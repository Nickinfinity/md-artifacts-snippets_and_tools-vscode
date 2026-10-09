import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { artifactToFormModel, unsupportedEditReason } from '../src/commands/create-prefill.helpers.js';
import { parseFromContent } from '../src/services/parser.service.js';
import { serializeArtifact } from '../src/services/artifact-serializer.service.js';
import type { ArtifactFormModel } from '../src/types/artifact-form.types.js';

/**
 * Guards Edit opening the artifact form instead of the raw `.md`.
 *
 * The load-bearing property is the **round trip**: the form is now an editing
 * surface for existing files, so anything `artifactToFormModel` drops is
 * silently deleted from the user's vault the first time they press Save. A
 * field-by-field assertion is the only thing standing between a missing key
 * here and data loss on disk.
 */
suite('edit mode — artifact → form model', () => {

    /** Parses a `.md` body the way the edit command does. */
    function parse(md: string) {
        const parsed = parseFromContent(md, '/v/Snippets/demo.md', '/v');
        assert.ok(parsed, 'fixture failed to parse');
        return parsed;
    }

    test('a single-block snippet round-trips through the form model', () => {
        const original = [
            '---',
            'artifactType: Snippet',
            'title: Demo',
            'description: A demo snippet.',
            'language: typescript',
            'tags: [a, b]',
            '---',
            '',
            '```typescript',
            'const answer = 42;',
            '```',
            '',
        ].join('\n');

        const model = artifactToFormModel(parse(original));

        assert.strictEqual(model.artifactType, 'Snippet');
        assert.strictEqual(model.title, 'Demo');
        assert.strictEqual(model.description, 'A demo snippet.');
        assert.deepStrictEqual(model.tags, ['a', 'b']);
        assert.strictEqual(model.blocks?.length, 1);
        assert.strictEqual(model.blocks?.[0]?.code, 'const answer = 42;');
        assert.strictEqual(model.blocks?.[0]?.language, 'typescript');
        assert.strictEqual(model.blocks?.[0]?.heading, '', 'single-block must carry an empty heading');
    });

    test('re-serializing an unedited model preserves the content fields', () => {
        // The strongest available statement of "editing loses nothing": parse →
        // model → serialize → parse, and compare the second parse to the first.
        const original = [
            '---',
            'artifactType: Snippet',
            'title: Demo',
            'description: A demo snippet.',
            'language: typescript',
            'tags: [a, b]',
            '---',
            '',
            '```typescript',
            'const answer = 42;',
            '```',
            '',
        ].join('\n');

        const first = parse(original);
        const model = artifactToFormModel(first) as ArtifactFormModel;
        const round = parse(serializeArtifact(model));

        assert.strictEqual(round.frontmatter.title, first.frontmatter.title);
        assert.strictEqual(round.frontmatter.description, first.frontmatter.description);
        assert.deepStrictEqual(round.frontmatter.tags, first.frontmatter.tags);
        assert.strictEqual(round.frontmatter.artifactType, first.frontmatter.artifactType);
        assert.strictEqual(round.code, first.code);
    });

    test('a multi-block artifact keeps every block, heading and fence language', () => {
        const original = [
            '---',
            'artifactType: Snippet',
            'title: Two',
            'language: bash',
            '---',
            '',
            '## Development',
            '',
            'Local dev.',
            '',
            '```bash',
            'npm run dev',
            '```',
            '',
            '## Production',
            '',
            '```bash',
            'npm run build',
            '```',
            '',
        ].join('\n');

        const model = artifactToFormModel(parse(original));

        assert.strictEqual(model.blocks?.length, 2, 'lost a block — Save would delete it from the vault');
        assert.strictEqual(model.blocks?.[0]?.heading, 'Development');
        assert.strictEqual(model.blocks?.[0]?.code, 'npm run dev');
        assert.strictEqual(model.blocks?.[0]?.language, 'bash');
        assert.strictEqual(model.blocks?.[1]?.heading, 'Production');
        assert.strictEqual(model.blocks?.[1]?.code, 'npm run build');
    });

    test('whole-file type keeps its type-only frontmatter', () => {
        const original = [
            '---',
            'artifactType: AIAgentsConfig',
            'title: Claude',
            'target: CLAUDE.md',
            'provider: anthropic',
            'model: opus',
            'version: 1.0',
            '---',
            '',
            '```markdown',
            '# Rules',
            '```',
            '',
        ].join('\n');

        const model = artifactToFormModel(parse(original));

        // These feed resolveOutputFileName; dropping target: renames the file.
        assert.strictEqual(model.target, 'CLAUDE.md');
        assert.strictEqual(model.provider, 'anthropic');
        assert.strictEqual(model.model, 'opus');
        // Unquoted on purpose: `parser.service` keeps a quoted YAML scalar's
        // quote characters in the value ("1" parses to '"1"'), so a quoted
        // fixture would be asserting that quirk rather than this conversion.
        assert.strictEqual(model.version, '1.0');
    });
});

