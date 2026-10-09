import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { ParsedArtifactFile, ParsedVar } from '../src/types/parsed-artifact.types.js';
import {
    VALUE_TRUNCATE_LIMIT,
    VariablesViewProvider,
    buildVariableNodes,
} from '../src/ui/views/variablesView.provider.js';
import { getVarSetScanner } from '../src/ui/panels/varsetPicker.panel.js';

/**
 * Unit tests for the Variables tree's pure data layer (T13, VSX-2xx).
 *
 * `buildVariableNodes` is the whole testable surface for the read-only
 * Variables view: given already-parsed `artifactType: Variables` files, it
 * returns a flat, parent-linked node list — file → sub-set → `name = value`
 * — with no `vscode` import in its signature. `VariablesViewProvider` is the
 * thin adapter that scans (via `VarSetScanner`, reused — not reimplemented)
 * and maps nodes to `vscode.TreeItem`s; only `getTreeItem`'s mapping is
 * covered here since it needs no vault or extension-host state.
 *
 * The module does NOT exist yet — every test below fails on import until
 * `src/ui/views/variablesView.provider.ts` is implemented.
 */

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Builds a `ParsedVar[]` from `[name, defaultValue]` pairs.
 *
 * @param entries - Ordered `[name, defaultValue]` pairs.
 * @returns `ParsedVar[]` built from `entries`.
 *
 * @example
 * mkVars([['VK-host', 'localhost'], ['VK-port', '8080']])
 */
function mkVars(entries: [string, string][]): ParsedVar[] {
    return entries.map(([name, defaultValue]) => ({ name, defaultValue }));
}

/**
 * Builds a single-block `ParsedArtifactFile` test fixture.
 *
 * @param overrides - Partial overrides for the default shape; spread last.
 * @returns Fully populated `ParsedArtifactFile` ready for use as a test input.
 *
 * @example
 * mkArtifact({ vars: mkVars([['VK-x', '1']]) })
 */
function mkArtifact(overrides: Partial<ParsedArtifactFile> = {}): ParsedArtifactFile {
    return {
        filePath:     '/tmp/vault/Variables/local-dev.md',
        fileName:     'local-dev',
        relativePath: 'local-dev.md',
        frontmatter:  { artifactType: 'Variables', title: 'Local Dev' },
        code:         '',
        vars:         [],
        blocks:       [],
        ...overrides,
    };
}

// ── buildVariableNodes ──────────────────────────────────────────────────────────

