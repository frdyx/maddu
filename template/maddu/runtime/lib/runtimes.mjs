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

import { access, constants as fsConstants, lstat, mkdir, readFile, readdir, stat, writeFile, unlink, open } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES, genWorkerId, normalizeParentId, isRefId } from './spine.mjs';
import { readWorkerEnvConfig, filterEnvForWorker } from './worker-env.mjs';
import { redactSpawn, redactLeaves } from './secret-scan.mjs';
import { isValidAuthority } from './pricing.mjs';

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
const PROBE_KILL_SETTLE_MS = 3000;      // probe settlement deadline from kill initiation
const PROBE_TASKKILL_TIMEOUT_MS = 5000; // bound on the taskkill invocation itself
const pExecFile = promisify(execFile);

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
    // v1.118.0 (S4 cost provenance) — optional pricing authority: the
    // lowercase hostname the runtime's workers actually call (e.g.
    // 'api.anthropic.com'). Forwarded as MADDU_PRICING_AUTHORITY so wrappers
    // can stamp a provable pricingIdentity on TOKEN_USAGE_REPORTED. Null =
    // unknown endpoint → rows stay honestly unpriced. Descriptors are
    // load/saved unvalidated, so the grammar is enforced at the spawn seam:
    // an invalid hand-edited value is NOT injected (omission + one-line
    // diagnostic — pricing must never block work).
    authority: null,
    notes: ''
  };
}

