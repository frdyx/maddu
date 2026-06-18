// `maddu doctor` — verify install integrity, port, and the 8 hard rules.
//
// Output: per-check PASS / WARN / FAIL, overall summary, DOCTOR_REPORT event
// appended to the spine. Exits 0 on PASS, 1 on FAIL, 0 on WARN-only.
//
// Multi-workspace: if a registry exists at ~/.config/maddu/workspaces.json,
// doctor validates registry shape first. Per-rule checks run for the cwd
// repo by default; pass --all to run them for every registered workspace.
//
// Governance Phase 2: doctor is now a thin wrapper around the gate runner
// (`template/maddu/runtime/lib/gates.mjs`). The 9 historical hard-rule /
// integrity checks are individual gates at
// `template/maddu/runtime/gates/builtin/*.mjs`. Operator-supplied gates at
// `<repo>/.maddu/gates/*.mjs` are discovered automatically.
//
// Flags:
//   --gate <id>          run only one gate by id
//   --severity <level>   filter built-in + operator gates by severity
//   --all                run gates per registered workspace

import { stat, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { exists, readMadduJson, frameworkVersion } from './_manifest.mjs';

const ANSI = {
  pass: '\x1b[32m',
  warn: '\x1b[33m',
  fail: '\x1b[31m',
  info: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m'
};

function tag(level) {
  if (level === 'PASS') return `${ANSI.pass}PASS${ANSI.reset}`;
  if (level === 'WARN') return `${ANSI.warn}WARN${ANSI.reset}`;
  if (level === 'FAIL') return `${ANSI.fail}FAIL${ANSI.reset}`;
  if (level === 'INFO') return `${ANSI.info}INFO${ANSI.reset}`;
  return level;
}

// A1 (v1.13.0): is this repo the Máddu framework *source* (a clone of
// frdyx/maddu or the npm-extracted package), as opposed to a consumer
// install produced by `maddu init`? The framework source has no
// `maddu.json` install marker by design — it IS the framework, it was
// never installed into anything. Detect it structurally so the
// missing-marker check can be informational here without weakening the
// real FAIL for a genuinely broken consumer install. Signals (all three):
//   - package.json `name === "maddu"`
//   - a `template/maddu/` source tree (only the source layout has this)
//   - a `commands/` CLI handler dir at the root
async function isFrameworkSourceRepo(repoRoot) {
  try {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    if (pkg.name !== 'maddu') return false;
  } catch { return false; }
  if (!(await exists(join(repoRoot, 'template', 'maddu')))) return false;
  if (!(await exists(join(repoRoot, 'commands')))) return false;
  return true;
}

// v1.1.0 Phase 3 — print the current governance mode as a banner so
// operators always know the operational posture before reading gates.
async function printGovernanceBanner(repoRoot) {
  const candidates = [
    join(repoRoot, 'maddu', 'runtime', 'lib', 'governance.mjs'),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'template', 'maddu', 'runtime', 'lib', 'governance.mjs'),
  ];
  let libPath = null;
  for (const c of candidates) {
    try { await stat(c); libPath = c; break; } catch {}
  }
  if (!libPath) return;
  try {
    const lib = await import(pathToFileURL(libPath).href);
    const cfg = await lib.readGovernance(repoRoot);
    const color = cfg.mode === 'strict' ? ANSI.fail : (cfg.mode === 'relaxed' ? ANSI.warn : '\x1b[34m');
    console.log(`             governance: ${color}${cfg.mode}${ANSI.reset}${ANSI.dim}  (${cfg.__source})${ANSI.reset}`);
    if (cfg.mode === 'relaxed') {
      console.log(`             ${ANSI.warn}operational gates lifted — hard rules still enforced${ANSI.reset}`);
    }
  } catch {}
}

async function checkPort(host, port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve({ free: false }));
    srv.once('listening', () => srv.close(() => resolve({ free: true })));
    srv.listen(port, host);
  });
}

