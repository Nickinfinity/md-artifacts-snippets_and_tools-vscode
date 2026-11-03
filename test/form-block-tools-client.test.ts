import * as assert from 'node:assert';
import { buildBlockCard, buildLanguageSelector, buildSingleBlockContent, formCodeBlockHtml } from '../src/ui/panels/artifactForm/form.blocks.js';
import { FORM_CLIENT_JS } from '../src/ui/panels/artifactForm/form.clientJs.js';
import { FREE_LANGUAGE_OPTIONS } from '../src/ui/panels/artifactForm/form.helpers.js';
import type { ArtifactFormBlock } from '../src/types/artifact-form.types.js';
import { makeWebviewDom, type WebviewDom } from './webview-dom-harness.js';

/**
 * W8b T8b.3 — the form's per-block tools in the webview: expand carries the live
 * block, `blockUpdated` brings the language back, Clear empties one block.
 */

const blk = (over: Partial<ArtifactFormBlock> = {}): ArtifactFormBlock =>
    ({ heading: '', description: '', language: 'css', code: 'plain', vars: [], ...over });

function singleDom(block: ArtifactFormBlock, mode: 'free' | 'locked' | 'hidden' = 'free'): WebviewDom {
    const seed = `<div id="blocks-area" data-lang-mode="${mode}">${buildSingleBlockContent(block, 0, mode, 'bash', formCodeBlockHtml)}</div>`;
    return makeWebviewDom({ seedHtml: seed, script: FORM_CLIENT_JS });
}

function cardsDom(blocks: ArtifactFormBlock[], mode: 'free' | 'locked' | 'hidden' = 'free'): WebviewDom {
    const cards = blocks.map((b, i) => buildBlockCard(b, i, blocks.length, mode, 'bash', formCodeBlockHtml)).join('');
    return makeWebviewDom({ seedHtml: `<div id="blocks-area" class="multi-block" data-lang-mode="${mode}">${cards}</div>`, script: FORM_CLIENT_JS });
}

const sent = (d: WebviewDom, command: string): Array<Record<string, unknown>> => d.posted.filter(m => m['command'] === command);
const rows = (d: WebviewDom, i: number): number => d.all(`.var-row[data-block="${i}"]`).length;

/** Answers every detectVars the script posted the way the host would: this block's code has no variables. */
function echoDetection(d: WebviewDom): void {
    for (const m of sent(d, 'detectVars')) { d.dispatch({ command: 'varsDetected', blockIndex: m['blockIndex'], vars: [] }); }
}

suite('form block tools — expand carries the live block', () => {
    test('single block: expandBlock posts index, code, language, heading from extractModel', () => {
        const d = singleDom(blk());
        d.el('#block-0-lang')!.value = 'css';
        d.fire(d.el('.expand-editor-btn'), 'click');
        assert.deepStrictEqual(sent(d, 'expandBlock'), [{ command: 'expandBlock', index: 0, code: 'plain', language: 'css', heading: '' }]);
    });

    test('card 2 expands block 2 with its own heading, language and code', () => {
        const d = cardsDom([blk(), blk(), blk({ code: 'third', heading: 'Third' })]);
        d.el('#block-2-lang')!.value = 'scss';
        d.fire(d.all('.expand-editor-btn')[2], 'click');
        assert.deepStrictEqual(sent(d, 'expandBlock'), [{ command: 'expandBlock', index: 2, code: 'third', language: 'scss', heading: 'Third' }]);
    });
});

suite('form block tools — blockUpdated brings the language back', () => {
    test('a language outside the select is added once and selected; detectVars posted', () => {
        const d = cardsDom([blk(), blk()]);
        d.dispatch({ command: 'blockUpdated', index: 1, code: 'plain2', language: 'scss' });
        const sel = d.el('#block-1-lang')!;
        assert.strictEqual(sel.value, 'scss');
        assert.strictEqual(sel.children.filter(o => o.value === 'scss').length, 1);
        assert.deepStrictEqual(sent(d, 'detectVars'), [{ command: 'detectVars', blockIndex: 1, code: 'plain2' }]);
    });

    test('a language already in the select adds no second option', () => {
        const d = singleDom(blk());
        d.dispatch({ command: 'blockUpdated', index: 0, code: 'x', language: 'javascript' });
        const sel = d.el('#block-0-lang')!;
        assert.strictEqual(sel.value, 'javascript');
        assert.strictEqual(sel.children.filter(o => o.value === 'javascript').length, 1);
    });

    test('no language in the message leaves the select alone', () => {
        const d = singleDom(blk());
        d.el('#block-0-lang')!.value = 'css';
        d.dispatch({ command: 'blockUpdated', index: 0, code: 'x' });
        assert.strictEqual(d.el('#block-0-lang')!.value, 'css');
    });

    test('locked select untouched, hidden mode does not throw', () => {
        const locked = singleDom(blk(), 'locked');
        locked.el('#block-0-lang')!.value = 'bash';
        locked.dispatch({ command: 'blockUpdated', index: 0, code: 'x', language: 'scss' });
        assert.strictEqual(locked.el('#block-0-lang')!.value, 'bash');
        assert.strictEqual(locked.el('#block-0-lang')!.children.length, 1);
        const hidden = singleDom(blk(), 'hidden');
        assert.doesNotThrow(() => hidden.dispatch({ command: 'blockUpdated', index: 0, code: 'x', language: 'scss' }));
    });
});

