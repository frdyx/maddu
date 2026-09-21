#!/usr/bin/env node
// runtime-execution-store — the append-store contract (docs/57-product-runtime-
// rfc.md §7.3, ADR-003, V04 / V05 / V12, P2) over MemoryStore and FileStore.
//
//   1. Contract (both stores): seq/prev assigned by the store; head returned;
//      expectedHead compare-and-swap refuses a stale head and writes nothing;
//      an operation key appends once per run (duplicate_operation); a terminal
//      event closes the run (run_terminal); invalid envelopes are refused with
//      the validation codes; a caller-supplied seq/prev that disagrees is
//      refused; the queue bound reports `busy`.
//   2. Concurrency: N parallel appends to one run all land with unique
//      contiguous seqs and an unbroken chain — no interleaving, no lost write.
//   3. FileStore: ack is 'durable' with sync (fdatasync) and 'written' without;
//      a second store instance reloads the same events and head; a run id with
//      ':' maps to a safe file name; the file holds exactly the canonical lines.
//   4. Damage: a torn tail (partial last line) and a corrupt line are reported
//      with the readable prefix served unchanged; appends are refused with
//      torn_tail; the file bytes are never rewritten (V05).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, readFile, appendFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}
async function rejects(p) { try { await p; return null; } catch (e) { return e; } }

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { MemoryStore, FileStore, BaseStore, StoreError, ACK_LEVELS, DEFAULT_MAX_QUEUE, reduceRun, verifyRun, eventDigest, canonicalEncode, CONTRACT } = rt;

  ok('surface: MemoryStore and FileStore extend BaseStore; the default queue bound is 1024', new MemoryStore() instanceof BaseStore && Object.getPrototypeOf(FileStore) === BaseStore && DEFAULT_MAX_QUEUE === 1024 && new MemoryStore().maxQueue === DEFAULT_MAX_QUEUE);
  ok('surface: a BaseStore alone honours the contract with ack buffered', await new BaseStore().append({ contract: CONTRACT, id: 'b', run: 'b', type: 'RUN_STARTED', ts: '2026-09-21T00:00:00.000Z', tenant: 't', product: 'p', principal: 'u', agentVersion: '1', producer: { kind: 'host', id: 'h' }, payload: {} }).then((r) => r.ack === 'buffered' && r.seq === 1));

  const draft = (i, type, extra = {}, run = 'run-1') => ({
    contract: CONTRACT, id: `ev-${i}`, run, type, ts: '2026-09-21T00:00:00.000Z',
    tenant: 't', product: 'p', principal: 'u', agentVersion: '1.0.0', producer: { kind: 'host', id: 'h' }, payload: {}, ...extra,
  });

  ok('ACK_LEVELS pinned', ACK_LEVELS.join() === 'buffered,written,durable' && Object.isFrozen(ACK_LEVELS));

  // ── 1. contract on both stores ──
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-rt-store-'));
  try {
    for (const [label, make] of [['MemoryStore', () => new MemoryStore()], ['FileStore', () => new FileStore(path.join(tmp, 'contract'))]]) {
      const s = make();
      const r1 = await s.append(draft(1, 'RUN_STARTED'));
      ok(`${label}: first append → seq 1, head = digest`, r1.seq === 1 && r1.head === r1.digest && /^[0-9a-f]{64}$/.test(r1.head));
      ok(`${label}: ack level is one of the contract's`, ACK_LEVELS.includes(r1.ack) && (label === 'MemoryStore' ? r1.ack === 'buffered' : r1.ack === 'durable'), r1.ack);
      const r2 = await s.append(draft(2, 'ACTION_PROPOSED', { operation: 'op-1' }), { expectedHead: r1.head });
      ok(`${label}: expectedHead matching → appended with prev = head`, r2.seq === 2 && (await s.readRun('run-1')).events[1].prev === r1.head);
      const stale = await rejects(s.append(draft(3, 'app.x'), { expectedHead: r1.head }));
      ok(`${label}: stale expectedHead → head_mismatch, nothing written`, stale instanceof StoreError && stale.code === 'head_mismatch' && (await s.head('run-1')) === r2.head && (await s.readRun('run-1')).events.length === 2);
      const nullHead = await rejects(s.append(draft(3, 'app.x'), { expectedHead: null }));
      ok(`${label}: expectedHead null on a non-empty run → head_mismatch`, nullHead?.code === 'head_mismatch');
      await s.append(draft(3, 'ACTION_DECIDED', { operation: 'op-1', payload: { decision: 'allow' } }));
      const dup = await rejects(s.append(draft(4, 'ACTION_DECIDED', { operation: 'op-1', payload: { decision: 'allow' } })));
      ok(`${label}: same operation key twice → duplicate_operation (V12)`, dup?.code === 'duplicate_operation' && dup.detail.key === 'ACTION_DECIDED:op-1');
      ok(`${label}: a different type for the same operation is a new key`, (await s.append(draft(4, 'ACTION_STARTED', { operation: 'op-1' }))).seq === 4);
      const bad = await rejects(s.append(draft(5, 'CHECK_FINISHED', { payload: {} })));
      ok(`${label}: invalid envelope → invalid_event with validation detail`, bad?.code === 'invalid_event' && Array.isArray(bad.detail) && bad.detail.some((e) => e.code === 'missing_gate'));
      const wrongSeq = await rejects(s.append(draft(5, 'app.x', { seq: 9 })));
      ok(`${label}: caller-supplied seq that disagrees → seq_mismatch`, wrongSeq?.code === 'seq_mismatch');
      const wrongPrev = await rejects(s.append(draft(5, 'app.x', { prev: 'a'.repeat(64) })));
      ok(`${label}: caller-supplied prev that disagrees → prev_mismatch`, wrongPrev?.code === 'prev_mismatch');
      ok(`${label}: caller-supplied seq/prev that agree are accepted`, (await s.append(draft(5, 'app.x', { seq: 5, prev: await s.head('run-1') }))).seq === 5);
      const term = await s.append(draft(6, 'RUN_COMPLETED', { payload: { outcome: 'success' } }));
      const late = await rejects(s.append(draft(7, 'app.late')));
      ok(`${label}: after a terminal event → run_terminal`, late?.code === 'run_terminal' && late.detail.seq === 6 && (await s.head('run-1')) === term.head);
      const read = await s.readRun('run-1');
      ok(`${label}: readRun serves stored order, head, terminal, no damage`, read.events.length === 6 && read.head === term.head && read.terminal.type === 'RUN_COMPLETED' && read.damaged === null);
      ok(`${label}: readRun returns a copy`, (read.events.pop(), (await s.readRun('run-1')).events.length === 6));
      const red = reduceRun(read.events.concat((await s.readRun('run-1')).events.slice(5)));
      ok(`${label}: the stored run reduces to completed with no issues`, red.status === 'completed' && red.issues.length === 0 && red.head === term.head);
      ok(`${label}: unknown run → empty read, null head`, (await s.readRun('never')).events.length === 0 && (await s.head('never')) === null);
      ok(`${label}: runs are independent`, (await s.append(draft(1, 'RUN_STARTED', {}, 'run-2'))).seq === 1);
      ok(`${label}: bad event / bad run → rejected promise`, (await rejects(s.append(null)))?.code === 'bad_event' && (await rejects(s.append({ ...draft(1, 'app.x'), run: '' })))?.code === 'bad_run');
      ok(`${label}: describe() states the ack level`, typeof s.describe().kind === 'string' && ACK_LEVELS.includes(s.describe().ack));
    }

    // ── 2. concurrency ──
    for (const [label, s] of [['MemoryStore', new MemoryStore()], ['FileStore', new FileStore(path.join(tmp, 'conc'))]]) {
      const N = 40;
      const results = await Promise.all([s.append(draft(0, 'RUN_STARTED', {}, 'c')), ...Array.from({ length: N }, (_, i) => s.append(draft(i + 1, 'app.step', { operation: `op-${i}` }, 'c')))]);
      const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
      ok(`${label}: ${N + 1} concurrent appends → contiguous unique seqs`, seqs.length === N + 1 && seqs.every((q, i) => q === i + 1));
      const run = await s.readRun('c');
      ok(`${label}: chain intact after concurrency`, reduceRun(run.events).issues.length === 0 && run.head === eventDigest(run.events[N]));
    }
    {
      const s = new MemoryStore({ maxQueue: 2 });
      const ps = [s.append(draft(1, 'RUN_STARTED', {}, 'q')), s.append(draft(2, 'app.a', {}, 'q')), s.append(draft(3, 'app.b', {}, 'q'))];
      const settled = await Promise.allSettled(ps);
      ok('queue bound → third concurrent append refused with busy, first two land', settled[0].status === 'fulfilled' && settled[1].status === 'fulfilled' && settled[2].status === 'rejected' && settled[2].reason.code === 'busy');
      ok('after the queue drains, appends resume', (await s.append(draft(4, 'app.c', {}, 'q'))).seq === 3);
    }

    // ── 3. FileStore persistence ──
    {
      const dir = path.join(tmp, 'persist');
      const s = new FileStore(dir);
      const runId = 'tenant:run.1';
      const r1 = await s.append(draft(1, 'RUN_STARTED', {}, runId));
      const r2 = await s.append(draft(2, 'app.y', { payload: { z: 1, a: [1, 2] } }, runId));
      const file = s.pathFor(runId);
      ok('run id maps to a safe file name', path.basename(file) === 'tenant%3Arun.1.ndjson' && (await readdir(dir)).includes(path.basename(file)));
      const text = await readFile(file, 'utf8');
      const events = (await s.readRun(runId)).events;
      ok('the file holds exactly the canonical lines, newline-terminated', text === events.map((e) => canonicalEncode(e) + '\n').join(''));
      const s2 = new FileStore(dir);
      const reread = await s2.readRun(runId);
      ok('a fresh instance reloads the same events and head', reread.events.length === 2 && reread.head === r2.head && reread.damaged === null && r1.head === eventDigest(reread.events[0]));
      const r3 = await s2.append(draft(3, 'app.z', {}, runId), { expectedHead: r2.head });
      ok('the fresh instance continues the chain', r3.seq === 3 && (await new FileStore(dir).head(runId)) === r3.head);
      const nosync = new FileStore(path.join(tmp, 'nosync'), { sync: false });
      ok("sync:false → ack 'written', never claimed durable", (await nosync.append(draft(1, 'RUN_STARTED'))).ack === 'written' && nosync.describe().durable === false);
      ok('describe() of a syncing store says durable', s.describe().durable === true && s.describe().ack === 'durable');
      await s2.append(draft(4, 'RUN_FAILED', { payload: { outcome: 'failure' } }, runId));
      const lateAcrossInstances = await rejects(new FileStore(dir).append(draft(5, 'app.x', {}, runId)));
      ok('a terminal event persists as terminal across instances', lateAcrossInstances?.code === 'run_terminal');
      await s2.append(draft(1, 'RUN_STARTED', {}, 'r2'));
      await s2.append(draft(2, 'ACTION_PROPOSED', { operation: 'k' }, 'r2'));
      const dupAcrossInstances = await rejects(new FileStore(dir).append(draft(3, 'ACTION_PROPOSED', { operation: 'k' }, 'r2')));
      ok('a duplicate operation is detected across instances', dupAcrossInstances?.code === 'duplicate_operation');
    }

    // ── 4. damage ──
    {
      const dir = path.join(tmp, 'damage');
      const s = new FileStore(dir);
      await s.append(draft(1, 'RUN_STARTED', {}, 'd'));
      await s.append(draft(2, 'app.a', {}, 'd'));
      const file = s.pathFor('d');
      const before = await readFile(file);
      await appendFile(file, '{"contract":"maddu.runtime.v1","id":"ev-3","run":"d"');
      const torn = await readFile(file);
      const s2 = new FileStore(dir);
      const rr = await s2.readRun('d');
      ok('torn tail → damaged.reason torn_tail with the readable prefix served', rr.damaged?.reason === 'torn_tail' && rr.damaged.readable === 2 && rr.events.length === 2 && rr.head === eventDigest(rr.events[1]), JSON.stringify(rr.damaged));
      const refused = await rejects(s2.append(draft(3, 'app.b', {}, 'd')));
      ok('appends to a damaged run → torn_tail', refused?.code === 'torn_tail');
      ok('the file bytes are untouched (never repaired, never truncated)', Buffer.compare(await readFile(file), torn) === 0 && torn.length > before.length);
      const v = verifyRun({ events: rr.events, damaged: rr.damaged });
      ok('the verifier reports availability limited for a damaged run', v.dimensions.availability.status === 'limited' && v.verdict !== 'verified');

      const s3 = new FileStore(dir);
      await s3.append(draft(1, 'RUN_STARTED', {}, 'e'));
      await s3.append(draft(2, 'app.a', {}, 'e'));
      const f3 = s3.pathFor('e');
      await appendFile(f3, '{"a": 1}\n');
      const rc = await new FileStore(dir).readRun('e');
      ok('a complete but non-canonical/invalid line → corrupt_line at its line number', rc.damaged?.reason === 'corrupt_line' && rc.damaged.line === 3 && rc.events.length === 2, JSON.stringify(rc.damaged));

      const s4 = new FileStore(dir);
      await s4.append(draft(1, 'RUN_STARTED', {}, 'f'));
      const ev2 = { ...draft(2, 'app.a', {}, 'f'), seq: 2, prev: 'b'.repeat(64) };
      await appendFile(s4.pathFor('f'), canonicalEncode(ev2) + '\n');
      const rb = await new FileStore(dir).readRun('f');
      ok('a canonical line whose prev does not link → chain_broken damage', rb.damaged?.reason === 'chain_broken' && rb.events.length === 1);
      const stray = await new FileStore(dir).readRun('g');
      ok('an absent file is an empty run, not damage', stray.events.length === 0 && stray.damaged === null);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('');
  console.log(`runtime-execution-store: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-execution-store OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
