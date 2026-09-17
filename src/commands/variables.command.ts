import * as vscode from 'vscode';
import { getVaultRootUri } from '../services/config.service.js';
import { getEntry } from '../services/artifact-type-config.service.js';
import { validateArtifactFilename, deriveFileName } from '../services/filename.service.js';
import { writeArtifact } from '../services/artifact-writer.service.js';
import { renderVariablesFile } from '../services/variables-writer.service.js';
import {
    addVar, renameVar, setVarValue, deleteVar,
    addSubSet, renameSubSet, deleteSubSet,
} from '../services/variables-crud.service.js';
import type { ArtifactFormModel } from '../types/artifact-form.types.js';
import type { VariableNode, VariablesViewProvider } from '../ui/views/variablesView.provider.js';
import {
    buildVariableCommandIds, resolveTarget, commitWrite, buildConfirmMessage, errMessage, at,
    type CommandIO, defaultIO,
} from './variables.command.helpers.js';

/**
 * The nine `obsidian-artifacts.variables.*` tree commands (T16, VSX-219).
 *
 * Each handler resolves its target from the clicked tree node
 * (`resolveTarget`, `variables.command.helpers.ts`) — never from "the active
 * or selected thing" — mutates through a T14 pure mutator, writes through
 * T15's `writeVariablesFile`/`writeArtifact`, and refreshes the T13 tree.
 *
 * Two things are injected rather than reached for globally, both defaulted
 * so `registerVariablesCommands` (real usage) never has to pass them, while
 * a test can:
 *  - `io` — user interaction (`showInputBox`/confirm/error toast), default
 *    the real `vscode.window`-backed `CommandIO`.
 *  - `vaultRoot` — default `getVaultRootUri()` (the process-wide configured
 *    vault), evaluated fresh per call since it is a default parameter, not a
 *    module-level constant. Matches how every writer in this codebase
 *    (`writeArtifact`, `writeVariablesFile`) already takes `vaultRoot`
 *    explicitly rather than re-reading global config internally — the only
 *    thing that lets a test point a handler at a temp-directory vault.
 *
 * `variables.command.ts` itself stays thin wiring; the node-id parsing,
 * `ParsedArtifactFile` → `ArtifactFormModel` conversion, and write/confirm
 * plumbing all live in the sibling helpers file (`CLAUDE.md`'s ~400-line
 * ceiling does not fit nine handlers plus that plumbing in one file).
 */

// ── New file (no node — invoked from the view's title bar) ────────────────

/**
 * Creates a new, empty `artifactType: Variables` file in the vault's
 * `Variables/` directory.
 *
 * Uses `writeArtifact` directly with `force: false` — unlike every other
 * handler here, this is a **create**, not an edit, so an existing file with
 * the same derived name must not be silently overwritten (`writeVariablesFile`
 * is documented as the edit-only, `force: true` path).
 *
 * @param provider  - Tree provider to refresh on success.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot - Vault root; defaults to `getVaultRootUri()`.
 * @returns void
 *
 * @example
 * await handleNewFile(provider);
 */
export async function handleNewFile(
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
): Promise<void> {
    if (!vaultRoot) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: no vault configured.'));
        return;
    }
    const title = await io.showInputBox({
        prompt: vscode.l10n.t('Title for the new Variables file'),
        validateInput: v => v.trim().length > 0 ? undefined : vscode.l10n.t('Title cannot be empty'),
    });
    if (title === undefined) { return; }

    const fileName = deriveFileName(title);
    const check = validateArtifactFilename(fileName);
    if (!check.ok) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', check.reason ?? 'invalid file name'));
        return;
    }

    const model: ArtifactFormModel = {
        artifactType: 'Variables', title, description: '', tags: [],
        blocks: [{ heading: '', description: '', language: '', code: '', vars: [] }],
    };
    const chosenDir = vscode.Uri.joinPath(vaultRoot, getEntry('Variables').dir);
    const result = await writeArtifact({
        vaultRoot, type: 'Variables', chosenDir, fileName, content: renderVariablesFile(model), force: false,
    });

    if (result.kind === 'success') { provider.refresh(); return; }
    const message = result.kind === 'collision' ? vscode.l10n.t('"{0}.md" already exists.', fileName) : result.message;
    io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', message));
}

// ── New sub-set (target: file) ─────────────────────────────────────────────

