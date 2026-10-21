import * as vscode from 'vscode';
import { PaneWidthController, type PaneMetrics } from '../../../services/pane-width.service.js';
import { getPreviewWidthSteps, getVariablesHeightFraction, setVariablesHeightFraction } from '../../../services/config.service.js';
import { varsHeightCss } from '../../../services/pane-layout.service.js';
import type { HostMessage } from './webviewHost.js';

/** How long a pane measurement may take before the widen loop gives up on the view. */
const MEASURE_TIMEOUT_MS = 600;

/**
 * Pane width plumbing for one preview session: the widen/restore loop, the
 * `measurePane` round trip, and the Variables-height message pair.
 *
 * Composed by `PreviewPanelController` via a callback bag. It has no lifecycle
 * hook of its own: the controller's `dispose()` calls {@link restore} exactly
 * once behind its `open` guard.
 *
 * @example
 * const width = new PreviewWidth(msg => host.post(msg));
 */
export class PreviewWidth {
    /**
     * Resolver for an in-flight `measure` round trip.
     *
     * The measurement rides the **session** message handler rather than a
     * subscription of its own: `onWebviewMessage` is a single-handler setter,
     * not a multicast event, so a second subscriber silently replaces the
     * first and disposing it clears the handler outright.
     */
    private pendingMeasure: ((m: PaneMetrics | undefined) => void) | undefined;
    /**
     * Widens the pane for the session and narrows it back by the same count.
     * Built per controller so the configured step count is re-read per insert.
     */
    private readonly paneWidth = new PaneWidthController(
        async id => { await vscode.commands.executeCommand(id); },
        getPreviewWidthSteps(),
        () => this.measure(),
    );

    /**
     * @param post - Posts a message to the pane's webview.
     *
     * @example
     * new PreviewWidth(msg => host.post(msg));
     */
    constructor(private readonly post: (msg: HostMessage) => void) {}

    /**
     * Widens the pane for a preview.
     *
     * @returns Resolves when the widen loop settles.
     *
     * @example
     * void width.widen();
     */
    widen(): Promise<void> { return this.paneWidth.widenForPreview(); }

    /**
     * Undoes the widen by the same count.
     *
     * @returns Resolves when the restore settles.
     *
     * @example
     * void width.restore();
     */
    restore(): Promise<void> { return this.paneWidth.restoreAfterPreview(); }

    /**
     * Hands a `paneMetrics` reply to whatever measurement is in flight.
     *
     * @param msg - Raw webview message; ignored unless both widths are numbers.
     * @returns Nothing.
     *
     * @example
     * width.resolveMeasure({ command: 'paneMetrics', paneWidth: 312, availWidth: 1920 });
     */
    resolveMeasure(msg: Record<string, unknown>): void {
        const paneWidth  = msg.paneWidth;
        const availWidth = msg.availWidth;
        if (typeof paneWidth !== 'number' || typeof availWidth !== 'number') { return; }
        this.pendingMeasure?.({ paneWidth, availWidth });
    }

    /**
     * Asks the webview how wide it is and resolves with what it reports.
     *
     * @returns The metrics, or `undefined` when the view did not answer within
     *          {@link MEASURE_TIMEOUT_MS} — a dead or hidden view must never
     *          hang an insert.
     *
     * @example
     * const m = await width.measure(); // { paneWidth: 312, availWidth: 1920 }
     */
    private measure(): Promise<PaneMetrics | undefined> {
        return new Promise(resolve => {
            const finish = (value: PaneMetrics | undefined): void => {
                if (!this.pendingMeasure) { return; }
                this.pendingMeasure = undefined;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => { finish(undefined); }, MEASURE_TIMEOUT_MS);
            this.pendingMeasure = finish;
            this.post({ command: 'measurePane' });
        });
    }

    /**
     * Pushes the stored variables-section height into the pane.
     * `varsHeightCss` is the one place a fraction becomes a CSS value.
     *
     * @returns Nothing.
     *
     * @example
     * width.postVarsHeight();
     */
    postVarsHeight(): void {
        this.post({ command: 'setVarsHeight', value: varsHeightCss(getVariablesHeightFraction()) });
    }

    /**
     * Persists a height the user dragged to, then echoes the clamped result.
     *
     * @param msg - Webview message carrying `fraction`.
     * @returns Resolves once stored and echoed.
     *
     * @example
     * await width.handleVarsHeightChanged({ fraction: 0.4 });
     */
    async handleVarsHeightChanged(msg: Record<string, unknown>): Promise<void> {
        await setVariablesHeightFraction(msg.fraction);
        this.postVarsHeight();
    }
}
