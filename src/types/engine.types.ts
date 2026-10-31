/**
 * Wire types for the `mda` engine (protocol 2.3, engine tag `v0.13.0`).
 *
 * Every shape here mirrors the engine's serde structs as specified in the
 * engine's `spec/PROTOCOL.md`; paths on the wire are vault-relative POSIX and
 * are converted only in `src/engine/adapt.ts`. Deliberately `vscode`-free
 * (`AGENTS.md`: no `vscode` imports in `src/types/`). Single-writer — workers
 * never edit this file.
 */
import type { ArtifactType, ParsedFrontmatter } from './parsed-artifact.types.js';

// ── Values ──────────────────────────────────────────────────────────────────

/**
 * A variable value: a string, a list, a list of records, or a record.
 *
 * @example
 * const v: VksValue = ['a', 'b'];
 */
export type VksValue = string | readonly string[] | readonly VksRecord[] | VksRecord;

/**
 * A structured record value — field name to nested value.
 *
 * @example
 * const r: VksRecord = { host: 'localhost', ports: ['80', '443'] };
 */
export interface VksRecord { readonly [field: string]: VksValue }

/**
 * Variable name → value, as sent to render and apply requests.
 *
 * @example
 * const values: Values = { 'VK-name': 'world' };
 */
export type Values = Readonly<Record<string, VksValue>>;

// ── Errors (engine codes and the client's own `client.*` codes) ─────────────

/**
 * An error as the engine reports it: a code and string params, never prose.
 *
 * @example
 * const e: EngineErrorData = { code: 'file.conflict', params: { path: 'Snippets/a.md', expected: 'x', actual: 'y' } };
 */
export interface EngineErrorData { readonly code: string; readonly params: Readonly<Record<string, string>> }

/**
 * Codes the client raises itself, beside the engine's own.
 *
 * @example
 * const c: ClientErrorCode = 'client.timeout';
 */
export type ClientErrorCode =
    | 'client.not_found' | 'client.invalid_path' | 'client.incompatible'
    | 'client.exited' | 'client.timeout' | 'client.protocol' | 'client.unavailable' | 'client.closed';

// ── The process seam (shared by the fake, the session, the supervisor and the edge) ──

/**
 * The two pipes the NDJSON session speaks over.
 *
 * @example
 * const s: EngineStreams = { stdin: new PassThrough(), stdout: new PassThrough() };
 */
export interface EngineStreams { readonly stdin: NodeJS.WritableStream; readonly stdout: NodeJS.ReadableStream }

/**
 * A running engine process — real (`child_process`) or the test fake.
 *
 * @example
 * proc.onExit(code => log(`engine exited (code ${code})`));
 */
export interface EngineProcess extends EngineStreams {
    readonly stderr: NodeJS.ReadableStream;
    kill(): void;
    onExit(handler: (code: number | null) => void): void;
}

/**
 * Starts an engine process from an absolute binary path and an argv array (never a shell string).
 *
 * @param binPath - Absolute path to `mda`.
 * @param args - Argument vector, e.g. `['serve']`.
 * @returns The started process.
 * @example
 * const proc = spawn('/usr/local/bin/mda', ['serve']);
 */
export type SpawnFn = (binPath: string, args: readonly string[]) => EngineProcess;

// ── Read shapes ─────────────────────────────────────────────────────────────

/**
 * A variable as read by the engine; `value` carries a structured default.
 *
 * @example
 * const v: EngineVar = { name: 'VK-greeting', defaultValue: 'hi' };
 */
export interface EngineVar { readonly name: string; readonly defaultValue: string; readonly value?: VksValue }

/**
 * One flagged region's layout, preserved so a save can round-trip it.
 *
 * @example
 * const r: RegionLayout = { name: 'Dev', rule: true };
 */
export interface RegionLayout { readonly name: string; readonly notes?: string; readonly rule?: boolean }

/**
 * How a file's payload was laid out on disk — copied into any save of that file.
 *
 * @example
 * const l: Layout = { payload: 'flags', regions: [{ name: 'Dev' }] };
 */
export interface Layout { readonly payload?: 'fence' | 'bare' | 'flags'; readonly regions?: readonly RegionLayout[]; readonly notes?: string }

/**
 * One `## ` section of a multi-block artifact.
 *
 * @example
 * const b: EngineBlock = { heading: 'Dev', description: '', code: 'npm test', vars: [] };
 */
