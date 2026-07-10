#!/usr/bin/env node
// discipline — the pure self-discipline evaluator (P1). Locks the decision core
// (decide), the governance-mode thresholds (resolveThresholds), and the Bash
// write-classifier (classifyBashWrite). The impure gather/hook paths are covered
// by later phases; this file needs no spine, git, or DOM.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

const { resolveThresholds, decide, classifyBashWrite, denyReason, DISCIPLINE_DEFAULTS,
  nextCounter, enforcePreTool, lastOwnSliceStop } =
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
ok('nextCounter: firstDirtyTs anchors on first dirty',
  nextCounter({ firstDirtyTs: null }, St({ commit: { newDirtyFiles: 3 } }), 1000).firstDirtyTs === 1000);
ok('nextCounter: firstDirtyTs clears when clean',
  nextCounter({ firstDirtyTs: 1000 }, St({ commit: { newDirtyFiles: 0 } }), 5000).firstDirtyTs === null);
ok('nextCounter: goal/plan active resets grace anchors',
  (() => { const c = nextCounter({ goalplanFirstTs: 500, goalplanAgeEdits: 3 }, St(), 0); return c.goalplanFirstTs === null && c.goalplanAgeEdits === 0; })());
ok('nextCounter: goal/plan inactive anchors the grace clock',
  nextCounter({ goalplanFirstTs: null }, St({ goalOrPlan: { active: false } }), 600000).goalplanFirstTs === 600000);
ok('nextCounter: goalplanAgeMin derived from anchor',
  Math.round(nextCounter({ goalplanFirstTs: 1000 }, St({ goalOrPlan: { active: false } }), 601000).goalplanAgeMin) === 10);
ok('nextCounter: firstDirtyTs of 0 is preserved (== null guard, not falsy)',
  nextCounter({ firstDirtyTs: 0 }, St({ commit: { newDirtyFiles: 2 } }), 9000).firstDirtyTs === 0);

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

console.log('');
console.log(`discipline: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('discipline OK');
process.exit(0);
