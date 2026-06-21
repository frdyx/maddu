// Failure-learning engine (`maddu learn`) — v1.9.0.
//
// Mines Claude Code session transcripts for the "failure→success
// correlation": a tool call that FAILED, paired with the later call that
// RESOLVED it. Each pair is classified into one of five categories and
// emitted as a deterministic candidate correction. This module is pure core:
// it reads JSONL files and returns data. It NEVER calls a provider SDK — the
// judgment of whether a candidate becomes a durable correction happens in a
// spawned worker subprocess (commands/learn.mjs), honoring hard rule #5.
//
// Hard-rule compliance:
//   - Rule #1 (files-only): reads JSONL transcripts, returns plain objects.
//   - Rule #4 (no broad deps): fs/promises, path, os, readline, crypto — all
//     Node stdlib. Mirrors commands/usage.mjs, which already reads the same
//     transcripts for the token ledger.
//   - Rule #5 (no provider SDKs): JSON.parse on line strings only.
//
// Transcript shape (Claude Code ~/.claude/projects/<slug>/<uuid>.jsonl):
//   assistant turn → { type:'assistant', message:{ content:[
//       { type:'tool_use', id:'toolu_…', name:'Read', input:{…} }, … ] } }
//   tool result    → { type:'user', message:{ content:[
//       { type:'tool_result', tool_use_id:'toolu_…', is_error?:true,
//         content:'…' }, … ] } }
// We match tool_use.id ↔ tool_result.tool_use_id to learn each call's outcome.

import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ── Transcript discovery (mirrors usage.mjs) ────────────────────────────────

export function transcriptsRoot() {
  return join(homedir(), '.claude', 'projects');
}

export async function listSessionFiles(root) {
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
  const withStats = await Promise.all(out.map(async (e) => {
    let mtime = 0;
    try { mtime = (await stat(e.path)).mtimeMs; } catch {}
    return { ...e, mtime };
  }));
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats;
}

// ── Per-file parse: build an ordered list of resolved tool CALLS ───────────

const ERROR_HINTS = [
  /command not found/i,
  /is not recognized as (?:an|the name of)/i,  // Windows shell
  /\bENOENT\b/i,
  /no such file or directory/i,
  /file does not exist/i,
  /cannot find/i,
  /not found/i,
  /permission denied/i,
  /error/i,
];
const NO_MATCH_HINTS = [
  /no matches found/i,
  /no files found/i,
  /found 0 (?:matches|files|results)/i,
];
const TOO_LARGE_HINTS = [
  /file (?:is too large|content exceeds|exceeds maximum)/i,
  /too large to (?:read|display)/i,
  /has been truncated/i,
  /exceeds the maximum/i,
];

function resultText(item) {
  if (item == null) return '';
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((c) => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : ''))).join('\n');
  }
  return '';
}

// Parse one JSONL transcript into an ordered array of calls:
//   { tool, input, ok, soft, errorText, ts, line }
// `ok` is the hard outcome (is_error). `soft` flags a non-error result that
// still smells like a miss (empty search / too-large read) so search-scope and
// large-file pairs surface even when the tool didn't set is_error.
export async function parseTranscript(filePath) {
  const calls = [];
  const pending = new Map(); // tool_use_id -> { tool, input, ts, line }
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  for await (const raw of rl) {
    line++;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const ts = parsed.timestamp || parsed.ts || null;
    const content = parsed?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'tool_use' && typeof item.id === 'string') {
        pending.set(item.id, { tool: item.name || 'unknown', input: item.input || {}, ts, line });
      } else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        const use = pending.get(item.tool_use_id);
        if (!use) continue;
        pending.delete(item.tool_use_id);
        const text = resultText(item);
        const hardError = item.is_error === true || ERROR_HINTS.slice(0, 8).some((re) => re.test(text) && item.is_error !== false);
        const noMatch = NO_MATCH_HINTS.some((re) => re.test(text));
        const tooLarge = TOO_LARGE_HINTS.some((re) => re.test(text));
        calls.push({
          tool: use.tool,
          input: use.input,
          ok: !(item.is_error === true),
          soft: !item.is_error && (noMatch || tooLarge),
          softKind: tooLarge ? 'large-file' : (noMatch ? 'search-scope' : null),
          errorText: item.is_error === true ? text.slice(0, 240) : (noMatch || tooLarge ? text.slice(0, 240) : ''),
          ts: use.ts || ts,
          line: use.line,
        });
      }
    }
  }
  return calls;
}

