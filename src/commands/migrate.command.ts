import * as vscode from 'vscode';
import { getVaultPath } from '../services/config.service.js';
import { validateObsidianVault } from '../services/vault.service.js';
import { applyMigration, planMigration, type MigrationPlan } from '../services/frontmatter-migration.service.js';

/** Lazily-created singleton so re-running the command reuses one panel instead of stacking new ones. */
let migrationChannel: vscode.OutputChannel | undefined;

/**
 * Returns the shared output channel the migration report is printed to,
 * creating it on first use.
 *
 * @returns The `'MD Artifacts: Migration'` output channel.
 *
 * @example
 * getMigrationChannel().appendLine('...');
 */
function getMigrationChannel(): vscode.OutputChannel {
    migrationChannel ??= vscode.window.createOutputChannel('MD Artifacts: Migration');
    return migrationChannel;
}

/**
 * Prints the dry-run report — one line per file — to the migration output channel.
 *
 * @param plan - The plan just computed by `planMigration`.
 * @returns void
 *
 * @example
 * printDryRunReport(planMigration(vaultPath));
 */
function printDryRunReport(plan: MigrationPlan): void {
    const channel = getMigrationChannel();
    channel.clear();
    channel.appendLine(`MD Artifacts: Migrate Vault Frontmatter — dry run (${plan.changes.length} file(s) would change)`);
    for (const change of plan.changes) {
        channel.appendLine(`  ${change.relativePath}: "${change.oldLine}" -> "${change.newLine}"`);
    }
    if (plan.skipped.length > 0) {
        channel.appendLine(`Could not understand ${plan.skipped.length} file(s) — left untouched:`);
        for (const skip of plan.skipped) {
            channel.appendLine(`  ${skip.relativePath}: ${skip.reason}`);
        }
    }
    channel.show(true);
}

/**
 * Registers the `md-artifacts.migrateFrontmatter` command.
 *
 * Every invocation starts with a dry run: `planMigration` is read-only, and
 * its report is printed to the `'MD Artifacts: Migration'` output
 * channel before anything is written. Applying requires the user to accept an
 * explicit modal confirmation naming the file count — dismissing it (Cancel
 * or Escape) leaves the vault untouched, so "dry-run first" is not a mode
 * someone can forget to pass, it is the only thing the command can do without
 * that extra click.
 *
 * @param context - Extension context used to register the disposable subscription.
 * @returns void
 *
 * @example
 * // Called once inside activate():
 * registerMigrateCommand(context);
 */
export function registerMigrateCommand(context: vscode.ExtensionContext): void {
    const disposable = vscode.commands.registerCommand('md-artifacts.migrateFrontmatter', async () => {
        const vaultPath = getVaultPath();
        if (!vaultPath) {
            void vscode.window.showErrorMessage(vscode.l10n.t('MD Artifacts: No vault configured. Open Settings to select your vault.'));
            return;
        }
        if (!validateObsidianVault(vaultPath)) { return; }

        const plan = planMigration(vaultPath);
        if (plan.changes.length === 0 && plan.skipped.length === 0) {
            void vscode.window.showInformationMessage(
                vscode.l10n.t('MD Artifacts: vault frontmatter is already up to date — nothing to migrate.'),
            );
            return;
        }

        printDryRunReport(plan);

        if (plan.changes.length === 0) {
            void vscode.window.showWarningMessage(
                vscode.l10n.t('MD Artifacts: found {0} file(s) with unrecognised frontmatter — nothing to apply. See the "MD Artifacts: Migration" output panel.', plan.skipped.length),
            );
            return;
        }

        const confirmLabel = vscode.l10n.t('Apply Migration');
        const confirmed = await vscode.window.showWarningMessage(
            vscode.l10n.t('MD Artifacts: rewrite frontmatter in {0} vault file(s)? See the "MD Artifacts: Migration" output panel for the full dry-run report.', plan.changes.length),
            { modal: true },
            confirmLabel,
        );
        if (confirmed !== confirmLabel) { return; }

        const result = applyMigration(plan);
        getMigrationChannel().appendLine(`Applied: ${result.changedFiles.length} file(s) rewritten.`);
        void vscode.window.showInformationMessage(
            vscode.l10n.t('MD Artifacts: migrated {0} file(s). See the output panel for details.', result.changedFiles.length),
        );
    });
    context.subscriptions.push(disposable);
}
