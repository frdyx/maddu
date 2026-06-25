// Global agent-instruction targets — make "install maddu" available to AI
// agents machine-wide via natural language. Files-only, device-bound.
//
// The problem: an operator wants `install maddu` to Just Work in every future
// repo, on a machine whose exact paths we cannot know in advance. The solution
// mirrors how the workspace registry resolves device-local config — never a
// hardcoded path, always `os.homedir()` + a per-agent convention (overridable
// by the agent's own env var), detected by directory existence, with an
// explicit custom-path escape hatch for anything non-standard.
//
// This module writes a single marker-delimited stanza (the self-contained
// "install maddu" instruction) into each selected agent's GLOBAL instruction
// file. It is a polite guest: it only ever touches the region between its own
// markers and never rewrites operator content. Re-running replaces the block in
// place (idempotent), so upgrades never duplicate.
//
// Storage targets (resolved at runtime, see KNOWN_AGENTS):
//   Claude Code   ~/.claude/CLAUDE.md      (env: CLAUDE_CONFIG_DIR)
//   Codex         ~/.codex/AGENTS.md       (env: CODEX_HOME)
//   Gemini CLI    ~/.gemini/GEMINI.md
//   Generic       ~/AGENTS.md              (explicit only — see autodetect:false)
//   <custom>      any absolute path the operator names (the advanced step)

import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

// Distinct from the repo-root worker-brief markers (`BEGIN MADDU v1`) so a
// global file can carry the install stanza independently and we can detect it
// precisely.
export const INSTALL_MARKER_BEGIN = '<!-- BEGIN MADDU INSTALL v1 -->';
export const INSTALL_MARKER_END = '<!-- END MADDU INSTALL v1 -->';

// The known-agent table. Extensible — add a row and everything else (detect,
// register, unregister, help) picks it up. `dir` is relative to the home
// directory unless `dirEnv` names an env var holding an absolute config dir.
// `autodetect:false` means the target is never auto-offered (its dir always
// exists), only written when explicitly selected.
export const KNOWN_AGENTS = [
  { id: 'claude', label: 'Claude Code', dirEnv: 'CLAUDE_CONFIG_DIR', dir: '.claude', file: 'CLAUDE.md', autodetect: true },
  { id: 'codex', label: 'Codex', dirEnv: 'CODEX_HOME', dir: '.codex', file: 'AGENTS.md', autodetect: true },
  { id: 'gemini', label: 'Gemini CLI', dirEnv: null, dir: '.gemini', file: 'GEMINI.md', autodetect: true },
  { id: 'agents', label: 'Generic AGENTS.md', dirEnv: null, dir: '', file: 'AGENTS.md', autodetect: false },
];

export function agentById(id) {
  return KNOWN_AGENTS.find((a) => a.id === id) || null;
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

// Resolve an agent's config DIRECTORY (env override → homedir + convention).
export function resolveAgentDir(agent) {
  if (agent.dirEnv && process.env[agent.dirEnv]) {
    return resolve(process.env[agent.dirEnv]);
  }
  return agent.dir ? join(homedir(), agent.dir) : homedir();
}

// Resolve an agent's global instruction FILE (absolute path).
export function resolveAgentFile(agent) {
  return join(resolveAgentDir(agent), agent.file);
}

// Detect every known agent: where its file would live, whether its config dir
// is present on this machine (the autodetect signal), and whether our install
// stanza is already merged into the file.
export async function detectAgents() {
  const out = [];
  for (const agent of KNOWN_AGENTS) {
    const dir = resolveAgentDir(agent);
    const file = resolveAgentFile(agent);
    const dirPresent = await exists(dir);
    let installed = false;
    let fileExists = false;
    if (await exists(file)) {
      fileExists = true;
      try {
        const text = normalize(await readFile(file, 'utf8'));
        installed = text.includes(INSTALL_MARKER_BEGIN);
      } catch {}
    }
    out.push({
      id: agent.id, label: agent.label, file, dir,
      // "present" = worth auto-offering: the agent's own dir exists, or the
      // stanza is already there (so we can report/update it).
      present: (agent.autodetect && dirPresent) || installed,
      dirPresent, fileExists, installed,
    });
  }
  return out;
}

// Wrap a stanza body in the install markers (+ terminal newline).
function wrapStanza(body) {
  const trimmed = body.replace(/^\s+|\s+$/g, '');
  return `${INSTALL_MARKER_BEGIN}\n${trimmed}\n${INSTALL_MARKER_END}\n`;
}

// Replace the existing marker region (markers inclusive) with `wrapped`,
// without toggling the file's terminal newline across runs (keeps re-runs
// byte-stable so "already current" is detectable).
function replaceBetweenMarkers(text, wrapped) {
  const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`${esc(INSTALL_MARKER_BEGIN)}[\\s\\S]*?${esc(INSTALL_MARKER_END)}`, 'm');
  const wrappedNoTrailingNL = wrapped.endsWith('\n') ? wrapped.slice(0, -1) : wrapped;
  return text.replace(re, wrappedNoTrailingNL);
}

