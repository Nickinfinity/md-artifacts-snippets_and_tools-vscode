import * as path from 'node:path';
import * as vscode from 'vscode';
import { getEngine, notifyEngineError } from '../engine/engine.vscode.js';
import { EngineRequestError } from '../engine/request-error.js';
import type { EngineParams, EngineResult } from '../types/engine.types.js';
import { confirmModal } from './confirm.service.js';

/** Engine write ops routed through `sendWrite`. `artifact.write_file` is absent: it owns its own exists loop. */
export type WriteMethod = 'artifact.create' | 'artifact.update' | 'artifact.patch' | 'artifact.delete'
    | 'vars.file.new' | 'vars.meta.tags' | 'vars.subset.add' | 'vars.subset.rename' | 'vars.subset.describe'
    | 'vars.subset.delete' | 'vars.var.add' | 'vars.var.rename' | 'vars.var.set' | 'vars.var.delete'
    | 'varsets.save' | 'index.create' | 'migrate.frontmatter.apply';

/** Callback bag shared by both entry points. */
type Opts = { readonly onReload?: () => unknown };

/**
 * THE write-error UX. `file.conflict` ⇒ one Reload / Cancel modal, never a re-send.
 * Every other engine error ⇒ the W1 toast. A non-engine throw rethrows.
 *
 * @param e    - What the request threw.
 * @param opts - `onReload` runs when the user picks Reload.
 * @returns Resolves once the user was told.
 * @example
 * try { await getEngine().request('artifact.update', p); } catch (e) { await handleWriteError(e); }
 */
export async function handleWriteError(e: unknown, opts: Opts = {}): Promise<void> {
    if (!(e instanceof EngineRequestError)) { throw e; }
    if (e.data.code !== 'file.conflict') { return notifyEngineError(e); }
    const file = path.posix.basename(e.data.params['path'] ?? '');
    const reload = await confirmModal({
        message: vscode.l10n.t('"{0}" changed on disk since it was opened.', file),
        action: vscode.l10n.t('Reload'),
    });
    if (reload) { await opts.onReload?.(); }
}

/**
 * Sends a vault write. Conflict ⇒ modal (no re-send); `file.exists` on `artifact.create` ⇒ confirm, then
 * `artifact.update` against the hash the engine reported; elsewhere `file.exists` ⇒ toast.
 *
 * @param method - A write op.
 * @param params - Its params.
 * @param opts   - `onReload` runs when the user picks Reload after a conflict.
 * @returns The result, or `undefined` when the user was told / declined.
 * @example
 * const r = await sendWrite('artifact.update', { path, expectedHash, model });
 */
export async function sendWrite<M extends WriteMethod>(method: M, params: EngineParams<M>, opts: Opts = {}): Promise<EngineResult<M> | undefined> {
    try {
        return await getEngine().request(method, params);
    } catch (e) {
        if (method === 'artifact.create' && e instanceof EngineRequestError && e.data.code === 'file.exists') {
            return overwrite(params as EngineParams<'artifact.create'>, e, opts) as Promise<EngineResult<M> | undefined>; // narrowing: M is 'artifact.create' here
        }
        await handleWriteError(e, opts);
        return undefined;
    }
}

/** Confirms, then replaces the existing file under the hash the engine just reported. */
async function overwrite(p: EngineParams<'artifact.create'>, e: EngineRequestError, opts: Opts): Promise<EngineResult<'artifact.update'> | undefined> {
    const actual = e.data.params['actual'];
    if (actual === undefined) { await notifyEngineError(e); return undefined; } // no hash to update against: never ask, never write
    const ok = await confirmModal({
        message: vscode.l10n.t('Overwrite "{0}"?', path.posix.basename(p.path)),
        action: vscode.l10n.t('Overwrite'),
    });
    if (!ok) { return undefined; }
    return sendWrite('artifact.update', { path: p.path, expectedHash: actual, model: p.model }, opts);
}
