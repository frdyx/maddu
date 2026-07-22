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
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { pathsFor } from './paths.mjs';
import { gitRun } from './git-exec.mjs';
import { withAppendLock } from './append-lock.mjs';

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
// v1.111.0: the override ROOT is normalized (valid-JSON `null`/arrays/scalars
// → {}), and `uncommitted.ignore` is normalized to an array of strings —
// anything else → []. The ignore knob lives in the SAME operator file as the
// warn/block thresholds, so it adds no new bypass class.
export function resolveThresholds(mode, overrides = {}) {
  const o = (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) ? overrides : {};
  const base = DISCIPLINE_DEFAULTS[mode] || DISCIPLINE_DEFAULTS.standard;
  const section = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const merged = {
    enforcement: o.enforcement || base.enforcement,
    slicestop:   { ...base.slicestop,   ...section(o.slicestop) },
    uncommitted: { ...base.uncommitted, ...section(o.uncommitted) },
    goalplan:    { ...base.goalplan,    ...section(o.goalplan) },
  };
  const rawIgnore = merged.uncommitted.ignore;
  merged.uncommitted.ignore = Array.isArray(rawIgnore)
    ? rawIgnore.filter((g) => typeof g === 'string' && g.length > 0)
    : [];
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
      'restart this session so the SessionStart hook binds it (an unbound running session — e.g. after a mid-session hooks install/upgrade — cannot be healed from the CLI: the hook never inherits an exported MADDU_SESSION_ID). If no Máddu session exists at all, run `maddu register` first.');
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
// v1.111.0: ENOENT (no file) means defaults and NORMAL gating; a
// present-but-unreadable/unparseable file sets `configInvalid: true`, which
// gatherRitualState maps to the unknown-observation path (commit pressure
// fails OPEN — a broken operator config must never silently count more
// files). The invalid content is never echoed.
export async function readDisciplineConfig(repoRoot, mode) {
  let overrides = {};
  let configInvalid = false;
  try {
    const p = join(pathsFor(repoRoot).state, 'config', 'discipline.json');
    let raw = null;
    try { raw = await readFile(p, 'utf8'); }
    catch (e) { if (!e || e.code !== 'ENOENT') configInvalid = true; raw = null; }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) overrides = parsed;
        else configInvalid = true;
      } catch { configInvalid = true; }
    }
  } catch { configInvalid = true; }
  const thresholds = resolveThresholds(mode, overrides);
  thresholds.configInvalid = configInvalid;
  return thresholds;
}

// ── Scratch-ignore globs (v1.111.0) ─────────────────────────────────────────
// globToRegExp: `*` is segment-local, `**` crosses `/`, `?` is one non-`/`
// char; anchored both ends; matches the forward-slash relative paths git
// emits. Compiled independently per glob inside try/catch — one bad glob is
// dropped, siblings still apply. Returns null for non-strings/empties/errors.
export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.length === 0) return null;
  try {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          // `**` (optionally followed by `/`) — crosses segments.
          i++;
          if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; }
          else re += '.*';
        } else {
          re += '[^/]*';
        }
      } else if (c === '?') {
        re += '[^/]';
      } else if ('\\^$.|+()[]{}'.includes(c)) {
        re += '\\' + c;
      } else {
        re += c;
      }
    }
    return new RegExp(`^${re}$`);
  } catch { return null; }
}

// Paths NOT matched by any glob. Non-array/empty globs → identity.
export function filterIgnored(paths, globs) {
  const list = Array.isArray(paths) ? paths : [];
  const res = (Array.isArray(globs) ? globs : []).map(globToRegExp).filter(Boolean);
  if (res.length === 0) return list;
  return list.filter((p) => !res.some((re) => re.test(p)));
}