export interface EngineBlock {
    readonly heading: string; readonly description: string; readonly code: string;
    readonly fenceLang?: string; readonly vars: readonly EngineVar[]; readonly varsError?: EngineErrorData;
}

/**
 * `artifact.read`'s result: the parsed file plus its content `hash` and `layout`.
 *
 * @example
 * const { hash, layout } = await engine.request('artifact.read', { path: 'Snippets/hello.md' });
 */
export interface EngineArtifact {
    readonly filePath: string; readonly fileName: string; readonly relativePath: string;
    readonly frontmatter: ParsedFrontmatter; readonly code: string;
    readonly vars: readonly EngineVar[]; readonly blocks: readonly EngineBlock[];
    readonly varsError?: EngineErrorData; readonly layout?: Layout; readonly hash: string;
}

/**
 * One file of an `artifact.tree` listing.
 *
 * @example
 * const f: TreeFile = { path: 'Snippets/hello.md', name: 'hello', title: 'Hello' };
 */
export interface TreeFile {
    readonly path: string; readonly name: string; readonly title?: string; readonly description?: string;
    readonly tags?: readonly string[]; readonly error?: { readonly code: string };
}

/**
 * The engine's registry entry for one artifact type, sent at handshake.
 *
 * @example
 * const t: TypeInfo = { type: 'Snippet', dir: 'Snippets', contexts: ['editor'], defaultEnabled: true, writesFile: false, multiBlock: true };
 */
export interface TypeInfo {
    readonly type: ArtifactType; readonly dir: string;
    readonly contexts: readonly ('editor' | 'terminal' | 'explorer' | 'all')[];
    readonly defaultEnabled: boolean; readonly writesFile: boolean;
    readonly outputNameKey?: 'target' | 'extension'; readonly multiBlock: boolean;
    readonly language?: { readonly mode: 'free' | 'locked' | 'hidden'; readonly default: string };
}

/**
 * Addresses a Variables sub-set by position, with its heading as a cross-check.
 *
 * @example
 * const ref: SubsetRef = { index: 0, heading: 'Default' };
 */
export interface SubsetRef { readonly index: number; readonly heading: string }

/**
 * One sub-set of a Variables file.
 *
 * @example
 * const s: Subset = { index: 0, heading: 'Dev', description: '', vars: [] };
 */
export interface Subset extends SubsetRef { readonly description: string; readonly vars: readonly EngineVar[]; readonly varsError?: EngineErrorData }

/**
 * One Variables file as `vars.list` / `vars.search` report it.
 *
 * @example
 * const f: VarsFile = { path: 'Variables/env.md', name: 'env.md', shape: 'flat', subsets: [] };
 */
export interface VarsFile {
    readonly path: string; readonly name: string; readonly title?: string; readonly description?: string;
    readonly tags?: readonly string[]; readonly shape?: 'blank' | 'flat' | 'sets';
    readonly subsets: readonly Subset[]; readonly varsError?: EngineErrorData; readonly error?: { readonly code: string };
}

/**
 * A non-fatal render diagnostic (`render.*` code).
 *
 * @example
 * const w: RenderWarning = { code: 'render.unknown_var', params: { line: '3', name: 'VK-x' } };
 */
export interface RenderWarning { readonly code: string; readonly params: { readonly line: string; readonly name?: string; readonly path?: string } }

/**
 * A render result; `containsEscape` flags terminal escape bytes in `output`.
 *
 * @example
 * const r: Rendered = { output: 'echo hi', warnings: [], containsEscape: false };
 */
export interface Rendered { readonly output: string; readonly warnings: readonly RenderWarning[]; readonly containsEscape: boolean }

/**
 * Result of any single-file write: where, and the new content hash.
 *
 * @example
 * const w: WriteResult = { path: 'Snippets/a.md', hash: 'abc' };
 */
export interface WriteResult { readonly path: string; readonly hash: string }

// ── Write model ─────────────────────────────────────────────────────────────

/**
 * One block of a write model.
 *
 * @example
 * const b: ModelBlock = { heading: 'Dev', language: 'bash', code: 'npm test' };
 */
export interface ModelBlock {
    readonly heading?: string; readonly description?: string; readonly language?: string; readonly code?: string;
    readonly vars?: readonly { readonly name: string; readonly value: VksValue }[];
}

/**
 * The model `artifact.create` / `artifact.update` serialise. A save of a read file
 * must copy the read's `layout` and `frontmatter.paths`.
 *
 * @example
 * const m: EngineModel = { artifactType: 'Snippet', title: 'Hello', blocks: [{ code: 'echo hi' }] };
 */
