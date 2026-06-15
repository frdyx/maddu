// `maddu workspace <subcommand>` — multi-workspace registry.
//
// Usage:
//   maddu workspace add <path> [--id <slug>] [--label "<label>"] [--role project|fixture|archive]
//   maddu workspace list
//   maddu workspace remove <id>
//   maddu workspace activate <id>
//   maddu workspace role <id> <project|fixture|archive>
//   maddu workspace show

import { resolve } from 'node:path';
import { request } from 'node:http';
import { parseFlags } from './_args.mjs';
import { loadLib } from './_libroot.mjs';

async function loadWorkspacesLib() {
  return loadLib('workspaces.mjs');
}

function printHelp() {
  console.log([
    'Usage: maddu workspace <add|list|remove|activate|role|show> [args]',
    '',
    '  add <path> [--id <slug>] [--label "<label>"] [--role project|fixture|archive]',
    '  add --path <path> [--id <slug>] [--label "<label>"] [--role project|fixture|archive]',
    '  list',
    '  show',
    '  remove <id>',
    '  role <id> <project|fixture|archive>',
    '  activate <id>     # signals live bridge to reroot when one is running',
  ].join('\n'));
}

// Best-effort: POST to a running bridge so its in-memory `active` pointer
// follows the registry update. If no bridge is up (ECONNREFUSED) we fall
// through silently and print a restart hint instead.
function postBridgeActivate(id, port = 4177) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ id });
    const req = request({
      host: '127.0.0.1', port, method: 'POST',
      path: '/bridge/_workspaces/activate',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 1500,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body); req.end();
  });
}

export default async function workspace(argv) {
  // --help discipline (B3): detect before any flag validation.
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }
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
      const role = (w.role || 'project').padEnd(8);
      console.log(`  ${tag} ${w.id.padEnd(22)} ${role} ${w.label.padEnd(28)} ${w.path}`);
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
    // v1.2.1 F5 — accept both `add <path>` (positional, legacy) and
    // `add --path <path>` (flag form, aligns with `plan complete --plan`,
    // etc.). If both are supplied we refuse rather than silently prefer one.
    const flagPath = typeof flags.path === 'string' ? flags.path : null;
    const posPath = positional[0] || null;
    if (flagPath && posPath) {
      console.error('maddu workspace add: pass <path> OR --path <path>, not both.');
      process.exit(2);
    }
    const path = flagPath || posPath;
    if (!path) {
      console.error('maddu workspace add <path> [--id <slug>] [--label "<label>"] [--role project|fixture|archive]');
      console.error('  or: maddu workspace add --path <path> [--id <slug>] [--label "<label>"] [--role project|fixture|archive]');
      process.exit(2);
    }
    const abs = resolve(process.cwd(), path);
    try {
      const w = await ws.addWorkspace({
        path: abs,
        id: typeof flags.id === 'string' ? flags.id : null,
        label: typeof flags.label === 'string' ? flags.label : null,
        role: typeof flags.role === 'string' ? flags.role : null
      });
      console.log(`added  ${w.id}  ${w.role || 'project'}  ${w.label}  ${w.path}`);
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

  if (sub === 'role') {
    const id = rest[0];
    const role = rest[1];
    if (!id || !role) { console.error('maddu workspace role <id> <project|fixture|archive>'); process.exit(2); }
    try {
      const w = await ws.setRole(id, role);
      console.log(`role  ${w.id}  ${w.role}`);
    } catch (err) {
      console.error(`maddu workspace role: ${err.message}`);
      process.exit(1);
    }
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
    // v1.1.1 B1: signal a running bridge so its active pointer + per-request
    // workspace resolution follow the registry. The bridge's
    // `/bridge/_workspaces/activate` route validates that the target id is
    // already mounted; if it isn't (the workspace was added after `maddu
    // start`), we print a LOUD restart hint instead of silently mis-routing.
    const result = await postBridgeActivate(id);
    if (result && result.status === 200) {
      console.log(`\x1b[2mbridge rerooted to "${id}" (in-memory active updated)\x1b[0m`);
    } else if (result && result.status === 404) {
      console.error('');
      console.error('\x1b[33mWARNING:\x1b[0m bridge is running but does not have this workspace mounted.');
      console.error(`  The new workspace "${id}" was added AFTER \`maddu start\`. The bridge is`);
      console.error('  still rooted in the previously-mounted set. Restart to pick it up:');
      console.error('    \x1b[1mmaddu stop && maddu start\x1b[0m');
    } else if (result && result.error && result.error !== 'ECONNREFUSED') {
      // ECONNREFUSED = no bridge running; that's fine for this code path.
      console.error(`\x1b[2mbridge signal failed: ${result.error} (workspace registry still updated)\x1b[0m`);
    }
    return;
  }

  console.error(`maddu workspace: unknown subcommand "${sub}"`);
  process.exit(2);
}
