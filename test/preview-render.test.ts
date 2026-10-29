import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderCodeHtml, renderCodeRowsHtml } from '../src/services/render.service.js';
import {
    renderPreviewHtml,
    renderMultiBlockPreviewHtml,
    renderPopupEmptyHtml,
    mergeVarsWithDefaults,
} from '../src/ui/panels/artifactPicker/preview.render.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of a regex in a string. */
function countMatches(html: string, pattern: RegExp): number {
    return (html.match(new RegExp(pattern.source, `g${pattern.flags.replace('g', '')}`)) ?? []).length;
}

/**
 * Unit tests for renderCodeHtml(code: string, fenceLang?: string): string.
 *
 * The function does NOT exist yet — all tests here should fail until
 * src/services/render.service.ts is implemented and exported.
 *
 * Expected HTML contract:
 *   <div class="code-block-wrapper">   ← outer wrapper, one per call
 *     <div class="code-line-row">      ← one per source line (paired)
 *       <span class="line-number">N</span>
 *       <span class="code-line">…</span>
 *     </div>
 *     …
 *   </div>
 */
suite('renderCodeHtml', () => {

    // ── Wrapper ───────────────────────────────────────────────────────────────

    test('output contains exactly one element with class code-block-wrapper', () => {
        const html = renderCodeHtml('hello');
        assert.strictEqual(
            countMatches(html, /class="[^"]*code-block-wrapper[^"]*"/),
            1,
        );
    });

    // ── Single line ───────────────────────────────────────────────────────────

    test('single-line code produces exactly one line-number element', () => {
        const html = renderCodeHtml('const x = 1;');
        assert.strictEqual(
            countMatches(html, /class="[^"]*line-number[^"]*"/),
            1,
        );
    });

    test('single-line code — the line-number element contains the text 1', () => {
        const html = renderCodeHtml('const x = 1;');
        assert.match(html, /class="[^"]*line-number[^"]*"[^>]*>\s*1\s*</);
    });

    test('single-line code produces exactly one code-line element', () => {
        const html = renderCodeHtml('const x = 1;');
        assert.strictEqual(
            countMatches(html, /class="[^"]*code-line[^"]*"/),
            1,
        );
    });

    // ── Multi-line ────────────────────────────────────────────────────────────

    test('5-line code produces exactly 5 line-number elements', () => {
        const html = renderCodeHtml('a\nb\nc\nd\ne');
        assert.strictEqual(
            countMatches(html, /class="[^"]*line-number[^"]*"/),
            5,
        );
    });

    test('5-line code — line numbers 1 through 5 are all present in order', () => {
        const html = renderCodeHtml('a\nb\nc\nd\ne');
        for (let n = 1; n <= 5; n++) {
            assert.match(
                html,
                new RegExp(`class="[^"]*line-number[^"]*"[^>]*>\\s*${n}\\s*<`),
                `line number ${n} not found`,
            );
        }
        // Verify ordering: each number appears before the next
        for (let n = 1; n < 5; n++) {
            const posN    = html.indexOf(`>${n}<`);
            const posNext = html.indexOf(`>${n + 1}<`);
            assert.ok(posN < posNext, `line number ${n} appears after ${n + 1}`);
        }
    });

    test('5-line code produces exactly 5 code-line elements', () => {
        const html = renderCodeHtml('a\nb\nc\nd\ne');
        assert.strictEqual(
            countMatches(html, /class="[^"]*code-line[^"]*"/),
            5,
        );
    });

    // ── Empty string ──────────────────────────────────────────────────────────

    test('empty string returns empty string or a wrapper with no line-number elements', () => {
        const html = renderCodeHtml('');
        const lineNumberCount = countMatches(html, /class="[^"]*line-number[^"]*"/);
        assert.ok(
            html === '' || lineNumberCount === 0,
            `expected empty output or zero line-numbers, got ${lineNumberCount} in: ${html}`,
        );
    });

    // ── Paired counts ─────────────────────────────────────────────────────────

    test('number of line-number elements equals number of code-line elements for single line', () => {
        const html = renderCodeHtml('hello world');
        assert.strictEqual(
            countMatches(html, /class="[^"]*line-number[^"]*"/),
            countMatches(html, /class="[^"]*code-line[^"]*"/),
        );
    });

    test('number of line-number elements equals number of code-line elements for 5 lines', () => {
        const html = renderCodeHtml('a\nb\nc\nd\ne');
        assert.strictEqual(
            countMatches(html, /class="[^"]*line-number[^"]*"/),
            countMatches(html, /class="[^"]*code-line[^"]*"/),
        );
    });

    // ── Per-line wrapping (CSS word-wrap / pre-wrap support) ──────────────────

    test('each line is in its own row element so CSS can apply pre-wrap without overflow', () => {
        // 3 lines → 3 row wrappers; each row must contain exactly one line-number + one code-line
        const html = renderCodeHtml('line1\nline2\nline3');
        // A "row" element wraps one line-number + one code-line pair
        const rowCount = countMatches(html, /class="[^"]*code-line-row[^"]*"/);
        assert.strictEqual(rowCount, 3, 'expected 3 code-line-row wrappers for 3 lines');
    });

    // ── Empty lines in the middle ─────────────────────────────────────────────

    test('empty line in the middle is preserved — 3 lines total when line 2 is empty', () => {
        const html = renderCodeHtml('first\n\nthird');
        assert.strictEqual(
            countMatches(html, /class="[^"]*line-number[^"]*"/),
            3,
            'empty middle line must still produce a line-number element',
        );
    });

    test('empty line in the middle — line number 2 is present', () => {
        const html = renderCodeHtml('first\n\nthird');
        assert.match(
            html,
            /class="[^"]*line-number[^"]*"[^>]*>\s*2\s*</,
            'line number 2 must appear even when the source line is empty',
        );
    });

    test('empty line in the middle — 3 code-line elements exist (one may be empty)', () => {
        const html = renderCodeHtml('first\n\nthird');
        assert.strictEqual(
            countMatches(html, /class="[^"]*code-line[^"]*"/),
            3,
        );
    });

    // ── fenceLang parameter ───────────────────────────────────────────────────

    test('fenceLang parameter is accepted without throwing', () => {
        assert.doesNotThrow(() => renderCodeHtml('const x = 1;', 'typescript'));
    });

    test('fenceLang parameter does not change the number of line-number elements', () => {
        const withLang    = renderCodeHtml('a\nb', 'bash');
        const withoutLang = renderCodeHtml('a\nb');
        assert.strictEqual(
            countMatches(withLang,    /class="[^"]*line-number[^"]*"/),
            countMatches(withoutLang, /class="[^"]*line-number[^"]*"/),
        );
    });

});

