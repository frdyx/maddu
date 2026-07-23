// Unit tests for the PR-D detach-recovery READ model (worktree-recovery.mjs
// readPendingDetach + the strict partition reader). Run:
//   node scripts/test/worktree-recovery-fold.mjs
//
// Flat-mode (single-machine) coverage of §3.3's strict lifecycle fold — the
// rejects that must NEVER auto-finalize (plan test 9) plus the happy candidate.
// Origin classification for sync/foreign/unverifiable is covered against real
// partitions + lineage in the recovery integration test; here origin is local by
// construction (no partitions), so this isolates the fold + identity + accounting.

import { mkdtemp, rm, mkdir, readdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append } from '../../template/maddu/runtime/lib/spine.mjs';
import { readPartitionStreamsStrict } from '../../template/maddu/runtime/lib/spine-append-core.mjs';
import { readPendingDetach } from '../../template/maddu/runtime/lib/worktree-recovery.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

async function freshRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-wtrec-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  return repo;
}
async function attach(repo, { aid, lane, path, token, session = 'ses_owner' }) {
  return append(repo, { type: 'WORKTREE_ATTACHED', actor: session, lane, data: {
    schemaVersion: 1, attachmentId: aid, claimEventId: 'evt_c', lane, session,
    pathRepoRel: path, pathAbs: `/abs/${path}`, branchRef: `refs/heads/maddu/lane/${lane}`,
    baseRef: null, baseHeadAtAttach: 'deadbeef', created: true, reused: false, dirty: false,
    gitCommonDir: '/abs/.git', platform: 'linux', worktreeInstanceId: token,
  } });
}
async function detaching(repo, { aid, lane, path, token, disposition = 'merged', intentId = 'wtd_1' }) {
  return append(repo, { type: 'WORKTREE_DETACHING', actor: 'ses_owner', lane, data: {
    schemaVersion: 1, intentId, attachmentId: aid, lane, pathRepoRel: path,
    worktreeInstanceId: token, disposition, integrationRef: 'refs/heads/main',
    integrationHead: 'cafe', branchHead: 'f00d', ancestorCheck: 'pass', dirtyAtDetach: false, reason: null,
  } });
}
async function detached(repo, { aid, lane, path, token }) {
  return append(repo, { type: 'WORKTREE_DETACHED', actor: 'ses_owner', lane, data: {
    schemaVersion: 1, attachmentId: aid, lane, pathRepoRel: path, disposition: 'merged',
    branchHead: 'f00d', integrationRef: 'refs/heads/main', integrationHead: 'cafe',
    ancestorCheck: 'pass', dirtyAtDetach: false, reason: null, worktreeInstanceId: token,
  } });
}