// ── Per-session state (counter + Claude→Máddu session binding) ──────────────
// Kept under .maddu/state/discipline/ — a local, best-effort hook cache (NOT the
// spine). Per-session files so concurrent Claude sessions don't clobber each
// other (Codex blocker). Every read/write is fail-safe (errors → empty/no-op).
// Best-effort wait for the sessions-map lock. Binding is non-fatal, so a genuinely
// stuck holder must not hang session start — time out and skip rather than block.
const BIND_LOCK_WAIT_MS = 2000;
const COUNTER_LOCK_WAIT_MS = 2000;
function disciplineDir(repoRoot) { return join(pathsFor(repoRoot).statePrjDir, 'discipline'); }
// v1.111.0 counter store: files live in a VERSIONED SUBDIRECTORY with
// hex-encoded, namespace-prefixed names.
//   • hex is injective AND case-neutral on the case-insensitive target
//     filesystem (a literal `sid.<sid>` would collide ses_A with ses_a);
//   • distinct `sid.` / `cla.` prefixes make the sid vs claude-fallback
//     namespaces injective (the legacy sanitizer collapsed `claude:a` and
//     `claude_a` onto one file);
//   • the SUBDIRECTORY physically separates the new layout from legacy flat
//     files — arbitrary historical explicit ids could occupy any flat-dir
//     name the hex scheme assigns. Nothing under the flat dir is read again;
//     legacy counters are inert and every counter restarts once at upgrade
//     (fail-open via baseline-initialization).
function counterDirV2(repoRoot) { return join(disciplineDir(repoRoot), 'v2'); }
function hexKey(s) {
  const str = String(s);
  if (str.length <= 96) return Buffer.from(str, 'utf8').toString('hex');
  const head = Buffer.from(str.slice(0, 96), 'utf8').toString('hex');
  const suffix = createHash('sha256').update(str, 'utf8').digest('hex').slice(0, 16);
  return `${head}.${suffix}`;
}
function counterPath(repoRoot, key) {
  const k = String(key);
  const name = k.startsWith('claude:') ? `cla.${hexKey(k.slice(7))}` : `sid.${hexKey(k)}`;
  return join(counterDirV2(repoRoot), `${name}.json`);
}
// The LEGACY flat path for the same key — used ONLY to stat for
// interlude detection (a v1 rollback writes here; the v2 counter records
// what it last observed and any drift forces reinitialization).
function legacyCounterPath(repoRoot, key) {
  return join(disciplineDir(repoRoot), `${String(key).replace(/[^\w.-]/g, '_')}.json`);
}
function sessionsMapPath(repoRoot) { return join(disciplineDir(repoRoot), 'sessions.json'); }

