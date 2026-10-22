import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { runMigrateFrontmatter } from '../src/commands/migrate.command.js';
import { startEngine } from '../src/engine/engine.vscode.js';

const CASES = path.join(__dirname, '../../test/fixtures/engine/op-cases');
/** Engine reply (`expect`) of a recorded op case. */
const reply = (op: string, name: string): unknown => (JSON.parse(fs.readFileSync(path.join(CASES, op, `${name}.json`), 'utf8')) as { expect: unknown }).expect;

suite('runMigrateFrontmatter', () => {
    let fake: FakeEngine;
    let handle: { dispose(): void };
    let lines: string[];
    const applies = (): { params: unknown }[] => fake.received.filter(r => r.method === 'migrate.frontmatter.apply');

    setup(() => {
        fake = createFakeEngine();
        handle = startEngine({ spawn: () => fake, enginePath: process.execPath, showError: () => Promise.resolve(undefined) });
        lines = [];
    });
    teardown(() => handle.dispose());

    const run = (answer: boolean, seen: number[] = []): Promise<void> =>
        runMigrateFrontmatter(async n => { seen.push(n); return answer; }, l => lines.push(l));

    test('confirmed: apply sends exactly the planned {path, hash} pairs, in order, never skipped', async () => {
        const plan = reply('migrate.frontmatter.plan', 'ok') as { changes: { path: string; hash: string }[] };
        fake.on('migrate.frontmatter.plan', () => ({ result: plan }));
        fake.on('migrate.frontmatter.apply', () => ({ result: { results: [], written: 5, skipped: 0 } }));
        const seen: number[] = [];
        await run(true, seen);
        assert.deepStrictEqual(seen, [5]);
        assert.strictEqual(applies().length, 1);
        assert.deepStrictEqual((applies()[0]?.params as { files: unknown }).files, plan.changes.map(({ path: p, hash }) => ({ path: p, hash })));
        assert.ok(lines.some(l => l.includes('Commands/blank.md')), 'plan skips are reported');
    });

    test('declined: zero apply', async () => {
        fake.on('migrate.frontmatter.plan', () => ({ result: reply('migrate.frontmatter.plan', 'ok') }));
        await run(false);
        assert.strictEqual(applies().length, 0);
    });

    test('empty plan: zero apply, never asks, up-to-date line', async () => {
        fake.on('migrate.frontmatter.plan', () => ({ result: reply('migrate.frontmatter.plan', 'empty') }));
        const seen: number[] = [];
        await run(true, seen);
        assert.strictEqual(applies().length, 0);
        assert.deepStrictEqual(seen, []);
        assert.ok(lines.some(l => l.includes('already up to date')));
    });

    test('stale apply result: report lists the skip, no throw', async () => {
        fake.on('migrate.frontmatter.plan', () => ({ result: reply('migrate.frontmatter.plan', 'ok') }));
        fake.on('migrate.frontmatter.apply', () => ({ result: reply('migrate.frontmatter.apply', 'stale') }));
        await run(true);
        assert.ok(lines.some(l => l.includes('skipped Snippets/legacy.md')), lines.join('\n'));
    });
});
