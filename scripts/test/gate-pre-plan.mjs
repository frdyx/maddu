#!/usr/bin/env node
// gate-pre-plan (v1.157.0, system1 U2) — a gate can refuse `plan new`.
//
// THE GAP THIS GUARDS (present through v1.156.0)
// ─────────────────────────────────────────────
// Gates ran only in `doctor`, `ci run` and `audit`: after the fact. Nothing in
// Máddu could refuse `plan new`, so a host whose rule is "no plan before the
// intake is complete" (system1) had to wrap the verb in its own CLI and block
// every raw `maddu plan new` with a PreToolUse guard. The rule lived outside
// the framework, and any caller that skipped the wrapper skipped the rule.
//
// What is asserted:
//   1. LIBRARY — runGates({ phase }) runs only gates that declare that phase,
//                hands them the caller's extra context on top of the normal
//                one, and keeps a gate file that failed to load (it may have
//                been a gate of that phase, so it can't be skipped silently).
//                Without `phase` nothing changes: a phased gate still runs in
//                doctor/ci.
//   2. COMMAND — a failing pre-plan gate refuses `plan new` (exit 1, gate id
//                on stderr, no PLAN_CREATED); a `verdict: 'hold'` refusal
//                exits 2; a passing one lets it through; a failing gate with
//                no phase is not consulted; a repo with no phased gates is
//                unchanged.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hermeticEnv } from './_hermetic-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLI = join(ROOT, 'bin', 'maddu.mjs');
const LIB = join(ROOT, 'template', 'maddu', 'runtime', 'lib');
const gates = await import(pathToFileURL(join(LIB, 'gates.mjs')).href);
const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => String(s || '').replace(ANSI_RE, '');

function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', timeout: 60000, env: hermeticEnv(),
  });
  return { ...r, stdout: strip(r.stdout), stderr: strip(r.stderr) };
}

// A fixture gate. `body` is the run() result expression; a gate that is run
// leaves a marker file, so "not run" is observed, not inferred from the runs.
function gateSrc({ id, phase, body, severity = 'safety' }) {
  return [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'export default {',
    `  id: ${JSON.stringify(id)},`,
    `  severity: ${JSON.stringify(severity)},`,
    ...(phase === undefined ? [] : [`  phase: ${JSON.stringify(phase)},`]),
    '  run: async (ctx) => {',
    `    writeFileSync(join(ctx.repoRoot, ${JSON.stringify(`ran-${id}`)}), '1');`,
    `    return ${body};`,
    '  },',
    '};',
    '',
  ].join('\n');
}

async function freshRepo(tag, gateFiles = {}) {
  const repo = await mkdtemp(join(tmpdir(), `maddu-${tag}-`));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await mkdir(join(repo, '.maddu', 'gates'), { recursive: true });
  for (const [name, src] of Object.entries(gateFiles)) {
    await writeFile(join(repo, '.maddu', 'gates', name), src);
  }
  return repo;
}

async function ran(repo, id) {
  try { await stat(join(repo, `ran-${id}`)); return true; } catch { return false; }
}

async function countEvents(repo, type) {
  return (await spine.readAll(repo)).filter((e) => e.type === type).length;
}

const FAIL_GATE = gateSrc({ id: 'fx-pre-fail', phase: 'pre-plan', body: "{ ok: false, message: 'intake incomplete' }" });
const HOLD_GATE = gateSrc({ id: 'fx-pre-hold', phase: 'pre-plan', body: "{ ok: false, message: 'waiting on the operator', evidence: { verdict: 'hold' } }" });
const PASS_GATE = gateSrc({ id: 'fx-pre-pass', phase: 'pre-plan', body: "{ ok: true, message: 'intake complete' }" });
const ARRAY_PHASE_GATE = gateSrc({ id: 'fx-pre-array', phase: ['pre-plan', 'other'], body: "{ ok: true }" });
const NOPHASE_FAIL = gateSrc({ id: 'fx-nophase-fail', body: "{ ok: false, message: 'not a pre-plan gate' }" });
const CTX_GATE = gateSrc({
  id: 'fx-pre-ctx', phase: 'pre-plan',
  body: "{ ok: true, evidence: { mode: ctx.mode ?? null, goal: ctx.goal ?? null, title: ctx.plan?.title ?? null, hasSpine: !!ctx.spine, repoRoot: ctx.repoRoot } }",
});

