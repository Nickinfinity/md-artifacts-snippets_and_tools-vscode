import * as assert from 'node:assert';
import { LANG_ALIAS, LANG_EXT } from '../src/types/constants.js';
import {
    extForLang,
    mapLanguageId,
    normalizeLangId,
    resolveLangId,
} from '../src/services/language-map.service.js';

/**
 * Unit tests for the language-mapping service (`language-map.service.ts`).
 *
 * `mapLanguageId` maps VS Code languageId → hljs / Obsidian fence info-string.
 * `normalizeLangId` / `resolveLangId` / `extForLang` were relocated here from
 * `artifactPicker/blockEditor.helpers.ts` (VSX-89) so the template feature can
 * reuse them outside the picker. Those assertions are the same ones that used
 * to live in `block-edit-helpers.test.ts`; they moved with the code, they were
 * not deleted. The LANG_ALIAS / LANG_EXT data-map assertions (VSX-87) came along
 * because they test the tables this service reads.
 */

// ── Table rows ────────────────────────────────────────────────────────────────

suite('mapLanguageId — initial table', () => {

    /**
     * @example
     * mapLanguageId('typescriptreact') === 'tsx'
     */
    test('typescriptreact → tsx', () => {
        assert.strictEqual(mapLanguageId('typescriptreact'), 'tsx');
    });

    test('javascriptreact → jsx', () => {
        assert.strictEqual(mapLanguageId('javascriptreact'), 'jsx');
    });

    test('shellscript → bash', () => {
        assert.strictEqual(mapLanguageId('shellscript'), 'bash');
    });

    test('dockerfile → dockerfile', () => {
        assert.strictEqual(mapLanguageId('dockerfile'), 'dockerfile');
    });

    test('objective-c → objc', () => {
        assert.strictEqual(mapLanguageId('objective-c'), 'objc');
    });

    test('objective-cpp → objcpp', () => {
        assert.strictEqual(mapLanguageId('objective-cpp'), 'objcpp');
    });
});

// ── Passthrough ───────────────────────────────────────────────────────────────

suite('mapLanguageId — passthrough', () => {

    /**
     * @example
     * mapLanguageId('javascript') === 'javascript'
     */
    test('javascript passes through unchanged', () => {
        assert.strictEqual(mapLanguageId('javascript'), 'javascript');
    });

    test('typescript passes through unchanged', () => {
        assert.strictEqual(mapLanguageId('typescript'), 'typescript');
    });

    test('python passes through unchanged', () => {
        assert.strictEqual(mapLanguageId('python'), 'python');
    });

    test('empty string passes through unchanged', () => {
        assert.strictEqual(mapLanguageId(''), '');
    });

    test('unknown id passes through unchanged', () => {
        assert.strictEqual(mapLanguageId('some-unknown-lang'), 'some-unknown-lang');
    });
});

// ── LANG_ALIAS / LANG_EXT data maps (VSX-87) ────────────────────────────────────

suite('LANG_ALIAS / LANG_EXT maps', () => {

    test('LANG_ALIAS resolves common shorthands to canonical languageIds', () => {
        assert.strictEqual(LANG_ALIAS['js'], 'javascript');
        assert.strictEqual(LANG_ALIAS['ts'], 'typescript');
        assert.strictEqual(LANG_ALIAS['py'], 'python');
        assert.strictEqual(LANG_ALIAS['sh'], 'shellscript');
        assert.strictEqual(LANG_ALIAS['bash'], 'shellscript');
        assert.strictEqual(LANG_ALIAS['c#'], 'csharp');
        assert.strictEqual(LANG_ALIAS['c++'], 'cpp');
        assert.strictEqual(LANG_ALIAS['yml'], 'yaml');
    });

    test('every LANG_ALIAS value is a non-empty lowercase string', () => {
        for (const [key, value] of Object.entries(LANG_ALIAS)) {
            assert.ok(value.length > 0, `alias ${key} maps to empty string`);
            assert.strictEqual(value, value.toLowerCase(), `alias value ${value} not lowercase`);
        }
    });

    test('no LANG_ALIAS entry maps a key to itself (would be a redundant alias)', () => {
        for (const [key, value] of Object.entries(LANG_ALIAS)) {
            assert.notStrictEqual(key, value, `alias ${key} maps to itself`);
        }
    });

    test('LANG_EXT maps canonical ids to bare extensions (no leading dot)', () => {
        assert.strictEqual(LANG_EXT['javascript'], 'js');
        assert.strictEqual(LANG_EXT['typescript'], 'ts');
        assert.strictEqual(LANG_EXT['python'], 'py');
        assert.strictEqual(LANG_EXT['csharp'], 'cs');
        assert.strictEqual(LANG_EXT['shellscript'], 'sh');
        assert.strictEqual(LANG_EXT['plaintext'], 'txt');
    });

    test('no LANG_EXT value contains a leading dot', () => {
        for (const [id, ext] of Object.entries(LANG_EXT)) {
            assert.ok(!ext.startsWith('.'), `ext for ${id} has a leading dot: ${ext}`);
        }
    });
});

// ── normalizeLangId (VSX-89, relocated) ─────────────────────────────────────────

suite('normalizeLangId', () => {

    test('lowercases an already-valid id', () => {
        assert.strictEqual(normalizeLangId('Python'), 'python');
    });

    test('resolves an uppercase shorthand via the alias map', () => {
        assert.strictEqual(normalizeLangId('JS'), 'javascript');
    });

    test('passes a valid id straight through', () => {
        assert.strictEqual(normalizeLangId('javascript'), 'javascript');
    });

    test('lowercases an unknown id with no alias', () => {
        assert.strictEqual(normalizeLangId('Zig'), 'zig');
    });
});

// ── resolveLangId (VSX-89, relocated) ───────────────────────────────────────────

suite('resolveLangId', () => {

    const known = ['javascript', 'typescript', 'python', 'json', 'plaintext'];

    test('prefers a real fence language, normalising shorthand', () => {
        assert.strictEqual(resolveLangId('js', undefined, known), 'javascript');
    });

    test('ignores the generic "code" fence and falls back to frontmatter', () => {
        assert.strictEqual(resolveLangId('code', 'python', known), 'python');
    });

    test('uses frontmatter when fence language is empty', () => {
        assert.strictEqual(resolveLangId('', 'typescript', known), 'typescript');
    });

    test('returns plaintext when nothing resolves', () => {
        assert.strictEqual(resolveLangId(undefined, undefined, known), 'plaintext');
    });

    test('returns plaintext when the resolved id is not installed', () => {
        assert.strictEqual(resolveLangId('madeuplang', undefined, known), 'plaintext');
    });
});

// ── extForLang (VSX-89, relocated) ──────────────────────────────────────────────

suite('extForLang', () => {

    test('maps a known languageId to its mapped extension', () => {
        assert.strictEqual(extForLang('javascript'), 'js');
        assert.strictEqual(extForLang('csharp'), 'cs');
    });

    test('plaintext maps to txt', () => {
        assert.strictEqual(extForLang('plaintext'), 'txt');
    });

    test('an unmapped but filename-safe id is used verbatim as the extension', () => {
        assert.strictEqual(extForLang('zig'), 'zig');
    });

    test('an unmapped non-filename-safe id falls back to txt', () => {
        assert.strictEqual(extForLang('weird-id!'), 'txt');
    });
});
