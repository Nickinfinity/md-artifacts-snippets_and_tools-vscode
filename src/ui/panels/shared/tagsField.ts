import * as vscode from 'vscode';
import { escHtml } from '../../../utils/html.js';
import { jsStr } from '../artifactPicker/webviewSnippets.js';

/**
 * THE editable tags field — markup and client behaviour, for every form that
 * has one.
 *
 * Both the artifact form and the var-set form render title/description/tags.
 * They diverged: the artifact form shipped chips **plus** an input with
 * add/remove wiring, while the var-set form rendered chips only and posted the
 * tag array **baked in at render time**, so its tags round-tripped as a
 * constant and could never be edited. That is the `CLAUDE.md` duplication
 * failure exactly — "'duplicate' is a claim about behaviour, not shape", and
 * here the behaviour was not the same.
 *
 * Webview client scripts cannot `import`, so the behaviour half ships as one
 * exported **string** consumed by each host template — the same pattern
 * `WEBVIEW_ESC_LBL_JS` uses, never a copy-paste.
 */

/**
 * Renders the tag chips for the initial server-side paint.
 *
 * Each chip carries its own remove button; `data-tag` holds the **escaped**
 * text because the client script reads it back out of the attribute.
 *
 * @param tags - Tag strings from frontmatter (untrusted vault content).
 * @returns Chip markup, or `''` when there are no tags.
 *
 * @example
 * buildTagChips(['api', 'dev']) // → '<span class="tag-chip">api<button …'
 */
export function buildTagChips(tags: string[]): string {
    if (tags.length === 0) { return ''; }
    return tags.map(tag => {
        const safe = escHtml(tag);
        const removeLabel = escHtml(vscode.l10n.t('Remove {0}', tag));
        return `    <span class="tag-chip">${safe}<button class="tag-remove" data-tag="${safe}" aria-label="${removeLabel}">×</button></span>\n`;
    }).join('');
}

/**
 * Builds the whole tags form-section: label, chips, and the add-tag input.
 *
 * @param tags        - Current tags.
 * @param labelClass  - Class for the label element — the two forms style their
 *                      labels differently (`slabel` vs a bare `<label>`), and that
 *                      is presentation, not behaviour, so it stays a parameter.
 * @returns The `<div class="form-section">…</div>` markup.
 *
 * @example
 * buildTagsField(['api'], 'slabel')
 */
export function buildTagsField(tags: string[], labelClass = ''): string {
    const chips = buildTagChips(tags);
    const labelAttr = labelClass !== '' ? ` class="${labelClass}"` : '';
    return `<div class="form-section">
  <div${labelAttr}>${escHtml(vscode.l10n.t('Tags'))}</div>
  <div class="tags-row" id="tags-row">
${chips}    <input type="text" id="tag-input" class="tag-input" placeholder="${escHtml(vscode.l10n.t('Add tag…'))}">
  </div>
</div>`;
}

/**
 * THE client-side tag behaviour — `renderTags()` / `wireTagInput()` over a
 * module-scoped `tags` array the host script must declare.
 *
 * Contract for the consuming script, all three required:
 *  - declare `let tags = [...]` before interpolating this;
 *  - provide `esc()` (from `WEBVIEW_ESC_LBL_JS`) for attribute escaping;
 *  - provide `markDirty()` — a no-op is fine for forms with no dirty tracking.
 *
 * Calling `renderTags()` once on load both paints the chips and wires the input.
 *
 * @example
 * `let tags = ${tagsJs}; function markDirty(){} ${TAGS_FIELD_CLIENT_JS} renderTags();`
 */
export const TAGS_FIELD_CLIENT_JS = `
  function renderTags() {
    const row = document.getElementById('tags-row');
    if (!row) { return; }
    const input = document.getElementById('tag-input');
    const chips = tags.map(function(t) {
      const safeTag = esc(t); // untrusted tag text — escape before it hits an attribute
      return '<span class="tag-chip">' + safeTag +
        '<button class="tag-remove" data-tag="' + safeTag + '" aria-label="' + ${jsStr(escHtml(vscode.l10n.t('Remove {0}', '{0}')))}.replace('{0}', safeTag) + '">\\xd7</button>' +
        '</span>';
    }).join('');
    row.innerHTML = chips + (input ? input.outerHTML : '<input type="text" id="tag-input" class="tag-input" placeholder="' + ${jsStr(escHtml(vscode.l10n.t('Add tag…')))} + '">');
    wireTagInput();
  }

  function wireTagInput() {
    const input = document.getElementById('tag-input');
    if (!input) { return; }
    input.addEventListener('keydown', function(ev) {
      if (ev.key === ',' || ev.key === ']' || ev.key === 'Enter') {
        ev.preventDefault();
        const val = input.value.trim();
        if (val && !tags.includes(val)) { tags.push(val); markDirty(); renderTags(); }
        else { input.value = ''; }
      }
    });
    document.querySelectorAll('.tag-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const tag = btn.dataset.tag;
        tags = tags.filter(function(t) { return t !== tag; });
        markDirty();
        renderTags();
      });
    });
  }
`;
