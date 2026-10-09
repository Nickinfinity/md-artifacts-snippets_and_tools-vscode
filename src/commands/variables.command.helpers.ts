import * as path from 'node:path';
import * as vscode from 'vscode';
import { getEntry } from '../services/artifact-type-config.service.js';
import { parseArtifactFile } from '../services/parser.service.js';
import { extractSubSets, getVarsFileShape } from '../services/varset.service.js';
import { writeVariablesFile } from '../services/variables-writer.service.js';
import type { WriteResult } from '../services/artifact-writer.service.js';
import type { VarSubSet } from '../types/varset.types.js';
import type { ParsedArtifactFile, ParsedVar } from '../types/parsed-artifact.types.js';
import type { ArtifactFormModel, ArtifactFormBlock } from '../types/artifact-form.types.js';
import type { VariableNode, VariableNodeKind, VariablesViewProvider } from '../ui/views/variablesView.provider.js';
import { isPathWithin } from '../utils/path-containment.js';
import { confirmTextFor } from './variables.confirm.helpers.js';

/**
 * Pure/light-vscode helpers for `variables.command.ts` (T16, VSX-219) and
 * `variables-apply.command.ts` (T1.3, VSX-246).
 *
 * Split out under `CLAUDE.md`'s file-size rule: nine-plus command handlers
 * module owns node-id parsing, the `ParsedArtifactFile` → `ArtifactFormModel`
 * conversion (deliberately **here**, not in a service — see the type's own
 * doc comment), and the resolve/write/confirm plumbing every handler shares.
 * `variables.command.ts` stays the thin `registerCommand` wiring layer.
 */

/**
 * Suffixes appended to `md-artifacts.variables.` for the contributed
 * commands. The first nine are already present in `package.json`
 * (orchestrator-only — read, never edited here); `applyToPreview` and
 * `saveCurrentValues` (T1.3, VSX-246) are new and land in `package.json`
 * separately (H1.1). One declaration; `buildVariableCommandIds` derives from
 * it so the id list is never hand-copied a second time.
 */
const VARIABLE_COMMAND_SUFFIXES = [
    'newFile', 'newSubSet', 'addVar', 'editValue',
    'renameVar', 'renameSubSet', 'deleteVar', 'deleteSubSet', 'deleteFile',
    'applyToPreview', 'applyToEditor', 'saveCurrentValues', 'openFile', 'search', 'clearSearch',
    'addToBlank', 'editDescription', 'editTags', 'viewInfo',
] as const;

/**
 * Derives one fully-qualified `md-artifacts.variables.*` command id
 * from its suffix — the one place `'md-artifacts.variables.'` is
 * spelled as a prefix, so `buildVariableCommandIds` and any single-id
 * constant agree by construction.
 *
 * @param suffix - One of `VARIABLE_COMMAND_SUFFIXES`.
 * @returns The fully-qualified command id.
 *
 * @example
 * variableCommandId('applyToPreview') // → 'md-artifacts.variables.applyToPreview'
 */
function variableCommandId(suffix: typeof VARIABLE_COMMAND_SUFFIXES[number]): string {
    return `md-artifacts.variables.${suffix}`;
}

/**
 * Derives the `md-artifacts.variables.*` command ids.
 *
 * @returns The fully-qualified command ids, in `VARIABLE_COMMAND_SUFFIXES` order.
 *
 * @example
 * buildVariableCommandIds() // → ['md-artifacts.variables.newFile', ...]
 */
export function buildVariableCommandIds(): string[] {
    return VARIABLE_COMMAND_SUFFIXES.map(variableCommandId);
}

/** Command id for "Open Variable Set" — the pane's route into the edit form. */
export const OPEN_FILE_COMMAND_ID = variableCommandId('openFile');
/** Command id for "Apply Variable Set to Preview" (T1.3). */
export const APPLY_TO_PREVIEW_COMMAND_ID = variableCommandId('applyToPreview');
/** Command id for "Save Preview Values as Variable Set" (T1.3). */
export const SAVE_CURRENT_VALUES_COMMAND_ID = variableCommandId('saveCurrentValues');
/** Command id for "Fill Variables in Editor" — fills `<VK-xxx>` tokens in the active editor. */
export const APPLY_TO_EDITOR_COMMAND_ID = variableCommandId('applyToEditor');
/** Command id for "Search Variable Sets" — live filter over the Variables tree. */
export const SEARCH_COMMAND_ID = variableCommandId('search');
/** Command id for "Clear Search" — shown only while a filter is active. */
export const CLEAR_SEARCH_COMMAND_ID = variableCommandId('clearSearch');

/** "Add…" on a blank file row — asks Variable (one block, no sub-sets) or Sub-set. */
export const ADD_TO_BLANK_COMMAND_ID = variableCommandId('addToBlank');

