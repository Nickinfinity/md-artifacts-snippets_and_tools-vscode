import * as vscode from 'vscode';
import { escHtml } from '../../../utils/html.js';
import { buildReorderButtons } from '../shared/reorderControls.js';
import { labelForVar } from '../artifactPicker/preview.helpers.js';
import { buildCodeBlockHtml } from '../artifactPicker/codeBlock.js';
import { renderCodeRowsHtml } from '../../../services/render.service.js';
import { FREE_LANGUAGE_OPTIONS } from './form.helpers.js';
import type { ArtifactFormBlock, ArtifactFormModel } from '../../../types/artifact-form.types.js';
import type { ParsedVar } from '../../../types/parsed-artifact.types.js';
import type { LanguageMode } from '../../../types/artifact.types.js';

// ── Language selector ─────────────────────────────────────────────────────────

/**
 * Builds a language `<select>` element for a block.
 *
 * - `free`: enabled dropdown with `FREE_LANGUAGE_OPTIONS`; current value pre-selected.
 * - `locked`: disabled single-option select showing the locked language.
 * - `hidden`: returns empty string (selector not rendered).
 *
 * @param blockIndex   - Zero-based block index (for element ids).
 * @param currentLang  - Currently selected language value.
 * @param mode         - Language selector mode from artifact type config.
 * @param lockedLang   - Language to show when `mode === 'locked'`.
 * @returns HTML string for the selector field row, or `''` when hidden.
 *
 * @example
 * buildLanguageSelector(0, 'javascript', 'free', '')
 */
export function buildLanguageSelector(
    blockIndex:  number,
    currentLang: string,
    mode:        LanguageMode,
    lockedLang:  string,
): string {
    if (mode === 'hidden') { return ''; }

    const id       = `block-${blockIndex}-lang`;
    const dataAttr = `data-block="${blockIndex}"`;

    const languageLabel = vscode.l10n.t('Language');

    if (mode === 'locked') {
        const safe = escHtml(lockedLang);
        return `<div class="field-row lang-row">
  <label class="slabel" for="${id}">${languageLabel}</label>
  <select id="${id}" class="lang-select" ${dataAttr} disabled>
    <option value="${safe}" selected>${safe}</option>
  </select>
</div>`;
    }

    // free mode — full dropdown
    // A language outside the list (a captured `scss`) is one extra selected option, never silently Plain text.
    const known   = FREE_LANGUAGE_OPTIONS.includes(currentLang);
    const options = [...FREE_LANGUAGE_OPTIONS, ...(known ? [] : [currentLang])].map(val => {
        const label  = val === '' ? vscode.l10n.t('Plain text') : val;
        const safeV  = escHtml(val);
        const safeL  = escHtml(label);
        const selStr = val === currentLang ? ' selected' : '';
        return `    <option value="${safeV}"${selStr}>${safeL}</option>`;
    }).join('\n');

    return `<div class="field-row lang-row">
  <label class="slabel" for="${id}">${languageLabel}</label>
  <select id="${id}" class="lang-select" ${dataAttr}>
${options}
  </select>
</div>`;
}

// ── Vars table ────────────────────────────────────────────────────────────────

/**
 * Builds the variables table for a block.
 *
 * Renders one input row per detected `<VK-xxx>` variable. Returns empty string
 * when the block has no vars.
 *
 * @param vars       - Variable list from `block.vars`.
 * @param blockIndex - Zero-based block index (for element ids/data attrs).
 * @returns HTML string for the vars section, or `''` when empty.
 *
 * @example
 * buildVarsTable([{ name: 'VK-host', defaultValue: 'localhost' }], 0)
 */
