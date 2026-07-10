// audit P3 — verification, not actor-witness (test-recency half).
//
// The recency gates (project-test-recent, self-test-recent, heavy-suites-recent)
// used to read a hand-writable `.maddu/state/*-last-run.json`, so writing
// `{counts:{fail:0},ts:now}` turned them green having verified nothing. They now
// read tamper-detecting spine RECEIPTS: a runner appends a VERIFICATION_STARTED
// before it runs and a VERIFICATION_RAN (from its in-process result) after,
// referencing the STARTED by id. This module owns:
//   - recordVerification: the emit pair (STARTED → run → RAN), used by every runner.
//   - pairVerifications: the U2 pairing invariants (exactly-one, kind+profile
//     matched, ordered, fail-closed) over the FULL verified read.
//   - recencyFromSpine: the U1 recency verdict (dangling window = full TTL, not a
//     count; future/invalid ts non-green; partial run doesn't qualify).
// The gates call readVerifiedEvents (verify.mjs) so integrity !== 'ok' → non-green.

import { isStaleTs } from './success-eval.mjs';

// Emit the STARTED → RAN pair around an in-process run. `run()` returns the
// runner's result object; the caller's `derive` maps it to the receipt payload
// { complete, result:'pass'|'fail', counts }. Best-effort spine appends: a
// verification still RUNS if the spine is unavailable (the gate just reads it as
// "no receipt" → non-green, never a false pass). Returns { startedId, result }.
export async function recordVerification(repoRoot, spineLib, { kind, profile = null, run, derive }) {
  const spine = spineLib && spineLib.spine ? spineLib.spine : spineLib;
  const T = (spine && spine.EVENT_TYPES) || {};
  const canAppend = !!(spine && spine.append);
  let startedId = null;
  if (canAppend) {
    try {
      const started = await spine.append(repoRoot, {
        type: T.VERIFICATION_STARTED || 'VERIFICATION_STARTED',
        actor: (spineLib && spineLib.actor) || null,
        lane: (spineLib && spineLib.lane) || null,
        data: { kind, profile },
      });
      startedId = (started && started.id) || null;
    } catch { startedId = null; }
  }
  // Run regardless of whether the STARTED append succeeded.
  const result = await run();
  if (canAppend && startedId) {
    try {
      const payload = derive ? derive(result) : {};
      await spine.append(repoRoot, {
        type: T.VERIFICATION_RAN || 'VERIFICATION_RAN',
        actor: (spineLib && spineLib.actor) || null,
        lane: (spineLib && spineLib.lane) || null,
        data: { kind, startedId, profile, complete: true, result: 'pass', counts: null, ...payload },
      });
    } catch { /* a dangling STARTED remains → the gate reads it as non-green */ }
  }
  return { startedId, result };
}

// U2 pairing over the full event list for one kind. A RAN is VALID iff exactly
// one preceding STARTED (same kind, same profile) carries its startedId and that
// STARTED is referenced by exactly one RAN. Orphan / mismatched / duplicate-
// referenced / non-preceding → invalid (dropped). Returns valid RANs + the
// STARTEDs left dangling (referenced by no valid RAN).
export function pairVerifications(events, kind) {
  const list = Array.isArray(events) ? events : [];
  const startedById = new Map();       // id -> { ev, index }
  const dupStarted = new Set();        // ids that appear on >1 STARTED (corrupt → fail-close)
  const rans = [];                     // { ev, index }
  list.forEach((e, index) => {
    if (!e || !e.data || e.data.kind !== kind) return;
    if (e.type === 'VERIFICATION_STARTED') {
      if (startedById.has(e.id)) dupStarted.add(e.id);
      else startedById.set(e.id, { ev: e, index });
    } else if (e.type === 'VERIFICATION_RAN') rans.push({ ev: e, index });
  });
  // Reference counts span ALL RANs (any kind): a startedId reused across kinds is
  // still a reuse and must fail-close, so count globally, not per-kind.
  const refCount = new Map();          // startedId -> number of RANs referencing it (any kind)
  for (const e of list) {
    if (e && e.type === 'VERIFICATION_RAN' && e.data && e.data.startedId) {
      refCount.set(e.data.startedId, (refCount.get(e.data.startedId) || 0) + 1);
    }
  }
  const valid = [];
  for (const { ev, index } of rans) {
    const sid = ev.data.startedId;
    if (dupStarted.has(sid)) continue;                 // a reused STARTED id is corrupt → fail-close
    const s = sid ? startedById.get(sid) : null;
    if (!s) continue;                                  // orphan RAN (no STARTED of this kind)
    if (refCount.get(sid) !== 1) continue;             // duplicate-referenced / reused id
    if (s.index >= index) continue;                    // STARTED must precede its RAN
    if ((s.ev.data.profile ?? null) !== (ev.data.profile ?? null)) continue; // profile mismatch
    valid.push(ev);
  }
  const referenced = new Set(valid.map((r) => r.data.startedId));
  const dangling = [...startedById.values()].map((s) => s.ev).filter((s) => !referenced.has(s.id));
  return { valid, dangling };
}

