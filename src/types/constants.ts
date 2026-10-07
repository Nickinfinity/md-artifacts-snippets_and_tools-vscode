import type { ArtifactsArray } from './artifact.types.js';

/**
 * All Obsidian vault artifact directories known to this extension.
 *
 * Each entry drives four things simultaneously:
 *  1. Which vault directories are created / detected (vault.service.ts)
 *  2. Which VS Code context keys are set (context.service.ts)
 *  3. Which insert commands are registered and where they appear (insert.command.ts + package.json)
 *  4. Per-type create-form behaviour — language mode, label, multi-block (artifact-type-config.service.ts)
 *
 * Context key and command ID are derived from `dir.toLowerCase()`:
 *   context key — `md-artifacts.<dir.toLowerCase()>Active`
 *   command     — `md-artifacts.insert.<dir.toLowerCase()>`
 *
 * `contexts: ['all']` means the artifact surfaces in every VS Code context menu.
 *
 * `type` is the canonical ArtifactType literal — direct lookup key used by the
 * parser, serializer, and helper services (never derived from `dir` at runtime).
 */
export const ARTIFACTS: ArtifactsArray = [
	{
		type: 'Snippet',
		name: 'Snippets',
		dir: 'Snippets',
		default: true,
		contexts: ['editor'],
		createForm: true,
		form: {
			language: { mode: 'free', default: '' },
			label: { singular: 'snippet' },
			multiBlock: true,
		},
	},
	{
		type: 'AIAgentsConfig',
		name: 'AI Agents Config',
		dir: 'AIAgentsConf',
		default: true,
		contexts: ['explorer'],
		createForm: true,
		// Invoking an agent config writes the whole file (named from `target:`),
		// exactly like a template — same flag, one shared code path.
		writesFile: true,
		outputNameKey: 'target',
		// D4: agent reuses the multi-block form machinery (matches ARTIFACT_FILE_FORMAT.md §5).
		// `free` language mirrors snippet/template; provider/model/version are agent-only
		// frontmatter keys rendered by buildAgentFieldsSection, not a language concern.
		form: {
			language: { mode: 'free', default: '' },
			label: { singular: 'agent config' },
			multiBlock: true,
		},
	},
	{
		type: 'Command',
		name: 'Commands',
		dir: 'Commands',
		default: false,
		contexts: ['terminal'],
		createForm: true,
		form: {
			language: { mode: 'locked', default: 'bash' },
			label: { singular: 'command' },
			multiBlock: true,
		},
	},
	{
		type: 'Template',
		name: 'Templates',
		dir: 'Templates',
		default: false,
		// Templates write a whole file into the workspace from the Explorer, so they
		// leave the editor menu (D4). `multiBlock: false` is D1 — a template is one
		// block; a 2+ block file is a validation error, expressed here in the table.
		contexts: ['explorer'],
		createForm: true,
		writesFile: true,
		outputNameKey: 'extension',
		form: {
			language: { mode: 'free', default: '' },
			label: { singular: 'template' },
			multiBlock: false,
		},
	},
	{
		type: 'Variables',
		name: 'Variables',
		dir: 'Variables',
		default: false,
		contexts: ['all'],
		// D-11 — a Variables file opens in an editable view, never the insert
		// preview. This one flag drives both halves: the main pane's Open list
		// omits it (`getBrowseTypes`) and the picker routes it to the pane's
		// edit mode (`opensForEdit`), so the list and the routing cannot drift.
		opensForEdit: true,
	},
	{
		type: 'AIPrompt',
		name: 'AI Prompts',
		dir: 'AIPrompts',
		// Namesake of the feature — auto-created on first vault selection, like
		// Snippets. A user who toggles it off has `false` written to settings, so
		// it does not come back.
		default: true,
		// A prompt is pasted into a chat pane (editor) or a CLI agent (terminal).
		// The only type declaring both, so it is the only one resolving its
		// target surface at insert time.
		contexts: ['editor', 'terminal'],
		createForm: true,
		form: {
			// The payload is flagged markdown (the syntax `flags.service.ts`
			// owns), so there is no language to pick — that service already
			// defaults it to markdown.
			language: { mode: 'hidden', default: 'markdown' },
			label: { singular: 'AI prompt' },
			// Flags' named regions already become ParsedBlocks; no new UI needed.
			multiBlock: true,
		},
	},
];

