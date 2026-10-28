import * as vscode from 'vscode';
import type { BlockRef } from './preview.types.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import { blockAsArtifact } from './preview.helpers.js';
import { openScratchFile, disposeScratchFile } from '../../../services/scratch-file.service.js';
import { extForLang, resolveLangId } from '../../../services/language-map.service.js';
import { out } from './shared.js';

/**
 * Scratch subdirectory this controller owns, under the extension storage dir.
 *
 * Exported so `extension.ts` sweeps it **by reference** rather than re-spelling
 * the literal — the same rule `blockExpand.ts`'s `SCRATCH_SUBDIR` follows. Until
 * Wave 2 this string existed in three places (twice here, once in the sweep).
 */
export const BLOCK_EDIT_SUBDIR = 'blockEdit';


/** Callback bag the controller uses to push state back to the preview owner. */
export interface BlockEditCallbacks {
    /** Absolute filesystem path of the artifact root. */
    rootFs: string;
    /** Extension storage directory under which temp edit files are written. */
    storageUri: vscode.Uri;
    /** Returns the artifact currently being previewed (or `undefined` if none). */
    getCurrentArtifact: () => ParsedArtifactFile | undefined;
    /** Updates the owner's current artifact after a save round-trip. */
    setCurrentArtifact: (artifact: ParsedArtifactFile) => void;
    /** Writes a freshly parsed artifact into the navigator's parse cache. */
    setCache: (uri: vscode.Uri, parsed: ParsedArtifactFile) => void;
    /** Posts a message to the preview webview (or no-op if the panel is gone). */
    postMessage: (msg: unknown) => void;
    /** Returns the preview panel's view column so the temp file opens as a tab beside it (same group). */
    getViewColumn: () => vscode.ViewColumn | undefined;
    /**
     * Receives the saved block text. The owner decides what to do with it —
     * the preview stages it as a pending edit rather than writing to disk, so
     * this controller no longer touches the vault at all.
     */
    onCodeStaged: (newCode: string) => void;
}

/**
 * Opens a single code block as a real temp file in extension storage, giving the
 * user the full VS Code editor (highlighting, IntelliSense, formatting) scoped to
 * that one block. On explicit save the edited code is
 * staged for the preview to Overwrite; on teardown the temp file is deleted.
 *
 * - Temp file lives at `<storageUri>/blockEdit/<slug>.<ext>` — never in the vault.
 * - Language is set explicitly with `setTextDocumentLanguage` (guarded by
 *   `getLanguages()`); the file extension is cosmetic.
 * - Sync is **save-only** (`onDidSaveTextDocument`), not live.
 *
 * @example
 * const ctrl = new BlockEditController(cb);
 * await ctrl.start(artifact, { kind: 'single' }, artifact.code, artifact.frontmatter.language);
 * // …later, before disposing the panel:
 * await ctrl.teardown();
 */
export class BlockEditController {
    private subs: vscode.Disposable[] = [];
    private tempUri: vscode.Uri | undefined;
    private sourceUri: vscode.Uri | undefined;
    private blockRef: BlockRef | undefined;

    constructor(private readonly cb: BlockEditCallbacks) {}

