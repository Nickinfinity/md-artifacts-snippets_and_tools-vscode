import * as vscode from 'vscode';
import type { ParsedArtifactFile, ParsedVar } from '../types/parsed-artifact.types.js';
import type { ApplyChange, ApplyResult, VarSetMatch, VarSubSet, VarsEditPayload } from '../types/varset.types.js';
import type { ArtifactFormModel } from '../types/artifact-form.types.js';
import { parseFromContent } from './parser.service.js';

/**
 * Recursively scans a vault `Variables/` directory for `artifactType: Variables` artifact
 * files, parsing each one and caching the parsed result.
 *
 * Cache is keyed by the absolute fs path of the directory passed to `scan`.
 * `invalidate()` clears the cache so the next `scan` call re-reads from disk.
 *
 * @example
 * const scanner = new VarSetScanner();
 * const files   = await scanner.scan(vscode.Uri.file('/vault/Variables'));
 * scanner.invalidate();
 */
export class VarSetScanner {
    private cache = new Map<string, ParsedArtifactFile[]>();

    private readonly invalidateEmitter = new vscode.EventEmitter<void>();
    /** Fired by `invalidate()` — subscribers (the Variables tree) re-render instead of going stale. */
    readonly onDidInvalidate = this.invalidateEmitter.event;

    /**
     * Scans the directory and returns parsed `artifactType: Variables` artifact files.
     *
     * @param variablesDirUri - Absolute URI of the directory to scan.
     * @returns Array of parsed files; cached on first call, returned by reference on subsequent calls.
     *
     * @example
     * await scanner.scan(vscode.Uri.file('/vault/Variables'));
     */
    async scan(variablesDirUri: vscode.Uri): Promise<ParsedArtifactFile[]> {
        const key = variablesDirUri.fsPath;
        const cached = this.cache.get(key);
        if (cached) { return cached; }

        const collected: ParsedArtifactFile[] = [];
        await this.walk(variablesDirUri, variablesDirUri, collected);
        this.cache.set(key, collected);
        return collected;
    }

    /**
     * Clears the internal cache so the next `scan` re-reads from disk, and
     * fires `onDidInvalidate` so subscribers (e.g. the Variables tree view)
     * know to re-render rather than going stale until a window reload.
     *
     * @returns void
     *
     * @example
     * scanner.invalidate();
     */
    invalidate(): void {
        this.cache.clear();
        this.invalidateEmitter.fire();
    }

    /**
     * Recursive directory walker. Reads every `.md` file, keeps only those whose
     * frontmatter `artifactType` is `'Variables'`, and pushes them into `out`.
     *
     * @param dirUri  - Current directory being read.
     * @param rootUri - Original root URI passed to `scan` — used to compute relative paths.
     * @param out     - Accumulator that mutates in place across recursion.
     * @returns Promise that resolves when the directory tree has been fully scanned.
     *
     * @example
     * await this.walk(uri, uri, []);
     */
    private async walk(dirUri: vscode.Uri, rootUri: vscode.Uri, out: ParsedArtifactFile[]): Promise<void> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
        } catch {
            return;
        }

        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(dirUri, name);

            // Recurse into sub-directories
            if (type === vscode.FileType.Directory) {
                await this.walk(childUri, rootUri, out);
                continue;
            }

            // Skip non-files and non-.md files
            if (type !== vscode.FileType.File) { continue; }
            if (!name.endsWith('.md')) { continue; }

            // Read + parse the .md file; skip when artifactType isn't 'Variables'
            try {
                const bytes   = await vscode.workspace.fs.readFile(childUri);
                const content = new TextDecoder().decode(bytes);
                const parsed  = parseFromContent(content, childUri.fsPath, rootUri.fsPath);
                if (parsed.frontmatter.artifactType === 'Variables') { out.push(parsed); }
            } catch {
                // Unreadable / unparseable file — silently skip.
            }
        }
    }
}

