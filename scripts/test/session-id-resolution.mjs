#!/usr/bin/env node
// PR1 ambient identity: real CLI attribution against owned spine fixtures.
// Exit: 0 all assertions pass, 1 assertion failure, 2 harness error.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { append, readAllStrict, isRefId } from '../../template/maddu/runtime/lib/spine.mjs';
import { recordInvocationSync } from '../../template/maddu/runtime/lib/invocation-receipts.mjs';
import {
  activePath, cleanupFixtures, cli, events, marker, receipts, segment, setPointer,
  selfTestArgs, selfTestSource, spool,
} from './_pr1-fixtures.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const CANDIDATE = 'ses_20260101000000_dead00';
const CACHE = 'ses_20260101000000_cafe00';
const malformed = 'invalid/session';

async function seed(root, state, cache = true) {
  if (!isRefId(CANDIDATE) || !isRefId(CACHE) || isRefId(malformed)) throw new Error('fixture id grammar mismatch');
  if (state !== 'absent' && state !== 'malformed') {
    await append(root, { type: 'SESSION_REGISTERED', actor: CANDIDATE, data: { role: 'implementer', label: 'candidate' } });
    if (state !== 'live') {
      await append(root, { type: 'SESSION_CLOSED', actor: CANDIDATE, data: { handoff: null } });
    }
  }
  // Register a second, distinct live session to expose incorrect fallback.
  await append(root, { type: 'SESSION_REGISTERED', actor: CACHE, data: { role: 'implementer', label: 'cache' } });
  if (cache) await setPointer(root, CACHE);
  const clean = await readAllStrict(root);
  if (clean.parseErrors !== 0) throw new Error('fixture replay must initially be complete');
  if (state === 'absent' && clean.events.some((e) => e.actor === CANDIDATE)) throw new Error('absent candidate was registered');
  if (state === 'parse-error') {
    const lines = (await readFile(segment(root), 'utf8')).split('\n');
    // Keep the genesis and complete tail intact; corrupt an interior line.
    lines.splice(1, 0, '{PR1 deliberate corrupt line');
    await writeFile(segment(root), lines.join('\n'));
    const partial = await readAllStrict(root);
    if (partial.parseErrors !== 1 || !partial.events.some((e) => e.type === 'SESSION_CLOSED' && e.actor === CANDIDATE)) {
      throw new Error('partial replay must contain both a parse error and positive close evidence');
    }
  }
  if (state === 'unreadable') {
    // Directory in place of a segment deterministically rejects readFile on
    // Windows and WSL, even as an elevated user. No chmod/ACL/symlink dependency.
    await rename(segment(root), segment(root) + '.saved');
    await mkdir(segment(root));
    let rejected = false;
    try { await readAllStrict(root); } catch { rejected = true; }
    if (!rejected) throw new Error('unreadable-spine fixture was readable');
  }
}

function dropLines(stderr) {
  return stderr.split(/\r?\n/).filter((line) => /MADDU_SESSION_ID|ses_20260101000000_dead00/.test(line));
}
function droppedOnce(stderr) {
  const lines = dropLines(stderr);
  // The contract specifies meaning and one line, not a literal diagnostic.
  return lines.length === 1 && /drop(?:ped|ping)?|ignor(?:ed|ing)|discard(?:ed|ing)?/i.test(lines[0]);
}

