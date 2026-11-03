import * as vscode from 'vscode';
import { openScratchFile, disposeScratchFile } from '../../../services/scratch-file.service.js';
import { extForLang, mapLanguageId, normalizeLangId } from '../../../services/language-map.service.js';
import { slugify } from '../../../services/scratch-file.service.js';
import type { ArtifactFormBlock } from '../../../types/artifact-form.types.js';
import { confirmModal } from '../../../services/confirm.service.js';
import { out } from './shared.js';

/** Highest block index the webview may name; the host model is stale by design, so this is the only bound. */
const MAX_BLOCK_INDEX = 1000;
/** Longest language id accepted from the webview. */
const MAX_LANG_LEN = 64;
/** Longest heading slug used as a scratch file name. */
const MAX_SLUG_LEN = 64;

/**
 * Form block "expand to editor" — opens one create-form block as a real temp
 * file in extension storage, then reports the saved text back to the form's
 * in-memory model. Mirrors `artifactPicker/blockEditor.ts`'s shape but never
 * touches a vault `.md` file: there is nothing to patch, only the block the
 * caller hands back through `onSaved`.
 *
 * Every write routes through `scratch-file.service` (T2) — the single
 * authority for scratch files — instead of a second copy of the containment
 * dance `blockEditor.ts` used to own alone.
 */

/** Subdirectory under extension storage this feature's scratch files live under. */
/**
 * Scratch subdirectory this controller owns, under the extension's storage dir.
 *
 * **Exported so `extension.ts` sweeps it by reference rather than re-spelling
 * the literal** — one fact, one spelling. `blockEditor.ts` already demonstrates
 * the drift that follows from the alternative.
 */
export const SCRATCH_SUBDIR = 'formBlockEdit';

/**
 * Resolves the safe `baseName` + cosmetic `ext` for a form block's scratch
 * file. The heading is slugified **before** either value reaches
 * `openScratchFile` — a hostile heading (`'../../etc/passwd'`) collapses to a
 * plain, separator-free slug (`'etc-passwd'`) here, so `scratch-file.service`'s
 * own reject-not-sanitise containment check is a second, independent gate,
 * never the only one standing between a hostile heading and a write.
 *
 * An empty (or all-punctuation) heading falls back to `untitled-block-<n>`,
 * keyed off `index` rather than the block itself — a block's position in
 * `ArtifactFormModel.blocks` is not part of the block.
 *
 * @param block - The block's `heading` and `language` fields.
 * @param index - The block's position in `ArtifactFormModel.blocks`.
 * @returns `{ baseName, ext }` — both safe to pass straight to `openScratchFile`.
 *
 * @example
 * blockNameParts({ heading: '', language: 'typescript' }, 2);
 * // → { baseName: 'untitled-block-3', ext: 'ts' }
 * blockNameParts({ heading: '../../etc/passwd', language: 'ts' }, 0);
 * // → { baseName: 'etc-passwd', ext: 'ts' }
 */
function blockNameParts(
    block: Pick<ArtifactFormBlock, 'heading' | 'language'>,
    index: number,
): { baseName: string; ext: string } {
    const slug = slugify(block.heading).slice(0, MAX_SLUG_LEN);
    const baseName = slug.length > 0 ? slug : `untitled-block-${index + 1}`;
    const ext = extForLang(normalizeLangId(block.language));
    return { baseName, ext };
}

/**
 * Builds the scratch file's display name (`<baseName>.<ext>`) for a form
 * block — the joined form of `blockNameParts`, used for logging and for
 * asserting the naming rule without touching `vscode`.
 *
 * @param block - The block's `heading` and `language` fields.
 * @param index - The block's position in `ArtifactFormModel.blocks`.
 * @returns The scratch file name.
 *
 * @example
 * scratchNameForBlock({ heading: '', language: 'typescript' }, 2); // → 'untitled-block-3.ts'
 * scratchNameForBlock({ heading: '../../etc/passwd', language: 'ts' }, 0); // → 'etc-passwd.ts'
 */
