import hljs from 'highlight.js';
import { escHtml } from '../utils/html.js';
import type { ParsedVar } from '../types/parsed-artifact.types.js';

/**
 * Matches a `<VK-Hint>` variable token — **opening or closing form** — where
 * `Hint` starts with a letter. Both forms name the *same* variable.
 *
 * The closing form exists for markdown-native payloads (flags, §7): unfenced,
 * `<VK-repo>` is a legal HTML open tag, so Obsidian renders it as an unclosed
 * custom element that swallows every block below it. Writing
 * `<VK-repo></VK-repo>` (or a lone `</VK-repo>`) leaves nothing open, so the
 * note renders — and both spellings resolve to the one variable.
 *
 * The one owner of token syntax: the highlighter and the form's live detection
 * both read it. The webview's `vkWrap` copy (client JS cannot import) is bound
 * to this by `test/vk-closing-tag.test.ts`.
 *
 * **Carries the `/g` flag**, so it holds `lastIndex` state. Only use it with
 * `matchAll` or `replace`/`replaceAll`, which reset `lastIndex` themselves;
 * never with a bare `.test()` or `.exec()` loop.
 *
 * @example
 * 'x = <VK-host>'.replaceAll(VK_TOKEN_RE, 'v')   // → 'x = v'
 * 'x = </VK-host>'.replaceAll(VK_TOKEN_RE, 'v')  // → 'x = v'
 */
export const VK_TOKEN_RE = /<\/?VK-([A-Za-z]\w*)>/g;

/**
 * Scans raw code for `<VK-hint>` tokens and returns a deduplicated list of `ParsedVar` objects.
 *
 * A valid token must match `<VK-hint>` where `hint` starts with a letter and is followed by
 * zero or more letters, digits, or underscores. The full `VK-hint` string (without angle
 * brackets) becomes the `name` field; `defaultValue` is always `''`. Duplicate tokens
 * (same name in multiple positions) are collapsed to a single entry in first-appearance order.
 *
 * @param code - Arbitrary string, typically the content of a code block.
 * @returns Deduplicated array of `{ name, defaultValue }` objects, or `[]` when no tokens are found.
 *
 * @example
 * extractVars('curl <VK-host>/<VK-path> -H "x: <VK-host>"')
 */
export function extractVars(code: string): ParsedVar[] {
    const seen = new Set<string>();
    const vars: ParsedVar[] = [];
    for (const m of code.matchAll(VK_TOKEN_RE)) {
        const name = `VK-${m[1]}`;
        if (!seen.has(name)) {
            seen.add(name);
            vars.push({ name, defaultValue: '' });
        }
    }
    return vars;
}

/**
 * Highlights one line of source code and wraps `<VK-xxx>` tokens in
 * `<span class="vk-var">` spans applied *after* syntax highlighting.
 *
 * VK tokens are replaced with inert identifier placeholders before the hljs
 * pass so the highlighter cannot split them across its own spans.
 *
 * @param line - Single line of raw source (no `\n`).
 * @param fenceLang - Optional highlight.js language identifier.
 * @returns HTML fragment for the line content (no block wrapper).
 *
 * @example
 * renderLineHtml('const x = <VK-val>;', 'javascript')
 * // → '<span class="hljs-keyword">const</span> x = <span class="vk-var">&lt;VK-val&gt;</span>;'
 */
function renderLineHtml(line: string, fenceLang?: string): string {
    // ── Protect VK tokens before syntax highlight ────────────────────────────
    // Replace each <VK-xxx> with a plain identifier placeholder so hljs cannot
    // wrap its components in separate spans.  Placeholders use a unique index
    // and only safe identifier characters, guaranteeing they pass through hljs
    // as a single untouched text node.
    const tokenMap: [string, string][] = [];
    const safe = line.replaceAll(VK_TOKEN_RE, (match) => {
        const placeholder = `__VK${tokenMap.length}__`;
        tokenMap.push([placeholder, match]);
        return placeholder;
    });

    // ── Syntax-highlight or plain-escape ─────────────────────────────────────
    let html: string;
    if (fenceLang) {
        try {
            html = hljs.highlight(safe, { language: fenceLang }).value;
        } catch {
            html = escHtml(safe);
        }
    } else {
        html = escHtml(safe);
    }

    // ── Restore VK tokens as styled spans ────────────────────────────────────
    for (const [placeholder, original] of tokenMap) {
        const inner = original.slice(1, -1); // strip surrounding < >
        const span  = `<span class="vk-var">&lt;${inner}&gt;</span>`;
        html = html.replaceAll(placeholder, span);
    }

    return html;
}

/**
 * Renders a code string as an HTML structure with line numbers, optional
 * syntax highlighting, and `<VK-xxx>` variable token spans.
 *
 * Returns an empty string when `code` is empty so callers can skip rendering
 * the wrapper entirely.
 *
 * HTML contract:
 * ```
 * <div class="code-block-wrapper">
 *   <div class="code-line-row">
 *     <span class="line-number">1</span>
 *     <span class="code-line">…highlighted content…</span>
 *   </div>
 *   …
 * </div>
 * ```
 *
 * @param code - Raw source code string; newlines split into separate rows.
 * @param fenceLang - Optional highlight.js language identifier (e.g. `'javascript'`).
 * @returns Complete HTML fragment, or `''` for empty input.
 *
 * @example
 * renderCodeHtml('const x = <VK-val>;', 'javascript')
 * // → '<div class="code-block-wrapper"><div class="code-line-row">…</div></div>'
 */
/**
 * Renders each line of `code` as a `<div class="code-line-row">` string and
 * returns them joined — **without** the outer `<div class="code-block-wrapper">` wrapper.
 *
 * Use this when the caller supplies its own wrapper element (e.g. the editable
 * code area in the artifact preview panel).
 *
 * @param code      - Raw source code string; newlines split into separate rows.
 * @param fenceLang - Optional highlight.js language identifier.
 * @returns Concatenated row HTML, or `''` for empty input.
 *
 * @example
 * renderCodeRowsHtml('const x = 1;', 'javascript')
 * // → '<div class="code-line-row">…</div>'
 */
export function renderCodeRowsHtml(code: string, fenceLang?: string): string {
    if (!code) { return ''; }
    return code.split('\n').map((line, i) => {
        const content = renderLineHtml(line, fenceLang);
        const num     = i + 1;
        return `<div class="code-line-row"><span class="line-number" contenteditable="false">${num}</span><span class="code-content">${content}</span></div>`;
    }).join('');
}

export function renderCodeHtml(code: string, fenceLang?: string): string {
    if (!code) { return ''; }

    const rows = code.split('\n').map((line, i) => {
        const content = renderLineHtml(line, fenceLang);
        const num     = i + 1;
        // code-line-row contains the substring "code-line", so the row element
        // satisfies both the code-line-row test and the code-line count test.
        // A separate span with class="code-line" would double-count.
        return `<div class="code-line-row"><span class="line-number" contenteditable="false">${num}</span><span class="code-content">${content}</span></div>`;
    }).join('');

    return `<div class="code-block-wrapper">${rows}</div>`;
}
