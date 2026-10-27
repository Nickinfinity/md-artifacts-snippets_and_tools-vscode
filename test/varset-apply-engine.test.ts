import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { toApplyResult } from '../src/engine/adapt.js';
import { VarSetController } from '../src/ui/panels/artifactPicker/varSetController.js';
import type { VarSetRef } from '../src/services/preview-target.service.js';
import type { EngineResult } from '../src/types/engine.types.js';

/**
 * T4.4 — the var-set apply diff comes from `varsets.apply`, never from TS `applyVarSet`.
 * Replies are seeded from the engine op cases; the fake never computes an apply.
 */

const CASES = path.join(__dirname, '../../test/fixtures/engine/op-cases/varsets.apply');
const expectOf = (n: string): EngineResult<'varsets.apply'> =>
    (JSON.parse(fs.readFileSync(path.join(CASES, `${n}.json`), 'utf8')) as { expect: EngineResult<'varsets.apply'> }).expect;
const errorOf = (n: string): string =>
    (JSON.parse(fs.readFileSync(path.join(CASES, `${n}.json`), 'utf8')) as { expect_error: string }).expect_error;

const FLAT: VarSetRef = { label: 'Dev', path: 'Variables/flat.md' };
const TYPED = { 'VK-host': 'x', 'VK-zzz': 'o' };

suite('varsets.apply → diff step', () => {
    let fake: FakeEngine;
    let dispose: () => void;
    let toasts: string[];
    let posts: Record<string, unknown>[];
    let ctrl: VarSetController;

    const applies = (): { params: Record<string, unknown> }[] => fake.received.filter(r => r.method === 'varsets.apply') as { params: Record<string, unknown> }[];
    const named = (c: string): Record<string, unknown>[] => posts.filter(p => p.command === c);

    setup(() => {
        toasts = []; posts = [];
        fake = createFakeEngine();
        const h = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: m => { toasts.push(m); return Promise.resolve(undefined); } });
        dispose = () => { h.dispose(); };
        ctrl = new VarSetController(vscode.Uri.file('/ext'), {
            getCurrentArtifact: () => undefined, postMessage: m => { posts.push(m); }, rememberAppliedSet: () => undefined,
        });
    });
    teardown(() => { dispose(); });

    test('flat ref: one varsets.apply, no subset key, three diff rows from the reply', async () => {
        fake.on('varsets.apply', () => ({ result: expectOf('mixed_actions') }));
        await ctrl.showDiffFor(FLAT, TYPED);
        assert.strictEqual(applies().length, 1);
        assert.deepStrictEqual(applies()[0].params, { path: 'Variables/flat.md', values: TYPED });
        const html = String(named('showVarSetDiff')[0].html);
        for (const c of ['diff-overridden', 'diff-filled', 'diff-kept']) { assert.ok(html.includes(c), c); }
    });

    test('confirm posts the reply values and the filled/overridden names', async () => {
        const reply = expectOf('mixed_actions');
        fake.on('varsets.apply', () => ({ result: reply }));
        await ctrl.showDiffFor(FLAT, TYPED);
        ctrl.handleConfirmApply();
        const applied = named('varSetApplied');
        assert.strictEqual(applied.length, 1);
        assert.deepStrictEqual(applied[0].values, reply.values);
        assert.deepStrictEqual(applied[0].varNames, ['VK-host', 'VK-port']);
    });

    test('sets ref: subset sent verbatim', async () => {
        fake.on('varsets.apply', () => ({ result: expectOf('sets') }));
        const ref: VarSetRef = { label: 'Dev', path: 'Variables/sets.md', subset: { index: 0, heading: 'Dev' } };
        await ctrl.showDiffFor(ref, {});
        assert.deepStrictEqual(applies()[0].params, { path: 'Variables/sets.md', subset: { index: 0, heading: 'Dev' }, values: {} });
    });

    test('a failed apply clears the previous diff: one toast, no second diff, confirm applies nothing', async () => {
        fake.on('varsets.apply', () => ({ result: expectOf('mixed_actions') }));
        await ctrl.showDiffFor(FLAT, TYPED);
        fake.on('varsets.apply', () => ({ error: { code: errorOf('mismatch'), params: {} } }));
        await ctrl.showDiffFor(FLAT, TYPED);
        assert.strictEqual(named('showVarSetDiff').length, 1);
        assert.strictEqual(toasts.length, 1);
        ctrl.handleConfirmApply();
        assert.strictEqual(named('varSetApplied').length, 0);
    });

    test('SEC: hostile action / non-string name rows are dropped, never rendered', async () => {
        const good = expectOf('mixed_actions').changes[1];
        const bad = [
            { action: '"><img src=x onerror=alert(1)>', name: 'VK-evil', oldValue: '', newValue: 'n' },
            { action: 'filled', name: 42, oldValue: '', newValue: 'n' },
        ];
        fake.on('varsets.apply', () => ({ result: { changes: [bad[0], bad[1], good], values: { 'VK-port': '3000' } } }));
        await ctrl.showDiffFor(FLAT, {});
        const html = String(named('showVarSetDiff')[0].html);
        assert.ok(!html.includes('onerror') && !html.includes('VK-evil'), html);
        assert.ok(html.includes('diff-filled') && html.includes('VK-port'));
    });

    test('SEC: a malformed reply posts nothing, leaves nothing confirmable, one toast', async () => {
        fake.on('varsets.apply', () => ({ result: expectOf('mixed_actions') }));
        await ctrl.showDiffFor(FLAT, TYPED);
        fake.on('varsets.apply', () => ({ result: { changes: 'x', values: {} } }));
        await ctrl.showDiffFor(FLAT, TYPED);
        assert.strictEqual(named('showVarSetDiff').length, 1);
        assert.strictEqual(toasts.length, 1);
        ctrl.handleConfirmApply();
        assert.strictEqual(named('varSetApplied').length, 0);
    });

    test('toApplyResult drops structured rows and values, blanks a structured oldValue', () => {
        const mixed = expectOf('mixed_actions');
        const structured = expectOf('structured');
        const odd = { action: 'kept' as const, name: 'VK-odd', newValue: 'n', oldValue: { a: '1' } };
        const merged = {
            changes: [...mixed.changes, ...structured.changes, odd],
            values: { ...mixed.values, ...structured.values, 'VK-odd': 'n' },
        } as unknown as EngineResult<'varsets.apply'>;
        const out = toApplyResult(merged);
        assert.deepStrictEqual(out.changes, [...mixed.changes, { action: 'kept', name: 'VK-odd', newValue: 'n', oldValue: '' }]);
        assert.deepStrictEqual(out.values, { ...mixed.values, 'VK-odd': 'n' });
        assert.ok(!('VK-db' in out.values));
    });
});
