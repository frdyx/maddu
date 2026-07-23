import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative } from 'node:path';

export const PROFILES = new Set(['smoke', 'quick', 'full']);
export const SOURCE_ONLY_MESSAGE = 'maddu self-test is only available in the Maddu framework source checkout; use `maddu test` for project tests.';

const QUICK_EXCLUDED = new Set(['run-all.mjs', 'stress-harness.mjs', 'upgrade-matrix.mjs', 'cockpit-playwright.mjs']);
const INTERNAL_SCRIPT_RE = /^_/;
const MAX_OUTPUT_TAIL = 8000;

// audit P4 — SKIP honesty. A task in this set is allowed to declare itself
// non-applicable by exiting with SKIP_EXIT_CODE; the runner records it as
// `skip` (distinct from `pass`), never as a pass. Any OTHER task that exits 77,
// and every nonzero/signal/spawn error, is a `fail`. These are the nine
// whole-task fixtures that need an optional dev dependency (happy-dom /
// playwright / a browser) or a git worktree that may be absent on a bare runner.
// Exit 77 is reserved (EX_NOPERM in sysexits) and is NOT used by any maddu verb
// for refusals (those use 1/2/3), so it cannot collide with a real failure.
export const SKIP_EXIT_CODE = 77;
export const SKIPPABLE_TASKS = new Set([
  'cockpit-boot',
  'cockpit-snapshot',
  'cockpit-command-bar',
  'cockpit-inspector',
  'cockpit-playwright',
  'worktree-attach',
  'worktree-coherence',
  'worktree-detach',
  'worktree-recovery',
  'spine-sync-git',
]);

// audit P4 — the single source of truth for exit-code → status. Only a
// SKIPPABLE task exiting with the reserved SKIP code is a `skip`; that code from
// any other task, and every other nonzero exit / signal / spawn error (-1), is a
// `fail`. A skip therefore can only ever mean "declared non-applicable", never
// "something broke". Exported so the honesty guard can pin the classification.
export function classifyExit(code, skippable) {
  if (code === 0) return 'pass';
  if (code === SKIP_EXIT_CODE && skippable) return 'skip';
  return 'fail';
}