// v0.19.1 PR-C3: when port is in use, probe http://host:port/bridge/status
// to decide if WE own it. If the bridge responds with the expected shape
// we PASS instead of WARN-ing — the bridge sitting on its own port is
// the healthy state.
async function probeBridge(host, port, timeoutMs = 750) {
  return new Promise((resolve) => {
    const req = httpRequest({
      method: 'GET',
      host,
      port,
      path: '/bridge/status',
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ reachable: true, parsed, status: res.statusCode });
        } catch {
          resolve({ reachable: true, parsed: null, status: res.statusCode });
        }
      });
    });
    req.on('error', () => resolve({ reachable: false }));
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false }); });
    req.end();
  });
}

// Resolve a runtime lib file. Honors both layouts:
//   1. Installed (commands/ alongside runtime/): <CLI-root>/runtime/lib/<name>
//   2. Framework source (CLI at framework root): <framework>/template/maddu/runtime/lib/<name>
// Mirrors _spine.mjs::libDir(). Returns null if neither path exists.
async function resolveRuntimeLib(name) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const cliRoot = join(__dirname, '..');
  const installed = join(cliRoot, 'runtime', 'lib', name);
  if (await exists(installed)) return installed;
  const dev = join(cliRoot, 'template', 'maddu', 'runtime', 'lib', name);
  if (await exists(dev)) return dev;
  return null;
}

async function loadWorkspacesLib() {
  const p = await resolveRuntimeLib('workspaces.mjs');
  if (!p) throw new Error('workspaces.mjs not found in runtime tree');
  return await import(pathToFileURL(p).href);
}

// Resolve and import the gate runner. Returns null on legacy installs.
async function loadGatesLib() {
  const p = await resolveRuntimeLib('gates.mjs');
  if (!p) return null;
  try { return await import(pathToFileURL(p).href); } catch { return null; }
}

// Map a gate run record into a doctor check row, preserving label text.
function gateRunToCheck(run, tagLabel) {
  const labelText = `${tagLabel}${run.label || run.gateId}`;
  let level = 'PASS';
  if (run.status === 'fail') level = 'FAIL';
  else if (run.status === 'warn') level = 'WARN';
  return { level, label: labelText, detail: run.message };
}

function workspaceRoleValue(w) {
  return (w?.role || 'project').toString().trim().toLowerCase() || 'project';
}

function workspaceDoctorLabel(w) {
  const role = workspaceRoleValue(w);
  return role === 'project' ? w.id : `${w.id}:${role}`;
}

function workspaceRoleSummary(workspaces) {
  const counts = new Map();
  for (const w of workspaces) {
    const role = workspaceRoleValue(w);
    counts.set(role, (counts.get(role) || 0) + 1);
  }
  const nonProject = [...counts.entries()].filter(([role]) => role !== 'project');
  if (nonProject.length === 0) return '';
  return ` (${nonProject.map(([role, count]) => `${count} ${role}`).join(', ')})`;
}

