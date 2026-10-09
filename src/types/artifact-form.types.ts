import type { ArtifactType, ParsedVar } from './parsed-artifact.types.js';

/**
 * Controls whether the artifact create/edit form is in create or edit mode.
 *
 * - `create` — new file; destination folder picker shown before save.
 * - `edit`   — existing file; destination is fixed to the source file's path.
 */
export type ArtifactFormMode = 'create' | 'edit';

/**
 * One content block within an artifact form. A single-block file has exactly
 * one entry; a multi-block file has two or more.
 *
 * @example
 * // Single-block snippet
 * { heading: '', description: '', language: 'javascript', code: 'console.log("hi");', vars: [] }
 *
 * // One block of a multi-block snippet
 * { heading: 'Development', description: 'Local dev server.', language: 'javascript', code: '...', vars: [...] }
 */
export interface ArtifactFormBlock {
    /** `##` heading text — always `''` for the sole block of a single-block file. */
    heading: string;
    /** Per-block description (text between heading and code fence). `''` in single-block mode. */
    description: string;
    /** Fence language / language selector value — `''` means plain text (bare fence). */
    language: string;
    /** Raw code content. Emitted verbatim; trailing whitespace trimmed on save. */
    code: string;
    /** Detected `<VK-xxx>` vars plus any user-declared defaults for this block. */
    vars: ParsedVar[];
}

/**
 * Top-level data model for the artifact create/edit form.
 *
 * `multiBlock` is **derived** (`blocks.length > 1`) and never stored here.
 * The serializer reads `blocks.length` directly to choose the output shape.
 *
 * @example
 * {
 *   artifactType: 'Snippet',
 *   title: 'Express Route',
 *   description: 'Basic GET handler.',
 *   tags: ['express', 'api'],
 *   blocks: [{ heading: '', description: '', language: 'javascript', code: '...', vars: [] }],
 * }
 */
export interface ArtifactFormModel {
    /** Artifact category — drives serializer language rules and destination directory. */
    artifactType: ArtifactType;
    /** File-level title — emitted in frontmatter `title:`. */
    title: string;
    /** File-level description — emitted in frontmatter `description:`. */
    description: string;
    /** Tag list — emitted as `tags: [a, b]`; omitted when empty. */
    tags: string[];
    /**
     * Output file extension — **`type: template` only**. Emitted as frontmatter
     * `extension:` when non-empty; overrides the fence language when the written
     * file's name is resolved (D3). Absent/empty for every other type.
     */
    extension?: string;
    /**
     * Output file name — **`artifactType: AIAgentsConfig` only**. Emitted as
     * frontmatter `target:` when non-empty, and used **verbatim** as the written
     * file's name (`CLAUDE.md`, `.cursorrules`) — never extension-appended, which
     * is exactly what separates it from `extension:` above. Absent/empty for
     * every other type.
     */
    target?: string;
    /**
     * File-level `env:` frontmatter, carried through an edit round trip untouched.
     *
     * The form renders **no input** for it — it exists so a Save cannot silently
     * drop a key the file already carried. Before this field existed, `env` was
     * parsed and key-ordered but had no model member to emit from, so every
     * `env:` in the vault was lost on any re-serialize.
     */
    env?: string;
    /**
     * AI provider — **`type: agent` only**. Emitted as frontmatter `provider:`
     * when non-empty (single-line enforced). Absent/empty for every other type.
     */
    provider?: string;
    /** AI model family — **`type: agent` only**. Emitted as `model:` when non-empty. */
    model?: string;
    /** AI model version — **`type: agent` only**. Emitted as `version:` when non-empty. */
    version?: string;
    /** Content blocks — at least one entry is always required. */
    blocks: ArtifactFormBlock[];
}

/**
 * What a surface capture produced, or `undefined` when there was nothing to
 * capture.
 *
 * §2.1 promises "one `CaptureFn` contract, three implementations". That is only
 * true if all three return the **same shape**, so it is declared once, here,
 * before any capture is written. A capture returning a bare
 * `Partial<ArtifactFormModel>`, or a bespoke `{ text, usedClipboard }` object,
 * is the defect this type exists to prevent.
 *
 * @example
 * const r: CaptureResult = { prefill: { blocks: [block] }, source: 'selection' };
 */
export interface CaptureResult {
    /** Prefill handed straight to `openArtifactFormPanel`. */
    readonly prefill: Partial<ArtifactFormModel>;
    /**
     * Where the text came from — drives the caller's toast, never the form.
     * `'clipboard'` **requires** the "used clipboard contents" message: a
     * clipboard read is never silent.
     */
    readonly source: 'selection' | 'clipboard' | 'file';
}

/**
 * One surface's capture strategy. `undefined` is the single "nothing to
 * capture" signal for every surface — the caller shows a toast and opens no
 * form.
 *
 * @example
 * const captureEditor: CaptureFn<{ text: string; languageId: string }> =
 *     (input, type) => input.text ? { prefill: {}, source: 'selection' } : undefined;
 */
export type CaptureFn<TInput> = (input: TInput, type: ArtifactType) => CaptureResult | undefined;
