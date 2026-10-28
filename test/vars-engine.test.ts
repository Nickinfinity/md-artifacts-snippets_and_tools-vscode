import * as assert from 'node:assert';
import type { EngineArtifact } from '../src/types/engine.types.js';
import { startVarsEngine, recordedSource, type VarsEngine } from './vars-engine.js';
import { getEngine } from '../src/engine/engine.vscode.js';

/** The Variables harness serves recorded engine reads, never a TS parse of the bytes (ledger #44). */
suite('vars-engine harness', () => {
    let eng: VarsEngine;
    setup(() => { eng = startVarsEngine(); });
    teardown(() => eng.dispose());

    test('a recorded yaml VKs source is read back with its declared defaults', async () => {
        const abs = eng.serve('Variables/flat.md', recordedSource('vars-flat'));
        const rel = abs.slice(abs.indexOf('Variables/'));
        const read = await getEngine().request('artifact.read', { path: rel }) as EngineArtifact;
        assert.deepStrictEqual(read.vars, [{ name: 'VK-host', defaultValue: 'localhost' }]);
    });

    test('an unrecorded source throws instead of being parsed by a TS twin', () => {
        assert.throws(() => eng.serve('Variables/x.md', '---\nartifactType: Variables\ntitle: Nope\n---\n\n```yaml VKs\nVK-zz: 1\n```\n'), /unrecorded/);
    });
});