async function readJson(p, fallback) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } }
// STRICT map read for the read-modify-write bind: ONLY a missing file means
// "empty" (a legitimate first bind). A present-but-corrupt/unreadable file
// PROPAGATES — the caller's catch turns it into a false return, leaving the
// bad file untouched, so a malformed sessions.json is never silently replaced
// by a singleton map that drops every surviving binding (Codex).
async function readSessionsMapStrict(p) {
  let raw;
  try { raw = await readFile(p, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return {}; throw e; }
  const parsed = JSON.parse(raw); // parse error → throw → caller returns false (no clobber)
  // Must be a plain string-keyed object. A valid-but-wrong shape (array / scalar /
  // null) would lose the binding on re-serialize, so reject it too — the caller's
  // catch turns it into false and the odd file is left untouched (Codex).
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('sessions.json is not a JSON object');
  }
  return parsed;
}
async function writeJson(p, obj) {
  try {
    await mkdir(disciplineDirOf(p), { recursive: true });
    // Atomic replace (UNIQUE temp + rename — a shared temp name lets two
    // concurrent writers consume each other's file) so a lock-free reader
    // never observes a torn half-written file while a writer is mid-update.
    const tmp = `${p}.tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, JSON.stringify(obj, null, 2));
    await rename(tmp, p);
    return true;
  } catch { return false; }
}
function disciplineDirOf(filePath) { return filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))); }

const COUNTER_DEFAULT = () => ({ lastSliceStopId: null, editsSinceSlice: 0, dirtyBaseline: [], firstDirtyTs: null, decisions: [] });

async function statSig(p) {
  try { const s = await stat(p); return { mtimeMs: s.mtimeMs, size: s.size }; }
  catch { return null; }
}
function sameSig(a, b) {
  if (a === null && b === null) return true;
  return !!(a && b && a.mtimeMs === b.mtimeMs && a.size === b.size);
}

// Read-time reconciliation (v1.111.0):
//   • dirtyV/map/scalar consistency — a rollback interlude ran old code that
//     maintained only the scalar; when map and scalar disagree, THE SCALAR
//     WINS (drop the stale map; the legacy-migration path in nextCounter
//     re-seeds from it). An adds-only interlude is undetectable by
//     construction (documented residual; understates age — fail-open).
//   • legacy-interlude detection — the v2 counter records the legacy flat
//     file's stat AS OBSERVED at its last write (`legacySeen`); ANY drift of
//     the CURRENT stat from that recorded observation (or a persisted
//     `legacyDrift` alarm from a post-write re-stat) means a v1 interlude ran
//     → strip `baselineInit` so the next evaluation re-initializes
//     (fail-open discard of the clocks).
async function reconcileCounter(repoRoot, key, c) {
  if (!c || typeof c !== 'object') return COUNTER_DEFAULT();
  const out = { ...c };
  // ANY array is reconciled — an EMPTY map beside a finite scalar is exactly
  // the rollback-desync shape (v1 cleared the paths but v2's empty map would
  // read as authoritative and re-seed dirty paths at "now", losing the
  // preserved age).
  const mapPresent = Array.isArray(out.dirtyFirstSeen);
  if (mapPresent) {
    let min = Infinity;
    let wellFormed = out.dirtyV === 2;
    for (const pair of out.dirtyFirstSeen) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !Number.isFinite(pair[1])) { wellFormed = false; break; }
      if (pair[1] < min) min = pair[1];
    }
    const scalarMatches = wellFormed && ((out.firstDirtyTs == null && out.dirtyFirstSeen.length === 0)
      || (Number.isFinite(out.firstDirtyTs) && out.firstDirtyTs === min));
    if (!wellFormed || !scalarMatches) {
      // Scalar wins: discard the stale/malformed map; nextCounter's legacy
      // migration re-seeds from firstDirtyTs.
      delete out.dirtyFirstSeen;
      delete out.dirtyV;
    }
  }
  // Legacy-interlude detection against the RECORDED observation. The drift
  // alarm is CONSUMED whenever it fires — even when the counter had no
  // baselineInit to strip (e.g. a witness-created counter): leaving it set
  // would force a SECOND initialization on a later read, silently absorbing
  // files dirtied in between into the baseline (never aged).
  try {
    const cur = await statSig(legacyCounterPath(repoRoot, key));
    const recorded = (out.legacySeen && typeof out.legacySeen === 'object') ? out.legacySeen : null;
    const drifted = out.legacyDrift === true || !sameSig(cur, recorded);
    if (drifted) {
      delete out.baselineInit;   // forces a baseline-initialization evaluation
      delete out.legacyDrift;
    }
  } catch { /* stat failure → leave as-is (fail-open either way) */ }
  return out;
}

// Detailed read: { counter, meta: { existed, readOk } } — file-absent vs
// read-and-parsed vs present-but-unreadable are distinguished so callers
// never guess from counter content.
export async function readCounterDetailed(repoRoot, key) {
  let raw = null;
  let existed = true;
  try { raw = await readFile(counterPath(repoRoot, key), 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') existed = false; else return { counter: COUNTER_DEFAULT(), meta: { existed: true, readOk: false } }; }
  if (!existed) return { counter: COUNTER_DEFAULT(), meta: { existed: false, readOk: false } };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* malformed */ }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { counter: COUNTER_DEFAULT(), meta: { existed: true, readOk: false } };
  }
  const counter = await reconcileCounter(repoRoot, key, { ...COUNTER_DEFAULT(), ...parsed });
  return { counter, meta: { existed: true, readOk: true } };
}

export async function readCounter(repoRoot, sid) {
  const { counter } = await readCounterDetailed(repoRoot, sid);
  return counter;
}
// Legacy-compat direct write (kept for older callers; new writers use
// mutateCounter). Writes the v2 path with a unique temp.
export async function writeCounter(repoRoot, sid, counter) { return writeJson(counterPath(repoRoot, sid), counter); }

// ── mutateCounter — THE locked counter transaction (v1.111.0) ───────────────
// Every counter writer routes through here: mkdir BEFORE lock acquisition
// (the lock opens its path directly), read + reconcile INSIDE the lock,
// fn(counter, meta) → write with a unique temp, then a POST-WRITE legacy
// re-stat: if the legacy flat file changed between the pre-read observation
// and now, persist `legacyDrift: true` (an alarm the next read consumes —
// NEVER re-record the newer stat, which would mask exactly the interlude
// the mechanism exists to catch). Lock failure → NO write, returns null;
// the caller proceeds fail-open with its read-only counter.
export async function mutateCounter(repoRoot, key, fn) {
  const p = counterPath(repoRoot, key);
  try {
    await mkdir(counterDirV2(repoRoot), { recursive: true });
    return await withAppendLock(p + '.lock', async () => {
      const preSig = await statSig(legacyCounterPath(repoRoot, key));
      const { counter, meta } = await readCounterDetailed(repoRoot, key);
      const next = (await fn(counter, meta)) || counter;
      next.legacySeen = preSig;
      // Persistence must be REAL to report success: a failed atomic write
      // returns null so the caller falls to its transient fail-open path
      // instead of believing an in-memory-only counter was persisted.
      if (!(await writeJson(p, next))) return null;
      const postSig = await statSig(legacyCounterPath(repoRoot, key));
      if (!sameSig(preSig, postSig)) {
        // Drift alarm. If THIS write fails, the alarm still self-corrects:
        // the persisted legacySeen is the PRE-drift signature, so the next
        // read's stat comparison detects the drift regardless.
        next.legacyDrift = true;
        await writeJson(p, next);
      }
      return next;
    }, { maxWaitMs: COUNTER_LOCK_WAIT_MS });
  } catch {
    return null;
  }
}

// Bind a Claude Code session id to a Máddu session id (called at SessionStart).
// Serialized under a per-repo advisory lock: the read-modify-write MUST be atomic
// or two concurrent SessionStarts (e.g. the long-lived bridge + a CLI invocation)
// can each read the same map, add their own key, and clobber the other's mapping
// (Codex). The lock's O_EXCL create needs the discipline dir to exist first (a
// first-ever bind has none), so mkdir precedes it. Best-effort: a lock timeout or
// IO error yields false — the caller treats binding as non-fatal — rather than
// hanging session start behind a genuinely stuck holder.
export async function bindClaudeSession(repoRoot, claudeId, madduId) {
  if (!claudeId || !madduId) return false;
  const res = await withBindingTransaction(repoRoot, () => bindClaudeSessionIn(repoRoot, claudeId, madduId));
  return res === true;
}

// ── Binding transactions (v1.111.0) ─────────────────────────────────────────
// withBindingTransaction holds the claude-binding lock for the WHOLE of fn
// (the advisory lock is NOT re-entrant, so fn must use only the unlocked
// `…In` helpers below — never the public self-locking forms). Lock order:
// binding lock OUTER, the session-close lock may nest INSIDE fn, the pointer
// lock is leaf-only. Returns fn's result, or BINDING_LOCK_FAILED when the
// lock cannot be acquired (callers fall back — a busy lock must never lose a
// SessionStart).
const BINDING_LOCK_FAILED = Symbol('binding-lock-failed');
export function isBindingLockFailed(v) { return v === BINDING_LOCK_FAILED; }
export async function withBindingTransaction(repoRoot, fn) {
  const mapPath = sessionsMapPath(repoRoot);
  // The sentinel means ACQUISITION failure only — a callback exception
  // PROPAGATES (an operational failure inside the transaction must never
  // masquerade as binding contention, or the caller's contention fallback
  // would re-attempt work the transaction already partially did).
  try {
    await mkdir(disciplineDir(repoRoot), { recursive: true });
  } catch {
    return BINDING_LOCK_FAILED;
  }
  let cbThrew = false, cbError;
  let result;
  try {
    result = await withAppendLock(mapPath + '.lock', async () => {
      // Boolean-tracked (not value-truthiness): `throw null` / `throw
      // undefined` / `Promise.reject()` must propagate too.
      try { return await fn(); } catch (e) { cbThrew = true; cbError = e; return undefined; }
    }, { maxWaitMs: BIND_LOCK_WAIT_MS });
  } catch {
    return BINDING_LOCK_FAILED;   // acquisition/timeout only — fn never ran
  }
  if (cbThrew) throw cbError;
  return result;
}

