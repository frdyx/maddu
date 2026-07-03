#!/usr/bin/env node
// ci-command (v1.87.0) — `maddu ci` headless gate rail.
//
// Verifies the churn-proof exit contract: unpinned = informational exit 0;
// pinned = exit 1 ONLY when a pinned required gate fails; --strict = exit 1 on
// any gate failure; `ci pin` writes the currently-green set and excludes
// failures. Runs against the framework source checkout (which has known
// source-repo gate failures — ideal fixtures for the required/unrequired split).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const BIN = join(ROOT, 'bin', 'maddu.mjs');
const CI_JSON = join(ROOT, '.maddu', 'config', 'ci.json');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function runCi(args) {
  const r = spawnSync(process.execPath, [BIN, 'ci', ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

async function main() {
  // Preserve any operator-pinned profile; restore on exit.
  let saved = null;
  try { saved = await readFile(CI_JSON, 'utf8'); } catch {}

  try {
    // ── unpinned: informational, exit 0 even with failing gates ──
    await rm(CI_JSON, { force: true });
    const un = runCi(['--json']);
    const unJ = parseJson(un.stdout);
    ok('unpinned run exits 0', un.code === 0, `got ${un.code}`);
    ok('unpinned json mode', unJ?.mode === 'unpinned', `got ${unJ?.mode}`);
    ok('json reports gate summary', Number.isFinite(unJ?.summary?.total) && unJ.summary.total > 0);
    ok('json scan advisory present or null', unJ && ('scan' in unJ));
    const anyFail = (unJ?.summary?.fail ?? 0) > 0;

    // ── strict: exit 1 iff any gate fails ──
    const st = runCi(['--strict', '--json']);
    const stJ = parseJson(st.stdout);
    ok('strict json mode', stJ?.mode === 'strict', `got ${stJ?.mode}`);
    ok('strict exit matches gate reality', anyFail ? st.code === 1 : st.code === 0,
      `fails=${unJ?.summary?.fail} exit=${st.code}`);

    // ── pin: writes green set, excludes failures ──
    const pin = runCi(['pin', '--json']);
    const pinJ = parseJson(pin.stdout);
    ok('pin exits 0', pin.code === 0, `got ${pin.code}`);
    ok('pin wrote a required list', Array.isArray(pinJ?.pinned) && pinJ.pinned.length > 0);
    ok('pin excluded the failing gates', Array.isArray(pinJ?.excluded) &&
      pinJ.excluded.length === (unJ?.summary?.fail ?? 0), `excluded=${pinJ?.excluded?.length}`);
    const onDisk = parseJson(await readFile(CI_JSON, 'utf8'));
    ok('profile persisted to .maddu/config/ci.json',
      Array.isArray(onDisk?.requiredGates) && onDisk.requiredGates.length === pinJ.pinned.length);
    ok('no failing gate leaked into the pin', pinJ.pinned.every((g) => !pinJ.excluded.includes(g)));

    // ── pinned run: exit 0 because failures are exactly the unpinned ones ──
    const pd = runCi(['--json']);
    const pdJ = parseJson(pd.stdout);
    ok('pinned run exits 0 (failures are unpinned)', pd.code === 0, `got ${pd.code}`);
    ok('pinned json mode', pdJ?.mode === 'pinned', `got ${pdJ?.mode}`);

    // ── the churn-proof core: pin a FAILING gate → exit 1; required flagged ──
    if (anyFail) {
      const failingId = pdJ.failed[0]?.gateId;
      await mkdir(dirname(CI_JSON), { recursive: true });
      await writeFile(CI_JSON, JSON.stringify({ requiredGates: [failingId] }, null, 2) + '\n');
      const red = runCi(['--json']);
      const redJ = parseJson(red.stdout);
      ok('pinned-failing gate → exit 1', red.code === 1, `pinned ${failingId}, exit ${red.code}`);
      ok('failed gate marked required in json',
        redJ?.failed?.find((f) => f.gateId === failingId)?.required === true);
    } else {
      ok('(skipped required-red case — no failing gates in this checkout)', true);
    }

    // ── unknown subcommand ──
    const bad = runCi(['frobnicate']);
    ok('unknown subcommand exits 2', bad.code === 2, `got ${bad.code}`);
  } finally {
    // Restore the operator's profile exactly as found.
    if (saved != null) { await mkdir(dirname(CI_JSON), { recursive: true }); await writeFile(CI_JSON, saved); }
    else await rm(CI_JSON, { force: true });
  }

  console.log(`\nci-command: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
