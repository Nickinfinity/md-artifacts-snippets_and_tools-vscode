import * as assert from 'node:assert';
import { isIndexArtifact } from '../src/ui/panels/artifactPicker/navigator.helpers.js';
import type { ParsedFrontmatter } from '../src/types/parsed-artifact.types.js';

/** `isIndexArtifact` at its current home in the navigator. */
suite('isIndexArtifact', () => {

    const fm = (overrides: Partial<ParsedFrontmatter>): ParsedFrontmatter => ({ artifactType: 'Template', ...overrides });

    test('true for a template carrying index: true', () => {
        assert.strictEqual(isIndexArtifact(fm({ artifactType: 'Template', index: true })), true);
    });

    test('true for an agent carrying index: true', () => {
        assert.strictEqual(isIndexArtifact(fm({ artifactType: 'AIAgentsConfig', index: true })), true);
    });

    test('false for a snippet carrying index: true — a run can only write files', () => {
        assert.strictEqual(isIndexArtifact(fm({ artifactType: 'Snippet', index: true })), false);
    });

    test('false for a command carrying index: true', () => {
        assert.strictEqual(isIndexArtifact(fm({ artifactType: 'Command', index: true })), false);
    });

    test('false when index is absent', () => {
        assert.strictEqual(isIndexArtifact(fm({ artifactType: 'Template' })), false);
    });

    test('false when index is explicitly false', () => {
        assert.strictEqual(isIndexArtifact(fm({ artifactType: 'Template', index: false })), false);
    });
});
