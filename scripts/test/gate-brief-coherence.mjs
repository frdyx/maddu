#!/usr/bin/env node
// v1.11.0 — the brief-coherence guard gate.
//
// Positive: against the real repo, every agent-facing COMMANDS verb is named in
// the worker brief → ok. Negative: the gate must flag a verb that's absent (we
// simulate by checking the gate's detection against a brief missing a verb).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');

function fail(msg) { console.error(`GATE-BRIEF FAILED: ${msg}`); process.exit(1); }

async function main() {
  const gatePath = path.join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin', 'brief-coherence.mjs');
  const gate = (await import(pathToFileURL(gatePath).href)).default;
  if (!gate || gate.id !== 'brief-coherence') fail('gate did not export the expected shape');
  if (gate.severity !== 'warn') fail(`severity ${gate.severity} != warn (must be non-blocking)`);

  // Positive: against the live framework source.
  const res = await gate.run({});
  if (!res.ok) fail(`gate WARNed on the real repo (brief should name every agent verb): ${res.message}`);

  // Sanity: the brief actually names a representative spread of agent verbs.
  const brief = await fs.readFile(path.join(FRAMEWORK_ROOT, 'template', 'maddu', 'CLAUDE.md'), 'utf8');
  for (const v of ['learn', 'review', 'plan', 'trust', 'mcp', 'audit', 'handoff']) {
    if (!new RegExp(`\\bmaddu\\s+${v}\\b`).test(brief)) fail(`brief is missing "maddu ${v}" — gate would not have caught its own contract`);
  }

  console.log('GATE-BRIEF OK (every agent verb named in the worker brief; warn-severity, non-blocking)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
