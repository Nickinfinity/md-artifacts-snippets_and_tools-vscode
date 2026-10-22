import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { engineErrorMessage } from '../src/engine/errors.js';
import { out } from '../src/ui/panels/artifactPicker/shared.js';
import { engineMeta } from '../src/engine/model.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { parseArtifactFile } from '../src/services/parser.service.js';
import { MultiIndexRunner } from '../src/ui/panels/artifactPicker/multiIndex.js';
import type { MultiIndexCallbacks } from '../src/ui/panels/artifactPicker/multiIndex.js';
import type { BatchOutcome, DestCandidate, IndexStep } from '../src/types/multi-index.types.js';
import type { ParsedArtifactFile } from '../src/types/parsed-artifact.types.js';
import type { EngineArtifact } from '../src/types/engine.types.js';

/**
 * T6 — `MultiIndexRunner`, driven entirely through its callback bag: a
 * stubbed `chooseDestination` (returns the first candidate, i.e. the mirrored
 * folder) and a stubbed `previewStep` (returns `written` with fixed vars, or
 * whatever outcome a given scenario needs). No extension-host UI interaction
 * is required — that's exactly why the callback bag exists.
 *
 * The vault side is real, read-only fixtures under `test/fixtures/multi-index/`
 * (mirroring the exact link set `multi-index.service.test.ts`'s `buildIndexPlan`
 * suite already exercises); the workspace side is a fresh temp directory per
 * test, cleaned up in `teardown`.
 */

const FIXTURE_DIR = path.join(__dirname, '../../test/fixtures/multi-index');

/** The index as the navigator hands it over: parsed, carrying the engine's `relPath` / `hash`. */
function readIndexArtifact(fileName: string): ParsedArtifactFile {
    const parsed = parseArtifactFile(path.join(FIXTURE_DIR, fileName), FIXTURE_DIR);
    assert.ok(parsed, `fixture ${fileName} must parse`);
    return { ...parsed, relPath: `Templates/${fileName}`, hash: 'h-index' } as ParsedArtifactFile;
}

const STEPS = [
    { raw: 'dir_2/subdir1/Button', relPath: 'dir_2/subdir1/Button.md', relDir: 'dir_2/subdir1', candidates: ['dir_2/subdir1', 'src/components'], def: 'javascript' },
    { raw: 'dir_2/subdir1/Button.test.md', relPath: 'dir_2/subdir1/Button.test.md', relDir: 'dir_2/subdir1', candidates: ['dir_2/subdir1'], def: 'python' },
    { raw: 'dir_1/barrel', relPath: 'dir_1/barrel.md', relDir: 'dir_1', candidates: ['dir_1'], def: 'ruby' },
];

/** An `artifact.read` reply for a Template whose only var is `VK-language`. */
function readReply(rel: string, def: string): EngineArtifact {
    return {
        filePath: rel, fileName: path.posix.basename(rel, '.md'), relativePath: rel.split('/').slice(1).join('/'),
        frontmatter: { artifactType: 'Template' }, code: 'x <VK-language>',
        vars: [{ name: 'VK-language', defaultValue: def }], blocks: [], hash: `h-${rel}`,
    } as EngineArtifact;
}

/** Fake engine serving `index.plan` (the given reply) and `artifact.read` for the three steps. */
function startFake(plan: unknown = { steps: STEPS, rejected: [] }): { fake: FakeEngine; dispose: () => void } {
    const fake = createFakeEngine();
    const handle = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: () => Promise.resolve(undefined) });
    setSessionVault('/v');
    fake.on('index.plan', () => ({ result: plan }));
    fake.on('artifact.read', p => {
        const rel = (p as { path: string }).path;
        const hit = STEPS.find(st => `Templates/${st.relPath}` === rel) ?? { def: 'x' };
        return { result: readReply(rel, hit.def) };
    });
    return { fake, dispose: () => { setSessionVault(undefined); handle.dispose(); } };
}

function makeWorkspaceRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'multi-index-runner-test-'));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

