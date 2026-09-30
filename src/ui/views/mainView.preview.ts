import { renderCodeHtml, renderCodeRowsHtml } from '../../services/render.service.js';
import {
    renderPreviewHtml,
    renderMultiBlockPreviewHtml,
    renderPopupEmptyHtml,
} from '../panels/artifactPicker/preview.render.js';
import type { ParsedArtifactFile } from '../../types/parsed-artifact.types.js';

/**
 * Structural shape `ensureView` needs from the pane's resolution state.
 *
 * Declared locally rather than imported from `mainView.provider.ts` (T4's
 * `Owns`, not this task's) or `webviewHost.ts` (T20's — built in parallel and
 * not guaranteed to exist yet). ORCH-7 supplies the real implementation at
 * wave close, the same callback-bag shape every controller in this repo
 * composes with.
 */
export interface ViewTarget {
    /**
     * Whether `resolveWebviewView` has fired for this pane session — a
     * **thunk**, read fresh on each call, never a snapshot `boolean`. A plain
     * `boolean` captured at call time (`{ resolved: this.view !== undefined }`)
     * would freeze the answer from before `focus()` ran, so `ensureView`'s
     * post-`focus()` recheck would read stale state instead of the outcome —
     * making that recheck decoration. The thunk shape makes that staleness
     * unwritable rather than merely discouraged.
     */
    resolved: () => boolean;
    /**
     * Reveals the pane (`executeCommand('md-artifacts.mainView.focus')`)
     * and resolves once `resolveWebviewView` has fired for it.
     */
    focus: () => Promise<void>;
}

/**
 * Ensures the main pane's webview is resolved before the first post — H3.
 *
 * `WebviewView.resolveWebviewView` fires **lazily**, only on first reveal
 * (`registerWebviewViewProvider` docs). A caller that assumes an
 * already-resolved view — the way the popup's synchronous `ensurePanel()`
 * could return `false` and bail — would silently drop the first post into a
 * view that does not exist yet. This awaits `target.focus()` (which performs
 * the reveal) and then **re-reads `target.resolved()`** rather than trusting
 * the call succeeded: `focus()`'s contract is "reveal and wait for
 * resolution", but nothing here enforces that a caller actually implements
 * it that way (e.g. wiring bare `executeCommand('md-artifacts.mainView.focus')`,
 * whose returned promise settles when the reveal command completes, not when
 * `resolveWebviewView` fires) — so a `focus()` that returns without the view
 * ever resolving must surface as a thrown error, not a silent success a
 * caller then posts into.
 *
 * @param target - The pane's current resolution state and its reveal action.
 * @returns Resolves once the view is confirmed resolved — either already, or
 *          after `focus()` settles and `resolved()` confirms it.
 * @throws  If `focus()` rejects, or if it resolves without `resolved()`
 *          becoming `true`.
 *
 * @example
 * await ensureView({ resolved: () => this.view !== undefined, focus: () => revealMainView() });
 * // view is now resolved — safe to post
 */
export async function ensureView(target: ViewTarget): Promise<void> {
    if (target.resolved()) {
        return;
    }
    await target.focus();
    if (!target.resolved()) {
        throw new Error('main pane did not resolve after focus()');
    }
}

/**
 * What the main pane's `preview` mode currently shows.
 *
 * Mirrors the three shapes `PreviewPanelController` renders in the popup
 * (`preview.ts`'s `showPreview` / `showMultiBlockPreview` / `showEmpty`), so
 * `renderMainViewPreviewHtml` needs no logic of its own beyond picking one.
 */
export type MainViewPreviewState =
    | { kind: 'empty' }
    | { kind: 'single'; artifact: ParsedArtifactFile; varSources?: Record<string, string>; insertAvailable?: boolean }
    | { kind: 'multi'; artifact: ParsedArtifactFile };

/**
 * Renders the main pane's `preview` mode HTML.
 *
 * Dispatches to the **existing** renderers verbatim — `renderPreviewHtml`,
 * `renderMultiBlockPreviewHtml`, `renderPopupEmptyHtml` — the same three the
 * popup (`preview.ts`) already uses, built from the same
 * `renderCodeRowsHtml` / `renderCodeHtml` calls `preview.ts` makes. No second
 * renderer and no second client script: `renderPreviewHtml` already
 * concatenates `PREVIEW_CLIENT_JS` inside one outer IIFE with its own single
 * `acquireVsCodeApi()` call, so this function contributes no script of its
 * own — swapping `webview.html` to this string is a full document reload,
 * so it never collides with `idle` mode's script from the previous render.
 *
 * `MainViewProvider.render()` calls this for `preview` mode, passing its own
 * `previewState` field (default `{ kind: 'empty' }`), the mode's stylesheet
 * URIs and a fresh nonce. The provider is the **single writer** of
 * `webview.html` for both modes; nothing else sets that property, so the two
 * modes cannot race it.
 *
 * Ending a preview is `MainViewProvider.endPreview()`, which clears the state
 * and returns the pane to `idle` — pinned by `test/main-view-integration.test.ts`.
 *
 * @param state     - What to show — `empty`, a single-block artifact, or a multi-block artifact.
 * @param cssUri    - Webview URIs for the shared stylesheets (`base.css` first).
 * @param cspSource - Webview CSP source token (`webview.cspSource`).
 * @param nonce     - CSP nonce for `renderPreviewHtml`'s `<script>` tag; unused by the other two states.
 * @returns Complete HTML document string, ready for `webview.html`.
 *
 * @example
 * renderMainViewPreviewHtml({ kind: 'empty' }, ['base.css'], webview.cspSource, getNonce())
 */
export function renderMainViewPreviewHtml(
    state: MainViewPreviewState,
    cssUri: string | string[],
    cspSource: string,
    nonce: string,
): string {
    if (state.kind === 'empty') {
        return renderPopupEmptyHtml(cssUri, cspSource);
    }
    if (state.kind === 'multi') {
        const highlightedBlocks = state.artifact.blocks.map(b => ({
            heading:     b.heading,
            codeHtml:    renderCodeHtml(b.code, b.fenceLang ?? state.artifact.frontmatter.language),
            vars:        b.vars,
            description: b.description,
        }));
        return renderMultiBlockPreviewHtml(state.artifact, highlightedBlocks, cssUri, cspSource);
    }
    const codeRowsHtml = renderCodeRowsHtml(state.artifact.code, state.artifact.frontmatter.language);
    return renderPreviewHtml(
        state.artifact, codeRowsHtml, nonce, cssUri, cspSource,
        state.varSources ?? {}, state.insertAvailable ?? true,
    );
}