try {
  for (const [index, state] of ['live', 'closed', 'absent', 'parse-error', 'malformed'].entries()) {
    const root = await marker('maddu-pr1-sid-');
    await seed(root, state);
    const before = (await readAllStrict(root)).events.filter((e) => e.type === 'GOAL_DECLARED').length;
    const envId = state === 'malformed' ? malformed : CANDIDATE;
    const r = cli(root, ['goal', 'set', '--objective', `PR1 ${state}`], { MADDU_SESSION_ID: envId });
    const added = (await readAllStrict(root)).events.filter((e) => e.type === 'GOAL_DECLARED').slice(before);
    const expected = ['live', 'parse-error'].includes(state) ? CANDIDATE : CACHE;
    // A malformed id is not a candidate at all, so it must never attribute,
    // and must do so SILENTLY — there was nothing to drop. PR1 deliberately
    // does NOT decide what it falls through TO: base behaviour is a null
    // actor, and demanding the cache id instead would expand this PR past
    // the plan's 'a malformed id still falls through silently'. Retained as
    // a control: it still bites if the new policy ever admits a malformed id.
    const actorOk = state === 'malformed'
      ? added[0]?.actor !== malformed
      : added[0]?.actor === expected;
    const diagnostic = ['closed', 'absent'].includes(state) ? droppedOnce(r.stderr)
      : state === 'malformed' ? r.stderr === '' : dropLines(r.stderr).length === 0;
    ok(`PR1 SID${index + 1}: command actor - ${state}`,
      r.status === 0 && added.length === 1 && actorOk && diagnostic,
      `exit=${r.status} delta=${added.length} actor=${added[0]?.actor} expected=${state === 'malformed' ? 'not ' + malformed : expected} stderr=${JSON.stringify(r.stderr.trim())}`);
  }

  {
    const root = await marker('maddu-pr1-unreadable-');
    await seed(root, 'unreadable');
    const before = (await receipts(root)).length;
    // Cannot append a command event to an unreadable segment: observe the
    // independently writable invocation corpus instead (no module mocking).
    const r = cli(root, ['skill', 'list'], { MADDU_SESSION_ID: CANDIDATE });
    const added = (await receipts(root)).slice(before);
    ok('PR1 SID6: unreadable spine keeps candidate in receipt (negative control)',
      r.status === 0 && added.length === 1 && added[0].sessionId === CANDIDATE && dropLines(r.stderr).length === 0,
      `exit=${r.status} delta=${added.length} sessionId=${added[0]?.sessionId} stderr=${JSON.stringify(r.stderr.trim())}`);
  }

  {
    const root = await marker('maddu-pr1-witness-actor-');
    await seed(root, 'closed');
    const beforeSpool = await spool(root);
    const before = (await events(root, 'MUTATION_UNWITNESSED')).length;
    const r = cli(root, ['goal', 'set', '--objective', 'PR1 witness attribution'], {
      MADDU_SESSION_ID: CANDIDATE, __MADDU_TEST_ZERO_CREDIT__: '1',
    });
    const spooled = await spool(root);
    // Drain without the candidate; actor must come from the captured witness
    // context, not from whichever process happened to drain the spool.
    const drain = cli(root, ['plan', 'list']);
    const added = (await events(root, 'MUTATION_UNWITNESSED')).slice(before);
    ok('PR1 SID7: CLI witness captures the verified cache actor',
      beforeSpool.length === 0 && r.status === 1 && spooled.length === 1
      && spooled[0].sessionId === CACHE && droppedOnce(r.stderr)
      && drain.status === 0 && (await spool(root)).length === 0
      && added.length === 1 && added[0].actor === CACHE && added[0].data.breachId === spooled[0].breachId,
      `exit=${r.status} spool=${spooled.length} spoolSid=${spooled[0]?.sessionId} delta=${added.length} actor=${added[0]?.actor}`);
  }

  {
    const root = await selfTestSource();
    await seed(root, 'closed');
    const before = (await events(root, 'VERIFICATION_RAN')).length;
    const r = cli(root, ['self-test', ...selfTestArgs], { MADDU_SESSION_ID: CANDIDATE }, join(root, 'bin', 'maddu.mjs'));
    const added = (await events(root, 'VERIFICATION_RAN')).slice(before);
    ok('PR1 SID8: self-test VERIFICATION_RAN uses the verified cache actor',
      r.status === 0 && added.length === 1 && added[0].actor === CACHE
      && added[0].data.kind === 'self-test' && added[0].data.counts?.pass === 1 && droppedOnce(r.stderr),
      `exit=${r.status} delta=${added.length} actor=${added[0]?.actor} stderr=${JSON.stringify(r.stderr.trim())}`);
  }

  for (const [index, cache] of [true, false].entries()) {
    const root = await marker('maddu-pr1-exit-receipt-');
    await seed(root, 'closed', cache);
    const before = (await receipts(root)).length;
    const r = cli(root, ['plan', 'list'], { MADDU_SESSION_ID: CANDIDATE });
    const added = (await receipts(root)).slice(before);
    const expected = cache ? CACHE : null;
    ok(`PR1 SID${index + 9}: exit receipt honors resolved ${cache ? 'cache id' : 'null without a pointer'}`,
      r.status === 0 && added.length === 1 && added[0].sessionId === expected && droppedOnce(r.stderr),
      `exit=${r.status} delta=${added.length} sessionId=${added[0]?.sessionId} expected=${expected} stderr=${JSON.stringify(r.stderr.trim())}`);
  }

  {
    const root = await marker('maddu-pr1-null-writer-');
    await seed(root, 'closed');
    const before = (await receipts(root)).length;
    const written = recordInvocationSync({ stateRoot: root, verb: 'plan', sub: 'list', sessionId: null,
      env: { MADDU_SESSION_ID: CANDIDATE } });
    const added = (await receipts(root)).slice(before);
    ok('PR1 SID11: synchronous receipt writer treats explicit null as authoritative',
      written && added.length === 1 && added[0].sessionId === null,
      `written=${written} delta=${added.length} sessionId=${added[0]?.sessionId}`);
  }

  {
    const root = await marker('maddu-pr1-close-target-');
    await seed(root, 'closed');
    const pointerBefore = await readFile(activePath(root));
    const before = (await events(root, 'SESSION_CLOSED')).length;
    const r = cli(root, ['session', 'close'], { MADDU_SESSION_ID: CANDIDATE });
    const added = (await events(root, 'SESSION_CLOSED')).slice(before);
    const pointerAfter = await readFile(activePath(root)).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    ok('PR1 SID12: close retains the already-closed env TARGET and cache bytes (negative control)',
      r.status === 0 && r.stdout.trim() === `(already closed)  ${CANDIDATE}`
      && added.length === 0 && !added.some((e) => e.actor === CACHE)
      && pointerAfter !== null && pointerBefore.equals(pointerAfter),
      `exit=${r.status} closeDelta=${added.length} stdout=${JSON.stringify(r.stdout.trim())} pointerSame=${pointerAfter !== null && pointerBefore.equals(pointerAfter)}`);
  }

  await cleanupFixtures();
  console.log(`\nsession-id-resolution: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  await cleanupFixtures();
  process.exit(2);
}
