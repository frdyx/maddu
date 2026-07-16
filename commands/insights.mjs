// `maddu insights` — cross-project usage insights (v1.4.0).
//
// The empirical counterpart to `maddu audit`. Where audit checks the FRAMEWORK
// source for coherence-rot (can a type fire? does a verb have a slash?),
// insights reads REAL `.maddu/events` spines across every registered workspace
// and reports what is actually UTILIZED — load-bearing vs occasional vs
// single-project vs DEAD (defined+reachable but never fired anywhere).
//
// Discovery = the workspace registry (`maddu workspace add`). Per-project
// presence is the primary weight, so one high-volume project can't masquerade
// as broad utilization.
//
// Subcommands (positional):
//   (bare)    full report — projects + event-type matrix + dead summary
//   events    event-type utilization matrix only
//   dead      just the kill-list: defined types that never fired anywhere
//   verbs     verb invocation behavior (scans ~/.claude transcripts)
//   slashes   slash-command usage (scans ~/.claude transcripts)
//
// Flags:
//   --json    machine-readable report (feeds a future cockpit Insights route)
//   --no-transcripts   skip the transcript scan in the bare report
//
// Read-only: scans spines + transcripts, writes nothing. Exit 0 always (it is
// a report, not a gate); exit 2 on usage error.

import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { loadLib, loadLibOptional } from './_libroot.mjs';

const ANSI = {
  lb: '\x1b[32m', occ: '\x1b[36m', sp: '\x1b[33m', dormant: '\x1b[35m', dead: '\x1b[31m',
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
};
const CLS_COLOR = {
  'load-bearing': ANSI.lb, occasional: ANSI.occ, 'single-project': ANSI.sp, dormant: ANSI.dormant, 'imported-only': ANSI.sp, dead: ANSI.dead,
};
const ROLES = new Set(['consumer', 'fixture', 'self']);
function clsTag(cls) { return `${CLS_COLOR[cls] || ''}${cls}${ANSI.reset}`; }

const SUBCOMMANDS = new Set(['events', 'dead', 'verbs', 'slashes', 'lanes']);

async function loadWorkspaces() {
  const ws = await loadLib('workspaces.mjs');
  const reg = await ws.readRegistry();
  return { reg, registryPath: ws.registryPath() };
}

function extractCommandSet(binSource) {
  const m = binSource.match(/const\s+COMMANDS\s*=\s*(\[[^\]]+\])/);
  if (!m) return new Set();
  try { return new Set(new Function(`return ${m[1]}`)()); } catch { return new Set(); }
}

