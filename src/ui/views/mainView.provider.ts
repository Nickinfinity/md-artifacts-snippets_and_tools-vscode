import * as vscode from 'vscode';
import { getNonce } from '../../utils/helpers.js';
import {
    buildCreateItems,
    buildBrowseItems,
    renderIdleHtml,
    resolveCreateCommandId,
    resolveBrowseCommandId,
    SETTINGS_COMMAND_ID,
} from './mainView.render.js';
import { renderMainViewPreviewHtml, type MainViewPreviewState, type ViewTarget } from './mainView.preview.js';
import type { DisposableLike, UriLike, WebviewHostTarget } from '../panels/artifactPicker/webviewHost.js';

/** The main pane's two render modes. */
type MainViewMode = 'idle' | 'preview';

/**
 * Stylesheets for `idle` mode — the pane's own set, and no more.
 *
 * Deliberately **not** merged with {@link PREVIEW_STYLE_FILES}: `picker.css`
 * styles `.btn`/`.actions`/`.input-row`, which the create rows also use, so
 * loading the preview set here would restyle a pane that already renders
 * correctly. Two modes, two sheet lists, no shared-superset compromise — that
 * argument is about *which* sheets, not how many, and it still holds after W3
 * added a third.
 *
 * `main-pane.css` (W3/T3.2) carries the filter input, the New/Open toggle and
 * the `.create-row[hidden]` rule the filter depends on. **Until it appears in
 * this array every rule in that sheet is dead** and no test can tell — its
 * guard reads the file off disk as a string, so "styled" and "never loaded"
 * look identical to the suite. This list is the only thing that loads it.
 */
const IDLE_STYLE_FILES = ['base.css', 'codicon.css', 'main-pane.css'];

/**
 * Stylesheets for `preview` mode — the popup's five, plus the narrow-pane sheet.
 *
 * **Order is load-bearing and pinned by `test/main-view-styles.test.ts`.** It
 * mirrors `preview.ts`'s array so the relocated preview inherits byte-identical
 * styling, with `main-view.css` **last**: every rule in it is single-class
 * specificity, so it overrides `picker.css` by source order alone. Drop
 * `picker.css` and the narrow-pane rules have nothing to override; move
 * `main-view.css` earlier and the reflow silently stops applying (ledger #109).
 */
const PREVIEW_STYLE_FILES = ['base.css', 'picker.css', 'code-block.css', 'hljs.css', 'varset.css', 'main-view.css'];

/** Sheet list for a mode — exported so the drift guard reads them from here. */
export const STYLE_FILES_BY_MODE: Readonly<Record<MainViewMode, readonly string[]>> = {
    idle:    IDLE_STYLE_FILES,
    preview: PREVIEW_STYLE_FILES,
};

/**
 * Narrows an inbound webview message to the `createType` shape.
 *
 * A webview message is untrusted input (it crosses a postMessage boundary),
 * so this checks shape only — `type` is validated downstream by
 * `resolveCreateCommandId`, which answers `undefined` for anything that is
 * not a create-form `ArtifactType`.
 *
 * @param message - Raw message from `webview.onDidReceiveMessage`.
 * @returns `true` when `message` has `{ command: 'createType', type: string }`.
 *
 * @example
 * isCreateTypeMessage({ command: 'createType', type: 'Snippet' }) // → true
 */
function isCreateTypeMessage(message: unknown): message is { command: 'createType'; type: string } {
    if (typeof message !== 'object' || message === null) {
        return false;
    }
    const m = message as Record<string, unknown>;
    return m.command === 'createType' && typeof m.type === 'string';
}

/**
 * Resolves an idle-mode row click to the command it should run.
 *
 * The three idle messages are routed in one place so `handleMessage` stays a
 * two-branch dispatcher: anything this does not claim falls through to the
 * preview session's handler. Every `type` is gated by the resolver that owns
 * its list, so a webview naming an unknown type resolves to nothing rather
 * than to an unregistered command id.
 *
 * @param message - Raw webview message.
 * @returns The command id to execute, or `undefined` if this is not an idle-row message.
 *
 * @example
 * resolveIdleCommandId({ command: 'openSettings' }) // → 'md-artifacts.settings'
 */
function resolveIdleCommandId(message: unknown): string | undefined {
    if (typeof message !== 'object' || message === null) {
        return undefined;
    }
    const m = message as Record<string, unknown>;
    if (m.command === 'openSettings') {
        return SETTINGS_COMMAND_ID;
    }
    if (typeof m.type !== 'string') {
        return undefined;
    }
    if (isCreateTypeMessage(message)) {
        return resolveCreateCommandId(message.type);
    }
    if (m.command === 'browseType') {
        return resolveBrowseCommandId(m.type);
    }
    return undefined;
}

