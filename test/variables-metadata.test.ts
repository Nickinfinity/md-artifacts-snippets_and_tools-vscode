import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { handleAddVar } from '../src/commands/variables.command.js';
import { handleEditDescription, handleEditTags, parseTagList } from '../src/commands/variables-meta.command.js';
import type { CommandIO } from '../src/commands/variables.command.helpers.js';
import { parseFromContent, parseArtifactFile } from '../src/services/parser.service.js';
import { serializeArtifact } from '../src/services/artifact-serializer.service.js';
import { variablesFileToEditPayload, editPayloadToModel } from '../src/services/varset.service.js';
import { validateSubSetDescriptions } from '../src/services/varset-form.service.js';
import { handleVarSetFormMessage, type VarSetFormCallbacks } from '../src/ui/panels/varsetForm/varsetForm.panel.js';
import { renderVarSetFormHtml, buildVarSetFormClientJs } from '../src/ui/panels/varsetForm/varsetForm.render.js';
import { VariablesViewProvider, buildVariableNodes, filterVariableNodes, type VariableNode } from '../src/ui/views/variablesView.provider.js';
import { makeWebviewDom } from './webview-dom-harness.js';
import type { VarsEditPayload } from '../src/types/varset.types.js';

/**
 * A Variables file carries more than variables: a set-level `description:`
 * and `tags:`, an `env:`, and a description under each `## ` sub-set. These
 * tests pin that none of it is lost by the editor or the pane, that the
 * editor can change all of it, and that the pane shows and searches it.
 *
 * The fixture is a real vault note (`js-array-domains.md`), copied verbatim.
 */

const FIXTURE = path.join(__dirname, '../../test/fixtures/vars-edit/with-descriptions.md');
const SOURCE = fs.readFileSync(FIXTURE, 'utf8');
const parse = (text: string) => parseFromContent(text, '/v/Variables/x.md', '/v/Variables');

suite('Variables metadata — editor round trip', () => {
    test('open → save unchanged rewrites the file byte for byte (descriptions, tags, description kept)', () => {
        const parsed = parse(SOURCE);
        const payload = variablesFileToEditPayload(parsed);
        assert.strictEqual(payload.subSets[0]?.description, 'Active users keyed by `status`; works for filter, find, map, group and dedupe.');
        assert.strictEqual(serializeArtifact(editPayloadToModel(payload, parsed)), SOURCE);
    });

    test('the editor renders each sub-set description, escaped', () => {
        const html = renderVarSetFormHtml(variablesFileToEditPayload(parse(SOURCE)), [], 'csp', 'n', 'edit');
        const body = html.slice(0, html.indexOf('<script nonce='));
        assert.ok(body.includes('data-role="subset-desc"'));
        assert.ok(body.includes('Active users keyed by `status`'));
        const hostile = renderVarSetFormHtml({ title: 't', description: '', tags: [],
            subSets: [{ heading: 'A', description: '</textarea><script>x</script>', pairs: [] }] }, [], 'csp', 'n', 'edit');
        assert.ok(!hostile.includes('</textarea><script>'), 'description broke out of its textarea');
    });

    test('a one-block set hides the description field (no heading to keep it under)', () => {
        const html = renderVarSetFormHtml({ title: 't', description: '', tags: [],
            subSets: [{ heading: '', pairs: [['VK-a', '1']] }] }, [], 'csp', 'n', 'edit');
        assert.ok(/data-role="subset-desc"[^>]*hidden>/.test(html));
    });

    test('the client posts one description per sub-set, edited text included', () => {
        const seedHtml = `
          <input id="vsfTitle" value="t"><textarea id="vsfDescription"></textarea>
          <div id="vsfError" hidden></div><button id="vsfCancel"></button><button id="vsfSave"></button>
          <div id="vsfSubSets">
            <div class="subset-group"><input data-role="heading" value="Dev" hidden>
              <textarea data-role="subset-desc">old</textarea><table class="vars-table"><tbody></tbody></table></div>
            <div class="subset-group"><input data-role="heading" value="Prod" hidden>
              <textarea data-role="subset-desc"></textarea><table class="vars-table"><tbody></tbody></table></div>
          </div>`;
        const d = makeWebviewDom({ seedHtml, script: buildVarSetFormClientJs('edit', '[]') });
        d.all('[data-role="subset-desc"]')[0].value = 'new text';
        d.fire(d.el('#vsfSave'), 'click');
        assert.deepStrictEqual((d.posted[0] as { payload: { descriptions: string[] } }).payload.descriptions, ['new text', '']);
    });

    test('the panel writes posted descriptions and refuses one that would break the file', async () => {
        const base = variablesFileToEditPayload(parse(SOURCE));
        let got: VarsEditPayload | undefined;
        const posted: Record<string, unknown>[] = [];
        const cb: VarSetFormCallbacks = {
            validate: () => ({ ok: true }), write: async () => { /* create only */ },
            post: m => { posted.push(m); }, close: () => { /* noop */ }, writeEdit: async p => { got = p; },
        };
        const wire = (descriptions: string[]) => ({ command: 'save', payload: {
            title: 't', description: '', tags: [], pairs: [[['VK-a', '1']], [['VK-a', '2']]], headings: ['A', 'B'], descriptions,
        } });
        await handleVarSetFormMessage(wire([' first ', '']), cb, 'edit', base);
        assert.deepStrictEqual(got?.subSets.map(s => s.description), ['first', '']);

        got = undefined;
        await handleVarSetFormMessage(wire(['ok', 'text\n```vks']), cb, 'edit', base);
        assert.strictEqual(got, undefined, 'a fence-opening description was written');
        assert.strictEqual(posted.at(-1)?.command, 'saveFailed');
    });

    test('validateSubSetDescriptions: inline code fine; fence or heading lines refused', () => {
        assert.ok(validateSubSetDescriptions(['Users keyed by `status`.']).ok);
        assert.ok(!validateSubSetDescriptions(['```vks']).ok);
        assert.ok(!validateSubSetDescriptions(['line\n## Prod']).ok);
    });
});

