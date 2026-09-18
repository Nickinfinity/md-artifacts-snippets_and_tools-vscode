import * as vscode from 'vscode';
import { escHtml, styleLinkTags } from '../../../utils/html.js';
import type { VarSetFormPayload } from '../../../types/varset.types.js';

/**
 * Renders the variable-set creation form's webview HTML.
 *
 * Self-contained on purpose (`renderIdleHtml` — `mainView.render.ts` — is the
 * precedent this follows): inline `<style nonce>` plus one `<script nonce>`
 * IIFE with a single `acquireVsCodeApi()` call, no separate client-JS file.
 * Rows are server-rendered and pre-escaped through {@link escHtml}, so the
 * client script never builds HTML and carries no `esc`/`lbl` helper of its
 * own — `WEBVIEW_ESC_LBL_JS` does not apply here for the same reason
 * `renderIdleHtml` does not use it.
 *
 * Rows are edit-in-place: the form edits the pairs it was opened with, no
 * add/remove row affordance.
 *
 * @param payload   - Current form values (title, description, tags, pairs).
 * @param cssUris   - Webview URIs for the stylesheets (`base.css`, `form.css`).
 * @param cspSource - Webview CSP source token (`webview.cspSource`).
 * @param nonce     - CSP nonce shared by the `<style>` and `<script>` tags.
 * @returns Complete HTML document string for `webview.html`.
 *
 * @example
 * renderVarSetFormHtml(
 *     { title: 'Local Dev', description: '', tags: ['api'], pairs: [['VK-host', 'localhost']] },
 *     ['base.css', 'form.css'], webview.cspSource, getNonce(),
 * )
 */
