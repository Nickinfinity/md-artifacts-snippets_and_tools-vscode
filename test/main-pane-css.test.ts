import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Guards T3.2's idle-pane sheet (Wave 3, VSX). Sourced by string, like every
 * other stylesheet guard in this repo — no test here renders a webview.
 *
 * `main-pane.css` is additive-only: `.create-row` / `.create-row-label` /
 * `.pane-section-label` / `.pane-footer` are declared exclusively in
 * `renderIdleHtml`'s inline `<style nonce>` block (`mainView.render.ts`) and
 * must stay that way for this wave — see CLAUDE.md T3.2. This suite styles
 * only the five new hooks T3.1 introduces: `#idleFilter`, `.idle-toggle`,
 * `.idle-toggle-btn[data-mode]`, `.idle-toggle-btn.is-active` and
 * `.create-row[hidden]`.
 */
suite('main-pane.css — idle pane filter/toggle sheet (T3.2)', () => {

    function readSheet(): string {
        return fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'ui', 'main-pane.css'),
            'utf8',
        );
    }

    test('targets the filter input', () => {
        assert.match(readSheet(), /#idleFilter\b/, 'no rule targets the filter input');
    });

    test('targets the toggle buttons', () => {
        assert.match(readSheet(), /\.idle-toggle-btn\b/, 'no rule targets the toggle buttons');
    });

    test('hides a filtered-out row', () => {
        assert.match(
            readSheet(),
            /\.create-row\[hidden\]/,
            'nothing hides a filtered-out row - the filter is inert',
        );
    });

    test('follows the VS Code theme', () => {
        assert.match(readSheet(), /var\(--vscode-/, 'hardcoded colours - the pane must follow the VS Code theme');
    });

    test('declares no colour literal', () => {
        // Leading `:` deliberately lets a hex fallback inside var(--x, #fff)
        // slip through — accepted ceiling, matches main-view-css.test.ts's form.
        assert.strictEqual(
            /:\s*(#[0-9a-fA-F]{3,6}\b|\b(rgb|rgba|hsl)\()/.exec(readSheet()),
            null,
            'a literal colour in a declaration value',
        );
    });
});
