import * as assert from 'node:assert';
import { makeWebviewDom, type WebviewDom } from './webview-dom-harness.js';
import { PREVIEW_CLIENT_JS } from '../src/ui/panels/artifactPicker/preview.clientJs.js';

/**
 * Overwrite is visible **iff** the code area's text differs from what was
 * rendered.
 *
 * The defect this guards: `markStaged` was a *notification* — anything that
 * fired `input` on `#codeWrapper` revealed Overwrite, whether or not the text
 * had actually changed, and nothing ever re-hid it. Typing a character and
 * deleting it left Overwrite showing over an identical file, so clicking it
 * rewrote the bytes already on disk and the confirm modal asked about a change
 * that did not exist.
 *
 * `preview-buttons.test.ts` cannot see this: it matches the rendered HTML
 * *string*, so it pins only the initial `hidden` attribute and never runs the
 * script.
 *
 * Seeds its own markup rather than reusing `makePreviewDom()`: that shared
 * preset deliberately leaves `#codeWrapper` empty, and filling it globally
 * makes `webview-script-executes.test.ts` run `CODE_BLOCK_CLIENT_JS`'s
 * caret code against a stub `getSelection()` that has no `getRangeAt`.
 * The two ids this suite needs (`#overwriteBtn`, `#dirtyNotice`) are reached
 * through guarded `if (…)` checks in the client script, which is why the
 * shared preset never carried them.
 */

const SEED_CODE = 'const answer = 42;';

/**
 * `hidden=""`, not a bare `hidden`: the harness's `parseAttrs` only matches
 * `name="value"` pairs, so a valueless attribute is never recorded and
 * `ElementStub`'s `'hidden' in attrs` reflection reads `false`. The quoted
 * empty form is equivalent HTML and is what the harness can actually parse.
 */
const SEED_HTML = `
  <div class="dirty-notice" id="dirtyNotice" hidden="">Temporary changes</div>
  <div id="codeWrapper"><div class="code-line-row"><span class="line-number" contenteditable="false">1</span><span class="code-content">${SEED_CODE}</span></div></div>
  <div id="varsSection"><div class="inputs" id="varInputs"></div></div>
  <button id="insertBtn">Insert</button>
  <button id="copyBtn">Copy</button>
  <button id="overwriteBtn" hidden="">Overwrite</button>
  <button id="editBtn">Edit</button>
  <button id="cancelBtn">Cancel</button>
`;

function makeDom(): WebviewDom {
    return makeWebviewDom({ seedHtml: SEED_HTML, script: PREVIEW_CLIENT_JS });
}

/** Rewrites the code area's single row, then fires the `input` a browser would. */
function typeCode(dom: WebviewDom, code: string): void {
    const content = dom.el('.code-content');
    if (!content) { throw new Error('.code-content not seeded'); }
    content.textContent = code;
    const wrapper = dom.el('#codeWrapper');
    if (!wrapper) { throw new Error('#codeWrapper not seeded'); }
    dom.fire(wrapper, 'input');
}

const overwriteHidden = (dom: WebviewDom): boolean | undefined => dom.el('#overwriteBtn')?.hidden;
const noticeHidden = (dom: WebviewDom): boolean | undefined => dom.el('#dirtyNotice')?.hidden;

suite('preview — Overwrite visibility tracks real change', () => {

    test('the seed is wired: both ids exist, so the assertions below are not vacuous', () => {
        const dom = makeDom();
        assert.ok(dom.el('#overwriteBtn'), '#overwriteBtn missing — every hidden assertion would read undefined');
        assert.ok(dom.el('#dirtyNotice'), '#dirtyNotice missing — every hidden assertion would read undefined');
        assert.strictEqual(overwriteHidden(dom), true, 'Overwrite must start hidden');
    });

    test('a spurious input with unchanged text leaves Overwrite hidden', () => {
        const dom = makeDom();

        // The event a programmatic re-render, a focus, or an IME can fire without
        // the user having changed a character.
        typeCode(dom, SEED_CODE);

        assert.strictEqual(
            overwriteHidden(dom), true,
            'an input event with identical text revealed Overwrite — it is a notification, not a comparison',
        );
        assert.strictEqual(noticeHidden(dom), true, 'the temporary-changes notice showed with no real change');
    });

    test('a real edit reveals Overwrite and the notice', () => {
        const dom = makeDom();
        typeCode(dom, 'const answer = 43;');

        assert.strictEqual(overwriteHidden(dom), false, 'a real edit did not reveal Overwrite');
        assert.strictEqual(noticeHidden(dom), false, 'a real edit did not reveal the notice');
    });

    test('editing back to the original text hides Overwrite again', () => {
        const dom = makeDom();
        typeCode(dom, 'const answer = 43;');
        assert.strictEqual(overwriteHidden(dom), false, 'precondition: the edit must first reveal Overwrite');

        typeCode(dom, SEED_CODE);

        assert.strictEqual(
            overwriteHidden(dom), true,
            'reverting the edit left Overwrite visible — it would rewrite the bytes already on disk',
        );
    });
});
