# Artifact `.md` File Format — Authoritative Spec

This file is the **single source of truth** for the on-disk structure of every
vault artifact `.md` file and how it varies per artifact type. The parser
(`src/services/parser.service.ts`) reads this format; any serializer/writer must
produce exactly this format so that `parse(serialize(x))` round-trips.

> When writing vault `.md` files, test fixtures, or a serializer, this file —
> not memory — defines the contract. If parser behaviour and this doc disagree,
> that is a bug in one of them; reconcile, do not guess.

> Examples below use `~~~` as the outer fence purely so the inner ` ``` `
> markdown fences render literally. In a real `.md` file every fence is a
> standard triple-backtick.

---

## 1. Canonical single-block structure

~~~md
---
artifactType: Snippet | AIAgentsConfig | Command | Template | Variables | AIPrompt
title: Human-readable title
description: Short explanation
language: javascript
tags: [tag1, tag2]
---

```code
// Code content — <VK-xxx> tokens are replaced at insert time
const x = <VK-variableName>;
```

vars:
VK-variableName=defaultValue
VK-anotherVar=
~~~

- **Frontmatter** — YAML between `---` fences. Recognised keys: `artifactType`
  (required; unrecognised value falls back to the directory-derived default,
  D1e — never a hardcoded literal, and never case-insensitively to a
  differently-cased spelling of a known value), `title`, `description`,
  `language`, `extension` (template-only, §5.1), `provider` / `model` /
  `version` (agent-only, §5.2), `tags` (inline array `[a, b]`), `env`, `target`.
- **`artifactType` is the only frontmatter key read or emitted, and its values
  are PascalCase** (`Snippet`, `AIAgentsConfig`, `Command`, `Template`,
  `Variables`, `AIPrompt`) — exact string match against the `ArtifactType`
  union, sourced from `ARTIFACTS` (`getAllTypes()`), never a hand-copied list.
  A legacy `type: <lowercase>` key (or `type: agent`, `AIAgentsConfig`'s old
  spelling) is **not read** — it is neither a fallback nor a second accepted
  key. It is simply an unrecognised line: every other frontmatter key in the
  same block (`title`, `tags`, …) still parses normally, but the artifact's
  type itself falls back to the directory-derived default, same as an
  unrecognised `artifactType` value. The **only** path forward for such a file
  is the **MD Artifacts:
  Migrate Vault Frontmatter** command (`md-artifacts.migrateFrontmatter`,
  `src/commands/migrate.command.ts` + `src/services/frontmatter-migration.service.ts`):
  it always dry-runs first (report in the "MD Artifacts: Migration"
  output channel), then rewrites `type: <legacy>` → `artifactType: <PascalCase>`
  only after an explicit modal confirmation naming the file count. The rewrite
  is a surgical single-line splice inside the first frontmatter block — every
  other key, including the read-side-only `index:` / `paths:` (§8.7), survives
  byte-identical. Idempotent: a file already carrying `artifactType:` is left
  untouched.
- **Blank line after frontmatter is optional.** The code fence may sit on the
  very next line after the closing `---` (real files do this), or be separated
  by one or more blank lines. A serializer may emit either; round-trip is
  unaffected.
- **Code block** — first fenced block after frontmatter. Info string may be
  `code`, a real language (`javascript`), or **empty** (plain text). Trailing
  whitespace is trimmed on parse — a serializer must trim too for round-trip.
  **A file may delimit its payload with flags instead of a fence** (§7) — for
  artifacts whose content is markdown, such as agent configs.
- **Vars (defaults)** — optional. Accepted forms, parser priority order:
  1. A ` ```vks ` fenced block (preferred, unambiguous). May be preceded by a
     decorative label line — `vars:`, `vars`, `### VKs:`, prose, blank lines.
     The label is **ignored**; the ` ```vks ` fence is what binds. (Real files
     write `vars:` then a ` ```vks ` fence — this is the fenced form, not the
     legacy form.)
  2. A legacy unfenced `vars:` / `vars` label followed directly by bare
     `KEY=value` lines (no fence), placed after the code block.
  Keys use the full `VK-` prefix. Empty value (`VK-x=`) is valid → default `''`.
  Lines starting with `#` are treated as comments and skipped. Vars not listed
  are still auto-detected from `<VK-xxx>` tokens in the code.
- **Default values are literal.** Only leading/trailing whitespace of the
  `KEY=value` line is trimmed. Quotes are **not** stripped — `VK-value="active"`
  yields the default `"active"` (quotes included), because the author wants a
  quoted string literal in the emitted code. A serializer emits the stored
  value verbatim — never auto-quote, auto-strip, or escape it.

