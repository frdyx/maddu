// One racer process for mutation-breach-drain-race.mjs. Spins on a per-trial
// barrier file, then performs ONE operation against that trial's directory
// and records what it believed happened, with a system-wide monotonic
// timestamp on either side so the parent can prove the racers overlapped.
//
//   node _mutation-breach-drain-racer.mjs <mode> <workdir> <racerId> <nTrials>
//
// mode = 'drain'  — the real drainBreachesToSpine over the trial's spool
//        (one row); the regression under test.
//        'rename' — the bare per-process rename claim the v1.132.0 gate
//        replaced; the CONTROL that proves this harness reproduces the
//        platform collision the defect depended on.
//
// The spin is deliberately tight (no sleeps): every racer observes the barrier
// within microseconds of the others, which is what makes the calls overlap.

import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { drainBreachesToSpine } from '../../template/maddu/runtime/lib/mutation-witness.mjs';

const [mode, workdir, racerId, nTrialsStr] = process.argv.slice(2);
const nTrials = Number(nTrialsStr);
const resFile = join(workdir, `res.${racerId}.ndjson`);
// Creating the result file is the "loaded, about to spin" signal the parent
// waits for before it releases the first barrier.
writeFileSync(resFile, '');

function spinUntilExists(p) {
  for (;;) { try { statSync(p); return; } catch {} }
}

// Same shape as the lib's claimName() so the control renames to the names the
// pre-gate drainer would have produced (distinct per process).
function bareClaimName(base) {
  return `${base}.draining.${Date.now()}-${hostname().replace(/-/g, '_').slice(0, 32)}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

for (let i = 0; i < nTrials; i++) {
  const tdir = join(workdir, `t${i}`);
  spinUntilExists(join(workdir, `go.${i}`));
  const rec = { trial: i, racer: racerId, pid: process.pid };
  const t0 = process.hrtime.bigint();
  try {
    if (mode === 'drain') {
      const appended = [];
      const r = await drainBreachesToSpine(tdir, tdir, async (ev) => { appended.push(ev.data.breachId); });
      Object.assign(rec, {
        drained: r.drained, failed: r.failed, appended,
        errors: r.errors.map((e) => ({ name: e.name, code: e.code ?? null })),
      });
    } else if (mode === 'rename') {
      await rename(join(tdir, 'row.json'), join(tdir, bareClaimName('row.json')));
      rec.renamed = true;
    } else {
      throw new Error(`unknown mode ${mode}`);
    }
  } catch (err) {
    rec.threw = err?.code ?? String(err);
  }
  const t1 = process.hrtime.bigint();
  rec.t0 = t0.toString();
  rec.t1 = t1.toString();
  appendFileSync(resFile, JSON.stringify(rec) + '\n');
  writeFileSync(join(workdir, `ack.${i}.${racerId}`), '');
}
