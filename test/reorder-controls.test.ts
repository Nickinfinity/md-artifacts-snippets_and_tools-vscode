import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildReorderButtons, REORDER_CLIENT_JS } from '../src/ui/panels/shared/reorderControls.js';
import { buildVarSetFormClientJs, renderVarSetFormHtml } from '../src/ui/panels/varsetForm/varsetForm.render.js';
import { FORM_CLIENT_JS } from '../src/ui/panels/artifactForm/form.clientJs.js';
import { editPayloadToModel } from '../src/services/varset.service.js';
import { serializeArtifact } from '../src/services/artifact-serializer.service.js';
import { parseFromContent } from '../src/services/parser.service.js';
import { makeWebviewDom } from './webview-dom-harness.js';
import type { VarsEditPayload } from '../src/types/varset.types.js';

/**
 * THE ↑/↓ reorder control (`shared/reorderControls.ts`) and its three users:
 * the artifact form's block cards, the var-set form's sub-sets and its
 * variable rows. Order is the DOM's, so each test moves an element and checks
 * what the form posts — the order that reaches the file.
 */

suite('reorder control — markup', () => {
    test('↑ disabled on the first item, ↓ on the last, labelled for screen readers', () => {
        const first = buildReorderButtons('var-row', 0, 3);
        const last  = buildReorderButtons('var-row', 2, 3);
        assert.ok(/data-action="up"[^>]* disabled/.test(first) && !/data-action="down"[^>]* disabled/.test(first));
        assert.ok(/data-action="down"[^>]* disabled/.test(last));
        assert.ok(first.includes('aria-label="Move up"') && first.includes('data-reorder="var-row"'));
    });

    test('there is one reorder implementation: no other src file spells the button', () => {
        const srcRoot = path.join(__dirname, '../../src');
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!full.endsWith('.ts') || full.endsWith('reorderControls.ts')) { continue; }
                if (/class="reorder-btn"|data-action="(?:up|down)"/.test(fs.readFileSync(full, 'utf8'))) { offenders.push(path.relative(srcRoot, full)); }
            }
        };
        walk(srcRoot);
        assert.deepStrictEqual(offenders, [], 'reorder buttons re-spelled outside shared/reorderControls.ts');
    });

    test('each editor bundle carries the shared script exactly once', () => {
        const count = (s: string) => s.split('function reorderMove(').length - 1;
        assert.strictEqual(count(FORM_CLIENT_JS), 1);
        assert.strictEqual(count(buildVarSetFormClientJs('edit', '[]')), 1);
        assert.strictEqual(count(buildVarSetFormClientJs('create', '[]')), 0, 'create mode has fixed rows');
        assert.ok(REORDER_CLIENT_JS.includes('function reorderWire('));
    });
});

// ── Var-set form ────────────────────────────────────────────────────────────

const twoSets: VarsEditPayload = {
    title: 'Bundles', description: '', tags: [],
    subSets: [
        { heading: 'Dev',  description: 'local', pairs: [['VK-host', 'localhost'], ['VK-port', '3000']] },
        { heading: 'Prod', description: 'live',  pairs: [['VK-host', 'prod.example']] },
    ],
};

/** The real server markup for `twoSets`, run under the real edit-mode script. */
function editDom() {
    const html = renderVarSetFormHtml(twoSets, [], 'csp', 'n', 'edit');
    const body = html.slice(html.indexOf('<body'), html.indexOf('<script nonce='));
    return makeWebviewDom({ seedHtml: body, script: buildVarSetFormClientJs('edit', '[]') });
}

type Posted = { payload: { pairs: [string, string][][]; headings: string[]; descriptions: string[] } };
const save = (d: ReturnType<typeof editDom>): Posted['payload'] => {
    d.fire(d.el('#vsfSave'), 'click');
    return (d.posted.at(-1) as Posted).payload;
};

