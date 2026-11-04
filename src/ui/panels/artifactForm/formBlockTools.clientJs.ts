/**
 * Per-block tools of the artifact form webview: the code/language round trip
 * of "expand block in editor", and the confirmed Clear.
 *
 * A string constant, not a module: webview client JS cannot import. It is
 * interpolated inside the `FORM_CLIENT_JS` IIFE (like `REORDER_CLIENT_JS`) and
 * shares its `blocksArea`, `langMode`, `cardAt`, `allCards`, `extractModel`,
 * `renderRows`, `renderVarsSection` and `markDirty`. It holds no localised
 * strings and must not carry `WEBVIEW_ESC_LBL_JS` or `REORDER_CLIENT_JS` again.
 *
 * @example
 * export const FORM_CLIENT_JS = `... ${FORM_BLOCK_TOOLS_JS} ...`;
 */
export const FORM_BLOCK_TOOLS_JS = `
  // ── Block tools: code area, language, Clear ──────────────────────────────

  // Replaces one block's code area (blockUpdated / Clear). window.__codeBlock.setCode
  // always targets the *first* '#codeWrapper' (server-rendered cards all carry
  // that id), so it is only safe in single-block mode; a card's wrapper is
  // found by class/index. Both end in renderRows — no second render/escape.
  function setCodeForBlock(blockIndex, code) {
    if (allCards().length === 0) {
      window.__codeBlock.setCode(code);
      return;
    }
    const wrapper = codeWrapperInCard(cardAt(blockIndex));
    if (wrapper) { wrapper.innerHTML = renderRows(code || ''); }
  }

  // Free mode only: select the language, adding it as an option when the list
  // lacks it. createElement + textContent: a language is text, never markup.
  function setLangForBlock(blockIndex, lang) {
    if (langMode !== 'free') { return; }
    const card = cardAt(blockIndex);
    const sel = card ? card.querySelector('.lang-select') : document.getElementById('block-0-lang');
    if (!sel) { return; }
    if (!Array.from(sel.children).some(function(o) { return o.value === lang; })) {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = lang;
      sel.appendChild(opt);
    }
    sel.value = lang;
  }

  /** The scratch tab saved: new code, and the language only if the user changed it there. */
  function onBlockUpdated(msg) {
    setCodeForBlock(msg.index, msg.code);
    if (typeof msg.language === 'string') { setLangForBlock(msg.index, msg.language); }
    markDirty();
    // An innerHTML set fires no 'input', so detection is asked for here.
    vscode.postMessage({ command: 'detectVars', blockIndex: msg.index, code: msg.code });
  }

  /** Clear clicked: an empty block has nothing to lose, so no confirm round trip. */
  function requestClear(i) {
    const b = extractModel().blocks[i];
    if (b && b.code) { vscode.postMessage({ command: 'clearBlock', index: i }); }
  }

  /** Host confirmed. No detectVars: re-detection would keep the typed defaults as orphans. */
  function onClearConfirmed(msg) {
    if (!msg.confirmed) { return; }
    setCodeForBlock(msg.index, '');
    renderVarsSection(msg.index, []);
    markDirty();
  }

  /**
   * First "add block" on a single inline block: the inline block becomes card 0,
   * so extractModel() (which reads cards once any exist) keeps its code, language
   * and variables. The live '.block-code' node and the vars section are moved,
   * not rebuilt, so the code area keeps its listeners and typed text.
   */
  function convertInlineToCard() {
    const inline = blocksArea ? blocksArea.querySelector('.block') : null;
    if (!inline) { return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = buildNewCardHtml(0);
    const card = tmp.firstElementChild;
    const inlineSel = inline.querySelector('.lang-select');
    const cardSel = card.querySelector('.lang-select');
    if (inlineSel && cardSel) { cardSel.value = inlineSel.value; }
    const freshCode = card.querySelector('.block-code');
    freshCode.parentElement.insertBefore(inline.querySelector('.block-code'), freshCode);
    freshCode.remove();
    const vars = inline.querySelector('.vars-section');
    if (vars) { card.querySelector('.card-body').appendChild(vars); }
    blocksArea.insertBefore(card, inline);
    inline.remove();
    activateMultiBlock();
    reindexCards();
  }
`;
