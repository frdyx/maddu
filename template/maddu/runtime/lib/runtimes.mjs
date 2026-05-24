// Runtime adapters — pluggable subprocess workers (claude exec, codex exec,
// Hermes, AionUi, future agents) registered via a JSON descriptor.
//
// Files-only:
//   .maddu/runtimes/<name>.json     — canonical descriptor per adapter
//   .maddu/state/runtime-health.json — projection of last detection result
//
// Máddu never imports a runtime's library. It only reads the descriptor and
// spawns the subprocess. The spawned worker is expected to heartbeat back to
// /bridge/workers/<id>/heartbeat — that surface is shared with Slice 12 so
// runtime-spawned workers appear immediately in /swarm and the stuck-banner.

import { mkdir, readFile, readdir, stat, writeFile, unlink, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathsFor } from './paths.mjs';
import { randomBytes } from 'node:crypto';
import { append, EVENT_TYPES, genWorkerId } from './spine.mjs';
import { readWorkerEnvConfig, filterEnvForWorker } from './worker-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Built-in wrapper map. Descriptors carrying `wrapper: 'claude' | 'codex' |
// 'gemini'` route their spawn through the matching wrapper script which
// parses token usage out of the provider's stream-json (where available)
// and emits TOKEN_USAGE_REPORTED events. Wrappers live as standalone .mjs
// scripts so they execute inside the worker subprocess — hard rule #5
// stays preserved (framework code never imports a provider SDK).
const BUILTIN_WRAPPERS = {
  'claude':   join(__dirname, 'runtimes', 'claude-wrapper.mjs'),
  'codex':    join(__dirname, 'runtimes', 'codex-wrapper.mjs'),
  'gemini':   join(__dirname, 'runtimes', 'gemini-wrapper.mjs'),
  // v1.2.0 Phase 7 — Hermes Agent (Nous Research). First new runtime added
  // under the v1.2.0 trust rails — rides through the worker-env allowlist,
  // secret-scan argv, tool allowlist, and strict-mode approval gating with
  // zero special-case code in the spawn path.
  'hermes':   join(__dirname, 'runtimes', 'hermes-wrapper.mjs'),
};

function wrapperPathFor(descriptor) {
  if (!descriptor) return null;
  // Explicit absolute path wins.
  if (descriptor.wrapperPath) return descriptor.wrapperPath;
  // Named built-in lookup.
  const name = descriptor.wrapper || null;
  if (name && BUILTIN_WRAPPERS[name]) return BUILTIN_WRAPPERS[name];
  return null;
}

// v0.19 Phase 4 — model routing hint resolver.
//
// modelPreference shape (descriptor / lane / pipeline-stage):
//   string                                      — flat default
//   { default, plan?, exec?, verify?, review? } — per-stage override
//
// Valid stage keys (others rejected by the model-hint-shape gate):
export const VALID_MODEL_STAGES = ['default', 'plan', 'exec', 'verify', 'review'];

function pickFromPreference(pref, stage) {
  if (!pref) return null;
  if (typeof pref === 'string') return pref;
  if (typeof pref === 'object') {
    if (stage && typeof pref[stage] === 'string') return pref[stage];
    if (typeof pref.default === 'string') return pref.default;
  }
  return null;
}

// Resolve a model hint string given the precedence chain. Higher in the
// list wins. Returns null if no source provides a value.
//
//   resolveModelHint({
//     override: 'claude-haiku-4-5-20251001',    // 1. per-spawn CLI flag
//     pipelineStagePref: 'gpt-5',               // 2. pipeline stage
//     lanePref: 'claude-sonnet-4-5',            // 3. lane catalog entry
//     runtimePref: { default: 'claude-sonnet' },// 4. runtime descriptor
//     stage: 'exec',                            // which stage we're spawning for
//   })
export function resolveModelHint({ override, pipelineStagePref, lanePref, runtimePref, stage } = {}) {
  if (typeof override === 'string' && override.length > 0) return override;
  return pickFromPreference(pipelineStagePref, stage)
      || pickFromPreference(lanePref, stage)
      || pickFromPreference(runtimePref, stage)
      || null;
}

// Validate a modelPreference value. Returns array of error strings; empty
// = valid. Used by the model-hint-shape gate.
export function validateModelPreference(pref, where) {
  const errs = [];
  if (pref == null) return errs;
  if (typeof pref === 'string') {
    if (pref.length === 0) errs.push(`${where}: modelPreference is empty string`);
    return errs;
  }
  if (typeof pref !== 'object' || Array.isArray(pref)) {
    errs.push(`${where}: modelPreference must be string or object (got ${Array.isArray(pref) ? 'array' : typeof pref})`);
    return errs;
  }
  for (const [k, v] of Object.entries(pref)) {
    if (!VALID_MODEL_STAGES.includes(k)) {
      errs.push(`${where}: modelPreference has unknown stage key '${k}' (valid: ${VALID_MODEL_STAGES.join('|')})`);
    } else if (typeof v !== 'string' || v.length === 0) {
      errs.push(`${where}: modelPreference['${k}'] must be non-empty string (got ${typeof v})`);
    }
  }
  return errs;
}

