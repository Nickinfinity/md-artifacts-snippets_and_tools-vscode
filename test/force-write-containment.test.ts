import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `force: true` may be spelled in exactly one place.
 *
 * `force` is the single flag standing between "write a new artifact" and
 * "overwrite whatever is already there". The Variables **edit** path needs it —
 * the user is editing a file that exists. Every other path must not have it:
 * the Wave 4 batch writer is explicitly forbidden `force`, because overwriting a
 * user's artifact is not a batch decision, and a collision there must degrade to
 * a skip.
 *
 * Same idiom as `varset-scanner-singleton.test.ts` and the retired flag-marker guard:
 * the fact lives in the shape of the code, so a source grep is the check that
 * can actually fail.
 *
 * **Comments are stripped before matching**, and that is not a nicety. The
 * first version of this guard failed on `createIndexRunner.ts` — whose JSDoc
 * states that it *never* passes `force: true`. A grep that cannot tell code
 * from prose flags the file documenting the rule it enforces, which is the
 * same defect as the T0 placeholder gate (ledger #29): a check that fires on
 * its own documentation is not a check.
 */

/**
 * Strips block and line comments so the scan sees code only.
 *
 * @param source - Raw TypeScript source text.
 * @returns The source with comments blanked out.
 *
 * @example
 * stripComments('a(); // force: true'); // → 'a(); '
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

/** Files permitted to pass `force: true`, and why. */
const ALLOWED = new Map<string, string>([
]);

/**
 * Recursively lists every `.ts` file under a directory.
 *
 * @param dir - Directory to walk.
 * @returns Absolute paths of every `.ts` file found.
 *
 * @example
 * collectTsFiles('/repo/src'); // → ['/repo/src/extension.ts', …]
 */
function collectTsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { return collectTsFiles(full); }
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

suite('force: true — one write path only', () => {
    test('no src/ file passes force outside the allowlist', () => {
        const srcRoot = path.resolve(__dirname, '..', '..', 'src');
        const offenders = collectTsFiles(srcRoot)
            .filter(file => /force:\s*true/.test(stripComments(fs.readFileSync(file, 'utf8'))))
            .map(file => path.relative(srcRoot, file).split(path.sep).join('/'))
            .filter(rel => !ALLOWED.has(rel));

        assert.deepStrictEqual(
            offenders,
            [],
            `${offenders.join(', ')} passes force: true — that overwrites an existing artifact without asking. Only the Variables edit path may.`,
        );
    });
});
