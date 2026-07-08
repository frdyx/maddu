// Máddu self-discipline evaluator — the read-only core that decides whether an
// agent's next tool call should be allowed, nudged, or blocked because a Máddu
// ritual is stale (no session/lane, no governing goal/plan, slice-stop overdue,
// or uncommitted work piling up).
//
// SCOPE HONESTY: this governs the *Claude tool surface* (Edit/Write/MultiEdit/
// NotebookEdit + recognized Bash writes), NOT the whole filesystem. Another
// runtime, an MCP server, or an unrecognized generator can still write; the
// after-the-fact git/slice-stop guards catch the resulting mess.
//
// TWO LAYERS:
//   • decide(...)          — PURE. synthetic-state in, verdict out. fully tested.
//   • gatherRitualState()  — impure (reads project/plans/git/session). thin.
//   • evaluateDiscipline() — convenience wrapper the hooks call. FAILS OPEN.
//
// FAIL-OPEN LAW: every impure path is wrapped so any error yields verdict 'ok'
// (allow). Only an explicit, deterministic verdict 'block' ever denies a tool.

import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathsFor } from './paths.mjs';
import { gitRun } from './git-exec.mjs';

// ── Enforcement + thresholds, keyed by governance mode ──────────────────────
// enforcement: 'block' (strict — deny at the first threshold), 'graduated'
// (standard — warn, then deny at a higher threshold), 'nudge' (relaxed —
// surface reminders, never deny). The governance key `discipline-enforcement`
// selects the tier; these matrices carry the numeric thresholds per tier.
export const DISCIPLINE_DEFAULTS = {
  strict: {
    enforcement: 'block',
    slicestop:   { warnEdits: 6,  blockEdits: 6,  warnMin: 20, blockMin: 20 },
    uncommitted: { warnFiles: 15, blockFiles: 15, warnMin: 45, blockMin: 45, blockIfSlicedButDirty: true },
    goalplan:    { graceEdits: 0, graceMin: 0 },
  },
  standard: {
    enforcement: 'graduated',
    slicestop:   { warnEdits: 6,  blockEdits: 12, warnMin: 20, blockMin: 45 },
    uncommitted: { warnFiles: 15, blockFiles: 30, warnMin: 45, blockMin: 90, blockIfSlicedButDirty: false },
    goalplan:    { graceEdits: 2, graceMin: 10 },
  },
  relaxed: {
    enforcement: 'nudge',
    slicestop:   { warnEdits: 6,  blockEdits: Infinity, warnMin: 20, blockMin: Infinity },
    uncommitted: { warnFiles: 15, blockFiles: Infinity, warnMin: 45, blockMin: Infinity, blockIfSlicedButDirty: false },
    goalplan:    { graceEdits: 0, graceMin: 0 },
  },
};

// Resolve the tier config for a governance mode, applying any operator overrides
// from .maddu/config/discipline.json (shallow per-section merge). Pure given its
// inputs; the file read is done by readDisciplineConfig below.
export function resolveThresholds(mode, overrides = {}) {
  const base = DISCIPLINE_DEFAULTS[mode] || DISCIPLINE_DEFAULTS.standard;
  const merged = {
    enforcement: overrides.enforcement || base.enforcement,
    slicestop:   { ...base.slicestop,   ...(overrides.slicestop   || {}) },
    uncommitted: { ...base.uncommitted, ...(overrides.uncommitted || {}) },
    goalplan:    { ...base.goalplan,    ...(overrides.goalplan     || {}) },
  };
  return merged;
}

