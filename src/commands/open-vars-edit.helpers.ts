import * as vscode from 'vscode';
import { getVaultRootUri } from '../services/config.service.js';
import { engineMeta, toEngineModel } from '../engine/model.js';
import { sendWrite } from '../services/conflict.service.js';
import { variablesFileToEditPayload, editPayloadToModel } from '../services/varset.service.js';
import { openVarSetFormPanel } from '../ui/panels/varsetForm/varsetForm.panel.js';
import type { VarsEditPayload } from '../types/varset.types.js';
import type { ParsedArtifactFile } from '../types/parsed-artifact.types.js';

/**
 * Opens a parsed Variables file in the var-set form's **edit** mode.
 *
 * THE single place the edit-mode callback bag is built. Both entry points route
 * here — the picker's accept handler (`navigator.ts`) and the Variables pane
 * (`variables.command.ts`) — so the write arguments, the vault-root guard and
 * the inert create-path members exist once rather than being copied per caller.
 *
 * The vault root is guarded **before** the panel opens: a throw inside
 * `writeEdit` would surface as an unhandled rejection in the webview message
 * loop rather than as an error the user sees.
 *
 * `vaultRoot` comes from `getVaultRootUri()` and never from the artifact's own
 * directory — the engine's containment check is performed *against* that
 * root, so substituting the file's own folder would neuter it.
 *
 * @param artifact     - The Variables file as the parser produced it.
 * @param extensionUri - Extension root, for the webview's `localResourceRoots`.
 * @param onSaved      - Optional; runs after a successful write (the pane passes its tree refresh).
 * @returns Resolves once the panel has been opened, or immediately when no vault is configured.
 *
 * @example
 * await openVarsEditForm(parsed, context.extensionUri, () => provider.refresh());
 */
export async function openVarsEditForm(
    artifact: ParsedArtifactFile,
    extensionUri: vscode.Uri,
    onSaved?: () => void,
): Promise<void> {
    const vaultRoot = getVaultRootUri();
    if (!vaultRoot) {
        void vscode.window.showErrorMessage(
            vscode.l10n.t('Variables directory is not configured. Open the Settings panel to enable it.'),
        );
        return;
    }

    const fileUri = vscode.Uri.file(artifact.filePath);
    const payload = variablesFileToEditPayload(artifact);

    openVarSetFormPanel(extensionUri, {
        // Edit mode never reaches write — the panel's `mode` branch routes it to
        // writeEdit. It is supplied inert because the bag's members are required
        // and making it optional would retype the create path.
        write:    async () => false, // unreachable in edit mode
        post:     () => {},
        close:    () => {},
        writeEdit: async (p, disposePanel) => {
            // Reload: drop the stale form (its hash would conflict forever) and refresh; the next open reads fresh.
            const ok = await saveVarsEdit(artifact, p, () => { disposePanel?.(); onSaved?.(); });
            if (ok) { onSaved?.(); }
            return ok;
        },
    }, { mode: 'edit', payload, sourceUri: fileUri });
}

/**
 * Saves an edit-form payload over the file it was read from, through the engine
 * with the hash of that read (conflict ⇒ modal, never an overwrite).
 *
 * @param artifact - The file as the engine read it (carries `relPath` / `hash` / `layout`).
 * @param payload  - The validated edit payload.
 * @param onReload - Runs when the user picks Reload on a conflict modal.
 * @returns `true` only when the engine wrote; `false` keeps the form open.
 *
 * @example
 * if (await saveVarsEdit(parsed, payload)) { refresh(); }
 */
export async function saveVarsEdit(artifact: ParsedArtifactFile, payload: VarsEditPayload, onReload?: () => unknown): Promise<boolean> {
    const meta = engineMeta(artifact);
    if (!meta) {
        void vscode.window.showErrorMessage(vscode.l10n.t('MD Artifacts: could not read "{0}".', artifact.filePath));
        return false;
    }
    const model = toEngineModel(editPayloadToModel(payload, artifact), artifact);
    return (await sendWrite('artifact.update', { path: meta.relPath, expectedHash: meta.hash, model }, { onReload })) !== undefined;
}
