import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PROJECT_TEST_PROFILES = new Set(['smoke', 'quick', 'full']);

const ADAPTIVE_FLAGS = new Set([
  'profile',
  'list',
  'only',
  'skip',
  'bail',
  'json',
  'no-report',
  'changed',
]);

const LEGACY_RUNNER_FLAGS = new Set(['command', 'runner-arg']);
const MAX_OUTPUT_TAIL = 8000;
const SLOW_RE = /\b(e2e|integration|integrations|int|coverage|stress|full|matrix|playwright|cypress)\b/i;
const UNSAFE_RE = /\b(watch|dev|serve|server|open|ui|interactive)\b/i;
const TEST_FAMILY_RE = /(^test$|test|spec|unit|smoke|e2e|integration|coverage|stress|full)/i;
const SMOKE_RE = /\b(smoke|unit)\b/i;
const WINDOWS_SHELL_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'npx']);

export class ProjectTestConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectTestConfigError';
    this.exitCode = 2;
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function readJsonMaybe(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitIds(value) {
  if (Array.isArray(value)) return uniq(value.flatMap(splitIds));
  if (!value || value === true) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizeRel(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function sanitizeId(value) {
  const id = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return id || 'test';
}

function quoteCommandPart(value) {
  const s = String(value);
  if (s === '') return '""';
  return /[\s"'`$&|<>]/.test(s) ? JSON.stringify(s) : s;
}

function commandText(task) {
  return [task.runner, ...(task.args || [])].map(quoteCommandPart).join(' ');
}

function hasFlag(argv, name) {
  return argv.some((arg, i) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

export function isAdaptiveProjectTestArgs(argv) {
  return argv.some((arg) => {
    if (!arg.startsWith('--')) return false;
    const name = arg.slice(2).split('=')[0];
    return ADAPTIVE_FLAGS.has(name);
  });
}

export function parseProjectTestArgs(argv) {
  const opts = {
    profile: 'quick',
    list: false,
    only: [],
    skip: [],
    bail: false,
    json: false,
    report: true,
    changed: false,
    changedFiles: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--bail') opts.bail = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-report') opts.report = false;
    else if (arg === '--profile') opts.profile = requiredValue(argv, ++i, '--profile');
    else if (arg.startsWith('--profile=')) opts.profile = arg.slice('--profile='.length);
    else if (arg === '--only') opts.only.push(...splitIds(requiredValue(argv, ++i, '--only')));
    else if (arg.startsWith('--only=')) opts.only.push(...splitIds(arg.slice('--only='.length)));
    else if (arg === '--skip') opts.skip.push(...splitIds(requiredValue(argv, ++i, '--skip')));
    else if (arg.startsWith('--skip=')) opts.skip.push(...splitIds(arg.slice('--skip='.length)));
    else if (arg === '--changed') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts.changed = true;
        opts.changedFiles = splitIds(argv[++i]);
      } else {
        opts.changed = true;
      }
    }
    else if (arg.startsWith('--changed=')) {
      opts.changed = true;
      opts.changedFiles = splitIds(arg.slice('--changed='.length));
    }
    else if (arg === '--command' || arg.startsWith('--command=') || arg === '--runner-arg' || arg.startsWith('--runner-arg=')) {
      throw new ProjectTestConfigError('maddu test: --command/--runner-arg cannot be combined with adaptive test flags; omit adaptive flags or encode the task in .maddu/config/test-harness.json');
    }
    else if (arg.startsWith('-')) throw new ProjectTestConfigError(`maddu test: unknown adaptive flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 0) {
    if (positional.length === 1 && PROJECT_TEST_PROFILES.has(positional[0])) opts.profile = positional[0];
    else throw new ProjectTestConfigError(`maddu test: unexpected positional argument(s): ${positional.join(' ')}`);
  }
  if (!PROJECT_TEST_PROFILES.has(opts.profile)) {
    throw new ProjectTestConfigError(`maddu test: invalid profile "${opts.profile}" (expected smoke, quick, or full)`);
  }
  opts.only = uniq(opts.only);
  opts.skip = uniq(opts.skip);
  return opts;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new ProjectTestConfigError(`maddu test: ${flag} requires a value`);
  return value;
}

export function hasLegacyRunnerConflict(argv) {
  return isAdaptiveProjectTestArgs(argv) && argv.some((arg) => {
    if (!arg.startsWith('--')) return false;
    const name = arg.slice(2).split('=')[0];
    return LEGACY_RUNNER_FLAGS.has(name);
  });
}

function scriptTask(scriptName, scriptValue) {
  const joined = `${scriptName} ${scriptValue || ''}`;
  if (!TEST_FAMILY_RE.test(joined)) return null;
  if (UNSAFE_RE.test(joined)) return null;
  const slow = SLOW_RE.test(joined);
  const id = `npm-${sanitizeId(scriptName)}`;
  return {
    id,
    label: `npm script ${scriptName}`,
    source: 'package.json',
    runner: 'npm',
    args: ['run', scriptName, '--silent'],
    cwd: '.',
    safe: true,
    slow,
    explicitSmoke: SMOKE_RE.test(scriptName),
    testFamily: true,
  };
}

function packageTestTask(scriptValue) {
  if (UNSAFE_RE.test(`test ${scriptValue || ''}`)) return null;
  return {
    id: 'npm-test',
    label: 'npm test',
    source: 'package.json',
    runner: 'npm',
    args: ['test', '--silent'],
    cwd: '.',
    safe: true,
    slow: SLOW_RE.test(`test ${scriptValue || ''}`),
    explicitSmoke: false,
    testFamily: true,
  };
}

async function discoverPackageTasks(repoRoot, warnings) {
  const pkg = await readJsonMaybe(join(repoRoot, 'package.json'));
  if (!pkg) return [];
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const tasks = [];
  if (scripts.test) {
    const task = packageTestTask(scripts.test);
    if (task) tasks.push(task);
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (name === 'test') continue;
    const task = scriptTask(name, value);
    if (task) tasks.push(task);
  }
  if (tasks.length === 0) {
    if (deps.vitest) tasks.push({ id: 'vitest', label: 'vitest run', source: 'package.json', runner: 'npx', args: ['vitest', 'run'], cwd: '.', safe: true, slow: false, explicitSmoke: false, testFamily: true });
    else if (deps.jest) tasks.push({ id: 'jest', label: 'jest', source: 'package.json', runner: 'npx', args: ['jest'], cwd: '.', safe: true, slow: false, explicitSmoke: false, testFamily: true });
    else if (deps.mocha) tasks.push({ id: 'mocha', label: 'mocha', source: 'package.json', runner: 'npx', args: ['mocha'], cwd: '.', safe: true, slow: false, explicitSmoke: false, testFamily: true });
  }
  if (scripts.test && !tasks.some((t) => t.id === 'npm-test')) {
    warnings.push('package.json script "test" looked interactive/unsafe and was skipped');
  }
  return tasks;
}

async function discoverPythonTasks(repoRoot) {
  const pySignals = [
    'pytest.ini',
    'tox.ini',
    'setup.cfg',
  ];
  for (const name of pySignals) {
    if (await exists(join(repoRoot, name))) {
      return [{ id: 'pytest', label: 'pytest', source: name, runner: 'pytest', args: [], cwd: '.', safe: true, slow: false, explicitSmoke: false, testFamily: true }];
    }
  }
  const req = await readTextMaybe(join(repoRoot, 'requirements.txt'));
  if (req && /\bpytest\b/i.test(req)) {
    return [{ id: 'pytest', label: 'pytest', source: 'requirements.txt', runner: 'pytest', args: [], cwd: '.', safe: true, slow: false, explicitSmoke: false, testFamily: true }];
  }
  const pyproject = await readTextMaybe(join(repoRoot, 'pyproject.toml'));
  if (pyproject && /\bpytest\b/i.test(pyproject)) {
    return [{ id: 'pytest', label: 'pytest', source: 'pyproject.toml', runner: 'pytest', args: [], cwd: '.', safe: true, slow: false, explicitSmoke: false, testFamily: true }];
  }
  return [];
}

async function readTextMaybe(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

async function readConfig(repoRoot) {
  const path = join(repoRoot, '.maddu', 'config', 'test-harness.json');
  const raw = await readTextMaybe(path);
  if (!raw) return { config: null, path };
  let config;
  try { config = JSON.parse(raw); }
  catch (err) { throw new ProjectTestConfigError(`maddu test: ${path} is not valid JSON: ${err.message}`); }
  if (config.schemaVersion !== 1) throw new ProjectTestConfigError(`maddu test: ${path} must declare schemaVersion 1`);
  if (config.tests !== undefined && !Array.isArray(config.tests)) throw new ProjectTestConfigError(`maddu test: ${path} tests must be an array`);
  if (config.changed !== undefined && !Array.isArray(config.changed)) throw new ProjectTestConfigError(`maddu test: ${path} changed must be an array`);
  return { config, path };
}

function validateProfileList(profiles, id, configPath) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new ProjectTestConfigError(`maddu test: ${configPath} test "${id}" profiles must be a non-empty array`);
  }
  for (const profile of profiles) {
    if (!PROJECT_TEST_PROFILES.has(profile)) {
      throw new ProjectTestConfigError(`maddu test: ${configPath} test "${id}" has invalid profile "${profile}"`);
    }
  }
  return uniq(profiles.map(String));
}

function validateCwd(repoRoot, cwd, id, configPath) {
  const rel = cwd == null ? '.' : String(cwd);
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(repoRoot, rel);
  const root = resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ProjectTestConfigError(`maddu test: ${configPath} test "${id}" cwd escapes the repo`);
  }
  return relative(root, abs) || '.';
}

function configTask(repoRoot, item, configPath) {
  if (!item || typeof item !== 'object') throw new ProjectTestConfigError(`maddu test: ${configPath} contains a non-object test entry`);
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
  if (!id) throw new ProjectTestConfigError(`maddu test: ${configPath} test entries require a non-empty id`);
  if (typeof item.runner !== 'string' || !item.runner.trim()) throw new ProjectTestConfigError(`maddu test: ${configPath} test "${id}" requires runner`);
  if (!Array.isArray(item.args) || item.args.some((a) => typeof a !== 'string')) {
    throw new ProjectTestConfigError(`maddu test: ${configPath} test "${id}" args must be an array of strings`);
  }
  const profiles = validateProfileList(item.profiles, id, configPath);
  const cwd = validateCwd(repoRoot, item.cwd, id, configPath);
  return {
    id,
    label: item.label || id,
    source: 'config',
    runner: item.runner,
    args: item.args.slice(),
    cwd,
    safe: true,
    slow: profiles.includes('full') && !profiles.includes('quick'),
    explicitSmoke: profiles.includes('smoke'),
    explicitProfiles: profiles,
    testFamily: true,
  };
}

function validateChangedMappings(config, configPath) {
  const out = [];
  for (const [idx, item] of (config?.changed || []).entries()) {
    if (!item || typeof item !== 'object') throw new ProjectTestConfigError(`maddu test: ${configPath} changed[${idx}] must be an object`);
    if (!Array.isArray(item.paths) || item.paths.some((p) => typeof p !== 'string')) {
      throw new ProjectTestConfigError(`maddu test: ${configPath} changed[${idx}].paths must be an array of strings`);
    }
    if (!Array.isArray(item.tests) || item.tests.some((t) => typeof t !== 'string')) {
      throw new ProjectTestConfigError(`maddu test: ${configPath} changed[${idx}].tests must be an array of strings`);
    }
    out.push({ paths: item.paths.map(normalizeRel), tests: item.tests.slice() });
  }
  return out;
}

async function discoverTasks(repoRoot) {
  const warnings = [];
  const tasks = [
    ...(await discoverPackageTasks(repoRoot, warnings)),
    ...(await discoverPythonTasks(repoRoot)),
  ];
  const { config, path: configPath } = await readConfig(repoRoot);
  if (config?.tests) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const item of config.tests) byId.set(item.id, configTask(repoRoot, item, configPath));
    return { tasks: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings, changedMappings: validateChangedMappings(config, configPath), configPath };
  }
  return { tasks: tasks.sort((a, b) => a.id.localeCompare(b.id)), warnings, changedMappings: [], configPath };
}

function taskProfiles(task) {
  if (task.explicitProfiles) return new Set(task.explicitProfiles);
  const profiles = new Set(['full']);
  if (task.safe && !task.slow) profiles.add('quick');
  if (task.explicitSmoke) profiles.add('smoke');
  return profiles;
}

function selectByProfile(tasks, profile) {
  if (profile === 'smoke') {
    const quick = tasks.filter((task) => taskProfiles(task).has('quick'));
    const explicit = tasks.filter((task) => taskProfiles(task).has('smoke'));
    return explicit.length ? explicit : quick.slice(0, 1);
  }
  return tasks.filter((task) => taskProfiles(task).has(profile));
}

async function gitChangedFiles(repoRoot) {
  const tracked = await runGit(repoRoot, ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD']);
  const untracked = await runGit(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  return uniq([...tracked, ...untracked].map(normalizeRel));
}

async function runGit(repoRoot, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) resolve([]);
      else resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

function pathMatchesPattern(filePath, pattern) {
  const file = normalizeRel(filePath);
  const p = normalizeRel(pattern);
  if (!p) return false;
  if (file === p) return true;
  if (p.endsWith('/**')) return file.startsWith(p.slice(0, -3));
  if (p.endsWith('/')) return file.startsWith(p);
  if (p.startsWith('*.')) return file.endsWith(p.slice(1));
  if (p.startsWith('**/*.')) return file.endsWith(p.slice(4));
  if (p.startsWith('.')) return file.endsWith(p);
  return file.startsWith(p.endsWith('/') ? p : `${p}/`);
}

function selectChanged(tasks, mappings, changedFiles, warnings) {
  if (!changedFiles.length) throw new ProjectTestConfigError('maddu test: --changed found no changed files');
  if (!mappings.length) {
    warnings.push('--changed used without .maddu/config/test-harness.json mappings; selected profile tasks unchanged');
    return tasks;
  }
  const wanted = new Set();
  for (const mapping of mappings) {
    if (changedFiles.some((file) => mapping.paths.some((pattern) => pathMatchesPattern(file, pattern)))) {
      for (const id of mapping.tests) wanted.add(id);
    }
  }
  const selected = tasks.filter((task) => wanted.has(task.id));
  const selectedIds = new Set(selected.map((task) => task.id));
  for (const id of wanted) {
    if (!selectedIds.has(id)) warnings.push(`--changed mapping selected unknown or out-of-profile test id "${id}"`);
  }
  return selected;
}

export async function buildProjectTestPlan(options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const parsed = {
    profile: options.profile || 'quick',
    only: splitIds(options.only),
    skip: splitIds(options.skip),
    changed: !!options.changed,
    changedFiles: options.changedFiles || null,
  };
  if (!PROJECT_TEST_PROFILES.has(parsed.profile)) throw new ProjectTestConfigError(`maddu test: invalid profile "${parsed.profile}"`);
  const discovery = await discoverTasks(repoRoot);
  const warnings = discovery.warnings.slice();
  let tasks = selectByProfile(discovery.tasks, parsed.profile);
  const availableIds = new Set(tasks.map((task) => task.id));
  const unknownOnly = parsed.only.filter((id) => !availableIds.has(id));
  const unknownSkip = parsed.skip.filter((id) => !availableIds.has(id));
  if (unknownOnly.length) throw new ProjectTestConfigError(`maddu test: unknown --only id(s) for ${parsed.profile}: ${unknownOnly.join(', ')}`);
  if (unknownSkip.length) throw new ProjectTestConfigError(`maddu test: unknown --skip id(s) for ${parsed.profile}: ${unknownSkip.join(', ')}`);
  if (parsed.only.length) {
    const allow = new Set(parsed.only);
    tasks = tasks.filter((task) => allow.has(task.id));
  }
  if (parsed.skip.length) {
    const deny = new Set(parsed.skip);
    tasks = tasks.filter((task) => !deny.has(task.id));
  }
  let changedFiles = [];
  if (parsed.changed) {
    changedFiles = parsed.changedFiles ? parsed.changedFiles.map(normalizeRel) : await gitChangedFiles(repoRoot);
    tasks = selectChanged(tasks, discovery.changedMappings, changedFiles, warnings);
  }
  if (tasks.length === 0) throw new ProjectTestConfigError(`maddu test: no runnable tests selected for profile ${parsed.profile}`);
  const root = resolve(repoRoot);
  return {
    repoRoot: root,
    profile: parsed.profile,
    changedFiles,
    discoveryWarnings: warnings,
    tasks: tasks.map((task) => {
      const cwdAbs = resolve(root, task.cwd || '.');
      return {
        id: task.id,
        label: task.label || task.id,
        source: task.source || 'discovered',
        runner: task.runner,
        args: task.args || [],
        cwd: relative(root, cwdAbs) || '.',
        cwdAbs,
        profiles: [...taskProfiles(task)],
        command: commandText(task),
      };
    }),
  };
}

function tail(text) {
  if (!text) return '';
  return text.length > MAX_OUTPUT_TAIL ? text.slice(-MAX_OUTPUT_TAIL) : text;
}

function isWindows() {
  return process.platform === 'win32';
}

function quoteWinArg(a) {
  if (typeof a !== 'string') a = String(a);
  if (a === '' || /[ \t"&|<>^()%!]/.test(a)) {
    return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  }
  return a;
}

function needsWindowsShell(cmd) {
  if (!isWindows()) return false;
  if (typeof cmd !== 'string') return false;
  const bare = cmd.replace(/\.(cmd|bat|ps1)$/i, '');
  return WINDOWS_SHELL_RUNNERS.has(bare);
}

async function runTask(task) {
  const started = Date.now();
  const res = await new Promise((resolveRun) => {
    const shell = needsWindowsShell(task.runner);
    const runner = shell ? quoteWinArg(task.runner) : task.runner;
    const args = shell ? task.args.map(quoteWinArg) : task.args;
    const child = spawn(runner, args, {
      cwd: task.cwdAbs,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => resolveRun({ code: -1, stdout, stderr: stderr + (err.message || String(err)) }));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
  const durationMs = Date.now() - started;
  return {
    id: task.id,
    label: task.label,
    source: task.source,
    command: task.command,
    cwd: task.cwd,
    status: res.code === 0 ? 'pass' : 'fail',
    exitCode: res.code,
    durationMs,
    stdoutTail: tail(res.stdout),
    stderrTail: tail(res.stderr),
  };
}

function countResults(results, planned, bailed) {
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  return {
    total: planned,
    run: results.length,
    pass,
    fail,
    skipped: planned - results.length,
    bailed: !!bailed,
  };
}

async function writeReports(repoRoot, report) {
  const stateDir = join(repoRoot, '.maddu', 'state');
  const reportsDir = join(stateDir, 'project-test-reports');
  await mkdir(reportsDir, { recursive: true });
  const stamp = report.ts.replace(/[-:T.Z]/g, '').slice(0, 14);
  const detailPath = join(reportsDir, `project-test.${stamp}.${report.profile}.json`);
  const lastRunPath = join(stateDir, 'project-test-last-run.json');
  const body = JSON.stringify(report, null, 2) + '\n';
  await writeFile(detailPath, body);
  await writeFile(lastRunPath, body);
  return { lastRunPath, detailPath };
}

export async function runProjectTest(options = {}) {
  const started = Date.now();
  const plan = await buildProjectTestPlan(options);
  const results = [];
  let bailed = false;
  for (const task of plan.tasks) {
    const result = await runTask(task);
    results.push(result);
    if (result.status === 'fail' && options.bail) {
      bailed = true;
      break;
    }
  }
  const durationMs = Date.now() - started;
  const counts = countResults(results, plan.tasks.length, bailed);
  // audit P3 — a run narrowed by --only/--skip/--changed is NOT a full quick/full
  // profile and must not qualify as recency (the VERIFICATION_RAN carries this).
  const complete = !(splitIds(options.only).length || splitIds(options.skip).length || options.changed);
  const report = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    profile: plan.profile,
    durationMs,
    repo: plan.repoRoot,
    counts,
    results,
    discoveryWarnings: plan.discoveryWarnings,
  };
  if (plan.changedFiles.length) report.changedFiles = plan.changedFiles;
  if (options.report !== false) report.reportPaths = await writeReports(plan.repoRoot, report);
  return {
    ok: counts.fail === 0,
    exitCode: counts.fail === 0 ? 0 : 1,
    profile: plan.profile,
    complete,
    durationMs,
    repo: plan.repoRoot,
    counts,
    results,
    discoveryWarnings: plan.discoveryWarnings,
    reportPaths: report.reportPaths || null,
    changedFiles: plan.changedFiles,
  };
}

export function listText(plan) {
  const lines = [`Maddu project test (${plan.profile})`, ''];
  for (const task of plan.tasks) lines.push(`  ${task.id.padEnd(28)} ${task.command}`);
  if (plan.discoveryWarnings.length) {
    lines.push('', 'Warnings:');
    for (const warning of plan.discoveryWarnings) lines.push(`  - ${warning}`);
  }
  lines.push('', `${plan.tasks.length} test(s) selected`);
  return lines.join('\n');
}

export function listJson(plan) {
  return JSON.stringify({
    profile: plan.profile,
    repo: plan.repoRoot,
    count: plan.tasks.length,
    discoveryWarnings: plan.discoveryWarnings,
    tests: plan.tasks.map((task) => ({
      id: task.id,
      source: task.source,
      profiles: task.profiles,
      cwd: task.cwd,
      command: task.command,
    })),
  }, null, 2);
}

function indentBlock(label, text) {
  const body = text.trimEnd().split('\n').map((line) => `      ${line}`).join('\n');
  return `    ${label}:\n${body}`;
}

export function resultText(result) {
  const lines = [`Maddu project test (${result.profile})`, ''];
  for (const r of result.results) {
    const tag = r.status === 'pass' ? 'PASS' : 'FAIL';
    lines.push(`  ${tag.padEnd(4)}  ${r.id.padEnd(28)} exit=${r.exitCode} ${r.durationMs}ms  ${r.command}`);
    if (r.status === 'fail') {
      if (r.stdoutTail) lines.push(indentBlock('stdout', r.stdoutTail));
      if (r.stderrTail) lines.push(indentBlock('stderr', r.stderrTail));
    }
  }
  if (result.discoveryWarnings.length) {
    lines.push('', 'Warnings:');
    for (const warning of result.discoveryWarnings) lines.push(`  - ${warning}`);
  }
  lines.push('');
  lines.push(`Summary: ${result.counts.pass} pass - ${result.counts.fail} fail - ${result.counts.run}/${result.counts.total} run - ${result.durationMs}ms`);
  if (result.counts.bailed) lines.push('Bailed after first failure.');
  if (result.reportPaths?.lastRunPath) lines.push(`Report: ${result.reportPaths.lastRunPath}`);
  return lines.join('\n');
}

export function resultJson(result) {
  return JSON.stringify(result, null, 2);
}

export async function runProjectTestCli(argv, options = {}) {
  let parsed;
  try {
    if (hasLegacyRunnerConflict(argv)) {
      throw new ProjectTestConfigError('maddu test: --command/--runner-arg cannot be combined with adaptive test flags; omit adaptive flags or encode the task in .maddu/config/test-harness.json');
    }
    parsed = parseProjectTestArgs(argv);
    const repoRoot = options.repoRoot || process.cwd();
    const plan = await buildProjectTestPlan({ ...parsed, repoRoot });
    if (parsed.list) {
      console.log(parsed.json ? listJson(plan) : listText(plan));
      return 0;
    }
    const result = await runProjectTest({ ...parsed, repoRoot });
    if (typeof options.onResult === 'function') { try { options.onResult(result); } catch {} }
    console.log(parsed.json ? resultJson(result) : resultText(result));
    return result.exitCode;
  } catch (err) {
    const message = err instanceof ProjectTestConfigError ? err.message : (err?.stack || err?.message || String(err));
    if (parsed?.json || hasFlag(argv, 'json')) console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(message);
    return err instanceof ProjectTestConfigError ? 2 : 1;
  }
}

