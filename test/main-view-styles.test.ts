import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STYLE_FILES_BY_MODE } from '../src/ui/views/mainView.provider.js';

/**
 * Pins the main pane's stylesheet arrays — **order, not membership**.
 *
 * Every rule in `main-view.css` is single-class specificity, so nothing but
 * source order decides whether the narrow-pane reflow wins over `picker.css`.
 * A membership-only assertion passes against an array that ships the sheets in
 * an order where the reflow silently does nothing, which is the failure ledger
 * #109 records: the pane was built against two sheets while the preview needs
 * six, and a green suite proved nothing because the CSS loaded fine and simply
 * had nothing to override.
 */
suite('main pane stylesheets (ORCH-7, ledger #109)', () => {

    test('preview mode loads the popup set plus main-view.css, in order', () => {
        assert.deepStrictEqual(
            [...STYLE_FILES_BY_MODE.preview],
            ['base.css', 'picker.css', 'code-block.css', 'hljs.css', 'varset.css', 'main-view.css'],
        );
    });

    test('main-view.css is last — it overrides by source order alone', () => {
        const preview = STYLE_FILES_BY_MODE.preview;
        assert.strictEqual(preview[preview.length - 1], 'main-view.css');
    });

    test('preview mode carries picker.css — without it the overrides have no base', () => {
        // main-view.css restyles .popup-body/.input-row/.actions/.btn, all of
        // which picker.css defines. Dropping it leaves the narrow-pane rules
        // overriding nothing at all.
        assert.ok(STYLE_FILES_BY_MODE.preview.includes('picker.css'));
    });

    test('idle mode carries its own three sheets — and none of preview\'s', () => {
        // The original argument still holds and is the reason this is pinned:
        // merging the two lists would drag picker.css's .btn/.actions rules over
        // a pane that already renders correctly. What changed in W3 is the
        // count, not that principle — `main-pane.css` is the idle pane's OWN
        // sheet (filter input, New/Open toggle, and the `.create-row[hidden]`
        // rule the filter depends on), so it belongs here while picker.css
        // still does not.
        //
        // This is also the only thing that loads that sheet: until it appears
        // in this array every rule in main-pane.css is dead, and
        // `main-pane-css.test.ts` cannot tell — it reads the file off disk as a
        // string, so "styled" and "never loaded" look identical to the suite.
        assert.deepStrictEqual(
            [...STYLE_FILES_BY_MODE.idle],
            ['base.css', 'codicon.css', 'main-pane.css'],
        );
        assert.ok(!STYLE_FILES_BY_MODE.idle.includes('picker.css'),
            'picker.css leaked into idle mode — its .btn/.actions rules restyle the create rows');
    });

    test('every referenced sheet exists on disk', () => {
        const dir = path.join(__dirname, '..', '..', 'src', 'ui');
        const present = fs.readdirSync(dir);
        const referenced = new Set([...STYLE_FILES_BY_MODE.idle, ...STYLE_FILES_BY_MODE.preview]);
        assert.ok(referenced.size > 0, 'sheet lists resolved to nothing');
        for (const sheet of referenced) {
            assert.ok(present.includes(sheet), `${sheet} is referenced but absent from src/ui`);
        }
    });
});