// ── VK-var highlighting ───────────────────────────────────────────────────────

/**
 * renderCodeHtml must wrap every <VK-xxx> token in the rendered output with a
 * <span class="vk-var"> that contains the full token text (delimiters included),
 * applied AFTER any syntax highlighting so it does not break hljs spans.
 *
 * Non-VK angle-bracket constructs must never receive this treatment.
 */
suite('renderCodeHtml — VK-var highlighting', () => {

    // ── Presence ──────────────────────────────────────────────────────────────

    test('<VK-items> in code → output contains a span with class vk-var', () => {
        const html = renderCodeHtml('const x = <VK-items>;');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            1,
        );
    });

    // ── Full token text preserved (delimiters visible) ────────────────────────

    test('span text contains the full <VK-items> token including < and > delimiters', () => {
        const html = renderCodeHtml('<VK-items>');
        // Accept both literal chars and HTML entity-escaped forms — browser renders both as "<VK-items>".
        assert.match(
            html,
            /<span[^>]*class="[^"]*vk-var[^"]*"[^>]*>(?:&lt;|<)VK-items(?:&gt;|>)<\/span>/,
        );
    });

    test('span text contains the full <VK-apiUrl> token with correct hint casing', () => {
        const html = renderCodeHtml('curl <VK-apiUrl>');
        assert.match(
            html,
            /<span[^>]*class="[^"]*vk-var[^"]*"[^>]*>(?:&lt;|<)VK-apiUrl(?:&gt;|>)<\/span>/,
        );
    });

    // ── Multiple vars on the same line ────────────────────────────────────────

    test('two vars on the same line each get their own vk-var span', () => {
        const html = renderCodeHtml('psql <VK-host>:<VK-port>/db');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            2,
        );
    });

    test('three vars on the same line produce three vk-var spans', () => {
        const html = renderCodeHtml('<VK-proto>://<VK-host>:<VK-port>');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            3,
        );
    });

    test('two different vars on same line — both tokens visible in output', () => {
        const html = renderCodeHtml('<VK-host>:<VK-port>');
        assert.match(html, /(?:&lt;|<)VK-host(?:&gt;|>)/);
        assert.match(html, /(?:&lt;|<)VK-port(?:&gt;|>)/);
    });

    // ── Non-VK angle brackets are NOT wrapped ────────────────────────────────

    test('<div> HTML tag does not produce a vk-var span', () => {
        const html = renderCodeHtml('<div>hello</div>');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            0,
        );
    });

    test('Array<string> generic does not produce a vk-var span', () => {
        const html = renderCodeHtml('const items: Array<string> = [];');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            0,
        );
    });

    test('<v-btn> Vue component tag does not produce a vk-var span', () => {
        const html = renderCodeHtml('<v-btn @click="go">OK</v-btn>');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            0,
        );
    });

    test('mix of VK token and non-VK tags — only the VK token is wrapped', () => {
        const html = renderCodeHtml('<div class="x"><VK-name></div>');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            1,
        );
    });

    // ── Applied after syntax highlighting ─────────────────────────────────────

    test('vk-var spans present alongside hljs spans when fenceLang is provided', () => {
        const html = renderCodeHtml('const url = <VK-apiUrl>;', 'javascript');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            1,
            'vk-var span missing when fenceLang triggers syntax highlighting',
        );
    });

    test('hljs spans and vk-var spans coexist — neither replaces the other', () => {
        const html = renderCodeHtml('const x = <VK-val>;', 'javascript');
        const hasHljsSpans = /<span[^>]*class="[^"]*hljs[^"]*"/.test(html);
        const hasVkSpan    = /<span[^>]*class="[^"]*vk-var[^"]*"/.test(html);
        assert.ok(hasHljsSpans, 'expected hljs spans from syntax highlighting');
        assert.ok(hasVkSpan,    'expected vk-var span alongside hljs spans');
    });

    // ── VK vars across multiple lines ─────────────────────────────────────────

    test('VK vars on different lines each produce their own vk-var span', () => {
        const html = renderCodeHtml('<VK-host>\n<VK-port>');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            2,
        );
    });

    test('line without a VK var has no vk-var span; line with one has exactly one', () => {
        const html = renderCodeHtml('no vars here\nhas <VK-name> here\nno vars again');
        assert.strictEqual(
            countMatches(html, /class="[^"]*vk-var[^"]*"/),
            1,
        );
    });

});

