import * as vscode from 'vscode';
import { applyVarSet } from '../../../services/varset.service.js';
import { getEntry } from '../../../services/artifact-type-config.service.js';
import { getVaultRootUri } from '../../../services/config.service.js';
import { writeVariablesFile } from '../../../services/variables-writer.service.js';
import { slugForVarSet, toVarSetModel, validateVarSetForm } from '../../../services/varset-form.service.js';
import type { ParsedArtifactFile, ParsedVar } from '../../../types/parsed-artifact.types.js';
import type { ApplyResult, VarSetFormPayload } from '../../../types/varset.types.js';
import { getVarSetScanner, pickVarSet } from '../varsetPicker.panel.js';
import { openVarSetFormPanel } from '../varsetForm/varsetForm.panel.js';
import { renderVarSetDiffHtml } from './varSetDiff.js';

/** Callbacks the controller uses to push state back to the host preview panel. */
export interface VarSetControllerCallbacks {
    /** Returns the artifact currently shown in the popup (`undefined` between switches). */
    getCurrentArtifact: () => ParsedArtifactFile | undefined;
    /** Posts a message to the popup webview. */
    postMessage: (msg: Record<string, unknown>) => void;
    /** Captures an applied sub-set so the source badge persists across re-renders. */
    rememberAppliedSet: (subSetName: string, varNames: string[]) => void;
}

/**
 * Owns the variable-set message flow inside the preview panel:
 * `pickVarSet`  → QuickPick → diff preview
 * `confirmApply` / `cancelApply` → finalise
 * `saveAsVarSet` → write a new `Variables/<slug>.md` file.
 *
 * Stateless across artifacts — the active sub-set is held only between the
 * QuickPick acceptance and the user's confirm/cancel decision.
 *
 * @example
 * const ctrl = new VarSetController(extensionUri, { getCurrentArtifact, postMessage, rememberAppliedSet });
 * await ctrl.handlePickVarSet({ values: { 'VK-host': '' } });
 */
export class VarSetController {

    /**
     * Pending `ApplyResult` between a sub-set selection and `confirmApply`.
     *
     * Holds the sub-set's **heading only**, not the `VarSubSet`: the Variables
     * pane reaches this flow through `showDiffFor`, and its `PreviewVarTarget`
     * carries no sub-set (a `VarSubSet` requires a `sourceFile` the preview
     * cannot obtain). The heading was the only field ever read here.
     */
    private pending: { heading: string; result: ApplyResult } | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly cb: VarSetControllerCallbacks,
    ) {}

    /**
     * Opens the QuickPick, computes the diff, and posts the diff HTML to the webview.
     *
     * @param msg - Webview payload — must contain `values: Record<string, string>`
     *              with the user's current input map.
     * @returns Resolves once the diff has been posted (or no-op on cancel).
     *
     * @example
     * await ctrl.handlePickVarSet({ values: collectVars() });
     */
    async handlePickVarSet(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }

        const variablesDirUri = getVariablesDirUri();
        if (!variablesDirUri) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Variables directory is not configured. Open the Settings panel to enable it.'));
            return;
        }

        const picked = await pickVarSet(
            artifact.vars,
            artifact.frontmatter.tags ?? [],
            variablesDirUri,
            this.extensionUri,
        );
        if (!picked) { return; }

        const currentValues = (msg.values as Record<string, string> | undefined) ?? {};
        this.showDiffFor(picked.subSet.heading, picked.subSet.vars, currentValues);
    }

    /**
     * Computes the diff and posts it to the webview — the half of the apply
     * flow that has nothing to do with *how* the sub-set was chosen.
     *
     * Split out (W1/H1.4) so the Variables pane can reach the diff step
     * without reimplementing it: `handlePickVarSet` is the QuickPick caller,
     * `PreviewPanelController.applyVarSet` is the pane's caller, and both land
     * here. Synchronous — nothing below awaits.
     *
     * @param heading       - The sub-set's display name, for the diff header and the badge.
     * @param vars          - The sub-set's variables to merge in.
     * @param currentValues - The preview's current input values to diff against.
     * @returns void
     *
     * @example
     * ctrl.showDiffFor('Local Dev', subSet.vars, { 'VK-host': '' });
     */
    showDiffFor(heading: string, vars: readonly ParsedVar[], currentValues: Record<string, string>): void {
        // Spread: `applyVarSet` takes a mutable `ParsedVar[]`, and a
        // `readonly` array will not assign to it.
        const result = applyVarSet(currentValues, [...vars]);
        this.pending = { heading, result };

        this.cb.postMessage({
            command:    'showVarSetDiff',
            html:       renderVarSetDiffHtml(result.changes, heading),
            subSetName: heading,
        });
    }

    /**
     * Finalises the pending apply — pushes merged values + source-badge metadata to the webview.
     *
     * @returns void
     *
     * @example
     * ctrl.handleConfirmApply();
     */
    handleConfirmApply(): void {
        const pending = this.pending;
        if (!pending) { return; }

        const filledOrOverriddenNames = pending.result.changes
            .filter(c => c.action === 'filled' || c.action === 'overridden')
            .map(c => c.name);

        this.cb.rememberAppliedSet(pending.heading, filledOrOverriddenNames);

        this.cb.postMessage({
            command:    'varSetApplied',
            values:     pending.result.values,
            subSetName: pending.heading,
            varNames:   filledOrOverriddenNames,
        });
        this.pending = undefined;
    }

    /**
     * Aborts the pending apply — webview reverts the diff view back to inputs.
     *
     * @returns void
     *
     * @example
     * ctrl.handleCancelApply();
     */
    handleCancelApply(): void {
        this.pending = undefined;
        this.cb.postMessage({ command: 'varSetCancelled' });
    }

    /**
     * Implements the save-as-variable-set flow — prompts for title and description,
     * builds a new `.md` file under `Variables/<slug>.md`, writes it, and invalidates
     * the scanner cache so the next pick run sees the new file.
     *
     * @param msg - Webview payload — must contain `values: Record<string, string>`
     *              with the user's current non-empty input map.
     * @returns Resolves once the file is written or after the user cancels a prompt.
     *
     * @example
     * await ctrl.handleSaveAsVarSet({ values: { 'VK-host': 'localhost' } });
     */
    async handleSaveAsVarSet(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }

        const values = (msg.values as Record<string, string> | undefined) ?? {};
        // The non-empty filter is the form's SEEDING filter, and W2 depends on
        // it staying here. `toVarSetModel` passes `pairs` through verbatim, so
        // a row the user deliberately blanks *in the form* is emitted as
        // `VK-name=` — correct for an editor, but only benign because the form
        // is never seeded with empty rows in the first place.
        const nonEmpty: [string, string][] = Object.entries(values).filter(([, v]) => v.length > 0);
        if (nonEmpty.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No values to save — fill at least one variable first.'));
            return;
        }

        const variablesDirUri = getVariablesDirUri();
        if (!variablesDirUri) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Variables directory is not configured. Open the Settings panel to enable it.'));
            return;
        }

        const vaultRoot = getVaultRootUri();
        if (!vaultRoot) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Variables directory is not configured. Open the Settings panel to enable it.'));
            return;
        }

        openVarSetFormPanel(
            this.extensionUri,
            {
                validate: validateVarSetForm,
                write:    payload => writeVarSetFromForm(payload, vaultRoot, variablesDirUri),
                // `post` and `close` are supplied by the panel itself — it owns
                // the webview and its disposal. These are the inert defaults the
                // panel overrides; see `openVarSetFormPanel`.
                post:  () => { /* replaced by the panel */ },
                close: () => { /* replaced by the panel */ },
            },
            {
                mode:   'create',
                values: Object.fromEntries(nonEmpty),
                tags:   artifact.frontmatter.tags ?? [],
            },
        );
    }
}

