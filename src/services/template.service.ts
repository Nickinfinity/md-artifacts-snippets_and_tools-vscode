/**
 * Pure domain logic for **every** artifact-as-a-file flow — templates and agent
 * configs alike (`ARTIFACTS.writesFile`).
 *
 * Such an artifact is a whole file: invoking it writes its single code block to
 * disk with `<VK-xxx>` variables resolved. This module owns the pure decisions
 * that need no `vscode`:
 *  - `resolveOutputFileName`   — the per-type entry point callers use
 *  - `resolveTemplateFileName` — the D3 extension-precedence chain (template)
 *  - `resolveAgentFileName`    — `target:` used verbatim (agent)
 *
 * The two resolvers differ only in *where the name comes from*; every rule they
 * share (path-injection rejection, extension detection, trailing-dot trimming)
 * lives once in `template.service.helpers.ts`.
 *
 * All exports are `vscode`-free so they are unit-testable without an extension
 * host. Language↔extension mapping stays in `language-map.service.ts`.
 */
import { extForLang, normalizeLangId } from './language-map.service.js';
import { assertNoPathInjection, carriesExtension, stripTrailingDots } from './template.service.helpers.js';
import type { ParsedArtifactFile } from '../types/parsed-artifact.types.js';

/** Inputs to `resolveTemplateFileName`. All optional — precedence fills the gaps. */
export interface TemplateFileNameArgs {
    /** The name the user typed (may already carry its own extension). */
    typed?: string;
    /** Frontmatter `extension:` value, with or without a leading dot. */
    frontmatterExt?: string;
    /** Fence language id (`artifact.frontmatter.language`) — the last-resort source. */
    langId?: string;
    /** Base name to use when nothing is typed (e.g. the artifact title/fileName). */
    fallbackBase?: string;
}

// ── Exports ─────────────────────────────────────────────────────────────────────

/**
 * Resolves the output filename for **any** whole-file artifact, dispatching on
 * its type so callers never branch on a type literal themselves.
 *
 * `agent` routes to `resolveAgentFileName` (the `target:` key already *is* the
 * filename); every other whole-file type routes to `resolveTemplateFileName`
 * (D3 extension precedence). Both share the same fallback base — the artifact
 * title, else its vault file name — and both throw rather than sanitise a
 * hostile frontmatter value.
 *
 * @param artifact - The parsed artifact about to be written to the workspace.
 * @returns The default filename to seed the name prompt with.
 * @throws {Error} When `target:`/`extension:`/the fallback carries a path-injection char.
 *
 * @example
 * resolveOutputFileName(agentArtifact);    // → 'CLAUDE.md'   (from target:)
 * resolveOutputFileName(templateArtifact); // → 'Button.tsx'  (from extension:/language)
 */
export function resolveOutputFileName(artifact: ParsedArtifactFile): string {
    const fallbackBase = artifact.frontmatter.title || artifact.fileName;
    if (artifact.frontmatter.artifactType === 'AIAgentsConfig') {
        return resolveAgentFileName({ target: artifact.frontmatter.target, fallbackBase });
    }
    return resolveTemplateFileName({
        frontmatterExt: artifact.frontmatter.extension,
        langId:         artifact.frontmatter.language,
        fallbackBase,
    });
}

/**
 * Resolves the output filename for a template following D3 precedence:
 * **user-typed → frontmatter `extension:` → fence language**.
 *
 * A typed name that already carries an extension wins whole. Otherwise the base
 * comes from `typed` (or `fallbackBase`, or `'template'`) and the extension from
 * `frontmatterExt` (dot optional) or, last, `extForLang(normalizeLangId(langId))`.
 * `typed` and `frontmatterExt` are path-injection vectors and throw on a
 * separator / `..` / NUL rather than being sanitised (§5.2).
 *
 * @param args - Typed name, frontmatter extension, fence langId, fallback base.
 * @returns The resolved filename (e.g. `'Button.tsx'`).
 * @throws {Error} When `typed` or `frontmatterExt` carries a path-injection char.
 *
 * @example
 * resolveTemplateFileName({ typed: 'Button', langId: 'tsx' })            // 'Button.tsx'
 * resolveTemplateFileName({ typed: 'Button.jsx', frontmatterExt: 'mjs' }) // 'Button.jsx'
 * resolveTemplateFileName({ typed: 'Button', frontmatterExt: '.mjs' })    // 'Button.mjs'
 */
