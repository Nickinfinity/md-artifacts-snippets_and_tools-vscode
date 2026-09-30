import * as assert from 'node:assert';
import { parseFromContent } from '../src/services/parser.service.js';
import { resolveOutputFileName, validateSingleBlock } from '../src/services/template.service.js';

/**
 * Parser integration for flag-delimited payloads.
 *
 * The unit tests in `flags.service.test.ts` cover the scanner; these pin what the
 * parser *does* with the regions — which shape a flagged file takes, that flags
 * beat fences, and above all that a file **without** flags parses exactly as it
 * did before flags existed.
 */

const ROOT = '/vault/AIAgentsConf';
const FILE = '/vault/AIAgentsConf/reviewer.md';

/** Parses vault content as an AIAgentsConf file. */
function parse(content: string) {
    return parseFromContent(content, FILE, ROOT);
}

suite('flag-delimited payloads — single region', () => {

    const AGENT = [
        '---',
        'artifactType: AIAgentsConfig',
        'title: Code reviewer',
        'target: CLAUDE.md',
        '---',
        '',
        'Scratch notes that are not part of the config.',
        '',
        '%%oa:start%%',
        '# Reviewer',
        '',
        'Review <VK-repo> and report findings.',
        '',
        '```bash',
        'npm test',
        '```',
        '%%oa:end%%',
        '',
        'More scratch notes.',
    ].join('\n');

    test('the payload is the region, not the first code fence', () => {
        // Without flags the ```bash fence would become the whole artifact — the
        // exact failure this feature removes for markdown-native artifacts.
        const parsed = parse(AGENT);
        assert.ok(parsed.code.startsWith('# Reviewer'), `code started at: ${parsed.code.slice(0, 40)}`);
        assert.ok(parsed.code.includes('```bash\nnpm test\n```'), 'inner fences must survive verbatim');
        assert.ok(!parsed.code.includes('Scratch notes'), 'text outside the flags must not leak in');
    });

    test('one region is a single-block file (blocks stays empty)', () => {
        assert.deepStrictEqual(parse(AGENT).blocks, []);
    });

    test('language defaults to markdown — the payload is the note\'s own markdown', () => {
        assert.strictEqual(parse(AGENT).frontmatter.language, 'markdown');
    });

    test('an explicit frontmatter language still wins', () => {
        const content = '---\nartifactType: AIAgentsConfig\nlanguage: yaml\n---\n%%oa:start%%\nkey: value\n%%oa:end%%';
        assert.strictEqual(parse(content).frontmatter.language, 'yaml');
    });

    test('<VK-xxx> tokens in the payload are auto-detected', () => {
        assert.deepStrictEqual(parse(AGENT).vars, [{ name: 'VK-repo', defaultValue: '' }]);
    });

    test('a ```vks fence outside the flags supplies the defaults', () => {
        const content = [
            '---', 'artifactType: AIAgentsConfig', '---',
            '%%oa:start%%',
            'Review <VK-repo> on <VK-branch>.',
            '%%oa:end%%',
            '',
            'vars:',
            '```vks',
            'VK-repo=md-artifacts',
            '```',
        ].join('\n');
        assert.deepStrictEqual(parse(content).vars, [
            { name: 'VK-repo', defaultValue: 'md-artifacts' },
            { name: 'VK-branch', defaultValue: '' },
        ]);
    });
});

suite('flag-delimited payloads — named regions become blocks', () => {

    const MULTI = [
        '---', 'artifactType: AIAgentsConfig', 'title: Reviewer', '---',
        '%%oa:start Dev%%',
        'Review the dev branch of <VK-repo>.',
        '%%oa:end%%',
        '',
        'Notes between the two configs.',
        '',
        '%%oa:start Prod%%',
        'Review a production release.',
        '%%oa:end%%',
    ].join('\n');

    test('each region becomes a block keyed by its flag name', () => {
        const blocks = parse(MULTI).blocks;
        assert.strictEqual(blocks.length, 2);
        assert.deepStrictEqual(blocks.map(b => b.heading), ['Dev', 'Prod']);
        assert.ok(blocks[0].code.startsWith('Review the dev branch'));
        assert.ok(!blocks[0].code.includes('Notes between'), 'inter-region notes must not leak into a block');
    });

    test('blocks report markdown so the preview highlights them as markdown', () => {
        assert.ok(parse(MULTI).blocks.every(b => b.fenceLang === 'markdown'));
    });

    test('vars are detected per block', () => {
        const blocks = parse(MULTI).blocks;
        assert.deepStrictEqual(blocks[0].vars, [{ name: 'VK-repo', defaultValue: '' }]);
        assert.deepStrictEqual(blocks[1].vars, []);
    });

    test('code still exposes the first region for single-preview callers', () => {
        assert.ok(parse(MULTI).code.startsWith('Review the dev branch'));
    });
});

