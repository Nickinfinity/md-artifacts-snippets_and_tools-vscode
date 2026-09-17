/**
 * The destination chooser for one multi-template-index step (D9): a QuickPick
 * over the candidate list `buildDestCandidates` (T1) built — mirrored folder
 * first and pre-selected, each declared `paths:` entry next — plus a trailing
 * `Browse…` row that defers to the existing `pickDestFolder` folder navigator.
 * No second folder browser is built here.
 */
import * as vscode from 'vscode';
import { pickDestFolder } from '../destFolderPicker.panel.js';
import type { DestCandidate } from '../../../types/multi-index.types.js';

/** Builder, not a module-scope const: `vscode.l10n.t` must run after the
 *  bundle is loaded, not at require time. */
function labelBrowse(): string {
    return `$(folder-opened) ${vscode.l10n.t('Browse…')}`;
}

/** One QuickPick row: a `DestCandidate` (carries its `relPath`) or the trailing Browse action. */
interface DestPickItem extends vscode.QuickPickItem {
    /** Workspace-relative POSIX path; `undefined` on the Browse row. */
    relPath?: string;
}

/**
 * Prompts for the destination folder of one template-index step.
 *
 * Renders `candidates` first — the mirrored folder leads the list, so it is
 * the QuickPick's default active item and a bare Enter accepts it — followed
 * by a `Browse…` row that reuses `pickDestFolder`, rooted at `workspaceRoot`
 * (not the clicked folder), so the user can place the file anywhere in the
 * project. Escape returns `undefined`; the runner treats that as "skip this
 * file" (D5).
 *
 * @param args.workspaceRoot - Workspace folder root; base for resolving a
 *   chosen candidate and the containment root `pickDestFolder` browses under.
 * @param args.candidates - Ordered candidate list from `buildDestCandidates`.
 * @param args.targetName - Target file name, named in the QuickPick title so
 *   the user knows what they are placing.
 * @returns The chosen destination `Uri`, or `undefined` on Escape.
 *
 * @example
 * const dest = await chooseStepDestination({
 *     workspaceRoot,
 *     candidates: buildDestCandidates({ mirroredRelDir, clickedRelPath, indexPaths }),
 *     targetName: 'Button.tsx',
 * });
 */
export async function chooseStepDestination(args: {
    workspaceRoot: vscode.Uri;
    candidates: readonly DestCandidate[];
    targetName: string;
}): Promise<vscode.Uri | undefined> {
    const { workspaceRoot, candidates, targetName } = args;

    const items: DestPickItem[] = [
        ...candidates.map(c => ({ label: `$(folder) ${c.label}`, detail: c.detail, relPath: c.relPath })),
        { label: labelBrowse() },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t('Destination for {0}', targetName),
        ignoreFocusOut: true,
    });
    if (!picked) { return undefined; }  // Escape

    return picked.relPath === undefined
        ? pickDestFolder(workspaceRoot)
        : vscode.Uri.joinPath(workspaceRoot, picked.relPath);
}
