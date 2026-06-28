#!/usr/bin/env node
// focus-trigger — the per-turn tagger + sustained-drift flag, end to end on a
// real spine. Verifies: FOCUS_TAGGED is appended per turn with a TRIGGER_FIRED
// provenance anchor; the focus{} projection window accumulates; a sustained run
// of off-axis turns emits a single DRIFT_FLAGGED; the flag cooldown suppresses a
// second flag; non-focus source events are skipped; and the gauntlet allowlist
// fails closed.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append, readAll, EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';
import { project } from '../../template/maddu/runtime/lib/projections.mjs';
import { maybeTagFocus } from '../../template/maddu/runtime/lib/focus-trigger.mjs';
import { isAllowed, lastFiredAt, withinCooldown } from '../../template/maddu/runtime/lib/gauntlet.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function setupRepo() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-focustrig-'));
  await mkdir(join(root, '.maddu', 'events'), { recursive: true });
  await mkdir(join(root, '.maddu', 'config'), { recursive: true });
  await writeFile(join(root, '.maddu', 'config', 'triggers.json'),
    JSON.stringify({ allowed: ['heartbeat:focus-director', 'slice-stop:focus-director'] }) + '\n');
  await append(root, { type: EVENT_TYPES.GOAL_DECLARED, data: { objective: 'ship the focus director deterministic tagger', success: [{ text: 'tagger flags drift', verify: null }] } });
  return root;
}

const hb = (focus) => ({ type: EVENT_TYPES.SESSION_HEARTBEAT, data: { focus } });

async function countType(root, type) {
  return (await readAll(root)).filter((e) => e.type === type).length;
}

async function main() {
  // --- gauntlet helper ---
  const root = await setupRepo();
  ok('isAllowed true for listed id', (await isAllowed(root, 'heartbeat:focus-director')) === true);
  ok('isAllowed false for unlisted id', (await isAllowed(root, 'nope:nope')) === false);

  // --- non-focus source is skipped ---
  const skip = await maybeTagFocus(root, { type: 'GOAL_DECLARED', id: 'x' });
  ok('non-focus source skipped', skip.skipped === 'not-a-focus-source');

  // --- per-turn tag: on-axis heartbeat appends FOCUS_TAGGED + TRIGGER_FIRED ---
  await append(root, hb('working on the focus director deterministic tagger'));
  const r1 = await maybeTagFocus(root, hb('working on the focus director deterministic tagger'), 'ses_test');
  ok('on-axis turn tagged toward', r1.tagged === true && r1.tag === 'toward', JSON.stringify(r1));
  ok('FOCUS_TAGGED appended', (await countType(root, 'FOCUS_TAGGED')) === 1);
  ok('TRIGGER_FIRED anchored', (await lastFiredAt(root, 'heartbeat:focus-director')) > 0);
  const projA = await project(root);
  ok('projection window grew', projA.focus.window.length === 1 && projA.focus.lastTag === 'toward');

  // --- sustained off-axis run → exactly one DRIFT_FLAGGED ---
  const offFocus = 'redesigning the marketing landing page gradient hero animation palette';
  for (let i = 0; i < 4; i++) {
    await append(root, hb(offFocus));
    await maybeTagFocus(root, hb(offFocus), 'ses_test');
  }
  const projB = await project(root);
  ok('lastTag is away after off-axis run', projB.focus.lastTag === 'away', JSON.stringify(projB.focus.lastTag));
  ok('exactly one DRIFT_FLAGGED', (await countType(root, 'DRIFT_FLAGGED')) === 1, `count=${await countType(root, 'DRIFT_FLAGGED')}`);
  ok('open flag present with menu', !!projB.focus.openFlag && projB.focus.openFlag.menu.join(',') === 'swap,revert,continue');

  // --- flag cooldown: more off-axis turns do NOT raise a second flag ---
  for (let i = 0; i < 3; i++) {
    await append(root, hb(offFocus));
    await maybeTagFocus(root, hb(offFocus), 'ses_test');
  }
  ok('flag cooldown suppresses second flag', (await countType(root, 'DRIFT_FLAGGED')) === 1, `count=${await countType(root, 'DRIFT_FLAGGED')}`);

  // --- withinCooldown helper reflects the just-fired tag trigger ---
  ok('withinCooldown true inside window', (await withinCooldown(root, 'heartbeat:focus-director', 60_000)) === true);
  ok('withinCooldown false for 0 cooldown', (await withinCooldown(root, 'heartbeat:focus-director', 0)) === false);

  await rm(root, { recursive: true, force: true });
}

try {
  await main();
  console.log('');
  console.log(`focus-trigger: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('focus-trigger OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