// Unlocked inner bind — caller MUST hold the binding lock. `boundAt` is real
// (epoch ms): the session-end rebind-freshness guard keys on it.
export async function bindClaudeSessionIn(repoRoot, claudeId, madduId, boundAt = Date.now()) {
  if (!claudeId || !madduId) return false;
  const mapPath = sessionsMapPath(repoRoot);
  try {
    const map = await readSessionsMapStrict(mapPath);   // corrupt → throw → false (no clobber)
    map[claudeId] = { madduId, at: boundAt };
    return writeJson(mapPath, map);
  } catch { return false; }
}

// Unlocked inner unbind — caller MUST hold the binding lock. Deletes the
// entry only if it still maps to `madduId` (compare-and-remove).
export async function unbindClaudeSessionIn(repoRoot, claudeId, madduId) {
  if (!claudeId || !madduId) return false;
  const mapPath = sessionsMapPath(repoRoot);
  try {
    const map = await readSessionsMapStrict(mapPath);
    if (!map[claudeId] || map[claudeId].madduId !== madduId) return false;
    delete map[claudeId];
    return writeJson(mapPath, map);
  } catch { return false; }
}

export async function resolveMadduSession(repoRoot, claudeId) {
  if (!claudeId) return null;
  const map = await readJson(sessionsMapPath(repoRoot), {});
  return (map[claudeId] && map[claudeId].madduId) || null;
}

