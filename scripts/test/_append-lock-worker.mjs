// Child worker for the append-lock stress test. Models a single spine writer
// (bridge OR cli) hammering one partition segment. argv:
//   node _append-lock-worker.mjs <segPath> <lockPath> <count> <label> <mode>
// mode = 'locked' (funnel) | 'unlocked' (control — proves the test detects forks).
//
// The critical section is deliberately read → tiny yield → write, which is the
// exact predecessor race spine.append() has (read lastEventLine, then O_APPEND).
// The yield widens the window so an unlocked control forks reliably.

import { appendFile, readFile } from 'node:fs/promises';
import { hashLine } from '../../template/maddu/runtime/lib/spine.mjs';
import { withAppendLock } from '../../template/maddu/runtime/lib/append-lock.mjs';

const [, , segPath, lockPath, countRaw, label, mode] = process.argv;
const count = parseInt(countRaw, 10);

async function lastLine(p) {
  let txt;
  try { txt = await readFile(p, 'utf8'); } catch { return null; }
  const lines = txt.split('\n').filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : null;
}

function yieldTick() {
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
}

async function writeOne(i) {
  const prevLine = await lastLine(segPath);
  await yieldTick(); // widen the read→write window
  const prev_hash = prevLine === null ? null : hashLine(prevLine);
  const ev = { v: 1, id: `${label}-${i}`, ts: new Date().toISOString(), type: 'STRESS', prev_hash };
  const line = JSON.stringify(ev);
  await appendFile(segPath, line + '\n', { flag: 'a' });
}

async function main() {
  for (let i = 0; i < count; i++) {
    if (mode === 'unlocked') {
      await writeOne(i);
    } else {
      await withAppendLock(lockPath, () => writeOne(i));
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); }
);
