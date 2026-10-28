import * as assert from 'node:assert';
import { saveVarsEdit } from '../src/commands/open-vars-edit.helpers.js';
import { writeVarSetFromForm } from '../src/ui/panels/artifactPicker/varSetController.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { handleVarSetFormMessage, type VarSetFormCallbacks } from '../src/ui/panels/varsetForm/varsetForm.panel.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';
import type { EngineParams } from '../src/types/engine.types.js';
import type { VarsEditPayload } from '../src/types/varset.types.js';
import { useVarsEngine } from './vars-engine.js';
import { recordedRead } from './recorded.js';

// T3.6: the Variable Set editor saves through artifact.update with the read's hash.
/** The file as the engine read it (recorded `ve-flat`); served at `Variables/flat.md` with a known hash. */
const engineFile = (hash: string): ParsedArtifactFile =>
    Object.assign(toParsedArtifactFile(recordedRead('ve-flat'), '/v'), { relPath: 'Variables/flat.md', hash });

const payload = (subSets: VarsEditPayload['subSets']): VarsEditPayload =>
    ({ title: 'Flat', description: '', tags: [], subSets });

suite('saveVarsEdit — artifact.update through the engine', () => {
    const eng = useVarsEngine();
    const sent = () => eng().calls('artifact.update').map(c => c.params as EngineParams<'artifact.update'>);

    test('untitled one-block set: one block, heading "", read hash + path sent', async () => {
        eng().fake.on('artifact.update', () => ({ result: { path: 'Variables/flat.md', hash: 'n' } }));
        const ok = await saveVarsEdit(engineFile('h1'), payload([{ heading: '', pairs: [['VK-host', 'localhost']] }]));
        assert.strictEqual(ok, true);
        assert.strictEqual(sent().length, 1);
        assert.strictEqual(sent()[0].path, 'Variables/flat.md');
        assert.strictEqual(sent()[0].expectedHash, 'h1');
        assert.strictEqual(sent()[0].model.blocks?.length, 1);
        assert.strictEqual(sent()[0].model.blocks?.[0].heading, '');
    });

    test('two sub-sets: headings in posted order', async () => {
        eng().fake.on('artifact.update', () => ({ result: { path: 'Variables/flat.md', hash: 'n' } }));
        await saveVarsEdit(engineFile('h1'), payload([
            { heading: 'Prod', description: '', pairs: [['VK-a', '1']] },
            { heading: 'Dev', description: '', pairs: [['VK-a', '2']] },
        ]));
        assert.deepStrictEqual(sent()[0].model.blocks?.map(b => b.heading), ['Prod', 'Dev']);
    });

    test('conflict: modal, false, exactly one update', async () => {
        eng().fake.on('artifact.update', () => ({ error: { code: 'file.conflict', params: { path: 'Variables/flat.md', actual: 'z' } } }));
        const ok = await saveVarsEdit(engineFile('h1'), payload([{ heading: '', pairs: [] }]));
        assert.strictEqual(ok, false);
        assert.strictEqual(sent().length, 1);
        assert.strictEqual(eng().modals.length, 1);
    });

    test('conflict + Reload: onReload called once, no second update', async () => {
        eng().fake.on('artifact.update', () => ({ error: { code: 'file.conflict', params: { path: 'Variables/flat.md', actual: 'z' } } }));
        let reloads = 0;
        const ok = await saveVarsEdit(engineFile('h1'), payload([{ heading: '', pairs: [] }]), () => { reloads++; });
        assert.strictEqual(ok, false);
        assert.strictEqual(reloads, 1);
        assert.strictEqual(sent().length, 1);
    });

    test('unrepresentable: toast, false, no invented heading', async () => {
        eng().fake.on('artifact.update', () => ({ error: { code: 'artifact.unrepresentable', params: { field: 'blocks', reason: 'round_trip' } } }));
        const ok = await saveVarsEdit(engineFile('h1'), payload([{ heading: '', pairs: [] }, { heading: 'B', pairs: [] }]));
        assert.strictEqual(ok, false);
        assert.strictEqual(sent().length, 1);
        assert.deepStrictEqual(sent()[0].model.blocks?.map(b => b.heading), ['', 'B']);
        assert.strictEqual(eng().toasts.length, 1);
    });

    test('file without engine meta: false, zero requests', async () => {
        const { relPath: _r, hash: _h, ...bare } = engineFile('h1') as ParsedArtifactFile & { relPath: string; hash: string };
        const ok = await saveVarsEdit(bare, payload([{ heading: '', pairs: [] }]));
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
            cb: { write: async () => ok, post: () => {}, close: () => { closed++; }, writeEdit: async () => ok },
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

suite('var-set create form — title rule is the engine\'s (varsets.save)', () => {
    const eng = useVarsEngine();
    test('blank title: exactly one varsets.save, vars.bad_title toast, write false (form stays open)', async () => {
        eng().fake.on('varsets.save', () => ({ error: { code: 'vars.bad_title', params: {} } }));
        const ok = await writeVarSetFromForm({ title: '  ', description: '', tags: [], pairs: [['VK-a', '1']] });
        assert.strictEqual(ok, false);
        assert.strictEqual(eng().calls('varsets.save').length, 1);
        assert.strictEqual(eng().toasts.length, 1);
    });
});