// Internal helper for Phase 3 autoRegister spawns. Emits
// SESSION_AUTO_REGISTERED with source:'spawn' and parentSessionId set
// to the caller's session id. Returns the new child session id, ready
// to be threaded into the spawned worker's env.
// v1.111.0: routed through the close-locked uniqueness transaction (all
// four production registration appenders share it — generated ids are
// existence-checked with a bounded regenerate; the makeEvent factory
// receives the FINAL id so data.sessionId is always correct).
async function registerChildSession(repoRoot, parentSessionId, runtimeName, label) {
  // CP5 (PR-B): grammar + existence on the spawn-supplied parent. verify.mjs
  // FAILs a dangling parentSessionId, so a malformed/nonexistent parent is
  // dropped to null here (ever-registered proj.sessions incl. closed).
  let parent = normalizeParentId(parentSessionId);
  if (parent) {
    try {
      const { project } = await import('./projections.mjs');
      const proj = await project(repoRoot);
      if (!new Set((proj.sessions || []).map((s) => s.id)).has(parent)) parent = null;
    } catch { /* projection read failed → keep parent; verify is the backstop */ }
  }
  const makeEvent = (sessionId) => ({
    type: EVENT_TYPES.SESSION_AUTO_REGISTERED,
    actor: sessionId,
    lane: null,
    data: {
      sessionId,
      parentSessionId: parent,
      source: 'spawn',
      label: label || `${runtimeName} worker`,
      role: 'implementer',
      runtime: runtimeName
    }
  });
  const { registerSessionUnique } = await import('./session-lifecycle.mjs');
  const r = await registerSessionUnique(repoRoot, { makeEvent });
  if (r.status !== 'registered') {
    throw new Error(`child session registration failed: ${r.status}`);
  }
  return r.sessionId;
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

// Like readRuntime, but absence and damage are DIFFERENT answers. A caller
// deciding "no descriptor → use my own default" must not make that decision
// on a descriptor that exists and cannot be read/parsed — silently probing a
// fallback command against a corrupt registration answers a different
// question than the operator asked (harness-parity funnel r1 #1).
export async function readRuntimeStrict(repoRoot, name) {
  const p = join(runtimesDir(repoRoot), `${name}.json`);
  let text;
  try {
    text = await readFile(p, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { descriptor: null, missing: true, unreadable: false };
    return { descriptor: null, missing: false, unreadable: true };
  }
  try {
    const parsed = JSON.parse(text);
    // A descriptor is an OBJECT. `null`, a scalar, or an array parse cleanly
    // but are damage, not a registration — falling back to a default probe on
    // them answers a different question than the operator asked (funnel PR1
    // r4 #2).
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { descriptor: null, missing: false, unreadable: true };
    }
    return { descriptor: parsed, missing: false, unreadable: false };
  } catch {
    return { descriptor: null, missing: false, unreadable: true };
  }
}

export async function saveRuntime(repoRoot, patch, by = null) {
  if (!patch.name) throw new Error('runtime name required');
  await ensureDir(runtimesDir(repoRoot));
  const existing = await readRuntime(repoRoot, patch.name);
  const next = mergeDescriptor(existing || defaultDescriptor(patch.name), patch);
  next.updatedAt = new Date().toISOString();
  if (!existing) next.createdAt = next.updatedAt;
  // Write-boundary redaction: a descriptor can carry a secret-shaped value in a
  // config field. Value-pattern scrub only — config field NAMES + short values
  // (e.g. `clientSecretEnvVar`) are preserved.
  await writeFile(join(runtimesDir(repoRoot), `${next.name}.json`), JSON.stringify(redactLeaves(next), null, 2) + '\n');
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
  // Write-boundary redaction: health carries buffered subprocess stdout/stderr
  // (detectRuntime) which can echo a secret. Value-pattern scrub only.
  await writeFile(healthFile(repoRoot), JSON.stringify(redactLeaves(h), null, 2) + '\n');
}

// --- Side-effect-free probe (harness-parity PR1) -------------------------
//
// `detectRuntime` below both PROBES and PERSISTS (health projection +
// RUNTIME_DETECTED append). Callers that only want to know what is installed —
// `runtime doctor`, which owns its own event and its own projection — must not
// be forced to write another surface's state as a side effect of asking. So the
// subprocess half lives here, pure: it spawns, reads, and returns. Nothing
// else. `detectRuntime` keeps its persistence layered on top, byte-for-byte
// unchanged in behaviour.
//
// SHELL-FREE BY DEFAULT. `shell: false` (the default) resolves the command
// against PATH ourselves and spawns the resolved file with an argv array, so a
// command name can never be re-parsed as a command line. That resolution is
// also what makes `notFound` DEFINITIVE: if no file matched on PATH, the binary
// genuinely is not installed. Under `shell: true` (the legacy descriptor path,
// where `detect.command` is a whole command line) a missing binary is
// indistinguishable from a failing one — the shell reports its own exit code —
// so `notFound` is never set there, and no caller may infer "not installed".

// Resolve a bare command name to a concrete file, the way a shell would, but
// without one.
//
// Windows needs PATHEXT: the CLIs Máddu probes (`claude`, `codex`, `gemini`)
// install as `.cmd` shims, and Node's shell-free spawn looks only for an exact
// filename — so a plain spawn('codex') reports ENOENT on a machine where codex
// is installed and working. Resolving here means a Windows probe reports what
// is actually true instead of a false 'not-installed'.
//
// The DETAILED variant also reports whether the search was CONCLUSIVE: a stat
// that fails with anything other than "definitely nothing there" (an EACCES
// PATH component, say) means "nothing found" is NOT proof of absence — the
// caller must hold the reading back instead of recording 'not-installed'
// (funnel PR1 r5 #3). ENOENT/ENOTDIR keep their classic PATH-walk meaning of
// "this candidate simply isn't there".
export async function resolveCommandPathDetailed(command, env = process.env) {
  if (typeof command !== 'string' || !command) return { path: null, inconclusive: false };
  const win = process.platform === 'win32';
  const exts = win
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.trim()).filter(Boolean)
    : [];
  const withExtensions = (base) => {
    if (!win) return [base];
    const out = [];
    if (extname(base)) out.push(base);            // caller already named the extension
    for (const e of exts) out.push(base + e);
    if (!extname(base)) out.push(base);           // extension-less file (rare, but legal)
    return out;
  };
  // A command carrying a path separator is a path, not a PATH lookup.
  const hasSeparator = command.includes('/') || command.includes('\\');
  let bases;
  let sawError = false;
  if (hasSeparator || isAbsolute(command)) {
    bases = [resolvePath(command)];
  } else {
    const rawPath = env.PATH ?? env.Path;
    if (typeof rawPath !== 'string' || rawPath === '') {
      // No search path at all: the walk never happened, so "nothing found"
      // would be a conclusion without a search (funnel r7 #2).
      return { path: null, inconclusive: true };
    }
    // An EMPTY PATH component has a defined meaning — the current directory —
    // so it is preserved as '.', never filtered away (funnel r7 #2).
    bases = rawPath.split(delimiter).map((d) => join(d === '' ? '.' : d, command));
  }
  for (const base of bases) {
    for (const cand of withExtensions(base)) {
      try {
        if ((await stat(cand)).isFile()) {
          // POSIX PATH semantics skip a NON-EXECUTABLE candidate and keep
          // searching — a non-executable `codex` early in PATH must not
          // shadow a working one later (funnel r7 #1). If nothing executable
          // turns up, the skipped candidate makes the walk inconclusive
          // (a broken install is not clean absence). Windows has no X_OK.
          if (process.platform !== 'win32') {
            try {
              await access(cand, fsConstants.X_OK);
            } catch {
              sawError = true;
              continue;
            }
          }
          return { path: cand, inconclusive: false };
        }
      } catch (e) {
        if (e?.code === 'ENOENT') {
          // stat follows symlinks: a DANGLING link stats ENOENT although an
          // entry exists — a broken installation, not clean absence
          // (funnel r6 #3). lstat is the tiebreaker, and ITS errors must not
          // read as absence either: only a definitive nothing-there
          // (ENOENT/ENOTDIR) keeps the walk conclusive (funnel r8 #2).
          try {
            await lstat(cand);
            sawError = true;
          } catch (le) {
            if (le?.code !== 'ENOENT' && le?.code !== 'ENOTDIR') sawError = true;
          }
        } else if (e?.code !== 'ENOTDIR') {
          sawError = true;
        }
      }
    }
  }
  return { path: null, inconclusive: sawError };
}

