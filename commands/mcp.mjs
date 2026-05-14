// `maddu mcp <subcommand>` — list / show / register / enable / disable / test / remove / visible.
//
// Usage:
//   maddu mcp list
//   maddu mcp show <name>
//   maddu mcp register --name <n> --transport stdio --command <bin> [--args a,b] [--lanes a,b]
//                       [--display "…"] [--notes "…"]
//                       (or --transport http --url <u>  /  --transport sse --url <u>)
//   maddu mcp enable  <name>
//   maddu mcp disable <name>
//   maddu mcp test    [<name>]      (no arg → test-all)
//   maddu mcp remove  <name>
//   maddu mcp visible <lane>

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', info: '\x1b[36m', accent: '\x1b[35m' };

function csv(s) { if (!s || s === true) return []; return String(s).split(',').map((x) => x.trim()).filter(Boolean); }
function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function badge(h) {
  if (!h) return `${ANSI.dim}—${ANSI.reset}`;
  if (h.skipped) return `${ANSI.dim}skipped${ANSI.reset} ${ANSI.dim}${h.reason || ''}${ANSI.reset}`;
  if (h.ok) return `${ANSI.pass}✓${ANSI.reset} ${ANSI.dim}${h.status || h.note || ''}${ANSI.reset}`;
  return `${ANSI.fail}✗${ANSI.reset} ${ANSI.dim}${h.error || ('status ' + h.status)}${ANSI.reset}`;
}

export default async function mcpCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, mcp } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu mcp <list|show|register|enable|disable|test|remove|visible> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const all = await mcp.listMcp(repoRoot);
    const h = await mcp.mcpHealth(repoRoot);
    console.log(`${ANSI.bold}MCP SERVERS  (${all.length})${ANSI.reset}`);
    if (all.length === 0) { console.log('  (none registered)'); return; }
    for (const r of all) {
      const enabled = r.enabled ? `${ANSI.pass}on${ANSI.reset}` : `${ANSI.dim}off${ANSI.reset}`;
      console.log(`  ${ANSI.accent}${r.name.padEnd(20)}${ANSI.reset}  ${r.displayName || r.name}  ${enabled}`);
      console.log(`    ${ANSI.dim}transport:${ANSI.reset} ${r.transport}  ${ANSI.dim}lanes:${ANSI.reset} ${(r.lanes || ['*']).join(', ')}`);
      console.log(`    ${ANSI.dim}health:${ANSI.reset}    ${badge(h[r.name])}`);
    }
    return;
  }

  if (sub === 'show') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu mcp show <name>'); process.exit(2); }
    const r = await mcp.readMcp(repoRoot, name);
    if (!r) { console.error(`mcp ${name} not found`); process.exit(3); }
    const h = (await mcp.mcpHealth(repoRoot))[name];
    console.log(`${ANSI.bold}${r.displayName || r.name}${ANSI.reset}  ${ANSI.dim}(${r.name})${ANSI.reset}`);
    console.log(`  transport:  ${r.transport}`);
    console.log(`  enabled:    ${r.enabled ? 'yes' : 'no'}`);
    console.log(`  lanes:      ${(r.lanes || ['*']).join(', ')}`);
    console.log(`  slot:       ${r.slot || '—'}`);
    if (r.transport === 'stdio') {
      console.log(`  command:    ${r.stdio?.command || '—'}`);
      console.log(`  args:       ${(r.stdio?.args || []).join(' ') || '—'}`);
    } else {
      const cfg = r[r.transport] || {};
      console.log(`  url:        ${cfg.url || '—'}`);
    }
    console.log(`  health:     ${badge(h)}`);
    if (h?.at) console.log(`  last test:  ${fmt(h.at)}`);
    if (r.notes) console.log(`\n${r.notes}`);
    return;
  }

  if (sub === 'register') {
    const { flags } = parseFlags(rest);
    const name = requireFlag(flags, 'name');
    const transport = flags.transport || 'stdio';
    const patch = {
      name,
      displayName: flags.display || name,
      transport,
      enabled: flags.disabled ? false : true,
      lanes: csv(flags.lanes).length ? csv(flags.lanes) : ['*'],
      notes: flags.notes || ''
    };
    if (transport === 'stdio') {
      patch.stdio = { command: flags.command || null, args: csv(flags.args), env: csv(flags.env) };
    } else if (transport === 'sse') {
      patch.sse = { url: flags.url || null };
    } else if (transport === 'http') {
      patch.http = { url: flags.url || null };
    }
    const saved = await mcp.saveMcp(repoRoot, patch, flags.by || null);
    console.log(`${ANSI.pass}registered${ANSI.reset}  ${saved.name}  (${saved.transport})`);
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const name = rest[0];
    if (!name) { console.error(`usage: maddu mcp ${sub} <name>`); process.exit(2); }
    await mcp.setEnabled(repoRoot, name, sub === 'enable');
    const c = sub === 'enable' ? ANSI.pass : ANSI.dim;
    console.log(`${c}${sub === 'enable' ? 'enabled' : 'disabled'}${ANSI.reset}  ${name}`);
    return;
  }

  if (sub === 'test') {
    const name = rest[0];
    if (!name) {
      const results = await mcp.testAll(repoRoot);
      console.log(`${ANSI.bold}TEST ALL  (${results.length})${ANSI.reset}`);
      for (const r of results) console.log(`  ${r.name.padEnd(20)}  ${badge(r)}`);
      return;
    }
    const r = await mcp.testMcp(repoRoot, name);
    console.log(`${name}  ${badge(r)}`);
    if (r.sample) console.log(`  ${ANSI.dim}${r.sample.split('\n').slice(0, 3).join('\n  ')}${ANSI.reset}`);
    return;
  }

  if (sub === 'remove') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu mcp remove <name>'); process.exit(2); }
    await mcp.removeMcp(repoRoot, name);
    console.log(`${ANSI.warn}removed${ANSI.reset}  ${name}`);
    return;
  }

  if (sub === 'visible') {
    const lane = rest[0];
    if (!lane) { console.error('usage: maddu mcp visible <lane>'); process.exit(2); }
    const all = await mcp.visibleFor(repoRoot, lane);
    console.log(`${ANSI.bold}VISIBLE for lane "${lane}"  (${all.length})${ANSI.reset}`);
    for (const r of all) console.log(`  ${r.name}  ${ANSI.dim}(${r.transport})${ANSI.reset}`);
    return;
  }

  console.error(`maddu mcp: unknown subcommand "${sub}"`);
  process.exit(2);
}
