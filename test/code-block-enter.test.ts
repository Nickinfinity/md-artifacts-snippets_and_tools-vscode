import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PREVIEW_CLIENT_JS } from '../src/ui/panels/artifactPicker/preview.clientJs.js';
import { buildCodeBlockHtml } from '../src/ui/panels/artifactPicker/codeBlock.js';
import { FORM_CLIENT_JS } from '../src/ui/panels/artifactForm/form.clientJs.js';
import { renderCodeRowsHtml } from '../src/services/render.service.js';
import { makeWebviewDom } from './webview-dom-harness.js';

/**
 * Enter and multi-line paste in the editable code area. Both go through the one
 * `insertAtCaret(wrapper, text)` helper in `CODE_BLOCK_CLIENT_JS` — `execCommand('insertText')`
 * is a paragraph split in Chromium (second `.code-content` per row, lost on re-render).
 */

const SEED = '<div id="codeWrapper"><div class="code-line-row"><span class="line-number" contenteditable="false">1</span>'
    + '<span class="code-content">echo one</span></div></div><div id="dirtyNotice" hidden></div><button id="overwriteBtn" hidden></button>';

function previewDom(clipboardText?: string) {
    return makeWebviewDom({ seedHtml: SEED, script: PREVIEW_CLIENT_JS, clipboardText });
}
const codeOf = (d: ReturnType<typeof previewDom>): string =>
    d.el('#codeWrapper')!.querySelectorAll('.code-content').map(c => c.textContent).join('\n');

/** Strips block and line comments so a guard never trips on the file documenting the rule. */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

suite('code block — Enter and paste', () => {
    test('Enter inserts a newline at the caret (offset 0 in the harness) and stages', () => {
        const d = previewDom();
        d.fire(d.el('#codeWrapper'), 'keydown', { key: 'Enter' });
        assert.strictEqual(codeOf(d), '\necho one');
        assert.strictEqual(d.el('#overwriteBtn')!.hidden, false);
    });

    test('multi-line paste normalises CRLF and keeps every line', () => {
        const d = previewDom('X\r\nY');
        d.fire(d.el('#codeWrapper'), 'paste', {});
        assert.strictEqual(codeOf(d), 'X\nYecho one');
        assert.strictEqual(d.el('#codeWrapper')!.querySelectorAll('.code-line-row').length, 2);
    });

    test('Cmd+Enter and IME Enter are not intercepted', () => {
        for (const init of [{ key: 'Enter', metaKey: true }, { key: 'Enter', isComposing: true }, { key: 'Enter', ctrlKey: true }]) {
            const d = previewDom();
            d.fire(d.el('#codeWrapper'), 'keydown', init);
            assert.strictEqual(d.el('#codeWrapper')!.querySelectorAll('.code-line-row').length, 1, JSON.stringify(init));
        }
    });

    test('no execCommand insertText left in codeBlock.ts or form.clientJs.ts', () => {
        const root = path.join(__dirname, '../../src/ui/panels');
        for (const f of ['artifactPicker/codeBlock.ts', 'artifactForm/form.clientJs.ts']) {
            const src = strip(fs.readFileSync(path.join(root, f), 'utf8'));
            assert.ok(!src.includes("execCommand('insertText'"), f);
        }
    });

    test('form: every card (both id="codeWrapper") gains exactly one line on Enter', () => {
        const card = (i: number, code: string): string => `<div class="block-card" data-block-index="${i}">${buildCodeBlockHtml(renderCodeRowsHtml(code, 'text'), 'text')}</div>`;
        const d = makeWebviewDom({ seedHtml: `<div id="blocks-area" class="multi-block">${card(0, 'a')}${card(1, 'b')}</div>`, script: FORM_CLIENT_JS });
        const texts = (): string[] => d.all('.block-card').map(c => c.querySelectorAll('.code-content').map(x => x.textContent).join('\n'));
        for (const w of d.all('.code-block-wrapper')) { d.fire(w, 'keydown', { key: 'Enter' }); }
        assert.deepStrictEqual(texts(), ['\na', '\nb']);
    });
});
