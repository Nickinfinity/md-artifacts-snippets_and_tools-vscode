import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * W5 drift guard: the two l10n bundles exist and carry identical key sets
 * (VSX-255).
 *
 * **Red by construction for the whole wave, deliberately.** This file is
 * landed *before* the wave's workers (hunk H5.0b) and reads files that
 * H5.1/H5.2 only write at wave close. Written after the bundles it checks, it
 * would be unprovable-red — a guard nobody has watched fail is decoration
 * (`CLAUDE.md`). Written first, it is red twice for the right reasons and each
 * closing hunk turns one half green. See `plan.md` §10: W5 is the one wave in
 * this plan with a sanctioned red gate, and its exact bounds are the three
 * `l10n-sources` suites plus this file. Anything else red is a real failure.
 *
 * The floor is a real number rather than `> 0` because `deepStrictEqual([], [])`
 * passes: an all-mis-spelled wave — three workers writing
 * `import { l10n } from 'vscode'` instead of `vscode.l10n.t(` — would produce
 * two empty bundles and certify a perfectly consistent nothing. The
 * per-file spelling assertion in `l10n-sources.test.ts` is what catches the
 * mis-spelling itself; this floor catches truncation.
 */

const l10nDir = path.resolve(__dirname, '..', '..', 'l10n');
const enPath = path.join(l10nDir, 'bundle.l10n.json');
const esPath = path.join(l10nDir, 'bundle.l10n.es.json');

/**
 * Reads one bundle as a key→value map.
 *
 * @param file - Absolute path to a `bundle.l10n*.json`.
 * @returns The parsed bundle object.
 *
 * @example
 * readBundle('/repo/l10n/bundle.l10n.json'); // → { 'Vault path not set': '…' }
 */
function readBundle(file: string): Record<string, unknown> {
    assert.ok(fs.existsSync(file),
        `${path.basename(file)} is missing — H5.1/H5.2 generate it at W5 close`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/**
 * The English bundle's key count floor.
 *
 * **Re-derived from H5.1's actual generated bundle at W5 close, as the plan
 * requires — this is a measurement, not the pre-generation placeholder.**
 * `@vscode/l10n-dev` extracted **103 keys from 91 files**, collapsed from 120
 * raw single-line call sites: 13 keys repeat, led by `Obsidian Artifacts: {0}`
 * at 15×, `Delete` at 4× and `Overwrite` at 3×. That collapse is why a key
 * count can never be derived from a site count.
 *
 * Set to 90% of the measured 103. The band is deliberate: tight enough that
 * losing a whole task's slice trips it (T5.3 alone is ~40 keys), loose enough
 * that W6's webview strings — which legitimately add and re-collapse keys —
 * do not force an edit here for every normal change. Raise it when W6 closes
 * and the surface stops moving.
 */
const EN_KEY_FLOOR = 92;

suite('l10n bundles', () => {
    test('the English bundle exists and is not empty or truncated', () => {
        const en = readBundle(enPath);
        assert.ok(Object.keys(en).length > EN_KEY_FLOOR,
            `the English bundle is empty or truncated — ${Object.keys(en).length} keys, floor ${EN_KEY_FLOOR}`);
    });

    test('the Spanish bundle carries exactly the English bundle keys', () => {
        const en = readBundle(enPath);
        const es = readBundle(esPath);
        assert.deepStrictEqual(Object.keys(es).sort(), Object.keys(en).sort(),
            'the es bundle has drifted from the English bundle');
    });
});
