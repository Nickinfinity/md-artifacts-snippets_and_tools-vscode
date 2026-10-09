import * as assert from 'node:assert';
import { makeWebviewDom, type WebviewDom, type ElementStub } from './webview-dom-harness.js';
import { renderIdleHtml, buildCreateItems, buildBrowseItems, IDLE_CLIENT_JS } from '../src/ui/views/mainView.render.js';

/**
 * Behaviour tests for the idle pane's client script (T3.1, VSX Wave 3).
 *
 * Seeded from real `renderIdleHtml(...)` output (never a hand-written
 * fragment), so "the inactive list ships `hidden` server-side" is actually
 * asserted rather than merely true of the harness's own markup.
 *
 * Two different jobs from `webview-script-executes.test.ts`: that suite
 * proves the script *loads* against a permissive stub that hands back a
 * fresh element from every lookup; this one proves *behaviour* against a
 * harness with stable element identity, a real attribute/property
 * round-trip, and a recording `vscode`. Its stub is deliberately not carried
 * over here.
 */

const HTML = renderIdleHtml(buildCreateItems(), 'base.css', "'self'", 'test-nonce', buildBrowseItems());

function makeIdleDom(state?: { mode?: unknown; query?: unknown }): WebviewDom {
    return makeWebviewDom({ seedHtml: bodyOnly(HTML), script: IDLE_CLIENT_JS, state });
}

/** `IDLE_CLIENT_JS` queries `document`, which the harness parses from the whole
 * seed string — stripping everything outside `<body>` keeps the harness from
 * choking on `<head>`/`<style>`/`<script>` tags it was never built to parse. */
function bodyOnly(html: string): string {
    const m = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
    return m ? m[1] : html;
}

function setFilter(dom: WebviewDom, value: string): void {
    const input = dom.el('#idleFilter');
    if (!input) { throw new Error('idleFilter not found'); }
    input.value = value;
    dom.fire(input, 'input');
}

function clickToggle(dom: WebviewDom, mode: 'new' | 'open'): void {
    const btn = dom.el(`.idle-toggle-btn[data-mode="${mode}"]`);
    if (!btn) { throw new Error(`toggle button for ${mode} not found`); }
    dom.fire(btn, 'click');
}

/** Pinned to *visible* rows: after D-9 every create label has an identical
 * browse twin, so a lookup ignoring `hidden` would click the wrong row. */
function clickRow(dom: WebviewDom, label: string): void {
    const match = findVisibleRow(dom, label);
    if (!match) { throw new Error(`no visible row for ${label}`); }
    dom.fire(match, 'click');
}

/** Every (type, action) pair the pane renders — D-9/D-11 give New and Open the
 * same five types, so `data-type` alone never uniquely picks a row; `data-action`
 * disambiguates New from Open the same way the client script's own `wantAction`
 * check does. */
const ROW_TYPES = ['Snippet', 'AIAgentsConfig', 'Command', 'Template', 'AIPrompt'] as const;
const ROW_ACTIONS = ['createType', 'browseType'] as const;

function allRows(dom: WebviewDom): ElementStub[] {
    const out: ElementStub[] = [];
    for (const type of ROW_TYPES) {
        for (const action of ROW_ACTIONS) {
            const el = dom.el(`.create-row[data-type="${type}"][data-action="${action}"]`);
            if (el) { out.push(el); }
        }
    }
    return out;
}

function findVisibleRow(dom: WebviewDom, label: string): ElementStub | null {
    return allRows(dom).find((el) => !el.hidden && el.textContent.trim() === label) ?? null;
}

function visibleRowLabels(dom: WebviewDom): string[] {
    return allRows(dom).filter((el) => !el.hidden).map((el) => el.textContent.trim());
}

const lastPosted = (dom: WebviewDom): Record<string, unknown> | undefined => dom.posted.at(-1);

