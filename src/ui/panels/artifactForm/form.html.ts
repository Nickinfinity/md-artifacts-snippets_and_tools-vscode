import * as vscode from 'vscode';
import { getLanguageMode, getDefaultLanguage, canMultiBlock, getTypeSingular } from '../../../services/artifact-type-config.service.js';
import type { ArtifactFormModel } from '../../../types/artifact-form.types.js';
import { escHtml, styleLinkTags } from '../../../utils/html.js';
import { buildTagsField } from '../shared/tagsField.js';
import { labelForAddBlock, labelForDeleteEntire } from './form.helpers.js';
import { buildSingleBlockContent, buildMultiBlockArea } from './form.blocks.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Arguments for `buildFormHtml`.
 *
 * @example
 * buildFormHtml({ model, cspSource: panel.webview.cspSource, cssUri, nonce, codeBlockHtml })
 */
export interface BuildFormHtmlArgs {
    /** Form data model — drives all rendered fields. */
    model: ArtifactFormModel;
    /** Webview CSP source token (e.g. `panel.webview.cspSource`). */
    cspSource: string;
    /** Webview URI(s) for this panel's stylesheets, in cascade order. */
    cssUri: string | string[];
    /** CSP nonce threaded into `<script>` tags (Phase 6b). */
    nonce: string;
    /** Produces editable code-block HTML for a given code + language pair. */
    codeBlockHtml: (code: string, lang: string) => string;
    /**
     * Client-side JS bundle injected into the webview `<script>` tag.
     * Omit in tests (no script produced). Provided by the controller in production.
     */
    clientJs?: string;
}

/**
 * Builds the full HTML document for the Artifact Form webview panel.
 *
 * Pure function — no VS Code API calls. The webview lifecycle lives in
 * `panel.ts` (Phase 6c); this module only produces the HTML string.
 * All per-type behaviour (language mode, labels) flows through
 * `artifact-type-config.service` helpers — no type-string comparisons.
 *
 * @param args - See `BuildFormHtmlArgs`.
 * @returns Complete HTML document string.
 *
 * @example
 * const html = buildFormHtml({ model, cspSource, cssUri, nonce, codeBlockHtml });
 * panel.webview.html = html;
 */
export function buildFormHtml(args: BuildFormHtmlArgs): string {
    const { model, cspSource, cssUri, nonce, codeBlockHtml } = args;
    const languageMode = getLanguageMode(model.artifactType);
    const lockedLang   = getDefaultLanguage(model.artifactType);
    const multi        = model.blocks.length > 1;
    const multiAllowed = canMultiBlock(model.artifactType);

    const singular     = getTypeSingular(model.artifactType);
    const head         = buildHead(nonce, cspSource, cssUri);
    const frontmatter  = buildFrontmatterSection(model);
    const blocksArea   = multi
        ? buildMultiBlockArea(model, languageMode, lockedLang, codeBlockHtml)
        : buildSingleBlockContent(model.blocks[0], 0, languageMode, lockedLang, codeBlockHtml);
    const addBtn       = multiAllowed ? buildAddBlockButton(model.artifactType) : '';
    const footer       = buildFooter(model.artifactType);
    const areaClass    = `blocks-area${multi ? ' multi-block' : ''}`;
    const areaAttrs    = `id="blocks-area" class="${areaClass}" data-lang-mode="${escHtml(languageMode)}" data-default-lang="${escHtml(lockedLang)}" data-type="${escHtml(model.artifactType)}" data-singular="${escHtml(singular)}"`;

    const scriptTag = args.clientJs
        ? buildScriptTag(nonce, args.clientJs)
        : '';

    return `<!DOCTYPE html>
<html lang="en">
${head}
<body class="form-body">
<div class="form-panel">
${frontmatter}
<div ${areaAttrs}>
${blocksArea}
</div>
${addBtn}
${footer}
</div>
${scriptTag}
</body>
</html>`;
}

// ── Script tag ────────────────────────────────────────────────────────────────

