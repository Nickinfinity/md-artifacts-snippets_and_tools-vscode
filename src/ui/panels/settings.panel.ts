import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce } from '../../utils/helpers.js';
import { styleLinkTags } from '../../utils/html.js';
import { validateObsidianVault, detectVaultDirs, createVaultDirectory, deleteVaultDirectory, isDirectoryEmpty } from '../../services/vault.service.js';
import { refreshVaultContext } from '../../services/context.service.js';
import { CONFIG_SECTION, getVaultPath, getPreviewWidthSteps, getVariablesHeightFraction } from '../../services/config.service.js';
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
 * Vault path and feature flags are persisted via the VS Code Settings API
 * (`obsidianArtifacts.*`) so they sync across devices via Settings Sync.
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
		vscode.l10n.t('Obsidian Artifacts: AI Snippets & Tools - Settings'),
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

	// ── Restore saved config ──────────────────────────────────────────────────
	// Reads the current vault path from VS Code settings and sends it to the
	// webview. Called on initial open AND every time the panel becomes visible
	// again so any external setting changes (e.g. Settings Sync) are reflected.
	function postCurrentConfig(): void {
		const savedPath = getVaultPath();

		if (savedPath) {
			const detectedDirs = detectVaultDirs(savedPath);
			panel.webview.postMessage({ command: 'updatePath', path: savedPath, dirs: detectedDirs });
		}
		// Unconditional: the pane settings have defaults and apply with or
		// without a vault, so they must seed even on a first, vault-less open.
		postMainPaneConfig(panel);
	}

	// Re-hydrate the webview whenever it becomes visible (tab switch or initial focus)
	panel.onDidChangeViewState(({ webviewPanel }) => {
		if (webviewPanel.visible) {
			postCurrentConfig();
		}
	});

	// Listen for messages from the webview (user interactions)
	// Thin dispatcher: each branch's body lives in its own module-scope handler
	// so this function stays inside the cognitive-complexity budget as the
	// panel grows. Add a new message by adding a handler, not a nested block.
	panel.webview.onDidReceiveMessage(async (message) => {
		if      (message.command === 'selectFolder')  { await handleSelectFolder(panel); }
		else if (message.command === 'dirToggle')     { await handleDirToggle(panel, message); }
		else if (message.command === 'setMainPane')   { await handleSetMainPane(panel, message); }
		else if (message.command === 'resetMainPane') { await handleResetMainPane(panel); }
	});

	// Send the initial saved config once the panel is open
	postCurrentConfig();
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

/**
 * Handles the "Select Vault Folder" button.
 *
 * @param panel - Panel to post the new vault state back to.
 * @returns Resolves once the vault is validated, stored and echoed back.
 *
 * @example
 * await handleSelectFolder(panel);
 */
async function handleSelectFolder(panel: vscode.WebviewPanel): Promise<void> {
			// Show native file picker dialog — users can only select folders, not files
			const folderUri = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: vscode.l10n.t('Select Vault')
			});

			if (folderUri && folderUri[0]) {
				const selectedFolderPath = folderUri[0].fsPath;

				// Validate the selected path is a valid Obsidian vault (contains .obsidian/)
				if (!validateObsidianVault(selectedFolderPath)) {
					return;
				}

				// Persist vault path to VS Code settings (global scope = synced across devices)
				await vscode.workspace
					.getConfiguration(CONFIG_SECTION)
					.update('vaultPath', selectedFolderPath, vscode.ConfigurationTarget.Global);

				vscode.window.showInformationMessage(vscode.l10n.t('Obsidian vault path saved: {0}', selectedFolderPath));

				// Refresh context keys so editor/terminal/explorer menus reflect the new vault state
				refreshVaultContext();

				// Send vault path and directory status to webview to update UI
				const detectedDirs = detectVaultDirs(selectedFolderPath);
				panel.webview.postMessage({ command: 'updatePath', path: selectedFolderPath, dirs: detectedDirs });
			} else {
				vscode.window.showWarningMessage(vscode.l10n.t('No folder selected.'));
			}
}

/**
 * Handles a vault-directory checkbox toggle.
 *
 * @param panel   - Panel to post the refreshed directory status back to.
 * @param message - Raw webview message carrying `vaultPath`, `dirName`, `isChecked`.
 * @returns Resolves once the directory and its feature flag are in sync.
 *
 * @example
 * await handleDirToggle(panel, { vaultPath: '/v', dirName: 'Snippets', isChecked: true });
 */
