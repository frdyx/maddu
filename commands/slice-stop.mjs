// `maddu slice-stop` — append a structured slice-stop event to the spine.
//
// Usage:
//   maddu slice-stop [--session <id>] (--summary "..." | "<summary positional>")
//                    [--lane <id>] [--action "..."] [--targets "a,b,c"]
//                    [--paths "a/,b/"] [--gates "g1,g2"] [--learnings "A;B;C"]
//                    [--next "X;Y"] [--reason "..."]
//
// Comma-separated for plain lists; semicolon-separated for learnings/next
// (because those entries often contain commas themselves).
//
// v0.19.1 PR-B:
//   - `--session` falls back to MADDU_SESSION_ID env var.
//   - If `--summary` is omitted, the first positional argument is used
//     as the summary (forgiving for natural agent invocations like
//     `slice-stop --session X "SLICE STOP: ..."`).

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, resolveSessionId } from './_spine.mjs';
import { loadLibOptional } from './_libroot.mjs';

function csv(s) {
  if (!s || s === true) return [];
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}
function ssv(s) {
  if (!s || s === true) return [];
  return String(s).split(';').map((x) => x.trim()).filter(Boolean);
}

// Runtime-lib resolution (cwd-installed → dev-template fallback) is shared via
// _libroot's loadLibOptional, which returns null when the module is absent.

