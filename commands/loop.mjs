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
import { loadSpineLib, resolveRepoRoot, resolveWorkAndStateRoots, envActingSid } from './_spine.mjs';
import { loadLib, loadLibOptional } from './_libroot.mjs';

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

// `shell: true` rather than a hand-rolled `cmd.exe /c` argv. On POSIX the two
// are identical (`sh -c <cmd>`), but on Windows they are not: `cmd.exe /c` with
// the command as ONE argv entry hits cmd's quote-stripping rule, so any command
// whose first token is a quoted path — `"C:\Program Files\nodejs\node.exe" …`,
// i.e. the DEFAULT Node install location — never launches at all. It reports
// `'"C:\Program Files\..."' is not recognized` and exits nonzero, which a loop
// then reads as a genuine verify/iterate failure and iterates against forever.
// Node's own `shell:true` emits `cmd.exe /d /s /c "<cmd>"`, whose `/s` rule
// handles exactly this; it is also what `evalCondition` and the acceptance
// executor already use, so this makes the three agree instead of adding a
// fourth convention.
function runShell(cmd, cwd) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let stdout = '', stderr = '';
    ch.stdout.on('data', (b) => stdout += b.toString());
    ch.stderr.on('data', (b) => stderr += b.toString());
    ch.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A repeatable flag as a raw list, UNFILTERED — `--oracle` with no value parses