async function handleDirToggle(panel: vscode.WebviewPanel, message: Record<string, unknown>): Promise<void> {
			const vaultPath = message.vaultPath as string;
			const dirName  = message.dirName  as string;
			const isChecked = message.isChecked as boolean;

			// Safety check: ensure a vault has been selected before allowing directory operations
			if (!vaultPath) {
				vscode.window.showWarningMessage(vscode.l10n.t('Please select a vault first.'));
				return;
			}

			if (isChecked) {
				// User enabled the feature: CREATE the directory on disk
				createVaultDirectory(vaultPath, dirName);
			} else {
				// User disabled the feature: DELETE the directory only if empty (safety guard)
				if (!isDirectoryEmpty(path.join(vaultPath, dirName))) {
					vscode.window.showWarningMessage(vscode.l10n.t('Cannot disable "{0}" — directory is not empty.', dirName));
					return;
				}
				deleteVaultDirectory(vaultPath, dirName);
			}

			// Persist the feature flag to VS Code settings so it syncs across devices
			await vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update(
					`features.${dirName.toLowerCase()}`,
					isChecked,
					vscode.ConfigurationTarget.Global
				);

			// Refresh context keys and send updated directory status back to the webview
			refreshVaultContext();
			const updatedDirs = detectVaultDirs(vaultPath);
			panel.webview.postMessage({ command: 'updateDirs', dirs: updatedDirs });
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
  <title>Obsidian Artifacts: AI Snippets & Tools - CONFIG</title>
</head>
<body class="settings-body">
  <div id="webviewContent">
    <!-- Header: extension logo and title -->
    <div class="logo-row">
      <span class="logo-icon">🔮</span>
      <h1>Obsidian Artifacts: AI Snippets &amp; Tools</h1>
    </div>
    <p class="tagline">Bring your Obsidian vault into VS Code</p>

    <hr>

    <!-- Introduction section explaining what the extension does -->
    <div class="intro">
      <p>This extension connects VS Code to your <strong>Obsidian vault</strong>, letting you browse notes, insert snippets, and create new entries without leaving the editor.</p>
      <p>To get started, point the extension to your vault's root folder — the directory that contains your <code>.obsidian/</code> folder. Your selection is saved locally and persists across sessions.</p>
    </div>

    <!-- Vault Features section: shown only after vault selection -->
    <!-- Contains checkbox list for directory management -->
    <div id="directoriesSection" class="directories-section">
      <p class="section-label">Vault Features</p>
      <p style="font-size: 0.9rem; color: var(--vscode-descriptionForeground); margin-bottom: 12px;">Select which directories to create in your vault. Directories marked as "default" will be auto-created when you first select your vault.</p>
      <!-- Directory checkboxes will be rendered here by JavaScript -->
      <div id="directoryList" class="directory-list"></div>
    </div>

    <!-- Vault Location section: shows selected path and folder picker button -->
    <div class="vault-dir-section">
      <p class="section-label">Vault Location</p>

      <div class="vault-card">
        <span class="vault-icon">📁</span>
        <span id="folderPath">No vault selected</span>
      </div>

      <button id="selectFolderButton">
        <span>Select Vault Folder</span>
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

    /**
     * Renders the directory checkbox list based on vault directory status.
     *
     * Creates a checkbox for each directory from ARTIFACTS, setting checked state
     * based on whether the directory exists on disk. Includes labels showing
     * directory name and whether it's auto-created or optional.
     *
     * @param {Array} dirs - Array of directory status objects from detectVaultDirs()
     */
    function renderDirectories(dirs) {
      const directoryList = document.getElementById('directoryList');
      directoryList.innerHTML = ''; // Clear existing items

      // Create checkbox item for each vault directory
      dirs.forEach(dir => {
        // Label wraps the entire checkbox item for better UX
        const item = document.createElement('label');
        item.className = 'directory-item';

        // Checkbox: checked if directory exists
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

        // Label text and hint container
        const labelDiv = document.createElement('div');
        labelDiv.className = 'directory-label';

        // Directory name
        const labelText = document.createElement('span');
        labelText.className = 'directory-label-text';
        labelText.textContent = dir.name;

        // Hint showing if auto-created (default) or optional
        const hint = document.createElement('span');
        hint.className = 'directory-hint';
        hint.textContent = dir.default ? '(automatically created)' : '(optional)';

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
