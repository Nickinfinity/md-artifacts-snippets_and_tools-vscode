import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngineArtifact } from '../src/types/engine.types.js';

/** Where the engine recordings live (written by `test/fixtures/engine/recorded/record.mjs`). */
const DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'engine', 'recorded');

/**
 * The exact bytes of a recorded source — what a test serves or parses.
 *
 * @param name - Recording name (`sources.json` / the README names table).
 * @returns The file's bytes, verbatim.
 * @example
 * eng.serve('Variables/flat.md', recordedSource('vars-flat'));
 */
export function recordedSource(name: string): string {
    return fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
}

/**
 * The pinned engine's `artifact.read` reply for a recorded source.
 *
 * @param name - Recording name.
 * @returns The engine artifact, as the engine sent it (paths vault-relative).
 * @example
 * const parsed = toParsedArtifactFile(recordedRead('edit-1'), '/v');
 */
export function recordedRead(name: string): EngineArtifact {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.read.json`), 'utf8')) as EngineArtifact;
}

/**
 * Every recorded `artifact.read` reply, keyed by its content hash — the lookup a fake
 * engine uses to answer a read for bytes a test served.
 *
 * @returns Hash → recorded read.
 * @example
 * const hit = recordedReadsByHash().get(sha256(content));
 */
export function recordedReadsByHash(): Map<string, EngineArtifact> {
    const out = new Map<string, EngineArtifact>();
    for (const f of fs.readdirSync(DIR).filter(n => n.endsWith('.read.json'))) {
        const read = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as EngineArtifact;
        out.set(read.hash, read);
    }
    return out;
}

/**
 * The pinned engine's `vars.list` reply over every recorded source.
 *
 * @returns The raw reply (`{ files: [...] }`), entries matched by `path`.
 * @example
 * const shapes = (recordedVarsList() as { files: { path: string; shape: string }[] }).files;
 */
export function recordedVarsList(): unknown {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'vars-list.json'), 'utf8'));
}