suite('buildVariableNodes', () => {

    // A one-sub-set file shows no sub-set level: its vars hang off the file
    // so a single-block set is worked on directly (the sub-set commands take
    // the file node as sub-set 0 — see resolveTarget).
    test('single-block file with 2 vars → flat [file, var, var], right order', () => {
        const artifact = mkArtifact({
            vars: mkVars([['VK-host', 'localhost'], ['VK-port', '8080']]),
        });
        const nodes = buildVariableNodes([artifact]);

        assert.deepStrictEqual(nodes.map(n => n.kind), ['file', 'var', 'var']);
    });

    test('file node label is frontmatter.title; a single-block file emits no sub-set node', () => {
        const artifact = mkArtifact({
            frontmatter: { artifactType: 'Variables', title: 'Express API Environments' },
            vars:        mkVars([['VK-host', 'localhost']]),
        });
        const nodes = buildVariableNodes([artifact]);

        assert.strictEqual(nodes[0].label, 'Express API Environments');
        assert.ok(!nodes.some(n => n.kind === 'subset'), 'a single-block file emitted a sub-set node');
    });

    test('var node label is exactly "name = value"', () => {
        const artifact = mkArtifact({ vars: mkVars([['VK-host', 'localhost']]) });
        const nodes = buildVariableNodes([artifact]);
        const varNode = nodes.find(n => n.kind === 'var');

        assert.strictEqual(varNode?.label, 'VK-host = localhost');
    });

    test('multi-block file → one subset per heading, vars scoped to their block', () => {
        const artifact = mkArtifact({
            vars: [],
            blocks: [
                { heading: 'Dev',  description: '', code: '', fenceLang: 'bash', vars: mkVars([['VK-a', '1']]) },
                { heading: 'Prod', description: '', code: '', fenceLang: 'bash', vars: mkVars([['VK-b', '2'], ['VK-c', '3']]) },
            ],
        });
        const nodes = buildVariableNodes([artifact]);

        assert.deepStrictEqual(
            nodes.map(n => n.kind),
            ['file', 'subset', 'var', 'subset', 'var', 'var'],
        );
        const subsetLabels = nodes.filter(n => n.kind === 'subset').map(n => n.label);
        assert.deepStrictEqual(subsetLabels, ['Dev', 'Prod']);

        // A mutant that re-parents every var onto the *first* subset passes both
        // assertions above (kinds and subset labels are unaffected) — this is the
        // assertion that actually pins "vars scoped to their block".
        const [devSubset, prodSubset] = nodes.filter(n => n.kind === 'subset');
        const varParents = nodes.filter(n => n.kind === 'var').map(n => n.parentId);
        assert.deepStrictEqual(varParents, [devSubset.id, prodSubset.id, prodSubset.id]);
    });

    test('parentId links each node to its actual parent — not just declaration order', () => {
        const artifact = mkArtifact({
            vars: [],
            blocks: [
                { heading: 'Dev',  description: '', code: '', vars: mkVars([['VK-a', '1']]) },
                { heading: 'Prod', description: '', code: '', vars: mkVars([['VK-b', '2']]) },
            ],
        });
        const nodes = buildVariableNodes([artifact]);
        const [fileNode, subsetNode, varNode] = nodes;

        assert.strictEqual(fileNode.parentId, null);
        assert.strictEqual(subsetNode.parentId, fileNode.id);
        assert.strictEqual(varNode.parentId, subsetNode.id);

        // Single-block: the var's parent is the file itself.
        const [single, singleVar] = buildVariableNodes([mkArtifact({ vars: mkVars([['VK-host', 'localhost']]) })]);
        assert.strictEqual(singleVar.parentId, single.id);
    });

    test('a file with no vars produces only the file node — no dangling empty subset', () => {
        const artifact = mkArtifact({ vars: [] });
        const nodes = buildVariableNodes([artifact]);

        assert.deepStrictEqual(nodes.map(n => n.kind), ['file']);
    });

    // ── Truncation boundary — pinned both sides ────────────────────────────────

    test('value at exactly VALUE_TRUNCATE_LIMIT chars is shown untouched, no marker', () => {
        const atLimit = 'x'.repeat(VALUE_TRUNCATE_LIMIT);
        const artifact = mkArtifact({ vars: mkVars([['VK-v', atLimit]]) });
        const varNode = buildVariableNodes([artifact]).find(n => n.kind === 'var');

        assert.strictEqual(varNode?.label, `VK-v = ${atLimit}`);
        assert.ok(!varNode?.label.includes('…'));
    });

    test('value one char over VALUE_TRUNCATE_LIMIT is cut to the limit and marked', () => {
        const overLimit = 'x'.repeat(VALUE_TRUNCATE_LIMIT + 1);
        const artifact = mkArtifact({ vars: mkVars([['VK-v', overLimit]]) });
        const varNode = buildVariableNodes([artifact]).find(n => n.kind === 'var');

        const expected = `VK-v = ${'x'.repeat(VALUE_TRUNCATE_LIMIT)}…`;
        assert.strictEqual(varNode?.label, expected);
    });

    // ── Untrusted vault content — hostile name/value must not break the row ────

    test('a value containing a newline is collapsed to one line, not split into fake rows', () => {
        const artifact = mkArtifact({ vars: mkVars([['VK-v', 'line1\nline2\rline3']]) });
        const varNode = buildVariableNodes([artifact]).find(n => n.kind === 'var');

        assert.ok(!varNode?.label.includes('\n'));
        assert.ok(!varNode?.label.includes('\r'));
        assert.strictEqual(varNode?.label, 'VK-v = line1 line2 line3');
    });

    test('a var name containing a newline is also collapsed to one line', () => {
        const artifact = mkArtifact({ vars: mkVars([['VK-a\nVK-b', 'val']]) });
        const varNode = buildVariableNodes([artifact]).find(n => n.kind === 'var');

        assert.ok(!varNode?.label.includes('\n'));
        assert.strictEqual(varNode?.label, 'VK-a VK-b = val');
    });

    test('multiple files each get their own file node, in input order', () => {
        const a = mkArtifact({ filePath: '/tmp/vault/Variables/a.md', fileName: 'a', vars: mkVars([['VK-x', '1']]) });
        const b = mkArtifact({ filePath: '/tmp/vault/Variables/b.md', fileName: 'b', vars: mkVars([['VK-y', '2']]) });
        const nodes = buildVariableNodes([a, b]);

        const fileIds = nodes.filter(n => n.kind === 'file').map(n => n.id);
        assert.deepStrictEqual(fileIds, [a.filePath, b.filePath]);
    });
});

