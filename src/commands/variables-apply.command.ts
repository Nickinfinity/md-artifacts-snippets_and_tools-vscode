import * as vscode from 'vscode';
import { getVaultRootUri } from '../services/config.service.js';
import { getPreviewTarget } from '../services/preview-target.service.js';
import { at, defaultIO, resolveTarget, type CommandIO } from './variables.command.helpers.js';
import type { VariableNode } from '../ui/views/variablesView.provider.js';

/**
 * Two Variables-pane commands that act on a **live preview** (T1.3,
 * VSX-246): applying a clicked sub-set to it, and saving its current input
 * values as a new sub-set. Both refuse — via `deps.notifyInfo`, never
 * `io.showError` — when no preview is open (O-2), since that is a normal,
 * expected state (the save command is palette-visible with no preview open),
 * not an error.
 *
 * Kept a sibling of `variables.command.ts` rather than added to it — that
 * file is already over `CLAUDE.md`'s ~400-line cap.
 */

/**
 * Interaction bag for both handlers here, separate from `CommandIO`:
 * `CommandIO` (`variables.command.helpers.ts`) has no information channel
 * (`showError` only), and "no preview open" is not an error — it needs its
 * own notification, distinct from `resolveTarget`'s containment-refusal
 * `io.showError` path.
 *
 * @example
 * const deps: ApplyDeps = { vaultRoot: getVaultRootUri(), io: defaultIO, notifyInfo: msg => vscode.window.showInformationMessage(msg) };
 */
export interface ApplyDeps {
    /** Vault root; `undefined` when no vault is configured. */
    vaultRoot: vscode.Uri | undefined;
    /** Interaction bag passed straight through to `resolveTarget`. */
    io: CommandIO;
    /** Shows an informational (non-error) toast — used for the "no preview open" refusal. */
    notifyInfo: (message: string) => void;
}

/**
 * Builds a real, `vscode.window`-backed `ApplyDeps` reading the live,
 * process-wide vault — a function rather than a constant so `vaultRoot` is
 * evaluated per call, matching `variables.command.ts`'s existing
 * default-parameter pattern (`vaultRoot = getVaultRootUri()`).
 *
 * @returns A real `ApplyDeps` for command registration to wire handlers to.
 *
 * @example
 * await handleApplyToPreview(node, liveApplyDeps());
 */
export function liveApplyDeps(): ApplyDeps {
    return {
        vaultRoot: getVaultRootUri(),
        io: defaultIO,
        notifyInfo: message => { void vscode.window.showInformationMessage(message); },
    };
}

/**
 * Applies the clicked sub-set to the live preview's variable inputs.
 *
 * Checks for a live preview **before** calling `resolveTarget` — resolving
 * first would fire `io.showError` on its own no-vault/no-node paths, and the
 * "no preview open" case must produce exactly one information message, not
 * an error toast plus a second refusal.
 *
 * @param node - Clicked `subset` tree node.
 * @param deps - Interaction bag; see `ApplyDeps`.
 * @returns void
 *
 * @example
 * await handleApplyToPreview(node, liveApplyDeps());
 */
export async function handleApplyToPreview(
    node: VariableNode | undefined,
    deps: ApplyDeps,
): Promise<void> {
    const target = getPreviewTarget();
    if (!target) {
        deps.notifyInfo(vscode.l10n.t('Obsidian Artifacts: no preview open — open an artifact preview first.'));
        return;
    }

    const resolved = await resolveTarget(node, 'subset', deps.vaultRoot, deps.io);
    if (!resolved) { return; }

    const subSet = at(resolved.subSets, resolved.subIdx);
    if (!subSet) {
        deps.io.showError(vscode.l10n.t('Obsidian Artifacts: variable set not found — refresh the tree and retry.'));
        return;
    }

    target.applyVarSet(subSet.heading, subSet.vars);
}

/**
 * Saves the live preview's current input values as a new variable set —
 * delegates to the preview's own `saveAsSet` (the existing save-as-set
 * flow), never re-implementing it.
 *
 * @param deps - Interaction bag; see `ApplyDeps`.
 * @returns void
 *
 * @example
 * await handleSaveCurrentValues(liveApplyDeps());
 */
export async function handleSaveCurrentValues(deps: ApplyDeps): Promise<void> {
    const target = getPreviewTarget();
    if (!target) {
        deps.notifyInfo(vscode.l10n.t('Obsidian Artifacts: no preview open — open an artifact preview first.'));
        return;
    }

    await target.saveAsSet(target.currentValues());
}
