// v1.2.0 Phase 2 — worker env allowlist.
//
// Reads `.maddu/config/worker-env.json` and filters `process.env` before
// it is handed to a spawned worker (`runtimes.spawnWorker` calls
// `filterEnvForWorker`). Defaults deny known secret-keyed vars and allow
// a known-safe baseline. Operator can extend per-lane.
//
// Config schema:
//   {
//     "schemaVersion": 1,
//     "default_allow":        ["PATH", "HOME", "USER", "USERPROFILE", "TEMP", "TMP", "LANG", "LC_*", "NODE_*", "MADDU_*"],
//     "default_deny_secrets": ["AWS_*", "OPENAI_*", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_*", "AZURE_*", "GCP_*", "STRIPE_*"],
//     "per_lane": { "<lane-id>": { "allow": ["…"] } }
//   }
//
// Hard-rule compliance: rule #1 — files-only. rule #6 — strengthened
// (workers no longer inherit secret-keyed vars by default).

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathsFor } from './paths.mjs';

export const DEFAULT_WORKER_ENV_CONFIG = {
  schemaVersion: 1,
  default_allow: [
    'PATH', 'HOME', 'USER', 'USERPROFILE', 'TEMP', 'TMP',
    'LANG', 'LC_*', 'NODE_*', 'MADDU_*',
    // Windows path-resolution baseline so spawned npm/node etc resolve.
    'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'PROCESSOR_*',
    // OS-X locale extras.
    'TERM', 'SHELL',
    // Provider CLI context (NOT secrets — auth tokens stay under ~/.config).
    'CLAUDE_*', 'CLAUDECODE', 'CODEX_*', 'GEMINI_*',
    // Windows shell + git basics that workers commonly need.
    'HOMEDRIVE', 'HOMEPATH', 'PWD', 'OLDPWD', 'COMPUTERNAME', 'USERDOMAIN',
    'USERNAME', 'PUBLIC', 'PROGRAMFILES', 'PROGRAMDATA', 'PSModulePath',
    'COMMONPROGRAMFILES', 'SYSTEMDRIVE', 'OS', 'PATHEXT',
  ],
  default_deny_secrets: [
    'AWS_*', 'OPENAI_*', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
    'GITLAB_*', 'AZURE_*', 'GCP_*', 'STRIPE_*',
  ],
  per_lane: {},
};

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function configPath(repoRoot) {
  return join(pathsFor(repoRoot).state, 'config', 'worker-env.json');
}

export async function readWorkerEnvConfig(repoRoot) {
  const p = configPath(repoRoot);
  if (!(await exists(p))) {
    return { ...structuredClone(DEFAULT_WORKER_ENV_CONFIG), __source: 'default' };
  }
  try {
    const cfg = JSON.parse(await readFile(p, 'utf8'));
    if (cfg.schemaVersion !== 1) cfg.schemaVersion = 1;
    if (!Array.isArray(cfg.default_allow)) cfg.default_allow = DEFAULT_WORKER_ENV_CONFIG.default_allow.slice();
    if (!Array.isArray(cfg.default_deny_secrets)) cfg.default_deny_secrets = DEFAULT_WORKER_ENV_CONFIG.default_deny_secrets.slice();
    if (!cfg.per_lane || typeof cfg.per_lane !== 'object') cfg.per_lane = {};
    cfg.__source = 'file';
    return cfg;
  } catch (err) {
    return { ...structuredClone(DEFAULT_WORKER_ENV_CONFIG), __source: `default-on-parse-error:${err.message}` };
  }
}

export async function writeWorkerEnvConfig(repoRoot, cfg) {
  const p = configPath(repoRoot);
  await mkdir(dirname(p), { recursive: true });
  const clean = {
    schemaVersion: 1,
    default_allow: Array.isArray(cfg.default_allow) ? cfg.default_allow : DEFAULT_WORKER_ENV_CONFIG.default_allow.slice(),
    default_deny_secrets: Array.isArray(cfg.default_deny_secrets) ? cfg.default_deny_secrets : DEFAULT_WORKER_ENV_CONFIG.default_deny_secrets.slice(),
    per_lane: cfg.per_lane && typeof cfg.per_lane === 'object' ? cfg.per_lane : {},
  };
  await writeFile(p, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

// Glob-ish pattern: matches if pattern equals var, or pattern is `PFX_*`
// and var starts with `PFX_`.
export function patternMatches(pattern, varName) {
  if (!pattern || !varName) return false;
  if (pattern === varName) return true;
  if (pattern.endsWith('_*')) {
    const prefix = pattern.slice(0, -1); // includes the trailing _
    return varName.startsWith(prefix);
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return varName.startsWith(prefix);
  }
  return false;
}

function anyPatternMatches(patterns, varName) {
  for (const p of patterns) if (patternMatches(p, varName)) return true;
  return false;
}

// Pure filter: given an env object and a config, return
// `{ env: filteredEnv, allowed: string[], denied: string[] }`. Allowed
// vars retain their values. Denied vars are dropped entirely.
//
// Resolution order (per spawn):
//   1. If var matches `default_deny_secrets` AND is NOT in
//      `per_lane[<lane>].allow` (operator opt-in), it is DENIED.
//   2. If var matches `default_allow` OR `per_lane[<lane>].allow`, it is
//      ALLOWED.
//   3. Otherwise DENIED (default-deny).
//
// Inject keys (added by spawnWorker AFTER filtering) bypass filtering —
// MADDU_* is in the allowlist by default anyway.
export function filterEnvForWorker(rawEnv, cfg, lane) {
  const allowed = [];
  const denied = [];
  const out = {};
  const laneCfg = (lane && cfg.per_lane && cfg.per_lane[lane]) || null;
  const laneAllow = (laneCfg && Array.isArray(laneCfg.allow)) ? laneCfg.allow : [];
  for (const key of Object.keys(rawEnv || {})) {
    // Step 1: secret-deny unless operator opted in per-lane.
    const isSecret = anyPatternMatches(cfg.default_deny_secrets, key);
    if (isSecret && !anyPatternMatches(laneAllow, key)) {
      denied.push(key);
      continue;
    }
    // Step 2: allowed by default or per-lane.
    if (anyPatternMatches(cfg.default_allow, key) || anyPatternMatches(laneAllow, key)) {
      out[key] = rawEnv[key];
      allowed.push(key);
      continue;
    }
    // Step 3: default-deny.
    denied.push(key);
  }
  return { env: out, allowed, denied };
}

// Convenience: add a key to a lane's allowlist.
export async function envAllow(repoRoot, varName, lane) {
  const cfg = await readWorkerEnvConfig(repoRoot);
  if (!lane) {
    // Global allow: add to default_allow.
    if (!cfg.default_allow.includes(varName)) cfg.default_allow.push(varName);
  } else {
    cfg.per_lane[lane] = cfg.per_lane[lane] || { allow: [] };
    if (!Array.isArray(cfg.per_lane[lane].allow)) cfg.per_lane[lane].allow = [];
    if (!cfg.per_lane[lane].allow.includes(varName)) cfg.per_lane[lane].allow.push(varName);
  }
  await writeWorkerEnvConfig(repoRoot, cfg);
  return cfg;
}
