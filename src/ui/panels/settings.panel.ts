import * as vscode from 'vscode';
import { getNonce } from '../../utils/helpers.js';
import { escHtml, styleLinkTags } from '../../utils/html.js';
import { jsStr } from './artifactPicker/webviewSnippets.js';
import { getEngine, requestOrNotify } from '../../engine/engine.vscode.js';
import type { EngineResult } from '../../types/engine.types.js';
import { getSessionVault, setSessionVault } from '../../services/vault-watch.service.js';
import { getAllTypes, getEntry, getTypeForDir } from '../../services/artifact-type-config.service.js';
import { confirmModal } from '../../services/confirm.service.js';
import { refreshVaultContext } from '../../services/context.service.js';
import { CONFIG_SECTION, getPreviewWidthSteps, getVariablesHeightFraction } from '../../services/config.service.js';
import {
	MAIN_PANE_KEYS,
	MAIN_PANE_SECTION_HTML,
	MAIN_PANE_SECTION_CSS,
	MAIN_PANE_CLIENT_JS,
	isMainPaneKey,
} from './settings.panel.helpers.js';

/**
 * Opens the configuration panel webview where users can:
 * 1. Select their Obsidian vault root directory
 * 2. Choose which vault feature directories to create/maintain
 *
 * The vault and the enabled types live in the engine; only the pane settings
 * are VS Code settings (`mdArtifacts.*`).
 *
 * @param {vscode.ExtensionContext} context - Extension context providing the extension URI
 *                                            for loading webview assets
 *
 * @example
 * openSettingsPanel(context);
 */
export function openSettingsPanel(context: vscode.ExtensionContext) {
	const panel = vscode.window.createWebviewPanel(
		'settings',
		vscode.l10n.t('MD Artifacts: AI Snippets & Tools - Settings'),
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'ui')],
			// Preserve the webview's JS and DOM when the user switches to another tab.
			// Without this, VS Code destroys the webview context on hide and the HTML
			// reloads from scratch on return — the postMessage with saved config is never
			// re-sent, so the UI appears empty even though settings are intact.
			retainContextWhenHidden: true,
		}
	);

	panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

	// Background read: called on open and whenever the panel becomes visible again.
	async function postCurrentConfig(): Promise<void> {
		const savedPath = getSessionVault();
		if (savedPath) {
			const dirs = await readDirRows();
			if (dirs) { await panel.webview.postMessage({ command: 'updatePath', path: savedPath, dirs }); }
		}
		// Unconditional: the pane settings have defaults and apply with or
		// without a vault, so they must seed even on a first, vault-less open.
		postMainPaneConfig(panel);
	}

	// Re-hydrate the webview whenever it becomes visible (tab switch or initial focus)
	panel.onDidChangeViewState(({ webviewPanel }) => {
		if (webviewPanel.visible) {
			void postCurrentConfig();
		}
	});

	// Thin dispatcher: add a message by adding a module-scope handler, not a nested block.
	panel.webview.onDidReceiveMessage(async (message) => {
		if      (message.command === 'selectFolder')  { await handleSelectFolder(panel); }
		else if (message.command === 'dirToggle')     { await handleDirToggle(panel, message); }
		else if (message.command === 'setMainPane')   { await handleSetMainPane(panel, message); }
		else if (message.command === 'resetMainPane') { await handleResetMainPane(panel); }
	});

	void postCurrentConfig();
}

/**
 * Persists a Preview Pane setting from the webview.
 *
 * The key is narrowed against `MAIN_PANE_KEYS` before it reaches
 * `update()` — a webview message is untrusted input, and this panel is the
 * only writer of the config section, so an unchecked key here would let the
 * webview write anywhere in it.
 *
 * @param panel   - The settings panel, echoed back the stored values.
 * @param message - Raw webview message carrying `key` and numeric `value`.
 * @returns Resolves once the setting is written and echoed back.
 *
 * @example
 * await handleSetMainPane(panel, { key: 'mainPane.previewWidthSteps', value: 5 });
 */
async function handleSetMainPane(panel: vscode.WebviewPanel, message: Record<string, unknown>): Promise<void> {
	const key = message.key;
	const value = message.value;
	if (!isMainPaneKey(key) || typeof value !== 'number' || !Number.isFinite(value)) { return; }

	await vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.update(key, value, vscode.ConfigurationTarget.Global);

	postMainPaneConfig(panel);
}

