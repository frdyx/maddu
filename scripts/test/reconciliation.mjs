// Roadmap #12c phase 4 — lane-claim reconciliation as a PURE PROJECTION. Run:
//   node scripts/test/reconciliation.mjs
//
// The load-bearing properties (from docs/research/roadmap-12c-team-sync-proposal.md §D):
//   1. DEFAULT PATH BYTE-IDENTICAL — a normal single-owner claim projects the
//      same {lane,sessionId,focus,claimedAt} shape it always did; contentions [].
//   2. WINNER = earliest in the k-way-merged total order (first-claimer holds);
//      later concurrent claims are computed as superseded, exposed as a read-time
//      `contentions` view. ZERO spine writes — nothing is appended to reconcile.
//   3. MONOTONIC under late arrivals — a late-synced EARLIER-ts claim flips the
//      winner on the next rebuild (no frozen "B won" record to contradict).
//   4. CONVERGENT — same union of events → same holder on every replica.
//   5. A same-owner re-claim updates data (LWW) but keeps its rank; a release
//      drops only the releasing owner, never the surviving co-claimant.

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append, EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';
import { project } from '../../template/maddu/runtime/lib/projections.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

const CLAIMED = EVENT_TYPES.LANE_CLAIMED;   // 'LANE_CLAIMED'
const RELEASED = EVENT_TYPES.LANE_RELEASED; // 'LANE_RELEASED'

// Stage a sync-mode fixture: one ndjson segment per replica partition, plus the
// committed replica.json that makes readAll route through readAllPartitioned.
// Rows are minimal event envelopes; the reducer only reads type/actor/lane/ts/data.
async function syncRepo(self, partitions) {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-reconcile-'));
  await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
  await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: self }) + '\n');
  for (const [rid, rows] of Object.entries(partitions)) {
    const dir = join(repo, '.maddu', 'events', 'by-replica', rid);
    await mkdir(dir, { recursive: true });
    const body = rows.map((r) => JSON.stringify({ v: 1, ...r })).join('\n') + '\n';
    await writeFile(join(dir, '000000000001.ndjson'), body);
  }
  return repo;
}
const claimRow = (id, ts, actor, lane, focus = null) =>
  ({ id, ts, type: CLAIMED, actor, lane, data: { focus } });
const releaseRow = (id, ts, actor, lane) =>
  ({ id, ts, type: RELEASED, actor, lane, data: {} });

