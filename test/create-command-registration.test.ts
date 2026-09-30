import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildCreateCommandIds } from '../src/commands/create-from-surface.command.js';

/**
 * Extension-host counterpart to `package-create-menus.test.ts`.
 *
 * That suite pins the **manifest** — every derived id has a `contributes`
 * entry, in the right group, with the right `when`. What a static pin cannot
 * catch is `extension.ts` never calling `registerCreateSurfaceCommands`, or the
 * view provider never being registered: the manifest stays perfectly correct,
 * every menu entry renders, and clicking one raises "command not found" with
 * the whole manifest suite green.
 *
 * That was the live state of this branch until Wave 1 close — eight contributed
 * menu entries, none of them wired, and no test that could tell. This suite is
 * what fails instead of the user.
 */
suite('create surface registration — extension host', () => {

	/**
	 * Activates the extension and returns every live command id.
	 *
	 * @returns The registered command ids, including built-ins.
	 * @example
	 * (await registeredCommands()).includes('md-artifacts.create.snippets');
	 */
	async function registeredCommands(): Promise<string[]> {
		const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'md-artifacts-snippets-and-tools-vscode');
		await ext?.activate();
		return vscode.commands.getCommands(true);
	}

	test('every derived create command id is actually registered', async () => {
		const registered = await registeredCommands();
		const derived = buildCreateCommandIds();

		// Guard the guard: an empty derivation would make the loop below vacuous.
		assert.ok(derived.length >= 5, `derivation collapsed to ${derived.length} ids`);

		for (const id of derived) {
			assert.ok(
				registered.includes(id),
				`${id} is contributed in package.json but never registered — `
				+ 'extension.ts must call registerCreateSurfaceCommands',
			);
		}
	});

	test('every contributed webview view has a registered provider', async () => {
		const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'md-artifacts-snippets-and-tools-vscode');
		await ext?.activate();

		// Read the ids from the manifest rather than from the provider class.
		// VS Code resolves what `contributes.views` declares, so that is the id
		// whose provider must exist — asserting against the class's own constant
		// would pass happily while the two drifted apart and the pane stayed dead.
		const views = (ext?.packageJSON?.contributes?.views?.['md-artifacts'] ?? []) as
			{ id: string; type?: string }[];
		const webviewIds = views.filter(v => v.type === 'webview').map(v => v.id);
		assert.ok(webviewIds.length > 0, 'no webview views contributed — expected md-artifacts.mainView');

		for (const id of webviewIds) {
			// `registerWebviewViewProvider` throws on a duplicate id, so a second
			// registration *succeeding* proves the first never happened. Failing
			// to throw is the assertion — an unregistered view renders as a
			// permanent "no data provider registered" pane with no error anywhere.
			let alreadyRegistered = false;
			try {
				vscode.window.registerWebviewViewProvider(id, { resolveWebviewView: () => { /* probe */ } })
					.dispose();
			} catch {
				alreadyRegistered = true;
			}
			assert.ok(
				alreadyRegistered,
				`${id} is contributed but has no provider — extension.ts must call `
				+ 'registerWebviewViewProvider, or the pane shows "no data provider registered"',
			);
		}
	});

	test('every contributed variables command is actually registered', async () => {
		// #52's lesson, applied to Wave 6: the manifest guard proves the nine ids
		// are *declared*, and stays green whether or not anything registered them.
		// A menu entry pointing at an unregistered id raises "command not found"
		// only when the user clicks it — which, for a delete command, is the worst
		// possible moment to discover it.
		const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'md-artifacts-snippets-and-tools-vscode');
		await ext?.activate();

		const declared = (ext?.packageJSON?.contributes?.commands ?? []) as { command: string }[];
		const variableIds = declared
			.map(c => c.command)
			.filter(id => id.startsWith('md-artifacts.variables.'));
		assert.ok(variableIds.length > 0, 'no variables commands contributed');

		const registered = await vscode.commands.getCommands(true);
		for (const id of variableIds) {
			assert.ok(
				registered.includes(id),
				`${id} is contributed but never registered — its menu item raises "command not found" on click`,
			);
		}
	});

	test('every contributed tree view is registered in extension.ts', () => {
		// A *static* check, deliberately, and the limitation is the point:
		// `registerTreeDataProvider` silently REPLACES an existing provider
		// instead of throwing, so the duplicate-registration probe the webview
		// test above relies on cannot work here — a probe would always "succeed"
		// and prove nothing. Reading the source is the only check available, so
		// it is the check taken, rather than a runtime-looking assertion that
		// cannot fail. Catches ledger #52's actual failure: nothing registered.
		const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'md-artifacts-snippets-and-tools-vscode');
		const views = (ext?.packageJSON?.contributes?.views?.['md-artifacts'] ?? []) as
			{ id: string; type?: string }[];
		const treeIds = views.filter(v => v.type !== 'webview').map(v => v.id);
		assert.ok(treeIds.length > 0, 'no tree views contributed — expected md-artifacts.variablesView');

		const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.ok(
			source.includes('registerTreeDataProvider'),
			'extension.ts calls registerTreeDataProvider nowhere, so every contributed tree view is dead',
		);

		for (const id of treeIds) {
			// The id may be spelled via the provider's `viewType` constant rather
			// than a literal, so accept either — what must not happen is a
			// contributed view no code path names at all.
			const constantName = `${id.split('.').pop() ?? ''}`;
			assert.ok(
				source.includes(id) || new RegExp(`${constantName}`, 'i').test(source),
				`${id} is contributed but extension.ts never names it — the view renders permanently empty with no error`,
			);
		}
	});
});
