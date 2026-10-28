/**
 * `MultiIndexRunner` — the only file doing I/O for the multi-template-index
 * feature (plan §4). Composed by the navigator through a callback bag, in the
 * same idiom `PreviewPanelController` / `FullEditController` already use
 * (`CLAUDE.md`: "callback bags, never reaching inward").
 *
 * **Deliberately does not import `preview.ts`.** The preview step arrives as
 * the `previewStep` callback, so this module and the preview panel stay
 * independently buildable and independently testable.
 *
 * The engine plans the run (`index.plan`: link syntax, vault containment,
 * candidates, per-step skips) and writes each file (`artifact.write_file`, via
 * the preview step). This runner creates nothing on disk.
 *
 * 🔒 Security: the chosen destination must stay inside the workspace folder
 * (`isWithinRoot`) before it is handed to the preview step that writes.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getVaultPath } from '../../../services/config.service.js';
import { getEngine } from '../../../engine/engine.vscode.js';
import { toParsedArtifactFile } from '../../../engine/adapt.js';
import { engineMeta } from '../../../engine/model.js';
import { engineErrorMessage } from '../../../engine/errors.js';
import { EngineRequestError } from '../../../engine/request-error.js';
import { isWithinRoot } from '../destFolderPicker.panel.js';
import { out } from './shared.js';
import type { EngineResult } from '../../../types/engine.types.js';
import type { BatchOutcome, DestCandidate, IndexStep, RunTally } from '../../../types/multi-index.types.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';

/** One step of an `index.plan` reply. */
type PlanStep = EngineResult<'index.plan'>['steps'][number];

/**
 * Callback bag `MultiIndexRunner` is composed with — the seam that keeps the
 * runner `vscode`-Uri-aware but UI-agnostic, and keeps `previewStep` (the only
 * hook into the preview panel) swappable for a test stub.
 */
export interface MultiIndexCallbacks {
    /** Vault directory the index file sits in — the vault containment root (§a). */
    indexDirUri: vscode.Uri;
    /** Workspace folder root — the workspace containment root (§e). */
    workspaceRoot: vscode.Uri;
    /** The clicked Explorer folder, workspace-relative POSIX (`''` = root). */
    clickedRelPath: string;
    /** Artifact root fs path, forwarded to `parseFromContent`'s `relativePath` computation. */
    vaultRootFs: string;
    /** Prompts for one step's destination folder; `undefined` means "skip this step". */
    chooseDestination: (step: IndexStep, candidates: readonly DestCandidate[]) => Promise<vscode.Uri | undefined>;
    /** Runs the interactive preview for one resolved artifact, resolving to how the step ended. */
    previewStep: (artifact: ParsedArtifactFile, destDir: vscode.Uri) => Promise<BatchOutcome>;
    /** Closes the driving QuickPick once the run finishes. */
    closePicker: () => void;
    /** Disposes the preview popup once the run finishes. */
    disposePreview: () => void;
}

/** How one step resolved — the value `runStep` reduces every branch to. */
type StepResult = 'written' | 'skipped' | 'aborted';

/**
 * Orchestrates one template-index run: builds the plan, walks its steps in
 * document order, and reports the outcome.
 *
 * @example
 * const runner = new MultiIndexRunner({ indexDirUri, workspaceRoot, clickedRelPath: '', vaultRootFs, chooseDestination, previewStep, closePicker, disposePreview });
 * await runner.run(indexArtifact);
 */
export class MultiIndexRunner {
    constructor(private readonly cb: MultiIndexCallbacks) {}

    /**
     * Runs the index end to end: plan → per-step processing → closing notification.
     *
     * Every step runs inside its own guard (`runStep`), so one bad link, one
     * unreadable file, or one rejected destination cannot kill the run — only
     * an explicit `aborted` outcome from `previewStep` (the user closed the
     * preview panel) stops it early.
     *
     * @param indexArtifact - The parsed template-index file (`frontmatter.index === true`).
     * @returns Resolves once the run has finished and both closing callbacks have fired.
     *
     * @example
     * await runner.run(indexArtifact);
     */
    async run(indexArtifact: ParsedArtifactFile): Promise<void> {
        const indexRel = engineMeta(indexArtifact)?.relPath;
        const carry: Record<string, string> = {};
        let written = 0;
        let skipped = 0;
        let aborted = false;

        if (indexRel === undefined) {
            out.appendLine('[multiIndex] index has no engine path (not read through the engine); nothing to plan.');
        } else {
            try {
                const plan = await getEngine().request('index.plan', { path: indexRel, mirrorFrom: this.cb.clickedRelPath });
                warnRejected(plan.rejected);
                for (const step of plan.steps) {
                    const result = await this.runStep(step, indexRel, carry);
                    if (result === 'aborted') { aborted = true; break; }
                    if (result === 'written') { written++; } else { skipped++; }
                }
            } catch (err) {
                warn(`index could not be planned: ${errorText(err)}`);
            }
        }

        void vscode.window.showInformationMessage(summariseRun({ written, skipped, aborted }));
        this.cb.disposePreview();
        this.cb.closePicker();
    }

