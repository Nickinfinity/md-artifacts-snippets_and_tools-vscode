import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Test-support module for the `package.nls.json` localisation guards
 * (`test/package-nls.test.ts`, `test/package-menus.test.ts`,
 * `test/package-create-menus.test.ts`). Mirrors `test/webview-dom-harness.ts`:
 * a plain `.ts` module under `test/`, imported rather than collected as a suite
 * (`.vscode-test.mjs` globs `dist/test/**\/*.test.js` only).
 *
 * `package.nls.json` is read once at module load — every exported function
 * shares the same parsed bundle, so a test importing both `resolveNls` and
 * `everyLocalisableManifestSites` never risks reading two different snapshots
 * of the file mid-suite.
 */

/** Compiled tests run from `dist/test/` — repo root is two levels up. */
const REPO_ROOT = path.join(__dirname, '..', '..');

const NLS_BUNDLE = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, 'package.nls.json'), 'utf8'),
) as Record<string, string>;

/**
 * Resolves a `contributes.*` manifest string the way VS Code resolves
 * `%key%` placeholders against `package.nls.json` before activation.
 *
 * A literal string (no `%…%` wrapping) passes through unchanged — most of
 * today's manifest still carries literals, and this is what keeps the guard
 * green on both sides of the `package.json` `%key%` swap (H4.1). An
 * unresolvable key **throws** rather than returning the key or `undefined`:
 * a silently-passed-through `undefined` would let two mis-keyed menu titles
 * compare equal to each other and go green (see `package-menus.test.ts:147`).
 *
 * @param value - A manifest string: either a literal or a `%key%` placeholder.
 * @returns The resolved literal string.
 * @throws {Error} If `value` is a `%key%` placeholder with no matching entry
 *   in `package.nls.json`.
 * @example
 * resolveNls('Insert Snippets'); // → 'Insert Snippets' (literal, untouched)
 * resolveNls('%cmd.insert.snippets.title%'); // → 'Insert Snippets'
 * resolveNls('%no.such.key%'); // throws: no.such.key
 */
export function resolveNls(value: string): string {
	const m = /^%(.+)%$/.exec(value);
	if (!m) { return value; }
	const key = m[1];
	if (!(key in NLS_BUNDLE)) {
		throw new Error(`package.nls.json has no entry for key: ${key}`);
	}
	return NLS_BUNDLE[key];
}

/** One localisable `contributes` string: its derived nls key and current literal value. */
export interface ManifestSite {
	key: string;
	value: string;
}

interface PackageManifest {
	contributes: {
		commands: { command: string; title: string; category?: string }[];
		submenus: { id: string; label: string }[];
		viewsWelcome: { view: string; contents: string }[];
		configuration: { title: string; properties: Record<string, { description: string }> };
		views: Record<string, { id: string; name: string }[]>;
		viewsContainers: { activitybar: { title: string }[] };
	};
}

/**
 * Enumerates every `contributes` string VS Code reads before activation and
 * would need to localise, deriving each site's nls key by the naming rule
 * this task fixes: `cmd.<id-tail>.title`, one shared `cmd.category`,
 * `submenu.<id-tail>.label`, `viewsWelcome.<viewId-tail>.contents`,
 * `config.<full property key>.description`, `config.title`,
 * `view.<viewId-tail>.name`, `container.title`.
 *
 * The **sole** derivation of "what in `package.json` is localisable" — H4.1
 * (the `%key%` swap in `package.json` itself) imports this rather than
 * re-deriving the site list, so the two halves of the localisation work can
 * never enumerate a different set of strings.
 *
 * @returns One entry per site (68 at this tip — many sharing the one
 *   `cmd.category` key), `key` derived and `value` the current literal.
 * @example
 * everyLocalisableManifestSites().length; // → 68
 */
export function everyLocalisableManifestSites(): ManifestSite[] {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
	) as PackageManifest;
	const sites: ManifestSite[] = [];

	for (const c of pkg.contributes.commands) {
		const tail = c.command.replace(/^md-artifacts\./, '');
		sites.push({ key: `cmd.${tail}.title`, value: c.title });
		if (c.category) { sites.push({ key: 'cmd.category', value: c.category }); }
	}
	for (const s of pkg.contributes.submenus) {
		const tail = s.id.replace(/^md-artifacts\.submenu\./, '');
		sites.push({ key: `submenu.${tail}.label`, value: s.label });
	}
	for (const v of pkg.contributes.viewsWelcome) {
		const tail = v.view.replace(/^md-artifacts\./, '');
		sites.push({ key: `viewsWelcome.${tail}.contents`, value: v.contents });
	}
	for (const [propKey, prop] of Object.entries(pkg.contributes.configuration.properties)) {
		sites.push({ key: `config.${propKey}.description`, value: prop.description });
	}
	sites.push({ key: 'config.title', value: pkg.contributes.configuration.title });
	for (const viewArr of Object.values(pkg.contributes.views)) {
		for (const v of viewArr) {
			const tail = v.id.replace(/^md-artifacts\./, '');
			sites.push({ key: `view.${tail}.name`, value: v.name });
		}
	}
	for (const vc of pkg.contributes.viewsContainers.activitybar) {
		sites.push({ key: 'container.title', value: vc.title });
	}
	return sites;
}