// ── VariablesViewProvider.getTreeItem — the vscode-adapter seam ────────────────

suite('VariablesViewProvider.getTreeItem', () => {

    test('file and subset nodes are collapsible; var nodes are leaves', () => {
        const provider = new VariablesViewProvider();

        const fileItem = provider.getTreeItem({ id: 'f', parentId: null, kind: 'file', label: 'F' });
        const subsetItem = provider.getTreeItem({ id: 's', parentId: 'f', kind: 'subset', label: 'S' });
        const varItem = provider.getTreeItem({ id: 'v', parentId: 's', kind: 'var', label: 'VK-x = 1' });

        assert.strictEqual(fileItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.strictEqual(subsetItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.strictEqual(varItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
    });

    test('getTreeItem preserves the node label verbatim on the TreeItem', () => {
        const provider = new VariablesViewProvider();
        const item = provider.getTreeItem({ id: 'v', parentId: 's', kind: 'var', label: 'VK-host = localhost' });

        assert.strictEqual(item.label, 'VK-host = localhost');
    });

    test('getTreeItem carries node.id onto TreeItem.id — VS Code identity, not label-derived', () => {
        // Without this, two rows sharing a label (e.g. two "VK-x = 1" vars under
        // different sub-sets) collide on VS Code's label-fallback identity.
        const provider = new VariablesViewProvider();
        const item = provider.getTreeItem({ id: 'file::subset:1::var:0', parentId: 's', kind: 'var', label: 'VK-x = 1' });

        assert.strictEqual(item.id, 'file::subset:1::var:0');
    });
});

/**
 * H0.1 — a scanner invalidation must reach the tree.
 *
 * `VarSetScanner` is a process-wide singleton (`varsetPicker.panel.ts`), and
 * the tree caches its flattened rows on `this.nodes`, re-scanning only on a
 * root `getChildren` call — which only `onDidChangeTreeData` triggers. Before
 * this hunk, `handleSaveAsVarSet` cleared the cache and stopped there: the
 * view stayed stale until a window reload (defect D-B).
 */
suite('VariablesViewProvider — scanner invalidation reaches the tree (H0.1)', () => {

    test('an invalidation on the shared scanner fires onDidChangeTreeData', () => {
        const provider = new VariablesViewProvider();
        let fired = 0;
        const sub = provider.onDidChangeTreeData(() => { fired++; });

        getVarSetScanner().invalidate();

        assert.strictEqual(fired, 1, 'a scanner invalidation did not reach the tree');
        sub.dispose();
        provider.dispose();
    });
});