// ── The Bash write-classifier ───────────────────────────────────────────────
// Returns 'remedy' | 'write' | 'allow'.
//  • 'remedy' — an exact ritual-remedy command; NEVER blocked (belt-and-braces,
//    even though `git commit` / `maddu slice-stop` do write).
//  • 'write'  — a recognized DIRECT file write; treated as an edit (subject to
//    discipline). Conservative: obvious writes only.
//  • 'allow'  — read-only, ambiguous (interpreter -e/-c, build steps), or
//    unrecognized → allow ("block obvious writes, fail open on ambiguity").
// NO blanket maddu/git exemption (that would let `maddu upgrade` / `git checkout
// -- .` bypass) — only the exact remedy verbs below.
const REMEDY_RE = [
  // strip a leading launcher (maddu / node …maddu.mjs / ./maddu/run) then match verb
  /(?:^|\s)(?:maddu|node\s+\S*maddu\.mjs|\.\/maddu\/run)\s+(register|session\s+start|lane\s+claim|goal\s+set|plan\s+(?:new|add|add-phase|revise)|slice-stop)\b/,
  /(?:^|\s)git\s+(status|diff|add|commit|log)\b/,
];
const WRITE_RE = [
  />>?\s*(?!\s*(?:&|\d|\/dev\/null))\S/,          // > file / >> file  (not 2>&1, >/dev/null)
  /(?:^|\s)sed\s+(?:-\w*\s+)*-i\b/,                // sed -i
  /(?:^|\s)tee\b/,                                 // tee
  /(?:^|\s)(?:mv|cp|install|rm|dd|truncate)\s/,    // move/copy/install/remove/dd/truncate
  /(?:^|\s)(?:Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Remove-Item)\b/i, // PowerShell
];
export function classifyBashWrite(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return 'allow';
  for (const re of REMEDY_RE) if (re.test(cmd)) return 'remedy';
  for (const re of WRITE_RE) if (re.test(cmd)) return 'write';
  return 'allow'; // read-only / ambiguous interpreter / build / unknown → allow
}

// ── The PURE decision core ──────────────────────────────────────────────────
// state: {
//   session:   { registered:boolean },
//   lane:      { claimed:boolean },
//   goalOrPlan:{ active:boolean },
//   slice:     { ageMin:number|null },        // minutes since last SLICE_STOP (null = none yet)
//   commit:    { newDirtyFiles:number, dirtyAgeMin:number|null, slicedButDirty:boolean },
// }
// counter:  { editsSinceSlice:number, goalplanAgeEdits:number, goalplanAgeMin:number }
// toolCtx:  { isMutating:boolean }   // does this tool actually mutate? (edit tool or classified Bash write)
// Returns { verdict:'ok'|'nudge'|'block', blocker, reason, remedy }.
export function decide({ thresholds, state, counter, toolCtx }) {
  const enf = thresholds.enforcement;
  if (enf === 'off') return ok();
  if (!toolCtx || !toolCtx.isMutating) return ok(); // only gate mutating tools

  const cap = (sev) => (enf === 'nudge' && sev === 'block' ? 'nudge' : sev); // relaxed never blocks
  const edits = counter?.editsSinceSlice || 0;

  // Ordered preconditions: session → lane → goal/plan → slice-stop → commit.
  if (!state.session?.registered) {
    return mk(cap('block'), 'session', 'no active Máddu session governs this work',
      'maddu register');
  }
  if (!state.lane?.claimed) {
    return mk(cap('block'), 'lane', 'editing without a claimed lane (hard rule #8)',
      'maddu lane claim <lane>');
  }
  if (!state.goalOrPlan?.active) {
    const gp = thresholds.goalplan;
    // strict (grace 0) blocks now; graduated blocks after the grace window.
    const over = (counter?.goalplanAgeEdits || 0) >= gp.graceEdits && (counter?.goalplanAgeMin || 0) >= gp.graceMin;
    const sev = (gp.graceEdits === 0 && gp.graceMin === 0) || over ? 'block' : 'warn';
    return mk(cap(sev), 'goal/plan', 'no active goal or open plan governs this work',
      'maddu goal set "<objective>" --success "<cmd>::<cond>"  OR  maddu plan new "<title>" --phases "..."');
  }
  // Slice-stop staleness — never on the first edit of a fresh slice.
  const ss = thresholds.slicestop;
  if (edits > 0 || state.slice?.ageMin != null) {
    const sliceMin = state.slice?.ageMin;
    const blockSlice = edits >= ss.blockEdits || (sliceMin != null && sliceMin >= ss.blockMin);
    const warnSlice  = edits >= ss.warnEdits  || (sliceMin != null && sliceMin >= ss.warnMin);
    if (blockSlice) return mk(cap('block'), 'slice-stop',
      `slice-stop overdue (${edits} edits since the last one)`, 'maddu slice-stop "SLICE STOP: ..."');
    if (warnSlice) return mk(cap('warn'), 'slice-stop',
      `slice-stop getting stale (${edits} edits)`, 'maddu slice-stop "SLICE STOP: ..."');
  }
  // Uncommitted accumulation — count only NEW dirty files this session.
  const uc = thresholds.uncommitted;
  const files = state.commit?.newDirtyFiles || 0;
  const dirtyMin = state.commit?.dirtyAgeMin;
  if (uc.blockIfSlicedButDirty && state.commit?.slicedButDirty) {
    return mk(cap('block'), 'commit', 'work was slice-stopped but is still uncommitted', 'git add -A && git commit');
  }
  const blockCommit = files >= uc.blockFiles || (dirtyMin != null && dirtyMin >= uc.blockMin);
  const warnCommit  = files >= uc.warnFiles  || (dirtyMin != null && dirtyMin >= uc.warnMin);
  if (blockCommit) return mk(cap('block'), 'commit', `uncommitted work piling up (${files} files)`, 'git add -A && git commit');
  if (warnCommit)  return mk(cap('warn'), 'commit', `uncommitted work growing (${files} files)`, 'git add -A && git commit');

  return ok();
}

