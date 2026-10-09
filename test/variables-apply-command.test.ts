import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { handleApplyToPreview, handleSaveCurrentValues, type ApplyDeps } from '../src/commands/variables-apply.command.js';
import { setPreviewTarget, type PreviewVarTarget } from '../src/services/preview-target.service.js';
import { renderVariablesFile } from '../src/services/variables-writer.service.js';
import { resolveTarget, type CommandIO } from '../src/commands/variables.command.helpers.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';
import type { VariableNode } from '../src/ui/views/variablesView.provider.js';

/**
 * T1.3 — Variables-pane commands that reach a live preview (VSX-246).
 *
 * The module does NOT exist yet — every test here fails on import until
 * `src/commands/variables-apply.command.ts` is implemented.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

function singleBlockModel(): ArtifactFormModel {
    return {
        artifactType: 'Variables', title: 'Local Dev', description: '', tags: [],
        blocks: [{ heading: '', description: '', language: '', code: '', vars: [{ name: 'VK-host', defaultValue: 'localhost' }] }],
    };
}

/** Fresh temp vault with a `Variables/` directory, as a `vscode.Uri`. */
function makeVault(): vscode.Uri {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'variables-apply-command-test-'));
    fs.mkdirSync(path.join(dir, 'Variables'));
    return vscode.Uri.file(dir);
}

/** Writes a fixture model to `<vaultRoot>/Variables/<name>.md`; returns the absolute path. */
function writeFixture(vaultRoot: vscode.Uri, name: string, model: ArtifactFormModel): string {
    const filePath = path.join(vaultRoot.fsPath, 'Variables', `${name}.md`);
    fs.writeFileSync(filePath, renderVariablesFile(model), 'utf8');
    return filePath;
}

function subsetNode(filePath: string, subIdx: number): VariableNode {
    return { id: `${filePath}::subset:${subIdx}`, parentId: filePath, kind: 'subset', label: `sub${subIdx}` };
}

/** Fake `PreviewVarTarget` that records every `applyVarSet` call. */
function fakeTarget(): PreviewVarTarget & { applied: [string, readonly { name: string; defaultValue: string }[]][] } {
    const applied: [string, readonly { name: string; defaultValue: string }[]][] = [];
    return {
        applied,
        applyVarSet: (subSetName, vars) => { applied.push([subSetName, vars]); },
        currentValues: () => ({ 'VK-host': 'typed-value' }),
        saveAsSet: async () => { /* not exercised directly — recorded via a spy in its own test */ },
    };
}

/** Builds an `ApplyDeps` bag with a fake `CommandIO` and a captured info channel. */
function makeDeps(vaultRoot: vscode.Uri | undefined): { deps: ApplyDeps; info: string[]; errors: string[] } {
    const info: string[] = [];
    const errors: string[] = [];
    const deps: ApplyDeps = {
        vaultRoot,
        io: {
            showInputBox: () => Promise.resolve(undefined),
            confirm: () => Promise.resolve(true),
            showQuickPick: () => Promise.resolve(undefined),
            showError: message => { errors.push(message); },
        },
        notifyInfo: message => { info.push(message); },
    };
    return { deps, info, errors };
}

// ── O-2: no preview open ─────────────────────────────────────────────────────

suite('handleApplyToPreview / handleSaveCurrentValues — no preview open (O-2)', () => {
    test('handleApplyToPreview: no preview open — must not throw, must not apply, must tell the user', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'dev', singleBlockModel());
        const { deps, info, errors } = makeDeps(vaultRoot);

        await handleApplyToPreview(subsetNode(filePath, 0), deps);

        assert.strictEqual(info.length, 1, 'no preview open, and the user was told nothing');
        assert.strictEqual(errors.length, 0, 'no preview open is not an error');
    });

    test('handleSaveCurrentValues: no preview open — same refusal path, invokable with no node', async () => {
        const vaultRoot = makeVault();
        const { deps, info, errors } = makeDeps(vaultRoot);

        await handleSaveCurrentValues(deps);

        assert.strictEqual(info.length, 1, 'no preview open, and the user was told nothing');
        assert.strictEqual(errors.length, 0, 'no preview open is not an error');
    });
});