// ── Phase 6: preview.render.ts (moved from preview.ts) ───────────────────────

/**
 * mergeVarsWithDefaults — three-tier var resolution used by `handleInsert`.
 * Moved from preview.ts to preview.render.ts in Phase 6; had no prior
 * dedicated test, so this suite is new coverage, not a relocation.
 */
suite('mergeVarsWithDefaults', () => {

    test('user-typed value wins over the default', () => {
        const result = mergeVarsWithDefaults(
            { 'VK-host': 'typed.example.com' },
            [{ name: 'VK-host', defaultValue: 'localhost' }],
        );
        assert.strictEqual(result['VK-host'], 'typed.example.com');
    });

    test('empty user input falls back to defaultValue', () => {
        const result = mergeVarsWithDefaults(
            { 'VK-host': '' },
            [{ name: 'VK-host', defaultValue: 'localhost' }],
        );
        assert.strictEqual(result['VK-host'], 'localhost');
    });

    test('neither user input nor default → key is omitted (token survives resolveVars)', () => {
        const result = mergeVarsWithDefaults(
            {},
            [{ name: 'VK-host', defaultValue: '' }],
        );
        assert.strictEqual(Object.hasOwn(result, 'VK-host'), false);
    });

    test('raw map missing the var entirely still falls back to defaultValue', () => {
        const result = mergeVarsWithDefaults(
            {},
            [{ name: 'VK-port', defaultValue: '8080' }],
        );
        assert.strictEqual(result['VK-port'], '8080');
    });
});

/**
 * Golden/uniqueness tests for renderPreviewHtml et al. — Phase 6 moved these
 * out of preview.ts into preview.render.ts and collapsed the webview-side
 * `esc`/`lbl` copies into one shared snippet (`webviewSnippets.ts`). This
 * fixture deliberately carries a defaultValue with `"` and `'` so the golden
 * captures the new 5-char client-side escaping.
 */