    /**
     * Runs one step, catching any thrown error so it degrades to `'skipped'`
     * rather than aborting the whole run (plan D6).
     */
    private async runStep(step: PlanStep, indexRel: string, carry: Record<string, string>): Promise<StepResult> {
        try {
            return await this.runStepUnsafe(step, indexRel, carry);
        } catch (err) {
            warn(`"${step.raw}" skipped: ${errorText(err)}`);
            return 'skipped';
        }
    }

    /** The ordered body of one step: engine skip, read, destination, containment, preview. */
    private async runStepUnsafe(step: PlanStep, indexRel: string, carry: Record<string, string>): Promise<StepResult> {
        if (step.skip) { warn(`"${step.raw}" skipped: ${engineErrorMessage(step.skip)}`); return 'skipped'; }
        const read = await getEngine().request('artifact.read', { path: path.posix.join(path.posix.dirname(indexRel), step.relPath) });
        const artifact = toParsedArtifactFile(read, getVaultPath());

        // Candidate destinations — engine order: mirrored folder first, then the index's `paths:`.
        const candidates: DestCandidate[] = step.candidates.map((relPath, i) => ({
            relPath, label: relPath === '' ? '/' : relPath,
            detail: i === 0 ? vscode.l10n.t('Suggested — mirrors the index') : vscode.l10n.t('From the index'),
        }));

        // Destination — undefined (Escape) skips this step, run continues.
        const destDir = await this.cb.chooseDestination(step, candidates);
        if (!destDir) { return 'skipped'; }

        // Workspace containment — the ONLY check standing behind the mirrored
        // candidate and whatever `chooseDestination` returns (a `paths:` entry or a
        // Browse result). Asserted before the preview step can write anything.
        if (!isWithinRoot(this.cb.workspaceRoot, destDir)) {
            warn(`"${step.raw}" skipped: destination is outside the workspace.`);
            return 'skipped';
        }

        // Carry-over from earlier steps overrides this step's own defaults.
        artifact.vars = artifact.vars.map(v => (Object.hasOwn(carry, v.name) ? { ...v, defaultValue: carry[v.name] } : v));

        // Delegate the actual write to the preview step (`runCreateFileFlow` → `write_file`).
        const outcome = await this.cb.previewStep(artifact, destDir);
        if (outcome.kind === 'written') {
            Object.assign(carry, outcome.vars);
            return 'written';
        }
        return outcome.kind === 'aborted' ? 'aborted' : 'skipped';
    }
}

/**
 * Words for a thrown error: an engine error through the localised table, anything else its message.
 *
 * @param err - What a step threw.
 * @returns Text safe to show.
 *
 * @example
 * errorText(new EngineRequestError({ code: 'vault.not_selected', params: {} }));
 */
function errorText(err: unknown): string {
    if (err instanceof EngineRequestError) { return engineErrorMessage(err.data); }
    return err instanceof Error ? err.message : String(err);
}

/**
 * Logs and surfaces one non-fatal warning during a run — every per-step skip
 * reason routes through this single spot so the message prefix (and the
 * output-channel mirror) cannot drift between call sites.
 *
 * @param message - Human-readable reason, already naming the offending entry.
 *
 * @example
 * warn('"dir/a" skipped: not a template or agent config.');
 */
function warn(message: string): void {
    out.appendLine(`[multiIndex] ${message}`);
    void vscode.window.showWarningMessage(vscode.l10n.t('Multi-Template: {0}', message));
}

/**
 * Warns once for every rejected index entry (plan step 2) — one notification
 * naming each refused link and its reason, not one popup per entry.
 *
 * @param rejected - `index.plan`'s `rejected`, in document order.
 *
 * @example
 * warnRejected([{ raw: '../escape', code: 'path.parent_segment' }]);
 */
function warnRejected(rejected: EngineResult<'index.plan'>['rejected']): void {
    if (rejected.length === 0) { return; }
    const detail = rejected.map(r => `${r.raw} (${engineErrorMessage({ code: r.code, params: {} })})`).join('; ');
    const noun = rejected.length === 1 ? 'entry' : 'entries';
    warn(`${rejected.length} ${noun} skipped: ${detail}`);
}

/**
 * The closing notification for a batch run.
 *
 * @param tally - The run's final counts.
 * @param label - Prefix naming which kind of run is reporting.
 * @returns The notification text.
 *
 * @example
 * summariseRun({ written: 3, skipped: 0, aborted: false });
 * // → 'Multi-Template: 3 files written, 0 skipped.'
 *
 * @example
 * summariseRun({ written: 2, skipped: 1, aborted: false }, 'Create index');
 * // → 'Create index: 2 files written, 1 skipped.'
 */
export function summariseRun(tally: RunTally, label = 'Multi-Template'): string {
    const fileWord = tally.written === 1 ? 'file' : 'files';
    const suffix = tally.aborted ? ' Run cancelled.' : '';
    return `${label}: ${tally.written} ${fileWord} written, ${tally.skipped} skipped.${suffix}`;
}
