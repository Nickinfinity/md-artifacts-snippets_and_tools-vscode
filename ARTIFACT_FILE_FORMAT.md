# Artifact `.md` file format

**The authority is the engine's spec, not this file:**
`spec/ARTIFACT_FILE_FORMAT.md` in the `mda` engine repo at the pinned tag
**`v0.13.0`** (`git -C <engine repo> show v0.13.0:spec/ARTIFACT_FILE_FORMAT.md`).
The engine reads and writes every artifact file; this extension never parses or
emits one. If what you see on disk and the engine spec disagree, that is an
engine question — requested as engine work, never patched here.

This page is the short map an extension task needs. Section numbers (§) are the
engine spec's.

## What a file is

- **Frontmatter** between `---` fences: `artifactType` (exact-case PascalCase,
  the one type key), `title`, `description`, `language`, the type-only keys
  (`extension` for `Template`; `provider` / `model` / `version` / `target` for
  `AIAgentsConfig`), `env`, `index` / `paths` (template indexes), `tags` —
  written Obsidian-style: `tags` and `paths` as YAML block lists, `tags` last
  (§1.1, §1.4).
- **Single block** — one code fence (§1); **multi-block** — `## Heading` +
  fence per block (§2); an empty `blocks` list means single-block.
- **Defaults** — one ```` ```yaml VKs ```` fence, optionally after a decorative
  `vars:` label line; the body is a strict YAML subset (§1.3, §9). Keys keep the
  full `VK-` prefix: `VK-host: localhost`. This is the **only** defaults format
  (L-5): nothing else supplies defaults.
- **`artifactType: Variables` files** (`Variables/`) hold sub-sets: blank
  (frontmatter only), flat (one untitled ```` ```yaml VKs ```` fence) or sets
  (`## Title` + fence, even one) (§3, §6). The engine's `vars.list` reports the
  shape.

## Variable tokens — `<VK-…>` (§4)

`<VK-name>` in code is a variable; `</VK-name>`, `<VK-name></VK-name>` and a
name with `_` all mean the **same variable** and render safely in Obsidian's
reading view (§4.2) — a bare `<VK-repo>` is a legal HTML tag name and swallows
what follows in an unfenced payload. In the extension the token syntax lives in
`src/services/render.service.ts` (`VK_TOKEN_RE`), for highlighting and live
detection only; **rendering** is the engine's `artifact.render` / `render.text`
(typed value → default → the token is left literally), which also reports
`containsEscape` for terminal delivery.

## Flags and layout (§7)

A markdown payload (agent config, `AIPrompt`) is delimited by Obsidian-comment
**flags**; named regions become blocks. The engine returns the file's `layout`
on read; **every write of a read file copies `layout` (and `frontmatter.paths`)
into the model** (`src/engine/model.ts`), so notes outside the flags, `***`
rules and markers survive (§7.6). A change the layout cannot represent is
refused (`artifact.unrepresentable`), nothing written.

## Template indexes (§8)

`index: true` + links to sibling artifacts; `paths` lists destination
candidates. The engine resolves links, rejects hostile ones (`..`, absolute,
drive letters / schemes), plans steps (`index.plan`) and writes
(`artifact.write_file`, `index.create`). The extension only sequences the
preview steps and checks the chosen destination stays inside the workspace.

## Artifact types (§5)

`Snippet`, `Command`, `Template`, `AIAgentsConfig`, `AIPrompt`, `Variables` —
the extension's `ARTIFACTS` (`src/types/constants.ts`) must match the engine's
registry by (`type`, `dir`) pair at handshake (O-2). `Template` and
`AIAgentsConfig` are whole-file (Create File writes a workspace file; the
filename rule is §5.1 / §5.2).
