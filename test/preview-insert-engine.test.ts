import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { engineErrorMessage, engineWarningMessage } from '../src/engine/errors.js';
import { setConfirmSink } from '../src/services/confirm.service.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { PreviewActions, type PreviewActionsCallbacks } from '../src/ui/panels/artifactPicker/preview.actions.js';
import { performInsert, renderForDelivery, type DeliveryIO } from '../src/ui/panels/artifactPicker/preview.insert.js';
import type { BlockRef } from '../src/services/artifact-patcher.service.js';
import type { EngineArtifact, Rendered } from '../src/types/engine.types.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';

/**
 * T4.1 / T4.2 — Insert and Copy render through `artifact.render`; a terminal send of
 * `containsEscape` output is refused (D-11). Sinks asserted: sendText, terminal(), confirm, clipboard, toasts.
 */

const CASES = path.join(__dirname, '../../test/fixtures/engine/op-cases/artifact.render');
const caseJson = (n: string): { params: Record<string, unknown>; expect: Rendered } => JSON.parse(fs.readFileSync(path.join(CASES, `${n}.json`), 'utf8'));
const SINGLE: BlockRef = { kind: 'single' };

function artifact(type = 'Snippet', over: Partial<ParsedArtifactFile> = {}): ParsedArtifactFile {
    return {
        filePath: '/v/Snippets/hello.md', fileName: 'hello', relativePath: 'hello.md',
        frontmatter: { artifactType: type }, code: 'hi <VK-name>', vars: [], blocks: [],
        relPath: 'Snippets/hello.md', hash: 'h1', ...over,
    } as ParsedArtifactFile;
}

