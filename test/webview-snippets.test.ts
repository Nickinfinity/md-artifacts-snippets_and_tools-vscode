import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { escHtml } from '../src/utils/html.js';
import { labelForVar } from '../src/ui/panels/artifactPicker/preview.helpers.js';
import { WEBVIEW_ESC_LBL_JS, jsStr } from '../src/ui/panels/artifactPicker/webviewSnippets.js';
import { CODE_BLOCK_CLIENT_JS } from '../src/ui/panels/artifactPicker/codeBlock.js';
import { PREVIEW_CLIENT_JS } from '../src/ui/panels/artifactPicker/preview.clientJs.js';
import { FORM_CLIENT_JS } from '../src/ui/panels/artifactForm/form.clientJs.js';

/**
 * Unit tests for Phase 6's shared webview `esc`/`lbl` snippet
 * (`webviewSnippets.ts`) and the security fix it enables in
 * `form.clientJs.ts`'s `renderVarsSection`.
 *
 * This test runtime is the VS Code *extension host* process
 * (`@vscode/test-electron`), which — unlike a webview — has no `document`/
 * `window` DOM. `esc`/`lbl` themselves are pure string functions with no DOM
 * dependency, so they can be extracted and evaluated directly. Anything that
 * needs a real `innerHTML`/`.textContent` round-trip is instead proven with a
 * hand-written decoder for the exact five named entities `esc` ever produces
 * — the standard, unambiguous HTML5 decoding for those five references, and
 * the same thing `.textContent` returns after `innerHTML` parses them. No
 * DOM library (e.g. jsdom) is added for this — see CLAUDE.md "No runtime
 * dependencies".
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of a regex in a string. */
function countMatches(html: string, pattern: RegExp): number {
    return (html.match(new RegExp(pattern.source, `g${pattern.flags.replace('g', '')}`)) ?? []).length;
}

/**
 * Evaluates `WEBVIEW_ESC_LBL_JS` and returns its `esc`/`lbl` functions as
 * real callables, so the tests below exercise the actual shipped source
 * text rather than a hand-copied re-implementation.
 *
 * @returns `{ esc, lbl }` extracted from the snippet.
 */
function loadWebviewEscLbl(): { esc: (s: string) => string; lbl: (name: string) => string } {
    const factory = new Function(`${WEBVIEW_ESC_LBL_JS}\nreturn { esc: esc, lbl: lbl };`) as () => {
        esc: (s: string) => string;
        lbl: (name: string) => string;
    };
    return factory();
}

/**
 * Decodes the five named entities `esc`/`escHtml` ever produce, in the order
 * that avoids re-corrupting a literal `&` that was itself part of an entity
 * (decode `&amp;` last — the mirror image of `esc` encoding it first).
 *
 * @param s - Text containing `&amp; &lt; &gt; &quot; &#39;` entities.
 * @returns Decoded plain text.
 */
function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

// ── esc matches canonical escHtml ───────────────────────────────────────────

suite('WEBVIEW_ESC_LBL_JS — esc matches canonical escHtml', () => {

    test('escapes the same 5 characters as escHtml, same output', () => {
        const { esc } = loadWebviewEscLbl();
        const sample = `it's "quoted" <tag> & more`;
        assert.strictEqual(esc(sample), escHtml(sample));
    });

    test('each of & < > " \' individually matches escHtml', () => {
        const { esc } = loadWebviewEscLbl();
        for (const ch of ['&', '<', '>', '"', "'"]) {
            assert.strictEqual(esc(ch), escHtml(ch));
        }
    });

    test('ampersand is escaped once, not double-escaped (order matches escHtml)', () => {
        const { esc } = loadWebviewEscLbl();
        assert.strictEqual(esc('&lt;'), escHtml('&lt;'));
    });
});

// ── esc round-trips through decode (proxy for a webview .textContent read) ─

suite('WEBVIEW_ESC_LBL_JS — esc round-trip', () => {

    test('a string containing " and \' round-trips through decode(esc(x))', () => {
        const { esc } = loadWebviewEscLbl();
        const raw = `He said "don't" & <run>`;
        assert.strictEqual(decodeEntities(esc(raw)), raw);
    });

    test('a string with only a double quote round-trips', () => {
        const { esc } = loadWebviewEscLbl();
        const raw = 'value with "quotes" inside';
        assert.strictEqual(decodeEntities(esc(raw)), raw);
    });

    test('a string with only a single quote round-trips', () => {
        const { esc } = loadWebviewEscLbl();
        const raw = "it's a value";
        assert.strictEqual(decodeEntities(esc(raw)), raw);
    });
});

