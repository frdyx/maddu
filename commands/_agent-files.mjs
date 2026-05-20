// Agent-file bootstrap helper — Phase 4 of the v0.17 agent-native rollout.
//
// Owns the create-or-merge discipline for the three repo-root agent files:
//   MADDU.md          — canonical agent brief (full file, ~150 lines)
//   CLAUDE.md         — short marker-delimited stanza for Claude Code
//   AGENTS.md         — short marker-delimited stanza for Codex CLI et al.
//
// Discipline (plan §2.4):
//   1. File missing → create with just the Máddu content.
//   2. File exists, markers present → replace BETWEEN markers only.
//   3. File exists, no markers → prepend the Máddu section + blank line.
//      The existing file's bytes are preserved verbatim after the prepend.
//
// MADDU.md is treated as a *whole file owned by Máddu* — there are no
// markers. If the operator wants to keep a hand-edited copy, they
// remove it from the auto-write list (future work — for now `--force`
// overwrites; without `--force` we keep operator edits and emit
// action:'no-change').

import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const MARKER_BEGIN = '<!-- BEGIN MADDU v1 -->';
export const MARKER_END = '<!-- END MADDU v1 -->';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

function hashText(text) {
  return createHash('sha256').update(normalize(text)).digest('hex');
}

// Wrap a marker-less stanza body with BEGIN/END markers + outer newlines.
function wrapWithMarkers(body) {
  const trimmed = body.replace(/^\s+|\s+$/g, '');
  return `${MARKER_BEGIN}\n${trimmed}\n${MARKER_END}\n`;
}

// Replace the content between BEGIN/END markers (inclusive of the markers
// themselves) with `wrapped`. Caller pre-wraps via wrapWithMarkers().
//
// Match the markers themselves but NOT a trailing newline — that way
// the splice doesn't toggle the file's terminal newline across runs
// (which would make re-runs ping-pong between 'merge' and 'no-change'
// and break the agent-file-current gate's byte-equality check). The
// `wrapped` argument keeps its terminal newline as long as the source
// file had one after END.
function replaceBetweenMarkers(text, wrapped) {
  const re = new RegExp(
    `${MARKER_BEGIN.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}[\\s\\S]*?${MARKER_END.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`,
    'm'
  );
  // Strip the trailing newline from `wrapped` because the regex above
  // doesn't consume the next char — feeding `wrapped` verbatim would
  // duplicate the newline that already follows END in the original.
  const wrappedNoTrailingNL = wrapped.endsWith('\n') ? wrapped.slice(0, -1) : wrapped;
  return text.replace(re, wrappedNoTrailingNL);
}

// One file's outcome.
//   action: 'create' — file did not exist; we wrote the canonical content.
//   action: 'merge'  — file existed; we either replaced the marker block
//                      or prepended a new one.
//   action: 'no-change' — file already byte-equal to what we'd write.
async function syncOne(targetPath, finalText) {
  const finalNorm = normalize(finalText);
  if (!(await exists(targetPath))) {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, finalNorm);
    return { action: 'create', file: targetPath };
  }
  const existing = normalize(await readFile(targetPath, 'utf8'));
  if (hashText(existing) === hashText(finalNorm)) {
    return { action: 'no-change', file: targetPath };
  }
  await writeFile(targetPath, finalNorm);
  return { action: 'merge', file: targetPath };
}

// Sync the MADDU.md canonical file. Whole-file ownership — no markers.
// If the operator has a custom MADDU.md they should rename it; the
// upgrade path treats divergence as 'merge' (overwrite). This mirrors
// frameworkOwnedFiles behavior for managed files.
export async function syncMaddu(repoRoot, canonicalText) {
  const target = join(repoRoot, 'MADDU.md');
  return syncOne(target, canonicalText);
}

// Sync CLAUDE.md / AGENTS.md per the three-rule discipline above.
//   - File missing → create with just the Máddu wrapped section.
//   - File exists, markers present → replace between markers.
//   - File exists, no markers → prepend wrapped section + blank line.
export async function syncMarkerFile(repoRoot, filename, sectionBody) {
  const target = join(repoRoot, filename);
  const wrapped = wrapWithMarkers(sectionBody);

  if (!(await exists(target))) {
    return syncOne(target, wrapped);
  }
  const existing = normalize(await readFile(target, 'utf8'));
  if (existing.includes(MARKER_BEGIN) && existing.includes(MARKER_END)) {
    // Markers present — replace between them. Rest of the file is
    // operator-owned and stays byte-identical.
    const next = replaceBetweenMarkers(existing, wrapped);
    return syncOne(target, next);
  }
  // No markers — prepend the wrapped section + blank line, preserving
  // the operator's existing file content verbatim below.
  const next = wrapped + '\n' + existing;
  return syncOne(target, next);
}

// Load the canonical content from the framework template tree. The
// caller passes the framework root (the maddu repo for dev, or the
// installed maddu/ directory for consumers). Returns:
//   { madduCanonical, claudeSection, agentsSection }
export async function loadAgentFileTemplates(frameworkRoot) {
  const base = join(frameworkRoot, 'template', 'maddu', 'agent-files');
  // Consumer-side: templates also ship under <consumer>/maddu/agent-files/
  // via the framework-owned manifest. Probe both.
  const installedBase = join(frameworkRoot, 'maddu', 'agent-files');
  const root = (await exists(base)) ? base
             : (await exists(installedBase)) ? installedBase
             : null;
  if (!root) {
    throw new Error(`agent-files templates not found under ${base} or ${installedBase}`);
  }
  const [maddu, claude, agents] = await Promise.all([
    readFile(join(root, 'MADDU.md'), 'utf8'),
    readFile(join(root, 'CLAUDE.section.md'), 'utf8'),
    readFile(join(root, 'AGENTS.section.md'), 'utf8'),
  ]);
  return { madduCanonical: maddu, claudeSection: claude, agentsSection: agents };
}

// Drive all three syncs and return a summary suitable for the
// AGENT_FILE_SYNCED event payload. Single event per init/upgrade run.
export async function syncAllAgentFiles(repoRoot, templates) {
  const results = await Promise.all([
    syncMaddu(repoRoot, templates.madduCanonical),
    syncMarkerFile(repoRoot, 'CLAUDE.md', templates.claudeSection),
    syncMarkerFile(repoRoot, 'AGENTS.md', templates.agentsSection),
  ]);
  // Roll up: if every file is no-change → 'no-change'; if any create →
  // 'create' wins; otherwise 'merge'. The per-file detail rides in
  // the event data.files entries (not yet exposed — keep payload terse).
  let action = 'no-change';
  if (results.some((r) => r.action === 'create')) action = 'create';
  else if (results.some((r) => r.action === 'merge')) action = 'merge';
  return {
    action,
    files: ['MADDU.md', 'CLAUDE.md', 'AGENTS.md'],
    perFile: Object.fromEntries(results.map((r) => [
      r.file.split(/[\\/]/).pop(), r.action
    ])),
  };
}
