// acceptance-proven-gate — SUPERVISOR-authored adversarial suite for the PR-2
// gate campaign (.maddu/state/pr2-gate-plan.md; r2/r3 sections override the
// base text). Written from the PLAN, independently of the implementation, per
// the implementer-never-writes-its-own-suite rule.
//
// CONTROL FIRST WITH HARD EXIT: a real RED→GREEN proof (driven through the
// shipped W1 orient wiring) must turn the gate GREEN — if it does not, every
// later negative is vacuous and the run aborts.
//
// Most cases drive the gate MODULE directly with a constructed ctx
// ({repoRoot, roots, nowMs}) against CLI-built fixture repos; the worktree
// case goes through the REAL runner surface (`maddu doctor`) because the
// runner's own roots resolution is part of the contract (plan r3 #3).

import { mkdtemp, mkdir, readdir, writeFile, appendFile, cp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hermeticEnv } from './_hermetic-env.mjs';

const LIB = (f) => pathToFileURL(join(process.cwd(), 'template', 'maddu', 'runtime', 'lib', f)).href;
const GATE = pathToFileURL(join(process.cwd(), 'template', 'maddu', 'runtime', 'gates', 'builtin', 'acceptance-proven.mjs')).href;
const BIN = join(process.cwd(), 'bin', 'maddu.mjs');
const NODE = process.execPath;