/** `chooseDestination` stub — always picks the mirrored (first) candidate. */
function firstCandidateChooser(workspaceRoot: vscode.Uri): MultiIndexCallbacks['chooseDestination'] {
    return async (_step: IndexStep, candidates: readonly DestCandidate[]) => vscode.Uri.joinPath(workspaceRoot, candidates[0].relPath);
}

/** Records every `previewStep` invocation; the runner, not the stub, is what these tests observe. */
class PreviewStepRecorder {
    calls: { artifact: ParsedArtifactFile; destDir: vscode.Uri }[] = [];
    /** Per-call override, keyed by call index (0-based); default is `written`. */
    outcomes = new Map<number, BatchOutcome['kind']>();

    readonly previewStep: MultiIndexCallbacks['previewStep'] = async (artifact, destDir) => {
        const callIndex = this.calls.length;
        this.calls.push({ artifact, destDir });
        const kind = this.outcomes.get(callIndex) ?? 'written';
        if (kind !== 'written') { return { kind }; }
        return { kind: 'written', vars: { 'VK-language': 'java' }, filePath: path.join(destDir.fsPath, 'out') };
    };
}

function makeCallbacks(overrides: Partial<MultiIndexCallbacks> & { workspaceRoot: vscode.Uri }): MultiIndexCallbacks {
    return {
        indexDirUri: vscode.Uri.file(FIXTURE_DIR),
        clickedRelPath: '',
        vaultRootFs: FIXTURE_DIR,
        chooseDestination: firstCandidateChooser(overrides.workspaceRoot),
        previewStep: async () => ({ kind: 'skipped' }),
        closePicker: () => { /* no-op default */ },
        disposePreview: () => { /* no-op default */ },
        ...overrides,
    };
}

/** Starts the fake engine for a suite (setup) and tears it down. */
function useFake(plan?: unknown): () => { fake: FakeEngine } {
    let f: ReturnType<typeof startFake> | undefined;
    setup(() => { f = startFake(plan); });
    teardown(() => { f?.dispose(); f = undefined; });
    return () => { assert.ok(f); return f; };
}

// ── Plan comes from the engine ───────────────────────────────────────────────

suite('MultiIndexRunner — index.plan', () => {

    const ok = JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/engine/op-cases/index.plan/ok.json'), 'utf8')).expect;
    const eng = useFake(ok);
    let workspaceDir: string;
    setup(() => { workspaceDir = makeWorkspaceRoot(); });
    teardown(() => { fs.rmSync(workspaceDir, { recursive: true, force: true }); });

    test('index.plan/ok: the 3 non-skipped steps reach previewStep; sub/snip and sub/nested-index never do', async () => {
        const recorder = new PreviewStepRecorder();
        const cb = makeCallbacks({ workspaceRoot: vscode.Uri.file(workspaceDir), previewStep: recorder.previewStep });

        await new MultiIndexRunner(cb).run(readIndexArtifact('index.md'));

        assert.deepStrictEqual(recorder.calls.map(c => engineMeta(c.artifact)?.relPath), ['Templates/edit.md', 'Templates/sub/widget.md', 'Templates/edit.md']);
        const reads = eng().fake.received.filter(r => r.method === 'artifact.read').map(r => (r.params as { path: string }).path);
        assert.ok(!reads.some(r => r.includes('snip') || r.includes('nested-index')), 'skipped steps are never read');
        const plan = eng().fake.received.find(r => r.method === 'index.plan');
        assert.deepStrictEqual(plan?.params, { path: 'Templates/index.md', mirrorFrom: '' });
    });
});

// ── Full run — success path ──────────────────────────────────────────────────

