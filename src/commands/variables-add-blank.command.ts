import * as vscode from 'vscode';
import { getVaultRootUri } from '../services/config.service.js';
import { ADD_TO_BLANK_COMMAND_ID, defaultIO, type CommandIO } from './variables.command.helpers.js';
import { handleAddVar, handleNewSubSet } from './variables.command.js';
import type { VariableNode, VariablesViewProvider } from '../ui/views/variablesView.provider.js';

/** What the blank file's Add… quick-pick returns. */
type BlankChoice = vscode.QuickPickItem & { choice: 'variable' | 'subset' };

/**
 * "Add…" on a blank Variables file (frontmatter only) — the one row where both
 * a variable and a sub-set are valid first steps, so it asks instead of
 * showing two identical `+` icons.
 *
 * - **Variable** — `handleAddVar`, which gives a blank file the untitled block
 *   its first variable goes into (the file becomes a one-block set).
 * - **Sub-set** — the file becomes a sub-sets set, via `handleNewSubSet`
 *   (name pre-filled with the set's title).
 *
 * @param node      - Clicked blank `file` row.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns Resolves once the chosen flow finishes or is cancelled.
 *
 * @example
 * await handleAddToBlank(node, provider);
 */
export async function handleAddToBlank(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const items: BlankChoice[] = [
        {
            choice: 'variable',
            label: `$(symbol-variable) ${vscode.l10n.t('Variable')}`,
            detail: vscode.l10n.t('One list of variables, no sub-sets'),
        },
        {
            choice: 'subset',
            label: `$(symbol-namespace) ${vscode.l10n.t('Sub-set')}`,
            detail: vscode.l10n.t('Named groups of variables'),
        },
    ];
    const picked = await io.showQuickPick(items, { placeHolder: vscode.l10n.t('What do you want to add?') });
    if (!picked) { return; }

    if (picked.choice === 'subset') {
        await handleNewSubSet(node, provider, io, vaultRoot);
        return;
    }
    await handleAddVar(node, provider, io, vaultRoot);
}

/**
 * Registers the blank file's Add… command.
 *
 * @param context  - Extension context, for disposal.
 * @param provider - The Variables tree provider.
 * @returns Nothing.
 *
 * @example
 * registerAddToBlankCommand(context, variablesProvider);
 */
export function registerAddToBlankCommand(context: vscode.ExtensionContext, provider: VariablesViewProvider): void {
    context.subscriptions.push(vscode.commands.registerCommand(
        ADD_TO_BLANK_COMMAND_ID, (node?: VariableNode) => handleAddToBlank(node, provider)));
}
