import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T4.1 — the activity-bar icon becomes an O+A monogram.
 *
 * The icon is an SVG monogram and cannot be proven correct by assertion —
 * the visual verdict is the orchestrator's F5 pass. These guards only pin
 * the shape a monogram needs (two paths) and the security/theming
 * invariants a webview-adjacent asset must keep (no external refs, no
 * hardcoded colour, no fixed size).
 *
 * @example
 * // exactly two `<path` elements: one for the O, one for the A
 */
suite('icon SVG — O+A monogram (T4.1)', () => {

    const svg = fs.readFileSync(
        path.join(__dirname, '..', '..', 'media', 'md-artifacts.svg'),
        'utf8',
    );

    test('is composed of exactly two paths — the O and the A', () => {
        const pathCount = [...svg.matchAll(/<path/g)].length;
        assert.strictEqual(pathCount, 2,
            'the O and the A are two paths; today the file is a single gem glyph');
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
