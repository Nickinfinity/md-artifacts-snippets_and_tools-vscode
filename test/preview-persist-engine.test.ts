import * as assert from 'node:assert';
import { getEngine } from '../src/engine/engine.vscode.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { blockAsArtifact, persistBlockCode } from '../src/ui/panels/artifactPicker/preview.helpers.js';
import type { BlockRef } from '../src/ui/panels/artifactPicker/preview.types.js';
import { useVarsEngine } from './vars-engine.js';

const MULTI = '---\nartifactType: AIAgentsConfig\ntitle: Multi\n---\n\n## One\n\n```bash\necho one\n```\n\n## Two\n\n```bash\necho 2\n```\n';
const SINGLE = '---\nartifactType: Snippet\ntitle: Solo\nlanguage: ts\n---\n\n```ts\nlet a = 1;\n```\n';
const FLAGGED = '---\nartifactType: AIPrompt\ntitle: Flagged\n---\n\nnotes\n\n%%oa:start One%%\nfirst\n%%oa:end%%\n\n%%oa:start Two%%\nsecond\n%%oa:end%%\n';
const FLAGGED_ERR = { code: 'artifact.not_serializable', params: { reason: 'flagged' } } as const;

suite('persistBlockCode through the engine (T3.7)', () => {
    const eng = useVarsEngine();

    /** Gives the served file the `flags` layout the real engine reports (the harness parses with the TS parser, which has none). */
    async function serveFlagged(rel: string): Promise<void> {
        eng().serve(rel, FLAGGED);
        const read = await getEngine().request('artifact.read', { path: rel });
        eng().fake.on('artifact.read', () => ({ result: { ...read, layout: { payload: 'flags' } } }));
    }

    /** Reads `rel` through the fake and returns the artifact the preview would hold for `ref`. */
    async function open(rel: string, ref: BlockRef) {
        const read = await getEngine().request('artifact.read', { path: rel });
        const file = toParsedArtifactFile(read, '/v');
        const b = ref.kind === 'multi' ? file.blocks.find(x => x.heading === ref.heading) : undefined;
        return { file, hash: read.hash, artifact: b ? blockAsArtifact(b, file) : file };
    }
    const patches = () => eng().calls('artifact.patch').map(c => c.params as { path: string; expectedHash: string; edit: Record<string, unknown> });
    const updates = () => eng().calls('artifact.update').map(c => c.params as { expectedHash: string; model: { title: string; layout?: { payload: string }; blocks: { code: string }[] } });

    test('single block sends patch {field:code} with the read hash', async () => {
        eng().serve('Snippets/solo.md', SINGLE);
        eng().fake.on('artifact.patch', p => ({ result: { path: (p as { path: string }).path, hash: 'h2' } }));
        const o = await open('Snippets/solo.md', { kind: 'single' });
        const r = await persistBlockCode({ artifact: o.artifact, blockRef: { kind: 'single' }, newCode: 'let a = 2;' });
        assert.ok(r, 'no result');
        assert.deepStrictEqual(patches().map(p => [p.expectedHash, p.edit]), [[o.hash, { field: 'code', code: 'let a = 2;' }]]);
        assert.strictEqual(updates().length, 0);
    });

    test('multi block sends block index + heading', async () => {
        eng().serve('AIAgentsConf/multi.md', MULTI);
        eng().fake.on('artifact.patch', p => ({ result: { path: (p as { path: string }).path, hash: 'h2' } }));
        const ref: BlockRef = { kind: 'multi', heading: 'Two' };
        const o = await open('AIAgentsConf/multi.md', ref);
        const r = await persistBlockCode({ artifact: o.artifact, blockRef: ref, newCode: 'echo 2' });
        assert.deepStrictEqual(patches()[0]?.edit, { field: 'code', block: 1, heading: 'Two', code: 'echo 2' });
        assert.strictEqual(patches()[0]?.expectedHash, o.hash);
        assert.strictEqual(r?.current.frontmatter.title, 'Two', 'current is the re-adapted block');
        assert.strictEqual(r?.file.frontmatter.title, 'Multi');
    });

    test('flagged: one patch, then one update from the fresh read; no toast', async () => {
        await serveFlagged('AIPrompts/f.md');
        eng().fake.on('artifact.patch', () => ({ error: FLAGGED_ERR }));
        eng().fake.on('artifact.update', p => ({ result: { path: (p as { path: string }).path, hash: 'h2' } }));
        const ref: BlockRef = { kind: 'multi', heading: 'Two' };
        const o = await open('AIPrompts/f.md', ref);
        assert.strictEqual(o.artifact.frontmatter.title, 'Two'); // blockAsArtifact renamed it: must not leak into the model
        await persistBlockCode({ artifact: o.artifact, blockRef: ref, newCode: 'changed' });
        assert.strictEqual(patches().length, 1);
        assert.strictEqual(updates().length, 1);
        const u = updates()[0]!;
        assert.strictEqual(u.expectedHash, o.hash);
        assert.strictEqual(u.model.layout?.payload, 'flags');
        assert.strictEqual(u.model.blocks.length, 2, 'the other region survives');
        assert.strictEqual(u.model.title, 'Flagged');
        assert.deepStrictEqual(u.model.blocks.map(b => b.code), ['first', 'changed']);
        assert.deepStrictEqual(eng().toasts, []);
    });

    test('conflict: modal, zero update', async () => {
        eng().serve('AIPrompts/f.md', FLAGGED);
        eng().fake.on('artifact.patch', () => ({ error: { code: 'file.conflict', params: { path: 'AIPrompts/f.md' } } }));
        const ref: BlockRef = { kind: 'multi', heading: 'Two' };
        const o = await open('AIPrompts/f.md', ref);
        const r = await persistBlockCode({ artifact: o.artifact, blockRef: ref, newCode: 'x' });
        assert.strictEqual(r, undefined);
        assert.strictEqual(updates().length, 0);
        assert.strictEqual(eng().modals.length, 1);
    });
});
