import * as vscode from 'vscode';
import { getCreateFormTypes, getBrowseTypes, getEntry } from '../../services/artifact-type-config.service.js';
import { escHtml, styleLinkTags } from '../../utils/html.js';
// THE create-id scheme — same authority insert.command.ts's artifactCommandId is
// for insert. Constructing the id inline here would be a second spelling.
import { createCommandId } from '../../commands/create-from-surface.command.js';
// THE insert-id scheme, for the same reason.
import { artifactCommandId } from '../../commands/insert.command.js';
import type { ArtifactType } from '../../types/parsed-artifact.types.js';

/** Command id the pane's Settings row runs — registered by `openSettings.command.ts`. */
export const SETTINGS_COMMAND_ID = 'md-artifacts.settings';

/**
 * One row in the main pane's idle-mode create list.
 */
export interface CreateItem {
    /** Canonical artifact type this row creates. */
    type: ArtifactType;
    /** Row label — bare `getEntry(type).name`, no verb prefix (D-9): the New/Open
     * toggle carries the verb, so New and Open render the same five labels. */
    label: string;
}

// ── Data ─────────────────────────────────────────────────────────────────────

/**
 * Builds the idle-mode "create" row data, one row per create-form-enabled
 * artifact type.
 *
 * Order and membership come from `getCreateFormTypes()` (`ARTIFACTS`
 * declaration order) — the main pane never hardcodes a type list, so a new
 * create-form type in `ARTIFACTS` surfaces here automatically.
 *
 * @returns One `CreateItem` per create-form-enabled type, in `ARTIFACTS` order.
 *
 * @example
 * buildCreateItems()[0] // → { type: 'Snippet', label: 'Snippets' }
 */
export function buildCreateItems(): CreateItem[] {
    return getCreateFormTypes().map(type => ({ type, label: getEntry(type).name }));
}

/**
 * Resolves the base create command id for a `createType` webview message,
 * or `undefined` when `type` is not a create-form type.
 *
 * `type` crosses the webview boundary untrusted: `getEntry` alone would
 * accept any of the six `ArtifactType` literals (including `Variables`,
 * which has no create form), resolving to an `md-artifacts.create.*`
 * id that is never registered. Gating on membership in the same
 * `getCreateFormTypes()` list the rows are built from keeps the two in
 * lockstep — a type can never be clickable here without also being a valid
 * target.
 *
 * @param type - Raw `type` value from a `{ command: 'createType', type }` message.
 * @returns `md-artifacts.create.<dir>` for a create-form type, else `undefined`.
 *
 * @example
 * resolveCreateCommandId('Snippet')   // → 'md-artifacts.create.snippets'
 * resolveCreateCommandId('Variables') // → undefined — not a create-form type
 */
export function resolveCreateCommandId(type: string): string | undefined {
    const createType = getCreateFormTypes().find(t => t === type);
    if (!createType) {
        return undefined;
    }
    return createCommandId(getEntry(createType).dir);
}

/**
 * Builds the idle-mode "browse" row data — one row per browsable artifact type.
 *
 * Reads `getBrowseTypes()` (H3.0) rather than `getAllTypes()`: `Variables`
 * opens straight into edit mode (D-11), so it is excluded from Open the same
 * way it is excluded from New. Membership still comes from `ARTIFACTS`, so a
 * new browsable type appears here with no edit.
 *
 * @returns One `CreateItem` per browsable type, in `ARTIFACTS` order.
 *
 * @example
 * buildBrowseItems()[0] // → { type: 'Snippet', label: 'Snippets' }
 */
export function buildBrowseItems(): CreateItem[] {
    return getBrowseTypes().map(type => ({ type, label: getEntry(type).name }));
}

/**
 * Resolves the insert/browse command id for a `browseType` webview message.
 *
 * Gated against `getBrowseTypes()` for the same reason `resolveCreateCommandId`
 * gates against `getCreateFormTypes()`: `type` crosses the webview boundary
 * untrusted, and an ungated value would build an `md-artifacts.insert.*`
 * id that was never registered — and `Variables` (D-11) must never resolve
 * here, since Open never renders it.
 *
 * @param type - Raw `type` value from a `{ command: 'browseType', type }` message.
 * @returns `md-artifacts.insert.<dir>` for a browsable type, else `undefined`.
 *
 * @example
 * resolveBrowseCommandId('Snippet')    // → 'md-artifacts.insert.snippets'
 * resolveBrowseCommandId('Variables')  // → undefined — not a browse type (D-11)
 * resolveBrowseCommandId('Nonsense')   // → undefined
 */
