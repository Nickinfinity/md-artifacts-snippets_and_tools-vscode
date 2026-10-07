import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VARIABLE_CONTEXT_VALUES } from '../src/ui/views/variablesView.provider.js';
import { VARIABLES_ROW_ACTIONS, VARIABLES_MENU_CATEGORIES, VARIABLES_INLINE_WHEN } from '../src/types/constants.js';

/**
 * Pins `package.json`'s Variables view menus to the provider's node kinds.
 *
 * VS Code reads `contributes.menus` before activation, so it is a static
 * mirror of a runtime fact — the same drift `package-menus.test.ts` guards for
 * the insert menus. The specific failure here is silent in both directions: a
 * `when: viewItem == subsets` that matches no node kind simply renders **no
 * menu entry**, and a node kind no menu names is a row with no actions. Neither
 * throws, neither logs, and no other test looks.
 */

const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
    contributes: {
        commands: { command: string }[];
        menus: Record<string, { command: string; when?: string; group?: string }[]>;
    };
};

const VARIABLES_PREFIX = 'md-artifacts.variables.';

suite('package.json — Variables view menus', () => {
    // A clause is `viewItem == x` (exact) or `viewItem =~ /re/` (a regex — file
    // actions use `/^file/` to reach every file shape; the apply buttons use
    // `/^(subset|fileFlat)$/`). The regex is evaluated as VS Code would.
    const clauses = (pkg.contributes.menus['view/item/context'] ?? []).flatMap(entry => {
        const when = entry.when ?? '';
        const exact = /viewItem == (\w+)/.exec(when)?.[1];
        const regex = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(when)?.[1];
        if (exact) { return [{ value: exact, test: (v: string) => v === exact }]; }
        if (regex) { const re = new RegExp(regex); return [{ value: `/${regex}/`, test: (v: string) => re.test(v) }]; }
        return [];
    });

    test('every viewItem the menus test for is a real provider context value', () => {
        assert.ok(clauses.length > 0, 'no view/item/context entries found — the tree has no actions');
        for (const c of clauses) {
            assert.ok(
                VARIABLE_CONTEXT_VALUES.some(v => c.test(v)),
                `menu targets viewItem "${c.value}", which no tree row produces — the entry silently never renders`,
            );
        }
    });

    test('every provider context value has at least one menu entry', () => {
        for (const v of VARIABLE_CONTEXT_VALUES) {
            assert.ok(clauses.some(c => c.test(v)), `context value "${v}" has no menu entry — that row is inert`);
        }
    });

    // Evaluates a menu entry's `viewItem` clause against one context value, as VS Code would.
    const reaches = (e: { when?: string }, v: string): boolean => {
        const when = e.when ?? '';
        const exact = /viewItem == (\w+)/.exec(when)?.[1];
        const regex = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(when)?.[1];
        return exact === v || (regex !== undefined && new RegExp(regex).test(v));
    };
    const entries = pkg.contributes.menus['view/item/context'] ?? [];
    const ADD_COMMANDS = ['addToBlank', 'addVar', 'newSubSet'].map(c => VARIABLES_PREFIX + c);

    test('the menus are exactly VARIABLES_ROW_ACTIONS (constants.ts) — no entry missing, extra or regrouped', () => {
        // THE rules live in the table; package.json is only the static mirror VS
        // Code reads before activation. Rebuilt here the way it was generated.
        const V = 'view == md-artifacts.variablesView && viewItem == ';
        const expected: { command: string; when: string; group: string }[] = [];
        for (const [row, a] of Object.entries(VARIABLES_ROW_ACTIONS)) {
            a.inline.forEach((cmd, i) => expected.push({
                command: VARIABLES_PREFIX + cmd,
                when: V + row + (VARIABLES_INLINE_WHEN[cmd] ? ` && ${VARIABLES_INLINE_WHEN[cmd]}` : ''),
                group: `inline@${i}`,
            }));
            VARIABLES_MENU_CATEGORIES.forEach((cat, ci) => a[cat].forEach((cmd, i) => expected.push({
                command: VARIABLES_PREFIX + cmd, when: V + row, group: `${ci + 1}_${cat}@${i}`,
            })));
        }
        const key = (e: { command: string; when?: string; group?: string }) => `${e.when} | ${e.group} | ${e.command}`;
        const actual = entries.filter(e => (e.when ?? '').includes('md-artifacts.variablesView')).map(key).sort();
        assert.deepStrictEqual(actual, expected.map(key).sort());
    });

    test('the table covers every row kind, and names only contributed commands', () => {
        assert.deepStrictEqual(Object.keys(VARIABLES_ROW_ACTIONS).sort(), [...VARIABLE_CONTEXT_VALUES].sort());
        const contributed = new Set(pkg.contributes.commands.map(c => c.command));
        for (const a of Object.values(VARIABLES_ROW_ACTIONS)) {
            for (const cmd of [a.inline, ...VARIABLES_MENU_CATEGORIES.map(c => a[c])].flat()) {
                assert.ok(contributed.has(VARIABLES_PREFIX + cmd), `${cmd} is not a contributed command`);
            }
        }
    });

    test('every row has exactly one inline +, chosen by its file shape', () => {
        const expected: Record<string, string> = {
            fileBlank: 'addToBlank', // asks: Variable (one block) or Sub-set
            fileFlat:  'addVar',     // one untitled block — no sub-set level
            fileSets:  'newSubSet',  // sub-sets, even just one titled one
            subset:    'addVar',
        };
        for (const [row, cmd] of Object.entries(expected)) {
            const inlineAdds = entries
                .filter(e => (e.group ?? '').startsWith('inline') && reaches(e, row) && ADD_COMMANDS.includes(e.command))
                .map(e => e.command);
            assert.deepStrictEqual(inlineAdds, [VARIABLES_PREFIX + cmd], `${row} row`);
        }
    });

    test('a one-block file row keeps New sub-set on right-click, and its variables stay applicable', () => {
        const forFlat = entries.filter(e => reaches(e, 'fileFlat'));
        assert.ok(forFlat.some(e => e.command === VARIABLES_PREFIX + 'newSubSet' && !(e.group ?? '').startsWith('inline')));
        assert.ok(forFlat.some(e => e.command === VARIABLES_PREFIX + 'applyToPreview'));
        // A one-block file has no sub-set to delete — only a sub-set row offers it.
        assert.ok(!forFlat.some(e => e.command === VARIABLES_PREFIX + 'deleteSubSet'));
        assert.ok(entries.some(e => e.command === VARIABLES_PREFIX + 'deleteSubSet' && reaches(e, 'subset')));
    });

    test('applyToPreview is palette-hidden and saveCurrentValues is palette-visible', () => {
        // W1/H1.1. The asymmetry is the whole design: `applyToPreview` takes a
        // clicked `subset` node, so a palette invocation would arrive with
        // `node === undefined` and refuse — it is hidden by an explicit
        // `when: false`. `saveCurrentValues` takes no node and is deliberately
        // invokable from the palette with no preview open (it shows the O-2
        // information message). Nothing else pins this, and both failure modes
        // are silent: a missing `when: false` renders a command that always
        // refuses, and a stray one hides a command the user is meant to reach.
        const palette = pkg.contributes.menus['commandPalette'] ?? [];
        const hidden = new Set(
            palette.filter(e => e.when === 'false').map(e => e.command),
        );

        assert.ok(
            hidden.has(`${VARIABLES_PREFIX}applyToPreview`),
            'applyToPreview must carry a commandPalette when:false — it needs a clicked subset node',
        );
        assert.ok(
            !hidden.has(`${VARIABLES_PREFIX}saveCurrentValues`),
            'saveCurrentValues must stay palette-visible — it takes no node and is valid with no preview open',
        );
    });

    test('every view/title entry is scoped to the Variables view', () => {
        // Without `view == …`, a `view/title` command renders on EVERY view's
        // title bar — silently, since it is otherwise a valid command.
        for (const entry of pkg.contributes.menus['view/title'] ?? []) {
            if (!entry.command.startsWith(VARIABLES_PREFIX)) { continue; }
            assert.ok(
                entry.when?.includes('view == md-artifacts.variablesView'),
                `${entry.command} is in view/title without a view scope — it renders on every view's title bar`,
            );
        }
    });

    test('every menu entry points at a contributed command', () => {
        const declared = new Set(pkg.contributes.commands.map(c => c.command));
        const entries = [
            ...(pkg.contributes.menus['view/item/context'] ?? []),
            ...(pkg.contributes.menus['view/title'] ?? []),
        ].filter(e => e.command.startsWith(VARIABLES_PREFIX));

        for (const entry of entries) {
            assert.ok(
                declared.has(entry.command),
                `${entry.command} is in a menu but has no contributes.commands entry — the item renders with no label`,
            );
        }
    });
});