/**
 * Provides the main activity-bar pane — `MainViewProvider.viewType`.
 *
 * A single webview with two modes rather than a `TreeDataProvider`: `idle`
 * (the create list) and `preview` (the relocated insert preview), so the same
 * view keeps its content across the mode switch instead of being torn down
 * and rebuilt.
 *
 * Thin wiring only — row data and HTML come from the pure functions in
 * `mainView.render.ts` and `mainView.preview.ts`.
 *
 * @example
 * const provider = new MainViewProvider(context.extensionUri);
 * context.subscriptions.push(
 *   vscode.window.registerWebviewViewProvider(MainViewProvider.viewType, provider),
 * );
 */
export class MainViewProvider implements vscode.WebviewViewProvider {
    /** The view id declared in `package.json`'s `contributes.views` — the one static mirror. */
    static readonly viewType = 'md-artifacts.mainView';

    private view?: vscode.WebviewView;
    private mode: MainViewMode = 'idle';
    private previewState: MainViewPreviewState = { kind: 'empty' };
    /** Extra inbound-message handler owned by the preview controller, if any. */
    private previewMessageHandler: ((msg: Record<string, unknown>) => void) | undefined;

    /** Resolves when `resolveWebviewView` next fires — see {@link armResolution}. */
    private viewResolved!: Promise<void>;
    private markResolved!: () => void;

    /**
     * @param extensionUri - Extension root URI, used to resolve `src/ui` assets.
     */
    constructor(private readonly extensionUri: vscode.Uri) {
        this.armResolution();
    }

    /**
     * Arms a fresh {@link viewResolved} promise.
     *
     * Re-armed on dispose because hiding a view via its context menu disposes
     * it: the next reveal resolves a **new** `WebviewView`, so a promise that
     * stayed settled from the previous session would let `focus()` return
     * before the new view exists.
     */
    private armResolution(): void {
        this.viewResolved = new Promise<void>(resolve => { this.markResolved = resolve; });
    }

