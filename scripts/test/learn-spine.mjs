#!/usr/bin/env node
// learn-spine (EXP phase 4) — fixture for the spine-corpus mining shared by
// `maddu learn --spine` and `maddu evolve`'s detectors.
//
// Lib level: pairing laws (tool first-match, gate FIFO arcs, non-clean
// reviews), learn-candidate shape fidelity, content-hashed idempotent ids,
// determinism, torn-line tolerance.
// Integration: `maddu learn digest --spine` in a real temp repo — spine
// candidates ride the digest, LEARN_MINED counts them, re-mining is
// idempotent (same ids), and WITHOUT --spine the digest is unchanged
// (opt-in inertness).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mineToolPairs, mineGateArcs, mineReviewFindings, spineCandidates } from '../../template/maddu/runtime/lib/learn-spine.mjs';
import { append, readAll } from '../../template/maddu/runtime/lib/spine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

let seq = 0;
const ev = (id, type, actor, data) =>
  ({ v: 1, id, ts: `2026-01-01T00:00:${String(seq++).padStart(2, '0')}.000Z`, type, actor, lane: null, data });

// ── pairing laws ────────────────────────────────────────────────────────────
{
  seq = 0;
  const events = [
    ev('e_r1', 'TOOL_REFUSED',   'ses_a', { tool: 'install', argv: ['a'], reason: 'allowlist', detail: 'no' }),
    ev('e_r2', 'TOOL_REFUSED',   null,    { tool: 'install', argv: ['b'], reason: 'allowlist', detail: 'no' }), // replaces r1 (unconsumed)
    ev('e_c1', 'TOOL_COMPLETED', null,    { tool: 'install', argv: ['b', '--ok'], exitCode: 0 }),
    ev('e_c2', 'TOOL_COMPLETED', null,    { tool: 'install', argv: ['c'], exitCode: 0 }), // no open refusal — unpaired
    ev('e_r3', 'TOOL_REFUSED',   null,    { tool: 'git', argv: ['push', '-f'], reason: 'dangerous-form', detail: 'no' }), // never completed
  ];
  const pairs = mineToolPairs(events);
  ok('first-match pairing: newest refusal wins, one pair', pairs.length === 1 && pairs[0].refusal.id === 'e_r2' && pairs[0].completion.id === 'e_c1');
  ok('unconsumed refusal + free completion stay unpaired', !pairs.some((p) => p.refusal.id === 'e_r1' || p.completion.id === 'e_c2'));

  const gates = mineGateArcs([
    ev('g_f1', 'GATE_RAN', null, { gateId: 'g1', ok: false, status: 'fail', severity: 'warn' }),
    ev('g_f2', 'GATE_RAN', null, { gateId: 'g1', ok: false, status: 'fail', severity: 'warn' }),
    ev('g_o1', 'GATE_RAN', null, { gateId: 'g1', ok: true, status: 'pass' }),
    ev('g_x1', 'GATE_RAN', null, { gateId: 'g2', ok: true, status: 'pass' }),
  ]);
  ok('gate arcs are FIFO (oldest fail consumed first)', gates.arcs.length === 1 && gates.arcs[0].fail.id === 'g_f1' && gates.arcs[0].ok.id === 'g_o1');
  ok('unresolved fails counted per gate', gates.unresolvedFails === 1 && gates.perGate.g1.unresolvedFails === 1 && gates.gatesSeen === 2);

  const findings = mineReviewFindings([
    ev('rv_1', 'SLICE_REVIEWED', null, { sliceEventId: 'evt_s1', verdict: 'CLEAN', findingsCount: 0 }),
    ev('rv_2', 'SLICE_REVIEWED', null, { sliceEventId: 'evt_s2', verdict: 'P2', findingsCount: 3 }),
    ev('rv_3', 'SLICE_REVIEWED', null, { sliceEventId: 'evt_s3', verdict: 'INFO', findingsCount: 1 }),
  ]);
  ok('only non-clean/non-info reviews become findings', findings.length === 1 && findings[0].verdict === 'P2' && findings[0].sliceEventId === 'evt_s2');
}

