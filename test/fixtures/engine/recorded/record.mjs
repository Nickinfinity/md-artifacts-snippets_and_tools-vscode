// Records engine replies for the test harness (plan W5 H5.0). Not part of the suite.
//
//   MDA_BIN=/Users/nick/.local/mda-v0.10.0/bin/mda npm run compile && node test/fixtures/engine/recorded/record.mjs
//
// Reads sources.json beside this file: [{ name, path, md } | { name, path, model } |
// { name, path, from, replace: [find, with] }].
// `md` is bytes, written verbatim. `model` is an ArtifactFormModel; the pinned engine
// writes its canonical bytes through artifact.create (toEngineModel only shapes the
// request — the engine owns the emission). `from` copies an earlier recording's bytes
// with one replacement. (Sources once in the pre-engine defaults format were converted
// by the engine once and are now `md` entries holding the engine's bytes.)
// Each source lands in a throwaway
// vault at its own unique `path`; then artifact.read → <name>.read.json, the bytes →
// <name>.md, and one vars.list over the whole vault → vars-list.json.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const bin = process.env.MDA_BIN;
if (!bin) { throw new Error('MDA_BIN is required'); }
const { toEngineModel } = await import(join(repo, 'dist', 'src', 'engine', 'model.js'));

const tmp = mkdtempSync(join(tmpdir(), 'mda-rec-'));
const vault = join(tmp, 'v');
mkdirSync(join(vault, '.obsidian'), { recursive: true });
const env = { ...process.env, MDA_CONFIG_DIR: join(tmp, 'cfg') };
const call = (op, params) => JSON.parse(execFileSync(bin, ['--vault', vault, 'call', op, JSON.stringify(params), '--json'], { env, encoding: 'utf8' }));

const sources = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8'));
const names = new Set();
for (const s of sources) {
    if (names.has(s.name)) { throw new Error(`duplicate name ${s.name}`); }
    names.add(s.name);
    const write = md => { mkdirSync(dirname(join(vault, s.path)), { recursive: true }); writeFileSync(join(vault, s.path), md); };
    if (s.md !== undefined) {
        write(s.md);
    } else if (s.from !== undefined) {
        const base = readFileSync(join(here, `${s.from}.md`), 'utf8');
        if (!base.includes(s.replace[0])) { throw new Error(`${s.name}: replace target missing`); }
        write(base.replace(s.replace[0], s.replace[1]));
    } else {
        call('artifact.create', { path: s.path, model: toEngineModel(s.model) });
    }
    const bytes = readFileSync(join(vault, s.path), 'utf8');
    const read = call('artifact.read', { path: s.path });
    if (read.hash !== createHash('sha256').update(bytes).digest('hex')) { throw new Error(`hash mismatch ${s.name}`); }
    writeFileSync(join(here, `${s.name}.md`), bytes);
    writeFileSync(join(here, `${s.name}.read.json`), `${JSON.stringify(read, null, 2)}\n`);
}
writeFileSync(join(here, 'vars-list.json'), `${JSON.stringify(call('vars.list', {}), null, 2)}\n`);
rmSync(tmp, { recursive: true, force: true });
console.log(`recorded ${sources.length} sources`);
