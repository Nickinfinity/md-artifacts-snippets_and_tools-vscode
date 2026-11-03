import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { scratchNameForBlock, FormBlockExpandController, handleClearBlock, handleExpandMessage } from '../src/ui/panels/artifactForm/blockExpand.js';
import { setConfirmSink } from '../src/services/confirm.service.js';
import type { ArtifactFormBlock } from '../src/types/artifact-form.types.js';

/**
 * `blockExpand.ts` (T5, VSX-207) — form block expand → editor → back.
 *
 * `scratchNameForBlock` is the pure naming rule: it must slug a heading
 * before anything reaches `scratch-file.service`'s own containment checks,
 * so a hostile heading never arrives there unslugged (that service rejects
 * hostile input rather than sanitising it — this is the layer that keeps it
 * from ever seeing one).
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): vscode.Uri {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-block-expand-test-'));
    return vscode.Uri.file(dir);
}

function block(over: Partial<ArtifactFormBlock> = {}): ArtifactFormBlock {
    return { heading: '', description: '', language: '', code: '', vars: [], ...over };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

// ── scratchNameForBlock ──────────────────────────────────────────────────────

suite('form-block-expand', () => {

    suite('scratchNameForBlock', () => {
        test('empty heading falls back to untitled-block-<n+1>, keyed off index', () => {
            assert.strictEqual(
                scratchNameForBlock({ heading: '', language: 'typescript' }, 2),
                'untitled-block-3.ts',
            );
        });

        test('a hostile heading yields a slugged, separator-free name', () => {
            const name = scratchNameForBlock({ heading: '../../etc/passwd', language: 'ts' }, 0);
            assert.strictEqual(name, 'etc-passwd.ts');
            assert.ok(!name.includes('/') && !name.includes('\\'), 'name must carry no path separator');
            assert.ok(!name.includes('..'), 'name must carry no traversal segment');
        });

        test('a normal heading slugifies as the base name', () => {
            assert.strictEqual(
                scratchNameForBlock({ heading: 'Dev Setup', language: 'javascript' }, 5),
                'dev-setup.js',
            );
        });
    });

    // ── FormBlockExpandController ────────────────────────────────────────────

    suite('FormBlockExpandController', () => {
        test('start() writes the block code to a temp file and opens it', async () => {
            const storageUri = makeTmpDir();
            const b = block({ heading: 'My Block', language: 'typescript', code: 'const x = 1;' });
            const ctrl = new FormBlockExpandController({
                storageUri,
                onSaved: () => { /* not exercised here */ },
                getViewColumn: () => undefined,
            });

            await ctrl.start(0, b);
            try {
                const doc = vscode.window.activeTextEditor?.document;
                assert.notStrictEqual(doc, undefined);
                assert.strictEqual(doc!.getText(), 'const x = 1;');
                assert.ok(doc!.uri.fsPath.endsWith(path.join('formBlockEdit', 'my-block.ts')));
            } finally {
                await ctrl.teardown();
            }
        });

        test('teardown() deletes the temp file', async () => {
            const storageUri = makeTmpDir();
            const b = block({ heading: 'Gone Soon', language: 'javascript', code: 'x' });
            const ctrl = new FormBlockExpandController({
                storageUri,
                onSaved: () => { /* not exercised here */ },
                getViewColumn: () => undefined,
            });

            await ctrl.start(0, b);
            const tempUri = vscode.window.activeTextEditor!.document.uri;
            assert.strictEqual(await exists(tempUri), true);

            await ctrl.teardown();
            assert.strictEqual(await exists(tempUri), false);
        });

        test('saving the temp file reports the new text through onSaved', async () => {
            const storageUri = makeTmpDir();
            const b = block({ heading: 'Save Me', language: 'plaintext', code: 'before' });
            let saved: { index: number; code: string } | undefined;
            const ctrl = new FormBlockExpandController({
                storageUri,
                onSaved: (index, code) => { saved = { index, code }; },
                getViewColumn: () => undefined,
            });

            await ctrl.start(3, b);
            try {
                const editor = vscode.window.activeTextEditor!;
                await editor.edit(e => {
                    const full = editor.document.validateRange(new vscode.Range(0, 0, editor.document.lineCount, 0));
                    e.replace(full, 'after');
                });
                await editor.document.save();

                assert.deepStrictEqual(saved, { index: 3, code: 'after' });
            } finally {
                await ctrl.teardown();
            }
        });

        test('a hostile heading never escapes extension storage', async () => {
            const storageUri = makeTmpDir();
            const b = block({ heading: '../../evil', language: 'ts', code: 'x' });
            const ctrl = new FormBlockExpandController({
                storageUri,
                onSaved: () => { /* not exercised here */ },
                getViewColumn: () => undefined,
            });

            await ctrl.start(0, b);
            try {
                const doc = vscode.window.activeTextEditor?.document;
                assert.notStrictEqual(doc, undefined);
                assert.ok(doc!.uri.fsPath.startsWith(storageUri.fsPath), 'temp file must stay inside storageUri');
                assert.strictEqual(await exists(vscode.Uri.file(path.join(os.tmpdir(), 'evil.ts'))), false);
            } finally {
                await ctrl.teardown();
            }
        });
    });

    // ── The expandBlock message is untrusted: assert the sink ────────────────

    suite('handleExpandMessage', () => {
        const mk = (storageUri: vscode.Uri, onSaved: (i: number, c: string, l?: string) => void = () => { /* unused */ }) =>
            new FormBlockExpandController({ storageUri, onSaved, getViewColumn: () => undefined });

        test('the webview block wins: index 3 with css writes untitled-block-4.css', async () => {
            const storageUri = makeTmpDir();
            const ctrl = mk(storageUri);
            await handleExpandMessage(ctrl, { index: 3, code: 'a{}', language: 'css', heading: '' });
            try {
                const doc = vscode.window.activeTextEditor!.document;
                assert.ok(doc.uri.fsPath.endsWith(path.join('formBlockEdit', 'untitled-block-4.css')));
                assert.strictEqual(doc.getText(), 'a{}');
            } finally {
                await ctrl.teardown();
            }
        });

        test('hostile heading and language stay a safe file under storageUri', async () => {
            const hostile: Array<[string, unknown]> = [
                ['../../etc/passwd', 'css'],
                ['x'.repeat(300), 'css'],
                ['h', '../x'],
                ['h', 'constructor'],
                ['h', '__proto__'],
                ['h', {}],
                ['h', undefined],
            ];
            for (const [heading, language] of hostile) {
                const storageUri = makeTmpDir();
                const ctrl = mk(storageUri);
                await handleExpandMessage(ctrl, { index: 0, code: 'x', language, heading });
                try {
                    const doc = vscode.window.activeTextEditor!.document;
                    assert.ok(doc.uri.fsPath.startsWith(storageUri.fsPath), `outside storage: ${JSON.stringify(language)}`);
                    assert.match(path.basename(doc.uri.fsPath), /^[a-z0-9-]+\.[a-z0-9]+$/);
                } finally {
                    await ctrl.teardown();
                }
            }
        });

        test('a bad index writes nothing and leaves the active editor alone', async () => {
            const before = vscode.window.activeTextEditor;
            for (const index of [-1, 1.5, Number.NaN, 1e9]) {
                const storageUri = makeTmpDir();
                const ctrl = mk(storageUri);
                await handleExpandMessage(ctrl, { index, code: 'x', language: 'css', heading: 'h' });
                assert.strictEqual(fs.existsSync(path.join(storageUri.fsPath, 'formBlockEdit')), false, `wrote for ${index}`);
                assert.strictEqual(vscode.window.activeTextEditor, before);
            }
        });

        test('save without a language change reports no language', async () => {
            const seen: Array<string | undefined> = [];
            const ctrl = mk(makeTmpDir(), (_i, _c, l) => seen.push(l));
            await handleExpandMessage(ctrl, { index: 0, code: 'a', language: 'bash', heading: 'h' });
            try {
                await vscode.window.activeTextEditor!.edit(e => e.insert(new vscode.Position(0, 0), 'b'));
                await vscode.window.activeTextEditor!.document.save();
                assert.deepStrictEqual(seen, [undefined]);
            } finally {
                await ctrl.teardown();
            }
        });

        test('save after the user changes the tab language reports it', async () => {
            const seen: Array<string | undefined> = [];
            const ctrl = mk(makeTmpDir(), (_i, _c, l) => seen.push(l));
            await handleExpandMessage(ctrl, { index: 0, code: 'a', language: 'css', heading: 'h' });
            try {
                const doc = await vscode.languages.setTextDocumentLanguage(vscode.window.activeTextEditor!.document, 'scss');
                await vscode.window.activeTextEditor!.edit(e => e.insert(new vscode.Position(0, 0), 'b'));
                await doc.save();
                assert.deepStrictEqual(seen, ['scss']);
            } finally {
                await ctrl.teardown();
            }
        });
    });

    // ── Clear ────────────────────────────────────────────────────────────────

    suite('handleClearBlock', () => {
        teardown(() => setConfirmSink(undefined));

        test('confirmed on the active index tears the session down and posts true', async () => {
            const ctrl = new FormBlockExpandController({ storageUri: makeTmpDir(), onSaved: () => { /* unused */ }, getViewColumn: () => undefined });
            await handleExpandMessage(ctrl, { index: 2, code: 'x', language: 'css', heading: 'h' });
            const tempUri = vscode.window.activeTextEditor!.document.uri;
            const posted: Array<Record<string, unknown>> = [];
            setConfirmSink(async () => true);
            await handleClearBlock(2, ctrl, m => posted.push(m));
            assert.strictEqual(await exists(tempUri), false);
            assert.strictEqual(ctrl.activeIndex, undefined);
            assert.deepStrictEqual(posted, [{ command: 'clearBlockConfirmed', index: 2, confirmed: true }]);
        });

        test('declined posts false and leaves the file', async () => {
            const ctrl = new FormBlockExpandController({ storageUri: makeTmpDir(), onSaved: () => { /* unused */ }, getViewColumn: () => undefined });
            await handleExpandMessage(ctrl, { index: 2, code: 'x', language: 'css', heading: 'h' });
            const tempUri = vscode.window.activeTextEditor!.document.uri;
            const posted: Array<Record<string, unknown>> = [];
            setConfirmSink(async () => false);
            try {
                await handleClearBlock(2, ctrl, m => posted.push(m));
                assert.strictEqual(await exists(tempUri), true);
                assert.deepStrictEqual(posted, [{ command: 'clearBlockConfirmed', index: 2, confirmed: false }]);
            } finally {
                await ctrl.teardown();
            }
        });

        test('confirmed on another index keeps the session', async () => {
            const ctrl = new FormBlockExpandController({ storageUri: makeTmpDir(), onSaved: () => { /* unused */ }, getViewColumn: () => undefined });
            await handleExpandMessage(ctrl, { index: 2, code: 'x', language: 'css', heading: 'h' });
            setConfirmSink(async () => true);
            try {
                await handleClearBlock(0, ctrl, () => { /* unused */ });
                assert.strictEqual(ctrl.activeIndex, 2);
            } finally {
                await ctrl.teardown();
            }
        });
    });
});
