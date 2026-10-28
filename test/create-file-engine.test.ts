import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { askFileName, runCreateFileFlow, type CreateFileIo } from '../src/ui/panels/artifactPicker/preview.createFile.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';
import type { EngineArtifact, EngineErrorData } from '../src/types/engine.types.js';

/**
 * T3.8 — Create File sends `artifact.write_file`; every rule (naming, containment, existing file)
 * is the engine's. Sinks asserted: requests received, prompts shown, the temp workspace's listing.
 */

const CASES = path.join(__dirname, '../../test/fixtures/engine/op-cases/artifact.write_file');
const caseJson = (n: string): { params: Record<string, string> } => JSON.parse(fs.readFileSync(path.join(CASES, `${n}.json`), 'utf8'));

/** A Template as the navigator holds it after `toParsedArtifactFile`. */
function template(over: Partial<ParsedArtifactFile> = {}): ParsedArtifactFile {
    return {
        filePath: '/v/Templates/component.md', fileName: 'component', relativePath: 'component.md',
        frontmatter: { artifactType: 'Template' }, code: 'x <VK-a>', vars: [], blocks: [],
        relPath: 'Templates/component.md', hash: 'h1', ...over,
    } as ParsedArtifactFile;
}

suite('Create File → artifact.write_file', () => {
    let fake: FakeEngine;
    let dispose: () => void;
    let ws: string;
    let wsUri: vscode.Uri;
    let asked: string[];
    let collisions: number;
    let collisionAnswer: 'overwrite' | 'rename' | undefined;
    const toasts: string[] = [];

    const io = (): CreateFileIo => ({
        getWorkspaceFolder: () => wsUri,
        askFileName: async d => { asked.push(d); return asked.length === 1 ? 'Button.tsx' : 'Other.tsx'; },
        pickCollision: async () => { collisions++; return collisionAnswer; },
    });
    const writes = (): { params: Record<string, unknown> }[] => fake.received.filter(r => r.method === 'artifact.write_file') as { params: Record<string, unknown> }[];
    const run = (dest: vscode.Uri | undefined, over: Partial<ParsedArtifactFile> = {}, code = 'x <VK-a>', blockRef?: { kind: 'multi'; heading: string }) =>
        runCreateFileFlow({ artifact: template(over), code, vars: { 'VK-a': '1' }, destDir: dest, destUri: undefined, openAfterWrite: false, ...(blockRef ? { blockRef } : {}) }, io());

    setup(() => {
        ws = fs.mkdtempSync(path.join(os.tmpdir(), 'create-file-engine-'));
        wsUri = vscode.Uri.file(ws);
        asked = []; collisions = 0; collisionAnswer = undefined; toasts.length = 0;
        fake = createFakeEngine();
        const h = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: m => { toasts.push(m); return Promise.resolve(undefined); } });
        setSessionVault('/v');
        dispose = () => { setSessionVault(undefined); h.dispose(); };
        fake.on('artifact.write_file', p => ({ result: { path: path.posix.join((p as { destDir: string }).destDir, (p as { fileName: string }).fileName), hash: 'new', warnings: [] } }));
    });
    teardown(() => { dispose(); fs.rmSync(ws, { recursive: true, force: true }); });

    test('🔒 workspaceRoot is the workspace folder fsPath; destDir is POSIX-relative', async () => {
        fs.mkdirSync(path.join(ws, 'out', 'deep'), { recursive: true });
        const r = await run(vscode.Uri.file(path.join(ws, 'out', 'deep')));
        assert.strictEqual(r.kind, 'written');
        assert.strictEqual(writes().length, 1);
        assert.strictEqual(writes()[0].params['workspaceRoot'], ws);
        assert.strictEqual(writes()[0].params['destDir'], 'out/deep');
        assert.strictEqual(writes()[0].params['path'], 'Templates/component.md');
        assert.deepStrictEqual(writes()[0].params['values'], { 'VK-a': '1' });
    });

    test('dest === workspace root ⇒ destDir "" and one write_file', async () => {
        const r = await run(wsUri);
        assert.strictEqual(r.kind, 'written');
        assert.strictEqual(writes().length, 1);
        assert.strictEqual(writes()[0].params['destDir'], '');
    });

    test('multi-block agent config, block 2 ⇒ write_file.block === 1', async () => {
        const rel = 'AIAgentsConf/multi.md';
        const read = { filePath: rel, fileName: 'multi', relativePath: 'multi.md', frontmatter: { artifactType: 'AIAgentsConfig' }, code: '', vars: [], hash: 'h',
            blocks: [{ heading: 'One', description: '', code: 'a', vars: [] }, { heading: 'Two', description: '', code: 'b', vars: [] }] } as unknown as EngineArtifact;
        fake.on('artifact.read', () => ({ result: read }));
        const r = await run(wsUri, { relPath: rel, frontmatter: { artifactType: 'AIAgentsConfig', target: 'CLAUDE.md' } } as Partial<ParsedArtifactFile>, 'x <VK-a>', { kind: 'multi', heading: 'Two' });
        assert.strictEqual(r.kind, 'written');
        assert.strictEqual(writes()[0].params['block'], 1);
    });

    test('🔒 hostile name: naming.path_injection ⇒ one write_file, no re-prompt, workspace listing unchanged', async () => {
        const err: EngineErrorData = { code: 'naming.path_injection', params: { field: 'fileName' } };
        fake.on('artifact.write_file', () => ({ error: err }));
        const before = fs.readdirSync(ws);
        const r = await run(wsUri);
        assert.notStrictEqual(r.kind, 'written');
        assert.strictEqual(writes().length, 1, 'exactly one write_file');
        assert.strictEqual(asked.length, 1, 'zero re-prompts');
        assert.strictEqual(collisions, 0);
        assert.deepStrictEqual(fs.readdirSync(ws), before);
        assert.strictEqual(toasts.length, 1, 'the W1 toast, once');
    });

    test('file.exists{actual} + Overwrite ⇒ second write_file carries expectedHash: actual', async () => {
        const actual = caseJson('ok_overwrite').params['expectedHash'];
        let n = 0;
        fake.on('artifact.write_file', p => (n++ === 0
            ? { error: { code: 'file.exists', params: { path: 'Button.tsx', actual } } }
            : { result: { path: 'Button.tsx', hash: 'n', warnings: [], echo: p } }));
        collisionAnswer = 'overwrite';
        const r = await run(wsUri);
        assert.strictEqual(r.kind, 'written');
        assert.strictEqual(writes().length, 2);
        assert.strictEqual(writes()[0].params['expectedHash'], undefined);
        assert.strictEqual(writes()[1].params['expectedHash'], actual);
    });

    test('file.exists + Cancel ⇒ no second write_file', async () => {
        fake.on('artifact.write_file', () => ({ error: { code: 'file.exists', params: { actual: 'a' } } }));
        const r = await run(wsUri);
        assert.strictEqual(r.kind, 'cancelled');
        assert.strictEqual(writes().length, 1);
    });

    test('🔒 destination outside the workspace ⇒ zero write_file', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'create-file-outside-'));
        try {
            const r = await run(vscode.Uri.file(outside));
            assert.notStrictEqual(r.kind, 'written');
            assert.strictEqual(writes().length, 0);
        } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    });

    test('W3-c: a staged code edit ⇒ zero write_file; an unedited preview ⇒ exactly one', async () => {
        const edited = await run(wsUri, {}, 'x <VK-a> edited');
        assert.notStrictEqual(edited.kind, 'written');
        assert.strictEqual(writes().length, 0);
        assert.strictEqual(asked.length, 0, 'refused before any prompt');
        const plain = await run(wsUri);
        assert.strictEqual(plain.kind, 'written');
        assert.strictEqual(writes().length, 1);
    });

    test('🔒 an engine-returned path that escapes the workspace ⇒ error + toast, nothing opened', async () => {
        fake.on('artifact.write_file', () => ({ result: { path: '../escape.txt', hash: 'n', warnings: [] } }));
        const r = await runCreateFileFlow({ artifact: template(), code: 'x <VK-a>', vars: {}, destDir: wsUri, destUri: undefined, openAfterWrite: true }, io());
        assert.strictEqual(r.kind, 'error');
        assert.strictEqual(toasts.length, 1);
    });
});

