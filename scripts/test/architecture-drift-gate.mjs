#!/usr/bin/env node
// architecture-drift-gate (v1.18.0) — the gate, the CLI, and the failOn ladder.
//
// Covers the acceptance surface: init scaffolds a valid contract; scan reports
// + writes graph.json + emits ARCHITECTURE_SCANNED; diagram writes diagram.mmd;
// baseline snapshots; and the failOn ladder (none warns/exits green, new fails
// only on un-baselined drift, any fails on all) at BOTH the gate and CLI level.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import gate from '../../template/maddu/runtime/gates/builtin/architecture-drift.mjs';
import { loadContract } from '../../template/maddu/runtime/lib/architecture.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const madduBin = resolve(__dirname, '..', '..', 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') { console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`); cond ? passed++ : failed++; }

function cli(args, cwd) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [madduBin, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (e) => res({ code: -1, stdout, stderr: stderr + e.message }));
    child.on('close', (code) => res({ code, stdout, stderr }));
  });
}
async function w(root, rel, body) { const p = join(root, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); }
async function writeContract(root, failOn) {
  await w(root, '.maddu/config/architecture.json', JSON.stringify({
    schemaVersion: 1,
    modules: [
      { name: 'domain', paths: ['src/domain/**'] },
      { name: 'app', paths: ['src/app/**'] },
      { name: 'infra', paths: ['src/infra/**'] },
    ],
    rules: [{ from: 'domain', allow: [] }, { from: 'app', allow: ['domain'] }, { from: 'infra', allow: ['domain', 'app'] }],
    options: { failOn },
  }, null, 2) + '\n');
}
async function makeViolatingRepo(failOn) {
  const root = await mkdtemp(join(tmpdir(), 'maddu-archgate-'));
  await writeContract(root, failOn);
  await w(root, 'src/domain/user.ts', 'export const User = 1;\n');
  await w(root, 'src/domain/bad.ts', "import { db } from '../infra/db';\nexport const bad = db;\n"); // domain->infra FORBIDDEN
  await w(root, 'src/app/svc.ts', "import { User } from '../domain/user';\nexport const svc = User;\n"); // app->domain OK
  await w(root, 'src/infra/db.ts', "export const db = 1;\n");
  return root;
}
async function eventTypes(root) {
  const dir = join(root, '.maddu', 'events');
  let files = []; try { files = await readdir(dir); } catch { return []; }
  const t = [];
  for (const f of files.filter((n) => n.endsWith('.ndjson')).sort()) {
    for (const line of (await readFile(join(dir, f), 'utf8')).split(/\r?\n/).filter(Boolean)) { try { t.push(JSON.parse(line).type); } catch {} }
  }
  return t;
}

async function main() {
  // ── init ──────────────────────────────────────────────────────────────────
  const initRoot = await mkdtemp(join(tmpdir(), 'maddu-archinit-'));
  try {
    await w(initRoot, 'src/domain/a.ts', 'export const a = 1;\n');
    await w(initRoot, 'src/app/b.ts', 'export const b = 1;\n');
    const r = await cli(['architecture', 'init', '--repo', initRoot], initRoot);
    ok('init exits 0', r.code === 0, r.stderr.slice(0, 120));
    const { contract } = await loadContract(initRoot);
    ok('init writes a valid contract', !!contract && contract.schemaVersion === 1 && contract.modules.length >= 1);
    ok('init detects src modules', contract.modules.some((m) => m.name === 'domain') && contract.modules.some((m) => m.name === 'app'));
    ok('init defaults failOn:none', (contract.options?.failOn || 'none') === 'none');
  } finally { await rm(initRoot, { recursive: true, force: true }); }

  // ── no contract → gate skips ─────────────────────────────────────────────
  const bare = await mkdtemp(join(tmpdir(), 'maddu-archbare-'));
  try {
    const g = await gate.run({ repoRoot: bare });
    ok('gate skips with no contract', g.ok === true && /no architecture contract/.test(g.message));
  } finally { await rm(bare, { recursive: true, force: true }); }

  // ── failOn:none — gate WARN, CLI exits green, emits event + graph ─────────
  const root = await makeViolatingRepo('none');
  try {
    const g = await gate.run({ repoRoot: root });
    ok('failOn:none gate is ok+warn (visible, non-blocking)', g.ok === true && g.status === 'warn', JSON.stringify({ ok: g.ok, status: g.status }));

    const scan = await cli(['architecture', 'scan', '--repo', root, '--json'], root);
    ok('failOn:none scan exits green', scan.code === 0, `code=${scan.code}`);
    const graph = JSON.parse(await readFile(join(root, '.maddu', 'state', 'architecture', 'graph.json'), 'utf8'));
    ok('scan writes graph.json with the forbidden edge', graph.counts.forbidden === 1 && graph.driftScore > 0, JSON.stringify(graph.counts));
    ok('scan emits ARCHITECTURE_SCANNED', (await eventTypes(root)).includes('ARCHITECTURE_SCANNED'));

    const text = await cli(['architecture', 'scan', '--repo', root], root);
    ok('text report is readable + nudges to harden', /drift score/i.test(text.stdout) && /failOn:\s*"new"/.test(text.stdout));

    const diag = await cli(['architecture', 'diagram', '--repo', root], root);
    let mmd = ''; try { mmd = await readFile(join(root, '.maddu', 'state', 'architecture', 'diagram.mmd'), 'utf8'); } catch {}
    ok('diagram writes diagram.mmd', diag.code === 0 && /graph LR/.test(mmd) && /VIOLATION/.test(mmd));
  } finally { await rm(root, { recursive: true, force: true }); }

  // ── failOn:new — fails on un-baselined, ratchets after baseline ──────────
  const r2 = await makeViolatingRepo('new');
  try {
    const before = await gate.run({ repoRoot: r2 });
    ok('failOn:new fails before baseline', before.ok === false, before.message);
    const scanFail = await cli(['architecture', 'scan', '--repo', r2], r2);
    ok('failOn:new scan exits 1 before baseline', scanFail.code === 1, `code=${scanFail.code}`);

    const base = await cli(['architecture', 'baseline', '--repo', r2], r2);
    ok('baseline exits 0 + writes baseline.json', base.code === 0 && (await readFile(join(r2, '.maddu', 'state', 'architecture', 'baseline.json'), 'utf8')).includes('forbidden:domain->infra'));

    const after = await gate.run({ repoRoot: r2 });
    ok('failOn:new passes once baselined (ratchet)', after.ok === true, after.message);
    const scanPass = await cli(['architecture', 'scan', '--repo', r2], r2);
    ok('failOn:new scan exits 0 after baseline', scanPass.code === 0, `code=${scanPass.code}`);

    // Introduce a NEW forbidden edge → only that fails.
    await w(r2, 'src/app/leak.ts', "import { db } from '../infra/db';\nexport const leak = db;\n"); // app->infra NEW
    const afterNew = await gate.run({ repoRoot: r2 });
    ok('new drift after baseline fails again', afterNew.ok === false && /forbidden:app->infra/.test(JSON.stringify(afterNew.evidence?.new || [])), JSON.stringify(afterNew.evidence?.new));
  } finally { await rm(r2, { recursive: true, force: true }); }

  // ── failOn:any — fails on any violation ──────────────────────────────────
  const r3 = await makeViolatingRepo('any');
  try {
    const g = await gate.run({ repoRoot: r3 });
    ok('failOn:any fails on any violation', g.ok === false);
    const scan = await cli(['architecture', 'scan', '--repo', r3], r3);
    ok('failOn:any scan exits 1', scan.code === 1, `code=${scan.code}`);
  } finally { await rm(r3, { recursive: true, force: true }); }

  console.log('');
  console.log(`architecture-drift-gate: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('architecture-drift-gate OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
