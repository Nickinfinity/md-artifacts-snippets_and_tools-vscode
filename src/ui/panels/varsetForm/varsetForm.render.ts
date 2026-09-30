import * as vscode from 'vscode';
import { escHtml, styleLinkTags } from '../../../utils/html.js';
import { jsStr, WEBVIEW_ESC_LBL_JS } from '../artifactPicker/webviewSnippets.js';
import { buildTagsField, TAGS_FIELD_CLIENT_JS } from '../shared/tagsField.js';
import type { VarSetFormPayload, VarsEditPayload, VarsEditWirePayload } from '../../../types/varset.types.js';

/**
 * Renders one `<table class="vars-table">` of editable `[name, value]` rows.
 *
 * Extracted from the formerly-inline row-building expression so both create
 * mode (one flat table) and edit mode (one table per sub-set) share a single
 * row renderer. `subSetIndex` is **not** load-bearing — `collectPairs` (the
 * client script) pairs rows by array position, never by `data-subset` —  it
 * exists solely so create mode's omission of the argument keeps the
 * create-mode golden byte-identical (no `data-subset` attribute emitted).
 *
 * @param pairs       - `[name, value]` rows, in display order.
 * @param subSetIndex - Sub-set index for edit mode; omitted in create mode.
 * @returns The `<table class="vars-table">…</table>` markup, values escaped.
 *
 * @example
 * renderVarPairRows([['VK-host', 'localhost']]);       // create mode, no data-subset
 * renderVarPairRows([['VK-host', 'localhost']], 0);     // edit mode, sub-set 0
 */
export function renderVarPairRows(pairs: [string, string][], subSetIndex?: number): string {
    // Row actions are EDIT-MODE ONLY, and `subSetIndex === undefined` is what
    // marks create mode — the same signal that already gates `data-subset`.
    // Create mode keeps its markup byte-for-byte, which is what lets
    // `test/fixtures/varset-form/create-mode.html` stay a real regression pin
    // rather than being regenerated to accommodate this feature. Create mode
    // captures values from a preview it was opened with, so its row set is
    // fixed by definition; edit mode is where a set gains or loses a variable.
    const isEdit = subSetIndex !== undefined;
    const subsetAttr = isEdit ? ` data-subset="${subSetIndex}"` : '';
    const removeCell = isEdit
        ? `
        <td class="var-actions"><button class="row-remove" aria-label="${escHtml(vscode.l10n.t('Remove variable'))}">&#215;</button></td>`
        : '';
    const rowsHtml = pairs.map(([name, value], i) => `
      <tr class="var-row">
        <td class="var-name"><input class="form-input var-input" data-role="name" data-index="${i}"${subsetAttr} value="${escHtml(name)}"></td>
        <td class="var-default"><input class="form-input var-input" data-role="value" data-index="${i}"${subsetAttr} value="${escHtml(value)}"></td>${removeCell}
      </tr>`).join('');
    const table = `<table class="vars-table"><tbody>${rowsHtml}</tbody></table>`;
    if (!isEdit) { return table; }
    const addLabel = escHtml(vscode.l10n.t('Add variable'));
    return `${table}<button class="add-var-row" data-table="${subSetIndex}">${addLabel}</button>`;
}

/**
 * Renders the variable-set form's webview HTML — create mode (a flat pair
 * list) or edit mode (one `<table>` per sub-set, headed by an `<h3>`).
 *
 * Self-contained on purpose (`renderIdleHtml` — `mainView.render.ts` — is the
 * precedent this follows): inline `<style nonce>` plus one `<script nonce>`
 * IIFE with a single `acquireVsCodeApi()` call built from
 * {@link buildVarSetFormClientJs}. Rows are server-rendered and pre-escaped
 * through {@link escHtml}. The client script DOES build HTML — the shared tags
 * field and the added variable rows — so it carries `esc` via
 * `WEBVIEW_ESC_LBL_JS`.
 *
 * Rows are add/remove-able: each carries a remove button and each table an
 * "Add variable" button, because a set that could only edit the rows it was
 * opened with could never gain a second variable.
 *
 * @param payload   - Current form values — a flat `VarSetFormPayload` (create) or a
 *                    sub-set-grouped `VarsEditPayload` (edit); which one is read is
 *                    decided by `mode`, never inferred from the payload's own shape.
 * @param cssUris   - Webview URIs for the stylesheets (`base.css`, `form.css`).
 * @param cspSource - Webview CSP source token (`webview.cspSource`).
 * @param nonce     - CSP nonce shared by the `<style>` and `<script>` tags.
 * @param mode      - `'create'` (default) or `'edit'`.
 * @returns Complete HTML document string for `webview.html`.
 *
 * @example
 * renderVarSetFormHtml(
 *     { title: 'Local Dev', description: '', tags: ['api'], pairs: [['VK-host', 'localhost']] },
 *     ['base.css', 'form.css'], webview.cspSource, getNonce(),
 * )
 */
