import { fromEngineModel } from '../../engine/model.js';
import type { PrefillFn } from './editor.capture.js';
import type { ArtifactType } from '../../types/parsed-artifact.types.js';
import type { CaptureResult } from '../../types/artifact-form.types.js';

/**
 * Everything `captureTerminal` needs from the outside world, injected so the
 * function stays pure and `vscode`-free. The real caller wires this to
 * `vscode.env.clipboard` and `workbench.action.terminal.copySelection` — see
 * the now-deleted `create.command.ts`, which reached for
 * `(activeTerminal as any)?.shellIntegration?.selection`. That branch was dead
 * code: `TerminalShellIntegration` (stable `@types/vscode`) exposes `cwd`,
 * `env` and `executeCommand` only — never a `selection` property — so it was
 * always `undefined` and always fell through to the clipboard. The only real terminal-selection capture VS Code
 * offers is copying the selection into the clipboard via the command palette
 * action, which is why this bag copies first and diffs against the saved
 * value instead of reading a selection directly.
 */
export interface TerminalCaptureBag {
    /** Reads the current clipboard text. */
    readClipboard(): Promise<string>;
    /** Overwrites the clipboard text. */
    writeClipboard(text: string): Promise<void>;
    /** Runs `workbench.action.terminal.copySelection` (or equivalent). */
    copySelection(): Promise<void>;
    /** Whether a terminal is active — guards against copying with none open. */
    hasActiveTerminal(): boolean;
}

/**
 * Captures terminal text for the create-form: tries a terminal selection
 * first (via a copy-to-clipboard round trip, since VS Code exposes no direct
 * selection read), falls back to whatever the clipboard already held, and
 * always restores the clipboard to its pre-capture value.
 *
 * Sequence: save the clipboard → (if a terminal is active) run
 * `copySelection()` and re-read the clipboard — a changed value is the
 * selection (`source: 'selection'`); unchanged means there was no selection,
 * so the saved value is treated as the user's own clipboard content
 * (`source: 'clipboard'`). The saved value is restored in a `finally` on
 * every path, including a throw from `copySelection`/`readClipboard`.
 *
 * @param bag  - Injected I/O, see `TerminalCaptureBag`.
 * @param type - Target artifact type.
 * @param prefill - Injected engine call (language rules live in the engine).
 * @returns The capture result, or `undefined` when there was nothing to capture.
 *
 * @example
 * const result = await captureTerminal(realBag, 'Command', prefill);
 * // result?.source === 'selection' | 'clipboard' | undefined
 */
export async function captureTerminal(
    bag: TerminalCaptureBag,
    type: ArtifactType,
    prefill: PrefillFn,
): Promise<CaptureResult | undefined> {
    const saved = await bag.readClipboard();

    try {
        let text = saved;
        let source: 'selection' | 'clipboard' = 'clipboard';

        if (bag.hasActiveTerminal()) {
            await bag.copySelection();
            const afterCopy = await bag.readClipboard();
            if (afterCopy !== saved) {
                text = afterCopy;
                source = 'selection';
            }
        }

        if (!text) {
            return undefined;
        }

        const m = await prefill({ source: 'terminal', type, text });
        return m && { prefill: fromEngineModel(m), source };
    } finally {
        await bag.writeClipboard(saved);
    }
}
