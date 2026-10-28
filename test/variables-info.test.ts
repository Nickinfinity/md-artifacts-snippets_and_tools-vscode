import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { handleViewInfo } from '../src/commands/variables-info.command.js';
import { handleAddVar } from '../src/commands/variables.command.js';
import type { CommandIO } from '../src/commands/variables.command.helpers.js';
import { renderInfoHtml } from '../src/ui/panels/infoPanel/infoPanel.render.js';
import { VariablesViewProvider, type VariableNode } from '../src/ui/views/variablesView.provider.js';
import type { InfoModel } from '../src/types/info.types.js';
import { useVarsEngine, recordedSource, VAULT, type VarsEngine } from './vars-engine.js';

/**
 * View Info — the artifact-agnostic summary popup (`types/info.types.ts` +
 * `ui/panels/infoPanel/`) and its Variables adapter. The adapter is driven
 * through the real command with the popup opener injected, so each test sees
 * exactly the model the popup would render.
 */

const FIXTURE = recordedSource('vars-with-descriptions');

let eng: () => VarsEngine;
/** Serves `content` as `Variables/x.md`; the tree node id carries its absolute path. */
function vault(content: string): { root: vscode.Uri; file: string } {
    return { root: VAULT, file: eng().serve('Variables/x.md', content) };
}
const quiet: CommandIO = {
    showInputBox: () => Promise.resolve(undefined), confirm: () => Promise.resolve(true),
    showError: () => { /* none */ }, showQuickPick: () => Promise.resolve(undefined),
};

async function infoFor(node: (file: string) => VariableNode, content = FIXTURE): Promise<InfoModel> {
    const { root, file } = vault(content);
    let got: InfoModel | undefined;
    await handleViewInfo(node(file), vscode.Uri.file('/ext'), quiet, root, (_u, m) => { got = m; });
    assert.ok(got, 'the popup was never opened');
    return got;
}

suite('View Info (engine)', () => {
    eng = useVarsEngine();

    suite('View Info — Variables adapter', () => {
        test('a set: description, tags, structure, counts, and one section per sub-set', async () => {
            const m = await infoFor(f => ({ id: f, parentId: null, kind: 'file', label: 'x', shape: 'sets' }));
            assert.strictEqual(m.kind, 'Variable set');
            assert.strictEqual(m.title, 'JavaScript Array Domains');
            assert.deepStrictEqual(m.tags, ['javascript', 'array', 'utils', 'collections']);
            assert.ok(m.description?.startsWith('Real-world collections'));
            assert.deepStrictEqual(m.fields.map(f => [f.label, f.value]), [['Structure', 'Named groups of variables'], ['Sub-sets', '6'], ['Variables', '21']]);
            assert.deepStrictEqual(m.sections.map(s => s.heading), ['Users', 'Products', 'Orders', 'Tasks', 'API page', 'Tags']);
            assert.ok(m.sections[0].description?.includes('`status`'));
            assert.strictEqual(m.path, 'x.md');
        });

        test('a sub-set: its description, its set, and its variables', async () => {
            const m = await infoFor(f => ({ id: `${f}::subset:1`, parentId: f, kind: 'subset', label: 'Products' }));
            assert.strictEqual(m.kind, 'Sub-set');
            assert.strictEqual(m.title, 'Products');
            assert.strictEqual(m.description, 'A product catalogue grouped or filtered by `category`.');
            assert.deepStrictEqual(m.sections[0].fields.map(f => f.label), ['VK-array', 'VK-result', 'VK-property', 'VK-value']);
        });

        test('a variable: value, sub-set and set', async () => {
            const m = await infoFor(f => ({ id: `${f}::subset:2::var:3`, parentId: `${f}::subset:2`, kind: 'var', label: 'v' }));
            assert.strictEqual(m.title, 'VK-value');
            assert.deepStrictEqual(m.fields.map(f => [f.label, f.value]), [['Value', '100'], ['Sub-set', 'Orders'], ['Variable set', 'JavaScript Array Domains']]);
        });

        test('a one-block set lists its variables without a sub-set level', async () => {
            const flat = recordedSource('vars-local');
            const m = await infoFor(f => ({ id: f, parentId: null, kind: 'file', label: 'x', shape: 'flat' }), flat);
            assert.strictEqual(m.fields[0].value, 'One list of variables, no sub-sets');
            assert.deepStrictEqual(m.sections.map(s => [s.heading, s.fields.length]), [['Variables', 1]]);
        });
    });

    suite('View Info — renderer (artifact-agnostic)', () => {
        const model: InfoModel = {
            kind: 'Snippet', title: '<img src=x onerror=alert(1)>', description: 'a "quoted" <b>desc</b>',
            tags: ['<t>'], fields: [{ label: 'L', value: '</span><script>x</script>', mono: true }],
            sections: [{ heading: 'S', fields: [], emptyText: 'Nothing.' }], path: 'p.md',
        };
        const html = renderInfoHtml(model, ['base.css'], 'csp', 'n');

        test('every model value is escaped', () => {
            assert.ok(!html.includes('<img src=x') && !html.includes('<script>x') && !html.includes('<b>desc'));
            assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        });

        test('the popup allows no script at all', () => {
            assert.ok(!/<script/i.test(html));
            assert.ok(html.includes("default-src 'none'") && !html.includes('script-src'));
        });

        test('an empty section shows its empty text', () => {
            assert.ok(html.includes('Nothing.'));
        });
    });

    suite('Create rules — Add Variable on a blank set', () => {
        test('the right-click Add Variable on a blank file sends vars.var.add with no subset (the engine makes it a one-block file)', async () => {
            const content = recordedSource('vars-blank-new');
            const { root, file } = vault(content);
            const answers = ['host', 'localhost'];
            const bag: CommandIO = { ...quiet, showInputBox: () => Promise.resolve(answers.shift()) };
            await handleAddVar({ id: file, parentId: null, kind: 'file', label: 'New', shape: 'blank' }, new VariablesViewProvider(), bag, root);
            assert.deepStrictEqual(eng().calls('vars.var.add').map(c => c.params), [
                { path: 'Variables/x.md', expectedHash: eng().hashOf(content), name: 'VK-host', value: 'localhost' },
            ]);
        });
    });
});