export async function resolveCommandPath(command, env = process.env) {
  return (await resolveCommandPathDetailed(command, env)).path;
}

// Probe a command and report what happened. NEVER writes anything.
//
//   probeRuntime({ command: 'codex', args: ['--version'] })            shell-free
//   probeRuntime({ command: 'codex --version', shell: true })          legacy command line
//
// Returns { command, args, shell, resolvedPath, ok, exitCode, stdout, stderr,
//           notFound, timedOut, errorCode, throwMessage, at }.
//   notFound     — shell-free only: PATH resolution found nothing, or the spawn
//                  itself reported ENOENT. This is the ONLY definitive
//                  "not installed" signal.
//   timedOut     — the probe was killed at `timeoutMs`; the exit code is
//                  whatever the kill produced, and says nothing about the CLI.
//   throwMessage — spawn threw synchronously (an async 'error' event instead
//                  resolves exit code -1, matching the legacy detect path).
export async function probeRuntime(spec = {}) {
  const {
    command = null,
    args = [],
    shell = false,
    timeoutMs = DEFAULT_DETECT_TIMEOUT_MS,
    expectExit = 0,
    env = process.env,
    cwd = undefined,
  } = spec;
  const result = {
    command, args: Array.isArray(args) ? [...args] : [], shell: !!shell, resolvedPath: null,
    ok: false, exitCode: null, stdout: '', stderr: '',
    notFound: false, timedOut: false, errorCode: null, throwMessage: null,
    at: new Date().toISOString(),
  };
  if (!command) {
    if (!shell) result.notFound = true;
    return result;
  }

  let target = command;
  let argv = result.args;
  let viaComSpec = false;
  if (!shell) {
    const det = await resolveCommandPathDetailed(command, env);
    if (!det.path) {
      if (det.inconclusive) {
        // The PATH walk hit an error it could not see through — "nothing
        // found" is not proof of absence here (funnel PR1 r5 #3).
        result.errorCode = 'PATH-UNREADABLE';
        result.exitCode = -1;
        return result;
      }
      result.notFound = true;
      return result;
    }
    const resolved = det.path;
    result.resolvedPath = resolved;
    const ext = extname(resolved).toLowerCase();
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      // A batch shim can only be executed by the command processor, and the
      // `/s /c` tail has to be built as ONE correctly quoted string under
      // windowsVerbatimArguments — letting libuv quote a spaced shim path
      // per-argv-entry breaks cmd's own quote stripping ('C:\Program' is not
      // recognized — funnel r2 #4). EVERY part is quoted, not just spaced
      // ones: an unquoted `&`, `^`, or `(` in a path like C:\tools&sdk would
      // be reparsed as cmd syntax (funnel r8 #3). Inside double quotes those
      // are literal — what can NEVER be represented safely is the quote
      // itself, `%` (expands even quoted), and `!` (expands under
      // registry-enabled delayed expansion), so those are REFUSED as an
      // honest probe failure, never interpolated.
      const parts = [resolved, ...result.args].map(String);
      if (parts.some((p) => /["%!]/.test(p))) {
        result.errorCode = 'UNQUOTABLE';
        result.exitCode = -1;
        return result;
      }
      const inner = parts.map((p) => `"${p}"`).join(' ');
      target = env.ComSpec || env.COMSPEC || 'cmd.exe';
      argv = ['/d', '/s', '/c', `"${inner}"`];
      viaComSpec = true;
    } else {
      target = resolved;
    }
  }

  try {
    // POSIX children get their own process GROUP so a timeout can kill the
    // whole tree — killing only the immediate shell leaves descendants alive
    // and the close event pending, hanging the probe past its budget (funnel
    // PR1 r3 #1; same pattern as verify-replay). Windows uses taskkill /T.
    const child = spawn(target, argv, {
      shell: !!shell, cwd, env,
      windowsVerbatimArguments: viaComSpec,
      detached: process.platform !== 'win32',
    });
    // Retention is CAPPED AT READ TIME while both pipes keep draining — a
    // noisy or hostile CLI must not grow memory until the timeout
    // (funnel r9 #5). The final result slices to 2000 as before.
    const RETAIN = 4096;
    let stdout = '', stderr = '';
    // The cap is enforced per append — a below-threshold check alone would
    // let one large final chunk overshoot by its full size (funnel r10 #2).
    child.stdout?.on('data', (b) => {
      if (stdout.length < RETAIN) stdout += b.toString('utf8').slice(0, RETAIN - stdout.length);
    });
    child.stderr?.on('data', (b) => {
      if (stderr.length < RETAIN) stderr += b.toString('utf8').slice(0, RETAIN - stderr.length);
    });
    let timedOut = false;
    let settleTimer = null;
    let settled = false;
    // A detached POSIX probe no longer receives the terminal's SIGINT: if the
    // operator interrupts the doctor mid-probe, the group must not be left
    // orphaned (funnel r5 #1). Transient handlers kill the group and re-raise;
    // they are removed on every settlement path.
    let dropSignalCleanup = null;
    if (process.platform !== 'win32') {
      const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const handlers = ['SIGINT', 'SIGTERM'].map((sig) => {
        // Whether OTHER listeners exist is captured BEFORE registering the
        // transient one — at fire time our once-handler has already been
        // removed, so a listener count taken then can read 0 even though
        // other handlers existed and already ran on the original signal
        // (funnel r6 #1, r8 #1). Re-raise only when no other listener existed
        // at registration AND none was added since.
        const hadOthers = process.listenerCount(sig) > 0;
        const h = () => {
          killGroup();
          if (!hadOthers && process.listenerCount(sig) === 0) process.kill(process.pid, sig);
        };
        process.once(sig, h);
        return [sig, h];
      });
      process.on('exit', killGroup);
      dropSignalCleanup = () => {
        for (const [sig, h] of handlers) process.removeListener(sig, h);
        process.removeListener('exit', killGroup);
      };
    }
    const code = await new Promise((resolve) => {
      const done = (c) => {
        if (settled) return;
        settled = true;
        // Release our ends of the pipes and detach from the child on EVERY
        // settlement path — a killed-but-unreaped descendant holding the
        // inherited pipe must not keep this process (or a test runner)
        // alive after the deadline resolved the probe (funnel PR1 r4 #1).
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        try { child.unref?.(); } catch {}
        try { dropSignalCleanup?.(); } catch {}
        resolve(c);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        // Settlement deadline from KILL INITIATION: even a kill that fails to
        // reap every descendant cannot hold the probe open forever.
        settleTimer = setTimeout(() => done(null), PROBE_KILL_SETTLE_MS);
        (async () => {
          try {
            if (process.platform === 'win32') {
              await pExecFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: PROBE_TASKKILL_TIMEOUT_MS });
            } else {
              process.kill(-child.pid, 'SIGKILL');
            }
          } catch {
            try { child.kill('SIGKILL'); } catch {}
          }
        })();
      }, timeoutMs);
      child.on('error', (err) => { result.errorCode = err?.code || null; clearTimeout(timer); done(-1); });
      child.on('close', (c) => { clearTimeout(timer); done(c); });
    });
    if (settleTimer) clearTimeout(settleTimer);
    result.timedOut = timedOut;
    result.exitCode = code;
    result.stdout = stdout.trim().slice(0, 2000);
    result.stderr = stderr.trim().slice(0, 2000);
    // expectExit is normalized HERE, once, so every caller (doctor probes and
    // detectRuntime alike) reads a descriptor's declared exit the same way —
    // a string '0' must not verify under one and fail under the other
    // (funnel PR1 r3 #2). Only an integer counts; anything else means 0.
    // A timed-out probe is NEVER ok, even if the kill raced a clean exit —
    // ok:true + timedOut:true is a contradiction no caller should ever see
    // (funnel PR1 r4 #1).
    const wantExit = Number.isInteger(expectExit) ? expectExit : 0;
    result.ok = !timedOut && code === wantExit;
    // A post-spawn ENOENT NEVER establishes absence: by this point resolution
    // has already PROVEN a file exists at the resolved path. On POSIX, execve
    // returns ENOENT for an existing script whose shebang interpreter is
    // missing — a broken installation, not an absent one (funnel r5 #2; the
    // ComSpec variant of the same trap was r1 #3). The ONLY source of
    // `notFound` is the resolution walk finding nothing, conclusively.
  } catch (err) {
    result.throwMessage = err.message;
  }
  return result;
}

