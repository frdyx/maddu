#!/usr/bin/env node
// architecture-mass (v1.23.0) — structural-mass dimension: monolith line counts,
// exact-duplicate code files, and the shrink-only ratchet.
//
// Verifies scanMass counts lines + flags files over the threshold, exact dup
// detection groups identical files, the baseline records oversize files, and
// evaluateMass blocks on a NEW or GROWN monolith but not on a shrunk/baselined
// one — across the failOn ladder. Since v1.155.0 it also checks the file set:
// what git can see, ignored files left out, and every visible file found
// (case and Unicode spellings, a leading space, UTF-8 split across output
// chunks, submodules and nested repositories).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm, rename, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as architecture from '../../template/maddu/runtime/lib/architecture.mjs';
import { gitRun } from '../../template/maddu/runtime/lib/git-exec.mjs';

const { scanMass, evaluateMass, writeMassBaseline, loadMassBaseline, visibilitySet, gitBoolConfig } = architecture;

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const lines = (n) => Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
async function put(root, rel, body) { const p = join(root, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); }
// `git …` in cwd → { code, out }. A spawn failure is code -1.
const gitIn = (cwd, args) => new Promise((res) => {
  let out = '';
  const c = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (s) => { out += s; });
  c.on('error', () => res({ code: -1, out }));
  c.on('close', (code) => res({ code, out }));
});
const oversizePaths = (scan) => scan.oversize.map((f) => f.path).sort();

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-mass-'));
  try {
    await put(root, 'src/big.mjs', lines(200));
    await put(root, 'src/small.mjs', lines(10));
    await put(root, 'src/readme.md', lines(500));   // non-code: ignored
    await put(root, 'src/dupA.mjs', lines(10));      // identical to small.mjs
    await put(root, 'src/sub/dupB.mjs', lines(10));  // identical too

    const scan = await scanMass(root, { maxLines: 100 });
    ok('counts code files only (md ignored)', scan.totals.files === 4);
    ok('big.mjs is over threshold', scan.oversize.length === 1 && scan.oversize[0].path === 'src/big.mjs');
    ok('line count is accurate', scan.files.find((f) => f.path === 'src/big.mjs').lines === 200);
    ok('files sorted largest-first', scan.files[0].path === 'src/big.mjs');
    // small.mjs, dupA.mjs, dupB.mjs are byte-identical → one duplicate group of 3.
    const dupGroup = scan.duplicates.find((g) => g.length === 3);
    ok('exact-duplicate group detected', !!dupGroup && dupGroup.includes('src/dupA.mjs'));

    // failOn ladder, no baseline yet (everything is "new").
    ok('failOn none never blocks', evaluateMass(scan, { files: {} }, 'none').blocking === false);
    ok('failOn any blocks on any oversize', evaluateMass(scan, { files: {} }, 'any').blocking === true);
    ok('failOn new blocks on a new monolith', evaluateMass(scan, { files: {} }, 'new').blocking === true);

    // Baseline the monolith → ratchet should now pass.
    await writeMassBaseline(root, scan, '2026-01-01T00:00:00Z');
    const base = await loadMassBaseline(root);
    ok('baseline records the oversize file', base.files['src/big.mjs'] === 200);
    ok('baselined monolith no longer blocks (new)', evaluateMass(scan, base, 'new').blocking === false);

    // Grow the monolith → ratchet blocks.
    await put(root, 'src/big.mjs', lines(260));
    const grown = await scanMass(root, { maxLines: 100 });
    const grownEval = evaluateMass(grown, base, 'new');
    ok('a grown monolith blocks', grownEval.blocking === true && grownEval.grown.length === 1);

    // Shrink below the baseline → passes (shrink-only ratchet).
    await put(root, 'src/big.mjs', lines(150));
    const shrunk = await scanMass(root, { maxLines: 100 });
    ok('a shrunk (but still oversize) monolith passes', evaluateMass(shrunk, base, 'new').blocking === false);

    // Shrink below the threshold → leaves the oversize set entirely.
    await put(root, 'src/big.mjs', lines(50));
    const tiny = await scanMass(root, { maxLines: 100 });
    ok('shrinking under the threshold clears the monolith', tiny.oversize.length === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  // ── scanMass honours .gitignore and .git/info/exclude ─────────────────────
  //
  // The dependency scan stopped reading git-ignored files in v1.120.0; the
  // mass scan kept walking the raw tree. Run from the operator's main
  // checkout, doctor's architecture-mass gate then counted copies of
  // cockpit.js and spine-append-core.mjs inside .claude/worktrees/ (excluded
  // through .git/info/exclude) and a gitignored marketing/ folder as eight new
  // monoliths: red on files no commit can fix and CI never sees. The other
  // half matters as much — an untracked file that git does NOT ignore must
  // still count, or a new monolith goes unnoticed until it is committed.
  const groot = await mkdtemp(join(tmpdir(), 'maddu-mass-gitignore-'));
  try {
    const git = (args) => new Promise((res) => {
      const c = spawn('git', args, { cwd: groot, stdio: 'ignore' });
      c.on('error', () => res(-1));
      c.on('exit', (code) => res(code));
    });
    if ((await git(['init', '-q'])) !== 0) {
      // No git here: scanMass falls back to the raw walk by design. Report it
      // as UNTESTED rather than letting the case count as a pass.
      ok('[UNTESTED] gitignore honoured — git unavailable in this environment', true, 'fallback path is intentional');
    } else {
      await put(groot, '.gitignore', 'marketing/\n');
      await put(groot, '.git/info/exclude', '.claude/worktrees/\n');
      await put(groot, 'src/tracked-big.mjs', lines(200));
      await put(groot, 'src/untracked-big.mjs', lines(210));
      await put(groot, 'marketing/demo/cockpit.js', lines(300));
      // A byte copy of the tracked monolith in an excluded worktree folder.
      await put(groot, '.claude/worktrees/wt1/src/tracked-big.mjs', lines(200));
      const added = await git(['add', '.gitignore', 'src/tracked-big.mjs']);
      const tracked = (await gitIn(groot, ['ls-files', '-z', '--cached'])).out.split('\0');
      ok('(setup) git add tracked the file the next rows call tracked', added === 0 && tracked.includes('src/tracked-big.mjs'), JSON.stringify(tracked));

      const scan = await scanMass(groot, { maxLines: 100 });
      const big = scan.oversize.map((f) => f.path).sort();
      ok('a gitignored oversize file is not counted', !big.includes('marketing/demo/cockpit.js'), JSON.stringify(big));
      ok('a file under a path excluded through .git/info/exclude is not counted', !big.some((p) => p.startsWith('.claude/')), JSON.stringify(big));
      ok('a tracked oversize file is counted', big.includes('src/tracked-big.mjs'), JSON.stringify(big));
      ok('an untracked file git does not ignore is still counted (caught before commit)', big.includes('src/untracked-big.mjs'), JSON.stringify(big));
      ok('an ignored copy forms no duplicate group with the tracked file',
        !scan.duplicates.some((g) => g.some((p) => p.startsWith('.claude/'))), JSON.stringify(scan.duplicates));
      ok('ignored files are left out of the totals', scan.totals.files === 2, JSON.stringify(scan.totals));
    }
  } finally {
    await rm(groot, { recursive: true, force: true });
  }

  // ── the listing has to name every file git can see (v1.155.0) ───────────
  //
  // With the mass scan now reading the dependency scan's listing, a file the
  // listing misses is a monolith that can grow unnoticed (Codex review round
  // 1). Each row below is a file git can see that a plain string match lost.
  {
    // gitRun decodes git's output as one stream. A multi-byte character whose
    // bytes arrive in two chunks used to become two replacement characters.
    const fakeGit = (chunks) => () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
      setImmediate(async () => {
        for (const c of chunks) { child.stdout.write(c); await new Promise((r) => setImmediate(r)); }
        child.stdout.end(); child.stderr.end();
      });
      return child;
    };
    const bytes = Buffer.from('src/café.mjs\0', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of é
    const r = await gitRun(['ls-files', '-z'], tmpdir(), 5000, { spawnImpl: fakeGit([bytes.subarray(0, cut), bytes.subarray(cut)]) });
    ok('gitRun decodes a character whose bytes arrive in two chunks', r.code === 0 && r.stdout === 'src/café.mjs\0', JSON.stringify(r.stdout));

    // Names are compared as git compares them on the checkout: case-folded
    // only under core.ignoreCase, Unicode-normalized only under
    // core.precomposeUnicode (macOS hands back decomposed names).
    const v = typeof visibilitySet === 'function';
    ok('a case-insensitive checkout finds src/big.mjs when git lists src/Big.mjs', v && visibilitySet(['src/Big.mjs'], { ignoreCase: true }).has('src/big.mjs'));
    ok('a case-sensitive checkout keeps names exact', v && !visibilitySet(['src/Big.mjs']).has('src/big.mjs'));
    ok('precomposed Unicode finds a decomposed name', v && visibilitySet(['src/ä.mjs'], { unicode: true }).has('src/ä.mjs'));
    ok('without it, the two spellings stay distinct', v && !visibilitySet(['src/ä.mjs']).has('src/ä.mjs'));
  }

  if ((await gitIn(tmpdir(), ['--version'])).code !== 0) {
    ok('[UNTESTED] listing rows — git unavailable in this environment', true, 'fallback path is intentional');
    return;
  }

  {
    // A repository holding only ignored source files: git's listing is empty,
    // and an empty listing is an answer, not a failure. Zero files are scanned.
    const iroot = await mkdtemp(join(tmpdir(), 'maddu-mass-ignored-only-'));
    try {
      await gitIn(iroot, ['init', '-q']);
      await put(iroot, '.git/info/exclude', 'scratch/\n');
      await put(iroot, 'scratch/big.mjs', lines(200));
      const scan = await scanMass(iroot, { maxLines: 100 });
      ok('a repository with only ignored source files scans zero files', scan.totals.files === 0 && scan.oversize.length === 0, JSON.stringify(scan.totals));
    } finally {
      await rm(iroot, { recursive: true, force: true });
    }
  }

  {
    // Names git lists differently from the disk.
    const croot = await mkdtemp(join(tmpdir(), 'maddu-mass-names-'));
    try {
      await gitIn(croot, ['init', '-q']);
      await gitIn(croot, ['config', 'core.ignoreCase', 'true']);
      await put(croot, 'src/Big.mjs', lines(200));
      const added = await gitIn(croot, ['add', 'src/Big.mjs']);
      await rename(join(croot, 'src', 'Big.mjs'), join(croot, 'src', 'big.mjs'));
      await put(croot, ' lead.mjs', lines(210));
      await put(croot, 'src/café.mjs', lines(220));
      const listed = (await gitIn(croot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).out.split('\0');
      const onDisk = await readdir(join(croot, 'src'));
      ok('(setup) git lists the index name src/Big.mjs while the disk says big.mjs',
        added.code === 0 && listed.includes('src/Big.mjs') && !listed.includes('src/big.mjs') && onDisk.includes('big.mjs') && !onDisk.includes('Big.mjs'),
        JSON.stringify({ listed, onDisk }));
      ok('(setup) a root file whose name starts with a space exists and git lists it', listed.includes(' lead.mjs') && (await readdir(croot)).includes(' lead.mjs'), JSON.stringify(listed));
      const big = oversizePaths(await scanMass(croot, { maxLines: 100 }));
      ok('a file renamed in case only still counts under core.ignoreCase', big.includes('src/big.mjs'), JSON.stringify(big));
      ok('a file whose name starts with a space still counts', big.includes(' lead.mjs'), JSON.stringify(big));
      ok('a file with a non-ASCII name counts', big.includes('src/café.mjs'), JSON.stringify(big));
    } finally {
      await rm(croot, { recursive: true, force: true });
    }
  }

  {
    // Submodules and nested repositories are one entry in the parent's
    // listing: a gitlink (`components/engine`) or a directory (`nested/`).
    // Their files are read from their own listing, which keeps their own
    // ignore rules; a gitlink with no repository inside counts in full.
    const nroot = await mkdtemp(join(tmpdir(), 'maddu-mass-nested-'));
    try {
      await gitIn(nroot, ['init', '-q']);
      await put(nroot, 'src/app.mjs', lines(10));
      await mkdir(join(nroot, 'nested'), { recursive: true });
      await gitIn(join(nroot, 'nested'), ['init', '-q']);
      await put(nroot, 'nested/big.mjs', lines(200));
      await put(nroot, 'nested/.gitignore', 'gen/\n');
      await put(nroot, 'nested/gen/big.mjs', lines(205));
      await mkdir(join(nroot, 'components', 'engine'), { recursive: true });
      await gitIn(join(nroot, 'components', 'engine'), ['init', '-q']);
      await put(nroot, 'components/engine/big.mjs', lines(210));
      await put(nroot, 'components/stale/big.mjs', lines(215));
      const link = (p) => gitIn(nroot, ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},${p}`]);
      const linked = [await link('components/engine'), await link('components/stale')];
      const listed = (await gitIn(nroot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).out.split('\0');
      ok('(setup) the parent lists the nested repository and the gitlinks as single entries',
        linked.every((l) => l.code === 0) && listed.includes('nested/') && listed.includes('components/engine') && listed.includes('components/stale')
          && !listed.some((p) => p.endsWith('big.mjs')),
        JSON.stringify(listed));
      const big = oversizePaths(await scanMass(nroot, { maxLines: 100 }));
      ok('a file in an untracked nested repository counts', big.includes('nested/big.mjs'), JSON.stringify(big));
      ok('a file the nested repository ignores does not', !big.includes('nested/gen/big.mjs'), JSON.stringify(big));
      ok('a file in a submodule counts', big.includes('components/engine/big.mjs'), JSON.stringify(big));
      ok('a file under a gitlink with no repository inside counts', big.includes('components/stale/big.mjs'), JSON.stringify(big));
    } finally {
      await rm(nroot, { recursive: true, force: true });
    }
  }

  // ── config read: precedence + failure fallback (v1.155.0, Codex R2 2 & 4) ───
  //
  // Folding (core.ignoreCase / core.precomposeUnicode) must follow git's own
  // precedence (the last/effective value), and a config query that FAILS must
  // read null so the raw walk applies — never a silent false (exact matching).
  {
    ok('gitBoolConfig is exported', typeof gitBoolConfig === 'function');
    const f = typeof gitBoolConfig === 'function';
    // Deterministic, git-free: an injected spawn that returns a fixed exit.
    const fake = (code, out = '', errMsg) => () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      setImmediate(() => {
        if (out) child.stdout.write(out);
        child.stdout.end(); child.stderr.end();
        setImmediate(() => errMsg ? child.emit('error', new Error(errMsg)) : child.emit('close', code));
      });
      return child;
    };
    ok('a set true config reads true', f && (await gitBoolConfig('x', 'core.ignoreCase', { spawnImpl: fake(0, 'true\n') })) === true);
    ok('a set false config reads false', f && (await gitBoolConfig('x', 'core.ignoreCase', { spawnImpl: fake(0, 'false\n') })) === false);
    ok('an unset config (exit 1, empty) reads false, not a failure', f && (await gitBoolConfig('x', 'core.ignoreCase', { spawnImpl: fake(1, '') })) === false);
    ok('a config query that spawn-errors reads null so the raw walk applies', f && (await gitBoolConfig('x', 'core.ignoreCase', { spawnImpl: fake(0, '', 'boom') })) === null);
    ok('a fatal config exit (128) reads null', f && (await gitBoolConfig('x', 'core.ignoreCase', { spawnImpl: fake(128, '') })) === null);

    // Precedence against real git: an overridden true→false reads false (last
    // wins). The old `--get-regexp` + `.some(... true)` wrongly folded here.
    const proot = await mkdtemp(join(tmpdir(), 'maddu-mass-cfgprec-'));
    try {
      await gitIn(proot, ['init', '-q']);
      await gitIn(proot, ['config', '--add', 'core.ignoreCase', 'true']);
      await gitIn(proot, ['config', '--add', 'core.ignoreCase', 'false']);
      ok('config precedence: an overridden true then false reads false (last wins)',
        f && (await gitBoolConfig(proot, 'core.ignoreCase')) === false);
    } finally { await rm(proot, { recursive: true, force: true }); }
  }

  // ── scan discovers from cwd, not an inherited GIT_DIR (v1.155.0, R2 5) ──────
  //
  // A git hook runs with GIT_DIR/GIT_WORK_TREE pointing at the invoking repo.
  // Left in place, a scan subprocess answers about THAT repo, not the one under
  // cwd. With them pointed at a DIFFERENT empty repo, the buggy scan listed
  // nothing and the target's tracked monolith vanished; cleared, it is found.
  {
    const eroot = await mkdtemp(join(tmpdir(), 'maddu-mass-env-'));
    const other = await mkdtemp(join(tmpdir(), 'maddu-mass-env-other-'));
    const saved = { d: process.env.GIT_DIR, w: process.env.GIT_WORK_TREE, i: process.env.GIT_INDEX_FILE };
    try {
      await gitIn(eroot, ['init', '-q']);
      await put(eroot, 'src/big.mjs', lines(200));
      await gitIn(eroot, ['add', 'src/big.mjs']);
      await gitIn(other, ['init', '-q']);
      process.env.GIT_DIR = join(other, '.git');
      process.env.GIT_WORK_TREE = other;
      delete process.env.GIT_INDEX_FILE;
      const big = oversizePaths(await scanMass(eroot, { maxLines: 100 }));
      ok('a scan ignores an inherited GIT_DIR/GIT_WORK_TREE and discovers from cwd', big.includes('src/big.mjs'), JSON.stringify(big));
    } finally {
      if (saved.d === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.d;
      if (saved.w === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.w;
      if (saved.i === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved.i;
      await rm(eroot, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  }
}

try {
  await main();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err && err.stack ? err.stack : err);
  process.exit(2);
}
