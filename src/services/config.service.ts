import * as vscode from 'vscode';
import { normalizeStepCount } from './pane-width.service.js';
import { clampVarsHeightFraction } from './pane-layout.service.js';

/** Manifest default for `mainPane.previewWidthSteps` — mirrored in `package.json`. */
const DEFAULT_PREVIEW_WIDTH_STEPS = 3;

/**
 * VS Code settings section name for this extension.
 *
 * The single source of truth for the section string literal — every
 * `getConfiguration` / `affectsConfiguration` call in the extension routes
 * through this constant so the section can be renamed in one place.
 *
 * @example
 * vscode.workspace.getConfiguration(CONFIG_SECTION)
 */
export const CONFIG_SECTION = 'mdArtifacts';

/**
 * Reads the configured vault path from VS Code settings, trimmed.
 *
 * The single vault-path reader for the whole extension — every site that
 * used to open-code `getConfiguration('mdArtifacts').get<string>(...)`
 * calls this instead.
 *
 * @returns The trimmed `mdArtifacts.vaultPath` setting, or `''` when unset.
 *
 * @example
 * const vaultPath = getVaultPath();
 * if (!vaultPath) { return; }
 */
export function getVaultPath(): string {
    return vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<string>('vaultPath', '')
        .trim();
}

/**
 * Resolves the configured vault path to a `vscode.Uri`.
 *
 * @returns `vscode.Uri.file(getVaultPath())` when a vault is configured,
 *          otherwise `undefined`.
 *
 * @example
 * const root = getVaultRootUri();
 * if (root) { vscode.Uri.joinPath(root, 'Snippets'); }
 */
export function getVaultRootUri(): vscode.Uri | undefined {
    const vaultPath = getVaultPath();
    return vaultPath.length > 0 ? vscode.Uri.file(vaultPath) : undefined;
}

/**
 * Reads how far the main pane widens when a preview opens, in widen steps.
 *
 * A step count rather than a width because VS Code exposes no API to set or
 * read a view's width (plan §1) — the same number of narrow steps restores
 * the previous width without ever reading it. Normalised through
 * `pane-width.service`'s own rule, so a hand-edited `settings.json` that VS
 * Code did not enforce against the manifest schema cannot produce a negative
 * or fractional loop count.
 *
 * @returns A whole step count `>= 0`; `0` disables the resize.
 *
 * @example
 * new PaneWidthController(runner, getPreviewWidthSteps());
 */
export function getPreviewWidthSteps(): number {
    return normalizeStepCount(
        vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<number>('mainPane.previewWidthSteps', DEFAULT_PREVIEW_WIDTH_STEPS),
    );
}

/**
 * Reads the variables-section height as a fraction of the pane height.
 *
 * Validated through `pane-layout.service`'s bounds — persisted settings are
 * untrusted input, so an out-of-range or mistyped value resolves to the
 * default rather than collapsing the section or swallowing the pane.
 *
 * @returns A fraction within the service's min/max bounds.
 *
 * @example
 * varsHeightCss(getVariablesHeightFraction()); // → '16.666666666666664vh'
 */
export function getVariablesHeightFraction(): number {
    return clampVarsHeightFraction(
        vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<number>('mainPane.variablesHeightFraction'),
    );
}

/**
 * Persists the variables-section height fraction.
 *
 * Clamped through `pane-layout.service` before it is written, because the
 * value arrives from a drag in the webview — untrusted input, and this is the
 * boundary. Written globally so the chosen height follows the user across
 * windows and survives a reload, which is what "remembers the size" means.
 *
 * `settings.panel.ts` remains the only *panel* that writes this section; this
 * is the one programmatic writer, and it lives here beside the matching reader
 * rather than reaching into the section from a UI file.
 *
 * @param fraction - Candidate fraction from the drag handle.
 * @returns Resolves once the setting is stored.
 *
 * @example
 * await setVariablesHeightFraction(0.28);
 */
export async function setVariablesHeightFraction(fraction: unknown): Promise<void> {
    await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(
            'mainPane.variablesHeightFraction',
            clampVarsHeightFraction(fraction),
            vscode.ConfigurationTarget.Global,
        );
}
