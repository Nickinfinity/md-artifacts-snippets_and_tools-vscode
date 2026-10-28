import * as path from 'node:path';

/**
 * **THE** path-containment rule: is `candidateFsPath` inside `rootFsPath`?
 *
 * This is the predicate standing between vault-authored text and the user's
 * filesystem, and it exists exactly once. It was previously spelled out three
 * times — the retired artifact writer, `destFolderPicker.panel.ts` (whence the
 * batch scaffolder imported it, so a *security* predicate lived in a UI panel),
 * and the frontmatter migration — with the copies already diverging on whether
 * they normalised first. `CLAUDE.md`'s standing rule applies: a cross-file
 * invariant gets one owner and a test, not three bodies and a comment.
 *
 * The rule is prefix-with-separator, so a sibling directory sharing a name
 * prefix (`/vault-backup` against root `/vault`) is **not** contained — the
 * bug a naive `startsWith` ships. Both sides are `path.resolve`d first, so a
 * `..` segment is collapsed before comparison rather than compared literally.
 *
 * It **rejects, never sanitises**: callers get a boolean and are expected to
 * refuse, not to repair the path back inside the root. Nothing here decodes,
 * so a percent-encoded traversal stays an inert literal segment.
 *
 * Callers needing symlink safety must `realpath` **both** sides before calling
 * and use that same resolved value for the subsequent operation — resolving
 * again afterwards reintroduces a TOCTOU window where the checked path is not
 * the path used.
 *
 * @param rootFsPath - Trusted root directory, as a filesystem path.
 * @param candidateFsPath - Untrusted path to test against it.
 * @returns `true` only when the candidate is the root itself or sits beneath it.
 *
 * @example
 * isPathWithin('/vault', '/vault/Snippets/a.md') // → true
 * isPathWithin('/vault', '/vault')               // → true  (the root itself)
 * isPathWithin('/vault', '/vault-backup/a.md')   // → false (prefix, not child)
 * isPathWithin('/vault', '/vault/../etc/passwd') // → false (resolved first)
 */
export function isPathWithin(rootFsPath: string, candidateFsPath: string): boolean {
	const root = path.resolve(rootFsPath);
	const candidate = path.resolve(candidateFsPath);
	if (candidate === root) { return true; }
	return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