/**
 * Markdown code-fence shorthand → canonical VS Code `languageId`.
 *
 * Only entries whose fence shorthand **differs** from the VS Code id belong here.
 * Fence info-strings that already are valid ids (`javascript`, `python`, `json`,
 * `html`, `css`, `go`, `java`, `sql`, …) skip this map — `resolveLangId` validates
 * them directly against `vscode.languages.getLanguages()`.
 *
 * `LANG_FENCE` below is the **partial** inverse of this map, not the full one.
 * A full inverse is impossible: this map carries *shorthand* (`py3`, `cjs`,
 * `c++`), and inverting it would emit those as fence strings — `python` would
 * serialize as ```` ```py3 ````. `LANG_FENCE` therefore carries only the ids
 * that are not themselves valid fence strings, and
 * `test/language-consistency.test.ts` — not this comment — is what keeps the
 * two tables agreeing.
 *
 * @example
 * LANG_ALIAS['js']   // → 'javascript'
 * LANG_ALIAS['c#']   // → 'csharp'
 * LANG_ALIAS['bash'] // → 'shellscript'
 */
export const LANG_ALIAS: Record<string, string> = {
	js: 'javascript',
	node: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	jsx: 'javascriptreact',
	ts: 'typescript',
	tsx: 'typescriptreact',
	py: 'python',
	py3: 'python',
	rb: 'ruby',
	rs: 'rust',
	golang: 'go',
	sh: 'shellscript',
	shell: 'shellscript',
	bash: 'shellscript',
	zsh: 'shellscript',
	yml: 'yaml',
	md: 'markdown',
	'c++': 'cpp',
	'c#': 'csharp',
	cs: 'csharp',
	kt: 'kotlin',
	// `objc`/`objcpp` are the fence strings; `objective-c`/`objective-cpp` are the
	// real VS Code languageIds that `resolveLangId` validates against.
	objc: 'objective-c',
	objcpp: 'objective-cpp',
	ps1: 'powershell',
	htm: 'html',
};

/**
 * Canonical VS Code `languageId` → markdown code-fence info-string.
 *
 * The direction used when *writing* a fence (e.g. capturing an editor selection
 * into a new artifact). Only ids whose conventional fence string **differs**
 * from the id belong here — `mapLanguageId` passes anything else through
 * unchanged, so `javascript` stays ```` ```javascript ````.
 *
 * This is the partial inverse of `LANG_ALIAS`; see that map's note for why it
 * cannot be derived from it. Guard 1 of `test/language-consistency.test.ts`
 * asserts every entry here round-trips: `normalizeLangId(fence) === id`.
 *
 * @example
 * LANG_FENCE['typescriptreact'] // → 'tsx'
 * LANG_FENCE['shellscript']     // → 'bash'
 * LANG_FENCE['objective-c']     // → 'objc'
 */
export const LANG_FENCE: Readonly<Record<string, string>> = {
	typescriptreact: 'tsx',
	javascriptreact: 'jsx',
	shellscript: 'bash',
	dockerfile: 'dockerfile',
	'objective-c': 'objc',
	'objective-cpp': 'objcpp',
};

/**
 * Canonical VS Code `languageId` → cosmetic file extension for the temp edit file.
 *
 * The extension is **cosmetic only** — `BlockEditController` sets the editor
 * language explicitly via `vscode.languages.setTextDocumentLanguage`, so the
 * file name does not drive highlighting. Unmapped ids fall back through
 * `extForLang` (the id itself when filename-safe, else `txt`).
 *
 * @example
 * LANG_EXT['javascript'] // → 'js'
 * LANG_EXT['csharp']     // → 'cs'
 * LANG_EXT['plaintext']  // → 'txt'
 */
export const LANG_EXT: Record<string, string> = {
	javascript: 'js',
	javascriptreact: 'jsx',
	typescript: 'ts',
	typescriptreact: 'tsx',
	python: 'py',
	ruby: 'rb',
	rust: 'rs',
	go: 'go',
	java: 'java',
	csharp: 'cs',
	cpp: 'cpp',
	c: 'c',
	kotlin: 'kt',
	swift: 'swift',
	php: 'php',
	shellscript: 'sh',
	powershell: 'ps1',
	yaml: 'yml',
	json: 'json',
	html: 'html',
	css: 'css',
	scss: 'scss',
	sql: 'sql',
	markdown: 'md',
	xml: 'xml',
	'objective-c': 'm',
	'objective-cpp': 'mm',
	dockerfile: 'dockerfile',
	plaintext: 'txt',
};

/**
 * Widest the main pane is grown to when a preview opens, in CSS px.
 *
 * The pane targets a third of `screen.availWidth`, capped here: on a wide or
 * high-resolution display a literal third is far more pane than the preview
 * needs, and the code area stops gaining anything past this width.
 *
 * @example
 * Math.min(availWidth / 3, MAX_PANE_WIDTH_PX);
 */
export const MAX_PANE_WIDTH_PX = 700;