**A serializer should always emit the ` ```vks ` fenced form, never the legacy
unfenced `vars:` form. Emitting a `vars:` label line immediately before the
` ```vks ` fence is allowed (matches real files) and parses identically.**

### 1.1 Serializer rules — single-block

- **Canonical frontmatter key order:** `artifactType`, `title`, `description`,
  `language`, `extension`, `provider`, `model`, `version`, `tags`, `env`,
  `target` (the serializer's `FRONTMATTER_KEY_ORDER`). Keys with empty/undefined
  values are omitted (except `artifactType`, always emitted). The type-specific keys
  (`extension` = template, `provider`/`model`/`version` = agent) group after
  `language`; reserved keys (`env`, `target`) sit at the end so future additions
  append cleanly.
- **Language is emitted in both frontmatter and the code fence info-string**
  for single-block files. The parser hoists fence → frontmatter when the
  frontmatter key is missing (`parser.service.ts` line 346); emitting both is
  the deterministic round-trip shape.
- **Plain text** (resolved `language === ''`): emit a bare ` ``` ` fence with
  empty info string AND **omit the `language` key entirely** from frontmatter.
  Do not emit `language: ` (empty value).
- **Single-line YAML enforcement** for `title`, `description`, and each
  `tags[i]`: the parser slices on the first `:` per line, so a literal newline
  in any of these values corrupts the frontmatter on re-parse. The serializer
  MUST strip `\r\n` / `\r` / `\n` (replace with single space) from `title`
  and `description`, then collapse runs of spaces. Tag entries MUST reject
  `,`, `]`, `\n`, `\r` (filtered at input; serializer asserts as last line of
  defence). `env` and `target` follow the same single-line rule.

---

## 2. Multi-block structure

A file with two or more `## ` (h2) headings, each followed by a fenced code
block, is a **multi-block file**. The picker shows blocks as a sub-list.

**File-level vs per-block description coexist.** The frontmatter `description:`
key is the **file-level description** and applies to the whole artifact. Each
section's text line between `## Heading` and the code fence is the
**per-block description** for that block. Both may be present at the same
time, and either may be empty.

- Sections split on `## ` (h2) **only** — `###`+ markers stay inside a block, so
  a serializer must never emit `## ` inside code.
- Each section may carry its own defaults via a ` ```vks ` fence placed
  **anywhere after** its code fence. Keys use the full `VK-` prefix.
- Any non-code text between the code fence and the ` ```vks ` fence (blank
  lines, an `### VKs:` marker, prose) is ignored; the ` ```vks ` fence still
  binds to that section's code.
- Per-block vars = tokens auto-detected from the block code, with matching
  ` ```vks ` defaults overlaid (code order preserved; vks-only keys appended).
- The conventional real-file layout per section is: `## Heading`, a one-line
  description, the code fence, a blank line, a decorative `### VKs:` marker, a
  blank line, then the ` ```vks ` fence. The marker and blank lines are ignored;
  only the code fence and the binding ` ```vks ` fence matter. Literal-value and
  optional-blank-line rules from §1 apply identically here.

### 2.1 Serializer rules — multi-block

- **No top-level code fence or top-level ` ```vks ` fence before the first
  `## ` heading.** The parser runs `parseCodeBlock` and `parseVars`
  unconditionally — even on multi-block files. If the serializer emits a
  top-level fence between frontmatter and the first heading, on re-parse the
  first block's code or vars would be hoisted as top-level `code` / `vars`,
  causing round-trip drift. Multi-block content starts directly with `## `.
- **No `language:` key in frontmatter** for multi-block files. Language lives
  on each block's fence info-string only.
- **Per-block layout:** `## <heading>`, optional one-line description, blank
  line, ` ```<lang>\n<code>\n``` `, optional per-block ` ```vks ` fence (same
  emit-when rule as §5 — only when at least one var has a non-empty default).

~~~md
---
artifactType: Snippet
title: API URLs
---

## Development
Local dev server.
```bash
http://localhost:<VK-PORT>
```

### VKs:

```vks
VK-PORT=3000
```

## Production
```bash
https://api.example.com
```
~~~

---

## 3. `artifactType: Variables` files

The content uses a ` ```vks ` block instead of a ` ```code ` block. Used both
for environment variable files and for **Variable Sets**.

~~~md
---
artifactType: Variables
env: dev
---

```vks
API_URL=http://localhost:3000
DB_URL=mongodb://localhost:27017
```
~~~

- Single-block variable file: one ` ```vks ` fence — its top-level vars are the
  whole set.
