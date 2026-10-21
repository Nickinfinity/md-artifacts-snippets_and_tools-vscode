import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    engineErrorMessage, engineWarningMessage, KNOWN_ERROR_CODES, KNOWN_WARNING_CODES,
} from '../src/engine/errors.js';
import type { ClientErrorCode } from '../src/types/engine.types.js';

const codes = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../test/fixtures/engine/codes.json'), 'utf8')) as { errors: string[]; warnings: string[] };

const CLIENT: ClientErrorCode[] = [
    'client.closed', 'client.exited', 'client.incompatible', 'client.invalid_path',
    'client.not_found', 'client.protocol', 'client.timeout', 'client.unavailable',
];

/** Tests for the engine error-code localisation table. */
suite('engine errors', () => {
    test('known error codes = codes.json errors + the 8 client codes', () => {
        const all = [...KNOWN_ERROR_CODES];
        assert.deepStrictEqual(all.filter(c => !c.startsWith('client.')).sort(), [...codes.errors].sort());
        assert.deepStrictEqual(all.filter(c => c.startsWith('client.')).sort(), CLIENT);
    });

    test('known warning codes = codes.json warnings', () => {
        assert.deepStrictEqual([...KNOWN_WARNING_CODES].sort(), [...codes.warnings].sort());
    });

    test('params reach the message', () => {
        assert.ok(engineErrorMessage({ code: 'file.conflict', params: { path: 'Snippets/a.md', expected: 'x', actual: 'y' } }).includes('Snippets/a.md'));
        assert.ok(engineErrorMessage({ code: 'client.incompatible', params: { missing: 'Snippet:Snips' } }).includes('Snippet:Snips'));
        const m = engineErrorMessage({ code: 'client.incompatible', params: { engine: '9.9.9', protocol: '7.1' } });
        assert.ok(m.includes('9.9.9') && m.includes('7.1'));
        assert.ok(engineWarningMessage({ code: 'render.unknown_var', params: { line: '3', name: 'VK-x' } }).includes('VK-x'));
    });

    test('unknown code -> generic message naming it', () => {
        assert.ok(engineErrorMessage({ code: 'zzz.new', params: {} }).includes('zzz.new'));
        assert.ok(engineWarningMessage({ code: 'render.zzz', params: { line: '1' } }).includes('render.zzz'));
    });

    test('op.bad_request never shows reason', () => {
        assert.ok(!engineErrorMessage({ code: 'op.bad_request', params: { reason: 'SECRET' } }).includes('SECRET'));
    });

    test('every known code yields a non-empty message', () => {
        for (const code of KNOWN_ERROR_CODES) {
            assert.ok(engineErrorMessage({ code, params: {} }).length > 0, code);
        }
    });
});
