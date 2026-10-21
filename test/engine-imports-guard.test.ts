import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Comments blanked, so a file documenting the rule cannot trip it. */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * Import/exec rules for `src/engine/`: only `engine.vscode.ts` touches `child_process`; only it and
 * `errors.ts` import `vscode`; nobody spawns through a shell or sync exec.
 *
 * @param fileName - Base name of the file.
 * @param src - Its comment-stripped source.
 * @returns Violations, empty when clean.
 * @example
 * checkEngineImports('adapt.ts', "import * as vscode from 'vscode'"); // ['imports vscode']
 */
export function checkEngineImports(fileName: string, src: string): string[] {
    const bad: string[] = [];
    if (fileName !== 'engine.vscode.ts' && /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"](?:node:)?child_process['"]/.test(src)) { bad.push('imports child_process'); }
    if (!['engine.vscode.ts', 'errors.ts'].includes(fileName) && /(?:from\s*|require\s*\(\s*|import\s*\(?\s*)['"]vscode['"]/.test(src)) { bad.push('imports vscode'); }
    if (/(?<!\.)\bexec(?:Sync|File|FileSync)?\s*\(|\bspawnSync\b|shell\s*:(?!\s*false\b)/.test(src)) { bad.push('exec/shell'); }
    return bad;
}

suite('engine import guard', () => {
    test('synthetic violations are caught', () => {
        assert.deepStrictEqual(checkEngineImports('adapt.ts', "import * as vscode from 'vscode'"), ['imports vscode']);
        assert.deepStrictEqual(checkEngineImports('adapt.ts', "import type { X } from 'vscode'"), ['imports vscode']);
        assert.deepStrictEqual(checkEngineImports('session.ts', "import { spawn } from 'node:child_process'"), ['imports child_process']);
        assert.deepStrictEqual(checkEngineImports('session.ts', "const c = require('child_process')"), ['imports child_process']);
        assert.deepStrictEqual(checkEngineImports('x.ts', 'spawn(a, b, { shell: true })'), ['exec/shell']);
        assert.deepStrictEqual(checkEngineImports('x.ts', 'execSync("ls")'), ['exec/shell']);
        assert.deepStrictEqual(checkEngineImports('adapt.ts', "spawn(b, a, { shell: '/bin/sh' })"), ['exec/shell']);
        assert.deepStrictEqual(checkEngineImports('adapt.ts', 'spawn(b, a, { shell: opt })'), ['exec/shell']);
        assert.deepStrictEqual(checkEngineImports('adapt.ts', "await import('node:child_process')"), ['imports child_process']);
        assert.deepStrictEqual(checkEngineImports('adapt.ts', "await import('vscode')"), ['imports vscode']);
        assert.deepStrictEqual(checkEngineImports('x.ts', 're.exec(s)'), []);
        assert.deepStrictEqual(checkEngineImports('engine.vscode.ts', "import * as vscode from 'vscode'; import { spawn } from 'node:child_process'"), []);
    });

    test('every src/engine file obeys', () => {
        const dir = path.resolve(__dirname, '..', '..', 'src', 'engine');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
        assert.ok(files.includes('engine.vscode.ts'));
        for (const f of files) {
            assert.deepStrictEqual(checkEngineImports(f, stripComments(fs.readFileSync(path.join(dir, f), 'utf8'))), [], f);
        }
    });
});
