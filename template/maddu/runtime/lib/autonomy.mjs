// autonomy.mjs (market roadmap #11, phase 2) — the earned-autonomy scorer.
//
// A deterministic, per-lane trust score over the verified record: Wilson
// lower bound (z=1.96) over witnessed-clean vs witnessed-dirty slice
// outcomes, mapped to a 3-rung ladder. RECOMMEND-ONLY by contract — nothing
// in this module (or its consumers) may write governance config; applying a
// recommendation is the operator running the existing `governance` verbs.
// Design contract: docs/research/earned-autonomy-proposal.md (DESIGN FINAL,
// Codex-consulted 2026-07-03).
//
// Pure over plain data, the outcome.mjs / reflect.mjs posture: no I/O, no
// clock (`nowMs` injected; when omitted, recency criteria are not applied),
// no writes. Same events + same thresholds + same nowMs ⇒ identical output.
//
// Attribution (the load-bearing part — verified against the real spine):
//   * SLICE_STOP.lane is null in practice; the slice's lane is resolved by a
//     SESSION JOIN — the lane its session (SLICE_STOP.actor) most recently
//     registered (SESSION_REGISTERED / SESSION_AUTO_REGISTERED) or claimed
//     (LANE_CLAIMED) as of that point in the spine. An explicit event lane
//     still wins when present.
//   * GATE_RAN historically carries actor:null/lane:null, so gates attach to
//     a slice TEMPORALLY: runs since the previous SLICE_STOP (the reflect.mjs
//     window). Forward-enriched events bind tighter: a gate with an `actor`
//     must match the slice's session; a gate with `data.sliceId` binds to
//     exactly that slice and nothing else.
//
// Outcome trichotomy (plus the neutral refinement from the Codex consult):
//   witnessed-dirty  — deliverables.missing.length > 0, OR an isHardCatch in
//                      the slice's gate window, OR a hedged completion claim
//                      without observed proof (reflect.mjs semantics).
//   witnessed-clean  — not dirty, AND proof on either axis: declared
//                      deliverables all verified (declared>0, missing==0) OR
//                      ≥1 ok-status gate in the window.
//   neutral          — witnessed (some gate ran, e.g. warn-status) but
//                      neither proof nor fault. Counts toward coverage,
//                      excluded from n.
//   unwitnessed      — no deliverables declared, no gates in the window.
//                      Excluded from n; drags coverage down.
// Legacy SLICE_STOPs (pre-v1.17.0, no deliverables field) classify purely by
// their gate window. Meta/report events are never inputs, so scoring cannot
// feed on itself.
//
// Gaming resistance: clean credit is capped per (lane × UTC day) — farming
// trivial verified deliverables buys at most the cap, while every dirty
// outcome always lands in full. `clean` in the output is the RAW count (so
// volume stays legible); `cleanCapped` is what n and the Wilson score use.

import { createHash } from 'node:crypto';
import { isHardCatch } from './outcome.mjs';
import { hedgesCompletion } from './reflect.mjs';

export const RUNGS = ['observe', 'established', 'relaxation-candidate'];

export const DEFAULT_THRESHOLDS = Object.freeze({
  z: 1.96,               // Wilson confidence parameter
  minN: 5,               // below this the record is too thin to grade
  minCoverage: 0.5,      // witnessed / total slices required to grade at all
  establishedWilson: 0.60,
  candidateWilson: 0.85, // all-clean first crosses this at n = 22 (documented; intentional)
  candidateMinN: 20,
  candidateCleanDays: 14, // no witnessed-dirty in this trailing window
  dailyCleanCap: 5,      // max clean credits per lane per UTC day
});

// Wilson score lower bound for a Bernoulli proportion. The small-sample-honest
// statistic: 3/3 clean scores well below 30/30 clean.
export function wilsonLower(successes, n, z = DEFAULT_THRESHOLDS.z) {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = (centre - spread) / denom;
  return lower < 0 ? 0 : lower;
}

// Stable hash of the effective thresholds, recorded on emitted events so a
// score is always interpretable against the config that produced it.
export function thresholdsHash(thresholds) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const stable = JSON.stringify(Object.fromEntries(Object.entries(t).sort(([a], [b]) => (a < b ? -1 : 1))));
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function utcDay(ts) {
  return String(ts || '').slice(0, 10) || '(no-date)';
}

function tsMs(ev) {
  const t = ev && ev.ts ? Date.parse(ev.ts) : NaN;
  return Number.isFinite(t) ? t : null;
}

// status wins; fall back to ok for pre-status events (reflect.mjs semantics).
function gateStatus(data) {
  if (!data) return null;
  if (data.status != null) return data.status;
  if (data.ok === true) return 'ok';
  if (data.ok === false) return 'fail';
  return null;
}

