import * as vscode from 'vscode';
import { escHtml, styleLinkTags } from '../../../utils/html.js';
import type { InfoField, InfoModel, InfoSection } from '../../../types/info.types.js';

/**
 * Renders one `label: value` line.
 *
 * @param f - The field.
 * @returns A `<div class="info-field">` row, escaped.
 *
 * @example
 * renderField({ label: 'Value', value: 'localhost', mono: true });
 */
function renderField(f: InfoField): string {
    const cls = f.mono ? 'info-value mono' : 'info-value';
    return `<div class="info-field"><span class="info-label">${escHtml(f.label)}</span><span class="${cls}">${escHtml(f.value)}</span></div>`;
}

/**
 * Renders one titled section (a sub-set, a variable list…).
 *
 * @param s - The section.
 * @returns A `<section class="info-section">`, escaped.
 *
 * @example
 * renderSection({ heading: 'Users', fields: [] , emptyText: 'No variables yet.' });
 */
function renderSection(s: InfoSection): string {
    const desc = s.description ? `<p class="info-desc">${escHtml(s.description)}</p>` : '';
    const body = s.fields.length > 0
        ? s.fields.map(renderField).join('')
        : `<p class="info-empty">${escHtml(s.emptyText ?? '')}</p>`;
    return `<section class="info-section"><h2>${escHtml(s.heading)}</h2>${desc}${body}</section>`;
}

/**
 * Renders the View Info popup for any artifact — see `InfoModel`.
 *
 * Static by design: the CSP allows **no script** at all (nothing here is
 * interactive), and every model value goes through `escHtml`, since it comes
 * from vault files. The small stylesheet is inline under a nonce rather than a
 * new `src/ui/*.css` file, so the packaged asset set is unchanged.
 *
 * @param model     - What to show.
 * @param cssUris   - Webview URIs for the shared sheets (`base.css`).
 * @param cspSource - The webview's CSP source token.
 * @param nonce     - Nonce for the inline `<style>`.
 * @returns A complete HTML document.
 *
 * @example
 * renderInfoHtml(model, [baseCssUri], webview.cspSource, getNonce());
 */
export function renderInfoHtml(model: InfoModel, cssUris: string | string[], cspSource: string, nonce: string): string {
    const safeNonce = escHtml(nonce);
    const tags = model.tags.length > 0
        ? `<div class="info-tags">${model.tags.map(t => `<span class="info-tag">#${escHtml(t)}</span>`).join('')}</div>`
        : '';
    const desc = model.description ? `<p class="info-desc">${escHtml(model.description)}</p>` : '';
    const path = model.path
        ? `<p class="info-path">${escHtml(vscode.l10n.t('File'))}: <span class="mono">${escHtml(model.path)}</span></p>`
        : '';
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${safeNonce}';">
${styleLinkTags(cssUris)}
<style nonce="${safeNonce}">
  body { padding: 14px 18px; }
  .info-kind { text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin: 0; }
  h1 { margin: 2px 0 6px; }
  h2 { font-size: 1rem; margin: 18px 0 4px; }
  .info-desc { margin: 4px 0 8px; color: var(--vscode-foreground); white-space: pre-wrap; }
  .info-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 10px; }
  .info-tag { padding: 1px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.8rem; }
  .info-field { display: flex; gap: 10px; padding: 3px 0; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  .info-label { min-width: 110px; color: var(--vscode-descriptionForeground); }
  .info-value { word-break: break-all; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .info-empty, .info-path { color: var(--vscode-descriptionForeground); }
  .info-path { margin-top: 18px; font-size: 0.85rem; }
</style>
</head>
<body>
  <p class="info-kind">${escHtml(model.kind)}</p>
  <h1>${escHtml(model.title)}</h1>
  ${desc}
  ${tags}
  ${model.fields.map(renderField).join('')}
  ${model.sections.map(renderSection).join('')}
  ${path}
</body>
</html>`;
}
