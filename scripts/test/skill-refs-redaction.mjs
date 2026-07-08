#!/usr/bin/env node
// Redaction coverage for the skill-hardening event payloads.
//
// Both new witnessed payloads ride the central write-boundary sweep in
// spine.append (redactDataPayload). This test proves that a secret planted in
// the NESTED shapes we introduced never reaches the stored spine bytes:
//   - SKILL_INJECTION_REFUSED.data.refused[].{id,provenance}
//   - GATE_RAN.data.evidence.failed[].refs[]   (skill-no-external-refs gate)
//
// The query-string strip in skill-refs.findExternalRefs is defense-in-depth on
// top of this; here we verify the LAST line of defense (the central sweep)
// actually covers our shapes.
//
// Exit 0 = pass, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SPINE = join(ROOT, 'template', 'maddu', 'runtime', 'lib', 'spine.mjs');

// Canonical AWS example key — matches the AWS access-key pattern in secret-scan.
const SECRET = 'AKIAIOSFODNN7EXAMPLE';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function makeRepo() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-skillredact-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}

async function rawSpine(repo) {
  const dir = join(repo, '.maddu', 'events');
  const segs = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort();
  let text = '';
  for (const s of segs) text += await readFile(join(dir, s), 'utf8');
  return text;
}

async function main() {
  const spine = await import(pathToFileURL(SPINE).href);

  // 1. SKILL_INJECTION_REFUSED with a (boundary-delimited, detectable) secret in
//    a nested refused[] entry — proves the central sweep traverses into
//    refused[].id. NB: the secret-scan regex is \b-anchored, so a secret GLUED
//    to a non-boundary prefix (e.g. `skl_AKIA…`) evades it — a pre-existing,
//    codebase-wide scanner limitation, not specific to this payload. The
//    realistic fields here (skill id, provenance enum) can't carry glued
//    free-text secrets, so a detectable placement is the honest coverage proof.
  {
    const repo = await makeRepo();
    await spine.append(repo, {
      type: spine.EVENT_TYPES.SKILL_INJECTION_REFUSED,
      actor: null,
      data: {
        sessionId: null,
        reason: 'untrusted-provenance',
        refused: [{ id: SECRET, provenance: 'imported', reason: 'untrusted-provenance' }],
      },
    });
    const raw = await rawSpine(repo);
    ok('refusal: event was written', raw.includes('SKILL_INJECTION_REFUSED'));
    ok('refusal: raw secret NOT on spine', !raw.includes(SECRET), 'nested refused[].id leaked');
    ok('refusal: redaction marker present', /REDACTED/.test(raw));
    await rm(repo, { recursive: true, force: true });
  }

  // 2. GATE_RAN evidence with a secret in a nested failed[].refs[] entry.
  {
    const repo = await makeRepo();
    await spine.append(repo, {
      type: spine.EVENT_TYPES.GATE_RAN,
      actor: null,
      data: {
        gateId: 'skill-no-external-refs', ok: false, status: 'fail', severity: 'safety', durationMs: 1,
        evidence: { failed: [{ skill: 'evil.md', provenance: 'imported', refs: [`https://x/${SECRET}/sdk`] }] },
      },
    });
    const raw = await rawSpine(repo);
    ok('gate evidence: event was written', raw.includes('skill-no-external-refs'));
    ok('gate evidence: raw secret NOT on spine', !raw.includes(SECRET), 'nested evidence.failed[].refs[] leaked');
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`\nskill-refs-redaction: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
