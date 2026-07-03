// v1.1.0 Phase 7 — coordinator primitive (runtime-agnostic).
//
// `maddu coordinator <plan-id>` reads `.maddu/plans/<id>/state.json`,
// walks phases in order, spawns one subprocess per phase. The
// subprocess inherits MADDU_COORDINATOR_PLAN_ID / _PHASE / _SESSION_ID
// env vars + the phase's `intent` as the initial prompt.
//
// 5-iter cap per phase. Each phase fans into a loop primitive (Phase 6)
// so stuck-detection + cooldown still apply.
//
// Coordinator is intentionally NOT dependent on Claude Code's Agent
// tool. The subprocess runner is the operator's choice of runtime
// (claude-code, codex, gemini, …) via the existing runtime descriptors
// — OR a synthetic shell command for testing.

import { spawn } from 'node:child_process';
import { append, EVENT_TYPES, makeId, readAll } from './spine.mjs';
import { readPlan, completePhase } from './plans.mjs';
import { readEffectiveGovernance, effectiveValue } from './governance.mjs';
import { runSliceReview } from './review.mjs';
import { spawnWorker } from './runtimes.mjs';

// NOTE (v1.3.0 coherence): the per-phase loop below shares its
// stuck-detection heuristic ("same fail signature twice → halt") with
// loops.mjs#runLoop, but is intentionally NOT merged with it — this driver
// emits COORDINATOR_* events, injects MADDU_COORDINATOR_* env, and spawns a
// subprocess per phase, whereas runLoop emits LOOP_* events and runs
// caller-supplied verify/iterate callbacks. See commands/loop.mjs for the
// rationale.
const PHASE_ITER_CAP = 5;

function genCoordinatorId() {
  return makeId('crd', undefined, 2);
}

async function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// Rule-#9 allowlist reader (same flat `allowed: [string]` schema slice-stop
// and schedule.mjs use). Best-effort: missing/unparseable → empty.
async function readTriggersAllowlist(repoRoot) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, '.maddu', 'config', 'triggers.json'), 'utf8'));
    return Array.isArray(parsed?.allowed) ? parsed.allowed : [];
  } catch { return []; }
}

function runPhaseSubprocess(cmd, args, env, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const ch = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => { try { ch.kill('SIGTERM'); } catch {} }, opts.timeoutMs);
    }
    ch.stdout.on('data', (b) => stdout += b.toString());
    ch.stderr.on('data', (b) => stderr += b.toString());
    ch.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
    ch.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + err.message }); });
  });
}

