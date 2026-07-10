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

// ── The Bash write-classifier (audit P2: 5-class) ────────────────────────────
// Returns 'write' | 'self-disable' | 'remedy' | 'ambiguous' | 'read'.
//  • 'write'  — a recognized DIRECT file write (redirect, sed -i, tee, mv/cp/rm,
//    PowerShell verb, OR an inline interpreter `-e/-c/-i` whose payload calls a
//    filesystem-write API). Treated as a mutating edit (subject to discipline).
//  • 'self-disable' — a command that turns Máddu's OWN enforcement off
//    (`maddu hooks uninstall/remove`, `governance set-override
//    discipline-enforcement off|nudge`). Gated/witnessed per governance mode.
//  • 'remedy' — an exact ritual-remedy command; NEVER blocked (even though
//    `git commit` / `maddu slice-stop` do write).
//  • 'ambiguous' — an opaque executor with no detected write intent (npm/make/
//    a bare interpreter running a script file). Gated under strict, nudged under
//    standard, allowed under relaxed (see disciplineAction).
//  • 'read'   — read-only / unrecognized (default). Allowed.
// WRITE DOMINATES self-disable so a compound `hooks uninstall && rm -rf x` is
// gated as a write, not waved through as a bare disable. Detection is
// deliberately INCOMPLETE (shell-wrapped / opaque writes fall to read/ambiguous)
// — the real gate for the named CLI disablements is the governance/hooks CLI
// layer (see commands/governance.mjs + commands/hooks.mjs). NO blanket maddu/git
// exemption — only the exact remedy verbs below.
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
// Filesystem-write APIs inside an interpreter payload (node -e / python -c / …).
// A bare `>` is a SHELL redirect signal ONLY (it lives in WRITE_RE above), NEVER
// an interpreter write-signal — `node -e "console.log(2 > 1)"` must stay 'read'
// (audit P2 F12). `open(...)` counts only in write/append mode.
// Require a CALL `(` after each API name so a bare word in a string/comment
// (`console.log('writeFileSync')`) does NOT read as a write. `open(...)` counts
// only with a SECOND quoted-mode arg containing a write-capable flag (w/a/x, or a
// `+` update flag — so r+/rb+/w+b all count, but 'r'/'rb' do not). The comma+quote
// requirement keeps a filename that merely contains w/a/x (`open('file.wax')`) read.
// This heuristic is deliberately INCOMPLETE (see the classifier header): a call
// embedded in a string/comment can still over-classify as write — the SAFE
// direction (an extra nudge under standard), never an under-gate.
const INTERP_WRITE_API_RE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|makedirs|rmdirSync|rmdir|rmtree|rmSync|unlinkSync|unlink|renameSync|rename|truncateSync|truncate|copyFileSync|copyFile|symlinkSync|symlink)\s*\(|\bos\.remove\s*\(|\bshutil\.(?:rmtree|move|copy\w*)\s*\(|\bopen\s*\([^)]*,\s*['"][a-z]*[wax+]/;
// A launcher running INLINE code (-e/-c). Detected on the dequoted code (the flag
// is unquoted); the payload write-API scan runs on the ORIGINAL (quotes→spaces).
const INTERP_INLINE_RE = /(?:^|\s)(?:node|deno|bun|python3?|perl|ruby)\b[^\n]*?\s-[A-Za-z]*[ec]\b/;
// In-place editors always write regardless of payload (perl -i, ruby -i).
const INPLACE_RE = /(?:^|\s)(?:perl|ruby)\b[^\n]*?\s-[A-Za-z]*i\b/;
// A command that disables Máddu's own enforcement.
const SELF_DISABLE_RE = [
  /(?:^|\s)(?:maddu|node\s+\S*maddu\.mjs|\.\/maddu\/run)\s+hooks\s+(?:uninstall|remove)\b/,
  /(?:^|\s)(?:maddu|node\s+\S*maddu\.mjs|\.\/maddu\/run)\s+governance\s+set-override\s+discipline-enforcement\s+(?:off|nudge)\b/,
];
// Opaque executors with no detected write intent — "might write."
const AMBIGUOUS_RE = [
  /(?:^|\s)(?:npm|npx|yarn|pnpm|make|cargo|gradle|mvn)\b/,
  /(?:^|\s)go\s+run\b/,
  /(?:^|\s)(?:node|deno|bun|python3?|perl|ruby)\s+(?!-)\S+/,  // interpreter running a SCRIPT FILE (no -flag)
];

// Blank the CONTENTS of quoted spans so a write token INSIDE a quoted argument
// is not mistaken for a real shell op (the commit trailer `… <email>` carries a
// `>`, a slice-stop message may quote `cat > file`). Real operators live in the
// unquoted code.
function stripQuotedArgs(s) {
  return String(s)
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/'([^'\\]|\\.)*'/g, "''");
}

// Fold shell control operators to spaces so a boundary-anchored `(?:^|\s)` match
// still catches a verb sitting tight against a separator (`uninstall;rm`,
// `x&&maddu …`). `>&`/`&1` redirect fds survive because WRITE_RE's redirect
// pattern already excludes a following digit/`&` (audit P2 F4).
function normalizeSeparators(s) {
  return String(s).replace(/(\|\||&&|[;&|\n])/g, ' ');
}

export function classifyBashWrite(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return 'read';
  const code = normalizeSeparators(stripQuotedArgs(cmd));
  // An UNQUOTED `sh -c`/`bash -c …` runs its argument AS code, so a write hidden
  // there is real — scan the original (quotes→spaces) when such a wrapper is present.
  const execWrapped = /(?:^|\s)(?:ba|da|k|z)?sh\s+-[a-z]*c\b/.test(code);
  const original = normalizeSeparators(cmd.replace(/["']/g, ' '));
  const scanForWrite = execWrapped ? original : code;

  // 1. WRITE dominates — a real write can't ride in on a remedy/self-disable token.
  for (const re of WRITE_RE) if (re.test(scanForWrite)) return 'write';
  if (INPLACE_RE.test(code)) return 'write';
  // Interpreter inline write: the -e/-c FLAG is unquoted (seen in `code`), but the
  // PAYLOAD lives inside quotes — scan it WITH quotes intact (separators folded only)
  // so `open('f','w')` is detectable; a bare `>` is NOT an API (F12).
  if (INTERP_INLINE_RE.test(code) && INTERP_WRITE_API_RE.test(normalizeSeparators(cmd))) return 'write';
  // 2. self-disable (turns enforcement off).
  for (const re of SELF_DISABLE_RE) if (re.test(code)) return 'self-disable';
  // 3. remedy (escape hatch).
  for (const re of REMEDY_RE) if (re.test(code)) return 'remedy';
  // 4. ambiguous opaque executor.
  for (const re of AMBIGUOUS_RE) if (re.test(code)) return 'ambiguous';
  // 5. read (default) — preserves the historic "unknown → allow" behavior.
  return 'read';
}

// Enforcement rank for weakening comparisons (audit P2): a lower rank = weaker,
// so ANY decrease (incl. block→graduated) is a "weakening" that needs a reason /
// approval. Shared by commands/governance.mjs.
export const ENFORCEMENT_RANK = { off: 0, nudge: 1, graduated: 2, block: 3 };

// Pure policy: the classifier's `kind` + effective `enforcement` (+ whether a
// self-disable carries an explicit --approve for the governance off-switch) →
// ONE action the caller acts on. `enforcement:'off'` is orthogonal (handled +
// witnessed at the hook seam), so this is only consulted for block/graduated/nudge.
//   'allow'         — run untouched (read / remedy / relaxed-ambiguous).
//   'nudge'         — run, surface a reminder, emit NO event (standard-ambiguous).
//   'gate'          — subject to the ritual checks (decide with isMutating:true).
//   'block'         — hard deny now (strict self-disable without --approve).
//   'witness-allow' — run, but the seam emits a DISCIPLINE_SKIPPED witness.
export function disciplineAction(kind, enforcement, approvedDisable = false) {
  const strict = enforcement === 'block';
  switch (kind) {
    case 'edit':
    case 'write':       return { action: 'gate' };
    case 'read':
    case 'remedy':      return { action: 'allow' };
    case 'ambiguous':   return { action: strict ? 'gate' : (enforcement === 'graduated' ? 'nudge' : 'allow') };
    case 'self-disable':
      if (approvedDisable) return { action: 'witness-allow' };  // sanctioned disable — record, don't block
      return { action: strict ? 'block' : 'witness-allow' };
    default:            return { action: 'allow' };
  }
}

// True only for the governance off-switch form carrying --approve (F8: the
// --approve exemption is scoped to that exact command, NOT `hooks uninstall`).
export function isApprovedOffSwitch(command) {
  const c = normalizeSeparators(String(command == null ? '' : command));
  return /(?:^|\s)(?:maddu|node\s+\S*maddu\.mjs|\.\/maddu\/run)\s+governance\s+set-override\s+discipline-enforcement\b/.test(c)
    && /(?:^|\s)--approve\b/.test(c);
}

// A stable, path-scrubbed one-line signature of an error, so the seam can latch
// witnesses per DISTINCT error signature (F6/B) without persisting a raw path/secret.
export function normErrorSig(e) {
  const m = e && (e.code || e.message) ? String(e.code || e.message) : String(e);
  return m.split('\n')[0].replace(/[A-Za-z]:\\[^\s]+|\/[^\s/][^\s]*/g, '<path>').slice(0, 120);
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
// The last slice-stop THIS session recorded (by actor), newest last. Pure so the
// per-session accounting is unit-testable: a global last slice-stop must never
// stand in for a session that hasn't stopped, or another session's slice-stop
// would silently reset this one's edit counter.
export function lastOwnSliceStop(stops, sessionId) {
  const list = Array.isArray(stops) ? stops : [];
  if (!sessionId) return null;
  let found = null;
  for (const s of list) if (s && s.actor === sessionId) found = s;
  return found;
}

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
  // Slice-stop freshness is PER SESSION — key on this session's own last
  // slice-stop, not the global last, or another session slice-stopping would
  // reset this session's edit counter (Codex: cross-session counter reset).
  const lastStop = lastOwnSliceStop(stops, sessionId);
  const goalActive = !!(proj.goal && proj.goal.status === 'active');

  // audit P2 C6d: an UNBOUND caller (no sessionId) must NOT inherit "any session /
  // any claim exists = I'm registered/claimed" — it can't prove THIS caller is
  // bound, so it faces the session/lane gate (fail-open still applies downstream).
  const registered = sessionId ? sessions.some((s) => s.id === sessionId) : false;
  const claimed = sessionId ? claims.some((c) => c.sessionId === sessionId) : false;

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
    commit: { newDirtyFiles: newDirty.length, dirtyAgeMin: counter?.firstDirtyTs != null ? Math.max(0, (nowMs - counter.firstDirtyTs) / 60000) : null, slicedButDirty },
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

// ── Pure per-session counter maintenance (reset + time anchors; NO edit bump) ─
// Given the previous counter and freshly-gathered `state`, return the counter to
// evaluate THIS edit against. editsSinceSlice resets to 0 on a new slice-stop id
// (so the first edit of a fresh slice is never over-threshold); firstDirtyTs
// anchors the uncommitted-age clock; goalplanFirstTs/AgeMin track how long work
// has run with no governing goal/plan. The edit-count BUMP happens AFTER decide
// (only for an allowed mutating edit) so decide sees the PRIOR counts — matching
// the locked decide() unit contract (editsSinceSlice:6 → block).
export function nextCounter(prev, state, nowMs) {
  const c = { ...(prev || {}) };
  const curSlice = (state && state.slice && state.slice.lastStopId) || null;
  // Reset ONLY on a real, newer own slice-stop. A null current id means "no own
  // slice-stop observed" — which also happens when this session's last stop is
  // truncated out of the projection's recent-50 window by other sessions — and
  // must NOT reset the counter (Codex: else a busy fleet resets A's count to 0
  // and A dodges the block). Keep the counter's own last id and edit count.
  if (curSlice != null && c.lastSliceStopId !== curSlice) { c.editsSinceSlice = 0; c.lastSliceStopId = curSlice; }
  // uncommitted-age anchor: clear when clean, set on the first dirty observation.
  // `== null` (not `!`) so a legitimate ts of 0 is never treated as unset.
  const newDirty = (state && state.commit && state.commit.newDirtyFiles) || 0;
  if (newDirty === 0) c.firstDirtyTs = null;
  else if (c.firstDirtyTs == null) c.firstDirtyTs = nowMs;
  // goal/plan grace anchor: reset while governed, else keep the clock running.
  if (state && state.goalOrPlan && state.goalOrPlan.active) {
    c.goalplanFirstTs = null; c.goalplanAgeEdits = 0; c.goalplanAgeMin = 0;
  } else {
    if (c.goalplanFirstTs == null) c.goalplanFirstTs = nowMs;
    c.goalplanAgeMin = Math.max(0, (nowMs - c.goalplanFirstTs) / 60000);
    c.goalplanAgeEdits = c.goalplanAgeEdits || 0;
  }
  return c;
}

// ── enforcePreTool — the STATEFUL PreToolUse entry (maintains the per-session
// counter, then decides). FAILS OPEN. Returns { verdict, blocker, reason,
// remedy, sid, mutating, enforcement }. The caller (commands/hooks.mjs) turns
// the verdict into the Claude Code PreToolUse output (deny JSON / additional
// context / none). Unlike evaluateDiscipline (read-only), this PERSISTS the
// post-decide edit bump — a blocked edit never advances the clocks.
export async function enforcePreTool(repoRoot, opts = {}) {
  // Hoisted so the catch can witness with whatever context was resolved (F6).
  let sid = null, counterKey = null, tool = null;
  try {
    ({ tool } = opts);
    const { filePath, command, nowMs = 0, laneJustClaimed = false } = opts;
    sid = opts.madduSessionId || null;
    if (!sid && opts.claudeSessionId) sid = await resolveMadduSession(repoRoot, opts.claudeSessionId);
    if (!sid) sid = process.env.MADDU_SESSION_ID || null;
    // Counter key: the Máddu sid, else a Claude-session-scoped fallback so an
    // unbound-but-Claude-identified agent's slice clock still advances (audit P2 C6d,
    // Q4 — NOT a shared bucket). Truly anonymous → no persistence.
    counterKey = sid || (opts.claudeSessionId ? `claude:${opts.claudeSessionId}` : null);

    // Classify → kind. Edit-family always mutates; Bash routes through the 5-class
    // classifier. Remedies + reads short-circuit (never gated, never witnessed).
    let kind, approvedDisable = false;
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) kind = 'edit';
    else if (tool === 'Bash') {
      kind = classifyBashWrite(command);
      approvedDisable = kind === 'self-disable' && isApprovedOffSwitch(command);
    } else kind = 'read';
    if (kind === 'read' || kind === 'remedy')
      return { ...ok(), sid, counterKey, mutating: false, enforcement: 'n/a', kind, action: 'allow' };

    const gov = await import('./governance.mjs');
    const cfg = await gov.readEffectiveGovernance(repoRoot);
    const thresholds = await readDisciplineConfig(repoRoot, cfg.mode);
    thresholds.enforcement = gov.effectiveValue(cfg, 'discipline-enforcement') || thresholds.enforcement;
    const enforcement = thresholds.enforcement;

    const action = disciplineAction(kind, enforcement, approvedDisable).action;

    // enforcement OFF: allow, but tell the seam this was a would-be-gated tool so
    // it emits DISCIPLINE_SKIPPED{enforcement-off}. PRESERVE a self-disable so the
    // seam still emits the per-incident self-disable witness (not the latched
    // enforcement-off one) even while enforcement is off.
    if (enforcement === 'off')
      return { ...ok(), sid, counterKey, mutating: true, enforcement: 'off', kind,
        action: kind === 'self-disable' ? 'witness-allow' : 'allow' };

    // strict self-disable without --approve → hard block (full shape for denyReason).
    if (action === 'block')
      return { ...mk('block', 'self-disable',
        'disabling Máddu enforcement requires operator approval',
        'maddu governance set-override discipline-enforcement off --reason "<why>" --approve'),
        sid, counterKey, mutating: true, enforcement, kind, action };

    // self-disable that is allowed (non-strict, or --approve) → run + witness.
    if (action === 'witness-allow')
      return { ...ok(), sid, counterKey, mutating: false, enforcement, kind, action };

    // ambiguous under standard → surface a nudge, no event, no block.
    if (action === 'nudge')
      return { verdict: 'nudge', blocker: 'ambiguous',
        reason: 'an opaque command that may write ran without a discipline check',
        remedy: 'run under a claimed lane / declare intent, or slice-stop if work is piling up',
        sid, counterKey, mutating: false, enforcement, kind, action };

    if (action !== 'gate')
      return { ...ok(), sid, counterKey, mutating: false, enforcement, kind, action };

    // action === 'gate' → the ritual path (decide's locked contract, unchanged).
    const prev = counterKey ? await readCounter(repoRoot, counterKey) : { editsSinceSlice: 0, dirtyBaseline: [] };
    const state = await gatherRitualState(repoRoot, sid, nowMs, prev);
    if (laneJustClaimed) state.lane = { claimed: true };
    const counter = nextCounter(prev, state, nowMs);
    // Recompute state fields that depend on the just-maintained counter (a fresh
    // slice-stop resets editsSinceSlice to 0 → "slice-stopped but still dirty" only
    // becomes true here).
    state.commit.dirtyAgeMin = counter.firstDirtyTs != null ? Math.max(0, (nowMs - counter.firstDirtyTs) / 60000) : null;
    state.commit.slicedButDirty = !!(counter.lastSliceStopId && (counter.editsSinceSlice || 0) === 0 && (state.commit.newDirtyFiles || 0) > 0);

    const decision = decide({ thresholds, state, counter, toolCtx: { isMutating: true } });

    // Persist. Bump the edit clocks ONLY for an allowed edit; on a HEALTHY eval
    // clear any skip-witness latch (F6 — the next off/error episode re-emits).
    if (counterKey) {
      if (decision.verdict !== 'block') {
        counter.editsSinceSlice = (counter.editsSinceSlice || 0) + 1;
        if (!(state.goalOrPlan && state.goalOrPlan.active)) counter.goalplanAgeEdits = (counter.goalplanAgeEdits || 0) + 1;
      }
      // Reaching the gate path at all means enforcement is ON and not erroring —
      // a healthy episode — so clear any enforcement-off/error latch regardless of
      // the ritual verdict (block/nudge/warn are still "enforcement working").
      if (counter.skipLatch) counter.skipLatch = {};
      await writeCounter(repoRoot, counterKey, counter);
    }
    return { ...decision, sid, counterKey, mutating: true, enforcement, kind, action };
  } catch (e) {
    // FAIL-OPEN, but hand the seam a signature so it can witness ENFORCEMENT_ERROR.
    return { ...ok(), sid, counterKey, tool, mutating: false, enforcement: 'error', kind: null, action: 'allow', errorSig: normErrorSig(e) };
  }
}
