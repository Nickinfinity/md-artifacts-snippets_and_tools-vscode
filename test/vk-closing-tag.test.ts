import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractVars, renderCodeHtml, VK_TOKEN_RE } from '../src/services/render.service.js';
import { stripComments } from './read-path-guard.test.js';
import { CODE_BLOCK_CLIENT_JS } from '../src/ui/panels/artifactPicker/codeBlock.js';

/**
 * `</VK-x>` is the render-safe spelling of `<VK-x>`.
 *
 * Unfenced markdown (a flagged payload) treats `<VK-repo>` as a legal HTML open
 * tag, so Obsidian renders it as an unclosed custom element that swallows every
 * block below it. Closing the tag fixes the note; these tests pin that both
 * spellings mean **one** variable, and that a pair yields the value **once**.
 */

suite('extractVars — closing tags are the same variable', () => {

    test('a lone closing tag is detected', () => {
        assert.deepStrictEqual(extractVars('Review </VK-repo>.'), [{ name: 'VK-repo', defaultValue: '' }]);
    });

    test('an adjacent pair is one variable, not two', () => {
        assert.deepStrictEqual(extractVars('Review <VK-repo></VK-repo>.'), [{ name: 'VK-repo', defaultValue: '' }]);
    });

    test('opening and closing forms of the same name collapse to one entry', () => {
        assert.deepStrictEqual(
            extractVars('<VK-repo> ... </VK-repo> ... <VK-repo>'),
            [{ name: 'VK-repo', defaultValue: '' }],
        );
    });

    test('order still follows first appearance across both forms', () => {
        assert.deepStrictEqual(
            extractVars('</VK-b> <VK-a>').map(v => v.name),
            ['VK-b', 'VK-a'],
        );
    });

    test('a closing tag that is not a VK token is ignored', () => {
        assert.deepStrictEqual(extractVars('</div> </VKfoo> <a href="x">'), []);
    });
});

suite('render — closing tags are highlighted like opening ones', () => {

    test('a closing tag gets its own vk-var span', () => {
        const html = renderCodeHtml('Review </VK-repo>.', 'markdown');
        assert.match(html, /<span[^>]*class="[^"]*vk-var[^"]*"[^>]*>&lt;\/VK-repo&gt;<\/span>/);
    });

    test('a pair produces two spans and no stray markup', () => {
        const html = renderCodeHtml('<VK-repo></VK-repo>', 'markdown');
        assert.strictEqual((html.match(/class="[^"]*vk-var[^"]*"/g) ?? []).length, 2);
    });
});

// ── Drift guard ─────────────────────────────────────────────────────────────────

/**
 * The webview's `vkWrap` cannot import `VK_TOKEN_RE` (client JS has no module
 * system), so it carries a twin pattern. Bind them: the webview highlighter must
 * recognise exactly the tokens the parser resolves, or a token renders plain in
 * the code area and silently vanishes on insert.
 */
