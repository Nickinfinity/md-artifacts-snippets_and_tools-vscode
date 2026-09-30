import * as vscode from 'vscode';

/**
 * Single OutputChannel reused across every artifactPicker module.
 *
 * Keeping the channel module-level (singleton) prevents duplicate channel
 * registrations and lets every part of the picker — navigator, preview panel,
 * full-editor controller — share a single diagnostic stream.
 *
 * @example
 * import { out } from './shared.js';
 * out.appendLine('[picker] something happened');
 */
export const out = vscode.window.createOutputChannel('MD Artifacts');