// ── lbl matches canonical labelForVar (pinned inputs) ───────────────────────

/**
 * Pinned expected labels for `labelForVar` — see services-dry.md Phase 6:
 * three different hand-rolled implementations existed before this phase and
 * were claimed to "differ on edge cases (multiple underscores, leading
 * underscore, digits)". These are the concrete inputs the plan named.
 */
const LABEL_CASES: [string, string][] = [
    ['VK-host',     'Host'],
    ['VK-api_key',  'Api key'],
    ['VK-API_KEY',  'Api key'],
    ['VK-a_b_c',    'A b c'],
    ['VK-_leading', ' leading'],
    ['VK-x2y',      'X2y'],
    ['VK-UPPER',    'Upper'],
];

suite('labelForVar — pinned canonical values', () => {
    for (const [input, expected] of LABEL_CASES) {
        test(`labelForVar(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
            assert.strictEqual(labelForVar(input), expected);
        });
    }
});

suite('WEBVIEW_ESC_LBL_JS — lbl matches canonical labelForVar on every pinned input', () => {
    const { lbl } = loadWebviewEscLbl();
    for (const [input] of LABEL_CASES) {
        test(`lbl(${JSON.stringify(input)}) === labelForVar(${JSON.stringify(input)})`, () => {
            assert.strictEqual(lbl(input), labelForVar(input));
        });
    }
});

// ── Single definition per generated webview document ────────────────────────

suite('shared esc/lbl — defined exactly once per generated client-JS bundle', () => {

    test('CODE_BLOCK_CLIENT_JS defines esc and lbl exactly once', () => {
        assert.strictEqual(countMatches(CODE_BLOCK_CLIENT_JS, /function esc\(/), 1);
        assert.strictEqual(countMatches(CODE_BLOCK_CLIENT_JS, /function lbl\(/), 1);
    });

    test('PREVIEW_CLIENT_JS defines esc and lbl exactly once (inherited from CODE_BLOCK_CLIENT_JS)', () => {
        assert.strictEqual(countMatches(PREVIEW_CLIENT_JS, /function esc\(/), 1);
        assert.strictEqual(countMatches(PREVIEW_CLIENT_JS, /function lbl\(/), 1);
    });

    test('FORM_CLIENT_JS defines esc and lbl exactly once (inherited from CODE_BLOCK_CLIENT_JS)', () => {
        assert.strictEqual(countMatches(FORM_CLIENT_JS, /function esc\(/), 1);
        assert.strictEqual(countMatches(FORM_CLIENT_JS, /function lbl\(/), 1);
    });

    test('PREVIEW_CLIENT_JS no longer defines its own local lbl/esc inside rebuildVarInputs', () => {
        // Before this phase, rebuildVarInputs() nested its own `function lbl(...)`
        // and `function esc(...)` — collapsing to the shared snippet means those
        // nested definitions are gone, not merely renamed.
        const rebuildVarInputsBody = PREVIEW_CLIENT_JS.slice(PREVIEW_CLIENT_JS.indexOf('function rebuildVarInputs'));
        assert.strictEqual(countMatches(rebuildVarInputsBody, /function lbl\(/), 0);
        assert.strictEqual(countMatches(rebuildVarInputsBody, /function esc\(/), 0);
    });
});

// ── Security fix: form.clientJs.ts renderVarsSection escapes both attrs ─────

suite('FORM_CLIENT_JS renderVarsSection — variable name/default are escaped', () => {

    test('does not contain the old unescaped data-var interpolation', () => {
        assert.ok(!FORM_CLIENT_JS.includes(`data-var="' + v.name + '"`));
    });

    test('does not contain the old unescaped value interpolation', () => {
        assert.ok(!FORM_CLIENT_JS.includes(`value="' + v.defaultValue + '"`));
    });

    test('routes v.name through esc() for the data-var attribute', () => {
        assert.match(FORM_CLIENT_JS, /const safeName = esc\(v\.name\);/);
    });

    test('routes v.defaultValue through esc() for the value attribute', () => {
        assert.match(FORM_CLIENT_JS, /value="\s*'\s*\+\s*esc\(v\.defaultValue\)\s*\+/);
    });

    test('a defaultValue containing " and < renders as escaped entities', () => {
        const { esc } = loadWebviewEscLbl();
        const value = 'bad" <script>';
        const rendered = esc(value);
        assert.ok(!rendered.includes('"'));
        assert.ok(!rendered.includes('<'));
        assert.strictEqual(rendered, 'bad&quot; &lt;script&gt;');
    });

    test('data-var round-trips: decoding esc(name) recovers the original name', () => {
        const { esc } = loadWebviewEscLbl();
        const name = `VK-weird"name'`;
        assert.strictEqual(decodeEntities(esc(name)), name);
    });
});

