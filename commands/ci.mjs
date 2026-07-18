// `maddu ci` — the headless, LLM-free gate rail for CI (roadmap #2).
//
// One verb that runs the deterministic checks a CI job needs and exits
// nonzero ONLY on gates the consumer has pinned as required. No LLM, no
// provider call, no network — the whole run is local and reproducible.
//
// Subcommands:
//   run (default) [--json] [--strict]
//       Run all gates headlessly (+ a learn-scan advisory line). Exit 1 iff a
//       PINNED required gate has status 'fail'. `--strict` fails on ANY gate
//       failure regardless of pinning (for repos that accept gate-set churn).
//   pin [--json]
//       Pin the currently-green gate set (status ok/warn) as this repo's
//       required list. Written to maddu.json `ci.requiredGates` in consumer
//       installs, or .maddu/config/ci.json in the framework source checkout
//       (maddu.json is the install marker and intentionally absent there).
//
// The exit contract is the point: framework upgrades may ADD gates, but a new
// gate never changes a consumer's CI verdict until they re-pin. Churn-proof
// by construction.
//
// GitHub Actions integration (auto-detected via GITHUB_ACTIONS):
//   - `::error` annotation per failed required gate
//   - a one-table markdown job summary appended to GITHUB_STEP_SUMMARY

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

