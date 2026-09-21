#!/usr/bin/env node
// checkpoint-spine-first — P0 audit fix 4 (A5-002): the spine wins.
//
// createCheckpoint() used to write .maddu/checkpoints/index.ndjson FIRST and
// append CHECKPOINT_CREATED second, so a crash between the two left a
// checkpoint that `maddu checkpoint list/show/rollback` would act on but the
// spine never recorded — the reverse of "derived ≠ projected". removeCheckpoint
// and createWorktree had the same order. Now every writer appends its spine
// event first and treats the index as a rebuildable cache, and listCheckpoints
// reconciles the index against the spine: a CHECKPOINT_CREATED with no index
// row is listed (marked `indexed:false`, branch/subject unknown), a
// CHECKPOINT_REMOVED hides the checkpoint whatever the index says, and a
// CHECKPOINT_WORKTREE_CREATED restores the worktree flag.
//
//   1. index write fails (index path is a directory) → createCheckpoint throws,
//      but the spine already carries CHECKPOINT_CREATED for that id.
//   2. index row lost (truncated) → the checkpoint is still listed and readable,
//      derived from the spine, and appears exactly once.
//   3. spine says removed, index still says present → hidden.
//   4. control: a normal create is listed once with its full index fields.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}

async function newRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-chk-'));
  const git = (args) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-q']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture: genesis']);
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}
const indexPath = (tmp) => path.join(tmp, '.maddu', 'checkpoints', 'index.ndjson');

async function main() {
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const cp = await import(pathToFileURL(path.join(LIB, 'checkpoints.mjs')).href);
  const eventsOf = (tmp) => spine.readAll(tmp);

  // ── 1. index write fails after the spine append ──
  {
    const tmp = await newRepo();
    try {
      await mkdir(indexPath(tmp), { recursive: true }); // a DIRECTORY where the index file goes → appendFile EISDIR
      let threw = null;
      try { await cp.createCheckpoint(tmp, { title: 'fixture one', by: 'ses_fixture' }); } catch (e) { threw = e; }
      ok('1: createCheckpoint throws when the index cannot be written', !!threw, threw ? threw.message : 'no throw');
      const created = (await eventsOf(tmp)).filter((e) => e.type === 'CHECKPOINT_CREATED');
      ok('1: the spine carries CHECKPOINT_CREATED although the index write failed (spine first)', created.length === 1, `events=${created.length}`);
      ok('1: the error names the recorded id so the operator can find it', !!threw && created.length === 1 && threw.message.includes(created[0].data.id), threw && threw.message);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── 2. index row lost → derived from the spine ──
  {
    const tmp = await newRepo();
    try {
      const rec = await cp.createCheckpoint(tmp, { title: 'fixture two', lane: 'general', by: 'ses_fixture' });
      await writeFile(indexPath(tmp), ''); // the crash window: spine has it, index does not
      const list = await cp.listCheckpoints(tmp);
      ok('2: a checkpoint with no index row is still listed, derived from the spine', list.length === 1 && list[0].id === rec.id, JSON.stringify(list.map((c) => c.id)));
      const one = list[0] || {};
      ok('2: the derived record carries id/commit/tag/title/lane/createdBy from the event', one.commit === rec.commit && one.tag === rec.tag && one.title === 'fixture two' && one.lane === 'general' && one.createdBy === 'ses_fixture', JSON.stringify(one));
      ok('2: the derived record says so (indexed:false) and leaves unknown fields null', one.indexed === false && one.branch === null && one.subject === null, JSON.stringify({ indexed: one.indexed, branch: one.branch, subject: one.subject }));
      const read = await cp.readCheckpoint(tmp, rec.id);
      ok('2: readCheckpoint finds it too', !!read && read.id === rec.id);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── 3. spine says removed, index still says present ──
  {
    const tmp = await newRepo();
    try {
      const rec = await cp.createCheckpoint(tmp, { title: 'fixture three', by: 'ses_fixture' });
      const indexAfterCreate = await readFile(indexPath(tmp), 'utf8');
      await cp.removeCheckpoint(tmp, rec.id, 'ses_fixture');
      await writeFile(indexPath(tmp), indexAfterCreate); // the crash window in reverse: the index never saw the remove
      const list = await cp.listCheckpoints(tmp);
      ok('3: a checkpoint the spine says was removed is hidden even though the index still lists it', list.length === 0, JSON.stringify(list.map((c) => c.id)));
      const removed = (await eventsOf(tmp)).filter((e) => e.type === 'CHECKPOINT_REMOVED');
      ok('3: CHECKPOINT_REMOVED is on the spine exactly once', removed.length === 1);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── 4. control: normal create ──
  {
    const tmp = await newRepo();
    try {
      const rec = await cp.createCheckpoint(tmp, { title: 'fixture four', by: 'ses_fixture' });
      const list = await cp.listCheckpoints(tmp);
      ok('4 control: a normal checkpoint is listed exactly once with its index fields', list.length === 1 && list[0].id === rec.id && list[0].branch !== null && list[0].indexed !== false, JSON.stringify(list.map((c) => ({ id: c.id, branch: c.branch, indexed: c.indexed }))));
      const events = await eventsOf(tmp);
      ok('4 control: exactly one CHECKPOINT_CREATED and the index has one put row', events.filter((e) => e.type === 'CHECKPOINT_CREATED').length === 1 && (await readFile(indexPath(tmp), 'utf8')).trim().split('\n').length === 1);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  console.log('');
  console.log(`checkpoint-spine-first: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('checkpoint-spine-first OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
