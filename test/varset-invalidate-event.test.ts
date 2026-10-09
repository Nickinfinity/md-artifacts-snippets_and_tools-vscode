import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { VarSetScanner } from '../src/services/varset.service.js';

/**
 * Covers T0.2 — `VarSetScanner.invalidate()` must announce itself via
 * `onDidInvalidate` so subscribers (the Variables tree view) can re-render
 * instead of going stale until a window reload.
 */

// ── Test helpers — mirrored from test/varset-scanner.test.ts (:32-34, :45-47,
// :60-74); that file exports nothing, so these are re-spelled inline rather
// than inventing a shared helper module for three stdlib calls. ────────────

function mkTempVarsDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'varset-invalidate-event-test-'));
}

function rmTempVarsDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function writeVarFile(filePath: string, env: string, vars: Record<string, string>): void {
    const lines = [
        '---',
        'artifactType: Variables',
        `env: ${env}`,
        '---',
        '',
        '```vks',
        ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
        '```',
        '',
    ];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

suite('VarSetScanner.onDidInvalidate', () => {

    let tmpDir: string;

    setup(() => { tmpDir = mkTempVarsDir(); });
    teardown(() => { rmTempVarsDir(tmpDir); });

    test('invalidate() fires onDidInvalidate exactly once', () => {
        const scanner = new VarSetScanner();
        let fired = 0;
        scanner.onDidInvalidate(() => { fired++; });

        scanner.invalidate();

        assert.strictEqual(fired, 1, 'invalidate() cleared the cache without telling anyone');
    });

    test('invalidate() both re-reads from disk and fires the event — the two facts cannot drift apart', async () => {
        writeVarFile(path.join(tmpDir, 'dev.md'), 'dev', { KEY: 'a' });

        const scanner = new VarSetScanner();
        let fired = 0;
        scanner.onDidInvalidate(() => { fired++; });

        const first = await scanner.scan(vscode.Uri.file(tmpDir));

        scanner.invalidate();
        assert.strictEqual(fired, 1, 'event must fire on invalidate()');

        const second = await scanner.scan(vscode.Uri.file(tmpDir));

        assert.strictEqual(second.length, first.length);
        assert.notStrictEqual(second[0], first[0], 'invalidate should force a re-read — references must differ');
    });

});
