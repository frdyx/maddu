// v1.2.0 Phase 1 — supply-chain trust library.
//
// Reads `.maddu/config/trust.json` (per-workspace trust posture). Drives
// `maddu trust audit|pin|unpin|verify|list|report` and the two doctor
// gates `dependency-freshness` + `dep-pinning-respected`.
//
// Hard-rule compliance:
//   - rule #4: no new npm deps. Uses Node stdlib + child_process.spawn
//     to call out to npm subprocesses (npm ls / npm view / npm audit).
//   - rule #5: no provider SDKs. All registry data via `npm` subprocess.
//   - rule #1: files-only state. trust.json + audit-cache.json + a
//     Markdown report file. No DB.
//   - rule #2: every mutating verb appends a spine event.
//
// Audit cache: `.maddu/state/trust-cache.json` with a 6-hour TTL keyed
// by `${name}@${version}` for `npm view` time-data. Stale cache used as
// fallback during registry outages.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathsFor } from './paths.mjs';

const TRUST_CONFIG_REL = ['config', 'trust.json'];
const TRUST_CACHE_REL  = ['state', 'trust-cache.json'];
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_TRUST_CONFIG = {
  schemaVersion: 1,
  pinnedPackages: [],
  audit: {
    freshness_warn_days: 30,
    freshness_block_days: 7,
  },
};

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function trustConfigPath(repoRoot) {
  return join(pathsFor(repoRoot).state, ...TRUST_CONFIG_REL);
}
function trustCachePath(repoRoot) {
  return join(pathsFor(repoRoot).state, ...TRUST_CACHE_REL);
}

export async function readTrustConfig(repoRoot) {
  const p = trustConfigPath(repoRoot);
  if (!(await exists(p))) {
    return { ...structuredClone(DEFAULT_TRUST_CONFIG), __source: 'default' };
  }
  try {
    const cfg = JSON.parse(await readFile(p, 'utf8'));
    // Migration: ensure schema fields exist.
    if (cfg.schemaVersion !== 1) cfg.schemaVersion = 1;
    if (!Array.isArray(cfg.pinnedPackages)) cfg.pinnedPackages = [];
    if (!cfg.audit || typeof cfg.audit !== 'object') {
      cfg.audit = { ...DEFAULT_TRUST_CONFIG.audit };
    } else {
      if (typeof cfg.audit.freshness_warn_days !== 'number') cfg.audit.freshness_warn_days = 30;
      if (typeof cfg.audit.freshness_block_days !== 'number') cfg.audit.freshness_block_days = 7;
    }
    cfg.__source = 'file';
    return cfg;
  } catch (err) {
    return { ...structuredClone(DEFAULT_TRUST_CONFIG), __source: `default-on-parse-error:${err.message}` };
  }
}

export async function writeTrustConfig(repoRoot, cfg) {
  const p = trustConfigPath(repoRoot);
  await mkdir(dirname(p), { recursive: true });
  const clean = {
    schemaVersion: 1,
    pinnedPackages: Array.isArray(cfg.pinnedPackages) ? cfg.pinnedPackages : [],
    audit: {
      freshness_warn_days: Number(cfg?.audit?.freshness_warn_days ?? 30),
      freshness_block_days: Number(cfg?.audit?.freshness_block_days ?? 7),
    },
  };
  await writeFile(p, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

async function readCache(repoRoot) {
  const p = trustCachePath(repoRoot);
  if (!(await exists(p))) return { entries: {} };
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return { entries: {} }; }
}

async function writeCache(repoRoot, cache) {
  const p = trustCachePath(repoRoot);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cache, null, 2) + '\n');
}

// ── subprocess helpers ─────────────────────────────────────────────────

