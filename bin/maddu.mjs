#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Framework lifecycle (locked surface):
//   init, upgrade, doctor, start, status, slice-stop
// Operational surface (additive — agents and operators use these to participate
// in the spine without needing the bridge running):
//   session, lane
const COMMANDS = ['init', 'upgrade', 'doctor', 'start', 'stop', 'status', 'slice-stop', 'session', 'lane', 'approval', 'events', 'memory', 'mailbox', 'task', 'skill', 'worker', 'search', 'runtime', 'mcp', 'schedule', 'checkpoint', 'auth', 'import', 'export', 'workspace', 'global', 'spine', 'goal', 'phase', 'brief', 'sources', 'slice', 'review', 'register', 'help', 'suggest', 'team', 'pipeline', 'advise', 'cost', 'usage', 'git', 'test', 'self-test', 'format', 'lint', 'install', 'governance', 'log', 'plan', 'loop', 'coordinator', 'trust', 'bridges', 'audit', 'insights', 'plugin', 'orient', 'handoff', 'learn', 'blueprint', 'debt', 'architecture', 'agents', 'focus', 'hooks', 'fleet', 'ci', 'autonomy', 'experience', 'evolve', 'model'];

async function printVersion() {
  const v = JSON.parse(await readFile(join(repoRoot, 'version.json'), 'utf8'));
  console.log(`maddu ${v.version} (${v.phase})`);
}

