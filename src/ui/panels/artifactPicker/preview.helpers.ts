import * as vscode from 'vscode';
import type { BlockRef } from './preview.types.js';
import { getEngine } from '../../../engine/engine.vscode.js';
import { engineMeta, toEngineModel } from '../../../engine/model.js';
import { EngineRequestError } from '../../../engine/request-error.js';
import { handleWriteError, sendWrite } from '../../../services/conflict.service.js';
import { artifactToFormModel } from '../../../commands/create-prefill.helpers.js';
import type { ArtifactFormModel } from '../../../types/artifact-form.types.js';
import { out } from './shared.js';
import { rereadBlock } from './preview.reread.js';
import { getEntry } from '../../../services/artifact-type-config.service.js';
import type { ArtifactContext } from '../../../types/artifact.types.js';
import type { ArtifactType, ParsedArtifactFile, ParsedBlock } from '../../../types/parsed-artifact.types.js';
import { styleLinkTags } from '../../../utils/html.js';

/**
 * Converts a `VK-xxx` variable name to a human-readable input label.
 *
 * Strips the `VK-` prefix, replaces `_` separators with spaces, lowercases
 * the result, then capitalises the first letter.
 *
 * @param name - Full variable name including the `VK-` prefix.
 * @returns Human-readable label string.
 *
 * @example
 * labelForVar('VK-min_price')  // → 'Min price'
 * labelForVar('VK-MY_VAR')     // → 'My var'
 */