export function renderVarSetFormHtml(
    payload: VarSetFormPayload | VarsEditPayload,
    cssUris: string | string[],
    cspSource: string,
    nonce: string,
    mode: 'create' | 'edit' = 'create',
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

    // Tags are vault frontmatter (untrusted) and this value is embedded inside
    // an inline <script>, not HTML text — escHtml (meant for HTML/attributes)
    // would not stop a tag containing "</script>" from closing the block
    // early. `<` → `<` is the standard guard for JSON-in-<script>.
    const backslash = String.fromCodePoint(92);
    const lessThan  = String.fromCodePoint(60);
    const tagsJs = JSON.stringify(payload.tags).replaceAll(lessThan, `${backslash}u003c`);
    // 🔴 The union makes `payload.pairs`/`payload.subSets` inaccessible without
    // narrowing first — 'pairs' in payload' (not a cast) decides which shape
    // this call carries, matching the `mode` parameter by construction: a
    // create-mode caller always passes VarSetFormPayload (has `pairs`), an
    // edit-mode caller always passes VarsEditPayload (has `subSets`).
    const rowsHtml = 'pairs' in payload
        ? renderVarPairRows(payload.pairs)
        : payload.subSets.map((sub, i) => `
      <h3 class="subset-heading">${escHtml(sub.heading)}</h3>
      ${renderVarPairRows(sub.pairs, i)}`).join('');

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
    ${buildTagsField(payload.tags)}
    <div class="form-section">
      <label>${escHtml(vscode.l10n.t('Variables'))}</label>
      ${rowsHtml}
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
  ${buildVarSetFormClientJs(mode, tagsJs)}
})();
</script>
</body>
</html>`;
}

/**
 * Builds the var-set form's client-script body — **acquire-free** (no
 * `acquireVsCodeApi()` call of its own; the caller's template keeps
 * `const vscode = acquireVsCodeApi();`, the same shape `mainView.render.ts`
 * uses for `IDLE_CLIENT_JS`). Extracted so `test/webview-dom-harness.ts` can
 * run it directly: the harness's `makeWebviewDom` hands `vscode` in as a
 * parameter and does no `<script>` extraction from seed HTML, so a script
 * that calls `acquireVsCodeApi()` itself throws `ReferenceError` there.
 *
 * `mode` is baked in as a literal (mirroring `mainView.render.ts:207`'s
 * interpolation), selecting `collectPairs`'s behaviour: `'edit'` groups rows
 * per `.vars-table` (one array of rows per sub-set, **always** — including
 * for exactly one table); `'create'` returns the historical flat array. The
 * selector is `.vars-table`, never `table.vars-table` — the harness's
 * `matches()` only supports `#id` / `.class` / `[attr]` / `.class[attr]`, so
 * a tag-qualified selector would silently match nothing.
 *
 * @param mode   - `'create'` or `'edit'` — which `collectPairs` shape to emit.
 * @param tagsJs - Pre-escaped, `JSON.stringify`'d + `<`-guarded tags array literal.
 * @returns The script body to interpolate between the template's IIFE braces.
 *
 * @example
 * buildVarSetFormClientJs('edit', '["api"]')
 */
