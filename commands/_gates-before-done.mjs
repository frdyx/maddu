// _gates-before-done — tier-scaled "gates must be green before you mark work
// done" check, shared by `maddu goal done` and `maddu plan complete`.
//
// Reuses the `discipline-enforcement` governance value (the same tier that scales
// the PreToolUse edit block):
//   • strict  (block)     → REFUSE completion while a critical/safety gate is red
//                            (overridable with --force, which is recorded).
//   • standard(graduated) → run gates, print any failures, but ALLOW completion.
//   • relaxed (nudge/off) → skip the check entirely.
//
// Abandon / cancel must NOT call this — those are honest terminal states and are
// never gated. FAILS OPEN: any error in our own check returns proceed:true, so a
// gate-runner bug can never trap the operator's ability to close work.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLib } from './_libroot.mjs';

// Which gate failures count as "blocking" mirrors `maddu ci`: a consumer pins a
// required set (maddu.json ci.requiredGates, or the source checkout's
// .maddu/config/ci.json), and only those block. Read order mirrors ci's writer.
async function readRequiredGates(repoRoot) {
  for (const p of [join(repoRoot, 'maddu.json'), join(repoRoot, '.maddu', 'config', 'ci.json')]) {
    try {
      const j = JSON.parse(await readFile(p, 'utf8'));
      const req = p.endsWith('maddu.json') ? j?.ci?.requiredGates : j?.requiredGates;
      if (Array.isArray(req)) return req;
    } catch { /* absent / unreadable → try next */ }
  }
  return null;
}

// Pure tier decision. Given the enforcement tier, the --force flag, and how many
// critical/safety gates failed, decide whether completion proceeds and whether
// gates even need running. Kept pure so the branching is unit-tested directly.
//   runGates? → does the caller need to run the suite at all
//   proceed   → may completion append
//   blocked   → strict refusal (proceed false because a gate is red)
export function gateVerdict({ enforcement, force = false, failCount = null }) {
  if (enforcement === 'off' || enforcement === 'nudge') return { runGates: false, proceed: true, skipped: 'relaxed' };
  if (force) return { runGates: false, proceed: true, forced: true };
  if (failCount == null) return { runGates: true, proceed: true }; // caller must run gates then re-decide
  if (failCount === 0) return { runGates: true, proceed: true, failCount: 0 };
  const blocked = enforcement === 'block';
  return { runGates: true, proceed: !blocked, blocked, failCount };
}

export async function checkGatesBeforeDone(repoRoot, { force = false } = {}) {
  try {
    const gov = await loadLib('governance.mjs');
    const gatesLib = await loadLib('gates.mjs');
    if (!gov || !gatesLib?.runGates) return { proceed: true, skipped: 'libs-unavailable' };

    const cfg = await gov.readEffectiveGovernance(repoRoot).catch(() => ({ mode: 'standard', overrides: {} }));
    const enforcement = gov.effectiveValue(cfg, 'discipline-enforcement') || 'graduated';

    const pre = gateVerdict({ enforcement, force });
    if (!pre.runGates) return { ...pre, enforcement };

    // emitEvents:false → the completion check writes NO GATE_RAN events (spine-
    // neutral; recording denials/gate-runs is a separate, deferred concern).
    const res = await gatesLib.runGates(repoRoot, { emitEvents: false });
    const runs = res.runs || [];
    // Blocking mirrors `maddu ci` EXACTLY: only pinned-required gates block, and a
    // repo with NO pinned profile blocks on nothing (ci is green there without
    // --strict). This keeps the source checkout's non-required env fails — and any
    // unprofiled consumer — from being trapped out of `goal done` / `plan complete`.
    const required = await readRequiredGates(repoRoot);
    const blockingFails = Array.isArray(required)
      ? runs.filter((r) => r.status === 'fail' && required.includes(r.gateId))
      : [];
    const failCount = blockingFails.length;
    const post = gateVerdict({ enforcement, force, failCount });
    const failed = blockingFails.map((r) => ({ gateId: r.gateId, message: r.message }));
    return { ...post, enforcement, failCount, warnCount: res.warnCount || 0, failed: failCount ? failed : undefined };
  } catch {
    return { proceed: true, error: true }; // fail-open: never trap completion on our own error
  }
}

// Print the check's result and return { proceed, forced, failCount }. Callers
// use `proceed` to decide whether to append the completion event, and should
// fold { gatesFailed, gatesForced } into that event's data (open, non-load-bearing).
export function reportGatesBeforeDone(gate, label = 'work') {
  if (gate.skipped || gate.error || !gate.failCount) {
    return { proceed: gate.proceed, forced: !!gate.forced, failCount: gate.failCount || 0 };
  }
  const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
  console.error(c(33, `${gate.failCount} gate(s) failing before ${label} can be marked done:`));
  for (const f of (gate.failed || [])) console.error(`  ${c(31, '✗')} ${f.gateId}: ${f.message}`);
  if (!gate.proceed) {
    console.error(c(31, `refusing to mark ${label} done`) + ` — fix the gate(s) above, or re-run with --force. (governance: strict)`);
  } else {
    console.error(c(33, `proceeding anyway (governance: ${gate.enforcement}) — gates are not blocking at this tier.`));
  }
  return { proceed: gate.proceed, forced: !!gate.forced, failCount: gate.failCount };
}