// D2 (v1.13.0): derive the ACTUAL changed files from git so the slice-scope
// gate isn't limited to what the agent self-reported via --targets/--paths.
// The gate is only as honest as the paths it's handed; an agent that edits
// outside scope and simply omits those files from its flags would otherwise
// pass. `git diff --name-only HEAD` covers staged + unstaged tracked edits;
// `ls-files --others` adds new untracked files. Repo-relative, forward-slashed.
// Returns null when not a git repo / git unavailable — slice-stop never breaks.
async function gitTouchedPaths(repoRoot) {
  try {
    const { execFileSync } = await import('node:child_process');
    const run = (args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tracked = run(['diff', '--name-only', 'HEAD']).split('\n');
    const untracked = run(['ls-files', '--others', '--exclude-standard']).split('\n');
    return [...tracked, ...untracked]
      .map((p) => p.trim().replace(/\\/g, '/'))
      .filter(Boolean)
      // Exclude Máddu's own state churn — every slice-stop writes the spine,
      // sessions, and projections. That is framework bookkeeping, not the
      // slice's product/code surface the scope gate governs.
      .filter((p) => !p.startsWith('.maddu/') && p !== 'maddu.json');
  } catch { return null; }
}

export default async function sliceStop(argv) {
  const { flags, positional } = parseFlags(argv);
  // v0.19.1 PR-B2: accept first positional arg as --summary if the flag
  // was omitted. The agent-side invocation pattern is
  //   `./maddu/run slice-stop --session X "SLICE STOP: ..."`
  // which previously failed with "--summary required".
  if ((!flags.summary || flags.summary === true) && positional.length > 0) {
    flags.summary = positional[0];
  }
  const summary = requireFlag(flags, 'summary');

  const { paths, spine, projections, hindsight, sessionActive } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  // v0.19.1 PR-B1: --session falls back to $MADDU_SESSION_ID. v1.73.x: then to
  // the active-session cache written by `maddu register`, so the slice-stop
  // ritual records to the spine without the agent threading a session id by
  // hand on every fresh tool-call shell — the friction that made it skipped.
  const sessionId = await resolveSessionId(repoRoot, flags, sessionActive);
  if (!sessionId) {
    console.error('--session required (or set MADDU_SESSION_ID, or run `maddu register` first)');
    process.exit(2);
  }

  // Governance Phase 3: invoke the slice-scope gate before appending.
  // Skipped when no scope is declared for the current slice (opt-in).
  const sliceId = (typeof flags['slice-id'] === 'string' ? flags['slice-id'] : null)
    || process.env.MADDU_SLICE_ID || null;
  const reportedPaths = [...csv(flags.targets), ...csv(flags.paths)];
  let touchedPaths = reportedPaths;
  if (sliceId) {
    // D2: cross-check the self-reported paths against git's actual working-tree
    // changes. Union them in so an out-of-scope edit the agent didn't declare
    // is still seen by the slice-scope gate. `--no-git-diff` opts out (e.g. a
    // non-git workspace or a deliberately partial slice-stop).
    if (flags['no-git-diff'] !== true) {
      const gitTouched = await gitTouchedPaths(repoRoot);
      if (gitTouched && gitTouched.length) {
        const set = new Set(reportedPaths);
        for (const p of gitTouched) set.add(p);
        touchedPaths = [...set];
        const omitted = gitTouched.filter((p) => !reportedPaths.includes(p));
        if (omitted.length) {
          console.error(`  slice-scope: cross-checked ${gitTouched.length} git working-tree change(s); ${omitted.length} not in --targets/--paths`);
        }
      }
    }
    const gatesLib = await loadLibOptional('gates.mjs');
    if (gatesLib?.runGates) {
      // Build ctx with extra slice-scope-specific fields.
      const baseCtx = {
        repoRoot,
        paths,
        spine,
        projections,
        project: () => projections.project(repoRoot),
        sliceId,
        touchedPaths,
      };
      const result = await gatesLib.runGates(repoRoot, {
        onlyId: 'slice-scope',
        emitEvents: true,
        ctx: baseCtx,
      });
      if (result.summary.fail > 0) {
        const failRun = result.runs.find((r) => !r.ok);
        console.error(`slice-stop refused by slice-scope gate: ${failRun?.message || 'see GATE_RAN event'}`);
        process.exit(1);
      }
    }
  }

  // completion-claim (v1.88.0, roadmap #3): the hedged-claim-without-proof
  // check fires at EVERY slice-stop — unlike slice-scope it needs no declared
  // slice id. Warn-tier: it SURFACES, never blocks the stop (the failOn-ladder
  // discipline: at least a quarter of own-repo data before any promotion to
  // fail). A check error never breaks the stop ritual.
  try {
    const ccGates = await loadLibOptional('gates.mjs');
    if (ccGates?.runGates) {
      const cc = await ccGates.runGates(repoRoot, {
        onlyId: 'completion-claim',
        emitEvents: true,
        ctx: { repoRoot, paths, spine, projections, project: () => projections.project(repoRoot) },
      });
      const run = cc.runs[0];
      if (run && !run.ok) console.error(`  completion-claim: ${run.message}`);
    }
  } catch {}

  // v1.1.0 Phase 5 — optional --triggered-by plan:<id> records lineage on
  // the slice-stop and triggers plan auto-revision.
  let triggered_by = null;
  if (typeof flags['triggered-by'] === 'string' && flags['triggered-by']) {
    const tb = flags['triggered-by'];
    const m = /^plan:(.+)$/.exec(tb);
    if (m) {
      triggered_by = { planId: m[1] };
    } else if (typeof tb === 'string') {
      triggered_by = { ref: tb };
    }
  }

  // v1.17.0 — two deterministic checks over the slice's paths, both best-effort
  // and WARN-only (they record + print, never break the stop):
  //   risk         — classify change-risk so it lives on the spine and the
  //                  review-trigger can escalate on auth/secret/schema/broad edits.
  //   deliverables — verify each declared --targets file actually exists (catch
  //                  a worker reporting a deliverable it never produced).
  let risk = null;
  let deliverables = null;
  try {
    const gitTouched = (flags['no-git-diff'] === true) ? null : await gitTouchedPaths(repoRoot);
    const riskLib = await loadLibOptional('risk-assess.mjs');
    if (riskLib?.assessRisk) {
      const basis = touchedPaths.length ? touchedPaths : (gitTouched || []);
      risk = riskLib.assessRisk(basis);
    }
    const delivLib = await loadLibOptional('deliverables.mjs');
    if (delivLib?.verifyDeliverables) {
      deliverables = await delivLib.verifyDeliverables({ repoRoot, targets: csv(flags.targets), gitTouched });
    }
  } catch {}

  const ev = await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.SLICE_STOP,
    actor: sessionId,
    lane: flags.lane || null,
    triggered_by,
    data: {
      summary,
      action: flags.action || null,
      targets: csv(flags.targets),
      paths: csv(flags.paths),
      gates: csv(flags.gates),
      learnings: ssv(flags.learnings),
      next: ssv(flags.next),
      reason: flags.reason || null,
      risk,
      deliverables
    }
  });

  // Surface both checks immediately so the operator sees them without a round-trip.
  if (risk && risk.level !== 'none' && risk.level !== 'low') {
    const note = risk.signals.length ? ` — ${risk.signals.join('; ')}` : '';
    console.error(`  risk: ${risk.level}${note}`);
  }
  if (deliverables && deliverables.missing.length) {
    console.error(`  deliverables: ${deliverables.missing.length} declared target(s) not found — ${deliverables.missing.join(', ')}`);
  }

  // Auto-revise the named plan if triggered_by carries a planId.
  if (triggered_by && triggered_by.planId) {
    try {
      const plans = await loadLibOptional('plans.mjs');
      if (plans) await plans.maybeAutoReviseFromSliceStop(repoRoot, ev);
    } catch (err) {
      console.error(`  plan auto-revise failed (non-fatal): ${err.message}`);
    }
  }

  console.log(`slice-stop  ${ev.id}  [${ev.lane || '—'}]`);
  console.log(`  ${summary}`);
  if (ev.data.next.length) {
    console.log(`  next:`);
    for (const n of ev.data.next) console.log(`    - ${n}`);
  }

  // Hindsight: auto-extract facts from this slice-stop into .maddu/memory.ndjson.
  try {
    const added = await hindsight.extractEvent(repoRoot, ev);
    if (added > 0) console.log(`  hindsight: ${added} fact(s) → .maddu/state/memory.ndjson`);
  } catch (err) {
    console.error(`  hindsight failed (non-fatal): ${err.message}`);
  }

  // Rule-#9 gauntlet (shared): a single allowlist read for every auto-trigger
  // below. Prefers the gauntlet helper; falls back to an inline read if an
  // older install predates it. Either way it fails CLOSED on an unreadable file.
  const triggersPath = join(repoRoot, '.maddu', 'config', 'triggers.json');
  const gauntlet = await loadLibOptional('gauntlet.mjs');
  const allow = gauntlet
    ? (id) => gauntlet.isAllowed(repoRoot, id)
    : async (id) => { try { return (((JSON.parse(await readFile(triggersPath, 'utf8')).allowed)) || []).includes(id); } catch { return false; } };

  // v1.81.0 (roadmap #5 / F2) — the autonomous skill-candidate detector was
  // RETIRED. It emitted SKILL_CANDIDATE_DETECTED from recurring slice-stop
  // tag-sets, but those are generic ("commit, test"), not reusable recipes:
  // 0 conversion across ~50 sessions / 4 fleet projects. Auto-knowledge-capture
  // is `maddu learn` (failure→success tool-call pairs → concrete corrections);
  // skills are now HAND-AUTHORED only (`maddu skill create` / `from-slice`). The
  // `funnel-integrity` gate keeps this auto-trigger from being silently re-wired.

  // v1.7.0 (invocation-logic) — auto-funnel the supply-chain trust audit:
  // after a slice-stop, if the dependency surface changed since the last
  // audit, run a fresh `trust audit`. This wires the missing WHEN so
  // freshness/pin violations on newly-added deps get caught in the natural
  // flow instead of only on a manual audit. Same rule-#9 gauntlet as
  // skill-candidate: gated on the `slice-stop:trust-audit` allowlist entry,
  // every emission carries triggered_by + a TRIGGER_FIRED record, cooldown
  // respected inside the trigger. Best-effort; never breaks the slice-stop.
  try {
    if (await allow('slice-stop:trust-audit')) {
      const tt = await loadLibOptional('trust-trigger.mjs');
      if (tt) {
        const res = await tt.auditIfDepsChanged(repoRoot, sessionId, {
          kind: 'slice-stop', id: 'trust-audit', fired_at: ev.ts,
        });
        if (res.ran) {
          const v = res.violations;
          console.log(`  trust audit (deps changed): ${res.audited} dep(s) audited${v ? `, ${v} violation(s) → \`maddu trust report\`` : ', clean'}`);
        }
      }
    }
  } catch (err) {
    console.error(`  trust-audit trigger failed (non-fatal): ${err.message}`);
  }

  // v1.10.0 (invocation-logic 2) — auto-set the curated handoff: after a
  // slice-stop, derive a "▶ RESUME HERE" narrative (summary + next steps) and
  // append HANDOFF_SET so `maddu orient` is never empty. Same rule-#9 gauntlet:
  // gated on `slice-stop:auto-handoff`, carries triggered_by + TRIGGER_FIRED.
  // Best-effort; never breaks the slice-stop.
  try {
    if (await allow('slice-stop:auto-handoff')) {
      const ht = await loadLibOptional('handoff-trigger.mjs');
      if (ht) {
        const res = await ht.maybeSetHandoff(repoRoot, ev, sessionId, {
          kind: 'slice-stop', id: 'auto-handoff', fired_at: ev.ts,
        });
        if (res.ran) console.log(`  handoff: updated → \`maddu orient\``);
      }
    }
  } catch (err) {
    console.error(`  auto-handoff trigger failed (non-fatal): ${err.message}`);
  }

  // v1.10.0 (invocation-logic 2) — auto-review: after a slice-stop, run the
  // configured reviewer over this slice. Graceful no-op when no `kind:'reviewer'`
  // runtime exists (so on-by-default is safe — it only spawns when an operator
  // opted in). Cooldown-guarded. Same rule-#9 gauntlet: gated on
  // `slice-stop:auto-review`, carries triggered_by + TRIGGER_FIRED. Best-effort.
  try {
    if (await allow('slice-stop:auto-review')) {
      const rt = await loadLibOptional('review-trigger.mjs');
      if (rt) {
        const res = await rt.maybeReviewSliceStop(repoRoot, ev, sessionId, {
          kind: 'slice-stop', id: 'auto-review', fired_at: ev.ts,
        });
        if (res.ran) console.log(`  auto-review: ${res.verdict}${res.findingsCount ? `, ${res.findingsCount} finding(s)` : ''} → \`maddu review status\``);
      }
    }
  } catch (err) {
    console.error(`  auto-review trigger failed (non-fatal): ${err.message}`);
  }

  // Focus Director floor — a slice-stop is a turn boundary too, so tag the
  // trajectory vs the declared goal here in case heartbeats were sparse. Same
  // rule-#9 gauntlet: gated on `slice-stop:focus-director`, carries triggered_by.
  // Deterministic + cheap (no LLM); best-effort.
  try {
    if (await allow('slice-stop:focus-director')) {
      const ft = await loadLibOptional('focus-trigger.mjs');
      if (ft) {
        const res = await ft.maybeTagFocus(repoRoot, ev, sessionId, { kind: 'slice-stop', id: 'focus-director', fired_at: ev.ts });
        if (res.tagged) console.log(`  focus: ${res.tag}${res.flagged ? ` → DRIFT FLAGGED (${res.runs} turns off-axis) → \`maddu orient\`` : ''}`);
      }
    }
  } catch (err) {
    console.error(`  focus-director trigger failed (non-fatal): ${err.message}`);
  }
}
