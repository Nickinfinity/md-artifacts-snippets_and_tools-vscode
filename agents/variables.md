# Variables

Variable Sets (apply / save-as) and the Variables UI: file shapes, the pane, the editor, and what a save must preserve. Part of [`AGENTS.md`](../AGENTS.md) — read it first.

## Variable Sets

Reusable bundles of `<VK-xxx>` defaults applied to any artifact at insert time,
stored in the vault's `Variables/` directory as ```` ```yaml VKs ```` fences (shape:
the engine's `spec/ARTIFACT_FILE_FORMAT.md` §6).

**Apply flow:** **[Apply Variable Set]** → QuickPick of every sub-set (the
`VarSetScanner` cache over `vars.list`) → the engine's `varsets.apply` returns
the changes, shown as a diff preview (`renderVarSetDiffHtml`) → **Apply**
commits or **Cancel** reverts. Applied inputs gain a `from: <setName>` badge;
editing an input clears it. Sets **stack** — later sets override overlapping
vars, earlier non-overlapping ones persist. (The TS scorer and the ranked
picker are gone — `varsets.match` exists engine-side, unused.)

**Save-as flow:** **[Save as Variable Set]** (visible when at least one input has
a value) prompts for title and optional description, then calls the engine's
`varsets.save` — the engine names the file, refuses a bad title / name
(`vars.bad_title` / `vars.bad_name`) and writes ```` ```yaml VKs ````; tags are
copied from the active artifact. The `VarSetScanner` cache is invalidated after
the write.

**Source tracking:** `PreviewModeController.varSources` holds
`varName → setName` so the badge survives extension-side re-renders; the webview
posts `clearVarSource` when the user edits an input.

**Module map:** `services/varset.service.ts` (`VarSetScanner`, `getVarsFileShape`,
`extractSubSets`, the edit-payload adapters) · `panels/varsetPicker.panel.ts`
(`pickVarSet`, `getVarSetScanner`) · `artifactPicker/varSetDiff.ts` ·
`artifactPicker/varSetController.ts` (`varsets.apply` / `varsets.save`, composed by
`PreviewPanelController`) · `types/varset.types.ts`.

Messages are in the single protocol table above.

---

## Variables UI — the pane and the editor

Two surfaces edit the same `Variables/*.md` files: the **Variables pane** (a
tree in the activity bar) and the **Variable Set editor** (`varsetForm/`, a
webview form opened by the pencil icon / "Edit Variable Set"). Both write
through the **engine** (`vars.*` ops / `artifact.update` with the read's
`expectedHash`); neither has an emitter of its own.

### File shapes — everything derives from these

`getVarsFileShape(parsed)` (`varset.service.ts`) is the one classifier — an adapter
over the engine read, pinned equal to `vars.list`'s own `shape` by
`varset-shape-engine.test.ts`:

| Shape | On disk | Pane shows | Row `contextValue` |
|---|---|---|---|
| `blank` | frontmatter only | the file row, no children | `fileBlank` |
| `flat` | one **untitled** ```` ```yaml VKs ```` fence | file → variables (no sub-set level) | `fileFlat` |
| `sets` | one or more `## Title` + fence — **even one** | file → sub-sets → variables | `fileSets` |

Read from structure, never from a count: a single *titled* sub-set is `sets`.
A flat file with zero variables writes no fence, so it reads back as `blank` —
deliberately the same thing.

**Moving between shapes** (one rule each, shared by pane and editor):
- blank → flat: first variable goes into an untitled block (`handleAddVar` gives
  a blank model one).
- blank → sets / flat → sets: the engine's `vars.subset.add` is **the** place a
  flat file gains sub-sets — it names the untitled block `Default`. The editor
  pre-fills the same name (`DEFAULT_SUBSET_NAME`, `varsetForm.subsets.ts`).
- sets → flat: editor only — delete down to one sub-set and clear its name.
- sets → blank: delete every sub-set (pane or editor); the file stays, header only.

### The pane

- **Rows by position.** Commands address a sub-set by the clicked row's
  **index** (`SubSetRef = string | number` in the mutators), never by heading:
  an untitled block has no heading and hand-written files may repeat one.
  `toFormModel` and `extractSubSets(parsed, { includeEmpty: true })` are
  block-for-block aligned so a row index is a model index. Empty sub-sets are
  shown (a just-created one must appear); the Apply picker still filters them.
- **One inline `+` per row**, chosen by shape: blank → **Add…** (quick-pick:
  Variable or Sub-set), flat → Add variable, sets → Add sub-set, sub-set row →
  Add variable.
- **Right-click is categorised** into separated sections, in this order:
  **View** (View Info) · **Create** · **Edit** · **Apply** · **Delete**. What each
  row offers lives in `VARIABLES_ROW_ACTIONS` (`types/constants.ts`) — the
  table, not `package.json`, is the source; regenerate the menus from it and
  `package-variables-menus.test.ts` holds the two equal. To change a menu, edit
  the table, then mirror it.
- **Shown compactly, searchable.** File rows show tags (`#tag`) beside the name
  and description + tags on hover; sub-set rows show their description. Search
  matches titles, names, values, descriptions and tags.
- **Edit from the pane:** Edit Description… (set or sub-set — a multi-line one is
  refused and pointed at the editor, never flattened), Edit Tags… (commas or
  spaces, leading `#` ok), Rename, Edit Value. Name prompts ask only for the
  part after `VK-`.
- **View Info** opens the shared info popup (see building blocks below).

### The editor (Variable Set form)

- Per sub-set: name (✎ swaps the `<h3>` for an input), description textarea,
  ↑/↓, 🗑 (codicons `edit`/`trash`, matching the pane). Every sub-set can be
  deleted, the last included. Per variable row: fixed `VK-` label + the rest of
  the name, value, ↑/↓, 🗑.
- **Everything is staged in the DOM until Save**; Cancel discards. The client
  posts `pairs`, `headings` and `descriptions` grouped per `.subset-group` in
  **document order** — so a move on screen *is* the reorder in the file.
  Posted headings/descriptions are authoritative (after a delete the original
  file is no longer index-aligned); only a payload without them falls back to
  the opened file by index.
- Validation on Save: the duplicate non-empty heading check only; everything
  else is the engine's (see "Editor guards" below).

### What a save must preserve (each one was a real data-loss bug here)

Frontmatter `description`, `tags`, `env`; each sub-set's description; an
untitled block staying untitled (the set title used to leak in as `## Title`).
The engine round-trips all of them; `variables-metadata.test.ts` asserts the
`artifact.update` model carries every field, and the engine's `rs-idem-*`
conformance cases hold the byte round trip.

**Editor guards (W5-d):** only two content checks remain before a request —
the payload shape guards (`parseVarSetFormPayload` / `parseVarsEditPayload`, the
trust boundary) and **duplicate non-empty sub-set headings** (`artifact.update`
accepts duplicates). Every other rule — names, newlines, fence or `## ` lines in
descriptions, empty headings — is the engine's refusal (`vks.bad_key`,
`artifact.unrepresentable`, …), proven on the real binary with the file's bytes
unchanged (`engine-smoke.test.ts`).
