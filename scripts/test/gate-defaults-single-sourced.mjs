#!/usr/bin/env node
// v1.11.0 — the defaults-single-sourced guard gate.
//
// Positive: against the real repo, the gate is ok (init + upgrade both import
// _config-seed.mjs and neither re-inlines a default). Negative: the gate's
// detection regex must FAIL a source that re-inlines `const DEFAULT_TRIGGERS`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');

function fail(msg) { console.error(`GATE-DEFAULTS FAILED: ${msg}`); process.exit(1); }

async function main() {
  const gatePath = path.join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin', 'defaults-single-sourced.mjs');
  const gate = (await import(pathToFileURL(gatePath).href)).default;
  if (!gate || gate.id !== 'defaults-single-sourced') fail('gate did not export the expected shape');
  if (gate.severity !== 'safety') fail(`severity ${gate.severity} != safety`);

  // Positive: against the live framework source.
  const res = await gate.run({});
  if (!res.ok) fail(`gate FAILED on the real (single-sourced) repo: ${res.message} ${JSON.stringify(res.evidence)}`);

  // Negative: the detection regex must catch a re-inlined default. We mirror the
  // gate's FORBIDDEN_INLINE pattern to prove it flags the regression shape.
  const FORBIDDEN = /\bconst\s+(DEFAULT_TRIGGERS|DEFAULT_PIPELINES|PLAN_EXEC_VERIFY_FIX|DEFAULT_JANITOR_CONFIG|DEFAULT_TRUST_CONFIG|DEFAULT_WORKER_ENV_CONFIG|DEFAULT_GOVERNANCE_CONFIG)\b/;
  if (!FORBIDDEN.test("  const DEFAULT_TRIGGERS = ['janitor:sessions'];")) fail('detection regex misses an inline DEFAULT_TRIGGERS');
  if (FORBIDDEN.test('// mentions DEFAULT_TRIGGERS in a comment')) fail('detection regex false-positives on a comment mention');
  if (!FORBIDDEN.test('const DEFAULT_WORKER_ENV_CONFIG = {};')) fail('detection regex misses worker-env config inline');

  console.log('GATE-DEFAULTS OK (passes on single-sourced repo; regex catches re-inlined defaults, ignores comments)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
