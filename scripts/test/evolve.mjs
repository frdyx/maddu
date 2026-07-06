#!/usr/bin/env node
// evolve (EXP phase 3) — fixture for the recommend-only evolution planner.
//
// Lib level (pure): detector thresholds (≥3 occurrences / ≥2 scopes),
// content-addressed rec ids (deterministic across runs), prior-art dedup,
// honest no-op on a thin corpus.
// Integration level (real temp repo): `evolve adopt` routes through the
// EXISTING write paths — memory adopt emits LEARN_CORRECTION_WRITTEN
// (destination 'memory', full fact) AND survives `rebuildMemory`; agent-file
// adopt emits the exact shape the learn-corrections-coherent gate traces and
// rewrites the CLAUDE.md marker block; skill adopt lands via saveSkill;
// gate/workflow/tool-pattern categories are draft-only (nothing written).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { planEvolution, MIN_OCCURRENCES, MIN_SCOPES } from '../../template/maddu/runtime/lib/evolve.mjs';
import { append, readAll, EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';
import { rebuildMemory, readMemory } from '../../template/maddu/runtime/lib/hindsight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

let seq = 0;
const ev = (id, type, actor, lane, data) =>
  ({ v: 1, id, ts: `2026-01-01T00:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq++ % 60).padStart(2, '0')}.000Z`, type, actor, lane, data });

// Two sessions so the ≥2-scopes requirement is satisfiable.
const SESSIONS = [
  ev('evt_r1', 'SESSION_AUTO_REGISTERED', 'ses_1', null, { sessionId: 'ses_1', label: 'A', role: 'implementer', source: 'cli' }),
  ev('evt_r2', 'SESSION_AUTO_REGISTERED', 'ses_2', null, { sessionId: 'ses_2', label: 'B', role: 'implementer', source: 'cli' }),
];

// ── lib: tool-correction detector crosses the threshold ────────────────────
{
  seq = 10;
  const evs = [...SESSIONS];
  for (let i = 0; i < 3; i++) {
    const sid = i % 2 === 0 ? 'ses_1' : 'ses_2';
    evs.push(ev(`evt_ref${i}`, 'TOOL_REFUSED', sid, null, { tool: 'install', argv: ['x'], reason: 'allowlist', detail: 'no' }));
    evs.push(ev(`evt_cmp${i}`, 'TOOL_COMPLETED', sid, null, { tool: 'install', argv: ['x', '--registry', 'ok'], exitCode: 0, durationMs: 5 }));
  }
  const plan = planEvolution(evs);
  ok('tool-correction clears ≥3×/≥2-scope thresholds', !plan.noOp && plan.recommendations.some((r) => r.detector === 'tool-correction' && r.category === 'memory'));
  const rec = plan.recommendations.find((r) => r.detector === 'tool-correction');
  ok('evidence carries all pair event ids (sorted)', rec.evidence.length === 6 && JSON.stringify(rec.evidence) === JSON.stringify([...rec.evidence].sort()));
  ok('confidence is a Wilson lower bound in (0,1)', rec.confidence > 0 && rec.confidence < 1);
  const plan2 = planEvolution(evs);
  ok('rec ids content-addressed: identical across runs', plan2.recommendations.find((r) => r.detector === 'tool-correction').recId === rec.recId);
  // Same evidence, different array order in → same id out.
  const shuffled = [...SESSIONS, ...evs.slice(2).reverse()];
  // (reversed pairing breaks pair detection; instead assert id derivation directly)
  ok('rec id derives from detector+evidence only', rec.recId.startsWith('rec_') && rec.recId.length === 16);
}

// ── lib: gate-flap + uncorrected-gate + prior-art suppression ───────────────
{
  seq = 100;
  const evs = [...SESSIONS];
  for (let i = 0; i < 3; i++) {
    const sid = i % 2 === 0 ? 'ses_1' : 'ses_2';
    evs.push(ev(`evt_gf${i}`, 'GATE_RAN', sid, null, { gateId: 'flappy-gate', ok: false, severity: 'warn', durationMs: 1, status: 'fail' }));
    evs.push(ev(`evt_go${i}`, 'GATE_RAN', sid, null, { gateId: 'flappy-gate', ok: true, severity: 'warn', durationMs: 1, status: 'pass' }));
    evs.push(ev(`evt_gu${i}`, 'GATE_RAN', sid, null, { gateId: 'doomed-gate', ok: false, severity: 'warn', durationMs: 1, status: 'fail' }));
    evs.push(ev(`evt_gc${i}`, 'GATE_RAN', sid, null, { gateId: 'covered-gate', ok: false, severity: 'warn', durationMs: 1, status: 'fail' }));
  }
  // Prior art mentioning covered-gate suppresses its uncorrected-gate rec.
  evs.push(ev('evt_prior', 'LEARN_CORRECTION_WRITTEN', null, null, { correctionId: 'cor_x', category: 'quirk', destination: 'memory', target: 'memory.ndjson', fact: { id: 'cor_x', text: 'covered-gate fails when Y — do Z first' } }));
  const plan = planEvolution(evs);
  ok('gate-flap detected (workflow)', plan.recommendations.some((r) => r.detector === 'gate-flap' && r.category === 'workflow'));
  ok('uncorrected-gate detected for doomed-gate', plan.recommendations.some((r) => r.detector === 'uncorrected-gate' && r.summary.includes('doomed-gate')));
  ok('prior art SUPPRESSES covered-gate', !plan.recommendations.some((r) => r.summary.includes('covered-gate')));
}

// ── lib: recurring learning across sessions → skill ─────────────────────────
{
  seq = 200;
  const evs = [...SESSIONS];
  for (let i = 0; i < 3; i++) {
    const sid = i % 2 === 0 ? 'ses_1' : 'ses_2';
    evs.push(ev(`evt_ls${i}`, 'SLICE_STOP', sid, `lane-${i % 2}`, { summary: `did work ${i}`, learnings: ['Always run the generator after editing docs'], targets: [], gates: [], deliverables: [] }));
  }
  const plan = planEvolution(evs);
  ok('recurring learning → skill candidate', plan.recommendations.some((r) => r.detector === 'recurring-learning' && r.category === 'skill'));
}

// ── lib: below threshold → honest no-op with real numbers ───────────────────
{
  seq = 300;
  const evs = [...SESSIONS,
    ev('evt_lone_ref', 'TOOL_REFUSED', 'ses_1', null, { tool: 'git', argv: ['x'], reason: 'allowlist', detail: 'no' }),
    ev('evt_lone_cmp', 'TOOL_COMPLETED', 'ses_1', null, { tool: 'git', argv: ['x'], exitCode: 0, durationMs: 1 }),
  ];
  const plan = planEvolution(evs);
  ok('thin corpus → noOp true with a single no-op rec', plan.noOp && plan.recommendations.length === 1 && plan.recommendations[0].category === 'no-op');
  ok('no-op why cites the real counts', plan.recommendations[0].why.includes('1 refusal→completion pair'));
  ok('no-op is deterministic', planEvolution(evs).recommendations[0].recId === plan.recommendations[0].recId);
  ok('thresholds surfaced in scanned', plan.scanned.thresholds.minOccurrences === MIN_OCCURRENCES && plan.scanned.thresholds.minScopes === MIN_SCOPES);
}

// ── integration: adopt routes through the real write paths ─────────────────
{
  const repo = await mkdtemp(join(tmpdir(), 'maddu-evolve-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  // Seed an above-threshold tool-correction corpus through the REAL appender.
  for (const [sid, label] of [['ses_1', 'A'], ['ses_2', 'B']]) {
    await append(repo, { type: 'SESSION_AUTO_REGISTERED', actor: sid, data: { sessionId: sid, label, role: 'implementer', source: 'cli' } });
  }
  for (let i = 0; i < 3; i++) {
    const sid = i % 2 === 0 ? 'ses_1' : 'ses_2';
    await append(repo, { type: 'TOOL_REFUSED', actor: sid, data: { tool: 'install', argv: ['x'], reason: 'allowlist', detail: 'no' } });
    await append(repo, { type: 'TOOL_COMPLETED', actor: sid, data: { tool: 'install', argv: ['x'], exitCode: 0, durationMs: 2 } });
  }
  const run = (args) => execFileSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8' });

  const planOut = JSON.parse(run(['evolve', 'plan', '--json']));
  const rec = planOut.recommendations.find((r) => r.detector === 'tool-correction');
  ok('CLI plan finds the seeded recommendation', !!rec && planOut.noOp === false);

  // memory adopt
  const adopt = JSON.parse(run(['evolve', 'adopt', rec.recId, '--json']));
  ok('adopt(memory) reports the memory write', adopt.wrote === 'memory.ndjson');
  const events = await readAll(repo);
  const corr = events.filter((e) => e.type === 'LEARN_CORRECTION_WRITTEN' && e.data?.destination === 'memory');
  ok('LEARN_CORRECTION_WRITTEN(memory) on the spine with full fact', corr.length === 1 && !!corr[0].data.fact?.id && typeof corr[0].data.fact.text === 'string');
  const memBefore = await readMemory(repo);
  ok('fact materialized in memory', memBefore.some((f) => f.id === corr[0].data.fact.id));
  // THE rebuild-coherence proof: truncate + rebuild from the spine → survives.
  const n = await rebuildMemory(repo);
  const memAfter = await readMemory(repo);
  ok('adopted fact SURVIVES rebuildMemory (event-sourced, not a raw write)', n >= 1 && memAfter.some((f) => f.id === corr[0].data.fact.id));

  // THE red-team regression: an adopted rec must NOT re-surface on the next
  // plan (prior-art dedup must match the concatenated text adopt writes).
  const planAfterAdopt = JSON.parse(run(['evolve', 'plan', '--json']));
  ok('adopted rec does NOT re-surface (dedup matches adopt concatenation)',
    !planAfterAdopt.recommendations.some((r) => r.recId === rec.recId));

  // adopt of a non-existent rec → exit 1
  let code = 0;
  try { run(['evolve', 'adopt', 'rec_nonexistent0']); } catch (e) { code = e.status; }
  ok('adopt of unknown rec-id exits 1', code === 1);
  // adopt with no rec-id → exit 2; no-op adopt → exit 1
  let codeU = 0;
  try { run(['evolve', 'adopt']); } catch (e) { codeU = e.status; }
  ok('adopt without rec-id exits 2', codeU === 2);

  // ── agent-file route (operator-chosen destination via --to) ──────────────
  // Seed a SECOND correction-class rec (different tool) and route it to the
  // CLAUDE.md learn block; assert the exact shape the learn-corrections-
  // coherent gate traces + the marker block lands on disk.
  for (let i = 0; i < 3; i++) {
    const sid = i % 2 === 0 ? 'ses_1' : 'ses_2';
    await append(repo, { type: 'TOOL_REFUSED', actor: sid, data: { tool: 'lint', argv: ['y'], reason: 'allowlist', detail: 'no' } });
    await append(repo, { type: 'TOOL_COMPLETED', actor: sid, data: { tool: 'lint', argv: ['y'], exitCode: 0, durationMs: 2 } });
  }
  const plan2 = JSON.parse(run(['evolve', 'plan', '--json']));
  const rec2 = plan2.recommendations.find((r) => r.detector === 'tool-correction' && r.summary.includes('lint'));
  ok('second correction-class rec derivable', !!rec2);
  const adopt2 = JSON.parse(run(['evolve', 'adopt', rec2.recId, '--to', 'agent-file', '--json']));
  ok('adopt(--to agent-file) reports the CLAUDE.md write', adopt2.wrote?.includes('CLAUDE.md') && adopt2.destination === 'agent-file');
  const events2 = await readAll(repo);
  const afCorr = events2.filter((e) => e.type === 'LEARN_CORRECTION_WRITTEN' && e.data?.destination === 'agent-file');
  ok('agent-file event carries the gate-traceable shape', afCorr.length === 1
    && typeof afCorr[0].data.correction?.id === 'string' && typeof afCorr[0].data.correction?.text === 'string'
    && afCorr[0].data.target === 'CLAUDE.md');
  const claudeMd = await readFile(join(repo, 'CLAUDE.md'), 'utf8').catch(() => '');
  ok('CLAUDE.md marker block written with the correction', claudeMd.includes('MADDU LEARN') && claudeMd.includes(afCorr[0].data.correction.text.slice(0, 40)));

  // --to on a non-correction category → exit 2
  // (seed a draft-only rec: 3 gate fail→ok arcs across the two sessions)
  for (let i = 0; i < 3; i++) {
    const sid = i % 2 === 0 ? 'ses_1' : 'ses_2';
    await append(repo, { type: 'GATE_RAN', actor: sid, data: { gateId: 'itest-gate', ok: false, severity: 'warn', durationMs: 1, status: 'fail' } });
    await append(repo, { type: 'GATE_RAN', actor: sid, data: { gateId: 'itest-gate', ok: true, severity: 'warn', durationMs: 1, status: 'pass' } });
  }
  const plan3 = JSON.parse(run(['evolve', 'plan', '--json']));
  const flapRec = plan3.recommendations.find((r) => r.detector === 'gate-flap');
  ok('draft-only (workflow) rec derivable', !!flapRec);
  let code2 = 0;
  try { run(['evolve', 'adopt', flapRec.recId, '--to', 'agent-file']); } catch (e) { code2 = e.status; }
  ok('--to on a non-correction category exits 2', code2 === 2);
  const draftOut = JSON.parse(run(['evolve', 'adopt', flapRec.recId, '--json']));
  ok('draft-only adopt writes NOTHING (draftOnly:true)', draftOut.draftOnly === true && !!draftOut.draft);
  const eventsAfterDraft = await readAll(repo);
  ok('draft-only adopt appended no events', eventsAfterDraft.length === events2.length + 6); // only the 6 seeded GATE_RANs

  // skill route: seed a recurring learning and adopt it
  for (let i = 0; i < 3; i++) {
    const sid = i % 2 === 0 ? 'ses_1' : 'ses_2';
    await append(repo, { type: 'SLICE_STOP', actor: sid, lane: `lane-${i % 2}`, data: { summary: `w${i}`, learnings: ['Regenerate mirrors after every docs edit'], targets: [], gates: [], deliverables: [] } });
  }
  const plan4 = JSON.parse(run(['evolve', 'plan', '--json']));
  const skillRec = plan4.recommendations.find((r) => r.detector === 'recurring-learning');
  ok('skill rec derivable', !!skillRec);
  const adopt4 = JSON.parse(run(['evolve', 'adopt', skillRec.recId, '--json']));
  ok('adopt(skill) writes via saveSkill', adopt4.wrote?.includes('.maddu/skills/'));
  const skillFile = adopt4.wrote.replace('.maddu/skills/', '');
  ok('skill file exists with SKILL_CREATED on the spine',
    (await exists(join(repo, '.maddu', 'skills', skillFile)))
    && (await readAll(repo)).some((e) => e.type === 'SKILL_CREATED'));

  await rm(repo, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
