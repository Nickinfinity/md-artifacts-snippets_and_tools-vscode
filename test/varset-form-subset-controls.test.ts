import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderVarSetFormHtml, buildVarSetFormClientJs } from '../src/ui/panels/varsetForm/varsetForm.render.js';
import { handleVarSetFormMessage, type VarSetFormCallbacks } from '../src/ui/panels/varsetForm/varsetForm.panel.js';
import { makeWebviewDom } from './webview-dom-harness.js';
import { serializeArtifact } from '../src/services/artifact-serializer.service.js';
import { parseFromContent } from '../src/services/parser.service.js';
import { editPayloadToModel, variablesFileToEditPayload } from '../src/services/varset.service.js';
import type { VarsEditPayload } from '../src/types/varset.types.js';

/**
 * Rename and delete for sub-sets in the var-set edit form. Both are staged in
 * the DOM and reach the file only through Save, so the contract is: what the
 * webview posts after a rename/delete, and that the panel writes exactly that
 * — in particular that a delete never shifts another sub-set's name onto the
 * wrong rows.
 */

const twoSets: VarsEditPayload = {
    title: 'Bundles', description: '', tags: [], env: 'staging',
    subSets: [
        { heading: 'Dev',  pairs: [['VK-host', 'localhost']] },
        { heading: 'Prod', pairs: [['VK-host', 'prod.example']] },
    ],
};

/** One server-shaped sub-set group, matching `renderSubSetGroup`'s structure. */
function group(name: string, value: string): string {
    return `<div class="subset-group">
      <div class="subset-header"><h3 class="subset-heading">${name}</h3>
        <button class="subset-rename"></button>
        <input data-role="heading" value="${name}" hidden>
        <button class="subset-delete"></button></div>
      <table class="vars-table"><tbody><tr class="var-row">
        <td><input data-role="name" value="VK-host"></td><td><input data-role="value" value="${value}"></td>
      </tr></tbody></table>
      <button class="add-var-row"></button>
    </div>`;
}

function dom(groups: string) {
    const seedHtml = `
      <input id="vsfTitle" value="Bundles"><textarea id="vsfDescription"></textarea>
      <div id="vsfError" hidden></div><button id="vsfCancel"></button><button id="vsfSave"></button>
      <div id="vsfSubSets">${groups}</div>
      <button class="add-subset"></button>`;
    return makeWebviewDom({ seedHtml, script: buildVarSetFormClientJs('edit', '[]') });
}

type Posted = { payload: { pairs: [string, string][][]; headings: string[] } };

suite('varset form — sub-set controls: markup', () => {
    const markup = (p: VarsEditPayload) => {
        const html = renderVarSetFormHtml(p, [], 'csp', 'n', 'edit');
        return html.slice(0, html.indexOf('<script nonce='));
    };

    test('every named sub-set gets a rename and a delete button', () => {
        const html = markup(twoSets);
        assert.strictEqual(html.split('class="subset-rename"').length - 1, 2);
        assert.strictEqual(html.split('class="subset-delete"').length - 1, 2);
    });

    test('base.css hides a `hidden` button — its bare button rule would otherwise beat the UA', () => {
        // Without this the lone sub-set's delete stayed clickable (test2.md).
        const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'base.css'), 'utf8');
        assert.ok(/button\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(css), 'button[hidden] rule missing');
    });

    test('rename and delete use the Variables pane codicons (edit / trash)', () => {
        const html = markup(twoSets);
        assert.ok(html.includes('codicon codicon-edit') && html.includes('codicon codicon-trash'));
        assert.ok(/font-src /.test(html), 'edit-mode CSP blocks the codicon font');
    });

    test('a lone sub-set still offers delete', () => {
        const html = markup({ ...twoSets, subSets: [twoSets.subSets[0]] });
        assert.ok(html.includes('class="subset-delete"'), 'lone sub-set has no delete');
        assert.ok(!/class="subset-delete"[^>]*hidden>/.test(html), 'lone sub-set delete is hidden');
    });

    test('a hostile heading is escaped in both the <h3> and the name input', () => {
        const html = markup({ ...twoSets, subSets: [{ heading: '"><script>x</script>', pairs: [] }] });
        assert.ok(!html.includes('<script>x'), 'heading reached the document unescaped');
        assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;'), 'input value not escaped');
    });
});

