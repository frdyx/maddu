// Invocation receipts (usage-audit roadmap Tier 2, v1.101.0).
//
// The 2026-07-16 fleet usage audit had NO execution data for CLI verbs — its
// "verb usage" numbers were transcript keyword MENTIONS (self-dev inflated,
// host-specific, blind to non-Claude callers). This corpus records what
// actually ran: every `maddu` CLI entry appends one receipt line at process
// exit.
//
// Corpus: `.maddu/state/invocation-receipts.ndjson` — a NEW dedicated file,
// deliberately NOT:
//   - the spine (no event-type explosion, no contract bump — receipts are
//     operational telemetry, not facts the record must witness);
//   - `.maddu/log/operations.ndjson` (that file is a regenerable spine
//     PROJECTION `maddu log` overwrites — receipts written there would be
//     destroyed on the next regeneration; Codex plan-review round 2).
//
// Containment contract (device-local operational telemetry):
//   - never chained (spine-sync touches only .maddu/events/);
//   - never synced/exported (`maddu export --otel` reads only the spine);
//   - untracked (.gitignore ignores .maddu/state/* — the
//     maddu-state-untracked gate enforces it);
//   - excluded from spine-integrity verification by construction (verify.mjs
//     reads only .maddu/events/);
//   - secret-scrubbed at the write boundary like every other state store
//     (verb/sub run through the canonical redactor — bin/ additionally
//     constrains sub to a token shape so free text never lands here).
//
// HONESTY CONTRACT — receipts are an OBSERVED-WINDOW signal, never an
// authoritative total. Fail-open writes (a logging error never blocks the
// verb), size-capped rotation, and pre-v1.101 installs writing nothing all
// make gaps STRUCTURAL. Every reader must therefore report the retention
// window (oldest→newest receipt ts) and the dropped/unparseable line count
// alongside any count, and no surface may present receipt counts as lifetime
// totals.
//
// Rotation: size-capped at ROTATE_BYTES per file with ONE rotated generation
// kept (`invocation-receipts.prev.ndjson`) → total disk is bounded at ~2×
// ROTATE_BYTES. Deliberately size-only: an age check on the hot write path
// would need a file read, and low-volume repos keeping a long window is a
// feature (more telemetry), not a staleness bug — the window report makes
// age visible. Declared via `maddu log --window`.
//
// Write path is SYNCHRONOUS on purpose: bin/maddu.mjs records from a
// `process.on('exit')` handler (the only seam that survives a command
// calling process.exit()), where only sync I/O runs. One appendFileSync of a
// ~200-byte line — measured well under the <10ms p50 budget.
//
// Pure lib — no console output, no process.exit. Node stdlib only (rule #4).

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { redactText } from './secret-scan.mjs';

export const RECEIPTS_FILE = 'invocation-receipts.ndjson';
export const RECEIPTS_PREV_FILE = 'invocation-receipts.prev.ndjson';
export const ROTATE_BYTES = 5 * 1024 * 1024; // 5MB per file, one prev generation kept

function receiptsPath(stateRoot) { return join(stateRoot, '.maddu', 'state', RECEIPTS_FILE); }
function prevPath(stateRoot) { return join(stateRoot, '.maddu', 'state', RECEIPTS_PREV_FILE); }

