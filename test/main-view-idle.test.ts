import * as assert from 'node:assert';
import { buildCreateItems, renderIdleHtml, resolveCreateCommandId, IDLE_CLIENT_JS } from '../src/ui/views/mainView.render.js';
import { getCreateFormTypes } from '../src/services/artifact-type-config.service.js';

/**
 * Unit tests for the main pane's idle-mode data and HTML (T4, VSX-206).
 *
 * `buildCreateItems()` must be *derived* from `getCreateFormTypes()` /
 * `getEntry()` — never a hand-copied literal list — so a new create-form type
 * in `ARTIFACTS` surfaces here with no code change. `renderIdleHtml` must
 * escape every interpolated value; nothing else in this module may hand-roll
 * a second `esc`. `resolveCreateCommandId` is the message-boundary guard —
 * it must reject any `ArtifactType` that is not create-form-enabled, since a
 * webview message is untrusted input.
 */
suite('mainView — idle mode', () => {

    // D-9: bare labels, no `Create ` prefix — the New/Open toggle carries the verb.
    test('buildCreateItems() labels match the live registry, in order', () => {
        assert.deepStrictEqual(
            buildCreateItems().map(i => i.label),
            ['Snippets', 'AI Agents Config', 'Commands', 'Templates', 'AI Prompts'],
        );
    });

    test('buildCreateItems() types are derived from getCreateFormTypes(), not hand-copied', () => {
        assert.deepStrictEqual(buildCreateItems().map(i => i.type), getCreateFormTypes());
    });

    test('renderIdleHtml escapes a "<" in a label — no raw tag reaches the document', () => {
        const html = renderIdleHtml(
            [{ type: 'Snippet', label: 'Create <script>Snippets' }],
            'base.css',
            "'self'",
            'test-nonce',
        );
        assert.ok(html.includes('&lt;script&gt;'));
        assert.ok(!html.includes('<script>Snippets'));
    });

    test('resolveCreateCommandId resolves a create-form type to its base create id', () => {
        assert.strictEqual(resolveCreateCommandId('Snippet'), 'md-artifacts.create.snippets');
    });

    test('resolveCreateCommandId rejects a non-create-form type (e.g. Variables)', () => {
        assert.strictEqual(resolveCreateCommandId('Variables'), undefined);
    });

    test('resolveCreateCommandId rejects an arbitrary string that is not any ArtifactType', () => {
        assert.strictEqual(resolveCreateCommandId('NotARealType'), undefined);
    });

    test('the New rows are derived from getCreateFormTypes() — one data-action="createType" per row', () => {
        const html = renderIdleHtml(buildCreateItems(), 'base.css', "'self'", 'test-nonce');
        assert.strictEqual(
            [...html.matchAll(/data-action="createType"/g)].length,
            getCreateFormTypes().length,
        );
    });

    test('renders a filter input', () => {
        const html = renderIdleHtml(buildCreateItems(), 'base.css', "'self'", 'test-nonce');
        assert.ok(html.includes('id="idleFilter"'), 'no filter input rendered');
    });

    test('renders the New/Open toggle', () => {
        const html = renderIdleHtml(buildCreateItems(), 'base.css', "'self'", 'test-nonce');
        assert.ok(
            html.includes('data-mode="new"') && html.includes('data-mode="open"'),
            'the New/Open toggle is not in the markup',
        );
    });

    // Standing prohibition: IDLE_CLIENT_JS exported but never interpolated ships a dead
    // pane behind a green suite — neither the markup nor the constant-content test would
    // catch that alone. Precedent: settings-main-pane.test.ts:53-59.
    test('renderIdleHtml actually interpolates IDLE_CLIENT_JS', () => {
        const html = renderIdleHtml(buildCreateItems(), 'base.css', "'self'", 'test-nonce');
        assert.ok(html.includes(IDLE_CLIENT_JS), 'IDLE_CLIENT_JS is exported but never rendered into the page');
    });

    // Standing prohibition (security): restored state must never reach the DOM through
    // innerHTML, or persisted webview state becomes an injection vector into the pane.
    test('IDLE_CLIENT_JS never uses innerHTML to apply restored state', () => {
        assert.ok(!IDLE_CLIENT_JS.includes('innerHTML'));
    });
});
