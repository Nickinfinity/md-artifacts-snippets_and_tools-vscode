# Whole-file types and template indexes

Templates and AI Agents Config (write a file instead of inserting), 🔒 template-index batch scaffolding, and flagged plain-markdown payloads. Part of [`AGENTS.md`](../AGENTS.md) — read it first.

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
- `services/template.service.ts` — the **default name** the Create File prompt
  shows: **`resolveOutputFileName(artifact)`** dispatches to `resolveAgentFileName` /
  `resolveTemplateFileName`; the panel never branches on type. It is a TS twin of
  the engine's own naming (`artifact.write_file` with no `fileName`), kept only
  because no op returns that name before the write (W5 R2; engine request ER-5
  would retire it). The write itself — and its `naming.*` refusal of a hostile
  typed name — is the engine's. The single-block rule is the engine's too.
- `services/template.service.helpers.ts` — the rules *both* resolvers need:
  `assertNoPathInjection` (hostile `target:`/`extension:` **throws**, never
  sanitised), `carriesExtension`, `stripTrailingDots`.
- `ui/panels/artifactPicker/preview.ts` — `handleInsert` branches once on
  `writesWholeFile(type)` into the shared `handleCreateFile`;
  `preview.render.ts` labels the button from the same call, so label and
  behaviour cannot drift. `navigator.ts` routes 2+ block files with
  `forcesSingleBlock(type)`, so a malformed multi-block template lands on the
  single preview where the D1 error surfaces.
- The type-only frontmatter keys are read and written by the **engine** (single-line
  YAML values, so a newline cannot inject a sibling key). Details: the engine's
  `spec/ARTIFACT_FILE_FORMAT.md` §5.2 (see [`ARTIFACT_FILE_FORMAT.md`](../ARTIFACT_FILE_FORMAT.md)).
- `ui/panels/artifactForm/form.html.ts` — `buildExtensionField` and
  `buildAgentFieldsSection` both render through **`buildOptionalTextField`**, so
  the markup and its `escHtml` seeding exist once. `form.clientJs.ts` reads all
  four keys from one `TYPE_FIELD_IDS` list (absent input → `''`).

Adding a third whole-file type is therefore a `constants.ts` row plus one branch
in `resolveOutputFileName` — nothing else.

### Template indexes — batch scaffolding (the engine's `index.plan` / `index.create`)

A **template index** is a whole-file artifact carrying `index: true` whose body
links sibling artifacts; one run scaffolds every linked file. Link syntax,
rejection list and carry-over are the **engine's** (`spec/ARTIFACT_FILE_FORMAT.md`
§8; `index.plan` returns `steps`, per-step `candidates` and a `rejected` list
with a code per link).

| File | Owns |
|---|---|
| `artifactPicker/multiIndex.ts` | `MultiIndexRunner` — asks `index.plan`, previews each step, carries a submitted value into later steps' defaults (one-line inline), `summariseRun` |
| `artifactPicker/multiIndex.dest.ts` | `chooseStepDestination` — QuickPick over the engine's candidates + `Browse…` |
| `artifactPicker/preview.batch.ts` | `BatchGate` — the one-shot promise the sequencer awaits |
| `artifactPicker/preview.createFile.ts` | `runCreateFileFlow` — one path for single and batch writes (`artifact.write_file`) |
| `ui/views/createIndexRunner.ts` | Create-from-capture index through `index.create` |
| `types/multi-index.types.ts` | `IndexStep` · `DestCandidate` · `BatchOutcome` · `RunTally` |

**The runner never imports `preview.ts`** — the preview step arrives as the
`previewStep` callback (callback-bag rule). `navigator.ts` composes both in
**one** branch of the accept handler (`isIndexArtifact` → `runIndex`).

**Non-obvious invariants:**
- `BatchGate.settle()` nulls its resolver **before** calling it — a write, a
  cancel and a panel disposal can all fire for one step; only the first decides.
- `runIndex` guards no-workspace and a cancelled destination **before** hiding
  the QuickPick.
- Every step runs in its own try/catch: one bad link is a skip with a warning;
  only an explicit `aborted` (the panel closed) stops the run.
- An index is never written verbatim: the picker routes it to a run, and
  `handleInsert` refuses a Create File click on a merely-hovered index.

**🔒 Security — re-check when touching this.** Vault-authored link text drives
writes into the **workspace**. Three layers, each **rejecting, never
sanitising**: (1) the engine refuses a hostile link in `index.plan` (`..`,
absolute paths, drive letters / schemes → `rejected`, never a step); (2) the
chosen destination must sit inside the workspace folder — `isWithinRoot`
(`destFolderPicker.panel.ts`, over `utils/path-containment.ts`'s `isPathWithin`)
immediately before the write, and `createIndexRunner` checks the vault the same
way; (3) the engine contains `artifact.write_file` / `index.create` to the
`workspaceRoot` it is given (never vault-derived). The IDE analyser does no
taint analysis here; a manual trace is the only check.

### Flags — plain-markdown payloads (the engine's syntax)

A vault note is already markdown, so an artifact whose payload *is* markdown
(an agent config, an `AIPrompt`) marks where the artifact starts and ends with
**flags** — Obsidian comments, invisible in reading view. The syntax, the
`***` chrome rule, named regions → blocks, and the precedence flags → fence →
bare body (whole-file types only) are the **engine's** (`spec/ARTIFACT_FILE_FORMAT.md`
§7); no extension file may spell the marker (`w5-cleanup-guard.test.ts` (d)).

What the extension must know:
- A read returns `layout` (and `frontmatter.paths` for an index); **every save
  copies them into the model** (`engine/model.ts`), or the engine refuses a
  flagged / index file (`artifact.not_serializable`).
- The form edits flagged and index files (W-UI a). A lossy multi-region change
  (add / delete a block, a per-block default, a block description) is refused
  by the engine (`artifact.unrepresentable`) with nothing written — accepted (R2).
- An `AIPrompt` is not whole-file: a prompt with no flags and no fence reads
  as empty `code` — accepted behaviour.
- **Render-safe token spelling** in unfenced payloads: `<VK-repo>` is a legal
  HTML tag name, so Obsidian renders it as an unclosed element that swallows
  what follows. `<VK-repo></VK-repo>`, a lone `</VK-repo>`, or a name with `_`
  all render fine and mean the **same variable** (`VK_TOKEN_RE`, `render.service.ts`).
