import * as path from 'node:path';
import * as vscode from 'vscode';
import { isPathWithin } from '../utils/path-containment.js';

/**
 * THE authority for scratch files — real files written into extension storage
 * so the user can edit them with the full VS Code editor, then have them
 * deleted on teardown. Layout: `<storageUri>/<subdir>/<slug>.<ext>`.
 *
 * Extracted from `artifactPicker/blockEditor.ts`'s `<storageUri>/blockEdit/`
 * temp-file behaviour and generalised to an arbitrary `subdir`, so future
 * scratch-file callers share one authority instead of a second copy of the
 * containment dance.
 *
 * **Not the same thing as `TempDocument`** (`temp-document.service.ts`), which
 * wraps an *untitled* `vscode.TextDocument` — no path, nothing on disk,
 * nothing to sweep. This service owns real files on disk, which is why it has
 * containment checks, slugging, and an orphan sweep, and `TempDocument` has
 * none of them. Neither absorbs the other.
 */

/** Arguments for `openScratchFile`. */
export interface ScratchFileArgs {
    /** Extension storage dir — the trusted root every scratch file must stay inside. */
    storageUri: vscode.Uri;
    /** Subdirectory under `storageUri` (e.g. `'blockEdit'`) — a single path segment. */
    subdir: string;
    /** Raw base name (e.g. an artifact title) — slugified before use, never used raw. */
    baseName: string;
    /** File extension, without the leading dot (e.g. `'ts'`). */
    ext: string;
    /** UTF-8 content to write. */
    content: string;
}

/**
 * Resolves `<storageUri>/<subdir>`, asserting it stays within `storageUri`.
 *
 * `subdir` is caller-supplied and untrusted the same way `baseName` is —
 * `vscode.Uri.joinPath` normalises `..` (`joinPath(storageUri, '../..')`
 * walks up out of `storageUri`), so every caller that turns `subdir` into a
 * path **must** route through this check first. Both `openScratchFile` and
 * `sweepOrphans` do; neither builds a directory Uri any other way.
 *
 * @param storageUri - Trusted root.
 * @param subdir - Subdirectory under the root.
 * @returns The resolved `vscode.Uri`, or `undefined` when `subdir` escapes `storageUri`.
 *
 * @example
 * resolveSubdir(storageUri, 'blockEdit');  // → <storageUri>/blockEdit
 * resolveSubdir(storageUri, '../..');      // → undefined
 */
function resolveSubdir(storageUri: vscode.Uri, subdir: string): vscode.Uri | undefined {
    const resolved = path.resolve(storageUri.fsPath, subdir);
    if (!isPathWithin(storageUri.fsPath, resolved)) {
        return undefined;
    }
    // `''` and `'.'` resolve to the storage root itself, which `isPathWithin`
    // accepts — it is contained, just not a *subdirectory*. That is inside the
    // trust boundary rather than an escape, but it turns `sweepOrphans` from
    // "delete one subdir's leftovers" into "empty the whole storage root", and
    // the sink is a delete loop. Require a proper subdirectory so the function
    // means what its name says.
    if (resolved === path.resolve(storageUri.fsPath)) {
        return undefined;
    }
    return vscode.Uri.file(resolved);
}

/**
 * Resolves `<dir>/<slug(baseName)>.<ext>` under an already-`resolveSubdir`-checked
 * `dir`, asserting containment without writing anything.
 *
 * Two `isPathWithin` checks, not one. The first runs against the **raw**
 * `baseName` joined as a literal path segment — this is what actually catches
 * a hostile name (`../../evil`, `/etc/passwd`), because `slugify` collapses
 * every `/` and `.` into `-` and would otherwise turn a traversal attempt into
 * an innocent-looking accepted filename (`evil`, `etc-passwd`) — silently
 * sanitising exactly the input this function must reject instead. The second
 * check runs on the slugified path and is the one `openScratchFile` relies on
 * immediately before the write, with nothing in between.
 *
 * @param storageUri - Trusted root (the containment anchor for both checks).
 * @param dir - Already-validated `<storageUri>/<subdir>` Uri from `resolveSubdir`.
 * @param baseName - Raw base name to slugify.
 * @param ext - File extension, no leading dot.
 * @returns The resolved `vscode.Uri`, or `undefined` when `baseName` is hostile
 *          or slugifies to an empty string.
 *
 * @example
 * const dir = resolveSubdir(storageUri, 'blockEdit')!;
 * resolveScratchUri(storageUri, dir, 'My Title', 'ts');
 * // → <storageUri>/blockEdit/my-title.ts
 * resolveScratchUri(storageUri, dir, '../../evil', 'ts'); // → undefined
 */
