import * as vscode from 'vscode';
import { extractSubSets } from '../../services/varset.service.js';
import { getVarSetScanner } from '../panels/varsetPicker.panel.js';
import { getVaultRootUri } from '../../services/config.service.js';
import { getEntry } from '../../services/artifact-type-config.service.js';
import type { ParsedArtifactFile } from '../../types/parsed-artifact.types.js';

/**
 * The three levels of the Variables tree, in display order.
 *
 * A runtime array with the type **derived from it**, rather than a bare union:
 * these values are also `TreeItem.contextValue`s, which `package.json`'s
 * `view/item/context` `when` clauses match on — and a `when` naming a value no
 * node produces renders **no menu entry**, silently. A type alone cannot be
 * enumerated at runtime, so the guard that pins the manifest to these kinds
 * (`package-variables-menus.test.ts`) needs the array to exist. One
 * declaration, both uses.
 */
export const VARIABLE_NODE_KINDS = ['file', 'subset', 'var'] as const;

/** One of the three tree levels — derived from `VARIABLE_NODE_KINDS`, never re-spelled. */
export type VariableNodeKind = typeof VARIABLE_NODE_KINDS[number];

/**
 * Max characters shown for a var's value before it is truncated with `…`.
 * A value at exactly this length is untouched; one character over is cut
 * and marked — see `truncateValue`.
 */
export const VALUE_TRUNCATE_LIMIT = 40;

/** Marker appended to a value cut by `VALUE_TRUNCATE_LIMIT`. */
const TRUNCATION_MARK = '…';

/**
 * Replaces any character below U+0020 (tab, CR, LF, and the rest of the C0
 * control range) with a single space.
 *
 * Var names and values are authored in vault `.md` files — untrusted input.
 * A `TreeItem` label renders as plain text (no HTML-escaping burden, unlike
 * the webview panels), but an embedded newline could still smuggle a fake
 * extra "row" into the single-line label, so control characters are
 * collapsed before display.
 *
 * @param value - Raw string from parsed frontmatter/vars.
 * @returns `value` with every control character replaced by `' '`.
 *
 * @example
 * stripControlChars('a\nb') // → 'a b'
 */
function stripControlChars(value: string): string {
    let out = '';
    for (const ch of value) {
        out += ch.charCodeAt(0) < 0x20 ? ' ' : ch;
    }
    return out;
}

/**
 * One row of the read-only Variables tree — a file, a sub-set within it, or
 * a `name = value` var within a sub-set.
 *
 * Flat by design (not nested): `parentId` links a node to its parent, so the
 * `VariablesViewProvider.getChildren` filters this list by `parentId` instead
 * of walking a tree shape. Kept `vscode`-free so `buildVariableNodes` stays
 * pure and testable without an extension host.
 *
 * @example
 * { id: '/vault/Variables/a.md', parentId: null, kind: 'file', label: 'Local Dev' }
 */
export interface VariableNode {
    /** Stable id — file path, or `<parentId>::subset:<i>` / `::var:<i>`. */
    id: string;
    /** Parent node's `id`; `null` for a top-level file node. */
    parentId: string | null;
    /** Which tree level this node renders at. */
    kind: VariableNodeKind;
    /** Display label — already sanitized to a single line. */
    label: string;
}

/**
 * Sanitizes and truncates a var's value for the tree label.
 *
 * A value at exactly `VALUE_TRUNCATE_LIMIT` characters (after sanitizing) is
 * returned untouched; anything longer is cut to the limit and suffixed with
 * `TRUNCATION_MARK`.
 *
 * @param value - Raw `defaultValue` from a `ParsedVar`.
 * @returns Single-line, length-bounded display string.
 *
 * @example
 * truncateValue('a'.repeat(41)) // → 'a'.repeat(40) + '…'
 */
function truncateValue(value: string): string {
    const clean = stripControlChars(value);
    if (clean.length <= VALUE_TRUNCATE_LIMIT) {
        return clean;
    }
    return `${clean.slice(0, VALUE_TRUNCATE_LIMIT)}${TRUNCATION_MARK}`;
}

/**
 * Pure transform — flattens already-parsed variable files into the tree's
 * row list: one `file` node per artifact, one `subset` node per
 * `extractSubSets` entry, one `var` node per `name = value` pair.
 *
 * Takes no `vscode` input and does no I/O — the provider is the only caller
 * that scans and passes results in, so this stays testable with a plain
 * fixture array.
 *
 * @param files - Parsed `artifactType: Variables` files, e.g. from `VarSetScanner.scan`.
 * @returns Flat, parent-linked `VariableNode[]` in file → sub-set → var order.
 *
 * @example
 * buildVariableNodes(parsedFixture).map(n => n.kind) // → ['file', 'subset', 'var', 'var']
 */
export function buildVariableNodes(files: ParsedArtifactFile[]): VariableNode[] {
    const nodes: VariableNode[] = [];

    for (const file of files) {
        const fileId = file.filePath;
        nodes.push({
            id: fileId,
            parentId: null,
            kind: 'file',
            label: stripControlChars(file.frontmatter.title || file.fileName),
        });

        extractSubSets(file).forEach((subSet, subIdx) => {
            const subsetId = `${fileId}::subset:${subIdx}`;
            nodes.push({
                id: subsetId,
                parentId: fileId,
                kind: 'subset',
                label: stripControlChars(subSet.heading),
            });

            subSet.vars.forEach((v, varIdx) => {
                nodes.push({
                    id: `${subsetId}::var:${varIdx}`,
                    parentId: subsetId,
                    kind: 'var',
                    label: `${stripControlChars(v.name)} = ${truncateValue(v.defaultValue)}`,
                });
            });
        });
    }

    return nodes;
}

