import * as vscode from 'vscode';
import { registerOpenSettingsCommand } from './commands/openSettings.command.js';
import { registerInsertCommands } from './commands/insert.command.js';
import { registerEditArtifactCommand } from './commands/editArtifact.command.js';
import { registerMigrateCommand } from './commands/migrate.command.js';
import { refreshVaultContext } from './services/context.service.js';
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
import { getLegacyFeatureFlags, getLegacyVaultPath } from './services/config.service.js';
import { getEngine, startEngine, requestOrNotify } from './engine/engine.vscode.js';
import { EngineRequestError } from './engine/request-error.js';
import { planLegacyImport } from './engine/legacy-import.js';
import type { EngineResult } from './types/engine.types.js';
import { getSessionVault, onVaultChanged, setSessionVault } from './services/vault-watch.service.js';
import { getVarSetScanner } from './ui/panels/varsetPicker.panel.js';

/**
 * Called by VS Code when the extension is first activated.
 *
 * Registers all commands, then asks the engine for its session vault (after
 * registration, so a slow engine never delays commands), runs the one-time
 * legacy-settings import, awaits context key initialisation (so menus are
 * correct before the user can interact) and auto-opens Settings on first use.
 *
 * @param {vscode.ExtensionContext} context - Extension context provided by VS Code
 */
export async function activate(context: vscode.ExtensionContext) {
	// The engine supervisor is lazy: the `config.get` below is its first request,
	// and the one that surfaces a missing or incompatible `mda` at startup.
	context.subscriptions.push(startEngine());

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

	// The engine owns the vault choice (E-8): its session vault replaces the old
	// `vaultPath` setting. Awaited here, after registration, inside its own catch —
	// `requestOrNotify` rethrows non-engine errors and activation must not fail.
	let cfg: EngineResult<'config.get'> | undefined;
	try { cfg = await requestOrNotify('config.get', {}); } catch { cfg = undefined; }
	setSessionVault(cfg?.vault);
	if (cfg) { await importLegacySettings(context, cfg); }

	// The engine sends no change notifications: the vault watcher invalidates caches.
	context.subscriptions.push(onVaultChanged(() => getVarSetScanner().invalidate()));

	// Await context key setup — ensures menus reflect vault state before first user interaction.
	// Without await the keys land asynchronously and the first right-click may show no items.
	await refreshVaultContext();

	// Auto-open Settings on first use — checked after the import, which may have selected one.
	if (!getSessionVault()) {
		void vscode.commands.executeCommand('md-artifacts.settings');
	}
}

/** `globalState` key recording that the legacy `vaultPath` / `features.*` import reached a final outcome. */
const LEGACY_IMPORTED_KEY = 'mdArtifacts.legacyImported';

/**
 * One-time import of the pre-engine settings (O-4). The flag is set only on a final outcome —
 * never after an engine failure, which would otherwise mark the import done forever.
 *
 * @param context - Extension context (its `globalState` holds the done-flag).
 * @param cfg - The engine's `config.get` result.
 * @returns Resolves when the import is done, skipped, or abandoned for this activation.
 * @example
 * await importLegacySettings(context, cfg);
 */
async function importLegacySettings(context: vscode.ExtensionContext, cfg: EngineResult<'config.get'>): Promise<void> {
	if (context.globalState.get<boolean>(LEGACY_IMPORTED_KEY, false)) { return; }
	const markDone = (): Thenable<void> => context.globalState.update(LEGACY_IMPORTED_KEY, true);
	const legacyVaultPath = getLegacyVaultPath();
	// The engine already has a vault, or there is nothing to import: final.
	if (cfg.source !== 'none' || !legacyVaultPath) { await markDone(); return; }
	const info = getEngine().info;
	if (!info) { return; }
	let inspect: { isObsidianVault: boolean } | undefined;
	try {
		inspect = await getEngine().request('vault.inspect', { path: legacyVaultPath });
	} catch (e) {
		// A vanished legacy path is final; any other failure retries next activation.
		if (e instanceof EngineRequestError && e.data.code === 'path.not_found') { await markDone(); }
		return;
	}
	const defaults = Object.fromEntries(info.types.map(t => [t.type, t.defaultEnabled]));
	const steps = planLegacyImport({
		engineSource: cfg.source, legacyVaultPath, legacyFlags: getLegacyFeatureFlags(),
		alreadyImported: false, defaults, inspect,
	});
	try {
		for (const step of steps) {
			if (step.op === 'vault.select') {
				const sel = await getEngine().request('vault.select', { path: step.path, createDefaults: step.createDefaults });
				setSessionVault(sel.path);
			} else {
				await getEngine().request('types.set_enabled', { type: step.type, enabled: step.enabled });
			}
		}
	} catch {
		return;   // retried next activation; the flag stays unset
	}
	await markDone();   // every step succeeded, or the plan was [] for a final reason (not a vault)
}

export function deactivate() {}
