import * as vscode from 'vscode';
import { writesWholeFile } from '../../../services/artifact-type-config.service.js';
import type { BlockRef } from '../../../services/artifact-patcher.service.js';
import type { PreviewModeController } from '../../../services/preview-mode.service.js';
import { isIndexArtifact } from '../../../services/multi-index.service.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import type { InvocationSurface } from './preview.helpers.js';
import { DELIVERY_IO, performInsert, renderForDelivery, type DeliveryIO } from './preview.insert.js';
import { mergeVarsWithDefaults } from './preview.render.js';
import { runCreateFileFlow, toBatchOutcome } from './preview.createFile.js';
import type { BatchGate } from './preview.batch.js';
import type { HostMessage } from './webviewHost.js';

/** Callback bag for {@link PreviewActions}; state stays on the controller. */
export interface PreviewActionsCallbacks {
    rootFs: string;
    targetEditor: vscode.TextEditor | undefined;
    invocationSurface: InvocationSurface;
    destUri?: vscode.Uri;
    batch: BatchGate;
    getCurrentArtifact: () => ParsedArtifactFile | undefined;
    setCurrentArtifact: (a: ParsedArtifactFile) => void;
    getBlockRef: () => BlockRef;
    getModeController: () => PreviewModeController | undefined;
    setCache: (uri: vscode.Uri, parsed: ParsedArtifactFile) => void;
    post: (msg: HostMessage) => void;
    /** Ends the preview session (the controller's `dispose`). */
    dispose: () => void;
    closePicker: () => void;
}

/**
 * The preview's user actions: Insert, Copy, Create File.
 *
 * @example
 * new PreviewActions(bag).handleCopy({ code: 'x', vars: {} });
 */
export class PreviewActions {
    /**
     * @param cb - Callback bag onto the owning controller's state.
     *
     * @example
     * new PreviewActions(bag);
     */
    constructor(private readonly cb: PreviewActionsCallbacks, private readonly io: DeliveryIO = DELIVERY_IO) {}

    /** In-flight guard: the render is awaited before the preview is disposed, so a double-click would deliver twice. */
    private inserting = false;

    /**
     * Insert: render through the engine, then deliver to editor or terminal. An engine error keeps the preview open.
     *
     * @param msg - `{ code, vars }` posted by the webview's Insert button.
     * @returns Resolves once delivery was started or refused.
     * @example await this.handleInsert({ code: 'echo <VK-a>', vars: { 'VK-a': '1' } });
     */
    async handleInsert(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }

        // Index guard (F7): a hovered index still renders Create File — only an armed run may write it.
        if (isIndexArtifact(artifact.frontmatter) && !this.cb.batch.isArmed) {
            void vscode.window.showInformationMessage(vscode.l10n.t('This is a template index — press Enter in the picker to run it.')); return;
        }
        // Templates/agent configs write a whole file instead of inserting at the
        // cursor; `writesWholeFile` is the single source shared with the label.
        if (writesWholeFile(artifact.frontmatter.artifactType)) {
            void this.handleCreateFile(msg, artifact);
            return;
        }

        if (this.inserting) { return; }
        this.inserting = true;
        try {
            const r = await renderForDelivery(artifact, this.resolveInsertCode(msg, artifact), msg.vars, this.cb.getBlockRef(), this.io);
            if (!r) { return; }
            this.cb.dispose();
            this.cb.closePicker();
            void performInsert(this.cb.targetEditor, artifact.frontmatter.artifactType, r, this.cb.invocationSurface, this.io);
        } finally {
            this.inserting = false;
        }
    }

    /**
     * Copies the engine-rendered output to the clipboard — every artifact type (T2: the
     * button is universal). Same render path as Insert, so the two cannot disagree.
     * Not escape-refused: a clipboard write is not a terminal send (W4-d).
     *
     * @param msg - `{ code, vars }` posted by the webview's Copy button.
     * @returns Resolves once copied, or after an engine error was shown.
     * @example await this.handleCopy({ code: 'ping <VK-host>', vars: { 'VK-host': 'db' } });
     */
    async handleCopy(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }
        const r = await renderForDelivery(artifact, this.resolveInsertCode(msg, artifact), msg.vars, this.cb.getBlockRef(), this.io);
        if (!r) { return; }
        // Awaited, not fire-and-forget: a remote host can reject the write, and the toast must not claim success then.
        await this.io.writeClipboard(r.output);
        this.io.showInfo(vscode.l10n.t('MD Artifacts: Copied to clipboard.'));
    }

    /** Routes to the Create File flow (D12); armed (batch step) pins `destDir`, skips
     *  the tab-open (D7), and settles the gate instead of closing the panel/picker. */
    private async handleCreateFile(msg: Record<string, unknown>, artifact: ParsedArtifactFile): Promise<void> {
        const code = this.resolveInsertCode(msg, artifact);
        const vars = mergeVarsWithDefaults(msg.vars as Record<string, string>, artifact.vars);
        const result = await runCreateFileFlow({
            artifact, code, vars, destDir: this.cb.batch.destDir,
            destUri: this.cb.destUri, openAfterWrite: !this.cb.batch.isArmed,
            blockRef: this.cb.getBlockRef(),
        });
        if (this.cb.batch.isArmed) { this.cb.batch.settle(toBatchOutcome(result, vars)); return; }
        if (result.kind === 'written') { this.cb.dispose(); this.cb.closePicker(); }
    }

    /**
     * Canonical code source for Insert and Copy: `msg.code` from the webview (staged edits), else `artifact.code`.
     *
     * @param msg      - Webview message.
     * @param artifact - Previewed artifact.
     * @returns The code to render.
     * @example this.resolveInsertCode({ code: 'x' }, artifact); // 'x'
     */
    private resolveInsertCode(msg: Record<string, unknown>, artifact: ParsedArtifactFile): string {
        return typeof msg.code === 'string' ? msg.code : artifact.code;
    }
}
