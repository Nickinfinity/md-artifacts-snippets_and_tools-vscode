# Insert and terminal

Insert commands, the insert target rule, the 🔒 terminal send rules, and vault directory logic. Part of [`AGENTS.md`](../AGENTS.md) — read it first.

### Insert commands (`src/commands/insert.command.ts`)

`registerInsertCommands(context)` loops over `ARTIFACTS` and registers **one
command per artifact**, all handled by the same `openArtifactPicker`. One loop,
one handler, zero hardcoded names — the per-artifact command IDs exist only
because of a hard VS Code constraint:

> A context-menu item's label comes **exclusively** from the `title` of the
> matching `contributes.commands` entry. Per-item overrides in
> `contributes.menus` are silently ignored.

IDs follow `md-artifacts.insert.<dir.toLowerCase()>` via
`artifactCommandId(dir)` and must match `package.json`. A type declaring
**both** `'editor'` and `'terminal'` in `contexts` (only `AIPrompt` today) also
registers `artifactTerminalCommandId(dir)` — `<base>.terminal` — a second
command the terminal menus point at; see **Insert target** below.

**Adding a new artifact type** — two source edits, both in `src/types/`:
1. Add the entry to `ARTIFACTS` in `src/types/constants.ts`.
2. Add the literal to the `ArtifactType` union in `parsed-artifact.types.ts`.
   Skipping this is a **compile error**, by design — an unrecognised type must
   never silently downgrade to `'Snippet'`.

Everything else derives: command registration, context keys, parser acceptance
and the type-config accessors. Then, for menu presentation only:
3. Add a matching `contributes.commands` entry in `package.json` with the correct title.
4. Add `contributes.menus` entries for the relevant context surfaces.

**Menu presentation.** `Variables` has `contexts: ['all']`, appears everywhere,
and is labelled **"See/Edit Variables"** (browse/edit, not insert); it sits in
`package.json` group `"2_variables@1"` while others use `"1_insert@N"`, so VS
Code's group separator keeps it last. Each surface shows direct entries when one
artifact is active there, or an "MD Artifacts" submenu when two or more
are (`*HasMultiple` context keys, maintained by `context.service.ts`).
The terminal is the exception: one **MD Artifacts** entry
(`md-artifacts.submenu.terminal.root`) nesting **Insert** and **Create**
submenus, always (W-UI b).

**Insert target — the invocation surface, not focus.** `AIPrompt` is the first
type declaring both `'editor'` and `'terminal'` in `contexts`, so it is the
first type that has to decide, at insert time, which one to write to.
"Resolve it from whichever has focus" is not implementable: VS Code exposes no
terminal-focus predicate — `vscode.window.activeTerminal` is documented as
"has focus **or most recently had focus**" and never goes back to `undefined`
on blur, so a focus-based implementation would send every `AIPrompt` to the
terminal as soon as one had ever been opened. Instead the target is captured
**statically**, from which command fired: `registerInsertCommands`
(`insert.command.ts`) registers a base command (routed to `'editor'`) and,
only for both-context types, a second `artifactTerminalCommandId` command
(routed to `'terminal'`) that the terminal context menus point at in
`package.json` — the menu the user actually clicked *is* the answer, always
correct, no live state to read. `resolveInsertTarget(type, invocationSurface)`
(`artifactPicker/preview.helpers.ts`) applies the resulting three-row rule:
`contexts: ['terminal']` (`Command`) always resolves `'terminal'`; both
contexts declared resolves to whichever surface invoked it; anything else
(including `Variables`'s `['all']`) always resolves `'editor'`.

**There is no terminal-selection API at all.** The sibling fact to the rule
above: `TerminalShellIntegration` exposes `cwd` / `env` / `executeCommand`
only — no `selection` property exists to read. `commands/capture/terminal.capture.ts`
captures a terminal selection the only way VS Code allows: run
`workbench.action.terminal.copySelection` (which writes the selection into the
clipboard), read the clipboard, then restore whatever the user's clipboard held
before — never clobbering it silently.

**🔒 Terminal send — one paste, not a line of keystrokes.**
`terminal.sendText(content, false)` suppresses only the *trailing* newline;
every embedded newline still reaches the shell as if the user pressed Enter
after that line (and a bare CR, or Ctrl-O in bash, submits it just the same).
That is wrong for any multi-line payload — an `AIPrompt` (multi-line flagged
markdown from the vault, untrusted by this codebase's standing rule, routinely
carrying a fenced ` ```bash ` block) and a `Command` alike: a `Command` with an
unfilled `<VK-…>` used to run line by line before the warning toast was read
(W-UI f, user ruling 2026-10-27).

`wrapForTerminal(type, content)` (`artifactPicker/preview.helpers.ts`) wraps a
multi-line payload in **bracketed-paste markers** (`ESC[200~` … `ESC[201~`) —
the same mechanism a real terminal paste uses. The receiving program treats
everything between them as literal text, so the newlines become part of the
input instead of submitting it: the prompt lands as one block, the way
Shift+Enter behaves in a CLI agent, and nothing runs until the user presses
Enter. No trailing newline is added. Wrapping applies to every payload
carrying a control character other than tab (any C0 — newline, CR, … — or DEL) of a type
whose `contexts` include `'terminal'`; plain single-line content is sent
unwrapped and without a newline. One private predicate in `preview.helpers.ts`
drives both the wrap and the confirm, so they cannot disagree. **Nothing sent
to the terminal runs before the user presses Enter.**

Support cannot be detected from the extension host (a shell with bracketed
paste disabled would show the markers literally and still act on each line), so
the confirmation stays as the backstop: `needsTerminalConfirmation(type,
content)` is `true` only when the target is `'terminal'` **and** the content
carries such a control character **and** the type's `contexts` include
`'terminal'` — `Command` and `AIPrompt` both prompt; the `containsEscape`
refusal still runs first. A `true` result opens a modal with the line count and a truncated
preview; Cancel or Escape sends nothing.

### Vault directory logic (`constants.ts` ↔ the engine's type registry)

Each `ARTIFACTS` entry drives context keys and command registration; the
**engine** owns the directories. `default: true` (`Snippets`, `AIAgentsConf`,
`AIPrompts`) are created by the engine on `vault.select { createDefaults: true }`;
`default: false` (`Commands`, `Templates`, `Variables`) are detected
(`types.list`) but never auto-created, and the engine never deletes one. At
handshake the client compares `ARTIFACTS`' (`type`, `dir`) pairs with the
engine's `types` and refuses on a missing pair (`client.incompatible`, O-2) —
engine-only types are ignored.
