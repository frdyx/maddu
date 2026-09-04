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
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

let BASE = null, PRISTINE = null;

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
