// Tier-3 activation-funnel self-test (usage-audit roadmap, 2026-07-16).
// Run standalone:  node scripts/test/activation-funnel.mjs
//
// Proves the Tier-3 acceptance criteria:
//   1. STAGE LADDER — each ritual marker advances exactly one stage:
//      installed → healthy (doctor FAIL:0) → session → claimed → slice →
//      repeating (≥3 lifetime slice-stops).
//   2. PASSIVE ≠ ADOPTION — a repo with thousands of GATE_RAN/boot events
//      and failing doctor runs stays 'installed'; a green doctor alone only
//      reaches 'healthy'. The audit's 5/21 parked installs must read as
//      parked.
//   3. IMPORTED NEVER ADVANCES — a transcript-backfilled SLICE_STOP
//      (data.source stamped) moves nothing.
//   4. FURTHEST-STAGE MONOTONIC — markers are independent (slice-stops
//      without a witnessed healthy doctor still count) and lifetime (nothing
//      decays).
//   5. FLEET INTEGRATION — digestRepo carries the funnel; aggregate rolls up
//      per-stage counts over ALL repos.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIB = join(REPO, 'template', 'maddu', 'runtime', 'lib');
const toUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`);

const funnel = await import(toUrl(join(LIB, 'activation-funnel.mjs')));
const fleetLib = await import(toUrl(join(LIB, 'fleet.mjs')));
const insights = await import(toUrl(join(LIB, 'insights.mjs')));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

let seq = 0;
function evLine(type, data = {}) {
  seq++;
  return JSON.stringify({ v: 1, id: `evt_20260716080000_${String(seq).padStart(6, '0')}`, ts: '2026-07-16T08:00:00.000Z', type, actor: null, lane: null, data }) + '\n';
}

async function makeRepo(root, spineLines) {
  await mkdir(join(root, '.maddu', 'events'), { recursive: true });
  if (spineLines.length) await writeFile(join(root, '.maddu', 'events', '000000000001.ndjson'), spineLines.join(''));
}

const DOCTOR_GREEN = evLine('DOCTOR_REPORT', { counts: { PASS: 5, WARN: 1, FAIL: 0, INFO: 0 } });
const DOCTOR_RED = evLine('DOCTOR_REPORT', { counts: { PASS: 3, WARN: 0, FAIL: 2, INFO: 0 } });

const tmp = await mkdtemp(join(tmpdir(), 'maddu-t3-'));
try {
  // ── 1. Stage ladder ────────────────────────────────────────────────────────
  const ladder = [
    ['installed', []],
    ['installed', [DOCTOR_RED, evLine('FRAMEWORK_BOOTED'), evLine('GATE_RAN', { gateId: 'x', ok: true })]],
    ['healthy', [DOCTOR_GREEN]],
    ['session', [DOCTOR_GREEN, evLine('SESSION_REGISTERED', { session_id: 's1' })]],
    ['session', [DOCTOR_GREEN, evLine('SESSION_AUTO_REGISTERED', { session_id: 's1' })]],
    ['claimed', [DOCTOR_GREEN, evLine('SESSION_REGISTERED', {}), evLine('LANE_CLAIMED', { lane: 'general' })]],
    ['slice', [DOCTOR_GREEN, evLine('SESSION_REGISTERED', {}), evLine('LANE_CLAIMED', {}), evLine('SLICE_STOP', { summary: 's' })]],
    ['repeating', [DOCTOR_GREEN, evLine('SESSION_REGISTERED', {}), evLine('LANE_CLAIMED', {}), evLine('SLICE_STOP', {}), evLine('SLICE_STOP', {}), evLine('SLICE_STOP', {})]],
  ];
  for (let i = 0; i < ladder.length; i++) {
    const [expect, lines] = ladder[i];
    const root = join(tmp, `ladder-${i}`);
    await makeRepo(root, lines);
    const fn = await funnel.deriveFunnel(root);
    ok(fn && fn.stage === expect, `ladder[${i}] expects ${expect} (got ${fn?.stage})`);
    ok(fn && fn.nextAction && fn.stageIndex === funnel.FUNNEL_STAGES.indexOf(expect), `ladder[${i}] stageIndex + nextAction present`);
  }
  ok((await funnel.deriveFunnel(join(tmp, 'no-such-repo'))) === null, 'repo without .maddu → null (no funnel to be on)');

  // ── 2. Passive ≠ adoption ──────────────────────────────────────────────────
  const rPassive = join(tmp, 'passive');
  await makeRepo(rPassive, [
    evLine('FRAMEWORK_INSTALLED', {}), DOCTOR_RED,
    ...Array.from({ length: 200 }, () => evLine('GATE_RAN', { gateId: 'g', ok: true })),
    ...Array.from({ length: 50 }, () => evLine('FRAMEWORK_BOOTED')),
  ]);
  const fnPassive = await funnel.deriveFunnel(rPassive);
  ok(fnPassive.stage === 'installed', `250 passive events + red doctor stays installed (got ${fnPassive.stage})`);

  // ── 3. Imported never advances ─────────────────────────────────────────────
  const rImported = join(tmp, 'imported');
  await makeRepo(rImported, [
    DOCTOR_GREEN,
    evLine('SLICE_STOP', { summary: 'backfilled', source: 'claude-code-transcript' }),
    evLine('SESSION_REGISTERED', { source: 'import-submit' }),
    evLine('LANE_CLAIMED', { source: 'claude-code-transcript' }),
  ]);
  const fnImported = await funnel.deriveFunnel(rImported);
  ok(fnImported.stage === 'healthy', `imported ritual markers advance nothing (got ${fnImported.stage})`);
  ok(fnImported.tallies.sliceStops === 0 && fnImported.tallies.sessions === 0, 'imported markers not tallied');

  // ── 4. Furthest-stage, markers independent ─────────────────────────────────
  const rOrphan = join(tmp, 'orphan');
  await makeRepo(rOrphan, [evLine('SLICE_STOP', {}), evLine('SLICE_STOP', {}), evLine('SLICE_STOP', {}), evLine('SLICE_STOP', {})]);
  const fnOrphan = await funnel.deriveFunnel(rOrphan);
  ok(fnOrphan.stage === 'repeating', `4 slice-stops without doctor/session/claim still read repeating (got ${fnOrphan.stage})`);

  // Sync-mode repos: ritual markers living in by-replica partitions count —
  // a migrated team-sync repo must not regress to 'installed' (Codex Tier-3
  // round 1). Same shard listing feeds the insights harvest.
  const rSync = join(tmp, 'synced');
  await makeRepo(rSync, [DOCTOR_GREEN]); // residual flat segment
  const partDir = join(rSync, '.maddu', 'events', 'by-replica', 'replica-a');
  await mkdir(partDir, { recursive: true });
  await writeFile(join(partDir, '000000000001.ndjson'), [
    evLine('SESSION_REGISTERED', {}), evLine('LANE_CLAIMED', {}),
    evLine('SLICE_STOP', {}), evLine('SLICE_STOP', {}), evLine('SLICE_STOP', {}),
  ].join(''));
  const fnSync = await funnel.deriveFunnel(rSync);
  ok(fnSync.stage === 'repeating', `partitioned markers merge with residual flat (got ${fnSync.stage})`);
  ok(fnSync.tallies.sliceStops === 3 && fnSync.tallies.healthyDoctor === true, 'tallies span flat + partition shards');
  const [hSync] = await insights.harvestSpines([{ id: 'sync', label: 'sync', path: rSync }]);
  ok(hSync.counts.get('SLICE_STOP') === 3 && hSync.counts.get('DOCTOR_REPORT') === 1,
    `insights harvest reads partitions too (got ${hSync.counts.get('SLICE_STOP')}/${hSync.counts.get('DOCTOR_REPORT')})`);
  // Only CANONICAL segment names count (Codex round 2): stray backup/copy
  // .ndjson files — flat or inside a partition — are not spine data and must
  // neither inflate counts nor advance the funnel.
  await writeFile(join(rSync, '.maddu', 'events', 'backup.ndjson'), evLine('SLICE_STOP', {}).repeat(5));
  await writeFile(join(partDir, 'copy-of-segment.ndjson'), evLine('SLICE_STOP', {}));
  const fnStray = await funnel.deriveFunnel(rSync);
  ok(fnStray.tallies.sliceStops === 3, `non-canonical .ndjson files are ignored (got ${fnStray.tallies.sliceStops} slice-stops)`);
  // null-vs-empty contract: unreadable/absent events dir → null (caller skips
  // the project); readable-but-empty → [] (a real zero-event repo).
  ok((await insights.listSpineShards(join(tmp, 'nope', 'events'))) === null, 'absent events dir → null');
  const rEmpty = join(tmp, 'empty-events');
  await mkdir(join(rEmpty, '.maddu', 'events'), { recursive: true });
  const emptyShards = await insights.listSpineShards(join(rEmpty, '.maddu', 'events'));
  ok(Array.isArray(emptyShards) && emptyShards.length === 0, 'readable-but-empty events dir → []');
  ok((await insights.harvestSpines([{ id: 'gone', label: 'gone', path: join(tmp, 'nope') }])).length === 0,
    'unreadable spine skips the project instead of counting a zero-event repo');

  // deriveStage pure edges.
  ok(funnel.deriveStage({}) === 'installed', 'empty tallies → installed');
  ok(funnel.deriveStage({ healthyDoctor: true }) === 'healthy', 'healthy tally → healthy');
  ok(funnel.deriveStage({ sliceStops: 2, claims: 5, sessions: 5, healthyDoctor: true }) === 'slice', '2 slices → slice, not repeating');
  ok(funnel.nextActionFor('healthy').includes('hooks install') && !funnel.nextActionFor('healthy').includes(' — or '),
    'healthy next action is ONE action, not a menu');
  ok(funnel.nextActionFor('repeating').includes('nothing'), 'repeating next action is a no-op');

  // ── 5. Fleet integration ───────────────────────────────────────────────────
  // The third fixture's events carry OLD ids (2026-01-01) so its liveness is
  // NOT active — proving the funnel rollup spans ALL repos, not just active
  // ones (the funnel never decays; Codex Tier-3 round 1 flagged the earlier
  // fixtures as same-liveness and therefore not proving this).
  const rOld = join(tmp, 'old-active');
  await makeRepo(rOld, [
    JSON.stringify({ v: 1, id: 'evt_20260101000000_000001', ts: '2026-01-01T00:00:00.000Z', type: 'SESSION_REGISTERED', actor: null, lane: null, data: {} }) + '\n',
  ]);
  const dParked = await fleetLib.digestRepo({ id: 'passive', label: 'passive', path: rPassive });
  const dActive = await fleetLib.digestRepo({ id: 'orphan', label: 'orphan', path: rOrphan });
  const dOld = await fleetLib.digestRepo({ id: 'old', label: 'old', path: rOld });
  ok(dParked.funnel?.stage === 'installed' && dActive.funnel?.stage === 'repeating', 'digestRepo carries the funnel');
  ok(dOld.liveness !== 'active' && dOld.funnel?.stage === 'session', `old repo is non-active yet funnel-staged (got ${dOld.liveness}/${dOld.funnel?.stage})`);
  const agg = fleetLib.aggregate([dParked, dActive, dOld], Date.now());
  ok(agg.funnel && agg.funnel.installed === 1 && agg.funnel.repeating === 1 && agg.funnel.session === 1 && agg.funnel.claimed === 0,
    `aggregate rolls up per-stage counts over ALL liveness tiers (got ${JSON.stringify(agg.funnel)})`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`activation-funnel: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
