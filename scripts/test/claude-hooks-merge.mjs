#!/usr/bin/env node
// claude-hooks-merge — the .claude/settings.json merge/strip logic (v1.74.0).
//
// `maddu hooks install` wires SessionStart(auto-register) + SessionEnd(close)
// into a HOST-repo file, so it must be idempotent and must never disturb the
// user's own hooks/settings. This locks the pure merge/strip/summarize logic
// without touching disk.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mergeInstall, stripMaddu, summarize, MADDU_HOOKS, hookCommandFor } from '../../template/maddu/runtime/lib/claude-hooks.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function main() {
  // ── install into an empty settings object ──
  const a = mergeInstall({});
  ok('install wires every Máddu hook event', summarize(a).allInstalled, JSON.stringify(summarize(a).installed));
  ok('SessionStart command is the node entrypoint', a.hooks.SessionStart[0].hooks[0].command === hookCommandFor('session-start'));

  // ── idempotency: re-install is byte-identical ──
  const b = mergeInstall(a);
  ok('re-install is idempotent (deep-equal)', JSON.stringify(a) === JSON.stringify(b));

  // ── preserve a user's own hooks + unrelated settings ──
  const user = {
    permissions: { allow: ['Bash'] },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo edit' }] }],
    },
  };
  const merged = mergeInstall(user);
  ok('user permissions preserved', JSON.stringify(merged.permissions) === JSON.stringify(user.permissions));
  ok('user PreToolUse hook preserved', merged.hooks.PreToolUse[0].hooks[0].command === 'echo edit');
  ok('user SessionStart hook preserved alongside ours', merged.hooks.SessionStart.some((g) => g.hooks[0].command === 'echo hi'));
  ok('our SessionStart hook added', merged.hooks.SessionStart.some((g) => g.hooks[0].command === hookCommandFor('session-start')));

  // ── strip removes only ours ──
  const stripped = stripMaddu(merged);
  ok('strip leaves the user SessionStart hook', stripped.hooks.SessionStart.length === 1 && stripped.hooks.SessionStart[0].hooks[0].command === 'echo hi');
  ok('strip leaves PreToolUse + permissions', stripped.hooks.PreToolUse && JSON.stringify(stripped.permissions) === JSON.stringify(user.permissions));
  ok('strip clears our SessionEnd event entirely', !stripped.hooks.SessionEnd);
  ok('after strip, summarize reports nothing installed', summarize(stripped).installed.length === 0);

  // ── strip a settings object that only had ours → hooks key removed ──
  const onlyOurs = mergeInstall({});
  const cleaned = stripMaddu(onlyOurs);
  ok('stripping an only-Máddu file removes the hooks key', !cleaned.hooks);

  // ── re-install after a command-text change still de-dupes (no stacking) ──
  const twice = mergeInstall(mergeInstall({}));
  ok('no duplicate Máddu groups after double install', twice.hooks.SessionStart.length === 1);

  ok('MADDU_HOOKS covers SessionStart + SessionEnd', MADDU_HOOKS.map((h) => h.event).join(',') === 'SessionStart,SessionEnd');
}

try {
  await main();
  console.log('');
  console.log(`claude-hooks-merge: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('claude-hooks-merge OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
