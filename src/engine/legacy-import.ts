import type { ArtifactType } from '../types/parsed-artifact.types.js';
import type { EngineResult } from '../types/engine.types.js';

/** One engine call the caller should send, in order. */
export type ImportStep =
    | { readonly op: 'vault.select'; readonly path: string; readonly createDefaults: false }
    | { readonly op: 'types.set_enabled'; readonly type: ArtifactType; readonly enabled: boolean };

/**
 * Pure plan for the one-time legacy-settings import (O-4). The engine's own config wins;
 * only a legacy vault that inspects as an Obsidian vault is selected, and never with dir creation.
 *
 * @param input Engine config source, legacy settings, engine defaults and the inspect result.
 *   `defaults` must come from `getEngine().info.types[].defaultEnabled` (engine registry order,
 *   which fixes the step order); skip the import when `info` is undefined rather than passing `{}`.
 * @returns Steps to send; empty = nothing to import.
 * @example planLegacyImport({ engineSource: 'default', ... }) // []
 */
export function planLegacyImport(input: {
    engineSource: EngineResult<'config.get'>['source'];
    legacyVaultPath: string;
    legacyFlags: Partial<Record<ArtifactType, boolean>>;
    alreadyImported: boolean;
    defaults: Partial<Record<ArtifactType, boolean>>;
    inspect?: { isObsidianVault: boolean };
}): readonly ImportStep[] {
    const { engineSource, legacyVaultPath, legacyFlags, alreadyImported, defaults, inspect } = input;
    if (engineSource !== 'none' || alreadyImported || !legacyVaultPath || !inspect?.isObsidianVault) {
        return [];
    }
    const steps: ImportStep[] = [{ op: 'vault.select', path: legacyVaultPath, createDefaults: false }];
    for (const type of Object.keys(defaults) as ArtifactType[]) {
        const enabled = legacyFlags[type];
        if (enabled !== undefined && enabled !== defaults[type]) {
            steps.push({ op: 'types.set_enabled', type, enabled });
        }
    }
    return steps;
}
