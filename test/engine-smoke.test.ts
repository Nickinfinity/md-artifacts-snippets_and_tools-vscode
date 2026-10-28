import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineSupervisor } from '../src/engine/supervisor.js';
import { locateEngine } from '../src/engine/locate.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { toEngineModel } from '../src/engine/model.js';
import { artifactToFormModel } from '../src/commands/create-prefill.helpers.js';
import { pruneVarsForSave } from '../src/ui/panels/artifactForm/panel.helpers.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';
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

    // W-UI a: the form path over a real 2-region flagged file changes only the edited field.
    test('form-path update of a flagged AIPrompt is byte-identical except the title', async function () {
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
        assert.strictEqual(found.kind, 'found', `MDA_BIN is not an executable absolute path: ${found.path}`);
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-smoke-'));
        fs.mkdirSync(path.join(tmp, '.obsidian'));
        fs.mkdirSync(path.join(tmp, 'AIPrompts'));
        const file = path.join(tmp, 'AIPrompts', 'w.md');
        fs.writeFileSync(file, REFACTOR);
        sup = new EngineSupervisor({
            spawn: spawnEngineProcess, binPath: found.path,
            args: ['serve', '--vault', tmp], knownTypes: engineKnownTypes(),
        });
        const save = async (title?: string): Promise<void> => {
            const read = toParsedArtifactFile(await sup!.request('artifact.read', { path: 'AIPrompts/w.md' }), tmp);
            // the webview posts a complete model; the prefill is Partial only by type
            const m = { ...artifactToFormModel(read), ...(title === undefined ? {} : { title }) } as ArtifactFormModel;
            await sup!.request('artifact.update', {
                path: read.relPath, expectedHash: read.hash,
                model: toEngineModel({ ...m, blocks: pruneVarsForSave(m.blocks) }, read),
            });
        };
        await save();
        assert.strictEqual(fs.readFileSync(file, 'utf8'), REFACTOR, 'an unchanged save altered the bytes');
        await save('W2');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), REFACTOR.replace('title: W', 'title: W2'));
    });
});

/** Canonical 2-region flagged AIPrompt: notes, `***` rules, a `yaml VKs` fence (tags block list, last). */
const REFACTOR = [
    '---', 'artifactType: AIPrompt', 'title: W', 'tags:', '  - a', '---', '',
    'Intro notes.', '',
    '%%oa:start First%%', '***', 'Do <VK-x> now.', '***', '%%oa:end%%', '',
    'Between notes.', '',
    '%%oa:start Second%%', 'Then done.', '%%oa:end%%', '',
].join('\n');
