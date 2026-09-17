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
 * 🔒 Security-critical: this is the extension's first recursive
 * `createDirectory` into the user's *workspace*, driven by *vault*-authored
 * link text. Two containment assertions guard it — vault containment (the
 * resolved link target must stay inside the index file's own directory,
 * checked before any read) and workspace containment (the chosen destination
 * must stay inside the workspace folder, checked before `createDirectory`) —
 * both are placed immediately before the I/O they guard, never after.
 */
import * as vscode from 'vscode';
import {
    applyCarryOver,
    buildDestCandidates,
    buildIndexPlan,
    summariseRun,
} from '../../../services/multi-index.service.js';
import { getTypeSingular, writesWholeFile } from '../../../services/artifact-type-config.service.js';
import { parseFromContent } from '../../../services/parser.service.js';
import { validateSingleBlock } from '../../../services/template.service.js';
import { isWithinRoot } from '../destFolderPicker.panel.js';
import { out } from './shared.js';
import type { BatchOutcome, DestCandidate, IndexStep, RejectedEntry } from '../../../types/multi-index.types.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';

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
        const plan = buildIndexPlan(indexArtifact.code);
        warnRejected(plan.rejected);

        const indexPaths = indexArtifact.frontmatter.paths ?? [];
        const carry: Record<string, string> = {};
        let written = 0;
        let skipped = 0;
        let aborted = false;

        for (const step of plan.steps) {
            const result = await this.runStep(step, indexPaths, carry);
            if (result === 'aborted') { aborted = true; break; }
            if (result === 'written') { written++; } else { skipped++; }
        }

        void vscode.window.showInformationMessage(summariseRun({ written, skipped, aborted }));
        this.cb.disposePreview();
        this.cb.closePicker();
    }

    /**
     * Runs one step, catching any thrown error so it degrades to `'skipped'`
     * rather than aborting the whole run (plan D6).
     */
    private async runStep(step: IndexStep, indexPaths: readonly string[], carry: Record<string, string>): Promise<StepResult> {
        try {
            return await this.runStepUnsafe(step, indexPaths, carry);
        } catch (err) {
            warn(`"${step.raw}" skipped: ${err instanceof Error ? err.message : String(err)}`);
            return 'skipped';
        }
    }

    /** The ordered body of one step (plan §4, points c–i) — read is gated separately by `readStepArtifact`. */
    private async runStepUnsafe(step: IndexStep, indexPaths: readonly string[], carry: Record<string, string>): Promise<StepResult> {
        const artifact = await this.readStepArtifact(step);
        if (!artifact) { return 'skipped'; }

        // c. Candidate destinations — mirrored folder first, then the index's `paths:`.
        const candidates = buildDestCandidates({ mirroredRelDir: step.relDir, clickedRelPath: this.cb.clickedRelPath, indexPaths });

        // d. Destination — undefined (Escape) skips this step, run continues.
        const destDir = await this.cb.chooseDestination(step, candidates);
        if (!destDir) { return 'skipped'; }

        // e. Workspace containment — the ONLY check standing behind the mirrored
        // candidate (it is safe by construction, never itself re-validated by
        // `safeRelPath`), and behind whatever `chooseDestination` returns from a
        // `paths:` entry or a Browse result. Asserted before any workspace write.
        if (!isWithinRoot(this.cb.workspaceRoot, destDir)) {
            warn(`"${step.raw}" skipped: destination is outside the workspace.`);
            return 'skipped';
        }

        // f. Recursive, idempotent — safe to call even when destDir already exists.
        await vscode.workspace.fs.createDirectory(destDir);

        // g. Carry-over from earlier steps overrides this step's own defaults.
        artifact.vars = applyCarryOver(artifact.vars, carry);

        // h. Delegate the actual write to the preview step.
        const outcome = await this.cb.previewStep(artifact, destDir);

        // i. Reduce the outcome.
        if (outcome.kind === 'written') {
            Object.assign(carry, outcome.vars);
            return 'written';
        }
        return outcome.kind === 'aborted' ? 'aborted' : 'skipped';
    }

    /**
     * Resolves and reads one step's linked file, gated by vault containment
     * (§a, before any read) and the D6 writesFile/D1-single-block rules (§b).
     *
     * @returns The parsed artifact, or `undefined` when the step must be skipped.
     */
    private async readStepArtifact(step: IndexStep): Promise<ParsedArtifactFile | undefined> {
        // a. Vault containment — asserted before any read.
        const targetUri = vscode.Uri.joinPath(this.cb.indexDirUri, step.relPath);
        if (!isWithinRoot(this.cb.indexDirUri, targetUri)) {
            warn(`"${step.raw}" skipped: resolves outside the index's own directory.`);
            return undefined;
        }

        let artifact: ParsedArtifactFile;
        try {
            const bytes = await vscode.workspace.fs.readFile(targetUri);
            artifact = parseFromContent(new TextDecoder().decode(bytes), targetUri.fsPath, this.cb.vaultRootFs);
        } catch {
            warn(`"${step.raw}" skipped: could not be read.`);
            return undefined;
        }

        // b. A linked file that isn't a writesFile type, or fails D1, is a skip
        // with a warning — an index of templates that accidentally links a
        // snippet must not abort the rest of the scaffold.
        if (!writesWholeFile(artifact.frontmatter.artifactType)) {
            warn(`"${step.raw}" skipped: not a template or agent config.`);
            return undefined;
        }
        const blockCheck = validateSingleBlock(artifact, getTypeSingular(artifact.frontmatter.artifactType));
        if (!blockCheck.ok) {
            warn(`"${step.raw}" skipped: ${blockCheck.reason}`);
            return undefined;
        }
        return artifact;
    }
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
 * @param rejected - `IndexPlan.rejected`, in document order.
 *
 * @example
 * warnRejected([{ raw: '../escape', reason: 'contains a parent-directory ("..") segment' }]);
 */
function warnRejected(rejected: readonly RejectedEntry[]): void {
    if (rejected.length === 0) { return; }
    const detail = rejected.map(r => `${r.raw} (${r.reason})`).join('; ');
    const noun = rejected.length === 1 ? 'entry' : 'entries';
    warn(`${rejected.length} ${noun} skipped: ${detail}`);
}
