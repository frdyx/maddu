#!/usr/bin/env node
// ci-command (v1.87.0) — `maddu ci` headless gate rail.
//
// Verifies the churn-proof exit contract: unpinned = informational exit 0;
// pinned = exit 1 ONLY when a pinned required gate fails; --strict = exit 1 on
// any gate failure; `ci pin` writes the currently-green set and excludes
// failures. Runs against the framework source checkout (which has known
// source-repo gate failures — ideal fixtures for the required/unrequired split).
//
// ISOLATION (v1.105.2): every `maddu ci` invocation is redirected via
// MADDU_CI_PROFILE to a TEMP profile file, so the pin/rm/rewrite churn never
// touches the repo's own .maddu/config/ci.json. A prior version mutated the real
// file and restored it in a finally; a harness kill (timeout) or a concurrent
// gate read in that window leaked a clobbered single-gate ci.json into the tree.
// A postcondition asserts the real ci.json is byte-identical (and equally
// present/absent) before and after the run.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const BIN = join(ROOT, 'bin', 'maddu.mjs');
const REAL_CI_JSON = join(ROOT, '.maddu', 'config', 'ci.json');

let PROFILE = null; // the temp profile every runCi invocation is redirected to

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function runCi(args) {
  const env = { ...process.env, MADDU_CI_PROFILE: PROFILE };
  const r = spawnSync(process.execPath, [BIN, 'ci', ...args], { cwd: ROOT, encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

// Snapshot a file as { exists, buf } (a Buffer, for a literal byte comparison —
// not a UTF-8 string) so the postcondition detects both a byte change AND an
// appear/disappear (an initially-absent file must stay absent).
async function snapshot(path) {
  try { return { exists: true, buf: await readFile(path) }; }
  catch (e) { if (e && e.code === 'ENOENT') return { exists: false, buf: null }; throw e; }
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-ci-'));
  PROFILE = join(tmp, 'ci.json');
  // The real repo ci.json must be untouched by anything below (the leak this closes).
  const realBefore = await snapshot(REAL_CI_JSON);
  let threw = null;

  try {
    // ── unpinned: informational, exit 0 even with failing gates ──
    await rm(PROFILE, { force: true });
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
    ok('pin wrote to the MADDU_CI_PROFILE override', pinJ?.target === 'MADDU_CI_PROFILE', `target=${pinJ?.target}`);
    // audit P4 — pin now excludes failing gates AND every warn-severity gate
    // (a warn gate can never red, so pinning it as "required" is a misnomer). So
    // `excluded` is a superset of the failing gates, not equal to them.
    ok('pin excludes every failing gate (plus warn-severity gates)',
      Array.isArray(pinJ?.excluded)
      && (unJ?.failed ?? []).every((f) => pinJ.excluded.includes(f.gateId))
      && pinJ.excluded.length >= (unJ?.summary?.fail ?? 0),
      `excluded=${pinJ?.excluded?.length}, failing=${unJ?.summary?.fail}`);
    const onDisk = parseJson(await readFile(PROFILE, 'utf8'));
    // Exact ordered equality — length alone can't catch a reorder or substitution.
    ok('profile persisted to the override, in the exact pinned order',
      Array.isArray(onDisk?.requiredGates)
      && onDisk.requiredGates.length === pinJ.pinned.length
      && onDisk.requiredGates.every((g, i) => g === pinJ.pinned[i]),
      `onDisk=${onDisk?.requiredGates?.length} pinned=${pinJ?.pinned?.length}`);
    ok('no failing gate leaked into the pin', pinJ.pinned.every((g) => !pinJ.excluded.includes(g)));

    // ── pinned run: exit 0 because failures are exactly the unpinned ones ──
    const pd = runCi(['--json']);
    const pdJ = parseJson(pd.stdout);
    ok('pinned run exits 0 (failures are unpinned)', pd.code === 0, `got ${pd.code}`);
    ok('pinned json mode', pdJ?.mode === 'pinned', `got ${pdJ?.mode}`);
    ok('pinned run resolves the profile via MADDU_CI_PROFILE', pdJ?.profileSource === 'MADDU_CI_PROFILE', `source=${pdJ?.profileSource}`);

    // ── the churn-proof core: pin a FAILING gate → exit 1; required flagged ──
    if (anyFail) {
      const failingId = pdJ.failed[0]?.gateId;
      await mkdir(dirname(PROFILE), { recursive: true });
      await writeFile(PROFILE, JSON.stringify({ requiredGates: [failingId] }, null, 2) + '\n');
      const red = runCi(['--json']);
      const redJ = parseJson(red.stdout);
      ok('pinned-failing gate → exit 1', red.code === 1, `pinned ${failingId}, exit ${red.code}`);
      ok('failed gate marked required in json',
        redJ?.failed?.find((f) => f.gateId === failingId)?.required === true);
    } else {
      ok('(skipped required-red case — no failing gates in this checkout)', true);
    }

    // ── fail-closed: a corrupt override is a hard error, never a silent green ──
    await writeFile(PROFILE, '{ not valid json ');
    const corrupt = runCi(['--json']);
    ok('corrupt override → nonzero exit (fail-closed, not green)', corrupt.code === 2, `exit ${corrupt.code}`);
    ok('corrupt override → diagnostic names MADDU_CI_PROFILE', /MADDU_CI_PROFILE/.test(corrupt.stderr), corrupt.stderr.trim().slice(0, 80));

    // ── unknown subcommand ──
    const bad = runCi(['frobnicate']);
    ok('unknown subcommand exits 2', bad.code === 2, `got ${bad.code}`);
  } catch (e) {
    threw = e; // record but don't skip the leak guard below (Codex P2)
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // Postcondition: the real ci.json is exactly as we found it (the leak guard).
  // Runs even if the body threw, so an error-path real-file mutation is still
  // caught. Literal byte comparison via Buffer.equals (Codex P2/P3).
  const realAfter = await snapshot(REAL_CI_JSON);
  const untouched = realBefore.exists === realAfter.exists
    && ((realBefore.buf === null && realAfter.buf === null)
      || (!!realBefore.buf && !!realAfter.buf && realBefore.buf.equals(realAfter.buf)));
  ok('real .maddu/config/ci.json untouched by the test', untouched,
    `before(exists=${realBefore.exists},len=${realBefore.buf?.length ?? 0}) after(exists=${realAfter.exists},len=${realAfter.buf?.length ?? 0})`);

  if (threw) console.error('harness error:', threw && (threw.stack || threw.message));
  console.log(`\nci-command: ${passed} passed, ${failed} failed`);
  // Exit contract: 2 = harness error (a thrown body), 1 = assertion failed, 0 = OK.
  process.exit(threw ? 2 : failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