// ── Failure→success pairing + classification ───────────────────────────────

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

function filePathOf(input) {
  return input?.file_path || input?.path || input?.notebook_path || null;
}

// Filename without its extension, so `FirstClassEntity.java` and
// `FirstClassEntity.scala` are recognized as the same logical file in a
// different module (the canonical file-path example).
function stemOf(p) {
  const b = basename(p);
  const ext = extname(b);
  return ext ? b.slice(0, -ext.length) : b;
}

// Is this call a failure worth learning from?
function isFailure(call) {
  if (call.ok === false) return true;
  if (call.soft) return true;
  return false;
}

// Decide whether `success` plausibly resolves `failure` (same tool, corrected
// args) and, if so, which of the five categories the correction is.
function classifyPair(failure, success) {
  if (failure.tool !== success.tool) return null;
  if (success.ok !== true || success.soft) return null;

  // file-path / large-file handling for the file tools.
  if (FILE_TOOLS.has(failure.tool)) {
    const a = filePathOf(failure.input), b = filePathOf(success.input);
    // large-file: SAME path re-read with pagination (offset/limit) added.
    if (a && b && a === b && (success.input?.offset != null || success.input?.limit != null)) {
      return 'large-file';
    }
    // file-path: same logical file (matching stem) found at a different path.
    if (a && b && a !== b && stemOf(a) === stemOf(b)) return 'file-path';
  }

  // env-command / command-pattern: a Bash command that failed, then a
  // different command that ran.
  if (failure.tool === 'Bash') {
    const a = String(failure.input?.command || ''), b = String(success.input?.command || '');
    if (a && b && a !== b) {
      // env-fact when the first failed with a "not found / not recognized" shape.
      if (/command not found|is not recognized|\bENOENT\b|no such file/i.test(failure.errorText)) return 'env-command';
      return 'command-pattern';
    }
    return null;
  }

  // search-scope: an empty Grep/Glob, then a broader search that returned hits.
  if (SEARCH_TOOLS.has(failure.tool)) {
    if (failure.softKind === 'search-scope' || failure.soft) return 'search-scope';
    return null;
  }

  // Other tools: nothing reliable to learn from a single pair (yet).
  return null;
}

// For each failure, greedily match the NEAREST later success of the same tool
// that classifies as a real correction.
export function pairFailures(calls) {
  const pairs = [];
  const used = new Set();
  for (let i = 0; i < calls.length; i++) {
    const failure = calls[i];
    if (!isFailure(failure)) continue;
    for (let j = i + 1; j < calls.length; j++) {
      if (used.has(j)) continue;
      const success = calls[j];
      if (success.tool !== failure.tool) continue;
      const category = classifyPair(failure, success);
      if (category) {
        used.add(j);
        pairs.push({ category, failure, success });
        break;
      }
    }
  }
  return pairs;
}

// ── Candidate digest ────────────────────────────────────────────────────────

function summarizeCall(call) {
  const fp = filePathOf(call.input);
  if (fp) return fp;
  if (call.tool === 'Bash') return String(call.input?.command || '').slice(0, 160);
  if (SEARCH_TOOLS.has(call.tool)) return `${call.input?.pattern || ''}${call.input?.path ? ' in ' + call.input.path : ''}`.slice(0, 160);
  return JSON.stringify(call.input).slice(0, 160);
}

