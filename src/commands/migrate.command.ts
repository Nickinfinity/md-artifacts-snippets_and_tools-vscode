import * as vscode from 'vscode';
import { requestOrNotify } from '../engine/engine.vscode.js';
import { engineErrorMessage } from '../engine/errors.js';
import { confirmModal } from '../services/confirm.service.js';
import { sendWrite } from '../services/conflict.service.js';
import type { EngineResult } from '../types/engine.types.js';

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

type Plan = EngineResult<'migrate.frontmatter.plan'>;

/** Appends one line to the migration channel. */
const channelLog = (line: string): void => getMigrationChannel().appendLine(line);

/**
 * Prints the dry-run report — one line per file — to the migration output channel.
 *
 * @param plan - The plan the engine just returned.
 * @param log  - Line sink (the channel by default).
 * @returns void
 *
 * @example
 * printDryRunReport(plan, channelLog);
 */
function printDryRunReport(plan: Plan, log: (line: string) => void): void {
    log(`MD Artifacts: Migrate Vault Frontmatter — dry run (${plan.changes.length} file(s) would change)`);
    // path is vault-relative POSIX: printed, never resolved to disk
    for (const change of plan.changes) {
        log(`  ${change.path}: "${change.oldLine}" -> "${change.newLine}"`);
    }
    if (plan.skipped.length > 0) {
        log(`Could not understand ${plan.skipped.length} file(s) — left untouched:`);
        for (const skip of plan.skipped) {
            log(`  ${skip.path}: ${engineErrorMessage(skip)}`);
        }
    }
}

/**
 * Plans a frontmatter migration through the engine, asks `confirm`, then applies exactly the planned files.
 *
 * @param confirm - Resolves true to apply `n` files.
 * @param log     - Report line sink; defaults to the migration output channel (cleared and shown first).
 * @returns Resolves once done or declined.
 *
 * @example
 * await runMigrateFrontmatter(async n => n > 0);
 */
export async function runMigrateFrontmatter(confirm: (n: number) => Promise<boolean>, log?: (line: string) => void): Promise<void> {
    if (!log) {
        getMigrationChannel().clear();
        getMigrationChannel().show(true);
    }
    const out = log ?? channelLog;
    const plan = await requestOrNotify('migrate.frontmatter.plan', {});
    if (!plan) { return; }
    if (plan.changes.length === 0 && plan.skipped.length === 0) {
        const msg = vscode.l10n.t('MD Artifacts: vault frontmatter is already up to date — nothing to migrate.');
        out(msg);
        void vscode.window.showInformationMessage(msg);
        return;
    }
    printDryRunReport(plan, out);
    if (plan.changes.length === 0) {
        void vscode.window.showWarningMessage(
            vscode.l10n.t('MD Artifacts: found {0} file(s) with unrecognised frontmatter — nothing to apply. See the "MD Artifacts: Migration" output panel.', plan.skipped.length),
        );
        return;
    }
    if (!await confirm(plan.changes.length)) { return; }

    const result = await sendWrite('migrate.frontmatter.apply', { files: plan.changes.map(({ path, hash }) => ({ path, hash })) });
    if (!result) { return; }
    for (const r of result.results) {
        if (r.status === 'skipped') { out(`  skipped ${r.path}: ${engineErrorMessage(r)}`); }
    }
    out(`Applied: ${result.written} file(s) rewritten, ${result.skipped} skipped.`);
    void vscode.window.showInformationMessage(
        vscode.l10n.t('MD Artifacts: migrated {0} file(s). See the output panel for details.', result.written),
    );
}

/**
 * Registers the `md-artifacts.migrateFrontmatter` command.
 *
 * Every invocation starts with a dry run: the engine's migration plan is read-only, and
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
    const disposable = vscode.commands.registerCommand('md-artifacts.migrateFrontmatter', () => runMigrateFrontmatter(n => confirmModal({
        message: vscode.l10n.t('MD Artifacts: rewrite frontmatter in {0} vault file(s)? See the "MD Artifacts: Migration" output panel for the full dry-run report.', n),
        action: vscode.l10n.t('Apply Migration'),
    })));
    context.subscriptions.push(disposable);
}
