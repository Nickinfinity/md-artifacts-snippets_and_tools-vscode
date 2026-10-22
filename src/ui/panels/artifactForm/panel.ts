import * as vscode from 'vscode';
import { buildFormHtml } from './form.html.js';
import { FORM_CLIENT_JS } from './form.clientJs.js';
import { defaultModel } from './form.helpers.js';
import { pruneVarsForSave, confirmDiscardDraft, deleteWithConfirm, saveToEngine } from './panel.helpers.js';
// Import cycle with editArtifact.command.ts is safe: the constant is read only at call time, never at module load.
import { EDIT_ARTIFACT_COMMAND_ID } from '../../../commands/editArtifact.command.js';
import { FormBlockExpandController } from './blockExpand.js';
import { extractVars } from '../../../services/parser.service.js';
import { validateArtifactFilename } from '../../../services/filename.service.js';
import { getNonce } from '../../../utils/helpers.js';
import { getEntry, getTypeSingular } from '../../../services/artifact-type-config.service.js';
import { renderCodeRowsHtml } from '../../../services/render.service.js';
import { buildCodeBlockHtml } from '../artifactPicker/codeBlock.js';
import type { EngineRead } from '../../../engine/model.js';
import type { ArtifactType } from '../../../types/parsed-artifact.types.js';
import type { ArtifactFormModel } from '../../../types/artifact-form.types.js';

// ── Public API ────────────────────────────────────────────────────────────────

const FORM_VIEW_TYPE = 'md-artifacts.artifactForm';

/**
 * Options for opening the Artifact Form panel.
 *
 * @example
 * openArtifactFormPanel(context, { mode: 'create', type: 'Snippet' })
 */
export interface OpenFormOpts {
    /** `'create'` or `'edit'` — only create implemented; edit seam marked. */
    mode: 'create' | 'edit';
    /** Artifact type to create/edit. */
    type: ArtifactType;
    /** Optional prefilled model (e.g. from editor selection — Phase 7). */
    prefill?: Partial<ArtifactFormModel>;
    /** Edit-mode seam — source file URI. Not used in create mode. */
    sourceUri?: vscode.Uri;
    /** Edit mode: the engine read that opened the form (path, hash, layout) — the write is made against its hash. */
    read?: EngineRead;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let currentController: ArtifactFormController | undefined;

/** What `openArtifactFormPanel` should do for a given call. */
export type FormPanelAction = 'create' | 'reveal' | 'retarget' | 'confirm-then-retarget';

/**
 * Decides how `openArtifactFormPanel` handles a call, given the current panel
 * state. Pure, so the rule is testable without an extension host — the panel
 * itself stays `vscode`-coupled and is checked at the F5 gate.
 *
 * The case this exists for (D5): the singleton used to `reveal()` and **drop
 * `opts` entirely**, so the second capture in a session silently reopened the
 * *first* capture's form. Every create-from-context path routes through this
 * one call, so fixing it here fixes all five rather than five times.
 *
 * @param args - Whether a panel exists, whether this call carries a prefill,
 *               and whether the open form has unsaved edits.
 * @returns The action to take.
 *
 * @example
 * decideFormPanelAction({ hasController: false, hasPrefill: false, isDirty: false }); // → 'create'
 * decideFormPanelAction({ hasController: true,  hasPrefill: true,  isDirty: true  }); // → 'confirm-then-retarget'
 */
export function decideFormPanelAction(args: {
    hasController: boolean;
    hasPrefill: boolean;
    isDirty: boolean;
}): FormPanelAction {
    if (!args.hasController) { return 'create'; }
    // No prefill — a bare "open the form" request. Revealing is right; there is
    // nothing new to show, so never prompt about unsaved work here.
    if (!args.hasPrefill) { return 'reveal'; }
    return args.isDirty ? 'confirm-then-retarget' : 'retarget';
}

/**
 * Builds the panel title for a type.
 *
 * @param type - The artifact type the form is targeting.
 * @returns The window title.
 * @example
 * panelTitle('Snippet', 'create'); // → 'MD Artifacts: Create Snippets'
 * panelTitle('Snippet', 'edit');   // → 'MD Artifacts: Edit Snippets'
 */
function panelTitle(type: ArtifactType, mode: OpenFormOpts['mode']): string {
    // type always comes from getCreateFormTypes(), so the lookup cannot miss.
    const name = getEntry(type).name;
    return mode === 'edit'
        ? vscode.l10n.t('MD Artifacts: Edit {0}', name)
        : vscode.l10n.t('MD Artifacts: Create {0}', name);
}

/**
 * Builds the form model for a set of open options.
 *
 * @param opts - The open options, possibly carrying a prefill.
 * @returns A complete model — prefill merged onto the type's defaults.
 * @example
 * buildModel({ mode: 'create', type: 'Snippet' });
 */
function buildModel(opts: OpenFormOpts): ArtifactFormModel {
    // Merge prefill (Partial) onto defaultModel base so required fields
    // (type/title/description/tags) always present; prefill.blocks wins.
    return opts.prefill
        ? { ...defaultModel(opts.type), ...opts.prefill }
        : defaultModel(opts.type);
}

/**
 * Confirms replacing an unsaved form, then retargets it.
 *
 * Cancel and Escape both leave the open form untouched — `showWarningMessage`
 * resolves `undefined` for either, so the single equality check covers both.
 *
 * @param ctrl - The live controller.
 * @param opts - The incoming capture's options.
 * @returns Resolves once the user has answered.
 * @example
 * void confirmThenRetarget(controller, { mode: 'create', type: 'Template', prefill });
 */
async function confirmThenRetarget(ctrl: ArtifactFormController, opts: OpenFormOpts): Promise<void> {
    const replaceAction = vscode.l10n.t('Replace');
    const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Replace the unsaved form?'),
        { modal: true, detail: vscode.l10n.t('The artifact form has unsaved changes. Replacing it discards them.') },
        replaceAction,
    );
    if (choice === replaceAction) { ctrl.retarget(opts); }
}