/**
 * Minimum height of the preview's editable code area, in lines.
 *
 * A short artifact would otherwise render a two-line sliver that is awkward to
 * edit in. Applied as a CSS custom property rather than a hard-coded rule
 * (`code-block.css` reads `--mda-code-min-lines`), because a stylesheet cannot
 * import a constant and a second spelling of the number is exactly the drift
 * this repo keeps writing guard tests about.
 *
 * @example
 * `style="--mda-code-min-lines: ${CODE_BLOCK_MIN_LINES}"`
 */
export const CODE_BLOCK_MIN_LINES = 8;

// ── Variables pane: actions per row ──────────────────────────────────────────

/**
 * The categories a Variables-pane right-click menu is split into, in display
 * order. Each becomes a VS Code menu group (`<n>_<category>`), so they appear
 * as separated sections, top to bottom.
 */
export const VARIABLES_MENU_CATEGORIES = ['view', 'create', 'edit', 'apply', 'delete'] as const;

/** One Variables-pane menu category — see {@link VARIABLES_MENU_CATEGORIES}. */
export type VariablesMenuCategory = typeof VARIABLES_MENU_CATEGORIES[number];

/** What one kind of row offers: its inline icons (in order) and its right-click sections. */
export type VariablesRowActions = { inline: readonly string[] } & Record<VariablesMenuCategory, readonly string[]>;

/**
 * **THE rules for what each Variables-pane row can do** — the single source for
 * which actions a set, a sub-set or a variable offers, per file shape.
 *
 * Keyed by the row's `contextValue` (`variablesView.provider.ts`'s
 * `VARIABLE_CONTEXT_VALUES`; a file row's value is its shape — see
 * `getVarsFileShape`). Values are `md-artifacts.variables.<suffix>` command
 * suffixes. `package.json`'s `view/item/context` menus are the static mirror VS
 * Code reads before activation; `package-variables-menus.test.ts` rebuilds them
 * from this table and fails on any difference.
 *
 * The "create" rules follow the file shapes:
 * - `fileBlank` (header only) — either first step: a variable (one untitled
 *   block) or a sub-set. The inline `+` asks which (`addToBlank`).
 * - `fileFlat` (one untitled block) — add a variable; a new sub-set names the
 *   untitled block "Default" first (`addSubSet`).
 * - `fileSets` (titled sub-sets, even one) — add a sub-set; variables are
 *   added on the sub-set rows.
 *
 * @example
 * VARIABLES_ROW_ACTIONS.fileFlat.create // → ['addVar', 'newSubSet']
 */
export const VARIABLES_ROW_ACTIONS: Readonly<Record<'fileBlank' | 'fileFlat' | 'fileSets' | 'subset' | 'var', VariablesRowActions>> = {
    fileBlank: {
        inline: ['addToBlank', 'openFile', 'deleteFile'],
        view:   ['viewInfo'],
        create: ['addVar', 'newSubSet'],
        edit:   ['openFile', 'editDescription', 'editTags'],
        apply:  [],
        delete: ['deleteFile'],
    },
    fileFlat: {
        inline: ['addVar', 'openFile', 'deleteFile', 'applyToPreview', 'applyToEditor'],
        view:   ['viewInfo'],
        create: ['addVar', 'newSubSet'],
        edit:   ['openFile', 'editDescription', 'editTags'],
        apply:  ['applyToPreview', 'applyToEditor'],
        delete: ['deleteFile'],
    },
    fileSets: {
        inline: ['newSubSet', 'openFile', 'deleteFile'],
        view:   ['viewInfo'],
        create: ['newSubSet'],
        edit:   ['openFile', 'editDescription', 'editTags'],
        apply:  [],
        delete: ['deleteFile'],
    },
    subset: {
        inline: ['addVar', 'applyToPreview', 'applyToEditor'],
        view:   ['viewInfo'],
        create: ['addVar'],
        edit:   ['renameSubSet', 'editDescription'],
        apply:  ['applyToPreview', 'applyToEditor'],
        delete: ['deleteSubSet'],
    },
    var: {
        inline: ['editValue'],
        view:   ['viewInfo'],
        create: [],
        edit:   ['editValue', 'renameVar'],
        apply:  [],
        delete: ['deleteVar'],
    },
};

/**
 * Extra `when` conditions an **inline** icon carries: the apply icons show
 * only when there is something to apply to. Their right-click entries stay
 * unconditional (each command explains itself when invoked with no target).
 *
 * @example
 * VARIABLES_INLINE_WHEN.applyToPreview // → 'md-artifacts.previewActive'
 */
export const VARIABLES_INLINE_WHEN: Readonly<Record<string, string>> = {
    applyToPreview: 'md-artifacts.previewActive',
    applyToEditor:  'editorIsOpen',
};
