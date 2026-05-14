// `maddu runtime <subcommand>` — list / show / register / detect / spawn / remove.
//
// Usage:
//   maddu runtime list
//   maddu runtime show <name>
//   maddu runtime register --name <n> --binary <b> [--args a,b] [--detect "cmd"]
//                          [--display "…"] [--mcp] [--streaming] [--approval per-tool]
//                          [--notes "…"]
//   maddu runtime detect [<name>]      (no arg → detect-all)
//   maddu runtime spawn <name> [--session <sid>] [--lane <id>] [--args a,b]
//   maddu runtime remove <name>

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', info: '\x1b[36m', accent: '\x1b[35m' };

function csv(s) { if (!s || s === true) return []; return String(s).split(',').map((x) => x.trim()).filter(Boolean); }
function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function healthBadge(h) {
  if (!h) return `${ANSI.dim}—${ANSI.reset}`;
  if (h.ok) return `${ANSI.pass}✓${ANSI.reset} ${h.version ? ANSI.dim + h.version + ANSI.reset : ''}`;
  if (h.exitCode != null) return `${ANSI.fail}✗${ANSI.reset} ${ANSI.dim}exit ${h.exitCode}${ANSI.reset}`;
  return `${ANSI.fail}✗${ANSI.reset} ${ANSI.dim}${h.error || 'unknown'}${ANSI.reset}`;
}

export default async function runtime(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, runtimes } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu runtime <list|show|register|detect|spawn|remove> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const all = await runtimes.listRuntimes(repoRoot);
    const health = await runtimes.runtimesHealth(repoRoot);
    console.log(`${ANSI.bold}RUNTIMES  (${all.length})${ANSI.reset}`);
    if (all.length === 0) {
      console.log('  (none — try `maddu runtime register --name claude-code --binary claude --args exec --detect "claude --version"`)');
      return;
    }
    for (const r of all) {
      console.log(`  ${ANSI.accent}${r.name.padEnd(18)}${ANSI.reset}  ${r.displayName || r.name}`);
      console.log(`    ${ANSI.dim}binary:${ANSI.reset} ${r.binary || '—'}  ${ANSI.dim}args:${ANSI.reset} ${(r.args || []).join(' ') || '—'}`);
      console.log(`    ${ANSI.dim}detect:${ANSI.reset} ${healthBadge(health[r.name])}`);
      const caps = [];
      if (r.capabilities?.mcp) caps.push('mcp');
      if (r.capabilities?.tools) caps.push('tools');
      if (r.capabilities?.streaming) caps.push('streaming');
      if (r.capabilities?.approval) caps.push(`approval:${r.capabilities.approval}`);
      if (caps.length) console.log(`    ${ANSI.dim}capabilities:${ANSI.reset} ${caps.join(', ')}`);
    }
    return;
  }

  if (sub === 'show') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu runtime show <name>'); process.exit(2); }
    const r = await runtimes.readRuntime(repoRoot, name);
    if (!r) { console.error(`runtime ${name} not found`); process.exit(3); }
    const h = (await runtimes.runtimesHealth(repoRoot))[name];
    console.log(`${ANSI.bold}${r.displayName || r.name}${ANSI.reset}  ${ANSI.dim}(${r.name})${ANSI.reset}`);
    console.log(`  binary:        ${r.binary || '—'}`);
    console.log(`  args:          ${(r.args || []).join(' ') || '—'}`);
    console.log(`  protocol:      ${r.protocol || '—'}`);
    console.log(`  capabilities:  mcp=${r.capabilities?.mcp ? 'yes' : 'no'}  tools=${r.capabilities?.tools ? 'yes' : 'no'}  streaming=${r.capabilities?.streaming ? 'yes' : 'no'}  approval=${r.capabilities?.approval || '—'}`);
    if (r.spawn?.cwd)      console.log(`  cwd:           ${r.spawn.cwd}`);
    if (r.spawn?.env?.length) console.log(`  env:           ${r.spawn.env.join(', ')}`);
    if (r.detect?.command) console.log(`  detect:        \`${r.detect.command}\``);
    console.log(`  health:        ${healthBadge(h)}`);
    if (h?.at) console.log(`  last checked:  ${fmt(h.at)}`);
    if (r.notes) console.log(`\n${r.notes}`);
    return;
  }

  if (sub === 'register') {
    const { flags } = parseFlags(rest);
    const name = requireFlag(flags, 'name');
    const patch = {
      name,
      displayName: flags.display || name,
      binary: flags.binary || null,
      args: csv(flags.args),
      protocol: flags.protocol || 'stdio-json',
      capabilities: {
        mcp: !!flags.mcp,
        tools: !!flags.tools,
        streaming: !!flags.streaming,
        approval: flags.approval || 'manual'
      },
      detect: { command: flags.detect || null, expectExit: 0 },
      lanes: csv(flags.lanes).length ? csv(flags.lanes) : ['*'],
      notes: flags.notes || ''
    };
    const saved = await runtimes.saveRuntime(repoRoot, patch, flags.by || null);
    console.log(`${ANSI.pass}registered${ANSI.reset}  ${saved.name}`);
    return;
  }

  if (sub === 'detect') {
    const name = rest[0];
    if (!name) {
      const results = await runtimes.detectAll(repoRoot);
      console.log(`${ANSI.bold}DETECT ALL  (${results.length})${ANSI.reset}`);
      for (const r of results) console.log(`  ${r.name.padEnd(18)}  ${healthBadge(r)}`);
      return;
    }
    const r = await runtimes.detectRuntime(repoRoot, name);
    console.log(`${r.name}  ${healthBadge(r)}`);
    if (r.stdout) console.log(`  ${ANSI.dim}${r.stdout.split('\n').join('\n  ')}${ANSI.reset}`);
    return;
  }

  if (sub === 'spawn') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu runtime spawn <name>'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    const out = await runtimes.spawnWorker(repoRoot, name, {
      session: flags.session || null,
      lane: flags.lane || null,
      extraArgs: csv(flags.args)
    });
    if (out.error) {
      console.log(`${ANSI.fail}spawn failed${ANSI.reset}  ${out.error}`);
      console.log(`  workerId: ${out.workerId}  (recorded as exited)`);
      process.exit(4);
    }
    console.log(`${ANSI.pass}spawned${ANSI.reset}  ${out.workerId}  pid:${out.pid}`);
    console.log(`  log: ${out.log}`);
    return;
  }

  if (sub === 'remove') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu runtime remove <name>'); process.exit(2); }
    await runtimes.removeRuntime(repoRoot, name);
    console.log(`${ANSI.warn}removed${ANSI.reset}  ${name}`);
    return;
  }

  console.error(`maddu runtime: unknown subcommand "${sub}"`);
  process.exit(2);
}
