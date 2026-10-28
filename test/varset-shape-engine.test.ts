import * as assert from 'node:assert';
import { getVarsFileShape } from '../src/services/varset.service.js';
import { toParsedArtifactFile, varsFileToParsed } from '../src/engine/adapt.js';
import { DEFAULT_SUBSET_NAME } from '../src/ui/panels/varsetForm/varsetForm.subsets.js';
import type { VarsFile } from '../src/types/engine.types.js';
import { recordedRead, recordedVarsList } from './recorded.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T5.3 — `getVarsFileShape` classifies adapter output, so it must agree with the engine's own
 * `shape` on every recorded Variables file (both adapters), and the default sub-set name must be
 * the one `vars.subset.add` writes.
 */
const files = (recordedVarsList() as { files: readonly VarsFile[] }).files;

suite('varset shape — pinned to the engine', () => {
    test('the recording set covers blank, flat and sets (>= 5 files)', () => {
        assert.ok(files.length >= 5, `only ${files.length} recorded files`);
        assert.deepStrictEqual([...new Set(files.map(f => f.shape))].sort(), ['blank', 'flat', 'sets']);
    });

    test('getVarsFileShape(varsFileToParsed(f)) equals the engine shape for every file', () => {
        for (const f of files) {
            assert.strictEqual(getVarsFileShape(varsFileToParsed(f, '/v')), f.shape, f.path);
        }
    });

    test('getVarsFileShape(toParsedArtifactFile(read)) equals the engine shape for every file', () => {
        for (const f of files) {
            const read = recordedRead(path.basename(f.path, '.md'));
            assert.strictEqual(getVarsFileShape(toParsedArtifactFile(read, '/v')), f.shape, f.path);
        }
    });
});

suite('varset default sub-set name — pinned to vars.subset.add', () => {
    test('DEFAULT_SUBSET_NAME is the heading the engine writes onto a flat file', () => {
        const dir = path.join(__dirname, '..', '..', 'test', 'fixtures', 'engine', 'op-cases', 'vars.subset.add');
        const c = JSON.parse(fs.readFileSync(path.join(dir, 'flat.json'), 'utf8')) as { expect_files: Record<string, string> };
        assert.ok(c.expect_files['Variables/flat.md']?.includes(`## ${DEFAULT_SUBSET_NAME}\n`));
    });
});
