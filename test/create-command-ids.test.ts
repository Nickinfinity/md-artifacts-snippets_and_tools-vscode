import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildCreateCommandIds,
    createCommandId,
    createTerminalCommandId,
    createIndexCommandId,
    deriveCreateSurfaceEntries,
} from '../src/commands/create-from-surface.command.js';
import { getCreateTypesForSurface, getIndexCapableTypes, getEntry } from '../src/services/artifact-type-config.service.js';
import type { ArtifactContext } from '../src/types/artifact.types.js';
import type { ArtifactType } from '../src/types/parsed-artifact.types.js';

/**
 * T6 — `buildCreateCommandIds()` drift guard.
 *
 * Independently re-derives the §2 rule (createForm === true && isInContext)
 * over `ARTIFACTS`, via the same `artifact-type-config.service.ts` helpers
 * `package-create-menus.test.ts` uses for its own `package.json` guard — so
 * this test and that one can never quietly agree on a shared wrong answer
 * without both reflecting a real change to `ARTIFACTS`.
 */
suite('buildCreateCommandIds (T6)', () => {

    test('includes the AI Prompt terminal-surface create id', () => {
        assert.ok(buildCreateCommandIds().includes('md-artifacts.create.aiprompts.terminal'));
    });

    test('the id trio derives from createCommandId, one word over insert.command.ts', () => {
        assert.strictEqual(createCommandId('Snippets'), 'md-artifacts.create.snippets');
        assert.strictEqual(createTerminalCommandId('AIPrompts'), 'md-artifacts.create.aiprompts.terminal');
        assert.strictEqual(createIndexCommandId('Templates'), 'md-artifacts.create.templates.index');
    });

    // Reviewer finding: the derivation loop iterates (surface × type) and only
    // `buildCreateCommandIds()` deduped its *output ids* through a `Set` — the
    // entries themselves, which is what `registerCreateSurfaceCommands` actually
    // registers against `vscode.commands.registerCommand`, were never deduped.
    // A type declaring two non-both-context surfaces (no such type exists in
    // ARTIFACTS today, so this was latent, not live) resolves to the same
    // `commandId` on both — the loop pushed it twice, and a second
    // `registerCommand` call for one id throws, failing `activate()` outright.
    // `ARTIFACTS` is orchestrator-only here, so this injects a fake
    // `surfaceTypes` returning the real `'Snippet'` type for two surfaces
    // instead — reproducing the exact shape without touching constants.ts.
    test('a type declaring two non-both-context surfaces collapses to one entry, not two', () => {
        const fakeSurfaceTypes = (surface: Exclude<ArtifactContext, 'all'>): ArtifactType[] =>
            (surface === 'editor' || surface === 'explorer') ? ['Snippet'] : [];

        const entries = deriveCreateSurfaceEntries(fakeSurfaceTypes, () => []);

        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0]?.commandId, 'md-artifacts.create.snippets');
    });

    // Regression guard over the real ARTIFACTS table — stays green today (8
    // pushed, 8 unique) and would turn red the moment a future edit (e.g.
    // Variables, already `contexts: ['all']`, gaining createForm) reintroduces
    // a live collision, independent of the injected case above.
    test('the real derivation never produces two entries for the same commandId', () => {
        const ids = deriveCreateSurfaceEntries().map(e => e.commandId);
        assert.strictEqual(ids.length, new Set(ids).size);
    });

    test('the id set equals the §2 derivation over ARTIFACTS', () => {
        const SURFACES: readonly Exclude<ArtifactContext, 'all'>[] = ['editor', 'terminal', 'explorer'];
        const expected = new Set<string>();

        for (const surface of SURFACES) {
            for (const type of getCreateTypesForSurface(surface)) {
                const entry = getEntry(type);
                const bothContexts = entry.contexts.includes('editor') && entry.contexts.includes('terminal');
                expected.add(
                    surface === 'terminal' && bothContexts
                        ? createTerminalCommandId(entry.dir)
                        : createCommandId(entry.dir),
                );
            }
        }
        for (const type of getIndexCapableTypes()) {
            expected.add(createIndexCommandId(getEntry(type).dir));
        }

        assert.deepStrictEqual([...buildCreateCommandIds()].sort(), [...expected].sort());
    });

    test('every id exists in package.json contributes.commands', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
        ) as { contributes: { commands: { command: string }[] } };
        const declared = new Set(pkg.contributes.commands.map(c => c.command));

        for (const id of buildCreateCommandIds()) {
            assert.ok(declared.has(id), `${id} missing from package.json contributes.commands`);
        }
    });
});