- Multi-block variable file: `## Heading` + ` ```vks ` blocks. Each heading is
  an independent sub-set with its own vars.

---

## 4. Variable syntax — `<VK-xxx>`

`<VK-xxx>` is the placeholder syntax for vault artifact variables.

- **`VK-`** is a fixed prefix. The hint after the hyphen can be any casing:
  `camelCase`, `UPPER_SNAKE`, `PascalCase`, `lowercase`.
- **Regex:** `/<\/?VK-([A-Za-z][A-Za-z0-9_]*)>/g` — hint must start with a letter;
  subsequent characters may be letters, digits, or underscores.
- **Closing form — `</VK-xxx>` is the same variable.** Both spellings detect,
  deduplicate, score, and substitute identically; one input, one var-set entry.
  See §4.1 for why it exists and how a pair resolves.
- **Collision-free by design** — does not conflict with JS/TS generics or JSX,
  HTML tags, CSS, Vue (`v-` prefix differs), Python, Shell, Jinja, Handlebars
  (`{{}}` differs), or Markdown rendering.
- **Token = variable name** — the full token including the `VK-` prefix is the
  variable name used for deduplication and substitution. `<VK-host>` →
  `name: 'VK-host'`.
- **Auto-detected from code** — `extractVars(code)` scans any code block for
  tokens automatically. A vars section is only needed to supply non-empty
  default values; its keys must also use the `VK-` prefix (e.g.
  `VK-host=localhost`).
- **Block-scoped in multi-block files** — each block's vars are extracted
  independently. The same token in two blocks produces a separate var in each.

> **Rule:** Always use `<VK-xxx>` syntax. Never use `{{xxx}}`.

### 4.1 The closing form — `</VK-xxx>`

`<VK-repo>` is a **legal HTML open tag name** (CommonMark tag names allow
letters, digits and hyphens — but not underscores). Inside a ` ``` ` fence that
is harmless, but a **flagged payload (§7) is real markdown**: Obsidian parses the
token as an unclosed custom element and every block after it — the rest of the
prose, the ` ```vks ` fence — becomes its child instead of a top-level block, so
the note stops rendering correctly.

Closing the tag leaves nothing open. Both render-safe spellings are supported:

| Spelling | Renders in Obsidian | Resolves to |
|---|---|---|
| `<VK-repo>` | ✗ swallows the rest of the note | value |
| `<VK-repo></VK-repo>` | ✓ empty element, nothing left open | value **once** |
| `</VK-repo>` | ✓ stray end tag, ignored by the parser | value |
| `<VK-repo_name>` | ✓ `_` is illegal in a tag name → literal text | value |

- **Substitution is two-pass** (`resolveVars`): an **adjacent** `<VK-x></VK-x>`
  pair collapses to the value *once*, then every remaining opening or closing tag
  resolves individually. `<VK-a></VK-b>` is not a pair — it is two tokens.
  `<VK-x> text </VK-x>` is also two tokens (not adjacent), each substituted.
- **Detection deduplicates across forms** — `<VK-x>` and `</VK-x>` in one file
  yield a single `VK-x` variable, one preview input, one var-set match.
- **Unknown variables stay literal** in both spellings, so partial substitution
  is still safe.
- The webview code area highlights both forms; its `vkWrap` twin is bound to
  `VK_TOKEN_RE` by `test/vk-closing-tag.test.ts`.

---

## 5. Per-artifact variations

`artifactType` is set from the chosen artifact; the destination directory comes
from `ARTIFACTS` in `src/types/constants.ts`.

| `artifactType` | Vault dir | `language` field | Code fence | Defaults | Multi-block | Notes |
|---|---|---|---|---|---|---|
| `Snippet` | `Snippets` | yes (or plain text) | language or empty | ` ```vks ` | yes | Editor insert. |
| `Template` | `Templates` | yes (or plain text) | language or empty | ` ```vks ` | **no (D1)** | Explorer → **writes a whole file** into the workspace. Single-block only. `extension:` overrides the fence language (see §5.1). May carry `index: true` — a **template index** whose body links the files one run scaffolds (§8). |
| `Command` | `Commands` | yes — **locked to `bash`** | `bash` (locked by serializer) | ` ```vks ` | yes | Terminal insert. |
| `AIAgentsConfig` | `AIAgentsConf` | optional | language, empty, **or none — flags instead (§7)** | ` ```vks ` | yes* | Explorer → **writes a whole file** into the workspace (like `template`), named from `target:` (§5.2). `provider` / `model` / `version` record the AI provenance (agent-only, §5.2). May carry `index: true` (§8), like `template`. *Create File enforces a single block/region. |
| `Variables` | `Variables` | n/a | ` ```vks ` only | the block itself | yes (sub-sets) | `env:` labels the environment. Variable Sets live here. |
| `AIPrompt` | `AIPrompts` | hidden — always `markdown` | none — **flags only** (§7), no language picker | ` ```vks ` (file-level, outside the flags) | yes — named flag regions become blocks | Editor **or** terminal insert — the only type declaring both `contexts`; the target is resolved from which menu invoked it, not live focus (`CLAUDE.md`'s insert-commands section). A file with **no flags and no fence parses to empty `code`** — accepted behaviour, not a bug (§5.3). |

Rules a serializer enforces:

- **Single-block:** `language` allowed in frontmatter. Multi-block: no top-level
  `language` — language lives on each block's fence.
- **`Command`:** no `language` selector in the create UI. The type is treated
  as **locked to `bash`** (`form.language.mode === 'locked'`,
  `form.language.default === 'bash'` in `constants.ts`). The serializer emits
  `language: bash` in single-block frontmatter and `bash` on every block fence
  info-string, deterministically — the UI never lets the user override it. A
  legacy authored `.md` whose fence carries `sh` or is empty still parses; the
  serializer normalises to `bash` on next write. Multi-block command files
  follow the §2.1 rule (no top-level `language`) but every block fence is
  still `bash`.
- **Plain text (any type):** emit a bare ` ``` ` fence (empty info string). The
  parser's `CODE_FENCE_RE` (`/```(\w*)\r?\n.../`) matches it because `\w*`
  allows zero characters.
