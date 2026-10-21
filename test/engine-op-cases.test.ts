import * as assert from 'node:assert';
import { EngineSession } from '../src/engine/session.js';
import type { EngineErrorData, EngineMethod } from '../src/types/engine.types.js';
import { createFakeEngine, loadOpCases } from './fake-engine.js';

const cases = loadOpCases();

suite('engine op cases through EngineSession', () => {
    test('case count is pinned', () => assert.strictEqual(cases.length, 358));
    for (const c of cases) {
        test(`${c.method}/${c.name}`, async () => {
            const fake = createFakeEngine();
            const session = new EngineSession(fake, { timeoutMs: 5000 });
            await session.initialize('2.0');
            fake.on(c.method, () => c.expectError === undefined
                ? { result: c.expect }
                : { error: { code: c.expectError, params: c.expectErrorParams ?? {} } });
            // the one sanctioned cast: fixtures are untyped data
            const call = session.request(c.method as EngineMethod, c.params as never);
            if (c.expectError === undefined) {
                assert.deepStrictEqual(await call, c.expect);
            } else {
                const e = await call.then(() => undefined, (x: { data: EngineErrorData }) => x);
                assert.strictEqual(e?.data.code, c.expectError);
                if (c.expectErrorParams) { assert.deepStrictEqual(e?.data.params, c.expectErrorParams); }
            }
            assert.deepStrictEqual(fake.received.at(-1)?.params, c.params);
            session.close();
        });
    }
});
