import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { MainViewProvider } from '../src/ui/views/mainView.provider.js';
import { WebviewHost, type WebviewHostTarget } from '../src/ui/panels/artifactPicker/webviewHost.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';
import { PreviewPanelController } from '../src/ui/panels/artifactPicker/preview.js';
import type { MainViewPreviewState } from '../src/ui/views/mainView.preview.js';
import { getPreviewTarget } from '../src/services/preview-target.service.js';

/** A minimal single-block artifact whose code renders visible `.code-line-row`s. */
function fakeArtifact(): ParsedArtifactFile {
    return {
        filePath:     '/v/Snippets/demo.md',
        fileName:     'demo',
        relativePath: 'demo.md',
        frontmatter:  { artifactType: 'Snippet', title: 'Demo', language: 'typescript', tags: [] },
        code:         'const answer = 42;',
        vars:         [],
        blocks:       [],
    } as unknown as ParsedArtifactFile;
}

/**
 * Integration gates for ORCH-7's wiring (ledger #116).
 *
 * Every Wave 7 slice was verified against its own fake and **nothing verified
 * a join** — which is the shape all three of the wave's seam defects share
 * (#104 nothing owned the call site, #109 the sheet overrode nothing, #113 the
 * postcondition nobody checked). These drive the real `MainViewProvider`, so
 * they fail on exactly the joins a slice-scoped test cannot reach.
 */

/** Minimal stand-in for the `WebviewView` VS Code hands `resolveWebviewView`. */
function fakeView(): vscode.WebviewView & { setVisible(v: boolean): void; fireDispose(): void } {
    const disposeListeners: Array<() => void> = [];
    const visibilityListeners: Array<() => void> = [];
    let visible = true;
    const view = {
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-webview:',
            asWebviewUri: (u: vscode.Uri) => u,
            postMessage: async () => true,
            onDidReceiveMessage: () => new vscode.Disposable(() => { /* no listeners in this fake */ }),
        },
        get visible() { return visible; },
        onDidChangeVisibility: (l: () => void) => { visibilityListeners.push(l); return new vscode.Disposable(() => { /* kept for the test's lifetime */ }); },
        onDidDispose: (l: () => void) => { disposeListeners.push(l); return new vscode.Disposable(() => { /* kept for the test's lifetime */ }); },
        show: () => { /* revealing an already-resolved view is a no-op here */ },
        setVisible(v: boolean) { visible = v; for (const l of visibilityListeners) { l(); } },
        fireDispose() { for (const l of disposeListeners) { l(); } },
    };
    return view as unknown as vscode.WebviewView & { setVisible(v: boolean): void; fireDispose(): void };
}

