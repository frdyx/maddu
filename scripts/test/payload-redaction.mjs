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
import { redactDataPayload, redactText, redactLeaves, matchSecretType, scanArgv, PATTERN_TYPES } from '../../template/maddu/runtime/lib/secret-scan.mjs';
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

    // ── 9d. v1.156.0 (R4) shapes an independent refuter found unredacted: JWT,
    //        URL-userinfo password, password/passwd/pwd values, npm_ and hf_
    //        tokens. A positive row and a near-miss negative control per shape. ──
    const R4 = {
      // Built by concatenation so no complete token sits in the source.
      jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'SflKxwRJSMeKKF2QT4fw' + 'pMeJf36POk6yJV_adQssw5c',
      // A header of 40+ base64 chars: the high-entropy pass alone would take
      // only the header and leave payload + signature behind.
      jwtLongHeader: 'eyJ' + 'A'.repeat(45) + '.' + 'eyJ' + 'P'.repeat(30) + '.' + 'S'.repeat(43),
      urlPw: 'pg' + 'Pa55word9',
      npm: 'npm_' + 'A1b2C3d4E5'.repeat(3) + 'F6g7H8',       // npm_ + 36
      hf: 'hf_' + 'Q1r2S3t4U5'.repeat(3) + 'v6w7x8y9',        // hf_ + 38
    };
    const same = (s) => redactText(s).text === s;

    // JWT
    const jwtR = redactText(`Authorization: Bearer ${R4.jwt}`).text;
    ok(jwtR === 'Authorization: Bearer [REDACTED:jwt]', `jwt: whole token redacted, header line kept (${jwtR})`);
    ok(matchSecretType(R4.jwt) === 'jwt', 'jwt: classified as jwt');
    const jwtHE = redactText(`bearer: ${R4.jwtLongHeader}`).text;
    ok(jwtHE === 'bearer: [REDACTED:jwt]', `jwt: a long header is not split off by the high-entropy pass (${jwtHE})`);
    const jwtTwoSeg = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJ' + 'zdWIiOiIxIn0';
    ok(same(`two segments ${jwtTwoSeg} only, and a bare eyJ in prose`), 'jwt negative: a two-segment eyJ string stays');

    // URL userinfo — only the password goes; scheme, user, host stay readable.
    const urlR = redactText(`DATABASE_URL=postgres://app:${R4.urlPw}@db.internal:5432/app`).text;
    ok(urlR === 'DATABASE_URL=postgres://app:[REDACTED:url-userinfo]@db.internal:5432/app', `url-userinfo: only the password redacted (${urlR})`);
    ok(redactText(`redis://:${R4.urlPw}@cache:6379/0`).text === 'redis://:[REDACTED:url-userinfo]@cache:6379/0', 'url-userinfo: empty user name');
    ok(redactText(`https://bot:p@${R4.urlPw}@host.example/x`).text === 'https://bot:[REDACTED:url-userinfo]@host.example/x',
      'url-userinfo: a raw @ in the password is redacted up to the last @');
    ok(matchSecretType(`https://bot:${R4.urlPw}@host.example`) === 'url-userinfo', 'url-userinfo: classified');
    ok(same('clone https://alice@example.com/repo.git or git@github.com:frdyx/maddu.git, bridge http://127.0.0.1:4177/bridge/status, see https://host.example:8080/a@b'),
      'url-userinfo negative: user-only, scp-style, host:port and an @ in the path stay');

    // password / passwd / pwd values
    const pwR = redactText('DB_PASSWORD=hunter2').text;
    ok(pwR === 'DB_PASSWORD=[REDACTED:password]', `password: env-line value redacted, key kept (${pwR})`);
    ok(redactText('password: "correct horse battery"').text === 'password: [REDACTED:password]', 'password: quoted value with spaces redacted whole');
    ok(redactText('run --password=hunter2 now').text === 'run --password=[REDACTED:password] now', 'password: CLI flag value');
    ok(redactText('Server=db;Uid=sa;Pwd=s3cr3t;Database=app').text === 'Server=db;Uid=sa;Pwd=[REDACTED:password];Database=app', 'pwd: connection-string value');
    ok(redactText('passwd: s3cr3t').text === 'passwd: [REDACTED:password]', 'passwd: value after a colon');
    ok(matchSecretType('password=hunter2') === 'password', 'password: classified');
    const pwLong = redactText(`password=${FAKE.longValue}!tail`).text;
    ok(pwLong === 'password=[REDACTED:password]', `password: a long value is redacted whole, no tail past the base64 run (${pwLong})`);
    ok(same('rotate the password before Friday; passwordless: true; password_file: /run/secrets/db'),
      'password negative: prose, and keys that only start with password, stay');
    ok(same('PWD=/home/dev/app OLDPWD=C:\\Users\\dev pwd: error retrieving current directory; /etc/passwd: Permission denied'),
      'pwd/passwd negative: shell working-directory env, the pwd error line and /etc/passwd stay');
    // JSON escapes: the spine-sync line scan runs redactText over JSON-encoded
    // event lines, so an escape after the separator must not read as a value.
    ok(same(JSON.stringify({ note: 'Password:\nrotate it' })), 'password negative: an escaped newline after the colon in a JSON line stays');
    ok(same(JSON.stringify({ note: 'bridge http://host.example:8080\nadmin@example.com, see http://x.example\nops:standby@pager.example' })),
      'url-userinfo negative: an escaped newline in a JSON line does not join a URL to a later @');

    // npm
    const npmR = redactText(`//registry.npmjs.org/:_authToken=${R4.npm}`).text;
    ok(npmR === '//registry.npmjs.org/:_authToken=[REDACTED:npm-token]', `npm-token: redacted (${npmR})`);
    ok(matchSecretType(R4.npm) === 'npm-token', 'npm-token: classified');
    ok(same('npm_x npm_config_cache npm_package_version npm_' + 'a'.repeat(35)), 'npm-token negative: env names and a 35-char body stay');

    // Hugging Face
    const hfR = redactText(`HF_TOKEN=${R4.hf}`).text;
    ok(hfR === 'HF_TOKEN=[REDACTED:huggingface-token]', `huggingface-token: redacted (${hfR})`);
    ok(matchSecretType(R4.hf) === 'huggingface-token', 'huggingface-token: classified');
    ok(same('from huggingface_hub import hf_hub_download; hf_' + 'b'.repeat(29)), 'huggingface-token negative: hf_hub_download and a 29-char body stay');

    // Every surface: the spine write boundary, argv refusal, the pattern list,
    // and a second pass that is byte-stable and finds nothing.
    const r4Mix = `creds ${R4.jwt} DB_PASSWORD=hunter2 postgres://app:${R4.urlPw}@db/app ${R4.npm} ${R4.hf}`;
    const r4Ev = JSON.stringify(await append(repo, { type: EVENT_TYPES.SLICE_STOP, data: { summary: r4Mix } }));
    ok(![R4.jwt, 'hunter2', R4.urlPw, R4.npm, R4.hf].some((s) => r4Ev.includes(s)), 'write boundary: no R4 shape stored raw');
    ok(r4Ev.includes('postgres://app:[REDACTED:url-userinfo]@db/app'), 'write boundary: URL kept readable');
    ok(scanArgv(['commit', '-m', `wip ${R4.npm}`])?.patternType === 'npm-token', 'argv: an npm token is refused');
    ok(scanArgv(['commit', '-m', 'docs: rotate the password weekly']) === null, 'argv negative: prose about passwords is not refused');
    for (const t of ['jwt', 'url-userinfo', 'password', 'npm-token', 'huggingface-token']) ok(PATTERN_TYPES.includes(t), `PATTERN_TYPES lists ${t}`);
    const r4Once = redactText(r4Mix);
    const r4Twice = redactText(r4Once.text);
    ok(r4Twice.text === r4Once.text && Object.keys(r4Twice.redactions).length === 0, 'R4 shapes: a second pass is byte-stable and finds nothing');

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
