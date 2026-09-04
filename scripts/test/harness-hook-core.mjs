#!/usr/bin/env node
// harness-hook-core — locks the Claude hook path's OBSERVABLE contract.
//
// WHY THIS EXISTS, AND WHY IT EXISTS *FIRST*
// Track A PR2 extracts the hook-firing core out of commands/hooks.mjs (1258
// lines) into template/maddu/runtime/lib/harness/ so the Codex, Hermes and
// OpenHands adapters can share it. The campaign calls that the highest-risk
// slice and isolates it precisely because it is refactor-only: nothing about
// what Claude Code sees may change.
//
// This suite is written BEFORE that refactor exists, by the supervisor rather
// than the implementer, against the behavior shipping today. That ordering is
// the point. A suite written after — or by the actor doing the extraction —
// can only describe what the new code happens to do; the goal's own constraint
// says the implementing actor never writes its own suite, because a maker who
// verifies their own work is the exact failure this framework is about.
//
// WHAT IT LOCKS — the surface Claude Code actually consumes, never internals:
//   • every `hooks fire` exits 0, always — the hook may never fail a tool call
//   • stdout is empty or strictly parseable JSON (Claude Code parses it)
//   • PreToolUse discriminates three ways: silent / nudge / deny
//   • containment holds: a throw at either seam, or malformed stdin, is silent
//   • SessionStart announces a well-formed minted session id
//   • SessionEnd is silent and idempotent
//
// Everything runs through `node bin/maddu.mjs hooks fire <event>` with canned
// stdin against a throwaway fixture repo. No internal import, no function name,
// no file path from inside hooks.mjs appears below — so the extraction is free
// to move any of it, and this suite still means the same thing afterwards.
//
// WHY THE INJECTED FAULT CASES ARE NOT HERE — see scripts/test/hook-fire-containment.mjs
// That suite fires the same events against a DELIBERATELY BROKEN core (one whose
// factory returns a `fire` that throws, or that rejects) to prove the CLI
// contains it. Those cases cannot live in this file, for two reasons.
//
// First, this suite's exit code is BORROWED: it is claim 3 of
// scripts/check-fire-core-extracted.mjs, which is in turn a success condition of
// the Track A goal. Anything red added here does not read as "a containment case
// is failing" — it reads as "the PR2 fire-core extraction was never done", about
// work that is shipped and correct. A suite whose verdict is reused as evidence
// that some OTHER work happened is frozen to present-tense claims until the
// borrowing stops. That is not special to behavior locks: five of the six Track A
// success conditions are suite exit codes, so the same freeze applies to
// harness-capabilities.mjs and harness-doctor.mjs, and will apply to the adapter
// suites the moment they are written.
//
// Second, this suite is deliberately MODULE-BLIND — the property quoted above,
// and the property that qualifies it as claim 3 at all. Fault injection is
// module-aware by construction: it must name the path it replaces. Putting a
// module-aware suite inside a module-blind lock destroys the thing that makes
// the lock usable as a goal term.
//
// What lives here is the CLAIM ("every `hooks fire` exits 0, always") tested on a
// healthy install. What lives there is the INJECTION.
//
// ANTI-VACUITY, FIRST
// A silence-based assertion is worthless if the harness cannot tell silence
// from an answer, and a containment assertion is worthless if the seam it
// relies on never fires. Both are proven before they are used: the verdict
// reader is shown to discriminate on synthetic input, and the throw seam is
// shown to be inert without its env guard — so "silent" under the seam is the
// containment working, not the case failing to run.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticEnv } from './_hermetic-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// The verdict reader. Three outcomes are meaningfully different to Claude Code:
// nothing at all, advisory context, and a refusal.
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

const exits = [];
function run(args, input, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: FIXTURE, encoding: 'utf8',
    input: input === undefined ? undefined : (typeof input === 'string' ? input : JSON.stringify(input)),
    // hermeticEnv scrubs host session identity (and the very seam vars this
    // suite sets) before the overrides are applied, so a fixture can never
    // inherit the developer's live session — or a stale MADDU_HOOK_TEST_THROW.
    env: hermeticEnv(env),
  });
  exits.push({ args: args.join(' '), status: r.status, err: r.stderr || '' });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const fire = (event, input, env) => run(['hooks', 'fire', event], input, env);

