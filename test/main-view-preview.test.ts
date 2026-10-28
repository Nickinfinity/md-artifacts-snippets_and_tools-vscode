import * as assert from 'node:assert';
import {
    ensureView,
    renderMainViewPreviewHtml,
    type ViewTarget,
    type MainViewPreviewState,
} from '../src/ui/views/mainView.preview.js';
import { renderCodeHtml, renderCodeRowsHtml } from '../src/services/render.service.js';
import { renderMultiBlockPreviewHtml, renderPreviewHtml } from '../src/ui/panels/artifactPicker/preview.render.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';

/**
 * Unit tests for the main pane's `preview`-mode module (T21, VSX-222).
 *
 * `ensureView` is the H3 seam: `resolveWebviewView` fires lazily, on first
 * reveal, so the pane's equivalent of the popup's synchronous `ensurePanel()`
 * must `await` a reveal instead of assuming the view already exists.
 * `renderMainViewPreviewHtml` must dispatch to the **existing** renderers
 * verbatim — no second renderer, no second client script — so its output is
 * pinned byte-for-byte against calling those renderers directly.
 */

/** Minimal single-block fixture, matching the shape `preview-copy.test.ts` uses. */
function fixture(overrides: Partial<ParsedArtifactFile['frontmatter']> = {}): ParsedArtifactFile {
    return {
        filePath:     '/vault/Snippets/demo.md',
        fileName:     'demo',
        relativePath: 'demo.md',
        frontmatter:  { artifactType: 'Snippet', title: 'Demo', ...overrides },
        code:         'console.log(<VK-msg>);',
        vars:         [{ name: 'VK-msg', defaultValue: 'hi' }],
        blocks:       [],
    };
}

suite('mainView.preview — ensureView (H3)', () => {

    test('short-circuits when already resolved — focus() is never called', async () => {
        let called = false;
        const target: ViewTarget = { resolved: () => true, visible: () => true, focus: async () => { called = true; } };
        await ensureView(target);
        assert.strictEqual(called, false);
    });

    test('resolved but hidden (retainContextWhenHidden) — focus() reveals once', async () => {
        let calls = 0;
        const target = { resolved: () => true, visible: () => false, focus: async () => { calls++; } };
        await ensureView(target);
        assert.strictEqual(calls, 1);
    });

    test('awaits focus() to completion before resolving — a slow reveal is not raced past', async () => {
        const order: string[] = [];
        let isResolved = false;
        const target: ViewTarget = {
            resolved: () => isResolved,
            visible: () => true,
            focus: async () => {
                await new Promise(resolve => setTimeout(resolve, 0));
                isResolved = true;
                order.push('focus-settled');
            },
        };
        await ensureView(target);
        order.push('ensureView-returned');
        assert.deepStrictEqual(order, ['focus-settled', 'ensureView-returned']);
    });

    test('propagates a rejected focus() rather than swallowing it', async () => {
        const target: ViewTarget = { resolved: () => false, visible: () => true, focus: async () => { throw new Error('reveal failed'); } };
        await assert.rejects(() => ensureView(target), /reveal failed/);
    });

    test('throws when focus() resolves without the view actually resolving (broken focus() contract)', async () => {
        // focus() returns cleanly but never flips resolved() to true — the
        // executeCommand-settles-before-resolveWebviewView-fires case.
        const target: ViewTarget = { resolved: () => false, visible: () => true, focus: async () => { /* no-op */ } };
        await assert.rejects(() => ensureView(target), /did not resolve/);
    });

    test('type — resolved must be a thunk, not a snapshot boolean (a snapshot would make the recheck decoration)', () => {
        // @ts-expect-error - 'resolved' must be `() => boolean`; a boolean snapshot must not compile
        const target: ViewTarget = { resolved: false, visible: () => true, focus: async () => { /* noop */ } };
        assert.strictEqual(typeof target, 'object');
    });
});

suite('mainView.preview — renderMainViewPreviewHtml (dispatch only, no second renderer)', () => {

    test('empty state renders the shared empty-state placeholder', () => {
        const html = renderMainViewPreviewHtml({ kind: 'empty' }, 'base.css', "'self'", 'test-nonce');
        assert.ok(html.includes('Select a file to preview'));
    });

    test('single-block state is byte-identical to calling renderPreviewHtml directly', () => {
        const artifact = fixture();
        const state: MainViewPreviewState = { kind: 'single', artifact };
        const viaDispatch = renderMainViewPreviewHtml(state, 'base.css', "'self'", 'test-nonce');

        const rows = renderCodeRowsHtml(artifact.code, artifact.frontmatter.language);
        const viaDirect = renderPreviewHtml(artifact, rows, 'test-nonce', 'base.css', "'self'", {});

        assert.strictEqual(viaDispatch, viaDirect);
    });

    test('multi-block state is byte-identical to calling renderMultiBlockPreviewHtml directly', () => {
        const artifact: ParsedArtifactFile = {
            ...fixture(),
            blocks: [
                { heading: 'Dev', description: '', code: 'a', fenceLang: 'bash', vars: [] },
                { heading: 'Prod', description: '', code: 'b', fenceLang: 'bash', vars: [] },
            ],
        };
        const viaDispatch = renderMainViewPreviewHtml({ kind: 'multi', artifact }, 'base.css', "'self'", 'test-nonce');

        const highlightedBlocks = artifact.blocks.map(b => ({
            heading:     b.heading,
            codeHtml:    renderCodeHtml(b.code, b.fenceLang ?? artifact.frontmatter.language),
            vars:        b.vars,
            description: b.description,
        }));
        const viaDirect = renderMultiBlockPreviewHtml(artifact, highlightedBlocks, 'base.css', "'self'");

        assert.strictEqual(viaDispatch, viaDirect);
    });

    test('single-block state carries varSources through to the "from:" badge', () => {
        const artifact = fixture();
        const html = renderMainViewPreviewHtml(
            { kind: 'single', artifact, varSources: { 'VK-msg': 'My Set' } },
            'base.css', "'self'", 'test-nonce',
        );
        assert.ok(html.includes('from: My Set'));
    });
});
