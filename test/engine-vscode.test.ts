import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { createFakeEngine } from './fake-engine.js';
import { getEngine, requestOrNotify, spawnEngineProcess, startEngine } from '../src/engine/engine.vscode.js';
import { installHint } from '../src/engine/locate.js';

suite('engine.vscode edge', () => {
    const handles: vscode.Disposable[] = [];
    let tmp: string;
    setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mda-edge-')); });
    teardown(() => { handles.splice(0).forEach(h => h.dispose()); fs.rmSync(tmp, { recursive: true, force: true }); });

    test('last startEngine wins; locate failure never spawns; client.unavailable offers Restart', async () => {
        const shown: { msg: string; actions: string[] }[] = [];
        const showError = (msg: string, ...actions: string[]): Thenable<string | undefined> => { shown.push({ msg, actions }); return Promise.resolve(undefined); };
        let spawned = 0;
        const spy = (): never => { spawned++; throw new Error('must not spawn'); };
        handles.push(startEngine({ spawn: spy, enginePath: process.execPath, showError }));
        const bad = path.join(tmp, 'mda');
        fs.writeFileSync(bad, 'x', { mode: 0o644 });
        handles.push(startEngine({ enginePath: bad, spawn: spy, showError }));
        assert.strictEqual(await requestOrNotify('config.get', {}), undefined);
        assert.ok(shown[0]?.msg.includes(installHint(process.platform)), shown[0]?.msg);
        assert.strictEqual(spawned, 0);

        const fake = createFakeEngine();
        fake.on('config.get', () => ({ error: { code: 'client.unavailable', params: {} } }));
        handles.push(startEngine({ spawn: () => fake, enginePath: process.execPath, showError }));
        assert.strictEqual(await requestOrNotify('config.get', {}), undefined);
        assert.ok(shown[1]?.actions.includes('Restart engine'), JSON.stringify(shown[1]));
        assert.doesNotThrow(() => getEngine());
    });

    test('spawnEngineProcess on a missing binary fires onExit exactly once', async () => {
        const proc = spawnEngineProcess('/nonexistent/abs/mda', ['serve']);
        let n = 0;
        proc.onExit(() => { n++; });
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(n, 1);
    });
});
