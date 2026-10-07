import * as vscode from 'vscode';
import * as path from 'node:path';
import { getNonce } from '../../../utils/helpers.js';
import { renderVarSetFormHtml, parseVarSetFormPayload, parseVarsEditPayload } from './varsetForm.render.js';
import { validateVarPairs, validateSubSetHeadings, validateSubSetDescriptions } from '../../../services/varset-form.service.js';
import type { VarSetFormPayload, VarsEditPayload } from '../../../types/varset.types.js';

const FORM_VIEW_TYPE = 'mdArtifacts.varSetForm';

/**
 * Callback bag the var-set form panel is composed with — the repo's
 * established controller idiom (`PreviewCallbacks`, `MultiIndexCallbacks`).
 * The panel never imports the model-builder/slug/write service directly;
 * everything past "the user clicked Save" is reached through this bag, so
 * the renderer/panel and the write-path service stay independently buildable.
 */
export interface VarSetFormCallbacks {
    /** Checks a payload before writing; `ok: false` carries the failure reason to show the user. */
    validate(payload: VarSetFormPayload): { ok: true } | { ok: false; reason: string };
    /** Writes the validated payload to `Variables/<slug>.md`. */
    write(payload: VarSetFormPayload): Promise<void>;
    /** Posts a message back into the form webview. */
    post(msg: Record<string, unknown>): void;
    /** Closes the form (disposes the panel). */
    close(): void;
    /**
     * Writes an **edit-mode** payload back to the file it was opened from.
     *
     * Required in edit mode and unused in create mode — `openVarSetFormPanel`
     * throws before creating a panel when edit mode is asked for without it,
     * because an absent writer reached through the save branch would close the
     * tab having written nothing: a clean-looking close that silently discards
     * the edit. The bag is deliberately **not** a discriminated union on mode —
     * that form does not compile against this tree's three call sites, and it
     * also makes the "missing writer" test unwritable, since the bag lacking
     * this member would not be constructible.
     */
    writeEdit?(payload: VarsEditPayload): Promise<void>;
}

/**
 * Handles one inbound webview message for the var-set form.
 *
 * Exported as a pure function — separate from `openVarSetFormPanel` — because
 * no test in this repo can post a message into a real `WebviewPanel`; this is
 * what makes the save/cancel contract unit-testable against a fake bag.
 *
 * The save path branches on **`mode`**, never on which callbacks the bag
 * happens to carry: a create-mode bag that carried `writeEdit` would otherwise
 * silently take the edit path. Create mode is byte-identical to before.
 *
 * @param msg  - The raw message posted from the webview (`{ command, payload? }`).
 * @param cb   - Callback bag supplying validate/write/post/close (+ `writeEdit` in edit mode).
 * @param mode - Which save path to take; defaults to `'create'` so existing callers are untouched.
 * @param base - Edit mode only: the payload the panel was opened with, supplying the `heading` and
 *               `env` values the webview never posts back.
 * @returns Resolves once the message has been fully handled.
 *
 * @example
 * await handleVarSetFormMessage({ command: 'save', payload }, cb);
 * await handleVarSetFormMessage({ command: 'save', payload }, cb, 'edit', openedWith);
 */
export async function handleVarSetFormMessage(
    msg: Record<string, unknown>,
    cb: VarSetFormCallbacks,
    mode: 'create' | 'edit' = 'create',
    base?: VarsEditPayload,
): Promise<void> {
    if (msg.command === 'cancel') {
        cb.close();
        return;
    }

    if (msg.command !== 'save') {
        return;
    }

    if (mode === 'edit') {
        await handleEditSave(msg, cb, base);
        return;
    }

    const payload = parseVarSetFormPayload(msg.payload);
    if (!payload) {
        cb.post({ command: 'saveFailed', reason: 'Malformed payload.' });
        return;
    }

    const result = cb.validate(payload);
    if (!result.ok) {
        cb.post({ command: 'saveFailed', reason: result.reason });
        return;
    }

    await cb.write(payload);
    cb.close();
}

