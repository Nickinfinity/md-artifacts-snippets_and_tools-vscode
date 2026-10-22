import * as assert from 'node:assert';
import { confirmModal, setConfirmSink } from '../src/services/confirm.service.js';

// H3.0d (W3): the one seam every write-path test stubs a modal through.
suite('confirmModal sink', () => {
    teardown(() => setConfirmSink(undefined));

    test('the sink receives exactly what confirmModal was asked, and its answer is the result', async function () {
        // A body that ignores the sink reaches a real modal, which the test host refuses
        // ("DialogService: refused to show dialog in tests") — observed red, H3.0d.
        this.timeout(2000);
        const seen: unknown[] = [];
        setConfirmSink(async opts => { seen.push(opts); return true; });
        assert.strictEqual(await confirmModal({ message: 'Overwrite a.md?', action: 'Overwrite', detail: 'Gone for good.' }), true);
        assert.deepStrictEqual(seen, [{ message: 'Overwrite a.md?', action: 'Overwrite', detail: 'Gone for good.' }]);

        setConfirmSink(async () => false);
        assert.strictEqual(await confirmModal({ message: 'Delete b.md?', action: 'Delete' }), false);
    });
});
