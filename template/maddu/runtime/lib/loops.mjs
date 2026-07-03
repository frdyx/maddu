// v1.1.0 Phase 6 — loop primitives (ralph + plan-loop).
//
// Every iteration is a real slice with slice-stop discipline. Each
// emits LOOP_ITERATION_STARTED + LOOP_ITERATION_COMPLETED. The host
// CLI hands a `verify` callback that returns { ok, signature }; the
// loop iterates until ok or the cap. Stuck-detection: 2 consecutive
// identical verify-fail signatures → halt.
//
// Cooldown read from the governance tier (Phase 3 lib).

import { append, EVENT_TYPES, makeId } from './spine.mjs';
import { readEffectiveGovernance, effectiveValue } from './governance.mjs';

function genLoopId() {
  return makeId('lop', undefined, 2);
}

async function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

export async function runLoop(repoRoot, { kind = 'ralph', goal, verify, iterate, maxIter = null, cooldownMs = null, by = null, lane = null, triggered_by = null }) {
  if (typeof verify !== 'function') throw new Error('runLoop: verify(iter) callback required');
  const gov = await readEffectiveGovernance(repoRoot); // phase-tier aware (v1.91.0)
  const effMax = maxIter != null ? maxIter : effectiveValue(gov, 'loop-max-iter-default');
  const effCooldown = cooldownMs != null ? cooldownMs : effectiveValue(gov, 'loop-cooldown-ms');

  const loopId = genLoopId();
  await append(repoRoot, {
    type: EVENT_TYPES.LOOP_STARTED,
    actor: by, lane,
    triggered_by,
    data: { loopId, kind, goal, maxIter: effMax, cooldownMs: effCooldown },
  });

  let lastFailSig = null;
  let consecutiveFails = 0;
  let result = null;

  for (let iter = 1; iter <= effMax; iter++) {
    await append(repoRoot, {
      type: EVENT_TYPES.LOOP_ITERATION_STARTED,
      actor: by, lane,
      triggered_by: { loopId, iter },
      data: { loopId, kind, iter },
    });

    let iterResult = { ok: false, signature: null, summary: null };
    try {
      if (typeof iterate === 'function') {
        const iterRes = await iterate(iter, { loopId });
        if (iterRes && typeof iterRes === 'object') Object.assign(iterResult, iterRes);
      }
      const v = await verify(iter, { loopId });
      if (v && typeof v === 'object') {
        iterResult.ok = !!v.ok;
        iterResult.signature = v.signature || null;
        iterResult.summary = v.summary || iterResult.summary;
      }
    } catch (err) {
      iterResult = { ok: false, signature: `error:${err.message}`, summary: err.message };
    }

    await append(repoRoot, {
      type: EVENT_TYPES.LOOP_ITERATION_COMPLETED,
      actor: by, lane,
      triggered_by: { loopId, iter },
      data: { loopId, kind, iter, ok: iterResult.ok, signature: iterResult.signature, summary: iterResult.summary },
    });

    if (iterResult.ok) {
      await append(repoRoot, {
        type: EVENT_TYPES.LOOP_COMPLETED,
        actor: by, lane,
        triggered_by: { loopId },
        data: { loopId, kind, iter, summary: iterResult.summary || null },
      });
      result = { ok: true, loopId, iters: iter };
      break;
    }

    // Stuck-detection: same fail signature twice in a row.
    if (iterResult.signature && iterResult.signature === lastFailSig) {
      consecutiveFails += 1;
    } else {
      consecutiveFails = 1;
      lastFailSig = iterResult.signature;
    }
    if (consecutiveFails >= 2) {
      await append(repoRoot, {
        type: EVENT_TYPES.LOOP_HALTED,
        actor: by, lane,
        triggered_by: { loopId },
        data: { loopId, kind, iter, reason: 'stuck-detection', signature: lastFailSig },
      });
      result = { ok: false, loopId, iters: iter, reason: 'stuck-detection', signature: lastFailSig };
      break;
    }

    if (iter < effMax) await sleep(effCooldown);
  }

  if (!result) {
    await append(repoRoot, {
      type: EVENT_TYPES.LOOP_HALTED,
      actor: by, lane,
      triggered_by: { loopId },
      data: { loopId, kind, iter: effMax, reason: 'max-iter-reached' },
    });
    result = { ok: false, loopId, iters: effMax, reason: 'max-iter-reached' };
  }

  return result;
}