export function renderVarSetFormHtml(
    payload: VarSetFormPayload,
    cssUris: string | string[],
    cspSource: string,
    nonce: string,
): string {
    const safeNonce = escHtml(nonce);
    // cspSource is the webview's own opaque scheme token (e.g.
    // `vscode-webview://…`), not vault/user content, so it is interpolated
    // raw here — the same choice `renderIdleHtml` (mainView.render.ts:149)
    // makes for the same reason. Escaping it (as form.html.ts:118 does for a
    // *different*, unnonced style-src) would corrupt a token that can itself
    // contain no HTML-special characters, for no security benefit.
    // Nonced inline <style> requires the matching nonce in style-src, or the
    // sheet is silently blocked at runtime with no visible error (T2.1 note).
    const csp = `default-src 'none'; script-src 'nonce-${safeNonce}'; `
        + `style-src ${cspSource} 'nonce-${safeNonce}';`;

    const tagsHtml = payload.tags.map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join('');
    // Tags are vault frontmatter (untrusted) and this value is embedded inside
    // an inline <script>, not HTML text — escHtml (meant for HTML/attributes)
    // would not stop a tag containing "</script>" from closing the block
    // early. `<` → `<` is the standard guard for JSON-in-<script>.
    const backslash = String.fromCodePoint(92);
    const lessThan  = String.fromCodePoint(60);
    const tagsJs = JSON.stringify(payload.tags).replaceAll(lessThan, `${backslash}u003c`);
    const rowsHtml = payload.pairs.map(([name, value], i) => `
      <tr class="var-row">
        <td class="var-name"><input class="form-input var-input" data-role="name" data-index="${i}" value="${escHtml(name)}"></td>
        <td class="var-default"><input class="form-input var-input" data-role="value" data-index="${i}" value="${escHtml(value)}"></td>
      </tr>`).join('');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${styleLinkTags(cssUris)}
<style nonce="${safeNonce}">
  .varset-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .varset-form-error { color: var(--vscode-errorForeground, #f48771); font-size: 0.85rem; }
</style>
</head>
<body class="form-body">
  <div class="form-panel">
    <div class="form-section">
      <label for="vsfTitle">${escHtml(vscode.l10n.t('Name'))}</label>
      <input class="form-input" id="vsfTitle" value="${escHtml(payload.title)}">
    </div>
    <div class="form-section">
      <label for="vsfDescription">${escHtml(vscode.l10n.t('Description'))}</label>
      <textarea class="form-input form-textarea" id="vsfDescription">${escHtml(payload.description)}</textarea>
    </div>
    <div class="form-section">
      <label>${escHtml(vscode.l10n.t('Tags'))}</label>
      <div class="tags-row">${tagsHtml}</div>
    </div>
    <div class="form-section">
      <label>${escHtml(vscode.l10n.t('Variables'))}</label>
      <table class="vars-table"><tbody>${rowsHtml}</tbody></table>
    </div>
    <div id="vsfError" class="varset-form-error" hidden></div>
    <div class="varset-form-actions">
      <button id="vsfCancel">${escHtml(vscode.l10n.t('Cancel'))}</button>
      <button id="vsfSave">${escHtml(vscode.l10n.t('Save'))}</button>
    </div>
  </div>
<script nonce="${safeNonce}">
(function () {
  const vscode = acquireVsCodeApi();

  function collectPairs() {
    const names  = Array.from(document.querySelectorAll('[data-role="name"]'));
    const values = Array.from(document.querySelectorAll('[data-role="value"]'));
    return names.map(function (el, i) { return [el.value, values[i].value]; });
  }

  document.getElementById('vsfCancel').addEventListener('click', function () {
    vscode.postMessage({ command: 'cancel' });
  });

  const errorEl = document.getElementById('vsfError');

  document.getElementById('vsfSave').addEventListener('click', function () {
    // Clear any reason left over from a prior rejected attempt so it cannot
    // linger over this fresh submission.
    errorEl.textContent = '';
    errorEl.hidden = true;
    vscode.postMessage({
      command: 'save',
      payload: {
        title: document.getElementById('vsfTitle').value,
        description: document.getElementById('vsfDescription').value,
        tags: ${tagsJs},
        pairs: collectPairs(),
      },
    });
  });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg && msg.command === 'saveFailed') {
      // textContent only — never innerHTML. msg.reason is extension-authored
      // today, but this is the webview's inbound boundary regardless.
      errorEl.textContent = msg.reason;
      errorEl.hidden = false;
      vscode.postMessage({ command: 'saveFailedAck' });
    }
  });
})();
</script>
</body>
</html>`;
}

/**
 * Shape-guards an inbound webview payload into a {@link VarSetFormPayload}.
 *
 * The webview message is untrusted: `pairs` entries carry user-typed variable
 * *names* as well as values, and both are emitted verbatim into a ` ```vks `
 * fence on write, so every field is checked before use. Hostile input is
 * **rejected, never sanitised** — a malformed payload returns `undefined`
 * rather than a best-effort coercion.
 *
 * @param raw - The `msg.payload` value posted from the webview, untyped.
 * @returns The validated payload, or `undefined` when the shape is wrong.
 *
 * @example
 * parseVarSetFormPayload({ title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] })
 * // → { title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] }
 * parseVarSetFormPayload({ title: 'x', pairs: 'not-an-array' }) // → undefined
 */
export function parseVarSetFormPayload(raw: unknown): VarSetFormPayload | undefined {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const obj = raw as Record<string, unknown>;

    if (typeof obj.title !== 'string') {
        return undefined;
    }
    const description = typeof obj.description === 'string' ? obj.description : '';

    if (obj.tags !== undefined && (!Array.isArray(obj.tags) || !obj.tags.every(t => typeof t === 'string'))) {
        return undefined;
    }
    const tags = (obj.tags as string[] | undefined) ?? [];

    if (!Array.isArray(obj.pairs)) {
        return undefined;
    }
    const pairs: [string, string][] = [];
    for (const entry of obj.pairs) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
            return undefined;
        }
        pairs.push([entry[0], entry[1]]);
    }

    return { title: obj.title, description, tags, pairs };
}
