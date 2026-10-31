import type { ArtifactType } from '../types/parsed-artifact.types.js';
import type { EngineErrorData, EngineMethod, EngineParams, EngineProcess, EngineResult, InitializeResult, SpawnFn } from '../types/engine.types.js';
import { EngineRequestError } from './request-error.js';
import { EngineSession } from './session.js';

/** Protocol this client speaks; the engine must share `major` and have at least `minMinor`. */
export const PROTOCOL = { major: 2, minMinor: 3, sent: '2.3' } as const;
export const RESTART_BACKOFF_MS = [0, 1000, 5000] as const; // ponytail: fixed schedule; jitter if many windows ever matter
export const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = RESTART_BACKOFF_MS.length + 1;

/** One spawned process; `done` makes failure handling idempotent per process. */
interface Handle { readonly proc: EngineProcess; readonly session: EngineSession; done: boolean }

const err = (code: string, params: Record<string, string> = {}): EngineRequestError => new EngineRequestError({ code, params });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Failures still inside the rolling window, oldest first.
 *
 * @param failures - Failure timestamps.
 * @param now - Current time.
 * @returns The recent ones.
 * @example
 * recentFailures([0, 90_000], 100_000); // [90000]
 */
export function recentFailures(failures: readonly number[], now: number): number[] {
    return failures.filter(t => now - t < FAILURE_WINDOW_MS);
}

/**
 * Owns the engine process: spawn, handshake, registry check, kill, bounded restart. Only this
 * file spawns or restarts; the wire is `EngineSession`'s.
 *
 * @param deps - Injected spawn (the real one is T1.7's), binary, argv, expected `(type, dir)` pairs.
 * @returns A supervisor; the first `request` starts the engine.
 * @example
 * const sup = new EngineSupervisor({ spawn, binPath, args: ['serve'], knownTypes });
 * const cfg = await sup.request('config.get', {});
 */
export class EngineSupervisor {
    private cur: Handle | undefined;
    private starting: Promise<EngineSession> | undefined;
    private terminal: EngineRequestError | undefined;
    private failures: number[] = [];
    private gaveUp = false;
    private disposed = false;
    private initInfo: InitializeResult | undefined;
    private readonly timeoutMs: number;
    private readonly log: (line: string) => void;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly deps: {
        spawn: SpawnFn; binPath: string; args: readonly string[];
        knownTypes: readonly { type: ArtifactType; dir: string }[];
        timeoutMs?: number; log?: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>;
    }) {
        this.timeoutMs = deps.timeoutMs ?? 30_000;
        this.log = deps.log ?? (() => undefined);
        this.now = deps.now ?? Date.now;
        this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    }

    /** The engine's `initialize` reply, after the first handshake. */
    get info(): InitializeResult | undefined { return this.initInfo; }

    /**
     * Sends one request, starting (or restarting) the engine as needed.
     *
     * @param method - Engine method.
     * @param params - Its params.
     * @returns The result; rejects with `EngineRequestError`.
     * @example
     * await sup.request('system.version', {});
     */
    async request<M extends EngineMethod>(method: M, params: EngineParams<M>): Promise<EngineResult<M>> {
        const t0 = this.now();
        try {
            if (this.disposed) { throw err('client.closed'); }
            if (this.terminal) { throw this.terminal; }
            if (this.gaveUp) { throw err('client.unavailable'); }
            this.starting ??= this.start();
            return await (await this.starting).request(method, params);
        } finally {
            this.log(`→ ${method} (${this.now() - t0} ms)`);
        }
    }

    /** Clears the give-up and incompatible state; the next request spawns afresh. */
    restart(): void {
        this.terminal = undefined;
        this.gaveUp = false;
        this.failures = [];
    }

    /** Ends stdin (engine exits on EOF); later requests reject `client.closed`. */
    dispose(): void {
        this.disposed = true;
        this.retire(this.cur);
    }

    private async start(): Promise<EngineSession> {
        const n = recentFailures(this.failures, this.now()).length;
        if (n > 0) { await this.sleep(RESTART_BACKOFF_MS[Math.min(n, RESTART_BACKOFF_MS.length) - 1] ?? 0); }
        if (this.disposed) { throw err('client.closed'); }
        const proc = this.deps.spawn(this.deps.binPath, this.deps.args);
        const session = new EngineSession(proc, { timeoutMs: this.timeoutMs, log: this.log });
        const h: Handle = { proc, session, done: false };
        this.cur = h;
        let tail = ''; // ponytail: unterminated stderr line buffers unbounded; fine for a local pinned binary
        proc.stderr.on('data', (c: Buffer | string) => {
            const lines = (tail + String(c)).split('\n');
            tail = lines.pop() ?? '';
            lines.filter(l => l !== '').forEach(this.log);
        });
        session.onFatal(d => this.fail(h, d));
        proc.onExit(code => { this.log(`engine exited (code ${code})`); this.fail(h, { code: 'client.exited', params: {} }); });
        try {
            const info = await session.initialize(PROTOCOL.sent);
            this.log(`engine ${info.engine}, protocol ${info.protocol}`);
            this.check(h, info);
            this.initInfo = info;
            return session;
        } catch (e) {
            if (e instanceof EngineRequestError && e.data.code === 'protocol.version_mismatch') {
                const server = e.data.params['server'];
                throw this.fatalIncompatible(h, server === undefined ? {} : { protocol: server });
            }
            if (e instanceof EngineRequestError && !this.terminal) { this.fail(h, e.data); }
            throw e;
        }
    }

    /** Version and registry checks; each failure is terminal. */
    private check(h: Handle, info: InitializeResult): void {
        const [major, minor] = info.protocol.split('.').map(Number);
        if (major !== PROTOCOL.major || !(minor !== undefined && minor >= PROTOCOL.minMinor)) {
            throw this.fatalIncompatible(h, { engine: info.engine, protocol: info.protocol });
        }
        const types: unknown = info.types;
        if (!Array.isArray(types) || !types.every(t => isObj(t) && typeof t['type'] === 'string' && typeof t['dir'] === 'string')) {
            throw this.terminate(h, err('client.protocol'));
        }
        const have = new Set(types.map(t => `${String(t['type'])}:${String(t['dir'])}`));
        const missing = this.deps.knownTypes.map(k => `${k.type}:${k.dir}`).filter(p => !have.has(p)).sort();
        if (missing.length > 0) { throw this.fatalIncompatible(h, { missing: missing.join(',') }); }
    }

    private fatalIncompatible(h: Handle, params: Record<string, string>): EngineRequestError {
        return this.terminate(h, err('client.incompatible', params));
    }

    /** Terminal state: close the process (EOF), never restart until `restart()`. */
    private terminate(h: Handle, e: EngineRequestError): EngineRequestError {
        this.terminal = e;
        this.retire(h);
        h.proc.kill(); // an engine that ignores EOF must not live on unwatched
        return e;
    }

    private retire(h: Handle | undefined): void {
        if (!h) { return; }
        h.done = true;
        h.session.close();
        if (this.cur === h) { this.cur = undefined; this.starting = undefined; }
    }

    /** A fatal session or process exit: kill the process, count one failure, allow a backed-off respawn. */
    private fail(h: Handle, _data: EngineErrorData): void {
        if (h.done) { return; }
        h.done = true;
        h.proc.kill();
        if (this.cur === h) { this.cur = undefined; this.starting = undefined; }
        this.failures = recentFailures([...this.failures, this.now()], this.now());
        if (this.failures.length >= MAX_FAILURES) { this.gaveUp = true; }
    }
}
