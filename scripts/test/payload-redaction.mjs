#!/usr/bin/env node
// Central spine payload sweep — worker/agent payload redaction at the
// write boundary (plan pln_20260706215157_42d3). Run:
//   node scripts/test/payload-redaction.mjs
//
// Asserts, against a real temp spine:
//   1. Every flagged free-text channel funnels through spine.append and is
//      stored REDACTED: slice-stop prose, heartbeat focus, session handoff,
//      inbox message, task spread-body, approval payload (nested), boss text.
//   2. Key-aware rule: {"password"/"apiKey"/"auth_token": "<long value>"} is
//      redacted whole (keys preserved) — the shape the leaf regex and any
//      line-wise regex both miss.
//   3. Clean path: append() returns the caller's ORIGINAL data reference
//      (no clone), stored bytes carry the exact input, and toJSON-bearing
//      values (Date) keep today's serialization.
//   4. Idempotence: re-appending stored (already-redacted) data is byte-stable.
//   5. prev_hash chains over the STORED (redacted) bytes — spine verify-style
//      recompute finds no fork.
//   6. The wrapper bypass (appendTokenUsage) sweeps its own path: a
//      secret-shaped `model` string parsed from a malformed provider frame
//      never lands raw; numeric fields untouched.
//   7. Short values under sensitive keys ("hunter2") and framework fields
//      (checkpointKey sha256 hex, event ids, git SHAs) are NOT touched —
//      the tight/high-confidence bar holds.

import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append, EVENT_TYPES, hashLine } from '../../template/maddu/runtime/lib/spine.mjs';
import { appendTokenUsage, logWrapperError } from '../../template/maddu/runtime/lib/runtimes/_wrapper-common.mjs';
import { redactDataPayload, redactText, redactLeaves, matchSecretType } from '../../template/maddu/runtime/lib/secret-scan.mjs';
import { send as mailboxSend } from '../../template/maddu/runtime/lib/mailbox.mjs';
import { curate } from '../../template/maddu/runtime/lib/briefings.mjs';
import { saveSkill, readSkill } from '../../template/maddu/runtime/lib/skills.mjs';
import { writeActiveSession, readActiveSession } from '../../template/maddu/runtime/lib/session-active.mjs';
import { appendFactIfNew } from '../../template/maddu/runtime/lib/hindsight.mjs';
import { safeImport } from '../../template/maddu/runtime/lib/imports.mjs';
import { pathsFor } from '../../template/maddu/runtime/lib/paths.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

// Fake but pattern-valid credentials (none are real).
const FAKE = {
  anthropic: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF',
  github: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  envLine: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789',
  longValue: 'c3VwZXJzZWNyZXRwYXlsb2FkdmFsdWU0NGNoYXJz',
  // v1.99.0 (P5) new shapes
  githubPat: 'github_pat_' + '1'.repeat(60),
  ghu: 'ghu_' + 'a'.repeat(36),
  google: 'AIza' + 'B'.repeat(35),
  stripe: 'sk_live_' + 'C'.repeat(30),
  pem: '-----BEGIN PRIVATE KEY-----\nMII' + 'x'.repeat(64) + '\n-----END PRIVATE KEY-----',
};

