import * as assert from 'node:assert';
import { contextKeysFor, refreshVaultContext } from '../src/services/context.service.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { createFakeEngine } from './fake-engine.js';

const toMap = (keys: ReadonlyArray<readonly [string, boolean]>): Map<string, boolean> => new Map(keys);

suite('context keys from types.list', () => {
	test('active = enabled && dirExists; vaultConfigured = rows present', () => {
		const m = toMap(contextKeysFor([
			{ type: 'Snippet', dir: 'Snippets', enabled: true, dirExists: true },
			{ type: 'Command', dir: 'Commands', enabled: true, dirExists: false },
			{ type: 'Template', dir: 'Templates', enabled: false, dirExists: true },
		]));
		assert.strictEqual(m.get('md-artifacts.snippetsActive'), true);
		assert.strictEqual(m.get('md-artifacts.commandsActive'), false);
		assert.strictEqual(m.get('md-artifacts.templatesActive'), false);
		assert.strictEqual(m.get('md-artifacts.vaultConfigured'), true);
	});

	test('engine-only types are ignored, not thrown on', () => {
		const rows = [{ type: 'Zzz', dir: 'Zzz', enabled: true, dirExists: true }] as never;
		assert.strictEqual(toMap(contextKeysFor(rows)).get('md-artifacts.vaultConfigured'), true);
	});

	test('refresh with vault.not_selected: all keys false, no toast, resolves', async () => {
		const fake = createFakeEngine();
		fake.on('types.list', () => ({ error: { code: 'vault.not_selected', params: {} } }));
		const errors: string[] = [];
		const handle = startEngine({
			spawn: () => fake, enginePath: process.execPath,
			showError: async (m) => { errors.push(m); return undefined; },
		});
		try {
			const set = new Map<string, unknown>();
			await refreshVaultContext((k, v) => { set.set(k, v); return Promise.resolve(); });
			assert.ok(set.size > 0);
			assert.ok(set.has('md-artifacts.vaultConfigured'));
			assert.ok(set.has('md-artifacts.explorerCreateHasMultiple'));
			assert.deepStrictEqual([...set.values()].filter(v => v !== false), []);
			assert.deepStrictEqual(errors, []);
		} finally {
			handle.dispose();
		}
	});
});
