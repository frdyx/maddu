#!/usr/bin/env node
// autonomy-cli — the `maddu autonomy` verb + events + enrichment (roadmap #11, phase 3).
//
// Subprocess assertions against a scratch repo with a seeded spine:
//   1. table + --json render, schemaVersion 1, deterministic configHash
//   2. AUTONOMY_SCORED appended on explicit runs; --no-emit suppresses it
//   3. AUTONOMY_RECOMMENDATION emitted on rung change ONCE (spine-deduped:
//      a second run with no change emits no new recommendation)
//   4. relax recommendation is MUTED while any phase is active (floor absolute)
//   5. GATE_RAN enrichment: slice-stop stamps actor onto the gate events it runs
//   6. the recommend-only contract: governance.json is never created/modified
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => (s || '').replace(ANSI_RE, '');

function run(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: strip((r.stdout || '') + (r.stderr || '')) , stdout: r.stdout || '' };
}

async function readSpineEvents(repo) {
  const dir = path.join(repo, '.maddu', 'events');
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort();
  const events = [];
  for (const f of files) {
    for (const line of (await readFile(path.join(dir, f), 'utf8')).split('\n')) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return events;
}

async function main() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'maddu-autonomy-cli-'));
  try {
    await mkdir(path.join(repo, '.maddu', 'events'), { recursive: true });
    await mkdir(path.join(repo, '.maddu', 'state'), { recursive: true });

    // Seed the spine through the real append API so prev_hash chains hold.
    const spine = await import(pathToFileURL(path.join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib', 'spine.mjs')).href);
    await spine.append(repo, { type: 'SESSION_REGISTERED', actor: 'ses_fix', lane: 'backend', data: { role: 'implementer' } });
    // 22 clean outcomes spread over 5 synthetic days is impossible via append
    // (append stamps real timestamps), so seed a smaller record and drive the
    // rung change with a threshold override instead: candidateMinN=3,
    // candidateWilson=0.4 → 5 clean same-day outcomes cross into candidate.
    for (let i = 0; i < 5; i++) {
      await spine.append(repo, {
        type: 'SLICE_STOP', actor: 'ses_fix', lane: null,
        data: { summary: `did slice ${i}`, deliverables: { declared: 1, verified: 1, missing: [] } },
      });
    }
    await mkdir(path.join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(path.join(repo, '.maddu', 'config', 'autonomy.json'),
      JSON.stringify({ thresholds: { candidateMinN: 3, candidateWilson: 0.4, minN: 3 } }, null, 2) + '\n');

    // ── 1. render + --json ──
    const j1 = run(repo, ['autonomy', '--json']);
    ok('exits 0', j1.code === 0, String(j1.code));
    const parsed = JSON.parse(j1.stdout);
    ok('schemaVersion 1', parsed.schemaVersion === 1);
    ok('backend lane attributed via session join', parsed.lanes.some((l) => l.lane === 'backend'), JSON.stringify(parsed.lanes.map((l) => l.lane)));
    const backend = parsed.lanes.find((l) => l.lane === 'backend');
    ok('5 clean outcomes counted', backend.clean === 5, String(backend.clean));
    ok('threshold override → relaxation-candidate', backend.rung === 'relaxation-candidate', backend.rung);
    ok('configHash present + overridden', typeof parsed.configHash === 'string' && parsed.configHash.length === 16);

    // ── 2+3. events: SCORED every run, RECOMMENDATION once ──
    let events = await readSpineEvents(repo);
    const scored1 = events.filter((e) => e.type === 'AUTONOMY_SCORED').length;
    const recs1 = events.filter((e) => e.type === 'AUTONOMY_RECOMMENDATION');
    ok('AUTONOMY_SCORED appended', scored1 === 1, String(scored1));
    ok('rung change → one AUTONOMY_RECOMMENDATION', recs1.length === 1, String(recs1.length));
    ok('recommendation is consider-relaxed', recs1[0]?.data?.recommendation === 'consider-relaxed', recs1[0]?.data?.recommendation);
    ok('recommendation carries configHash', recs1[0]?.data?.configHash === parsed.configHash);

    const r2 = run(repo, ['autonomy']);
    ok('second run exits 0', r2.code === 0);
    events = await readSpineEvents(repo);
    ok('no duplicate recommendation on unchanged rung',
      events.filter((e) => e.type === 'AUTONOMY_RECOMMENDATION').length === 1,
      String(events.filter((e) => e.type === 'AUTONOMY_RECOMMENDATION').length));
    ok('scored appended again on explicit run', events.filter((e) => e.type === 'AUTONOMY_SCORED').length === 2);

    const before = (await readSpineEvents(repo)).length;
    run(repo, ['autonomy', '--no-emit']);
    ok('--no-emit appends nothing', (await readSpineEvents(repo)).length === before);

    // ── 4. phase floor mutes relax recommendations ──
    const repo2 = await mkdtemp(path.join(os.tmpdir(), 'maddu-autonomy-cli2-'));
    try {
      await mkdir(path.join(repo2, '.maddu', 'events'), { recursive: true });
      await mkdir(path.join(repo2, '.maddu', 'config'), { recursive: true });
      await spine.append(repo2, { type: 'SESSION_REGISTERED', actor: 'ses_p', lane: 'backend', data: {} });
      await spine.append(repo2, { type: 'PHASE_DECLARED', actor: 'ses_p', data: { name: 'release-freeze', tier: 'strict' } });
      for (let i = 0; i < 5; i++) {
        await spine.append(repo2, { type: 'SLICE_STOP', actor: 'ses_p', lane: null, data: { summary: `s${i}`, deliverables: { declared: 1, verified: 1, missing: [] } } });
      }
      await writeFile(path.join(repo2, '.maddu', 'config', 'autonomy.json'),
        JSON.stringify({ thresholds: { candidateMinN: 3, candidateWilson: 0.4, minN: 3 } }) + '\n');
      const p1 = run(repo2, ['autonomy', '--json']);
      const pp = JSON.parse(p1.stdout);
      const rec = pp.recommendations.find((c) => c.lane === 'backend');
      ok('phase active → recommendation muted', rec && rec.muted === true, JSON.stringify(rec));
      ok('mutedReason names the phase', /release-freeze/.test(rec?.mutedReason || ''), rec?.mutedReason);
      // Governance file must never appear (recommend-only contract).
      let govExists = true;
      try { await stat(path.join(repo2, '.maddu', 'state', 'config', 'governance.json')); } catch { govExists = false; }
      ok('governance config never written', !govExists);
    } finally {
      await rm(repo2, { recursive: true, force: true });
    }

    // ── 5. GATE_RAN enrichment via slice-stop ──
    // slice-stop runs the completion-claim gate with attribution; assert the
    // resulting GATE_RAN carries the session as actor.
    const r3 = run(repo, ['slice-stop', '--session', 'ses_fix', '--summary', 'enrichment probe slice'], { MADDU_SESSION_ID: 'ses_fix' });
    ok('slice-stop exits 0', r3.code === 0, r3.out.slice(0, 120));
    events = await readSpineEvents(repo);
    const gateRuns = events.filter((e) => e.type === 'GATE_RAN');
    ok('slice-stop emitted a GATE_RAN', gateRuns.length >= 1, String(gateRuns.length));
    ok('GATE_RAN stamped with the session actor', gateRuns.some((g) => g.actor === 'ses_fix'),
      JSON.stringify(gateRuns.map((g) => g.actor)));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }

  console.log('');
  console.log(`autonomy-cli: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('autonomy-cli OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
