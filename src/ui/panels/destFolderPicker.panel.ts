import * as path from 'node:path';
import * as vscode from 'vscode';
import { validateFolderName } from '../../services/filename.service.js';
import { isPathWithin } from '../../utils/path-containment.js';

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Builds a breadcrumb label showing the current position within the root.
 *
 * Returns `'/'` when `currentUri` equals `rootUri`; otherwise returns the
 * POSIX relative path from root to current (e.g. `'Web/React'`).
 *
 * @param rootUri    - Root directory Uri (artifact-type base dir).
 * @param currentUri - Currently displayed directory Uri.
 * @returns Human-readable relative path or `'/'`.
 *
 * @example
 * buildBreadcrumb(root, root)                     // '/'
 * buildBreadcrumb(root, Uri.joinPath(root, 'Web')) // 'Web'
 */
export function buildBreadcrumb(rootUri: vscode.Uri, currentUri: vscode.Uri): string {
    if (currentUri.fsPath === rootUri.fsPath) { return '/'; }
    // path.relative uses OS sep; replace for POSIX display
    return path.relative(rootUri.fsPath, currentUri.fsPath).replaceAll(path.sep, '/');
}

/**
 * Returns `true` when `candidate` is equal to or nested within `root`.
 *
 * Uses a separator suffix to prevent false positives from directory names that
 * share a common prefix (e.g. `/vault/A` vs `/vault/AB`).
 *
 * @param rootUri      - Root directory Uri.
 * @param candidateUri - Uri to validate.
 * @returns `true` if candidate is within root.
 *
 * @example
 * isWithinRoot(root, Uri.joinPath(root, 'Web')) // true
 * isWithinRoot(root, Uri.file('/tmp/evil'))      // false
 */
export function isWithinRoot(rootUri: vscode.Uri, candidateUri: vscode.Uri): boolean {
    return isPathWithin(rootUri.fsPath, candidateUri.fsPath);
}

/**
 * Filters a `readDirectory` result to directories only, excluding dotfiles.
 *
 * @param entries - Raw entries from `vscode.workspace.fs.readDirectory`.
 * @returns Entries that are directories and whose names do not start with `.`.
 *
 * @example
 * filterDirEntries([['Web', FileType.Directory], ['foo.md', FileType.File]]) // [['Web', Directory]]
 */
export function filterDirEntries(
    entries: [string, vscode.FileType][],
): [string, vscode.FileType][] {
    return entries.filter(([name, type]) =>
        (type & vscode.FileType.Directory) !== 0 && !name.startsWith('.'),
    );
}

// ── QuickPick labels ──────────────────────────────────────────────────────────

// Builders, not module-scope consts: `vscode.l10n.t` must run after the
// bundle is loaded, not at require time. Neither is read back by equality —
// `item.isUse`/`item.isNew` flags carry the identity — so a builder loses
// nothing a hoisted const had.
function labelUse(): string {
    return `$(check) ${vscode.l10n.t('Use this folder')}`;
}
function labelNew(): string {
    return `$(new-folder) ＋ ${vscode.l10n.t('New folder here')}`;
}
const LABEL_BACK = '$(arrow-left)  ..';

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Opens a folder-only QuickPick navigator under `rootUri`.
 *
 * The user may browse subfolders, create new folders inline (nestable, no
 * depth limit), confirm the current folder with "Use this folder", or press
 * Escape to cancel.
 *
 * Path-escape guard: the picker never descends outside `rootUri` —
 * `isWithinRoot` is checked before any navigation or creation.
 *
 * @param rootUri - Root directory to browse (artifact-type base dir).
 * @returns Chosen subfolder Uri (may equal `rootUri`), or `undefined` on Escape.
 *
 * @example
 * const chosen = await pickDestFolder(vscode.Uri.joinPath(vaultRoot, 'Snippets'));
 * if (chosen) { // user picked a folder }
 */
export async function pickDestFolder(rootUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    return new DestFolderNavigator(rootUri).run();
}

// ── DestFolderNavigator ───────────────────────────────────────────────────────

interface FolderItem extends vscode.QuickPickItem {
    /** Absolute Uri for folder items; undefined for action items. */
    uri?: vscode.Uri;
    /** Identifies the "Use this folder" action item. */
    isUse?: boolean;
    /** Identifies the "New folder here" action item. */
    isNew?: boolean;
    /** Identifies the ".." back item. */
    isBack?: boolean;
}

class DestFolderNavigator {
    private readonly rootUri: vscode.Uri;
    private currentDir: vscode.Uri;
    private readonly dirStack: vscode.Uri[] = [];

    constructor(rootUri: vscode.Uri) {
        this.rootUri    = rootUri;
        this.currentDir = rootUri;
    }

    /**
     * Runs the picker loop. Resolves when the user confirms or cancels.
     *
     * @returns Chosen Uri or `undefined` on Escape.
     *
     * @example
     * await new DestFolderNavigator(rootUri).run()
     */
    async run(): Promise<vscode.Uri | undefined> {
        return new Promise<vscode.Uri | undefined>(resolve => {
            const qp = vscode.window.createQuickPick<FolderItem>();
            qp.placeholder    = vscode.l10n.t('Choose or create a destination folder');
            qp.ignoreFocusOut = true;

            const render = async () => {
                qp.busy = true;
                qp.title = vscode.l10n.t('Destination / {0}', buildBreadcrumb(this.rootUri, this.currentDir));
                const items: FolderItem[] = [
                    { label: labelUse(), isUse: true },
                    { label: labelNew(), isNew: true },
                ];
                if (this.dirStack.length > 0) {
                    items.push({ label: LABEL_BACK, isBack: true });
                }
                try {
                    const entries = await vscode.workspace.fs.readDirectory(this.currentDir);
                    const dirs = filterDirEntries(entries);
                    dirs.sort(([a], [b]) => a.localeCompare(b));
                    for (const [name] of dirs) {
                        const uri = vscode.Uri.joinPath(this.currentDir, name);
                        items.push({ label: `$(folder) ${name}`, uri });
                    }
                } catch { /* dir unreadable — show no subdirs */ }
                qp.items = items;
                qp.busy = false;
            };

            qp.onDidAccept(async () => {
                const item = qp.selectedItems[0];
                if (!item) { return; }

                if (item.isUse) {
                    qp.dispose();
                    resolve(this.currentDir);
                    return;
                }

                if (item.isNew) {
                    const name = await vscode.window.showInputBox({
                        prompt: vscode.l10n.t('New folder name'),
                        ignoreFocusOut: true,
                        validateInput: (v) => {
                            const r = validateFolderName(v);
                            return r.ok ? undefined : r.reason;
                        },
                    });
                    if (!name) { return; }  // Escaped input box — stay in picker
                    const newUri = vscode.Uri.joinPath(this.currentDir, name);
                    if (!isWithinRoot(this.rootUri, newUri)) { return; }
                    try {
                        await vscode.workspace.fs.createDirectory(newUri);
                        this.dirStack.push(this.currentDir);
                        this.currentDir = newUri;
                        await render();
                    } catch { /* createDirectory failed — stay put */ }
                    return;
                }

                if (item.isBack) {
                    const parent = this.dirStack.pop();
                    if (parent) {
                        this.currentDir = parent;
                        await render();
                    }
                    return;
                }

                if (item.uri && isWithinRoot(this.rootUri, item.uri)) {
                    this.dirStack.push(this.currentDir);
                    this.currentDir = item.uri;
                    await render();
                }
            });

            qp.onDidHide(() => {
                qp.dispose();
                resolve(undefined);
            });

            void render().then(() => qp.show());
        });
    }
}
