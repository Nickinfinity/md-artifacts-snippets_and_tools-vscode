import * as assert from 'node:assert';
import {
    resolveTemplateFileName,
    resolveAgentFileName,
    resolveOutputFileName,
} from '../src/services/template.service.js';
import type { ParsedArtifactFile, ParsedBlock } from '../src/types/parsed-artifact.types.js';

/**
 * T2 — extension precedence (D3). Security-critical:
 * `frontmatterExt` and `typed` are path-injection vectors and must **throw**,
 * never be sanitised (plan §5.2). The hostile table below is the whole point.
 */

// ── resolveTemplateFileName — precedence (D3) ────────────────────────────────────

suite('resolveTemplateFileName — precedence', () => {

    test('fence language is the last resort when nothing else supplies an extension', () => {
        assert.strictEqual(
            resolveTemplateFileName({ typed: 'Button', frontmatterExt: undefined, langId: 'tsx' }),
            'Button.tsx',
        );
    });

    test('a typed name that already carries an extension wins whole', () => {
        assert.strictEqual(
            resolveTemplateFileName({ typed: 'Button.jsx', frontmatterExt: 'mjs', langId: 'tsx' }),
            'Button.jsx',
        );
    });

    test('frontmatter extension beats the fence language', () => {
        assert.strictEqual(
            resolveTemplateFileName({ typed: 'Button', frontmatterExt: '.mjs', langId: 'tsx' }),
            'Button.mjs',
        );
    });

    test('frontmatter extension is accepted with or without the leading dot', () => {
        assert.strictEqual(
            resolveTemplateFileName({ typed: 'Button', frontmatterExt: 'mjs' }),
            'Button.mjs',
        );
    });

    test('langId is normalised before extension lookup (python → py)', () => {
        assert.strictEqual(
            resolveTemplateFileName({ typed: 'script', langId: 'python' }),
            'script.py',
        );
    });

    test('falls back to fallbackBase when nothing is typed', () => {
        assert.strictEqual(
            resolveTemplateFileName({ frontmatterExt: 'mjs', fallbackBase: 'my-module' }),
            'my-module.mjs',
        );
    });

    test('a typed name with any dot-suffix wins whole (D3 — component.test stays)', () => {
        assert.strictEqual(
            resolveTemplateFileName({ typed: 'component.test', langId: 'ts' }),
            'component.test',
        );
    });

    test('interior dots in a fallback base are preserved when an extension is appended', () => {
        assert.strictEqual(
            resolveTemplateFileName({ fallbackBase: 'my.module', frontmatterExt: 'mjs' }),
            'my.module.mjs',
        );
    });
});

// ── resolveTemplateFileName — security (§5.2) ────────────────────────────────────

suite('resolveTemplateFileName — path-injection is rejected, not sanitised', () => {

    const hostile = ['../../etc/passwd', '..\\..\\win.ini', 'a/b', 'x\0.js'];

    for (const bad of hostile) {
        test(`throws when typed = ${JSON.stringify(bad)}`, () => {
            assert.throws(() => resolveTemplateFileName({ typed: bad, langId: 'ts' }));
        });

        test(`throws when frontmatterExt = ${JSON.stringify(bad)}`, () => {
            assert.throws(() => resolveTemplateFileName({ typed: 'ok', frontmatterExt: bad }));
        });
    }
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function parsedWith(blocks: ParsedBlock[]): ParsedArtifactFile {
    return {
        filePath: '/v/Templates/x.md',
        fileName: 'x',
        relativePath: 'x.md',
        frontmatter: { artifactType: 'Template' },
        code: 'x',
        vars: [],
        blocks,
    };
}

// ── resolveAgentFileName — target: is the whole filename ─────────────────────────

suite('resolveAgentFileName', () => {

    test('uses target: verbatim when it carries an extension', () => {
        assert.strictEqual(resolveAgentFileName({ target: 'CLAUDE.md' }), 'CLAUDE.md');
    });

    test('uses a dotfile target: verbatim — never appends an extension', () => {
        // The regression: routing a dotfile through the template chain produced
        // ".cursorrules.md". A target: IS the complete filename.
        assert.strictEqual(resolveAgentFileName({ target: '.cursorrules' }), '.cursorrules');
    });

    test('falls back to a .md-suffixed title when target: is absent', () => {
        assert.strictEqual(resolveAgentFileName({ target: '', fallbackBase: 'Claude reviewer' }), 'Claude reviewer.md');
        assert.strictEqual(resolveAgentFileName({ fallbackBase: 'notes.txt' }), 'notes.txt');
    });

    test('rejects a path-injection target: rather than sanitising it', () => {
        assert.throws(() => resolveAgentFileName({ target: '../../etc/passwd' }), /path separator/);
        assert.throws(() => resolveAgentFileName({ target: 'a/b.md' }), /path separator/);
    });
});

// ── resolveOutputFileName — the shared entry point both types go through ─────────

suite('resolveOutputFileName', () => {

    /** Builds a parsed file carrying only the frontmatter under test. */
    function artifactWith(frontmatter: ParsedArtifactFile['frontmatter'], fileName = 'x'): ParsedArtifactFile {
        return { ...parsedWith([]), fileName, frontmatter };
    }

    test('an agent routes to the target:-verbatim rule, not the extension chain', () => {
        // The regression this guards: dispatching an agent through the template
        // chain turns '.cursorrules' into '.cursorrules.md'.
        assert.strictEqual(
            resolveOutputFileName(artifactWith({ artifactType: 'AIAgentsConfig', target: '.cursorrules', language: 'markdown' })),
            '.cursorrules',
        );
    });

    test('a template routes to the D3 extension chain', () => {
        assert.strictEqual(
            resolveOutputFileName(artifactWith({ artifactType: 'Template', extension: 'tsx' }, 'button')),
            'button.tsx',
        );
    });

    test('both types fall back to the title before the vault file name', () => {
        assert.strictEqual(
            resolveOutputFileName(artifactWith({ artifactType: 'AIAgentsConfig', title: 'Claude reviewer' }, 'ignored')),
            'Claude reviewer.md',
        );
        assert.strictEqual(
            resolveOutputFileName(artifactWith({ artifactType: 'Template', title: 'Button', language: 'tsx' }, 'ignored')),
            'Button.tsx',
        );
    });

    test('a hostile frontmatter value throws through the dispatcher too', () => {
        assert.throws(() => resolveOutputFileName(artifactWith({ artifactType: 'AIAgentsConfig', target: '../../etc/passwd' })), /path separator/);
        assert.throws(() => resolveOutputFileName(artifactWith({ artifactType: 'Template', extension: '../x' })), /path separator/);
    });
});
