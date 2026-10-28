import * as path from 'node:path';
import * as vscode from 'vscode';
import { isPathWithin } from '../../utils/path-containment.js';

// ── Name validation (shared with the create form's file-name prompt) ───────

export type NameCheck = { ok: true } | { ok: false; reason: string };

const ILLEGAL_CHARS_RE   = /[\\/:*?"<>|]/;
const CONTROL_CHARS_RE   = /[\x00-\x1F\x7F]/;
const RESERVED_NAMES_RE  = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Runs the common name checks shared by file and folder validators.
 *
 * Covers empty-after-trim, illegal characters, ASCII control characters,
 * leading / trailing dot, leading / trailing space, and Windows reserved
 * names. Returns the first failure encountered with a user-facing reason.
 *
 * @param name - Raw name string as typed by the user.
 * @returns `{ ok: true }` when all shared rules pass; `{ ok: false, reason }` otherwise.
 *
 * @example
 * runCommonChecks('CON');   // → { ok: false, reason: 'Reserved system name' }
 * runCommonChecks('foo');   // → { ok: true }
 */
export function runCommonChecks(name: string): NameCheck {
    if (name.trim().length === 0) {
        return { ok: false, reason: 'Name cannot be empty' };
    }
    if (name.startsWith(' ') || name.endsWith(' ')) {
        return { ok: false, reason: 'Name cannot start or end with a space' };
    }
    if (name.startsWith('.') || name.endsWith('.')) {
        return { ok: false, reason: 'Name cannot start or end with a dot' };
    }
    if (ILLEGAL_CHARS_RE.exec(name)) {
        return { ok: false, reason: 'Name contains an illegal character (\\ / : * ? " < > |)' };
    }
    if (CONTROL_CHARS_RE.exec(name)) {
        return { ok: false, reason: 'Name contains a control character' };
    }
    if (RESERVED_NAMES_RE.exec(name)) {
        return { ok: false, reason: 'Reserved system name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)' };
    }
    return { ok: true };
}

/**
 * Validates a user-typed folder name created inside the artifact root.
 *
 * Adds folder-specific rules on top of `runCommonChecks`: rejects `.` and
 * `..` (no traversal) and rejects any `/` or `\` (folder names are a single
 * path segment — nested paths must be created level by level). Does **not**
 * reject `.md` extensions since folders are not markdown files.
 *
 * @param name - Folder name string (single path segment).
 * @returns `{ ok: true }` when valid, `{ ok: false, reason }` otherwise.
 *
 * @example
 * validateFolderName('Web');     // → { ok: true }
 * validateFolderName('..');      // → { ok: false, reason: ... }
 * validateFolderName('a/b');     // → { ok: false, reason: ... }
 */
export function validateFolderName(name: string): { ok: boolean; reason?: string } {
    if (name === '.' || name === '..') {
        return { ok: false, reason: 'Folder name cannot be "." or ".."' };
    }
    return runCommonChecks(name);
}

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
                    // ponytail: recorded E-1 exception — vault AND workspace navigation (listing only, never artifact
                    // content); upgrade path for the vault side: `artifact.tree`.
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
                        // ponytail: recorded E-1 exception — creates an empty folder (name checked by validateFolderName,
                        // contained by isWithinRoot); no engine op creates folders.
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

// ── Destination from an invoked URI ──

/**
 * Maps an invoked URI + its file type to the directory to write into.
 *
 * A directory (or a symlink pointing at one — the `Directory` bit is set) is
 * used as-is; anything else (a file, a symlink to a file) resolves to its parent.
 *
 * @param uri      - The URI the command was invoked on.
 * @param fileType - The stat'd `FileType` bitmask for `uri`.
 * @returns The directory URI to write the template into.
 *
 * @example
 * classifyDestination(Uri.file('/ws/src'), FileType.Directory)          // /ws/src
 * classifyDestination(Uri.file('/ws/src/a.ts'), FileType.File)          // /ws/src
 */
export function classifyDestination(uri: vscode.Uri, fileType: vscode.FileType): vscode.Uri {
    if ((fileType & vscode.FileType.Directory) !== 0) {
        return uri;
    }
    return vscode.Uri.joinPath(uri, '..');
}

/**
 * Resolves the destination directory for a template write.
 *
 * When `uri` is supplied it is stat'd and classified (D2); when it is absent —
 * or the stat fails — the folder picker opens rooted at the first workspace
 * folder. Returns `undefined` when no workspace is open or the user cancels the
 * picker.
 *
 * @param uri - The invoked Explorer URI, or `undefined` for a palette invocation.
 * @returns The chosen destination directory URI, or `undefined`.
 *
 * @example
 * const dest = await resolveDestination(clickedUri);
 * if (dest) { hand destDir: dest to the engine's template write; }
 */
export async function resolveDestination(uri: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
    if (uri !== undefined) {
        try {
            // ponytail: recorded E-1 exception (W5 R3) — stat only decides file vs directory for the invoked
            // URI; workspace navigation, never artifact content.
            const stat = await vscode.workspace.fs.stat(uri);
            return classifyDestination(uri, stat.type);
        } catch {
            // URI vanished between click and stat — fall through to the picker.
        }
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root === undefined) {
        return undefined;
    }
    return pickDestFolder(root);
}
