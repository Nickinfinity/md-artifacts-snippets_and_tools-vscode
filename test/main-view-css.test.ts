import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Guards T22's narrow-pane sheet (VSX-223).
 *
 * The file-existence check is the actual gate: it fails until
 * `src/ui/main-view.css` exists, and it is one of the sheets that makes
 * `npx vsce ls --no-dependencies | grep -E 'src/ui/.*\.(css|ttf)'` print 11
 * matched lines (W3 added `main-pane.css`, taking it from 10 — measured with
 * the tool, not derived; see CLAUDE.md's packaging check — the
 * `(css|ttf)` form is canonical: a sheet-only grep can't see a missing
 * `codicon.ttf`, which ships a pane of tofu boxes with no error).
 *
 * The colour-literal check pins the "both themes work untouched" contract —
 * every colour must route through a `var(--vscode-…)` token, never a hex
 * literal, or dark/light parity silently breaks.
 */
suite('main-view.css — narrow-pane sheet (T22, VSX-223)', () => {

    test('src/ui/main-view.css exists', () => {
        const dir = path.join(__dirname, '..', '..', 'src', 'ui');
        assert.ok(fs.readdirSync(dir).includes('main-view.css'));
    });

    test('declares no colour literal — every colour is a var(--vscode-…) token', () => {
        const sheet = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'ui', 'main-view.css'),
            'utf8',
        );
        assert.strictEqual(/#[0-9a-fA-F]{3,8}\b/.exec(sheet), null);
    });

    /**
     * T1 (VSX-235 / VSX-236 CSS half): the action row must wrap instead of
     * forcing a single stacked column, and buttons must wrap rather than
     * being squeezed to zero width. See CLAUDE.md §1 — the pane width can
     * never be read back, so no fixed pixel breakpoint is allowed either.
     */
    suite('responsive action row (T1, VSX-235)', () => {

        function readSheet(): string {
            return fs.readFileSync(
                path.join(__dirname, '..', '..', 'src', 'ui', 'main-view.css'),
                'utf8',
            );
        }

        function ruleBody(sheet: string, selector: RegExp): string {
            const match = selector.exec(sheet);
            return match ? match[1] : '';
        }

        test('.actions no longer forces an unconditional column stack', () => {
            const body = ruleBody(readSheet(), /\.actions\s*\{([^}]*)\}/);
            assert.strictEqual(/flex-direction:\s*column/.exec(body), null);
        });

        test('.btn no longer forces full width', () => {
            const body = ruleBody(readSheet(), /\.btn\s*\{([^}]*)\}/);
            assert.strictEqual(/width:\s*100%/.exec(body), null);
        });

        test('.actions wraps buttons instead of stacking them', () => {
            const body = ruleBody(readSheet(), /\.actions\s*\{([^}]*)\}/);
            assert.ok(/flex-wrap:\s*wrap/.exec(body), 'expected .actions to declare flex-wrap: wrap');
        });

        test('.btn keeps a readable per-button minimum width', () => {
            const body = ruleBody(readSheet(), /\.btn\s*\{([^}]*)\}/);
            assert.ok(/min-width:\s*\d/.exec(body), 'expected .btn to declare a numeric min-width');
        });

        test('#varsSection is height-bounded to a T2-overridable custom property and scrolls', () => {
            const body = ruleBody(readSheet(), /#varsSection\s*\{([^}]*)\}/);
            assert.ok(
                /max-height:\s*var\(--mda-vars-height,\s*[^)]+\)/.exec(body),
                'expected #varsSection max-height to read var(--mda-vars-height, <default>)',
            );
            assert.ok(/overflow-y:\s*auto/.exec(body), 'expected #varsSection to scroll on its own');
        });
    });
});
