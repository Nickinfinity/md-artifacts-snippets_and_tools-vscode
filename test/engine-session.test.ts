import * as assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { EngineSession, MAX_LINE_BYTES } from '../src/engine/session.js';
import type { EngineErrorData } from '../src/types/engine.types.js';

/** Session over a PassThrough pair; `written` is every byte the session put on stdin. */
function rig(timeoutMs = 1000) {
    const stdin = new PassThrough(), stdout = new PassThrough();
    let written = '';
    stdin.on('data', d => { written += String(d); });
    const session = new EngineSession({ stdin, stdout }, { timeoutMs });
    const fatals: EngineErrorData[] = [];
    session.onFatal(d => fatals.push(d));
    const reply = (id: number, result: unknown): void => { stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); };
    const tick = (ms = 10): Promise<void> => new Promise(r => setTimeout(r, ms));
    return { session, stdin, stdout, fatals, reply, tick, written: () => written };
}
const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { data?: EngineErrorData }) => e.data?.code ?? 'no-data');

suite('EngineSession', () => {
    test('replies match by id, out of order', async () => {
        const r = rig();
        const a = r.session.request('system.version', {}), b = r.session.request('config.get', {});
        r.reply(2, 'B'); r.reply(1, 'A');
        assert.deepStrictEqual([await a, await b], ['A', 'B']);
    });

    test('non-JSON line is fatal client.protocol; later request writes nothing', async () => {
        const r = rig();
        const a = r.session.request('system.version', {}), b = r.session.request('config.get', {});
        r.stdout.write('not json\n');
        assert.deepStrictEqual([await code(a), await code(b)], ['client.protocol', 'client.protocol']);
        assert.strictEqual(r.fatals.length, 1);
        const before = r.written();
        assert.strictEqual(await code(r.session.request('system.version', {})), 'client.closed');
        await r.tick();
        assert.strictEqual(r.written(), before);
    });

    test('timeout is fatal client.timeout; answered request leaves no timer', async () => {
        const r = rig(20);
        assert.strictEqual(await code(r.session.request('system.version', {})), 'client.timeout');
        assert.strictEqual(r.fatals.length, 1);
        const q = rig(20);
        const p = q.session.request('system.version', {});
        q.reply(1, 'ok'); await p; await q.tick(40);
        assert.strictEqual(q.fatals.length, 0);
    });

    test('close() then stdout end: onFatal not fired', async () => {
        const r = rig();
        r.session.close(); r.stdout.end(); await r.tick();
        assert.strictEqual(r.fatals.length, 0);
    });

    test('server notification is ignored', async () => {
        const r = rig();
        const p = r.session.request('system.version', {});
        r.stdout.write('{"jsonrpc":"2.0","method":"vault.changed"}\n'); r.reply(1, 'ok');
        assert.strictEqual(await p, 'ok');
        assert.strictEqual(r.fatals.length, 0);
    });

    test('raw U+2028/U+2029 inside a reply string do not split the line', async () => {
        const r = rig();
        const p = r.session.request('system.version', {});
        r.stdout.write('{"jsonrpc":"2.0","id":1,"result":"a\u2028b\u2029c"}\n');
        assert.strictEqual(await p, 'a\u2028b\u2029c');
        assert.strictEqual(r.fatals.length, 0);
    });

    test('reply split inside a multibyte character still resolves', async () => {
        const r = rig();
        const p = r.session.request('system.version', {});
        const buf = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"h\u00e9llo"}\n');
        const cut = buf.indexOf(0xc3) + 1;
        r.stdout.write(buf.subarray(0, cut)); await r.tick(); r.stdout.write(buf.subarray(cut));
        assert.strictEqual(await p, 'h\u00e9llo');
    });

    test('error data with a non-string param rejects client.protocol', async () => {
        const r = rig();
        const p = r.session.request('system.version', {});
        r.stdout.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"x","data":{"code":"file.conflict","params":{"path":{"x":1}}}}}\n');
        assert.strictEqual(await code(p), 'client.protocol');
        assert.strictEqual(r.fatals.length, 0);
    });

    test('over-long request rejects protocol.line_too_long, zero bytes written', async () => {
        const r = rig();
        const big = 'x'.repeat(MAX_LINE_BYTES);
        let e: { data?: EngineErrorData } = {};
        await r.session.request('config.get', { big } as never).catch(x => { e = x; });
        assert.deepStrictEqual(e.data, { code: 'protocol.line_too_long', params: { max: '16777216' } });
        await r.tick();
        assert.strictEqual(r.written(), '');
    });
});
