import * as assert from 'node:assert';
import { PREVIEW_CLIENT_JS } from '../src/ui/panels/artifactPicker/preview.clientJs.js';
import { makePreviewDom } from './webview-dom-harness.js';

/**
 * Proves T1.2's two changes to `PREVIEW_CLIENT_JS`:
 *
 * 1. The var-set *trigger* moved out of the preview — the script no longer
 *    posts `pickVarSet` (Apply/Save-as buttons now live in the Variables
 *    pane).
 * 2. A new values channel exists — a debounced `varsSnapshot` post on every
 *    `[data-var]` input edit — because removing the old `pickVarSet` /
 *    `saveAsVarSet` payload deleted the only way the host learned what the
 *    user typed.
 *
 * The diff *protocol* (`showVarSetDiff` → `confirmApply`/`cancelApply`) is a
 * standing regression guard here, not a red proof: it must stay green before
 * and after, or the trigger removal took the protocol down with it.
 */
suite('preview client script — var-set trigger removed, values channel added', () => {

    test('the script no longer posts pickVarSet — the trigger moved to the Variables pane', () => {
        assert.ok(
            !PREVIEW_CLIENT_JS.includes("'pickVarSet'"),
            'the script still posts pickVarSet - the trigger did not move to the Variables pane',
        );
    });

    test('typing in a var input posts a debounced varsSnapshot with the current values', async () => {
        const dom = makePreviewDom();
        const input = dom.el('[data-var="VK-host"]');
        assert.ok(input, 'seed HTML must carry the VK-host input the harness advertises');
        input.value = 'typed';
        dom.fire(input, 'input');

        await tick(200); // past INPUT_DEBOUNCE_MS (150ms)

        const last = dom.posted.filter((m) => m.command === 'varsSnapshot').at(-1);
        assert.ok(last, 'the host has no way to learn what the user typed');
        assert.deepStrictEqual(last.values, { 'VK-host': 'typed' });
    });

    // Standing regression guard — green before and after, not a red proof.
    // The tripwire against deleting too much: the var-set *trigger* leaves,
    // the var-set *diff protocol* stays.
    test('[guard] the diff protocol still wires confirmApply after Apply Variable Set is shown', () => {
        const dom = makePreviewDom();
        dom.dispatch({ command: 'showVarSetDiff', html: '<button id="varSetApplyBtn"></button>' });
        dom.fire(dom.el('#varSetApplyBtn'), 'click');
        assert.ok(
            dom.posted.some((m) => m.command === 'confirmApply'),
            'the diff protocol was removed along with the trigger',
        );
    });
});

/** Resolves after `ms` of real time — this harness runs real timers (see `webview-dom-harness.ts`). */
function tick(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
