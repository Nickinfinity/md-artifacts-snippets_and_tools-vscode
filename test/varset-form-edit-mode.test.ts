import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderVarSetFormHtml, buildVarSetFormClientJs } from '../src/ui/panels/varsetForm/varsetForm.render.js';
import { makeWebviewDom } from './webview-dom-harness.js';
import type { VarSetFormPayload, VarsEditPayload } from '../src/types/varset.types.js';

/**
 * T7.1a — the var-set form renderer's edit-mode markup, the pair-row
 * extraction (`renderVarPairRows`), and the client-script seam
 * (`buildVarSetFormClientJs`). Covers: the create-mode byte-identity golden
 * (regression pin, not a genuine-red proof), edit-mode escaping (the sink
 * assertion), multi-sub-set seeding, CSP in both modes, and the grouped
 * posted-shape contract for a single sub-set (risk 5).
 */

const GOLDEN_PATH = path.join(__dirname, '../../test/fixtures/varset-form/create-mode.html');

/** Slices a rendered document down to its `<body>` markup, cutting at the
 * `<script nonce=` boundary — the golden covers markup only, never the
 * client script (which risk 5 requires rewriting). */
function bodyOnly(html: string): string {
    const idx = html.indexOf('<script nonce=');
    assert.ok(idx !== -1, 'no <script nonce= boundary found in rendered HTML');
    return html.slice(0, idx);
}

/**
 * Reset ONCE, deliberately, after W7: the tags field became editable in both
 * forms (`shared/tagsField.ts`), which legitimately changed create-mode markup —
 * the read-only `<div class="tags-row"></div>` gained an `id` and an input. The
 * diff was inspected line by line and contained *only* that field; the pair
 * rows stayed byte-identical, because the add/remove row affordance is gated to
 * edit mode precisely so this pin kept its meaning.
 *
 * Reset a SECOND time, deliberately: the name cell gained the fixed `VK-`
 * label (`renderVarNameCell`) — the input now holds only the part after the
 * prefix, which the client restores on Save. The diff is that one `<td>` only.
 *
 * Those are the only circumstances for regenerating it. A failure here is a
 * regression until someone has read the diff and can name the intended change.
 */
suite('varset form render — create-mode golden (regression pin, not genuine red)', () => {
    test('create-mode markup is byte-unchanged by the edit-mode extraction', () => {
        const payload: VarSetFormPayload = { title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] };
        const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE');
        const golden = fs.readFileSync(GOLDEN_PATH, 'utf8');
        assert.strictEqual(bodyOnly(html), golden,
            'create-mode markup changed — fix the change, do not regenerate this golden to accommodate it');
    });
});

suite('varset form render — edit mode escaping (sink)', () => {
    test('a sub-set heading carrying <script> renders escaped', () => {
        const payload: VarsEditPayload = {
            title: 'x', description: '', tags: [],
            subSets: [{ heading: '<script>alert(1)</script>', pairs: [['VK-a', 'b']] }],
        };
        const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE', 'edit');
        assert.ok(!html.includes('<script>alert(1)'), 'a heading reached the document unescaped');
        assert.ok(html.includes('&lt;script&gt;'), 'heading was dropped rather than escaped');
    });

    test('a pair value carrying <script> renders escaped in edit mode', () => {
        const payload: VarsEditPayload = {
            title: 'x', description: '', tags: [],
            subSets: [{ heading: 'Dev', pairs: [['VK-host', '<script>alert(2)</script>']] }],
        };
        const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE', 'edit');
        assert.ok(!html.includes('<script>alert(2)'), 'a pair value reached the document unescaped');
        assert.ok(html.includes('&lt;script&gt;'), 'pair value was dropped rather than escaped');
    });

    test('hostile subSets shape never yields an unescaped <script> anywhere in the document', () => {
        const payload: VarsEditPayload = {
            title: '"><script>alert(3)</script>',
            description: '<script>alert(4)</script>',
            tags: ['<script>alert(5)</script>'],
            subSets: [
                { heading: '<script>alert(6)</script>', pairs: [['<script>alert(7)</script>', '<script>alert(8)</script>']] },
                { heading: '', pairs: [] },
            ],
        };
        const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE', 'edit');
        for (let i = 3; i <= 8; i++) {
            assert.ok(!html.includes(`<script>alert(${i})`), `alert(${i}) payload reached the document unescaped`);
        }
    });
});

