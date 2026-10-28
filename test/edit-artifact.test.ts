import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { artifactToFormModel } from '../src/commands/create-prefill.helpers.js';
import { toParsedArtifactFile } from '../src/engine/adapt.js';
import { recordedRead } from './recorded.js';

/**
 * Guards Edit opening the artifact form instead of the raw `.md`.
 *
 * The load-bearing property is **losslessness**: the form is now an editing
 * surface for existing files, so anything `artifactToFormModel` drops is
 * silently deleted from the user's vault the first time they press Save. A
 * field-by-field assertion is the only thing standing between a missing key
 * here and data loss on disk. The serialize round trip itself is the engine's
 * (`serialize/form-*`, `rs-idem-*`).
 */
suite('edit mode — artifact → form model', () => {

    /** The pinned engine's `artifact.read` of a recorded source, as the edit command adapts it. */
    function parse(name: string) {
        return toParsedArtifactFile(recordedRead(name), '/v');
    }

    test('a single-block snippet round-trips through the form model', () => {
        const model = artifactToFormModel(parse('edit-1'));

        assert.strictEqual(model.artifactType, 'Snippet');
        assert.strictEqual(model.title, 'Demo');
        assert.strictEqual(model.description, 'A demo snippet.');
        assert.deepStrictEqual(model.tags, ['a', 'b']);
        assert.strictEqual(model.blocks?.length, 1);
        assert.strictEqual(model.blocks?.[0]?.code, 'const answer = 42;');
        assert.strictEqual(model.blocks?.[0]?.language, 'typescript');
        assert.strictEqual(model.blocks?.[0]?.heading, '', 'single-block must carry an empty heading');
    });

    test('a multi-block artifact keeps every block, heading and fence language', () => {
        const model = artifactToFormModel(parse('edit-3'));

        assert.strictEqual(model.blocks?.length, 2, 'lost a block — Save would delete it from the vault');
        assert.strictEqual(model.blocks?.[0]?.heading, 'Development');
        assert.strictEqual(model.blocks?.[0]?.code, 'npm run dev');
        assert.strictEqual(model.blocks?.[0]?.language, 'bash');
        assert.strictEqual(model.blocks?.[1]?.heading, 'Production');
        assert.strictEqual(model.blocks?.[1]?.code, 'npm run build');
    });

    test('whole-file type keeps its type-only frontmatter', () => {
        const model = artifactToFormModel(parse('edit-4'));

        // These feed resolveOutputFileName; dropping target: renames the file.
        assert.strictEqual(model.target, 'CLAUDE.md');
        assert.strictEqual(model.provider, 'anthropic');
        assert.strictEqual(model.model, 'opus');
        assert.strictEqual(model.version, '1.0');
    });
});

suite('edit mode — wiring', () => {

    const panelSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactForm', 'panel.ts'),
        'utf8',
    );
    const helperSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactForm', 'panel.helpers.ts'),
        'utf8',
    );
    const previewSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactPicker', 'preview.ts'),
        'utf8',
    );
    const extensionSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'extension.ts'),
        'utf8',
    );

    test('the edit command is registered — an unregistered command fails silently', () => {
        assert.ok(
            extensionSource.includes('registerEditArtifactCommand(context)'),
            'edit command never registered; the Edit button would do nothing at all',
        );
    });

    test('Edit routes to the form command, not the raw .md editor', () => {
        assert.ok(
            previewSource.includes('EDIT_ARTIFACT_COMMAND_ID'),
            'preview no longer opens the form for Edit',
        );
        assert.strictEqual(
            /this\.fullEdit\.start\(/.exec(previewSource),
            null,
            'Edit still opens the raw .md through FullEditController',
        );
    });

    test('edit mode saves in place — no folder picker, no filename prompt', () => {
        // The engine half moved into `saveToEngine` (panel.helpers.ts); `saveInPlace` is gone with it.
        const saveAt   = helperSource.indexOf('export async function saveToEngine');
        const editAt   = helperSource.indexOf("opts.mode === 'edit'", saveAt);
        const pickDestAt = helperSource.indexOf('io.pickDir(', saveAt);
        assert.ok(saveAt > 0 && editAt > saveAt, 'save path does not branch on edit mode, so an edit would be saved as a new file');
        assert.ok(pickDestAt > editAt, 'the edit branch must come before the destination picker');
    });
});