suite('Create File — file-name prompt', () => {
    test('askFileName shows no validateInput: naming is the engine\'s refusal on write_file', async () => {
        const orig = vscode.window.showInputBox;
        let opts: vscode.InputBoxOptions | undefined;
        Object.assign(vscode.window, { showInputBox: async (o?: vscode.InputBoxOptions) => { opts = o; return 'a.ts'; } });
        try {
            assert.strictEqual(await askFileName('Button.tsx'), 'a.ts');
        } finally { Object.assign(vscode.window, { showInputBox: orig }); }
        assert.ok(opts, 'showInputBox was called');
        assert.strictEqual(opts.validateInput, undefined);
        assert.strictEqual(opts.value, 'Button.tsx');
    });

    test('regression net (green both sides): an engine naming.reserved refusal ⇒ one toast, cancelled, exactly one write_file', async () => {
        const fake = createFakeEngine();
        const toasts: string[] = [];
        const h = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: m => { toasts.push(m); return Promise.resolve(undefined); } });
        setSessionVault('/v');
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'create-file-naming-'));
        try {
            fake.on('artifact.write_file', () => ({ error: { code: 'naming.reserved', params: { name: 'CON' } } }));
            const r = await runCreateFileFlow({ artifact: template(), code: 'x <VK-a>', vars: {}, destDir: vscode.Uri.file(ws), destUri: undefined, openAfterWrite: false }, {
                getWorkspaceFolder: () => vscode.Uri.file(ws), askFileName: async () => 'CON', pickCollision: async () => undefined,
            });
            assert.strictEqual(r.kind, 'cancelled');
            assert.strictEqual(toasts.length, 1);
            assert.strictEqual(fake.received.filter(x => x.method === 'artifact.write_file').length, 1);
        } finally { setSessionVault(undefined); h.dispose(); fs.rmSync(ws, { recursive: true, force: true }); }
    });
});
