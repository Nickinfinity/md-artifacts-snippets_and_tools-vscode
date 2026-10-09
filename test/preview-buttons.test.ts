import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CODE_BLOCK_MIN_LINES } from '../src/types/constants.js';
import { PREVIEW_CLIENT_JS } from '../src/ui/panels/artifactPicker/preview.clientJs.js';
import { renderPreviewHtml } from '../src/ui/panels/artifactPicker/preview.render.js';
import { parseFromContent } from '../src/services/parser.service.js';
import { renderCodeRowsHtml } from '../src/services/render.service.js';

/**
 * Binds the preview's client script to the buttons the preview actually renders.
 *
 * The defect this exists for: removing the "Edit Block" button left
 * `document.getElementById('editBlockBtn').addEventListener(...)` in the client
 * script. `getElementById` answers `null`, the property access throws, and the
 * script dies **at that line** — so every listener after it is never wired.
 * Insert, Edit and Cancel all go dead at once, with no error anywhere the
 * extension can see and a suite that stays green.
 *
 * An id may only be dereferenced unguarded if the markup always renders it.
 */
/** The rendered preview document for a minimal single-block artifact. */
function renderedHtml(): string {
    const md = [
        '---',
        'artifactType: Snippet',
        'title: Demo',
        'language: typescript',
        '---',
        '',
        '```typescript',
        'const answer = 42;',
        '```',
        '',
    ].join('\n');
    const parsed = parseFromContent(md, '/v/Snippets/demo.md', '/v');
    assert.ok(parsed, 'fixture failed to parse');
    return renderPreviewHtml(
        parsed,
        renderCodeRowsHtml(parsed.code, 'typescript'),
        'test-nonce',
        'https://css',
        'https://csp',
        {},
    );
}

/** The rendered preview document for a minimal single-block artifact carrying one `<VK-xxx>` var. */
function renderedHtmlWithVars(): string {
    const md = [
        '---',
        'artifactType: Snippet',
        'title: Demo',
        'language: typescript',
        '---',
        '',
        '```typescript',
        'const host = "<VK-host>";',
        '```',
        '',
        'vars:',
        'VK-host=localhost',
        '',
    ].join('\n');
    const parsed = parseFromContent(md, '/v/Snippets/demo.md', '/v');
    assert.ok(parsed, 'fixture failed to parse');
    return renderPreviewHtml(
        parsed,
        renderCodeRowsHtml(parsed.code, 'typescript'),
        'test-nonce',
        'https://css',
        'https://csp',
        {},
    );
}


suite('preview client script ↔ rendered buttons', () => {

    test('every unguarded getElementById(...).addEventListener has a matching element', () => {
        const html = renderedHtml();
        // Unguarded means dereferenced straight off the lookup — the throwing shape.
        const pattern = /getElementById\('([^']+)'\)\s*\.addEventListener/g;
        const ids = [...PREVIEW_CLIENT_JS.matchAll(pattern)].map(m => m[1]);

        assert.ok(ids.length > 0, 'found no unguarded listeners — the pattern stopped matching, so this guard is inert');

        for (const id of ids) {
            assert.ok(
                html.includes(`id="${id}"`),
                `client script dereferences #${id} unguarded but the preview never renders it — this throws and kills every listener after it`,
            );
        }
    });

    test('the buttons the preview renders are the expected set', () => {
        const html = renderedHtml();
        for (const id of ['insertBtn', 'copyBtn', 'editBtn', 'cancelBtn']) {
            assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
        }
        assert.strictEqual(
            /id="editBlockBtn"/.exec(html),
            null,
            'Edit Block is gone from the preview — block editing lives in the artifact form now',
        );
    });

    test('the Edit button is labelled "Edit", not "Edit .md"', () => {
        assert.ok(renderedHtml().includes('id="editBtn">Edit<'));
    });

    test('the code area carries no "not saved to .md" hint label', () => {
        assert.strictEqual(/slabel-hint/.exec(renderedHtml()), null);
    });

    test('the code area min-height comes from CODE_BLOCK_MIN_LINES, not a second spelling', () => {
        // A stylesheet cannot import a constant, so the number crosses into CSS
        // as a custom property. If the sheet ever hard-codes a line count again,
        // the constant becomes decorative and changing it silently does nothing.
        assert.ok(
            renderedHtml().includes(`--mda-code-min-lines: ${CODE_BLOCK_MIN_LINES}`),
            'the rendered code area does not set the custom property from the constant',
        );
        const sheet = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'ui', 'code-block.css'),
            'utf8',
        );
        assert.ok(
            sheet.includes('var(--mda-code-min-lines'),
            'code-block.css does not read the custom property',
        );
        assert.strictEqual(
            /min-height:\s*calc\(\d/.exec(sheet),
            null,
            'code-block.css hard-codes a line count instead of reading the property',
        );
    });

    /**
     * `#overwriteBtn` ships with a `hidden` attribute, but that attribute alone
     * does NOT hide it: `base.css:15`'s bare `button { display: inline-flex }`
     * is an **author** rule and beats the UA's `[hidden] { display: none }`
     * regardless of specificity. Without an explicit override the button is
     * visible the moment a preview opens, before any edit — which is exactly
     * what was reported, and why every JS-side fix to `markStaged` changed
     * nothing: the attribute was always being set correctly.
     *
     * Same mechanism `main-pane.css`'s `.create-row[hidden]` and
     * `#idleFilterClear[hidden]` rules exist for. `.dirty-notice` needs no such
     * rule — it is a `<div>`, so the UA rule applies to it untouched.
     */
    test('code-block.css hides #overwriteBtn when the hidden attribute is set', () => {
        const sheet = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'ui', 'code-block.css'),
            'utf8',
        );
        const rule = /#overwriteBtn\[hidden\]\s*\{([^}]*)\}/.exec(sheet);
        assert.ok(
            rule,
            'no #overwriteBtn[hidden] rule — base.css\'s bare button{display:inline-flex} '
            + 'beats the UA [hidden] rule, so Overwrite is visible before any edit',
        );
        assert.ok(
            /display:\s*none/.exec(rule![1]),
            '#overwriteBtn[hidden] exists but does not set display:none',
        );
    });
});