export interface EngineModel {
    readonly artifactType: ArtifactType; readonly title?: string; readonly description?: string;
    readonly tags?: readonly string[]; readonly extension?: string; readonly provider?: string;
    readonly model?: string; readonly version?: string; readonly env?: string; readonly target?: string;
    readonly index?: boolean; readonly paths?: readonly string[];
    readonly blocks?: readonly ModelBlock[]; readonly layout?: Layout;
}

// ── Batch results ───────────────────────────────────────────────────────────

/**
 * One step of an index run or index create.
 *
 * @example
 * const s: StepResult = { status: 'skipped', relPath: 'a.md', code: 'file.exists', params: { path: 'a.md' } };
 */
export type StepResult =
    | ({ readonly status: 'written'; readonly relPath: string; readonly path: string; readonly hash: string } & Omit<Rendered, 'output'>)
    | { readonly status: 'skipped'; readonly relPath: string; readonly code: string; readonly params: Readonly<Record<string, string>> };

/**
 * One file of a frontmatter migration apply.
 *
 * @example
 * const r: MigrateResult = { status: 'written', path: 'Snippets/a.md', hash: 'abc' };
 */
export type MigrateResult =
    | { readonly status: 'written'; readonly path: string; readonly hash: string }
    | { readonly status: 'skipped'; readonly path: string; readonly code: string; readonly params: Readonly<Record<string, string>> };

/**
 * A batch operation's per-item results plus totals.
 *
 * @example
 * const b: Batch<MigrateResult> = { results: [], written: 0, skipped: 0 };
 */
export interface Batch<R> { readonly results: readonly R[]; readonly written: number; readonly skipped: number }

// ── The method map: one row per engine op this extension calls ──────────────
type P<T> = Readonly<T>;
type VarsEdit<T> = P<{ path: string; expectedHash: string } & T>;

/**
 * Method name → params and result, for every engine op this extension calls.
 *
 * @example
 * type R = EngineOps['artifact.read']['result']; // EngineArtifact
 */
