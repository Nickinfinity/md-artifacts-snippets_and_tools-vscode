import * as assert from 'node:assert';
import { renderVarSetFormHtml, parseVarSetFormPayload } from '../src/ui/panels/varsetForm/varsetForm.render.js';
import { handleVarSetFormMessage, type VarSetFormCallbacks } from '../src/ui/panels/varsetForm/varsetForm.panel.js';
import type { VarSetFormPayload } from '../src/types/varset.types.js';

/**
 * T2.1 — the var-set creation form's renderer, payload guard, and message
 * handler. Covers the webview trust boundary in both directions (outbound
 * HTML escaping, inbound payload shape-guarding) plus the CSP shape and the
 * `handleVarSetFormMessage` callback-bag contract.
 */
suite('varset form render — outbound escaping', () => {
    test('a var value reaching the document is escaped, not dropped', () => {
        const html = renderVarSetFormHtml(
            { title: '', description: '', tags: [], pairs: [['VK-host', '<script>alert(1)</script>']] },
            'x.css', "'self'", 'N0NCE',
        );
        assert.ok(!html.includes('<script>alert(1)'), 'a var value reached the document unescaped');
        assert.ok(html.includes('&lt;script&gt;'), 'the value was dropped rather than escaped');
    });

    test('a tag value cannot break out of the inline <script> block', () => {
        // Tags are embedded via JSON.stringify inside the inline <script>, not
        // as HTML text, so escHtml alone would not stop this — a tag reading
        // literally "</script><script>alert(1)</script>" must never let the
        // closing sequence reach the document verbatim.
        const html = renderVarSetFormHtml(
            { title: '', description: '', tags: ['</script><script>alert(1)</script>'], pairs: [] },
            'x.css', "'self'", 'N0NCE',
        );
        assert.ok(!html.includes('</script><script>alert(1)'), 'a tag value closed the script block early');
    });

    test('renders a hidden error element the client script can populate on saveFailed', () => {
        // A rejected save (see handleVarSetFormMessage) posts { command:
        // 'saveFailed', reason }. Without a DOM sink for it the rejection is
        // silent to the user — this pins that the sink exists in the markup.
        const html = renderVarSetFormHtml(
            { title: '', description: '', tags: [], pairs: [] },
            'x.css', "'self'", 'N0NCE',
        );
        assert.ok(/<div id="vsfError"[^>]*hidden[^>]*><\/div>/.test(html),
            'no hidden #vsfError element for the saveFailed reason to populate');
        assert.ok(/errorEl\.textContent\s*=\s*msg\.reason/.test(html),
            'saveFailed reason is not written to the DOM via textContent');
    });
});

suite('varset form render — CSP', () => {
    const payload: VarSetFormPayload = { title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] };
    const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE');

    test('carries the default-src baseline', () => {
        assert.ok(html.includes("default-src 'none'"), 'no CSP baseline');
    });

    test('script-src carries no wildcard', () => {
        assert.ok(!/script-src[^;]*\*/.test(html), 'a wildcard script-src');
    });

    test('script-src carries the nonce', () => {
        assert.ok(html.includes("script-src 'nonce-N0NCE'"), 'script-src carries no nonce');
    });

    test('inline <style> carries the nonce', () => {
        assert.ok(html.includes('<style nonce="N0NCE"'), 'style tag carries no nonce');
    });

    test('inline <script> carries the nonce', () => {
        assert.ok(html.includes('<script nonce="N0NCE"'), 'script tag carries no nonce');
    });

    test('style-src admits the nonced inline <style> (would be blocked at runtime otherwise)', () => {
        assert.ok(/style-src[^;]*'nonce-N0NCE'/.test(html),
            'inline <style> is nonced but style-src does not admit it - blocked at runtime, invisible here');
    });
});

suite('varset form payload guard — inbound', () => {
    // Accept case first: the two rejection cases below pass trivially against
    // a module that exports nothing (every call returning `undefined`), so
    // they only prove anything once an accept case is pinned too.
    test('accepts a well-shaped payload verbatim', () => {
        assert.deepStrictEqual(
            parseVarSetFormPayload({ title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] }),
            { title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] });
    });

    test('rejects a non-array pairs field', () => {
        assert.strictEqual(parseVarSetFormPayload({ title: 'x', pairs: 'not-an-array' }), undefined);
    });

    test('rejects a non-string value inside a pair', () => {
        assert.strictEqual(parseVarSetFormPayload({ title: 'x', pairs: [['VK-a', 1]] }), undefined,
            'a non-string value was accepted from the webview');
    });
});

suite('handleVarSetFormMessage — callback-bag contract', () => {
    const payload: VarSetFormPayload = { title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] };

    function makeBag(overrides: Partial<VarSetFormCallbacks> = {}): {
        bag: VarSetFormCallbacks;
        calls: { write: unknown[]; post: unknown[]; closed: boolean };
    } {
        const calls = { write: [] as unknown[], post: [] as unknown[], closed: false };
        const bag: VarSetFormCallbacks = {
            validate: () => ({ ok: true }),
            write: async (p) => { calls.write.push(p); },
            post: (msg) => { calls.post.push(msg); },
            close: () => { calls.closed = true; },
            ...overrides,
        };
        return { bag, calls };
    }

    test('cancel calls close and never post', async () => {
        const { bag, calls } = makeBag();
        await handleVarSetFormMessage({ command: 'cancel' }, bag);
        assert.strictEqual(calls.closed, true);
        assert.strictEqual(calls.post.length, 0, 'cancel must not post');
    });

    test('a valid save calls write exactly once', async () => {
        const { bag, calls } = makeBag();
        await handleVarSetFormMessage({ command: 'save', payload }, bag);
        assert.strictEqual(calls.write.length, 1);
    });

    test('an invalid save calls write zero times and posts the failure reason', async () => {
        const { bag, calls } = makeBag({ validate: () => ({ ok: false, reason: 'bad title' }) });
        await handleVarSetFormMessage({ command: 'save', payload }, bag);
        assert.strictEqual(calls.write.length, 0, 'write must not run when validate fails');
        assert.strictEqual(calls.post.length, 1);
        assert.deepStrictEqual(calls.post[0], { command: 'saveFailed', reason: 'bad title' });
    });
});
