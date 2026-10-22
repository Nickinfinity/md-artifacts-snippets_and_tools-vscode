import * as assert from 'node:assert';
import type * as vscode from 'vscode';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { handleWriteError, sendWrite } from '../src/services/conflict.service.js';
import { setConfirmSink } from '../src/services/confirm.service.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { engineErrorMessage } from '../src/engine/errors.js';
import type { EngineParams } from '../src/types/engine.types.js';

// T3.2: conflict / exists UX. Each rejection asserts the sink (requests the fake saw).
suite('conflict.service', () => {
    let fake: FakeEngine, handle: vscode.Disposable;
    let toasts: string[], modals: string[], answer: boolean;
    const count = (m: string): number => fake.received.filter(r => r.method === m).length;
    const err = (code: string, params: Record<string, string>) => () => ({ error: { code, params } });
    const model = { artifactType: 'Template', title: 'x', blocks: [{ code: 'y' }] } as EngineParams<'artifact.create'>['model'];

    setup(() => {
        fake = createFakeEngine();
        toasts = []; modals = []; answer = true;
        handle = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: m => { toasts.push(m); return Promise.resolve(undefined); } });
        setSessionVault('/v');
        setConfirmSink(async o => { modals.push(o.message); return answer; });
    });
    teardown(() => { setConfirmSink(undefined); setSessionVault(undefined); handle.dispose(); });

    test('conflict: modal, Reload runs onReload once, update sent once, result undefined', async () => {
        fake.on('artifact.update', err('file.conflict', { path: 'Templates/edit.md', expected: '0', actual: 'a6' }));
        let reloads = 0;
        const r = await sendWrite('artifact.update', { path: 'Templates/edit.md', expectedHash: '0', model }, { onReload: () => { reloads++; } });
        assert.strictEqual(r, undefined);
        assert.strictEqual(reloads, 1);
        assert.strictEqual(count('artifact.update'), 1);
        assert.deepStrictEqual(modals, ['"edit.md" changed on disk since it was opened.']);
    });

    test('conflict + Cancel: no reload', async () => {
        answer = false;
        fake.on('artifact.update', err('file.conflict', { path: 'a.md' }));
        let reloads = 0;
        await sendWrite('artifact.update', { path: 'a.md', expectedHash: '0', model }, { onReload: () => { reloads++; } });
        assert.strictEqual(reloads, 0);
        assert.strictEqual(count('artifact.update'), 1);
    });

    test('create exists: confirm re-sends update with actual hash and same model; decline sends none', async () => {
        const actual = 'a66d1d83245274487be8b44f84ec7473fe570749f520aec0dbe145e004ed483f';
        fake.on('artifact.create', err('file.exists', { path: 'Templates/edit.md', actual }));
        fake.on('artifact.update', () => ({ result: { path: 'Templates/edit.md', hash: 'h' } }));
        await sendWrite('artifact.create', { path: 'Templates/edit.md', model });
        const upd = fake.received.filter(r => r.method === 'artifact.update');
        assert.strictEqual(upd.length, 1);
        assert.deepStrictEqual(upd[0]?.params, { path: 'Templates/edit.md', expectedHash: actual, model });

        answer = false;
        await sendWrite('artifact.create', { path: 'Templates/edit.md', model });
        assert.strictEqual(count('artifact.update'), 1);
    });

    test('create exists without actual: toast only, no modal, no update', async () => {
        fake.on('artifact.create', err('file.exists', { path: 'Templates/edit.md' }));
        await sendWrite('artifact.create', { path: 'Templates/edit.md', model });
        assert.strictEqual(modals.length, 0);
        assert.strictEqual(toasts.length, 1);
        assert.strictEqual(count('artifact.update'), 0);
    });

    test('exists on varsets.save: toast, zero follow-up requests', async () => {
        fake.on('varsets.save', err('file.exists', { path: 'Variables/a.md', actual: 'z' }));
        await sendWrite('varsets.save', { title: 't' });
        assert.strictEqual(fake.received.filter(r => r.method === 'varsets.save').length, 1);
        assert.strictEqual(count('artifact.update'), 0);
        assert.strictEqual(toasts.length, 1);
        assert.strictEqual(modals.length, 0);
    });

    test('other engine error: one toast with engineErrorMessage text', async () => {
        const data = { code: 'vars.var_not_found', params: { name: 'VK-x' } };
        fake.on('vars.var.rename', () => ({ error: data }));
        await sendWrite('vars.var.rename', { path: 'Variables/a.md', expectedHash: 'h', name: 'VK-x', newName: 'VK-y' });
        assert.deepStrictEqual(toasts, [engineErrorMessage(data)]);
        assert.strictEqual(modals.length, 0);
    });

    test('non-engine throw rejects, no toast, no modal', async () => {
        await assert.rejects(handleWriteError(new TypeError('boom')), TypeError);
        assert.strictEqual(toasts.length + modals.length, 0);
    });
});
