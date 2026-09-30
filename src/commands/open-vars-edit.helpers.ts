import * as vscode from 'vscode';
import * as path from 'node:path';
import { getVaultRootUri } from '../services/config.service.js';
import { validateVarSetForm } from '../services/varset-form.service.js';
import { writeVariablesFile } from '../services/variables-writer.service.js';
import { variablesFileToEditPayload, editPayloadToModel } from '../services/varset.service.js';
import { openVarSetFormPanel } from '../ui/panels/varsetForm/varsetForm.panel.js';
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
 * directory — `writeArtifact`'s containment check is performed *against* that
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
        // Edit mode never reaches validate/write — the panel's `mode` branch
        // routes it to writeEdit. Both are supplied inert because the bag's
        // members are required and making them optional would retype the
        // create path (varSetController.ts's handleSaveAsVarSet).
        validate: validateVarSetForm,
        write:    async () => { /* unreachable in edit mode */ },
        post:     () => {},
        close:    () => {},
        writeEdit: async p => {
            await writeVariablesFile({
                vaultRoot,
                chosenDir: vscode.Uri.joinPath(fileUri, '..'),
                fileName:  path.basename(artifact.filePath, '.md'),
                model:     editPayloadToModel(p, artifact),
            });
            onSaved?.();
        },
    }, { mode: 'edit', payload, sourceUri: fileUri });
}