/**
 * Opens the Artifact Form panel for create (or edit) mode.
 *
 * If the panel is already open, reveals it rather than spawning a new one.
 * The panel owns its own lifecycle; callers should not hold any reference.
 *
 * @param context - Extension context for resource roots and subscriptions.
 * @param opts    - See `OpenFormOpts`.
 *
 * @example
 * openArtifactFormPanel(context, { mode: 'create', type: 'Snippet' });
 */
export function openArtifactFormPanel(
    context: vscode.ExtensionContext,
    opts: OpenFormOpts,
): void {
    const action = decideFormPanelAction({
        hasController: currentController !== undefined,
        hasPrefill:    opts.prefill !== undefined,
        isDirty:       currentController?.isDirty ?? false,
    });

    switch (action) {
        case 'create':
            currentController = new ArtifactFormController(context, opts);
            currentController.open();
            return;
        case 'reveal':
            currentController?.reveal();
            return;
        case 'retarget':
            currentController?.retarget(opts);
            return;
        case 'confirm-then-retarget':
            if (currentController) { void confirmThenRetarget(currentController, opts); }
            return;
    }
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Owns the Artifact Form `WebviewPanel` lifecycle, message routing, and the
 * atomic save flow (§4.5): folder pick → filename prompt → serialize →
 * write (with collision resolution).
 *
 * Singleton enforced via module-level `currentController`. Second invocation of
 * `openArtifactFormPanel` reveals the existing panel.
 *
 * @example
 * const ctrl = new ArtifactFormController(context, opts);
 * ctrl.open();
 */
class ArtifactFormController {
    private panel: vscode.WebviewPanel | undefined;
    private dirty  = false;
    private subs: vscode.Disposable[] = [];
    private blockExpand: FormBlockExpandController | undefined;

    private model: ArtifactFormModel;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private opts:    OpenFormOpts,
    ) {
        // edit-mode seam: hydrate from sourceUri — not implemented, seam only
        this.model = buildModel(opts);
    }

    /**
     * Creates the webview panel and wires message + dispose subscriptions.
     *
     * @example
     * controller.open();
     */
    open(): void {
        const title = panelTitle(this.opts.type, this.opts.mode);

        this.panel = vscode.window.createWebviewPanel(
            FORM_VIEW_TYPE,
            title,
            vscode.ViewColumn.Active,
            {
                enableScripts:            true,
                retainContextWhenHidden:  true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'src', 'ui')],
            },
        );

        this.render();

        this.subs.push(
            this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg as Record<string, unknown>)),
            this.panel.onDidDispose(() => this.onDisposed()),
        );
    }

    /**
     * Opens one block in a real editor tab, and folds the saved text back into
     * the model when the user saves it.
     *
     * Composed as a **callback bag**, never by handing the controller a
     * reference to this panel — the rule the picker's controllers already
     * follow. The controller therefore knows nothing about the form, and the
     * form knows nothing about temp files.
     *
     * @param index - Index of the block to expand.
     * @returns Resolves once the editor tab has opened.
     *
     * @example
     * void controller.handleExpandBlock(0);
     */
    private async handleExpandBlock(index: number): Promise<void> {
        this.blockExpand ??= new FormBlockExpandController({
            storageUri: this.context.storageUri ?? this.context.globalStorageUri,
            getBlock: (i) => this.model.blocks[i],
            onSaved: (i, code) => {
                const block = this.model.blocks[i];
                if (!block) { return; }
                block.code = code;
                this.dirty = true;
                // The webview owns the rendered code area, so push the new text
                // rather than re-rendering the whole form and losing focus.
                void this.panel?.webview.postMessage({ command: 'blockUpdated', index: i, code });
            },
            getViewColumn: () => this.panel?.viewColumn,
        });
        await this.blockExpand.start(index);
    }

    /**
     * Whether the open form has unsaved edits.
     *
     * @returns `true` when the webview has reported a change since the last render.
     * @example
     * if (controller.isDirty) { /* confirm before replacing *\/ }
     */
    get isDirty(): boolean { return this.dirty; }

    /**
     * Points the open form at a new capture — **type as well as model**.
     *
     * The type drives the language mode, the multi-block affordance and which
     * type-only field section renders, so swapping only the model would leave
     * one type's chrome around another type's content (Snippet form open, user
     * right-clicks a file for Template). Replacing `opts` and re-rendering the
     * whole body is the smallest change that cannot produce that mismatch.
     *
     * Resets `dirty`: the freshly rendered content is exactly what the capture
     * supplied, so there is nothing unsaved yet.
     *
     * @param opts - The incoming capture's open options.
     * @example
     * controller.retarget({ mode: 'create', type: 'Template', prefill });
     */
    retarget(opts: OpenFormOpts): void {
        this.opts  = opts;
        this.model = buildModel(opts);
        this.dirty = false;
        if (this.panel) { this.panel.title = panelTitle(opts.type, opts.mode); }
        this.render();
        this.reveal();
    }

    /**
     * Brings the existing panel back into view.
     *
     * @example
     * controller.reveal();
     */
    reveal(): void { this.panel?.reveal(vscode.ViewColumn.Active); }

    /**
     * Disposes the webview panel and clears the singleton reference.
     *
     * @example
     * controller.dispose();
     */
    dispose(): void { this.panel?.dispose(); }

    // ── Private ───────────────────────────────────────────────────────────────

    private onDisposed(): void {
        this.subs.forEach(s => s.dispose());
        this.subs      = [];
        this.panel     = undefined;
        // Watchers go before the target they post into: tear the block-expand
        // controller down first, or its save watcher posts into a disposed webview.
        void this.blockExpand?.teardown();
        this.blockExpand = undefined;
        currentController = undefined;
    }

    private render(): void {
        if (!this.panel) { return; }
        const nonce  = getNonce();
        // Order matters — base.css carries the global reset. No hljs.css: those
        // rules are all .popup-body-scoped and never applied to this panel.
        const cssUri = ['base.css', 'form.css', 'code-block.css'].map(
            f => this.panel!.webview.asWebviewUri(
                vscode.Uri.joinPath(this.context.extensionUri, 'src', 'ui', f),
            ).toString(),
        );
        this.panel.webview.html = buildFormHtml({
            model:        this.model,
            cspSource:    this.panel.webview.cspSource,
            cssUri,
            nonce,
            codeBlockHtml: (code, lang) => buildCodeBlockHtml(renderCodeRowsHtml(code, lang), lang),
            clientJs:     FORM_CLIENT_JS,
        });
    }

    private post(msg: unknown): void {
        void this.panel?.webview.postMessage(msg);
    }

    // ── Message router ────────────────────────────────────────────────────────

    private handleMessage(msg: Record<string, unknown>): void {
        switch (msg['command']) {
            case 'markDirty':    this.dirty = true; break;
            case 'addBlock':     break;  // locally handled in client JS; no-op here
            case 'validateName': this.handleValidateName(String(msg['name'] ?? '')); break;
            case 'detectVars':   this.handleDetectVars(Number(msg['blockIndex']), String(msg['code'] ?? '')); break;
            case 'removeBlock':  void this.handleRemoveBlock(Number(msg['blockIndex'])); break;
            case 'deleteEntire': void this.handleDeleteEntire(); break;
            case 'cancel':       void this.handleCancel(Boolean(msg['dirty'])); break;
            case 'save':         void this.handleSave(msg['model'] as ArtifactFormModel); break;
            case 'expandBlock':  void this.handleExpandBlock(Number(msg['index'])); break;
        }
    }

    private handleValidateName(name: string): void {
        const result = validateArtifactFilename(name);
        this.post({ command: 'nameValidation', ok: result.ok, reason: result.reason });
    }

    private handleDetectVars(blockIndex: number, code: string): void {
        const vars = extractVars(code);
        this.post({ command: 'varsDetected', blockIndex, vars });
    }

    private async handleRemoveBlock(blockIndex: number): Promise<void> {
        const singular = getTypeSingular(this.opts.type);
        const deleteAction = vscode.l10n.t('Delete');
        const answer   = await vscode.window.showWarningMessage(
            vscode.l10n.t('This {0} block will be deleted. Continue?', singular),
            { modal: true },
            deleteAction,
        );
        this.post({ command: 'removeBlockConfirmed', blockIndex, confirmed: answer === deleteAction });
    }

    /**
     * Handles the Delete Artifact button.
     *
     * Two different actions behind one label, because the label is honest in
     * both cases: in **edit** mode there is a file on disk and "delete" must
     * remove it, while in **create** mode nothing has been written yet, so the
     * only thing to delete is the draft.
     *
     * The file deletion goes through the engine and is permanent; the confirm says so.
     *
     * @returns Resolves once the user has answered and any deletion is done.
     */
    private async handleDeleteEntire(): Promise<void> {
        const sourceUri = this.opts.mode === 'edit' ? this.opts.sourceUri : undefined;
        const done = sourceUri
            ? await deleteWithConfirm(sourceUri, this.opts.read)
            : await confirmDiscardDraft(getTypeSingular(this.opts.type));
        if (!done) {
            this.post({ command: 'deleteEntireConfirmed', confirmed: false });
            return;
        }
        this.dispose();
    }

    private async handleCancel(dirty: boolean): Promise<void> {
        if (!dirty) { this.dispose(); return; }
        const discardAction = vscode.l10n.t('Discard');
        const answer = await vscode.window.showWarningMessage(
            vscode.l10n.t('Discard unsaved changes?'),
            { modal: true },
            discardAction,
        );
        if (answer === discardAction) {
            this.dispose();
        } else {
            this.post({ command: 'cancelConfirmed', confirmed: false });
        }
    }

    // ── Atomic save flow (§4.5) ───────────────────────────────────────────────

    private async handleSave(model: ArtifactFormModel): Promise<void> {
        const pruned = { ...model, blocks: pruneVarsForSave(model.blocks) };
        const { sourceUri } = this.opts;
        const reload = () => {
            this.dispose();
            if (sourceUri) { void vscode.commands.executeCommand(EDIT_ARTIFACT_COMMAND_ID, sourceUri.fsPath); }
        };
        if (await saveToEngine(pruned, this.opts, reload)) { this.dispose(); return; }
        // No `error`: the engine path already told the user (modal / toast); this only re-enables Save.
        this.post({ command: 'saveResult', ok: false });
    }
}
