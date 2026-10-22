import * as assert from 'node:assert';
import { captureEditor, type PrefillFn } from '../src/commands/capture/editor.capture.js';
import { loadOpCases } from './fake-engine.js';
import type { EngineModel } from '../src/types/engine.types.js';

/**
 * `captureEditor` gathers the selection and asks the engine (`artifact.prefill`); language mapping and
 * the hidden-language rule are engine-owned (op cases `selection_tsx`, `selection_hidden`).
 */

const reply = (name: string): EngineModel =>
    loadOpCases().find(c => c.method === 'artifact.prefill' && c.name === name)!.expect as EngineModel;

suite('captureEditor', () => {
    test('empty selection yields undefined and sends no request', async () => {
        const sent: unknown[] = [];
        const prefill: PrefillFn = async p => { sent.push(p); return undefined; };
        assert.strictEqual(await captureEditor({ text: '', languageId: 'ts' }, 'Snippet', prefill), undefined);
        assert.strictEqual(sent.length, 0);
    });

    test('sends exactly the selection params; prefill comes from the reply', async () => {
        const sent: unknown[] = [];
        const prefill: PrefillFn = async p => { sent.push(p); return reply('selection_tsx'); };
        const result = await captureEditor({ text: 'const x = 1;', languageId: 'typescriptreact' }, 'Snippet', prefill);
        assert.deepStrictEqual(sent, [{ source: 'selection', type: 'Snippet', text: 'const x = 1;', languageId: 'typescriptreact' }]);
        assert.strictEqual(result?.source, 'selection');
        assert.strictEqual(result?.prefill.blocks?.[0]?.language, 'tsx');
        assert.strictEqual(result?.prefill.blocks?.[0]?.code, 'const x = 1;');
    });

    test('engine refusal yields undefined', async () => {
        assert.strictEqual(await captureEditor({ text: 'hi', languageId: 'plaintext' }, 'Snippet', async () => undefined), undefined);
    });
});
