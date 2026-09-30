import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VARIABLE_NODE_KINDS } from '../src/ui/views/variablesView.provider.js';

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
    test('every viewItem the menus test for is a real provider node kind', () => {
        const kinds = new Set<string>(VARIABLE_NODE_KINDS);
        const referenced = (pkg.contributes.menus['view/item/context'] ?? [])
            .map(entry => /viewItem == (\w+)/.exec(entry.when ?? '')?.[1])
            .filter((v): v is string => v !== undefined);

        assert.ok(referenced.length > 0, 'no view/item/context entries found — the tree has no actions');
        for (const viewItem of referenced) {
            assert.ok(
                kinds.has(viewItem),
                `menu targets viewItem "${viewItem}", which no VariableNode.kind produces — the entry silently never renders`,
            );
        }
    });

    test('every provider node kind has at least one menu entry', () => {
        const referenced = new Set(
            (pkg.contributes.menus['view/item/context'] ?? [])
                .map(entry => /viewItem == (\w+)/.exec(entry.when ?? '')?.[1]),
        );
        for (const kind of VARIABLE_NODE_KINDS) {
            assert.ok(referenced.has(kind), `node kind "${kind}" has no menu entry — that row is inert`);
        }
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
