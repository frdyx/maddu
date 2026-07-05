// spine-append-core.mjs — stdlib-only append mechanics shared by the full spine
// (spine.mjs) and the standalone token-usage wrapper (runtimes/_wrapper-common.mjs).
// Roadmap #12c phase 1.
//
// SCOPE: this module owns ONLY the sync-mode partitioned append — writing into
// `.maddu/events/by-replica/<replicaId>/` under the per-partition append funnel
// with a strictly-valid `prev_hash` chain computed INSIDE the lock. The DEFAULT
// single-machine append path stays in spine.mjs / _wrapper-common.mjs and is
// untouched by this module — sync mode is opt-in (replica.json present).
//
// It imports ONLY Node stdlib + append-lock.mjs (also stdlib-only). It pulls in NO
// catalog/defaults logic, so the worker-subprocess token wrapper can import it
// without breaking its standalone contract (see _wrapper-common.mjs header).

import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withAppendLock } from './append-lock.mjs';

const ROLL_BYTES = 10 * 1024 * 1024;

// Canonical tamper-evidence hash of a stored NDJSON line (trailing CR stripped so a
// CRLF-normalized copy verifies identically). Single source of truth — spine.mjs
// re-exports this so the verifier and every writer can never drift.
export function hashLine(line) {
  return createHash('sha256').update(String(line).replace(/\r$/, ''), 'utf8').digest('hex');
}

export function configReplicaPath(repoRoot) {
  return join(repoRoot, '.maddu', 'config', 'replica.json');
}

// The replicaId of THIS checkout, or null when sync mode is not initialised
// (default single-machine mode). Never throws — a missing/torn file → null → the
// caller takes the unchanged default append path, preserving the opt-in invariant.
export async function readReplicaId(repoRoot) {
  try {
    const obj = JSON.parse(await readFile(configReplicaPath(repoRoot), 'utf8'));
    const id = obj && typeof obj.replicaId === 'string' ? obj.replicaId.trim() : '';
    return id || null;
  } catch {
    return null;
  }
}

export function partitionDir(repoRoot, replicaId) {
  return join(repoRoot, '.maddu', 'events', 'by-replica', replicaId);
}

// Numeric-segment filter — identical to spine.mjs#listSegments, applied per
// partition dir. Dotfiles (`.append.lock`) and replica.json are excluded by it.
async function listSegmentsInDir(dir) {
  try {
    const files = await readdir(dir);
    return files.filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  } catch {
    return [];
  }
}

async function currentSegmentInDir(dir) {
  const segs = await listSegmentsInDir(dir);
  if (segs.length === 0) {
    const name = '000000000001.ndjson';
    await writeFile(join(dir, name), '');
    return name;
  }
  const last = segs[segs.length - 1];
  const st = await stat(join(dir, last));
  if (st.size < ROLL_BYTES) return last;
  const next = String(parseInt(last.split('.')[0], 10) + 1).padStart(12, '0') + '.ndjson';
  await writeFile(join(dir, next), '');
  return next;
}

// Tail-read (≤64 KB) the exact stored text of the last non-empty event line in
// this partition, or null if empty. Dir-scoped mirror of spine.mjs#lastEventLine.
async function lastEventLineInDir(dir) {
  const segs = await listSegmentsInDir(dir);
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = join(dir, segs[i]);
    let st;
    try { st = await stat(p); } catch { continue; }
    if (st.size === 0) continue;
    const readLen = Math.min(st.size, 65536);
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, st.size - readLen);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      if (lines.length) return lines[lines.length - 1];
    } finally { await fh.close(); }
    // Pathological single line > 64 KB — full read fallback.
    const lines = (await readFile(p, 'utf8')).split('\n').filter((l) => l.trim());
    if (lines.length) return lines[lines.length - 1];
  }
  return null;
}

function onWaitStderr(dir) {
  return ({ waitedMs, holder }) => {
    if (waitedMs > 0) {
      const who = holder && holder.pid ? ` (held by pid ${holder.pid}@${holder.host})` : '';
      process.stderr.write(
        `maddu spine: waiting ${Math.round(waitedMs / 1000)}s for partition append lock in ${dir}${who}\n`
      );
    }
  };
}

// Append a pre-built event into THIS replica's partition, under the append funnel,
// with `prev_hash` computed INSIDE the lock so the read-then-write cannot fork.
// `ev` must be a complete envelope WITHOUT prev_hash; prev_hash is set here.
// Returns the same `ev` (now carrying prev_hash), matching spine.append()'s return.
export async function appendPartitioned(repoRoot, replicaId, ev) {
  const dir = partitionDir(repoRoot, replicaId);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, '.append.lock');
  return withAppendLock(
    lockPath,
    async () => {
      const prevLine = await lastEventLineInDir(dir);
      ev.prev_hash = prevLine === null ? null : hashLine(prevLine);
      const line = JSON.stringify(ev);
      if (line.includes('\n')) {
        throw new Error('spine-append-core: serialized event contains a raw newline — NDJSON framing invariant violated');
      }
      const seg = await currentSegmentInDir(dir);
      await appendFile(join(dir, seg), line + '\n', { flag: 'a' });
      return ev;
    },
    { onWait: onWaitStderr(dir) }
  );
}