// Classify every SLICE_STOP into an outcome record. Single ordered walk:
// maintains the session→lane join and the between-slice-stops gate window as
// it goes. Exported for the CLI's per-slice explain view.
export function classifyOutcomes(events) {
  const list = Array.isArray(events) ? events : [];
  const sessionLane = new Map(); // sessionId -> lane (latest wins, spine order)
  const outcomes = [];
  let windowGates = []; // GATE_RAN.data (+actor) since the previous SLICE_STOP

  for (const ev of list) {
    if (!ev || !ev.type) continue;

    if (ev.type === 'SESSION_REGISTERED' || ev.type === 'SESSION_AUTO_REGISTERED') {
      const sid = ev.actor || (ev.data && ev.data.sessionId) || null;
      if (sid && ev.lane) sessionLane.set(sid, ev.lane);
      continue;
    }
    if (ev.type === 'LANE_CLAIMED') {
      if (ev.actor && ev.lane) sessionLane.set(ev.actor, ev.lane);
      continue;
    }
    if (ev.type === 'GATE_RAN') {
      windowGates.push({ ...(ev.data || {}), actor: ev.actor || null });
      continue;
    }
    if (ev.type !== 'SLICE_STOP') continue;

    const sid = ev.actor || null;
    const lane = ev.lane || (sid && sessionLane.get(sid)) || '(unattributed)';
    const d = ev.data || {};
    const del = d.deliverables && typeof d.deliverables === 'object' ? d.deliverables : null;
    const declared = del && Number.isFinite(del.declared) ? del.declared : 0;
    const missing = del && Array.isArray(del.missing) ? del.missing.length : 0;
    const verified = del && Number.isFinite(del.verified) ? del.verified : 0;

    // Bind the window: sliceId-stamped gates bind exactly; actor-stamped gates
    // must match this slice's session; legacy unstamped gates attach by window.
    const gates = windowGates.filter((g) => {
      if (g.sliceId != null) return g.sliceId === ev.id;
      if (g.actor != null && sid != null) return g.actor === sid;
      return true;
    });
    const okGate = gates.some((g) => gateStatus(g) === 'ok');
    const hardCatch = gates.some((g) => isHardCatch(g));
    const witnessedByGates = gates.length > 0;

    const proof = verified > 0 || okGate;
    const hedgedNoProof = hedgesCompletion(d.summary) && !proof;

    let outcome;
    if (missing > 0 || hardCatch || hedgedNoProof) outcome = 'dirty';
    else if ((declared > 0 && missing === 0) || okGate) outcome = 'clean';
    else if (witnessedByGates || declared > 0) outcome = 'neutral';
    else outcome = 'unwitnessed';

    outcomes.push({
      sliceId: ev.id || null,
      ts: ev.ts || null,
      tsMs: tsMs(ev),
      lane,
      sessionId: sid,
      outcome,
      declared,
      verified,
      missing,
      gates: gates.length,
      hardCatch,
      hedgedNoProof,
    });
    windowGates = [];
  }
  return outcomes;
}

// Reduce classified outcomes into per-lane digests + rungs. The fleet.mjs
// idiom: pure per-unit digest, deterministic ordering, --json-ready.
export function scoreAutonomy(events, opts = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null;
  const outcomes = classifyOutcomes(events);

  const byLane = new Map();
  for (const o of outcomes) {
    let slot = byLane.get(o.lane);
    if (!slot) {
      slot = { lane: o.lane, clean: 0, cleanCapped: 0, dirty: 0, neutral: 0, unwitnessed: 0, total: 0, lastDirtyMs: null, capDays: new Map() };
      byLane.set(o.lane, slot);
    }
    slot.total++;
    if (o.outcome === 'clean') {
      slot.clean++;
      const day = utcDay(o.ts);
      const used = slot.capDays.get(day) || 0;
      if (used < thresholds.dailyCleanCap) { slot.cleanCapped++; slot.capDays.set(day, used + 1); }
    } else if (o.outcome === 'dirty') {
      slot.dirty++;
      if (o.tsMs != null && (slot.lastDirtyMs == null || o.tsMs > slot.lastDirtyMs)) slot.lastDirtyMs = o.tsMs;
    } else if (o.outcome === 'neutral') slot.neutral++;
    else slot.unwitnessed++;
  }

  const lanes = [...byLane.values()].sort((a, b) => (a.lane < b.lane ? -1 : 1)).map((s) => {
    const n = s.cleanCapped + s.dirty;
    const witnessed = s.clean + s.dirty + s.neutral;
    const coverage = s.total > 0 ? witnessed / s.total : 0;
    const wilson = wilsonLower(s.cleanCapped, n, thresholds.z);
    // Recency: with no injected clock, the criterion is not applied (pure-core
    // posture, same as reflect.mjs recentDays).
    const recentDirty = nowMs != null && s.lastDirtyMs != null
      && (nowMs - s.lastDirtyMs) <= thresholds.candidateCleanDays * 86400000;

    let rung = 'observe';
    if (n >= thresholds.minN && coverage >= thresholds.minCoverage) {
      if (wilson >= thresholds.candidateWilson && n >= thresholds.candidateMinN && !recentDirty) rung = 'relaxation-candidate';
      else if (wilson >= thresholds.establishedWilson) rung = 'established';
    }
    return {
      lane: s.lane,
      clean: s.clean,
      cleanCapped: s.cleanCapped,
      dirty: s.dirty,
      neutral: s.neutral,
      unwitnessed: s.unwitnessed,
      total: s.total,
      n,
      coverage: Math.round(coverage * 1000) / 1000,
      wilson: Math.round(wilson * 10000) / 10000,
      rung,
    };
  });

  return {
    schemaVersion: 1,
    asOf: nowMs != null ? new Date(nowMs).toISOString() : null,
    attribution: 'session-join+window',
    configHash: thresholdsHash(opts.thresholds),
    totalSlices: outcomes.length,
    lanes,
  };
}
