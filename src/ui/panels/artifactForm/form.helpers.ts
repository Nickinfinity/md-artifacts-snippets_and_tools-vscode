import * as vscode from 'vscode';
import { getDefaultLanguage, getTypeSingular } from '../../../services/artifact-type-config.service.js';
import type { ArtifactType } from '../../../types/parsed-artifact.types.js';
import type { ArtifactFormModel } from '../../../types/artifact-form.types.js';

// ── Language options ──────────────────────────────────────────────────────────

/**
 * Ordered list of language choices for `free`-mode language selectors.
 *
 * `''` represents plain text (bare code fence). Options appear in this order
 * in the dropdown; the currently-selected block language is pre-selected by
 * the HTML builder. Extend this list to add hljs-supported languages.
 *
 * @example
 * FREE_LANGUAGE_OPTIONS[0] // '' (Plain text)
 */
export const FREE_LANGUAGE_OPTIONS: readonly string[] = [
    '',
    'bash',
    'css',
    'dockerfile',
    'html',
    'javascript',
    'json',
    'jsx',
    'markdown',
    'python',
    'rust',
    'shell',
    'sql',
    'tsx',
    'typescript',
    'yaml',
];

// ── Default model ─────────────────────────────────────────────────────────────

/**
 * Builds a blank `ArtifactFormModel` for a new artifact of the given type.
 *
 * The single block starts with the type's default language (from
 * `getDefaultLanguage`) so the language selector is pre-selected correctly
 * when the form opens.
 *
 * @param type - Canonical artifact type for the new model.
 * @returns A minimal, empty `ArtifactFormModel`.
 *
 * @example
 * defaultModel('Snippet')
 * // → { artifactType: 'Snippet', title: '', description: '', tags: [], blocks: [{ heading: '', description: '', language: '', code: '', vars: [] }] }
 */
export function defaultModel(type: ArtifactType): ArtifactFormModel {
    return {
        artifactType: type,
        title:       '',
        description: '',
        tags:        [],
        blocks: [
            {
                heading:     '',
                description: '',
                language:    getDefaultLanguage(type),
                code:        '',
                vars:        [],
            },
        ],
    };
}

// ── UI label helpers ──────────────────────────────────────────────────────────

/**
 * Returns the label for the "add block" button.
 *
 * Always derived from `getTypeSingular(type)` — never a hard-coded type string.
 *
 * @param type - Canonical artifact type.
 * @returns Label string e.g. `'+ Add additional snippet'`.
 *
 * @example
 * labelForAddBlock('Snippet') // → '+ Add additional snippet'
 */
export function labelForAddBlock(type: ArtifactType): string {
    return vscode.l10n.t('+ Add additional {0}', getTypeSingular(type));
}

/**
 * Returns the label for the delete footer button.
 *
 * The same wording for every type: the per-type singular made the button read
 * as if it deleted only part of the file ("delete entire snippet" beside a
 * per-block delete), and the type is already stated everywhere else on the
 * form. `type` is retained so the signature does not churn at four call sites
 * and a future per-type wording stays a one-line change.
 *
 * @param _type - Canonical artifact type; unused, see above.
 * @returns The button label.
 *
 * @example
 * labelForDeleteEntire('Command') // → 'Delete Artifact'
 */
export function labelForDeleteEntire(_type: ArtifactType): string {
    return vscode.l10n.t('Delete Artifact');
}
