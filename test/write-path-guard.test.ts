import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments } from './read-path-guard.test.js';

/** The W3 write-path files — each now writes the vault and workspace only through the engine. */
const WRITE_PATH_FILES = [
    'commands/variables.command.ts',
    'commands/variables.command.helpers.ts',
    'commands/variables-meta.command.ts',
    'commands/open-vars-edit.helpers.ts',
    'commands/editArtifact.command.ts',
    'commands/migrate.command.ts',
    'commands/capture/editor.capture.ts',
    'commands/capture/explorer.capture.ts',
    'commands/capture/terminal.capture.ts',
    'ui/panels/artifactForm/panel.ts',
    'ui/panels/artifactForm/panel.helpers.ts',
    'ui/panels/varsetForm/varsetForm.panel.ts',
    'ui/panels/artifactPicker/preview.ts',
    'ui/panels/artifactPicker/preview.actions.ts',
    'ui/panels/artifactPicker/preview.staged.ts',
    'ui/panels/artifactPicker/preview.helpers.ts',
    'ui/panels/artifactPicker/preview.reread.ts',
    'ui/panels/artifactPicker/preview.createFile.ts',
    'ui/panels/artifactPicker/multiIndex.ts',
    'ui/panels/artifactPicker/varSetController.ts',
    'ui/views/createIndexRunner.ts',
] as const;

/**
 * Direct writes (and the TS writers / re-parser) a write-path file must not regain.
 * `import type` from the patcher stays legal — `BlockRef` is a type, not a write.
 *
 * @param src - Comment-stripped source.
 * @returns Violations, empty when clean.
 * @example
 * writePathViolations('await vscode.workspace.fs.writeFile(u, b)'); // ['workspace.fs']
 */
export function writePathViolations(src: string): string[] {
    const bad: string[] = [];
    if (/\bworkspace\.fs\b/.test(src)) { bad.push('workspace.fs'); }
    if (/from\s+['"](node:)?fs(\/promises)?['"]/.test(src)) { bad.push('fs import'); }
    for (const name of ['serializeArtifact', 'writeArtifact', 'writeVariablesFile', 'writeTemplateFile', 'parseArtifactFile', 'renderVariablesFile']) {
        if (new RegExp(`\\b${name}\\b`).test(src)) { bad.push(name); }
    }
    if (/\bpatch[A-Z]\w*\(/.test(src)) { bad.push('patch*('); }
    return bad;
}

/**
 * Write-only rule for the one file that must still READ a workspace file (`artifact.prefill`'s `text`).
 *
 * @param src - Comment-stripped source.
 * @returns Violations, empty when clean.
 * @example
 * workspaceWriteViolations('await vscode.workspace.fs.stat(u)'); // []
 */
export function workspaceWriteViolations(src: string): string[] {
    return /\bworkspace\.fs\.(writeFile|delete|createDirectory|rename|copy)\b/.test(src) ? ['workspace.fs write'] : [];
}

suite('write-path guard (W3)', () => {
    test('synthetic violations are caught', () => {
        assert.deepStrictEqual(writePathViolations('await vscode.workspace.fs.writeFile(u, b)'), ['workspace.fs']);
        assert.deepStrictEqual(writePathViolations("import * as fs from 'node:fs'"), ['fs import']);
        assert.deepStrictEqual(writePathViolations("import { promises } from 'fs'"), ['fs import']);
        assert.deepStrictEqual(writePathViolations('serializeArtifact(model)'), ['serializeArtifact']);
        assert.deepStrictEqual(writePathViolations('await writeVariablesFile(u, m)'), ['writeVariablesFile']);
        assert.deepStrictEqual(writePathViolations('parseArtifactFile(p, d)'), ['parseArtifactFile']);
        assert.deepStrictEqual(writePathViolations('patchBlockCode(text, ref, code)'), ['patch*(']);
        assert.deepStrictEqual(writePathViolations("import type { BlockRef } from '../../services/artifact-patcher.service.js'"), []);
        assert.deepStrictEqual(workspaceWriteViolations('await vscode.workspace.fs.stat(u)'), []);
        assert.deepStrictEqual(workspaceWriteViolations('await vscode.workspace.fs.delete(u)'), ['workspace.fs write']);
    });

    test('every W3 write-path file writes only through the engine', () => {
        const srcRoot = path.resolve(__dirname, '..', '..', 'src');
        for (const rel of WRITE_PATH_FILES) {
            const src = stripComments(fs.readFileSync(path.join(srcRoot, rel), 'utf8'));
            assert.deepStrictEqual(writePathViolations(src), [], `${rel} regained a direct write`);
        }
    });

    test('create-from-surface reads its source file but never writes the workspace', () => {
        const file = path.resolve(__dirname, '..', '..', 'src', 'commands', 'create-from-surface.command.ts');
        assert.deepStrictEqual(workspaceWriteViolations(stripComments(fs.readFileSync(file, 'utf8'))), []);
    });
});