// Deterministic candidate id: stable across re-mines so the same pair never
// duplicates (idempotency, mirroring usage.mjs importHash).
function candidateId(slug, category, failure, success) {
  const h = createHash('sha256');
  h.update([slug, category, failure.tool, summarizeCall(failure), summarizeCall(success)].join('\x00'));
  return 'lrn_' + h.digest('hex').slice(0, 16);
}

// Mine one parsed file into candidates.
export function candidatesFromCalls(slug, sessionUuid, calls) {
  const pairs = pairFailures(calls);
  return pairs.map((p) => ({
    id: candidateId(slug, p.category, p.failure, p.success),
    category: p.category,
    slug,
    sessionUuid,
    tool: p.failure.tool,
    failure: summarizeCall(p.failure),
    failureError: p.failure.errorText || null,
    success: summarizeCall(p.success),
    ts: p.success.ts || p.failure.ts || null,
  }));
}

// Mine every (filtered) transcript. Returns a deterministic digest:
//   { mined, paired, candidates:[…], counts:{category->n}, scannedFiles }
export async function mineTranscripts(opts = {}) {
  const root = opts.root || transcriptsRoot();
  const files = await listSessionFiles(root);
  const sinceMs = opts.since ? new Date(opts.since).getTime() : null;
  const slugFilter = opts.slug || null;
  const seen = new Set();
  const candidates = [];
  let scannedFiles = 0, mined = 0;
  for (const entry of files) {
    if (slugFilter && entry.slug !== slugFilter && !entry.slug.includes(slugFilter)) continue;
    scannedFiles++;
    let calls;
    try { calls = await parseTranscript(entry.path); } catch { continue; }
    mined += calls.length;
    for (const c of candidatesFromCalls(entry.slug, entry.sessionUuid, calls)) {
      if (sinceMs && c.ts && new Date(c.ts).getTime() < sinceMs) continue;
      if (seen.has(c.id)) continue; // dedup across sessions
      seen.add(c.id);
      candidates.push(c);
    }
  }
  // Stable ordering: category, then id — deterministic digest output.
  candidates.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  const counts = {};
  for (const c of candidates) counts[c.category] = (counts[c.category] || 0) + 1;
  return { mined, paired: candidates.length, candidates, counts, scannedFiles };
}

// ── Destination 1: project agent-file (stable, version-controlled) ──────────
// Corrections judged "stable" land in the PROJECT-ROOT CLAUDE.md, under a
// marker pair distinct from the framework's `<!-- BEGIN MADDU v1 -->` block so
// the two never clobber each other. The wording is deliberately product-facing:
// these are facts ABOUT the product being built, written into the product's own
// brief. They are NOT Máddu hard rules and must never be framed as such
// (scope-boundary rule).
export const LEARN_MARKER_BEGIN = '<!-- BEGIN MADDU LEARN v1 -->';
export const LEARN_MARKER_END = '<!-- END MADDU LEARN v1 -->';

// Render the agent-file block from the full set of agent-file corrections.
// `corrections` is an array of { text, category }.
export function renderAgentBlock(corrections) {
  const lines = [];
  lines.push(LEARN_MARKER_BEGIN);
  lines.push('## Learned corrections (project facts)');
  lines.push('');
  lines.push('_Distilled by `maddu learn` from past failed→succeeded tool calls in this');
  lines.push('repo. These describe THIS project — its paths, commands, and quirks — not the');
  lines.push('Máddu framework. Edit freely; `maddu learn` rewrites only between the markers._');
  lines.push('');
  if (!corrections.length) {
    lines.push('_(none yet)_');
  } else {
    const byCat = {};
    for (const c of corrections) (byCat[c.category] ||= []).push(c);
    for (const cat of Object.keys(byCat).sort()) {
      for (const c of byCat[cat]) lines.push(`- ${c.text}`);
    }
  }
  lines.push('');
  lines.push(LEARN_MARKER_END);
  return lines.join('\n');
}

