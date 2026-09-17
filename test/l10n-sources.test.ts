import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * W5 drift guard: every user-facing string reaching a `vscode` API goes
 * through `vscode.l10n.t` (VSX-255).
 *
 * **This file is the one authority on the pattern list, and is read-only to
 * every worker.** An earlier draft of the plan had each of the wave's three
 * tasks write its own copy; three copies of one pattern list drift exactly the
 * way `CLAUDE.md`'s four divergent webview `esc` copies did — fix a false
 * positive in one and the other two keep it. It is landed *before* the wave's
 * workers are dispatched, which is also a strictly stronger TDD position than
 * a worker writing its own assertion: you cannot shape the guard to fit what
 * you wrote.
 *
 * **Three suites, one per task's `Owns` list**, so each worker can make
 * exactly its own suite green and read the other two failures as expected:
 * `l10n sources — src/commands` (T5.1), `— src/services` (T5.2),
 * `— src/ui` (T5.3). All three are red on landing, by construction, and stay
 * red until their task lands — see `plan.md` §10, the one wave in this plan
 * carrying a sanctioned red gate.
 *
 * **Comments are stripped before matching**, the same trap
 * `create-path-dry.test.ts`, `flags.service.test.ts` and
 * `force-write-containment.test.ts` all hit: the file documenting a rule is a
 * source-grep guard's first false positive. `plan.md` §10 spells the four
 * patterns out in prose, and several owned files carry JSDoc examples of the
 * very call shapes scanned for.
 *
 * ponytail: a regex over stripped text, not an AST check — load-bearing
 * ceiling, stated because the plan's Definition of done depends on knowing it.
 * It catches a literal in a message-API first argument, an option-object
 * value, a QuickPick property assignment, and this project's own
 * `io.showError` shim. It **cannot** catch a positional modal button label,
 * which is indistinguishable from any other string argument — those are held
 * by the positive per-call-site assertions in `test/l10n-ui.test.ts` (T5.3)
 * and by the `confirmModal` preference in `plan.md` §10. Upgrade path if a
 * miss ever actually bites: an AST scan (ts-morph or the TS compiler API) over
 * call expressions and their argument kinds.
 */

/**
 * Strips block and line comments so the scan sees code only.
 *
 * Copied verbatim from `create-path-dry.test.ts:55` per `plan.md` §10 — this
 * is the fourth local copy (with `force-write-containment.test.ts:36` and
 * `varset-scanner-singleton.test.ts:35`) and is accepted, test-only: a shared
 * helper would be a fifth file for a handful of assertions.
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

/**
 * Recursively lists every `.ts` file under a directory.
 *
 * @param dir - Directory to walk.
 * @returns Absolute paths of every `.ts` file found.
 *
 * @example
 * collectTsFiles('/repo/src/commands'); // → ['/repo/src/commands/…', …]
 */
function collectTsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { return collectTsFiles(full); }
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

const srcRoot = path.resolve(__dirname, '..', '..', 'src');
const servicesDir = path.join(srcRoot, 'services');

/**
 * Reads a source file with its comments stripped.
 *
 * @param file - Absolute path to a `.ts` file.
 * @returns The file's source text, comments removed.
 *
 * @example
 * readStripped('/repo/src/services/vault.service.ts'); // → 'export function …'
 */
function readStripped(file: string): string {
    return stripComments(fs.readFileSync(file, 'utf8'));
}

/**
 * Repo-relative path, for assertion messages that stay readable.
 *
 * @param file - Absolute path.
 * @returns The path relative to `src/`, forward-slash separated.
 *
 * @example
 * rel('/repo/src/commands/migrate.command.ts'); // → 'commands/migrate.command.ts'
 */
function rel(file: string): string {
    return path.relative(srcRoot, file).split(path.sep).join('/');
}

/**
 * The four patterns, each with the assertion message it fails under.
 *
 * P1 — message APIs. P2 — option-object keys. P3 — property assignment, which
 * matches neither of the first two because the QuickPick property is
 * `placeholder` while the options key is `placeHolder`. P4 — this project's
 * own IO shim, which routes 23 of T5.1's strings past P1 entirely.
 *
 * `(?!\$)` in P2/P3 excludes `$(codicon) ${runtime}` template values, which
 * must **not** be wrapped — six of them live in `src/ui`
 * (`varsetPicker.panel.ts`, `destFolderPicker.panel.ts`, `navigator.ts`,
 * `multiIndex.dest.ts`, `navigator.helpers.ts` ×2). `(?!\2)` excludes
 * empty-string data-model fields (`description: ''`), which appear in all
 * three scopes; without it P2 is unsatisfiable for every task.
 */