export default async function insights(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: maddu insights [events|dead|verbs|slashes|lanes] [--json] [--no-transcripts] [--include-imported] [--role consumer|fixture|self]');
    return;
  }
  const { flags, positional } = parseFlags(argv);
  const sub = positional[0] || null;
  const json = !!flags.json;
  if (sub && !SUBCOMMANDS.has(sub)) {
    console.error(`maddu insights: unknown subcommand "${sub}". One of: ${[...SUBCOMMANDS].join(', ')} (or none for all).`);
    process.exit(2);
  }
  const includeImported = !!flags['include-imported'];
  const roleFilter = flags.role ? String(flags.role) : null;
  if (roleFilter && !ROLES.has(roleFilter)) {
    console.error(`maddu insights: unknown --role "${roleFilter}". One of: ${[...ROLES].join(', ')}.`);
    process.exit(2);
  }

  const lib = await loadLibOptional('insights.mjs');
  if (!lib) {
    console.error('maddu insights: runtime lib not found. Run `maddu upgrade` to get v1.4.0+.');
    process.exit(2);
  }
  const spineLib = await loadLib('spine.mjs');
  const { reg, registryPath } = await loadWorkspaces();

  const workspaces = reg.workspaces || [];

  // `insights lanes` (Tier 4a) — the audit's dead-catalog/ad-hoc table, per
  // repo: lanes defined vs distinct ids actually claimed, dead catalog
  // placements, ad-hoc share. Early branch: it needs no event matrix or
  // transcript scan.
  if (sub === 'lanes') {
    const obs = await loadLibOptional('lane-observability.mjs');
    if (!obs?.laneReport) {
      console.error('maddu insights lanes: runtime lib not found. Run `maddu upgrade` to get v1.103.0+.');
      process.exit(2);
    }
    const rows = [];
    for (const w of workspaces) {
      if (!w?.path) continue;
      const role = lib.workspaceRole ? await lib.workspaceRole(w) : (w.role || 'consumer');
      if (roleFilter && role !== roleFilter) continue;
      let r;
      try { r = await obs.laneReport(w.path); } catch { continue; }
      // Skip only genuinely lane-less repos (catalog MISSING — never had
      // lanes — with no claims and a clean scan). A malformed OR unreadable
      // catalog and an incomplete spine scan are failures the fleet table
      // must surface, never silently hide (Codex rounds 3+4).
      if (!r.catalog.length && !r.adHoc.length && r.catalogState === 'missing' && r.claimsComplete) continue;
      const claimedCatalog = r.catalog.filter((l) => l.claims > 0).length;
      const realAdHoc = r.adHoc.filter((a) => !a.ephemeral);
      rows.push({
        name: w.label || w.id || w.path, role,
        defined: r.catalog.length,
        claimedCatalog,
        deadCatalog: r.unusedCatalog.length,
        adHoc: realAdHoc.length,
        ephemeral: r.adHoc.length - realAdHoc.length,
        suggestions: r.suggestions.map((s) => s.id),
        totalClaims: r.totalClaims,
        catalogState: r.catalogState || (r.catalogReadable ? 'ok' : 'malformed'),
        claimsComplete: !!r.claimsComplete,
      });
    }
    rows.sort((a, b) => b.totalClaims - a.totalClaims || a.name.localeCompare(b.name));
    if (json) {
      process.stdout.write(JSON.stringify({ registryPath, filters: { role: roleFilter }, lanes: rows }, null, 2) + '\n');
      return;
    }
    const scope = roleFilter ? ` · role=${roleFilter}` : '';
    console.log(`${ANSI.bold}Máddu insights — lanes${ANSI.reset}  ${ANSI.dim}catalog vs observed claims (lifetime, native only${scope})${ANSI.reset}`);
    // Aggregates sum ONLY healthy-catalog rows — a broken catalog makes the
    // catalog-vs-ad-hoc split unknowable, so its counts must not ride the
    // headline while the row itself says "unknowable" (Codex round 5).
    const okRows = rows.filter((r) => r.catalogState === 'ok');
    const broken = rows.length - okRows.length;
    const dead = okRows.reduce((a, r) => a + r.deadCatalog, 0);
    const defined = okRows.reduce((a, r) => a + r.defined, 0);
    const adhocTotal = okRows.reduce((a, r) => a + r.adHoc, 0);
    console.log(`  ${ANSI.dim}${defined} catalog placements · ${dead} never claimed (${defined ? Math.round((dead / defined) * 100) : 0}%) · ${adhocTotal} distinct ad-hoc ids in real use${broken ? ` · ${broken} repo(s) with broken catalogs excluded from these sums` : ''}${ANSI.reset}\n`);
    for (const r of rows) {
      const roleTag = r.role !== 'consumer' ? ` ${ANSI.dim}[${r.role}]${ANSI.reset}` : '';
      // A broken catalog makes the catalog-vs-ad-hoc CLASSIFICATION
      // unknowable — render the failure, never a table row that presents
      // claimed ids as classified ad-hoc/suggestions (Codex round 4).
      if (r.catalogState !== 'ok') {
        console.log(`    ${r.name.padEnd(18)} ${ANSI.dead}catalog ${r.catalogState.toUpperCase()}${ANSI.reset} — lane classification unknowable ${ANSI.dim}(${r.totalClaims} lifetime claim(s) observed; fix .maddu/lanes/catalog.json)${ANSI.reset}${roleTag}`);
        continue;
      }
      const sug = r.suggestions.length ? `  ${ANSI.lb}suggest: ${r.suggestions.join(', ')}${ANSI.reset}` : '';
      const inc = !r.claimsComplete ? `  ${ANSI.sp}(incomplete spine scan — counts are a floor; dead withheld)${ANSI.reset}` : '';
      console.log(`    ${r.name.padEnd(18)} ${String(r.defined).padStart(3)} defined · ${String(r.claimedCatalog).padStart(3)} claimed · ${ANSI.dead}${String(r.deadCatalog).padStart(3)} dead${ANSI.reset} · ${String(r.adHoc).padStart(3)} ad-hoc${r.ephemeral ? ` ${ANSI.dim}(+${r.ephemeral} ephemeral)${ANSI.reset}` : ''}${roleTag}${sug}${inc}`);
    }
    console.log(`\n  ${ANSI.dim}adopt observed reality per repo: maddu lane suggest (inside the repo)${ANSI.reset}`);
    return;
  }
  const definedSet = await lib.definedEventTypes(spineLib);
  let projects = await lib.harvestSpines(workspaces, { includeImported });
  if (roleFilter && lib.workspaceRole) projects = projects.filter((p) => p.role === roleFilter);

  // Plugin-owned event types (manifests are bundled, identical across installs)
  // so a would-be-dead type owned by a plugin reads as dormant, not dead.
  let pluginOwners = new Map();
  try {
    const pluginsLib = await loadLibOptional('plugins.mjs');
    if (pluginsLib?.allPluginEventOwners) {
      const ownerRoot = (await findRepoRoot(process.cwd())) || workspaces[0]?.path;
      if (ownerRoot) pluginOwners = await pluginsLib.allPluginEventOwners(ownerRoot);
    }
  } catch {}
  const matrix = lib.buildMatrix(projects, definedSet, pluginOwners);

  // Invocation receipts (Tier 2) — the EXECUTION signal for verbs, harvested
  // from each workspace's .maddu/state/invocation-receipts.ndjson. Rendered
  // FIRST in the verbs report; transcript mentions are demoted to a labeled
  // legacy signal. Role-filtered like projects (harvestReceipts resolves the
  // role per workspace).
  let receipts = null;
  if ((sub === 'verbs' || !sub) && lib.harvestReceipts) {
    try {
      receipts = await lib.harvestReceipts(workspaces);
      if (roleFilter) receipts = receipts.filter((r) => r.role === roleFilter);
    } catch {}
  }

  // Transcript scan (verbs/slashes) — only when needed.
  const wantTranscripts = (sub === 'verbs' || sub === 'slashes' || (!sub && !flags['no-transcripts']));
  let transcripts = null, commandSet = new Set();
  if (wantTranscripts) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const binPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'maddu.mjs');
      commandSet = extractCommandSet(await readFile(binPath, 'utf8'));
    } catch {}
    // --role scopes the transcript scan to the matching workspaces' session
    // dirs (path-encoded, case-insensitive) — without this, `--role consumer`
    // verb counts would still include framework self-dev sessions. Derived
    // from the REGISTRY (role-checked per workspace), not from harvested
    // spines, so a registered repo whose .maddu/events is absent still
    // contributes its transcript dirs.
    let dirAllow = null;
    if (roleFilter && lib.transcriptDirName && lib.workspaceRole) {
      dirAllow = new Set();
      for (const w of workspaces) {
        if (w?.path && (await lib.workspaceRole(w)) === roleFilter) dirAllow.add(lib.transcriptDirName(w.path));
      }
    }
    transcripts = await lib.scanTranscripts(commandSet, { dirAllow });
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      registryPath,
      filters: { role: roleFilter, includeImported },
      projects: projects.map((p) => ({
        name: p.name, role: p.role || null, total: p.total, distinctTypes: p.counts.size,
        importedTotal: p.importedTotal || 0,
        installedVersion: p.installedVersion, versionSource: p.versionSource || 'unknown',
        lastTs: p.lastTs,
        gateOutcomes: p.gateOutcomes || null,
      })),
      // Receipt-backed verb executions — an OBSERVED-WINDOW signal, never
      // lifetime totals: window + dropped ride every entry by contract.
      receipts: receipts && receipts.map((r) => ({
        name: r.name, role: r.role, count: r.count, failures: r.failures,
        dropped: r.dropped, window: r.window, verbs: r.verbs,
      })),
      eventMatrix: {
        definedTotal: matrix.definedTotal, everFired: matrix.everFired, counts: matrix.counts,
        undeclaredCount: matrix.undeclaredCount || 0,
        partition: matrix.partition ? {
          complete: matrix.partition.complete, sum: matrix.partition.sum,
          bucketSizes: Object.fromEntries(Object.entries(matrix.partition.buckets).map(([k, v]) => [k, v.length])),
          buckets: matrix.partition.buckets,
        } : null,
        rows: matrix.rows, deadDefined: matrix.deadDefined,
        dormantByDesign: matrix.dormantByDesign || [],
      },
      transcripts: transcripts && {
        filesScanned: transcripts.filesScanned,
        verbs: [...transcripts.verbCount.entries()].map(([v, c]) => ({ verb: v, count: c, dirs: transcripts.verbDirs.get(v)?.size || 0 })),
        slashes: [...transcripts.slashCount.entries()].map(([s, c]) => ({ slash: s, count: c })),
      },
    }, null, 2) + '\n');
    return;
  }

  // ── Human report ──────────────────────────────────────────────────────────
  console.log(`${ANSI.bold}Máddu insights${ANSI.reset}  cross-project usage  ${ANSI.dim}registry: ${registryPath}${ANSI.reset}`);
  if (workspaces.length === 0) {
    console.log('\n  (no workspaces registered — `maddu workspace add <path>` to register projects to analyze)');
    return;
  }
  if (projects.length === 0) {
    console.log(`\n  (${workspaces.length} workspace(s) registered, but none have a .maddu spine yet)`);
    return;
  }

  if (!sub || sub === 'events' || sub === 'dead') {
    const scope = roleFilter ? ` · role=${roleFilter}` : '';
    console.log(`\n  ${ANSI.bold}Projects (${matrix.n} with a spine${scope})${ANSI.reset}${includeImported ? `  ${ANSI.dim}(imported backfill INCLUDED in totals)${ANSI.reset}` : ''}`);
    for (const p of [...projects].sort((a, b) => b.total - a.total)) {
      const imp = p.importedTotal ? `  ${ANSI.dim}(+${p.importedTotal} imported)${ANSI.reset}` : '';
      const role = p.role && p.role !== 'consumer' ? ` ${ANSI.dim}[${p.role}]${ANSI.reset}` : '';
      console.log(`    ${p.name.padEnd(18)} ${String(p.total).padStart(7)} events  ${String(p.counts.size).padStart(3)} types  ${ANSI.dim}v${p.installedVersion || '?'} (${p.versionSource || 'unknown'}) · last ${p.lastTs?.slice(0, 10) || '?'}${ANSI.reset}${imp}${role}`);
    }
  }

  if (!sub || sub === 'events') {
    console.log(`\n  ${ANSI.bold}Event-type utilization${ANSI.reset}  ${ANSI.dim}defined ${matrix.definedTotal} · ever-fired ${matrix.everFired} · ${matrix.counts['load-bearing']} load-bearing / ${matrix.counts.occasional} occasional / ${matrix.counts['single-project']} single-project / ${matrix.counts.dormant} dormant / ${matrix.counts['imported-only']} imported-only / ${matrix.counts.dead} dead${ANSI.reset}`);
    // Exhaustive partition (Tier 1): every defined type in exactly one bucket.
    if (matrix.partition) {
      const b = matrix.partition.buckets;
      const eq = `${b.fired.length} fired + ${b['imported-only'].length} imported-only + ${b['dormant-by-design'].length} dormant-by-design + ${b['plugin-owned'].length} plugin-owned + ${b.dead.length} dead = ${matrix.partition.sum}/${matrix.definedTotal}`;
      const undecl = matrix.undeclaredCount ? ` · ${matrix.undeclaredCount} undeclared type(s) counted apart (spine drift, outside the defined partition)` : '';
      console.log(`  ${matrix.partition.complete ? ANSI.dim : ANSI.dead}partition: ${eq}${matrix.partition.complete ? '' : '  ← INCOMPLETE'}${undecl}${ANSI.reset}`);
    }
    for (const cls of ['load-bearing', 'occasional', 'single-project', 'dormant', 'imported-only']) {
      const items = matrix.rows.filter((r) => r.cls === cls);
      if (!items.length) continue;
      console.log(`\n    ${clsTag(cls)} (${items.length})`);
      for (const r of items) {
        const flag = r.undeclared ? `  ${ANSI.dead}[not in EVENT_TYPES]${ANSI.reset}`
          : (r.owner !== 'core' ? `  ${ANSI.dormant}[${r.owner}]${ANSI.reset}` : '');
        const imp = r.importedCount ? `  ${ANSI.dim}(+${r.importedCount} imported)${ANSI.reset}` : '';
        console.log(`      ${r.type.padEnd(32)} ${String(r.count).padStart(7)}×  ${r.projects}/${matrix.n} proj${imp}${flag}`);
      }
    }
  }

  if (!sub || sub === 'events') {
    // Gate OUTCOME discrimination (Tier 2): pass alone proves execution, not
    // discrimination — enumerate the non-pass states so "all green" is
    // distinguishable from "fail path never writes" (which the gate-fail-path
    // self-test proves separately, by forcing a failing gate in a fixture).
    const agg = { ok: 0, warn: 0, fail: 0, other: 0 };
    for (const p of projects) {
      for (const k of Object.keys(agg)) agg[k] += p.gateOutcomes?.[k] || 0;
    }
    if (agg.ok + agg.warn + agg.fail + agg.other > 0) {
      const failers = projects.filter((p) => (p.gateOutcomes?.fail || 0) > 0)
        .map((p) => `${p.name} ${p.gateOutcomes.fail}`).join(', ');
      console.log(`\n  ${ANSI.bold}Gate outcomes${ANSI.reset}  ${ANSI.dim}GATE_RAN status across projects (native): ${agg.ok} ok / ${agg.warn} warn / ${agg.fail} fail${agg.other ? ` / ${agg.other} other (pre-schema)` : ''}${failers ? `  · fails in: ${failers}` : ''}${ANSI.reset}`);
    }
  }

  if (!sub || sub === 'dead' || sub === 'events') {
    console.log(`\n  ${clsTag('dead')}  ${matrix.deadDefined.length}/${matrix.definedTotal} defined event types (core-owned) never fired in any registered project`);
    if (sub === 'dead' || !sub) {
      for (const t of matrix.deadDefined) console.log(`      ${ANSI.dim}${t}${ANSI.reset}`);
    }
    // v1.7.0 — dormant-by-design is insurance, not a gap. Listed apart so the
    // dead count above reads as genuine "nothing invokes it" work.
    const dbd = matrix.dormantByDesign || [];
    if (dbd.length) {
      console.log(`\n  ${ANSI.dormant}dormant-by-design${ANSI.reset}  ${dbd.length} type(s) fire only under a specific posture/edge (expected, not a gap)`);
      if (sub === 'dead' || !sub) {
        for (const t of dbd) {
          const reason = lib.DORMANT_BY_DESIGN?.get(t);
          console.log(`      ${ANSI.dim}${t.padEnd(32)} ${reason || ''}${ANSI.reset}`);
        }
      }
    }
  }

  if ((sub === 'verbs' || !sub) && receipts) {
    // Receipt-backed EXECUTIONS first (Tier 2). Every count is presented with
    // the window it covers + the dropped-line count — receipts are fail-open
    // and rotated, so they are an observed-window signal, never a lifetime
    // total. Workspaces with no corpus yet are an honest "no telemetry".
    const withReceipts = receipts.filter((r) => r.count > 0);
    const without = receipts.length - withReceipts.length;
    console.log(`\n  ${ANSI.bold}Verb executions${ANSI.reset}  ${ANSI.dim}(receipt-backed; observed window per workspace, not lifetime totals)${ANSI.reset}`);
    if (!withReceipts.length) {
      console.log(`      ${ANSI.dim}(no receipts yet — the corpus lands as installs upgrade to v1.101+ and run verbs)${ANSI.reset}`);
    }
    for (const r of withReceipts) {
      const win = r.window ? `${r.window.oldest.slice(0, 10)} → ${r.window.newest.slice(0, 10)}` : '?';
      console.log(`    ${r.name.padEnd(18)} ${String(r.count).padStart(6)} receipts  ${ANSI.dim}window ${win} · ${r.dropped} dropped · ${r.failures} failed${ANSI.reset}`);
      for (const v of r.verbs.slice(0, sub === 'verbs' ? 999 : 5)) {
        console.log(`      ${v.verb.padEnd(24)} ${String(v.count).padStart(5)}×${v.fail ? `  ${ANSI.dim}${v.fail} failed${ANSI.reset}` : ''}`);
      }
    }
    if (without > 0) console.log(`      ${ANSI.dim}(${without} workspace(s) report no receipts — pre-v1.101 installs write none)${ANSI.reset}`);
  }

  if ((sub === 'verbs' || !sub) && transcripts) {
    const scanScope = roleFilter ? `scoped to role=${roleFilter} workspaces` : 'includes framework self-dev';
    console.log(`\n  ${ANSI.bold}Verb mentions — legacy signal${ANSI.reset}  ${ANSI.dim}(${transcripts.filesScanned} transcript files; ${scanScope}; keyword mentions, NOT executions — prefer the receipt-backed table above)${ANSI.reset}`);
    const rows = [...transcripts.verbCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, sub === 'verbs' ? 999 : 15);
    for (const [v, c] of rows) {
      console.log(`      ${v.padEnd(14)} ${String(c).padStart(5)}×  ${ANSI.dim}${transcripts.verbDirs.get(v)?.size || 0} session-dir(s)${ANSI.reset}`);
    }
  }

  if ((sub === 'slashes' || !sub) && transcripts) {
    const slashScope = roleFilter ? `scoped to role=${roleFilter} workspaces` : 'includes framework self-dev';
    console.log(`\n  ${ANSI.bold}Slash usage${ANSI.reset}  ${ANSI.dim}(${transcripts.filesScanned} transcript files; ${slashScope}; mentions, not executions)${ANSI.reset}`);
    const rows = [...transcripts.slashCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, sub === 'slashes' ? 999 : 15);
    for (const [s, c] of rows) console.log(`      /${s.padEnd(24)} ${String(c).padStart(5)}×`);
  }

  console.log(`\n  ${ANSI.dim}Re-run after default-flow changes; watch the dead count shrink. See docs/audit/ for the standing analysis.${ANSI.reset}`);
}
