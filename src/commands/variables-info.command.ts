import * as vscode from 'vscode';
import { getVaultRootUri } from '../services/config.service.js';
import { getVarsFileShape } from '../services/varset.service.js';
import { openInfoPanel } from '../ui/panels/infoPanel/infoPanel.js';
import { VIEW_INFO_COMMAND_ID, resolveTarget, defaultIO, type CommandIO, type ResolvedTarget } from './variables.command.helpers.js';
import type { InfoField, InfoModel, InfoSection } from '../types/info.types.js';
import type { ParsedVar } from '../types/parsed-artifact.types.js';
import type { VariableNode } from '../ui/views/variablesView.provider.js';

/** Variables as `name: value` info lines, in file order. */
function varFields(vars: readonly ParsedVar[]): InfoField[] {
    return vars.map(v => ({ label: v.name, value: v.defaultValue, mono: true }));
}

/**
 * Builds the View Info model for a Variables-pane row — the Variables adapter
 * for the artifact-agnostic info popup (`types/info.types.ts`).
 *
 * - a **set** (file row): description, tags, its shape and counts, then one
 *   section per sub-set (or one "Variables" section for a one-block file);
 * - a **sub-set**: its description, the set it belongs to, its variables;
 * - a **variable**: its value, sub-set and set.
 *
 * @param target - The resolved row (`resolveTarget`).
 * @param kind   - Which kind of row was clicked.
 * @returns The model `openInfoPanel` renders.
 *
 * @example
 * buildVariablesInfo(target, 'subset').kind // → 'Sub-set'
 */
export function buildVariablesInfo(target: ResolvedTarget, kind: VariableNode['kind']): InfoModel {
    const { model, parsed } = target;
    const setTitle = model.title;
    const path = parsed.relativePath;
    const noName = vscode.l10n.t('(no name)');
    const allVars = model.blocks.reduce((n, b) => n + b.vars.length, 0);

    if (kind === 'file') {
        const shape = getVarsFileShape(parsed);
        const shapeLabel = shape === 'blank' ? vscode.l10n.t('Empty')
            : shape === 'flat' ? vscode.l10n.t('One list of variables, no sub-sets')
            : vscode.l10n.t('Named groups of variables');
        const fields: InfoField[] = [{ label: vscode.l10n.t('Structure'), value: shapeLabel }];
        if (shape === 'sets') { fields.push({ label: vscode.l10n.t('Sub-sets'), value: String(model.blocks.length) }); }
        fields.push({ label: vscode.l10n.t('Variables'), value: String(allVars) });
        if (model.env) { fields.push({ label: vscode.l10n.t('Environment'), value: model.env }); }
        const empty = vscode.l10n.t('No variables yet.');
        const sections: InfoSection[] = shape === 'sets'
            ? model.blocks.map(b => ({ heading: b.heading || noName, description: b.description || undefined, fields: varFields(b.vars), emptyText: empty }))
            : model.blocks.map(b => ({ heading: vscode.l10n.t('Variables'), fields: varFields(b.vars), emptyText: empty }));
        return { kind: vscode.l10n.t('Variable set'), title: setTitle, description: model.description || undefined, tags: model.tags, fields, sections, path };
    }

    const block = model.blocks[target.subIdx ?? -1];
    if (kind === 'subset') {
        return {
            kind: vscode.l10n.t('Sub-set'),
            title: block?.heading || noName,
            description: block?.description || undefined,
            tags: model.tags,
            fields: [
                { label: vscode.l10n.t('Variable set'), value: setTitle },
                { label: vscode.l10n.t('Variables'), value: String(block?.vars.length ?? 0) },
            ],
            sections: [{ heading: vscode.l10n.t('Variables'), fields: varFields(block?.vars ?? []), emptyText: vscode.l10n.t('No variables yet.') }],
            path,
        };
    }

    const v = block?.vars[target.varIdx ?? -1];
    const fields: InfoField[] = [{ label: vscode.l10n.t('Value'), value: v?.defaultValue ?? '', mono: true }];
    if (block?.heading) { fields.push({ label: vscode.l10n.t('Sub-set'), value: block.heading }); }
    fields.push({ label: vscode.l10n.t('Variable set'), value: setTitle });
    return {
        kind: vscode.l10n.t('Variable'),
        title: v?.name ?? '',
        description: block?.description || undefined,
        tags: model.tags,
        fields,
        sections: [],
        path,
    };
}

/**
 * "View Info" on any Variables-pane row: opens (or updates) the read-only
 * summary popup beside the editor.
 *
 * @param node         - Clicked row.
 * @param extensionUri - Extension root, for the popup's assets.
 * @param io           - Interaction bag; defaults to the real `vscode.window`-backed one.
 * @param vaultRoot    - Vault root; defaults to `getVaultRootUri()`.
 * @param open         - Popup opener; injectable so a test can capture the model.
 * @returns Resolves once the popup shows, or immediately when the row cannot be resolved.
 *
 * @example
 * await handleViewInfo(node, context.extensionUri);
 */
export async function handleViewInfo(
    node: VariableNode | undefined,
    extensionUri: vscode.Uri,
    io: CommandIO = defaultIO,
    vaultRoot: vscode.Uri | undefined = getVaultRootUri(),
    open: (uri: vscode.Uri, model: InfoModel) => void = openInfoPanel,
): Promise<void> {
    const kind = node?.kind ?? 'file';
    const target = await resolveTarget(node, kind, vaultRoot, io);
    if (!target) { return; }
    open(extensionUri, buildVariablesInfo(target, kind));
}

/**
 * Registers the Variables pane's View Info command.
 *
 * @param context - Extension context, for disposal and the extension URI.
 * @returns Nothing.
 *
 * @example
 * registerVariablesInfoCommand(context);
 */
export function registerVariablesInfoCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand(
        VIEW_INFO_COMMAND_ID, (node?: VariableNode) => handleViewInfo(node, context.extensionUri)));
}
