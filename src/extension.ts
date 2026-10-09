import * as vscode from 'vscode';
import { registerOpenSettingsCommand } from './commands/openSettings.command.js';
import { registerInsertCommands } from './commands/insert.command.js';
import { registerEditArtifactCommand } from './commands/editArtifact.command.js';
import { registerMigrateCommand } from './commands/migrate.command.js';
import { refreshVaultContext } from './services/context.service.js';
import { createVaultDirectory } from './services/vault.service.js';
import { registerCreateSurfaceCommands } from './commands/create-from-surface.command.js';
import { MainViewProvider, setMainViewProvider } from './ui/views/mainView.provider.js';
import { VariablesViewProvider } from './ui/views/variablesView.provider.js';
import { registerVariablesCommands } from './commands/variables.command.js';
import { registerVariablesSearchCommands } from './commands/variables-search.command.js';
import { registerAddToBlankCommand } from './commands/variables-add-blank.command.js';
import { registerVariablesMetaCommands } from './commands/variables-meta.command.js';
import { registerVariablesInfoCommand } from './commands/variables-info.command.js';
import { handleApplyToPreview, handleApplyToEditor, handleSaveCurrentValues, liveApplyDeps } from './commands/variables-apply.command.js';
import { onPreviewTargetChanged } from './services/preview-target.service.js';
import { APPLY_TO_PREVIEW_COMMAND_ID, APPLY_TO_EDITOR_COMMAND_ID, SAVE_CURRENT_VALUES_COMMAND_ID } from './commands/variables.command.helpers.js';
import type { VariableNode } from './ui/views/variablesView.provider.js';
import { sweepOrphans } from './services/scratch-file.service.js';
import { SCRATCH_SUBDIR as FORM_BLOCK_SUBDIR } from './ui/panels/artifactForm/blockExpand.js';
import { BLOCK_EDIT_SUBDIR } from './ui/panels/artifactPicker/blockEditor.js';
import { ARTIFACTS } from './types/constants.js';
import { CONFIG_SECTION, getVaultPath } from './services/config.service.js';

/**
 * Called by VS Code when the extension is first activated.
 *
 * Registers all commands, awaits context key initialisation (so menus are
 * correct before the user can interact), auto-opens Settings on first use,
 * and subscribes to configuration changes for Settings Sync / external edits.
 *
 * @param {vscode.ExtensionContext} context - Extension context provided by VS Code
 */
export async function activate(context: vscode.ExtensionContext) {
	// Register commands first so executeCommand calls below resolve correctly
	registerOpenSettingsCommand(context);
	registerInsertCommands(context);
	registerCreateSurfaceCommands(context);
	registerMigrateCommand(context);
	context.subscriptions.push(registerEditArtifactCommand(context));

	// The main pane. Registered without a `when` on the view itself (package.json):
	// a view that fails its `when` is dropped, and a container whose views are all
	// dropped leaves the activity bar entirely — taking its viewsWelcome with it.
	const mainViewProvider = new MainViewProvider(context.extensionUri);
	// The picker reaches the pane through this accessor rather than a seventh
	// `openArtifactPicker` parameter threaded through four call sites — the same
	// idiom `varsetPicker.panel.ts`'s `getVarSetScanner()` already uses.
	setMainViewProvider(mainViewProvider);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			MainViewProvider.viewType,
			mainViewProvider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
		new vscode.Disposable(() => setMainViewProvider(undefined)),
	);

	const variablesProvider = new VariablesViewProvider();
	// createTreeView (not registerTreeDataProvider) because search writes the
	// view's header description.
	const variablesView = vscode.window.createTreeView(VariablesViewProvider.viewType, {
		treeDataProvider: variablesProvider,
	});

	// The Variables tree. Read-only this wave; T16 (Wave 6) adds the CRUD
	// commands that call `refresh()`. Registered here for the same reason the
	// main pane is: a contributed view with no provider renders as a permanently
	// empty pane and reports nothing anywhere (ledger #52).
	context.subscriptions.push(
		variablesView,
		// The provider itself, because it subscribes to the process-wide
		// VarSetScanner singleton — without this the listener outlives the
		// provider for the life of the host (H0.1).
		variablesProvider,
	);

	// Variables CRUD commands. Registered after the tree provider above, so the
	// refresh callback they fire always has a provider to reach.
	registerVariablesCommands(context, variablesProvider);
	registerVariablesSearchCommands(context, variablesProvider, variablesView);
	registerAddToBlankCommand(context, variablesProvider);
	registerVariablesMetaCommands(context, variablesProvider);
	registerVariablesInfoCommand(context);

	// The two Variables-pane commands that act on a live preview (W1/T1.3).
	// Ids come from the `VARIABLE_COMMAND_SUFFIXES` derivation, never hand-typed
	// — `package-variables-menus.test.ts` pins the manifest to the same source.
	// `liveApplyDeps()` is called per invocation so `vaultRoot` reflects the
	// current configuration rather than whatever it was at activation.
	context.subscriptions.push(
		vscode.commands.registerCommand(
			APPLY_TO_PREVIEW_COMMAND_ID,
			(node?: VariableNode) => handleApplyToPreview(node, liveApplyDeps()),
		),
		vscode.commands.registerCommand(
			APPLY_TO_EDITOR_COMMAND_ID,
			(node?: VariableNode) => handleApplyToEditor(node, liveApplyDeps()),
		),
		// The Variables pane shows Apply-to-preview only while a preview is open.
		new vscode.Disposable(onPreviewTargetChanged(active => {
			void vscode.commands.executeCommand('setContext', 'md-artifacts.previewActive', active);
		})),
		vscode.commands.registerCommand(
			SAVE_CURRENT_VALUES_COMMAND_ID,
			() => handleSaveCurrentValues(liveApplyDeps()),
		),
	);

	// Clean up scratch files orphaned by a previous crash / hard-close, through
	// the one scratch-file authority. Both subdirs are now owned by the service
	// and named by their owning module — no literal spelled here.
	const storageUri = context.storageUri ?? context.globalStorageUri;
	for (const subdir of [BLOCK_EDIT_SUBDIR, FORM_BLOCK_SUBDIR]) {
		void sweepOrphans(storageUri, subdir);
	}

	// Await context key setup — ensures menus reflect vault state before first user interaction.
	// Without await the keys land asynchronously and the first right-click may show no items.
	await refreshVaultContext();

	// Auto-open Settings on first use (no vault configured yet)
	const vaultPath = getVaultPath();

	if (!vaultPath) {
		vscode.commands.executeCommand('md-artifacts.settings');
	}

	// React to any mdArtifacts.* setting change (Settings Sync, manual edits, etc.)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration(CONFIG_SECTION)) { return; }

			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const changedVaultPath = getVaultPath();

			// When feature flags arrive via Settings Sync, ensure enabled dirs exist on disk.
			// Only CREATE — never auto-delete to prevent accidental data loss.
			const featuresKey = `${CONFIG_SECTION}.features`;
			if (changedVaultPath && e.affectsConfiguration(featuresKey)) {
				for (const artifact of ARTIFACTS) {
					const enabled = config.get<boolean>(
						`features.${artifact.dir.toLowerCase()}`,
						artifact.default
					);
					if (enabled) {
						createVaultDirectory(changedVaultPath, artifact.dir);
					}
				}
			}

			refreshVaultContext();
		})
	);
}

export function deactivate() {}