// Per-repo gate-runner wrapper. Preserves prior doctor behavior (the
// install-integrity / hard-rules / spine / approval / session-cache checks
// are now individual gates) and prepends the maddu.json / framework-version
// preamble that isn't a gate-shaped concern.
async function runRepoChecks(repoRoot, label, gateOpts = {}) {
  const checks = [];
  const tagLabel = label ? `[${label}] ` : '';

  const madduJson = await readMadduJson(repoRoot);
  let sourceGateOnly = false;
  if (!madduJson) {
    // A1: in the framework *source* repo the install marker is intentionally
    // absent — this repo IS Máddu, it was never installed into anything.
    // Downgrade to an explicit informational line so an operator/agent running
    // doctor here doesn't read red-FAIL as breakage (and doesn't "fix" it by
    // writing a bogus maddu.json into the framework root). A genuinely broken
    // consumer install still FAILs below.
    if (await isFrameworkSourceRepo(repoRoot)) {
      checks.push({
        level: 'INFO',
        label: `${tagLabel}install marker`,
        detail: 'framework source repo — install marker (maddu.json) intentionally absent; run inside a consumer install to verify install integrity.',
      });
      if (!gateOpts.onlyId && !gateOpts.severity) return checks;
      sourceGateOnly = true;
    } else {
      checks.push({ level: 'FAIL', label: `${tagLabel}maddu.json`, detail: `missing at ${repoRoot}` });
      return checks;
    }
  }
  if (madduJson) {
    const cliVersion = await frameworkVersion();
    if (cliVersion !== madduJson.framework_version) {
      checks.push({ level: 'WARN', label: `${tagLabel}framework version`, detail: `CLI v${cliVersion} but install is v${madduJson.framework_version} — run \`maddu upgrade\`` });
    }
  }

  // ── Gate runner — built-in gates + operator gates ──
  const gatesLib = await loadGatesLib();
  if (gatesLib?.runGates) {
    const result = await gatesLib.runGates(repoRoot, {
      onlyId: gateOpts.onlyId,
      severity: gateOpts.severity,
      emitEvents: true,
    });
    for (const run of result.runs) checks.push(gateRunToCheck(run, tagLabel));
    // State containment isn't a gate (no security-relevant invariant; it's
    // just a hygiene check for repo layout). Keep it inline below.
  } else {
    checks.push({ level: 'WARN', label: `${tagLabel}gate runner`, detail: 'gates.mjs not available — install older than v0.16' });
  }

  // ── State containment (not a gate; layout hygiene only) ──
  if (sourceGateOnly) return checks;

  const FORBIDDEN_AT_ROOT = ['skills', 'mcp', 'runtimes', 'checkpoints'];
  const leaks = [];
  for (const name of FORBIDDEN_AT_ROOT) {
    if (await exists(join(repoRoot, name))) leaks.push(name);
  }
  if (leaks.length === 0) {
    checks.push({ level: 'PASS', label: `${tagLabel}state containment`, detail: 'no Máddu state dirs leaked outside .maddu/' });
  } else {
    checks.push({ level: 'WARN', label: `${tagLabel}state containment`, detail: `leaked at repo root: ${leaks.join(', ')} — move into .maddu/` });
  }

  // ── Project-local CLI shim (maddu/run + maddu/run.cmd) ──
  // Not a gate — it's about the operator's invocation path, not a hard rule.
  async function shimFileStat(p) {
    try { const st = await stat(p); return st.isFile() ? st : null; } catch { return null; }
  }
  const shimPosixStat = await shimFileStat(join(repoRoot, 'maddu', 'run'));
  const shimWinStat = await shimFileStat(join(repoRoot, 'maddu', 'run.cmd'));
  if (!shimPosixStat && !shimWinStat) {
    checks.push({
      level: 'WARN',
      label: `${tagLabel}cli shim`,
      detail: 'maddu/run and maddu/run.cmd both missing — run `maddu upgrade` or `maddu init --force`'
    });
  } else if (process.platform !== 'win32' && shimPosixStat) {
    const mode = shimPosixStat.mode & 0o777;
    if ((mode & 0o111) === 0) {
      checks.push({ level: 'WARN', label: `${tagLabel}cli shim`, detail: 'maddu/run not executable — `chmod +x maddu/run` (or re-run `maddu upgrade`)' });
    } else {
      checks.push({ level: 'PASS', label: `${tagLabel}cli shim`, detail: 'maddu/run present + executable' });
    }
  } else {
    const which = [shimPosixStat && 'maddu/run', shimWinStat && 'maddu/run.cmd'].filter(Boolean).join(' + ');
    checks.push({ level: 'PASS', label: `${tagLabel}cli shim`, detail: `${which} present` });
  }

  return checks;
}

// Legacy inline checks are now individual gates under
// template/maddu/runtime/gates/builtin/. See:
//   install-integrity.mjs
//   rule-1-files-only.mjs
//   rule-2-no-sqlite.mjs
//   rule-5-no-provider-sdks.mjs
//   rule-6-no-token-leaks.mjs
//   rule-8-no-duplicate-claims.mjs
//   active-session-cache.mjs
//   approval-ledger-completeness.mjs
//   spine-integrity.mjs
//   tracked-source-drift.mjs (Phase 2 new)