export class SelfTestConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelfTestConfigError';
    this.exitCode = 2;
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitIds(value) {
  if (Array.isArray(value)) return uniq(value.flatMap(splitIds));
  if (!value || value === true) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseSelfTestArgs(argv) {
  const opts = {
    profile: 'quick',
    list: false,
    only: [],
    skip: [],
    bail: false,
    json: false,
    report: true,
    failOnSkip: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--bail') opts.bail = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-report') opts.report = false;
    else if (arg === '--fail-on-skip') opts.failOnSkip = true;
    else if (arg === '--profile') opts.profile = argv[++i];
    else if (arg.startsWith('--profile=')) opts.profile = arg.slice('--profile='.length);
    else if (arg === '--only') opts.only.push(...splitIds(argv[++i]));
    else if (arg.startsWith('--only=')) opts.only.push(...splitIds(arg.slice('--only='.length)));
    else if (arg === '--skip') opts.skip.push(...splitIds(argv[++i]));
    else if (arg.startsWith('--skip=')) opts.skip.push(...splitIds(arg.slice('--skip='.length)));
    else if (arg.startsWith('-')) throw new SelfTestConfigError(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 0) {
    if (positional.length === 1 && PROFILES.has(positional[0])) opts.profile = positional[0];
    else throw new SelfTestConfigError(`unexpected positional argument(s): ${positional.join(' ')}`);
  }
  if (!PROFILES.has(opts.profile)) {
    throw new SelfTestConfigError(`invalid profile "${opts.profile}" (expected smoke, quick, or full)`);
  }
  opts.only = uniq(opts.only);
  opts.skip = uniq(opts.skip);
  return opts;
}

async function assertSourceLayout(frameworkRoot, testDir) {
  if (!(await exists(testDir))) throw new SelfTestConfigError(SOURCE_ONLY_MESSAGE);
  let pkg = null;
  try { pkg = JSON.parse(await readFile(join(frameworkRoot, 'package.json'), 'utf8')); } catch {}
  if (pkg?.name !== 'maddu') throw new SelfTestConfigError(SOURCE_ONLY_MESSAGE);
}

function smokeTasks(frameworkRoot) {
  const bin = join(frameworkRoot, 'bin', 'maddu.mjs');
  return [
    { id: 'audit-generated', kind: 'smoke', args: [bin, 'audit', 'generated'], label: 'maddu audit generated' },
    { id: 'audit', kind: 'smoke', args: [bin, 'audit'], label: 'maddu audit' },
    { id: 'spine-verify', kind: 'smoke', args: [bin, 'spine', 'verify'], label: 'maddu spine verify' },
  ];
}

async function discoverScriptTasks(testDir) {
  const entries = await readdir(testDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !INTERNAL_SCRIPT_RE.test(e.name))
    .map((e) => ({
      id: e.name.replace(/\.mjs$/, ''),
      kind: 'script',
      fileName: e.name,
      args: [join(testDir, e.name)],
      label: `scripts/test/${e.name}`,
      skippable: SKIPPABLE_TASKS.has(e.name.replace(/\.mjs$/, '')),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function taskCommand(task, frameworkRoot) {
  const rel = task.args.map((arg) => {
    const r = relative(frameworkRoot, arg).replace(/\\/g, '/');
    return r && !r.startsWith('..') ? r : arg;
  });
  return `node ${rel.join(' ')}`;
}

export async function buildSelfTestPlan(options = {}) {
  const frameworkRoot = options.frameworkRoot || process.cwd();
  const testDir = options.testDir || join(frameworkRoot, 'scripts', 'test');
  const profile = options.profile || 'quick';
  if (!PROFILES.has(profile)) throw new SelfTestConfigError(`invalid profile "${profile}"`);
  await assertSourceLayout(frameworkRoot, testDir);

  const scripts = await discoverScriptTasks(testDir);
  const smoke = smokeTasks(frameworkRoot);
  const focused = scripts.filter((t) => !QUICK_EXCLUDED.has(t.fileName));
  const special = scripts.filter((t) => t.fileName === 'stress-harness.mjs' || t.fileName === 'upgrade-matrix.mjs' || t.fileName === 'cockpit-playwright.mjs');
  const base = profile === 'smoke' ? smoke
    : profile === 'quick' ? [...smoke, ...focused]
    : [...smoke, ...focused, ...special];

  const availableIds = new Set(base.map((t) => t.id));
  const only = splitIds(options.only);
  const skip = splitIds(options.skip);
  const unknownOnly = only.filter((id) => !availableIds.has(id));
  const unknownSkip = skip.filter((id) => !availableIds.has(id));
  if (unknownOnly.length) throw new SelfTestConfigError(`unknown --only id(s) for ${profile}: ${unknownOnly.join(', ')}`);
  if (unknownSkip.length) throw new SelfTestConfigError(`unknown --skip id(s) for ${profile}: ${unknownSkip.join(', ')}`);

  let tasks = base;
  if (only.length) {
    const allow = new Set(only);
    tasks = tasks.filter((t) => allow.has(t.id));
  }
  if (skip.length) {
    const deny = new Set(skip);
    tasks = tasks.filter((t) => !deny.has(t.id));
  }
  return {
    frameworkRoot,
    profile,
    tasks: tasks.map((t) => ({ ...t, command: taskCommand(t, frameworkRoot) })),
  };
}

function tail(text) {
  if (!text) return '';
  return text.length > MAX_OUTPUT_TAIL ? text.slice(-MAX_OUTPUT_TAIL) : text;
}

async function runTask(task, frameworkRoot) {
  const started = Date.now();
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, task.args, {
      cwd: frameworkRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
  const durationMs = Date.now() - started;
  const status = classifyExit(res.code, task.skippable);
  return {
    id: task.id,
    label: task.label,
    command: task.command,
    status,
    exitCode: res.code,
    durationMs,
    stdoutTail: tail(res.stdout),
    stderrTail: tail(res.stderr),
  };
}

function countResults(results, planned, bailed) {
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  // audit P4 — `taskSkipped` (deliberate exit-77 skips) is distinct from the
  // legacy `skipped` field, which stays == planned-minus-attempted (tasks not
  // reached, e.g. after --bail). Schema v1 back-compatible: `skipped` unchanged,
  // `taskSkipped` added.
  const taskSkipped = results.filter((r) => r.status === 'skip').length;
  return {
    total: planned,
    run: results.length,
    pass,
    fail,
    taskSkipped,
    skipped: planned - results.length,
    bailed: !!bailed,
  };
}

async function writeReports(frameworkRoot, report) {
  const stateDir = join(frameworkRoot, '.maddu', 'state');
  const reportsDir = join(stateDir, 'self-test-reports');
  await mkdir(reportsDir, { recursive: true });
  const stamp = report.ts.replace(/[-:T.Z]/g, '').slice(0, 14);
  const detailPath = join(reportsDir, `self-test.${stamp}.${report.profile}.json`);
  const lastRunPath = join(stateDir, 'self-test-last-run.json');
  const body = JSON.stringify(report, null, 2) + '\n';
  await writeFile(detailPath, body);
  await writeFile(lastRunPath, body);
  return { lastRunPath, detailPath };
}

export async function runSelfTest(options = {}) {
  const started = Date.now();
  const plan = await buildSelfTestPlan(options);
  const results = [];
  let bailed = false;
  for (const task of plan.tasks) {
    const result = await runTask(task, plan.frameworkRoot);
    results.push(result);
    if (result.status === 'fail' && options.bail) {
      bailed = true;
      break;
    }
  }
  const durationMs = Date.now() - started;
  const counts = countResults(results, plan.tasks.length, bailed);
  // audit P4 — with --fail-on-skip, a deliberately-skipped task makes the suite
  // RED (CI passes this so a missing dev dep can't green the run). The receipt
  // `result`/`ok` is derived from THIS final verdict, never from counts.fail
  // alone, so a fail-on-skip red is recorded as a fail even though no task
  // literally "failed".
  const failOnSkip = options.failOnSkip === true;
  const ok = counts.fail === 0 && !(failOnSkip && counts.taskSkipped > 0);
  const report = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    profile: plan.profile,
    durationMs,
    counts,
    results,
  };
  if (options.report !== false) {
    report.reportPaths = await writeReports(plan.frameworkRoot, report);
  }
  return {
    ok,
    exitCode: ok ? 0 : 1,
    profile: plan.profile,
    // audit P3 — a run narrowed by --only/--skip is not a full profile and must
    // not qualify as recency (carried on the VERIFICATION_RAN receipt). audit P4
    // extends this: a run with ANY skipped task is likewise not a complete
    // profile, so a skipped suite can never satisfy a recency gate.
    complete: !(((options.only || []).length) || ((options.skip || []).length) || counts.taskSkipped > 0),
    durationMs,
    counts,
    results,
    reportPaths: report.reportPaths || null,
  };
}

export function listText(plan) {
  const lines = [`Maddu self-test (${plan.profile})`, ''];
  for (const task of plan.tasks) lines.push(`  ${task.id.padEnd(28)} ${task.command}`);
  lines.push('', `${plan.tasks.length} test(s) selected`);
  return lines.join('\n');
}

export function listJson(plan) {
  return JSON.stringify({
    profile: plan.profile,
    count: plan.tasks.length,
    tests: plan.tasks.map((t) => ({ id: t.id, kind: t.kind, command: t.command })),
  }, null, 2);
}

export function resultText(result) {
  const lines = [`Maddu self-test (${result.profile})`, ''];
  for (const r of result.results) {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
    lines.push(`  ${tag.padEnd(4)}  ${r.id.padEnd(28)} ${r.durationMs}ms`);
    if (r.status === 'fail') {
      if (r.stdoutTail) lines.push(indentBlock('stdout', r.stdoutTail));
      if (r.stderrTail) lines.push(indentBlock('stderr', r.stderrTail));
    }
  }
  lines.push('');
  const skipPart = result.counts.taskSkipped ? ` - ${result.counts.taskSkipped} skip` : '';
  lines.push(`Summary: ${result.counts.pass} pass - ${result.counts.fail} fail${skipPart} - ${result.counts.run}/${result.counts.total} run - ${result.durationMs}ms`);
  if (result.counts.taskSkipped) lines.push(`${result.counts.taskSkipped} task(s) skipped (optional dependency absent) — SKIP is not PASS.`);
  if (result.counts.bailed) lines.push('Bailed after first failure.');
  if (result.reportPaths?.lastRunPath) lines.push(`Report: ${result.reportPaths.lastRunPath}`);
  return lines.join('\n');
}

function indentBlock(label, text) {
  const body = text.trimEnd().split('\n').map((line) => `      ${line}`).join('\n');
  return `    ${label}:\n${body}`;
}

export function resultJson(result) {
  return JSON.stringify(result, null, 2);
}

export async function runSelfTestCli(argv, options = {}) {
  let parsed;
  try {
    parsed = parseSelfTestArgs(argv);
    const plan = await buildSelfTestPlan({ ...parsed, frameworkRoot: options.frameworkRoot });
    if (parsed.list) {
      console.log(parsed.json ? listJson(plan) : listText(plan));
      return 0;
    }
    const result = await runSelfTest({ ...parsed, frameworkRoot: options.frameworkRoot });
    if (typeof options.onResult === 'function') { try { options.onResult(result); } catch {} }
    console.log(parsed.json ? resultJson(result) : resultText(result));
    return result.exitCode;
  } catch (err) {
    const message = err instanceof SelfTestConfigError ? err.message : (err?.stack || err?.message || String(err));
    if (parsed?.json) console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(message);
    return err instanceof SelfTestConfigError ? 2 : 1;
  }
}