suite('form block tools — Clear', () => {
    const withVar = (): ArtifactFormBlock => blk({ code: '<VK-a>', vars: [{ name: 'VK-a', defaultValue: 'x' }] });

    test('click posts clearBlock { index }; confirmed empties code and the var rows without re-running detection', () => {
        const d = singleDom(withVar());
        assert.strictEqual(rows(d, 0), 1);
        d.fire(d.el('.clear-block-btn'), 'click');
        assert.deepStrictEqual(sent(d, 'clearBlock'), [{ command: 'clearBlock', index: 0 }]);
        d.dispatch({ command: 'clearBlockConfirmed', index: 0, confirmed: true });
        echoDetection(d);   // a host reply to any detectVars: no variables
        assert.strictEqual(rows(d, 0), 0, 'the <VK-a> default row must not survive');
        assert.strictEqual(sent(d, 'detectVars').length, 0);
        d.fire(d.el('.expand-editor-btn'), 'click');
        assert.strictEqual(sent(d, 'expandBlock')[0]!['code'], '');
    });

    test('declined leaves code and rows', () => {
        const d = singleDom(withVar());
        d.dispatch({ command: 'clearBlockConfirmed', index: 0, confirmed: false });
        assert.strictEqual(rows(d, 0), 1);
        d.fire(d.el('.expand-editor-btn'), 'click');
        // the harness does not decode entities, so assert only that the code is still there
        assert.notStrictEqual(sent(d, 'expandBlock')[0]!['code'], '');
    });

    test('an empty block posts nothing', () => {
        const d = singleDom(blk({ code: '' }));
        d.fire(d.el('.clear-block-btn'), 'click');
        assert.strictEqual(sent(d, 'clearBlock').length, 0);
    });

    test('card 1 clears alone; card 0 keeps code and rows', () => {
        const d = cardsDom([withVar(), { ...withVar() }]);
        d.fire(d.all('.clear-block-btn')[1], 'click');
        assert.deepStrictEqual(sent(d, 'clearBlock'), [{ command: 'clearBlock', index: 1 }]);
        d.dispatch({ command: 'clearBlockConfirmed', index: 1, confirmed: true });
        assert.strictEqual(rows(d, 1), 0);
        assert.strictEqual(rows(d, 0), 1);
        d.fire(d.all('.expand-editor-btn')[0], 'click');
        d.fire(d.all('.expand-editor-btn')[1], 'click');
        const codes = sent(d, 'expandBlock').map(m => m['code']);
        assert.ok(codes[0] !== '' && codes[1] === '');
    });
});

suite('form block tools — markup', () => {
    test('Clear button in single block, server card and buildNewCardHtml', () => {
        assert.match(buildSingleBlockContent(blk(), 0, 'free', '', formCodeBlockHtml), /class="clear-block-btn" data-block="0"/);
        assert.match(buildBlockCard(blk(), 1, 2, 'free', '', formCodeBlockHtml), /class="clear-block-btn" data-block="1"/);
        const fn = FORM_CLIENT_JS.slice(FORM_CLIENT_JS.indexOf('function buildNewCardHtml'), FORM_CLIENT_JS.indexOf('function buildNewLangSelectHtml'));
        assert.match(fn, /class="clear-block-btn"/);
    });

    test('unknown language renders one extra selected option; known adds none', () => {
        const scss = buildLanguageSelector(0, 'scss', 'free', '');
        assert.strictEqual((scss.match(/<option /g) ?? []).length, FREE_LANGUAGE_OPTIONS.length + 1);
        assert.ok(scss.includes('<option value="scss" selected>scss</option>'));
        assert.strictEqual((scss.match(/ selected/g) ?? []).length, 1);
        const css = buildLanguageSelector(0, 'css', 'free', '');
        assert.strictEqual((css.match(/<option /g) ?? []).length, FREE_LANGUAGE_OPTIONS.length);
    });

    test('hostile language stays text', () => {
        const html = buildLanguageSelector(0, '"><img onerror=x>', 'free', '');
        assert.ok(!html.includes('<img'));
        assert.ok(html.includes('&lt;img onerror=x&gt;'));
        assert.strictEqual((html.match(/ selected/g) ?? []).length, 1);
    });
});
