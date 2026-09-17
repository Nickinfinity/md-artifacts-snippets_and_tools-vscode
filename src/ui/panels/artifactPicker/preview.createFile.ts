/**
 * Create File flow for whole-file artifact types (`artifactType: Template` /
 * `artifactType: AIAgentsConfig`, `ARTIFACTS.writesFile`): enforce the single-block guard (D1), resolve the
 * destination and filename, substitute variables, write into the workspace, then
 * (optionally) open the new file.
 *
 * Extracted out of `preview.ts` (D12) behind the single {@link runCreateFileFlow}
 * entry point — the panel no longer reaches into `vscode` prompts or the writer
 * directly, it just supplies the artifact/code/vars and a destination policy.
 */
import * as vscode from 'vscode';
import { resolveVars } from '../../../services/parser.service.js';
import { validateSingleBlock, resolveOutputFileName } from '../../../services/template.service.js';
import { getTypeSingular } from '../../../services/artifact-type-config.service.js';
import { writeTemplateFile } from '../../../services/template-writer.service.js';
import { resolveDestination } from '../../../services/template-destination.service.js';
import { validateTargetFileName } from '../../../services/filename.service.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
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
}

/**
 * Runs the full Create File flow for a `template`/`agent` artifact: D1 block
 * check, destination + filename resolution, variable substitution, write with
 * collision handling, and (when requested) opening the written file. Any
 * rejection — bad block count, cancelled prompt, missing workspace, containment
 * failure — stops the flow without writing.
 *
 * @param args - See {@link RunCreateFileFlowArgs}.
 * @returns `written` with the final absolute path, `cancelled` when the user
 *          backed out (or no workspace is open), or `error` after a message has
 *          already been shown to the user.
 *
 * @example
 * const result = await runCreateFileFlow({
 *     artifact, code, vars,
 *     destDir: undefined, destUri, openAfterWrite: true,
 * });
 * if (result.kind === 'written') { console.log(result.filePath); }
 */
export async function runCreateFileFlow(args: RunCreateFileFlowArgs): Promise<CreateFileResult> {
    const { artifact, code, vars, destUri, openAfterWrite } = args;
    const type = artifact.frontmatter.artifactType;

    // ── D1: single-block only (template) / one config file (agent) ────────
    const blockCheck = validateSingleBlock(artifact, getTypeSingular(type));
    if (!blockCheck.ok) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: {0}', blockCheck.reason));
        return { kind: 'error' };
    }

    // ── Destination (D2) + containment root ───────────────────────────────
    const destDir = args.destDir ?? await resolveDestination(destUri);
    if (!destDir) { return { kind: 'cancelled' }; }  // no workspace open, or the folder picker was cancelled
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(destDir)?.uri;
    if (!workspaceRoot) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: Destination is not inside an open workspace folder.'));
        return { kind: 'error' };
    }

    // ── Default filename — throws on a hostile frontmatter value ──────────
    // Per-type naming (template = D3 extension precedence, agent = `target:`
    // verbatim) is the service's decision, not the caller's; a hostile value
    // throws here rather than being sanitised into a plausible path.
    let defaultName: string;
    try {
        defaultName = resolveOutputFileName(artifact);
    } catch (err) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: {0}', (err as Error).message));
        return { kind: 'error' };
    }

    const fileName = await askFileName(defaultName);
    if (fileName === undefined) { return { kind: 'cancelled' }; }  // cancelled

    // ── Resolve variables into the file content, then write ───────────────
    const content = resolveVars(code, vars);

    const finalPath = await writeWithCollisionHandling(workspaceRoot, destDir, fileName, content);
    if (finalPath === undefined) { return { kind: 'cancelled' }; }  // cancelled or errored (message already shown)

    if (openAfterWrite) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(finalPath));
        await vscode.window.showTextDocument(doc);
    }
    return { kind: 'written', filePath: finalPath };
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
 * Writes the template file, resolving collisions interactively: on an existing
 * file the user chooses Overwrite (retry with `force`), Rename (re-prompt), or
 * Cancel. Containment/error results surface a message and abort.
 *
 * @param workspaceRoot - Containment boundary for the write (must contain `destDir`).
 * @param destDir - Destination directory to write into.
 * @param fileName - Initial filename (may change via the Rename branch).
 * @param content - UTF-8 content to write, variables already resolved.
 * @returns The written file's absolute path, or `undefined` on cancel/error.
 *
 * @example
 * const path = await writeWithCollisionHandling(workspaceRoot, destDir, 'Button.tsx', content);
 */
async function writeWithCollisionHandling(
    workspaceRoot: vscode.Uri,
    destDir: vscode.Uri,
    fileName: string,
    content: string,
): Promise<string | undefined> {
    // Hoisted per call (not module scope): `vscode.l10n.t` must run after the
    // bundle is loaded, and the read-back equality (`choice === OVERWRITE_LABEL`
    // / `!== RENAME_LABEL`) still compares one binding on both sides.
    const OVERWRITE_LABEL = vscode.l10n.t('Overwrite');
    const RENAME_LABEL = vscode.l10n.t('Rename');
    let name  = fileName;
    let force = false;
    for (;;) {
        const result = await writeTemplateFile({ workspaceRoot, destDir, fileName: name, content, force });
        if (result.kind === 'success') { return result.filePath; }
        if (result.kind === 'error') {
            void vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: {0}', result.message));
            return undefined;
        }
        // ── collision → ask ────────────────────────────────────────────────
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t('"{0}" already exists in that folder.', name), { modal: true }, OVERWRITE_LABEL, RENAME_LABEL);
        if (choice === OVERWRITE_LABEL) { force = true; continue; }
        if (choice !== RENAME_LABEL)    { return undefined; }  // Cancel / dismissed
        const renamed = await askFileName(name);
        if (renamed === undefined) { return undefined; }
        name  = renamed;
        force = false;
    }
}
