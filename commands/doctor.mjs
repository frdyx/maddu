// `maddu doctor` — verify install integrity, port, and the 8 hard rules.
//
// Output: per-check PASS / WARN / FAIL, overall summary, DOCTOR_REPORT event
// appended to the spine. Exits 0 on PASS, 1 on FAIL, 0 on WARN-only.
//
// Multi-workspace: if a registry exists at ~/.config/maddu/workspaces.json,
// doctor validates registry shape first. Per-rule checks run for the cwd
// repo by default; pass --all to run them for every registered workspace.

import { readdir, readFile, stat, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { exists, readMadduJson, sha256OfFile, frameworkVersion } from './_manifest.mjs';

const ANSI = {
  pass: '\x1b[32m',
  warn: '\x1b[33m',
  fail: '\x1b[31m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m'
};

function tag(level) {
  if (level === 'PASS') return `${ANSI.pass}PASS${ANSI.reset}`;
  if (level === 'WARN') return `${ANSI.warn}WARN${ANSI.reset}`;
  if (level === 'FAIL') return `${ANSI.fail}FAIL${ANSI.reset}`;
  return level;
}

async function walkFiles(dir, predicate = () => true) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walkFiles(p, predicate));
    else if (ent.isFile() && predicate(p)) out.push(p);
  }
  return out;
}

async function checkPort(host, port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve({ free: false }));
    srv.once('listening', () => srv.close(() => resolve({ free: true })));
    srv.listen(port, host);
  });
}

// Load the workspaces library from the framework template (always available
// because doctor ships with the CLI).
async function loadWorkspacesLib() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const lib = join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'workspaces.mjs');
  return await import(pathToFileURL(lib).href);
}

