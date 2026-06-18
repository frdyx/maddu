#!/usr/bin/env node
// risk-assess (v1.17.0) — deterministic change-risk classifier + escalation.
//
// Verifies the classifier levels (none/low/medium/high/critical, sensitive
// surface beats size, docs-only stays low), and that the review-trigger
// bypasses its cooldown only for a high/critical-risk slice.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessRisk, escalatesReview, riskRank } from '../../template/maddu/runtime/lib/risk-assess.mjs';
import { append, EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';
import { maybeReviewSliceStop } from '../../template/maddu/runtime/lib/review-trigger.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function main2() {
  // Classifier.
  ok('empty → none', assessRisk([]).level === 'none');
  ok('docs only → low', assessRisk(['README.md', 'docs/guide.md']).level === 'low');
  ok('many docs still low', assessRisk(Array.from({ length: 30 }, (_, i) => `docs/p${i}.md`)).level === 'low');
  ok('one code file → medium', assessRisk(['src/app.js']).level === 'medium');
  ok('broad code change → high', assessRisk(Array.from({ length: 25 }, (_, i) => `src/m${i}.js`)).level === 'high');
  ok('auth path → critical', assessRisk(['src/auth/login.js']).level === 'critical');
  ok('schema → critical', assessRisk(['db/schema.sql']).level === 'critical');
  ok('.env → critical', assessRisk(['config/.env']).level === 'critical');
  ok('migration → critical', assessRisk(['migrations/001_init.sql']).level === 'critical');
  ok('sensitive beats size', assessRisk([...Array.from({ length: 25 }, (_, i) => `src/m${i}.js`), 'src/auth.js']).level === 'critical');
  ok('"author.md" does not over-fire', assessRisk(['src/author.md']).level === 'low');
  ok('signals name the sensitive surface', /sensitive surface/.test(assessRisk(['src/token-store.ts']).signals.join(' ')));

  // Ordering + escalation predicate.
  ok('rank ordering', riskRank('critical') > riskRank('high') && riskRank('high') > riskRank('medium') && riskRank('medium') > riskRank('low'));
  ok('escalates high/critical only', escalatesReview('critical') && escalatesReview('high') && !escalatesReview('medium') && !escalatesReview('low'));
}

async function escalationPath() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-risk-'));
  try {
    await mkdir(join(root, '.maddu', 'events'), { recursive: true });
    // Put a recent auto-review TRIGGER_FIRED on the spine so the cooldown is active.
    await append(root, { type: EVENT_TYPES.TRIGGER_FIRED, data: { triggerId: 'slice-stop:auto-review' } });

    const medEv = { id: 'evt_med', type: 'SLICE_STOP', data: { risk: { level: 'medium' } } };
    const r1 = await maybeReviewSliceStop(root, medEv);
    ok('medium-risk slice respects cooldown', r1.skipped === 'cooldown', JSON.stringify(r1));

    const critEv = { id: 'evt_crit', type: 'SLICE_STOP', data: { risk: { level: 'critical' } } };
    const r2 = await maybeReviewSliceStop(root, critEv);
    // Escalates past the cooldown — then no-ops because no reviewer is configured.
    ok('critical-risk slice escalates past cooldown', r2.skipped !== 'cooldown', JSON.stringify(r2));
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function main() {
  main2();
  await escalationPath();
  console.log('');
  console.log(`risk-assess: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('risk-assess OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
