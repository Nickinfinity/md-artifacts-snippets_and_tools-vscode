import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACTS } from '../src/types/constants.js';
import type { Artifact, ArtifactContext } from '../src/types/artifact.types.js';
import { artifactCommandId, artifactTerminalCommandId } from '../src/commands/insert.command.js';
import { resolveNls } from './nls.helpers.js';

/**
 * Drift guard: `package.json` menu contributions ↔ `ARTIFACTS`.
 *
 * Every other consumer of the artifact set (command registration, context keys,
 * vault-dir detection, settings toggles) loops over `ARTIFACTS`, so adding a
 * type there wires those automatically. `package.json` is the lone exception —
 * VS Code reads it *before* the extension activates, so it cannot derive from
 * constants at runtime and must be hand-maintained. A new artifact added to
 * `ARTIFACTS` but forgotten in `package.json` produces **no error**: its
 * context-menu entry simply never appears (the exact "Insert Template not
 * showing" class of report). This suite fails loudly instead.
 *
 * It reuses the real derivers (`artifactCommandId`) rather than re-deriving the
 * command-ID pattern, so the guard is pinned to what actually registers.
 */
suite('package.json menus ↔ ARTIFACTS drift guard', () => {

	// Compiled tests run from dist/test → repo root is two levels up.
	const pkg = JSON.parse(
		fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
	) as {
		contributes: {
			commands: { command: string; title?: string }[];
			menus: Record<string, { command?: string; when?: string }[]>;
		};
	};

	const ALL_SURFACES: ArtifactContext[] = ['editor', 'terminal', 'explorer'];

	/**
	 * Expands an artifact's declared `contexts` to concrete menu surfaces.
	 * `'all'` fans out to every surface; otherwise the listed surfaces pass through.
	 *
	 * @param contexts - The artifact's `contexts` field from ARTIFACTS.
	 * @returns The concrete surfaces the artifact must appear in.
	 * @example
	 * surfacesFor(['all'])       // → ['editor', 'terminal', 'explorer']
	 * surfacesFor(['explorer'])  // → ['explorer']
	 */
	function surfacesFor(contexts: readonly ArtifactContext[]): ArtifactContext[] {
		return contexts.includes('all')
			? [...ALL_SURFACES]
			: ALL_SURFACES.filter(s => contexts.includes(s));
	}

	/**
	 * True if a `package.json` menu list contains an entry for the given command.
	 *
	 * @param menuKey - Key into `contributes.menus` (e.g. `'explorer/context'`).
	 * @param commandId - The command ID to look for.
	 * @returns Whether any entry in that menu references the command.
	 * @example
	 * menuHasCommand('explorer/context', 'md-artifacts.insert.templates') // → true
	 */
	function menuHasCommand(menuKey: string, commandId: string): boolean {
		const entries = pkg.contributes.menus[menuKey] ?? [];
		return entries.some(e => e.command === commandId);
	}

	/**
	 * True for artifacts whose `contexts` declare **both** `'editor'` and
	 * `'terminal'` (only `AIPrompt` today) — the only types T3 registers a
	 * dedicated `.terminal` command for, since resolving their insert target
	 * needs to know which menu was actually clicked (D6, row 2).
	 *
	 * @param a - The `ARTIFACTS` entry under test.
	 * @returns Whether `a` needs a terminal-surface command.
	 * @example isBothContextArtifact({ contexts: ['editor', 'terminal'], ... }) // → true
	 */
	function isBothContextArtifact(a: Artifact): boolean {
		return a.contexts.includes('editor') && a.contexts.includes('terminal');
	}

	/**
	 * The command id that should appear in a given surface's menus for this
	 * artifact. Both-context artifacts get a dedicated `.terminal` id for the
	 * `'terminal'` surface (T3); every other surface, and every other
	 * artifact, uses the shared base id.
	 *
	 * @param a       - The `ARTIFACTS` entry under test.
	 * @param surface - The concrete menu surface being checked.
	 * @returns The expected command id for that surface.
	 * @example commandIdFor(aiPromptEntry, 'terminal') // → 'md-artifacts.insert.aiprompts.terminal'
	 */
	function commandIdFor(a: Artifact, surface: ArtifactContext): string {
		return surface === 'terminal' && isBothContextArtifact(a)
			? artifactTerminalCommandId(a.dir)
			: artifactCommandId(a.dir);
	}

	test('every artifact has a contributes.commands entry with a non-empty title', () => {
		for (const a of ARTIFACTS) {
			const id = artifactCommandId(a.dir);
			const cmd = pkg.contributes.commands.find(c => c.command === id);
			assert.ok(cmd, `package.json contributes.commands is missing ${id}`);
			const resolved = resolveNls(cmd.title ?? '');
			assert.ok(
				typeof resolved === 'string' && resolved.length > 0,
				`${id} has no menu title (VS Code labels the entry from this)`,
			);
		}
	});

	test('every artifact appears in each declared context surface (direct entry)', () => {
		for (const a of ARTIFACTS) {
			for (const surface of surfacesFor(a.contexts)) {
				const id = commandIdFor(a, surface);
				assert.ok(
					menuHasCommand(`${surface}/context`, id),
					`${id} missing from ${surface}/context (contexts: ${a.contexts.join(',')})`,
				);
			}
		}
	});

	test('every artifact appears in each declared submenu (multi-artifact case)', () => {
		for (const a of ARTIFACTS) {
			for (const surface of surfacesFor(a.contexts)) {
				const id = commandIdFor(a, surface);
				assert.ok(
					menuHasCommand(`md-artifacts.submenu.${surface}`, id),
					`${id} missing from md-artifacts.submenu.${surface}`,
				);
			}
		}
	});

	// ── T3: both-context artifacts get a dedicated terminal-surface command ────

	test('every both-context artifact contributes a .terminal command mirroring the base title (derived from ARTIFACTS)', () => {
		const bothContext = ARTIFACTS.filter(isBothContextArtifact);
		assert.ok(bothContext.length > 0, 'expected at least one both-context artifact (AIPrompt) to exercise this guard');

		for (const a of bothContext) {
			const baseId     = artifactCommandId(a.dir);
			const terminalId = artifactTerminalCommandId(a.dir);
			const baseCmd     = pkg.contributes.commands.find(c => c.command === baseId);
			const terminalCmd = pkg.contributes.commands.find(c => c.command === terminalId);
			assert.ok(terminalCmd, `package.json contributes.commands is missing ${terminalId}`);
			assert.strictEqual(
				resolveNls(terminalCmd?.title ?? ''), resolveNls(baseCmd?.title ?? ''),
				`${terminalId} title should mirror ${baseId} (same label, different menu id)`,
			);
		}
	});

	test('terminal surfaces reference a both-context artifact\'s .terminal id, never its base id', () => {
		for (const a of ARTIFACTS.filter(isBothContextArtifact)) {
			const baseId     = artifactCommandId(a.dir);
			const terminalId = artifactTerminalCommandId(a.dir);

			assert.ok(menuHasCommand('terminal/context', terminalId), `terminal/context missing ${terminalId}`);
			assert.ok(!menuHasCommand('terminal/context', baseId), `terminal/context must not reference the base id ${baseId}`);

			assert.ok(menuHasCommand('md-artifacts.submenu.terminal', terminalId), `submenu.terminal missing ${terminalId}`);
			assert.ok(!menuHasCommand('md-artifacts.submenu.terminal', baseId), `submenu.terminal must not reference the base id ${baseId}`);
		}
	});

	// The base id and the .terminal id share one title, so an unconstrained
	// .terminal entry would list twice, indistinguishably, in the Command
	// Palette — and picking the .terminal one would spawn a terminal from a
	// palette invocation. Pinned here so the next both-context type cannot
	// silently reintroduce the duplicate.
	test('commandPalette suppresses a both-context artifact\'s .terminal id (when: false)', () => {
		for (const a of ARTIFACTS.filter(isBothContextArtifact)) {
			const terminalId = artifactTerminalCommandId(a.dir);
			const entry = (pkg.contributes.menus.commandPalette ?? []).find(e => e.command === terminalId);
			assert.ok(entry, `commandPalette is missing an entry for ${terminalId}`);
			assert.strictEqual(entry?.when, 'false', `commandPalette entry for ${terminalId} must be when: false`);
		}
	});

	// Regression guard for the registration rule itself (insert.command.ts): a
	// terminal-only artifact (Command, contexts: ['terminal']) never needed a
	// second command id — it already resolves to the terminal unconditionally
	// (D6, row 1). A `.terminal` entry appearing for it would be dead weight
	// nobody's menu points at.
	test('a terminal-only artifact (not both-context) never gets a .terminal command contributed', () => {
		for (const a of ARTIFACTS.filter(x => !isBothContextArtifact(x))) {
			const terminalId = artifactTerminalCommandId(a.dir);
			assert.ok(
				!pkg.contributes.commands.some(c => c.command === terminalId),
				`${terminalId} should not exist — ${a.type} is not a both-context artifact`,
			);
		}
	});
});
