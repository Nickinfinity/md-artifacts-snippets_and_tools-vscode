import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments } from './read-path-guard.test.js';

// ponytail: stripComments is not string-aware: a `'**/*.md'` opens a false block comment and a `//`
// inside a string eats its line, so a sink placed there is hidden; aliased or bracket access
// (`t['sendText']`) evades the scan. A tokenizer would close it; not worth one for a grep guard.
const srcRoot = path.resolve(__dirname, '../../src');
const SINK = 'ui/panels/artifactPicker/preview.insert.ts';

/** Recursively lists every `.ts` file under a directory. */
function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { return tsFiles(full); }
        return e.name.endsWith('.ts') ? [full] : [];
    });
}

/** Comment-stripped `src`, keyed by `src`-relative POSIX path. */
const files = tsFiles(srcRoot).map(f => ({
    rel: path.relative(srcRoot, f).split(path.sep).join('/'),
    text: stripComments(fs.readFileSync(f, 'utf8')),
}));
const sink = files.find(f => f.rel === SINK)?.text ?? '';

/** Files containing a pattern, one entry per hit. */
const hits = (re: RegExp): string[] =>
    files.flatMap(f => Array.from(f.text.matchAll(re), () => f.rel));

suite('Terminal sink guard (T7.2)', () => {
    test('scan found real files', () => {
        assert.ok(files.length > 50, `only ${files.length} src files scanned`);
        assert.ok(sink.includes('performInsert'), 'sink file not found or empty');
    });

    test('(a) exactly one .sendText( / sendSequence in src, in preview.insert.ts', () => {
        assert.deepStrictEqual(hits(/\.sendText\(|sendSequence/g), [SINK]);
    });

    test('(b) createTerminal( only inside DELIVERY_IO', () => {
        assert.deepStrictEqual(hits(/\bcreateTerminal\(/g), [SINK]);
        const start = sink.indexOf('DELIVERY_IO: DeliveryIO = {');
        assert.ok(start >= 0, 'DELIVERY_IO not found');
        const body = sink.slice(start, sink.indexOf('\n};', start));
        assert.ok(body.includes('createTerminal('), 'createTerminal( is outside DELIVERY_IO');
    });

    test('(c) performInsert refuses containsEscape before io.terminal()', () => {
        const start = sink.indexOf('export async function performInsert(');
        assert.ok(start >= 0, 'performInsert not found');
        const body = sink.slice(start, sink.indexOf('\n}\n', start));
        const refuse = body.indexOf('r.containsEscape');
        const open = body.indexOf('io.terminal()');
        assert.ok(refuse >= 0 && open >= 0, 'containsEscape check or io.terminal() missing');
        assert.ok(refuse < open, 'io.terminal() runs before the containsEscape refusal');
    });
});