suite('renderPreviewHtml — Phase 6 render-level golden', () => {

    const FIXTURE: ParsedArtifactFile = {
        filePath:     '/vault/Snippets/demo.md',
        fileName:     'demo',
        relativePath: 'demo.md',
        frontmatter: {
            artifactType: 'Snippet',
            title:       'Demo Snippet',
            description: 'A demo artifact for golden tests.',
            language:    'javascript',
            tags:        ['demo', 'golden'],
        },
        code: 'console.log(<VK-msg>);',
        vars: [{ name: 'VK-msg', defaultValue: `it's "ok"` }],
        blocks: [],
    };

    const SNAPSHOT_DIR = path.join(__dirname, '../../test/fixtures/preview-render-golden');

    /**
     * Writes or compares an HTML snapshot for this suite only.
     *
     * @param name   - Snapshot file name (without extension).
     * @param actual - HTML string to compare or record.
     */
    function snapshot(name: string, actual: string): void {
        const filePath = path.join(SNAPSHOT_DIR, `${name}.html`);
        if (process.env['UPDATE_SNAPSHOTS']) {
            fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
            fs.writeFileSync(filePath, actual, 'utf8');
            return;
        }
        let expected: string;
        try {
            expected = fs.readFileSync(filePath, 'utf8');
        } catch {
            throw new Error(`Snapshot missing: ${filePath}\nRun with UPDATE_SNAPSHOTS=1 to generate.`);
        }
        assert.strictEqual(actual, expected, `Snapshot mismatch: ${name}`);
    }

    test('output is byte-identical to the locked golden', () => {
        const codeRowsHtml = renderCodeRowsHtml(FIXTURE.code, FIXTURE.frontmatter.language);
        const html = renderPreviewHtml(FIXTURE, codeRowsHtml, 'test-nonce-abc123', 'https://test-css-uri/styles.css', 'https://test-csp-source', {});
        snapshot('demo-snippet', html);
    });

    test('the shared esc/lbl function bodies appear exactly once in the generated document', () => {
        const codeRowsHtml = renderCodeRowsHtml(FIXTURE.code, FIXTURE.frontmatter.language);
        const html = renderPreviewHtml(FIXTURE, codeRowsHtml, 'test-nonce-abc123', 'https://test-css-uri/styles.css', 'https://test-csp-source', {});
        assert.strictEqual(countMatches(html, /function esc\(/), 1);
        assert.strictEqual(countMatches(html, /function lbl\(/), 1);
    });

    test('renderMultiBlockPreviewHtml — read-only preview does not embed a <script> tag', () => {
        const html = renderMultiBlockPreviewHtml(
            FIXTURE,
            [{ heading: 'Block A', codeHtml: renderCodeHtml('a();', 'javascript'), vars: [], description: '' }],
            'https://test-css-uri/styles.css',
            'https://test-csp-source',
        );
        assert.ok(!html.includes('<script'));
        assert.ok(html.includes('Block A'));
    });

    test('renderPopupEmptyHtml — no script tag, no esc/lbl duplication concern', () => {
        const html = renderPopupEmptyHtml('https://test-css-uri/styles.css', 'https://test-csp-source');
        assert.ok(!html.includes('<script'));
        assert.ok(html.includes('Select a file to preview'));
    });
});

// ── T6: primary-button label is type-aware ────────────────────────────────────

/**
 * The only per-type rendering difference for the interactive preview: a template
 * writes a whole file (Create File), everything else inserts (Insert). The
 * snippet golden above is the tripwire proving the branch did not leak wider.
 */
suite('renderPreviewHtml — Create File button for templates', () => {

    function render(artifactType: 'Snippet' | 'Template' | 'AIAgentsConfig'): string {
        const artifact: ParsedArtifactFile = {
            filePath:     '/vault/Templates/comp.md',
            fileName:     'comp',
            relativePath: 'comp.md',
            frontmatter:  { artifactType, title: 'Comp', language: 'typescriptreact' },
            code:         'export const Comp = () => null;',
            vars:         [],
            blocks:       [],
        };
        const rows = renderCodeRowsHtml(artifact.code, artifact.frontmatter.language);
        return renderPreviewHtml(artifact, rows, 'n', 'css', 'csp', {});
    }

    test('a template artifact labels the primary button "Create File"', () => {
        const html = render('Template');
        assert.match(html, /id="insertBtn">Create File<\/button>/);
        assert.ok(!/id="insertBtn">Insert<\/button>/.test(html));
    });

    test('an agent artifact labels the primary button "Create File"', () => {
        const html = render('AIAgentsConfig');
        assert.match(html, /id="insertBtn">Create File<\/button>/);
        assert.ok(!/id="insertBtn">Insert<\/button>/.test(html));
    });

    test('a cursor-insert artifact still labels it "Insert"', () => {
        const html = render('Snippet');
        assert.match(html, /id="insertBtn">Insert<\/button>/);
        assert.ok(!/Create File/.test(html));
    });
});

suite('empty code line renders a <br> so Chromium can hold a caret', () => {
    test('renderCodeRowsHtml: exactly one <br> cell for "a\\n\\nb"', () => {
        const html = renderCodeRowsHtml('a\n\nb');
        assert.strictEqual(html.split('<span class="code-content"><br></span>').length - 1, 1);
    });
    test('renderCodeHtml: same <br> cell', () => {
        assert.ok(renderCodeHtml('a\n\nb').includes('<span class="code-content"><br></span>'));
    });
});
