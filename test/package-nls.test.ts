import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveNls, everyLocalisableManifestSites } from './nls.helpers.js';

/**
 * `package.nls.json` / `package.nls.es.json` localisation guard.
 *
 * VS Code resolves `contributes.*` `%key%` placeholders against
 * `package.nls.json` (and its locale variants) **before activation** — there
 * is no runtime API to call, so this is a static-file contract like
 * `package-menus.test.ts`'s command-id mirror. `resolveNls` and
 * `everyLocalisableManifestSites` (`test/nls.helpers.ts`) are the single
 * derivation this suite and `package-menus.test.ts` / `package-create-menus.test.ts`
 * all route through.
 */
suite('package.nls.json localisation guard', () => {

	// Compiled tests run from dist/test → repo root is two levels up.
	const en = JSON.parse(
		fs.readFileSync(path.join(__dirname, '..', '..', 'package.nls.json'), 'utf8'),
	) as Record<string, string>;
	const es = JSON.parse(
		fs.readFileSync(path.join(__dirname, '..', '..', 'package.nls.es.json'), 'utf8'),
	) as Record<string, string>;

	// The `""` review sentinel lives only in the es bundle, so filter it on both
	// sides — comparing raw key sets fails on a correctly-written pair.
	function keys(o: object): string[] {
		return Object.keys(o).filter(k => k !== '').sort();
	}

	test('resolveNls passes a literal title through untouched', () => {
		assert.strictEqual(resolveNls('Insert Snippets'), 'Insert Snippets',
			'a literal title must pass through untouched');
	});

	test('resolveNls resolves a %key% via package.nls.json', () => {
		assert.strictEqual(resolveNls('%cmd.insert.snippets.title%'), 'Insert Snippets',
			'a %key% must resolve via package.nls.json');
	});

	test('resolveNls throws loudly on an unresolvable key', () => {
		assert.throws(() => resolveNls('%no.such.key%'), /no\.such\.key/,
			'an unresolvable key must fail loudly, not silently pass through');
	});

	test('every localisable manifest site is covered, at the pinned count', () => {
		// Without the length pin, this loop is vacuous over any subset — a helper
		// returning 5 of 70 sites would pass just as well.
		// 68 → 70: `variables.openFile` added a title and a category site (the
		// pane's route into the var-set edit form). 70 → 74: `variables.search`
		// and `variables.clearSearch`, a title and a category site each.
		// 74 → 76: `variables.applyToEditor`, a title and a category site.
		// 76 → 78: `variables.addToBlank` (blank file's Add…), same two sites.
		// 78 → 82: `variables.editDescription` and `variables.editTags`, two sites each.
		// 82 → 84: `variables.viewInfo`, a title and a category site.
		const sites = everyLocalisableManifestSites();
		assert.strictEqual(sites.length, 84);

		// UNFILTERED count: the `""` review sentinel is es-ONLY. The en bundle has
		// exactly 54 keys and no sentinel. 51 → 52: `cmd.variables.openFile.title`.
		// 52 → 54: `cmd.variables.search.title`, `cmd.variables.clearSearch.title`.
		// 54 → 55: `cmd.variables.applyToEditor.title`. 55 → 56: `cmd.variables.addToBlank.title`.
		// 56 → 58: `cmd.variables.editDescription.title`, `cmd.variables.editTags.title`.
		// 58 → 59: `cmd.variables.viewInfo.title`.
		assert.strictEqual(Object.keys(en).length, 59);

		// A Map, not a Set of values: pins the key→value binding, not just the
		// value set — red on a wrong value, a wrong key, and a mis-keyed pair.
		// Green on both sides of the %key% swap: literals pass through, %keys%
		// resolve to the same literals.
		assert.deepStrictEqual(
			new Map(sites.map(s => [s.key, resolveNls(s.value)])),
			new Map(Object.entries(en)),
		);
	});

	test('every site value resolves without throwing (vacuous until package.json swaps to %keys%)', () => {
		for (const s of everyLocalisableManifestSites()) {
			assert.doesNotThrow(() => resolveNls(s.value));
		}
	});

	test('no bare literal remains in contributes — every site is a %key%', () => {
		// H4.1's complementary assertion, and the inverse of the resolve loop
		// above: that one proves every value *resolves*, which a bare literal
		// also satisfies by passing through untouched. Only this one catches a
		// `%key%` reverted to its English literal — the exact regression that
		// re-Anglicises one menu entry while the Spanish bundle still carries
		// its key, with no other guard in the suite going red.
		//
		// The length pin is what stops it being vacuous over a subset: without
		// it, a helper returning 5 of 70 sites passes here and in the Map guard.
		const sites = everyLocalisableManifestSites();
		assert.strictEqual(sites.length, 84);

		const bare = sites.filter(s => !/^%.+%$/.test(s.value));
		assert.deepStrictEqual(bare, [],
			`contributes carries ${bare.length} bare literal(s): ${bare.map(s => s.key).join(', ')}`);
	});

	test('the Spanish bundle has not drifted from the English one', () => {
		assert.deepStrictEqual(keys(es), keys(en),
			'the Spanish bundle has drifted from the English one');
	});

	test('every Spanish value is a non-empty string', () => {
		assert.strictEqual(
			Object.values(es).filter(v => !v || typeof v !== 'string').length, 0,
			'an empty or non-string Spanish value',
		);
	});
});
