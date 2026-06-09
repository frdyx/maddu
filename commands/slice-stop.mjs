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

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat, readFile } from 'node:fs/promises';

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function csv(s) {
  if (!s || s === true) return [];
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}
function ssv(s) {
  if (!s || s === true) return [];
  return String(s).split(';').map((x) => x.trim()).filter(Boolean);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadGatesLib() {
  const candidates = [
    join(process.cwd(), 'maddu', 'runtime', 'lib', 'gates.mjs'),
    join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'gates.mjs'),
  ];
  for (const p of candidates) {
    try { await stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

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
  // v0.19.1 PR-B1: fall back to MADDU_SESSION_ID env when --session omitted.
  if (!flags.session || flags.session === true) flags.session = process.env.MADDU_SESSION_ID;
  const summary = requireFlag(flags, 'summary');
  const sessionId = requireFlag(flags, 'session');

  const { paths, spine, projections, hindsight } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

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
    const gatesLib = await loadGatesLib();
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
      reason: flags.reason || null
    }
  });

  // Auto-revise the named plan if triggered_by carries a planId.
  if (triggered_by && triggered_by.planId) {
    try {
      const candidates = [
        join(process.cwd(), 'maddu', 'runtime', 'lib', 'plans.mjs'),
        join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'plans.mjs'),
      ];
      for (const c of candidates) {
        try { await stat(c); const plans = await import(pathToFileURL(c).href); await plans.maybeAutoReviseFromSliceStop(repoRoot, ev); break; } catch {}
      }
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

  // v1.4.0 (Bucket C) — auto-funnel the skills system: after each slice-stop,
  // detect reusable patterns and emit SKILL_CANDIDATE_DETECTED for any that
  // crossed threshold. This is what makes the skills funnel fire without the
  // agent remembering. Rule-#9 gauntlet: only fires when the trigger id is in
  // the .maddu/config/triggers.json allowlist, and each emit carries
  // triggered_by provenance. Best-effort; never breaks the slice-stop.
  try {
    const triggersPath = join(repoRoot, '.maddu', 'config', 'triggers.json');
    let allowed = [];
    try { allowed = (JSON.parse(await readFile(triggersPath, 'utf8')).allowed) || []; } catch {}
    if (allowed.includes('slice-stop:skill-candidate')) {
      const candPaths = [
        join(process.cwd(), 'maddu', 'runtime', 'lib', 'skill-candidates.mjs'),
        join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'skill-candidates.mjs'),
      ];
      for (const c of candPaths) {
        try {
          await stat(c);
          const sc = await import(pathToFileURL(c).href);
          const emitted = await sc.emitFreshCandidates(repoRoot, sessionId, {
            kind: 'slice-stop', id: 'skill-candidate', fired_at: ev.ts,
          });
          if (emitted.length) console.log(`  skill candidate(s): ${emitted.length} detected → review with \`maddu skill candidates\``);
          break;
        } catch {}
      }
    }
  } catch (err) {
    console.error(`  skill-candidate detection failed (non-fatal): ${err.message}`);
  }

  // v1.7.0 (invocation-logic) — auto-funnel the supply-chain trust audit:
  // after a slice-stop, if the dependency surface changed since the last
  // audit, run a fresh `trust audit`. This wires the missing WHEN so
  // freshness/pin violations on newly-added deps get caught in the natural
  // flow instead of only on a manual audit. Same rule-#9 gauntlet as
  // skill-candidate: gated on the `slice-stop:trust-audit` allowlist entry,
  // every emission carries triggered_by + a TRIGGER_FIRED record, cooldown
  // respected inside the trigger. Best-effort; never breaks the slice-stop.
  try {
    const triggersPath = join(repoRoot, '.maddu', 'config', 'triggers.json');
    let allowed = [];
    try { allowed = (JSON.parse(await readFile(triggersPath, 'utf8')).allowed) || []; } catch {}
    if (allowed.includes('slice-stop:trust-audit')) {
      const candPaths = [
        join(process.cwd(), 'maddu', 'runtime', 'lib', 'trust-trigger.mjs'),
        join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'trust-trigger.mjs'),
      ];
      for (const c of candPaths) {
        try {
          await stat(c);
          const tt = await import(pathToFileURL(c).href);
          const res = await tt.auditIfDepsChanged(repoRoot, sessionId, {
            kind: 'slice-stop', id: 'trust-audit', fired_at: ev.ts,
          });
          if (res.ran) {
            const v = res.violations;
            console.log(`  trust audit (deps changed): ${res.audited} dep(s) audited${v ? `, ${v} violation(s) → \`maddu trust report\`` : ', clean'}`);
          }
          break;
        } catch {}
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
    const triggersPath = join(repoRoot, '.maddu', 'config', 'triggers.json');
    let allowed = [];
    try { allowed = (JSON.parse(await readFile(triggersPath, 'utf8')).allowed) || []; } catch {}
    if (allowed.includes('slice-stop:auto-handoff')) {
      const candPaths = [
        join(process.cwd(), 'maddu', 'runtime', 'lib', 'handoff-trigger.mjs'),
        join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'handoff-trigger.mjs'),
      ];
      for (const c of candPaths) {
        try {
          await stat(c);
          const ht = await import(pathToFileURL(c).href);
          const res = await ht.maybeSetHandoff(repoRoot, ev, sessionId, {
            kind: 'slice-stop', id: 'auto-handoff', fired_at: ev.ts,
          });
          if (res.ran) console.log(`  handoff: updated → \`maddu orient\``);
          break;
        } catch {}
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
    const triggersPath = join(repoRoot, '.maddu', 'config', 'triggers.json');
    let allowed = [];
    try { allowed = (JSON.parse(await readFile(triggersPath, 'utf8')).allowed) || []; } catch {}
    if (allowed.includes('slice-stop:auto-review')) {
      const candPaths = [
        join(process.cwd(), 'maddu', 'runtime', 'lib', 'review-trigger.mjs'),
        join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'review-trigger.mjs'),
      ];
      for (const c of candPaths) {
        try {
          await stat(c);
          const rt = await import(pathToFileURL(c).href);
          const res = await rt.maybeReviewSliceStop(repoRoot, ev, sessionId, {
            kind: 'slice-stop', id: 'auto-review', fired_at: ev.ts,
          });
          if (res.ran) console.log(`  auto-review: ${res.verdict}${res.findingsCount ? `, ${res.findingsCount} finding(s)` : ''} → \`maddu review status\``);
          break;
        } catch {}
      }
    }
  } catch (err) {
    console.error(`  auto-review trigger failed (non-fatal): ${err.message}`);
  }
}
