#!/usr/bin/env node
// v1.12.0 — maddu blueprint: prompt/action extraction, variable inference,
// intake schema, and deterministic render.
//
// Builds a fixture transcripts root (one operator session + one sub-agent
// session) and asserts: operator prompts extracted + sub-agent session filtered;
// actions categorized; variables inferred (brand/vertical/source) into a starter
// intake schema; the render carries the handoff sections and is deterministic.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadLib(file) {
  const installed = path.join(process.cwd(), 'maddu', 'runtime', 'lib', file);
  const sourceLib = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib', file);
  for (const p of [installed, sourceLib]) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

function fail(msg) { console.error(`BLUEPRINT FAILED: ${msg}`); process.exit(1); }

// One transcript line helpers.
const userText = (text, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } });
const toolUse = (id, name, input, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

async function main() {
  const bp = await loadLib('blueprint.mjs');
  if (!bp) { console.error('harness error: blueprint.mjs not found'); process.exit(2); }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-bp-'));
  try {
    const projDir = path.join(root, 'C--Users-X-Projects-demo');
    await fs.mkdir(projDir, { recursive: true });

    // Operator session: genesis prompt + meaningful actions + a 2nd prompt.
    const op = [
      userText('I want to build a website generator for any business, starting with restaurants. Crawl the source site and audit it.', '2026-06-01T10:00:00Z'),
      toolUse('t1', 'WebFetch', { url: 'https://restauranglulu.se/meny' }, '2026-06-01T10:00:01Z'),
      toolResult('t1', '2026-06-01T10:00:02Z'),
      toolUse('t2', 'Write', { file_path: 'C:/Users/X/Projects/demo/profiles/dental.profile.json' }, '2026-06-01T10:00:03Z'),
      toolResult('t2', '2026-06-01T10:00:04Z'),
      toolUse('t3', 'Write', { file_path: 'C:/Users/X/Projects/demo/examples/dossier.lulu.example.json' }, '2026-06-01T10:00:05Z'),
      toolResult('t3', '2026-06-01T10:00:06Z'),
      toolUse('t4', 'Bash', { command: 'npm run build' }, '2026-06-01T10:00:07Z'),
      toolResult('t4', '2026-06-01T10:00:08Z'),
      userText('add more verticals and wire the build', '2026-06-01T10:05:00Z'),
    ].join('\n') + '\n';
    await fs.writeFile(path.join(projDir, 'sess-op.jsonl'), op);

    // Sub-agent session — must be filtered out (first prompt is a system role).
    const sub = [
      userText('You are a sub-agent. Extract structured facts from the page text. Use ONLY the provided text.', '2026-06-01T11:00:00Z'),
      toolUse('s1', 'Bash', { command: 'echo hi' }, '2026-06-01T11:00:01Z'),
      toolResult('s1', '2026-06-01T11:00:02Z'),
    ].join('\n') + '\n';
    await fs.writeFile(path.join(projDir, 'sess-sub.jsonl'), sub);

    // Prompts: operator only; sub-agent session filtered.
    const { prompts, operatorSessions, agentSessions } = await bp.gatherPrompts({ root, slug: 'demo' });
    if (agentSessions !== 1) fail(`expected 1 sub-agent session filtered, got ${agentSessions}`);
    if (prompts.length !== 2) fail(`expected 2 operator prompts, got ${prompts.length}`);
    if (!/website generator/.test(prompts[0].text)) fail('genesis prompt not first');

    // Actions: restricted to operator sessions, categorized.
    const actions = await bp.gatherActions({ root, slug: 'demo', onlySessions: operatorSessions });
    if (!actions.sources.some((s) => /restauranglulu/.test(s.k))) fail('source not captured');
    if (actions.artifactCount !== 2) fail(`expected 2 artifacts, got ${actions.artifactCount}`);
    if (!actions.operations.some((o) => /npm run/.test(o.op))) fail('npm operation not captured');

    // Variables → starter intake schema.
    const variables = bp.inferVariables({ products: [], actions, genesis: prompts[0].text });
    const byKey = Object.fromEntries(variables.map((v) => [v.key, v]));
    if (!byKey.brand || !byKey.brand.values.includes('lulu')) fail(`brand variable not inferred: ${JSON.stringify(variables)}`);
    if (!byKey.vertical || !byKey.vertical.values.includes('dental')) fail('vertical variable not inferred');
    if (!byKey.source_urls) fail('source_urls variable not inferred');
    const schema = JSON.parse(bp.renderIntakeSchema(variables));
    if (schema.intake.vertical.type !== 'string' || !Array.isArray(schema.intake.vertical.enum)) fail('intake schema vertical malformed');

    // Render carries the handoff sections + is deterministic.
    const opts = { slug: 'demo', prompts, actions, problems: [], variables, products: [], relatedRepos: [], full: false, generatedAt: '2026-06-09' };
    const md = bp.renderBlueprint(opts);
    for (const sec of ['## Intake schema', '## The procedure', '## Acceptance criteria', '## Generalization prompt']) {
      if (!md.includes(sec)) fail(`render missing section: ${sec}`);
    }
    if (!/"intake"/.test(md)) fail('render missing intake JSON');
    if (md !== bp.renderBlueprint(opts)) fail('render is not deterministic');

    console.log('BLUEPRINT OK (operator/sub-agent split, categorized actions, intake schema, deterministic render)');
    process.exit(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
