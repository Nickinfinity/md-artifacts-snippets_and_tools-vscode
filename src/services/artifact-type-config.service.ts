import { ARTIFACTS } from '../types/constants.js';
import type { Artifact, ArtifactContext, ArtifactTypeFormConfig, LanguageMode } from '../types/artifact.types.js';
import type { ArtifactType } from '../types/parsed-artifact.types.js';

/**
 * Locates the `ARTIFACTS` entry for a given type literal.
 *
 * **This is the only place that traverses `ARTIFACTS` by type.** Six other call
 * sites used to open-code `ARTIFACTS.find(a => a.type === …)` — including one
 * that re-threw a character-identical error message — so this is enforced by
 * `test/artifact-type-config.test.ts` rather than asserted in prose.
 *
 * Throws on miss so a caller passing an unrecognised type fails loudly instead
 * of silently receiving `undefined`.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns The matching `Artifact` entry.
 * @throws When no entry has a matching `type` field.
 *
 * @example
 * getEntry('Snippet'); // → { type: 'Snippet', dir: 'Snippets', form: { ... }, ... }
 * getEntry('Snippet').dir; // → 'Snippets'
 */
export function getEntry(type: ArtifactType): Artifact {
    const entry = ARTIFACTS.find(e => e.type === type);
    if (!entry) {
        throw new Error(`Unknown artifact type: ${type}`);
    }
    return entry;
}

/**
 * Returns the per-type form configuration for a create-form-enabled type.
 *
 * Throws when the requested type is not create-form-enabled (e.g.
 * `Variables`) — the form UI should never reach this code path
 * for an excluded type. Use `getCreateFormTypes()` to drive the type picker
 * so excluded types are never offered.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns The `ArtifactTypeFormConfig` for the type.
 * @throws When the type is unknown or `createForm !== true`.
 *
 * @example
 * getFormConfig('Command'); // → { language: { mode: 'locked', default: 'bash' }, label: { singular: 'command' }, multiBlock: true }
 */
export function getFormConfig(type: ArtifactType): ArtifactTypeFormConfig {
    const entry = getEntry(type);
    if (entry.createForm !== true || !entry.form) {
        throw new Error(`Artifact type "${type}" is not create-form-enabled`);
    }
    return entry.form;
}

/**
 * Returns the language-selector mode (`free` | `locked` | `hidden`) for a
 * create-form-enabled type.
 *
 * Drives whether the form renders an enabled dropdown, a disabled pre-filled
 * field, or no language field at all.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns The `LanguageMode` for the type.
 * @throws When the type is not create-form-enabled.
 *
 * @example
 * getLanguageMode('Snippet'); // → 'free'
 * getLanguageMode('Command'); // → 'locked'
 */
export function getLanguageMode(type: ArtifactType): LanguageMode {
    return getFormConfig(type).language.mode;
}

/**
 * Returns the default language for a create-form-enabled type.
 *
 * For `locked` mode this is the serializer's emitted language (e.g. `bash`
 * for `command`). For `free` mode this is the language new blocks start
 * with (`''` for plain text on `snippet`). For `hidden` mode this is the
 * fence info-string the serializer emits unconditionally.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns The default language string (may be empty).
 * @throws When the type is not create-form-enabled.
 *
 * @example
 * getDefaultLanguage('Command'); // → 'bash'
 * getDefaultLanguage('Snippet'); // → ''
 */
export function getDefaultLanguage(type: ArtifactType): string {
    return getFormConfig(type).language.default ?? '';
}

/**
 * Returns the singular noun label for a create-form-enabled type.
 *
 * Drives dynamic UI strings such as `+ Add additional <singular>`,
 * `× This <singular> block will be deleted`, and `Delete entire <singular>`.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns The singular noun (e.g. `'snippet'`, `'command'`).
 * @throws When the type is not create-form-enabled.
 *
 * @example
 * getTypeSingular('Snippet'); // → 'snippet'
 */
export function getTypeSingular(type: ArtifactType): string {
    return getFormConfig(type).label.singular;
}

