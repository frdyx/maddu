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
    refusedLine('npm'), completedLine('npm'),                        // in-window tool pair
    evLine('GATE_RAN', { gateId: 'g1', ok: false, status: 'fail', severity: 'critical' }),
    evLine('GATE_RAN', { gateId: 'g1', ok: true, status: 'ok', severity: 'critical' }), // in-window gate arc
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

  const s1 = run(['slice-stop', 'SLICE STOP: t5 preview slice. Action: fixture. Reason: test.']);
  ok(s1.status === 0, `slice-stop exits 0 (got ${s1.status}: ${(s1.stderr || '').slice(0, 200)})`);
  ok(/learn: 1 candidate\(s\)/.test(s1.stdout) && /spine-tool-recovery/.test(s1.stdout),
    `slice-stop PREVIEWS the seeded candidate (stdout: ${s1.stdout.split('\n').filter((l) => l.includes('learn')).join(' | ')})`);
  ok(/maddu learn digest --spine/.test(s1.stdout) && /maddu learn run --spine/.test(s1.stdout),
    'preview points at the EXISTING learn verbs (accept one-liners)');
  ok(/nothing is written/.test(s1.stdout), 'preview states the no-auto-writing contract');

  // ── 3: isolation — throwing detector, ritual still green ─────────────────
  const s2 = run(['slice-stop', 'SLICE STOP: t5 isolation slice. Action: fixture. Reason: test.'], { MADDU_TEST_LEARN_DETECTOR: 'throw' });
  ok(s2.status === 0 && /slice-stop\s+evt_/.test(s2.stdout), `throwing detector still slice-stops GREEN (got ${s2.status})`);
  ok(!/learn:/.test(s2.stdout), 'no learn output when the detector throws (silently isolated)');

  // ── 4 (E2E): slow detector — stop completes within budget ─────────────────
  const tSlow = Date.now();
  const s3 = run(['slice-stop', 'SLICE STOP: t5 deadline slice. Action: fixture. Reason: test.'], { MADDU_TEST_LEARN_DETECTOR: 'slow' });
  const slowElapsed = Date.now() - tSlow;
  ok(s3.status === 0 && /passed its 1500ms budget/.test(s3.stdout),
    `slow detector: stop green + budget note printed (got ${s3.status}; ${s3.stdout.split('\n').filter((l) => l.includes('learn')).join(' ')})`);
  ok(slowElapsed < 20_000, `slow detector never stalls the ritual (elapsed ${slowElapsed}ms)`);

  // Session close: same isolation contract at the other boundary.
  const c1 = run(['session', 'close'], { MADDU_TEST_LEARN_DETECTOR: 'throw' });
  ok(c1.status === 0, `session close with a throwing detector exits 0 (got ${c1.status}: ${(c1.stderr || '').slice(0, 200)})`);

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
