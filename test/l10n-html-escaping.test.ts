import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * W6 follow-up SEC guard: a `vscode.l10n.t(...)` result is a bundle value —
 * translator-supplied at runtime, not a developer literal — so it must never
 * land in webview HTML unescaped. Three sites did: two in
 * `settings.panel.ts`, one in `preview.render.ts`. All three escaped the
 * `{0}` *argument* but not the outer `l10n.t(...)` call itself.
 *
 * The fix shape (already correct elsewhere in this tree, e.g.
 * `preview.render.ts`'s `env`/`target` pills): keep markup OUT of the bundle
 * string, pass only text through `l10n.t`, then wrap the escaped text in tags
 * at the call site — `` `<strong>${e(vscode.l10n.t('Obsidian vault'))}</strong>` ``,
 * never `l10n.t('...{0}...', '<strong>...</strong>')`.
 *
 * This guard is a direct-interpolation scanner, not a fixed-string diff: it
 * flags every `${vscode.l10n.t(` that is not immediately wrapped by `e(` or
 * `escHtml(`, so re-introducing any of the three (or a fresh unescaped call)
 * fails it — not just the exact current text.
 */

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Strips block and line comments so the scan sees code only.
 *
 * @param source - Raw TypeScript source text.
 * @returns The source with comments blanked out.
 *
 * @example
 * stripComments("if (x) {} // was if (y) {}"); // → "if (x) {} "
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

/**
 * Finds every `${vscode.l10n.t(` template interpolation in `src` that is not
 * immediately preceded by an escaping call (`e(` or `escHtml(`), i.e. the
 * bundle value would land in HTML raw.
 *
 * @param src - Comment-stripped source text.
 * @returns One entry per offending interpolation, `{ line, snippet }`.
 *
 * @example
 * findUnescapedL10nInterpolations("`<p>${vscode.l10n.t('hi')}</p>`")
 * // → [{ line: 1, snippet: "${vscode.l10n.t('hi')" }]
 */
function findUnescapedL10nInterpolations(src: string): { line: number; snippet: string }[] {
    const offenders: { line: number; snippet: string }[] = [];
    const re = /\$\{(e|escHtml)?\(?vscode\.l10n\.t\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
        const wrapped = match[1] !== undefined;
        if (!wrapped) {
            const line = src.slice(0, match.index).split('\n').length;
            offenders.push({ line, snippet: src.slice(match.index, match.index + 80).replace(/\n/g, ' ') });
        }
    }
    return offenders;
}

/**
 * Reads a `src/`-relative file, strips comments, and returns any unescaped
 * `l10n.t` interpolations found in it.
 *
 * @param relPath - Path relative to `src/`.
 * @returns Offending interpolations, if any.
 *
 * @example
 * scan('ui/panels/settings.panel.ts')
 */
function scan(relPath: string): { line: number; snippet: string }[] {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', relPath), 'utf8'));
    return findUnescapedL10nInterpolations(src);
}

suite('l10n — bundle values never reach webview HTML unescaped', () => {
    test('settings.panel.ts wraps every l10n.t interpolation in escHtml', () => {
        const offenders = scan('ui/panels/settings.panel.ts');
        assert.deepStrictEqual(offenders, [],
            `unescaped vscode.l10n.t(...) interpolation(s) in settings.panel.ts:\n${
                offenders.map(o => `  line ${o.line}: ${o.snippet}`).join('\n')}`);
    });

    test('preview.render.ts wraps every l10n.t interpolation in e(...)', () => {
        const offenders = scan('ui/panels/artifactPicker/preview.render.ts');
        assert.deepStrictEqual(offenders, [],
            `unescaped vscode.l10n.t(...) interpolation(s) in preview.render.ts:\n${
                offenders.map(o => `  line ${o.line}: ${o.snippet}`).join('\n')}`);
    });
});

/**
 * Part 3 guard: a client-script `jsStr`-wrapped localised constant that lands
 * in HTML (an attribute or `innerHTML`) must be escaped BEFORE it is quoted
 * as a JS string literal — `jsStr(escHtml(...))`. `jsStr` alone guarantees a
 * valid JS string literal and nothing more; these client scripts then build
 * HTML by concatenation, so the value crosses a second boundary `jsStr` never
 * covered. Proven exploitable: bundle value `Bloque" onmouseover="alert(1)`
 * breaks out of a `placeholder="..."` attribute with `jsStr` alone, and is
 * contained once `escHtml` runs first.
 *
 * This is a shape scanner, not a fixed-string diff, so it catches a *new*
 * site introduced later in the same wrong shape — not just today's 10. It
 * must also stay silent on a constant that only ever reaches `.textContent`
 * or an `errors.push({ msg })` object: escaping those double-escapes and
 * renders entities literally in the UI.
 */
suite('l10n — jsStr client-script constants never reach an HTML sink unescaped', () => {
    /**
     * Finds every `const NAME = jsStr(...)` declaration in `src` and records
     * whether its argument already contains an `escHtml(` call.
     *
     * @param src - Comment-stripped source text.
     * @returns Map of constant name → "already escaped".
     *
     * @example
     * findJsStrConsts("const X_JS = jsStr(escHtml(vscode.l10n.t('Hi')));")
     * // → Map { 'X_JS' => true }
     */
    function findJsStrConsts(src: string): Map<string, boolean> {
        const out = new Map<string, boolean>();
        const re = /const\s+(\w+)\s*=\s*jsStr\(([\s\S]*?)\);/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(src)) !== null) {
            out.set(match[1], /escHtml\(/.test(match[2]));
        }
        return out;
    }

    /**
     * Finds every `${NAME}` usage of a known `jsStr` constant and classifies
     * the line it appears on as an HTML sink (attribute/`innerHTML` text) or
     * a safe sink (`.textContent`, or an `errors.push({ msg })`-style object).
     *
     * @param src - Comment-stripped source text.
     * @param constNames - Names returned by {@link findJsStrConsts}.
     * @returns One entry per usage, tagged `isSafe` / `isHtmlSink`.
     *
     * @example
     * findUsages("box.innerHTML = '<p>' + ${X_JS} + '</p>';", ['X_JS'])
     * // → [{ name: 'X_JS', line: 1, isSafe: false, isHtmlSink: true, text: '...' }]
     */
    function findUsages(
        src: string,
        constNames: string[],
    ): { name: string; line: number; isSafe: boolean; isHtmlSink: boolean; text: string }[] {
        const usages: { name: string; line: number; isSafe: boolean; isHtmlSink: boolean; text: string }[] = [];
        const lines = src.split('\n');
        lines.forEach((line, i) => {
            for (const name of constNames) {
                if (!line.includes(`\${${name}}`)) { continue; }
                const isSafe = /\.textContent\s*=|field:\s*'\w+',\s*msg:/.test(line);
                const isHtmlSink = /innerHTML|'<|">|placeholder="|aria-label="/.test(line);
                usages.push({ name, line: i + 1, isSafe, isHtmlSink, text: line.trim() });
            }
        });
        return usages;
    }

    /**
     * Scans a `src/`-relative client-script file for `jsStr` constants that
     * reach an HTML sink without an inner `escHtml(`.
     *
     * @param relPath - Path relative to `src/`.
     * @returns Offending usages, if any.
     *
     * @example
     * scanClientScript('ui/panels/artifactPicker/preview.clientJs.ts')
     */
    function scanClientScript(relPath: string): { name: string; line: number; text: string }[] {
        const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', relPath), 'utf8'));
        const consts = findJsStrConsts(src);
        const usages = findUsages(src, [...consts.keys()]);
        return usages
            .filter(u => u.isHtmlSink && !(u.isSafe && !u.isHtmlSink) && !consts.get(u.name))
            .map(({ name, line, text }) => ({ name, line, text }));
    }

    test('form.clientJs.ts escapes every jsStr constant before it reaches HTML', () => {
        const offenders = scanClientScript('ui/panels/artifactForm/form.clientJs.ts');
        assert.deepStrictEqual(offenders, [],
            `jsStr constant(s) reach HTML without escHtml in form.clientJs.ts:\n${
                offenders.map(o => `  line ${o.line} (${o.name}): ${o.text}`).join('\n')}`);
    });

    test('preview.clientJs.ts escapes every jsStr constant before it reaches HTML', () => {
        const offenders = scanClientScript('ui/panels/artifactPicker/preview.clientJs.ts');
        assert.deepStrictEqual(offenders, [],
            `jsStr constant(s) reach HTML without escHtml in preview.clientJs.ts:\n${
                offenders.map(o => `  line ${o.line} (${o.name}): ${o.text}`).join('\n')}`);
    });

    test('does not flag a constant that only reaches .textContent or an errors object', () => {
        const src = [
            "const SAFE_JS = jsStr(vscode.l10n.t('Invalid name.'));",
            'nameError.textContent = ${SAFE_JS};',
            "errors.push({ field: 'title', msg: ${SAFE_JS} });",
        ].join('\n');
        const consts = findJsStrConsts(src);
        const usages = findUsages(src, [...consts.keys()]);
        assert.ok(usages.every(u => u.isSafe), 'safe-sink usages must not be flagged as HTML sinks');
    });
});
