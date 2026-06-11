#!/usr/bin/env node
// A4 (v1.13.0) — blueprint output is secret-scanned before it is written.
//
// `maddu blueprint` mines Claude Code transcripts and scans real product repos,
// then writes a PORTABLE markdown handoff meant to be carried into other repos.
// That artifact can leak secrets (an API key pasted into a prompt, a `.env`
// line read off disk) across the boundary hard rule #6 protects. renderBlueprint
// must route its output through the canonical secret-scan engine so a planted
// credential is redacted, never carried verbatim.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');

function fail(msg) { console.error(`BLUEPRINT-SECRET-REDACTION FAILED: ${msg}`); process.exit(1); }

// Fake but pattern-valid credentials (none are real).
const FAKE = {
  aws: 'AKIAIOSFODNN7EXAMPLE',
  anthropic: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF',
  openaiProj: 'sk-proj-abcdef0123456789ABCDEF',
  github: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  envLine: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789',
  highEntropy: 'secret_key = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ"',
};

async function main() {
  const scan = await import(pathToFileURL(path.join(LIB, 'secret-scan.mjs')).href);
  const bp = await import(pathToFileURL(path.join(LIB, 'blueprint.mjs')).href);

  // ── 1. redactText unit coverage across pattern types. ──
  for (const [label, raw] of Object.entries(FAKE)) {
    const { text } = scan.redactText(`prefix ${raw} suffix`);
    if (label === 'aws' && text.includes(FAKE.aws)) fail(`redactText left raw ${label}`);
    if (label === 'anthropic' && text.includes(FAKE.anthropic)) fail(`redactText left raw ${label}`);
    if (label === 'github' && text.includes(FAKE.github)) fail(`redactText left raw ${label}`);
    if (!/\[REDACTED:/.test(text)) fail(`redactText produced no redaction marker for ${label} (${text})`);
  }
  // The high-entropy value must be scrubbed but the key name kept.
  const he = scan.redactText(FAKE.highEntropy).text;
  if (he.includes('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ')) fail('high-entropy value not redacted');
  if (!/secret_key/.test(he)) fail('high-entropy redaction dropped the key name');

  // ── 2. End-to-end: a transcript prompt carrying keys → blueprint redacts. ──
  const planted = [FAKE.aws, FAKE.anthropic, FAKE.openaiProj, FAKE.github, FAKE.envLine].join(' ; ');
  const md = bp.renderBlueprint({
    slug: 'redaction-fixture',
    prompts: [{ text: `Build the thing. Credentials: ${planted}`, ts: '2026-06-09T00:00:00.000Z' }],
    actions: { categorized: {}, operatorTurns: 1 },
    problems: [],
    variables: [],
    products: [{ root: '/tmp/fake', readme: `deploy with ${FAKE.envLine}`, pkg: { name: 'fixture', scripts: [] } }],
    relatedRepos: [],
    generatedAt: '2026-06-09T00:00:00.000Z',
  });

  for (const [label, raw] of Object.entries(FAKE)) {
    // The high-entropy/env raw value contains the literal secret value.
    const needle = label === 'highEntropy' ? 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ'
      : label === 'envLine' ? 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
      : raw;
    if (md.includes(needle)) fail(`blueprint output still contains raw ${label}: ${needle}`);
  }
  if (!/\[REDACTED:/.test(md)) fail('blueprint output has no redaction markers despite planted secrets');

  // ── 3. Redaction is deterministic (re-render is byte-identical). ──
  const md2 = bp.renderBlueprint({
    slug: 'redaction-fixture',
    prompts: [{ text: `Build the thing. Credentials: ${planted}`, ts: '2026-06-09T00:00:00.000Z' }],
    actions: { categorized: {}, operatorTurns: 1 },
    problems: [],
    variables: [],
    products: [{ root: '/tmp/fake', readme: `deploy with ${FAKE.envLine}`, pkg: { name: 'fixture', scripts: [] } }],
    relatedRepos: [],
    generatedAt: '2026-06-09T00:00:00.000Z',
  });
  if (md !== md2) fail('redacted blueprint render is non-deterministic');

  console.log('BLUEPRINT-SECRET-REDACTION OK (redactText pattern coverage + planted keys scrubbed from blueprint + deterministic)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
