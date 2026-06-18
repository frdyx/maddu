#!/usr/bin/env node
// debt-ledger (v1.17.0) — `maddu debt` deliberate-shortcut scanner.
//
// Verifies the marker parser (what / ceiling / upgrade in either order, the
// no-trigger flag), the tree scan (multiple comment styles, skipped dirs,
// binary skip), and the CLI path (writes .maddu/state/debt-ledger.json + a
// DEBT_SCANNED spine event, exit 0).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarker, scanDebt } from '../../commands/debt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const madduBin = resolve(__dirname, '..', '..', 'bin', 'maddu.mjs');
const TOKEN = 'maddu-' + 'debt:'; // assembled so this test file isn't self-flagged

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function cli(args, cwd) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [madduBin, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => res({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => res({ code, stdout, stderr }));
  });
}

async function eventTypes(repoRoot) {
  const dir = join(repoRoot, '.maddu', 'events');
  let files = [];
  try { files = await readdir(dir); } catch { return []; }
  const types = [];
  for (const f of files.filter((n) => n.endsWith('.ndjson')).sort()) {
    const body = await readFile(join(dir, f), 'utf8');
    for (const line of body.split(/\r?\n/).filter(Boolean)) {
      try { types.push(JSON.parse(line).type); } catch {}
    }
  }
  return types;
}

async function main() {
  // 1. parseMarker.
  const a = parseMarker(' in-memory dedup. ceiling: ~10k events. upgrade: index by segment.');
  ok('parse: what extracted', a.what === 'in-memory dedup', a.what);
  ok('parse: ceiling extracted', a.ceiling === '~10k events', a.ceiling);
  ok('parse: upgrade extracted', a.upgrade === 'index by segment', a.upgrade);

  const b = parseMarker(' global lock'); // no ceiling/upgrade → no trigger
  ok('parse: bare what', b.what === 'global lock' && b.ceiling === null && b.upgrade === null);

  const c = parseMarker(' single worker. upgrade: when load > 1/s. ceiling: one job at a time.');
  ok('parse: reversed order', c.upgrade === 'when load > 1/s' && c.ceiling === 'one job at a time', `${c.upgrade} | ${c.ceiling}`);

  // 2. scanDebt over a tree.
  const root = await mkdtemp(join(tmpdir(), 'maddu-debt-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'a.js'),
      `export const x = 1;\n// ${TOKEN} in-memory dedup. ceiling: 10k. upgrade: index by segment.\n`);
    await writeFile(join(root, 'src', 'b.py'),
      `def f():\n    pass  # ${TOKEN} global lock, no per-account locks yet\n`);
    await writeFile(join(root, 'c.md'),
      `Notes.\n<!-- ${TOKEN} flat-file store. ceiling: single host. -->\n`);
    // Must be ignored:
    await writeFile(join(root, 'node_modules', 'pkg', 'd.js'), `// ${TOKEN} vendor marker, ignore me\n`);
    // Binary file (null byte) must be skipped, not crash.
    await writeFile(join(root, 'src', 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));

    const r = await scanDebt(root);
    ok('scan: counts 3 markers (node_modules skipped)', r.counts.markers === 3, JSON.stringify(r.counts));
    ok('scan: 2 with no upgrade trigger', r.counts.noTrigger === 2, JSON.stringify(r.counts));
    ok('scan: spans 3 files', r.counts.files === 3, JSON.stringify(r.counts));
    ok('scan: no vendor marker', !r.entries.some((e) => /node_modules/.test(e.file)));
    ok('scan: entries sorted by path (c.md first)', r.entries[0].file === 'c.md');
    ok('scan: src/a.js marker has a trigger', r.entries.find((e) => e.file === 'src/a.js')?.hasTrigger === true);

    // 3. CLI path — writes ledger + DEBT_SCANNED event, exit 0.
    const run = await cli(['debt', '--json', '--repo', root], root);
    ok('cli: exits 0', run.code === 0, `code=${run.code} ${run.stderr.slice(0, 120)}`);
    let doc = null;
    try { doc = JSON.parse(await readFile(join(root, '.maddu', 'state', 'debt-ledger.json'), 'utf8')); } catch {}
    ok('cli: writes debt-ledger.json', doc && doc.counts.markers === 3, doc ? JSON.stringify(doc.counts) : 'no file');
    const types = await eventTypes(root);
    ok('cli: emits DEBT_SCANNED', types.includes('DEBT_SCANNED'));

    // --no-write suppresses the cache.
    const root2 = await mkdtemp(join(tmpdir(), 'maddu-debt-nw-'));
    try {
      await writeFile(join(root2, 'x.js'), `// ${TOKEN} thing. upgrade: later.\n`);
      const run2 = await cli(['debt', '--no-write', '--repo', root2], root2);
      let exists = true;
      try { await readFile(join(root2, '.maddu', 'state', 'debt-ledger.json'), 'utf8'); } catch { exists = false; }
      ok('cli: --no-write writes no ledger file', run2.code === 0 && !exists);
    } finally { await rm(root2, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }

  console.log('');
  console.log(`debt-ledger: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('debt-ledger OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
