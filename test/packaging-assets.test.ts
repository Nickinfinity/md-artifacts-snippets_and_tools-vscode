import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T6.3 guard: the i18n assets (`package.json`'s `l10n` pointer, the two
 * `package.nls*.json` manifests, and the two `l10n/bundle.l10n*.json`
 * runtime-string bundles) actually ship in the packaged `.vsix`.
 *
 * `.vscodeignore` decides what ships and tests run from source, so a green
 * suite never notices an excluded asset (CLAUDE.md, packaging section). This
 * suite is the static-file half of that contract; `npx vsce ls
 * --no-dependencies` (run manually — `vsce` cannot run inside the test
 * process) is the other half that proves the real packer agrees.
 */
suite('packaging: i18n assets ship', () => {

	// Compiled tests run from dist/test → repo root is two levels up.
	const ROOT = path.join(__dirname, '..', '..');

	test('package.json carries the l10n pointer', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
		) as { l10n?: string };
		assert.ok(pkg.l10n, 'package.json has no "l10n" pointer - vscode.l10n.t returns English forever');
	});

	test('every i18n asset file exists on disk', () => {
		for (const asset of ['package.nls.json', 'package.nls.es.json',
			'l10n/bundle.l10n.json', 'l10n/bundle.l10n.es.json']) {
			assert.ok(fs.existsSync(path.join(ROOT, asset)), `${asset} is missing`);
		}
	});

	test('.vscodeignore keeps the src/ui stylesheet and font globs, not named exceptions', () => {
		const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
		assert.match(ignore, /^!src\/ui\/\*\.css$/m, 'the stylesheet glob was narrowed to named files');
		assert.match(ignore, /^!src\/ui\/\*\.ttf$/m, 'the font glob was narrowed');
		assert.doesNotMatch(ignore, /^!src\/ui\/[a-z0-9-]+\.css$/m,
			'a named per-file exception - the next added stylesheet ships unstyled, silently');
	});

	/**
	 * Whether any active (non-comment, non-negation) `.vscodeignore` line
	 * excludes an asset matching `pattern`.
	 *
	 * The original guard anchored to column 0 with a fixed prefix
	 * (`/^package\.nls/m`, `/^l10n/m`), so `**\/l10n/**` or
	 * `**\/package.nls.json` — legal, common glob spellings — slipped past it
	 * entirely; both were proven to strip the assets from a real `vsce ls`
	 * while leaving the old guard green. This scans every line's *content*
	 * for the asset name, skipping only comments (`#`) and re-inclusions
	 * (`!`), so any exclusion spelling is caught regardless of anchoring.
	 *
	 * @param ignoreText - Raw `.vscodeignore` contents.
	 * @param pattern - Matches the asset name within a single line.
	 * @returns True if some exclusion line references the asset.
	 *
	 * @example
	 * excludesAsset('**\/l10n/**', /(^|\/)l10n(\/|$)/) // → true
	 * excludesAsset('!**\/l10n/**', /(^|\/)l10n(\/|$)/) // → false (negation)
	 */
	function excludesAsset(ignoreText: string, pattern: RegExp): boolean {
		return ignoreText.split('\n').some(line => {
			const trimmed = line.trim();
			if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) {
				return false;
			}
			return pattern.test(trimmed);
		});
	}

	test('.vscodeignore never excludes the nls or l10n bundles', () => {
		const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
		assert.strictEqual(excludesAsset(ignore, /package\.nls/), false,
			'the nls bundles are excluded from the package');
		assert.strictEqual(excludesAsset(ignore, /(^|\/)l10n(\/|$)/), false,
			'the l10n bundles are excluded from the package');
	});
});
