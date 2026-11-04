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

	test('every create entry sits in the 3_create group (root and create submenu)', () => {
		for (const surface of SURFACES) {
			for (const menu of [`md-artifacts.submenu.${surface}.root`, `md-artifacts.submenu.create.${surface}`]) {
				for (const e of PKG.contributes.menus[menu] ?? []) {
					const isCreate = e.command?.startsWith('md-artifacts.create.')
						|| e.submenu?.startsWith('md-artifacts.submenu.create.');
					if (!isCreate) { continue; }
					assert.ok(
						e.group?.startsWith('3_create@'),
						`${menu}: ${e.command ?? e.submenu} is in group "${e.group}", expected 3_create@N`,
					);
				}
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

	test('explorer create submenu splits single-file from index on listMultiSelection', () => {
		const entries = (PKG.contributes.menus['md-artifacts.submenu.create.explorer'] ?? [])
			.filter(e => e.command?.startsWith('md-artifacts.create.'));
		assert.ok(entries.length > 0, 'explorer create submenu has no create commands');
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

	test('editor Create submenu requires a real selection', () => {
		const entry = (PKG.contributes.menus['md-artifacts.submenu.editor.root'] ?? [])
			.find(e => e.submenu === 'md-artifacts.submenu.create.editor');
		assert.ok(entry, 'editor root does not nest the Create submenu');
		assert.strictEqual(entry.when, 'editorHasSelection', 'editor Create must require editorHasSelection');
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

    // ── One "MD Artifacts" entry per surface (W-UI b terminal, VSX-269 editor + explorer) ──

    /** Surface → the `when` its root's Create entry carries (editor needs a selection to capture). */
    const CREATE_WHEN: Record<Surface, string | undefined> = {
        editor: 'editorHasSelection', terminal: undefined, explorer: undefined,
    };

    test('each <surface>/context holds exactly one entry, the root submenu', () => {
        for (const surface of SURFACES) {
            assert.deepStrictEqual(PKG.contributes.menus[MENU_KEY[surface]], [
                { submenu: `md-artifacts.submenu.${surface}.root`, when: 'md-artifacts.vaultConfigured', group: 'mda@1' },
            ], `${MENU_KEY[surface]} must hold only the MD Artifacts root`);
        }
    });

    test('each surface root nests Insert and Create, declared and labelled', () => {
        const label = (id: string): string | undefined => {
            const s = PKG.contributes.submenus.find(x => x.id === id);
            return s ? resolveNls(s.label) : undefined;
        };
        for (const surface of SURFACES) {
            const root = `md-artifacts.submenu.${surface}.root`;
            const create = `md-artifacts.submenu.create.${surface}`;
            const createWhen = CREATE_WHEN[surface];
            assert.deepStrictEqual(PKG.contributes.menus[root], [
                { submenu: `md-artifacts.submenu.${surface}`, group: '1_insert@1' },
                createWhen ? { submenu: create, when: createWhen, group: '3_create@1' } : { submenu: create, group: '3_create@1' },
            ], `${root} shape`);
            assert.strictEqual(label(root), 'MD Artifacts');
            assert.strictEqual(label(`md-artifacts.submenu.${surface}`), 'Insert');
            assert.strictEqual(label(create), 'Create');
        }
    });

    test('no *HasMultiple context key survives in package.json', () => {
        assert.ok(!JSON.stringify(PKG.contributes.menus).includes('HasMultiple'),
            'a menu still reads a *HasMultiple key — every surface is a single root now');
    });
});
