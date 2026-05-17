// `maddu global <subcommand>` — machine-scope crons + standing approval policies.
//
// Usage:
//   maddu global cron add --natural "every minute" --title "tick"
//                          [--cron "*/5 * * * *"] [--action inbox] [--value "…"]
//                          [--targets r1,r2]            (comma-separated; omit = all)
//                          [--disabled]
//   maddu global cron list
//   maddu global cron show <id>
//   maddu global cron enable | disable <id>
//   maddu global cron remove <id>
//
//   maddu global policy add --tool bash --decision deny [--lane <lane>]
//   maddu global policy list
//   maddu global policy remove <tool>@<lane|*>
//
// Files live at ~/.config/maddu/global/{schedules.ndjson, policies.json}
// (or %APPDATA%\maddu\global\… on Windows). The bridge picks up changes
// on its next 30 s tick (schedules) or the next APPROVAL_REQUESTED
// (policies) — no restart required.

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
import { parseFlags } from './_args.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frameworkRoot = resolve(__dirname, '..');

async function loadGlobalLib() {
  const candidates = [
    join(process.cwd(), 'maddu', 'runtime', 'lib', 'global.mjs'),
    join(frameworkRoot, 'template', 'maddu', 'runtime', 'lib', 'global.mjs')
  ];
  for (const c of candidates) {
    try { await stat(c); return await import(pathToFileURL(c).href); } catch {}
  }
  throw new Error('global.mjs not found. Run `maddu init` first.');
}

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', accent: '\x1b[35m' };

function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function parseTargets(value) {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function printHelp() {
  console.error('Usage: maddu global <cron|policy> <subcommand> [args]');
}

async function cron(sub, rest, lib) {
  if (sub === 'list') {
    const all = await lib.listGlobalSchedules();
    console.log(`${ANSI.bold}GLOBAL CRONS  (${all.length})${ANSI.reset}  file: ${lib.globalSchedulesPath()}`);
    if (!all.length) { console.log('  (none — try `maddu global cron add --natural "every hour" --title test`)'); return; }
    for (const s of all) {
      const enabled = s.enabled ? `${ANSI.pass}on${ANSI.reset}` : `${ANSI.dim}off${ANSI.reset}`;
      const targets = (s.targets && s.targets.length) ? s.targets.join(',') : '(all workspaces)';
      console.log(`  ${ANSI.accent}${s.id}${ANSI.reset}  ${ANSI.bold}${s.title}${ANSI.reset}  ${enabled}`);
      console.log(`    ${ANSI.dim}cron:${ANSI.reset}    ${s.cron}${s.natural ? `   ${ANSI.dim}(« ${s.natural} »)${ANSI.reset}` : ''}`);
      console.log(`    ${ANSI.dim}action:${ANSI.reset}  ${s.action?.kind}: ${s.action?.value || '—'}`);
      console.log(`    ${ANSI.dim}targets:${ANSI.reset} ${targets}`);
      console.log(`    ${ANSI.dim}fires:${ANSI.reset}   ${s.fireCount}  ${ANSI.dim}last:${ANSI.reset} ${fmt(s.lastRun)}`);
    }
    return;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu global cron show <id>'); process.exit(2); }
    const s = await lib.readGlobalSchedule(id);
    if (!s) { console.error(`global cron ${id} not found`); process.exit(3); }
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  if (sub === 'add') {
    const { flags } = parseFlags(rest);
    const patch = {
      title: flags.title,
      natural: flags.natural,
      cron: flags.cron,
      action: {
        kind: flags.action || 'inbox',
        value: flags.value || flags.title || 'scheduled fire'
      },
      targets: parseTargets(flags.targets),
      enabled: flags.disabled ? false : true
    };
    try {
      const saved = await lib.saveGlobalSchedule(patch, flags.by || 'operator');
      const targetStr = saved.targets.length ? saved.targets.join(',') : '(all workspaces)';
      console.log(`${ANSI.pass}added${ANSI.reset}  ${saved.id}  ${saved.cron}  → ${targetStr}`);
    } catch (err) { console.error(`${ANSI.fail}add failed:${ANSI.reset} ${err.message}`); process.exit(5); }
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = rest[0];
    if (!id) { console.error(`usage: maddu global cron ${sub} <id>`); process.exit(2); }
    try { await lib.setGlobalEnabled(id, sub === 'enable'); }
    catch (err) { console.error(err.message); process.exit(3); }
    console.log(`${sub === 'enable' ? ANSI.pass + 'enabled' : ANSI.dim + 'disabled'}${ANSI.reset}  ${id}`);
    return;
  }

  if (sub === 'remove') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu global cron remove <id>'); process.exit(2); }
    await lib.removeGlobalSchedule(id);
    console.log(`${ANSI.warn}removed${ANSI.reset}  ${id}`);
    return;
  }

  console.error(`maddu global cron: unknown subcommand "${sub}"`);
  process.exit(2);
}

async function policy(sub, rest, lib) {
  if (sub === 'list') {
    const all = await lib.listGlobalPolicies();
    console.log(`${ANSI.bold}GLOBAL POLICIES  (${all.length})${ANSI.reset}  file: ${lib.globalPoliciesPath()}`);
    if (!all.length) { console.log('  (none — try `maddu global policy add --tool bash --decision deny`)'); return; }
    for (const p of all) {
      const dec = p.decision === 'deny' ? ANSI.fail : ANSI.pass;
      console.log(`  ${dec}${p.decision.padEnd(13)}${ANSI.reset}  ${ANSI.accent}${p.id}${ANSI.reset}  ${ANSI.dim}set ${fmt(p.setAt)} by ${p.setBy || '—'}${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'add') {
    const { flags } = parseFlags(rest);
    const tool = flags.tool;
    const decision = flags.decision;
    const lane = flags.lane || null;
    if (!tool) { console.error('--tool required (use "*" for any tool)'); process.exit(2); }
    if (!decision) { console.error('--decision required (allow-always | deny)'); process.exit(2); }
    try {
      const p = await lib.saveGlobalPolicy({ tool, lane, decision }, flags.by || 'operator');
      console.log(`${ANSI.pass}added${ANSI.reset}  ${p.id}  ${p.decision}`);
    } catch (err) { console.error(`${ANSI.fail}add failed:${ANSI.reset} ${err.message}`); process.exit(5); }
    return;
  }

  if (sub === 'remove') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu global policy remove <tool>@<lane|*>'); process.exit(2); }
    const ok = await lib.removeGlobalPolicy(id);
    if (!ok) { console.error(`unknown policy: ${id}`); process.exit(1); }
    console.log(`${ANSI.warn}removed${ANSI.reset}  ${id}`);
    return;
  }

  console.error(`maddu global policy: unknown subcommand "${sub}"`);
  process.exit(2);
}

export default async function globalCmd(argv) {
  const verb = argv[0];
  const sub = argv[1];
  const rest = argv.slice(2);
  if (!verb || !sub) { printHelp(); process.exit(2); }

  const lib = await loadGlobalLib();

  if (verb === 'cron')   return await cron(sub, rest, lib);
  if (verb === 'policy') return await policy(sub, rest, lib);

  console.error(`maddu global: unknown verb "${verb}" (expected: cron | policy)`);
  process.exit(2);
}
