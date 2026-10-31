import * as vscode from 'vscode';
import type { ClientErrorCode, EngineErrorData, RenderWarning } from '../types/engine.types.js';

/** Params of an engine or client error. */
type P = EngineErrorData['params'];

/** One localised line per client code; the union is covered at compile time. */
const CLIENT_MESSAGES = {
    'client.not_found': (p: P) => vscode.l10n.t('Engine executable not found: {0}', p.path ?? ''),
    'client.invalid_path': (p: P) => vscode.l10n.t('Invalid path: {0}', p.path ?? ''),
    'client.incompatible': (p: P) => p.missing === undefined
        ? vscode.l10n.t('Engine {0} (protocol {1}) is not compatible with this extension.', p.engine ?? '', p.protocol ?? '')
        : vscode.l10n.t('Engine lacks required support: {0}', p.missing),
    'client.exited': () => vscode.l10n.t('The engine process exited unexpectedly.'),
    'client.timeout': () => vscode.l10n.t('The engine did not answer in time.'),
    'client.protocol': () => vscode.l10n.t('The engine sent an invalid reply.'),
    'client.unavailable': () => vscode.l10n.t('The engine is not available.'),
    'client.closed': () => vscode.l10n.t('The engine session is closed.'),
} satisfies Record<ClientErrorCode, (p: P) => string>;

