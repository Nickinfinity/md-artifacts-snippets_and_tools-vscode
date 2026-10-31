import * as assert from 'node:assert';
import * as readline from 'node:readline';
import { createFakeEngine, loadOpCases, type FakeEngine } from './fake-engine.js';

/** Lets `n` macrotask turns pass, so queued stream writes land. */
async function ticks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) { await new Promise(r => setImmediate(r)); }
}

/** Writes one request and resolves with the next stdout line, parsed. */
function ask(fake: FakeEngine, method: string, params: unknown, id = 1): Promise<any> {
    return new Promise(resolve => {
        fake.stdout.once('data', (b: Buffer) => resolve(JSON.parse(b.toString().trim())));
        fake.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

suite('fake-engine', () => {
    test('major mismatch -> protocol.version_mismatch {client, server}', async () => {
        const reply = await ask(createFakeEngine({ protocol: '2.3' }), 'initialize', { protocol: '1.0' });
        assert.strictEqual(reply.error.data.code, 'protocol.version_mismatch');
        assert.deepStrictEqual(reply.error.data.params, { client: '1.0', server: '2.3' });
    });

    test('handshake ok, then unknown op; pre-init op is not_initialized', async () => {
        const fake = createFakeEngine();
        assert.strictEqual((await ask(fake, 'config.get', {})).error.code, -32002);
        const ok = await ask(fake, 'initialize', { protocol: '2.3' }, 2);
        assert.strictEqual(ok.result.engine, '0.13.0');
        assert.ok(ok.result.types.length > 0);
        const unk = await ask(fake, 'nope', {}, 3);
        assert.deepStrictEqual([unk.error.code, unk.error.data.params], [-32601, { name: 'nope' }]);
    });

    test('kill counts, fires onExit(null) once; crash then kill does not re-fire', () => {
        const a = createFakeEngine(); const codes: (number | null)[] = [];
        a.onExit(c => codes.push(c)); a.kill(); a.kill();
        assert.deepStrictEqual([a.killed, codes], [2, [null]]);
        const b = createFakeEngine(); const bc: (number | null)[] = [];
        b.onExit(c => bc.push(c)); b.crash(7); b.kill();
        assert.deepStrictEqual(bc, [7]);
    });

    test('async handler: replies keep request order, nothing leaves before release', async () => {
        const fake = createFakeEngine();
        await ask(fake, 'initialize', { protocol: '2.3' });
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        fake.on('a', async () => { await gate; return { result: 'A' }; });
        fake.on('b', () => ({ result: 'B' }));
        const lines: { id: number; result?: unknown }[] = [];
        readline.createInterface({ input: fake.stdout }).on('line', l => lines.push(JSON.parse(l)));
        fake.stdin.write('{"jsonrpc":"2.0","id":2,"method":"a","params":{}}\n{"jsonrpc":"2.0","id":3,"method":"b","params":{}}\n');
        await ticks(5);
        assert.strictEqual(lines.length, 0, 'nothing may leave before release');
        release();
        await ticks(5);
        assert.deepStrictEqual(lines.map(l => [l.id, l.result]), [[2, 'A'], [3, 'B']]);
    });

    test('a throwing handler answers op.internal and later requests are still answered', async () => {
        const fake = createFakeEngine();
        await ask(fake, 'initialize', { protocol: '2.3' });
        fake.on('boom', async () => { throw new Error('x'); });
        fake.on('b', () => ({ result: 'B' }));
        const boom = await ask(fake, 'boom', {}, 2);
        assert.strictEqual(boom.error?.data?.code, 'op.internal');
        assert.strictEqual((await ask(fake, 'b', {}, 3)).result, 'B');
    });

    test('loadOpCases normalises and pins the corpus', () => {
        const cases = loadOpCases();
        const find = (m: string, n: string) => cases.find(c => c.method === m && c.name === n);
        assert.deepStrictEqual(find('config.get', 'none')?.params, {});
        assert.ok(Array.isArray(find('artifact.read', 'array_params')?.params));
        assert.strictEqual((find('artifact.read', 'flagged')?.expect as any).layout.payload, 'flags');
        assert.ok(cases.every(c => c.method !== 'system.ops'));
        assert.strictEqual(cases.length, 449);
    });
});
