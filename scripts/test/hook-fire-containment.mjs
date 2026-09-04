#!/usr/bin/env node
// hook-fire-containment — `maddu hooks fire` may never fail the tool call,
// including when the fire-core it delegates to throws.
//
// WHY THIS EXISTS
// A measured defect, not fixed when this was written. commands/hooks.mjs wraps
// LOADING the fire core in a try and guards its SHAPE (`typeof core?.fire !==
// 'function'`), then calls it OUTSIDE that containment. A core whose factory
// returns `{ fire() { throw } }` passes the shape check and throws at the call,
// so `maddu hooks fire` exits 1 with a raw stack — and a `hooks fire` that
// exits non-zero fails the user's tool call, which is the single thing that
// path exists to prevent. Measured on a real install, exit 1 with
// `Error: fixture: the core threw` on stderr, for every event.
//
// SYNC AND ASYNC ARE DIFFERENT PATHS OUT, and both are covered below. The call
// site is `return core.fire(event)`: a synchronous throw unwinds through
// `hooks()`, while a rejection travels as a returned promise and surfaces at
// whatever finally awaits it. The synchronous case is the obvious one; the
// asynchronous case is the one that will actually happen, because every arm of
// a real core awaits something (a spine append, a lane claim, a settings read)
// and any of those can reject. A containment that catches only the first is
// half a fix, so the suite runs the full event matrix twice.
//
// WHY IT IS A SEPARATE FILE FROM harness-hook-core.mjs
// That suite is the behavior LOCK for the fire-core extraction, and
// scripts/check-fire-core-extracted.mjs uses its green as claim 3 of the PR2
// success condition. A red assertion added there would flip the oracle to NOT
// DONE and take pr2-check-discriminates.mjs with it — reporting a shipped,
// correct refactor as unstarted. The lock says what Claude Code sees TODAY;
// this file says what it must see once the containment is closed. They are
// different claims and they belong in different files.
//
// WHAT IS ASSERTED — outcomes only
// The exit code of the installed CLI, its stdout as Claude Code parses it, and
// whether a stack trace reaches either stream. No internal function name and no
// try-block shape: a fixer may move the call inside the existing try, wrap it,
// install a handler, or restructure the arm entirely.
//
// NOTE FOR WHOEVER FIXES THIS: exit 0 alone will not satisfy the suite. `hooks`
// is a MUTATING-tier verb, so an invocation that exits without recording spools
// a mutation-witness breach and bin/maddu.mjs rewrites the code back to 1 — the
// very non-zero exit this path exists to prevent. The contained arm has to
// declare its no-op the way the sibling core-unavailable arm already does. That
// is not an extra requirement invented here; it is why the assertion is on the
// exit code the harness sees rather than on the catch.
//
// THE FAULT INJECTION
// Each case replaces the INSTALLED runtime's harness/fire-core.mjs with a
// stand-in module. That is the real seam — commands/hooks.mjs resolves the core
// through the repo's own maddu/runtime/lib/, the same way a half-applied
// upgrade or a bad release would hand it a broken one. No source is patched and
// no env switch is used, so nothing here can be satisfied by a test-only path.
//
// ANTI-VACUITY, FIRST
//   • the healthy install is shown firing, answering, and discriminating
//     (silent on a read, advisory on an edit) before any degraded case is read
//     as evidence of anything.
//   • the stand-in is PROVEN to be the module actually loaded: a factory
//     returning the wrong shape produces the documented degradation notice on
//     SessionStart, which only the replaced module can cause. Without that, a
//     stand-in that was never consulted would make every case below pass for
//     the wrong reason — the inert-fixture trap.
//   • the two EXISTING containments — a factory that throws, and a factory that
//     returns the wrong shape — are shown GREEN. So a red on the throwing-fire
//     cases is the uncontained call, not the swap.
//   • the boundary runs the other way too: containment must not become
//     "swallow everything". A healthy core is shown still doing its work, so a
//     fix that silences the arm entirely fails here rather than passing.
//
// WINDOWS
// No probe code goes through a shell; the CLI is spawned with an argv array and
// stdin is fed as a string, so backslashes in fixture paths survive.
//
// ROUND 3 (the sections marked R3-*)
// Four further escapes in the same seam, added by a suite author who is not the
// implementer, and each reproduced on a real install before being written down:
//   R3-B1  the floor rewrites a core's non-zero exit to 0 AFTER the witness has
//          already declined to judge it (evaluateWitness breaches only at exit
//          0), so the invocation reports success having recorded nothing, and
//          the floor's own "see `maddu doctor`" points at no evidence.
//   R3-B2  the mutation-breach drain exits 1 on an unreadable spool row BEFORE
//          the witness context exists, so the floor cannot apply and one corrupt
//          file fails the next tool call without the core being loaded at all.
//   R3-B3  the deny-then-EXIT twin of M5d. The buffer that discards a refusal on
//          a throw is flushed by an unconditional exit handler, so the crashed
//          core's deny is emitted while the code is clamped to 0.
//   R3-M1  the floor exists only when mutation-witness.mjs loads AND a tier
//          context arms, i.e. never on the half-applied installs it exists for.
//
// HONESTY ABOUT WHAT DISCRIMINATES. Not every line below separates the fixed
// tree from the broken one, and the ones that do not are labelled `control:`,
// `fixture:` or `boundary:` rather than counted as coverage. Specifically: on
// the pre-fix tree the throw/rejection paths already had empty parseable stdout
// and already emitted no deny, so those M5 rows were green before and after —
// they pin behaviour, they do not measure a fix. The rows that carry R3 are the
// record assertions (R3-B1), the exit code under a corrupt spool row (R3-B2),
// the verdict of the exit twin (R3-B3), and the exit code on a partial install
// (R3-M1). Each has a control beside it proving its channel has both states.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticEnv } from './_hermetic-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_BIN = join(ROOT, 'bin', 'maddu.mjs');
const CORE = join('maddu', 'runtime', 'lib', 'harness', 'fire-core.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
  return cond;
}
const note = (text) => console.log(`        ${text}`);

