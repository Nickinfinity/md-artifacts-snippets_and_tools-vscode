import * as vscode from 'vscode';
import { getNonce } from '../../../utils/helpers.js';
import { renderVarSetFormHtml, parseVarSetFormPayload } from './varsetForm.render.js';
import type { VarSetFormPayload } from '../../../types/varset.types.js';

const FORM_VIEW_TYPE = 'obsidianArtifacts.varSetForm';

/**
 * Callback bag the var-set form panel is composed with — the repo's
 * established controller idiom (`PreviewCallbacks`, `MultiIndexCallbacks`).
 * The panel never imports the model-builder/slug/write service directly;
 * everything past "the user clicked Save" is reached through this bag, so
 * the renderer/panel and the write-path service stay independently buildable.
 */
export interface VarSetFormCallbacks {
    /** Checks a payload before writing; `ok: false` carries the failure reason to show the user. */
    validate(payload: VarSetFormPayload): { ok: true } | { ok: false; reason: string };
    /** Writes the validated payload to `Variables/<slug>.md`. */
    write(payload: VarSetFormPayload): Promise<void>;
    /** Posts a message back into the form webview. */
    post(msg: Record<string, unknown>): void;
    /** Closes the form (disposes the panel). */
    close(): void;
}

/**
 * Handles one inbound webview message for the var-set form.
 *
 * Exported as a pure function — separate from `openVarSetFormPanel` — because
 * no test in this repo can post a message into a real `WebviewPanel`; this is
 * what makes the save/cancel contract unit-testable against a fake bag.
 *
 * @param msg - The raw message posted from the webview (`{ command, payload? }`).
 * @param cb  - Callback bag supplying validate/write/post/close.
 * @returns Resolves once the message has been fully handled.
 *
 * @example
 * await handleVarSetFormMessage({ command: 'save', payload }, cb);
 */
export async function handleVarSetFormMessage(
    msg: Record<string, unknown>,
    cb: VarSetFormCallbacks,
): Promise<void> {
    if (msg.command === 'cancel') {
        cb.close();
        return;
    }

    if (msg.command === 'save') {
        const payload = parseVarSetFormPayload(msg.payload);
        if (!payload) {
            cb.post({ command: 'saveFailed', reason: 'Malformed payload.' });
            return;
        }

        const result = cb.validate(payload);
        if (!result.ok) {
            cb.post({ command: 'saveFailed', reason: result.reason });
            return;
        }

        await cb.write(payload);
        cb.close();
    }
}

/**
 * Opens the variable-set creation form panel.
 *
 * Takes `extensionUri`, not `ExtensionContext` — there is no source for a
 * context here (`VarSetController`'s constructor is the same shape), and the
 * form has no block-expand or storage need beyond it.
 *
 * @param values        - Current non-empty variable values, keyed by full `VK-xxx` name.
 * @param tags          - Tags carried over from the active artifact.
 * @param extensionUri  - Extension root URI, for `localResourceRoots` and stylesheet URIs.
 * @param cb            - Callback bag supplying validate/write/post/close.
 *
 * @example
 * openVarSetFormPanel({ 'VK-host': 'localhost' }, ['api'], context.extensionUri, cb);
 */
export function openVarSetFormPanel(
    values: Record<string, string>,
    tags: string[],
    extensionUri: vscode.Uri,
    cb: VarSetFormCallbacks,
): void {
    const uiRoot = vscode.Uri.joinPath(extensionUri, 'src', 'ui');
    const panel = vscode.window.createWebviewPanel(
        FORM_VIEW_TYPE,
        vscode.l10n.t('Save Variable Set'),
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [uiRoot],
        },
    );

    const cssUris = ['base.css', 'form.css'].map(f =>
        panel.webview.asWebviewUri(vscode.Uri.joinPath(uiRoot, f)).toString());

    const payload: VarSetFormPayload = {
        title: '',
        description: '',
        tags,
        pairs: Object.entries(values),
    };

    panel.webview.html = renderVarSetFormHtml(payload, cssUris, panel.webview.cspSource, getNonce());

    const bag: VarSetFormCallbacks = {
        ...cb,
        post: (msg) => { void panel.webview.postMessage(msg); },
        close: () => { panel.dispose(); cb.close(); },
    };

    panel.webview.onDidReceiveMessage((msg: unknown) => {
        void handleVarSetFormMessage(msg as Record<string, unknown>, bag);
    });
}
