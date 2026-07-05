// Test the sync-mode partitioned append wiring (roadmap #12c phase 1b). Run:
//   node scripts/test/spine-partition.mjs
//
// Asserts:
//   DEFAULT mode (no replica.json) — unchanged: append() and appendTokenUsage()
//   write the flat .maddu/events segment; NO by-replica dir; the token event
//   keeps its historical no-prev_hash shape.
//   SYNC mode (replica.json present) — append() and appendTokenUsage() land in
//   .maddu/events/by-replica/<replicaId>/ on ONE valid prev_hash chain; the flat
//   events dir gets no numeric segment.

import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append, EVENT_TYPES, hashLine } from '../../template/maddu/runtime/lib/spine.mjs';
import { readReplicaId } from '../../template/maddu/runtime/lib/spine-append-core.mjs';
import { appendTokenUsage } from '../../template/maddu/runtime/lib/runtimes/_wrapper-common.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const TYPE = Object.keys(EVENT_TYPES)[0];

async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function numericSegs(dir) {
  try { return (await readdir(dir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort(); }
  catch { return []; }
}
async function linesOf(file) {
  return (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim());
}
// Verify a file's NDJSON forms one unbroken prev_hash chain. Returns forkAt or -1.
async function chainForkAt(file) {
  const lines = await linesOf(file);
  for (let i = 0; i < lines.length; i++) {
    const ev = JSON.parse(lines[i]);
    const expected = i === 0 ? null : hashLine(lines[i - 1]);
    if ((ev.prev_hash ?? null) !== expected) return i;
  }
  return -1;
}

async function main() {
  console.log('spine-partition: sync-mode partitioned append wiring');

  // ── DEFAULT mode ──────────────────────────────────────────────────────────
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-spine-default-'));
    await append(repo, { type: TYPE, data: { n: 1 } });
    await append(repo, { type: TYPE, data: { n: 2 } });
    await appendTokenUsage(repo, { runtime: 'claude-code', sessionId: 'ses_x', model: 'm', outputTokens: 5 });

    const eventsDir = join(repo, '.maddu', 'events');
    const flat = await numericSegs(eventsDir);
    ok(flat.length >= 1, `DEFAULT: flat segment written (got ${flat.length})`);
    ok(!(await exists(join(eventsDir, 'by-replica'))), 'DEFAULT: NO by-replica dir created');
    const lines = await linesOf(join(eventsDir, flat[0]));
    ok(lines.length === 3, `DEFAULT: all 3 events in flat segment (got ${lines.length})`);
    const tok = JSON.parse(lines[2]);
    ok(tok.type === 'TOKEN_USAGE_REPORTED' && !('prev_hash' in tok),
      'DEFAULT: token event keeps historical no-prev_hash shape (path unchanged)');
    await rm(repo, { recursive: true, force: true });
  }

  // ── SYNC mode ─────────────────────────────────────────────────────────────
  {
    const repo = await mkdtemp(join(tmpdir(), 'maddu-spine-sync-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    const replicaId = 'rep_testreplica01';
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'),
      JSON.stringify({ replicaId }) + '\n');

    await append(repo, { type: TYPE, data: { n: 1 } });
    await append(repo, { type: TYPE, data: { n: 2 } });
    await appendTokenUsage(repo, { runtime: 'claude-code', sessionId: 'ses_y', model: 'm', outputTokens: 7 });
    await append(repo, { type: TYPE, data: { n: 3 } });

    const eventsDir = join(repo, '.maddu', 'events');
    const partDir = join(eventsDir, 'by-replica', replicaId);
    ok(await exists(partDir), 'SYNC: replica partition dir created');
    ok((await numericSegs(eventsDir)).length === 0, 'SYNC: NO flat numeric segment written (all in partition)');

    const partSegs = await numericSegs(partDir);
    ok(partSegs.length === 1, `SYNC: one partition segment (got ${partSegs.length})`);
    const partFile = join(partDir, partSegs[0]);
    const lines = await linesOf(partFile);
    ok(lines.length === 4, `SYNC: all 4 events (incl. token) in partition (got ${lines.length})`);

    const fork = await chainForkAt(partFile);
    ok(fork === -1, `SYNC: partition prev_hash chain unbroken (first fork at ${fork})`);

    const first = JSON.parse(lines[0]);
    ok((first.prev_hash ?? null) === null, 'SYNC: partition genesis has prev_hash null');
    const tok = JSON.parse(lines[2]);
    ok(tok.type === 'TOKEN_USAGE_REPORTED' && typeof tok.prev_hash === 'string',
      'SYNC: token event routed into partition WITH a prev_hash (in the chain)');
    // The lock file must never pollute the segment listing.
    ok(!(await numericSegs(partDir)).includes('.append.lock'), 'SYNC: .append.lock excluded from segments');
    await rm(repo, { recursive: true, force: true });
  }

  // ── Sync-config safety (Codex post-seal fixes) ────────────────────────────
  async function throws(fn) { try { await fn(); return false; } catch { return true; } }
  {
    // Absent replica.json → default mode (null), NOT an error.
    const repo = await mkdtemp(join(tmpdir(), 'maddu-cfg-absent-'));
    ok((await readReplicaId(repo)) === null, 'absent replica.json → null (default mode)');
    await rm(repo, { recursive: true, force: true });
  }
  {
    // Present but malformed → FAIL CLOSED (throw), never silent flat write.
    const repo = await mkdtemp(join(tmpdir(), 'maddu-cfg-bad-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), '{ not json');
    ok(await throws(() => readReplicaId(repo)), 'malformed replica.json → readReplicaId throws (fail-closed)');
    ok(await throws(() => append(repo, { type: TYPE, data: {} })), 'malformed replica.json → append throws (no silent flat write)');
    await rm(repo, { recursive: true, force: true });
  }
  {
    // Path-traversal replicaId → rejected before it becomes a path.
    const repo = await mkdtemp(join(tmpdir(), 'maddu-cfg-trav-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: '../escaped' }));
    ok(await throws(() => readReplicaId(repo)), 'traversal replicaId "../escaped" → rejected');
    ok(!(await exists(join(repo, '.maddu', 'events', 'escaped'))), 'traversal never wrote outside by-replica');
    await rm(repo, { recursive: true, force: true });
  }
  {
    // Whitespace-padded id is NOT silently normalized — validated raw, fails closed.
    for (const bad of [' repA', 'repA ', '\nrepA']) {
      const repo = await mkdtemp(join(tmpdir(), 'maddu-cfg-ws-'));
      await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
      await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: bad }));
      ok(await throws(() => readReplicaId(repo)), `whitespace-padded id ${JSON.stringify(bad)} → rejected (raw validation)`);
      await rm(repo, { recursive: true, force: true });
    }
  }

  console.log(`spine-partition: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
