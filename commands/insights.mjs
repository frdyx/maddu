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

const SUBCOMMANDS = new Set(['events', 'dead', 'verbs', 'slashes']);

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
    console.log('Usage: maddu insights [events|dead|verbs|slashes] [--json] [--no-transcripts] [--include-imported] [--role consumer|fixture|self]');
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
    // verb counts would still include framework self-dev sessions.
    let dirAllow = null;
    if (roleFilter && lib.transcriptDirName) {
      const allowedPaths = new Set(projects.map((p) => p.repoRoot));
      dirAllow = new Set(workspaces.filter((w) => w?.path && allowedPaths.has(w.path)).map((w) => lib.transcriptDirName(w.path)));
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
      })),
      eventMatrix: {
        definedTotal: matrix.definedTotal, everFired: matrix.everFired, counts: matrix.counts,
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

  if ((sub === 'verbs' || !sub) && transcripts) {
    const scanScope = roleFilter ? `scoped to role=${roleFilter} workspaces` : 'includes framework self-dev';
    console.log(`\n  ${ANSI.bold}Verb invocations${ANSI.reset}  ${ANSI.dim}(${transcripts.filesScanned} transcript files; ${scanScope}; mentions, not executions)${ANSI.reset}`);
    const rows = [...transcripts.verbCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, sub === 'verbs' ? 999 : 15);
    for (const [v, c] of rows) {
      console.log(`      ${v.padEnd(14)} ${String(c).padStart(5)}×  ${ANSI.dim}${transcripts.verbDirs.get(v)?.size || 0} session-dir(s)${ANSI.reset}`);
    }
  }

  if ((sub === 'slashes' || !sub) && transcripts) {
    console.log(`\n  ${ANSI.bold}Slash usage${ANSI.reset}`);
    const rows = [...transcripts.slashCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, sub === 'slashes' ? 999 : 15);
    for (const [s, c] of rows) console.log(`      /${s.padEnd(24)} ${String(c).padStart(5)}×`);
  }

  console.log(`\n  ${ANSI.dim}Re-run after default-flow changes; watch the dead count shrink. See docs/audit/ for the standing analysis.${ANSI.reset}`);
}
