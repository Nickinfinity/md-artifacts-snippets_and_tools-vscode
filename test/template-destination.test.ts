import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    classifyDestination,
    resolveDestination,
} from '../src/ui/panels/destFolderPicker.panel.js';

/**
 * T4 — destination resolution from an Explorer URI (D2).
 *
 * The pure decision (`classifyDestination`) carries the assertions; the thin
 * `vscode` wrapper (`resolveDestination`) is exercised here for the URI-present
 * branch (stat a real temp path) — its no-URI branch opens the folder picker
 * and is covered by the H1 manual pass.
 */

function makeTmpDir(): vscode.Uri {
    return vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'tmpl-dest-test-')));
}

// ── classifyDestination (pure) ───────────────────────────────────────────────────

suite('classifyDestination', () => {

    const dir = vscode.Uri.file('/ws/src/components');
    const file = vscode.Uri.file('/ws/src/components/Button.tsx');

    test('a Directory is returned unchanged', () => {
        assert.strictEqual(
            classifyDestination(dir, vscode.FileType.Directory).fsPath,
            dir.fsPath,
        );
    });

    test('a File resolves to its parent directory', () => {
        assert.strictEqual(
            classifyDestination(file, vscode.FileType.File).fsPath,
            dir.fsPath,
        );
    });

    test('a symlink-to-directory is treated as a directory (Directory bit set)', () => {
        const t = vscode.FileType.SymbolicLink | vscode.FileType.Directory;
        assert.strictEqual(classifyDestination(dir, t).fsPath, dir.fsPath);
    });

    test('a symlink-to-file resolves to its parent (no Directory bit)', () => {
        const t = vscode.FileType.SymbolicLink | vscode.FileType.File;
        assert.strictEqual(classifyDestination(file, t).fsPath, dir.fsPath);
    });
});

// ── resolveDestination (wrapper, URI-present branch) ──────────────────────────────

suite('resolveDestination — URI present', () => {

    test('a directory URI resolves to itself', async () => {
        const d = makeTmpDir();
        const resolved = await resolveDestination(d);
        assert.strictEqual(resolved?.fsPath, d.fsPath);
    });

    test('a file URI resolves to its parent directory', async () => {
        const d = makeTmpDir();
        const fileUri = vscode.Uri.joinPath(d, 'note.txt');
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode('x'));
        const resolved = await resolveDestination(fileUri);
        assert.strictEqual(resolved?.fsPath, d.fsPath);
    });
});
