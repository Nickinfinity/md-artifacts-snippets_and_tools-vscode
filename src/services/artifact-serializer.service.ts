import type { ArtifactFormBlock, ArtifactFormModel } from '../types/artifact-form.types.js';
import type { ArtifactType, ParsedVar } from '../types/parsed-artifact.types.js';
import { getDefaultLanguage, getLanguageMode } from './artifact-type-config.service.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Canonical frontmatter key emission order.
 *
 * Keys are emitted in this sequence; keys with empty or undefined values are
 * omitted — except `artifactType`, which is always present. Reserved keys
 * (`env`, `target`) sit at the end so future additions append cleanly.
 *
 * @example
 * FRONTMATTER_KEY_ORDER // ['artifactType','title','description','language','extension','provider','model','version','tags','env','target']
 */
export const FRONTMATTER_KEY_ORDER: readonly string[] = [
    'artifactType', 'title', 'description', 'language', 'extension', 'provider', 'model', 'version', 'tags', 'env', 'target',
];

// ── Public export ─────────────────────────────────────────────────────────────

/**
 * Serializes an `ArtifactFormModel` to a vault `.md` string.
 *
 * The output is the exact inverse of `parseFromContent` for all canonical
 * shapes. Round-trip contract: `parseFromContent(serializeArtifact(m))` must
 * deep-equal `parseFromContent(originalContent)` for any fixture produced by
 * the create form. Normalising types (e.g. `command` → `language: bash`) are
 * stable after the first serialization.
 *
 * @param model - The form model to serialize.
 * @returns UTF-8 markdown string suitable for writing to disk.
 *
 * @example
 * serializeArtifact({ artifactType: 'Snippet', title: 'Hi', description: '', tags: [],
 *   blocks: [{ heading: '', description: '', language: 'javascript', code: 'x', vars: [] }] })
 */
export function serializeArtifact(model: ArtifactFormModel): string {
    const isMultiBlock = model.blocks.length > 1;

    // `Variables` files carry no code fence at all — the vks fence IS the content
    // (ARTIFACT_FILE_FORMAT.md §3). They are also not create-form-enabled, so the
    // language resolution below would throw on them; this branch must come first.
    if (model.artifactType === 'Variables') {
        // A Variables file with exactly ONE `## ` heading has `blocks.length === 1`,
        // so `isMultiBlock` is false and the single-block path emits a flat,
        // heading-less fence — silently deleting the heading. `extractSubSets`
        // branches on `blocks.length > 0`, so that file is a real sub-set shape
        // and the round trip must preserve it. Narrow on purpose: flipping
        // `isMultiBlock` to `> 0` outright would change byte output for every
        // one-block file of every type. A heading-less block keeps the flat path,
        // so a file that had no heading can never gain one.
        const keepsHeading = model.blocks.length === 1 && (model.blocks[0]?.heading ?? '') !== '';
        return serializeFrontmatter(model, undefined) + serializeVariablesBody(model, isMultiBlock || keepsHeading);
    }

    if (isMultiBlock) {
        return serializeFrontmatter(model, undefined) + serializeMultiBlockBody(model);
    }

    const lang = resolveBlockLanguage(model.artifactType, model.blocks[0]?.language ?? '');
    const resolvedLang = lang !== '' ? lang : undefined;
    return serializeFrontmatter(model, resolvedLang) + serializeSingleBlockBody(model.blocks[0] ?? emptyBlock(), lang);
}

// ── Frontmatter ───────────────────────────────────────────────────────────────

/**
 * Builds the YAML frontmatter block including the opening and closing `---` fences.
 *
 * @param model       - The form model supplying title, description, tags.
 * @param language    - Resolved language string (pass `undefined` for multi-block).
 * @returns Frontmatter string ending with `---\n`.
 *
 * @example
 * serializeFrontmatter(model, 'javascript') // '---\nartifactType: Snippet\n...\n---\n'
 */
function serializeFrontmatter(model: ArtifactFormModel, language: string | undefined): string {
    const lines: string[] = ['---'];

    // artifactType is always emitted
    lines.push(`artifactType: ${model.artifactType}`);

    // title / description — single-line enforced
    if (model.title !== '') { lines.push(`title: ${safeYamlValue(model.title)}`); }
    if (model.description !== '') { lines.push(`description: ${safeYamlValue(model.description)}`); }

    // language — single-block only, omitted for plain text and multi-block
    if (language !== undefined && language !== '') { lines.push(`language: ${language}`); }

    // extension / provider / model / version — type-only keys, emitted before tags.
    pushOptionalKeys(lines, model, ['extension', 'provider', 'model', 'version']);

    // tags — omitted when empty
    if (model.tags.length > 0) {
        const safeTagList = model.tags
            .filter(t => !/[,\]\n\r]/.test(t))
            .join(', ');
        lines.push(`tags: [${safeTagList}]`);
    }

    // env / target — both sit in FRONTMATTER_KEY_ORDER and in the parser's
    // STRING_FRONTMATTER_KEYS, yet neither had an emit line here: this function
    // hardcoded its fields and never iterates the order table, so every `env:`
    // and every user-typed `target:` was silently dropped on any re-serialize.
    // A key-order table is not an emitter. Guarded by a content round-trip in
    // frontmatter-keys.test.ts — the pre-existing list-vs-list comparison was
    // green throughout, because both keys are in both lists.
    pushOptionalKeys(lines, model, ['env', 'target']);

    lines.push('---');
    return lines.join('\n') + '\n';
}

