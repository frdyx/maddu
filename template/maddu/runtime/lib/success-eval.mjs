// Success-condition evaluation — the goal's measurable ✓/○/? state (v1.97.0).
//
// Extracted verbatim from commands/orient.mjs so BOTH the CLI briefing and the
// bridge builders share one evaluator. The split matters for a hard safety
// invariant: running an operator-declared verify command spawns a subprocess,
// and the bridge must NEVER spawn on an HTTP GET (server.js). So:
//
//   - the CLI path (orient, orient --digest) calls evalSuccess with
//     runVerify=true, which spawns, then writes the result to a state cache;
//   - bridge builders call readSuccessCache (no spawn, no shell) to render the
//     same ✓/○/? the operator last saw on the CLI.
//
// The cache is a rebuildable state file (.maddu/state/success-eval.json), never
// a spine event — it holds no authority, only the last evaluated snapshot.

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { pathsFor } from './paths.mjs';

export const VERIFY_TIMEOUT_MS = 120000;
const SCHEMA_VERSION = 1;

// Evaluate ONE success condition. runVerify is a caller-supplied boolean so a
// bridge caller can pass false (→ state:'skipped', no spawn). Moved verbatim
// from orient.mjs — keep the exact state semantics (met/pending/unverifiable/
// skipped) so the CLI render and the cache never disagree.
export function evalCondition(cond, repoRoot, runVerify) {
  if (!cond.verify) return { ...cond, state: 'unverifiable' };
  if (!runVerify) return { ...cond, state: 'skipped' };
  try {
    const r = spawnSync(cond.verify, { shell: true, cwd: repoRoot, timeout: VERIFY_TIMEOUT_MS, stdio: 'ignore' });
    if (r.error || r.status == null) return { ...cond, state: 'pending', note: r.error ? r.error.message : 'no exit code' };
    return { ...cond, state: r.status === 0 ? 'met' : 'pending', exitCode: r.status };
  } catch (e) {
    return { ...cond, state: 'pending', note: e.message };
  }
}

// Evaluate a goal's full success set → the same derivation orient computes.
// runVerify=false returns every condition as 'skipped' without spawning.
export function evalSuccess(goal, repoRoot, runVerify) {
  const success = Array.isArray(goal?.success) ? goal.success : [];
  const evaluated = success.map((c) => evalCondition(c, repoRoot, runVerify));
  const metCount = evaluated.filter((c) => c.state === 'met').length;
  const verifiable = evaluated.filter((c) => c.verify).length;
  const pendingCount = evaluated.filter((c) => c.state === 'pending').length;
  const allMet = verifiable > 0 && pendingCount === 0;
  return { evaluated, metCount, verifiable, pendingCount, allMet };
}

function cachePath(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'success-eval.json');
}

// Persist the last CLI evaluation so the bridge can render real ✓/○/? without
// spawning. `ts` is stamped by the caller (deterministic-friendly). The goal's
// objective + setAt travel with the snapshot so a consumer can tell whether the
// cache still corresponds to the CURRENT goal (a stale cache for a since-changed
// goal is worse than none). Atomic write (temp + rename).
export async function writeSuccessCache(repoRoot, { goal, result, ts }) {
  const dir = pathsFor(repoRoot).statePrjDir;
  await mkdir(dir, { recursive: true });
  const dst = cachePath(repoRoot);
  const tmp = dst + '.tmp';
  const record = {
    _v: SCHEMA_VERSION,
    ts: ts || null,
    objective: goal?.objective || null,
    setAt: goal?.setAt || null,
    metCount: result.metCount,
    verifiable: result.verifiable,
    pendingCount: result.pendingCount,
    allMet: result.allMet,
    // Store only the fields a readout needs — text + state (+ the command so a
    // reader can show what was checked). Drop note/exitCode: transient and can
    // carry subprocess error strings we don't need in a cache.
    conditions: (result.evaluated || []).map((c) => ({
      text: c.text || null, verify: c.verify || null, state: c.state,
    })),
  };
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
  await rename(tmp, dst);
  return record;
}