// ── the stand-in cores ───────────────────────────────────────────────────────
// Each is a complete, loadable module. They differ only in what the factory
// hands back, which is exactly the cross-file contract commands/hooks.mjs
// guards — and, for the last two, fails to guard past the shape check.
const CORES = {
  wrongShape: 'export function createHookFireCore() { return {}; }\n',
  factoryThrows: 'export function createHookFireCore() { throw new Error("fixture: the factory threw"); }\n',
  fireThrows: 'export function createHookFireCore() { return { fire() { throw new Error("fixture: the core threw"); } }; }\n',
  fireRejects: 'export function createHookFireCore() { return { async fire() { throw new Error("fixture: the core rejected"); } }; }\n',

  // Returns normally instead of ending the process. The shipped core's handlers
  // all exit, so this arm is reached only by a core that is wrong — which is
  // exactly when the fallthrough has to be right. It is also the shape a future
  // adapter reaches innocently, by returning a value rather than exiting, and a
  // fallthrough that records nothing is a mutation-witness breach that gets
  // rewritten to exit 1.
  fireReturns: 'export function createHookFireCore() { return { fire() { return; } }; }\n',

  // Ends the process itself, with a code of its own choosing. Not a throw, so
  // no catch anywhere in hooks.mjs can see it — see the note on this case in
  // the section below, which is where the interesting argument lives.
  fireExits: 'export function createHookFireCore() { return { fire() { process.exit(7); } }; }\n',

  // The SAME silence, exiting 0 instead of 7. It is the anti-vacuity twin of
  // fireExits: identical in everything the witness law cares about — mutating
  // verb, zero appends, no declared excuse — and different only in the code the
  // core chose. Today one of them is recorded as a breach and the other is not,
  // which is the whole of R3-B1 in two lines of fixture.
  fireExitsZero: 'export function createHookFireCore() { return { fire() { process.exit(0); } }; }\n',

  // Decides, then ends the process — the exit-shaped twin of denyThenThrow. The
  // buffer that discards the deny on a throw is flushed by an unconditional
  // `process.on("exit")`, so this one gets released while the floor rewrites
  // the code to 0: Claude Code reads exit 0 plus a refusal and blocks the edit.
  denyThenExit: [
    'const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",',
    '  permissionDecision: "deny", permissionDecisionReason: "fixture: a broken core denied" } });',
    'export function createHookFireCore() {',
    '  return {',
    '    fire() {',
    '      process.stdout.write(DENY);',
    '      process.exit(7);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n'),

  // The dangerous one: it DECIDES before it fails. A deny is already on stdout
  // when the throw happens, so containment arrives too late to prevent the
  // refusal — it can only choose what to do about the second document.
  denyThenThrow: [
    'const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",',
    '  permissionDecision: "deny", permissionDecisionReason: "fixture: a broken core denied" } });',
    'export function createHookFireCore() {',
    '  return {',
    '    fire() {',
    '      process.stdout.write(DENY);',
    '      throw new Error("fixture: threw after writing to stdout");',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n'),
};

// ── the verdict reader ───────────────────────────────────────────────────────
// Three outcomes are meaningfully different to Claude Code: nothing at all,
// advisory context, and a refusal. `unparseable` is the fourth and is always a
// defect — Claude Code parses this stdout.
function verdictOf(stdout) {
  const s = (stdout || '').trim();
  if (!s) return 'silent';
  let j;
  try { j = JSON.parse(s); } catch { return 'unparseable'; }
  const h = j.hookSpecificOutput || {};
  if (h.permissionDecision === 'deny') return 'deny';
  if (typeof h.additionalContext === 'string' && h.additionalContext) return 'nudge';
  return 'other';
}

// A raw stack trace reaching the harness is a hook reporting its own crash into
// somebody else's transcript. Matched on frame lines, not on the word "Error",
// so a deliberate one-line diagnosis still passes.
const hasStackTrace = (text) => /^\s+at\s+\S+/m.test(text || '');
const firstFrame = (text) => ((text || '').split('\n').find((l) => /^\s+at\s/.test(l)) || '').trim().slice(0, 60);

// ── the record channel ───────────────────────────────────────────────────────
// What an install can still SHOW about an invocation after it has ended. Two
// places carry it, and a fix may use either: the breach spool
// (.maddu/state/mutation-breaches/, written synchronously at exit) or the spine
// itself once a later run has drained that spool. Read both, so an assertion
// about "was this recorded" never depends on which stage the evidence sits in.
async function breachSpool(dir) {
  try { return (await readdir(join(dir, '.maddu', 'state', 'mutation-breaches'))).sort(); }
  catch { return []; }
}
async function spineLines(dir) {
  const out = [];
  let names = [];
  try { names = await readdir(join(dir, '.maddu', 'events')); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.ndjson')) continue;
    try {
      for (const line of (await readFile(join(dir, '.maddu', 'events', n), 'utf8')).split('\n')) {
        if (line.trim()) out.push(line);
      }
    } catch {}
  }
  return out;
}
// Is there a durable, machine-readable record that this install had an
// invocation which reported success while recording nothing? Spool row or spine
// event — either is an honest answer, and neither names a mechanism.
async function unwitnessedRecorded(dir) {
  const spool = (await breachSpool(dir)).filter((n) => !n.endsWith('.drained'));
  if (spool.length) return { yes: true, where: `spool ${spool.join(',')}` };
  const hit = (await spineLines(dir)).filter((l) => l.includes('MUTATION_UNWITNESSED'));
  if (hit.length) return { yes: true, where: `spine ${hit.length} event(s)` };
  return { yes: false, where: 'nothing on either channel' };
}

let BASE = null, PRISTINE = null;

// The installed CLI, any verb. `fire` below is the hook-shaped special case;
// this is for the boundary that says a failed drain must still block a NON-hook
// mutating verb — the behaviour a fix to that path must not delete.
function run(installDir, args, input) {
  const bin = join(installDir, 'maddu', 'bin', 'maddu.mjs');
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: installDir, encoding: 'utf8', env: hermeticEnv(),
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function fire(installDir, event, payload) {
  const bin = join(installDir, 'maddu', 'bin', 'maddu.mjs');
  const r = spawnSync(process.execPath, [bin, 'hooks', 'fire', event], {
    cwd: installDir, encoding: 'utf8', env: hermeticEnv(),
    input: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const SID = 'fire-containment-uuid-1';
const EVENTS = ['session-start', 'session-end', 'pre-compact', 'pre-tool-use'];
const payloads = (dir) => ({
  'session-start': { session_id: SID, cwd: dir },
  'session-end': { session_id: SID, cwd: dir },
  'pre-compact': { session_id: SID, cwd: dir, trigger: 'auto' },
  'pre-tool-use': { session_id: SID, cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'README.md') } },
});

// A fresh copy per case. Deliberate: `hooks` is a mutating-tier verb, so a run
// that exits without recording spools a mutation-witness breach which the NEXT
// mutating invocation in that repo has to drain. Sharing one install between
// cases would let an earlier case's residue decide a later one's exit code —
// the whole thing this suite measures.
async function installWith(name, core) {
  const dir = join(BASE, name);
  await cp(PRISTINE, dir, { recursive: true });
  if (core) await writeFile(join(dir, CORE), core);
  return dir;
}

async function main() {
  BASE = await mkdtemp(join(tmpdir(), 'maddu-fire-containment-'));
  try {
    PRISTINE = join(BASE, 'pristine');
    await mkdir(PRISTINE, { recursive: true });
    spawnSync('git', ['init', '-q', PRISTINE], { encoding: 'utf8' });
    spawnSync('git', ['-C', PRISTINE, 'config', 'user.email', 't@t.t'], { encoding: 'utf8' });
    spawnSync('git', ['-C', PRISTINE, 'config', 'user.name', 't'], { encoding: 'utf8' });
    await writeFile(join(PRISTINE, 'README.md'), 'x\n');
    spawnSync('git', ['-C', PRISTINE, 'add', '-A'], { encoding: 'utf8' });
    spawnSync('git', ['-C', PRISTINE, 'commit', '-qm', 'init'], { encoding: 'utf8' });
    const init = spawnSync(process.execPath, [SRC_BIN, 'init'], {
      cwd: PRISTINE, encoding: 'utf8', env: hermeticEnv(),
    });
    if (init.status !== 0) throw new Error(`fixture init failed: ${`${init.stdout}${init.stderr}`.slice(0, 400)}`);

    // ── control: the reader discriminates ───────────────────────────────────
    ok('control: the reader sees a deny',
      verdictOf('{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"x"}}') === 'deny');
    ok('control: the reader sees a nudge',
      verdictOf('{"hookSpecificOutput":{"additionalContext":"x"}}') === 'nudge');
    ok('control: the reader sees silence, and does not call garbage valid',
      verdictOf('') === 'silent' && verdictOf('not json{') === 'unparseable');

    // ── control: a healthy install fires, answers, and discriminates ─────────
    console.log('\n  controls - the healthy install, before any degraded one is read as evidence');
    {
      const dir = await installWith('healthy', null);
      const p = payloads(dir);
      for (const ev of EVENTS) {
        const r = fire(dir, ev, p[ev]);
        ok(`control: healthy ${ev} exits 0`, r.status === 0, `exit ${r.status}`);
        ok(`control: healthy ${ev} stdout is empty or parseable`,
          verdictOf(r.out) !== 'unparseable', r.out.slice(0, 50));
      }
      // ...and the containment must never become "swallow everything": a
      // working core is still seen doing its work, both ways.
      const edit = fire(dir, 'pre-tool-use', p['pre-tool-use']);
      ok('control: a healthy core still gates a mutating tool',
        verdictOf(edit.out) === 'nudge', verdictOf(edit.out));
      const read = fire(dir, 'pre-tool-use', {
        session_id: SID, cwd: dir, tool_name: 'Read', tool_input: { file_path: join(dir, 'README.md') },
      });
      ok('control: and leaves a non-mutating tool alone',
        verdictOf(read.out) === 'silent', verdictOf(read.out));
    }

    // ── control: the fault injection reaches the code under test ────────────
    // Everything below depends on the stand-in being the module hooks.mjs
    // actually loads. A wrong-shape factory produces the documented degradation
    // notice on SessionStart, which nothing else in the install can cause — so
    // this is direct evidence the swap took effect, not an assumption.
    console.log('\n  controls - the stand-in IS the module loaded, and the EXISTING containments hold');
    {
      const dir = await installWith('wrong-shape', CORES.wrongShape);
      const p = payloads(dir);
      const r = fire(dir, 'session-start', p['session-start']);
      note(`wrong-shape session-start: exit ${r.status}, stdout ${r.out.slice(0, 90)}`);
      ok('control: the replaced core is the one hooks.mjs loads',
        /did not start/i.test(r.out), r.out.slice(0, 90) || '(silence)');
      ok('control: a wrong-shape core is already contained - exit 0',
        r.status === 0, `exit ${r.status}`);
      ok('control: and it does not fail the tool call',
        fire(dir, 'pre-tool-use', p['pre-tool-use']).status === 0);
    }
    {
      const dir = await installWith('factory-throws', CORES.factoryThrows);
      const p = payloads(dir);
      const r = fire(dir, 'session-start', p['session-start']);
      ok('control: a factory that THROWS is already contained - exit 0',
        r.status === 0, `exit ${r.status} / ${r.err.split('\n')[0]?.slice(0, 50) || ''}`);
      ok('control: and it does not fail the tool call',
        fire(dir, 'pre-tool-use', p['pre-tool-use']).status === 0);
    }

    // ── M5: the call itself must be contained ───────────────────────────────
    // Same shape as the two controls above, one fact different: the throw
    // happens at the CALL rather than at the load. If that changes the exit
    // code, the containment stops at the wrong line.
    //
    // The two rows are not a duplicate of each other. `return core.fire(event)`
    // hands back whatever fire() returns, so a synchronous throw and a rejected
    // promise leave the function by different routes and can be fixed one
    // without the other.
    for (const [label, core, blurb] of [
      ['sync', CORES.fireThrows, 'a core whose fire() throws synchronously'],
      ['async', CORES.fireRejects, 'a core whose fire() returns a rejected promise'],
    ]) {
      console.log(`\n  M5 (${label}) - ${blurb} must not fail the tool call`);
      const dir = await installWith(`fire-${label}`, core);
      const p = payloads(dir);
      for (const ev of EVENTS) {
        const r = fire(dir, ev, p[ev]);
        ok(`M5 (${label}): ${ev} exits 0`, r.status === 0,
          `exit ${r.status}${r.err ? ` / ${r.err.split('\n')[0].slice(0, 50)}` : ''}`);
        ok(`M5 (${label}): ${ev} never prints a stack trace`,
          !hasStackTrace(r.err) && !hasStackTrace(r.out), firstFrame(`${r.err}\n${r.out}`));
        ok(`M5 (${label}): ${ev} stdout stays empty or parseable`,
          verdictOf(r.out) !== 'unparseable', r.out.slice(0, 50));
      }
      // The sharpest one: a broken core must not turn into a refusal. A hook
      // that denies because its own machinery failed is worse than one that
      // says nothing.
      const t = fire(dir, 'pre-tool-use', p['pre-tool-use']);
      ok(`M5 (${label}): a broken core never denies the tool call`,
        verdictOf(t.out) !== 'deny', verdictOf(t.out));
    }

    // ── M5b: a core that RETURNS instead of exiting ─────────────────────────
    // The shipped core's handlers all end the process, so nothing downstream of
    // the call ever runs today. That makes the fallthrough the least-exercised
    // line on the path — and it is not inert, because `hooks` is a
    // mutating-tier verb: falling out of the call having recorded nothing is a
    // mutation-witness breach, which bin/maddu.mjs rewrites to exit 1. A hook
    // that fails the tool call because its core returned politely is the same
    // defect as one that fails because its core threw.
    {
      console.log('\n  M5b - a core that returns normally must still not fail the tool call');
      const dir = await installWith('fire-returns', CORES.fireReturns);
      const p = payloads(dir);
      for (const ev of EVENTS) {
        const r = fire(dir, ev, p[ev]);
        ok(`M5b: ${ev} exits 0 when the core returns instead of exiting`,
          r.status === 0, `exit ${r.status}${r.err ? ` / ${r.err.split('\n')[0].slice(0, 50)}` : ''}`);
        ok(`M5b: ${ev} stdout stays empty or parseable`,
          verdictOf(r.out) !== 'unparseable', r.out.slice(0, 50));
      }
    }

    // ── M5c: a core that ends the process itself ────────────────────────────
    // `process.exit(7)` inside fire() is not a throw, so no catch in hooks.mjs
    // can see it. It was proposed as an ASSERTED KNOWN LIMIT. It is not one.
    //
    // MEASURED, not assumed: a `process.on('exit')` listener that assigns
    // `process.exitCode = 0` overrides an explicit `process.exit(7)` — the
    // listener observes code 7 and the process still terminates 0. That is not
    // a theoretical mechanism for this CLI either: bin/maddu.mjs ALREADY
    // registers such a listener and already rewrites the code through it (the
    // mutation-witness breach path). The capability is installed; only the
    // decision to use it here is missing.
    //
    // So this asserts the correct outcome. If it is ever deliberately accepted
    // as a limit instead, this assertion is where that decision gets made,
    // visibly, rather than by the case never having been written down.
    {
      console.log('\n  M5c - a core that exits the process itself must not carry its code out');
      const dir = await installWith('fire-exits', CORES.fireExits);
      const p = payloads(dir);
      for (const ev of ['session-start', 'pre-tool-use']) {
        const r = fire(dir, ev, p[ev]);
        ok(`M5c: ${ev} exits 0 even though the core called process.exit(7)`,
          r.status === 0, `exit ${r.status}`);
      }
    }

    // ── M5d: a core that DECIDES, then fails ────────────────────────────────
    // The only case where containment cannot undo the damage. The core writes a
    // deny and then throws, so the refusal is already through the pipe before
    // anything catches. What is still decidable is the SECOND document: append
    // the arm's own advisory and stdout holds two JSON values, which is not
    // parseable; suppress it and the deny stands alone.
    //
    // The control below proves the single-document assertion can fail, so it is
    // measuring the output and not the reader's good manners.
    {
      console.log('\n  M5d - a core that writes a verdict and then throws');
      ok('control: two concatenated documents ARE unparseable, so the check below can fail',
        verdictOf('{"hookSpecificOutput":{"additionalContext":"a"}}{"hookSpecificOutput":{"additionalContext":"b"}}') === 'unparseable');

      const dir = await installWith('deny-then-throw', CORES.denyThenThrow);
      const r = fire(dir, 'pre-tool-use', payloads(dir)['pre-tool-use']);
      note(`deny-then-throw: exit ${r.status}, verdict ${verdictOf(r.out)}, stdout ${r.out.slice(0, 100)}`);

      ok('M5d: the throw after the write is still contained - exit 0',
        r.status === 0, `exit ${r.status}`);
      ok('M5d: stdout carries at most ONE document, never a second appended after it',
        verdictOf(r.out) !== 'unparseable', verdictOf(r.out));
      ok('M5d: and never prints a stack trace',
        !hasStackTrace(r.err) && !hasStackTrace(r.out), firstFrame(`${r.err}\n${r.out}`));

      // THE RESIDUAL, asserted rather than described. Suppressing the second
      // document is strictly better than emitting it, but it leaves a refusal
      // standing that was produced by a core which did not finish — the hook
      // failing the user's tool call, which is the one thing this whole path
      // exists to prevent. Buffering the core's stdout and discarding it when
      // the call throws closes it; flushing on the intentional-exit path keeps
      // a legitimate verdict. Until then this is red, and being red is how the
      // gap stays visible instead of becoming folklore.
      ok('M5d: a core that failed does not leave a refusal standing',
        verdictOf(r.out) !== 'deny', verdictOf(r.out));
    }

    // ══ ROUND 3 ═════════════════════════════════════════════════════════════
    // Four measured escapes, each reproduced on a real install before it was
    // written here, all in the same seam from different sides: the floor that
    // stops `hooks fire` failing a tool call does more than it says (it converts
    // a crash into a success the witness then declines to judge) and less (it
    // does not exist at all on the installs it was built to tolerate).

    // ── R3-B1: a crash the floor rewrites to 0 must still leave a record ────
    // evaluateWitness takes `exitCode` and returns no breach unless it is 0.
    // The floor then sets the code to 0 AFTER that verdict. So a core that ends
    // the process itself exits successfully having appended nothing, declared
    // nothing, and recorded nothing — and the floor's own stderr line sends the
    // operator to `maddu doctor`, which has nothing to show them. The repo's
    // rule since v1.129.0 is that a command Máddu names is a command Máddu has;
    // a diagnostic Máddu names must likewise have something to diagnose.
    //
    // WHAT IS ASSERTED is durable evidence on either channel — the spool now, or
    // the spine after a later drain. Not a call site, not an argument order. A
    // fixer may judge the witness on the code the world sees, spool from the
    // floor itself, or record it some third way.
    {
      console.log('\n  R3-B1 - a crash the floor rewrites to 0 must still leave a record');
      // ANTI-VACUITY on the exact channel the claim uses, both directions.
      // (a) it speaks: an identically silent core that exits 0 IS recorded
      //     today. The two cores differ in nothing the witness law cares about
      //     — mutating verb, zero appends, no declared excuse — only in the
      //     number they passed to process.exit.
      const zero = await installWith('fire-exits-zero', CORES.fireExitsZero);
      const rz = fire(zero, 'pre-tool-use', payloads(zero)['pre-tool-use']);
      const recZero = await unwitnessedRecorded(zero);
      note(`exit(0) core: exit ${rz.status}, record: ${recZero.where}`);
      ok('control: a silent core that exits 0 IS recorded as unwitnessed',
        recZero.yes, recZero.where);
      // (b) it is not stuck on: a healthy install records no breach, so "a
      //     record exists" is a fact about the run and not about the channel.
      const clean = await installWith('record-channel-clean', null);
      fire(clean, 'pre-tool-use', payloads(clean)['pre-tool-use']);
      const recClean = await unwitnessedRecorded(clean);
      ok('control: a healthy install fires without recording a breach',
        !recClean.yes, recClean.where);

      for (const ev of ['pre-tool-use', 'session-start']) {
        const dir = await installWith(`fire-exits-record-${ev}`, CORES.fireExits);
        const before = (await spineLines(dir)).length;
        const r = fire(dir, ev, payloads(dir)[ev]);
        const after = (await spineLines(dir)).length;
        const rec = await unwitnessedRecorded(dir);
        note(`exit(7) core on ${ev}: exit ${r.status}, spine ${before} -> ${after}, record: ${rec.where}`);
        ok(`R3-B1 fixture (${ev}): the run really did record nothing`,
          after === before, `spine ${before} -> ${after}`);
        ok(`R3-B1 (${ev}): the floor still keeps the tool call alive`,
          r.status === 0, `exit ${r.status}`);
        ok(`R3-B1 (${ev}): and the success it manufactured is recorded somewhere`,
          rec.yes, rec.where);
      }
    }

    // ── R3-B2: an unreadable breach row must not fail the tool call ─────────
    // The drain runs BEFORE the witness context is armed, and exits 1 on a
    // failed row for any mutating verb. `hooks fire` is a mutating verb, and at
    // that point there is no ctx, so the exit handler returns early and the
    // floor cannot apply. A single corrupt file under .maddu/state/
    // mutation-breaches/ therefore fails the next tool call outright — the one
    // outcome this whole path exists to prevent, reached without the hook core
    // ever being loaded.
    {
      console.log('\n  R3-B2 - a corrupt spool row must not take the host down with it');
      const dir = await installWith('drain-blocks-hook', null);
      const p = payloads(dir);
      ok('R3-B2 fixture: the install fires cleanly before the row is planted',
        fire(dir, 'pre-tool-use', p['pre-tool-use']).status === 0);
      const spoolDir = join(dir, '.maddu', 'state', 'mutation-breaches');
      await mkdir(spoolDir, { recursive: true });
      await writeFile(join(spoolDir, 'r3b2.json'), '{ this row is not json\n');
      ok('R3-B2 fixture: the row is on disk and cannot be parsed',
        (await breachSpool(dir)).includes('r3b2.json'));

      // ONE SHOT, deliberately. The drain quarantines the row on its first
      // attempt, so a second identical invocation passes for a reason that has
      // nothing to do with any fix. Every assertion below reads this one run.
      const r = fire(dir, 'pre-tool-use', p['pre-tool-use']);
      note(`with a corrupt row present: exit ${r.status} / ${r.err.split('\n')[0]?.slice(0, 90) || ''}`);
      ok('R3-B2: a hook fire over a corrupt spool row does not fail the tool call',
        r.status === 0, `exit ${r.status}`);
      ok('R3-B2: and does not print a stack trace at the operator',
        !hasStackTrace(r.err) && !hasStackTrace(r.out), firstFrame(`${r.err}\n${r.out}`));
      ok('R3-B2: stdout stays empty or parseable',
        verdictOf(r.out) !== 'unparseable', r.out.slice(0, 50));
      // The evidence must survive the fix. "Never fail the tool call" must not
      // be bought by deleting the row nobody could read — it is the only trace
      // of a breach, and the census gate exists to keep reporting it.
      const kept = await breachSpool(dir);
      ok('R3-B2 boundary: the unreadable row is retained, not quietly discarded',
        kept.length > 0, kept.join(',') || '(spool empty)');

      // ...and a failed drain must STILL block a mutating non-hook verb. That
      // is the designed behaviour ("spool retained; resolve before mutating"),
      // and a fix that simply stops blocking would satisfy everything above
      // while deleting it.
      const ctl = await installWith('drain-blocks-mutating', null);
      const ctlSpool = join(ctl, '.maddu', 'state', 'mutation-breaches');
      await mkdir(ctlSpool, { recursive: true });
      await writeFile(join(ctlSpool, 'r3b2.json'), '{ this row is not json\n');
      const reg = run(ctl, ['register']);
      note(`register over a corrupt row: exit ${reg.status} / ${reg.err.split('\n')[0]?.slice(0, 90) || ''}`);
      ok('R3-B2 boundary: a corrupt row still blocks a mutating non-hook verb',
        reg.status !== 0 && /mutation-breach drain failed/.test(reg.err), `exit ${reg.status}`);
    }

    // ── R3-B3: the deny-then-EXIT twin of M5d ───────────────────────────────
    // M5d's core writes a deny and THROWS, and the catch empties the buffer, so
    // the refusal is dropped. This core writes the same deny and EXITS, which no
    // catch can see — the buffer is flushed by an unconditional `exit` handler
    // while the floor rewrites the code to 0. Claude Code reads exit 0 plus a
    // refusal and blocks the edit. Two equivalent crashes, opposite outcomes, on
    // a path whose every documented posture is fail-open.
    {
      console.log('\n  R3-B3 - a core that denies and then exits must not leave the refusal standing');
      // The twin, run beside it, so the red below is about HOW the core stopped
      // rather than about denies in general.
      const thrown = await installWith('r3-deny-throw', CORES.denyThenThrow);
      const rt = fire(thrown, 'pre-tool-use', payloads(thrown)['pre-tool-use']);
      ok('control: the THROW twin already discards the refusal',
        verdictOf(rt.out) !== 'deny', verdictOf(rt.out));

      const dir = await installWith('r3-deny-exit', CORES.denyThenExit);
      const r = fire(dir, 'pre-tool-use', payloads(dir)['pre-tool-use']);
      note(`deny-then-exit: exit ${r.status}, verdict ${verdictOf(r.out)}, stdout ${r.out.slice(0, 100)}`);
      ok('R3-B3: the exit after the write is still contained - exit 0',
        r.status === 0, `exit ${r.status}`);
      ok('R3-B3: stdout carries at most ONE document',
        verdictOf(r.out) !== 'unparseable', verdictOf(r.out));
      ok('R3-B3: a core that failed does not leave a refusal standing',
        verdictOf(r.out) !== 'deny', verdictOf(r.out));
    }

    // ── R3-M1: the floor must exist where it is needed most ────────────────
    // prepareMutationWitness registers the exit handler that carries the floor
    // ONLY if mutation-witness.mjs loads, and the handler returns early unless a
    // tier context armed — which needs commands/_tiers.mjs. Both are exactly
    // what a half-applied upgrade or a version-skewed install is missing. So the
    // containment is absent in precisely the corruption states it exists to
    // tolerate, and a core's process.exit escapes unclamped.
    {
      console.log('\n  R3-M1 - containment must not depend on the optional libs a broken install is missing');
      for (const [label, victim] of [
        ['mutation-witness', join('maddu', 'runtime', 'lib', 'mutation-witness.mjs')],
        ['_tiers', join('maddu', 'commands', '_tiers.mjs')],
      ]) {
        // Liveness first: with the file gone, a HEALTHY core still fires and
        // still exits 0. So a red below is the missing floor rather than a
        // fixture that broke the install outright.
        const healthy = await installWith(`partial-${label}-healthy`, null);
        await rm(join(healthy, victim), { force: true });
        const h = fire(healthy, 'pre-tool-use', payloads(healthy)['pre-tool-use']);
        ok(`R3-M1 fixture (${label} absent): a healthy core still exits 0`,
          h.status === 0, `exit ${h.status}`);

        const dir = await installWith(`partial-${label}`, CORES.fireExits);
        await rm(join(dir, victim), { force: true });
        for (const ev of ['pre-tool-use', 'session-start']) {
          const r = fire(dir, ev, payloads(dir)[ev]);
          ok(`R3-M1 (${label} absent): ${ev} still exits 0 when the core exits 7`,
            r.status === 0, `exit ${r.status}`);
        }
      }
    }
  } finally {
    // Runs on every path out — assertion failure, harness throw (the `finally`
    // precedes main()'s catch), or success. The retries are the Windows hazard:
    // a node child that has just exited can still hold a handle inside the
    // fixture, and an un-retried rm would leave several throwaway installs
    // behind on the very runs most likely to fail.
    if (BASE) await rm(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }

  console.log(`\nhook-fire-containment: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('hook-fire-containment FAILED'); process.exit(1); }
  console.log('hook-fire-containment OK');
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