async function main() {
  console.log('worktree-recovery-fold: strict §3.3 lifecycle fold');

  // 1. Happy: one open intent, identity-matched → exactly one auto candidate.
  {
    const repo = await freshRepo();
    await attach(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_alpha' });
    await detaching(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_alpha' });
    const r = await readPendingDetach(repo);
    ok(r.mode === 'flat', 'flat mode detected (no partitions)');
    ok(r.candidates.length === 1 && r.candidates[0].attachmentId === 'wta_1', 'one open intent → one auto candidate');
    ok(r.candidates[0].origin === 'local' && r.candidates[0].attachmentOwner === 'ses_owner', 'candidate is local + carries the attachment owner');
    ok(r.candidates[0].disposition === 'merged' && r.candidates[0].ancestorCheck === 'pass', 'candidate carries the verified disposition (no re-ancestry)');
    ok(r.surfaced.length === 0, 'nothing surfaced on the happy path');
    await rm(repo, { recursive: true, force: true });
  }

  // 2. Terminal present → the intent is resolved, no candidate.
  {
    const repo = await freshRepo();
    await attach(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_alpha' });
    await detaching(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_alpha' });
    await detached(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_alpha' });
    const r = await readPendingDetach(repo);
    ok(r.candidates.length === 0 && r.surfaced.length === 0, 'a landed terminal resolves the intent (no candidate, no surface)');
    await rm(repo, { recursive: true, force: true });
  }

  // 3. Two open intents for one attachment → ambiguous, never take-first.
  {
    const repo = await freshRepo();
    await attach(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_alpha' });
    await detaching(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_alpha', intentId: 'wtd_a' });
    await detaching(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_alpha', intentId: 'wtd_b' });
    const r = await readPendingDetach(repo);
    ok(r.candidates.length === 0, 'duplicate intents → NO auto candidate');
    ok(r.surfaced.every((s) => s.reason === 'ambiguous-duplicate-intent') && r.surfaced.length === 2, 'both duplicate intents surfaced as ambiguous');
    await rm(repo, { recursive: true, force: true });
  }

  // 4. Identity mismatch (wrong token) → surfaced, never auto.
  {
    const repo = await freshRepo();
    await attach(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_REAL' });
    await detaching(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_WRONG' });
    const r = await readPendingDetach(repo);
    ok(r.candidates.length === 0 && r.surfaced[0]?.reason === 'identity-mismatch', 'token mismatch → identity-mismatch, no candidate');
    await rm(repo, { recursive: true, force: true });
  }

  // 5. Competing live epochs on one lane → ambiguous.
  {
    const repo = await freshRepo();
    await attach(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_1' });
    await attach(repo, { aid: 'wta_2', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_2' });
    await detaching(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_1' });
    const r = await readPendingDetach(repo);
    ok(r.candidates.length === 0 && r.surfaced[0]?.reason === 'competing-live-epochs', 'two live epochs on a lane → competing-live-epochs');
    await rm(repo, { recursive: true, force: true });
  }

  // 6. Intent with no live attachment → surfaced no-live-attachment.
  {
    const repo = await freshRepo();
    await detaching(repo, { aid: 'wta_ghost', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_g' });
    const r = await readPendingDetach(repo);
    ok(r.candidates.length === 0 && r.surfaced[0]?.reason === 'no-live-attachment', 'intent with no ATTACHED → no-live-attachment');
    await rm(repo, { recursive: true, force: true });
  }

  // 7. Post-terminal intent (DETACHING after DETACHED) → surfaced post-terminal.
  {
    const repo = await freshRepo();
    await attach(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_1' });
    await detached(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_1' });
    await detaching(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_1' });
    const r = await readPendingDetach(repo);
    ok(r.candidates.length === 0 && r.surfaced.some((s) => s.reason === 'post-terminal'), 'DETACHING after DETACHED → post-terminal, no candidate');
    await rm(repo, { recursive: true, force: true });
  }

  // 8. Strict reader accounts parse errors; a torn source segment → source-parse-gap.
  {
    const repo = await freshRepo();
    await attach(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_1' });
    await detaching(repo, { aid: 'wta_1', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_1' });
    // Corrupt the flat segment with a torn line.
    const seg = join(repo, '.maddu', 'events', (await readdir(join(repo, '.maddu', 'events'))).find((f) => /^\d{12}\.ndjson$/.test(f)));
    await appendFile(seg, '{ this is not json\n');
    const streams = await readPartitionStreamsStrict(repo);
    ok(streams.find((s) => s.replicaId === '')?.parseErrors >= 1, 'strict reader counts the torn line as a parseError');
    const r = await readPendingDetach(repo);
    ok(r.candidates.length === 0 && r.surfaced[0]?.reason === 'source-parse-gap', 'a torn source stream → source-parse-gap, no auto');
    await rm(repo, { recursive: true, force: true });
  }

  // 9. Legacy adoption (Diff-r2 #3): a legacy ATTACHED carries NO worktreeInstanceId;
  //    its authorized removing detach mints one into the intent. The fold must accept
  //    the unique intent's token as identity (not identity-mismatch) so the crash is
  //    resumable/auto-finalizable — the on-disk token is still verified before removal.
  {
    const repo = await freshRepo();
    // legacy ATTACHED: hand-write with NO worktreeInstanceId.
    await append(repo, { type: 'WORKTREE_ATTACHED', actor: 'ses_owner', lane: 'alpha', data: {
      schemaVersion: 1, attachmentId: 'wta_legacy', claimEventId: 'evt_c', lane: 'alpha', session: 'ses_owner',
      pathRepoRel: '.maddu/worktrees/alpha', pathAbs: '/abs/alpha', branchRef: 'refs/heads/maddu/lane/alpha',
      baseRef: null, baseHeadAtAttach: 'deadbeef', created: true, reused: false, dirty: false,
      gitCommonDir: '/abs/.git', platform: 'linux' } }); // <- no worktreeInstanceId
    await detaching(repo, { aid: 'wta_legacy', lane: 'alpha', path: '.maddu/worktrees/alpha', token: 'tok_adopted' });
    const r = await readPendingDetach(repo);
    ok(r.candidates.length === 1 && r.candidates[0].attachmentId === 'wta_legacy', 'legacy adoption → a candidate (not identity-mismatch)');
    ok(r.candidates[0].worktreeInstanceId === 'tok_adopted', 'candidate adopts the intent token as identity');
    // A DIFFERENT token on the intent when the attachment ALREADY has one is still a mismatch.
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`worktree-recovery-fold: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