function runNpm(args, { cwd, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'npm.cmd' : 'npm';
    const child = spawn(cmd, args, { cwd, shell: isWin, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {}; }, timeoutMs);
    child.stdout.on('data', (b) => stdout += b.toString());
    child.stderr.on('data', (b) => stderr += b.toString());
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + (err.message || '') }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ── package.json reader ────────────────────────────────────────────────

export async function readPackageJson(repoRoot) {
  const p = join(repoRoot, 'package.json');
  if (!(await exists(p))) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export function listDirectDeps(pkg) {
  if (!pkg) return [];
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = pkg[field] || {};
    for (const [name, spec] of Object.entries(block)) {
      out.push({ name, spec, field });
    }
  }
  return out;
}

// ── audit core ────────────────────────────────────────────────────────

// Get installed version of a package from `npm ls --json` (best-effort).
export async function getInstalledVersions(repoRoot) {
  const r = await runNpm(['ls', '--all', '--json', '--depth=0'], { cwd: repoRoot, timeoutMs: 20000 });
  // npm ls can exit non-zero on peer-dep issues but still emit valid JSON.
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || '{}'); } catch {}
  const out = {};
  function walk(deps) {
    if (!deps || typeof deps !== 'object') return;
    for (const [name, info] of Object.entries(deps)) {
      if (info && info.version && !out[name]) out[name] = info.version;
      if (info && info.dependencies) walk(info.dependencies);
    }
  }
  walk(parsed?.dependencies);
  return out;
}

// Fetch `npm view <pkg> time --json` with a 6h cache. Returns
// `{ created, modified, '<version>': iso }` or null on failure.
export async function fetchTimeData(repoRoot, name, { now = Date.now(), cache, fresh = false } = {}) {
  cache = cache || (await readCache(repoRoot));
  const entry = cache.entries[name];
  if (!fresh && entry && (now - entry.fetchedAt) < CACHE_TTL_MS) {
    return { ...entry.data, __cacheHit: true };
  }
  const r = await runNpm(['view', name, 'time', '--json'], { cwd: repoRoot, timeoutMs: 12000 });
  if (r.code !== 0 || !r.stdout.trim()) {
    if (entry) return { ...entry.data, __cacheHit: true, __stale: true };
    return null;
  }
  let data;
  try { data = JSON.parse(r.stdout); } catch { return entry ? { ...entry.data, __cacheHit: true, __stale: true } : null; }
  cache.entries[name] = { fetchedAt: now, data };
  await writeCache(repoRoot, cache);
  return { ...data, __cacheHit: false };
}

// Days between two ISO timestamps.
function daysBetween(a, b) {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.floor((db - da) / 86400000);
}

// Pure (no subprocess) audit-row builder — exposed for tests + freshness gate.
export function buildAuditRow({ name, spec, installedVersion, timeData, pinnedPackages, audit, now = new Date().toISOString() }) {
  const pin = pinnedPackages.find((p) => p.name === name) || null;
  const publishIso = (installedVersion && timeData && timeData[installedVersion]) || null;
  const ageDays = publishIso ? daysBetween(publishIso, now) : null;
  const warnDays = audit?.freshness_warn_days ?? 30;
  const blockDays = audit?.freshness_block_days ?? 7;

  let freshnessLevel = 'ok';
  if (ageDays != null && ageDays <= blockDays) freshnessLevel = 'block';
  else if (ageDays != null && ageDays <= warnDays) freshnessLevel = 'warn';

  let pinStatus = 'unpinned';
  let pinViolation = false;
  if (pin) {
    if (installedVersion && pin.version && installedVersion === pin.version) {
      pinStatus = 'pinned-match';
    } else {
      pinStatus = 'pinned-drift';
      pinViolation = true;
    }
  }

  return {
    name,
    spec: spec ?? null,
    installedVersion: installedVersion ?? null,
    publishIso,
    ageDays,
    freshnessLevel,
    pinStatus,
    pinViolation,
    pinned: pin ? { version: pin.version, sha256: pin.sha256 || null } : null,
  };
}

