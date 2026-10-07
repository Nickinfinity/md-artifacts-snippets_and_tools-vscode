import * as vscode from 'vscode';
import { CODE_BLOCK_CLIENT_JS } from '../artifactPicker/codeBlock.js';
import { TAGS_FIELD_CLIENT_JS } from '../shared/tagsField.js';
import { REORDER_CLIENT_JS } from '../shared/reorderControls.js';
import { jsStr } from '../artifactPicker/webviewSnippets.js';
import { escHtml } from '../../../utils/html.js';

// Localised client-script literals — resolved once at import time (extension
// host), spliced bare into the template below (see preview.clientJs.ts JSDoc).
// Every constant that lands in HTML (an attribute or innerHTML) is escaped
// BEFORE it is quoted as a JS string literal — `jsStr(escHtml(...))` — because
// the client script builds HTML by concatenation, so a bundle value crosses
// two boundaries: script literal, then HTML sink. `jsStr` alone only covers
// the first. The tags field's own strings ('Remove {0}', 'Add tag…') live in
// `shared/tagsField.ts` alongside the behaviour that uses them.
const BLOCK_HEADING_JS = jsStr(escHtml(vscode.l10n.t('Block heading')));
const EXPAND_BLOCK_JS = jsStr(escHtml(vscode.l10n.t('Expand block in editor')));
const TOGGLE_BLOCK_JS = jsStr(escHtml(vscode.l10n.t('Toggle block')));
const DESCRIPTION_JS = jsStr(escHtml(vscode.l10n.t('Description')));
const OPTIONAL_BLOCK_DESC_JS = jsStr(escHtml(vscode.l10n.t('Optional block description')));
const TITLE_REQUIRED_JS = jsStr(vscode.l10n.t('Title is required.'));
const NEEDS_CODE_JS = jsStr(vscode.l10n.t('At least one block must have code.'));
const NEEDS_HEADINGS_JS = jsStr(vscode.l10n.t('Every block must have a heading.'));
const INVALID_NAME_JS = jsStr(vscode.l10n.t('Invalid name.'));
const DEFAULT_VALUE_JS = jsStr(escHtml(vscode.l10n.t('Default value')));
const VARIABLES_LABEL_JS = jsStr(escHtml(vscode.l10n.t('Variables')));

// ── Exported client JS bundle ─────────────────────────────────────────────────

/**
 * Client-side JavaScript bundle for the Artifact Form webview panel.
 *
 * Intended to be embedded inside one outer IIFE that provides
 * `const vscode = acquireVsCodeApi()` — call that exactly once per webview.
 * Includes `CODE_BLOCK_CLIENT_JS` (which sets up `window.__codeBlock` for
 * the first / only code area, and also carries the shared `esc`/`lbl`
 * helpers from `webviewSnippets.ts` — see `renderVarsSection` below) then
 * layers in all form-specific interactivity.
 *
 * Responsibilities:
 * 1. Include CODE_BLOCK_CLIENT_JS — exposes `window.__codeBlock` + `renderRows`
 *    + the shared `esc`/`lbl` helpers.
 * 2. Track dirty state; post `markDirty` once per session.
 * 3. Title blur → `validateName`; render `nameValidation` reply inline.
 * 4. Code changes → `detectVars { blockIndex, code }`; merge reply to var inputs.
 * 5. Tag input: Enter to commit, block `,`/`]`/newlines; `×` removes chip.
 * 6. `+` button → `addBlock` + locally append empty card; focus new heading.
 * 7. `×` on card → `removeBlock { blockIndex }`; splice DOM on `removeBlockConfirmed`.
 * 8. `↑`/`↓` → swap adjacent card DOM nodes locally (no round-trip).
 * 9. Save → §3.7 client-side validation; post `save { model }` on pass.
 * 10. Cancel → `cancel { dirty }`; dispose on `cancelConfirmed`.
 * 11. Delete entire → `deleteEntire`; dispose on `deleteEntireConfirmed`.
 * 12. `expand-editor-btn` on card → `expandBlock { index }`; `blockUpdated`
 *     reply replaces that block's code area (`setCodeForBlock`) and marks dirty.
 * 13. Ext→webview messages: nameValidation, varsDetected, saveResult,
 *     removeBlockConfirmed, deleteEntireConfirmed, cancelConfirmed, blockUpdated.
 *
 * @example
 * panel.webview.html = `<script nonce="${nonce}">(function(){
 *   const vscode = acquireVsCodeApi();
 *   ${FORM_CLIENT_JS}
 * })();</script>`;
 */