// ── H6.0 — `jsStr` is THE script-context escaping authority ───────────────────

/**
 * Strips block and line comments so the scan sees code only.
 *
 * Same shape as `test/create-path-dry.test.ts:55`. Load-bearing here: this
 * file's own JSDoc spells the escape while explaining the rule, so a guard
 * without it is permanently red against its own documentation.
 *
 * @param source - Raw TypeScript source text.
 * @returns The source with comments blanked out.
 *
 * @example
 * stripComments("const a = 1; // <\\/script>"); // → "const a = 1; "
 */
function stripCommentsTs(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

/**
 * Recursively lists every `.ts` file under a directory.
 *
 * @param dir - Directory to walk.
 * @returns Absolute paths of every `.ts` file found.
 *
 * @example
 * collectSrcTsFiles('/repo/src'); // → ['/repo/src/extension.ts', …]
 */
function collectSrcTsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { return collectSrcTsFiles(full); }
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

suite('jsStr — the one script-context escaper (H6.0)', () => {
    const SRC = path.resolve(__dirname, '../../src');
    const OWNER = path.join(SRC, 'ui/panels/artifactPicker/webviewSnippets.ts');

    test('neutralises a closing script tag', () => {
        assert.strictEqual(jsStr('</script><script>alert(1)'), '"<\\/script><script>alert(1)"');
    });

    test('no closing-tag sequence survives into the script body', () => {
        assert.ok(!jsStr('</script>').includes('</'),
            'a closing script tag survived into the script body');
    });

    test('no comment opener survives into the script body', () => {
        assert.ok(!jsStr('<!--').includes('<!--'),
            'a comment opener survived into the script body');
    });

    test('the escaped literal still evaluates back to the original', () => {
        for (const s of ['</script>', '<!--', 'Off', 'from: ', `a"b'c`]) {
            // eslint-disable-next-line no-eval
            assert.strictEqual(eval(jsStr(s)), s, `round-trip failed for ${JSON.stringify(s)}`);
        }
    });

    test('exactly one jsStr implementation exists in src/', () => {
        const owners = collectSrcTsFiles(SRC).filter(f =>
            /(?:export\s+)?function\s+jsStr\s*\(/.test(stripCommentsTs(fs.readFileSync(f, 'utf8'))));
        assert.deepStrictEqual(owners, [OWNER],
            `jsStr must be declared exactly once, in webviewSnippets.ts; found ${owners.length}`);
    });

    test('no other src/ file performs the script-context escape itself', () => {
        // Two traps, both paid for during H6.0:
        //
        // 1. The bare sequence `<` + backslash + `/` is NOT the thing to hunt:
        //    `parser.service.ts` carries it twice as ordinary regex syntax
        //    (`VK_TOKEN_RE` :98, `VK_PAIR_RE` :110) matching a `</VK-xxx>`
        //    closing tag. The needle below is the *replacement value* that
        //    produces the escape - `<`, backslash, backslash, `/` - which those
        //    regexes do not contain.
        // 2. This scan reads RAW source, not `stripCommentsTs` output. That
        //    stripper is not a lexer: a regex literal containing `/*` (exactly
        //    what an escaper line looks like) is swallowed as a comment, and the
        //    guard silently stops seeing the thing it exists to find. Verified
        //    by mutation - with stripping the probe went undetected; raw, it is
        //    caught. No `src/` file spells this needle in prose, so raw is safe.
        const escaper = '<' + '\\\\' + '/';
        const spellers = collectSrcTsFiles(SRC)
            .filter(f => f !== OWNER)
            .filter(f => fs.readFileSync(f, 'utf8').includes(escaper));
        assert.deepStrictEqual(spellers, [],
            'script-context escaping belongs to jsStr alone - import it, never re-spell it');
    });
});
