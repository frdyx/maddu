// Stress + unit test for the sync-mode per-partition append funnel
// (append-lock.mjs, roadmap #12c phase 1). Run standalone:
//   node scripts/test/append-lock.mjs
//
// Proves, with REAL concurrent OS processes (the bridge+CLI model):
//   1. CONTROL (no lock) forks the chain — the test is sensitive to forks.
//   2. FUNNEL (with lock) never forks and loses no events under the same load.
//   3. Dead same-host lock is reclaimed (ESRCH steal).
//   4. A LIVE holder's lock is never stolen (waited past, then released cleanly).
//   5. Release is nonce-guarded: an ex-owner never unlinks a replacement's lock.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import {
  hashLine,
} from '../../template/maddu/runtime/lib/spine.mjs';
import {
  acquireAppendLock,
  releaseAppendLock,
} from '../../template/maddu/runtime/lib/append-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, '_append-lock-worker.mjs');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

function runWorker(segPath, lockPath, count, label, mode) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [WORKER, segPath, lockPath, String(count), label, mode], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    cp.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${label} exit ${code}`))));
    cp.on('error', reject);
  });
}

// Verify the on-disk NDJSON forms one unbroken prev_hash chain in file order.
// Returns { total, forkAt } — forkAt = index of first broken link, or -1.
async function verifyChain(segPath) {
  const txt = await readFile(segPath, 'utf8');
  const lines = txt.split('\n').filter((l) => l.trim());
  let forkAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const ev = JSON.parse(lines[i]);
    const expected = i === 0 ? null : hashLine(lines[i - 1]);
    if ((ev.prev_hash ?? null) !== expected) { forkAt = i; break; }
  }
  return { total: lines.length, forkAt, lines };
}

async function scenarioConcurrentWriters(mode, workers, per) {
  const dir = await mkdtemp(join(tmpdir(), `maddu-applock-${mode}-`));
  const segPath = join(dir, '000000000001.ndjson');
  const lockPath = join(dir, '.append.lock');
  await writeFile(segPath, '');
  const labels = Array.from({ length: workers }, (_, k) => `w${k}`);
  await Promise.all(labels.map((l) => runWorker(segPath, lockPath, per, l, mode)));
  const res = await verifyChain(segPath);
  await rm(dir, { recursive: true, force: true });
  return res;
}

async function main() {
  console.log('append-lock: concurrent-writer stress + lock-protocol units');

  const WORKERS = 6;
  const PER = 25;
  const EXPECTED = WORKERS * PER;

  // 1. CONTROL — no lock. Under real concurrency the read→write race MUST fork
  //    (and/or lose framing). If this does NOT fork, the test is blind and any
  //    "locked passes" result is meaningless — so we assert the control forks.
  const control = await scenarioConcurrentWriters('unlocked', WORKERS, PER);
  ok(control.forkAt !== -1, `CONTROL should fork the chain (proves test sensitivity) — got forkAt=${control.forkAt}, total=${control.total}`);

  // 2. FUNNEL — with lock. Must NOT fork and must lose NO events.
  const funnel = await scenarioConcurrentWriters('locked', WORKERS, PER);
  ok(funnel.forkAt === -1, `FUNNEL must not fork — first broken link at index ${funnel.forkAt}`);
  ok(funnel.total === EXPECTED, `FUNNEL must lose no events — expected ${EXPECTED}, got ${funnel.total}`);
  const ids = new Set(funnel.lines.map((l) => JSON.parse(l).id));
  ok(ids.size === EXPECTED, `FUNNEL ids all present & unique — expected ${EXPECTED}, got ${ids.size}`);

  // 3. Dead same-host lock is reclaimed. Fabricate a lock owned by a pid that is
  //    definitely dead (a huge pid that isn't running) on THIS host.
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-applock-dead-'));
    const lockPath = join(dir, '.append.lock');
    const deadPid = 2147480000; // effectively never a live pid → ESRCH
    await writeFile(lockPath, JSON.stringify({ ownerId: 'stale', pid: deadPid, host: hostname(), startedAt: new Date().toISOString() }));
    let acquired = false;
    const t = setTimeout(() => {}, 0);
    const lock = await Promise.race([
      acquireAppendLock(lockPath).then((l) => { acquired = true; return l; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out — dead lock NOT reclaimed')), 3000)),
    ]).catch((e) => { console.error(`  ! ${e.message}`); return null; });
    clearTimeout(t);
    ok(acquired && lock, 'dead same-host lock is reclaimed (ESRCH steal)');
    if (lock) await lock.release();
    await rm(dir, { recursive: true, force: true });
  }

  // 4. A LIVE holder is never stolen: a second acquire must BLOCK until release.
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-applock-live-'));
    const lockPath = join(dir, '.append.lock');
    const first = await acquireAppendLock(lockPath);
    let secondAcquired = false;
    const secondP = acquireAppendLock(lockPath).then((l) => { secondAcquired = true; return l; });
    await new Promise((r) => setTimeout(r, 300));
    ok(!secondAcquired, 'live holder is NOT stolen — second acquire blocks while first is held');
    await first.release();
    const second = await Promise.race([
      secondP,
      new Promise((_, rej) => setTimeout(() => rej(new Error('second never acquired after release')), 3000)),
    ]).catch((e) => { console.error(`  ! ${e.message}`); return null; });
    ok(!!second, 'second acquire proceeds once the live holder releases');
    if (second) await second.release();
    await rm(dir, { recursive: true, force: true });
  }

  // 5. Nonce-guarded release: an ex-owner must not unlink a replacement's lock.
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-applock-nonce-'));
    const lockPath = join(dir, '.append.lock');
    const a = await acquireAppendLock(lockPath);
    // Simulate A's lock having been stolen and replaced by B (new nonce on disk).
    await writeFile(lockPath, JSON.stringify({ ownerId: 'B-owner', pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    await releaseAppendLock(lockPath, a.ownerId); // A tries to release its (gone) lock
    let stillThere = false;
    try { await stat(lockPath); stillThere = true; } catch { stillThere = false; }
    ok(stillThere, "ex-owner's nonce-guarded release does NOT unlink the replacement lock");
    const cur = JSON.parse(await readFile(lockPath, 'utf8'));
    ok(cur.ownerId === 'B-owner', "replacement lock survives ex-owner release");
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`append-lock: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