const DESCRIPTOR_SCHEMA = 1;
const DEFAULT_DETECT_TIMEOUT_MS = 5000;

function runtimesDir(repoRoot) {
  return join(pathsFor(repoRoot).state, 'runtimes'); // .maddu/runtimes
}
function logsDir(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'worker-logs'); // .maddu/state/worker-logs
}
function healthFile(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'runtime-health.json');
}

async function ensureDir(p) { await mkdir(p, { recursive: true }); }

function defaultDescriptor(name) {
  return {
    schemaVersion: DESCRIPTOR_SCHEMA,
    name,
    kind: null,                 // null | 'reviewer' | future kinds; framework ignores when null
    displayName: name,
    binary: null,
    args: [],
    protocol: 'stdio-json',
    version: null,
    capabilities: {
      mcp: false,
      tools: false,
      streaming: false,
      approval: 'manual'
    },
    spawn: { env: [], cwd: '.' },
    detect: { command: null, expectExit: 0 },
    lanes: ['*'],
    // v0.17 Phase 3 — when true, spawnWorker auto-registers a child
    // session per spawn and threads its id through MADDU_SESSION_ID. The
    // child appears in sessionsTree under the caller's session, so a
    // parent that fans out N workers shows N distinct branches instead
    // of N events all stamped with the parent's actor id.
    autoRegister: false,
    // v0.19 Phase 1 — opt-in token-usage wrapper. When set, spawnWorker
    // routes the worker through a wrapper script that tees stdout and
    // parses token usage out of the stream. Null = no wrapper (legacy
    // behavior, descriptor untouched).
    //   wrapper:     name of built-in wrapper ('claude' | 'codex' | 'gemini')
    //   wrapperPath: absolute path to a custom wrapper .mjs (overrides built-in)
    wrapper: null,
    wrapperPath: null,
    // v0.19 Phase 4 — model routing preference. Worker decides whether
    // to honor it; framework only forwards as MADDU_MODEL_HINT env. May
    // also be a richer { default, plan, exec, verify, review } object;
    // the caller resolves a single string before spawning.
    modelPreference: null,
    notes: ''
  };
}

function genChildSessionId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `ses_${t}_${r}`;
}

// Internal helper for Phase 3 autoRegister spawns. Emits
// SESSION_AUTO_REGISTERED with source:'spawn' and parentSessionId set
// to the caller's session id. Returns the new child session id, ready
// to be threaded into the spawned worker's env.
async function registerChildSession(repoRoot, parentSessionId, runtimeName, label) {
  const sessionId = genChildSessionId();
  await append(repoRoot, {
    type: EVENT_TYPES.SESSION_AUTO_REGISTERED,
    actor: sessionId,
    lane: null,
    data: {
      sessionId,
      parentSessionId: parentSessionId || null,
      source: 'spawn',
      label: label || `${runtimeName} worker`,
      role: 'implementer',
      runtime: runtimeName
    }
  });
  return sessionId;
}

function mergeDescriptor(base, patch) {
  const out = { ...base, ...patch };
  out.capabilities = { ...(base.capabilities || {}), ...(patch.capabilities || {}) };
  out.spawn = { ...(base.spawn || {}), ...(patch.spawn || {}) };
  out.detect = { ...(base.detect || {}), ...(patch.detect || {}) };
  if (!Array.isArray(out.args)) out.args = [];
  if (!Array.isArray(out.lanes)) out.lanes = ['*'];
  return out;
}

