import * as assert from 'node:assert';
import type * as vscode from 'vscode';
import { handleApplyToPreview, handleSaveCurrentValues, type ApplyDeps } from '../src/commands/variables-apply.command.js';
import { setPreviewTarget, type PreviewVarTarget } from '../src/services/preview-target.service.js';
import { resolveTarget, type CommandIO } from '../src/commands/variables.command.helpers.js';
import type { VariableNode } from '../src/ui/views/variablesView.provider.js';
import { useVarsEngine, recordedSource, VAULT, type VarsEngine } from './vars-engine.js';

/**
 * T1.3 — Variables-pane commands that reach a live preview (VSX-246).
 *
 * The module does NOT exist yet — every test here fails on import until
 * `src/commands/variables-apply.command.ts` is implemented.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

let eng: () => VarsEngine;
const makeVault = (): vscode.Uri => VAULT;
/** Serves the recorded flat set (`vars-flat`) at `Variables/<name>.md`; returns the absolute path a tree node carries. */
const writeFixture = (_vault: vscode.Uri, name: string): string =>
    eng().serve(`Variables/${name}.md`, recordedSource('vars-flat'));

function subsetNode(filePath: string, subIdx: number): VariableNode {
    return { id: `${filePath}::subset:${subIdx}`, parentId: filePath, kind: 'subset', label: `sub${subIdx}` };
}

/** Fake `PreviewVarTarget` that records every `applyVarSet` call. */
function fakeTarget(): PreviewVarTarget & { applied: unknown[] } {
    const applied: unknown[] = [];
    return {
        applied,
        applyVarSet: (...args: unknown[]) => { applied.push(args[0]); },
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

suite('Variables apply commands (engine)', () => {
    eng = useVarsEngine();

    // ── O-2: no preview open ─────────────────────────────────────────────────────

    suite('handleApplyToPreview / handleSaveCurrentValues — no preview open (O-2)', () => {
        test('handleApplyToPreview: no preview open — must not throw, must not apply, must tell the user', async () => {
            const vaultRoot = makeVault();
            const filePath = writeFixture(vaultRoot, 'dev');
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
            const filePath = writeFixture(vaultRoot, 'dev');
            const { deps } = makeDeps(vaultRoot);
            const target = fakeTarget();
            const release = setPreviewTarget(target);

            try {
                await handleApplyToPreview(subsetNode(filePath, 0), deps);
                assert.deepStrictEqual(target.applied, [{ label: 'Local Dev', path: 'Variables/dev.md' }]);
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
        const outside = (): string => eng().serve('NotVariables/outside.md', recordedSource('vars-flat'));

        test('a valid Variables file OUTSIDE Variables/ is refused before reaching the preview', async () => {
            const outsidePath = outside();
            const { deps } = makeDeps(VAULT);
            const target = fakeTarget();
            const release = setPreviewTarget(target);
            try {
                await handleApplyToPreview(subsetNode(outsidePath, 0), deps);
                assert.strictEqual(target.applied.length, 0, 'a file outside Variables/ reached the preview');
                assert.strictEqual(eng().calls('artifact.read').length, 0, 'the outside file was read');
            } finally {
                release();
            }
        });

        test('sink assertion: resolveTarget refuses the outside path and sends no artifact.read', async () => {
            const outsidePath = outside();
            const errors: string[] = [];
            const io: CommandIO = {
                showInputBox: () => Promise.resolve(undefined),
                confirm: () => Promise.resolve(true),
                showQuickPick: () => Promise.resolve(undefined),
                showError: (message: string) => { errors.push(message); },
            };
            assert.strictEqual(await resolveTarget(subsetNode(outsidePath, 0), 'subset', VAULT, io), undefined);
            assert.strictEqual(errors.length, 1);
            assert.strictEqual(eng().calls('artifact.read').length, 0);
        });

        test('paired: the same file inside Variables/ is read exactly once', async () => {
            const inside = eng().serve('Variables/in.md', recordedSource('vars-flat'));
            const target = await resolveTarget(subsetNode(inside, 0), 'subset', VAULT, makeDeps(VAULT).deps.io);
            assert.ok(target);
            assert.strictEqual(eng().calls('artifact.read').length, 1);
        });
    });
});