/**
 * Adds a new, empty sub-set to the clicked file.
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

    const heading = await io.showInputBox({ prompt: vscode.l10n.t('New sub-set heading') });
    if (heading === undefined) { return; }

    try {
        const newModel = addSubSet(target.model, heading);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', errMessage(err)));
    }
}

// ── Add variable (target: subset) ──────────────────────────────────────────

/**
 * Adds a new variable to the clicked sub-set.
 *
 * @param node      - Clicked `subset` tree node.
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
    const subSet = at(target.subSets, target.subIdx);
    if (!subSet) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: sub-set not found — refresh the tree and retry.'));
        return;
    }

    const name = await io.showInputBox({ prompt: vscode.l10n.t('Variable name'), value: 'VK-' });
    if (name === undefined) { return; }
    const value = await io.showInputBox({ prompt: vscode.l10n.t('Default value for {0}', name) });
    if (value === undefined) { return; }

    try {
        const newModel = addVar(target.model, subSet.heading, name, value);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', errMessage(err)));
    }
}

// ── Edit value (target: var) ───────────────────────────────────────────────

/**
 * Edits the clicked variable's default value. A no-op (unchanged value, or
 * Cancel/Escape) performs zero writes.
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
    const target = await resolveTarget(node, 'var', vaultRoot, io);
    if (!target) { return; }
    const subSet = at(target.subSets, target.subIdx);
    const current = at(subSet?.vars ?? [], target.varIdx);
    if (!subSet || !current) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: variable not found — refresh the tree and retry.'));
        return;
    }

    const value = await io.showInputBox({ prompt: vscode.l10n.t('New value for {0}', current.name), value: current.defaultValue });
    if (value === undefined || value === current.defaultValue) { return; }

    try {
        const newModel = setVarValue(target.model, subSet.heading, current.name, value);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', errMessage(err)));
    }
}

// ── Rename variable (target: var) ──────────────────────────────────────────

/**
 * Renames the clicked variable, preserving its value. A no-op (unchanged
 * name, or Cancel/Escape) performs zero writes.
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
    const target = await resolveTarget(node, 'var', vaultRoot, io);
    if (!target) { return; }
    const subSet = at(target.subSets, target.subIdx);
    const current = at(subSet?.vars ?? [], target.varIdx);
    if (!subSet || !current) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: variable not found — refresh the tree and retry.'));
        return;
    }

    const newName = await io.showInputBox({ prompt: vscode.l10n.t('New variable name'), value: current.name });
    if (newName === undefined || newName === current.name) { return; }

    try {
        const newModel = renameVar(target.model, subSet.heading, current.name, newName);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', errMessage(err)));
    }
}

// ── Rename sub-set (target: subset) ────────────────────────────────────────

/**
 * Renames the clicked sub-set's heading. A no-op (unchanged heading, or
 * Cancel/Escape) performs zero writes.
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
    if (!subSet) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: sub-set not found — refresh the tree and retry.'));
        return;
    }

    const newHeading = await io.showInputBox({ prompt: vscode.l10n.t('New sub-set heading'), value: subSet.heading });
    if (newHeading === undefined || newHeading === subSet.heading) { return; }

    try {
        const newModel = renameSubSet(target.model, subSet.heading, newHeading);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', errMessage(err)));
    }
}

// ── Delete variable (target: var, destructive) ─────────────────────────────

/**
 * Deletes the clicked variable after modal confirmation. Cancel, Escape, or
 * declining the confirmation performs zero writes.
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
    const target = await resolveTarget(node, 'var', vaultRoot, io);
    if (!target) { return; }
    const subSet = at(target.subSets, target.subIdx);
    const current = at(subSet?.vars ?? [], target.varIdx);
    if (!subSet || !current) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: variable not found — refresh the tree and retry.'));
        return;
    }

    const message = buildConfirmMessage({ kind: 'var', name: current.name, parent: subSet.heading });
    if (!await io.confirm(message)) { return; }

    try {
        const newModel = deleteVar(target.model, subSet.heading, current.name);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', errMessage(err)));
    }
}

// ── Delete sub-set (target: subset, destructive) ────────────────────────────

/**
 * Deletes the clicked sub-set after modal confirmation. Refuses (via the
 * mutator's own thrown error, caught here) to delete a file's last sub-set —
 * delete the file instead. Cancel, Escape, decline, or the refusal all
 * perform zero writes.
 *
 * @param node      - Clicked `subset` tree node.
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
    if (!subSet) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: sub-set not found — refresh the tree and retry.'));
        return;
    }

    const message = buildConfirmMessage({
        kind: 'subset', name: subSet.heading, varCount: subSet.vars.length, parent: target.parsed.relativePath,
    });
    if (!await io.confirm(message)) { return; }

    try {
        const newModel = deleteSubSet(target.model, subSet.heading);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', errMessage(err)));
    }
}

// ── Delete file (target: file, destructive) ─────────────────────────────────

/**
 * Deletes the clicked Variables file after modal confirmation. Cancel,
 * Escape, or declining the confirmation performs no deletion.
 *
 * Plain `vscode.workspace.fs.delete(uri)` — no `useTrash`, matching this
 * codebase's one other file-deletion call site (`scratch-file.service.ts`);
 * OS trash support is environment-dependent and not something any existing
 * code here relies on.
 *
 * Resolves through `resolveTarget` like every other handler — rather than
 * reading `node.id`/`node.label` directly — specifically to get the
 * vault-relative path and the file's total variable count for the
 * confirmation message: the tree's `file` label is `title || fileName`
 * (`variablesView.provider.ts`), which reads as a *title*, not a file, so
 * passing it into the modal would say "Delete Local Dev…" for a file named
 * `dev.md` — the confirmation must name the file, not its title.
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
    const message = buildConfirmMessage({ kind: 'file', name: target.parsed.relativePath, varCount });
    if (!await io.confirm(message)) { return; }

    try {
        await vscode.workspace.fs.delete(vscode.Uri.file(target.filePath));
        provider.refresh();
    } catch (err) {
        io.showError(vscode.l10n.t('Obsidian Artifacts: {0}', errMessage(err)));
    }
}

// ── Registration ──────────────────────────────────────────────────────────

/**
 * Registers the nine `obsidian-artifacts.variables.*` commands.
 *
 * @param context  - Extension context used to register the disposable subscriptions.
 * @param provider - The Variables tree provider every mutating command refreshes.
 * @returns void
 *
 * @example
 * // Called once inside activate():
 * registerVariablesCommands(context, variablesViewProvider);
 */
export function registerVariablesCommands(context: vscode.ExtensionContext, provider: VariablesViewProvider): void {
    const [
        newFileId, newSubSetId, addVarId, editValueId,
        renameVarId, renameSubSetId, deleteVarId, deleteSubSetId, deleteFileId,
    ] = buildVariableCommandIds();

    context.subscriptions.push(
        vscode.commands.registerCommand(newFileId, () => handleNewFile(provider)),
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
