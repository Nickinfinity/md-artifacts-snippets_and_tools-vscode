import * as assert from 'node:assert';
import { makePreviewDom } from './webview-dom-harness.js';

/**
 * Proves the preview's variable-set flow survives its own `#varsSection`
 * innerHTML round-trip (diff view → Cancel → re-apply).
 *
 * The defect this guards: `PREVIEW_CLIENT_JS`'s `input` listener that clears
 * a var-set `from:` badge is delegated from `#varsSection` (which is never
 * itself replaced), not bound to `#varInputs`'s children directly (which
 * *are* replaced wholesale on every diff-view swap via `showDiffView` /
 * `restoreVarsView`, minting fresh nodes each time). A direct bind would die
 * the moment one round-trip happened.
 *
 * `test/webview-script-executes.test.ts` cannot see this: its stub returns a
 * fresh, disposable element from every `getElementById`, so it never notices
 * a listener bound to a node that later stops being "the" `#id` node.
 * `webview-dom-harness.ts` models identity and the innerHTML round-trip
 * precisely so this defect is reachable.
 *
 * T1.2 removed the `#applyVarSetBtn` / `#saveAsVarSetBtn` click wiring
 * (the trigger moved to the Variables pane — see `preview-varset-script.test.ts`),
 * so this file's own diff-view round-trip is driven directly via `dispatch`
 * instead of through a button click that no longer exists.
 */
suite('preview var-set flow survives its own innerHTML round-trip', () => {

    test('harness self-check: innerHTML replacement mints a new element identity', () => {
        const dom = makePreviewDom();
        const before = dom.el('#varInputs');
        dom.dispatch({ command: 'showVarSetDiff', html: '<button id="varSetApplyBtn"></button>' });
        dom.dispatch({ command: 'varSetCancelled' });
        assert.notStrictEqual(
            dom.el('#varInputs'), before,
            'the harness does not model identity replacement - every later assertion is decorative',
        );
    });

    test('the badge-clearing input listener still posts after a diff round-trip', () => {
        const dom = makePreviewDom();

        dom.dispatch({ command: 'showVarSetDiff', html: '<button id="varSetApplyBtn"></button>' });
        dom.dispatch({ command: 'varSetCancelled' });

        // Continuation of the exact sequence above, same dom/script instance — load-bearing.
        // Standalone (no prior diff swap) this assertion is green today: restoreVarsView
        // early-returns on savedVarsHtml === null, the badge is built off the still-live
        // original varInputs, and clearVarSource does post. It only goes red once a diff
        // swap has actually happened, which is why it must not be split into its own test.
        dom.dispatch({
            command: 'varSetApplied',
            values: { 'VK-host': 'x' },
            subSetName: 'Dev',
            varNames: ['VK-host'],
        });
        dom.fire(dom.el('[data-var="VK-host"]'), 'input');
        assert.ok(
            dom.posted.some((m) => m.command === 'clearVarSource'),
            'the input listener is bound to a detached node',
        );
    });
});
