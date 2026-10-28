# Webview UI

The preview's message protocol and the reusable UI building blocks (markup + one client-script string each). Part of [`AGENTS.md`](../AGENTS.md) — read it first.

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

## Reusable UI building blocks (DRY)

Webview scripts cannot `import`, so a shared UI piece is **two halves in one
file**: a server-side markup builder and one exported client-script **string**,
interpolated once per bundle (the `WEBVIEW_ESC_LBL_JS` pattern). Never paste a
copy into a second script; extend the shared file.

| Piece | Server half | Client half | Users today |
|---|---|---|---|
| Tags field | `buildTagsField(tags, labelClass)` | `TAGS_FIELD_CLIENT_JS` (expects `let tags` + `markDirty`) | artifact form, var-set form |
| ↑/↓ reorder | `buildReorderButtons(itemClass, index, total, attrs)` | `REORDER_CLIENT_JS` — `reorderWire(container, onMoved)`, `reorderRefreshAll(root)`, `reorderButtonsHtml(item, attrs)` for script-built rows | artifact form block cards; var-set sub-sets and rows |
| View Info popup | build an `InfoModel` (`types/info.types.ts`) | none — static page, CSP forbids script | Variables pane (`variables-info.command.ts`) |

**Reorder rules:** an item is any element with a class; its buttons carry
`data-reorder="<class>"`, so nested lists (rows inside sub-sets) never move the
wrong thing. Moves stay among same-class siblings. The control only moves DOM —
the form must collect values in document order (both do).

**Adding View Info to another artifact** (e.g. snippets): write one adapter
`build<Type>Info(…) → InfoModel` (labels via `vscode.l10n.t` there — types stay
`vscode`-free) and call `openInfoPanel(extensionUri, model)`. No new panel,
renderer, stylesheet or message protocol.

**Adding per-row actions to another tree:** follow `VARIABLES_ROW_ACTIONS` —
a table in `types/constants.ts` keyed by `contextValue`, categories as menu
groups `<n>_<category>@<i>`, `package.json` as a generated mirror, and a guard
test that rebuilds the mirror from the table. Same idea as `ARTIFACTS` →
insert menus.

**Other shared pieces worth knowing:** `base.css`'s `button[hidden]` rule (a
bare `button { display }` otherwise beats the UA's `[hidden]`), `confirmModal`,
`escHtml` / `jsStr`, and the test harness (`test/webview-dom-harness.ts`, which
now supports `insertBefore`, `removeAttribute`, `hasAttribute` and textarea
values) for clicking real client scripts in tests.

---
