import * as vscode from 'vscode';

/**
 * Single OutputChannel reused across every artifactForm module.
 *
 * Keeping the channel module-level (singleton) prevents duplicate channel
 * registrations and lets every part of the form — HTML builder, controller,
 * writer — share a single diagnostic stream.
 *
 * @example
 * import { out } from './shared.js';
 * out.appendLine('[form] saving artifact');
 */
export const out = vscode.window.createOutputChannel('MD Artifacts: Form');
