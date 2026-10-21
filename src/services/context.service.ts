import * as vscode from 'vscode';
import { ARTIFACTS } from '../types/constants.js';
import { isInContext, getCreateTypesForSurface, getAllTypes } from './artifact-type-config.service.js';
import { getEngine } from '../engine/engine.vscode.js';
import type { EngineResult } from '../types/engine.types.js';
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

type Surface = Exclude<ArtifactContext, 'all'>;
const SURFACES: readonly Surface[] = ['editor', 'terminal', 'explorer'];

/**
 * Pure derivation of every context key from the engine's `types.list` rows.
 *
 * Keys: `vaultConfigured` (rows present: `types.list` fails with `vault.not_selected`
 * exactly when no vault is set), `<dir>Active` per artifact (`enabled && dirExists` —
 * the engine's `enabled` already folds the override, and a disabled type's folder stays),
 * and the `<surface>HasMultiple` / `<surface>CreateHasMultiple` counts (>= 2 -> submenu).
 *
 * @param rows - `types.list` result, or `null` when the engine could not answer.
 * @returns Full `md-artifacts.*` key/value pairs, `vaultConfigured` first.
 * @example
 * contextKeysFor(null); // every key false
 */
export function contextKeysFor(rows: EngineResult<'types.list'> | null): ReadonlyArray<readonly [string, boolean]> {
	const known = new Set<string>(getAllTypes());
	const active = new Set<ArtifactType>(
		(rows ?? []).filter(r => known.has(r.type) && r.enabled && r.dirExists).map(r => r.type));
	const keys: Array<readonly [string, boolean]> = [[`${CTX}.vaultConfigured`, rows !== null]];
	for (const a of ARTIFACTS) { keys.push([artifactContextKey(a.dir), active.has(a.type)]); }
	const count = (types: readonly ArtifactType[]) => types.filter(t => active.has(t)).length;
	// `isInContext` / `getCreateTypesForSurface` are THE surface rules; no re-check here.
	for (const s of SURFACES) {
		keys.push([`${CTX}.${s}HasMultiple`, count(getAllTypes().filter(t => isInContext(t, s))) >= 2]);
	}
	for (const s of SURFACES) {
		keys.push([`${CTX}.${s}CreateHasMultiple`, count(getCreateTypesForSurface(s)) >= 2]);
	}
	return keys;
}

/**
 * Asks the engine which types are active and refreshes all vault-related context keys.
 *
 * A background read: engine unavailable / no vault / any throw degrades to all keys
 * false, never rejects and never toasts. Call on activation, on config change and
 * after the settings panel writes.
 *
 * @param setContext - Injected sink (default: the `setContext` command).
 * @returns {Promise<void>}
 * @example
 * await refreshVaultContext();
 */
export async function refreshVaultContext(
	setContext: (key: string, value: boolean) => Thenable<unknown> =
		(k, v) => vscode.commands.executeCommand('setContext', k, v),
): Promise<void> {
	let rows: EngineResult<'types.list'> | null = null;
	try {
		// getEngine() throws synchronously, so it must sit inside the try.
		rows = await getEngine().request('types.list', {});
	} catch {
		rows = null;
	}
	for (const [k, v] of contextKeysFor(rows)) { await setContext(k, v); }
}
