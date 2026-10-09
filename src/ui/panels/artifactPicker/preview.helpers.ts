import * as vscode from 'vscode';
import { resolveVars, parseFromContent } from '../../../services/parser.service.js';
import { patchBlockCode, type BlockRef } from '../../../services/artifact-patcher.service.js';
import { out } from './shared.js';
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
 * Wraps terminal-bound content in bracketed-paste markers so a multi-line
 * payload arrives as **one block of text** instead of as keystrokes that
 * submit themselves line by line.
 *
 * `terminal.sendText(content, false)` suppresses only the *trailing* newline.
 * Every newline *inside* the payload still reaches the shell as if the user
 * pressed Enter there — correct for a `Command` (running it is the point),
 * wrong for an `AIPrompt`, whose payload is multi-line markdown by design and
 * is meant to land in a CLI agent's input the way Shift+Enter does.
 *
 * Bracketed paste is the mechanism a real terminal paste uses: the receiving
 * program sees `ESC[200~ … ESC[201~` and treats everything between as literal
 * text, so the newlines become part of the input rather than executing it.
 * Nothing runs until the user presses Enter themselves.
 *
 * Scoped to both-context types, so the pre-existing `Command` path
 * (`contexts: ['terminal']` only) is byte-identical, and skipped for
 * single-line content, which has nothing to protect.
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
 * wrapForTerminal('Command', 'a\nb');  // → 'a\nb' (unchanged — meant to run)
 * wrapForTerminal('AIPrompt', 'one');   // → 'one' (single line, nothing to protect)
 */
export function wrapForTerminal(type: ArtifactType, content: string): string {
    if (!content.includes('\n') || !hasBothContexts(getEntry(type).contexts)) {
        return content;
    }
    return `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`;
}

/**
 * Whether `performInsert` should confirm before sending `content` to the
 * terminal.
 *
 * Vault content is untrusted. {@link wrapForTerminal} stops a multi-line
 * payload from submitting itself, but bracketed-paste support cannot be
 * detected from the extension host, so a shell with it disabled would still
 * act on each newline. This confirmation is the backstop for that case.
 *
 * Scoped so the pre-existing `Command` path (`contexts: ['terminal']` only) is
 * byte-identical — it never confirms.
 *
 * @param type    - Canonical `ArtifactType` literal (looked up via `getEntry`).
 * @param content - The fully variable-resolved text about to be sent.
 * @returns `true` when the confirmation modal should fire.
 *
 * @example
 * needsTerminalConfirmation('AIPrompt', 'line one\nline two'); // → true
 * needsTerminalConfirmation('Command', 'line one\nline two');  // → false (['terminal']-only, unchanged)
 */
export function needsTerminalConfirmation(type: ArtifactType, content: string): boolean {
    return content.includes('\n') && hasBothContexts(getEntry(type).contexts);
}

/** Longest single preview line shown in the terminal-confirm modal before truncation. */
const CONFIRM_PREVIEW_LINE_MAX = 200;
/** Longest run of leading lines shown in the terminal-confirm modal's preview. */
const CONFIRM_PREVIEW_LINE_COUNT = 3;

/**
 * Builds the modal `detail` text for the terminal-send confirmation: line
 * count, what is about to happen, and a short truncated preview so the user
 * can recognise the payload.
 *
 * @param content - The fully variable-resolved text about to be sent.
 * @returns The `detail` string for `vscode.window.showWarningMessage`.
 * @example terminalConfirmDetail('echo hi\nrm -rf /'); // → '2 lines will be pasted…'
 */
function terminalConfirmDetail(content: string): string {
    const lines = content.split('\n');
    const clamp = (line: string): string =>
        line.length > CONFIRM_PREVIEW_LINE_MAX ? `${line.slice(0, CONFIRM_PREVIEW_LINE_MAX)}…` : line;
    const preview = lines.slice(0, CONFIRM_PREVIEW_LINE_COUNT).map(clamp).join('\n')
        + (lines.length > CONFIRM_PREVIEW_LINE_COUNT ? '\n…' : '');

    return vscode.l10n.t(
        '{0} lines will be pasted into the terminal as one block, without pressing Enter. If the receiving shell does not support bracketed paste, each line could run on its own.',
        lines.length,
    ) + `\n\n${preview}`;
}

