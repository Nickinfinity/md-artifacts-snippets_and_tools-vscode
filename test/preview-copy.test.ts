import * as assert from 'node:assert';
import { renderCodeRowsHtml } from '../src/services/render.service.js';
import { getAllTypes } from '../src/services/artifact-type-config.service.js';
import { renderPreviewHtml } from '../src/ui/panels/artifactPicker/preview.render.js';
import type { ArtifactType, ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of a regex in a string. */
function countMatches(html: string, pattern: RegExp): number {
    return (html.match(new RegExp(pattern.source, `g${pattern.flags.replace('g', '')}`)) ?? []).length;
}

/** Builds a minimal single-block fixture of the given type for renderPreviewHtml. */
function fixture(artifactType: ArtifactType, overrides: Partial<ParsedArtifactFile['frontmatter']> = {}): ParsedArtifactFile {
    return {
        filePath:     `/vault/X/demo.md`,
        fileName:     'demo',
        relativePath: 'demo.md',
        frontmatter:  { artifactType, title: 'Demo', ...overrides },
        code:         'console.log(<VK-msg>);',
        vars:         [{ name: 'VK-msg', defaultValue: 'hi' }],
        blocks:       [],
    };
}

function render(a: ParsedArtifactFile): string {
    const rows = renderCodeRowsHtml(a.code, a.frontmatter.language);
    return renderPreviewHtml(a, rows, 'test-nonce', 'https://css', 'https://csp', {});
}

// ── T2: Copy control — every artifact type, no gating ─────────────────────────

suite('renderPreviewHtml — Copy control', () => {

    // Derived from ARTIFACTS (getAllTypes), never hand-copied — a 7th type must
    // not silently skip this no-gating assertion (CLAUDE.md: derive-or-guard).
    const ALL_TYPES: ArtifactType[] = getAllTypes();

    for (const type of ALL_TYPES) {
        test(`Copy control renders for artifactType "${type}" — no per-type gating`, () => {
            const html = render(fixture(type));
            assert.strictEqual(
                countMatches(html, /id="copyBtn"/),
                1,
                `expected exactly one Copy control for ${type}`,
            );
        });
    }

    test('index artifact still gets a Copy control (D8/D9 — no isIndexArtifact exclusion)', () => {
        const html = render(fixture('Template', { index: true }));
        assert.strictEqual(countMatches(html, /id="copyBtn"/), 1);
    });

    test('single-block preview gets exactly one Copy button — never one per var', () => {
        const a = fixture('Snippet');
        a.vars = [
            { name: 'VK-a', defaultValue: '1' },
            { name: 'VK-b', defaultValue: '2' },
            { name: 'VK-c', defaultValue: '3' },
        ];
        const html = render(a);
        assert.strictEqual(countMatches(html, /id="copyBtn"/), 1);
    });

    test('Copy control lives inside the actions block alongside Insert', () => {
        const html = render(fixture('Snippet'));
        assert.match(html, /id="insertBtn">[^<]*<\/button>\s*<button[^>]*id="copyBtn"/);
    });

    // ── Security: hostile title/code goes through escHtml; CSP/nonce untouched ──

    test('hostile title/code — hostile chars never appear unescaped, CSP and nonce unchanged', () => {
        const hostile = `"><script>alert('x')</script>&'`;
        const a = fixture('Snippet', { title: hostile });
        a.code = hostile;
        const html = render(a);

        // The raw hostile payload must never appear verbatim in the document.
        assert.ok(!html.includes(`<script>alert('x')</script>`), 'unescaped <script> leaked into the document');
        assert.ok(!html.includes('"><script>'), 'unescaped attribute-breakout payload leaked into the document');

        // Copy control is present and unaffected by the hostile content.
        assert.strictEqual(countMatches(html, /id="copyBtn"/), 1);

        // CSP meta tag and the single script nonce are unchanged in shape.
        assert.match(html, /Content-Security-Policy"\s+content="default-src 'none'; style-src https:\/\/csp 'unsafe-inline'; script-src 'nonce-test-nonce';"/);
        assert.strictEqual(countMatches(html, /<script nonce="test-nonce">/), 1);
    });
});
