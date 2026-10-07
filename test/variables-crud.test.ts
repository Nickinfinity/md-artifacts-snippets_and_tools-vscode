import * as assert from 'node:assert';
import type { ArtifactFormModel, ArtifactFormBlock } from '../src/types/artifact-form.types.js';
import {
    addVar,
    renameVar,
    setVarValue,
    deleteVar,
    addSubSet,
    renameSubSet,
    deleteSubSet,
} from '../src/services/variables-crud.service.js';

/**
 * Unit tests for the pure Variables mutation service (T14, VSX-217).
 *
 * Every mutator takes and returns an `ArtifactFormModel` (never
 * `ParsedArtifactFile`) and must not mutate its input — this file proves both
 * the happy paths and the immutability contract for each of the seven
 * mutators: addVar / renameVar / setVarValue / deleteVar / addSubSet /
 * renameSubSet / deleteSubSet.
 *
 * The module does NOT exist yet — every test here fails on import until
 * src/services/variables-crud.service.ts is implemented.
 */

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Builds an `ArtifactFormBlock` sub-set fixture.
 *
 * @param heading - Sub-set heading.
 * @param vars    - `[name, defaultValue][]` pairs for the sub-set's vars.
 * @returns A populated `ArtifactFormBlock`.
 *
 * @example
 * mkBlock('Development', [['VK-host', 'localhost']])
 */
function mkBlock(heading: string, vars: [string, string][]): ArtifactFormBlock {
    return {
        heading,
        description: '',
        language: '',
        code: '',
        vars: vars.map(([name, defaultValue]) => ({ name, defaultValue })),
    };
}

/**
 * Builds a fixture `ArtifactFormModel` wrapping the given sub-set blocks.
 *
 * @param blocks - Sub-set blocks (one or more).
 * @returns A minimal `artifactType: 'Variables'` model.
 *
 * @example
 * mkModel([mkBlock('sub', [['VK-host', 'v']])])
 */
function mkModel(blocks: ArtifactFormBlock[]): ArtifactFormModel {
    return {
        artifactType: 'Variables',
        title: 'Fixture',
        description: '',
        tags: [],
        blocks,
    };
}

/**
 * Deep, function-free snapshot of a model for before/after immutability
 * comparison — plain data only, so JSON round-trip is a safe deep clone.
 *
 * @param model - Model to snapshot.
 * @returns A structurally-independent copy.
 *
 * @example
 * const before = snapshot(model);
 */
function snapshot(model: ArtifactFormModel): ArtifactFormModel {
    return JSON.parse(JSON.stringify(model)) as ArtifactFormModel;
}

// ── Test suite ──────────────────────────────────────────────────────────────

