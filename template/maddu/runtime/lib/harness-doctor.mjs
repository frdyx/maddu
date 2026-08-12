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

import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, readAll, EVENT_TYPES } from './spine.mjs';
import { withAppendLock } from './append-lock.mjs';
import { probeRuntime, readRuntime } from './runtimes.mjs';
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

// A harness config is scanned for the Máddu stanza marker, not parsed. Bounded
// so a pathological file can never be pulled wholly into memory.
const MAX_CONFIG_SCAN_BYTES = 512 * 1024;

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

async function isFileAt(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

async function readBounded(p) {
  let fh = null;
  try {
    fh = await open(p, 'r');
    const buf = Buffer.alloc(MAX_CONFIG_SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_CONFIG_SCAN_BYTES, 0);
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
  const descriptor = opts.descriptor !== undefined
    ? opts.descriptor
    : await readRuntime(stateRoot, entry.name).catch(() => null);
  const override = descriptor?.detect?.command;
  const spec = (typeof override === 'string' && override)
    ? { command: override, shell: true, expectExit: descriptor?.detect?.expectExit ?? 0 }
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
// 'present-no-stanza'. PR1 does no parsing of a foreign harness's config
// semantics beyond this substring scan.
export async function observeConfigs(entry, workRoot, { platform = process.platform, home = homedir() } = {}) {
  const candidates = configCandidatesFor(entry, platform);
  const scanSet = new Set(Array.isArray(entry?.sentinel?.files) ? entry.sentinel.files : []);
  const marker = entry?.sentinel?.marker || null;
  const out = [];
  for (const candidate of candidates) {
    const resolved = resolveConfigCandidate(candidate, workRoot, home);
    let status = 'absent';
    if (resolved && await isFileAt(resolved)) {
      status = 'present-no-stanza';
      if (marker && scanSet.has(candidate)) {
        const text = await readBounded(resolved);
        if (text != null && text.includes(marker)) status = 'stanza-present';
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
// absolute paths stay in the CLI presentation, so the record is portable
// between machines and carries no operator home directory.
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
// Lock-acquisition failure is reported, never thrown — the projection is a
// cache of the spine and can always be rebuilt; a busy lock must not turn a
// successful observation into a failed command.
export async function materializeHarnessCapabilities(stateRoot, opts = {}) {
  try {
    await mkdir(pathsFor(stateRoot).statePrjDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'state-dir-unavailable', error: err.message };
  }
  let cbThrew = false, cbError;
  let result;
  try {
    result = await withAppendLock(projectionLockPath(stateRoot), async () => {
      // Boolean-tracked so a callback that throws a falsy value still
      // propagates instead of masquerading as lock contention.
      try {
        const events = await readAll(stateRoot);
        const projection = reduceHarnessCapabilities(events);
        const target = harnessCapabilitiesProjectionPath(stateRoot);
        const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
        await writeFile(tmp, JSON.stringify(projection, null, 2) + '\n');
        await rename(tmp, target);
        return { ok: true, path: target, projection };
      } catch (e) { cbThrew = true; cbError = e; return undefined; }
    }, { maxWaitMs: opts.maxWaitMs ?? PROJECTION_LOCK_WAIT_MS });
  } catch {
    return { ok: false, reason: 'lock-busy' };
  }
  if (cbThrew) throw cbError;
  return result;
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