function isDirSync(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFileSync(p) { try { return statSync(p).isFile(); } catch { return false; } }

// Sync, FAIL-OPEN mirror of paths.resolveRoots (paths.mjs): nearest ancestor
// with .maddu/ or a .maddu-state-root pointer; MADDU_STATE_ROOT env > pointer
// file > local. Where resolveRoots THROWS on a misconfigured pointer (a spine
// write must never guess), this returns null — telemetry never blocks or
// noises a verb over a pointer problem; the receipt is simply not written.
export function resolveStateRootSync(startDir = process.cwd(), env = process.env) {
  try {
    let dir = resolve(startDir);
    let workRoot = null;
    let hasLocalState = false;
    while (true) {
      if (isDirSync(join(dir, '.maddu'))) { workRoot = dir; hasLocalState = true; break; }
      if (isFileSync(join(dir, '.maddu-state-root'))) { workRoot = dir; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!workRoot) return null;

    const envTarget = env && typeof env.MADDU_STATE_ROOT === 'string' && env.MADDU_STATE_ROOT.trim()
      ? env.MADDU_STATE_ROOT.trim() : null;
    if (envTarget) {
      const t = resolve(envTarget);
      return isDirSync(join(t, '.maddu')) ? t : null;
    }
    const pointer = join(workRoot, '.maddu-state-root');
    if (isFileSync(pointer)) {
      const raw = readFileSync(pointer, 'utf8').split(/\r?\n/)[0].trim();
      if (!raw) return null;
      const t = isAbsolute(raw) ? resolve(raw) : join(workRoot, raw);
      return isDirSync(join(t, '.maddu')) ? resolve(t) : null;
    }
    return hasLocalState ? workRoot : null;
  } catch { return null; }
}

// Append one receipt. Sync (exit-handler safe), FAIL-OPEN: returns true on
// write, false on any problem — never throws, never blocks the verb.
//
// sessionId precedence: explicit opts > MADDU_SESSION_ID env > the per-repo
// active-session cache (.maddu/state/session.active.json), read RAW — the
// liveness-verified read (_spine.mjs:resolveSessionId) replays the spine,
// which has no place on a hot exit path. A stale cache id mislabels
// telemetry attribution at worst; it authorizes nothing.
// `_testBeforeRename` is a GUARDED TEST-ONLY hook (no-op in production —
// nothing outside scripts/test/ passes it): it runs between the size check
// and the rotation rename, letting a test deterministically simulate the
// concurrent-rotation race (current file vanishing mid-rotation) that cannot
// be triggered from outside the seam (Codex diff-review round 2: the prior
// race test never actually entered the rotation branch).
export function recordInvocationSync({
  stateRoot, verb, sub = null, exitCode = 0, durationMs = 0,
  sessionId = null, env = process.env, rotateBytes = ROTATE_BYTES, now = null,
  _testBeforeRename = null,
} = {}) {
  try {
    if (!stateRoot || !verb) return false;
    const dir = join(stateRoot, '.maddu', 'state');
    mkdirSync(dir, { recursive: true });

    let sid = sessionId || (env && env.MADDU_SESSION_ID) || null;
    if (!sid) {
      try {
        const cache = JSON.parse(readFileSync(join(dir, 'session.active.json'), 'utf8'));
        if (cache && typeof cache.sessionId === 'string') sid = cache.sessionId;
      } catch {}
    }

    const receipt = {
      v: 1,
      ts: now || new Date().toISOString(),
      verb: redactText(String(verb)).text.slice(0, 64),
      sub: sub == null ? null : redactText(String(sub)).text.slice(0, 64),
      exit: Number.isInteger(exitCode) ? exitCode : 1,
      ms: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
      sessionId: sid,
      workspace: stateRoot,
    };

    const file = receiptsPath(stateRoot);
    const prev = prevPath(stateRoot);
    const line = JSON.stringify(receipt) + '\n';
    let size = 0;
    try { size = statSync(file).size; } catch {}
    if (size >= rotateBytes) {
      if (typeof _testBeforeRename === 'function') { try { _testBeforeRename(); } catch {} }
      // Rename FIRST (atomic replace on POSIX). Only if that fails — Windows
      // refuses an existing destination — drop the old generation and retry,
      // and only while the SOURCE still exists: if it's gone, another process
      // already rotated and deleting prev here would destroy the generation
      // it just created (Codex diff-review round 1). The residual TOCTOU
      // between the isFileSync check and the retry is accepted: telemetry,
      // worst case one generation lost.
      try { renameSync(file, prev); } catch {
        if (isFileSync(file)) {
          try { rmSync(prev, { force: true }); renameSync(file, prev); } catch {}
        }
      }
      // Hard ceiling: if rotation FAILED to clear the file (e.g. prev is
      // locked — `after` still ≥ cap), the append must not grow it
      // unboundedly — receipts are DROPPED instead (fail-open means dropped
      // telemetry is fine; unbounded disk is not; Codex round 1). The check
      // includes the candidate line's own bytes, so a rotation-blocked file
      // can NEVER exceed 2× the cap — an exact bound, not "2× plus one
      // receipt" (round 2). Scoped to the failed-rotation state: after a
      // SUCCESSFUL rotation the file is fresh and a single receipt line
      // (verb/sub capped at 64 chars) can never approach the bound.
      let after = 0;
      try { after = statSync(file).size; } catch {}
      if (after >= rotateBytes && after + Buffer.byteLength(line, 'utf8') > rotateBytes * 2) return false;
    }
    appendFileSync(file, line);
    return true;
  } catch { return false; }
}

// Read the full retained corpus (prev generation first, then current — the
// retained receipts in append order). Unparseable non-empty lines are COUNTED
// as dropped, never silently skipped: the honesty contract requires readers
// to surface them.
export async function readReceipts(stateRoot) {
  const out = { receipts: [], dropped: 0, window: null, bytes: 0, files: [] };
  for (const p of [prevPath(stateRoot), receiptsPath(stateRoot)]) {
    let text;
    try {
      text = await readFile(p, 'utf8');
      out.bytes += (await stat(p)).size;
      out.files.push(p);
    } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // FULL writer-shape check — every field the writer emits, exactly:
        // a record missing `exit` would contaminate the failure tally
        // (undefined !== 0 reads as a failed invocation; Codex round 1),
        // a non-string truthy `sub` would corrupt the verb rollup key, and
        // anything else off-shape is outside this reader's contract
        // (round 2). Off-shape records count as dropped, never guessed.
        const valid = r && r.v === 1
          && typeof r.verb === 'string' && typeof r.ts === 'string'
          && (r.sub === null || typeof r.sub === 'string')
          && Number.isInteger(r.exit) && Number.isFinite(r.ms)
          && (r.sessionId === null || typeof r.sessionId === 'string')
          && typeof r.workspace === 'string';
        if (valid) out.receipts.push(r);
        else out.dropped++;
      } catch { out.dropped++; }
    }
  }
  let oldest = null, newest = null;
  for (const r of out.receipts) {
    if (!oldest || r.ts < oldest) oldest = r.ts;
    if (!newest || r.ts > newest) newest = r.ts;
  }
  if (oldest) out.window = { oldest, newest };
  return out;
}

// Per-verb rollup for one workspace, window + drop count attached — the shape
// `insights verbs` and `maddu log --window` render. Never a lifetime total:
// callers must present `window` and `dropped` alongside `count`.
export async function readReceiptStats(stateRoot) {
  const { receipts, dropped, window, bytes, files } = await readReceipts(stateRoot);
  const verbMap = new Map();
  let failures = 0;
  for (const r of receipts) {
    const key = r.sub ? `${r.verb} ${r.sub}` : r.verb;
    const cur = verbMap.get(key) || { count: 0, fail: 0 };
    cur.count++;
    if (r.exit !== 0) { cur.fail++; failures++; }
    verbMap.set(key, cur);
  }
  const verbs = [...verbMap.entries()]
    .map(([verb, { count, fail }]) => ({ verb, count, fail }))
    .sort((a, b) => b.count - a.count || a.verb.localeCompare(b.verb));
  return { count: receipts.length, failures, dropped, window, bytes, files, verbs, rotateBytes: ROTATE_BYTES };
}