suite('Insert / Copy → artifact.render', () => {
    let fake: FakeEngine;
    let dispose: () => void;
    let toasts: string[];
    let sent: { text: string; addNewLine: boolean | undefined }[];
    let terminals: number, confirms: number, confirmAnswer: boolean;
    let warnings: string[], clip: string[], infos: string[];

    const io = (): DeliveryIO => ({
        terminal: () => { terminals++; return { sendText: (text: string, addNewLine?: boolean) => { sent.push({ text, addNewLine }); }, show: () => undefined }; },
        showWarning: m => { warnings.push(m); },
        writeClipboard: t => { clip.push(t); return Promise.resolve(); },
        showInfo: m => { infos.push(m); },
    });
    const renders = (): { params: Record<string, unknown> }[] => fake.received.filter(r => r.method === 'artifact.render') as { params: Record<string, unknown> }[];
    const reads = (): unknown[] => fake.received.filter(r => r.method === 'artifact.read');
    const reply = (output: string, containsEscape = false, w: Rendered['warnings'] = []): void => {
        fake.on('artifact.render', () => ({ result: { output, warnings: w, containsEscape } }));
    };
    const bag = (a: ParsedArtifactFile, surface: 'editor' | 'terminal' = 'editor', blockRef: BlockRef = SINGLE): PreviewActionsCallbacks => ({
        rootFs: '/v', targetEditor: undefined, invocationSurface: surface, batch: { isArmed: false } as never,
        getCurrentArtifact: () => a, setCurrentArtifact: () => undefined, getBlockRef: () => blockRef,
        getModeController: () => undefined, setCache: () => undefined, post: () => undefined,
        dispose: () => undefined, closePicker: () => undefined,
    });

    setup(() => {
        toasts = []; sent = []; terminals = 0; confirms = 0; confirmAnswer = true; warnings = []; clip = []; infos = [];
        fake = createFakeEngine();
        const h = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: m => { toasts.push(m); return Promise.resolve(undefined); } });
        setSessionVault('/v');
        setConfirmSink(() => { confirms++; return Promise.resolve(confirmAnswer); });
        dispose = () => { setConfirmSink(undefined); setSessionVault(undefined); h.dispose(); };
    });
    teardown(() => { dispose(); });

    const renderOf = async (a = artifact(), code = 'x', vars: unknown = {}, ref: BlockRef = SINGLE): Promise<Rendered> => {
        const r = await renderForDelivery(a, code, vars, ref, io());
        assert.ok(r);
        return r;
    };
    const refusal = engineErrorMessage({ code: 'render.contains_escape', params: {} });

    // ── T4.1 ─────────────────────────────────────────────────────────────────

    test('🔒 containsEscape + terminal ⇒ nothing sent, no terminal, no confirm, one localised toast', async () => {
        reply(caseJson('ok_escape').expect.output, true);
        const r = await renderOf();
        await performInsert(undefined, 'Command', r, 'editor', io());
        assert.strictEqual(sent.length, 0);
        assert.strictEqual(terminals, 0);
        assert.strictEqual(confirms, 0);
        assert.deepStrictEqual(toasts, [refusal]);

        // Multi-line AIPrompt from the terminal: the confirm would fire, so order is observable.
        toasts.length = 0;
        const multi: Rendered = { output: 'a\n\x1b[31mb', warnings: [], containsEscape: true };
        await performInsert(undefined, 'AIPrompt', multi, 'terminal', io());
        assert.strictEqual(sent.length, 0);
        assert.strictEqual(terminals, 0);
        assert.strictEqual(confirms, 0);
        assert.deepStrictEqual(toasts, [refusal]);
    });

    test('🔒 paired: containsEscape false ⇒ exactly one sendText', async () => {
        await performInsert(undefined, 'Command', { output: 'ls', warnings: [], containsEscape: false }, 'editor', io());
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(toasts.length, 0);
    });

    test('🔒 staged ESC rides params.code verbatim; extension has no ESC scan of its own', async () => {
        reply('ok');
        await renderOf(artifact(), 'a\x1b[31mb');
        assert.strictEqual(renders()[0].params['code'], 'a\x1b[31mb');
        const src = fs.readFileSync(path.join(__dirname, '../../src/ui/panels/artifactPicker/preview.insert.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/\\x1b|\\u001b|\\x9b|\\u009b/i.test(src), 'preview.insert.ts spells an escape literal');
    });

    test('editor target + containsEscape ⇒ output is inserted', async () => {
        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'plaintext' });
        const editor = await vscode.window.showTextDocument(doc);
        await performInsert(editor, 'Snippet', { output: 'E\x1b[0m', warnings: [], containsEscape: true }, 'editor', io());
        assert.strictEqual(doc.getText(), 'E\x1b[0m');
        assert.strictEqual(toasts.length, 0);
    });

    test('params: single has no block key; typed values pass raw; hostile keys dropped', async () => {
        const c = caseJson('ok_code');
        reply(c.expect.output);
        await renderOf(artifact(), 'hi <VK-name>', { 'VK-name': 'bob' });
        assert.deepStrictEqual(renders()[0].params, c.params);

        const read = { filePath: 'x', fileName: 'multi', relativePath: 'multi.md', frontmatter: { artifactType: 'AIAgentsConfig' }, code: '', vars: [], hash: 'h',
            blocks: [{ heading: 'One', description: '', code: 'a', vars: [] }, { heading: 'Two', description: '', code: 'b', vars: [] }] } as unknown as EngineArtifact;
        fake.on('artifact.read', () => ({ result: read }));
        await renderOf(artifact('AIAgentsConfig', { relPath: 'AIAgentsConf/multi.md' } as never), 'b', {}, { kind: 'multi', heading: 'Two' });
        assert.strictEqual(renders()[1].params['block'], 1);

        await renderOf(artifact(), 'x', JSON.parse('{"VK-name":"","__proto__":"x","n":1}'));
        assert.deepStrictEqual(renders()[2].params['values'], { 'VK-name': '' });
    });

    test('AIPrompt + terminal + multi-line: confirm true ⇒ bracketed paste; false ⇒ nothing', async () => {
        const r: Rendered = { output: 'a\nb', warnings: [], containsEscape: false };
        await performInsert(undefined, 'AIPrompt', r, 'terminal', io());
        assert.deepStrictEqual(sent, [{ text: '\x1b[200~a\nb\x1b[201~', addNewLine: false }]);
        sent.length = 0; confirmAnswer = false;
        await performInsert(undefined, 'AIPrompt', r, 'terminal', io());
        assert.strictEqual(sent.length, 0);
    });

    test('Command stays byte-identical: one sendText, no confirm, no markers', async () => {
        await performInsert(undefined, 'Command', { output: 'echo 1\necho 2', warnings: [], containsEscape: false }, 'editor', io());
        assert.deepStrictEqual(sent, [{ text: 'echo 1\necho 2', addNewLine: false }]);
        assert.strictEqual(confirms, 0);
    });

    test('warnings ⇒ one joined toast, result still returned', async () => {
        const c = caseJson('ok_unknown');
        fake.on('artifact.render', () => ({ result: c.expect }));
        const r = await renderOf();
        assert.strictEqual(r.output, c.expect.output);
        assert.deepStrictEqual(warnings, [c.expect.warnings.map(engineWarningMessage).join('\n')]);
    });

    test('errors: path.not_found ⇒ undefined + one toast; no engine meta ⇒ no render, no read', async () => {
        fake.on('artifact.render', () => ({ error: { code: 'path.not_found', params: { path: 'Snippets/nope.md' } } }));
        assert.strictEqual(await renderForDelivery(artifact(), 'x', {}, SINGLE, io()), undefined);
        assert.strictEqual(toasts.length, 1);
        assert.strictEqual(sent.length, 0);

        const before = renders().length;
        const bare = artifact('Snippet');
        delete (bare as { relPath?: string }).relPath;
        assert.strictEqual(await renderForDelivery(bare, 'x', {}, { kind: 'multi', heading: 'Two' }, io()), undefined);
        assert.strictEqual(renders().length, before);
        assert.strictEqual(reads().length, 0);
    });

    test('🔒 double-click: one render and one sendText', async () => {
        let release!: () => void;
        const gate = new Promise<void>(res => { release = res; });
        fake.on('artifact.render', async () => { await gate; return { result: { output: 'echo 1', warnings: [], containsEscape: false } }; });
        const a = artifact('Command');
        const actions = new PreviewActions(bag(a, 'terminal'), io());
        const first = actions.handleInsert({ code: 'echo 1', vars: {} });
        const second = actions.handleInsert({ code: 'echo 1', vars: {} });
        release();
        await Promise.all([first, second]);
        await new Promise(res => setTimeout(res, 20));
        assert.strictEqual(renders().length, 1);
        assert.strictEqual(sent.length, 1);
    });

    // ── T4.2 ─────────────────────────────────────────────────────────────────

    test('Copy: clipboard gets the engine output verbatim, one info', async () => {
        reply('ENGINE-OUT');
        await new PreviewActions(bag(artifact()), io()).handleCopy({ code: 'hi <VK-name>', vars: { 'VK-name': 'bob' } });
        assert.deepStrictEqual(clip, ['ENGINE-OUT']);
        assert.strictEqual(infos.length, 1);
    });

    test('Copy: warning toast and clipboard still written', async () => {
        const c = caseJson('ok_unknown');
        fake.on('artifact.render', () => ({ result: c.expect }));
        await new PreviewActions(bag(artifact()), io()).handleCopy({ code: 'x', vars: {} });
        assert.strictEqual(warnings.length, 1);
        assert.deepStrictEqual(clip, [c.expect.output]);
    });

    test('Copy: engine error ⇒ no clipboard, no info, one toast', async () => {
        fake.on('artifact.render', () => ({ error: { code: 'path.not_found', params: { path: 'x' } } }));
        await new PreviewActions(bag(artifact()), io()).handleCopy({ code: 'x', vars: {} });
        assert.strictEqual(clip.length, 0);
        assert.strictEqual(infos.length, 0);
        assert.strictEqual(toasts.length, 1);
    });

    test('Copy: staged msg.code is what params.code carries', async () => {
        reply('o');
        await new PreviewActions(bag(artifact()), io()).handleCopy({ code: 'STAGED', vars: {} });
        assert.strictEqual(renders()[0].params['code'], 'STAGED');
    });
});
