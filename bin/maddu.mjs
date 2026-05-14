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
const COMMANDS = ['init', 'upgrade', 'doctor', 'start', 'status', 'slice-stop', 'session', 'lane', 'approval', 'events', 'memory', 'mailbox', 'task', 'skill', 'worker', 'search', 'runtime', 'mcp', 'schedule', 'checkpoint'];

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

Flags:
  --version      Print framework version.
  --help         Print this help.

Docs:
  README.md, docs/hard-rules.md, docs/installation.md
`);
}

async function main() {
  const [, , raw, ...rest] = process.argv;

  if (!raw || raw === '--help' || raw === '-h' || raw === 'help') {
    printHelp();
    return;
  }
  if (raw === '--version' || raw === '-v' || raw === 'version') {
    await printVersion();
    return;
  }
  if (!COMMANDS.includes(raw)) {
    console.error(`maddu: unknown command "${raw}". Run "maddu --help".`);
    process.exit(2);
  }

  const commandPath = join(repoRoot, 'commands', `${raw}.mjs`);
  const mod = await import(pathToFileURL(commandPath).href);
  await mod.default(rest);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
