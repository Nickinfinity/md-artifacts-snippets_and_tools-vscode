import * as vscode from 'vscode';
import type { ApplyChange } from '../../../types/varset.types.js';
import { escHtml } from '../../../utils/html.js';

/**
 * Maps the `ApplyChange.action` domain enum to its localised UI label.
 *
 * `vscode.l10n.t(c.action)` would pass a variable as the message key, which
 * the `@vscode/l10n-dev` static extractor cannot see — it produces no bundle
 * entry and ships English regardless of locale. Three literal call sites,
 * one per enum member, keep every key extractable.
 *
 * @param action - The change's status (`varset.types.ts`'s `ApplyChange.action`).
 * @returns The localised, human-readable status label.
 *
 * @example
 * actionLabel('filled') // → 'filled' (or its localisation)
 */
function actionLabel(action: ApplyChange['action']): string {
    switch (action) {
        case 'filled': return vscode.l10n.t('filled');
        case 'overridden': return vscode.l10n.t('overridden');
        case 'kept': return vscode.l10n.t('kept');
    }
}

/**
 * Renders the variable-set diff confirmation HTML — a table that lists every
 * change `applyVarSet` produced (filled, overridden, kept) plus Apply / Cancel
 * buttons. The host webview replaces its variables-section innerHTML with
 * this fragment so the user can confirm before committing.
 *
 * Posts `confirmApply` or `cancelApply` on button click. Markup uses class
 * names defined in `src/ui/varset.css`.
 *
 * @param changes    - Per-var change rows from `ApplyResult.changes`.
 * @param subSetName - Human-readable heading of the picked sub-set (used in title).
 * @returns HTML fragment ready to drop into the variables section.
 *
 * @example
 * panel.webview.postMessage({ command: 'showVarSetDiff', html: renderVarSetDiffHtml(changes, 'Local Dev') });
 */
export function renderVarSetDiffHtml(changes: ApplyChange[], subSetName: string): string {
    const e = escHtml;

    const rowsHtml = changes.map(c => {
        const oldCell = c.oldValue === ''
            ? '<span class="empty">∅</span>'
            : `<code>${e(c.oldValue)}</code>`;
        const newCell = c.newValue === ''
            ? '<span class="empty">∅</span>'
            : `<code>${e(c.newValue)}</code>`;
        const klass = `diff-${c.action}`;
        const statusLabel = e(actionLabel(c.action));
        return /* html */`
        <tr class="${klass}">
          <td><code>${e(c.name)}</code></td>
          <td>${oldCell}</td>
          <td>${newCell}</td>
          <td>${statusLabel}</td>
        </tr>`;
    }).join('');

    return /* html */`
    <div class="varset-diff" data-varset-diff>
      <p class="varset-diff-title">${e(vscode.l10n.t('Apply "{0}"?', subSetName))}</p>
      <table class="varset-diff-table">
        <thead>
          <tr>
            <th>${e(vscode.l10n.t('Variable'))}</th>
            <th>${e(vscode.l10n.t('Current'))}</th>
            <th>${e(vscode.l10n.t('New'))}</th>
            <th>${e(vscode.l10n.t('Status'))}</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="actions">
        <button class="btn btn-insert"    id="varSetApplyBtn">${e(vscode.l10n.t('Apply'))}</button>
        <button class="btn btn-cancel"    id="varSetCancelBtn">${e(vscode.l10n.t('Cancel'))}</button>
      </div>
    </div>`;
}
