import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderPreviewHtml } from '../src/ui/panels/artifactPicker/preview.render.js';
import { renderCodeRowsHtml } from '../src/services/render.service.js';
import { parseFromContent } from '../src/services/parser.service.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';

/**
 * Insert is hidden when there is no editor tab to insert into.
 *
 * Only editor-bound types are gated. `Command` routes to the terminal
 * (`contexts: ['terminal']`) and `Template` / `AIAgentsConfig` write a whole
 * file (`writesFile: true`, button reads "Create File") — none of them needs an
 * editor, so their button must stay visible regardless.
 *
 * `performInsert`'s clipboard fallback is gone: Copy owns that, and a button
 * that silently does something else is worse than one that is absent.
 */

function artifact(md: string, file: string): ParsedArtifactFile {
    const parsed = parseFromContent(md, file, '/v');
    assert.ok(parsed, `fixture failed to parse: ${file}`);
    return parsed;
}

function render(a: ParsedArtifactFile, insertAvailable: boolean): string {
    return renderPreviewHtml(
        a,
        renderCodeRowsHtml(a.code, a.frontmatter.language ?? 'typescript'),
        'test-nonce',
        'https://css',
        'https://csp',
        {},
        insertAvailable,
    );
}

const SNIPPET = artifact([
    '---', 'artifactType: Snippet', 'title: Demo', 'language: typescript', '---', '',
    '```typescript', 'const answer = 42;', '```', '',
].join('\n'), '/v/Snippets/demo.md');

const COMMAND = artifact([
    '---', 'artifactType: Command', 'title: Deploy', 'language: bash', '---', '',
    '```bash', 'npm run deploy', '```', '',
].join('\n'), '/v/Commands/deploy.md');

const TEMPLATE = artifact([
    '---', 'artifactType: Template', 'title: Readme', 'language: markdown', 'extension: md', '---', '',
    '```markdown', '# Title', '```', '',
].join('\n'), '/v/Templates/readme.md');

/** True when `#insertBtn` carries the `hidden` attribute in the rendered markup. */
function insertHidden(html: string): boolean {
    const tag = /<button[^>]*id="insertBtn"[^>]*>/.exec(html);
    assert.ok(tag, '#insertBtn is not rendered at all');
    return /\shidden\b/.test(tag[0]);
}

suite('preview — Insert is hidden with no editor to insert into', () => {

    test('an editor-bound artifact hides Insert when no editor is available', () => {
        assert.strictEqual(
            insertHidden(render(SNIPPET, false)), true,
            'Insert is visible with no editor open — clicking it inserts nowhere',
        );
    });

    test('the same artifact shows Insert once an editor is available', () => {
        assert.strictEqual(
            insertHidden(render(SNIPPET, true)), false,
            'Insert stayed hidden even though an editor is open',
        );
    });

    test('a terminal-bound Command keeps Insert with no editor open', () => {
        assert.strictEqual(
            insertHidden(render(COMMAND, false)), false,
            'Command routes to the terminal — gating it on an editor makes it uninsertable',
        );
    });

    test('a whole-file Template keeps its Create File button with no editor open', () => {
        assert.strictEqual(
            insertHidden(render(TEMPLATE, false)), false,
            'Template writes a file to the workspace — it never needs an editor',
        );
    });

    test('the default keeps Insert visible, so every existing call site is unchanged', () => {
        const html = renderPreviewHtml(
            SNIPPET, renderCodeRowsHtml(SNIPPET.code, 'typescript'),
            'test-nonce', 'https://css', 'https://csp', {},
        );
        assert.strictEqual(insertHidden(html), false, 'omitting the parameter changed the default');
    });

    /**
     * `#insertBtn` is a `<button>`, and `base.css:15`'s bare
     * `button { display: inline-flex }` is an **author** rule that beats the
     * UA's `[hidden] { display: none }` regardless of specificity. Without an
     * explicit override the attribute is set and the button still renders —
     * the exact bug that made `#overwriteBtn` visible for three rounds.
     */
    test('picker.css hides #insertBtn when the hidden attribute is set', () => {
        const sheet = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'ui', 'picker.css'),
            'utf8',
        );
        const rule = /#insertBtn\[hidden\]\s*\{([^}]*)\}/.exec(sheet);
        assert.ok(
            rule,
            'no #insertBtn[hidden] rule — base.css\'s bare button{display:inline-flex} '
            + 'beats the UA [hidden] rule, so Insert renders even when marked hidden',
        );
        assert.ok(
            /display:\s*none/.exec(rule![1]),
            '#insertBtn[hidden] exists but does not set display:none',
        );
    });
});
