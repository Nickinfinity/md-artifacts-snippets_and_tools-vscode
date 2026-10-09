import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { variablesFileToEditPayload, editPayloadToModel } from '../src/services/varset.service.js';
import { parseFromContent } from '../src/services/parser.service.js';
import { serializeArtifact } from '../src/services/artifact-serializer.service.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';

/**
 * T7.2 — file ↔ `VarsEditPayload` adapter round trip.
 *
 * Load-bearing property, same as `test/edit-artifact.test.ts`: anything the
 * adapter drops is deleted from the vault on the next Save. Three file shapes
 * exist (`extractSubSets` branches on `blocks.length > 0`), not two — the
 * heading-less shape and the one-heading shape take different code paths and
 * are each asserted separately, field by field.
 */
suite('vars edit — file <-> VarsEditPayload round trip', () => {

    // `__dirname` in compiled output is `dist/test/` — two levels up lands at
    // the repo root (test/fixtures.smoke.test.ts uses the same pattern).
    const fixturesDir = path.join(__dirname, '../../test/fixtures/vars-edit');

    function parseFixture(name: string) {
        const md = fs.readFileSync(path.join(fixturesDir, name), 'utf8');
        return parseFromContent(md, path.join('/v/Variables', name), '/v/Variables');
    }

    function roundTrip(name: string) {
        const original = parseFixture(name);
        const payload = variablesFileToEditPayload(original);
        const model = editPayloadToModel(payload, original);
        const serialized = serializeArtifact(model as ArtifactFormModel);
        const reparsed = parseFromContent(serialized, path.join('/v/Variables', name), '/v/Variables');
        return { original, reparsed };
    }

    test('fixtures exist', () => {
        for (const name of ['with-env.md', 'single-subset.md', 'one-heading.md']) {
            assert.ok(fs.existsSync(path.join(fixturesDir, name)), `missing fixture ${name}`);
        }
    });

    test('multi-sub-set fixture (with-env.md) round-trips field by field', () => {
        const { original, reparsed } = roundTrip('with-env.md');

        assert.strictEqual(reparsed.frontmatter.artifactType, original.frontmatter.artifactType);
        assert.strictEqual(reparsed.frontmatter.title, original.frontmatter.title);
        assert.strictEqual(reparsed.frontmatter.description, original.frontmatter.description);
        assert.deepStrictEqual(reparsed.frontmatter.tags, original.frontmatter.tags);
        // language is derived from the fence on reparse — excluded by design (CLAUDE.md note).

        assert.strictEqual(reparsed.blocks.length, original.blocks.length);
        for (let i = 0; i < original.blocks.length; i++) {
            assert.strictEqual(reparsed.blocks[i]?.heading, original.blocks[i]?.heading, `block ${i} heading`);
            assert.deepStrictEqual(reparsed.blocks[i]?.vars, original.blocks[i]?.vars, `block ${i} vars`);
        }
        // Documented ceiling (variables-writer.service.ts:15-28): top-level `vars`
        // and `frontmatter.language` are filled from sub-set 1 on any round trip
        // through the multi-block Variables path — never asserted here.
    });

    test('single-subset (heading-less) fixture round-trips field by field', () => {
        const { original, reparsed } = roundTrip('single-subset.md');

        assert.strictEqual(reparsed.frontmatter.artifactType, original.frontmatter.artifactType);
        assert.strictEqual(reparsed.frontmatter.title, original.frontmatter.title);
        assert.strictEqual(reparsed.frontmatter.description, original.frontmatter.description);
        assert.deepStrictEqual(reparsed.frontmatter.tags, original.frontmatter.tags);

        assert.strictEqual(reparsed.blocks.length, 0, 'heading-less file must stay heading-less');
        assert.strictEqual(original.blocks.length, 0, 'fixture precondition: heading-less shape');
        assert.deepStrictEqual(reparsed.vars, original.vars);
    });

    test('one-heading fixture round-trips and the `## ` heading survives', () => {
        const { original, reparsed } = roundTrip('one-heading.md');

        assert.strictEqual(original.blocks.length, 1, 'fixture precondition: exactly one heading');
        assert.strictEqual(reparsed.blocks.length, 1);
        assert.strictEqual(reparsed.blocks[0]?.heading, original.blocks[0]?.heading, 'heading must survive, not collapse to flat');
        assert.notStrictEqual(reparsed.blocks[0]?.heading, '', 'heading must not be dropped');
        assert.deepStrictEqual(reparsed.blocks[0]?.vars, original.blocks[0]?.vars);
        assert.strictEqual(reparsed.frontmatter.title, original.frontmatter.title);
        assert.strictEqual(reparsed.frontmatter.description, original.frontmatter.description);
        assert.deepStrictEqual(reparsed.frontmatter.tags, original.frontmatter.tags);
    });

    test('env survives at the sink — asserted on the re-parsed file, not the adapter return', () => {
        const { reparsed } = roundTrip('with-env.md');
        assert.strictEqual(reparsed.frontmatter.env, 'staging');
    });

    test('a heading-less file gains no heading through the adapter', () => {
        const original = parseFixture('single-subset.md');
        const payload = variablesFileToEditPayload(original);
        assert.strictEqual(payload.subSets.length, 1);
        assert.strictEqual(payload.subSets[0]?.heading, '', 'heading-less source must carry an empty heading in the payload');
    });
});
