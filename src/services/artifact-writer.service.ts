import * as path from 'node:path';
import * as vscode from 'vscode';
import { getEntry } from './artifact-type-config.service.js';
import { isPathWithin } from '../utils/path-containment.js';
import type { ArtifactType } from '../types/parsed-artifact.types.js';

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Discriminated union returned by `writeArtifact`.
 *
 * - `success`   — file written; `filePath` is the absolute OS path.
 * - `collision` — file already exists and `force` was not set; nothing written.
 * - `error`     — unexpected failure (path-escape, write error, etc.); caller
 *                 shows `message` to the user.
 */
export type WriteResult =
    | { kind: 'success';   filePath: string }
    | { kind: 'collision'; filePath: string }
    | { kind: 'error';     message: string };

/**
 * Arguments for `writeArtifact`.
 */
export interface WriteArgs {
    /** Vault root Uri — used to compute the base directory and for path-escape checks. */
    vaultRoot: vscode.Uri;
    /** Artifact type — determines the base subdirectory (e.g. `snippet` → `Snippets`). */
    type: ArtifactType;
    /** Target directory Uri — must be within `vaultRoot`. */
    chosenDir: vscode.Uri;
    /** Filename **without** `.md` extension — the writer appends it. */
    fileName: string;
    /** UTF-8 content to write. */
    content: string;
    /** When `true`, overwrite an existing file. Defaults to `false`. */
    force?: boolean;
}

// ── Public function ───────────────────────────────────────────────────────────

/**
 * Writes a vault artifact file using `vscode.workspace.fs`.
 *
 * Steps (in order):
 * 1. Validates `chosenDir` is inside `vaultRoot` (path-escape guard).
 * 2. Ensures the artifact-type base directory exists (auto-creates if absent).
 * 3. Checks whether the final path already exists:
 *    - Exists + `!force` → returns `{ kind: 'collision' }` without writing.
 *    - Exists + `force`  → overwrites.
 *    - Absent            → creates.
 * 4. Returns `{ kind: 'success', filePath }` on success.
 * 5. Returns `{ kind: 'error', message }` on any unexpected exception.
 *
 * The writer never calls `vscode.window.showTextDocument` — the panel closes
 * silently on success (deliberate UX; no editor tab opened).
 *
 * @param args - Write configuration.
 * @returns A `WriteResult` describing the outcome.
 *
 * @example
 * const result = await writeArtifact({ vaultRoot, type: 'snippet', chosenDir, fileName: 'my-snippet', content });
 * if (result.kind === 'success') { panel.dispose(); }
 */
export async function writeArtifact(args: WriteArgs): Promise<WriteResult> {
    try {
        // ── 1. Path-escape guard ───────────────────────────────────────────
        if (!isWithinRoot(args.vaultRoot, args.chosenDir)) {
            return { kind: 'error', message: vscode.l10n.t('Destination "{0}" is outside the vault root.', args.chosenDir.fsPath) };
        }

        // ── 2. Auto-create base dir ────────────────────────────────────────
        const baseDir = vscode.Uri.joinPath(args.vaultRoot, getEntry(args.type).dir);
        await vscode.workspace.fs.createDirectory(baseDir);

        // ── 3. Path-escape guard, on the FINAL path ────────────────────────
        // Step 1 contained the *directory*; this contains the *file*. They are
        // not the same check: `fileName` is caller-supplied and unvalidated,
        // and `Uri.joinPath` normalises `..`, so a name like `../../evil`
        // resolves outside a `chosenDir` that step 1 already approved. Every
        // caller today happens to guard upstream (`assertNoPathInjection`, or
        // `safeRelPath`), but the writer is the authority and the rule belongs
        // here — a `fileName` legitimately carrying a separator (`sub/b`, from
        // the create-index batch) is what retires the old "it is a basename"
        // assumption. Rejected, never trimmed. Guarded by
        // `artifact-writer.test.ts` — "rejects a fileName that escapes chosenDir".
        const fileUri = vscode.Uri.joinPath(args.chosenDir, `${args.fileName}.md`);
        if (!isWithinRoot(args.chosenDir, fileUri)) {
            return { kind: 'error', message: vscode.l10n.t('Filename "{0}" resolves outside the destination directory.', args.fileName) };
        }

        // ── 4. Collision check ─────────────────────────────────────────────
        const exists = await fileExists(fileUri);

        if (exists && !args.force) {
            return { kind: 'collision', filePath: fileUri.fsPath };
        }

        // ── 5. Write ───────────────────────────────────────────────────────
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(args.content));
        return { kind: 'success', filePath: fileUri.fsPath };

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'error', message };
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Returns `true` when `candidate` is equal to or nested within `root`.
 *
 * Appends a platform separator before prefix-checking so `/vault-root-b` is
 * not matched as within `/vault-root`.
 *
 * @param root      - Vault root Uri.
 * @param candidate - Uri to validate.
 * @returns `true` if `candidate` is within `root`.
 *
 * @example
 * isWithinRoot(vaultRoot, vscode.Uri.joinPath(vaultRoot, 'Snippets')) // true
 * isWithinRoot(vaultRoot, vscode.Uri.file('/other/dir'))              // false
 */
function isWithinRoot(root: vscode.Uri, candidate: vscode.Uri): boolean {
    return isPathWithin(root.fsPath, candidate.fsPath);
}

/**
 * Returns `true` when a file exists at `uri` (stat succeeds without throwing).
 *
 * @param uri - File Uri to check.
 * @returns `true` if the file exists.
 *
 * @example
 * await fileExists(vscode.Uri.file('/vault/Snippets/route.md'))
 */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
