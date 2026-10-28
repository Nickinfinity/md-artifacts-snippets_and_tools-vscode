import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACTS } from '../src/types/constants.js';

/**
 * Drift guard: no per-type branching on the create path (VSX-214).
 *
 * The create path — `create-from-surface.command.ts`, the three `capture/`
 * modules, the `mainView.*` renderers, the index runner and its plan service,
 * and the create form's own HTML builder — is designed so that adding a new
 * `ARTIFACTS` entry needs no new branch here: every decision reads
 * `getEntry`/`getLanguageMode`/`getFilenameField`/`writesWholeFile` etc. from
 * `artifact-type-config.service.ts` instead of comparing `type` against a
 * literal. A `type === 'Snippet'` (or a `switch` case, or its Yoda-reversed
 * form) creeping back in is exactly the regression those services exist to
 * prevent, so it gets a source-grep test rather than a comment asserting the
 * same thing (`CLAUDE.md` — "an invariant stated in a comment is not an
 * invariant").
 *
 * Type literals are read from `ARTIFACTS` itself (never hand-copied), so a
 * new artifact type is covered automatically without touching this file.
 *
 * **Comments are stripped before matching.** Same trap the retired flag-marker
 * guard and `force-write-containment.test.ts` both hit: several files in this exact
 * set document "never a `type === 'AIPrompt'` literal" in JSDoc precisely
 * because they obey this rule, so the file most carefully explaining the
 * invariant is the guard's first false positive if comments are not removed
 * first (confirmed here — `capture/terminal.capture.ts` spells the raw pattern
 * inside its own JSDoc; a version of this guard with `stripComments` reduced
 * to a pass-through goes red on that line alone).
 *
 * ponytail: this is a regex scan, not an AST walk, so it has a real ceiling —
 * it cannot see `const S = 'Snippet'; t === S` (const indirection, incl. via
 * `switch`), a `Record<ArtifactType, …>` / object-map lookup keyed by type
 * (the one most likely to actually recur — a per-type lookup table is the
 * natural way to add a per-type fact, and it contains no comparison at all),
 * `[...].includes(t)`, `t.startsWith(...)`, a regex `.test(t)`, `Object.is`,
 * or loose `==` (which `eqeqeq` only warns on, and `eslint src` exits 0 on
 * warnings). Upgrade path if one of these actually recurs: an AST scan
 * (ts-morph or the TS compiler API) over identifier bindings and switch
 * discriminants instead of a text pattern.
 */

/**
 * Strips block and line comments so the scan sees code only.
 *
 * @param source - Raw TypeScript source text.
 * @returns The source with comments blanked out.
 *
 * @example
 * stripComments("if (type === 'Snippet') {} // was type === 'Snippet'");
 * // → "if (type === 'Snippet') {} "
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
 * collectTsFiles('/repo/src'); // → ['/repo/src/extension.ts', …]
 */
function collectTsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { return collectTsFiles(full); }
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

const srcRoot = path.resolve(__dirname, '..', '..', 'src');

/**
 * Whether a `src`-relative (forward-slash) path belongs to the create path,
 * per the scope carved out for this guard: `create-*` commands, the capture
 * trio, the `mainView.*` renderers, the index runner, its plan service, and
 * the create form's HTML builder — deliberately narrower than `commands/**`
 * + `ui/views/**`, which would sweep in the Variables CRUD path
 * (`variables.command.ts`, `variablesView.provider.ts`) that legitimately
 * switches on node *kind*, not artifact type.
 *
 * `form.html.ts` is named explicitly rather than by a directory prefix:
 * `artifactForm/` holds several files unrelated to per-type branching, and a
 * wildcard there would drag them in with no finding to show for it.
 *
 * @param relPath - Path relative to `src/`, forward-slash separated.
 * @returns `true` when `relPath` is in scope for this guard.
 *
 * @example
 * isCreatePathFile('commands/create-from-surface.command.ts'); // → true
 * @example
 * isCreatePathFile('commands/variables.command.ts'); // → false
 */
function isCreatePathFile(relPath: string): boolean {
    return (
        /^commands\/create-[^/]+\.ts$/.test(relPath) ||
        relPath.startsWith('commands/capture/') ||
        /^ui\/views\/mainView\.[^/]+\.ts$/.test(relPath) ||
        relPath === 'ui/views/createIndexRunner.ts' ||
        relPath === 'ui/panels/artifactForm/form.html.ts'
    );
}

/**
 * Every create-path file this guard scans, resolved from disk rather than
 * hand-listed — a rename or a new create-path file changes this set without
 * touching this test.
 */
const CREATE_PATH_FILES: string[] = collectTsFiles(srcRoot)
    .filter(f => isCreatePathFile(path.relative(srcRoot, f).split(path.sep).join('/')));

/**
 * Whether `filePath` is one of the two paths this guard exempts:
 * `artifact-type-config.service.ts` (the accessor layer these branches must
 * route through instead) and anything under `src/types/` (plain data, not
 * behaviour).
 *
 * @param filePath - Absolute or relative file path, any separator.
 * @returns `true` when `filePath` is exempt from the scan.
 *
 * @example
 * isExempt('/repo/src/services/artifact-type-config.service.ts'); // → true
 */
function isExempt(filePath: string): boolean {
    const normalized = filePath.split(path.sep).join('/');
    return normalized.endsWith('/artifact-type-config.service.ts') || normalized.includes('/types/');
}