    /**
     * Writes the block code to a temp file, opens it beside the preview, sets its
     * language, and arms the save watcher. Replaces any previous session.
     *
     * @param artifact - The artifact (single-block file, or block-adapted) owning the code.
     * @param blockRef - Identifies which code fence in the source `.md` to patch.
     * @param code     - Initial code body to seed the temp file with.
     * @param language - Fence/frontmatter language hint used to resolve the editor language.
     *
     * @example
     * await controller.start(a, { kind: 'multi', heading: 'Production' }, a.code, a.frontmatter.language);
     */
    async start(
        artifact: ParsedArtifactFile,
        blockRef: BlockRef,
        code: string,
        language: string | undefined,
    ): Promise<void> {
        await this.teardown();

        // ── Resolve language + cosmetic extension ─────────────────────────────
        const known  = await vscode.languages.getLanguages();
        const langId = resolveLangId(language, language, known);
        const ext    = extForLang(langId);
        // The service REJECTS a name that slugs to empty, where this controller
        // previously fell back to 'block'. Supply that fallback here rather than
        // softening the service: rejection is the service's job, and a default
        // title is this caller's.
        const rawBase = artifact.frontmatter.title || artifact.fileName;
        const base    = rawBase.trim().length > 0 ? rawBase : 'block';

        // ── Write + open the temp file, through THE scratch-file authority ────
        // Previously this hand-rolled joinPath + createDirectory + writeFile with
        // no containment check at all. `openScratchFile` slugs, contains and
        // writes in one place; `undefined` means the name was rejected.
        const tempUri = await openScratchFile({
            storageUri: this.cb.storageUri,
            subdir:     BLOCK_EDIT_SUBDIR,
            baseName:   base,
            ext,
            content:    code,
        });
        if (!tempUri) {
            out.appendLine(`[blockEdit] rejected scratch name for "${base}" — not opening`);
            return;
        }
        // Recorded BEFORE the editor is opened: if openTextDocument or
        // showTextDocument throws, the file already exists on disk, and a
        // tempUri assigned only afterwards would leave it untracked and
        // undeletable by teardown.
        this.tempUri = tempUri;

        const doc = await vscode.workspace.openTextDocument(tempUri);
        if (known.includes(langId)) {
            await vscode.languages.setTextDocumentLanguage(doc, langId);
        }
        const column = this.cb.getViewColumn() ?? vscode.ViewColumn.Beside;
        await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });

        // ── Record state + arm the save watcher ───────────────────────────────
        this.sourceUri = vscode.Uri.file(artifact.filePath);
        this.blockRef  = blockRef;

        const key = tempUri.toString();
        this.subs.push(
            vscode.workspace.onDidSaveTextDocument(d => {
                if (d.uri.toString() !== key) { return; }
                void this.onSave(d.getText());
            }),
        );
        out.appendLine(`[blockEdit] start → ${base}.${ext} (lang=${langId}, ref=${blockRef.kind})`);
    }

    /**
     * Disposes the save watcher and deletes the temp file. Safe to call multiple
     * times; always run before disposing the preview panel.
     *
     * @example
     * await controller.teardown();
     */
    async teardown(): Promise<void> {
        this.subs.forEach(s => s.dispose());
        this.subs = [];
        const temp = this.tempUri;
        this.tempUri   = undefined;
        this.sourceUri = undefined;
        this.blockRef  = undefined;
        if (temp) { await disposeScratchFile(temp); }
    }

    /**
     * Hands the saved temp content back to the preview as a **staged** edit.
     *
     * This used to patch and write the source `.md` on every save, which made
     * the expanded editor a permanent write while typing in the preview's own
     * code area was not — two editing surfaces for one block with opposite
     * durability. Both are now staged, and `Overwrite` is the single place an
     * edit becomes permanent (`persistBlockCode`).
     *
     * @param newCode - Text the user saved in the temp file.
     */
    private async onSave(newCode: string): Promise<void> {
        if (!this.sourceUri || !this.blockRef) { return; }
        if (!this.cb.getCurrentArtifact()) { return; }
        this.cb.onCodeStaged(newCode);
        out.appendLine('[blockEdit] save: staged into the preview (not written to disk)');
    }

    /**
     * For a multi-block ref, re-adapts the matching block from the freshly parsed
     * file so the preview keeps showing that block. For a single ref, the whole
     * file artifact is the preview artifact.
     */
    private adaptForPreview(updated: ParsedArtifactFile): ParsedArtifactFile {
        if (this.blockRef?.kind !== 'multi') { return updated; }
        const heading = this.blockRef.heading;
        const block   = updated.blocks.find(b => b.heading === heading);
        return block ? blockAsArtifact(block, updated) : updated;
    }
}
