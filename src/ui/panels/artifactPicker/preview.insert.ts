import * as vscode from 'vscode';
import type { BlockRef } from '../../../services/artifact-patcher.service.js';
import { confirmModal } from '../../../services/confirm.service.js';
import { notifyEngineError, requestOrNotify } from '../../../engine/engine.vscode.js';
import { engineWarningMessage } from '../../../engine/errors.js';
import { engineMeta } from '../../../engine/model.js';
import { EngineRequestError } from '../../../engine/request-error.js';
import type { Rendered } from '../../../types/engine.types.js';
import type { ArtifactType, ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import { blockIndex } from './preview.createFile.js';
import {
    needsTerminalConfirmation, resolveInsertTarget, sanitiseVarsSnapshot, wrapForTerminal,
    type InvocationSurface,
} from './preview.helpers.js';
import { out } from './shared.js';

/** Longest single preview line shown in the terminal-confirm modal before truncation. */
const CONFIRM_PREVIEW_LINE_MAX = 200;
/** Longest run of leading lines shown in the terminal-confirm modal's preview. */
const CONFIRM_PREVIEW_LINE_COUNT = 3;

/**
 * Where rendered output goes: terminal, warnings, clipboard. An injected bag so tests
 * count sinks without assigning `vscode.window.*`.
 *
 * @example
 * const io: DeliveryIO = DELIVERY_IO;
 */
export interface DeliveryIO {
    terminal(): Pick<vscode.Terminal, 'sendText' | 'show'>;
    showWarning(msg: string): void;
    writeClipboard(text: string): Thenable<void>;
    showInfo(msg: string): void;
}

/** The real sinks. `terminal()` creates a terminal, so callers use it only once a send is certain. */
export const DELIVERY_IO: DeliveryIO = {
    terminal: () => vscode.window.activeTerminal ?? vscode.window.createTerminal('MD Artifacts'),
    showWarning: m => { void vscode.window.showWarningMessage(m); },
    writeClipboard: t => vscode.env.clipboard.writeText(t),
    showInfo: m => { void vscode.window.showInformationMessage(m); },
};

/**
 * Builds the modal `detail` text for the terminal-send confirmation: line
 * count, what is about to happen, and a short truncated preview.
 *
 * @param content - The rendered text about to be sent.
 * @returns The modal `detail` string.
 * @example terminalConfirmDetail('echo hi\nrm -rf /'); // → '2 lines will be pasted…'
 */
function terminalConfirmDetail(content: string): string {
    const lines = content.split('\n');
    const clamp = (line: string): string =>
        line.length > CONFIRM_PREVIEW_LINE_MAX ? `${line.slice(0, CONFIRM_PREVIEW_LINE_MAX)}…` : line;
    const preview = lines.slice(0, CONFIRM_PREVIEW_LINE_COUNT).map(clamp).join('\n')
        + (lines.length > CONFIRM_PREVIEW_LINE_COUNT ? '\n…' : '');

    return vscode.l10n.t(
        '{0} lines will be pasted into the terminal as one block, without pressing Enter. If the receiving shell does not support bracketed paste, each line could run on its own.',
        lines.length,
    ) + `\n\n${preview}`;
}

/**
 * Renders the previewed block through the engine (`artifact.render`): the preview's own
 * (possibly staged) `code` and the raw typed values. The engine owns default fallback, so
 * nothing is merged here. Warnings show as one toast.
 *
 * @param artifact - Previewed artifact (needs engine meta).
 * @param code     - The preview's code, staged edits included.
 * @param rawVars  - Untrusted webview vars; cleaned by `sanitiseVarsSnapshot`.
 * @param blockRef - Which block the preview shows.
 * @param io       - Warning sink.
 * @returns The engine's `Rendered`, or `undefined` after the user was told (or nothing to render).
 * @example
 * const r = await renderForDelivery(artifact, 'echo <VK-a>', { 'VK-a': '1' }, { kind: 'single' });
 */
export async function renderForDelivery(
    artifact: ParsedArtifactFile, code: string, rawVars: unknown, blockRef: BlockRef, io: DeliveryIO = DELIVERY_IO,
): Promise<Rendered | undefined> {
    const meta = engineMeta(artifact);
    if (!meta) { out.appendLine(`[render] no engine meta for ${artifact.filePath}`); return undefined; }
    const block = await blockIndex(meta.relPath, blockRef);
    if (block === null) { return undefined; }
    const r = await requestOrNotify('artifact.render', {
        path: meta.relPath, ...(block === undefined ? {} : { block }), code, values: sanitiseVarsSnapshot(rawVars),
    });
    if (r && r.warnings.length > 0) { io.showWarning(r.warnings.map(engineWarningMessage).join('\n')); }
    return r;
}

/**
 * Delivers rendered output to the editor or terminal.
 *
 * Target by {@link resolveInsertTarget}. 🔒 A terminal send of output the engine flags
 * `containsEscape` is refused before the confirm and before any terminal exists (D-11);
 * the flag is read on the engine's `output`, never on the bracketed-paste wrapper (which
 * carries ESC itself). Multi-line both-context payloads are confirmed, then pasted as one block.
 *
 * @param editor            - Editor to insert into, or `undefined`.
 * @param type              - Artifact type.
 * @param r                 - Engine render result.
 * @param invocationSurface - Which menu invoked the insert.
 * @param io                - Sinks.
 * @returns Resolves once delivered or refused.
 * @example
 * await performInsert(vscode.window.activeTextEditor, 'Snippet', r, 'editor');
 */
export async function performInsert(
    editor: vscode.TextEditor | undefined, type: ArtifactType, r: Rendered,
    invocationSurface: InvocationSurface, io: DeliveryIO = DELIVERY_IO,
): Promise<void> {
    if (resolveInsertTarget(type, invocationSurface) === 'terminal') {
        if (r.containsEscape) {
            await notifyEngineError(new EngineRequestError({ code: 'render.contains_escape', params: {} }));
            return;
        }
        if (needsTerminalConfirmation(type, r.output)) {
            const ok = await confirmModal({
                message: vscode.l10n.t('Send multi-line content to the terminal?'),
                action: vscode.l10n.t('Send'),
                detail: terminalConfirmDetail(r.output),
            });
            if (!ok) { return; }
        }
        const terminal = io.terminal();
        terminal.sendText(wrapForTerminal(type, r.output), false);
        terminal.show(true);
        return;
    }
    if (editor) {
        await editor.edit(edit => edit.insert(editor.selection.active, r.output));
        return;
    }
    // No clipboard fallback: Copy is its own button and resolves identically.
    io.showWarning(vscode.l10n.t('MD Artifacts: No editor open to insert into. Use Copy instead.'));
}
