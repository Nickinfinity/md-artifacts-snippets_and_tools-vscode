import * as vscode from 'vscode';
import { detectVaultDirs } from './vault.service.js';
import { ARTIFACTS } from '../types/constants.js';
import { getVaultPath } from './config.service.js';
import { isInContext, getCreateTypesForSurface } from './artifact-type-config.service.js';
import type { ArtifactContext } from '../types/artifact.types.js';
import type { ArtifactType } from '../types/parsed-artifact.types.js';

/** Prefix shared by all extension context keys — matches the VS Code settings namespace */
const CTX = 'md-artifacts';

/** Shorthand: fire a setContext command for a key relative to the extension prefix */
const setCtx = (key: string, val: unknown): Thenable<unknown> =>
	vscode.commands.executeCommand('setContext', `${CTX}.${key}`, val);

/**
 * Derives the VS Code context key name for a given artifact directory.
 *
 * Pattern: `md-artifacts.<dir.toLowerCase()>Active`
 * Must match the `when` clauses declared in package.json.
 *
 * @param {string} dir - The artifact `dir` field (e.g. `'Snippets'`, `'AIAgentsConf'`)
 * @returns {string} Fully-qualified context key
 */
export function artifactContextKey(dir: string): string {
	return `${CTX}.${dir.toLowerCase()}Active`;
}

/**
 * Sets all vault-related VS Code context keys based on the provided vault path.
 *
 * Keys are derived dynamically from `ARTIFACTS` — adding a new artifact to
 * constants.ts automatically produces the matching context key here.
 *
 * Keys set:
 * - `md-artifacts.vaultConfigured`            — true when a vault path is configured
 * - `md-artifacts.<dir.toLowerCase()>Active`  — true when that artifact dir exists on disk
 * - `md-artifacts.editorHasMultiple`          — true when ≥2 editor artifacts are active
 * - `md-artifacts.terminalHasMultiple`        — true when ≥2 terminal artifacts are active
 * - `md-artifacts.explorerHasMultiple`        — true when ≥2 explorer artifacts are active
 * - `md-artifacts.<surface>CreateHasMultiple` — true when ≥2 *create-capable*
 *   artifacts are active on that surface. A separate family from the insert keys
 *   above: a surface can offer one insert type and two create types, or the
 *   reverse, so one key cannot serve both menus.
 *
 * The `*HasMultiple` keys drive the single-vs-submenu logic in package.json menus:
 * one active artifact → direct labelled entry, two or more → "MD Artifacts" submenu.
 *
 * @param {string | null} vaultPath - Absolute path to the vault root, or null if unconfigured
 * @returns {Promise<void>}
 */
async function setVaultContextKeys(vaultPath: string | null): Promise<void> {
	await setCtx('vaultConfigured', vaultPath !== null);

	if (vaultPath === null) {
		// Vault not configured — clear all per-artifact and per-context keys
		for (const a of ARTIFACTS) {
			await vscode.commands.executeCommand('setContext', artifactContextKey(a.dir), false);
		}
		await setCtx('editorHasMultiple',   false);
		await setCtx('terminalHasMultiple', false);
		await setCtx('explorerHasMultiple', false);
		await setCtx('editorCreateHasMultiple',   false);
		await setCtx('terminalCreateHasMultiple', false);
		await setCtx('explorerCreateHasMultiple', false);
		return;
	}

	// Check which artifact directories currently exist on disk
	const dirs = detectVaultDirs(vaultPath);

	// Set one context key per artifact based on whether its directory exists
	for (const d of dirs) {
		await vscode.commands.executeCommand('setContext', artifactContextKey(d.dir), d.exists);
	}

	// Count active artifacts per VS Code context surface.
	// Used by package.json `when` clauses to choose between direct entries and submenus.
	// `isInContext` (artifact-type-config.service.ts) is THE `'all'`-matching rule.
	// This file carried a private copy until Wave 0 close; two bodies for one rule
	// is the drift `package-menus.test.ts` would only catch after it had shipped.
	const countActive = (surface: Exclude<ArtifactContext, 'all'>) =>
		dirs.filter(d => isInContext(d.type, surface) && d.exists).length;

	await setCtx('editorHasMultiple',   countActive('editor')   >= 2);
	await setCtx('terminalHasMultiple', countActive('terminal') >= 2);
	await setCtx('explorerHasMultiple', countActive('explorer') >= 2);

	// Create menus collapse on the same rule as insert, but over a different
	// population: create-capable types (createForm) rather than insert-capable
	// ones. Derived from the same §2 rule via getCreateTypesForSurface, so a new
	// createForm entry in ARTIFACTS reaches these keys with no edit here.
	const countCreate = (surface: Exclude<ArtifactContext, 'all'>) => {
		const createTypes: readonly ArtifactType[] = getCreateTypesForSurface(surface);
		return dirs.filter(d => d.exists && createTypes.includes(d.type)).length;
	};

	await setCtx('editorCreateHasMultiple',   countCreate('editor')   >= 2);
	await setCtx('terminalCreateHasMultiple', countCreate('terminal') >= 2);
	await setCtx('explorerCreateHasMultiple', countCreate('explorer') >= 2);
}

/**
 * Reads `mdArtifacts.vaultPath` from VS Code settings and refreshes
 * all vault-related VS Code context keys.
 *
 * VS Code settings are the single source of truth for the vault path — no
 * custom file storage is used. Settings Sync propagates the value across devices.
 *
 * Should be called:
 * 1. On extension activation — restores context from the previous session
 * 2. After any `mdArtifacts.*` setting changes (via onDidChangeConfiguration)
 * 3. After the config panel writes a new vault path or toggles a directory
 *
 * @returns {Promise<void>}
 *
 * @example
 * await refreshVaultContext();
 */
export async function refreshVaultContext(): Promise<void> {
	const vaultPath = getVaultPath();

	await setVaultContextKeys(vaultPath.length > 0 ? vaultPath : null);
}