async function readSpineLines(repo) {
  const dir = join(repo, '.maddu', 'events');
  const segs = (await readdir(dir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  const lines = [];
  for (const s of segs) {
    lines.push(...(await readFile(join(dir, s), 'utf8')).split('\n').filter((l) => l.trim()));
  }
  return lines;
}

async function main() {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-payload-redaction-'));
  try {
    // ── 1. Every flagged free-text channel, through the real append ──
    const channels = [
      [EVENT_TYPES.SLICE_STOP, { summary: `done, used ${FAKE.anthropic} for the call`, action: 'edited x', reason: 'ok' }],
      [EVENT_TYPES.WORKER_HEARTBEAT, { id: 'wrk_1', focus: `retry with token ${FAKE.github}` }],
      [EVENT_TYPES.SESSION_CLOSED, { handoff: `next: rotate ${FAKE.aws} in ci` }],
      [EVENT_TYPES.INBOX_MESSAGE, { message: `pasted env: ${FAKE.envLine}` }],
      [EVENT_TYPES.HANDOFF_SET, { body: `resume: key is ${FAKE.anthropic}` }],
    ];
    for (const [type, data] of channels) {
      const ev = await append(repo, { type, data });
      const stored = JSON.stringify(ev);
      ok(!/sk-ant-|ghp_A1b2|AKIA[0-9A-Z]{16}|sk-abcdefghij/.test(stored), `${type}: raw secret not in returned event`);
      ok(/\[REDACTED:/.test(stored), `${type}: redaction marker present`);
    }
    let lines = await readSpineLines(repo);
    ok(!lines.some((l) => /sk-ant-api03|ghp_A1b2|AKIAIOSFODNN7EXAMPLE|sk-abcdefghijklmnop/.test(l)),
      'no raw secret on any stored spine line');

    // ── 2. Key-aware: the bridge spread-body shape ──
    const spreadBody = {
      id: 'tsk_1',
      title: 'deploy',
      password: FAKE.longValue,               // sensitive key, no pattern prefix
      apiKey: FAKE.longValue,                 // camelCase key form
      auth_token: FAKE.longValue,
      metadata: { nested: { secret_key: FAKE.longValue } },
      note: 'clean text stays',
    };
    const evSpread = await append(repo, { type: EVENT_TYPES.TASK_UPDATED, data: spreadBody });
    ok(!JSON.stringify(evSpread).includes(FAKE.longValue), 'key-aware: long values under sensitive keys redacted');
    ok(evSpread.data.password === '[REDACTED:value-under-sensitive-key]', 'key-aware: password value replaced whole');
    ok(evSpread.data.apiKey === '[REDACTED:value-under-sensitive-key]', 'key-aware: camelCase apiKey caught');
    ok(evSpread.data.metadata.nested.secret_key === '[REDACTED:value-under-sensitive-key]', 'key-aware: nested hit');
    ok('password' in evSpread.data && 'apiKey' in evSpread.data, 'key-aware: keys preserved, never dropped');
    ok(evSpread.data.note === 'clean text stays', 'key-aware: sibling clean fields untouched');
    ok(evSpread.data.title === 'deploy', 'key-aware: short clean value under clean key untouched');

    // ── 7 (early). Tight bar: short values + framework shapes untouched ──
    const tight = {
      password: 'hunter2',                                    // <16 chars — not matched by design
      checkpointKey: 'sha256:' + 'a'.repeat(64),              // framework field, hex
      commit: '3d93e3c9b54c8e21f77e126f77e126f77e126f77',     // git SHA
      approvalRequestId: 'evt_20260706212537_74a08c',
    };
    const evTight = await append(repo, { type: EVENT_TYPES.TASK_UPDATED, data: tight });
    ok(evTight.data === tight, 'tight bar: no hit → original reference returned (no clone)');
    ok(evTight.data.password === 'hunter2', 'tight bar: short password value untouched');
    ok(evTight.data.checkpointKey === tight.checkpointKey, 'tight bar: checkpointKey untouched');

    // ── 3. Clean path: reference identity + Date/toJSON preserved ──
    const cleanData = { focus: 'plain focus text', when: new Date('2026-01-02T03:04:05.000Z') };
    const evClean = await append(repo, { type: EVENT_TYPES.WORKER_HEARTBEAT, data: cleanData });
    ok(evClean.data === cleanData, 'clean path: append returns the original data reference');
    lines = await readSpineLines(repo);
    ok(lines[lines.length - 1].includes('"2026-01-02T03:04:05.000Z"'), 'clean path: Date serialized via toJSON as before');

    // ── 4. Idempotence: stored redacted data re-appends byte-stable ──
    const once = redactDataPayload({ password: FAKE.longValue, text: `k ${FAKE.anthropic}` });
    const twice = redactDataPayload(once);
    ok(JSON.stringify(twice) === JSON.stringify(once), 'idempotent: second sweep is byte-stable');

    // ── 5. prev_hash chains over stored bytes ──
    lines = await readSpineLines(repo);
    let forked = false;
    for (let i = 1; i < lines.length; i++) {
      if (JSON.parse(lines[i]).prev_hash !== hashLine(lines[i - 1])) { forked = true; break; }
    }
    ok(!forked, `chain intact over ${lines.length} stored (redacted) lines`);
    ok(lines.length === 8, `all 8 appends stored (got ${lines.length})`);

    // ── 6. Wrapper bypass sweeps itself ──
    const tok = await appendTokenUsage(repo, {
      runtime: 'claude', sessionId: 'ses_x',
      model: `claude-opus ${FAKE.anthropic}`,   // malformed frame carried a secret
      inputTokens: 10, outputTokens: 20,
    });
    ok(tok && !JSON.stringify(tok).includes('sk-ant-api03'), 'wrapper: secret-shaped model string redacted');
    ok(tok.data.inputTokens === 10 && tok.data.outputTokens === 20, 'wrapper: numeric fields untouched');
    const tokClean = await appendTokenUsage(repo, { runtime: 'claude', sessionId: 'ses_x', model: 'claude-opus-4-8', inputTokens: 1 });
    ok(tokClean.data.model === 'claude-opus-4-8', 'wrapper: clean model string untouched');
    lines = await readSpineLines(repo);
    ok(!lines.some((l) => l.includes('sk-ant-api03')), 'wrapper: no raw secret stored');

    // ── 8. Residual state stores sweep their own write boundaries ──
    // Mailbox: the body is omitted from the spine event but stored in the
    // lane-local file — that file must never hold a raw secret.
    await mailboxSend(repo, 'lane-x', { from: 'ses_x', type: 'note', subject: 'creds', body: `use ${FAKE.anthropic} for now` });
    const mbox = await readFile(join(repo, '.maddu', 'lanes', 'lane-x', 'mailbox.ndjson'), 'utf8');
    ok(!mbox.includes('sk-ant-api03') && mbox.includes('[REDACTED:anthropic-api-key]'), 'mailbox file: body swept at write');
    const mboxClean = await mailboxSend(repo, 'lane-x', { from: 'ses_x', type: 'note', subject: 's', body: 'plain body' });
    ok(mboxClean.body === 'plain body', 'mailbox: clean body byte-identical');

    // Briefings: the persisted "byte-exact original" is swept (no-op when clean).
    const brf = await curate(repo, { kind: 'orient', full: `full briefing with ${FAKE.aws} inside`, budget: 2000 });
    const brfRaw = await readFile(join(repo, '.maddu', 'state', 'briefings', `${brf.briefingId}.json`), 'utf8');
    ok(!brfRaw.includes('AKIAIOSFODNN7EXAMPLE') && brfRaw.includes('[REDACTED:aws-access-key]'), 'briefing original: swept at write');
    const brfClean = await curate(repo, { kind: 'orient', full: 'plain full briefing', budget: 2000 });
    const brfCleanRaw = await readFile(join(repo, '.maddu', 'state', 'briefings', `${brfClean.briefingId}.json`), 'utf8');
    ok(brfCleanRaw.includes('plain full briefing'), 'briefing original: clean text byte-identical');

    // Wrapper error log: msg is redacted before persisting.
    await logWrapperError(repo, 'wrk_test', `splitter threw on line: token ${FAKE.github}`);
    const wlog = await readFile(join(repo, '.maddu', 'state', 'worker-logs', 'wrk_test.wrapper-errors.log'), 'utf8');
    ok(!wlog.includes('ghp_A1b2') && wlog.includes('[REDACTED:github-token]'), 'wrapper-errors.log: msg swept at write');

    // Skill bodies: agent-authored free text in .maddu/skills/ the central
    // sweep never sees (SKILL_* events carry only id+title).
    const skl = await saveSkill(repo, { title: 'deploy recipe', body: `run with ${FAKE.envLine} exported`, by: 'ses_x' });
    const sklBack = await readSkill(repo, skl.id);
    ok(!sklBack.raw.includes('sk-abcdefghijklmnop') && sklBack.body.includes('[REDACTED:'), 'skill body: swept at write');
    const sklClean = await saveSkill(repo, { title: 'clean recipe', body: 'plain skill body', by: 'ses_x' });
    ok((await readSkill(repo, sklClean.id)).body.trim() === 'plain skill body', 'skill body: clean text byte-identical');

    // ── 9. v1.99.0 (P5) extended secret shapes — one canonical detector ──
    ok(matchSecretType(FAKE.githubPat) === 'github-fine-grained-token', 'shape: github fine-grained PAT');
    ok(matchSecretType(FAKE.ghu) === 'github-token', 'shape: github user-to-server (ghu_)');
    ok(matchSecretType(FAKE.google) === 'google-api-key', 'shape: google AIza key');
    ok(matchSecretType(FAKE.stripe) === 'stripe-secret-key', 'shape: stripe sk_live_');
    ok(matchSecretType(FAKE.pem) === 'private-key-block', 'shape: PEM private-key block');
    // PEM body scrubbed whole (complete block), surrounding text kept.
    const pemR = redactText('lead ' + FAKE.pem + ' trail');
    ok(!pemR.text.includes('MIIx') && pemR.text.includes('[REDACTED:private-key-block]'), 'PEM: whole block scrubbed');
    ok(pemR.text.startsWith('lead ') && pemR.text.endsWith(' trail'), 'PEM: surrounding text preserved');
    // Unterminated PEM (no END) scrubbed to end so the partial body can't survive.
    ok(!redactText('x -----BEGIN PRIVATE KEY-----\nTRUNC' + 'z'.repeat(50)).text.includes('TRUNC'),
      'PEM: unterminated key body scrubbed');

    // ── 9b. Field-name calibration: compound sensitive keys redact; framework
    //        token-ish keys DON'T (bare token/secret excluded on purpose). ──
    const fld = await append(repo, { type: EVENT_TYPES.TASK_UPDATED, data: {
      refreshToken: 'R'.repeat(24), clientSecret: 'S'.repeat(24), bearer: 'B'.repeat(24),
      sessionToken: 'T'.repeat(24), csrfToken: 'U'.repeat(24),
    } });
    ok(fld.data.refreshToken.startsWith('[REDACTED:'), 'field: refreshToken redacted');
    ok(fld.data.clientSecret.startsWith('[REDACTED:'), 'field: clientSecret redacted');
    ok(fld.data.bearer.startsWith('[REDACTED:'), 'field: bearer redacted');
    ok(fld.data.sessionToken === 'T'.repeat(24), 'field: sessionToken UNTOUCHED (bare token excluded)');
    ok(fld.data.csrfToken === 'U'.repeat(24), 'field: csrfToken UNTOUCHED');

    // ── 9c. redactLeaves (value-pattern) is NON-BREAKING on live config: a
    //        config field NAME keeps its short value; only a literal secret VALUE
    //        is scrubbed. This is why MCP/runtime descriptors are safe to wrap. ──
    const cfg = redactLeaves({ clientSecretEnvVar: 'MY_ENV_NAME_1234', refreshTokenUrl: 'https://example/oauth/refresh', apiKeyValue: FAKE.google });
    ok(cfg.clientSecretEnvVar === 'MY_ENV_NAME_1234', 'redactLeaves: config env-var NAME value preserved');
    ok(cfg.refreshTokenUrl === 'https://example/oauth/refresh', 'redactLeaves: config URL preserved');
    ok(cfg.apiKeyValue.startsWith('[REDACTED:'), 'redactLeaves: literal secret in a config value scrubbed');

    // ── 10. Newly-wrapped state stores redact at their OWN write boundary ──
    // active-session pointer (session.active.json)
    await writeActiveSession(repo, { sessionId: 'ses_x', focus: `rotate ${FAKE.stripe} today` });
    const act = await readActiveSession(repo);
    ok(!JSON.stringify(act).includes(FAKE.stripe) && act.focus.includes('[REDACTED:stripe-secret-key]'),
      'session-active: focus swept at write');
    ok(act.sessionId === 'ses_x', 'session-active: non-secret sessionId untouched');
    // memory facts (memory.ndjson)
    await appendFactIfNew(repo, { v: 1, id: 'mem_p5_test', ts: '2026-07-10T00:00:00.000Z', kind: 'discovery', text: `saw key ${FAKE.google}`, tags: ['t'], source: {} });
    const memRaw = await readFile(join(pathsFor(repo).state, 'memory.ndjson'), 'utf8');
    ok(!memRaw.includes(FAKE.google) && memRaw.includes('[REDACTED:google-api-key]'), 'memory fact: swept at write');

    // ── 11. Importer uses the ONE canonical detector (no second scanner) ──
    const impStripe = await safeImport(repo, { kind: 'memory-note', payload: { text: `deploy key ${FAKE.stripe}` }, by: 'ses_x' });
    ok(impStripe.ok === false && impStripe.rejected === true, 'import: Stripe-bearing payload rejected');
    ok(impStripe.hits.some((h) => h.pattern === 'stripe-secret-key'), 'import: canonical pattern name recorded (never the value)');
    const impClean = await safeImport(repo, { kind: 'memory-note', payload: { text: 'a plain lesson' }, by: 'ses_x' });
    ok(impClean.ok === true, 'import: clean payload accepted');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`payload-redaction: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
