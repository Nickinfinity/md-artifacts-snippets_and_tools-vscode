import type { ArtifactType } from './parsed-artifact.types.js';

/**
 * All VS Code UI surfaces where an artifact's command can appear.
 *
 * - `editor`   — main editor context menu
 * - `terminal` — integrated terminal context menu
 * - `explorer` — Explorer (file tree) context menu
 * - `all`      — every standard VS Code context menu surface
 */
export type ArtifactContext = 'editor' | 'terminal' | 'explorer' | 'all';

/**
 * Language selector behaviour for an artifact type in the create form.
 *
 * - `free`   — enabled dropdown, user-selectable (snippet)
 * - `locked` — disabled, pre-filled with `language.default` (command → `bash`)
 * - `hidden` — not rendered; fence info-string is always `language.default`
 */
export type LanguageMode = 'free' | 'locked' | 'hidden';

/**
 * Per-type form behaviour for the artifact create form.
 *
 * Read by `artifact-type-config.service` helpers. Form code never
 * branches on a type string literal — all per-type variation lives here.
 *
 * @example
 * { language: { mode: 'locked', default: 'bash' }, label: { singular: 'command' }, multiBlock: true }
 */
export interface ArtifactTypeFormConfig {
	/** Language selector configuration. */
	language: {
		/** Selector rendering mode. */
		mode: LanguageMode;
		/** Required when `mode === 'locked'`; default for new blocks when `'free'`; fence value when `'hidden'`. */
		default?: string;
		/** Optional curated dropdown list for `mode === 'free'`. */
		options?: string[];
	};
	/** Type-singular labels used in UI buttons and confirm prompts. */
	label: {
		/** Singular noun — drives `+ Add additional <singular>`, `Delete entire <singular>`, etc. */
		singular: string;
	};
	/** `true` → multi-block allowed (`+` button visible); `false` → single block forced. */
	multiBlock: boolean;
}

/** A single Obsidian vault artifact directory and its VS Code UI configuration */
export interface Artifact {
	/** Canonical artifact type literal — direct lookup key for parser/serializer/services. */
	type: ArtifactType;
	/** Human-readable display name */
	name: string;
	/** Folder name on disk inside the vault root */
	dir: string;
	/** Auto-create this directory on first vault selection when true */
	default: boolean;
	/** Context menu surfaces where this artifact's action should appear */
	contexts: readonly ArtifactContext[];
	/** Optional VS Code codicon id used in QuickPick / preview headers */
	icon?: string;
	/** Gate this type into the create-flow type picker. */
	createForm?: boolean;
	/**
	 * Invoking this type writes a whole file into the workspace (Explorer
	 * "Create File") instead of inserting at the cursor — `template`, `agent`.
	 *
	 * Declared here rather than as a type-literal check in a service so the
	 * write-vs-insert set stays derived from this table (`writesWholeFile`).
	 */
	writesFile?: boolean;
	/**
	 * Which `ArtifactFormModel` key supplies this type's **output filename**.
	 * Set on exactly the `writesFile` types, and meaningless without one:
	 * `'target'` is the filename verbatim (`AIAgentsConfig` — `CLAUDE.md`),
	 * `'extension'` feeds the D3 precedence chain instead (`Template`).
	 *
	 * Declared here, next to `writesFile`, for the same reason `writesFile`
	 * is: it keeps `CLAUDE.md`'s promise that a third whole-file type is a
	 * `constants.ts` row plus one branch in `resolveOutputFileName` literally
	 * true. Read through `getFilenameField`; `filename-field.test.ts` binds
	 * the two flags so a `writesFile` row that forgets this key fails loudly
	 * instead of scaffolding extension-less files.
	 */
	outputNameKey?: 'target' | 'extension';
	/**
	 * Whether picking this type opens it in an **editable** view rather than the
	 * insert preview (D-11).
	 *
	 * Declared here beside `writesFile` for the same reason that one is: the
	 * write-vs-insert and edit-vs-insert sets both stay derived from this table.
	 * One flag drives **both** halves of the behaviour — the main pane's browse
	 * list omits the type (`getBrowseTypes`) and the picker routes it to the
	 * pane's edit mode (`opensForEdit`) — so the row list and the routing can
	 * never disagree about which types are editable.
	 *
	 * Read through `opensForEdit` / `getBrowseTypes`, never as a type-literal
	 * check: a hardcoded `type === 'Variables'` is the enumeration class that
	 * silently drifts when a second editable type appears.
	 */
	opensForEdit?: boolean;
	/** Per-type form behaviour — required when `createForm === true`. */
	form?: ArtifactTypeFormConfig;
}

export type ArtifactsArray = readonly Artifact[];