suite('variables-crud.service', () => {

    // ── addVar ──────────────────────────────────────────────────────────────

    suite('addVar', () => {

        test('name without the VK- prefix is rejected', () => {
            const model = mkModel([mkBlock('sub', [])]);
            assert.throws(() => addVar(model, 'sub', 'nope', 'v'));
        });

        test('name with an invalid hint (empty, digit-first) is rejected', () => {
            const model = mkModel([mkBlock('sub', [])]);
            assert.throws(() => addVar(model, 'sub', 'VK-', 'v'));
            assert.throws(() => addVar(model, 'sub', 'VK-1abc', 'v'));
        });

        test('adds a var to the named sub-set and returns a new model', () => {
            const model = mkModel([mkBlock('sub', [])]);
            const result = addVar(model, 'sub', 'VK-host', 'localhost');
            assert.deepStrictEqual(result.blocks[0].vars, [{ name: 'VK-host', defaultValue: 'localhost' }]);
            assert.notStrictEqual(result, model);
        });

        test('rejects a duplicate name within the same sub-set', () => {
            const model = mkModel([mkBlock('sub', [['VK-host', 'a']])]);
            assert.throws(() => addVar(model, 'sub', 'VK-host', 'b'));
        });

        test('same name in a different sub-set is not a duplicate', () => {
            const model = mkModel([mkBlock('a', [['VK-host', 'x']]), mkBlock('b', [])]);
            const result = addVar(model, 'b', 'VK-host', 'y');
            assert.deepStrictEqual(result.blocks[1].vars, [{ name: 'VK-host', defaultValue: 'y' }]);
        });

        test('unknown sub-set heading throws', () => {
            const model = mkModel([mkBlock('sub', [])]);
            assert.throws(() => addVar(model, 'missing', 'VK-host', 'v'));
        });

        test('does not mutate the input model or its nested vars array', () => {
            const model = mkModel([mkBlock('sub', [['VK-existing', 'v']])]);
            const before = snapshot(model);
            const originalVarsArray = model.blocks[0].vars;
            addVar(model, 'sub', 'VK-host', 'localhost');
            assert.deepStrictEqual(model, before);
            assert.strictEqual(model.blocks[0].vars, originalVarsArray);
            assert.strictEqual(originalVarsArray.length, 1);
        });

        test('rejection path also leaves the model untouched', () => {
            const model = mkModel([mkBlock('sub', [['VK-host', 'a']])]);
            const before = snapshot(model);
            assert.throws(() => addVar(model, 'sub', 'VK-host', 'b'));
            assert.deepStrictEqual(model, before);
        });
    });

    // ── renameVar ───────────────────────────────────────────────────────────

    suite('renameVar', () => {

        test('renames a var, preserving its value', () => {
            const model = mkModel([mkBlock('sub', [['VK-host', 'localhost']])]);
            const result = renameVar(model, 'sub', 'VK-host', 'VK-hostname');
            assert.deepStrictEqual(result.blocks[0].vars, [{ name: 'VK-hostname', defaultValue: 'localhost' }]);
        });

        test('rejects an invalid new name', () => {
            const model = mkModel([mkBlock('sub', [['VK-host', 'v']])]);
            assert.throws(() => renameVar(model, 'sub', 'VK-host', 'nope'));
        });

        test('rejects renaming onto an existing name in the same sub-set', () => {
            const model = mkModel([mkBlock('sub', [['VK-a', '1'], ['VK-b', '2']])]);
            assert.throws(() => renameVar(model, 'sub', 'VK-a', 'VK-b'));
        });

        test('throws when the var to rename is not found', () => {
            const model = mkModel([mkBlock('sub', [])]);
            assert.throws(() => renameVar(model, 'sub', 'VK-missing', 'VK-other'));
        });

        test('does not mutate the input model or its nested vars array', () => {
            const model = mkModel([mkBlock('sub', [['VK-host', 'localhost']])]);
            const before = snapshot(model);
            const originalVarsArray = model.blocks[0].vars;
            renameVar(model, 'sub', 'VK-host', 'VK-hostname');
            assert.deepStrictEqual(model, before);
            assert.strictEqual(model.blocks[0].vars, originalVarsArray);
        });
    });

    // ── setVarValue ─────────────────────────────────────────────────────────

    suite('setVarValue', () => {

        test('updates the value, leaving the name unchanged', () => {
            const model = mkModel([mkBlock('sub', [['VK-host', 'old']])]);
            const result = setVarValue(model, 'sub', 'VK-host', 'new');
            assert.deepStrictEqual(result.blocks[0].vars, [{ name: 'VK-host', defaultValue: 'new' }]);
        });

        test('throws when the var is not found', () => {
            const model = mkModel([mkBlock('sub', [])]);
            assert.throws(() => setVarValue(model, 'sub', 'VK-missing', 'v'));
        });

        test('does not mutate the input model or its nested vars array', () => {
            const model = mkModel([mkBlock('sub', [['VK-host', 'old']])]);
            const before = snapshot(model);
            const originalVarsArray = model.blocks[0].vars;
            setVarValue(model, 'sub', 'VK-host', 'new');
            assert.deepStrictEqual(model, before);
            assert.strictEqual(model.blocks[0].vars, originalVarsArray);
        });
    });

    // ── deleteVar ───────────────────────────────────────────────────────────

    suite('deleteVar', () => {

        test('removes the var from the sub-set', () => {
            const model = mkModel([mkBlock('sub', [['VK-a', '1'], ['VK-b', '2']])]);
            const result = deleteVar(model, 'sub', 'VK-a');
            assert.deepStrictEqual(result.blocks[0].vars, [{ name: 'VK-b', defaultValue: '2' }]);
        });

        test('throws when the var is not found', () => {
            const model = mkModel([mkBlock('sub', [])]);
            assert.throws(() => deleteVar(model, 'sub', 'VK-missing'));
        });

        test('does not mutate the input model or its nested vars array', () => {
            const model = mkModel([mkBlock('sub', [['VK-a', '1'], ['VK-b', '2']])]);
            const before = snapshot(model);
            const originalVarsArray = model.blocks[0].vars;
            deleteVar(model, 'sub', 'VK-a');
            assert.deepStrictEqual(model, before);
            assert.strictEqual(model.blocks[0].vars, originalVarsArray);
            assert.strictEqual(originalVarsArray.length, 2);
        });
    });

    // ── addSubSet ───────────────────────────────────────────────────────────

    suite('addSubSet', () => {

        test('appends a new, empty sub-set', () => {
            const model = mkModel([mkBlock('a', [])]);
            const result = addSubSet(model, 'b');
            assert.strictEqual(result.blocks.length, 2);
            assert.deepStrictEqual(result.blocks[1], { heading: 'b', description: '', language: '', code: '', vars: [] });
        });

        test('rejects an empty or whitespace-only heading', () => {
            const model = mkModel([mkBlock('a', [])]);
            assert.throws(() => addSubSet(model, ''));
            assert.throws(() => addSubSet(model, '   '));
        });

        test('rejects a duplicate heading', () => {
            const model = mkModel([mkBlock('a', [])]);
            assert.throws(() => addSubSet(model, 'a'));
        });

        test('does not mutate the input model', () => {
            const model = mkModel([mkBlock('a', [])]);
            const before = snapshot(model);
            const originalBlocksArray = model.blocks;
            addSubSet(model, 'b');
            assert.deepStrictEqual(model, before);
            assert.strictEqual(model.blocks, originalBlocksArray);
            assert.strictEqual(originalBlocksArray.length, 1);
        });
    });

    // ── renameSubSet ────────────────────────────────────────────────────────

    suite('renameSubSet', () => {

        test('renames the sub-set heading', () => {
            const model = mkModel([mkBlock('a', [['VK-x', '1']])]);
            const result = renameSubSet(model, 'a', 'b');
            assert.strictEqual(result.blocks[0].heading, 'b');
            assert.deepStrictEqual(result.blocks[0].vars, [{ name: 'VK-x', defaultValue: '1' }]);
        });

        test('rejects renaming onto an existing heading', () => {
            const model = mkModel([mkBlock('a', []), mkBlock('b', [])]);
            assert.throws(() => renameSubSet(model, 'a', 'b'));
        });

        test('rejects an empty new heading', () => {
            const model = mkModel([mkBlock('a', [])]);
            assert.throws(() => renameSubSet(model, 'a', ''));
        });

        test('throws when the old heading is not found', () => {
            const model = mkModel([mkBlock('a', [])]);
            assert.throws(() => renameSubSet(model, 'missing', 'b'));
        });

        test('does not mutate the input model', () => {
            const model = mkModel([mkBlock('a', [])]);
            const before = snapshot(model);
            renameSubSet(model, 'a', 'b');
            assert.deepStrictEqual(model, before);
        });
    });

    // ── deleteSubSet ────────────────────────────────────────────────────────

    suite('deleteSubSet', () => {

        test('removes the sub-set when more than one exists', () => {
            const model = mkModel([mkBlock('a', []), mkBlock('b', [])]);
            const result = deleteSubSet(model, 'b');
            assert.strictEqual(result.blocks.length, 1);
            assert.strictEqual(result.blocks[0].heading, 'a');
        });

        test('deletes the last remaining sub-set, leaving none', () => {
            const model = mkModel([mkBlock('only', [['VK-x', '1']])]);
            assert.deepStrictEqual(deleteSubSet(model, 'only').blocks, []);
        });

        test('throws when the heading is not found', () => {
            const model = mkModel([mkBlock('a', []), mkBlock('b', [])]);
            assert.throws(() => deleteSubSet(model, 'missing'));
        });

        test('does not mutate the input model', () => {
            const model = mkModel([mkBlock('a', []), mkBlock('b', [])]);
            const before = snapshot(model);
            const originalBlocksArray = model.blocks;
            deleteSubSet(model, 'b');
            assert.deepStrictEqual(model, before);
            assert.strictEqual(model.blocks, originalBlocksArray);
        });

        test('rejection path (unknown heading) leaves the model untouched', () => {
            const model = mkModel([mkBlock('only', [['VK-x', '1']])]);
            const before = snapshot(model);
            assert.throws(() => deleteSubSet(model, 'missing'));
            assert.deepStrictEqual(model, before);
        });
    });
});