// ── Apply to preview ─────────────────────────────────────────────────────────

suite('handleApplyToPreview — a live preview receives the sub-set', () => {
    test('applies the clicked sub-set to the live preview target', async () => {
        const vaultRoot = makeVault();
        const filePath = writeFixture(vaultRoot, 'dev', singleBlockModel());
        const { deps } = makeDeps(vaultRoot);
        const target = fakeTarget();
        const release = setPreviewTarget(target);

        try {
            await handleApplyToPreview(subsetNode(filePath, 0), deps);
            assert.deepStrictEqual(target.applied, [
                ['Local Dev', [{ name: 'VK-host', defaultValue: 'localhost' }]],
            ]);
        } finally {
            release();
        }
    });
});

// ── Save current values ──────────────────────────────────────────────────────

suite('handleSaveCurrentValues — reaches the save-as-set flow with the target\'s values', () => {
    test('a live target\'s currentValues() reach saveAsSet', async () => {
        const vaultRoot = makeVault();
        const { deps } = makeDeps(vaultRoot);
        const saved: Record<string, string>[] = [];
        const target: PreviewVarTarget = {
            applyVarSet: () => { /* not exercised here */ },
            currentValues: () => ({ 'VK-host': 'typed-value' }),
            saveAsSet: async values => { saved.push(values); },
        };
        const release = setPreviewTarget(target);

        try {
            await handleSaveCurrentValues(deps);
            assert.deepStrictEqual(saved, [{ 'VK-host': 'typed-value' }]);
        } finally {
            release();
        }
    });
});

// ── D-7: containment guard inside resolveTarget ──────────────────────────────

suite('resolveTarget — D-7 containment guard (hostile fixture)', () => {
    test('a valid, parseable Variables file written OUTSIDE Variables/ is refused before reaching the preview', async () => {
        const vaultRoot = makeVault();
        // Written under the vault root but NOT under Variables/ — the fixture
        // must be a genuinely parseable `artifactType: Variables` file, or the
        // refusal could be coming from parseArtifactFile returning undefined
        // instead of the containment guard. Built through the production
        // emitter (renderVariablesFile), never a hand-typed string.
        const outsideDir = path.join(vaultRoot.fsPath, 'NotVariables');
        fs.mkdirSync(outsideDir);
        const outsidePath = path.join(outsideDir, 'outside.md');
        fs.writeFileSync(outsidePath, renderVariablesFile(singleBlockModel()), 'utf8');

        const { deps } = makeDeps(vaultRoot);
        const target = fakeTarget();
        const release = setPreviewTarget(target);

        try {
            await handleApplyToPreview(subsetNode(outsidePath, 0), deps);
            assert.strictEqual(target.applied.length, 0, 'a file outside Variables/ reached the preview');
        } finally {
            release();
        }
    });

    test('sink assertion — resolveTarget itself refuses the outside-root path (used to prove the guard is not decoration)', async () => {
        const vaultRoot = makeVault();
        const outsideDir = path.join(vaultRoot.fsPath, 'NotVariables');
        fs.mkdirSync(outsideDir, { recursive: true });
        const outsidePath = path.join(outsideDir, 'outside.md');
        fs.writeFileSync(outsidePath, renderVariablesFile(singleBlockModel()), 'utf8');

        const errors: string[] = [];
        const io: CommandIO = {
            showInputBox: () => Promise.resolve(undefined),
            confirm: () => Promise.resolve(true),
            showQuickPick: () => Promise.resolve(undefined),
            showError: (message: string) => { errors.push(message); },
        };
        const result = await resolveTarget(subsetNode(outsidePath, 0), 'subset', vaultRoot, io);
        assert.strictEqual(result, undefined, 'resolveTarget must refuse a path outside the Variables directory');
        assert.strictEqual(errors.length, 1);
    });
});
