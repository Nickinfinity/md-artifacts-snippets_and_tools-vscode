import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DEFAULT_VARS_HEIGHT_FRACTION,
    MIN_VARS_HEIGHT_FRACTION,
    MAX_VARS_HEIGHT_FRACTION,
    clampVarsHeightFraction,
    varsHeightCss,
} from '../src/services/pane-layout.service.js';

/**
 * Unit tests for the variables-section height rules.
 *
 * Pure service — no VS Code API. `clampVarsHeightFraction` is the untrusted-
 * input validation boundary for persisted config and webview messages: it
 * must never throw and must never return a value outside
 * `[MIN_VARS_HEIGHT_FRACTION, MAX_VARS_HEIGHT_FRACTION]`.
 */
suite('pane-layout.service', () => {

    // ── clampVarsHeightFraction ──────────────────────────────────────────────

    suite('clampVarsHeightFraction', () => {
        test('zero → default (would collapse the section to nothing)', () => {
            assert.strictEqual(clampVarsHeightFraction(0), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('in-bounds value → returned unchanged', () => {
            assert.strictEqual(clampVarsHeightFraction(0.25), 0.25);
        });

        test('min bound value → accepted as-is', () => {
            assert.strictEqual(clampVarsHeightFraction(MIN_VARS_HEIGHT_FRACTION), MIN_VARS_HEIGHT_FRACTION);
        });

        test('max bound value → accepted as-is', () => {
            assert.strictEqual(clampVarsHeightFraction(MAX_VARS_HEIGHT_FRACTION), MAX_VARS_HEIGHT_FRACTION);
        });

        test('just below min bound → rejected to default', () => {
            assert.strictEqual(
                clampVarsHeightFraction(MIN_VARS_HEIGHT_FRACTION - 0.001),
                DEFAULT_VARS_HEIGHT_FRACTION,
            );
        });

        test('just above max bound → rejected to default', () => {
            assert.strictEqual(
                clampVarsHeightFraction(MAX_VARS_HEIGHT_FRACTION + 0.001),
                DEFAULT_VARS_HEIGHT_FRACTION,
            );
        });

        test('negative number → default', () => {
            assert.strictEqual(clampVarsHeightFraction(-1), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('NaN → default', () => {
            assert.strictEqual(clampVarsHeightFraction(NaN), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('Infinity → default', () => {
            assert.strictEqual(clampVarsHeightFraction(Infinity), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('-Infinity → default', () => {
            assert.strictEqual(clampVarsHeightFraction(-Infinity), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('string → default (untrusted persisted state)', () => {
            assert.strictEqual(clampVarsHeightFraction('0.3'), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('null → default', () => {
            assert.strictEqual(clampVarsHeightFraction(null), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('undefined → default', () => {
            assert.strictEqual(clampVarsHeightFraction(undefined), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('object → default (hostile webview message payload)', () => {
            assert.strictEqual(clampVarsHeightFraction({ fraction: 0.3 }), DEFAULT_VARS_HEIGHT_FRACTION);
        });

        test('never throws on hostile input', () => {
            assert.doesNotThrow(() => clampVarsHeightFraction(Symbol('x')));
        });
    });

    // ── varsHeightCss ────────────────────────────────────────────────────────

    suite('varsHeightCss', () => {
        test('renders a clamped fraction as a vh CSS value (not %, which computes to none here)', () => {
            assert.strictEqual(varsHeightCss(0.25), '25vh');
        });

        test('renders the default fraction as a literal vh string', () => {
            // Literal, not varsHeightCss(1 / 6) — comparing the function against
            // itself is a tautology that survives a wrong unit, a dropped `* 100`,
            // or a swapped return value entirely.
            assert.strictEqual(varsHeightCss(DEFAULT_VARS_HEIGHT_FRACTION), '16.666666666666664vh');
        });
    });

    // ── package.json mirror drift guard ──────────────────────────────────────

    suite('package.json mirror', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
        ) as {
            contributes: {
                configuration: {
                    properties: Record<string, { default: number; minimum: number; maximum: number }>;
                };
            };
        };
        const mirror = pkg.contributes.configuration.properties['mdArtifacts.mainPane.variablesHeightFraction'];

        test('minimum/maximum are the exact static mirror of this service\'s bounds', () => {
            // This service is the authority; package.json is the static mirror
            // VS Code reads before activation (CLAUDE.md's single-sources-of-truth
            // rule) — bounds are plain numbers, so they must match exactly.
            assert.strictEqual(mirror.minimum, MIN_VARS_HEIGHT_FRACTION);
            assert.strictEqual(mirror.maximum, MAX_VARS_HEIGHT_FRACTION);
        });

        test('default is the same one-sixth value, within JSON\'s 4-decimal rounding', () => {
            // DEFAULT_VARS_HEIGHT_FRACTION is exactly 1/6 (0.16666...), which JSON
            // cannot spell exactly — package.json rounds it to 0.1667 for a
            // human-readable manifest default. Approximate on purpose; anything
            // tighter would fail on the rounding itself, not on real drift.
            assert.ok(
                Math.abs(mirror.default - DEFAULT_VARS_HEIGHT_FRACTION) < 0.001,
                `package.json default ${mirror.default} drifted from 1/6 by more than 0.001`,
            );
        });
    });
});

/**
 * Guards the variables-resize wiring.
 *
 * `varsHeightCss` sat with **zero callers** for the whole wave: the service was
 * green, fully unit-tested, and connected to nothing — the shape of defect this
 * repo has hit repeatedly (a slice verified against its own fake while no test
 * owned the join).
 */
suite('variables resize — wiring', () => {

    const previewSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'preview.ts'),
        'utf8',
    );
    const clientSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'preview.clientJs.ts'),
        'utf8',
    );
    const renderSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'preview.render.ts'),
        'utf8',
    );
    const sheetSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'main-view.css'),
        'utf8',
    );

    test('varsHeightCss is actually called — a pure service nothing invokes is dead code', () => {
        assert.ok(previewSource.includes('varsHeightCss('), 'nothing converts the stored fraction into CSS');
    });

    test('the drag handle is rendered and has a stylesheet rule', () => {
        assert.ok(renderSource.includes('id="varsResizeHandle"'), 'no resize handle in the preview markup');
        assert.ok(sheetSource.includes('.vars-resize-handle'), 'the handle has no styling, so it is invisible');
    });

    test('the drag posts a fraction and the extension persists it clamped', () => {
        assert.ok(clientSource.includes("command: 'varsHeightChanged'"), 'the drag never reports back');
        assert.ok(previewSource.includes("cmd === 'varsHeightChanged'"), 'nothing handles the drag message');
        assert.ok(
            previewSource.includes('setVariablesHeightFraction('),
            'the dragged height is never persisted',
        );
    });

    test('the webview never decides the bounds itself', () => {
        // The clamp is the extension's job; a second bounds check in the client
        // script would be a competing authority that silently drifts.
        assert.strictEqual(
            /MIN_VARS_HEIGHT|MAX_VARS_HEIGHT|0\.05|0\.5\b/.exec(clientSource),
            null,
            'the client script hard-codes bounds that pane-layout.service owns',
        );
    });
});