/**
 * Pure scoring function — compares an artifact's `(vars, tags)` profile against
 * a candidate variable set's `(vars, tags)` profile and returns a `VarSetMatch`
 * report containing both per-var classification and a single combined score.
 *
 * Combined score: `matchRatio * 0.7 + (tagMatches / totalArtifactTags) * 0.3`.
 * When the artifact has no tags, the tag component is `0`. When the artifact has
 * no vars, `matchRatio` is `0`.
 *
 * @param artifactVars - Vars declared by the artifact being inserted.
 * @param artifactTags - Tags declared by the artifact's frontmatter.
 * @param setVars      - Vars declared by the candidate variable set.
 * @param setTags      - Tags declared by the candidate variable set's frontmatter.
 * @returns `VarSetMatch` report with overlap arrays, ratios, and combined score.
 *
 * @example
 * scoreVarSet(
 *   [{ name: 'VK-host', defaultValue: '' }],
 *   ['api'],
 *   [{ name: 'VK-host', defaultValue: 'localhost' }],
 *   ['api'],
 * )
 */
export function scoreVarSet(
    artifactVars: ParsedVar[],
    artifactTags: string[],
    setVars: ParsedVar[],
    setTags: string[],
): VarSetMatch {
    const artifactNames = new Set(artifactVars.map(v => v.name));
    const setNames      = new Set(setVars.map(v => v.name));

    const matchedVars:   string[] = [];
    const unmatchedVars: string[] = [];
    const extraVars:     string[] = [];

    for (const v of artifactVars) {
        if (setNames.has(v.name)) { matchedVars.push(v.name); }
        else                      { unmatchedVars.push(v.name); }
    }
    for (const v of setVars) {
        if (!artifactNames.has(v.name)) { extraVars.push(v.name); }
    }

    const matchRatio = artifactVars.length === 0
        ? 0
        : matchedVars.length / artifactVars.length;

    const setTagSet = new Set(setTags);
    const tagMatches = artifactTags.reduce((acc, t) => acc + (setTagSet.has(t) ? 1 : 0), 0);
    const tagComponent = artifactTags.length === 0
        ? 0
        : tagMatches / artifactTags.length;

    const score = matchRatio * 0.7 + tagComponent * 0.3;

    return { matchedVars, unmatchedVars, extraVars, matchRatio, tagMatches, score };
}

/**
 * Display name for a sub-set wherever it stands alone (the Apply picker, the
 * `from:` badge): its heading, or — for an untitled block — the set's title.
 *
 * @param subSet - A sub-set from {@link extractSubSets}.
 * @returns A non-empty label whenever the file has a title or a name.
 *
 * @example
 * subSetLabel({ heading: '', vars: [], sourceFile }); // → sourceFile's title
 */
export function subSetLabel(subSet: VarSubSet): string {
    return subSet.heading || subSet.sourceFile.frontmatter.title || subSet.sourceFile.fileName;
}

/**
 * The three shapes a Variables file can take — **the** rule every view of a
 * set (the pane's rows, its menus, its commands) derives from:
 *
 * - `blank` — frontmatter only: no `vks` fence, no `## ` sub-sets.
 * - `flat`  — one untitled `vks` fence: variables, no sub-sets.
 * - `sets`  — one or more `## Title` sub-sets (even just one).
 *
 * Read from the file's structure, never from a count: a single **titled**
 * sub-set is `sets`, a single **untitled** fence is `flat`. A flat file with
 * no variables writes no fence at all, so it reads back as `blank` — the two
 * are deliberately the same thing.
 */
export type VarsFileShape = 'blank' | 'flat' | 'sets';

/**
 * Classifies a parsed Variables file — see {@link VarsFileShape}.
 *
 * @param file - Parsed `artifactType: Variables` file.
 * @returns `'sets'` when it has any `## ` sub-set, `'flat'` when it has only
 *          untitled variables, otherwise `'blank'`.
 *
 * @example
 * getVarsFileShape(parseFromContent('---\nartifactType: Variables\n---\n', p, dir)); // → 'blank'
 */