export function scratchNameForBlock(
    block: Pick<ArtifactFormBlock, 'heading' | 'language'>,
    index: number,
): string {
    const { baseName, ext } = blockNameParts(block, index);
    return `${baseName}.${ext}`;
}

/**
 * Callback bag `FormBlockExpandController` reports through — never a
 * reference to the form controller, the same composition rule the picker's
 * controllers follow (`PreviewPanelController` → `FullEditController`, etc.).
 */
export interface FormBlockExpandCallbacks {
    /** Extension storage dir — the trusted root scratch files must stay inside. */
    storageUri: vscode.Uri;
    /**
     * Called with the saved file text once the user saves the expanded editor.
     * `languageId` is set only when the user changed the tab's language.
     */
    onSaved: (index: number, code: string, languageId?: string) => void;
    /** Returns the view column the temp editor should open beside. */
    getViewColumn: () => vscode.ViewColumn | undefined;
}

/**
 * Opens one create-form block as a real temp file in extension storage so the
 * user can edit it with the full VS Code editor, then reports the saved text
 * back through `onSaved`. Sync is save-only (`onDidSaveTextDocument`), not live.
 *
 * @example
 * const ctrl = new FormBlockExpandController(cb);
 * await ctrl.start(0);
 * // …later, before disposing the form panel:
 * await ctrl.teardown();
 */
export class FormBlockExpandController {
    private subs: vscode.Disposable[] = [];
    private tempUri: vscode.Uri | undefined;

    private active: number | undefined;

    constructor(private readonly cb: FormBlockExpandCallbacks) {}

    /**
     * Index of the block whose scratch tab is open, if any.
     *
     * @returns The index, or `undefined` when no session is active.
     *
     * @example
     * if (ctrl.activeIndex === 2) { /* block 2 is open in a tab *\/ }
     */
    get activeIndex(): number | undefined { return this.active; }

    /**
     * Writes the block's code to a temp file, opens it beside the form panel,
     * sets its editor language, and arms the save watcher. Replaces any
     * previous session (`teardown()` runs first).
     *
     * @param index - The block's position in the form.
     * @param block - The block as the webview holds it now (not the open-time model).
     * @returns A promise that resolves once the editor is open — or
     *          immediately, doing nothing, if the scratch file was rejected.
     *
     * @example
     * await controller.start(0, { heading: '', language: 'css', code: 'a{}' });
     */
    async start(
        index: number,
        block: Pick<ArtifactFormBlock, 'heading' | 'language' | 'code'>,
    ): Promise<void> {
        await this.teardown();

        // ── Resolve safe name + write through the one scratch-file authority ──
        const { baseName, ext } = blockNameParts(block, index);
        const uri = await openScratchFile({
            storageUri: this.cb.storageUri,
            subdir: SCRATCH_SUBDIR,
            baseName,
            ext,
            content: block.code,
        });
        if (!uri) {
            out.appendLine(`[formBlockExpand] start: scratch file rejected for block ${index}`);
            return;
        }

        // ── Open + set editor language (cosmetic; extension already picked ext) ──
        let doc = await vscode.workspace.openTextDocument(uri);
        const known = await vscode.languages.getLanguages();
        const langId = normalizeLangId(block.language);
        if (known.includes(langId)) {
            // The returned document is the one carrying the new language.
            doc = await vscode.languages.setTextDocumentLanguage(doc, langId);
        }
        // Why: report a language only if the user changed it, or bash → shellscript → bash
        // and '' → plaintext would silently rewrite blocks on every save.
        const openedLangId = doc.languageId;
        const column = this.cb.getViewColumn() ?? vscode.ViewColumn.Beside;
        await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });

        // ── Record state + arm the save watcher ───────────────────────────────
        this.tempUri = uri;
        this.active = index;
        const key = uri.toString();
        this.subs.push(
            vscode.workspace.onDidSaveTextDocument(d => {
                if (d.uri.toString() !== key) { return; }
                this.cb.onSaved(
                    index,
                    d.getText(),
                    d.languageId === openedLangId ? undefined : mapLanguageId(d.languageId),
                );
            }),
        );
        out.appendLine(`[formBlockExpand] start → ${baseName}.${ext} (block ${index})`);
    }

    /**
     * Disposes the save watcher and deletes the temp file. Safe to call
     * multiple times. **Must** run before the form panel disposes — a watcher
     * still armed after `panel.dispose()` would post into a disposed webview,
     * the same failure `FullEditController.teardown()` exists to avoid.
     *
     * @returns A promise that resolves once the temp file is removed.
     *
     * @example
     * await controller.teardown();
     */
    async teardown(): Promise<void> {
        this.subs.forEach(s => s.dispose());
        this.subs = [];
        const temp = this.tempUri;
        this.tempUri = undefined;
        this.active = undefined;
        if (temp) {
            await disposeScratchFile(temp);
        }
    }
}

