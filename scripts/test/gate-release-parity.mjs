#!/usr/bin/env node
// gate-release-parity — the record-the-fix release invariant (roadmap #4, F1).
//
// Drives the gate against throwaway git repos so each branch of the verdict is
// proven deterministically: impacting-change-without-bump WARNs; bumped-without
// -a-FIXED-IN-row FAILs; bumped-with-a-row PASSes; docs-only PASSes; no-tag and
// consumer-install skip.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import gate from '../../template/maddu/runtime/gates/builtin/release-parity.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });

async function write(dir, rel, body) {
  const abs = join(dir, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body);
}

// Build a repo tagged v1.0.0 (version.json = 1.0.0), then apply `mutate` and
// commit it as the HEAD under test. `isSource` controls the scripts/generate.mjs
// source-checkout marker.
async function buildRepo(mutate, { isSource = true, tag = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'maddu-relpar-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  if (isSource) await write(dir, 'scripts/generate.mjs', '// marker\n');
  await write(dir, 'version.json', JSON.stringify({ version: '1.0.0', released: '2026-01-01' }) + '\n');
  await write(dir, 'commands/orient.mjs', '// v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  if (tag) git(dir, 'tag', 'v1.0.0');
  await mutate(dir, write);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'work');
  return dir;
}

async function main() {
  ok('gate id + safety severity', gate.id === 'release-parity' && gate.severity === 'safety');

  // ── impacting change, no version bump → WARN (delivery debt) ──
  const debt = await buildRepo(async (d, w) => { await w(d, 'commands/orient.mjs', '// v2 impacting\n'); });
  const rDebt = await gate.run({ repoRoot: debt });
  ok('impacting + no bump → not ok', rDebt.ok === false, rDebt.message);
  ok('impacting + no bump → status warn (not fail)', rDebt.status === 'warn', rDebt.status);
  ok('debt message says delivery debt', /delivery debt/.test(rDebt.message), rDebt.message);

  // ── impacting change, version bumped, but NO FIXED-IN row → FAIL ──
  const noRow = await buildRepo(async (d, w) => {
    await w(d, 'commands/orient.mjs', '// v2 impacting\n');
    await w(d, 'version.json', JSON.stringify({ version: '1.1.0', released: '2026-02-01' }) + '\n');
  });
  const rNoRow = await gate.run({ repoRoot: noRow });
  ok('bumped + no FIXED-IN row → not ok', rNoRow.ok === false, rNoRow.message);
  ok('bumped + no row → FAIL (no warn downgrade)', rNoRow.status !== 'warn', `status=${rNoRow.status}`);
  ok('FAIL message names FIXED-IN.json', /FIXED-IN\.json/.test(rNoRow.message), rNoRow.message);

  // ── impacting change, bumped, WITH a matching FIXED-IN row → PASS ──
  const recorded = await buildRepo(async (d, w) => {
    await w(d, 'commands/orient.mjs', '// v2 impacting\n');
    await w(d, 'version.json', JSON.stringify({ version: '1.1.0', released: '2026-02-01' }) + '\n');
    await w(d, 'docs/audit/FIXED-IN.json', JSON.stringify([
      { symptom: 's', area: 'a', fixed_in: '1.1.0', consumer_impact: 'c', ledger_ref: 'F1' },
    ]) + '\n');
  });
  const rRec = await gate.run({ repoRoot: recorded });
  ok('bumped + matching row → ok', rRec.ok === true, rRec.message);

  // ── docs/fixture-only change → PASS (nothing impacting) ──
  const docsOnly = await buildRepo(async (d, w) => {
    await w(d, 'docs/13-troubleshooting.md', '# changed\n');
    await w(d, 'scripts/test/x.mjs', '// fixture\n');
  });
  const rDocs = await gate.run({ repoRoot: docsOnly });
  ok('docs/fixture-only → ok', rDocs.ok === true, rDocs.message);

  // ── no tags → skip ──
  const noTag = await buildRepo(async (d, w) => { await w(d, 'commands/orient.mjs', '// v2\n'); }, { tag: false });
  const rNoTag = await gate.run({ repoRoot: noTag });
  ok('no tags → ok/skip', rNoTag.ok === true && /no tags/.test(rNoTag.message), rNoTag.message);

  // ── consumer install (no scripts/generate.mjs) → skip ──
  const consumer = await buildRepo(async (d, w) => { await w(d, 'commands/orient.mjs', '// v2\n'); }, { isSource: false });
  const rCons = await gate.run({ repoRoot: consumer });
  ok('consumer install → ok/skip', rCons.ok === true && /consumer install/.test(rCons.message), rCons.message);

  await Promise.all([debt, noRow, recorded, docsOnly, noTag, consumer].map((d) => rm(d, { recursive: true, force: true })));

  // ── LIVE TEETH: the real repo must never be in a hard-FAIL release-parity
  // state. A bumped version that carries consumer-impacting changes without a
  // FIXED-IN.json row FAILs here, so `maddu self-test` (the source release gate)
  // goes red at release time — not just when someone runs `doctor --gate`.
  // In-progress WARN (impacting changes pending a bump) is allowed; skip states
  // (no tags / not a source repo) return ok and pass.
  const live = await gate.run({ repoRoot: REPO_ROOT });
  const liveOkOrWarn = live.ok === true || live.status === 'warn';
  ok('live repo is not in a hard release-parity FAIL', liveOkOrWarn, live.message);
}

try {
  await main();
  console.log('');
  console.log(`gate-release-parity: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('gate-release-parity OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