// Read the last evaluated snapshot, or null if none (no spawn, no shell). The
// bridge's success ✓/○/? comes from here. Callers should treat a null/absent
// cache as "not evaluated yet", not "all pending".
export async function readSuccessCache(repoRoot) {
  try {
    let raw = await readFile(cachePath(repoRoot), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

export function successCachePath(repoRoot) {
  return cachePath(repoRoot);
}

// ─────────────────────────────────────────────────────────────────────────────
// audit P3 — verification, not actor-witness.
//
// The `.maddu/state/success-eval.json` cache is hand-writable, so a readout that
// renders `allMet` straight from it lets anyone forge "goal met". The authority
// is now the tamper-detecting spine: `orient` appends a VERIFICATION_RAN receipt
// from the in-process eval result, and readouts derive "met" from the LATEST
// success-eval receipt — time-bounded (TTL + future-skew), goal-corroborated
// (objective/setAt must match the current spine goal), and integrity-gated.
// ─────────────────────────────────────────────────────────────────────────────

export const SUCCESS_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000; // orient re-evals each fresh session
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// Shared staleness classifier — returns null (fresh) or a reason string. Rejects
// missing/invalid ts, a MATERIALLY-FUTURE ts (beyond a small clock skew), and a
// ts older than the TTL. Used by the success assessor AND the recency gates [R5].
export function isStaleTs(ts, nowMs, { ttlMs, skewMs = FUTURE_SKEW_MS } = {}) {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return 'no-ts';
  if (nowMs != null && (t - nowMs) > skewMs) return 'future-ts';
  if (nowMs != null && ttlMs != null && (nowMs - t) > ttlMs) return 'expired';
  return null;
}

// Latest success-eval VERIFICATION_RAN receipt from an event list (or null).
export function latestSuccessReceipt(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.type === 'VERIFICATION_RAN' && e.data && e.data.kind === 'success-eval') return e;
  }
  return null;
}

// Latest spine-integrity gate verdict (GATE_RAN) from an event list (or null).
export function latestIntegrityVerdict(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.type === 'GATE_RAN' && e.data && e.data.gateId === 'spine-integrity') return e;
  }
  return null;
}

// GET-side integrity resolution (T1/T2) — the bridge never spawns and never
// re-hashes. Three states from what's cheaply observable on a read:
//   'unknown' — a strict-parse error (a malformed line after the last verdict),
//               no verdict, OR the verdict PREDATES the receipt (didn't cover it).
//   'broken'  — the last spine-integrity verdict FAILED.
//   'ok'      — a passing verdict that is at-or-after the receipt.
// The GET is deliberately NON-authoritative: it reports honest timestamps; the
// recency/success GATES (gate context) do the live verified read.
export function resolveGetIntegrity({ parseErrors, integrityVerdict, receiptTs } = {}) {
  if (parseErrors == null || parseErrors > 0) return 'unknown';
  if (!integrityVerdict) return 'unknown';
  const vd = integrityVerdict.data || {};
  // Only an explicit FAIL is 'broken'. A 'warn' verdict (e.g. a pre-cutover
  // legacy fork) is NOT broken — it must not stale a fresh success receipt.
  const failed = vd.status != null ? vd.status === 'fail' : vd.ok === false;
  if (failed) return 'broken';
  // A capped integrity scan didn't cover the whole chain → can't assert 'ok'.
  if (vd.capped === true || (vd.evidence && vd.evidence.capped === true)) return 'unknown';
  const vt = Date.parse(integrityVerdict.ts || '');
  const rt = Date.parse(receiptTs || '');
  if (!Number.isFinite(vt)) return 'unknown';
  if (Number.isFinite(rt) && vt < rt) return 'unknown'; // verdict predates the receipt
  return 'ok';
}

