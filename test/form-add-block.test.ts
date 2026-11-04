import * as assert from 'node:assert';
import { buildSingleBlockContent, formCodeBlockHtml } from '../src/ui/panels/artifactForm/form.blocks.js';
import { FORM_CLIENT_JS } from '../src/ui/panels/artifactForm/form.clientJs.js';
import { makeWebviewDom, type WebviewDom } from './webview-dom-harness.js';

/**
 * "Add block" on a single inline block must turn that block into card 0 (code,
 * language, variables kept) before appending card 1 — otherwise the original
 * block drops out of `extractModel()` and the new card collides on index 0.
 */

function singleSnippetDom(): WebviewDom {
    const block = { heading: '', description: '', language: 'bash', code: '', vars: [{ name: 'VK-host', defaultValue: 'h1' }] };
    const inner = buildSingleBlockContent(block, 0, 'free', '', formCodeBlockHtml);
    const seed = `<div id="blocks-area" data-lang-mode="free" data-type="Snippet">${inner}</div><button id="add-block-btn">+</button>`;
    return makeWebviewDom({ seedHtml: seed, script: FORM_CLIENT_JS });
}

/** Every card's data-block-index, in document order. */
const cardIdx = (d: WebviewDom): Array<string | undefined> => d.all('.block-card').map(c => c.dataset.blockIndex);

suite('form add block — inline block becomes card 0', () => {
    test('first add converts the inline block, keeps code, language and variables', () => {
        const d = singleSnippetDom();
        d.el('#codeWrapper')!.textContent = 'body { }';
        d.el('#block-0-lang')!.value = 'css';
        d.fire(d.el('#add-block-btn'), 'click');

        assert.deepStrictEqual(cardIdx(d), ['0', '1']);
        assert.strictEqual(d.all('.block').length, 0, 'inline block is gone');
        const first = d.all('.block-card')[0];
        assert.strictEqual(first.querySelector('.lang-select')!.value, 'css');
        assert.strictEqual(first.querySelector('#codeWrapper'), d.el('#codeWrapper'), 'same live code node');
        assert.strictEqual(first.querySelectorAll('.var-row').length, 1, 'variable rows moved into card 0');
    });

    test('every card has exactly one Expand and one Clear, each with a tooltip', () => {
        const d = singleSnippetDom();
        d.fire(d.el('#add-block-btn'), 'click');
        assert.strictEqual(d.all('.expand-editor-btn').length, 2, 'no stray Expand outside the cards');
        assert.strictEqual(d.all('.clear-block-btn').length, 2, 'no stray Clear outside the cards');
        for (const card of d.all('.block-card')) {
            const expand = card.querySelectorAll('.expand-editor-btn');
            const clear = card.querySelectorAll('.clear-block-btn');
            assert.strictEqual(expand.length, 1);
            assert.strictEqual(clear.length, 1);
            assert.ok(expand[0].getAttribute('title'));
            assert.ok(clear[0].getAttribute('title'));
        }
    });

    test('a second add gives three cards indexed 0, 1, 2', () => {
        const d = singleSnippetDom();
        d.fire(d.el('#add-block-btn'), 'click');
        d.fire(d.el('#add-block-btn'), 'click');
        assert.deepStrictEqual(cardIdx(d), ['0', '1', '2']);
    });

    test('the saved model keeps block 0 beside the new block', () => {
        const d = singleSnippetDom();
        d.el('#codeWrapper')!.textContent = 'a';
        d.el('#block-0-lang')!.value = 'css';
        d.fire(d.el('#add-block-btn'), 'click');
        d.fire(d.el('.expand-editor-btn'), 'click');
        const m = d.posted.find(p => p['command'] === 'expandBlock')!;
        assert.strictEqual(m['index'], 0);
        assert.strictEqual(m['language'], 'css');
        assert.strictEqual(m['code'], 'a');
    });
});