// Binding with its timestamp — { madduId, boundAt } | null. Lock-free
// (advisory consumers); the END path re-reads INSIDE its binding
// transaction via resolveClaudeBindingIn.
export async function resolveClaudeBinding(repoRoot, claudeId) {
  return resolveClaudeBindingIn(repoRoot, claudeId);
}
export async function resolveClaudeBindingIn(repoRoot, claudeId) {
  if (!claudeId) return null;
  const map = await readJson(sessionsMapPath(repoRoot), {});
  const e = map[claudeId];
  if (!e || typeof e.madduId !== 'string' || e.madduId.length === 0) return null;
  return { madduId: e.madduId, boundAt: Number.isFinite(e.at) ? e.at : null };
}

// ── Git dirty-file read (git-exec; excludes .maddu/ bookkeeping) ─────────────
// v1.111.0: `dirtyFilesDetailed(workRoot)` is the full observation —
//   { ok, paths, renames } where:
//   • ok=false on nonzero exit / timeout / exception (today those collapsed
//     to [] which reads as "genuinely clean" and would erase the age map);
//   • rename/copy records are parsed CORRECTLY: `-z` emits `XY to\0from\0`
//     for R/C statuses — the old loop slice(3)'d the bare `from` record into
//     a bogus path;
//   • renames maps to → { from, kind: 'R'|'C' }; clock transfer is R-only
//     (a copy's source never left the dirty set in the rename sense — a
//     transferred clock would age a just-created file).
// `dirtyFiles` keeps its legacy shape ([] on failure) for count-only callers.
export async function dirtyFilesDetailed(workRoot) {
  // A null/absent work root is an UNKNOWN observation — Node would treat
  // `cwd: null` as the process cwd, silently measuring the WRONG checkout.
  if (typeof workRoot !== 'string' || workRoot.length === 0) {
    return { ok: false, paths: [], renames: new Map() };
  }
  try {
    const r = await gitRun(['status', '--porcelain=v1', '-z'], workRoot, 5000);
    if (r.code !== 0) return { ok: false, paths: [], renames: new Map() };
    const paths = [];
    const renames = new Map();
    const recs = r.stdout.split('\0');
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (!rec) continue;
      const status = rec.slice(0, 2);
      const path = rec.slice(3).replace(/\\/g, '/');
      let from = null;
      const kind = /R/.test(status) ? 'R' : (/C/.test(status) ? 'C' : null);
      if (kind) {
        // Consume the following record: the rename/copy SOURCE path.
        i++;
        from = (recs[i] || '').replace(/\\/g, '/') || null;
      }
      if (!path || path.startsWith('.maddu/') || path === 'maddu.json') continue;
      paths.push(path);
      if (kind && from) renames.set(path, { from, kind });
    }
    return { ok: true, paths, renames };
  } catch { return { ok: false, paths: [], renames: new Map() }; }
}