suite('MultiIndexRunner — run (success)', () => {

    useFake();
    let workspaceDir: string;

    setup(() => { workspaceDir = makeWorkspaceRoot(); });
    teardown(() => { fs.rmSync(workspaceDir, { recursive: true, force: true }); });

    test('previewStep receives the chosen dir for each step; the runner itself creates nothing', async () => {
        const workspaceRoot = vscode.Uri.file(workspaceDir);
        const recorder = new PreviewStepRecorder();
        let closed = 0;
        let disposed = 0;
        const cb = makeCallbacks({
            workspaceRoot,
            previewStep: recorder.previewStep,
            closePicker: () => { closed++; },
            disposePreview: () => { disposed++; },
        });

        await new MultiIndexRunner(cb).run(readIndexArtifact('index.md'));

        assert.deepStrictEqual(recorder.calls.map(c => c.destDir.fsPath),
            ['dir_2/subdir1', 'dir_2/subdir1', 'dir_1'].map(d => path.join(workspaceDir, d)));
        assert.deepStrictEqual(fs.readdirSync(workspaceDir), [], 'no folder chain is created by the runner');
        assert.strictEqual(closed, 1, 'closePicker must fire exactly once');
        assert.strictEqual(disposed, 1, 'disposePreview must fire exactly once');
    });

    test('candidates map to DestCandidate: first is the mirror, rest come from the index', async () => {
        const seen: (readonly DestCandidate[])[] = [];
        const cb = makeCallbacks({
            workspaceRoot: vscode.Uri.file(workspaceDir),
            chooseDestination: async (_s, c) => { seen.push(c); return undefined; },
        });

        await new MultiIndexRunner(cb).run(readIndexArtifact('index.md'));

        assert.deepStrictEqual(seen[0].map(c => [c.relPath, c.label]), [['dir_2/subdir1', 'dir_2/subdir1'], ['src/components', 'src/components']]);
        assert.notStrictEqual(seen[0][0].detail, seen[0][1].detail);
    });

    test('carry-over reaches step 2: its VK-language default equals step 1\'s submitted value', async () => {
        const recorder = new PreviewStepRecorder();
        const cb = makeCallbacks({ workspaceRoot: vscode.Uri.file(workspaceDir), previewStep: recorder.previewStep });

        await new MultiIndexRunner(cb).run(readIndexArtifact('index.md'));

        const step1Vars = recorder.calls[0].artifact.vars;
        assert.strictEqual(step1Vars.find(v => v.name === 'VK-language')?.defaultValue, 'javascript', 'step 1 keeps its own default (empty carry)');

        const step2Vars = recorder.calls[1].artifact.vars;
        assert.strictEqual(step2Vars.find(v => v.name === 'VK-language')?.defaultValue, 'java', 'step 2 must see step 1\'s submitted value, not its own "python" default');
    });
});

// ── Skip / abort semantics ───────────────────────────────────────────────────

suite('MultiIndexRunner — run (skip / abort)', () => {

    useFake();
    let workspaceDir: string;

    setup(() => { workspaceDir = makeWorkspaceRoot(); });
    teardown(() => { fs.rmSync(workspaceDir, { recursive: true, force: true }); });

    test('a skipped outcome on step 2 leaves step 3 running', async () => {
        const recorder = new PreviewStepRecorder();
        recorder.outcomes.set(1, 'skipped');
        const cb = makeCallbacks({ workspaceRoot: vscode.Uri.file(workspaceDir), previewStep: recorder.previewStep });

        await new MultiIndexRunner(cb).run(readIndexArtifact('index.md'));

        assert.strictEqual(recorder.calls.length, 3, 'step 3 must still be attempted after a skip');
    });

    test('an aborted outcome on step 2 means step 3 never runs', async () => {
        const recorder = new PreviewStepRecorder();
        recorder.outcomes.set(1, 'aborted');
        const cb = makeCallbacks({ workspaceRoot: vscode.Uri.file(workspaceDir), previewStep: recorder.previewStep });

        await new MultiIndexRunner(cb).run(readIndexArtifact('index.md'));

        assert.strictEqual(recorder.calls.length, 2, 'step 3 must never be attempted once aborted');
    });
});

// ── Security — workspace containment (§e), before previewStep ───────────────

