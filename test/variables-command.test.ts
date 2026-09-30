import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    buildVariableCommandIds,
    handleNewFile, handleNewSubSet, handleAddVar, handleEditValue,
    handleRenameVar, handleRenameSubSet, handleDeleteVar, handleDeleteSubSet, handleDeleteFile,
} from '../src/commands/variables.command.js';
import {
    toFormModel, fileNodePath, subsetIndex, varIndex, type CommandIO,
} from '../src/commands/variables.command.helpers.js';
import { parseFromContent, parseArtifactFile } from '../src/services/parser.service.js';
import { renderVariablesFile } from '../src/services/variables-writer.service.js';
import { addVar as crudAddVar, setVarValue as crudSetVarValue } from '../src/services/variables-crud.service.js';
import { extractSubSets } from '../src/services/varset.service.js';
import { VariablesViewProvider, type VariableNode } from '../src/ui/views/variablesView.provider.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';

/**
 * T16 — the nine `md-artifacts.variables.*` tree commands (VSX-219).
 *
 * The module does NOT exist yet — every test here fails on import until
 * `src/commands/variables.command.ts` is implemented (the plan's own "Test
 * first" red reason).
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

function multiBlockModel(): ArtifactFormModel {
    return {
        artifactType: 'Variables', title: 'Env Bundle', description: '', tags: [],
        blocks: [
            { heading: 'Dev', description: '', language: '', code: '', vars: [{ name: 'VK-host', defaultValue: 'localhost' }] },
            { heading: 'Prod', description: '', language: '', code: '', vars: [
                { name: 'VK-host', defaultValue: 'prod.example.com' },
                { name: 'VK-port', defaultValue: '443' },
            ] },
        ],
    };
}

function singleBlockModel(): ArtifactFormModel {
    return {
        artifactType: 'Variables', title: 'Local Dev', description: '', tags: [],
        blocks: [{ heading: '', description: '', language: '', code: '', vars: [{ name: 'VK-host', defaultValue: 'localhost' }] }],
    };
}

/** Fresh temp vault with a `Variables/` directory, as a `vscode.Uri`. */
function makeVault(): vscode.Uri {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'variables-command-test-'));
    fs.mkdirSync(path.join(dir, 'Variables'));
    return vscode.Uri.file(dir);
}

/** Writes a fixture model to `<vaultRoot>/Variables/<name>.md`; returns the absolute path. */
function writeFixture(vaultRoot: vscode.Uri, name: string, model: ArtifactFormModel): string {
    const filePath = path.join(vaultRoot.fsPath, 'Variables', `${name}.md`);
    fs.writeFileSync(filePath, renderVariablesFile(model), 'utf8');
    return filePath;
}

function readBytes(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

function fileNode(filePath: string): VariableNode {
    return { id: filePath, parentId: null, kind: 'file', label: path.basename(filePath) };
}
function subsetNode(filePath: string, subIdx: number): VariableNode {
    return { id: `${filePath}::subset:${subIdx}`, parentId: filePath, kind: 'subset', label: `sub${subIdx}` };
}
function varNode(filePath: string, subIdx: number, idx: number): VariableNode {
    const parentId = `${filePath}::subset:${subIdx}`;
    return { id: `${parentId}::var:${idx}`, parentId, kind: 'var', label: `var${idx}` };
}

/** Canned `CommandIO` — queued `showInputBox` answers, a fixed confirm result, captured errors. */
function makeIO(opts: { inputs?: (string | undefined)[]; confirmResult?: boolean } = {}): { io: CommandIO; errors: string[]; confirmCalls: string[] } {
    const inputs = [...(opts.inputs ?? [])];
    const errors: string[] = [];
    const confirmCalls: string[] = [];
    const io: CommandIO = {
        showInputBox: () => Promise.resolve(inputs.shift()),
        confirm: message => { confirmCalls.push(message); return Promise.resolve(opts.confirmResult ?? true); },
        showError: message => { errors.push(message); },
    };
    return { io, errors, confirmCalls };
}

/** Wraps a real `VariablesViewProvider`'s `refresh()` to count calls without touching its I/O. */
function spyRefresh(provider: VariablesViewProvider): () => number {
    let count = 0;
    const original = provider.refresh.bind(provider);
    provider.refresh = () => { count += 1; original(); };
    return () => count;
}

function listVariablesDir(vaultRoot: vscode.Uri): string[] {
    return fs.readdirSync(path.join(vaultRoot.fsPath, 'Variables')).sort();
}

// ── Test first ────────────────────────────────────────────────────────────

suite('buildVariableCommandIds (T16)', () => {
    test('Test first — equals the package.json mirror (id set, not a count)', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
            contributes: { commands: { command: string }[] };
        };
        const expected = pkg.contributes.commands.map(c => c.command).filter(id => id.startsWith('md-artifacts.variables.'));
        // Derivation-sourced, not a second hardcoded count: W1 (H1.1) took this
        // from 9 to 11 and a literal here would have to be edited by every wave
        // that adds a command — the `deepStrictEqual` below is what pins the set.
        assert.strictEqual(expected.length, buildVariableCommandIds().length,
            `manifest declares ${expected.length} variables.* ids, derivation yields ${buildVariableCommandIds().length}`);
        assert.deepStrictEqual([...buildVariableCommandIds()].sort(), [...expected].sort());
    });
});