export async function dirtyFiles(repoRoot) {
  const d = await dirtyFilesDetailed(repoRoot);
  return d.paths;
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

// workRoot: undefined -> repoRoot (repository-scoped callers); NULL -> the
// caller could not resolve a work root, so the observation is UNKNOWN
// (observed:false) rather than silently measured against the wrong repo.
export async function gatherRitualState(repoRoot, sessionId, nowMs, counter, { workRoot = repoRoot } = {}) {
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
  const sliceAgeMin = lastStop ? Math.max(0, (nowMs - Date.parse(lastStop.ts)) / 60000) : null;

  // v1.111.0 commit observation. The ignore config is loaded HERE so every
  // call site (hooks, evaluateDiscipline, enforcePreTool, the doctor gate)
  // inherits it with no threading; the mode-independent parts (ignore list,
  // configInvalid) are all we need — 'standard' is a fine mode key.
  let ignore = [];
  let configInvalid = false;
  try {
    const cfgT = await readDisciplineConfig(repoRoot, 'standard');
    ignore = cfgT.uncommitted.ignore || [];
    configInvalid = !!cfgT.configInvalid;
  } catch { configInvalid = true; }

  const obs = workRoot ? await dirtyFilesDetailed(workRoot) : { ok: false, paths: [], renames: new Map() };
  const observed = obs.ok && !configInvalid;
  const rawDirty = obs.paths;
  const currentDirtyPaths = observed ? filterIgnored(rawDirty, ignore) : [];

  // Observation-domain change (worktree switch) is recognized BEFORE the
  // baseline diff — the transition call must never block on a new root's
  // pre-existing dirt. An ABSENT counter.workRoot ADOPTS silently (legacy
  // counters, first observation) — only present-and-different resets.
  const domainChanged = !!(observed && counter && typeof counter.workRoot === 'string'
    && counter.workRoot.length > 0 && counter.workRoot !== workRoot);
  // Baseline-initialization evaluation: no PERSISTED init marker means no
  // baseline was ever seeded for this counter (fresh session whose
  // session-start write failed, corrupt counter discarded, legacy pre-v2
  // counter, or a witness-created latch file) — commit pressure is
  // suppressed and the next locked mutation seeds the baseline.
  const needsBaselineInit = !!(observed && !(counter && counter.baselineInit === true));

  const baseline = new Set(Array.isArray(counter?.dirtyBaseline) ? counter.dirtyBaseline : []);
  const suppressed = !observed || domainChanged || needsBaselineInit;
  const newDirtyPaths = suppressed ? [] : currentDirtyPaths.filter((p) => !baseline.has(p));
  const dirtyAgeMin = (!suppressed && counter?.firstDirtyTs != null)
    ? Math.max(0, (nowMs - counter.firstDirtyTs) / 60000) : null;
  const slicedButDirty = !suppressed
    && !!(counter && counter.lastSliceStopId && (counter.editsSinceSlice || 0) === 0 && newDirtyPaths.length > 0);

  return {
    session: { registered },
    lane: { claimed },
    goalOrPlan: { active: goalActive || openPlans.length > 0 },
    slice: { ageMin: sliceAgeMin, lastStopId: lastStop ? lastStop.id : null },
    commit: {
      newDirtyFiles: newDirtyPaths.length,
      newDirtyPaths,
      currentDirtyPaths,
      workRoot,
      renames: obs.renames,
      observed,
      domainChanged,
      needsBaselineInit,
      dirtyAgeMin,
      slicedButDirty,
    },
    _dirty: rawDirty,
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
    // Final-sid validation (the whole resolution chain — opts, binding, env):
    // a nonconforming id (legacy corrupt binding, bare-flag boolean) never
    // acts as a session identity.
    if (!refIdOk(sessionId)) sessionId = null;

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
    // undefined = repository-scoped caller (observe the repo we were given);
    // explicit null = the hook could not resolve a work root (observed:false).
    const state = await gatherRitualState(repoRoot, sessionId, nowMs, counter, { workRoot: opts.workRoot === undefined ? repoRoot : opts.workRoot });
    if (laneJustClaimed) state.lane = { claimed: true };

    return decide({ thresholds, state, counter, toolCtx: { isMutating } });
  } catch {
    return ok(); // FAIL-OPEN: any error → allow
  }
}

// Typed reference-grammar predicate, local so discipline.mjs stays a leaf
// (no import from spine.mjs — matches spine's SID_REF_RE exactly).
const REF_ID_RE = /^[\w.-]{1,128}$/;
function refIdOk(v) { return typeof v === 'string' && REF_ID_RE.test(v); }
const CLAUDE_ID_RE_LOCAL = /^[\w-]{1,64}$/;
function claudeIdOk(v) { return typeof v === 'string' && CLAUDE_ID_RE_LOCAL.test(v); }

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
  // goal/plan grace anchor: reset while governed, else keep the clock running.
  // Runs UNCONDITIONALLY (even on an unobserved commit state) — skipping it
  // would let a transient git failure keep a stale edit count past a fresh
  // slice-stop and wrongly deny the next edit.
  if (state && state.goalOrPlan && state.goalOrPlan.active) {
    c.goalplanFirstTs = null; c.goalplanAgeEdits = 0; c.goalplanAgeMin = 0;
  } else {
    if (c.goalplanFirstTs == null) c.goalplanFirstTs = nowMs;
    c.goalplanAgeMin = Math.max(0, (nowMs - c.goalplanFirstTs) / 60000);
    c.goalplanAgeEdits = c.goalplanAgeEdits || 0;
  }

  // ── Dirty reconciliation (v1.111.0) — SKIPPED when observation is unknown
  // (git failure / invalid config): clocks, baseline, and map are preserved
  // untouched; only the slice/goalplan maintenance above ran.
  const commit = state && state.commit;
  if (!commit || commit.observed === false) return c;

  const current = Array.isArray(commit.currentDirtyPaths) ? commit.currentDirtyPaths : [];
  const currentSet = new Set(current);

  // Observation-domain change (worktree switch): re-baseline in the new
  // root, CLEAR the clocks (never transfer an age across checkouts), stamp.
  if (commit.domainChanged) {
    c.workRoot = commit.workRoot;
    c.dirtyBaseline = current.slice();
    c.dirtyFirstSeen = [];
    c.firstDirtyTs = null;
    c.dirtyV = 2;
    return c;
  }
  // Baseline initialization: seed from the FULL filtered dirty list with
  // empty clocks; the persisted marker is what un-suppresses commit
  // pressure from the next evaluation on.
  if (commit.needsBaselineInit) {
    c.workRoot = commit.workRoot;
    c.dirtyBaseline = current.slice();
    c.dirtyFirstSeen = [];
    c.firstDirtyTs = null;
    c.baselineInit = true;
    c.dirtyV = 2;
    return c;
  }
  // Absent workRoot ADOPTS the observed root without clearing anything
  // (pre-v2 counter migration — continuation history preserved).
  if (typeof c.workRoot !== 'string' || c.workRoot.length === 0) c.workRoot = commit.workRoot;

  // Baseline retirement: a baseline path that went clean retires — if it is
  // later re-dirtied it counts as NEW work with a fresh clock (previously it
  // was excluded forever).
  const baseline = Array.isArray(c.dirtyBaseline) ? c.dirtyBaseline : [];
  c.dirtyBaseline = baseline.filter((p) => currentSet.has(p));

  const newDirtyPaths = Array.isArray(commit.newDirtyPaths) ? commit.newDirtyPaths : [];
  const newSet = new Set(newDirtyPaths);

  // Per-file first-seen clocks, stored as an ARRAY OF [path, tsMs] PAIRS
  // (object keys would invite __proto__ hazards). Legacy migration: a
  // counter with a scalar firstDirtyTs but no valid map seeds every current
  // new-dirty path at that scalar (preserves the old age on upgrade).
  let seen = new Map();
  const mapValid = c.dirtyV === 2 && Array.isArray(c.dirtyFirstSeen)
    && c.dirtyFirstSeen.every((pair) => Array.isArray(pair) && typeof pair[0] === 'string' && Number.isFinite(pair[1]));
  if (mapValid) {
    for (const pair of c.dirtyFirstSeen) seen.set(pair[0], pair[1]);
  } else if (c.firstDirtyTs != null) {
    // Legacy/malformed map → migrate from the scalar (seed every current
    // new-dirty path at the preserved firstDirtyTs).
    for (const p of newDirtyPaths) seen.set(p, c.firstDirtyTs);
  }
  // Snapshot rename sources BEFORE pruning (transfer decisions need the
  // pre-prune timestamps).
  const renames = commit.renames instanceof Map ? commit.renames : new Map();
  const sourceTs = new Map();
  for (const [to, meta] of renames) {
    if (meta && meta.kind === 'R' && typeof meta.from === 'string' && seen.has(meta.from)) {
      sourceTs.set(to, seen.get(meta.from));
    }
  }
  // Prune entries no longer new-dirty; add missing at nowMs.
  for (const p of Array.from(seen.keys())) { if (!newSet.has(p)) seen.delete(p); }
  for (const p of newDirtyPaths) { if (!seen.has(p)) seen.set(p, nowMs); }
  // RENAME clock transfer (R-only, never C): only when the source actually
  // LEFT the dirty set this round — a copy's still-dirty source keeps its
  // own clock and the copy seeds fresh.
  for (const [to, ts] of sourceTs) {
    const meta = renames.get(to);
    if (meta && !currentSet.has(meta.from) && seen.has(to)) seen.set(to, ts);
  }
  c.dirtyFirstSeen = Array.from(seen.entries());
  // Keep the legacy scalar = min(map) so read-only consumers that never run
  // nextCounter keep working with no migration of their own.
  c.firstDirtyTs = seen.size ? Math.min(...seen.values()) : null;
  c.dirtyV = 2;
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
    // Final-sid validation AFTER the whole resolution chain (opts, stored
    // binding, env) — a legacy nonconforming binding or a bare-flag boolean
    // must never reach the counter-key namespace (v1.111.0).
    if (!refIdOk(sid)) sid = null;
    // Counter key: the Máddu sid, else a Claude-session-scoped fallback so an
    // unbound-but-Claude-identified agent's slice clock still advances (audit P2 C6d,
    // Q4 — NOT a shared bucket). The claude id is grammar-gated too. Truly
    // anonymous → no persistence.
    counterKey = sid || (claudeIdOk(opts.claudeSessionId) ? `claude:${opts.claudeSessionId}` : null);

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
    // The counter RMW runs under mutateCounter's lock (v1.111.0): read →
    // gather → nextCounter → decide → bump → write is ONE transaction, so a
    // parallel gate or witness-latch write can't clobber the map/baseline.
    // Recompute rule for BOTH derivation sites: dirtyAgeMin stays null while
    // observation is unknown — an aged counter must never commit-block during
    // a git failure. Lock failure → NO write; evaluate a TRANSIENT
    // nextCounter result in memory (never the raw snapshot, whose stale
    // firstDirtyTs could block a now-clean repo) and skip the edit bump.
    const workRoot = opts.workRoot === undefined ? repoRoot : opts.workRoot;
    let decision, enforcedState;
    const persisted = counterKey ? await mutateCounter(repoRoot, counterKey, async (prev) => {
      const state = await gatherRitualState(repoRoot, sid, nowMs, prev, { workRoot });
      if (laneJustClaimed) state.lane = { claimed: true };
      const counter = nextCounter(prev, state, nowMs);
      state.commit.dirtyAgeMin = (state.commit.observed && counter.firstDirtyTs != null)
        ? Math.max(0, (nowMs - counter.firstDirtyTs) / 60000) : null;
      state.commit.slicedButDirty = !!(state.commit.observed && counter.lastSliceStopId
        && (counter.editsSinceSlice || 0) === 0 && (state.commit.newDirtyFiles || 0) > 0);
      decision = decide({ thresholds, state, counter, toolCtx: { isMutating: true } });
      enforcedState = state;
      // Bump the edit clocks ONLY for an allowed edit; on a HEALTHY eval
      // clear any skip-witness latch (F6 — the next off/error episode
      // re-emits).
      if (decision.verdict !== 'block') {
        counter.editsSinceSlice = (counter.editsSinceSlice || 0) + 1;
        if (!(state.goalOrPlan && state.goalOrPlan.active)) counter.goalplanAgeEdits = (counter.goalplanAgeEdits || 0) + 1;
      }
      if (counter.skipLatch) counter.skipLatch = {};
      return counter;
    }) : null;
    if (!counterKey || persisted === null) {
      // Anonymous caller, or the counter lock was busy: transient evaluation,
      // nothing persisted, verdict computed from properly-maintained state.
      const prev = counterKey ? await readCounter(repoRoot, counterKey) : { editsSinceSlice: 0, dirtyBaseline: [] };
      const state = await gatherRitualState(repoRoot, sid, nowMs, prev, { workRoot });
      if (laneJustClaimed) state.lane = { claimed: true };
      const counter = nextCounter(prev, state, nowMs);
      state.commit.dirtyAgeMin = (state.commit.observed && counter.firstDirtyTs != null)
        ? Math.max(0, (nowMs - counter.firstDirtyTs) / 60000) : null;
      state.commit.slicedButDirty = !!(state.commit.observed && counter.lastSliceStopId
        && (counter.editsSinceSlice || 0) === 0 && (state.commit.newDirtyFiles || 0) > 0);
      decision = decide({ thresholds, state, counter, toolCtx: { isMutating: true } });
      enforcedState = state;
    }
    void enforcedState;
    return { ...decision, sid, counterKey, mutating: true, enforcement, kind, action };
  } catch (e) {
    // FAIL-OPEN, but hand the seam a signature so it can witness ENFORCEMENT_ERROR.
    return { ...ok(), sid, counterKey, tool, mutating: false, enforcement: 'error', kind: null, action: 'allow', errorSig: normErrorSig(e) };
  }
}
