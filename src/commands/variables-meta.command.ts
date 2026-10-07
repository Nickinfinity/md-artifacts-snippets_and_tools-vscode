import * as vscode from 'vscode';
import { getVaultRootUri } from '../services/config.service.js';
import { setSubSetDescription } from '../services/variables-crud.service.js';
import { validateSubSetDescriptions } from '../services/varset-form.service.js';
import {
    EDIT_DESCRIPTION_COMMAND_ID, EDIT_TAGS_COMMAND_ID,
    resolveTarget, commitWrite, errMessage, defaultIO, type CommandIO, type ResolvedTarget,
} from './variables.command.helpers.js';
import type { ArtifactFormModel } from '../types/artifact-form.types.js';
import type { VariableNode, VariablesViewProvider } from '../ui/views/variablesView.provider.js';

/**
 * Splits a typed tag list: commas or spaces separate, a leading `#` is
 * dropped (the pane shows tags as `#tag`, so a pasted label round-trips),
 * blanks and duplicates go. Characters the frontmatter list cannot hold are
 * left to the serializer, which drops any tag carrying them.
 *
 * @param text - What the user typed, e.g. `'#api, http  #rest'`.
 * @returns The tags, in typed order, de-duplicated.
 *
 * @example
 * parseTagList('#api, http  #rest, api'); // → ['api', 'http', 'rest']
 */
export function parseTagList(text: string): string[] {
    const tags = text.split(/[,\s]+/).map(t => t.replace(/^#+/, '').trim()).filter(Boolean);
    return [...new Set(tags)];
}

/**
 * Writes `model` when it differs from the target's; a no-op otherwise.
 *
 * @param target   - Resolved file.
 * @param model    - The edited model.
 * @param provider - Tree provider to refresh on success.
 * @param io       - Interaction bag.
 * @returns Resolves once written or refused (toast shown).
 *
 * @example
 * await write(target, { ...target.model, tags: ['api'] }, provider, io);
 */
async function write(target: ResolvedTarget, model: ArtifactFormModel, provider: VariablesViewProvider, io: CommandIO): Promise<void> {
    try {
        await commitWrite(target.vaultRoot, target.filePath, model, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
    }
}

/**
 * Asks for a one-line description, refusing to flatten one that already spans
 * several lines — an input box would silently join them; the editor keeps them.
 *
 * @param io      - Interaction bag.
 * @param current - The description as stored.
 * @returns The new text, or `undefined` on Cancel/Escape, no change, or a refusal.
 *
 * @example
 * await promptDescription(io, 'Users keyed by status');
 */
async function promptDescription(io: CommandIO, current: string): Promise<string | undefined> {
    if (current.includes('\n')) {
        io.showError(vscode.l10n.t('MD Artifacts: this description spans several lines — edit it in the editor (pencil icon) to keep them.'));
        return undefined;
    }
    const text = await io.showInputBox({
        prompt: vscode.l10n.t('Description (leave empty to remove)'),
        value: current,
        validateInput: t => validateSubSetDescriptions([t]).ok
            ? undefined
            : vscode.l10n.t('A line cannot start with ``` or "## ".'),
    });
    if (text === undefined) { return undefined; }
    const trimmed = text.trim();
    return trimmed === current ? undefined : trimmed;
}

/**
 * Edits the description of the clicked row: a file row edits the set's
 * frontmatter `description:`, a sub-set row edits the prose under its
 * `## ` heading. Unchanged text or Cancel/Escape writes nothing.
 *
 * @param node      - Clicked `file` or `subset` row.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns Resolves once written, cancelled, or refused.
 *
 * @example
 * await handleEditDescription(node, provider);
 */
export async function handleEditDescription(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const isSubSet = node?.kind === 'subset';
    const target = await resolveTarget(node, isSubSet ? 'subset' : 'file', vaultRoot, io);
    if (!target) { return; }

    if (!isSubSet) {
        const text = await promptDescription(io, target.model.description);
        if (text === undefined) { return; }
        await write(target, { ...target.model, description: text }, provider, io);
        return;
    }

    const block = target.model.blocks[target.subIdx ?? -1];
    if (!block) {
        io.showError(vscode.l10n.t('MD Artifacts: sub-set not found — refresh the tree and retry.'));
        return;
    }
    const text = await promptDescription(io, block.description);
    if (text === undefined) { return; }
    try {
        await write(target, setSubSetDescription(target.model, target.subIdx ?? -1, text), provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
    }
}

/**
 * Edits the clicked file's tags as one comma-separated line (see
 * {@link parseTagList}). Unchanged tags or Cancel/Escape writes nothing.
 *
 * @param node      - Clicked `file` row.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns Resolves once written, cancelled, or refused.
 *
 * @example
 * await handleEditTags(node, provider);
 */
export async function handleEditTags(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const target = await resolveTarget(node, 'file', vaultRoot, io);
    if (!target) { return; }
    const text = await io.showInputBox({
        prompt: vscode.l10n.t('Tags, separated by commas'),
        value: target.model.tags.join(', '),
    });
    if (text === undefined) { return; }
    const tags = parseTagList(text);
    if (tags.join('\n') === target.model.tags.join('\n')) { return; }
    await write(target, { ...target.model, tags }, provider, io);
}

/**
 * Registers the description and tag commands of the Variables pane.
 *
 * @param context  - Extension context, for disposal.
 * @param provider - The Variables tree provider.
 * @returns Nothing.
 *
 * @example
 * registerVariablesMetaCommands(context, variablesProvider);
 */
export function registerVariablesMetaCommands(context: vscode.ExtensionContext, provider: VariablesViewProvider): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(EDIT_DESCRIPTION_COMMAND_ID, (node?: VariableNode) => handleEditDescription(node, provider)),
        vscode.commands.registerCommand(EDIT_TAGS_COMMAND_ID, (node?: VariableNode) => handleEditTags(node, provider)),
    );
}