function ok() { return { verdict: 'ok', blocker: null, reason: null, remedy: null }; }
function mk(verdict, blocker, reason, remedy) { return { verdict, blocker, reason, remedy }; }

// Render a decision into the PreToolUse deny reason (one blocker + its remedy).
export function denyReason(decision) {
  return `Máddu blocked this edit: ${decision.reason}.\nRun:  ${decision.remedy}\nThen retry. (Máddu enforces its own record — see \`maddu doctor\`.)`;
}

// ── Impure config read ──────────────────────────────────────────────────────
export async function readDisciplineConfig(repoRoot, mode) {
  let overrides = {};
  try {
    const p = join(pathsFor(repoRoot).state, 'config', 'discipline.json');
    overrides = JSON.parse(await readFile(p, 'utf8'));
  } catch { /* no override file → defaults */ }
  return resolveThresholds(mode, overrides);
}

// ── Per-session state (counter + Claude→Máddu session binding) ──────────────
// Kept under .maddu/state/discipline/ — a local, best-effort hook cache (NOT the
// spine). Per-session files so concurrent Claude sessions don't clobber each
// other (Codex blocker). Every read/write is fail-safe (errors → empty/no-op).
function disciplineDir(repoRoot) { return join(pathsFor(repoRoot).statePrjDir, 'discipline'); }
function counterPath(repoRoot, sid) { return join(disciplineDir(repoRoot), `${String(sid).replace(/[^\w.-]/g, '_')}.json`); }
function sessionsMapPath(repoRoot) { return join(disciplineDir(repoRoot), 'sessions.json'); }

async function readJson(p, fallback) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } }
async function writeJson(p, obj) {
  try { await mkdir(disciplineDirOf(p), { recursive: true }); await writeFile(p, JSON.stringify(obj, null, 2)); return true; }
  catch { return false; }
}
function disciplineDirOf(filePath) { return filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))); }

export async function readCounter(repoRoot, sid) {
  return readJson(counterPath(repoRoot, sid), { lastSliceStopId: null, editsSinceSlice: 0, dirtyBaseline: [], firstDirtyTs: null, decisions: [] });
}
export async function writeCounter(repoRoot, sid, counter) { return writeJson(counterPath(repoRoot, sid), counter); }

// Bind a Claude Code session id to a Máddu session id (called at SessionStart).
export async function bindClaudeSession(repoRoot, claudeId, madduId) {
  if (!claudeId || !madduId) return false;
  const map = await readJson(sessionsMapPath(repoRoot), {});
  map[claudeId] = { madduId, at: null };
  return writeJson(sessionsMapPath(repoRoot), map);
}
export async function resolveMadduSession(repoRoot, claudeId) {
  if (!claudeId) return null;
  const map = await readJson(sessionsMapPath(repoRoot), {});
  return (map[claudeId] && map[claudeId].madduId) || null;
}

// ── Git dirty-file read (git-exec; excludes .maddu/ bookkeeping) ─────────────
export async function dirtyFiles(repoRoot) {
  try {
    const r = await gitRun(['status', '--porcelain=v1', '-z'], repoRoot, 5000);
    if (r.code !== 0) return [];
    // -z: records are NUL-separated; each record is "XY <path>" (rename adds a
    // second NUL-separated path we don't need for a count).
    const out = [];
    for (const rec of r.stdout.split('\0')) {
      if (!rec) continue;
      const path = rec.slice(3).replace(/\\/g, '/'); // strip "XY " status prefix
      if (!path || path.startsWith('.maddu/') || path === 'maddu.json') continue;
      out.push(path);
    }
    return out;
  } catch { return []; }
}

