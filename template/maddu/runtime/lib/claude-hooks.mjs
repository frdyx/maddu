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
  for (const { event, fire } of MADDU_HOOKS) {
    const arr = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    // Drop any prior Máddu group for this event (so re-install refreshes the
    // command text), keep everything else, then append a fresh group.
    const kept = arr.filter((g) => !groupHasMaddu(g));
    kept.push({ hooks: [{ type: 'command', command: hookCommandFor(fire, bin) }] });
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
