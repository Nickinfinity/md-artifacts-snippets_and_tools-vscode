import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildVariableNodes, filterVariableNodes, type VariableNode } from '../src/ui/views/variablesView.provider.js';
import { resolveTarget, type CommandIO } from '../src/commands/variables.command.helpers.js';
import { renderVariablesFile } from '../src/services/variables-writer.service.js';
import { renderVarSetFormHtml, buildVarSetFormClientJs } from '../src/ui/panels/varsetForm/varsetForm.render.js';
import { makeWebviewDom } from './webview-dom-harness.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';

/**
 * One-sub-set sets are worked on directly: the tree shows their vars with no
 * sub-set level (and sub-set commands accept the file node), the edit form
 * hides the lone name field — plus the tree's search filter.
 */

const single: ParsedArtifactFile = {
    filePath: '/v/Variables/local.md', fileName: 'local', relativePath: 'local.md',
    frontmatter: { artifactType: 'Variables', title: 'Local Dev' }, code: '',
    vars: [{ name: 'VK-host', defaultValue: 'localhost' }, { name: 'VK-port', defaultValue: '8080' }], blocks: [],
};
const multi: ParsedArtifactFile = {
    filePath: '/v/Variables/envs.md', fileName: 'envs', relativePath: 'envs.md',
    frontmatter: { artifactType: 'Variables', title: 'Envs' }, code: '', vars: [],
    blocks: [
        { heading: 'Dev', description: '', code: '', vars: [{ name: 'VK-api', defaultValue: 'dev.local' }] },
        { heading: 'Prod', description: '', code: '', vars: [{ name: 'VK-api', defaultValue: 'prod.example' }] },
    ],
};

const quietIo = (errors: string[] = []): CommandIO => ({
    showInputBox: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(true),
    showError: (m: string) => { errors.push(m); },
});

suite('variables tree — one-sub-set set shows its vars directly', () => {
    test('no sub-set node; vars hang off the file; ids keep ::subset:0', () => {
        const nodes = buildVariableNodes([single]);
        assert.deepStrictEqual(nodes.map(n => n.kind), ['file', 'var', 'var']);
        assert.strictEqual(nodes[0].single, true);
        assert.ok(nodes.slice(1).every(n => n.parentId === single.filePath));
        assert.strictEqual(nodes[1].id, `${single.filePath}::subset:0::var:0`);
    });

    test('a multi-sub-set set keeps its sub-set level', () => {
        const nodes = buildVariableNodes([multi]);
        assert.deepStrictEqual(nodes.map(n => n.kind), ['file', 'subset', 'var', 'subset', 'var']);
        assert.strictEqual(nodes[0].single, false);
    });
});

suite('variables tree — resolveTarget accepts a one-sub-set file as sub-set 0', () => {
    function vaultWith(model: Parameters<typeof renderVariablesFile>[0]): { root: vscode.Uri; file: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vars-single-'));
        fs.mkdirSync(path.join(dir, 'Variables'));
        const file = path.join(dir, 'Variables', 'local.md');
        fs.writeFileSync(file, renderVariablesFile(model), 'utf8');
        return { root: vscode.Uri.file(dir), file };
    }
    const model = {
        artifactType: 'Variables' as const, title: 'Local', description: '', tags: [],
        blocks: [{ heading: '', description: '', language: '', code: '', vars: [{ name: 'VK-host', defaultValue: 'localhost' }] }],
    };

    test('single file node + expected subset → resolves with subIdx 0', async () => {
        const { root, file } = vaultWith(model);
        const node: VariableNode = { id: file, parentId: null, kind: 'file', label: 'Local', single: true };
        const target = await resolveTarget(node, 'subset', root, quietIo());
        assert.strictEqual(target?.subIdx, 0);
    });

    test('a multi-sub-set file node is still refused where a sub-set is expected', async () => {
        const { root, file } = vaultWith(model);
        const errors: string[] = [];
        const node: VariableNode = { id: file, parentId: null, kind: 'file', label: 'Local', single: false };
        assert.strictEqual(await resolveTarget(node, 'subset', root, quietIo(errors)), undefined);
        assert.strictEqual(errors.length, 1);
    });
});

suite('variables tree — search filter', () => {
    const nodes = buildVariableNodes([single, multi]);
    const ids = (q: string) => filterVariableNodes(nodes, q).map(n => n.id);

    test('empty query keeps everything', () => assert.strictEqual(ids('  ').length, nodes.length));

    test('a var match keeps the var and its ancestors only', () => {
        assert.deepStrictEqual(ids('PORT'), [single.filePath, `${single.filePath}::subset:0::var:1`]);
    });

    test('a value match works too', () => {
        assert.deepStrictEqual(ids('prod.ex'), [multi.filePath, `${multi.filePath}::subset:1`, `${multi.filePath}::subset:1::var:0`]);
    });

    test('a sub-set match keeps its whole subtree', () => {
        assert.deepStrictEqual(ids('dev'), [
            single.filePath, // "Local Dev" title
            `${single.filePath}::subset:0::var:0`, `${single.filePath}::subset:0::var:1`,
            multi.filePath, `${multi.filePath}::subset:0`, `${multi.filePath}::subset:0::var:0`,
        ]);
    });

    test('no match → empty', () => assert.deepStrictEqual(ids('zzz'), []));
});

suite('varset edit form — one-sub-set quick edit', () => {
    const lone = { title: 'L', description: '', tags: [], subSets: [{ heading: '', pairs: [['VK-a', '1']] as [string, string][] }] };

    test('a lone heading-less sub-set renders its name field hidden', () => {
        const html = renderVarSetFormHtml(lone, [], 'csp', 'n', 'edit');
        assert.ok(/data-role="heading"[^>]*hidden>/.test(html.slice(0, html.indexOf('<script nonce='))));
    });

    test('Add sub-set reveals the hidden name field', () => {
        const seedHtml = `
          <input id="vsfTitle" value="L"><textarea id="vsfDescription"></textarea>
          <div id="vsfError" hidden></div><button id="vsfCancel"></button><button id="vsfSave"></button>
          <div id="vsfSubSets"><input data-role="heading" data-subset="0" value="" hidden>
            <table class="vars-table"><tbody></tbody></table></div>
          <button class="add-subset"></button>`;
        const dom = makeWebviewDom({ seedHtml, script: buildVarSetFormClientJs('edit', '[]') });
        dom.fire(dom.el('.add-subset'), 'click');
        assert.ok(dom.all('[data-role="heading"]').every(h => !h.hidden), 'a name field stayed hidden');
    });
});