export function getVarsFileShape(file: ParsedArtifactFile): VarsFileShape {
    if (file.blocks.length > 0) { return 'sets'; }
    return file.vars.length > 0 ? 'flat' : 'blank';
}

/**
 * Pure transform — flattens a parsed variable artifact file into one or more
 * `VarSubSet` entries. Multi-block files yield one sub-set per `## Heading` that
 * has at least one var. Single-block files yield one sub-set wrapping the
 * top-level `vars` and using `frontmatter.title || fileName` as the heading.
 * Sub-sets with no vars are excluded unless `includeEmpty` is set — applying a
 * set needs vars, but the Variables pane must show a sub-set the moment it is
 * created, or "New sub-set" looks like it did nothing.
 *
 * @param artifact - Fully parsed variable file.
 * @param opts     - `includeEmpty`: keep `## ` sub-sets that hold no vars (pane + its commands).
 * @returns Ordered array of `VarSubSet`; `[]` when no qualifying sub-set exists.
 *
 * @example
 * extractSubSets(parsedFile)                         // apply picker — vars only
 * extractSubSets(parsedFile, { includeEmpty: true }) // Variables pane
 */
export function extractSubSets(artifact: ParsedArtifactFile, opts: { includeEmpty?: boolean } = {}): VarSubSet[] {
    if (artifact.blocks.length > 0) {
        return artifact.blocks
            .filter(b => opts.includeEmpty || b.vars.length > 0)
            .map(b => ({ heading: b.heading, vars: b.vars, sourceFile: artifact }));
    }

    if (artifact.vars.length === 0) { return []; }

    const heading = artifact.frontmatter.title || artifact.fileName;
    return [{ heading, vars: artifact.vars, sourceFile: artifact }];
}

/**
 * Pure merge — applies a variable set's defaults on top of the user's current
 * input values, returning the merged map plus a per-var change log.
 *
 * Action rules:
 *   - `'filled'`     — old empty, set provides a value (including `''`).
 *   - `'overridden'` — old non-empty, set provides a value.
 *   - `'kept'`       — set does not provide this var; old value preserved.
 *
 * The `changes` array contains one entry per var in the union of
 * `Object.keys(currentValues)` and `setVars.map(v => v.name)`.
 *
 * @param currentValues - User-typed values keyed by full var name.
 * @param setVars       - Variable set to apply on top.
 * @returns `ApplyResult` containing merged values and per-var changes.
 *
 * @example
 * applyVarSet(
 *   { 'VK-host': 'old' },
 *   [{ name: 'VK-host', defaultValue: 'new' }, { name: 'VK-port', defaultValue: '8080' }],
 * )
 */
export function applyVarSet(
    currentValues: Record<string, string>,
    setVars: ParsedVar[],
): ApplyResult {
    const setMap = new Map(setVars.map(v => [v.name, v.defaultValue]));
    const allNames = new Set<string>([...Object.keys(currentValues), ...setMap.keys()]);

    const values: Record<string, string> = {};
    const changes: ApplyChange[] = [];

    for (const name of allNames) {
        const oldValue = currentValues[name] ?? '';
        if (setMap.has(name)) {
            const newValue = setMap.get(name) ?? '';
            const action: ApplyChange['action'] = oldValue === '' ? 'filled' : 'overridden';
            values[name] = newValue;
            changes.push({ name, oldValue, newValue, action });
        } else {
            values[name] = oldValue;
            changes.push({ name, oldValue, newValue: oldValue, action: 'kept' });
        }
    }

    return { values, changes };
}

/**
 * Builds the `ArtifactFormModel` for a saved variable set, ready for
 * `serializeArtifact`.
 *
 * Lives here rather than in the picker controller so the save-as payload is
 * domain logic with a unit test, not UI wiring — and so the one `.md` writer
 * stays the only code path that turns a model into file bytes.
 *
 * @param title       - Display title, written verbatim into the frontmatter.
 * @param description - Optional description; omitted from output when empty.
 * @param tags        - Tags copied from the active artifact's frontmatter.
 * @param entries     - Ordered `[name, value]` pairs for the `vks` fence.
 * @returns A single-block `artifactType: Variables` model.
 *
 * @example
 * buildVarSetModel('Local Dev', '', ['api'], [['VK-host', 'localhost']]);
 * // → { artifactType: 'Variables', title: 'Local Dev', …, blocks: [{ vars: [{ name: 'VK-host', defaultValue: 'localhost' }] }] }
 */