suite('edit mode — wiring', () => {

    const panelSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ui', 'panels', 'artifactForm', 'panel.ts'),
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
        assert.ok(
            panelSource.includes("this.opts.mode === 'edit' && this.opts.sourceUri"),
            'save path does not branch on edit mode, so an edit would be saved as a new file',
        );
        const saveInPlaceAt = panelSource.indexOf('private async saveInPlace');
        const pickDestAt    = panelSource.indexOf('await pickDestFolder');
        assert.ok(saveInPlaceAt > 0, 'saveInPlace missing');
        assert.ok(
            panelSource.indexOf("mode === 'edit'") < pickDestAt,
            'the edit branch must come before the destination picker',
        );
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

    test('the delete goes to the trash, never a hard unlink', () => {
        assert.ok(
            helperSource.includes('useTrash: true'),
            'artifact delete is unrecoverable — it must go to the OS trash',
        );
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
        // The confirm must be awaited *before* the delete call, not after.
        const confirmAt = helperSource.indexOf('async function confirmDeleteFile');
        const deleteAt  = helperSource.indexOf('async function deleteArtifactFile');
        assert.ok(confirmAt > 0 && deleteAt > 0, 'delete helpers missing');
        assert.ok(
            panelSource.indexOf('confirmDeleteFile(sourceUri)') < panelSource.indexOf('deleteArtifactFile(sourceUri)'),
            'the file is deleted before the user confirms',
        );
    });

    test('a cancelled confirmation deletes nothing and leaves the form open', () => {
        // `dispose()` must sit behind the confirmed check; an early dispose would
        // close the form even when the user pressed Cancel.
        const handlerAt = panelSource.indexOf('private async handleDeleteEntire');
        const handler   = panelSource.slice(handlerAt, handlerAt + 900);
        assert.ok(handler.includes('if (!confirmed)'), 'no cancel branch in the delete handler');
        assert.ok(
            handler.indexOf('if (!confirmed)') < handler.indexOf('this.dispose()'),
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

/**
 * Guards the refusals that stop edit mode destroying content.
 *
 * The form round-trips through the webview, where `extractModel()` rebuilds the
 * model from DOM fields — so a frontmatter key with no input is gone by the
 * time Save runs. For a create that is harmless; for an edit it deletes the
 * user's content. Each case below was confirmed to lose data before the guard
 * existed.
 */
suite('edit mode — refuses what the form cannot round-trip', () => {

    function parseMd(md: string) {
        const parsed = parseFromContent(md, '/v/AIPrompts/demo.md', '/v');
        assert.ok(parsed, 'fixture failed to parse');
        return parsed;
    }

    test('a flagged artifact is refused, not silently reduced to a fence', () => {
        // The flag markers and every note line outside the region are not
        // modelled at all — saving replaced the whole file with one fence.
        const md = [
            '---',
            'artifactType: AIPrompt',
            'title: Review',
            '---',
            '',
            'Notes that are not part of the artifact.',
            '',
            '%%oa:start%%',
            'Review the repo.',
            '%%oa:end%%',
            '',
        ].join('\n');
        const parsed = parseMd(md);
        const reason = unsupportedEditReason(parsed, md);
        assert.ok(reason, 'a flagged artifact was accepted for editing');
        assert.match(reason, /flags/i);
    });

    test('a template index is refused — index links are read-side only', () => {
        const md = [
            '---',
            'artifactType: Template',
            'title: Scaffold',
            'index: true',
            '---',
            '',
            '```markdown',
            '- [[one]]',
            '```',
            '',
        ].join('\n');
        const reason = unsupportedEditReason(parseMd(md), md);
        assert.ok(reason, 'an index artifact was accepted for editing');
        assert.match(reason, /index/i);
    });

    test('an artifact declaring env: is editable — the model carries the field now', () => {
        const md = [
            '---',
            'artifactType: Snippet',
            'title: Demo',
            'env: prod',
            'language: bash',
            '---',
            '',
            '```bash',
            'echo hi',
            '```',
            '',
        ].join('\n');
        // H7.0b gave `ArtifactFormModel` an `env` field and the serializer an emit
        // line, so the key now survives a form round trip. The refusal existed
        // only because it did not.
        assert.strictEqual(
            unsupportedEditReason(parseMd(md), md),
            undefined,
            'an env-carrying artifact is refused although the model now carries env'
        );
    });

    test('an ordinary snippet is still editable', () => {
        const md = [
            '---',
            'artifactType: Snippet',
            'title: Demo',
            'language: bash',
            '---',
            '',
            '```bash',
            'echo hi',
            '```',
            '',
        ].join('\n');
        assert.strictEqual(unsupportedEditReason(parseMd(md), md), undefined);
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
        assert.ok(commandSource.includes('isPathWithin('), 'no containment check on the edit path');
        assert.ok(
            commandSource.indexOf('isPathWithin(') < commandSource.indexOf('parseArtifactFile('),
            'the file is read before containment is checked',
        );
    });

    test('a non-create-form type is rejected with a message, not a thrown command', () => {
        // getFormConfig('Variables') throws; ungated, the Edit button would fail
        // as an unhandled command error.
        assert.ok(commandSource.includes('getCreateFormTypes()'), 'no create-form gate on the edit command');
    });

    test('the round-trip refusal runs before the form opens', () => {
        assert.ok(
            commandSource.indexOf('unsupportedEditReason(') < commandSource.indexOf('openArtifactFormPanel('),
            'the form opens before the lossy-edit check',
        );
    });
});