/** Engine codes (spec/PROTOCOL.md §5). Literal `l10n.t` first arguments only. `op.bad_request` never shows `reason`. */
const ENGINE_MESSAGES: Readonly<Record<string, (p: P) => string>> = {
    ...CLIENT_MESSAGES,
    'op.unknown': p => vscode.l10n.t('Unknown engine operation: {0}', p.name ?? ''),
    'op.bad_request': () => vscode.l10n.t('The engine rejected the request as malformed.'),
    'op.internal': () => vscode.l10n.t('Internal engine error.'),
    'protocol.version_mismatch': p => vscode.l10n.t('Protocol version mismatch (client {0}, engine {1}).', p.client ?? '', p.server ?? ''),
    'protocol.parse_error': () => vscode.l10n.t('The engine could not parse the request.'),
    'protocol.line_too_long': p => vscode.l10n.t('Request line exceeds {0} bytes.', p.max ?? ''),
    'protocol.already_initialized': () => vscode.l10n.t('Engine already initialized.'),
    'protocol.not_initialized': () => vscode.l10n.t('Engine not initialized.'),
    'protocol.invalid_request': () => vscode.l10n.t('Invalid engine request.'),
    'path.outside_root': p => vscode.l10n.t('Path is outside the vault: {0}', p.path ?? ''),
    'path.not_found': p => vscode.l10n.t('Path not found: {0}', p.path ?? ''),
    'path.not_dir': p => vscode.l10n.t('Not a directory: {0}', p.path ?? ''),
    'file.too_large': p => vscode.l10n.t('File too large: {0} ({1} bytes, max {2}).', p.path ?? '', p.size ?? '', p.max ?? ''),
    'file.not_regular': p => vscode.l10n.t('Not a regular file: {0}', p.path ?? ''),
    'file.conflict': p => vscode.l10n.t('File changed on disk since it was read: {0}', p.path ?? ''),
    'file.exists': p => vscode.l10n.t('File already exists: {0}', p.path ?? ''),
    'io.failed': p => vscode.l10n.t('File operation failed on {0} ({1}).', p.path ?? '', p.kind ?? ''),
    'path.empty': () => vscode.l10n.t('Path is empty.'),
    'path.control_char': p => vscode.l10n.t('Path contains a control character: {0}', p.path ?? ''),
    'path.drive_or_scheme': p => vscode.l10n.t('Path has a drive letter or scheme: {0}', p.path ?? ''),
    'path.backslash': p => vscode.l10n.t('Path contains a backslash: {0}', p.path ?? ''),
    'path.absolute': p => vscode.l10n.t('Path must be relative: {0}', p.path ?? ''),
    'path.parent_segment': p => vscode.l10n.t('Path contains a ".." segment: {0}', p.path ?? ''),
    'vault.not_selected': () => vscode.l10n.t('No vault selected.'),
    'vault.not_obsidian': p => vscode.l10n.t('Not an Obsidian vault: {0}', p.path ?? ''),
    'vault.unknown': p => vscode.l10n.t('Unknown vault: {0}', p.path ?? ''),
    'vault.unavailable': p => vscode.l10n.t('Vault unavailable: {0}', p.path ?? ''),
    'config.invalid': p => vscode.l10n.t('Invalid vault configuration: {0}', p.path ?? ''),
    'artifact.bad_path': p => vscode.l10n.t('Not a valid artifact path: {0}', p.path ?? ''),
    'artifact.vars_invalid': p => vscode.l10n.t('Invalid variables in {0}.', p.path ?? ''),
    'artifact.block_not_found': p => vscode.l10n.t('Block not found: {0}', p.block ?? ''),
    'artifact.not_serializable': p => vscode.l10n.t('Artifact cannot be saved: {0}', p.reason ?? ''),
    'artifact.unrepresentable': p => vscode.l10n.t('Field "{0}" cannot be represented: {1}', p.field ?? '', p.reason ?? ''),
    'artifact.not_whole_file': p => vscode.l10n.t('{0} is not a whole-file artifact type.', p.type ?? ''),
    'artifact.multi_block': p => vscode.l10n.t('Artifact has {0} blocks; one is required.', p.count ?? ''),
    'artifact.is_index': () => vscode.l10n.t('This artifact is an index and cannot be written directly.'),
    'render.limit': p => vscode.l10n.t('Render limit exceeded: {0} (max {1}).', p.limit ?? '', p.max ?? ''),
    'render.contains_escape': () => vscode.l10n.t('Output contains terminal escape characters.'),
    'render.unjoinable': p => vscode.l10n.t('Line {0} cannot be joined into one command.', p.line ?? ''),
    'rename.index_link': p => vscode.l10n.t('Index {0} still links to {1}.', p.index ?? '', p.link ?? ''),
    'rename.links_unchecked': () => vscode.l10n.t('Not every index was checked for links to the renamed file.'),
    'index.not_index': p => vscode.l10n.t('Not an index artifact: {0}', p.path ?? ''),
    'index.unsluggable': p => vscode.l10n.t('Cannot make a file name from "{0}".', p.segment ?? ''),
    'index.limit': p => vscode.l10n.t('Index limit exceeded: {0} (max {1}).', p.limit ?? '', p.max ?? ''),
    'walk.limit': p => vscode.l10n.t('Vault scan limit exceeded: {0} (max {1}).', p.limit ?? '', p.max ?? ''),
    'naming.path_injection': p => vscode.l10n.t('"{0}" must not contain path separators.', p.field ?? ''),
    'naming.empty': () => vscode.l10n.t('Name is empty.'),
    'naming.edge_space': () => vscode.l10n.t('Name must not start or end with a space.'),
    'naming.edge_dot': () => vscode.l10n.t('Name must not start or end with a dot.'),
    'naming.illegal_char': () => vscode.l10n.t('Name contains an illegal character.'),
    'naming.control_char': () => vscode.l10n.t('Name contains a control character.'),
    'naming.reserved': () => vscode.l10n.t('Name is reserved by the operating system.'),
    'naming.too_long': p => vscode.l10n.t('Name is too long (max {0}).', p.max ?? ''),
    'naming.md_extension': () => vscode.l10n.t('Name must not end in .md.'),
    'vks.syntax': p => vscode.l10n.t('Variables syntax error at line {0}: {1}', p.line ?? '', p.rule ?? ''),
    'vks.indent': p => vscode.l10n.t('Variables indentation error at line {0}.', p.line ?? ''),
    'vks.bad_key': p => vscode.l10n.t('Bad key "{1}" at line {0}.', p.line ?? '', p.key ?? ''),
    'vks.duplicate_key': p => vscode.l10n.t('Duplicate key "{1}" at line {0}.', p.line ?? '', p.key ?? ''),
    'vks.unsupported': p => vscode.l10n.t('Unsupported construct "{1}" at line {0}.', p.line ?? '', p.construct ?? ''),
    'vks.mixed_list': p => vscode.l10n.t('Mixed list items at line {0}.', p.line ?? ''),
    'vks.inline_comment': p => vscode.l10n.t('Inline comment not allowed at line {0}.', p.line ?? ''),
    'vks.control_char': p => vscode.l10n.t('Control character at line {0}.', p.line ?? ''),
    'vks.limit': p => vscode.l10n.t('Variables limit exceeded at line {0}: {1} (max {2}).', p.line ?? '', p.limit ?? '', p.max ?? ''),
    'vks.mixed_dialect': p => vscode.l10n.t('Mixed variables dialects at line {0}.', p.line ?? ''),
    'vks.unrepresentable': p => vscode.l10n.t('Variable {0} cannot be represented: {1}', p.var ?? '', p.reason ?? ''),
    'vars.bad_name': p => vscode.l10n.t('Invalid variable name: {0}', p.name ?? ''),
    'vars.var_exists': p => vscode.l10n.t('Variable already exists: {0}', p.name ?? ''),
    'vars.var_not_found': p => vscode.l10n.t('Variable not found: {0}', p.name ?? ''),
    'vars.subset_exists': p => vscode.l10n.t('Sub-set already exists: {0}', p.heading ?? ''),
    'vars.bad_heading': p => vscode.l10n.t('Invalid sub-set heading: {0}', p.reason ?? ''),
    'vars.untitled_description': () => vscode.l10n.t('An untitled sub-set cannot have a description.'),
    'vars.bad_title': () => vscode.l10n.t('Invalid title.'),
    'vars.fenceless_section': p => vscode.l10n.t('Section "{0}" has no variables block.', p.heading ?? ''),
    'vars.mixed_file': () => vscode.l10n.t('The file mixes untitled and titled variable blocks.'),
    'vars.untagged_defaults': p => vscode.l10n.t('Defaults without tags: {0}', p.info ?? ''),
    'migrate.up_to_date': () => vscode.l10n.t('Already up to date.'),
    'migrate.leading_blank': () => vscode.l10n.t('File starts with a blank line.'),
    'migrate.quoted_type': p => vscode.l10n.t('Quoted type value: {0}', p.value ?? ''),
    'migrate.pending': p => vscode.l10n.t('Migration pending: {0}', p.kind ?? ''),
};