- **`tags`:** emit `tags: [a, b]`; omit the key entirely when there are no tags.
- **vks fence:** emit only when at least one var has a non-empty default value.
- **`extension`:** a `Template`-only frontmatter key. Emitted verbatim
  (single line enforced) when non-empty, in the key order
  `artifactType · title · description · language · extension · provider · model · version · tags · env · target`.
  Parsed as a plain string. Absent/empty for every other type.
- **`provider` / `model` / `version`:** `AIAgentsConfig`-only frontmatter keys
  (§5.2). Each emitted verbatim (single line enforced) when non-empty, in the
  key order above. Parsed as plain strings. Absent/empty for every other type.
- **`index` / `paths`:** whole-file-type-only and **read-side only** — the
  parser reads them, the serializer never emits them and neither appears in the
  key order above (§8.7). `index` is a real boolean (exact `true`); `paths` is
  an inline array parsed by the same rule as `tags`.

### 5.1 Templates — whole-file behaviour

A `Template` is not a fragment inserted at the cursor; invoking **Insert
Template** from the Explorer writes the artifact's single code block to disk as a
real file, with `<VK-xxx>` variables resolved exactly as every other artifact
resolves them.

- **Single-block only (D1).** A template `.md` with two or more `##` blocks is a
  validation error surfaced when Create File is pressed — no file is written.
  The parser stays general; the guard (`validateTemplateBlocks`,
  `services/template.service.ts`) is template-scoped.
