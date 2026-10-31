# AGENTS.md

Guidance for AI agents working in this repo. **Read this file first; open an
`agents/*.md` file only when the index below says your task needs it.**

## Branching and pull requests

**Work happens on `feature/<slug>`. Pull requests always target `develop` — never
`main`.** `main` is the protected release branch (PR required, one code-owner
approval, no force-pushes) and only receives `develop` promotions. A feature PR
opened against `main` cannot be undone cleanly: reverting leaves the commits as
ancestors of `main` (a later promotion silently skips them), and rewinding needs
an admin to lift and restore protection (capture the full protection payload
first — the API takes a whole-object `PUT`). This happened once (PR #7, rewound
2026-08-18). Check the base before opening the PR.

```
feature/<slug>  ──PR──▶  develop  ──PR──▶  main
```

Per-wave commits, ticket ids leading the subject, `git rm -r docs` before the PR
— see [`agents/plans.md`](agents/plans.md).

## Commands

```bash
pnpm install           # Install deps (no node_modules by default — run after clone)
npm run compile        # One-off TypeScript build (outputs to dist/)
npm run watch          # Watch mode for development
npm run lint           # ESLint check (src/)
npm run test           # Compile + lint + run all tests (1701 passing at the v0.13.0 pin)
rm -rf dist && npm test # REQUIRED after any file delete or rename — see below
npx tsc --noEmit       # Type-check only — IDE diagnostics can be stale
```

- **Clean-rebuild rule.** `tsc` does not remove orphaned output, so a deleted
  test's stale compiled file keeps running and *inflates* the pass count (or fails
  against code that is gone). `rm -rf dist` after any delete or rename.
- **Engine smoke tests** run only with `MDA_BIN` set (pinned binary,
  `/Users/nick/.local/mda-v0.13.0/bin/mda`); without it they skip loudly
  (`ENGINE SMOKE SKIPPED`). Tests use temp vaults with `MDA_CONFIG_DIR` in a temp dir.
- **macOS socket-path caveat.** `.vscode-test.mjs` pins
  `--user-data-dir=/tmp/mda-vsct` (macOS caps unix socket paths at 103 chars).
  `listen EINVAL … .sock` does not mean the suite is broken — never fall back to a
  partial gate.
- **F5** launches the Extension Development Host.

## What this extension does

**MD Artifacts: AI Snippets & Tools** brings an Obsidian vault's snippets,
templates, commands, agent configs, AI prompts and variables into VS Code: an
activity-bar home (a main pane that lists create-form types and hosts the insert
preview; a Variables pane), a QuickPick artifact picker, a create/edit form, and
Variable Sets. **It requires the `mda` engine** (a separate Rust binary, `mda
serve`, JSON-RPC over stdio, protocol 2.3): every vault and workspace file read
and write, every parse, render and vault rule is the engine's (R-4: no TS
fallback). The extension owns only what is VS Code-specific — menus, panes,
webviews, delivery to editor / terminal / clipboard, confirmations, localisation.

## The engine client (`src/engine/`) — rules every task touches

- **One authority per job:** `session.ts` is the only wire code; `supervisor.ts`
  spawns, handshakes and restarts; `engine.vscode.ts` is the only `child_process`
  import (argv array, never a shell); `errors.ts` turns a code into words;
  `adapt.ts` converts engine shapes and vault-relative POSIX paths (through
  `isPathWithin`); `model.ts` builds the write model; `request-error.ts` defines
  the rejection. Guard: `test/engine-imports-guard.test.ts`.
- **Engine output is untrusted** — parsed in a `try`, shape-guarded; its strings
  reach webviews only through `escHtml` / `jsStr`.
- **Errors are codes + string params**, localised through the one table
  (`engineErrorMessage`) — never shown raw; `op.bad_request.reason` is log-only.
- **Every write of a read file sends that read's `expectedHash` and copies its
  `layout` and `frontmatter.paths` into the model**, or the engine refuses a
  flagged / index file. Conflicts (`file.conflict`, `file.exists`) go through
  `conflict.service.ts`.