suite('webview vkWrap matches VK_TOKEN_RE', () => {

    /** Pulls the `vkWrap` regex literal out of the generated client JS. */
    function webviewTokenRe(): RegExp {
        const src = /html\.replace\(\/(.+?)\/g,/.exec(CODE_BLOCK_CLIENT_JS);
        assert.ok(src, 'vkWrap regex not found in CODE_BLOCK_CLIENT_JS');
        // The webview matches HTML-escaped text; decode so both patterns are
        // compared against the same raw token spellings.
        const body = src[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>');
        return new RegExp(body, 'g');
    }

    const CASES = ['<VK-repo>', '</VK-repo>', '<VK-a_b>', '</VK-a_b>'];
    const NON_TOKENS = ['<div>', '</div>', '<VK->', '</VK->', '<vk-repo>'];

    for (const token of CASES) {
        test(`both patterns match ${token}`, () => {
            assert.strictEqual(
                new RegExp(VK_TOKEN_RE.source, 'g').test(token),
                webviewTokenRe().test(token),
                `parser and webview disagree on ${token}`,
            );
        });
    }

    for (const token of NON_TOKENS) {
        test(`both patterns reject ${token}`, () => {
            assert.strictEqual(new RegExp(VK_TOKEN_RE.source, 'g').test(token), false, `parser matched ${token}`);
            assert.strictEqual(webviewTokenRe().test(token), false, `webview matched ${token}`);
        });
    }
});

suite('extractVars — token detection', () => {

    // ── Positive matches ─────────────────────────────────────────────────────

    test('single var returns one ParsedVar with the full token as name and empty defaultValue', () => {
        const result = extractVars('<VK-items>');
        assert.deepStrictEqual(result, [{ name: 'VK-items', defaultValue: '' }]);
    });

    test('multiple distinct vars in one string are all returned in order of first appearance', () => {
        const result = extractVars('<VK-host> <VK-port> <VK-path>');
        assert.deepStrictEqual(result, [
            { name: 'VK-host',  defaultValue: '' },
            { name: 'VK-port',  defaultValue: '' },
            { name: 'VK-path',  defaultValue: '' },
        ]);
    });

    test('repeated var is deduplicated — only the first occurrence is kept', () => {
        const result = extractVars('<VK-items> and <VK-items> and <VK-items>');
        assert.deepStrictEqual(result, [{ name: 'VK-items', defaultValue: '' }]);
    });

    test('camelCase hint <VK-myVar> is valid', () => {
        const result = extractVars('<VK-myVar>');
        assert.deepStrictEqual(result, [{ name: 'VK-myVar', defaultValue: '' }]);
    });

    test('UPPER_SNAKE_CASE hint <VK-MY_VAR> is valid', () => {
        const result = extractVars('<VK-MY_VAR>');
        assert.deepStrictEqual(result, [{ name: 'VK-MY_VAR', defaultValue: '' }]);
    });

    test('PascalCase hint <VK-MyComponent> is valid', () => {
        const result = extractVars('<VK-MyComponent>');
        assert.deepStrictEqual(result, [{ name: 'VK-MyComponent', defaultValue: '' }]);
    });

    test('mixed-casing vars in one string all extracted correctly', () => {
        const result = extractVars('<VK-myVar> <VK-MY_VAR> <VK-MyComponent>');
        assert.deepStrictEqual(result, [
            { name: 'VK-myVar',       defaultValue: '' },
            { name: 'VK-MY_VAR',      defaultValue: '' },
            { name: 'VK-MyComponent', defaultValue: '' },
        ]);
    });

    test('vars embedded in real JS code are all extracted', () => {
        const code = 'const x = <VK-items>.filter(i => i.<VK-prop> === <VK-value>)';
        const result = extractVars(code);
        assert.deepStrictEqual(result, [
            { name: 'VK-items', defaultValue: '' },
            { name: 'VK-prop',  defaultValue: '' },
            { name: 'VK-value', defaultValue: '' },
        ]);
    });

    // ── Negative matches — nothing should be extracted ───────────────────────

    test('plain HTML tags <div> and <span> produce no matches', () => {
        assert.deepStrictEqual(
            extractVars('<div><span>Hello</span></div>'),
            [],
        );
    });

    test('Vue-style components <v-btn> and <v-card> produce no matches', () => {
        assert.deepStrictEqual(
            extractVars('<v-btn @click="go"><v-card></v-card></v-btn>'),
            [],
        );
    });

    test('TypeScript generics Array<string> and Map<K,V> produce no matches', () => {
        assert.deepStrictEqual(
            extractVars('const a: Array<string> = []; const m: Map<K,V> = new Map();'),
            [],
        );
    });

    test('JSX component <MyComponent> produces no match', () => {
        assert.deepStrictEqual(
            extractVars('<MyComponent prop="val" />'),
            [],
        );
    });

    test('old {{variable}} placeholder syntax produces no matches', () => {
        assert.deepStrictEqual(
            extractVars('Hello {{name}}, your order {{orderId}} is ready.'),
            [],
        );
    });

    test('<VK> with no hyphen and no hint produces no match', () => {
        assert.deepStrictEqual(extractVars('<VK>'), []);
    });

    test('<VK-> with empty hint produces no match', () => {
        assert.deepStrictEqual(extractVars('<VK->'), []);
    });

    test('empty string returns empty array', () => {
        assert.deepStrictEqual(extractVars(''), []);
    });

});

// ── One owner ───────────────────────────────────────────────────────────────────

/**
 * `VK_TOKEN_RE` is token syntax for UI highlighting and live detection; a second
 * declaration is a second dialect. Held in `render.service.ts`, nowhere else.
 */
suite('VK_TOKEN_RE has one declaration', () => {

    /** Every `.ts` file under `dir`. */
    function walk(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { return walk(full); }
            return e.name.endsWith('.ts') ? [full] : [];
        });
    }

    test('exactly one `VK_TOKEN_RE =` in comment-stripped src/, in services/render.service.ts', () => {
        const src = path.join(__dirname, '..', '..', 'src');
        const owners = walk(src)
            .filter(f => /\bVK_TOKEN_RE\s*=/.test(
                stripComments(fs.readFileSync(f, 'utf8'))))
            .map(f => path.relative(src, f).split(path.sep).join('/'));
        assert.deepStrictEqual(owners, ['services/render.service.ts']);
    });
});