// Write/replace the learn block in <repoRoot>/<filename> (default CLAUDE.md),
// preserving everything outside the markers. Returns { action, path }.
export async function writeAgentFileBlock(repoRoot, filename, corrections) {
  const target = join(repoRoot, filename);
  const block = renderAgentBlock(corrections);
  let existing = '';
  try { existing = await readFile(target, 'utf8'); } catch {}
  let next, action;
  if (existing.includes(LEARN_MARKER_BEGIN) && existing.includes(LEARN_MARKER_END)) {
    const re = new RegExp(
      `${LEARN_MARKER_BEGIN.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}[\\s\\S]*?${LEARN_MARKER_END.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`,
    );
    next = existing.replace(re, block);
    action = 'replace';
  } else if (existing.trim()) {
    next = existing.replace(/\n*$/, '\n') + '\n' + block + '\n';
    action = 'append';
  } else {
    next = block + '\n';
    action = 'create';
  }
  await writeFile(target, next);
  return { action, path: target };
}

// ── Judgment worker contract ────────────────────────────────────────────────
// The deterministic miner produces candidates; a spawned provider subprocess
// (commands/learn.mjs, hard rule #5 boundary) decides which become durable
// corrections, in what words, and to which destination. We hand it the
// candidates inside a delimited block and ask for a strict JSON array back.
// The PARENT — never the worker — writes the spine.

export function buildJudgePrompt(digest) {
  const candidates = digest.candidates.map((c) => ({
    id: c.id, category: c.category, tool: c.tool,
    failure: c.failure, failureError: c.failureError, success: c.success,
  }));
  return [
    'You are reviewing failed→succeeded tool-call pairs mined from a coding',
    'session, to distil durable corrections that would prevent the wasted',
    'attempt next time. For EACH candidate decide: is it a real, reusable',
    'lesson about THIS project (not a one-off)? If yes, write one terse',
    'imperative correction and route it:',
    '  - "agent-file": stable project facts (paths, required commands) — go in',
    '    the version-controlled brief.',
    '  - "memory":     softer/volatile patterns — go in queryable memory.',
    'These corrections describe the PRODUCT in this repo; they are NOT framework',
    'rules. Return ONLY a JSON array, one object per accepted candidate:',
    '[{"id":"<candidateId>","verdict":"accept","destination":"agent-file|memory","category":"<category>","text":"<correction>"}]',
    'Omit rejected candidates. No prose outside the JSON.',
    '',
    '<CANDIDATES>',
    JSON.stringify(candidates),
    '</CANDIDATES>',
  ].join('\n');
}

// Tolerantly extract the JSON judgments array from worker stdout (it may wrap
// the array in prose or code fences). Returns [] on any parse failure.
export function parseJudgments(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(stdout.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter((j) => j && typeof j.id === 'string' && j.verdict === 'accept'
    && typeof j.text === 'string' && (j.destination === 'agent-file' || j.destination === 'memory'));
}

// Render a human/agent-readable markdown digest (the no-provider fallback).
export function renderDigest(digest) {
  const lines = [];
  lines.push('# maddu learn — candidate corrections');
  lines.push('');
  lines.push(`Scanned ${digest.scannedFiles} session file(s); ${digest.paired} candidate correction(s).`);
  lines.push('');
  if (!digest.candidates.length) {
    lines.push('_No failure→success pairs found._');
    lines.push('');
    return lines.join('\n');
  }
  const byCat = {};
  for (const c of digest.candidates) (byCat[c.category] ||= []).push(c);
  for (const cat of Object.keys(byCat).sort()) {
    lines.push(`## ${cat} (${byCat[cat].length})`);
    lines.push('');
    for (const c of byCat[cat]) {
      lines.push(`- **${c.id}** · \`${c.tool}\``);
      lines.push(`  - failed: \`${c.failure}\`${c.failureError ? ` — ${c.failureError.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
      lines.push(`  - then succeeded: \`${c.success}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}
