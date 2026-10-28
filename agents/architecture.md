# Architecture

How the extension is put together: folders, activation, the picker, the main pane and its webview transport, the pane resize, and the edit/create form. Part of [`AGENTS.md`](../AGENTS.md) — read it first.

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
│   ├── variables.command.ts (+ .command.helpers · .confirm.helpers)  # Variables CRUD commands + confirmations
│   ├── variables-add-blank.command.ts  # Blank set's "Add…" (Variable or Sub-set)
│   ├── variables-meta.command.ts     # Edit Description… / Edit Tags… (pane)
│   ├── variables-info.command.ts     # View Info — the Variables adapter for the info popup
│   ├── var-name-prompt.helpers.ts    # Pane prompts with the fixed VK- prefix
│   └── variables-apply.command.ts · variables-search.command.ts
├── engine/                           # THE engine client — the only code that talks to `mda`
│   ├── session.ts                    # NDJSON JSON-RPC framing, ids, pending, timeout (the only wire code)
│   ├── supervisor.ts                 # spawn, handshake (protocol 2.0, O-2 type check), restart with backoff
│   ├── engine.vscode.ts              # the VS Code edge: real spawn, Output channel, getEngine() (sole child_process)
│   ├── locate.ts                     # find the binary (setting → PATH), install hint
│   ├── errors.ts                     # THE code → vscode.l10n.t table (en + es)
│   ├── request-error.ts              # the error a request rejects with
│   ├── adapt.ts                      # THE engine → extension shape + path conversion (isPathWithin)
│   ├── model.ts                      # THE extension ↔ engine write model (copies read layout / paths)
│   └── legacy-import.ts              # one-time import of the deprecated vaultPath / features.* settings
├── services/                         # UI-side logic only — every vault rule is the engine's
│   ├── artifact-type-config.service.ts   # THE ARTIFACTS reader — getEntry, getAllTypes, getFormConfig…
│   ├── config.service.ts                 # THE settings reader — CONFIG_SECTION, getVaultPath(RootUri)
│   ├── render.service.ts                 # renderCode(Rows)Html (hljs) + THE `<VK-xxx>` token syntax — VK_TOKEN_RE, extractVars
│   ├── template.service(.helpers).ts     # resolveOutputFileName — the Create File prompt's default name (W5 R2; ER-5 would retire it)
│   ├── varset.service.ts                 # VarSetScanner (cache over vars.list), getVarsFileShape, extractSubSets, edit-payload adapters
│   ├── scratch-file.service.ts           # THE temp edit-file lifecycle (extension storage, O-10) + slugify for scratch names
│   ├── vault-watch.service.ts            # session vault + FileSystemWatcher cache invalidation (the engine sends no change events)
│   ├── conflict.service.ts               # THE file.conflict / file.exists UX for every engine write
│   ├── context.service.ts · language-map.service.ts · preview-target.service.ts
│   ├── pane-width.service.ts         # THE pane-resize rule — closed-loop widen, equal-and-opposite restore (vscode-free)
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
│   │   ├── shared/                   # Cross-editor UI pieces (markup + one client-script string each):
│   │   │                             # tagsField.ts · reorderControls.ts — see "Reusable UI building blocks"
│   │   ├── varsetForm/               # Variable Set editor: render · subsets (sub-set groups + edit script) · panel
│   │   ├── infoPanel/                # View Info popup — infoPanel.ts (open/reuse) · infoPanel.render.ts (pure, no script)
│   │   └── settings.panel.ts · varsetPicker.panel.ts · destFolderPicker.panel.ts
│   ├── base.css                      # Global reset + bare h1/hr/button — EVERY panel links this
│   ├── main-view.css                 # Narrow-pane layout overrides for the sidebar preview
│   ├── codicon.css · codicon.ttf     # Vendored @vscode/codicons — see "One runtime dependency" below
│   └── settings.css · picker.css · form.css · hljs.css · code-block.css · varset.css
├── types/
│   ├── constants.ts                  # ARTIFACTS · LANG_ALIAS · LANG_FENCE · LANG_EXT
│   ├── parsed-artifact.types.ts      # ArtifactType union, ParsedArtifactFile, ParsedBlock, ParsedVar
│   ├── multi-index.types.ts          # IndexStep · IndexPlan · DestCandidate · CarryOver · BatchOutcome
│   ├── info.types.ts                 # InfoModel — what a View Info popup shows (artifact-agnostic)
│   └── artifact.types.ts · artifact-form.types.ts (CaptureResult · CaptureFn) · varset.types.ts · webview-messages.types.ts
├── utils/
│   ├── helpers.ts                    # getNonce() — CSPRNG-backed
│   ├── html.ts                       # THE escHtml (& < > " ') + styleLinkTags
│   └── path-containment.ts           # THE containment rule — isPathWithin(root, candidate)
├── features/ · providers/            # (empty) reserved
media/md-artifacts.svg          # Activity-bar container icon — replaceable, referenced by path only
test/                                 # 1607 tests (W5). fixtures/ (engine/op-cases, engine/recorded) + snapshots/form-html
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

