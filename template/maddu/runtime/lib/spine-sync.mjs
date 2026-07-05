// spine-sync.mjs — team-sync activation + import (roadmap #12c phase 3).
//
// `syncInit`  — opt into sync mode: mint this checkout's replicaId, migrate the
//               legacy flat segment(s) into by-replica/<replicaId>/ byte-identically
//               (so the prev_hash chain survives), and template .gitignore /
//               .gitattributes so ONLY partition segments are committed. Refuses if
//               committing the spine would expose a secret (the whole data payload
//               becomes git-visible — far beyond the argv scrubs of #219/#220).
// `importPartitions` — validate partitions that arrived via `git pull` (git is a
//               dumb transport): report-only parse/envelope quarantine + chain
//               verify where a per-partition fork is FATAL (option (b) makes the
//               chain strictly valid, so a fork means tampering/corruption), plus
//               the same secret gate. Read-only: reconciliation is pure projection.
//
// Identity is delegated to git ACL + PGP — Máddu mints no accounts. replica.json is
// git-ignored by construction (.maddu/config/* ignores it) and a doctor gate asserts
// it is never tracked. No EVENT_CONTRACT change: replicaId lives in the path.

import { readdir, readFile, writeFile, mkdir, rename, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { makeId } from './spine.mjs';
import { isValidReplicaId, readReplicaId, partitionDir, pendingReplicaPath } from './spine-append-core.mjs';
import { withAppendLock } from './append-lock.mjs';
import { redactText } from './secret-scan.mjs';
import { verifySpine } from './verify.mjs';

const SEG_RE = /^\d{12}\.ndjson$/;

const GITIGNORE_BEGIN = '# BEGIN MADDU SYNC (#12c team-sync partitions) — do not edit';
const GITIGNORE_END = '# END MADDU SYNC';
// Un-ignore the events dir enough for git to descend, keep the flat segments and
// lock files ignored, and track ONLY by-replica partition *.ndjson. Order matters:
// each negation must re-include the parent level the broader ignore matched.
const GITIGNORE_BODY = [
  '!.maddu/events/',
  '.maddu/events/*',
  '!.maddu/events/by-replica/',
  '!.maddu/events/by-replica/**/',
  '.maddu/events/by-replica/**/.append.lock',
  '!.maddu/events/by-replica/**/*.ndjson',
  '# replica.json is this checkout\'s identity — NEVER commit it (a shared replicaId',
  '# resurrects the multi-writer conflict). The install re-includes .maddu/config/, so',
  '# every transient sync file under it must be ignored explicitly here.',
  '.maddu/config/replica.json',
  '.maddu/config/replica.json.tmp',
  '.maddu/config/replica.pending.json',
  '.maddu/config/.sync-init.lock',
].join('\n');

const GITATTR_BEGIN = '# BEGIN MADDU SYNC (#12c) — do not edit';
const GITATTR_END = '# END MADDU SYNC';
// Partition segments are byte-exact hash-chained records: never let git normalize
// line endings (-text) and never try to merge them (each is single-writer, disjoint
// across replicas, so a merge would be a bug not a resolution).
const GITATTR_BODY = [
  '.maddu/events/by-replica/**/*.ndjson -text merge=binary',
].join('\n');

async function dirExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function listSegs(dir) {
  try { return (await readdir(dir)).filter((f) => SEG_RE.test(f)).sort(); }
  catch { return []; }
}

// Scan every committed-or-committable event line for secret-shaped values. Uses the
// canonical redactText — a hit is any line where redactText would replace something.
// Returns [{ where, patternTypes }]. The whole data payload is in scope: approvals,
// handoff prose, slice summaries, inbox, plans, imported memory.
export async function scanSpineForSecrets(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const hits = [];
  const scanDir = async (dir, label) => {
    for (const f of await listSegs(dir)) {
      let text;
      try { text = await readFile(join(dir, f), 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const kinds = Object.keys(redactText(lines[i]).redactions);
        if (kinds.length) hits.push({ where: `${label}/${f}:${i + 1}`, patternTypes: kinds });
      }
    }
  };
  await scanDir(eventsDir, 'events');
  const byReplica = join(eventsDir, 'by-replica');
  let dirs = [];
  try { dirs = (await readdir(byReplica, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { /* none */ }
  for (const rid of dirs) await scanDir(join(byReplica, rid), `by-replica/${rid}`);
  return hits;
}

// Idempotently ensure a marker-delimited block exists in `file` (created if absent).
// Only the block between BEGIN/END is Máddu-owned; everything else is left intact.
async function ensureMarkerBlock(file, begin, end, body) {
  let cur = '';
  try { cur = await readFile(file, 'utf8'); } catch { /* new file */ }
  const block = `${begin}\n${body}\n${end}`;
  const re = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  let next;
  if (re.test(cur)) {
    next = cur.replace(re, block); // refresh in place
  } else {
    const sep = cur && !cur.endsWith('\n') ? '\n' : '';
    next = `${cur}${sep}${cur ? '\n' : ''}${block}\n`;
  }
  if (next !== cur) await writeFile(file, next);
}

// Migrate any legacy flat segments in events/ into replicaId's partition, by
// byte-identical rename (every stored line — and thus the prev_hash chain — is
// preserved verbatim). Refuses to overwrite an existing partition segment (an
// inconsistent state) rather than clobber history. Idempotent: with no flat
// segments left it is a no-op, which is what makes a re-run resume cleanly.
async function migrateFlatInto(repoRoot, replicaId) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const partDir = partitionDir(repoRoot, replicaId);
  await mkdir(partDir, { recursive: true });
  const migrated = [];
  for (const f of await listSegs(eventsDir)) {
    const dest = join(partDir, f);
    if (await dirExists(dest)) {
      throw new Error(`migrate: ${f} already exists in partition ${replicaId} — refusing to overwrite (inconsistent state; resolve manually)`);
    }
    await rename(join(eventsDir, f), dest);
    migrated.push(f);
  }
  return migrated;
}

// Template .gitignore + .gitattributes so ONLY partition segments are committed.
async function ensureSyncTemplates(repoRoot) {
  await ensureMarkerBlock(join(repoRoot, '.gitignore'), GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_BODY);
  await ensureMarkerBlock(join(repoRoot, '.gitattributes'), GITATTR_BEGIN, GITATTR_END, GITATTR_BODY);
}

// The pending-migration marker (path + parse) lives in spine-append-core so that
// append()/readAll() can route to the in-flight partition. Here we just read it.
async function readPending(repoRoot) {
  try {
    const id = JSON.parse(await readFile(pendingReplicaPath(repoRoot), 'utf8'))?.replicaId;
    return typeof id === 'string' && isValidReplicaId(id) ? id : null;
  } catch { return null; }
}

// Opt this checkout into sync mode. Returns one of:
//   { ok:true, already:true, replicaId }            — already initialised (templates refreshed)
//   { ok:true, replicaId, migrated:[seg…] }         — initialised (or resumed a partial init)
//   { ok:false, reason:'secret', hits }             — refused: committing would leak a secret
//   { ok:false, reason:'config-invalid', message }  — replica.json present but malformed
//   { ok:false, reason:'mint-collision' }           — could not mint a fresh replicaId
//   { ok:false, reason:'migrate-conflict', message } — a segment name already in the partition
// `mintId` is injectable for deterministic tests; `now` injects the timestamp.
// Two concurrent `spine sync init` runs are serialized by an exclusive init lock, so
// they cannot both mint + publish (which would leave an orphan partition or split the
// active replica.json from the migrated partition). The second run waits, then sees
// replica.json and returns { already:true }.
export async function syncInit(repoRoot, opts = {}) {
  await mkdir(join(repoRoot, '.maddu', 'config'), { recursive: true });
  const initLock = join(repoRoot, '.maddu', 'config', '.sync-init.lock');
  return withAppendLock(initLock, () => syncInitBody(repoRoot, opts));
}

async function syncInitBody(repoRoot, { mintId = () => makeId('rep'), now = null, force = false } = {}) {
  const cfgPath = join(repoRoot, '.maddu', 'config', 'replica.json');

  // Malformed replica.json is itself a hard sync-config problem — surface it.
  let existing = null;
  try { existing = await readReplicaId(repoRoot); }
  catch (e) { return { ok: false, reason: 'config-invalid', message: e.message }; }

  // Secret gate runs UNCONDITIONALLY (first-time, resume, AND already): the sync
  // surface must never be created/refreshed while a secret is present in the payload.
  const hits = await scanSpineForSecrets(repoRoot);
  if (hits.length) return { ok: false, reason: 'secret', hits };

  // Already fully initialised (replica.json is written LAST, so its presence means
  // migration completed). Just re-ensure the git templates and return — never touch
  // segments (a fully-synced repo has no residual flat by construction).
  if (existing && !force) {
    await ensureSyncTemplates(repoRoot);
    return { ok: true, already: true, replicaId: existing };
  }

  // Not yet synced. Resume a pending migration into its SAME replicaId, or mint one.
  let replicaId = await readPending(repoRoot);
  if (!replicaId) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = mintId();
      if (!isValidReplicaId(id)) continue;
      if (!(await dirExists(partitionDir(repoRoot, id)))) { replicaId = id; break; }
    }
    if (!replicaId) return { ok: false, reason: 'mint-collision' };
  }

  // Write the pending marker FIRST. From here a concurrent append() sees it and —
  // crucially — does NOT write into the partition; it WAITS for replica.json (the
  // completion signal) before touching the partition. So migration needs no lock:
  // no writer can interleave with the renames. readAll still sees the in-progress
  // partition + residual flat (readActiveReplicaId), so reads stay consistent.
  await mkdir(join(repoRoot, '.maddu', 'config'), { recursive: true });
  await writeFile(pendingReplicaPath(repoRoot), JSON.stringify({ replicaId }) + '\n');

  // Migrate all flat segments in, THEN write replica.json LAST (activation): only
  // once every segment is in place does append() route to the partition.
  let migrated;
  try { migrated = await migrateFlatInto(repoRoot, replicaId); }
  catch (e) { return { ok: false, reason: 'migrate-conflict', message: e.message }; }
  const createdAt = now || new Date().toISOString();
  // Publish ATOMICALLY (temp + rename): a concurrent reader/appender must see either
  // no replica.json or a COMPLETE one — never a half-written file it would reject as
  // "malformed" instead of waiting on the still-present pending marker.
  const tmpCfg = cfgPath + '.tmp';
  await writeFile(tmpCfg, JSON.stringify({ replicaId, createdAt }, null, 2) + '\n');
  await rename(tmpCfg, cfgPath);

  try { await unlink(pendingReplicaPath(repoRoot)); } catch { /* already gone */ }
  await ensureSyncTemplates(repoRoot);

  // Barrier residual: the funnel serializes every append that saw the marker. The
  // only remaining race is an append whose mode-read observed NEITHER marker nor
  // replica.json (a microsecond before the marker was written) and then wrote a flat
  // segment after migration's snapshot — the same best-effort flat concurrency the
  // single-machine spine already accepts (spine.mjs:461-473). Such a segment cannot
  // chain into the partition (it links to the pre-migration flat tail), so rather
  // than silently strand it, surface it: `spine sync init` should run while writes
  // are quiescent; re-running with the operator's chosen remedy is the fix.
  const strandedFlat = await listSegs(join(repoRoot, '.maddu', 'events'));
  const result = { ok: true, replicaId, migrated };
  if (strandedFlat.length) result.strandedFlat = strandedFlat;
  return result;
}

// Validate the partitions that git placed on disk (git is a dumb transport). This
// is READ-ONLY — reconciliation is pure projection, so nothing is written back.
// Returns:
//   {
//     ok: bool,                 // false if a fatal condition was found
//     totalEvents, partitions:  [{ replicaId, events, segments }],
//     forks:      [issue…],     // per-partition chain_broken → FATAL (option b makes
//                               //   the chain strictly valid, so a fork = tampering)
//     duplicateIds:[issue…],    // same event id at two positions — TOLERATED (the
//                               //   identity is partition-position, not the id), reported
//     quarantined:[issue…],     // unparseable / torn / envelope-missing lines — set aside
//     secretHits: [hit…],       // committing/using a secret-bearing partition → FATAL
//   }
// Dedup is on partition-position (replicaId, segment, line-seq): every event has one
// position in one partition, so re-importing (re-pulling) is inherently idempotent.
export async function importPartitions(repoRoot) {
  const secretHits = await scanSpineForSecrets(repoRoot);
  const v = await verifySpine(repoRoot);

  const forks = v.issues.filter((i) => i.kind === 'chain_broken');
  // Quarantine = line-level parse/envelope damage: set aside (readAll skips it),
  // reported but NOT fatal — the rest of the partition still imports.
  const quarantineKinds = new Set(['unparseable', 'torn_trailing_line', 'non_object', 'envelope_missing']);
  const quarantined = v.issues.filter((i) => quarantineKinds.has(i.kind));

  // Duplicate ids: WITHIN a partition = a real single-writer bug (fatal); ACROSS
  // partitions = a tolerated probabilistic id collision (identity is partition-
  // position). null firstReplicaId (flat/default) counts as same-partition.
  const duplicateIds = v.issues.filter((i) => i.kind === 'duplicate_id');
  const dupWithin = duplicateIds.filter((i) => (i.firstReplicaId ?? null) === (i.replicaId ?? null));
  const dupAcross = duplicateIds.filter((i) => (i.firstReplicaId ?? null) !== (i.replicaId ?? null));

  // Any OTHER FAIL (segment_gap, malformed structure, etc.) is a corrupt partition
  // and is fatal — a gap or missing genesis must never be reported "safe to merge".
  const structuralFails = v.issues.filter(
    (i) => i.level === 'FAIL' && !quarantineKinds.has(i.kind) && i.kind !== 'duplicate_id'
  );

  const byRid = new Map();
  for (const s of v.segments) {
    if (!s.replicaId) continue;
    const cur = byRid.get(s.replicaId) || { replicaId: s.replicaId, events: 0, segments: 0 };
    cur.events += s.events;
    cur.segments += 1;
    byRid.set(s.replicaId, cur);
  }

  const ok = forks.length === 0 && secretHits.length === 0 && structuralFails.length === 0 && dupWithin.length === 0;
  return {
    ok,
    totalEvents: v.events,
    partitions: [...byRid.values()].sort((a, b) => a.replicaId.localeCompare(b.replicaId)),
    forks,
    structuralFails,
    dupWithin,
    dupAcross,
    duplicateIds,
    quarantined,
    secretHits,
  };
}

export { GITIGNORE_BEGIN, GITIGNORE_END, GITATTR_BEGIN };
