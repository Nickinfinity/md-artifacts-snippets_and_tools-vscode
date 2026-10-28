import * as assert from 'node:assert';
import { variablesFileToEditPayload, editPayloadToModel } from '../src/services/varset.service.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { recordedRead } from './recorded.js';

/**
 * T7.2 — file <-> `VarsEditPayload` adapter, on recorded engine reads.
 *
 * Load-bearing property, same as `test/edit-artifact.test.ts`: anything the adapter drops is
 * deleted from the vault on the next Save. Three file shapes exist (`extractSubSets` branches on
 * `blocks.length > 0`) and each is asserted field by field on the model the adapter hands the
 * engine. The serializer half of the old round trip is the engine's now (`rs-idem-*`, `fx-ve-*`
 * conformance cases).
 */
suite('vars edit — recorded read -> VarsEditPayload -> model', () => {
    function adapt(name: string) {
        const original = toParsedArtifactFile(recordedRead(name), '/v');
        const model = editPayloadToModel(variablesFileToEditPayload(original), original);
        return { original, model };
    }

    test('multi-sub-set fixture (fx-ve-with-env) keeps every field', () => {
        const { original, model } = adapt('fx-ve-with-env');

        assert.strictEqual(model.artifactType, original.frontmatter.artifactType);
        assert.strictEqual(model.title, original.frontmatter.title);
        assert.strictEqual(model.description, original.frontmatter.description);
        assert.deepStrictEqual(model.tags, original.frontmatter.tags);
        assert.strictEqual(model.blocks.length, original.blocks.length);
        for (let i = 0; i < original.blocks.length; i++) {
            assert.strictEqual(model.blocks[i]?.heading, original.blocks[i]?.heading, `block ${i} heading`);
            assert.deepStrictEqual(model.blocks[i]?.vars, original.blocks[i]?.vars, `block ${i} vars`);
        }
    });

    test('single-subset (heading-less) fixture stays one heading-less block', () => {
        const { original, model } = adapt('fx-ve-single-subset');

        assert.strictEqual(original.blocks.length, 0, 'fixture precondition: heading-less shape');
        assert.strictEqual(model.title, original.frontmatter.title);
        assert.strictEqual(model.description, original.frontmatter.description);
        assert.deepStrictEqual(model.tags, original.frontmatter.tags);
        assert.strictEqual(model.blocks.length, 1);
        assert.strictEqual(model.blocks[0]?.heading, '');
        assert.deepStrictEqual(model.blocks[0]?.vars, original.vars);
    });

    test('one-heading fixture keeps its `## ` heading', () => {
        const { original, model } = adapt('fx-ve-one-heading');

        assert.strictEqual(original.blocks.length, 1, 'fixture precondition: exactly one heading');
        assert.strictEqual(model.blocks.length, 1);
        assert.strictEqual(model.blocks[0]?.heading, original.blocks[0]?.heading, 'heading must survive, not collapse to flat');
        assert.notStrictEqual(model.blocks[0]?.heading, '', 'heading must not be dropped');
        assert.deepStrictEqual(model.blocks[0]?.vars, original.blocks[0]?.vars);
        assert.strictEqual(model.title, original.frontmatter.title);
        assert.strictEqual(model.description, original.frontmatter.description);
        assert.deepStrictEqual(model.tags, original.frontmatter.tags);
    });

    test('env survives into the model', () => {
        assert.strictEqual(adapt('fx-ve-with-env').model.env, 'staging');
    });

    test('a heading-less file gains no heading through the adapter', () => {
        const payload = variablesFileToEditPayload(toParsedArtifactFile(recordedRead('fx-ve-single-subset'), '/v'));
        assert.strictEqual(payload.subSets.length, 1);
        assert.strictEqual(payload.subSets[0]?.heading, '', 'heading-less source must carry an empty heading in the payload');
    });
});