/**
 * The edit-mode half of the save branch: shape-guard, content-validate, write.
 *
 * Bypasses `validate`/`write` deliberately — `validateVarSetForm` iterates
 * `payload.pairs`, which the grouped edit shape does not have, and its title
 * check is a slug rule belonging to the create path. It does **not** bypass the
 * content check: `validateVarPairs` runs over every sub-set's rows, because
 * names and values reach the ` ```vks ` fence verbatim and this payload is
 * webview text the user just typed — strictly more hostile than create's.
 *
 * Headings come off the wire when posted — the form can rename and delete
 * sub-sets, so the webview's list is the only one aligned to its rows — and
 * are checked by `validateSubSetHeadings` before any write. `env` is always
 * re-attached from `base`; it is never rendered, so the webview cannot touch it.
 *
 * @param msg  - The raw `save` message from the webview.
 * @param cb   - Callback bag; `writeEdit` is guaranteed present by the open-time guard.
 * @param base - The payload the panel was opened with (`env`, legacy headings).
 * @returns Resolves once the edit has been written or refused.
 *
 * @example
 * await handleEditSave({ command: 'save', payload }, cb, openedWith);
 */
async function handleEditSave(
    msg: Record<string, unknown>,
    cb: VarSetFormCallbacks,
    base?: VarsEditPayload,
): Promise<void> {
    const wire = parseVarsEditPayload(msg.payload);
    if (!wire || !base) {
        cb.post({ command: 'saveFailed', reason: 'Malformed payload.' });
        return;
    }

    for (const group of wire.pairs) {
        const check = validateVarPairs(group);
        if (!check.ok) {
            cb.post({ command: 'saveFailed', reason: check.reason });
            return;
        }
    }

    // Posted headings are authoritative: after a delete the base is no longer
    // index-aligned to the rows, so falling back to it per slot would hand one
    // sub-set another's name. Only a payload with no headings at all (an older
    // client) takes the base's, by index — nothing could have moved then.
    const headings = wire.headings
        ? wire.headings.map(h => h.trim())
        : wire.pairs.map((_, i) => base.subSets[i]?.heading ?? '');
    const headingCheck = validateSubSetHeadings(headings);
    if (!headingCheck.ok) {
        cb.post({ command: 'saveFailed', reason: headingCheck.reason });
        return;
    }

    // Same rule as headings: posted descriptions win; only an older client
    // that posts none keeps the file's, by index.
    const descriptions = wire.descriptions
        ? wire.descriptions.map(d => d.trim())
        : wire.pairs.map((_, i) => base.subSets[i]?.description ?? '');
    const descriptionCheck = validateSubSetDescriptions(descriptions);
    if (!descriptionCheck.ok) {
        cb.post({ command: 'saveFailed', reason: descriptionCheck.reason });
        return;
    }

    const payload: VarsEditPayload = {
        title:       wire.title,
        description: wire.description,
        tags:        wire.tags,
        env:         base.env,
        subSets:     wire.pairs.map((pairs, i) => ({ heading: headings[i], description: descriptions[i], pairs })),
    };

    await cb.writeEdit?.(payload);
    cb.close();
}

/**
 * Options for opening the var-set form panel — mirrors `OpenFormOpts`
 * (`artifactForm/panel.ts:32`) rather than inventing a second create/edit
 * spelling: `mode` picks the branch, `values`/`tags` seed create mode,
 * `payload`/`sourceUri` seed edit mode.
 *
 * @example
 * { mode: 'create', values: { 'VK-host': 'localhost' }, tags: ['api'] }
 * { mode: 'edit', payload, sourceUri: vscode.Uri.file('/v/Variables/bundles.md') }
 */
