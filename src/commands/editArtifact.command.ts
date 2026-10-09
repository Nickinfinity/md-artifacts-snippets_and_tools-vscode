import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { parseArtifactFile } from '../services/parser.service.js';
import { artifactToFormModel } from './create-prefill.helpers.js';
import { openArtifactFormPanel } from '../ui/panels/artifactForm/panel.js';
import { getVaultRootUri } from '../services/config.service.js';
import { isPathWithin } from '../utils/path-containment.js';
import { getCreateFormTypes } from '../services/artifact-type-config.service.js';
import { unsupportedEditReason } from './create-prefill.helpers.js';

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
    return vscode.commands.registerCommand(EDIT_ARTIFACT_COMMAND_ID, (filePath: unknown) => {
        if (typeof filePath !== 'string' || filePath.length === 0) {
            return;
        }
        const vaultRoot = getVaultRootUri();
        if (!vaultRoot) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not open artifact for editing: vault not configured.'));
            return;
        }
        // The path arrives from a registered command, so any extension can call
        // this with any path. It is subsequently written by the form's
        // save-in-place and trash-deleted by Delete Artifact, so containment is
        // checked here, before the read — the same rule every other write in
        // this repo routes through. Rejected, never sanitised.
        if (!isPathWithin(vaultRoot.fsPath, filePath)) {
            vscode.window.showErrorMessage(vscode.l10n.t('Refusing to edit a file outside the configured vault.'));
            return;
        }

        // `parseArtifactFile` answers null for an unreadable or malformed file
        // rather than throwing, so this is the only failure branch to handle.
        const parsed = parseArtifactFile(filePath, vaultRoot.fsPath);
        if (!parsed) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not read artifact: {0}', filePath));
            return;
        }
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
        // Refuse rather than silently drop content the form cannot round-trip.
        const blocked = unsupportedEditReason(parsed, readFileSync(filePath, 'utf-8'));
        if (blocked) {
            vscode.window.showWarningMessage(blocked);
            return;
        }
        openArtifactFormPanel(context, {
            mode:      'edit',
            type,
            prefill,
            sourceUri: vscode.Uri.file(filePath),
        });
    });
}