// Did the containment clamp a non-zero exit on its way out? `hooks fire` forces
// its own code to 0, so `status === 0` is true by construction and no longer
// separates "it worked" from "it failed and the floor hid it". The clamp says so
// on stderr — the same sentence from commands/hooks.mjs and bin/maddu.mjs — so
// the evidence did not disappear, it changed channel. Assertions below follow it.
const clamped = (err) => /would have exited/.test(err || '');

let FIXTURE = null;

async function main() {
  // ── controls on the reader itself, before it is trusted ───────────────────
  ok('control: reader sees a deny',
    verdictOf('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}') === 'deny');
  ok('control: reader sees a nudge',
    verdictOf('{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"}}') === 'nudge');
  ok('control: reader sees silence', verdictOf('') === 'silent' && verdictOf('   ') === 'silent');
  ok('control: reader does not call garbage valid', verdictOf('not json{') === 'unparseable');

  FIXTURE = await mkdtemp(join(tmpdir(), 'maddu-hookcore-'));
  try {
    spawnSync('git', ['init', '-q', FIXTURE]);
    spawnSync('git', ['-C', FIXTURE, 'config', 'user.email', 't@t.t']);
    spawnSync('git', ['-C', FIXTURE, 'config', 'user.name', 't']);
    await writeFile(join(FIXTURE, 'README.md'), 'x\n');
    spawnSync('git', ['-C', FIXTURE, 'add', '-A']);
    spawnSync('git', ['-C', FIXTURE, 'commit', '-qm', 'init']);
    const init = run(['init']);
    if (init.status !== 0) throw new Error(`fixture init failed: ${init.out.slice(0, 300)}`);

    const target = join(FIXTURE, 'README.md');
    const EDIT = { session_id: 'hookcore-uuid-1', cwd: FIXTURE, tool_name: 'Edit', tool_input: { file_path: target } };
    const READ = { session_id: 'hookcore-uuid-1', cwd: FIXTURE, tool_name: 'Read', tool_input: { file_path: target } };

    // ── PreToolUse discriminates three ways ─────────────────────────────────
    // Together these are the anti-vacuity core: a gate that always denied, or
    // always kept quiet, could not produce all three.
    const readV = fire('pre-tool-use', READ);
    ok('non-mutating tool is not gated', verdictOf(readV.out) === 'silent', verdictOf(readV.out));

    const editV = fire('pre-tool-use', EDIT);
    ok('mutating tool under standard governance is nudged, not blocked',
      verdictOf(editV.out) === 'nudge', verdictOf(editV.out));

    // ── containment: the hook may never fail a tool call ────────────────────
    // First prove the seam is INERT without its guard, so the silences below
    // are containment and not an env var that does nothing.
    const seamOff = fire('pre-tool-use', EDIT, { MADDU_HOOK_TEST_THROW: 'handler' });
    ok('control: the throw seam is inert without MADDU_SELF_TEST',
      verdictOf(seamOff.out) === 'nudge', verdictOf(seamOff.out));

    for (const stage of ['bootstrap', 'handler']) {
      const r = fire('pre-tool-use', EDIT, { MADDU_SELF_TEST: '1', MADDU_HOOK_TEST_THROW: stage });
      ok(`a throw at the ${stage} seam is contained (silent, exit 0)`,
        r.status === 0 && !clamped(r.err) && verdictOf(r.out) === 'silent',
        `exit ${r.status}${clamped(r.err) ? ' (clamped from non-zero)' : ''} / ${verdictOf(r.out)}`);
    }

    const malformed = fire('pre-tool-use', 'not json{');
    ok('malformed stdin is contained (silent, exit 0)',
      malformed.status === 0 && !clamped(malformed.err) && verdictOf(malformed.out) === 'silent',
      `exit ${malformed.status}${clamped(malformed.err) ? ' (clamped from non-zero)' : ''} / ${verdictOf(malformed.out)}`);

    // ── SessionStart announces a real, well-formed session ──────────────────
    const start = fire('session-start', { session_id: 'hookcore-uuid-1', cwd: FIXTURE });
    let startJson = null;
    try { startJson = JSON.parse(start.out); } catch {}
    ok('SessionStart names its own event', startJson?.hookSpecificOutput?.hookEventName === 'SessionStart');
    ok('SessionStart announces a well-formed minted session id',
      /\bses_\d{14}_[0-9a-f]{6}\b/.test(startJson?.hookSpecificOutput?.additionalContext || ''),
      (startJson?.hookSpecificOutput?.additionalContext || '').slice(0, 60));

    // ── SessionEnd is quiet and repeatable ──────────────────────────────────
    const end1 = fire('session-end', { session_id: 'hookcore-uuid-1', cwd: FIXTURE });
    const end2 = fire('session-end', { session_id: 'hookcore-uuid-1', cwd: FIXTURE });
    ok('SessionEnd is silent and idempotent',
      verdictOf(end1.out) === 'silent' && verdictOf(end2.out) === 'silent',
      `${verdictOf(end1.out)} / ${verdictOf(end2.out)}`);

    // ── the refusal path, reached the only way it can be ────────────────────
    // Strict governance turns the same stale ritual from advisory into a
    // refusal. Asserting BOTH sides is what makes the nudge assertion above
    // mean something: the difference is the gate, not the harness.
    const gov = run(['governance', 'set', 'strict']);
    ok('fixture can be moved to strict governance', gov.status === 0, `exit ${gov.status}`);

    const denied = fire('pre-tool-use', EDIT);
    ok('the same edit under strict governance is denied', verdictOf(denied.out) === 'deny', verdictOf(denied.out));

    let denyJson = null;
    try { denyJson = JSON.parse(denied.out); } catch {}
    const reason = denyJson?.hookSpecificOutput?.permissionDecisionReason || '';
    ok('a deny carries a reason and a remedy the operator can act on',
      reason.includes('Máddu blocked this edit') && /\bmaddu \w/.test(reason),
      reason.slice(0, 70));

    // ── the invariants that hold across every call made above ───────────────
    // THE EXIT CODE STOPPED BEING THE WHOLE ANSWER. `maddu hooks fire <event>`
    // now clamps its own exit code to 0 unconditionally — a containment the
    // harness needs, and one that makes `status === 0` true BY CONSTRUCTION for
    // every fire below. Read alone, this assertion could no longer fail for the
    // reason it names. (It was not fully vacuous: `init` and `governance set
    // strict` also land in `exits` and are not clamped, so it kept discriminating
    // for the two calls it was never about.)
    //
    // The evidence was not destroyed, it moved channels. When the clamp fires it
    // says so on stderr — `maddu: hooks fire <event> would have exited N; forced
    // to 0 …`, the same sentence from both the command-level clamp
    // (commands/hooks.mjs) and the bin-level floor (bin/maddu.mjs). So the
    // invariant is unchanged in meaning and follows the evidence: no invocation
    // exits non-zero, AND none had a non-zero exit suppressed on its way out.
    //
    // This still passes on the PRE-PR2 tree this lock was authored against, where
    // no clamp existed and that sentence was never printed — verified by running
    // it there, not assumed. The lock locks what it always locked.
    ok('no hook invocation exits non-zero, or has a non-zero exit suppressed',
      exits.every((e) => e.status === 0 && !clamped(e.err)),
      exits.filter((e) => e.status !== 0 || clamped(e.err))
        .map((e) => `${e.args}=${e.status}${clamped(e.err) ? ' (clamped from non-zero)' : ''}`).join(', '));
  } finally {
    if (FIXTURE) await rm(FIXTURE, { recursive: true, force: true });
  }

  console.log(`\nharness-hook-core: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('harness-hook-core FAILED'); process.exit(1); }
  console.log('harness-hook-core OK');
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
