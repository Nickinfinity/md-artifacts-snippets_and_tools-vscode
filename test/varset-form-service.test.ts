import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderVariablesFile } from '../src/services/variables-writer.service.js';
import { slugForVarSet, toVarSetModel, validateVarSetForm } from '../src/services/varset-form.service.js';
import type { VarSetFormPayload } from '../src/types/varset.types.js';

/**
 * T2.2 — var-set form payload adapter.
 *
 * Byte-identity is proven through **this task's own adapter**
 * (`toVarSetModel`), not through `renderVariablesFile(buildVarSetModel(...))`
 * directly — that composition is already asserted for all seven CASES in
 * `test/varset-serialize.test.ts:53-58` and would stay green against a
 * bespoke emitter too.
 */

const GOLDEN = fs.readFileSync(
    path.join(__dirname, '..', '..', 'test', 'snapshots', 'varset', 'full.md'),
    'utf8',
);

suite('varset-form.service — byte identity with the prompt-flow golden', () => {
    test('the form path emits what the prompt path emitted (full golden)', () => {
        const payload: VarSetFormPayload = {
            title: 'Local Dev',
            description: 'Dev machine settings',
            tags: ['api', 'dev'],
            pairs: [['VK-host', 'localhost']],
        };
        assert.strictEqual(
            renderVariablesFile(toVarSetModel(payload)),
            GOLDEN,
            'the form path does not emit what the prompt path emitted',
        );
    });

    test('the adapter trims title and description like the old prompt flow did', () => {
        // Re-pointed onto the adapter's own output (not the golden): the
        // golden can never catch a missing trim here because `safeYamlValue`
        // (artifact-serializer.service.ts:299) already ends in `.trim()`, so
        // an untrimmed adapter still emits byte-identical frontmatter. This
        // guards the adapter directly instead.
        const payload: VarSetFormPayload = {
            title: ' Local Dev ',
            description: ' Dev machine settings ',
            tags: [],
            pairs: [['VK-a', 'b']],
        };
        const model = toVarSetModel(payload);
        assert.strictEqual(model.title, 'Local Dev', 'the adapter did not trim the title');
        assert.strictEqual(model.description, 'Dev machine settings', 'the adapter did not trim the description');
    });
});

suite('varset-form.service — slugForVarSet', () => {
    test('slugs a normal title', () => {
        assert.strictEqual(slugForVarSet('Local Dev'), 'local-dev');
    });

    test('falls back to untitled-variable-set for a punctuation-only title', () => {
        assert.strictEqual(
            slugForVarSet('...'),
            'untitled-variable-set',
            'a punctuation-only title would write a bare ".md"',
        );
    });
});

suite('varset-form.service — validateVarSetForm', () => {
    test('accepts a well-formed payload', () => {
        const result = validateVarSetForm({
            title: 'Local Dev', description: '', tags: [], pairs: [['VK-a', 'b']],
        });
        assert.strictEqual(result.ok, true);
    });

    test('rejects a blank title, with a reason', () => {
        const bad = validateVarSetForm({
            title: '  ', description: '', tags: [], pairs: [['VK-a', 'b']],
        });
        assert.strictEqual(bad.ok, false);
        assert.ok(bad.ok === false && bad.reason.length > 0, 'a refusal with no reason');
    });

    test('rejects a fence-breaking variable name', () => {
        const result = validateVarSetForm({
            title: 'x', description: '', tags: [],
            pairs: [['VK-a\n```\n---\nartifactType: Snippet', 'v']],
        });
        assert.strictEqual(result.ok, false, 'a fence-breaking variable name was accepted');
    });

    test('rejects a fence-breaking variable value', () => {
        const result = validateVarSetForm({
            title: 'x', description: '', tags: [],
            pairs: [['VK-a', 'v\n```\n---\nartifactType: Snippet']],
        });
        assert.strictEqual(result.ok, false, 'a fence-breaking variable VALUE was accepted');
    });

    test('accepts a legal value containing "=" — see the `equals` golden', () => {
        const result = validateVarSetForm({
            title: 'x', description: '', tags: [], pairs: [['VK-a', 'a=b&c=d']],
        });
        assert.strictEqual(result.ok, true, 'a legal value containing = was rejected - see the `equals` golden');
    });
});
