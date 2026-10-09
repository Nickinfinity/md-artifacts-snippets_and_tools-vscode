import * as vscode from 'vscode';
import { escHtml } from '../../../utils/html.js';
import { jsStr } from '../artifactPicker/webviewSnippets.js';
import { DEFAULT_SUBSET_NAME } from '../../../services/variables-crud.service.js';
import { buildReorderButtons, REORDER_CLIENT_JS } from '../shared/reorderControls.js';

// Resolved at import time — the display language is fixed at activation.
const RENAME_LABEL = vscode.l10n.t('Rename sub-set');
const DELETE_LABEL = vscode.l10n.t('Delete sub-set');
const DESC_PLACEHOLDER = vscode.l10n.t('Description (optional)');

/**
 * Renders one edit-mode sub-set: a `.subset-group` holding its header (name +
 * rename/delete controls), its variable table and its Add variable button.
 *
 * Every group carries a `data-role="heading"` input, because the heading is
 * what the webview posts back for this sub-set — a rename or a delete only
 * stays aligned to its rows if the name travels with them. A named sub-set
 * shows its `<h3>` with the input hidden until ✎ swaps them; a heading-less
 * sub-set shows the input directly (hidden while it is the file's only one,
 * so a one-block file still edits as a plain variable list).
 *
 * Under the header sits the sub-set's description — the prose between its
 * `## ` heading and its fence. A one-block file has no heading to hang one
 * under, so the field is hidden there and revealed with the name field when
 * Add sub-set turns the block into a sub-set.
 *
 * Delete is offered on every sub-set, the last one included: saving with none
 * left writes a frontmatter-only file, which reopens as one empty sub-set.
 *
 * @param heading     - The sub-set's heading, `''` when the file has none.
 * @param subSetIndex - Render-time index (`data-subset`; not load-bearing).
 * @param total       - Number of sub-sets in the file (1 = the file's only one).
 * @param rowsHtml    - The group's table + Add variable markup (`renderVarPairRows`),
 *                      passed in so this module does not import the renderer back.
 * @param description - The sub-set's description, `''` when it has none.
 * @returns The `.subset-group` markup, every vault value escaped.
 *
 * @example
 * renderSubSetGroup('Dev', 0, 2, renderVarPairRows([['VK-host', 'localhost']], 0));
 */
export function renderSubSetGroup(
    heading: string,
    subSetIndex: number,
    total: number,
    rowsHtml: string,
    description = '',
): string {
    const named = heading !== '';
    const lone = total === 1;
    const descHidden = !named && lone ? ' hidden' : '';
    const placeholder = escHtml(vscode.l10n.t('Sub-set name'));
    const inputHidden = named || lone ? ' hidden' : '';
    const title = named
        ? `<h3 class="subset-heading">${escHtml(heading)}</h3>
        <button class="subset-rename" title="${escHtml(RENAME_LABEL)}" aria-label="${escHtml(RENAME_LABEL)}"><span class="codicon codicon-edit" aria-hidden="true"></span></button>`
        : '';
    return `
    <div class="subset-group">
      <div class="subset-header">
        ${title}
        <input class="form-input subset-heading-input" data-role="heading" data-subset="${subSetIndex}" placeholder="${placeholder}" value="${escHtml(heading)}"${inputHidden}>
        ${buildReorderButtons('subset-group', subSetIndex, total)}
        <button class="subset-delete" title="${escHtml(DELETE_LABEL)}" aria-label="${escHtml(DELETE_LABEL)}"><span class="codicon codicon-trash" aria-hidden="true"></span></button>
      </div>
      <textarea class="form-input form-textarea subset-desc" data-role="subset-desc" rows="2" placeholder="${escHtml(DESC_PLACEHOLDER)}"${descHidden}>${escHtml(description)}</textarea>
      ${rowsHtml}
    </div>`;
}

/**
 * Edit-mode client script for the sub-set groups: `collectPairs` /
 * `collectHeadings` (both read per `.subset-group`, in document order, so a
 * deleted group simply drops out of both), rename, delete and Add sub-set.
 *
 * Runs inside the form's IIFE and relies on its `wireAddVar`. Nothing here
 * writes to disk: a rename or delete is staged in the DOM and reaches the
 * file only on Save, so Cancel discards it — no confirmation needed.
 *
 * @example
 * `${SUBSET_EDIT_CLIENT_JS}` // interpolated by buildVarSetFormClientJs('edit', …)
 */
