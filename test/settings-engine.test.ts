import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { handleDirToggle } from '../src/ui/panels/settings.panel.js';

suite('settings panel through the engine', () => {
    let tmp: string;
    let handle: vscode.Disposable;
    let toasts: string[];
    const posted: unknown[] = [];
    const panel = { webview: { postMessage: (m: unknown): Thenable<boolean> => { posted.push(m); return Promise.resolve(true); } } };
    let fake: FakeEngine;
    const typeRows = [{ type: 'Snippet', dir: 'Snippets', enabled: false, dirExists: true }, { type: 'Zzz', dir: 'Zzz', enabled: true, dirExists: true }];

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mda-settings-'));
        fs.mkdirSync(path.join(tmp, '.obsidian'));
        fs.mkdirSync(path.join(tmp, 'Snippets'));
        toasts = [];
        fake = createFakeEngine();
        fake.on('types.set_enabled', () => ({ result: { type: 'Snippet', enabled: false, created: false } }));
        fake.on('types.list', () => ({ result: typeRows }));
        handle = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: m => { toasts.push(m); return Promise.resolve(undefined); } });
        setSessionVault(tmp);
    });
    teardown(() => { setSessionVault(undefined); handle.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); });

    test('hostile dirName reaches no engine call; valid toggle sends one, ignores vaultPath, deletes nothing', async () => {
        const sets = () => fake.received.filter(r => r.method === 'types.set_enabled');
        await handleDirToggle(panel, { command: 'dirToggle', vaultPath: '/elsewhere', dirName: '../../etc', isChecked: true });
        assert.strictEqual(sets().length, 0);

        await handleDirToggle(panel, { command: 'dirToggle', vaultPath: '/elsewhere', dirName: 'Snippets', isChecked: false });
        assert.deepStrictEqual(sets().map(r => r.params), [{ type: 'Snippet', enabled: false }]);
        assert.ok(!JSON.stringify(fake.received).includes('/elsewhere'));
        assert.ok(fs.existsSync(path.join(tmp, 'Snippets')));

        // rows: engine-only type dropped, checkbox shows `enabled` (not dirExists)
        const msg = posted.at(-1) as { command: string; dirs: { dir: string; exists: boolean }[] };
        assert.strictEqual(msg.command, 'updateDirs');
        assert.deepStrictEqual(msg.dirs.map(d => [d.dir, d.exists]), [['Snippets', false]]);
        assert.deepStrictEqual(toasts, []);
    });

    test('no session vault: a toggle with a non-empty vaultPath sends nothing', async () => {
        setSessionVault(undefined);
        const before = fake.received.length;
        await handleDirToggle(panel, { command: 'dirToggle', vaultPath: tmp, dirName: 'Snippets', isChecked: true });
        assert.strictEqual(fake.received.length, before);
    });
});
