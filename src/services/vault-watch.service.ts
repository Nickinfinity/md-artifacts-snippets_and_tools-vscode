import * as vscode from 'vscode';

/**
 * The session vault and the one watcher on it. The engine sends no change
 * notifications (PROTOCOL: `vault.changed` is reserved, not built), so caches
 * are invalidated from here. Imports only `vscode` — `config.service` and
 * `engine.vscode` import *this*, never the reverse.
 */

let sessionVault: string | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Listeners outlive the watcher: it is re-created per vault, they subscribe once (often before any vault). */
const listeners = new Set<() => void>();

/** Debounced fan-out; one burst of file events (a sync, a git checkout) fires listeners once. */
function fire(): void {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => { timer = undefined; listeners.forEach(l => l()); }, 150);
}

/**
 * Sets the vault the engine session is using, and re-points the watcher at it.
 *
 * @param path - Absolute vault root, or `undefined` when no vault is selected.
 * @returns Nothing.
 * @example
 * setSessionVault((await requestOrNotify('config.get', {}))?.vault);
 */
export function setSessionVault(path: string | undefined): void {
    if (path === sessionVault) { return; }
    sessionVault = path;
    watcher?.dispose();
    watcher = undefined;
    if (path === undefined) { return; }
    watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path), '**/*.md'));
    watcher.onDidCreate(fire);
    watcher.onDidChange(fire);
    watcher.onDidDelete(fire);
    fire();
}

/**
 * The in-memory session vault (no I/O, no engine round trip).
 *
 * @returns The absolute vault root, or `undefined` when none is selected.
 * @example
 * const root = getSessionVault();
 */
export function getSessionVault(): string | undefined {
    return sessionVault;
}

/**
 * Subscribes to "something under the vault changed" — file events or a vault switch.
 *
 * @param listener - Called (debounced 150 ms) after a change.
 * @returns Disposable that unsubscribes.
 * @example
 * context.subscriptions.push(onVaultChanged(() => getVarSetScanner().invalidate()));
 */
export function onVaultChanged(listener: () => void): vscode.Disposable {
    listeners.add(listener);
    return new vscode.Disposable(() => { listeners.delete(listener); });
}
