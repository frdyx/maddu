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

import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readReplicaId, appendPartitioned } from '../spine-append-core.mjs';

const ROLL_BYTES = 10 * 1024 * 1024;

function genId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `evt_${t}_${r}`;
}

async function currentSegment(eventsDir) {
  await mkdir(eventsDir, { recursive: true });
  let files;
  try {
    files = (await readdir(eventsDir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  } catch { files = []; }
  if (files.length === 0) {
    const name = '000000000001.ndjson';
    await writeFile(join(eventsDir, name), '');
    return name;
  }
  const last = files[files.length - 1];
  try {
    const st = await stat(join(eventsDir, last));
    if (st.size < ROLL_BYTES) return last;
  } catch {}
  const next = String(parseInt(last.split('.')[0], 10) + 1).padStart(12, '0') + '.ndjson';
  await writeFile(join(eventsDir, next), '');
  return next;
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

  // #12c sync mode: land in the replica's partition on a valid chain (shared,
  // stdlib-only core). Token accounting is best-effort and MUST NOT block the
  // worker's exit, so the funnel wait is BOUNDED — on a stuck lock we let
  // ELOCKTIMEOUT drop this one event (nothing was written, so no chain fork). The
  // caller already wraps this in try/catch + logWrapperError. Default single-
  // machine mode keeps the flat write below.
  const replicaId = await readReplicaId(repoRoot);
  if (replicaId) return appendPartitioned(repoRoot, replicaId, ev, { maxWaitMs: 3000 });

  const seg = await currentSegment(eventsDir);
  await appendFile(join(eventsDir, seg), JSON.stringify(ev) + '\n');
  return ev;
}

// Wrapper-local error log. Failures here are tolerated — we never let a
// bookkeeping failure block the worker's actual output.
export async function logWrapperError(repoRoot, workerId, msg) {
  try {
    const logDir = join(repoRoot, '.maddu', 'state', 'worker-logs');
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `${workerId || 'unknown'}.wrapper-errors.log`);
    await appendFile(logPath, `[${new Date().toISOString()}] ${msg}\n`);
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
