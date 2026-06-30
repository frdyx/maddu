#!/usr/bin/env node
// cost-budget — the runaway-session guard (roadmap #14, F5).
//
// Pure verdict over the tokenLedger within a trailing window (now injected):
// metric selection, the WARN-over-ceiling, and SKIP when no budget. Also drives
// the gate end-to-end through a tmp repo with an opt-in cost-budget.json.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costVerdict, tokensFor, DAY_MS } from '../../template/maddu/runtime/lib/cost-budget.mjs';
import gate from '../../template/maddu/runtime/gates/builtin/cost-budget.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const NOW = Date.parse('2026-06-30T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

// ── tokensFor: metric selection, null-safe ──
ok('total = input + output', tokensFor({ inputTokens: 100, outputTokens: 30 }, 'total') === 130);
ok('output metric', tokensFor({ inputTokens: 100, outputTokens: 30 }, 'output') === 30);
ok('input metric', tokensFor({ inputTokens: 100, outputTokens: 30 }, 'input') === 100);
ok('nulls → 0', tokensFor({ inputTokens: null, outputTokens: null }) === 0);

const rows = [
  { ts: hoursAgo(2), inputTokens: 1000, outputTokens: 500 },   // in window
  { ts: hoursAgo(10), inputTokens: 2000, outputTokens: 800 },  // in window
  { ts: hoursAgo(30), inputTokens: 9000, outputTokens: 9000 }, // OUTSIDE 1d window
  { ts: 'garbage', inputTokens: 5, outputTokens: 5 },          // bad ts skipped
];

// ── window scoping ──
const within = costVerdict({ rows, now: NOW, windowDays: 1, maxTokens: 100000, metric: 'total' });
ok('only in-window rows summed (1500+2800=4300)', within.total === 4300 && within.counted === 2, JSON.stringify({ total: within.total, counted: within.counted }));
ok('within budget → OK', within.level === 'OK');

const wide = costVerdict({ rows, now: NOW, windowDays: 2, maxTokens: 100000, metric: 'total' });
ok('wider window pulls the 30h row in (4300+18000)', wide.total === 22300, String(wide.total));

// ── WARN over ceiling ──
const over = costVerdict({ rows, now: NOW, windowDays: 1, maxTokens: 4000, metric: 'total' });
ok('over budget → WARN', over.level === 'WARN' && over.total === 4300, over.level);
ok('message reports total/max + percent', /4,?300/.test(over.message) && /%/.test(over.message), over.message);

// ── output metric vs total ──
ok('output metric sums only output (500+800=1300)', costVerdict({ rows, now: NOW, windowDays: 1, maxTokens: 999999, metric: 'output' }).total === 1300);

// ── SKIP when no usable budget ──
ok('no maxTokens → SKIP', costVerdict({ rows, now: NOW, windowDays: 1 }).level === 'SKIP');
ok('zero/negative budget → SKIP', costVerdict({ rows, now: NOW, maxTokens: 0 }).level === 'SKIP');
ok('empty ledger → OK at 0', costVerdict({ rows: [], now: NOW, maxTokens: 100 }).level === 'OK');
ok('DAY_MS is 1 day', DAY_MS === 86400000);

// ── the gate end-to-end through a tmp repo ──
async function gateWith(config, ledger) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-cost-'));
  try {
    if (config) {
      await fs.mkdir(path.join(repo, '.maddu', 'config'), { recursive: true });
      await fs.writeFile(path.join(repo, '.maddu', 'config', 'cost-budget.json'), JSON.stringify(config));
    }
    const ctx = { repoRoot: repo, project: async () => ({ tokenLedger: ledger || [] }) };
    return await gate.run(ctx);
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
}

const nowRow = [{ ts: new Date().toISOString(), inputTokens: 5000, outputTokens: 5000 }];
ok('gate: no config → PASS (opt-in)', (await gateWith(null, nowRow)).ok === true);
const overGate = await gateWith({ windowDays: 1, maxTokens: 1000, metric: 'total' }, nowRow);
ok('gate: over budget → not ok + warn status (advisory)', overGate.ok === false && overGate.status === 'warn', JSON.stringify({ ok: overGate.ok, status: overGate.status }));
const underGate = await gateWith({ windowDays: 1, maxTokens: 100000000 }, nowRow);
ok('gate: under budget → PASS', underGate.ok === true && /within budget/.test(underGate.message));

console.log('');
console.log(`cost-budget: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('cost-budget OK');
process.exit(0);
