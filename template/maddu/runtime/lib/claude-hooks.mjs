// Claude Code hook wiring for session discipline (v1.74.0).
//
// Installs a SessionStart hook that auto-registers a Máddu session (so the
// spine records a session every time an agent starts working in the repo —
// no reliance on the agent remembering its brief) and a SessionEnd hook that
// closes it. Combined with the active-session cache + resolveSessionId
// fallback, that auto-registered session flows into `lane claim` / `slice-stop`
// with no env var or `--session` to thread. Slice boundaries can't be
// auto-detected, so the SessionStart hook also surfaces a one-line reminder
// (as additionalContext) to claim a lane and slice-stop — the nudge half.
//
// Storage: <repo>/.claude/settings.json (a HOST-repo file, outside .maddu/ —
// written only on explicit `maddu hooks install`, never silently at init).
//
// JSON has no comment markers, so Máddu identifies its OWN hook entries by a
// sentinel substring in the command (MADDU_SENTINEL). install is idempotent
// (re-running changes nothing); remove strips exactly those entries and
// nothing else. The merge/strip functions are pure (no IO) so they unit-test
// without a temp repo; the IO wrappers are thin.

import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';

// The node invocation the project-local CLI shim (maddu/run) wraps. Pure node,
// so the hook command is cross-platform (no bash/cmd-specific shim path).
// Consumer installs carry the CLI at maddu/bin/maddu.mjs; the framework
// SOURCE repo carries it at bin/maddu.mjs (there is no maddu/bin there —
// dogfooding v1.89.0 surfaced hooks that silently errored on every fire).
// resolveHookBin picks the right one at install time.
export const HOOK_BIN = 'node maddu/bin/maddu.mjs';
export const HOOK_BIN_SOURCE = 'node bin/maddu.mjs';
export const MADDU_SENTINEL = 'hooks fire';

// IO: which entrypoint exists in THIS repo. Consumer layout wins; the source
// layout is the fallback only when the consumer path is absent and the source
// CLI is present. Unknown layouts keep the consumer default.
export async function resolveHookBin(repoRoot) {
  const has = async (p) => { try { await stat(p); return true; } catch { return false; } };
  if (await has(join(repoRoot, 'maddu', 'bin', 'maddu.mjs'))) return HOOK_BIN;
  if (await has(join(repoRoot, 'bin', 'maddu.mjs'))) return HOOK_BIN_SOURCE;
  return HOOK_BIN;
}

// The hook events Máddu wires, in install order. `event` is the Claude Code
// hook event name; `fire` is the `maddu hooks fire <fire>` sub-event.
export const MADDU_HOOKS = [
  { event: 'SessionStart', fire: 'session-start' },
  { event: 'SessionEnd', fire: 'session-end' },
  // No matcher on the group → fires on BOTH manual (/compact) and auto
  // compaction; the payload's `trigger` field records which (v1.89.0).
  { event: 'PreCompact', fire: 'pre-compact' },
  // Enforce session rituals (auto-claim a lane, then allow/nudge/deny) before a
  // MUTATING tool call. The matcher scopes it to the file-mutating tools plus
  // Bash — the fire handler classifies each Bash command (classifyBashWrite) and
  // exits immediately for reads/remedies, so only recognized Bash writes are
  // gated. Best-effort and FAILS OPEN — it never exits 2, so it can't block the
  // tool on an error; only an explicit deny (permissionDecision) stops an edit.
  { event: 'PreToolUse', fire: 'pre-tool-use', matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash' },
];

export function hookCommandFor(fire, bin = HOOK_BIN) {
  return `${bin} hooks fire ${fire}`;
}

function isMadduCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes('maddu.mjs') && cmd.includes(MADDU_SENTINEL);
}

// True if a SessionStart/SessionEnd-shaped group already carries our command.
function groupHasMaddu(group) {
  return !!group && Array.isArray(group.hooks) && group.hooks.some((h) => isMadduCommand(h && h.command));
}