/**
 * Guards the Delete Artifact button.
 *
 * It now removes a file from the user's vault, so the two properties that
 * matter are that it cannot fire without a confirmation and that the delete is
 * recoverable. Both are asserted against the source, because the alternative —
 * driving the real modal — is not reachable from this suite.
 */
suite('delete artifact', () => {

    const panelSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactForm', 'panel.ts'),
        'utf8',
    );
    const helperSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactForm', 'panel.helpers.ts'),
        'utf8',
    );

    test('the delete is an engine artifact.delete (permanent), never workspace.fs', () => {
        // W3-b: the engine has no trash; the confirm text says so. Behaviour is in artifact-form-engine.test.ts.
        assert.ok(helperSource.includes("'artifact.delete'"), 'the delete does not go through the engine');
        assert.ok(!helperSource.includes('workspace.fs'), 'the delete still touches the workspace filesystem');
        assert.ok(helperSource.includes('cannot be undone'), 'the confirm does not say the delete is permanent');
    });

    test('deletion is gated on a modal confirmation', () => {
        // `modal: true` lives in the shared confirm service now, not inline —
        // asserted there so the refactor cannot quietly drop the modal flag.
        const confirmSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'services', 'confirm.service.ts'),
            'utf8',
        );
        assert.ok(confirmSource.includes('modal: true'), 'the shared confirm helper is not modal');
        assert.ok(helperSource.includes('confirmModal('), 'delete does not route through the confirm helper');
        // The confirm must be awaited *before* the engine delete, inside deleteWithConfirm.
        const fnAt = helperSource.indexOf('export async function deleteWithConfirm');
        assert.ok(fnAt > 0, 'deleteWithConfirm missing');
        const confirmAt = helperSource.indexOf('confirmDeleteFile(', fnAt);
        const deleteAt  = helperSource.indexOf("'artifact.delete'", fnAt);
        assert.ok(confirmAt > fnAt && deleteAt > confirmAt, 'the file is deleted before the user confirms');
    });

    test('a cancelled confirmation deletes nothing and leaves the form open', () => {
        // `dispose()` must sit behind the confirmed check; an early dispose would
        // close the form even when the user pressed Cancel.
        const handlerAt = panelSource.indexOf('private async handleDeleteEntire');
        const handler   = panelSource.slice(handlerAt, handlerAt + 900);
        assert.ok(handler.includes('if (!done)'), 'no cancel branch in the delete handler');
        assert.ok(
            handler.indexOf('if (!done)') < handler.indexOf('this.dispose()'),
            'the form disposes before the confirmation is checked',
        );
    });

    test('create mode deletes no file — there is none yet', () => {
        const handlerAt = panelSource.indexOf('private async handleDeleteEntire');
        const handler   = panelSource.slice(handlerAt, handlerAt + 900);
        assert.ok(
            handler.includes("this.opts.mode === 'edit' ? this.opts.sourceUri : undefined"),
            'create mode must not resolve a file to delete',
        );
        assert.ok(handler.includes('confirmDiscardDraft'), 'create mode has no discard confirmation');
    });
});

suite('edit command — boundaries', () => {

    const commandSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'commands', 'editArtifact.command.ts'),
        'utf8',
    );

    test('SEC: the path is contained to the vault before it is read', () => {
        // The command is callable by any extension, and the path it is given is
        // later written by save-in-place and trash-deleted by Delete Artifact.
        const guardAt = commandSource.indexOf('toVaultPath(');
        const readAt  = commandSource.indexOf("'artifact.read'");
        assert.ok(guardAt > 0, 'no containment check on the edit path');
        assert.ok(readAt > 0, 'the edit command no longer reads through the engine');
        assert.ok(guardAt < readAt, 'the file is read before containment is checked');
    });

    test('a non-create-form type is rejected with a message, not a thrown command', () => {
        // getFormConfig('Variables') throws; ungated, the Edit button would fail
        // as an unhandled command error.
        assert.ok(commandSource.includes('getCreateFormTypes()'), 'no create-form gate on the edit command');
    });

    test('no lossy-edit refusal: flagged and index files open in the form (W-UI a)', () => {
        const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.ok(!strip(commandSource).includes('unsupportedEditReason'), 'the command still gates on the stale refusal');
        const helpers = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'create-prefill.helpers.ts'), 'utf8');
        assert.ok(!strip(helpers).includes('export function unsupportedEditReason'), 'the stale refusal still exists');
    });
});
