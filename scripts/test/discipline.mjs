#!/usr/bin/env node
// discipline — the pure self-discipline evaluator (P1). Locks the decision core
// (decide), the governance-mode thresholds (resolveThresholds), and the Bash
// write-classifier (classifyBashWrite). The impure gather/hook paths are covered
// by later phases; this file needs no spine, git, or DOM.
// Target scope exempts resolved outside writes; inside and unknown writes retain discipline enforcement.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const { resolveThresholds, decide, classifyBashWrite, classifyWriteTarget, denyReason, DISCIPLINE_DEFAULTS,
  nextCounter, enforcePreTool, lastOwnSliceStop, globToRegExp, filterIgnored } =
  await import('../../template/maddu/runtime/lib/discipline.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── classifyBashWrite ───────────────────────────────────────────────────────
const W = (c) => classifyBashWrite(c) === 'write';
const R = (c) => classifyBashWrite(c) === 'remedy';
// audit P2: the old catch-all 'allow' split into 'read' (default, allowed) and
// 'ambiguous' (opaque executor — gated under strict, nudged under standard).
const RD = (c) => classifyBashWrite(c) === 'read';
const AM = (c) => classifyBashWrite(c) === 'ambiguous';
const NW = (c) => classifyBashWrite(c) !== 'write';   // "not a write" invariant

ok('write: redirect > file', W('echo hi > src/a.js'));
ok('write: append >> file', W('cat x >> out.txt'));
ok('write: sed -i', W('sed -i "s/a/b/" f.js'));
ok('write: tee', W('cat x | tee f'));
ok('write: mv/cp/rm/dd/truncate', W('mv a b') && W('cp a b') && W('rm -rf x') && W('dd if=a of=b') && W('truncate -s0 f'));
ok('write: PowerShell Set-Content/Out-File/Remove-Item', W('Set-Content f x') && W('foo | Out-File f') && W('Remove-Item f'));

ok('not-write: 2>&1 is not a file write', NW('make 2>&1'));
ok('read: >/dev/null is not a repo write', RD('cmd >/dev/null'));
ok('read: read-only ls/cat/grep', RD('ls -la') && RD('cat f') && RD('grep x f'));
ok('ambiguous: build step', AM('npm run build') && AM('make') && AM('node build.js'));
ok('read: interpreter -c/-e without a write API', RD('python -c "open(0)"') && RD('node -e "x"'));
// audit P2 — the named holes: interpreter WRITES + self-disable
ok('write: node -e with a write API', W('node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"'));
ok('write: python -c open in write mode', W('python3 -c "open(\'f\',\'w\').write(1)"'));
ok('self-disable: hooks uninstall/remove', classifyBashWrite('maddu hooks uninstall') === 'self-disable' && classifyBashWrite('maddu hooks remove') === 'self-disable');
ok('self-disable: governance off-switch', classifyBashWrite('maddu governance set-override discipline-enforcement off') === 'self-disable');
ok('write dominates self-disable: `hooks uninstall && rm -rf x`', W('maddu hooks uninstall && rm -rf x') && W('maddu hooks uninstall;rm -rf x'));

// WRITE precedence: a write must NOT ride in on a remedy token (Codex bypass).
ok('bypass closed: `maddu register && echo x > f` → write', W('maddu register && echo x > src/a.js'));
ok('bypass closed: `git status && rm -rf src` → write', W('git status && rm -rf src'));
ok('bypass closed: `git diff | tee patch` → write', W('git diff | tee patch.txt'));
ok('bypass closed: `maddu slice-stop x; Set-Content f` → write', W('maddu slice-stop x; Set-Content f x'));
// clean remedies (no write token) still short-circuit as remedy
ok('clean remedy still remedy: git commit', R('git commit -m "fix"'));
ok('clean remedy still remedy: git add -A && git commit (no write token)', R('git add -A && git commit -m x'));

// Quoted-arg de-noise (deadlock fix): a write char INSIDE a quoted argument must
// NOT read as a shell op — else the mandated commit trailer or a slice-stop
// message could block the very remedy that clears the block.
ok('remedy: commit trailer <email> in quotes not a redirect', R('git commit -m "x\n\nCo-Authored-By: A <noreply@anthropic.com>"'));
ok('remedy: slice-stop message mentioning `cat > f` not a write', R('maddu slice-stop "note: cat > tempfile pattern"'));
ok('remedy: git commit -m with literal > inside message', R('git commit -m "use > redirect in prose"'));
ok('still write: real redirect outside quotes', W('echo x > f.js'));
ok('still write: quoted remedy token but real unquoted rm', W('maddu slice-stop "msg"; rm -rf src'));

// exec-wrapper: `bash -c "…"`/`sh -c "…"` runs its arg as code — a write hidden
// there is real (the dequote must not hide it), but a remedy that merely QUOTES
// "bash -c" in its message must stay a remedy (no re-introduced deadlock).
ok('write: bash -c hiding a redirect', W('bash -lc "echo x > f"'));
ok('write: sh -c hiding rm', W('sh -c "rm -rf src"'));
ok('remedy: slice-stop message that quotes the text bash -c', R('maddu slice-stop "we used bash -c and cat > f earlier"'));

ok('remedy: bare maddu verbs', R('maddu slice-stop "x"') && R('maddu goal set "g"') && R('maddu plan new "t"') && R('maddu lane claim l') && R('maddu register'));
ok('remedy: node bin/maddu.mjs form', R('node bin/maddu.mjs slice-stop "x"'));
ok('remedy: ./maddu/run form', R('./maddu/run slice-stop "x"'));
ok('remedy: git status/diff/add/commit/log', R('git status') && R('git commit -F m.txt') && R('git add -A') && R('git diff') && R('git log -1'));
ok('remedy beats write: git commit never classed write', classifyBashWrite('git commit -F .maddu/tmp/msg') === 'remedy');
ok('no blanket maddu: maddu upgrade is NOT a remedy', classifyBashWrite('maddu upgrade') !== 'remedy');
ok('no blanket git: git checkout -- . is NOT a remedy', classifyBashWrite('git checkout -- .') !== 'remedy');
ok('empty/nullish → read', RD('') && RD('   ') && classifyBashWrite(null) === 'read' && classifyBashWrite(undefined) === 'read');

// ── resolveThresholds ───────────────────────────────────────────────────────
ok('strict enforcement=block', resolveThresholds('strict').enforcement === 'block');
ok('standard enforcement=graduated', resolveThresholds('standard').enforcement === 'graduated');
ok('relaxed enforcement=nudge', resolveThresholds('relaxed').enforcement === 'nudge');
ok('unknown mode → standard fallback', resolveThresholds('bogus').enforcement === 'graduated');
ok('override merges per-section', resolveThresholds('strict', { slicestop: { blockEdits: 99 } }).slicestop.blockEdits === 99 && resolveThresholds('strict', { slicestop: { blockEdits: 99 } }).slicestop.warnEdits === 6);
ok('override can flip enforcement', resolveThresholds('strict', { enforcement: 'nudge' }).enforcement === 'nudge');

// ── decide ──────────────────────────────────────────────────────────────────
const strict = resolveThresholds('strict');
const standard = resolveThresholds('standard');
const relaxed = resolveThresholds('relaxed');
const good = { session: { registered: true }, lane: { claimed: true }, goalOrPlan: { active: true }, slice: { ageMin: 0 }, commit: { newDirtyFiles: 0, dirtyAgeMin: 0, slicedButDirty: false } };
const mut = { isMutating: true };
const d = (thresholds, state, counter = { editsSinceSlice: 0 }, toolCtx = mut) => decide({ thresholds, state, counter, toolCtx });

ok('non-mutating tool → ok', d(strict, good, { editsSinceSlice: 99 }, { isMutating: false }).verdict === 'ok');
ok('all good, first edit → ok', d(strict, good).verdict === 'ok');

// preconditions + ordering
ok('no session → block (strict)', d(strict, { ...good, session: { registered: false } }).blocker === 'session');
ok('no lane → block (strict)', d(strict, { ...good, lane: { claimed: false } }).blocker === 'lane');
ok('session beats lane in ordering', d(strict, { ...good, session: { registered: false }, lane: { claimed: false } }).blocker === 'session');

// ── unobservable projection must SOFTEN, never harden (v1.120.0) ────────────
//
// gatherRitualState used to swallow a project() failure into `proj = {}`, which
// makes sessions/claims/stops read as EMPTY. An unreadable projection therefore
// presented as "no session, no lane, no slice-stop" and BLOCKED every write,
// telling the operator they had skipped rituals they may well have performed.
// The module's own contract says an input that cannot be resolved is UNKNOWN,
// never silently measured — the commit gate has always worked that way. These
// pin the ritual half to the same rule.
const unobserved = {
  ritualObserved: false,
  session: { registered: false }, lane: { claimed: false }, goalOrPlan: { active: false },
  slice: { ageMin: 999 },
  commit: { newDirtyFiles: 0, dirtyAgeMin: 0, slicedButDirty: false },
};
ok('unobservable projection does NOT block on session', d(strict, unobserved, { editsSinceSlice: 99 }).blocker !== 'session');
ok('unobservable projection does NOT block on lane', d(strict, unobserved, { editsSinceSlice: 99 }).blocker !== 'lane');
ok('unobservable projection does NOT block on goal/plan', d(strict, unobserved, { editsSinceSlice: 99 }).blocker !== 'goal/plan');
ok('unobservable projection does NOT block on slice-stop', d(strict, unobserved, { editsSinceSlice: 99 }).blocker !== 'slice-stop');
ok('unobservable projection with a clean tree → ok', d(strict, unobserved, { editsSinceSlice: 99 }).verdict === 'ok');
// The commit gate keeps running: it observes the WORKING TREE directly, which
// is a different source from the projection, so suppressing it too would be
// over-correction rather than honesty.
ok('unobservable projection STILL enforces the commit gate',
  d(strict, { ...unobserved, commit: { newDirtyFiles: 99, dirtyAgeMin: 999, slicedButDirty: false } }, { editsSinceSlice: 99 }).blocker === 'commit');
// And the normal path is untouched — without the flag, absence still blocks.
ok('an OBSERVED empty projection still blocks on session (no regression)',
  d(strict, { ...unobserved, ritualObserved: true }, { editsSinceSlice: 99 }).blocker === 'session');

// goal/plan
ok('strict no goal/plan → block now', d(strict, { ...good, goalOrPlan: { active: false } }).verdict === 'block');
ok('standard no goal/plan within grace → warn', d(standard, { ...good, goalOrPlan: { active: false } }, { editsSinceSlice: 0, goalplanAgeEdits: 0, goalplanAgeMin: 0 }).verdict === 'warn');
ok('standard no goal/plan past grace → block', d(standard, { ...good, goalOrPlan: { active: false } }, { editsSinceSlice: 3, goalplanAgeEdits: 3, goalplanAgeMin: 11 }).verdict === 'block');
ok('relaxed no goal/plan → nudge (never block)', d(relaxed, { ...good, goalOrPlan: { active: false } }).verdict === 'nudge');

// slice-stop staleness — first edit never blocks
ok('first edit of slice (0 edits) → ok', d(strict, { ...good, slice: { ageMin: null } }, { editsSinceSlice: 0 }).verdict === 'ok');
ok('strict 6 edits → block slice-stop', (() => { const r = d(strict, good, { editsSinceSlice: 6 }); return r.verdict === 'block' && r.blocker === 'slice-stop'; })());
ok('standard 6 edits → warn', d(standard, good, { editsSinceSlice: 6 }).verdict === 'warn');
ok('standard 12 edits → block', d(standard, good, { editsSinceSlice: 12 }).verdict === 'block');
ok('strict 20 min → block by time', d(strict, { ...good, slice: { ageMin: 20 } }, { editsSinceSlice: 1 }).verdict === 'block');

// The block message must name the condition that actually fired. An
// age-triggered block used to render the edit wording, printing
// "slice-stop overdue (0 edits since the last one)" — self-contradictory, and
// it pointed at a cause no amount of not-editing could clear.
ok('age-triggered block names the AGE, not an edit count', (() => {
  const r = d(strict, { ...good, slice: { ageMin: 20 } }, { editsSinceSlice: 0 });
  return r.verdict === 'block' && /last one was 20 min ago/.test(r.reason) && !/edits? since/.test(r.reason);
})());
ok('edit-triggered block names the EDITS, not an age', (() => {
  const r = d(strict, { ...good, slice: { ageMin: 0 } }, { editsSinceSlice: 6 });
  return r.verdict === 'block' && /6 edits since the last one/.test(r.reason) && !/min ago/.test(r.reason);
})());
ok('both conditions fired → both named', (() => {
  const r = d(strict, { ...good, slice: { ageMin: 20 } }, { editsSinceSlice: 6 });
  return /6 edits since the last one/.test(r.reason) && /20 min ago/.test(r.reason);
})());
ok('edit count is pluralized correctly', (() => {
  const one = resolveThresholds('strict', { slicestop: { blockEdits: 1 } });
  const r1 = d(one, { ...good, slice: { ageMin: 0 } }, { editsSinceSlice: 1 });
  const r6 = d(strict, { ...good, slice: { ageMin: 0 } }, { editsSinceSlice: 6 });
  return r1.reason.includes('(1 edit since') && r6.reason.includes('(6 edits since');
})());
ok('warn message names its trigger too', (() => {
  const r = d(standard, { ...good, slice: { ageMin: 30 } }, { editsSinceSlice: 0 });
  return r.verdict === 'warn' && /last one was 30 min ago/.test(r.reason);
})());

// The gate reads ONE session's counter and only that session's own slice-stop
// resets it, so a slice-stop recorded against a different live session leaves
// the block standing. Naming the session keeps the remedy true.
ok('remedy pins the session the counter belongs to', (() => {
  const s = { ...good, session: { registered: true, id: 'ses_20260101120000_abc123' }, slice: { ageMin: 20 } };
  const r = d(strict, s, { editsSinceSlice: 0 });
  return r.remedy === 'maddu slice-stop --session ses_20260101120000_abc123 "SLICE STOP: ..."';
})());
ok('remedy falls back to the bare form when no session id is known', (() => {
  const r = d(strict, { ...good, slice: { ageMin: 20 } }, { editsSinceSlice: 0 });
  return r.remedy === 'maddu slice-stop "SLICE STOP: ..."';
})());

// commit pileup — new dirty over baseline
ok('strict 15 dirty files → block commit', (() => { const r = d(strict, { ...good, commit: { newDirtyFiles: 15, dirtyAgeMin: 0, slicedButDirty: false } }, { editsSinceSlice: 1 }); return r.verdict === 'block' && r.blocker === 'commit'; })());
ok('standard 15 dirty → warn', d(standard, { ...good, commit: { newDirtyFiles: 15, dirtyAgeMin: 0, slicedButDirty: false } }, { editsSinceSlice: 1 }).verdict === 'warn');
ok('standard 30 dirty → block', d(standard, { ...good, commit: { newDirtyFiles: 30, dirtyAgeMin: 0, slicedButDirty: false } }, { editsSinceSlice: 1 }).verdict === 'block');
ok('strict slicedButDirty → block', d(strict, { ...good, commit: { newDirtyFiles: 1, dirtyAgeMin: 0, slicedButDirty: true } }, { editsSinceSlice: 0 }).verdict === 'block');
ok('standard slicedButDirty (no block-if flag) → ok', d(standard, { ...good, commit: { newDirtyFiles: 1, dirtyAgeMin: 0, slicedButDirty: true } }, { editsSinceSlice: 0 }).verdict === 'ok');

// relaxed caps every block down to nudge
ok('relaxed no session → nudge not block', d(relaxed, { ...good, session: { registered: false } }).verdict === 'nudge');

// denyReason names the remedy
ok('denyReason includes the remedy', denyReason(d(strict, { ...good, goalOrPlan: { active: false } })).includes('maddu goal set'));

// off enforcement
ok('off enforcement → ok', decide({ thresholds: { ...strict, enforcement: 'off' }, state: { ...good, session: { registered: false } }, counter: { editsSinceSlice: 99 }, toolCtx: mut }).verdict === 'ok');

// ── nextCounter (P3 — pure per-session counter maintenance, no edit bump) ────
const St = (over = {}) => ({
  session: { registered: true }, lane: { claimed: true }, goalOrPlan: { active: true },
  slice: { ageMin: 0, lastStopId: 'A' }, commit: { newDirtyFiles: 0 }, ...over,
});
ok('nextCounter: new slice-stop id resets editsSinceSlice',
  (() => { const c = nextCounter({ lastSliceStopId: 'A', editsSinceSlice: 5 }, St({ slice: { lastStopId: 'B' } }), 0); return c.editsSinceSlice === 0 && c.lastSliceStopId === 'B'; })());
ok('nextCounter: same slice carries editsSinceSlice',
  nextCounter({ lastSliceStopId: 'A', editsSinceSlice: 5 }, St(), 0).editsSinceSlice === 5);
ok('nextCounter: does NOT bump editsSinceSlice (bump is post-decide)',
  nextCounter({ lastSliceStopId: 'A', editsSinceSlice: 2 }, St(), 0).editsSinceSlice === 2);
// v1.111.0: the age anchor derives from the per-file dirtyFirstSeen map —
// synthetic states carry the full commit shape (paths + observed flag).
const Cm = (over = {}) => ({ newDirtyFiles: (over.newDirtyPaths || []).length, newDirtyPaths: [], currentDirtyPaths: [], observed: true, workRoot: '/w', renames: new Map(), ...over });
ok('nextCounter: firstDirtyTs anchors on first dirty',
  nextCounter({ firstDirtyTs: null }, St({ commit: Cm({ newDirtyPaths: ['a.js', 'b.js', 'c.js'], currentDirtyPaths: ['a.js', 'b.js', 'c.js'] }) }), 1000).firstDirtyTs === 1000);
ok('nextCounter: firstDirtyTs clears when clean',
  nextCounter({ firstDirtyTs: 1000 }, St({ commit: Cm({}) }), 5000).firstDirtyTs === null);
ok('nextCounter: goal/plan active resets grace anchors',
  (() => { const c = nextCounter({ goalplanFirstTs: 500, goalplanAgeEdits: 3 }, St(), 0); return c.goalplanFirstTs === null && c.goalplanAgeEdits === 0; })());
ok('nextCounter: goal/plan inactive anchors the grace clock',
  nextCounter({ goalplanFirstTs: null }, St({ goalOrPlan: { active: false } }), 600000).goalplanFirstTs === 600000);
ok('nextCounter: goalplanAgeMin derived from anchor',
  Math.round(nextCounter({ goalplanFirstTs: 1000 }, St({ goalOrPlan: { active: false } }), 601000).goalplanAgeMin) === 10);
ok('nextCounter: firstDirtyTs of 0 is preserved (== null guard, not falsy)',
  nextCounter({ firstDirtyTs: 0 }, St({ commit: Cm({ newDirtyPaths: ['a', 'b'], currentDirtyPaths: ['a', 'b'] }) }), 9000).firstDirtyTs === 0);

// ── lastOwnSliceStop (per-session accounting — Codex cross-session fix) ──────
{
  const stops = [
    { id: 's1', actor: 'A', ts: '1' },
    { id: 's2', actor: 'B', ts: '2' },   // another session's slice-stop, newest
  ];
  ok('lastOwnSliceStop: returns THIS session\'s last, not the global last',
    lastOwnSliceStop(stops, 'A')?.id === 's1');
  ok('lastOwnSliceStop: another session\'s stop never counts',
    lastOwnSliceStop([{ id: 's2', actor: 'B', ts: '2' }], 'A') === null);
  ok('lastOwnSliceStop: no session → null', lastOwnSliceStop(stops, null) === null);
  // The bug it prevents: B slice-stopping must NOT reset A's counter. With the
  // per-session id, A's lastStopId stays 's1' → nextCounter does not reset.
  const aCounter = { lastSliceStopId: 's1', editsSinceSlice: 11 };
  const aState = { slice: { lastStopId: lastOwnSliceStop(stops, 'A')?.id ?? null }, commit: {}, goalOrPlan: { active: true } };
  ok('cross-session: B\'s slice-stop does NOT reset A\'s editsSinceSlice',
    nextCounter(aCounter, aState, 0).editsSinceSlice === 11);
  // Truncation edge (Codex re-review): A's own last stop pushed out of the
  // recent-50 projection window → lastStopId null → must NOT reset A's counter.
  const truncated = nextCounter({ lastSliceStopId: 'a-old', editsSinceSlice: 11 }, { slice: { lastStopId: null }, commit: {}, goalOrPlan: { active: true } }, 0);
  ok('truncated own slice-stop (null) does NOT reset the counter',
    truncated.editsSinceSlice === 11 && truncated.lastSliceStopId === 'a-old');
}

// ── enforcePreTool (P3 — stateful entry; FAIL-OPEN short-circuits) ───────────
// These paths return before any git/governance read, so a bogus repoRoot is fine.
ok('enforcePreTool: non-mutating tool → ok, mutating:false',
  (await enforcePreTool('/no/such/repo', { tool: 'Read', filePath: 'x.js' })).verdict === 'ok');
{
  const r = await enforcePreTool('/no/such/repo', { tool: 'Bash', command: 'maddu slice-stop "x"' });
  ok('enforcePreTool: Bash remedy → ok + mutating:false', r.verdict === 'ok' && r.mutating === false);
}
{
  const r = await enforcePreTool('/no/such/repo', { tool: 'Bash', command: 'git commit -m x' });
  ok('enforcePreTool: git commit remedy → ok', r.verdict === 'ok' && r.mutating === false);
}
{
  const r = await enforcePreTool('/no/such/repo', { tool: 'Bash', command: 'npm run build' });
  // ambiguous under standard → a nudge (surfaced, non-blocking), never gated as a write.
  ok('enforcePreTool: ambiguous Bash → non-mutating', r.mutating === false && (r.verdict === 'nudge' || r.verdict === 'ok'));
}
{
  // A mutating Edit against a bogus repo must never THROW — it returns a verdict
  // (fail-open: an internal error yields ok). The value is not asserted here, only
  // that the call resolves to a well-formed decision object.
  const r = await enforcePreTool('/no/such/repo', { tool: 'Edit', filePath: 'x.js', nowMs: 0 });
  ok('enforcePreTool: mutating on bogus repo never throws (fail-open shape)', typeof r.verdict === 'string');
}

// ── v1.111.0 — scratch-ignore globs (typed, fail-safe) ──────────────────────
{
  ok('glob: * is segment-local', globToRegExp('src/*.js').test('src/a.js') && !globToRegExp('src/*.js').test('src/x/a.js'));
  ok('glob: ** crosses segments', globToRegExp('**/*.tmp').test('a/b/c.tmp') && globToRegExp('**/*.tmp').test('c.tmp'));
  ok('glob: ? is one non-slash char', globToRegExp('a?.js').test('ab.js') && !globToRegExp('a?.js').test('a/x.js') && !globToRegExp('a?.js').test('a.js'));
  ok('glob: anchored both ends', !globToRegExp('a.js').test('xa.js') && !globToRegExp('a.js').test('a.jsx'));
  ok('glob: regex metacharacters escaped', globToRegExp('a+b.txt').test('a+b.txt') && !globToRegExp('a+b.txt').test('aab.txt'));
  ok('glob: non-string/empty → null', globToRegExp(true) === null && globToRegExp('') === null && globToRegExp(3) === null);
  ok('filterIgnored: mixed set', JSON.stringify(filterIgnored(['keep.js', '_scratch.mjs', 'x/_t.mjs'], ['_*', '**/_*.mjs'])) === JSON.stringify(['keep.js']));
  ok('filterIgnored: bad glob dropped, siblings apply', JSON.stringify(filterIgnored(['a.tmp', 'b.js'], [null, '*.tmp'])) === JSON.stringify(['b.js']));
  ok('filterIgnored: empty globs → identity', JSON.stringify(filterIgnored(['a', 'b'], [])) === JSON.stringify(['a', 'b']));
  ok('resolveThresholds: null root normalized', Array.isArray(resolveThresholds('standard', null).uncommitted.ignore));
  ok('resolveThresholds: non-array ignore → []', resolveThresholds('standard', { uncommitted: { ignore: 'x' } }).uncommitted.ignore.length === 0);
  ok('resolveThresholds: mixed-type ignore filtered', JSON.stringify(resolveThresholds('standard', { uncommitted: { ignore: ['ok', 3, null, ''] } }).uncommitted.ignore) === JSON.stringify(['ok']));
}

// ── v1.111.0 — per-file first-seen clocks (map maintenance) ─────────────────
{
  const base = { baselineInit: true, workRoot: '/w', dirtyBaseline: [] };
  // seed → prune-on-commit drops age to next-oldest
  let c = nextCounter({ ...base }, St({ commit: Cm({ newDirtyPaths: ['old.js'], currentDirtyPaths: ['old.js'] }) }), 1000);
  c = nextCounter(c, St({ commit: Cm({ newDirtyPaths: ['old.js', 'new.js'], currentDirtyPaths: ['old.js', 'new.js'] }) }), 5000);
  ok('map: two files, min = oldest', c.firstDirtyTs === 1000 && c.dirtyFirstSeen.length === 2);
  c = nextCounter(c, St({ commit: Cm({ newDirtyPaths: ['new.js'], currentDirtyPaths: ['new.js'] }) }), 6000);
  ok('map: committing the oldest drops age to next-oldest', c.firstDirtyTs === 5000);
  c = nextCounter(c, St({ commit: Cm({}) }), 7000);
  ok('map: full clean → empty map + null scalar', c.firstDirtyTs === null && c.dirtyFirstSeen.length === 0);
  // legacy migration preserves age
  const m = nextCounter({ ...base, firstDirtyTs: 2000 }, St({ commit: Cm({ newDirtyPaths: ['a', 'b'], currentDirtyPaths: ['a', 'b'] }) }), 9000);
  ok('map: legacy scalar migration seeds at old ts', m.firstDirtyTs === 2000 && m.dirtyFirstSeen.every((p) => p[1] === 2000));
  // malformed stored map → rebuilt from scalar (nextCounter-level guard)
  const bad = nextCounter({ ...base, dirtyV: 2, dirtyFirstSeen: [['x']], firstDirtyTs: 3000 }, St({ commit: Cm({ newDirtyPaths: ['x'], currentDirtyPaths: ['x'] }) }), 9000);
  ok('map: malformed pairs → legacy migration path', bad.firstDirtyTs === 3000);
  // __proto__ as a path is inert (array-of-pairs storage)
  const proto = nextCounter({ ...base }, St({ commit: Cm({ newDirtyPaths: ['__proto__'], currentDirtyPaths: ['__proto__'] }) }), 100);
  ok('map: __proto__ path inert', proto.firstDirtyTs === 100 && Object.getPrototypeOf({}) === Object.prototype);
  // observed=false preserves clocks but slice/goalplan still run
  const pres = nextCounter({ ...base, lastSliceStopId: 'A', editsSinceSlice: 4, firstDirtyTs: 500, dirtyV: 2, dirtyFirstSeen: [['f', 500]] },
    St({ slice: { lastStopId: 'B' }, commit: { observed: false, newDirtyFiles: 0 } }), 9999);
  ok('unobserved: clocks preserved', pres.firstDirtyTs === 500 && pres.dirtyFirstSeen.length === 1);
  ok('unobserved: slice reset still runs', pres.editsSinceSlice === 0 && pres.lastSliceStopId === 'B');
}

// ── v1.111.0 — rename clock transfer (R-only, snapshot-then-prune) ──────────
{
  const base = { baselineInit: true, workRoot: '/w', dirtyBaseline: [] };
  let c = nextCounter({ ...base }, St({ commit: Cm({ newDirtyPaths: ['src.js'], currentDirtyPaths: ['src.js'] }) }), 1000);
  // staged rename: src.js → dst.js (src leaves the dirty set) → clock transfers
  const ren = new Map([['dst.js', { from: 'src.js', kind: 'R' }]]);
  c = nextCounter(c, St({ commit: Cm({ newDirtyPaths: ['dst.js'], currentDirtyPaths: ['dst.js'], renames: ren }) }), 5000);
  ok('rename: R transfers the clock', c.firstDirtyTs === 1000 && c.dirtyFirstSeen[0][0] === 'dst.js');
  // copy: source still dirty → target seeds fresh, source keeps its clock
  let k = nextCounter({ ...base }, St({ commit: Cm({ newDirtyPaths: ['s.js'], currentDirtyPaths: ['s.js'] }) }), 1000);
  const cp = new Map([['t.js', { from: 's.js', kind: 'C' }]]);
  k = nextCounter(k, St({ commit: Cm({ newDirtyPaths: ['s.js', 't.js'], currentDirtyPaths: ['s.js', 't.js'], renames: cp }) }), 5000);
  const tEntry = k.dirtyFirstSeen.find((p) => p[0] === 't.js');
  ok('copy: C never transfers (target seeds at now)', tEntry && tEntry[1] === 5000);
  // C where the source did leave: still no transfer (kind gate, not set membership)
  let k2 = nextCounter({ ...base }, St({ commit: Cm({ newDirtyPaths: ['s2.js'], currentDirtyPaths: ['s2.js'] }) }), 1000);
  const cp2 = new Map([['t2.js', { from: 's2.js', kind: 'C' }]]);
  k2 = nextCounter(k2, St({ commit: Cm({ newDirtyPaths: ['t2.js'], currentDirtyPaths: ['t2.js'], renames: cp2 }) }), 5000);
  ok('copy: C with departed source still seeds fresh', k2.dirtyFirstSeen.find((p) => p[0] === 't2.js')[1] === 5000);
}

// ── v1.111.0 — workRoot domains, baseline init/retirement ───────────────────
{
  // domain change: re-baseline + clear clocks + stamp
  const dc = nextCounter({ baselineInit: true, workRoot: '/old', dirtyBaseline: ['gone.js'], dirtyV: 2, dirtyFirstSeen: [['gone.js', 111]], firstDirtyTs: 111 },
    St({ commit: Cm({ domainChanged: true, workRoot: '/new', currentDirtyPaths: ['pre.js'] }) }), 5000);
  ok('domain change: re-baseline + cleared clocks + stamped root',
    dc.workRoot === '/new' && dc.dirtyBaseline[0] === 'pre.js' && dc.firstDirtyTs === null && dc.dirtyFirstSeen.length === 0);
  // baseline init: seed + marker
  const bi = nextCounter({}, St({ commit: Cm({ needsBaselineInit: true, workRoot: '/w', currentDirtyPaths: ['pre1.js', 'pre2.js'] }) }), 5000);
  ok('baseline init: seeds full current list + sets marker',
    bi.baselineInit === true && bi.dirtyBaseline.length === 2 && bi.firstDirtyTs === null);
  // absent workRoot ADOPTS without clearing
  const ad = nextCounter({ baselineInit: true, dirtyBaseline: [], dirtyV: 2, dirtyFirstSeen: [['f.js', 700]], firstDirtyTs: 700 },
    St({ commit: Cm({ workRoot: '/adopted', newDirtyPaths: ['f.js'], currentDirtyPaths: ['f.js'] }) }), 5000);
  ok('absent workRoot: adopts, clocks survive', ad.workRoot === '/adopted' && ad.firstDirtyTs === 700);
  // baseline retirement: clean-then-redirty counts as new
  const rt = nextCounter({ baselineInit: true, workRoot: '/w', dirtyBaseline: ['a.js', 'b.js'] },
    St({ commit: Cm({ newDirtyPaths: [], currentDirtyPaths: ['a.js'] }) }), 5000);
  ok('baseline retirement: clean path retires', JSON.stringify(rt.dirtyBaseline) === JSON.stringify(['a.js']));
}

// ── classifyWriteTarget — target-aware discipline contract ─────────────────
{
  const base = join(tmpdir(), 'maddu-write-target-contract');
  const root = join(base, 'work');
  const stateRoot = join(base, 'state');
  const outside = join(base, 'outside');
  const roots = [root, stateRoot];
  // These commands are classifier input ONLY; no shell executes them. Forward
  // slashes and quoted paths preserve Windows paths and temp dirs with spaces.
  const quote = (p) => `"${p.replaceAll('\\', '/')}"`;
  // The export is deliberately absent at the base commit. Optional invocation
  // yields undefined (NOT 'unknown'), so every comparison records a failed
  // ok() instead of aborting module loading or skipping the new rows.
  const target = (opts) => classifyWriteTarget?.({ roots, ...opts });
  const edit = (filePath, opts = {}) => target({ tool: 'Edit', filePath, ...opts });
  const bash = (command, opts = {}) => target({ tool: 'Bash', command, ...opts });
  const all = (values, expected) => values.every((value) => value === expected);

  ok('target: absolute Edit outside every root', edit(join(outside, 'x.js')) === 'outside');
  ok('target: Write inside the second root', target({ tool: 'Write', filePath: join(stateRoot, 'x.js') }) === 'inside');
  ok('target: relative Edit without cwd uses the first root', edit('src/x.js') === 'inside');
  ok('target: relative Edit uses an outside cwd', edit('x.js', { cwd: outside }) === 'outside');
  // Do not use join/resolve on the INPUTS here: the classifier must collapse
  // the literal traversal, not receive an already-normalized fixture.
  ok('target: dot and parent traversal cross the root boundary correctly',
    edit(`${root}${sep}..${sep}outside${sep}x.js`) === 'outside'
    && edit(`${outside}${sep}..${sep}work${sep}x.js`) === 'inside'
    && edit(`${root}${sep}.${sep}src${sep}..${sep}x.js`) === 'inside');
  ok('target: sibling prefix is outside and root equality is inside',
    edit(join(`${root}-other`, 'x.js')) === 'outside' && edit(root) === 'inside');
  if (process.platform === 'win32') {
    const inside = join(root, 'MixedCase', 'x.js');
    const mixed = inside.replace(/[a-z]/gi, (c, i) => i % 2 ? c.toUpperCase() : c.toLowerCase());
    const msys = inside.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`);
    ok('target: win32 case, separators, and MSYS spelling are equivalent',
      all([edit(mixed), edit(inside.replaceAll('\\', '/')), edit(msys)], 'inside'));
  }
  ok('target: tilde expands to the home directory',
    edit('~/x') === 'outside' && edit('~/x', { roots: [homedir()] }) === 'inside');
  ok('target: absent paths and invalid roots are unknown',
    all([target({ tool: 'Edit' }), edit(''), edit(join(root, 'x'), { roots: [] }),
      edit(join(root, 'x'), { roots: null }), edit(join(root, 'x'), { roots: root })], 'unknown'));

  const redirect = `echo x > ${quote(join(outside, 'f'))}`;
  ok('target: absolute redirects, append, and heredoc outside',
    all([bash(redirect), bash(`echo x >> ${quote(join(outside, 'f'))}`),
      bash(`cat <<'HEREDOC' > ${quote(join(outside, 'f'))}\nx\nHEREDOC`)], 'outside'));
  ok('target: an inside redirect wins over an outside redirect',
    bash(`${redirect} && echo y > src/a.js`, { cwd: root }) === 'inside');
  ok('target: relative Bash targets require cwd without cd',
    bash('echo x > out.txt', { cwd: root }) === 'inside'
    && bash('echo x > out.txt') === 'unknown'
    && bash(`cd ${quote(outside)} && echo x > out.txt`, { cwd: root }) === 'unknown');
  ok('target: variables, command substitution, globs, and braces are unknown',
    all([bash('echo x > "$OUT"'), bash('echo x > $OUT'),
      bash(`echo x > ${outside.replaceAll('\\', '/')}/*.log`),
      bash('echo x > `pwd`/f'), bash('echo x > f?.log'), bash('echo x > {a,b}.log')], 'unknown'));
  // Round 3 removes every writer except tee, regardless of operand location.
  ok('target: mv is unknown for inside and outside operands',
    bash(`mv ${quote(join(root, 'a'))} ${quote(join(outside, 'b'))}`) === 'unknown'
    && bash(`mv ${quote(join(outside, 'a'))} ${quote(join(outside, 'b'))}`) === 'unknown');
  ok('target: cp and install are unknown for either destination',
    all([bash(`cp ${quote(join(root, 'a'))} ${quote(join(outside, 'b'))}`),
      bash(`install ${quote(join(root, 'a'))} ${quote(join(outside, 'b'))}`)], 'unknown')
    && all([bash(`cp ${quote(join(outside, 'a'))} ${quote(join(root, 'b'))}`),
      bash(`install ${quote(join(outside, 'a'))} ${quote(join(root, 'b'))}`)], 'unknown'));
  ok('target: rm is unknown for outside and mixed operands',
    bash(`rm -rf ${quote(join(outside, 'x'))}`) === 'unknown'
    && bash(`rm -rf ${quote(join(outside, 'x'))} ${quote(join(root, 'y'))}`) === 'unknown');
  ok('target: tee retains its scope while sed, dd, and truncate are unknown',
    bash(`tee -a ${quote(join(outside, 'log'))}`) === 'outside'
    && all([bash(`sed -i 's/a/b/' ${quote(join(outside, 'f'))}`),
      bash(`dd if=x of=${quote(join(outside, 'y'))}`),
      bash(`truncate -s0 ${quote(join(outside, 'f'))}`)], 'unknown')
    && bash(`sed -i -e 's/a/b/' ${quote(join(root, 'f'))}`, { cwd: root }) === 'unknown'
    && bash(`sed -i --expression 's/a/b/' ${quote(join(root, 'f'))}`, { cwd: root }) === 'unknown'
    && bash(`tee -a ${quote(join(outside, 'log'))} ${quote(join(root, 'log'))}`) === 'inside');
  ok('target: shell wrapper payload redirects remain unknown',
    all([bash(`bash -lc "echo x > '${join(outside, 'f').replaceAll('\\', '/')}'"`),
      bash(`sh -c "echo x > '${join(outside, 'f').replaceAll('\\', '/')}'"`)], 'unknown'));
  ok('target: PowerShell and interpreter writes remain unknown',
    all([bash(`Set-Content ${quote(join(outside, 'f'))} x`),
      bash(`node -e "require('fs').writeFileSync('${join(outside, 'f').replaceAll('\\', '/')}','y')"`),
      bash(`python -c "open('${join(outside, 'f').replaceAll('\\', '/')}', 'w').write('y')"`)], 'unknown'));
  ok('target: null-device redirects and fd duplication yield no targets',
    all([bash('cmd >/dev/null'), bash('make 2>&1')], 'unknown'));

  // Paired behavioral rows lock the new exemption AND the preserved gate.
  // Standalone inside/unknown regression checks already pass at the base and
  // would violate this spec's requirement that every added row starts red.
  const bogusRepo = resolve('/no/such/repo');
  // A truthy invalid explicit id is rejected by the existing validator and
  // prevents an inherited MADDU_SESSION_ID from writing a bogus-repo counter.
  const enforce = (opts, repoRoot = bogusRepo) => enforcePreTool(repoRoot, { madduSessionId: 'invalid/session', ...opts });
  // Gated calls need a writable state root on every platform. Reserve the
  // bogus root for external allowances that must return before filesystem I/O.
  const withRepo = async (run) => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'maddu-enforce-target-'));
    try {
      await mkdir(join(repoRoot, '.maddu'));
      return await run(repoRoot);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  };
  const external = (r) => r.verdict === 'ok' && r.kind === 'external'
    && r.mutating === false && r.action === 'allow' && r.enforcement === 'n/a';
  const outsideWrite = await enforce({ tool: 'Write', filePath: join(outside, 'x.js') });
  const outsideBash = await enforce({ tool: 'Bash', command: redirect });
  const [mixedWrite, insideEdit] = await withRepo(async (repoRoot) => [
    await enforce({ tool: 'Bash', command: `${redirect} && rm -rf src`, cwd: repoRoot }, repoRoot),
    await enforce({ tool: 'Edit', filePath: 'x.js', nowMs: 0 }, repoRoot),
  ]);
  ok('enforce target: outside Write returns the complete external allowance', external(outsideWrite), JSON.stringify(outsideWrite));
  ok('enforce target: outside Bash returns the complete external allowance', external(outsideBash), JSON.stringify(outsideBash));
  ok('enforce target: outside Bash allowed while a mixed repo write stays gated',
    external(outsideBash) && mixedWrite.kind === 'write' && mixedWrite.mutating === true
    && mixedWrite.action === 'gate' && mixedWrite.verdict === 'block', JSON.stringify(mixedWrite));
  ok('enforce target: outside Write allowed while Edit x.js keeps its session block',
    external(outsideWrite) && insideEdit.verdict === 'block' && insideEdit.blocker === 'session'
    && insideEdit.kind === 'edit' && insideEdit.mutating === true && insideEdit.action === 'gate', JSON.stringify(insideEdit));

  ok('target: MultiEdit and NotebookEdit obey the same root scope',
    all(['MultiEdit', 'NotebookEdit'].map((tool) => target({ tool, filePath: join(root, 'x') })), 'inside')
    && all(['MultiEdit', 'NotebookEdit'].map((tool) => target({ tool, filePath: join(outside, 'x') })), 'outside'));
  ok('target: unresolved companions stay unknown unless an inside target wins',
    bash(`${redirect} && echo y > "$OUT"`, { cwd: root }) === 'unknown'
    && bash('echo x > "$OUT" && echo y > src/a.js', { cwd: root }) === 'inside');
  const scoped = await withRepo(async (repoRoot) => {
    const decisions = [];
    for (const filePath of [join(root, 'x'), join(repoRoot, 'x')]) {
      decisions.push(await enforce({ tool: 'Write', filePath, workRoot: root }, repoRoot));
    }
    return decisions;
  });
  const cwdOutside = await enforce({ tool: 'Edit', filePath: 'x.js', workRoot: root, cwd: outside });
  ok('enforce target: both governed roots gate and an outside cwd exempts relative Edit',
    external(cwdOutside) && scoped.every((r) => r.kind === 'edit' && r.mutating === true && r.verdict === 'block'));
  const [unknown, otherKinds] = await withRepo(async (repoRoot) => {
    const unknown = [];
    for (const opts of [{ tool: 'Edit' }, { tool: 'Bash', command: 'echo x > "$OUT"' }]) unknown.push(await enforce(opts, repoRoot));
    const otherKinds = [];
    for (const opts of [
      { tool: 'Read' }, { tool: 'Bash', command: 'git status' },
      { tool: 'Bash', command: 'npm run build' }, { tool: 'Bash', command: 'maddu hooks uninstall' },
    ]) otherKinds.push(await enforce({ filePath: join(outside, 'x'), ...opts }, repoRoot));
    return [unknown, otherKinds];
  });
  ok('enforce target: external exemption preserves unknown gates and other shape kinds',
    external(outsideWrite) && unknown.every((r) => r.mutating === true && r.action === 'gate' && r.verdict === 'block')
    && otherKinds.map((r) => r.kind).join(',') === 'read,remedy,ambiguous,self-disable');

  // Accepted contract holes: an extracted outside redirect cannot account for
  // a separate opaque write, even when both occur in the same shell segment.
  const opaqueNode = `node -e "require('fs').writeFileSync('src/x','y')" > ${quote(join(outside, 'log'))}`;
  ok('target hole: node inline write with outside stdout remains unknown',
    bash(opaqueNode, { cwd: root }) === 'unknown');
  ok('target hole: Set-Content beside an outside redirect remains unknown',
    bash(`Set-Content src/x y ; echo x > ${quote(join(outside, 'f'))}`, { cwd: root }) === 'unknown');
  ok('target hole: sudo rm beside an outside redirect remains unknown',
    bash(`sudo rm -rf ${quote(join(root, 'x'))} && echo x > ${quote(join(outside, 'f'))}`, { cwd: root }) === 'unknown');
  ok('target hole: perl in-place write beside an outside redirect remains unknown',
    bash(`perl -i -pe s/a/b/ src/x && echo x > ${quote(join(outside, 'f'))}`, { cwd: root }) === 'unknown');

  // Compare otherwise identical contexts. The base already gates the opaque
  // write, so the paired outside-only allowance makes this new row start red.
  const redirectOnly = await enforce({
    tool: 'Bash', command: `echo x > ${quote(join(outside, 'log'))}`, cwd: root, workRoot: root,
  });
  const opaqueDecision = await withRepo((repoRoot) =>
    enforce({ tool: 'Bash', command: opaqueNode, cwd: root, workRoot: root }, repoRoot));
  ok('enforce target hole: outside redirect allows while opaque node write stays gated',
    external(redirectOnly) && opaqueDecision.kind !== 'external' && opaqueDecision.kind === 'write'
    && opaqueDecision.mutating === true && opaqueDecision.action === 'gate'
    && opaqueDecision.verdict === 'block',
    `redirect=${redirectOnly.kind} opaque=${opaqueDecision.kind} verdict=${opaqueDecision.verdict}`);

  // Target-directory options do not re-admit a removed verb.
  ok('target hole: cp -t inside root is unknown',
    bash(`cp -t ${quote(root)} ${quote(join(outside, 'src'))}`, { cwd: root }) === 'unknown');
  ok('target hole: cp -t outside root with inside source is unknown',
    bash(`cp -t ${quote(outside)} ${quote(join(root, 'a'))}`, { cwd: root }) === 'unknown');
  ok('target hole: cp --target-directory inside root is unknown',
    bash(`cp --target-directory=${quote(root)} ${quote(join(outside, 'a'))}`, { cwd: root }) === 'unknown');
  ok('target hole: mv -t inside root is unknown',
    bash(`mv -t ${quote(root)} ${quote(join(outside, 'a'))}`, { cwd: root }) === 'unknown');
  ok('target hole: install -t inside root is unknown',
    bash(`install -t ${quote(root)} ${quote(join(outside, 'a'))}`, { cwd: root }) === 'unknown');
}

// Round-1 adversarial reproductions (findings 1-11). Commands are classifier
// input only, never executed. Each case has its own verdict assertion; none
// borrows an unrelated failure to make the row red against 2ebbafd.
{
  const { existsSync, lstatSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } = await import('node:fs');
  const { writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const fixtureParent = resolve(process.cwd());
  const fixture = await mkdtemp(join(fixtureParent, '.disc-r1-'));
  const root = join(fixture, 'work');
  const outside = join(fixture, 'outside');
  const slash = (p) => p.replaceAll('\\', '/');
  const quote = (p) => `"${slash(p)}"`;
  const links = [];
  const check = (name, expected, opts) => {
    let actual, error = '';
    try { actual = classifyWriteTarget?.({ roots: [root], cwd: root, ...opts }); }
    catch (e) { error = String(e?.stack || e); }
    ok(`round1 ${name}`, !error && actual === expected,
      error || `expected=${expected} actual=${actual}`);
  };
  // Link setup must fail loudly. Use junctions on Windows and file/directory
  // symlinks on POSIX; neither platform may silently skip a link reproduction.
  const linkTo = (target, link, type) => {
    symlinkSync(target, link, type);
    links.push(link);
    if (!lstatSync(link).isSymbolicLink() || !readlinkSync(link)) {
      throw new Error(`round1 link fixture is not a readable link: ${link}`);
    }
  };
  try {
    await mkdir(join(root, '~'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'source'), 'source\n');
    const src = quote(join(outside, 'source'));
    const inside = quote(join(root, 'x'));
    const log = quote(join(outside, 'log'));
    const out = quote(join(outside, 'x'));
    const bash = (name, command, expected = 'unknown', opts = {}) =>
      check(name, expected, { tool: 'Bash', command, ...opts });

    // Finding 1 also names install and trailing append/stderr variants.
    for (const verb of ['cp', 'install']) {
      for (const redirect of ['>', '>>', '2>']) {
        bash(`F1: ${verb} inside destination with ${redirect} outside log is unknown`,
          `${verb} ${src} ${inside} ${redirect} ${log}`, 'unknown');
      }
    }

    for (const [name, command] of [
      ['npm run build', `npm run build > ${log}`],
      ['npx generator', `npx generator > ${log}`],
      ['find -delete', `find ${quote(root)} -delete > ${log}`],
      ['printf piped to xargs rm', `printf '%s\\n' ${inside} | xargs rm > ${log}`],
      ['git checkout', `git checkout -- . > ${log}`],
      ['git clean', `git clean -fd > ${log}`],
      ['maddu hooks uninstall', `maddu hooks uninstall > ${log}`],
    ]) bash(`F2: ${name} with outside stdout is unknown`, command);

    for (const [name, command] of [
      ['quoted command substitution', `echo "$(rm ${inside})" > ${log}`],
      ['process substitution', `cat <(rm ${inside}) > ${log}`],
      ['subshell', `(rm ${inside}) > ${log}`],
      ['here-string executor', `bash <<< 'echo x > ${inside}' > ${log}`],
      ['nested bash -c', `bash -c 'bash -c "echo x > ${slash(join(root, 'x'))}"' > ${log}`],
      ['bash script.sh', `bash script.sh > ${log}`],
    ]) bash(`F3: ${name} with outside stdout is unknown`, command);

    bash('F4: mixed quoted and unquoted target is unknown',
      `echo x > ${slash(root).slice(0, -2)}"rk"/x`);
    bash('F4: escaped target character is unknown',
      `echo x > ${slash(root).slice(0, -1)}\\k/x`);
    bash('F4: bracket glob target is unknown', `rm ${slash(root).slice(0, -1)}[k]/x`);
    bash('F4: quoted tilde stays relative to cwd', "echo x > '~/x'", 'inside');

    bash('F5: clobber redirect retains its inside target',
      `echo x >| ${inside}; echo y > ${log}`, 'inside');

    // The quoted heredoc is admitted only as the whole special form. The
    // terminator ends its data: trailing commands/comments cannot hide in it.
    bash('F6: heredoc quote cannot hide commands after the terminator',
      `cat <<'EOF' > ${log}\n'\nEOF\necho x > ${inside}\n#'`);
    bash('F6: comment quote cannot hide the next line',
      `echo x > ${log};#'\necho x > ${inside}\n#'`);

    for (const [name, command] of [
      ['parenthesized cd', `(cd ${quote(root)}; echo x > x)`],
      ['parenthesized pushd', `(pushd ${quote(root)}; echo x > x)`],
      ['semicolon-adjacent cd', `true;cd ${quote(root)};echo x > x`],
    ]) bash(`F7: ${name} is unknown`, command, 'unknown', { cwd: outside });

    // Round 3 rejects these verbs even with formerly admitted options/scripts.
    bash('F8: attached cp -tDIR is unknown', `cp -t${slash(root)} ${src}`);
    bash('F8: sed -i -f external script is unknown',
      `sed -i -f ${quote(join(outside, 'script.sed'))} ${inside} > ${log}`);
    bash('F8: sed attached -e with an inside operand is unknown',
      `sed -i -es/a/b/ ${inside} > ${log}`, 'unknown');
    bash('F8: install -d with mixed directories is unknown',
      `install -d ${quote(join(root, 'new'))} ${quote(join(outside, 'new'))}`, 'unknown');
    bash('F8: rm -- with a dash-prefixed inside operand is unknown', `rm -- -inside ${out}`, 'unknown');
    bash('F8: mv -- with a dash-prefixed inside source is unknown', `mv -- -inside ${out}`, 'unknown');
    bash('F8: sed script with a w command is unknown',
      `sed -i 's/a/b/w ${slash(join(root, 'log'))}' ${out}`);

    const dangling = join(outside, 'dangling');
    const missingTarget = join(root, 'new-target');
    linkTo(missingTarget, dangling, process.platform === 'win32' ? 'junction' : 'file');
    if (existsSync(missingTarget) || existsSync(dangling)) throw new Error('F9 fixture must remain dangling');
    check('F9: dangling link into the root is inside', 'inside', { tool: 'Write', filePath: dangling });

    await mkdir(join(root, 'sub'));
    const directoryLink = join(outside, 'link');
    linkTo(join(root, 'sub'), directoryLink, process.platform === 'win32' ? 'junction' : 'dir');
    if (realpathSync(directoryLink) !== realpathSync(join(root, 'sub'))) {
      throw new Error('F9 directory link does not resolve to root/sub');
    }
    // Do not join/resolve the input: link/.. must survive until the classifier
    // walks the link, then applies the parent component.
    check('F9: link/../new follows the link before parent traversal', 'inside',
      { tool: 'Write', filePath: `${directoryLink}${sep}..${sep}new` });

    // A real cyclic link makes canonicalization fail without monkeypatching
    // implementation internals or relying on OS-specific permission denial.
    const cycle = join(outside, 'cycle');
    linkTo(cycle, cycle, process.platform === 'win32' ? 'junction' : 'dir');
    let realpathFailed = false;
    try { realpathSync.native(cycle); } catch { realpathFailed = true; }
    if (!realpathFailed) throw new Error('F9 cyclic-link fixture must fail realpath');
    check('F9: realpath failure cannot retain an outside verdict', 'unknown',
      { tool: 'Write', filePath: cycle });
    // F9's cp-to-a-linked-child reproduction is an end-to-end row in
    // discipline-hook.mjs; round 3 now requires unknown for the removed cp verb.

    bash('F10: /dev/shm is governed on POSIX and an unknown MSYS mount on win32',
      `echo x > /dev/shm/repo/x; echo y > ${log}`,
      process.platform === 'win32' ? 'unknown' : 'inside', { roots: ['/dev/shm/repo'] });

    check('F11: null work root cannot be discarded beside a state root', 'unknown',
      { tool: 'Write', filePath: join(root, 'x'), roots: [null, join(fixture, 'state')] });
    check('F11: null root wins even beside a matching valid root', 'unknown',
      { tool: 'Write', filePath: join(root, 'x'), roots: [null, root] });
    check('F11: relative roots are unknown', 'unknown',
      { tool: 'Write', filePath: join(root, 'x'), roots: ['relative-root'] });
    if (process.platform === 'win32') {
      const msysRoot = slash(root).replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`);
      if (msysRoot === slash(root)) throw new Error('F11 MSYS fixture requires a drive-letter root');
      check('F11: MSYS root matches a drive-letter Edit target', 'inside',
        { tool: 'Edit', filePath: slash(join(root, 'x')), roots: [msysRoot] });
    }
  } finally {
    // Unlink individually before recursive cleanup so no governed target can
    // be traversed. A cleanup failure is a harness error, never a silent pass.
    for (const link of links.reverse()) unlinkSync(link);
    if (dirname(resolve(fixture)) !== fixtureParent) throw new Error('round1 fixture escaped its parent');
    await rm(fixture, { recursive: true, force: true });
  }
}

// Round-2 reproductions. Bash strings are classifier input, never executed.
// Keep the related fd/heredoc controls in their regression rows so each new
// row exposes its own finding even when a control already passes.
{
  const { dirname } = await import('node:path');
  const fixtureParent = resolve(tmpdir());
  const fixture = await mkdtemp(join(fixtureParent, 'maddu-disc-r2-'));
  const slash = (p) => p.replaceAll('\\', '/');
  const root = slash(join(fixture, 'governed-long-root'));
  const outside = slash(join(fixture, 'outside'));
  const quote = (p) => `"${p}"`;
  const check = (name, cases, setupError = '') => {
    const results = cases.map(({ expected, ...opts }) => {
      let actual, error = setupError;
      if (!error) {
        try { actual = classifyWriteTarget({ roots: [root], cwd: root, ...opts }); }
        catch (e) { error = String(e?.stack || e); }
      }
      return { expected, actual, error };
    });
    ok(`round2 ${name}`, results.every((r) => !r.error && r.actual === r.expected),
      results.map((r) => r.error || `expected=${r.expected} actual=${r.actual}`).join('; '));
  };
  const bashCase = (command, expected) => ({ tool: 'Bash', command, expected });
  try {
    await mkdir(join(root, '.maddu'), { recursive: true });
    await mkdir(outside);
    const inside = quote(`${root}/x`);
    const log = quote(`${outside}/log`);
    const src = quote(`${outside}/src`);
    const file = quote(`${outside}/f`);

    check('F1: uniq with an inside output operand is unknown', [
      bashCase(`uniq ${quote(`${outside}/in`)} ${quote(`${root}/out`)}`, 'unknown'),
    ]);
    check('F2: cp double-quoted -t with an inside destination is unknown', [
      bashCase(`cp "-t" ${quote(root)} ${src}`, 'unknown'),
    ]);
    check('F2: cp single-quoted -t with an inside destination is unknown', [
      bashCase(`cp '-t' ${quote(root)} ${src}`, 'unknown'),
    ]);
    check('F3: head valued-option substitution is unknown', [
      bashCase(`head -n "$(rm '${root}/x')" ${file} > ${log}`, 'unknown'),
    ]);
    check('F3: truncate valued-option substitution is unknown', [
      bashCase(`truncate -s "$(rm '${root}/x')" ${file}`, 'unknown'),
    ]);
    check('F4: >&word retains an inside target with outside-file and fd controls', [
      bashCase(`echo x >&${inside}; echo y > ${log}`, 'inside'),
      bashCase(`echo x >&${quote(`${outside}/a`)}`, 'outside'),
      bashCase('echo x >&2', 'unknown'),
    ]);
    check('F5: early heredoc delimiter is unknown with a well-formed control', [
      bashCase(`cat <<'EOF' > ${log}\nEOF\necho x > ${inside}\nEOF`, 'unknown'),
      bashCase(`cat <<'EOF' > ${log}\nbody\nEOF`, 'outside'),
    ]);

    if (process.platform === 'win32') {
      const { execFileSync } = await import('node:child_process');
      const { realpathSync } = await import('node:fs');
      let shortRoot, setupError = '';
      try {
        shortRoot = slash(execFileSync('cmd', ['/c', `for %I in ("${root}") do @echo %~sI`], {
          encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 10000,
        }).trim());
        if (!shortRoot || /[\r\n]/.test(shortRoot) || !/~\d/.test(shortRoot)
          || shortRoot.toLowerCase() === root.toLowerCase()
          || realpathSync.native(shortRoot).toLowerCase() !== realpathSync.native(root).toLowerCase()) {
          throw new Error(`8.3 root spelling unavailable or invalid: ${JSON.stringify(shortRoot)}`);
        }
      } catch (e) { setupError = `8.3 fixture failed: ${String(e?.stack || e)}`; }
      // Failed short-name setup is reported by BOTH rows; it is never a skip
      // or a fallback to testing the ordinary long spelling.
      check('F6: win32 8.3 root spelling keeps Edit inside', [
        { tool: 'Edit', filePath: `${shortRoot}/x`, expected: 'inside' },
      ], setupError);
      check('F6: win32 8.3 root spelling keeps Bash inside', [
        bashCase(`echo x > ${quote(`${shortRoot}/x`)}`, 'inside'),
      ], setupError);
    }
  } finally {
    if (dirname(resolve(fixture)) !== fixtureParent) throw new Error('round2 fixture escaped temp parent');
    await rm(fixture, { recursive: true, force: true });
  }
}

// Round-3 review, first copy, findings 1-12; F13 lives in discipline-hook.
// Commands remain DATA: no shell runs any of these destructive reproductions.
// Every fixture is owned by this worktree and removed, with links unlinked first.
// Platform-only rows are explicit; a failed link setup is NOT proof of a red
// implementation assertion and is labelled FIXTURE ERROR in the run report.
{
  const fs = await import('node:fs');
  const { dirname, relative } = await import('node:path');
  const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
  const fixtureParent = resolve(process.cwd());
  const fixture = await mkdtemp(join(fixtureParent, '.disc-r3-'));
  const base = join(fixture, 'probes');
  const root = join(base, 'work');
  const outside = join(base, 'outside');
  const slash = (p) => p.replaceAll('\\', '/');
  const quote = (p) => `"${slash(p)}"`;
  const links = [];
  const linkTo = (target, link, type = 'file') => {
    fs.symlinkSync(target, link, type);
    links.push(link);
    if (!fs.lstatSync(link).isSymbolicLink() || !fs.readlinkSync(link)) {
      throw new Error(`not a readable symlink: ${link}`);
    }
  };
  const setup = (run) => {
    try { run(); return ''; }
    catch (e) { return `FIXTURE ERROR: ${e.code || ''} ${e.message}`; }
  };
  const check = (name, expected, opts, fixtureError = '') => {
    let actual, error = fixtureError;
    if (!error) {
      try { actual = classifyWriteTarget({ roots: [root], cwd: root, ...opts }); }
      catch (e) { error = `CLASSIFIER ERROR: ${e.stack || e}`; }
    }
    ok(`round3 ${name}`, !error && actual === expected,
      error || `expected=${expected} actual=${actual}`);
  };
  const bash = (name, command, expected = 'unknown', opts = {}, error = '') =>
    check(name, expected, { tool: 'Bash', command, ...opts }, error);
  try {
    fs.mkdirSync(join(root, '.maddu'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(join(root, 'x'), 'governed\n');
    fs.writeFileSync(join(outside, 'src'), 'source\n');
    fs.writeFileSync(join(outside, 'file'), 'outside\n');
    fs.writeFileSync(join(outside, 'f'), 'a\n');
    fs.writeFileSync(join(outside, 'big'), 'b\na\n');
    const src = quote(join(outside, 'src'));
    const out = quote(join(outside, 'f'));
    const log = quote(join(outside, 'log'));
    const victim = `'${slash(join(root, 'x'))}'`;

    // F1: B is a REAL directory containing R; the move destination is its sibling.
    bash('F1: rm of a directory containing the root is unknown', `rm -rf ${quote(base)}`);
    bash('F1: mv of a directory containing the root is unknown',
      `mv ${quote(base)} ${quote(join(fixture, 'moved'))}`);
    const copySource = join(outside, 'copy', 'src');
    const copyDest = join(outside, 'copy', 'dst');
    fs.mkdirSync(join(copySource, 'sub'), { recursive: true });
    fs.mkdirSync(join(copyDest, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(join(copySource, 'sub', 'x'), 'copy source\n');
    const copyError = setup(() => {
      const child = join(copyDest, 'src', 'sub', 'x');
      linkTo(join(root, 'x'), child);
      if (fs.realpathSync(child) !== fs.realpathSync(join(root, 'x')) || !fs.statSync(child).isFile()) {
        throw new Error('F1 deep destination must resolve to the governed FILE');
      }
    });
    bash('F1: recursive cp through a deep destination file symlink is unknown',
      `cp -r ${quote(copySource)} ${quote(copyDest)}`, 'unknown', {}, copyError);

    // F2: each unchecked execution-bearing token from the review has its own row.
    for (const [name, command] of [
      ['leading assignment substitution', `X="$(rm ${victim})" echo x > ${log}`],
      ['cp source substitution', `cp "$(rm ${victim})" ${quote(join(outside, 'new'))}`],
      ['cp -T source substitution', `cp -T "$(rm ${victim})" ${quote(join(outside, 'new'))}`],
      ['install source substitution', `install "$(rm ${victim})" ${quote(join(outside, 'new'))}`],
      ['dd bs substitution', `dd if=${src} of=${out} bs="$(rm ${victim})"`],
      ['sed attached -i substitution', `sed -i"$(rm ${victim})" 's/a/b/' ${out}`],
      ['sed concatenated script substitution', `sed -i 's|a|'"$(rm ${victim})"'|g' ${out}`],
      ['overwritten cp -t substitution', `cp -t "$(rm ${victim})" -t ${quote(outside)} ${src}`],
    ]) bash(`F2: ${name} is unknown`, command);

    // F3: keep the exact final FILE symlink, never a directory-junction surrogate.
    const entry = join(root, 'link');
    const entryError = setup(() => {
      linkTo(join(outside, 'file'), entry);
      if (fs.realpathSync(entry) !== fs.realpathSync(join(outside, 'file')) || !fs.statSync(entry).isFile()) {
        throw new Error('F3 inside entry must refer to the outside FILE');
      }
    });
    for (const [verb, command] of [
      ['rm', `rm ${quote(entry)}`],
      ['mv', `mv ${quote(entry)} ${quote(join(outside, 'moved'))}`],
      ['sed', `sed -i 's/a/b/' ${quote(entry)}`],
      ['install', `install ${src} ${quote(entry)}`],
    ]) bash(`F3: ${verb} of an inside symlink to outside is unknown`, command, 'unknown', {}, entryError);
    // Removing those verbs must not hide the directory-entry rule for admitted writes.
    check('F3: Write keeps the inside directory entry of an outside referent', 'inside',
      { tool: 'Write', filePath: entry }, entryError);
    bash('F3: tee keeps the inside directory entry of an outside referent',
      `tee ${quote(entry)}`, 'inside', {}, entryError);

    bash('F4: sed backup into the root is unknown', "sed -i'../work/*' 's/a/b/' f", 'unknown', { cwd: outside });
    bash('F5: TMPDIR inside with sort output outside is unknown', `TMPDIR=${quote(root)} sort ${quote(join(outside, 'big'))} > ${log}`);
    for (const verb of ['mkdir -p', 'install -d']) {
      // Preserve the literal components; new is absent before the hypothetical command.
      if (fs.existsSync(join(root, 'new'))) throw new Error('F6 new must not exist');
      bash(`F6: ${verb} with intermediate inside creation is unknown`, `${verb} ${quote(`${root}/new/../../outside`)}`);
    }

    // F7: nlink and identity checks prove this is a hard link, not two equal files.
    const hard = join(outside, 'hard');
    const hardError = setup(() => {
      // Separate inode: later symlink cases must not inherit this nlink doubt.
      const hardTarget = join(root, 'hard-x');
      fs.writeFileSync(hardTarget, 'hard-linked governed file\n');
      fs.linkSync(hardTarget, hard);
      const a = fs.statSync(hardTarget), b = fs.statSync(hard);
      if (a.nlink <= 1 || b.nlink <= 1 || a.dev !== b.dev || a.ino !== b.ino) {
        throw new Error('F7 hard links must share identity and have nlink > 1');
      }
    });
    check('F7: Write through an outside hard link is unknown', 'unknown', { tool: 'Write', filePath: hard }, hardError);
    bash('F7: redirect through an outside hard link is unknown', `echo x > ${quote(hard)}`, 'unknown', {}, hardError);
    for (const descriptor of ['stderr', 'stdout']) {
      const command = `tee /dev/${descriptor} ${log}`;
      // These aliases name the opener's fd, not a path the hook can resolve.
      bash(`F7: /dev/${descriptor} is an unresolvable descriptor alias`, command, 'unknown');
    }
    const fdAliases = ['/proc/self/fd/1', '/dev/fd/2'].map((path) => ({
      path, actual: classifyWriteTarget({ tool: 'Bash', command: `echo x > ${path}`, cwd: root, roots: [root] }),
    }));
    ok('round3 F7: /proc/self/fd/1 and /dev/fd/2 redirects are unknown',
      fdAliases.every(({ actual }) => actual === 'unknown'),
      fdAliases.map(({ path, actual }) => `${path}: expected=unknown actual=${actual}`).join('; '));
    bash('F7: /dev/tty is an ordinary path, not a sink', `tee /dev/tty ${log}`,
      process.platform === 'win32' ? 'unknown' : 'inside',
      process.platform === 'win32' ? {} : { roots: ['/dev'] });

    // F8: do not resolve() the relative link contents before creating the link.
    const relativeLink = join(outside, 'link');
    const relativeError = setup(() => {
      fs.mkdirSync(join(root, 'sub'));
      linkTo(join(root, 'sub'), join(outside, 'hop'), process.platform === 'win32' ? 'junction' : 'dir');
      linkTo('hop/../x', relativeLink);
      if (fs.readlinkSync(relativeLink).replaceAll('\\', '/') !== 'hop/../x'
        || fs.readFileSync(relativeLink, 'utf8') !== fs.readFileSync(join(root, 'x'), 'utf8')) {
        throw new Error('F8 relative link must follow hop before .. and reach R/x');
      }
    });
    check('F8: relative symlink follows hop before parent traversal', 'inside',
      { tool: 'Write', filePath: relativeLink }, relativeError);

    bash('F9: >&-inside is a filename redirect, not an fd close', `echo x >&-inside; echo y > ${log}`, 'inside');
    for (const verb of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      bash(`F10: inherited ${verb} is not a verb`, `${verb} > ${log}`);
    }

    if (process.platform !== 'win32') {
      const literal = `${root}/a\\..\\..\\outside`;
      fs.writeFileSync(literal, 'literal backslashes\n');
      check('F11: POSIX backslashes are literal filename characters', 'inside', { tool: 'Write', filePath: literal });
      const spacedRoot = join(base, 'work ');
      fs.mkdirSync(spacedRoot);
      fs.writeFileSync(join(spacedRoot, 'x'), 'trailing space in root\n');
      check('F11: a trailing space in the root is preserved', 'inside',
        { tool: 'Write', filePath: join(spacedRoot, 'x'), roots: [spacedRoot] });
      // A trimmed outside alias and an untrimmed inside alias are distinct files.
      const spacedFile = join(outside, 'spaced ');
      const spacedError = setup(() => {
        fs.writeFileSync(join(outside, 'spaced'), 'outside\n');
        linkTo(join(root, 'sub', 'spaced'), spacedFile);
        fs.writeFileSync(join(root, 'sub', 'spaced'), 'inside\n');
      });
      check('F11: a trailing space in filePath is preserved', 'inside',
        { tool: 'Write', filePath: spacedFile }, spacedError);
    } else {
      console.log('  [NOT RUN] round3 F11: 3 POSIX literal-filename rows require a POSIX filesystem');
    }
    if (process.platform === 'win32') {
      const mountTarget = `/tmp/${slash(relative(tmpdir(), root))}/x`;
      bash('F12: /tmp mount spelling cannot establish outside on win32', `echo x > ${quote(mountTarget)}`);
      bash('F12: /usr mount spelling cannot establish outside on win32', `echo x > /usr/maddu-review3/x`);
    }

    // Narrowed boundaries not isolated by the original review reproductions.
    bash('contract: even a plain leading assignment is unknown', `X=plain echo x > ${log}`);
    bash('contract: a quoted > in a producer argument is not plain', `echo 'a>b' > ${log}`);
    for (const component of ['.', '..']) {
      bash(`contract: a Bash target with ${component} component is unknown`,
        `echo x > ${quote(`${outside}/${component}/outside-file`)}`);
    }
    // These verbs had no standalone all-outside coverage in the earlier rows.
    for (const [verb, command] of [
      ['rmdir', `rmdir ${quote(join(outside, 'empty'))}`],
      ['mkdir', `mkdir -p ${quote(join(outside, 'new-dir'))}`],
      ['touch', `touch ${out}`],
      ['uniq', `uniq ${src} ${out}`],
      ['sort', `sort ${src} > ${log}`],
    ]) bash(`contract: ${verb} with all outside operands is unknown`, command);

    // Preservation: the newly unknown Bash write must reach the SAME ritual
    // decision as an ordinary inside write, and bump only its own session.
    // Relaxed mode yields a gated nudge, so a permitted write really increments.
    const counterRoot = join(fixture, 'counter-repo');
    fs.mkdirSync(join(counterRoot, '.maddu', 'config'), { recursive: true });
    fs.writeFileSync(join(counterRoot, '.maddu', 'config', 'governance.json'), JSON.stringify({ mode: 'relaxed' }));
    const sid = 'ses_round3_counter', otherSid = 'ses_round3_other';
    const seed = { editsSinceSlice: 4, goalplanAgeEdits: 2 };
    await disc.writeCounter(counterRoot, sid, seed);
    await disc.writeCounter(counterRoot, otherSid, { editsSinceSlice: 9, goalplanAgeEdits: 7 });
    const otherBefore = await disc.readCounter(counterRoot, otherSid);
    const control = await disc.enforcePreTool(counterRoot, {
      tool: 'Bash', command: 'echo x > x', cwd: counterRoot, madduSessionId: sid, nowMs: 0,
    });
    await disc.writeCounter(counterRoot, sid, seed);
    const unknownCommand = `cp ${src} ${quote(join(outside, 'counter-copy'))}`;
    const scope = classifyWriteTarget({ tool: 'Bash', command: unknownCommand, roots: [counterRoot], cwd: counterRoot });
    const result = await disc.enforcePreTool(counterRoot, {
      tool: 'Bash', command: unknownCommand, cwd: counterRoot, madduSessionId: sid, nowMs: 0,
    });
    const after = await disc.readCounter(counterRoot, sid);
    const otherAfter = await disc.readCounter(counterRoot, otherSid);
    ok('round3 preservation: unknown Bash retains the gated verdict and bumps only its session counter',
      scope === 'unknown' && control.verdict === 'nudge' && result.verdict === control.verdict
      && result.blocker === control.blocker && result.kind === 'write' && result.action === 'gate'
      && result.mutating === true && result.enforcement === control.enforcement
      && result.sid === sid && result.counterKey === sid
      && after.editsSinceSlice === 5 && after.goalplanAgeEdits === 3
      && JSON.stringify(otherAfter) === JSON.stringify(otherBefore),
      `scope=${scope} expected=nudge/gate actual=${result.verdict}/${result.action} kind=${result.kind} edits=${after.editsSinceSlice} goalEdits=${after.goalplanAgeEdits}`);

    // Outside Write stays ok; ordinary inside Write retains the pre-change
    // decide() result. A hard-link alias to the inside file is unknown and must
    // receive that same result too. The alias exposes the faulty early return
    // without needing file-symlink privileges for this preservation row.
    const evalOpts = { tool: 'Write', cwd: root, madduSessionId: 'invalid/session', nowMs: 0 };
    const thresholds = resolveThresholds('standard');
    const state = await disc.gatherRitualState(root, null, 0, { editsSinceSlice: 0, dirtyBaseline: [] }, { workRoot: root });
    const before = decide({ thresholds, state, counter: { editsSinceSlice: 0, dirtyBaseline: [] }, toolCtx: { isMutating: true } });
    const outsideEval = await disc.evaluateDiscipline(root, { ...evalOpts, filePath: join(outside, 'file') });
    const insideEval = await disc.evaluateDiscipline(root, { ...evalOpts, filePath: join(root, 'hard-x') });
    const aliasEval = hardError ? null : await disc.evaluateDiscipline(root, { ...evalOpts, filePath: hard });
    ok('round3 preservation: evaluateDiscipline allows outside Write and preserves inside and alias Write verdicts',
      !hardError && outsideEval.verdict === 'ok' && before.verdict === 'block' && before.blocker === 'session'
      && JSON.stringify(insideEval) === JSON.stringify(before) && JSON.stringify(aliasEval) === JSON.stringify(before),
      hardError || `outside=${outsideEval.verdict} expectedInside=${before.verdict}/${before.blocker} inside=${insideEval.verdict}/${insideEval.blocker} alias=${aliasEval?.verdict}/${aliasEval?.blocker}`);
  } finally {
    for (const link of links.reverse()) fs.unlinkSync(link);
    if (dirname(resolve(fixture)) !== fixtureParent) throw new Error('round3 fixture escaped its parent');
    await rm(fixture, { recursive: true, force: true });
  }
}

console.log('');
console.log(`discipline: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('discipline OK');
process.exit(0);