const gate = (await import(GATE)).default;
const spine = await import(LIB('spine.mjs'));
const verify = await import(LIB('verify.mjs'));
const projections = await import(LIB('projections.mjs'));

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : `  ${detail}`}`);
  cond ? passed++ : failed++;
};

const scratch = await mkdtemp(join(tmpdir(), 'acc-gate-'));

const run = (args, cwd, envOver = {}) =>
  spawnSync(NODE, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 180000, env: hermeticEnv(envOver) });

const oracleCmd = (root) =>
  `"${NODE}" -e "const fs=require('fs');fs.appendFileSync('count.txt','x');process.exit(fs.readFileSync('src/a.txt','utf8').includes('fixed')?0:1)"`;

async function makeRepo(tag) {
  const root = await mkdtemp(join(scratch, tag + '-'));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'oracle'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.maddu', 'config'), { recursive: true });
  await writeFile(join(root, 'oracle', 't.txt'), 'oracle-v1\n');
  await writeFile(join(root, 'src', 'a.txt'), 'impl-v1\n');
  await spine.ensureSpine(root);
  return root;
}

const declareGoal = (root, { conditions = null, sets = true } = {}) => {
  const conds = conditions || [`${oracleCmd(root)}::impl says fixed`];
  const args = ['goal', 'set', '--objective', 'gate fixture goal'];
  for (const c of conds) args.push('--success', c);
  if (sets) args.push('--oracle', 'oracle/**', '--impl', 'src/**');
  return run(args, root);
};

// Faithful to gates.mjs buildCtx: the runner supplies the lib modules; a gate
// consumes ctx.verify/ctx.projections, never its own imports.
const ctxFor = (root, extra = {}) => ({
  repoRoot: root,
  roots: { workRoot: root, stateRoot: root },
  spine, verify, projections,
  project: (r) => projections.project(r || root),
  ...extra,
});

// Build a PROVEN repo: declare, orient (RED), fix impl, orient (GREEN).
async function provenRepo(tag, opts = {}) {
  const root = await makeRepo(tag);
  declareGoal(root, opts);
  run(['orient'], root);
  await writeFile(join(root, 'src', 'a.txt'), 'impl-v2 fixed\n');
  run(['orient'], root);
  return root;
}

const LIMITS_RE = /limit/i;

async function main() {
  // ── CONTROL (hard exit): a real proof turns the gate green ───────────────
  {
    const root = await provenRepo('control');
    const r = await gate.run(ctxFor(root));
    const good = r && r.ok === true && /worktree/.test(r.message) && /1\/1/.test(r.message) && LIMITS_RE.test(r.message);
    ok('CONTROL: proven repo → gate green, tier + 1/1 + limits pointer in message', good, JSON.stringify(r));
    if (!good) { console.log('CONTROL FAILED — aborting, everything else would be vacuous'); return 1; }
    ok('gate shape: id + warn severity', gate.id === 'acceptance-proven' && gate.severity === 'warn');

    // Freshness through the SEAM (r2 #7): same repo, nowMs two days ahead,
    // policy 1d → expired, never green.
    await writeFile(join(root, 'maddu.json'), JSON.stringify({ acceptance: { maxProofAge: '1d' } }) + '\n');
    const aged = await gate.run(ctxFor(root, { nowMs: Date.now() + 2 * 86400000 }));
    ok('aged past maxProofAge → red naming expired', aged.ok === false && /expired/i.test(aged.message), JSON.stringify(aged));
    const fresh = await gate.run(ctxFor(root));
    ok('same policy at real now → still green', fresh.ok === true, JSON.stringify(fresh));
    await rm(join(root, 'maddu.json'), { force: true });

    // Stale impl (historically-proven is NOT green) + orient agreement. The
    // edit REMOVES the passing marker: orient re-observes on every run, and an
    // edit that still passes would legitimately re-green a fresh pair — the
    // agreement claim is about the shared view, so the fixture must go to a
    // genuinely non-live state on both surfaces.
    await writeFile(join(root, 'src', 'a.txt'), 'impl-v3 no longer passing\n');
    const stale = await gate.run(ctxFor(root));
    ok('impl moved after GREEN → red naming the liveness reason',
      stale.ok === false && /impl/i.test(stale.message) && LIMITS_RE.test(stale.message), JSON.stringify(stale));
    const oj = JSON.parse(run(['orient', '--json'], root).stdout || '{}');
    const rows = Array.isArray(oj.proofs) ? oj.proofs : [];
    ok('orient agrees: no live row while the gate is red',
      rows.length === 1 && rows[0].state !== 'live', JSON.stringify(rows));
  }

  // ── post-GREEN ORACLE edit (r3 #5): the view hashes the CURRENT oracle ───
  {
    const root = await provenRepo('oracle-edit');
    await writeFile(join(root, 'oracle', 't.txt'), 'oracle-v2 EDITED\n');
    const r = await gate.run(ctxFor(root));
    ok('oracle edited after GREEN → red naming oracle-changed',
      r.ok === false && /oracle/i.test(r.message), JSON.stringify(r));
    const oj = JSON.parse(run(['orient', '--json'], root).stdout || '{}');
    const rows = Array.isArray(oj.proofs) ? oj.proofs : [];
    ok('orient agrees on the oracle-changed condition',
      rows.length === 1 && rows[0].state !== 'live', JSON.stringify(rows));
  }

  // ── the three DISTINCT nothing-declared axes (all red, all distinct) ─────
  {
    const noGoal = await makeRepo('axis-nogoal');
    const a = await gate.run(ctxFor(noGoal));
    const textOnly = await makeRepo('axis-textonly');
    declareGoal(textOnly, { conditions: ['a text-only condition'] });
    const b = await gate.run(ctxFor(textOnly));
    const noSets = await makeRepo('axis-nosets');
    declareGoal(noSets, { sets: false });
    const c = await gate.run(ctxFor(noSets));
    ok('no goal → red', a.ok === false && /goal/i.test(a.message), JSON.stringify(a));
    ok('no verifiable condition → red', b.ok === false, JSON.stringify(b));
    ok('no declared sets → red naming the declaration', c.ok === false && /(oracle|impl|set|declar)/i.test(c.message), JSON.stringify(c));
    ok('the three axes are pairwise DISTINCT messages',
      a.message !== b.message && b.message !== c.message && a.message !== c.message,
      JSON.stringify([a.message, b.message, c.message]));
    ok('negative messages carry the limits pointer too',
      [a, b, c].every((r) => LIMITS_RE.test(r.message)), JSON.stringify([a.message, b.message, c.message]));
  }

  // ── zero observations: declared, never observed → unproven, named (r2 #3) ─
  {
    const root = await makeRepo('unobserved');
    declareGoal(root);
    const r = await gate.run(ctxFor(root));
    ok('declared-but-never-observed → red naming unproven/never-observed',
      r.ok === false && /(unproven|never.*observed)/i.test(r.message), JSON.stringify(r));
  }

  // ── no-red history: GREEN only → unproven ────────────────────────────────
  {
    const root = await makeRepo('greenonly');
    await writeFile(join(root, 'src', 'a.txt'), 'impl already fixed\n');
    declareGoal(root);
    run(['orient'], root);
    const r = await gate.run(ctxFor(root));
    ok('GREEN-only history → red (a pass with no prior RED proves nothing)',
      r.ok === false && /(unproven|no.*red|never)/i.test(r.message), JSON.stringify(r));
  }

  // ── mixed conditions: every-verifiable rule + denominator (r2 #6) ────────
  {
    const root = await makeRepo('mixed');
    const c2 = `"${NODE}" -e "const fs=require('fs');process.exit(fs.existsSync('second-fixed.txt')?0:1)"`;
    declareGoal(root, { conditions: ['a text-only condition', `${oracleCmd(root)}::first`, `${c2}::second`] });
    run(['orient'], root);                                     // both RED
    await writeFile(join(root, 'src', 'a.txt'), 'impl-v2 fixed\n');
    run(['orient'], root);                                     // first GREEN, second still RED
    const half = await gate.run(ctxFor(root));
    ok('1/2 live → red with the 1/2 denominator (verifiable only)',
      half.ok === false && /1\/2/.test(half.message), JSON.stringify(half));
    await writeFile(join(root, 'second-fixed.txt'), 'yes\n');  // second's impl set is src/** — must move it too
    await writeFile(join(root, 'src', 'a.txt'), 'impl-v2 fixed plus second\n');
    run(['orient'], root);
    const full = await gate.run(ctxFor(root));
    ok('2/2 live → green with 2/2', full.ok === true && /2\/2/.test(full.message), JSON.stringify(full));
  }

  // ── integrity broken: suppression, one vocabulary with orient ────────────
  {
    const root = await provenRepo('broken');
    const evDir = join(root, '.maddu', 'events');
    const segs = await readdir(evDir);
    await appendFile(join(evDir, segs.find((f) => f.endsWith('.ndjson'))), '{"not":"a spine event"}\n');
    const r = await gate.run(ctxFor(root));
    ok('broken chain → red as suppressed/unverified, never green',
      r.ok === false && /(integrit|suppressed|verification)/i.test(r.message), JSON.stringify(r));
    const oj = JSON.parse(run(['orient', '--json'], root).stdout || '{}');
    ok('orient agrees: proofs suppressed for integrity',
      !!oj.proofs && oj.proofs.suppressed === 'integrity', JSON.stringify(oj.proofs));
  }

  // ── team-sync: unsupported, red, no crash ────────────────────────────────
  {
    const root = await provenRepo('sync');
    const si = run(['spine', 'sync', 'init'], root);
    if (si.status !== 0) {
      ok('spine sync init succeeded (fixture prerequisite)', false, si.stderr.slice(0, 200));
    } else {
      const r = await gate.run(ctxFor(root));
      ok('team-sync mode → red naming team-sync', r.ok === false && /team-sync/i.test(r.message), JSON.stringify(r));
    }
  }

  // ── completed goal → red; orient agrees (r3 #2 agreement case) ───────────
  {
    const root = await provenRepo('completed');
    run(['goal', 'done', '--force'], root);
    const r = await gate.run(ctxFor(root));
    ok('completed goal → red (a closed goal proves nothing forward)',
      r.ok === false && /goal/i.test(r.message), JSON.stringify(r));
    const oj = JSON.parse(run(['orient', '--json'], root).stdout || '{}');
    const anyLive = Array.isArray(oj.proofs) && oj.proofs.some((row) => row && row.state === 'live');
    ok('orient agrees: no live proof rendered for a completed goal', !anyLive, JSON.stringify(oj.proofs));
  }

  // ── redeclared goal → the old proof cannot green the new declaration ─────
  {
    const root = await provenRepo('redeclared');
    declareGoal(root, { conditions: [`${oracleCmd(root)}::same command, new declaration`] });
    const r = await gate.run(ctxFor(root));
    ok('redeclaration kills the prior proof (red until re-proven)', r.ok === false, JSON.stringify(r));
  }

  // ── orphan RAN: never green, never a crash ───────────────────────────────
  {
    const root = await makeRepo('orphan');
    declareGoal(root);
    await spine.append(root, {
      type: 'VERIFICATION_RAN', actor: null, lane: null,
      data: { kind: 'acceptance', startedId: 'evt_00000000000000_000000', observation_status: 'eligible', outcome_class: 'process-pass', result: 'pass', complete: true },
    });
    const r = await gate.run(ctxFor(root));
    ok('orphan RAN → red, no crash', r.ok === false, JSON.stringify(r));
  }

  // ── malformed nested declaration (schema-valid) → named red, no throw ────
  {
    const root = await makeRepo('malformed');
    await spine.append(root, {
      type: 'GOAL_DECLARED', actor: null, lane: null,
      data: { objective: 'malformed fixture', constraints: [], success: [{ text: 'bad', verify: 42 }], oracle: ['oracle/**'], implementation: [42] },
    });
    let res = null, threw = false;
    try { res = await gate.run(ctxFor(root)); } catch { threw = true; }
    ok('malformed nested declaration → typed red, never a throw',
      !threw && res && res.ok === false, JSON.stringify(res));
    const o = run(['orient'], root);
    ok('orient survives the malformed declaration (exit 0)', o.status === 0, o.stderr.slice(0, 200));
  }

  // ── FALSY malformed verify cannot shrink the denominator (funnel r1 #1) ──
  // The planted offender: one PROVABLE condition plus `verify:0`. A
  // truthiness-based mapping drops the malformed row as "text-only" and
  // greens 1/1; presence-based validation must red as declaration-invalid.
  {
    const root = await makeRepo('falsy-verify');
    await spine.append(root, {
      type: 'GOAL_DECLARED', actor: null, lane: null,
      data: { objective: 'falsy fixture', constraints: [], success: [{ text: 'good', verify: oracleCmd(root) }, { text: 'bad', verify: 0 }], oracle: ['oracle/**'], implementation: ['src/**'] },
    });
    run(['orient'], root);
    await writeFile(join(root, 'src', 'a.txt'), 'impl-v2 fixed\n');
    run(['orient'], root);                       // the good condition is now provable
    const r = await gate.run(ctxFor(root));
    ok('falsy verify → red declaration-invalid, never a shrunken-denominator green',
      r.ok === false && /declaration|encoded|identity/i.test(r.message), JSON.stringify(r));
  }

  // ── refusal wording honesty (funnel r1 #2/#3) ────────────────────────────
  {
    const noGoal = await makeRepo('word-nogoal');
    const a = await gate.run(ctxFor(noGoal));
    const done = await provenRepo('word-done');
    run(['goal', 'done', '--force'], done);
    const b = await gate.run(ctxFor(done));
    ok('closed-goal refusal is DISTINCT from no-goal (no false "declare one")',
      b.ok === false && b.message !== a.message && !/declare one/i.test(b.message), JSON.stringify(b.message));
    const oracleOnly = await makeRepo('word-oracleonly');
    run(['goal', 'set', '--objective', 'x', '--success', 'true::t', '--oracle', 'oracle/**'], oracleOnly);
    const c = await gate.run(ctxFor(oracleOnly));
    ok('impl-missing refusal names the implementation-binding clause, not the oracle',
      c.ok === false && /--impl/.test(c.message) && !/no declared oracle/i.test(c.message), JSON.stringify(c.message));
  }

  // ── attached worktree through the REAL runner (r3 #3) ────────────────────
  {
    const primary = await makeRepo('wt-primary');
    const work = await mkdtemp(join(scratch, 'wt-work-'));
    execFileSync('git', ['init', '-q', work]);
    await mkdir(join(work, 'oracle'), { recursive: true });
    await mkdir(join(work, 'src'), { recursive: true });
    await writeFile(join(work, 'oracle', 't.txt'), 'oracle-v1\n');
    await writeFile(join(work, 'src', 'a.txt'), 'impl-v1\n');
    await writeFile(join(work, '.maddu-state-root'), primary + '\n');
    // Declare + prove FROM THE WORKTREE (decl.cwd binds the checkout).
    const g = run(['goal', 'set', '--objective', 'wt goal', '--success', `${oracleCmd(work)}::wt`, '--oracle', 'oracle/**', '--impl', 'src/**'], work);
    ok('worktree fixture: goal declared', g.status === 0, g.stderr.slice(0, 200));
    run(['orient'], work);
    await writeFile(join(work, 'src', 'a.txt'), 'impl-v2 fixed\n');
    run(['orient'], work);
    // The REAL runner (runGates) invoked from the WORKTREE cwd — its own
    // resolveGateRoots must produce the split pair (r3 #3). `maddu doctor`
    // short-circuits on a fixture without maddu.json before reaching the gate
    // list (implementer report), so the runner is driven directly, standing
    // where an operator would stand.
    const runnerScript = join(scratch, 'run-gates-from-worktree.mjs');
    await writeFile(runnerScript, [
      `import { runGates } from ${JSON.stringify(LIB('gates.mjs'))};`,
      `const res = await runGates(${JSON.stringify(primary)}, { emitEvents: false });`,
      `const row = res.runs.find((r) => r.gateId === 'acceptance-proven');`,
      `console.log(JSON.stringify(row || null));`,
    ].join('\n'));
    const gateFromWorktree = () => {
      const r = spawnSync(NODE, [runnerScript], { cwd: work, encoding: 'utf8', timeout: 180000, env: hermeticEnv() });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { return { parseError: r.stdout, stderr: r.stderr }; }
    };
    const w1 = gateFromWorktree();
    ok('real runner from the worktree: green after the worktree proof',
      !!w1 && w1.ok === true, JSON.stringify(w1));
    await writeFile(join(work, 'src', 'a.txt'), 'impl-v3 moved\n');
    const w2 = gateFromWorktree();
    ok('real runner from the worktree: red after the WORKTREE impl moved',
      !!w2 && w2.ok === false && /impl/i.test(w2.message || ''), JSON.stringify(w2));

    // An EXPLICIT roots pair beats the invoker's standing worktree (funnel
    // r4 #3): `doctor --all` iterating registered workspaces must judge each
    // workspace's own tree, not pair the primary target with this cwd's
    // worktree. The equal-pair override from the worktree cwd must judge the
    // PRIMARY (whose cwd-bound decls have no worktree proof ⇒ red), while
    // the cwd-derived run above judged the worktree (green then red).
    const overrideScript = join(scratch, 'run-gates-override.mjs');
    await writeFile(overrideScript, [
      `import { runGates } from ${JSON.stringify(LIB('gates.mjs'))};`,
      `const res = await runGates(${JSON.stringify(primary)}, { emitEvents: false, roots: { workRoot: ${JSON.stringify(primary)}, stateRoot: ${JSON.stringify(primary)} } });`,
      `console.log(JSON.stringify(res.runs.find((r) => r.gateId === 'acceptance-proven') || null));`,
    ].join('\n'));
    const ov = spawnSync(NODE, [overrideScript], { cwd: work, encoding: 'utf8', timeout: 180000, env: hermeticEnv() });
    let ovRow = null;
    try { ovRow = JSON.parse((ov.stdout || '').trim().split('\n').pop()); } catch {}
    ok('explicit roots pair overrides the standing worktree (judges the target, not the cwd)',
      !!ovRow && ovRow.ok === false, JSON.stringify(ovRow));

    // The standalone STATE-root walk consumers like doctor use (gate funnel
    // r2 #1, canonical-parity semantics per r5 #1): env → pointer → local,
    // marker-gated, and a non-blank INVALID env/pointer target THROWS — the
    // canonical misconfiguration law, never a silent substitute state.
    const RES = await import(pathToFileURL(join(process.cwd(), 'commands', '_resolve.mjs')).href);
    ok('findStateRoot follows the pointer from a plain worktree',
      await RES.findStateRoot(work) === primary, String(await RES.findStateRoot(work)));
    await mkdir(join(work, '.maddu'), { recursive: true });
    ok('findStateRoot: pointer beats a local .maddu (canonical precedence)',
      await RES.findStateRoot(work) === primary, String(await RES.findStateRoot(work)));
    ok('findStateRoot: a VALID env override beats the pointer',
      await RES.findStateRoot(work, { MADDU_STATE_ROOT: work }) === work,
      String(await RES.findStateRoot(work, { MADDU_STATE_ROOT: work })));
    {
      let threw = false;
      try { await RES.findStateRoot(work, { MADDU_STATE_ROOT: join(work, 'nowhere') }); } catch { threw = true; }
      ok('findStateRoot: an INVALID env override throws (never a silent substitute)', threw);
    }
    {
      const orphan = await mkdtemp(join(scratch, 'orphan-'));
      await writeFile(join(orphan, '.maddu-state-root'), join(orphan, 'nowhere') + '\n');
      await mkdir(join(orphan, '.maddu'), { recursive: true });
      let threw = false;
      try { await RES.findStateRoot(orphan, {}); } catch { threw = true; }
      ok('findStateRoot: a dangling pointer throws (canonical misconfiguration law)', threw);
    }
    {
      const bare = await mkdtemp(join(scratch, 'bare-'));
      ok('findStateRoot: no marker anywhere → null even with a valid env set',
        await RES.findStateRoot(bare, { MADDU_STATE_ROOT: primary }) === null,
        String(await RES.findStateRoot(bare, { MADDU_STATE_ROOT: primary })));
    }
  }

  return failed === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.log('[FAIL] suite crashed:', err && err.stack || err);
  failed++;
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
console.log(`\nacceptance-proven-gate: ${passed} passed, ${failed} failed`);
process.exit(code || (failed ? 1 : 0));
