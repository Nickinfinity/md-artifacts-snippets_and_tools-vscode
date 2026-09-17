import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseFromContent } from '../../../services/parser.service.js';
import type { BlockRef } from '../../../services/artifact-patcher.service.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
import { out } from './shared.js';
import { ArtifactItem, buildItem, PREVIEW_DEBOUNCE_MS } from './navigator.helpers.js';
import { PreviewPanelController, blockAsArtifact } from './preview.js';
import { WebviewHost } from './webviewHost.js';
import { getMainViewProvider, type MainViewProvider } from '../../views/mainView.provider.js';
import { ensureView } from '../../views/mainView.preview.js';
import type { InvocationSurface } from './preview.helpers.js';
import { getVaultRootUri } from '../../../services/config.service.js';
import { forcesSingleBlock } from '../../../services/artifact-type-config.service.js';
import { isIndexArtifact } from '../../../services/multi-index.service.js';
import { resolveDestination } from '../../../services/template-destination.service.js';
import { MultiIndexRunner } from './multiIndex.js';
import { chooseStepDestination } from './multiIndex.dest.js';

/**
 * Opens a QuickPick navigator for the given vault artifact directory.
 *
 * While the user navigates, a popup `WebviewPanel` beside the editor shows
 * parsed metadata + code + variable defaults (preview mode).  When the user
 * presses Enter on a file, the QuickPick closes and the popup switches to
 * interactive edit mode.
 *
 * @param artifactDir  - Vault-relative directory name (e.g. `'Snippets'`).
 * @param artifactName - Human-readable name shown in the QuickPick title.
 * @param extensionUri - Extension URI used to resolve the shared CSS stylesheet.
 * @param storageUri   - Extension storage dir for block-edit temp files
 *                       (`context.storageUri ?? context.globalStorageUri`).
 * @param destUri      - The Explorer URI a Template was invoked on (folder or file),
 *                       forwarded to the Create File flow (D2). `undefined` for every
 *                       non-template invocation; the picker behaves exactly as before.
 * @param surface      - Which context-menu surface the command was invoked from (T3),
 *                       forwarded to `performInsert` for both-context types (`AIPrompt`).
 *                       `registerInsertCommands` passes this explicitly for every
 *                       registration — no default here, so a missing argument is a
 *                       compile error rather than a silent editor insert.
 *
 * @example
 * await openArtifactPicker('Templates', 'Templates', context.extensionUri, storageUri, clickedUri, 'editor');
 */
/**
 * The registered main pane, or a thrown error naming why it is absent.
 *
 * The pane is the preview's only host now that the editor-column popup is
 * gone, so a missing provider is an activation defect, not a state the
 * preview can degrade through — failing loudly beats rendering nowhere.
 *
 * @returns The registered `MainViewProvider`.
 * @throws When `extension.ts` has not registered one.
 *
 * @example
 * requirePane().endPreview();
 */
function requirePane(): MainViewProvider {
    const pane = getMainViewProvider();
    if (!pane) {
        throw new Error('main pane provider is not registered — extension activation did not complete');
    }
    return pane;
}

export async function openArtifactPicker(
    artifactDir: string,
    artifactName: string,
    extensionUri: vscode.Uri,
    storageUri: vscode.Uri,
    destUri: vscode.Uri | undefined,
    surface: InvocationSurface,
): Promise<void> {
    const vaultRoot = getVaultRootUri();

    if (!vaultRoot) {
        vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: No vault configured. Open Settings to select your vault.'));
        return;
    }

    const rootUri = vscode.Uri.joinPath(vaultRoot, artifactDir);

    try {
        const stat = await vscode.workspace.fs.stat(rootUri);
        if ((stat.type & vscode.FileType.Directory) === 0) { throw new Error('not a directory'); }
    } catch {
        vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: Directory "{0}" not found in your vault.', artifactDir));
        return;
    }

    const targetEditor = vscode.window.activeTextEditor;
    await new ArtifactNavigator(rootUri, artifactName, targetEditor, extensionUri, storageUri, destUri, surface).run();
}

// ── ArtifactNavigator ─────────────────────────────────────────────────────────

class ArtifactNavigator {
    private readonly qp: vscode.QuickPick<ArtifactItem>;
    private readonly rootUri: vscode.Uri;
    private readonly artifactName: string;
    private readonly extensionUri: vscode.Uri;
    private readonly parseCache = new Map<string, ParsedArtifactFile>();
    private readonly refreshedUris = new Set<string>();
    private readonly preview: PreviewPanelController;
    /** One transport per picker session; re-attached whenever the pane resolves. */
    private readonly host = new WebviewHost();