// ── Node-id parsing ─────────────────────────────────────────────────────────

suite('node-id parsing', () => {
    test('file/subset/var ids round-trip', () => {
        const fp = '/vault/Variables/env.md';
        assert.strictEqual(fileNodePath(fileNode(fp)), fp);
        assert.strictEqual(fileNodePath(subsetNode(fp, 1)), fp);
        assert.strictEqual(fileNodePath(varNode(fp, 1, 0)), fp);

        assert.strictEqual(subsetIndex(fileNode(fp)), undefined);
        assert.strictEqual(subsetIndex(subsetNode(fp, 1)), 1);
        assert.strictEqual(subsetIndex(varNode(fp, 1, 0)), 1);

        assert.strictEqual(varIndex(subsetNode(fp, 1)), undefined);
        assert.strictEqual(varIndex(varNode(fp, 1, 0)), 0);
    });
});

// ── toFormModel — deep-freeze / structural-sharing contract ────────────────

suite('toFormModel — deep-freeze contract (ledger #83/#85)', () => {
    test('multi-block: a frozen model survives a mutator call; the untouched block is shared by reference', () => {
        const md = renderVariablesFile(multiBlockModel());
        const parsed = parseFromContent(md, '/vault/Variables/env.md', '/vault/Variables');
        const model = toFormModel(parsed);
        Object.freeze(model);
        Object.freeze(model.blocks);
        for (const b of model.blocks) { Object.freeze(b.vars); }

        const updated = crudAddVar(model, 'Dev', 'VK-extra', 'x');

        assert.strictEqual(updated.blocks.length, 2);
        assert.strictEqual(updated.blocks[1], model.blocks[1], 'Prod block must be shared by reference, not mutated');
    });

    test('single-block: heading matches extractSubSets\' synthesis, and a frozen model survives a mutator call', () => {
        const md = renderVariablesFile(singleBlockModel());
        const parsed = parseFromContent(md, '/vault/Variables/dev.md', '/vault/Variables');
        const model = toFormModel(parsed);
        const subSets = extractSubSets(parsed);

        assert.strictEqual(model.blocks[0].heading, subSets[0]?.heading);

        Object.freeze(model);
        Object.freeze(model.blocks);
        Object.freeze(model.blocks[0].vars);

        const updated = crudSetVarValue(model, model.blocks[0].heading, 'VK-host', 'new-value');
        assert.strictEqual(updated.blocks[0].vars[0]?.defaultValue, 'new-value');
    });
});

// ── handleNewFile ─────────────────────────────────────────────────────────

suite('handleNewFile', () => {
    test('creates a new Variables file and refreshes the tree', async () => {
        const vaultRoot = makeVault();
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['My New Set'] });

        await handleNewFile(provider, io, vaultRoot);

        const files = listVariablesDir(vaultRoot);
        assert.deepStrictEqual(files, ['my-new-set.md']);
        assert.strictEqual(refreshCount(), 1);
    });

    test('Cancel/Escape on the title prompt performs zero writes', async () => {
        const vaultRoot = makeVault();
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: [undefined] });

        await handleNewFile(provider, io, vaultRoot);

        assert.deepStrictEqual(listVariablesDir(vaultRoot), []);
        assert.strictEqual(refreshCount(), 0);
    });

    test('a name collision does not overwrite the existing file', async () => {
        const vaultRoot = makeVault();
        const existingPath = writeFixture(vaultRoot, 'my-new-set', singleBlockModel());
        const before = readBytes(existingPath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io, errors } = makeIO({ inputs: ['My New Set'] });

        await handleNewFile(provider, io, vaultRoot);

        assert.strictEqual(readBytes(existingPath), before, 'existing file must not be overwritten');
        assert.strictEqual(refreshCount(), 0);
        assert.ok(errors.length > 0);
    });
});