On folder pick the panel asks the **engine**: `vault.inspect` (is it an Obsidian
vault, which type directories exist) → `vault.select { createDefaults: true }`
(the engine creates the `default: true` directories and persists the vault in
**its own** machine config — Settings Sync no longer carries it, E-8). Type
toggles are `types.set_enabled` (stored in `<vault>/.mda/config.toml`); toggling
off only disables — the engine never deletes a directory (V-11). The panel's own
`mdArtifacts.*` writes are the `mainPane.*` numbers (`isMainPaneKey`-gated);
the other programmatic writer is `config.service.ts`'s
`setVariablesHeightFraction`, beside its reader. Those two are the whole set;
nothing else may call `update()` on the section. The legacy `vaultPath` /
`features.*` settings are **deprecated**: read once by `engine/legacy-import.ts`
on first start (O-4), never written.

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
  posting into a view that never resolved. `ensureView` also reveals a view that
  is resolved but hidden (`retainContextWhenHidden` keeps it resolved behind
  another container) — `visible()` on `ViewTarget` (W-UI c). Guard: `test/main-view-integration.test.ts`.
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
engine's read — **anything it drops is deleted from the vault on the next Save**,
which is why `test/edit-artifact.test.ts` asserts it field by field (the byte
round trip itself is the engine's: conformance `serialize/form-*`, `rs-idem-*`).

Edit-mode save goes back to the same file through `artifact.update`: no folder
picker, no filename prompt. It sends the read's `expectedHash` and copies its
`layout` / `frontmatter.paths` (`engine/model.ts`); if the file changed since
the read, the engine answers `file.conflict` and `conflict.service.ts` shows the
reload / overwrite modal — nothing is written silently.

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
- **Variables CRUD goes through the engine's `vars.*` ops** (`vars.var.add`,
  `vars.subset.rename`, …) and `artifact.update` for the Variable Set editor —
  each with the `expectedHash` of the read it edits. There is no TS emitter;
  the engine writes canonical ```` ```yaml VKs ```` (Obsidian-style frontmatter,
  `tags` last), so a hand-formatted file is normalised on its first edit.

### Known file-size debt

Measured with `wc -l` at the close of W5 (2026-10-28) — **re-measure before
trusting these on a later read**. `preview.ts` was split in W2 (699 → 390); the
653-line parser and 505-line migration service were deleted in W5.

**Over the guideline:** `artifactForm/form.clientJs.ts` (**559** — one `const`
per localised string, deferred split) · `artifactPicker/navigator.ts` (**463**) ·
`varsetForm/varsetForm.render.ts` (447) · `commands/variables.command.ts` (447) ·
`ui/panels/settings.panel.ts` (440) · `artifactForm/panel.ts` (439) ·
`ui/views/variablesView.provider.ts` (424) · `commands/variables.command.helpers.ts` (405).

**Approaching it:** `ui/views/mainView.provider.ts` (395 — R10: anything further
must split it first) · `services/artifact-type-config.service.ts` (394) ·
`artifactPicker/preview.ts` (390) · `types/constants.ts` (363) ·
`types/engine.types.ts` (362) · `ui/panels/destFolderPicker.panel.ts` (341) ·
`services/pane-width.service.ts` (340).

A marker for whoever touches one next, not a todo. The seam for a panel file is
the one `artifactForm/` and `preview.ts` were split on: controller · renderers
(`*.render.ts`) · webview script (`*.clientJs.ts`) · pure helpers (`*.helpers.ts`).
