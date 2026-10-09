import { VK_TOKEN_RE } from './parser.service.js';
import type { ArtifactFormModel, ArtifactFormBlock } from '../types/artifact-form.types.js';
import type { ParsedVar } from '../types/parsed-artifact.types.js';

/**
 * Pure, `vscode`-free mutators for the Variables create/edit form model
 * (T14, VSX-217).
 *
 * Every mutator's first parameter and return type is `ArtifactFormModel` —
 * never `ParsedArtifactFile` — and none mutates its input: each call builds a
 * new `blocks` array plus a new `vars` array on the one touched block, while
 * every untouched block/vars array stays shared by reference with the
 * original model (ARTIFACT_FILE_FORMAT.md §3, §6).
 *
 * One sub-set = one `ArtifactFormBlock`; its `heading` is the sub-set's
 * identity, its `vars` the `<VK-xxx>` entries. A variable's `name` is the
 * **full token without angle brackets** — `'VK-host'`, never `'<VK-host>'`
 * or `'host'` (§4) — validated against `VK_TOKEN_RE`'s hint rule, imported
 * from `parser.service.ts` rather than re-spelled here.
 */

/**
 * Reports whether `name` is a legal `<VK-xxx>` variable name — the bare
 * `VK-hint` spelling with no angle brackets, matching `VK_TOKEN_RE`'s hint
 * rule (`[A-Za-z]\w*` after the `VK-` prefix).
 *
 * Wraps the candidate as an opening tag and matches it against the shared
 * `VK_TOKEN_RE` — via `matchAll`, which resets `lastIndex` itself — rather
 * than re-spelling the hint pattern locally, so the two rules can never drift.
 *
 * @param name - Candidate bare variable name (no angle brackets).
 * @returns `true` when wrapping `name` in `<...>` yields exactly one token
 * spanning the whole wrapped string.
 *
 * @example
 * isValidVarName('VK-host')   // → true
 * isValidVarName('nope')      // → false — missing the VK- prefix
 * isValidVarName('VK-')       // → false — empty hint
 * isValidVarName('VK-1abc')   // → false — hint must start with a letter
 */
function isValidVarName(name: string): boolean {
    const wrapped = `<${name}>`;
    const matches = [...wrapped.matchAll(VK_TOKEN_RE)];
    return matches.length === 1 && matches[0][0] === wrapped;
}

/**
 * Throws when `name` fails the `VK-xxx` hint rule.
 *
 * @param name - Candidate bare variable name.
 * @returns void
 * @throws {Error} When `isValidVarName(name)` is `false`.
 *
 * @example
 * assertValidVarName('VK-host'); // ok
 * assertValidVarName('nope');    // throws
 */
function assertValidVarName(name: string): void {
    if (!isValidVarName(name)) {
        throw new Error(`Invalid variable name "${name}": must be a VK-xxx token (e.g. "VK-host").`);
    }
}

/**
 * Names a sub-set: its heading, or its index into `model.blocks`.
 *
 * The Variables pane passes the **index** — the position of the row that was
 * clicked. A heading cannot identify an untitled block (`''`), and two
 * hand-written blocks may share one; a position is always exact.
 */
export type SubSetRef = string | number;

/**
 * Finds a sub-set's index from a heading or an index.
 *
 * @param model - Model to search.
 * @param ref   - Sub-set heading, or an index into `model.blocks`.
 * @returns The matching block's index.
 * @throws {Error} When no block carries the heading, or the index is out of range.
 *
 * @example
 * findSubSetIndex(model, 'Development')
 * findSubSetIndex(model, 0)
 */
function findSubSetIndex(model: ArtifactFormModel, ref: SubSetRef): number {
    const index = typeof ref === 'number'
        ? (Number.isInteger(ref) && ref >= 0 && ref < model.blocks.length ? ref : -1)
        : model.blocks.findIndex(b => b.heading === ref);
    if (index === -1) {
        throw new Error(`Sub-set not found: "${ref}".`);
    }
    return index;
}

/** Name given to an untitled block when a file gains a second sub-set (it then needs a `## ` heading). */
export const DEFAULT_SUBSET_NAME = 'Default';

/**
 * Returns {@link DEFAULT_SUBSET_NAME}, or the first free numbered variant
 * (`Default 2`, `Default 3`, …) when a sub-set already uses it.
 *
 * Written to disk, so deliberately not localized: a vault is shared data.
 *
 * @param taken - Headings already in use.
 * @returns A heading no sub-set in `taken` carries.
 *
 * @example
 * uniqueDefaultName([]);          // → 'Default'
 * uniqueDefaultName(['Default']); // → 'Default 2'
 */
