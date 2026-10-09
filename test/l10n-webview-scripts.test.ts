import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORM_CLIENT_JS } from '../src/ui/panels/artifactForm/form.clientJs.js';
import { MAIN_PANE_CLIENT_JS } from '../src/ui/panels/settings.panel.helpers.js';

/**
 * T6.1 guard: every client-script / webview-fragment string this task owns
 * goes through `vscode.l10n.t` (baked in at import time via `jsStr`, since a
 * webview `<script>` cannot call `l10n.t` itself — see `preview.clientJs.ts`'s
 * JSDoc), not a raw literal.
 *
 * With no active translation bundle `vscode.l10n.t('X')` returns `'X'`
 * unchanged, so the *built* client-script string is byte-identical whether or
 * not the source calls `l10n.t` — asserting against `FORM_CLIENT_JS` /
 * `PREVIEW_CLIENT_JS` etc. cannot tell the two apart. The check has to be a
 * **source-text** scan, same as `test/l10n-sources.test.ts` / `l10n-ui.test.ts`
 * / `l10n-preview-render.test.ts` (T6.2a, sibling task): strip every
 * `l10n.t('...')` call's own argument text, then confirm the literal is gone
 * from what remains. `stripComments` copied verbatim from
 * `test/create-path-dry.test.ts:55` per the established convention.
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
 * read('ui/panels/artifactPicker/codeBlock.ts')
 */
function read(relPath: string): string {
    return stripComments(fs.readFileSync(path.join(srcRoot, relPath), 'utf8'));
}

/**
 * Whether `text` still appears in `src` outside of an `l10n.t(...)` call's
 * own argument list.
 *
 * @param src  - Comment-stripped source text.
 * @param text - Visible English string to check for as raw markup/literal.
 * @returns `true` when `text` survives outside every `l10n.t` call.
 *
 * @example
 * isHardcoded("l10n.t('Cancel')", 'Cancel')       // → false
 * isHardcoded("<button>Cancel</button>", 'Cancel') // → true
 */
function isHardcoded(src: string, text: string): boolean {
    const withoutL10nCalls = src.replace(/l10n\.t\(\s*(['"`])(?:(?!\1).)*\1/g, '');
    return withoutL10nCalls.includes(text);
}

suite('l10n — webview client scripts (T6.1)', () => {
    test('preview.clientJs.ts source carries no raw literal for its two strings', () => {
        const src = read('ui/panels/artifactPicker/preview.clientJs.ts');
        assert.ok(!isHardcoded(src, "'No variables defined.'"), 'No variables defined. is still a raw literal');
        assert.ok(!isHardcoded(src, "'from: '"), 'from:  is still a raw literal');
    });

    test('codeBlock.ts source localises the expand-editor title/aria-label', () => {
        const src = read('ui/panels/artifactPicker/codeBlock.ts');
        assert.ok(!isHardcoded(src, 'title="Open this block in the editor"'),
            'the expand-editor title is still a raw literal');
        assert.ok(!isHardcoded(src, 'aria-label="Open this block in the editor"'),
            'the expand-editor aria-label is still a raw literal');
    });

    test('form.clientJs.ts source carries no raw literal for its fourteen sites', () => {
        const src = read('ui/panels/artifactForm/form.clientJs.ts');
        // RED assertion the task names explicitly.
        assert.ok(!isHardcoded(src, "'Title is required.'"), 'a client-script string is still a raw literal');
        const rawLiterals = [
            "'Block heading'", "'Expand block in editor'", "'Toggle block'",
            "'Description'", "'Optional block description'", "'Remove {0}'",
            "'Add tag…'", "'At least one block must have code.'",
            "'Every block must have a heading.'", "'Invalid name.'",
            "'Default value'", "'Variables'",
        ];
        for (const literal of rawLiterals) {
            assert.ok(!isHardcoded(src, literal), `${literal} is still hardcoded in form.clientJs.ts`);
        }
        // The pinned esc(v.defaultValue) interpolation must survive byte-identical
        // in the BUILT string — this one check is legitimately against the bundle.
        assert.match(FORM_CLIENT_JS, /value="\s*'\s*\+\s*esc\(v\.defaultValue\)\s*\+/);
    });

    test('settings.panel.helpers.ts source localises MAIN_PANE_CLIENT_JS and MAIN_PANE_SECTION_HTML', () => {
        const src = read('ui/panels/settings.panel.helpers.ts');
        // RED assertion the task names explicitly.
        assert.ok(!isHardcoded(src, "'Off'"), 'the Off label is unlocalised');
        const rawLiterals = [
            "'Preview Pane'", "'Restore both values to their defaults'", "'Reset'",
            "'Variables height'", "'Share of the pane before the list scrolls'",
            "'Widen on open'",
        ];
        for (const literal of rawLiterals) {
            assert.ok(!isHardcoded(src, literal), `${literal} is still hardcoded`);
        }
        // Bundles still parse/load as valid JS regardless of l10n source-call
        // presence (belt-and-braces alongside webview-script-executes.test.ts).
        assert.ok(MAIN_PANE_CLIENT_JS.length > 0);
    });
});