/**
 * Parses an `expandBlock` webview message. The message is untrusted: the index
 * is bounded here, never by the host model (which is stale by design), and
 * every text field is a string or `''`.
 *
 * @param msg - The raw message.
 * @returns The index and block, or `undefined` when the index is not a safe integer in `[0, 1000)`.
 *
 * @example
 * parseExpandBlockMsg({ index: 3, code: 'a{}', language: 'css' }); // → { index: 3, block: { heading: '', language: 'css', code: 'a{}' } }
 * parseExpandBlockMsg({ index: -1 });                              // → undefined
 */
export function parseExpandBlockMsg(
    msg: Record<string, unknown>,
): { index: number; block: Pick<ArtifactFormBlock, 'heading' | 'language' | 'code'> } | undefined {
    const i = msg['index'];
    if (typeof i !== 'number' || !Number.isSafeInteger(i) || i < 0 || i >= MAX_BLOCK_INDEX) { return undefined; }
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const language = str(msg['language']);
    return {
        index: i,
        block: {
            heading: str(msg['heading']),
            language: language.length > MAX_LANG_LEN ? '' : language,
            code: str(msg['code']),
        },
    };
}

/**
 * Handles an `expandBlock` message end to end: parse, open the scratch tab,
 * and log (never throw) on failure.
 *
 * @param ctrl - The expand controller.
 * @param msg - The raw webview message.
 * @returns Resolves once the tab is open, or at once when the message is rejected.
 *
 * @example
 * await handleExpandMessage(ctrl, { command: 'expandBlock', index: 0, code: 'x', language: 'css', heading: '' });
 */
export async function handleExpandMessage(
    ctrl: FormBlockExpandController,
    msg: Record<string, unknown>,
): Promise<void> {
    const parsed = parseExpandBlockMsg(msg);
    if (!parsed) { return; }
    try {
        await ctrl.start(parsed.index, parsed.block);
    } catch (err) {
        out.appendLine(`[formBlockExpand] start failed for block ${parsed.index}: ${String(err)}`);
    }
}

/**
 * Handles a `clearBlock` message: asks the user to confirm, tears down that
 * block's scratch session (its tab would otherwise save stale text back), and
 * tells the webview the answer.
 *
 * @param index - The block index from the webview.
 * @param ctrl - The expand controller, if one exists.
 * @param post - Posts a message to the webview.
 * @returns Resolves once the answer is posted.
 *
 * @example
 * await handleClearBlock(0, ctrl, m => panel.webview.postMessage(m));
 */
export async function handleClearBlock(
    index: number,
    ctrl: FormBlockExpandController | undefined,
    post: (m: Record<string, unknown>) => void,
): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_BLOCK_INDEX) { return; }
    const confirmed = await confirmModal({
        message: vscode.l10n.t('Clear the code in this block?'),
        action: vscode.l10n.t('Clear'),
    });
    if (confirmed && ctrl?.activeIndex === index) { await ctrl.teardown(); }
    post({ command: 'clearBlockConfirmed', index, confirmed });
}