/**
 * Builds the match pattern for one `ArtifactType` literal: a strict
 * comparison in either operand order, or a `switch` `case` label. Carries the
 * `g` flag so the caller can **count** occurrences, not just detect one —
 * a boolean `test()` would freeze the grandfathered debt's *existence* while
 * leaving its *count* free to grow silently (round-3 review finding: a second
 * `t === 'Template'` anywhere in `form.html.ts` was invisible to a test-only
 * guard).
 *
 * @param literal - One `ARTIFACTS[i].type` value (e.g. `'Snippet'`).
 * @returns A global regex matching any of the three shapes against `literal`.
 *
 * @example
 * "t === 'Snippet'".match(literalBranchPattern('Snippet'));   // → ["=== 'Snippet'"]
 * @example
 * "'Snippet' === t".match(literalBranchPattern('Snippet'));   // → ["'Snippet' ==="]
 * @example
 * "case 'Snippet':".match(literalBranchPattern('Snippet'));   // → ["case 'Snippet':"]
 */
function literalBranchPattern(literal: string): RegExp {
    return new RegExp(
        `(===|!==)\\s*['"\`]${literal}['"\`]` +
        `|\\bcase\\s+['"\`]${literal}['"\`]\\s*:` +
        `|['"\`]${literal}['"\`]\\s*(===|!==)`,
        'g',
    );
}

/** One `{file, literal, count}` finding — a create-path file branching on that specific type literal, and how many times. */
interface TypeLiteralViolation {
    readonly file: string;
    readonly literal: string;
    readonly count: number;
}

/**
 * Scans `files` for a bare comparison (either operand order) or a `switch`
 * `case` against one of `ARTIFACTS`'s `type` literals, after stripping
 * comments and skipping the two exempt paths.
 *
 * Reports one entry per `{file, literal}` pair carrying its match **count**,
 * rather than one per file or a plain existence flag — a file can carry two
 * distinct literals (as `form.html.ts` does today), and a *second* branch on
 * an already-grandfathered literal must still surface, or the debt grows for
 * free inside an exact-match list built to cap it. Sorted by `(file, literal)`
 * for a stable, order-independent comparison.
 *
 * @param files - Absolute paths of `.ts` files to scan.
 * @returns The violations found, sorted; `[]` when none.
 *
 * @example
 * findTypeLiteralViolations(CREATE_PATH_FILES);
 * // → [{ file: 'ui/panels/artifactForm/form.html.ts', literal: 'AIAgentsConfig', count: 1 }, …]
 */
function findTypeLiteralViolations(files: string[]): TypeLiteralViolation[] {
    const literals = ARTIFACTS.map(a => a.type);
    const violations: TypeLiteralViolation[] = [];

    for (const f of files) {
        if (isExempt(f)) { continue; }
        const stripped = stripComments(fs.readFileSync(f, 'utf8'));
        const rel = path.relative(srcRoot, f).split(path.sep).join('/');
        for (const literal of literals) {
            const count = (stripped.match(literalBranchPattern(literal)) ?? []).length;
            if (count > 0) {
                violations.push({ file: rel, literal, count });
            }
        }
    }

    return violations.sort((a, b) =>
        a.file === b.file ? a.literal.localeCompare(b.literal) : a.file.localeCompare(b.file));
}

/**
 * Pre-existing debt that predates this guard, grandfathered by exact name
 * rather than silently exempted. Both are in `buildExtensionField` /
 * `buildAgentFieldsSection` (`src/ui/panels/artifactForm/form.html.ts:172,224`),
 * gating which type-specific fields the create form renders.
 *
 * Correct fix (not done here — no human UI verification behind a close-out
 * wave change to shared form code): move the per-type field set onto the
 * `ARTIFACTS` entry's `form` config and read it through
 * `artifact-type-config.service.ts`, the way every other create-path decision
 * already does.
 *
 * This list is an exact-match target, not a ceiling: a third violation
 * anywhere in the scanned set fails the test below, and so does silently
 * fixing one of these two without deleting its row here — and, because each
 * row also pins a `count`, so does a **second** branch accreting onto either
 * already-grandfathered literal. `Template` and `AIAgentsConfig` are the two
 * whole-file artifact types, so further per-type form logic is realistically
 * more likely to pile onto these two than to appear as a brand-new literal.
 */
// Tracked as VSX-224 — the fix is to declare the per-type field sets on the
// `ARTIFACTS` entry's `form` config and delete both branches, then empty this list.
const KNOWN_VIOLATIONS: readonly TypeLiteralViolation[] = [
    { file: 'ui/panels/artifactForm/form.html.ts', literal: 'AIAgentsConfig', count: 1 },
    { file: 'ui/panels/artifactForm/form.html.ts', literal: 'Template', count: 1 },
];

suite('create path — no per-type branching (drift guard)', () => {

    test('the glob resolved to real files, not an empty, always-passing scan', () => {
        assert.ok(CREATE_PATH_FILES.length > 0, 'CREATE_PATH_FILES is empty — the discovery glob matched nothing');

        const basenames = CREATE_PATH_FILES.map(f => path.basename(f));
        for (const expected of ['create-from-surface.command.ts', 'editor.capture.ts', 'mainView.render.ts', 'form.html.ts']) {
            assert.ok(basenames.includes(expected), `expected ${expected} in CREATE_PATH_FILES, got: ${basenames.join(', ')}`);
        }
    });

    test('only the grandfathered form.html.ts branches violate — no new per-type branching', () => {
        const violations = findTypeLiteralViolations(CREATE_PATH_FILES);

        assert.deepStrictEqual(
            violations,
            KNOWN_VIOLATIONS,
            `violations changed from the grandfathered list — a new branch was added, a known one's count ` +
            `grew, or one of the known two was fixed without updating KNOWN_VIOLATIONS (or moved out of the ` +
            `scanned set). Got: ${JSON.stringify(violations)}`,
        );
    });
});
