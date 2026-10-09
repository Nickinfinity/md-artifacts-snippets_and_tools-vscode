import * as vscode from 'vscode';
import type { VariableNodeKind } from '../ui/views/variablesView.provider.js';

/**
 * Input to `confirmTextFor` — one delete confirmation request.
 *
 * A discriminated union, not a flat shape with optional fields: a "required
 * in practice" field that is typed optional is a comment pretending to be
 * an invariant, and it degrades — an omitted `parent` renders the literal
 * string `"undefined"` into an irreversible-action modal instead of failing
 * to compile. Each variant carries exactly what makes that kind's target
 * unambiguous *and* quantified: a count where the delete has substructure,
 * a parent where the name alone does not identify the row (duplicate names
 * at every level below `file` are legal by design — `addVar`'s uniqueness
 * check is scoped to one sub-set, `addSubSet`'s to one file, so `VK-host` in
 * both `Dev` and `Prod`, or two files each owning a `Production` sub-set,
 * are the normal case, not an edge case). `file`'s name self-identifies
 * (nothing above it in the tree), so it carries neither `parent`; `var` is
 * an atomic leaf (nothing below it), so it carries no `varCount`.
 */
export type ConfirmInput =
    | { kind: 'file'; name: string; varCount: number }
    | { kind: 'subset'; name: string; varCount: number; parent: string }
    | { kind: 'var'; name: string; parent: string };

/**
 * Type-level pin, not runtime code: fails to compile the moment
 * `ConfirmInput['kind']` and `VariableNodeKind` diverge in **either**
 * direction.
 *
 * `ConfirmInput` is a hand-written union, so it does not automatically track
 * `VARIABLE_NODE_KINDS` (`variablesView.provider.ts`) the way a plain
 * `kind: VariableNodeKind` field would — a fourth node kind added there
 * would silently stop being a compile error here, undoing the guarantee
 * `assertNever` exists for. This checks both subset directions: every
 * `ConfirmInput` kind must be a real `VariableNodeKind`, and every
 * `VariableNodeKind` must be a `ConfirmInput` kind. Read the assignment
 * below it, not this alias, when tracing a failure here.
 */
type ConfirmInputKindsMatchVariableNodeKind =
    ConfirmInput['kind'] extends VariableNodeKind
        ? (VariableNodeKind extends ConfirmInput['kind'] ? true : never)
        : never;
const kindsPinnedToVariableNodeKind: ConfirmInputKindsMatchVariableNodeKind = true;

/**
 * Pluralises the word "variable" for a count — `1` is singular, everything
 * else (including `0`) is plural.
 *
 * @param count - Number of variables.
 * @returns `'variable'` when `count === 1`, else `'variables'`.
 *
 * @example
 * pluralVariable(1)  // → 'variable'
 * pluralVariable(0)  // → 'variables'
 */
function pluralVariable(count: number): string {
    return count === 1 ? vscode.l10n.t('variable') : vscode.l10n.t('variables');
}

/**
 * Exhaustiveness guard — a compile-time trip wire, not a runtime path.
 *
 * `confirmTextFor`'s `switch` narrows `kind` to `never` in `default` only
 * when every `VariableNodeKind` literal has its own `case`. Adding a fourth
 * kind to `VARIABLE_NODE_KINDS` (`variablesView.provider.ts`) without adding
 * a matching `case` here makes `x` something other than `never`, which is a
 * compile error at this call site — the "silently missing message" bug
 * turned into a build failure instead.
 *
 * @param x - Value the caller has proven unreachable.
 * @returns Never returns; always throws.
 */
function assertNever(x: never): never {
    throw new Error(`variables.confirm.helpers: unhandled node kind ${String(x)}`);
}

/**
 * Builds the destructive-confirmation modal message for one Variables-tree
 * delete. The **one** authority for this wording — every delete command
 * (delete var, delete sub-set, delete file) routes through it, so the three
 * messages can never drift apart or say the same thing twice.
 *
 * Pure string builder: still no I/O, still decides nothing about *how* the
 * confirmation is shown — the caller wraps the result in
 * `vscode.window.showWarningMessage(text, { modal: true }, deleteLabel)`
 * (`variables.command.helpers.ts`'s `defaultIO.confirm`), where `deleteLabel`
 * is `vscode.l10n.t('Delete')` **hoisted once and compared back by equality**
 * (`choice === deleteLabel`) — the label is localised too, so the caller
 * cannot compare the live choice against the English literal `'Delete'`
 * without silently failing every non-English delete.
 *
 * The `vscode` import on line 1 is deliberate, not drift: this file composes
 * plural-sensitive *user-facing sentences* (`vscode.l10n.t` with `{0}`-style
 * placeholders), so it is localised in place — unlike the `vscode`-free
 * *services* that Wave 5's accepted-gap-1 exempts. What decides that is this
 * file's directory (`src/commands/`, which carries no vscode-free guard), not
 * this helper's shape. `pluralVariable` is localised for the same reason: it
 * picks `'variable'`/`'variables'` **inside** these sentences, and Spanish
 * plural rules do not follow English — wrapping the sentence but leaving the
 * word literal would strand an English `variable(s)` inside every translated
 * delete confirmation.
 *
 * @param input - The node kind and the fields that variant requires — see
 * `ConfirmInput`.
 * @returns The modal's message text, ending in "This cannot be undone."
 *
 * @example
 * confirmTextFor({ kind: 'file', name: 'dev.md', varCount: 12 })
 * // → 'Delete dev.md and its 12 variables? This cannot be undone.'
 * @example
 * confirmTextFor({ kind: 'var', name: 'VK-host', parent: 'Prod' })
 * // → 'Delete variable VK-host from sub-set Prod? This cannot be undone.'
 */
export function confirmTextFor(input: ConfirmInput): string {
    switch (input.kind) {
        case 'file': {
            const { name, varCount } = input;
            return vscode.l10n.t('Delete {0} and its {1} {2}? This cannot be undone.', name, varCount, pluralVariable(varCount));
        }
        case 'subset': {
            const { name, varCount, parent } = input;
            return vscode.l10n.t('Delete sub-set {0} in {1} and its {2} {3}? This cannot be undone.', name, parent, varCount, pluralVariable(varCount));
        }
        case 'var': {
            const { name, parent } = input;
            return vscode.l10n.t('Delete variable {0} from sub-set {1}? This cannot be undone.', name, parent);
        }
        default:
            return assertNever(input);
    }
}
