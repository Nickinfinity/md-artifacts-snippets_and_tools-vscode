import * as vscode from 'vscode';
import { parseFromContent, resolveVars } from '../../../services/parser.service.js';
import { renderCodeHtml, renderCodeRowsHtml } from '../../../services/render.service.js';
import { writesWholeFile, isTerminalOnly } from '../../../services/artifact-type-config.service.js';
import { patchFrontmatterField, patchVarDefaults, type BlockRef } from '../../../services/artifact-patcher.service.js';
import { PreviewModeController, type SectionKey } from '../../../services/preview-mode.service.js';
import { getNonce } from '../../../utils/helpers.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import { out } from './shared.js';
import { performInsert, persistBlockCode, sanitiseVarsSnapshot, hasVisibleEditor, type InvocationSurface } from './preview.helpers.js';
import { confirmModal } from '../../../services/confirm.service.js';
import type { WebviewHost, HostMessage } from './webviewHost.js';
import type { MainViewPreviewState } from '../../views/mainView.preview.js';
import { renderPreviewHtml, renderMultiBlockPreviewHtml, renderPopupEmptyHtml, mergeVarsWithDefaults } from './preview.render.js';
import { BlockEditController } from './blockEditor.js';
import { VarSetController } from './varSetController.js';
import { runCreateFileFlow, toBatchOutcome } from './preview.createFile.js';
import { BatchGate } from './preview.batch.js';
import { isIndexArtifact } from '../../../services/multi-index.service.js';
import { PaneWidthController, type PaneMetrics } from '../../../services/pane-width.service.js';
import { getPreviewWidthSteps, getVariablesHeightFraction, setVariablesHeightFraction } from '../../../services/config.service.js';
import { varsHeightCss } from '../../../services/pane-layout.service.js';
import { EDIT_ARTIFACT_COMMAND_ID } from '../../../commands/editArtifact.command.js';
import { setPreviewTarget } from '../../../services/preview-target.service.js';
import type { BatchOutcome } from '../../../types/multi-index.types.js';

// Re-export the adapter so the navigator does not need to import preview.helpers directly.
export { blockAsArtifact } from './preview.helpers.js';

/** How long a pane measurement may take before the widen loop gives up on the view. */
const MEASURE_TIMEOUT_MS = 600;