/**
 * Read-only `TreeDataProvider` for the `obsidian-artifacts.variablesView`
 * (contributed in `package.json`, registered in `extension.ts`).
 *
 * Scans the vault's `Variables/` directory through the *shared*
 * `VarSetScanner` singleton (`getVarSetScanner()`, `varsetPicker.panel.ts`) —
 * not a private instance. That scanner's cache is also invalidated by the
 * Save-as-Variable-Set flow (`varSetController.ts`); a second instance here
 * would give this tree its own cache that flow never invalidates, so it
 * would go stale after a save the picker itself sees immediately. Flattens
 * the scan result with `buildVariableNodes` and answers
 * `getChildren`/`getTreeItem` from that flat list. `refresh()` invalidates
 * the shared cache and fires `onDidChangeTreeData`; T16's CRUD commands call
 * it after a vault write.
 *
 * @example
 * const provider = new VariablesViewProvider();
 * context.subscriptions.push(
 *   vscode.window.registerTreeDataProvider(VariablesViewProvider.viewType, provider),
 * );
 */
export class VariablesViewProvider implements vscode.TreeDataProvider<VariableNode> {
    /** The view id declared in `package.json`'s `contributes.views`. */
    static readonly viewType = 'obsidian-artifacts.variablesView';

    private readonly changeEmitter = new vscode.EventEmitter<VariableNode | undefined | null | void>();
    /** Fired by `refresh()` — mutation commands (T16) trigger a re-render through this. */
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private readonly scanner = getVarSetScanner();
    private nodes: VariableNode[] = [];

    /**
     * Re-renders the tree whenever the shared scanner cache is invalidated —
     * by this provider's own `refresh()`, or by any other caller (creating a
     * variable set through the preview, for one).
     *
     * The listener fires `changeEmitter` **directly** and must never call
     * `refresh()`: the scanner's emit is synchronous inside `invalidate()`, so
     * `refresh() → invalidate() → listener → refresh()` would recurse forever.
     * That is also why `refresh()` below no longer fires the emitter itself.
     */
    private readonly scannerSub: vscode.Disposable =
        this.scanner.onDidInvalidate(() => { this.changeEmitter.fire(); });

    /**
     * Invalidates the scanner cache, which re-renders the tree from disk.
     *
     * The re-render is not spelled here: `invalidate()` fires
     * `onDidInvalidate`, `scannerSub` hears it and fires `changeEmitter`. Adding
     * an explicit `changeEmitter.fire()` back would double-fire every refresh.
     *
     * @returns void
     *
     * @example
     * provider.refresh();
     */
    refresh(): void {
        this.scanner.invalidate();
    }

    /**
     * Releases this provider's subscription to the process-wide scanner.
     *
     * One `Disposable`, not an array — there is exactly one subscription. The
     * scanner is a module singleton, so a provider that never disposes leaks a
     * listener onto it for the life of the host.
     *
     * @returns void
     *
     * @example
     * context.subscriptions.push(provider);
     */
    dispose(): void {
        this.scannerSub.dispose();
    }

    /**
     * Returns a node's children: top-level file nodes when called with no
     * element, otherwise the nodes whose `parentId` matches it.
     *
     * The vault scan happens only on the top-level call, and its result is
     * cached on `this.nodes` for the same render pass's child lookups.
     *
     * @param element - Parent node, or `undefined` for the tree root.
     * @returns Child nodes for `element`, or `[]` when no vault is configured.
     *
     * @example
     * await provider.getChildren(); // → top-level file nodes
     */
    async getChildren(element?: VariableNode): Promise<VariableNode[]> {
        if (!element) {
            const vaultRoot = getVaultRootUri();
            if (!vaultRoot) {
                this.nodes = [];
                return [];
            }
            const variablesDirUri = vscode.Uri.joinPath(vaultRoot, getEntry('Variables').dir);
            const files = await this.scanner.scan(variablesDirUri);
            this.nodes = buildVariableNodes(files);
            return this.nodes.filter(n => n.parentId === null);
        }
        return this.nodes.filter(n => n.parentId === element.id);
    }

    /**
     * Adapts a `VariableNode` to a `vscode.TreeItem` — the only place this
     * feature touches the `vscode` tree-rendering API.
     *
     * `file` and `subset` nodes are collapsible; `var` nodes are leaves.
     *
     * @param node - Node returned from `getChildren`.
     * @returns The `TreeItem` VS Code renders for `node`.
     *
     * @example
     * provider.getTreeItem({ id: 'a', parentId: null, kind: 'file', label: 'Local Dev' });
     */
    getTreeItem(node: VariableNode): vscode.TreeItem {
        const collapsibleState = node.kind === 'var'
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(node.label, collapsibleState);
        item.id = node.id;
        item.contextValue = node.kind;
        item.iconPath = new vscode.ThemeIcon(
            node.kind === 'file' ? 'file' : node.kind === 'subset' ? 'symbol-namespace' : 'symbol-variable',
        );
        // No `item.command` on a file node — deliberately. A single click is
        // RESERVED for a different behaviour (not yet decided), so it must stay
        // unbound rather than being spent on "open the edit form": the edit form
        // is reached by the inline pencil (`OPEN_FILE_COMMAND_ID`) and the
        // context menu. VS Code's TreeItem exposes no double-click hook, so a
        // double-click route would need a click-timing shim in the provider —
        // not worth inventing until the single-click behaviour is specified.
        return item;
    }
}
