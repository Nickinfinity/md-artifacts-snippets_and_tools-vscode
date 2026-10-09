import * as assert from 'node:assert';
import { sanitiseVarsSnapshot } from '../src/ui/panels/artifactPicker/preview.helpers.js';

/**
 * Guards the `varsSnapshot` channel's key safety (W1/H1.4).
 *
 * The webview posts `{ command: 'varsSnapshot', values }` on every var-input
 * edit, and the host caches it so `PreviewVarTarget.currentValues()` can stay
 * synchronous. The **keys** of that payload are untrusted: they come from
 * `data-var` attributes rendered out of vault-authored content, and the
 * webview's `collectVars()` builds a plain `{}`. Copying that onto another
 * plain object is the classic prototype-pollution shape.
 *
 * Raised by the Wave 1 reviewer against H1.4 specifically, while approving
 * T1.2 — nothing consumed the message until this hunk, so the defect could
 * only ever land here.
 */
suite('varsSnapshot key safety (H1.4)', () => {

    test('ordinary values round-trip', () => {
        const out = sanitiseVarsSnapshot({ 'VK-host': 'localhost', 'VK-port': '8080' });
        assert.strictEqual(out['VK-host'], 'localhost');
        assert.strictEqual(out['VK-port'], '8080');
    });

    test('a __proto__ key never reaches Object.prototype', () => {
        // The genuine red: with a plain `{}` accumulator and no key filter,
        // assigning `__proto__` silently replaces the object's prototype
        // instead of adding a property — and `({}).polluted` becomes defined
        // for every object in the host.
        const out = sanitiseVarsSnapshot(JSON.parse('{"__proto__": {"polluted": "yes"}}'));

        assert.strictEqual(
            ({} as Record<string, unknown>)['polluted'], undefined,
            'Object.prototype was polluted by a hostile varsSnapshot key',
        );
        assert.strictEqual(out['polluted'], undefined, 'the hostile key leaked into the snapshot');
    });

    test('constructor and prototype keys are dropped', () => {
        const out = sanitiseVarsSnapshot({ constructor: 'x', prototype: 'y', 'VK-ok': 'kept' });
        assert.strictEqual(out['constructor'], undefined, 'a constructor key was copied through');
        assert.strictEqual(out['prototype'], undefined, 'a prototype key was copied through');
        assert.strictEqual(out['VK-ok'], 'kept', 'a legitimate sibling key was dropped with the hostile ones');
    });

    test('non-string values are dropped, not coerced', () => {
        const out = sanitiseVarsSnapshot({ 'VK-obj': { nested: 1 }, 'VK-num': 42, 'VK-str': 'ok' });
        assert.strictEqual(out['VK-obj'], undefined, 'an object value was coerced instead of dropped');
        assert.strictEqual(out['VK-num'], undefined, 'a number value was coerced instead of dropped');
        assert.strictEqual(out['VK-str'], 'ok');
    });

    test('a non-object payload yields an empty map rather than throwing', () => {
        for (const raw of [undefined, null, 'string', 42]) {
            assert.deepStrictEqual(
                Object.keys(sanitiseVarsSnapshot(raw)), [],
                `a ${typeof raw} payload must yield an empty map`,
            );
        }
    });
});
