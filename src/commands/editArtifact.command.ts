import * as vscode from 'vscode';
import { requestOrNotify } from '../engine/engine.vscode.js';
import { toParsedArtifactFile, toVaultPath } from '../engine/adapt.js';
import { artifactToFormModel } from './create-prefill.helpers.js';
import { openArtifactFormPanel } from '../ui/panels/artifactForm/panel.js';
import { getVaultRootUri } from '../services/config.service.js';
import { getCreateFormTypes } from '../services/artifact-type-config.service.js';

/** Command id the preview pane's Edit action runs. */
export const EDIT_ARTIFACT_COMMAND_ID = 'md-artifacts.editArtifact';

/**
 * Registers the edit-artifact command.
 *
 * Exists as a command rather than a direct call because `openArtifactFormPanel`
 * needs the `ExtensionContext`, which the preview controller does not carry —
 * the same reason every create entry point is a command. Routing Edit through
 * here means editing opens the *same* panel, in the same editor column, as
 * creating: one form, two modes.
 *
 * @param context - Extension context, forwarded to the form panel.
 * @returns The command registration, for `context.subscriptions`.
 *
 * @example
 * context.subscriptions.push(registerEditArtifactCommand(context));
 */
export function registerEditArtifactCommand(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand(EDIT_ARTIFACT_COMMAND_ID, async (filePath: unknown) => {
        if (typeof filePath !== 'string' || filePath.length === 0) {
            return;
        }
        const vaultRoot = getVaultRootUri();
        if (!vaultRoot) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not open artifact for editing: vault not configured.'));
            return;
        }
        // The path arrives from a registered command, so any extension can call
        // this with any path. It is subsequently written and deleted by the form
        // through the engine, so containment is checked here, before the read.
        // `toVaultPath` answers `undefined` for outside-the-vault; rejected, never sanitised.
        const rel = toVaultPath(filePath, vaultRoot.fsPath);
        if (rel === undefined) {
            vscode.window.showErrorMessage(vscode.l10n.t('Refusing to edit a file outside the configured vault.'));
            return;
        }

        // `requestOrNotify` toasts an engine failure and answers `undefined`.
        const read = await requestOrNotify('artifact.read', { path: rel });
        if (!read) { return; }
        const parsed = toParsedArtifactFile(read, vaultRoot.fsPath);
        const prefill = artifactToFormModel(parsed);
        const type = prefill.artifactType;
        if (!type) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not open artifact for editing: unrecognised artifact type.'));
            return;
        }
        // Gated against the same list the form is built from — `getFormConfig`
        // throws for a non-create-form type (Variables), which would surface as
        // an unhandled command failure rather than a message.
        if (!getCreateFormTypes().includes(type)) {
            vscode.window.showWarningMessage(vscode.l10n.t('{0} artifacts have no form — open the .md directly to edit one.', type));
            return;
        }
        openArtifactFormPanel(context, {
            mode:      'edit',
            type,
            prefill,
            sourceUri: vscode.Uri.file(filePath),
            read:      parsed,
        });
    });
}
