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

import { readFile, writeFile, stat, mkdir, readdir } from 'node:fs/promises';
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

// ---------------------------------------------------------------------------
// Slash-command install mechanics (v0.18 Phase 1).
//
// Slash commands are framework-owned markdown files installed into
// `.claude/commands/maddu-*.md` and `.codex/commands/maddu-*.md`. Claude
// Code and Codex CLI natively pick these up — when the operator types
// `/maddu-<name> <args>` the agent inlines the markdown into the
// conversation and dispatches the underlying `maddu` CLI calls.
//
// Source of truth: `template/maddu/agent-files/commands/*.md` in the
// framework checkout, or `<consumer>/maddu/agent-files/commands/*.md`
// after install (mirrored automatically by frameworkOwnedFiles()).
//
// Discipline:
//   - Each installed file body is wrapped in <!-- BEGIN MADDU v1 --> /
//     <!-- END MADDU v1 --> markers — same pattern as CLAUDE.md/AGENTS.md
//     so operators can append project-specific instructions outside the
//     marker block without losing them on upgrade.
//   - Files NOT prefixed `maddu-` are operator-owned and never touched.
//   - When no slash-command templates exist (Phase 1), we still create
//     the .claude/commands/ and .codex/commands/ directories so the
//     install path is exercised and operators can drop their own
//     commands beside Máddu's.
// ---------------------------------------------------------------------------

const SLASH_COMMAND_DIRS = ['.claude/commands', '.codex/commands'];

async function exists_(p) { return exists(p); }

// Locate the slash-command template directory. Probes:
//   <root>/template/maddu/agent-files/commands  (source layout)
//   <root>/maddu/agent-files/commands           (installed/consumer layout)
// Returns absolute path or null.
async function locateSlashCommandTemplateDir(frameworkRoot) {
  const sourceBase = join(frameworkRoot, 'template', 'maddu', 'agent-files', 'commands');
  const installedBase = join(frameworkRoot, 'maddu', 'agent-files', 'commands');
  if (await exists(sourceBase)) return sourceBase;
  if (await exists(installedBase)) return installedBase;
  return null;
}

// List slash-command template files (`<name>.md`) from a template dir.
// Filters to *.md only; ignores any non-markdown debris.
async function listSlashCommandTemplates(templateDir) {
  let entries;
  try { entries = await readdir(templateDir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name.startsWith('maddu-'))
    .map((e) => e.name)
    .sort();
}

// Sync one slash command into both `.claude/commands/` and `.codex/commands/`.
// Returns { file, action } pairs (one per dir).
async function syncOneSlashCommand(repoRoot, fileName, bodyText) {
  const wrapped = wrapWithMarkers(bodyText);
  const results = [];
  for (const dir of SLASH_COMMAND_DIRS) {
    const target = join(repoRoot, dir, fileName);
    if (!(await exists(target))) {
      results.push(await syncOne(target, wrapped));
      continue;
    }
    const existing = normalize(await readFile(target, 'utf8'));
    if (existing.includes(MARKER_BEGIN) && existing.includes(MARKER_END)) {
      const next = replaceBetweenMarkers(existing, wrapped);
      results.push(await syncOne(target, next));
    } else {
      // Existing file without markers — preserve it. The gate will
      // surface drift. We do not prepend here; slash-command files are
      // single-purpose and a marker-less variant is most likely an
      // operator-authored override (or an older Máddu install pre-v0.18).
      results.push({ action: 'no-change', file: target, reason: 'no-markers-present' });
    }
  }
  return results;
}

// Drive the slash-command sync. Creates both target directories
// unconditionally; installs each template file under marker discipline.
// Returns a summary suitable for a SLASH_COMMANDS_SYNCED event payload.
export async function syncSlashCommands(repoRoot, frameworkRoot) {
  // Ensure target directories exist even when nothing ships.
  for (const dir of SLASH_COMMAND_DIRS) {
    await mkdir(join(repoRoot, dir), { recursive: true });
  }
  const templateDir = await locateSlashCommandTemplateDir(frameworkRoot);
  if (!templateDir) {
    return { action: 'no-change', files: [], perFile: {}, reason: 'no-template-dir' };
  }
  const fileNames = await listSlashCommandTemplates(templateDir);
  if (fileNames.length === 0) {
    return { action: 'no-change', files: [], perFile: {}, reason: 'no-templates' };
  }
  const perFile = {};
  let sawCreate = false, sawMerge = false;
  for (const name of fileNames) {
    const body = await readFile(join(templateDir, name), 'utf8');
    const results = await syncOneSlashCommand(repoRoot, name, body);
    for (const r of results) {
      const key = r.file.split(/[\\/]/).slice(-3).join('/');
      perFile[key] = r.action;
      if (r.action === 'create') sawCreate = true;
      else if (r.action === 'merge') sawMerge = true;
    }
  }
  let action = 'no-change';
  if (sawCreate) action = 'create';
  else if (sawMerge) action = 'merge';
  return { action, files: fileNames, perFile };
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
