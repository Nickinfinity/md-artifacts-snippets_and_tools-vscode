import * as vscode from 'vscode';
import { parseFromContent, resolveVars } from '../../../services/parser.service.js';
import { writesWholeFile } from '../../../services/artifact-type-config.service.js';
import { patchFrontmatterField, patchVarDefaults } from '../../../services/artifact-patcher.service.js';
import type { PreviewModeController, SectionKey } from '../../../services/preview-mode.service.js';
import { isIndexArtifact } from '../../../services/multi-index.service.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import { performInsert, type InvocationSurface } from './preview.helpers.js';
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
    getModeController: () => PreviewModeController | undefined;
    setCache: (uri: vscode.Uri, parsed: ParsedArtifactFile) => void;
    post: (msg: HostMessage) => void;
    /** Ends the preview session (the controller's `dispose`). */
    dispose: () => void;
    closePicker: () => void;
}

/**
 * The preview's user actions: save a section, Insert, Copy, Create File.
 *
 * @example
 * await new PreviewActions(bag).handleSaveSection({ section: 'title', value: 'x' });
 */
export class PreviewActions {
    /**
     * @param cb - Callback bag onto the owning controller's state.
     *
     * @example
     * new PreviewActions(bag);
     */
    constructor(private readonly cb: PreviewActionsCallbacks) {}

    /**
     * Patches one frontmatter field (or the var defaults) into the `.md`.
     *
     * @param msg - Webview message carrying `section` and `value`.
     * @returns Resolves once written and acknowledged.
     *
     * @example
     * await actions.handleSaveSection({ section: 'title', value: 'x' });
     */
    async handleSaveSection(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }
        const fileUri = vscode.Uri.file(artifact.filePath);
        const section = msg.section as string;
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            let content = new TextDecoder().decode(bytes);
            if (section === 'varDefaults') {
                content = patchVarDefaults(content, msg.value as Record<string, string>);
            } else {
                content = patchFrontmatterField(content, section, msg.value as string);
            }
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
            const updated = parseFromContent(content, fileUri.fsPath, this.cb.rootFs);
            this.cb.setCache(fileUri, updated);
            this.cb.setCurrentArtifact(updated);
            this.cb.getModeController()?.stopEditingSection(section as SectionKey);
            // sectionSaved before fileUpdated so the webview exits edit mode first,
            // then fileUpdated can safely update all non-editing sections.
            this.cb.post({ command: 'sectionSaved', section, success: true });
            this.cb.post({ command: 'fileUpdated', artifact: updated });
        } catch {
            this.cb.post({ command: 'sectionSaved', section, success: false });
        }
    }

    handleInsert(msg: Record<string, unknown>): void {
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

        const code         = this.resolveInsertCode(msg, artifact);
        const resolvedVars = mergeVarsWithDefaults(msg.vars as Record<string, string>, artifact.vars);

        void performInsert(this.cb.targetEditor, { ...artifact, code }, resolvedVars, this.cb.invocationSurface);
        this.cb.dispose();
        this.cb.closePicker();
    }

    /**
     * Copies the resolved code to the clipboard — every artifact type, no
     * `writesWholeFile` / `isIndexArtifact` branching (T2 — the button is
     * universal by design). Resolution mirrors `handleInsert`: the same
     * `resolveInsertCode` + `mergeVarsWithDefaults` → `resolveVars` chain,
     * so Copy and Insert never disagree on what "this artifact" means.
     * @param msg - `{ code, vars }` posted by the webview's Copy button.
     * @example this.handleCopy({ code: 'ping <VK-host>', vars: { 'VK-host': 'db' } });
     */
    handleCopy(msg: Record<string, unknown>): void {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }
        const code         = this.resolveInsertCode(msg, artifact);
        const resolvedVars = mergeVarsWithDefaults(msg.vars as Record<string, string>, artifact.vars);
        // Chained, not fire-and-forget: a remote/SSH host can reject the write, and the
        // toast must not claim success when it did (reviewer finding 1).
        void vscode.env.clipboard.writeText(resolveVars(code, resolvedVars))
            .then(() => vscode.window.showInformationMessage(vscode.l10n.t('MD Artifacts: Copied to clipboard.')));
    }

    /** Routes to the Create File flow (D12); armed (batch step) pins `destDir`, skips
     *  the tab-open (D7), and settles the gate instead of closing the panel/picker. */
    private async handleCreateFile(msg: Record<string, unknown>, artifact: ParsedArtifactFile): Promise<void> {
        const code = this.resolveInsertCode(msg, artifact);
        const vars = mergeVarsWithDefaults(msg.vars as Record<string, string>, artifact.vars);
        const result = await runCreateFileFlow({
            artifact, code, vars, destDir: this.cb.batch.destDir,
            destUri: this.cb.destUri, openAfterWrite: !this.cb.batch.isArmed,
        });
        if (this.cb.batch.isArmed) { this.cb.batch.settle(toBatchOutcome(result, vars)); return; }
        if (result.kind === 'written') { this.cb.dispose(); this.cb.closePicker(); }
    }

    /**
     * Canonical code source for `Insert`: fullEdit mode → live `.md` document;
     * else `msg.code` from the webview; fallback → `artifact.code`.
     */
    private resolveInsertCode(msg: Record<string, unknown>, artifact: ParsedArtifactFile): string {
        const mode = this.cb.getModeController()?.mode ?? 'preview';
        if (mode === 'fullEdit') {
            const fileUri = vscode.Uri.file(artifact.filePath);
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
            if (openDoc) {
                return parseFromContent(openDoc.getText(), artifact.filePath, this.cb.rootFs).code;
            }
        }
        return typeof msg.code === 'string' ? msg.code : artifact.code;
    }
}
