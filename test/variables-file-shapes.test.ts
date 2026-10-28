import * as assert from 'node:assert';
import { handleAddVar, handleNewSubSet } from '../src/commands/variables.command.js';
import { handleAddToBlank } from '../src/commands/variables-add-blank.command.js';
import type { CommandIO } from '../src/commands/variables.command.helpers.js';
import { getVarsFileShape } from '../src/services/varset.service.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { VariablesViewProvider, buildVariableNodes, type VariableNode } from '../src/ui/views/variablesView.provider.js';
import { startVarsEngine, recordedSource, VAULT, type VarsEngine } from './vars-engine.js';
import { recordedRead } from './recorded.js';

/**
 * The three Variables file shapes — blank, flat (one untitled block), sets
 * (one or more titled sub-sets) — and every move between them that the pane
 * can make. One row of the design table per test: starting file → action →
 * expected file on disk + expected pane rows.
 */

const HEADER = recordedSource('vars-blank-localdev');
const FLAT = recordedSource('vars-flat');

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

/** The pane rows for a recorded engine read — the shape the engine reported, adapted at the one edge. */
function rows(name: string): [string, string][] {
    return buildVariableNodes([toParsedArtifactFile(recordedRead(name), VAULT.fsPath)]).map(n => [n.kind, n.label]);
}
const shapeOf = (name: string): string => getVarsFileShape(toParsedArtifactFile(recordedRead(name), VAULT.fsPath));

function fileNode(file: string, shape: VariableNode['shape']): VariableNode {
    return { id: file, parentId: null, kind: 'file', label: 'Local Dev', shape };
}

suite('Variables file shapes — classification and pane rows (recorded engine reads)', () => {
    test('blank: header only → just the file row', () => {
        assert.strictEqual(shapeOf('vars-blank-localdev'), 'blank');
        assert.deepStrictEqual(rows('vars-blank-localdev'), [['file', 'Local Dev']]);
    });

    test('flat: one untitled block → variables straight under the file', () => {
        assert.strictEqual(shapeOf('vars-flat'), 'flat');
        assert.deepStrictEqual(rows('vars-flat'), [['file', 'Local Dev'], ['var', 'VK-host = localhost']]);
    });

    test('sets: a single TITLED sub-set is still listed as a sub-set', () => {
        assert.strictEqual(shapeOf('vars-titled-dev'), 'sets');
        assert.deepStrictEqual(rows('vars-titled-dev'), [['file', 'Local Dev'], ['subset', 'Dev'], ['var', 'VK-host = localhost']]);
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
