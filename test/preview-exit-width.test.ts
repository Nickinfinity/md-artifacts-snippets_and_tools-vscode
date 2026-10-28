import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Strips block and line comments so the locators below scan code only.
 *
 * @param source - Raw TypeScript source.
 * @returns The source without comments.
 *
 * @example
 * stripComments('a // b'); // → 'a '
 */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * W-UI (e): Edit must not open the form while the width restore is still
 * stepping — `decreaseViewWidth` acts on the focused part, so the remaining
 * steps would shrink the editor group. Locator-only: `PreviewWidth` is built
 * inside the controller from `vscode.commands`, so there is no seam for a
 * behavioural test; the behaviour is proved by the F5-e click-path.
 */
suite('preview exit — width restore completes before Edit opens the form', () => {
    const src = stripComments(fs.readFileSync(
        path.resolve(__dirname, '../../src/ui/panels/artifactPicker/preview.ts'), 'utf8'));

    test('dispose() stores the restore promise', () => {
        const body = src.slice(src.indexOf('dispose(): void {'));
        const end = body.indexOf('\n    }');
        assert.ok(body.slice(0, end).includes('this.narrowed = this.width.restore()'));
    });

    test('handleFullEdit awaits this.narrowed before executing the edit command', () => {
        const start = src.indexOf('private async handleFullEdit(');
        assert.ok(start > 0, 'handleFullEdit is not async');
        const body = src.slice(start, src.indexOf('\n    }', start));
        const awaited = body.indexOf('await this.narrowed');
        assert.ok(awaited > 0, 'no await of the stored restore');
        assert.ok(awaited < body.indexOf('EDIT_ARTIFACT_COMMAND_ID'));
    });
});
