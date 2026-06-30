#!/usr/bin/env node
// v1.10.0 — generalized + high-confidence-only skill-candidate detection.
//
// Two slices touching the same product area (src/auth/*.ts) must surface ONE
// high-confidence candidate tagged area:auth; a single occurrence must NOT;
// and a Máddu-style docs+command recurrence must still work (back-compat).

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

function fail(msg) { console.error(`SKILL-CANDIDATE FAILED: ${msg}`); process.exit(1); }

async function sliceStop(spine, repo, summary, targets) {
  return spine.append(repo, { type: 'SLICE_STOP', actor: 'ses_x', data: { summary, targets, next: [], learnings: [], gates: [] } });
}

async function main() {
  const spine = await loadLib('spine.mjs');
  const sc = await loadLib('skill-candidates.mjs');
  if (!spine || !sc) { console.error('harness error: lib not found'); process.exit(2); }

  // --- Case 1: two product slices in the same area → one high candidate. ---
  let repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-skc-area-'));
  try {
    await sliceStop(spine, repo, 'implement login', ['src/auth/login.ts']);
    await sliceStop(spine, repo, 'implement logout', ['src/auth/logout.ts']);
    const cands = await sc.detectCandidates(repo);
    if (cands.length !== 1) fail(`expected 1 area candidate, got ${cands.length}: ${JSON.stringify(cands.map((c) => c.tags))}`);
    if (!cands[0].tags.includes('area:auth')) fail(`candidate missing area:auth: ${JSON.stringify(cands[0].tags)}`);
    if (!cands[0].tags.includes('ext:ts')) fail(`candidate missing ext:ts: ${JSON.stringify(cands[0].tags)}`);
    if (cands[0].confidence !== 'high') fail(`confidence ${cands[0].confidence} != high`);
    if (cands[0].examples.length !== 2) fail(`expected 2 examples, got ${cands[0].examples.length}`);

    // v1.81.0 (roadmap #5 / F2): the autonomous detector is RETIRED. Detection
    // (detectCandidates, above) stays pure for any historical/manual use, but
    // emitFreshCandidates is a deliberate no-op — it appends NOTHING, so no
    // dead funnel can re-form. (Lock enforced by the funnel-integrity gate.)
    const e1 = await sc.emitFreshCandidates(repo, 'ses_x', { kind: 'slice-stop', id: 'skill-candidate', fired_at: '2026-06-09T00:00:00Z' });
    if (e1.length !== 0) fail(`retired emit expected 0, got ${e1.length}`);
    const all = await spine.readAll(repo);
    if (all.filter((x) => x.type === 'SKILL_CANDIDATE_DETECTED').length !== 0) fail('retired detector must append no SKILL_CANDIDATE_DETECTED');
  } finally { await fs.rm(repo, { recursive: true, force: true }); }

  // --- Case 2: a single occurrence → NO candidate (high-confidence only). ---
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-skc-single-'));
  try {
    await sliceStop(spine, repo, 'implement login', ['src/auth/login.ts']);
    const cands = await sc.detectCandidates(repo);
    if (cands.length !== 0) fail(`single occurrence should yield 0 candidates, got ${cands.length}`);
  } finally { await fs.rm(repo, { recursive: true, force: true }); }

  // --- Case 3: Máddu-style docs+command recurrence still works. ---
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-skc-maddu-'));
  try {
    await sliceStop(spine, repo, 'add docs for a command', ['template/maddu/docs/x.md', 'commands/x.mjs']);
    await sliceStop(spine, repo, 'add docs for a command', ['template/maddu/docs/y.md', 'commands/y.mjs']);
    const cands = await sc.detectCandidates(repo);
    const hit = cands.find((c) => c.tags.includes('docs') && c.tags.includes('command'));
    if (!hit) fail(`expected a docs+command candidate (back-compat), got ${JSON.stringify(cands.map((c) => c.tags))}`);
  } finally { await fs.rm(repo, { recursive: true, force: true }); }

  console.log('SKILL-CANDIDATE OK (area:/ext: generalization, high-confidence-only, back-compat)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
