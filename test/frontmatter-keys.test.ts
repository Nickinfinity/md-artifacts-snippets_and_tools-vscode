import * as assert from 'node:assert';
import { STRING_FRONTMATTER_KEYS, parseFromContent } from '../src/services/parser.service.js';
import { FRONTMATTER_KEY_ORDER, serializeArtifact } from '../src/services/artifact-serializer.service.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';

/**
 * Drift guard for R3 — the two frontmatter key lists that must agree.
 *
 * They are deliberately NOT merged: the parser's set says "read these as plain
 * strings", the serializer's array says "emit in this order". Different
 * directions, different shapes. What binds them is that anything written must
 * be readable — otherwise a key round-trips to nothing and the data is lost on
 * the next save, silently.
 *
 * `artifactType` and `tags` are excluded because the parser handles them
 * specially: `artifactType` is validated against ARTIFACTS, `tags` is parsed
 * as a list.
 */

/** Keys the parser handles outside the plain-string path. */
const SPECIALLY_PARSED = new Set(['artifactType', 'tags']);

suite('frontmatter key lists — serializer vs parser', () => {

    test('every key the serializer emits is one the parser reads back', () => {
        for (const key of FRONTMATTER_KEY_ORDER) {
            const known = SPECIALLY_PARSED.has(key) || STRING_FRONTMATTER_KEYS.has(key);
            assert.ok(
                known,
                `serializer emits "${key}" but the parser drops it — add it to STRING_FRONTMATTER_KEYS or stop emitting it`
            );
        }
    });

    test('every plain-string key the parser reads is one the serializer can emit', () => {
        for (const key of STRING_FRONTMATTER_KEYS) {
            assert.ok(
                FRONTMATTER_KEY_ORDER.includes(key),
                `parser reads "${key}" but the serializer never emits it — the key can be read but never written`
            );
        }
    });
});

/**
 * T1 — the `artifactType` key migration (D1). `type:` is no longer read at
 * all; only `artifactType:` is, and only with an exact-case match against the
 * PascalCase `ArtifactType` union — D1 rules out a case-insensitive fallback.
 */
suite('artifactType key — T1 migration', () => {

    test('FRONTMATTER_KEY_ORDER[0] is artifactType — the first emitted line', () => {
        assert.strictEqual(FRONTMATTER_KEY_ORDER[0], 'artifactType');
    });

    test('artifactType: Snippet parses to the PascalCase literal', () => {
        const parsed = parseFromContent('---\nartifactType: Snippet\n---\n\nbody\n', '/vault/Snippets/x.md', '/vault/Snippets');
        assert.strictEqual(parsed.frontmatter.artifactType, 'Snippet');
    });

    test('artifactType: snippet (wrong case) does not match — falls through to the directory-derived default', () => {
        // '/vault/Commands' derives a default of 'Command'; a case-insensitive
        // bug would wrongly accept 'snippet' as 'Snippet' instead.
        const parsed = parseFromContent('---\nartifactType: snippet\n---\n\nbody\n', '/vault/Commands/x.md', '/vault/Commands');
        assert.strictEqual(parsed.frontmatter.artifactType, 'Command');
    });

    test('a legacy `type:` key is ignored entirely — never read as artifactType', () => {
        const parsed = parseFromContent('---\ntype: Command\n---\n\nbody\n', '/vault/Snippets/x.md', '/vault/Snippets');
        assert.strictEqual(parsed.frontmatter.artifactType, 'Snippet');
    });

    test('a value outside the union never downgrades silently to a hardcoded default', () => {
        // Directory-derived default here is 'Command', not the hardcoded
        // 'Snippet' — an unrecognised value must fall through to THAT, not to
        // a literal always equal to 'Snippet'.
        const parsed = parseFromContent('---\nartifactType: NotARealType\n---\n\nbody\n', '/vault/Commands/x.md', '/vault/Commands');
        assert.strictEqual(parsed.frontmatter.artifactType, 'Command');
    });
});

/**
 * The two **read-side-only** index keys.
 *
 * They deliberately break the symmetry the suite above enforces for string keys:
 * the parser reads them, the serializer never emits them (plan D11). A guard is
 * needed because the obvious "fix" — adding them to `FRONTMATTER_KEY_ORDER` —
 * would emit keys nothing in `ArtifactFormModel` ever sets.
 */
