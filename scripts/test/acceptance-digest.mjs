#!/usr/bin/env node
// acceptance-digest — fingerprint identity invariants.
//
// The property under test is ONE-DIRECTIONAL: a false DIFFERENCE is safe, a
// false MATCH is not. So most cases here assert that two inputs which a naive
// encoding would merge are kept distinct.
//
// Several cases carry a CONTROL that proves the rejected implementation really
// does collide on that input. Without the control, "these two digests differ"
// is a claim any correct-looking implementation satisfies, and the test would
// pass without pinning the defect it names.
//
// exit 0 = OK, 1 = assertion failed, 2 = harness error.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import {
  commandDigest,
  conditionPlanFingerprint,
  planFingerprint,
  verifierTerm,
} from '../../template/maddu/runtime/lib/acceptance-digest.mjs';
import { sha256Normalized } from '../../template/maddu/runtime/lib/content-pins.mjs';

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};

// ── golden values ─────────────────────────────────────────────────────────
// Frozen literals. If the encoding changes for any reason, these break — which
// is the point: the digest is a published identity, not an implementation
// detail free to drift.
ok('commandDigest("npm test") is stable',
  commandDigest('npm test') === '53a6616bb378179c58bb7b6d67f8bf35972f270e0c0b258f0cbf9ee056e7343d',
  commandDigest('npm test'));
ok('commandDigest("") is stable',
  commandDigest('') === 'd8733c99639c252df624c2ecec148b03648ffb464da7586e0096832f4d6dfd1b');
ok('planFingerprint([]) is stable',
  planFingerprint([]) === 'e7fcac7443ea48cf7290d737186d8c4e87a48e3b5f982755883a5772cfa05629');
ok('conditionPlanFingerprint([]) is stable',
  conditionPlanFingerprint([]) === 'e62ea8e26641205e5586c23e062021d4b41c96ab95e8aab2371293b08ae79f12');

// The domain tags must actually separate the namespaces.
ok('task-plan and condition-plan tags do not collide on empty input',
  planFingerprint([]) !== conditionPlanFingerprint([]));

// ── injectivity: unpaired surrogate vs U+FFFD ─────────────────────────────
// CONTROL FIRST: prove `Buffer.from(str,'utf8')` really does merge these, so
// the assertion below is pinning a real defect rather than restating that two
// different strings usually hash differently.
const lone = String.fromCharCode(0xD800);
const repl = '�';
const naive = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
ok('CONTROL: Buffer.from(utf8) merges an unpaired surrogate with U+FFFD',
  naive(lone) === naive(repl),
  'if this fails the counterexample is stale, not that we are safe');
ok('commandDigest separates an unpaired surrogate from U+FFFD',
  commandDigest(lone) !== commandDigest(repl));

// ── the rejected hasher: sha256Normalized on a STRING ──────────────────────
// Passing a String makes `buf.includes(0)` search for the CHARACTER "0" and
// `buf.toString('latin1')` a no-op that returns the string unchanged, after
// which `Buffer.from(s,'latin1')` truncates every code point above U+00FF.
// CONTROL: show the collision, then show we avoid it.
const hiA = 'aĀb';   // Ā — truncates to byte 0x00 under latin1
const hiB = 'a' + String.fromCharCode(0) + 'b'; // U+0100 truncates to 0x00 under latin1
let controlCollides = false;
try { controlCollides = sha256Normalized(hiA) === sha256Normalized(hiB); } catch { controlCollides = false; }
ok('CONTROL: sha256Normalized(String) collides on latin1-truncating input',
  controlCollides,
  'the rejected path must actually be broken for the next assertion to mean anything');
ok('commandDigest separates latin1-truncating inputs',
  commandDigest(hiA) !== commandDigest(hiB));

ok('commandDigest does not normalize CRLF',
  commandDigest('a\r\nb') !== commandDigest('a\nb'));
ok('commandDigest distinguishes internal whitespace',
  commandDigest('npm test') !== commandDigest('npm  test'));
ok('commandDigest returns null for a non-string', commandDigest(42) === null);

