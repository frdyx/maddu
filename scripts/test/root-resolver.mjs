#!/usr/bin/env node
// root-resolver — the work-root / state-root split (roadmap #12a, phase 1).
//
// The trap this pins: a lane worktree under .maddu/worktrees/<lane>/ is a
// full checkout carrying its own tracked copy of .maddu/. A naive walk-up
// from inside it finds THAT copy and every spine append lands in the checkout
// instead of the primary repo's record. resolveRoots must (a) keep legacy
// behavior bit-identical when no redirection marker exists, (b) honor the
// .maddu-state-root pointer file, (c) let MADDU_STATE_ROOT env win over the
// pointer, and (d) THROW on a broken pointer rather than silently falling
// back — a silent fallback re-creates the split-spine bug.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { findRepoRoot, resolveRoots, STATE_ROOT_POINTER } from '../../template/maddu/runtime/lib/paths.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
const norm = (p) => (p ? resolve(p) : p);
const NO_ENV = {}; // never let the harness's own MADDU_STATE_ROOT leak in

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'maddu-roots-'));
  try {
    // ── fixture ──
    // primary/                      ← the real repo (.maddu/ = the spine home)
    //   .maddu/
    //     worktrees/lane-x/         ← lane worktree checkout
    //       .maddu/                 ← the checkout's own tracked COPY
    //       .maddu-state-root       ← pointer → primary
    //       src/deep/               ← nested cwd inside the worktree
    //     worktrees/lane-y/         ← pointer-only worktree (.maddu untracked)
    //       src/
    //   src/
    const primary = join(base, 'primary');
    const laneX = join(primary, '.maddu', 'worktrees', 'lane-x');
    const laneY = join(primary, '.maddu', 'worktrees', 'lane-y');
    await mkdir(join(primary, '.maddu'), { recursive: true });
    await mkdir(join(primary, 'src'), { recursive: true });
    await mkdir(join(laneX, '.maddu'), { recursive: true });
    await mkdir(join(laneX, 'src', 'deep'), { recursive: true });
    await mkdir(join(laneY, 'src'), { recursive: true });
    await writeFile(join(laneX, STATE_ROOT_POINTER), primary + '\n');
    await writeFile(join(laneY, STATE_ROOT_POINTER), primary + '\n');

    // ── 1. legacy behavior unchanged when no marker is involved ──
    const plain = await resolveRoots(join(primary, 'src'), NO_ENV);
    ok('plain repo: workRoot == stateRoot == primary',
      norm(plain.workRoot) === norm(primary) && norm(plain.stateRoot) === norm(primary) && plain.redirected === false);
    ok('plain repo: matches legacy findRepoRoot',
      norm(await findRepoRoot(join(primary, 'src'))) === norm(plain.workRoot));
    ok('outside any repo: null', (await resolveRoots(base, NO_ENV)) === null);

    // ── 2. THE TRAP: nested worktree with its own .maddu copy ──
    const trap = await resolveRoots(join(laneX, 'src', 'deep'), NO_ENV);
    ok('worktree: workRoot is the worktree checkout', norm(trap.workRoot) === norm(laneX));
    ok('worktree: stateRoot redirects to the PRIMARY repo', norm(trap.stateRoot) === norm(primary));
    ok('worktree: redirected flag set', trap.redirected === true);
    ok('legacy findRepoRoot falls into the trap (documents why the split exists)',
      norm(await findRepoRoot(join(laneX, 'src', 'deep'))) === norm(laneX));

    // ── 3. pointer-only worktree (no .maddu in the checkout) ──
    const py = await resolveRoots(join(laneY, 'src'), NO_ENV);
    ok('pointer-only: workRoot is the worktree, not the primary', norm(py.workRoot) === norm(laneY));
    ok('pointer-only: stateRoot is the primary', norm(py.stateRoot) === norm(primary) && py.redirected === true);

    // ── 4. env var wins over the pointer ──
    const alt = join(base, 'alt');
    await mkdir(join(alt, '.maddu'), { recursive: true });
    const viaEnv = await resolveRoots(join(laneX, 'src'), { MADDU_STATE_ROOT: alt });
    ok('MADDU_STATE_ROOT beats the pointer file', norm(viaEnv.stateRoot) === norm(alt) && viaEnv.redirected === true);
    let envThrew = false;
    try { await resolveRoots(join(primary, 'src'), { MADDU_STATE_ROOT: join(base, 'nowhere') }); }
    catch { envThrew = true; }
    ok('invalid MADDU_STATE_ROOT throws (never silently falls back)', envThrew);

    // ── 5. broken / empty pointers throw ──
    const laneBad = join(primary, '.maddu', 'worktrees', 'lane-bad');
    await mkdir(join(laneBad, '.maddu'), { recursive: true });
    await writeFile(join(laneBad, STATE_ROOT_POINTER), join(base, 'gone') + '\n');
    let badThrew = false;
    try { await resolveRoots(laneBad, NO_ENV); } catch { badThrew = true; }
    ok('pointer to a dir without .maddu/ throws', badThrew);

    const laneEmpty = join(primary, '.maddu', 'worktrees', 'lane-empty');
    await mkdir(join(laneEmpty, '.maddu'), { recursive: true });
    await writeFile(join(laneEmpty, STATE_ROOT_POINTER), '   \n');
    let emptyThrew = false;
    try { await resolveRoots(laneEmpty, NO_ENV); } catch { emptyThrew = true; }
    ok('empty pointer file throws', emptyThrew);

    // ── 6. relative pointer + CRLF tolerance (Windows) ──
    const laneRel = join(primary, '.maddu', 'worktrees', 'lane-rel');
    await mkdir(join(laneRel, '.maddu'), { recursive: true });
    await writeFile(join(laneRel, STATE_ROOT_POINTER), `..${sep}..${sep}..\r\n`);
    const rel = await resolveRoots(laneRel, NO_ENV);
    ok('relative pointer resolves against the work root (CRLF-tolerant)',
      norm(rel.stateRoot) === norm(primary) && rel.redirected === true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  console.log(`\nroot-resolver: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err}`); process.exit(2); });