export function buildVarSetModel(
    title:       string,
    description: string,
    tags:        string[],
    entries:     [string, string][],
): ArtifactFormModel {
    return {
        artifactType: 'Variables',
        title,
        description,
        tags,
        blocks: [{
            heading:     '',
            description: '',
            language:    '',
            code:        '',
            vars:        entries.map(([name, defaultValue]) => ({ name, defaultValue })),
        }],
    };
}

/**
 * Pure transform — the file-to-form-model direction for the Variables edit form.
 *
 * Mirrors `extractSubSets`'s branch on `blocks.length > 0` (the file has
 * **three** on-disk shapes, not two): a `blocks.length > 0` file yields one
 * `subSets` entry per block, heading intact; a heading-less file
 * (`blocks.length === 0`) yields exactly one entry wrapping the top-level
 * `vars`, with `heading: ''` — never a synthesised title/fileName heading,
 * so a heading-less file cannot gain a real `## ` heading on the next Save.
 * `env` is file-level frontmatter, carried through untouched so a Save cannot
 * silently drop it (it is never rendered by the form).
 *
 * @param file - Fully parsed `artifactType: Variables` file.
 * @returns The edit form's payload shape.
 *
 * @example
 * variablesFileToEditPayload(parsedVariablesFile)
 * // → { title: 'Bundles', description: '', tags: [], env: 'staging',
 * //     subSets: [{ heading: 'Dev', pairs: [['VK-host', 'localhost']] }] }
 */
export function variablesFileToEditPayload(file: ParsedArtifactFile): VarsEditPayload {
    const fm = file.frontmatter;
    const pairsOf = (vars: ParsedVar[]) => vars.map(v => [v.name, v.defaultValue] as [string, string]);
    const subSets = file.blocks.length > 0
        ? file.blocks.map(b => ({ heading: b.heading, description: b.description, pairs: pairsOf(b.vars) }))
        : [{
            heading: '',
            pairs: file.vars.map(v => [v.name, v.defaultValue] as [string, string]),
        }];

    return {
        title: fm.title ?? '',
        description: fm.description ?? '',
        tags: fm.tags ?? [],
        env: fm.env,
        subSets,
    };
}

/**
 * Pure transform — the form-model-to-file direction for the Variables edit form.
 *
 * `original` is how frontmatter the edit form never renders (`env` today)
 * survives the round trip — the same role `artifactToFormModel`'s callers play
 * for the create/edit form's own undisplayed keys. A sub-set whose `heading`
 * is `''` produces a heading-less block, so `serializeArtifact`'s single-block
 * `Variables` path (never the multi-block path) is what re-emits it.
 *
 * @param payload  - The edited payload posted back from the webview.
 * @param original - The file as parsed before editing, for undisplayed keys.
 * @returns An `ArtifactFormModel` ready for `serializeArtifact`.
 *
 * @example
 * editPayloadToModel(payload, original) // → { artifactType: 'Variables', ... }
 */
export function editPayloadToModel(payload: VarsEditPayload, original: ParsedArtifactFile): ArtifactFormModel {
    return {
        artifactType: 'Variables',
        title: payload.title,
        description: payload.description,
        tags: payload.tags,
        env: payload.env ?? original.frontmatter.env,
        blocks: payload.subSets.map(s => ({
            heading: s.heading,
            // An untitled block has no `## ` line to hang a description under.
            description: s.heading === '' ? '' : (s.description ?? ''),
            language: '',
            code: '',
            vars: s.pairs.map(([name, defaultValue]) => ({ name, defaultValue })),
        })),
    };
}