- **The engine sends no change events** — caches are invalidated by the
  `FileSystemWatcher` in `vault-watch.service.ts`.
- **A TS re-implementation of anything the engine answers is a defect** (a sibling
  of the engine). The only recorded file-system exceptions outside the engine
  (E-1) are `scratch-file.service.ts` (extension storage), `engine.vscode.ts`
  (binary check), `destFolderPicker.panel.ts` (folder navigation) and
  `create-from-surface.command.ts` (capture size check) — held exactly by
  `test/w5-cleanup-guard.test.ts`.
- The on-disk format is the engine's: ```` ```yaml VKs ```` defaults only — see
  [`ARTIFACT_FILE_FORMAT.md`](ARTIFACT_FILE_FORMAT.md).

## Read this when…

| Your task touches | Read |
|---|---|
| Folder layout, activation, the picker, the main pane / webview transport, the pane resize, the edit/create form | [`agents/architecture.md`](agents/architecture.md) |
| Insert commands, editor vs terminal target, 🔒 terminal send | [`agents/insert-and-terminal.md`](agents/insert-and-terminal.md) |
| Templates / AI Agents Config, Create File, 🔒 template indexes, flagged payloads | [`agents/whole-file-and-indexes.md`](agents/whole-file-and-indexes.md) |
| Variable Sets, the Variables pane or editor | [`agents/variables.md`](agents/variables.md) |
| Preview message protocol, shared UI pieces (tags field, reorder, View Info) | [`agents/webview-ui.md`](agents/webview-ui.md) |
| Any user-visible string, nls / l10n bundles, 🔒 escaping detail | [`agents/i18n.md`](agents/i18n.md) |
| Dependencies, `package.json`, `.vscodeignore`, packaging | [`agents/packaging.md`](agents/packaging.md) |
| Writing or running a plan | [`agents/plans.md`](agents/plans.md) |

## Single sources of truth

Each fact lives in **one** place, held by a named guard. Re-implementing one is
the regression this table exists to prevent.

