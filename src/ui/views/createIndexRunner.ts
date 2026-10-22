/**
 * `runCreateIndex` — scaffolds a template index through ONE engine `index.create`.
 * The engine writes the siblings and the index, dedupes names and reports an
 * existing file as a per-step skip; this module only picks the folder, converts
 * it to a vault path and tallies the Batch.
 *
 * 🔒 Containment: the picked folder must sit inside the vault (`isWithinRoot`)
 * and convert through `toVaultPath` BEFORE any request; otherwise zero requests.
 */
import * as vscode from 'vscode';
import { sendWrite } from '../../services/conflict.service.js';
import { summariseRun } from '../../services/multi-index.service.js';
import { toVaultPath } from '../../engine/adapt.js';
import { isWithinRoot } from '../panels/destFolderPicker.panel.js';
import type { RunTally } from '../../types/multi-index.types.js';

/** Callback bag: containment root and the destination prompt. */
export interface CreateIndexCallbacks {
    /** Vault root Uri — the containment root for the one destination check. */
    vaultRoot: vscode.Uri;
    /** Prompts once for this run's destination folder; `undefined` means the user cancelled. */
    pickDest: () => Promise<vscode.Uri | undefined>;
}

/** `runCreateIndex`'s result — the tally plus the ready-to-show summary line. */
export interface CreateIndexRunResult {
    readonly tally: RunTally;
    readonly message: string;
}

/**
 * Sends one `index.create` for `input.paths` into a user-picked vault folder.
 * Cancel, out-of-vault pick or a told engine error ⇒ `aborted: true`, nothing written.
 *
 * @param input - Index type and the captured source paths.
 * @param cb - Vault root and destination prompt.
 * @returns The run's tally and a ready-to-show summary line.
 *
 * @example
 * const { message } = await runCreateIndex({ type: 'Template', paths: ['a.ts'] }, { vaultRoot, pickDest });
 */
export async function runCreateIndex(
    input: { type: 'Template' | 'AIAgentsConfig'; paths: readonly string[] },
    cb: CreateIndexCallbacks,
): Promise<CreateIndexRunResult> {
    const chosen = await cb.pickDest();
    const dir = chosen && isWithinRoot(cb.vaultRoot, chosen)
        ? (chosen.fsPath === cb.vaultRoot.fsPath ? '' : toVaultPath(chosen.fsPath, cb.vaultRoot.fsPath))
        : undefined;
    if (dir === undefined) { return finish({ written: 0, skipped: 0, aborted: true }); }

    const batch = await sendWrite('index.create', { type: input.type, dir, paths: input.paths });
    if (!batch) { return finish({ written: 0, skipped: 0, aborted: true }); }
    return finish({ written: batch.written, skipped: batch.skipped, aborted: false });
}

/**
 * Builds the `{ tally, message }` pair — the one `summariseRun` call site.
 *
 * @param tally - The run's final counts.
 * @returns `{ tally, message }`.
 *
 * @example
 * finish({ written: 2, skipped: 0, aborted: false });
 */
function finish(tally: RunTally): CreateIndexRunResult {
    return { tally, message: summariseRun(tally, 'Create index') };
}
