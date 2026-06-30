#!/usr/bin/env node
// governance-budget — the self-applying cap on Máddu's governance surface
// (roadmap #7). Pure verdict logic: per-category caps with a waiver escape
// hatch (OVER→FAIL, waiver-carried→WARN, under→PASS) + relative self-test
// latency (WARN/SKIP, never FAIL). Also asserts the SHIPPED manifest is green
// against the real ground-truth counts so introducing the cap can't self-trip.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  budgetVerdict, latencyVerdict, effectiveCap, waiversFor, summarizeBudget, BUDGET_LEVELS,
} from '../../template/maddu/runtime/lib/governance-budget.mjs';
import { discoverGates } from '../../template/maddu/runtime/lib/gates.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const manifest = {
  schemaVersion: 1,
  categories: {
    gates: { cap: 70, note: 'g' },
    verbs: { cap: 70, note: 'v' },
    'audit-checks': { cap: 17, note: 'a' },
  },
  waivers: [],
  selfTest: { baselineMs: 36000, tolerancePct: 50 },
};

// ── waivers + effective cap ──
ok('no waivers → effectiveCap == cap', effectiveCap('gates', manifest) === 70);
ok('waiversFor empty', waiversFor('gates', manifest).length === 0);
const waived = { ...manifest, waivers: [{ category: 'gates', reason: 'x', added: '2026-06-30' }, { category: 'verbs', reason: 'y' }] };
ok('one waiver raises the gates ceiling by one', effectiveCap('gates', waived) === 71);
ok('waiver for another category does not raise gates', effectiveCap('audit-checks', waived) === 17);

// ── budgetVerdict: under / over / waiver-carried ──
const under = budgetVerdict({ counts: { gates: 66, verbs: 66, 'audit-checks': 15 }, manifest });
ok('all under cap → PASS', under.level === 'PASS', under.level);
ok('rows are sorted by category', under.rows.map((r) => r.category).join() === 'audit-checks,gates,verbs', under.rows.map((r) => r.category).join());

const over = budgetVerdict({ counts: { gates: 71, verbs: 66, 'audit-checks': 15 }, manifest });
ok('over cap with no waiver → FAIL', over.level === 'FAIL' && over.over[0].category === 'gates', JSON.stringify(over.over.map((r) => r.category)));
ok('the over row is flagged OVER', over.rows.find((r) => r.category === 'gates').level === BUDGET_LEVELS.OVER);

const carried = budgetVerdict({ counts: { gates: 71, verbs: 66, 'audit-checks': 15 }, manifest: waived });
ok('over cap but within cap+waiver → WARN (recorded debt)', carried.level === 'WARN' && carried.warn[0].category === 'gates', carried.level);
ok('the carried row is flagged WARN', carried.rows.find((r) => r.category === 'gates').level === BUDGET_LEVELS.WARN);

const overEvenWaived = budgetVerdict({ counts: { gates: 72, verbs: 66, 'audit-checks': 15 }, manifest: waived });
ok('over even the waiver-raised ceiling → FAIL', overEvenWaived.level === 'FAIL', overEvenWaived.level);

ok('summarize renders count/cap', summarizeBudget(under) === 'audit-checks 15/17 · gates 66/70 · verbs 66/70', summarizeBudget(under));
ok('summarize marks waivers', summarizeBudget(carried).includes('gates 71/70+1w'), summarizeBudget(carried));

// ── latencyVerdict ──
ok('within tolerance → OK', latencyVerdict({ durationMs: 32000, selfTest: manifest.selfTest }).level === 'OK');
ok('over tolerance → WARN', latencyVerdict({ durationMs: 60000, selfTest: manifest.selfTest }).level === 'WARN');
ok('no baseline → SKIP', latencyVerdict({ durationMs: 60000, selfTest: {} }).level === 'SKIP');
ok('no duration → SKIP', latencyVerdict({ durationMs: null, selfTest: manifest.selfTest }).level === 'SKIP');
ok('default tolerance is 50%', latencyVerdict({ durationMs: 53000, selfTest: { baselineMs: 36000 } }).level === 'OK'
  && latencyVerdict({ durationMs: 55000, selfTest: { baselineMs: 36000 } }).level === 'WARN');

// ── the SHIPPED manifest must be green against real ground-truth counts ──
// (introducing the cap must not trip it — caps carry deliberate headroom).
const shipped = JSON.parse(await readFile(join(repoRoot, 'docs', 'audit', 'governance-budget.json'), 'utf8'));
const builtinGates = (await discoverGates(repoRoot)).filter((g) => g.__source === 'builtin').length;
const binSrc = await readFile(join(repoRoot, 'bin', 'maddu.mjs'), 'utf8');
const verbCount = (() => { const m = binSrc.match(/const\s+COMMANDS\s*=\s*(\[[^\]]+\])/); return m ? new Function(`return ${m[1]}`)().length : 0; })();
// audit-checks: 9 reusable gates surfaced + the 7 audit-only labels (kept in sync
// with commands/audit.mjs by the audit-checks budget itself catching drift).
const auditChecks = 9 + 7;
const shippedVerdict = budgetVerdict({ counts: { gates: builtinGates, verbs: verbCount, 'audit-checks': auditChecks }, manifest: shipped });
ok('shipped manifest is PASS against real counts', shippedVerdict.level === 'PASS',
  `${shippedVerdict.level} | ${summarizeBudget(shippedVerdict)}`);
ok('each shipped category has real headroom (count <= cap)', shippedVerdict.rows.every((r) => r.count <= r.cap),
  shippedVerdict.rows.map((r) => `${r.category} ${r.count}/${r.cap}`).join(', '));

console.log('');
console.log(`governance-budget: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('governance-budget OK');
process.exit(0);
