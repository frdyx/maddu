// `maddu help` — interactive discovery guide for the v0.18 UX shell.
//
// Renders a tree of slash commands by topic, with one-line descriptions
// and example invocations. The cousin `/maddu-help` slash command points
// at this same surface from inside Claude Code / Codex.
//
// Output is plain text with ANSI colors when stdout is a TTY. No
// dependencies; reads only from process state + lists baked into this
// file (the framework's authoritative slash-command roster).
//
// Flags:
//   --topic <name>   filter to one topic group (autopilot|planning|review|team|cost|skills|admin)
//   --format <mode>  text (default) | json

import { parseFlags } from './_args.mjs';

// Slash-command roster. Kept in sync with template/maddu/agent-files/commands/.
// v0.19.1 (A3): phase tags removed — every entry below is shipping and live.
const ROSTER = [
  {
    topic: 'discovery',
    title: 'Discovery & doctor',
    items: [
      { name: '/maddu-help',    line: 'Print this guide.',                              under: 'help' },
      { name: '/maddu-doctor',  line: 'Run hard-rule gates and surface findings.',      under: 'doctor' },
      { name: '/maddu-suggest <task>', line: 'Recommend a slash command + lane for a vague task.', under: 'suggest' },
    ],
  },
  {
    topic: 'autopilot',
    title: 'Autopilot (end-to-end)',
    items: [
      { name: '/maddu-autopilot <task>', line: 'Register → claim → plan-exec-verify-fix → slice-stop.', under: 'register, suggest, lane claim, pipeline run, slice-stop' },
    ],
  },
  {
    topic: 'planning',
    title: 'Planning & review',
    items: [
      { name: '/maddu-plan <topic>',         line: 'Run the plan stage only; write a plan artifact.', under: 'goal, phase, brief' },
      { name: '/maddu-review [<slice-id>]',  line: 'Post-stop review of the current or named slice.',  under: 'review' },
    ],
  },
  {
    topic: 'team',
    title: 'Team & advisors',
    items: [
      { name: '/maddu-team <N> <task>',          line: 'Spawn N child sessions with disjoint lanes.',      under: 'team open' },
      { name: '/maddu-advise <runtime> <prompt>', line: 'Non-claiming advisor query; artifact-only.',     under: 'advise' },
    ],
  },
  {
    topic: 'cost',
    title: 'Status & cost',
    items: [
      { name: '/maddu-status',  line: 'Pretty-print sessions, lanes, gates, reviews, teams.', under: 'status, brief' },
      { name: '/maddu-cost',    line: 'Token/call rollup per session, day, runtime.',         under: 'cost' },
    ],
  },
  {
    topic: 'skills',
    title: 'Skills & notes',
    items: [
      { name: '/maddu-skill <verb> <args>', line: 'List, search, create, apply, delete skills.',  under: 'skill' },
      { name: '/maddu-note <text>',         line: 'One-liner into the operator inbox.',          under: 'mailbox send' },
    ],
  },
  {
    topic: 'admin',
    title: 'Cancel',
    items: [
      { name: '/maddu-cancel', line: 'Stop the current slice cleanly (heartbeat-close + slice-stop).', under: 'session close, slice-stop' },
    ],
  },
  {
    topic: 'tools',
    title: 'Default tools (v1.1.0)',
    items: [
      { name: '/maddu-git <argv…>',     line: 'Audited git wrapper; refuses empty -m and `push -f`.',        under: 'git' },
      { name: '/maddu-test [argv…]',    line: 'Auto-detect test runner (npm test / vitest / jest / mocha).', under: 'test' },
      { name: '/maddu-format [argv…]',  line: 'Auto-detect formatter (prettier / npm run format).',          under: 'format' },
      { name: '/maddu-lint [argv…]',    line: 'Auto-detect linter (eslint / npm run lint).',                 under: 'lint' },
      { name: '/maddu-install <pkgs…>', line: 'Audited dep install (npm/pnpm/yarn). Refuses empty list.',    under: 'install' },
    ],
  },
];

const C = {
  bold:  (s) => process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  dim:   (s) => process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s,
  cyan:  (s) => process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  yellow:(s) => process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s,
};

function printText(roster) {
  console.log(C.bold('Máddu — the no-learning-curve guide'));
  console.log('');
  console.log('Inside Claude Code or Codex CLI, you can type slash commands directly.');
  console.log('From a shell, the verbose ' + C.cyan('maddu <cmd>') + ' surface is always available.');
  console.log('');
  console.log(C.bold('Natural language works too:'));
  console.log('  type "ship the login form" or "status" and the agent will dispatch');
  console.log('  the right slash command and tell you which one it picked.');
  console.log('');
  console.log(C.bold('Slash commands by topic:'));
  console.log('');

  for (const group of roster) {
    console.log('  ' + C.bold(group.title));
    for (const item of group.items) {
      console.log('    ' + C.cyan(item.name.padEnd(34)) + ' ' + item.line);
      console.log('      ' + C.dim('└─ ' + item.under));
    }
    console.log('');
  }

  console.log(C.bold('Discovery helpers:'));
  console.log('  ' + C.cyan('maddu suggest --task "<vague task>"') + '   recommends a slash command + lane');
  console.log('  ' + C.cyan('maddu help --format json') + '              machine-readable roster');
  console.log('  ' + C.cyan('maddu doctor') + '                          hard-rule + gate diagnostics');
}

function filterByTopic(roster, topic) {
  if (!topic) return roster;
  const match = roster.filter((g) => g.topic === topic);
  return match.length ? match : roster;
}

export default async function help(argv) {
  const { flags } = parseFlags(argv);
  const topic = flags.topic || null;
  const format = flags.format || 'text';
  const filtered = filterByTopic(ROSTER, topic);
  if (format === 'json') {
    process.stdout.write(JSON.stringify({ topics: filtered }, null, 2) + '\n');
    return;
  }
  printText(filtered);
}
