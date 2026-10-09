import * as vscode from 'vscode';
import { escHtml } from '../../../utils/html.js';
import { jsStr } from '../artifactPicker/webviewSnippets.js';

/**
 * THE ↑/↓ reorder control — markup and client behaviour, for every editor
 * list that can be reordered: the artifact form's block cards, and the
 * var-set form's sub-sets and variable rows.
 *
 * An item is any element with a known class; its buttons name that class in
 * `data-reorder`, so nested lists (rows inside a sub-set) never confuse which
 * element a click moves. Order is the DOM's: every form collects its values
 * in document order, so moving an element *is* the reorder — nothing else to
 * keep in sync.
 *
 * Webview scripts cannot `import`, so the behaviour ships as one string
 * ({@link REORDER_CLIENT_JS}) included once per bundle — the
 * `tagsField.ts` / `WEBVIEW_ESC_LBL_JS` pattern, never a copy-paste.
 */

const MOVE_UP   = vscode.l10n.t('Move up');
const MOVE_DOWN = vscode.l10n.t('Move down');

/**
 * Renders an item's ↑/↓ buttons. `↑` is disabled on the first item and `↓` on
 * the last; the client keeps that true after every move, add and remove.
 *
 * @param item  - Class of the element the buttons move (e.g. `'var-row'`).
 * @param index - The item's position in its list.
 * @param total - Number of items in the list.
 * @param attrs - Extra attributes for both buttons (the artifact form keeps
 *                its `data-block` index on them); `''` for none.
 * @returns The two `<button class="reorder-btn">` elements.
 *
 * @example
 * buildReorderButtons('block-card', 0, 2, ' data-block="0"');
 */
export function buildReorderButtons(item: string, index: number, total: number, attrs = ''): string {
    const up   = index === 0 ? ' disabled' : '';
    const down = index === total - 1 ? ' disabled' : '';
    const button = (action: string, label: string, glyph: string, disabled: string): string =>
        `<button class="reorder-btn" data-reorder="${item}" data-action="${action}"${attrs}${disabled}`
        + ` title="${escHtml(label)}" aria-label="${escHtml(label)}">${glyph}</button>`;
    return button('up', MOVE_UP, '↑', up) + button('down', MOVE_DOWN, '↓', down);
}

// Placeholders the client swaps for an item class and attributes — so markup a
// script builds at runtime comes from the same template as the server's.
const ITEM_SLOT  = '__REORDER_ITEM__';
const ATTRS_SLOT = '__REORDER_ATTRS__';

/**
 * Client half of the reorder control. Defines, inside the host IIFE:
 *
 * - `reorderButtonsHtml(item, attrs)` — the {@link buildReorderButtons} markup,
 *   for rows/cards a script creates (call `reorderRefreshAll` after inserting);
 * - `reorderRefreshAll(root)` — re-applies first/last disabling for every list
 *   under `root` (each list is an item's same-class siblings);
 * - `reorderWire(container, onMoved)` — one delegated click listener moving the
 *   clicked button's item; `onMoved(item)` runs after a move (dirty state,
 *   re-indexing).
 *
 * @example
 * `${REORDER_CLIENT_JS}\n reorderWire(list, function () { markDirty(); });`
 */
export const REORDER_CLIENT_JS = `
  // ── Reorder ↑/↓ — shared (shared/reorderControls.ts) ───────────────────────
  var REORDER_TPL = ${jsStr(buildReorderButtons(ITEM_SLOT, 1, 3, ATTRS_SLOT))};
  function reorderButtonsHtml(item, attrs) {
    return REORDER_TPL.split(${jsStr(ITEM_SLOT)}).join(item).split(${jsStr(ATTRS_SLOT)}).join(attrs || '');
  }
  function reorderPeers(item, cls) {
    var parent = item.parentElement;
    if (!parent) { return []; }
    return Array.from(parent.children).filter(function (c) { return c.classList.contains(cls); });
  }
  function reorderRefreshAll(root) {
    if (!root) { return; }
    root.querySelectorAll('.reorder-btn[data-reorder]').forEach(function (btn) {
      var cls = btn.dataset.reorder;
      var item = btn.closest('.' + cls);
      var peers = item ? reorderPeers(item, cls) : [];
      var i = peers.indexOf(item);
      var edge = btn.dataset.action === 'up' ? i <= 0 : i === peers.length - 1;
      if (edge) { btn.setAttribute('disabled', ''); } else { btn.removeAttribute('disabled'); }
    });
  }
  // Moves item one place among its same-class siblings; false at either end.
  function reorderMove(item, cls, dir) {
    var peers = reorderPeers(item, cls);
    var i = peers.indexOf(item);
    var j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= peers.length) { return false; }
    if (dir === 'up') { item.parentElement.insertBefore(item, peers[j]); }
    else { item.parentElement.insertBefore(peers[j], item); }
    return true;
  }
  function reorderWire(container, onMoved) {
    if (!container) { return; }
    container.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.reorder-btn') : null;
      if (!btn || !btn.dataset.reorder || btn.hasAttribute('disabled')) { return; }
      var item = btn.closest('.' + btn.dataset.reorder);
      if (!item || !reorderMove(item, btn.dataset.reorder, btn.dataset.action)) { return; }
      reorderRefreshAll(container);
      if (onMoved) { onMoved(item); }
    });
    reorderRefreshAll(container);
  }
`;