- **Output filename — extension precedence (D3):** **user-typed → frontmatter
  `extension:` → fence language.** A typed name that already carries an extension
  wins whole; otherwise the extension is taken from `extension:` (leading dot
  optional), and only if that is absent from the fence language (mapped through
  `language-map.service.ts`). `extension:` and the typed name are path-injection
  vectors: a value carrying `/`, `\`, `..`, or a NUL is **rejected, never
  sanitised**.
- **Destination (D2):** the clicked folder (or a clicked file's parent), or a
  folder picker rooted at the workspace when invoked from the palette. The write
  is containment-checked against the workspace folder before any I/O and creates
  no directory.

### 5.2 Agents — provider / model / version

An `AIAgentsConfig` config records which AI it targets via three optional,
**agent-only** free-text frontmatter keys. They are metadata only — they do
not change insert or target-file write behaviour.

~~~md
---
artifactType: AIAgentsConfig
title: Code reviewer
provider: Claude
model: Opus
version: "4.8"
---
~~~

- **Free-text, optional.** Any of the three may be absent; an empty value is
  **omitted**, never emitted blank. No curated dropdown — the create form renders
  three plain text inputs, rendered for no other type.
- **Single-line enforced.** Like `title` / `description` / `extension`, each value
  is routed through the serializer's `safeYamlValue` so an embedded newline cannot
  inject a sibling frontmatter key on re-parse. They are parsed as plain strings.
- **Round-trip.** A hand-authored agent file carrying these keys preserves them
  through `parse(serialize(x))`; the create form seeds its inputs from them.
- **Multi-block (D4).** The agent create form reuses the multi-block machinery
  (`form.multiBlock === true`), matching the §5 `AIAgentsConfig` row.

**Whole-file behaviour (Explorer → Create File).** Like a `template`, invoking an
agent config from the Explorer **writes its code block to disk as a real file**
with `<VK-xxx>` resolved — it does not insert at the cursor. Shared with templates
via `writesWholeFile(type)` (`artifact-type-config.service.ts`), the single source
for both the preview's `Create File` label and the write-vs-insert branch.

- **Filename from `target:`.** The default (editable) name is seeded from the
  `target:` frontmatter key (e.g. `CLAUDE.md`); absent, it falls back to the title.
  `target:` is a path-injection vector — a value carrying `/`, `\`, `..`, or a NUL
  is **rejected, never sanitised**, and the write is containment-checked against the
  workspace folder (identical guards to the template `extension:`/typed-name path).
- **Single-block only for the write.** A 2+ block agent is a Create-File validation
  error (an agent config is one file), even though the create form permits authoring
  multiple blocks (D4).
- **No code fence required.** An agent config is markdown, so its payload is
  normally delimited by flags (§7) rather than wrapped in a fence. Both shapes
  parse; the write path is identical.

### 5.3 AI Prompts — flags, and the empty-payload caveat

An `AIPrompt` lives in `AIPrompts/` and is authored with flags (§7) exactly
like an agent config's markdown payload — there is no new parsing for it, and
no fence: `form.language.mode` is `'hidden'`, so the create form never shows a
language selector, and the fence language defaults to `markdown` the same way
a flagged agent config's does.

~~~md
---
artifactType: AIPrompt
title: Code review request
---

%%oa:start%%
Review <VK-repo_name> and report findings.
%%oa:end%%
~~~

**Empty payload is accepted behaviour, not a bug.** `AIPrompt` is an *insert*
type (`Snippet`/`Command`-shaped: `writesFile` is absent from its `ARTIFACTS`
row), not a whole-file type — so the §7.5 rule-3 bare-body fallback, which only
fires for `writesFile` types (`Template`, `AIAgentsConfig`), never applies to
it. A prompt file with **no flags and no fence** therefore parses to an empty
`code` string, same as an empty `Snippet` or `Command` file would. Author a
prompt with at least one `%%oa:start%%…%%oa:end%%` region (or, unconventionally,
a fence) to give it a payload.

---

## 6. Variable Sets — storage shape

(Behaviour — scoring, apply/stacking/save-as flow, module map — stays in
`CLAUDE.md`. Only the on-disk shape lives here.)

- Variable set files live in the vault's `Variables/` directory with
  `artifactType: Variables` frontmatter.
- A single-block variable file uses one ` ```vks ` fence — its top-level vars
  are the whole set.
- A multi-block variable file uses `## Heading` + ` ```vks ` blocks. Each
  heading is an independent sub-set with its own vars.

---

## 7. Flags — plain-markdown payloads

A vault note *is* markdown. When the artifact's payload is itself markdown — an
agent config, or an `AIPrompt` (§5.3) — there is nothing to wrap it in: a
` ``` ` fence is wrong (the payload may contain fences of its own) and a `##`
heading would swallow the author's surrounding notes. **Flags** mark where the
artifact starts and ends:

~~~md
---
artifactType: AIAgentsConfig
title: Code reviewer
target: CLAUDE.md
---

Scratch notes to myself — not part of the artifact.

%%oa:start%%
# Reviewer

Review <VK-repo> and report findings.

```bash
npm test
```
%%oa:end%%

More notes, also excluded.
~~~

`%%…%%` is Obsidian's own comment syntax, so flags are **invisible in Obsidian's
reading view** while staying plain text on disk.

### 7.1 Syntax

| Flag | Form |
|---|---|
| Start | `%%oa:start%%` — or `%%oa:start Some name%%` |
| End | `%%oa:end%%` |
| Visual rule (optional) | `***` on its own line, **inside** a region — dropped from the payload |

- **Own line.** A flag must be the only thing on its line. Leading/trailing
  whitespace and spaces inside the `%%…%%` are tolerated (`%% oa:start Dev %%`).
