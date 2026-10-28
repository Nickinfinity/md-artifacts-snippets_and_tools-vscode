import type { ParsedArtifactFile, ParsedVar } from './parsed-artifact.types.js';

// ── Shared ────────────────────────────────────────────────────────────────────

/**
 * Plain-data snapshot of a parsed artifact file, safe to transmit over the
 * `postMessage` / `onDidReceiveMessage` boundary (no methods, no circular refs).
 *
 * Structurally identical to `ParsedArtifactFile` — defined as an alias so
 * message types can reference it without importing the parser type directly.
 *
 * @example
 * const msg: FileUpdatedMsg = { command: 'fileUpdated', artifact: parsedArtifact };
 */
export type SerializedArtifact = ParsedArtifactFile;

// ── Webview → Extension ───────────────────────────────────────────────────────

/**
 * Webview notifies the extension that the user began editing a section.
 * The extension should call `PreviewModeController.startEditingSection`.
 *
 * @example
 * vscode.postMessage({ command: 'startEdit', section: 'title' });
 */
export interface StartEditMsg {
    command: 'startEdit';
    section: 'title' | 'description' | 'varDefaults';
}

/**
 * Webview saves an edited `title` value.
 *
 * @example
 * vscode.postMessage({ command: 'saveSection', section: 'title', value: 'New Title' });
 */
export interface SaveSectionTitleMsg {
    command: 'saveSection';
    section: 'title';
    value: string;
}

/**
 * Webview saves an edited `description` value.
 *
 * @example
 * vscode.postMessage({ command: 'saveSection', section: 'description', value: 'Updated.' });
 */
export interface SaveSectionDescriptionMsg {
    command: 'saveSection';
    section: 'description';
    value: string;
}

/**
 * Webview saves updated variable default values.
 *
 * @example
 * vscode.postMessage({ command: 'saveSection', section: 'varDefaults', value: { 'VK-host': 'localhost' } });
 */
export interface SaveSectionVarDefaultsMsg {
    command: 'saveSection';
    section: 'varDefaults';
    value: Record<string, string>;
}

/**
 * Union of all `saveSection` message variants, discriminated by `section`.
 *
 * @example
 * function handle(msg: SaveSectionMsg) {
 *   if (msg.section === 'varDefaults') { msg.value; // Record<string,string> }
 * }
 */
export type SaveSectionMsg =
    | SaveSectionTitleMsg
    | SaveSectionDescriptionMsg
    | SaveSectionVarDefaultsMsg;

/**
 * Webview cancels an in-progress section edit without saving.
 *
 * @example
 * vscode.postMessage({ command: 'cancelEdit', section: 'title' });
 */
export interface CancelEditMsg {
    command: 'cancelEdit';
    section: string;
}

/**
 * Webview requests that the code area switch to a `<textarea>` for inline editing
 * (`quickEdit` mode).
 *
 * @example
 * vscode.postMessage({ command: 'quickEdit' });
 */
export interface QuickEditMsg {
    command: 'quickEdit';
}

/**
 * Webview requests that the extension open the artifact code in a real VS Code
 * editor tab via `TempDocument` (`fullEdit` mode).
 *
 * @example
 * vscode.postMessage({ command: 'fullEdit' });
 */
export interface FullEditMsg {
    command: 'fullEdit';
}

/**
 * Webview requests that the extension return from `quickEdit` back to `preview` mode.
 *
 * @example
 * vscode.postMessage({ command: 'backToPreview' });
 */
export interface BackToPreviewMsg {
    command: 'backToPreview';
}

/**
 * Webview confirms the insert, providing the raw typed `<VK-xxx>` values.
 * The extension renders the code with them through the engine (`artifact.render`)
 * and calls `performInsert` with the result.
 *
 * @example
 * vscode.postMessage({ command: 'insert', vars: { 'VK-host': 'localhost' } });
 */
export interface InsertMsg {
    command: 'insert';
    vars: Record<string, string>;
}

/**
 * Webview requests that the extension copy the resolved code to the clipboard,
 * for every artifact type — the single-block preview's one button, or one
 * block's button when reached via the multi-block navigator (T2). Resolution
 * mirrors `insert`: current code + raw values through the engine's
 * `artifact.render`, clipboard only — never the cursor or terminal.
 *
 * @example
 * vscode.postMessage({ command: 'copy', vars: { 'VK-host': 'localhost' }, code: 'ping <VK-host>' });
 */
export interface CopyMsg {
    command: 'copy';
    vars: Record<string, string>;
    code: string;
}

/**
 * Webview (create/edit form) requests that a block's code be opened for
 * expanded editing in a real VS Code editor tab, via
 * `FormBlockExpandController` (T5). The extension answers with `blockUpdated`
 * once the user saves the expanded editor.
 *
 * @example
 * vscode.postMessage({ command: 'expandBlock', index: 0 });
 */
export interface ExpandBlockMsg {
    command: 'expandBlock';
    index: number;
}

/**
 * Webview cancels the entire artifact insert operation.
 *
 * @example
 * vscode.postMessage({ command: 'cancel' });
 */
export interface CancelMsg {
    command: 'cancel';
}

/**
 * Union of every message the webview can send to the extension.
 *
 * @example
 * panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMsg) => { ... });
 */
export type WebviewToExtensionMsg =
    | StartEditMsg
    | SaveSectionMsg
    | CancelEditMsg
    | QuickEditMsg
    | FullEditMsg
    | BackToPreviewMsg
    | InsertMsg
    | CopyMsg
    | ExpandBlockMsg
    | CancelMsg;

// ── Extension → Webview ───────────────────────────────────────────────────────

/**
 * Extension acknowledges a `saveSection` operation and reports success or failure.
 *
 * @example
 * panel.webview.postMessage({ command: 'sectionSaved', section: 'title', success: true });
 */
export interface SectionSavedMsg {
    command: 'sectionSaved';
    section: string;
    success: boolean;
}

/**
 * Extension pushes an updated `<VK-xxx>` var list to the webview after the user
 * edits the code in `fullEdit` mode (debounced, triggered by `onDidChangeTextDocument`).
 *
 * @example
 * panel.webview.postMessage({ command: 'updateVars', vars: extractVars(code) });
 */
export interface UpdateVarsMsg {
    command: 'updateVars';
    vars: ParsedVar[];
}

/**
 * Extension sends refreshed parsed artifact data to the webview after a `.md` file
 * write — e.g. after `patchFrontmatterField` or `patchVarDefaults` persists a change.
 *
 * @example
 * panel.webview.postMessage({ command: 'fileUpdated', artifact: parsedArtifact });
 */
export interface FileUpdatedMsg {
    command: 'fileUpdated';
    artifact: SerializedArtifact;
}

/**
 * Extension (create/edit form) reports a block's code updated after the user
 * saved the expanded temp editor — `FormBlockExpandController.onSaved`'s
 * `(index, code)` pair, forwarded to the webview so it can update that
 * block's in-page code area.
 *
 * @example
 * panel.webview.postMessage({ command: 'blockUpdated', index: 0, code: 'const x = 1;' });
 */
export interface BlockUpdatedMsg {
    command: 'blockUpdated';
    index: number;
    code: string;
}

/**
 * Union of every message the extension can send to the webview.
 *
 * @example
 * window.addEventListener('message', (e: MessageEvent<ExtensionToWebviewMsg>) => { ... });
 */
export type ExtensionToWebviewMsg =
    | SectionSavedMsg
    | UpdateVarsMsg
    | FileUpdatedMsg
    | BlockUpdatedMsg;
