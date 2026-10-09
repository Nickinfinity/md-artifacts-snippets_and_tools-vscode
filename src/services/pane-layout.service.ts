/**
 * Pure sizing rules for the main pane's variables section.
 *
 * `vscode`-free by design: the section height is a *fraction* of the pane,
 * never a pixel count, because `WebviewView` exposes no width/size member to
 * derive one from (see CLAUDE.md §1 for the platform survey this is built
 * on). The orchestrator wires persisted config and webview drag messages
 * through `clampVarsHeightFraction`; this module only owns the bounds and
 * the CSS value they produce.
 */

/** Default variables-section height as a fraction of the pane (one sixth). */
export const DEFAULT_VARS_HEIGHT_FRACTION = 1 / 6;

/** Smallest accepted fraction — inclusive. Below this, the section would be too small to use. */
export const MIN_VARS_HEIGHT_FRACTION = 0.05;

/** Largest accepted fraction — inclusive. Above this, the code area would be squeezed out. */
export const MAX_VARS_HEIGHT_FRACTION = 0.5;

/**
 * Validates an untrusted candidate fraction, rejecting anything outside
 * bounds to the default rather than folding it to the nearest bound.
 *
 * Despite the "clamp" name (matching the config field it validates,
 * `mdArtifacts.mainPane.variablesHeightFraction`), this does **not**
 * clamp to the nearest edge — an out-of-range number is rejected to
 * {@link DEFAULT_VARS_HEIGHT_FRACTION} wholesale, on the theory that a
 * value someone bothered to push out of bounds (or corrupt/mistyped state)
 * is more likely wrong than "close enough". `MIN_VARS_HEIGHT_FRACTION` and
 * `MAX_VARS_HEIGHT_FRACTION` are themselves **accepted** (inclusive bounds).
 * This is the validation boundary for persisted settings and webview
 * messages — both untrusted — so it never throws and never returns a value
 * outside `[MIN_VARS_HEIGHT_FRACTION, MAX_VARS_HEIGHT_FRACTION]`.
 *
 * @param raw - Candidate value of unknown provenance (config, webview message).
 * @returns `raw` unchanged when it is a finite number within bounds;
 *          otherwise {@link DEFAULT_VARS_HEIGHT_FRACTION}.
 *
 * @example
 * clampVarsHeightFraction(0.25);   // → 0.25
 * clampVarsHeightFraction(0);      // → DEFAULT_VARS_HEIGHT_FRACTION (would collapse the section)
 * clampVarsHeightFraction('0.3'); // → DEFAULT_VARS_HEIGHT_FRACTION (wrong type, untrusted input)
 */
export function clampVarsHeightFraction(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return DEFAULT_VARS_HEIGHT_FRACTION;
    }
    if (raw < MIN_VARS_HEIGHT_FRACTION || raw > MAX_VARS_HEIGHT_FRACTION) {
        return DEFAULT_VARS_HEIGHT_FRACTION;
    }
    return raw;
}

/**
 * Renders an already-clamped fraction as the CSS value for T1's height
 * custom property.
 *
 * `vh`, not `%`: the section's ancestor chain (`body` → `.popup-body` →
 * `#varsSection`, see `preview.render.ts`) declares no definite height on
 * any linked sheet, and a percentage `max-height` against an indefinite
 * containing block computes to `none` (CSS 2.1 §10.7) — the configured
 * value would silently vanish. `vh` is relative to the viewport instead, so
 * it matches T1's own fallback (`calc(100vh / 6)`) and actually applies.
 *
 * Callers must pass a fraction that already went through
 * {@link clampVarsHeightFraction} — this function does no validation of its
 * own, it only formats.
 *
 * @param fraction - A fraction already within `[MIN_VARS_HEIGHT_FRACTION, MAX_VARS_HEIGHT_FRACTION]`.
 * @returns A CSS `vh` value, e.g. `'25vh'`.
 *
 * @example
 * varsHeightCss(0.25); // → '25vh'
 */
export function varsHeightCss(fraction: number): string {
    return `${fraction * 100}vh`;
}
