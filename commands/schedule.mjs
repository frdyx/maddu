// `maddu schedule <subcommand>` — list / show / create / parse / enable / disable / remove / tick.
//
// Usage:
//   maddu schedule list
//   maddu schedule show <id>
//   maddu schedule create --natural "every evening at 6pm" --title "Daily summary"
//                          [--action-kind inbox|event] [--action-value "…"]
//   maddu schedule create --cron "0 18 * * *" --title "…" [--action-kind …]
//   maddu schedule parse "every weekday at 9am"        — preview the cron
//   maddu schedule enable | disable <id>
//   maddu schedule tick                                 — run one poller pass now
//   maddu schedule remove <id>

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', info: '\x1b[36m', accent: '\x1b[35m' };

function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function scheduleCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, schedule } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu schedule <list|show|create|parse|enable|disable|tick|remove> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const all = await schedule.listSchedules(repoRoot);
    console.log(`${ANSI.bold}SCHEDULES  (${all.length})${ANSI.reset}`);
    if (all.length === 0) { console.log('  (none — try `maddu schedule create --natural "every hour" --title test`)'); return; }
    for (const s of all) {
      const enabled = s.enabled ? `${ANSI.pass}on${ANSI.reset}` : `${ANSI.dim}off${ANSI.reset}`;
      console.log(`  ${ANSI.accent}${s.id}${ANSI.reset}  ${ANSI.bold}${s.title}${ANSI.reset}  ${enabled}`);
      console.log(`    ${ANSI.dim}cron:${ANSI.reset}     ${s.cron}${s.natural ? `   ${ANSI.dim}(« ${s.natural} »)${ANSI.reset}` : ''}`);
      console.log(`    ${ANSI.dim}action:${ANSI.reset}   ${s.action?.kind}: ${s.action?.value || '—'}`);
      console.log(`    ${ANSI.dim}fires:${ANSI.reset}    ${s.fireCount}  ${ANSI.dim}last:${ANSI.reset} ${fmt(s.lastRun)}`);
    }
    return;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu schedule show <id>'); process.exit(2); }
    const s = await schedule.readSchedule(repoRoot, id);
    if (!s) { console.error(`schedule ${id} not found`); process.exit(3); }
    console.log(`${ANSI.bold}${s.title}${ANSI.reset}  ${ANSI.dim}(${s.id})${ANSI.reset}`);
    console.log(`  enabled:    ${s.enabled ? 'yes' : 'no'}`);
    console.log(`  cron:       ${s.cron}`);
    if (s.natural) console.log(`  natural:    ${s.natural}`);
    console.log(`  action:     ${s.action?.kind} → ${s.action?.value || '—'}`);
    console.log(`  fires:      ${s.fireCount}`);
    console.log(`  lastRun:    ${fmt(s.lastRun)}`);
    console.log(`  created:    ${fmt(s.createdAt)}  by ${s.createdBy || '—'}`);
    console.log(`  updated:    ${fmt(s.updatedAt)}`);
    return;
  }

  if (sub === 'parse') {
    const { positional } = parseFlags(rest);
    const text = positional.join(' ');
    if (!text) { console.error('usage: maddu schedule parse "<natural language>"'); process.exit(2); }
    const cron = schedule.parseNatural(text);
    if (!cron) { console.log(`${ANSI.fail}✗${ANSI.reset} could not parse "${text}"`); process.exit(4); }
    console.log(`${ANSI.pass}${cron}${ANSI.reset}  ${ANSI.dim}« ${text} »${ANSI.reset}`);
    return;
  }

  if (sub === 'create') {
    const { flags } = parseFlags(rest);
    const patch = {
      title: flags.title,
      natural: flags.natural,
      cron: flags.cron,
      action: {
        kind: flags['action-kind'] || 'inbox',
        value: flags['action-value'] || flags.title || 'scheduled fire'
      },
      enabled: flags.disabled ? false : true
    };
    try {
      const saved = await schedule.saveSchedule(repoRoot, patch, flags.by || null);
      console.log(`${ANSI.pass}created${ANSI.reset}  ${saved.id}  ${saved.cron}${saved.natural ? `  « ${saved.natural} »` : ''}`);
    } catch (err) {
      console.error(`${ANSI.fail}create failed:${ANSI.reset} ${err.message}`);
      process.exit(5);
    }
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = rest[0];
    if (!id) { console.error(`usage: maddu schedule ${sub} <id>`); process.exit(2); }
    try { await schedule.setEnabled(repoRoot, id, sub === 'enable'); }
    catch (err) { console.error(err.message); process.exit(3); }
    const c = sub === 'enable' ? ANSI.pass : ANSI.dim;
    console.log(`${c}${sub === 'enable' ? 'enabled' : 'disabled'}${ANSI.reset}  ${id}`);
    return;
  }

  if (sub === 'remove') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu schedule remove <id>'); process.exit(2); }
    await schedule.removeSchedule(repoRoot, id);
    console.log(`${ANSI.warn}removed${ANSI.reset}  ${id}`);
    return;
  }

  if (sub === 'tick') {
    const { flags } = parseFlags(rest);
    const now = flags.at ? new Date(flags.at) : new Date();
    const fired = await schedule.tick(repoRoot, now);
    console.log(`tick at ${fmt(now.toISOString())}  fired: ${fired.length}`);
    for (const f of fired) console.log(`  ${ANSI.pass}↦${ANSI.reset} ${f.id}  ${f.title}`);
    return;
  }

  console.error(`maddu schedule: unknown subcommand "${sub}"`);
  process.exit(2);
}
