// `maddu hooks <install|status|remove|fire>` — wire session discipline into
// Claude Code so a fresh maddu repo records session + spine activity every
// time an agent starts working, without relying on the agent following its
// brief by hand.
//
//   maddu hooks install     # merge SessionStart(auto-register) + SessionEnd(close)
//                           # into <repo>/.claude/settings.json (idempotent)
//   maddu hooks status      # show which Máddu hooks are installed
//   maddu hooks remove      # strip Máddu's hook entries (leaves yours intact)
//   maddu hooks fire <ev>   # runtime entrypoint the settings.json calls:
//                           #   session-start → register + remind to slice-stop
//                           #   session-end   → close the active session
//                           #   pre-compact   → COMPACTION_CHECKPOINT on the spine
//                           #                   (fails OPEN: never blocks compaction)
//
// install/remove touch a HOST-repo file (.claude/settings.json) outside
// .maddu/, so they run only on explicit invocation — never silently at init.

import { join } from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, resolveWorkAndStateRoots, resolveParentId } from './_spine.mjs';
import { loadLib, loadLibOptional } from './_libroot.mjs';
import registerCmd from './register.mjs';

// Ownership side-state for the permission guardrails: the exact rule strings
// THIS install added (a rule the user already had is not ours and must survive
// uninstall). Lives in .maddu/state/ — if the state dir is wiped (projections
// are rebuildable), uninstall falls back to the canonical current rule set,
// which degrades to exact-string matching (documented limit).
function guardrailStatePath(repoRoot) {
  return join(repoRoot, '.maddu', 'state', 'guardrails.json');
}
async function readGuardrailState(repoRoot) {
  try {
    const raw = await readFile(guardrailStatePath(repoRoot), 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.deny) && Array.isArray(j.ask)) {
      // An EMPTY record is treated as absent: "we own nothing" makes uninstall
      // a silent no-op that leaves every guardrail behind, which is strictly
      // worse than the documented exact-string fallback an absent record
      // triggers. Install never writes one; one on disk is stale state.
      if (j.deny.length + j.ask.length === 0) return null;
      // `created` marks which containers install brought into existence, so
      // strip only cleans up those (a user's pre-existing empty array stays).
      // Records from before this field default to the old delete-empties
      // behavior inside stripGuardrails.
      const created = j.created && typeof j.created === 'object' && !Array.isArray(j.created)
        ? j.created : undefined;
      return created ? { deny: j.deny, ask: j.ask, created } : { deny: j.deny, ask: j.ask };
    }
  } catch { /* absent / malformed → null */ }
  return null;
}
async function writeGuardrailState(repoRoot, recorded) {
  const p = guardrailStatePath(repoRoot);
  await mkdir(join(repoRoot, '.maddu', 'state'), { recursive: true });
  await writeFile(p, JSON.stringify({ v: 1, ...recorded }, null, 2) + '\n');
}
async function clearGuardrailState(repoRoot) {
  // Only "already absent" is ignorable. Any other failure means a STALE
  // ownership record survives the uninstall — a later install would re-record
  // against it and could claim (then delete) a rule the user authors in the
  // meantime. Say so instead of swallowing it.
  try { await rm(guardrailStatePath(repoRoot)); }
  catch (e) {
    if (e && e.code === 'ENOENT') return;
    console.error(`\x1b[33mwarning\x1b[0m  could not delete ${guardrailStatePath(repoRoot)} (${String((e && e.message) || e).slice(0, 80)})`);
    console.error(`  Delete it manually — a stale ownership record can mis-claim rules on a later install.`);
  }
}

