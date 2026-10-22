/**
 * Create File flow for whole-file artifact types (`artifactType: Template` /
 * `artifactType: AIAgentsConfig`, `ARTIFACTS.writesFile`): resolve the destination and
 * filename, then ask the engine to render and write (`artifact.write_file`) with Overwrite /
 * Rename handling, then (optionally) open the new file.
 *
 * The engine owns every rule (single-block, naming, containment, variable substitution); this
 * file owns only the prompts. `write_file` renders the vault file, not the preview's code, so a
 * staged edit refuses the flow (W3-c).
 */
import * as vscode from 'vscode';
import { resolveOutputFileName } from '../../../services/template.service.js';
import { resolveDestination } from '../../../services/template-destination.service.js';
import { validateTargetFileName } from '../../../services/filename.service.js';
import { handleWriteError } from '../../../services/conflict.service.js';
import { getEngine, requestOrNotify } from '../../../engine/engine.vscode.js';
import { resolveInVault, toVaultPath } from '../../../engine/adapt.js';
import { engineMeta } from '../../../engine/model.js';
import { EngineRequestError } from '../../../engine/request-error.js';
import type { BlockRef } from '../../../services/artifact-patcher.service.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import type { EngineParams } from '../../../types/engine.types.js';
import type { BatchOutcome } from '../../../types/multi-index.types.js';

/** Outcome of {@link runCreateFileFlow}. */
export type CreateFileResult =
    | { kind: 'written'; filePath: string }
    | { kind: 'cancelled' }
    | { kind: 'error' };

/**
 * Maps a {@link CreateFileResult} onto the batch gate's `BatchOutcome` union
 * (T4 hook 3 / the seam the reviewer flagged): a failed step — `cancelled` or
 * `error` — must not abort the whole run, so both collapse to `skipped`; only
 * `written` carries forward, picking up the resolved vars for the runner's
 * carry-over map.
 *
 * @param result - Outcome of {@link runCreateFileFlow}.
 * @param vars - Resolved vars to attach when `result.kind === 'written'`.
 * @returns The corresponding `BatchOutcome`.
 *
 * @example
 * toBatchOutcome({ kind: 'cancelled' }, {}); // → { kind: 'skipped' }
 */
export function toBatchOutcome(result: CreateFileResult, vars: Record<string, string>): BatchOutcome {
    return result.kind === 'written'
        ? { kind: 'written', vars, filePath: result.filePath }
        : { kind: 'skipped' };
}

/** Arguments for {@link runCreateFileFlow}. */
export interface RunCreateFileFlowArgs {
    artifact: ParsedArtifactFile;
    code: string;
    vars: Record<string, string>;
    /** Pinned destination (batch mode); when undefined the interactive resolver runs. */
    destDir: vscode.Uri | undefined;
    /** Explorer URI for the interactive resolver. */
    destUri: vscode.Uri | undefined;
    /** false in batch mode — N tabs do not scale (D7). */
    openAfterWrite: boolean;
    /** Which block of a multi-block file the preview shows; a `multi` ref sends `block` to the engine. */
    blockRef?: BlockRef;
}

/** The prompts and workspace lookup the flow needs — injectable so a test host with no workspace can reach `write_file`. */
export interface CreateFileIo {
    getWorkspaceFolder(uri: vscode.Uri): vscode.Uri | undefined;
    askFileName(defaultValue: string): Promise<string | undefined>;
    /** The file exists: Overwrite, Rename, or `undefined` (Cancel / dismissed). */
    pickCollision(name: string): Promise<'overwrite' | 'rename' | undefined>;
}

/** The real `vscode` prompts. */
const REAL_IO: CreateFileIo = {
    getWorkspaceFolder: uri => vscode.workspace.getWorkspaceFolder(uri)?.uri,
    askFileName,
    pickCollision: async name => {
        const overwrite = vscode.l10n.t('Overwrite');
        const rename = vscode.l10n.t('Rename');
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t('"{0}" already exists in that folder.', name), { modal: true }, overwrite, rename);
        return choice === overwrite ? 'overwrite' : choice === rename ? 'rename' : undefined;
    },
};

/**
 * Runs the full Create File flow for a `template`/`agent` artifact: staged-edit check,
 * destination + filename resolution, `artifact.write_file` with collision handling, and (when
 * requested) opening the written file. Any rejection stops the flow before a request is sent or
 * leaves the engine's answer as the only effect.
 *
 * @param args - See {@link RunCreateFileFlowArgs}.
 * @param io - Prompts and workspace lookup; defaults to the real `vscode` ones.
 * @returns `written` with the final absolute path, `cancelled` when the user backed out (or no
 *          workspace is open), or `error` after a message has already been shown.
 *
 * @example
 * const result = await runCreateFileFlow({
 *     artifact, code, vars,
 *     destDir: undefined, destUri, openAfterWrite: true,
 * });
 * if (result.kind === 'written') { console.log(result.filePath); }
 */