/**
 * Clears both Preview Pane overrides so the manifest defaults apply again.
 *
 * Writes `undefined`, which *removes* the override rather than storing a
 * literal — storing the current default would silently pin the value if the
 * shipped default ever changed.
 *
 * @param panel - The settings panel, echoed the restored defaults.
 * @returns Resolves once both keys are cleared.
 *
 * @example
 * await handleResetMainPane(panel);
 */
async function handleResetMainPane(panel: vscode.WebviewPanel): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	for (const key of MAIN_PANE_KEYS) {
		await config.update(key, undefined, vscode.ConfigurationTarget.Global);
	}
	postMainPaneConfig(panel);
	vscode.window.showInformationMessage(vscode.l10n.t('Preview pane settings reset to defaults.'));
}

/**
 * Sends the effective Preview Pane values to the webview.
 *
 * Read through `config.service`'s accessors, so what the panel displays is
 * the value the extension will actually use — already normalised and
 * bounds-checked, not the raw stored text.
 *
 * @param panel - Panel to post to.
 *
 * @example
 * postMainPaneConfig(panel);
 */
function postMainPaneConfig(panel: vscode.WebviewPanel): void {
	panel.webview.postMessage({
		command: 'updateMainPane',
		widthSteps: getPreviewWidthSteps(),
		varsFraction: getVariablesHeightFraction(),
	});
}

/** The slice of a `WebviewPanel` the handlers use — lets tests pass a stub. */
export interface SettingsPanelLike { readonly webview: { postMessage(message: unknown): Thenable<boolean> } }

/**
 * Engine type rows → the client's directory shape (`{ ...registry entry, exists: enabled }`).
 * Rows the extension has no registry entry for are dropped: `getEntry` throws on them.
 *
 * @param rows - `types.list` result.
 * @returns Rows for the client's `renderDirectories`.
 * @example
 * toDirRows([{ type: 'Snippet', dir: 'Snippets', enabled: true, dirExists: true }])[0].exists; // true
 */
function toDirRows(rows: EngineResult<'types.list'>) {
	const known = new Set<string>(getAllTypes());
	return rows.filter(r => known.has(r.type)).map(r => ({ ...getEntry(r.type), exists: r.enabled }));
}

/**
 * Background read of the type rows: never toasts, never rejects (catch-all).
 *
 * @returns Client rows, or `undefined` when the engine cannot answer.
 * @example
 * const dirs = await readDirRows();
 */
async function readDirRows(): Promise<ReturnType<typeof toDirRows> | undefined> {
	try {
		return toDirRows(await getEngine().request('types.list', {}));
	} catch {
		return undefined;
	}
}

/**
 * Handles the "Select Vault Folder" button: inspect, confirm, select, then refresh keys and rows.
 *
 * @param panel - Panel to post the new vault state back to.
 * @returns Resolves once the vault is selected and echoed back.
 *
 * @example
 * await handleSelectFolder(panel);
 */
async function handleSelectFolder(panel: SettingsPanelLike): Promise<void> {
	const folderUri = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: vscode.l10n.t('Select Vault')
	});
	if (!folderUri?.[0]) {
		vscode.window.showWarningMessage(vscode.l10n.t('No folder selected.'));
		return;
	}
	const selected = folderUri[0].fsPath;

	// ── Inspect, then confirm what select will create ────────────────────────
	const report = await requestOrNotify('vault.inspect', { path: selected });
	if (!report) { return; }
	if (!report.isObsidianVault) {
		vscode.window.showErrorMessage(
			vscode.l10n.t('"{0}" is not a valid Obsidian vault. The selected folder must contain a .obsidian directory.', selected));
		return;
	}
	const ok = await confirmModal({
		message: vscode.l10n.t('Use "{0}" as your vault?', selected),
		detail: report.missingDefaults.length > 0
			? vscode.l10n.t('These directories will be created: {0}', report.missingDefaults.join(', '))
			: undefined,
		action: vscode.l10n.t('Select Vault'),
	});
	if (!ok) { return; }

	const chosen = await requestOrNotify('vault.select', { path: selected, createDefaults: true });
	if (!chosen) { return; }
	setSessionVault(chosen.path);
	vscode.window.showInformationMessage(vscode.l10n.t('Obsidian vault path saved: {0}', chosen.path));
	await refreshVaultContext();
	const dirs = await readDirRows();
	await panel.webview.postMessage({ command: 'updatePath', path: chosen.path, dirs });
}

