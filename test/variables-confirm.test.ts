import * as assert from 'node:assert';
import { confirmTextFor } from '../src/commands/variables.confirm.helpers.js';

/**
 * Unit tests for the destructive-path confirmation builder (T17, VSX-220).
 *
 * `confirmTextFor` is a pure string builder — no `vscode` import, no I/O —
 * shared by all three delete commands (delete var / delete sub-set / delete
 * file) so the wording lives in exactly one place. Each of the three
 * `VariableNodeKind`s must produce a distinct message, the two kinds that
 * carry a variable count (`file`, `subset`) must pluralise correctly
 * (including the `0` edge case), and the two kinds whose `name` is not
 * self-identifying (`subset`, `var`) must carry `parent` — duplicate names
 * one level below `file` are legal by design, so the same `VK-host` under
 * `Dev` and under `Prod` must not produce the same modal (review finding 1,
 * VSX-220).
 *
 * The module does NOT exist yet — every test below fails on import until
 * `src/commands/variables.confirm.helpers.ts` is implemented.
 */

suite('confirmTextFor', () => {

    test('file kind — exact pinned wording (plan T17 anchor assertion)', () => {
        assert.strictEqual(
            confirmTextFor({ kind: 'file', name: 'dev.md', varCount: 12 }),
            'Delete dev.md and its 12 variables? This cannot be undone.',
        );
    });

    test('file kind — singular at count 1', () => {
        assert.strictEqual(
            confirmTextFor({ kind: 'file', name: 'dev.md', varCount: 1 }),
            'Delete dev.md and its 1 variable? This cannot be undone.',
        );
    });

    test('file kind — plural at count 0 (a file with no sub-sets is still deletable)', () => {
        assert.strictEqual(
            confirmTextFor({ kind: 'file', name: 'empty.md', varCount: 0 }),
            'Delete empty.md and its 0 variables? This cannot be undone.',
        );
    });

    test('subset kind — plural wording + parent, distinct from file kind', () => {
        assert.strictEqual(
            confirmTextFor({ kind: 'subset', name: 'Production', varCount: 3, parent: 'dev.md' }),
            'Delete sub-set Production in dev.md and its 3 variables? This cannot be undone.',
        );
    });

    test('subset kind — singular at count 1', () => {
        assert.strictEqual(
            confirmTextFor({ kind: 'subset', name: 'Production', varCount: 1, parent: 'dev.md' }),
            'Delete sub-set Production in dev.md and its 1 variable? This cannot be undone.',
        );
    });

    test('subset kind — plural at count 0 (a sub-set with no variables is still deletable)', () => {
        assert.strictEqual(
            confirmTextFor({ kind: 'subset', name: 'Empty', varCount: 0, parent: 'dev.md' }),
            'Delete sub-set Empty in dev.md and its 0 variables? This cannot be undone.',
        );
    });

    test('var kind — atomic leaf, no count clause, carries parent, distinct from file/subset', () => {
        assert.strictEqual(
            confirmTextFor({ kind: 'var', name: 'VK-api_key', parent: 'Dev' }),
            'Delete variable VK-api_key from sub-set Dev? This cannot be undone.',
        );
    });

    test('all three kinds produce distinct messages for the same name/count/parent', () => {
        const messages = new Set([
            confirmTextFor({ kind: 'file', name: 'X', varCount: 1 }),
            confirmTextFor({ kind: 'subset', name: 'X', varCount: 1, parent: 'p' }),
            confirmTextFor({ kind: 'var', name: 'X', parent: 'p' }),
        ]);
        assert.strictEqual(messages.size, 3);
    });

    test('every message ends with the fixed "cannot be undone" sentence', () => {
        // Each variant has a different required shape (a discriminated union,
        // not one shape looped over three `kind` literals), so the three
        // calls are spelled out rather than driven by a `for` loop.
        const messages = [
            confirmTextFor({ kind: 'file', name: 'X', varCount: 2 }),
            confirmTextFor({ kind: 'subset', name: 'X', varCount: 2, parent: 'p' }),
            confirmTextFor({ kind: 'var', name: 'X', parent: 'p' }),
        ];
        for (const message of messages) {
            assert.ok(message.endsWith('This cannot be undone.'));
        }
    });

    // ── Ambiguous names (VSX-220 review finding 1) ──────────────────────────
    // `addVar`'s uniqueness check is scoped to one sub-set and `addSubSet`'s to
    // one file (both engine rules), so the same leaf
    // name legitimately exists under two different parents — `VK-host` in
    // both `Dev` and `Prod`, or two files each owning a `Production` sub-set.
    // Without `parent` in the message, both rows produce a byte-identical
    // modal and the user cannot tell which one they are about to destroy.

    test('var kind — same name under two different sub-sets produces different messages', () => {
        const inDev = confirmTextFor({ kind: 'var', name: 'VK-host', parent: 'Dev' });
        const inProd = confirmTextFor({ kind: 'var', name: 'VK-host', parent: 'Prod' });
        assert.notStrictEqual(inDev, inProd);
    });

    test('subset kind — same name under two different files produces different messages', () => {
        const inFileA = confirmTextFor({ kind: 'subset', name: 'Production', varCount: 3, parent: 'a.md' });
        const inFileB = confirmTextFor({ kind: 'subset', name: 'Production', varCount: 3, parent: 'b.md' });
        assert.notStrictEqual(inFileA, inFileB);
    });

    // ── Union rejects the missing/wrong field, per kind (VSX-220 review round 2) ──
    // The bug this round fixed was `parent?: string`: typed optional, so
    // omitting it compiled clean and rendered "...undefined?" into a
    // destructive-action modal. `ConfirmInput` is now a discriminated union
    // where each kind's required fields are exactly the ones its message
    // uses — these are compile-time assertions: `@ts-expect-error` fails the
    // build the moment the next line stops erroring, which is what "the
    // union stopped enforcing this" would look like.

    test('type union — file kind rejects a parent (its name self-identifies)', () => {
        // @ts-expect-error - 'file' has no 'parent' field; passing one must not compile
        const result = confirmTextFor({ kind: 'file', name: 'dev.md', varCount: 1, parent: 'nope' });
        assert.strictEqual(typeof result, 'string');
    });

    test('type union — subset kind requires parent', () => {
        // @ts-expect-error - 'subset' omitting 'parent' must not compile
        const result = confirmTextFor({ kind: 'subset', name: 'Production', varCount: 1 });
        assert.strictEqual(typeof result, 'string');
    });

    test('type union — var kind requires parent and rejects varCount (atomic leaf, no substructure)', () => {
        // @ts-expect-error - 'var' omitting 'parent' must not compile
        const withoutParent = confirmTextFor({ kind: 'var', name: 'VK-host' });
        // @ts-expect-error - 'var' has no 'varCount' field; passing one must not compile
        const withVarCount = confirmTextFor({ kind: 'var', name: 'VK-host', parent: 'Dev', varCount: 0 });
        assert.strictEqual(typeof withoutParent, 'string');
        assert.strictEqual(typeof withVarCount, 'string');
    });
});