function printHelp() {
  console.log([
    'Usage: maddu hooks <install|status|remove|uninstall> [--statusline] [--no-guardrails] [--dry-run]',
    '',
    '  install     Wire SessionStart (auto-register + stale-sweep) + SessionEnd',
    '              (close) + PreCompact (compaction checkpoint) + PreToolUse',
    '              (auto-claim a lane before editing) into',
    '              <repo>/.claude/settings.json so every Claude Code session in',
    '              this repo records to the spine. Idempotent; preserves your',
    '              own hooks.',
    '              Also installs permission guardrails by default: deny-rules on',
    '              the framework internals (maddu/runtime/**, .maddu/config/**,',
    '              .maddu/gates/**, the settings files) plus ask-rules for paths',
    '              the project declares in maddu.json → guardrails.ask[].',
    '              Edit-form only (Write() rules are inert in Claude Code',
    '              v2.1.210+). Bypassable harness friction covering the',
    '              built-in file tools, NOT a security boundary — Bash coverage',
    '              is version-dependent, subprocesses are never covered.',
    '              --no-guardrails skips them. --retire-inert-write-twins',
    '              retires redundant Write() rules (explicit, reported).',
    '              With --statusline, also set the Claude Code statusLine to',
    '              `maddu status --line` (a one-line on-goal/drift segment). Opt-in;',
    '              never clobbers a statusLine you already set.',
    '  status      Show which Máddu hooks + guardrails are installed.',
    '  remove      Remove only Máddu\'s hook entries, its guardrail rules (exact',
    '              strings), and its statusLine, if set.',
    '  uninstall   Alias for `remove` — the fast off-switch for the discipline hook.',
    '',
    'Once installed, a session auto-registers, the SessionStart sweep clears stale',
    'sessions + orphaned lane claims, and PreToolUse auto-claims a lane before the',
    'first edit — so agentic work is recorded and laned without the agent',
    'remembering. Slice boundaries stay agent-driven (`maddu slice-stop` at each).',
  ].join('\n'));
}

// The hook-FIRING core lives in the runtime library
// (template/maddu/runtime/lib/harness/fire-core.mjs) so the Codex / Hermes /
// OpenHands adapters share ONE implementation instead of copying it. It cannot
// import back into commands/: the two are siblings in a consumer install but
// not in the framework source checkout, so a relative path resolves in exactly
// one of the two layouts (scripts/test/command-import-layout.mjs). This file
// therefore hands the core the resolvers it needs. Loaded lazily, and once.
let _fireCore = null;
async function hookCore() {
  if (_fireCore) return _fireCore;
  const mod = await loadLib('harness/fire-core.mjs');
  _fireCore = mod.createHookFireCore({
    loadSpineLib, resolveRepoRoot, resolveParentId, loadLib, loadLibOptional, registerCmd,
  });
  return _fireCore;
}

// The events `hooks install` wires. The list is CLI surface — it decides what
// the usage error below says — so it stays here rather than being read back
// out of a core that may not load.
const FIRE_EVENTS = ['session-start', 'session-end', 'pre-tool-use', 'pre-compact'];

