import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
    buildVariableCommandIds,
    handleNewFile, handleNewSubSet, handleAddVar, handleEditValue,
    handleRenameVar, handleRenameSubSet, handleDeleteVar, handleDeleteSubSet, handleDeleteFile,
} from '../src/commands/variables.command.js';
import { fileNodePath, subsetIndex, varIndex, type CommandIO } from '../src/commands/variables.command.helpers.js';
import { VariablesViewProvider, type VariableNode } from '../src/ui/views/variablesView.provider.js';
import { startVarsEngine, recordedSource, VAULT, type VarsEngine } from './vars-engine.js';

/**
 * The `md-artifacts.variables.*` tree commands, through the engine: every edit is one `vars.*` request
 * carrying the hash of the `artifact.read` the handler just did. Rejections assert the sink (requests sent).
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const fileNode = (filePath: string, shape?: VariableNode['shape']): VariableNode =>
    ({ id: filePath, parentId: null, kind: 'file', label: path.basename(filePath), ...(shape ? { shape } : {}) });
const subsetNode = (filePath: string, subIdx: number): VariableNode =>
    ({ id: `${filePath}::subset:${subIdx}`, parentId: filePath, kind: 'subset', label: `sub${subIdx}` });
const varNode = (filePath: string, subIdx: number, idx: number): VariableNode => {
    const parentId = `${filePath}::subset:${subIdx}`;
    return { id: `${parentId}::var:${idx}`, parentId, kind: 'var', label: `var${idx}` };
};

/** Canned `CommandIO` — queued `showInputBox` answers, a fixed confirm result, captured errors. */
function makeIO(opts: { inputs?: (string | undefined)[]; confirmResult?: boolean } = {}): { io: CommandIO; errors: string[]; confirmCalls: string[] } {
    const inputs = [...(opts.inputs ?? [])];
    const errors: string[] = [], confirmCalls: string[] = [];
    const io: CommandIO = {
        showInputBox: () => Promise.resolve(inputs.shift()),
        confirm: message => { confirmCalls.push(message); return Promise.resolve(opts.confirmResult ?? true); },
        showError: message => { errors.push(message); },
        showQuickPick: () => Promise.resolve(undefined),
    };
    return { io, errors, confirmCalls };
}

/** Counts `refresh()` calls on a real provider without touching its I/O. */
function spyRefresh(provider: VariablesViewProvider): () => number {
    let count = 0;
    const original = provider.refresh.bind(provider);
    provider.refresh = () => { count += 1; original(); };
    return () => count;
}

const WRITES = ['vars.file.new', 'vars.meta.tags', 'vars.subset.add', 'vars.subset.rename', 'vars.subset.delete',
    'vars.var.add', 'vars.var.rename', 'vars.var.set', 'vars.var.delete', 'artifact.delete'];

