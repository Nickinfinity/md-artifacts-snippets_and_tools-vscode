import * as vscode from 'vscode';

/** What a confirmation asks: the question, the confirming button, optional consequences. */
type ConfirmOpts = { message: string; action: string; detail?: string };

let sink: ((opts: ConfirmOpts) => Promise<boolean>) | undefined;

/**
 * Replaces the modal with a function, for tests. The test host refuses real dialogs, so
 * every write-path test answers a confirmation through this one seam (W3, H3.0d).
 *
 * @param fn - Answers each confirmation; `undefined` restores the real modal.
 * @returns Nothing.
 * @example
 * setConfirmSink(async () => true); // teardown: setConfirmSink(undefined)
 */
export function setConfirmSink(fn: ((opts: ConfirmOpts) => Promise<boolean>) | undefined): void { sink = fn; }

/**
 * Shows a modal confirmation and reports whether the user accepted.
 *
 * **THE** modal-confirm helper. Every destructive or overwriting action in the
 * extension routes through it, because the same three-line shape was being
 * written per call site and the important part — that Cancel *and* Escape both
 * mean no — is easy to get subtly wrong: `showWarningMessage` resolves
 * `undefined` for either, so the single equality check below covers both, and
 * a hand-rolled `!== 'Cancel'` would treat Escape as consent.
 *
 * @param opts - `message` (the question), optional `detail` (consequences),
 *               and `action` (the confirming button's label).
 * @returns `true` only when the user pressed the action button.
 *
 * @example
 * if (await confirmModal({ message: 'Overwrite demo.md?', action: 'Overwrite' })) { … }
 */
export async function confirmModal(opts: {
    message: string;
    detail?: string;
    action: string;
}): Promise<boolean> {
    if (sink) { return sink(opts); }
    const answer = await vscode.window.showWarningMessage(
        opts.message,
        { modal: true, ...(opts.detail ? { detail: opts.detail } : {}) },
        opts.action,
    );
    return answer === opts.action;
}