async function main() {
  // ── layer 1: the runner ───────────────────────────────────────────────
  {
    const repo = await freshRepo('pre-lib', {
      'fx-pre-pass.mjs': PASS_GATE,
      'fx-pre-array.mjs': ARRAY_PHASE_GATE,
      'fx-nophase-fail.mjs': NOPHASE_FAIL,
      'fx-pre-ctx.mjs': CTX_GATE,
    });
    const r = await gates.runGates(repo, {
      phase: 'pre-plan', emitEvents: false,
      ctxExtra: { mode: 'plan', goal: 'goal-x', plan: { title: 'T' }, repoRoot: '/elsewhere' },
    });
    const ids = r.runs.map((x) => x.gateId).sort();
    ok('lib: phase filter runs exactly the pre-plan gates', JSON.stringify(ids) === JSON.stringify(['fx-pre-array', 'fx-pre-ctx', 'fx-pre-pass']), ids.join(','));
    ok('lib: a gate without the phase is not run', !(await ran(repo, 'fx-nophase-fail')));
    ok('lib: no builtin gate declares pre-plan', r.runs.every((x) => x.source === 'operator'));
    const ctxRun = r.runs.find((x) => x.gateId === 'fx-pre-ctx');
    ok('lib: ctxExtra reaches the gate', ctxRun?.evidence?.mode === 'plan' && ctxRun.evidence.goal === 'goal-x' && ctxRun.evidence.title === 'T', JSON.stringify(ctxRun?.evidence));
    ok('lib: ctxExtra keeps the normal context', ctxRun?.evidence?.hasSpine === true);
    ok('lib: ctxExtra cannot replace a core key', ctxRun?.evidence?.repoRoot === repo, ctxRun?.evidence?.repoRoot);

    // Without a phase, nothing changes: the phased gate is an ordinary gate.
    const all = await gates.runGates(repo, { onlyId: 'fx-pre-pass', emitEvents: false });
    ok('lib: no phase → a phased gate still runs (doctor/ci unchanged)', all.runs.length === 1 && all.runs[0].status === 'ok');

    // A gate file that does not load might have been a pre-plan gate: keep
    // it, and fail it, rather than run the phase without it.
    await writeFile(join(repo, '.maddu', 'gates', 'fx-broken.mjs'), 'export default {{ not js\n');
    const br = await gates.runGates(repo, { phase: 'pre-plan', emitEvents: false });
    const broken = br.runs.find((x) => /fx-broken/.test(x.gateId));
    ok('lib: an unloadable gate file fails the phase', broken?.status === 'fail' && /could not load/.test(broken.message), broken ? broken.message : br.runs.map((x) => x.gateId).join(','));
    // ...whatever other filter rides along: a load error has no severity and a
    // path for an id, so those filters must not be what drops it (Codex R1 #3).
    const brSev = await gates.runGates(repo, { phase: 'pre-plan', severity: 'safety', emitEvents: false });
    ok('lib: phase + severity still keeps the unloadable file', brSev.runs.some((x) => /fx-broken/.test(x.gateId) && x.status === 'fail'), brSev.runs.map((x) => x.gateId).join(','));
    const brId = await gates.runGates(repo, { phase: 'pre-plan', onlyId: 'fx-pre-pass', emitEvents: false });
    ok('lib: phase + onlyId still keeps the unloadable file', brId.runs.some((x) => /fx-broken/.test(x.gateId) && x.status === 'fail'), brId.runs.map((x) => x.gateId).join(','));
    ok('lib: the runner advertises the pre-plan phase', Array.isArray(gates.GATE_PHASES) && gates.GATE_PHASES.includes('pre-plan'));

    await rm(repo, { recursive: true, force: true });
  }

  // ── layer 2: `plan new` ───────────────────────────────────────────────
  {
    const repo = await freshRepo('pre-cli-fail', { 'fx-pre-fail.mjs': FAIL_GATE });
    const r = run(['plan', 'new', 'Blocked plan', '--goal', 'g1'], repo);
    ok('cli: failing pre-plan gate refuses plan new (exit 1)', r.status === 1, `status=${r.status} ${r.stderr.trim()}`);
    ok('cli: refusal names the gate and its message', /fx-pre-fail/.test(r.stderr) && /intake incomplete/.test(r.stderr), r.stderr.trim());
    ok('cli: refusal appends no PLAN_CREATED', await countEvents(repo, 'PLAN_CREATED') === 0);
    ok('cli: the refusal is on the spine as a GATE_RAN', (await spine.readAll(repo)).some((e) => e.type === 'GATE_RAN' && e.data?.gateId === 'fx-pre-fail' && e.data.status === 'fail'));
    await rm(repo, { recursive: true, force: true });
  }
  {
    const repo = await freshRepo('pre-cli-hold', { 'fx-pre-hold.mjs': HOLD_GATE });
    const r = run(['plan', 'new', 'Held plan'], repo);
    ok('cli: verdict hold exits 2', r.status === 2, `status=${r.status} ${r.stderr.trim()}`);
    ok('cli: hold appends no PLAN_CREATED', await countEvents(repo, 'PLAN_CREATED') === 0);
    await rm(repo, { recursive: true, force: true });
  }
  {
    const repo = await freshRepo('pre-cli-pass', { 'fx-pre-pass.mjs': PASS_GATE, 'fx-nophase-fail.mjs': NOPHASE_FAIL });
    const r = run(['plan', 'new', 'Allowed plan'], repo);
    ok('cli: passing pre-plan gate lets plan new through', r.status === 0 && /created/.test(r.stdout), `status=${r.status} ${r.stderr.trim()}`);
    ok('cli: exactly one PLAN_CREATED', await countEvents(repo, 'PLAN_CREATED') === 1);
    ok('cli: the pre-plan gate ran', await ran(repo, 'fx-pre-pass'));
    ok('cli: a failing gate without the phase is not consulted', !(await ran(repo, 'fx-nophase-fail')));
    await rm(repo, { recursive: true, force: true });
  }
  // A newer CLI over an older installed runtime (Codex R1 #2): loadLib prefers
  // <cwd>/maddu/runtime/lib, and a runner that predates phases ignores the
  // `phase` filter and runs EVERY gate with no ctx.mode. The stub below is that
  // runner: it marks itself if runGates is ever called.
  const OLD_RUNNER = [
    "import { readdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'export async function discoverGates(root) {',
    "  const dir = join(root, '.maddu', 'gates');",
    '  const out = [];',
    "  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {",
    '    try { const m = await import(pathToFileURL(join(dir, f)).href); if (m.default?.id) out.push(m.default); }',
    '    catch (error) { out.push({ __loadError: true, id: join(dir, f), error }); }',
    '  }',
    '  return out;',
    '}',
    'export async function runGates(root) {',
    "  writeFileSync(join(root, 'ran-old-runner'), '1');",
    '  return { runs: [], summary: { ok: 0, fail: 0, warn: 0, total: 0 } };',
    '}',
    '',
  ].join('\n');
  // An installed runtime is the whole lib dir (the spine loader resolves the
  // directory, not one file), so copy the current one and swap only the runner.
  async function withOldRunner(repo) {
    await cp(LIB, join(repo, 'maddu', 'runtime', 'lib'), { recursive: true });
    await writeFile(join(repo, 'maddu', 'runtime', 'lib', 'gates.mjs'), OLD_RUNNER);
  }
  {
    const repo = await freshRepo('pre-cli-old', { 'fx-pre-pass.mjs': PASS_GATE });
    await withOldRunner(repo);
    const r = run(['plan', 'new', 'Old runner plan'], repo);
    ok('cli: old runner + a phased gate refuses (exit 1)', r.status === 1 && /maddu upgrade/.test(r.stderr), `status=${r.status} ${r.stderr.trim()}`);
    ok('cli: old runner + a phased gate appends no PLAN_CREATED', await countEvents(repo, 'PLAN_CREATED') === 0);
    ok('cli: the old runner is never asked to run gates', !(await ran(repo, 'old-runner')));
    await rm(repo, { recursive: true, force: true });
  }
  {
    const repo = await freshRepo('pre-cli-old-none', { 'fx-nophase-fail.mjs': NOPHASE_FAIL });
    await withOldRunner(repo);
    const r = run(['plan', 'new', 'Old runner, no phases'], repo);
    ok('cli: old runner + no phased gate → plan new unchanged', r.status === 0 && await countEvents(repo, 'PLAN_CREATED') === 1, `status=${r.status} ${r.stderr.trim()}`);
    ok('cli: old runner + no phased gate → no gate ran', !(await ran(repo, 'old-runner')) && !(await ran(repo, 'fx-nophase-fail')));
    await rm(repo, { recursive: true, force: true });
  }
  {
    const repo = await freshRepo('pre-cli-none');
    const r = run(['plan', 'new', 'Plain plan', '--phases', 'a,b'], repo);
    ok('cli: no phased gates → plan new unchanged', r.status === 0 && await countEvents(repo, 'PLAN_CREATED') === 1, `status=${r.status} ${r.stderr.trim()}`);
    ok('cli: no phased gates → no GATE_RAN written', await countEvents(repo, 'GATE_RAN') === 0);
    await rm(repo, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log('');
  console.log(`gate-pre-plan: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('gate-pre-plan OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