export function uniqueDefaultName(taken: readonly string[]): string {
    if (!taken.includes(DEFAULT_SUBSET_NAME)) { return DEFAULT_SUBSET_NAME; }
    let n = 2;
    while (taken.includes(`${DEFAULT_SUBSET_NAME} ${n}`)) { n += 1; }
    return `${DEFAULT_SUBSET_NAME} ${n}`;
}

/**
 * Builds a new model with `blocks[index]` replaced by `block`. Every other
 * block stays shared by reference with `model` — only the touched block and
 * the top-level `blocks` array are new.
 *
 * @param model - Source model (never mutated).
 * @param index - Index of the block to replace.
 * @param block - Replacement block.
 * @returns New `ArtifactFormModel` with the one block swapped in.
 *
 * @example
 * withBlock(model, 0, { ...model.blocks[0], vars: [] })
 */
function withBlock(model: ArtifactFormModel, index: number, block: ArtifactFormBlock): ArtifactFormModel {
    const blocks = model.blocks.slice();
    blocks[index] = block;
    return { ...model, blocks };
}

/**
 * Adds a new variable to a sub-set.
 *
 * @param model         - Source model (never mutated).
 * @param subSet        - The target sub-set — its heading, or its index (what the pane passes).
 * @param name          - Full `VK-xxx` token name, no angle brackets.
 * @param defaultValue  - Default value stored for the new var.
 * @returns New model with the var appended to the sub-set's `vars`.
 * @throws {Error} When `subSet` has no matching block, `name` fails
 * the `VK-` hint rule, or `name` already exists in that sub-set.
 *
 * @example
 * addVar(model, 'Development', 'VK-port', '3000')
 */
export function addVar(
    model: ArtifactFormModel,
    subSet: SubSetRef,
    name: string,
    defaultValue: string,
): ArtifactFormModel {
    assertValidVarName(name);
    const index = findSubSetIndex(model, subSet);
    const block = model.blocks[index];
    if (block.vars.some(v => v.name === name)) {
        throw new Error(`Variable "${name}" already exists in sub-set "${block.heading}".`);
    }
    const vars: ParsedVar[] = [...block.vars, { name, defaultValue }];
    return withBlock(model, index, { ...block, vars });
}

/**
 * Renames a variable within a sub-set, preserving its current value.
 *
 * @param model         - Source model (never mutated).
 * @param subSet        - The target sub-set — its heading, or its index (what the pane passes).
 * @param oldName       - Current full token name.
 * @param newName       - New full token name.
 * @returns New model with the var renamed.
 * @throws {Error} When the sub-set or `oldName` is not found, `newName` fails
 * the `VK-` hint rule, or `newName` collides with another var in the sub-set.
 *
 * @example
 * renameVar(model, 'Development', 'VK-host', 'VK-hostname')
 */
export function renameVar(
    model: ArtifactFormModel,
    subSet: SubSetRef,
    oldName: string,
    newName: string,
): ArtifactFormModel {
    assertValidVarName(newName);
    const index = findSubSetIndex(model, subSet);
    const block = model.blocks[index];
    const varIndex = block.vars.findIndex(v => v.name === oldName);
    if (varIndex === -1) {
        throw new Error(`Variable "${oldName}" not found in sub-set "${block.heading}".`);
    }
    if (newName !== oldName && block.vars.some(v => v.name === newName)) {
        throw new Error(`Variable "${newName}" already exists in sub-set "${block.heading}".`);
    }
    const vars = block.vars.slice();
    vars[varIndex] = { ...vars[varIndex], name: newName };
    return withBlock(model, index, { ...block, vars });
}

/**
 * Sets a variable's default value, leaving its name unchanged.
 *
 * @param model         - Source model (never mutated).
 * @param subSet        - The target sub-set — its heading, or its index (what the pane passes).
 * @param name          - Full token name of the variable to update.
 * @param value         - New default value.
 * @returns New model with the var's value updated.
 * @throws {Error} When the sub-set or `name` is not found.
 *
 * @example
 * setVarValue(model, 'Development', 'VK-host', 'localhost')
 */
export function setVarValue(
    model: ArtifactFormModel,
    subSet: SubSetRef,
    name: string,
    value: string,
): ArtifactFormModel {
    const index = findSubSetIndex(model, subSet);
    const block = model.blocks[index];
    const varIndex = block.vars.findIndex(v => v.name === name);
    if (varIndex === -1) {
        throw new Error(`Variable "${name}" not found in sub-set "${block.heading}".`);
    }
    const vars = block.vars.slice();
    vars[varIndex] = { ...vars[varIndex], defaultValue: value };
    return withBlock(model, index, { ...block, vars });
}

/**
 * Deletes a variable from a sub-set.
 *
 * @param model         - Source model (never mutated).
 * @param subSet        - The target sub-set — its heading, or its index (what the pane passes).
 * @param name          - Full token name of the variable to delete.
 * @returns New model with the var removed from the sub-set's `vars`.
 * @throws {Error} When the sub-set or `name` is not found.
 *
 * @example
 * deleteVar(model, 'Development', 'VK-host')
 */