// Pure staleness assessment of a success receipt against the current goal.
export function assessSuccess(receipt, { goal, nowMs, ttlMs = SUCCESS_RECEIPT_TTL_MS, integrity = 'ok' } = {}) {
  const reasons = [];
  if (!receipt) reasons.push('absent');
  const d = (receipt && receipt.data) || {};
  const tsReason = receipt ? isStaleTs(receipt.ts, nowMs, { ttlMs }) : null;
  if (tsReason) reasons.push(tsReason);
  const goalMatch = !!(receipt && goal &&
    (d.objective ?? null) === (goal.objective ?? null) &&
    (d.setAt ?? null) === (goal.setAt ?? null));
  // A receipt with no CURRENT goal (the goal was cleared) is stale — an old
  // "met" must not render against a goal that no longer exists.
  if (receipt && !goal) reasons.push('goal-changed');
  else if (receipt && goal && !goalMatch) reasons.push('goal-changed');
  // integrity 'broken' (the chain FAILED a live verify, or the last verdict
  // failed) forces STALE — the record can't be trusted. integrity 'unknown' (no
  // integrity verdict has run SINCE this receipt) does NOT force stale: the count
  // still renders but is LABELLED unverified (Codex: "unknown → label unverified,
  // never render as verified"). A forged receipt breaks the hash chain, so the
  // next spine-integrity verdict flips it to 'broken' → stale.
  if (integrity === 'broken') reasons.push('integrity-broken');
  const ageMs = receipt && nowMs != null && Number.isFinite(Date.parse(receipt.ts || ''))
    ? nowMs - Date.parse(receipt.ts) : null;
  return {
    present: !!receipt, stale: reasons.length > 0, staleReasons: reasons,
    goalMatch, integrity, unverified: integrity !== 'ok', ageMs,
  };
}

// The render object every readout uses. When STALE, `allMet` is forced null and
// the counts move under `lastKnown` so no consumer can infer completion via
// `metCount === total` [F2]. When fresh + goal-matched + integrity ok, it renders
// the receipt's ✓/○/? as authoritative.
export function resolveSuccessView(events, { goal, nowMs, ttlMs = SUCCESS_RECEIPT_TTL_MS, integrity = 'ok' } = {}) {
  const receipt = latestSuccessReceipt(events);
  const a = assessSuccess(receipt, { goal, nowMs, ttlMs, integrity });
  const d = (receipt && receipt.data) || {};
  const conditions = Array.isArray(d.conditions) ? d.conditions : [];
  const total = conditions.length || (Array.isArray(goal?.success) ? goal.success.length : null);
  const base = {
    objective: (goal && goal.objective) ?? d.objective ?? null,
    evaluatedAt: receipt ? receipt.ts : null,
    stale: a.stale,
    staleReasons: a.staleReasons,
    integrity,
    // true when integrity !== 'ok' (unknown OR broken) — the count, if shown, is
    // not confirmed by an integrity verdict at/after the receipt.
    unverified: a.unverified,
    total,
  };
  if (a.stale) {
    return {
      ...base,
      allMet: null, metCount: null, verifiable: null,
      lastKnown: receipt ? {
        allMet: d.allMet ?? null, metCount: d.metCount ?? null,
        verifiable: d.verifiable ?? null, conditions,
      } : null,
    };
  }
  return {
    ...base,
    allMet: d.allMet ?? null,
    metCount: d.metCount ?? null,
    verifiable: d.verifiable ?? null,
    conditions,
    lastKnown: null,
  };
}

// Append the VERIFICATION_STARTED → VERIFICATION_RAN receipt pair for an
// in-process success-eval (called by orient after evalSuccess with runVerify).
// Best-effort: a spine-append failure never breaks orient (the readout just
// falls back to "unverified"/stale). Returns the started id or null.
export async function recordSuccessEval(repoRoot, spineLib, { goal, result, actor = null, lane = null }) {
  const spine = spineLib && spineLib.spine ? spineLib.spine : spineLib;
  if (!spine || !spine.append) return null;
  const T = spine.EVENT_TYPES || {};
  try {
    const started = await spine.append(repoRoot, {
      type: T.VERIFICATION_STARTED || 'VERIFICATION_STARTED', actor, lane,
      data: { kind: 'success-eval', profile: null },
    });
    await spine.append(repoRoot, {
      type: T.VERIFICATION_RAN || 'VERIFICATION_RAN', actor, lane,
      data: {
        kind: 'success-eval', startedId: (started && started.id) || null, profile: null,
        complete: true, result: 'pass',
        allMet: result.allMet, metCount: result.metCount,
        verifiable: result.verifiable, pendingCount: result.pendingCount,
        objective: (goal && goal.objective) ?? null, setAt: (goal && goal.setAt) ?? null,
        conditions: (result.evaluated || []).map((c) => ({ text: c.text || null, state: c.state })),
      },
    });
    return (started && started.id) || null;
  } catch { return null; }
}
