#!/usr/bin/env node
// PR5 clause 1: a register receipt must name the session that command minted.
// Run byte-copied real CLI code; all state and home paths belong to fixtures.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { childEnv, cleanupFixtures } from './_pr1-fixtures.mjs';
import { sourceFixture, fixtureEnv } from './_pr2-fixtures.mjs';

let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond, extra = '') => {
  extra = extra.replace(/\s+/g, ' ').trim();
  if (cond) { passed++; console.log(`  [PASS] ${name} - ${extra || 'assertion holds'}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};

function cli(root, args, sessionId) {
  const env = childEnv(fixtureEnv(root));
  // Delete, do not substitute an empty string. Case-insensitive on Windows.
  for (const key of Object.keys(env)) {
    if (/^MADDU_SESSION_ID$/i.test(key)) delete env[key];
  }
  if (sessionId !== undefined) env.MADDU_SESSION_ID = sessionId;
  const r = spawnSync(process.execPath, [join(root, 'bin/maddu.mjs'), ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  if (r.error || r.signal || r.status !== 0) {
    throw new Error(`${args.join(' ')}: exit=${r.status}, signal=${r.signal}, ${r.error?.message || ''} ${r.stderr}`);
  }
  return r;
}

function minted(r) {
  const id = r.stdout.split(/\r?\n/)[0].trim();
  if (!/^ses_[\w.-]+$/.test(id)) throw new Error(`register did not print a session id first: ${r.stdout}`);
  return id;
}

async function lastReceipt(root, verb, expectedCount) {
  const text = await readFile(join(root, '.maddu/state/invocation-receipts.ndjson'), 'utf8');
  const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
    .filter((row) => row.verb === verb);
  // Receipt absence or command failure is a harness problem, not the C2 red.
  if (rows.length !== expectedCount || !Object.hasOwn(rows.at(-1), 'sessionId')) {
    throw new Error(`${verb}: expected ${expectedCount} receipts with sessionId, observed ${JSON.stringify(rows)}`);
  }
  if (rows.at(-1).exit !== 0) throw new Error(`${verb}: nonzero receipt exit=${rows.at(-1).exit}`);
  return rows.at(-1);
}

try {
  const firstRoot = await sourceFixture('maddu-pr5-register-first-');
  const first = minted(cli(firstRoot, ['register']));
  const receipt = await lastReceipt(firstRoot, 'register', 1);
  ok('1a fresh register receipt carries its minted id', receipt.sessionId === first,
    `minted=${first}; observed receipt.sessionId=${JSON.stringify(receipt.sessionId)}; fixture=${firstRoot}`);

  const twiceRoot = await sourceFixture('maddu-pr5-register-twice-');
  const previous = minted(cli(twiceRoot, ['register']));
  const second = minted(cli(twiceRoot, ['register']));
  if (second === previous) throw new Error('env-free second register did not mint a distinct id');
  const secondReceipt = await lastReceipt(twiceRoot, 'register', 2);
  ok('1b second register receipt carries the second id, not the previous active id',
    secondReceipt.sessionId === second,
    `first=${previous}; second=${second}; observed receipt.sessionId=${JSON.stringify(secondReceipt.sessionId)}`);

  cli(twiceRoot, ['status']);
  const statusReceipt = await lastReceipt(twiceRoot, 'status', 1);
  ok('1c [control] ordinary status receipt uses the newly active session', statusReceipt.sessionId === second,
    `active=${second}; observed receipt.sessionId=${JSON.stringify(statusReceipt.sessionId)}`);

  const reused = minted(cli(twiceRoot, ['register'], second));
  const reuseReceipt = await lastReceipt(twiceRoot, 'register', 3);
  ok('1d [control] live env-pinned register reuses and attributes the same id',
    reused === second && reuseReceipt.sessionId === second,
    `env=${second}; stdout=${reused}; observed receipt.sessionId=${JSON.stringify(reuseReceipt.sessionId)}`);
} catch (err) {
  ok('PR5 register-receipt harness', false, err.stack || err.message);
} finally {
  await cleanupFixtures();
}
console.log('');
console.log(`register-receipt: PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