// Per-repo hard-rule + integrity checks. Returns an array of check objects.
// Pulled out of the main function so the same logic can run once for the
// cwd repo or N times for every registered workspace.
async function runRepoChecks(repoRoot, label) {
  const checks = [];
  const tagLabel = label ? `[${label}] ` : '';

  const madduJson = await readMadduJson(repoRoot);
  if (!madduJson) {
    checks.push({ level: 'FAIL', label: `${tagLabel}maddu.json`, detail: `missing at ${repoRoot}` });
    return checks;
  }
  const cliVersion = await frameworkVersion();
  if (cliVersion !== madduJson.framework_version) {
    checks.push({ level: 'WARN', label: `${tagLabel}framework version`, detail: `CLI v${cliVersion} but install is v${madduJson.framework_version} — run \`maddu upgrade\`` });
  }

  // ── Install integrity ──
  const managed = madduJson.managed || {};
  const missing = [], modified = [];
  for (const [rel, meta] of Object.entries(managed)) {
    const abs = join(repoRoot, rel);
    if (!(await exists(abs))) { missing.push(rel); continue; }
    const h = await sha256OfFile(abs);
    if (h !== meta.sha256) modified.push(rel);
  }
  if (missing.length === 0 && modified.length === 0) {
    checks.push({ level: 'PASS', label: `${tagLabel}install integrity`, detail: `${Object.keys(managed).length} managed files present, hashes match` });
  } else {
    if (missing.length) checks.push({ level: 'FAIL', label: `${tagLabel}install integrity`, detail: `missing: ${missing.join(', ')}` });
    if (modified.length) checks.push({ level: 'WARN', label: `${tagLabel}install integrity`, detail: `locally modified: ${modified.join(', ')}` });
  }

  // ── Rule #1: files-only state ──
  const stateDir = join(repoRoot, '.maddu');
  const dbFiles = await walkFiles(stateDir, (p) => /\.(db|sqlite|sqlite3)$/i.test(p));
  if (dbFiles.length === 0) {
    checks.push({ level: 'PASS', label: `${tagLabel}rule #1 files-only state`, detail: 'no DB files under .maddu/' });
  } else {
    checks.push({ level: 'FAIL', label: `${tagLabel}rule #1 files-only state`, detail: `found: ${dbFiles.map((p) => p.slice(repoRoot.length + 1)).join(', ')}` });
  }

  // ── Rule #2: no SQLite / DB packages ──
  const pkgJsonPath = join(repoRoot, 'package.json');
  if (await exists(pkgJsonPath)) {
    let pkg = {};
    try { pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')); } catch {}
    const banned = ['better-sqlite3', 'sqlite3', 'sqlite', 'node-sqlite', '@databases/sqlite'];
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const found = banned.filter((b) => deps[b]);
    if (found.length === 0) {
      checks.push({ level: 'PASS', label: `${tagLabel}rule #2 no DB packages`, detail: 'no SQLite-family deps in package.json' });
    } else {
      checks.push({ level: 'FAIL', label: `${tagLabel}rule #2 no DB packages`, detail: `found: ${found.join(', ')}` });
    }
  } else {
    checks.push({ level: 'PASS', label: `${tagLabel}rule #2 no DB packages`, detail: 'no package.json — nothing to check' });
  }

  // ── Rule #5: no provider SDK imports in framework code ──
  const madduDir = join(repoRoot, 'maddu');
  const codeFiles = await walkFiles(madduDir, (p) => /\.(m?js|ts|mjs|html|css)$/.test(p));
  const banned = [/from\s+['"]anthropic['"]/, /from\s+['"]@anthropic-ai/, /from\s+['"]openai['"]/, /from\s+['"]@google\/generative-ai['"]/, /require\(['"](anthropic|openai|@anthropic-ai|@google\/generative-ai)['"]/];
  const sdkHits = [];
  for (const f of codeFiles) {
    const text = await readFile(f, 'utf8');
    for (const re of banned) if (re.test(text)) sdkHits.push(f.slice(repoRoot.length + 1));
  }
  if (sdkHits.length === 0) {
    checks.push({ level: 'PASS', label: `${tagLabel}rule #5 no provider SDKs in app code`, detail: `scanned ${codeFiles.length} files` });
  } else {
    checks.push({ level: 'FAIL', label: `${tagLabel}rule #5 no provider SDKs in app code`, detail: sdkHits.join(', ') });
  }

  // ── Rule #6: no obvious token leaks under .maddu/ ──
  const tokenRegex = /(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|xox[baprs]-[0-9a-zA-Z\-]+)/;
  const stateFiles = await walkFiles(stateDir, (p) => /\.(json|ndjson|md|txt|ya?ml)$/i.test(p));
  const tokenHits = [];
  for (const f of stateFiles) {
    const text = await readFile(f, 'utf8');
    if (tokenRegex.test(text)) tokenHits.push(f.slice(repoRoot.length + 1));
  }
  if (tokenHits.length === 0) {
    checks.push({ level: 'PASS', label: `${tagLabel}rule #6 no token leaks under .maddu/`, detail: `scanned ${stateFiles.length} files` });
  } else {
    checks.push({ level: 'FAIL', label: `${tagLabel}rule #6 no token leaks under .maddu/`, detail: tokenHits.join(', ') });
  }

  // ── State containment ──
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

  // ── Rule #8: no duplicate active lane claims ──
  const claimsPath = join(repoRoot, '.maddu', 'lanes', 'claims.json');
  if (await exists(claimsPath)) {
    try {
      const cj = JSON.parse(await readFile(claimsPath, 'utf8'));
      const lanes = (cj.claims || []).map((c) => c.lane);
      const dups = lanes.filter((l, i) => lanes.indexOf(l) !== i);
      if (dups.length === 0) {
        checks.push({ level: 'PASS', label: `${tagLabel}rule #8 lane ownership`, detail: `${lanes.length} active claim(s), no duplicates` });
      } else {
        checks.push({ level: 'FAIL', label: `${tagLabel}rule #8 lane ownership`, detail: `duplicate lanes: ${[...new Set(dups)].join(', ')}` });
      }
    } catch {
      checks.push({ level: 'WARN', label: `${tagLabel}rule #8 lane ownership`, detail: 'claims.json unreadable' });
    }
  }

  return checks;
}

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
    checks.push({ level: 'PASS', label: 'workspace registry', detail: `${reg.workspaces.length} workspaces, active: ${reg.active || '(none)'}` });
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
    repoTargets = regResult.workspaces.map((w) => ({ repoRoot: w.path, label: w.id }));
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
  } else if (repoTargets.length > 0) {
    console.log(`${ANSI.bold}Máddu doctor${ANSI.reset}  ${repoTargets.length} workspaces`);
  }

  for (const { repoRoot, label } of repoTargets) {
    checks.push(...await runRepoChecks(repoRoot, label));
  }

  // ── Port availability (machine-wide, not per-workspace) ──
  const portRes = await checkPort('127.0.0.1', 4177);
  checks.push({
    level: portRes.free ? 'PASS' : 'WARN',
    label: 'port 4177 available',
    detail: portRes.free ? 'free for bridge' : 'in use (bridge may already be running)'
  });

  // ── Report ──
  console.log();
  for (const c of checks) {
    console.log(`  ${tag(c.level)}  ${c.label}${ANSI.dim}  ${c.detail}${ANSI.reset}`);
  }

  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const c of checks) counts[c.level]++;
  console.log();
  console.log(`  ${ANSI.bold}Summary:${ANSI.reset}  ${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail`);

  // Append a DOCTOR_REPORT event to each repo's spine that was checked.
  for (const { repoRoot } of repoTargets) {
    try {
      const eventsSegment = join(repoRoot, '.maddu', 'events', '000000000001.ndjson');
      const ts = new Date().toISOString();
      const ev = {
        v: 1,
        id: 'evt_' + ts.replace(/[-:T.Z]/g, '').slice(0, 14) + '_drep00',
        ts,
        type: 'DOCTOR_REPORT',
        actor: null,
        lane: null,
        data: {
          counts,
          checks: checks.map((c) => ({ level: c.level, label: c.label }))
        }
      };
      await appendFile(eventsSegment, JSON.stringify(ev) + '\n');
      if (verbose) console.log(`\n  (recorded ${ev.id} in ${repoRoot})`);
    } catch (err) {
      if (verbose) console.error(`  (could not append DOCTOR_REPORT to ${repoRoot}: ${err.message})`);
    }
  }

  process.exit(counts.FAIL > 0 ? 1 : 0);
}