suite('index frontmatter keys — read-side only', () => {

    const parse = (fm: string) => parseFromContent(`---\n${fm}\n---\n\nbody\n`, '/vault/Templates/i.md', '/vault/Templates').frontmatter;

    test('reads index: true and the paths inline array', () => {
        const fm = parse('artifactType: Template\nindex: true\npaths: [a/b, c]');
        assert.strictEqual(fm.index, true);
        assert.deepStrictEqual(fm.paths, ['a/b', 'c']);
    });

    test('a non-true index value is false, never truthy', () => {
        assert.strictEqual(parse('artifactType: Template\nindex: false').index, false);
        assert.strictEqual(parse('artifactType: Template\nindex: yes').index, false);
    });

    test('an absent index key stays undefined', () => {
        assert.strictEqual(parse('artifactType: Template').index, undefined);
    });

    test('the serializer never emits either key', () => {
        for (const key of ['index', 'paths']) {
            assert.ok(
                !FRONTMATTER_KEY_ORDER.includes(key),
                `"${key}" is read-side only (plan D11) — emitting these needs ArtifactFormModel plumbing first`
            );
        }
    });
});

/**
 * H7.0b — the keys the lists above certified and the emitter never wrote.
 *
 * The two suites at the top of this file compare **two lists to each other**.
 * `env` and `target` are in both, so those suites stayed green for as long as
 * `serializeFrontmatter` had no emit line for either — a guard that cannot fail
 * is decoration. These assert the **content** of a real round trip instead:
 * serialize a model carrying the key, re-parse the bytes, read the key back.
 *
 * Both were dropped on every re-serialize before this hunk, on `main`, for every
 * artifact in the vault — a pre-existing data-loss defect, not W7 scope.
 */
suite('frontmatter round trip — env and target survive serialize → parse', () => {

    const VARIABLES_DIR = '/vault/Variables';
    const AGENTS_DIR    = '/vault/AIAgentsConf';

    test('env survives a full serialize → parse round trip', () => {
        const model: ArtifactFormModel = {
            artifactType: 'Variables',
            title:        'Bundles',
            description:  '',
            tags:         [],
            env:          'production',
            blocks:       [{ heading: '', description: '', language: 'vks', code: '', vars: [{ name: 'VK-host', defaultValue: 'localhost' }] }],
        };

        const reparsed = parseFromContent(serializeArtifact(model), `${VARIABLES_DIR}/bundles.md`, VARIABLES_DIR);

        assert.strictEqual(
            reparsed.frontmatter.env,
            'production',
            'env was emitted into the frontmatter and read back — if this is undefined, serializeFrontmatter has no env line again'
        );
    });

    test('target survives a full serialize → parse round trip', () => {
        const model: ArtifactFormModel = {
            artifactType: 'AIAgentsConfig',
            title:        'Claude config',
            description:  '',
            tags:         [],
            target:       'CLAUDE.md',
            blocks:       [{ heading: '', description: '', language: 'markdown', code: 'be helpful', vars: [] }],
        };

        const reparsed = parseFromContent(serializeArtifact(model), `${AGENTS_DIR}/claude.md`, AGENTS_DIR);

        assert.strictEqual(
            reparsed.frontmatter.target,
            'CLAUDE.md',
            'target is a user-typed field that names the written file verbatim — losing it silently retargets the output'
        );
    });

    test('a Variables file with exactly one heading keeps it', () => {
        // `serializeArtifact` branches on `blocks.length > 1`, so a single-heading
        // file took the flat single-block path and the `## ` heading was deleted.
        // `extractSubSets` branches on `blocks.length > 0`, so this IS a sub-set
        // shape and the heading is content, not decoration.
        const model: ArtifactFormModel = {
            artifactType: 'Variables',
            title:        'Solo',
            description:  '',
            tags:         [],
            blocks:       [{ heading: 'Dev', description: '', language: 'vks', code: '', vars: [{ name: 'VK-host', defaultValue: 'localhost' }] }],
        };

        const reparsed = parseFromContent(serializeArtifact(model), `${VARIABLES_DIR}/solo.md`, VARIABLES_DIR);

        assert.strictEqual(reparsed.blocks.length, 1, 'the one-heading shape must re-parse as one block, not a flat file');
        assert.strictEqual(reparsed.blocks[0].heading, 'Dev', 'the sub-set heading was silently deleted on serialize');
    });

    test('a heading-less Variables file does NOT gain a heading', () => {
        // The mirror of the case above, and the reason the fix is narrow: the
        // commonest Variables file has no heading and must keep none.
        const model: ArtifactFormModel = {
            artifactType: 'Variables',
            title:        'Flat',
            description:  '',
            tags:         [],
            blocks:       [{ heading: '', description: '', language: 'vks', code: '', vars: [{ name: 'VK-host', defaultValue: 'localhost' }] }],
        };

        const serialized = serializeArtifact(model);

        assert.ok(!serialized.includes('## '), `a heading-less file gained a heading:\n${serialized}`);
    });
});
