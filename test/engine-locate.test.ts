import * as assert from 'node:assert';
import { installHint, locateEngine } from '../src/engine/locate.js';

/** Builds an injected `isExecutableFile` that records every path it is asked about. */
function probe(executable: readonly string[]): { fn: (p: string) => boolean; calls: string[] } {
	const calls: string[] = [];
	return { calls, fn: (p: string) => { calls.push(p); return executable.includes(p); } };
}

suite('locateEngine — binary lookup', () => {

	test('PATH lookup skips relative and empty entries', () => {
		const { fn } = probe(['./mda', 'mda', '/usr/bin/mda']);
		const r = locateEngine({ settingPath: '', envPath: '.:/usr/bin', platform: 'linux', isExecutableFile: fn });
		assert.deepStrictEqual(r, { kind: 'found', path: '/usr/bin/mda' });
	});

	test('relative PATH entry is never probed', () => {
		const { fn, calls } = probe(['/usr/bin/mda']);
		locateEngine({ settingPath: '', envPath: '.::bin:/usr/bin', platform: 'linux', isExecutableFile: fn });
		assert.deepStrictEqual(calls, ['/usr/bin/mda']);
	});

	test('relative setting is invalid and never probed', () => {
		const { fn, calls } = probe(['mda', '/usr/bin/mda']);
		const r = locateEngine({ settingPath: 'mda', envPath: '/usr/bin', platform: 'linux', isExecutableFile: fn });
		assert.deepStrictEqual(r, { kind: 'invalid-setting', path: 'mda' });
		assert.deepStrictEqual(calls, []);
	});

	test('win32 tries mda.exe only, no PATHEXT', () => {
		const cmd = probe(['C:\\tools\\mda.cmd']);
		assert.deepStrictEqual(
			locateEngine({ settingPath: '', envPath: 'C:\\tools', platform: 'win32', isExecutableFile: cmd.fn }),
			{ kind: 'not-found' });
		const exe = probe(['C:\\tools\\mda.exe']);
		assert.deepStrictEqual(
			locateEngine({ settingPath: '', envPath: 'C:\\tools', platform: 'win32', isExecutableFile: exe.fn }),
			{ kind: 'found', path: 'C:\\tools\\mda.exe' });
	});

	test('bad absolute setting does not fall back to PATH', () => {
		const { fn } = probe(['/usr/bin/mda']);
		const r = locateEngine({ settingPath: '/opt/x/mda', envPath: '/usr/bin', platform: 'linux', isExecutableFile: fn });
		assert.deepStrictEqual(r, { kind: 'invalid-setting', path: '/opt/x/mda' });
	});

	test('platform picks the path module: win32 setting on a posix host, posix-style on win32', () => {
		const a = probe(['C:\\x\\mda.exe']);
		assert.deepStrictEqual(
			locateEngine({ settingPath: 'C:\\x\\mda.exe', envPath: undefined, platform: 'win32', isExecutableFile: a.fn }),
			{ kind: 'found', path: 'C:\\x\\mda.exe' });
		const b = probe([]);
		assert.strictEqual(
			locateEngine({ settingPath: 'C:\\x\\mda.exe', envPath: undefined, platform: 'linux', isExecutableFile: b.fn }).kind,
			'invalid-setting');
		assert.deepStrictEqual(b.calls, []);
	});

	test('good setting wins; undefined PATH is not-found', () => {
		const { fn } = probe(['/opt/mda']);
		assert.deepStrictEqual(
			locateEngine({ settingPath: '/opt/mda', envPath: undefined, platform: 'darwin', isExecutableFile: fn }),
			{ kind: 'found', path: '/opt/mda' });
		assert.deepStrictEqual(
			locateEngine({ settingPath: '', envPath: undefined, platform: 'darwin', isExecutableFile: fn }),
			{ kind: 'not-found' });
	});
});

suite('installHint', () => {
	test('same line on every OS and pins v0.13.0', () => {
		assert.strictEqual(installHint('darwin'), installHint('win32'));
		assert.ok(installHint('linux').includes('--tag v0.13.0'));
	});
});