export function resolveTemplateFileName(args: TemplateFileNameArgs): string {
    const typed = args.typed?.trim() ?? '';
    const fmExt = args.frontmatterExt?.trim() ?? '';

    if (typed !== '') { assertNoPathInjection(typed, 'filename'); }
    if (fmExt !== '') { assertNoPathInjection(fmExt, 'extension'); }

    // ── A typed name with its own extension is authoritative ──────────────────
    if (typed !== '' && carriesExtension(typed)) {
        return typed;
    }

    // ── Compose base + resolved extension ─────────────────────────────────────
    const rawBase = typed !== '' ? typed : (args.fallbackBase?.trim() ?? '');
    const base = stripTrailingDots(rawBase) || 'template';

    const ext = resolveExtension(fmExt, args.langId);
    return ext !== '' ? `${base}.${ext}` : base;
}

/**
 * Resolves the output filename for an **agent** create-file flow.
 *
 * Unlike a template, an agent's `target:` frontmatter (`CLAUDE.md`, `.cursorrules`,
 * `AGENTS.md`) **is already the complete intended filename** — it must be used
 * verbatim, never routed through the extension-appending chain (which would turn a
 * dotfile like `.cursorrules` into `.cursorrules.md`). When `target` is absent the
 * name falls back to the title/fileName, defaulting to a `.md` extension since agent
 * configs are markdown. `target` and the fallback base are path-injection vectors
 * and **throw** on a separator / `..` / NUL rather than being sanitised.
 *
 * @param args - `target` (frontmatter, may be empty) and `fallbackBase` (title/fileName).
 * @returns The resolved filename.
 * @throws {Error} When `target` or the fallback base carries a path-injection char.
 *
 * @example
 * resolveAgentFileName({ target: 'CLAUDE.md' })              // 'CLAUDE.md'
 * resolveAgentFileName({ target: '.cursorrules' })           // '.cursorrules'
 * resolveAgentFileName({ target: '', fallbackBase: 'Claude reviewer' }) // 'Claude reviewer.md'
 */
export function resolveAgentFileName(args: { target?: string; fallbackBase?: string }): string {
    const target = args.target?.trim() ?? '';
    if (target !== '') {
        assertNoPathInjection(target, 'target');
        return target;
    }
    const base = stripTrailingDots(args.fallbackBase?.trim() ?? '') || 'agent';
    assertNoPathInjection(base, 'filename');
    return carriesExtension(base) ? base : `${base}.md`;
}

/**
 * Picks the extension: frontmatter value (leading dot stripped) if present, else
 * the fence language resolved through the language map. Returns `''` when no
 * source yields one — the caller then writes an extension-less file.
 *
 * @param fmExt  - Frontmatter extension (already injection-checked, may be `''`).
 * @param langId - Fence language id (may be `undefined`).
 * @returns A bare extension without the leading dot, or `''`.
 *
 * @example
 * resolveExtension('.mjs', 'tsx') // 'mjs'
 * resolveExtension('', 'python')  // 'py'
 * resolveExtension('', undefined) // ''
 */
function resolveExtension(fmExt: string, langId: string | undefined): string {
    if (fmExt !== '') {
        return fmExt.replace(/^\.+/, '');
    }
    const lang = langId?.trim();
    if (lang !== undefined && lang !== '') {
        return extForLang(normalizeLangId(lang));
    }
    return '';
}