suite('MultiIndexRunner — workspace containment', () => {

    useFake();
    let workspaceDir: string;
    let outsideDir: string;

    setup(() => {
        workspaceDir = makeWorkspaceRoot();
        outsideDir   = makeWorkspaceRoot();  // a wholly separate temp dir — never inside workspaceRoot
    });
    teardown(() => {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    test('a chooseDestination result outside the workspace never reaches previewStep; the run continues', async () => {
        const workspaceRoot = vscode.Uri.file(workspaceDir);
        const outside        = vscode.Uri.file(outsideDir);
        const recorder = new PreviewStepRecorder();

        let call = 0;
        const cb = makeCallbacks({
            workspaceRoot,
            chooseDestination: async (_step, candidates) => {
                const destDir = call === 0 ? outside : vscode.Uri.joinPath(workspaceRoot, candidates[0].relPath);
                call++;
                return destDir;
            },
            previewStep: recorder.previewStep,
        });

        await new MultiIndexRunner(cb).run(readIndexArtifact('index.md'));

        assert.deepStrictEqual(fs.readdirSync(outsideDir), [], 'nothing must be created outside the workspace root');
        assert.strictEqual(recorder.calls.length, 2, 'only the two steps with an in-workspace destination reach previewStep');
        assert.ok(recorder.calls.every(c => c.destDir.fsPath.startsWith(workspaceDir)));
    });
});

// ── Security — hostile destination: nothing is created before the engine decides ──

suite('MultiIndexRunner — hostile name', () => {

    useFake();
    let workspaceDir: string;

    setup(() => { workspaceDir = makeWorkspaceRoot(); });
    teardown(() => { fs.rmSync(workspaceDir, { recursive: true, force: true }); });

    test('previewStep ending in naming.path_injection leaves the chosen dest dir uncreated', async () => {
        const hostile: MultiIndexCallbacks['previewStep'] = async () => ({ kind: 'skipped' }); // runCreateFileFlow maps the engine error to cancelled -> skipped
        const cb = makeCallbacks({ workspaceRoot: vscode.Uri.file(workspaceDir), previewStep: hostile });

        await new MultiIndexRunner(cb).run(readIndexArtifact('index.md'));

        assert.deepStrictEqual(fs.readdirSync(workspaceDir), [], 'workspace listing unchanged: no createDirectory ran');
    });
});

// ── Rejected index entries ───────────────────────────────────────────────────

suite('MultiIndexRunner — rejected entries', () => {

    useFake({ steps: [STEPS[0]], rejected: [{ raw: '../../etc/passwd', code: 'path.parent_segment' }, { raw: '/etc/passwd', code: 'path.absolute' }] });
    let workspaceDir: string;

    setup(() => { workspaceDir = makeWorkspaceRoot(); });
    teardown(() => { fs.rmSync(workspaceDir, { recursive: true, force: true }); });

    test('rejected links never reach previewStep; only the legitimate step does', async () => {
        const recorder = new PreviewStepRecorder();
        const cb = makeCallbacks({ workspaceRoot: vscode.Uri.file(workspaceDir), previewStep: recorder.previewStep });

        await new MultiIndexRunner(cb).run(readIndexArtifact('hostile-index.md'));

        assert.strictEqual(recorder.calls.length, 1);
        assert.deepStrictEqual(fs.readdirSync(workspaceDir), []);
    });
});

// ── Engine errors reach the user as words, never bare codes ──────────────────

suite('MultiIndexRunner — engine error text', () => {

    const eng = useFake();
    let workspaceDir: string;
    setup(() => { workspaceDir = makeWorkspaceRoot(); });
    teardown(() => { fs.rmSync(workspaceDir, { recursive: true, force: true }); });

    test('an index.plan error is reported through engineErrorMessage, not the bare code', async () => {
        eng().fake.on('index.plan', () => ({ error: { code: 'vault.not_selected', params: {} } }));
        const lines: string[] = [];
        const orig = out.appendLine.bind(out);
        out.appendLine = (l: string) => { lines.push(l); };
        try {
            await new MultiIndexRunner(makeCallbacks({ workspaceRoot: vscode.Uri.file(workspaceDir) })).run(readIndexArtifact('index.md'));
        } finally { out.appendLine = orig; }
        const words = engineErrorMessage({ code: 'vault.not_selected', params: {} });
        assert.ok(lines.some(l => l.includes(words)), `expected "${words}" in ${JSON.stringify(lines)}`);
    });
});