export const FORM_CLIENT_JS: string = `${CODE_BLOCK_CLIENT_JS}

  // ── Form client (Phase 6b) ───────────────────────────────────────────────

  // ── State ────────────────────────────────────────────────────────────────
  let dirty = false;
  let savePending = false;
  const pendingConfirm = {};   // { removeBlock, deleteEntire, cancel }
  let tags = [];

  // ── Dirty tracking ───────────────────────────────────────────────────────
  function markDirty() {
    if (dirty) { return; }
    dirty = true;
    vscode.postMessage({ command: 'markDirty', dirty: true });
  }

  // ── Per-block code extraction ────────────────────────────────────────────
  // renderRows is in scope from CODE_BLOCK_CLIENT_JS (line 0 shared helpers).
  function extractCodeFrom(wrapper) {
    const rows = wrapper.querySelectorAll('.code-line-row');
    if (rows.length === 0) { return wrapper.textContent || ''; }
    const parts = [];
    rows.forEach(function(r) {
      const c = r.querySelector('.code-content');
      parts.push(c ? (c.textContent || '') : '');
    });
    return parts.join('\\n');
  }

  // ── Block area helpers ───────────────────────────────────────────────────
  const blocksArea = document.getElementById('blocks-area');
  const langMode   = blocksArea ? blocksArea.dataset.langMode : 'free';
  const defLang    = blocksArea ? (blocksArea.dataset.defaultLang || '') : '';
  const singular   = blocksArea ? (blocksArea.dataset.singular || 'block') : 'block';

  function allCards() {
    return Array.from(document.querySelectorAll('.block-card'));
  }

  function cardAt(blockIndex) {
    return document.querySelector('.block-card[data-block-index="' + blockIndex + '"]');
  }

  function codeWrapperInCard(card) {
    return card ? card.querySelector('.code-block-wrapper') : null;
  }

  // Replaces one block's code area after the expand-to-editor round-trip
  // (blockUpdated message). window.__codeBlock.setCode always targets the
  // *first* '#codeWrapper' in the document (server-rendered cards all carry
  // that same id — see codeBlock.ts), so it is only safe to reuse directly in
  // single-block mode; a multi-block card's wrapper is found by class/index
  // instead. Both branches end in the exact same body __codeBlock.setCode
  // uses (renderRows(code || '')) — no second esc/render implementation.
  function setCodeForBlock(blockIndex, code) {
    const cards = allCards();
    if (cards.length === 0) {
      window.__codeBlock.setCode(code);
      return;
    }
    const wrapper = codeWrapperInCard(cardAt(blockIndex));
    if (wrapper) { wrapper.innerHTML = renderRows(code || ''); }
  }

  // ── Code area event setup ────────────────────────────────────────────────
  function initCodeArea(wrapper, blockIndex) {
    let detectTimer;
    wrapper.addEventListener('input', function() {
      markDirty();
      if (detectTimer) { clearTimeout(detectTimer); }
      detectTimer = setTimeout(function() {
        detectTimer = undefined;
        vscode.postMessage({ command: 'detectVars', blockIndex: blockIndex, code: extractCodeFrom(wrapper) });
      }, 300);
    });
    wrapper.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); document.execCommand('insertText', false, '\\n'); }
    });
    wrapper.addEventListener('paste', function(ev) {
      ev.preventDefault();
      const text = (ev.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });
  }

  function initAllCodeAreas() {
    // Single-block: window.__codeBlock already covers #codeWrapper.
    // Multi-block: init each card's wrapper by card DOM order = block index.
    const single = document.getElementById('codeWrapper');
    if (single) {
      single.addEventListener('input', function() {
        markDirty();
        setTimeout(function() {
          vscode.postMessage({ command: 'detectVars', blockIndex: 0, code: extractCodeFrom(single) });
        }, 300);
      });
      return;
    }
    allCards().forEach(function(card, i) {
      const wrapper = codeWrapperInCard(card);
      if (wrapper) { initCodeArea(wrapper, i); }
    });
  }

  // ── New block card HTML ──────────────────────────────────────────────────
  // Reorder buttons get their first/last disabling from reindexCards().
  function buildNewCardHtml(blockIndex) {
    const langSelHtml = buildNewLangSelectHtml(blockIndex);
    return '<div class="block-card" data-block-index="' + blockIndex + '">' +
      '<div class="card-header">' +
        '<input type="text" id="block-' + blockIndex + '-heading" class="block-heading-input" value="" data-block="' + blockIndex + '" placeholder="' + ${BLOCK_HEADING_JS} + '">' +
        langSelHtml +
        reorderButtonsHtml('block-card', ' data-block="' + blockIndex + '"') +
        '<button class="remove-block-btn" data-block="' + blockIndex + '">\xd7</button>' +
        '<button class="expand-editor-btn" data-block="' + blockIndex + '" aria-label="' + ${EXPAND_BLOCK_JS} + '">⤢</button>' +
        '<button class="expand-btn" data-block="' + blockIndex + '" aria-label="' + ${TOGGLE_BLOCK_JS} + '">⎾</button>' +
      '</div>' +
      '<div class="card-body expanded" data-block="' + blockIndex + '">' +
        '<div class="field-row">' +
          '<label class="slabel" for="block-' + blockIndex + '-desc">' + ${DESCRIPTION_JS} + '</label>' +
          '<textarea id="block-' + blockIndex + '-desc" class="form-input form-textarea" data-block="' + blockIndex + '" rows="2" placeholder="' + ${OPTIONAL_BLOCK_DESC_JS} + '"></textarea>' +
        '</div>' +
        '<div class="block-code">' +
          '<div class="code-block-wrapper editable" contenteditable="true" spellcheck="false" data-lang="' + defLang + '"></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function buildNewLangSelectHtml(blockIndex) {
    if (langMode === 'hidden') { return ''; }
    if (langMode === 'locked') {
      return '<select id="block-' + blockIndex + '-lang" class="lang-select" data-block="' + blockIndex + '" disabled>' +
        '<option value="' + defLang + '" selected>' + defLang + '</option>' +
      '</select>';
    }
    // Clone options from first existing select
    const firstSel = document.querySelector('.lang-select');
    if (!firstSel) { return ''; }
    const clone = firstSel.cloneNode(true);
    clone.id = 'block-' + blockIndex + '-lang';
    clone.dataset.block = String(blockIndex);
    Array.from(clone.options).forEach(function(opt) { opt.selected = opt.value === defLang; });
    return clone.outerHTML;
  }

  // ── Re-index cards after splice/reorder ──────────────────────────────────
  function reindexCards() {
    allCards().forEach(function(card, i) {
      card.dataset.blockIndex = String(i);
      card.querySelectorAll('[data-block]').forEach(function(el) { el.dataset.block = String(i); });
      const heading = card.querySelector('.block-heading-input');
      if (heading) { heading.id = 'block-' + i + '-heading'; }
      const langSel = card.querySelector('.lang-select');
      if (langSel) { langSel.id = 'block-' + i + '-lang'; }
      const desc = card.querySelector('.form-textarea');
      if (desc) { desc.id = 'block-' + i + '-desc'; }
    });
    reorderRefreshAll(blocksArea);
  }

  // ── Transition: single → multi-block ────────────────────────────────────
  function activateMultiBlock() {
    if (!blocksArea) { return; }
    blocksArea.classList.add('multi-block');
  }

  function deactivateMultiBlock() {
    if (!blocksArea) { return; }
    blocksArea.classList.remove('multi-block');
  }

  // ── Tag management ───────────────────────────────────────────────────────
  // Shared with the var-set form — THE one tag implementation (shared/tagsField.ts).
  ${TAGS_FIELD_CLIENT_JS}
  ${REORDER_CLIENT_JS}

  // ── Name validation ──────────────────────────────────────────────────────
  const titleInput = document.getElementById('title');
  const nameError  = document.getElementById('name-error') || (function() {
    const el = document.createElement('div');
    el.id = 'name-error';
    el.className = 'field-error';
    el.style.display = 'none';
    if (titleInput && titleInput.parentNode) { titleInput.parentNode.insertBefore(el, titleInput.nextSibling); }
    return el;
  })();

  let validateTimer;
  if (titleInput) {
    titleInput.addEventListener('input', markDirty);
    titleInput.addEventListener('blur', function() {
      if (validateTimer) { clearTimeout(validateTimer); }
      validateTimer = setTimeout(function() {
        validateTimer = undefined;
        vscode.postMessage({ command: 'validateName', name: titleInput.value });
      }, 200);
    });
  }

  // Type-specific frontmatter inputs: extension (template), provider/model/
  // version (agent). Only the active type's inputs exist in the DOM; the rest
  // are null. One list drives both the dirty listeners and extractModel below,
  // so a new type-specific key is a single-line change here.
  const TYPE_FIELD_IDS = ['extension', 'target', 'provider', 'model', 'version'];

  TYPE_FIELD_IDS.forEach(function(id) {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', markDirty); }
  });

  /** Trimmed value of a type-specific input, or '' when absent for this type. */
  function readTypeField(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  // ── Model extraction ─────────────────────────────────────────────────────
  function extractModel() {
    const type      = blocksArea ? (blocksArea.dataset.type || 'Snippet') : 'Snippet';
    const title     = titleInput ? titleInput.value : '';
    const descEl    = document.getElementById('description');
    const desc      = descEl ? descEl.value : '';
    // Type-specific keys — '' whenever the input is absent for this type.
    const extension = readTypeField('extension');
    const target    = readTypeField('target');
    const provider  = readTypeField('provider');
    const model     = readTypeField('model');
    const version   = readTypeField('version');
    const blockEls  = allCards();
    let blocks;
    if (blockEls.length === 0) {
      // single-block (inline, no cards)
      const wrapper = document.getElementById('codeWrapper');
      const langSel = document.getElementById('block-0-lang');
      blocks = [{
        heading:     '',
        description: '',
        language:    langSel ? langSel.value : defLang,
        code:        wrapper ? extractCodeFrom(wrapper) : '',
        vars:        extractVarsForBlock(0),
      }];
    } else {
      blocks = blockEls.map(function(card, i) {
        const headingEl = card.querySelector('.block-heading-input');
        const descEl2   = card.querySelector('.form-textarea');
        const langEl    = card.querySelector('.lang-select');
        const wrapper   = codeWrapperInCard(card);
        return {
          heading:     headingEl ? headingEl.value : '',
          description: descEl2  ? descEl2.value  : '',
          language:    langEl   ? langEl.value   : defLang,
          code:        wrapper  ? extractCodeFrom(wrapper) : '',
          vars:        extractVarsForBlock(i),
        };
      });
    }
    return { artifactType: type, title: title, description: desc, extension: extension, target: target, provider: provider, model: model, version: version, tags: tags.slice(), blocks: blocks };
  }

  function extractVarsForBlock(blockIndex) {
    const rows = document.querySelectorAll('.var-row[data-block="' + blockIndex + '"]');
    const vars = [];
    rows.forEach(function(row) {
      const name  = row.dataset.var || '';
      const input = row.querySelector('.var-input');
      vars.push({ name: name, defaultValue: input ? input.value : '' });
    });
    return vars;
  }

  // ── §3.7 Client-side validation ──────────────────────────────────────────
  function validateForSave(model) {
    const errors = [];
    if (!model.title.trim()) { errors.push({ field: 'title', msg: ${TITLE_REQUIRED_JS} }); }
    const hasCode = model.blocks.some(function(b) { return b.code.trim().length > 0; });
    if (!hasCode) { errors.push({ field: 'blocks', msg: ${NEEDS_CODE_JS} }); }
    if (model.blocks.length > 1) {
      const allHeadings = model.blocks.every(function(b) { return b.heading.trim().length > 0; });
      if (!allHeadings) { errors.push({ field: 'headings', msg: ${NEEDS_HEADINGS_JS} }); }
    }
    return errors;
  }

  function showValidationErrors(errors) {
    const saveError = document.getElementById('save-error') || (function() {
      const el = document.createElement('div');
      el.id = 'save-error';
      el.className = 'field-error';
      const footer = document.querySelector('.form-footer');
      if (footer) { footer.insertBefore(el, footer.firstChild); }
      return el;
    })();
    if (errors.length === 0) { saveError.style.display = 'none'; saveError.textContent = ''; return; }
    saveError.style.display = '';
    saveError.textContent = errors.map(function(e) { return e.msg; }).join(' ');
    if (nameError && errors.some(function(e) { return e.field === 'title'; })) {
      nameError.style.display = '';
      nameError.textContent = ${TITLE_REQUIRED_JS};
    }
  }

  // ── Message dispatcher ───────────────────────────────────────────────────
  window.addEventListener('message', function(event) {
    const msg = event.data;
    switch (msg.command) {
      case 'nameValidation': {
        if (!nameError) { break; }
        if (msg.ok) { nameError.style.display = 'none'; nameError.textContent = ''; }
        else { nameError.style.display = ''; nameError.textContent = msg.reason || ${INVALID_NAME_JS}; }
        break;
      }
      case 'varsDetected': {
        mergeVarsDetected(msg.blockIndex, msg.vars || []);
        break;
      }
      case 'saveResult': {
        savePending = false;
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) { saveBtn.removeAttribute('disabled'); }
        if (!msg.ok && msg.error) {
          showValidationErrors([{ field: 'save', msg: msg.error }]);
        }
        break;
      }
      case 'removeBlockConfirmed': {
        if (!msg.confirmed) { break; }
        const card = cardAt(msg.blockIndex);
        if (card) { card.remove(); }
        if (allCards().length === 1) { deactivateMultiBlock(); }
        reindexCards();
        break;
      }
      case 'deleteEntireConfirmed': {
        if (msg.confirmed) { vscode.postMessage({ command: 'cancel', dirty: false }); }
        break;
      }
      case 'cancelConfirmed': {
        if (msg.confirmed) { vscode.postMessage({ command: 'cancel', dirty: false }); }
        break;
      }
      case 'blockUpdated': {
        setCodeForBlock(msg.index, msg.code);
        markDirty();
        break;
      }
    }
  });

  function mergeVarsDetected(blockIndex, detectedVars) {
    // Preserve existing typed defaults; add new detected names; orphans kept.
    const existing = {};
    document.querySelectorAll('.var-row[data-block="' + blockIndex + '"]').forEach(function(row) {
      const input = row.querySelector('.var-input');
      existing[row.dataset.var || ''] = input ? input.value : '';
    });
    const merged = detectedVars.map(function(v) {
      return { name: v.name, defaultValue: existing[v.name] !== undefined ? existing[v.name] : '' };
    });
    // Keep orphans with non-empty defaults
    Object.keys(existing).forEach(function(name) {
      const inCode = detectedVars.some(function(v) { return v.name === name; });
      if (!inCode && existing[name]) { merged.push({ name: name, defaultValue: existing[name] }); }
    });
    renderVarsSection(blockIndex, merged);
  }

  function renderVarsSection(blockIndex, vars) {
    const container = blockIndex === 0 && !document.querySelector('.block-card')
      ? document.querySelector('.block')
      : cardAt(blockIndex);
    if (!container) { return; }
    let varsSec = container.querySelector('.vars-section');
    if (!varsSec) {
      varsSec = document.createElement('div');
      varsSec.className = 'vars-section';
      const codeDiv = container.querySelector('.block-code');
      if (codeDiv && codeDiv.parentNode) { codeDiv.parentNode.insertBefore(varsSec, codeDiv.nextSibling); }
      else { container.appendChild(varsSec); }
    }
    if (vars.length === 0) { varsSec.style.display = 'none'; return; }
    varsSec.style.display = '';
    const rows = vars.map(function(v) {
      // esc() is mandatory here: v.name/v.defaultValue come from vault-file
      // content re-parsed after a save round-trip (fileUpdated), so they are
      // untrusted input crossing the webview boundary — an unescaped quote
      // would break out of the data-var/value attributes.
      const safeName = esc(v.name);
      return '<tr class="var-row" data-var="' + safeName + '" data-block="' + blockIndex + '">' +
        '<td class="var-name">' + esc(lbl(v.name)) + '</td>' +
        '<td class="var-default">' +
          '<input type="text" class="var-input" data-var="' + safeName + '" data-block="' + blockIndex + '" value="' + esc(v.defaultValue) + '" placeholder="' + ${DEFAULT_VALUE_JS} + '">' +
        '</td></tr>';
    }).join('');
    varsSec.innerHTML = '<div class="slabel">' + ${VARIABLES_LABEL_JS} + '</div><table class="vars-table"><tbody>' + rows + '</tbody></table>';
  }

  // ── Button wiring ────────────────────────────────────────────────────────
  function wireButtons() {
    // Save
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function() {
        if (savePending) { return; }
        const model  = extractModel();
        const errors = validateForSave(model);
        if (errors.length > 0) { showValidationErrors(errors); return; }
        showValidationErrors([]);
        savePending = true;
        saveBtn.setAttribute('disabled', '');
        vscode.postMessage({ command: 'save', model: model });
      });
    }

    // Cancel
    const cancelBtn = document.getElementById('cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() {
        vscode.postMessage({ command: 'cancel', dirty: dirty });
      });
    }

    // Delete entire
    const deleteBtn = document.getElementById('delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function() {
        vscode.postMessage({ command: 'deleteEntire' });
      });
    }

    // Add block
    const addBtn = document.getElementById('add-block-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function() {
        const cards = allCards();
        const newIndex = cards.length;
        if (newIndex === 1) { activateMultiBlock(); }
        const newHtml  = buildNewCardHtml(newIndex);
        const tmp      = document.createElement('div');
        tmp.innerHTML  = newHtml;
        const newCard  = tmp.firstElementChild;
        if (blocksArea && newCard) {
          blocksArea.appendChild(newCard);
          reindexCards();
          const wrapper = codeWrapperInCard(newCard);
          if (wrapper) { initCodeArea(wrapper, newIndex); }
          const headingInput = newCard.querySelector('.block-heading-input');
          if (headingInput) { headingInput.focus(); }
          markDirty();
          vscode.postMessage({ command: 'addBlock' });
        }
      });
    }

    // Reorder: the shared control moves the card; re-index so every
    // data-block (remove, expand, lang) follows its card.
    reorderWire(blocksArea, function () { reindexCards(); markDirty(); });

    // Remove block (delegated on blocksArea)
    if (blocksArea) {
      blocksArea.addEventListener('click', function(ev) {
        const target = ev.target;
        if (!target) { return; }
        if (target.classList.contains('remove-block-btn')) {
          const blockIndex = parseInt(target.dataset.block || '0', 10);
          vscode.postMessage({ command: 'removeBlock', blockIndex: blockIndex });
        }
        if (target.classList.contains('expand-btn')) {
          const blockIndex = parseInt(target.dataset.block || '0', 10);
          const card = cardAt(blockIndex);
          if (card) {
            const body = card.querySelector('.card-body');
            if (body) { body.classList.toggle('expanded'); }
          }
        }
        if (target.classList.contains('expand-editor-btn')) {
          const blockIndex = parseInt(target.dataset.block || '0', 10);
          vscode.postMessage({ command: 'expandBlock', index: blockIndex });
        }
      });
    }

    // Wire any input change → dirty
    document.querySelectorAll('.form-input, .form-textarea, .lang-select, .block-heading-input').forEach(function(el) {
      el.addEventListener('input', markDirty);
      el.addEventListener('change', markDirty);
    });
  }

  // ── Initialise ───────────────────────────────────────────────────────────
  // Read initial tags from existing chips in the DOM
  document.querySelectorAll('.tag-chip').forEach(function(chip) {
    const btn = chip.querySelector('.tag-remove');
    if (btn && btn.dataset.tag) { tags.push(btn.dataset.tag); }
  });
  wireTagInput();
  wireButtons();
  initAllCodeAreas();
`;
