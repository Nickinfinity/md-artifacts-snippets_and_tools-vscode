import { fromEngineModel } from '../../engine/model.js';
import type { PrefillFn } from './editor.capture.js';
import type { ArtifactType } from '../../types/parsed-artifact.types.js';
import type { CaptureResult } from '../../types/artifact-form.types.js';

/**
 * Explorer single-file input for `captureExplorerFile` — the workspace
 * file's name, its already-read contents, and its `languageId`.
 * Deliberately not a `vscode.Uri`: this module stays `vscode`-free so it is
 * unit-testable without a host, and the caller (not this function) does the
 * `workspace.fs.readFile`.
 */
export interface ExplorerFileInput {
    /**
     * File name as reported by the workspace. Untrusted: a workspace file
     * is authored by whoever owns that workspace, not by this extension, so
     * this is rejected by the engine (`naming.path_injection`) before it can reach `target:`
     * or `extension:` frontmatter.
     */
    fileName: string;
    /** Full file contents, already read by the caller. */
    contents: string;
    /** `document.languageId` (or equivalent) for the source file. */
    languageId: string;
}

/** Max accepted `contents` length — 512 KiB, measured in UTF-16 code units (`string.length`), not bytes. */
const MAX_CONTENTS_LENGTH = 512 * 1024;

/**
 * Captures a single workspace file for the create form via `artifact.prefill`.
 * Oversized contents are refused before any request; a hostile name is rejected by the engine
 * (never trimmed here), which yields `undefined`.
 *
 * @param input - `{ fileName, contents, languageId }`.
 * @param type - Target artifact type.
 * @param prefill - Injected engine call.
 * @returns A `CaptureResult` with `source: 'file'`, or `undefined`.
 * @example
 * await captureExplorerFile({ fileName: 'CLAUDE.md', contents: '# hi', languageId: 'markdown' }, 'AIAgentsConfig', prefill);
 */
export async function captureExplorerFile(input: ExplorerFileInput, type: ArtifactType, prefill: PrefillFn): Promise<CaptureResult | undefined> {
    if (input.contents.length > MAX_CONTENTS_LENGTH) {
        return undefined;
    }
    const m = await prefill({ source: 'file', type, text: input.contents, languageId: input.languageId, fileName: input.fileName });
    return m && { prefill: fromEngineModel(m), source: 'file' };
}
