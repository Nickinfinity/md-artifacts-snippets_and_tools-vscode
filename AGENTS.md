# AGENTS.md

This file provides guidance to AI AGENTS when working with code in this repository.

## Branching and pull requests

**Work happens on `feature/<slug>`. Pull requests always target `develop` — never
`main`.**

`main` is the release branch and is protected (PR required, one code-owner
approval, no force-pushes). It receives changes only by promoting `develop`, not
from feature branches directly. Opening a feature PR against `main` is the wrong
base even when the diff is correct, and neither way out is free:

- **Revert the merge.** Respects protection, but leaves those commits as
  ancestors of `main` — so a later `develop` → `main` promotion sees them as
  already merged and **silently does not reapply them**. Recovering needs a
  revert-of-the-revert on the promoting PR.
- **Rewind `main`.** Clean, and leaves no trap, but requires an admin to lift
  `allow_force_pushes`, force-push, and restore protection. Capture the full
  protection payload *before* lifting it and diff it back afterwards — the
  GitHub API takes a whole-object `PUT`, so a partial payload silently drops
  settings.

This happened once (PR #7, rewound on 2026-08-18). Check the base before opening
the PR; it costs nothing then.

```
feature/<slug>  ──PR──▶  develop  ──PR──▶  main
```

Everything else in `CREATING_A_PLAN.md` still holds — per-wave commits, ticket
ids leading the subject, `git rm -r docs` before the PR.

---

## Commands

```bash
pnpm install           # Install deps (no node_modules by default — run after clone)
npm run compile        # One-off TypeScript build (outputs to dist/)
npm run watch          # Watch mode for development (preferred during active development)
npm run lint           # ESLint check (runs against src/)
npm run test           # Compile + lint + run all tests (1362 passing)
rm -rf dist && npm test # REQUIRED after any file delete or rename — see below
npx tsc --noEmit       # Type-check only — IDE diagnostics can be stale; use this to verify
```

**Clean-rebuild rule.** `tsc` does not remove orphaned output, so a deleted
test's stale compiled artifact keeps running and *inflates* the pass count into
a phantom green. `rm -rf dist` after any delete or rename.

**macOS socket-path caveat.** `.vscode-test.mjs` pins
`--user-data-dir=/tmp/mda-vsct` because macOS caps unix socket paths at 103 chars
and the default under a deep repo path overflows it (`listen EINVAL … .sock`).
Seeing that does not mean the suite is broken — never fall back to a partial gate.

Press **F5** in VS Code to launch the Extension Development Host.

---

## What This Extension Does

**MD Artifacts: AI Snippets & Tools** bridges an Obsidian vault and VS Code, letting developers insert vault content — snippets, templates, commands, agent configs, AI prompts, and variables — directly into the editor or terminal without leaving VS Code.

- **Settings panel** — pick and validate the vault root, toggle artifact directories.
- **Artifact picker** — a `vscode.QuickPick` hierarchical navigator with a
  side-by-side **interactive preview**: editable code area (line numbers, hljs,
  `<VK-xxx>` spans) plus variable inputs. **Insert** resolves variables to the
  cursor or terminal; **Edit .md** opens the real vault file.
- **Create form** — a webview form that writes new artifacts into the vault.
- **Variable Sets** — reusable `<VK-xxx>` default bundles, applied with a diff
  preview or saved from current values.
- **Activity-bar home** — a dedicated container (icon: `media/md-artifacts.svg`,
  freely replaceable — nothing reads or fingerprints it) holds two panes: the
  **main pane**, a two-mode webview that lists create-form types (`idle`) and
  hosts the insert preview (`preview`) once an artifact is picked; and the
  **Variables pane**, a tree (file → sub-set → variable) with CRUD commands and
  confirmations for editing `Variables/` files without leaving the sidebar.

---

## Folder Structure

```
src/
├── extension.ts                      # Entry point — activate() / deactivate()
├── commands/
│   ├── openSettings.command.ts       # Registers md-artifacts.settings
│   ├── insert.command.ts             # One insert command per artifact (loop over ARTIFACTS)
│   ├── create.command.ts             # Create-artifact flow + editor-selection capture
│   ├── migrate.command.ts            # md-artifacts.migrateFrontmatter — dry-run, then apply
│   ├── capture/                      # One CaptureFn per surface, vscode-free
│   │   └── editor.capture.ts · terminal.capture.ts · explorer.capture.ts
│   ├── create-prefill.helpers.ts     # THE prefill builders (pure)
│   ├── create-from-surface.command.ts   # Derived create-command registration (mirrors insert.command.ts)
│   └── variables.command.ts (+ .command.helpers · .confirm.helpers)  # Variables CRUD commands + confirmations
├── services/                         # Domain logic. Panels/commands stay thin wiring.
│   ├── artifact-type-config.service.ts   # THE ARTIFACTS reader — getEntry, getAllTypes, getFormConfig…
│   ├── config.service.ts                 # THE settings reader — CONFIG_SECTION, getVaultPath(RootUri)
│   ├── artifact-serializer.service.ts    # THE .md emitter — serializeArtifact
│   ├── parser.service.ts                 # THE .md reader — parse*, extractVars, resolveVars, VK_TOKEN_RE
│   ├── flags.service.ts                  # THE %%oa:start%%/%%oa:end%% syntax — extractFlaggedRegions
│   ├── frontmatter-migration.service.ts  # THE `type:` → `artifactType:` rewrite — planMigration/applyMigration
│   ├── filename.service.ts               # THE slug — slugify, deriveFileName, validate* guards
│   ├── template.service(.helpers).ts     # Whole-file types (template + agent) — resolveOutputFileName,
│   │                                     # validateSingleBlock; helpers = path-injection/ext rules
│   ├── artifact-patcher.service.ts       # Surgical in-place .md edits
│   ├── artifact-writer.service.ts        # Atomic writes + isPathWithin path-escape guard
│   ├── vault.service.ts · context.service.ts     # Vault validation/detection; context keys
│   ├── language-map.service.ts · render.service.ts  # mapLanguageId; renderCode(Rows)Html
│   ├── varset.service.ts                 # Scanner, score, extractSubSets, applyVarSet, buildVarSetModel
│   ├── multi-index.service.ts            # THE index link syntax + safeRelPath — buildIndexPlan,
│   │                                     # buildDestCandidates, applyCarryOver (vscode-free)
│   ├── scratch-file.service.ts       # THE temp edit-file lifecycle (real files under extension storage)
│   ├── create-index.service.ts       # N captured paths → sibling files + an index (pure)
│   ├── variables-crud.service.ts · variables-writer.service.ts  # Variables mutation + whole-file .md writer
│   ├── pane-width.service.ts         # THE pane-resize rule — closed-loop widen to a
│   │                                 # measured target, equal-and-opposite restore (vscode-free)
│   ├── pane-layout.service.ts        # THE variables-height bounds — clamp + varsHeightCss (vscode-free)
│   ├── confirm.service.ts            # THE modal confirm — confirmModal (Cancel and Escape both = no)
│   └── preview-mode.service.ts · temp-document.service.ts
├── ui/
│   ├── views/                        # The activity-bar surfaces (WebviewView-based, not TreeDataProvider)
│   │   ├── mainView.provider.ts      # THE main pane — WebviewViewProvider, idle ⇄ preview modes
│   │   ├── mainView.render.ts        # buildCreateItems · renderIdleHtml (pure)
│   │   ├── mainView.preview.ts       # preview mode — reuses preview.render/preview.clientJs verbatim
│   │   ├── variablesView.provider.ts # Variables tree (file → sub-set → var)
│   │   └── createIndexRunner.ts      # Batch write of a create-flow-generated index
│   ├── panels/
│   │   ├── artifactPicker.panel.ts   # Re-export shim (back-compat for insert.command.ts)
│   │   ├── artifactPicker/           # Parts table under Architecture. navigator · codeBlock ·
│   │   │                             # preview(.render/.clientJs/.helpers/.createFile/.batch) ·
│   │   │                             # blockEditor · varSetController · varSetDiff ·
│   │   │                             # multiIndex(.dest) · webviewHost · webviewSnippets · shared
│   │   │                             # (+ *.helpers.ts siblings)
│   │   ├── artifactForm/             # panel(.helpers) · form.html · form.blocks ·
│   │   │                             # form.clientJs · form.helpers · blockExpand · shared
│   │   └── settings.panel.ts · varsetPicker.panel.ts · destFolderPicker.panel.ts
│   ├── base.css                      # Global reset + bare h1/hr/button — EVERY panel links this
│   ├── main-view.css                 # Narrow-pane layout overrides for the sidebar preview
│   ├── codicon.css · codicon.ttf     # Vendored @vscode/codicons — see "One runtime dependency" below
│   └── settings.css · picker.css · form.css · hljs.css · code-block.css · varset.css
├── types/
│   ├── constants.ts                  # ARTIFACTS · LANG_ALIAS · LANG_FENCE · LANG_EXT
│   ├── parsed-artifact.types.ts      # ArtifactType union, ParsedArtifactFile, ParsedBlock, ParsedVar
│   ├── multi-index.types.ts          # IndexStep · IndexPlan · DestCandidate · CarryOver · BatchOutcome
│   └── artifact.types.ts · artifact-form.types.ts (CaptureResult · CaptureFn) · varset.types.ts · webview-messages.types.ts
├── utils/
│   ├── helpers.ts                    # getNonce() — CSPRNG-backed
│   ├── html.ts                       # THE escHtml (& < > " ') + styleLinkTags
│   └── path-containment.ts           # THE containment rule — isPathWithin(root, candidate)
├── features/ · providers/            # (empty) reserved
media/md-artifacts.svg          # Activity-bar container icon — replaceable, referenced by path only
test/                                 # 1362 tests. fixtures/ + snapshots/
├── snapshots/varset/*.md             # Byte-exact var-set emission goldens — NEVER edit
├── snapshots/form-html/*.html        # Form-panel HTML snapshots
└── drift guards: language-consistency · frontmatter-keys · constants · webview-snippets ·
                  package-create-menus · create-path-dry
```

---

## Architecture

### Activation flow (`src/extension.ts`)

`activate()` registers the settings/insert/create commands, then **awaits**
`refreshVaultContext()` — without the await the context keys land late and the
first right-click shows no items. If no vault path is stored, the Settings panel
opens automatically. An `onDidChangeConfiguration` listener watches the section
(via `CONFIG_SECTION`) and re-creates enabled-but-missing directories on Settings
Sync — **create only, never auto-delete.**

### Settings panel (`src/ui/panels/settings.panel.ts`)

On folder pick: `validateObsidianVault()` (requires `.obsidian/`) →
`detectVaultDirs()` → auto-create the `default: true` entries → persist path and
feature flags to `mdArtifacts.*` (Settings Sync). It is the only **panel** that writes that config section, and sources the
section name from `CONFIG_SECTION`. One programmatic writer also exists —
`config.service.ts`'s `setVariablesHeightFraction`, for the drag handle, which
lives beside its matching reader rather than reaching into the section from a
UI file. Those two are the whole set; nothing else may call `update()` on it.

### Single sources of truth

Each of these is the **only** place its fact lives. Re-implementing one is the
regression this list exists to prevent; each is held by a named guard test.

| Fact | Sole owner | Guard |
|---|---|---|
| Artifact types | `artifact-type-config.service.ts` — `getEntry` / `getAllTypes` | `constants.test.ts` — parser accepts every `ARTIFACTS` type |
| Settings section | `config.service.ts` — `CONFIG_SECTION`, `getVaultPath`, `getVaultRootUri` | — (thin `vscode` wrapper; covered via callers) |
| `.md` emission | `artifact-serializer.service.ts` — `serializeArtifact` | `varset-serialize.test.ts` byte goldens + `frontmatter-keys.test.ts` |
| `.md` parsing | `parser.service.ts` | `frontmatter-keys.test.ts` binds it to the serializer |
| HTML escaping | `utils/html.ts` — `escHtml` (all five of `&<>"'`) | `webview-snippets.test.ts` — webview `esc` must match it |
| Webview `esc`/`lbl` | `artifactPicker/webviewSnippets.ts` — `WEBVIEW_ESC_LBL_JS` | `webview-snippets.test.ts` — defined exactly once per bundle |
| Slugs | `filename.service.ts` — `slugify` | `filename.service.test.ts` |
| `<VK-xxx>` regex | `parser.service.ts` — `VK_TOKEN_RE` (matches `</VK-xxx>` too) | `utils-html.test.ts` (shared-instance `lastIndex` reuse) · `vk-closing-tag.test.ts` binds the webview `vkWrap` twin |
| Language tables | `types/constants.ts` — `LANG_ALIAS` / `LANG_FENCE` / `LANG_EXT` | `language-consistency.test.ts` |
| Context-menu surfaces | `types/constants.ts` — each `ARTIFACTS` entry's `contexts` | `package-menus.test.ts` — pins `package.json` menus to `ARTIFACTS` |
| Write-a-file vs insert | `types/constants.ts` — `writesFile`, read via `writesWholeFile` | `artifact-type-config.test.ts` — answer must equal the flag, every type |
| Single-block restriction | `types/constants.ts` — `form.multiBlock`, read via `canMultiBlock` / `forcesSingleBlock` | `artifact-type-config.test.ts` — mirrors the flag, every create-form type |
| Whole-file naming | `template.service.ts` — `resolveOutputFileName` | `template.service.test.ts` — agent `target:` verbatim vs template D3 chain |
| Flag syntax (`%%oa:…%%`) | `flags.service.ts` — `extractFlaggedRegions` | `flags.service.test.ts` — no other `src/` file may spell the marker |
| Index link + path syntax | `multi-index.service.ts` — `safeRelPath` (the sole rejection authority) | `multi-index.service.test.ts` — hostile inputs asserted through **both** callers |
| Read-side-only frontmatter keys | `parser.service.ts` — `BOOLEAN_FRONTMATTER_KEYS` / `ARRAY_FRONTMATTER_KEYS`, absent from the serializer's `FRONTMATTER_KEY_ORDER` | `frontmatter-keys.test.ts` — the D11 guard: `index` / `paths` must never be emitted |
| `artifactType` frontmatter key — single key, exact-case PascalCase, no legacy `type:` read (D1) | `parser.service.ts` — `applyFrontmatterField` / `VALID_TYPES`; `artifact-serializer.service.ts` — `FRONTMATTER_KEY_ORDER[0]` | `frontmatter-keys.test.ts` — "artifactType key — T1 migration" suite |
| Path containment (`isPathWithin`) | `utils/path-containment.ts` — the **one** prefix-with-separator rule, previously spelled out three times | `path-containment.test.ts` — no other `src/` file may spell `endsWith(path.sep)` |
| Create-form client-JS payload shape | `artifactForm/form.clientJs.ts` — `extractModel()` | `test/form-clientjs-model-shape.test.ts` — binds the webview's posted keys to `ArtifactFormModel`; added after the webview posted `type:` while the extension read `artifactType`, which compiled clean |
| Create-surface derivation (which types get a create command, from where) | `artifact-type-config.service.ts` — `getCreateFormTypes()` | `package-create-menus.test.ts` — pins `package.json`'s create menus to the derivation |
| Webview transport (queue-while-hidden, dispose≠cancel) | `artifactPicker/webviewHost.ts` — `WebviewHost` | `test/webview-host.test.ts` |
| Temp edit files on disk | `services/scratch-file.service.ts` — `openScratchFile` | covered via `blockEditor.ts` callers |
| Create-flow capture shape | `types/artifact-form.types.ts` — `CaptureResult` / `CaptureFn<T>` | — (no test names either symbol; enforced by the compiler only — every `commands/capture/*.ts` function is typed to return `CaptureResult \| undefined` (`captureTerminal` is async, so `Promise<…>` of it)) |
| Variables `.md` mutation | `services/variables-crud.service.ts` + `variables-writer.service.ts` — through `serializeArtifact`, never a bespoke emitter | covered via `test/variables-*.test.ts` |
| Pane-width command ids + resize rule | `services/pane-width.service.ts` — `PANE_WIDTH_COMMANDS`, `widenForPreview`/`restoreAfterPreview` | `test/pane-width.service.test.ts` — the closed-loop suite drives a fake pane whose width *responds*, including inverted |
| Variables-height bounds | `services/pane-layout.service.ts` — `clampVarsHeightFraction`, `varsHeightCss` | `test/pane-layout.service.test.ts` — bounds, hostile input, the `package.json` mirror, **and that `varsHeightCss` has a caller** |
| Modal confirmation | `services/confirm.service.ts` — `confirmModal` | covered via `test/edit-artifact.test.ts` (delete) and `test/preview-buttons.test.ts` (overwrite) |
| Block-code writes | `artifactPicker/preview.helpers.ts` — `persistBlockCode`, wrapping `patchBlockCode` | `test/preview-buttons.test.ts` — `preview.ts` may not call `patchBlockCode` directly |
| Max pane width / code-area min height | `types/constants.ts` — `MAX_PANE_WIDTH_PX`, `CODE_BLOCK_MIN_LINES` | `test/preview-buttons.test.ts` — the sheet must read the custom property, never a second literal |
| Script-context escaping (`<\/`, `<!--`) | `artifactPicker/webviewSnippets.ts` — `jsStr` | `test/webview-snippets.test.ts` — exactly one `jsStr` in `src/`, and no other file performing the escape |
| Bundle values never reach HTML unescaped | the `escHtml` / `jsStr` / `jsStr(escHtml(…))` rule above | `test/l10n-html-escaping.test.ts` — scans for any `${vscode.l10n.t(` not wrapped in an escaper |
| i18n asset packaging | `.vscodeignore` (no exclusion of `package.nls*` / `l10n/`) + `package.json`'s `"l10n": "./l10n"` | `test/packaging-assets.test.ts` — content-scanned, not column-0 anchored |
| nls / l10n key naming | the English source string **is** the key — no key ids | `test/l10n-bundle.test.ts` |
| Insert target (editor vs terminal) | `services/preview-target.service.ts` | `test/preview-target.service.test.ts` |

**Context menus are driven by `constants.ts`, always.** An artifact's
`contexts` field is the single source for *where* its command shows (editor /
terminal / explorer / `all`). Everything runtime derives from it — command
registration, context keys, `*HasMultiple` counts. `package.json`'s
`contributes.commands` + `contributes.menus` are the one static mirror (VS Code
reads them before activation, so they cannot derive at runtime); they must
match `ARTIFACTS`, and `package-menus.test.ts` fails loudly if they drift — a
new artifact wired in constants but missing from `package.json` shows **no
menu entry, no error** without it.

**Never write `ARTIFACTS.find(...)`, a second `escHtml`, or a second slug.**
Never call `vscode.workspace.getConfiguration('mdArtifacts')` outside
`config.service.ts`.

### Artifact picker (`src/ui/panels/artifactPicker/`)

The legacy `artifactPicker.panel.ts` is a 1-line re-export shim kept for
back-compat with `commands/insert.command.ts`.

| File | Owns |
|---|---|
| `navigator.ts` (+ `.helpers.ts`) | `ArtifactNavigator`, `openArtifactPicker`, parse cache, hierarchical browsing, accept/active routing |
| `codeBlock.ts` | Editable code-area HTML (`buildCodeBlockHtml`) + `CODE_BLOCK_CLIENT_JS` (caret preservation, debounced re-render, paste/Enter intercept). Also carries `WEBVIEW_ESC_LBL_JS`. |
| `preview.ts` | `PreviewPanelController` — popup lifecycle + message routing, **including the full-edit flow** (`handleFullEdit`, `'fullEdit'` message): the real `.md` opens in an editor tab, save → `fileUpdated`, change (500 ms) → `updateVars`. There is no `fullEditor.ts`; an earlier version of this table listed one. **Controller only.** |
| `preview.render.ts` | `renderPreviewHtml`, `renderMultiBlockPreviewHtml`, `renderPopupEmptyHtml`, `mergeVarsWithDefaults` |
| `preview.clientJs.ts` | `PREVIEW_CLIENT_JS` — the popup's webview-side script |
| `blockEditor.ts` | `BlockEditController` — one block to a temp file; `normalizeLangId` / `resolveLangId` / `extForLang` |
| `varSetController.ts` · `varSetDiff.ts` | Variable-set apply/save routing and diff HTML |
| `webviewSnippets.ts` | `WEBVIEW_ESC_LBL_JS` — shared client-JS `esc`/`lbl` |
| `shared.ts` | Single `out` OutputChannel |

`openArtifactPicker(dir, name)` validates the vault and artifact directory, then hands off to `ArtifactNavigator.run()`. There is no WebviewPanel — the entire picker is a `vscode.QuickPick`.

**Controller composition — callback bags, never reaching inward.**
`ArtifactNavigator` constructs `PreviewPanelController` with
`{ extensionUri, rootFs, targetEditor, setCache, onDispose, closePicker }`;
that controller owns `FullEditController` with
`{ rootFs, getCurrentArtifact, setCurrentArtifact, setCache, postMessage }`.
The full-editor never touches the navigator. `parseCache` lives on the
navigator; others write through `setCache`. **Imitate this shape** when adding a
sub-controller.

**Client-script assembly.** `renderPreviewHtml` injects
`buildCodeBlockHtml(renderCodeRowsHtml(code, lang))` and concatenates the client
scripts inside **one** outer IIFE, so they share the single
`acquireVsCodeApi()` — which may be called **once per webview**.

**Non-obvious invariants** (per-method detail is in each file's JSDoc — read the
source rather than a second copy of it here):
- `onDidChangeActive` is debounced 120 ms; the code area re-renders locally in
  the webview on a 150 ms debounce with **no** round-trip to the extension.
- `CODE_BLOCK_CLIENT_JS` exposes
  `window.__codeBlock = { extractCode, renderRows, flushPendingRender, setCode }`.
  Insert must call `flushPendingRender()` **before** `extractCode()`, or it reads
  stale text.
- `FullEditController.teardown()` **must** run before `panel.dispose()`, or the
  watchers post into a disposed webview.

**Code preview rendering (`src/services/render.service.ts`):**
- `renderCodeHtml(code, fenceLang?)` returns a full `.code-block-wrapper` block;
  `renderCodeRowsHtml` returns only the inner rows — use it when the caller
  supplies its own wrapper (the editable code area) to avoid double-nesting.
- One `.code-line-row` per line → `.line-number` (`contenteditable="false"`, so
  it survives an editable wrapper) + `.code-content` (`pre-wrap`/`break-all`,
  no horizontal scroll).
- `<VK-xxx>` tokens are protected from hljs splitting via `__VK0__` placeholders
  before highlighting, then restored as `.vk-var` spans after.
- All colours use VS Code CSS variables, so light/dark work automatically.

**Module-level helpers (`preview.helpers.ts` unless noted):** `blockAsArtifact`
(ParsedBlock → ParsedArtifactFile; re-exported from `preview.ts` for one import
site) · `performInsert` (cursor, terminal for `command` type, clipboard
fallback) · `labelForVar` (**canonical** — the `WEBVIEW_ESC_LBL_JS` twin is
test-pinned to it) · `popupShell` (`cssUri` takes one URI or an ordered array) ·
`buildItem` / `relFsPath` (`navigator.helpers.ts`).

**Two variable-name conventions — do not conflate:**
- QuickPick descriptions strip the `VK-` prefix **only**: `VK-api_key` → `api_key`.
- Preview/form labels apply full `labelForVar`: `VK-api_key` → `Api key`.

**Insert-time var resolution is three-tier:** user input → `v.defaultValue` →
otherwise the `<VK-xxx>` token is left in the output literally.

### The main pane (`src/ui/views/mainView.*.ts`)

`MainViewProvider` (`mainView.provider.ts`) is a `vscode.WebviewViewProvider`
registered against the activity-bar container, **not** a `TreeDataProvider` —
one webview with two render modes, `idle` and `preview`, so the pane keeps its
content across a mode switch instead of being torn down and rebuilt.

- `idle` — `buildCreateItems()` / `renderIdleHtml()` (`mainView.render.ts`, both
  pure) list one row per create-form-enabled `ArtifactType`, sourced from
  `getCreateFormTypes()`. A row click posts `{ command: 'createType', type }`;
  `resolveCreateCommandId` gates it against the same list the rows were built
  from, so a type can never be clickable here without also being a valid
  target — a per-type fact the pane needs is a new `artifact-type-config.service.ts`
  field, never a branch in this file.
- `preview` — `renderMainViewPreviewHtml()` (`mainView.preview.ts`) dispatches to
  the **existing** `renderPreviewHtml` / `renderMultiBlockPreviewHtml` /
  `renderPopupEmptyHtml` (`artifactPicker/preview.render.ts`) verbatim — no
  second renderer, no second client script. This pane is now the **sole**
  preview host: `createWebviewPanel` no longer appears anywhere under
  `src/ui/panels/artifactPicker/`.

Extension→pane transport goes through `WebviewHost` (`artifactPicker/webviewHost.ts`),
a `vscode`-free wrapper unit-tested against a fake target. It exists because a
`WebviewView` breaks assumptions a `WebviewPanel`-based popup could make for
free — four constraints, each a named fact so the next person does not
rediscover one through a silently dropped message:

- **H1 — you cannot post to a hidden view, even with `retainContextWhenHidden`.**
  The `@types/vscode` typings **contradict themselves** here: the generic
  `Webview.postMessage` doc says a hidden webview with `retainContextWhenHidden`
  still receives messages, but the doc inside `registerWebviewViewProvider`'s own
  `webviewOptions` — the API this pane actually uses — says the opposite, adding
  that such a view's scripts are suspended; `WebviewPanelOptions` documents the
  same restriction for panels. The option-specific doc governs. This was
  litigated once during review and the finding was withdrawn; do not re-open it.
  `WebviewHost.post()` queues while hidden and flushes on visible, last-write-wins
  per `command` (except `QUEUE_AS_EVENTS`, which queue in arrival order because
  each is a distinct fact rather than a state snapshot). Guard: `test/webview-host.test.ts`.
- **H2 — hiding a view disposes it, and disposed ≠ cancelled.** A `WebviewView`
  fires `onDidDispose` on a mere sidebar hide, not only on a real end. `WebviewHost`
  exposes `onDidDispose` (view instance gone) and `onTeardown` (the extension is
  actually done with this host, via explicit `teardown()`) as separate events —
  but **`onTeardown` currently has no subscriber anywhere, and `host.teardown()`
  has no caller**; nothing wires the batch abort to it. The batch actually aborts
  in `preview.ts`'s `dispose()` — `this.batch.settle({ kind: 'aborted' })` — reached
  from cancel, insert, `handleCreateFile` and the navigator's hide/dispose path.
  H2's conclusion still holds (a hide parks a run rather than cancelling it,
  because `dispose()` is what a hide reaches, not a cancel-specific path), but
  the mechanism is `dispose()`, not `onTeardown` — do not go instrument the
  latter expecting it to fire. Guard: `test/webview-host.test.ts` (dispose vs
  teardown as distinct events).
