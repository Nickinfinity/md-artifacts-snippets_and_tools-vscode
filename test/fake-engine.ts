/**
 * In-process stand-in for `mda serve`: a pure stream peer speaking NDJSON JSON-RPC (PROTOCOL §1–§2).
 * No `vscode`, no `child_process`. Also loads the engine's op-case fixtures.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';
import type { EngineErrorData, EngineProcess, TypeInfo } from '../src/types/engine.types.js';

const FIXTURES = path.join(__dirname, '../../test/fixtures/engine');

/** One fake reply: a result or an engine error. */
export type Reply = { result: unknown } | { error: EngineErrorData };

/**
 * Answers one request: a result or an engine error, now or later.
 * A Promise lets a test hold a reply back; replies still leave in request order.
 *
 * @param params - The request's params, untouched.
 * @returns `{ result }` or `{ error }`, or a Promise of one.
 * @example
 * const h: FakeHandler = () => ({ result: { ok: true } });
 * const slow: FakeHandler = async () => { await gate; return { result: 'late' }; };
 */
export type FakeHandler = (params: unknown) => Reply | Promise<Reply>;

/** A fake engine process plus test controls. */
export interface FakeEngine extends EngineProcess {
    readonly received: readonly { id: number | string; method: string; params: unknown }[];
    readonly killed: number;
    on(method: string, handler: FakeHandler): void;
    sendRaw(line: string): void;
    crash(code?: number): void;
    hang(): void;
}

/**
 * Builds a fake engine that handshakes per PROTOCOL §2.
 *
 * @param opts - `protocol` it claims (default `2.0`), `types` it reports (default `initialize.json`'s).
 * @returns The fake, already listening on its stdin.
 * @example
 * const fake = createFakeEngine({ protocol: '2.0' });
 * fake.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":"2.0"}}\n');
 */
export function createFakeEngine(opts: { protocol?: string; types?: readonly TypeInfo[] } = {}): FakeEngine {
    const protocol = opts.protocol ?? '2.0';
    const types = opts.types ?? (readJson('initialize.json') as { types: TypeInfo[] }).types;
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const handlers = new Map<string, FakeHandler>();
    const received: { id: number | string; method: string; params: unknown }[] = [];
    const exitHandlers: ((code: number | null) => void)[] = [];
    let initialized = false, hung = false, exited = false, killed = 0;

    const send = (msg: object): void => { if (!exited) { stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); } };
    const fail = (id: unknown, code: number, data: EngineErrorData): void => send({ id, error: { code, message: data.code, data } });
    const exit = (code: number | null): void => {
        if (exited) { return; }
        exited = true;
        stdout.end();
        exitHandlers.forEach(h => h(code));
    };

    const initialize = (params: unknown): Reply => {
        const client = (params as { protocol?: unknown } | null)?.protocol;
        if (typeof client !== 'string') { return { error: { code: 'op.bad_request', params: {} } }; }
        if (client.split('.')[0] !== protocol.split('.')[0]) {
            return { error: { code: 'protocol.version_mismatch', params: { client, server: protocol } } };
        }
        return { result: { protocol, engine: '0.10.0', types } };
    };

    type Req = { id: number | string; method: string; params?: unknown };

    const answer = async (req: Req): Promise<void> => {
        const custom = handlers.get(req.method);
        if (req.method !== 'initialize' && !initialized) { fail(req.id, -32002, { code: 'protocol.not_initialized', params: {} }); return; }
        if (req.method === 'initialize' && initialized && !custom) { fail(req.id, -32600, { code: 'protocol.already_initialized', params: {} }); return; }
        const handler = custom ?? (req.method === 'initialize' ? initialize : undefined);
        if (!handler) { fail(req.id, -32601, { code: 'op.unknown', params: { name: req.method } }); return; }
        const out = await handler(req.params);
        if (hung || exited) { return; }
        if ('error' in out) { fail(req.id, -32000, out.error); return; }
        if (req.method === 'initialize') { initialized = true; }
        send({ id: req.id, result: out.result });
    };

    // Every reply rides one chain, so replies leave in request order even when a
    // handler is async (the real engine is strictly in-order). Each link catches
    // its own failure: one throwing handler must not silence every later reply.
    let queue: Promise<void> = Promise.resolve();
    const handle = (line: string): void => {
        if (hung || exited || line.trim() === '') { return; }
        let req: Req;
        try { req = JSON.parse(line); } catch { fail(null, -32700, { code: 'protocol.parse_error', params: {} }); return; }
        received.push({ id: req.id, method: req.method, params: req.params });
        const step = async (): Promise<void> => {
            try { await answer(req); } catch { fail(req.id, -32603, { code: 'op.internal', params: {} }); }
        };
        queue = queue.then(step, step);
    };
    readline.createInterface({ input: stdin }).on('line', handle);

    return {
        stdin, stdout, stderr, received,
        get killed() { return killed; },
        kill() { killed++; exit(null); },
        onExit(h) { exitHandlers.push(h); },
        on(method, handler) { handlers.set(method, handler); },
        sendRaw(line) { if (!exited) { stdout.write(`${line}\n`); } },
        crash(code = 1) { exit(code); },
        hang() { hung = true; },
    };
}

/** One engine op case, normalised from `op-cases/<method>/<name>.json`. */
export interface OpCase {
    readonly method: string; readonly name: string;
    readonly params: unknown;
    readonly expect?: unknown; readonly expectError?: string; readonly expectErrorParams?: Readonly<Record<string, string>>;
}

/**
 * Loads every op case except `system.ops/*`.
 *
 * @returns Cases with absent `params` normalised to `{}`; other fixture keys ignored.
 * @example
 * const cases = loadOpCases().filter(c => c.method === 'config.get');
 */
export function loadOpCases(): readonly OpCase[] {
    const root = path.join(FIXTURES, 'op-cases');
    return fs.readdirSync(root).filter(m => m !== 'system.ops').sort().flatMap(method =>
        fs.readdirSync(path.join(root, method)).filter(f => f.endsWith('.json')).sort().map(file => {
            const j = readJson(path.join('op-cases', method, file)) as Record<string, unknown>;
            return {
                method, name: file.slice(0, -5), params: j['params'] ?? {}, expect: j['expect'],
                expectError: j['expect_error'] as string | undefined,
                expectErrorParams: j['expect_error_params'] as Record<string, string> | undefined,
            };
        }));
}

function readJson(rel: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
}
