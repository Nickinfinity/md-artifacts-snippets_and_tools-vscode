import type { ParsedArtifactFile, ParsedVar } from './parsed-artifact.types.js';

/**
 * Score and overlap report produced by `scoreVarSet`.
 *
 * The report compares one artifact's variable + tag profile against one
 * candidate variable set's profile so the picker can rank sub-sets by
 * combined similarity.
 *
 * @example
 * {
 *   matchedVars:   ['VK-host', 'VK-port'],
 *   unmatchedVars: ['VK-token'],
 *   extraVars:     ['VK-debug'],
 *   matchRatio:    0.6667,
 *   tagMatches:    1,
 *   score:         0.5667,
 * }
 */
export interface VarSetMatch {
    /** Var names present in both the artifact and the set. */
    matchedVars: string[];
    /** Artifact var names that the set does not provide. */
    unmatchedVars: string[];
    /** Set var names that the artifact does not require. */
    extraVars: string[];
    /** Fraction of artifact vars matched by the set — `matched / totalArtifact`, 0 when artifact has no vars. */
    matchRatio: number;
    /** Number of artifact tags that also appear in the set's tag list. */
    tagMatches: number;
    /** Combined score: `matchRatio * 0.7 + (tagMatches / totalArtifactTags) * 0.3`. */
    score: number;
}

/**
 * One independently-applicable variable set extracted from a `ParsedArtifactFile`.
 *
 * For multi-block files, one `VarSubSet` is produced per `## Heading` block.
 * For single-block files, one `VarSubSet` wraps the file's top-level `vars`.
 *
 * @example
 * {
 *   heading:    'Local Development',
 *   vars:       [{ name: 'VK-API_URL', defaultValue: 'http://localhost:3000' }],
 *   sourceFile: <ParsedArtifactFile>,
 * }
 */
export interface VarSubSet {
    /** Display heading — block heading or, for single-block files, the parent file title/fileName. */
    heading: string;
    /** Variables this sub-set defines. */
    vars: ParsedVar[];
    /** Back-reference to the parsed file the sub-set was extracted from. */
    sourceFile: ParsedArtifactFile;
}

/**
 * One row in an `ApplyResult.changes` array — describes the per-var transition
 * produced by applying a variable set on top of the user's current input values.
 */
export interface ApplyChange {
    /** Full var name (e.g. `'VK-host'`). */
    name: string;
    /** Value before apply (`''` when the var was not set). */
    oldValue: string;
    /** Value after apply (`''` when no incoming value was provided). */
    newValue: string;
    /**
     * - `'filled'`     — old value was empty; set provided a value (incl. empty string).
     * - `'overridden'` — old value was non-empty; set replaced it.
     * - `'kept'`       — set did not provide this var; old value preserved.
     */
    action: 'filled' | 'overridden' | 'kept';
}

/**
 * Result of `applyVarSet` — merged values plus per-var change log.
 */
export interface ApplyResult {
    /** Final merged value map, keyed by full var name. */
    values: Record<string, string>;
    /** One entry per var in the union of `current` and `set` keys. */
    changes: ApplyChange[];
}

/**
 * The variable-set creation form's payload — what the webview form holds, and
 * what crosses the `postMessage` boundary back to the extension.
 *
 * Lives here rather than beside either half of the form on purpose: the
 * renderer/panel and the slug/validation/adapter service are built
 * independently and both need this shape, so neither may own it.
 *
 * **Untrusted on the inbound path.** A payload arriving from the webview is
 * shape-guarded before use — `pairs` entries carry user-typed variable *names*
 * as well as values, and both halves are emitted verbatim into a ` ```vks `
 * fence, so both are validated (rejected, never sanitised) before any write.
 *
 * @example
 * const payload: VarSetFormPayload = {
 *     title:       'Local Dev',
 *     description: 'Dev machine settings',
 *     tags:        ['api', 'dev'],
 *     pairs:       [['VK-host', 'localhost']],
 * };
 */
export interface VarSetFormPayload {
    /** Set title — slugged into `Variables/<slug>.md`, and emitted as `title:`. */
    title: string;
    /** Optional prose context; `''` when the user left it blank. */
    description: string;
    /** Tags carried over from the artifact the values were captured from. */
    tags: string[];
    /** Editable `[name, value]` rows, in display order. */
    pairs: [string, string][];
}

/**
 * A parsed Variables file, shaped for the var-set form's **edit** mode.
 *
 * Groups every `[name, value]` pair under the sub-set heading it belongs to, so
 * one rendered `<table class="vars-table">` corresponds to one entry here. The
 * heading-less file shape (`blocks.length === 0`) yields a single entry whose
 * `heading` is `''` — a file that had no `## ` heading must never gain one.
 *
 * `env` is **file-level** frontmatter (Q-B): carried through the edit round trip
 * untouched and re-emitted unchanged, never rendered as an input. It is here
 * only so a Save cannot silently drop it.
 *
 * @example
 * const payload: VarsEditPayload = {
 *     title:       'Bundles',
 *     description: 'Per-environment settings',
 *     tags:        ['api'],
 *     env:         'production',
 *     subSets:     [{ heading: 'Dev', pairs: [['VK-host', 'localhost']] }],
 * };
 */
export interface VarsEditPayload {
    /** Set title — emitted as `title:`; the file's own path is the write target. */
    title: string;
    /** Optional prose context; `''` when the user left it blank. */
    description: string;
    /** Tags carried from the edited file's frontmatter. */
    tags: string[];
    /** File-level `env:` frontmatter, carried verbatim so a Save cannot drop it. */
    env?: string;
    /**
     * One entry per sub-set, in rendered order; `heading` is `''` when the
     * source had none. `description` is the prose between a `## ` heading and
     * its fence — carried so a Save cannot drop it (absent ≡ `''`).
     */
    subSets: { heading: string; description?: string; pairs: [string, string][] }[];
}

/**
 * What the edit-mode webview actually posts back — **not** {@link VarsEditPayload}.
 *
 * Headings ride the wire (one per sub-set) because the form can rename and
 * delete sub-sets — only the webview knows which name now belongs to which
 * rows. `env` is absent: it is never rendered, so the panel re-attaches it
 * from the payload it was opened with.
 *
 * `pairs` is grouped one entry per rendered sub-set, index-aligned to
 * `VarsEditPayload.subSets`. Edit mode **always** posts this grouped shape, even
 * for a single sub-set; create mode keeps posting a flat `[string, string][]`.
 *
 * @example
 * const wire: VarsEditWirePayload = {
 *     title:       'Bundles',
 *     description: '',
 *     tags:        ['api'],
 *     pairs:       [[['VK-host', 'localhost']], [['VK-host', 'prod.example']]],
 * };
 */
export interface VarsEditWirePayload {
    /** Set title, as typed in the form. */
    title: string;
    /** Optional prose context; `''` when the user left it blank. */
    description: string;
    /** Tags, as edited in the form. */
    tags: string[];
    /** Rows grouped per sub-set, index-aligned to the rendered `.vars-table` order. */
    pairs: [string, string][][];
    /**
     * Every sub-set's current heading, index-aligned to `pairs` — `''` for an
     * unnamed one. Authoritative when present; absent only from older clients,
     * in which case the panel keeps the file's headings by index.
     */
    headings?: string[];
    /**
     * Every sub-set's description, index-aligned to `pairs`. Authoritative when
     * present; absent only from older clients, in which case the panel keeps
     * the file's descriptions by index.
     */
    descriptions?: string[];
}
