#!/usr/bin/env node
// End-to-end test for v0.17.1 layout refusal.
//
// Locks in the behavior: init and upgrade must REFUSE when invoked via a
// consumer install's bundled CLI, and must SUCCEED when invoked from the
// framework source.
//
// Test scenarios:
//   A. Source init into a fresh tmp dir → success, full file count.
//   B. Source init from inside the freshly-installed tmp dir, targeting a
//      sibling tmp dir → REFUSED with exit code 2 and a clear error string.
//   C. Source upgrade from inside the consumer install (using consumer bin)
//      → REFUSED with exit code 2.
//   D. Source upgrade from outside, using source bin (cwd inside consumer)
//      → SUCCESS or "Already on framework vX.Y.Z. Nothing to do."
//
// Exit codes:
//   0 = all scenarios pass
//   1 = one or more scenarios failed (details on stderr)
//   2 = harness error (e.g. tmp dir setup failed)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_REPO = join(__dirname, '..', '..');
const SOURCE_BIN = join(SOURCE_REPO, 'bin', 'maddu.mjs');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

function runNode(args, cwd, { allowFailure = false } = {}) {
  try {
    const stdout = execFileSync('node', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    if (!allowFailure) throw err;
    return { code: err.status ?? -1, stdout: err.stdout?.toString('utf8') ?? '', stderr: err.stderr?.toString('utf8') ?? '' };
  }
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(abs);
    else if (entry.isFile()) n++;
  }
  return n;
}

let tmpA, tmpB;
try {
  // ─── Scenario A: source init succeeds ─────────────────────────────────
  tmpA = mkdtempSync(join(tmpdir(), 'maddu-test-A-'));
  const initA = runNode([SOURCE_BIN, 'init'], tmpA);
  const fileCountA = countFiles(join(tmpA, 'maddu'));
  record(
    'A. source init into fresh tmp succeeds',
    initA.code === 0 && fileCountA > 80,
    `exit=${initA.code}, maddu/ files=${fileCountA}`,
  );

  // ─── Scenario B: consumer-install init REFUSES ────────────────────────
  tmpB = mkdtempSync(join(tmpdir(), 'maddu-test-B-'));
  const consumerBin = join(tmpA, 'maddu', 'bin', 'maddu.mjs');
  const initB = runNode([consumerBin, 'init'], tmpB, { allowFailure: true });
  const refusedB = initB.code === 2 && /refused/i.test(initB.stderr) && /consumer install/i.test(initB.stderr);
  record(
    'B. consumer-install init into sibling tmp refuses (exit 2 + actionable error)',
    refusedB,
    `exit=${initB.code}, stderr contains "refused": ${/refused/i.test(initB.stderr)}, contains "consumer install": ${/consumer install/i.test(initB.stderr)}`,
  );

  // ─── Scenario C: consumer-install upgrade REFUSES ─────────────────────
  // Upgrade needs maddu.json in cwd; use tmpA which is now an installed consumer.
  const upgradeC = runNode([consumerBin, 'upgrade'], tmpA, { allowFailure: true });
  const refusedC = upgradeC.code === 2 && /refused/i.test(upgradeC.stderr);
  record(
    'C. consumer-install upgrade refuses (exit 2 + actionable error)',
    refusedC,
    `exit=${upgradeC.code}, stderr contains "refused": ${/refused/i.test(upgradeC.stderr)}`,
  );

  // ─── Scenario D: source upgrade from outside the consumer ─────────────
  // Run source bin pointing at tmpA — should succeed (no-op upgrade since same version).
  const upgradeD = runNode([SOURCE_BIN, 'upgrade'], tmpA, { allowFailure: true });
  const okD = upgradeD.code === 0 && /(Upgraded|Already on framework|Nothing to do)/i.test(upgradeD.stdout);
  record(
    'D. source upgrade from inside consumer (via source bin) succeeds',
    okD,
    `exit=${upgradeD.code}, stdout matches expected: ${/(Upgraded|Already on framework|Nothing to do)/i.test(upgradeD.stdout)}`,
  );
} catch (err) {
  console.error('harness error:', err.message);
  process.exit(2);
} finally {
  if (tmpA) try { rmSync(tmpA, { recursive: true, force: true }); } catch {}
  if (tmpB) try { rmSync(tmpB, { recursive: true, force: true }); } catch {}
}

const failures = results.filter((r) => !r.ok);
console.log('');
if (failures.length === 0) {
  console.log(`LAYOUT REFUSAL OK — ${results.length}/${results.length} scenarios passed`);
  process.exit(0);
} else {
  console.error(`LAYOUT REFUSAL FAILED — ${failures.length}/${results.length} scenario(s) failed`);
  process.exit(1);
}
