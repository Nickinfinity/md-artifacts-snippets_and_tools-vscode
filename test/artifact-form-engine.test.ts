import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startVarsEngine, VAULT, type VarsEngine } from './vars-engine.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { setConfirmSink } from '../src/services/confirm.service.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { artifactToFormModel } from '../src/commands/create-prefill.helpers.js';
import { EDIT_ARTIFACT_COMMAND_ID } from '../src/commands/editArtifact.command.js';
import { requestOrNotify } from '../src/engine/engine.vscode.js';
import { deleteWithConfirm, pruneVarsForSave, saveToEngine, type SaveIO } from '../src/ui/panels/artifactForm/panel.helpers.js';
import type { OpenFormOpts } from '../src/ui/panels/artifactForm/panel.js';
import type { EngineRead } from '../src/engine/model.js';
import type { EngineArtifact, EngineModel } from '../src/types/engine.types.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';

const SNIPPET = '---\nartifactType: Snippet\ntitle: Demo\nlanguage: bash\n---\n\n```bash\necho hi\n```\n';
const form = (over: Partial<ArtifactFormModel> = {}): ArtifactFormModel => ({
    artifactType: 'Snippet', title: 'Demo', description: '', tags: [], extension: '', target: '', env: '', provider: '', model: '', version: '',
    blocks: [{ heading: '', description: '', language: 'bash', code: 'echo bye', vars: [] }], ...over,
} as ArtifactFormModel);

