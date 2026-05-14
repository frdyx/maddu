// `maddu checkpoint <subcommand>` — list / show / create / worktree / rollback / remove.
//
// Usage:
//   maddu checkpoint list [--lane <l>]
//   maddu checkpoint show <id>
//   maddu checkpoint create [--lane <l>] [--title "…"]
//   maddu checkpoint worktree <id>             — `git worktree add` into .maddu/checkpoints/<id>/
//   maddu checkpoint rollback <id> [--mode softHead|hardHead|branch|inspect] [--apply]
//                                              — without --apply, prints commands only
//   maddu checkpoint remove <id>

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', info: '\x1b[36m', accent: '\x1b[35m' };
function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function checkpoint(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, checkpoints } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu checkpoint <list|show|create|worktree|rollback|remove> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const { flags } = parseFlags(rest);
    let all = await checkpoints.listCheckpoints(repoRoot);
    if (flags.lane) all = all.filter((c) => c.lane === flags.lane);
    console.log(`${ANSI.bold}CHECKPOINTS  (${all.length})${ANSI.reset}`);
    if (all.length === 0) { console.log('  (none — try `maddu checkpoint create --title "before risky slice"`)'); return; }
    for (const c of all) {
      console.log(`  ${ANSI.accent}${c.id}${ANSI.reset}  ${ANSI.bold}${c.title}${ANSI.reset}  ${ANSI.dim}${c.commit.slice(0, 8)}${ANSI.reset}`);
      const meta = [];
      if (c.lane) meta.push(`lane:${c.lane}`);
      if (c.branch) meta.push(`branch:${c.branch}`);
      if (c.hasWorktree) meta.push(`worktree:${ANSI.pass}yes${ANSI.reset}`);
      meta.push(`at:${fmt(c.ts)}`);
      console.log(`    ${ANSI.dim}${meta.join('  ·  ')}${ANSI.reset}`);
      if (c.subject) console.log(`    ${ANSI.dim}msg:${ANSI.reset} ${c.subject}`);
    }
    return;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu checkpoint show <id>'); process.exit(2); }
    const c = await checkpoints.readCheckpoint(repoRoot, id);
    if (!c) { console.error(`checkpoint ${id} not found`); process.exit(3); }
    console.log(`${ANSI.bold}${c.title}${ANSI.reset}  ${ANSI.dim}(${c.id})${ANSI.reset}`);
    console.log(`  commit:      ${c.commit}`);
    console.log(`  branch:      ${c.branch || '—'}`);
    console.log(`  tag:         ${c.tag}`);
    console.log(`  lane:        ${c.lane || '—'}`);
    console.log(`  ts:          ${fmt(c.ts)}  by ${c.createdBy || '—'}`);
    console.log(`  worktree:    ${c.hasWorktree ? c.worktreePath : '—'}`);
    if (c.subject) console.log(`  subject:     ${c.subject}`);
    return;
  }

  if (sub === 'create') {
    const { flags } = parseFlags(rest);
    try {
      const cp = await checkpoints.createCheckpoint(repoRoot, { lane: flags.lane || null, title: flags.title || null, by: flags.by || null });
      console.log(`${ANSI.pass}created${ANSI.reset}  ${cp.id}  ${ANSI.dim}${cp.commit.slice(0, 8)}${ANSI.reset}  ${cp.title}`);
    } catch (err) {
      console.error(`${ANSI.fail}create failed:${ANSI.reset} ${err.message}`);
      process.exit(4);
    }
    return;
  }

  if (sub === 'worktree') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu checkpoint worktree <id>'); process.exit(2); }
    try {
      const out = await checkpoints.createWorktree(repoRoot, id);
      console.log(`${ANSI.pass}worktree${ANSI.reset}  ${out.path}${out.alreadyExisted ? ` ${ANSI.dim}(already existed)${ANSI.reset}` : ''}`);
    } catch (err) { console.error(`${ANSI.fail}worktree failed:${ANSI.reset} ${err.message}`); process.exit(5); }
    return;
  }

  if (sub === 'rollback') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu checkpoint rollback <id> [--mode softHead|hardHead|branch|inspect] [--apply]'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    const mode = flags.mode || 'inspect';
    const apply = !!flags.apply;
    try {
      const out = await checkpoints.rollback(repoRoot, id, { apply, mode, by: flags.by || null });
      if (out.applied) {
        console.log(`${ANSI.pass}applied${ANSI.reset}  mode:${mode}`);
        console.log(`  ${ANSI.dim}commands:${ANSI.reset}`);
        for (const c of out.commands) console.log(`    ${c}`);
        if (out.output) console.log(`  ${ANSI.dim}output:${ANSI.reset} ${out.output}`);
      } else {
        console.log(`${ANSI.warn}preview${ANSI.reset}  (dry-run — pass --apply --mode <m> to execute)`);
        for (const [name, cmds] of Object.entries(out.recovery)) {
          console.log(`\n  ${ANSI.bold}${name}${ANSI.reset}`);
          for (const c of cmds) console.log(`    ${c}`);
        }
      }
    } catch (err) { console.error(`${ANSI.fail}rollback failed:${ANSI.reset} ${err.message}`); process.exit(6); }
    return;
  }

  if (sub === 'remove') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu checkpoint remove <id>'); process.exit(2); }
    await checkpoints.removeCheckpoint(repoRoot, id);
    console.log(`${ANSI.warn}removed${ANSI.reset}  ${id}`);
    return;
  }

  console.error(`maddu checkpoint: unknown subcommand "${sub}"`);
  process.exit(2);
}