// Full audit: walks direct deps, calls npm-view for each (cache-aware).
export async function auditRepo(repoRoot, { fresh = false, includeCves = false } = {}) {
  const pkg = await readPackageJson(repoRoot);
  if (!pkg) {
    return {
      ok: false,
      reason: 'no-package-json',
      detail: `no package.json at ${repoRoot}`,
      rows: [],
    };
  }
  const cfg = await readTrustConfig(repoRoot);
  const deps = listDirectDeps(pkg);
  const installed = await getInstalledVersions(repoRoot);
  const cache = await readCache(repoRoot);
  const now = new Date().toISOString();
  const rows = [];
  let cacheHits = 0, cacheMisses = 0;
  for (const d of deps) {
    let timeData = null;
    try {
      timeData = await fetchTimeData(repoRoot, d.name, { cache, fresh, now: Date.parse(now) });
      if (timeData?.__cacheHit) cacheHits++; else cacheMisses++;
    } catch {}
    const row = buildAuditRow({
      name: d.name,
      spec: d.spec,
      installedVersion: installed[d.name] || null,
      timeData,
      pinnedPackages: cfg.pinnedPackages,
      audit: cfg.audit,
      now,
    });
    rows.push(row);
  }
  let cveSummary = null;
  if (includeCves) {
    const r = await runNpm(['audit', '--json'], { cwd: repoRoot, timeoutMs: 25000 });
    try {
      const j = JSON.parse(r.stdout || '{}');
      cveSummary = {
        total: j?.metadata?.vulnerabilities?.total ?? 0,
        critical: j?.metadata?.vulnerabilities?.critical ?? 0,
        high: j?.metadata?.vulnerabilities?.high ?? 0,
      };
    } catch { cveSummary = { total: 0, critical: 0, high: 0, __degraded: true }; }
  }
  const violations = rows.filter((r) => r.pinViolation || r.freshnessLevel === 'block');
  const warns = rows.filter((r) => !r.pinViolation && r.freshnessLevel === 'warn');
  return {
    ok: true,
    auditedAt: now,
    cacheHits,
    cacheMisses,
    audit: cfg.audit,
    rows,
    violations,
    warns,
    cveSummary,
  };
}

// ── pin verbs ─────────────────────────────────────────────────────────

export async function pinPackage(repoRoot, { name, version, sha256 = null }) {
  if (!name || !version) throw new Error('pinPackage requires name + version');
  const cfg = await readTrustConfig(repoRoot);
  const existing = cfg.pinnedPackages.findIndex((p) => p.name === name);
  const entry = { name, version, ...(sha256 ? { sha256 } : {}) };
  if (existing >= 0) cfg.pinnedPackages[existing] = entry;
  else cfg.pinnedPackages.push(entry);
  await writeTrustConfig(repoRoot, cfg);
  return entry;
}

export async function unpinPackage(repoRoot, name) {
  const cfg = await readTrustConfig(repoRoot);
  const before = cfg.pinnedPackages.length;
  cfg.pinnedPackages = cfg.pinnedPackages.filter((p) => p.name !== name);
  const removed = before !== cfg.pinnedPackages.length;
  if (removed) await writeTrustConfig(repoRoot, cfg);
  return removed;
}

// ── package.json declared-spec compare for the pinning gate ───────────

// Returns rows where package.json's declared spec disagrees with trust.json
// pin. Used by the `dep-pinning-respected` gate. Pure on inputs.
export function diffPinsAgainstSpec(pkg, pinnedPackages) {
  if (!pkg) return [];
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies'];
  const out = [];
  for (const p of pinnedPackages) {
    let foundSpec = null, foundField = null;
    for (const f of fields) {
      const block = pkg[f] || {};
      if (Object.prototype.hasOwnProperty.call(block, p.name)) {
        foundSpec = block[p.name];
        foundField = f;
        break;
      }
    }
    if (foundSpec == null) {
      out.push({ name: p.name, status: 'pinned-but-absent', pinnedVersion: p.version });
      continue;
    }
    // Equality: exact-pin spec matches the literal version. Acceptable forms
    // include `1.2.3`, `=1.2.3`. Any caret/tilde/range means the pin is at
    // risk of drifting and the gate complains.
    const stripped = String(foundSpec).trim().replace(/^=/, '');
    if (stripped === p.version) {
      out.push({ name: p.name, status: 'match', pinnedVersion: p.version, declared: foundSpec, field: foundField });
    } else {
      out.push({ name: p.name, status: 'drift', pinnedVersion: p.version, declared: foundSpec, field: foundField });
    }
  }
  return out;
}

// ── audit report renderer (Markdown) ──────────────────────────────────

