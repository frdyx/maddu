#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const COMMANDS = ['init', 'upgrade', 'doctor', 'start', 'status', 'slice-stop'];

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
  status         Print a state snapshot.
  slice-stop     Run the slice-stop ritual at the end of a working session.

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