export function resolveBrowseCommandId(type: string): string | undefined {
    const known = getBrowseTypes().find(t => t === type);
    if (!known) {
        return undefined;
    }
    return artifactCommandId(getEntry(known).dir);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

/**
 * Renders the idle-mode webview HTML — a filterable list of rows behind a
 * New/Open toggle, plus a pinned Settings row.
 *
 * Every interpolated value is escaped via `escHtml`. New and Open render the
 * same five labels (D-9 drops the `Create ` prefix so the toggle alone
 * carries the verb); `IDLE_CLIENT_JS` hides whichever list the current mode
 * and filter text do not match, and both lists ship the inactive one already
 * `hidden` server-side so nothing double-renders before the script runs.
 *
 * Every row uses the same vendored codicon glyph per section
 * (`Artifact.icon` is unpopulated by every `ARTIFACTS` entry today, so a
 * per-type icon branch would be five identical fallbacks dressed up as a
 * feature that does not exist).
 *
 * @param items     - New-mode rows, from `buildCreateItems()`.
 * @param cssUris   - Webview URIs for the stylesheets — `base.css` first.
 * @param cspSource - Webview CSP source token (`webview.cspSource`).
 * @param nonce     - CSP nonce shared by the `<style>` and `<script>` tags.
 * @param browseItems - Open-mode rows, from `buildBrowseItems()`.
 * @returns Complete HTML document string for `webview.html`.
 *
 * @example
 * renderIdleHtml(buildCreateItems(), [baseCssUri, codiconCssUri], webview.cspSource, getNonce(), buildBrowseItems())
 */
export function renderIdleHtml(
    items: CreateItem[],
    cssUris: string | string[],
    cspSource: string,
    nonce: string,
    browseItems: CreateItem[] = [],
): string {
    const rows = renderRows(items, 'createType', 'add', false);
    const browseRows = renderRows(browseItems, 'browseType', 'search', true);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
${styleLinkTags(cssUris)}
<style nonce="${nonce}">
  .create-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin-bottom: 4px;
    text-align: left;
  }
  .create-row-label { flex: 1; }
  /* Pins Settings to the bottom without a fixed height: the body is the flex
     column and the spacer takes whatever is left over. */
  body.popup-body { display: flex; flex-direction: column; min-height: 100vh; }
  .pane-spacer { flex: 1 1 auto; }
  .pane-section-label {
    margin: 14px 0 6px;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  .pane-footer {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--vscode-widget-border, transparent);
  }
</style>
</head>
<body class="popup-body">
  <div class="idle-filter-wrap">
    <input type="text" id="idleFilter" aria-label="${escHtml(vscode.l10n.t('Filter artifact types'))}" placeholder="${escHtml(vscode.l10n.t('Filter…'))}">
    <button type="button" id="idleFilterClear" aria-label="${escHtml(vscode.l10n.t('Clear filter'))}" title="${escHtml(vscode.l10n.t('Clear filter'))}" hidden>
      <span class="codicon codicon-close" aria-hidden="true"></span>
    </button>
  </div>
  <div class="idle-toggle" role="group">
    <button type="button" class="idle-toggle-btn is-active" data-mode="new" aria-pressed="true">${escHtml(vscode.l10n.t('New'))}</button>
    <button type="button" class="idle-toggle-btn" data-mode="open" aria-pressed="false">${escHtml(vscode.l10n.t('Open'))}</button>
  </div>
  <div class="create-list">${rows}${browseRows}</div>
  <div class="pane-spacer"></div>
  <div class="pane-footer">
    <button class="create-row" id="paneSettingsBtn">
      <span class="codicon codicon-gear" aria-hidden="true"></span>
      <span class="create-row-label">${escHtml(vscode.l10n.t('Settings'))}</span>
    </button>
  </div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  ${IDLE_CLIENT_JS}
})();
</script>
</body>
</html>`;
}

/**
 * Renders one list of clickable rows.
 *
 * The row carries its own `data-action`, so the click handler posts the right
 * command without a second `querySelectorAll` per section — one listener, one
 * message shape, whatever the section. `startHidden` renders the row already
 * `hidden` server-side, so the inactive mode's rows never flash visible
 * before `IDLE_CLIENT_JS` runs (or if it fails to load at all).
 *
 * @param items       - Rows to render.
 * @param action      - Message `command` a click posts (`createType` / `browseType`).
 * @param icon        - Vendored codicon glyph name, without the `codicon-` prefix.
 * @param startHidden - Whether the row ships `hidden` in the markup (Open rows, on first load).
 * @returns The rows' HTML, every interpolation escaped.
 *
 * @example
 * renderRows(buildBrowseItems(), 'browseType', 'search', true)
 */
function renderRows(items: CreateItem[], action: string, icon: string, startHidden: boolean): string {
    const hiddenAttr = startHidden ? ' hidden' : '';
    return items.map(item => `
      <button class="create-row" data-type="${escHtml(item.type)}" data-action="${escHtml(action)}"${hiddenAttr}>
        <span class="codicon codicon-${escHtml(icon)}" aria-hidden="true"></span>
        <span class="create-row-label">${escHtml(item.label)}</span>
      </button>`).join('');
}

/**
 * Idle-pane client script — filter input, New/Open toggle, and the delegated
 * row-click handler, concatenated inside the wrapper's own IIFE.
 *
 * Does **not** call `acquireVsCodeApi()` itself (only once per webview is
 * legal): the wrapper declares `const vscode = acquireVsCodeApi();` before
 * concatenating this constant, the same pattern `settings.panel.ts:339` uses
 * for `MAIN_PANE_CLIENT_JS`.
 *
 * One predicate (`applyFilter`) recomputes every row's `hidden` on both a
 * filter keystroke and a toggle click, so the two writers can never disagree
 * about a row mid-session. `mode` and the filter query persist via
 * `vscode.setState`/`getState` — `mode` is narrowed to the two known literals
 * on read-back so a corrupted or hostile persisted value can never reach
 * `dataset`/`classList`/`aria-pressed` un-validated, and the restored query
 * is assigned only to `#idleFilter.value`, never through `innerHTML`.
 *
 * @example
 * `<script nonce="${nonce}">const vscode = acquireVsCodeApi(); ${IDLE_CLIENT_JS}</script>`
 */
