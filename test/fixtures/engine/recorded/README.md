# Engine recordings (plan W5 H5.0)

Replies recorded from the pinned engine (`/Users/nick/.local/mda-v0.10.0/bin/mda`, `v0.10.0`, protocol 2.0). **Never edit by hand.** Re-record: `npm run compile && MDA_BIN=<pinned> node test/fixtures/engine/recorded/record.mjs`. Entries marked "engine-converted once" were older-format sources that the engine re-emitted once; they are now plain `md` entries holding those engine bytes.

Load through `test/recorded.ts`: `recordedSource(name)` (bytes), `recordedRead(name)` (`artifact.read` reply; adapt with `toParsedArtifactFile(read, "/v")`), `recordedReadsByHash()` (the fake engine lookup), `recordedVarsList()`.

Paths are unique per recording; a test may serve the bytes at any path (lookup is by content hash). Engine reads hold **declared defaults only**: a token without a default is not in `vars`.

| Name | Recorded at | Kind | Consumer (test: source it replaces) |
|---|---|---|---|
| `vars-flat` | `Variables/vars-flat.md` | model, engine-emitted | variables-command (singleBlockModel); variables-apply-command (singleBlockModel: writeFixture dev, outside, in); T5.3 shape test |
| `vars-sets` | `Variables/vars-sets.md` | model, engine-emitted | variables-command (multiBlockModel) |
| `vars-users` | `Variables/vars-users.md` | model, engine-emitted | variables-apply-editor (model) |
| `vars-users-empty` | `Variables/vars-users-empty.md` | model, engine-emitted | variables-apply-editor (:76, empty default) |
| `vars-local` | `Variables/vars-local.md` | model, engine-emitted | variables-single-and-search (model); variables-info (:71 flat, was an older-format source) |
| `vars-envs` | `Variables/vars-envs.md` | model, engine-emitted | variables-single-and-search (:80) |
| `vars-titled-dev` | `Variables/vars-titled-dev.md` | model, engine-emitted | variables-file-shapes (TITLED, was an older-format source) |
| `vars-blank-new` | `Variables/vars-blank-new.md` | md | variables-command (:152); variables-info (:103) |
| `vars-blank-localdev` | `Variables/vars-blank-localdev.md` | md | variables-command (:246); variables-file-shapes (HEADER) |
| `shape-empty-flat` | `Variables/shape-empty-flat.md` | md | varset-shape-engine (T5.3) |
| `shape-empty-set` | `Variables/shape-empty-set.md` | md | varset-shape-engine (T5.3) |
| `ve-flat` | `Variables/ve-flat.md` | md | varset-edit-engine (FLAT, T5.6) |
| `vars-with-descriptions` | `Variables/vars-with-descriptions.md` | md (engine-converted once) | variables-info (FIXTURE); variables-metadata (SOURCE, T5.6) |
| `vars-with-descriptions-multiline` | `Variables/vars-with-descriptions-multiline.md` | from vars-with-descriptions | variables-metadata (:155 multi-line description) |
| `fx-ve-one-heading` | `Variables/fx-ve-one-heading.md` | md (engine-converted once) | vars-edit-roundtrip (T5.3) |
| `fx-ve-single-subset` | `Variables/fx-ve-single-subset.md` | md (engine-converted once) | vars-edit-roundtrip (T5.3) |
| `fx-ve-with-env` | `Variables/fx-ve-with-env.md` | md (engine-converted once) | vars-edit-roundtrip (T5.3) |
| `snippet-demo` | `Snippets/snippet-demo.md` | md | artifact-form-engine (SNIPPET) |
| `persist-single` | `Snippets/persist-single.md` | md | preview-persist-engine (SINGLE) |
| `persist-multi` | `AIAgentsConf/persist-multi.md` | md | preview-persist-engine (MULTI) |
| `persist-flagged` | `AIPrompts/persist-flagged.md` | md | preview-persist-engine (FLAGGED) |
| `edit-1` | `Snippets/edit-1.md` | md | edit-artifact.test.ts, inline literal #1 |
| `edit-2` | `Snippets/edit-2.md` | md | edit-artifact.test.ts, inline literal #2 |
| `edit-3` | `Snippets/edit-3.md` | md | edit-artifact.test.ts, inline literal #3 |
| `edit-4` | `AIAgentsConf/edit-4.md` | md | edit-artifact.test.ts, inline literal #4 |
| `buttons-1` | `Snippets/buttons-1.md` | md | preview-buttons.test.ts, inline literal #1 |
| `buttons-2` | `Snippets/buttons-2.md` | md (engine-converted once) | preview-buttons.test.ts, inline literal #2 |
| `availability-1` | `Snippets/availability-1.md` | md | preview-insert-availability.test.ts, inline literal #1 |
| `availability-2` | `Commands/availability-2.md` | md | preview-insert-availability.test.ts, inline literal #2 |
| `availability-3` | `Templates/availability-3.md` | md | preview-insert-availability.test.ts, inline literal #3 |
| `mi-index` | `Templates/mi/index.md` | md (engine-converted once) | multi-index-runner (index.md) |
| `mi-hostile-index` | `Templates/mi/hostile-index.md` | md (engine-converted once) | multi-index-runner (hostile-index.md) |
| `mi-barrel` | `Templates/mi/dir_1/barrel.md` | md (engine-converted once) | multi-index-runner (dir_1/barrel.md) |
| `mi-button` | `Templates/mi/dir_2/subdir1/Button.md` | md (engine-converted once) | multi-index-runner (dir_2/subdir1/Button.md) |
| `mi-button-test` | `Templates/mi/dir_2/subdir1/Button.test.md` | md (engine-converted once) | multi-index-runner (dir_2/subdir1/Button.test.md) |