export function buildVarsTable(vars: ParsedVar[], blockIndex: number): string {
    if (vars.length === 0) { return ''; }
    const rows = vars.map(v => {
        const safeName  = escHtml(v.name);
        const safeVal   = escHtml(v.defaultValue);
        const safeLabel = escHtml(labelForVar(v.name));
        return `      <tr class="var-row" data-var="${safeName}" data-block="${blockIndex}">
        <td class="var-name">${safeLabel}</td>
        <td class="var-default">
          <input type="text" class="var-input" data-var="${safeName}" data-block="${blockIndex}" value="${safeVal}" placeholder="${escHtml(vscode.l10n.t('Default value'))}">
        </td>
      </tr>`;
    }).join('\n');
    return `<div class="vars-section">
  <div class="slabel">${escHtml(vscode.l10n.t('Variables'))}</div>
  <table class="vars-table"><tbody>
${rows}
  </tbody></table>
</div>`;
}

// ── Code area for form blocks ─────────────────────────────────────────────────

/**
 * Builds the editable code area for one form block, without the preview toolbar.
 *
 * The form already puts an `expand-editor-btn` on every block (single-block
 * corner, card header), so the toolbar's own expand button would be a second
 * one per block. The preview keeps the toolbar; the form does not.
 *
 * @param code - Block code to render.
 * @param lang - Highlight language for the block.
 * @returns Code-area HTML with no toolbar.
 *
 * @example
 * formCodeBlockHtml('const a = 1;', 'javascript')
 */
export const formCodeBlockHtml = (code: string, lang: string): string =>
    buildCodeBlockHtml(renderCodeRowsHtml(code, lang), lang, { toolbar: false });

// ── Single block (inline, no card chrome) ─────────────────────────────────────

/**
 * Builds the inline block content for a single-block form.
 *
 * No card chrome, no heading/description inputs (hidden in single-block mode).
 *
 * There is no `.card-header` here to hang the expand-to-editor button on (a
 * single-block form also has no language selector for `mode === 'hidden'`
 * types, e.g. `AIAgentsConfig`), so Expand and Clear sit in a
 * `.block-code-tools` row just above `.block-code` (`form.css`): over the code
 * area they hid the text behind them.
 *
 * @param block        - The sole block from the model.
 * @param blockIndex   - Always `0` for single-block.
 * @param mode         - Language selector mode.
 * @param lockedLang   - Locked language string (used when `mode === 'locked'`).
 * @param codeBlockHtml - Editable code-block HTML builder.
 * @returns HTML string for the block content.
 *
 * @example
 * buildSingleBlockContent(model.blocks[0], 0, 'free', '', codeBlockHtml)
 */
export function buildSingleBlockContent(
    block:        ArtifactFormBlock,
    blockIndex:   number,
    mode:         LanguageMode,
    lockedLang:   string,
    codeBlockHtml:(code: string, lang: string) => string,
): string {
    const langSelector = buildLanguageSelector(blockIndex, block.language, mode, lockedLang);
    const resolvedLang = mode === 'locked' ? lockedLang : block.language;
    const codeHtml     = codeBlockHtml(block.code, resolvedLang);
    const varsHtml     = buildVarsTable(block.vars, blockIndex);
    return `<div class="block" data-block-index="${blockIndex}">
${langSelector}
<div class="block-code-tools">
<button class="expand-editor-btn" data-block="${blockIndex}" aria-label="${escHtml(vscode.l10n.t('Expand block in editor'))}">⤢</button>
<button class="clear-block-btn" data-block="${blockIndex}" aria-label="${escHtml(vscode.l10n.t('Clear code in this block'))}">✕</button>
</div>
<div class="block-code">
${codeHtml}
</div>
${varsHtml}
</div>`;
}

// ── Multi-block area (accordion cards) ────────────────────────────────────────

/**
 * Builds the full multi-block area as accordion cards.
 *
 * @param model         - Form model with `blocks.length > 1`.
 * @param mode          - Language mode for the type.
 * @param lockedLang    - Locked language (used when `mode === 'locked'`).
 * @param codeBlockHtml - Editable code-block HTML builder.
 * @returns HTML string for all block cards.
 *
 * @example
 * buildMultiBlockArea(model, 'free', '', codeBlockHtml)
 */