/**
 * Handles a vault-directory checkbox toggle. Toggle-off never deletes anything.
 *
 * `message.vaultPath` is ignored (untrusted): the session vault is the only vault, and
 * `dirName` is resolved through the registry — unknown names are dropped.
 *
 * @param panel   - Panel to post the refreshed rows to.
 * @param message - Raw webview message carrying `dirName`, `isChecked`.
 * @returns Resolves once the engine, context keys and webview are in sync.
 *
 * @example
 * await handleDirToggle(panel, { command: 'dirToggle', dirName: 'Snippets', isChecked: false });
 */
export async function handleDirToggle(panel: SettingsPanelLike, message: Record<string, unknown>): Promise<void> {
	if (!getSessionVault()) {
		vscode.window.showWarningMessage(vscode.l10n.t('Please select a vault first.'));
		return;
	}
	const type = typeof message.dirName === 'string' ? getTypeForDir(message.dirName) : undefined;
	if (type === undefined || typeof message.isChecked !== 'boolean') { return; }

	if (!await requestOrNotify('types.set_enabled', { type, enabled: message.isChecked })) { return; }
	await refreshVaultContext();
	const dirs = await readDirRows();
	if (dirs) { await panel.webview.postMessage({ command: 'updateDirs', dirs }); }
}

/**
 * Generates the HTML/CSS/JS content for the settings webview panel.
 *
 * This function creates a complete self-contained webview with:
 * - Introduction text explaining the extension
 * - Vault folder selector button
 * - Checkbox list for vault directories (shown only after vault selection)
 * - CSS styling using VS Code theme variables for consistent appearance
 * - JavaScript for handling user interactions and webview communication
 *
 * @param {vscode.Webview} webview - The webview object for loading assets and CSP headers
 * @param {vscode.Uri} extensionUri - The extension's URI for resolving media asset paths
 * @returns {string} Complete HTML document as a string ready for webview.html assignment
 *
 * @description
 * The webview communicates with the extension via postMessage for:
 * - selectFolder: when user clicks folder selector
 * - dirToggle: when user toggles directory checkboxes
 *
 * Receives messages from extension:
 * - updatePath: when vault is selected (includes vault path and directory status)
 * - updateDirs: when directory status changes (refreshes checkbox states)
 */
