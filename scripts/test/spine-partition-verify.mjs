// Test per-partition report-only chain verification (roadmap #12c phase 2). Run:
//   node scripts/test/spine-partition-verify.mjs
//
// A partitioned spine was previously INVISIBLE to verifySpine (it reads the flat
// events dir, finds no NNNNNNNNNNNN.ndjson, and returns "empty"). Phase 2 makes it
// walk each partition as its own prev_hash chain, report-only, tagging issues with
// replicaId. Cross-replica referential integrity is deferred to import (phase 3).

import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySpine } from '../../template/maddu/runtime/lib/verify.mjs';
import { hashLine, EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const TYPE = Object.keys(EVENT_TYPES)[0];

let idc = 0;
function eid() { return `evt_20260101000000_${String(++idc).padStart(6, '0').replace(/\d/g, (d) => 'abcdef'[d % 6])}`; }

// Build a VALID prev_hash chain file from a list of partial events.
function chainLines(evs) {
  const lines = [];
  let prev = null;
  for (const e of evs) {
    const ev = { v: 1, id: e.id || eid(), ts: e.ts || '2026-01-01T00:00:00Z', type: e.type || TYPE, actor: e.actor ?? null, lane: e.lane ?? null, data: e.data || {}, prev_hash: prev };
    const line = JSON.stringify(ev);
    lines.push(line);
    prev = hashLine(line);
  }
  return lines;
}
async function writePartition(repo, rid, evs) {
  const dir = join(repo, '.maddu', 'events', 'by-replica', rid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '000000000001.ndjson'), chainLines(evs).join('\n') + '\n');
  return dir;
}

async function main() {
  console.log('spine-partition-verify: per-partition chain verification');

  // A. Two clean partitions → no FAIL, no chain_broken; both partitions' segments
  //    are actually scanned (proves the spine is no longer invisible).
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-pv-clean-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }));
    await writePartition(repo, 'repA', [{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }]);
    await writePartition(repo, 'repB', [{ data: { n: 1 } }, { data: { n: 2 } }]);
    const r = await verifySpine(repo);
    ok(r.events === 5, `both partitions scanned (5 events, got ${r.events})`);
    ok(r.counts.FAIL === 0, `clean partitions: 0 FAIL (got ${r.counts.FAIL})`);
    ok(!r.issues.some((i) => i.kind === 'chain_broken'), 'clean partitions: no chain_broken');
    ok(r.segments.some((s) => s.replicaId === 'repA') && r.segments.some((s) => s.replicaId === 'repB'),
      'segments tagged with each replicaId');
    await rm(repo, { recursive: true, force: true });
  }

  // B. A forked partition (a trailing event with the WRONG prev_hash) → chain_broken
  //    FAIL (audit P1) tagged with that partition's replicaId; the OTHER partition
  //    stays clean. repA carries a leading SPINE_CUTOVER anchor (as syncInit now
  //    seeds), so it is a strict/post-cutover chain where a fork is FATAL, not WARN.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-pv-fork-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }));
    const dirA = await writePartition(repo, 'repA', [{ type: 'SPINE_CUTOVER', data: { version: '1.98.0' } }, { data: { n: 1 } }, { data: { n: 2 } }]);
    await writePartition(repo, 'repB', [{ data: { n: 1 } }]);
    // Append a forked line to repA: prev_hash null instead of the real predecessor.
    const forked = JSON.stringify({ v: 1, id: eid(), ts: '2026-01-01T00:00:05Z', type: TYPE, actor: null, lane: null, data: { n: 3 }, prev_hash: null });
    await appendFile(join(dirA, '000000000001.ndjson'), forked + '\n');
    const r = await verifySpine(repo);
    const broken = r.issues.filter((i) => i.kind === 'chain_broken');
    ok(broken.length === 1, `fork produces exactly one chain_broken (got ${broken.length})`);
    ok(broken[0]?.level === 'FAIL', `strict-chain fork is FAIL (got ${broken[0]?.level})`);
    ok(broken[0]?.replicaId === 'repA', `chain_broken tagged replicaId=repA (got ${broken[0]?.replicaId})`);
    ok(!r.issues.some((i) => i.kind === 'chain_broken' && i.replicaId === 'repB'), 'repB chain stays clean (independent)');
    await rm(repo, { recursive: true, force: true });
  }

  // C. Referential is DEFERRED in sync mode: a LANE_RELEASED with no prior
  //    LANE_CLAIMED inside a partition must NOT produce orphan_lane_release
  //    (that check needs the merged order → import/phase 3).
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-pv-ref-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }));
    await writePartition(repo, 'repA', [{ type: 'LANE_RELEASED', lane: 'harness', actor: 'ses_x', data: {} }]);
    const r = await verifySpine(repo);
    ok(!r.issues.some((i) => i.kind === 'orphan_lane_release'), 'sync mode: referential switch deferred (no orphan_lane_release)');
    await rm(repo, { recursive: true, force: true });
  }

  // D. A STRAY EMPTY by-replica dir must NOT flip a default repo into sync mode
  //    (which would silently disable the flat referential pass). Codex-found edge:
  //    verify keys on partitions that hold a segment file, not on a bare dir.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-pv-strayempty-'));
    const eventsDir = join(repo, '.maddu', 'events');
    await mkdir(join(eventsDir, 'by-replica', 'repA'), { recursive: true }); // empty partition dir
    // A flat orphan LANE_RELEASED — default mode must still FAIL it.
    await writeFile(join(eventsDir, '000000000001.ndjson'),
      chainLines([{ type: 'LANE_RELEASED', lane: 'harness', actor: 'ses_x', data: {} }]).join('\n') + '\n');
    const r = await verifySpine(repo);
    ok(r.issues.some((i) => i.kind === 'orphan_lane_release'),
      'stray empty partition dir does NOT disable flat referential (orphan_lane_release still flagged)');
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`spine-partition-verify: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
