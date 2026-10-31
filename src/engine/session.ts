import type { EngineErrorData, EngineMethod, EngineParams, EngineResult, EngineStreams, InitializeResult } from '../types/engine.types.js';
import { EngineRequestError } from './request-error.js';

/** Longest request line the engine accepts, in bytes (PROTOCOL §1). */
export const MAX_LINE_BYTES = 16_777_216;

interface Pending { readonly resolve: (v: unknown) => void; readonly reject: (e: EngineRequestError) => void; readonly timer: NodeJS.Timeout }

const err = (code: string, params: Record<string, string> = {}): EngineRequestError => new EngineRequestError({ code, params });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isErrData = (v: unknown): v is EngineErrorData => isObj(v) && typeof v['code'] === 'string' && isObj(v['params']) && Object.values(v['params']).every(x => typeof x === 'string');

/**
 * NDJSON JSON-RPC client over a process's stdio (PROTOCOL §1). Ids are integers from 1; replies
 * match by id in any order. Anything malformed is fatal: pending requests reject, `onFatal` fires
 * once, the session is dead. Only this file touches the wire.
 *
 * @param streams - The engine's stdin/stdout.
 * @param opts - `timeoutMs` per request (timer starts at send); `log` receives diagnostic lines only.
 * @returns A session.
 * @example
 * const s = new EngineSession(proc, { timeoutMs: 30_000 });
 * await s.initialize('2.3');
 */
export class EngineSession {
    private nextId = 1;
    private dead = false;
    private fatalHandler: ((data: EngineErrorData) => void) | undefined;
    private readonly pending = new Map<number, Pending>();

    constructor(private readonly streams: EngineStreams, private readonly opts: { timeoutMs: number; log?: (line: string) => void }) {
        // readline also breaks on U+2028/U+2029, which the engine emits raw inside strings; PROTOCOL §1's only terminator is \n.
        // setEncoding keeps multibyte chars intact across chunks.
        // ponytail: no max line length on stdout, so an unterminated flood buffers unbounded; fine for a local pinned binary.
        let buf = '';
        let ended = false;
        const end = (): void => { if (!ended) { ended = true; this.fatal({ code: 'client.exited', params: {} }); } };
        streams.stdout.setEncoding('utf8');
        streams.stdout.on('data', (chunk: string) => {
            buf += chunk;
            for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (line !== '') { this.onLine(line); }
            }
        });
        streams.stdout.on('end', end);
        streams.stdout.on('close', end);
    }

    /**
     * Handshake (PROTOCOL §2).
     *
     * @param protocol - Protocol version the client speaks.
     * @returns The engine's reply, shape-checked.
     * @example
     * const info = await session.initialize('2.3');
     */
    async initialize(protocol: string): Promise<InitializeResult> {
        const r = await this.send('initialize', { protocol });
        if (!isObj(r) || typeof r['protocol'] !== 'string' || typeof r['engine'] !== 'string' || !Array.isArray(r['types'])) {
            throw err('client.protocol');
        }
        return r as unknown as InitializeResult;
    }

    /**
     * Sends one request.
     *
     * @param method - Engine method.
     * @param params - Its params.
     * @returns The engine's `result`; rejects with `EngineRequestError`.
     * @example
     * const v = await session.request('system.version', {});
     */
    request<M extends EngineMethod>(method: M, params: EngineParams<M>): Promise<EngineResult<M>> {
        return this.send(method, params) as Promise<EngineResult<M>>;
    }

    /**
     * Registers the fatal handler; fires once (non-JSON line, unmatched id, timeout, stdout end).
     *
     * @param handler - Receives the `client.*` error data.
     * @example
     * session.onFatal(d => restart(d.code));
     */
    onFatal(handler: (data: EngineErrorData) => void): void { this.fatalHandler = handler; }

    /**
     * Ends stdin (engine exits on EOF). Marks dead and suppresses `onFatal`; pending reject `client.closed`.
     *
     * @example
     * session.close();
     */
    close(): void {
        if (this.dead) { return; }
        this.dead = true;
        this.rejectAll({ code: 'client.closed', params: {} });
        this.streams.stdin.end();
    }

    private send(method: string, params: unknown): Promise<unknown> {
        if (this.dead) { return Promise.reject(err('client.closed')); }
        const id = this.nextId++;
        // readline-based readers (the fake engine) split on U+2028/2029; escape them so one request stays one line.
        const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }).replace(/[\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16)}`);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
            return Promise.reject(err('protocol.line_too_long', { max: String(MAX_LINE_BYTES) }));
        }
        return new Promise((resolve, reject) => {
            // ponytail: timer starts at send so queue time counts; engine is strictly in-order, no per-method budgets.
            const timer = setTimeout(() => this.fatal({ code: 'client.timeout', params: {} }), this.opts.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.streams.stdin.write(`${line}\n`);
        });
    }

    private onLine(line: string): void {
        if (this.dead) { return; }
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { return this.protocolFault(line); }
        if (!isObj(msg)) { return this.protocolFault(line); }
        if ('method' in msg && !('id' in msg)) { return; } // server notification, ignored (PROTOCOL §8)
        const id = msg['id'];
        const p = typeof id === 'number' ? this.pending.get(id) : undefined;
        if (!p || ('result' in msg) === ('error' in msg)) { return this.protocolFault(line); }
        this.pending.delete(id as number);
        clearTimeout(p.timer);
        if ('result' in msg) { p.resolve(msg['result']); return; }
        const data = isObj(msg['error']) ? msg['error']['data'] : undefined;
        p.reject(new EngineRequestError(isErrData(data) ? data : { code: 'client.protocol', params: {} }));
    }

    private protocolFault(line: string): void {
        this.opts.log?.(`protocol fault: ${line.slice(0, 200)}`);
        this.fatal({ code: 'client.protocol', params: {} });
    }

    private fatal(data: EngineErrorData): void {
        if (this.dead) { return; }
        this.dead = true;
        this.rejectAll(data);
        this.fatalHandler?.(data);
    }

    private rejectAll(data: EngineErrorData): void {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new EngineRequestError(data)); }
        this.pending.clear();
    }
}