suite('varset form — sub-set controls: client', () => {
    test('rename swaps the <h3> for the name input; blur commits the new name', () => {
        const d = dom(group('Dev', 'localhost') + group('Prod', 'prod.example'));
        const first = d.all('.subset-group')[0];
        const title = first.querySelector('.subset-heading')!;
        const input = first.querySelector('[data-role="heading"]')!;

        d.fire(first.querySelector('.subset-rename'), 'click');
        assert.strictEqual(title.hidden, true, 'h3 still shown while editing');
        assert.strictEqual(input.hidden, false, 'name input not revealed');

        input.value = ' Local ';
        d.fire(input, 'blur');
        assert.strictEqual(input.hidden, true);
        assert.strictEqual(title.textContent, 'Local');

        d.fire(d.el('#vsfSave'), 'click');
        assert.deepStrictEqual((d.posted[0] as Posted).payload.headings, [' Local ', 'Prod']);
    });

    test('emptying the name of the ONLY sub-set makes the set one block again', () => {
        const d = dom(group('Dev', 'localhost'));
        const g = d.el('.subset-group')!;
        const input = g.querySelector('[data-role="heading"]')!;
        d.fire(g.querySelector('.subset-rename'), 'click');
        input.value = '';
        d.fire(input, 'blur');
        assert.strictEqual(g.querySelector('.subset-heading'), null, 'title still shown');
        assert.strictEqual(input.hidden, true, 'an untitled lone block shows no name field');
        d.fire(d.el('#vsfSave'), 'click');
        assert.deepStrictEqual((d.posted[0] as Posted).payload.headings, ['']);
    });

    test('Add sub-set on a one-block set pre-fills the untitled block\'s name with "Default"', () => {
        const untitled = `<div class="subset-group"><div class="subset-header">
            <input data-role="heading" value="" hidden><button class="subset-delete"></button></div>
          <table class="vars-table"><tbody></tbody></table></div>`;
        const d = dom(untitled);
        d.fire(d.el('.add-subset'), 'click');
        const first = d.all('[data-role="heading"]')[0];
        assert.strictEqual(first.hidden, false);
        assert.strictEqual(first.value, 'Default');
    });

    test('blurring an emptied name restores the previous one', () => {
        const d = dom(group('Dev', 'localhost') + group('Prod', 'prod.example'));
        const first = d.all('.subset-group')[0];
        const input = first.querySelector('[data-role="heading"]')!;
        d.fire(first.querySelector('.subset-rename'), 'click');
        input.value = '   ';
        d.fire(input, 'blur');
        assert.strictEqual(input.value, 'Dev');
        assert.strictEqual(first.querySelector('.subset-heading')!.textContent, 'Dev');
    });

    test('delete removes the whole sub-set; save posts the rest with names aligned', () => {
        const d = dom(group('Dev', 'localhost') + group('Prod', 'prod.example'));
        d.fire(d.all('.subset-group')[0].querySelector('.subset-delete'), 'click');
        assert.strictEqual(d.all('.subset-group').length, 1);

        d.fire(d.el('#vsfSave'), 'click');
        const { payload } = d.posted[0] as Posted;
        assert.deepStrictEqual(payload.headings, ['Prod']);
        assert.deepStrictEqual(payload.pairs, [[['VK-host', 'prod.example']]]);
    });

    test('every sub-set can be deleted; save then posts none', () => {
        const d = dom(group('Dev', 'localhost') + group('Prod', 'prod.example'));
        d.all('.subset-delete').forEach(b => d.fire(b, 'click'));
        assert.strictEqual(d.all('.subset-group').length, 0);
        d.fire(d.el('#vsfSave'), 'click');
        assert.deepStrictEqual((d.posted[0] as Posted).payload, {
            title: 'Bundles', description: '', tags: [], pairs: [], headings: [], descriptions: [] });
    });

    test('Add sub-set after deleting everything starts a fresh, deletable one', () => {
        const d = dom(group('Dev', 'localhost'));
        d.fire(d.el('.subset-delete'), 'click');
        d.fire(d.el('.add-subset'), 'click');
        assert.strictEqual(d.all('.subset-group').length, 1);
        d.fire(d.el('.subset-delete'), 'click');
        assert.strictEqual(d.all('.subset-group').length, 0);
    });
});

