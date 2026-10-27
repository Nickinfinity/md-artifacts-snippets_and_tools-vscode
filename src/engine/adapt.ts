import * as path from 'node:path';
import type { EngineArtifact, EngineBlock, EngineVar, Layout, VarsFile } from '../types/engine.types.js';
import type { ParsedArtifactFile, ParsedBlock, ParsedVar } from '../types/parsed-artifact.types.js';
import type { ApplyChange, ApplyResult } from '../types/varset.types.js';
import { isPathWithin } from '../utils/path-containment.js';
import { EngineRequestError } from './request-error.js';

/**
 * Absolute path to vault-relative POSIX; `undefined` when outside the vault or the root itself.
 *
 * @param absPath - Absolute filesystem path.
 * @param vaultRoot - Absolute vault root.
 * @returns Vault-relative POSIX path, or `undefined`.
 * @example
 * toVaultPath('/v/Snippets/a.md', '/v'); // 'Snippets/a.md'
 */
export function toVaultPath(absPath: string, vaultRoot: string): string | undefined {
    if (!isPathWithin(vaultRoot, absPath)) { return undefined; }
    const rel = path.relative(path.resolve(vaultRoot), path.resolve(absPath));
    return rel === '' ? undefined : rel.split(path.sep).join('/');
}

/**
 * Engine vault-relative path to absolute; throws when it escapes the vault.
 *
 * @param rel - Vault-relative POSIX path from the engine (untrusted).
 * @param vaultRoot - Absolute vault root.
 * @returns Absolute path inside the vault.
 * @example
 * resolveInVault('Snippets/a.md', '/v'); // '/v/Snippets/a.md'
 */
export function resolveInVault(rel: string, vaultRoot: string): string {
    const abs = path.resolve(vaultRoot, ...rel.split('/'));
    if (toVaultPath(abs, vaultRoot) !== rel) {
        throw new EngineRequestError({ code: 'client.protocol', params: { path: rel } });
    }
    return abs;
}

// ponytail: structured `value` dropped here; W6 carries it through.
const mapVars = (vars: readonly EngineVar[]): ParsedVar[] =>
    vars.map(v => ({ name: v.name, defaultValue: v.defaultValue }));

const mapBlock = (b: EngineBlock): ParsedBlock => ({
    heading: b.heading, description: b.description, code: b.code,
    ...(b.fenceLang === undefined ? {} : { fenceLang: b.fenceLang }), vars: mapVars(b.vars),
});

/**
 * An engine read as the extension's parsed shape; keeps vault-relative path, hash and layout.
 *
 * @param a - The `artifact.read` result (untrusted).
 * @param vaultRoot - Absolute vault root.
 * @returns Parsed file with absolute `filePath`.
 * @example
 * toParsedArtifactFile(read, '/v').relPath; // 'Snippets/hello.md'
 */
export function toParsedArtifactFile(a: EngineArtifact, vaultRoot: string):
    ParsedArtifactFile & { readonly relPath: string; readonly hash: string; readonly layout?: Layout } {
    const filePath = resolveInVault(a.filePath, vaultRoot);
    return {
        filePath, fileName: a.fileName, relativePath: a.relativePath, frontmatter: a.frontmatter,
        code: a.code, vars: mapVars(a.vars), blocks: a.blocks.map(mapBlock),
        relPath: a.filePath, hash: a.hash, ...(a.layout === undefined ? {} : { layout: a.layout }),
    };
}

/**
 * A Variables listing entry as a parsed file.
 *
 * @param f - The `vars.list` entry (untrusted).
 * @param vaultRoot - Absolute vault root.
 * @returns Parsed file; `error` set when the file is broken.
 * @example
 * varsFileToParsed(f, '/v').frontmatter.artifactType; // 'Variables'
 */
export function varsFileToParsed(f: VarsFile, vaultRoot: string):
    ParsedArtifactFile & { readonly relPath: string; readonly error?: string } {
    const filePath = resolveInVault(f.path, vaultRoot);
    const error = f.error?.code ?? f.varsError?.code;
    const sets = f.shape === 'sets';
    return {
        filePath, fileName: f.name, relativePath: f.path.slice(f.path.indexOf('/') + 1),
        frontmatter: {
            artifactType: 'Variables',
            ...(f.title === undefined ? {} : { title: f.title }),
            ...(f.description === undefined ? {} : { description: f.description }),
            ...(f.tags === undefined ? {} : { tags: [...f.tags] }),
        },
        code: '',
        vars: f.shape === 'flat' ? mapVars(f.subsets[0]?.vars ?? []) : [],
        blocks: sets ? f.subsets.map(s => ({
            heading: s.heading, description: s.description, code: '', fenceLang: 'yaml VKs', vars: mapVars(s.vars),
        })) : [],
        relPath: f.path, ...(error === undefined ? {} : { error }),
    };
}

const APPLY_ACTIONS: readonly string[] = ['filled', 'overridden', 'kept'] satisfies readonly ApplyChange['action'][];
const isAction = (a: unknown): a is ApplyChange['action'] => typeof a === 'string' && APPLY_ACTIONS.includes(a);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A `varsets.apply` reply as the diff renderer's `ApplyResult`. The reply is engine stdout, so
 * the shape is checked here: a malformed envelope throws `client.protocol`; a row with a non-string
 * `name` / `newValue` or an unknown `action` is dropped (rejected, never sanitised — `action` becomes
 * a CSS class). Structured values are dropped too, so diff, `values` and badge names agree.
 *
 * @param r - The engine reply (untrusted).
 * @returns Strings-only result; a non-string `oldValue` becomes `''`.
 * @throws EngineRequestError `client.protocol` when `changes` / `values` have the wrong shape.
 * @example
 * toApplyResult({ changes: [], values: {} }); // { changes: [], values: {} }
 */
export function toApplyResult(r: unknown): ApplyResult {
    // ponytail: structured values dropped until the W6 table editor.
    if (!isRecord(r) || !Array.isArray(r.changes) || !isRecord(r.values)) {
        throw new EngineRequestError({ code: 'client.protocol', params: {} });
    }
    const changes = r.changes.flatMap((c: unknown): ApplyChange[] =>
        isRecord(c) && typeof c.name === 'string' && typeof c.newValue === 'string'
            && isAction(c.action)
            ? [{ name: c.name, action: c.action, newValue: c.newValue, oldValue: typeof c.oldValue === 'string' ? c.oldValue : '' }]
            : []);
    const values = Object.fromEntries(Object.entries(r.values).filter((e): e is [string, string] => typeof e[1] === 'string'));
    return { changes, values };
}
