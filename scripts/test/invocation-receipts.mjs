// Tier-2 execution-telemetry self-test (usage-audit roadmap, 2026-07-16).
// Run standalone:  node scripts/test/invocation-receipts.mjs
//
// Proves the Tier-2 receipt-corpus acceptance criteria:
//   1. WRITER — recordInvocationSync appends a parseable receipt with every
//      contracted field (ts, verb, sub, exit, ms, sessionId, workspace);
//      fail-open (bad state root → false, never a throw); secret-shaped
//      input is scrubbed at the write boundary; p50 latency < 10ms (the
//      roadmap kill criterion).
//   2. STATE-ROOT RESOLUTION — sync mirror of paths.resolveRoots: walk-up,
//      MADDU_STATE_ROOT env, .maddu-state-root pointer; a misconfigured
//      pointer resolves to null (telemetry never guesses OR throws).
//   3. HONESTY — unparseable lines are COUNTED as dropped; the window spans
//      oldest→newest across the rotated generation; readReceiptStats carries
//      window + dropped + rotation cap alongside every count.
//   4. ROTATION — size cap rotates current → prev, one generation kept,
//      reads span both.
//   5. E2E through bin/maddu.mjs — a real CLI entry writes a receipt from
//      its exit handler (including the normalized-verb rules: version,
//      unknown-command-never-persists-raw-text, token-shaped sub only).

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIB = join(REPO, 'template', 'maddu', 'runtime', 'lib');
const toUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`);

const ir = await import(toUrl(join(LIB, 'invocation-receipts.mjs')));
const insights = await import(toUrl(join(LIB, 'insights.mjs')));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

const tmp = await mkdtemp(join(tmpdir(), 'maddu-t2-'));
try {
  // ── 2. State-root resolution (sync, fail-open) ────────────────────────────
  const rA = join(tmp, 'repoA');
  await mkdir(join(rA, '.maddu', 'state'), { recursive: true });
  await mkdir(join(rA, 'sub', 'deep'), { recursive: true });
  ok(ir.resolveStateRootSync(join(rA, 'sub', 'deep'), {}) === rA, 'walk-up finds the nearest .maddu ancestor');
  ok(ir.resolveStateRootSync(tmp, {}) === null, 'no .maddu anywhere up the tree → null');
  ok(ir.resolveStateRootSync(join(rA, 'sub'), { MADDU_STATE_ROOT: rA }) === rA, 'MADDU_STATE_ROOT env honored');
  ok(ir.resolveStateRootSync(join(rA, 'sub'), { MADDU_STATE_ROOT: join(tmp, 'nowhere') }) === null,
    'env pointing at a dir without .maddu → null, not a throw (fail-open vs resolveRoots)');
  const rPtr = join(tmp, 'worktree');
  await mkdir(rPtr, { recursive: true });
  await writeFile(join(rPtr, '.maddu-state-root'), rA + '\n');
  ok(ir.resolveStateRootSync(rPtr, {}) === rA, '.maddu-state-root pointer file redirects to the primary');
  await writeFile(join(rPtr, '.maddu-state-root'), join(tmp, 'nowhere') + '\n');
  ok(ir.resolveStateRootSync(rPtr, {}) === null, 'misconfigured pointer → null, never a guess or a throw');

  // ── 1. Writer ──────────────────────────────────────────────────────────────
  ok(ir.recordInvocationSync({ stateRoot: rA, verb: 'lane', sub: 'claim', exitCode: 0, durationMs: 42.7, env: {} }) === true, 'write returns true');
  ok(ir.recordInvocationSync({ stateRoot: null, verb: 'lane', env: {} }) === false, 'null stateRoot → false, no throw');
  ok(ir.recordInvocationSync({ stateRoot: rA, verb: null, env: {} }) === false, 'missing verb → false, no throw');
  // A file where the state DIR should be → mkdir/append fails → fail-open.
  const rBlocked = join(tmp, 'blocked');
  await mkdir(join(rBlocked, '.maddu'), { recursive: true });
  await writeFile(join(rBlocked, '.maddu', 'state'), 'not a directory');
  ok(ir.recordInvocationSync({ stateRoot: rBlocked, verb: 'status', env: {} }) === false, 'unwritable corpus → false, no throw');

  let { receipts, dropped } = await ir.readReceipts(rA);
  ok(receipts.length === 1 && dropped === 0, `single receipt reads back (got ${receipts.length}/${dropped})`);
  const r0 = receipts[0];
  ok(r0.verb === 'lane' && r0.sub === 'claim' && r0.exit === 0 && r0.ms === 43 && r0.workspace === rA && typeof r0.ts === 'string',
    `receipt fields contracted (got ${JSON.stringify(r0)})`);
  ok(r0.sessionId === null, 'no env/cache session → sessionId null');

  // sessionId precedence: env, then the raw active-session cache.
  ir.recordInvocationSync({ stateRoot: rA, verb: 'status', env: { MADDU_SESSION_ID: 'ses_env' } });
  await writeFile(join(rA, '.maddu', 'state', 'session.active.json'), JSON.stringify({ _v: 1, sessionId: 'ses_cache' }));
  ir.recordInvocationSync({ stateRoot: rA, verb: 'status', env: {} });
  ({ receipts } = await ir.readReceipts(rA));
  ok(receipts.at(-2).sessionId === 'ses_env' && receipts.at(-1).sessionId === 'ses_cache',
    'sessionId precedence: env > raw active-session cache');

  // Write-boundary scrub: a secret-shaped sub never lands raw.
  ir.recordInvocationSync({ stateRoot: rA, verb: 'lane', sub: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn', env: {} });
  const rawText = await readFile(join(rA, '.maddu', 'state', ir.RECEIPTS_FILE), 'utf8');
  ok(!rawText.includes('sk-ant-api03'), 'secret-shaped sub is redacted at the write boundary');

  // Kill criterion: p50 write latency < 10ms.
  const times = [];
  for (let i = 0; i < 50; i++) {
    const t0 = process.hrtime.bigint();
    ir.recordInvocationSync({ stateRoot: rA, verb: 'status', env: {} });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const p50 = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  ok(p50 < 10, `receipt write p50 < 10ms (got ${p50.toFixed(2)}ms)`);

  // ── 3+4. Honesty + rotation ────────────────────────────────────────────────
  const rB = join(tmp, 'repoB');
  await mkdir(join(rB, '.maddu', 'state'), { recursive: true });
  ir.recordInvocationSync({ stateRoot: rB, verb: 'doctor', exitCode: 1, env: {}, now: '2026-07-01T00:00:00.000Z' });
  // Tiny rotate cap: the next write sees size ≥ cap → rotates first.
  ir.recordInvocationSync({ stateRoot: rB, verb: 'status', env: {}, rotateBytes: 10, now: '2026-07-10T00:00:00.000Z' });
  const stats1 = await ir.readReceiptStats(rB);
  ok(stats1.files.length === 2 && stats1.count === 2, `rotation keeps one prev generation, reads span both (got ${stats1.files.length} files, ${stats1.count})`);
  ok(stats1.window?.oldest === '2026-07-01T00:00:00.000Z' && stats1.window?.newest === '2026-07-10T00:00:00.000Z',
    `window spans rotated + current (got ${JSON.stringify(stats1.window)})`);
  ok(stats1.failures === 1 && stats1.verbs.find((v) => v.verb === 'doctor')?.fail === 1, 'non-zero exits tallied per verb and in total');
  ok(stats1.rotateBytes === ir.ROTATE_BYTES, 'stats declare the rotation cap');
  // Unparseable AND off-shape lines are counted, never silently skipped —
  // a record missing `exit` must not contaminate the failure tally
  // (undefined !== 0; Codex round 1), and the reader enforces the FULL
  // writer shape (a truthy non-string `sub` would corrupt the verb rollup
  // key; Codex round 2).
  const { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } = await import('node:fs');
  const fullReceipt = (over = {}) => JSON.stringify({
    v: 1, ts: '2026-07-11T00:00:00.000Z', verb: 'status', sub: null, exit: 0, ms: 1, sessionId: null, workspace: rB, ...over,
  }) + '\n';
  appendFileSync(join(rB, '.maddu', 'state', ir.RECEIPTS_FILE),
    'not json at all\n{"v":1}\n'
    + JSON.stringify({ v: 1, ts: '2026-07-11T00:00:00.000Z', verb: 'status' }) + '\n'
    + fullReceipt({ sub: 42 })
    + fullReceipt({ workspace: undefined })
    + fullReceipt({ v: 2 }));
  const stats2 = await ir.readReceiptStats(rB);
  ok(stats2.dropped === 6 && stats2.count === 2, `garbage/partial/bad-sub/no-workspace/wrong-v lines all dropped (got dropped=${stats2.dropped}, count=${stats2.count})`);
  ok(stats2.failures === 1, `off-shape records never count as failures (got ${stats2.failures})`);
  ok(!stats2.verbs.some((v) => v.verb.includes('42')), 'non-string sub cannot corrupt the verb rollup');

  // Rotation hard ceiling: when rotation keeps failing (prev is an unremovable
  // non-empty DIRECTORY), the append is DROPPED instead of growing the file
  // (Codex round 1); the ceiling includes the candidate line's own bytes so
  // the 2×-cap bound is EXACT, never "2× plus one receipt" (round 2).
  const rHard = join(tmp, 'repoHard');
  await mkdir(join(rHard, '.maddu', 'state'), { recursive: true });
  mkdirSync(join(rHard, '.maddu', 'state', ir.RECEIPTS_PREV_FILE));
  writeFileSync(join(rHard, '.maddu', 'state', ir.RECEIPTS_PREV_FILE, 'block.txt'), 'x');
  writeFileSync(join(rHard, '.maddu', 'state', ir.RECEIPTS_FILE), 'x'.repeat(200));
  ok(ir.recordInvocationSync({ stateRoot: rHard, verb: 'status', env: {}, rotateBytes: 100 }) === false,
    'rotation-blocked file at 2× cap drops the receipt (returns false)');
  ok(statSync(join(rHard, '.maddu', 'state', ir.RECEIPTS_FILE)).size === 200, 'blocked corpus did not grow past the hard ceiling');
  // Exact-bound edge: file just UNDER 2× cap, but the candidate line would
  // cross it → still dropped, size unchanged.
  writeFileSync(join(rHard, '.maddu', 'state', ir.RECEIPTS_FILE), 'x'.repeat(195));
  ok(ir.recordInvocationSync({ stateRoot: rHard, verb: 'status', env: {}, rotateBytes: 100 }) === false,
    'line that would cross the 2× bound is dropped even below the pre-append ceiling');
  ok(statSync(join(rHard, '.maddu', 'state', ir.RECEIPTS_FILE)).size === 195, 'exact bound: corpus never exceeds 2× the cap');

  // Concurrent-rotation guard, exercised FOR REAL via the guarded test-only
  // hook (production passes nothing): the rotation branch is entered (size ≥
  // cap), then the current file vanishes mid-rotation — as if another process
  // rotated it first — and the fallback must NOT delete the prev generation
  // that other process just created (Codex rounds 1+2).
  const rRace = join(tmp, 'repoRace');
  await mkdir(join(rRace, '.maddu', 'state'), { recursive: true });
  const prevLine = JSON.stringify({ v: 1, ts: '2026-07-01T00:00:00.000Z', verb: 'doctor', sub: null, exit: 0, ms: 1, sessionId: null, workspace: rRace }) + '\n';
  writeFileSync(join(rRace, '.maddu', 'state', ir.RECEIPTS_PREV_FILE), prevLine);
  writeFileSync(join(rRace, '.maddu', 'state', ir.RECEIPTS_FILE), 'y'.repeat(150));
  ok(ir.recordInvocationSync({
    stateRoot: rRace, verb: 'status', env: {}, rotateBytes: 100,
    _testBeforeRename: () => rmSync(join(rRace, '.maddu', 'state', ir.RECEIPTS_FILE)),
  }) === true, 'race: rotation branch entered, current vanished mid-rotation, write still proceeds');
  const race = await ir.readReceipts(rRace);
  ok(race.receipts.some((r) => r.verb === 'doctor'), 'race: prev generation SURVIVES a failed rename whose source is gone');
  ok(race.receipts.some((r) => r.verb === 'status'), 'race: the new receipt landed in a fresh current file');

  // Normal rotation replaces prev (rename-first on POSIX; rm+retry fallback
  // on Windows — same observable outcome on both).
  const rRot = join(tmp, 'repoRot');
  await mkdir(join(rRot, '.maddu', 'state'), { recursive: true });
  writeFileSync(join(rRot, '.maddu', 'state', ir.RECEIPTS_PREV_FILE), prevLine);
  writeFileSync(join(rRot, '.maddu', 'state', ir.RECEIPTS_FILE), fullReceipt({ verb: 'old-current' }).repeat(3));
  ok(ir.recordInvocationSync({ stateRoot: rRot, verb: 'status', env: {}, rotateBytes: 100 }) === true, 'rotation with existing prev file succeeds');
  const rot = await ir.readReceipts(rRot);
  ok(!rot.receipts.some((r) => r.verb === 'doctor') && rot.receipts.filter((r) => r.verb === 'old-current').length === 3 && rot.receipts.some((r) => r.verb === 'status'),
    'rotation replaced prev with the old current; new receipt starts the fresh current');

  // insights.harvestReceipts: per-workspace rollup with role + honesty fields.
  const harvested = await insights.harvestReceipts([
    { id: 'b', label: 'repoB', path: rB, role: 'project' },
    { id: 'none', label: 'no-corpus', path: join(tmp, 'repoC-nothere') },
  ]);
  ok(harvested.length === 2 && harvested[0].name === 'repoB' && harvested[0].count === 2 && harvested[0].dropped === 6,
    'harvestReceipts rolls up counts + dropped per workspace');
  ok(harvested[1].count === 0 && harvested[1].window === null, 'workspace without a corpus reports 0 receipts, window null — honest no-telemetry');

  // ── 5. E2E through the real CLI entry ─────────────────────────────────────
  const rE = join(tmp, 'e2e');
  await mkdir(join(rE, '.maddu', 'state'), { recursive: true });
  const bin = join(REPO, 'bin', 'maddu.mjs');
  const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: rE, encoding: 'utf8', timeout: 60000 });
  const v = run(['--version']);
  ok(v.status === 0, `maddu --version exits 0 (got ${v.status}: ${v.stderr})`);
  const u = run(['definitely-not-a-verb', 'sk-ant-secret-looking-arg']);
  ok(u.status === 2, `unknown command exits 2 (got ${u.status})`);
  const s = run(['session', 'list']);
  const e2e = await ir.readReceipts(rE);
  ok(e2e.receipts.length === 3, `three CLI entries → three receipts (got ${e2e.receipts.length})`);
  const [rv, ru, rs] = e2e.receipts;
  ok(rv.verb === 'version' && rv.exit === 0 && rv.ms >= 0, `--version receipt normalized (got ${JSON.stringify(rv)})`);
  ok(ru.verb === '(unknown)' && ru.exit === 2, `unknown command records '(unknown)' with exit 2 (got ${JSON.stringify(ru)})`);
  ok(!JSON.stringify(e2e.receipts).includes('definitely-not-a-verb') && !JSON.stringify(e2e.receipts).includes('sk-ant-secret'),
    'raw unknown-command text and its args never persist');
  ok(rs.verb === 'session' && rs.sub === 'list' && typeof rs.exit === 'number', `verb+sub captured for a real command (got ${JSON.stringify(rs)}, status ${s.status})`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`invocation-receipts: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