function printHelp() {
  console.log(`Máddu — the Source of local truth.

Usage:
  maddu <command> [args]

Commands:
  init           Install Máddu into the current directory.
  upgrade        Pull newer framework files in place; never touch project state.
  doctor         Verify install integrity, port, and hard-rule compliance.
  start          Boot the bridge server on 127.0.0.1:4177.
  stop           Stop the running bridge server (reads .maddu/state/bridge.pid). (v1.1.1)
  status         Print a state snapshot of the spine.
  slice-stop     Append a structured slice-stop event to the spine.
  session        Subcommands: register | heartbeat | close | list.
  lane           Subcommands: claim | release | list.
  approval       Subcommands: list | respond | policy | request.  (Phase A1)
  events         Subcommands: list | tail.                          (Phase A2)
  memory         Subcommands: list | search | extract.              (Phase A3)
  mailbox        Subcommands: counts | list | send | read.           (Phase B2)
  task           Subcommands: list | show | create | update | complete. (Phase B3)
  skill          Subcommands: list | show | create | from-slice | apply | delete. (Phase B4)
  worker         Subcommands: list | register | heartbeat | exit | kill | show. (Phase B5)
  search         Cross-corpus search over events, memory, skills, mailbox. (Phase B6)
  runtime        Subcommands: list | show | register | detect | spawn | remove. (Phase C1)
  mcp            Subcommands: list | show | register | enable | disable | test | remove | visible. (Phase C2)
  schedule       Subcommands: list | show | create | parse | enable | disable | tick | remove. (Phase C3)
  checkpoint     Subcommands: list | show | create | worktree | rollback | remove. (Phase C4)
  auth           Subcommands: where | list | keys | add | remove | rate-limit | reveal. (Phase C5)
  import         Subcommands: submit | scan | list | rejections. (Phase D2)
  workspace      Subcommands: add | list | remove | activate | show. (Multi-workspace cockpit)
  global         Subcommands: cron <add|list|show|enable|disable|remove> | policy <add|list|remove>. (Multi-workspace, machine-scope)
  spine          Subcommands: verify [--json] | show <eventId>. Integrity check + event lookup against the append-only spine.
  goal           Subcommands: set --objective "…" [--constraint "…" …] | show. (Governance Phase 1)
  phase          Subcommands: set --name "…" [--notes "…"] [--tier strict|standard|relaxed] | clear | show. A --tier makes the phase sterile: effective governance escalates while it is active. (v1.91.0)
  brief          Turn-start orientation digest. Writes .maddu/state/orientation.json + handoff.md. [--json] (Governance Phase 1)
  sources        Subcommands: rebuild | status. Tracked SSOT files for the tracked-source-drift gate. (Governance Phase 2)
  slice          Subcommands: scope-declare | scope-expand | approve-functional | show. Optional slice scope-lock. (Governance Phase 3)
  review         Subcommands: run --slice <id> [--reviewer name] | status [--limit N]. Post-stop review lane. (Governance Phase 5)
  register       Zero-keystroke session bootstrap; idempotent on MADDU_SESSION_ID env. (v0.17)
  help           Interactive discovery guide for slash commands + topics. (v0.18)
  suggest        Recommend a slash command + lane for a vague task. (v0.18)
  team           Subcommands: open | spawn | status | close. Disjoint-lane workers; spawn fans out tracked workers concurrently. (v0.18 Phase 4; spawn v1.5.0)
  pipeline       Subcommands: run <name> | list. Declarative multi-stage runner. (v0.18 Phase 4)
  advise         Non-claiming advisor: maddu advise <runtime> "<prompt>". (v0.18 Phase 4)
  cost           Token / call rollup per session, day, runtime, model. (v0.18 Phase 4)
  usage          Subcommands: import --from claude-code. Backfill the ledger from transcripts. (v0.19.1)
  git            Audited git wrapper. Refuses empty commit messages + git push -f. (v1.1.0)
  test           Project tests. Legacy auto-detect by default; opt-in profiles with --profile quick|full.
  self-test      Source-only Máddu framework test suite runner. quick by default; use --profile full for release validation.
  format         Auto-detects formatter (prettier / npm run format). (v1.1.0)
  lint           Auto-detects linter (eslint / npm run lint). (v1.1.0)
  install        Audited dep installer (npm/pnpm/yarn). Refuses empty package list. (v1.1.0)
  governance     Subcommands: show | set <strict|standard|relaxed> | set-override | reset. (v1.1.0)
  log            Receipt log viewer (--since --lane --op --rebuild --json). (v1.1.0)
  plan           Subcommands: new | list | show | add-phase | complete-phase | block-phase | revise | complete | cancel | kanban. (v1.1.0)
  loop           Subcommands: ralph | plan | status | cancel. Persist-until-done iteration with stuck-detection. (v1.1.0)
  coordinator    maddu coordinator <plan-id> [--runtime <n>] [--dry-run] [--synthetic-cmd "<bash>"]. Runtime-agnostic multi-phase driver. (v1.1.0)
  trust          Subcommands: audit | pin | unpin | verify | list | report | env-allow. Supply-chain audit + pinning. (v1.2.0)
  bridges        Subcommands: list | kill-all. Device-scope view of running Máddu bridges. (v1.2.1)
  audit          Framework-coherence self-audit: events | commands | cockpit | slash | docs | charter | invariants. [--json] (v1.3.0)
  insights       Cross-project usage: events | dead | verbs | slashes. What's actually utilized vs defined. [--json] (v1.4.0)
  plugin         Subcommands: list | info | enable | disable. Capabilities that live outside the core. [--trust] [--json] (v1.4.0)
  orient         Session-start briefing: goal + success-progress (run verify cmds) + handoff + trail. [--json] [--no-verify] (v1.6.0)
  handoff        Subcommands: set "<markdown>" | show. Curated "▶ RESUME HERE" cross-session handoff. (v1.6.0)
  learn          Mine past sessions for failed→succeeded tool calls; distil corrections. run | digest | scan | list | show | sync [--from-claude-memory] | retrieve. (v1.9.0; scan v1.87.0; vendor import v1.90.0)
  blueprint      Export a portable variable-driven handoff of how a project was built. [--slug a,b] [--repo p,p] [--full] (v1.12.0)
  debt           Ledger of deliberate-shortcut markers (maddu-debt: …); flags ones with no upgrade trigger. [--json] [--no-write] (v1.17.0)
  architecture   Declared architecture contract vs the real import graph → drift. Subcommands: init | scan | diagram | baseline. (v1.18.0)
  agents         Make "install maddu" available to AI agents machine-wide. Subcommands: detect | register | unregister. (v1.72.0)
  focus          Focus Director (opt-in): per-turn drift tag vs the goal + sustained-drift flag. Subcommands: status | enable | disable | resolve.
  hooks          Wire Claude Code session hooks: auto-register + auto-close + pre-compaction checkpoint. install | status | remove. (v1.74.0; PreCompact v1.89.0)
  fleet          Read-only single-machine fleet view: per-repo version/currency/liveness + version delta vs fleet latest. [--json] (v1.76.0)
  ci             Headless LLM-free gate rail for CI: run | pin. Exit 1 only on pinned required gates (churn-proof). [--json --strict] (v1.87.0)
  autonomy       Earned autonomy: per-lane Wilson trust score over the verified record → recommend-only tier guidance. [--lane <id>] [--json] [--no-emit] (v1.92.0)

Flags:
  --version      Print framework version.
  --help         Print this help.

Docs:
  README.md, docs/hard-rules.md, docs/installation.md
`);
}

