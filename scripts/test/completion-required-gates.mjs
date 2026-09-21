#!/usr/bin/env node
// completion-required-gates — P0 audit fix 6 (A3-002 / A3-004): a pinned
// required gate that cannot run must block `goal done` / `plan complete`
// under strict governance, exactly as it reds `maddu ci` since audit P4.
//
//   1. requiredGateIntegrity() — pure vectors: unresolved, ambiguous,
//      warn-severity, healthy, unpinned.
//   2. checkGatesBeforeDone() in a fixture repo whose ci.json requires an id no
//      gate provides: strict → proceed:false with the integrity failure named;
//      standard → proceed:true but the failure is counted and reported.
//   3. an operator gate file that throws at import (A3-004) under the required
//      id: the id resolves to nothing runnable → blocked under strict.
//   4. control: a required id that resolves to one real builtin gate does not
//      block on resolution alone.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}

async function fixture({ requiredGates, mode, operatorGate = null }) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-reqgates-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(path.join(tmp, '.maddu', 'config'), { recursive: true });
  await writeFile(path.join(tmp, '.maddu', 'config', 'ci.json'), JSON.stringify({ requiredGates }, null, 2) + '\n');
  await writeFile(path.join(tmp, '.maddu', 'config', 'governance.json'), JSON.stringify({ mode, overrides: {} }, null, 2) + '\n');
  if (operatorGate) {
    await mkdir(path.join(tmp, '.maddu', 'gates'), { recursive: true });
    await writeFile(path.join(tmp, '.maddu', 'gates', operatorGate.file), operatorGate.source);
  }
  return tmp;
}

async function main() {
  const { requiredGateIntegrity } = await import(pathToFileURL(path.join(LIB, 'required-gates.mjs')).href);
  const { checkGatesBeforeDone } = await import(pathToFileURL(path.join(ROOT, 'commands', '_gates-before-done.mjs')).href);

  // ── 1. pure vectors ──
  const runs = [
    { gateId: 'alpha', severity: 'safety', status: 'ok' },
    { gateId: 'beta', severity: 'warn', status: 'ok' },
    { gateId: 'dup', severity: 'safety', status: 'ok' },
    { gateId: 'dup', severity: 'safety', status: 'ok' },
  ];
  ok('vector: unpinned (null) → no integrity failures', requiredGateIntegrity(runs, null).length === 0);
  ok('vector: empty pin → no integrity failures', requiredGateIntegrity(runs, []).length === 0);
  ok('vector: a required id with exactly one fail-capable run is clean', requiredGateIntegrity(runs, ['alpha']).length === 0);
  const unresolved = requiredGateIntegrity(runs, ['ghost']);
  ok('vector: a required id with no run → unresolved', unresolved.length === 1 && unresolved[0].reason === 'unresolved' && unresolved[0].message === 'ghost (required but no runnable gate resolves)', JSON.stringify(unresolved));
  const ambiguous = requiredGateIntegrity(runs, ['dup']);
  ok('vector: a required id that resolves twice → ambiguous', ambiguous.length === 1 && ambiguous[0].reason === 'ambiguous' && /resolves to 2 gates/.test(ambiguous[0].message), JSON.stringify(ambiguous));
  const warnOnly = requiredGateIntegrity(runs, ['beta']);
  ok('vector: a required warn-severity id → warn-severity (can never fail)', warnOnly.length === 1 && warnOnly[0].reason === 'warn-severity', JSON.stringify(warnOnly));
  ok('vector: order and multiplicity follow the pin list', requiredGateIntegrity(runs, ['ghost', 'alpha', 'beta']).map((f) => f.gateId).join(',') === 'ghost,beta');

  // ── 2. a required id no gate provides ──
  {
    const strict = await fixture({ requiredGates: ['nonexistent-gate-id'], mode: 'strict' });
    try {
      const r = await checkGatesBeforeDone(strict);
      ok('strict: a required id that resolves to no gate BLOCKS completion', r.proceed === false && r.blocked === true, JSON.stringify({ proceed: r.proceed, blocked: r.blocked, enforcement: r.enforcement, failCount: r.failCount, error: r.error }));
      ok('strict: the block names the unresolved required id', Array.isArray(r.failed) && r.failed.some((f) => f.gateId === 'nonexistent-gate-id' && /no runnable gate resolves/.test(f.message)), JSON.stringify(r.failed));
    } finally { await rm(strict, { recursive: true, force: true }); }
    const standard = await fixture({ requiredGates: ['nonexistent-gate-id'], mode: 'standard' });
    try {
      const r = await checkGatesBeforeDone(standard);
      ok('standard: completion proceeds but the unresolved required id is counted and reported', r.proceed === true && r.failCount >= 1 && Array.isArray(r.failed) && r.failed.some((f) => f.gateId === 'nonexistent-gate-id'), JSON.stringify({ proceed: r.proceed, failCount: r.failCount, failed: r.failed }));
    } finally { await rm(standard, { recursive: true, force: true }); }
  }

  // ── 3. an operator gate that throws at import under the required id (A3-004) ──
  {
    const tmp = await fixture({
      requiredGates: ['broken-operator-gate'], mode: 'strict',
      operatorGate: { file: 'broken-operator-gate.mjs', source: "throw new Error('boom at import');\nexport default { id: 'broken-operator-gate', severity: 'safety', run: async () => ({ ok: true }) };\n" },
    });
    try {
      const r = await checkGatesBeforeDone(tmp);
      ok('strict: an import-broken operator gate leaves its required id unresolved → BLOCKS', r.proceed === false && Array.isArray(r.failed) && r.failed.some((f) => f.gateId === 'broken-operator-gate'), JSON.stringify({ proceed: r.proceed, failed: r.failed }));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── 4. control: a real builtin id resolves ──
  {
    const tmp = await fixture({ requiredGates: ['lanes-catalog-parseable'], mode: 'strict' });
    try {
      const r = await checkGatesBeforeDone(tmp);
      const resolutionFailure = Array.isArray(r.failed) && r.failed.some((f) => f.gateId === 'lanes-catalog-parseable' && /no runnable gate resolves|resolves to \d+ gates|warn-severity/.test(f.message));
      ok('control: a required id that resolves to one builtin gate raises no resolution failure', !resolutionFailure && r.error !== true, JSON.stringify({ proceed: r.proceed, failed: r.failed, error: r.error }));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  console.log('');
  console.log(`completion-required-gates: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('completion-required-gates OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
