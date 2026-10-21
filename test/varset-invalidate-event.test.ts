import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { VarSetScanner } from '../src/services/varset.service.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { createFakeEngine } from './fake-engine.js';

/**
 * Covers T0.2 — `VarSetScanner.invalidate()` must announce itself via
 * `onDidInvalidate` so subscribers (the Variables tree view) can re-render
 * instead of going stale until a window reload.
 */

suite('VarSetScanner.onDidInvalidate', () => {

    let handle: vscode.Disposable;

    setup(() => {
        const fake = createFakeEngine();
        fake.on('vars.list', () => ({ result: { files: [{ path: 'Variables/dev.md', name: 'dev', shape: 'blank', subsets: [] }] } }));
        handle = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: () => Promise.resolve(undefined) });
        setSessionVault('/v');
    });
    teardown(() => { setSessionVault(undefined); handle.dispose(); });

    test('invalidate() fires onDidInvalidate exactly once', () => {
        const scanner = new VarSetScanner();
        let fired = 0;
        scanner.onDidInvalidate(() => { fired++; });

        scanner.invalidate();

        assert.strictEqual(fired, 1, 'invalidate() cleared the cache without telling anyone');
    });

    test('invalidate() both re-reads from disk and fires the event — the two facts cannot drift apart', async () => {
        const scanner = new VarSetScanner();
        let fired = 0;
        scanner.onDidInvalidate(() => { fired++; });

        const first = await scanner.scan(vscode.Uri.file('/v/Variables'));

        scanner.invalidate();
        assert.strictEqual(fired, 1, 'event must fire on invalidate()');

        const second = await scanner.scan(vscode.Uri.file('/v/Variables'));

        assert.strictEqual(second.length, first.length);
        assert.notStrictEqual(second[0], first[0], 'invalidate should force a re-read — references must differ');
    });

});
