import * as assert from 'node:assert';
import { buildBlockCard, buildSingleBlockContent, formCodeBlockHtml } from '../src/ui/panels/artifactForm/form.blocks.js';
import { FORM_CLIENT_JS } from '../src/ui/panels/artifactForm/form.clientJs.js';
import { buildFormHtml } from '../src/ui/panels/artifactForm/form.html.js';
import { defaultModel } from '../src/ui/panels/artifactForm/form.helpers.js';
import { buildCodeBlockHtml } from '../src/ui/panels/artifactPicker/codeBlock.js';
import { renderCodeRowsHtml } from '../src/services/render.service.js';
import type { ArtifactFormBlock } from '../src/types/artifact-form.types.js';

/**
 * T9 (VSX-211) — the create-form "expand block to editor" button.
 *
 * Three call sites render a block's code area, and all three must carry the
 * button or it vanishes on that path:
 * 1. `form.blocks.ts`'s `buildBlockCard` — server-rendered multi-block card.
 * 2. `form.clientJs.ts`'s `buildNewCardHtml` — client-added multi-block card.
 * 3. `form.blocks.ts`'s `buildSingleBlockContent` — the plain single-block
 *    form (Snippet/Command/etc. with exactly one block) — the common case,
 *    and the one round 1 of review found missing.
 */

function mockCodeBlock(code: string, lang: string): string {
    return `<pre data-lang="${lang}">${code}</pre>`;
}

const BLOCK: ArtifactFormBlock = {
    heading:     'One',
    description: '',
    language:    'javascript',
    code:        'const a = 1;',
    vars:        [],
};

suite('form-expand-button — server-rendered card (form.blocks.ts)', () => {

    test('buildBlockCard renders the expand-editor-btn for its block index', () => {
        const html = buildBlockCard(BLOCK, 0, 1, 'free', '', mockCodeBlock);
        assert.match(html, /class="expand-editor-btn" data-block="0"/);
    });

    test('expand-editor-btn is a distinct class from the collapse chevron expand-btn', () => {
        const html = buildBlockCard(BLOCK, 0, 1, 'free', '', mockCodeBlock);
        // Neither button may carry both tokens — the delegated click handler
        // matches 'expand-btn' by exact class-list membership, so a button
        // classed with both would fire both behaviours on one click.
        assert.ok(!/class="[^"]*\bexpand-btn\b[^"]*\bexpand-editor-btn\b[^"]*"/.test(html));
        assert.ok(!/class="[^"]*\bexpand-editor-btn\b[^"]*\bexpand-btn\b[^"]*"/.test(html));
        assert.match(html, /class="expand-btn" data-block="0"/);
    });
});

suite('form-expand-button — single-block form (form.blocks.ts)', () => {

    test('buildSingleBlockContent renders the expand-editor-btn inside .block-code', () => {
        const html = buildSingleBlockContent(BLOCK, 0, 'free', '', mockCodeBlock);
        assert.match(html, /class="expand-editor-btn" data-block="0"/);
    });

    test('renders for a hidden-language-mode type too (e.g. AIAgentsConfig — no lang selector)', () => {
        const html = buildSingleBlockContent(BLOCK, 0, 'hidden', 'markdown', mockCodeBlock);
        assert.match(html, /class="expand-editor-btn" data-block="0"/);
    });
});

suite('form-expand-button — client-added card (form.clientJs.ts)', () => {

    test('buildNewCardHtml (inlined in FORM_CLIENT_JS) also renders expand-editor-btn', () => {
        const fn = FORM_CLIENT_JS.slice(
            FORM_CLIENT_JS.indexOf('function buildNewCardHtml'),
            FORM_CLIENT_JS.indexOf('function buildNewLangSelectHtml'),
        );
        assert.match(fn, /class="expand-editor-btn"/);
    });

    test('clicking expand-editor-btn posts expandBlock with the live block from extractModel', () => {
        assert.match(
            FORM_CLIENT_JS,
            /target\.classList\.contains\('expand-editor-btn'\)[\s\S]{0,300}extractModel\(\)\.blocks\[blockIndex\][\s\S]{0,200}command: 'expandBlock', index: blockIndex, code: b\.code, language: b\.language, heading: b\.heading/,
        );
    });

    test('a blockUpdated message replaces that block\'s code area (no new esc copy)', () => {
        assert.match(FORM_CLIENT_JS, /case 'blockUpdated':[\s\S]{0,40}onBlockUpdated\(msg\)/);
        // The replacement path reuses renderRows (shared with __codeBlock.setCode),
        // not a second render/escape implementation.
        assert.match(FORM_CLIENT_JS, /function setCodeForBlock\(blockIndex, code\) \{[\s\S]{0,400}renderRows\(code \|\| ''\)/);
    });
});

suite('form-expand-button — one expand button per form block (formCodeBlockHtml)', () => {

    const FORM_ARGS = { cspSource: 'x', cssUri: [] as string[], nonce: 'n' };
    const countOf = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

    test('single-block Snippet: exactly one expand-editor-btn and no toolbar expandCodeBtn', () => {
        const html = buildFormHtml({ ...FORM_ARGS, model: defaultModel('Snippet'), codeBlockHtml: formCodeBlockHtml });
        assert.strictEqual(countOf(html, /class="expand-editor-btn"/g), 1);
        assert.ok(!html.includes('id="expandCodeBtn"'));
    });

    test('single-block AIAgentsConfig (hidden language): exactly one expand-editor-btn', () => {
        const html = buildFormHtml({ ...FORM_ARGS, model: defaultModel('AIAgentsConfig'), codeBlockHtml: formCodeBlockHtml });
        assert.strictEqual(countOf(html, /class="expand-editor-btn"/g), 1);
        assert.ok(!html.includes('id="expandCodeBtn"'));
    });

    test('3-card model: one expand button per card, each carrying its own data-block, no toolbar button', () => {
        const model = defaultModel('Snippet');
        model.blocks = [0, 1, 2].map(i => ({ heading: `H${i}`, description: '', language: 'javascript', code: `c${i}`, vars: [] }));
        const html = buildFormHtml({ ...FORM_ARGS, model, codeBlockHtml: formCodeBlockHtml });
        assert.strictEqual(countOf(html, /class="expand-editor-btn"/g), 3);
        for (const i of [0, 1, 2]) {
            assert.match(html, new RegExp(`class="expand-editor-btn" data-block="${i}"`));
        }
        assert.ok(!html.includes('id="expandCodeBtn"'));
    });

    test('buildCodeBlockHtml (preview path) still carries the toolbar expandCodeBtn', () => {
        const html = buildCodeBlockHtml(renderCodeRowsHtml('a', 'javascript'), 'javascript');
        assert.match(html, /id="expandCodeBtn"/);
    });
});
