import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getLegacyFeatureFlags, getVaultPath, CONFIG_SECTION } from '../src/services/config.service.js';
import { getSessionVault, setSessionVault } from '../src/services/vault-watch.service.js';

suite('config.service — session vault', () => {
    teardown(async () => {
        setSessionVault(undefined);
        await vscode.workspace.getConfiguration(CONFIG_SECTION)
            .update('features.snippets', undefined, vscode.ConfigurationTarget.Global);
    });

    test('session vault round trip', () => {
        setSessionVault('/a');
        assert.strictEqual(getSessionVault(), '/a');
        setSessionVault(undefined);
        assert.strictEqual(getSessionVault(), undefined);
    });

    test('getVaultPath reads the session vault', () => {
        setSessionVault('/new');
        assert.strictEqual(getVaultPath(), '/new');
        setSessionVault(undefined);
        assert.strictEqual(getVaultPath(), '');
    });

    test('getLegacyFeatureFlags returns explicit values only, keyed by ArtifactType', async () => {
        await vscode.workspace.getConfiguration(CONFIG_SECTION)
            .update('features.snippets', true, vscode.ConfigurationTarget.Global);
        assert.deepStrictEqual(getLegacyFeatureFlags(), { Snippet: true });
    });
});
