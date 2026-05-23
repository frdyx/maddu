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
import { stat } from 'node:fs/promises';

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
  const touchedPaths = [...csv(flags.targets), ...csv(flags.paths)];
  if (sliceId) {
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
}
