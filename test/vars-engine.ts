import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { startEngine } from '../src/engine/engine.vscode.js';
import { setConfirmSink } from '../src/services/confirm.service.js';
import { setSessionVault } from '../src/services/vault-watch.service.js';
import { parseFromContent } from '../src/services/parser.service.js';
import type { EngineArtifact } from '../src/types/engine.types.js';

/** Vault root every Variables command test points its handlers at; nothing is read from disk. */
export const VAULT = vscode.Uri.file('/v');

/** A fake engine serving `artifact.read` for registered files, plus the sinks tests assert on. */
export interface VarsEngine {
    readonly fake: FakeEngine;
    /** Registers `content` at vault-relative `rel`; returns its absolute path (what a tree node id carries). */
    serve(rel: string, content: string): string;
    /** The hash `serve` gave `content` — what the engine would be sent as `expectedHash`. */
    hashOf(content: string): string;
    /** Requests the fake received for `method`. */
    calls(method: string): { params: unknown }[];
    readonly toasts: string[];
    readonly modals: string[];
    dispose(): void;
}

/**
 * Starts a fake engine wired as the session engine (call in `setup`, `dispose` in `teardown`).
 *
 * @param confirmAnswer - What the shared modal sink answers (default accept).
 * @returns The harness.
 * @example
 * const eng = startVarsEngine();
 * const file = eng.serve('Variables/a.md', md);
 */
export function startVarsEngine(confirmAnswer = true): VarsEngine {
    const fake = createFakeEngine();
    const files = new Map<string, EngineArtifact>();
    const toasts: string[] = [], modals: string[] = [];
    const handle = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: m => { toasts.push(m); return Promise.resolve(undefined); } });
    setSessionVault(VAULT.fsPath);
    setConfirmSink(async o => { modals.push(o.message); return confirmAnswer; });
    fake.on('artifact.read', p => {
        const hit = files.get((p as { path: string }).path);
        return hit ? { result: hit } : { error: { code: 'artifact.not_found', params: { path: (p as { path: string }).path } } };
    });
    const hashOf = (c: string): string => createHash('sha256').update(c).digest('hex');
    for (const m of ['vars.meta.tags', 'vars.subset.add', 'vars.subset.rename', 'vars.subset.describe', 'vars.subset.delete',
        'vars.var.add', 'vars.var.rename', 'vars.var.set', 'vars.var.delete']) {
        fake.on(m, p => ({ result: { path: (p as { path: string }).path, hash: 'after' } }));
    }
    fake.on('artifact.delete', p => ({ result: { path: (p as { path: string }).path } }));
    return {
        fake, hashOf, toasts, modals,
        calls: m => fake.received.filter(r => r.method === m),
        serve(rel, content) {
            const abs = path.posix.join(VAULT.fsPath, rel);
            const p = parseFromContent(content, abs, path.posix.dirname(abs));
            files.set(rel, {
                filePath: rel, fileName: p.fileName, relativePath: rel.split('/').slice(1).join('/'),
                frontmatter: p.frontmatter, code: p.code, vars: p.vars,
                blocks: p.blocks.map(b => ({ heading: b.heading, description: b.description, code: b.code, vars: b.vars, ...(b.fenceLang === undefined ? {} : { fenceLang: b.fenceLang }) })),
                hash: hashOf(content),
            });
            return abs;
        },
        dispose() { setConfirmSink(undefined); setSessionVault(undefined); handle.dispose(); },
    };
}

/**
 * Registers `setup`/`teardown` for a fake engine inside the calling suite.
 *
 * @returns Getter for the current test's harness.
 * @example
 * suite('x', () => { const eng = useVarsEngine(); test('y', () => { eng().serve(...); }); });
 */
export function useVarsEngine(confirmAnswer = true): () => VarsEngine {
    let e: VarsEngine | undefined;
    setup(() => { e = startVarsEngine(confirmAnswer); });
    teardown(() => { e?.dispose(); e = undefined; });
    return () => { if (!e) { throw new Error('engine not started'); } return e; };
}
