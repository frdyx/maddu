#!/usr/bin/env node
// PR4 clause 1: profile-aware latency budgets and visible audit latency states.
// Node 20 ESM; no dependencies. Only [control] rows may pass at the branch base.
//
// 1e seam: the real CLI in a copied sourceFixture, plus the shipped manifest.
// audit's frameworkRoot() is module-relative; cwd/MADDU_STATE_ROOT do not
// redirect its latency read. No real state file is swapped or written, and
// the CLI's AUDIT_REPORT side effect is confined to the fixture as well.
//
// P4 correction (accepted by the contract author): smoke is NOT silent at
// base; it gets generic OK/within-baseline text. Its row asserts the contracted
// profile name + not-budgeted explanation, not absence of existing text.

import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetVerdict, latencyVerdict, summarizeBudget } from '../../template/maddu/runtime/lib/governance-budget.mjs';
import { discoverGates } from '../../template/maddu/runtime/lib/gates.mjs';
import { cleanupFixtures } from './_pr1-fixtures.mjs';
import { fixtureCli, sourceFixture } from './_pr2-fixtures.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond, extra = '') => {
  extra = extra.replace(/\s+/g, ' ').trim();
  if (cond) { passed++; console.log(`  [PASS] ${name} - ${extra || 'assertion holds'}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};

const positiveFinite = (n) => Number.isFinite(n) && n > 0;

// Same ground-truth derivation as governance-budget.mjs. Also read the
// audit-only labels from their registry, instead of freezing its current size.
async function groundTruthCounts() {
  const gates = (await discoverGates(REPO_ROOT)).filter((g) => g.__source === 'builtin').length;
  const bin = await readFile(join(REPO_ROOT, 'bin/maddu.mjs'), 'utf8');
  const audit = (await readFile(join(REPO_ROOT, 'commands/audit.mjs'), 'utf8')).split(/\r?\n/).join('\n');
  const commands = bin.match(/const\s+COMMANDS\s*=\s*(\[[^\]]+\])/);
  const reusable = audit.match(/const\s+GATE_IDS\s*=\s*\{([\s\S]*?)\n\};/);
  const auditOnly = audit.match(/const\s+AUDIT_ONLY_LABELS\s*=\s*(\[[^\]]+\])/);
  if (!commands || !reusable || !auditOnly) throw new Error('cannot derive the command/audit registries');
  const verbs = new Function(`return ${commands[1]}`)().length;
  const gateCount = (reusable[1].match(/^\s*[\w-]+:\s*'/gm) || []).length;
  const auditOnlyCount = new Function(`return ${auditOnly[1]}`)().length;
  if (![gates, verbs, gateCount, auditOnlyCount].every(positiveFinite)) {
    throw new Error('empty ground-truth registry; refusing a vacuous count control');
  }
  return { gates, verbs, 'audit-checks': gateCount + auditOnlyCount };
}

function auditBudget(root) {
  const result = fixtureCli(root, ['audit', 'budget', '--json'], {}, join(root, 'bin/maddu.mjs'));
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error(`audit did not return JSON: exit=${result.status}; ${result.stderr || result.stdout}`); }
  const checks = report.checks?.filter((c) => c.label === 'governance budget');
  if (report.audit !== 'budget' || checks?.length !== 1 || typeof checks[0].detail !== 'string') {
    throw new Error(`audit did not return exactly one governance budget check: ${result.stdout}`);
  }
  // A missing module, count failure or CLI refusal is a harness error, not
  // evidence for the renderer defect. At base these probes exit 0 with PASS.
  if (result.status !== 0 || checks[0].level === 'FAIL' || /not available|not found|invalid JSON/.test(checks[0].detail)) {
    throw new Error(`audit fixture failed before latency rendering: exit=${result.status}; ${checks[0].detail}; ${result.stderr}`);
  }
  return checks[0];
}

try {
  const manifestPath = join(REPO_ROOT, 'docs/audit/governance-budget.json');
  const shipped = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const profile of ['quick', 'full']) {
    const spec = shipped.selfTest?.profiles?.[profile];
    ok(`1a ${profile} has its own positive finite baseline and tolerance`,
      positiveFinite(spec?.baselineMs) && Number.isFinite(spec?.tolerancePct) && spec.tolerancePct >= 0,
      `selfTest.profiles.${profile}=${JSON.stringify(spec)}`);
  }
  ok('1a flat selfTest.baselineMs is retired',
    !!shipped.selfTest && !Object.hasOwn(shipped.selfTest, 'baselineMs'),
    `selfTest keys=${Object.keys(shipped.selfTest || {}).join(',')}`);

  // Deliberately synthetic baselines, not today's shipped measurements. A
  // fixed duration between these ceilings must select two different verdicts.
  const selfTest = { profiles: {
    quick: { baselineMs: 1000, tolerancePct: 10 },
    full: { baselineMs: 10000, tolerancePct: 20 },
  } };
  const durationMs = 4000;
  const tight = latencyVerdict({ durationMs, profile: 'quick', selfTest });
  const loose = latencyVerdict({ durationMs, profile: 'full', selfTest });
  ok('1b same duration WARNs for tight quick and is OK for loose full',
    tight.level === 'WARN' && loose.level === 'OK',
    `quick=${JSON.stringify(tight)}; full=${JSON.stringify(loose)}`);

  for (const profile of ['smoke', undefined]) {
    const verdict = latencyVerdict({ durationMs, profile, selfTest });
    const message = typeof verdict.message === 'string' ? verdict.message : '';
    const namesInput = profile === undefined
      ? /undefined|unknown|missing|unspecified|unrecorded|not recorded/i.test(message)
      : /\bsmoke\b/.test(message);
    ok(`1c ${String(profile)} is UNSUPPORTED and names input plus supported profiles`,
      verdict.level === 'UNSUPPORTED' && namesInput
        && Object.keys(selfTest.profiles).every((name) => message.includes(name)),
      JSON.stringify(verdict));
  }

  const absent = latencyVerdict({ durationMs: null, profile: 'quick', selfTest });
  const unsupported = latencyVerdict({ durationMs: null, profile: 'smoke', selfTest });
  ok('1d supported/no-duration SKIP differs in level and message from UNSUPPORTED',
    absent.level === 'SKIP' && unsupported.level === 'UNSUPPORTED'
      && typeof absent.message === 'string' && typeof unsupported.message === 'string'
      && absent.message.length > 0 && unsupported.message.length > 0
      && absent.message !== unsupported.message && /no recorded|no .*duration|missing .*duration/i.test(absent.message),
    `quick=${JSON.stringify(absent)}; smoke=${JSON.stringify(unsupported)}`);

  const counts = await groundTruthCounts();
  const countVerdict = budgetVerdict({ counts, manifest: shipped });
  ok('1f [control] shipped count budget is PASS against ground truth',
    countVerdict.level === 'PASS', `${countVerdict.level} | ${summarizeBudget(countVerdict)}`);
  if (countVerdict.level !== 'PASS') throw new Error('count control failed; latency rendering probes would be confounded');

  const root = await sourceFixture('maddu-pr4-budget-');
  await mkdir(join(root, 'docs/audit'), { recursive: true });
  await copyFile(manifestPath, join(root, 'docs/audit/governance-budget.json'));
  await mkdir(join(root, '.maddu/state'), { recursive: true });
  const lastRun = join(root, '.maddu/state/self-test-last-run.json');

  // funnel r1 #4 — every 1e row pins BOTH the check level and the exact
  // `latency <STATE>:` clause. A renderer that drops the state name, or folds
  // UNSUPPORTED into PASS, passed the earlier wording; it cannot pass this.
  const stateClause = (state) => new RegExp(`(?:^|[·;(] ?)latency ${state}:`);

  await writeFile(lastRun, JSON.stringify({ profile: 'smoke', durationMs: 5000 }));
  const smoke = auditBudget(root);
  ok('1e smoke report is WARN with a named latency UNSUPPORTED clause that names smoke',
    smoke.level === 'WARN' && stateClause('UNSUPPORTED').test(smoke.detail) && /\bsmoke\b/.test(smoke.detail)
      && /not budgeted|unbudgeted|unsupported|no .*baseline|no .*budget|not .*supported/i.test(smoke.detail),
    `level=${smoke.level}; detail=${smoke.detail}`);

  // This is a genuinely absent fixture file, not a report with null duration.
  try { await unlink(lastRun); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const noRun = auditBudget(root);
  ok('1e absent report is PASS with a named latency SKIP clause saying no run is recorded',
    noRun.level === 'PASS' && stateClause('SKIP').test(noRun.detail)
      && /no (?:recorded|.*\brun)|not (?:yet )?recorded|missing .*duration/i.test(noRun.detail),
    `level=${noRun.level}; detail=${noRun.detail}`);

  // At base the only available baseline is flat. Reading it here keeps the
  // renderer probe independent of 1a, and does not bless that obsolete shape.
  const quickBaseline = shipped.selfTest?.profiles?.quick?.baselineMs ?? shipped.selfTest?.baselineMs;
  if (!positiveFinite(quickBaseline)) throw new Error('no usable quick baseline for the within-budget audit probe');
  await writeFile(lastRun, JSON.stringify({ profile: 'quick', durationMs: quickBaseline / 2 }));
  const quick = auditBudget(root);
  ok('1e within-budget report is PASS with a named latency OK clause naming quick',
    quick.level === 'PASS' && stateClause('OK').test(quick.detail) && /\bquick\b/.test(quick.detail)
      && /within(?:[ -]budget|\b)/i.test(quick.detail),
    `level=${quick.level}; detail=${quick.detail}`);

  const quickTol = shipped.selfTest?.profiles?.quick?.tolerancePct ?? 50;
  await writeFile(lastRun, JSON.stringify({ profile: 'quick', durationMs: Math.ceil(quickBaseline * (1 + quickTol / 100)) + 1000 }));
  const over = auditBudget(root);
  ok('1e over-budget report is WARN with a named latency WARN clause naming quick',
    over.level === 'WARN' && stateClause('WARN').test(over.detail) && /\bquick\b/.test(over.detail),
    `level=${over.level}; detail=${over.detail}`);

  // funnel r1 #6 (pre-existing) — a count-side WARN (a waiver-carried category)
  // used to swallow the latency clause. Drive the real audit with a fixture
  // manifest whose gates cap sits one under the real count plus one waiver, and
  // require the latency OK clause to survive beside the count warning.
  const carried = structuredClone(shipped);
  carried.categories.gates.cap = counts.gates - 1;
  carried.waivers = [{ category: 'gates', reason: 'budget-profile fixture: count-WARN must not hide latency', added: '2026-09-13' }];
  await writeFile(join(root, 'docs/audit/governance-budget.json'), JSON.stringify(carried, null, 2));
  await writeFile(lastRun, JSON.stringify({ profile: 'quick', durationMs: quickBaseline / 2 }));
  const countWarn = auditBudget(root);
  ok('1e a waiver-carried count WARN still renders the latency OK clause',
    countWarn.level === 'WARN' && /carried by 1 waiver/.test(countWarn.detail) && stateClause('OK').test(countWarn.detail),
    `level=${countWarn.level}; detail=${countWarn.detail}`);
} catch (err) {
  ok('PR4 budget harness', false, err.stack || err.message);
} finally {
  await cleanupFixtures();
}
console.log('');
console.log(`budget-profile: PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
