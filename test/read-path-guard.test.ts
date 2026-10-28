import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ponytail: tenth copy of the comment stripper in test/ (precedent l10n-ui.test.ts:21); exported so
// write-path-guard.test.ts (W3/H3.2) reuses it instead of becoming the eleventh.
export const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The W2 read-path files — each now reads the vault only through the engine. */
const READ_PATH_FILES = [
    'ui/panels/settings.panel.ts',
    'services/context.service.ts',
    'ui/panels/artifactPicker/navigator.ts',
    'ui/panels/artifactPicker/navigator.helpers.ts',
    'services/varset.service.ts',
] as const;

/**
 * Direct vault I/O a read-path file must not regain.
 *
 * @param src - Comment-stripped source.
 * @returns Violations, empty when clean.
 * @example
 * readPathViolations("await vscode.workspace.fs.readFile(u)"); // ['workspace.fs']
 */
export function readPathViolations(src: string): string[] {
    const bad: string[] = [];
    if (/\bworkspace\.fs\b/.test(src)) { bad.push('workspace.fs'); }
    if (/\bparseFromContent\b/.test(src)) { bad.push('parseFromContent'); }
    if (/['"][./]*services\/vault\.service\.js['"]|['"]\.\/vault\.service\.js['"]/.test(src)) { bad.push('vault.service.js'); }
    return bad;
}

suite('read-path guard (W2)', () => {
    test('synthetic violations are caught', () => {
        assert.deepStrictEqual(readPathViolations('await vscode.workspace.fs.readFile(u)'), ['workspace.fs']);
        assert.deepStrictEqual(readPathViolations('parseFromContent(text, uri)'), ['parseFromContent']);
        assert.deepStrictEqual(readPathViolations("import { x } from '../../services/vault.service.js'"), ['vault.service.js']);
        assert.deepStrictEqual(readPathViolations("import { x } from './vault.service.js'"), ['vault.service.js']);
        assert.deepStrictEqual(readPathViolations("import { x } from './vault-watch.service.js'"), []);
    });

    test('every W2 read-path file reads the vault only through the engine', () => {
        const srcRoot = path.resolve(__dirname, '..', '..', 'src');
        for (const rel of READ_PATH_FILES) {
            const src = stripComments(fs.readFileSync(path.join(srcRoot, rel), 'utf8'));
            assert.deepStrictEqual(readPathViolations(src), [], `${rel} regained direct vault I/O`);
        }
    });

    // T5.5: the engine only selects Obsidian vaults (`vault.not_obsidian`), so no `.obsidian` re-check.
    // Not in READ_PATH_FILES: its size-check `workspace.fs.stat` is a recorded E-1 exception.
    test('create-from-surface imports no vault.service', () => {
        const src = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'commands', 'create-from-surface.command.ts'), 'utf8'));
        assert.ok(!readPathViolations(src).includes('vault.service.js'), 'create-from-surface regained the vault.service import');
    });
});
