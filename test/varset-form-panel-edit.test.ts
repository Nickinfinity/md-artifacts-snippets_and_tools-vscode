import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    openVarSetFormPanel,
    handleVarSetFormMessage,
    type VarSetFormCallbacks,
} from '../src/ui/panels/varsetForm/varsetForm.panel.js';
import type { VarsEditPayload } from '../src/types/varset.types.js';

/**
 * T7.1b — the var-set form panel's create/edit modes: the open-time
 * writer guard, the mode-keyed (never callback-presence-keyed) branch, and
 * the two callback-not-called assertions the panel is the only place able
 * to prove (parse rejection, content-sink rejection).
 */

function fakeBag(overrides: Partial<VarSetFormCallbacks> = {}): VarSetFormCallbacks & { writeCalls: unknown[]; closeCalls: number } {
    const writeCalls: unknown[] = [];
    let closeCalls = 0;
    return {
        validate: () => ({ ok: true }),
        write: async () => { /* create-mode write; unused here */ },
        post: () => { /* no-op */ },
        close: () => { closeCalls++; },
        get writeCalls() { return writeCalls; },
        get closeCalls() { return closeCalls; },
        ...overrides,
    } as VarSetFormCallbacks & { writeCalls: unknown[]; closeCalls: number };
}

const basePayload: VarsEditPayload = {
    title: 'Bundles',
    description: '',
    tags: ['api'],
    env: 'staging',
    subSets: [{ heading: 'Dev', pairs: [['VK-host', 'localhost']] }],
};

suite('varset form panel — open-time writer guard (edit mode)', () => {

    test('edit mode without cb.writeEdit throws before creating a panel', () => {
        const panelsBefore = countOpenPanels();
        assert.throws(() => {
            openVarSetFormPanel(
                vscode.Uri.file('/ext'),
                { validate: () => ({ ok: true }), write: async () => { /* noop */ }, post: () => { /* noop */ }, close: () => { /* noop */ } },
                { mode: 'edit', payload: basePayload, sourceUri: vscode.Uri.file('/v/Variables/bundles.md') },
            );
        }, /writeEdit/);
        // Source-order proof (test/edit-artifact.test.ts:380-385 precedent):
        // the throw fires before vscode.window.createWebviewPanel runs, so no
        // panel is left behind by the attempt.
        assert.strictEqual(countOpenPanels(), panelsBefore, 'a panel was created despite the missing writer');
    });

    test('edit mode with cb.writeEdit present opens without throwing', () => {
        const panel = openVarSetFormPanel(
            vscode.Uri.file('/ext'),
            fakeBag({ writeEdit: async () => { /* noop */ } }),
            { mode: 'edit', payload: basePayload, sourceUri: vscode.Uri.file('/v/Variables/bundles.md') },
        );
        assert.strictEqual(panel, undefined); // void return; reaching here is the assertion
    });
});

suite('varset form panel — mode keys the branch, not callback presence', () => {

    test('create-mode save with a writer-carrying bag still takes the create path (not edit)', async () => {
        let editCalled = false;
        let createCalled = false;
        const cb = fakeBag({
            // A bag that happens to carry writeEdit — must not flip a
            // create-mode message onto the edit save path.
            writeEdit: async () => { editCalled = true; },
            write: async () => { createCalled = true; },
        });

        await handleVarSetFormMessage(
            { command: 'save', payload: { title: 'x', description: '', tags: [], pairs: [['VK-a', 'b']] } },
            cb,
            'create',
        );

        assert.strictEqual(editCalled, false, 'create-mode save reached the edit writer');
        assert.strictEqual(createCalled, true, 'create-mode save did not reach the create writer');
    });
});

suite('varset form panel — edit-mode save: callback-not-called assertions', () => {

    test('a malformed payload never reaches writeEdit', async () => {
        let called = false;
        const cb = fakeBag({ writeEdit: async () => { called = true; } });

        await handleVarSetFormMessage(
            { command: 'save', payload: { title: 'x' /* missing pairs/subSets shape */ } },
            cb,
            'edit',
            basePayload,
        );

        assert.strictEqual(called, false, 'writeEdit was called despite a malformed payload');
    });

    test('a name containing "=" is rejected and never reaches writeEdit', async () => {
        let called = false;
        const cb = fakeBag({ writeEdit: async () => { called = true; } });

        await handleVarSetFormMessage(
            {
                command: 'save',
                payload: {
                    title: 'Bundles', description: '', tags: ['api'],
                    pairs: [[['VK-bad=name', 'localhost']]],
                },
            },
            cb,
            'edit',
            basePayload,
        );

        assert.strictEqual(called, false, 'writeEdit was called despite a fence-breaking name');
    });

    test('a value containing a newline is rejected and never reaches writeEdit', async () => {
        let called = false;
        const cb = fakeBag({ writeEdit: async () => { called = true; } });

        await handleVarSetFormMessage(
            {
                command: 'save',
                payload: {
                    title: 'Bundles', description: '', tags: ['api'],
                    pairs: [[['VK-host', 'line1\nline2']]],
                },
            },
            cb,
            'edit',
            basePayload,
        );

        assert.strictEqual(called, false, 'writeEdit was called despite a newline-carrying value');
    });

    test('a value containing a backtick is rejected and never reaches writeEdit', async () => {
        let called = false;
        const cb = fakeBag({ writeEdit: async () => { called = true; } });

        await handleVarSetFormMessage(
            {
                command: 'save',
                payload: {
                    title: 'Bundles', description: '', tags: ['api'],
                    pairs: [[['VK-host', 'has`backtick']]],
                },
            },
            cb,
            'edit',
            basePayload,
        );

        assert.strictEqual(called, false, 'writeEdit was called despite a backtick-carrying value');
    });

    test('a valid single-sub-set grouped payload survives the guard and reaches writeEdit', async () => {
        let received: VarsEditPayload | undefined;
        const cb = fakeBag({ writeEdit: async (payload) => { received = payload; } });

        await handleVarSetFormMessage(
            {
                command: 'save',
                payload: {
                    title: 'Bundles', description: '', tags: ['api'],
                    pairs: [[['VK-host', 'prod.example']]],
                },
            },
            cb,
            'edit',
            basePayload,
        );

        assert.ok(received, 'writeEdit was never called for a valid payload');
        assert.strictEqual(received?.subSets[0]?.pairs[0]?.[1], 'prod.example');
        // heading/env re-attached from base, never off the wire
        assert.strictEqual(received?.subSets[0]?.heading, 'Dev');
        assert.strictEqual(received?.env, 'staging');
    });
});

suite('varset form panel — create-mode call site (varSetController.ts)', () => {

    test('the picker still calls openVarSetFormPanel in create mode', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'varSetController.ts'),
            'utf8',
        );
        assert.ok(source.includes('openVarSetFormPanel('), 'varSetController.ts no longer calls openVarSetFormPanel');
        assert.ok(source.includes("mode:   'create'") || source.includes("mode: 'create'"), 'create-mode call site lost its explicit mode');
    });
});

/**
 * Counts currently-visible webview panels of the var-set form's view type via
 * `vscode.window.tabGroups` — used only to prove the open-time guard's throw
 * precedes panel creation (no panel left behind by a refused open).
 */
function countOpenPanels(): number {
    let count = 0;
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('varSetForm')) {
                count++;
            }
        }
    }
    return count;
}
