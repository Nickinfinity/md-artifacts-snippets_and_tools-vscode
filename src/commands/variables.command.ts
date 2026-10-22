import * as vscode from 'vscode';
import { getVaultRootUri } from '../services/config.service.js';
import { resolveInVault } from '../engine/adapt.js';
import { handleWriteError, sendWrite } from '../services/conflict.service.js';
import { openVarsEditForm } from './open-vars-edit.helpers.js';
import { subSetLabel } from '../services/varset.service.js';
import type { SubsetRef } from '../types/engine.types.js';
import type { VariableNode, VariablesViewProvider } from '../ui/views/variablesView.provider.js';
import {
    buildVariableCommandIds, resolveTarget, sendVarsEdit, buildConfirmMessage, at,
    OPEN_FILE_COMMAND_ID, type CommandIO, type ResolvedTarget, defaultIO,
} from './variables.command.helpers.js';
import { promptVarName } from './var-name-prompt.helpers.js';

/**
 * The `md-artifacts.variables.*` tree commands.
 *
 * Each handler resolves its target from the clicked tree node (`resolveTarget`,
 * which reads the file through the engine and keeps its hash), then sends one
 * `vars.*` request carrying that hash (`sendVarsEdit`). The engine owns every
 * vault rule (names, duplicates, shapes); conflicts and engine errors are
 * reported by `sendWrite`. Two things are injected, both defaulted: `io` (user
 * interaction) and `vaultRoot` (default `getVaultRootUri()`, evaluated per call).
 */

/** Toast for a sub-set / variable the tree row no longer matches. */
const notFound = (io: CommandIO, what: 'sub-set' | 'variable'): void => io.showError(what === 'sub-set'
    ? vscode.l10n.t('MD Artifacts: sub-set not found — refresh the tree and retry.')
    : vscode.l10n.t('MD Artifacts: variable not found — refresh the tree and retry.'));

/** Engine ref of the clicked sub-set for sub-set ops; a flat file's lone block is `{0, ''}`. */
const subsetRef = (t: ResolvedTarget): SubsetRef => ({ index: t.subIdx ?? 0, heading: t.subset?.heading ?? '' });

/** The `subset` param for a var op: absent on flat/blank files (engine: `vars.var.rename/ok`). */
const varScope = (t: ResolvedTarget): { subset?: NonNullable<ResolvedTarget['subset']> } => t.subset ? { subset: t.subset } : {};

// ── New file (no node — invoked from the view's title bar) ────────────────

/**
 * Creates a new Variables file (`vars.file.new`) seeded with one placeholder
 * row, then opens it in the form. Title rules, file naming and collisions are
 * the engine's; a collision surfaces as its toast and writes nothing.
 *
 * The placeholder is not optional polish: the form has no add-row affordance,
 * so an empty file would open as a table with nothing to edit.
 *
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @param openForm  - Opens the created file's form.
 * @returns void
 *
 * @example
 * await handleNewFile(provider);
 */
export async function handleNewFile(
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
    openForm?: (fileUri: vscode.Uri) => Promise<void>,
): Promise<void> {
    if (!vaultRoot) {
        io.showError(vscode.l10n.t('MD Artifacts: no vault configured.'));
        return;
    }
    const title = await io.showInputBox({
        prompt: vscode.l10n.t('Title for the new Variables file'),
        validateInput: v => v.trim().length > 0 ? undefined : vscode.l10n.t('Title cannot be empty'),
    });
    if (title === undefined) { return; }

    const onReload = (): void => provider.refresh();
    try {
        const created = await sendWrite('vars.file.new', { title }, { onReload });
        if (!created) { return; }
        const seeded = await sendWrite('vars.var.add', { path: created.path, expectedHash: created.hash, name: 'VK-name', value: '' }, { onReload });
        provider.refresh();
        if (seeded && openForm) { await openForm(vscode.Uri.file(resolveInVault(created.path, vaultRoot.fsPath))); }
    } catch (e) {
        await handleWriteError(e, { onReload });
    }
}