function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
	// Generate a random nonce for Content Security Policy (prevents inline script injection attacks)
	const nonce = getNonce();
	// Load external CSS stylesheet from src/ui folder (loaded as URI for security)
	// Order matters — base.css carries the global reset shared by every panel.
	const styleTags = styleLinkTags(
		['base.css', 'settings.css'].map(f =>
			webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui', f)).toString(),
		),
	);

	// Extracted rather than inlined into the `.replace()` below: nesting a
	// template literal inside another is an S4624 violation (CLAUDE.md).
	const vaultStrong = `<strong>${escHtml(vscode.l10n.t('Obsidian vault'))}</strong>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Content Security Policy: inline scripts only allowed with matching nonce, styles from webview host -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'nonce-${nonce}';">
  <!-- Load external stylesheet from extension src/ui folder -->
  ${styleTags}
  <!-- Section-local styles; nonce-matched, which is why style-src carries the nonce too -->
  <style nonce="${nonce}">${MAIN_PANE_SECTION_CSS}</style>
  <title>${escHtml(vscode.l10n.t('MD Artifacts: AI Snippets & Tools - CONFIG'))}</title>
</head>
<body class="settings-body">
  <div id="webviewContent">
    <!-- Header: extension logo and title -->
    <div class="logo-row">
      <span class="logo-icon">🔮</span>
      <h1>${escHtml(vscode.l10n.t('MD Artifacts: AI Snippets & Tools'))}</h1>
    </div>
    <p class="tagline">${escHtml(vscode.l10n.t('Bring your Obsidian vault into VS Code'))}</p>

    <hr>

    <!-- Introduction section explaining what the extension does -->
    <div class="intro">
      <p>${escHtml(vscode.l10n.t('This extension connects VS Code to your {0}, letting you browse notes, insert snippets, and create new entries without leaving the editor.', '{{vault}}')).replace('{{vault}}', vaultStrong)}</p>
      <p>${escHtml(vscode.l10n.t("To get started, point the extension to your vault's root folder — the directory that contains your {0} folder. Your selection is saved locally and persists across sessions.", '{{obsidianDir}}')).replace('{{obsidianDir}}', '<code>.obsidian/</code>')}</p>
    </div>

    <!-- Vault Features section: shown only after vault selection -->
    <!-- Contains checkbox list for directory management -->
    <div id="directoriesSection" class="directories-section">
      <p class="section-label">${escHtml(vscode.l10n.t('Vault Features'))}</p>
      <!-- Directory checkboxes will be rendered here by JavaScript -->
      <div id="directoryList" class="directory-list"></div>
    </div>

    <!-- Vault Location section: shows selected path and folder picker button -->
    <div class="vault-dir-section">
      <p class="section-label">${escHtml(vscode.l10n.t('Vault Location'))}</p>

      <div class="vault-card">
        <span class="vault-icon">📁</span>
        <span id="folderPath">${escHtml(vscode.l10n.t('No vault selected'))}</span>
      </div>

      <button id="selectFolderButton">
        <span>${escHtml(vscode.l10n.t('Select Vault Folder'))}</span>
      </button>
    </div>
${MAIN_PANE_SECTION_HTML}
  </div>

  <!-- Main webview script with nonce for security -->
  <script nonce="${nonce}">
    // Get VS Code API for postMessage communication
    const vscode = acquireVsCodeApi();
    let currentVaultPath = null;

    // LISTENER: Select Folder button click
    document.getElementById('selectFolderButton').addEventListener('click', () => {
      // Send message to extension asking for folder picker
      vscode.postMessage({ command: 'selectFolder' });
    });

    // LISTENER: Messages from extension (vault updates, directory status changes)
${MAIN_PANE_CLIENT_JS}

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.command === 'updateMainPane') {
        applyMainPaneConfig(message);
      }
      else if (message.command === 'updatePath') {
        // Vault path was selected: update UI with vault path and directory status
        currentVaultPath = message.path;
        const el = document.getElementById('folderPath');
        el.textContent = message.path;
        el.classList.add('has-path');

        // Render directory checkboxes if directory status was included
        if (message.dirs) {
          renderDirectories(message.dirs);
        }

        // Show the vault features section
        document.getElementById('directoriesSection').classList.add('active');
      }
      else if (message.command === 'updateDirs') {
        // Directory was created/deleted: refresh checkbox states
        if (message.dirs) {
          renderDirectories(message.dirs);
        }
      }
    });

    // One checkbox per engine type row; checked = enabled.
    function renderDirectories(dirs) {
      const directoryList = document.getElementById('directoryList');
      directoryList.innerHTML = '';
      dirs.forEach(dir => {
        const item = document.createElement('label');
        item.className = 'directory-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = dir.exists;
        checkbox.setAttribute('data-dir-name', dir.dir);

        // Checkbox change handler: send dirToggle message to extension
        checkbox.addEventListener('change', (e) => {
          vscode.postMessage({
            command: 'dirToggle',
            vaultPath: currentVaultPath,
            dirName: dir.dir,
            isChecked: e.target.checked
          });
        });

        const labelDiv = document.createElement('div');
        labelDiv.className = 'directory-label';

        const labelText = document.createElement('span');
        labelText.className = 'directory-label-text';
        labelText.textContent = dir.name;

        const hint = document.createElement('span');
        hint.className = 'directory-hint';
        hint.textContent = dir.default ? ${jsStr(vscode.l10n.t('(automatically created)'))} : ${jsStr(vscode.l10n.t('(optional)'))};

        labelDiv.appendChild(labelText);
        labelDiv.appendChild(hint);

        item.appendChild(checkbox);
        item.appendChild(labelDiv);

        directoryList.appendChild(item);
      });
    }
  </script>
</body>
</html>`;
}