// Pure: return a NEW settings object with Máddu's hook entries ensured. Any
// non-Máddu hooks (the user's own) are preserved untouched. Idempotent.
// `bin` selects the entrypoint (consumer default; pass resolveHookBin's
// answer so a source-repo install writes a command that actually exists).
export function mergeInstall(settings, { bin = HOOK_BIN } = {}) {
  const next = settings && typeof settings === 'object' ? structuredCloneSafe(settings) : {};
  if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
  for (const { event, fire, matcher } of MADDU_HOOKS) {
    const arr = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    // Drop any prior Máddu group for this event (so re-install refreshes the
    // command text), keep everything else, then append a fresh group. A matcher
    // (e.g. PreToolUse) is written on the group so Claude Code scopes the hook.
    const kept = arr.filter((g) => !groupHasMaddu(g));
    const group = { hooks: [{ type: 'command', command: hookCommandFor(fire, bin) }] };
    if (matcher) group.matcher = matcher;
    kept.push(group);
    next.hooks[event] = kept;
  }
  return next;
}

// Pure: return a NEW settings object with Máddu's hook entries removed, and
// any now-empty event arrays / the hooks object itself cleaned up.
export function stripMaddu(settings) {
  if (!settings || typeof settings !== 'object' || !settings.hooks) return settings || {};
  const next = structuredCloneSafe(settings);
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].filter((g) => !groupHasMaddu(g));
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

// Pure: which Máddu hook events are currently installed in `settings`.
export function summarize(settings) {
  const installed = [];
  const hooks = settings && settings.hooks;
  if (hooks && typeof hooks === 'object') {
    for (const { event } of MADDU_HOOKS) {
      if (Array.isArray(hooks[event]) && hooks[event].some(groupHasMaddu)) installed.push(event);
    }
  }
  return { installed, allInstalled: installed.length === MADDU_HOOKS.length };
}

// ── status line (opt-in) ────────────────────────────────────────────────────
// A one-line `maddu status --line` segment, wired as the Claude Code statusLine
// ONLY on explicit `maddu hooks install --statusline`. Never clobbers an
// operator's own statusLine: merge writes ours only when the slot is empty or
// already ours; strip removes only ours. Identified (like the hook commands) by
// a sentinel substring in the command.
export function statusLineCommandFor(bin = HOOK_BIN) {
  return `${bin} status --line`;
}

function isMadduStatusLine(sl) {
  return !!sl && typeof sl === 'object' && typeof sl.command === 'string'
    && sl.command.includes('maddu.mjs') && sl.command.includes('status --line');
}

// Pure: ensure Máddu's statusLine. If the operator already set a DIFFERENT
// statusLine, leave it untouched and report skipped:true so the caller can say
// so. Returns { settings, skipped }.
export function mergeStatusLine(settings, { bin = HOOK_BIN } = {}) {
  const next = settings && typeof settings === 'object' ? structuredCloneSafe(settings) : {};
  if (next.statusLine && !isMadduStatusLine(next.statusLine)) {
    return { settings: next, skipped: true };
  }
  next.statusLine = { type: 'command', command: statusLineCommandFor(bin) };
  return { settings: next, skipped: false };
}

// Pure: remove Máddu's statusLine if present; leave a non-Máddu one intact.
export function stripStatusLine(settings) {
  if (!settings || typeof settings !== 'object') return settings || {};
  if (!isMadduStatusLine(settings.statusLine)) return settings;
  const next = structuredCloneSafe(settings);
  delete next.statusLine;
  return next;
}

// Pure: is Máddu's statusLine currently installed?
export function statusLineInstalled(settings) {
  return isMadduStatusLine(settings && settings.statusLine);
}

// ── Permission guardrails (verification-witness plan, PR 3) ─────────────────
// deny/ask rules over the verdict-machinery paths, installed alongside the
// hooks. HONEST STRENGTH (docs/34-threat-model.md §12, SECURITY.md): this is
// bypassable harness friction inside Claude Code, not a security boundary —
// Edit/Read deny rules cover the built-in file tools plus the Bash file
// commands Claude Code recognizes, and are documented NOT to reach arbitrary
// subprocesses (`node -e`, `python -c`). OS-level enforcement is the Claude
// Code sandbox (`filesystem.denyWrite`), unavailable on native Windows.
//
// Edit-form ONLY: `Write(path)` rules are accepted but never matched by file
// permission checks in Claude Code v2.1.210+ (officially documented — use
// `Edit(path)`, which also blocks creating a new file there).
//
// OWNERSHIP MODEL (documented limit): permission rules are plain strings, so
// there is no room for a sentinel marker inside a rule. Máddu owns EXACTLY the
// strings it generates: merge unions them in without duplicates, strip removes
// them by string equality. Consequence: if the operator had hand-authored an
// identical rule string before install, uninstall removes it too — re-add it
// by hand. Non-identical operator rules are never touched.