// ── New sub-set (target: file) ─────────────────────────────────────────────

/**
 * Adds a new, empty sub-set to the clicked file (`vars.subset.add`). On a flat
 * file the engine names the untitled block "Default". When the set holds no
 * variables yet, the name box starts with the set's own title; a name already
 * used by a sub-set is flagged while typing.
 *
 * @param node      - Clicked `file` tree node.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleNewSubSet(node, provider);
 */
export async function handleNewSubSet(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const target = await resolveTarget(node, 'file', vaultRoot, io);
    if (!target) { return; }

    const taken = new Set(target.subSets.map(s => s.heading));
    const noVars = target.subSets.every(s => s.vars.length === 0);
    const heading = await io.showInputBox({
        prompt: vscode.l10n.t('New sub-set heading'),
        value: noVars ? target.parsed.frontmatter.title || target.parsed.fileName : '',
        validateInput: text => text !== '' && taken.has(text) ? vscode.l10n.t('Sub-set "{0}" already exists.', text) : undefined,
    });
    if (heading === undefined) { return; }
    await sendVarsEdit(target, 'vars.subset.add', { heading }, provider);
}

// ── Add variable (target: subset) ──────────────────────────────────────────

/**
 * Adds a new variable (`vars.var.add`) to the clicked sub-set — or, on a flat
 * or blank file, to the file itself (the engine makes a blank file flat).
 *
 * @param node      - Clicked `subset` (or lone `file`) tree node.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleAddVar(node, provider);
 */
export async function handleAddVar(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const target = await resolveTarget(node, 'subset', vaultRoot, io);
    if (!target) { return; }
    if (target.parsed.blocks.length > 0 && !at(target.subSets, target.subIdx)) { return notFound(io, 'sub-set'); }

    const name = await promptVarName(io, vscode.l10n.t('Variable name'));
    if (name === undefined) { return; }
    const value = await io.showInputBox({ prompt: vscode.l10n.t('Default value for {0}', name) });
    if (value === undefined) { return; }
    await sendVarsEdit(target, 'vars.var.add', { ...varScope(target), name, value }, provider);
}

/**
 * Resolves a `var` node and its current variable, toasting when the row is stale.
 *
 * @param node      - Clicked `var` node.
 * @param vaultRoot - Vault root.
 * @param io        - Interaction bag.
 * @returns The target and the variable, or `undefined` (refused, toast shown).
 *
 * @example
 * const hit = await resolveVar(node, vaultRoot, io);
 */
async function resolveVar(node: VariableNode | undefined, vaultRoot: vscode.Uri | undefined, io: CommandIO) {
    const target = await resolveTarget(node, 'var', vaultRoot, io);
    if (!target) { return undefined; }
    const subSet = at(target.subSets, target.subIdx);
    const current = at(subSet?.vars ?? [], target.varIdx);
    if (!subSet || !current) { notFound(io, 'variable'); return undefined; }
    return { target, subSet, current };
}

// ── Edit value (target: var) ───────────────────────────────────────────────

/**
 * Edits the clicked variable's default value (`vars.var.set`). A no-op
 * (unchanged value, or Cancel/Escape) sends nothing.
 *
 * @param node      - Clicked `var` tree node.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleEditValue(node, provider);
 */
export async function handleEditValue(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const hit = await resolveVar(node, vaultRoot, io);
    if (!hit) { return; }
    const { target, current } = hit;
    const value = await io.showInputBox({ prompt: vscode.l10n.t('New value for {0}', current.name), value: current.defaultValue });
    if (value === undefined || value === current.defaultValue) { return; }
    await sendVarsEdit(target, 'vars.var.set', { ...varScope(target), name: current.name, value }, provider);
}

// ── Rename variable (target: var) ──────────────────────────────────────────

/**
 * Renames the clicked variable (`vars.var.rename`), preserving its value. A
 * no-op (unchanged name, or Cancel/Escape) sends nothing; a duplicate is the
 * engine's `vars.var_exists`.
 *
 * @param node      - Clicked `var` tree node.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleRenameVar(node, provider);
 */
