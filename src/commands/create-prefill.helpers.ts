import * as path from 'node:path';
import * as vscode from 'vscode';
import { mapLanguageId } from '../services/language-map.service.js';
import { extractFlaggedRegions } from '../services/flags.service.js';
import { getFilenameField } from '../services/artifact-type-config.service.js';
import type { ArtifactType, ParsedArtifactFile } from '../types/parsed-artifact.types.js';
import type { ArtifactFormModel } from '../types/artifact-form.types.js';

// ── Pure prefill builders (exported for unit tests) ───────────────────────────
//
// `buildSnippetPrefill` and `buildCommandPrefill` were lifted verbatim from the
// former `create.command.ts`, which Wave 2 deleted — **this module is now their
// only home.** `test/selection-entry.helpers.test.ts` carries that file's
// original assertions unchanged; they are the golden net proving the move was a
// move and not a rewrite. This module is `vscode`-free by design.

/**
 * Builds a `Partial<ArtifactFormModel>` prefill for a snippet created from an
 * editor selection. The VS Code `languageId` is mapped to the conventional
 * fence info-string via `mapLanguageId` (e.g. `typescriptreact` → `tsx`).
 *
 * @param text       - Selected text to prefill as `blocks[0].code`.
 * @param languageId - `editor.document.languageId` from the active editor.
 * @returns Partial model with a single prefilled block.
 *
 * @example
 * buildSnippetPrefill('const x = 1;', 'typescriptreact')
 * // → { blocks: [{ heading: '', description: '', language: 'tsx', code: 'const x = 1;', vars: [] }] }
 */
export function buildSnippetPrefill(text: string, languageId: string): Partial<ArtifactFormModel> {
    return {
        blocks: [{ heading: '', description: '', language: mapLanguageId(languageId), code: text, vars: [] }],
    };
}

/**
 * Builds a `Partial<ArtifactFormModel>` prefill for a command created from a
 * terminal selection or clipboard text. Language is always `''` — the command
 * type locks to `bash` at serialise time via `constants.ts`.
 *
 * @param text - Terminal selection or clipboard text to prefill as `blocks[0].code`.
 * @returns Partial model with a single prefilled block.
 *
 * @example
 * buildCommandPrefill('git status')
 * // → { blocks: [{ heading: '', description: '', language: '', code: 'git status', vars: [] }] }
 */
export function buildCommandPrefill(text: string): Partial<ArtifactFormModel> {
    return {
        blocks: [{ heading: '', description: '', language: '', code: text, vars: [] }],
    };
}

// ── Whole-file prefill ─────────────────────────────────────────────────────────

/**
 * Builds a `Partial<ArtifactFormModel>` prefill for a whole file dropped/opened
 * into the create flow (e.g. a workspace file offered as a `Template` or
 * `AIAgentsConfig` source).
 *
 * The file's basename and extension are read from `fileName` with Node's
 * `path` module, independent of any directory components the caller passes.
 * `languageId` only feeds the block's fence language via `mapLanguageId`; the
 * `target`/`extension` prefill is decided by `getFilenameField`, reading the
 * `outputNameKey` declared on the `ARTIFACTS` row — never the type literal.
 *
 * @param fileName   - Source file name or path (only the basename is used).
 * @param contents   - Full file contents to prefill as `blocks[0].code`.
 * @param languageId - `editor.document.languageId` (or equivalent) for the source file.
 * @param type       - Target artifact type chosen for the new artifact.
 * @returns Partial model with a single prefilled block, plus `target` or
 *          `extension` when the type calls for one.
 *
 * @example
 * buildFilePrefill('CLAUDE.md', '# hi', 'markdown', 'AIAgentsConfig')
 * // → { target: 'CLAUDE.md', blocks: [{ heading: '', description: '', language: 'markdown', code: '# hi', vars: [] }] }
 *
 * @example
 * buildFilePrefill('Button.tsx', 'const x = 1;', 'typescriptreact', 'Template')
 * // → { extension: 'tsx', blocks: [{ heading: '', description: '', language: 'tsx', code: 'const x = 1;', vars: [] }] }
 */