// to `true`, and dropping it silently would run a loop against a declared set
// one pattern shorter than the operator typed. The validator refuses it loudly.
function flagList(raw) {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function reportLoop(res) {
  if (res.ok) {
    console.log(`${ANSI.pass}completed${ANSI.reset}  loop ${res.loopId}  iters=${res.iters}`);
    process.exit(0);
  }
  console.error(`${ANSI.fail}halted${ANSI.reset}     loop ${res.loopId}  iters=${res.iters}  reason=${res.reason}`);
  if (res.signature) console.error(`           signature: ${res.signature}`);
  process.exit(1);
}

export default async function loopCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections, verify: verifyLib } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const loopsLib = await loadLoopsLib();
  const sessionId = await envActingSid();

  if (!sub) { console.error('usage: maddu loop <ralph|plan|status|cancel> [args]'); process.exit(2); }

  // The PLAN loop is untouched by PR-2: no acceptance, no baseline, no intent
  // fields — its LOOP_STARTED payload stays byte-identical to what it has
  // always written.
  if (sub === 'plan') {
    const { flags } = parseFlags(rest);
    const goal = typeof flags.goal === 'string' ? flags.goal : (typeof flags.plan === 'string' ? `plan-loop ${flags.plan}` : null);
    if (!goal) {
      console.error('usage: maddu loop plan --plan <plan-id> [--max-iter N] [--verify "<bash>"] [--iterate "<bash>"]');
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

    console.log(`${ANSI.bold}loop:plan${ANSI.reset}  goal: ${goal}`);
    reportLoop(await loopsLib.runLoop(repoRoot, {
      kind: 'plan-loop',
      goal, verify, iterate, maxIter,
      by: sessionId, lane: typeof flags.lane === 'string' ? flags.lane : null,
      triggered_by: typeof flags.plan === 'string' ? { planId: flags.plan } : null,
    }));
  }

  // ── ralph — every ralph loop is now an ACCEPTANCE loop ───────────────────
  //
  // PR-2 W1. A ralph loop asks one question — "is it green yet?" — and until
  // now it would answer that question with an unrecorded shell exit code, or,
  // with no `--verify` at all, burn every iteration on a synthetic
  // `no-verify-supplied` failure until the cap. Both are refused at the door
  // now: a loop that cannot succeed must say so before it spends anything, and
  // a loop that CAN succeed records what it observed.
  //
  // BREAKING for a bare `ralph --verify "<cmd>"`: an acceptance with no declared
  // oracle and implementation can never satisfy O3 or O8, so it could iterate to
  // green and still prove nothing. The refusal is loud and typed rather than
  // silently recording unprovable observations.
  if (sub === 'ralph') {
    const { flags } = parseFlags(rest);
    const fromGoal = Object.hasOwn(flags, 'from-goal');
    // PRESENCE and VALUE are separate questions (funnel r1 #1): a bare
    // `--verify` or `--verify=` still names the ad-hoc intent, so it must
    // still CONFLICT with --from-goal rather than silently vanishing into a
    // goal adoption that reports green on flags the operator never reconciled.
    const verifySupplied = Object.hasOwn(flags, 'verify');
    const verifyCmd = typeof flags.verify === 'string' && flags.verify.trim() ? flags.verify : null;
    const iterateCmd = typeof flags.iterate === 'string' ? flags.iterate : null;
    const maxIter = typeof flags['max-iter'] === 'string' ? Number(flags['max-iter']) : null;
    const lane = typeof flags.lane === 'string' ? flags.lane : null;

    if (fromGoal && verifySupplied) {
      console.error('--from-goal and --verify are two answers to one question: --from-goal adopts the active goal\'s conditions, --verify declares an ad-hoc one. Pick one.');
      process.exit(2);
    }
    if (!fromGoal && !verifyCmd) {
      console.error('maddu loop ralph needs something to verify: --from-goal (adopt the active goal\'s conditions) or --verify "<cmd>" --oracle "<glob>" --impl "<glob>".');
      process.exit(2);
    }

    const acceptance = await loadLibOptional('acceptance.mjs');
    const recorder = await loadLibOptional('acceptance-record.mjs');
    if (!acceptance?.refuseDeclaredSet || !recorder?.observeAcceptance) {
      console.error('maddu loop ralph needs the acceptance library — this install predates it; run `maddu upgrade` first.');
      process.exit(2);
    }

    // Roots: the observed command runs in the WORK root and its digests
    // describe that tree; loop events and receipts append to the STATE root.
    const rootsPair = await resolveWorkAndStateRoots(paths);
    const workRoot = rootsPair ? rootsPair.workRoot : repoRoot;
    const stateRoot = rootsPair ? rootsPair.stateRoot : repoRoot;

    let conditions = null;         // [{ text, verify }]
    let oraclePatterns = null;
    let implPatterns = null;
    let declEventId = null;
    let label = null;
    let verifyOverride = false;

    if (fromGoal) {
      // --from-goal is EXPLICIT and never inferred. It requires a goal this
      // loop can actually prove something about: driving a legacy goal through
      // it would complete on void receipts with no possible proof, which is
      // exactly the "green because nothing was checked" outcome the track
      // exists to close.
      const proj = await projections.project(repoRoot);
      const g = proj.goal || null;
      if (!g) { console.error('--from-goal: no goal declared — set one with `maddu goal set`.'); process.exit(3); }
      if (g.status !== 'active') { console.error(`--from-goal: the goal is ${g.status}, not active — set a new one with \`maddu goal set\`.`); process.exit(3); }
      const verifiable = (Array.isArray(g.success) ? g.success : []).filter((c) => c.verify);
      if (!verifiable.length) { console.error('--from-goal: the active goal declares no verifiable success condition (`--success "<cmd>::<text>"`).'); process.exit(3); }
      if (!Array.isArray(g.oracle) || !g.oracle.length || !Array.isArray(g.implementation) || !g.implementation.length) {
        console.error('--from-goal: the active goal declares no acceptance sets — re-declare it with `maddu goal set … --oracle "<glob>" --impl "<glob>"`.');
        process.exit(3);
      }
      // A goal declared by a pre-validation CLI can carry sets acceptanceIdFor
      // would throw on (over-budget pattern, blank entry). Refuse at the door
      // with the reason instead of surfacing a per-condition throw every
      // iteration as "not green".
      for (const [setLabel, patterns] of [['goal oracle', g.oracle], ['goal implementation', g.implementation]]) {
        const r = acceptance.refuseDeclaredSet(patterns, setLabel);
        if (r.ok !== true) { console.error(`--from-goal: ${r.reason}: ${r.detail}`); process.exit(3); }
      }
      conditions = verifiable;
      oraclePatterns = g.oracle;
      implPatterns = g.implementation;
      declEventId = g.declEventId ?? null;
      label = g.objective || 'goal';
    } else {
      oraclePatterns = flagList(flags.oracle);
      implPatterns = flagList(flags.impl);
      if (!oraclePatterns.length || !implPatterns.length) {
        console.error('--verify needs its declared sets: --oracle "<glob>" (the files that must stay frozen) and --impl "<glob>" (the files that must move). Without them nothing this loop observes can ever become a proof.');
        process.exit(2);
      }
      for (const [flagLabel, patterns] of [['--oracle', oraclePatterns], ['--impl', implPatterns]]) {
        const r = acceptance.refuseDeclaredSet(patterns, flagLabel);
        if (r.ok !== true) { console.error(`${r.reason}: ${r.detail}`); process.exit(2); }
      }
      label = typeof flags.goal === 'string' ? flags.goal : null;
      if (!label) {
        console.error('usage: maddu loop ralph --goal "<task>" --verify "<bash>" --oracle "<glob>" --impl "<glob>" [--iterate "<bash>"] [--max-iter N]');
        process.exit(2);
      }
      conditions = [{ text: label, verify: verifyCmd }];
      // An ad-hoc verify alongside an active goal that HAS verifiable
      // conditions is a real ambiguity — the loop is about to report green on
      // something the goal never asked for. Name both and record the override
      // rather than silently picking one.
      const proj = await projections.project(repoRoot);
      const g = proj.goal || null;
      const goalVerifiable = g && g.status === 'active' ? (Array.isArray(g.success) ? g.success : []).filter((c) => c.verify) : [];
      if (goalVerifiable.length) {
        verifyOverride = true;
        console.error(`${ANSI.warn}warning${ANSI.reset}  --verify overrides the active goal "${g.objective}" and its ${goalVerifiable.length} verifiable condition(s); this loop observes the ad-hoc command only.`);
      }
    }

    // The read mode is resolved ONCE, at loop start. It is a property of the
    // checkout, and re-verifying the chain every iteration would make each
    // iteration cost O(spine); a checkout does not change sync mode mid-loop
    // except by operator action, and if it did the receipt voids harmlessly.
    const mode = typeof verifyLib?.resolveSpineMode === 'function'
      ? await verifyLib.resolveSpineMode(stateRoot) : 'unknown';
    const roots = { workRoot, stateRoot };
    const declSource = fromGoal ? 'goal' : 'flag';

    // ONE decl per condition, built once and REUSED by the baseline and every
    // iteration — identity must be byte-stable across them or the RED and the
    // GREEN land under different acceptanceIds and pair with nothing. The
    // ad-hoc scope nonce is the loopId, which only exists once `runLoop` has
    // minted it, so the decls are built on FIRST USE (the baseline, always
    // before iteration 1) and memoized from there. Every callback inside one
    // `runLoop` receives the same loopId, so the memo can never straddle two.
    let decls = null;
    const declsFor = (loopId) => {
      if (decls) return decls;
      decls = conditions.map((c) => ({
        command: c.verify,
        cwd: workRoot,
        declEventId: fromGoal ? declEventId : null,
        scopeNonce: fromGoal ? null : loopId,
        oraclePatterns,
        implPatterns,
        tierPolicy: 'worktree',
        schemaVersion: '1',
      }));
      return decls;
    };

    // SERIALIZED: the observation lock admits one observer per state root, so
    // running the set in parallel would turn its own siblings into lock-busy
    // voids instead of runs.
    const observeAll = async (phase, loopId) => {
      const out = [];
      for (const decl of declsFor(loopId)) {
        let res;
        try {
          res = await recorder.observeAcceptance(roots, decl, {
            declSource, phase, loopId, spineLib: spine, actor: sessionId, lane,
          }, { mode });
        } catch (err) {
          res = { ok: false, reason: (err && err.message) || 'observation error' };
        }
        out.push(res);
      }
      return out;
    };

    const classOf = (res) => (res && res.ok === true && res.ran ? res.ran.outcome_class : null);

    // Iteration 0: the RED recorded while the work is still untouched, before
    // any iterate can fix it. An all-green baseline does NOT skip the loop —
    // the operator asked for it — and its GREEN can still close a qualifying
    // earlier orient-recorded RED.
    const baseline = async ({ loopId }) => {
      const results = await observeAll('baseline', loopId);
      const red = results.filter((r) => classOf(r) === 'process-fail').length;
      const green = results.filter((r) => classOf(r) === 'process-pass').length;
      const other = results.length - red - green;
      console.log(`${ANSI.dim}baseline:${ANSI.reset}  ${red} red · ${green} green${other ? ` · ${other} not observed` : ''}  (${results.length} acceptance${results.length === 1 ? '' : 's'})`);
    };

    const verify = async (iter, { loopId }) => {
      const results = await observeAll('iteration', loopId);
      let ok = results.length > 0;
      // A signature is a claim that two iterations failed the SAME way. Any
      // observation that did not run (lock-busy, a refusal) or whose output was
      // truncated past the fingerprint cap makes that claim unsupportable, so
      // the whole signature goes null and stuck detection stands down for this
      // iteration rather than halting on a shared prefix or a synthesized error
      // string. `res.ok !== true` is normalized BEFORE any property access —
      // a no-run carries no `ran` at all.
      let fingerprintable = true;
      const parts = [];
      for (const res of results) {
        if (!res || res.ok !== true) { ok = false; fingerprintable = false; continue; }
        const ran = res.ran || {};
        if (ran.outcome_class !== 'process-pass') ok = false;
        if (ran.fingerprint == null) fingerprintable = false;
        else parts.push(`${(res.receipt && res.receipt.acceptanceId) || ''}:${ran.exit}:${ran.fingerprint}`);
      }
      const failed = results.filter((r) => classOf(r) !== 'process-pass').length;
      return {
        ok,
        // Order-stable by construction: `parts` follows the fixed decl order.
        signature: fingerprintable ? parts.join('|') : null,
        summary: ok ? `acceptance green (${results.length})` : `${failed}/${results.length} acceptance(s) not green`,
      };
    };

    const iterate = iterateCmd ? async (iter) => {
      // WORK root, like the observed verify: in an attached worktree an
      // iterate editing the primary while verify observes the worktree could
      // never converge.
      const r = await runShell(iterateCmd, workRoot);
      return { summary: `iterate exit=${r.code}` };
    } : null;

    console.log(`${ANSI.bold}loop:ralph${ANSI.reset}  goal: ${label}`);
    const res = await loopsLib.runLoop(repoRoot, {
      kind: 'ralph',
      goal: label, verify, iterate, baseline,
      startedData: { baselineRequested: true, verifySource: declSource, verifyOverride },
      maxIter,
      by: sessionId, lane,
      triggered_by: null,
    });
    if (res.baselineError) {
      console.error(`${ANSI.warn}baseline observation failed${ANSI.reset}  ${res.baselineError} — the loop ran anyway; its first RED may be missing.`);
    }
    reportLoop(res);
  }

  if (sub === 'status') {
    const { spine } = await loadSpineLib();
    const all = await spine.readAll(repoRoot);
    const loopEvents = all.filter((e) => /^LOOP_/.test(e.type));
    if (loopEvents.length === 0) { console.log('(no loop activity)'); return; }
    // Which loops genuinely exist — order-independent, so clock skew across
    // replicas cannot hide a loop whose start sorts after its own halt.
    // Hydrate each row from its OWN LOOP_STARTED, never from whichever event
    // merged first: a cancel from a clock-behind replica sorting ahead of the
    // start would otherwise build the row from the halt, leaving `kind` null —
    // which then threw on `l.kind.padEnd()` below.
    const byId = {};
    for (const e of loopEvents) {
      if (e.type !== 'LOOP_STARTED' || !e.data?.loopId) continue;
      byId[e.data.loopId] = {
        loopId: e.data.loopId, kind: e.data.kind || null, started: e.ts,
        iters: 0, status: 'open', goal: e.data.goal || null,
      };
    }
    for (const ev of loopEvents) {
      const id = ev.data?.loopId;
      if (!id) continue;
      // Anchor on the EXISTENCE of a start (the rows above), not on ordering:
      // an orphaned halt must not conjure a loop that was never started, but
      // discarding events that merely sort before the start would drop a
      // legitimate halt whose start lives in a clock-skewed replica.
      if (!byId[id]) continue;
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
      console.log(`  ${l.loopId}  ${String(l.kind || '—').padEnd(10)} ${c}${l.status}${ANSI.reset}  iters=${l.iters}  ${ANSI.dim}${l.goal || ''}${ANSI.reset}`);
      if (l.reason) console.log(`    ${ANSI.dim}reason: ${l.reason}${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'cancel') {
    const loopId = rest[0];
    if (!loopId) { console.error('usage: maddu loop cancel <loop-id>'); process.exit(2); }
    const { spine } = await loadSpineLib();
    // Referential guard (v1.124.0). `loopId` is typed by the operator and was
    // appended unvalidated, so `loop cancel lop_typo` printed `cancelled` and
    // exited 0. Worse than a no-op: the loop readers anchored on ANY LOOP_*
    // event, so the orphaned halt CONJURED a phantom halted loop into
    // `loop status` and the cockpit — a loop that never existed, reported as
    // cancelled. The loop's existence is established by LOOP_STARTED.
    {
      const all = await spine.readAll(repoRoot);
      const live = all.filter((e) => e.data?.loopId === loopId);
      if (!live.some((e) => e.type === 'LOOP_STARTED')) {
        console.error(`loop ${loopId} not found`);
        process.exit(3);
      }
      const terminal = live.find((e) => e.type === 'LOOP_HALTED' || e.type === 'LOOP_COMPLETED');
      if (terminal) {
        console.error(`loop ${loopId} is already ${terminal.type === 'LOOP_HALTED' ? 'halted' : 'completed'}`);
        process.exit(3);
      }
    }
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
