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

import { readdir, readFile, writeFile, mkdir, rename, access, unlink, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { makeId } from './spine.mjs';
import { isValidReplicaId, readReplicaId, partitionDir, pendingReplicaPath, appendPartitioned, FLAT_LOCK_VERSION } from './spine-append-core.mjs';
import { withAppendLock } from './append-lock.mjs';
import { redactText } from './secret-scan.mjs';
import { verifySpine } from './verify.mjs';
import { gitRun as defaultGitRun, gitAvailable as defaultGitAvailable } from './git-exec.mjs';
import { bootstrapLineageFresh, bootstrapLineageUpgrade } from './replica-lineage.mjs';

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

async function syncInitBody(repoRoot, { mintId = () => makeId('rep'), now = null } = {}) {
  const cfgPath = join(repoRoot, '.maddu', 'config', 'replica.json');

  // Malformed replica.json is itself a hard sync-config problem — surface it.
  let existing = null;
  try { existing = await readReplicaId(repoRoot); }
  catch (e) { return { ok: false, reason: 'config-invalid', message: e.message }; }

  // Anchors and team-sync are structurally incompatible (witness PR 4: one
  // anchor chain covers one replica's flat spine; migration would also move
  // the very segments existing payloads point at). BOTH sides refuse: `spine
  // anchor` refuses in sync mode, and init refuses while anchors exist. This
  // early check fails CLOSED — only a genuinely-absent dir (ENOENT) means no
  // anchors; an unreadable dir must not let init migrate covered segments.
  // A SECOND check runs after the pending marker is written (see below) to
  // close the race with a stamp completing between here and the marker.
  const anchorsPresent = async () => {
    try {
      const entries = await readdir(join(repoRoot, '.maddu', 'anchors'), { withFileTypes: true });
      return entries.some((e) => e.isDirectory() && /^\d{6}$/.test(e.name));
    } catch (e) {
      if (e && e.code === 'ENOENT') return false;
      throw e; // unreadable ≠ absent — surface it, don't fail open
    }
  };
  try {
    if (await anchorsPresent()) return { ok: false, reason: 'anchors-present' };
  } catch (e) {
    return { ok: false, reason: 'config-invalid', message: `cannot read .maddu/anchors (${e.code || e.message}) — resolve before sync init` };
  }

  // Secret gate runs UNCONDITIONALLY (first-time, resume, AND already): the sync
  // surface must never be created/refreshed while a secret is present in the payload.
  const hits = await scanSpineForSecrets(repoRoot);
  if (hits.length) return { ok: false, reason: 'secret', hits };

  // Already fully initialised (replica.json is written LAST, so its presence means
  // migration completed). Just re-ensure the git templates + backfill the
  // device-local replica lineage for an upgrade (a checkout synced before PR-D has
  // no lineage file → {current:existing, predecessors:[], complete:false}: its own
  // partition classifies LOCAL, but with completeness UNKNOWN an unlisted source is
  // unverifiable, never foreign). Never touch segments (a fully-synced repo has no
  // residual flat by construction). NOTE: there is deliberately no `force`/rotation
  // path — replica ROTATION is out of PR-D scope (had no production caller).
  if (existing) {
    await ensureSyncTemplates(repoRoot);
    await bootstrapLineageUpgrade(repoRoot, existing);
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

  // Anchors recheck AFTER the marker: once the marker exists, any in-flight
  // `spine anchor` sees sync mode at its post-stamp recheck and rolls back —
  // so a stamp that FINALIZED before our marker is exactly the case this
  // catches. One of the two rechecks always fires; both cannot pass.
  try {
    if (await anchorsPresent()) {
      await unlink(pendingReplicaPath(repoRoot)).catch(() => {});
      return { ok: false, reason: 'anchors-present' };
    }
  } catch (e) {
    await unlink(pendingReplicaPath(repoRoot)).catch(() => {});
    return { ok: false, reason: 'config-invalid', message: `cannot read .maddu/anchors (${e.code || e.message}) — resolve before sync init` };
  }

  // Migrate all flat segments in, THEN write replica.json LAST (activation): only
  // once every segment is in place does append() route to the partition.
  let migrated;
  try { migrated = await migrateFlatInto(repoRoot, replicaId); }
  catch (e) { return { ok: false, reason: 'migrate-conflict', message: e.message }; }

  // audit P1 — seed a chain-local SPINE_CUTOVER anchor as the GENESIS of an EMPTY
  // freshly-minted partition (a new replica joining an already-synced >=1.98 repo
  // migrates nothing), so the verifier holds its first real append to the strict
  // post-cutover rules — otherwise a markerless modern partition stays lenient
  // forever and a real fork/strip there would only WARN. We seed ONLY when the
  // partition is empty: a NON-empty migration is left byte-identical (its bytes are
  // the tamper-detection), and a >=1.98 install's migrated FRAMEWORK marker already
  // makes it strict; a pre-1.98-rooted migration is legitimately lenient (it was
  // written by unlocked writers). appendPartitioned sets prev_hash=null (genesis).
  const pdir = partitionDir(repoRoot, replicaId);
  let partHasEvents = false;
  for (const s of await listSegs(pdir)) {
    try { if ((await stat(join(pdir, s))).size > 0) { partHasEvents = true; break; } } catch { /* unreadable — treat as absent */ }
  }
  if (!partHasEvents) {
    const cutoverTs = now || new Date().toISOString();
    await appendPartitioned(repoRoot, replicaId, {
      v: 1,
      id: makeId('evt', cutoverTs),
      ts: cutoverTs,
      type: 'SPINE_CUTOVER',
      actor: null,
      lane: null,
      data: { version: FLAT_LOCK_VERSION },
    });
  }
  // Device-local replica lineage (PR-D §3.1), written AFTER migration + BEFORE
  // replica.json activation: a fresh init is the authoritative origin, so
  // {current:replicaId, predecessors:[], complete:true} — completeness is KNOWN
  // because this device minted the id. Device-local ($GIT_DIR, never synced) so a
  // team-sync clone never treats another device's partitions as local. A crash
  // before activation leaves the lineage naming the pending id, which the resume
  // re-derives to the same replicaId (idempotent overwrite).
  await bootstrapLineageFresh(repoRoot, replicaId);

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
  // chain_broken is already collected as `forks` above (audit P1 made it a FAIL on
  // a locked/strict chain); exclude it here so a partition fork isn't double-counted
  // as both a fork and a structural fail.
  const structuralFails = v.issues.filter(
    (i) => i.level === 'FAIL' && !quarantineKinds.has(i.kind) && i.kind !== 'duplicate_id' && i.kind !== 'chain_broken'
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

// The only real spine surface: a NUMERIC partition segment file (a stray
// non-segment *.ndjson or note.txt under by-replica/ is NOT a segment).
const SEGMENT_PATH_RE = /^\.maddu\/events\/by-replica\/[^/]+\/\d{12}\.ndjson$/;
const isSegmentPath = (p) => SEGMENT_PATH_RE.test(p);
const isMetaPath = (p) => p === '.gitignore' || p === '.gitattributes';
const syncCommitSubject = (replicaId) => `maddu spine sync (${replicaId})`;

// The exact bytes ensureMarkerBlock writes to a FRESH dotfile (sync created it
// from nothing) — `${begin}\n${body}\n${end}\n`. A dotfile is first-shareable
// only if it equals this exactly (modulo line-ending/trailing-whitespace). A
// stripping approach is spoofable — a user can plant a fake BEGIN marker — so we
// compare against the whole canonical block instead, which no user content can
// survive. Never publishes a user's pre-existing untracked .gitignore rules.
function freshDotfileContent(name) {
  const [begin, end, body] = name === '.gitignore'
    ? [GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_BODY]
    : [GITATTR_BEGIN, GITATTR_END, GITATTR_BODY];
  return `${begin}\n${body}\n${end}\n`;
}
function isSyncManagedOnlyDotfile(name, content) {
  return content.replace(/\r\n/g, '\n').trimEnd() === freshDotfileContent(name).trimEnd();
}

// `git push` publishes the WHOLE branch, not just our commit — so before pushing
// we audit EVERY unpushed commit (@{u}..HEAD) COMMIT-BY-COMMIT, purely by PATH +
// CONTENT (never by commit subject, which a user can spoof). Per commit, via
// `git show --name-status --no-renames` (rename detection OFF so a rename's
// non-spine SOURCE is visible as a delete). A non-merge commit is "sync-owned"
// (safe to publish) iff it is non-empty and EVERY entry is one of:
//   • a numeric segment file UNDER THIS REPLICA'S OWN partition (a foreign
//     by-replica/<other>/ segment is a forgery — peers' partitions arrive via
//     pull, already on the remote, never in our unpushed range), ADDED (A) or
//     MODIFIED as a pure byte-APPEND (parent blob is a prefix of the new blob —
//     a truncation/rewrite/type-change is refused, and import can miss a no-gap
//     truncation), OR
//   • a sync-managed dotfile ADDED (A) whose blob is EXACTLY the canonical block
//     (freshDotfileContent) — a first share of a maddu-created dotfile, carrying
//     no user content; a modify/delete of a tracked dotfile, or any user content,
//     is refused.
// A merge is owned iff its --diff-merges=combined diff is empty (a clean disjoint
// auto-merge introduces nothing; its side commits are audited on their own; an
// evil merge that introduces any path is refused). Returns { ok, offending }.
async function auditUnpushed(gitRun, repoRoot, replicaId) {
  const myPrefix = `.maddu/events/by-replica/${replicaId}/`;
  const list = await gitRun(['rev-list', '@{u}..HEAD'], repoRoot, 10000);
  if (list.code !== 0) return { ok: false, error: (list.stderr || list.error || '').trim() };
  const shas = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const offending = [];
  for (const sha of shas) {
    // Every git call is code-checked — an errored/timed-out call returning empty
    // stdout must NOT fail open into "no paths → vacuously owned".
    const subjR = await gitRun(['log', '-1', '--format=%s', sha], repoRoot, 5000);
    if (subjR.code !== 0) return { ok: false, error: (subjR.stderr || subjR.error || 'log failed').trim() };
    const subj = subjR.stdout.trim();
    const parR = await gitRun(['rev-list', '--parents', '-n', '1', sha], repoRoot, 5000);
    if (parR.code !== 0) return { ok: false, error: (parR.stderr || parR.error || 'rev-list failed').trim() };
    const isMerge = parR.stdout.trim().split(/\s+/).slice(1).length > 1;

    if (isMerge) {
      const mR = await gitRun(['show', '--format=', '--name-only', '--diff-merges=combined', sha], repoRoot, 10000);
      if (mR.code !== 0) return { ok: false, error: (mR.stderr || mR.error || 'show failed').trim() };
      const mNames = [...new Set(mR.stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
      if (mNames.length > 0) offending.push({ sha: sha.slice(0, 9), subject: subj, paths: mNames.slice(0, 5) });
      continue;
    }

    const nsR = await gitRun(['show', '--format=', '--name-status', '--no-renames', sha], repoRoot, 10000);
    if (nsR.code !== 0) return { ok: false, error: (nsR.stderr || nsR.error || 'show failed').trim() };
    const entries = nsR.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const tab = l.indexOf('\t');
      return tab < 0 ? { status: l, path: '' } : { status: l.slice(0, tab).trim(), path: l.slice(tab + 1).trim() };
    });
    let bad = null;
    if (entries.length === 0) bad = '(empty commit)';
    for (const e of entries) {
      const st = e.status[0];
      if (isSegmentPath(e.path) && e.path.startsWith(myPrefix)) {
        if (st === 'A') {
          // new segment in our own partition — fine
        } else if (st === 'M') {
          // A modification is only sync-owned if it is a pure APPEND: the parent
          // blob must be a byte-PREFIX of the new blob. A truncation/rewrite
          // (deleting tail events) leaves a valid shorter chain that import would
          // pass — this catches it. Compare against the FIRST parent.
          const oldB = await gitRun(['show', `${sha}^:${e.path}`], repoRoot, 10000);
          const newB = await gitRun(['show', `${sha}:${e.path}`], repoRoot, 10000);
          if (oldB.code !== 0 || newB.code !== 0) return { ok: false, error: 'segment blob read failed' };
          if (!newB.stdout.startsWith(oldB.stdout)) { bad = e.path; break; } // not an append
        } else { bad = e.path; break; } // D (delete) / T (type-change) / etc.
      } else if (isMetaPath(e.path)) {
        // A dotfile is owned ONLY as a first-share ADD of the exact managed block
        // (no user content). Subject is NOT trusted (spoofable); content is.
        if (st !== 'A') { bad = e.path; break; }
        const blob = await gitRun(['show', `${sha}:${e.path}`], repoRoot, 10000);
        if (blob.code !== 0) return { ok: false, error: 'dotfile blob read failed' };
        if (blob.stdout.replace(/\r\n/g, '\n').trimEnd() !== freshDotfileContent(e.path).trimEnd()) { bad = e.path; break; }
      } else { bad = e.path || '(unknown)'; break; } // foreign partition / non-spine
    }
    const owned = !bad;
    if (!owned) offending.push({ sha: sha.slice(0, 9), subject: subj, paths: bad ? [bad] : entries.filter((e) => !isSegmentPath(e.path)).map((e) => e.path).slice(0, 5) });
  }
  return { ok: offending.length === 0, offending };
}

// True (with a reason string) iff the repo is mid-merge / rebase / cherry-pick /
// revert — an operation the USER started that `spine sync` must not conclude
// (a bare `git commit` would finish a merge) or abort. Never throws.
async function gitBusy(gitRun, repoRoot) {
  for (const [ref, why] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
    const r = await gitRun(['rev-parse', '-q', '--verify', ref], repoRoot, 5000);
    if (r.code === 0 && r.stdout.trim()) return `${why} in progress`;
  }
  for (const d of ['rebase-merge', 'rebase-apply']) {
    const p = await gitRun(['rev-parse', '--git-path', d], repoRoot, 5000);
    const rel = (p.stdout || '').trim();
    if (p.code === 0 && rel) {
      const abs = isAbsolute(rel) ? rel : join(repoRoot, rel);
      if (await dirExists(abs)) return 'rebase in progress';
    }
  }
  return null;
}

// `maddu spine sync` — the git-transport verb (roadmap #12c phase 5). Sugar over
// the dumb-transport model: commit THIS replica's new partition segments, pull
// peers' partitions, validate the merged set (`spine import`), then push. Author-
// partitioning + `.gitattributes ... merge=binary` means the pull can never
// textually conflict — replicas write disjoint dirs — so a clean round-trip needs
// no manual merge. Every failure short-circuits BEFORE push so a corrupt or
// secret-bearing set is never shared. Pure orchestration: reconciliation stays a
// read-time projection; this writes only git objects, never the spine. It commits
// ONLY this replica's numeric segment files (never a peer's dir, a stray
// non-segment *.ndjson the secret scan can't see, or unrelated user work) and
// never bypasses repo hooks.
//
// gitRun/gitAvailable are injectable so tests can drive real temp checkouts (the
// gate) or stub the transport; they default to the shared git-exec runner.
export async function syncGit(repoRoot, opts = {}) {
  const gitRun = opts.gitRun || defaultGitRun;
  const gitAvailable = opts.gitAvailable || defaultGitAvailable;
  const doPull = opts.pull !== false;
  const doPush = opts.push !== false;
  const steps = [];

  // Require a COMMITTED replica.json — a pending/stalled `sync init` is NOT a
  // syncable state (a half-activation must never be shared). readReplicaId reads
  // only the committed file and throws on a malformed one (fail-closed). The
  // pending-marker check comes FIRST so a crashed init (pending but no committed
  // file) reports 'sync-init-in-progress', not a misleading 'not-sync-mode'.
  if (await dirExists(pendingReplicaPath(repoRoot))) return { ok: false, reason: 'sync-init-in-progress', steps };
  let replicaId;
  try { replicaId = await readReplicaId(repoRoot); }
  catch (e) { return { ok: false, reason: 'config-invalid', detail: e.message, steps }; }
  if (!replicaId) return { ok: false, reason: 'not-sync-mode', steps };
  if (!(await gitAvailable(repoRoot))) return { ok: false, reason: 'no-git', steps };

  // Never conclude or abort a merge/rebase/cherry-pick/revert the user is running.
  const busy = await gitBusy(gitRun, repoRoot);
  if (busy) return { ok: false, reason: 'git-busy', detail: busy, steps };

  // Secret gate — refuse if any committable spine line holds a secret-shaped
  // value (committing exposes the whole data payload). Re-checked here because
  // events accrue after `sync init`; a peer secret is caught again post-pull.
  const preHits = await scanSpineForSecrets(repoRoot);
  if (preHits.length) return { ok: false, reason: 'secret', hits: preHits, steps };

  // 1. Stage ONLY this replica's numeric segment files. Peers' partitions arrive
  //    already-committed via pull; a stray non-segment *.ndjson (which the secret
  //    scan does NOT cover) and unrelated user work are never swept in.
  const myDirRel = `.maddu/events/by-replica/${replicaId}`;
  const mySegs = await listSegs(join(repoRoot, myDirRel));
  const stagePaths = mySegs.map((s) => `${myDirRel}/${s}`);
  // The sync-managed ignore/attr files must land ONCE so peers track partitions —
  // but only when UNTRACKED, so a user's own edits to a pre-existing (tracked)
  // .gitignore/.gitattributes are never folded into a spine-sync commit.
  const uncommittedMeta = [];
  for (const f of ['.gitignore', '.gitattributes']) {
    if (!(await dirExists(join(repoRoot, f)))) continue;
    const tracked = await gitRun(['ls-files', '--error-unmatch', '--', f], repoRoot, 5000);
    if (tracked.code === 0) continue; // already tracked → not ours to commit
    // Untracked → first share, but ONLY if the file is the maddu-managed block
    // and nothing else. A user's pre-existing untracked .gitignore rules must
    // NOT be published by sync — flag it for the operator to commit themselves.
    const content = await readFile(join(repoRoot, f), 'utf8').catch(() => '');
    if (isSyncManagedOnlyDotfile(f, content)) stagePaths.push(f);
    else uncommittedMeta.push(f);
  }

  let committed = false;
  if (stagePaths.length) {
    const add = await gitRun(['add', '--', ...stagePaths], repoRoot, 20000);
    if (add.code !== 0) return { ok: false, reason: 'git-add-failed', detail: (add.stderr || add.error || '').trim(), steps };
    // 0 = our paths have no staged changes; 1 = they do; anything else is a real
    // git error we surface (never silently skip a commit of pending spine data).
    const diff = await gitRun(['diff', '--cached', '--quiet', '--', ...stagePaths], repoRoot, 10000);
    if (diff.code === 1) {
      // Commit ONLY our pathspec, under the canonical subject the pre-push audit
      // recognizes as sync-owned — never fold in unrelated staged work. Hooks are
      // NOT bypassed: repo policy applies and a hook failure surfaces cleanly.
      const commit = await gitRun(['commit', '-m', syncCommitSubject(replicaId), '--', ...stagePaths], repoRoot, 20000);
      if (commit.code !== 0) return { ok: false, reason: 'git-commit-failed', detail: (commit.stderr || commit.error || '').trim(), steps };
      committed = true;
    } else if (diff.code !== 0) {
      return { ok: false, reason: 'git-status-failed', detail: (diff.stderr || diff.error || '').trim(), steps };
    }
  }
  steps.push({ step: 'commit', committed });

  // Upstream presence gates the network hops — a local-only repo (no tracking
  // branch) still commits, and reports pull/push as skipped rather than erroring.
  const upstream = await gitRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot, 5000);
  const hasUpstream = upstream.code === 0 && upstream.stdout.trim().length > 0;

  // 2. Pull peers' partitions. Disjoint author dirs + merge=binary → never a
  //    conflict; if one somehow arises, abort OUR merge (we guaranteed above the
  //    tree was clean of a user operation) and report it — never push over it.
  let pulled = false;
  if (doPull && hasUpstream) {
    const pull = await gitRun(['pull', '--no-rebase', '--no-edit'], repoRoot, 60000);
    if (pull.code !== 0) {
      await gitRun(['merge', '--abort'], repoRoot, 10000);
      return { ok: false, reason: 'pull-conflict', detail: (pull.stderr || pull.error || '').trim(), committed, steps };
    }
    pulled = true;
  }
  steps.push({ step: 'pull', pulled });

  // 3. Validate the merged set before sharing further. A fork / structural fail /
  //    within-partition dup / secret in ANY partition means we do NOT push.
  const report = await importPartitions(repoRoot);
  steps.push({ step: 'import', ok: report.ok });
  if (!report.ok) return { ok: false, reason: 'import-failed', import: report, committed, pulled, steps };

  // 4. Push. Audit every unpushed commit in @{u}..HEAD COMMIT-BY-COMMIT (see
  //    auditUnpushed) so nothing but our own append/first-share reaches the
  //    remote. Then push an EXPLICIT refspec `HEAD:refs/heads/<upstream-branch>`
  //    to the tracked remote — NEVER a bare `git push`, whose `push.default` /
  //    `remote.*.push` config could publish OTHER local branches this audit never
  //    inspected. `--no-follow-tags` closes the annotated-tag side channel.
  let pushed = false;
  if (doPush && hasUpstream) {
    const audit = await auditUnpushed(gitRun, repoRoot, replicaId);
    if (audit.error) return { ok: false, reason: 'git-range-failed', detail: audit.error, committed, pulled, import: report, steps };
    if (!audit.ok) return { ok: false, reason: 'unrelated-commits', offending: audit.offending, committed, pulled, import: report, steps };
    const branchR = await gitRun(['symbolic-ref', '--short', 'HEAD'], repoRoot, 5000);
    if (branchR.code !== 0) return { ok: false, reason: 'push-failed', detail: 'detached HEAD', committed, pulled, import: report, steps };
    const branch = branchR.stdout.trim();
    const remoteR = await gitRun(['config', '--get', `branch.${branch}.remote`], repoRoot, 5000);
    const mergeR = await gitRun(['config', '--get', `branch.${branch}.merge`], repoRoot, 5000);
    if (remoteR.code !== 0 || mergeR.code !== 0) return { ok: false, reason: 'push-failed', detail: 'no tracked upstream remote/ref', committed, pulled, import: report, steps };
    const remote = remoteR.stdout.trim();
    // The upstream must be a proper branch ref (refs/heads/<name>) — fail closed
    // on any other tracked ref (e.g. a tag) so we never push HEAD to a mangled
    // refs/heads/refs/tags/... destination.
    const merge = mergeR.stdout.trim();
    if (!merge.startsWith('refs/heads/') || merge === 'refs/heads/') {
      return { ok: false, reason: 'push-failed', detail: `upstream is not a branch ref (${merge})`, committed, pulled, import: report, steps };
    }
    const remoteRef = merge.slice('refs/heads/'.length);
    const push = await gitRun(['push', '--no-follow-tags', remote, `HEAD:refs/heads/${remoteRef}`], repoRoot, 60000);
    if (push.code !== 0) return { ok: false, reason: 'push-failed', detail: (push.stderr || push.error || '').trim(), committed, pulled, import: report, steps };
    pushed = true;
  }
  steps.push({ step: 'push', pushed });

  return { ok: true, replicaId, committed, pulled, pushed, hasUpstream, uncommittedMeta, import: report, steps };
}

export { GITIGNORE_BEGIN, GITIGNORE_END, GITATTR_BEGIN };