// Validate the workspaces registry (multi-workspace mode). Returns an array
// of check objects plus the list of registered workspaces for the caller
// to optionally iterate. If the registry is missing, returns no checks and
// an empty workspace list (legacy single-repo mode).
async function validateRegistry() {
  const ws = await loadWorkspacesLib();
  const checks = [];
  if (!(await ws.registryExists())) {
    return { checks, workspaces: [], registryPath: null };
  }
  const reg = await ws.readRegistry();
  const path = ws.registryPath();
  if (!Array.isArray(reg.workspaces)) {
    checks.push({ level: 'FAIL', label: 'workspace registry', detail: `${path}: missing workspaces array` });
    return { checks, workspaces: [], registryPath: path };
  }
  if (reg.workspaces.length === 0) {
    checks.push({ level: 'WARN', label: 'workspace registry', detail: `${path}: empty (add one with \`maddu workspace add <path>\`)` });
    return { checks, workspaces: [], registryPath: path };
  }
  const seenIds = new Set(), seenPaths = new Set();
  const issues = [];
  for (const w of reg.workspaces) {
    if (!w.id || !w.path) { issues.push(`malformed entry: ${JSON.stringify(w)}`); continue; }
    if (ws.validWorkspaceRole && !ws.validWorkspaceRole(w.role)) {
      issues.push(`workspace "${w.id}": invalid role "${w.role}"`);
    }
    if (seenIds.has(w.id)) issues.push(`duplicate id: ${w.id}`);
    if (seenPaths.has(w.path)) issues.push(`duplicate path: ${w.path}`);
    seenIds.add(w.id); seenPaths.add(w.path);
    if (!(await exists(w.path))) {
      issues.push(`workspace "${w.id}": path unreachable: ${w.path}`);
      continue;
    }
    if (!(await exists(join(w.path, '.maddu')))) {
      issues.push(`workspace "${w.id}": no .maddu/ at ${w.path}`);
    }
  }
  if (reg.active && !seenIds.has(reg.active)) {
    issues.push(`active "${reg.active}" is not a registered workspace`);
  }
  if (issues.length === 0) {
    checks.push({ level: 'PASS', label: 'workspace registry', detail: `${reg.workspaces.length} workspaces${workspaceRoleSummary(reg.workspaces)}, active: ${reg.active || '(none)'}` });
  } else {
    // Unreachable paths and missing .maddu/ are WARN, not FAIL, so an
    // unmounted external drive doesn't break the whole report.
    checks.push({ level: 'WARN', label: 'workspace registry', detail: issues.join('; ') });
  }
  return { checks, workspaces: reg.workspaces, registryPath: path };
}

