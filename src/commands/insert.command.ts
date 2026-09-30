import * as vscode from 'vscode';
import { ARTIFACTS } from '../types/constants.js';
import type { Artifact } from '../types/artifact.types.js';
import { openArtifactPicker } from '../ui/panels/artifactPicker.panel.js';
import type { InvocationSurface } from '../ui/panels/artifactPicker/preview.helpers.js';

/**
 * Derives the VS Code command ID for an artifact's insert command.
 *
 * Pattern: `md-artifacts.insert.<dir.toLowerCase()>`
 *
 * This pattern must stay in sync with the command IDs declared in `package.json`
 * (`contributes.commands`) and the menu entries that reference them. Adding a new
 * artifact to `ARTIFACTS` requires adding a matching entry in `package.json` —
 * the TypeScript handler is registered automatically via the loop below.
 *
 * @param dir - The artifact's `dir` field (e.g. `'Snippets'`, `'AIAgentsConf'`).
 * @returns The fully-qualified VS Code command ID string.
 *
 * @example
 * artifactCommandId('Snippets')   // → 'md-artifacts.insert.snippets'
 * artifactCommandId('AIAgentsConf') // → 'md-artifacts.insert.aiagentsconf'
 */
export function artifactCommandId(dir: string): string {
    return `md-artifacts.insert.${dir.toLowerCase()}`;
}

/**
 * Derives the sibling command ID registered for the **terminal** context menu
 * of a both-context artifact (`contexts` containing both `'editor'` and
 * `'terminal'`, e.g. `AIPrompt`).
 *
 * `vscode.window.activeTerminal` is a recency value, not a focus predicate
 * (VS Code exposes no terminal-focus API), so T3 cannot resolve the insert
 * target from live focus state. Instead the invocation surface is captured
 * statically: a distinct command ID per surface, wired to a distinct
 * `package.json` menu entry, tells `performInsert` which menu the user
 * actually clicked.
 *
 * @param dir - The artifact's `dir` field (e.g. `'AIPrompts'`).
 * @returns The fully-qualified terminal-surface command ID string.
 *
 * @example
 * artifactTerminalCommandId('AIPrompts') // → 'md-artifacts.insert.aiprompts.terminal'
 */
export function artifactTerminalCommandId(dir: string): string {
    return `${artifactCommandId(dir)}.terminal`;
}

/**
 * Dynamically registers one VS Code insert command per artifact defined in `ARTIFACTS`.
 *
 * ### Architecture — why one loop produces multiple command IDs
 *
 * VS Code derives the label shown in a context menu **exclusively** from the
 * `title` field of the matching entry in `contributes.commands` (in `package.json`).
 * Per-item title overrides in `contributes.menus` entries are silently ignored.
 * Therefore, showing "Insert Snippets", "Insert Templates", etc. as distinct labels
 * requires a distinct command ID for each artifact — there is no other VS Code mechanism.
 *
 * At the TypeScript level this is still architecturally "one command":
 * - One registration function (`registerInsertCommands`)
 * - One loop over `ARTIFACTS` — adding an artifact to constants auto-registers its handler
 * - One shared handler function (`openArtifactPicker`)
 * - Zero hardcoded artifact names — every string comes from `ARTIFACTS`
 *
 * The `package.json` command entries are the one static piece; they must mirror `ARTIFACTS`
 * because VS Code reads `package.json` before the extension activates.
 *
 * ### Variables — special context behaviour
 *
 * `Variables` has `contexts: ['all']` in `ARTIFACTS`, meaning its command
 * (`insert.variables`) appears in every context surface (editor, terminal, explorer).
 * In `package.json` it is placed in group `"2_variables@1"` while all other artifacts
 * use `"1_insert@N"` — VS Code renders different groups with a visual separator, so
 * Variables always appears at the bottom of the MD Artifacts submenu or as a
 * standalone entry below the other artifacts when only it is active.
 *
 * ### Visibility — single entry vs. submenu
 *
 * Each context surface (`editor/context`, `terminal/context`, `explorer/context`) shows:
 * - A **direct menu entry** for each active artifact when only one is active in that surface
 *   (`!md-artifacts.<surface>HasMultiple`).
 * - The **"MD Artifacts" submenu** when two or more artifacts are active in that
 *   surface (`md-artifacts.<surface>HasMultiple`).
 *
 * These `when` clauses and the `*HasMultiple` context keys are managed by `context.service.ts`.
 *
 * @param context - Extension context used to register disposable subscriptions.
 * @returns void
 *
 * @example
 * // Called once inside activate():
 * registerInsertCommands(context);
 */
export function registerInsertCommands(context: vscode.ExtensionContext): void {
    // One iteration per artifact — command ID and display name come entirely from ARTIFACTS.
    // No artifact name, dir, or label is hardcoded in this file.
    // storageUri is workspace-scoped (undefined with no folder open) — fall back to
    // the always-defined globalStorageUri so block-edit temp files have a home.
    const storageUri = context.storageUri ?? context.globalStorageUri;

    // VS Code passes (uri, uris[]) to an Explorer context-menu command. Forward
    // the invoked URI so the Template "Insert Template" flow can resolve
    // its destination (D2); multi-select uses the first entry. Non-template
    // commands are invoked without a URI and openArtifactPicker only consults
    // destUri in the template create-file path — their behaviour is unchanged.
    const register = (commandId: string, artifact: Artifact, surface: InvocationSurface): void => {
        const disposable = vscode.commands.registerCommand(
            commandId,
            (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
                const destUri = uris?.[0] ?? uri;
                void openArtifactPicker(artifact.dir, artifact.name, context.extensionUri, storageUri, destUri, surface);
            },
        );
        context.subscriptions.push(disposable);
    };

    for (const artifact of ARTIFACTS) {
        // ponytail: the invocation surface is captured statically from which command id
        // fired, not a live focus read — VS Code exposes no terminal-focus predicate, and
        // a Command Palette invocation has no menu to speak of, so it defaults to 'editor'.
        // Upgrade only if VS Code ever exposes a real terminal-focus API.
        register(artifactCommandId(artifact.dir), artifact, 'editor');

        // Both-context types (only AIPrompt today) get a dedicated terminal-surface
        // command — package.json points the terminal menus at this id instead of the
        // base one, so performInsert can tell which menu the user actually clicked (T3).
        if (artifact.contexts.includes('editor') && artifact.contexts.includes('terminal')) {
            register(artifactTerminalCommandId(artifact.dir), artifact, 'terminal');
        }
    }
}