// T3.3: form save / edit save / delete go through the engine. Every rejection asserts the sink.
suite('artifact form — engine writes', () => {
    let eng: VarsEngine, answer = true;
    let dirs: string[], notes: string[];
    const count = (m: string): number => eng.fake.received.filter(r => r.method === m).length;
    const io = (dir = path.join(VAULT.fsPath, 'Snippets'), name: string | undefined = 'demo'): SaveIO => ({
        pickDir: root => { dirs.push(root.fsPath); return Promise.resolve(dir === '' ? undefined : vscode.Uri.file(dir)); },
        promptName: () => Promise.resolve(name),
        notify: m => { notes.push(m); },
    });
    const open = async (): Promise<EngineRead> => {
        eng.serve('Snippets/demo.md', SNIPPET);
        const r = await requestOrNotify('artifact.read', { path: 'Snippets/demo.md' });
        assert.ok(r);
        return toParsedArtifactFile(r, VAULT.fsPath);
    };
    const editOpts = (read: EngineRead): OpenFormOpts => ({ mode: 'edit', type: 'Snippet', sourceUri: vscode.Uri.file(read.filePath), read });

    setup(() => { answer = true; dirs = []; notes = []; eng = startVarsEngine(); setConfirmSink(async o => { eng.modals.push(o.message); return answer; }); });
    teardown(() => eng.dispose());

    test('edit save sends exactly one artifact.update carrying the opened read\'s hash', async () => {
        const read = await open();
        eng.fake.on('artifact.update', () => ({ result: { path: 'Snippets/demo.md', hash: 'new' } }));
        assert.strictEqual(await saveToEngine(form(), editOpts(read), () => undefined), true);
        const sent = eng.fake.received.filter(r => r.method === 'artifact.update');
        assert.strictEqual(sent.length, 1);
        const p = sent[0]?.params as { path: string; expectedHash: string };
        assert.strictEqual(p.path, 'Snippets/demo.md');
        assert.strictEqual(p.expectedHash, read.hash);
        assert.strictEqual(p.expectedHash, eng.hashOf(SNIPPET));
    });

    test('stale hash: one modal, Reload runs onReload once, no second update, false', async () => {
        const read = await open();
        eng.fake.on('artifact.update', () => ({ error: { code: 'file.conflict', params: { path: 'Snippets/demo.md', expected: 'a', actual: 'b' } } }));
        let reloads = 0;
        assert.strictEqual(await saveToEngine(form(), editOpts(read), () => { reloads++; }), false);
        assert.strictEqual(count('artifact.update'), 1);
        assert.strictEqual(eng.modals.length, 1);
        assert.strictEqual(reloads, 1);
    });

    test('edit without a read sends nothing', async () => {
        assert.strictEqual(await saveToEngine(form(), { mode: 'edit', type: 'Snippet' }, () => undefined), false);
        assert.strictEqual(eng.fake.received.filter(r => r.method.startsWith('artifact.') && r.method !== 'artifact.read').length, 0);
    });

    test('delete: confirmed sends artifact.delete with the read\'s hash; decline sends zero', async () => {
        const read = await open();
        eng.fake.on('artifact.delete', () => ({ result: { path: 'Snippets/demo.md' } }));
        answer = false;
        assert.strictEqual(await deleteWithConfirm(vscode.Uri.file(read.filePath), read), false);
        assert.strictEqual(count('artifact.delete'), 0);
        answer = true;
        assert.strictEqual(await deleteWithConfirm(vscode.Uri.file(read.filePath), read), true);
        const sent = eng.fake.received.filter(r => r.method === 'artifact.delete');
        assert.deepStrictEqual(sent.map(r => r.params), [{ path: 'Snippets/demo.md', expectedHash: read.hash }]);
    });

    test('delete without a read: no modal, no request', async () => {
        assert.strictEqual(await deleteWithConfirm(vscode.Uri.file('/v/Snippets/demo.md'), undefined), false);
        assert.strictEqual(count('artifact.delete'), 0);
        assert.strictEqual(eng.modals.length, 0);
    });

    test('SEC: unknown model.artifactType from the webview sends nothing and answers false', async () => {
        const bad = form({ artifactType: 'Nope' as ArtifactFormModel['artifactType'] });
        assert.strictEqual(await saveToEngine(bad, { mode: 'create', type: 'Snippet' }, () => undefined, io()), false);
        assert.strictEqual(eng.fake.received.filter(r => r.method === 'artifact.create').length, 0);
        assert.deepStrictEqual(dirs, [], 'picker reached for an unknown type');
        assert.deepStrictEqual(notes, ['Unknown artifact type.'], 'the user was not told');
    });

    test('SEC: model.artifactType !== opts.type builds the path from opts.type', async () => {
        eng.fake.on('artifact.create', () => ({ result: { path: 'Snippets/demo.md', hash: 'h' } }));
        const lying = form({ artifactType: 'Command' });
        assert.strictEqual(await saveToEngine(lying, { mode: 'create', type: 'Snippet' }, () => undefined, io()), true);
        assert.deepStrictEqual(dirs, [path.join(VAULT.fsPath, 'Snippets')]);
        const sent = eng.fake.received.find(r => r.method === 'artifact.create');
        assert.strictEqual((sent?.params as { path: string }).path, 'Snippets/demo.md');
    });

    test('SEC: a destination outside the vault sends nothing', async () => {
        assert.strictEqual(await saveToEngine(form(), { mode: 'create', type: 'Snippet' }, () => undefined, io('/elsewhere')), false);
        assert.strictEqual(count('artifact.create'), 0);
        assert.strictEqual(notes.length, 1);
    });

    test('SEC: the webview cannot retype the artifact — model.artifactType is opts.type on update and create', async () => {
        const read = await open();
        eng.fake.on('artifact.update', () => ({ result: { path: 'Snippets/demo.md', hash: 'n' } }));
        eng.fake.on('artifact.create', () => ({ result: { path: 'Snippets/demo.md', hash: 'h' } }));
        const lying = form({ artifactType: 'Command' });
        await saveToEngine(lying, editOpts(read), () => undefined, io());
        await saveToEngine(lying, { mode: 'create', type: 'Snippet' }, () => undefined, io());
        for (const m of ['artifact.update', 'artifact.create']) {
            const sent = eng.fake.received.find(r => r.method === m);
            assert.strictEqual((sent?.params as { model: { artifactType: string } }).model.artifactType, 'Snippet', m);
        }
    });

    test('no vault on create: one toast, no picker, no request', async () => {
        setSessionVault(undefined);
        assert.strictEqual(await saveToEngine(form(), { mode: 'create', type: 'Snippet' }, () => undefined, io()), false);
        assert.deepStrictEqual(notes, ['Vault not configured.']);
        assert.deepStrictEqual(dirs, []);
    });

    test('create: cancelled picker or prompt sends nothing; exists + decline writes nothing and answers false', async () => {
        assert.strictEqual(await saveToEngine(form(), { mode: 'create', type: 'Snippet' }, () => undefined, io('')), false);
        assert.strictEqual(await saveToEngine(form(), { mode: 'create', type: 'Snippet' }, () => undefined, io(undefined, '')), false);
        assert.strictEqual(count('artifact.create'), 0);
        eng.fake.on('artifact.create', () => ({ error: { code: 'file.exists', params: { path: 'Snippets/demo.md', actual: 'x' } } }));
        answer = false;
        assert.strictEqual(await saveToEngine(form(), { mode: 'create', type: 'Snippet' }, () => undefined, io()), false);
        assert.strictEqual(count('artifact.update'), 0);
    });

    test('handleSave posts saveResult{ok:false} with no error when the write answers false (Save re-enables)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactForm', 'panel.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const at = src.indexOf('private async handleSave');
        const body = src.slice(at, src.indexOf('\n    }\n', at));
        assert.match(body, /\{ command: 'saveResult', ok: false \}/);
        assert.doesNotMatch(body, /error/);
    });
});

