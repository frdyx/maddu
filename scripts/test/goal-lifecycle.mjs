#!/usr/bin/env node
// Test — goal lifecycle (GOAL_COMPLETED closes a declared goal).
//
// Before this, a goal was the latest GOAL_DECLARED forever — a finished
// objective lingered as "the current goal". GOAL_COMPLETED transitions it to
// completed/abandoned so orient/show can prompt for a fresh one.
//
// Exit 0 = pass, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', '..', 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function makeRepo() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-goal-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}

async function main() {
  const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
  const projections = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);
  const T = spine.EVENT_TYPES;

  // 1. Declare → active.
  {
    const repo = await makeRepo();
    await spine.append(repo, { type: T.GOAL_DECLARED, actor: null, data: { objective: 'X', constraints: [], success: [] } });
    const p = await projections.project(repo);
    ok('declared goal is active', p.goal?.status === 'active' && p.goal?.objective === 'X');
    ok('  not yet completed', p.goal?.completedAt === null);
    await rm(repo, { recursive: true, force: true });
  }

  // 2. Complete → completed with note + timestamp.
  {
    const repo = await makeRepo();
    await spine.append(repo, { type: T.GOAL_DECLARED, actor: null, data: { objective: 'X', constraints: [], success: [] } });
    await spine.append(repo, { type: T.GOAL_COMPLETED, actor: null, data: { note: 'shipped', objective: 'X', outcome: 'done' } });
    const p = await projections.project(repo);
    ok('completed goal has status completed', p.goal?.status === 'completed', JSON.stringify(p.goal));
    ok('  completedAt set', !!p.goal?.completedAt);
    ok('  completion note carried', p.goal?.completionNote === 'shipped');
    await rm(repo, { recursive: true, force: true });
  }

  // 3. Abandon outcome.
  {
    const repo = await makeRepo();
    await spine.append(repo, { type: T.GOAL_DECLARED, actor: null, data: { objective: 'Y', constraints: [], success: [] } });
    await spine.append(repo, { type: T.GOAL_COMPLETED, actor: null, data: { note: null, objective: 'Y', outcome: 'abandoned' } });
    const p = await projections.project(repo);
    ok('abandoned outcome → status abandoned', p.goal?.status === 'abandoned');
    await rm(repo, { recursive: true, force: true });
  }

  // 4. COMPLETED with no prior declare → no crash, goal stays null.
  {
    const repo = await makeRepo();
    await spine.append(repo, { type: T.GOAL_COMPLETED, actor: null, data: { note: null, objective: null, outcome: 'done' } });
    const p = await projections.project(repo);
    ok('completion without a goal is a no-op', p.goal == null);
    await rm(repo, { recursive: true, force: true });
  }

  // 5. Re-declare after completion → a fresh active goal (latest wins).
  {
    const repo = await makeRepo();
    await spine.append(repo, { type: T.GOAL_DECLARED, actor: null, data: { objective: 'old', constraints: [], success: [] } });
    await spine.append(repo, { type: T.GOAL_COMPLETED, actor: null, data: { note: null, objective: 'old', outcome: 'done' } });
    await spine.append(repo, { type: T.GOAL_DECLARED, actor: null, data: { objective: 'new', constraints: [], success: [] } });
    const p = await projections.project(repo);
    ok('re-declared goal is active again', p.goal?.status === 'active' && p.goal?.objective === 'new');
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`\ngoal-lifecycle: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
