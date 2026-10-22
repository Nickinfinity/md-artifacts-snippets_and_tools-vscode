import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { captureExplorerFile } from '../src/commands/capture/explorer.capture.js';
import type { PrefillFn } from '../src/commands/capture/editor.capture.js';
import { createFakeEngine, loadOpCases } from './fake-engine.js';
import { requestOrNotify, startEngine } from '../src/engine/engine.vscode.js';
import type { EngineModel } from '../src/types/engine.types.js';

/**
 * 🔒 A workspace file name becomes `target:` / `extension:` and, downstream, a file on disk. The engine
 * rejects hostile names (op cases `file_injection`, `file_subpath`: `naming.path_injection`); the capture
 * must send them untrimmed and return `undefined` on refusal. Removed with the TS validator
 * (`fileNameForType`), now engine-held: ../ traversal, absolute, sub/b.ts, drive-letter, NUL, control char,
 * `./x`, `x/` -> `file_injection` + `file_subpath`.
 */

const reply = (name: string): EngineModel =>
    loadOpCases().find(c => c.method === 'artifact.prefill' && c.name === name)!.expect as EngineModel;

suite('captureExplorerFile', () => {
    const handles: { dispose(): void }[] = [];
    teardown(() => handles.splice(0).forEach(h => h.dispose()));

    test('AIAgentsConfig: sends the verbatim name; target comes from the reply', async () => {
        const sent: unknown[] = [];
        const result = await captureExplorerFile(
            { fileName: 'CLAUDE.md', contents: 'rules', languageId: 'markdown' }, 'AIAgentsConfig',
            async p => { sent.push(p); return reply('file_agent'); },
        );
        assert.deepStrictEqual(sent, [{ source: 'file', type: 'AIAgentsConfig', text: 'rules', languageId: 'markdown', fileName: 'CLAUDE.md' }]);
        assert.strictEqual(result?.source, 'file');
        assert.strictEqual(result?.prefill.target, 'CLAUDE.md');
    });

    test('Template: extension comes from the reply', async () => {
        const result = await captureExplorerFile(
            { fileName: 'Button.tsx', contents: 'x', languageId: 'typescriptreact' }, 'Template',
            async () => reply('file_template'),
        );
        assert.strictEqual(result?.prefill.extension, 'tsx');
        assert.strictEqual(result?.prefill.blocks?.[0]?.language, 'tsx');
    });

    test('hostile name: engine answers naming.path_injection -> undefined, one toast, name sent untrimmed', async () => {
        const fake = createFakeEngine();
        fake.on('artifact.prefill', () => ({ error: { code: 'naming.path_injection', params: { field: 'fileName' } } }));
        const toasts: string[] = [];
        handles.push(startEngine({ spawn: () => fake, enginePath: process.execPath, showError: async m => { toasts.push(m); return undefined; } }));
        const result = await captureExplorerFile(
            { fileName: '../../etc/passwd', contents: 'x', languageId: 'plaintext' }, 'AIAgentsConfig',
            p => requestOrNotify('artifact.prefill', p),
        );
        assert.strictEqual(result, undefined);
        assert.strictEqual(toasts.length, 1);
        const sent = fake.received.filter(r => r.method === 'artifact.prefill');
        assert.strictEqual(sent.length, 1);
        assert.strictEqual((sent[0]!.params as { fileName: string }).fileName, '../../etc/passwd');
    });

    test('captureExplorerUri no longer toasts a second "cannot be used as an artifact filename" and awaits the capture', () => {
        const src = fs.readFileSync(`${__dirname}/../../src/commands/create-from-surface.command.ts`, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!src.includes('cannot be used as an artifact filename'));
        assert.ok(!/const captured\s*=\s*captureExplorerFile/.test(src));
    });

    // H3.0f (W3): only a refused EXPLORER capture skips the form — an empty selection or terminal
    // still opens an empty form (HEAD behaviour), never a silent dead click.
    test('a refused explorer capture opens no form; editor/terminal still open one', () => {
        const src = fs.readFileSync(`${__dirname}/../../src/commands/create-from-surface.command.ts`, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const open = src.indexOf("openArtifactFormPanel(context, { mode: 'create'");
        const guard = src.indexOf("if (!result && surface === 'explorer')");
        assert.ok(open > 0 && guard > 0 && guard < open, "if (!result && surface === 'explorer') { return; } must precede openArtifactFormPanel");
        assert.ok(!/if \(!result\)\s*\{\s*return;\s*\}/.test(src), 'an unscoped guard silences empty editor/terminal captures');
    });

    test('rejects an oversized file (> 512 KiB) with no request', async () => {
        let sent = 0;
        const result = await captureExplorerFile(
            { fileName: 'CLAUDE.md', contents: 'a'.repeat(512 * 1024 + 1), languageId: 'markdown' }, 'AIAgentsConfig',
            async () => { sent++; return reply('file_agent'); },
        );
        assert.strictEqual(result, undefined);
        assert.strictEqual(sent, 0);
    });

    test('accepts a file at exactly the 512 KiB boundary', async () => {
        const result = await captureExplorerFile(
            { fileName: 'CLAUDE.md', contents: 'a'.repeat(512 * 1024), languageId: 'markdown' }, 'AIAgentsConfig',
            async () => reply('file_agent'),
        );
        assert.strictEqual(result?.source, 'file');
    });
});
