import * as vscode from 'vscode';
import { SEARCH_COMMAND_ID, CLEAR_SEARCH_COMMAND_ID } from './variables.command.helpers.js';
import type { VariableNode, VariablesViewProvider } from '../ui/views/variablesView.provider.js';

/** Context key that shows the Clear Search button while a filter is active. */
const FILTERED_CONTEXT_KEY = 'md-artifacts.variablesFiltered';

/**
 * Applies a search to the Variables tree and mirrors it in the view header.
 *
 * A TreeView cannot host a text input, so the query lives in an input box and
 * the header's description is where the active filter stays visible.
 *
 * @param provider - The Variables tree provider.
 * @param view     - The Variables TreeView, for its description.
 * @param query    - Search text; `''` clears.
 * @returns Nothing.
 *
 * @example
 * applySearch(provider, view, 'host'); // header shows: “host”
 */
function applySearch(provider: VariablesViewProvider, view: vscode.TreeView<VariableNode>, query: string): void {
    provider.setFilter(query);
    const active = query.trim() !== '';
    view.description = active ? vscode.l10n.t('Filter: {0}', query.trim()) : undefined;
    void vscode.commands.executeCommand('setContext', FILTERED_CONTEXT_KEY, active);
}

/**
 * Registers the Variables tree's search and clear-search commands.
 *
 * Search opens an input box that filters the tree **as you type** (no Enter
 * needed); Enter or Escape just closes the box, and the filter stays until
 * cleared from the view's title bar.
 *
 * @param context  - Extension context, for disposal.
 * @param provider - The Variables tree provider.
 * @param view     - The Variables TreeView.
 * @returns Nothing.
 *
 * @example
 * registerVariablesSearchCommands(context, provider, view);
 */
export function registerVariablesSearchCommands(
    context: vscode.ExtensionContext,
    provider: VariablesViewProvider,
    view: vscode.TreeView<VariableNode>,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(SEARCH_COMMAND_ID, () => {
            const box = vscode.window.createInputBox();
            box.title = vscode.l10n.t('Search Variable Sets');
            box.placeholder = vscode.l10n.t('Set, sub-set, variable name or value');
            box.value = provider.filterText;
            box.onDidChangeValue(v => applySearch(provider, view, v));
            box.onDidAccept(() => box.hide());
            box.onDidHide(() => box.dispose());
            box.show();
        }),
        vscode.commands.registerCommand(CLEAR_SEARCH_COMMAND_ID, () => applySearch(provider, view, '')),
    );
}