export async function runCreateFileFlow(args: RunCreateFileFlowArgs, io: CreateFileIo = REAL_IO): Promise<CreateFileResult> {
    const { artifact, code, vars, destUri, openAfterWrite } = args;
    const meta = engineMeta(artifact);
    // A file that did not come from the engine has no vault path to render; unreachable via the navigator.
    if (!meta) { return { kind: 'error' }; }

    // ── W3-c: write_file renders the vault file, so a staged edit would be silently dropped ──
    if (code !== artifact.code) {
        void vscode.window.showErrorMessage(vscode.l10n.t('MD Artifacts: Overwrite your edit first, then Create File.'));
        return { kind: 'error' };
    }

    // ── Destination (D2) + containment root ───────────────────────────────
    const destDir = args.destDir ?? await resolveDestination(destUri);
    if (!destDir) { return { kind: 'cancelled' }; }  // no workspace open, or the folder picker was cancelled
    const workspaceRoot = io.getWorkspaceFolder(destDir);
    const rel = workspaceRoot && (destDir.fsPath === workspaceRoot.fsPath ? '' : toVaultPath(destDir.fsPath, workspaceRoot.fsPath));
    if (!workspaceRoot || rel === undefined) {
        void vscode.window.showErrorMessage(vscode.l10n.t('MD Artifacts: Destination is not inside an open workspace folder.'));
        return { kind: 'error' };
    }

    // ── Default filename — only seeds the prompt; the engine re-validates what is sent ──
    let defaultName: string;
    try {
        defaultName = resolveOutputFileName(artifact);
    } catch (err) {
        void vscode.window.showErrorMessage(vscode.l10n.t('MD Artifacts: {0}', (err as Error).message));
        return { kind: 'error' };
    }
    const fileName = await io.askFileName(defaultName);
    if (fileName === undefined) { return { kind: 'cancelled' }; }

    const block = await blockIndex(meta.relPath, args.blockRef);
    if (block === null) { return { kind: 'cancelled' }; }  // read failed, toast shown
    const base = { path: meta.relPath, ...(block === undefined ? {} : { block }), values: vars, workspaceRoot: workspaceRoot.fsPath, destDir: rel };

    const written = await writeWithCollisionHandling(base, fileName, io);
    if (written === undefined) { return { kind: 'cancelled' }; }  // cancelled or errored (message already shown)
    let finalPath: string;
    try {
        finalPath = resolveInVault(written, workspaceRoot.fsPath);  // engine path is untrusted: throws client.protocol on escape
    } catch (e) {
        await handleWriteError(e);
        return { kind: 'error' };
    }

    if (openAfterWrite) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(finalPath));
        await vscode.window.showTextDocument(doc);
    }
    return { kind: 'written', filePath: finalPath };
}

/**
 * Index of the shown block in a fresh read of the file (a `multi` ref only).
 *
 * @param relPath - Vault-relative path of the artifact.
 * @param ref - The preview's block ref.
 * @returns The index; `undefined` when nothing is sent (single, or heading not found: the engine answers `artifact.multi_block`); `null` when the read failed.
 *
 * @example
 * await blockIndex('AIAgentsConf/multi.md', { kind: 'multi', heading: 'Two' }); // 1
 */
async function blockIndex(relPath: string, ref: BlockRef | undefined): Promise<number | undefined | null> {
    if (ref?.kind !== 'multi') { return undefined; }
    const read = await requestOrNotify('artifact.read', { path: relPath });
    if (!read) { return null; }
    const i = read.blocks.findIndex(b => b.heading === ref.heading);
    return i < 0 ? undefined : i;
}

/**
 * Prompts for a target filename, seeded with `defaultValue` and validated
 * live by `validateTargetFileName` (workspace-target rules, T3).
 *
 * @param defaultValue - Prefilled, fully-editable filename (raw title + ext, P5).
 * @returns The confirmed filename, or `undefined` when the user cancels.
 *
 * @example
 * const name = await askFileName('Button.tsx');
 */
async function askFileName(defaultValue: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
        prompt:         vscode.l10n.t('File name for the new file'),
        value:          defaultValue,
        ignoreFocusOut: true,
        validateInput:  v => {
            const r = validateTargetFileName(v);
            return r.ok ? undefined : r.reason;
        },
    });
}

/**
 * Sends `artifact.write_file`, resolving an existing file interactively: on `file.exists` the
 * user chooses Overwrite (re-send with the engine's `actual` hash), Rename (re-prompt) or Cancel.
 * Every other engine error goes to the shared write-error UX and aborts.
 *
 * @param base - Request params except `fileName` / `expectedHash`.
 * @param fileName - Initial filename (may change via the Rename branch).
 * @param io - Prompts.
 * @returns The workspace-relative POSIX path the engine wrote, or `undefined` on cancel/error.
 *
 * @example
 * const rel = await writeWithCollisionHandling(base, 'Button.tsx', io);
 */
async function writeWithCollisionHandling(
    base: EngineParams<'artifact.write_file'>,
    fileName: string,
    io: CreateFileIo,
): Promise<string | undefined> {
    let name = fileName;
    let expectedHash: string | undefined;
    for (;;) {
        try {
            const res = await getEngine().request('artifact.write_file', { ...base, fileName: name, ...(expectedHash === undefined ? {} : { expectedHash }) });
            return res.path;
        } catch (e) {
            if (!(e instanceof EngineRequestError)) { throw e; }
            const actual = e.data.params['actual'];
            if (e.data.code !== 'file.exists' || actual === undefined) { await handleWriteError(e); return undefined; }
            const choice = await io.pickCollision(name);
            if (choice === 'overwrite') { expectedHash = actual; continue; }
            if (choice !== 'rename') { return undefined; }  // Cancel / dismissed
            const renamed = await io.askFileName(name);
            if (renamed === undefined) { return undefined; }
            name = renamed;
            expectedHash = undefined;
        }
    }
}
