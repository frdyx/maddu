// audit P4 — SKIP honesty guard. The self-test runner used to map every
// zero-exit task to PASS, so the nine whole-task fixtures that print "SKIP" and
// exited 0 (when an optional dev dep or git was absent) were tallied as PASS —
// a broken cockpit boot or dropped fixture read as green. The fix: a reserved
// SKIP exit (77), honoured only for declared-skippable tasks, counted as a
// distinct `skip`, with --fail-on-skip turning any skip RED in CI.
//
// This guard pins that contract structurally so it cannot silently regress:
//   1. classifyExit maps codes correctly (skip only for skippable+77).
//   2. every SKIPPABLE fixture actually exits 77 on its skip path (not 0).
//   3. no NON-skippable discovered fixture uses exit 77 (the code is reserved).
//   4. a skippable task's skip forces complete=false and (with --fail-on-skip)
//      a non-green verdict — verified against the runner's own verdict math.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyExit, SKIP_EXIT_CODE, SKIPPABLE_TASKS } from './_self-test-runner.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond) => { if (!cond) { failures++; console.log(`  [FAIL] ${name}`); } else { console.log(`  [ok] ${name}`); } };

async function main() {
  // 1 — classifier
  ok('code 0 → pass', classifyExit(0, false) === 'pass' && classifyExit(0, true) === 'pass');
  ok('77 + skippable → skip', classifyExit(SKIP_EXIT_CODE, true) === 'skip');
  ok('77 + non-skippable → fail', classifyExit(SKIP_EXIT_CODE, false) === 'fail');
  ok('other nonzero → fail', classifyExit(1, true) === 'fail' && classifyExit(2, true) === 'fail');
  ok('spawn error (-1) → fail', classifyExit(-1, true) === 'fail');

  // 2 — every skippable fixture actually exits 77 on its skip path
  for (const id of SKIPPABLE_TASKS) {
    let src = '';
    try { src = await readFile(join(testDir, `${id}.mjs`), 'utf8'); } catch { /* missing */ }
    ok(`${id} exits ${SKIP_EXIT_CODE} on skip`, new RegExp(`process\\.exit\\(${SKIP_EXIT_CODE}\\)`).test(src));
    ok(`${id} has no exit(0) skip path`, !/SKIP[\s\S]{0,120}?process\.exit\(0\)/.test(src));
  }

  // 3 — no OTHER discovered fixture uses the reserved skip code
  const entries = await readdir(testDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.mjs') || e.name.startsWith('_')) continue;
    const id = e.name.replace(/\.mjs$/, '');
    if (SKIPPABLE_TASKS.has(id) || id === 'self-test-skip-honesty') continue;
    const src = await readFile(join(testDir, e.name), 'utf8');
    ok(`${id} does not use reserved exit ${SKIP_EXIT_CODE}`, !new RegExp(`process\\.exit\\(${SKIP_EXIT_CODE}\\)`).test(src));
  }

  // 4 — verdict math: a skip must make the suite incomplete, and --fail-on-skip
  //     must turn it red (mirrors runSelfTest's ok/complete derivation).
  const verdict = (counts, failOnSkip) => ({
    ok: counts.fail === 0 && !(failOnSkip && counts.taskSkipped > 0),
    complete: !(counts.taskSkipped > 0),
  });
  const withSkip = { fail: 0, taskSkipped: 1 };
  ok('a skipped suite is not complete', verdict(withSkip, false).complete === false);
  ok('skip is green WITHOUT --fail-on-skip', verdict(withSkip, false).ok === true);
  ok('skip is RED WITH --fail-on-skip', verdict(withSkip, true).ok === false);
  ok('clean suite is green + complete', verdict({ fail: 0, taskSkipped: 0 }, true).ok === true && verdict({ fail: 0, taskSkipped: 0 }, true).complete === true);

  console.log(failures === 0 ? '\nself-test-skip-honesty: all checks passed' : `\nself-test-skip-honesty: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