suite('flagged payloads flow through the whole-file (template + agent) path', () => {

    test('an agent config needs no code fence at all — target: names the file, region is its content', () => {
        const content = [
            '---', 'artifactType: AIAgentsConfig', 'title: Reviewer', 'target: CLAUDE.md', '---',
            'notes',
            '%%oa:start%%',
            '# Reviewer',
            'Be terse.',
            '%%oa:end%%',
        ].join('\n');
        const parsed = parse(content);

        // The two decisions the Create File flow makes, unchanged by flags.
        assert.deepStrictEqual(validateSingleBlock(parsed, 'agent config'), { ok: true });
        assert.strictEqual(resolveOutputFileName(parsed), 'CLAUDE.md');
        assert.strictEqual(parsed.code, '# Reviewer\nBe terse.');
    });

    test('a flagged template with no extension: falls back to .md via the markdown language', () => {
        const content = '---\nartifactType: Template\ntitle: Readme\n---\n%%oa:start%%\n# <VK-project>\n%%oa:end%%';
        const parsed = parseFromContent(content, '/vault/Templates/readme.md', '/vault/Templates');
        assert.strictEqual(resolveOutputFileName(parsed), 'Readme.md');
    });

    test('two flagged regions are rejected by the single-block guard, naming the count', () => {
        const content = '---\nartifactType: AIAgentsConfig\n---\n%%oa:start A%%\none\n%%oa:end%%\n%%oa:start B%%\ntwo\n%%oa:end%%';
        const res = validateSingleBlock(parse(content), 'agent config');
        assert.strictEqual(res.ok, false);
        if (!res.ok) { assert.ok(res.reason.includes('2'), `reason should name the count, got: ${res.reason}`); }
    });
});

suite('flags are optional for whole-file types (template + agent)', () => {

    test('a bare markdown agent note with no flags and no fence is the payload', () => {
        const content = '---\nartifactType: AIAgentsConfig\ntitle: Reviewer\ntarget: CLAUDE.md\n---\n\n# Reviewer\n\nBe terse with <VK-repo_name>.';
        const parsed = parse(content);
        assert.strictEqual(parsed.code, '# Reviewer\n\nBe terse with <VK-repo_name>.');
        assert.strictEqual(parsed.frontmatter.language, 'markdown');
        assert.deepStrictEqual(parsed.blocks, []);
        assert.strictEqual(resolveOutputFileName(parsed), 'CLAUDE.md');
    });

    test('the vars section is not written into the payload', () => {
        const content = '---\nartifactType: AIAgentsConfig\n---\nBe terse with <VK-repo_name>.\n\nvars:\n```vks\nVK-repo_name=my-app\n```\n';
        const parsed = parse(content);
        assert.strictEqual(parsed.code, 'Be terse with <VK-repo_name>.');
        assert.deepStrictEqual(parsed.vars, [{ name: 'VK-repo_name', defaultValue: 'my-app' }]);
    });

    /** No flags → nothing is chrome, so a `***` the author wrote is kept. */
    test('a flag-less note keeps its `***` — the rule is only ignored inside a region', () => {
        const content = '---\nartifactType: AIAgentsConfig\n---\nintro\n\n***\n\noutro';
        assert.strictEqual(parse(content).code, 'intro\n\n***\n\noutro');
    });

    test('a template with no fence takes the whole body too', () => {
        const content = '---\nartifactType: Template\ntitle: Readme\n---\n# <VK-project_name>\n\nDocs go here.';
        const parsed = parseFromContent(content, '/vault/Templates/readme.md', '/vault/Templates');
        assert.strictEqual(parsed.code, '# <VK-project_name>\n\nDocs go here.');
        assert.strictEqual(resolveOutputFileName(parsed), 'Readme.md');
    });

    /** The fallback must never outrank an actual code block. */
    test('an existing code fence still wins over the bare body', () => {
        const content = '---\nartifactType: AIAgentsConfig\n---\nPreamble prose.\n\n```md\nfenced payload\n```\n\nTrailing prose.';
        assert.strictEqual(parse(content).code, 'fenced payload');
    });

    test('a snippet with no fence does NOT take the bare body (insert types are unchanged)', () => {
        const content = '---\nartifactType: Snippet\n---\nJust some prose in a note.';
        const parsed = parseFromContent(content, '/vault/Snippets/x.md', '/vault/Snippets');
        assert.strictEqual(parsed.code, '', 'only whole-file types get the bare-markdown fallback');
    });

    test('flags still win when present', () => {
        const content = '---\nartifactType: AIAgentsConfig\n---\nexcluded\n%%oa:start%%\nincluded\n%%oa:end%%\nexcluded too';
        assert.strictEqual(parse(content).code, 'included');
    });
});

