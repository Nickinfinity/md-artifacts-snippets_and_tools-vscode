import { fromEngineModel } from '../../engine/model.js';
import type { EngineModel, EngineParams } from '../../types/engine.types.js';
import type { ArtifactType } from '../../types/parsed-artifact.types.js';
import type { CaptureResult } from '../../types/artifact-form.types.js';

/**
 * Injected `artifact.prefill` call. The engine owns language mapping, the hidden-language rule and
 * file-name rejection; the capture only gathers text. `undefined` = refused (the caller already toasted).
 *
 * @param p - Engine params.
 * @returns The engine's model, or `undefined` on error.
 * @example
 * const prefill: PrefillFn = p => requestOrNotify('artifact.prefill', p);
 */
export type PrefillFn = (p: EngineParams<'artifact.prefill'>) => Promise<EngineModel | undefined>;

/**
 * Editor-selection input for `captureEditor` — the primary selection's text
 * and its document's `languageId`. Deliberately not `vscode.TextEditor`: this
 * module stays `vscode`-free so it is unit-testable without a host.
 */
export interface EditorSelection {
    /** Selected text (primary selection only; secondary cursors ignored). */
    text: string;
    /** `editor.document.languageId` of the source document. */
    languageId: string;
}

/**
 * Captures an editor selection for the create form via `artifact.prefill`.
 * Empty selection yields `undefined` without a request.
 *
 * @param sel - Primary selection text and `languageId`.
 * @param type - Target artifact type.
 * @param prefill - Injected engine call.
 * @returns A `CaptureResult` with `source: 'selection'`, or `undefined`.
 * @example
 * await captureEditor({ text: 'const x = 1;', languageId: 'typescriptreact' }, 'Snippet', prefill);
 */
export async function captureEditor(sel: EditorSelection, type: ArtifactType, prefill: PrefillFn): Promise<CaptureResult | undefined> {
    if (sel.text === '') {
        return undefined;
    }
    const m = await prefill({ source: 'selection', type, text: sel.text, languageId: sel.languageId });
    return m && { prefill: fromEngineModel(m), source: 'selection' };
}
