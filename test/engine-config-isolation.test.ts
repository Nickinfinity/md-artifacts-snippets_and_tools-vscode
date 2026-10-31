import * as assert from 'node:assert';
import * as path from 'node:path';

/**
 * The test host must run the engine against a throwaway config dir: `activate()` asks the engine
 * for its default vault, and the developer's real one must never become the suite's session vault.
 * Set by `.vscode-test.mjs` (`env`); the engine honours an absolute `MDA_CONFIG_DIR` at v0.13.0.
 */
suite('engine config isolation', () => {
    test('MDA_CONFIG_DIR is set to an absolute temp dir in the test host', () => {
        const dir = process.env['MDA_CONFIG_DIR'];
        assert.ok(dir, 'MDA_CONFIG_DIR is unset — the suite would read the real engine config');
        assert.ok(path.isAbsolute(dir), `MDA_CONFIG_DIR must be absolute (relative is ignored by the engine): ${dir}`);
        assert.ok(dir.startsWith('/tmp/'), `MDA_CONFIG_DIR must be a temp dir, got ${dir}`);
    });
});
