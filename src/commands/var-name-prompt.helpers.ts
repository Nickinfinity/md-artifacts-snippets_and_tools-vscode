import * as vscode from 'vscode';
import type { CommandIO } from './variables.command.helpers.js';

/** Every variable name carries this prefix; prompts ask only for what follows it. */
const VK_PREFIX = 'VK-';

/**
 * Puts the `VK-` prefix on a name typed without it. An already-prefixed name
 * (pasted in full) is returned unchanged, so it is never doubled; `''` stays
 * `''` so the mutator's own validation still rejects a missing name.
 *
 * Mirrors the var-set form's client-side `vkName` (`varsetForm.render.ts`),
 * which cannot import this.
 *
 * @param rest - Text typed after the fixed prefix.
 * @returns The full `VK-xxx` name.
 *
 * @example
 * withVkPrefix('host');    // → 'VK-host'
 * withVkPrefix('VK-host'); // → 'VK-host'
 */
export function withVkPrefix(rest: string): string {
    if (rest === '' || rest.startsWith(VK_PREFIX)) { return rest; }
    return VK_PREFIX + rest;
}

/**
 * Asks for a variable name with `VK-` fixed: the box holds only the part
 * after it, and a live info line shows the full name that will be saved.
 * An input box cannot render a non-editable prefix, so this is the closest
 * the Variables pane gets to the form's fixed label.
 *
 * @param io      - Interaction bag (`showInputBox`).
 * @param prompt  - Prompt line shown under the box.
 * @param current - Current full name when renaming; its prefix is stripped for editing.
 * @returns The full `VK-xxx` name, or `undefined` on Cancel/Escape.
 *
 * @example
 * await promptVarName(io, vscode.l10n.t('Variable name'));            // 'host' typed → 'VK-host'
 * await promptVarName(io, vscode.l10n.t('New variable name'), 'VK-a'); // box starts as 'a'
 */
export async function promptVarName(io: CommandIO, prompt: string, current = ''): Promise<string | undefined> {
    const rest = current.startsWith(VK_PREFIX) ? current.slice(VK_PREFIX.length) : current;
    const typed = await io.showInputBox({
        prompt,
        value: rest,
        placeHolder: vscode.l10n.t('Name after {0}', VK_PREFIX),
        validateInput: text => text === '' ? undefined : {
            message: vscode.l10n.t('Saved as {0}', withVkPrefix(text)),
            severity: vscode.InputBoxValidationSeverity.Info,
        },
    });
    return typed === undefined ? undefined : withVkPrefix(typed);
}