/**
 * Appends `key: value` for each optional string field that is present and non-empty.
 *
 * Every value goes through `safeYamlValue`, so an embedded newline can never
 * inject a sibling frontmatter key on re-parse — the property that made the
 * per-key `if` chain this replaces worth keeping identical in behaviour. Caller
 * order decides emission order, which must match `FRONTMATTER_KEY_ORDER`.
 *
 * @param lines - Frontmatter lines accumulated so far; appended to in place.
 * @param model - The form model supplying the values.
 * @param keys  - Which optional string fields to emit, in emission order.
 * @returns Nothing; `lines` is mutated.
 *
 * @example
 * pushOptionalKeys(lines, model, ['env', 'target']);
 */
function pushOptionalKeys(
    lines: string[],
    model: ArtifactFormModel,
    keys: readonly (keyof ArtifactFormModel)[],
): void {
    for (const key of keys) {
        const value = model[key];
        if (typeof value === 'string' && value !== '') {
            lines.push(`${key}: ${safeYamlValue(value)}`);
        }
    }
}

// ── Single-block body ─────────────────────────────────────────────────────────

/**
 * Builds the body (after frontmatter) for a single-block artifact.
 *
 * @param block - The sole content block.
 * @param lang  - Resolved language string (may be empty for plain text).
 * @returns Body string starting with a blank line and ending with `\n`.
 *
 * @example
 * serializeSingleBlockBody(block, 'javascript')
 */
function serializeSingleBlockBody(block: ArtifactFormBlock, lang: string): string {
    const fence = `\`\`\`${lang}`;
    const codePart = `\n${fence}\n${block.code.trimEnd()}\n\`\`\`\n`;
    const vksPart = serializeVks(block.vars);
    return codePart + vksPart;
}

// ── Variables body ────────────────────────────────────────────────────────────

/**
 * Builds the body for an `artifactType: Variables` file — bare ` ```vks ` fences, no code
 * fence and no `vars:` label (ARTIFACT_FILE_FORMAT.md §3, §6).
 *
 * Unlike `serializeVks`, vars are emitted **unfiltered**: for a variables file
 * the fence is the payload, so a var with an empty value is a key the user
 * asked to record, not an omittable annotation.
 *
 * @param model        - The variables model to serialize.
 * @param isMultiBlock - Whether to emit one `## `-headed sub-set per block.
 * @returns Body string starting with `\n` and ending with `\n`.
 *
 * @example
 * serializeVariablesBody(model, false) // '\n```vks\nVK-host=localhost\n```\n'
 */
function serializeVariablesBody(model: ArtifactFormModel, isMultiBlock: boolean): string {
    if (!isMultiBlock) {
        return vksFence(model.blocks[0]?.vars ?? []);
    }

    return model.blocks
        .map(b => {
            const descLine = b.description !== '' ? `${b.description}\n` : '';
            // A heading ALWAYS gets a fence, even with no vars. `parseBlocks`
            // requires one, so a bare `## Heading` is dropped on re-parse while
            // the heading stays stranded in the user's file — the sub-set
            // vanishes from the tree and the text remains. Reached two ways,
            // both destructive: a sub-set created before its first variable,
            // and `deleteVar` removing a sub-set's last one. The empty fence
            // parses back cleanly as `vars: []`; only the emission was wrong.
            // `vksFence` itself keeps returning '' for empty — its other
            // caller (`serializeVks`) must NOT emit a bare `vars:` fence for a
            // var-less snippet block. Guarded by "empty sub-set round-trip".
            return `\n## ${b.heading}\n${descLine}${b.vars.length === 0 ? EMPTY_VKS_FENCE : vksFence(b.vars)}`;
        })
        .join('');
}

/**
 * The `vks` fence emitted for a sub-set that has no variables yet.
 *
 * Distinct from `vksFence([])`, which returns `''` — see the comment in
 * `serializeVariablesBody` for why the two callers need different answers.
 */
const EMPTY_VKS_FENCE = '\n```vks\n```\n';

/**
 * Emits a bare ` ```vks ` fence for the given vars, values verbatim.
 *
 * @param vars - Vars to write as `name=value` lines.
 * @returns Fence string starting with `\n`, or `''` when there are no vars.
 *
 * @example
 * vksFence([{ name: 'VK-host', defaultValue: 'localhost' }])
 * // '\n```vks\nVK-host=localhost\n```\n'
 */