suite('flags are additive — unflagged files are untouched', () => {

    test('a classic fenced single-block file parses exactly as before', () => {
        const content = '---\nartifactType: Snippet\nlanguage: javascript\n---\n\n```javascript\nconst x = <VK-name>;\n```\n\nvars:\nVK-name=hi\n';
        const parsed = parseFromContent(content, '/vault/Snippets/x.md', '/vault/Snippets');
        assert.strictEqual(parsed.code, 'const x = <VK-name>;');
        assert.strictEqual(parsed.frontmatter.language, 'javascript');
        assert.deepStrictEqual(parsed.vars, [{ name: 'VK-name', defaultValue: 'hi' }]);
        assert.deepStrictEqual(parsed.blocks, []);
    });

    /**
     * The legacy unfenced `vars:` form (§1) had no test, so the S8786 rewrite of
     * its regex was unguarded. All three spacings below are shapes real vault
     * files use; each parsed identically before and after.
     */
    test('the legacy unfenced vars: section still parses in every spacing', () => {
        const file = (varsSection: string) =>
            `---\nartifactType: Snippet\n---\n\n\`\`\`js\nx = <VK-a>;\n\`\`\`\n\n${varsSection}`;
        const varsOf = (varsSection: string) =>
            parseFromContent(file(varsSection), '/vault/Snippets/x.md', '/vault/Snippets').vars;
        const expected = [{ name: 'VK-a', defaultValue: '1' }];

        assert.deepStrictEqual(varsOf('vars:\nVK-a=1\n'), expected, 'tight');
        assert.deepStrictEqual(varsOf('vars:\n\nVK-a=1\n'), expected, 'blank line after the label');
        assert.deepStrictEqual(varsOf('vars:\nVK-a=1'), expected, 'no trailing newline');
    });

    test('a classic ##-heading multi-block file still splits on headings', () => {
        const content = '---\nartifactType: Snippet\n---\n## Dev\n```bash\ndev\n```\n## Prod\n```bash\nprod\n```';
        const parsed = parseFromContent(content, '/vault/Snippets/x.md', '/vault/Snippets');
        assert.deepStrictEqual(parsed.blocks.map(b => b.heading), ['Dev', 'Prod']);
    });

    test('`##` headings inside a flagged region stay payload, not blocks', () => {
        // Flags win: the author already said where the artifact starts and ends.
        const content = [
            '---', 'artifactType: AIAgentsConfig', '---',
            '%%oa:start%%',
            '## Style',
            '```md',
            'be terse',
            '```',
            '## Scope',
            '```md',
            'src only',
            '```',
            '%%oa:end%%',
        ].join('\n');
        const parsed = parse(content);
        assert.deepStrictEqual(parsed.blocks, [], 'a single flagged region is one block, headings and all');
        assert.ok(parsed.code.startsWith('## Style'));
        assert.ok(parsed.code.includes('## Scope'));
    });
});
