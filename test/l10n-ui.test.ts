import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T5.3 own guard, additive to the landed `l10n sources — src/ui` suite
 * (`test/l10n-sources.test.ts`, read-only).
 *
 * `confirmModal` `action:` labels (`preview.ts`, `panel.helpers.ts` x2) —
 * `action` is deliberately excluded from every guard pattern (it
 * false-positives on `varset.types.ts:73` and `varset.service.ts:228,233`), so
 * these are green whether localised or not without a dedicated positive check.
 *
 * `stripComments` is copied verbatim from `create-path-dry.test.ts:55` per
 * `plan.md` §10 — the fifth local copy, accepted as test-only.
 */

const srcRoot = path.resolve(__dirname, '..', '..', 'src');

/**
 * Strips block and line comments so the scan sees code only.
 *
 * @param source - Raw TypeScript source text.
 * @returns The source with comments blanked out.
 *
 * @example
 * stripComments("showErrorMessage('x') // showErrorMessage('y')");
 * // → "showErrorMessage('x') "
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

function read(relPath: string): string {
    return fs.readFileSync(path.join(srcRoot, relPath), 'utf8');
}

suite('l10n — src/ui positive assertions (T5.3)', () => {
    test('the block-code overwrite confirmModal action label is localised (preview.ts)', () => {
        const src = stripComments(['preview.ts', 'preview.staged.ts'].map(f => read(`ui/panels/artifactPicker/${f}`)).join('\n'));
        assert.match(src, /action:\s*OVERWRITE_ACTION/,
            'preview.ts\'s confirmModal action: is not routed through a localised const');
        assert.match(src, /const OVERWRITE_ACTION\s*=\s*vscode\.l10n\.t\('Overwrite'\)/,
            'OVERWRITE_ACTION is not localised via vscode.l10n.t');
    });

    test('the delete/discard confirmModal action labels are localised (panel.helpers.ts)', () => {
        const src = stripComments(read('ui/panels/artifactForm/panel.helpers.ts'));
        assert.match(src, /action:\s*DELETE_ACTION/,
            'confirmDeleteFile\'s action: is not routed through a localised const');
        assert.match(src, /const DELETE_ACTION\s*=\s*vscode\.l10n\.t\('Delete'\)/,
            'DELETE_ACTION is not localised via vscode.l10n.t');
        assert.match(src, /action:\s*DISCARD_ACTION/,
            'confirmDiscardDraft\'s action: is not routed through a localised const');
        assert.match(src, /const DISCARD_ACTION\s*=\s*vscode\.l10n\.t\('Discard'\)/,
            'DISCARD_ACTION is not localised via vscode.l10n.t');
    });
});