/**
 * Returns whether a create-form-enabled type allows multiple blocks.
 *
 * `true` → the form renders the `+ Add additional <singular>` button.
 * `false` → single block forced; `+` and per-block `×` buttons never render.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns `true` when multi-block is allowed.
 * @throws When the type is not create-form-enabled.
 *
 * @example
 * canMultiBlock('Snippet'); // → true
 */
export function canMultiBlock(type: ArtifactType): boolean {
    return getFormConfig(type).multiBlock;
}

/**
 * Returns every artifact type declared in `ARTIFACTS`, in declaration order.
 *
 * The parser uses this to decide which frontmatter `artifactType:` values are valid,
 * so a type added to `ARTIFACTS` is accepted immediately. Before this existed
 * the parser carried its own hardcoded list and silently downgraded any type
 * missing from it to `'snippet'`.
 *
 * @returns Array of every `ArtifactType` literal.
 *
 * @example
 * getAllTypes(); // → ['Snippet', 'AIAgentsConfig', 'Command', 'Template', 'Variables']
 */
export function getAllTypes(): ArtifactType[] {
    return ARTIFACTS.map(e => e.type);
}

/**
 * Returns the list of types that surface in the create-flow type picker.
 *
 * Derived from `ARTIFACTS` — any entry with `createForm === true` is
 * included. Adding a new create-form type is a `constants.ts` change only;
 * downstream pickers and tests pick it up automatically.
 *
 * @returns Array of `ArtifactType` literals (order matches `ARTIFACTS` order).
 *
 * @example
 * getCreateFormTypes(); // → ['Snippet', 'AIAgentsConfig', 'Command', 'Template']
 */
export function getCreateFormTypes(): ArtifactType[] {
    return ARTIFACTS.filter(e => e.createForm === true).map(e => e.type);
}

/**
 * Reports whether invoking this artifact type writes a whole file into the
 * workspace (the Explorer "Create File" flow) instead of inserting at the cursor.
 *
 * Two types write files today: `Template` (filename from the D3
 * extension-precedence chain) and `AIAgentsConfig` (filename seeded from the
 * `target:` frontmatter key, e.g. `CLAUDE.md`). Every other type inserts at
 * the cursor or sends to the terminal.
 *
 * **Derived from `ARTIFACTS.writesFile`, never a type-literal check** — a
 * hardcoded `type === 'Template' || type === 'AIAgentsConfig'` is the
 * enumeration class that silently drifts when a third file-writing type is added.
 *
 * **Single source for the behaviour** — the preview's primary-button label
 * (`Create File` vs `Insert`) and the insert handler's write-vs-paste branch both
 * call this, so they can never disagree. Guarded by `artifact-type-config.test.ts`.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns `true` for `Template` and `AIAgentsConfig`; `false` otherwise.
 * @throws When the type is unknown (via `getEntry`).
 *
 * @example
 * writesWholeFile('Template');       // → true
 * writesWholeFile('AIAgentsConfig'); // → true
 * writesWholeFile('Snippet');        // → false
 */
export function writesWholeFile(type: ArtifactType): boolean {
    return getEntry(type).writesFile === true;
}

/**
 * Answers whether a type can *only* ever insert into the terminal.
 *
 * The narrow question the preview renderer needs: may Insert be hidden when no
 * editor tab is open? A `contexts: ['terminal']` row (only `Command` today)
 * always routes to the terminal — `resolveInsertTarget`'s first rule — so
 * gating its button on an editor would make it uninsertable.
 *
 * Deliberately *not* `resolveInsertTarget`: that resolver needs an
 * `InvocationSurface` the renderer does not have, and a both-context type
 * (`AIPrompt`) can still land in an editor, so it must stay gated. Reads
 * `contexts` through `getEntry`, never a second `ARTIFACTS` traversal.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns `true` when `contexts` is exactly `['terminal']`; `false` otherwise.
 * @throws When the type is unknown (via `getEntry`).
 *
 * @example
 * isTerminalOnly('Command');  // → true
 * isTerminalOnly('AIPrompt'); // → false — declares both, can land in an editor
 * isTerminalOnly('Snippet');  // → false
 */
