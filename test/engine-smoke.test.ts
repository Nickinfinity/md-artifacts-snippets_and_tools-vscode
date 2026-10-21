import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineSupervisor } from '../src/engine/supervisor.js';
import { locateEngine } from '../src/engine/locate.js';
import { engineKnownTypes, isExecutableFile, spawnEngineProcess } from '../src/engine/engine.vscode.js';

suite('engine smoke (real binary)', () => {
    let tmp = '';
    let sup: EngineSupervisor | undefined;
    teardown(() => {
        sup?.dispose();
        sup = undefined;
        if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; }
    });

    test('artifact.read hello.md through the real mda', async function () {
        this.timeout(15_000);
        const found = locateEngine({
            settingPath: process.env['MDA_BIN'] ?? '', envPath: process.env['PATH'],
            platform: process.platform, isExecutableFile,
        });
        if (found.kind === 'not-found') {
            console.warn('ENGINE SMOKE SKIPPED: set MDA_BIN to the pinned v0.10.0 mda binary');
            this.skip();
            return;
        }
        // A set-but-bad MDA_BIN must fail, never skip.
        assert.strictEqual(found.kind, 'found', `MDA_BIN is not an executable absolute path: ${found.path}`);

        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-smoke-'));
        fs.cpSync(path.join(__dirname, '../../test/fixtures/engine/smoke-vault'), tmp, { recursive: true });
        fs.mkdirSync(path.join(tmp, '.obsidian'));

        sup = new EngineSupervisor({
            spawn: spawnEngineProcess, binPath: found.path,
            args: ['serve', '--vault', tmp], knownTypes: engineKnownTypes(),
        });
        const art = await sup.request('artifact.read', { path: 'Snippets/hello.md' });
        assert.deepStrictEqual(art.vars[0], { name: 'VK-greeting', defaultValue: 'marker-7f3a' });
        assert.strictEqual(sup.info?.engine, '0.10.0');
        assert.ok(sup.info?.protocol.startsWith('2.'), `protocol ${sup.info?.protocol}`);
    });
});
