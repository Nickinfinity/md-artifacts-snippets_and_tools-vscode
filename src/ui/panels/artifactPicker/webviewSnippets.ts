/**
 * Client-side JS text fragments shared by more than one webview panel.
 *
 * A webview `<script>` cannot `import` the TS `escHtml` / `labelForVar`
 * helpers — it runs in an isolated browser context, not the extension host —
 * so every webview that needs the same behaviour has historically hand-rolled
 * its own copy. This module holds the one shared source string instead of a
 * copy per webview.
 *
 * Concatenate the exported constant(s) INSIDE an existing outer IIFE. They
 * never call `acquireVsCodeApi()` themselves — that call is legal only once
 * per webview, and stays owned by each panel's own outer script.
 */

/**
 * Webview-side `esc` / `lbl` helpers.
 *
 * `esc` mirrors `escHtml` (`src/utils/html.ts`) — the same five characters
 * (`& < > " '`), escaped in the same order, so extension-rendered HTML and
 * webview-re-rendered HTML never disagree on what needs escaping.
 *
 * `lbl` mirrors `labelForVar` (`preview.helpers.ts`) — strips a leading
 * `VK-`, replaces every `_` with a space, lowercases the result, then
 * capitalises the first character.
 *
 * Bundled inside `CODE_BLOCK_CLIENT_JS` (`codeBlock.ts`): every consumer of
 * that constant (`preview.clientJs.ts`, `form.clientJs.ts`) already
 * concatenates it first, so `esc`/`lbl` come along for free without a second
 * inclusion — which would print the function bodies twice into the same
 * generated document.
 *
 * @example
 * const script = `${WEBVIEW_ESC_LBL_JS}\nconsole.log(esc('<x>'), lbl('VK-api_key'));`
 * // → defines esc() and lbl() in the enclosing scope
 */
export const WEBVIEW_ESC_LBL_JS = /* javascript */`
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function lbl(name) {
    const hint = name.indexOf('VK-') === 0 ? name.slice(3) : name;
    const j    = hint.split('_').join(' ').toLowerCase();
    return j.charAt(0).toUpperCase() + j.slice(1);
  }
`;

/**
 * Escape a value for use as a **string literal inside a client script**.
 *
 * `escHtml` is the wrong tool here and the boundary between them is where the
 * defect would be: inside a `<script>` the HTML entities `escHtml` produces
 * are never decoded, so `&amp;` reaches the user literally — and `escHtml`
 * does not neutralise `</script>`, which ends the element regardless of the
 * JavaScript syntax around it.
 *
 * Two hazards, both handled:
 *
 * - **`</`** — the HTML parser closes the `<script>` element on `</script>`
 *   without parsing JavaScript, so a closing tag inside a literal escapes the
 *   script context entirely. Rewritten as `<\/`, which is the identical string
 *   to JavaScript and invisible to the tokeniser.
 * - **`<!--`** — the script-data tokeniser reacts to a comment opener by
 *   entering script-data-escaped state, which changes how a *later*
 *   `</script>` is read. Rewritten so the opener never appears intact.
 *
 * U+2028 / U+2029 need no handling: they are legal in string literals since
 * ES2019 and the webview is Chromium.
 *
 * The returned value **includes its own surrounding quotes** — splice it in
 * bare, never inside quotes you wrote yourself.
 *
 * @param value - The text to embed. Typically a `vscode.l10n.t` result.
 * @returns A quoted JavaScript string literal, safe in script context.
 *
 * @example
 * `const label = ${jsStr(l10n.t('Off'))};`   // → const label = "Off";
 * jsStr('</script>')                          // → "<\/script>"
 */
export function jsStr(value: string): string {
    return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}
