// Tier-5 learn-trial acceptance suite (usage-audit roadmap, 2026-07-16).
// Run standalone:  node scripts/test/learn-slice-trigger.mjs
//
// Proves the roadmap's §Tier 5 acceptance criteria:
//   1. A seeded failed→succeeded pair inside the session window PREVIEWS a
//      candidate at slice-stop (window bounded by the session's previous
//      SLICE_STOP — pre-boundary pairs never leak in).
//   2. The ACCEPT path (existing `learn run --spine` verbs, fake judge)
//      writes the correction + the LEARN_CORRECTION_WRITTEN event.
//   3. ISOLATION: a deliberately-throwing detector still slice-stops (and
//      session-closes) GREEN — proven through the REAL CLI call sites via
//      the guarded MADDU_TEST_LEARN_DETECTOR hook.
//   4. DEADLINE RACE: a slow detector never stalls the ritual — the stop
//      completes and prints within budget, the straggler is abandoned.
//   5. Caps: >MAX_LINES truncates (flagged), oversize lines are skipped
//      UNPARSED and counted.

import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIB = join(REPO, 'template', 'maddu', 'runtime', 'lib');
const BIN = join(REPO, 'bin', 'maddu.mjs');
const toUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`);

const lt = await import(toUrl(join(LIB, 'learn-slice-trigger.mjs')));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

let seq = 0;
function evLine(type, data = {}, { actor = null, id = null } = {}) {
  seq++;
  return JSON.stringify({
    v: 1, id: id || `evt_20260716090000_${String(seq).padStart(6, '0')}`,
    ts: '2026-07-16T09:00:00.000Z', type, actor, lane: null, data,
  }) + '\n';
}
const refusedLine = (tool) => evLine('TOOL_REFUSED', { tool, argv: [tool, '--bad'], reason: 'refused' });
const completedLine = (tool) => evLine('TOOL_COMPLETED', { tool, argv: [tool, '--good'] });

const tmp = await mkdtemp(join(tmpdir(), 'maddu-t5-'));
try {
  // ── 1 + caps: unit-level window semantics ──────────────────────────────────
  const rUnit = join(tmp, 'unit');
  await mkdir(join(rUnit, '.maddu', 'events'), { recursive: true });
  await writeFile(join(rUnit, '.maddu', 'events', '000000000001.ndjson'), [
    refusedLine('git'), completedLine('git'),                       // BEFORE the boundary — must not leak in
    evLine('SLICE_STOP', { summary: 'prior stop' }, { actor: 'ses_t', id: 'evt_20260716090000_prior0' }),
    refusedLine('npm'), completedLine('npm'),                        // in-window tool pair (null-actor census)
    // Gate events carry session attribution (as slice-stop-run gates do) —
    // null-actor GATE_RAN is deliberately outside the window residual.
    evLine('GATE_RAN', { gateId: 'g1', ok: false, status: 'fail', severity: 'critical' }, { actor: 'ses_t' }),
    evLine('GATE_RAN', { gateId: 'g1', ok: true, status: 'ok', severity: 'critical' }, { actor: 'ses_t' }), // in-window gate arc
  ].join(''));
  const det = await lt.detectCandidates(rUnit, { sessionId: 'ses_t' });
  ok(det.candidates.length === 2, `seeded window yields exactly the in-window candidates (got ${det.candidates.length}: ${det.candidates.map((c) => c.category).join(',')})`);
  ok(det.candidates.some((c) => c.category === 'spine-tool-recovery' && c.tool === 'npm'), 'the in-window failed→succeeded tool pair is detected');
  ok(!det.candidates.some((c) => c.tool === 'git'), 'a pair before the session\'s previous slice-stop never leaks into the window');
  ok(det.candidates.some((c) => c.category === 'spine-gate-recovery'), 'the in-window gate fail→ok arc is detected');
  ok(det.timedOut === false && det.truncated === false && det.skippedOversize === 0, 'clean window carries clean honesty flags');

  // Caps: an oversize line is skipped unparsed + counted; >MAX_LINES truncates.
  await appendFile(join(rUnit, '.maddu', 'events', '000000000001.ndjson'),
    JSON.stringify({ v: 1, id: 'evt_20260716090001_big001', ts: '2026-07-16T09:00:01.000Z', type: 'INBOX_MESSAGE', actor: null, lane: null, data: { text: 'x'.repeat(lt.MAX_LINE_BYTES + 100) } }) + '\n');
  const detBig = await lt.detectCandidates(rUnit, { sessionId: 'ses_t' });
  ok(detBig.skippedOversize === 1 && detBig.candidates.length === 2, `oversize line skipped unparsed + counted (got ${detBig.skippedOversize})`);
  const rMany = join(tmp, 'many');
  await mkdir(join(rMany, '.maddu', 'events'), { recursive: true });
  const many = [];
  for (let i = 0; i < lt.MAX_LINES + 100; i++) many.push(evLine('SESSION_HEARTBEAT', { n: i }));
  await writeFile(join(rMany, '.maddu', 'events', '000000000001.ndjson'), many.join(''));
  const detMany = await lt.detectCandidates(rMany, { sessionId: 'ses_t' });
  ok(detMany.truncated === true && detMany.linesScanned <= lt.MAX_LINES, `window truncates at ${lt.MAX_LINES} lines (scanned ${detMany.linesScanned})`);
  // Oversize lines COUNT toward the caps (Codex round 1: exempting them
  // would let a pathological all-oversize spine be scanned unboundedly).
  const rAllBig = join(tmp, 'all-big');
  await mkdir(join(rAllBig, '.maddu', 'events'), { recursive: true });
  const bigLine = JSON.stringify({ v: 1, id: 'evt_20260716090002_big', ts: 'x', type: 'INBOX_MESSAGE', actor: null, lane: null, data: { text: 'y'.repeat(lt.MAX_LINE_BYTES + 10) } });
  await writeFile(join(rAllBig, '.maddu', 'events', '000000000001.ndjson'), Array(10).fill(bigLine).join('\n') + '\n');
  const detAllBig = await lt.detectCandidates(rAllBig, { sessionId: 'ses_t' });
  ok(detAllBig.truncated === true && detAllBig.skippedOversize <= 4,
    `oversize lines consume the byte cap — an all-oversize spine is bounded (skipped ${detAllBig.skippedOversize}, truncated ${detAllBig.truncated})`);
  // Oversize BOUNDARY probe: an oversize prior stop still cuts the window
  // (raw substring probe; a false positive only narrows — safe direction).
  const rBigStop = join(tmp, 'big-stop');
  await mkdir(join(rBigStop, '.maddu', 'events'), { recursive: true });
  await writeFile(join(rBigStop, '.maddu', 'events', '000000000001.ndjson'), [
    refusedLine('cargo'), completedLine('cargo'), // BEFORE the oversize boundary — must not leak
    JSON.stringify({ v: 1, id: 'evt_20260716090003_bigstp', ts: 'x', type: 'SLICE_STOP', actor: 'ses_t', lane: null, data: { summary: 'huge ' + 'z'.repeat(lt.MAX_LINE_BYTES) } }) + '\n',
    refusedLine('go'), completedLine('go'), // after — detected
  ].join(''));
  const detBigStop = await lt.detectCandidates(rBigStop, { sessionId: 'ses_t' });
  ok(detBigStop.candidates.length === 1 && detBigStop.candidates[0].tool === 'go',
    `oversize prior stop still bounds the window (got ${detBigStop.candidates.map((c) => c.tool).join(',')})`);
  // Partition ordering: events in a by-replica partition NEWER than the flat
  // boundary are detected — order restored by event-id sort, not path sort.
  const rPart = join(tmp, 'partitioned');
  await mkdir(join(rPart, '.maddu', 'events', 'by-replica', 'r1'), { recursive: true });
  await writeFile(join(rPart, '.maddu', 'events', '000000000001.ndjson'),
    evLine('SLICE_STOP', { summary: 'prior' }, { actor: 'ses_t', id: 'evt_20260716090100_prior1' }));
  await writeFile(join(rPart, '.maddu', 'events', 'by-replica', 'r1', '000000000001.ndjson'),
    JSON.stringify({ v: 1, id: 'evt_20260716090200_pref01', ts: 'x', type: 'TOOL_REFUSED', actor: null, lane: null, data: { tool: 'mvn', argv: ['mvn'], reason: 'r' } }) + '\n'
    + JSON.stringify({ v: 1, id: 'evt_20260716090201_pcomp1', ts: 'x', type: 'TOOL_COMPLETED', actor: null, lane: null, data: { tool: 'mvn', argv: ['mvn'] } }) + '\n');
  const detPart = await lt.detectCandidates(rPart, { sessionId: 'ses_t' });
  ok(detPart.candidates.length === 1 && detPart.candidates[0].tool === 'mvn',
    `partition events order by event id, not shard path (got ${detPart.candidates.map((c) => c.tool).join(',') || 'none'})`);
  // Cross-session honesty: attributed events from ANOTHER session never leak
  // into this session's preview; null-actor census events stay (documented).
  const rXs = join(tmp, 'cross-session');
  await mkdir(join(rXs, '.maddu', 'events'), { recursive: true });
  await writeFile(join(rXs, '.maddu', 'events', '000000000001.ndjson'), [
    evLine('SLICE_STOP', { summary: 'prior' }, { actor: 'ses_t', id: 'evt_20260716090000_prior2' }),
    evLine('GATE_RAN', { gateId: 'gx', ok: false, status: 'fail', severity: 'critical' }, { actor: 'ses_OTHER' }),
    evLine('GATE_RAN', { gateId: 'gx', ok: true, status: 'ok', severity: 'critical' }, { actor: 'ses_OTHER' }),
    refusedLine('pip'), completedLine('pip'), // null-actor census pair — stays
  ].join(''));
  const detXs = await lt.detectCandidates(rXs, { sessionId: 'ses_t' });
  ok(detXs.candidates.length === 1 && detXs.candidates[0].tool === 'pip',
    `another session's attributed events are excluded; null-actor census stays (got ${detXs.candidates.map((c) => c.category).join(',')})`);

  // ── 4 (unit): cooperative deadline + caller race ───────────────────────────
  let calls = 0;
  const fakeNow = () => (calls++ === 0 ? 0 : 10_000); // second check is past any deadline
  const detTimeout = await lt.detectCandidates(rUnit, { sessionId: 'ses_t', now: fakeNow, deadlineMs: 1500 });
  ok(detTimeout.timedOut === true && detTimeout.candidates.length === 0, 'cooperative deadline between parse steps yields timedOut, no half-baked candidates');
  const t0 = Date.now();
  const raced = await lt.runDetectionPreview(rUnit, { sessionId: 'ses_t', deadlineMs: 100, _testDelayMs: 1500 });
  const elapsed = Date.now() - t0;
  ok(raced.timedOut === true && elapsed < 1200, `caller race returns within budget while the straggler is abandoned (elapsed ${elapsed}ms)`);

  // ── E2E through the real CLI ───────────────────────────────────────────────
  const fixture = join(tmp, 'e2e');
  await mkdir(join(fixture, '.maddu', 'events'), { recursive: true });
  await mkdir(join(fixture, '.maddu', 'state'), { recursive: true });
  await mkdir(join(fixture, '.maddu', 'runtimes'), { recursive: true });
  await mkdir(join(fixture, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(fixture, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [{ id: 'general', scope: 'x' }] }) + '\n');
  await writeFile(join(fixture, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  await writeFile(join(fixture, 'CLAUDE.md'), '# Project\n\nKeep this.\n');
  const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
    cwd: fixture, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env },
  });

  ok(run(['register']).status === 0, 'register exits 0 in the e2e fixture');
  // Seed a failed→succeeded pair INSIDE this session's window (hand-appended,
  // like every spine fixture in this suite family).
  await appendFile(join(fixture, '.maddu', 'events', '000000000001.ndjson'), refusedLine('pytest') + completedLine('pytest'));

  const tBase = Date.now();
  const s1 = run(['slice-stop', 'SLICE STOP: t5 preview slice. Action: fixture. Reason: test.']);
  const baseElapsed = Date.now() - tBase; // spawn + normal-stop baseline for the relative deadline bound
  ok(s1.status === 0, `slice-stop exits 0 (got ${s1.status}: ${(s1.stderr || '').slice(0, 200)})`);
  ok(/learn: 1 candidate\(s\)/.test(s1.stdout) && /spine-tool-recovery/.test(s1.stdout),
    `slice-stop PREVIEWS the seeded candidate (stdout: ${s1.stdout.split('\n').filter((l) => l.includes('learn')).join(' | ')})`);
  ok(/maddu learn digest --spine/.test(s1.stdout) && /maddu learn run --spine/.test(s1.stdout),
    'preview points at the EXISTING learn verbs (accept one-liners)');
  ok(/nothing is written/.test(s1.stdout), 'preview states the no-auto-writing contract');

  // ── 3: isolation — throwing detector, ritual still green ─────────────────
  // Hooks require MADDU_SELF_TEST=1 (production-gated); first prove the gate:
  // without it, the hook env var is inert and the preview still runs. Seed a
  // FRESH pair with current-clock ids so it lands inside the new window
  // (post-s1 boundary — the sort is wall-clock keyed).
  const nowClock = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const freshLine = (type, data, n) => JSON.stringify({ v: 1, id: `evt_${nowClock}_zfrsh${n}`, ts: new Date().toISOString(), type, actor: null, lane: null, data }) + '\n';
  await appendFile(join(fixture, '.maddu', 'events', '000000000001.ndjson'),
    freshLine('TOOL_REFUSED', { tool: 'tsc', argv: ['tsc', '--bad'], reason: 'refused' }, 1)
    + freshLine('TOOL_COMPLETED', { tool: 'tsc', argv: ['tsc', '--good'] }, 2));
  const sGate = run(['slice-stop', 'SLICE STOP: t5 gate slice. Action: fixture. Reason: test.'], { MADDU_TEST_LEARN_DETECTOR: 'throw' });
  ok(sGate.status === 0 && /learn:/.test(sGate.stdout),
    `without MADDU_SELF_TEST=1 the test hook is INERT — preview still runs (learn lines: ${sGate.stdout.split('\n').filter((l) => l.includes('learn')).join(' | ') || 'none'})`);
  const s2 = run(['slice-stop', 'SLICE STOP: t5 isolation slice. Action: fixture. Reason: test.'], { MADDU_SELF_TEST: '1', MADDU_TEST_LEARN_DETECTOR: 'throw' });
  ok(s2.status === 0 && /slice-stop\s+evt_/.test(s2.stdout), `throwing detector still slice-stops GREEN (got ${s2.status})`);
  ok(!/learn:/.test(s2.stdout), 'no learn output when the detector throws (silently isolated)');

  // ── 4 (E2E): slow detector — stop completes within budget, straggler's
  // unref'd timers never hold the process open (bound is spawn overhead +
  // the ~1.6s race, NOT the 5s straggler).
  const tSlow = Date.now();
  const s3 = run(['slice-stop', 'SLICE STOP: t5 deadline slice. Action: fixture. Reason: test.'], { MADDU_SELF_TEST: '1', MADDU_TEST_LEARN_DETECTOR: 'slow' });
  const slowElapsed = Date.now() - tSlow;
  ok(s3.status === 0 && /passed its 1500ms budget/.test(s3.stdout),
    `slow detector: stop green + budget note printed (got ${s3.status}; ${s3.stdout.split('\n').filter((l) => l.includes('learn')).join(' ')})`);
  // RELATIVE bound (Codex round 2: a flat <12s would hide the old 5s
  // straggler stall): the slow run may cost only the ~1.6s race + slack
  // over a normal stop — never the straggler's 5s delay chain.
  ok(slowElapsed < baseElapsed + 3500,
    `slow run = baseline + race only, straggler never holds exit (slow ${slowElapsed}ms vs base ${baseElapsed}ms)`);

  // Session close: same isolation contract at the other boundary, proven
  // OBSERVABLY (Codex round 2): with a fresh candidate seeded, a clean
  // close prints the learn line; a close with a throwing detector prints
  // none — both exit 0. Exit code alone can't distinguish; the line does.
  await appendFile(join(fixture, '.maddu', 'events', '000000000001.ndjson'),
    freshLine('TOOL_REFUSED', { tool: 'gradle', argv: ['gradle', '--bad'], reason: 'refused' }, 3)
    + freshLine('TOOL_COMPLETED', { tool: 'gradle', argv: ['gradle', '--good'] }, 4));
  const c1 = run(['session', 'close'], { MADDU_SELF_TEST: '1', MADDU_TEST_LEARN_DETECTOR: 'throw' });
  ok(c1.status === 0 && !/learn:/.test(c1.stdout),
    `close with a throwing detector: exit 0, learn line ABSENT (got ${c1.status}; stdout: ${c1.stdout.trim().slice(0, 120)})`);
  ok(run(['register']).status === 0, 're-register for the clean-close baseline');
  const c2 = run(['session', 'close']);
  ok(c2.status === 0 && /learn: \d+ candidate/.test(c2.stdout),
    `clean close prints the learn line — proving the throw path was really exercised above (got: ${c2.stdout.trim().slice(0, 160)})`);
  ok(run(['register']).status === 0, 're-register for the accept-path steps');

  // ── 2: accept path — fake judge writes correction + LEARN event ───────────
  const fakeJudge = join(fixture, 'fake-judge.mjs');
  await writeFile(fakeJudge, [
    'const prompt = process.argv[2] || "";',
    'const m = prompt.match(/<CANDIDATES>\\s*([\\s\\S]*?)\\s*<\\/CANDIDATES>/);',
    'let cands = []; try { cands = JSON.parse(m[1]); } catch {}',
    'const out = cands.map((c) => ({ id: c.id, verdict: "accept", destination: "memory",',
    '  category: c.category, text: "prefer `" + c.success + "` over `" + c.failure + "`" }));',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n'));
  await writeFile(join(fixture, '.maddu', 'runtimes', 'fakejudge.json'),
    JSON.stringify({ name: 'fakejudge', binary: process.execPath, learnArgs: [fakeJudge, '${prompt}'], authProvider: 'fakejudge' }) + '\n');
  const emptyTranscripts = join(tmp, 'no-transcripts');
  await mkdir(emptyTranscripts, { recursive: true });
  const lr = run(['learn', 'run', '--runtime', 'fakejudge', '--no-auth-check', '--spine', '--root', emptyTranscripts]);
  ok(lr.status === 0, `learn run --spine (fake judge) exits 0 (got ${lr.status}: ${(lr.stderr || '').slice(0, 300)})`);
  const spineText = await readFile(join(fixture, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
  ok(/LEARN_CORRECTION_WRITTEN/.test(spineText), 'accept path lands LEARN_CORRECTION_WRITTEN on the spine');
  let memText = '';
  try { memText = await readFile(join(fixture, '.maddu', 'memory.ndjson'), 'utf8'); } catch {}
  ok(/prefer/.test(memText), `accepted correction written to memory (got ${memText.slice(0, 120) || '(empty)'})`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`learn-slice-trigger: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
