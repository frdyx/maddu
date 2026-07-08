#!/usr/bin/env node
// discipline — the pure self-discipline evaluator (P1). Locks the decision core
// (decide), the governance-mode thresholds (resolveThresholds), and the Bash
// write-classifier (classifyBashWrite). The impure gather/hook paths are covered
// by later phases; this file needs no spine, git, or DOM.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

const { resolveThresholds, decide, classifyBashWrite, denyReason, DISCIPLINE_DEFAULTS } =
  await import('../../template/maddu/runtime/lib/discipline.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── classifyBashWrite ───────────────────────────────────────────────────────
const W = (c) => classifyBashWrite(c) === 'write';
const R = (c) => classifyBashWrite(c) === 'remedy';
const A = (c) => classifyBashWrite(c) === 'allow';

ok('write: redirect > file', W('echo hi > src/a.js'));
ok('write: append >> file', W('cat x >> out.txt'));
ok('write: sed -i', W('sed -i "s/a/b/" f.js'));
ok('write: tee', W('cat x | tee f'));
ok('write: mv/cp/rm/dd/truncate', W('mv a b') && W('cp a b') && W('rm -rf x') && W('dd if=a of=b') && W('truncate -s0 f'));
ok('write: PowerShell Set-Content/Out-File/Remove-Item', W('Set-Content f x') && W('foo | Out-File f') && W('Remove-Item f'));

ok('allow: 2>&1 is not a file write', A('make 2>&1'));
ok('allow: >/dev/null is not a repo write', A('cmd >/dev/null'));
ok('allow: read-only ls/cat/grep', A('ls -la') && A('cat f') && A('grep x f'));
ok('allow: ambiguous build step', A('npm run build'));
ok('allow: ambiguous interpreter -c/-e', A('python -c "open(0)"') && A('node -e "x"'));

ok('remedy: bare maddu verbs', R('maddu slice-stop "x"') && R('maddu goal set "g"') && R('maddu plan new "t"') && R('maddu lane claim l') && R('maddu register'));
ok('remedy: node bin/maddu.mjs form', R('node bin/maddu.mjs slice-stop "x"'));
ok('remedy: ./maddu/run form', R('./maddu/run slice-stop "x"'));
ok('remedy: git status/diff/add/commit/log', R('git status') && R('git commit -F m.txt') && R('git add -A') && R('git diff') && R('git log -1'));
ok('remedy beats write: git commit never classed write', classifyBashWrite('git commit -F .maddu/tmp/msg') === 'remedy');
ok('no blanket maddu: maddu upgrade is NOT a remedy', classifyBashWrite('maddu upgrade') !== 'remedy');
ok('no blanket git: git checkout -- . is NOT a remedy', classifyBashWrite('git checkout -- .') !== 'remedy');
ok('empty/nullish → allow', A('') && A('   ') && classifyBashWrite(null) === 'allow' && classifyBashWrite(undefined) === 'allow');

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

console.log('');
console.log(`discipline: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('discipline OK');
process.exit(0);