export const IDLE_CLIENT_JS = /* js */`
  var toggleBtns = document.querySelectorAll('.idle-toggle-btn');
  var filterInput = document.getElementById('idleFilter');
  var clearBtn = document.getElementById('idleFilterClear');
  var mode = 'new';

  function applyFilter() {
    var query = (filterInput.value || '').toLowerCase();
    var wantAction = mode === 'open' ? 'browseType' : 'createType';
    document.querySelectorAll('.create-row[data-type]').forEach(function (row) {
      var label = (row.textContent || '').toLowerCase();
      row.hidden = !(row.dataset.action === wantAction && label.indexOf(query) !== -1);
    });
    // The clear affordance only exists while there is something to clear, so an
    // empty filter shows no dead button. Driven from applyFilter rather than the
    // input listener alone so every path that changes the query - typing, the
    // toggle, and the getState() restore - agrees about the button's visibility.
    if (clearBtn) { clearBtn.hidden = filterInput.value === ''; }
  }

  function setMode(next) {
    mode = next === 'open' ? 'open' : 'new';
    toggleBtns.forEach(function (btn) {
      var active = btn.dataset.mode === mode;
      if (active) { btn.classList.add('is-active'); } else { btn.classList.remove('is-active'); }
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    applyFilter();
    vscode.setState({ mode: mode, query: filterInput.value });
  }

  toggleBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setMode(btn.dataset.mode);
    });
  });

  filterInput.addEventListener('input', function () {
    applyFilter();
    vscode.setState({ mode: mode, query: filterInput.value });
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      filterInput.value = '';
      applyFilter();
      // Persist the emptied query, or a pane hide/reveal restores the filter the
      // user just cleared - a WebviewView hide disposes the view, so getState()
      // is the only thing that survives it.
      vscode.setState({ mode: mode, query: '' });
      filterInput.focus();
    });
  }

  document.querySelectorAll('.create-row[data-type]').forEach(function (el) {
    el.addEventListener('click', function () {
      vscode.postMessage({ command: el.dataset.action, type: el.dataset.type });
    });
  });
  var settingsBtn = document.getElementById('paneSettingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', function () {
      vscode.postMessage({ command: 'openSettings' });
    });
  }

  var restored = vscode.getState();
  if (restored) {
    filterInput.value = typeof restored.query === 'string' ? restored.query : '';
    setMode(restored.mode);
  }
`;