// ── handleNewSubSet ───────────────────────────────────────────────────────

suite('handleNewSubSet', () => {
    // Round-trip, not a byte check: an empty sub-set used to vanish on
    // re-parse (`serializeArtifact` omitted the `vks` fence for `vars: []`,
    // and `parseBlocks` requires a fence after every heading) — fixed at the
    // serializer (orchestrator row, logged exception to the forbidden-files
    // rule). A round-trip assertion pins the user-visible behaviour now that
    // it is true, rather than only pinning what bytes got written.
    test('adds a new sub-set and refreshes — it survives a re-parse', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['Staging'] });

        await handleNewSubSet(fileNode(filePath), provider, io, vaultRoot);

        const parsed = parseArtifactFile(filePath, path.join(vaultRoot.fsPath, 'Variables'));
        assert.deepStrictEqual(parsed?.blocks.map(b => b.heading), ['Dev', 'Prod', 'Staging']);
        assert.deepStrictEqual(parsed?.blocks[2]?.vars, []);
        assert.strictEqual(refreshCount(), 1);
    });

    test('no argument refuses — zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io, errors } = makeIO({ inputs: ['Staging'] });

        await handleNewSubSet(undefined, provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
        assert.ok(errors.length > 0);
    });

    test('Cancel/Escape on the heading prompt performs zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: [undefined] });

        await handleNewSubSet(fileNode(filePath), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });
});

// ── handleAddVar ──────────────────────────────────────────────────────────

