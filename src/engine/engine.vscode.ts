import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ArtifactType } from '../types/parsed-artifact.types.js';
import type { EngineMethod, EngineParams, EngineProcess, EngineResult, SpawnFn } from '../types/engine.types.js';
import { getAllTypes, getEntry } from '../services/artifact-type-config.service.js';
import { getEngineDebug, getEnginePath } from '../services/config.service.js';
import { installHint, locateEngine } from './locate.js';
import { engineErrorMessage } from './errors.js';
import { EngineRequestError } from './request-error.js';
import { EngineSupervisor } from './supervisor.js';

/** The window's engine; `locateError` explains why there is none. Replaced wholesale by each `startEngine`. */
let sup: EngineSupervisor | undefined;
let locateError: EngineRequestError | undefined;
let channel: vscode.OutputChannel | undefined;
let traceWarned = false;
let showErrorSink: (msg: string, ...actions: string[]) => Thenable<string | undefined> = (m, ...a) => vscode.window.showErrorMessage(m, ...a);

/**
 * True for a regular file the process may run (posix: X bit; win32: file only). Any throw is false.
 *
 * @param absPath - Absolute candidate path.
 * @returns Whether it can be spawned.
 * @example
 * isExecutableFile('/usr/bin/env'); // true
 */
export function isExecutableFile(absPath: string): boolean {
    try {
        if (!fs.statSync(absPath).isFile()) { return false; }
        if (process.platform !== 'win32') { fs.accessSync(absPath, fs.constants.X_OK); }
        return true;
    } catch { return false; }
}

/**
 * The registry pairs the engine must report (the one expression; never a raw `ARTIFACTS` walk).
 *
 * @returns `(type, dir)` for every artifact type.
 * @example
 * engineKnownTypes()[0]; // { type: 'Snippet', dir: 'Snippets' }
 */
export function engineKnownTypes(): readonly { type: ArtifactType; dir: string }[] {
    return getAllTypes().map(type => ({ type, dir: getEntry(type).dir }));
}

/**
 * Real spawn: argv array, no shell. `'error'` (ENOENT, EACCES) and `'exit'` both route to one
 * `onExit` call, so a single death is never counted twice.
 *
 * @param binPath - Absolute binary path.
 * @param args - Argv, verbatim.
 * @returns The wrapped process.
 * @example
 * const proc = spawnEngineProcess('/opt/mda', ['serve']);
 */
export const spawnEngineProcess: SpawnFn = (binPath, args): EngineProcess => {
    const child = spawn(binPath, [...args], { stdio: 'pipe', shell: false, windowsHide: true });
    const handlers: ((code: number | null) => void)[] = [];
    let fired = false;
    const fire = (code: number | null): void => {
        if (fired) { return; }
        fired = true;
        handlers.forEach(h => h(code));
    };
    // Unhandled 'error' would crash the extension host; EPIPE after death lands on stdin.
    child.on('error', e => { getChannel().appendLine(`engine process error: ${e.message}`); fire(null); });
    child.stdin.on('error', e => getChannel().appendLine(`engine stdin error: ${e.message}`));
    child.on('exit', code => fire(code));
    return {
        stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
        kill: () => { child.kill(); },
        onExit: h => { handlers.push(h); },
    };
};

function getChannel(): vscode.OutputChannel {
    channel ??= vscode.window.createOutputChannel('MD Artifacts: Engine');
    return channel;
}

/**
 * Creates the window's supervisor from settings (or `deps`). Last call wins: the previous engine is
 * disposed first. Never throws; a locate failure is stored and surfaces from `getEngine()`.
 *
 * @param deps - Test overrides for spawn, binary, debug level and the error sink.
 * @returns Disposable that tears this engine down (no-op if superseded).
 * @example
 * context.subscriptions.push(startEngine());
 */
export function startEngine(deps: {
    spawn?: SpawnFn; enginePath?: string; debug?: 'off' | 'debug' | 'trace';
    showError?: (msg: string, ...actions: string[]) => Thenable<string | undefined>;
} = {}): vscode.Disposable {
    sup?.dispose();
    sup = undefined;
    locateError = undefined;
    const showError = deps.showError ?? ((m, ...a) => vscode.window.showErrorMessage(m, ...a));
    showErrorSink = showError;
    const debug = deps.debug ?? getEngineDebug();
    const found = locateEngine({
        settingPath: deps.enginePath ?? getEnginePath(), envPath: process.env['PATH'],
        platform: process.platform, isExecutableFile,
    });
    let mine: EngineSupervisor | undefined;
    if (found.kind === 'found') {
        const args = ['serve', ...(debug === 'off' ? [] : [debug === 'trace' ? '--debug=trace' : '--debug'])];
        mine = new EngineSupervisor({
            spawn: deps.spawn ?? spawnEngineProcess, binPath: found.path, args,
            knownTypes: engineKnownTypes(), log: l => getChannel().appendLine(l),
        });
        sup = mine;
        if (debug === 'trace' && !traceWarned) {
            traceWarned = true;
            void showError(vscode.l10n.t('Engine trace output may contain secrets (file contents, variable values).'));
        }
    } else {
        locateError = new EngineRequestError(found.kind === 'invalid-setting'
            ? { code: 'client.invalid_path', params: { path: found.path } }
            : { code: 'client.not_found', params: {} });
    }
    return new vscode.Disposable(() => {
        if (mine !== undefined && sup === mine) { sup = undefined; }
        mine?.dispose();
    });
}

/**
 * The window's supervisor.
 *
 * @returns The supervisor.
 * @throws EngineRequestError - The stored locate error, else `client.unavailable`.
 * @example
 * await getEngine().request('config.get', {});
 */
export function getEngine(): EngineSupervisor {
    if (sup) { return sup; }
    throw locateError ?? new EngineRequestError({ code: 'client.unavailable', params: {} });
}

/**
 * Runs a request; on an engine error shows the localised message (with Restart / install hint) and resolves `undefined`.
 *
 * @param method - Engine method.
 * @param params - Its params.
 * @returns The result, or `undefined` after the user was told.
 * @example
 * const cfg = await requestOrNotify('config.get', {});
 */
export async function requestOrNotify<M extends EngineMethod>(method: M, params: EngineParams<M>): Promise<EngineResult<M> | undefined> {
    const engine = sup;
    try {
        return await getEngine().request(method, params);
    } catch (e) {
        if (!(e instanceof EngineRequestError)) { throw e; }
        await notifyEngineError(e, engine);
        return undefined;
    }
}

/**
 * Shows an engine error the W1 way: localised message, install hint for a missing binary, Restart when unavailable.
 * Every caller that catches an `EngineRequestError` itself (the write path) reports through this, never its own toast.
 *
 * @param e      - The engine error.
 * @param engine - The supervisor that was asked (Restart targets it); defaults to the current one.
 * @returns Resolves once the user dismissed the message.
 * @example
 * try { await getEngine().request('artifact.update', p); } catch (e) { if (e instanceof EngineRequestError) { await notifyEngineError(e); } }
 */
export async function notifyEngineError(e: EngineRequestError, engine: EngineSupervisor | undefined = sup): Promise<void> {
    const { code } = e.data;
    const base = engineErrorMessage(e.data);
    const hint = code === 'client.not_found' || code === 'client.invalid_path';
    const msg = hint ? vscode.l10n.t('{0} Install: {1}', base, installHint(process.platform)) : base;
    const restart = vscode.l10n.t('Restart engine');
    const pick = await showErrorSink(msg, ...(code === 'client.unavailable' ? [restart] : []));
    if (pick === restart) { engine?.restart(); }
}
