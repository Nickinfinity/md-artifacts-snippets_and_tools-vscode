import * as assert from 'node:assert';
import { createFakeEngine, loadOpCases, type FakeEngine } from './fake-engine.js';

/** Writes one request and resolves with the next stdout line, parsed. */
function ask(fake: FakeEngine, method: string, params: unknown, id = 1): Promise<any> {
    return new Promise(resolve => {
        fake.stdout.once('data', (b: Buffer) => resolve(JSON.parse(b.toString().trim())));
        fake.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

suite('fake-engine', () => {
    test('major mismatch -> protocol.version_mismatch {client, server}', async () => {
        const reply = await ask(createFakeEngine({ protocol: '2.0' }), 'initialize', { protocol: '1.0' });
        assert.strictEqual(reply.error.data.code, 'protocol.version_mismatch');
        assert.deepStrictEqual(reply.error.data.params, { client: '1.0', server: '2.0' });
    });

    test('handshake ok, then unknown op; pre-init op is not_initialized', async () => {
        const fake = createFakeEngine();
        assert.strictEqual((await ask(fake, 'config.get', {})).error.code, -32002);
        const ok = await ask(fake, 'initialize', { protocol: '2.0' }, 2);
        assert.strictEqual(ok.result.engine, '0.10.0');
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

    test('loadOpCases normalises and pins the corpus', () => {
        const cases = loadOpCases();
        const find = (m: string, n: string) => cases.find(c => c.method === m && c.name === n);
        assert.deepStrictEqual(find('config.get', 'none')?.params, {});
        assert.ok(Array.isArray(find('artifact.read', 'array_params')?.params));
        assert.strictEqual((find('artifact.read', 'flagged')?.expect as any).layout.payload, 'flags');
        assert.ok(cases.every(c => c.method !== 'system.ops'));
        assert.strictEqual(cases.length, 358);
    });
});
