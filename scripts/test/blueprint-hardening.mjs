#!/usr/bin/env node
// v1.15.0 — maddu blueprint: extractor HARDENING.
//
// The happy path is covered by blueprint.mjs. This locks the GRACEFUL edge-case
// behaviors so a future refactor can't regress them:
//   - malformed / non-JSON / truncated / null-content transcript lines are
//     SKIPPED, never thrown on (a corrupt transcript must not abort an export);
//   - a slug that matches nothing returns empty structures (no throw, no crash);
//   - Windows backslash paths normalize: repoRoots inferred + deduped across
//     slash styles, and Claude Code's own ~/.claude/projects/ dirs excluded;
//   - inferVariables on empty inputs returns [] (no throw);
//   - the OUTPUT CONTRACT holds on all-empty input: renderBlueprint still emits
//     the title, the Intake schema, and the Generalization prompt, and stays
//     byte-deterministic.

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

function fail(msg) { console.error(`BLUEPRINT-HARDENING FAILED: ${msg}`); process.exit(1); }

const userText = (text, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } });
const toolUse = (id, name, input, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

async function main() {
  const bp = await loadLib('blueprint.mjs');
  if (!bp) { console.error('harness error: blueprint.mjs not found'); process.exit(2); }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-bph-'));
  try {
    const projDir = path.join(root, 'C--Users-X-Projects-demo');
    await fs.mkdir(projDir, { recursive: true });

    // ── 1. A transcript salted with garbage between the real turns. ──────────
    // Non-JSON, a truncated object, a `user` turn with null content, an empty
    // line, a CRLF line, and a system-reminder noise turn. The two genuine
    // operator prompts must survive; nothing may throw.
    const messy = [
      'this is not json at all',
      userText('Build a generator for any business; crawl the source and audit it.', '2026-06-01T10:00:00Z'),
      '{"type":"user","message":{"content":', // truncated JSON
      JSON.stringify({ type: 'user', timestamp: '2026-06-01T10:00:01Z', message: { content: null } }),
      '', // blank
      toolUse('w1', 'Write', { file_path: 'C:\\Users\\X\\Projects\\demo\\profiles\\dental.profile.json' }, '2026-06-01T10:00:02Z'),
      toolResult('w1', '2026-06-01T10:00:03Z'),
      // A Write into Claude Code's own transcript dir — must NOT become a repoRoot.
      toolUse('w2', 'Write', { file_path: 'C:\\Users\\X\\.claude\\projects\\demo\\note.md' }, '2026-06-01T10:00:04Z'),
      toolResult('w2', '2026-06-01T10:00:05Z'),
      userText('<system-reminder>ignore me</system-reminder>', '2026-06-01T10:00:06Z'),
      userText('add more verticals and wire the build', '2026-06-01T10:05:00Z'),
    ].join('\r\n') + '\r\n'; // CRLF throughout
    await fs.writeFile(path.join(projDir, 'sess-messy.jsonl'), messy);

    const { prompts, operatorSessions, sessionsScanned } = await bp.gatherPrompts({ root, slug: 'demo' });
    if (sessionsScanned !== 1) fail(`expected 1 session scanned, got ${sessionsScanned}`);
    if (prompts.length !== 2) fail(`malformed lines not skipped cleanly: expected 2 prompts, got ${prompts.length} (${JSON.stringify(prompts.map((p) => p.text))})`);
    if (!/generator for any business/.test(prompts[0].text)) fail('genesis prompt lost among garbage');
    if (prompts.some((p) => /system-reminder/.test(p.text))) fail('system-reminder noise not filtered');

    // ── 2. Windows backslash paths normalize + repoRoot dedup/exclusion. ─────
    const actions = await bp.gatherActions({ root, slug: 'demo', onlySessions: operatorSessions });
    if (actions.repoRoots.some((r) => /\.claude/i.test(r))) fail('.claude transcript dir leaked into repoRoots');
    if (!actions.repoRoots.some((r) => /Projects\/demo$/.test(String(r).replace(/\\/g, '/')))) fail(`product repoRoot not inferred from backslash path: ${JSON.stringify(actions.repoRoots)}`);
    // The dental profile must survive backslash normalization into an artifact.
    if (actions.artifactCount < 1) fail('backslash Write path not captured as artifact');
    if (!JSON.stringify(actions.artifacts).includes('dental.profile.json')) fail('backslash artifact filename not normalized');

    // ── 3. No-match slug → empty, no throw. ──────────────────────────────────
    const none = await bp.gatherPrompts({ root, slug: 'nonexistent-zzz' });
    if (none.sessionsScanned !== 0) fail(`no-match slug should scan 0 sessions, got ${none.sessionsScanned}`);
    if (none.prompts.length !== 0) fail('no-match slug should yield 0 prompts');
    const noneActions = await bp.gatherActions({ root, slug: 'nonexistent-zzz' });
    if (noneActions.total !== 0 || noneActions.repoRoots.length !== 0) fail('no-match slug should yield empty actions');

    // ── 4. inferVariables on empty → [] (no throw). ──────────────────────────
    const emptyVars = bp.inferVariables({});
    if (!Array.isArray(emptyVars) || emptyVars.length !== 0) fail(`inferVariables({}) should be [], got ${JSON.stringify(emptyVars)}`);

    // ── 5. OUTPUT CONTRACT on all-empty input. ───────────────────────────────
    // Even with nothing mined, the export must be a usable skeleton: a title,
    // the Intake schema (so the agent knows to collect variables), and the
    // Generalization prompt (the paste-ready payload). And it must be stable.
    const emptyOpts = { slug: '', prompts: [], actions: {}, problems: [], variables: [], products: [], relatedRepos: [], full: false, generatedAt: '2026-06-11' };
    const md = bp.renderBlueprint(emptyOpts);
    for (const sec of ['# Project blueprint', '## Intake schema', '## Generalization prompt']) {
      if (!md.includes(sec)) fail(`output contract broken on empty input: missing "${sec}"`);
    }
    if (md !== bp.renderBlueprint(emptyOpts)) fail('render not deterministic on empty input');

    console.log('BLUEPRINT-HARDENING OK (malformed lines skipped, win paths normalized, no-match graceful, empty output contract holds)');
    process.exit(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((e) => fail(e?.stack || String(e)));
