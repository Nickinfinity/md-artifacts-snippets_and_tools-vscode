import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Drift guard: one `VarSetScanner` **instance**, not merely one class.
 *
 * `VarSetScanner` caches its recursive scan, so a second instance is a second
 * cache — and each is invalidated by only one of the two writers. T13 shipped
 * exactly that: a private scanner in the Variables tree meant Save-as-Variable-Set
 * left the tree stale, and the tree's own refresh left the Apply-Variable-Set
 * QuickPick stale. Both caches were "correct"; they just disagreed.
 *
 * Cache *identity* is not observable from a fixture test, so this is a source
 * grep instead — the same idiom the retired flag-marker guard and
 * `path-containment.test.ts` already use for facts that live in the shape of
 * the code rather than its behaviour. Every consumer calls `getVarSetScanner()`.
 */

/** Files permitted to contain the constructor call, and why. */
const ALLOWED = new Map<string, string>([
    ['ui/panels/varsetPicker.panel.ts', 'holds the one shared instance, exported as getVarSetScanner()'],
    ['services/varset.service.ts',      'the class definition — the call appears only inside a JSDoc @example'],
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

suite('VarSetScanner — one instance', () => {
    test('no src/ file constructs its own scanner outside the allowlist', () => {
        const srcRoot = path.resolve(__dirname, '..', '..', 'src');
        const offenders = collectTsFiles(srcRoot)
            .filter(file => fs.readFileSync(file, 'utf8').includes('new VarSetScanner('))
            .map(file => path.relative(srcRoot, file).split(path.sep).join('/'))
            .filter(rel => !ALLOWED.has(rel));

        assert.deepStrictEqual(
            offenders,
            [],
            `${offenders.join(', ')} constructs a second VarSetScanner — a second cache that only one writer invalidates. Call getVarSetScanner() instead.`,
        );
    });
});
