#!/usr/bin/env node
// claude-hooks-merge — the .claude/settings.json merge/strip logic (v1.74.0).
//
// `maddu hooks install` wires SessionStart(auto-register) + SessionEnd(close)
// into a HOST-repo file, so it must be idempotent and must never disturb the
// user's own hooks/settings. This locks the pure merge/strip/summarize logic
// without touching disk.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mergeInstall, stripMaddu, summarize, MADDU_HOOKS, hookCommandFor, resolveHookBin, HOOK_BIN, HOOK_BIN_SOURCE, mergeStatusLine, stripStatusLine, statusLineInstalled, statusLineCommandFor, GUARDRAIL_DENY_CONSUMER, GUARDRAIL_DENY_SOURCE, guardrailAskRules, mergeGuardrails, stripGuardrails, summarizeGuardrails, retireInertWriteTwins, resolveGuardrailRules } from '../../template/maddu/runtime/lib/claude-hooks.mjs';
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
  // PreToolUse discipline hook: wired, carries the mutating-tools matcher (edit
  // family + Bash; the handler classifies Bash and skips reads/remedies).
  ok('install wires the PreToolUse discipline hook', a.hooks.PreToolUse?.some((g) => g.hooks?.[0]?.command === hookCommandFor('pre-tool-use')));
  ok('PreToolUse Máddu group carries the Edit|Write|…|Bash matcher', a.hooks.PreToolUse?.find((g) => g.hooks?.[0]?.command === hookCommandFor('pre-tool-use'))?.matcher === 'Edit|Write|MultiEdit|NotebookEdit|Bash');
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

  // ── permission guardrails (PR 3, verification-witness plan) ──
  {
    const rules = { deny: [...GUARDRAIL_DENY_CONSUMER], ask: guardrailAskRules(['tests/**', 'vitest.config.ts']) };

    // ask-rule generation: Edit-form, trimmed, paren-injection rejected
    ok('guardrailAskRules emits Edit-form rules',
      JSON.stringify(rules.ask) === JSON.stringify(['Edit(tests/**)', 'Edit(vitest.config.ts)']));
    ok('guardrailAskRules rejects paren injection + junk',
      guardrailAskRules(['a)b', '(x', '', '   ', 42, null]).length === 0);

    // fresh merge adds every rule
    const g1 = mergeGuardrails({}, rules);
    const sum1 = summarizeGuardrails(g1.settings, rules);
    ok('mergeGuardrails installs all rules', sum1.allInstalled, JSON.stringify(sum1.missing));
    ok('mergeGuardrails reports what it added',
      g1.added.deny.length === GUARDRAIL_DENY_CONSUMER.length && g1.added.ask.length === 2);

    // idempotent
    const g2 = mergeGuardrails(g1.settings, rules);
    ok('mergeGuardrails idempotent (deep-equal)', JSON.stringify(g1.settings) === JSON.stringify(g2.settings));
    ok('idempotent re-merge adds nothing', g2.added.deny.length === 0 && g2.added.ask.length === 0);

    // user rules preserved, order kept, no duplicates
    const user = { permissions: { deny: ['Edit(secrets/**)'], ask: ['Bash(git push:*)'], allow: ['Bash'] } };
    const g3 = mergeGuardrails(user, rules);
    ok('user deny rule preserved first', g3.settings.permissions.deny[0] === 'Edit(secrets/**)');
    ok('user ask rule preserved', g3.settings.permissions.ask.includes('Bash(git push:*)'));
    ok('user allow untouched', JSON.stringify(g3.settings.permissions.allow) === JSON.stringify(['Bash']));

    // strip removes exactly the canonical strings, cleans empties
    const s1 = stripGuardrails(g1.settings, rules);
    ok('stripGuardrails leaves no permissions object when nothing remains', !s1.permissions);
    const s2 = stripGuardrails(g3.settings, rules);
    ok('stripGuardrails keeps user rules',
      s2.permissions.deny.includes('Edit(secrets/**)') && s2.permissions.ask.includes('Bash(git push:*)'));
    ok('stripGuardrails removed canonical rules',
      !s2.permissions.deny.some((r) => GUARDRAIL_DENY_CONSUMER.includes(r)));

    // BYTE-PRESERVATION (kill criterion core): install→uninstall on a settings
    // object with user content returns deep-equal user content.
    const userBefore = JSON.stringify(user);
    const roundTrip = stripGuardrails(mergeGuardrails(JSON.parse(userBefore), rules).settings, rules);
    ok('install→uninstall round-trip preserves user settings deep-equal',
      JSON.stringify(roundTrip) === userBefore);

    // inert Write() twin retirement: removed only when the Edit twin is in the
    // SAME array; a twin-less Write rule survives; removals are reported.
    const twins = {
      permissions: {
        ask: ['Edit(.maddu/config/**)', 'Write(.maddu/config/**)', 'Write(untwinned/**)'],
        deny: ['Edit(.claude/settings.json)', 'Write(.claude/settings.json)'],
      },
    };
    const r1 = retireInertWriteTwins(twins);
    ok('twin Write retired from ask', !r1.settings.permissions.ask.includes('Write(.maddu/config/**)'));
    ok('twin Write retired from deny', !r1.settings.permissions.deny.includes('Write(.claude/settings.json)'));
    ok('twin-less Write survives', r1.settings.permissions.ask.includes('Write(untwinned/**)'));
    ok('retirements reported', r1.retired.length === 2 && r1.retired.every((x) => x.rule.startsWith('Write(')));
    ok('Edit rules untouched by retirement',
      r1.settings.permissions.ask.includes('Edit(.maddu/config/**)')
      && r1.settings.permissions.deny.includes('Edit(.claude/settings.json)'));

    // cross-array twin does NOT retire (Edit in deny, Write in ask ≠ same array)
    const cross = { permissions: { ask: ['Write(x/**)'], deny: ['Edit(x/**)'] } };
    ok('cross-array Write twin NOT retired', retireInertWriteTwins(cross).settings.permissions.ask.includes('Write(x/**)'));

    // retirement is NOT a merge side effect (explicit-flag-only — Codex F6):
    // a plain merge leaves user Write twins exactly where they were.
    const g4 = mergeGuardrails(twins, { deny: [], ask: [] });
    ok('mergeGuardrails does NOT retire twins',
      g4.settings.permissions.ask.includes('Write(.maddu/config/**)')
      && g4.settings.permissions.deny.includes('Write(.claude/settings.json)')
      && g4.retired === undefined);

    // layout-aware rule resolution (IO): a fake consumer layout vs source layout
    const dirC = await mkdtemp(join(tmpdir(), 'maddu-guard-consumer-'));
    await mkdir(join(dirC, 'maddu', 'bin'), { recursive: true });
    await writeFile(join(dirC, 'maddu', 'bin', 'maddu.mjs'), '// stub');
    await writeFile(join(dirC, 'maddu.json'), JSON.stringify({ guardrails: { ask: ['tests/**'] } }));
    const rc = await resolveGuardrailRules(dirC);
    ok('consumer layout resolves consumer deny set',
      rc.layout === 'consumer' && JSON.stringify(rc.deny) === JSON.stringify(GUARDRAIL_DENY_CONSUMER));
    ok('consumer ask rules read from maddu.json', JSON.stringify(rc.ask) === JSON.stringify(['Edit(tests/**)']));
    ok('clean consumer resolution carries no warnings', rc.warnings.length === 0);
    await rm(dirC, { recursive: true, force: true });

    // source layout needs BOTH the source CLI and the source runtime tree
    const dirS = await mkdtemp(join(tmpdir(), 'maddu-guard-source-'));
    await mkdir(join(dirS, 'bin'), { recursive: true });
    await writeFile(join(dirS, 'bin', 'maddu.mjs'), '// stub');
    await mkdir(join(dirS, 'template', 'maddu', 'runtime'), { recursive: true });
    const rs = await resolveGuardrailRules(dirS);
    ok('source layout resolves settings-only deny set',
      rs.layout === 'source' && JSON.stringify(rs.deny) === JSON.stringify(GUARDRAIL_DENY_SOURCE));
    ok('missing maddu.json → no ask rules, no warning', rs.ask.length === 0 && rs.warnings.length === 0);
    await rm(dirS, { recursive: true, force: true });

    // AMBIGUOUS layout fails CLOSED to the consumer (stronger) deny set —
    // bin/maddu.mjs alone, without the source runtime tree, is not source.
    const dirA = await mkdtemp(join(tmpdir(), 'maddu-guard-ambig-'));
    await mkdir(join(dirA, 'bin'), { recursive: true });
    await writeFile(join(dirA, 'bin', 'maddu.mjs'), '// stub');
    const ra = await resolveGuardrailRules(dirA);
    ok('ambiguous layout fails closed to consumer denies',
      ra.layout === 'consumer' && JSON.stringify(ra.deny) === JSON.stringify(GUARDRAIL_DENY_CONSUMER));
    await rm(dirA, { recursive: true, force: true });

    // declared-but-broken guardrails surface WARNINGS (never silent — Codex F8)
    const dirW = await mkdtemp(join(tmpdir(), 'maddu-guard-warn-'));
    await mkdir(join(dirW, 'maddu', 'bin'), { recursive: true });
    await writeFile(join(dirW, 'maddu', 'bin', 'maddu.mjs'), '// stub');
    await writeFile(join(dirW, 'maddu.json'), '{ not json');
    const rw1 = await resolveGuardrailRules(dirW);
    ok('malformed maddu.json → loud warning, zero ask rules',
      rw1.ask.length === 0 && rw1.warnings.length === 1 && /could not be parsed/.test(rw1.warnings[0]));
    await writeFile(join(dirW, 'maddu.json'), JSON.stringify({ guardrails: { ask: 'tests/**' } }));
    const rw2 = await resolveGuardrailRules(dirW);
    ok('non-array guardrails.ask → loud warning', rw2.warnings.length === 1 && /not an array/.test(rw2.warnings[0]));
    await writeFile(join(dirW, 'maddu.json'), JSON.stringify({ guardrails: { ask: ['ok/**', 'bad)path', ''] } }));
    const rw3 = await resolveGuardrailRules(dirW);
    ok('invalid ask entries → warning naming the dropped count',
      JSON.stringify(rw3.ask) === JSON.stringify(['Edit(ok/**)']) && rw3.warnings.length === 1 && /2 guardrails/.test(rw3.warnings[0]));
    await rm(dirW, { recursive: true, force: true });
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
