import * as vscode from 'vscode';
import * as path from 'node:path';
import { confirmModal } from '../../../services/confirm.service.js';
import type { ArtifactFormBlock, ArtifactFormModel } from '../../../types/artifact-form.types.js';
import { pickDestFolder } from '../destFolderPicker.panel.js';
import { sendWrite } from '../../../services/conflict.service.js';
import { toEngineModel, type EngineRead } from '../../../engine/model.js';
import { toVaultPath } from '../../../engine/adapt.js';
import { getEntry } from '../../../services/artifact-type-config.service.js';
import { getVaultRootUri } from '../../../services/config.service.js';
import { deriveFileName, validateArtifactFilename } from '../../../services/filename.service.js';
import type { OpenFormOpts } from './panel.js';
import type { ParsedVar } from '../../../types/parsed-artifact.types.js';

// ── mergeBlockVars ────────────────────────────────────────────────────────────

/**
 * Merges the current var list with freshly detected vars from a code change.
 *
 * Rules (§3.5):
 * - Detected var already in current → keep the current `defaultValue` (preserves
 *   what the user typed).
 * - Detected var not in current → add it with `defaultValue: ''`.
 * - Var in current but absent from detected (orphan) → keep if `defaultValue`
 *   is non-empty; drop if empty.
 *
 * @param currentVars  - Vars currently displayed in the form (may have user-typed defaults).
 * @param detectedVars - Vars newly detected from `extractVars(code)` (all defaultValue `''`).
 * @returns Merged var list preserving user-typed defaults and non-empty orphans.
 *
 * @example
 * mergeBlockVars([{ name: 'VK-host', defaultValue: 'localhost' }], [{ name: 'VK-host', defaultValue: '' }])
 * // → [{ name: 'VK-host', defaultValue: 'localhost' }]
 */
export function mergeBlockVars(currentVars: ParsedVar[], detectedVars: ParsedVar[]): ParsedVar[] {
    const currentMap = new Map(currentVars.map(v => [v.name, v.defaultValue]));
    const merged: ParsedVar[] = detectedVars.map(v => ({
        name:         v.name,
        defaultValue: currentMap.get(v.name) ?? '',
    }));
    // Preserve orphans with non-empty defaults
    const detectedSet = new Set(detectedVars.map(v => v.name));
    for (const v of currentVars) {
        if (!detectedSet.has(v.name) && v.defaultValue !== '') {
            merged.push({ name: v.name, defaultValue: v.defaultValue });
        }
    }
    return merged;
}

// ── pruneVarsForSave ──────────────────────────────────────────────────────────

/**
 * Prunes the var list of each block at save time per §3.5 rules.
 *
 * - Token `<VK-xxx>` present in `block.code` → keep var (any default).
 * - Token absent AND `defaultValue === ''`  → drop (no orphan default).
 * - Token absent AND `defaultValue !== ''`  → keep as orphan default
 *   (serializer will emit it in the `vks` fence; parser preserves it on
 *   round-trip).
 *
 * @param blocks - Blocks from the form model before serialization.
 * @returns New blocks array with pruned var lists; original is not mutated.
 *
 * @example
 * pruneVarsForSave([{ code: 'x', vars: [{ name: 'VK-gone', defaultValue: '' }], ... }])
 * // → [{ code: 'x', vars: [], ... }]
 */
export function pruneVarsForSave(blocks: ArtifactFormBlock[]): ArtifactFormBlock[] {
    return blocks.map(block => {
        const prunedVars = block.vars.filter(v => {
            const token  = '<' + v.name + '>';
            const inCode = block.code.includes(token);
            return inCode || v.defaultValue !== '';
        });
        return { ...block, vars: prunedVars };
    });
}

// ── validateForSave ───────────────────────────────────────────────────────────

/**
 * Validates a form model against the §3.7 save-time rules.
 *
 * Returns an `errors` map keyed by field path; empty map means valid.
 * Keys used: `'title'`, `'blocks'`, `'block:N.heading'` (N = zero-based index).
 *
 * @param model - The form model to validate.
 * @returns `{ ok, errors }` where `errors` is empty when `ok === true`.
 *
 * @example
 * validateForSave({ title: '', blocks: [{ code: 'x', ... }], ... })
 * // → { ok: false, errors: { title: 'Title is required.' } }
 */
export function validateForSave(model: ArtifactFormModel): { ok: boolean; errors: Record<string, string> } {
    const errors: Record<string, string> = {};

    if (!model.title.trim()) {
        errors['title'] = 'Title is required.';
    }

    const hasCode = model.blocks.some(b => b.code.trim().length > 0);
    if (!hasCode) {
        errors['blocks'] = 'At least one block must have code.';
    }

    if (model.blocks.length > 1) {
        model.blocks.forEach((b, i) => {
            if (!b.heading.trim()) {
                errors[`block:${i}.heading`] = 'Block heading is required.';
            }
        });
    }

    return { ok: Object.keys(errors).length === 0, errors };
}

// ── reorderBlocks ─────────────────────────────────────────────────────────────

/**
 * Swaps two blocks in the list by index and returns a new array.
 *
 * When `fromIdx === toIdx` the original order is returned unchanged.
 * Does not mutate the input array.
 *
 * @param blocks  - Current block list.
 * @param fromIdx - Index of the block to move.
 * @param toIdx   - Destination index (the block it swaps with).
 * @returns New blocks array with the two positions exchanged.
 *
 * @example
 * reorderBlocks([A, B, C], 0, 1) // → [B, A, C]
 */
export function reorderBlocks(blocks: ArtifactFormBlock[], fromIdx: number, toIdx: number): ArtifactFormBlock[] {
    const copy = [...blocks];
    const a = copy[fromIdx];
    const b = copy[toIdx];
    if (a !== undefined && b !== undefined) {
        copy[fromIdx] = b;
        copy[toIdx]   = a;
    }
    return copy;
}

