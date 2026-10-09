/**
 * Adapter between the variable-set creation **form** payload and the
 * existing `.md` emission pipeline.
 *
 * There is no `renderVarSetFile` and this module must never grow one: the
 * one `.md` emitter is `serializeArtifact` (`artifact-serializer.service.ts`),
 * already wrapped for this file type by `variables-writer.service.ts`
 * (`renderVariablesFile` / `writeVariablesFile`), and the one model builder
 * is `buildVarSetModel` (`varset.service.ts`). This module only adapts a
 * webview payload into calls onto those two.
 */
import { buildVarSetModel } from './varset.service.js';
import { slugify } from './filename.service.js';
import type { ArtifactFormModel } from '../types/artifact-form.types.js';
import type { VarSetFormPayload } from '../types/varset.types.js';

/** Result of {@link validateVarSetForm} — mirrors the codebase's standing `{ ok } | { ok: false, reason }` shape. */
export type VarSetFormValidation = { ok: true } | { ok: false; reason: string };

/** A variable name or value containing any of these would break out of the `vks` fence it is emitted into verbatim. */
const FENCE_BREAKING_RE = /[\n`]/;
/** Variable *names* additionally cannot contain `=` — it is the `vksFence` `name=value` separator. */
const NAME_EQUALS_RE = /=/;

/**
 * Slugs a variable-set title into a filename stem, falling back to a
 * dedicated default when the title has no slug-able characters.
 *
 * Deliberately **not** `filename.service.ts`'s `deriveFileName` — that
 * falls back to `'untitled'`, while the save-as-variable-set flow being
 * preserved here (`varSetController.ts:200`) has always fallen back to
 * `'untitled-variable-set'`. Collapsing the two would change the on-disk
 * filename for a punctuation-only title.
 *
 * @param title - Raw, untrimmed title as typed in the form.
 * @returns A filesystem-safe slug, or `'untitled-variable-set'` when empty.
 *
 * @example
 * slugForVarSet('Local Dev'); // → 'local-dev'
 * slugForVarSet('...');       // → 'untitled-variable-set'
 *
 * ponytail: passes the title to `slugify` **untrimmed** — faithfully
 * mirroring the old flow (`varSetController.ts:205` slugged untrimmed while
 * `:203` trimmed only for the model). Correct today only because `slugify`
 * strips leading/trailing dashes itself (`SLUG_TRIM_DASH_RE`,
 * filename.service.ts:18,145) — a silent dependency on another module's
 * internals, with no test that fails if that stripping ever changes.
 * Upgrade path if it bites: assert this parity directly in
 * `filename.service.test.ts` (or trim here explicitly once nothing else
 * depends on matching the old flow's exact bytes).
 */
export function slugForVarSet(title: string): string {
    const slug = slugify(title);
    return slug.length > 0 ? slug : 'untitled-variable-set';
}

/**
 * Validates a `VarSetFormPayload` before it is ever turned into a model or
 * written to disk.
 *
 * **Rejects, never sanitises** — matching every other trust-boundary guard
 * in this codebase. Two independent hazards are checked:
 *   - an empty (post-trim) title, so `slugForVarSet` never has to guess intent;
 *   - a variable *name* or *value* that would break out of the ` ```vks `
 *     fence it is emitted into verbatim (`vksFence`, `artifact-serializer.service.ts`) —
 *     a newline or backtick in either half, or an `=` in a name (the
 *     `name=value` separator). `=` and backtick-free content in a **value**
 *     is legal (see the `equals` / `quotes` goldens) and must not be rejected.
 *
 * @param payload - Form payload as posted from the webview (untrusted shape assumed already checked upstream).
 * @returns `{ ok: true }` when safe to write, `{ ok: false, reason }` otherwise.
 *
 * @example
 * validateVarSetForm({ title: 'Local Dev', description: '', tags: [], pairs: [['VK-host', 'localhost']] });
 * // → { ok: true }
 */
export function validateVarSetForm(payload: VarSetFormPayload): VarSetFormValidation {
    if (payload.title.trim().length === 0) {
        return { ok: false, reason: 'Name cannot be empty.' };
    }

    return validateVarPairs(payload.pairs);
}

/**
 * Validates `[name, value]` rows against the ` ```vks ` fence they are emitted
 * into verbatim — the content half of the var-set trust boundary.
 *
 * Extracted from {@link validateVarSetForm} so the **edit** path can run the
 * identical check: a second copy of a security check is the duplication
 * `CLAUDE.md` names, and this one guards a real sink. `serializeArtifact` emits
 * `${name}=${value}` into the fence with nothing downstream escaping, so a
 * newline plus a fence marker in a value re-parses as a single variable and
 * silently destroys the rest of the file.
 *
 * Edit mode legitimately skips only the **title/slug** check its caller keeps,
 * because it writes back to a path that already exists.
 *
 * **Rejects, never sanitises.**
 *
 * @param pairs - Editable `[name, value]` rows, from any mode's payload.
 * @returns `{ ok: true }` when every row is safe to write, `{ ok: false, reason }` otherwise.
 *
 * @example
 * validateVarPairs([['VK-host', 'localhost']]);      // → { ok: true }
 * validateVarPairs([['VK-a', '`\n```vks']]);          // → { ok: false, reason: … }
 */
export function validateVarPairs(pairs: [string, string][]): VarSetFormValidation {
    for (const [name, value] of pairs) {
        if (FENCE_BREAKING_RE.test(name) || NAME_EQUALS_RE.test(name)) {
            return { ok: false, reason: `Variable name "${name}" contains an illegal character (newline, backtick, or =).` };
        }
        if (FENCE_BREAKING_RE.test(value)) {
            return { ok: false, reason: `Value for "${name}" contains an illegal character (newline or backtick).` };
        }
    }

    return { ok: true };
}

/**
 * Converts a form payload into the `ArtifactFormModel` the existing writer
 * pipeline expects — the thin adapter this task owns.
 *
 * Trims `title`/`description` exactly as the prompt flow being replaced did
 * (`title.trim()` / `description.trim()` at `varSetController.ts:198`),
 * otherwise a padded input would emit a padded frontmatter value and break
 * the byte-identity contract with the golden files.
 *
 * @param payload - Validated form payload.
 * @returns A single-block `artifactType: Variables` model, ready for `renderVariablesFile` / `writeVariablesFile`.
 *
 * @example
 * toVarSetModel({ title: ' Local Dev ', description: '', tags: [], pairs: [['VK-host', 'localhost']] });
 * // → buildVarSetModel('Local Dev', '', [], [['VK-host', 'localhost']])
 */
export function toVarSetModel(payload: VarSetFormPayload): ArtifactFormModel {
    return buildVarSetModel(
        payload.title.trim(),
        payload.description.trim(),
        payload.tags,
        payload.pairs,
    );
}

/**
 * Validates the sub-set headings of an edit-mode Save.
 *
 * With one sub-set a heading is optional — a heading-less file stays flat.
 * With two or more, every sub-set is emitted as a `## ` heading, so each must
 * be non-empty (a bare `## ` would not re-parse), unique (sub-sets are picked
 * by heading), and free of newline/backtick (either would break the heading
 * line or the fence under it).
 *
 * @param headings - Final headings, one per sub-set, in file order.
 * @returns `{ ok: true }` or the first failure reason.
 *
 * @example
 * validateSubSetHeadings(['Dev', 'Prod']); // { ok: true }
 * validateSubSetHeadings(['Dev', '']);     // { ok: false, reason: 'Every sub-set needs a name…' }
 */
export function validateSubSetHeadings(headings: string[]): VarSetFormValidation {
    if (headings.length < 2) {
        return headings.some(h => FENCE_BREAKING_RE.test(h))
            ? { ok: false, reason: 'Sub-set name contains an illegal character (newline or backtick).' }
            : { ok: true };
    }
    const seen = new Set<string>();
    for (const h of headings) {
        if (h === '') {
            return { ok: false, reason: 'Every sub-set needs a name when the set has more than one.' };
        }
        if (FENCE_BREAKING_RE.test(h)) {
            return { ok: false, reason: `Sub-set name "${h}" contains an illegal character (newline or backtick).` };
        }
        if (seen.has(h)) {
            return { ok: false, reason: `Sub-set name "${h}" is used twice.` };
        }
        seen.add(h);
    }
    return { ok: true };
}

/** A description line that would open a fence or start a new `## ` sub-set when re-parsed. */
const STRUCTURE_BREAKING_LINE_RE = /^\s*(?:```|~~~|##\s)/m;

/**
 * Validates sub-set descriptions — the prose written between a `## ` heading
 * and its ` ```vks ` fence.
 *
 * Free text otherwise (inline `` `code` `` is fine, and the source vault uses
 * it): only a line that would re-parse as a fence or as the next sub-set's
 * heading is refused, since either would split or swallow the sub-set.
 *
 * @param descriptions - One description per sub-set (`''` for none).
 * @returns `{ ok: true }` or the first failure reason.
 *
 * @example
 * validateSubSetDescriptions(['Users keyed by `status`.']); // { ok: true }
 * validateSubSetDescriptions(['```vks']);                   // { ok: false, … }
 */
export function validateSubSetDescriptions(descriptions: string[]): VarSetFormValidation {
    const bad = descriptions.find(d => STRUCTURE_BREAKING_LINE_RE.test(d));
    return bad === undefined
        ? { ok: true }
        : { ok: false, reason: 'A sub-set description cannot contain a line starting with ``` or "## ".' };
}
