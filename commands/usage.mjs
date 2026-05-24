// `maddu usage import --from claude-code` — v0.19.1 PR-C2.
//
// Retroactively populate the token ledger from Claude Code's own session
// transcripts. The bridge can only see workers it spawns; direct shell
// sessions (the operator's `claude` CLI) emit no events. Without an
// import path, `maddu cost` looks broken when the operator has clearly
// used Claude Code.
//
// This command walks `~/.claude/projects/<slug>/<session-uuid>.jsonl`
// (newest first), parses each line as JSON, finds assistant turns that
// carry `message.usage`, and emits one TOKEN_USAGE_REPORTED event per
// turn with `source: "claude-code-transcript"`.
//
// Idempotency:
//   We hash (sessionUuid + lineNumber + usage payload) and skip a line
//   if we've already imported it. The hash key lives in the event
//   payload (`importHash`) so a re-scan of `.maddu/events/` reveals
//   which lines are already present and we never emit twice.
//
// Hard-rule compliance:
//   - Rule #1 (files-only): reads JSONL transcripts (plain files), writes
//     spine events. No DB.
//   - Rule #4 (no broad new deps): uses fs/promises, path, os, readline,
//     crypto — all Node stdlib.
//   - Rule #5 (no provider SDKs): JSONL parsing is plain JSON.parse on
//     line strings. No `@anthropic-ai/sdk` import.
//
// Flags:
//   --from claude-code         (required) the source identifier.
//   --session <id>             only import lines whose Claude Code session
//                              UUID matches <id> (substring match accepted).
//   --since <iso-date>         skip lines older than <iso-date>.
//   --dry-run                  parse and report counts; don't write events.

import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { exists } from './_libroot.mjs';

function transcriptsRoot() {
  // Claude Code stores transcripts under ~/.claude/projects/<slug>/.
  // The slug encodes the repo path; we walk all of them and let the
  // operator filter via --session.
  return join(homedir(), '.claude', 'projects');
}

async function listSessionFiles(root) {
  const out = [];
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = join(root, d.name);
    let files;
    try { files = await readdir(sub, { withFileTypes: true }); }
    catch { continue; }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        out.push({ path: join(sub, f.name), slug: d.name, sessionUuid: f.name.replace(/\.jsonl$/, '') });
      }
    }
  }
  // Newest-first by mtime — best-effort.
  const withStats = await Promise.all(out.map(async (e) => ({ ...e, mtime: (await stat(e.path)).mtimeMs })));
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats;
}

function hashLine(sessionUuid, lineNumber, usage) {
  const h = createHash('sha256');
  h.update(String(sessionUuid));
  h.update('\x00');
  h.update(String(lineNumber));
  h.update('\x00');
  h.update(JSON.stringify(usage));
  return h.digest('hex').slice(0, 16);
}

// Extract a TOKEN_USAGE_REPORTED row from one parsed JSONL line, or
// null if the line isn't an assistant turn with a usage block.
function extractUsage(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  // Claude Code's transcript shape: assistant turns have type === 'assistant'
  // and carry `message.usage` mirroring the Anthropic API response shape.
  if (parsed.type !== 'assistant') return null;
  const msg = parsed.message;
  if (!msg || typeof msg !== 'object') return null;
  const u = msg.usage;
  if (!u || typeof u !== 'object') return null;
  // At least one token count must be present for the row to be useful.
  if (u.input_tokens == null && u.output_tokens == null && u.cache_read_input_tokens == null && u.cache_creation_input_tokens == null) {
    return null;
  }
  return {
    model: msg.model || parsed.model || null,
    inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
    outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
    cacheRead: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : null,
    cacheCreation: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : null,
    ts: parsed.timestamp || parsed.ts || null,
  };
}