export function renderReportMarkdown(repoRoot, audit, extras = {}) {
  // v1.2.0 Phase 6 — security-team-shareable trust posture report.
  // `audit` is the result of auditRepo(). `extras` carries the surrounding
  // posture surfaces the report needs: governance, pins, recent
  // violations/secret/env events, MCP inventory, worker-env policy,
  // skill provenance distribution, doctor snapshot.
  const lines = [];
  const dateTag = new Date().toISOString();
  lines.push(`# Máddu trust report — ${repoRoot}`);
  lines.push('');
  lines.push(`Generated: ${dateTag}`);
  lines.push('');
  lines.push('This report is suitable for handing to a security team. It');
  lines.push('summarizes the current supply-chain trust posture of this');
  lines.push('Máddu workspace. See `docs/34-threat-model.md` for the full');
  lines.push('threat model and enforcement boundary.');
  lines.push('');

  // §1 Governance + trust posture
  lines.push('## 1. Governance + trust posture');
  lines.push('');
  if (extras.governance) {
    lines.push(`- Governance mode: \`${extras.governance.mode || 'standard'}\``);
    const overrides = extras.governance.overrides || {};
    const overrideKeys = Object.keys(overrides);
    if (overrideKeys.length) {
      lines.push(`- Overrides (${overrideKeys.length}):`);
      for (const k of overrideKeys) {
        lines.push(`  - \`${k}\`: ${JSON.stringify(overrides[k])}`);
      }
    } else {
      lines.push('- Overrides: (none)');
    }
  } else {
    lines.push('- Governance mode: (unavailable)');
  }
  lines.push(`- Freshness thresholds (days): warn=${audit.audit.freshness_warn_days}, block=${audit.audit.freshness_block_days}`);
  if (audit.cveSummary) {
    lines.push(`- npm audit CVE total: ${audit.cveSummary.total} (critical=${audit.cveSummary.critical}, high=${audit.cveSummary.high})`);
  }
  lines.push('');

  // §2 Pinned packages
  const pins = extras.pinnedPackages || [];
  lines.push(`## 2. Pinned packages (${pins.length})`);
  lines.push('');
  if (pins.length === 0) {
    lines.push('_(no pins declared in `.maddu/config/trust.json`)_');
  } else {
    lines.push('| Package | Pinned version | sha256 |');
    lines.push('|---|---|---|');
    for (const p of pins) {
      lines.push(`| ${p.name} | ${p.version} | ${p.sha256 || '—'} |`);
    }
  }
  lines.push('');

  // §3 Direct dep audit
  lines.push(`## 3. Direct dependencies (${audit.rows.length})`);
  lines.push('');
  if (audit.rows.length === 0) {
    lines.push('_(no direct dependencies)_');
  } else {
    lines.push('| Package | Installed | Age (d) | Freshness | Pin |');
    lines.push('|---|---|---|---|---|');
    for (const r of audit.rows) {
      lines.push(`| ${r.name} | ${r.installedVersion || '—'} | ${r.ageDays ?? '—'} | ${r.freshnessLevel} | ${r.pinStatus} |`);
    }
  }
  lines.push('');

  // §4 Recent violations
  const violations = extras.recentViolations || audit.violations || [];
  lines.push(`## 4. Recent violations (${violations.length})`);
  lines.push('');
  if (violations.length === 0) {
    lines.push('_(no recent violations)_');
  } else {
    for (const v of violations) {
      if (v.ts && v.data) {
        lines.push(`- \`${v.ts}\` — ${v.data.kind || 'unknown'} on \`${v.data.pkg || '—'}\`: ${v.data.detail || ''}`);
      } else {
        lines.push(`- ${v.name}: pinViolation=${v.pinViolation}, freshness=${v.freshnessLevel}`);
      }
    }
  }
  lines.push('');

  // §5 Recent secret refusals
  const secretRefusals = extras.recentSecretRefusals || [];
  lines.push(`## 5. Recent secret-scan refusals (${secretRefusals.length})`);
  lines.push('');
  lines.push('_Pattern types only — raw matches are never recorded._');
  lines.push('');
  if (secretRefusals.length === 0) {
    lines.push('_(no recent secret refusals)_');
  } else {
    lines.push('| Timestamp | Tool | Pattern type | Argv index | Override |');
    lines.push('|---|---|---|---|---|');
    for (const s of secretRefusals) {
      const d = s.data || {};
      lines.push(`| ${s.ts} | ${d.tool || '?'} | ${d.pattern_type || d.patternType || '?'} | ${d.argv_index ?? d.position ?? '?'} | ${d.override || 'none'} |`);
    }
  }
  lines.push('');

  // §6 Worker env policy
  const we = extras.workerEnvPolicy || null;
  lines.push('## 6. Worker env policy');
  lines.push('');
  if (we) {
    lines.push(`- default_allow patterns: ${we.default_allow.length}`);
    if (we.default_allow.length) {
      lines.push('  ```');
      for (const p of we.default_allow) lines.push(`  ${p}`);
      lines.push('  ```');
    }
    lines.push(`- default_deny_secrets patterns: ${we.default_deny_secrets.length}`);
    if (we.default_deny_secrets.length) {
      lines.push('  ```');
      for (const p of we.default_deny_secrets) lines.push(`  ${p}`);
      lines.push('  ```');
    }
    const perLaneKeys = Object.keys(we.per_lane || {});
    lines.push(`- per-lane overrides: ${perLaneKeys.length}`);
    for (const lane of perLaneKeys) {
      const allow = (we.per_lane[lane]?.allow || []).join(', ') || '(none)';
      lines.push(`  - \`${lane}\`: allow=${allow}`);
    }
  } else {
    lines.push('_(worker-env policy unavailable)_');
  }
  lines.push('');
  const envFiltered = extras.recentEnvFiltered || [];
  lines.push(`### Recent worker env-filter events (${envFiltered.length})`);
  lines.push('');
  if (envFiltered.length === 0) {
    lines.push('_(no recent worker spawns)_');
  } else {
    lines.push('| Timestamp | Worker | Allowed | Denied |');
    lines.push('|---|---|---|---|');
    for (const w of envFiltered) {
      const d = w.data || {};
      lines.push(`| ${w.ts} | ${d.workerId || '?'} | ${d.allowedCount ?? '?'} | ${d.deniedCount ?? '?'} |`);
    }
  }
  lines.push('');

  // §7 MCP inventory
  const mcp = extras.mcpInventory || [];
  lines.push(`## 7. Active MCP servers (${mcp.length})`);
  lines.push('');
  if (mcp.length === 0) {
    lines.push('_(no MCP servers registered)_');
  } else {
    lines.push('| Name | Enabled | Provenance source | Approved |');
    lines.push('|---|---|---|---|');
    for (const m of mcp) {
      const p = m.provenance || {};
      lines.push(`| ${m.name} | ${m.enabled ? 'yes' : 'no'} | ${p.source || '—'} | ${p.approved === true ? 'yes' : (p.approved === false ? 'pending' : '—')} |`);
    }
  }
  lines.push('');

  // §8 Skill provenance distribution
  const skill = extras.skillProvenance || null;
  lines.push('## 8. Skill provenance distribution');
  lines.push('');
  if (skill) {
    lines.push('| Provenance | Count |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(skill)) {
      lines.push(`| ${k} | ${v} |`);
    }
  } else {
    lines.push('_(skill provenance unavailable)_');
  }
  lines.push('');

  // §9 Doctor gate snapshot
  const doctor = extras.doctor || null;
  lines.push('## 9. Doctor gate snapshot');
  lines.push('');
  if (doctor) {
    lines.push(`- Total gates: ${doctor.total}`);
    lines.push(`- PASS: ${doctor.pass}`);
    lines.push(`- WARN: ${doctor.warn}`);
    lines.push(`- FAIL: ${doctor.fail}`);
    if (doctor.failedGates && doctor.failedGates.length) {
      lines.push('');
      lines.push('### Failed gates');
      for (const g of doctor.failedGates) lines.push(`- ${g}`);
    }
    if (doctor.error) {
      lines.push('');
      lines.push(`_(doctor run note: ${doctor.error})_`);
    }
  } else {
    lines.push('_(doctor snapshot unavailable — run `maddu doctor` and re-run report)_');
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('See `docs/34-threat-model.md` for what Máddu enforces vs.');
  lines.push('documents-but-does-not-enforce, and §5 of that doc for');
  lines.push('OS-level defenses (Little Snitch / ufw / Windows Firewall)');
  lines.push('that layer with Máddu.');
  lines.push('');
  return lines.join('\n') + '\n';
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