suite('ORCH-7 integration — main pane joins (ledger #116)', () => {

    // ── Gate 1: focus() must not settle before resolveWebviewView has run ────

    test('focus() does not settle until the view has actually resolved', async () => {
        const provider = new MainViewProvider(vscode.Uri.file('/ext'));
        let settled = false;
        const pending = provider.focus().then(() => { settled = true; });

        // Yield generously. `executeCommand('<viewId>.focus')` may well settle in
        // here — that is the whole point: it reports the reveal, not the provider
        // callback, so settling on it alone would post into a view that does not
        // exist yet.
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(settled, false, 'focus() settled before resolveWebviewView fired');

        provider.resolveWebviewView(fakeView());
        await pending;
        assert.strictEqual(settled, true);
    });

    test('viewTarget().resolved is a live thunk, not a snapshot', () => {
        const provider = new MainViewProvider(vscode.Uri.file('/ext'));
        const target = provider.viewTarget();
        assert.strictEqual(target.resolved(), false);
        provider.resolveWebviewView(fakeView());
        assert.strictEqual(target.resolved(), true, 'resolved() froze at its call-time value');
    });

    test('a hide-dispose re-arms resolution, so the next focus() waits for the new view', async () => {
        const provider = new MainViewProvider(vscode.Uri.file('/ext'));
        const view = fakeView();
        provider.resolveWebviewView(view);
        assert.strictEqual(provider.viewTarget().resolved(), true);

        view.fireDispose();
        assert.strictEqual(provider.viewTarget().resolved(), false, 'dispose left resolved() true');

        let settled = false;
        const pending = provider.focus().then(() => { settled = true; });
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(settled, false, 'focus() reused the previous session’s settled promise');
        provider.resolveWebviewView(fakeView());
        await pending;
    });

    // ── Gate 4: preview ⇄ idle ────────────────────────────────────────────────

    test('showPreview renders preview mode; endPreview returns the pane to idle', () => {
        const provider = new MainViewProvider(vscode.Uri.file('/ext'));
        const view = fakeView();
        provider.resolveWebviewView(view);

        // Identify the mode by a stable marker, never by byte-identity: every
        // render mints a fresh CSPRNG nonce, so two idle renders differ by
        // design and an equality assertion here could only ever fail.
        const isIdle = () => view.webview.html.includes('codicon-add');

        assert.ok(isIdle(), 'idle mode did not render the create rows');

        provider.showPreview({ kind: 'empty' });
        assert.ok(!isIdle(), 'preview mode still shows the create rows');

        provider.endPreview();
        assert.ok(isIdle(), 'endPreview did not restore the create list');
    });

    test('endPreview clears the state, so a later setMode cannot resurrect the artifact', () => {
        const provider = new MainViewProvider(vscode.Uri.file('/ext'));
        const view = fakeView();
        provider.resolveWebviewView(view);

        // Start from a REAL artifact, not the empty state. Starting empty makes
        // the assertion unfalsifiable — "not clearing" and "clearing" both leave
        // the state empty — which is exactly how this test first passed against
        // an endPreview that cleared nothing (ledger #117).
        provider.showPreview({ kind: 'single', artifact: fakeArtifact() });
        assert.ok(view.webview.html.includes('code-line-row'),
            'fixture did not render a code area, so the assertion below proves nothing');

        provider.endPreview();
        provider.setMode('preview');

        assert.ok(!view.webview.html.includes('codicon-add'), 'setMode did not enter preview');
        assert.ok(!view.webview.html.includes('code-line-row'),
            'preview after endPreview re-rendered the previous artifact instead of the empty state');
    });

    // ── Gate 2: no cross-session leakage across an artifact swap ─────────────

    test('a message queued for artifact A never reaches artifact B', () => {
        const posted: unknown[] = [];
        let visible = false;
        const target: WebviewHostTarget = {
            postMessage: m => { posted.push(m); return true; },
            html: '',
            cspSource: 'vscode-webview:',
            asWebviewUri: u => u,
            get visible() { return visible; },
            onDidChangeViewState: () => ({ dispose() { /* not exercised here */ } }),
            onDidDispose: () => ({ dispose() { /* not exercised here */ } }),
        };
        const host = new WebviewHost(target);

        // Artifact A's update arrives while the pane is hidden, so it queues.
        host.post({ command: 'fileUpdated', artifact: 'A' });

        // The user hovers artifact B: the preview swaps and the queue is dropped,
        // because A's message addresses a document that no longer exists.
        host.clearQueue();

        visible = true;
        const flushed = host.flushOnVisible();

        assert.deepStrictEqual(flushed, [], 'A queued message survived the artifact swap');
        assert.deepStrictEqual(posted, [], 'A stale message reached the sink after the swap');
    });

    test('clearQueue is non-terminal — the host still works afterwards', () => {
        const posted: unknown[] = [];
        let visible = false;
        const target: WebviewHostTarget = {
            postMessage: m => { posted.push(m); return true; },
            html: '',
            cspSource: 'vscode-webview:',
            asWebviewUri: u => u,
            get visible() { return visible; },
            onDidChangeViewState: () => ({ dispose() { /* not exercised here */ } }),
            onDidDispose: () => ({ dispose() { /* not exercised here */ } }),
        };
        const host = new WebviewHost(target);

        host.post({ command: 'fileUpdated', artifact: 'A' });
        host.clearQueue();
        host.post({ command: 'fileUpdated', artifact: 'B' });

        visible = true;
        host.flushOnVisible();

        assert.deepStrictEqual(posted, [{ command: 'fileUpdated', artifact: 'B' }],
            'clearQueue either killed the host or failed to drop A');
    });

    // ── Gate 2b: the SWAP PATH clears the queue, not just the method ─────────

    test('showPreview itself clears the queue — the wiring, not just clearQueue()', async () => {
        // The first Gate 2 tests called `clearQueue()` by hand, so deleting both
        // of its call sites left the suite green: the method was covered and the
        // *wiring* was not. Same shape as #117, one layer out (ledger #119).
        const posted: unknown[] = [];
        let visible = false;
        const target: WebviewHostTarget = {
            postMessage: m => { posted.push(m); return true; },
            html: '',
            cspSource: 'vscode-webview:',
            asWebviewUri: u => u,
            get visible() { return visible; },
            onDidChangeViewState: () => ({ dispose() { /* not exercised */ } }),
            onDidDispose: () => ({ dispose() { /* not exercised */ } }),
        };
        const host = new WebviewHost(target);
        const rendered: MainViewPreviewState[] = [];

        const controller = new PreviewPanelController({
            extensionUri: vscode.Uri.file('/ext'),
            rootFs: '/v',
            targetEditor: undefined,
            setCache: () => { /* no cache in this test */ },
            onDispose: () => { /* no navigator here */ },
            host,
            ensureView: async () => { /* pane already "live" via the fake target */ },
            endPreview: () => { /* not exercised */ },
            showPreviewState: state => { rendered.push(state); },
            onWebviewMessage: () => new vscode.Disposable(() => { /* no inbound traffic */ }),
            closePicker: () => { /* not exercised */ },
            storageUri: vscode.Uri.file('/storage'),
            invocationSurface: 'editor',
        });

        // Artifact A's update queues while the pane is hidden.
        host.post({ command: 'fileUpdated', artifact: 'A' });

        // The user picks artifact B. Nobody calls clearQueue() by hand here —
        // showPreview must do it.
        await controller.showPreview(fakeArtifact());

        visible = true;
        host.flushOnVisible();

        // Asserted by command rather than on an empty array: `showPreview` now
        // also posts the pane-width `measurePane` handshake, which is expected
        // traffic. The defect this test exists for is unchanged — A's stale
        // update must never survive the swap — and still fails it.
        assert.deepStrictEqual(
            posted.filter(m => (m as { command?: string }).command === 'fileUpdated'),
            [],
            "artifact A's queued message reached the sink after switching to B — showPreview did not clear the queue");
        assert.strictEqual(rendered.length, 1, 'showPreview did not render');
    });

    // ── Gate 2c: the width probe must not unseat the session message handler ──

    test('Cancel still routes after showPreview — the width probe leaves one live handler', async () => {
        // Shipped defect: the pane-width measurement subscribed its own handler
        // through `onWebviewMessage`, which is a single-handler *setter* and not
        // a multicast event. The probe replaced the session handler and its
        // disposal cleared the slot outright, so Cancel, Edit and Insert all went
        // dead in the real pane while all 1163 tests stayed green — nothing here
        // routed a user action *after* a render.
        let visible = true;
        const target: WebviewHostTarget = {
            postMessage: () => true,
            html: '',
            cspSource: 'vscode-webview:',
            asWebviewUri: u => u,
            get visible() { return visible; },
            onDidChangeViewState: () => ({ dispose() { /* not exercised */ } }),
            onDidDispose: () => ({ dispose() { /* not exercised */ } }),
        };

        let handler: ((msg: Record<string, unknown>) => void) | undefined;
        let subscriptions = 0;
        let disposed = false;

        const controller = new PreviewPanelController({
            extensionUri: vscode.Uri.file('/ext'),
            rootFs: '/v',
            targetEditor: undefined,
            setCache: () => { /* no cache in this test */ },
            onDispose: () => { disposed = true; },
            host: new WebviewHost(target),
            ensureView: async () => { /* pane already "live" */ },
            endPreview: () => { /* not exercised */ },
            showPreviewState: () => { /* rendering covered elsewhere */ },
            onWebviewMessage: h => {
                subscriptions++;
                handler = h;
                return new vscode.Disposable(() => { handler = undefined; });
            },
            closePicker: () => { /* not exercised */ },
            storageUri: vscode.Uri.file('/storage'),
            invocationSurface: 'editor',
        });

        await controller.showPreview(fakeArtifact());

        assert.strictEqual(subscriptions, 1,
            'the width probe added a second subscriber — onWebviewMessage is a setter, so it unseated the session handler');
        assert.ok(handler, 'no live message handler after showPreview');

        handler?.({ command: 'cancel' });
        assert.ok(disposed, 'Cancel did not reach the controller after a render');
    });

    // ── Gate 1b: every render re-ensures, so a hide-dispose cannot kill the pane ──

    test('showPreview re-ensures the view on every render, not once per session', async () => {
        // Hiding an activity-bar view disposes it. With an `if (this.open) return`
        // fast path in ensureHost, the next showPreview re-attached nothing and
        // rendered into a nulled view: no HTML change, no error, no log — a
        // permanently dead pane (ledger #119). Counting the calls is what pins it.
        let ensureViewCalls = 0;
        const rendered: MainViewPreviewState[] = [];
        const host = new WebviewHost();

        const controller = new PreviewPanelController({
            extensionUri: vscode.Uri.file('/ext'),
            rootFs: '/v',
            targetEditor: undefined,
            setCache: () => { /* no cache in this test */ },
            onDispose: () => { /* no navigator here */ },
            host,
            ensureView: async () => { ensureViewCalls++; },
            endPreview: () => { /* not exercised */ },
            showPreviewState: state => { rendered.push(state); },
            onWebviewMessage: () => new vscode.Disposable(() => { /* no inbound traffic */ }),
            closePicker: () => { /* not exercised */ },
            storageUri: vscode.Uri.file('/storage'),
            invocationSurface: 'editor',
        });

        await controller.showPreview(fakeArtifact());
        await controller.showPreview(fakeArtifact());

        assert.strictEqual(ensureViewCalls, 2,
            'the second render skipped ensureView — after a hide-dispose that leaves the pane dead');
        assert.strictEqual(rendered.length, 2);
    });

    // ── Gate 1c: the Variables-pane target is claimed and released in step ──

    /**
     * Builds a controller whose pane is live unless `ensureView` throws.
     *
     * @param ensureView - Stand-in for the pane reveal; throw to drive the failure path.
     * @returns A controller wired to inert fakes.
     */
    function targetController(ensureView: () => Promise<void> = async () => { /* pane live */ }) {
        return new PreviewPanelController({
            extensionUri: vscode.Uri.file('/ext'),
            rootFs: '/v',
            targetEditor: undefined,
            setCache: () => { /* no cache here */ },
            onDispose: () => { /* no navigator here */ },
            host: new WebviewHost(),
            ensureView,
            endPreview: () => { /* not exercised */ },
            showPreviewState: () => { /* rendering covered elsewhere */ },
            onWebviewMessage: () => new vscode.Disposable(() => { /* no inbound traffic */ }),
            closePicker: () => { /* not exercised */ },
            storageUri: vscode.Uri.file('/storage'),
            invocationSurface: 'editor',
        });
    }

    test('dispose() releases the Variables-pane target (H1.4)', async () => {
        // Ledger #23. A WebviewView is disposed by a mere sidebar *hide*, so a
        // preview that dies without releasing leaves the Variables pane holding
        // a target whose applyVarSet posts into a webview that is gone. The
        // release rides `dispose()` — the path every preview-end funnels
        // through — never a teardown hook that a hide never reaches.
        const controller = targetController();

        await controller.showPreview(fakeArtifact());
        assert.notStrictEqual(getPreviewTarget(), undefined, 'showPreview did not claim the target');

        controller.dispose();
        assert.strictEqual(getPreviewTarget(), undefined,
            'dispose() left the target claimed — the Variables pane still holds a dead preview');
    });

    test('a failed ensureHost claims nothing (H1.4)', async () => {
        // `this.open` is set *inside* `ensureHost`, so when it fails
        // `dispose()`'s `if (!this.open) return` never runs the release. A claim
        // placed before that check would therefore leak for the life of the host.
        const controller = targetController(async () => { throw new Error('pane reveal failed'); });

        await controller.showPreview(fakeArtifact());

        assert.strictEqual(getPreviewTarget(), undefined,
            'a preview whose pane never opened claimed the target anyway — nothing will ever release it');
    });

    test('a multi-block preview does not inherit the single-block claim (H1.4)', async () => {
        // Sequenced deliberately: asserting `undefined` after a bare
        // `showMultiBlockPreview` would pass with zero implementation, because
        // nothing ever claimed. The real hazard is a *stale* target surviving
        // the switch — `showPreview` tears down at its top but never disposes —
        // so the single-block claim has to happen first for this to mean
        // anything. A multi-block pane renders no variable inputs, so a set
        // applied into it has nothing to land on.
        const controller = targetController();

        await controller.showPreview(fakeArtifact());
        assert.notStrictEqual(getPreviewTarget(), undefined,
            'showPreview did not claim — the rest of this test would be vacuous');

        controller.dispose();
        assert.strictEqual(getPreviewTarget(), undefined, 'dispose() did not release before the switch');

        await controller.showMultiBlockPreview(fakeArtifact());
        assert.strictEqual(getPreviewTarget(), undefined,
            'a multi-block preview claimed the Variables-pane target — it renders no variable inputs');
    });
});
