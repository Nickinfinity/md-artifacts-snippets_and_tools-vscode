import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T4.1 — the activity-bar icon is an O+A monogram, with a Markdown (M + down-arrow)
 * badge in the bottom-right corner since the MD Artifacts rename.
 *
 * The icon is an SVG monogram and cannot be proven correct by assertion —
 * the visual verdict is the orchestrator's F5 pass. These guards only pin
 * the shape the mark needs (O, A, badge) and the security/theming
 * invariants a webview-adjacent asset must keep (no external refs, no
 * hardcoded colour, no fixed size).
 *
 * @example
 * // exactly three drawn `<path` elements: the O, the A and the badge
 */
suite('icon SVG — O+A monogram (T4.1)', () => {

    const svg = fs.readFileSync(
        path.join(__dirname, '..', '..', 'media', 'md-artifacts.svg'),
        'utf8',
    );

    // Drawn marks only — the clip path inside <defs> shapes the gap around the
    // badge and is never painted.
    const drawn = svg.replace(/<defs>[\s\S]*?<\/defs>/, '');

    test('is composed of exactly three drawn paths — the O, the A and the Markdown badge', () => {
        const pathCount = [...drawn.matchAll(/<path/g)].length;
        assert.strictEqual(pathCount, 3,
            'the O, the A and the Markdown (M + down-arrow) badge are three paths');
    });

    test('the O+A is clipped clear of the badge, never overlapping it', () => {
        assert.match(svg, /<clipPath id="badge-gap">/);
        assert.match(drawn, /clip-path="url\(#badge-gap\)"/);
    });

    test('declares the 24x24 viewBox the activity bar renders at', () => {
        assert.match(svg, /viewBox="0 0 24 24"/);
    });

    test('uses currentColor so VS Code can recolour it per theme', () => {
        assert.match(svg, /fill="currentColor"/);
    });

    test('carries no external or embedded resource reference', () => {
        assert.doesNotMatch(svg, /<image|<script|xlink:href|data:/i);
    });

    test('has no hardcoded per-path colour — theming stays on currentColor', () => {
        assert.doesNotMatch(svg, /fill="#|fill="rgb|stroke="#/);
    });

    test('carries no fixed width/height that would override the viewBox', () => {
        assert.doesNotMatch(svg, /\swidth=|\sheight=/);
    });
});