export async function handleRenameVar(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const hit = await resolveVar(node, vaultRoot, io);
    if (!hit) { return; }
    const { target, current } = hit;
    const newName = await promptVarName(io, vscode.l10n.t('New variable name'), current.name);
    if (newName === undefined || newName === current.name) { return; }
    await sendVarsEdit(target, 'vars.var.rename', { ...varScope(target), name: current.name, newName }, provider);
}

// ── Rename sub-set (target: subset) ────────────────────────────────────────

/**
 * Renames the clicked sub-set's heading (`vars.subset.rename`). A no-op
 * (unchanged heading, or Cancel/Escape) sends nothing.
 *
 * @param node      - Clicked `subset` tree node.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleRenameSubSet(node, provider);
 */
export async function handleRenameSubSet(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const target = await resolveTarget(node, 'subset', vaultRoot, io);
    if (!target) { return; }
    const subSet = at(target.subSets, target.subIdx);
    if (!subSet) { return notFound(io, 'sub-set'); }

    const heading = await io.showInputBox({ prompt: vscode.l10n.t('New sub-set heading'), value: subSet.heading });
    if (heading === undefined || heading === subSet.heading) { return; }
    await sendVarsEdit(target, 'vars.subset.rename', { subset: subsetRef(target), heading }, provider);
}

// ── Delete variable (target: var, destructive) ─────────────────────────────

/**
 * Deletes the clicked variable (`vars.var.delete`) after modal confirmation.
 * Cancel, Escape, or declining sends nothing.
 *
 * @param node      - Clicked `var` tree node.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleDeleteVar(node, provider);
 */
export async function handleDeleteVar(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const hit = await resolveVar(node, vaultRoot, io);
    if (!hit) { return; }
    const { target, subSet, current } = hit;
    if (!await io.confirm(buildConfirmMessage({ kind: 'var', name: current.name, parent: subSetLabel(subSet) }))) { return; }
    await sendVarsEdit(target, 'vars.var.delete', { ...varScope(target), name: current.name }, provider);
}

// ── Delete sub-set (target: subset, destructive) ────────────────────────────

/**
 * Deletes the clicked sub-set (`vars.subset.delete`) after modal confirmation —
 * including a file's last one (via the `fileSingle` row), which leaves the file
 * with no variables. Cancel, Escape, or decline sends nothing.
 *
 * @param node      - Clicked `subset` (or lone `file`) tree node.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleDeleteSubSet(node, provider);
 */
export async function handleDeleteSubSet(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const target = await resolveTarget(node, 'subset', vaultRoot, io);
    if (!target) { return; }
    const subSet = at(target.subSets, target.subIdx);
    if (!subSet) { return notFound(io, 'sub-set'); }

    const message = buildConfirmMessage({
        kind: 'subset', name: subSetLabel(subSet), varCount: subSet.vars.length, parent: target.parsed.relativePath,
    });
    if (!await io.confirm(message)) { return; }
    await sendVarsEdit(target, 'vars.subset.delete', { subset: subsetRef(target) }, provider);
}

// ── Delete file (target: file, destructive) ─────────────────────────────────

/**
 * Deletes the clicked Variables file (`artifact.delete`, permanent — the engine
 * has no trash) after modal confirmation; the message names the file, not its
 * title. Cancel, Escape, or declining sends nothing.
 *
 * @param node      - Clicked `file` tree node.
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleDeleteFile(node, provider);
 */
export async function handleDeleteFile(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const target = await resolveTarget(node, 'file', vaultRoot, io);
    if (!target) { return; }

    const varCount = target.subSets.reduce((n, s) => n + s.vars.length, 0);
    if (!await io.confirm(buildConfirmMessage({ kind: 'file', name: target.parsed.relativePath, varCount }))) { return; }
    const done = await sendWrite('artifact.delete', { path: target.relPath, expectedHash: target.hash }, { onReload: () => provider.refresh() });
    if (done) { provider.refresh(); }
}

// ── Open in form ────────────────────────────────────────────────────────────