// ── plan fingerprint: delimiter injection ─────────────────────────────────
// A naive `id\0digest\0cwd\n` join is not prefix-free. These two DIFFERENT
// plans serialize to the same bytes under that join at equal task counts.
const planA = [{ id: 'a', command: 'c1', cwd: 'x\nb' }, { id: 'c', command: 'c2', cwd: 'z' }];
const planB = [{ id: 'a', command: 'c1', cwd: 'x' }, { id: 'b\nc', command: 'c2', cwd: 'z' }];
const naiveJoin = (rows) => rows.map((d) => `${d.id}\0${d.command}\0${d.cwd}\n`).sort().join('');
ok('CONTROL: a naive delimiter join merges these two distinct plans',
  naiveJoin(planA) === naiveJoin(planB));
ok('planFingerprint separates delimiter-injected plans',
  planFingerprint(planA) !== planFingerprint(planB));

// NUL in an id, same shape.
ok('planFingerprint separates NUL-bearing ids',
  planFingerprint([{ id: 'a\0b', command: 'c', cwd: '.' }])
  !== planFingerprint([{ id: 'a', command: 'c', cwd: 'b' }]));

// ── plan fingerprint: semantics ───────────────────────────────────────────
const t1 = { id: 't1', command: 'npm test', cwd: '.' };
const t2 = { id: 't2', command: 'pytest', cwd: 'py' };
// CORRECTED after the diff review. An earlier revision asserted the OPPOSITE —
// that order is irrelevant — and thereby certified a false match: runProjectTest
// walks plan.tasks in order and breaks at the first failure under --bail, so
// [pass, fail] runs two tasks and [fail, pass] runs one. Two genuinely
// different plans must never share a digest, and a test asserting they may is
// worse than no test at all.
ok('execution order IS part of the fingerprint (--bail makes it semantic)',
  planFingerprint([t1, t2]) !== planFingerprint([t2, t1]));
ok('multiplicity IS part of the fingerprint',
  planFingerprint([t1]) !== planFingerprint([t1, t1]));
ok('the same command in a different cwd is a different task',
  planFingerprint([{ ...t1, cwd: 'a' }]) !== planFingerprint([{ ...t1, cwd: 'b' }]));
ok('a later, never-executed task still changes the fingerprint (--bail case)',
  planFingerprint([t1]) !== planFingerprint([t1, t2]));
ok('duplicate ids are preserved, not rejected',
  planFingerprint([{ id: 'x', command: 'a', cwd: '.' }, { id: 'x', command: 'b', cwd: '.' }])
  !== planFingerprint([{ id: 'x', command: 'a', cwd: '.' }]));
ok('planFingerprint tolerates a non-array', typeof planFingerprint(null) === 'string');
// canonPath substitutes only the HOST separator, so the correct property is
// platform-dependent and the assertion must branch. An earlier revision asserted
// the Windows property unconditionally; CI runs ubuntu-latest, where a backslash
// is a legal filename character and the two paths are genuinely DIFFERENT
// directories — so it would have gone red there while passing locally. Asserting
// a platform-specific property without branching is how a green local run
// becomes a red CI run.
const BS = String.fromCharCode(92);
const winCwd = planFingerprint([{ id: 'a', command: 'x', cwd: 'test' + BS + 'sub' }]);
const posixCwd = planFingerprint([{ id: 'a', command: 'x', cwd: 'test/sub' }]);
if (sep === BS) {
  ok('WINDOWS: a native-separator cwd matches its POSIX spelling', winCwd === posixCwd);
} else {
  ok('POSIX: a literal backslash in a cwd is NOT a separator', winCwd !== posixCwd);
}

// ── condition plan ────────────────────────────────────────────────────────
const cA = { text: 'tests pass', verify: 'npm test' };
const cB = { text: 'lint clean', verify: 'npm run lint' };
ok('condition DECLARATION ORDER is part of the fingerprint',
  conditionPlanFingerprint([cA, cB]) !== conditionPlanFingerprint([cB, cA]));
ok('text is bound to its own verifier',
  conditionPlanFingerprint([{ text: 'a', verify: 'x' }, { text: 'b', verify: 'y' }])
  !== conditionPlanFingerprint([{ text: 'a', verify: 'y' }, { text: 'b', verify: 'x' }]));

// Totality: none of these may throw, and they must stay distinguishable by type.
const weird = [{ verify: 42 }, { verify: null }, { verify: {} }, {}, { verify: 'x' }];
let threw = null;
try { weird.forEach((c) => conditionPlanFingerprint([c])); } catch (e) { threw = e; }
ok('conditionPlanFingerprint accepts representative JSON-compatible verifiers', threw === null, threw?.message);
ok('a number verifier and a null verifier stay distinguishable',
  conditionPlanFingerprint([{ verify: 42 }]) !== conditionPlanFingerprint([{ verify: null }]));
