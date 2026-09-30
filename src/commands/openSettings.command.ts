import * as vscode from 'vscode';
import { openSettingsPanel } from '../ui/panels/settings.panel.js';

/**
 * Registers the `md-artifacts.settings` command.
 *
 * Opens the MD Artifacts settings webview panel where the user can
 * configure their vault path and enable/disable artifact directories.
 *
 * @param {vscode.ExtensionContext} context - Extension context for subscription management
 */
export function registerOpenSettingsCommand(context: vscode.ExtensionContext): void {
	const disposable = vscode.commands.registerCommand('md-artifacts.settings', () => {
		openSettingsPanel(context);
	});
	context.subscriptions.push(disposable);
}