suite('varset form render — multi-sub-set seeding', () => {
    test('edit mode renders one .vars-table per sub-set, each row from the file', () => {
        const payload: VarsEditPayload = {
            title: 'Bundles', description: '', tags: [],
            subSets: [
                { heading: 'Dev', pairs: [['VK-host', 'localhost']] },
                { heading: 'Prod', pairs: [['VK-host', 'prod.example']] },
            ],
        };
        const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE', 'edit');
        const tableCount = (html.match(/class="vars-table"/g) ?? []).length;
        assert.strictEqual(tableCount, 2, 'expected one .vars-table per sub-set');
        assert.ok(html.includes('subset-heading') && html.includes('>Dev<'), 'Dev heading missing');
        assert.ok(html.includes('>Prod<'), 'Prod heading missing');
        assert.ok(html.includes('value="localhost"'), 'Dev row value missing');
        assert.ok(html.includes('value="prod.example"'), 'Prod row value missing');
    });

    test('create mode still seeds a single flat pair list (no data-subset, no heading)', () => {
        const payload: VarSetFormPayload = { title: 'x', description: '', tags: [], pairs: [['VK-a', 'b'], ['VK-c', 'd']] };
        const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE');
        const tableCount = (html.match(/class="vars-table"/g) ?? []).length;
        assert.strictEqual(tableCount, 1, 'create mode must render exactly one flat table');
        assert.ok(!html.includes('data-subset'), 'create mode must not emit data-subset');
        assert.ok(!html.includes('subset-heading'), 'create mode must not emit a sub-set heading');
    });
});

suite('varset form render — CSP in both modes', () => {
    test('edit mode carries the nonce in CSP, style and script tags', () => {
        const payload: VarsEditPayload = { title: 'x', description: '', tags: [], subSets: [{ heading: '', pairs: [] }] };
        const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE', 'edit');
        assert.ok(html.includes("script-src 'nonce-N0NCE'"), 'edit mode script-src missing nonce');
        assert.ok(html.includes('<style nonce="N0NCE"'), 'edit mode style tag missing nonce');
        assert.ok(html.includes('<script nonce="N0NCE"'), 'edit mode script tag missing nonce');
    });

    test('create mode still carries the nonce (unchanged)', () => {
        const payload: VarSetFormPayload = { title: 'x', description: '', tags: [], pairs: [] };
        const html = renderVarSetFormHtml(payload, 'x.css', "'self'", 'N0NCE');
        assert.ok(html.includes("script-src 'nonce-N0NCE'"), 'create mode script-src missing nonce');
    });
});

suite('varset form render — 🔒 posted shape (grouped, even for one sub-set)', () => {
    test('a 1-sub-set edit document posts pairs.length === 1, grouped — pairs[0] is an array of rows', () => {
        const scriptBody = buildVarSetFormClientJs('edit', '[]');
        const seedHtml = `
          <input class="form-input" id="vsfTitle" value="Bundles">
          <textarea class="form-input form-textarea" id="vsfDescription"></textarea>
          <div id="vsfError" hidden></div>
          <button id="vsfCancel"></button>
          <button id="vsfSave"></button>
          <div class="subset-group"><table class="vars-table"><tbody>
            <tr class="var-row">
              <td><input data-role="name" data-index="0" value="VK-host"></td>
              <td><input data-role="value" data-index="0" value="localhost"></td>
            </tr>
          </tbody></table></div>
        `;
        const dom = makeWebviewDom({ seedHtml, script: scriptBody });
        dom.fire(dom.el('#vsfSave'), 'click');
        assert.strictEqual(dom.posted.length, 1, 'expected exactly one postMessage on Save');
        const msg = dom.posted[0] as { command: string; payload: { pairs: unknown } };
        assert.strictEqual(msg.command, 'save');
        const pairs = msg.payload.pairs as unknown[];
        assert.strictEqual(pairs.length, 1, 'expected pairs grouped into exactly one sub-set entry');
        assert.ok(Array.isArray(pairs[0]), 'pairs[0] must be an array of rows, not a row itself');
        assert.deepStrictEqual(pairs[0], [['VK-host', 'localhost']]);
    });

    test('create mode still posts a flat pairs array (unchanged)', () => {
        const scriptBody = buildVarSetFormClientJs('create', '[]');
        const seedHtml = `
          <input class="form-input" id="vsfTitle" value="x">
          <textarea class="form-input form-textarea" id="vsfDescription"></textarea>
          <div id="vsfError" hidden></div>
          <button id="vsfCancel"></button>
          <button id="vsfSave"></button>
          <table class="vars-table"><tbody>
            <tr class="var-row">
              <td><input data-role="name" data-index="0" value="VK-a"></td>
              <td><input data-role="value" data-index="0" value="b"></td>
            </tr>
          </tbody></table>
        `;
        const dom = makeWebviewDom({ seedHtml, script: scriptBody });
        dom.fire(dom.el('#vsfSave'), 'click');
        const msg = dom.posted[0] as { payload: { pairs: unknown } };
        const pairs = msg.payload.pairs as unknown[];
        assert.deepStrictEqual(pairs, [['VK-a', 'b']], 'create mode must post a flat pairs array');
    });
});
