// replica-lineage.mjs — the DEVICE-LOCAL replica lineage (PR-D §3.1).
//
// WHY DEVICE-LOCAL
// ────────────────
// Detach recovery may only auto-act on an intent whose SOURCE partition this
// device authored — otherwise a team-sync-imported foreign replica's intent could
// drive a local checkout removal. `replicaId` lives in the partition PATH, not in
// event data, so an imported intent's origin is its source partition id. The
// authority for "which partitions are mine" is this file, kept in $GIT_DIR (never
// committed, never synced): a SYNCED lineage would make every clone treat another
// device's partitions as local-and-auto-authorized — the critical hazard (r4-2).
//
// SHAPE: { current, predecessors: [], complete }
//   current      — this device's active replicaId
//   predecessors — earlier ids this device rotated FROM (all still LOCAL). PR-D
//                  never appends here (rotation is OUT); the field exists so the
//                  classifier and a future rotation PR agree on the shape.
//   complete     — is the predecessor set KNOWN-exhaustive? true after a fresh
//                  init (this device minted `current` and never rotated); false
//                  after an upgrade backfill (we can't prove no earlier local id
//                  existed) — so an UNLISTED source stays UNVERIFIABLE, not foreign.
//
// CLASSIFIER (§3.1): a source in {current}∪predecessors → LOCAL; an unlisted
// source → FOREIGN only when complete:true, else UNVERIFIABLE; a missing/malformed
// lineage, or current !== the active replica.json id, → UNVERIFIABLE. Unverifiable
// → needsOperator (never "foreign", never auto). Lineage is NEVER reconstructed
// from partition dirs (that would re-import the hazard it removes).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import { gitRun } from './git-exec.mjs';
import { readReplicaId } from './spine-append-core.mjs';

const LINEAGE_FILE = 'maddu-replica-lineage.json';

// Resolve $GIT_DIR (the shared common dir, so every linked worktree sees ONE
// lineage). Returns an absolute path to the lineage file, or null when git can't
// resolve a dir (a non-git checkout — sync/worktrees don't apply there anyway).
export async function lineagePath(repoRoot) {
  const r = await gitRun(['rev-parse', '--git-common-dir'], repoRoot, 5000);
  if (r.code !== 0) return null;
  let dir = r.stdout.trim();
  if (!dir) return null;
  if (!isAbsolute(dir)) dir = join(repoRoot, dir);
  return join(dir, LINEAGE_FILE);
}

// Read the lineage, or null on absent/malformed (the classifier treats both as
// UNVERIFIABLE — a fail-closed default, never fabricated as "foreign"/"local").
export async function readLineage(repoRoot) {
  const p = await lineagePath(repoRoot);
  if (!p) return null;
  try {
    const obj = JSON.parse(await readFile(p, 'utf8'));
    if (!obj || typeof obj.current !== 'string' || !obj.current) return null;
    if (!Array.isArray(obj.predecessors)) return null;
    if (typeof obj.complete !== 'boolean') return null;
    return { current: obj.current, predecessors: obj.predecessors.filter((x) => typeof x === 'string' && x), complete: obj.complete };
  } catch {
    return null;
  }
}

async function writeLineageAtomic(repoRoot, obj) {
  const p = await lineagePath(repoRoot);
  if (!p) return false;
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await rename(tmp, p);
  return true;
}

// Fresh init: this device is the authoritative origin of `current`. complete:true.
// Best-effort — a lineage-write failure must not fail sync init (its absence just
// makes classification unverifiable, which is safe). Overwrites idempotently so a
// crash-resumed init re-establishes the same {current} without stale predecessors.
export async function bootstrapLineageFresh(repoRoot, replicaId) {
  try { return await writeLineageAtomic(repoRoot, { current: replicaId, predecessors: [], complete: true }); }
  catch { return false; }
}

// Upgrade backfill: a checkout synced before PR-D has no lineage file. Record its
// existing id as `current` with complete:false (we can't prove no earlier local id
// existed). NEVER overwrites a present lineage (that could drop a true predecessor
// set or downgrade a known-complete origin). Best-effort.
export async function bootstrapLineageUpgrade(repoRoot, existingId) {
  try {
    if (await readLineage(repoRoot)) return false; // already has one — leave it
    return await writeLineageAtomic(repoRoot, { current: existingId, predecessors: [], complete: false });
  } catch { return false; }
}

// Classify a source partition id (an intent's origin) against this device's
// lineage + the active replica.json. Returns 'local' | 'foreign' | 'unverifiable'.
// `activeReplicaId` may be passed (avoids a re-read); otherwise it is read.
export async function classifyOrigin(repoRoot, sourceReplicaId, activeReplicaId = undefined) {
  if (typeof sourceReplicaId !== 'string' || !sourceReplicaId) return 'unverifiable';
  const lineage = await readLineage(repoRoot);
  if (!lineage) return 'unverifiable';
  let active = activeReplicaId;
  if (active === undefined) {
    try { active = await readReplicaId(repoRoot); } catch { active = null; }
  }
  // A lineage whose `current` disagrees with the active replica.json is stale /
  // mis-set — cannot be trusted to authorize a destructive removal.
  if (!active || lineage.current !== active) return 'unverifiable';
  if (sourceReplicaId === lineage.current || lineage.predecessors.includes(sourceReplicaId)) return 'local';
  // An unlisted source is FOREIGN only when the local set is provably exhaustive.
  return lineage.complete ? 'foreign' : 'unverifiable';
}