export async function detectRuntime(repoRoot, name, by = null) {
  const r = await readRuntime(repoRoot, name);
  if (!r) throw new Error(`runtime ${name} not found`);
  const cmd = r.detect?.command || (r.binary ? `${r.binary} --version` : null);
  const result = { name, command: cmd, ok: false, exitCode: null, stdout: '', stderr: '', error: null, at: new Date().toISOString() };
  if (!cmd) {
    result.error = 'no detect.command and no binary defined';
  } else {
    // A descriptor's `detect.command` is a whole COMMAND LINE, so it keeps
    // running through a shell exactly as it always has. Only the spawn/collect
    // mechanics moved into probeRuntime.
    const probe = await probeRuntime({ command: cmd, shell: true, expectExit: r.detect?.expectExit ?? 0 });
    result.exitCode = probe.exitCode;
    result.stdout = probe.stdout;
    result.stderr = probe.stderr;
    result.ok = probe.ok;
    if (probe.throwMessage) result.error = probe.throwMessage;
    if (result.ok && result.stdout) result.version = result.stdout.split('\n')[0].slice(0, 80);
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
  // v1.5.0 — the worker's task, exposed as a SAFE env channel (never shell-
  // interpolated). A runtime descriptor/wrapper can read MADDU_TASK instead of
  // taking the task through argv — the injection-safe way to pass an
  // agent-supplied prompt on the Windows shell-spawn path.
  if (typeof opts.task === 'string' && opts.task) env.MADDU_TASK = opts.task;
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
  // v1.118.0 (S4 cost provenance) — descriptor-declared pricing authority,
  // grammar-checked HERE because descriptors load unvalidated. Invalid value
  // → omit + one-line diagnostic, never refuse the spawn (pricing must never
  // block work). Wrappers stamp pricingIdentity only when this env is present
  // AND the model is parser-proven — so a row's identity is always provable.
  // Funnel r1-F1: the parent's own MADDU_PRICING_AUTHORITY survives the
  // MADDU_* env allowlist above, so a nested worker routed through a
  // DIFFERENT endpoint would inherit the parent's authority and be silently
  // mispriced against the wrong manifest entry. Scrub unconditionally; only
  // what THIS descriptor proves is ever injected.
  delete env.MADDU_PRICING_AUTHORITY;
  if (r.authority != null) {
    if (isValidAuthority(r.authority)) env.MADDU_PRICING_AUTHORITY = r.authority;
    else process.stderr.write(`maddu: runtime "${name}" has invalid pricing authority ${JSON.stringify(r.authority)} — MADDU_PRICING_AUTHORITY not injected\n`);
  }

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
  // CP3 (r4-2): a fresh child session supersedes the inherited env; otherwise
  // the child inherits process.env.MADDU_SESSION_ID via the env spread above
  // (MADDU_* is allow-listed). Scrub it if it is malformed, so a nonconforming
  // parent id is never handed to the child as an actor identity — a valid
  // inherited id legitimately continues the parent session.
  if (effectiveSession) env.MADDU_SESSION_ID = effectiveSession;
  else if (!isRefId(env.MADDU_SESSION_ID)) delete env.MADDU_SESSION_ID;
  if (opts.lane) env.MADDU_LANE = opts.lane;

  let child, pid = null, error = null;
  // v0.19 Phase 1 — if the descriptor opts in to a wrapper, spawn:
  //   node <wrapper-script> <real-binary> [args...]
  // The wrapper tees stdout transparently to the same log fd while
  // parsing token-usage frames out of the provider stream.
  const wrapperPath = wrapperPathFor(r);
  const spawnBinary = wrapperPath ? process.execPath : r.binary;
  const spawnArgs = wrapperPath ? [wrapperPath, r.binary, ...args] : args;
  // v1.5.0 — wait mode. Synchronous drivers (the coordinator, a team
  // fan-out) need to spawn a worker and await its exit to use the exit code
  // as the phase/lane result. In that mode we do NOT detach/unref, and we
  // emit a real WORKER_EXITED on completion (not just on spawn error). The
  // default (fire-and-forget, detached) path is unchanged.
  const waitForExit = !!opts.wait;
  // Windows: runtime binaries are usually .cmd/.ps1 shims (claude, codex, npm),
  // which Node's spawn can't exec without a shell. Use shell:true on win32 for
  // the DIRECT binary path — but NOT when a wrapper is used, since that path is
  // `node <wrapper-script>` (node is a real exe) and the wrapper/cwd paths often
  // contain spaces that shell-quoting would mangle. Mirrors the npm-family
  // shell:true fix (v1.1.1) for the worker-spawn path.
  const useShell = process.platform === 'win32' && !wrapperPath;
  // v1.5.0 — SECURE task delivery: an agent-supplied task is piped to the
  // worker's STDIN, never placed in argv. This is the injection-safe channel
  // (a task with shell metacharacters can't escape into the command line under
  // shell:true). `claude -p` / `codex exec` read the prompt from stdin. The task
  // is also in env MADDU_TASK. Callers pass `opts.task`, not an argv arg.
  const taskStdin = (typeof opts.task === 'string' && opts.task.length > 0) ? opts.task : null;
  let exitPromise = null;
  try {
    child = spawn(spawnBinary, spawnArgs, {
      cwd, env, stdio: [taskStdin ? 'pipe' : 'ignore', logFh.fd, logFh.fd], detached: !waitForExit, shell: useShell
    });
    pid = child.pid;
    // Feed the task to stdin then close it, so the worker can start. Guard
    // against EPIPE if the process exits before reading.
    if (taskStdin && child.stdin) {
      child.stdin.on('error', () => {});
      try { child.stdin.write(taskStdin); child.stdin.end(); } catch {}
    }
    // Attach exit/error handlers SYNCHRONOUSLY — before any await — so an early
    // spawn 'error' event (e.g. ENOENT on a missing binary) is handled, not
    // thrown as an uncaught exception that crashes the process.
    if (waitForExit) {
      exitPromise = new Promise((resolve) => {
        child.on('exit', (code) => resolve(code == null ? -1 : code));
        child.on('error', () => resolve(-1));
      });
    } else {
      child.on('error', () => {}); // detached fire-and-forget: never let it throw
      child.unref();
    }
  } catch (err) {
    error = err.message;
  } finally {
    try { await logFh.close(); } catch {}
  }

  // Either way, record the spawn intent in the spine. For autoRegister
  // descriptors the actor and sessionId are the freshly-minted child
  // session id (not the caller's) — that's how the cockpit reads the
  // fan-out as a tree instead of a flat list keyed by parent.
  // Scrub command/args before persisting — no-op on clean text (r.binary +
  // runtime flags), redacts a secret-shaped value a caller slipped into
  // extraArgs. The prompt itself rides via stdin and is never logged.
  const spawnRec = redactSpawn({ command: r.binary, args });
  await append(repoRoot, {
    type: EVENT_TYPES.WORKER_SPAWNED,
    actor: effectiveSession,
    lane: opts.lane || null,
    data: { id: workerId, command: spawnRec.command, args: spawnRec.args, pid, runtime: name, log: logPath, sessionId: effectiveSession, wrapper: wrapperPath ? (r.wrapper || 'custom') : null, modelHint: resolvedHint || null, stage: opts.stage || null, error }
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
    return { workerId, pid, log: logPath, error, exitCode: -1 };
  }

  // v1.5.0 — wait mode: await the worker's exit (handlers attached at spawn
  // time above) and emit a real WORKER_EXITED carrying the actual exit code,
  // so callers can branch on success/failure.
  if (waitForExit && child && exitPromise) {
    const exitCode = await exitPromise;
    await append(repoRoot, {
      type: EVENT_TYPES.WORKER_EXITED,
      actor: effectiveSession, lane: opts.lane || null,
      data: { id: workerId, exitCode, runtime: name, sessionId: effectiveSession }
    });
    return { workerId, pid, log: logPath, error: null, exitCode };
  }

  return { workerId, pid, log: logPath, error };
}
