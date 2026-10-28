import * as assert from 'node:assert';
import { validateArtifactFilename, deriveFileName } from '../src/ui/panels/artifactForm/panel.helpers.js';

/**
 * The create form's file-name prompt rules (moved beside their sole caller by W5 T5.7;
 * the engine's `naming.*` refusal on write is the backstop, these are validate-as-you-type).
 */
suite('validateArtifactFilename', () => {
    test('plain ASCII name → ok', () => {
        assert.strictEqual(validateArtifactFilename('express-route').ok, true);
    });

    test('unicode name → ok (Obsidian supports them)', () => {
        assert.strictEqual(validateArtifactFilename('café-utils').ok, true);
    });

    test('empty string → reject', () => {
        assert.strictEqual(validateArtifactFilename('').ok, false);
    });

    test('whitespace-only → reject', () => {
        assert.strictEqual(validateArtifactFilename('   ').ok, false);
    });

    test('illegal char / → reject', () => {
        assert.strictEqual(validateArtifactFilename('a/b').ok, false);
    });

    test('illegal char \\ → reject', () => {
        assert.strictEqual(validateArtifactFilename('a\\b').ok, false);
    });

    test('illegal char : → reject', () => {
        assert.strictEqual(validateArtifactFilename('a:b').ok, false);
    });

    test('illegal chars * ? " < > | → reject', () => {
        for (const ch of ['*', '?', '"', '<', '>', '|']) {
            assert.strictEqual(validateArtifactFilename(`a${ch}b`).ok, false, `expected reject for ${ch}`);
        }
    });

    test('ASCII control char → reject', () => {
        assert.strictEqual(validateArtifactFilename('a\x01b').ok, false);
    });

    test('leading dot → reject', () => {
        assert.strictEqual(validateArtifactFilename('.hidden').ok, false);
    });

    test('trailing dot → reject', () => {
        assert.strictEqual(validateArtifactFilename('name.').ok, false);
    });

    test('leading space → reject', () => {
        assert.strictEqual(validateArtifactFilename(' name').ok, false);
    });

    test('trailing space → reject', () => {
        assert.strictEqual(validateArtifactFilename('name ').ok, false);
    });

    test('reserved name CON (uppercase) → reject', () => {
        assert.strictEqual(validateArtifactFilename('CON').ok, false);
    });

    test('reserved name con (lowercase) → reject', () => {
        assert.strictEqual(validateArtifactFilename('con').ok, false);
    });

    test('reserved name Con (mixed case) → reject', () => {
        assert.strictEqual(validateArtifactFilename('Con').ok, false);
    });

    test('reserved name COM1 → reject', () => {
        assert.strictEqual(validateArtifactFilename('COM1').ok, false);
    });

    test('reserved name LPT9 → reject', () => {
        assert.strictEqual(validateArtifactFilename('LPT9').ok, false);
    });

    test('reserved-name prefix only (CONsole) → ok', () => {
        assert.strictEqual(validateArtifactFilename('CONsole').ok, true);
    });

    test('.md extension typed (lowercase) → reject (caller appends)', () => {
        assert.strictEqual(validateArtifactFilename('foo.md').ok, false);
    });

    test('.MD extension typed (uppercase) → reject', () => {
        assert.strictEqual(validateArtifactFilename('foo.MD').ok, false);
    });

    test('.Md extension typed (mixed) → reject', () => {
        assert.strictEqual(validateArtifactFilename('foo.Md').ok, false);
    });

    test('reject returns user-facing reason string', () => {
        const r = validateArtifactFilename('a/b');
        assert.strictEqual(r.ok, false);
        assert.ok(r.reason && r.reason.length > 0);
    });
});

suite('deriveFileName', () => {
    test('valid title slugifies', () => {
        assert.strictEqual(deriveFileName('My New Snippet'), 'my-new-snippet');
    });

    test('empty title → untitled', () => {
        assert.strictEqual(deriveFileName(''), 'untitled');
    });

    test('whitespace-only title → untitled', () => {
        assert.strictEqual(deriveFileName('   '), 'untitled');
    });

    test('title that slugifies to empty → untitled', () => {
        assert.strictEqual(deriveFileName('!!!'), 'untitled');
    });
});