async function main() {
  console.log('reconciliation: pure-projection lane-claim tie-break');

  // 1. DEFAULT PATH BYTE-IDENTICAL — single owner, real flat append path.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-reconcile-flat-'));
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'portability', data: { focus: 'work' } });
    const p = await project(repo);
    ok(p.claims.length === 1, 'single claim → one holder');
    const c = p.claims[0];
    ok(c.lane === 'portability' && c.sessionId === 'sesA' && c.focus === 'work',
      'holder shape {lane,sessionId,focus} preserved');
    ok(typeof c.claimedAt === 'string' && !('_order' in c), 'claimedAt kept, internal _order not leaked');
    ok(Array.isArray(p.contentions) && p.contentions.length === 0, 'no contention on the default path');
    await rm(repo, { recursive: true, force: true });
  }

  // 2. Same-owner re-claim: LWW data, no contention, still one holder.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-reconcile-reclaim-'));
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'x', data: { focus: 'f1' } });
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'x', data: { focus: 'f2' } });
    const p = await project(repo);
    ok(p.claims.length === 1 && p.claims[0].focus === 'f2', 'same-owner re-claim = last-writer-wins data');
    ok(p.contentions.length === 0, 'same owner never contends with itself');
    await rm(repo, { recursive: true, force: true });
  }

  // 3. Claim → release → re-claim (flat): released lane leaves no holder, then re-holds.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-reconcile-cycle-'));
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'x', data: { focus: 'a' } });
    await append(repo, { type: RELEASED, actor: 'sesA', lane: 'x', data: {} });
    ok((await project(repo)).claims.length === 0, 'release empties the lane (byte-identical)');
    await append(repo, { type: CLAIMED, actor: 'sesB', lane: 'x', data: { focus: 'b' } });
    const p = await project(repo);
    ok(p.claims.length === 1 && p.claims[0].sessionId === 'sesB', 're-claim after release installs the new holder');
    ok(p.contentions.length === 0, 'sequential claim/release never produces a contention');
    await rm(repo, { recursive: true, force: true });
  }

  // 4. CONCURRENT claims, two partitions — winner = earliest in the total order.
  //    A@t1 sorts before B@t2, so A holds; B is superseded and surfaced.
  {
    const repo = await syncRepo('self', {
      repA: [claimRow('a1', '2026-01-01T00:00:01Z', 'sesA', 'lane-z', 'A-work')],
      repB: [claimRow('b1', '2026-01-01T00:00:02Z', 'sesB', 'lane-z', 'B-work')],
    });
    const p = await project(repo);
    ok(p.claims.length === 1 && p.claims[0].sessionId === 'sesA', 'earliest-ts claim (A) holds the lane');
    ok(p.contentions.length === 1, 'one contention surfaced');
    const con = p.contentions[0];
    ok(con.lane === 'lane-z' && con.holder.sessionId === 'sesA', 'contention names the winner as holder');
    ok(con.superseded.length === 1 && con.superseded[0].sessionId === 'sesB', 'loser (B) listed as superseded');
    await rm(repo, { recursive: true, force: true });
  }

  // 5. MONOTONICITY — a late-arriving EARLIER-ts claim flips the winner on rebuild.
  //    Round 1: only A's partition (t=5) → A holds. Round 2: B's partition appears
  //    with an EARLIER ts (t=2) → B now sorts first in the merge → B holds. No
  //    reconciliation record accumulates; the decision self-corrects.
  {
    // round 1
    const r1 = await syncRepo('self', {
      repA: [claimRow('a1', '2026-01-01T00:00:05Z', 'sesA', 'lane-z', 'A')],
    });
    const p1 = await project(r1);
    ok(p1.claims[0].sessionId === 'sesA' && p1.contentions.length === 0, 'round 1: A holds alone');
    await rm(r1, { recursive: true, force: true });
    // round 2: same A partition + a late B claim with an earlier ts
    const r2 = await syncRepo('self', {
      repA: [claimRow('a1', '2026-01-01T00:00:05Z', 'sesA', 'lane-z', 'A')],
      repB: [claimRow('b1', '2026-01-01T00:00:02Z', 'sesB', 'lane-z', 'B')],
    });
    const p2 = await project(r2);
    ok(p2.claims[0].sessionId === 'sesB', 'round 2: late earlier-ts claim (B) FLIPS the winner');
    ok(p2.contentions.length === 1 && p2.contentions[0].superseded[0].sessionId === 'sesA',
      'the former holder (A) is now the superseded one — monotonic, self-correcting');
    await rm(r2, { recursive: true, force: true });
  }

  // 6. CONVERGENCE — the union is order-independent: projecting the same two
  //    partitions yields the same holder no matter which replica is "self".
  {
    const parts = {
      repA: [claimRow('a1', '2026-01-01T00:00:01Z', 'sesA', 'lane-z', 'A')],
      repB: [claimRow('b1', '2026-01-01T00:00:02Z', 'sesB', 'lane-z', 'B')],
    };
    const fromA = await syncRepo('repA', parts);
    const fromB = await syncRepo('repB', parts);
    const wA = (await project(fromA)).claims[0].sessionId;
    const wB = (await project(fromB)).claims[0].sessionId;
    ok(wA === 'sesA' && wB === 'sesA', 'both replicas converge on the same holder (sesA)');
    await rm(fromA, { recursive: true, force: true });
    await rm(fromB, { recursive: true, force: true });
  }

  // 7. Release of one co-claimant leaves the survivor holding, contention gone.
  {
    const repo = await syncRepo('self', {
      repA: [claimRow('a1', '2026-01-01T00:00:01Z', 'sesA', 'lane-z', 'A')],
      repB: [
        claimRow('b1', '2026-01-01T00:00:02Z', 'sesB', 'lane-z', 'B'),
        releaseRow('b2', '2026-01-01T00:00:03Z', 'sesB', 'lane-z'),
      ],
    });
    const p = await project(repo);
    ok(p.claims.length === 1 && p.claims[0].sessionId === 'sesA', 'B released → A holds alone');
    ok(p.contentions.length === 0, 'contention clears once the rival releases');
    await rm(repo, { recursive: true, force: true });
  }

  // 8. Three-way contention: superseded lists BOTH losers in total order.
  {
    const repo = await syncRepo('self', {
      repA: [claimRow('a1', '2026-01-01T00:00:01Z', 'sesA', 'lane-z', 'A')],
      repB: [claimRow('b1', '2026-01-01T00:00:02Z', 'sesB', 'lane-z', 'B')],
      repC: [claimRow('c1', '2026-01-01T00:00:03Z', 'sesC', 'lane-z', 'C')],
    });
    const con = (await project(repo)).contentions[0];
    ok(con.holder.sessionId === 'sesA', '3-way: earliest (A) holds');
    ok(con.superseded.map((s) => s.sessionId).join(',') === 'sesB,sesC',
      '3-way: both losers listed in total order (B then C)');
    await rm(repo, { recursive: true, force: true });
  }

  // 9. A co-claimant's session close (in its own partition) drops only its claim.
  {
    const repo = await syncRepo('self', {
      repA: [claimRow('a1', '2026-01-01T00:00:01Z', 'sesA', 'lane-z', 'A')],
      repB: [
        claimRow('b1', '2026-01-01T00:00:02Z', 'sesB', 'lane-z', 'B'),
        { id: 'b2', ts: '2026-01-01T00:00:04Z', type: EVENT_TYPES.SESSION_CLOSED, actor: 'sesB', data: {} },
      ],
    });
    const p = await project(repo);
    ok(p.claims.length === 1 && p.claims[0].sessionId === 'sesA', 'SESSION_CLOSED releases B, A survives');
    ok(p.contentions.length === 0, 'no contention after the closing session drops out');
    await rm(repo, { recursive: true, force: true });
  }

  // 10. DEFAULT PATH BYTE-IDENTICAL: reconciliation is scoped to sync mode, so
  //     on the flat path the reducer runs the EXACT pre-#12c logic — a
  //     LANE_RELEASED clears the lane unconditionally, regardless of actor.
  //     Sequence: A claims x; B (never claimed x) releases x → x cleared.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-reconcile-nonholder-'));
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'x', data: { focus: 'a' } });
    await append(repo, { type: RELEASED, actor: 'sesB', lane: 'x', data: {} });
    const p = await project(repo);
    ok(p.claims.length === 0, 'flat path: any LANE_RELEASED clears the lane (byte-identical)');
    ok(p.contentions.length === 0, 'flat path: contentions always empty');
    await rm(repo, { recursive: true, force: true });
  }

  // 11. BYTE-IDENTICAL ORDERING: release + re-claim preserves the old
  //     delete-then-reinsert order. A claims x; C claims y; A releases x
  //     (x cleared); A re-claims x → x re-inserted at the end → order must be
  //     [y, x], exactly as the pre-#12c reducer produced.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-reconcile-order-'));
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'x', data: { focus: 'a' } });
    await append(repo, { type: CLAIMED, actor: 'sesC', lane: 'y', data: { focus: 'c' } });
    await append(repo, { type: RELEASED, actor: 'sesA', lane: 'x', data: {} });
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'x', data: { focus: 'a2' } });
    const order = (await project(repo)).claims.map((c) => c.lane).join(',');
    ok(order === 'y,x', `claim order preserved after holder release + re-claim — got ${order}`);
    await rm(repo, { recursive: true, force: true });
  }

  // 12. SYNC-CORRECT: with 2+ live claimants, a NON-owner release is a no-op —
  //     it must not evict a surviving holder.
  {
    const repo = await syncRepo('self', {
      repA: [claimRow('a1', '2026-01-01T00:00:01Z', 'sesA', 'lane-z', 'A')],
      repB: [claimRow('b1', '2026-01-01T00:00:02Z', 'sesB', 'lane-z', 'B')],
      repC: [releaseRow('c1', '2026-01-01T00:00:03Z', 'sesC', 'lane-z')],
    });
    const p = await project(repo);
    ok(p.claims.length === 1 && p.claims[0].sessionId === 'sesA', 'contended lane: non-owner release does not evict the holder');
    ok(p.contentions.length === 1 && p.contentions[0].superseded[0].sessionId === 'sesB',
      'both real claimants survive a bogus foreign release');
    await rm(repo, { recursive: true, force: true });
  }

  // 13. SYNC-CORRECT (sole remote claimant): a foreign release must NOT evict
  //     the only holder. repA claims x; repC releases x (never claimed it) →
  //     no-op → A keeps holding x. Same rule as flat case 10, exercised through
  //     the partitioned read path (interpretation is mode-independent).
  {
    const repo = await syncRepo('self', {
      repA: [claimRow('a1', '2026-01-01T00:00:01Z', 'sesA', 'x', 'A')],
      repC: [releaseRow('c1', '2026-01-01T00:00:02Z', 'sesC', 'x')],
    });
    const p = await project(repo);
    ok(p.claims.length === 1 && p.claims[0].sessionId === 'sesA', 'sync: foreign release does NOT evict the sole holder');
    ok(p.contentions.length === 0, 'sync: no contention from a foreign release on a sole-owner lane');
    await rm(repo, { recursive: true, force: true });
  }

  // 14. DEFAULT PATH BYTE-IDENTICAL under the local claim RACE. The mutex-free
  //     spine can land two LANE_CLAIMED on one lane (both claimants passed the
  //     guard before either append was visible). On the flat path this MUST
  //     resolve exactly as the pre-#12c reducer did: last-writer-wins, NO
  //     contention surfaced. (In sync mode the same shape resolves to the
  //     earliest claimant + a contention — case 4 — which is the whole point of
  //     scoping reconciliation to sync mode.)
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-reconcile-race-'));
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'x', data: { focus: 'a' } });
    await append(repo, { type: CLAIMED, actor: 'sesB', lane: 'x', data: { focus: 'b' } });
    const p = await project(repo);
    ok(p.claims.length === 1 && p.claims[0].sessionId === 'sesB', 'flat race: last-writer-wins (byte-identical LWW)');
    ok(p.contentions.length === 0, 'flat race: no contention surfaced (default path unchanged)');
    await rm(repo, { recursive: true, force: true });
  }

  // 15. DEFAULT PATH BYTE-IDENTICAL: stale release after a force-claim. Force
  //     emits RELEASED(prior) + CLAIMED(new); a prior holder's stale release can
  //     land afterward. On the flat path the final unconditional clear wins,
  //     exactly as before. Sequence mirrors Codex's round-4 scenario 1.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-reconcile-stale-'));
    await append(repo, { type: CLAIMED, actor: 'sesA', lane: 'x', data: { focus: 'a' } });
    await append(repo, { type: RELEASED, actor: 'sesA', lane: 'x', data: { reason: 'force-preempt' } });
    await append(repo, { type: CLAIMED, actor: 'sesB', lane: 'x', data: { focus: 'b', forcedFrom: 'sesA' } });
    await append(repo, { type: RELEASED, actor: 'sesA', lane: 'x', data: {} }); // stale
    const p = await project(repo);
    ok(p.claims.length === 0, 'flat: stale release after force clears the lane (byte-identical)');
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`reconciliation: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
