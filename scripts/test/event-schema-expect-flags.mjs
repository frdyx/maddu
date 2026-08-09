#!/usr/bin/env node
// event-schema --expect-change / --expect-bump — the flag contract.
//
// These flags are a RELEASE GATE: they are what stops a contract change from
// shipping under a version that misdescribes it. Their behaviour is exit codes
// on argv, so it can only be tested by spawning the real suite — asserting the
// logic in-process would test a copy of it.
//
// The defect this exists to prevent already happened once: the bump assertion
// was gated on `want !== 'none'`, so `--expect-change none --expect-bump major`
// exited 0 while the real bump was none. The guard was switched off in exactly
// the mode a post-refresh release runs in.
//
// EXIT CODES ARE READ WITHOUT A PIPE. Reading one through `| head` or `| grep`
// yields the pipe's status, not the suite's.
//
// exit 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, 'event-schema.mjs');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};

function run(...args) {
  const r = spawnSync(process.execPath, [SUITE, ...args], { encoding: 'utf8' });
  if (r.error) { console.error(`[harness] ${r.error.message}`); process.exit(2); }
  return r.status;
}

// Same, against a SYNTHETIC baseline via the MADDU_CONTRACT_BASELINE seam.
function runWithBaseline(baselineFile, ...args) {
  const r = spawnSync(process.execPath, [SUITE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MADDU_CONTRACT_BASELINE: baselineFile },
  });
  if (r.error) { console.error(`[harness] ${r.error.message}`); process.exit(2); }
  return r.status;
}

// The committed baseline matches the live shape, so the true classification is
// `none` and the true bump is `none`. Every expectation below is anchored to
// that, which is also the state any post-refresh release is in.
ok('no flags → passes', run() === 0);
ok('--expect-change none → passes', run('--expect-change', 'none') === 0);

// THE REGRESSION. This exact invocation returned 0 while the real bump was none.
ok('--expect-change none --expect-bump major → FAILS (the closed hole)',
  run('--expect-change', 'none', '--expect-bump', 'major') === 1);
ok('--expect-change none --expect-bump none → passes',
  run('--expect-change', 'none', '--expect-bump', 'none') === 0);

// A wrong shape expectation must fail, or the flag asserts nothing.
ok('--expect-change minor against an unchanged shape → FAILS',
  run('--expect-change', 'minor') === 1);
ok('--expect-change major against an unchanged shape → FAILS',
  run('--expect-change', 'major') === 1);

// Two DIFFERENT domains: a shape is never `patch` (summary-only edits are
// invisible to contractShape), but a VERSION bump legitimately can be, so a
// patch-only contract release must be able to declare it.
ok('--expect-change patch → harness error (not a shape classification)',
  run('--expect-change', 'patch') === 2);
ok('--expect-bump patch → accepted as a domain value, then asserted',
  run('--expect-change', 'none', '--expect-bump', 'patch') === 1);

// Argument hygiene: a malformed or orphaned flag is a caller error (exit 2),
// never a silent pass. An orphaned --expect-bump looks like an assertion and
// would assert nothing.
ok('--expect-change garbage → harness error', run('--expect-change', 'garbage') === 2);
ok('--expect-change with no value → harness error', run('--expect-change') === 2);
ok('--expect-bump garbage → harness error',
  run('--expect-change', 'none', '--expect-bump', 'garbage') === 2);
ok('orphaned --expect-bump (no --expect-change) → harness error',
  run('--expect-bump', 'major') === 2);

// -- THE DISCRIMINATING CASES ---------------------------------------------
// Everything above runs against required === bump === 'none', so changing the
// guard from `vd.bump === wantBump` to `vd.required === wantBump` would leave
// every one of them unchanged. A suite written to pin a distinction, which
// never exercises the distinction, pins nothing.
//
// This builds a baseline where the two axes genuinely DIFFER: the pre-PR shape
// (so the SHAPE change is minor -- fields were added) stamped with version
// 0.17.0 (so the VERSION move to 1.17.0 is major).
const dir = mkdtempSync(join(tmpdir(), 'maddu-expect-flags-'));
const live = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'event-contract-baseline.json'), 'utf8'));
const NEW_FIELDS = ['planDigest', 'planTaskCount', 'tasksTruncated', 'conditionPlanDigest', 'conditionCount'];
const ran = live.shape?.types?.VERIFICATION_RAN;
if (!ran || !ran.data) { console.error('[harness] baseline shape missing VERIFICATION_RAN.data'); process.exit(2); }
for (const f of NEW_FIELDS) delete ran.data[f];
live.version = '0.17.0';
const skewed = join(dir, 'baseline-skewed.json');
writeFileSync(skewed, JSON.stringify(live, null, 2));

// CONTROL: the fixture must really produce differing axes, or the three
// assertions below are as vacuous as the ones they exist to replace.
ok('CONTROL: synthetic baseline yields required=minor, bump=major',
  runWithBaseline(skewed, '--expect-change', 'minor', '--expect-bump', 'major') === 0,
  'if this fails the fixture is wrong, not the guard');
ok('an UNDECLARED over-bump FAILS (bump defaults to the shape)',
  runWithBaseline(skewed, '--expect-change', 'minor') === 1);
ok('declaring the WRONG bump FAILS',
  runWithBaseline(skewed, '--expect-change', 'minor', '--expect-bump', 'minor') === 1);
ok('a wrong SHAPE expectation FAILS even with the right bump',
  runWithBaseline(skewed, '--expect-change', 'major', '--expect-bump', 'major') === 1);

// -- argv hygiene: assertion-LOOKING input must never pass silently --------
ok('a TYPO in a flag name -> harness error',
  run('--expect-change', 'none', '--expect-bunp', 'major') === 2);
ok('a DUPLICATE --expect-change -> harness error',
  run('--expect-change', 'none', '--expect-change', 'major') === 2);
ok('a DUPLICATE --expect-bump -> harness error',
  run('--expect-change', 'none', '--expect-bump', 'none', '--expect-bump', 'major') === 2);
ok('the --flag=value form -> harness error',
  run('--expect-change', 'none', '--expect-bump=major') === 2);
ok('an unknown flag -> harness error', run('--totally-unknown', 'x') === 2);
ok('a bare positional argument -> harness error', run('nonsense') === 2);
ok('a flag whose value is another flag -> harness error',
  run('--expect-change', '--expect-bump') === 2);

// The suite runs on every self-test, so a leaked mkdtemp accumulates one
// directory per run forever. Cleaned unconditionally, after the assertions.
// NOT a bare catch. An earlier revision swallowed a ReferenceError here — rmSync
// was never imported — so the cleanup looked applied while never running, and
// the suite leaked one directory per self-test run. A catch that cannot tell
// "cleanup failed" from "cleanup was impossible" hides its own absence.
try {
  rmSync(dir, { recursive: true, force: true });
} catch (e) {
  console.error(`[FAIL] temp cleanup did not run: ${e.message}`);
  failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
