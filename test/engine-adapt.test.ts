import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngineArtifact, VarsFile } from '../src/types/engine.types.js';
import { EngineRequestError } from '../src/engine/request-error.js';
import { toParsedArtifactFile, toVaultPath, varsFileToParsed } from '../src/engine/adapt.js';

const read = (n: string): EngineArtifact =>
    // sanctioned test-only cast: fixture JSON is untyped
    (JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/engine/op-cases/artifact.read', n), 'utf8')) as { expect: EngineArtifact }).expect;

const throwsProtocol = (fn: () => unknown): void =>
    assert.throws(fn, (e: unknown) => e instanceof EngineRequestError && e.data.code === 'client.protocol');

suite('engine adapt', () => {
    test('toVaultPath rejects escapes, siblings and the root', () => {
        assert.strictEqual(toVaultPath('/v/../etc/passwd', '/v'), undefined);
        assert.strictEqual(toVaultPath('/vault2/Snippets/a.md', '/vault'), undefined);
        assert.strictEqual(toVaultPath('/v', '/v'), undefined);
        assert.strictEqual(toVaultPath('/v/Snippets/a.md', '/v'), 'Snippets/a.md');
    });

    test('escaped or empty paths throw, nothing returned', () => {
        const ok = read('ok.json');
        for (const filePath of ['../../etc/x.md', '', '/etc/x.md', 'a/../b.md']) {
            throwsProtocol(() => toParsedArtifactFile({ ...ok, filePath }, '/v'));
        }
        for (const p of ['../x.md', '', '/etc/x.md', 'a/../b.md']) {
            throwsProtocol(() => varsFileToParsed({ path: p, name: 'x.md', subsets: [] }, '/v'));
        }
    });

    test('read maps paths, hash, layout', () => {
        const ok = read('ok.json');
        const r = toParsedArtifactFile(ok, '/v');
        assert.strictEqual(r.filePath, '/v/Snippets/hello.md');
        assert.strictEqual(r.relPath, 'Snippets/hello.md');
        assert.strictEqual(r.relativePath, 'hello.md');
        assert.strictEqual(r.hash, ok.hash);
        const flagged = read('flagged.json');
        assert.strictEqual(toParsedArtifactFile(flagged, '/v').layout?.payload, 'flags');
    });

    test('vars carry only name + defaultValue', () => {
        const r = toParsedArtifactFile(read('ok_structured.json'), '/v');
        assert.deepStrictEqual(Object.keys(r.vars[0]), ['name', 'defaultValue']);
    });

    test('varsFileToParsed shapes and error', () => {
        const vars = [{ name: 'VK-a', defaultValue: '1' }];
        const sub = { index: 0, heading: 'Dev', description: 'd', vars };
        const flat: VarsFile = { path: 'Variables/e.md', name: 'e.md', title: 'E', shape: 'flat', subsets: [{ ...sub, heading: '' }] };
        const f = varsFileToParsed(flat, '/v');
        assert.deepStrictEqual(f.vars, vars);
        assert.deepStrictEqual(f.blocks, []);
        assert.strictEqual(f.relativePath, 'e.md');
        assert.strictEqual(f.frontmatter.artifactType, 'Variables');
        const sets = varsFileToParsed({ ...flat, shape: 'sets', subsets: [sub] }, '/v');
        assert.deepStrictEqual(sets.vars, []);
        assert.strictEqual(sets.blocks[0].fenceLang, 'yaml VKs');
        assert.strictEqual(sets.blocks[0].heading, 'Dev');
        assert.strictEqual(varsFileToParsed({ ...flat, shape: 'blank', subsets: [] }, '/v').vars.length, 0);
        assert.strictEqual(varsFileToParsed({ ...flat, error: { code: 'io.failed' } }, '/v').error, 'io.failed');
    });
});