    private currentDir: vscode.Uri;
    private readonly dirStack: vscode.Uri[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    /** The artifact whose blocks are currently listed; set by `loadBlocks`. */
    private currentArtifact: ParsedArtifactFile | undefined;
    /** When true, `onDidHide` will NOT dispose the preview (handoff to interactive mode). */
    private keepPopupOnHide = false;
    private lastPreviewedUri = '';

    constructor(
        rootUri: vscode.Uri,
        artifactName: string,
        targetEditor: vscode.TextEditor | undefined,
        extensionUri: vscode.Uri,
        storageUri: vscode.Uri,
        private readonly destUri: vscode.Uri | undefined,
        private readonly invocationSurface: InvocationSurface,
    ) {
        this.rootUri      = rootUri;
        this.currentDir   = rootUri;
        this.artifactName = artifactName;
        this.extensionUri = extensionUri;

        this.qp = vscode.window.createQuickPick<ArtifactItem>();
        this.qp.placeholder        = vscode.l10n.t('Type to filter — Enter to select and edit variables');
        this.qp.ignoreFocusOut     = true;
        this.qp.matchOnDescription = true;
        this.qp.matchOnDetail      = true;

        this.preview = new PreviewPanelController({
            extensionUri,
            rootFs:       rootUri.fsPath,
            targetEditor,
            setCache:     (uri, parsed) => { this.parseCache.set(uri.toString(), parsed); },
            onDispose:    () => { /* preview self-cleans; navigator has no extra work */ },
            closePicker:  () => this.qp.hide(),
            host:         this.host,
            ensureView:   async () => {
                const pane = requirePane();
                await ensureView(pane.viewTarget());
                const target = pane.hostTarget();
                if (!target) { throw new Error('main pane resolved but exposed no host target'); }
                this.host.attachTarget(target);
            },
            endPreview:       () => { getMainViewProvider()?.endPreview(); },
            showPreviewState: state => { requirePane().showPreview(state); },
            onWebviewMessage: handler => requirePane().onWebviewMessage(handler),
            storageUri,
            destUri,
            invocationSurface: this.invocationSurface,
        });
    }

    async run(): Promise<void> {
        out.appendLine(`\n=== picker: ${this.artifactName}  root=${this.rootUri.fsPath} ===`);

        this.qp.onDidChangeActive(items => {
            if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
            this.debounceTimer = setTimeout(() => void this.handleActiveChange(items), PREVIEW_DEBOUNCE_MS);
        });

        this.qp.onDidAccept(() => void this.handleAccept());

        this.qp.onDidHide(() => {
            if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
            // Only dispose the popup when the user dismissed the picker (Escape /
            // click-outside).  If handleAccept set keepPopupOnHide = true the popup
            // is being handed off to interactive mode — leave it alive.
            if (!this.keepPopupOnHide) { this.preview.dispose(); }
            this.qp.dispose();
        });

        await this.loadDir(this.rootUri);
        this.qp.show();
    }

    // ── Directory loading ─────────────────────────────────────────────────────

    private async loadDir(uri: vscode.Uri): Promise<void> {
        this.currentDir = uri;
        this.qp.busy    = true;
        this.qp.value   = '';
        this.refreshedUris.clear();
        this.lastPreviewedUri = '';

        const rel     = this.relPath(uri);
        this.qp.title = rel ? `${this.artifactName} / ${rel}` : this.artifactName;

        const items: ArtifactItem[] = [];

        if (this.dirStack.length > 0) {
            items.push({ label: '$(arrow-left)  ..', description: vscode.l10n.t('Go back'), isBack: true });
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            entries.sort(([nameA, typeA], [nameB, typeB]) => {
                const aIsDir = (typeA & vscode.FileType.Directory) !== 0;
                const bIsDir = (typeB & vscode.FileType.Directory) !== 0;
                if (aIsDir !== bIsDir) { return aIsDir ? -1 : 1; }
                return nameA.localeCompare(nameB);
            });

            for (const [name, fileType] of entries) {
                const isDir = (fileType & vscode.FileType.Directory) !== 0;
                if (!isDir && !name.endsWith('.md')) { continue; }
                const itemUri  = vscode.Uri.joinPath(uri, name);
                const fallback = isDir ? name : name.slice(0, -3);
                const cached   = isDir ? undefined : this.parseCache.get(itemUri.toString());
                items.push(buildItem(itemUri, isDir, fallback, cached, this.rootUri.fsPath));
                if (cached) { this.refreshedUris.add(itemUri.toString()); }
            }
        } catch (err) {
            out.appendLine(`[dir] read failed: ${(err as Error).message}`);
        }

        this.qp.items = items;
        this.qp.busy  = false;

        this.prefetchItems(items);

        // Trigger initial preview — onDidChangeActive may not fire automatically
        // when the QuickPick first shows.
        setTimeout(() => {
            const [first] = this.qp.activeItems;
            if (first) { void this.handleActiveChange([first]); }
        }, 60);
    }

    // ── Block listing ─────────────────────────────────────────────────────────

    private loadBlocks(artifact: ParsedArtifactFile): void {
        this.dirStack.push(this.currentDir);
        this.currentArtifact = artifact;
        this.qp.value = '';
        this.qp.title = artifact.frontmatter.title || artifact.fileName;

        const items: ArtifactItem[] = [];
        items.push({ label: '$(arrow-left)  ..', description: vscode.l10n.t('Go back'), isBack: true });

        for (const block of artifact.blocks) {
            const firstSentence = block.description
                ? (/^[^.!?]*[.!?]?/.exec(block.description)?.[0] ?? block.description).trim()
                : '';
            const detail = block.vars.length > 0
                ? `$(symbol-variable)  ${block.vars.map(v => v.name.startsWith('VK-') ? v.name.slice(3) : v.name).join('  |  ')}`
                : undefined;
            items.push({ label: `$(code)  ${block.heading}`, description: firstSentence || undefined, detail, block });
        }

        this.qp.items = items;
        out.appendLine(`[blocks] listed ${artifact.blocks.length} blocks for "${this.qp.title}"`);
    }

    // ── Background prefetch ───────────────────────────────────────────────────

    private prefetchItems(items: ArtifactItem[]): void {
        void Promise.all(
            items
                .filter(i => !i.isDirectory && !i.isBack && i.uri && !this.parseCache.has(i.uri.toString()))
                .map(async i => {
                    const artifact = await this.getOrParse(i.uri!);
                    if (artifact) { this.refreshItem(i.uri!, artifact); }
                }),
        );
    }

    // ── Active change → preview routing ───────────────────────────────────────

    private async handleActiveChange(items: readonly ArtifactItem[]): Promise<void> {
        const item = items[0];
        out.appendLine(`[active] "${item?.label ?? ''}" isDir=${item?.isDirectory} uri=${item?.uri?.fsPath ?? ''} block=${item?.block?.heading ?? ''}`);

        if (item?.block && this.currentArtifact) {
            const key = `block:${item.block.heading}`;
            if (key !== this.lastPreviewedUri) {
                this.lastPreviewedUri = key;
                this.preview.showPreview(
                    blockAsArtifact(item.block, this.currentArtifact),
                    { kind: 'multi', heading: item.block.heading },
                );
            }
            return;
        }

        if (!item || item.isBack || item.isDirectory || !item.uri) {
            this.preview.showEmpty();
            return;
        }

        const artifact = await this.getOrParse(item.uri);
        if (!artifact) { return; }

        this.refreshItem(item.uri, artifact);

        const key = item.uri.toString();
        if (key === this.lastPreviewedUri) { return; }
        this.lastPreviewedUri = key;

        if (this.isMultiBlockNav(artifact)) {
            this.preview.showMultiBlockPreview(artifact);
            return;
        }
        this.preview.showPreview(artifact);
    }

    /**
     * Whether an artifact should be browsed as a multi-block file.
     *
     * A template is single-block by contract (D1); a malformed 2+ block template
     * is deliberately routed to the single preview so the Create File handler
     * surfaces the D1 error, rather than letting the user drill into its blocks.
     *
     * Which types those are is **not** re-stated here — `forcesSingleBlock`
     * derives it from the same `ARTIFACTS.form.multiBlock` flag the create form
     * reads, so agent (multi-block) and template (single) can never disagree
     * between the form and the picker.
     *
     * @param artifact - The parsed artifact under consideration.
     * @returns `true` when it has 2+ blocks and its type allows multiple.
     *
     * @example
     * this.isMultiBlockNav(artifact) ? showMultiBlockPreview(artifact) : showPreview(artifact)
     */
    private isMultiBlockNav(artifact: ParsedArtifactFile): boolean {
        return artifact.blocks.length > 1 && !forcesSingleBlock(artifact.frontmatter.artifactType);
    }

    // ── Parsing & cache ───────────────────────────────────────────────────────

    private async getOrParse(uri: vscode.Uri): Promise<ParsedArtifactFile | undefined> {
        const key = uri.toString();
        const hit = this.parseCache.get(key);
        if (hit) { out.appendLine(`[parse] cache hit ${uri.fsPath}`); return hit; }
        try {
            const bytes   = await vscode.workspace.fs.readFile(uri);
            const content = new TextDecoder().decode(bytes);
            const parsed  = parseFromContent(content, uri.fsPath, this.rootUri.fsPath);
            this.parseCache.set(key, parsed);
            out.appendLine(`[parse] OK "${parsed.frontmatter.title ?? parsed.fileName}" vars=${parsed.vars.length}`);
            return parsed;
        } catch (err) {
            out.appendLine(`[parse] FAILED ${uri.fsPath}: ${(err as Error).message}`);
            return undefined;
        }
    }

    private refreshItem(uri: vscode.Uri, artifact: ParsedArtifactFile): void {
        const key = uri.toString();
        if (this.refreshedUris.has(key)) { return; }
        this.refreshedUris.add(key);
        this.qp.items = this.qp.items.map(i =>
            i.uri?.toString() === key
                ? buildItem(uri, false, artifact.fileName, artifact, this.rootUri.fsPath)
                : i,
        );
    }

    // ── Accept handler ────────────────────────────────────────────────────────

    private async handleAccept(): Promise<void> {
        const [item] = this.qp.activeItems;
        if (!item) { return; }

        if (item.isBack) {
            const prev = this.dirStack.pop();
            if (prev) { await this.loadDir(prev); }
            return;
        }

        if (item.isDirectory && item.uri) {
            this.dirStack.push(this.currentDir);
            await this.loadDir(item.uri);
            return;
        }

        if (item.block && this.currentArtifact) {
            const blockArtifact = blockAsArtifact(item.block, this.currentArtifact);
            this.handoffToPreview(blockArtifact, { kind: 'multi', heading: item.block.heading });
            return;
        }

        if (!item.uri) { return; }

        const artifact = await this.getOrParse(item.uri);
        if (!artifact) {
            vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: Could not read file.'));
            return;
        }

        if (isIndexArtifact(artifact.frontmatter)) { await this.runIndex(artifact); return; }

        if (this.isMultiBlockNav(artifact)) {
            this.loadBlocks(artifact);
            return;
        }

        this.handoffToPreview(artifact);
    }

    /**
     * Runs a template index (F7): resolves the destination (D2), hides the QuickPick before the run starts (F6), hands off to `MultiIndexRunner`.
     * @param artifact - Parsed index file.
     * @returns Resolves once the run (or an early guard) finishes.
     * @example await this.runIndex(indexArtifact);
     */
    private async runIndex(artifact: ParsedArtifactFile): Promise<void> {
        if (!vscode.workspace.workspaceFolders?.length) { vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: Open a workspace folder to run a template index.')); return; }
        const destDir = await resolveDestination(this.destUri);
        if (!destDir) { return; }
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(destDir)?.uri;
        if (!workspaceRoot) { vscode.window.showErrorMessage(vscode.l10n.t('Obsidian Artifacts: Destination is not inside an open workspace folder.')); return; }
        this.keepPopupOnHide = true; this.qp.hide();
        const clickedRelPath = destDir.fsPath === workspaceRoot.fsPath ? '' : path.relative(workspaceRoot.fsPath, destDir.fsPath).replaceAll(path.sep, '/');
        const runner = new MultiIndexRunner({
            indexDirUri: vscode.Uri.joinPath(vscode.Uri.file(artifact.filePath), '..'),
            workspaceRoot, clickedRelPath, vaultRootFs: this.rootUri.fsPath,
            chooseDestination: (step, candidates) => chooseStepDestination({ workspaceRoot, candidates, targetName: path.posix.basename(step.relPath) }),
            previewStep: (a, d) => this.preview.previewOnce(a, d), closePicker: () => this.qp.hide(), disposePreview: () => this.preview.dispose(),
        });
        await runner.run(artifact);
    }

    /** Hide QP, render artifact in interactive preview, focus the panel. */
    private handoffToPreview(artifact: ParsedArtifactFile, blockRef?: BlockRef): void {
        this.keepPopupOnHide = true;
        this.qp.hide();
        this.preview.showPreview(artifact, blockRef);
        this.preview.reveal(false);
    }

    private relPath(uri: vscode.Uri): string {
        const root = this.rootUri.fsPath;
        const p    = uri.fsPath;
        if (p === root) { return ''; }
        return p.startsWith(root) ? p.slice(root.length + 1).replaceAll('\\', ' / ') : '';
    }
}