/**
 * Wraps the client JS bundle in a nonced `<script>` tag inside one outer IIFE.
 *
 * @param nonce    - CSP nonce matching the `Content-Security-Policy` header.
 * @param clientJs - Full client JS string (e.g. `FORM_CLIENT_JS`).
 * @returns `<script>` element string.
 *
 * @example
 * buildScriptTag('abc123', FORM_CLIENT_JS)
 */
function buildScriptTag(nonce: string, clientJs: string): string {
    const safeNonce = escHtml(nonce);
    return `<script nonce="${safeNonce}">(function(){const vscode=acquireVsCodeApi();${clientJs}})()</script>`;
}

// ── Head ──────────────────────────────────────────────────────────────────────

/**
 * Builds the `<head>` section including CSP meta and stylesheet link.
 *
 * @param nonce     - CSP nonce for `<script>` tags.
 * @param cspSource - Webview CSP source token.
 * @param cssUri    - Webview URI for the shared stylesheet.
 * @returns `<head>…</head>` HTML string.
 *
 * @example
 * buildHead('abc123', panel.webview.cspSource, cssUri.toString())
 */
function buildHead(nonce: string, cspSource: string, cssUri: string | string[]): string {
    const csp = `default-src 'none'; script-src 'nonce-${escHtml(nonce)}'; style-src ${escHtml(cspSource)};`;
    const link = styleLinkTags(cssUri);
    return `<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${link}
</head>`;
}

// ── Frontmatter section ───────────────────────────────────────────────────────

/**
 * Builds the title, description, and tags fields (file-level frontmatter).
 *
 * @param model - Form model supplying title, description, and tags.
 * @returns HTML string for the frontmatter fields.
 *
 * @example
 * buildFrontmatterSection(model)
 */
function buildFrontmatterSection(model: ArtifactFormModel): string {
    const titleVal = escHtml(model.title);
    const descVal  = escHtml(model.description);
    return `<div class="form-section">
  <label class="slabel" for="title">${escHtml(vscode.l10n.t('Title'))}</label>
  <input type="text" id="title" class="form-input" value="${titleVal}" placeholder="${escHtml(vscode.l10n.t('Artifact title'))}">
</div>
<div class="form-section">
  <label class="slabel" for="description">${escHtml(vscode.l10n.t('Description'))}</label>
  <textarea id="description" class="form-input form-textarea" rows="2" placeholder="${escHtml(vscode.l10n.t('Optional description'))}">${descVal}</textarea>
</div>
${buildExtensionField(model)}${buildAgentFieldsSection(model)}${buildTagsField(model.tags, 'slabel')}`;
}

/**
 * Builds the optional file-extension field — **templates only**. The extension
 * is a template-specific frontmatter key (it overrides the fence language when
 * the written file is named, D3), so the input appears for no other type; every
 * other type gets an empty string here and never posts an `extension`.
 *
 * @param model - Form model (its `type` gates the field, `extension` seeds it).
 * @returns The extension form-section HTML, or `''` for non-template types.
 *
 * @example
 * buildExtensionField({ artifactType: 'Template', extension: '.tsx', ... }) // → '<div class="form-section">…'
 * buildExtensionField({ artifactType: 'Snippet', ... })                     // → ''
 */
function buildExtensionField(model: ArtifactFormModel): string {
    if (model.artifactType !== 'Template') { return ''; }
    return buildOptionalTextField('extension', vscode.l10n.t('File extension'), model.extension, vscode.l10n.t('e.g. .tsx — overrides the fence language'));
}

/**
 * Builds one optional single-line frontmatter input — the shape every
 * type-specific key uses (template `extension`, agent `provider`/`model`/
 * `version`).
 *
 * Exists so those keys cannot drift apart in markup or, worse, in escaping: the
 * seed crosses the webview boundary, so it passes `escHtml` **here**, once, for
 * every caller.
 *
 * @param id          - Input element id; also the posted model key.
 * @param label       - Field label, rendered before the `(optional)` hint.
 * @param value       - Current model value (may be `undefined` for a new artifact).
 * @param placeholder - Placeholder text shown when empty.
 * @returns The form-section HTML for that one input.
 *
 * @example
 * buildOptionalTextField('provider', 'Provider', 'Claude', 'e.g. Claude') // → '<div class="form-section">…'
 */