/**
 * Confirms deleting an artifact file from the vault.
 *
 * Names the file explicitly and says where it goes: a modal that says only
 * "are you sure?" gives the user nothing to check the action against, and this
 * one removes a file from their vault.
 *
 * @param uri - File that would be deleted.
 * @returns `true` only if the user chose Delete; Cancel and Escape are both `false`.
 *
 * @example
 * if (await confirmDeleteFile(uri)) { await deleteArtifactFile(uri); }
 */
export async function confirmDeleteFile(uri: vscode.Uri): Promise<boolean> {
    const DELETE_ACTION = vscode.l10n.t('Delete');
    return confirmModal({
        message: vscode.l10n.t('Delete "{0}"?', path.basename(uri.fsPath)),
        detail:  vscode.l10n.t('The file is permanently deleted and cannot be undone.'),
        action:  DELETE_ACTION,
    });
}

/**
 * Confirms discarding an unsaved draft — create mode, where no file exists yet.
 *
 * @param singular - Human noun for the artifact type, e.g. `'snippet'`.
 * @returns `true` only if the user chose Discard.
 *
 * @example
 * if (await confirmDiscardDraft('snippet')) { panel.dispose(); }
 */
export async function confirmDiscardDraft(singular: string): Promise<boolean> {
    const DISCARD_ACTION = vscode.l10n.t('Discard');
    return confirmModal({
        message: vscode.l10n.t('Discard this {0}?', singular),
        detail:  vscode.l10n.t('It has not been saved, so nothing is written to the vault.'),
        action:  DISCARD_ACTION,
    });
}

/**
 * Confirms, then permanently deletes an artifact through the engine (no trash: W3-b).
 * Declining, a missing read, a conflict and an engine error all send nothing further and answer `false`.
 *
 * @param sourceUri - File the form was opened from (names the confirm).
 * @param read      - The engine read that opened the form; carries the path and hash to delete against.
 * @returns `true` only when the engine deleted the file.
 *
 * @example
 * if (!await deleteWithConfirm(uri, opts.read)) { return; }
 */
export async function deleteWithConfirm(sourceUri: vscode.Uri, read: EngineRead | undefined): Promise<boolean> {
    if (!read || !await confirmDeleteFile(sourceUri)) { return false; }
    return await sendWrite('artifact.delete', { path: read.relPath, expectedHash: read.hash }) !== undefined;
}

/** Create-mode prompts; a seam so tests never open a real QuickPick or input box. */
export interface SaveIO {
    readonly pickDir: (root: vscode.Uri) => Thenable<vscode.Uri | undefined>;
    readonly promptName: (title: string) => Thenable<string | undefined>;
    readonly notify: (message: string) => void;
}

const REAL_IO: SaveIO = {
    notify: m => { void vscode.window.showErrorMessage(m); },
    pickDir: pickDestFolder,
    promptName: title => vscode.window.showInputBox({
        title:          vscode.l10n.t('Save artifact as'),
        value:          deriveFileName(title),
        prompt:         vscode.l10n.t('File name (without .md extension)'),
        ignoreFocusOut: true,
        validateInput:  v => {
            const r = validateArtifactFilename(v);
            return r.ok ? undefined : r.reason;
        },
    }),
};

/**
 * The engine half of the form's Save. Edit: one `artifact.update` against the hash the form was opened from.
 * Create: destination folder, file name, then `artifact.create` (exists ⇒ T3.2's overwrite confirm).
 * `model` crosses the webview boundary, so its type is only checked, never trusted: the path is built from `opts.type`.
 *
 * @param webviewModel - The webview's model after `pruneVarsForSave` (untrusted).
 * @param opts     - How the form was opened.
 * @param onReload - Runs when the user picks Reload after a conflict.
 * @param io       - Create-mode prompts (tests inject).
 * @returns `true` when the engine wrote the file; `false` when nothing was written (cancelled, refused or told).
 *
 * @example
 * if (await saveToEngine(pruned, opts, reopen)) { panel.dispose(); }
 */
export async function saveToEngine(webviewModel: ArtifactFormModel, opts: OpenFormOpts, onReload: () => void, io: SaveIO = REAL_IO): Promise<boolean> {
    try {
        getEntry(webviewModel.artifactType);
    } catch {
        io.notify(vscode.l10n.t('Unknown artifact type.'));
        return false;
    }
    // The webview's type is never what the engine is told: a form opened for opts.type cannot retype the file.
    const pruned = { ...webviewModel, artifactType: opts.type };
    const { read } = opts;
    if (opts.mode === 'edit') {
        if (!read) { return false; }
        return await sendWrite('artifact.update',
            { path: read.relPath, expectedHash: read.hash, model: toEngineModel(pruned, read) }, { onReload }) !== undefined;
    }
    const vaultRoot = getVaultRootUri();
    if (!vaultRoot) { io.notify(vscode.l10n.t('Vault not configured.')); return false; }
    const chosenDir = await io.pickDir(vscode.Uri.joinPath(vaultRoot, getEntry(opts.type).dir));
    if (!chosenDir) { return false; }
    const dirRel = chosenDir.fsPath === vaultRoot.fsPath ? '' : toVaultPath(chosenDir.fsPath, vaultRoot.fsPath);
    if (dirRel === undefined) { io.notify(vscode.l10n.t('The destination folder is outside the vault.')); return false; }
    const fileName = await io.promptName(pruned.title);
    if (!fileName) { return false; }
    const path = dirRel === '' ? `${fileName}.md` : `${dirRel}/${fileName}.md`;
    return await sendWrite('artifact.create', { path, model: toEngineModel(pruned) }) !== undefined;
}