/** "Edit Description…" — a file's frontmatter description, or a sub-set's prose. */
export const EDIT_DESCRIPTION_COMMAND_ID = variableCommandId('editDescription');

/** "Edit Tags…" — a file's frontmatter tags, as a comma-separated list. */
export const EDIT_TAGS_COMMAND_ID = variableCommandId('editTags');

/** "View Info" — the read-only summary popup for a set, sub-set or variable. */
export const VIEW_INFO_COMMAND_ID = variableCommandId('viewInfo');

/**
 * Extracts the absolute file path a `VariableNode` belongs to.
 *
 * `VariableNode.id` is documented as `<filePath>` for a `file` node, or
 * `<filePath>::subset:<i>[::var:<j>]` for its descendants — see
 * `VariableNode`'s own JSDoc. Splits on the first `::subset:` marker rather
 * than parsing a full id grammar, since a real OS path never contains that
 * literal substring.
 *
 * @param node - Tree node passed back from a `view/item/context` command.
 * @returns The absolute `.md` file path the node belongs to.
 *
 * @example
 * fileNodePath({ id: '/vault/Variables/a.md::subset:0::var:1', ... }) // → '/vault/Variables/a.md'
 */
export function fileNodePath(node: VariableNode): string {
    const markerIndex = node.id.indexOf('::subset:');
    return markerIndex === -1 ? node.id : node.id.slice(0, markerIndex);
}

const SUBSET_INDEX_RE = /::subset:(\d+)/;
const VAR_INDEX_RE = /::var:(\d+)$/;

/**
 * Extracts the sub-set ordinal (index into `extractSubSets(file)`) encoded
 * in a `subset` or `var` node's id.
 *
 * @param node - Tree node.
 * @returns The sub-set index, or `undefined` for a `file` node's id.
 *
 * @example
 * subsetIndex({ id: '/a.md::subset:2', ... }) // → 2
 */
export function subsetIndex(node: VariableNode): number | undefined {
    const match = SUBSET_INDEX_RE.exec(node.id);
    return match ? Number(match[1]) : undefined;
}

/**
 * Extracts the var ordinal (index into a sub-set's `vars`) encoded in a
 * `var` node's id.
 *
 * @param node - Tree node.
 * @returns The var index, or `undefined` for a `file`/`subset` node's id.
 *
 * @example
 * varIndex({ id: '/a.md::subset:0::var:3', ... }) // → 3
 */
export function varIndex(node: VariableNode): number | undefined {
    const match = VAR_INDEX_RE.exec(node.id);
    return match ? Number(match[1]) : undefined;
}

/**
 * Safe array-by-optional-index lookup — `arr[i]` is a compile error when `i`
 * is `number | undefined`, and every node-id index above is exactly that.
 *
 * @param arr - Array to index into.
 * @param i   - Index, or `undefined`.
 * @returns `arr[i]`, or `undefined` when `i` is `undefined` or out of range.
 *
 * @example
 * at(['a', 'b'], 1)         // → 'b'
 * at(['a', 'b'], undefined) // → undefined
 */
export function at<T>(arr: readonly T[], i: number | undefined): T | undefined {
    return i === undefined ? undefined : arr[i];
}

/**
 * Converts a parsed `.md` file into the `ArtifactFormModel` the T14 mutators
 * operate on — **the one place** this conversion happens (plan note #4: read
 * side speaks `ParsedArtifactFile`, write side speaks `ArtifactFormModel`,
 * and the command layer is the sole crossing point).
 *
 * Built per {@link getVarsFileShape}, block-for-block aligned with
 * `extractSubSets(parsed, { includeEmpty: true })` — the list the pane renders
 * — so a row's position is the block's index (handlers pass that index to the
 * mutators, never a heading):
 *
 * - `blank` → no blocks.
 * - `flat`  → one block headed `''`. It must stay untitled: the serializer
 *   writes a `## ` heading for any single block that has one, so the set's
 *   title used to leak in here and every pane edit silently turned a
 *   one-block file into a titled sub-set.
 * - `sets`  → one block per `## ` sub-set.
 *
 * @param parsed - Result of `parseArtifactFile`/`parseFromContent` for an `artifactType: Variables` file.
 * @returns Equivalent `ArtifactFormModel`, ready for the T14 mutators.
 *
 * @example
 * toFormModel(parsed).blocks[0].vars
 */