suite('reorder control — var-set form', () => {
    test('moving a variable down changes its order in the posted sub-set', () => {
        const d = editDom();
        const rowDown = d.all('.var-row')[0].querySelector('[data-action="down"]');
        d.fire(rowDown, 'click');
        assert.deepStrictEqual(save(d).pairs[0], [['VK-port', '3000'], ['VK-host', 'localhost']]);
    });

    test('moving a sub-set up moves its rows, name and description together', () => {
        const d = editDom();
        const prodUp = d.all('.subset-group')[1].querySelector('.subset-header [data-action="up"]')
            ?? d.all('.subset-group')[1].querySelector('[data-action="up"]');
        d.fire(prodUp, 'click');
        const p = save(d);
        assert.deepStrictEqual(p.headings, ['Prod', 'Dev']);
        assert.deepStrictEqual(p.descriptions, ['live', 'local']);
        assert.deepStrictEqual(p.pairs, [[['VK-host', 'prod.example']], [['VK-host', 'localhost'], ['VK-port', '3000']]]);
    });

    test('a variable never jumps into another sub-set — ↓ on a sub-set\'s last row is disabled and inert', () => {
        const d = editDom();
        const lastDevRow = d.all('.subset-group')[0].querySelectorAll('.var-row')[1];
        const down = lastDevRow.querySelector('[data-action="down"]')!;
        assert.ok(down.hasAttribute('disabled'));
        d.fire(down, 'click');
        assert.deepStrictEqual(save(d).pairs[0], [['VK-host', 'localhost'], ['VK-port', '3000']]);
    });

    test('ends are re-evaluated after a move: the new first sub-set\'s ↑ is disabled', () => {
        const d = editDom();
        d.fire(d.all('.subset-group')[1].querySelector('[data-action="up"]'), 'click');
        const first = d.all('.subset-group')[0];
        assert.strictEqual(first.querySelector('[data-action="up"]')!.hasAttribute('disabled'), true);
        assert.strictEqual(d.all('.subset-group')[1].querySelector('[data-action="up"]')!.hasAttribute('disabled'), false);
    });

    test('the posted order is the order written to the file', () => {
        const swapped: VarsEditPayload = { ...twoSets, subSets: [twoSets.subSets[1], twoSets.subSets[0]] };
        const text = serializeArtifact(editPayloadToModel(swapped, parseFromContent('---\nartifactType: Variables\n---\n', '/v/Variables/b.md', '/v/Variables')));
        assert.ok(text.indexOf('## Prod') < text.indexOf('## Dev'), text);
    });
});

// ── Artifact form ───────────────────────────────────────────────────────────

suite('reorder control — artifact form block cards', () => {
    test('moving a card down swaps it and re-indexes every data-block in both cards', () => {
        const card = (i: number, total: number, heading: string) => `
          <div class="block-card" data-block-index="${i}"><div class="card-header">
            <input class="block-heading-input" id="block-${i}-heading" data-block="${i}" value="${heading}">
            ${buildReorderButtons('block-card', i, total, ` data-block="${i}"`)}
            <button class="remove-block-btn" data-block="${i}"></button>
          </div></div>`;
        const seedHtml = `<div id="blocks-area" class="multi-block">${card(0, 2, 'One')}${card(1, 2, 'Two')}</div>`;
        const d = makeWebviewDom({ seedHtml, script: FORM_CLIENT_JS });

        d.fire(d.all('.block-card')[0].querySelector('[data-action="down"]'), 'click');

        const cards = d.all('.block-card');
        assert.deepStrictEqual(cards.map(c => c.querySelector('.block-heading-input')!.value), ['Two', 'One']);
        assert.deepStrictEqual(cards.map(c => c.dataset.blockIndex), ['0', '1']);
        assert.strictEqual(cards[1].querySelector('.remove-block-btn')!.dataset.block, '1', 'data-block did not follow its card');
        assert.ok(cards[0].querySelector('[data-action="up"]')!.hasAttribute('disabled'));
    });
});