export interface OpenVarSetFormOpts {
    /** `'create'` (today's flow) or `'edit'` (opens an existing file's parsed payload). */
    mode: 'create' | 'edit';
    /** Create mode: current non-empty variable values, keyed by full `VK-xxx` name. */
    values?: Record<string, string>;
    /** Create mode: tags carried over from the active artifact. */
    tags?: string[];
    /** Edit mode: the file's parsed payload — required in edit mode. */
    payload?: VarsEditPayload;
    /** Edit mode: the file the payload was parsed from — required in edit mode, used for the tab title. */
    sourceUri?: vscode.Uri;
}

/**
 * Opens the variable-set form panel — create mode (today's flow, byte-identical)
 * or edit mode (a parsed `Variables/*.md` file, opened for in-place editing).
 *
 * Takes `extensionUri`, not `ExtensionContext` — there is no source for a
 * context here (`VarSetController`'s constructor is the same shape), and the
 * form has no block-expand or storage need beyond it.
 *
 * **Edit mode refuses to open without a writer.** `handleVarSetFormMessage`'s
 * edit-save branch ends `await cb.writeEdit?.(payload); cb.close();` — an
 * absent `writeEdit` would silently close the tab having written nothing. This
 * function throws *before* `vscode.window.createWebviewPanel` is called, so no
 * panel is ever created for a bag that cannot honour a save.
 *
 * The branch is keyed on `opts.mode`, **never** on whether `cb.writeEdit` is
 * present — a create-mode call whose bag happens to carry `writeEdit` still
 * takes the create path and title.
 *
 * @param extensionUri - Extension root URI, for `localResourceRoots` and stylesheet URIs.
 * @param cb           - Callback bag supplying validate/write/post/close (+ `writeEdit` in edit mode).
 * @param opts         - See {@link OpenVarSetFormOpts}.
 *
 * @example
 * openVarSetFormPanel(context.extensionUri, cb, { mode: 'create', values: { 'VK-host': 'localhost' }, tags: ['api'] });
 * openVarSetFormPanel(context.extensionUri, cb, { mode: 'edit', payload, sourceUri });
 */
export function openVarSetFormPanel(
    extensionUri: vscode.Uri,
    cb: VarSetFormCallbacks,
    opts: OpenVarSetFormOpts,
): void {
    if (opts.mode === 'edit' && !cb.writeEdit) {
        throw new Error('openVarSetFormPanel: edit mode requires cb.writeEdit.');
    }

    const uiRoot = vscode.Uri.joinPath(extensionUri, 'src', 'ui');
    const title = opts.mode === 'edit' && opts.sourceUri
        ? vscode.l10n.t('Edit Variable Set: {0}', path.basename(opts.sourceUri.fsPath, '.md'))
        : vscode.l10n.t('Save Variable Set');

    const panel = vscode.window.createWebviewPanel(
        FORM_VIEW_TYPE,
        title,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [uiRoot],
        },
    );

    // codicon.css is vendored in src/ui (see CLAUDE.md "One runtime dependency").
    const sheets = opts.mode === 'edit' ? ['base.css', 'codicon.css', 'form.css'] : ['base.css', 'form.css'];
    const cssUris = sheets.map(f =>
        panel.webview.asWebviewUri(vscode.Uri.joinPath(uiRoot, f)).toString());

    const payload: VarSetFormPayload | VarsEditPayload = opts.mode === 'edit' && opts.payload
        ? opts.payload
        : {
            title: '',
            description: '',
            tags: opts.tags ?? [],
            pairs: Object.entries(opts.values ?? {}),
        };

    panel.webview.html = renderVarSetFormHtml(payload, cssUris, panel.webview.cspSource, getNonce(), opts.mode);

    const bag: VarSetFormCallbacks = {
        ...cb,
        post: (msg) => { void panel.webview.postMessage(msg); },
        close: () => { panel.dispose(); cb.close(); },
    };

    const editBase = opts.mode === 'edit' ? opts.payload : undefined;
    panel.webview.onDidReceiveMessage((msg: unknown) => {
        void handleVarSetFormMessage(msg as Record<string, unknown>, bag, opts.mode, editBase);
    });
}
