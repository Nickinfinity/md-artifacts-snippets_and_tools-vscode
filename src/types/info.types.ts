/**
 * The read-only "View Info" summary — artifact-agnostic.
 *
 * A caller describes *what* to show (an artifact, a sub-set, a variable,
 * later a snippet block…) as an `InfoModel`; `renderInfoHtml`
 * (`ui/panels/infoPanel/infoPanel.render.ts`) owns *how*. Adding View Info to
 * another artifact type is one adapter that builds this model — no new panel,
 * renderer or stylesheet. Labels arrive already localised (types stay
 * `vscode`-free; the adapter calls `vscode.l10n.t`).
 */

/** One `label: value` line. */
export interface InfoField {
    /** Localised label, e.g. `'Value'`. */
    label: string;
    /** Value shown verbatim (escaped by the renderer). */
    value: string;
    /** Render in the editor font — names, values, paths. */
    mono?: boolean;
}

/** A titled group of fields under the summary — a sub-set, a block, a variable list. */
export interface InfoSection {
    /** Section heading (escaped). */
    heading: string;
    /** Optional prose under the heading. */
    description?: string;
    /** The section's lines; an empty list renders the `emptyText`. */
    fields: InfoField[];
    /** Shown when `fields` is empty, e.g. `'No variables yet.'`. */
    emptyText?: string;
}

/**
 * Everything one View Info popup shows.
 *
 * @example
 * const model: InfoModel = {
 *     kind: 'Variable set', title: 'JavaScript Array Domains',
 *     description: 'Real-world collections…', tags: ['javascript'],
 *     fields: [{ label: 'Sub-sets', value: '6' }], sections: [],
 *     path: 'test/js-array-domains.md',
 * };
 */
export interface InfoModel {
    /** What the item is, shown above the title (`'Variable set'`, `'Sub-set'`, `'Variable'`). */
    kind: string;
    /** The item's name. */
    title: string;
    /** Item-level prose; omitted when empty. */
    description?: string;
    /** Tags, rendered as chips; `[]` for none. */
    tags: string[];
    /** Summary lines under the title. */
    fields: InfoField[];
    /** Groups under the summary. */
    sections: InfoSection[];
    /** Vault-relative path of the file the item lives in. */
    path?: string;
}
