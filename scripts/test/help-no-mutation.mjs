#!/usr/bin/env node
// PR3a round 2 F1: trailing help must render module help without mutations.
// The dispatcher is the verb oracle; recipes only supply meaningful argv.
// Unknown additions fail recipe coverage and are never run speculatively.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const plain = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').trim();
let passed = 0, failed = 0, skipped = 0;
const ok = (label, cond, detail = '') => {
  detail = detail.replace(/\s+/g, ' ').trim();
  if (cond) { passed++; console.log(`  [PASS] ${label} - ${detail || 'assertion holds'}`); }
  else { failed++; console.log(`  [FAIL] ${label}${detail ? ` - ${detail}` : ''}`); }
};
const skip = (label, cause) => {
  skipped++;
  console.log(`  [SKIP] ${label} - ${cause.replace(/\s+/g, ' ').trim()}`);
};

// Both platform config roots MUST be redirected (workspace-roles.mjs pattern).
// Also drop inherited state pointers, node preloads, git roots and agent homes.
const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:MADDU_|GIT_|CLAUDE_|CODEX_|NODE_OPTIONS$|NODE_PATH$|APPDATA$|LOCALAPPDATA$|XDG_|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$|TMP$|TEMP$|TMPDIR$|NPM_CONFIG_)/i.test(key)));
function environment(root) {
  const home = join(root, 'home');
  return {
    ...ambient,
    APPDATA: join(root, 'appdata'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    LOCALAPPDATA: join(root, 'localappdata'),
    HOME: home, USERPROFILE: home,
    XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    npm_config_cache: join(root, 'npm-cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  };
}

function run(executable, args, cwd, env) {
  const result = spawnSync(executable, args, {
    cwd, env, encoding: 'utf8', timeout: 15000, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error(`subprocess failed: ${result.error?.message || result.signal || 'no exit status'}`);
  }
  return { ...result, text: plain(result.stdout + result.stderr) };
}

// Compare bytes AND metadata, including additions/removals, not just existence.
// Invocation receipts are the dispatcher's intentional help telemetry, not
// config or spine events. Nothing else is excluded, including breach spools.
async function snapshot(root, dir = root, result = new Map()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    const name = relative(root, file).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) throw new Error(`refusing fixture symlink: ${file}`);
    if (entry.isDirectory()) await snapshot(root, file, result);
    else if (entry.isFile() && !name.endsWith('/.maddu/state/invocation-receipts.ndjson')) {
      const st = await lstat(file, { bigint: true });
      const hash = createHash('sha256').update(await readFile(file)).digest('hex');
      result.set(name, `${hash}:${st.mode}:${st.mtimeNs}:${st.ctimeNs}`);
    }
  }
  return result;
}
const changes = (before, after) => [...new Set([...before.keys(), ...after.keys()])]
  .filter((name) => before.get(name) !== after.get(name)).sort();
const isConfig = (name) => /^(?:appdata|xdg-config)\//.test(name) || name.includes('/.maddu/config/');
const isSpine = (name) => name.includes('/.maddu/events/');

const recipes = {
  start: () => ['--port', '49177'], // No subcommand; the verb itself starts a process.
  stop: () => ['--'], // No subcommand; keep --help after another argv token.
  workspace: (repo) => ['add', repo, '--id', 'help-fixture'],
  plan: () => ['new', 'Help must not create this plan'],
  lane: () => ['claim', 'help-fixture', '--session', 'help-fixture'],
  install: (repo) => [join(repo, 'local-package')],
  task: () => ['create', 'Help must not create this task'],
  review: () => ['run', '--slice', 'help-fixture', '--reviewer', 'help-fixture'],
  'self-test': () => ['smoke'], // Runs/records verification without --help.
  agents: (repo) => ['register', '--path', join(repo, 'AGENTS.md')],
  bridges: () => ['kill-all'],
  global: () => ['policy', 'add', '--tool', 'bash', '--decision', 'deny'],
  hooks: () => ['install'],
  // This module explicitly has ONLY read subcommands. Still cover its early
  // help return; do not describe `events` as a mutation or invent a subcommand.
  insights: () => ['events', '--no-transcripts'],
  plugin: () => ['enable', 'help-fixture', '--trust'],
  trust: () => ['pin', 'help-fixture', '--version', '1.0.0'],
};

let root;
try {
  const dispatcher = await readFile(join(REPO_ROOT, 'bin', 'maddu.mjs'), 'utf8');
  const literal = dispatcher.match(/\bVERBS_WITH_OWN_HELP\s*=\s*new Set\(\[([^\]]+)\]\)/)?.[1];
  if (!literal) throw new Error('cannot read VERBS_WITH_OWN_HELP from the dispatcher');
  const verbs = [...new Set([...literal.matchAll(/['"]([a-z][a-z-]*)['"]/g)].map((m) => m[1]))];
  if (!verbs.length) throw new Error('VERBS_WITH_OWN_HELP oracle is empty');
  const missing = verbs.filter((verb) => !Object.hasOwn(recipes, verb));
  ok('F1 every dispatcher-owned help verb has an audited probe recipe', missing.length === 0,
    `verbs=${verbs.length}; missing=${missing.join(', ') || 'none'}`);

  root = await mkdtemp(join(tmpdir(), 'maddu-help-no-mutation-'));
  const source = join(root, 'source');
  // Byte-for-byte copies of CURRENT files, not a checkout of HEAD. This also
  // contains framework-root fallbacks (notably self-test) inside the temp dir.
  // No installed server/test runner: a regressed help guard cannot boot a
  // bridge or launch the framework test suite from this fixture.
  for (const part of ['bin', 'commands', 'template/maddu/runtime/lib']) {
    await cp(join(REPO_ROOT, part), join(source, part), {
      recursive: true,
      filter: async (file) => {
        if ((await lstat(file)).isSymbolicLink()) throw new Error(`cannot isolate source symlink: ${file}`);
        return true;
      },
    });
  }
  const sourceBefore = await snapshot(source);
  const bin = join(source, 'bin', 'maddu.mjs');

  for (const verb of verbs) {
    if (!Object.hasOwn(recipes, verb)) {
      skip(`F1 ${verb}: trailing --help`, `dispatcher contains ${verb}, but no audited argv/isolation recipe exists`);
      continue;
    }
    const moduleSource = await readFile(join(source, 'commands', `${verb}.mjs`), 'utf8');
    if (verb === 'bridges' && /scanProcesses\(/.test(moduleSource) && /process\.kill\(/.test(moduleSource)) {
      skip('F1 bridges kill-all: trailing --help',
        'commands/bridges.mjs merges a host process scan into kill-all and calls process.kill; APPDATA/XDG isolation cannot contain those signals');
      continue;
    }
    const probeRoot = join(root, verb);
    const repo = join(probeRoot, 'fixture-repo');
    const env = environment(probeRoot);
    for (const dir of [repo, env.HOME, env.APPDATA, env.XDG_CONFIG_HOME, env.TMP,
      join(repo, '.maddu', 'config'), join(repo, '.maddu', 'events'), join(repo, 'local-package')]) {
      await mkdir(dir, { recursive: true });
    }
    const git = run('git', ['init', '--quiet', repo], repo, env);
    if (git.status !== 0) throw new Error(`fixture git init exited ${git.status}: ${git.text}`);
    await writeFile(join(repo, 'package.json'), '{"name":"help-fixture","version":"1.0.0","private":true}\n');
    await writeFile(join(repo, 'local-package', 'package.json'), '{"name":"help-local","version":"1.0.0"}\n');
    // An existing file catches overwrites; global's initially absent policy
    // file catches creations. Neither expected result is hard-coded as RED.
    await writeFile(join(repo, '.maddu', 'config', 'trust.json'), '{"pinnedPackages":[]}\n');

    try {
      const before = await snapshot(probeRoot);
      const url = pathToFileURL(join(source, 'commands', `${verb}.mjs`)).href;
      const direct = run(process.execPath, ['--input-type=module', '-e',
        `const mod = await import(${JSON.stringify(url)}); await mod.default(['--help']);`], repo, env);
      const baselineChanges = changes(before, await snapshot(probeRoot));
      if (!direct.text.replace(/\s+/g, ' ').toLowerCase().includes(`usage: maddu ${verb}`)) {
        throw new Error(`module help oracle lacks usage: ${direct.text}`);
      }
      if (baselineChanges.length) throw new Error(`direct --help mutated fixture: ${baselineChanges.join(', ')}`);

      const args = [verb, ...recipes[verb](repo), '--help'];
      const result = run(process.execPath, [bin, ...args], repo, env);
      const changed = changes(before, await snapshot(probeRoot));
      const detail = `argv=${args.join(' ')}; exit=${result.status}; output=${result.text.slice(0, 200)}`;
      // global's canonical module help currently exits 2; text is the contract,
      // not a new exit-code policy. Crashes/timeouts are harness failures.
      ok(`F1 ${verb}: trailing --help prints its own module help`, result.text === direct.text, detail);
      ok(`F1 ${verb}: trailing --help changes no config file`, !changed.some(isConfig),
        `changed=${changed.filter(isConfig).join(', ') || 'none'}`);
      ok(`F1 ${verb}: trailing --help appends no spine event`, !changed.some(isSpine),
        `changed=${changed.filter(isSpine).join(', ') || 'none'}`);
      const other = changed.filter((name) => !isConfig(name) && !isSpine(name));
      ok(`F1 ${verb}: trailing --help makes no other non-telemetry write`, other.length === 0,
        `changed=${other.join(', ') || 'none'}${verb === 'insights' ? '; module is read-only (events probe)' : ''}`);
    } catch (err) {
      ok(`F1 ${verb}: probe harness`, false, err.stack || err.message);
    }
  }
  const sourceChanges = changes(sourceBefore, await snapshot(source));
  ok('F1 help probes leave the temporary framework copy unchanged', sourceChanges.length === 0,
    `changed=${sourceChanges.join(', ') || 'none'}`);
} catch (err) {
  ok('PR3a help-no-mutation harness', false, err.stack || err.message);
} finally {
  if (root) {
    // Never recursively remove a computed Windows target without containment.
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`unsafe cleanup target: ${root}`);
    await rm(root, { recursive: true, force: true });
  }
}

console.log('');
console.log(`PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