export async function listRuntimes(repoRoot) {
  await ensureDir(runtimesDir(repoRoot));
  let entries;
  try { entries = await readdir(runtimesDir(repoRoot), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    try {
      const text = await readFile(join(runtimesDir(repoRoot), ent.name), 'utf8');
      out.push(JSON.parse(text));
    } catch {}
  }
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function readRuntime(repoRoot, name) {
  try {
    const text = await readFile(join(runtimesDir(repoRoot), `${name}.json`), 'utf8');
    return JSON.parse(text);
  } catch { return null; }
}

export async function saveRuntime(repoRoot, patch, by = null) {
  if (!patch.name) throw new Error('runtime name required');
  await ensureDir(runtimesDir(repoRoot));
  const existing = await readRuntime(repoRoot, patch.name);
  const next = mergeDescriptor(existing || defaultDescriptor(patch.name), patch);
  next.updatedAt = new Date().toISOString();
  if (!existing) next.createdAt = next.updatedAt;
  await writeFile(join(runtimesDir(repoRoot), `${next.name}.json`), JSON.stringify(next, null, 2) + '\n');
  await append(repoRoot, {
    type: EVENT_TYPES.RUNTIME_REGISTERED,
    actor: by, lane: null,
    data: { name: next.name, displayName: next.displayName, binary: next.binary, version: next.version }
  });
  return next;
}

export async function removeRuntime(repoRoot, name, by = null) {
  try { await unlink(join(runtimesDir(repoRoot), `${name}.json`)); } catch {}
  await append(repoRoot, {
    type: EVENT_TYPES.RUNTIME_REMOVED,
    actor: by, lane: null, data: { name }
  });
  // Strip from health projection too.
  try {
    const h = JSON.parse(await readFile(healthFile(repoRoot), 'utf8'));
    delete h[name];
    await writeFile(healthFile(repoRoot), JSON.stringify(h, null, 2) + '\n');
  } catch {}
}

async function readHealth(repoRoot) {
  try { return JSON.parse(await readFile(healthFile(repoRoot), 'utf8')); }
  catch { return {}; }
}

async function writeHealth(repoRoot, h) {
  await ensureDir(pathsFor(repoRoot).statePrjDir);
  await writeFile(healthFile(repoRoot), JSON.stringify(h, null, 2) + '\n');
}

export async function detectRuntime(repoRoot, name, by = null) {
  const r = await readRuntime(repoRoot, name);
  if (!r) throw new Error(`runtime ${name} not found`);
  const cmd = r.detect?.command || (r.binary ? `${r.binary} --version` : null);
  const result = { name, command: cmd, ok: false, exitCode: null, stdout: '', stderr: '', error: null, at: new Date().toISOString() };
  if (!cmd) {
    result.error = 'no detect.command and no binary defined';
  } else {
    try {
      const child = spawn(cmd, { shell: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, DEFAULT_DETECT_TIMEOUT_MS);
      const code = await new Promise((resolve) => {
        child.on('error', () => resolve(-1));
        child.on('close', (c) => resolve(c));
      });
      clearTimeout(timer);
      result.exitCode = code;
      result.stdout = stdout.trim().slice(0, 2000);
      result.stderr = stderr.trim().slice(0, 2000);
      result.ok = code === (r.detect?.expectExit ?? 0);
      if (result.ok && stdout.trim()) result.version = stdout.trim().split('\n')[0].slice(0, 80);
    } catch (err) {
      result.error = err.message;
    }
  }
  // Persist into health projection.
  const h = await readHealth(repoRoot);
  h[name] = result;
  await writeHealth(repoRoot, h);
  await append(repoRoot, {
    type: EVENT_TYPES.RUNTIME_DETECTED,
    actor: by, lane: null,
    data: { name, ok: result.ok, exitCode: result.exitCode, version: result.version || null }
  });
  return result;
}

export async function detectAll(repoRoot, by = null) {
  const all = await listRuntimes(repoRoot);
  const out = [];
  for (const r of all) {
    try { out.push(await detectRuntime(repoRoot, r.name, by)); }
    catch (err) { out.push({ name: r.name, ok: false, error: err.message }); }
  }
  return out;
}

export async function runtimesHealth(repoRoot) {
  return await readHealth(repoRoot);
}

// Spawn a subprocess worker using a runtime descriptor. The spawned process
// receives MADDU_WORKER_ID and MADDU_BRIDGE_URL env vars; it is expected to
// heartbeat via POST /bridge/workers/<id>/heartbeat.
//
// Output is captured to .maddu/state/worker-logs/<workerId>.log.
// The child is detached so it survives the bridge — caller is responsible
// for tracking via the workers projection.
export async function spawnWorker(repoRoot, name, opts = {}) {
  const r = await readRuntime(repoRoot, name);
  if (!r) throw new Error(`runtime ${name} not found`);
  if (!r.binary) throw new Error(`runtime ${name} has no binary`);
  await ensureDir(logsDir(repoRoot));
  const workerId = genWorkerId();
  const logPath = join(logsDir(repoRoot), `${workerId}.log`);
  const logFh = await open(logPath, 'a');
  const args = [...(r.args || []), ...(opts.extraArgs || [])];
  const cwd = opts.cwd || r.spawn?.cwd || process.cwd();
  // v1.2.0 Phase 2 — worker env allowlist. Filter `process.env` BEFORE
  // injecting MADDU_* bookkeeping vars. Default-deny known secret-keyed
  // vars (AWS_*, OPENAI_*, ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.); allow
  // a known-safe baseline (PATH, HOME, USER, LANG, NODE_*, MADDU_*).
  // Operator can extend per-lane via `maddu trust env-allow`.
  let envFilter;
  try {
    const envCfg = await readWorkerEnvConfig(repoRoot);
    envFilter = filterEnvForWorker(process.env, envCfg, opts.lane || null);
  } catch {
    envFilter = { env: { ...process.env }, allowed: Object.keys(process.env), denied: [] };
  }
  const env = {
    ...envFilter.env,
    MADDU_WORKER_ID: workerId,
    MADDU_BRIDGE_URL: opts.bridgeUrl || 'http://127.0.0.1:4177',
    MADDU_RUNTIME: name,
    // v0.19 Phase 1 — wrappers append TOKEN_USAGE_REPORTED directly into
    // the spine; they need the repo root explicitly because the worker
    // cwd may have been overridden by opts.cwd.
    MADDU_REPO_ROOT: repoRoot,
  };
  // v0.19 Phase 4 — model routing hint. Caller may resolve in advance
  // and pass opts.modelHint as a literal, OR pass the precedence inputs
  // (lanePref, pipelineStagePref, stage) and let spawnWorker resolve via
  // resolveModelHint(). Worker decides whether to honor the env value.
  const resolvedHint = typeof opts.modelHint === 'string' && opts.modelHint.length > 0
    ? opts.modelHint
    : resolveModelHint({
        override: opts.modelHintOverride || null,
        pipelineStagePref: opts.pipelineStagePref || null,
        lanePref: opts.lanePref || null,
        runtimePref: r.modelPreference || null,
        stage: opts.stage || null,
      });
  if (resolvedHint) env.MADDU_MODEL_HINT = resolvedHint;

  // v0.17 Phase 3 — runtime descriptors carrying autoRegister:true mint
  // a fresh child session per spawn (linked to opts.session as parent
  // when present). The child session id supersedes opts.session in the
  // env we hand to the spawned process; bookkeeping (WORKER_SPAWNED
  // actor, projection lookup) follows the new id so the harness sees
  // each spawn as its own identity. Descriptors without autoRegister
  // (i.e. all existing v0.16 runtimes) retain v0.16 semantics exactly.
  let effectiveSession = opts.session || null;
  if (r.autoRegister) {
    effectiveSession = await registerChildSession(
      repoRoot, opts.session || null, name,
      opts.label || `${name} worker ${workerId}`
    );
  }
  if (effectiveSession) env.MADDU_SESSION_ID = effectiveSession;
  if (opts.lane) env.MADDU_LANE = opts.lane;

  let child, pid = null, error = null;
  // v0.19 Phase 1 — if the descriptor opts in to a wrapper, spawn:
  //   node <wrapper-script> <real-binary> [args...]
  // The wrapper tees stdout transparently to the same log fd while
  // parsing token-usage frames out of the provider stream.
  const wrapperPath = wrapperPathFor(r);
  const spawnBinary = wrapperPath ? process.execPath : r.binary;
  const spawnArgs = wrapperPath ? [wrapperPath, r.binary, ...args] : args;
  try {
    child = spawn(spawnBinary, spawnArgs, {
      cwd, env, stdio: ['ignore', logFh.fd, logFh.fd], detached: true
    });
    pid = child.pid;
    child.unref();
  } catch (err) {
    error = err.message;
  } finally {
    try { await logFh.close(); } catch {}
  }

  // Either way, record the spawn intent in the spine. For autoRegister
  // descriptors the actor and sessionId are the freshly-minted child
  // session id (not the caller's) — that's how the cockpit reads the
  // fan-out as a tree instead of a flat list keyed by parent.
  await append(repoRoot, {
    type: EVENT_TYPES.WORKER_SPAWNED,
    actor: effectiveSession,
    lane: opts.lane || null,
    data: { id: workerId, command: r.binary, args, pid, runtime: name, log: logPath, sessionId: effectiveSession, wrapper: wrapperPath ? (r.wrapper || 'custom') : null, modelHint: resolvedHint || null, stage: opts.stage || null, error }
  });
  // v1.2.0 Phase 2 — WORKER_ENV_FILTERED event records what was allowed
  // and denied for this spawn. Denied list is KEYS ONLY — never values —
  // per the hard constraint on secret logging.
  try {
    await append(repoRoot, {
      type: EVENT_TYPES.WORKER_ENV_FILTERED,
      actor: effectiveSession,
      lane: opts.lane || null,
      data: {
        workerId,
        runtime: name,
        allowedCount: envFilter.allowed.length,
        denied: envFilter.denied,  // KEYS ONLY — values never logged
        deniedCount: envFilter.denied.length,
      },
    });
  } catch {}
  if (error) {
    // Mark as exited so projection reflects a failed spawn.
    await append(repoRoot, {
      type: EVENT_TYPES.WORKER_EXITED,
      actor: null, lane: null,
      data: { id: workerId, exitCode: -1, reason: error }
    });
  }
  return { workerId, pid, log: logPath, error };
}