export default async function doctor(argv) {
  const { flags } = parseFlags(argv);
  const verbose = !!flags.verbose;
  const checkAll = !!flags.all;
  const checks = [];

  // ── Workspace registry validation (always runs if registry exists) ──
  const regResult = await validateRegistry();
  checks.push(...regResult.checks);

  // Decide which repos to validate:
  //   * --all: every registered workspace.
  //   * Otherwise: the cwd repo (legacy behavior). If no cwd repo and no
  //     registry, exit with the original error.
  let repoTargets = [];
  if (checkAll) {
    if (regResult.workspaces.length === 0) {
      console.log(`${tag('FAIL')}  --all requires a workspace registry. Run \`maddu workspace add <path>\` first.`);
      process.exit(1);
    }
    repoTargets = regResult.workspaces.map((w) => ({ repoRoot: w.path, label: workspaceDoctorLabel(w) }));
  } else {
    const cwdRepo = await findRepoRoot(process.cwd());
    if (!cwdRepo) {
      if (regResult.workspaces.length > 0) {
        console.log(`${tag('WARN')}  not inside a .maddu/ repo; pass --all to check every registered workspace.`);
      } else {
        console.log(`${tag('FAIL')}  .maddu/ not found. Run \`maddu init\` first.`);
        process.exit(1);
      }
    } else {
      repoTargets = [{ repoRoot: cwdRepo, label: null }];
    }
  }

  if (repoTargets.length === 1 && !checkAll) {
    const { repoRoot } = repoTargets[0];
    const madduJson = await readMadduJson(repoRoot);
    console.log(`${ANSI.bold}Máddu doctor${ANSI.reset}  repo: ${repoRoot}`);
    if (madduJson) console.log(`             installed framework v${madduJson.framework_version}`);
    // v1.1.0 Phase 3 — governance mode banner.
    await printGovernanceBanner(repoRoot);
  } else if (repoTargets.length > 0) {
    console.log(`${ANSI.bold}Máddu doctor${ANSI.reset}  ${repoTargets.length} workspaces${workspaceRoleSummary(regResult.workspaces)}`);
  }

  const gateOpts = {
    onlyId: typeof flags.gate === 'string' ? flags.gate : undefined,
    severity: typeof flags.severity === 'string' ? flags.severity : undefined,
  };
  for (const { repoRoot, label } of repoTargets) {
    checks.push(...await runRepoChecks(repoRoot, label, gateOpts));
  }

  // ── Port availability (machine-wide, not per-workspace) ──
  //
  // v0.19.1 PR-C3: when the port is in use, probe /bridge/status to see
  // if WE own it. The previous WARN-on-in-use was a false positive when
  // the operator's own bridge held the port — the healthy state.
  const portRes = await checkPort('127.0.0.1', 4177);
  if (portRes.free) {
    checks.push({ level: 'PASS', label: 'port 4177 available', detail: 'free for bridge' });
  } else {
    const probe = await probeBridge('127.0.0.1', 4177);
    const isOurBridge = probe.reachable && probe.parsed && (
      probe.parsed.bridge === 'maddu' || probe.parsed.ok === true || probe.parsed.framework === 'maddu'
    );
    if (isOurBridge) {
      checks.push({
        level: 'PASS',
        label: 'port 4177 available',
        detail: 'our bridge is running on 127.0.0.1:4177 (/bridge/status responded)'
      });
    } else {
      checks.push({
        level: 'WARN',
        label: 'port 4177 available',
        detail: probe.reachable
          ? 'in use by another process (/bridge/status returned unexpected shape)'
          : 'in use by another process (no /bridge/status response)'
      });
    }
  }

  // ── Report ──
  console.log();
  for (const c of checks) {
    console.log(`  ${tag(c.level)}  ${c.label}${ANSI.dim}  ${c.detail}${ANSI.reset}`);
  }

  const counts = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  for (const c of checks) counts[c.level]++;
  console.log();
  const infoSuffix = counts.INFO > 0 ? ` · ${counts.INFO} info` : '';
  console.log(`  ${ANSI.bold}Summary:${ANSI.reset}  ${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail${infoSuffix}`);

  // Append a DOCTOR_REPORT event to each repo's spine via the proper
  // spine.append API (generates a unique random id and respects segment
  // rolling). The previous manual append used a static `_drep00` suffix,
  // which collided when doctor ran more than once per second.
  const spineLibPath = await resolveRuntimeLib('spine.mjs');
  if (spineLibPath) {
    try {
      const spineMod = await import(pathToFileURL(spineLibPath).href);
      for (const { repoRoot } of repoTargets) {
        try {
          const ev = await spineMod.append(repoRoot, {
            type: 'DOCTOR_REPORT',
            data: {
              counts,
              checks: checks.map((c) => ({ level: c.level, label: c.label })),
            },
          });
          if (verbose) console.log(`\n  (recorded ${ev.id} in ${repoRoot})`);
        } catch (err) {
          if (verbose) console.error(`  (could not append DOCTOR_REPORT to ${repoRoot}: ${err.message})`);
        }
      }
    } catch (err) {
      if (verbose) console.error(`  (could not load spine.mjs: ${err.message})`);
    }
  }

  process.exit(counts.FAIL > 0 ? 1 : 0);
}
