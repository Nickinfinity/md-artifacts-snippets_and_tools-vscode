import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T6.2a guard: no hardcoded visible text remains in the preview-side
 * renderers (`preview.render.ts`, `varSetDiff.ts`, `varsetForm.render.ts`).
 *
 * `stripComments` is load-bearing, not hygiene — the comment block at
 * `preview.render.ts:68-71` (pre-refactor line numbers) contains both
 * `Create File` and `Insert`, so without stripping, two assertions here would
 * be permanently red regardless of the markup. Copied verbatim from
 * `test/create-path-dry.test.ts:55` per the established pattern
 * (`test/l10n-ui.test.ts` notes it as the fifth local copy, test-only).
 */

const srcRoot = path.resolve(__dirname, '..', '..', 'src');

/**
 * Strips block and line comments so the scan sees code only.
 *
 * @param source - Raw TypeScript source text.
 * @returns The source with comments blanked out.
 *
 * @example
 * stripComments("if (x) {} // was if (y) {}");
 * // → "if (x) {} "
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

/**
 * Reads a `src/`-relative file and strips its comments.
 *
 * @param relPath - Path relative to `src/`.
 * @returns Comment-stripped source text.
 *
 * @example
 * read('ui/panels/artifactPicker/preview.render.ts')
 */
function read(relPath: string): string {
    return stripComments(fs.readFileSync(path.join(srcRoot, relPath), 'utf8'));
}

/**
 * True when `text` appears in `src` as raw markup rather than solely as the
 * key argument of a `vscode.l10n.t(...)` call.
 *
 * A literal `src.includes(text)` cannot distinguish the two: once a string is
 * correctly localised, `vscode.l10n.t('No variables defined.')` still
 * contains that exact English text as its extractable key — that is how
 * `@vscode/l10n-dev` finds it (see `test/l10n-sources.test.ts`'s pattern-based
 * convention, the established authority this file follows). Stripping every
 * `l10n.t('...')` / `l10n.t("...")` call's argument before searching is what
 * makes the guard test the actual defect (hardcoded HTML text) instead of an
 * unsatisfiable substring check.
 *
 * @param src  - Comment-stripped source text.
 * @param text - Visible English string to check for as raw markup.
 * @returns Whether `text` still appears outside any `l10n.t` call.
 *
 * @example
 * isHardcoded("l10n.t('Cancel')", 'Cancel')      // → false
 * isHardcoded("<button>Cancel</button>", 'Cancel') // → true
 */
function isHardcoded(src: string, text: string): boolean {
    const withoutL10nCalls = src.replace(/l10n\.t\(\s*(['"`])(?:(?!\1).)*\1/g, '');
    return withoutL10nCalls.includes(text);
}

suite('l10n — preview-side renderers (T6.2a)', () => {
    test('preview.render.ts carries no hardcoded visible text', () => {
        const src = read('ui/panels/artifactPicker/preview.render.ts');
        const hardcoded = [
            '>Variables<', 'No variables defined.', 'Overwrite', '>Cancel<',
            'Create File', "'Insert'", 'Resize the variables section',
            'Copy', '>Edit<', 'Press Enter to choose a block.',
            'Select a file to preview', 'env: ', 'target: ', 'from: ',
        ];
        for (const s of hardcoded) {
            assert.ok(!isHardcoded(src, s), `${s} is still hardcoded in the preview markup`);
        }
    });

    test('varSetDiff.ts renders the action enum through explicit l10n lookups, not a dynamic key', () => {
        const src = read('ui/panels/artifactPicker/varSetDiff.ts');
        assert.ok(!/l10n\.t\(\s*c\.action\s*\)/.test(src),
            'l10n.t(c.action) is a dynamic key the bundle extractor cannot see');
        assert.ok(!/const statusLabel = e\(c\.action\)/.test(src),
            'statusLabel still renders the raw enum value verbatim');
        for (const s of ['>Apply<', '>Cancel<']) {
            assert.ok(!isHardcoded(src, s), `${s} is still hardcoded in the diff markup`);
        }
    });

    test('varsetForm.render.ts carries no hardcoded visible text', () => {
        const src = read('ui/panels/varsetForm/varsetForm.render.ts');
        for (const s of ['>Name<', '>Description<', '>Tags<', '>Variables<', '>Cancel<', '>Save<']) {
            assert.ok(!isHardcoded(src, s), `${s} is still hardcoded in the varset-form markup`);
        }
    });
});
