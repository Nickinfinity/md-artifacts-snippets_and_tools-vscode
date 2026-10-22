import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { runCreateIndex } from '../src/ui/views/createIndexRunner.js';
import { loadOpCases } from './fake-engine.js';
import { startVarsEngine, VAULT, type VarsEngine } from './vars-engine.js';

/**
 * T3.9 — `runCreateIndex` sends ONE `index.create` (the engine writes siblings + index, dedupes names,
 * and reports exists as per-step skips). Driven through the fake engine seeded from the op cases.
 */

const opCase = (name: string) => {
    const c = loadOpCases().find(x => x.method === 'index.create' && x.name === name);
    assert.ok(c, `op case index.create/${name}`);
    return c;
};

suite('runCreateIndex', () => {
    let eng: VarsEngine;
    setup(() => { eng = startVarsEngine(); });
    teardown(() => eng.dispose());

    const run = (pick: () => Promise<vscode.Uri | undefined>, paths = ['a.ts', 'sub/b.ts']) =>
        runCreateIndex({ type: 'Template', paths }, { vaultRoot: VAULT, pickDest: pick });

    test('one index.create with the vault-relative dir; tally from the Batch', async () => {
        const c = opCase('ok');
        eng.fake.on('index.create', () => ({ result: c.expect }));
        const p = c.params as { dir: string; paths: string[]; type: 'Template' };
        const { tally, message } = await run(async () => vscode.Uri.joinPath(VAULT, p.dir), p.paths);
        assert.deepStrictEqual(eng.calls('index.create').map(r => r.params), [p]);
        assert.strictEqual(eng.calls('index.create').length, 1);
        assert.deepStrictEqual(tally, { written: 5, skipped: 0, aborted: false });
        assert.ok(message.startsWith('Create index:'), message);
    });

    test('cancelled pick — aborted, zero requests', async () => {
        const { tally } = await run(async () => undefined);
        assert.deepStrictEqual(tally, { written: 0, skipped: 0, aborted: true });
        assert.strictEqual(eng.fake.received.filter(r => r.method === 'index.create').length, 0);
    });

    test('pick outside the vault — aborted, zero requests', async () => {
        const { tally } = await run(async () => vscode.Uri.file('/somewhere-else'));
        assert.deepStrictEqual(tally, { written: 0, skipped: 0, aborted: true });
        assert.strictEqual(eng.fake.received.filter(r => r.method === 'index.create').length, 0);
    });

    test('vault root picked — dir is empty string', async () => {
        eng.fake.on('index.create', () => ({ result: { results: [], written: 0, skipped: 0 } }));
        await run(async () => VAULT);
        assert.strictEqual((eng.calls('index.create')[0].params as { dir: string }).dir, '');
    });

    test('collision result — one summary, skipped 2', async () => {
        const c = opCase('collision');
        eng.fake.on('index.create', () => ({ result: c.expect }));
        const { tally } = await run(async () => vscode.Uri.joinPath(VAULT, 'Templates'), ['edit.ts']);
        assert.deepStrictEqual(tally, { written: 0, skipped: 2, aborted: false });
        assert.strictEqual(eng.calls('index.create').length, 1);
    });

    test('engine error — toast, nothing counted as written', async () => {
        eng.fake.on('index.create', () => ({ error: { code: 'path.bad_dir', params: { path: 'x' } } }));
        const { tally } = await run(async () => vscode.Uri.joinPath(VAULT, 'Templates'));
        assert.deepStrictEqual(tally, { written: 0, skipped: 0, aborted: true });
        assert.strictEqual(eng.toasts.length, 1);
    });
});
