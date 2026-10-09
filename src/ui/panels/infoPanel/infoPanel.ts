import * as vscode from 'vscode';
import { getNonce } from '../../../utils/helpers.js';
import { renderInfoHtml } from './infoPanel.render.js';
import type { InfoModel } from '../../../types/info.types.js';

const INFO_VIEW_TYPE = 'mdArtifacts.info';

/** The one open View Info popup, reused so repeated clicks do not stack tabs. */
let current: vscode.WebviewPanel | undefined;

/**
 * Shows a View Info popup for any artifact — the one entry point every
 * artifact type's "View Info" command calls with its own `InfoModel`.
 *
 * Opens beside the active editor without taking focus, so the tree keeps it
 * and the next item can be inspected straight away; an open popup is updated
 * in place instead of opening a second one. Scripts are disabled: the popup
 * is read-only.
 *
 * @param extensionUri - Extension root, for `localResourceRoots` and `base.css`.
 * @param model        - What to show.
 * @returns Nothing.
 *
 * @example
 * openInfoPanel(context.extensionUri, buildVariablesInfo(target, node));
 */
export function openInfoPanel(extensionUri: vscode.Uri, model: InfoModel): void {
    const uiRoot = vscode.Uri.joinPath(extensionUri, 'src', 'ui');
    const title = vscode.l10n.t('Info: {0}', model.title);
    if (!current) {
        current = vscode.window.createWebviewPanel(
            INFO_VIEW_TYPE, title,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: false, localResourceRoots: [uiRoot] },
        );
        current.onDidDispose(() => { current = undefined; });
    } else {
        current.title = title;
        current.reveal(vscode.ViewColumn.Beside, true);
    }
    const baseCss = current.webview.asWebviewUri(vscode.Uri.joinPath(uiRoot, 'base.css')).toString();
    current.webview.html = renderInfoHtml(model, [baseCss], current.webview.cspSource, getNonce());
}