/** Callback bag the controller uses to push state back to the navigator. */
export interface PreviewCallbacks {
    extensionUri: vscode.Uri;
    rootFs: string;
    targetEditor: vscode.TextEditor | undefined;
    /** Updates the navigator's parse cache after a save round-trip. */
    setCache: (uri: vscode.Uri, parsed: ParsedArtifactFile) => void;
    /** Notifies the navigator that the preview session has ended. */
    onDispose: () => void;
    /**
     * The webview transport the preview renders into — the main pane
     * (Wave 7). Queues posts while the pane is hidden and distinguishes a
     * hide-dispose from a real teardown (H1/H2).
     */
    host: WebviewHost;
    /**
     * Reveals the main pane, waits for `resolveWebviewView` to have fired,
     * and attaches the live view to {@link host} (H3).
     *
     * Awaiting the reveal command alone is not enough — it settles when the
     * reveal completes, not when the provider callback runs (ledger #116).
     */
    ensureView: () => Promise<void>;
    /** Returns the pane to `idle` when the preview ends (Cancel, Insert, Create File). */
    endPreview: () => void;
    /**
     * Renders a preview state into the pane.
     *
     * The provider is the **single writer** of `webview.html` — routing HTML
     * through it rather than `host.setHtml` keeps one renderer for the pane's
     * two modes instead of two writers racing the same property.
     */
    showPreviewState: (state: MainViewPreviewState) => void;
    /** Subscribes to inbound webview messages; the provider owns the webview. */
    onWebviewMessage: (handler: (msg: Record<string, unknown>) => void) => vscode.Disposable;
    /** Closes the QuickPick (called from `handleInsert`). */
    closePicker: () => void;
    /** Extension storage dir for block-edit temp files (`context.storageUri ?? globalStorageUri`). */
    storageUri: vscode.Uri;
    /** Explorer URI a Template was invoked on (D2); `undefined` for non-template flows. */
    destUri?: vscode.Uri;
    /** Which context-menu surface the insert command was invoked from (T3); threaded to `performInsert`. */
    invocationSurface: InvocationSurface;
}

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
    private cssUri: string[] = [];
    private cspSource = '';
    private currentArtifact: ParsedArtifactFile | undefined;
    private modeController: PreviewModeController | undefined;
    private msgSub: vscode.Disposable | undefined;
    private readonly blockEdit: BlockEditController;
    private readonly varSet:    VarSetController;
    private readonly batch = new BatchGate();  // one-shot per-step gate a MultiIndexRunner arms (T4)
    /** Releases this preview's claim on the Variables-pane target; see `claimTarget` (H1.4). */
    private releaseTarget: (() => void) | undefined;
    /** Latest values the webview reported, so `currentValues()` stays synchronous (H1.4). */
    private varsSnapshot: Record<string, string> = {};
    /**
     * Widens the pane for the session and narrows it back by the same count.
     *
     * Built here rather than injected because the navigator constructs one
     * controller per picker invocation, so the configured step count is
     * re-read on every insert instead of being frozen at activation.
     */
    private readonly paneWidth = new PaneWidthController(
        async id => { await vscode.commands.executeCommand(id); },
        getPreviewWidthSteps(),
        () => this.measurePane(),
    );
    /**
     * Resolver for an in-flight `measurePane` round trip.
     *
     * The measurement rides the **session** message handler rather than a
     * subscription of its own: `onWebviewMessage` is a single-handler setter,
     * not a multicast event, so a second subscriber silently replaces the
     * first and disposing it clears the handler outright — which killed
     * Cancel, Edit and Insert.
     */
    private pendingMeasure: ((m: PaneMetrics | undefined) => void) | undefined;
    /** Which fence in the source `.md` this preview's code belongs to. */
    private currentBlockRef: BlockRef = { kind: 'single' };
    /**
     * Latest staged code from the expanded editor, if any.
     *
     * Staged, not written: the preview's own code area and the expanded editor
     * are two views of one block, and neither is permanent until Overwrite.
     */
    private stagedCode: string | undefined;

    /**
     * Watches for editor tabs opening/closing while a preview is open, so
     * Insert can appear the moment there is somewhere to insert into.
     *
     * `visibleTextEditors`, not `activeTextEditor`: the latter goes `undefined`
     * whenever a webview takes focus, which would hide Insert exactly while the
     * user is working in this pane. Disposed in `dispose()` beside `msgSub`.
     */
    private editorsSub: vscode.Disposable | undefined;

    constructor(private readonly cb: PreviewCallbacks) {
        this.blockEdit = new BlockEditController({
            rootFs:              cb.rootFs,
            storageUri:          cb.storageUri,
            getCurrentArtifact:  () => this.currentArtifact,
            setCurrentArtifact:  a => { this.currentArtifact = a; },
            setCache:            cb.setCache,
            postMessage:         msg => { this.postToWebview(msg); },
            getViewColumn:       () => undefined,
            onCodeStaged:        code => { this.stageCode(code); },
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
        void this.paneWidth.restoreAfterPreview();
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
        this.stagedCode = undefined;
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
        this.postVarsHeight();
        void this.paneWidth.widenForPreview();
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
        void this.paneWidth.widenForPreview();
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

    // ── Internal: webview message routing ─────────────────────────────────────

    /**
     * Asks the webview how wide it is, with its own one-shot subscription.
     *
     * The extension host has no way to read a `WebviewView`'s width, but the
     * webview is a real DOM and can measure itself. This uses a subscription
     * of its own rather than the session handler because the widen loop runs
     * alongside normal message traffic and must not consume it.
     *
     * @returns The reported metrics, or `undefined` if the view did not answer
     *          in time — a dead or hidden view must never hang an insert.
     *
     * @example
     * const m = await this.measurePane(); // { paneWidth: 312, availWidth: 1920 }
     */
    /**
     * Hands a `paneMetrics` reply to whatever measurement is in flight.
     *
     * @param msg - Raw webview message; ignored unless both widths are numbers.
     *
     * @example
     * this.resolveMeasure({ command: 'paneMetrics', paneWidth: 312, availWidth: 1920 });
     */
    private resolveMeasure(msg: Record<string, unknown>): void {
        const paneWidth  = msg.paneWidth;
        const availWidth = msg.availWidth;
        if (typeof paneWidth !== 'number' || typeof availWidth !== 'number') { return; }
        this.pendingMeasure?.({ paneWidth, availWidth });
    }

    /**
     * Asks the webview how wide it is and resolves with what it reports.
     *
     * Rides the **session** message handler (`pendingMeasure`) rather than a
     * subscription of its own — see the field's own note for why a second
     * subscriber is not an option here.
     *
     * @returns The metrics, or `undefined` when the view did not answer within
     *          {@link MEASURE_TIMEOUT_MS} — a dead or hidden view must never
     *          hang an insert.
     *
     * @example
     * const m = await this.measurePane(); // { paneWidth: 312, availWidth: 1920 }
     */
    private measurePane(): Promise<PaneMetrics | undefined> {
        return new Promise(resolve => {
            const finish = (value: PaneMetrics | undefined): void => {
                if (!this.pendingMeasure) { return; }
                this.pendingMeasure = undefined;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => { finish(undefined); }, MEASURE_TIMEOUT_MS);
            this.pendingMeasure = finish;
            this.cb.host.post({ command: 'measurePane' });
        });
    }

    // ── Internal: the Variables-pane seam (W1/H1.4) ───────────────────────────

    /** Registers this preview as the Variables pane's target for the session. */
    private claimTarget(): void {
        this.releaseTarget?.();
        this.releaseTarget = setPreviewTarget({
            applyVarSet: (subSetName, vars) => {
                this.varSet.showDiffFor(subSetName, vars, this.varsSnapshot);
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
            if (m.command === 'paneMetrics') { this.resolveMeasure(m); return; }
            void this.handleMessage(m);
        });
    }

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        const cmd = msg.command as string;
        if      (cmd === 'startEdit')     { this.modeController?.startEditingSection(msg.section as SectionKey); }
        else if (cmd === 'cancelEdit')    { this.modeController?.stopEditingSection(msg.section as SectionKey); }
        else if (cmd === 'quickEdit')     { this.modeController?.enterQuickEdit(); }
        else if (cmd === 'backToPreview') { this.modeController?.enterPreview(); }
        else if (cmd === 'fullEdit')      { this.handleFullEdit(); }
        else if (cmd === 'saveSection')   { await this.handleSaveSection(msg); }
        else if (cmd === 'insert')        { this.handleInsert(msg); }
        else if (cmd === 'copy')          { this.handleCopy(msg); }
        else if (cmd === 'editBlock')     { await this.handleEditBlock(); }
        else if (cmd === 'overwrite')     { await this.handleOverwrite(msg); }
        else if (cmd === 'varsHeightChanged') { await this.handleVarsHeightChanged(msg); }
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
     * behind it would show a stale copy of what the user is editing.
     */
    private handleFullEdit(): void {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }
        const filePath = artifact.filePath;
        this.dispose();
        void vscode.commands.executeCommand(EDIT_ARTIFACT_COMMAND_ID, filePath);
    }

    /**
     * Opens the previewed block as a temp file in the full editor.
     *
     * Reuses `BlockEditController` — the same machinery the button removed in
     * the previous pass drove, now reporting its save back as a staged edit
     * instead of writing to the vault.
     */
    private async handleEditBlock(): Promise<void> {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }
        await this.blockEdit.start(
            artifact,
            this.currentBlockRef,
            this.stagedCode ?? artifact.code,
            artifact.frontmatter.language,
        );
    }

    /**
     * Pushes the stored variables-section height into the pane.
     *
     * Sent as a message rather than baked into the HTML so the renderers stay
     * free of configuration reads — the same reason the width probe is a
     * message. `varsHeightCss` is the one place a fraction becomes a CSS value.
     */
    private postVarsHeight(): void {
        this.postToWebview({ command: 'setVarsHeight', value: varsHeightCss(getVariablesHeightFraction()) });
    }

    /**
     * Persists a height the user dragged to.
     *
     * The webview sends a raw fraction it computed from a pointer position;
     * `setVariablesHeightFraction` clamps it, so an out-of-range drag settles
     * to the default rather than storing a pane-swallowing value. The clamped
     * result is echoed back so the pane shows what was actually stored.
     *
     * @param msg - Webview message carrying `fraction`.
     */
    private async handleVarsHeightChanged(msg: Record<string, unknown>): Promise<void> {
        await setVariablesHeightFraction(msg.fraction);
        this.postVarsHeight();
    }

    /**
     * Records a staged edit and reflects it in the pane.
     *
     * @param code - The new block text.
     */
    private stageCode(code: string): void {
        this.stagedCode = code;
        this.postToWebview({ command: 'codeStaged', code });
    }

    /**
     * Makes the staged edit permanent, behind a confirmation.
     *
     * The write itself is `persistBlockCode` — the one place block code is
     * patched into a `.md` — so this method only owns the confirmation and the
     * post-write refresh.
     *
     * @param msg - Webview message carrying the current `code`.
     */
    private async handleOverwrite(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }
        const code = typeof msg.code === 'string' ? msg.code : this.stagedCode;
        if (typeof code !== 'string') { return; }

        const name = artifact.relativePath || artifact.fileName;
        // `confirmModal` itself does the equality check internally
        // (`answer === opts.action`), so a local binding here is safe without
        // a second comparison site — and it must be local, not module-scope,
        // so `vscode.l10n.t` runs after the bundle is loaded.
        const OVERWRITE_ACTION = vscode.l10n.t('Overwrite');
        const ok = await confirmModal({
            message: vscode.l10n.t('Overwrite "{0}" with these changes?', name),
            detail:  vscode.l10n.t('The edited block replaces what is currently in the .md file.'),
            action:  OVERWRITE_ACTION,
        });
        if (!ok) { return; }

        const sourceUri = vscode.Uri.file(artifact.filePath);
        const updated = await persistBlockCode({
            sourceUri,
            blockRef: this.currentBlockRef,
            newCode:  code,
            rootFs:   this.cb.rootFs,
        });
        if (!updated) {
            // `persistBlockCode` also answers undefined when the patch was a
            // no-op, which is the "nothing changed" case rather than a failure.
            vscode.window.showWarningMessage(vscode.l10n.t('Nothing was written — the code is unchanged, or the block could not be located in the file.'));
            return;
        }

        this.cb.setCache(sourceUri, updated);
        this.stagedCode = undefined;
        this.postToWebview({ command: 'overwriteDone' });
        out.appendLine(`[pane] overwrite → ${artifact.fileName}`);
    }

    private async handleSaveSection(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }
        const fileUri = vscode.Uri.file(artifact.filePath);
        const section = msg.section as string;
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            let content = new TextDecoder().decode(bytes);
            if (section === 'varDefaults') {
                content = patchVarDefaults(content, msg.value as Record<string, string>);
            } else {
                content = patchFrontmatterField(content, section, msg.value as string);
            }
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
            const updated = parseFromContent(content, fileUri.fsPath, this.cb.rootFs);
            this.cb.setCache(fileUri, updated);
            this.currentArtifact = updated;
            this.modeController?.stopEditingSection(section as SectionKey);
            // sectionSaved before fileUpdated so the webview exits edit mode first,
            // then fileUpdated can safely update all non-editing sections.
            this.cb.host.post({ command: 'sectionSaved', section, success: true });
            this.cb.host.post({ command: 'fileUpdated', artifact: updated });
        } catch {
            this.cb.host.post({ command: 'sectionSaved', section, success: false });
        }
    }

    private handleInsert(msg: Record<string, unknown>): void {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }

        // Index guard (F7): a hovered index still renders Create File — only an armed run may write it.
        if (isIndexArtifact(artifact.frontmatter) && !this.batch.isArmed) {
            void vscode.window.showInformationMessage(vscode.l10n.t('This is a template index — press Enter in the picker to run it.')); return;
        }
        // Templates/agent configs write a whole file instead of inserting at the
        // cursor; `writesWholeFile` is the single source shared with the label.
        if (writesWholeFile(artifact.frontmatter.artifactType)) {
            void this.handleCreateFile(msg, artifact);
            return;
        }

        const code         = this.resolveInsertCode(msg, artifact);
        const resolvedVars = mergeVarsWithDefaults(msg.vars as Record<string, string>, artifact.vars);

        void performInsert(this.cb.targetEditor, { ...artifact, code }, resolvedVars, this.cb.invocationSurface);
        this.dispose();
        this.cb.closePicker();
    }

    /**
     * Copies the resolved code to the clipboard — every artifact type, no
     * `writesWholeFile` / `isIndexArtifact` branching (T2 — the button is
     * universal by design). Resolution mirrors `handleInsert`: the same
     * `resolveInsertCode` + `mergeVarsWithDefaults` → `resolveVars` chain,
     * so Copy and Insert never disagree on what "this artifact" means.
     * @param msg - `{ code, vars }` posted by the webview's Copy button.
     * @example this.handleCopy({ code: 'ping <VK-host>', vars: { 'VK-host': 'db' } });
     */
    private handleCopy(msg: Record<string, unknown>): void {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }
        const code         = this.resolveInsertCode(msg, artifact);
        const resolvedVars = mergeVarsWithDefaults(msg.vars as Record<string, string>, artifact.vars);
        // Chained, not fire-and-forget: a remote/SSH host can reject the write, and the
        // toast must not claim success when it did (reviewer finding 1).
        void vscode.env.clipboard.writeText(resolveVars(code, resolvedVars))
            .then(() => vscode.window.showInformationMessage(vscode.l10n.t('MD Artifacts: Copied to clipboard.')));
    }

    /** Routes to the Create File flow (D12); armed (batch step) pins `destDir`, skips
     *  the tab-open (D7), and settles the gate instead of closing the panel/picker. */
    private async handleCreateFile(msg: Record<string, unknown>, artifact: ParsedArtifactFile): Promise<void> {
        const code = this.resolveInsertCode(msg, artifact);
        const vars = mergeVarsWithDefaults(msg.vars as Record<string, string>, artifact.vars);
        const result = await runCreateFileFlow({
            artifact, code, vars, destDir: this.batch.destDir,
            destUri: this.cb.destUri, openAfterWrite: !this.batch.isArmed,
        });
        if (this.batch.isArmed) { this.batch.settle(toBatchOutcome(result, vars)); return; }
        if (result.kind === 'written') { this.dispose(); this.cb.closePicker(); }
    }

    /**
     * Canonical code source for `Insert`: fullEdit mode → live `.md` document;
     * else `msg.code` from the webview; fallback → `artifact.code`.
     */
    private resolveInsertCode(msg: Record<string, unknown>, artifact: ParsedArtifactFile): string {
        const mode = this.modeController?.mode ?? 'preview';
        if (mode === 'fullEdit') {
            const fileUri = vscode.Uri.file(artifact.filePath);
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
            if (openDoc) {
                return parseFromContent(openDoc.getText(), artifact.filePath, this.cb.rootFs).code;
            }
        }
        return typeof msg.code === 'string' ? msg.code : artifact.code;
    }
}