// Consumer layout: the runtime lives at maddu/, and a consumer's agent has no
// legitimate reason to edit framework internals → deny.
export const GUARDRAIL_DENY_CONSUMER = [
  'Edit(maddu/runtime/**)',
  'Edit(.maddu/config/**)',
  'Edit(.maddu/gates/**)',
  'Edit(.claude/settings.json)',
  'Edit(.claude/settings.local.json)',
];
// Framework SOURCE repo: gate/verifier development IS the work, so the TCB
// paths carry operator-managed `ask` rules instead (committed in-repo); the
// guardrail layer only self-protects the settings files.
export const GUARDRAIL_DENY_SOURCE = [
  'Edit(.claude/settings.json)',
  'Edit(.claude/settings.local.json)',
];

// A declared project path → an ask rule. Paths come from maddu.json
// `guardrails.ask[]` — DECLARED by the project, never guessed (Máddu cannot
// know where a consumer's tests live; a guessed rule is dead or wrong).
// Parentheses are rejected because the path is interpolated into the rule
// syntax `Edit(<path>)` and a ')' would terminate the rule early.
export function guardrailAskRules(askPaths) {
  const rules = [];
  for (const p of Array.isArray(askPaths) ? askPaths : []) {
    if (typeof p !== 'string') continue;
    const t = p.trim();
    if (!t || t.includes('(') || t.includes(')')) continue;
    rules.push(`Edit(${t})`);
  }
  return rules;
}

// Pure: retire inert `Write(X)` twins. A `Write(path)` rule is documented
// inert in Claude Code v2.1.210+; when the SAME array also carries `Edit(X)`
// (which subsumes it), removing the Write twin is behavior-neutral dead-config
// cleanup. Only twin-redundant Write rules are removed — a Write rule with no
// Edit twin is left alone (still inert, but removing it would change what the
// operator sees without a covering rule remaining). Returns { settings,
// retired } and reports every removal so the caller can print it.
export function retireInertWriteTwins(settings) {
  const retired = [];
  if (!settings?.permissions || typeof settings.permissions !== 'object') {
    return { settings: settings || {}, retired };
  }
  const next = structuredCloneSafe(settings);
  for (const key of ['deny', 'ask', 'allow']) {
    const arr = next.permissions[key];
    if (!Array.isArray(arr)) continue;
    const editSet = new Set(arr.filter((r) => typeof r === 'string' && r.startsWith('Edit(')));
    next.permissions[key] = arr.filter((r) => {
      if (typeof r !== 'string' || !r.startsWith('Write(')) return true;
      const twin = 'Edit(' + r.slice('Write('.length);
      if (editSet.has(twin)) { retired.push({ list: key, rule: r }); return false; }
      return true;
    });
  }
  return { settings: next, retired };
}

// Pure: union the guardrail rules into permissions.deny / permissions.ask
// (no duplicates, existing order preserved, user rules untouched), then
// retire inert Write twins. Returns { settings, added, retired }.
export function mergeGuardrails(settings, { deny = [], ask = [] } = {}) {
  const base = settings && typeof settings === 'object' ? structuredCloneSafe(settings) : {};
  if (!base.permissions || typeof base.permissions !== 'object') base.permissions = {};
  const added = { deny: [], ask: [] };
  for (const [key, rules] of [['deny', deny], ['ask', ask]]) {
    if (!rules.length) continue;
    const arr = Array.isArray(base.permissions[key]) ? base.permissions[key] : [];
    const have = new Set(arr.filter((r) => typeof r === 'string'));
    for (const r of rules) {
      if (!have.has(r)) { arr.push(r); have.add(r); added[key].push(r); }
    }
    base.permissions[key] = arr;
  }
  const { settings: next, retired } = retireInertWriteTwins(base);
  return { settings: next, added, retired };
}

