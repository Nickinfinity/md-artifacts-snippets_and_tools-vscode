import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    setPreviewTarget,
    getPreviewTarget,
    type PreviewVarTarget,
} from '../src/services/preview-target.service.js';

/**
 * Unit tests for the `vscode`-free "which preview receives variable values"
 * registry (T0.3).
 *
 * The registry is one module-level slot, and this suite runs inside the same
 * single extension host as every other test file (`.vscode-test.mjs` loads
 * `dist/test/**\/*.test.js` into one process) — Wave 1's tests will also call
 * `setPreviewTarget`. So a test may never assume the slot starts empty; it
 * must instead prove the round trip it performed itself, and always release
 * in `teardown` so a failing assertion mid-test cannot leak a stale target
 * into a sibling test file.
 */
suite('preview-target.service', () => {

    /** A minimal stand-in for a live preview; none of its methods are exercised here — only identity matters. */
    function fakeTarget(): PreviewVarTarget {
        return {
            applyVarSet: () => { /* not exercised — registry only stores identity */ },
            currentValues: () => ({}),
            saveAsSet: async () => { /* not exercised — registry only stores identity */ },
        };
    }

    let release: (() => void) | undefined;

    teardown(() => {
        // Round-trip cleanup, not a "registry starts clean" assumption — see
        // the suite doc above.
        release?.();
        release = undefined;
    });

    test('set/get round trip; release() clears the slot', () => {
        const targetA = fakeTarget();
        release = setPreviewTarget(targetA);
        assert.strictEqual(getPreviewTarget(), targetA);

        release();
        assert.strictEqual(getPreviewTarget(), undefined, 'release() must clear the slot');
        release = undefined;
    });

    test('a stale release must not clear a newer target', () => {
        const targetA = fakeTarget();
        const targetB = fakeTarget();

        const first = setPreviewTarget(targetA);
        release = setPreviewTarget(targetB);
        first(); // the FIRST target's release, called late

        assert.strictEqual(getPreviewTarget(), targetB, 'a stale release must not clear a newer target');
    });

    test('registry source stays vscode-free', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '..', '..', 'src', 'services', 'preview-target.service.ts'),
            'utf8',
        );
        assert.ok(!src.includes("from 'vscode'"), 'the registry must stay vscode-free');
    });
});
