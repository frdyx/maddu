// Test `spine import` validation (roadmap #12c phase 3b). Run:
//   node scripts/test/spine-import.mjs
//
// import is READ-ONLY: it validates the partitions git placed on disk. A per-
// partition chain fork is FATAL (option b makes the chain strictly valid), a secret
// in a partition is FATAL, and re-import is idempotent (position identity).

import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashLine, EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';
import { importPartitions } from '../../template/maddu/runtime/lib/spine-sync.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const TYPE = Object.keys(EVENT_TYPES)[0];
let idc = 0;
const eid = () => `evt_20260101000000_${String(++idc).padStart(6, '0').replace(/\d/g, (d) => 'abcdef'[d % 6])}`;

function chainLines(evs) {
  const lines = []; let prev = null;
  for (const e of evs) {
    const ev = { v: 1, id: e.id || eid(), ts: e.ts || '2026-01-01T00:00:00Z', type: e.type || TYPE, actor: null, lane: null, data: e.data || {}, prev_hash: prev };
    const line = JSON.stringify(ev); lines.push(line); prev = hashLine(line);
  }
  return lines;
}
async function part(repo, rid, evs) {
  const dir = join(repo, '.maddu', 'events', 'by-replica', rid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '000000000001.ndjson'), chainLines(evs).join('\n') + '\n');
  return dir;
}
async function syncRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-import-'));
  await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true }); // a real sync repo always has one
  await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repself' }));
  return repo;
}

async function main() {
  console.log('spine-import: partition validation');

  // 1. Two clean partitions → ok, both listed, totals summed.
  {
    const repo = await syncRepo();
    await part(repo, 'repA', [{ data: { n: 1 } }, { data: { n: 2 } }]);
    await part(repo, 'repB', [{ data: { n: 1 } }]);
    const r = await importPartitions(repo);
    ok(r.ok === true, 'clean partitions: ok');
    ok(r.totalEvents === 3, `totalEvents summed (got ${r.totalEvents})`);
    ok(r.partitions.length === 2 && r.partitions[0].replicaId === 'repA', 'both partitions listed, sorted');
    ok(r.forks.length === 0 && r.secretHits.length === 0, 'no forks, no secrets');
    await rm(repo, { recursive: true, force: true });
  }

  // 2. Idempotent: importing again yields the same report.
  {
    const repo = await syncRepo();
    await part(repo, 'repA', [{ data: { n: 1 } }, { data: { n: 2 } }]);
    const a = await importPartitions(repo);
    const b = await importPartitions(repo);
    ok(a.totalEvents === b.totalEvents && a.ok && b.ok, 're-import is idempotent (read-only)');
    await rm(repo, { recursive: true, force: true });
  }

  // 3. Forked partition → FATAL. repA carries a leading SPINE_CUTOVER anchor (as
  //    syncInit now seeds), so it is a strict/post-cutover chain where a fork is a
  //    chain_broken FAIL — collected as a fatal fork by importPartitions (audit P1).
  {
    const repo = await syncRepo();
    const dirA = await part(repo, 'repA', [{ type: 'SPINE_CUTOVER', data: { version: '1.98.0' } }, { data: { n: 1 } }]);
    await appendFile(join(dirA, '000000000001.ndjson'),
      JSON.stringify({ v: 1, id: eid(), ts: '2026-01-01T00:00:05Z', type: TYPE, actor: null, lane: null, data: {}, prev_hash: null }) + '\n');
    const r = await importPartitions(repo);
    ok(r.ok === false, 'forked partition: import NOT ok (fatal)');
    ok(r.forks.length === 1 && r.forks[0].replicaId === 'repA', 'fork reported with replicaId');
    await rm(repo, { recursive: true, force: true });
  }

  // 4. Secret in a partition → FATAL.
  {
    const repo = await syncRepo();
    await part(repo, 'repA', [{ data: { note: 'token sk-ant-' + 'A'.repeat(40) } }]);
    const r = await importPartitions(repo);
    ok(r.ok === false && r.secretHits.length >= 1, 'secret in partition: import NOT ok');
    ok(r.secretHits[0].patternTypes.includes('anthropic-api-key'), 'anthropic key flagged');
    await rm(repo, { recursive: true, force: true });
  }

  // 5. No partitions → ok, empty.
  {
    const repo = await syncRepo();
    const r = await importPartitions(repo);
    ok(r.ok === true && r.partitions.length === 0 && r.totalEvents === 0, 'no partitions: ok + empty');
    await rm(repo, { recursive: true, force: true });
  }

  // 6. Segment gap (000000000002 without 000000000001) → FATAL (Codex-found: a
  //    structural FAIL must not be reported "safe to merge").
  {
    const repo = await syncRepo();
    const dir = join(repo, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '000000000002.ndjson'), chainLines([{ data: {} }]).join('\n') + '\n');
    const r = await importPartitions(repo);
    ok(r.ok === false && r.structuralFails.length >= 1, 'segment gap → import NOT ok (structural fatal)');
    await rm(repo, { recursive: true, force: true });
  }

  // 7. duplicate id WITHIN a partition → FATAL; ACROSS partitions → tolerated.
  {
    const repo = await syncRepo();
    const DUP = 'evt_20260101000000_aaaaaa';
    // within: repA has the same id twice (single-writer bug)
    await part(repo, 'repA', [{ id: DUP, data: { n: 1 } }, { id: DUP, data: { n: 2 } }]);
    const rw = await importPartitions(repo);
    ok(rw.ok === false && rw.dupWithin.length >= 1, 'within-partition duplicate id → FATAL');
    await rm(repo, { recursive: true, force: true });

    const repo2 = await syncRepo();
    await part(repo2, 'repA', [{ id: DUP, data: {} }]);
    await part(repo2, 'repB', [{ id: DUP, data: {} }]);
    const ra = await importPartitions(repo2);
    ok(ra.dupAcross.length >= 1 && ra.dupWithin.length === 0, 'cross-partition duplicate id → tolerated (dupAcross, not fatal)');
    ok(ra.ok === true, 'cross-partition duplicate id alone does not fail import');
    await rm(repo2, { recursive: true, force: true });
  }

  console.log(`spine-import: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