// U1 recency verdict from the spine. ttlMs bounds BOTH the recency window and the
// dangling-detection window (never a fixed event count). profileOk(profile) gates
// which profiles qualify (e.g. quick|full for project/self test). Returns:
//   { latest, danglingInWindow, hasReceipt, staleReasonForLatest }
export function recencyFromSpine(events, { kind, ttlMs, nowMs, profileOk = () => true }) {
  const { valid, dangling } = pairVerifications(events, kind);
  const withinWindow = (ev) => isStaleTs((ev && ev.ts) || null, nowMs, { ttlMs }) === null; // fresh (not future, not expired, valid ts)
  // A dangling STARTED = a run began without a recorded result (crash / append-
  // failure). It is relevant unless it is clearly EXPIRED — a fresh, a
  // future-dated, or an invalid/absent-ts dangling attempt all count as non-green
  // (a future or unparseable ts is itself suspect and must not be ignored).
  const relevantDangling = (s) => {
    const r = isStaleTs((s && s.ts) || null, nowMs, { ttlMs });
    return r === null || r === 'future-ts' || r === 'no-ts';
  };
  const danglingInWindow = dangling.filter(relevantDangling);
  // The NEWEST valid receipt (by ts — events are pre-sorted) is authoritative,
  // selected BEFORE any freshness filter so a future-dated newest run can't be
  // skipped over to let an older pass win. It goes green ONLY when it is itself
  // in-window (not future/expired) AND complete + pass + profile-ok [F9].
  const newest = valid.length ? valid[valid.length - 1] : null;
  const newestInWindow = !!(newest && withinWindow(newest));
  const qualifies = (r) => r && r.data.complete === true && r.data.result === 'pass' && profileOk(r.data.profile ?? null);
  const latest = (newestInWindow && qualifies(newest)) ? newest : null;
  return { latest, latestAnyValid: newest, newestInWindow, danglingInWindow, hasReceipt: valid.length > 0 };
}

// The shared recency-gate verdict from an already-verified event list. Integrity
// gates the whole thing (F7): a non-'ok' verified read is never green. Then U1
// dangling → non-green; a usable receipt → green; a valid-but-unusable receipt →
// non-green with WHY; nothing → non-green (a legacy last-run.json is never trusted
// for recency, F8).
export function recencyGateVerdict(events, integrity, { kind, ttlMs, nowMs, profileOk = () => true, label, ttlLabel, legacyPresent = false }) {
  if (integrity !== 'ok') {
    return { ok: false, message: `${label}: spine integrity ${integrity} — cannot trust recency from an unverified chain` };
  }
  const rec = recencyFromSpine(events, { kind, ttlMs, nowMs, profileOk });
  if (rec.danglingInWindow.length) {
    return { ok: false, message: `${label}: a run started without a recorded result (${rec.danglingInWindow.length} dangling attempt(s) within ${ttlLabel})` };
  }
  if (rec.latest) {
    const ageH = Math.floor((nowMs - Date.parse(rec.latest.ts)) / 3600000);
    const c = rec.latest.data.counts || {};
    return { ok: true, message: `${label}: last ${rec.latest.data.profile || 'suite'} run ${ageH}h ago (verified spine receipt) — ${c.pass || 0} pass · ${c.fail || 0} fail` };
  }
  if (rec.latestAnyValid) {
    const d = rec.latestAnyValid.data;
    let why;
    if (!rec.newestInWindow) why = 'newest receipt has a future or out-of-window timestamp — not trusted for recency';
    else if (d.result !== 'pass') why = `last run FAILED (${(d.counts && d.counts.fail) || '?'} failure(s))`;
    else if (d.complete !== true) why = 'last run was partial (--only/--skip/--changed/--scenario) — not a full profile';
    else why = `last run profile "${d.profile || '?'}" does not qualify (need quick/full)`;
    return { ok: false, message: `${label}: ${why}` };
  }
  return {
    ok: false,
    message: `${label}: no verified spine receipt yet${legacyPresent ? ' (a legacy last-run.json is present but is not trusted for recency)' : ''} — run the suite`,
  };
}