// Merge the install stanza into an absolute file path. Discipline:
//   - File missing            → create with just the wrapped stanza.
//   - File exists, has markers → replace between markers (operator content kept).
//   - File exists, no markers  → append the wrapped stanza after a blank line
//     (operator content above is preserved verbatim).
// Returns { action: 'create'|'merge'|'no-change', file }.
export async function mergeInstallStanza(absPath, stanzaBody) {
  const file = isAbsolute(absPath) ? absPath : resolve(process.cwd(), absPath);
  const wrapped = wrapStanza(stanzaBody);

  if (!(await exists(file))) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, wrapped);
    return { action: 'create', file };
  }
  const existing = normalize(await readFile(file, 'utf8'));
  let next;
  if (existing.includes(INSTALL_MARKER_BEGIN) && existing.includes(INSTALL_MARKER_END)) {
    next = replaceBetweenMarkers(existing, wrapped);
  } else {
    next = existing.replace(/\s*$/, '') + '\n\n' + wrapped;
  }
  if (normalize(next) === existing) return { action: 'no-change', file };
  await writeFile(file, next);
  return { action: 'merge', file };
}

// Remove the marker region from an absolute file path (operator content kept).
// Returns { action: 'removed'|'absent'|'missing', file }.
export async function removeInstallStanza(absPath) {
  const file = isAbsolute(absPath) ? absPath : resolve(process.cwd(), absPath);
  if (!(await exists(file))) return { action: 'missing', file };
  const existing = normalize(await readFile(file, 'utf8'));
  if (!existing.includes(INSTALL_MARKER_BEGIN)) return { action: 'absent', file };
  const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`\\n*${esc(INSTALL_MARKER_BEGIN)}[\\s\\S]*?${esc(INSTALL_MARKER_END)}\\n*`, 'm');
  const next = existing.replace(re, '\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
  await writeFile(file, next.endsWith('\n') ? next : next + '\n');
  return { action: 'removed', file };
}

// Load the single-sourced install stanza body from the framework tree. Probes
// the dev-source layout and the consumer-installed layout (same dual-probe as
// loadAgentFileTemplates).
export async function loadInstallStanza(frameworkRoot) {
  const candidates = [
    // dev-source layout (frameworkRoot = repo root)
    join(frameworkRoot, 'template', 'maddu', 'agent-files', 'GLOBAL-INSTALL.section.md'),
    join(frameworkRoot, 'maddu', 'agent-files', 'GLOBAL-INSTALL.section.md'),
    // consumer install (frameworkRoot = <repo>/maddu)
    join(frameworkRoot, 'agent-files', 'GLOBAL-INSTALL.section.md'),
  ];
  for (const c of candidates) {
    if (await exists(c)) return readFile(c, 'utf8');
  }
  throw new Error(`GLOBAL-INSTALL.section.md not found under ${candidates.join(' or ')}`);
}
