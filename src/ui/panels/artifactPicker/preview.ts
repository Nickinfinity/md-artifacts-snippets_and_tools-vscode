import * as vscode from 'vscode';
import { writesWholeFile, isTerminalOnly } from '../../../services/artifact-type-config.service.js';
import type { BlockRef } from '../../../services/artifact-patcher.service.js';
import { PreviewModeController, type SectionKey } from '../../../services/preview-mode.service.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import { out } from './shared.js';
import { sanitiseVarsSnapshot, hasVisibleEditor } from './preview.helpers.js';
import type { HostMessage } from './webviewHost.js';
import { BlockEditController } from './blockEditor.js';
import { VarSetController } from './varSetController.js';
import { BatchGate } from './preview.batch.js';
import { PreviewWidth } from './preview.width.js';
import { StagedEdit } from './preview.staged.js';
import { PreviewActions } from './preview.actions.js';
import type { PreviewCallbacks } from './preview.types.js';
import { EDIT_ARTIFACT_COMMAND_ID } from '../../../commands/editArtifact.command.js';
import { setPreviewTarget } from '../../../services/preview-target.service.js';
import type { BatchOutcome } from '../../../types/multi-index.types.js';

// Re-export the adapter so the navigator does not need to import preview.helpers directly.
export { blockAsArtifact } from './preview.helpers.js';
export type { PreviewCallbacks } from './preview.types.js';

/**
 * Owns the preview session in the main pane: reveal/attach lifecycle, the
 * webview ↔ extension message protocol, and the embedded sub-controllers.
 * Created lazily by the navigator once the user starts hovering an item.
 *
 * The pane itself renders (`MainViewProvider`); this controller decides *what*
 * state to show and owns everything around it.
 *
 * @example
 * new PreviewPanelController({ extensionUri, rootFs, targetEditor, setCache, onDispose, closePicker }).showPreview(artifact);
 */
export class PreviewPanelController {
    /** True between the first render and the end of the preview session. */
    private open = false;
    private currentArtifact: ParsedArtifactFile | undefined;
    private modeController: PreviewModeController | undefined;
    private msgSub: vscode.Disposable | undefined;
    private readonly blockEdit: BlockEditController;
    private readonly varSet:    VarSetController;
    private readonly staged:    StagedEdit;
    private readonly actions:   PreviewActions;
    /** Pane width plumbing; `dispose()` restores it exactly once behind the `open` guard. */
    private readonly width: PreviewWidth;
    private readonly batch = new BatchGate();  // one-shot per-step gate a MultiIndexRunner arms (T4)
    /** Releases this preview's claim on the Variables-pane target; see `claimTarget` (H1.4). */
    private releaseTarget: (() => void) | undefined;
    /** Latest values the webview reported, so `currentValues()` stays synchronous (H1.4). */
    private varsSnapshot: Record<string, string> = {};
    /** Which fence in the source `.md` this preview's code belongs to. */
    private currentBlockRef: BlockRef = { kind: 'single' };

    /**
     * Watches for editor tabs opening/closing while a preview is open, so
     * Insert can appear the moment there is somewhere to insert into.
     *
     * `visibleTextEditors`, not `activeTextEditor`: the latter goes `undefined`
     * whenever a webview takes focus, which would hide Insert exactly while the
     * user is working in this pane. Disposed in `dispose()` beside `msgSub`.
     */
    private editorsSub: vscode.Disposable | undefined;

    /**
     * The restore `dispose()` started. Edit awaits it so the form does not take
     * focus mid-restore (the width commands act on the focused part).
     */
    private narrowed: Promise<void> = Promise.resolve();

