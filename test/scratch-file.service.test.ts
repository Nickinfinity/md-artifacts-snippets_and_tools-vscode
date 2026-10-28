import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openScratchFile, disposeScratchFile, sweepOrphans, slugify } from '../src/services/scratch-file.service.js';

/**
 * `scratch-file.service.ts` is the one authority for real temp-edit files
 * written into extension storage (`<storageUri>/<subdir>/<slug>.<ext>`),
 * generalised from `blockEditor.ts`'s `<storageUri>/blockEdit/` behaviour.
 *
 * Security focus: a hostile `baseName` must be **rejected**, never slugged
 * into an accepted write — `slugify('../../evil')` is `'evil'`, an innocuous
 * filename, so containment must be checked against the *raw* name too, not
 * only the post-slug one. Both hostile shapes are asserted below.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): vscode.Uri {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-file-test-'));
    return vscode.Uri.file(dir);
}

async function readFile(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('scratch-file.service', () => {

    // ── Happy path ───────────────────────────────────────────────────────────

    test('openScratchFile writes content at <storageUri>/<subdir>/<slug>.<ext>', async () => {
        const storageUri = makeTmpDir();
        const uri = await openScratchFile({
            storageUri,
            subdir: 'blockEdit',
            baseName: 'My Block Title',
            ext: 'ts',
            content: 'const x = 1;',
        });
        assert.notStrictEqual(uri, undefined);
        assert.ok(uri!.fsPath.endsWith(path.join('blockEdit', 'my-block-title.ts')));
        assert.strictEqual(await readFile(uri!), 'const x = 1;');
    });

    test('openScratchFile creates the subdir when absent', async () => {
        const storageUri = makeTmpDir();
        const uri = await openScratchFile({
            storageUri,
            subdir: 'blockEdit',
            baseName: 'fresh',
            ext: 'js',
            content: 'x',
        });
        assert.notStrictEqual(uri, undefined);
        const dirStat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(storageUri, 'blockEdit'));
        assert.ok((dirStat.type & vscode.FileType.Directory) !== 0);
    });

    // ── Hostile base names — rejected, not sanitised ───────────────────────────

    test('a parent-directory traversal base name is rejected', async () => {
        const storageUri = makeTmpDir();
        const result = await openScratchFile({
            storageUri, subdir: 'x', baseName: '../../evil', ext: 'ts', content: '',
        });
        assert.strictEqual(result, undefined);
    });

    test('a traversal base name never even creates the subdir — rejected before any write', async () => {
        const storageUri = makeTmpDir();
        await openScratchFile({ storageUri, subdir: 'x', baseName: '../../evil', ext: 'ts', content: 'x' });
        // Rejection happens before mkdir+write, and it must not have been
        // slugged into an accepted "evil.ts" write inside storageUri/x either.
        assert.strictEqual(await exists(vscode.Uri.joinPath(storageUri, 'x')), false);
        assert.strictEqual(await exists(vscode.Uri.joinPath(storageUri, 'x', 'evil.ts')), false);
    });

    test('an absolute-path base name is rejected', async () => {
        const storageUri = makeTmpDir();
        const result = await openScratchFile({
            storageUri, subdir: 'x', baseName: '/etc/passwd', ext: 'ts', content: '',
        });
        assert.strictEqual(result, undefined);
    });

    test('an absolute-path base name never writes to that absolute location', async () => {
        const storageUri = makeTmpDir();
        await openScratchFile({ storageUri, subdir: 'x', baseName: '/etc/passwd', ext: 'ts', content: 'x' });
        assert.strictEqual(await exists(vscode.Uri.file('/etc/passwd.ts')), false);
    });

    test('a base name that slugifies to empty is rejected', async () => {
        const storageUri = makeTmpDir();
        const result = await openScratchFile({
            storageUri, subdir: 'x', baseName: '!!!', ext: 'ts', content: '',
        });
        assert.strictEqual(result, undefined);
    });

    // ── Hostile subdir — rejected, not sanitised ────────────────────────────────
    // `vscode.Uri.joinPath` normalises `..`, so `subdir` is exactly as untrusted
    // as `baseName` and must go through the same containment gate.

    test('a parent-directory traversal subdir is rejected', async () => {
        const storageUri = makeTmpDir();
        const result = await openScratchFile({
            storageUri, subdir: '../../evil-dir', baseName: 'fine', ext: 'ts', content: '',
        });
        assert.strictEqual(result, undefined);
    });

    test('a traversal subdir never creates the escape target', async () => {
        const storageUri = makeTmpDir();
        // One level up from storageUri is os.tmpdir() itself — a deterministic,
        // writable-if-the-guard-were-missing target, unlike '../../evil-dir'
        // (which could land outside any writable dir and pass for the wrong
        // reason: OS permission denial rather than our own containment check).
        const escapeTarget = path.join(os.tmpdir(), 'scratch-file-escape-marker');
        await openScratchFile({ storageUri, subdir: '../scratch-file-escape-marker', baseName: 'fine', ext: 'ts', content: 'x' });
        assert.strictEqual(fs.existsSync(escapeTarget), false, 'a hostile subdir must not create anything outside storageUri');
    });

    // ── dispose ──────────────────────────────────────────────────────────────

    test('disposeScratchFile deletes the file', async () => {
        const storageUri = makeTmpDir();
        const uri = await openScratchFile({
            storageUri, subdir: 'blockEdit', baseName: 'to-delete', ext: 'ts', content: 'x',
        });
        assert.notStrictEqual(uri, undefined);
        assert.strictEqual(await exists(uri!), true);
        await disposeScratchFile(uri!);
        assert.strictEqual(await exists(uri!), false);
    });

    test('disposeScratchFile on an already-missing file does not throw', async () => {
        const storageUri = makeTmpDir();
        const ghost = vscode.Uri.joinPath(storageUri, 'blockEdit', 'never-existed.ts');
        await assert.doesNotReject(disposeScratchFile(ghost));
    });

    // ── sweepOrphans ─────────────────────────────────────────────────────────

    test('sweepOrphans removes every leftover file in the subdir', async () => {
        const storageUri = makeTmpDir();
        await openScratchFile({ storageUri, subdir: 'blockEdit', baseName: 'orphan-one', ext: 'ts', content: 'a' });
        await openScratchFile({ storageUri, subdir: 'blockEdit', baseName: 'orphan-two', ext: 'ts', content: 'b' });

        const dir = vscode.Uri.joinPath(storageUri, 'blockEdit');
        const before = await vscode.workspace.fs.readDirectory(dir);
        assert.strictEqual(before.length, 2);

        await sweepOrphans(storageUri, 'blockEdit');

        const after = await vscode.workspace.fs.readDirectory(dir);
        assert.strictEqual(after.length, 0);
    });

    test('sweepOrphans on a subdir that does not exist is a no-op, not an error', async () => {
        const storageUri = makeTmpDir();
        await assert.doesNotReject(sweepOrphans(storageUri, 'blockEdit'));
    });

    // ── sweepOrphans — hostile subdir, rejected not sanitised ───────────────────

    test('sweepOrphans with a traversal subdir deletes nothing outside storageUri', async () => {
        const storageUri = makeTmpDir();
        // A sibling directory with a bait file — outside storageUri, and what a
        // missing containment check on `subdir` would expose to the delete loop.
        const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-file-victim-'));
        const baitFile = path.join(victimDir, 'bait.txt');
        fs.writeFileSync(baitFile, 'do not delete');

        const subdir = path.join('..', path.basename(victimDir));
        await assert.doesNotReject(sweepOrphans(storageUri, subdir));

        assert.strictEqual(fs.existsSync(baitFile), true, 'sweepOrphans must not touch a directory outside storageUri');
        assert.strictEqual(fs.existsSync(victimDir), true, 'sweepOrphans must not touch a directory outside storageUri');
    });

	// ── The storage root is not a subdirectory ───────────────────────────────

	test("sweepOrphans refuses a subdir that resolves to the storage root itself", async () => {
		// `''` and `'.'` are *contained* — isPathWithin accepts them — but they name
		// the root, not a subdirectory, so sweeping them empties the whole storage
		// dir instead of one scratch folder. Unreachable today (both callers pass
		// module constants), pinned because the sink is a delete loop.
		//
		// The bait is a FILE AT THE ROOT, deliberately. A file nested inside a
		// subdirectory survives either way: `fs.delete` on a non-empty directory
		// throws without `recursive`, and sweepOrphans swallows per-entry errors —
		// so a nested bait makes this test pass against the unguarded code too.
		// That version was written first and proved green with the guard removed,
		// which is exactly the decoration this repo's rules reject.
		const root = makeTmpDir();
		const bait = vscode.Uri.joinPath(root, 'bait.txt');
		await vscode.workspace.fs.writeFile(bait, new TextEncoder().encode('keep me'));

		for (const subdir of ['', '.']) {
			await sweepOrphans(root, subdir);
			assert.strictEqual(
				await readFile(bait), 'keep me',
				`sweepOrphans('${subdir}') deleted a file at the storage root`,
			);
		}
	});
});

suite('slugify', () => {
    test('Hello World → hello-world', () => {
        assert.strictEqual(slugify('Hello World'), 'hello-world');
    });

    test('punctuation collapses to single dash', () => {
        assert.strictEqual(slugify('Hello World!!'), 'hello-world');
    });

    test('multiple internal runs collapse to single dash', () => {
        assert.strictEqual(slugify('foo   bar___baz'), 'foo-bar-baz');
    });

    test('leading / trailing dashes stripped', () => {
        assert.strictEqual(slugify('---hello---'), 'hello');
    });

    test('whitespace-only → empty string', () => {
        assert.strictEqual(slugify('   '), '');
    });

    test('alphanumeric preserved', () => {
        assert.strictEqual(slugify('Phase 0.5'), 'phase-0-5');
    });

    test('unicode reduced to dashes (ASCII slug)', () => {
        // No transliteration — non-[a-z0-9] runs become a single dash.
        assert.strictEqual(slugify('café'), 'caf');
    });

    // ── Relocated from block-edit-helpers.test.ts ─────────────────────────
    // These covered `blockEditor.helpers.slug`, a byte-identical third copy
    // deleted in Phase 1 of the services-dry refactor. Kept verbatim so the
    // surviving implementation still answers for every case the copy did.

    test('lowercases and hyphenates spaced words', () => {
        assert.strictEqual(slugify('My Snippet Title'), 'my-snippet-title');
    });

    test('strips punctuation', () => {
        assert.strictEqual(slugify('Hello, World!'), 'hello-world');
    });

    test('trims and collapses surrounding whitespace', () => {
        assert.strictEqual(slugify('  Trim  Me  '), 'trim-me');
    });

    test('leaves an already-slugged string unchanged', () => {
        assert.strictEqual(slugify('already-slug'), 'already-slug');
    });

    // ── Relocated from varSetController's private slugify ─────────────────
    // Its empty-input fallback ('untitled-variable-set') now lives at the
    // call site, so the shared function's contract is: empty in, empty out.

    test('punctuation-only title yields an empty slug (caller supplies the fallback)', () => {
        assert.strictEqual(slugify('!!!'), '');
    });

    test('Local Development! → local-development', () => {
        assert.strictEqual(slugify('Local Development!'), 'local-development');
    });
});