export function deleteVar(model: ArtifactFormModel, subSet: SubSetRef, name: string): ArtifactFormModel {
    const index = findSubSetIndex(model, subSet);
    const block = model.blocks[index];
    if (!block.vars.some(v => v.name === name)) {
        throw new Error(`Variable "${name}" not found in sub-set "${block.heading}".`);
    }
    const vars = block.vars.filter(v => v.name !== name);
    return withBlock(model, index, { ...block, vars });
}

/**
 * Adds a new, empty sub-set (an `ArtifactFormBlock` with no vars).
 *
 * **The one place a one-block file becomes a sub-sets file.** A file whose
 * only block is untitled has no `## ` heading; with two sub-sets every block
 * needs one, so the untitled block is named {@link uniqueDefaultName} first.
 *
 * @param model   - Source model (never mutated).
 * @param heading - Heading for the new sub-set; must be non-empty and unique.
 * @returns New model with the sub-set appended (and an untitled sole block named).
 * @throws {Error} When `heading` is empty/whitespace-only or already used by
 * another block in `model`.
 *
 * @example
 * addSubSet(model, 'Production')
 */
export function addSubSet(model: ArtifactFormModel, heading: string): ArtifactFormModel {
    if (heading.trim().length === 0) {
        throw new Error('Sub-set heading cannot be empty.');
    }
    if (model.blocks.some(b => b.heading === heading)) {
        throw new Error(`Sub-set "${heading}" already exists.`);
    }
    const newBlock: ArtifactFormBlock = { heading, description: '', language: '', code: '', vars: [] };
    const sole = model.blocks.length === 1 ? model.blocks[0] : undefined;
    const blocks = sole?.heading === ''
        ? [{ ...sole, heading: uniqueDefaultName([heading]) }]
        : model.blocks;
    return { ...model, blocks: [...blocks, newBlock] };
}

/**
 * Renames a sub-set's heading.
 *
 * @param model      - Source model (never mutated).
 * @param oldHeading - Current heading (or index) of the sub-set to rename.
 * @param newHeading - New heading; must be non-empty and unique.
 * @returns New model with the sub-set's heading changed.
 * @throws {Error} When `oldHeading` has no matching block, `newHeading` is
 * empty/whitespace-only, or `newHeading` collides with another block.
 *
 * @example
 * renameSubSet(model, 'Development', 'Dev')
 */
export function renameSubSet(model: ArtifactFormModel, oldHeading: SubSetRef, newHeading: string): ArtifactFormModel {
    if (newHeading.trim().length === 0) {
        throw new Error('Sub-set heading cannot be empty.');
    }
    const index = findSubSetIndex(model, oldHeading);
    if (model.blocks.some((b, i) => i !== index && b.heading === newHeading)) {
        throw new Error(`Sub-set "${newHeading}" already exists.`);
    }
    return withBlock(model, index, { ...model.blocks[index], heading: newHeading });
}

/**
 * Sets a sub-set's description — the prose between its `## ` heading and its
 * fence. Structure-breaking text is the caller's to refuse
 * (`validateSubSetDescriptions`); this only places it.
 *
 * @param model       - Source model (never mutated).
 * @param subSet      - The target sub-set — its heading, or its index.
 * @param description - New description; `''` removes it.
 * @returns New model with the sub-set's description replaced.
 * @throws {Error} When the sub-set is not found, or it is untitled (an
 * untitled block has no heading line to keep a description under).
 *
 * @example
 * setSubSetDescription(model, 0, 'Active users keyed by `status`.')
 */
export function setSubSetDescription(model: ArtifactFormModel, subSet: SubSetRef, description: string): ArtifactFormModel {
    const index = findSubSetIndex(model, subSet);
    if (model.blocks[index].heading === '') {
        throw new Error('An untitled sub-set cannot have a description — give it a name first.');
    }
    return withBlock(model, index, { ...model.blocks[index], description });
}

/**
 * Deletes a sub-set — the last one included, matching the edit form. A file
 * left with none serializes to frontmatter only and reopens as one empty
 * sub-set; removing the file itself stays a separate, confirmed command.
 *
 * @param model   - Source model (never mutated).
 * @param heading - Heading (or index) of the sub-set to delete.
 * @returns New model with the sub-set removed.
 * @throws {Error} When `heading` has no matching block.
 *
 * @example
 * deleteSubSet(model, 'Production')
 */
export function deleteSubSet(model: ArtifactFormModel, heading: SubSetRef): ArtifactFormModel {
    const index = findSubSetIndex(model, heading);
    return { ...model, blocks: model.blocks.filter((_block, i) => i !== index) };
}
