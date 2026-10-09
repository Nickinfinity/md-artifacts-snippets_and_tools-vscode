import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { resolveInsertTarget, needsTerminalConfirmation, wrapForTerminal } from '../src/ui/panels/artifactPicker/preview.helpers.js';
import { ARTIFACTS } from '../src/types/constants.js';
import { artifactTerminalCommandId } from '../src/commands/insert.command.js';

/**
 * T3 — pure resolver that decides which surface `performInsert` writes to.
 * `vscode`-free by design: the invocation surface (which menu the command
 * fired from) is an explicit argument, correct by construction — no live
 * `vscode.window` focus reads, which VS Code has no predicate for anyway.
 * `performInsert` supplies the real invocation surface at the edge, captured
 * statically by `registerInsertCommands` (`insert.command.ts`).
 *
 * D6's three-row table, verbatim:
 *  - contexts === ['terminal']            → terminal, regardless of invocation surface
 *  - contexts contains editor AND terminal → the invocation surface, verbatim
 *  - anything else, including ['all']      → editor, never terminal
 */
suite('resolveInsertTarget (T3)', () => {

    test('Command (contexts: [terminal]) always resolves to terminal, regardless of invocation surface', () => {
        assert.strictEqual(resolveInsertTarget('Command', 'editor'), 'terminal');
        assert.strictEqual(resolveInsertTarget('Command', 'terminal'), 'terminal');
    });

    test('Snippet (contexts: [editor]) resolves to editor, regardless of invocation surface', () => {
        assert.strictEqual(resolveInsertTarget('Snippet', 'editor'), 'editor');
        // Snippet never gets a terminal-surface command registered, but the row
        // itself must ignore invocationSurface even if it somehow received one.
        assert.strictEqual(resolveInsertTarget('Snippet', 'terminal'), 'editor');
    });

    // Regression guard: contexts: ['all'] must land on the editor row, never the
    // terminal row — routing Variables to the terminal is a regression, not a feature.
    test('Variables (contexts: [all]) resolves to editor, never terminal — even invoked from the terminal surface', () => {
        assert.strictEqual(resolveInsertTarget('Variables', 'editor'), 'editor');
        assert.strictEqual(resolveInsertTarget('Variables', 'terminal'), 'editor');
    });

    // AIPrompt is the first type declaring both editor and terminal — the only
    // row resolved from the injected invocation surface.
    suite('AIPrompt (contexts: [editor, terminal]) resolves from the invocation surface', () => {
        test('invoked from the terminal surface → terminal', () => {
            assert.strictEqual(resolveInsertTarget('AIPrompt', 'terminal'), 'terminal');
        });

        test('invoked from the editor surface → editor', () => {
            assert.strictEqual(resolveInsertTarget('AIPrompt', 'editor'), 'editor');
        });
    });
});

/**
 * `terminal.sendText` executes every internal newline as if typed — harmless
 * for `Command` (its whole point is to run), but a hazard for a both-context
 * type like `AIPrompt`: untrusted vault content that can carry a fenced
 * `bash` block. `needsTerminalConfirmation` is the pure decision gating the
 * confirm modal in `performInsert`; the modal itself is extension-host UI and
 * is not unit-tested — this predicate is the thing that can silently rot.
 */
suite('needsTerminalConfirmation (T3 — terminal-send confirmation)', () => {

    test('multi-line content on a both-context type (AIPrompt) → true', () => {
        assert.strictEqual(needsTerminalConfirmation('AIPrompt', 'line one\nline two'), true);
    });

    test('single-line content on a both-context type (AIPrompt) → false', () => {
        assert.strictEqual(needsTerminalConfirmation('AIPrompt', 'single line'), false);
    });

    // Regression guard: Command (contexts: ['terminal'] only) is where this
    // confirm must NOT fire — it always ran multi-line content unconfirmed
    // before T3, and that path must stay byte-identical.
    test('multi-line content on a terminal-only type (Command) → false, unchanged from before T3', () => {
        assert.strictEqual(needsTerminalConfirmation('Command', 'line one\nline two'), false);
    });

    test('multi-line content on an editor-only type (Snippet) → false (never reaches the terminal anyway)', () => {
        assert.strictEqual(needsTerminalConfirmation('Snippet', 'line one\nline two'), false);
    });
});

/**
 * `package-menus.test.ts` pins the manifest's `.terminal` command + menu
 * entries, but a static pin cannot catch `registerInsertCommands` failing to
 * actually register the handler — a deleted `if` block would leave the menu
 * entry firing "command not found" with the manifest suite fully green.
 * This is the extension-host counterpart: it asserts the id is really live.
 */
suite('registerInsertCommands — .terminal registration (T3)', () => {
    test('every both-context artifact has its .terminal command registered', async function () {
        const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'md-artifacts-snippets-and-tools-vscode');
        await ext?.activate();

        const registered   = await vscode.commands.getCommands(true);
        const bothContext  = ARTIFACTS.filter(a => a.contexts.includes('editor') && a.contexts.includes('terminal'));
        assert.ok(bothContext.length > 0, 'expected at least one both-context artifact (AIPrompt) to exercise this guard');

        for (const a of bothContext) {
            const terminalId = artifactTerminalCommandId(a.dir);
            assert.ok(
                registered.includes(terminalId),
                `${terminalId} is not registered — registerInsertCommands must register a .terminal id for both-context artifacts`,
            );
        }
    });
});

/**
 * A prompt sent to the terminal must arrive as **one block of text**, the way
 * Shift+Enter behaves in a CLI agent's input — not as keystrokes that submit
 * themselves at every newline.
 *
 * `sendText(content, false)` only suppresses the *trailing* newline, so the
 * payload is wrapped in bracketed-paste markers instead. A `Command` is
 * deliberately excluded: running it line by line is the entire point, and that
 * path must stay byte-identical.
 */
suite('wrapForTerminal — multi-line prompts paste as one block', () => {

    const START = '\x1b[200~';
    const END = '\x1b[201~';

    test('a multi-line AIPrompt is wrapped in bracketed-paste markers', () => {
        assert.strictEqual(wrapForTerminal('AIPrompt', 'line one\nline two'), `${START}line one\nline two${END}`);
    });

    test('the payload survives byte-identically between the markers', () => {
        const payload = 'Review the repo.\n\n```bash\nnpm test\n```\n\nReport findings.';
        const wrapped = wrapForTerminal('AIPrompt', payload);
        assert.strictEqual(wrapped.slice(START.length, -END.length), payload);
    });

    test('a single-line AIPrompt is left alone — nothing to protect', () => {
        assert.strictEqual(wrapForTerminal('AIPrompt', 'just one line'), 'just one line');
    });

    // The regression guard: a Command is meant to execute line by line.
    test('a multi-line Command is NOT wrapped', () => {
        assert.strictEqual(wrapForTerminal('Command', 'echo one\necho two'), 'echo one\necho two');
    });

    test('a multi-line Snippet is NOT wrapped', () => {
        assert.strictEqual(wrapForTerminal('Snippet', 'a\nb'), 'a\nb');
    });

    test('no stray newline is appended — Enter stays the user\'s to press', () => {
        assert.ok(!wrapForTerminal('AIPrompt', 'a\nb').endsWith('\n'));
    });
});