    constructor(private readonly cb: PreviewCallbacks) {
        this.width = new PreviewWidth(msg => { cb.host.post(msg); });
        this.blockEdit = new BlockEditController({
            rootFs:              cb.rootFs,
            storageUri:          cb.storageUri,
            getCurrentArtifact:  () => this.currentArtifact,
            setCurrentArtifact:  a => { this.currentArtifact = a; },
            setCache:            cb.setCache,
            postMessage:         msg => { this.postToWebview(msg); },
            getViewColumn:       () => undefined,
            onCodeStaged:        code => { this.staged.stageCode(code); },
        });
        this.staged = new StagedEdit({
            blockEdit:          this.blockEdit,
            getCurrentArtifact: () => this.currentArtifact,
            getBlockRef:        () => this.currentBlockRef,
            setCache:           cb.setCache,
            setCurrentArtifact: a => { this.currentArtifact = a; },
            postMessage:        msg => { this.postToWebview(msg); },
        });
        this.actions = new PreviewActions({
            rootFs:             cb.rootFs,
            targetEditor:       cb.targetEditor,
            invocationSurface:  cb.invocationSurface,
            destUri:            cb.destUri,
            batch:              this.batch,
            getCurrentArtifact: () => this.currentArtifact,
            setCurrentArtifact: a => { this.currentArtifact = a; },
            getBlockRef:        () => this.currentBlockRef,
            getModeController:  () => this.modeController,
            setCache:           cb.setCache,
            post:               msg => { cb.host.post(msg); },
            dispose:            () => { this.dispose(); },
            closePicker:        cb.closePicker,
        });
        this.varSet = new VarSetController(cb.extensionUri, {
            getCurrentArtifact: () => this.currentArtifact,
            postMessage:        msg => { this.postToWebview(msg); },
            rememberAppliedSet: (subSetName, varNames) => {
                if (!this.modeController) { return; }
                for (const name of varNames) { this.modeController.setVarSource(name, subSetName); }
            },
        });
    }


    /**
     * Posts a sub-controller's message through the host.
     *
     * The sub-controllers' bags are typed `unknown` (they predate the host),
     * so this narrows rather than casts: a message with no string `command`
     * is dropped, because the queue keys on that field and an entry without
     * one could never be collapsed or flushed correctly.
     *
     * @param msg - Candidate message from a sub-controller.
     *
     * @example
     * this.postToWebview({ command: 'updateVars', vars });
     */
    private postToWebview(msg: unknown): void {
        if (typeof msg !== 'object' || msg === null) { return; }
        if (typeof (msg as { command?: unknown }).command !== 'string') { return; }
        this.cb.host.post(msg as HostMessage);
    }

    /** True while a preview session is active (regardless of pane visibility). */
    isOpen(): boolean { return this.open; }

    /**
     * Reveals the main pane and waits for its view to be live.
     *
     * `preserveFocus` is accepted for call-site compatibility but no longer
     * meaningful: an activity-bar pane is revealed by its own focus command,
     * which cannot reveal-without-focusing the way a `WebviewPanel` could.
     *
     * @param _preserveFocus - Ignored; see above.
     * @returns Resolves once the pane's view has resolved.
     *
     * @example
     * await controller.reveal(false);
     */
    async reveal(_preserveFocus: boolean): Promise<void> {
        await this.cb.ensureView();
    }

    /**
     * Keeps the pane's Insert button in step with whether an editor tab exists.
     *
     * The initial state is rendered into the HTML; this only handles the tabs
     * opening or closing *while* the preview is up. Posting through the host
     * means a hidden pane queues the message rather than dropping it (H1).
     *
     * @example
     * this.watchEditorAvailability(); // after showPreviewState
     */
    private watchEditorAvailability(): void {
        this.editorsSub?.dispose();
        const type = this.currentArtifact?.frontmatter.artifactType;
        // Only editor-bound types are gated, and the decision lives here rather
        // than as a marker attribute in the markup: the extension already knows
        // the type, so shipping a flag into the webview would be a second copy
        // of the same rule. A whole-file type writes into the workspace and a
        // terminal-bound type sends to the terminal — neither needs an editor.
        if (!type || writesWholeFile(type) || isTerminalOnly(type)) { return; }
        this.editorsSub = vscode.window.onDidChangeVisibleTextEditors(() => {
            this.postToWebview({ command: 'setInsertAvailable', value: hasVisibleEditor() });
        });
    }

    /** Ends the preview session and returns the pane to `idle`. */
    dispose(): void {
        if (!this.open) { return; }
        // Released here, on the one path every preview-end funnels through —
        // never from a teardown hook. A sidebar *hide* disposes a WebviewView
        // (H2), so a preview that died without releasing would leave the
        // Variables pane holding a target whose applyVarSet posts into a dead
        // webview (ledger #23).
        this.releaseTarget?.();
        this.releaseTarget = undefined;
        this.open = false;
        void this.blockEdit.teardown();
        this.msgSub?.dispose();
        this.msgSub          = undefined;
        this.editorsSub?.dispose();
        this.editorsSub      = undefined;
        this.modeController  = undefined;
        this.currentArtifact = undefined;
        this.batch.settle({ kind: 'aborted' });  // no-op unless still armed (D5)
        // Every preview-end path funnels here (insert, cancel, edit, batch
        // abort) and the `open` guard above makes it once-per-session, so this
        // is the one place the widen is undone. Fire-and-forget: `dispose()` is
        // sync by contract, and a failed narrow must never break an insert.
        this.narrowed = this.width.restore();
        this.cb.endPreview();
        this.cb.onDispose();
    }

