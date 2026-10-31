import * as assert from 'node:assert';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { EngineSupervisor, RESTART_BACKOFF_MS, recentFailures } from '../src/engine/supervisor.js';
import type { EngineErrorData } from '../src/types/engine.types.js';

const SNIP = [{ type: 'Snippet' as const, dir: 'Snippets' }];

/** Supervisor over fakes; `fakes` is every spawned process, `sleeps` every backoff asked for. */
function rig(opts: { knownTypes?: typeof SNIP; protocol?: string; timeoutMs?: number; setup?: (f: FakeEngine, n: number) => void } = {}) {
    const fakes: FakeEngine[] = [];
    const sleeps: number[] = [];
    const logs: string[] = [];
    const sup = new EngineSupervisor({
        spawn: () => {
            const f = createFakeEngine({ protocol: opts.protocol });
            f.on('config.get', () => ({ result: { source: 'none' } }));
            opts.setup?.(f, fakes.length);
            fakes.push(f);
            return f;
        },
        binPath: '/x/mda', args: ['serve'], knownTypes: opts.knownTypes ?? SNIP, timeoutMs: opts.timeoutMs,
        log: l => logs.push(l), now: () => 0, sleep: ms => { sleeps.push(ms); return Promise.resolve(); },
    });
    const get = (): Promise<unknown> => sup.request('config.get', {});
    return { sup, fakes, sleeps, logs, get };
}
const err = (p: Promise<unknown>): Promise<EngineErrorData> =>
    p.then(() => { throw new Error('resolved'); }, (e: { data: EngineErrorData }) => e.data);

suite('EngineSupervisor', () => {
    test('registry pair missing is terminal client.incompatible; no respawn', async () => {
        const r = rig({ knownTypes: [{ type: 'Snippet', dir: 'Snippets' }, { type: 'Snippet', dir: 'Snips' }] });
        const d = await err(r.get());
        assert.strictEqual(d.code, 'client.incompatible');
        assert.strictEqual(d.params['missing'], 'Snippet:Snips');
        assert.strictEqual((await err(r.get())).code, 'client.incompatible');
        assert.strictEqual((await err(r.get())).code, 'client.incompatible');
        assert.strictEqual(r.fakes.length, 1);
        assert.strictEqual(r.fakes[0]?.killed, 1);
    });

    test('different-major engine is incompatible; no respawn', async () => {
        const r = rig({ protocol: '3.0' });
        const d = await err(r.get());
        assert.strictEqual(d.code, 'client.incompatible');
        assert.strictEqual(d.params['protocol'], '3.0');
        await err(r.get());
        assert.strictEqual(r.fakes.length, 1);
        assert.strictEqual(r.fakes[0]?.killed, 1);
    });

    test('concurrent first requests share one spawn', async () => {
        const r = rig();
        await Promise.all([r.get(), r.get()]);
        assert.strictEqual(r.fakes.length, 1);
        assert.strictEqual(r.logs.includes('engine 0.13.0, protocol 2.3'), true);
        assert.strictEqual(r.logs.some(l => /^→ config\.get \(\d+ ms\)$/.test(l)), true);
    });

    test('crash mid-request rejects client.exited; next request respawns after sleep(0)', async () => {
        const r = rig({ setup: (f, n) => { if (n === 0) { f.on('config.get', () => { f.crash(); return { result: {} }; }); } } });
        assert.strictEqual((await err(r.get())).code, 'client.exited');
        await r.get();
        assert.strictEqual(r.fakes.length, 2);
        assert.deepStrictEqual(r.sleeps, [0]);
        assert.strictEqual(r.logs.includes('engine exited (code 1)'), true);
    });

    test('hang: client.timeout and the process is killed', async () => {
        const r = rig({ timeoutMs: 20, setup: f => f.hang() });
        assert.strictEqual((await err(r.get())).code, 'client.timeout');
        assert.strictEqual(r.fakes[0]?.killed, 1);
    });

    test('four crashes in the window give up; restart() clears it', async () => {
        const r = rig({ setup: f => f.on('config.get', () => { f.crash(); return { result: {} }; }) });
        for (let i = 0; i < 4; i++) { assert.strictEqual((await err(r.get())).code, 'client.exited'); }
        assert.strictEqual((await err(r.get())).code, 'client.unavailable');
        assert.strictEqual(r.fakes.length, 4);
        assert.deepStrictEqual(r.sleeps, [...RESTART_BACKOFF_MS]);
        r.sup.restart();
        await err(r.get());
        assert.strictEqual(r.fakes.length, 5);
    });

    test('initialize result with major 3 is incompatible{engine, protocol}', async () => {
        const r = rig({ setup: f => f.on('initialize', () => ({ result: { protocol: '3.0', engine: '9', types: [] } })) });
        const d = await err(r.get());
        assert.deepStrictEqual([d.code, d.params['engine'], d.params['protocol']], ['client.incompatible', '9', '3.0']);
        assert.strictEqual(r.fakes[0]?.killed, 1);
    });

    test('dispose: later request client.closed, no spawn', async () => {
        const r = rig();
        await r.get();
        r.sup.dispose();
        assert.strictEqual((await err(r.get())).code, 'client.closed');
        assert.strictEqual(r.fakes.length, 1);
    });

    test('non-JSON line kills the process, rejects client.protocol, next request respawns', async () => {
        const r = rig({ setup: (f, n) => { if (n === 0) { f.on('config.get', () => { f.sendRaw('not json'); return { result: {} }; }); } } });
        assert.strictEqual((await err(r.get())).code, 'client.protocol');
        assert.strictEqual(r.fakes[0]?.killed, 1);
        await r.get();
        assert.strictEqual(r.fakes.length, 2);
    });

    test('malformed types list is terminal client.protocol', async () => {
        const r = rig({ setup: f => f.on('initialize', () => ({ result: { protocol: '2.3', engine: '1', types: [{ type: 1 }] } })) });
        assert.strictEqual((await err(r.get())).code, 'client.protocol');
        await err(r.get());
        assert.strictEqual(r.fakes.length, 1);
        assert.strictEqual(r.fakes[0]?.killed, 1);
    });

    test('engine-sent client.* codes are per-request data, not supervisor state', async () => {
        const cases: EngineErrorData[] = [{ code: 'client.unavailable', params: {} }, { code: 'client.incompatible', params: { missing: 'X:y' } }];
        for (const data of cases) {
            let first = true;
            const r = rig({ setup: f => f.on('config.get', () => { if (first) { first = false; return { error: data }; } return { result: {} }; }) });
            assert.strictEqual((await err(r.get())).code, data.code);
            await r.get();
            assert.strictEqual(r.fakes.length, 1);
            assert.deepStrictEqual(r.sleeps, []);
        }
    });

    test('recentFailures drops entries outside the window', () => {
        assert.deepStrictEqual(recentFailures([0, 90_000], 100_000), [90_000]);
    });
});