/**
 * Substitutes variables and delivers resolved content to the editor, terminal, or clipboard.
 *
 * The target surface is decided by {@link resolveInsertTarget} from the artifact's
 * declared `contexts` plus the invocation surface — never an
 * `artifactType === 'Command'` literal here. A `'terminal'` target always
 * writes (creating a terminal if none exists). A multi-line payload goes
 * through {@link wrapForTerminal} so it pastes as one block instead of
 * submitting itself line by line, and {@link needsTerminalConfirmation}
 * gates it behind a modal first — vault content is untrusted and
 * bracketed-paste support cannot be detected. Cancelling (or dismissing) the
 * modal sends nothing. An `'editor'` target falls back to the clipboard when
 * `editor` is `undefined`.
 *
 * @param editor            - Active text editor to insert into, or `undefined` when none is open.
 * @param artifact          - Artifact supplying the code template and type.
 * @param vars              - Resolved `{ name → value }` map from the edit panel or input box.
 * @param invocationSurface - Which menu the insert command was invoked from; see {@link InvocationSurface}.
 *
 * @example
 * await performInsert(vscode.window.activeTextEditor, artifact, { 'VK-host': 'localhost' }, 'editor');
 */
export async function performInsert(
    editor: vscode.TextEditor | undefined,
    artifact: ParsedArtifactFile,
    vars: Record<string, string>,
    invocationSurface: InvocationSurface
): Promise<void> {
    const content = resolveVars(artifact.code, vars);
    const target = resolveInsertTarget(artifact.frontmatter.artifactType, invocationSurface);

    if (target === 'terminal') {
        if (needsTerminalConfirmation(artifact.frontmatter.artifactType, content)) {
            // Hoisted per call, not module scope, so `vscode.l10n.t` runs after
            // the bundle is loaded; the read-back (`choice !== SEND_LABEL`)
            // still compares one binding on both sides.
            const SEND_LABEL = vscode.l10n.t('Send');
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t('Send multi-line content to the terminal?'),
                { modal: true, detail: terminalConfirmDetail(content) },
                SEND_LABEL,
            );
            if (choice !== SEND_LABEL) { return; }
        }
        const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('MD Artifacts');
        terminal.sendText(wrapForTerminal(artifact.frontmatter.artifactType, content), false);
        terminal.show(true);
        return;
    }
    if (editor) {
        editor.edit(edit => edit.insert(editor.selection.active, content));
        return;
    }
    // No clipboard fallback: Copy is a dedicated button beside Insert and
    // resolves identically, so a silent copy here was one button doing two
    // different things depending on state the user cannot see. The preview
    // hides Insert outright when no editor is open, so this is now only
    // reachable if the last editor closed between render and click.
    vscode.window.showWarningMessage(vscode.l10n.t('MD Artifacts: No editor open to insert into. Use Copy instead.'));
}

/**
 * Writes new code for one block back into its source `.md`.
 *
 * **THE** block-code persist path. Both routes that make an edit permanent —
 * the preview's Overwrite button and anything else that needs to commit a
 * block — go through here, so the patch/write/re-parse sequence and its
 * "block not found" guard exist once. `patchBlockCode` remains the only thing
 * that understands fence structure; this adds the I/O around it.
 *
 * @param opts - `sourceUri` of the `.md`, the `blockRef` identifying the fence,
 *               the `newCode`, and `rootFs` for re-parsing.
 * @returns The re-parsed artifact on success; `undefined` when the block could
 *          not be located or the write failed (both already logged).
 *
 * @example
 * const updated = await persistBlockCode({ sourceUri, blockRef, newCode, rootFs });
 * if (updated) { setCache(sourceUri, updated); }
 */
export async function persistBlockCode(opts: {
    sourceUri: vscode.Uri;
    blockRef:  BlockRef;
    newCode:   string;
    rootFs:    string;
}): Promise<ParsedArtifactFile | undefined> {
    try {
        const bytes   = await vscode.workspace.fs.readFile(opts.sourceUri);
        const content = new TextDecoder().decode(bytes);
        const patched = patchBlockCode(content, opts.blockRef, opts.newCode);
        if (patched === content) {
            out.appendLine('[persistBlockCode] no change (block not found?)');
            return undefined;
        }
        await vscode.workspace.fs.writeFile(opts.sourceUri, new TextEncoder().encode(patched));
        return parseFromContent(patched, opts.sourceUri.fsPath, opts.rootFs);
    } catch (e) {
        out.appendLine(`[persistBlockCode] failed: ${(e as Error).message}`);
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
