import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';
import type { Subset, VarsFile } from '../src/types/engine.types.js';
import { VarSetScanner } from '../src/services/varset.service.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';

/**
 * VarSetScanner over the fake engine: `scan` is one `vars.list`, adapted to the parsed shape,
 * cached per directory until `invalidate()`. Directory walking and type filtering are engine-owned.
 */

const DIR = vscode.Uri.file('/v/Variables');

/**
 * Builds a sub-set with one variable.
 *
 * @param heading - Sub-set heading.
 * @param extra   - Fields merged over the defaults (e.g. `varsError`).
 * @returns A `Subset`.
 * @example
 * subset('Dev', { varsError: { code: 'x.y', params: {} } });
 */
function subset(heading: string, extra: Partial<Subset> = {}): Subset {
    return { index: 0, heading, description: '', vars: [{ name: 'VK-a', defaultValue: heading }], ...extra };
}

/**
 * Builds a `sets` listing entry.
 *
 * @param name  - File name stem.
 * @param subs  - Its sub-sets.
 * @param extra - Fields merged over the defaults.
 * @returns A `VarsFile`.
 * @example
 * file('all', [subset('Dev'), subset('Prod')]);
 */
function file(name: string, subs: Subset[], extra: Partial<VarsFile> = {}): VarsFile {
    return { path: `Variables/${name}.md`, name, shape: 'sets', subsets: subs, ...extra };
}

suite('VarSetScanner', () => {
    let fake: FakeEngine;
    let handle: vscode.Disposable;
    let listing: VarsFile[];
    const showError = (): Thenable<string | undefined> => Promise.resolve(undefined);

    const requests = (): number => fake.received.filter(r => r.method === 'vars.list').length;

    setup(() => {
        listing = [];
        fake = createFakeEngine();
        fake.on('vars.list', () => ({ result: { files: listing } }));
        handle = startEngine({ spawn: () => fake, enginePath: process.execPath, showError });
        setSessionVault('/v');
    });
    teardown(() => { setSessionVault(undefined); handle.dispose(); });

    test('a sets file arrives with one block per sub-set, fenceLang yaml VKs', async () => {
        listing = [file('all', [subset('Dev'), subset('Prod')])];
        const files = await new VarSetScanner().scan(DIR);
        assert.strictEqual(files.length, 1);
        assert.deepStrictEqual(files[0].blocks.map(b => b.heading), ['Dev', 'Prod']);
        assert.strictEqual(files[0].blocks[0].fenceLang, 'yaml VKs');
        assert.strictEqual(files[0].filePath, '/v/Variables/all.md');
        assert.ok(files.every((f: ParsedArtifactFile) => f.frontmatter.artifactType === 'Variables'));
    });

    test('a flat file has blocks: [] and its vars on the top level', async () => {
        listing = [{ path: 'Variables/simple.md', name: 'simple', shape: 'flat', subsets: [subset('')] }];
        const [f] = await new VarSetScanner().scan(DIR);
        assert.deepStrictEqual(f.blocks, []);
        assert.deepStrictEqual(f.vars.map(v => v.name), ['VK-a']);
    });

    test('an empty listing is an empty array', async () => {
        assert.deepStrictEqual(await new VarSetScanner().scan(DIR), []);
    });

    test('Q4: files with error, file-level varsError or a sub-set varsError are skipped', async () => {
        const bad = { code: 'vars.bad', params: {} };
        listing = [
            file('good', [subset('Dev')]),
            file('io', [], { error: { code: 'io.failed' } }),
            file('fileLevel', [subset('Dev')], { varsError: bad }),
            file('inSet', [subset('A'), subset('B', { varsError: bad })]),
        ];
        const files = await new VarSetScanner().scan(DIR);
        assert.deepStrictEqual(files.map(f => f.fileName), ['good']);
    });

    test('second scan is cached: same references, one vars.list', async () => {
        listing = [file('dev', [subset('Dev')])];
        const scanner = new VarSetScanner();
        const first = await scanner.scan(DIR);
        const second = await scanner.scan(DIR);
        assert.strictEqual(second[0], first[0]);
        assert.strictEqual(requests(), 1);
    });

    test('cache is keyed by directory: another vault dir re-lists', async () => {
        const scanner = new VarSetScanner();
        await scanner.scan(DIR);
        await scanner.scan(vscode.Uri.file('/other/Variables'));
        assert.strictEqual(requests(), 2);
    });

    test('a failed vars.list yields [] and is never cached', async () => {
        let n = 0;
        fake.on('vars.list', () => (++n === 1
            ? { error: { code: 'io.failed', params: {} } }
            : { result: { files: [file('dev', [subset('Dev')])] } }));
        const scanner = new VarSetScanner();
        assert.deepStrictEqual(await scanner.scan(DIR), []);
        const second = await scanner.scan(DIR);
        assert.strictEqual(requests(), 2);
        assert.deepStrictEqual(second.map(f => f.fileName), ['dev']);
    });

    test('invalidate re-lists and returns fresh objects', async () => {
        listing = [file('dev', [subset('Dev')])];
        const scanner = new VarSetScanner();
        const first = await scanner.scan(DIR);
        scanner.invalidate();
        const second = await scanner.scan(DIR);
        assert.notStrictEqual(second[0], first[0]);
        assert.strictEqual(requests(), 2);
    });

    test('invalidate picks up files added and removed since the last scan', async () => {
        listing = [file('dev', [subset('Dev')])];
        const scanner = new VarSetScanner();
        await scanner.scan(DIR);
        listing = [file('dev', [subset('Dev')]), file('prod', [subset('Prod')])];
        assert.strictEqual((await scanner.scan(DIR)).length, 1, 'cached');
        scanner.invalidate();
        assert.deepStrictEqual((await scanner.scan(DIR)).map(f => f.fileName), ['dev', 'prod']);
        listing = [file('dev', [subset('Dev')])];
        scanner.invalidate();
        assert.deepStrictEqual((await scanner.scan(DIR)).map(f => f.fileName), ['dev']);
    });

    test('no session vault: [] without asking the engine', async () => {
        setSessionVault(undefined);
        assert.deepStrictEqual(await new VarSetScanner().scan(DIR), []);
        assert.strictEqual(requests(), 0);
    });
});
