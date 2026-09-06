#!/usr/bin/env node
// discipline — the pure self-discipline evaluator (P1). Locks the decision core
// (decide), the governance-mode thresholds (resolveThresholds), and the Bash
// write-classifier (classifyBashWrite). The impure gather/hook paths are covered
// by later phases; this file needs no spine, git, or DOM.
// Target scope exempts resolved outside writes; inside and unknown writes retain discipline enforcement.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

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
  ok('target: mv scopes every source and destination',
    bash(`mv ${quote(join(root, 'a'))} ${quote(join(outside, 'b'))}`) === 'inside'
    && bash(`mv ${quote(join(outside, 'a'))} ${quote(join(outside, 'b'))}`) === 'outside');
  ok('target: cp and install scope only the destination',
    all([bash(`cp ${quote(join(root, 'a'))} ${quote(join(outside, 'b'))}`),
      bash(`install ${quote(join(root, 'a'))} ${quote(join(outside, 'b'))}`)], 'outside')
    && all([bash(`cp ${quote(join(outside, 'a'))} ${quote(join(root, 'b'))}`),
      bash(`install ${quote(join(outside, 'a'))} ${quote(join(root, 'b'))}`)], 'inside'));
  ok('target: rm scopes every non-flag operand',
    bash(`rm -rf ${quote(join(outside, 'x'))}`) === 'outside'
    && bash(`rm -rf ${quote(join(outside, 'x'))} ${quote(join(root, 'y'))}`) === 'inside');
  ok('target: tee, sed, dd, and truncate extract write operands',
    all([bash(`tee -a ${quote(join(outside, 'log'))}`),
      bash(`sed -i 's/a/b/' ${quote(join(outside, 'f'))}`),
      bash(`dd if=x of=${quote(join(outside, 'y'))}`),
      bash(`truncate -s0 ${quote(join(outside, 'f'))}`)], 'outside')
    && bash(`sed -i -e 's/a/b/' ${quote(join(root, 'f'))}`, { cwd: root }) === 'inside'
    && bash(`sed -i --expression 's/a/b/' ${quote(join(root, 'f'))}`, { cwd: root }) === 'inside'
    && bash(`tee -a ${quote(join(outside, 'log'))} ${quote(join(root, 'log'))}`) === 'inside');
  ok('target: shell wrapper payload redirects are extracted',
    all([bash(`bash -lc "echo x > '${join(outside, 'f').replaceAll('\\', '/')}'"`),
      bash(`sh -c "echo x > '${join(outside, 'f').replaceAll('\\', '/')}'"`)], 'outside'));
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
  const enforce = (opts) => enforcePreTool(bogusRepo, { madduSessionId: 'invalid/session', ...opts });
  const external = (r) => r.verdict === 'ok' && r.kind === 'external'
    && r.mutating === false && r.action === 'allow' && r.enforcement === 'n/a';
  const outsideWrite = await enforce({ tool: 'Write', filePath: join(outside, 'x.js') });
  const outsideBash = await enforce({ tool: 'Bash', command: redirect });
  const mixedWrite = await enforce({ tool: 'Bash', command: `${redirect} && rm -rf src`, cwd: bogusRepo });
  const insideEdit = await enforce({ tool: 'Edit', filePath: 'x.js', nowMs: 0 });
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
  const scoped = [];
  for (const filePath of [join(root, 'x'), join(bogusRepo, 'x')]) {
    scoped.push(await enforce({ tool: 'Write', filePath, workRoot: root }));
  }
  const cwdOutside = await enforce({ tool: 'Edit', filePath: 'x.js', workRoot: root, cwd: outside });
  ok('enforce target: both governed roots gate and an outside cwd exempts relative Edit',
    external(cwdOutside) && scoped.every((r) => r.kind === 'edit' && r.mutating === true && r.verdict === 'block'));
  const unknown = [];
  for (const opts of [{ tool: 'Edit' }, { tool: 'Bash', command: 'echo x > "$OUT"' }]) unknown.push(await enforce(opts));
  const otherKinds = [];
  for (const opts of [
    { tool: 'Read' }, { tool: 'Bash', command: 'git status' },
    { tool: 'Bash', command: 'npm run build' }, { tool: 'Bash', command: 'maddu hooks uninstall' },
  ]) otherKinds.push(await enforce({ filePath: join(outside, 'x'), ...opts }));
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
  const opaqueDecision = await enforce({ tool: 'Bash', command: opaqueNode, cwd: root, workRoot: root });
  ok('enforce target hole: outside redirect allows while opaque node write stays gated',
    external(redirectOnly) && opaqueDecision.kind !== 'external' && opaqueDecision.kind === 'write'
    && opaqueDecision.mutating === true && opaqueDecision.action === 'gate'
    && opaqueDecision.verdict === 'block',
    `redirect=${redirectOnly.kind} opaque=${opaqueDecision.kind} verdict=${opaqueDecision.verdict}`);

  // A target-directory option supplies the destination independently of the
  // last operand. Copying FROM the root still does not write its source.
  ok('target hole: cp -t inside root writes inside',
    bash(`cp -t ${quote(root)} ${quote(join(outside, 'src'))}`, { cwd: root }) === 'inside');
  ok('target hole: cp -t outside root writes outside despite inside source',
    bash(`cp -t ${quote(outside)} ${quote(join(root, 'a'))}`, { cwd: root }) === 'outside');
  ok('target hole: cp --target-directory inside root writes inside',
    bash(`cp --target-directory=${quote(root)} ${quote(join(outside, 'a'))}`, { cwd: root }) === 'inside');
  ok('target hole: mv -t inside root writes inside',
    bash(`mv -t ${quote(root)} ${quote(join(outside, 'a'))}`, { cwd: root }) === 'inside');
  ok('target hole: install -t inside root writes inside',
    bash(`install -t ${quote(root)} ${quote(join(outside, 'a'))}`, { cwd: root }) === 'inside');
}

console.log('');
console.log(`discipline: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('discipline OK');
process.exit(0);
