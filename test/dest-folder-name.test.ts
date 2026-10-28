import * as assert from 'node:assert';
import { validateFolderName } from '../src/ui/panels/destFolderPicker.panel.js';

/** New-folder name rules (moved beside the folder picker by W5 T5.7 — no engine write sees a folder name). */
suite('validateFolderName', () => {
    test('plain ASCII → ok', () => {
        assert.strictEqual(validateFolderName('Web').ok, true);
    });

    test('unicode → ok', () => {
        assert.strictEqual(validateFolderName('café').ok, true);
    });

    test('empty → reject', () => {
        assert.strictEqual(validateFolderName('').ok, false);
    });

    test('dot . → reject (traversal)', () => {
        assert.strictEqual(validateFolderName('.').ok, false);
    });

    test('dot-dot .. → reject (traversal)', () => {
        assert.strictEqual(validateFolderName('..').ok, false);
    });

    test('contains / → reject (nested path)', () => {
        assert.strictEqual(validateFolderName('a/b').ok, false);
    });

    test('contains \\ → reject (nested path)', () => {
        assert.strictEqual(validateFolderName('a\\b').ok, false);
    });

    test('illegal char : → reject', () => {
        assert.strictEqual(validateFolderName('a:b').ok, false);
    });

    test('reserved name CON → reject', () => {
        assert.strictEqual(validateFolderName('CON').ok, false);
    });

    test('reserved name LPT3 → reject', () => {
        assert.strictEqual(validateFolderName('lpt3').ok, false);
    });

    test('leading dot → reject', () => {
        assert.strictEqual(validateFolderName('.hidden').ok, false);
    });

    test('trailing space → reject', () => {
        assert.strictEqual(validateFolderName('name ').ok, false);
    });

    test('folder named foo.md → ok (no .md rejection for folders)', () => {
        assert.strictEqual(validateFolderName('foo.md').ok, true);
    });
});
