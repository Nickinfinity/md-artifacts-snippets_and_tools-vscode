import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { handleAddVar, handleNewSubSet } from '../src/commands/variables.command.js';
import { handleAddToBlank } from '../src/commands/variables-add-blank.command.js';
import type { CommandIO } from '../src/commands/variables.command.helpers.js';
import { addSubSet, uniqueDefaultName, DEFAULT_SUBSET_NAME } from '../src/services/variables-crud.service.js';
import { getVarsFileShape } from '../src/services/varset.service.js';
import { parseArtifactFile } from '../src/services/parser.service.js';
import { VariablesViewProvider, buildVariableNodes, type VariableNode } from '../src/ui/views/variablesView.provider.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';
import { startVarsEngine, VAULT, type VarsEngine } from './vars-engine.js';

/**
 * The three Variables file shapes — blank, flat (one untitled block), sets
 * (one or more titled sub-sets) — and every move between them that the pane
 * can make. One row of the design table per test: starting file → action →
 * expected file on disk + expected pane rows.
 */

const HEADER = '---\nartifactType: Variables\ntitle: Local Dev\n---\n';
const FLAT   = `${HEADER}\n\`\`\`vks\nVK-host=localhost\n\`\`\`\n`;
const TITLED = `${HEADER}\n## Dev\n\n\`\`\`vks\nVK-host=localhost\n\`\`\`\n`;

function vaultWith(content: string): { root: vscode.Uri; file: string; dir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vars-shapes-'));
    const dir = path.join(root, 'Variables');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'local.md');
    fs.writeFileSync(file, content, 'utf8');
    return { root: vscode.Uri.file(root), file, dir };
}

/** Canned IO: queued input-box answers, a fixed quick-pick index, captured errors. */
function io(inputs: (string | undefined)[], pick?: number): { io: CommandIO; errors: string[] } {
    const errors: string[] = [];
    return {
        errors,
        io: {
            showInputBox: () => Promise.resolve(inputs.shift()),
            confirm: () => Promise.resolve(true),
            showError: m => { errors.push(m); },
            showQuickPick: items => Promise.resolve(pick === undefined ? undefined : items[pick]),
        },
    };
}

function rows(file: string, dir: string): [string, string][] {
    const parsed = parseArtifactFile(file, dir)!;
    return buildVariableNodes([parsed]).map(n => [n.kind, n.label]);
}

function fileNode(file: string, shape: VariableNode['shape']): VariableNode {
    return { id: file, parentId: null, kind: 'file', label: 'Local Dev', shape };
}

suite('Variables file shapes — classification and pane rows', () => {
    test('blank: header only → just the file row', () => {
        const { file, dir } = vaultWith(HEADER);
        assert.strictEqual(getVarsFileShape(parseArtifactFile(file, dir)!), 'blank');
        assert.deepStrictEqual(rows(file, dir), [['file', 'Local Dev']]);
    });

    test('flat: one untitled block → variables straight under the file', () => {
        const { file, dir } = vaultWith(FLAT);
        assert.strictEqual(getVarsFileShape(parseArtifactFile(file, dir)!), 'flat');
        assert.deepStrictEqual(rows(file, dir), [['file', 'Local Dev'], ['var', 'VK-host = localhost']]);
    });

    test('sets: a single TITLED sub-set is still listed as a sub-set', () => {
        const { file, dir } = vaultWith(TITLED);
        assert.strictEqual(getVarsFileShape(parseArtifactFile(file, dir)!), 'sets');
        assert.deepStrictEqual(rows(file, dir), [['file', 'Local Dev'], ['subset', 'Dev'], ['var', 'VK-host = localhost']]);
    });
});

suite('Variables file shapes — transitions from the pane (requests; the shape change itself is the engine\'s)', () => {
    let eng: VarsEngine;
    setup(() => { eng = startVarsEngine(); });
    teardown(() => eng.dispose());
    const sent = (m: string): unknown[] => eng.calls(m).map(c => c.params);

    test('blank → flat: Add… → Variable sends vars.var.add with no subset', async () => {
        const file = eng.serve('Variables/local.md', HEADER);
        const { io: bag, errors } = io(['host', 'localhost'], 0);
        await handleAddToBlank(fileNode(file, 'blank'), new VariablesViewProvider(), bag, VAULT);
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(sent('vars.var.add'), [{ path: 'Variables/local.md', expectedHash: eng.hashOf(HEADER), name: 'VK-host', value: 'localhost' }]);
    });

    test('blank → sets: Add… → Sub-set sends vars.subset.add, name pre-filled with the set title', async () => {
        const file = eng.serve('Variables/local.md', HEADER);
        const { io: bag, errors } = io(['Local Dev'], 1);
        await handleAddToBlank(fileNode(file, 'blank'), new VariablesViewProvider(), bag, VAULT);
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(sent('vars.subset.add'), [{ path: 'Variables/local.md', expectedHash: eng.hashOf(HEADER), heading: 'Local Dev' }]);
    });

    test('blank: cancelling the Add… pick sends nothing', async () => {
        const file = eng.serve('Variables/local.md', HEADER);
        await handleAddToBlank(fileNode(file, 'blank'), new VariablesViewProvider(), io([]).io, VAULT);
        assert.strictEqual(eng.fake.received.filter(r => r.method.startsWith('vars.')).length, 0);
    });

    test('flat stays flat: adding a variable from the file row sends no subset (the engine writes no heading)', async () => {
        const file = eng.serve('Variables/local.md', FLAT);
        await handleAddVar(fileNode(file, 'flat'), new VariablesViewProvider(), io(['port', '80']).io, VAULT);
        assert.deepStrictEqual(sent('vars.var.add'), [{ path: 'Variables/local.md', expectedHash: eng.hashOf(FLAT), name: 'VK-port', value: '80' }]);
    });

    test('flat → sets: New sub-set sends only the heading; the engine names the untitled block "Default" (vars.subset.add/flat_default)', async () => {
        const file = eng.serve('Variables/local.md', FLAT);
        await handleNewSubSet(fileNode(file, 'flat'), new VariablesViewProvider(), io(['Prod']).io, VAULT);
        assert.deepStrictEqual(sent('vars.subset.add'), [{ path: 'Variables/local.md', expectedHash: eng.hashOf(FLAT), heading: 'Prod' }]);
    });
});

suite('Variables file shapes — the naming rule (addSubSet)', () => {
    const model = (blocks: { heading: string; vars?: { name: string; defaultValue: string }[] }[]): ArtifactFormModel => ({
        artifactType: 'Variables', title: 'T', description: '', tags: [],
        blocks: blocks.map(b => ({ heading: b.heading, description: '', language: '', code: '', vars: b.vars ?? [] })),
    });

    test('an untitled sole block is named Default; a new "Default" pushes it to "Default 2"', () => {
        assert.deepStrictEqual(addSubSet(model([{ heading: '' }]), 'Prod').blocks.map(b => b.heading), ['Default', 'Prod']);
        assert.deepStrictEqual(addSubSet(model([{ heading: '' }]), 'Default').blocks.map(b => b.heading), ['Default 2', 'Default']);
    });

    test('a titled sole block and a blank model are left alone', () => {
        assert.deepStrictEqual(addSubSet(model([{ heading: 'Dev' }]), 'Prod').blocks.map(b => b.heading), ['Dev', 'Prod']);
        assert.deepStrictEqual(addSubSet(model([]), 'Prod').blocks.map(b => b.heading), ['Prod']);
    });

    test('uniqueDefaultName skips taken numbers', () => {
        assert.strictEqual(uniqueDefaultName(['Default', 'Default 2']), 'Default 3');
    });
});