suite('Variables pane commands (engine)', () => {
    let eng: VarsEngine, provider: VariablesViewProvider, refreshes: () => number;
    let sets: string, setsMd: string, flat: string, flatMd: string;
    const writes = (): number => WRITES.reduce((n, m) => n + eng.calls(m).length, 0);

    setup(() => {
        eng = startVarsEngine();
        provider = new VariablesViewProvider();
        refreshes = spyRefresh(provider);
        setsMd = recordedSource('vars-sets');
        flatMd = recordedSource('vars-flat');
        sets = eng.serve('Variables/sets.md', setsMd);
        flat = eng.serve('Variables/flat.md', flatMd);
    });
    teardown(() => eng.dispose());

    suite('buildVariableCommandIds', () => {
        test('equals the package.json mirror (id set, not a count)', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
                contributes: { commands: { command: string }[] };
            };
            const expected = pkg.contributes.commands.map(c => c.command).filter(id => id.startsWith('md-artifacts.variables.'));
            assert.deepStrictEqual([...buildVariableCommandIds()].sort(), [...expected].sort());
        });
    });

    suite('node-id parsing', () => {
        test('file/subset/var ids round-trip', () => {
            const fp = '/vault/Variables/env.md';
            assert.strictEqual(fileNodePath(varNode(fp, 1, 0)), fp);
            assert.strictEqual(subsetIndex(fileNode(fp)), undefined);
            assert.strictEqual(subsetIndex(varNode(fp, 1, 0)), 1);
            assert.strictEqual(varIndex(subsetNode(fp, 1)), undefined);
            assert.strictEqual(varIndex(varNode(fp, 1, 0)), 0);
        });
    });

    suite('requests carry path, the read hash and the engine sub-set ref', () => {
        test('rename var in sub-set 1 sends vars.var.rename with {index:1, heading:Prod}', async () => {
            const { io } = makeIO({ inputs: ['port2'] });
            await handleRenameVar(varNode(sets, 1, 1), provider, io, VAULT);
            assert.deepStrictEqual(eng.calls('vars.var.rename').map(c => c.params), [{
                path: 'Variables/sets.md', expectedHash: eng.hashOf(setsMd),
                subset: { index: 1, heading: 'Prod' }, name: 'VK-port', newName: 'VK-port2',
            }]);
            assert.strictEqual(refreshes(), 1);
        });

        test('🔒 a flat file sends NO subset key (its pseudo-row heading is the file title)', async () => {
            const { io } = makeIO({ inputs: ['server'] });
            await handleRenameVar(varNode(flat, 0, 0), provider, io, VAULT);
            const [call] = eng.calls('vars.var.rename');
            assert.ok(call);
            assert.ok(!('subset' in (call.params as object)), 'flat edit must not carry a subset');
            assert.deepStrictEqual(call.params, { path: 'Variables/flat.md', expectedHash: eng.hashOf(flatMd), name: 'VK-host', newName: 'VK-server' });
        });

        test('sub-set ops on a flat file address {0, ""} (vars.subset.delete/flat)', async () => {
            await handleDeleteSubSet(fileNode(flat, 'flat'), provider, makeIO().io, VAULT);
            assert.deepStrictEqual(eng.calls('vars.subset.delete').map(c => (c.params as { subset: unknown }).subset), [{ index: 0, heading: '' }]);
        });

        test('edit value → vars.var.set; add var → vars.var.add; new sub-set → vars.subset.add; rename/delete sub-set', async () => {
            await handleEditValue(varNode(sets, 0, 0), provider, makeIO({ inputs: ['127.0.0.1'] }).io, VAULT);
            await handleAddVar(subsetNode(sets, 1), provider, makeIO({ inputs: ['user', 'bob'] }).io, VAULT);
            await handleNewSubSet(fileNode(sets, 'sets'), provider, makeIO({ inputs: ['Staging'] }).io, VAULT);
            await handleRenameSubSet(subsetNode(sets, 1), provider, makeIO({ inputs: ['Live'] }).io, VAULT);
            await handleDeleteVar(varNode(sets, 1, 0), provider, makeIO().io, VAULT);
            await handleDeleteSubSet(subsetNode(sets, 0), provider, makeIO().io, VAULT);
            const p = (m: string): unknown => eng.calls(m)[0]?.params;
            const base = { path: 'Variables/sets.md', expectedHash: eng.hashOf(setsMd) };
            assert.deepStrictEqual(p('vars.var.set'), { ...base, subset: { index: 0, heading: 'Dev' }, name: 'VK-host', value: '127.0.0.1' });
            assert.deepStrictEqual(p('vars.var.add'), { ...base, subset: { index: 1, heading: 'Prod' }, name: 'VK-user', value: 'bob' });
            assert.deepStrictEqual(p('vars.subset.add'), { ...base, heading: 'Staging' });
            assert.deepStrictEqual(p('vars.subset.rename'), { ...base, subset: { index: 1, heading: 'Prod' }, heading: 'Live' });
            assert.deepStrictEqual(p('vars.var.delete'), { ...base, subset: { index: 1, heading: 'Prod' }, name: 'VK-host' });
            assert.deepStrictEqual(p('vars.subset.delete'), { ...base, subset: { index: 0, heading: 'Dev' } });
        });

        test('add var on a blank file sends vars.var.add without subset', async () => {
            const blank = eng.serve('Variables/blank.md', recordedSource('vars-blank-new'));
            await handleAddVar(fileNode(blank, 'blank'), provider, makeIO({ inputs: ['host', 'h'] }).io, VAULT);
            assert.deepStrictEqual(eng.calls('vars.var.add').map(c => c.params), [
                { path: 'Variables/blank.md', expectedHash: eng.hashOf(recordedSource('vars-blank-new')), name: 'VK-host', value: 'h' },
            ]);
        });

        test('conflict: modal, no re-send, Reload refreshes the pane', async () => {
            eng.fake.on('vars.var.set', () => ({ error: { code: 'file.conflict', params: { path: 'Variables/flat.md' } } }));
            await handleEditValue(varNode(flat, 0, 0), provider, makeIO({ inputs: ['x'] }).io, VAULT);
            assert.deepStrictEqual(eng.modals, ['"flat.md" changed on disk since it was opened.']);
            assert.strictEqual(eng.calls('vars.var.set').length, 1);
            assert.strictEqual(refreshes(), 1, 'only the Reload refresh, not a success refresh');
        });
    });

    suite('🔒 containment: only Variables/ is read', () => {
        test('inside Variables/ ⇒ exactly one artifact.read; inside the vault but outside ⇒ zero', async () => {
            await handleDeleteFile(fileNode(flat), provider, makeIO({ confirmResult: false }).io, VAULT);
            assert.strictEqual(eng.calls('artifact.read').length, 1);

            const other = eng.serve('Snippets/x.md', flatMd);
            const { io, errors } = makeIO();
            await handleRenameVar(varNode(other, 0, 0), provider, io, VAULT);
            await handleDeleteFile(fileNode(other), provider, io, VAULT);
            assert.strictEqual(eng.calls('artifact.read').length, 1, 'no read for a node outside Variables/');
            assert.strictEqual(errors.length, 2);
            assert.strictEqual(writes(), 0);
        });

        test('a sibling dir sharing the prefix ("Variables-old/") is outside too', async () => {
            const other = eng.serve('Variables-old/x.md', flatMd);
            await handleDeleteFile(fileNode(other), provider, makeIO().io, VAULT);
            assert.strictEqual(eng.calls('artifact.read').length, 0);
        });
    });

    suite('Cancel / Escape / decline / no-op send nothing', () => {
        const cases: [string, () => Promise<void>][] = [
            ['new sub-set cancelled', () => handleNewSubSet(fileNode(sets, 'sets'), provider, makeIO({ inputs: [undefined] }).io, VAULT)],
            ['add var: name cancelled', () => handleAddVar(subsetNode(sets, 0), provider, makeIO({ inputs: [undefined] }).io, VAULT)],
            ['add var: value cancelled', () => handleAddVar(subsetNode(sets, 0), provider, makeIO({ inputs: ['a', undefined] }).io, VAULT)],
            ['edit value cancelled', () => handleEditValue(varNode(sets, 0, 0), provider, makeIO({ inputs: [undefined] }).io, VAULT)],
            ['edit value unchanged', () => handleEditValue(varNode(sets, 0, 0), provider, makeIO({ inputs: ['localhost'] }).io, VAULT)],
            ['rename var cancelled', () => handleRenameVar(varNode(sets, 0, 0), provider, makeIO({ inputs: [undefined] }).io, VAULT)],
            ['rename var unchanged', () => handleRenameVar(varNode(sets, 0, 0), provider, makeIO({ inputs: ['host'] }).io, VAULT)],
            ['rename sub-set unchanged', () => handleRenameSubSet(subsetNode(sets, 0), provider, makeIO({ inputs: ['Dev'] }).io, VAULT)],
            ['delete var declined', () => handleDeleteVar(varNode(sets, 0, 0), provider, makeIO({ confirmResult: false }).io, VAULT)],
            ['delete sub-set declined', () => handleDeleteSubSet(subsetNode(sets, 0), provider, makeIO({ confirmResult: false }).io, VAULT)],
            ['delete file declined', () => handleDeleteFile(fileNode(sets), provider, makeIO({ confirmResult: false }).io, VAULT)],
            ['new file cancelled', () => handleNewFile(provider, makeIO({ inputs: [undefined] }).io, VAULT)],
        ];
        for (const [name, run] of cases) {
            test(name, async () => {
                await run();
                assert.strictEqual(writes(), 0);
                assert.strictEqual(refreshes(), 0);
            });
        }

        test('no argument refuses with a toast: no read, no write', async () => {
            const { io, errors } = makeIO({ inputs: ['x'] });
            await handleNewSubSet(undefined, provider, io, VAULT);
            await handleDeleteVar(undefined, provider, io, VAULT);
            await handleDeleteSubSet(undefined, provider, io, VAULT);
            await handleDeleteFile(undefined, provider, io, VAULT);
            assert.strictEqual(errors.length, 4);
            assert.strictEqual(eng.calls('artifact.read').length, 0);
            assert.strictEqual(writes(), 0);
        });
    });

    // H3.0e (W3): the prompt-display half of "`VK-` is fixed, not typed" — the wire half is `:134` / `:110`.
    suite('VK- name prompts', () => {
        const capture = (): { io: CommandIO; seen: vscode.InputBoxOptions[] } => {
            const seen: vscode.InputBoxOptions[] = [];
            return { seen, io: { ...makeIO().io, showInputBox: o => { seen.push(o); return Promise.resolve(undefined); } } };
        };

        test('add var: the name box starts empty — no editable VK- pre-fill', async () => {
            const { io, seen } = capture();
            await handleAddVar(subsetNode(sets, 1), provider, io, VAULT);
            assert.strictEqual(seen[0]?.value, '');
        });

        test('rename var: the box holds the name without VK-', async () => {
            const { io, seen } = capture();
            await handleRenameVar(varNode(sets, 1, 1), provider, io, VAULT);
            assert.strictEqual(seen[0]?.value, 'port');
        });
    });

    suite('handleNewSubSet prompt', () => {
        test('a set with no variables pre-fills the name with the set title; one with variables starts empty', async () => {
            const empty = eng.serve('Variables/empty.md', recordedSource('vars-blank-localdev'));
            const seen: vscode.InputBoxOptions[] = [];
            const io: CommandIO = { ...makeIO().io, showInputBox: o => { seen.push(o); return Promise.resolve(undefined); } };
            await handleNewSubSet(fileNode(empty, 'blank'), provider, io, VAULT);
            await handleNewSubSet(fileNode(sets, 'sets'), provider, io, VAULT);
            assert.deepStrictEqual(seen.map(o => o.value), ['Local Dev', '']);
        });

        test('a name already used by a sub-set is flagged while typing', async () => {
            const seen: vscode.InputBoxOptions[] = [];
            const io: CommandIO = { ...makeIO().io, showInputBox: o => { seen.push(o); return Promise.resolve(undefined); } };
            await handleNewSubSet(fileNode(sets, 'sets'), provider, io, VAULT);
            assert.ok(seen[0]?.validateInput?.('Dev'));
            assert.strictEqual(seen[0]?.validateInput?.('Staging'), undefined);
        });
    });

    suite('handleNewFile', () => {
        test('vars.file.new, then vars.var.add with the NEW result path+hash (no artifact.read), form opened at result.path', async () => {
            eng.fake.on('vars.file.new', () => ({ result: { path: 'Variables/local-dev.md', hash: 'h1' } }));
            const opened: string[] = [];
            await handleNewFile(provider, makeIO({ inputs: ['Local Dev'] }).io, VAULT, async u => { opened.push(u.fsPath); });
            assert.deepStrictEqual(eng.calls('vars.file.new').map(c => c.params), [{ title: 'Local Dev' }]);
            assert.deepStrictEqual(eng.calls('vars.var.add').map(c => c.params), [
                { path: 'Variables/local-dev.md', expectedHash: 'h1', name: 'VK-name', value: '' },
            ]);
            assert.strictEqual(eng.calls('artifact.read').length, 0);
            assert.deepStrictEqual(opened, ['/v/Variables/local-dev.md']);
            assert.strictEqual(refreshes(), 1);
        });

        test('a name collision (file.exists) toasts: no seed request, form not opened', async () => {
            eng.fake.on('vars.file.new', () => ({ error: { code: 'file.exists', params: { path: 'Variables/x.md' } } }));
            let opened = 0;
            await handleNewFile(provider, makeIO({ inputs: ['X'] }).io, VAULT, async () => { opened++; });
            assert.strictEqual(eng.calls('vars.var.add').length, 0);
            assert.strictEqual(opened, 0);
            assert.strictEqual(eng.toasts.length, 1);
        });
    });

    suite('handleDeleteFile', () => {
        test('sends artifact.delete {path, expectedHash}, refreshes; the confirm names the file', async () => {
            const { io, confirmCalls } = makeIO();
            await handleDeleteFile(fileNode(sets), provider, io, VAULT);
            assert.deepStrictEqual(eng.calls('artifact.delete').map(c => c.params), [{ path: 'Variables/sets.md', expectedHash: eng.hashOf(setsMd) }]);
            assert.ok(confirmCalls[0]?.includes('sets.md'));
            assert.strictEqual(refreshes(), 1);
        });
    });
});