export interface EngineOps {
    'system.version':  { params: P<object>; result: { engine: string; protocol: string } };
    'config.get':      { params: P<object>; result: { vault?: string; source: 'flag' | 'default' | 'none'; configDir?: string; defaultError?: EngineErrorData } };
    'vault.inspect':   { params: P<{ path: string }>; result: { path: string; isObsidianVault: boolean; dirs: readonly { type: ArtifactType; dir: string; state: 'present' | 'missing' | 'blocked' }[]; missingDefaults: readonly ArtifactType[] } };
    'vault.select':    { params: P<{ path: string; createDefaults?: boolean }>; result: { path: string; created: readonly string[] } };
    'vault.list':      { params: P<object>; result: { default?: string; vaults: readonly { path: string; available: boolean }[] } };
    'vault.use':       { params: P<{ path: string }>; result: { path: string } };
    'types.list':      { params: P<object>; result: readonly { type: ArtifactType; dir: string; enabled: boolean; dirExists: boolean }[] };
    'types.set_enabled': { params: P<{ type: ArtifactType; enabled: boolean }>; result: { type: ArtifactType; enabled: boolean; created: boolean } };
    'artifact.tree':   { params: P<{ type: ArtifactType; dir?: string }>; result: { dirs: readonly string[]; files: readonly TreeFile[] } };
    'artifact.read':   { params: P<{ path: string }>; result: EngineArtifact };
    'artifact.create': { params: P<{ path: string; model: EngineModel }>; result: WriteResult };
    'artifact.update': { params: P<{ path: string; expectedHash: string; model: EngineModel }>; result: WriteResult };
    'artifact.patch':  { params: P<{ path: string; expectedHash: string; edit:
        | { field: 'title' | 'description'; value: string }
        | { field: 'code'; block?: number; heading?: string; code: string } }>; result: WriteResult };
    'artifact.delete': { params: P<{ path: string; expectedHash: string }>; result: { path: string } };
    'artifact.render': { params: P<{ path: string; block?: number; code?: string; values?: Values }>; result: Rendered };
    'artifact.write_file': { params: P<{ path: string; block?: number; values?: Values; workspaceRoot: string; destDir: string; fileName?: string; expectedHash?: string }>;
        result: { path: string; hash: string } & Omit<Rendered, 'output'> };
    /** Returns every string field present; `blocks[].vars` is never filled at v0.13.0 — W3 must not round-trip a vars array from it. */
    'artifact.prefill': { params: P<{ source: 'selection' | 'file' | 'terminal'; type: ArtifactType; text: string; languageId?: string; fileName?: string }>; result: EngineModel };
    'index.plan':      { params: P<{ path: string; mirrorFrom?: string }>; result: { steps: readonly { raw: string; relPath: string; relDir: string; candidates: readonly string[]; skip?: EngineErrorData }[]; rejected: readonly { raw: string; code: string }[] } };
    'index.run':       { params: P<{ path: string; workspaceRoot: string; steps: readonly { relPath: string; destDir: string; fileName?: string }[]; values?: Values }>; result: Batch<StepResult> };
    'index.create':    { params: P<{ type: 'Template' | 'AIAgentsConfig'; dir: string; paths: readonly string[] }>; result: Batch<StepResult> };
    'render.text':     { params: P<{ text: string; values?: Values }>; result: Rendered };
    'vars.list':       { params: P<object>; result: { files: readonly VarsFile[] } };
    'vars.search':     { params: P<{ query: string }>; result: { files: readonly VarsFile[] } };
    'vars.file.new':   { params: P<{ title: string; dir?: string; description?: string; tags?: readonly string[] }>; result: WriteResult };
    'vars.meta.tags':  { params: VarsEdit<{ tags: readonly string[] }>; result: WriteResult };
    'vars.subset.add': { params: VarsEdit<{ heading: string }>; result: WriteResult };
    'vars.subset.rename': { params: VarsEdit<{ subset: SubsetRef; heading: string }>; result: WriteResult };
    'vars.subset.describe': { params: VarsEdit<{ subset: SubsetRef; description: string }>; result: WriteResult };
    'vars.subset.delete': { params: VarsEdit<{ subset: SubsetRef }>; result: WriteResult };
    'vars.var.add':    { params: VarsEdit<{ subset?: SubsetRef; name: string; value?: VksValue }>; result: WriteResult };
    'vars.var.rename': { params: VarsEdit<{ subset?: SubsetRef; name: string; newName: string }>; result: WriteResult };
    'vars.var.set':    { params: VarsEdit<{ subset?: SubsetRef; name: string; value: VksValue }>; result: WriteResult };
    'vars.var.delete': { params: VarsEdit<{ subset?: SubsetRef; name: string }>; result: WriteResult };
    'varsets.match':   { params: P<{ path: string; block?: number }>; result: { artifactVars: readonly string[]; paths: readonly string[]; matches: readonly { pathIndex: number; subset: SubsetRef; label: string; score: number; matchRatio: number; tagMatches: number; matchedVars: readonly string[]; extraVars: readonly string[] }[] } };
    /** `oldValue` / `newValue` are `""` when absent. */
    'varsets.apply':   { params: P<{ path: string; subset?: SubsetRef; values?: Values }>; result: { values: Values; changes: readonly { name: string; oldValue: VksValue; newValue: VksValue; action: 'filled' | 'overridden' | 'kept' }[] } };
    'varsets.save':    { params: P<{ title: string; description?: string; tags?: readonly string[]; values?: Values; dir?: string }>; result: WriteResult };
    'migrate.frontmatter.plan':  { params: P<object>; result: { changes: readonly { path: string; hash: string; oldLine: string; newLine: string; artifactType: ArtifactType; normalises?: readonly ('bom' | 'encoding')[] }[]; skipped: readonly { path: string; code: string; params: Readonly<Record<string, string>> }[] } };
    'migrate.frontmatter.apply': { params: P<{ files: readonly { path: string; hash: string }[] }>; result: Batch<MigrateResult> };
}

/**
 * Any method name the client may send.
 *
 * @example
 * const m: EngineMethod = 'artifact.read';
 */
export type EngineMethod = keyof EngineOps;

/**
 * Params type for method `M`.
 *
 * @example
 * const p: EngineParams<'artifact.read'> = { path: 'Snippets/a.md' };
 */
export type EngineParams<M extends EngineMethod> = EngineOps[M]['params'];

/**
 * Result type for method `M`.
 *
 * @example
 * let r: EngineResult<'system.version'>; // { engine, protocol }
 */
export type EngineResult<M extends EngineMethod> = EngineOps[M]['result'];

/**
 * The `initialize` handshake reply.
 *
 * @example
 * const info: InitializeResult = { protocol: '2.3', engine: '0.13.0', types: [] };
 */
export interface InitializeResult { readonly protocol: string; readonly engine: string; readonly types: readonly TypeInfo[] }