ok('a missing verifier and an object verifier stay distinguishable',
  conditionPlanFingerprint([{}]) !== conditionPlanFingerprint([{ verify: {} }]));
// CORRECTED after the diff review. An earlier revision asserted that two
// different numbers SHARE a term, documenting a false match as if documenting
// it made it acceptable. It does not: distinct declared plans must have
// distinct identities.
ok('two different numbers do NOT share a verifier term',
  conditionPlanFingerprint([{ verify: 1 }]) !== conditionPlanFingerprint([{ verify: 2 }]));
ok('distinct strings and objects stay distinct',
  conditionPlanFingerprint([{ verify: { a: 1 } }]) !== conditionPlanFingerprint([{ verify: { a: 2 } }]));
ok('verifierTerm tags a string differently from a value',
  verifierTerm({ verify: 'x' })[0] === 's' && verifierTerm({ verify: 1 })[0] === 'x');
ok('a missing verifier is distinguishable from a null one',
  conditionPlanFingerprint([{}]) !== conditionPlanFingerprint([{ verify: null }]));
ok('-0 and 0 are distinguishable (JSON.stringify maps both to "0")',
  conditionPlanFingerprint([{ verify: -0 }]) !== conditionPlanFingerprint([{ verify: 0 }]));

// An unencodable value must THROW, not degrade to a shared term. The caller
// (conditionPlanFields in success-eval.mjs) wraps this in try/catch and omits
// identity entirely, so the outcome is NO identity rather than a false match.
// An earlier revision degraded to a type tag, which made every bigint - and
// every circular object - share one digest.
const throwsOn = (v) => { try { conditionPlanFingerprint([{ verify: v }]); return false; } catch { return true; } };
ok('a circular verifier THROWS (identity omitted, never shared)',
  throwsOn((() => { const o = {}; o.self = o; return o; })()));
ok('a bigint verifier THROWS', throwsOn(10n));

// The encoder must be recursive. An earlier revision special-cased a top-level
// -0 and delegated the interior to JSON.stringify, which merges one level down.
ok('NESTED -0 and 0 are distinguishable',
  conditionPlanFingerprint([{ verify: { x: -0 } }]) !== conditionPlanFingerprint([{ verify: { x: 0 } }]));
ok('NaN and Infinity are distinguishable (JSON maps both to null)',
  conditionPlanFingerprint([{ verify: NaN }]) !== conditionPlanFingerprint([{ verify: Infinity }]));
ok('NaN and null are distinguishable',
  conditionPlanFingerprint([{ verify: NaN }]) !== conditionPlanFingerprint([{ verify: null }]));
ok('object key ORDER does not change identity',
  conditionPlanFingerprint([{ verify: { a: 1, b: 2 } }]) === conditionPlanFingerprint([{ verify: { b: 2, a: 1 } }]));
ok('object key SET does change identity',
  conditionPlanFingerprint([{ verify: { a: 1 } }]) !== conditionPlanFingerprint([{ verify: { a: 1, b: undefined } }]));
ok('a DEEPLY circular value THROWS',
  throwsOn((() => { const o = { a: {} }; o.a.up = o; return o; })()));

// The ROW is validated too: GOAL_DECLARED.success constrains only the outer
// array, so a plan of bare primitives is contract-valid and [1] vs [2] would
// otherwise both read text/verify as undefined and collide.
const rowThrows = (rows) => { try { conditionPlanFingerprint(rows); return false; } catch { return true; } };
ok('a primitive condition ROW throws rather than collapsing', rowThrows([1]) && rowThrows([2]));
ok('a null condition ROW throws', rowThrows([null]));

// The common case must NOT throw: a condition declared with only a verifier has
// no `text`, and treating that absence as an encoding failure would omit
// identity for every ordinary goal.
ok('a condition with no text still produces identity',
  typeof conditionPlanFingerprint([{ verify: 'npm test' }]) === 'string');

// This source must stay TEXT to git. One literal NUL byte makes git classify the
// whole file binary, so a reviewer sees "Binary files differ" and none of these
// assertions - in a suite whose entire subject is checkable evidence.
ok('this file contains no literal NUL byte',
  !readFileSync(new URL(import.meta.url)).includes(0));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
