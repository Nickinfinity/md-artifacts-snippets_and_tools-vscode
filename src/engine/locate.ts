import * as path from 'node:path';

/** Outcome of looking for the `mda` binary. */
export type LocateResult =
	| { readonly kind: 'found'; readonly path: string }
	| { readonly kind: 'invalid-setting'; readonly path: string }
	| { readonly kind: 'not-found' };

/**
 * Finds the engine binary: a non-empty setting wins (and is never silently
 * skipped when bad), else the first absolute `PATH` entry holding `mda`.
 * Path rules follow `platform`, not the host. Relative and empty `PATH`
 * entries are ignored (cwd binary planting); win32 tries `mda.exe` only —
 * no `PATHEXT`, since `.cmd`/`.bat` cannot be spawned without a shell.
 *
 * @param opts.settingPath `mdArtifacts.engine.path`, '' when unset.
 * @param opts.envPath The `PATH` variable, if any.
 * @param opts.platform Target platform (selects win32 vs posix rules).
 * @param opts.isExecutableFile Injected filesystem check; only ever given absolute paths.
 * @returns The lookup result.
 * @example
 * locateEngine({ settingPath: '', envPath: '/usr/bin', platform: 'linux', isExecutableFile: () => true });
 * // { kind: 'found', path: '/usr/bin/mda' }
 */
export function locateEngine(opts: {
	settingPath: string; envPath: string | undefined; platform: NodeJS.Platform;
	isExecutableFile: (absPath: string) => boolean;
}): LocateResult {
	const p = opts.platform === 'win32' ? path.win32 : path.posix;
	if (opts.settingPath !== '') {
		const ok = p.isAbsolute(opts.settingPath) && opts.isExecutableFile(opts.settingPath);
		return ok ? { kind: 'found', path: opts.settingPath } : { kind: 'invalid-setting', path: opts.settingPath };
	}
	const bin = opts.platform === 'win32' ? 'mda.exe' : 'mda';
	for (const dir of (opts.envPath ?? '').split(p.delimiter)) {
		if (dir === '' || !p.isAbsolute(dir)) { continue; }
		const candidate = p.join(dir, bin);
		if (opts.isExecutableFile(candidate)) { return { kind: 'found', path: candidate }; }
	}
	return { kind: 'not-found' };
}

/**
 * The install line shown when the engine is missing (one cargo line for every OS until engine W8).
 *
 * @param _platform Reserved; the hint is currently OS-independent.
 * @returns The install command.
 * @example
 * installHint('darwin'); // 'cargo install --git ... --tag v0.13.0 mda'
 */
export function installHint(_platform: NodeJS.Platform): string {
	return 'cargo install --git https://github.com/Nickinfinity/md-artifacts-cli --tag v0.13.0 mda';
}
