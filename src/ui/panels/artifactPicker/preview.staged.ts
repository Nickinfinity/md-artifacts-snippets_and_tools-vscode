import * as vscode from 'vscode';
import type { BlockRef } from '../../../services/artifact-patcher.service.js';
import { confirmModal } from '../../../services/confirm.service.js';
import { engineMeta } from '../../../engine/model.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import { out } from './shared.js';
import { persistBlockCode } from './preview.helpers.js';
import { rereadBlock } from './preview.reread.js';
import type { BlockEditController } from './blockEditor.js';

/** Callback bag for {@link StagedEdit}; the controller keeps the state it reads. */
export interface StagedEditCallbacks {
    blockEdit: BlockEditController;
    getCurrentArtifact: () => ParsedArtifactFile | undefined;
    /** Which fence in the source `.md` the preview's code belongs to. */
    getBlockRef: () => BlockRef;
    setCache: (uri: vscode.Uri, parsed: ParsedArtifactFile) => void;
    setCurrentArtifact: (a: ParsedArtifactFile) => void;
    postMessage: (msg: { command: string; [key: string]: unknown }) => void;
}

/**
 * Staged block edits: the expanded editor and the code area both stage; only
 * Overwrite writes, behind a `confirmModal`.
 *
 * @example
 * const staged = new StagedEdit(bag); staged.stageCode('x'); staged.reset();
 */
export class StagedEdit {
    /** Latest staged code from the expanded editor, if any. Staged, not written. */
    private stagedCode: string | undefined;

    /**
     * @param cb - Callback bag onto the owning controller's state.
     *
     * @example
     * new StagedEdit({ blockEdit, getCurrentArtifact, getBlockRef, setCache, setCurrentArtifact, postMessage });
     */
    constructor(private readonly cb: StagedEditCallbacks) {}

    /**
     * Drops any staged code (a new preview starts clean).
     *
     * @returns Nothing.
     *
     * @example
     * staged.reset();
     */
    reset(): void { this.stagedCode = undefined; }

    /**
     * Opens the previewed block as a temp file in the full editor, reporting
     * its saves back as staged edits instead of writing to the vault.
     *
     * @returns Resolves once the editor is opened.
     *
     * @example
     * await staged.handleEditBlock();
     */
    async handleEditBlock(): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }
        await this.cb.blockEdit.start(
            artifact,
            this.cb.getBlockRef(),
            this.stagedCode ?? artifact.code,
            artifact.frontmatter.language,
        );
    }

    /**
     * Records a staged edit and reflects it in the pane.
     *
     * @param code - The new block text.
     * @returns Nothing.
     *
     * @example
     * staged.stageCode('echo hi');
     */
    stageCode(code: string): void {
        this.stagedCode = code;
        this.cb.postMessage({ command: 'codeStaged', code });
    }

    /**
     * Makes the staged edit permanent, behind a confirmation.
     * The write itself is `persistBlockCode` — the one place block code is
     * patched into a `.md`.
     *
     * @param msg - Webview message carrying the current `code`.
     * @returns Resolves once written or declined.
     *
     * @example
     * await staged.handleOverwrite({ code: 'echo hi' });
     */
    async handleOverwrite(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }
        const code = typeof msg.code === 'string' ? msg.code : this.stagedCode;
        if (typeof code !== 'string') { return; }

        const name = artifact.relativePath || artifact.fileName;
        // Local, not module-scope, so `vscode.l10n.t` runs after the bundle is loaded.
        const OVERWRITE_ACTION = vscode.l10n.t('Overwrite');
        const ok = await confirmModal({
            message: vscode.l10n.t('Overwrite "{0}" with these changes?', name),
            detail:  vscode.l10n.t('The edited block replaces what is currently in the .md file.'),
            action:  OVERWRITE_ACTION,
        });
        if (!ok) { return; }

        const sourceUri = vscode.Uri.file(artifact.filePath);
        const blockRef = this.cb.getBlockRef();
        const done = await persistBlockCode({
            artifact, blockRef, newCode: code,
            onReload: () => this.reload(sourceUri, artifact, blockRef),
        });
        if (!done) { return; } // a conflict modal or toast already told the user
        this.cb.setCache(sourceUri, done.file);
        this.cb.setCurrentArtifact(done.current);
        this.stagedCode = undefined;
        this.cb.postMessage({ command: 'overwriteDone' });
        out.appendLine(`[pane] overwrite → ${artifact.fileName}`);
    }

    /** Conflict "Reload": adopt the on-disk file and drop the stale staged edit. */
    private async reload(uri: vscode.Uri, artifact: ParsedArtifactFile, ref: BlockRef): Promise<void> {
        const rel = engineMeta(artifact)?.relPath;
        const fresh = rel === undefined ? undefined : await rereadBlock(rel, ref);
        if (!fresh) { return; }
        this.cb.setCache(uri, fresh.file);
        this.cb.setCurrentArtifact(fresh.current);
        this.stagedCode = undefined;
        this.cb.postMessage({ command: 'fileUpdated', artifact: fresh.current });
    }
}
