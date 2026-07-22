// `maddu loop <subcommand>` — ralph + plan-loop primitives (v1.1.0 Phase 6).
//
// Usage:
//   maddu loop ralph --goal "<task>" [--max-iter N] [--lane <id>]
//                    [--verify "<bash-command>"] [--iterate "<bash-command>"]
//   maddu loop plan  --plan <plan-id> [--max-iter N]
//   maddu loop status [--loop <id>]
//   maddu loop cancel <loop-id>
//
// `--verify` exit=0 ⇒ ok; non-zero ⇒ fail. Stuck-detection halts after
// two consecutive identical failure signatures.

import { spawn } from 'node:child_process';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, envActingSid } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m' };

// NOTE (v1.3.0 coherence): `maddu loop` (ralph/plan) and `maddu coordinator`
// both drive bounded multi-phase iteration with the same "same fail
// signature twice in a row → halt" stuck-detection heuristic. The two
// implementations live in runtime/lib/loops.mjs (runLoop) and
// runtime/lib/coordinator.mjs (runCoordinator). They were NOT merged: the
// loops core emits LOOP_* events and takes verify/iterate callbacks, while
// the coordinator emits COORDINATOR_* events, injects MADDU_COORDINATOR_*
// env, and spawns one subprocess per phase. The control flow is interwoven
// with each one's distinct event emission, so extracting a shared core was
// judged higher-risk than the duplication it removes. This cross-reference
// is the deliberate alternative — see runtime/lib/coordinator.mjs.

async function loadLoopsLib() {
  return loadLib('loops.mjs');
}

function runShell(cmd, cwd) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'sh';
    const args = isWin ? ['/c', cmd] : ['-c', cmd];
    const ch = spawn(shell, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    ch.stdout.on('data', (b) => stdout += b.toString());
    ch.stderr.on('data', (b) => stderr += b.toString());
    ch.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export default async function loopCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const loopsLib = await loadLoopsLib();
  const sessionId = await envActingSid();

  if (!sub) { console.error('usage: maddu loop <ralph|plan|status|cancel> [args]'); process.exit(2); }

  if (sub === 'ralph' || sub === 'plan') {
    const { flags } = parseFlags(rest);
    const goal = typeof flags.goal === 'string' ? flags.goal : (typeof flags.plan === 'string' ? `plan-loop ${flags.plan}` : null);
    if (!goal) {
      console.error('usage: maddu loop ralph --goal "<task>" [--max-iter N] [--verify "<bash>"] [--iterate "<bash>"]');
      process.exit(2);
    }
    const verifyCmd = typeof flags.verify === 'string' ? flags.verify : null;
    const iterateCmd = typeof flags.iterate === 'string' ? flags.iterate : null;
    const maxIter = typeof flags['max-iter'] === 'string' ? Number(flags['max-iter']) : null;

    const verify = async (iter) => {
      if (!verifyCmd) {
        // No verify command → always-fail (will hit stuck-detection or max-iter).
        return { ok: false, signature: 'no-verify-supplied', summary: 'no --verify command' };
      }
      const r = await runShell(verifyCmd, repoRoot);
      const tail = (r.stdout + '\n' + r.stderr).slice(-200);
      return { ok: r.code === 0, signature: `exit=${r.code}:${tail.slice(0, 80)}`, summary: r.code === 0 ? 'verify passed' : `verify failed exit=${r.code}` };
    };
    const iterate = iterateCmd ? async (iter) => {
      const r = await runShell(iterateCmd, repoRoot);
      return { summary: `iterate exit=${r.code}` };
    } : null;

    const triggered_by = sub === 'plan' && typeof flags.plan === 'string' ? { planId: flags.plan } : null;
    console.log(`${ANSI.bold}loop:${sub}${ANSI.reset}  goal: ${goal}`);
    const res = await loopsLib.runLoop(repoRoot, {
      kind: sub === 'plan' ? 'plan-loop' : 'ralph',
      goal, verify, iterate, maxIter,
      by: sessionId, lane: typeof flags.lane === 'string' ? flags.lane : null,
      triggered_by,
    });
    if (res.ok) {
      console.log(`${ANSI.pass}completed${ANSI.reset}  loop ${res.loopId}  iters=${res.iters}`);
      process.exit(0);
    } else {
      console.error(`${ANSI.fail}halted${ANSI.reset}     loop ${res.loopId}  iters=${res.iters}  reason=${res.reason}`);
      if (res.signature) console.error(`           signature: ${res.signature}`);
      process.exit(1);
    }
  }

  if (sub === 'status') {
    const { spine } = await loadSpineLib();
    const all = await spine.readAll(repoRoot);
    const loopEvents = all.filter((e) => /^LOOP_/.test(e.type));
    if (loopEvents.length === 0) { console.log('(no loop activity)'); return; }
    const byId = {};
    for (const ev of loopEvents) {
      const id = ev.data?.loopId;
      if (!id) continue;
      if (!byId[id]) byId[id] = { loopId: id, kind: ev.data.kind, started: null, iters: 0, status: 'open', goal: ev.data.goal || null };
      if (ev.type === 'LOOP_STARTED') byId[id].started = ev.ts;
      else if (ev.type === 'LOOP_ITERATION_COMPLETED') byId[id].iters = ev.data.iter || byId[id].iters;
      else if (ev.type === 'LOOP_HALTED') { byId[id].status = 'halted'; byId[id].reason = ev.data.reason; }
      else if (ev.type === 'LOOP_COMPLETED') { byId[id].status = 'completed'; }
    }
    const filter = typeof argv[1] === 'string' && argv[1] === '--loop' ? argv[2] : null;
    const list = Object.values(byId).filter((x) => !filter || x.loopId === filter);
    console.log(`${ANSI.bold}LOOPS  (${list.length})${ANSI.reset}`);
    for (const l of list) {
      const c = l.status === 'completed' ? ANSI.pass : (l.status === 'halted' ? ANSI.fail : ANSI.dim);
      console.log(`  ${l.loopId}  ${l.kind.padEnd(10)} ${c}${l.status}${ANSI.reset}  iters=${l.iters}  ${ANSI.dim}${l.goal || ''}${ANSI.reset}`);
      if (l.reason) console.log(`    ${ANSI.dim}reason: ${l.reason}${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'cancel') {
    const loopId = rest[0];
    if (!loopId) { console.error('usage: maddu loop cancel <loop-id>'); process.exit(2); }
    const { spine } = await loadSpineLib();
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.LOOP_HALTED,
      actor: sessionId, lane: null,
      data: { loopId, kind: null, iter: null, reason: 'operator-cancel' },
    });
    console.log(`${ANSI.warn}cancelled${ANSI.reset}  ${loopId}`);
    return;
  }

  console.error(`maddu loop: unknown subcommand "${sub}"`);
  process.exit(2);
}
