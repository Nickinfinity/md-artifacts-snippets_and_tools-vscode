import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments } from './read-path-guard.test.js';

/** The W4 render-path files — each now renders only through the engine. */
const RENDER_PATH_FILES = [
    'ui/panels/artifactPicker/preview.insert.ts',
    'ui/panels/artifactPicker/preview.helpers.ts',
    'ui/panels/artifactPicker/preview.actions.ts',
    'ui/panels/artifactPicker/varSetController.ts',
    'commands/variables-apply.command.ts',
] as const;

/**
 * TS substitution a render-path file must not regain.
 * The `applyVarSet` rule is import-anchored on purpose: `target.applyVarSet(ref)` and the
 * `applyVarSet:` bag key are the `PreviewVarTarget` method and stay legal.
 *
 * @param src - Comment-stripped source.
 * @returns Violations, empty when clean.
 * @example
 * renderPathViolations("resolveVars(code, vars)"); // ['resolveVars']
 */
export function renderPathViolations(src: string): string[] {
    const bad: string[] = [];
    if (/\bresolveVars\b/.test(src)) { bad.push('resolveVars'); }
    if (/import\s+(?!type\b)[^;]*from\s+['"][^'"]*parser\.service\.js['"]/.test(src)) { bad.push('parser.service.js'); }
    if (/import\s*\{[^}]*\bapplyVarSet\b[^}]*\}\s*from\s*['"][^'"]*varset\.service\.js['"]/.test(src)) { bad.push('applyVarSet import'); }
    return bad;
}

suite('render-path guard (W4)', () => {
    test('synthetic violations are caught, the legal shapes are not', () => {
        assert.deepStrictEqual(renderPathViolations('const out = resolveVars(code, vars);'), ['resolveVars']);
        assert.deepStrictEqual(renderPathViolations("import { parseFromContent } from '../../services/parser.service.js'"), ['parser.service.js']);
        assert.deepStrictEqual(renderPathViolations("import { applyVarSet, scoreVarSet } from '../../services/varset.service.js'"), ['applyVarSet import']);
        assert.deepStrictEqual(renderPathViolations('target.applyVarSet(ref)'), []);
        assert.deepStrictEqual(renderPathViolations('applyVarSet: ref => { void this.varSet.showDiffFor(ref, v); }'), []);
        assert.deepStrictEqual(renderPathViolations("import type { X } from '../../services/parser.service.js'"), []);
        assert.deepStrictEqual(renderPathViolations("import { subSetLabel } from '../services/varset.service.js'"), []);
    });

    test('every W4 render-path file renders only through the engine', () => {
        const srcRoot = path.resolve(__dirname, '..', '..', 'src');
        for (const rel of RENDER_PATH_FILES) {
            const src = stripComments(fs.readFileSync(path.join(srcRoot, rel), 'utf8'));
            assert.deepStrictEqual(renderPathViolations(src), [], `${rel} regained TS substitution`);
        }
    });

    // ponytail: stripComments' `/\*…\*/` can start inside a string such as `'**/*.md'`
    // (vault-watch.service.ts) and eat to the next `*/` — the same blind spot the W2/W3 guards
    // carry. A tokenizer would close it; not worth one for a grep guard.
    test('L-5: no src file references resolveVars in code', () => {
        const srcRoot = path.resolve(__dirname, '..', '..', 'src');
        const offenders = fs.readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
            .filter(rel => rel.endsWith('.ts'))
            .filter(rel => /\bresolveVars\b/.test(stripComments(fs.readFileSync(path.join(srcRoot, rel), 'utf8'))));
        assert.deepStrictEqual(offenders, []);
    });
});
