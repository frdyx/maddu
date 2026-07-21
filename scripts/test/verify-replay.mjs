#!/usr/bin/env node
// verify-replay — witness track PR 5 kill criterion, driven through the REAL
// CLI on scratch git repos:
//
//   1. pure/unit: runDeclared settlement (bad cwd spawn error never rejects),
//      timeout env seam
//   2. pass / verify-fail / install-fail (verify never runs) semantics +
//      receipt shape (kind 'replay', profile 'replayed', strict STARTED→RAN)
//   3. TIMEOUT tree kill: a grandchild-spawning verify is killed whole
//      (both processes dead), receipt timed_out + complete:false, clone gone
//   4. declared-only discipline: undeclared → unsupported (no events);
//      malformed shapes → config-invalid; config is read AT THE SHA (a
//      pre-declaration commit is unsupported even when the worktree declares;
//      a post-removal HEAD still replays a declaring SHA)
//   5. exact-SHA discipline: short/uppercase/ref refused; nonexistent full
//      sha refused; annotated-TAG object id refused (peel defense)
//   6. dirty-worktree contamination: an uncommitted edit to the verify
//      script does not reach the clone — replay reflects the committed state
//   7. --json: stdout is exactly one JSON document; child output → stderr
//   8. cleanup: no maddu-replay-* temp dirs survive any scenario
//   9. refusals emit NO spine events; spine-unavailable refuses pre-run
//  10. recency isolation: replay receipts never pair as project-test
//  11. flag validation table
//
// What this does NOT prove (documented): host-env isolation (explicitly out
// of scope — replay is clean-checkout reproducibility only).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(SRC_ROOT, 'bin', 'maddu.mjs');
const LIB = join(SRC_ROOT, 'template', 'maddu', 'runtime', 'lib', 'verify-replay.mjs');
const RECENCY_LIB = join(SRC_ROOT, 'template', 'maddu', 'runtime', 'lib', 'verification-recency.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, MADDU_SESSION_ID: '', ...env },
  });
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

async function makeRepo(base, name, { madduJson } = {}) {
  const repo = join(base, name);
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  const seed = { v: 1, id: 'evt_seed', ts: '2026-07-21T00:00:00.000Z', type: 'SESSION_REGISTERED', actor: null, lane: null, data: {} };
  await writeFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), JSON.stringify(seed) + '\n');
  await writeFile(join(repo, '.gitignore'), '.maddu/*\n');
  if (madduJson !== undefined) await writeFile(join(repo, 'maddu.json'), JSON.stringify(madduJson, null, 2) + '\n');
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

function headSha(repo) { return git(repo, ['rev-parse', 'HEAD']).trim(); }

async function spineText(repo) {
  return readFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), 'utf8').catch(() => '');
}
async function spineEvents(repo) {
  const dir = join(repo, '.maddu', 'events');
  let out = [];
  for (const f of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.ndjson')).sort()) {
    const text = await readFile(join(dir, f), 'utf8');
    for (const line of text.split('\n')) { if (line.trim()) { try { out.push(JSON.parse(line)); } catch {} } }
  }
  return out;
}

