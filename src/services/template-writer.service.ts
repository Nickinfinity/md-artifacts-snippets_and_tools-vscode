import * as vscode from 'vscode';
import { isWithinRoot } from '../ui/panels/destFolderPicker.panel.js';
import type { WriteResult } from './artifact-writer.service.js';

/**
 * Writes a resolved template file into the user's **workspace**.
 *
 * This is deliberately **not** `writeArtifact`: that writer is vault-scoped by
 * contract — it derives a base directory from the artifact type and auto-creates
 * it, which pointed at a workspace would litter a `Templates/` folder into the
 * user's project. This writer creates no directory, appends no `.md`, and writes
 * the caller-resolved filename verbatim. The `WriteResult` union and the
 * `isWithinRoot` containment helper are the only shared parts.
 *
 * Security (plan §5): the destination is attacker-influenced, so containment is
 * asserted **before any I/O**. Both the destination directory and the final file
 * path must resolve inside `workspaceRoot`; the filename check is the backstop
 * for a separator that slipped past `validateTargetFileName` upstream.
 */

/** Arguments for {@link writeTemplateFile}. */
export interface WriteTemplateArgs {
    /** Workspace folder root — the containment boundary for the write. */
    workspaceRoot: vscode.Uri;
    /** Destination directory (already resolved from the Explorer URI or picker). */
    destDir: vscode.Uri;
    /** Final filename **including** its extension — no `.md` is appended. */
    fileName: string;
    /** UTF-8 content to write (variables already resolved). */
    content: string;
    /** When `true`, overwrite an existing file. Defaults to `false`. */
    force?: boolean;
}

/**
 * Writes `content` to `destDir/fileName` inside the workspace, guarding
 * containment and reporting collisions.
 *
 * @param args - Workspace root, destination dir, filename, content, force flag.
 * @returns `success` with the absolute path, `collision` when the file exists and
 *          `force` is unset, or `error` (containment failure or I/O exception).
 *
 * @example
 * const r = await writeTemplateFile({ workspaceRoot, destDir, fileName: 'Button.tsx', content });
 * if (r.kind === 'success') { await vscode.window.showTextDocument(vscode.Uri.file(r.filePath)); }
 */
export async function writeTemplateFile(args: WriteTemplateArgs): Promise<WriteResult> {
    try {
        // ── Containment: destination dir must be inside the workspace ──────────
        if (!isWithinRoot(args.workspaceRoot, args.destDir)) {
            return { kind: 'error', message: vscode.l10n.t('Destination "{0}" is outside the workspace folder.', args.destDir.fsPath) };
        }

        // ── Containment: the resolved file path must also stay inside ──────────
        const fileUri = vscode.Uri.joinPath(args.destDir, args.fileName);
        if (!isWithinRoot(args.workspaceRoot, fileUri)) {
            return { kind: 'error', message: vscode.l10n.t('Resolved path "{0}" escapes the workspace folder.', fileUri.fsPath) };
        }

        // ── Collision check ────────────────────────────────────────────────────
        if (await fileExists(fileUri) && !args.force) {
            return { kind: 'collision', filePath: fileUri.fsPath };
        }

        // ── Write (no directory is created — destDir already exists) ───────────
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(args.content));
        return { kind: 'success', filePath: fileUri.fsPath };

    } catch (err) {
        return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Returns `true` when a file exists at `uri` (stat succeeds without throwing).
 *
 * @param uri - File URI to check.
 * @returns `true` if the file exists.
 *
 * @example
 * await fileExists(vscode.Uri.file('/ws/src/Button.tsx'))
 */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
