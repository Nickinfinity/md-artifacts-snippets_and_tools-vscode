import * as vscode from 'vscode';
import { escHtml } from '../../../utils/html.js';
import { WEBVIEW_ESC_LBL_JS } from './webviewSnippets.js';
import { CODE_BLOCK_MIN_LINES } from '../../../types/constants.js';

/**
 * Debounce window (ms) shared by the code area's local re-render and the
 * preview panel's `varsSnapshot` post — both were the same bare `150`
 * literal in two places before this constant existed.
 *
 * @example
 * setTimeout(fn, INPUT_DEBOUNCE_MS);
 */
export const INPUT_DEBOUNCE_MS = 150;

/**
 * Builds the contenteditable code-block HTML fragment.
 *
 * The wrapper carries the `editable` modifier so it gets the editor border /
 * caret colour from `code-block.css`.  Line numbers are server-rendered (passed in
 * via `rowsHtml`) and refreshed in-place on every keystroke by the client-side
 * script.
 *
 * @param rowsHtml - Pre-rendered row HTML produced by `renderCodeRowsHtml`.
 * @param lang     - Highlight.js language id (echoed into `data-lang` for inspection).
 * @returns The slabel + wrapper HTML.
 *
 * @example
 * buildCodeBlockHtml(renderCodeRowsHtml(code, 'javascript'), 'javascript')
 */
export function buildCodeBlockHtml(rowsHtml: string, lang: string): string {
    const expandLabel = escHtml(vscode.l10n.t('Open this block in the editor'));
    return /* html */`
  <div class="code-toolbar">
    <button class="expand-editor-btn" id="expandCodeBtn" title="${expandLabel}"
            aria-label="${expandLabel}">⤢</button>
  </div>
  <div id="codeWrapper" class="code-block-wrapper editable" contenteditable="true" spellcheck="false"
       style="--mda-code-min-lines: ${CODE_BLOCK_MIN_LINES}" data-lang="${escHtml(lang)}">${rowsHtml || ''}</div>`;
}

/**
 * Client-side JavaScript that powers the editable code area.
 *
 * Designed to be inlined inside the outer preview-panel IIFE (which already
 * holds `vscode = acquireVsCodeApi()`).  This payload:
 *
 * - Looks up `#codeWrapper` itself.
 * - Concatenates `WEBVIEW_ESC_LBL_JS` for the shared `esc`/`lbl` helpers,
 *   then defines local `extractCode`, `vkWrap`, `renderRows`.
 * - Implements caret-preserving re-render on `input` (debounced 150 ms).
 * - Intercepts `Enter` to insert a literal `\n` (avoids `<div>` wrapping).
 * - Intercepts paste to strip rich HTML.
 * - Exposes `window.__codeBlock = { extractCode, renderRows }` so the outer
 *   script can read the latest plain-text code and re-render after a server
 *   `fileUpdated` round-trip.
 *
 * Tagged with `String.raw` so escape sequences below (`\n`, `\w`) are written
 * once instead of doubled — raw mode only changes how *this* TS template
 * reads its own source; the emitted webview JS text is unaffected.
 *
 * @example
 * const html = `<script nonce="${n}">(function(){ const vscode = acquireVsCodeApi(); ${CODE_BLOCK_CLIENT_JS} ... })();</script>`;
 */
export const CODE_BLOCK_CLIENT_JS = /* javascript */ String.raw`${WEBVIEW_ESC_LBL_JS}
  // ── Code-block client (Part 2) ──────────────────────────────────────────
  const codeWrapper = document.getElementById('codeWrapper');

  function extractCode() {
    const rows = codeWrapper.querySelectorAll('.code-line-row');
    if (rows.length === 0) { return codeWrapper.textContent || ''; }
    const parts = [];
    rows.forEach(r => {
      const c = r.querySelector('.code-content');
      parts.push(c ? c.textContent : '');
    });
    return parts.join('\n');
  }

  // Opening and closing spellings both name one variable — the twin of
  // VK_TOKEN_RE in parser.service.ts, bound to it by webview-snippets.test.ts.
  function vkWrap(html) {
    return html.replace(/&lt;(\/?)VK-([A-Za-z]\w*)&gt;/g, '<span class="vk-var">&lt;$1VK-$2&gt;</span>');
  }
  function renderRows(code) {
    const lines = code.split('\n');
    return lines.map(function (line, i) {
      return '<div class="code-line-row"><span class="line-number" contenteditable="false">' +
        (i + 1) + '</span><span class="code-content">' + vkWrap(esc(line)) + '</span></div>';
    }).join('');
  }

  // ── Caret offset (counted across all .code-content text + joining \n) ──
  function getCaretOffset() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { return 0; }
    const range = sel.getRangeAt(0);
    if (!codeWrapper.contains(range.endContainer)) { return 0; }
    const rows = codeWrapper.querySelectorAll('.code-line-row');
    let offset = 0;
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i].querySelector('.code-content');
      if (!c) { continue; }
      if (c.contains(range.endContainer) || c === range.endContainer) {
        const pre = document.createRange();
        pre.selectNodeContents(c);
        pre.setEnd(range.endContainer, range.endOffset);
        return offset + pre.toString().length;
      }
      offset += c.textContent.length + 1;
    }
    return offset;
  }
  function setCaretOffset(offset) {
    const rows = codeWrapper.querySelectorAll('.code-line-row');
    let remaining = offset;
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i].querySelector('.code-content');
      if (!c) { continue; }
      const len = c.textContent.length;
      if (remaining <= len) { placeCaret(c, remaining); return; }
      remaining -= len + 1;
    }
    const last = rows[rows.length - 1] && rows[rows.length - 1].querySelector('.code-content');
    if (last) { placeCaret(last, last.textContent.length); }
  }
  function placeCaret(el, off) {
    let remaining = off, target = null, targetOffset = 0;
    (function walk(node) {
      if (target) { return; }
      if (node.nodeType === 3 /* TEXT_NODE */) {
        if (remaining <= node.length) { target = node; targetOffset = remaining; }
        else { remaining -= node.length; }
        return;
      }
      for (let i = 0; i < node.childNodes.length && !target; i++) { walk(node.childNodes[i]); }
    })(el);
    const range = document.createRange();
    if (target) { range.setStart(target, targetOffset); range.collapse(true); }
    else        { range.selectNodeContents(el); range.collapse(false); }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── Re-render on input (debounced) ────────────────────────────────────
  let renderTimer;
  function scheduleRender() {
    if (renderTimer) { clearTimeout(renderTimer); }
    renderTimer = setTimeout(function () {
      renderTimer = undefined;
      const code  = extractCode();
      const caret = getCaretOffset();
      codeWrapper.innerHTML = renderRows(code);
      setCaretOffset(caret);
    }, ${INPUT_DEBOUNCE_MS});
  }
  codeWrapper.addEventListener('input', scheduleRender);
  codeWrapper.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      document.execCommand('insertText', false, '\n');
    }
  });
  codeWrapper.addEventListener('paste', function (ev) {
    ev.preventDefault();
    const text = (ev.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // Bridge: expose the hooks the outer script needs.
  window.__codeBlock = {
    extractCode: extractCode,
    renderRows:  renderRows,
    flushPendingRender: function () {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = undefined; }
    },
    setCode: function (code) {
      codeWrapper.innerHTML = renderRows(code || '');
    },
  };
`;
