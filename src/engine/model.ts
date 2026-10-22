import type { EngineModel, Layout, ModelBlock } from '../types/engine.types.js';
import type { ArtifactFormBlock, ArtifactFormModel } from '../types/artifact-form.types.js';
import type { ParsedArtifactFile, ParsedFrontmatter } from '../types/parsed-artifact.types.js';
import type { toParsedArtifactFile } from './adapt.js';

/**
 * An engine read as the extension holds it (carries `relPath`, `hash`, `layout`).
 *
 * @example
 * const r: EngineRead = toParsedArtifactFile(read, '/v');
 */
export type EngineRead = ReturnType<typeof toParsedArtifactFile>;

/**
 * Engine meta (path, hash, layout) of a file that came from the engine; `undefined` for a TS-parsed one.
 *
 * @param a - Parsed file, possibly carrying engine fields at runtime.
 * @returns The meta, or `undefined`.
 * @example
 * engineMeta(toParsedArtifactFile(read, '/v'))?.hash;
 */
export function engineMeta(a: ParsedArtifactFile):
    { readonly relPath: string; readonly hash: string; readonly layout?: Layout } | undefined {
    if (!('relPath' in a) || !('hash' in a) || typeof a.relPath !== 'string' || typeof a.hash !== 'string') { return undefined; }
    const layout = 'layout' in a ? (a as EngineRead).layout : undefined; // guarded above; layout is optional
    return { relPath: a.relPath, hash: a.hash, ...(layout === undefined ? {} : { layout }) };
}

const toBlock = (b: ArtifactFormBlock): ModelBlock => ({
    heading: b.heading, description: b.description, language: b.language, code: b.code,
    vars: b.vars.map(v => ({ name: v.name, value: v.defaultValue })),
});

/**
 * Form model to the engine write model; a save of a read file passes `read` so
 * `layout`, `index` and `paths` survive (dropping `index` silently un-indexes the file).
 *
 * @param m - Form model.
 * @param read - The read being saved over, if any.
 * @returns Model for `artifact.create` / `artifact.update`.
 * @example
 * toEngineModel(form, { frontmatter: { index: true } }).index; // true
 */
export function toEngineModel(m: ArtifactFormModel,
    read?: { readonly layout?: Layout; readonly frontmatter: Pick<ParsedFrontmatter, 'index' | 'paths'> }): EngineModel {
    return {
        artifactType: m.artifactType, title: m.title, description: m.description, tags: m.tags,
        extension: m.extension, target: m.target, env: m.env, provider: m.provider, model: m.model, version: m.version,
        blocks: m.blocks.map(toBlock),
        ...(read?.layout === undefined ? {} : { layout: read.layout }),
        ...(read?.frontmatter.index === undefined ? {} : { index: read.frontmatter.index }),
        ...(read?.frontmatter.paths === undefined ? {} : { paths: read.frontmatter.paths }),
    };
}

/**
 * Engine model (e.g. `artifact.prefill`) to a form prefill.
 *
 * @param m - Engine model (untrusted shape already guarded by the caller).
 * @returns Partial form model.
 * @example
 * fromEngineModel(prefill).blocks?.[0]?.language; // 'tsx'
 */
export function fromEngineModel(m: EngineModel): Partial<ArtifactFormModel> {
    return {
        artifactType: m.artifactType, title: m.title ?? '', description: m.description ?? '', tags: [...(m.tags ?? [])],
        extension: m.extension ?? '', target: m.target ?? '', env: m.env ?? '',
        provider: m.provider ?? '', model: m.model ?? '', version: m.version ?? '',
        blocks: (m.blocks ?? []).map(b => ({
            heading: b.heading ?? '', description: b.description ?? '', language: b.language ?? '', code: b.code ?? '',
            // ponytail: structured `value` dropped to ''; W6 carries it (same rule as adapt.ts).
            vars: (b.vars ?? []).map(v => ({ name: v.name, defaultValue: typeof v.value === 'string' ? v.value : '' })),
        })),
    };
}
