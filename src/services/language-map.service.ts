/**
 * The single home for language-identifier mapping across the extension.
 *
 * VS Code sometimes uses different identifiers than the fence info-strings that
 * hljs and Obsidian expect (e.g. `typescriptreact` vs `tsx`). This module owns
 * every direction of that mapping so all callers stay consistent:
 *  - `mapLanguageId`    — languageId → fence info-string (writing a fence)
 *  - `normalizeLangId`  — raw fence info-string → canonical languageId
 *  - `resolveLangId`    — validated languageId (fence/frontmatter → installed id)
 *  - `extForLang`       — languageId → cosmetic file extension
 *
 * The tables themselves live in `types/constants.ts` (`LANG_FENCE`, `LANG_ALIAS`,
 * `LANG_EXT`) so drift between them is visible in one file and testable from one
 * import (`test/language-consistency.test.ts`). Adding a new alias is a one-line
 * change there.
 *
 * `normalizeLangId` / `resolveLangId` / `extForLang` previously lived in
 * `artifactPicker/blockEditor.helpers.ts`; they were relocated here because the
 * template feature needs them outside the picker, and this service is where
 * language mapping belongs. They stay `vscode`-free (`resolveLangId` takes the
 * installed-id list as a parameter) so they remain unit-testable without a host.
 */

import { LANG_ALIAS, LANG_EXT, LANG_FENCE } from '../types/constants.js';

/** Fence info-strings that are not real languages — ignored by `resolveLangId`. */
const GENERIC_FENCE_LANGS = new Set(['', 'code']);

/** Matches a languageId safe to use verbatim as a file extension. */
const FILENAME_SAFE_EXT_RE = /^[a-z0-9]+$/;

// ── Exports ─────────────────────────────────────────────────────────────────────

/**
 * Converts a VS Code `languageId` to the fence info-string used in vault `.md`
 * files. Unknown ids are returned unchanged so callers never receive an empty
 * string when the id is simply not in the table.
 *
 * @param id - The VS Code `languageId` (e.g. `'typescriptreact'`).
 * @returns The fence info-string (e.g. `'tsx'`), or `id` if not mapped.
 *
 * @example
 * mapLanguageId('typescriptreact') // 'tsx'
 * mapLanguageId('javascript')      // 'javascript'
 * mapLanguageId('')                // ''
 */
export function mapLanguageId(id: string): string {
    return LANG_FENCE[id] ?? id;
}

/**
 * Normalises a raw code-fence info-string to a canonical VS Code `languageId`.
 *
 * Lowercases the input, then resolves shorthand via `LANG_ALIAS`. Does **not**
 * validate against the host's installed languages — that is `resolveLangId`'s job.
 *
 * @param raw - Raw fence info-string (e.g. `'JS'`, `'Python'`, `'c#'`).
 * @returns The aliased id when a shorthand matches, otherwise the lowercased input.
 *
 * @example
 * normalizeLangId('JS')     // → 'javascript'
 * normalizeLangId('Python') // → 'python'
 * normalizeLangId('zig')    // → 'zig'
 */
export function normalizeLangId(raw: string): string {
    const lc = raw.toLowerCase();
    return LANG_ALIAS[lc] ?? lc;
}

/**
 * Resolves the languageId to apply to the temp document.
 *
 * Priority: fence language (when "real" — not `code`/empty) → frontmatter
 * language → `'plaintext'`. A candidate is accepted only when its normalised form
 * appears in `known`.
 *
 * @param fenceLang       - Fence info-string of the block (may be `undefined`).
 * @param frontmatterLang - Frontmatter `language` value (may be `undefined`).
 * @param known           - Installed language ids (`vscode.languages.getLanguages()`).
 * @returns A validated languageId, or `'plaintext'` when nothing matches.
 *
 * @example
 * resolveLangId('js', undefined, ['javascript', 'plaintext'])  // → 'javascript'
 * resolveLangId('code', 'python', ['python', 'plaintext'])     // → 'python'
 * resolveLangId('nope', undefined, ['plaintext'])              // → 'plaintext'
 */
export function resolveLangId(
    fenceLang: string | undefined,
    frontmatterLang: string | undefined,
    known: string[],
): string {
    // ── Try each candidate in priority order ──────────────────────────────────
    for (const candidate of [fenceLang, frontmatterLang]) {
        if (candidate === undefined || GENERIC_FENCE_LANGS.has(candidate.toLowerCase())) {
            continue;
        }
        const id = normalizeLangId(candidate);
        if (known.includes(id)) {
            return id;
        }
    }
    return 'plaintext';
}

/**
 * Maps a languageId to a cosmetic file extension for the temp file name.
 *
 * Uses `LANG_EXT` first; otherwise returns the id itself when it is filename-safe
 * (`/^[a-z0-9]+$/`), else `'txt'`.
 *
 * @param langId - Canonical VS Code languageId.
 * @returns A file extension without the leading dot.
 *
 * @example
 * extForLang('javascript') // → 'js'
 * extForLang('zig')        // → 'zig'
 * extForLang('weird-id!')  // → 'txt'
 */
export function extForLang(langId: string): string {
    const mapped = LANG_EXT[langId];
    if (mapped !== undefined) {
        return mapped;
    }
    return FILENAME_SAFE_EXT_RE.test(langId) ? langId : 'txt';
}
