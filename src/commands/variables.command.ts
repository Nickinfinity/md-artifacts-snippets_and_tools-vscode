import * as vscode from 'vscode';
import { getVaultRootUri } from '../services/config.service.js';
import { getEntry } from '../services/artifact-type-config.service.js';
import { validateArtifactFilename, deriveFileName } from '../services/filename.service.js';
import { writeArtifact } from '../services/artifact-writer.service.js';
import { renderVariablesFile } from '../services/variables-writer.service.js';
import { parseArtifactFile } from '../services/parser.service.js';
import { openVarsEditForm } from './open-vars-edit.helpers.js';
import {
    addVar, renameVar, setVarValue, deleteVar,
    addSubSet, renameSubSet, deleteSubSet,
} from '../services/variables-crud.service.js';
import { subSetLabel } from '../services/varset.service.js';
import type { ArtifactFormModel } from '../types/artifact-form.types.js';
import type { VariableNode, VariablesViewProvider } from '../ui/views/variablesView.provider.js';
import {
    buildVariableCommandIds, resolveTarget, commitWrite, buildConfirmMessage, errMessage, at,
    OPEN_FILE_COMMAND_ID, type CommandIO, type ResolvedTarget, defaultIO,
} from './variables.command.helpers.js';
import { promptVarName } from './var-name-prompt.helpers.js';

/**
 * The nine `md-artifacts.variables.*` tree commands (T16, VSX-219).
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

    const fileName = deriveFileName(title);
    const check = validateArtifactFilename(fileName);
    if (!check.ok) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', check.reason ?? 'invalid file name'));
        return;
    }

    // Seeded with one placeholder row, not empty: the form renders the pairs it
    // was opened with and has no add-row affordance, so an empty file opens as a
    // table with nothing to edit and no way to add anything.
    const model: ArtifactFormModel = {
        artifactType: 'Variables', title, description: '', tags: [],
        blocks: [{
            heading: '', description: '', language: '', code: '',
            vars: [{ name: 'VK-name', defaultValue: '' }],
        }],
    };
    const chosenDir = vscode.Uri.joinPath(vaultRoot, getEntry('Variables').dir);
    const result = await writeArtifact({
        vaultRoot, type: 'Variables', chosenDir, fileName, content: renderVariablesFile(model), force: false,
    });

    if (result.kind === 'success') {
        provider.refresh();
        // Creating a set and then leaving the user in the tree is a dead end —
        // open the file that was just written so the values can be filled in.
        if (openForm) { await openForm(vscode.Uri.joinPath(chosenDir, `${fileName}.md`)); }
        return;
    }
    const message = result.kind === 'collision' ? vscode.l10n.t('"{0}.md" already exists.', fileName) : result.message;
    io.showError(vscode.l10n.t('MD Artifacts: {0}', message));
}

// ── New sub-set (target: file) ─────────────────────────────────────────────

/**
 * Adds a new, empty sub-set to the clicked file — the inline `+` on a
 * sub-sets file, right-click on a one-block file (whose untitled block is
 * then named by `addSubSet`), and Add… → Sub-set on a blank one. When the set holds no
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

    const taken = new Set(target.model.blocks.map(b => b.heading));
    const noVars = target.subSets.every(s => s.vars.length === 0);
    const heading = await io.showInputBox({
        prompt: vscode.l10n.t('New sub-set heading'),
        value: noVars ? target.parsed.frontmatter.title || target.parsed.fileName : '',
        validateInput: text => text !== '' && taken.has(text) ? vscode.l10n.t('Sub-set "{0}" already exists.', text) : undefined,
    });
    if (heading === undefined) { return; }

    try {
        const newModel = addSubSet(target.model, heading);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
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
    // A blank file has no block yet: its first variable makes it a one-block
    // file, so the model gets one untitled block to receive it.
    if (target.model.blocks.length === 0) {
        const untitled = { heading: '', description: '', language: '', code: '', vars: [] };
        await addVarAt({ ...target, model: { ...target.model, blocks: [untitled] } }, 0, provider, io);
        return;
    }
    if (!at(target.subSets, target.subIdx)) {
        io.showError(vscode.l10n.t('MD Artifacts: sub-set not found — refresh the tree and retry.'));
        return;
    }

    await addVarAt(target, target.subIdx ?? -1, provider, io);
}

/**
 * Prompts for a variable (name, then value) and adds it to block `index` of
 * the target's model. Shared by Add variable and the blank file's Add… →
 * Variable, which passes a model it has just given an untitled block.
 *
 * @param target   - Resolved file, whose `model` is the one mutated.
 * @param index    - Block index in `target.model` — the clicked row's position.
 * @param provider - Tree provider to refresh on success.
 * @param io       - Interaction bag.
 * @returns Resolves once written, cancelled, or refused (toast shown).
 *
 * @example
 * await addVarAt(target, 0, provider, io);
 */