| Fact | Sole owner | Guard |
|---|---|---|
| Every vault rule — parse, serialize, flags, slugs for vault files, index links, frontmatter keys, migration, render, var-set apply / save, Variables mutation, vault-path containment | **the engine** (`mda` `v0.13.0`) | engine conformance + op cases; `w5-cleanup-guard.test.ts` (deleted services stay deleted) |
| Artifact types | `artifact-type-config.service.ts` — `getEntry` / `getAllTypes` (+ O-2 handshake vs the engine) | `constants.test.ts` · `engine-supervisor.test.ts` |
| Settings section | `config.service.ts` — `CONFIG_SECTION`, `getVaultPath`, `getVaultRootUri` | — (never call `getConfiguration('mdArtifacts')` elsewhere) |
| Engine wire / spawn / errors / shapes / write model | `src/engine/` (see above) | `engine-imports-guard.test.ts` |
| HTML escaping | `utils/html.ts` — `escHtml` (all five of `&<>"'`) | `webview-snippets.test.ts` |
| Webview `esc` / `lbl` | `artifactPicker/webviewSnippets.ts` — `WEBVIEW_ESC_LBL_JS` | `webview-snippets.test.ts` |
| Script-context escaping (`<\/`, `<!--`) | `webviewSnippets.ts` — `jsStr` | `webview-snippets.test.ts` |
| Bundle values never reach HTML unescaped | `escHtml` / `jsStr` / `jsStr(escHtml(…))` | `l10n-html-escaping.test.ts` |
| `<VK-xxx>` token syntax (UI highlighting, live detection) | `render.service.ts` — `VK_TOKEN_RE` (matches `</VK-xxx>` too), `extractVars` | `vk-closing-tag.test.ts` (one declaration + the webview `vkWrap` twin) |
| Language tables | `types/constants.ts` — `LANG_ALIAS` / `LANG_FENCE` / `LANG_EXT` | `language-consistency.test.ts` |
| Context-menu surfaces | `constants.ts` — each `ARTIFACTS` entry's `contexts` | `package-menus.test.ts` · `package-create-menus.test.ts` |
| Write-a-file vs insert · single-block forms | `constants.ts` — `writesFile`, `form.multiBlock` (read via `writesWholeFile` / `canMultiBlock`) | `artifact-type-config.test.ts` |
| Create File default name | `template.service.ts` — `resolveOutputFileName` (the write is the engine's) | `template.service.test.ts` |
| Path containment rule | `utils/path-containment.ts` — `isPathWithin` | `path-containment.test.ts` |
| Create-form payload shape | `artifactForm/form.clientJs.ts` — client `extractModel()` | `form-clientjs-model-shape.test.ts` |
| Create-surface derivation | `artifact-type-config.service.ts` — `getCreateFormTypes()` | `package-create-menus.test.ts` |
| Webview transport (queue-while-hidden, dispose ≠ cancel) | `artifactPicker/webviewHost.ts` — `WebviewHost` | `webview-host.test.ts` |
| Temp edit files | `scratch-file.service.ts` — `openScratchFile` | via `blockEditor.ts` callers |
| Capture shape | `types/artifact-form.types.ts` — `CaptureResult` / `CaptureFn<T>` | compiler |
| Pane width / Variables height | `pane-width.service.ts` · `pane-layout.service.ts` | `pane-width.service.test.ts` · `pane-layout.service.test.ts` |
| Modal confirmation | `confirm.service.ts` — `confirmModal` | `edit-artifact.test.ts` · `preview-buttons.test.ts` |
| Block-code writes | `preview.helpers.ts` — `persistBlockCode` (→ `artifact.patch`) | `preview-buttons.test.ts` |
| Max pane width / code-area min height | `constants.ts` — `MAX_PANE_WIDTH_PX`, `CODE_BLOCK_MIN_LINES` | `preview-buttons.test.ts` |
| Insert target (editor vs terminal) | `preview-target.service.ts` · `resolveInsertTarget` | `preview-target.service.test.ts` · `insert-target.test.ts` |
| Variables file shape | `varset.service.ts` — `getVarsFileShape` (adapter, equal to `vars.list`'s `shape`) | `varset-shape-engine.test.ts` · `variables-file-shapes.test.ts` |
| Variables-pane row actions | `constants.ts` — `VARIABLES_ROW_ACTIONS` + friends | `package-variables-menus.test.ts` |
| Reorder control · tags field · View Info | `ui/panels/shared/reorderControls.ts` · `tagsField.ts` · `infoPanel/` | `reorder-controls.test.ts` · `variables-info.test.ts` |
| `VK-` name prefix | form `renderVarNameCell` / client `vkName`; pane `withVkPrefix` (twins) | `varset-form-subset-controls.test.ts` · `variables-command.test.ts` |
| i18n packaging · key naming | `.vscodeignore` + `"l10n": "./l10n"`; the English string **is** the key | `packaging-assets.test.ts` · `l10n-bundle.test.ts` |
| Only ```` ```yaml VKs ```` anywhere in `src` / `test` | — (L-5) | `w5-cleanup-guard.test.ts` |

**Context menus derive from `constants.ts`, always.** `package.json`'s
`contributes.commands` / `menus` are a static mirror (read before activation);
a type wired in constants but missing there shows **no menu entry, no error** —
the `package-*menus` guards catch it. **Never write `ARTIFACTS.find(...)`, a
second `escHtml`, or a second slug.**

## 🔒 Escaping is per destination

| Destination | Rule |
|---|---|
| HTML text or attribute | `escHtml` |
| A string literal inside a client script | `jsStr` |
| A localised string a client script concatenates into HTML | `jsStr(escHtml(l10n.t(...)))` |

`escHtml` is wrong inside `<script>`; `jsStr` is not an HTML escape. Escape
**after** formatting (`escHtml(l10n.t('x {0}', v))`), never both, never neither.
Keep markup out of bundle strings. Detail: [`agents/i18n.md`](agents/i18n.md).

## Code Style

### ⚠️ File complexity limits (READ FIRST)

**Never grow a file into a god-object.** One extra import line is cheap; a
1000-line file is paid for on every read.
- A `.ts` file stays under **~400 lines**. Plan a split at ~500. **Past 700, split before adding.**
- A function stays under **~50 lines** (ESLint caps cognitive complexity at 15, `S3776`).
- A class owns **one concern** — if you need a `// ── Section X ──` banner to
  navigate inside it, that section wants its own file.

**Splitting pattern:** a domain feature gets a folder, not a file — one `*.ts`
per concern, a sibling `*.helpers.ts` for its pure functions, and a `shared.ts`
for cross-concern singletons.

**Worked examples.** The picker was one 1182-line `artifactPicker.panel.ts`; it
was split by concern into the folder above, controllers composing via callback
bags. Later `preview.ts` hit 595 lines and was cut on the seam `artifactForm/`
already used — **controller** (`preview.ts`) · **renderers**
(`preview.render.ts`) · **webview script constant** (`preview.clientJs.ts`) ·
**pure helpers** (`preview.helpers.ts`) — landing at 300 with no behaviour
change. Use that seam for a panel file before inventing another.

**Reaching for a file that is already large?** Different concern → new sibling
file. Stateless/pure → its `*.helpers.ts`. Service/cross-cutting →
`src/services/`, never the panel. Only if all three are "no" with a reason does
it go in the existing file. Notice a file crossed 400 lines while finishing a
feature → propose the split in that PR, not later.

Current over-the-line files: [`agents/architecture.md`](agents/architecture.md#known-file-size-debt) (re-measure before trusting).

### Invariants (each cost a real bug here)

**An invariant stated in a comment is not an invariant.** Two comments here
asserted contracts that had *already* broken: `artifact-type-config.service.ts`
claimed nothing else traversed `ARTIFACTS` (six sites did), and `constants.ts`
said "keep the two directions consistent" about language tables that had drifted
— with the effect that **no Objective-C fence worked at all**. → Every
cross-file invariant gets a **test**, and the comment names it.

**Any list enumerating a domain set is derived, or drift-guarded.**
`VALID_TYPES` was a hand-copy of the `ARTIFACTS` types; a missing entry silently
downgraded to `'snippet'` — wrong behaviour, no error.

**A guard test that cannot fail is decoration.** Prove each new guard by
reintroducing the exact bug, watching it go red, then restoring. This caught a
guard here that passed against the very drift it was written for.

**"Duplicate" is a claim about behaviour, not shape.** Diff the bodies before
collapsing: the webview `esc` "copies" escaped 5, 4, 3 and **0** characters, and
the one that escaped nothing was writing unescaped user values into HTML
attributes.

**Webview client JS cannot import — so it gets one shared exported snippet
string, never a copy-paste** (`WEBVIEW_ESC_LBL_JS`, carried by
`CODE_BLOCK_CLIENT_JS` so consumers inherit it exactly once).

**Data crossing a webview message is untrusted.** Keep its guard (`panel.ts`'s
`getEntry` try/catch, the var-set payload shape guards) and escape everything
interpolated into webview HTML. **So is engine output** (see the engine-client rules).

### Comments
- Every function and interface must have a JSDoc block that includes: a concise description, `@param` tags, a `@returns` tag, and at least one `@example`.
- Add inline section comments (e.g. `// ── Section name ───`) to visually group logical blocks within longer functions.
- Comments should explain **why**, not **what** — well-named identifiers already describe what the code does.

### File organisation
Vault domain logic is the **engine's**; `src/engine/` is the client (see above).
UI-side logic in `services/`, shared pure helpers in `utils/`, constants in
`types/constants.ts`, types in `types/` (**no `vscode` imports there** — adapt at
the edges), webview HTML + message handling in `ui/panels/`. Commands and panels
stay thin wiring.

### ESLint gotchas
- Use `RegExp.exec(str)` not `str.match(re)` — rule `S6594`.
- Use `str.startsWith(x)` not `/^x/.test(str)` — rule `S6557`.
- No nested template literals — extract inner expression to a variable first — rule `S4624`.
- Cognitive complexity limit is 15 per function (`S3776`) — extract sub-methods when approaching it.
