import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACTS } from '../src/types/constants.js';
import { getCreateTypesForSurface, getIndexCapableTypes, getEntry } from '../src/services/artifact-type-config.service.js';
import type { ArtifactType } from '../src/types/parsed-artifact.types.js';
import { resolveNls } from './nls.helpers.js';

/**
 * Drift guard: `package.json`'s create commands and menus ↔ the §2 derivation
 * over `ARTIFACTS`.
 *
 * VS Code reads `contributes.*` **before activation**, so it cannot derive at
 * runtime — it is a static mirror of what the code derives, and a static mirror
 * drifts. A create type wired into `ARTIFACTS` but missing from `package.json`
 * shows **no menu entry and no error**, which is precisely the failure the
 * insert-side `package-menus.test.ts` exists to catch. This is its create-side
 * twin, in its own file so the two waves never collide on one test file.
 *
 * It pins four things, not just the id set: the ids, the group string, the
 * direct-vs-submenu split, and the context-key names.
 */
suite('package.json create menus ↔ ARTIFACTS drift guard', () => {

	const PKG = JSON.parse(
		fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
	) as {
		contributes: {
			commands: { command: string; title: string }[];
			submenus: { id: string; label: string }[];
			menus: Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
		};
	};

	const SURFACES = ['editor', 'terminal', 'explorer'] as const;
	type Surface = typeof SURFACES[number];

	/** Surface → the `contributes.menus` key VS Code reads for it. */
	const MENU_KEY: Record<Surface, string> = {
		editor:   'editor/context',
		terminal: 'terminal/context',
		explorer: 'explorer/context',
	};

	/**
	 * Builds the create command id for a type, mirroring `insert.command.ts`'s
	 * scheme one word over. Derived, never spelled by hand.
	 *
	 * @param type - The artifact type.
	 * @returns The base create command id.
	 * @example createId('Snippet'); // → 'md-artifacts.create.snippets'
	 */
	function createId(type: ArtifactType): string {
		return `md-artifacts.create.${getEntry(type).dir.toLowerCase()}`;
	}

	/**
	 * The full derived id set: one base id per (type × surface), a `.terminal`
	 * variant for a both-context type, and an `.index` variant for a
	 * whole-file type on the explorer.
	 *
	 * @returns Every create command id the derivation implies.
	 * @example expectedIds().has('md-artifacts.create.aiprompts.terminal'); // → true
	 */
	function expectedIds(): Set<string> {
		const ids = new Set<string>();
		for (const surface of SURFACES) {
			for (const type of getCreateTypesForSurface(surface)) {
				const contexts = getEntry(type).contexts as readonly string[];
				const bothContexts = contexts.includes('editor') && contexts.includes('terminal');
				// A both-context type points its terminal menu at a second command,
				// because a menu label comes only from contributes.commands.title.
				ids.add(surface === 'terminal' && bothContexts ? `${createId(type)}.terminal` : createId(type));
			}
		}
		for (const type of getIndexCapableTypes()) { ids.add(`${createId(type)}.index`); }
		return ids;
	}

	/**
	 * Pre-derivation create ids to exclude from the comparison. **Empty since
	 * Wave 2**, which deleted `create.command.ts` along with its handlers and
	 * manifest entries — so every assertion below now runs against the full set
	 * with nothing carved out.
	 *
	 * Kept as an empty literal rather than deleted outright: it is the seam where
	 * a future legacy id would be parked, and its emptiness is the visible proof
	 * that none exists. It was never a pattern, deliberately — a pattern would
	 * have kept silently absorbing new ids after the legacy ones went, which is
	 * the opposite of what a drift guard is for.
	 */
	const LEGACY_IDS: readonly string[] = [];

	const declaredCreateIds = new Set(
		PKG.contributes.commands
			.map(c => c.command)
			.filter(id => id.startsWith('md-artifacts.create.'))
			.filter(id => !LEGACY_IDS.includes(id)),
	);

	test('the declared create command id set equals the derivation exactly', () => {
		// A set comparison, not a count: eight wrong ids satisfy `length === 8`.
		assert.deepStrictEqual(
			[...declaredCreateIds].sort(),
			[...expectedIds()].sort(),
		);
	});

	test('the derivation is non-empty, so this guard cannot pass vacuously', () => {
		assert.ok(expectedIds().size >= 5, `derivation collapsed to ${expectedIds().size} ids`);
	});

	test('every create command has a non-empty, distinct title', () => {
		// Resolved values, not raw keys: a bare `%key%` satisfies a non-empty
		// string check and a set of *keys* is trivially distinct even when two
		// keys are mis-mapped to the same label — resolving through `resolveNls`
		// is what actually proves the rendered titles differ.
		const titles = PKG.contributes.commands
			.filter(c => declaredCreateIds.has(c.command))
			.map(c => resolveNls(c.title));
		for (const t of titles) { assert.ok(t && t.trim().length > 0, 'empty create command title'); }
		// A menu item's label comes ONLY from its command title, so duplicates
		// render as two identical rows the user cannot tell apart.
		assert.strictEqual(new Set(titles).size, titles.length, 'duplicate create command titles');
	});

	test('every create menu entry sits in the 3_create group', () => {
		for (const surface of SURFACES) {
			for (const e of PKG.contributes.menus[MENU_KEY[surface]] ?? []) {
				const isCreate = e.command?.startsWith('md-artifacts.create.')
					|| e.submenu?.startsWith('md-artifacts.submenu.create.');
				if (!isCreate) { continue; }
				assert.ok(
					e.group?.startsWith('3_create@'),
					`${surface}: ${e.command ?? e.submenu} is in group "${e.group}", expected 3_create@N`,
				);
			}
		}
	});

	test('each surface splits direct entries from its submenu on <surface>CreateHasMultiple', () => {
		for (const surface of SURFACES) {
			const entries = (PKG.contributes.menus[MENU_KEY[surface]] ?? [])
				.filter(e => e.command?.startsWith('md-artifacts.create.')
					|| e.submenu?.startsWith('md-artifacts.submenu.create.'));
			const key = `md-artifacts.${surface}CreateHasMultiple`;

			const submenuEntry = entries.find(e => e.submenu);
			assert.ok(submenuEntry, `${surface}: no create submenu entry`);
			const submenuWhen = submenuEntry.when ?? '';
			assert.ok(
				submenuWhen.includes(key),
				`${surface}: submenu must be gated on ${key}, got "${submenuWhen}"`,
			);
			// The negated form is a different clause with the opposite meaning, and
			// `includes` alone cannot tell them apart — a submenu gated on `!key`
			// would satisfy the check above while showing in exactly the wrong case.
			assert.ok(
				!submenuWhen.includes(`!${key}`),
				`${surface}: submenu is gated on !${key} (inverted), got "${submenuWhen}"`,
			);

			for (const e of entries.filter(x => x.command)) {
				assert.ok(
					e.when?.includes(`!${key}`),
					`${surface}: direct entry ${e.command} must be gated on !${key}, got "${e.when}"`,
				);
			}
		}
	});

	test('each surface declares its own create submenu', () => {
		for (const surface of SURFACES) {
			const id = `md-artifacts.submenu.create.${surface}`;
			assert.ok(
				PKG.contributes.submenus.some(s => s.id === id),
				`missing submenu declaration ${id}`,
			);
			assert.ok(
				(PKG.contributes.menus[id] ?? []).length > 0,
				`submenu ${id} declared but has no entries`,
			);
		}
	});

	test('explorer splits single-file from index on listMultiSelection', () => {
		const entries = (PKG.contributes.menus['explorer/context'] ?? [])
			.filter(e => e.command?.startsWith('md-artifacts.create.'));
		for (const e of entries) {
			const isIndex = e.command!.endsWith('.index');
			// An index needs 2+ files; a single-file capture needs exactly one.
			// Both showing at once is the defect this split prevents.
			assert.ok(
				isIndex
					? e.when?.includes('listMultiSelection') && !e.when.includes('!listMultiSelection')
					: e.when?.includes('!listMultiSelection'),
				`${e.command}: wrong listMultiSelection gating — "${e.when}"`,
			);
		}
	});

	test('editor create entries require a real selection', () => {
		for (const e of PKG.contributes.menus['editor/context'] ?? []) {
			if (!e.command?.startsWith('md-artifacts.create.')
				&& !e.submenu?.startsWith('md-artifacts.submenu.create.')) { continue; }
			assert.ok(
				e.when?.includes('editorHasSelection'),
				`${e.command ?? e.submenu}: editor create entries must require editorHasSelection`,
			);
		}
	});

	test('ids that cannot work from the palette are suppressed there', () => {
		const palette = PKG.contributes.menus['commandPalette'] ?? [];
		for (const id of declaredCreateIds) {
			if (!id.endsWith('.terminal') && !id.endsWith('.index')) { continue; }
			const entry = palette.find(e => e.command === id);
			// `.terminal` needs the terminal it was invoked from; `.index` needs a
			// multi-selection. Neither is answerable from the palette.
			assert.ok(entry, `${id} must appear in commandPalette to be suppressed`);
			assert.strictEqual(entry.when, 'false', `${id} must be suppressed with when:false`);
		}
	});

	test('no create type declared in ARTIFACTS is missing from package.json', () => {
		for (const a of ARTIFACTS.filter(x => x.createForm === true)) {
			assert.ok(
				declaredCreateIds.has(createId(a.type)),
				`${a.type} declares createForm but has no ${createId(a.type)} command`,
			);
		}
	});
});