export function buildMultiBlockArea(
    model:        ArtifactFormModel,
    mode:         LanguageMode,
    lockedLang:   string,
    codeBlockHtml:(code: string, lang: string) => string,
): string {
    const total = model.blocks.length;
    return model.blocks.map((block, idx) =>
        buildBlockCard(block, idx, total, mode, lockedLang, codeBlockHtml)
    ).join('\n');
}

/**
 * Builds one accordion card for a block in multi-block mode.
 *
 * Card header: heading input, language selector, reorder buttons, remove
 * button, expand-to-editor button, collapse chevron. Card body: description,
 * code area, vars. Reorder `↑` disabled on block 0; `↓` disabled on the last
 * block.
 *
 * The expand-to-editor button (`expand-editor-btn`) is a **different button
 * and class** from the collapse chevron (`expand-btn`) — the delegated click
 * handler in `form.clientJs.ts` matches `expand-btn` by exact token, so
 * giving one button both classes would fire both behaviours on a single
 * click. Exported (was private) so `test/form-expand-button.test.ts` can
 * assert the button renders without going through the full `buildFormHtml`
 * pipeline.
 *
 * @param block         - Block data.
 * @param blockIndex    - Zero-based index within model.blocks.
 * @param total         - Total number of blocks (for boundary detection).
 * @param mode          - Language mode.
 * @param lockedLang    - Locked language string.
 * @param codeBlockHtml - Editable code-block HTML builder.
 * @returns HTML string for the block card.
 *
 * @example
 * buildBlockCard(block, 0, 2, 'free', '', codeBlockHtml)
 */
export function buildBlockCard(
    block:        ArtifactFormBlock,
    blockIndex:   number,
    total:        number,
    mode:         LanguageMode,
    lockedLang:   string,
    codeBlockHtml:(code: string, lang: string) => string,
): string {
    const isFirst      = blockIndex === 0;
    const headingVal   = escHtml(block.heading);
    const descVal      = escHtml(block.description);
    const langSelector = buildLanguageSelector(blockIndex, block.language, mode, lockedLang);
    const resolvedLang = mode === 'locked' ? lockedLang : block.language;
    const codeHtml     = codeBlockHtml(block.code, resolvedLang);
    const varsHtml     = buildVarsTable(block.vars, blockIndex);
    const bodyClass    = isFirst ? 'card-body expanded' : 'card-body';

    return `<div class="block-card" data-block-index="${blockIndex}">
  <div class="card-header">
    <input type="text" id="block-${blockIndex}-heading" class="block-heading-input" value="${headingVal}" data-block="${blockIndex}" placeholder="${escHtml(vscode.l10n.t('Block heading'))}">
    ${langSelector}
    ${buildReorderButtons('block-card', blockIndex, total, ' data-block="' + blockIndex + '"')}
    <button class="remove-block-btn" data-block="${blockIndex}">×</button>
    <button class="expand-editor-btn" data-block="${blockIndex}" aria-label="${escHtml(vscode.l10n.t('Expand block in editor'))}">⤢</button>
    <button class="expand-btn" data-block="${blockIndex}" aria-label="${escHtml(vscode.l10n.t('Toggle block'))}">⌄</button>
  </div>
  <div class="${bodyClass}" data-block="${blockIndex}">
    <div class="field-row">
      <label class="slabel" for="block-${blockIndex}-desc">${escHtml(vscode.l10n.t('Description'))}</label>
      <textarea id="block-${blockIndex}-desc" class="form-input form-textarea" data-block="${blockIndex}" rows="2" placeholder="${escHtml(vscode.l10n.t('Optional block description'))}">${descVal}</textarea>
    </div>
    <div class="block-code-tools">
    <button class="clear-block-btn" data-block="${blockIndex}" aria-label="${escHtml(vscode.l10n.t('Clear code in this block'))}">✕</button>
    </div>
    <div class="block-code">
${codeHtml}
    </div>
${varsHtml}
  </div>
</div>`;
}