    /** `MultiIndexRunner`'s per-step hook: arms the batch gate, shows the preview,
     *  reveals the panel, and returns the gate's promise (settled by `handleCreateFile` /
     *  `cancel` / `onDidDispose`). */
    previewOnce(artifact: ParsedArtifactFile, destDir: vscode.Uri): Promise<BatchOutcome> {
        const outcome = this.batch.arm(destDir);
        this.showPreview(artifact);
        this.reveal(false);
        return outcome;
    }

    // ── Renderers ─────────────────────────────────────────────────────────────

    /**
     * Shows the artifact in the main pane's interactive preview mode.
     *
     * @param artifact - Single-block artifact (or block-adapted artifact) to display.
     * @returns Resolves once the pane has rendered.
     *
     * @example
     * await controller.showPreview(artifact);
     */
    async showPreview(artifact: ParsedArtifactFile, blockRef?: BlockRef): Promise<void> {
        void this.blockEdit.teardown();
        this.currentBlockRef = blockRef ?? { kind: 'single' };
        this.staged.reset();
        this.currentArtifact = artifact;
        this.modeController  = new PreviewModeController(artifact.code);

        // Before `ensureHost`, never after: `ensureView` re-attaches the target
        // and `attachTarget` flushes a visible one, so clearing afterwards would
        // run *after* the flush it exists to prevent (ledger #119).
        this.cb.host.clearQueue();
        if (!await this.ensureHost()) { return; }

        // Claimed here, not inside `ensureHost`: `showMultiBlockPreview`
        // reaches the same `ensureHost` but renders no variable inputs, so
        // claiming there would let the Variables pane apply a set into a pane
        // with nothing to apply it to. And not before the check either — if
        // `ensureHost` fails, `dispose()`'s `open` guard means the release
        // never runs and the target leaks.
        this.claimTarget();

        const varSources = this.modeController?.getAllVarSources() ?? {};
        this.cb.showPreviewState({
            kind: 'single', artifact, varSources,
            insertAvailable: hasVisibleEditor(),
        });
        this.setupMessageHandler();
        this.watchEditorAvailability();
        this.width.postVarsHeight();
        void this.width.widen();
        out.appendLine(`[pane] preview → ${artifact.fileName}`);
    }

    /**
     * Shows a stacked multi-block preview in the main pane.
     *
     * @param artifact - Multi-block artifact to preview.
     * @returns Resolves once the pane has rendered.
     *
     * @example
     * await controller.showMultiBlockPreview(artifact);
     */
    async showMultiBlockPreview(artifact: ParsedArtifactFile): Promise<void> {
        this.cb.host.clearQueue();   // before ensureHost — see showPreview (ledger #119)
        if (!await this.ensureHost()) { return; }
        this.cb.showPreviewState({ kind: 'multi', artifact });
        void this.width.widen();
        out.appendLine(`[pane] multi-block preview → ${artifact.fileName} (${artifact.blocks.length} blocks)`);
    }

    /** Renders the empty state, leaving the pane in `preview` mode. */
    showEmpty(): void {
        if (!this.open) { return; }
        this.cb.showPreviewState({ kind: 'empty' });
    }
    // ── Internal: host lifecycle ──────────────────────────────────────────────

