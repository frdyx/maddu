// `maddu experience` — the experience ledger (EXP phase 1).
//
// A read-only view of the spine as normalized experience steps grouped into
// session trajectories (design: docs/research/exp-experience-protocol-design.md).
// Pure projection — reads .maddu/events, writes NOTHING, mints NOTHING (step
// ids are source event ids), so two runs over the same spine are identical.
//
// Subcommands (positional):
//   (bare) | list   trajectory manifest — id, label, span, step counts
//   show <id>       one trajectory's steps (or "env" for ambient steps)
//   stats           totals, per-role/kind counts, unmapped types, absent axes
//   export          governed ATDP artifact (--format atdp --out <path>
//                   [--since <id>] [--until <id>]) — refuse-on-hit secret
//                   gate (no skip flag), repo-confined, deterministic
//
// Flags:
//   --json          machine-readable output
//   --lane <id>     (show) filter steps to one lane without re-grouping
//   --limit <n>     (show) last n steps (default 50, 0 = all)
//
// Exit: 0 ok, 1 trajectory not found, 2 usage error.

import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = {
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
  ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', accent: '\x1b[35m',
};

function fmtTs(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

const ROLE_TONE = { action: ANSI.accent, outcome: ANSI.ok, observation: ANSI.dim, state: ANSI.dim, signal: ANSI.warn };

export default async function experience(argv) {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;
  const { flags, positional } = parseFlags(rest);

  if (!['list', 'show', 'stats', 'export'].includes(sub)) {
    console.error('Usage: maddu experience [list | show <trajectoryId> [--lane <id>] [--limit <n>] | stats | export --format atdp --out <path> [--since <eventId>]] [--json]');
    process.exit(2);
  }

  const repoRoot = await findRepoRoot();
  const spine = await loadLib('spine.mjs');
  const expLib = await loadLib('experience.mjs');
  const events = await spine.readAll(repoRoot);

  // ── export (EXP phase 5): the governed ATDP artifact ─────────────────────
  // Refuse-on-hit secret gate (no skip flag), repo-confined --out,
  // deterministic output (no clock). See lib/experience-export.mjs for the
  // full posture. 5.2 decision: exports are answered READ-TIME (re-running
  // the export IS the audit — deterministic bytes given the same range); no
  // EXPERIENCE_EXPORTED event type is minted (contract policy §10, default NO).
  if (sub === 'export') {
    const { basename, dirname, isAbsolute, join: joinPath, resolve, sep } = await import('node:path');
    const { readFile, realpath, rename, writeFile } = await import('node:fs/promises');
    // Unknown flags are hard usage errors on THIS surface — a caller reaching
    // for --force/--skip must hear "no such flag", not have it silently
    // ignored while the gate's behavior is misread.
    const KNOWN_FLAGS = ['format', 'out', 'since', 'until', 'json'];
    for (const k of Object.keys(flags)) {
      if (!KNOWN_FLAGS.includes(k)) {
        console.error(`experience export: unknown flag --${k} (the secret gate has no skip flag; supported: ${KNOWN_FLAGS.map((f) => '--' + f).join(' ')})`);
        process.exit(2);
      }
    }
    if (flags.format !== 'atdp') {
      console.error('experience export: --format atdp is required (the only supported format)');
      process.exit(2);
    }
    const outFlag = flags.out;
    if (!outFlag || outFlag === true) {
      console.error('Usage: maddu experience export --format atdp --out <path-inside-repo> [--since <eventId>] [--until <eventId>] [--json]');
      process.exit(2);
    }
    const exporter = await loadLib('experience-export.mjs');

    // --since strictly after / --until up to and including <eventId>; an
    // unknown id is a usage error (the `export --otel --since` discipline).
    // --until keeps a past export reproducible after the spine grows.
    const sinceId = flags.since && flags.since !== true ? String(flags.since) : null;
    const untilId = flags.until && flags.until !== true ? String(flags.until) : null;
    const { selected, unknown } = exporter.selectRange(events, sinceId, untilId);
    if (selected === null) {
      console.error(`experience export: --${unknown} event "${unknown === 'since' ? sinceId : untilId}" not found on the spine`);
      process.exit(2);
    }

    // Repo confinement: the resolved output path must live INSIDE the repo
    // (realpath on the existing parent dir defeats .. and symlink escapes).
    const outAbs = isAbsolute(String(outFlag)) ? String(outFlag) : resolve(repoRoot, String(outFlag));
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    let realOut = null, realRoot = null;
    try {
      realRoot = await realpath(repoRoot);
      // Resolve the target itself when it exists (a FILE symlink must count
      // as its destination, not its name); otherwise real parent + basename.
      try { realOut = await realpath(outAbs); }
      catch { realOut = joinPath(await realpath(dirname(outAbs)), basename(outAbs)); }
    } catch {
      realOut = null; // parent doesn't exist → refuse rather than guess
    }
    const confined = realOut !== null && norm(realOut).startsWith(norm(realRoot) + sep);
    if (!confined) {
      console.error(`experience export: refused — --out must resolve to an EXISTING directory inside the repo (${repoRoot}); an export is a sharing boundary and this command never writes outside it.`);
      process.exit(1);
    }
    // Never let the artifact overwrite framework state: .maddu/ (the spine
    // lives there), maddu/ (the runtime), or maddu.json. An export writes a
    // NEW artifact, not framework bytes. The check runs on the REALPATH-
    // resolved target — same basis as confinement — so an in-repo symlink
    // (e.g. link → .maddu/events) cannot smuggle the write past the list.
    {
      const rel = norm(realOut).slice(norm(realRoot).length + 1).replace(/\\/g, '/');
      if (rel.startsWith('.maddu/') || rel.startsWith('maddu/') || rel === 'maddu.json' || rel === '.maddu' || rel === 'maddu') {
        console.error('experience export: refused — --out must not target .maddu/, maddu/, or maddu.json (framework state is never an export destination).');
        process.exit(1);
      }
    }
    // Never silently clobber a file that is not itself an ATDP artifact
    // (a fat-fingered `--out package.json` must refuse). Overwriting a
    // PREVIOUS export in place is allowed — that is the deterministic re-run.
    {
      let existing = null;
      try { existing = await readFile(outAbs, 'utf8'); } catch { existing = null; }
      if (existing !== null) {
        let isAtdp = false;
        try { isAtdp = JSON.parse(existing)?.manifest?.format === 'atdp'; } catch { isAtdp = false; }
        if (!isAtdp) {
          console.error(`experience export: refused — ${outAbs} exists and is not an ATDP artifact; this command never overwrites other files. Pick a new path (or delete the file yourself first).`);
          process.exit(1);
        }
      }
    }

    // The mandatory secret gate: refuse-on-hit, name the offenders, no file.
    const hits = exporter.scanSelectedEvents(selected);
    if (hits.length) {
      console.error(`${ANSI.fail}Refused:${ANSI.reset} ${hits.length} selected event(s) carry secret-shaped values — no export written. There is no flag to skip this gate.`);
      for (const h of hits.slice(0, 20)) console.error(`  ${ANSI.dim}${h.id}  (${(h.patternTypes || []).join(', ')})${ANSI.reset}`);
      console.error(`${ANSI.dim}Redact at the source (rotation for anything already committed), then re-run.${ANSI.reset}`);
      process.exit(1);
    }

    const expSel = expLib.deriveExperience(selected);
    let replicaId = null;
    try {
      const core = await loadLib('spine-append-core.mjs');
      replicaId = await core.readActiveReplicaId(repoRoot);
    } catch { replicaId = null; }
    const doc = exporter.buildAtdp({
      events: selected,
      experience: expSel,
      sinceId,
      provenance: { repo: basename(repoRoot), replicaId },
    });
    // Write-then-rename: a mid-write failure never leaves a truncated
    // artifact at the destination (the temp sibling passed the same
    // confinement — same directory, same realpath basis).
    const tmpOut = outAbs + '.tmp';
    await writeFile(tmpOut, JSON.stringify(doc, null, 2) + '\n');
    await rename(tmpOut, outAbs);
    const summary = {
      out: outAbs,
      events: selected.length,
      steps: doc.steps.length,
      trajectories: doc.trajectories.length,
      trainingEligibility: doc.manifest.trainingEligibility,
      redactionProfile: doc.manifest.redactionProfile,
    };
    if (flags.json) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return; }
    console.log(`${ANSI.ok}exported${ANSI.reset} ${selected.length} event(s) → ${outAbs}`);
    console.log(`  ${ANSI.dim}${doc.trajectories.length} trajectorie(s) · ${doc.steps.length} step(s) · trainingEligibility=false · ${doc.manifest.redactionProfile}${ANSI.reset}`);
    console.log(`  ${ANSI.dim}deterministic: re-running over the same range reproduces these bytes (that IS the audit)${ANSI.reset}`);
    return;
  }

  const exp = expLib.deriveExperience(events);

  if (sub === 'stats') {
    if (flags.json) { process.stdout.write(JSON.stringify(exp.stats, null, 2) + '\n'); return; }
    const s = exp.stats;
    console.log(`${ANSI.bold}Máddu experience — stats${ANSI.reset}  ${ANSI.dim}${repoRoot}${ANSI.reset}\n`);
    console.log(`  events ${s.eventCount} · steps ${s.stepCount} · trajectories ${s.trajectoryCount} ${ANSI.dim}(env steps: ${s.envStepCount})${ANSI.reset}`);
    console.log(`  by role:  ${Object.entries(s.byRole).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`  by kind:  ${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    const um = Object.entries(s.unmappedTypes);
    console.log(`  unmapped types (default rule applied): ${um.length ? um.map(([t, n]) => `${t}(${n})`).join(' · ') : ANSI.dim + '(none)' + ANSI.reset}`);
    const sk = Object.entries(s.signalsByKind || {});
    console.log(`  signals: ${s.signalCount || 0}${sk.length ? ` (${sk.map(([k, n]) => `${k} ${n}`).join(' · ')})` : ''}${s.unattachedTrailingGates ? ` · ${s.unattachedTrailingGates} trailing gate(s) unattached` : ''}`);
    if (s.signalsByAttachment && Object.keys(s.signalsByAttachment).length) {
      console.log(`  ${ANSI.dim}attachment: ${Object.entries(s.signalsByAttachment).map(([k, n]) => `${k} ${n}`).join(' · ')}${ANSI.reset}`);
    }
    console.log(`  ${ANSI.dim}absent by design (never inferred): ${s.absentByDesign.join(', ')}${ANSI.reset}`);
    return;
  }

  if (sub === 'show') {
    const id = positional[0];
    if (!id) { console.error('Usage: maddu experience show <trajectoryId> [--lane <id>] [--limit <n>] [--json]'); process.exit(2); }
    const traj = exp.trajectories.find((t) => t.trajectoryId === id);
    if (!traj) {
      console.error(`experience: no trajectory "${id}" ${ANSI.dim}(try \`maddu experience list\`)${ANSI.reset}`);
      process.exit(1);
    }
    let steps = exp.steps.filter((s) => s.trajectoryId === id);
    if (flags.lane) steps = steps.filter((s) => s.lane === flags.lane);
    let limit = 50;
    if (flags.limit !== undefined) {
      limit = Number(flags.limit);
      if (!Number.isFinite(limit) || limit < 0) {
        console.error(`experience: --limit must be a non-negative number (0 = all), got "${flags.limit}"`);
        process.exit(2);
      }
    }
    const shown = limit > 0 ? steps.slice(-limit) : steps;
    if (flags.json) { process.stdout.write(JSON.stringify({ trajectory: traj, steps: shown, totalSteps: steps.length }, null, 2) + '\n'); return; }
    // Honest span: linkage attribution is by session id, not time — a janitor
    // auto-close doesn't stop an agent from working, so steps can postdate
    // closedAt. Say so instead of implying activity stopped at the close.
    const postClose = traj.closedAt && traj.lastTs && traj.lastTs > traj.closedAt
      ? ` · last step ${fmtTs(traj.lastTs)} (after close)` : '';
    console.log(`${ANSI.bold}Máddu experience — ${traj.trajectoryId}${ANSI.reset}  ${ANSI.dim}${traj.label || ''}${ANSI.reset}`);
    console.log(`  ${ANSI.dim}${traj.status} · ${fmtTs(traj.openedAt)} → ${fmtTs(traj.closedAt)}${postClose} · ${steps.length} step(s)${flags.lane ? ` on lane ${flags.lane}` : ''}${shown.length < steps.length ? ` (last ${shown.length})` : ''}${ANSI.reset}\n`);
    for (const st of shown) {
      const tone = ROLE_TONE[st.role] || '';
      const what =
        st.action?.tool ? `${st.action.tool}${st.action.argv ? ' ' + st.action.argv.slice(0, 3).join(' ') : ''}` :
        st.observation?.summary ? st.observation.summary :
        st.state?.focus || st.state?.goal || st.state?.phase || '';
      // ok:null = no evidence either way (missing exit code) — render as
      // unknown, never as a failure claim.
      const verdict = st.outcome
        ? (st.outcome.ok === true ? `${ANSI.ok}ok${ANSI.reset}`
          : st.outcome.ok === false ? `${ANSI.fail}${st.outcome.status || 'fail'}${ANSI.reset}`
          : `${ANSI.dim}?${ANSI.reset}`)
        : '';
      const sigs = st.signals.length
        ? `  ${ANSI.warn}⚑${st.signals.length}${ANSI.reset}${ANSI.dim}(${st.signals.map((g) => `${g.kind}${g.verdict ? ':' + g.verdict : ''}`).join(',')})${ANSI.reset}`
        : '';
      console.log(`  ${ANSI.dim}${fmtTs(st.ts)}${ANSI.reset}  ${tone}${st.role.padEnd(11)}${ANSI.reset} ${st.kind.padEnd(10)} ${String(what).slice(0, 80)}${verdict ? '  ' + verdict : ''}${sigs}${st.lane ? `  ${ANSI.dim}[${st.lane}]${ANSI.reset}` : ''}`);
    }
    return;
  }

  // list (default)
  if (flags.json) { process.stdout.write(JSON.stringify({ schemaVersion: exp.schemaVersion, trajectories: exp.trajectories }, null, 2) + '\n'); return; }
  console.log(`${ANSI.bold}Máddu experience — trajectories${ANSI.reset}  ${ANSI.dim}${repoRoot}${ANSI.reset}\n`);
  if (!exp.trajectories.length) { console.log(`  ${ANSI.dim}(empty spine)${ANSI.reset}`); return; }
  for (const t of exp.trajectories) {
    const statusTone = t.status === 'open' ? ANSI.ok : t.status === 'ambient' ? ANSI.dim : ANSI.dim;
    console.log(`  ${ANSI.accent}${t.trajectoryId}${ANSI.reset}  ${statusTone}${t.status}${ANSI.reset}  ${ANSI.dim}${t.steps} step(s) · ${(t.lanes || []).join(',') || 'no lane'} · ${fmtTs(t.firstTs)} → ${fmtTs(t.lastTs)}${ANSI.reset}`);
    if (t.label) console.log(`    ${ANSI.dim}${t.label}${ANSI.reset}`);
  }
  console.log(`\n  ${ANSI.dim}maddu experience show <id> · maddu experience stats${ANSI.reset}`);
}
