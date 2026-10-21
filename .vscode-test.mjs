import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'dist/test/**/*.test.js',
	// macOS caps unix socket paths at 103 chars. The default
	// `.vscode-test/user-data/<v>-main.sock` path overflows that under a deep
	// repo path, and the host dies with `listen EINVAL` before any test runs.
	launchArgs: ['--user-data-dir=/tmp/mda-vsct'],
	// The engine keeps its default vault in a machine config dir. Without this the
	// test host would adopt the developer's real default vault as its session vault.
	env: { MDA_CONFIG_DIR: '/tmp/mda-vsct-cfg' },
});
