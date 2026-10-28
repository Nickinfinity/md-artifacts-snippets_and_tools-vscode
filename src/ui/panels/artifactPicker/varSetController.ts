import * as vscode from 'vscode';
import { notifyEngineError, requestOrNotify } from '../../../engine/engine.vscode.js';
import { toApplyResult } from '../../../engine/adapt.js';
import { EngineRequestError } from '../../../engine/request-error.js';
import type { VarSetRef } from '../../../services/preview-target.service.js';
import { getEntry } from '../../../services/artifact-type-config.service.js';
import { getVaultRootUri } from '../../../services/config.service.js';
import { sendWrite } from '../../../services/conflict.service.js';
import type { ParsedArtifactFile, ParsedVar } from '../../../types/parsed-artifact.types.js';
import type { ApplyResult, VarSetFormPayload } from '../../../types/varset.types.js';
import { getVarSetScanner } from '../varsetPicker.panel.js';
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
 * `showDiffFor` (Variables-pane Apply) → diff preview
 * `confirmApply` / `cancelApply` → finalise
 * `saveAsVarSet` → write a new `Variables/<slug>.md` file.
 *
 * Stateless across artifacts — the active sub-set is held only between the
 * QuickPick acceptance and the user's confirm/cancel decision.
 *
 * @example
 * const ctrl = new VarSetController(extensionUri, { getCurrentArtifact, postMessage, rememberAppliedSet });
 * await ctrl.showDiffFor({ label: 'Local Dev', path: 'Variables/dev.md' }, { 'VK-host': '' });
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
     * Asks the engine for the apply diff and posts it to the webview. A failed
     * apply (toast already shown) leaves nothing confirmable.
     *
     * @param ref           - The set to apply (path + sub-set ref from the Variables pane).
     * @param currentValues - The preview's current input values to diff against.
     * @returns Resolves once the diff is posted, or the failure reported.
     *
     * @example
     * await ctrl.showDiffFor({ label: 'Local Dev', path: 'Variables/dev.md' }, { 'VK-host': '' });
     */
    async showDiffFor(ref: VarSetRef, currentValues: Record<string, string>): Promise<void> {
        // A failed apply must not leave the previous diff confirmable.
        this.pending = undefined;
        const r = await requestOrNotify('varsets.apply', {
            path: ref.path, ...(ref.subset ? { subset: ref.subset } : {}), values: currentValues,
        });
        if (!r) { return; }
        let result: ApplyResult;
        try { result = toApplyResult(r); } catch (e) {
            // Malformed reply: one toast through the engine error path, nothing confirmable.
            if (e instanceof EngineRequestError) { await notifyEngineError(e); return; }
            throw e;
        }
        this.pending = { heading: ref.label, result };

        this.cb.postMessage({
            command:    'showVarSetDiff',
            html:       renderVarSetDiffHtml(result.changes, ref.label),
            subSetName: ref.label,
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

        if (!getVariablesDirUri()) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Variables directory is not configured. Open the Settings panel to enable it.'));
            return;
        }

        openVarSetFormPanel(
            this.extensionUri,
            {
                write:    payload => writeVarSetFromForm(payload),
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
 * Saves a validated var-set form payload as a new `Variables/` file through the
 * engine, then refreshes the scanner so the tree shows it without a reload.
 * An existing set of that name is never overwritten: `sendWrite` toasts
 * `file.exists` and returns `undefined`.
 *
 * @param payload - The validated form payload.
 * @returns `true` when written (form closes); `false` keeps the form open.
 *
 * @example
 * if (await writeVarSetFromForm(payload)) { done(); }
 */
export async function writeVarSetFromForm(payload: VarSetFormPayload): Promise<boolean> {
    const description = payload.description.trim();
    const saved = await sendWrite('varsets.save', {
        title: payload.title.trim(),
        ...(description === '' ? {} : { description }),
        tags: payload.tags,
        values: Object.fromEntries(payload.pairs),
    });
    if (saved === undefined) { return false; }
    // F5 step 4 depends on this: without it the new set is on disk but
    // absent from the Variables tree until the window reloads (D-B).
    getVarSetScanner().invalidate();
    void vscode.window.showInformationMessage(vscode.l10n.t('Variable set saved: {0}', payload.title.trim()));
    return true;
}

// ── Module helpers ────────────────────────────────────────────────────────────

/**
 * Resolves the configured `<vault>/Variables` directory URI from VS Code settings.
 *
 * @returns The directory URI, or `null` when `mdArtifacts.vaultPath` is unset.
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
