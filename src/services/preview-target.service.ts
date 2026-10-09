import type { ParsedVar } from '../types/parsed-artifact.types.js';

/**
 * What a live preview offers the Variables pane, so the pane can drive
 * variable-set actions (Apply / Save as set) without importing the preview
 * module directly — `src/types/` and this file stay `vscode`-free by rule,
 * and the two surfaces must not couple to one another's internals.
 *
 * @example
 * const target: PreviewVarTarget = {
 *     applyVarSet: (name, vars) => controller.applyVarSet(name, vars),
 *     currentValues: () => controller.snapshotValues(),
 *     saveAsSet: values => controller.handleSaveAsVarSet({ values }),
 * };
 */
export interface PreviewVarTarget {
    /**
     * Applies a sub-set's values to the preview's inputs, showing the diff step.
     *
     * @param subSetName - The sub-set's display name, for the diff header.
     * @param vars - The sub-set's variables to merge into the preview.
     * @returns Nothing; the preview renders the diff itself.
     * @example
     * target.applyVarSet('Staging', [{ name: 'VK-host', defaultValue: 'staging.example.com' }]);
     */
    applyVarSet(subSetName: string, vars: readonly ParsedVar[]): void;

    /**
     * The values currently typed into the preview, for "save these as a set".
     *
     * @returns A map of variable name to its current input value.
     * @example
     * const values = target.currentValues(); // { 'VK-host': 'localhost' }
     */
    currentValues(): Record<string, string>;

    /**
     * Saves the given values as a new variable set, carrying the active
     * artifact's tags.
     *
     * @param values - The values to persist, keyed by variable name.
     * @returns A promise that resolves once the set has been written.
     * @example
     * await target.saveAsSet({ 'VK-host': 'localhost' });
     */
    saveAsSet(values: Record<string, string>): Promise<void>;
}

/** The currently registered preview, or `undefined` when none is open. */
let activeTarget: PreviewVarTarget | undefined;

/** Called with `true` when a preview registers, `false` when the last one releases. */
const changeListeners = new Set<(active: boolean) => void>();

/**
 * Subscribes to "is a preview open?" changes — the Variables pane uses it to
 * show its Apply-to-preview button only when there is a preview to apply to.
 *
 * @param listener - Receives `true` on register, `false` on release.
 * @returns A function that unsubscribes the listener.
 *
 * @example
 * const off = onPreviewTargetChanged(active => setContext('md-artifacts.previewActive', active));
 */
export function onPreviewTargetChanged(listener: (active: boolean) => void): () => void {
    changeListeners.add(listener);
    return () => { changeListeners.delete(listener); };
}

function notifyChanged(): void {
    for (const listener of changeListeners) { listener(activeTarget !== undefined); }
}

/**
 * Registers the preview that should receive variable-set actions.
 *
 * Mirrors `mainView.provider.ts`'s `onWebviewMessage` identity guard: the
 * returned releaser clears the slot only if it is still the one that set it,
 * so a stale release from an earlier preview can never clobber a newer one
 * (see `test/preview-target.service.test.ts` — "a stale release must not
 * clear a newer target").
 *
 * @param t - The live preview's callback bag.
 * @returns A releaser; call it when that preview closes.
 * @example
 * const release = setPreviewTarget(target);
 * // …later, on dispose…
 * release();
 */
export function setPreviewTarget(t: PreviewVarTarget): () => void {
    activeTarget = t;
    notifyChanged();
    return () => {
        if (activeTarget === t) {
            activeTarget = undefined;
            notifyChanged();
        }
    };
}

/**
 * The currently registered preview target, if any.
 *
 * @returns The live preview's callback bag, or `undefined` when no preview is open.
 * @example
 * getPreviewTarget()?.applyVarSet('Staging', vars);
 */
export function getPreviewTarget(): PreviewVarTarget | undefined {
    return activeTarget;
}
