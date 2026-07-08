#!/usr/bin/env node
// claude-hooks-merge — the .claude/settings.json merge/strip logic (v1.74.0).
//
// `maddu hooks install` wires SessionStart(auto-register) + SessionEnd(close)
// into a HOST-repo file, so it must be idempotent and must never disturb the
// user's own hooks/settings. This locks the pure merge/strip/summarize logic
// without touching disk.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mergeInstall, stripMaddu, summarize, MADDU_HOOKS, hookCommandFor, resolveHookBin, HOOK_BIN, HOOK_BIN_SOURCE, mergeStatusLine, stripStatusLine, statusLineInstalled, statusLineCommandFor } from '../../template/maddu/runtime/lib/claude-hooks.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  ok('MADDU_HOOKS covers SessionStart + SessionEnd + PreCompact + PreToolUse', MADDU_HOOKS.map((h) => h.event).join(',') === 'SessionStart,SessionEnd,PreCompact,PreToolUse');

  // ── source-repo bin resolution (v1.89.1) — the dogfood bug: the framework
  // source repo has bin/maddu.mjs, not maddu/bin/maddu.mjs; installing the
  // consumer command there produced hooks that errored on every fire. ──
  const srcBin = mergeInstall({}, { bin: HOOK_BIN_SOURCE });
  ok('mergeInstall honors a bin override', srcBin.hooks.SessionStart[0].hooks[0].command === `${HOOK_BIN_SOURCE} hooks fire session-start`);
  ok('strip still identifies bin-overridden entries (sentinel match)', !stripMaddu(srcBin).hooks);
  {
    const consumer = await mkdtemp(join(tmpdir(), 'maddu-chm-consumer-'));
    await mkdir(join(consumer, 'maddu', 'bin'), { recursive: true });
    await writeFile(join(consumer, 'maddu', 'bin', 'maddu.mjs'), '// stub');
    ok('resolveHookBin: consumer layout → maddu/bin', await resolveHookBin(consumer) === HOOK_BIN);
    await rm(consumer, { recursive: true, force: true });

    const source = await mkdtemp(join(tmpdir(), 'maddu-chm-source-'));
    await mkdir(join(source, 'bin'), { recursive: true });
    await writeFile(join(source, 'bin', 'maddu.mjs'), '// stub');
    ok('resolveHookBin: source layout → bin/', await resolveHookBin(source) === HOOK_BIN_SOURCE);
    await rm(source, { recursive: true, force: true });

    const bare = await mkdtemp(join(tmpdir(), 'maddu-chm-bare-'));
    ok('resolveHookBin: unknown layout → consumer default', await resolveHookBin(bare) === HOOK_BIN);
    await rm(bare, { recursive: true, force: true });
  }
  // The real framework source checkout resolves to the source bin.
  const HERE = dirname(fileURLToPath(import.meta.url));
  ok('resolveHookBin: this repo (framework source) → bin/', await resolveHookBin(resolve(HERE, '..', '..')) === HOOK_BIN_SOURCE);
  ok('install wires the PreCompact checkpoint hook', a.hooks.PreCompact?.[0]?.hooks?.[0]?.command === hookCommandFor('pre-compact'));
  ok('PreCompact group has no matcher (fires on manual AND auto)', !('matcher' in (a.hooks.PreCompact?.[0] || { matcher: 1 })));
  // PreToolUse auto-claim hook: wired, carries the file-mutating-tools matcher.
  ok('install wires the PreToolUse auto-claim hook', a.hooks.PreToolUse?.some((g) => g.hooks?.[0]?.command === hookCommandFor('pre-tool-use')));
  ok('PreToolUse Máddu group carries the Edit|Write matcher', a.hooks.PreToolUse?.find((g) => g.hooks?.[0]?.command === hookCommandFor('pre-tool-use'))?.matcher === 'Edit|Write|MultiEdit|NotebookEdit');
  // A user's own PreToolUse hook is preserved alongside ours (merge fixture up top).
  ok('strip removes only our PreToolUse group', (() => { const s = stripMaddu(a); return !s.hooks || !s.hooks.PreToolUse; })());

  // ── statusLine (opt-in, v1.97.0) ──
  {
    // fresh install writes ours into an empty slot
    const s1 = mergeStatusLine({});
    ok('mergeStatusLine writes ours when slot empty', !s1.skipped && s1.settings.statusLine.command === statusLineCommandFor());
    ok('statusLineInstalled true after merge', statusLineInstalled(s1.settings));

    // idempotent
    const s2 = mergeStatusLine(s1.settings);
    ok('mergeStatusLine idempotent', JSON.stringify(s1.settings) === JSON.stringify(s2.settings) && !s2.skipped);

    // never clobbers the operator's own statusLine
    const own = { statusLine: { type: 'command', command: 'echo mine' } };
    const s3 = mergeStatusLine(own);
    ok('mergeStatusLine skips a non-Máddu statusLine', s3.skipped && s3.settings.statusLine.command === 'echo mine');

    // strip removes only ours
    ok('stripStatusLine removes ours', !statusLineInstalled(stripStatusLine(s1.settings)));
    ok('stripStatusLine leaves a non-Máddu statusLine', stripStatusLine(own).statusLine.command === 'echo mine');

    // honors a bin override (source-repo entrypoint)
    const s4 = mergeStatusLine({}, { bin: HOOK_BIN_SOURCE });
    ok('mergeStatusLine honors bin override', s4.settings.statusLine.command === `${HOOK_BIN_SOURCE} status --line`);

    // statusLine is orthogonal to hooks — merging hooks doesn't add a statusLine
    ok('mergeInstall alone adds no statusLine', !statusLineInstalled(mergeInstall({})));
  }
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
