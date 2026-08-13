// harness-doctor.mjs (harness-parity PR1) — compare the capability manifest
// against what is actually installed, and put the comparison on the record.
//
// This is the OBSERVING half of cross-harness discipline. It enforces nothing
// and installs nothing: it probes for a CLI, looks at whether the harness's
// config files exist and whether they already carry a Máddu stanza, runs the
// manifest's pure comparison, appends ONE HARNESS_CAPABILITY_OBSERVED per
// harness, and refreshes a projection that is rebuildable from the spine.
// Adapters (later PRs) are what will act on any of it.
//
// WHAT IT WRITES, EXHAUSTIVELY: its own event on the STATE-root spine, and its
// own projection file. Nothing else. In particular it does NOT ride
// `detectRuntime`, which would write the runtime-health projection and append
// RUNTIME_DETECTED as a side effect of merely asking a question — hence the
// pure `probeRuntime` extracted alongside it in runtimes.mjs.
//
// ROOTS COME IN PAIRS. `workRoot` is the checkout whose repo-local harness
// configs are being inspected; `stateRoot` owns the descriptors, the spine, and
// the projection. Inside a lane worktree those differ, and reading configs from
// one while recording against the other is the whole point.

import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, readAll, EVENT_TYPES } from './spine.mjs';
import { withAppendLock } from './append-lock.mjs';
import { probeRuntime, readRuntimeStrict } from './runtimes.mjs';
import {
  HARNESS_CAPABILITIES,
  HARNESS_CAPABILITIES_VERSION,
  compareObserved,
  configCandidatesFor,
  extractVersion,
  getHarnessEntry,
  listHarnessNames,
  reduceHarnessCapabilities,
} from './harness-capabilities.mjs';

export const PROJECTION_LOCK_WAIT_MS = 3000;
export const PROJECTION_FILE = 'harness-capabilities.json';

// A harness config is scanned for the Máddu stanza marker, not parsed. The
// WHOLE file is scanned in fixed-size chunks with a marker-length overlap —
// bounded MEMORY, not bounded coverage: a stanza past any byte offset still
// counts (funnel r1 #6). The projection read below keeps a hard size bound
// instead, because a projection larger than that is not ours.
const CONFIG_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_PROJECTION_READ_BYTES = 512 * 1024;

export class UnknownHarnessError extends Error {
  constructor(name, validNames) {
    super(`unknown harness "${name}"`);
    this.name = 'UnknownHarnessError';
    this.harness = name;
    this.validNames = validNames;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function harnessCapabilitiesProjectionPath(stateRoot) {
  return join(pathsFor(stateRoot).statePrjDir, PROJECTION_FILE);
}

function projectionLockPath(stateRoot) {
  return join(pathsFor(stateRoot).statePrjDir, 'harness-capabilities.lock');
}

// Manifest config-path syntax: '~/x' is home-relative, anything else is
// work-root-relative. Absolute candidates are left alone.
export function resolveConfigCandidate(candidate, workRoot, home = homedir()) {
  if (typeof candidate !== 'string' || !candidate) return null;
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return resolvePath(join(home, candidate.slice(2)));
  }
  return resolvePath(join(workRoot, candidate));
}

// stat with the distinction the config observation needs: ENOENT is definitive
// absence; any other stat failure is an inspection failure, never absence.
async function statKind(p) {
  try {
    const s = await stat(p);
    return s.isFile() ? 'file' : 'not-file';
  } catch (err) {
    return err?.code === 'ENOENT' ? 'absent' : 'error';
  }
}

// Scan a file for a marker substring, whole file, fixed memory. Returns
// 'found' | 'not-found' | 'error'. The chunk overlap keeps a marker that
// straddles a chunk boundary visible.
async function scanFileForMarker(p, marker) {
  let fh = null;
  try {
    fh = await open(p, 'r');
    const buf = Buffer.alloc(CONFIG_SCAN_CHUNK_BYTES);
    let carry = '';
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CONFIG_SCAN_CHUNK_BYTES, pos);
      if (bytesRead <= 0) return 'not-found';
      const text = carry + buf.subarray(0, bytesRead).toString('utf8');
      if (text.includes(marker)) return 'found';
      carry = text.slice(-(marker.length - 1));
      pos += bytesRead;
    }
  } catch {
    return 'error';
  } finally {
    try { await fh?.close(); } catch {}
  }
}

