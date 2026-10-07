import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { fillVarTokens, handleApplyToEditor, type ApplyDeps } from '../src/commands/variables-apply.command.js';
import { onPreviewTargetChanged, setPreviewTarget, type PreviewVarTarget } from '../src/services/preview-target.service.js';
import { renderVariablesFile } from '../src/services/variables-writer.service.js';
import type { VariableNode } from '../src/ui/views/variablesView.provider.js';

/**
 * The Variables pane's two apply buttons: "Fill Variables in Editor" (fills
 * `<VK-xxx>` tokens in the active editor) and the preview-open signal that
 * shows Apply-to-preview only while a preview exists.
 */

suite('fillVarTokens', () => {
    test('fills the set\'s tokens and leaves unknown ones', () => {
        assert.strictEqual(
            fillVarTokens('const <VK-result> = <VK-array>.map(<VK-other>);', [
                { name: 'VK-result', defaultValue: 'names' },
                { name: 'VK-array', defaultValue: 'users' },
            ]),
            'const names = users.map(<VK-other>);',
        );
    });

    test('an empty value keeps its token instead of erasing it', () => {
        assert.strictEqual(fillVarTokens('<VK-a>/<VK-b>', [
            { name: 'VK-a', defaultValue: 'x' },
            { name: 'VK-b', defaultValue: '' },
        ]), 'x/<VK-b>');
    });

    test('the render-safe <VK-x></VK-x> pair becomes one value', () => {
        assert.strictEqual(fillVarTokens('run <VK-host></VK-host>', [{ name: 'VK-host', defaultValue: 'db' }]), 'run db');
    });
});

suite('handleApplyToEditor', () => {
    const model = {
        artifactType: 'Variables' as const, title: 'Users', description: '', tags: [],
        blocks: [{ heading: '', description: '', language: '', code: '', vars: [
            { name: 'VK-array', defaultValue: 'users' },
            { name: 'VK-result', defaultValue: 'activeUsers' },
        ] }],
    };

    function vault(): { root: vscode.Uri; node: VariableNode } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vars-editor-'));
        fs.mkdirSync(path.join(dir, 'Variables'));
        const file = path.join(dir, 'Variables', 'users.md');
        fs.writeFileSync(file, renderVariablesFile(model), 'utf8');
        return { root: vscode.Uri.file(dir), node: { id: file, parentId: null, kind: 'file', label: 'Users', shape: 'flat' } };
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

    test('no selection → fills the whole document', async () => {
        const { root, node } = vault();
        const editor = await editorWith('const <VK-result> = <VK-array>.filter(x => x);\n<VK-array>.length;');
        await handleApplyToEditor(node, deps(root, editor, []));
        assert.strictEqual(editor.document.getText(), 'const activeUsers = users.filter(x => x);\nusers.length;');
    });

    test('a selection limits the fill to the selected text', async () => {
        const { root, node } = vault();
        const editor = await editorWith('<VK-array>\n<VK-array>');
        editor.selection = new vscode.Selection(1, 0, 1, '<VK-array>'.length);
        await handleApplyToEditor(node, deps(root, editor, []));
        assert.strictEqual(editor.document.getText(), '<VK-array>\nusers');
    });

    test('no matching tokens → tells the user and edits nothing', async () => {
        const { root, node } = vault();
        const editor = await editorWith('nothing to fill');
        const info: string[] = [];
        await handleApplyToEditor(node, deps(root, editor, info));
        assert.strictEqual(editor.document.getText(), 'nothing to fill');
        assert.strictEqual(info.length, 1);
    });

    test('no editor open → tells the user, touches nothing', async () => {
        const { root, node } = vault();
        const info: string[] = [];
        await handleApplyToEditor(node, deps(root, undefined, info));
        assert.strictEqual(info.length, 1);
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
