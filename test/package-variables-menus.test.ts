import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VARIABLE_CONTEXT_VALUES } from '../src/ui/views/variablesView.provider.js';

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
    // actions use `/^file/` to also reach `fileSingle`; the apply buttons use
    // `/^(subset|fileSingle)$/`). The regex is evaluated as VS Code would.
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

    test('a one-sub-set file row carries the sub-set actions', () => {
        const forSingle = (pkg.contributes.menus['view/item/context'] ?? [])
            .filter(e => (e.when ?? '').includes('viewItem == fileSingle')).map(e => e.command);
        assert.ok(forSingle.includes('md-artifacts.variables.addVar'));
        assert.ok(forSingle.includes('md-artifacts.variables.applyToPreview'));
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