function buildOptionalTextField(id: string, label: string, value: string | undefined, placeholder: string): string {
    const safeVal = escHtml(value ?? '');
    const safeLabel = escHtml(label);
    const safePlaceholder = escHtml(placeholder);
    return `<div class="form-section">
  <label class="slabel" for="${id}">${safeLabel} <span class="muted">${escHtml(vscode.l10n.t('(optional)'))}</span></label>
  <input type="text" id="${id}" class="form-input" value="${safeVal}" placeholder="${safePlaceholder}">
</div>
`;
}

/**
 * Builds the agent-only fields. `target`, `provider`, `model` and `version` are
 * agent-specific frontmatter keys, so the inputs appear for no other type; every
 * other type gets an empty string here and never posts them.
 *
 * `target` leads because it is the one that decides the **written file's name**
 * (verbatim — `resolveAgentFileName` never appends an extension); the other
 * three are provenance only.
 *
 * Rendered through the same `buildOptionalTextField` the template-only
 * `extension` key uses, so the markup and the `escHtml` seeding of these
 * webview-bound values are literally the same code, not a parallel copy.
 *
 * @param model - Form model (its `type` gates the fields, the four keys seed them).
 * @returns The agent form-section HTML, or `''` for non-agent types.
 *
 * @example
 * buildAgentFieldsSection({ artifactType: 'AIAgentsConfig', provider: 'Claude', ... }) // → '<div class="form-section">…'
 * buildAgentFieldsSection({ artifactType: 'Snippet', ... })                   // → ''
 */
function buildAgentFieldsSection(model: ArtifactFormModel): string {
    if (model.artifactType !== 'AIAgentsConfig') { return ''; }
    return buildOptionalTextField('target', vscode.l10n.t('Target file name'), model.target, vscode.l10n.t('e.g. CLAUDE.md — used verbatim'))
        + buildOptionalTextField('provider', vscode.l10n.t('Provider'), model.provider, vscode.l10n.t('e.g. Claude'))
        + buildOptionalTextField('model', vscode.l10n.t('Model'), model.model, vscode.l10n.t('e.g. Opus'))
        + buildOptionalTextField('version', vscode.l10n.t('Version'), model.version, vscode.l10n.t('e.g. 4.8'));
}

// ── Add-block button ──────────────────────────────────────────────────────────

/**
 * Builds the "Add additional block" button below the blocks area.
 *
 * Label derived from `labelForAddBlock` so it reflects the type's singular noun.
 *
 * @param type - Canonical artifact type.
 * @returns HTML string for the add-block button.
 *
 * @example
 * buildAddBlockButton('Snippet') // → '<button …>+ Add additional snippet</button>'
 */
function buildAddBlockButton(type: ArtifactFormModel['artifactType']): string {
    const label = escHtml(labelForAddBlock(type));
    return `<button id="add-block-btn" class="add-block-btn">${label}</button>`;
}

// ── Footer ────────────────────────────────────────────────────────────────────

/**
 * Builds the form footer with Save, Cancel, and Delete buttons.
 *
 * "Delete entire" label derived from `labelForDeleteEntire` — no type-string
 * comparisons.
 *
 * @param type - Canonical artifact type (drives delete label).
 * @returns HTML string for the form footer.
 *
 * @example
 * buildFooter('Snippet')
 */
function buildFooter(type: ArtifactFormModel['artifactType']): string {
    const deleteLabel = escHtml(labelForDeleteEntire(type));
    return `<div class="form-footer">
  <button id="save-btn" class="btn btn-primary">${escHtml(vscode.l10n.t('Save'))}</button>
  <button id="cancel-btn" class="btn">${escHtml(vscode.l10n.t('Cancel'))}</button>
  <button id="delete-btn" class="btn btn-danger">${deleteLabel}</button>
</div>`;
}