// ── candidate shape + determinism ───────────────────────────────────────────
{
  seq = 20;
  const events = [
    ev('c_r', 'TOOL_REFUSED',   'ses_a', { tool: 'lint', argv: ['x'], reason: 'allowlist', detail: 'denied' }),
    ev('c_c', 'TOOL_COMPLETED', null,    { tool: 'lint', argv: ['x', '--fix'], exitCode: 0 }),
    ev('c_gf', 'GATE_RAN', null, { gateId: 'gX', ok: false, status: 'fail', severity: 'warn' }),
    ev('c_go', 'GATE_RAN', null, { gateId: 'gX', ok: true, status: 'pass' }),
    ev('c_rv', 'SLICE_REVIEWED', 'ses_a', { sliceEventId: 'evt_sX', verdict: 'P1', findingsCount: 2 }),
  ];
  const cands = spineCandidates(events);
  ok('three candidate kinds emitted', cands.length === 3
    && cands.some((c) => c.category === 'spine-tool-recovery')
    && cands.some((c) => c.category === 'spine-gate-recovery')
    && cands.some((c) => c.category === 'spine-review-finding'));
  const tool = cands.find((c) => c.category === 'spine-tool-recovery');
  ok('learn-candidate shape fields present', tool.id.startsWith('lrn_') && tool.slug === '(spine)'
    && tool.tool === 'lint' && typeof tool.failure === 'string' && typeof tool.success === 'string'
    && tool.failureError === 'allowlist: denied' && Array.isArray(tool.sourceEvents));
  ok('sessionUuid carries linkage when present', tool.sessionUuid === 'ses_a');
  const again = spineCandidates(events);
  ok('ids deterministic across runs', JSON.stringify(cands.map((c) => c.id)) === JSON.stringify(again.map((c) => c.id)));
  ok('torn lines tolerated', spineCandidates([null, {}, ...events]).length === 3);
  ok('empty input → empty output', spineCandidates([]).length === 0 && spineCandidates(undefined).length === 0);
}

// ── integration: learn digest --spine in a real temp repo ──────────────────
{
  const repo = await mkdtemp(join(tmpdir(), 'maddu-lspine-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await append(repo, { type: 'TOOL_REFUSED', actor: null, data: { tool: 'install', argv: ['p'], reason: 'allowlist', detail: 'no' } });
  await append(repo, { type: 'TOOL_COMPLETED', actor: null, data: { tool: 'install', argv: ['p', '--ok'], exitCode: 0 } });
  await append(repo, { type: 'GATE_RAN', actor: null, data: { gateId: 'ig', ok: false, status: 'fail', severity: 'warn' } });
  await append(repo, { type: 'GATE_RAN', actor: null, data: { gateId: 'ig', ok: true, status: 'pass' } });
  // Point the transcript root at an EMPTY dir so mining is spine-only + hermetic.
  const emptyRoot = join(repo, 'no-transcripts');
  await mkdir(emptyRoot, { recursive: true });
  const run = (args) => execFileSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8' });

  const withSpine = JSON.parse(run(['learn', 'digest', '--spine', '--root', emptyRoot, '--json']));
  ok('digest --spine carries the spine candidates', withSpine.paired === 2 && withSpine.spinePaired === 2
    && withSpine.candidates.every((c) => c.slug === '(spine)'));
  ok('spine categories counted', withSpine.counts['spine-tool-recovery'] === 1 && withSpine.counts['spine-gate-recovery'] === 1);

  const withoutSpine = JSON.parse(run(['learn', 'digest', '--root', emptyRoot, '--json']));
  ok('WITHOUT --spine the digest is unchanged (opt-in inertness)', withoutSpine.paired === 0 && withoutSpine.spinePaired === undefined && withoutSpine.candidates.length === 0);

  const again = JSON.parse(run(['learn', 'digest', '--spine', '--root', emptyRoot, '--json']));
  ok('re-mining is idempotent (same content-hashed ids)',
    JSON.stringify(again.candidates.map((c) => c.id).sort()) === JSON.stringify(withSpine.candidates.map((c) => c.id).sort()));

  // Red-team F1 regression: two IDENTICAL refusal->completion pairs (same tool,
  // same redacted argv) content-hash to the same id - the digest carries it ONCE.
  await append(repo, { type: 'TOOL_REFUSED', actor: null, data: { tool: 'install', argv: ['p'], reason: 'allowlist', detail: 'no' } });
  await append(repo, { type: 'TOOL_COMPLETED', actor: null, data: { tool: 'install', argv: ['p', '--ok'], exitCode: 0 } });
  const dup = JSON.parse(run(['learn', 'digest', '--spine', '--root', emptyRoot, '--json']));
  const ids = dup.candidates.map((c) => c.id);
  ok('identical spine pairs dedup to ONE candidate (unique ids)', new Set(ids).size === ids.length && dup.spinePaired === 2);

  const mined = (await readAll(repo)).filter((e) => e.type === 'LEARN_MINED');
  ok('LEARN_MINED reflects the merged paired count', mined.length === 4 && mined[0].data.paired === 2 && mined[1].data.paired === 0);

  await rm(repo, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
