import * as assert from 'node:assert';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';
import { treeToItems } from '../src/ui/panels/artifactPicker/navigator.helpers.js';

suite('navigator — engine tree mapping', () => {
    test('back row, dirs, then files; uri built inside the vault', () => {
        const items = treeToItems({ dirs: ['sub'], files: [{ path: 'Snippets/a.md', name: 'a', title: 'A' }] }, '', true, '/v');
        assert.deepStrictEqual(items.map(i => i.label), ['$(arrow-left)  ..', '$(folder)  sub', '$(file)  A']);
        assert.strictEqual(items[2].uri?.fsPath, '/v/Snippets/a.md');
        assert.strictEqual(items[2].relPath, 'Snippets/a.md');
    });

    test('a file listed with an error is shown with a warning icon, not hidden', () => {
        const items = treeToItems({ dirs: [], files: [{ path: 'Snippets/b.md', name: 'b', error: { code: 'io.failed' } }] }, 'Snippets', false, '/v');
        assert.strictEqual(items.length, 1);
        assert.ok(items[0].label.startsWith('$(warning)'), items[0].label);
    });

    test('hostile engine path throws instead of yielding an item', () => {
        assert.throws(() => treeToItems({ dirs: [], files: [{ path: '../x.md', name: 'x' }] }, '', false, '/v'));
        assert.throws(() => treeToItems({ dirs: ['..'], files: [] }, 'Snippets', false, '/v'));
    });

    test('a cached file keeps its vars detail row', () => {
        const parsed = { frontmatter: {}, vars: [{ name: 'VK-greeting', defaultValue: 'hi' }], blocks: [], fileName: 'a' } as unknown as ParsedArtifactFile;
        const [item] = treeToItems({ dirs: [], files: [{ path: 'Snippets/a.md', name: 'a' }] }, 'Snippets', false, '/v', rel => (rel === 'Snippets/a.md' ? parsed : undefined));
        assert.ok(item.detail?.includes('greeting=hi'), String(item.detail));
    });
});
