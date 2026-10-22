import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngineArtifact, EngineModel, Layout } from '../src/types/engine.types.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { engineMeta, fromEngineModel, toEngineModel } from '../src/engine/model.js';

const cases = path.join(__dirname, '../../test/fixtures/engine/op-cases');
// sanctioned test-only cast: fixture JSON is untyped
const fixture = <T>(op: string, n: string): T => JSON.parse(fs.readFileSync(path.join(cases, op, `${n}.json`), 'utf8')) as T;

const form = (over: Partial<ArtifactFormModel> = {}): ArtifactFormModel => ({
    artifactType: 'AIPrompt', title: 'T', description: '', tags: [],
    blocks: [{ heading: '', description: '', language: '', code: 'x', vars: [] }], ...over,
});

suite('engine model', () => {
    test('layout copied from read; flagged_layout params round-trip', () => {
        const layout: Layout = { payload: 'flags', regions: [{ name: '', notes: 'Scratch notes.' }] };
        assert.deepStrictEqual(toEngineModel(form(), { layout, frontmatter: {} }).layout, layout);
        const p = fixture<{ params: { model: EngineModel } }>('artifact.update', 'flagged_layout').params.model;
        assert.strictEqual(toEngineModel(form({ title: 'Flagged v2' }), { layout: p.layout, frontmatter: {} }).layout?.payload, 'flags');
    });

    test('index and paths both copied (paths-only copy un-indexes the file)', () => {
        const m = toEngineModel(form(), { frontmatter: { index: true, paths: ['src'] } });
        assert.strictEqual(m.index, true);
        assert.deepStrictEqual(m.paths, ['src']);
    });

    test('no read => no layout/index/paths keys', () => {
        const m = toEngineModel(form());
        assert.ok(!('layout' in m) && !('index' in m) && !('paths' in m));
    });

    test('var defaultValue becomes value', () => {
        const b = toEngineModel(form({ blocks: [{ heading: '', description: '', language: '', code: '', vars: [{ name: 'VK-a', defaultValue: 'x' }] }] })).blocks?.[0];
        assert.deepStrictEqual(b?.vars, [{ name: 'VK-a', value: 'x' }]);
    });

    test('untitled block sent with heading \'\'', () => {
        assert.strictEqual(toEngineModel(form()).blocks?.[0]?.heading, '');
    });

    test('fromEngineModel keeps block language', () => {
        const e = fixture<{ expect: EngineModel }>('artifact.prefill', 'selection_tsx').expect;
        assert.strictEqual(fromEngineModel(e).blocks?.[0]?.language, 'tsx');
    });

    test('engineMeta: undefined for TS-parsed, meta for engine read', () => {
        const r = fixture<{ expect: EngineArtifact }>('artifact.read', 'ok').expect;
        const parsed = toParsedArtifactFile(r, '/v');
        assert.strictEqual(engineMeta({ filePath: '/v/a.md', fileName: 'a.md', relativePath: 'a.md', frontmatter: parsed.frontmatter, code: '', vars: [], blocks: [] }), undefined);
        assert.strictEqual(engineMeta(parsed)?.hash, r.hash);
        assert.strictEqual(engineMeta(parsed)?.relPath, r.filePath);
    });
});