// Pure: remove exactly the canonical guardrail rule strings; clean up empty
// arrays / an empty permissions object. Never touches non-matching rules.
export function stripGuardrails(settings, { deny = [], ask = [] } = {}) {
  if (!settings || typeof settings !== 'object' || !settings.permissions) return settings || {};
  const next = structuredCloneSafe(settings);
  const drop = { deny: new Set(deny), ask: new Set(ask) };
  for (const key of ['deny', 'ask']) {
    if (!Array.isArray(next.permissions[key])) continue;
    next.permissions[key] = next.permissions[key].filter((r) => !drop[key].has(r));
    if (next.permissions[key].length === 0) delete next.permissions[key];
  }
  if (Object.keys(next.permissions).length === 0) delete next.permissions;
  return next;
}

// Pure: which canonical guardrail rules are present / missing.
export function summarizeGuardrails(settings, { deny = [], ask = [] } = {}) {
  const has = (key, r) => Array.isArray(settings?.permissions?.[key]) && settings.permissions[key].includes(r);
  const present = [], missing = [];
  for (const r of deny) (has('deny', r) ? present : missing).push(`deny ${r}`);
  for (const r of ask) (has('ask', r) ? present : missing).push(`ask ${r}`);
  return { present, missing, allInstalled: missing.length === 0 && (deny.length + ask.length) > 0 };
}

// IO: the canonical rule set for THIS repo — layout-aware deny list + ask
// rules generated from maddu.json `guardrails.ask[]` (absent → none).
export async function resolveGuardrailRules(repoRoot) {
  const has = async (p) => { try { await stat(p); return true; } catch { return false; } };
  const isSource = !(await has(join(repoRoot, 'maddu', 'bin', 'maddu.mjs')))
    && (await has(join(repoRoot, 'bin', 'maddu.mjs')));
  const deny = isSource ? [...GUARDRAIL_DENY_SOURCE] : [...GUARDRAIL_DENY_CONSUMER];
  let askPaths = [];
  try {
    const raw = await readFile(join(repoRoot, 'maddu.json'), 'utf8');
    const cfg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    askPaths = cfg?.guardrails?.ask || [];
  } catch { /* no maddu.json / malformed → no ask rules */ }
  return { deny, ask: guardrailAskRules(askPaths), layout: isSource ? 'source' : 'consumer' };
}

// structuredClone is available on Node ≥ 17; fall back to JSON round-trip for
// the plain-data settings object on anything older.
function structuredCloneSafe(obj) {
  try { return structuredClone(obj); }
  catch { return JSON.parse(JSON.stringify(obj)); }
}

// ── IO wrappers ──────────────────────────────────────────────────────────

export function settingsPath(repoRoot) {
  return join(repoRoot, '.claude', 'settings.json');
}

// Returns { settings, existed, raw }. A malformed file is reported (existed:
// true, settings: null) so the caller refuses to clobber it rather than
// silently overwriting hand-authored JSON.
export async function loadSettings(repoRoot) {
  const path = settingsPath(repoRoot);
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch { return { settings: {}, existed: false, raw: null }; }
  let stripped = raw;
  if (stripped.charCodeAt(0) === 0xFEFF) stripped = stripped.slice(1);
  try { return { settings: JSON.parse(stripped), existed: true, raw }; }
  catch { return { settings: null, existed: true, raw }; }
}

// Atomic write (temp + rename), 2-space JSON, trailing newline, preserving the
// file's existing EOL style when it already exists.
export async function saveSettings(repoRoot, settings, { eol = '\n' } = {}) {
  const dir = join(repoRoot, '.claude');
  await mkdir(dir, { recursive: true });
  const dst = settingsPath(repoRoot);
  const tmp = dst + '.tmp';
  let body = JSON.stringify(settings, null, 2) + '\n';
  if (eol === '\r\n') body = body.replace(/\n/g, '\r\n');
  await writeFile(tmp, body);
  await rename(tmp, dst);
  return dst;
}