function vksFence(vars: ParsedVar[]): string {
    if (vars.length === 0) { return ''; }
    const body = vars.map(v => `${v.name}=${v.defaultValue}`).join('\n');
    return `\n\`\`\`vks\n${body}\n\`\`\`\n`;
}

// ── Multi-block body ──────────────────────────────────────────────────────────

/**
 * Builds the body for a multi-block artifact: one `## `‐headed section per block.
 *
 * No top-level code or vks fence is emitted before the first heading — doing so
 * causes the parser to phantom-hoist that content as the file's top-level code.
 *
 * @param model - The form model with two or more blocks.
 * @returns Body string starting with `\n` and ending with `\n`.
 *
 * @example
 * serializeMultiBlockBody(multiBlockModel)
 */
function serializeMultiBlockBody(model: ArtifactFormModel): string {
    return model.blocks.map(b => serializeBlock(b, model.artifactType)).join('');
}

/**
 * Serializes one block of a multi-block artifact.
 *
 * @param block - The block to serialize.
 * @param type  - The artifact type (used to resolve language mode).
 * @returns Block string starting with `\n## ` and ending with `\n`.
 *
 * @example
 * serializeBlock(block, 'Snippet')
 */
function serializeBlock(block: ArtifactFormBlock, type: ArtifactType): string {
    const lang = resolveBlockLanguage(type, block.language);
    const descLine = block.description !== '' ? `${block.description}\n\n` : '\n';
    const fence = `\`\`\`${lang}`;
    const vksPart = serializeVks(block.vars);
    return `\n## ${block.heading}\n${descLine}${fence}\n${block.code.trimEnd()}\n\`\`\`\n${vksPart}`;
}

// ── Vars (vks fence) ──────────────────────────────────────────────────────────

/**
 * Emits a `vars:\n```vks` fence for vars that have a non-empty `defaultValue`.
 *
 * Returns an empty string when no var has a non-empty default, so the fence is
 * omitted entirely — the parser auto-detects tokens from the code block.
 * Default values are emitted **verbatim**: quotes, spaces, and equals signs are
 * not escaped. `VK-x="active"` stays `VK-x="active"`.
 *
 * @param vars - The var list from the block or top-level model.
 * @returns Vks fence string (starting with `\n`) or `''`.
 *
 * @example
 * serializeVks([{ name: 'VK-x', defaultValue: '"active"' }])
 * // '\nvars:\n```vks\nVK-x="active"\n```\n'
 */
function serializeVks(vars: ParsedVar[]): string {
    const fence = vksFence(vars.filter(v => v.defaultValue !== ''));
    return fence === '' ? '' : `\nvars:${fence}`;
}

// ── Language resolution ───────────────────────────────────────────────────────

/**
 * Resolves the fence info-string for a block based on the artifact type's language mode.
 *
 * For `locked` or `hidden` types, returns the type's fixed default (e.g. `bash`
 * for `command`) — the block's own `language` value is ignored. For `free` types,
 * returns `block.language` as-is (may be `''` for plain text).
 *
 * @param type          - Artifact type — used to look up `getLanguageMode`.
 * @param blockLanguage - Language value from the block (used only for `free` mode).
 * @returns Fence info-string — may be `''` for plain text.
 *
 * @example
 * resolveBlockLanguage('Command', '') // 'bash'
 * resolveBlockLanguage('Snippet', 'javascript') // 'javascript'
 * resolveBlockLanguage('Snippet', '') // ''
 */
function resolveBlockLanguage(type: ArtifactType, blockLanguage: string): string {
    const mode = getLanguageMode(type);
    if (mode === 'locked' || mode === 'hidden') {
        return getDefaultLanguage(type);
    }
    return blockLanguage;
}

// ── YAML safety ───────────────────────────────────────────────────────────────

/**
 * Strips embedded newlines from a YAML scalar value and collapses space runs.
 *
 * The parser reads frontmatter line-by-line, so a literal newline inside
 * `title` or `description` would split the value across two lines and corrupt
 * the parse. This function normalises the value to a single line.
 *
 * @param s - Raw string from the form model.
 * @returns Single-line string with leading/trailing whitespace trimmed.
 *
 * @example
 * safeYamlValue('Foo\nBar') // 'Foo Bar'
 * safeYamlValue('A\r\nB\rC') // 'A B C'
 */
function safeYamlValue(s: string): string {
    return s.replaceAll(/\r\n|\r|\n/g, ' ').replaceAll(/ {2,}/g, ' ').trim();
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Returns a zero-value block used as a fallback when `model.blocks` is empty.
 *
 * `ArtifactFormModel` always has at least one block in valid state, but this
 * guard prevents a crash on malformed input at the cost of an empty output.
 *
 * @returns An empty `ArtifactFormBlock`.
 *
 * @example
 * emptyBlock() // { heading: '', description: '', language: '', code: '', vars: [] }
 */
function emptyBlock(): ArtifactFormBlock {
    return { heading: '', description: '', language: '', code: '', vars: [] };
}