export default async function hooks(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);

  // Mutation-witness placement (Codex diff r2 F2): NO unconditional
  // declaration here — the session-start/end fire happy paths APPEND
  // (register/renew/close events) and must stay witnessed by those appends;
  // a blanket excuse would hide exactly the silent non-recording this guard
  // exists to catch. Declarations live in the specific append-free branches:
  // fire containment/graceful exits (the core's noop), the per-tool /
  // per-compaction conditional-append arms, and the install/remove host-file
  // arm.

  // ── fire: the runtime entrypoint the installed hooks call ──
  // Handled BEFORE the shared bootstrap: each event bootstraps inside its own
  // fail-open containment (a bootstrap failure must never block a tool call,
  // a compaction, or a session boundary).
  if (sub === 'fire') {
    const event = rest[0];
    // Checked BEFORE the core is loaded, so an unknown event still exits 2 on a
    // runtime that cannot supply one.
    if (!FIRE_EVENTS.includes(event)) {
      console.error(`maddu hooks fire: unknown event "${event}". One of: session-start, session-end, pre-compact, pre-tool-use.`);
      process.exit(2);
    }
    // CONTAINMENT around the load itself. `loadLib` prefers the repo's own
    // maddu/runtime/lib/ over this checkout, so a repo whose installed runtime
    // predates the core — the half-applied-upgrade state v1.127.0 exists for —
    // throws here, ABOVE every arm's own containment. A `hooks fire` that exits
    // non-zero fails the user's tool call, so degrade the way each arm degrades
    // on a bootstrap failure instead: exit 0, and let SessionStart say why.
    let core = null, loadErr = null;
    try { core = await hookCore(); } catch (e) { loadErr = e; core = null; }
    // `typeof core?.fire`, not `!core`: the factory's return shape is now a
    // CROSS-FILE contract, and a module that loads but hands back the wrong
    // object would otherwise throw a TypeError out of `hooks()` at the call
    // below — a stack trace and exit 1, which is the one thing a hook may
    // never do.
    if (typeof core?.fire !== 'function') {
      // Declare the append-free exit BEFORE taking it, exactly as every other
      // arm in this file does. `hooks` is a MUTATING-tier verb and `fire`
      // matches none of its readShapes (commands/_tiers.mjs), so every
      // invocation arms a mutation witness; an exit 0 with zero spine appends
      // and no declared no-op is a BREACH. bin/maddu.mjs's exit handler then
      // spools it, prints MUTATION_UNWITNESSED, and rewrites the code to 1 —
      // the exact non-zero exit this path exists to prevent — and the spooled
      // row makes the NEXT mutating invocation run the drain, which exits 1
      // before dispatch if it fails. Silence here is not a small omission.
      try {
        (await loadLibOptional('mutation-witness.mjs'))?.witnessNoop?.('hook-fire:core-unavailable');
      } catch { /* the excuse is best-effort — never why a hook fails */ }
      if (event === 'session-start') {
        // Report what actually happened rather than asserting a cause. ONLY
        // MADDU_LIB_NOT_FOUND means nothing resolved, and it is the only case
        // `maddu upgrade` addresses — it also covers being invoked from a
        // directory that is not the repo root, since _libroot keys the
        // installed path on process.cwd(), which is why the remedy names the
        // root. Every other reason lands here too: a module present but
        // unreadable, or one that throws on import (a syntax error or a bad
        // transitive import would disable all four hooks on EVERY install that
        // shipped it). Telling that operator the file is missing sends them to
        // an upgrade that faithfully recopies the broken file, so say the real
        // reason and let them see it.
        const absent = loadErr && loadErr.code === 'MADDU_LIB_NOT_FOUND';
        const why = absent
          ? 'no hook fire-core resolved from this directory — run `maddu upgrade` from the repo root'
          : `the hook fire-core failed to load (${String((loadErr && loadErr.message) || 'unexpected module shape').split('\n')[0].slice(0, 140)})`;
        try {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: `Máddu session discipline did not start — ${why}. Run \`maddu register\` and \`maddu slice-stop\` by hand until it is fixed.`,
            },
          }) + '\n');
        } catch { /* stdout gone — still exit 0 */ }
      }
      process.exit(0);
    }
    // THE CALL IS CONTAINED, not just the load. The guard above is shape-only —
    // it proves `fire` is a function, not that calling it survives. A core that
    // loads, constructs, and then throws (or returns a promise that rejects)
    // escaped through here as an uncaught error: a stack trace on stderr and
    // exit 1, which is precisely the non-zero exit this whole branch exists to
    // prevent. `await` rather than `return` is load-bearing: `return core.fire()`
    // hands the promise back to the caller and a rejection leaves by a different
    // route than a synchronous throw, so only awaiting catches both.
    //
    // Every arm inside the core ends in process.exit, so reaching the catch at
    // all means the core failed. Declare the no-op first — `hooks` is a
    // mutating-tier verb, so exiting 0 with no spine append and no declared
    // excuse is a mutation-witness breach that gets rewritten back to exit 1,
    // which would defeat the containment while appearing to implement it.
    // stdout is a PARSED contract, so the core's output is BUFFERED and only
    // released once the core has finished having opinions.
    //
    // A core that writes a verdict and then throws has not made a decision, it
    // has crashed halfway through making one. Three options were weighed.
    // Emitting an advisory after its output yields two JSON documents; that
    // usually fails to parse and the tool proceeds — but only by ACCIDENT, and
    // not reliably, since many readers stop at the first complete value and
    // would honour a deny with trailing data. Correctness that depends on
    // another parser's leniency is not correctness. Merely suppressing the
    // advisory leaves the crashed core's deny standing, so a broken install
    // silently blocks edits. Buffering discards both problems: if the catch
    // below runs, the core failed and whatever it had started to say is dropped.
    //
    // DELIBERATE BEHAVIOUR CHANGE, not a side effect: a core that emits a
    // legitimate deny and then throws during cleanup loses that refusal. That is
    // the right way for this path to fail — every documented posture here is
    // fail-open ("may never fail the tool call", "fails OPEN: never blocks
    // compaction") — and the operator still learns through the breach spool and
    // the SessionStart notice below.
    //
    // The flush rides an `exit` handler because every arm of the core ends in
    // process.exit, so there is no normal return to flush after.
    let buffered = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const flush = () => {
      const out = buffered; buffered = [];
      for (const chunk of out) { try { realWrite(chunk); } catch {} }
    };
    process.stdout.write = (chunk, ...rest) => {
      buffered.push(chunk);
      const cb = rest.find((a) => typeof a === 'function');
      if (cb) cb();
      return true;
    };
    process.on('exit', flush);
    try {
      await core.fire(event);
    } catch (err) {
      buffered = [];   // the core crashed — it does not get to have said anything
      try {
        (await loadLibOptional('mutation-witness.mjs'))?.witnessNoop?.('hook-fire:core-threw');
      } catch { /* the excuse is best-effort — never why a hook fails */ }
      // The buffer is empty, so this is now the ONLY document on stdout and is
      // guaranteed parseable — which is what makes emitting it safe here where
      // suppression was necessary before.
      if (event === 'session-start') {
        try {
          realWrite(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: `Máddu session discipline did not start — the hook fire-core failed while running (${String((err && err.message) || err).split('\n')[0].slice(0, 140)}). Run \`maddu doctor\`; run \`maddu register\` and \`maddu slice-stop\` by hand until it is fixed.`,
            },
          }) + '\n');
        } catch { /* stdout gone — still exit 0 */ }
      }
      process.exit(0);
    }
    // A core that RETURNS instead of exiting. Every shipped arm ends in
    // process.exit, so this is unreachable today — but it is reachable by a
    // future arm that forgets, and falling through here without declaring a
    // no-op is a mutation-witness breach that rewrites this exit 0 back to 1.
    // The containment would then be defeated by the one path that looked safest.
    try {
      (await loadLibOptional('mutation-witness.mjs'))?.witnessNoop?.('hook-fire:core-returned-without-exiting');
    } catch { /* best-effort */ }
    process.exit(0);
  }

  // Shared bootstrap for the NON-fire subcommands (install/status/remove).
  // These are interactive operator commands — a bootstrap failure may error
  // normally here; only the fire handlers carry the fail-open containment.
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const lib = await loadLib('claude-hooks.mjs');

  // ── status ──
  if (!sub || sub === 'status' || sub === 'list') {
    const { settings, existed } = await lib.loadSettings(repoRoot);
    if (settings === null) {
      console.log(`\x1b[33m.claude/settings.json exists but is not valid JSON — refusing to read it.\x1b[0m`);
      console.log(`  ${lib.settingsPath(repoRoot)}`);
      return;
    }
    const { installed, allInstalled } = lib.summarize(settings);
    console.log(`\x1b[1mMáddu Claude Code hooks\x1b[0m  ${lib.settingsPath(repoRoot)}${existed ? '' : '  \x1b[2m(no settings file yet)\x1b[0m'}`);
    for (const { event } of lib.MADDU_HOOKS) {
      const on = installed.includes(event);
      console.log(`  ${on ? '\x1b[32m●\x1b[0m installed ' : '\x1b[2m○ not set  \x1b[0m'} ${event}`);
    }
    if (lib.resolveGuardrailRules && lib.summarizeGuardrails) {
      const rules = await lib.resolveGuardrailRules(repoRoot);
      const g = lib.summarizeGuardrails(settings, rules);
      console.log(`\x1b[1mPermission guardrails\x1b[0m (${rules.layout} layout — harness friction, not a security boundary)`);
      for (const r of g.present) console.log(`  \x1b[32m●\x1b[0m installed  ${r}`);
      for (const r of g.missing) console.log(`  \x1b[2m○ not set   ${r}\x1b[0m`);
    }
    if (!allInstalled) console.log(`\nRun \x1b[1mmaddu hooks install\x1b[0m to wire session discipline into this repo.`);
    return;
  }

  // ── install / remove ──
  if (sub === 'install' || sub === 'remove' || sub === 'uninstall') {
    // Mutation-witness declared no-op: writes the HOST file
    // (.claude/settings.json) — no spine event exists for it (r2 F2: the
    // declaration is arm-local, never verb-wide).
    //
    // Declared INLINE, the way every other command declares one, rather than
    // through the fire core. This arm is not on the firing path, and routing it
    // through `hookCore()` made `maddu hooks remove` — the documented fast
    // off-switch for the discipline hook — throw MADDU_LIB_NOT_FOUND before it
    // did anything, on exactly the half-applied install where an operator most
    // needs to switch enforcement off. `hookCore()` is now called from inside
    // its containment and nowhere else.
    (await loadLibOptional('mutation-witness.mjs'))?.witnessNoop?.('host-file-write:claude-settings');
    const { flags } = parseFlags(rest);
    // `uninstall` is an alias for `remove` — it's the off-switch operators reach
    // for when the discipline hook needs to come out fast, so both names work.
    const removing = sub === 'remove' || sub === 'uninstall';
    const { settings, existed, raw } = await lib.loadSettings(repoRoot);
    if (settings === null) {
      console.error(`\x1b[31mrefusing to touch ${lib.settingsPath(repoRoot)} — it exists but is not valid JSON. Fix or remove it first.\x1b[0m`);
      process.exit(1);
    }
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      // Valid JSON but not an object root ([], "x", 42, true): properties
      // attached to an array/primitive vanish at serialize time, so a merge
      // would "succeed" while installing nothing (and still record ownership).
      console.error(`\x1b[31mrefusing to touch ${lib.settingsPath(repoRoot)} — its root is not a JSON object. Fix or remove it first.\x1b[0m`);
      process.exit(1);
    }
    const bin = lib.resolveHookBin ? await lib.resolveHookBin(repoRoot) : undefined;
    // On remove, also strip Máddu's statusLine (if present) — never leave a
    // dangling `status --line` pointing at removed wiring. On install, only wire
    // the statusLine when --statusline is passed (opt-in).
    let statusLineSkipped = false;
    // Permission guardrails ride install/remove by default (the point is that a
    // consumer install ships them without a second command); --no-guardrails
    // opts out. Rules are layout-aware + generated from maddu.json
    // `guardrails.ask[]` — see claude-hooks.mjs for the honest-strength notes.
    // OWNERSHIP: the exact strings each install adds are recorded in
    // .maddu/state/guardrails.json; uninstall strips exactly those, so a rule
    // the user had authored before install survives. Install first strips the
    // previously-recorded set, so a changed guardrails.ask[] declaration
    // retires its old generated rules instead of leaving them behind.
    const wantGuardrails = !flags['no-guardrails'] && lib.resolveGuardrailRules && lib.mergeGuardrails;
    const gRules = wantGuardrails ? await lib.resolveGuardrailRules(repoRoot) : null;
    if (gRules && gRules.warnings && gRules.warnings.length) {
      for (const w of gRules.warnings) console.error(`\x1b[33mwarning\x1b[0m  ${w}`);
    }
    const gPrev = wantGuardrails ? await readGuardrailState(repoRoot) : null;
    let gAdded = null, gRetired = null, gRecorded = null, gStripFallback = false;
    let next;
    if (removing) {
      next = lib.stripMaddu(settings);
      if (lib.stripStatusLine) next = lib.stripStatusLine(next);
      if (wantGuardrails && lib.stripGuardrails) {
        // Prefer the recorded ownership set; fall back to the canonical current
        // rules only when no record exists (pre-side-state installs) — the
        // fallback can remove a user-authored identical rule (documented).
        gStripFallback = !gPrev;
        next = lib.stripGuardrails(next, gPrev || gRules);
      }
    } else {
      next = lib.mergeInstall(settings, { bin });
      if (flags.statusline && lib.mergeStatusLine) {
        const merged = lib.mergeStatusLine(next, { bin });
        next = merged.settings;
        statusLineSkipped = merged.skipped;
      }
      if (wantGuardrails) {
        if (gPrev && lib.stripGuardrails) next = lib.stripGuardrails(next, gPrev);
        const g = lib.mergeGuardrails(next, gRules);
        if (g.malformed && g.malformed.length) {
          // Merging into these shapes would either lose the rules at
          // JSON-serialize time (properties on an array) or clobber user data
          // (non-array deny/ask) — refuse before anything is written, same as
          // the invalid-JSON refusal above.
          console.error(`\x1b[31mrefusing to install guardrails\x1b[0m — ${lib.settingsPath(repoRoot)} has a malformed shape at: ${g.malformed.join(', ')}.`);
          console.error(`  Fix it (permissions must be an object; deny/ask must be arrays), or re-run with --no-guardrails.`);
          process.exit(1);
        }
        next = g.settings;
        gAdded = g.added;
        // Recorded ownership = exactly what this merge introduced (after the
        // prev-owned strip, re-added canonical rules land in `added`; a rule
        // the user authored independently never does). An all-empty record is
        // NEVER written — it reads back as absent anyway, and persisting one
        // was the round-2 bug that neutered uninstall.
        gRecorded = (g.added.deny.length + g.added.ask.length)
          ? { deny: g.added.deny, ask: g.added.ask, created: g.created } : null;
        if (!gPrev) {
          const preexisting = (gRules.deny.length + gRules.ask.length)
            - (g.added.deny.length + g.added.ask.length);
          if (preexisting > 0 && g.added.deny.length + g.added.ask.length === 0) {
            // EVERY canonical rule was already present with no ownership
            // record — the signature of a pre-record install (or lost state),
            // not of a user hand-authoring the complete set. Recording an
            // empty set here would make a later uninstall a silent no-op that
            // leaves all guardrails behind; leave NO record instead so
            // uninstall keeps its exact-string fallback, and say so.
            gRecorded = null;
            console.error(`\x1b[33mwarning\x1b[0m  all ${preexisting} canonical guardrail rule(s) were already present with no ownership record`);
            console.error(`  (pre-1.107 install or lost .maddu/state/guardrails.json). No record written — uninstall will`);
            console.error(`  strip the canonical set by exact string; if you hand-authored an identical rule, re-add it after.`);
          } else if (preexisting > 0) {
            // Partial overlap: the pre-existing matches are treated as YOURS
            // (they survive uninstall) — that is the protection for a rule
            // you authored before install, but it also means a rule left by a
            // recordless earlier install stays behind. Be loud about it.
            console.error(`\x1b[33mwarning\x1b[0m  ${preexisting} canonical guardrail rule(s) were already present with no ownership record —`);
            console.error(`  treated as user-authored (they will survive uninstall). If they came from an earlier Máddu`);
            console.error(`  install, run \x1b[1mmaddu hooks remove\x1b[0m first, then re-install, to reset ownership.`);
          }
        }
      }
      // Inert Write() twin retirement is an EXPLICIT operator action, never a
      // side effect of install — it edits user-visible rules (behavior-neutral
      // under documented Claude Code semantics, but the operator pulls the
      // trigger and gets a report).
      if (flags['retire-inert-write-twins'] && lib.retireInertWriteTwins) {
        const r = lib.retireInertWriteTwins(next);
        next = r.settings;
        gRetired = r.retired;
      }
    }
    const before = JSON.stringify(settings);
    const after = JSON.stringify(next);
    if (before === after) {
      // Settings text unchanged — still reconcile the ownership side-state
      // (never on dry-run): an idempotent re-install re-records the same set;
      // a no-op remove clears any stale record.
      if (!flags['dry-run'] && wantGuardrails) {
        if (removing) await clearGuardrailState(repoRoot);
        else if (gRecorded) await writeGuardrailState(repoRoot, gRecorded);
        else await clearGuardrailState(repoRoot); // never leave a stale/empty record behind
      }
      if (!removing && flags.statusline && statusLineSkipped) {
        console.log('\x1b[33mstatusLine already set to your own command\x1b[0m — left untouched. Remove it first to use Máddu\'s.');
        return;
      }
      console.log(removing ? 'no Máddu hooks present — nothing to remove.' : '\x1b[32mMáddu hooks already installed\x1b[0m — no changes.');
      return;
    }
    if (flags['dry-run']) {
      const what = removing
        ? 'remove Máddu hooks from'
        : `install Máddu hooks${flags.statusline && !statusLineSkipped ? ' + statusLine' : ''} into`;
      console.log(`(dry-run) would ${what}:`);
      console.log(`  ${lib.settingsPath(repoRoot)}`);
      if (!removing && flags.statusline && statusLineSkipped) {
        console.log(`  ${'\x1b[33m'}(statusLine left untouched — you already set your own)${'\x1b[0m'}`);
      }
      return;
    }
    // audit P2 (C6c): uninstalling the PreToolUse hook disables Máddu's own
    // discipline enforcement. Record it WRITE-AHEAD — append the witness BEFORE
    // stripping the settings so a disable is never silent; abort on append failure
    // (a disable that can't be recorded must not proceed) unless --force, which
    // still records first and only downgrades the abort to a loud warning.
    if (removing && lib.summarize(settings).installed.includes('PreToolUse')) {
      // NEVER remove the enforcement hook unless the disable is recorded first —
      // a disable that can't be witnessed must not proceed (no --force bypass of the
      // write-ahead; the operator can hand-edit .claude/settings.json if the spine
      // is genuinely broken, which is itself the problem to fix).
      try {
        const { spine } = await loadSpineLib();
        // CP3: grammar-gate the actor — an inherited malformed env id must not be
        // written raw into the disable witness.
        const refUninstall = spine.isRefId || ((v) => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v));
        const uninstallActor = refUninstall(process.env.MADDU_SESSION_ID) ? process.env.MADDU_SESSION_ID : null;
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.DISCIPLINE_SKIPPED,
          actor: uninstallActor,
          data: {
            reason: 'enforcement-hook-uninstalled',
            tool: null, sessionId: uninstallActor, enforcement: null,
          },
        });
      } catch (e) {
        console.error(`\x1b[31mrefusing to uninstall\x1b[0m — could not record the disable on the spine (${String((e && e.message) || e).slice(0, 80)}).`);
        console.error(`  Disabling enforcement must leave a witness. Fix the spine first (a broken spine is the real problem).`);
        process.exit(1);
      }
    }
    const eol = existed && raw && raw.includes('\r\n') ? '\r\n' : '\n';
    await lib.saveSettings(repoRoot, next, { eol });
    if (wantGuardrails) {
      if (removing) await clearGuardrailState(repoRoot);
      else if (gRecorded) await writeGuardrailState(repoRoot, gRecorded);
      else await clearGuardrailState(repoRoot); // never leave a stale/empty record behind
    }
    if (removing) {
      console.log(`\x1b[32mremoved\x1b[0m Máddu hooks${wantGuardrails ? ' + permission guardrails' : ''} → ${lib.settingsPath(repoRoot)}`);
      if (gStripFallback && wantGuardrails) {
        console.log(`  \x1b[33mno ownership record found\x1b[0m — stripped the canonical rule set by exact string;`);
        console.log(`  \x1b[2mif you had hand-authored an identical rule before install, re-add it.\x1b[0m`);
      }
    } else {
      const { installed } = lib.summarize(next);
      console.log(`\x1b[32minstalled\x1b[0m Máddu hooks (${installed.join(', ')}) → ${lib.settingsPath(repoRoot)}`);
      console.log(`  Every Claude Code session now auto-registers, sweeps stale sessions + orphaned`);
      console.log(`  claims, auto-claims a lane before the first edit, and checkpoints before compaction.`);
      if (gAdded && (gAdded.deny.length || gAdded.ask.length)) {
        console.log(`  Permission guardrails (${gRules.layout} layout): ${gAdded.deny.length} deny + ${gAdded.ask.length} ask rule(s) added.`);
        console.log(`  \x1b[2mHarness friction inside Claude Code, not a security boundary — the rules cover`);
        console.log(`  Claude Code's built-in file tools; coverage of Bash file commands is`);
        console.log(`  version-dependent and NOT guaranteed, and subprocesses that open files`);
        console.log(`  themselves are never covered (docs/34-threat-model.md).\x1b[0m`);
        if (!gRules.ask.length) console.log(`  \x1b[2mDeclare project paths to guard as ask-rules in maddu.json → guardrails.ask[].\x1b[0m`);
      }
      if (gRetired && gRetired.length) {
        console.log(`  Retired ${gRetired.length} inert Write() twin rule(s) (Write rules are never`);
        console.log(`  matched by file checks in Claude Code v2.1.210+; the Edit twin covers each):`);
        for (const r of gRetired) console.log(`    \x1b[2m- ${r.list}: ${r.rule}\x1b[0m`);
      }
      if (flags.statusline && lib.statusLineInstalled && lib.statusLineInstalled(next)) {
        console.log(`  statusLine set to \x1b[1mmaddu status --line\x1b[0m (on-goal / drift, one glance).`);
      } else if (flags.statusline && statusLineSkipped) {
        console.log(`  \x1b[33mstatusLine left untouched\x1b[0m — you already set your own.`);
      }
      console.log(`  Remove with \x1b[1mmaddu hooks remove\x1b[0m.`);
    }
    return;
  }

  console.error(`maddu hooks: unknown subcommand "${sub}". One of: install, status, remove.`);
  process.exit(2);
}