suite('handleAddVar', () => {
    test('adds a variable to the targeted sub-set', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['VK-region', 'us-east'] });

        await handleAddVar(subsetNode(filePath, 0), provider, io, vaultRoot);

        const parsed = parseArtifactFile(filePath, path.join(vaultRoot.fsPath, 'Variables'));
        assert.deepStrictEqual(parsed?.blocks[0]?.vars.map(v => v.name), ['VK-host', 'VK-region']);
        assert.strictEqual(refreshCount(), 1);
    });

    test('Cancel on the name prompt performs zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: [undefined] });

        await handleAddVar(subsetNode(filePath, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('a duplicate variable name is rejected — zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io, errors } = makeIO({ inputs: ['VK-host', 'dup'] });

        await handleAddVar(subsetNode(filePath, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
        assert.ok(errors.length > 0);
    });
});

// ── handleEditValue ───────────────────────────────────────────────────────

suite('handleEditValue', () => {
    test('updates the variable\'s value and refreshes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['staging.example.com'] });

        await handleEditValue(varNode(filePath, 0, 0), provider, io, vaultRoot);

        const parsed = parseArtifactFile(filePath, path.join(vaultRoot.fsPath, 'Variables'));
        assert.strictEqual(parsed?.blocks[0]?.vars[0]?.defaultValue, 'staging.example.com');
        assert.strictEqual(refreshCount(), 1);
    });

    test('an unchanged value is a no-op — zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['localhost'] }); // same as the fixture's VK-host default

        await handleEditValue(varNode(filePath, 0, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('Cancel/Escape performs zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: [undefined] });

        await handleEditValue(varNode(filePath, 0, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });
});

// ── handleRenameVar ───────────────────────────────────────────────────────

suite('handleRenameVar', () => {
    test('renames the variable, preserving its value', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['VK-hostname'] });

        await handleRenameVar(varNode(filePath, 0, 0), provider, io, vaultRoot);

        const parsed = parseArtifactFile(filePath, path.join(vaultRoot.fsPath, 'Variables'));
        assert.deepStrictEqual(parsed?.blocks[0]?.vars[0], { name: 'VK-hostname', defaultValue: 'localhost' });
        assert.strictEqual(refreshCount(), 1);
    });

    test('an unchanged name is a no-op — zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['VK-host'] });

        await handleRenameVar(varNode(filePath, 0, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('a name collision within the sub-set is rejected — zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        // Prod sub-set (index 1) already has VK-port; rename VK-host -> VK-port collides.
        const { io, errors } = makeIO({ inputs: ['VK-port'] });

        await handleRenameVar(varNode(filePath, 1, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
        assert.ok(errors.length > 0);
    });
});

// ── handleRenameSubSet ────────────────────────────────────────────────────

suite('handleRenameSubSet', () => {
    test('renames the sub-set heading', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['Staging'] });

        await handleRenameSubSet(subsetNode(filePath, 0), provider, io, vaultRoot);

        const parsed = parseArtifactFile(filePath, path.join(vaultRoot.fsPath, 'Variables'));
        assert.strictEqual(parsed?.blocks[0]?.heading, 'Staging');
        assert.strictEqual(refreshCount(), 1);
    });

    test('an unchanged heading is a no-op — zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ inputs: ['Dev'] });

        await handleRenameSubSet(subsetNode(filePath, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });
});

// ── handleDeleteVar — destructive ────────────────────────────────────────

suite('handleDeleteVar', () => {
    test('deletes the target variable; the sibling variable and sub-set survive untouched', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: true });

        // Prod sub-set: delete VK-port (index 1), VK-host (index 0) must survive.
        await handleDeleteVar(varNode(filePath, 1, 1), provider, io, vaultRoot);

        const parsed = parseArtifactFile(filePath, path.join(vaultRoot.fsPath, 'Variables'));
        assert.deepStrictEqual(parsed?.blocks[0]?.vars, [{ name: 'VK-host', defaultValue: 'localhost' }], 'Dev sub-set untouched');
        assert.deepStrictEqual(parsed?.blocks[1]?.vars, [{ name: 'VK-host', defaultValue: 'prod.example.com' }], 'Prod keeps VK-host, loses VK-port');
        assert.strictEqual(refreshCount(), 1);
    });

    // The silently-destructive path the round-2 review flagged: deleting a
    // sub-set's *only* var (not the sub-set itself) used to strand the
    // heading — the next write dropped the now-`vars: []` block on re-parse.
    // Fixed at the serializer alongside the New-Sub-Set case above; asserted
    // here as a round-trip, the same way.
    test('deleting a sub-set\'s last variable leaves the sub-set surviving, empty', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: true });

        // Dev sub-set has exactly one var (VK-host) — delete it.
        await handleDeleteVar(varNode(filePath, 0, 0), provider, io, vaultRoot);

        const parsed = parseArtifactFile(filePath, path.join(vaultRoot.fsPath, 'Variables'));
        assert.deepStrictEqual(parsed?.blocks.map(b => b.heading), ['Dev', 'Prod'], 'Dev heading survives, not stranded');
        assert.deepStrictEqual(parsed?.blocks[0]?.vars, [], 'Dev sub-set is now empty');
        assert.deepStrictEqual(parsed?.blocks[1]?.vars, multiBlockModel().blocks[1]?.vars, 'Prod sub-set untouched');
        assert.strictEqual(refreshCount(), 1);
    });

    test('declining the confirmation (Cancel) performs zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        // `showWarningMessage({modal:true}, 'Delete')` resolves undefined on Cancel — CommandIO.confirm -> false.
        const { io } = makeIO({ confirmResult: false });

        await handleDeleteVar(varNode(filePath, 1, 1), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('declining the confirmation (Escape) performs zero writes', async () => {
        // Same API-level return value as Cancel (`showWarningMessage` resolves
        // undefined for both — CLAUDE.md's standing gotcha) — asserted as its
        // own case per the plan's requirement, not merged with the Cancel test.
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: false });

        await handleDeleteVar(varNode(filePath, 1, 1), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('no argument refuses — zero writes, no delete, a message shown', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io, errors, confirmCalls } = makeIO({ confirmResult: true });

        await handleDeleteVar(undefined, provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
        assert.strictEqual(confirmCalls.length, 0, 'must refuse before ever asking for confirmation');
        assert.ok(errors.length > 0);
    });
});

// ── handleDeleteSubSet — destructive ─────────────────────────────────────

