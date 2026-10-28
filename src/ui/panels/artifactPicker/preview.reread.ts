import type { BlockRef } from './preview.types.js';
import { getEngine } from '../../../engine/engine.vscode.js';
import { toParsedArtifactFile } from '../../../engine/adapt.js';
import { getVaultPath } from '../../../services/config.service.js';
import type { ParsedArtifactFile } from '../../../types/parsed-artifact.types.js';
// Import cycle with preview.helpers.ts (it imports `rereadBlock` from here): safe — both sides use only functions, at call time.
import { blockAsArtifact } from './preview.helpers.js';

/** A fresh engine read shaped for the preview. */
export interface RereadBlock {
    /** The whole file (what the navigator cache holds). */
    readonly file: ParsedArtifactFile;
    /** Index of the previewed block (0 for a single-block file). */
    readonly index: number;
    /** What the preview shows: the file itself, or the block re-adapted. */
    readonly current: ParsedArtifactFile;
}

/**
 * Re-reads `relPath` from the engine, adapted for the preview.
 *
 * @param relPath - Vault-relative POSIX path.
 * @param ref - Which block the preview shows.
 * @returns The fresh read; `undefined` if a multi block's heading is gone.
 * @example
 * const r = await rereadBlock('Snippets/a.md', { kind: 'single' });
 */
export async function rereadBlock(relPath: string, ref: BlockRef): Promise<RereadBlock | undefined> {
    const read = await getEngine().request('artifact.read', { path: relPath });
    const file = toParsedArtifactFile(read, getVaultPath());
    if (ref.kind === 'single') { return { file, index: 0, current: file }; }
    const index = read.blocks.findIndex(b => b.heading === ref.heading), block = file.blocks[index];
    return block ? { file, index, current: blockAsArtifact(block, file) } : undefined;
}
