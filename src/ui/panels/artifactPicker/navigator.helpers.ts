import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveInVault } from '../../../engine/adapt.js';
import type { TreeFile } from '../../../types/engine.types.js';
import { writesWholeFile } from '../../../services/artifact-type-config.service.js';
import type { ParsedArtifactFile, ParsedBlock, ParsedFrontmatter } from '../../../types/parsed-artifact.types.js';

/** Debounce window for QuickPick `onDidChangeActive` → preview render. */
export const PREVIEW_DEBOUNCE_MS = 120;

/** QuickPick item with optional vault-specific metadata. */
export interface ArtifactItem extends vscode.QuickPickItem {
    uri?: vscode.Uri;
    isDirectory?: boolean;
    isBack?: boolean;
    /** Set when this item represents a `##`-headed block inside a multi-block file. */
    block?: ParsedBlock;
    /** Vault-relative POSIX path — the one key for cache, stack and engine calls. */
    relPath?: string;
    /** The engine listed this file with an error; shown, never hidden. */
    broken?: boolean;
}

/**
 * Computes a forward-slash relative filesystem path from a URI to a root path.
 *
 * Returns the absolute path unchanged when the URI does not live inside the root,
 * which keeps logging useful even when called with an unexpected URI.
 *
 * @param uri    - File or directory URI.
 * @param rootFs - Absolute filesystem path of the artifact root directory.
 * @returns Relative POSIX-style path, or the original `fsPath` when outside the root.
 *
 * @example
 * relFsPath(vscode.Uri.file('/vault/Snippets/sub/foo.md'), '/vault/Snippets')
 * // → 'sub/foo.md'
 */
export function relFsPath(uri: vscode.Uri, rootFs: string): string {
    const p = uri.fsPath;
    return (p.startsWith(rootFs + '/') || p.startsWith(rootFs + '\\'))
        ? p.slice(rootFs.length + 1).replaceAll('\\', '/')
        : p;
}

/**
 * Builds a richly populated `ArtifactItem`.
 *
 * - `label`       — `$(file)  <title>` (filename fallback).
 * - `description` — Parsed description (relative-path fallback when absent).
 * - `detail`      — `$(symbol-variable) key=val | key=val    $(tag) #tag1 #tag2` (omitted when both empty).
 *
 * @param uri      - File or directory URI.
 * @param isDir    - True when the entry is a directory.
 * @param fallback - Display name to use before the file is parsed.
 * @param parsed   - Parsed metadata, or `undefined` if not yet loaded.
 * @param rootFs   - Absolute filesystem path of the artifact root directory.
 * @param relPath  - Vault-relative POSIX path carried on the item.
 * @returns A fully-populated QuickPick item.
 *
 * @example
 * buildItem(uri, false, 'express-route', parsed, '/vault/Snippets')
 */
export function buildItem(
    uri: vscode.Uri,
    isDir: boolean,
    fallback: string,
    parsed: ParsedArtifactFile | undefined,
    rootFs: string,
    relPath?: string
): ArtifactItem {
    if (isDir) {
        return { label: `$(folder)  ${fallback}`, uri, isDirectory: true, relPath };
    }

    const title       = parsed?.frontmatter.title || fallback;
    const description = parsed?.frontmatter.description || relFsPath(uri, rootFs);

    // ── detail: vars then tags, each section prefixed with a codicon ─────────
    const varsPart = parsed?.vars.length
        ? `$(symbol-variable)  ${parsed.vars.map(v => (v.name.startsWith('VK-') ? v.name.slice(3) : v.name) + (v.defaultValue ? '=' + v.defaultValue : '')).join('  |  ')}`
        : '';
    const tagsPart = parsed?.frontmatter.tags?.length
        ? `$(tag)  ${parsed.frontmatter.tags.map(t => '#' + t).join(' ')}`
        : '';
    const detail = varsPart || tagsPart
        ? [varsPart, tagsPart].filter(Boolean).join('    ')
        : undefined;

    return { label: `$(file)  ${title}`, description, detail, uri, isDirectory: false, relPath };
}

/**
 * Maps one `artifact.tree` level to QuickPick items: back row, dirs, then files.
 *
 * @param tree      - The engine reply (untrusted names; containment is checked per item).
 * @param dirRel    - Vault-relative path of the listed directory.
 * @param hasBack   - Whether to lead with the `..` row.
 * @param vaultRoot - Absolute vault root.
 * @param cached    - Parse-cache lookup by vault-relative path, so re-entered levels keep their detail row.
 * @returns Items in display order; throws when an engine path escapes the vault.
 *
 * @example
 * treeToItems({ dirs: [], files: [] }, 'Snippets', true, '/v'); // [back row]
 */
export function treeToItems(
    tree: { readonly dirs: readonly string[]; readonly files: readonly TreeFile[] },
    dirRel: string,
    hasBack: boolean,
    vaultRoot: string,
    cached: (relPath: string) => ParsedArtifactFile | undefined = () => undefined,
): ArtifactItem[] {
    const items: ArtifactItem[] = [];
    if (hasBack) { items.push({ label: '$(arrow-left)  ..', description: vscode.l10n.t('Go back'), isBack: true }); }
    for (const name of tree.dirs) {
        const rel = dirRel ? `${dirRel}/${name}` : name;
        items.push(buildItem(vscode.Uri.file(resolveInVault(rel, vaultRoot)), true, name, undefined, vaultRoot, rel));
    }
    for (const f of tree.files) {
        const name = f.title || f.name;
        const uri = vscode.Uri.file(resolveInVault(f.path, vaultRoot));
        const item = buildItem(uri, false, name, cached(f.path), path.join(vaultRoot, f.path.split('/')[0]), f.path);
        if (f.error) { items.push({ ...item, label: `$(warning)  ${name}`, description: f.error.code, broken: true }); continue; }
        if (f.description) { item.description = f.description; }
        items.push(item);
    }
    return items;
}

/**
 * Reports whether a parsed file's frontmatter marks it as a template index.
 *
 * `index: true` alone is not enough — a run can only write files, so a
 * `Snippet` or `Command` carrying `index: true` is not an index.
 *
 * @param fm - Parsed frontmatter of a candidate file.
 * @returns `true` only when `fm.index === true` and the type writes whole files.
 *
 * @example
 * isIndexArtifact({ artifactType: 'Template', index: true }); // → true
 * isIndexArtifact({ artifactType: 'Snippet', index: true });  // → false
 */
export function isIndexArtifact(fm: ParsedFrontmatter): boolean {
    return fm.index === true && writesWholeFile(fm.artifactType);
}
