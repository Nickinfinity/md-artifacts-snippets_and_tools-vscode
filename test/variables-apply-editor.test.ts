import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { handleApplyToEditor, type ApplyDeps } from '../src/commands/variables-apply.command.js';
import { onPreviewTargetChanged, setPreviewTarget, type PreviewVarTarget } from '../src/services/preview-target.service.js';
import { engineErrorMessage } from '../src/engine/errors.js';
import type { VariableNode } from '../src/ui/views/variablesView.provider.js';
import { useVarsEngine, recordedSource, VAULT } from './vars-engine.js';

/**
 * The Variables pane's two apply buttons: "Fill Variables in Editor" (fills
 * `<VK-xxx>` tokens in the active editor) and the preview-open signal that
 * shows Apply-to-preview only while a preview exists.
 */

suite('handleApplyToEditor', () => {
    const eng = useVarsEngine();
    const model = {
        artifactType: 'Variables' as const, title: 'Users', description: '', tags: [],
        blocks: [{ heading: '', description: '', language: '', code: '', vars: [
            { name: 'VK-array', defaultValue: 'users' },
            { name: 'VK-result', defaultValue: 'activeUsers' },
        ] }],
    };

    function vault(): { root: vscode.Uri; node: VariableNode } {
        const file = eng().serve('Variables/users.md', recordedSource('vars-users'));
        return { root: VAULT, node: { id: file, parentId: null, kind: 'file', label: 'Users', shape: 'flat' } };
    }

    async function editorWith(text: string): Promise<vscode.TextEditor> {
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'javascript' });
        return vscode.window.showTextDocument(doc);
    }

    function deps(root: vscode.Uri, editor: vscode.TextEditor | undefined, info: string[]): ApplyDeps {
        return {
            vaultRoot: root,
            io: { showInputBox: () => Promise.resolve(undefined), confirm: () => Promise.resolve(true), showError: () => { /* none */ }, showQuickPick: () => Promise.resolve(undefined), },
            notifyInfo: m => { info.push(m); },
            activeEditor: () => editor,
        };
    }

    teardown(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });

    /** Canned engine: answers `render.text` by `params.text`; never substitutes. */
    function canned(map: Record<string, string>): void {
        eng().fake.on('render.text', p => ({ result: { output: map[(p as { text: string }).text] ?? (p as { text: string }).text, warnings: [], containsEscape: false } }));
    }
    const renders = (): { params: unknown }[] => eng().calls('render.text');

    test('no selection → one render.text, document becomes the engine output', async () => {
        const { root, node } = vault();
        const text = 'const <VK-result> = <VK-array>.filter(x => x);\n<VK-array>.length;';
        canned({ [text]: 'ENGINE-OUT' });
        const editor = await editorWith(text);
        await handleApplyToEditor(node, deps(root, editor, []));
        assert.strictEqual(renders().length, 1);
        assert.deepStrictEqual(renders()[0]?.params, { text, values: { 'VK-array': 'users', 'VK-result': 'activeUsers' } });
        assert.strictEqual(editor.document.getText(), 'ENGINE-OUT');
    });

    test('a selection limits the render to the selected text', async () => {
        const { root, node } = vault();
        canned({ '<VK-array>': 'users' });
        const editor = await editorWith('<VK-array>\n<VK-array>');
        editor.selection = new vscode.Selection(1, 0, 1, '<VK-array>'.length);
        await handleApplyToEditor(node, deps(root, editor, []));
        assert.strictEqual(renders().length, 1);
        assert.strictEqual((renders()[0]?.params as { text: string }).text, '<VK-array>');
        assert.strictEqual(editor.document.getText(), '<VK-array>\nusers');
    });

    test('an empty default is sent as "" (engine keeps the token)', async () => {
        const file = eng().serve('Variables/e.md', recordedSource('vars-users-empty'));
        const node: VariableNode = { id: file, parentId: null, kind: 'file', label: 'E', shape: 'flat' };
        canned({});
        const editor = await editorWith('<VK-a>');
        await handleApplyToEditor(node, deps(VAULT, editor, []));
        assert.deepStrictEqual((renders()[0]?.params as { values: unknown }).values, { 'VK-a': '' });
    });

    test('engine output === input → tells the user and edits nothing', async () => {
        const { root, node } = vault();
        canned({});
        const editor = await editorWith('nothing to fill');
        const info: string[] = [];
        await handleApplyToEditor(node, deps(root, editor, info));
        assert.strictEqual(editor.document.getText(), 'nothing to fill');
        assert.strictEqual(info.length, 1);
    });

    test('a refused later range → document byte-unchanged, one engine toast', async () => {
        const { root, node } = vault();
        const err = { code: 'render.limit', params: { limit: 'steps', max: '9' } };
        eng().fake.on('render.text', p => (p as { text: string }).text === 'bbb'
            ? { error: err } : { result: { output: 'X', warnings: [], containsEscape: false } });
        const editor = await editorWith('aaa\nbbb');
        editor.selections = [new vscode.Selection(0, 0, 0, 3), new vscode.Selection(1, 0, 1, 3)];
        await handleApplyToEditor(node, deps(root, editor, []));
        assert.strictEqual(editor.document.getText(), 'aaa\nbbb');
        assert.deepStrictEqual(eng().toasts, [engineErrorMessage(err)]);
    });

    test('no editor open → tells the user, zero render.text', async () => {
        const { root, node } = vault();
        const info: string[] = [];
        await handleApplyToEditor(node, deps(root, undefined, info));
        assert.strictEqual(info.length, 1);
        assert.strictEqual(renders().length, 0);
    });

    test('document edited while rendering → stale ranges, no fill, no toast', async () => {
        const { root, node } = vault();
        const editor = await editorWith('body');
        eng().fake.on('render.text', async () => {
            const we = new vscode.WorkspaceEdit();
            we.insert(editor.document.uri, new vscode.Position(0, 0), 'USER ');
            await vscode.workspace.applyEdit(we);
            return { result: { output: 'FILLED', warnings: [], containsEscape: false } };
        });
        const info: string[] = [];
        await handleApplyToEditor(node, deps(root, editor, info));
        assert.strictEqual(editor.document.getText(), 'USER body');
        assert.deepStrictEqual(info, []);
        assert.deepStrictEqual(eng().toasts, []);
    });
});

suite('preview-open signal (drives md-artifacts.previewActive)', () => {
    test('fires true on register and false on release', () => {
        const seen: boolean[] = [];
        const off = onPreviewTargetChanged(a => { seen.push(a); });
        const target: PreviewVarTarget = { applyVarSet: () => { /* none */ }, currentValues: () => ({}), saveAsSet: async () => { /* none */ } };
        const release = setPreviewTarget(target);
        release();
        off();
        assert.deepStrictEqual(seen, [true, false]);
    });

    test('a stale release (another preview took over) does not report false', () => {
        const seen: boolean[] = [];
        const off = onPreviewTargetChanged(a => { seen.push(a); });
        const mk = (): PreviewVarTarget => ({ applyVarSet: () => { /* none */ }, currentValues: () => ({}), saveAsSet: async () => { /* none */ } });
        const releaseFirst = setPreviewTarget(mk());
        const releaseSecond = setPreviewTarget(mk());
        releaseFirst();
        releaseSecond();
        off();
        assert.deepStrictEqual(seen, [true, true, false]);
    });
});
