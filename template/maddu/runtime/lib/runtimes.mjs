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
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES, genWorkerId } from './spine.mjs';

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
    notes: ''
  };
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
  const env = { ...process.env, MADDU_WORKER_ID: workerId, MADDU_BRIDGE_URL: opts.bridgeUrl || 'http://127.0.0.1:4177', MADDU_RUNTIME: name };
  if (opts.session) env.MADDU_SESSION_ID = opts.session;
  if (opts.lane) env.MADDU_LANE = opts.lane;

  let child, pid = null, error = null;
  try {
    child = spawn(r.binary, args, {
      cwd, env, stdio: ['ignore', logFh.fd, logFh.fd], detached: true
    });
    pid = child.pid;
    child.unref();
  } catch (err) {
    error = err.message;
  } finally {
    try { await logFh.close(); } catch {}
  }

  // Either way, record the spawn intent in the spine.
  await append(repoRoot, {
    type: EVENT_TYPES.WORKER_SPAWNED,
    actor: opts.session || null,
    lane: opts.lane || null,
    data: { id: workerId, command: r.binary, args, pid, runtime: name, log: logPath, sessionId: opts.session || null, error }
  });
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
