import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    MAIN_PANE_KEYS,
    MAIN_PANE_SECTION_HTML,
    MAIN_PANE_SECTION_CSS,
    MAIN_PANE_CLIENT_JS,
    isMainPaneKey,
} from '../src/ui/panels/settings.panel.helpers.js';

/**
 * Guards the settings panel's Preview Pane section.
 *
 * `settings.panel.ts` is the **only** writer of the `mdArtifacts.*`
 * section, and the key it writes now arrives in a webview message — untrusted
 * input. `isMainPaneKey` is the boundary that stops the webview naming any
 * other key in the section, so it is asserted as a rejection list, not just
 * an acceptance one.
 */
suite('settings panel — Preview Pane section', () => {

    suite('isMainPaneKey — the config-write boundary', () => {

        test('accepts exactly the two keys this section owns', () => {
            for (const key of MAIN_PANE_KEYS) {
                assert.ok(isMainPaneKey(key), `${key} should be writable`);
            }
        });

        test('rejects every other settings key in the section', () => {
            // vaultPath is the damaging one: the webview could otherwise
            // repoint the vault through a number-typed settings message.
            for (const key of ['vaultPath', 'features.snippets', 'defaultEnvironment', 'mainPane', '']) {
                assert.strictEqual(isMainPaneKey(key), false, `${key} must not be writable here`);
            }
        });

        test('rejects non-string payloads without throwing', () => {
            for (const raw of [undefined, null, 42, {}, [], Symbol('x')]) {
                assert.strictEqual(isMainPaneKey(raw), false);
            }
        });
    });

    suite('the section is actually wired into the panel', () => {

        const panelSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'settings.panel.ts'),
            'utf8',
        );

        test('the markup and client script are both interpolated into the webview', () => {
            // A fragment that is exported but never interpolated renders nothing
            // and raises no error — the silent-failure shape this repo keeps
            // getting bitten by.
            assert.ok(panelSource.includes('${MAIN_PANE_SECTION_HTML}'), 'section markup never interpolated');
            assert.ok(panelSource.includes('${MAIN_PANE_CLIENT_JS}'), 'client script never interpolated');
        });

        test('both message commands the client sends have a handler', () => {
            for (const command of ['setMainPane', 'resetMainPane']) {
                assert.ok(
                    MAIN_PANE_CLIENT_JS.includes(`'${command}'`),
                    `client script never sends ${command}`,
                );
                assert.ok(
                    panelSource.includes(`message.command === '${command}'`),
                    `panel has no handler for ${command}`,
                );
            }
        });

        test('the client script does not acquire a second vscode API handle', () => {
            // acquireVsCodeApi() may be called once per webview; the panel's
            // existing script already holds the handle this fragment reuses.
            assert.strictEqual(/acquireVsCodeApi/.exec(MAIN_PANE_CLIENT_JS), null);
        });

        test('the section markup carries no colour literal', () => {
            assert.strictEqual(/#[0-9a-fA-F]{3,8}\b/.exec(MAIN_PANE_SECTION_HTML), null);
        });

        test('the section stylesheet carries no colour literal either', () => {
            assert.strictEqual(/#[0-9a-fA-F]{3,8}\b/.exec(MAIN_PANE_SECTION_CSS), null);
        });

        test('the inline <style> is nonce-matched by the CSP that governs it', () => {
            // A `<style nonce>` block under a `style-src` without that nonce is
            // dropped silently — no error, no styles, a panel that merely looks
            // unfinished. The two must be changed together, so they are asserted
            // together.
            assert.ok(
                panelSource.includes('<style nonce="${nonce}">${MAIN_PANE_SECTION_CSS}</style>'),
                'section stylesheet is not emitted as a nonce-carrying style tag',
            );
            const csp = /content="default-src 'none';[^"]*"/.exec(panelSource)?.[0] ?? '';
            assert.ok(csp.includes('script-src'), 'CSP not found in the panel source');
            const styleSrc = /style-src[^;"]*/.exec(csp)?.[0] ?? '';
            assert.ok(
                styleSrc.includes("'nonce-${nonce}'"),
                `style-src does not carry the nonce, so the inline block is blocked: ${styleSrc}`,
            );
        });
    });
});