export function isTerminalOnly(type: ArtifactType): boolean {
    const { contexts } = getEntry(type);
    return contexts.length === 1 && contexts[0] === 'terminal';
}

/**
 * Names the `ArtifactFormModel` key that supplies a type's output filename,
 * or `undefined` for the types that do not write a whole file.
 *
 * The one reader of `Artifact.outputNameKey`, and the reason no caller spells
 * `artifactType === 'Template'` to make this decision: `buildFilePrefill`
 * (explorer capture) and `create-index.service.ts` (batch siblings) both need
 * the same per-type answer, and both get it here. Kept in this service rather
 * than as a local table because this module derives **everything** from
 * `getEntry` — a `Record<ArtifactType, …>` here would be a second enumeration
 * of the domain set, which is the drift `constants.test.ts` exists to catch.
 *
 * @param type - The artifact type to look up.
 * @returns `'target'`, `'extension'`, or `undefined` when the type inserts at
 *          the cursor rather than writing a file.
 *
 * @example
 * getFilenameField('AIAgentsConfig'); // → 'target'
 * getFilenameField('Template');       // → 'extension'
 * getFilenameField('Snippet');        // → undefined
 */
export function getFilenameField(type: ArtifactType): 'target' | 'extension' | undefined {
    return getEntry(type).outputNameKey;
}

/**
 * Reports whether picking this artifact type opens it in an **editable** view
 * instead of the insert preview (D-11).
 *
 * `Variables` is the only such type today: its files are variable-set
 * definitions the user edits, not payloads inserted at a cursor.
 *
 * **Derived from `ARTIFACTS.opensForEdit`, never a type-literal check** — the
 * same rule `writesWholeFile` follows, for the same reason. A hardcoded
 * `type === 'Variables'` is the enumeration that drifts the moment a second
 * editable type appears.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns `true` when the type opens for edit; `false` when it inserts.
 * @throws When the type is unknown (via `getEntry`).
 *
 * @example
 * opensForEdit('Variables'); // → true
 * opensForEdit('Snippet');   // → false
 */
export function opensForEdit(type: ArtifactType): boolean {
    return getEntry(type).opensForEdit === true;
}

/**
 * Returns the types that surface in the main pane's **Open** (browse) list —
 * every type except those that open for edit.
 *
 * The counterpart to `getCreateFormTypes()` for the browse half of the pane,
 * and the gate `resolveBrowseCommandId` checks: a row can never be clickable
 * in that list without also being a valid browse target, because both derive
 * from this one call.
 *
 * Built from `getAllTypes()` minus `opensForEdit`, so a new editable type is a
 * `constants.ts` flag and nothing else — never a second list to maintain here.
 *
 * @returns Array of browsable `ArtifactType` literals, in `ARTIFACTS` order.
 *
 * @example
 * getBrowseTypes(); // → ['Snippet', 'AIAgentsConfig', 'Command', 'Template', 'AIPrompt']
 */
export function getBrowseTypes(): ArtifactType[] {
    return getAllTypes().filter(type => !opensForEdit(type));
}

/**
 * Reports whether a type is restricted to a single code block (D1).
 *
 * Derived from the same `form.multiBlock` flag `canMultiBlock` reads, but
 * **non-throwing**: types with no create form (`Variables`) answer `false`, so
 * navigation code can ask about any parsed file without a try/catch.
 *
 * The picker uses it to route a malformed 2+ block template to the single
 * preview, where the Create File handler surfaces the D1 error.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @returns `true` only when the type declares `form.multiBlock === false`.
 * @throws When the type is unknown (via `getEntry`) — a *missing form* is not an error.
 *
 * @example
 * forcesSingleBlock('Template');       // → true
 * forcesSingleBlock('AIAgentsConfig'); // → false
 * forcesSingleBlock('Variables');      // → false — no form config, no throw
 */