/**
 * Opens a Variables file in the var-set form's edit mode, by path — the pane's
 * route into the form (file-node click, and right after `handleNewFile`).
 * Reads through the engine; the path must be inside `Variables/` of the vault.
 *
 * @param fileUri  - The `.md` to open.
 * @param provider - Tree provider, refreshed after a successful save.
 * @param extensionUri - Extension root, for the webview's `localResourceRoots`.
 * @param io       - Interaction bag.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns Resolves once the panel is open, or immediately when the file cannot be read.
 *
 * @example
 * await openVariablesFileInForm(uri, provider, context.extensionUri);
 */
export async function openVariablesFileInForm(
    fileUri: vscode.Uri,
    provider: VariablesViewProvider,
    extensionUri: vscode.Uri,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const node: VariableNode = { id: fileUri.fsPath, parentId: null, kind: 'file', label: '' };
    const target = await resolveTarget(node, 'file', vaultRoot, io);
    if (!target) { return; }
    await openVarsEditForm(target.parsed, extensionUri, () => provider.refresh());
}

/**
 * Opens the clicked `file` tree node in the var-set form's edit mode.
 *
 * @param node         - Clicked `file` tree node.
 * @param provider     - Tree provider, refreshed after a successful save.
 * @param extensionUri - Extension root, for the webview's `localResourceRoots`.
 * @param io           - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot    - Vault root; defaults to `getVaultRootUri()`.
 * @returns Resolves once the panel is open, or immediately when the node cannot be resolved.
 *
 * @example
 * await handleOpenFile(node, provider, context.extensionUri);
 */
export async function handleOpenFile(
    node: VariableNode | undefined,
    provider: VariablesViewProvider,
    extensionUri: vscode.Uri,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    const target = await resolveTarget(node, 'file', vaultRoot, io);
    if (!target) { return; }
    await openVarsEditForm(target.parsed, extensionUri, () => provider.refresh());
}

// ── Registration ──────────────────────────────────────────────────────────

/**
 * Registers the `md-artifacts.variables.*` tree commands.
 *
 * @param context  - Extension context used to register the disposable subscriptions.
 * @param provider - The Variables tree provider every mutating command refreshes.
 * @returns void
 *
 * @example
 * registerVariablesCommands(context, variablesViewProvider);
 */
export function registerVariablesCommands(context: vscode.ExtensionContext, provider: VariablesViewProvider): void {
    const [
        newFileId, newSubSetId, addVarId, editValueId,
        renameVarId, renameSubSetId, deleteVarId, deleteSubSetId, deleteFileId,
    ] = buildVariableCommandIds();

    context.subscriptions.push(
        vscode.commands.registerCommand(newFileId, () => handleNewFile(
            provider, defaultIO, getVaultRootUri(),
            uri => openVariablesFileInForm(uri, provider, context.extensionUri),
        )),
        vscode.commands.registerCommand(OPEN_FILE_COMMAND_ID, (node?: VariableNode) =>
            handleOpenFile(node, provider, context.extensionUri)),
        vscode.commands.registerCommand(newSubSetId, (node?: VariableNode) => handleNewSubSet(node, provider)),
        vscode.commands.registerCommand(addVarId, (node?: VariableNode) => handleAddVar(node, provider)),
        vscode.commands.registerCommand(editValueId, (node?: VariableNode) => handleEditValue(node, provider)),
        vscode.commands.registerCommand(renameVarId, (node?: VariableNode) => handleRenameVar(node, provider)),
        vscode.commands.registerCommand(renameSubSetId, (node?: VariableNode) => handleRenameSubSet(node, provider)),
        vscode.commands.registerCommand(deleteVarId, (node?: VariableNode) => handleDeleteVar(node, provider)),
        vscode.commands.registerCommand(deleteSubSetId, (node?: VariableNode) => handleDeleteSubSet(node, provider)),
        vscode.commands.registerCommand(deleteFileId, (node?: VariableNode) => handleDeleteFile(node, provider)),
    );
}

export { buildVariableCommandIds };