export async function addVarAt(
    target: ResolvedTarget,
    index: number,
    provider: VariablesViewProvider,
    io: CommandIO,
): Promise<void> {
    const name = await promptVarName(io, vscode.l10n.t('Variable name'));
    if (name === undefined) { return; }
    const value = await io.showInputBox({ prompt: vscode.l10n.t('Default value for {0}', name) });
    if (value === undefined) { return; }

    try {
        const newModel = addVar(target.model, index, name, value);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
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
        io.showError(vscode.l10n.t('MD Artifacts: variable not found — refresh the tree and retry.'));
        return;
    }

    const value = await io.showInputBox({ prompt: vscode.l10n.t('New value for {0}', current.name), value: current.defaultValue });
    if (value === undefined || value === current.defaultValue) { return; }

    try {
        const newModel = setVarValue(target.model, target.subIdx ?? -1, current.name, value);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
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
        io.showError(vscode.l10n.t('MD Artifacts: variable not found — refresh the tree and retry.'));
        return;
    }

    const newName = await promptVarName(io, vscode.l10n.t('New variable name'), current.name);
    if (newName === undefined || newName === current.name) { return; }

    try {
        const newModel = renameVar(target.model, target.subIdx ?? -1, current.name, newName);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
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
        io.showError(vscode.l10n.t('MD Artifacts: sub-set not found — refresh the tree and retry.'));
        return;
    }

    const newHeading = await io.showInputBox({ prompt: vscode.l10n.t('New sub-set heading'), value: subSet.heading });
    if (newHeading === undefined || newHeading === subSet.heading) { return; }

    try {
        const newModel = renameSubSet(target.model, target.subIdx ?? -1, newHeading);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
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
        io.showError(vscode.l10n.t('MD Artifacts: variable not found — refresh the tree and retry.'));
        return;
    }

    const message = buildConfirmMessage({ kind: 'var', name: current.name, parent: subSetLabel(subSet) });
    if (!await io.confirm(message)) { return; }

    try {
        const newModel = deleteVar(target.model, target.subIdx ?? -1, current.name);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
    }
}

// ── Delete sub-set (target: subset, destructive) ────────────────────────────

/**
 * Deletes the clicked sub-set after modal confirmation — including a file's
 * last one (reached through the `fileSingle` row), which leaves the file with
 * no variables. Cancel, Escape, or decline perform zero writes.
 *
 * @param node      - Clicked `subset` (or `fileSingle`) tree node.
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
        io.showError(vscode.l10n.t('MD Artifacts: sub-set not found — refresh the tree and retry.'));
        return;
    }

    const message = buildConfirmMessage({
        kind: 'subset', name: subSetLabel(subSet), varCount: subSet.vars.length, parent: target.parsed.relativePath,
    });
    if (!await io.confirm(message)) { return; }

    try {
        const newModel = deleteSubSet(target.model, target.subIdx ?? -1);
        await commitWrite(target.vaultRoot, target.filePath, newModel, provider, io);
    } catch (err) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
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
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(err)));
    }
}

// ── Registration ──────────────────────────────────────────────────────────

/**
 * Registers the nine `md-artifacts.variables.*` commands.
 *
 * @param context  - Extension context used to register the disposable subscriptions.
 * @param provider - The Variables tree provider every mutating command refreshes.
 * @returns void
 *
 * @example
 * // Called once inside activate():
 * registerVariablesCommands(context, variablesViewProvider);
 */
/**
 * Opens a Variables file in the var-set form's edit mode, by path.
 *
 * The pane's route into the form — used both by a file-node click and by
 * `handleNewFile` right after it writes. Parses the file here because the tree
 * carries paths, not parsed artifacts, and routes through the one shared
 * `openVarsEditForm` so the callback bag is not built a second time.
 *
 * @param fileUri  - The `.md` to open.
 * @param provider - Tree provider, refreshed after a successful save.
 * @param extensionUri - Extension root, for the webview's `localResourceRoots`.
 * @returns Resolves once the panel is open, or immediately when the file cannot be parsed.
 *
 * @example
 * await openVariablesFileInForm(uri, provider, context.extensionUri);
 */
export async function openVariablesFileInForm(
    fileUri: vscode.Uri,
    provider: VariablesViewProvider,
    extensionUri: vscode.Uri,
    io: CommandIO = defaultIO,
): Promise<void> {
    let parsed;
    try {
        parsed = parseArtifactFile(fileUri.fsPath, vscode.Uri.joinPath(fileUri, '..').fsPath);
    } catch (e) {
        io.showError(vscode.l10n.t('MD Artifacts: {0}', errMessage(e)));
        return;
    }
    if (!parsed) {
        io.showError(vscode.l10n.t('MD Artifacts: could not read "{0}".', fileUri.fsPath));
        return;
    }
    await openVarsEditForm(parsed, extensionUri, () => provider.refresh());
}

/**
 * Opens the clicked `file` tree node in the var-set form's edit mode.
 *
 * Reuses `resolveTarget` so the node→path resolution and its containment check
 * are the shared ones, then hands the parsed file to `openVarsEditForm`.
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
    await openVariablesFileInForm(vscode.Uri.file(target.filePath), provider, extensionUri, io);
}

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
