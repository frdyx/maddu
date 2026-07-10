// Shared helpers for runtime wrapper subprocesses.
//
// Wrappers spawn a provider CLI (claude, codex, gemini, ...) and tee its
// stdout while sniffing token-usage frames out of the stream. They run
// **inside** the worker subprocess, never imported by framework code —
// this preserves hard rule #5 (no provider SDKs in framework code) by
// construction: parsing lives where the API call already happens.
//
// Wrappers append events directly to .maddu/events/<segment>.ndjson with
// the same shape `lib/spine.mjs#append` produces. We don't import spine.mjs
// here because (a) wrappers should be standalone (b) the spine module pulls
// in defaults/catalog logic the wrapper doesn't need.
//
// #12c: in team-sync mode this event must land in the replica's partition on a
// valid chain (not the flat default segment), so the sync path routes through
// spine-append-core.mjs — which is stdlib-only (no catalog/defaults), preserving
// the standalone contract above. The DEFAULT (single-machine) path is unchanged.
//
// Failure mode: silent + non-blocking. If parsing throws, append fails, or
// the provider emits unexpected JSON, the wrapper logs to
// `.maddu/state/worker-logs/<workerId>.wrapper-errors.log` and keeps
// forwarding stdout untouched. The worker never blocks on bookkeeping.

import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveWriteReplica, appendPartitioned, appendFlatChained } from '../spine-append-core.mjs';
import { redactDataPayload, redactText } from '../secret-scan.mjs';

function genId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `evt_${t}_${r}`;
}

// Append a TOKEN_USAGE_REPORTED event directly to the spine NDJSON.
//
// repoRoot: the .maddu/ parent dir.
// payload : { runtime, sessionId, model, inputTokens?, outputTokens?,
//             cacheRead?, cacheCreation?, unreportedTokens? }
export async function appendTokenUsage(repoRoot, payload) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const ts = new Date().toISOString();
  const ev = {
    v: 1,
    id: genId(),
    ts,
    type: 'TOKEN_USAGE_REPORTED',
    actor: payload.sessionId || null,
    lane: payload.lane || null,
    data: {
      runtime: payload.runtime || null,
      sessionId: payload.sessionId || null,
      model: payload.model || null,
    },
  };
  if (typeof payload.inputTokens === 'number') ev.data.inputTokens = payload.inputTokens;
  if (typeof payload.outputTokens === 'number') ev.data.outputTokens = payload.outputTokens;
  if (typeof payload.cacheRead === 'number') ev.data.cacheRead = payload.cacheRead;
  if (typeof payload.cacheCreation === 'number') ev.data.cacheCreation = payload.cacheCreation;
  if (payload.unreportedTokens === true) ev.data.unreportedTokens = true;

  // This append bypasses spine.append(), so it applies the same write-boundary
  // sweep itself. The fields are numbers by construction EXCEPT `model`, which
  // is parsed from the provider stream — a malformed frame must not carry a
  // secret-shaped string onto the spine. Clean data (the normal case, always)
  // passes through by reference. secret-scan.mjs is stdlib-only pure regex, so
  // the wrapper's standalone contract holds.
  ev.data = redactDataPayload(ev.data);

  // #12c sync mode: land in the replica's partition on a valid chain (shared,
  // stdlib-only core). Token accounting is best-effort and MUST NOT block the
  // worker's exit: the funnel wait is bounded (maxWaitMs), and if a `spine sync
  // init` migration is pending we DROP this one event rather than block or write
  // into an incomplete partition (nothing written → no chain fork). The caller wraps
  // this in try/catch + logWrapperError. Default mode keeps the flat write below.
  //
  // MADDU_WRAPPER_APPEND_WAIT_MS (RAISE-ONLY): on saturated CI runners the 3s
  // funnel wait can expire under normal (slow) operation, so the designed
  // drop-on-timeout degradation fires and the ledger legitimately misses rows —
  // a hardware-dependent false alarm in exact-total tests. The env can only
  // RAISE the bound (a longer best-effort wait is strictly safer accounting;
  // shortening it would widen the drop window), so values at or below the
  // default (and garbage) are ignored.
  const defaultWaitMs = 3000;
  const rawWait = Number(process.env.MADDU_WRAPPER_APPEND_WAIT_MS);
  const waitMs = Number.isFinite(rawWait) && rawWait > defaultWaitMs ? rawWait : defaultWaitMs;
  const w = await resolveWriteReplica(repoRoot, { timeoutMs: waitMs });
  if (w.pending) return null; // migration in flight — drop this token event
  if (w.id) return appendPartitioned(repoRoot, w.id, ev, { maxWaitMs: waitMs });

  // Default flat path — through the SHARED locked+chained primitive (audit P1) so
  // token events carry prev_hash like every other flat write (no keyless flat
  // writer remains → the verifier's chain-strip detection stays free of false
  // positives). Best-effort: `maxWaitMs` bounds lock-contention polling; if the
  // funnel is contended past the budget the acquire throws and we DROP (return
  // null, write nothing) rather than block the worker's exit. A migration that
  // committed while we waited surfaces as {reroute|pending}.
  try {
    const outcome = await appendFlatChained(repoRoot, eventsDir, ev, { maxWaitMs: waitMs });
    if (outcome.reroute) return appendPartitioned(repoRoot, outcome.reroute, ev, { maxWaitMs: waitMs });
    if (outcome.pending) return null;
    return outcome.ev;
  } catch {
    return null; // contention past budget / transient — drop, never block the worker
  }
}

// Wrapper-local error log. Failures here are tolerated — we never let a
// bookkeeping failure block the worker's actual output.
export async function logWrapperError(repoRoot, workerId, msg) {
  try {
    const logDir = join(repoRoot, '.maddu', 'state', 'worker-logs');
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `${workerId || 'unknown'}.wrapper-errors.log`);
    // Today every call site passes err.message templates only — but a future
    // site that interpolates a provider-stream line must not persist a raw
    // secret. No-op on clean text.
    await appendFile(logPath, `[${new Date().toISOString()}] ${redactText(String(msg)).text}\n`);
  } catch {
    // Last-ditch: drop on the floor. We don't have a better escape.
  }
}

// Line-buffered split helper. Stream tools usually flush per-line; we
// still buffer to be safe.
export function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { onLine(line); } catch {}
    }
  };
}

// Resolve repo root from env (set by the framework before spawning).
export function repoRootFromEnv() {
  return process.env.MADDU_REPO_ROOT || process.cwd();
}

export function workerIdFromEnv() {
  return process.env.MADDU_WORKER_ID || null;
}

export function sessionIdFromEnv() {
  return process.env.MADDU_SESSION_ID || null;
}

export function modelHintFromEnv() {
  return process.env.MADDU_MODEL_HINT || null;
}