- **H3 — `resolveWebviewView` fires lazily, on first reveal.** `executeCommand('<viewId>.focus')`
  settles when the *reveal* completes, not when the provider callback runs, so
  revealing and immediately posting is a race. `ensureView()` (`mainView.preview.ts`)
  awaits `focus()` and then re-checks resolution, throwing rather than silently
  posting into a view that never resolved. Guard: `test/main-view-integration.test.ts`.
- **H4 — a sidebar pane is ~300px wide against an editor column's ~800px.**
  `main-view.css` loads after `picker.css`/`code-block.css` and reflows the
  preview to a single column; the code area wraps rather than widening the pane
  (`.code-content` is `pre-wrap` + `break-all`, so the sheet carries no overflow
  rule of its own by design — horizontal overflow is unreachable regardless of
  width). Guards: `test/main-view-styles.test.ts` (sheet order) and
  `test/main-view-css.test.ts` (layout rules).

### F5 status — the UI is confirmed to render (2026-09-07)

**The main-pane wave's F5 pass was run and reported passing by the repo owner.**
That is the first human confirmation on this branch that any of this
extension's UI renders at all — every earlier gate had been cleared by
instruction.

Take the scope literally: it confirms the wave's click-paths as exercised, not
every state of every panel. The suite still renders no webview, so **a green
suite remains necessary and nowhere near sufficient** for anything visual; that
rule has not softened. What changed is that the baseline is no longer unknown.