suite('Variables metadata — pane display and search', () => {
    const nodes = buildVariableNodes([{ ...parse(SOURCE), filePath: '/v/Variables/x.md' }]);

    test('file row shows tags beside the name and description + tags on hover', () => {
        const file = nodes[0];
        assert.strictEqual(file.detail, '#javascript #array #utils #collections');
        assert.ok(file.tooltip?.startsWith('Real-world collections'));
        assert.ok(file.tooltip?.endsWith('#collections'));
    });

    test('sub-set row shows its description beside the name (bounded) and in full on hover', () => {
        const users = nodes.find(n => n.kind === 'subset' && n.label === 'Users')!;
        assert.ok(users.detail && users.detail.length <= 41);
        assert.strictEqual(users.tooltip, 'Active users keyed by `status`; works for filter, find, map, group and dedupe.');
    });

    test('search matches a tag, a set description and a sub-set description', () => {
        const kept = (q: string) => filterVariableNodes(nodes, q).filter(n => n.kind !== 'var').map(n => n.label);
        assert.ok(kept('collections').includes('JavaScript Array Domains'));
        assert.ok(kept('real-world').includes('JavaScript Array Domains'));
        assert.deepStrictEqual(kept('catalogue'), ['JavaScript Array Domains', 'Products']);
    });
});

suite('Variables metadata — pane editing keeps and changes it', () => {
    function vault(content: string): { root: vscode.Uri; file: string; dir: string } {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vars-meta-'));
        const dir = path.join(root, 'Variables');
        fs.mkdirSync(dir);
        const file = path.join(dir, 'x.md');
        fs.writeFileSync(file, content, 'utf8');
        return { root: vscode.Uri.file(root), file, dir };
    }
    function io(inputs: (string | undefined)[]): { io: CommandIO; errors: string[] } {
        const errors: string[] = [];
        return { errors, io: {
            showInputBox: () => Promise.resolve(inputs.shift()),
            confirm: () => Promise.resolve(true),
            showError: m => { errors.push(m); },
            showQuickPick: () => Promise.resolve(undefined),
        } };
    }
    const fileRow = (file: string): VariableNode => ({ id: file, parentId: null, kind: 'file', label: 'x', shape: 'sets' });
    const subsetRow = (file: string, i: number): VariableNode => ({ id: `${file}::subset:${i}`, parentId: file, kind: 'subset', label: 's' });

    test('adding a variable keeps env, tags, the set description and every sub-set description', async () => {
        const { root, file, dir } = vault(SOURCE.replace('tags: [', 'env: staging\ntags: ['));
        await handleAddVar(subsetRow(file, 0), new VariablesViewProvider(), io(['extra', 'x']).io, root);
        const after = parseArtifactFile(file, dir)!;
        const before = parse(SOURCE);
        assert.strictEqual(after.frontmatter.env, 'staging', 'env: was dropped');
        assert.deepStrictEqual(after.frontmatter.tags, before.frontmatter.tags);
        assert.strictEqual(after.frontmatter.description, before.frontmatter.description);
        assert.deepStrictEqual(after.blocks.map(b => b.description), before.blocks.map(b => b.description));
    });

    test('Edit Description… on a sub-set row changes only that sub-set\'s prose', async () => {
        const { root, file, dir } = vault(SOURCE);
        await handleEditDescription(subsetRow(file, 1), new VariablesViewProvider(), io(['Catalogue by `category`.']).io, root);
        const blocks = parseArtifactFile(file, dir)!.blocks;
        assert.strictEqual(blocks[1].description, 'Catalogue by `category`.');
        assert.strictEqual(blocks[0].description, parse(SOURCE).blocks[0].description);
    });

    test('Edit Description… on a file row changes the frontmatter description', async () => {
        const { root, file, dir } = vault(SOURCE);
        await handleEditDescription(fileRow(file), new VariablesViewProvider(), io(['Short.']).io, root);
        assert.strictEqual(parseArtifactFile(file, dir)!.frontmatter.description, 'Short.');
    });

    test('a multi-line sub-set description is refused in the pane, file untouched', async () => {
        const { root, file } = vault(SOURCE.replace('works for filter', 'works for\nfilter'));
        const before = fs.readFileSync(file, 'utf8');
        const { io: bag, errors } = io(['flattened']);
        await handleEditDescription(subsetRow(file, 0), new VariablesViewProvider(), bag, root);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
        assert.strictEqual(errors.length, 1);
    });

    test('Edit Tags… replaces the tag list', async () => {
        const { root, file, dir } = vault(SOURCE);
        await handleEditTags(fileRow(file), new VariablesViewProvider(), io(['#js, arrays  arrays']).io, root);
        assert.deepStrictEqual(parseArtifactFile(file, dir)!.frontmatter.tags, ['js', 'arrays']);
    });

    test('parseTagList: commas or spaces, leading # dropped, de-duplicated', () => {
        assert.deepStrictEqual(parseTagList('#api, http  #rest, api'), ['api', 'http', 'rest']);
        assert.deepStrictEqual(parseTagList('  '), []);
    });
});
