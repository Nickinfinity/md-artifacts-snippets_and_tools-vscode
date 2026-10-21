import * as assert from 'assert';
import { planLegacyImport } from '../src/engine/legacy-import.js';

const base = {
    engineSource: 'none' as const,
    legacyVaultPath: '/v',
    legacyFlags: { Command: true },
    alreadyImported: false,
    defaults: { Snippet: true, Command: false },
    inspect: { isObsidianVault: true },
};

suite('planLegacyImport', () => {
    test('engine default wins: nothing to import', () => {
        assert.deepStrictEqual(planLegacyImport({ ...base, engineSource: 'default' }), []);
    });
    test('selects the vault and sets only flags that differ from the default', () => {
        assert.deepStrictEqual(
            planLegacyImport({ ...base, legacyFlags: { Command: true, Snippet: true } }),
            [
                { op: 'vault.select', path: '/v', createDefaults: false },
                { op: 'types.set_enabled', type: 'Command', enabled: true },
            ],
        );
    });
    test('non-vault, failed inspect, already imported, empty path => []', () => {
        assert.deepStrictEqual(planLegacyImport({ ...base, inspect: { isObsidianVault: false } }), []);
        assert.deepStrictEqual(planLegacyImport({ ...base, inspect: undefined }), []);
        assert.deepStrictEqual(planLegacyImport({ ...base, alreadyImported: true }), []);
        assert.deepStrictEqual(planLegacyImport({ ...base, legacyVaultPath: '' }), []);
    });
    test('steps follow the order of defaults keys', () => {
        const steps = planLegacyImport({
            ...base,
            defaults: { Snippet: true, Command: false, Template: false },
            legacyFlags: { Template: true, Snippet: false },
        });
        assert.deepStrictEqual(steps.slice(1).map(s => (s.op === 'types.set_enabled' ? s.type : '')), ['Snippet', 'Template']);
    });
});
