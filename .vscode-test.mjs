import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'dist/test/**/*.test.js',
	// macOS caps unix socket paths at 103 chars. The default
	// `.vscode-test/user-data/<v>-main.sock` path overflows that under a deep
	// repo path, and the host dies with `listen EINVAL` before any test runs.
	launchArgs: ['--user-data-dir=/tmp/mda-vsct'],
});