export function buildVarSetFormClientJs(mode: 'create' | 'edit', tagsJs: string): string {
    const collectPairs = mode === 'edit'
        ? `function collectPairs() {
    var tables = Array.from(document.querySelectorAll('.vars-table'));
    return tables.map(function (table) {
      var names  = Array.from(table.querySelectorAll('[data-role="name"]'));
      var values = Array.from(table.querySelectorAll('[data-role="value"]'));
      return names.map(function (el, i) { return [el.value, values[i].value]; });
    });
  }`
        : `function collectPairs() {
    var names  = Array.from(document.querySelectorAll('[data-role="name"]'));
    var values = Array.from(document.querySelectorAll('[data-role="value"]'));
    return names.map(function (el, i) { return [el.value, values[i].value]; });
  }`;

    return `${collectPairs}

  // Tags are LIVE, not the render-time array: this used to post \`tags: [...]\`
  // baked in at build time, so a tag could never be added or removed — the
  // field rendered as decoration. Shared with the artifact form.
${WEBVIEW_ESC_LBL_JS}
  let tags = ${tagsJs};
  function markDirty() { /* the var-set form tracks no dirty state */ }
${TAGS_FIELD_CLIENT_JS}
  renderTags();

  // ── Add / remove variable rows ───────────────────────────────────────────
  // Without these the form could only edit the values it was opened with — a
  // new set could never gain a second variable, and an unwanted row could
  // never go. Rows are built by the same markup the server paints, so a
  // round trip through collectPairs() sees no difference between them.
  function addRow(table) {
    const body = table.querySelector('tbody');
    if (!body) { return; }
    const tr = document.createElement('tr');
    tr.className = 'var-row';
    tr.innerHTML =
      '<td class="var-name"><input class="form-input var-input" data-role="name" value=""></td>' +
      '<td class="var-default"><input class="form-input var-input" data-role="value" value=""></td>' +
      '<td class="var-actions"><button class="row-remove" aria-label="' + ${jsStr(escHtml(vscode.l10n.t('Remove variable')))} + '">\\xd7</button></td>';
    body.appendChild(tr);
    wireRowRemove();
    const added = tr.querySelector('[data-role="name"]');
    if (added) { added.focus(); }
  }

  function wireRowRemove() {
    document.querySelectorAll('.row-remove').forEach(function (btn) {
      if (btn.dataset.wired === '1') { return; }
      btn.dataset.wired = '1';
      btn.addEventListener('click', function () {
        const row = btn.closest('.var-row');
        if (row) { row.remove(); }
      });
    });
  }

  document.querySelectorAll('.add-var-row').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const table = document.querySelectorAll('.vars-table')[Number(btn.dataset.table || '0')];
      if (table) { addRow(table); }
    });
  });
  wireRowRemove();

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
        tags: tags.slice(),
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
  });`;
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

/**
 * Shape-guards an inbound **edit-mode** webview payload into a
 * {@link VarsEditWirePayload}.
 *
 * Mirrors {@link parseVarSetFormPayload} one nesting level deeper: edit mode
 * posts `pairs` grouped per sub-set (`[string, string][][]`), always — including
 * for a single sub-set — so a flat array is a malformed payload here and is
 * rejected. Hostile input is **rejected, never sanitised**.
 *
 * This guard is only half the protection: it rejects a bad *shape*, while
 * `validateVarPairs` rejects fence-breaking *content*. Both must run before any
 * write, because names and values are emitted verbatim into a ` ```vks ` fence.
 *
 * @param raw - The `msg.payload` value posted from the webview, untyped.
 * @returns The validated wire payload, or `undefined` when the shape is wrong.
 *
 * @example
 * parseVarsEditPayload({ title: 'x', description: '', tags: [], pairs: [[['VK-a', 'b']]] })
 * // → { title: 'x', description: '', tags: [], pairs: [[['VK-a', 'b']]] }
 * parseVarsEditPayload({ title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] })
 * // → undefined — flat, not grouped
 */
export function parseVarsEditPayload(raw: unknown): VarsEditWirePayload | undefined {
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
    const pairs: [string, string][][] = [];
    for (const group of obj.pairs) {
        if (!Array.isArray(group)) {
            return undefined;
        }
        const subSet: [string, string][] = [];
        for (const entry of group) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
                return undefined;
            }
            subSet.push([entry[0], entry[1]]);
        }
        pairs.push(subSet);
    }

    return { title: obj.title, description, tags, pairs };
}