suite('varset form — sub-set controls: panel', () => {
    function bag(onWrite: (p: VarsEditPayload) => void, posted: Record<string, unknown>[] = []): VarSetFormCallbacks {
        return {
            validate: () => ({ ok: true }),
            write: async () => { /* create only */ },
            post: (m) => { posted.push(m); },
            close: () => { /* noop */ },
            writeEdit: async (p) => { onWrite(p); },
        };
    }

    test('deleting the first sub-set writes the second under its own name', async () => {
        let got: VarsEditPayload | undefined;
        await handleVarSetFormMessage({ command: 'save', payload: {
            title: 'Bundles', description: '', tags: [],
            pairs: [[['VK-host', 'prod.example']]], headings: ['Prod'],
        } }, bag(p => { got = p; }), 'edit', twoSets);
        // No descriptions posted (older client) → the base's, by index: none for this fixture.
        assert.deepStrictEqual(got?.subSets, [{ heading: 'Prod', description: '', pairs: [['VK-host', 'prod.example']] }]);
        assert.strictEqual(got?.env, 'staging');
    });

    test('deleting every sub-set writes an empty set that reopens as one empty sub-set', async () => {
        let got: VarsEditPayload | undefined;
        await handleVarSetFormMessage({ command: 'save', payload: {
            title: 'Bundles', description: '', tags: [], pairs: [], headings: [],
        } }, bag(p => { got = p; }), 'edit', twoSets);
        assert.deepStrictEqual(got?.subSets, []);

        const original = parseFromContent('---\nartifactType: Variables\ntitle: Bundles\n---\n', '/v/Variables/b.md', '/v/Variables');
        const text = serializeArtifact(editPayloadToModel(got!, original));
        assert.ok(!text.includes('```vks') && !text.includes('## '), `empty set still emits a body: ${text}`);
        const reopened = variablesFileToEditPayload(parseFromContent(text, '/v/Variables/b.md', '/v/Variables'));
        assert.deepStrictEqual(reopened.subSets, [{ heading: '', pairs: [] }]);
    });

    test('a rename that collides with another sub-set is refused, not written', async () => {
        let called = false;
        const posted: Record<string, unknown>[] = [];
        await handleVarSetFormMessage({ command: 'save', payload: {
            title: 'Bundles', description: '', tags: [],
            pairs: [[['VK-host', 'a']], [['VK-host', 'b']]], headings: ['Prod', 'Prod'],
        } }, bag(() => { called = true; }, posted), 'edit', twoSets);
        assert.strictEqual(called, false);
        assert.strictEqual(posted[0]?.command, 'saveFailed');
    });
});

suite('varset form — fixed VK- prefix on variable names', () => {
    test('the name input holds only the part after VK-; the prefix is a non-editable label', () => {
        const html = renderVarSetFormHtml(twoSets, [], 'csp', 'n', 'edit');
        const body = html.slice(0, html.indexOf('<script nonce='));
        assert.ok(body.includes('<span class="vk-prefix" aria-hidden="true">VK-</span>'));
        assert.ok(/data-role="name"[^>]*value="host"/.test(body), 'name input still carries the prefix');
        assert.ok(!/data-role="name"[^>]*value="VK-/.test(body));
    });

    test('a legacy name without the prefix is shown as-is', () => {
        const html = renderVarSetFormHtml({ ...twoSets, subSets: [{ heading: '', pairs: [['host', 'x']] }] }, [], 'csp', 'n', 'edit');
        assert.ok(/data-role="name"[^>]*value="host"/.test(html));
    });

    for (const mode of ['create', 'edit'] as const) {
        test(`${mode}: save restores VK-, never doubles it, and leaves an empty name empty`, () => {
            const rows = `<tr class="var-row"><td><input data-role="name" value="host"></td><td><input data-role="value" value="1"></td></tr>
              <tr class="var-row"><td><input data-role="name" value="VK-port"></td><td><input data-role="value" value="2"></td></tr>
              <tr class="var-row"><td><input data-role="name" value=""></td><td><input data-role="value" value="3"></td></tr>`;
            const table = `<table class="vars-table"><tbody>${rows}</tbody></table>`;
            const seedHtml = `
              <input id="vsfTitle" value="B"><textarea id="vsfDescription"></textarea>
              <div id="vsfError" hidden></div><button id="vsfCancel"></button><button id="vsfSave"></button>
              ${mode === 'edit' ? `<div id="vsfSubSets"><div class="subset-group">${table}</div></div>` : table}`;
            const d = makeWebviewDom({ seedHtml, script: buildVarSetFormClientJs(mode, '[]') });
            d.fire(d.el('#vsfSave'), 'click');
            const pairs = (d.posted[0] as { payload: { pairs: unknown } }).payload.pairs;
            const expected = [['VK-host', '1'], ['VK-port', '2'], ['', '3']];
            assert.deepStrictEqual(pairs, mode === 'edit' ? [expected] : expected);
        });
    }
});