const C = { dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m' };

async function readJsonIfPresent(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

// MADDU_CI_PROFILE — a test/CI-only seam that redirects WHERE `maddu ci` reads
// and writes its pinned profile, so a self-test (scripts/test/ci-command.mjs) can
// exercise pin/exit contracts against the real source gates WITHOUT mutating the
// repo's own .maddu/config/ci.json (the shared-file leak this closes). It affects
// ONLY `maddu ci`; other profile readers (e.g. commands/_gates-before-done.mjs)
// ignore it by design. Resolved against cwd if relative.
function ciProfileOverride() {
  const raw = (process.env.MADDU_CI_PROFILE || '').trim();
  return raw ? resolve(raw) : null;
}

// STRICT override read: a MISSING file means "unpinned" (the intended initial
// state), but a present-but-unreadable / non-JSON / wrong-shaped override is a
// hard error — never a silent green (Codex). Returns requiredGates | null.
async function readOverrideProfile(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return null; throw new Error(`MADDU_CI_PROFILE unreadable (${path}): ${e && e.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`MADDU_CI_PROFILE is not valid JSON (${path})`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.requiredGates)) {
    throw new Error(`MADDU_CI_PROFILE has no requiredGates array (${path})`);
  }
  return parsed.requiredGates;
}

// The pinned profile lives in the consumer's maddu.json (`ci.requiredGates`);
// the framework source checkout has no maddu.json by design, so it falls back
// to .maddu/config/ci.json. Read order mirrors write order.
async function readCiProfile(repoRoot) {
  // Override wins over both real files (test/CI seam). Its read is strict —
  // a bad override throws (caller surfaces a nonzero diagnostic), never green.
  const override = ciProfileOverride();
  if (override) {
    return { requiredGates: await readOverrideProfile(override), source: 'MADDU_CI_PROFILE' };
  }
  const marker = await readJsonIfPresent(join(repoRoot, 'maddu.json'));
  if (Array.isArray(marker?.ci?.requiredGates)) {
    return { requiredGates: marker.ci.requiredGates, source: 'maddu.json' };
  }
  const cfg = await readJsonIfPresent(join(repoRoot, '.maddu', 'config', 'ci.json'));
  if (Array.isArray(cfg?.requiredGates)) {
    return { requiredGates: cfg.requiredGates, source: '.maddu/config/ci.json' };
  }
  return { requiredGates: null, source: null };
}

async function writeCiProfile(repoRoot, requiredGates) {
  // Override wins over both real files (test/CI seam) — the pin lands in the temp
  // profile, never the repo's own ci.json / maddu.json.
  const override = ciProfileOverride();
  if (override) {
    await mkdir(dirname(override), { recursive: true });
    await writeFile(override, JSON.stringify({ requiredGates }, null, 2) + '\n');
    return 'MADDU_CI_PROFILE';
  }
  const markerPath = join(repoRoot, 'maddu.json');
  const marker = await readJsonIfPresent(markerPath);
  if (marker) {
    marker.ci = { ...(marker.ci || {}), requiredGates };
    await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n');
    return 'maddu.json';
  }
  const cfgDir = join(repoRoot, '.maddu', 'config');
  await mkdir(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, 'ci.json');
  const cfg = (await readJsonIfPresent(cfgPath)) || {};
  cfg.requiredGates = requiredGates;
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return '.maddu/config/ci.json';
}

function statusMark(status) {
  if (status === 'ok') return `${C.green}PASS${C.reset}`;
  if (status === 'warn') return `${C.yellow}WARN${C.reset}`;
  return `${C.red}FAIL${C.reset}`;
}

// GitHub Actions job summary: one table, nothing fancier — the verdict's own
// scope guard ("any formatting beyond an afternoon is the smell").
async function writeGhaSummary(summaryPath, { runs, requiredSet, failedRequired, scanLine, verdictLine }) {
  const rows = runs.map((r) => {
    const req = requiredSet ? (requiredSet.has(r.gateId) ? 'required' : '') : '';
    return `| ${r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌'} | \`${r.gateId}\` | ${req} | ${String(r.message || '').replace(/\|/g, '\\|').slice(0, 120)} |`;
  });
  const md = [
    '## maddu ci',
    '',
    verdictLine,
    '',
    '| | gate | | detail |',
    '|---|---|---|---|',
    ...rows,
    '',
    scanLine ? `> ${scanLine}` : '',
    failedRequired.length ? `**${failedRequired.length} required gate(s) red:** ${failedRequired.map((r) => `\`${r.gateId}\``).join(', ')}` : '',
    '',
  ].join('\n');
  try { await appendFile(summaryPath, md); } catch {} // summary is best-effort
}

export default async function ciCmd(argv) {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
  const { flags } = parseFlags(argv[0] === sub ? argv.slice(1) : argv);

  const { paths, spine } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const gatesLib = await loadLib('gates.mjs');
  if (!gatesLib?.runGates) {
    console.error('maddu ci: gate runner not available (install older than v0.16) — run `maddu upgrade`.');
    process.exit(2);
  }

  // ── run the gates (headless: no spine writes from CI) ──────────────────────
  const result = await gatesLib.runGates(repoRoot, { emitEvents: false });
  const runs = result.runs;

  // ── pin ─────────────────────────────────────────────────────────────────--
  if (sub === 'pin') {
    // audit P4 — pin ONLY fail-capable gates (severity !== 'warn'). A warn-severity
    // gate can never red `maddu ci`, so pinning it as "required" is a misnomer that
    // re-introduces the green-because-wrong-scope hole. Pinning keys on severity,
    // not this run's status: a fail-capable gate that merely warned this run stays
    // eligible. (The required-resolution check below enforces the same invariant.)
    const green = runs.filter((r) => r.status !== 'fail' && r.severity !== 'warn').map((r) => r.gateId).sort();
    const excluded = runs.filter((r) => r.status === 'fail' || r.severity === 'warn').map((r) => r.gateId).sort();
    const target = await writeCiProfile(repoRoot, green);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ pinned: green, excluded, target }, null, 2) + '\n');
      return;
    }
    console.log(`maddu ci pin  ${C.dim}pinned ${green.length} gate(s) as required → ${target}${C.reset}`);
    if (excluded.length) {
      console.log(`  ${C.yellow}excluded ${excluded.length} currently-failing gate(s):${C.reset} ${excluded.join(', ')}`);
      console.log(`  ${C.dim}fix them and re-run \`maddu ci pin\` to include them.${C.reset}`);
    }
    console.log(`  ${C.dim}from now on \`maddu ci\` exits nonzero only when a pinned gate fails — framework`);
    console.log(`  upgrades can add gates without changing this repo's CI verdict until you re-pin.${C.reset}`);
    return;
  }

  if (sub !== 'run') {
    console.error(`maddu ci: unknown subcommand "${sub}". Use run | pin.`);
    process.exit(2);
  }

  // ── verdict ─────────────────────────────────────────────────────────────--
  const strict = flags.strict === true;
  let profile;
  try { profile = await readCiProfile(repoRoot); }
  catch (e) { console.error(`maddu ci: ${e && e.message}`); process.exit(2); }
  const requiredSet = profile.requiredGates ? new Set(profile.requiredGates) : null;
  const failed = runs.filter((r) => r.status === 'fail');
  const failedRequired = requiredSet ? failed.filter((r) => requiredSet.has(r.gateId)) : [];

  // audit P4 — fail-closed required-gate RESOLUTION. A pinned required id that no
  // longer resolves to exactly one runnable gate (deleted / renamed / a broken
  // operator override that left nothing runnable), or resolves to a warn-severity
  // gate that can never red, is itself a RED — otherwise a required guarantee can
  // silently vanish and CI stays green. Checked against the POST-OVERRIDE resolved
  // runs (runGates already dedupes by id, operator wins), never raw definitions.
  const runsById = new Map();
  for (const r of runs) runsById.set(r.gateId, (runsById.get(r.gateId) || 0) + 1);
  const requiredIntegrity = [];
  if (profile.requiredGates) {
    for (const id of profile.requiredGates) {
      const count = runsById.get(id) || 0;
      const run = runs.find((r) => r.gateId === id);
      if (count === 0) requiredIntegrity.push(`${id} (required but no runnable gate resolves)`);
      else if (count > 1) requiredIntegrity.push(`${id} (required id resolves to ${count} gates)`);
      else if (run && run.severity === 'warn') requiredIntegrity.push(`${id} (required but warn-severity — can never fail)`);
    }
  }

  const red = strict ? failed : failedRequired;
  const exitCode = (red.length || requiredIntegrity.length) ? 1 : 0;

  // ── learn-scan advisory (never affects the exit code in v1) ────────────────
  let scan = null;
  try {
    const reflect = await loadLib('reflect.mjs');
    if (reflect?.scanCompletionClaims) {
      const events = await spine.readAll(repoRoot);
      scan = reflect.scanCompletionClaims(events, { nowMs: Date.now() });
    }
  } catch {} // advisory only — a scan error never breaks CI

  const scanLine = scan
    ? `learn scan (advisory): ${scan.scanned} slice-stop(s), ${scan.cumulativeCount} hedged-without-proof${scan.crossed ? ` — pattern LIVE (≥${scan.threshold})` : ''}`
    : null;

  const mode = strict ? 'strict (any gate failure is red)' : requiredSet
    ? `pinned (${requiredSet.size} required via ${profile.source})`
    : 'unpinned (exit 0 unless --strict)';
  const counts = `${result.summary.ok} ok · ${result.summary.warn} warn · ${result.summary.fail} fail of ${result.summary.total}`;
  const redReason = red.length
    ? `${red.length} ${strict ? '' : 'required '}gate(s) failing`
    : `${requiredIntegrity.length} required gate(s) unresolved/warn-only`;
  const verdictLine = exitCode === 0
    ? `**green** — ${counts} · mode: ${mode}`
    : `**red** — ${redReason} · ${counts}`;

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      exitCode, mode: strict ? 'strict' : requiredSet ? 'pinned' : 'unpinned',
      requiredGates: profile.requiredGates, profileSource: profile.source,
      summary: result.summary,
      failed: failed.map((r) => ({ gateId: r.gateId, severity: r.severity, required: requiredSet ? requiredSet.has(r.gateId) : null, message: r.message })),
      requiredIntegrity,
      scan: scan ? { scanned: scan.scanned, hedgedWithoutProof: scan.cumulativeCount, live: scan.crossed } : null,
    }, null, 2) + '\n');
    process.exit(exitCode);
  }

  // ── plain-text report: failures verbose, the rest a count ──────────────────
  console.log(`maddu ci  ${C.dim}${counts} · mode: ${mode}${C.reset}`);
  for (const r of failed) {
    const tag = requiredSet && requiredSet.has(r.gateId) ? ` ${C.red}[required]${C.reset}` : '';
    console.log(`  ${statusMark(r.status)}  ${r.gateId}${tag}${r.message ? `  ${C.dim}${r.message}${C.reset}` : ''}`);
  }
  for (const problem of requiredIntegrity) {
    console.log(`  ${C.red}✗${C.reset}  ${C.red}[required-integrity]${C.reset} ${C.dim}${problem}${C.reset}`);
  }
  const warns = runs.filter((r) => r.status === 'warn');
  for (const r of warns) console.log(`  ${statusMark(r.status)}  ${r.gateId}${r.message ? `  ${C.dim}${r.message}${C.reset}` : ''}`);
  if (scanLine) console.log(`  ${C.dim}${scanLine}${C.reset}`);
  if (!requiredSet && !strict) {
    console.log(`\n  ${C.yellow}no ci profile pinned${C.reset} ${C.dim}— this run is informational (exit 0). Pin the currently-green`);
    console.log(`  gate set as required with \`maddu ci pin\`, or use --strict to fail on any gate.${C.reset}`);
  }
  console.log(exitCode === 0
    ? `\n  ${C.green}✓ green${C.reset}`
    : `\n  ${C.red}✗ red — ${red.length} ${strict ? '' : 'required '}gate(s) failing${C.reset}`);

  // ── GitHub Actions surfaces ─────────────────────────────────────────────--
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const r of red) {
      console.log(`::error title=maddu gate ${r.gateId}::${(r.message || 'gate failed').replace(/\r?\n/g, ' ')}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await writeGhaSummary(process.env.GITHUB_STEP_SUMMARY, { runs, requiredSet, failedRequired: red, scanLine, verdictLine });
    }
  }

  process.exit(exitCode);
}