async function replayTempDirs() {
  return (await readdir(tmpdir()).catch(() => [])).filter((d) => d.startsWith('maddu-replay-'));
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

const NODE = JSON.stringify(process.execPath); // absolute node path, shell-quoted

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'maddu-replayt-'));
  const tempBefore = await replayTempDirs();
  try {
    const vr = await import(pathToFileURL(LIB).href);
    const recency = await import(pathToFileURL(RECENCY_LIB).href);

    // ── 1. unit: settlement + env seam ──
    const bad = await vr.runDeclared(`${NODE} -e "process.exit(0)"`, { cwd: join(base, 'no-such-dir'), timeoutMs: 8000 });
    ok('runDeclared with bad cwd settles a spawnError (never rejects)', bad.settled === true && bad.spawnError !== null && bad.exit === null, JSON.stringify(bad));
    const oldSeam = process.env.MADDU_REPLAY_TIMEOUT_MS;
    process.env.MADDU_REPLAY_TIMEOUT_MS = 'junk';
    ok('timeout seam: junk falls back to default', vr.replayTimeoutMs() === vr.REPLAY_TIMEOUT_MS_DEFAULT);
    process.env.MADDU_REPLAY_TIMEOUT_MS = '1234';
    ok('timeout seam: numeric honored', vr.replayTimeoutMs() === 1234);
    if (oldSeam === undefined) delete process.env.MADDU_REPLAY_TIMEOUT_MS; else process.env.MADDU_REPLAY_TIMEOUT_MS = oldSeam;

    // ── 2. pass / verify-fail / install-fail + receipt shape ──
    const rPass = await makeRepo(base, 'pass', { madduJson: { name: 'pass', replay: { install: `${NODE} -e "process.exit(0)"`, verify: `${NODE} -e "process.exit(0)"` } } });
    const shaPass = headSha(rPass);
    const o1 = runCli(rPass, ['spine', 'verify', '--replay', shaPass]);
    ok('pass: exit 0', o1.status === 0, `status=${o1.status} stderr=${(o1.stderr || '').slice(0, 200)}`);
    ok('pass: honest-scope line printed', (o1.stdout || '').includes('git object copying only'));
    const evs1 = await spineEvents(rPass);
    const started1 = evs1.filter((e) => e.type === 'VERIFICATION_STARTED' && e.data.kind === 'replay');
    const ran1 = evs1.filter((e) => e.type === 'VERIFICATION_RAN' && e.data.kind === 'replay');
    ok('pass: exactly one strict STARTED→RAN pair', started1.length === 1 && ran1.length === 1
      && ran1[0].data.startedId === started1[0].id
      && started1[0].data.profile === 'replayed' && ran1[0].data.profile === 'replayed');
    const d1 = ran1[0]?.data || {};
    ok('pass: receipt shape (subject, exits, flags)', d1.result === 'pass' && d1.complete === true
      && d1.subject_sha === shaPass && d1.install_exit === 0 && d1.verify_exit === 0
      && d1.timed_out === false && d1.clone_deleted === true && d1.counts === null
      && d1.commands && typeof d1.commands.verify === 'string');

    const rFail = await makeRepo(base, 'vfail', { madduJson: { name: 'vfail', replay: { verify: `${NODE} -e "process.exit(3)"` } } });
    const o2 = runCli(rFail, ['spine', 'verify', '--replay', headSha(rFail), '--json']);
    const j2 = JSON.parse(o2.stdout);
    ok('verify-fail: exit 1, result fail, complete TRUE (protocol ran)', o2.status === 1
      && j2.result === 'fail' && j2.complete === true && j2.verifyExit === 3 && j2.installDeclared === false);

    const rIFail = await makeRepo(base, 'ifail', { madduJson: { name: 'ifail', replay: { install: `${NODE} -e "process.exit(2)"`, verify: `${NODE} -e "process.exit(0)"` } } });
    const o3 = runCli(rIFail, ['spine', 'verify', '--replay', headSha(rIFail), '--json']);
    const j3 = JSON.parse(o3.stdout);
    ok('install-fail: verify never runs, complete false', o3.status === 1
      && j3.result === 'fail' && j3.complete === false && j3.installExit === 2 && j3.verifyExit === null);

    // ── 3. timeout tree kill (grandchild-spawning verify) ──
    const rKill = await makeRepo(base, 'tkill', { madduJson: { name: 'tkill', replay: { verify: `${NODE} spawner.mjs` } } });
    const pidFile = join(base, 'pids.txt');
    await writeFile(join(rKill, 'spawner.mjs'), [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });",
      "writeFileSync(process.env.MADDU_TEST_PIDFILE, process.pid + ' ' + c.pid);",
      'setTimeout(()=>{}, 60000);',
    ].join('\n'));
    git(rKill, ['add', '-A']); git(rKill, ['commit', '-q', '-m', 'spawner']);
    const t0 = Date.now();
    const o4 = runCli(rKill, ['spine', 'verify', '--replay', headSha(rKill), '--json'],
      { MADDU_REPLAY_TIMEOUT_MS: '2000', MADDU_TEST_PIDFILE: pidFile });
    const elapsed = Date.now() - t0;
    const j4 = JSON.parse(o4.stdout);
    ok('timeout: exit 1, timed_out, complete false, settled', o4.status === 1
      && j4.timedOut === true && j4.result === 'fail' && j4.complete === false && j4.settled === true,
      JSON.stringify({ status: o4.status, timedOut: j4.timedOut, settled: j4.settled }));
    ok('timeout: returned well under the 60s child sleep', elapsed < 45000, `${elapsed}ms`);
    const pids = (await readFile(pidFile, 'utf8').catch(() => '')).trim().split(/\s+/).map(Number).filter(Boolean);
    ok('timeout: pidfile captured parent+grandchild', pids.length === 2, JSON.stringify(pids));
    await new Promise((r) => setTimeout(r, 500));
    ok('timeout: BOTH processes dead (tree kill)', pids.length === 2 && !alive(pids[0]) && !alive(pids[1]),
      JSON.stringify(pids.map((p) => ({ p, alive: alive(p) }))));
    ok('timeout: clone deleted after kill', j4.cloneDeleted === true && j4.cloneDir === null);

    // ── 3b. lingering descendant holding the piped stdio must not stall
    // settlement (--json pipes; the shell exits 0 while a detached grandchild
    // keeps the inherited pipe open for 60s) ──
    const rLinger = await makeRepo(base, 'linger', { madduJson: { name: 'linger', replay: { verify: `${NODE} linger.mjs` } } });
    await writeFile(join(rLinger, 'linger.mjs'), [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "// cwd OUTSIDE the clone: this lingerer squats on the inherited PIPE only",
      "// (the cwd-squatter variant is the cleanup-fail path, seam-tested above).",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'inherit', detached: true, cwd: tmpdir() });",
      'c.unref();',
      "writeFileSync(process.env.MADDU_TEST_LINGER_PID, String(c.pid));",
      'process.exit(0);',
    ].join('\n'));
    git(rLinger, ['add', '-A']); git(rLinger, ['commit', '-q', '-m', 'linger']);
    const lingerPidFile = join(base, 'linger-pid.txt');
    const tL = Date.now();
    const oL = runCli(rLinger, ['spine', 'verify', '--replay', headSha(rLinger), '--json'], { MADDU_TEST_LINGER_PID: lingerPidFile });
    const elapsedL = Date.now() - tL;
    let jL = null; try { jL = JSON.parse(oL.stdout); } catch {}
    ok('lingering descendant: settles pass promptly (pipes released after exit)',
      oL.status === 0 && jL?.result === 'pass' && elapsedL < 30000, `${elapsedL}ms status=${oL.status}`);
    const lingerPid = Number((await readFile(lingerPidFile, 'utf8').catch(() => '')).trim());
    if (lingerPid && alive(lingerPid)) { try { process.kill(lingerPid); } catch {} }

    // ── 3c. WRAPPER signal death is NOT complete (POSIX only: Windows shells
    // report numeric exit codes, not signals). `kill` is a shell BUILTIN and
    // `$$` is the shell node spawned — our direct child SIGKILLs itself, so
    // 'close' reports (null, SIGKILL). (A signal sent to a grandchild instead
    // surfaces as numeric 128+n from the surviving shell — that is case
    // 3c-ii below, the documented residual.) ──
    if (process.platform !== 'win32') {
      const rSig = await makeRepo(base, 'sigkill', { madduJson: { name: 'sigkill', replay: { verify: 'kill -9 $$' } } });
      const oSig = runCli(rSig, ['spine', 'verify', '--replay', headSha(rSig), '--json']);
      const jSig = JSON.parse(oSig.stdout);
      ok('signal-killed verify: fail + complete FALSE (never "protocol completed")',
        oSig.status === 1 && jSig.result === 'fail' && jSig.complete === false && jSig.verifyExit === null,
        JSON.stringify({ status: oSig.status, complete: jSig.complete, sig: jSig.verifySignal }));
    }

    // ── 3c-ii. INNER signal death (nested shell): reports numeric 128+n →
    // fail with complete:true (documented residual — 128+n is also a
    // legitimate exit code); the point proven here: never a pass ──
    if (process.platform !== 'win32') {
      // `; exit $?` forces the outer shell to FORK the inner sh (a lone
      // command would be exec'd, collapsing this into case 3c) and then
      // report the inner signal death as numeric 128+9.
      const rSig2 = await makeRepo(base, 'siginner', { madduJson: { name: 'siginner', replay: { verify: `sh -c 'kill -9 $$'; exit $?` } } });
      const oSig2 = runCli(rSig2, ['spine', 'verify', '--replay', headSha(rSig2), '--json']);
      const jSig2 = JSON.parse(oSig2.stdout);
      ok('inner signal death: FAIL with numeric 128+n, complete:true (the documented residual, exactly)',
        oSig2.status === 1 && jSig2.result === 'fail'
        && typeof jSig2.verifyExit === 'number' && jSig2.verifyExit >= 128
        && jSig2.complete === true && jSig2.verifySignal === null,
        JSON.stringify({ exit: jSig2.verifyExit, sig: jSig2.verifySignal, complete: jSig2.complete }));
    }

    // ── 3e. token-shaped UNKNOWN CONFIG KEY never leaks through refusals ──
    const tokenKey = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const rLeak = await makeRepo(base, 'keyleak', { madduJson: { name: 'keyleak', replay: { verify: 'v', [tokenKey]: true } } });
    const oLeakH = runCli(rLeak, ['spine', 'verify', '--replay', headSha(rLeak)]);
    const oLeakJ = runCli(rLeak, ['spine', 'verify', '--replay', headSha(rLeak), '--json']);
    ok('unknown-key refusal: token-shaped key redacted (human stderr + --json)',
      oLeakH.status === 2 && oLeakJ.status === 2
      && !(oLeakH.stderr || '').includes(tokenKey) && !(oLeakH.stdout || '').includes(tokenKey)
      && !(oLeakJ.stdout || '').includes(tokenKey) && !(oLeakJ.stderr || '').includes(tokenKey)
      && /unknown key/i.test(oLeakH.stderr), (oLeakH.stderr || '').slice(0, 140));

    // ── 3f. committed SYMLINK maddu.json (mode 120000) refused even where
    // core.symlinks=false would materialize it as a regular file whose
    // CONTENT is the target string — here the target string IS valid JSON
    // declaring commands, the exact smuggling shape ──
    const rSym = await makeRepo(base, 'symcfg', {});
    const evilTarget = JSON.stringify({ name: 'symcfg', replay: { verify: `${NODE} -e "require('fs').writeFileSync(process.env.MADDU_TEST_SYM_MARK,'x')"` } });
    const symBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: rSym, input: evilTarget, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${symBlob},maddu.json`], { cwd: rSym });
    git(rSym, ['commit', '-q', '-m', 'symlink maddu.json']);
    const symMark = join(base, 'sym-mark.txt');
    const oSym = runCli(rSym, ['spine', 'verify', '--replay', headSha(rSym)], { MADDU_TEST_SYM_MARK: symMark });
    ok('symlink maddu.json in tree → config-invalid; smuggled commands never run',
      oSym.status === 2 && /not a regular file in the tree|mode 120000/i.test(oSym.stderr) && !(await exists(symMark)),
      (oSym.stderr || '').slice(0, 140));

    // ── 3g. token-shaped UNKNOWN FLAG name never echoed verbatim ──
    const tokenFlag = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
    const oFlagLeak = runCli(rSym, ['spine', 'verify', `--${tokenFlag}`]);
    ok('unknown-flag refusal: token-shaped flag name redacted',
      oFlagLeak.status === 2 && !(oFlagLeak.stderr || '').includes(tokenFlag) && /unknown flag/i.test(oFlagLeak.stderr),
      (oFlagLeak.stderr || '').slice(0, 140));

    // ── 3d. `git replace` refs must not fool subject validation or checkout ──
    const rRepl = await makeRepo(base, 'replref', { madduJson: { name: 'replref', replay: { verify: `${NODE} -e "process.exit(0)"` } } });
    const shaRepl = headSha(rRepl);
    const blobId = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: rRepl, input: 'not a commit\n', encoding: 'utf8' }).trim();
    git(rRepl, ['replace', '-f', shaRepl, blobId]);
    const oRepl = runCli(rRepl, ['spine', 'verify', '--replay', shaRepl, '--json']);
    const jRepl = JSON.parse(oRepl.stdout || '{}');
    ok('replace-ref smuggling: raw commit still validates and replays (blob replacement ignored)',
      oRepl.status === 0 && jRepl.result === 'pass', `status=${oRepl.status} ${(oRepl.stderr || '').slice(0, 120)}`);

    // ── 4. declared-only discipline ──
    const rNone = await makeRepo(base, 'none', { madduJson: { name: 'none' } });
    const spineBefore = await spineText(rNone);
    const o5 = runCli(rNone, ['spine', 'verify', '--replay', headSha(rNone)]);
    ok('undeclared → unsupported, exit 2', o5.status === 2 && /unsupported|declares no replay/i.test(o5.stderr));
    ok('undeclared → NO spine events', (await spineText(rNone)) === spineBefore);
    ok('undeclared output never says replayed', !/\breplayed\b/.test(o5.stdout || ''));

    const badShapes = [
      ['replay-array', { name: 'x', replay: ['a'] }],
      ['verify-missing', { name: 'x', replay: {} }],
      ['verify-blank', { name: 'x', replay: { verify: '   ' } }],
      ['install-nonstring', { name: 'x', replay: { install: 5, verify: 'v' } }],
      ['unknown-key', { name: 'x', replay: { verify: 'v', timeoutMs: 5 } }],
    ];
    for (const [label, cfg] of badShapes) {
      const rr = await makeRepo(base, `bad-${label}`, { madduJson: cfg });
      const oo = runCli(rr, ['spine', 'verify', '--replay', headSha(rr)]);
      ok(`malformed config (${label}) → config-invalid exit 2`, oo.status === 2 && /config|shape|must be/i.test(oo.stderr), (oo.stderr || '').slice(0, 120));
    }

    // config read AT THE SHA, not the worktree
    const rSha = await makeRepo(base, 'atsha', { madduJson: { name: 'atsha' } });
    const shaA = headSha(rSha); // no replay declared at A
    await writeFile(join(rSha, 'maddu.json'), JSON.stringify({ name: 'atsha', replay: { verify: `${NODE} -e "process.exit(0)"` } }, null, 2) + '\n');
    git(rSha, ['add', '-A']); git(rSha, ['commit', '-q', '-m', 'declare replay']);
    const shaB = headSha(rSha); // declared at B
    await writeFile(join(rSha, 'maddu.json'), JSON.stringify({ name: 'atsha' }, null, 2) + '\n');
    git(rSha, ['add', '-A']); git(rSha, ['commit', '-q', '-m', 'remove replay']); // removed at C (HEAD)
    const oA = runCli(rSha, ['spine', 'verify', '--replay', shaA]);
    ok('config-at-SHA: pre-declaration commit → unsupported (worktree history irrelevant)', oA.status === 2 && /unsupported|declares no replay/i.test(oA.stderr));
    const oB = runCli(rSha, ['spine', 'verify', '--replay', shaB, '--json']);
    ok('config-at-SHA: declaring commit replays even when HEAD removed it', oB.status === 0 && JSON.parse(oB.stdout).result === 'pass');

    // ── 5. exact-SHA discipline ──
    const rShaChecks = await makeRepo(base, 'shachecks', { madduJson: { name: 'shachecks', replay: { verify: `${NODE} -e "process.exit(0)"` } } });
    const full = headSha(rShaChecks);
    for (const [label, subject, re] of [
      ['abbreviation', full.slice(0, 12), /full lowercase hex/i],
      ['uppercase', full.toUpperCase(), /full lowercase hex/i],
      ['ref name', 'HEAD', /full lowercase hex/i],
      ['nonexistent full sha', 'f'.repeat(40), /does not exist/i],
    ]) {
      const oo = runCli(rShaChecks, ['spine', 'verify', '--replay', subject]);
      ok(`sha discipline: ${label} refused`, oo.status === 2 && re.test(oo.stderr), (oo.stderr || '').slice(0, 120));
    }
    git(rShaChecks, ['tag', '-a', 'vtag', '-m', 'annotated']);
    const tagId = git(rShaChecks, ['rev-parse', 'vtag']).trim();
    const oTag = runCli(rShaChecks, ['spine', 'verify', '--replay', tagId]);
    ok('sha discipline: annotated-tag object id refused (peel defense)',
      tagId !== full && oTag.status === 2 && /is a tag, not a commit/i.test(oTag.stderr), (oTag.stderr || '').slice(0, 120));

    // ── 6. dirty-worktree contamination detection ──
    const rDirty = await makeRepo(base, 'dirty', { madduJson: { name: 'dirty', replay: { verify: `${NODE} check.mjs` } } });
    await writeFile(join(rDirty, 'check.mjs'), 'process.exit(0);\n');
    git(rDirty, ['add', '-A']); git(rDirty, ['commit', '-q', '-m', 'check ok']);
    const shaClean = headSha(rDirty);
    await writeFile(join(rDirty, 'check.mjs'), 'process.exit(7);\n'); // uncommitted sabotage
    const oD = runCli(rDirty, ['spine', 'verify', '--replay', shaClean, '--json']);
    const jD = JSON.parse(oD.stdout);
    ok('dirty worktree does not contaminate the clone (replay of committed state passes)',
      oD.status === 0 && jD.result === 'pass' && jD.verifyExit === 0);

    // ── 7. --json purity ──
    const rJson = await makeRepo(base, 'jsonp', { madduJson: { name: 'jsonp', replay: { verify: `${NODE} -e "console.log('CHILD_OUT_MARKER'); process.exit(0)"` } } });
    const oJ = runCli(rJson, ['spine', 'verify', '--replay', headSha(rJson), '--json']);
    let jJ = null; try { jJ = JSON.parse(oJ.stdout); } catch {}
    ok('--json: stdout is exactly one parseable JSON document', jJ !== null && jJ.result === 'pass');
    ok('--json: child stdout routed to stderr, never stdout',
      !(oJ.stdout || '').includes('CHILD_OUT_MARKER') && (oJ.stderr || '').includes('CHILD_OUT_MARKER'));
    ok('--json: scope line carried in the document', typeof jJ?.scope === 'string' && jJ.scope.includes('git object copying only'));

    // ── 8. forced cleanup failure fails CLOSED (guarded test seam) ──
    const rClean = await makeRepo(base, 'cleanfail', { madduJson: { name: 'cleanfail', replay: { verify: `${NODE} -e "process.exit(0)"` } } });
    const oC = runCli(rClean, ['spine', 'verify', '--replay', headSha(rClean), '--json'], { MADDU_REPLAY_TEST_CLEANUP_FAIL: '1' });
    const jC = JSON.parse(oC.stdout);
    ok('cleanup-fail: exit 1 even though the commands passed', oC.status === 1 && jC.verifyExit === 0);
    ok('cleanup-fail: receipt fails closed (fail, complete false, clone_deleted false)',
      jC.result === 'fail' && jC.complete === false && jC.cloneDeleted === false && typeof jC.cloneDir === 'string');
    const evsC = (await spineEvents(rClean)).filter((e) => e.type === 'VERIFICATION_RAN' && e.data.kind === 'replay');
    ok('cleanup-fail: spine receipt mirrors the fail-closed shape',
      evsC.length === 1 && evsC[0].data.result === 'fail' && evsC[0].data.complete === false
      && evsC[0].data.clone_deleted === false && evsC[0].data.verify_exit === 0);
    if (jC.cloneDir) await rm(jC.cloneDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});

    // ── 9. spine-unavailable refuses PRE-run ──
    const rSpine = await makeRepo(base, 'nospine', { madduJson: { name: 'nospine', replay: { verify: `${NODE} -e "require('fs').writeFileSync(process.env.MADDU_TEST_RAN_MARK || 'ran.txt', 'x'); process.exit(0)"` } } });
    const shaS = headSha(rSpine);
    await rm(join(rSpine, '.maddu', 'events'), { recursive: true, force: true });
    await writeFile(join(rSpine, '.maddu', 'events'), 'not a directory\n'); // events as FILE → append throws
    const ranMark = join(base, 'ran-mark.txt');
    const oS = runCli(rSpine, ['spine', 'verify', '--replay', shaS], { MADDU_TEST_RAN_MARK: ranMark });
    ok('spine-unavailable: refuses (exit 2) and never runs the commands',
      oS.status === 2 && /unrecorded|spine/i.test(oS.stderr) && !(await exists(ranMark)), (oS.stderr || '').slice(0, 160));
    // Same refusal with cleanup ALSO failing → the leftover clone is named.
    const oS2 = runCli(rSpine, ['spine', 'verify', '--replay', shaS], { MADDU_TEST_RAN_MARK: ranMark, MADDU_REPLAY_TEST_CLEANUP_FAIL: '1' });
    const leftMatch = /clone was left at (.+?) — delete/.exec(oS2.stderr || '');
    ok('spine-unavailable + cleanup-fail: refusal names the leftover clone path',
      oS2.status === 2 && leftMatch !== null, (oS2.stderr || '').slice(0, 200));
    if (leftMatch) await rm(leftMatch[1].trim(), { recursive: true, force: true, maxRetries: 5 }).catch(() => {});

    // ── 10. recency isolation ──
    const evsIso = await spineEvents(rPass);
    const asProjectTest = recency.pairVerifications(evsIso, 'project-test');
    const asReplay = recency.pairVerifications(evsIso, 'replay');
    ok('recency isolation: replay receipts never pair as project-test',
      asProjectTest.valid.length === 0 && asReplay.valid.length === 1);

    // ── 11. flag validation ──
    for (const [label, args] of [
      ['unknown flag', ['spine', 'verify', '--replya', shaPass]],
      ['valueless --replay', ['spine', 'verify', '--replay']],
      ['positional extra', ['spine', 'verify', 'now', '--replay', shaPass]],
      ['--json with value', ['spine', 'verify', '--replay', shaPass, '--json=false']],
    ]) {
      const oo = runCli(rPass, args);
      ok(`flag validation: ${label} → usage exit 2`, oo.status === 2 && /Usage: maddu spine verify/.test(oo.stderr));
    }
    const oPlain = runCli(rPass, ['spine', 'verify']);
    ok('flag validation: plain `spine verify` integrity walk still works', oPlain.status === 0 && /spine integrity|events/.test(oPlain.stdout));

    // ── 12. no temp-dir leaks across ALL scenarios (last, after every case;
    // deliberately-leaked seam clones were removed above as part of their
    // own assertions) ──
    const tempAfter = await replayTempDirs();
    const leaked = tempAfter.filter((d) => !tempBefore.includes(d));
    ok('cleanup: no maddu-replay-* temp dirs leaked by any scenario', leaked.length === 0, JSON.stringify(leaked));

  } catch (e) {
    console.error('harness error:', e && e.stack || e);
    process.exitCode = 2;
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