// ── gatherRitualState — impure; reads the world into decide()'s `state` shape ─
// Fail-safe: any sub-read that throws degrades that ritual to its most-permissive
// value so the overall verdict can only be softened, never falsely hardened.
export async function gatherRitualState(repoRoot, sessionId, nowMs, counter) {
  const [{ project }, plansMod] = await Promise.all([
    import('./projections.mjs'), import('./plans.mjs'),
  ]);
  let proj = {};
  try { proj = await project(repoRoot); } catch { proj = {}; }
  let openPlans = [];
  try { openPlans = (await plansMod.listPlans(repoRoot)).filter((p) => p.status === 'open'); } catch { openPlans = []; }

  const sessions = Array.isArray(proj.activeSessions) ? proj.activeSessions : [];
  const claims = Array.isArray(proj.claims) ? proj.claims : [];
  const stops = Array.isArray(proj.sliceStops) ? proj.sliceStops : [];
  const lastStop = stops.length ? stops[stops.length - 1] : null;
  const goalActive = !!(proj.goal && proj.goal.status === 'active');

  const registered = sessionId ? sessions.some((s) => s.id === sessionId) : sessions.length > 0;
  const claimed = sessionId ? claims.some((c) => c.sessionId === sessionId) : claims.length > 0;

  const dirty = await dirtyFiles(repoRoot);
  const baseline = new Set(Array.isArray(counter?.dirtyBaseline) ? counter.dirtyBaseline : []);
  const newDirty = dirty.filter((p) => !baseline.has(p));
  const sliceAgeMin = lastStop ? Math.max(0, (nowMs - Date.parse(lastStop.ts)) / 60000) : null;
  const slicedButDirty = !!(counter && counter.lastSliceStopId && (counter.editsSinceSlice || 0) === 0 && newDirty.length > 0);

  return {
    session: { registered },
    lane: { claimed },
    goalOrPlan: { active: goalActive || openPlans.length > 0 },
    slice: { ageMin: sliceAgeMin, lastStopId: lastStop ? lastStop.id : null },
    commit: { newDirtyFiles: newDirty.length, dirtyAgeMin: counter?.firstDirtyTs ? Math.max(0, (nowMs - counter.firstDirtyTs) / 60000) : null, slicedButDirty },
    _dirty: dirty,
  };
}

// ── evaluateDiscipline — the wrapper the hooks call. FAILS OPEN. ─────────────
// Resolves session + governance, gathers state, applies decide(). laneJustClaimed
// lets the PreToolUse caller (which auto-claims first) skip a stale "no lane".
export async function evaluateDiscipline(repoRoot, opts = {}) {
  try {
    const { tool, filePath, command, nowMs = 0, laneJustClaimed = false } = opts;
    let sessionId = opts.madduSessionId || null;
    if (!sessionId && opts.claudeSessionId) sessionId = await resolveMadduSession(repoRoot, opts.claudeSessionId);
    if (!sessionId) sessionId = process.env.MADDU_SESSION_ID || null;

    const gov = await import('./governance.mjs');
    const cfg = await gov.readEffectiveGovernance(repoRoot);
    const thresholds = await readDisciplineConfig(repoRoot, cfg.mode);
    thresholds.enforcement = gov.effectiveValue(cfg, 'discipline-enforcement') || thresholds.enforcement;

    // is this tool actually a mutating write?
    let isMutating = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool);
    if (tool === 'Bash') {
      const kind = classifyBashWrite(command);
      if (kind === 'remedy') return ok();          // remedies are never blocked
      isMutating = kind === 'write';
    }
    if (!isMutating) return ok();

    const counter = sessionId ? await readCounter(repoRoot, sessionId) : { editsSinceSlice: 0, dirtyBaseline: [] };
    const state = await gatherRitualState(repoRoot, sessionId, nowMs, counter);
    if (laneJustClaimed) state.lane = { claimed: true };

    return decide({ thresholds, state, counter, toolCtx: { isMutating } });
  } catch {
    return ok(); // FAIL-OPEN: any error → allow
  }
}
