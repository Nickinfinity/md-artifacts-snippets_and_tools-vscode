import * as assert from 'node:assert';
import { saveVarsEdit } from '../src/commands/open-vars-edit.helpers.js';
import { parseFromContent } from '../src/services/parser.service.js';
import { handleVarSetFormMessage, type VarSetFormCallbacks } from '../src/ui/panels/varsetForm/varsetForm.panel.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';
import type { EngineParams } from '../src/types/engine.types.js';
import type { VarsEditPayload } from '../src/types/varset.types.js';
import { useVarsEngine } from './vars-engine.js';

// T3.6: the Variable Set editor saves through artifact.update with the read's hash.
const FLAT = '---\nartifactType: Variables\ntitle: Flat\n---\n\n```yaml VKs\nVK-host: localhost\n```\n';

/** A file as the engine read it: TS-parsed shape plus the engine meta fields `toParsedArtifactFile` keeps. */
const engineFile = (md: string, hash: string): ParsedArtifactFile =>
    Object.assign(parseFromContent(md, '/v/Variables/flat.md', '/v/Variables'), { relPath: 'Variables/flat.md', hash });

const payload = (subSets: VarsEditPayload['subSets']): VarsEditPayload =>
    ({ title: 'Flat', description: '', tags: [], subSets });

suite('saveVarsEdit — artifact.update through the engine', () => {
    const eng = useVarsEngine();
    const sent = () => eng().calls('artifact.update').map(c => c.params as EngineParams<'artifact.update'>);

    test('untitled one-block set: one block, heading "", read hash + path sent', async () => {
        eng().fake.on('artifact.update', () => ({ result: { path: 'Variables/flat.md', hash: 'n' } }));
        const ok = await saveVarsEdit(engineFile(FLAT, 'h1'), payload([{ heading: '', pairs: [['VK-host', 'localhost']] }]));
        assert.strictEqual(ok, true);
        assert.strictEqual(sent().length, 1);
        assert.strictEqual(sent()[0].path, 'Variables/flat.md');
        assert.strictEqual(sent()[0].expectedHash, 'h1');
        assert.strictEqual(sent()[0].model.blocks?.length, 1);
        assert.strictEqual(sent()[0].model.blocks?.[0].heading, '');
    });

    test('two sub-sets: headings in posted order', async () => {
        eng().fake.on('artifact.update', () => ({ result: { path: 'Variables/flat.md', hash: 'n' } }));
        await saveVarsEdit(engineFile(FLAT, 'h1'), payload([
            { heading: 'Prod', description: '', pairs: [['VK-a', '1']] },
            { heading: 'Dev', description: '', pairs: [['VK-a', '2']] },
        ]));
        assert.deepStrictEqual(sent()[0].model.blocks?.map(b => b.heading), ['Prod', 'Dev']);
    });

    test('conflict: modal, false, exactly one update', async () => {
        eng().fake.on('artifact.update', () => ({ error: { code: 'file.conflict', params: { path: 'Variables/flat.md', actual: 'z' } } }));
        const ok = await saveVarsEdit(engineFile(FLAT, 'h1'), payload([{ heading: '', pairs: [] }]));
        assert.strictEqual(ok, false);
        assert.strictEqual(sent().length, 1);
        assert.strictEqual(eng().modals.length, 1);
    });

    test('conflict + Reload: onReload called once, no second update', async () => {
        eng().fake.on('artifact.update', () => ({ error: { code: 'file.conflict', params: { path: 'Variables/flat.md', actual: 'z' } } }));
        let reloads = 0;
        const ok = await saveVarsEdit(engineFile(FLAT, 'h1'), payload([{ heading: '', pairs: [] }]), () => { reloads++; });
        assert.strictEqual(ok, false);
        assert.strictEqual(reloads, 1);
        assert.strictEqual(sent().length, 1);
    });

    test('unrepresentable: toast, false, no invented heading', async () => {
        eng().fake.on('artifact.update', () => ({ error: { code: 'artifact.unrepresentable', params: { field: 'blocks', reason: 'round_trip' } } }));
        const ok = await saveVarsEdit(engineFile(FLAT, 'h1'), payload([{ heading: '', pairs: [] }, { heading: 'B', pairs: [] }]));
        assert.strictEqual(ok, false);
        assert.strictEqual(sent().length, 1);
        assert.deepStrictEqual(sent()[0].model.blocks?.map(b => b.heading), ['', 'B']);
        assert.strictEqual(eng().toasts.length, 1);
    });

    test('file without engine meta: false, zero requests', async () => {
        const ok = await saveVarsEdit(parseFromContent(FLAT, '/v/Variables/flat.md', '/v/Variables'), payload([{ heading: '', pairs: [] }]));
        assert.strictEqual(ok, false);
        assert.strictEqual(eng().fake.received.length, 0);
    });
});

suite('var-set form panel — closes only when the write succeeded (Q2)', () => {
    const wire = { command: 'save', payload: { title: 't', description: '', tags: [], pairs: [[['VK-a', '1']]], headings: [''], descriptions: [''] } };
    const base: VarsEditPayload = payload([{ heading: '', pairs: [['VK-a', '1']] }]);
    const bag = (ok: boolean): { cb: VarSetFormCallbacks; closed: () => number } => {
        let closed = 0;
        return {
            closed: () => closed,
            cb: { validate: () => ({ ok: true }), write: async () => ok, post: () => {}, close: () => { closed++; }, writeEdit: async () => ok },
        };
    };

    for (const [mode, msg] of [['edit', wire], ['create', { command: 'save', payload: { title: 't', description: '', tags: [], pairs: [['VK-a', '1']] } }]] as const) {
        test(`${mode}: false keeps the form open`, async () => {
            const b = bag(false);
            await handleVarSetFormMessage(msg, b.cb, mode, base);
            assert.strictEqual(b.closed(), 0);
        });
        test(`${mode}: true closes it`, async () => {
            const b = bag(true);
            await handleVarSetFormMessage(msg, b.cb, mode, base);
            assert.strictEqual(b.closed(), 1);
        });
    }
});
