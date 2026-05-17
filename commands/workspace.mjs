// `maddu workspace <subcommand>` — multi-workspace registry.
//
// Usage:
//   maddu workspace add <path> [--id <slug>] [--label "<label>"]
//   maddu workspace list
//   maddu workspace remove <id>
//   maddu workspace activate <id>
//   maddu workspace show

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { parseFlags } from './_args.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frameworkRoot = resolve(__dirname, '..');

async function loadWorkspacesLib() {
  const candidates = [
    join(process.cwd(), 'maddu', 'runtime', 'lib', 'workspaces.mjs'),
    join(frameworkRoot, 'template', 'maddu', 'runtime', 'lib', 'workspaces.mjs')
  ];
  for (const c of candidates) {
    try { await stat(c); return await import(pathToFileURL(c).href); } catch {}
  }
  throw new Error('workspaces.mjs not found. Run `maddu init` first.');
}

function printHelp() {
  console.error('Usage: maddu workspace <add|list|remove|activate|show> [args]');
}

export default async function workspace(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub) { printHelp(); process.exit(2); }

  const ws = await loadWorkspacesLib();

  if (sub === 'list') {
    const reg = await ws.readRegistry();
    if (reg.workspaces.length === 0) {
      console.log('(no workspaces registered — `maddu workspace add <path>` to add one)');
      console.log(`registry: ${ws.registryPath()}`);
      return;
    }
    console.log(`\x1b[1mWORKSPACES  (${reg.workspaces.length})\x1b[0m  registry: ${ws.registryPath()}`);
    for (const w of reg.workspaces) {
      const tag = w.id === reg.active ? '\x1b[32m●\x1b[0m' : ' ';
      console.log(`  ${tag} ${w.id.padEnd(22)} ${w.label.padEnd(28)} ${w.path}`);
    }
    return;
  }

  if (sub === 'show') {
    const reg = await ws.readRegistry();
    console.log(JSON.stringify(reg, null, 2));
    return;
  }

  if (sub === 'add') {
    const { flags, positional } = parseFlags(rest);
    const path = positional[0];
    if (!path) { console.error('maddu workspace add <path> [--id <slug>] [--label "<label>"]'); process.exit(2); }
    const abs = resolve(process.cwd(), path);
    try {
      const w = await ws.addWorkspace({
        path: abs,
        id: typeof flags.id === 'string' ? flags.id : null,
        label: typeof flags.label === 'string' ? flags.label : null
      });
      console.log(`added  ${w.id}  ${w.label}  ${w.path}`);
    } catch (err) {
      console.error(`maddu workspace add: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'remove') {
    const id = rest[0];
    if (!id) { console.error('maddu workspace remove <id>'); process.exit(2); }
    const ok = await ws.removeWorkspace(id);
    if (!ok) { console.error(`unknown workspace: ${id}`); process.exit(1); }
    console.log(`removed  ${id}`);
    return;
  }

  if (sub === 'activate') {
    const id = rest[0];
    if (!id) { console.error('maddu workspace activate <id>'); process.exit(2); }
    try {
      const reg = await ws.activateWorkspace(id);
      console.log(`active  ${reg.active}`);
    } catch (err) {
      console.error(`maddu workspace activate: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`maddu workspace: unknown subcommand "${sub}"`);
  process.exit(2);
}
