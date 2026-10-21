import * as vscode from 'vscode';
import type { BlockRef } from '../../../services/artifact-patcher.service.js';
import { confirmModal } from '../../../services/confirm.service.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import { out } from './shared.js';
import { persistBlockCode } from './preview.helpers.js';
import type { BlockEditController } from './blockEditor.js';

/** Callback bag for {@link StagedEdit}; the controller keeps the state it reads. */
export interface StagedEditCallbacks {
    rootFs: string;
    blockEdit: BlockEditController;
    getCurrentArtifact: () => ParsedArtifactFile | undefined;
    /** Which fence in the source `.md` the preview's code belongs to. */
    getBlockRef: () => BlockRef;
    setCache: (uri: vscode.Uri, parsed: ParsedArtifactFile) => void;
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
     * new StagedEdit({ rootFs, blockEdit, getCurrentArtifact, getBlockRef, setCache, postMessage });
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
        const updated = await persistBlockCode({
            sourceUri,
            blockRef: this.cb.getBlockRef(),
            newCode:  code,
            rootFs:   this.cb.rootFs,
        });
        if (!updated) {
            // Also answered when the patch was a no-op: "nothing changed", not a failure.
            vscode.window.showWarningMessage(vscode.l10n.t('Nothing was written — the code is unchanged, or the block could not be located in the file.'));
            return;
        }

        this.cb.setCache(sourceUri, updated);
        this.stagedCode = undefined;
        this.cb.postMessage({ command: 'overwriteDone' });
        out.appendLine(`[pane] overwrite → ${artifact.fileName}`);
    }
}
