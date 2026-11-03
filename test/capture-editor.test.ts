import * as assert from 'node:assert';
import { captureEditor, type PrefillFn } from '../src/commands/capture/editor.capture.js';
import { loadOpCases } from './fake-engine.js';
import type { EngineModel } from '../src/types/engine.types.js';
import { buildFormHtml } from '../src/ui/panels/artifactForm/form.html.js';
import { defaultModel } from '../src/ui/panels/artifactForm/form.helpers.js';
import { formCodeBlockHtml } from '../src/ui/panels/artifactForm/form.blocks.js';

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

    // W8b T8b.4: a captured language outside the hand list still reaches the form's language select.
    test('captured scss block: the form select selects scss, and exactly one option is selected', async () => {
        const base = reply('selection_tsx');
        const scss: PrefillFn = async () => ({ ...base, blocks: base.blocks?.map(b => ({ ...b, language: 'scss' })) });
        const result = await captureEditor({ text: 'a{}', languageId: 'scss' }, 'Snippet', scss);
        const model = { ...defaultModel('Snippet'), ...result?.prefill };
        const html = buildFormHtml({ nonce: 'n', cspSource: 'x', cssUri: [], model, codeBlockHtml: formCodeBlockHtml });
        const select = /<select id="[^"]*" class="lang-select"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
        assert.ok(select.includes('<option value="scss" selected>'), select);
        assert.strictEqual((select.match(/<option [^>]*\bselected\b/g) ?? []).length, 1);
    });

    test('engine refusal yields undefined', async () => {
        assert.strictEqual(await captureEditor({ text: 'hi', languageId: 'plaintext' }, 'Snippet', async () => undefined), undefined);
    });
});