suite('handleDeleteSubSet', () => {
    // Three sub-sets, not two: deleting one of *two* collapses the file to
    // single-block shape (`serializeArtifact` only emits `## ` headings for
    // `blocks.length > 1`), moving the survivor's vars to the top-level
    // `parsed.vars` instead of `parsed.blocks[0]` — real, documented
    // behaviour (`CLAUDE.md`: "multiBlock is derived"), but it would make
    // this test about that collapse instead of about the sibling surviving.
    // Three sub-sets keeps the file multi-block after the delete, so the
    // untouched sibling is asserted the direct way.
    test('deletes the target sub-set; an untouched sibling sub-set survives unchanged', async () => {
        const vaultRoot = makeVault();
        const threeSubSets: ArtifactFormModel = {
            artifactType: 'Variables', title: 'Env Bundle', description: '', tags: [],
            blocks: [
                ...multiBlockModel().blocks,
                { heading: 'Staging', description: '', language: '', code: '', vars: [{ name: 'VK-host', defaultValue: 'staging.example.com' }] },
            ],
        };
        const filePath = writeFixture(vaultRoot, 'env', threeSubSets);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: true });

        await handleDeleteSubSet(subsetNode(filePath, 0), provider, io, vaultRoot); // delete 'Dev'

        const parsed = parseArtifactFile(filePath, path.join(vaultRoot.fsPath, 'Variables'));
        assert.strictEqual(parsed?.blocks.length, 2);
        assert.deepStrictEqual(parsed?.blocks.map(b => b.heading), ['Prod', 'Staging']);
        assert.deepStrictEqual(parsed?.blocks[0]?.vars, threeSubSets.blocks[1]?.vars, 'Prod sub-set untouched');
        assert.deepStrictEqual(parsed?.blocks[1]?.vars, threeSubSets.blocks[2]?.vars, 'Staging sub-set untouched');
        assert.strictEqual(refreshCount(), 1);
    });

    test('refuses to delete a file\'s last remaining sub-set — zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'dev', singleBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io, errors } = makeIO({ confirmResult: true });

        await handleDeleteSubSet(subsetNode(filePath, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
        assert.ok(errors.length > 0);
    });

    test('declining the confirmation (Cancel) performs zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: false });

        await handleDeleteSubSet(subsetNode(filePath, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('declining the confirmation (Escape) performs zero writes', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: false });

        await handleDeleteSubSet(subsetNode(filePath, 0), provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('no argument refuses — zero writes, no delete, a message shown', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'env', multiBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io, errors, confirmCalls } = makeIO({ confirmResult: true });

        await handleDeleteSubSet(undefined, provider, io, vaultRoot);

        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
        assert.strictEqual(confirmCalls.length, 0);
        assert.ok(errors.length > 0);
    });
});

// ── handleDeleteFile — destructive ───────────────────────────────────────

suite('handleDeleteFile', () => {
    test('deletes the target file; the sibling file survives — exactly one path changed', async () => {
        const vaultRoot = makeVault();
        const targetPath = writeFixture(vaultRoot, 'dev', singleBlockModel());
        const siblingPath = writeFixture(vaultRoot, 'prod', multiBlockModel());
        const siblingBefore = readBytes(siblingPath);
        const before = listVariablesDir(vaultRoot);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: true });

        await handleDeleteFile(fileNode(targetPath), provider, io, vaultRoot);

        const after = listVariablesDir(vaultRoot);
        const removed = before.filter(f => !after.includes(f));
        const added = after.filter(f => !before.includes(f));
        assert.deepStrictEqual(removed, ['dev.md']);
        assert.deepStrictEqual(added, []);
        assert.strictEqual(readBytes(siblingPath), siblingBefore, 'sibling file bytes unchanged');
        assert.strictEqual(refreshCount(), 1);
    });

    test('declining the confirmation (Cancel) performs zero deletion', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'dev', singleBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: false });

        await handleDeleteFile(fileNode(filePath), provider, io, vaultRoot);

        assert.ok(fs.existsSync(filePath));
        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('declining the confirmation (Escape) performs zero deletion', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'dev', singleBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io } = makeIO({ confirmResult: false });

        await handleDeleteFile(fileNode(filePath), provider, io, vaultRoot);

        assert.ok(fs.existsSync(filePath));
        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
    });

    test('no argument refuses — zero deletion, no delete, a message shown', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'dev', singleBlockModel());
        const before = readBytes(filePath);
        const provider = new VariablesViewProvider();
        const refreshCount = spyRefresh(provider);
        const { io, errors, confirmCalls } = makeIO({ confirmResult: true });

        await handleDeleteFile(undefined, provider, io, vaultRoot);

        assert.ok(fs.existsSync(filePath));
        assert.strictEqual(readBytes(filePath), before);
        assert.strictEqual(refreshCount(), 0);
        assert.strictEqual(confirmCalls.length, 0);
        assert.ok(errors.length > 0);
    });
});