Worth remembering *why* it matters here: immediately before this pass, review
found the preview's whole client script was aborting on load (a Temporal Dead
Zone `ReferenceError`), so the pane widen had been dead in a real window while
1205 tests passed and were reported as working. `test/webview-script-executes.test.ts`
exists because of that and is the one test that would have caught it.

### The pane resize — measured, not assumed

`WebviewView` exposes **no** width member and the workbench width commands are
undocumented internals that act on the **focused** view. Two facts cost real
debugging here, both now pinned by tests:

- **The extension host cannot read the pane's width — but the webview can.**
  It is a real DOM, so `window.innerWidth` inside `PREVIEW_CLIENT_JS` measures
  the pane and posts it back (`measurePane` → `paneMetrics`). The plan's
  premise that "the width cannot be read back" is true only of the *host* API.
  This is what makes the widen closed-loop instead of a blind step count.
- **The commands frequently land on the editor group, not the pane** — in which
  case `increaseViewWidth` *shrinks* the sidebar, exactly inverting the intent.
  Focus cannot be forced (the QuickPick holds it during hover previews), so
  `PaneWidthController` **probes**: one step, re-measure, and if the pane got
  smaller it undoes the probe and swaps the two ids for the session. Restore
  uses whichever id is the opposite of the one that worked, so the
  equal-and-opposite guarantee survives either polarity.

