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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
