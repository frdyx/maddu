// Success-condition evaluation — the goal's measurable ✓/○/? state (v1.97.0).
//
// Extracted verbatim from commands/orient.mjs so BOTH the CLI briefing and the
// bridge builders share one evaluator. The split matters for a hard safety
// invariant: running an operator-declared verify command spawns a subprocess,
// and the bridge must NEVER spawn on an HTTP GET (server.js). So:
//
//   - the CLI path (orient, orient --digest) calls evalSuccess with
//     runVerify=true, which spawns, then writes the result to a state cache;
//   - bridge builders call readSuccessCache (no spawn, no shell) to render the
//     same ✓/○/? the operator last saw on the CLI.
//
// The cache is a rebuildable state file (.maddu/state/success-eval.json), never
// a spine event — it holds no authority, only the last evaluated snapshot.

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { pathsFor } from './paths.mjs';

export const VERIFY_TIMEOUT_MS = 120000;
const SCHEMA_VERSION = 1;

// Evaluate ONE success condition. runVerify is a caller-supplied boolean so a
// bridge caller can pass false (→ state:'skipped', no spawn). Moved verbatim
// from orient.mjs — keep the exact state semantics (met/pending/unverifiable/
// skipped) so the CLI render and the cache never disagree.
export function evalCondition(cond, repoRoot, runVerify) {
  if (!cond.verify) return { ...cond, state: 'unverifiable' };
  if (!runVerify) return { ...cond, state: 'skipped' };
  try {
    const r = spawnSync(cond.verify, { shell: true, cwd: repoRoot, timeout: VERIFY_TIMEOUT_MS, stdio: 'ignore' });
    if (r.error || r.status == null) return { ...cond, state: 'pending', note: r.error ? r.error.message : 'no exit code' };
    return { ...cond, state: r.status === 0 ? 'met' : 'pending', exitCode: r.status };
  } catch (e) {
    return { ...cond, state: 'pending', note: e.message };
  }
}

// Evaluate a goal's full success set → the same derivation orient computes.
// runVerify=false returns every condition as 'skipped' without spawning.
export function evalSuccess(goal, repoRoot, runVerify) {
  const success = Array.isArray(goal?.success) ? goal.success : [];
  const evaluated = success.map((c) => evalCondition(c, repoRoot, runVerify));
  const metCount = evaluated.filter((c) => c.state === 'met').length;
  const verifiable = evaluated.filter((c) => c.verify).length;
  const pendingCount = evaluated.filter((c) => c.state === 'pending').length;
  const allMet = verifiable > 0 && pendingCount === 0;
  return { evaluated, metCount, verifiable, pendingCount, allMet };
}

function cachePath(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'success-eval.json');
}

// Persist the last CLI evaluation so the bridge can render real ✓/○/? without
// spawning. `ts` is stamped by the caller (deterministic-friendly). The goal's
// objective + setAt travel with the snapshot so a consumer can tell whether the
// cache still corresponds to the CURRENT goal (a stale cache for a since-changed
// goal is worse than none). Atomic write (temp + rename).
export async function writeSuccessCache(repoRoot, { goal, result, ts }) {
  const dir = pathsFor(repoRoot).statePrjDir;
  await mkdir(dir, { recursive: true });
  const dst = cachePath(repoRoot);
  const tmp = dst + '.tmp';
  const record = {
    _v: SCHEMA_VERSION,
    ts: ts || null,
    objective: goal?.objective || null,
    setAt: goal?.setAt || null,
    metCount: result.metCount,
    verifiable: result.verifiable,
    pendingCount: result.pendingCount,
    allMet: result.allMet,
    // Store only the fields a readout needs — text + state (+ the command so a
    // reader can show what was checked). Drop note/exitCode: transient and can
    // carry subprocess error strings we don't need in a cache.
    conditions: (result.evaluated || []).map((c) => ({
      text: c.text || null, verify: c.verify || null, state: c.state,
    })),
  };
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
  await rename(tmp, dst);
  return record;
}

// Read the last evaluated snapshot, or null if none (no spawn, no shell). The
// bridge's success ✓/○/? comes from here. Callers should treat a null/absent
// cache as "not evaluated yet", not "all pending".
export async function readSuccessCache(repoRoot) {
  try {
    let raw = await readFile(cachePath(repoRoot), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

export function successCachePath(repoRoot) {
  return cachePath(repoRoot);
}