suite('mainView idle pane — client script behaviour', () => {

    test('harness matches() both ways: compound selector needs class AND attr', () => {
        const dom = makeIdleDom();
        const row = dom.el('.create-row[data-type="Snippet"]');
        assert.ok(row, '.create-row[data-type="Snippet"] must match a seeded create row');

        // Positive half: exactly five New + five Open rows carry both the class and
        // data-type — count, not a first-match lookup, so a matches() that ignores the
        // bracket clause (matching on .create-row alone) is caught by the wrong count.
        const rows = dom.all('.create-row[data-type]');
        assert.strictEqual(rows.length, 10, 'expected 10 rows carrying both .create-row and [data-type]');

        // Negative half: the Settings row (class="create-row", no data-type) must not be
        // a MEMBER of that set — checked by identity against the element itself, not by
        // reading a field off whatever `el()` happened to return first.
        const settingsRow = dom.el('#paneSettingsBtn');
        assert.ok(settingsRow, '#paneSettingsBtn must exist');
        assert.ok(!rows.includes(settingsRow!), 'compound selector matched the class-only Settings row');
    });

    test('the filter narrows the visible list to matching labels', () => {
        const dom = makeIdleDom();
        setFilter(dom, 'sn');
        assert.deepStrictEqual(visibleRowLabels(dom), ['Snippets'], 'the filter did not narrow the list');
    });

    test('a row click in Open mode posts browseType, and Variables is never offered', () => {
        const dom = makeIdleDom();
        clickToggle(dom, 'open');
        setFilter(dom, 'sn');
        clickRow(dom, 'Snippets');
        assert.deepStrictEqual(
            lastPosted(dom),
            { command: 'browseType', type: 'Snippet' },
            'a row click in Open mode did not post browseType',
        );
        // D-11 — Variables opens for edit, never from the Open list.
        const allLabels = (() => {
            const dom2 = makeIdleDom();
            clickToggle(dom2, 'open');
            return visibleRowLabels(dom2);
        })();
        assert.ok(!allLabels.includes('Variables'), 'Variables must not be offered under Open');
        assert.ok(dom.stateWrites.length > 0, 'the toggle change was never persisted');
    });

    test('the pane seeds itself from getState() on load', () => {
        const dom = makeIdleDom({ mode: 'open', query: 'sn' });
        assert.deepStrictEqual(
            visibleRowLabels(dom),
            ['Snippets'],
            'the pane did not seed itself from getState() - filter and mode were ignored on load',
        );
        assert.strictEqual(dom.el('#idleFilter')?.value, 'sn', 'the restored query never reached the input');
    });

    test('IDLE_CLIENT_JS is actually interpolated into renderIdleHtml output', () => {
        assert.ok(HTML.includes(IDLE_CLIENT_JS));
    });

    // ── Filter clear button ─────────────────────────────────────────────────
    suite('the filter clear button', () => {

        test('clicking it empties the input and restores every row of the current mode', () => {
            const dom = makeIdleDom();
            setFilter(dom, 'sn');
            // Precondition, not decoration: without it a clear button that does
            // nothing would still pass the post-click assertion below, because
            // the unfiltered list is also the full list.
            assert.deepStrictEqual(visibleRowLabels(dom), ['Snippets'], 'precondition: the filter did not narrow');

            const clearBtn = dom.el('#idleFilterClear');
            assert.ok(clearBtn, '#idleFilterClear must exist');
            dom.fire(clearBtn!, 'click');

            assert.strictEqual(dom.el('#idleFilter')?.value, '', 'the clear button did not empty the input');
            assert.deepStrictEqual(
                visibleRowLabels(dom),
                ['Snippets', 'AI Agents Config', 'Commands', 'Templates', 'AI Prompts'],
                'the clear button emptied the input without re-running the filter',
            );
        });

        test('it stays out of the way of Open mode — clearing keeps the active mode', () => {
            const dom = makeIdleDom();
            clickToggle(dom, 'open');
            setFilter(dom, 'sn');
            // Asserted, not assumed: `dom.fire(null, …)` no-ops in the harness, so
            // without this the whole test passes against a pane where nothing was
            // ever clicked — green, and incapable of failing for its own reason.
            const clearBtn = dom.el('#idleFilterClear');
            assert.ok(clearBtn, '#idleFilterClear must exist in Open mode too');
            dom.fire(clearBtn!, 'click');

            // Still Open: a clear that reset the mode would show the New rows,
            // and a row click would post createType instead of browseType.
            clickRow(dom, 'Snippets');
            assert.deepStrictEqual(
                lastPosted(dom),
                { command: 'browseType', type: 'Snippet' },
                'clearing the filter dropped the active mode back to New',
            );
        });

        test('clearing persists the emptied query, so a reload does not resurrect it', () => {
            const dom = makeIdleDom();
            setFilter(dom, 'sn');
            const clearBtn = dom.el('#idleFilterClear');
            assert.ok(clearBtn, '#idleFilterClear must exist');
            dom.fire(clearBtn!, 'click');

            const last = dom.stateWrites.at(-1) as { query?: unknown } | undefined;
            assert.strictEqual(last?.query, '', 'the cleared query was never persisted');
        });
    });

    // ── Security: hostile persisted state ───────────────────────────────────
    suite('hostile getState() payload', () => {
        test('an unrecognised persisted mode falls back to new rather than being assigned through', () => {
            const dom = makeIdleDom({ mode: 'javascript:alert(1)', query: '<script>alert(1)</script>' });
            assert.strictEqual(
                dom.el('.idle-toggle-btn[data-mode="new"]')?.classList.contains('is-active'),
                true,
                'an unrecognised persisted mode was assigned through instead of falling back to new',
            );
        });

        test('the restored query lands in the input as literal text, never through innerHTML', () => {
            const dom = makeIdleDom({ mode: 'javascript:alert(1)', query: '<script>alert(1)</script>' });
            assert.strictEqual(
                dom.el('#idleFilter')?.value,
                '<script>alert(1)</script>',
                'the restored query did not land in the input as literal text',
            );
        });

        test('a bogus persisted mode never reaches a posted message', () => {
            const dom = makeIdleDom({ mode: 'javascript:alert(1)', query: '<script>alert(1)</script>' });
            assert.ok(
                !JSON.stringify(dom.posted).includes('javascript:'),
                'a bogus persisted mode reached a posted message',
            );
        });
    });
});
