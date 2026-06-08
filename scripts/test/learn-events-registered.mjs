#!/usr/bin/env node
// v1.9.0 failure-learning — event-type registration test.
//
// Asserts that the six new v1.9.0 event types are:
//   1. declared in spine.EVENT_TYPES (so `append` accepts them), and
//   2. classified honestly by insights.buildMatrix — LEARN_MINED is a real
//      load-bearing entry point (NOT dormant), while the other five are
//      dormant-by-design (fire only when `maddu learn` / supersession /
//      curated briefings run) so `insights dead` stays truthful.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadLib(file) {
  const installed = path.join(process.cwd(), 'maddu', 'runtime', 'lib', file);
  const sourceLib = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib', file);
  for (const p of [installed, sourceLib]) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

const NEW_TYPES = [
  'LEARN_MINED',
  'LEARN_DIGEST_WRITTEN',
  'LEARN_JUDGED',
  'LEARN_CORRECTION_WRITTEN',
  'MEMORY_FACT_SUPERSEDED',
  'BRIEFING_CURATED',
];
// Everything except the load-bearing entry point should be dormant-by-design.
const DORMANT = NEW_TYPES.filter((t) => t !== 'LEARN_MINED');

function fail(msg) { console.error(`LEARN EVENTS FAILED: ${msg}`); process.exit(1); }

async function main() {
  const spine = await loadLib('spine.mjs');
  const insights = await loadLib('insights.mjs');
  if (!spine || !insights) { console.error('harness error: spine/insights lib not found'); process.exit(2); }

  // 1. Declared in EVENT_TYPES.
  for (const t of NEW_TYPES) {
    if (spine.EVENT_TYPES[t] !== t) fail(`${t} not declared in EVENT_TYPES`);
  }

  // 2. `append` accepts each in a throwaway temp repo.
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-learn-evt-'));
  try {
    for (const t of NEW_TYPES) {
      const ev = await spine.append(repo, { type: t, data: { probe: true } });
      if (!ev || ev.type !== t) fail(`append did not echo ${t}`);
    }
    const all = await spine.readAll(repo);
    if (all.length !== NEW_TYPES.length) fail(`expected ${NEW_TYPES.length} events, got ${all.length}`);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }

  // 3. buildMatrix classification: a single project with ZERO occurrences of
  //    any new type. Dormant ones must classify as `dormant`/dormant-by-design,
  //    NOT `dead`; LEARN_MINED (no occurrences, not dormant) must be `dead` so
  //    it is never mistaken for insurance — it's a genuine entry point.
  const definedSet = new Set(Object.keys(spine.EVENT_TYPES));
  const projects = [{ name: 'probe', counts: new Map() }];
  const matrix = insights.buildMatrix(projects, definedSet);
  const byType = new Map(matrix.rows.map((r) => [r.type, r]));

  for (const t of DORMANT) {
    const row = byType.get(t);
    if (!row) fail(`${t} missing from matrix rows`);
    if (row.cls !== 'dormant') fail(`${t} classified ${row.cls}, expected dormant`);
    if (row.owner !== 'dormant-by-design') fail(`${t} owner ${row.owner}, expected dormant-by-design`);
    if (matrix.deadDefined.includes(t)) fail(`${t} leaked into deadDefined`);
  }
  const mined = byType.get('LEARN_MINED');
  if (!mined) fail('LEARN_MINED missing from matrix rows');
  if (mined.owner !== 'core') fail(`LEARN_MINED owner ${mined.owner}, expected core (not dormant)`);

  console.log(`LEARN EVENTS OK (${NEW_TYPES.length} registered, ${DORMANT.length} dormant-by-design)`);
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
