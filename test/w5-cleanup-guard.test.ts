import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments } from './read-path-guard.test.js';

/** `src`-relative files W5 deleted — the engine owns their rules now. */
const DELETED = [
    'services/parser.service.ts', 'services/flags.service.ts', 'services/artifact-serializer.service.ts',
    'services/artifact-patcher.service.ts', 'services/variables-writer.service.ts',
    'services/artifact-writer.service.ts', 'services/template-writer.service.ts',
    'services/create-index.service.ts', 'services/frontmatter-migration.service.ts',
    'services/multi-index.service.ts', 'services/template-destination.service.ts',
    'services/varset-form.service.ts', 'services/variables-crud.service.ts',
    'services/vault.service.ts', 'services/filename.service.ts',
] as const;

/** E-1 Done: the only `src` files that may touch the file system (§11). */
const FS_ALLOWED = [
    'commands/create-from-surface.command.ts',
    'engine/engine.vscode.ts',
    'services/scratch-file.service.ts',
    'ui/panels/destFolderPicker.panel.ts',
];

const srcRoot = path.resolve(__dirname, '../../src');

/** Recursively lists every `.ts` file under a directory. */
function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { return tsFiles(full); }
        return e.name.endsWith('.ts') ? [full] : [];
    });
}

const rel = (f: string): string => path.relative(srcRoot, f).split(path.sep).join('/');

/** Old-format residue the W5 cut removed. Built by concatenation so this file never spells them. */
const RESIDUE = [
    '`'.repeat(3) + 'vks',
    'VKS' + '_FENCE',
    'EMPTY' + '_VKS',
    'render' + 'VariablesFile',
    'write' + 'VariablesFile',
] as const;

/** Every file under a directory, any extension (fixtures are `.md` / `.json`, not `.ts`). */
function allFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? allFiles(full) : [full];
    });
}

/**
 * Finds residue needles in `[name, text]` pairs. Pure, so the guard can be proven red on planted input.
 *
 * @param files - Name and raw text pairs. Comments count: residue in a comment is still residue.
 * @returns `name -> needle` hits, empty when clean.
 * @example
 * residueHits([['a.ts', 'const x = 1;']]); // []
 */
function residueHits(files: ReadonlyArray<readonly [string, string]>): string[] {
    return files.flatMap(([name, text]) => RESIDUE.filter(n => text.includes(n)).map(n => `${name} -> ${n}`));
}

suite('W5 cleanup guard', () => {

    test('(a) the deleted services no longer exist', () => {
        const alive = DELETED.filter(f => fs.existsSync(path.join(srcRoot, f)));
        assert.deepStrictEqual(alive, []);
    });

    test('(b) no src import names a deleted service', () => {
        const names = DELETED.map(f => path.basename(f, '.ts'));
        const hits = tsFiles(srcRoot).flatMap(f => {
            const code = stripComments(fs.readFileSync(f, 'utf-8'));
            return names.filter(n => code.includes(`/${n}.js'`)).map(n => `${rel(f)} -> ${n}`);
        });
        assert.deepStrictEqual(hits, []);
    });

    test('(c) E-1: file-system access is exactly the four recorded files', () => {
        const fsRe = /workspace\.fs|from 'fs'|fs\/promises|from 'node:fs'/;
        const found = tsFiles(srcRoot).filter(f => fsRe.test(fs.readFileSync(f, 'utf-8'))).map(rel).sort();
        assert.deepStrictEqual(found, [...FS_ALLOWED].sort());
    });

    test('(d) no src file spells the flag marker (the engine owns the syntax)', () => {
        const hits = tsFiles(srcRoot)
            .filter(f => stripComments(fs.readFileSync(f, 'utf-8')).includes('%%oa:')).map(rel);
        assert.deepStrictEqual(hits, []);
    });

    test('(e) Done: no old-format residue in raw src/ or test/', () => {
        const testRoot = path.resolve(__dirname, '../../test');
        assert.deepStrictEqual(residueHits([['planted.md', 'x ' + RESIDUE[0]]]), ['planted.md -> ' + RESIDUE[0]]);
        const files = [...allFiles(srcRoot), ...allFiles(testRoot)]
            .map(f => [path.relative(srcRoot, f), fs.readFileSync(f, 'utf-8')] as const);
        assert.deepStrictEqual(residueHits(files), []);
    });
});
