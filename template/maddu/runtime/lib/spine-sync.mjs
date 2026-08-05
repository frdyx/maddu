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
import { isValidReplicaId, readReplicaId, partitionDir, pendingReplicaPath, appendPartitioned, FLAT_LOCK_VERSION, scanWsAuthorityEvents, resolveWsAuthority, verifyAnchorNomination, wsFromLine, hashLine, writeIdentityCache, publishWsAnchorOnce, computeAuthorityFingerprint, findIncompatibleWsStamp, buildWsGrandfather, maybeExtendWsCutoverLocked } from './spine-append-core.mjs';
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
// S2 (r4-F4/r5-F3): safe continuation of a stranded residual-flat migration
// in an ALREADY-activated workspace. Locking order is FIXED: flat append
// lock → active partition append lock (nested) — live partition appends use
// the partition lock, so the compatibility re-read inside both locks cannot
// race a concurrent append into a fork. Returns
//   { status:'migrated', segments } |
//   { status:'fatal', reason, remedy }.
// Safe means: no partition segment-name collision AND the residual chain's
// first prev_hash links the partition's CURRENT last stored line (it chains
// cleanly onto the tail). Residual segments written against the OLD
// pre-migration flat tail can never satisfy that — they get the named fatal.
async function continueResidualMigration(repoRoot, replicaId, residualSegs) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const pdir = partitionDir(repoRoot, replicaId);
  const flatLock = join(eventsDir, '.append.lock');
  const partLock = join(pdir, '.append.lock');
  const FATAL_REMEDY = 'inspect the residual segment(s) under .maddu/events/ — if their events are already represented in the partition, archive them out of .maddu/events/; otherwise re-append their events through `maddu` verbs and archive the files';
  try {
    return await withAppendLock(flatLock, async () =>
      withAppendLock(partLock, async () => {
        // Re-read INSIDE both locks (the pre-lock listing may be stale).
        const flats = await listSegs(eventsDir);
        if (!flats.length) return { status: 'migrated', segments: [] };
        const partSegs = await listSegs(pdir);
        for (const f of flats) {
          if (partSegs.includes(f)) {
            return { status: 'fatal', reason: `segment name ${f} collides with an existing partition segment`, remedy: FATAL_REMEDY };
          }
        }
        // Committed-element law (diff-funnel r10-F1): NEVER rename a torn
        // residual segment into the partition — a valid-JSON tail whose
        // newline was lost in a crashed append would become the partition's
        // poisoned active tail (verify: torn_trailing_line; every later
        // append: TORN_TAIL). Every residual segment must end with '\n'.
        for (const f of flats) {
          let txt;
          try { txt = await readFile(join(eventsDir, f), 'utf8'); }
          catch (e) { return { status: 'fatal', reason: `residual segment ${f} unreadable: ${e?.message || e}`, remedy: FATAL_REMEDY }; }
          if (txt.length && !txt.endsWith('\n')) {
            return { status: 'fatal', reason: `residual segment ${f} ends with an unterminated line (a crashed write) — append the missing newline if the JSON is complete, otherwise trim the partial line`, remedy: FATAL_REMEDY };
          }
        }
        // Tail compatibility: first residual line must chain onto the
        // partition's current last COMMITTED line (a torn partition tail is
        // equally fatal — the residual would chain past an uncommitted line).
        const firstFlatTxt = await readFile(join(eventsDir, flats[0]), 'utf8');
        const firstLine = firstFlatTxt.split('\n').find((l) => l.trim());
        if (!firstLine) return { status: 'fatal', reason: `residual segment ${flats[0]} is empty/unreadable`, remedy: FATAL_REMEDY };
        let firstPrev = null;
        try { firstPrev = JSON.parse(firstLine)?.prev_hash ?? null; }
        catch { return { status: 'fatal', reason: `residual segment ${flats[0]} first line is malformed`, remedy: FATAL_REMEDY }; }
        let tailLine = null;
        for (let i = partSegs.length - 1; i >= 0 && tailLine === null; i--) {
          const txt = await readFile(join(pdir, partSegs[i]), 'utf8');
          if (txt.length && !txt.endsWith('\n')) {
            return { status: 'fatal', reason: `partition segment ${partSegs[i]} ends with an unterminated line (a crashed write) — repair it before continuing the migration`, remedy: FATAL_REMEDY };
          }
          const lines = txt.split('\n').filter((l) => l.trim());
          if (lines.length) tailLine = lines[lines.length - 1];
        }
        if (!tailLine || firstPrev !== hashLine(tailLine)) {
          return { status: 'fatal', reason: 'residual chain does not link the partition tail (written against the pre-migration flat tail)', remedy: FATAL_REMEDY };
        }
        const moved = [];
        for (const f of flats) {
          await rename(join(eventsDir, f), join(pdir, f));
          moved.push(f);
        }
        return { status: 'migrated', segments: moved };
      }, { maxWaitMs: 10000 }), { maxWaitMs: 10000 });
  } catch (e) {
    return { status: 'fatal', reason: `continuation locking failed: ${e?.message || e}`, remedy: FATAL_REMEDY };
  }
}

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
    // ── S2 residual-flat continuation (plan-review r4-F4 / r5-F3) ──
    // Pre-existing residual flat segments in an ALREADY-activated workspace
    // (the funnel race the init-time barrier can't reach retroactively) used
    // to be permanently stranded behind this early return. Attempt a SAFE
    // continuation: flat lock AND active partition lock acquired in that
    // fixed order (live partition appends serialize on the latter), tail
    // compatibility re-read INSIDE both locks, rename only when every
    // residual segment (a) has no name collision in the partition and
    // (b) chains onto the partition's CURRENT tail. Anything else is a NAMED
    // fatal with the manual remedy — never a silent strand.
    const residual = await listSegs(join(repoRoot, '.maddu', 'events'));
    if (residual.length) {
      const cont = await continueResidualMigration(repoRoot, existing, residual);
      if (cont.status === 'fatal') {
        // A fatal continuation is a FAILURE, never "already in sync mode"
        // (diff-funnel r1-F5: reporting it ok:true stranded the residual
        // history silently behind an exit-0 no-op).
        return { ok: false, reason: 'residual-migration-fatal', message: cont.reason, remedy: cont.remedy, replicaId: existing, continuation: cont };
      }
      return { ok: true, already: true, replicaId: existing, continuation: cont };
    }
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

  // Write the pending marker FIRST — and UNDER the flat funnel lock, held
  // from here through migration and activation (diff-funnel r3-F3): a flat
  // writer's in-lock marker recheck and its appendFile are one critical
  // section, so publishing the marker inside the same funnel closes the
  // TOCTOU where the marker landed between a writer's recheck and its write
  // (which stranded that write — worst case a ceremony's WS_IDENTITY_RESOLVED
  // — in a residual flat segment migration had already snapshotted past).
  // Lock order stays flat → partition (publishWsAnchorOnce / the cutover
  // seed take the partition lock NESTED under this), matching
  // continueResidualMigration. From the marker on, a concurrent append()
  // WAITS for replica.json (the completion signal) before touching the
  // partition; readAll still sees the in-progress partition + residual flat
  // (readActiveReplicaId), so reads stay consistent.
  await mkdir(join(repoRoot, '.maddu', 'config'), { recursive: true });
  const flatFunnelDir = join(repoRoot, '.maddu', 'events');
  await mkdir(flatFunnelDir, { recursive: true });
  return withAppendLock(join(flatFunnelDir, '.append.lock'), async () => {
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
  // ── Workspace-identity anchor bootstrap (S2, plan-review r4-F2; hardened
  // diff-funnel r1-F4) ──
  // Runs for EVERY first-time or resumed init, OUTSIDE the empty-partition
  // branch, BEFORE replica.json publishes — and is a HARD precondition:
  // activation without a verified identity authority (or a cached conflict
  // awaiting the ceremony) would let this checkout stamp events into a
  // permanently unverifiable workspace. Failure returns a NAMED reason and
  // leaves the pending marker in place, so a re-run resumes exactly here.
  // Nomination target is this partition's first line: a NON-empty migration
  // nominates the migrated old flat genesis (its derivation equals the
  // workspace's prior flat identity, so already-ws-stamped migrated events
  // stay consistent); an empty migration nominates the cutover just seeded.
  // A workspace-wide anchor already present (peer partitions in a clone; a
  // crash-resumed init that got this far last time) is nomination-VERIFIED
  // and adopted, never duplicated — idempotent resumes by construction.
  {
    const WS_REMEDY = 'fix the reported partition/anchor state (or restore the missing bytes), then re-run `maddu spine sync init` — the pending marker keeps this resumable';
    const wsFail = (message) => ({ ok: false, reason: 'ws-identity-bootstrap-failed', message, remedy: WS_REMEDY });
    // (1) Verify what already exists — an unverifiable pre-existing anchor is
    // a named failure BEFORE we add anything.
    let scan;
    try { scan = await scanWsAuthorityEvents(repoRoot); }
    catch (e) { return wsFail(`authority scan failed: ${e?.message || e}`); }
    for (const a of scan.anchors) {
      const v = await verifyAnchorNomination(repoRoot, a.data);
      if (!v.ok) return wsFail(`existing anchor ${a.id} does not verify: ${v.reason}`);
    }
    // (2) Publish only when anchorless — through the ONE serialized law
    // (diff-funnel r2-F2: a direct appendPartitioned from a pre-lock scan
    // could double-publish against a racing writer, and nominating this
    // partition's first line instead of the canonical merge-first candidate
    // mis-anchors a clone joining an existing anchorless workspace).
    const law = resolveWsAuthority(scan);
    if (!law.conflict && !law.authority) {
      const anchorTs = now || new Date().toISOString();
      let pub;
      try {
        pub = await publishWsAnchorOnce(repoRoot, replicaId, ({ spineIdentity, genesis }) => ({
          v: 1,
          id: makeId('evt', anchorTs),
          ts: anchorTs,
          type: 'WS_IDENTITY_ANCHORED',
          actor: null,
          lane: null,
          data: { v: 1, spineIdentity, genesis },
        }));
      } catch (e) { return wsFail(`anchor publication failed: ${e?.message || e}`); }
      if (pub.unresolvable) return wsFail(`anchor publication failed: ${pub.unresolvable}`);
      if (pub.bootstrap) return wsFail(`partition ${replicaId} has no genesis line to nominate`);
      // adopted / published / conflict — all resolved by the post-verify below.
    }
    // (3) FRESH post-verify before activation: whatever the workspace holds
    // NOW (our anchor, an adopted one, or a raced conflict) must verify and
    // resolve — activation without a defined identity state is forbidden
    // (r1-F4). A verified conflict IS a defined state: freeze + ceremony.
    const fpPre2 = await computeAuthorityFingerprint(repoRoot).catch(() => null); // pre-scan: makes the final cache provably fresh
    let scan2;
    try { scan2 = await scanWsAuthorityEvents(repoRoot); }
    catch (e) { return wsFail(`post-publication authority scan failed: ${e?.message || e}`); }
    for (const a of scan2.anchors) {
      const v = await verifyAnchorNomination(repoRoot, a.data);
      if (!v.ok) return wsFail(`anchor ${a.id} does not verify after bootstrap: ${v.reason}`);
    }
    const law2 = resolveWsAuthority(scan2);
    if (law2.conflict) {
      await writeIdentityCache(repoRoot, { spineIdentity: null, conflict: true, mode: 'sync' }).catch(() => {});
    } else if (law2.authority) {
      // Adoption-side history compatibility (diff-funnel r4-F2): activating
      // with an authority that instantly FAILs migrated stamped history is
      // never correct — grandfathered losing stamps pass, anything else is
      // the named failure.
      const badAdopt = await findIncompatibleWsStamp(repoRoot, law2.authority, buildWsGrandfather(scan2.anchors, scan2.resolutions));
      if (badAdopt) {
        return wsFail(`existing event ${badAdopt.id} is stamped ${badAdopt.ws}, incompatible with the workspace authority ${law2.authority}`);
      }
      await writeIdentityCache(repoRoot, { spineIdentity: law2.authority, mode: 'sync', fp: fpPre2 }).catch(() => {});
    } else {
      return wsFail('no identity authority exists after the anchor bootstrap');
    }
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
  }); // end of the flat-funnel critical section opened at the pending-marker write (r3-F3)
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
  // The whole snapshot-and-merge phase — segment enumeration, torn-tail
  // check, staging, the pathspec commit, the upstream probe, AND the pull —
  // runs UNDER ONE uninterrupted hold of the active partition's append lock
  // (diff-funnel r13-F1 + r14-F1): `git add` racing a writer mid-append
  // could commit a segment blob cut before the trailing newline (the
  // pre-push audit's prefix-extension rule would publish that torn blob),
  // and any gap before the pull would let a local append land just before
  // peer AUTHORITY bytes whose cutover binds the pre-append head. Under the
  // lock the files are whole-line by construction; a segment torn by a
  // CRASH (no writer active) is refused with the repair remedy rather than
  // shared.
  const myDirRel = `.maddu/events/by-replica/${replicaId}`;
  const commitLockPath = join(partitionDir(repoRoot, replicaId), '.append.lock');
  await mkdir(partitionDir(repoRoot, replicaId), { recursive: true });
  let commitOutcome;
  try {
    commitOutcome = await withAppendLock(commitLockPath, async () => {
      const mySegs = await listSegs(join(repoRoot, myDirRel));
      for (const s of mySegs) {
        const txt = await readFile(join(repoRoot, myDirRel, s), 'utf8').catch(() => null);
        if (txt === null) return { fail: { ok: false, reason: 'git-add-failed', detail: `segment ${s} unreadable`, steps } };
        if (txt.length && !txt.endsWith('\n')) {
          return { fail: { ok: false, reason: 'torn-segment', detail: `segment ${s} ends with an unterminated line (a crashed write) — append the missing newline if the JSON is complete, otherwise trim the partial line, then re-run \`maddu spine sync\``, steps } };
        }
      }
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

      let committedIn = false;
      if (stagePaths.length) {
        const add = await gitRun(['add', '--', ...stagePaths], repoRoot, 20000);
        if (add.code !== 0) return { fail: { ok: false, reason: 'git-add-failed', detail: (add.stderr || add.error || '').trim(), steps } };
        // 0 = our paths have no staged changes; 1 = they do; anything else is a real
        // git error we surface (never silently skip a commit of pending spine data).
        const diff = await gitRun(['diff', '--cached', '--quiet', '--', ...stagePaths], repoRoot, 10000);
        if (diff.code === 1) {
          // Commit ONLY our pathspec, under the canonical subject the pre-push audit
          // recognizes as sync-owned — never fold in unrelated staged work. Hooks are
          // NOT bypassed: repo policy applies and a hook failure surfaces cleanly.
          const commit = await gitRun(['commit', '-m', syncCommitSubject(replicaId), '--', ...stagePaths], repoRoot, 20000);
          if (commit.code !== 0) return { fail: { ok: false, reason: 'git-commit-failed', detail: (commit.stderr || commit.error || '').trim(), steps } };
          committedIn = true;
        } else if (diff.code !== 0) {
          return { fail: { ok: false, reason: 'git-status-failed', detail: (diff.stderr || diff.error || '').trim(), steps } };
        }
      }
      // ── 2. Upstream probe + pull, INSIDE the SAME critical section ──
      // (diff-funnel r14-F1: releasing the lock between the snapshot commit
      // and the pull left a gap where a concurrent writer could append an
      // A-stamped event at H+1 just before the pull delivered a resolution
      // whose cutover binds head H — an unhealable post-cutover losing
      // stamp. One uninterrupted lock covers snapshot → probe → pull; peer
      // AUTHORITY bytes can never interleave with a local append. r12-F1's
      // rationale for fencing the pull itself also lives here. Appends wait
      // (or best-effort callers drop) for the phase's duration — a
      // workspace receiving new authority SHOULD quiesce.)
      const upstream = await gitRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot, 5000);
      const hasUpstreamIn = upstream.code === 0 && upstream.stdout.trim().length > 0;
      let pulledIn = false;
      if (doPull && hasUpstreamIn) {
        const pull = await gitRun(['pull', '--no-rebase', '--no-edit'], repoRoot, 60000);
        if (pull.code !== 0) {
          await gitRun(['merge', '--abort'], repoRoot, 10000);
          return { fail: { ok: false, reason: 'pull-conflict', detail: (pull.stderr || pull.error || '').trim(), committed: committedIn, steps } };
        }
        pulledIn = true;
        // Cutover EXTENSION (diff-funnel r15-F1), still under the SAME lock:
        // if the pulled resolution's heads predate this checkout's own
        // pre-adoption offline work (losing stamps beyond the bound heads —
        // legitimately appended before this checkout learned of the
        // ceremony), append a same-selection extension with fresh heads and
        // commit it NOW, so the grandfathered coverage travels with this
        // sync instead of leaving unhealable post-cutover mismatches.
        const extTs = new Date().toISOString();
        const ext = await maybeExtendWsCutoverLocked(repoRoot, partitionDir(repoRoot, replicaId), (selected, conflicts) => ({
          v: 1, id: makeId('evt', extTs), ts: extTs,
          type: 'WS_IDENTITY_RESOLVED', actor: null, lane: null,
          data: { selected, conflicts },
        }));
        if (ext.unresolvable) {
          return { fail: { ok: false, reason: 'import-failed', detail: `cutover-extension scan failed: ${ext.unresolvable}`, committed: committedIn, steps } };
        }
        if (ext.extended) {
          const segsNow = await listSegs(join(repoRoot, myDirRel));
          const extPaths = segsNow.map((s) => `${myDirRel}/${s}`);
          const add2 = await gitRun(['add', '--', ...extPaths], repoRoot, 20000);
          if (add2.code !== 0) return { fail: { ok: false, reason: 'git-add-failed', detail: (add2.stderr || add2.error || '').trim(), committed: committedIn, steps } };
          const commit2 = await gitRun(['commit', '-m', syncCommitSubject(replicaId), '--', ...extPaths], repoRoot, 20000);
          if (commit2.code !== 0) return { fail: { ok: false, reason: 'git-commit-failed', detail: (commit2.stderr || commit2.error || '').trim(), committed: committedIn, steps } };
          committedIn = true;
        }
      }
      return { committed: committedIn, uncommittedMeta, hasUpstream: hasUpstreamIn, pulled: pulledIn };
    }, { maxWaitMs: 60000 });
  } catch (e) {
    return { ok: false, reason: 'git-busy', detail: `append funnel contended: ${e?.message || e}`, steps };
  }
  if (commitOutcome.fail) return commitOutcome.fail;
  const committed = commitOutcome.committed;
  const uncommittedMeta = commitOutcome.uncommittedMeta;
  const hasUpstream = commitOutcome.hasUpstream;
  const pulled = commitOutcome.pulled;
  steps.push({ step: 'commit', committed });
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