- **Name.** Everything after `oa:start` up to the closing `%%`, trimmed. Optional.
- **Case-sensitive**, lowercase `oa:start` / `oa:end`.
- The syntax has exactly one owner in code: `src/services/flags.service.ts`.
  `test/flags.service.test.ts` fails if any other `src/` file spells it out again.

### 7.2 Parsing rules

- **Flags beat fences.** A file containing at least one start flag takes the
  flagged path; its ` ``` ` fences and `##` headings are payload, never structure.
  A file with no flags parses exactly as it always did — flags are **additive**,
  and no existing vault file changes meaning.
- **Text outside the flags is dropped.** That is the point of the markers.
- **Content is verbatim**, inner fences included; only blank lines at the two ends
  are trimmed, never interior ones or leading indentation.
- **Fenced regions are skipped while scanning**, so a prompt that *documents* the
  flag syntax inside a ` ```md ` sample does not terminate itself. Fence matching
  follows CommonMark: a fence closes only on the same character (` ``` ` vs `~~~`)
  at the same length or longer.
- **One region → single-block file** (`blocks: []`; its name is decorative, the
  title comes from frontmatter). **Two or more → one `ParsedBlock` per region**,
  the flag name as the block heading, so the multi-block picker and preview work
  unchanged.
- **`language` defaults to `markdown`** when frontmatter does not set one; an
  explicit `language:` still wins. This is what makes `extForLang` yield `.md` for
  a written file with no `extension:` / `target:`.
- **Two lenient rules**, so a half-typed file still previews: an unterminated
  start flag runs to end of file, and a second start flag while a region is open
  is content, not a new region.
- **`***` inside a region is chrome, not content.** The flags themselves are
  invisible in Obsidian, so an author brackets a region with `***` horizontal
  rules to *see* where a block begins and ends — the visual job a ` ``` ` fence
  does for a snippet, which matters most in a multi-region prompt file. Every
  `***` line **between a Start and an End flag** is dropped from the payload,
  wherever it sits.

~~~md
%%oa:start Dev review%%
***
# Reviewer

Review <VK-repo_name> before merging.
***
%%oa:end%%
~~~
→ payload: `# Reviewer\n\nReview <VK-repo_name> before merging.`

  Precise rules:
  - **Only inside a region.** A `***` before the first Start, between an End and
    the next Start, or anywhere in a file with **no flags at all** (§7.5) is
    ordinary markdown and is preserved.
  - **Only `***`.** `---` is ordinary content — an author may genuinely want a
    thematic break inside a prompt, and `---` is ambiguous in markdown anyway
    (frontmatter at the top of a file; a setext H2 directly under a text line).
    `***` renders as a horizontal line in every position.
  - The whole line must be asterisks: `***`, `*****`, `  ***  ` are rules;
    `**`, `* * *`, and `***emphasis***` are content.
  - A `***` inside a fenced code block is content — fenced lines are never
    scanned for markers.

### 7.3 Variables

`<VK-xxx>` tokens in a flagged payload are **auto-detected** — a prompt's whole
value is its tokens, so an explicit list is not required. A ` ```vks ` fence
supplies defaults for them and is **file-level**: put it *outside* the flags,
since anything between them is payload.

~~~md
%%oa:start%%
Review <VK-repo_name> on <VK-branch_name>.
%%oa:end%%

vars:
```vks
VK-repo_name=md-artifacts
```
~~~

**Write flagged-payload tokens in a render-safe spelling.** A flagged payload is
*not* inside a code fence, so Obsidian parses it as markdown — and a bare
`<VK-repo>` is a legal HTML open tag that swallows every block below it,
including this ` ```vks ` fence. Use `<VK-repo></VK-repo>`, a lone `</VK-repo>`,
or a name containing `_`; **all three resolve to the same variable and the same
output** (§4.1 has the full table).

