#!/usr/bin/env node
// phase-strictness (v1.91.0) — per-phase governance escalation (roadmap #9).
//
// Pure layer: escalateMode is escalation-only (a phase tier can tighten,
// never weaken). E2E over a temp repo via the CLI: `phase set --tier` emits
// PHASE_DECLARED with the tier and escalates readEffectiveGovernance's mode;
// explicit governance.json overrides keep winning; `phase clear` emits
// PHASE_CLEARED, restores baseline, and nulls the projection; invalid tiers
// are rejected; writers (`governance set …`) still read/write the BASE config.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLI = join(ROOT, 'bin', 'maddu.mjs');
const gov = await import(pathToFileURL(join(ROOT, 'template', 'maddu', 'runtime', 'lib', 'governance.mjs')).href);
const spine = await import(pathToFileURL(join(ROOT, 'template', 'maddu', 'runtime', 'lib', 'spine.mjs')).href);

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 30000 });

async function main() {
  // ── pure: escalation-only matrix ──
  ok('standard + strict phase → strict', gov.escalateMode('standard', 'strict') === 'strict');
  ok('strict + relaxed phase → strict (never weakens)', gov.escalateMode('strict', 'relaxed') === 'strict');
  ok('relaxed + standard phase → standard', gov.escalateMode('relaxed', 'standard') === 'standard');
  ok('same tier → unchanged', gov.escalateMode('standard', 'standard') === 'standard');
  ok('invalid phase tier → base unchanged', gov.escalateMode('standard', 'bogus') === 'standard');
  ok('invalid base falls back to default', gov.escalateMode('bogus', 'relaxed') === 'standard');

  // ── e2e over a temp repo ──
  const repo = await mkdtemp(join(tmpdir(), 'maddu-phs-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });

  // baseline: standard, no phase
  {
    const eff = await gov.readEffectiveGovernance(repo);
    ok('no phase → baseline mode, __phase null', eff.mode === 'standard' && eff.__phase === null);
  }

  // sterile phase escalates
  {
    const r = run(['phase', 'set', '--name', 'release', '--tier', 'strict'], repo);
    ok('phase set --tier strict exits 0', r.status === 0, (r.stderr || '').slice(0, 150));
    ok('set output announces the escalation', (r.stdout || '').includes('escalates effective mode → strict'));
    const eff = await gov.readEffectiveGovernance(repo);
    ok('effective mode escalated to strict', eff.mode === 'strict');
    ok('__phase carries name/tier/escalated', eff.__phase?.name === 'release' && eff.__phase?.tier === 'strict' && eff.__phase?.escalated === true);
    ok('strict behavior flows through effectiveValue', gov.effectiveValue(eff, 'force-claim-allowed') === false);
    const events = await spine.readAll(repo);
    const decl = events.find((e) => e.type === 'PHASE_DECLARED');
    ok('PHASE_DECLARED carries the tier', decl?.data?.tier === 'strict');
  }

  // explicit override still wins over the escalated mode's default
  {
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'governance.json'),
      JSON.stringify({ mode: 'standard', overrides: { 'loop-max-iter-default': 7 } }));
    const eff = await gov.readEffectiveGovernance(repo);
    ok('escalation preserved with config file present', eff.mode === 'strict');
    ok('explicit override beats escalated default', gov.effectiveValue(eff, 'loop-max-iter-default') === 7);
  }

  // relaxed phase tier never weakens a strict workspace
  {
    await writeFile(join(repo, '.maddu', 'config', 'governance.json'),
      JSON.stringify({ mode: 'strict', overrides: {} }));
    run(['phase', 'set', '--name', 'spike', '--tier', 'relaxed'], repo);
    const eff = await gov.readEffectiveGovernance(repo);
    ok('relaxed phase on strict workspace → still strict', eff.mode === 'strict' && eff.__phase?.escalated === false);
  }

  // clear restores baseline + nulls projection
  {
    const r = run(['phase', 'clear'], repo);
    ok('phase clear exits 0', r.status === 0, (r.stderr || '').slice(0, 150));
    const events = await spine.readAll(repo);
    ok('PHASE_CLEARED on the spine', events.some((e) => e.type === 'PHASE_CLEARED'));
    const eff = await gov.readEffectiveGovernance(repo);
    ok('after clear → baseline mode, __phase null', eff.mode === 'strict' && eff.__phase === null);
    const show = run(['phase', 'show'], repo);
    ok('phase show → null after clear', (show.stdout || '').trim() === 'null');
    const again = run(['phase', 'clear'], repo);
    ok('double clear is a graceful no-op', again.status === 0 && (again.stdout || '').includes('nothing to clear'));
  }

  // invalid tier rejected
  {
    const r = run(['phase', 'set', '--name', 'x', '--tier', 'chaos'], repo);
    ok('invalid --tier rejected (exit 2)', r.status === 2 && (r.stderr || '').includes('invalid --tier'));
  }

  // tierless phase → no escalation metadata
  {
    run(['phase', 'set', '--name', 'plain'], repo);
    const eff = await gov.readEffectiveGovernance(repo);
    ok('tierless phase → __phase null (no escalation semantics)', eff.__phase === null);
  }

  await rm(repo, { recursive: true, force: true });
  console.log(`\nphase-strictness: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