export async function runCoordinator(repoRoot, { planId, runtime = null, sessionId = null, dryRun = false, syntheticPhaseCmd = null, iterCap = null }) {
  if (!planId) throw new Error('planId required');
  const plan = await readPlan(repoRoot, planId);
  if (!plan || !plan.title) throw new Error(`plan ${planId} not found`);
  if (plan.status === 'completed' || plan.status === 'cancelled') {
    throw new Error(`plan ${planId} is ${plan.status} — refusing to coordinate`);
  }

  const gov = await readEffectiveGovernance(repoRoot); // phase-tier aware (v1.91.0)
  const effIterCap = iterCap != null ? iterCap : PHASE_ITER_CAP;
  const cooldownMs = effectiveValue(gov, 'loop-cooldown-ms');

  const coordinatorId = genCoordinatorId();
  const startEv = await append(repoRoot, {
    type: EVENT_TYPES.COORDINATOR_STARTED,
    actor: sessionId, lane: null,
    triggered_by: { planId },
    data: { coordinatorId, planId, runtime, dryRun },
  });
  // Slices produced during this run are review-eligible (Bucket C, v1.4.0).
  const startedTs = startEv.ts;
  const reviewedSlices = new Set();

  // v1.7.0 (invocation-logic) — checkpoint-before-risky-op. A real
  // coordinator run spawns workers that mutate the repo across multiple
  // phases; an auto-snapshot before that gives the operator a clean
  // rollback point. This is the WHEN that was missing for the checkpoint
  // domain (CHECKPOINT_* never fired in any real project). Skipped for
  // dry-run / synthetic smoke tests (no real mutation). Rule-#9 gauntlet:
  // gated on the `coordinator:pre-run-checkpoint` allowlist entry, emits
  // TRIGGER_FIRED + CHECKPOINT_CREATED carrying triggered_by. Best-effort
  // (no git / no tag → coordinator proceeds; the snapshot is a safety net,
  // not a precondition).
  if (!dryRun && !syntheticPhaseCmd) {
    try {
      const allowed = await readTriggersAllowlist(repoRoot);
      if (allowed.includes('coordinator:pre-run-checkpoint')) {
        const cp = await import('./checkpoints.mjs');
        if (await cp.gitAvailable(repoRoot)) {
          const provenance = { kind: 'coordinator', id: coordinatorId, fired_at: startedTs };
          await append(repoRoot, {
            type: EVENT_TYPES.TRIGGER_FIRED,
            actor: sessionId, lane: null,
            data: { triggerId: 'coordinator:pre-run-checkpoint', reason: 'pre-coordinator-run', planId, triggered_by: provenance },
          });
          const rec = await cp.createCheckpoint(repoRoot, {
            by: sessionId,
            title: `before coordinator ${coordinatorId} (plan ${planId})`,
            triggeredBy: provenance,
          });
          console.log(`  checkpoint ${rec.id} created before coordinator run (rollback: maddu checkpoint rollback ${rec.id})`);
        }
      }
    } catch { /* snapshot is best-effort; never blocks the run */ }
  }

  const phases = (plan.phases || []).filter((p) => p.status !== 'completed');
  for (const phase of phases) {
    if (phase.status === 'blocked') {
      await append(repoRoot, {
        type: EVENT_TYPES.COORDINATOR_HALTED,
        actor: sessionId, lane: null,
        triggered_by: { planId, coordinatorId, phase: phase.name },
        data: { coordinatorId, planId, phase: phase.name, reason: 'phase-blocked', detail: phase.blockedReason || '' },
      });
      return { ok: false, reason: 'phase-blocked', phase: phase.name, coordinatorId };
    }

    await append(repoRoot, {
      type: EVENT_TYPES.COORDINATOR_PHASE_STARTED,
      actor: sessionId, lane: null,
      triggered_by: { planId, coordinatorId },
      data: { coordinatorId, planId, phase: phase.name, intent: phase.intent },
    });

    let phaseResult = { ok: false, lastSignature: null, exitCode: null };
    let lastSig = null, sameSigCount = 0;

    for (let iter = 1; iter <= effIterCap; iter++) {
      const env = {
        ...process.env,
        MADDU_COORDINATOR_PLAN_ID: planId,
        MADDU_COORDINATOR_PHASE: phase.name,
        MADDU_COORDINATOR_ID: coordinatorId,
        MADDU_COORDINATOR_ITER: String(iter),
        MADDU_SESSION_ID: sessionId || process.env.MADDU_SESSION_ID || '',
      };

      let result;
      if (dryRun) {
        // Dry-run mode: succeed immediately. Useful for the synthetic
        // 3-phase plan walk-through.
        result = { code: 0, stdout: `[dry-run] ${phase.name}: ${phase.intent || ''}`, stderr: '' };
      } else if (syntheticPhaseCmd) {
        // Synthetic mode: run the supplied shell command. The command
        // sees MADDU_COORDINATOR_PHASE in its env so it can branch.
        const isWin = process.platform === 'win32';
        const shell = isWin ? 'cmd.exe' : 'sh';
        const args = isWin ? ['/c', syntheticPhaseCmd] : ['-c', syntheticPhaseCmd];
        result = await runPhaseSubprocess(shell, args, env, { cwd: repoRoot, timeoutMs: 60000 });
      } else if (runtime) {
        // v1.5.0 — real-runtime mode: spawn the configured runtime as a
        // tracked Máddu worker (WORKER_SPAWNED/EXITED + an auto-registered
        // child session linked to this coordinator's session) and use the
        // worker's exit code as the phase result. The phase intent rides in
        // env (MADDU_COORDINATOR_PHASE) and as an extra arg so a runtime
        // descriptor can route it into the agent's prompt. Awaits exit via
        // spawnWorker's wait mode.
        try {
          const w = await spawnWorker(repoRoot, runtime, {
            wait: true,
            session: sessionId,
            stage: phase.name,
            label: `coordinator ${coordinatorId} · ${phase.name}`,
            task: phase.intent || null,
          });
          result = {
            code: w.error ? -1 : (w.exitCode == null ? 0 : w.exitCode),
            stdout: `[runtime:${runtime} worker:${w.workerId} exit:${w.exitCode}]`,
            stderr: w.error || '',
          };
        } catch (err) {
          result = { code: -1, stdout: '', stderr: `spawn failed: ${err.message}` };
        }
      } else {
        // No runtime and no synthetic command — nothing to execute. Keep the
        // phase a no-op success (legacy behaviour) but tell the operator how
        // to make it real.
        result = { code: 0, stdout: `[no runtime] phase ${phase.name} — pass --runtime <name> to spawn a tracked worker, or --synthetic-cmd for a smoke run`, stderr: '' };
      }

      const sig = `exit=${result.code}:${(result.stderr || result.stdout).slice(-80)}`;
      if (result.code === 0) {
        phaseResult = { ok: true, lastSignature: sig, exitCode: 0 };
        break;
      }

      if (sig === lastSig) sameSigCount += 1; else { sameSigCount = 1; lastSig = sig; }
      if (sameSigCount >= 2) {
        phaseResult = { ok: false, lastSignature: sig, exitCode: result.code };
        break;
      }
      if (iter < effIterCap) await sleep(cooldownMs);
    }

    if (!phaseResult.ok) {
      await append(repoRoot, {
        type: EVENT_TYPES.COORDINATOR_HALTED,
        actor: sessionId, lane: null,
        triggered_by: { planId, coordinatorId, phase: phase.name },
        data: { coordinatorId, planId, phase: phase.name, reason: 'phase-iteration-cap', signature: phaseResult.lastSignature, exitCode: phaseResult.exitCode },
      });
      return { ok: false, reason: 'phase-iteration-cap', phase: phase.name, coordinatorId };
    }

    // Mark the phase complete on the plan (emits PLAN_PHASE_COMPLETED →
    // refreshes state.json + plan.md artifacts via Phase 5).
    try { await completePhase(repoRoot, { planId, name: phase.name, summary: `coordinator ${coordinatorId} OK`, by: sessionId }); } catch {}

    await append(repoRoot, {
      type: EVENT_TYPES.COORDINATOR_PHASE_COMPLETED,
      actor: sessionId, lane: null,
      triggered_by: { planId, coordinatorId, phase: phase.name },
      data: { coordinatorId, planId, phase: phase.name },
    });

    // v1.4.0 (Bucket C) — enforce the review stage: review the newest slice
    // produced during this run, if a reviewer runtime is configured. Graceful
    // no-op (skipped) when none is set up. Never blocks coordination.
    try {
      const all = await readAll(repoRoot);
      const fresh = all.filter((e) => e.type === 'SLICE_STOP' && e.ts >= startedTs && !reviewedSlices.has(e.id));
      const newest = fresh[fresh.length - 1];
      if (newest) {
        reviewedSlices.add(newest.id);
        const r = await runSliceReview(repoRoot, {
          sliceEventId: newest.id,
          triggeredBy: { kind: 'coordinator', id: coordinatorId, fired_at: new Date().toISOString() },
        });
        if (r && r.ok) console.log(`[coordinator ${coordinatorId}] reviewed slice ${newest.id}: ${r.verdict}`);
      }
    } catch (err) {
      console.error(`[coordinator ${coordinatorId}] review attempt failed (non-fatal): ${err.message}`);
    }
  }

  await append(repoRoot, {
    type: EVENT_TYPES.COORDINATOR_COMPLETED,
    actor: sessionId, lane: null,
    triggered_by: { planId, coordinatorId },
    data: { coordinatorId, planId, phaseCount: phases.length },
  });
  return { ok: true, phaseCount: phases.length, coordinatorId };
}
