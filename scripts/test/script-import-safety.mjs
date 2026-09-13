#!/usr/bin/env node
// PR5 clauses 5-6. REAL children run untouched source copies, never this
// checkout's utilities. No optional dependencies, module stubs, or fs mocks.
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv, cleanupFixtures } from './_pr1-fixtures.mjs';
import { sourceFixture, fixtureEnv } from './_pr2-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WATCH = ['scripts/test/__fixtures__/event-contract-baseline.json', 'commands/_flag-allowlists.json'];
const RETURNED = 'PR5_IMPORT_RETURNED';
const TIMEOUT = 10000;
let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond, extra = '') => {
  extra = extra.replace(/\s+/g, ' ').trim();
  if (cond) { passed++; console.log(`  [PASS] ${name} - ${extra || 'assertion holds'}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};

async function topFiles(dir, suffix) {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => entry.name).sort();
}

function run(root, args) {
  const env = childEnv(fixtureEnv(root, {
    // Optional capture output and nested test temp dirs are also fixture-owned.
    OUT: join(root, 'fixture-shot.png'), TMP: join(root, 'fixture-tmp'),
    TEMP: join(root, 'fixture-tmp'), TMPDIR: join(root, 'fixture-tmp'),
  }));
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: root, env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', error = null, timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { error = `${err.code || ''}: ${err.message}`; });
    const timer = setTimeout(() => {
      timedOut = true;
      // A utility can launch its own node/browser children. Terminate the
      // owned process tree on timeout before removing its fixture files.
      if (process.platform === 'win32' && child.pid) {
        const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, encoding: 'utf8', timeout: 3000,
        });
        if (killed.error || killed.status !== 0) {
          error = `taskkill: ${killed.error?.message || killed.stderr || killed.stdout}`;
          child.kill('SIGKILL');
        }
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, TIMEOUT);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      done({ status, signal, error, stdout, stderr, timedOut });
    });
  });
}

// funnel r1 #7 — the write oracle is the WHOLE owned fixture, not two named
// files: a quiet write to a generated doc, a screenshot, or a temp dir under
// the fixture is a side effect too. Snapshot = every file's size + mtime +
// (for the two artifacts a script legitimately owns) bytes.
async function walk(dir, rel = '') {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') return out; throw err; }
  for (const entry of entries) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...await walk(join(dir, entry.name), path)); }
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

async function snapshot(root) {
  const files = await walk(root);
  const map = new Map();
  for (const path of files) {
    const st = await stat(join(root, path), { bigint: true });
    const rec = { size: st.size, mtime: st.mtimeNs };
    if (WATCH.includes(path)) rec.bytes = await readFile(join(root, path));
    map.set(path, rec);
  }
  return map;
}

function changed(before, after) {
  const reasons = [];
  for (const [path, old] of before) {
    const next = after.get(path);
    if (!next) { reasons.push(`${path} (removed)`); continue; }
    const why = [];
    if (old.bytes && next.bytes && !old.bytes.equals(next.bytes)) why.push('bytes');
    if (old.size !== next.size) why.push('size');
    if (old.mtime !== next.mtime) why.push('mtime');
    if (why.length) reasons.push(`${path} (${why.join('+')})`);
  }
  for (const path of after.keys()) if (!before.has(path)) reasons.push(`${path} (created)`);
  return reasons;
}

function detail(r) {
  const text = (value) => value.replace(/\s+/g, ' ').trim().slice(0, 900);
  return `exit=${r.status}; signal=${r.signal || 'none'}; timeout=${r.timedOut ? `${TIMEOUT}ms exceeded` : 'no'}`
    + `${r.error ? `; error=${r.error}` : ''}; stdout=${text(r.stdout) || '(empty)'}; stderr=${text(r.stderr) || '(empty)'}`;
}

function successful(r) { return !r.timedOut && !r.error && !r.signal && r.status === 0; }

try {
  const scripts = await topFiles(join(ROOT, 'scripts'), '.mjs');
  if (!scripts.length) throw new Error('no top-level utility scripts discovered');
  const root = await sourceFixture('maddu-pr5-script-safety-');
  await cp(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  // generate.mjs needs the authored top-level docs as well as their payload
  // copies. Do not copy the checkout's .maddu or repo-only docs subtrees.
  for (const entry of await readdir(join(ROOT, 'docs'), { withFileTypes: true })) {
    if (entry.isFile()) await cp(join(ROOT, 'docs', entry.name), join(root, 'docs', entry.name));
  }
  await mkdir(join(root, 'fixture-tmp'), { recursive: true });

  // The two artifacts a generator legitimately owns are read from the REAL
  // checkout (bytes) so the fixture can be seeded with valid-but-stale data;
  // the fixture itself is then watched as a whole tree (snapshot/changed).
  const original = await Promise.all(WATCH.map(async (path) => {
    try { return { path, bytes: await readFile(join(ROOT, path)) }; }
    catch (err) { if (err.code !== 'ENOENT') throw err; return { path, absent: true }; }
  }));
  if (original.some((file) => file.absent)) throw new Error('a required watched source artifact is absent');
  async function seedArtifacts() {
    // Valid but stale DATA, not modified executable code. This makes an
    // accidental generator run observable even when the checkout is current.
    for (const file of original) {
      const value = { ...JSON.parse(file.bytes.toString('utf8')), _pr5ImportSafety: 'leave this fixture data unchanged' };
      await writeFile(join(root, file.path), JSON.stringify(value, null, 2) + '\n');
      const old = new Date('2000-01-01T00:00:00Z');
      await utimes(join(root, file.path), old, old);
    }
  }

  for (const script of scripts) {
    const path = join(root, 'scripts', script);
    await seedArtifacts();
    let before = await snapshot(root);
    let result = await run(root, [path, '--help']);
    let changes = changed(before, await snapshot(root));
    const usage = result.stdout.trim().length > 0 && (result.stdout.includes(basename(script)) || /\bUsage\b/i.test(result.stdout));
    // Census/capture completion output is direct evidence of work. Missing
    // playwright and timeouts are observed failures, never assumed skips.
    const work = /\bSPINE:|\bDORMANT\b|\bcaptured\s.+\(ws=|PR2 fire-core extraction:|refreshed event-contract baseline|flag-allowlists: (?:current|wrote)|generate: (?:wrote|all)/i
      .test(result.stdout + result.stderr);
    ok(`5a ${script} --help is usage-only and leaves watched artifacts unchanged`,
      successful(result) && usage && changes.length === 0 && !work,
      `${detail(result)}; usage=${usage}; work output=${work}; changed=${changes.join(', ') || 'none'}`);

    await seedArtifacts();
    before = await snapshot(root);
    // No script argv. The marker additionally proves import returned to the
    // caller: process.exit(0) is not a successful import. Non-marker stdout
    // exposes the census's otherwise invisible live-spine read.
    result = await run(root, ['--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(path).href)}); console.log(${JSON.stringify(RETURNED)});`]);
    changes = changed(before, await snapshot(root));
    const control = script === 'check-fire-core-extracted.mjs' ? ' [control]' : '';
    ok(`5b ${script}${control} import returns quietly and leaves watched artifacts unchanged`,
      successful(result) && result.stdout.trim() === RETURNED && result.stderr === '' && changes.length === 0,
      `${detail(result)}; changed=${changes.join(', ') || 'none'}`);
  }

  const runtimeDir = join(root, 'template/maddu/runtime/lib/runtimes');
  const wrappers = await topFiles(runtimeDir, '-wrapper.mjs');
  if (!wrappers.length) throw new Error('no runtime wrappers discovered');
  for (const name of wrappers) {
    const path = join(runtimeDir, name);
    const imported = await run(root, ['--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(path).href)}); console.log(${JSON.stringify(RETURNED)});`]);
    ok(`6a ${name} is importable without a CLI binary`,
      successful(imported) && imported.stderr === '' && imported.stdout.trim() === RETURNED, detail(imported));
    const direct = await run(root, [path]);
    ok(`6b ${name} [control] program still rejects a missing CLI binary`,
      !direct.timedOut && !direct.error && !direct.signal && direct.status === 2 && /missing CLI binary argument/.test(direct.stderr),
      detail(direct));
  }
  const common = await run(root, ['--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(join(runtimeDir, '_wrapper-common.mjs')).href)}); console.log(${JSON.stringify(RETURNED)});`]);
  ok('6c _wrapper-common.mjs [control] remains a cleanly importable library',
    successful(common) && common.stderr === '' && common.stdout.trim() === RETURNED, detail(common));

  const realChanges = [];
  for (const file of original) {
    let now = null;
    try { now = await readFile(join(ROOT, file.path)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (!now) realChanges.push(`${file.path} (removed)`);
    else if (!now.equals(file.bytes)) realChanges.push(`${file.path} (bytes)`);
  }
  if (realChanges.length) throw new Error(`real checkout artifacts changed: ${realChanges.join(', ')}`);
} catch (err) {
  ok('PR5 script-import-safety harness', false, err.stack || err.message);
} finally {
  await cleanupFixtures();
}
console.log('');
console.log(`script-import-safety: PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
