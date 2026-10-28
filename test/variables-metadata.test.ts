import * as assert from 'node:assert';
import type * as vscode from 'vscode';
import { useVarsEngine, recordedSource, VAULT } from './vars-engine.js';
import { recordedRead } from './recorded.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { handleEditDescription, handleEditTags, parseTagList } from '../src/commands/variables-meta.command.js';
import type { CommandIO } from '../src/commands/variables.command.helpers.js';
import { variablesFileToEditPayload, editPayloadToModel } from '../src/services/varset.service.js';
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
 * The fixture is a real vault note (`js-array-domains.md`), recorded from the pinned engine.
 */

const SOURCE = recordedSource('vars-with-descriptions');
const parse = () => toParsedArtifactFile(recordedRead('vars-with-descriptions'), '/v');

suite('Variables metadata — editor round trip', () => {
    test('open → save unchanged sends the same descriptions, tags and description to artifact.update (byte round trip: engine case rs-idem-descriptions)', () => {
        const parsed = parse();
        const payload = variablesFileToEditPayload(parsed);
        assert.strictEqual(payload.subSets[0]?.description, 'Active users keyed by `status`; works for filter, find, map, group and dedupe.');
        const model = editPayloadToModel(payload, parsed);
        assert.strictEqual(model.title, parsed.frontmatter.title);
        assert.strictEqual(model.description, parsed.frontmatter.description);
        assert.deepStrictEqual(model.tags, parsed.frontmatter.tags);
        assert.deepStrictEqual(model.blocks.map(b => [b.heading, b.description]), parsed.blocks.map(b => [b.heading, b.description]));
    });

    test('the editor renders each sub-set description, escaped', () => {
        const html = renderVarSetFormHtml(variablesFileToEditPayload(parse()), [], 'csp', 'n', 'edit');
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

    test('the panel writes posted descriptions — a fence- or heading-looking line included (the engine refuses what it cannot write)', async () => {
        const base = variablesFileToEditPayload(parse());
        let got: VarsEditPayload | undefined;
        const posted: Record<string, unknown>[] = [];
        const cb: VarSetFormCallbacks = {
            write: async () => true,
            post: m => { posted.push(m); }, close: () => { /* noop */ }, writeEdit: async p => { got = p; return true; },
        };
        const wire = (descriptions: string[]) => ({ command: 'save', payload: {
            title: 't', description: '', tags: [], pairs: [[['VK-a', '1']], [['VK-a', '2']]], headings: ['A', 'B'], descriptions,
        } });
        await handleVarSetFormMessage(wire([' first ', '']), cb, 'edit', base);
        assert.deepStrictEqual(got?.subSets.map(s => s.description), ['first', '']);

        const first = got;
        await handleVarSetFormMessage(wire(['ok', 'text\n```']), cb, 'edit', base);
        assert.notStrictEqual(got, first);
        assert.deepStrictEqual((got as VarsEditPayload | undefined)?.subSets.map(s => s.description), ['ok', 'text\n```'], 'the panel re-checked a rule the engine owns');
        assert.strictEqual(posted.length, 0);
    });
});

suite('Variables metadata — pane display and search', () => {
    const nodes = buildVariableNodes([{ ...parse(), filePath: '/v/Variables/x.md' }]);

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

suite('Variables metadata — pane editing goes through the engine', () => {
    const eng = useVarsEngine();
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

    test('Edit Description… on a sub-set row sends vars.subset.describe with the sub-set ref', async () => {
        const file = eng().serve('Variables/x.md', SOURCE);
        const heading = parse().blocks[1].heading;
        await handleEditDescription(subsetRow(file, 1), new VariablesViewProvider(), io(['Catalogue by `category`.']).io, VAULT);
        assert.deepStrictEqual(eng().calls('vars.subset.describe').map(c => c.params), [{
            path: 'Variables/x.md', expectedHash: eng().hashOf(SOURCE),
            subset: { index: 1, heading }, description: 'Catalogue by `category`.',
        }]);
    });

    test('Edit Description… on a file row sends artifact.patch description', async () => {
        const file = eng().serve('Variables/x.md', SOURCE);
        eng().fake.on('artifact.patch', p => ({ result: { path: (p as { path: string }).path, hash: 'after' } }));
        await handleEditDescription(fileRow(file), new VariablesViewProvider(), io(['Short.']).io, VAULT);
        assert.deepStrictEqual(eng().calls('artifact.patch').map(c => c.params), [{
            path: 'Variables/x.md', expectedHash: eng().hashOf(SOURCE), edit: { field: 'description', value: 'Short.' },
        }]);
    });

    test('a multi-line sub-set description is refused in the pane, zero write requests', async () => {
        const src = recordedSource('vars-with-descriptions-multiline');
        const file = eng().serve('Variables/x.md', src);
        const { io: bag, errors } = io(['flattened']);
        await handleEditDescription(subsetRow(file, 0), new VariablesViewProvider(), bag, VAULT);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(eng().calls('vars.subset.describe').length, 0);
        assert.strictEqual(eng().calls('artifact.patch').length, 0);
    });

    test('Edit Description… asks with no validateInput (the engine refuses what it cannot write)', async () => {
        const file = eng().serve('Variables/x.md', SOURCE);
        const seen: (vscode.InputBoxOptions | undefined)[] = [];
        const bag: CommandIO = { ...io([]).io, showInputBox: o => { seen.push(o); return Promise.resolve(undefined); } };
        await handleEditDescription(subsetRow(file, 1), new VariablesViewProvider(), bag, VAULT);
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0]?.validateInput, undefined);
    });

    test('Edit Tags… parses the input and sends vars.meta.tags', async () => {
        const file = eng().serve('Variables/x.md', SOURCE);
        await handleEditTags(fileRow(file), new VariablesViewProvider(), io(['#js, arrays  arrays']).io, VAULT);
        assert.deepStrictEqual(eng().calls('vars.meta.tags').map(c => c.params), [{
            path: 'Variables/x.md', expectedHash: eng().hashOf(SOURCE), tags: ['js', 'arrays'],
        }]);
    });

    test('parseTagList: commas or spaces, leading # dropped, de-duplicated', () => {
        assert.deepStrictEqual(parseTagList('#api, http  #rest, api'), ['api', 'http', 'rest']);
        assert.deepStrictEqual(parseTagList('  '), []);
    });
});