suite('preview markup no longer carries the var-set buttons (T1.1)', () => {

    test('the Apply and Save-as var-set buttons are gone from the preview', () => {
        const html = renderedHtmlWithVars();
        assert.ok(!html.includes('applyVarSetBtn'), 'the Apply button is still in the preview markup');
        assert.ok(!html.includes('saveAsVarSetBtn'), 'the Save-as button is still in the preview markup');
    });

    test('the variable inputs and resize handle survive the button removal', () => {
        const html = renderedHtmlWithVars();
        assert.ok(html.includes('id="varInputs"'), 'the variable inputs must stay - insert reads them');
        assert.ok(html.includes('id="varsResizeHandle"'), 'the resize handle must stay (D-2)');
        assert.ok(html.includes('data-var="VK-host"'), 'per-variable inputs must still render');
    });
});

/**
 * Guards the staged-edit contract.
 *
 * The promise the UI makes is "your edits are temporary until you press
 * Overwrite". Two things can silently break it: an editing surface that writes
 * to disk anyway, or an Overwrite that writes without confirming. Both are
 * durability claims made to the user about their own vault, so both are pinned.
 */
suite('staged edits and Overwrite', () => {

    const blockEditorSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'blockEditor.ts'),
        'utf8',
    );
    const previewSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'preview.ts'),
        'utf8',
    );

    test('the expanded editor never writes to the vault itself', () => {
        // It used to patch and write the .md on every save, which made one of
        // the two editing surfaces permanent and the other not.
        assert.strictEqual(
            /fs\.writeFile/.exec(blockEditorSource),
            null,
            'the expanded block editor writes to disk — edits there would not be "temporary"',
        );
        assert.ok(
            blockEditorSource.includes('onCodeStaged'),
            'the expanded editor does not report its save back as a staged edit',
        );
    });

    test('Overwrite confirms before writing', () => {
        const at = previewSource.indexOf('private async handleOverwrite');
        assert.ok(at > 0, 'handleOverwrite missing');
        const body = previewSource.slice(at, at + 1600);
        assert.ok(body.includes('confirmModal('), 'Overwrite does not confirm');
        assert.ok(
            body.indexOf('confirmModal(') < body.indexOf('persistBlockCode('),
            'Overwrite writes before it confirms',
        );
        assert.ok(body.includes('if (!ok) { return; }'), 'a declined confirmation still writes');
    });

    test('block code is written in exactly one place', () => {
        // persistBlockCode is THE write path; a second patch+write pair is the
        // drift that leaves one route confirming and the other not.
        const helperSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'preview.helpers.ts'),
            'utf8',
        );
        assert.ok(helperSource.includes('export async function persistBlockCode'), 'persistBlockCode missing');
        assert.strictEqual(
            /patchBlockCode\(/.exec(previewSource),
            null,
            'preview.ts patches block code directly instead of going through persistBlockCode',
        );
    });

    test('both editing surfaces route through one staged-state function', () => {
        assert.ok(PREVIEW_CLIENT_JS.includes('function markStaged()'), 'no shared staged-state function');
        // Surface 1: typing in the preview's own code area (passed by reference).
        assert.ok(
            PREVIEW_CLIENT_JS.includes("addEventListener('input', markStaged)"),
            'typing in the code area does not mark the edit staged',
        );
        // Surface 2: a save coming back from the expanded editor.
        const at = PREVIEW_CLIENT_JS.indexOf("msg.command === 'codeStaged'");
        assert.ok(at > 0, 'no codeStaged handler');
        assert.ok(
            PREVIEW_CLIENT_JS.slice(at, at + 200).includes('markStaged()'),
            'a save from the expanded editor does not mark the edit staged',
        );
    });

    test('the notice sits above the code area, not below the variables', () => {
        // It warns about the code area's contents, so it belongs where the user
        // is looking when they make the edit — placing it after #varsSection put
        // it off-screen on an artifact with several variables.
        const html = renderedHtml();
        const noticeAt = html.indexOf('id="dirtyNotice"');
        const codeAt   = html.indexOf('id="codeWrapper"');
        const varsAt   = html.indexOf('id="varsSection"');
        assert.ok(noticeAt > 0 && codeAt > 0 && varsAt > 0, 'preview markup changed shape');
        assert.ok(noticeAt < codeAt, 'the notice renders below the code area');
        assert.ok(noticeAt < varsAt, 'the notice renders below the variables section');
    });

    test('the Overwrite button and notice start hidden', () => {
        const html = renderedHtml();
        assert.ok(/id="overwriteBtn"[^>]*hidden/.exec(html), 'Overwrite is visible before any edit');
        assert.ok(/id="dirtyNotice"[^>]*hidden/.exec(html), 'the temporary-changes notice shows with no edit');
    });
});
