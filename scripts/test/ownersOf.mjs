// ownersOf / foldOwnership unit fixture (PR-C, v1.113.0).
//
// ownersOf is the write-time ownership authority: every serialized lane writer
// (claim / release / force / auto-claim / janitor) calls it on a fresh in-lock
// snapshot to see the FULL owner set — holder plus superseded owners — and
// decide mode-aware. This fixture pins its contract in BOTH modes, and asserts
// it agrees with reduceClaims (the read-time authority) so writer decisions and
// projection display can never disagree.

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'template/maddu/runtime/lib/projections.mjs');
const { ownersOf, reduceClaims, foldOwnership } = await import(pathToFileURL(LIB).href);

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL ${name}`); } };
const ev = (type, actor, lane, extra = {}) => ({
  type, actor, lane, ts: extra.ts || '2026-01-01T00:00:00Z', data: extra.data || {},
});

// ── DEFAULT mode (last-writer-claim, unconditional release-clear) ─────────────
{
  const evs = [ev('LANE_CLAIMED', 'ses_a', 'L1'), ev('LANE_CLAIMED', 'ses_b', 'L1')];
  let o = ownersOf(evs, 'L1', { syncMode: false });
  ok('default: last-writer is holder', o.mode === 'default' && o.holder && o.holder.sessionId === 'ses_b');
  ok('default: owners = [holder]', o.owners.length === 1 && o.owners[0].sessionId === 'ses_b');

  o = ownersOf([...evs, ev('LANE_RELEASED', 'ses_b', 'L1')], 'L1', { syncMode: false });
  ok('default: release clears holder', o.holder === null && o.owners.length === 0);

  o = ownersOf([...evs, ev('SESSION_CLOSED', 'ses_b', null)], 'L1', { syncMode: false });
  ok('default: session-close clears holder', o.holder === null);

  o = ownersOf([...evs, ev('SESSION_AUTO_CLOSED', 'ses_b', null)], 'L1', { syncMode: false });
  ok('default: auto-close clears holder', o.holder === null);

  o = ownersOf(evs, 'UNKNOWN', { syncMode: false });
  ok('default: unknown lane → null holder, no owners', o.holder === null && o.owners.length === 0);
}

// ── SYNC mode (first-claimer holds by _order, per-owner release, superseded) ───
{
  const evs = [
    ev('LANE_CLAIMED', 'ses_a', 'L1'),
    ev('LANE_CLAIMED', 'ses_b', 'L1'),
    ev('LANE_CLAIMED', 'ses_c', 'L1'),
  ];
  let o = ownersOf(evs, 'L1', { syncMode: true });
  ok('sync: first-claimer is holder', o.mode === 'sync' && o.holder && o.holder.sessionId === 'ses_a');
  ok('sync: full owner set retained', o.owners.length === 3);
  ok('sync: owners ordered by _order', o.owners.map((x) => x.sessionId).join(',') === 'ses_a,ses_b,ses_c');

  // A re-claim by the SAME owner keeps its rank (first-claimer stable).
  o = ownersOf([...evs, ev('LANE_CLAIMED', 'ses_c', 'L1', { data: { focus: 'refresh' } })], 'L1', { syncMode: true });
  ok('sync: same-owner re-claim keeps rank', o.holder.sessionId === 'ses_a' && o.owners.length === 3);

  // Holder release → next _order promotes; superseded set shrinks by one.
  o = ownersOf([...evs, ev('LANE_RELEASED', 'ses_a', 'L1')], 'L1', { syncMode: true });
  ok('sync: holder release promotes next _order', o.holder.sessionId === 'ses_b' && o.owners.length === 2);

  // A superseded owner releasing must NOT evict the holder.
  o = ownersOf([...evs, ev('LANE_RELEASED', 'ses_c', 'L1')], 'L1', { syncMode: true });
  ok('sync: superseded release keeps holder', o.holder.sessionId === 'ses_a' && o.owners.length === 2);

  // Holder session-close promotes; superseded owners persist.
  o = ownersOf([...evs, ev('SESSION_CLOSED', 'ses_a', null)], 'L1', { syncMode: true });
  ok('sync: holder close promotes, superseded stays', o.holder.sessionId === 'ses_b' && o.owners.length === 2);

  // Agreement with the read-time reducer.
  const rc = reduceClaims(evs, { syncMode: true });
  ok('sync: reduceClaims holder agrees with ownersOf', rc.length === 1 && rc[0].sessionId === 'ses_a');
}

// ── foldOwnership shape sanity ────────────────────────────────────────────────
{
  const st = foldOwnership([ev('LANE_CLAIMED', 'ses_a', 'L1')], { syncMode: false });
  ok('foldOwnership default state has claims Map', st.claims instanceof Map && st.claims.get('L1'));
  const stS = foldOwnership([ev('LANE_CLAIMED', 'ses_a', 'L1')], { syncMode: true });
  ok('foldOwnership sync state has laneClaims Map', stS.laneClaims instanceof Map && stS.laneClaims.get('L1'));
}

console.log(`ownersOf: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