export function buildFilePrefill(
    fileName: string,
    contents: string,
    languageId: string,
    type: ArtifactType,
): Partial<ArtifactFormModel> {
    const prefill: Partial<ArtifactFormModel> = {
        blocks: [{ heading: '', description: '', language: mapLanguageId(languageId), code: contents, vars: [] }],
    };

    const field = getFilenameField(type);
    if (field === 'target') {
        prefill.target = path.basename(fileName);
    } else if (field === 'extension') {
        prefill.extension = path.extname(fileName).slice(1);
    }

    return prefill;
}

/**
 * Builds a full prefill from an already-parsed artifact, for opening the form
 * in **edit** mode.
 *
 * The inverse of what the form's save path emits: every field the serializer
 * writes is carried back so a round trip through the form is lossless for the
 * fields the form owns. A multi-block file maps one `ParsedBlock` per form
 * block; a single-block file yields exactly one block with an empty heading,
 * which is the shape `serializeArtifact` reads to choose the output form.
 *
 * Pure and `vscode`-free like its sibling builders — the caller reads and
 * parses the file.
 *
 * @param parsed - The artifact as `parser.service` produced it.
 * @returns A prefill carrying the artifact's current content.
 *
 * @example
 * artifactToFormModel(parseArtifactFile('/v/Snippets/demo.md')).title // → 'Demo'
 */
export function artifactToFormModel(parsed: ParsedArtifactFile): Partial<ArtifactFormModel> {
    const fm = parsed.frontmatter;
    const blocks = parsed.blocks.length > 0
        ? parsed.blocks.map(b => ({
            heading:     b.heading ?? '',
            description: b.description ?? '',
            language:    b.fenceLang ?? fm.language ?? '',
            code:        b.code ?? '',
            vars:        b.vars ?? [],
        }))
        : [{
            heading:     '',
            description: '',
            language:    fm.language ?? '',
            code:        parsed.code ?? '',
            vars:        parsed.vars ?? [],
        }];

    return {
        artifactType: fm.artifactType,
        title:        fm.title ?? '',
        description:  fm.description ?? '',
        tags:         fm.tags ?? [],
        extension:    fm.extension,
        target:       fm.target,
        // Carried but never rendered: without this line the serializer's `env`
        // emit fix would still never reach an edit save, because the model
        // handed to it would have no `env` to emit.
        env:          fm.env,
        provider:     fm.provider,
        model:        fm.model,
        version:      fm.version,
        blocks,
    };
}

/**
 * Explains why an artifact cannot be safely edited through the form, if so.
 *
 * The form is a **lossy** representation of a `.md`: it round-trips through
 * the webview, where `extractModel()` rebuilds the model from DOM fields, so
 * anything without an input is gone by the time Save runs. For a create that
 * is harmless — the fields never existed. For an edit it **deletes the user's
 * content from their vault**, silently and irreversibly.
 *
 * Two cases the form cannot carry today, each refused rather than quietly
 * dropped:
 * - **Flagged payloads** (the marker syntax `flags.service.ts` owns) — the
 *   region markers and every line
 *   of surrounding note outside them are not modelled at all; a save replaces
 *   the whole file with a single fence.
 * - **`index: true` / `paths:`** — read-side-only keys the serializer never
 *   emits (see `ARTIFACT_FILE_FORMAT.md` §8), so a saved index stops being an
 *   index.
 * `env:` was a third case until H7.0b gave `ArtifactFormModel` an `env` field
 * and `serializeFrontmatter` an emit line for it. It now survives an edit, so
 * refusing one would be refusing a file the form handles correctly.
 *
 * @param parsed - The parsed artifact.
 * @param body   - Raw file content, needed because flags are a body-level syntax.
 * @returns A human-readable reason, or `undefined` when editing is safe.
 *
 * @example
 * const reason = unsupportedEditReason(parsed, content);
 * if (reason) { vscode.window.showWarningMessage(reason); return; }
 */
export function unsupportedEditReason(parsed: ParsedArtifactFile, body: string): string | undefined {
    if (extractFlaggedRegions(body).length > 0) {
        return vscode.l10n.t('This artifact uses Obsidian comment flags, which the form cannot represent. Editing it here would discard the flags and any notes around them — open the .md directly instead.');
    }
    if (parsed.frontmatter.index === true || (parsed.frontmatter.paths?.length ?? 0) > 0) {
        return vscode.l10n.t('This artifact is a template index. The form does not carry index links, so saving would stop it being an index — open the .md directly instead.');
    }
    return undefined;
}