// ── Invocation receipts (usage-audit Tier 2, v1.101.0) ──────────────────────
// Every CLI entry records one execution receipt to
// `.maddu/state/invocation-receipts.ndjson` — the audit's verb stats were
// transcript MENTIONS; this is the execution signal. FAIL-OPEN at every step:
// the lib may be absent (older install), the cwd may have no .maddu, the
// write may fail — none of it ever blocks or noises the verb. Recording
// happens in a process 'exit' handler because commands call process.exit()
// directly; state-root resolution also runs at exit so `maddu init` (no
// .maddu at entry, one at exit) is recorded too.
async function armInvocationReceipt(raw, rest) {
  try {
    let lib = null;
    for (const p of [
      join(repoRoot, 'runtime', 'lib', 'invocation-receipts.mjs'), // consumer install (maddu/bin → maddu/runtime/lib)
      join(repoRoot, 'template', 'maddu', 'runtime', 'lib', 'invocation-receipts.mjs'), // source checkout
    ]) {
      try { lib = await import(pathToFileURL(p).href); break; } catch {}
    }
    if (!lib || typeof lib.recordInvocationSync !== 'function') return;
    // Normalized verb only — an unknown command's raw text is caller input
    // and never persisted (it could be prose or a pasted secret).
    let verb;
    if (!raw || raw === '--help' || raw === '-h') verb = 'help';
    else if (raw === '--version' || raw === '-v' || raw === 'version') verb = 'version';
    else if (COMMANDS.includes(raw)) verb = raw;
    else verb = '(unknown)';
    // Subcommand only for a KNOWN verb and only when the first arg LOOKS like
    // one (token shape) — this keeps free text (slice-stop messages, flag
    // values, whatever followed a typo'd command) out of the corpus.
    const subRaw = COMMANDS.includes(raw) && Array.isArray(rest) && typeof rest[0] === 'string' ? rest[0] : null;
    const sub = subRaw && /^[a-z][a-z0-9-]{0,31}$/i.test(subRaw) ? subRaw.toLowerCase() : null;
    const t0 = Date.now();
    process.on('exit', (code) => {
      try {
        const stateRoot = lib.resolveStateRootSync(process.cwd(), process.env);
        if (!stateRoot) return;
        lib.recordInvocationSync({
          stateRoot, verb, sub,
          exitCode: typeof code === 'number' ? code : (process.exitCode ?? 0),
          durationMs: Date.now() - t0,
        });
      } catch {}
    });
  } catch {}
}

async function main() {
  const [, , raw, ...rest] = process.argv;
  await armInvocationReceipt(raw, rest);

  if (!raw || raw === '--help' || raw === '-h') {
    printHelp();
    return;
  }
  // `maddu help` (no flag form) is the v0.18 discovery surface — routed
  // through commands/help.mjs below, NOT the short --help usage above.
  if (raw === '--version' || raw === '-v' || raw === 'version') {
    await printVersion();
    return;
  }
  if (!COMMANDS.includes(raw)) {
    console.error(`maddu: unknown command "${raw}". Run "maddu --help".`);
    process.exit(2);
  }

  // v1.1.1 B3: --help discipline. If the operator types `maddu <verb> --help`
  // (or -h), short-circuit BEFORE the verb's own flag validation runs.
  //
  // Verbs that ship their own per-verb usage string (start, stop, workspace,
  // plan, lane, install) detect --help at the top of their handler — route
  // through them so the operator sees the more specific text. Everything
  // else falls back to the global discovery surface (`maddu help`).
  if (rest.includes('--help') || rest.includes('-h')) {
    const VERBS_WITH_OWN_HELP = new Set(['start', 'stop', 'workspace', 'plan', 'lane', 'install', 'task', 'review', 'self-test', 'agents']);
    if (VERBS_WITH_OWN_HELP.has(raw)) {
      const mod = await import(pathToFileURL(join(repoRoot, 'commands', `${raw}.mjs`)).href);
      await mod.default(rest);
      return;
    }
    try {
      const helpMod = await import(pathToFileURL(join(repoRoot, 'commands', 'help.mjs')).href);
      await helpMod.default([]);
      return;
    } catch {
      printHelp();
      return;
    }
  }

  const commandPath = join(repoRoot, 'commands', `${raw}.mjs`);
  const mod = await import(pathToFileURL(commandPath).href);
  await mod.default(rest);
}

main().catch((err) => {
  // A malformed EXPLICIT id flag (--session / --parent, PR-B) is a clean user
  // error: render the message without a stack, exit 2. The raw value is never
  // in err.message (no injection surface).
  if (err && err.code === 'INVALID_EXPLICIT_ID') {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