    /**
     * Reveals the pane, attaches it to the host, and wires the session's
     * lifecycle listeners.
     *
     * **Re-ensures on every render, not once per session.** Hiding an
     * activity-bar view via its context menu *disposes* it, which nulls the
     * provider's `view` — so an `if (this.open) return` fast path left the
     * pane permanently dead after the first hide: the next `showPreview`
     * changed no HTML, raised no error and logged nothing (ledger #119).
     * `ensureView` is cheap when the view is already live.
     *
     * **H2 — a hide is not a cancel.** The old popup aborted the batch gate
     * from `panel.onDidDispose`; hiding a view also disposes it, so that
     * wiring would abort a multi-index run whenever the user looked at
     * another container. Only an explicit end — Cancel, Insert, Create File —
     * calls {@link dispose}.
     *
     * @returns `true` when the pane is live and rendering can proceed.
     */
    private async ensureHost(): Promise<boolean> {
        try {
            await this.cb.ensureView();
            if (!this.open) {
                this.open = true;
                out.appendLine('[pane] preview session opened');
            }
            return true;
        } catch (err) {
            out.appendLine(`[pane] reveal FAILED: ${(err as Error).message}`);
            return false;
        }
    }

    // ── Internal: the Variables-pane seam (W1/H1.4) ───────────────────────────

    /** Registers this preview as the Variables pane's target for the session. */
    private claimTarget(): void {
        this.releaseTarget?.();
        this.releaseTarget = setPreviewTarget({
            applyVarSet: ref => {
                void this.varSet.showDiffFor(ref, this.varsSnapshot);
            },
            currentValues: () => ({ ...this.varsSnapshot }),
            // Routed through the controller, not reimplemented: it holds the
            // `getCurrentArtifact()` gate that carries the artifact's tags.
            saveAsSet: values => this.varSet.handleSaveAsVarSet({ values }),
        });
    }

    private setupMessageHandler(): void {
        this.msgSub?.dispose();
        this.msgSub = undefined;
        if (!this.open) { return; }
        this.msgSub = this.cb.onWebviewMessage(msg => {
            const m = msg as Record<string, unknown>;
            // Answered here rather than in `handleMessage` so the width probe
            // stays off the user-action routing chain entirely.
            if (m.command === 'paneMetrics') { this.width.resolveMeasure(m); return; }
            void this.handleMessage(m);
        });
    }

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        const cmd = msg.command as string;
        if      (cmd === 'startEdit')     { this.modeController?.startEditingSection(msg.section as SectionKey); }
        else if (cmd === 'cancelEdit')    { this.modeController?.stopEditingSection(msg.section as SectionKey); }
        else if (cmd === 'quickEdit')     { this.modeController?.enterQuickEdit(); }
        else if (cmd === 'backToPreview') { this.modeController?.enterPreview(); }
        else if (cmd === 'fullEdit')      { await this.handleFullEdit(); }
        else if (cmd === 'insert')        { void this.actions.handleInsert(msg); }
        else if (cmd === 'copy')          { void this.actions.handleCopy(msg); }
        else if (cmd === 'editBlock')     { await this.staged.handleEditBlock(); }
        else if (cmd === 'overwrite')     { await this.staged.handleOverwrite(msg); }
        else if (cmd === 'varsHeightChanged') { await this.width.handleVarsHeightChanged(msg); }
        else if (cmd === 'cancel')        { this.cancel(); }
        else if (cmd === 'confirmApply')  { this.varSet.handleConfirmApply(); }
        else if (cmd === 'cancelApply')   { this.varSet.handleCancelApply(); }
        else if (cmd === 'clearVarSource'){ this.modeController?.clearVarSource(msg.name as string); }
        else if (cmd === 'varsSnapshot')  { this.varsSnapshot = sanitiseVarsSnapshot(msg.values); }
    }

    /** Cancel: settles the batch gate `skipped` when armed (D5); else disposes as before. */
    private cancel(): void { if (this.batch.isArmed) { this.batch.settle({ kind: 'skipped' }); return; } this.dispose(); }

    /**
     * Opens the artifact in the create/edit form, the same panel and column a
     * create opens in — rather than the raw `.md` in a text editor.
     *
     * Routed through a command because the form needs the `ExtensionContext`,
     * which this controller does not carry. The preview session ends first:
     * the form is now the editing surface, so leaving the pane in preview mode
     * behind it would show a stale copy of what the user is editing. The form
     * opens only after the width restore settles: the form takes focus, and
     * `decreaseViewWidth` acts on the focused part, so the remaining steps
     * would otherwise shrink the editor group.
     */
    private async handleFullEdit(): Promise<void> {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }
        const filePath = artifact.filePath;
        this.dispose();
        await this.narrowed;
        void vscode.commands.executeCommand(EDIT_ARTIFACT_COMMAND_ID, filePath);
    }
}
