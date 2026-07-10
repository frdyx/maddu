// Test `spine sync init` (roadmap #12c phase 3a). Run:
//   node scripts/test/spine-sync-init.mjs
//
// Covers: legacy migration byte-identical (chain survives), replica.json minted +
// readReplicaId flips to sync mode, idempotency, the secret gate, and — against a
// REAL git repo via `git check-ignore` — that the templated .gitignore commits only
// partition segments while keeping locks, flat segments, and replica.json untracked.

import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { append, readAll, EVENT_TYPES, hashLine } from '../../template/maddu/runtime/lib/spine.mjs';
import { readReplicaId, resolveWriteReplica } from '../../template/maddu/runtime/lib/spine-append-core.mjs';
import { verifySpine } from '../../template/maddu/runtime/lib/verify.mjs';
import { syncInit, scanSpineForSecrets, importPartitions } from '../../template/maddu/runtime/lib/spine-sync.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const TYPE = Object.keys(EVENT_TYPES)[0];
async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function segs(dir) { try { return (await readdir(dir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort(); } catch { return []; } }
// audit P1 — these fixtures build PRE-cutover chains (generic events, no marker),
// so a mismatch now surfaces as chain_fork (WARN), not chain_broken (FAIL). Guard
// on BOTH kinds so a real fork/broken link is still caught (a chain_broken-only
// check would silently pass a forked pre-cutover chain).
const chainMismatches = (v) => v.issues.filter((i) => i.kind === 'chain_broken' || i.kind === 'chain_fork');

async function main() {
  console.log('spine-sync-init: team-sync activation');

  // 1. Migration byte-identical + chain survives + sync mode flips on.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-'));
    await append(repo, { type: TYPE, data: { n: 1 } });
    await append(repo, { type: TYPE, data: { n: 2 } });
    const flatBefore = join(repo, '.maddu', 'events', '000000000001.ndjson');
    const bytesBefore = await readFile(flatBefore, 'utf8');

    const res = await syncInit(repo, { mintId: () => 'rep_testinit01', now: '2026-01-01T00:00:00Z' });
    ok(res.ok && res.replicaId === 'rep_testinit01', 'syncInit ok, replicaId minted');
    ok(res.migrated.includes('000000000001.ndjson'), 'flat segment migrated');

    const partSeg = join(repo, '.maddu', 'events', 'by-replica', 'rep_testinit01', '000000000001.ndjson');
    ok(await exists(partSeg), 'segment now lives in the partition');
    ok((await readFile(partSeg, 'utf8')) === bytesBefore, 'migration is byte-identical (prev_hash chain survives)');
    ok((await segs(join(repo, '.maddu', 'events'))).length === 0, 'no flat segment left behind');
    ok((await readReplicaId(repo)) === 'rep_testinit01', 'readReplicaId now reports sync mode');

    const v = await verifySpine(repo);
    ok(v.counts.FAIL === 0 && chainMismatches(v).length === 0, 'migrated partition chain verifies clean');

    // A new append now lands in the partition and continues the chain.
    await append(repo, { type: TYPE, data: { n: 3 } });
    ok((await segs(join(repo, '.maddu', 'events', 'by-replica', 'rep_testinit01'))).length >= 1, 'post-init append targets the partition');
    const v2 = await verifySpine(repo);
    ok(v2.events === 3 && chainMismatches(v2).length === 0, 'chain still valid after post-init append');
    await rm(repo, { recursive: true, force: true });
  }

  // 1b. audit P1 — an EMPTY freshly-minted partition (a new replica joining an
  //     already-synced repo migrates nothing) is seeded with a SPINE_CUTOVER
  //     GENESIS, so it is STRICT: a later fork is a chain_broken FAIL and
  //     importPartitions reports it fatal (closes the markerless-partition gap).
  //     A NON-empty migration is NOT seeded (byte-identity preserved — test 1).
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-empty-'));
    await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
    const res = await syncInit(repo, { mintId: () => 'rep_empty01', now: '2026-01-01T00:00:00Z' });
    ok(res.ok, 'empty-repo sync init ok');
    const pseg = join(repo, '.maddu', 'events', 'by-replica', 'rep_empty01', '000000000001.ndjson');
    const evs = (await readFile(pseg, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    ok(evs.length === 1 && evs[0].type === 'SPINE_CUTOVER' && evs[0].prev_hash === null,
      `empty partition seeded with a SPINE_CUTOVER genesis (got ${JSON.stringify(evs.map((e) => e.type))})`);
    await append(repo, { type: TYPE, data: { n: 1 } }); // lands in the partition, strict
    // Hand-append a forked line (wrong prev_hash) → strict chain_broken FAIL.
    await writeFile(pseg, (await readFile(pseg, 'utf8')) + JSON.stringify({ v: 1, id: 'evt_20260101000009_ffffff', ts: '2026-01-01T00:00:09Z', type: TYPE, actor: null, lane: null, data: { n: 2 }, prev_hash: null }) + '\n');
    const v = await verifySpine(repo);
    ok(v.issues.some((i) => i.kind === 'chain_broken' && i.level === 'FAIL'), 'fork in a seeded (strict) partition is chain_broken FAIL');
    const imp = await importPartitions(repo);
    ok(imp.ok === false && imp.forks.length >= 1, 'importPartitions reports the seeded-partition fork fatal');
    await rm(repo, { recursive: true, force: true });
  }

  // 2. Idempotent: second init is a no-op returning the same replicaId.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-idem-'));
    await append(repo, { type: TYPE, data: {} });
    const a = await syncInit(repo, { mintId: () => 'rep_idem01' });
    const b = await syncInit(repo, { mintId: () => 'rep_SHOULD_NOT_BE_USED' });
    ok(a.ok && b.ok && b.already === true && b.replicaId === 'rep_idem01', 'second init is a no-op with same replicaId');
    await rm(repo, { recursive: true, force: true });
  }

  // 3. Secret gate: a secret-shaped line refuses init (no migration, no replica.json).
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-secret-'));
    await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
    const ev = { v: 1, id: 'evt_20260101000000_aaaaaa', ts: '2026-01-01T00:00:00Z', type: TYPE, actor: null, lane: null, data: { note: 'key AKIAIOSFODNN7EXAMPLE leaked' }, prev_hash: null };
    await writeFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), JSON.stringify(ev) + '\n');
    const hits = await scanSpineForSecrets(repo);
    ok(hits.length === 1 && hits[0].patternTypes.includes('aws-access-key'), 'scanSpineForSecrets flags the AWS key');
    const res = await syncInit(repo, { mintId: () => 'rep_secret01' });
    ok(!res.ok && res.reason === 'secret', 'syncInit refuses on a secret hit');
    ok(!(await exists(join(repo, '.maddu', 'config', 'replica.json'))), 'no replica.json written on refusal');
    ok(!(await exists(join(repo, '.maddu', 'events', 'by-replica'))), 'no migration on refusal');
    await rm(repo, { recursive: true, force: true });
  }

  // 3b. RESUME a partial migration (Codex-found): a prior init crashed after moving
  //     seg 1 into the partition (pending marker written, NO replica.json yet) with
  //     seg 2 still flat. Re-running must resume into the SAME replicaId (from the
  //     marker) and migrate the remainder — never mint a new one (chain split), and
  //     the reassembled partition chain must be intact.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-resume-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    // Build a continuous 3-event chain, split across two segments.
    let prev = null;
    const line = (n) => { const ev = { v: 1, id: `evt_20260101000000_00000${n}`, ts: '2026-01-01T00:00:0' + n + 'Z', type: TYPE, actor: null, lane: null, data: { n }, prev_hash: prev }; const s = JSON.stringify(ev); prev = hashLine(s); return s; };
    const l1 = line(1), l2 = line(2), l3 = line(3);
    const pdir = join(repo, '.maddu', 'events', 'by-replica', 'rep_resume01');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, '000000000001.ndjson'), l1 + '\n' + l2 + '\n');      // "already migrated"
    await writeFile(join(repo, '.maddu', 'events', '000000000002.ndjson'), l3 + '\n'); // residual flat
    await writeFile(join(repo, '.maddu', 'config', 'replica.pending.json'), JSON.stringify({ replicaId: 'rep_resume01' }));

    const res = await syncInit(repo, { mintId: () => 'rep_SHOULD_NOT_MINT' });
    ok(res.ok && res.replicaId === 'rep_resume01', 'resume uses the pending marker replicaId (no new mint)');
    ok(res.migrated.includes('000000000002.ndjson'), 'resume migrates the residual flat segment');
    ok((await segs(join(repo, '.maddu', 'events'))).length === 0, 'no flat segment left after resume');
    ok(!(await exists(join(repo, '.maddu', 'events', 'by-replica', 'rep_SHOULD_NOT_MINT'))), 'no split partition minted');
    ok(await exists(join(repo, '.maddu', 'config', 'replica.json')), 'replica.json written after migration completed');
    ok(!(await exists(join(repo, '.maddu', 'config', 'replica.pending.json'))), 'pending marker cleared');
    const v = await verifySpine(repo);
    ok(v.events === 3 && chainMismatches(v).length === 0, 'reassembled partition chain is intact (3 events, no fork)');
    await rm(repo, { recursive: true, force: true });
  }

  // 3d. Codex's race: appends CONCURRENT with sync init must never fork the partition
  //     chain and must never lose an event. The invariants the design actually
  //     GUARANTEES here (and that we assert) are:
  //       (1) NO EVENT IS EVER LOST — every append lands somewhere the merged read
  //           sees (partition, or a stranded flat segment via the flat-legacy stream).
  //       (2) THE FUNNEL ADDS NO FORKS — once init has committed, every subsequent
  //           append goes through the per-partition lock and never breaks the chain.
  //       (3) A FORK, IF PRESENT, IS SURFACED — verify reports it, never silence.
  //     Historically (pre-v1.98.0) appends that hit the PRE-MARKER window took the
  //     lock-free flat path and two such appends could fork the FLAT chain, which
  //     migration then carried into the partition — the documented "run sync init
  //     while writes are quiescent" residual. Since v1.98.0 (audit P1) the flat
  //     append is funnel-locked too (appendFlatChained), so that window no longer
  //     forks in practice; either way any residual fork is SURFACED by verify
  //     (chain_fork on a pre-cutover chain / chain_broken on a strict one), counted
  //     via chainMismatches() below, and the funnel-adds-no-forks invariant holds.
  {
    let legacyWindowForks = 0;
    for (let iter = 0; iter < 6; iter++) {
      const repo = await mkdtemp(join(tmpdir(), 'maddu-si-conc-'));
      await append(repo, { type: TYPE, data: { seed: 1 } });
      await append(repo, { type: TYPE, data: { seed: 2 } });
      const APPENDS = 4;
      const jobs = [syncInit(repo, { mintId: () => `rep_conc${iter}` })];
      for (let k = 0; k < APPENDS; k++) jobs.push(append(repo, { type: TYPE, data: { c: k } }));
      const [res] = await Promise.all(jobs);
      ok(res.ok, `iter ${iter}: concurrent sync init ok`);

      // (1) no event lost — the hard guarantee, unconditional.
      const all = await readAll(repo);
      ok(all.length === 2 + APPENDS, `iter ${iter}: no event lost (${all.length}/${2 + APPENDS} in merged read)`);

      // Snapshot legacy-window forks migration carried in (tolerated, surfaced —
      // counted for visibility), then prove the FUNNEL adds none: two post-commit
      // appends — pure funnel path — must not grow the broken-link set.
      const vAfterInit = await verifySpine(repo);
      const forksAfterInit = chainMismatches(vAfterInit).length;
      if (forksAfterInit > 0) legacyWindowForks++;
      await append(repo, { type: TYPE, data: { post: 1 } });
      await append(repo, { type: TYPE, data: { post: 2 } });
      const vFinal = await verifySpine(repo);
      const forksFinal = chainMismatches(vFinal).length;
      // (2) funnel adds no forks above the committed tail.
      ok(forksFinal === forksAfterInit, `iter ${iter}: funnel adds no forks (before=${forksAfterInit}, after=${forksFinal})`);
      // (3) post-commit appends land in the merged read.
      const allFinal = await readAll(repo);
      ok(allFinal.length === 2 + APPENDS + 2, `iter ${iter}: post-commit appends land (${allFinal.length}/${2 + APPENDS + 2})`);
      await rm(repo, { recursive: true, force: true });
    }
    if (legacyWindowForks > 0) {
      console.log(`  (i) ${legacyWindowForks}/6 iteration(s) surfaced a pre-marker-window fork (documented single-machine residual — tolerated, surfaced by verify)`);
    }
  }

  // 3e. Codex's resume-fork race: a crashed init left a marker + seg1 in the
  //     partition + seg2 flat. A concurrent append must NOT chain onto the partial
  //     partition (that forked the committed chain). With wait-on-pending it waits
  //     for the resuming init to commit, then chains from the completed tail.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-resume-race-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    let prev = null;
    const line = (n) => { const ev = { v: 1, id: `evt_20260101000000_00000${n}`, ts: '2026-01-01T00:00:0' + n + 'Z', type: TYPE, actor: null, lane: null, data: { n }, prev_hash: prev }; const s = JSON.stringify(ev); prev = hashLine(s); return s; };
    const l1 = line(1), l2 = line(2);
    const pdir = join(repo, '.maddu', 'events', 'by-replica', 'rep_rr01');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, '000000000001.ndjson'), l1 + '\n');            // seg1 migrated pre-crash
    await writeFile(join(repo, '.maddu', 'events', '000000000002.ndjson'), l2 + '\n'); // seg2 residual flat
    await writeFile(join(repo, '.maddu', 'config', 'replica.pending.json'), JSON.stringify({ replicaId: 'rep_rr01' }));

    const [res] = await Promise.all([
      syncInit(repo, { mintId: () => 'rep_NOPE' }),
      append(repo, { type: TYPE, data: { n: 3 } }),
    ]);
    ok(res.ok && res.replicaId === 'rep_rr01', 'resume-race: init resumes into the marker replicaId');
    const v = await verifySpine(repo);
    ok(chainMismatches(v).length === 0, 'resume-race: concurrent append did NOT fork the committed chain');
    ok((await readAll(repo)).length === 3, 'resume-race: all 3 events present');
    await rm(repo, { recursive: true, force: true });
  }

  // 3f. resolveWriteReplica unit: committed→{id}, default→{flat}, stalled marker→{pending}.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-rwr-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    ok((await resolveWriteReplica(repo)).flat === true, 'resolveWriteReplica: default repo → flat');
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'rep_c01' }));
    ok((await resolveWriteReplica(repo)).id === 'rep_c01', 'resolveWriteReplica: committed → id');
    await rm(join(repo, '.maddu', 'config', 'replica.json'));
    await writeFile(join(repo, '.maddu', 'config', 'replica.pending.json'), JSON.stringify({ replicaId: 'rep_p01' }));
    ok((await resolveWriteReplica(repo, { timeoutMs: 80, pollMs: 20 })).pending === true, 'resolveWriteReplica: stalled marker → pending (never writes)');
    // Partial replica.json mid-publish + marker present → transient, waits (pending),
    // NOT a "malformed" crash (Codex-found atomic-publish window).
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), '{');
    let threw = false;
    try { const r = await resolveWriteReplica(repo, { timeoutMs: 60, pollMs: 20 }); ok(r.pending === true, 'partial replica.json while pending → pending (no crash)'); }
    catch { threw = true; }
    ok(!threw, 'partial replica.json while pending does NOT throw malformed');
    await rm(repo, { recursive: true, force: true });
  }

  // 3g. Two concurrent `spine sync init` runs (Codex-found) are serialized by the
  //     init lock: exactly one mints + publishes; the other returns already. Never a
  //     split (two partition dirs, or replica.json id ≠ the migrated partition).
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-double-'));
    await append(repo, { type: TYPE, data: { n: 1 } });
    let n = 0;
    const nextId = () => `rep_dbl${n++}`; // distinct id per call so a split would show
    const [a, b] = await Promise.all([
      syncInit(repo, { mintId: nextId }),
      syncInit(repo, { mintId: nextId }),
    ]);
    ok(a.ok && b.ok, 'both concurrent inits ok');
    ok((a.already === true) !== (b.already === true), 'exactly one init did the work, the other returned already');
    const parts = await readdir(join(repo, '.maddu', 'events', 'by-replica'));
    ok(parts.length === 1, `exactly one partition dir (got ${parts.length}: ${parts.join(',')})`);
    const committed = await readReplicaId(repo);
    ok(parts[0] === committed, 'replica.json id matches the single partition dir (no split)');
    ok((await verifySpine(repo)).counts.FAIL === 0, 'no verify failure after concurrent init');
    await rm(repo, { recursive: true, force: true });
  }

  // 3c. Secret gate runs on RESUME too (Codex-found: already-init must not mask a
  //     secret that appeared after the first init).
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-resume-secret-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'rep_rs01' }));
    const dir = join(repo, '.maddu', 'events', 'by-replica', 'rep_rs01');
    await mkdir(dir, { recursive: true });
    const ev = { v: 1, id: 'evt_20260101000000_aaaaaa', ts: '2026-01-01T00:00:00Z', type: TYPE, actor: null, lane: null, data: { k: 'AKIAIOSFODNN7EXAMPLE' }, prev_hash: null };
    await writeFile(join(dir, '000000000001.ndjson'), JSON.stringify(ev) + '\n');
    const res = await syncInit(repo, { mintId: () => 'rep_rs01' });
    ok(!res.ok && res.reason === 'secret', 'resume refuses when a secret is now present');
    await rm(repo, { recursive: true, force: true });
  }

  // 4. gitignore templating against a REAL git repo (git check-ignore).
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-si-git-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // Mirror the REAL `maddu init` shape: .maddu/* ignored, but .maddu/config/ is
    // RE-INCLUDED (durable) with NO config/* re-ignore — so every transient sync file
    // under config/ must be ignored by the sync block itself, not the base.
    await writeFile(join(repo, '.gitignore'), '.maddu/*\n!.maddu/config/\n');
    await append(repo, { type: TYPE, data: {} });
    const res = await syncInit(repo, { mintId: () => 'rep_git01' });
    ok(res.ok, 'syncInit ok in a git repo');

    const ignored = (rel) => {
      try { execFileSync('git', ['check-ignore', '-q', rel], { cwd: repo }); return true; }
      catch (e) { if (e.status === 1) return false; throw e; }
    };
    ok(!ignored('.maddu/events/by-replica/rep_git01/000000000001.ndjson'), 'partition segment is TRACKED (not ignored)');
    ok(ignored('.maddu/events/by-replica/rep_git01/.append.lock'), 'partition .append.lock is ignored');
    ok(ignored('.maddu/config/replica.json'), 'replica.json is ignored (never committed)');
    ok(ignored('.maddu/config/replica.json.tmp'), 'replica.json.tmp (atomic publish) is ignored');
    ok(ignored('.maddu/config/replica.pending.json'), 'replica.pending.json (migration marker) is ignored');
    ok(ignored('.maddu/config/.sync-init.lock'), '.sync-init.lock is ignored');
    ok(ignored('.maddu/events/000000000001.ndjson'), 'a flat legacy segment would stay ignored');

    // .gitattributes marks partition ndjson -text so bytes survive cross-platform.
    const attr = await readFile(join(repo, '.gitattributes'), 'utf8');
    ok(/by-replica.*-text/.test(attr), '.gitattributes marks partition segments -text');
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`spine-sync-init: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
