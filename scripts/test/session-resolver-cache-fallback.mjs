#!/usr/bin/env node
// session-resolver-cache-fallback — resolveSessionId precedence (v1.73.x).
//
// The session-discipline commands (lane claim/release, slice-stop, slice
// scope-*) resolve the acting session via a single shared helper so a single
// `maddu register` flows into all of them across fresh tool-call shells where
// $MADDU_SESSION_ID does not persist — removing the friction that made the
// register/claim/slice ritual get skipped on fresh installs. Precedence:
// explicit --session flag > $MADDU_SESSION_ID > the liveness-verified
// active-session cache. A stale (closed) cache must NOT resolve.
//
// Drives resolveSessionId with a stubbed sessionActive lib (no temp repo).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { resolveSessionId } from '../../commands/_spine.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// A sessionActive stub whose verified-read returns a fixed result.
const stub = (result) => ({ readActiveSessionVerified: async () => result });
const ALIVE = { sessionId: 'ses_cache_alive' };
const STALE = { stale: true, sessionId: 'ses_cache_closed' };

async function main() {
  const saved = process.env.MADDU_SESSION_ID;
  delete process.env.MADDU_SESSION_ID;
  try {
    // 1. explicit flag wins over everything
    ok('explicit --session flag wins', await resolveSessionId('/x', { session: 'ses_flag' }, stub(ALIVE)) === 'ses_flag');

    // 2. env beats the cache when no flag
    process.env.MADDU_SESSION_ID = 'ses_env';
    ok('env beats cache', await resolveSessionId('/x', {}, stub(ALIVE)) === 'ses_env');
    delete process.env.MADDU_SESSION_ID;

    // 3. cache resolves when flag + env absent (the fresh-shell case)
    ok('alive cache resolves when flag+env absent', await resolveSessionId('/x', {}, stub(ALIVE)) === 'ses_cache_alive');

    // 4. a stale (closed) cache must NOT resolve — returns null, caller errors
    ok('stale cache does not resolve', await resolveSessionId('/x', {}, stub(STALE)) === null);

    // 5. no cache at all → null
    ok('no cache → null', await resolveSessionId('/x', {}, stub(null)) === null);

    // 6. missing sessionActive lib (pre-v0.14 install) → null, no throw
    ok('absent sessionActive lib → null (no throw)', await resolveSessionId('/x', {}, null) === null);

    // 7. PR-B: an OWNED-but-malformed --session is a HARD error (never a silent
    //    fall-through to env/cache, which could resolve a DIFFERENT session).
    //    Bare true, empty '', repeated array, and bad grammar all throw.
    for (const [label, val] of [['bare true', true], ['empty', ''], ['array', ['a', 'b']], ['bad grammar', 'bad id!']]) {
      let threw = false;
      try { await resolveSessionId('/x', { session: val }, stub(ALIVE)); }
      catch (e) { threw = !!(e && e.code === 'INVALID_EXPLICIT_ID'); }
      ok(`malformed --session (${label}) throws InvalidExplicitId`, threw);
    }

    // 8. a malformed AMBIENT env is NOT an explicit request → falls through to
    //    the (valid) cache rather than throwing.
    process.env.MADDU_SESSION_ID = 'bad env!';
    ok('malformed env falls through to cache', await resolveSessionId('/x', {}, stub(ALIVE)) === 'ses_cache_alive');
    delete process.env.MADDU_SESSION_ID;
  } finally {
    if (saved === undefined) delete process.env.MADDU_SESSION_ID;
    else process.env.MADDU_SESSION_ID = saved;
  }
}

try {
  await main();
  console.log('');
  console.log(`session-resolver-cache-fallback: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('session-resolver-cache-fallback OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