const PATTERNS: ReadonlyArray<{ re: RegExp; message: string }> = [
    {
        re: /show(?:Information|Error|Warning)Message\(\s*(['"`])/g,
        message: 'a message API is called with a raw string literal',
    },
    {
        re: /\b(prompt|placeHolder|title|detail|label|description)\s*:\s*(['"`])(?!\$)(?!\2)/g,
        message: 'an option-object label is a raw string literal',
    },
    {
        re: /\.(placeholder|title)\s*=\s*(['"`])(?!\$)/g,
        message: 'a QuickPick/panel property is assigned a raw string literal',
    },
    {
        re: /io\.showError\(\s*(['"`])/g,
        message: 'io.showError is called with a raw string literal',
    },
];

/**
 * Asserts every pattern finds nothing in one file, plus the spelling rule.
 *
 * The spelling assertion is not decoration: three workers writing
 * `import { l10n } from 'vscode'` would produce an **empty** bundle that
 * `l10n-bundle.test.ts`'s key-drift check then validates as
 * consistent-but-empty. The extractor scans for `vscode.l10n.t(` literally.
 *
 * @param file - Absolute path to the source file to scan.
 * @returns Nothing; throws `AssertionError` on the first violation.
 *
 * @example
 * assertLocalised('/repo/src/services/vault.service.ts');
 */
function assertLocalised(file: string): void {
    const src = readStripped(file);
    for (const { re, message } of PATTERNS) {
        const hits = [...src.matchAll(new RegExp(re.source, re.flags))];
        assert.strictEqual(hits.length, 0, `${rel(file)}: ${message} (${hits.length} site(s))`);
    }
    assert.ok(!src.includes('l10n.t(') || src.includes('vscode.l10n.t('),
        `${rel(file)}: l10n.t must be spelled vscode.l10n.t( for the extractor to see it`);
}

suite('l10n sources — src/commands', () => {
    test('every .ts under src/commands routes its user-facing strings through vscode.l10n.t', () => {
        for (const file of collectTsFiles(path.join(srcRoot, 'commands'))) {
            assertLocalised(file);
        }
    });

    // Gap 1b (plan.md §10): two vscode-free files under src/commands/ compose
    // user-facing sentences with a bare `return`, which NO pattern above
    // reaches — so T5.1's suite would be green whether or not they were
    // localised. These positive assertions are what make that half real.
    test('the three delete confirmations are localised, plural word included', () => {
        const src = readStripped(path.join(srcRoot, 'commands', 'variables.confirm.helpers.ts'));

        // Three interpolations, not one: name, count, and the plural word
        // itself. A `{0}`-only wrap yields a two-argument call that silently
        // drops pluralVariable(varCount) — English "variable(s)" inside every
        // Spanish confirmation.
        assert.match(src, /vscode\.l10n\.t\(\s*'Delete \{0\} and its \{1\} \{2\}\?/,
            'the file-delete confirmation is not localised with all three placeholders');
        assert.match(src, /vscode\.l10n\.t\(\s*'Delete sub-set \{0\} in \{1\} and its \{2\} \{3\}\?/,
            'the sub-set-delete confirmation is not localised with all four placeholders');
        assert.match(src, /vscode\.l10n\.t\(\s*'Delete variable \{0\} from sub-set \{1\}\?/,
            'the variable-delete confirmation is not localised');

        // pluralVariable picks the word INSIDE those sentences, so wrapping the
        // sentence and not the word leaves English in the Spanish output.
        assert.match(src, /vscode\.l10n\.t\(\s*'variable'\s*\)/,
            "pluralVariable's singular return is not localised");
        assert.match(src, /vscode\.l10n\.t\(\s*'variables'\s*\)/,
            "pluralVariable's plural return is not localised");
    });

    // The one POSITIONAL modal button label under src/commands. The four
    // patterns above structurally cannot see it — a positional argument is
    // indistinguishable from any other string argument — and `l10n-ui.test.ts`
    // (T5.3's) is scoped to src/ui, so without this assertion nothing pins it
    // and a later edit un-localises every delete button with no test going red.
    //
    // Equality is by REFERENCE here (`choice === deleteLabel`), so the two
    // sides cannot desync the way a re-spelled literal would. That is what the
    // hoist buys, and it is what this assertion protects: localising the label
    // alone, without the hoist, makes every delete silently do nothing in
    // Spanish.
    test('the delete modal button label is hoisted and localised (variables.command.helpers.ts)', () => {
        const src = readStripped(path.join(srcRoot, 'commands', 'variables.command.helpers.ts'));
        assert.match(src, /const deleteLabel\s*=\s*vscode\.l10n\.t\('Delete'\)/,
            'the Delete modal button label is not hoisted to a localised const');
        assert.match(src, /showWarningMessage\([^)]*\bdeleteLabel\b/,
            'showWarningMessage is not passed the hoisted deleteLabel');
        assert.match(src, /choice === deleteLabel/,
            'the choice is not compared against the same hoisted const — a literal here breaks every delete in Spanish');
    });

    test('the three unsupported-edit reasons are localised', () => {
        const src = readStripped(path.join(srcRoot, 'commands', 'create-prefill.helpers.ts'));
        assert.match(src, /vscode\.l10n\.t\(\s*'This artifact uses Obsidian comment flags/,
            'the flags reason is not localised');
        assert.match(src, /vscode\.l10n\.t\(\s*'This artifact is a template index/,
            'the index reason is not localised');
        assert.match(src, /vscode\.l10n\.t\(\s*'This artifact declares env:/,
            'the env: reason is not localised');
    });
});

/**
 * T5.2's eleven owned services, listed **literally**.
 *
 * 🔴 Never `readdirSync(servicesDir)` here. `create-index.service.ts:177`
 * carries `title: 'Index'`, a guard-visible P2 hit in a **`vscode`-free**
 * service: a directory-globbed suite would go red on a file nobody owns and
 * nobody may legally fix (adding the import would break its `vscode`-free
 * status), blocking the wave with no available action. The membership guard
 * below is the one that deliberately scans the whole directory, and its job is
 * the opposite one — detecting a service entering or leaving the set.
 */
const T52_OWNS: readonly string[] = [
    'confirm.service.ts',
    'artifact-writer.service.ts',
    'config.service.ts',
    'context.service.ts',
    'template-writer.service.ts',
    'variables-writer.service.ts',
    'temp-document.service.ts',
    'template-destination.service.ts',
    'vault.service.ts',
    'scratch-file.service.ts',
    'varset.service.ts',
];

/**
 * The nineteen services that must stay `vscode`-free, measured from the tree
 * at `146a81d` (30 services: 19 free, 11 coupled).
 *
 * Seventeen are pre-branch; `preview-target.service.ts` (W0/T0.3) and
 * `varset-form.service.ts` (W2/T2.2) bring it to nineteen.
 */
const VSCODE_FREE: readonly string[] = [
    'artifact-patcher.service.ts',
    'artifact-serializer.service.ts',
    'artifact-type-config.service.ts',
    'create-index.service.ts',
    'filename.service.ts',
    'flags.service.ts',
    'frontmatter-migration.service.ts',
    'language-map.service.ts',
    'multi-index.service.ts',
    'pane-layout.service.ts',
    'pane-width.service.ts',
    'parser.service.ts',
    'preview-mode.service.ts',
    'preview-target.service.ts',
    'render.service.ts',
    'template.service.helpers.ts',
    'template.service.ts',
    'variables-crud.service.ts',
    'varset-form.service.ts',
];

suite('l10n sources — src/services', () => {
    test('every vscode-coupled service routes its user-facing strings through vscode.l10n.t', () => {
        for (const name of T52_OWNS) {
            const file = path.join(servicesDir, name);
            assert.ok(fs.existsSync(file), `${name}: T5.2's Owns list names a service that does not exist`);
            assertLocalised(file);
        }
    });

    // The membership guard. An earlier draft derived the vscode-free list by
    // "has no `from 'vscode'`" and then asserted that same predicate — vacuous
    // by construction: a service that GAINS the import silently leaves the set
    // instead of failing. Pinning the names is what makes it a real guard.
    test('the vscode-free service set is exactly the nineteen named — localise at the caller, never here', () => {
        const derived = fs.readdirSync(servicesDir)
            .filter(f => f.endsWith('.ts') && !fs.readFileSync(path.join(servicesDir, f), 'utf8').includes("from 'vscode'"))
            .sort();
        assert.deepStrictEqual(derived, [...VSCODE_FREE].sort(),
            'a service entered or left the vscode-free set — localise at the caller, not here');
    });

    test("T5.2's eleven owned services are exactly the vscode-coupled ones", () => {
        const coupled = fs.readdirSync(servicesDir)
            .filter(f => f.endsWith('.ts') && fs.readFileSync(path.join(servicesDir, f), 'utf8').includes("from 'vscode'"))
            .sort();
        assert.deepStrictEqual(coupled, [...T52_OWNS].sort(),
            "T5.2's Owns list has drifted from the set of vscode-coupled services");
    });
});

suite('l10n sources — src/ui', () => {
    test('every .ts under src/ui routes its host-side user-facing strings through vscode.l10n.t', () => {
        for (const file of collectTsFiles(path.join(srcRoot, 'ui'))) {
            assertLocalised(file);
        }
    });
});