    /**
     * Resolves the webview view: sets its options, wires the message handler,
     * renders the current mode, and releases anything awaiting {@link focus}.
     *
     * @param webviewView - The view instance VS Code hands the provider.
     *
     * @example
     * provider.resolveWebviewView(webviewView);
     */
    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'ui')],
        };
        webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
        webviewView.onDidDispose(() => {
            this.view = undefined;
            this.armResolution();
        });
        this.render();
        this.markResolved();
    }

    // ── Mode ─────────────────────────────────────────────────────────────────

    /**
     * Switches the pane's render mode and re-renders.
     *
     * @param mode - `'idle'` (create list) or `'preview'` (insert preview).
     *
     * @example
     * provider.setMode('preview');
     */
    setMode(mode: MainViewMode): void {
        this.mode = mode;
        this.render();
    }

    /**
     * Shows `state` in `preview` mode, switching mode if needed.
     *
     * @param state - What the preview should render.
     *
     * @example
     * provider.showPreview({ kind: 'single', artifact });
     */
    showPreview(state: MainViewPreviewState): void {
        this.previewState = state;
        this.setMode('preview');
    }

    /**
     * Ends the preview and returns the pane to the create list.
     *
     * Clears {@link previewState} so a later `setMode('preview')` cannot
     * re-render the previous artifact.
     *
     * @example
     * provider.endPreview();
     */
    endPreview(): void {
        this.previewState = { kind: 'empty' };
        this.setMode('idle');
    }

    // ── Resolution and hosting ───────────────────────────────────────────────

    /**
     * The {@link ViewTarget} `ensureView` needs, with a **live** `resolved`
     * thunk rather than a snapshot boolean.
     *
     * @returns A target whose `focus()` settles only once the view has resolved.
     *
     * @example
     * await ensureView(provider.viewTarget());
     */
    viewTarget(): ViewTarget {
        return {
            resolved: () => this.view !== undefined,
            focus:    () => this.focus(),
        };
    }

    /**
     * Reveals the pane and waits for `resolveWebviewView` to have fired.
     *
     * `executeCommand('<viewId>.focus')` settles when the **reveal** completes,
     * which is not the same event as the provider callback running — awaiting
     * only the command would satisfy `ensureView`'s type and miss its
     * postcondition, posting into a view that does not exist yet (ledger #116).
     *
     * @returns Resolves once the view is live.
     *
     * @example
     * await provider.focus();
     */
    async focus(): Promise<void> {
        if (this.view) {
            this.view.show?.(true);
            return;
        }
        await vscode.commands.executeCommand(`${MainViewProvider.viewType}.focus`);
        await this.viewResolved;
    }

    /**
     * Adapts the resolved view into the structural shape `WebviewHost` wants.
     *
     * A `WebviewView` splits the members across two objects — `visible`,
     * `onDidChangeVisibility` and `onDidDispose` live on the view, the rest on
     * `view.webview` — and it has **no** `onDidChangeViewState`, so visibility
     * is adapted into that slot.
     *
     * @returns The adapter, or `undefined` when the view has not resolved.
     *
     * @example
     * const target = provider.hostTarget();
     * if (target) { host.attachTarget(target); }
     */
    hostTarget(): WebviewHostTarget | undefined {
        const view = this.view;
        if (!view) {
            return undefined;
        }
        return {
            postMessage: message => view.webview.postMessage(message),
            get html(): string { return view.webview.html; },
            set html(value: string) { view.webview.html = value; },
            get cspSource(): string { return view.webview.cspSource; },
            asWebviewUri: (uri: UriLike) => view.webview.asWebviewUri(uri as vscode.Uri),
            get visible(): boolean { return view.visible; },
            onDidChangeViewState: (listener: () => void): DisposableLike =>
                view.onDidChangeVisibility(() => listener()),
            onDidDispose: (listener: () => void): DisposableLike =>
                view.onDidDispose(() => listener()),
        };
    }

    /**
     * Subscribes a handler to inbound webview messages.
     *
     * Held on the provider rather than on the webview, so it survives a
     * hide-dispose and the re-resolve that follows — the subscription made in
     * `resolveWebviewView` is rebuilt each time, but this handler is not.
     *
     * @param handler - Receives every message that is not a `createType` row click.
     * @returns A disposable that unsubscribes.
     *
     * @example
     * const sub = provider.onWebviewMessage(msg => route(msg));
     */
    onWebviewMessage(handler: (msg: Record<string, unknown>) => void): vscode.Disposable {
        this.previewMessageHandler = handler;
        return new vscode.Disposable(() => {
            if (this.previewMessageHandler === handler) {
                this.previewMessageHandler = undefined;
            }
        });
    }

    // ── Message handling ────────────────────────────────────────────────────

    /**
     * Handles a `createType` message by executing the derived base create
     * command for that type — the same `md-artifacts.create.<dir>`
     * id `insert.command.ts`'s `artifactCommandId` mirrors for insert.
     *
     * `resolveCreateCommandId` gates on `getCreateFormTypes()` membership, so
     * a message naming a non-create-form type (e.g. `Variables`) is dropped
     * rather than resolving to a command id that is never registered.
     *
     * @param message - Raw message from the webview.
     */
    private handleMessage(message: unknown): void {
        const commandId = resolveIdleCommandId(message);
        if (commandId) {
            void vscode.commands.executeCommand(commandId);
            return;
        }
        if (typeof message === 'object' && message !== null) {
            this.previewMessageHandler?.(message as Record<string, unknown>);
        }
    }

    // ── Render ───────────────────────────────────────────────────────────────

    /** Re-renders `webview.html` for the current mode. */
    private render(): void {
        if (!this.view) {
            return;
        }
        const webview = this.view.webview;
        const cssUris = STYLE_FILES_BY_MODE[this.mode].map(f =>
            webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', f)).toString(),
        );
        webview.html = this.mode === 'idle'
            ? renderIdleHtml(buildCreateItems(), cssUris, webview.cspSource, getNonce(), buildBrowseItems())
            : renderMainViewPreviewHtml(this.previewState, cssUris, webview.cspSource, getNonce());
    }
}

// ── Singleton accessor ───────────────────────────────────────────────────────

let activeProvider: MainViewProvider | undefined;

/**
 * Records the provider `extension.ts` registered, so code that cannot receive
 * it as a parameter can still reach the pane.
 *
 * Mirrors `varsetPicker.panel.ts`'s `getVarSetScanner()` — the repo's existing
 * idiom for one shared instance reachable without threading it through every
 * signature (the picker is reached via `openArtifactPicker`, whose six
 * parameters are mirrored at four call sites).
 *
 * @param provider - The registered provider, or `undefined` to clear.
 *
 * @example
 * setMainViewProvider(provider);
 */
export function setMainViewProvider(provider: MainViewProvider | undefined): void {
    activeProvider = provider;
}

/**
 * The registered main-pane provider.
 *
 * @returns The provider, or `undefined` before activation has registered one.
 *
 * @example
 * const pane = getMainViewProvider();
 */
export function getMainViewProvider(): MainViewProvider | undefined {
    return activeProvider;
}