Target is `min(screen.availWidth / 3, MAX_PANE_WIDTH_PX)`. `screen.availWidth`
is the **screen**, not the VS Code window — the two differ when the window is
not maximised, and that is an accepted, deliberate approximation (nothing
exposes the window's size). The accepted sash-drag limitation from the plan
still stands: a drag *during* a preview offsets the restore, and no
compensating heuristic may be added.

**A webview message cannot subscribe its own handler.**
`MainViewProvider.onWebviewMessage` is a single-handler **setter**, not a
multicast event: a second subscriber silently replaces the first, and disposing
it clears the slot outright. That killed Cancel, Edit and Insert once. Anything
needing an inbound reply rides the session handler (`pendingMeasure` is the
pattern). Guard: `test/main-view-integration.test.ts` — "Cancel still routes
after showPreview".

### Editing an artifact — one form, two modes

`Edit` in the preview opens the **artifact form**, not the raw `.md`: same
panel, same column as create (`editArtifact.command.ts` exists because the form
needs the `ExtensionContext` the preview does not carry).
`artifactToFormModel` (`create-prefill.helpers.ts`) is the inverse of the
serializer — **anything it drops is deleted from the vault on the next Save**,
which is why `test/edit-artifact.test.ts` asserts it field by field and round
trips parse → model → serialize → parse.

Edit-mode save writes straight back to `sourceUri`: no folder picker, no
filename prompt, no collision check (that check exists to stop a *new* file
clobbering an existing one, and here the existing file is the target).

**Preview edits are staged, never live.** Typing in the code area *and* saving
in the expanded editor (`⤢`) both stage; only **Overwrite** writes, behind a
`confirmModal`. `BlockEditController` used to patch and write the `.md` on every
save — two editing surfaces for one block with opposite durability — and no
longer touches disk at all. `persistBlockCode` is the single write path.

### Create form — three durable findings (`src/ui/panels/artifactForm/panel.ts`)

- **`openArtifactFormPanel` is a prefill-aware singleton, not a plain reveal.**
  A second call while a form is already open used to `reveal()` and drop the
  incoming `opts` entirely, so a second capture silently reopened the *first*
  capture's form. `decideFormPanelAction({ hasController, hasPrefill, isDirty })`
  now picks one of four actions — `create` / `reveal` / `retarget` /
  `confirm-then-retarget` — and a dirty open form with an incoming prefill goes
  through a `{ modal: true }` confirm (`confirmThenRetarget`) whose Cancel or
  Escape leaves the open form untouched. Every create-from-context path routes
  through this one function, so the fix lives once.
- **`target:` is a form field, not just a frontmatter key.** `ArtifactFormModel`
  carries `target?: string`, rendered in `buildAgentFieldsSection` through the
  shared `buildOptionalTextField` and collected client-side via `TYPE_FIELD_IDS`
  — it belongs in the whole-file table above beside `extension:`, both typed-only
  fields feeding `resolveOutputFileName`.
- **Variables CRUD is a whole-file rewrite through `serializeArtifact`.**
  `variables-writer.service.ts`'s `renderVariablesFile` is a thin, named wrapper
  over the one `.md` emitter — no bespoke Variables serialization exists. Its
  ceiling: a hand-formatted `vks` file is normalised to `serializeArtifact`'s
  canonical emission (blank-line placement, frontmatter key order) on first
  edit — accepted as a rare, low-stakes edge case, with a `patchVksBlock`
  surgical-edit upgrade path named in the code if it ever bites.

### Parser service (`src/services/parser.service.ts`)

Seven exports: `parseArtifactFile` (sync, reads from disk), `parseFromContent`
(pre-read string — used by the picker's async reads), `parseBlocks`,
`extractVars`, `resolveVars`, plus two the drift guards bind:
`VK_TOKEN_RE` (carries `/g` — use only with `matchAll`/`replaceAll`, or reset
`lastIndex`) and `STRING_FRONTMATTER_KEYS`. The parse functions extract:
frontmatter (`---` fences), the ` ```code ` block, vars (a ` ```vks ` fence for
`artifactType: Variables`, else an unfenced `vars:` section after the code), and
`blocks` — `## ` headings each followed by a fence. An empty `blocks` array
signals a single-block file. Tokens are auto-detected by `extractVars`; a
section whose **first** fence is ` ```vks ` is a pure sub-set, while a code
fence *followed by* one gets defaults merged via `mergeVarDefaults` (code order
kept, vks-only keys appended, unmatched detected vars keep `''`).

The body is read one of **two** ways, chosen in a single line of
`parseFromContent`: `readFlaggedPayload` when the file carries flags (see above),
`readFencedPayload` — the classic behaviour, unchanged — otherwise.
**`ARTIFACT_FILE_FORMAT.md` is the authority on all of this** — read it before
touching the parser, the serializer, or any fixture.

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
after that line. That is correct for `Command` — running it is the whole point
— and wrong for `AIPrompt`, whose payload is multi-line flagged markdown by
design, comes from the vault (untrusted by this codebase's standing rule), and
routinely carries a fenced ` ```bash ` block that would otherwise execute
verbatim.

`wrapForTerminal(type, content)` (`artifactPicker/preview.helpers.ts`) wraps a
multi-line payload in **bracketed-paste markers** (`ESC[200~` … `ESC[201~`) —
the same mechanism a real terminal paste uses. The receiving program treats
everything between them as literal text, so the newlines become part of the
input instead of submitting it: the prompt lands as one block, the way
Shift+Enter behaves in a CLI agent, and nothing runs until the user presses
Enter. No trailing newline is added. Wrapping is skipped for single-line
content and for any type not declaring **both** contexts, so `Command` is
byte-identical to before — pinned by a test, because "a `Command` still
executes line by line" is exactly what a well-meaning refactor would break.

Support cannot be detected from the extension host (a shell with bracketed
paste disabled would show the markers literally and still act on each line), so
the confirmation stays as the backstop: `needsTerminalConfirmation(type,
content)` is `true` only when the target is `'terminal'` **and** the content is
multi-line **and** the type declares both contexts — so `Command` never
prompts. A `true` result opens a modal with the line count and a truncated
preview; Cancel or Escape sends nothing.

### Vault directory logic (`constants.ts` + `vault.service.ts`)

Each `ARTIFACTS` entry drives directory creation/detection, context keys, and
command registration. `default: true` (`Snippets`, `AIAgentsConf`, `AIPrompts`)
are auto-created on first vault selection; `default: false` (`Commands`,
`Templates`, `Variables`) are detected but never auto-created.

### Templates and AI Agents Config — one flow, two rows in the table

`Template` and `AIAgentsConfig` are the two **whole-file** artifact types:
invoking one from the Explorer writes a new file into the workspace (primary
button reads **Create File**) instead of inserting at the cursor. Everything
except *where the filename comes from* is literally the same code — treat any
new `artifactType === 'Template'` or `artifactType === 'AIAgentsConfig'`
literal as a bug.

**How they differ** — only in three registry fields and the filename rule:

| | `Template` (`Templates/`) | `AIAgentsConfig` (`AIAgentsConf/`) |
|---|---|---|
| `ARTIFACTS` row | `writesFile: true`, `multiBlock: false`, `default: false` | `writesFile: true`, `multiBlock: true`, `default: true` |
| Type-only frontmatter | `extension:` | `provider:` / `model:` / `version:` |
| Output filename | D3 precedence: typed → `extension:` → fence language | `target:` **verbatim** (`CLAUDE.md`, `.cursorrules`) — never extension-appended |

**Shared path, file by file:**

- `types/constants.ts` — `writesFile` and `form.multiBlock` are the *only*
  declarations of this behaviour. Both flags are read through
  `artifact-type-config.service.ts` (`writesWholeFile`, `forcesSingleBlock`,
  `canMultiBlock`), never re-derived. `getEntry` stays the sole `ARTIFACTS`
  traversal — the new accessors go through it too.
- `services/template.service.ts` — owns both filename rules and the shared D1
  single-block guard. Callers use **`resolveOutputFileName(artifact)`**, which
  dispatches to `resolveAgentFileName` / `resolveTemplateFileName`; the panel
  never branches on type. `validateSingleBlock(parsed, label)` is shared, the
  human label passed in from `getTypeSingular(type)`.
- `services/template.service.helpers.ts` — the rules *both* resolvers need:
  `assertNoPathInjection` (hostile `target:`/`extension:` **throws**, never
  sanitised), `carriesExtension`, `stripTrailingDots`.
- `ui/panels/artifactPicker/preview.ts` — `handleInsert` branches once on
  `writesWholeFile(type)` into the shared `handleCreateFile`;
  `preview.render.ts` labels the button from the same call, so label and
  behaviour cannot drift. `navigator.ts` routes 2+ block files with
  `forcesSingleBlock(type)`, so a malformed multi-block template lands on the
  single preview where the D1 error surfaces.
- `parser.service.ts` / `artifact-serializer.service.ts` — the type-only keys are
  just entries in `STRING_FRONTMATTER_KEYS` + `FRONTMATTER_KEY_ORDER`, all
  emitted through `safeYamlValue` (single-line, so a newline cannot inject a
  sibling key). Details: [`ARTIFACT_FILE_FORMAT.md` §5.2](ARTIFACT_FILE_FORMAT.md).
- `ui/panels/artifactForm/form.html.ts` — `buildExtensionField` and
  `buildAgentFieldsSection` both render through **`buildOptionalTextField`**, so
  the markup and its `escHtml` seeding exist once. `form.clientJs.ts` reads all
  four keys from one `TYPE_FIELD_IDS` list (absent input → `''`).

Adding a third whole-file type is therefore a `constants.ts` row plus one branch
in `resolveOutputFileName` — nothing else.

### Template indexes — batch scaffolding (`services/multi-index.service.ts`)

A **template index** is an ordinary whole-file artifact carrying `index: true`
whose body links sibling artifacts; one run scaffolds every linked file. Format,
link syntaxes, rejection list and carry-over semantics:
[`ARTIFACT_FILE_FORMAT.md` §8](ARTIFACT_FILE_FORMAT.md) — **authoritative**.

**Additive by construction.** No new artifact type, vault directory, command or
menu entry, and the two frontmatter keys are read-side only — so
`package.json`, `types/constants.ts` and `artifact-serializer.service.ts` are
absent from the feature's diff. That absence *is* the design proof; a change
that needs to touch them is a different feature.

| File | Owns |
|---|---|
| `services/multi-index.service.ts` | **THE** link syntax + `safeRelPath`. Pure, `vscode`-free: `isIndexArtifact`, `extractIndexLinks`, `resolveLinkTarget`, `buildIndexPlan`, `buildDestCandidates`, `applyCarryOver`, `summariseRun` |
| `types/multi-index.types.ts` | `IndexStep` · `RejectedEntry` · `IndexPlan` · `DestCandidate` · `CarryOver` · `BatchOutcome` · `RunTally` — no `vscode` import (the runner's callback bag needs `Uri`, so it lives beside the runner) |
| `artifactPicker/multiIndex.ts` | `MultiIndexRunner` — the **only** file doing I/O for the feature |
| `artifactPicker/multiIndex.dest.ts` | `chooseStepDestination` — QuickPick over the candidates + a `Browse…` row deferring to `pickDestFolder` |
| `artifactPicker/preview.batch.ts` | `BatchGate` — the one-shot promise the sequencer awaits |
| `artifactPicker/preview.createFile.ts` | `runCreateFileFlow` — the Create File flow, extracted so one path serves single and batch writes |

**The runner never imports `preview.ts`.** The preview step arrives as the
`previewStep` callback in its bag, so the runner is testable without an
extension host — the same callback-bag rule the picker's controllers follow.
`navigator.ts` composes both, in **one** branch in the accept handler
(`isIndexArtifact` → `runIndex`), placed between the parse and the multi-block
check.

**Non-obvious invariants:**
- `BatchGate.settle()` nulls its resolver **before** calling it, because a
  write, a cancel and a panel disposal can all fire for one step and only the
  first may decide the outcome.
- `runIndex` guards no-workspace and a cancelled destination **before** hiding
  the QuickPick, or a cancelled palette invocation leaves the picker hidden with
  no run behind it.
- Every step runs inside its own try/catch: one bad link degrades to a skip with
  a warning. Only an explicit `aborted` (the user closed the preview panel)
  stops the run.
- An index can never be written verbatim: the picker routes it to a run, and
  `handleInsert` refuses a Create File click on a merely-hovered index.

**🔒 Security — the one thing to re-check when touching this.** This is the
extension's first recursive `createDirectory` into the user's *workspace*,
driven by *vault*-authored text. Two containment assertions guard it and both
sit immediately before the I/O they protect: the resolved link target must stay
inside the index's own vault directory (before any read), and the chosen
destination must stay inside the workspace folder (before `createDirectory`).
Both assertions route through `isPathWithin` (`utils/path-containment.ts` —
**THE** containment authority, see the single-sources-of-truth table above),
via the `isWithinRoot(rootUri, candidateUri)` adapter `multiIndex.ts` imports
from `destFolderPicker.panel.ts`; it never re-implements the
prefix-with-separator check itself, and neither do the other two former copies
of that check (`artifact-writer.service.ts`'s own local adapter, and the
frontmatter migration's symlink-aware wrapper) — one rule, seven call sites
across five modules.
The workspace check also covers the mirrored candidate, which is safe by
construction and never re-validated. This is a **different, earlier** guard
than `safeRelPath` (`multi-index.service.ts`):
`safeRelPath` rejects a hostile link-target or `paths:` *string* before it is
ever turned into a filesystem path (no `..`, no absolute path, no drive
letter/URI scheme, …); `isPathWithin` then checks the *resolved* path actually
lands inside the trusted root. Both **reject and never sanitise**, and neither
decodes, so an encoded traversal stays an inert literal segment at either
layer. The IDE analyser does no taint analysis here; a manual trace is the
only check.

### Flags — plain-markdown payloads (`services/flags.service.ts`)

A vault note is already markdown, so an artifact whose payload *is* markdown —
an agent config, or an **`AIPrompt`** (`AIPrompts/`, ARTIFACT_FILE_FORMAT.md
§5.3) — has nothing to wrap it in: a fence is wrong because the payload may
contain fences. **Flags** mark where the artifact starts and ends, using
Obsidian's own comment syntax so they are invisible in reading view:

```md
notes that are not part of the artifact

%%oa:start Dev%%
Review <VK-repo>.

```bash
npm test
```
%%oa:end%%
```

- **`flags.service.ts` owns the syntax — nothing else may spell it.**
  `extractFlaggedRegions(body)` is the whole API; `flags.service.test.ts` fails
  if any other `src/` file contains the marker, doc comments included (point at
  the service by name instead).
- **Type-agnostic by design.** The parser applies it to every file, so
  `AIPrompt` landed as an `ARTIFACTS` row with **no extraction code** — it
  reuses the same `extractFlaggedRegions` an agent config already used.
- **Flags beat fences**, and are purely additive: a file with no flags parses
  exactly as before. `parser.service.ts` picks between `readFlaggedPayload` and
  `readFencedPayload` in one line.
- One region → single-block file; **named regions → `ParsedBlock`s** keyed by the
  name, reusing the multi-block picker with no new UI.
- **`***` inside a region is chrome.** Flags are invisible in Obsidian, so
  authors bracket a region with `***` to see the block — the visual job a fence
  does for a snippet. Every `***` line between Start and End is dropped;
  **outside a region, and in flag-less files, it is content**. `---` is never
  special (ambiguous with frontmatter and setext H2).
- **Flags are optional for whole-file types.** Precedence is flags → code fence
  → bare body, and the bare-body fallback fires **only** for `writesFile` types
  with nothing fenced, so `Snippet`/`Command` behaviour is untouched. `AIPrompt`
  is **not** a whole-file type, so it never gets that fallback: a prompt with
  no flags and no fence parses to an empty `code` — accepted behaviour, not a
  bug (ARTIFACT_FILE_FORMAT.md §5.3).
- Scanning **skips fenced regions** (a prompt documenting the syntax in a
  ` ```md ` sample must not terminate itself) and defaults `language` to
  `markdown`, which is what makes `extForLang` yield `.md` downstream.
- The whole-file path needed **zero changes**: region content lands in `code`, so
  `validateSingleBlock` and `resolveOutputFileName` apply unaltered.
- **Tokens in an unfenced payload need a render-safe spelling.** `<VK-repo>` is
  a legal HTML tag name, so Obsidian renders it as an unclosed custom element
  that swallows every block below it (this is what broke the ` ```vks ` fence in
  the vault examples). `<VK-repo></VK-repo>`, a lone `</VK-repo>`, or a name
  with `_` all render fine — and all mean the **same variable**
  ([`ARTIFACT_FILE_FORMAT.md` §4.1](ARTIFACT_FILE_FORMAT.md)).

Rules, edge cases, and the vars interaction: [`ARTIFACT_FILE_FORMAT.md` §7](ARTIFACT_FILE_FORMAT.md).

### One runtime dependency

`highlight.js` — imported by `render.service.ts` for code-preview highlighting,
and the only entry in `dependencies`. Everything else is the VS Code API and
Node `fs`/`path`. Keep it that way; the ladder is reuse → stdlib → native
before any new dep.

*(This section previously claimed "no third-party packages" while `highlight.js`
was already in `dependencies` — the same stale-invariant failure the Invariants
section below is about. Corrected rather than left to mislead.)*

**`@vscode/codicons` stays a devDependency on purpose.** It ships the icon font
used by the main pane's create rows. Its assets are **vendored**, not loaded
from `node_modules` at runtime: `src/ui/codicon.css` + `src/ui/codicon.ttf` are
copies checked into `src/ui/`, which is what both `localResourceRoots`
(`extensionUri/src/ui`) and `vsce --no-dependencies` can actually reach —
`node_modules` is invisible to both. That is the count staying at one and not
becoming two; do not "fix" it by moving `@vscode/codicons` to `dependencies`.

**Packaging caveat.** `npx vsce ls` fails on this repo with `npm error
ELSPROBLEMS`: `vsce` shells out to `npm list --production`, which cannot read
pnpm's `node_modules` layout and walks `highlight.js`'s own devDependencies.
Use **`npx vsce ls --no-dependencies`** for the `.vscodeignore` check below.
A real `vsce package` will need this resolved — either an npm-compatible
install or `--no-dependencies` with the dependency bundled another way.

---

## Interactive Preview Panel

**This section describes the main pane's `preview` mode, not a popup.** There
is no `ViewColumn.Beside` popup left in this codebase — `createWebviewPanel`
does not appear anywhere under `src/ui/panels/artifactPicker/` any more. On
Enter, the picker closes and the activity-bar main pane switches to `preview`
mode (see **The main pane**, above) and becomes the interaction surface: an
editable code area (line numbers `contenteditable="false"`, hljs highlighting,
`<VK-xxx>` spans), one `<input>` per token pre-filled from `vars:`, and
**Insert** / **Edit .md** / **Cancel**. The rendering and client script are the
same `renderPreviewHtml` / `renderMultiBlockPreviewHtml` / `PREVIEW_CLIENT_JS`
this section always described — only the host changed.

**CSP requirement:** the pane's webview is **always** created with
`enableScripts: true`. Creating it once with `false` (e.g. after hovering a
multi-block file) silently blocks every button handler with no error.

**Webview ↔ extension message protocol** (`types/webview-messages.types.ts`'s
shared vocabulary — the preview mode, the variable-set flow, and the create
form's block-expand flow all speak it) **survives the relocation unchanged**,
minus two rows that never existed in `src/` (`updateRows`, `switchMode` — a
prior version of this doc invented them) and plus two that did exist but were
missing from the table: `sectionSaved` (preview mode's inline title/description
edit) and `blockUpdated` (create-form only — posted by `artifactForm/panel.ts`
after its expanded block editor saves, not by the preview flow):

| Direction | Command | Payload |
|---|---|---|
| webview → ext | `insert` | `{ code, vars: Record<string,string> }` |
| webview → ext | `fullEdit` / `editBlock` / `cancel` | — (whole `.md` · block temp file · close) |
| webview → ext | `codeChanged` | `{ code: string }` |
| webview → ext | `pickVarSet` / `saveAsVarSet` | `{ values: Record<string,string> }` |
| webview → ext | `confirmApply` / `cancelApply` | — |
| webview → ext | `clearVarSource` | `{ name: string }` |
| ext → webview | `sectionSaved` | `{ section: string, success: boolean }` — ack for a `saveSection` |
| ext → webview | `updateVars` | `{ vars: ParsedVar[] }` |
| ext → webview | `fileUpdated` | `{ artifact: SerializedArtifact }` — after `.md` save |
| ext → webview | `blockUpdated` | `{ index: number, code: string }` — after the expanded block editor saves |
| ext → webview | `showVarSetDiff` | `{ html: string, subSetName: string }` |
| ext → webview | `varSetApplied` | `{ values, subSetName, varNames }` |
| ext → webview | `varSetCancelled` | — |

---

## Vault File Format & Variable Syntax

> The on-disk `.md` structure (single-block, multi-block, `artifactType: Variables`),
> the per-artifact variations table and the `<VK-xxx>` syntax live in
> [`ARTIFACT_FILE_FORMAT.md`](ARTIFACT_FILE_FORMAT.md) — **authoritative**, and
> what the parser implements and `parse(serialize(x)) ≅ x` must satisfy. If it
> and the code disagree, that is a bug to reconcile, not a judgement call — and
> the reconciliation extends the shared code to match the spec, never the
> reverse.

---

## Writing a Plan — and running one

**Two different jobs, two different files. Do not confuse them.**

> **Writing a plan → read [`CREATING_A_PLAN.md`](CREATING_A_PLAN.md) first.**
> A multi-phase feature breakdown, a multi-agent dispatch, or anything that lands
> under `docs/plans/`. It is the **authoring** authority; a plan under
> `docs/plans/<feature-slug>/` is one instance of it.
>
> It owns: where plan files live and why they never merge (`git rm -r docs` is
> the last commit before the PR), the orchestrator/reviewer/worker topology and
> their prompt templates, the dispatch mechanics (workers `sonnet`, reviewer and
> orchestrator `opus`, named on **every** spawn), the mandatory skills, the task
> spec, the **refinement waves** (§5.3), the gate command, the ledger format, and
> the plan's definition of done.
>
> **A drafted plan is not a runnable plan** (`CREATING_A_PLAN.md` §5.3). Two
> further Opus roles refine it, per wave, before anything is dispatched — the
> **Loopholes and Details Fixer** (ambiguity, goal reachability, disjointness,
> and every `Signatures` / `Test first` claim verified against the actual tree)
> and the **Tasks Optimizer and Resource Finder**, which is the plan's **TDD and
> DRY** specialist: it enforces that each task's test work is ordered *before*
> its implementation in the task's own text, and that every task names the
> existing component, helper, table or service it reuses rather than growing a
> sibling. Cycle is A → apply → B → apply → A again → `ready`. Both roles are
> **read-and-report and never edit a file** — the plan is single-writer, like the
> ledger.
>
> **Refinement passes are human-triggered and agent-requested**, exactly like
> execution waves. The authoring agent stops after each draft or application and
> **asks** for the next pass by name and scope; it never chains A → B → A on its
> own, and `READY` means *runnable*, never *run it*. The plan carries a
> refinement status table mirrored into `progress.md`, and **no wave is
> dispatchable while its row reads anything but `ready`.**

> **Running a plan → read the plan, and nothing else.**
> **Every plan in this repo is self-contained by construction**
> (`CREATING_A_PLAN.md` §5.2): it ends with an **execution appendix** carrying all
> five role prompt templates verbatim — the three execution roles and the two
> refinement roles — plus the dispatch mechanics, the gate, the review loop, the
> commit-and-push policy, the skills table and the static-analysis rule.
> An orchestrator that has never opened `CREATING_A_PLAN.md` can run it.
>
> **Do not send an executing agent to `CREATING_A_PLAN.md`.** It is ~800 lines of
> guidance about a job that is already finished, and it invites re-deriving
> decisions the plan has already made and recorded. If something needed to execute
> is missing from the plan, that is a **bug in the plan** — fix it there. The only
> agent that opens the authoring file after authoring is one whose task is to edit
> it.
>
> A plan's three files — `plan.md`, `progress.md`, `jira-tickets.md` — are one
> document in three projections (specification · ledger · external contract). All
> three are read before dispatch, and a change to one propagates to all three;
> `docs/` is gitignored, so no diff or CI will ever catch a divergence.
>
> Two standing rules from it that bind work outside a plan too:
> **static analysis runs through the *SonarQube for IDE* (SonarLint) VS Code
> extension** — its `<ide_diagnostics>` arrive on their own after every
> `Edit`/`Write` and are fixed, not filed; never invoke `sonar-analyze`, the
> `mcp__sonarqube__*` tools, or the `sonar` CLI (§3.1). And the IDE analyser
> does **no taint analysis**, so on subprocess, filesystem, and webview
> surfaces a manual security trace is the only check that exists.

---

## Variable Sets

Reusable bundles of `<VK-xxx>` defaults applied to any artifact at insert time,
stored in the vault's `Variables/` directory (shape:
[`ARTIFACT_FILE_FORMAT.md` §6](ARTIFACT_FILE_FORMAT.md)).

**Scoring:** `score = matchRatio * 0.7 + (tagMatches / totalArtifactTags) * 0.3`.
Vars match on exact `name` (full `VK-xxx` token, case-sensitive); tags match
against the artifact's frontmatter `tags`.

**Apply flow:** **[Apply Variable Set]** → QuickPick of every sub-set across
every variable file, score-sorted → `applyVarSet(currentValues, subSet.vars)`
posts `changes[]` as a diff preview (`renderVarSetDiffHtml`) → **Apply** commits
or **Cancel** reverts. Applied inputs gain a `from: <setName>` badge; editing an
input clears it. Sets **stack** — later sets override overlapping vars, earlier
non-overlapping ones persist.

**Save-as flow:**

- The variables section also exposes **[Save as Variable Set]**, visible only when at least one input has a non-empty value.
- On click the extension prompts for title and (optional) description, then
  builds a model with `buildVarSetModel` (`varset.service.ts`) and emits it
  through **`serializeArtifact`** — there is no bespoke var-set file builder.
  The slug comes from `filename.service.slugify`; tags are copied from the
  active artifact. Byte output is locked by `test/snapshots/varset/*.md`.
- The shared `VarSetScanner` cache is invalidated after the write so the next pick run sees the new file.

**Source tracking:** `PreviewModeController.varSources` holds
`varName → setName` so the badge survives extension-side re-renders; the webview
posts `clearVarSource` when the user edits an input.

**Module map:** `services/varset.service.ts` (`VarSetScanner` cached recursive
scan, `scoreVarSet`, `extractSubSets`, `applyVarSet`, `buildVarSetModel` — pure
parts unit-tested in `test/varset-*.test.ts`) · `panels/varsetPicker.panel.ts`
(`pickVarSet`, `getVarSetScanner` for cache invalidation) ·
`artifactPicker/varSetDiff.ts` (`renderVarSetDiffHtml`) ·
`artifactPicker/varSetController.ts` (composed by `PreviewPanelController`) ·
`types/varset.types.ts`.

Messages are in the single protocol table above.

---

## Key Config Files

| File | Purpose |
|---|---|
| `tsconfig.json` | Strict mode, `ES2022` target, `Node16` module resolution, `rootDir: "."`, output to `dist/` |
| `package.json` | `"main": "./dist/src/extension.js"` — mirrors the `rootDir: "."` output path |
| `eslint.config.mjs` | Enforces naming conventions, curly braces, `===` equality, semicolons |
| `.vscode/launch.json` | Debug launch with `--extensionDevelopmentPath`; other extensions disabled in the host |
| `.vscode/tasks.json` | `npm watch` is the default build task (runs automatically on F5) |
| `.vscode-test.mjs` | Test runner looks for compiled tests at `dist/test/**/*.test.js` |
| [`ARTIFACT_FILE_FORMAT.md`](ARTIFACT_FILE_FORMAT.md) | **Authoritative** artifact `.md` structure spec — parser/serializer contract. Read before touching vault files, fixtures, parser, or any writer. |
| [`CREATING_A_PLAN.md`](CREATING_A_PLAN.md) | **Authoritative** plan-writing process — agent topology, prompt templates, task spec, refinement waves (§5.3), gate, ledger. Read before writing any plan or dispatching agents. |

---

## Internationalisation — two files, two escaping rules

**Two mechanisms, and they are not interchangeable.** `package.nls.json` /
`package.nls.es.json` localise the **static manifest** (`contributes.*`, read
before activation). `l10n/bundle.l10n*.json` plus `vscode.l10n.t()` localise
**runtime** strings. `engines.vscode` is `^1.117.0`, so `vscode.l10n` (since
1.73) is available; **`vscode-nls` is deprecated and forbidden**, and
`@vscode/l10n-dev` stays a **devDependency** — the one runtime dependency is
still `highlight.js` alone.

**`package.json`'s `"l10n": "./l10n"` points at the *directory*, not the file.**
Pointing it at `bundle.l10n.json` makes every language fall back to English
with **no error** — a green suite cannot tell the difference. Guarded by
`test/packaging-assets.test.ts`.

**Regenerate with:**

```bash
npx @vscode/l10n-dev@0.0.35 export -o ./l10n ./src
```

This writes **English only**; the `es` bundle is extended by hand. Assert growth
**numerically** (`Object.keys(bundle).length` before vs after, strictly greater)
— an unchanged count means the extractor saw no new call sites, and the whole
wave's output is inert. Then re-assert **parity**: every `en` key present in
`es`, and identical `{0}` placeholder sets on both sides. Identical *values* are
expected for product nouns (`Variables`, `Variable`) and are deliberately
unguarded.

**Three string shapes are invisible to the extractor** — each ships a silent
English fallthrough, so none may be used:
- a **dynamic key** — `l10n.t(someVariable)` produces no bundle entry. Write an
  explicit lookup with one literal `l10n.t` call per case (see
  `artifactPicker/varSetDiff.ts`'s `actionLabel`).
- a string built by **concatenation** — use a single `{0}` template instead.
- `getTypeSingular`'s nouns, absent **by design** (decision D-8) — exclude them
  when reading a growth count, or the delta looks like a miss.

### 🔒 Escaping is per destination — `escHtml` and `jsStr` are not substitutes

| Destination | Rule |
|---|---|
| HTML text or attribute | `escHtml` (`utils/html.ts` — all five of `&<>"'`) |
| A string literal inside a client script | `jsStr` (`artifactPicker/webviewSnippets.ts`) |
| A localised string that a **client script concatenates into HTML** | `jsStr(escHtml(l10n.t(...)))` |

`escHtml` is wrong inside a `<script>`: its entities are never decoded there, so
`&amp;` reaches the user literally, and it does not neutralise `</script>`.
`jsStr` handles that (`</` → `<\/`, and `<!--`, which puts the script-data
tokeniser into escaped state) — but **`jsStr` is not an HTML escape.** It
guarantees a valid JS *string literal* and nothing more. Where a client script
builds HTML by concatenation the value crosses **two** boundaries, so both
escapes apply, HTML first: a bundle value containing `"` otherwise breaks out of
the attribute it lands in. That inner-first order is the inverse of the usual
rule and is deliberate.

**Escape *after* format, never both.** `escHtml(l10n.t('from: {0}', src))` is
correct; `l10n.t('from: {0}', escHtml(src))` double-escapes; `l10n.t('from: {0}',
src)` alone is an injection.

**Keep markup out of bundle strings.** A `{0}` argument carrying raw HTML means
the *outer* `l10n.t` result cannot simply be wrapped in `escHtml` without
escaping that markup too. Pass text through `l10n.t`, escape it, and wrap it in
tags at the call site — the shape `preview.render.ts`'s `env`/`target` pills
already use.

**Client scripts resolve their strings in the extension host, at import time.**
The module building the script string is extension-host TypeScript, so it calls
`l10n.t` there and bakes the result into the constant — no injection plumbing,
no runtime handshake. The display language is fixed at activation, which is fine:
VS Code requires a reload to change it.

**The nineteen `vscode`-free services localise at the caller**, never by
importing `vscode` themselves. Renderers may call `vscode.l10n.t` directly —
they are UI, not domain.

**🔒 A green suite proves nothing here.** `l10n.t` falls back to the English
source string when no bundle is loaded, so every test passes identically
against a working bundle, a broken bundle and no bundle at all. The **F5 pass in
a Spanish display language is the only verification that exists.**

---

## VS Code Extension Notes

- `package.json` declares `"activationEvents": ["onStartupFinished"]` — activation is already narrowed off "every window open"; it fires once, after VS Code finishes starting up, not eagerly during startup and not per-command. Nothing further to narrow here without a reason.
- Compiled output goes to `dist/` and is **gitignored**. Run `npm run compile` after cloning.
- `media/` ships in the packaged extension. `src/`, `test/`, and `dist/test/` are excluded via `.vscodeignore` — **except `!src/ui/*.css` and `!src/ui/*.ttf`**, both of which must stay globs. The webviews load stylesheets (and the vendored codicon font) from source, so a named per-file exception silently ships a CSS-less or font-less extension when an asset is added or renamed, and the suite stays green because tests run from source. Verify with `npx vsce ls --no-dependencies | grep -E 'src/ui/.*\.(css|ttf)'`, which must print **eleven** matched lines (ten stylesheets + `codicon.ttf` — always cite the count together with this exact command; a bare number is ambiguous between the sheet count and the matched-line count). The **i18n assets ship the same way and need the same care**: widen the grep to `'src/ui/.*\.(css|ttf)|package\.nls|l10n/'` and it must print **fifteen** — the eleven above plus `package.nls.json`, `package.nls.es.json`, `l10n/bundle.l10n.json` and `l10n/bundle.l10n.es.json`. `.vscodeignore` excludes none of them today, which is exactly why `test/packaging-assets.test.ts` guards it: the guard scans every non-comment, non-`!` line's *content*, because an earlier column-0-anchored version stayed green while `**/l10n/**` silently stripped both bundles from the package. The `--no-dependencies` flag is not optional here — see the
packaging caveat above; without it `vsce` exits non-zero and `grep` finds
nothing, which reads exactly like a missing-asset failure.
- All imports use explicit `.js` extensions (e.g. `'./helpers.js'`) — required by `Node16` module resolution even for `.ts` source files.
- Webview `localResourceRoots` is restricted to `extensionUri/src/ui` — all webview assets must live in `src/ui/`.

---

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

**Known debt, not yet paid** (measured with `wc -l` at the close of the i18n
wave, 2026-09-18 — **re-measure before trusting these on a later read**):

`artifactPicker/preview.ts` is **699** lines — past the ~400 guideline, past the
~500 "plan a split" mark, and now at the **700 "split before adding"** line. It
is the next split, not a someday. The seam is the one `artifactForm/` already
uses and that this file was split on once before: controller (`preview.ts`) ·
renderers (`preview.render.ts`) · webview script (`preview.clientJs.ts`) · pure
helpers (`preview.helpers.ts`). The width/measure plumbing and the staged-edit
handlers are the natural next extractions.

`artifactForm/form.clientJs.ts` is **628**. It crossed the mark during the i18n
wave for a reason that is *not* padding: resolving localised strings at module
scope needs one `const` per string, which an in-place literal swap cannot avoid.
The split was deliberately deferred rather than churn a file that had an open
security fix landing on nine of its lines in the same wave.

**Over the guideline today:** `services/parser.service.ts` (**653**) ·
`artifactPicker/preview.ts` (699) · `artifactForm/form.clientJs.ts` (628) ·
`artifactForm/panel.ts` (**548**) · `services/frontmatter-migration.service.ts`
(**505**) · `commands/variables.command.ts` (**462**) ·
`ui/panels/settings.panel.ts` (**446**) · `artifactPicker/navigator.ts` (**445**).

**Approaching it:** `artifactPicker/preview.helpers.ts` (395) ·
`services/artifact-type-config.service.ts` (394) ·
`ui/views/mainView.provider.ts` (394) · `commands/variables.command.helpers.ts`
(392) · `services/pane-width.service.ts` (340) ·
`services/artifact-patcher.service.ts` (330) ·
`commands/create-from-surface.command.ts` (329) ·
`artifactPicker/webviewHost.ts` (327).

None of these are mid-edit right now — this is a marker for whoever touches one
next, not a todo.

---

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
`getEntry` try/catch) and escape everything interpolated into webview HTML.

### Comments
- Every function and interface must have a JSDoc block that includes: a concise description, `@param` tags, a `@returns` tag, and at least one `@example`.
- Add inline section comments (e.g. `// ── Section name ───`) to visually group logical blocks within longer functions.
- Comments should explain **why**, not **what** — well-named identifiers already describe what the code does.

### File organisation
Domain logic in `services/`, shared pure helpers in `utils/`, constants in
`types/constants.ts`, types in `types/` (**no `vscode` imports there** — adapt at
the edges), webview HTML + message handling in `ui/panels/`. Commands and panels
stay thin wiring.

### ESLint gotchas
- Use `RegExp.exec(str)` not `str.match(re)` — rule `S6594`.
- Use `str.startsWith(x)` not `/^x/.test(str)` — rule `S6557`.
- No nested template literals — extract inner expression to a variable first — rule `S4624`.
- Cognitive complexity limit is 15 per function (`S3776`) — extract sub-methods when approaching it.