export function forcesSingleBlock(type: ArtifactType): boolean {
    return getEntry(type).form?.multiBlock === false;
}

/**
 * Resolves the artifact type that owns a vault directory name.
 *
 * The directory is the type declaration for files that carry no frontmatter —
 * a real vault `Commands/` file usually starts straight at `## heading`, and
 * the user already declared its kind by filing it there. `ARTIFACTS` treats the
 * directory as authoritative for menus, context keys and command registration;
 * this makes parsing agree with them.
 *
 * @param dirName - Bare directory name as it appears in the vault (e.g. `'Commands'`). Case-insensitive.
 * @returns The owning `ArtifactType`, or `undefined` when no entry claims that directory.
 *
 * @example
 * getTypeForDir('Commands'); // → 'Command'
 * getTypeForDir('Whatever'); // → undefined
 */
export function getTypeForDir(dirName: string): ArtifactType | undefined {
    const target = dirName.toLowerCase();
    return ARTIFACTS.find(a => a.dir.toLowerCase() === target)?.type;
}

/**
 * Reports whether an artifact type surfaces on a given VS Code context-menu
 * surface. `'all'` in the entry's `contexts` matches every surface.
 *
 * `surface` excludes `'all'` by construction: `'all'` is only ever a
 * *declaration* inside an entry's `contexts` (meaning "every surface"), never
 * a surface a caller can query — so that combination is unrepresentable
 * rather than a silently-false answer.
 *
 * `context.service.ts` still carries its own private `artifactInContext(contexts, surface)`
 * (a raw-contexts-array equivalent of the `'all'` rule below) as of this
 * writing; the orchestrator retires it in favour of this type-keyed version
 * at Wave 0 close, once every caller of this service exists to import from.
 *
 * @param type - Canonical `ArtifactType` literal.
 * @param surface - The context-menu surface to test (never `'all'`).
 * @returns `true` when the type's `contexts` includes `surface` or `'all'`.
 * @throws When the type is unknown (via `getEntry`).
 *
 * @example
 * isInContext('Command', 'terminal'); // → true
 * isInContext('Variables', 'editor'); // → true (contexts: ['all'])
 */
export function isInContext(type: ArtifactType, surface: Exclude<ArtifactContext, 'all'>): boolean {
    const entry = getEntry(type);
    return entry.contexts.includes(surface) || entry.contexts.includes('all');
}

/**
 * Returns the create-form types that surface on a given context-menu surface.
 *
 * A type qualifies iff `entry.createForm === true && isInContext(entry.type, surface)`.
 * `Variables` has no `createForm`, so it is absent from every surface despite
 * declaring `contexts: ['all']`.
 *
 * @param surface - The context-menu surface to filter by (never `'all'` — see `isInContext`).
 * @returns `ArtifactType` literals in `ARTIFACTS` declaration order.
 *
 * @example
 * getCreateTypesForSurface('terminal'); // → ['Command', 'AIPrompt']
 * getCreateTypesForSurface('explorer'); // → ['AIAgentsConfig', 'Template']
 */
export function getCreateTypesForSurface(surface: Exclude<ArtifactContext, 'all'>): ArtifactType[] {
    return ARTIFACTS
        .filter(e => e.createForm === true && isInContext(e.type, surface))
        .map(e => e.type);
}

/**
 * Returns the types capable of driving a template index (batch scaffolding).
 *
 * A type qualifies iff it surfaces on `'explorer'` (per
 * `getCreateTypesForSurface`) and `writesFile === true` — an index can only
 * scaffold whole-file types, and only from the Explorer.
 *
 * @returns `ArtifactType` literals in `ARTIFACTS` declaration order.
 *
 * @example
 * getIndexCapableTypes(); // → ['AIAgentsConfig', 'Template']
 */
export function getIndexCapableTypes(): ArtifactType[] {
    return getCreateTypesForSurface('explorer').filter(t => getEntry(t).writesFile === true);
}