export function toFormModel(parsed: ParsedArtifactFile): ArtifactFormModel {
    const block = (heading: string, vars: ParsedVar[], description = ''): ArtifactFormBlock =>
        ({ heading, description, language: '', code: '', vars });
    const shape = getVarsFileShape(parsed);
    let blocks: ArtifactFormBlock[] = [];
    if (shape === 'flat') {
        blocks = [block('', parsed.vars)];
    } else if (shape === 'sets') {
        blocks = parsed.blocks.map(b => block(b.heading, b.vars, b.description));
    }

    return {
        artifactType: 'Variables',
        title: parsed.frontmatter.title ?? parsed.fileName,
        description: parsed.frontmatter.description ?? '',
        tags: parsed.frontmatter.tags ?? [],
        // Carried so a pane edit cannot drop the file's `env:` line.
        env: parsed.frontmatter.env,
        blocks,
    };
}

/**
 * The user-interaction primitives every command handler needs,
 * injected rather than called on `vscode.window` directly so a test can
 * drive a handler's full logic (no-op, cancel, escape, confirm/decline)
 * without a live human at the keyboard. `defaultIO` is what
 * `registerVariablesCommands` wires real handlers to; a test passes its own
 * `CommandIO` with canned responses instead.
 */
export interface CommandIO {
    /** Prompts for text; `undefined` on Cancel or Escape — same as `vscode.window.showInputBox`. */
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    /** Shows a modal Delete/Cancel confirmation; `true` only for an explicit **Delete** click. */
    confirm: (message: string) => Promise<boolean>;
    /** Shows an error toast. Fire-and-forget, matching `vscode.window.showErrorMessage`'s own contract. */
    showError: (message: string) => void;
    /** Single-choice pick; `undefined` on Cancel or Escape — same as `vscode.window.showQuickPick`. */
    showQuickPick: <T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions) => Thenable<T | undefined>;
}

/**
 * Real `vscode.window`-backed `CommandIO` — what every handler uses by
 * default. `confirm` resolves `false` for **both** Cancel and Escape
 * (`showWarningMessage`'s documented gotcha — `CLAUDE.md`), so only an exact
 * `'Delete'` match counts as confirmed.
 *
 * @example
 * await defaultIO.confirm('Delete variable VK-host? This cannot be undone.');
 */
export const defaultIO: CommandIO = {
    showInputBox: options => vscode.window.showInputBox(options),
    confirm: async message => {
        const deleteLabel = vscode.l10n.t('Delete');
        const choice = await vscode.window.showWarningMessage(message, { modal: true }, deleteLabel);
        return choice === deleteLabel;
    },
    showError: message => { void vscode.window.showErrorMessage(message); },
    showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
};

/**
 * Builds the app-prefixed confirmation text for a delete, delegating the
 * wording itself to T17's `confirmTextFor` (`variables.confirm.helpers.ts`)
 * — the one authority for what each of the three delete messages says.
 *
 * @param input - Node kind, display name, variable count, and parent —
 * see `ConfirmInput` (`variables.confirm.helpers.ts`) for the per-kind rules.
 * @returns The full message text, ready for `CommandIO.confirm`.
 *
 * @example
 * buildConfirmMessage({ kind: 'var', name: 'VK-host', varCount: 0, parent: 'Dev' })
 * // → 'MD Artifacts: Delete variable VK-host? This cannot be undone.'
 */
export function buildConfirmMessage(input: Parameters<typeof confirmTextFor>[0]): string {
    return vscode.l10n.t('MD Artifacts: {0}', confirmTextFor(input));
}

/** Everything a command handler needs to act on the node the user clicked. */
export interface ResolvedTarget {
    /** Vault root — passed straight through to the writer's containment checks. */
    vaultRoot: vscode.Uri;
    /** Absolute path of the `.md` file the clicked node belongs to. */
    filePath: string;
    /** Freshly re-parsed file — never cached across a mutation (structural-sharing rule). */
    parsed: ParsedArtifactFile;
    /** `toFormModel(parsed)` — ready for a T14 mutator. */
    model: ArtifactFormModel;
    /** `extractSubSets(parsed, { includeEmpty: true })` — same list the tree rendered, so node-id indices apply directly. */
    subSets: VarSubSet[];
    /** Sub-set ordinal from the node's id, when the node is a `subset` or `var`. */
    subIdx?: number;
    /** Var ordinal from the node's id, when the node is a `var`. */
    varIdx?: number;
}

/**
 * Resolves a `view/item/context` node into everything a handler needs,
 * refusing (and toasting) when the node is missing, the wrong kind, or the
 * vault/file cannot be read.
 *
 * Covers the "destructive command invoked with no argument refuses" rule for
 * every command, not only the destructive ones — a palette-invoked or
 * otherwise argument-less call always has `node === undefined` and refuses
 * here before touching disk.
 *
 * `vaultRoot` is a parameter, not read from `vscode.workspace.getConfiguration`
 * in here — matching how every writer in this codebase (`writeArtifact`,
 * `writeVariablesFile`) takes it explicitly rather than re-reading global
 * config, and the only thing that makes this function testable against a
 * temp-directory vault instead of the real, process-wide configured one.
 *
 * @param node         - The tree node VS Code passed to the command, or `undefined`.
 * @param expectedKind - The node kind this command operates on.
 * @param vaultRoot    - Vault root, or `undefined` when none is configured (`getVaultRootUri()`'s own return shape).
 * @param io           - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @returns A `ResolvedTarget`, or `undefined` when the call must refuse (a toast was already shown).
 *
 * @example
 * const target = await resolveTarget(node, 'var', getVaultRootUri());
 * if (!target) { return; }
 */
