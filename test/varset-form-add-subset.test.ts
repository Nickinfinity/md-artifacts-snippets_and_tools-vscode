import * as assert from 'node:assert';
import { renderVarSetFormHtml, buildVarSetFormClientJs } from '../src/ui/panels/varsetForm/varsetForm.render.js';
import { handleVarSetFormMessage, type VarSetFormCallbacks } from '../src/ui/panels/varsetForm/varsetForm.panel.js';
import { validateSubSetHeadings } from '../src/services/varset-form.service.js';
import { makeWebviewDom } from './webview-dom-harness.js';
import type { VarsEditPayload } from '../src/types/varset.types.js';

/**
 * The var-set edit form can add a sub-set (a `## heading` + `vks` fence).
 * Covers the markup, the client round trip (headings ride the wire), the
 * panel's heading merge (an existing heading is never renamed) and the
 * heading validator.
 */

const base: VarsEditPayload = {
    title: 'Bundles', description: '', tags: [], env: 'staging',
    subSets: [{ heading: 'Dev', pairs: [['VK-host', 'localhost']] }],
};
const headingless: VarsEditPayload = { ...base, subSets: [{ heading: '', pairs: [['VK-host', 'localhost']] }] };

function bag(onWrite: (p: VarsEditPayload) => void, posted: Record<string, unknown>[] = []): VarSetFormCallbacks {
    return {
        validate: () => ({ ok: true }),
        write: async () => { /* create only */ },
        post: (m) => { posted.push(m); },
        close: () => { /* noop */ },
        writeEdit: async (p) => { onWrite(p); },
    };
}

async function save(payload: unknown, b: VarsEditPayload, cb: VarSetFormCallbacks): Promise<void> {
    await handleVarSetFormMessage({ command: 'save', payload }, cb, 'edit', b);
}

suite('varset form — add sub-set: markup', () => {
    test('edit mode renders an Add sub-set button and the sub-set container', () => {
        const html = renderVarSetFormHtml(base, [], 'csp', 'n', 'edit');
        assert.ok(html.includes('id="vsfSubSets"'));
        assert.ok(html.includes('class="add-subset"'));
    });

    test('create mode renders no Add sub-set button', () => {
        const html = renderVarSetFormHtml({ title: '', description: '', tags: [], pairs: [] }, [], 'csp', 'n', 'create');
        assert.ok(!html.includes('class="add-subset"'));
    });

    test('an existing heading stays a read-only <h3>; a heading-less sub-set gets an input', () => {
        const markup = (p: VarsEditPayload) => {
            const html = renderVarSetFormHtml(p, [], 'csp', 'n', 'edit');
            return html.slice(0, html.indexOf('<script nonce='));
        };
        assert.ok(!markup(base).includes('data-role="heading"'));
        assert.ok(markup(headingless).includes('data-role="heading" data-subset="0"'));
    });
});

suite('varset form — add sub-set: client round trip', () => {
    test('clicking Add sub-set then Save posts a second group and its typed heading', () => {
        const seedHtml = `
          <input id="vsfTitle" value="Bundles"><textarea id="vsfDescription"></textarea>
          <div id="vsfError" hidden></div><button id="vsfCancel"></button><button id="vsfSave"></button>
          <div id="vsfSubSets">
            <h3 class="subset-heading">Dev</h3>
            <table class="vars-table"><tbody><tr class="var-row">
              <td><input data-role="name" value="VK-host"></td><td><input data-role="value" value="localhost"></td>
            </tr></tbody></table>
          </div>
          <button class="add-subset"></button>`;
        const dom = makeWebviewDom({ seedHtml, script: buildVarSetFormClientJs('edit', '[]') });

        dom.fire(dom.el('.add-subset'), 'click');
        assert.strictEqual(dom.all('.vars-table').length, 2, 'Add sub-set did not append a table');
        const heading = dom.el('[data-role="heading"]');
        assert.ok(heading, 'new sub-set has no heading input');
        heading.value = 'Prod';

        dom.fire(dom.el('#vsfSave'), 'click');
        const msg = dom.posted[0] as { payload: { pairs: unknown[]; headings: string[] } };
        assert.strictEqual(msg.payload.pairs.length, 2);
        assert.deepStrictEqual(msg.payload.pairs[1], []);
        assert.deepStrictEqual(msg.payload.headings, ['', 'Prod']);
    });
});

suite('varset form — add sub-set: panel merge', () => {
    test('a new sub-set reaches writeEdit with its typed heading; the existing one keeps its own', async () => {
        let got: VarsEditPayload | undefined;
        await save({ title: 'Bundles', description: '', tags: [],
            pairs: [[['VK-host', 'localhost']], [['VK-host', 'prod']]], headings: ['Renamed', ' Prod '] }, base, bag(p => { got = p; }));
        assert.deepStrictEqual(got?.subSets.map(s => s.heading), ['Dev', 'Prod']);
        assert.strictEqual(got?.env, 'staging');
    });

    test('a heading-less file gaining a sub-set takes both typed headings', async () => {
        let got: VarsEditPayload | undefined;
        await save({ title: 'B', description: '', tags: [],
            pairs: [[['VK-a', '1']], [['VK-a', '2']]], headings: ['Dev', 'Prod'] }, headingless, bag(p => { got = p; }));
        assert.deepStrictEqual(got?.subSets.map(s => s.heading), ['Dev', 'Prod']);
    });

    test('an unnamed new sub-set is rejected with saveFailed and never written', async () => {
        let called = false;
        const posted: Record<string, unknown>[] = [];
        await save({ title: 'B', description: '', tags: [],
            pairs: [[['VK-a', '1']], []], headings: ['', ''] }, base, bag(() => { called = true; }, posted));
        assert.strictEqual(called, false);
        assert.strictEqual(posted[0]?.command, 'saveFailed');
    });

    test('headings whose length differs from pairs is a malformed payload', async () => {
        let called = false;
        await save({ title: 'B', description: '', tags: [], pairs: [[['VK-a', '1']]], headings: ['a', 'b'] },
            base, bag(() => { called = true; }));
        assert.strictEqual(called, false);
    });
});

suite('varset form — validateSubSetHeadings', () => {
    test('one sub-set may stay unnamed', () => assert.deepStrictEqual(validateSubSetHeadings(['']), { ok: true }));
    test('distinct names pass', () => assert.deepStrictEqual(validateSubSetHeadings(['Dev', 'Prod']), { ok: true }));
    test('empty name with 2+ sub-sets fails', () => assert.strictEqual(validateSubSetHeadings(['Dev', '']).ok, false));
    test('duplicate names fail', () => assert.strictEqual(validateSubSetHeadings(['Dev', 'Dev']).ok, false));
    test('newline or backtick fails', () => {
        assert.strictEqual(validateSubSetHeadings(['Dev', 'a\nb']).ok, false);
        assert.strictEqual(validateSubSetHeadings(['a`b']).ok, false);
    });
});