async function readBounded(p) {
  let fh = null;
  try {
    fh = await open(p, 'r');
    const buf = Buffer.alloc(MAX_PROJECTION_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_PROJECTION_READ_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    try { await fh?.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

// Why a probe that ran did not produce a usable answer. Never conflated with
// "not installed" — a timeout or a permission error says nothing at all about
// whether the CLI is present, and reporting one as absence would be a
// confident wrong answer where an honest 'assumed' was available.
function probeFailureReason(probe) {
  if (probe.throwMessage) return 'spawn-error';
  if (probe.timedOut) return 'timeout';
  if (probe.errorCode === 'EACCES' || probe.errorCode === 'EPERM') return 'permission-denied';
  if (probe.errorCode) return `spawn-error:${probe.errorCode}`;
  if (!probe.ok) return 'nonzero-exit';
  return null;
}

// Run the probe for one harness.
//
// PRECEDENCE: a REGISTERED runtime descriptor (`.maddu/runtimes/<name>.json`)
// overrides only the probe's command EXPRESSION — its legacy `detect.command`
// is a command line and keeps running through a shell, exactly as `runtime
// detect` runs it. The manifest's `versionPattern` still parses the output
// either way, so the descriptor changes how we ask, never how we read the
// answer.
//
// A shell probe can never yield 'not-installed': the shell's own exit code is
// what comes back, so a missing binary and a failing one are the same
// observation. Only a shell-free probe whose PATH resolution found nothing is
// definitive.
async function probeHarness(stateRoot, entry, opts = {}) {
  let descriptor;
  if (opts.descriptor !== undefined) {
    descriptor = opts.descriptor;
  } else {
    // Absence and damage are different answers (funnel r1 #1): a MISSING
    // descriptor means "nothing registered — probe the manifest default"; a
    // descriptor that exists but cannot be read or parsed means the operator
    // registered SOMETHING, and probing a fallback command against a corrupt
    // registration could verify the wrong binary. That reading is held at
    // 'assumed' without running any probe at all.
    const strict = await readRuntimeStrict(stateRoot, entry.name)
      .catch(() => ({ descriptor: null, missing: false, unreadable: true }));
    if (strict.unreadable) {
      return {
        installed: true,
        version: null,
        probeFailure: 'descriptor-unreadable',
        probeSource: 'runtime-descriptor',
        probeCommand: null,
        resolvedPath: null,
        exitCode: null,
        rawOutput: '',
      };
    }
    descriptor = strict.descriptor;
  }
  const override = descriptor?.detect?.command;
  // A registered descriptor's expectExit is honored — it is the operator's
  // own registration semantics, read exactly the way `runtime detect` reads
  // it (funnel r2 #3, adjudicated: doctor and detect must not disagree about
  // the same registration). Hardening: only an INTEGER counts; any other
  // shape falls back to 0 rather than becoming a truthy surprise.
  const declaredExit = descriptor?.detect?.expectExit;
  const spec = (typeof override === 'string' && override)
    ? { command: override, shell: true, expectExit: Number.isInteger(declaredExit) ? declaredExit : 0 }
    : { command: entry.detect?.command || null, args: entry.detect?.args || [], shell: false };
  if (opts.timeoutMs) spec.timeoutMs = opts.timeoutMs;

  const probe = await probeRuntime(spec);
  const version = extractVersion(entry, probe.stdout) || extractVersion(entry, probe.stderr);
  const failure = probeFailureReason(probe);
  return {
    // `installed:false` ONLY when PATH resolution was definitive. Under a shell
    // probe `notFound` is never set, so this reads "not definitively absent".
    installed: !probe.notFound,
    version: version || null,
    probeFailure: probe.notFound ? null : failure,
    probeSource: spec.shell ? 'runtime-descriptor' : 'manifest',
    probeCommand: spec.command,
    resolvedPath: probe.resolvedPath,
    exitCode: probe.exitCode,
    rawOutput: probe.stdout || probe.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Config observation
// ---------------------------------------------------------------------------

// Per-candidate, in manifest order, nothing discarded. A candidate is scanned
// for the Máddu stanza only when the manifest declares it stanza-capable
// (`sentinel.files`); anything else that merely exists reads
// 'present-no-stanza'. Failure honesty (funnel r1 #6): only ENOENT is
// 'absent'; a candidate that exists but cannot be inspected — or whose stanza
// scan errors mid-read — reads 'unreadable', never a definitive claim in
// either direction. PR1 does no parsing of a foreign harness's config
// semantics beyond this substring scan.
export async function observeConfigs(entry, workRoot, { platform = process.platform, home = homedir() } = {}) {
  const candidates = configCandidatesFor(entry, platform);
  const scanSet = new Set(Array.isArray(entry?.sentinel?.files) ? entry.sentinel.files : []);
  const marker = entry?.sentinel?.marker || null;
  const out = [];
  for (const candidate of candidates) {
    const resolved = resolveConfigCandidate(candidate, workRoot, home);
    let status = 'absent';
    if (resolved) {
      const kind = await statKind(resolved);
      if (kind === 'error' || kind === 'not-file') {
        // SOMETHING occupies the path but it is not an inspectable config
        // file (a directory, a socket, an EACCES). Only a definitive ENOENT
        // may read 'absent' — that is the documented contract (funnel r4 #3).
        status = 'unreadable';
      } else if (kind === 'file') {
        status = 'present-no-stanza';
        if (marker && scanSet.has(candidate)) {
          const scan = await scanFileForMarker(resolved, marker);
          if (scan === 'found') status = 'stanza-present';
          else if (scan === 'error') status = 'unreadable';
        }
      }
    }
    out.push({ path: candidate, status, resolved });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The observation
// ---------------------------------------------------------------------------

// Probe + config read + pure comparison. WRITES NOTHING — the caller decides
// whether the observation gets recorded.
export async function observeHarness(roots, harnessName, opts = {}) {
  const { workRoot, stateRoot } = roots || {};
  const manifest = opts.manifest || HARNESS_CAPABILITIES;
  const entry = getHarnessEntry(harnessName, manifest);
  if (!entry) throw new UnknownHarnessError(harnessName, listHarnessNames(manifest));

  const detected = await probeHarness(stateRoot, entry, opts);
  const configs = await observeConfigs(entry, workRoot, opts);
  const compared = compareObserved(entry, detected);
  const firstPresent = configs.find((c) => c.status !== 'absent') || null;

  return {
    harness: entry.name,
    displayName: entry.displayName,
    manifestVersion: opts.manifestVersion || HARNESS_CAPABILITIES_VERSION,
    status: compared.status,
    cliVersion: compared.cliVersion,
    drift: compared.drift,
    probeFailure: compared.probeFailure,
    enforcementCeiling: compared.enforcementCeiling,
    capabilities: compared.capabilities,
    volatile: compared.volatile,
    verifiedAgainst: entry.verifiedAgainst,
    configPath: firstPresent ? firstPresent.path : null,
    configs,
    workRoot: workRoot || null,
    probeSource: detected.probeSource,
    probeCommand: detected.probeCommand,
    resolvedPath: detected.resolvedPath,
  };
}

// The event payload. `configs` is stripped to { path, status } — the resolved
// absolute paths stay in the CLI presentation, so the record carries no
// operator HOME directory. `workRoot` is the one machine path deliberately
// kept: it is the checkout-scoping coordinate, exactly as GATE_RAN carries it
// (v1.121.0), so a worktree's observation can never masquerade as the
// primary's (funnel r1 #4 — adjudicated: consistency with the shipped
// GATE_RAN precedent wins over path-free purity).
export function observationEventData(observation) {
  return {
    harness: observation.harness,
    status: observation.status,
    cliVersion: observation.cliVersion,
    manifestVersion: observation.manifestVersion,
    capabilities: observation.capabilities,
    enforcementCeiling: observation.enforcementCeiling,
    drift: observation.drift,
    probeFailure: observation.probeFailure,
    volatile: observation.volatile,
    configPath: observation.configPath,
    configs: (observation.configs || []).map((c) => ({ path: c.path, status: c.status })),
    workRoot: observation.workRoot,
  };
}

async function recordObservation(stateRoot, observation, by = null) {
  return append(stateRoot, {
    type: EVENT_TYPES.HARNESS_CAPABILITY_OBSERVED,
    actor: by,
    lane: null,
    data: observationEventData(observation),
  });
}

// ---------------------------------------------------------------------------
// Projection — serialized read/reduce/write
// ---------------------------------------------------------------------------

let tmpSeq = 0;

// Materialize `.maddu/state/harness-capabilities.json` from the spine.
//
// The read/reduce/write is a TRANSACTION, so it runs under its own projection
// lock: two doctors finishing at once would otherwise each reduce a different
// snapshot and the later rename would win with the older answer. The tmp file
// is unique per writer and the rename happens INSIDE the lock, so a concurrent
// materialization can never publish a half-written file or clobber a newer one.
//
// EVERY failure here is reported, never thrown (funnel r1 #8): the projection
// is a cache of the spine and can always be rebuilt, and by the time this
// runs the observation event has already been appended — a cache-refresh
// problem must not turn a successful observation into a failed command. The
// reason distinguishes a busy lock from a real read/write failure, and a
// failed writer removes its own tmp file.
export async function materializeHarnessCapabilities(stateRoot, opts = {}) {
  try {
    await mkdir(pathsFor(stateRoot).statePrjDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'state-dir-unavailable', error: err.message };
  }
  let cbResult;
  try {
    await withAppendLock(projectionLockPath(stateRoot), async () => {
      let tmp = null;
      try {
        const events = await readAll(stateRoot);
        const projection = reduceHarnessCapabilities(events);
        const target = harnessCapabilitiesProjectionPath(stateRoot);
        tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
        await writeFile(tmp, JSON.stringify(projection, null, 2) + '\n');
        await rename(tmp, target);
        cbResult = { ok: true, path: target, projection };
      } catch (e) {
        if (tmp) { try { await unlink(tmp); } catch {} }
        cbResult = { ok: false, reason: 'projection-write-failed', error: e?.message || String(e) };
      }
    }, { maxWaitMs: opts.maxWaitMs ?? PROJECTION_LOCK_WAIT_MS });
  } catch (err) {
    // Only a TIMEOUT on a live holder is "busy". Any other acquisition
    // failure (permissions, a directory squatting on the lock path, …) is a
    // different problem and deserves its own diagnosis (funnel r2 #5).
    if (err?.code === 'ELOCKTIMEOUT') return { ok: false, reason: 'lock-busy' };
    return { ok: false, reason: 'lock-unavailable', error: err?.message || String(err) };
  }
  return cbResult ?? { ok: false, reason: 'projection-write-failed', error: 'materializer produced no result' };
}

export async function readHarnessCapabilitiesProjection(stateRoot) {
  try {
    const text = await readBounded(harnessCapabilitiesProjectionPath(stateRoot));
    return text == null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

// Observe ONE harness: probe, compare, append, refresh the projection.
// Throws UnknownHarnessError for a name the manifest does not carry — an
// unknown name is a caller mistake, not an observation.
export async function runHarnessDoctor(roots, harnessName, opts = {}) {
  const observation = await observeHarness(roots, harnessName, opts);
  const event = await recordObservation(roots.stateRoot, observation, opts.by ?? null);
  const projection = await materializeHarnessCapabilities(roots.stateRoot, opts);
  return { observations: [observation], events: [event], projection };
}

// Observe every harness the manifest carries. Each gets its own event; the
// projection is refreshed once at the end (it is a pure reduce of the spine,
// so one refresh after the last append sees all of them).
export async function runHarnessDoctorAll(roots, opts = {}) {
  const manifest = opts.manifest || HARNESS_CAPABILITIES;
  const observations = [];
  const events = [];
  for (const name of listHarnessNames(manifest)) {
    const observation = await observeHarness(roots, name, opts);
    observations.push(observation);
    events.push(await recordObservation(roots.stateRoot, observation, opts.by ?? null));
  }
  const projection = await materializeHarnessCapabilities(roots.stateRoot, opts);
  return { observations, events, projection };
}