/**
 * Writes a validated var-set form payload through the **existing** variables
 * writer, then refreshes the scanner so the Variables tree shows the new file
 * without a window reload.
 *
 * Lives here rather than in `varset-form.service.ts` because it is the wiring
 * between two worker-owned halves (H2.1): the service owns the adapter and the
 * validation, the panel owns the webview, and neither may reach the other. The
 * three steps below sat inline in the old prompt flow and belong to no task.
 *
 * @param payload   - The validated form payload.
 * @param vaultRoot - Vault root, for `writeArtifact`'s containment checks.
 * @param dirUri    - The resolved `<vault>/Variables` directory.
 * @returns Resolves once the file is written and the scanner invalidated.
 *
 * @example
 * await writeVarSetFromForm(payload, vaultRoot, variablesDirUri);
 */
async function writeVarSetFromForm(
    payload: VarSetFormPayload,
    vaultRoot: vscode.Uri,
    dirUri: vscode.Uri,
): Promise<void> {
    const result = await writeVariablesFile({
        vaultRoot,
        chosenDir: dirUri,
        // `writeArtifact` appends `.md` itself — passing it here would write `…md.md`.
        fileName:  slugForVarSet(payload.title),
        model:     toVarSetModel(payload),
    });

    if (result.kind === 'success') {
        // F5 step 4 depends on this: without it the new set is on disk but
        // absent from the Variables tree until the window reloads (D-B).
        getVarSetScanner().invalidate();
        void vscode.window.showInformationMessage(vscode.l10n.t('Variable set saved: {0}', payload.title.trim()));
        return;
    }

    // `collision` is unreachable while `writeVariablesFile` hardcodes
    // `force: true` (recorded W2 debt, upgrade path `force: false` + this arm),
    // but it is handled rather than assumed away so tightening that flag later
    // cannot turn a refused write into a silent no-op.
    const reason = result.kind === 'collision'
        ? vscode.l10n.t('A variable set named "{0}" already exists.', result.filePath)
        : result.message;
    void vscode.window.showErrorMessage(vscode.l10n.t('Failed to save variable set: {0}', reason));
}

// ── Module helpers ────────────────────────────────────────────────────────────

/**
 * Resolves the configured `<vault>/Variables` directory URI from VS Code settings.
 *
 * @returns The directory URI, or `null` when `obsidianArtifacts.vaultPath` is unset.
 *
 * @example
 * const dir = getVariablesDirUri();
 */
export function getVariablesDirUri(): vscode.Uri | null {
    const vaultRoot = getVaultRootUri();
    if (!vaultRoot) { return null; }
    return vscode.Uri.joinPath(vaultRoot, getEntry('Variables').dir);
}

// ── ParsedVar export — helps consumers avoid an extra import ─────────────────
export type { ParsedVar };