async function loadExistingHashes(spine, repoRoot) {
  // Walk the spine for TOKEN_USAGE_REPORTED events with source === 'claude-code-transcript'.
  const out = new Set();
  let all;
  try { all = await spine.readAll(repoRoot); } catch { return out; }
  for (const ev of all) {
    if (ev.type !== 'TOKEN_USAGE_REPORTED') continue;
    const d = ev.data || {};
    if (d.source === 'claude-code-transcript' && d.importHash) out.add(d.importHash);
  }
  return out;
}

async function importFromClaudeCode(repoRoot, spine, flags) {
  const root = transcriptsRoot();
  if (!(await exists(root))) {
    return { ok: false, message: `transcripts root not found: ${root}` };
  }
  const files = await listSessionFiles(root);
  if (files.length === 0) {
    return { ok: true, message: 'no transcript files found', imported: 0, skipped: 0, scanned: 0 };
  }
  const sessionFilter = flags.session && flags.session !== true ? String(flags.session) : null;
  const sinceMs = flags.since && flags.since !== true ? new Date(flags.since).getTime() : null;
  const dryRun = !!flags['dry-run'];
  const existing = await loadExistingHashes(spine, repoRoot);

  let scanned = 0, imported = 0, skipped = 0, files_examined = 0;
  const perFile = [];

  for (const entry of files) {
    if (sessionFilter && !entry.sessionUuid.includes(sessionFilter)) continue;
    files_examined++;
    const rl = createInterface({ input: createReadStream(entry.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    let lineNumber = 0;
    let fileImported = 0, fileSkipped = 0;
    for await (const raw of rl) {
      lineNumber++;
      scanned++;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      const usage = extractUsage(parsed);
      if (!usage) continue;
      if (sinceMs && usage.ts && new Date(usage.ts).getTime() < sinceMs) continue;
      const importHash = hashLine(entry.sessionUuid, lineNumber, parsed.message?.usage || {});
      if (existing.has(importHash)) { skipped++; fileSkipped++; continue; }
      if (!dryRun) {
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.TOKEN_USAGE_REPORTED,
          actor: entry.sessionUuid,
          lane: null,
          data: {
            runtime: 'claude-code',
            sessionId: entry.sessionUuid,
            model: usage.model || 'claude-unknown',
            ts: usage.ts || new Date().toISOString(),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheRead: usage.cacheRead,
            cacheCreation: usage.cacheCreation,
            source: 'claude-code-transcript',
            importHash,
          },
        });
        existing.add(importHash);
      }
      imported++; fileImported++;
    }
    if (fileImported || fileSkipped) {
      perFile.push({ sessionUuid: entry.sessionUuid, imported: fileImported, skipped: fileSkipped });
    }
  }

  return {
    ok: true,
    dryRun,
    scanned,
    imported,
    skipped,
    files_examined,
    perFile,
  };
}

export default async function usage(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub) {
    console.error('Usage: maddu usage <import> [flags]');
    process.exit(2);
  }

  if (sub === 'import') {
    const { flags } = parseFlags(rest);
    const from = requireFlag(flags, 'from');
    if (from !== 'claude-code') {
      console.error(`maddu usage import: --from "${from}" not supported. Only "claude-code" is available in v0.19.1.`);
      process.exit(2);
    }
    const { paths, spine } = await loadSpineLib();
    const repoRoot = await resolveRepoRoot(paths);
    const result = await importFromClaudeCode(repoRoot, spine, flags);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    const tag = result.dryRun ? '[dry-run] ' : '';
    console.log(`${tag}Claude Code transcript import:`);
    console.log(`  files examined: ${result.files_examined}`);
    console.log(`  lines scanned:  ${result.scanned}`);
    console.log(`  imported:       ${result.imported}`);
    console.log(`  skipped (already imported): ${result.skipped}`);
    if (result.dryRun) {
      console.log('');
      console.log('  (no events written — re-run without --dry-run to commit)');
    }
    return;
  }

  console.error(`maddu usage: unknown subcommand "${sub}"`);
  process.exit(2);
}
