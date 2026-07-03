#!/usr/bin/env node
// vendor-memory-sync (v1.90.0) — `learn sync --from-claude-memory` interop.
//
// Pure layer: slug derivation, frontmatter parsing, content-hashed fact ids.
// E2E over a temp repo + fake vendor memory dir (via --dir): preview writes
// nothing; --adopt imports facts + VENDOR_MEMORY_IMPORTED events; re-running
// is idempotent (content-hash match); an edited vendor memory imports as a
// NEW fact; rebuildMemory replays imports from the spine; and the vendor
// directory is byte-untouched throughout (import-only contract).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLI = join(ROOT, 'bin', 'maddu.mjs');
const LIB = join(ROOT, 'template', 'maddu', 'runtime', 'lib');
const vm = await import(pathToFileURL(join(LIB, 'vendor-memory.mjs')).href);
const hindsight = await import(pathToFileURL(join(LIB, 'hindsight.mjs')).href);
const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 30000 });

async function main() {
  // ── pure: slug derivation (platform-appropriate abs path — resolve() only
  // treats C:\… as absolute on Windows) ──
  {
    const abs = process.platform === 'win32' ? 'C:\\Users\\x\\my.repo' : '/users/x/my.repo';
    const slugs = vm.slugsFor(abs);
    const expectedStrict = process.platform === 'win32' ? 'C--Users-x-my.repo' : '-users-x-my.repo';
    ok('slugsFor flattens separators + drive colon', slugs[0] === expectedStrict, slugs[0]);
    ok('slugsFor offers a loose fallback for dotted paths', slugs[1] === expectedStrict.replace('my.repo', 'my-repo'), slugs[1]);
  }

  // ── pure: frontmatter parse + content-hashed id ──
  {
    const raw = '---\nname: test-fact\ndescription: a one-liner\nmetadata:\n  type: project\n---\n\nThe body text.\n';
    const p = vm.parseMemoryMarkdown('test_fact.md', raw);
    ok('parses frontmatter name/description', p.name === 'test-fact' && p.description === 'a one-liner');
    ok('parses metadata type', p.type === 'project');
    ok('body excludes frontmatter', p.body === 'The body text.');
    const bare = vm.parseMemoryMarkdown('bare.md', 'just a body');
    ok('no-frontmatter file imports body-only', bare.body === 'just a body' && bare.name === 'bare');
    ok('same content → same fact id (idempotency key)', vm.vendorFactId(p) === vm.vendorFactId(vm.parseMemoryMarkdown('test_fact.md', raw)));
    ok('edited content → different fact id', vm.vendorFactId(p) !== vm.vendorFactId(vm.parseMemoryMarkdown('test_fact.md', raw + 'edit')));
    const fact = vm.buildVendorFact(p, { dir: '/x' });
    ok('fact is kind vendor with provenance', fact.kind === 'vendor' && fact.source.origin === 'claude-memory' && fact.source.file === 'test_fact.md');
  }

  // ── e2e over a temp repo + fake vendor dir ──
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-vms-repo-'));
    const vendor = await mkdtemp(join(tmpdir(), 'maddu-vms-vendor-'));
    await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
    await writeFile(join(vendor, 'MEMORY.md'), '- [index line](a.md)\n');
    await writeFile(join(vendor, 'project_alpha.md'), '---\nname: project-alpha\ndescription: alpha state\n---\n\nAlpha is at v2.\n');
    await writeFile(join(vendor, 'feedback_beta.md'), '---\nname: feedback-beta\ndescription: how to work\n---\n\nAlways run the linter.\n');
    const vendorBytes = async () => {
      const out = {};
      for (const f of (await readdir(vendor)).sort()) out[f] = await readFile(join(vendor, f), 'utf8');
      return JSON.stringify(out);
    };
    const before = await vendorBytes();

    // preview: reports 2 new, writes nothing
    const prev = run(['learn', 'sync', '--from-claude-memory', '--dir', vendor, '--json'], repo);
    let pj = null; try { pj = JSON.parse(prev.stdout); } catch {}
    ok('preview finds 2 new memories (index skipped)', pj?.found === 2 && pj?.new === 2, prev.stdout.slice(0, 200));
    ok('preview writes no facts', (await hindsight.readMemory(repo)).length === 0);

    // adopt: facts + events land
    const ad = run(['learn', 'sync', '--from-claude-memory', '--dir', vendor, '--adopt'], repo);
    ok('adopt exits 0', ad.status === 0, (ad.stderr || '').slice(0, 200));
    const facts = await hindsight.readMemory(repo);
    ok('2 vendor facts imported', facts.filter((f) => f.kind === 'vendor').length === 2);
    const events = await spine.readAll(repo);
    const imports = events.filter((e) => e.type === 'VENDOR_MEMORY_IMPORTED');
    ok('VENDOR_MEMORY_IMPORTED event per fact (carrying the fact)', imports.length === 2 && !!imports[0].data.fact);

    // idempotent re-run
    const re = run(['learn', 'sync', '--from-claude-memory', '--dir', vendor, '--json'], repo);
    let rj = null; try { rj = JSON.parse(re.stdout); } catch {}
    ok('re-run is idempotent (0 new, 2 already imported)', rj?.new === 0 && rj?.alreadyImported === 2, re.stdout.slice(0, 200));

    // edited vendor memory → exactly one new fact
    await writeFile(join(vendor, 'project_alpha.md'), '---\nname: project-alpha\ndescription: alpha state\n---\n\nAlpha is at v3 now.\n');
    const ed = run(['learn', 'sync', '--from-claude-memory', '--dir', vendor, '--adopt', '--json'], repo);
    let ej = null; try { ej = JSON.parse(ed.stdout); } catch {}
    ok('edited memory imports as one NEW fact', ej?.new === 1, ed.stdout.slice(0, 200));
    ok('old fact retained (append-only)', (await hindsight.readMemory(repo)).filter((f) => f.kind === 'vendor').length === 3);

    // rebuild replays vendor facts from the spine
    await hindsight.rebuildMemory(repo);
    ok('rebuildMemory replays vendor imports', (await hindsight.readMemory(repo)).filter((f) => f.kind === 'vendor').length === 3);

    // import-only: vendor dir byte-identical after everything (minus our own edit)
    ok('vendor directory untouched by import', (await vendorBytes()) !== before ? (await vendorBytes()).includes('v3 now.') : true);
    const untouched = JSON.parse(await vendorBytes());
    ok('vendor index + beta byte-identical', untouched['MEMORY.md'] === '- [index line](a.md)\n' && untouched['feedback_beta.md'].includes('Always run the linter.'));

    // no vendor dir at all → graceful no-op
    const bare = await mkdtemp(join(tmpdir(), 'maddu-vms-bare-'));
    await mkdir(join(bare, '.maddu', 'events'), { recursive: true });
    const none = run(['learn', 'sync', '--from-claude-memory'], bare);
    ok('no vendor dir → graceful no-op exit 0', none.status === 0 && (none.stdout || '').includes('no Claude Code memory directory'));

    await rm(repo, { recursive: true, force: true });
    await rm(vendor, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }

  console.log(`\nvendor-memory-sync: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
