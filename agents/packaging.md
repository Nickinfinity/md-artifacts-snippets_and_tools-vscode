# Packaging and configuration

The runtime dependency rule, key config files, `.vscodeignore` and the VS Code notes. Part of [`AGENTS.md`](../AGENTS.md) — read it first.

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

## Key Config Files

| File | Purpose |
|---|---|
| `tsconfig.json` | Strict mode, `ES2022` target, `Node16` module resolution, `rootDir: "."`, output to `dist/` |
| `package.json` | `"main": "./dist/src/extension.js"` — mirrors the `rootDir: "."` output path |
| `eslint.config.mjs` | Enforces naming conventions, curly braces, `===` equality, semicolons |
| `.vscode/launch.json` | Debug launch with `--extensionDevelopmentPath`; other extensions disabled in the host |
| `.vscode/tasks.json` | `npm watch` is the default build task (runs automatically on F5) |
| `.vscode-test.mjs` | Test runner looks for compiled tests at `dist/test/**/*.test.js` |
| [`ARTIFACT_FILE_FORMAT.md`](../ARTIFACT_FILE_FORMAT.md) | Short map of the artifact `.md` format. **The authority is the engine's `spec/ARTIFACT_FILE_FORMAT.md` at `v0.10.0`** — read it before touching fixtures, recordings or anything that writes. |
| [`CREATING_A_PLAN.md`](../CREATING_A_PLAN.md) | **Authoritative** plan-writing process — agent topology, prompt templates, task spec, refinement waves (§5.3), gate, ledger. Read before writing any plan or dispatching agents. |

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