export async function resolveTarget(
    node: VariableNode | undefined,
    expectedKind: VariableNodeKind,
    vaultRoot: vscode.Uri | undefined,
    io: CommandIO = defaultIO,
): Promise<ResolvedTarget | undefined> {
    // A one-block file shows no sub-set level, so its file node stands in for
    // block 0 — one rule here serves every sub-set command. A blank file stands
    // in for the block its first variable will create (see `handleAddVar`).
    const lone = expectedKind === 'subset' && node?.kind === 'file'
        && (node.shape === 'flat' || node.shape === 'blank');
    if (node?.kind !== expectedKind && !lone) {
        io.showError(vscode.l10n.t('MD Artifacts: no variable-tree item selected.'));
        return undefined;
    }
    if (!vaultRoot) {
        io.showError(vscode.l10n.t('MD Artifacts: no vault configured.'));
        return undefined;
    }
    const filePath = fileNodePath(node);
    const rootDir = vscode.Uri.joinPath(vaultRoot, getEntry('Variables').dir).fsPath;
    if (!isPathWithin(rootDir, filePath)) {
        io.showError(vscode.l10n.t('MD Artifacts: "{0}" is outside the Variables directory.', filePath));
        return undefined;
    }
    const parsed = parseArtifactFile(filePath, rootDir);
    if (!parsed) {
        io.showError(vscode.l10n.t('MD Artifacts: could not read "{0}".', filePath));
        return undefined;
    }
    return {
        vaultRoot,
        filePath,
        parsed,
        model: toFormModel(parsed),
        subSets: extractSubSets(parsed, { includeEmpty: true }),
        subIdx: lone ? 0 : subsetIndex(node),
        varIdx: varIndex(node),
    };
}

/**
 * Writes a mutated model back to its source file, in place — the writer's
 * `chosenDir`/`fileName` are derived from `filePath` itself so an edit never
 * moves or renames the file.
 *
 * @param vaultRoot - Vault root, for the writer's containment checks.
 * @param filePath  - Absolute path of the file being edited.
 * @param model     - Mutated model to render and write.
 * @returns The writer's `WriteResult`.
 *
 * @example
 * await writeBack(vaultRoot, '/vault/Variables/a.md', newModel);
 */
export async function writeBack(vaultRoot: vscode.Uri, filePath: string, model: ArtifactFormModel): Promise<WriteResult> {
    return writeVariablesFile({
        vaultRoot,
        chosenDir: vscode.Uri.file(path.dirname(filePath)),
        fileName: path.basename(filePath, '.md'),
        model,
    });
}

/**
 * Shared write → refresh → report tail for every mutating command: writes
 * the model back, refreshes the tree on success, toasts on failure.
 *
 * @param vaultRoot - Vault root, for the writer's containment checks.
 * @param filePath  - Absolute path of the file being edited.
 * @param model     - Mutated model to write.
 * @param provider  - Tree provider to refresh on a successful write.
 * @param io        - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @returns void
 *
 * @example
 * await commitWrite(vaultRoot, filePath, newModel, provider);
 */
export async function commitWrite(
    vaultRoot: vscode.Uri,
    filePath: string,
    model: ArtifactFormModel,
    provider: VariablesViewProvider,
    io: CommandIO = defaultIO,
): Promise<void> {
    const result = await writeBack(vaultRoot, filePath, model);
    if (result.kind === 'success') {
        provider.refresh();
        return;
    }
    const message = result.kind === 'error' ? result.message : vscode.l10n.t('"{0}" already exists.', filePath);
    io.showError(vscode.l10n.t('MD Artifacts: {0}', message));
}

/**
 * Extracts a display message from a caught value — every T14 mutator throws
 * a plain `Error`, but `catch` bindings are `unknown`.
 *
 * @param err - Caught value.
 * @returns `err.message` when `err` is an `Error`, the string itself when
 * `err` is already a string, else a generic fallback.
 *
 * @example
 * errMessage(new Error('boom')) // → 'boom'
 */
export function errMessage(err: unknown): string {
    if (err instanceof Error) { return err.message; }
    return typeof err === 'string' ? err : 'Unknown error.';
}
