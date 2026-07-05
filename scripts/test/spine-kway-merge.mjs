// Test the sync-mode k-way merge read order (roadmap #12c phase 1c). Run:
//   node scripts/test/spine-kway-merge.mjs
//
// The load-bearing property: intra-partition order is seq ALWAYS; (ts, replicaId)
// only interleaves ACROSS partitions. A flat sort on ts would fail the
// backward-clock case — this test pins that it does not.

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kWayMergeStreams } from '../../template/maddu/runtime/lib/spine-append-core.mjs';
import { readAll, append } from '../../template/maddu/runtime/lib/spine.mjs';
import { EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const TYPE = Object.keys(EVENT_TYPES)[0];
const ev = (id, ts) => ({ id, ts, type: TYPE });

async function main() {
  console.log('spine-kway-merge: deterministic cross-partition merge');

  // 1. Interleave across two partitions by ts; seq preserved within each.
  {
    const A = { replicaId: 'A', events: [ev('a1', '2026-01-01T00:00:01Z'), ev('a2', '2026-01-01T00:00:03Z')] };
    const B = { replicaId: 'B', events: [ev('b1', '2026-01-01T00:00:02Z'), ev('b2', '2026-01-01T00:00:04Z')] };
    const order = kWayMergeStreams([A, B]).map((e) => e.id);
    ok(JSON.stringify(order) === JSON.stringify(['a1', 'b1', 'a2', 'b2']), `interleave by ts — got ${order}`);
  }

  // 2. BACKWARD-CLOCK invariant: partition A's second event has an EARLIER ts than
  //    its first. It MUST still come after a1 (seq wins intra-partition). A flat
  //    sort on ts would put a2 before a1 and b's between — assert we do not.
  {
    const A = { replicaId: 'A', events: [ev('a1', '2026-01-01T00:00:05Z'), ev('a2', '2026-01-01T00:00:01Z')] };
    const B = { replicaId: 'B', events: [ev('b1', '2026-01-01T00:00:03Z')] };
    const order = kWayMergeStreams([A, B]).map((e) => e.id);
    // b1(ts=3) < a1(ts=5) → b1 first; then A's stream head is a1, emitted in seq
    // before a2 regardless of a2's smaller ts.
    ok(order.indexOf('a1') < order.indexOf('a2'), `backward clock: a1 stays before a2 (seq) — got ${order}`);
    ok(JSON.stringify(order) === JSON.stringify(['b1', 'a1', 'a2']), `backward-clock full order — got ${order}`);
  }

  // 3. ts tie across partitions → replicaId breaks it deterministically.
  {
    const A = { replicaId: 'A', events: [ev('a', '2026-01-01T00:00:00Z')] };
    const B = { replicaId: 'B', events: [ev('b', '2026-01-01T00:00:00Z')] };
    ok(JSON.stringify(kWayMergeStreams([B, A]).map((e) => e.id)) === JSON.stringify(['a', 'b']),
      'ts tie resolves by replicaId, independent of stream input order');
  }

  // 4. Integration through readAll: two real partitions on disk merge in order.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-kway-'));
    const mk = async (rid, rows) => {
      const dir = join(repo, '.maddu', 'events', 'by-replica', rid);
      await mkdir(dir, { recursive: true });
      const body = rows.map((r) => JSON.stringify({ v: 1, id: r.id, ts: r.ts, type: TYPE, data: {} })).join('\n') + '\n';
      await writeFile(join(dir, '000000000001.ndjson'), body);
    };
    await mk('repA', [{ id: 'a1', ts: '2026-01-01T00:00:01Z' }, { id: 'a2', ts: '2026-01-01T00:00:03Z' }]);
    await mk('repB', [{ id: 'b1', ts: '2026-01-01T00:00:02Z' }]);
    const order = (await readAll(repo)).map((e) => e.id);
    ok(JSON.stringify(order) === JSON.stringify(['a1', 'b1', 'a2']), `readAll merges partitions on disk — got ${order}`);
    await rm(repo, { recursive: true, force: true });
  }

  // 5. Default mode unchanged: no by-replica dir → flat append order preserved.
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-flat-'));
    await append(repo, { type: TYPE, data: { n: 1 } });
    await append(repo, { type: TYPE, data: { n: 2 } });
    const evs = await readAll(repo);
    ok(evs.length === 2 && evs[0].data.n === 1 && evs[1].data.n === 2, 'default readAll preserves flat append order');
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`spine-kway-merge: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