/** Render warnings (spec/PROTOCOL.md §6): `line` plus `name` or `path`. */
const WARNING_MESSAGES: Readonly<Record<string, (p: RenderWarning['params']) => string>> = {
    'render.unknown_var': p => vscode.l10n.t('Line {0}: unknown variable {1}', p.line, p.name ?? p.path ?? ''),
    'render.each_not_list': p => vscode.l10n.t('Line {0}: {1} is not a list.', p.line, p.name ?? p.path ?? ''),
    'render.unterminated': p => vscode.l10n.t('Line {0}: unterminated block for {1}.', p.line, p.name ?? p.path ?? ''),
    'render.unmatched_end': p => vscode.l10n.t('Line {0}: end tag without a start for {1}.', p.line, p.name ?? p.path ?? ''),
    'render.self_nested': p => vscode.l10n.t('Line {0}: {1} is nested in itself.', p.line, p.name ?? p.path ?? ''),
    'render.not_scalar': p => vscode.l10n.t('Line {0}: {1} is not a single value.', p.line, p.name ?? p.path ?? ''),
    'render.join_record': p => vscode.l10n.t('Line {0}: cannot join records for {1}.', p.line, p.name ?? p.path ?? ''),
    'render.join_empty': p => vscode.l10n.t('Line {0}: nothing to join for {1}.', p.line, p.name ?? p.path ?? ''),
};

/** Codes the table covers (its own keys, never a second list). */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(ENGINE_MESSAGES));
/** Warning codes the table covers. */
export const KNOWN_WARNING_CODES: ReadonlySet<string> = new Set(Object.keys(WARNING_MESSAGES));

/**
 * Localised one-line message for an engine or client error. Unknown code gives a generic message naming it.
 * Plain text: callers escape at their sink.
 *
 * @param err - code + string params from the engine or the client.
 * @returns the message.
 * @example
 * engineErrorMessage({ code: 'path.not_found', params: { path: 'a.md' } });
 */
export function engineErrorMessage(err: EngineErrorData): string {
    const f = KNOWN_ERROR_CODES.has(err.code) ? ENGINE_MESSAGES[err.code] : undefined;
    return f ? f(err.params) : vscode.l10n.t('Engine error: {0}', err.code);
}

/**
 * Same for a render warning.
 *
 * @param w - warning code + params.
 * @returns the message.
 * @example
 * engineWarningMessage({ code: 'render.unknown_var', params: { line: '3', name: 'VK-x' } });
 */
export function engineWarningMessage(w: RenderWarning): string {
    const f = KNOWN_WARNING_CODES.has(w.code) ? WARNING_MESSAGES[w.code] : undefined;
    return f ? f(w.params) : vscode.l10n.t('Engine warning: {0}', w.code);
}