// W-UI a: the lossy-edit refusal is gone; the engine refuses every lossy shape itself (artifact.unrepresentable).
suite('edit — flagged / index files open in the form and round-trip', () => {
    let eng: VarsEngine;
    const flagged = (JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/engine/op-cases/artifact.read/flagged.json'), 'utf8')) as { expect: EngineArtifact }).expect;
    const indexRead: EngineArtifact = {
        filePath: 'Templates/index.md', fileName: 'index', relativePath: 'index.md',
        frontmatter: { artifactType: 'Template', title: 'Index', index: true, paths: ['src/components'] },
        code: '1. [[edit]]', vars: [], blocks: [], layout: { payload: 'bare' }, hash: 'h1',
    };
    const noop = (): void => undefined;
    const formTabs = (): number => vscode.window.tabGroups.all.flatMap(g => g.tabs)
        .filter(t => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('artifactForm')).length;
    const waitForTab = async (): Promise<number> => {
        for (let i = 0; i < 40 && formTabs() === 0; i++) { await new Promise(r => setTimeout(r, 50)); }
        return formTabs();
    };
    const edited = (read: EngineRead, over: Partial<ArtifactFormModel>): ArtifactFormModel => {
        const m = { ...artifactToFormModel(read), ...over } as ArtifactFormModel;
        return { ...m, blocks: pruneVarsForSave(m.blocks) };
    };
    const updateParams = (): { expectedHash: string; model: EngineModel } => {
        const sent = eng.fake.received.filter(r => r.method === 'artifact.update');
        assert.strictEqual(sent.length, 1);
        return sent[0]?.params as { expectedHash: string; model: EngineModel };
    };

    setup(async function () {
        this.timeout(10_000);
        // activate() first: a late activation replaces the fake engine and the /v vault.
        await vscode.extensions.all.find(e => e.packageJSON?.name === 'md-artifacts-snippets-and-tools-vscode')?.activate();
        eng = startVarsEngine();
        eng.fake.on('artifact.update', () => ({ result: { path: 'x.md', hash: 'new' } }));
    });
    teardown(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); eng.dispose(); });

    test('a flagged AIPrompt opens the form', async function () {
        this.timeout(10_000);
        eng.fake.on('artifact.read', () => ({ result: flagged }));
        await vscode.commands.executeCommand(EDIT_ARTIFACT_COMMAND_ID, path.join(VAULT.fsPath, 'AIPrompts/flagged.md'));
        assert.strictEqual(await waitForTab(), 1, 'the form did not open for a flagged file');
    });

    test('an index template opens the form', async function () {
        this.timeout(10_000);
        eng.fake.on('artifact.read', () => ({ result: indexRead }));
        await vscode.commands.executeCommand(EDIT_ARTIFACT_COMMAND_ID, path.join(VAULT.fsPath, 'Templates/index.md'));
        assert.strictEqual(await waitForTab(), 1, 'the form did not open for an index file');
    });

    test('flagged save: layout, payload and hash ride the update; only the title changes', async () => {
        const read = toParsedArtifactFile(flagged, VAULT.fsPath);
        const opts: OpenFormOpts = { mode: 'edit', type: 'AIPrompt', sourceUri: vscode.Uri.file(read.filePath), read };
        assert.strictEqual(await saveToEngine(edited(read, { title: 'Flagged v2' }), opts, noop), true);
        const p = updateParams();
        assert.deepStrictEqual(p.model.layout, read.layout);
        assert.strictEqual(p.model.blocks?.[0]?.code, read.code);
        assert.strictEqual(p.model.title, 'Flagged v2');
        assert.strictEqual(p.expectedHash, read.hash);
    });

    test('index save: index, paths and layout ride the update', async () => {
        const read = toParsedArtifactFile(indexRead, VAULT.fsPath);
        const opts: OpenFormOpts = { mode: 'edit', type: 'Template', sourceUri: vscode.Uri.file(read.filePath), read };
        assert.strictEqual(await saveToEngine(edited(read, { description: 'd2' }), opts, noop), true);
        const { model } = updateParams();
        assert.strictEqual(model.index, true);
        assert.deepStrictEqual(model.paths, ['src/components']);
        assert.deepStrictEqual(model.layout, { payload: 'bare' });
    });
});