export function labelForVar(name: string): string {
    const hint   = name.startsWith('VK-') ? name.slice(3) : name;
    const joined = hint.replaceAll('_', ' ').toLowerCase();
    return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Wraps popup body content in a complete HTML document that loads the shared stylesheet.
 *
 * @param body      - Inner HTML to place inside `<body>`.
 * @param cssUri    - Webview URI for the shared stylesheet.
 * @param cspSource - Webview CSP source token; falls back to `'unsafe-inline'` before
 *                    the panel is created (e.g. for the initial empty-state render).
 * @returns Complete HTML document string.
 *
 * @example
 * return popupShell('<p>Hello</p>', cssUri, cspSource);
 */
export function popupShell(body: string, cssUri: string | string[], cspSource = "'unsafe-inline'"): string {
    const linkTag = styleLinkTags(cssUri);
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource};">
${linkTag}
</head>
<body class="popup-body">${body}</body>
</html>`;
}

/**
 * Adapts a `ParsedBlock` into a minimal `ParsedArtifactFile` so it can be passed
 * to preview/insert helpers without changes.
 *
 * Inherits `frontmatter`, `filePath`, `fileName`, and `relativePath` from the
 * parent artifact; overrides `title`, `description`, `language`, `code`, `vars`,
 * and clears `blocks` (blocks never nest).
 *
 * @param block  - The block to adapt.
 * @param parent - The artifact the block belongs to.
 * @returns A `ParsedArtifactFile`-shaped object for the block.
 *
 * @example
 * const adapted = blockAsArtifact(item.block, currentArtifact);
 */
export function blockAsArtifact(block: ParsedBlock, parent: ParsedArtifactFile): ParsedArtifactFile {
    return {
        ...parent,
        frontmatter: {
            ...parent.frontmatter,
            title:       block.heading,
            description: block.description || undefined,
            language:    block.fenceLang ?? parent.frontmatter.language,
        },
        code:   block.code,
        vars:   block.vars,
        blocks: [],
    };
}

/**
 * Which context-menu surface an insert command was invoked from — statically
 * known from the command id that fired (the base id vs. its `.terminal`
 * sibling registered for both-context types), never a live focus read. See
 * `registerInsertCommands` (`insert.command.ts`) for where this is captured.
 */
export type InvocationSurface = 'editor' | 'terminal';

/**
 * Where `performInsert` ultimately writes the resolved content. Shares
 * `InvocationSurface`'s two literal values today, but is kept as a distinct
 * type: this is the *decision* `resolveInsertTarget` produces, not the *input*
 * fact of which menu was clicked.
 */
export type InsertTarget = 'terminal' | 'editor';

/**
 * True when `contexts` declares **both** `'editor'` and `'terminal'` — the one
 * D6 row that needs to distinguish which menu invoked it. The single
 * authority both `resolveInsertTarget` and `needsTerminalConfirmation` key
 * off, so the insert-target decision and the terminal-confirm decision can
 * never disagree about which types this applies to.
 *
 * @param contexts - An artifact's declared `contexts` field.
 * @returns Whether both surfaces are declared.
 * @example hasBothContexts(['editor', 'terminal']) // → true
 */
function hasBothContexts(contexts: readonly ArtifactContext[]): boolean {
    return contexts.includes('editor') && contexts.includes('terminal');
}

/**
 * Decides which surface an artifact's resolved content should land on.
 *
 * Reads the type's declared `contexts` via `getEntry` — never a
 * `artifactType === 'X'` literal — and applies D6's three-row table:
 *  1. `contexts` is exactly `['terminal']` → always `'terminal'`.
 *  2. `contexts` contains **both** `'editor'` and `'terminal'` → the
 *     invocation surface decides, verbatim.
 *  3. Anything else (including `['all']`, e.g. `Variables`) → always
 *     `'editor'`. This row never routes to the terminal, regardless of
 *     `invocationSurface`. `performInsert` falls back to the clipboard when
 *     no editor is actually available — that is a runtime-availability
 *     concern this pure resolver has no way to know.
 *
 * @param type              - Canonical `ArtifactType` literal (looked up via `getEntry`).
 * @param invocationSurface - Which menu the command was invoked from; see {@link InvocationSurface}.
 * @returns The surface `performInsert` should write to.
 *
 * @example
 * resolveInsertTarget('Command', 'editor');    // → 'terminal' (contexts: ['terminal'])
 * resolveInsertTarget('Variables', 'terminal'); // → 'editor'   (contexts: ['all'], never terminal)
 * resolveInsertTarget('AIPrompt', 'terminal');  // → 'terminal' (contexts: ['editor', 'terminal'])
 */
export function resolveInsertTarget(type: ArtifactType, invocationSurface: InvocationSurface): InsertTarget {
    const { contexts } = getEntry(type);

    if (contexts.length === 1 && contexts[0] === 'terminal') {
        return 'terminal';
    }
    if (hasBothContexts(contexts)) {
        return invocationSurface;
    }
    return 'editor';
}

/**
 * Answers whether there is an editor tab open to insert into.
 *
 * `visibleTextEditors`, deliberately **not** `activeTextEditor`: the latter is
 * focus-sensitive and goes `undefined` whenever a webview takes focus, so a
 * button gated on it would vanish exactly while the user is working in the
 * preview pane. "A tab is open" is the question Insert actually depends on,
 * and it is focus-independent.
 *
 * @returns `true` when at least one text editor is visible in the workbench.
 *
 * @example
 * hasVisibleEditor(); // → false in an empty workbench, true with any file open
 */
export function hasVisibleEditor(): boolean {
    return vscode.window.visibleTextEditors.length > 0;
}

/** Bracketed-paste start marker — tells the receiving program "literal text follows". */
const BRACKETED_PASTE_START = '\x1b[200~';
/** Bracketed-paste end marker. */
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Any C0 control except tab (`\t`), plus DEL. A newline, a bare CR (Enter) and Ctrl-O (0x0F, which
 * also runs the line in bash) all submit what was typed, so none may reach a shell unpasted. ESC is
 * inside the range but is refused earlier, on the engine's `containsEscape`.
 */
const TERMINAL_CONTROL = /[\0-\x08\x0a-\x1f\x7f]/;

/**
 * THE terminal-block predicate: `content` carries a control character and `type` can reach the
 * terminal. Shared by {@link wrapForTerminal} and {@link needsTerminalConfirmation} so they cannot disagree.
 *
 * @param type    - Canonical `ArtifactType` literal (looked up via `getEntry`).
 * @param content - The fully variable-resolved text about to be sent.
 * @returns Whether the payload must be pasted as a block and confirmed.
 * @example reachesTerminalAsBlock('Command', 'a\nb') // → true
 */
function reachesTerminalAsBlock(type: ArtifactType, content: string): boolean {
    return TERMINAL_CONTROL.test(content) && getEntry(type).contexts.includes('terminal');
}

/**
 * Wraps terminal-bound content in bracketed-paste markers so a multi-line
 * payload arrives as **one block of text** instead of as keystrokes that
 * submit themselves line by line.
 *
 * `terminal.sendText(content, false)` suppresses only the *trailing* newline;
 * every control character inside the payload still reaches the shell as if
 * typed. Bracketed paste (`ESC[200~ … ESC[201~`) makes the receiving program
 * treat everything between as literal text. Nothing runs until the user
 * presses Enter. Applies to every type that can reach the terminal (`Command`
 * and `AIPrompt`); single-line, control-free content has nothing to protect.
 *
 * ponytail: assumes the receiving program has bracketed paste enabled — true
 * for bash 4.4+, zsh, fish and the CLI agents this targets. A shell with it
 * disabled would show the markers literally and still run each line, and
 * support cannot be detected from the extension host, which is why
 * {@link needsTerminalConfirmation} still fires.
 *
 * @param type    - Canonical `ArtifactType` literal (looked up via `getEntry`).
 * @param content - The fully variable-resolved text about to be sent.
 * @returns The exact string to hand to `terminal.sendText`.
 *
 * @example
 * wrapForTerminal('AIPrompt', 'a\nb'); // → '\x1b[200~a\nb\x1b[201~'
 * wrapForTerminal('Command', 'a\nb');  // → '\x1b[200~a\nb\x1b[201~'
 * wrapForTerminal('Command', 'ls');    // → 'ls' (single line, nothing to protect)
 */
export function wrapForTerminal(type: ArtifactType, content: string): string {
    return reachesTerminalAsBlock(type, content)
        ? `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`
        : content;
}

/**
 * Whether `performInsert` should confirm before sending `content` to the
 * terminal.
 *
 * Vault content is untrusted. {@link wrapForTerminal} stops a payload from
 * submitting itself, but bracketed-paste support cannot be detected from the
 * extension host, so a shell with it disabled would still act on each control
 * character. This confirmation is the backstop. Same predicate as the wrap.
 *
 * @param type    - Canonical `ArtifactType` literal (looked up via `getEntry`).
 * @param content - The fully variable-resolved text about to be sent.
 * @returns `true` when the confirmation modal should fire.
 *
 * @example
 * needsTerminalConfirmation('AIPrompt', 'line one\nline two'); // → true
 * needsTerminalConfirmation('Command', 'line one\nline two');  // → true
 * needsTerminalConfirmation('Command', 'ls');                  // → false
 */
export function needsTerminalConfirmation(type: ArtifactType, content: string): boolean {
    return reachesTerminalAsBlock(type, content);
}

/**
 * THE block-code persist path: `artifact.patch` under the hash of the read being previewed; a flagged
 * file (`not_serializable{flagged}`) falls back to `artifact.update` from a fresh read, one block swapped.
 * Conflict ⇒ modal, other errors ⇒ toast; both give `undefined`.
 *
 * @param opts - Previewed `artifact` (needs engine meta), `blockRef`, `newCode`, `onReload` for the modal.
 * @returns `file` = whole re-read, `current` = what the preview shows; `undefined` if nothing was written.
 * @example
 * const r = await persistBlockCode({ artifact, blockRef, newCode });
 */
export async function persistBlockCode(opts: {
    artifact: ParsedArtifactFile; blockRef: BlockRef; newCode: string; onReload?: () => unknown;
}): Promise<{ file: ParsedArtifactFile; current: ParsedArtifactFile } | undefined> {
    const meta = engineMeta(opts.artifact);
    if (!meta) { out.appendLine('[persistBlockCode] artifact carries no engine hash'); return undefined; }
    const { relPath: path, hash: expectedHash } = meta, { blockRef, newCode: code, onReload } = opts;
    try {
        const before = await rereadBlock(path, blockRef);
        if (!before) { out.appendLine('[persistBlockCode] block not found'); return undefined; }
        const loc = blockRef.kind === 'single' ? {} : { block: before.index, heading: blockRef.heading };
        try {
            await getEngine().request('artifact.patch', { path, expectedHash, edit: { field: 'code', ...loc, code } });
        } catch (e) {
            if (!(e instanceof EngineRequestError) || e.data.code !== 'artifact.not_serializable' || e.data.params['reason'] !== 'flagged') { throw e; }
            const form = artifactToFormModel(before.file);
            const blocks = (form.blocks ?? []).map((b, i) => (i === before.index ? { ...b, code } : b));
            const model = toEngineModel({ ...form, blocks } as ArtifactFormModel, before.file); // narrowing: artifactToFormModel fills every field the model needs
            if (!await sendWrite('artifact.update', { path, expectedHash, model }, { onReload })) { return undefined; }
        }
        const after = await rereadBlock(path, blockRef);
        return after && { file: after.file, current: after.current };
    } catch (e) {
        try { await handleWriteError(e, { onReload }); } catch (x) { out.appendLine(`[persistBlockCode] failed: ${(x as Error).message}`); }
        return undefined;
    }
}

/** Keys that would reach `Object.prototype` if copied onto a plain `{}`. */
const UNSAFE_SNAPSHOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Copies a `varsSnapshot` payload into a null-prototype map of string values.
 *
 * **The keys are untrusted.** They come from `data-var` attributes rendered
 * from vault-authored content, and the webview's `collectVars()` builds a
 * plain `{}`, so `__proto__` / `constructor` / `prototype` would otherwise
 * reach a host-side object. Rejected outright — never renamed or escaped into
 * something that merely looks safe — and non-string values are dropped rather
 * than coerced, so a hostile payload cannot smuggle an object through.
 *
 * @param raw - The message's `values` field, of unknown shape.
 * @returns A null-prototype `Record<string, string>`; empty when `raw` is not an object.
 *
 * @example
 * sanitiseVarsSnapshot({ 'VK-host': 'localhost', __proto__: 'x' }); // { 'VK-host': 'localhost' }
 */
export function sanitiseVarsSnapshot(raw: unknown): Record<string, string> {
    const safe: Record<string, string> = Object.create(null) as Record<string, string>;
    if (typeof raw !== 'object' || raw === null) { return safe; }

    for (const [key, value] of Object.entries(raw)) {
        if (UNSAFE_SNAPSHOT_KEYS.has(key)) { continue; }
        if (typeof value === 'string') { safe[key] = value; }
    }
    return safe;
}
