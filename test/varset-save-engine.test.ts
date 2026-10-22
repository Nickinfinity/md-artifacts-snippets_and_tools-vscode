import * as assert from 'node:assert';
import { writeVarSetFromForm } from '../src/ui/panels/artifactPicker/varSetController.js';
import { getVarSetScanner } from '../src/ui/panels/varsetPicker.panel.js';
import { useVarsEngine } from './vars-engine.js';

// T3.6 (ex T3.12): save-as goes through varsets.save; an existing set is never overwritten.
suite('writeVarSetFromForm — varsets.save through the engine', () => {
    const eng = useVarsEngine();
    let invalidated = 0;
    let orig: () => void;
    setup(() => {
        invalidated = 0;
        const s = getVarSetScanner();
        orig = s.invalidate.bind(s);
        s.invalidate = () => { invalidated++; };
    });
    teardown(() => { getVarSetScanner().invalidate = orig; });

    const payload = { title: 'Local Dev', description: '', tags: ['env'], pairs: [['VK-a', ''], ['VK-host', 'localhost']] as [string, string][] };

    test('ok: params match op case varsets.save/ok, invalidate once, true', async () => {
        eng().fake.on('varsets.save', () => ({ result: { path: 'Variables/local-dev.md', hash: 'c764' } }));
        assert.strictEqual(await writeVarSetFromForm(payload), true);
        assert.deepStrictEqual(eng().calls('varsets.save').map(c => c.params), [
            { title: 'Local Dev', tags: ['env'], values: { 'VK-a': '', 'VK-host': 'localhost' } },
        ]);
        assert.strictEqual(invalidated, 1);
    });

    test('a non-empty description is sent', async () => {
        eng().fake.on('varsets.save', () => ({ result: { path: 'Variables/local-dev.md', hash: 'c764' } }));
        await writeVarSetFromForm({ ...payload, description: ' dev box ' });
        assert.strictEqual((eng().calls('varsets.save')[0].params as { description?: string }).description, 'dev box');
    });

    test('file.exists: one request, no update, no invalidate, false', async () => {
        eng().fake.on('varsets.save', () => ({ error: { code: 'file.exists', params: { path: 'Variables/local-dev.md' } } }));
        assert.strictEqual(await writeVarSetFromForm(payload), false);
        assert.strictEqual(eng().fake.received.filter(r => r.method === 'varsets.save').length, 1);
        assert.strictEqual(eng().calls('artifact.update').length, 0);
        assert.strictEqual(invalidated, 0);
        assert.strictEqual(eng().toasts.length, 1);
    });
});
