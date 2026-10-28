import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathWithin } from '../src/utils/path-containment.js';

/**
 * `isPathWithin` is the single containment authority (`src/utils/path-containment.ts`).
 *
 * Two things are pinned here. First the rule itself, hostile inputs included —
 * this predicate is what stands between vault-authored text and the user's
 * filesystem, and the IDE analyser performs no taint analysis, so nothing else
 * checks it. Second the *singleness*: the rule was spelled out three times
 * before this file existed, and the copies had already diverged on whether they
 * normalised the paths first. The drift guard below is modelled on the retired
 * flag-marker guard, which pinned the flag marker to its owning module the
 * same way.
 */
suite('isPathWithin — the containment rule', () => {

	test('a child path is contained', () => {
		assert.strictEqual(isPathWithin('/vault', '/vault/Snippets/a.md'), true);
	});

	test('a deeply nested child is contained', () => {
		assert.strictEqual(isPathWithin('/vault', '/vault/a/b/c/d.md'), true);
	});

	test('the root itself is contained', () => {
		assert.strictEqual(isPathWithin('/vault', '/vault'), true);
	});

	test('a trailing separator on the root does not change the answer', () => {
		assert.strictEqual(isPathWithin('/vault/', '/vault/Snippets/a.md'), true);
		assert.strictEqual(isPathWithin('/vault/', '/vault-backup/a.md'), false);
	});

	// The bug a naive startsWith ships: a sibling that merely shares a prefix.
	test('a name-prefix sibling is NOT contained', () => {
		assert.strictEqual(isPathWithin('/vault', '/vault-backup/a.md'), false);
	});

	test('an unrelated absolute path is not contained', () => {
		assert.strictEqual(isPathWithin('/vault', '/etc/passwd'), false);
	});

	test('a traversal is resolved, then refused', () => {
		assert.strictEqual(isPathWithin('/vault', '/vault/../etc/passwd'), false);
	});

	test('a traversal that lands back inside is contained', () => {
		assert.strictEqual(isPathWithin('/vault', '/vault/Snippets/../Commands/a.md'), true);
	});

	// Nothing decodes, so an encoded traversal stays an inert literal segment
	// rather than becoming a live one.
	test('a percent-encoded traversal is an inert literal segment', () => {
		assert.strictEqual(isPathWithin('/vault', '/vault/%2e%2e/etc/passwd'), true);
		assert.strictEqual(isPathWithin('/vault', '/etc/%2e%2e/passwd'), false);
	});

	test('the parent of the root is not contained', () => {
		assert.strictEqual(isPathWithin('/vault/Snippets', '/vault'), false);
	});
});

// ── Drift guard ─────────────────────────────────────────────────────────────

/**
 * The rule lives in one file. Anything else spelling `endsWith(path.sep)` is a
 * second copy of it — which is how the three pre-existing versions came to
 * disagree about normalisation in the first place.
 */
suite('containment rule is declared exactly once', () => {

	test('no other src/ file spells the prefix-with-separator rule', () => {
		const srcDir = path.join(__dirname, '../../src');
		const offenders: string[] = [];

		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) { walk(full); continue; }
				if (!entry.name.endsWith('.ts')) { continue; }
				if (full.endsWith(path.join('utils', 'path-containment.ts'))) { continue; }
				if (fs.readFileSync(full, 'utf8').includes('endsWith(path.sep)')) {
					offenders.push(path.relative(srcDir, full));
				}
			}
		};
		walk(srcDir);

		assert.deepStrictEqual(
			offenders,
			[],
			`containment rule re-implemented outside path-containment.ts: ${offenders.join(', ')}`,
		);
	});
});
