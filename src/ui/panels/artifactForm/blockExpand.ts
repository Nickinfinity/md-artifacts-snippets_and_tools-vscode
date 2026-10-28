import * as vscode from 'vscode';
import { openScratchFile, disposeScratchFile } from '../../../services/scratch-file.service.js';
import { extForLang, normalizeLangId } from '../../../services/language-map.service.js';
import { slugify } from '../../../services/scratch-file.service.js';
import type { ArtifactFormBlock } from '../../../types/artifact-form.types.js';
import { out } from './shared.js';

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
    const slug = slugify(block.heading);
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
    /** Returns the block at `index` from the form's current model, or `undefined` if out of range. */
    getBlock: (index: number) => ArtifactFormBlock | undefined;
    /** Called with the saved file text once the user saves the expanded editor. */
    onSaved: (index: number, code: string) => void;
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

    constructor(private readonly cb: FormBlockExpandCallbacks) {}

    /**
     * Writes the block's code to a temp file, opens it beside the form panel,
     * sets its editor language, and arms the save watcher. Replaces any
     * previous session (`teardown()` runs first).
     *
     * @param index - The block's position in `ArtifactFormModel.blocks`.
     * @returns A promise that resolves once the editor is open — or
     *          immediately, doing nothing, if `index` is out of range or the
     *          scratch file was rejected.
     *
     * @example
     * await controller.start(0);
     */
    async start(index: number): Promise<void> {
        await this.teardown();

        const block = this.cb.getBlock(index);
        if (!block) {
            out.appendLine(`[formBlockExpand] start: no block at index ${index}`);
            return;
        }

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
        const doc = await vscode.workspace.openTextDocument(uri);
        const known = await vscode.languages.getLanguages();
        const langId = normalizeLangId(block.language);
        if (known.includes(langId)) {
            await vscode.languages.setTextDocumentLanguage(doc, langId);
        }
        const column = this.cb.getViewColumn() ?? vscode.ViewColumn.Beside;
        await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });

        // ── Record state + arm the save watcher ───────────────────────────────
        this.tempUri = uri;
        const key = uri.toString();
        this.subs.push(
            vscode.workspace.onDidSaveTextDocument(d => {
                if (d.uri.toString() !== key) { return; }
                this.cb.onSaved(index, d.getText());
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
        if (temp) {
            await disposeScratchFile(temp);
        }
    }
}