export const SUBSET_EDIT_CLIENT_JS = `${REORDER_CLIENT_JS}
  // Sub-sets and variable rows both reorder through the shared control; the
  // order on screen is the order collectPairs/collectHeadings post, so a move
  // here is a move in the file.
  function rowsChanged() { reorderRefreshAll(document.getElementById('vsfSubSets')); }
  reorderWire(document.getElementById('vsfSubSets'));

  function subSetGroups() { return Array.from(document.querySelectorAll('.subset-group')); }

  function collectPairs() {
    return subSetGroups().map(function (group) {
      var names  = Array.from(group.querySelectorAll('[data-role="name"]'));
      var values = Array.from(group.querySelectorAll('[data-role="value"]'));
      return names.map(function (el, i) { return [vkName(el.value), values[i].value]; });
    });
  }

  // One description per group, aligned like the headings. A hidden field (a
  // one-block set) posts '' — there is no heading line to keep it under.
  function collectDescriptions() {
    return subSetGroups().map(function (group) {
      var d = group.querySelector('[data-role="subset-desc"]');
      return d && !d.hidden ? d.value : '';
    });
  }

  // One heading per group, always — the panel takes them verbatim, so a
  // renamed or reordered-by-delete sub-set keeps the name the user sees.
  function collectHeadings() {
    return subSetGroups().map(function (group) {
      var h = group.querySelector('[data-role="heading"]');
      return h ? h.value : '';
    });
  }

  // ── Rename / delete ──────────────────────────────────────────────────────
  function wireSubSetControls(group) {
    var title  = group.querySelector('.subset-heading');
    var input  = group.querySelector('[data-role="heading"]');
    var rename = group.querySelector('.subset-rename');
    var del    = group.querySelector('.subset-delete');
    if (title && input && rename) {
      // Enter/blur keep a non-empty name; Escape restores the one shown
      // before. Emptying the name of the ONLY sub-set is the way back to a
      // one-block set: the title goes and the group becomes untitled (saved
      // without a heading). With others present a name is required, so an
      // emptied field restores instead. textContent only — the name is user text.
      function finish(keep) {
        if (input.hidden) { return; }
        var name = input.value.trim();
        if (keep && name) {
          title.textContent = name;
        } else if (keep && subSetGroups().length === 1) {
          title.remove(); rename.remove();
          input.value = ''; input.hidden = true;
          var desc = group.querySelector('[data-role="subset-desc"]');
          if (desc) { desc.hidden = true; }
          return;
        } else {
          input.value = title.textContent;
        }
        input.hidden = true; title.hidden = false; rename.hidden = false;
      }
      rename.addEventListener('click', function () {
        title.hidden = true; rename.hidden = true; input.hidden = false;
        input.focus();
        if (input.select) { input.select(); }
      });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }
    if (del) {
      del.addEventListener('click', function () { group.remove(); rowsChanged(); });
    }
  }
  subSetGroups().forEach(wireSubSetControls);

  // ── Add sub-set ──────────────────────────────────────────────────────────
  // Built with createElement, not a markup string, so the script carries no
  // heading/table literal a whole-document scan would count.
  function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
  document.querySelectorAll('.add-subset').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const container = document.getElementById('vsfSubSets');
      if (!container) { return; }
      // A one-block set hid its name field; with two sub-sets it needs one,
      // pre-filled with the same default the Variables pane gives it.
      subSetGroups().forEach(function (g) {
        var h = g.querySelector('[data-role="heading"]');
        if (h && !g.querySelector('.subset-heading')) {
          h.hidden = false;
          if (!h.value) { h.value = ${jsStr(DEFAULT_SUBSET_NAME)}; }
          var d = g.querySelector('[data-role="subset-desc"]');
          if (d) { d.hidden = false; }
        }
      });
      const group = el('div', 'subset-group');
      const header = el('div', 'subset-header');
      const heading = el('input', 'form-input subset-heading-input');
      heading.setAttribute('data-role', 'heading');
      heading.setAttribute('placeholder', ${jsStr(vscode.l10n.t('Sub-set name'))});
      const del = el('button', 'subset-delete');
      del.setAttribute('title', ${jsStr(DELETE_LABEL)});
      del.setAttribute('aria-label', ${jsStr(DELETE_LABEL)});
      del.appendChild(el('span', 'codicon codicon-trash'));
      const desc = el('textarea', 'form-input form-textarea subset-desc');
      desc.setAttribute('data-role', 'subset-desc');
      desc.setAttribute('rows', '2');
      desc.setAttribute('placeholder', ${jsStr(DESC_PLACEHOLDER)});
      const table = el('table', 'vars-table');
      table.appendChild(document.createElement('tbody'));
      const add = el('button', 'add-var-row');
      add.textContent = ${jsStr(vscode.l10n.t('Add variable'))};
      // Same ↑/↓ markup as the server's (shared template); a span keeps it one node.
      const arrows = el('span', 'reorder-slot');
      arrows.innerHTML = reorderButtonsHtml('subset-group');
      header.appendChild(heading);
      header.appendChild(arrows);
      header.appendChild(del);
      group.appendChild(header);
      group.appendChild(desc);
      group.appendChild(table);
      group.appendChild(add);
      container.appendChild(group);
      wireSubSetControls(group);
      wireAddVar();
      rowsChanged();
      heading.focus();
    });
  });`;