function resolveScratchUri(
    storageUri: vscode.Uri,
    dir: vscode.Uri,
    baseName: string,
    ext: string,
): vscode.Uri | undefined {
    const root = storageUri.fsPath;

    // ── Reject a hostile raw name before slugify can neuter it into an
    // innocent-looking accepted one ──────────────────────────────────────────
    const rawResolved = path.resolve(dir.fsPath, baseName);
    if (!isPathWithin(root, rawResolved)) {
        return undefined;
    }

    const slug = slugify(baseName);
    if (slug.length === 0) {
        return undefined;
    }

    // ── Final assertion, immediately before the caller writes ─────────────────
    const resolved = path.resolve(dir.fsPath, `${slug}.${ext}`);
    if (!isPathWithin(root, resolved)) {
        return undefined;
    }
    return vscode.Uri.file(resolved);
}

/**
 * Creates (or overwrites) a scratch file with `content` at
 * `<storageUri>/<subdir>/<slug(baseName)>.<ext>`.
 *
 * A hostile `baseName` — one that would escape `storageUri` before or after
 * slugging — is **rejected**, returning `undefined`; it is never trimmed,
 * stripped, or slugged into an accepted write. See `resolveScratchUri` for
 * the two-check reasoning.
 *
 * @param args - See `ScratchFileArgs`.
 * @returns The written file's `vscode.Uri`, or `undefined` if `baseName` was rejected.
 *
 * @example
 * const uri = await openScratchFile({ storageUri, subdir: 'blockEdit', baseName: 'My Block', ext: 'ts', content: 'x' });
 * const rejected = await openScratchFile({ storageUri, subdir: 'x', baseName: '../../evil', ext: 'ts', content: '' });
 * // rejected === undefined
 */
export async function openScratchFile(args: ScratchFileArgs): Promise<vscode.Uri | undefined> {
    const dir = resolveSubdir(args.storageUri, args.subdir);
    if (dir === undefined) {
        return undefined;
    }
    const uri = resolveScratchUri(args.storageUri, dir, args.baseName, args.ext);
    if (uri === undefined) {
        return undefined;
    }
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(args.content));
    return uri;
}

/**
 * Deletes a scratch file. Best-effort — an already-missing file is not an error.
 *
 * @param uri - Uri previously returned by `openScratchFile`.
 * @returns A promise that resolves once the delete attempt completes.
 *
 * @example
 * await disposeScratchFile(uri);
 */
export async function disposeScratchFile(uri: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.delete(uri);
    } catch {
        /* already gone — ignore */
    }
}

/**
 * Deletes every leftover entry directly under `<storageUri>/<subdir>` (e.g.
 * after a crash or non-clean teardown left a scratch file behind).
 *
 * `subdir` goes through the same `resolveSubdir` containment check
 * `openScratchFile` uses — a hostile `subdir` (e.g. `'../..'`, which
 * `vscode.Uri.joinPath` would normalise right out of `storageUri`) deletes
 * nothing and never even calls `readDirectory`. Best-effort beyond that —
 * errors on individual entries are swallowed, and a missing `subdir` is not
 * an error.
 *
 * @param storageUri - Extension storage dir.
 * @param subdir - Subdirectory to sweep (e.g. `'blockEdit'`).
 * @returns A promise that resolves once the sweep completes.
 *
 * @example
 * await sweepOrphans(context.storageUri ?? context.globalStorageUri, 'blockEdit');
 * await sweepOrphans(context.storageUri, '../..'); // no-op — rejected, nothing deleted
 */
export async function sweepOrphans(storageUri: vscode.Uri, subdir: string): Promise<void> {
    const dir = resolveSubdir(storageUri, subdir);
    if (dir === undefined) {
        return;
    }
    try {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        for (const [name] of entries) {
            try {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
            } catch {
                /* ignore individual failures */
            }
        }
    } catch {
        /* dir does not exist yet — nothing to sweep */
    }
}

const SLUG_NON_ALNUM_RE  = /[^a-z0-9]+/g;
const SLUG_TRIM_DASH_RE  = /^-+|-+$/g;

/**
 * Lowercases and dash-separates a title into a filesystem-safe slug.
 *
 * Strategy: lowercase → replace every run of non-`[a-z0-9]` characters with
 * a single `-` → strip leading/trailing `-`. No transliteration — non-ASCII
 * letters collapse into separators along with punctuation and whitespace.
 *
 * @param title - Raw title string.
 * @returns Slug string (may be empty if `title` has no `[a-z0-9]` chars).
 *
 * @example
 * slugify('Hello World!!');  // → 'hello-world'
 * slugify('   ');            // → ''
 * slugify('Phase 0.5');      // → 'phase-0-5'
 */
export function slugify(title: string): string {
    return title
        .toLowerCase()
        .replaceAll(SLUG_NON_ALNUM_RE, '-')
        .replaceAll(SLUG_TRIM_DASH_RE, '');
}