This is a **rendering-only** concern: the extension parses, resolves and writes
every spelling identically, and payloads inside a ` ``` ` fence are immune (no
HTML is parsed there). The vault's `AIAgentsConf/test/*.md` examples use the
underscore form.

### 7.4 Whole-file types

Flags need no special handling in the Create File flow: the region content lands
in `code`, so `validateSingleBlock` (2+ regions → the same "one file" error) and
`resolveOutputFileName` (`target:` for agents, extension chain for templates)
apply to a flagged file exactly as to a fenced one. This is also why the
`AIPrompt` type (§5.3) required **no extraction code** — only its `ARTIFACTS`
row — even though it is not itself a whole-file type.

**Serializer.** Flags are a read-side format today: the create form still writes
the fenced shape, and `parse(serialize(x))` is unaffected because the serializer
never emits flags. Hand-authored flagged files are edited through **Edit .md**
(raw text), not re-serialized.

### 7.5 Flags are optional for whole-file types

A `Template` or `AIAgentsConfig` file **is** the artifact, so when it is a
single block there is nothing to delimit — write the note and leave the flags
out entirely:

~~~md
---
artifactType: AIAgentsConfig
title: Code reviewer
target: CLAUDE.md
---

# Reviewer

Be terse with <VK-repo_name>.

vars:
```vks
VK-repo_name=my-app
```
~~~

Precedence, strictly ordered so no existing file changes meaning:

1. **Flags** — if the file has any region, that is the payload.
2. **Code fence** — the classic shape; a ` ```vks ` fence does not count (it is
   the defaults section, not content).
3. **Bare body** — only for types with `writesFile` (`Template`,
   `AIAgentsConfig`): the whole body minus its `vars:` / ` ```vks ` section,
   with `language: markdown`.

Insert types — `Snippet`, `Command`, `Variables`, and **`AIPrompt`** (§5.3,
despite also being flag-authored) — never take rule 3: a note with no fence
and no flags yields no code, exactly as before. When multi-block support
arrives for the whole-file types, flags become the way to mark each region; a
single-region file will still be able to omit them.

---

## 8. Template indexes — `index: true`

A **template index** is an ordinary whole-file artifact (§5.1 / §5.2) carrying
`index: true`, whose body links sibling artifacts in the same vault folder tree.
Invoking it scaffolds **every linked file in one run** — the links are the
payload, not the code:

~~~md
---
artifactType: Template
title: React component scaffold
index: true
paths: [src/components, packages/ui/src]
---

1. [[dir_2/subdir1/Button]]
2. [T](dir_2/subdir1/Button.test.md)
3. [[dir_1/barrel]]
~~~

It is deliberately additive: **no** new artifact type, **no** new vault
directory, **no** new command and **no** new context-menu entry. An index lives
in `Templates/` or `AIAgentsConf/` like any other file of its type.

### 8.1 The two keys

| Key | Type | Meaning |
|---|---|---|
| `index` | boolean | Marks the file as an index. **Only the exact value `true`** counts — a stringly-typed `false` cannot reach a downstream check as truthy (`BOOLEAN_FRONTMATTER_KEYS`, `parser.service.ts`). |
| `paths` | inline array | Extra destination folders offered for **every** link in the index. Workspace-folder-relative, POSIX, **file-level** (declared once, not per link) and **suggestions only** — the user may ignore all of them. Shares `parseInlineArray` with `tags`, so `paths: [a, b]` splits by exactly the same rule (`ARRAY_FRONTMATTER_KEYS`). |

**`index: true` is valid only on the whole-file types.** A run can only *write*
files, so `isIndexArtifact` requires `fm.index === true` **and**
`writesWholeFile(fm.artifactType)` — a `Snippet`, `Command` or `Variables` file
carrying `index: true` is not an index and behaves exactly as before.

**An index is never written to disk verbatim.** Pressing Enter on one in the
picker starts a run; a mouse click on **Create File** while merely hovering it
is refused with a message pointing back at the picker. There is no path by which
`index.md` itself lands in the workspace.

### 8.2 Link syntax and order

Both Obsidian-native spellings are accepted, matched in **one pass** so their
relative order is the document order the run follows:

| Form | Example | Notes |
|---|---|---|
| Wikilink | `[[dir_2/subdir1/Button]]` | Alias (`\|text`) and anchor (`#Heading`) suffixes are stripped; the target is what remains. |
| Markdown link | `[T](dir_2/subdir1/Button.test.md)` | The URL is the target; the link text is ignored. |

- **Document order is the run order.** Duplicates are preserved — a link written
  twice is two steps.
- **Images and embeds are not links.** Both `![alt](url)` and `![[Button]]` are
  excluded — they display a note rather than nominate one to scaffold — so an
  illustrated index does not try to scaffold its own screenshots, and embedding
  a note for context does not add a step.
- **A link is single-line, and its target carries no `[` or `(`.** A target
  containing either character, or spanning a newline, is not recognised as a
  link at all. This is deliberate: it is what keeps link scanning **linear** on
  a hostile body (a flood of unclosed `[[[[…` costs one character per attempt,
  not a scan to end-of-input per start position). Such a name is unlinkable
  rather than silently truncated into a *different* path.
- `.md` is appended when the target does not already end in it, so
  `[[dir_1/barrel]]` and `[T](dir_1/barrel.md)` name the same file.
- Any text that is not a link is ignored — numbering, prose and headings are
  free chrome, the same way `***` is chrome inside a flag region (§7.2).

### 8.3 Resolution — subtree-relative, and the rejection list

A link resolves **relative to the index file's own directory only**. There is no
vault-wide search: a link that legitimately lives elsewhere in the vault is
**rejected, not chased down**.

Every vault-authored string that becomes a filesystem path — both link targets
and `paths:` entries — goes through the single rejection authority
`safeRelPath` (`src/services/multi-index.service.ts`). It **rejects, never
sanitises**:

| Rejected | Reason reported |
|---|---|
| `../escape`, `a/../../b` | `contains a parent-directory ("..") segment` |
| `/etc/passwd` | `absolute path` |
| `C:\tmp`, `file:///etc` | `contains a drive letter or URI scheme (":")` |
| `dir\sub\file` | `contains a backslash path separator` |
| any C0 / DEL / C1 control character | `contains a NUL or control character` |
| `''`, `/`, `.` | `empty path` |

Accepted paths are normalised to POSIX — doubled separators and `.` segments
collapse — but segment *content* is never decoded, so a percent-encoded
traversal (`%2e%2e%2f…`) has no real `/` to split on and survives as one inert
literal segment instead of resolving back into `..`.

A rejected entry is **reported by name with its reason** in a single warning and
carries no rewritten path — a refused value never comes back as a different,
"cleaned" one. The rest of the run continues.

### 8.4 What a linked file must be

Each link is read and parsed as an ordinary artifact, then checked. A failure
**skips that one step with a warning** — an index that accidentally links a
snippet must not abort the rest of the scaffold:

- **A whole-file type** (`template` or `agent`) — `writesWholeFile`, the same
  gate the Create File button uses.
- **Single-block** — the shared `validateSingleBlock` rule of §5.1 / §5.2. An
  index may not link a 2+ block file, because one link writes one file.
- **Readable** — an unresolvable or unreadable target is a skip, not a crash.

The linked file is otherwise completely ordinary: same preview, same variable
inputs, same Create File button, same filename rules (`extension:` chain for
templates, `target:` verbatim for agents), same flags/fence precedence (§7.5).
Nothing about a file changes because an index happens to link it.

### 8.5 Destinations — suggested, never forced

Per step, in order, the user is offered:

1. **The mirrored folder, first and pre-selected** — the folder the run was
   started from, plus the link's own directory relative to the index. An index
   at `Templates/react/index.md` linking `dir_2/subdir1/Button` invoked on
   `src/app` suggests `src/app/dir_2/subdir1`. A bare Enter accepts it.
2. **Each `paths:` entry** that `safeRelPath` accepts, in declaration order.
3. **`Browse…`** — the existing folder navigator, rooted at the **workspace
   folder** (not the clicked folder), so any folder in the project is reachable.

Candidates are deduped by path, first occurrence wins. **Escape skips that one
file** and the run continues to the next link. Missing folders are created,
including intermediate levels — the destination is containment-checked against
the workspace folder *before* the directory is created, and a destination
outside it is skipped with a warning.

Closing the preview panel **aborts** the whole run. A run always ends with one
summary notification: `Multi-Template: 3 files written, 0 skipped.`

### 8.6 Variable carry-over

Values the user submits on one step are carried forward **in memory for the rest
of the run**, pre-filling the same-named variable on later files:

- Matching is on the **full `VK-xxx` token, exact and case-sensitive** — the same
  rule Variable Sets use (§6).
- A carried value **overrides that file's own default**; it does not lock the
  input. The user always retains the final choice — only the default shown
  changes.
- Carry-over is **per run and in-memory by design**. Durable bundles are what
  Variable Sets are for; nothing is written to the vault.

### 8.7 Read-side only — the serializer never emits these keys

Mirroring §7.4: `index` and `paths` are a **read-side format**. The parser reads
them; `serializeArtifact` never writes them, and both are deliberately absent
from `FRONTMATTER_KEY_ORDER` — a guard in `test/frontmatter-keys.test.ts` fails
if either appears there, with a message naming this decision.

Indexes are therefore **hand-authored** and edited through **Edit .md** (raw
text), not through the create form. `parse(serialize(x))` is unaffected: a file
that gains `index:` by hand keeps it because the serializer is never the thing
that rewrites it.
