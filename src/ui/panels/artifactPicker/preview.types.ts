import type * as vscode from 'vscode';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import type { InvocationSurface } from './preview.helpers.js';
import type { WebviewHost } from './webviewHost.js';
import type { MainViewPreviewState } from '../../views/mainView.preview.js';

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
 * Identifies which code block of an artifact the preview is showing.
 *
 * - `{ kind: 'single' }` — the lone code block of a single-block file.
 * - `{ kind: 'multi', heading }` — the block under the `## <heading>` section of a
 *   multi-block file (first match wins when headings repeat).
 *
 * @example
 * const ref: BlockRef = { kind: 'multi', heading: 'Two' };
 */
export type BlockRef =
    | { kind: 'single' }
    | { kind: 'multi'; heading: string };
