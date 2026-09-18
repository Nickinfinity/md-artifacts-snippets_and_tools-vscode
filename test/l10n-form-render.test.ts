import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T6.2b guard: no hardcoded visible text remains in the form/main-view/
 * settings renderers (`form.html.ts`, `form.blocks.ts`, `form.helpers.ts`,
 * `mainView.render.ts`, `settings.panel.ts`).
 *
 * `stripComments` is load-bearing, not hygiene — several of these files carry
 * JSDoc `@example`s that spell the exact visible text being localised (e.g.
 * `form.helpers.ts`'s `labelForAddBlock`/`labelForDeleteEntire` docs), so an
 * unstripped scan would be permanently red regardless of the markup. Copied
 * verbatim from `test/create-path-dry.test.ts:55` per the established
 * pattern (`test/l10n-ui.test.ts` / `test/l10n-preview-render.test.ts`).
 *
 * Needles are the exact **raw literal syntax** (quoted attribute text or a
 * bare HTML text node, e.g. `placeholder="Artifact title"` / `>Save<`) rather
 * than the bare English words — `vscode.l10n.t('Artifact title')` legitimately
 * still contains the substring "Artifact title" as its bundle key, so a
 * plain-word needle would false-fail forever after the fix, not before it.
 */

const srcRoot = path.resolve(__dirname, '..', '..', 'src');

/**
 * Strips block and line comments so the scan sees code only.
 *
 * @param source - Raw TypeScript source text.
 * @returns The source with comments blanked out.
 *
 * @example
 * stripComments("if (x) {} // was if (y) {}");
 * // → "if (x) {} "
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

/**
 * Reads a `src/`-relative file and strips its comments.
 *
 * @param relPath - Path relative to `src/`.
 * @returns Comment-stripped source text.
 *
 * @example
 * read('ui/panels/artifactForm/form.html.ts')
 */
function read(relPath: string): string {
    return stripComments(fs.readFileSync(path.join(srcRoot, relPath), 'utf8'));
}

suite('l10n — form/main-view/settings renderers (T6.2b)', () => {
    test('form.html.ts carries no hardcoded visible text', () => {
        const src = read('ui/panels/artifactForm/form.html.ts');
        const hardcoded = [
            '>Title</label>', 'placeholder="Artifact title"',
            '>Description</label>\n  <textarea id="description"',
            'placeholder="Optional description"', '>Tags</div>',
            'placeholder="Add tag…"',
            "'extension', 'File extension'",
            '<span class="muted">(optional)</span>',
            "'target', 'Target file name'",
            "'provider', 'Provider'", "'model', 'Model'", "'version', 'Version'",
            'aria-label="Remove ${safe}"', '>Save</button>', '>Cancel</button>',
        ];
        for (const s of hardcoded) {
            assert.ok(!src.includes(s), `${s} is still hardcoded in form.html.ts`);
        }
    });

    test('form.blocks.ts carries no hardcoded visible text', () => {
        const src = read('ui/panels/artifactForm/form.blocks.ts');
        const hardcoded = [
            '>Language</label>', "'' ? 'Plain text' : val",
            'placeholder="Default value"', '>Variables</div>',
            'aria-label="Expand block in editor"', 'placeholder="Block heading"',
            'aria-label="Toggle block"', '>Description</label>',
            'placeholder="Optional block description"',
        ];
        for (const s of hardcoded) {
            assert.ok(!src.includes(s), `${s} is still hardcoded in form.blocks.ts`);
        }
    });

    test('form.helpers.ts labels are localised, not concatenated/literal English', () => {
        const src = read('ui/panels/artifactForm/form.helpers.ts');
        assert.ok(!src.includes('`+ Add additional ${'),
            'labelForAddBlock still builds its label by raw concatenation');
        assert.ok(!src.includes("return 'Delete Artifact'"),
            'labelForDeleteEntire still returns a raw literal');
        assert.match(src, /vscode\.l10n\.t\('\+ Add additional \{0\}'/,
            'labelForAddBlock is not routed through vscode.l10n.t');
        assert.match(src, /vscode\.l10n\.t\('Delete Artifact'\)/,
            'labelForDeleteEntire is not routed through vscode.l10n.t');
    });

    test('mainView.render.ts carries no hardcoded visible text', () => {
        const src = read('ui/views/mainView.render.ts');
        const hardcoded = [
            'aria-label="Filter artifact types"', 'placeholder="Filter…"',
            'aria-label="Clear filter"', 'title="Clear filter"',
            '>New</button>', '>Open</button>', '>Settings</span>',
        ];
        for (const s of hardcoded) {
            assert.ok(!src.includes(s), `${s} is still hardcoded in mainView.render.ts`);
        }
    });

    // Standing regression guard, already green on arrival per the orchestrator's
    // anchor check — W3's D-9 already dropped the `Create ` concatenation.
    test('mainView.render.ts never rebuilds a label with a "Create " concatenation', () => {
        assert.doesNotMatch(read('ui/views/mainView.render.ts'), /`Create \$\{/,
            'a label is still built by concatenation');
    });

    test('settings.panel.ts carries no hardcoded visible webview text', () => {
        const src = read('ui/panels/settings.panel.ts');
        const hardcoded = [
            '<title>Obsidian Artifacts: AI Snippets &amp; Tools - CONFIG</title>',
            '<h1>Obsidian Artifacts: AI Snippets &amp; Tools</h1>',
            '<p class="tagline">Bring your Obsidian vault into VS Code</p>',
            '>Vault Features</p>', '>Vault Location</p>',
            '<span id="folderPath">No vault selected</span>',
            '<span>Select Vault Folder</span>',
            "hint.textContent = dir.default ? '(automatically created)' : '(optional)'",
        ];
        for (const s of hardcoded) {
            assert.ok(!src.includes(s), `${s} is still hardcoded in settings.panel.ts`);
        }
    });

    test('settings.panel.ts splices the two directory-hint strings through jsStr', () => {
        const src = read('ui/panels/settings.panel.ts');
        assert.match(src, /dir\.default \? \$\{jsStr\(vscode\.l10n\.t\('\(automatically created\)'\)\)\} : \$\{jsStr\(vscode\.l10n\.t\('\(optional\)'\)\)\}/,
            'the inline <script> directory hint is not spliced through jsStr — a bad splice here ships silently ' +
            '(test/webview-script-executes.test.ts does not cover this inline script)');
    });
});
