#!/usr/bin/env node
// PR3a clauses 5-8: live help, module-owned help, and slash roster drift.
// Aggregate set rows stay red when only some members are missing; successful
// members are not padded out into dozens of green assertions at the base.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'maddu.mjs');
const read = (file) => readFile(join(REPO_ROOT, file), 'utf8');
const plain = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').trim();
const GENERIC_GUIDE = 'Máddu — the no-learning-curve guide';

let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond, extra = '') => {
  extra = extra.replace(/\s+/g, ' ').trim();
  if (cond) { passed++; console.log(`  [PASS] ${name} - ${extra || 'assertion holds'}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};
const skip = (name, cause) => {
  skipped++;
  console.log(`  [SKIP] ${name} - ${cause.replace(/\s+/g, ' ').trim()}`);
};

// Help still arms invocation receipts. Run outside any repo, with ambient
// MADDU_* overrides removed, so no receipt can touch this tree or its parent.
// The filesystem root has no ancestors to walk; no fixture files are needed.
const HELP_CWD = parse(REPO_ROOT).root;
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MADDU_/i.test(key)));
const run = (args) => {
  const result = spawnSync(process.execPath, args, {
    cwd: HELP_CWD, env: childEnv, encoding: 'utf8', timeout: 15000,
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error(`help subprocess failed: ${result.error?.message || result.signal || 'no exit status'}`);
  }
  return { ...result, text: plain(result.stdout + result.stderr) };
};
const cli = (args) => run([BIN, ...args]);

try {
  const commandFiles = (await readdir(join(REPO_ROOT, 'commands'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.startsWith('_'))
    .map((entry) => entry.name).sort();
  if (!commandFiles.length) throw new Error('commands/ contains no public modules; verb oracle is empty');
  const verbs = commandFiles.map((file) => file.slice(0, -4));
  const dispatcher = await read('bin/maddu.mjs');
  const ownHelpLiteral = dispatcher.match(/\bVERBS_WITH_OWN_HELP\s*=\s*new Set\(\[([^\]]+)\]\)/)?.[1];
  if (!ownHelpLiteral) throw new Error('cannot read VERBS_WITH_OWN_HELP from the dispatcher');
  const ownHelp = new Set([...ownHelpLiteral.matchAll(/['"]([a-z][a-z-]*)['"]/g)].map((match) => match[1]));
  if (!ownHelp.size) throw new Error('VERBS_WITH_OWN_HELP oracle is empty');

  const stateMarkers = ['.maddu', '.maddu-state-root'].filter((name) => existsSync(join(HELP_CWD, name)));
  if (stateMarkers.length) {
    const cause = `observed state markers at help cwd ${HELP_CWD}: ${stateMarkers.join(', ')}; running help could write receipts`;
    for (const clause of [5, 6, 7]) skip(`${clause} live help rows`, cause);
  } else {
    const help = cli(['--help']);
    if (help.status !== 0) throw new Error(`maddu --help exited ${help.status}: ${help.text}`);
    const listing = help.text.match(/(?:^|\n)Commands:\n([\s\S]*?)(?:\nFlags:|$)/)?.[1];
    if (!listing) throw new Error('maddu --help has no Commands listing');
    const listed = new Set([...listing.matchAll(/^\s{2}([a-z][a-z-]*)\s{2,}\S/gm)].map((match) => match[1]));
    if (!listed.size) throw new Error('maddu --help command listing could not be read');
    const missingVerbs = verbs.filter((verb) => !listed.has(verb));
    ok('5 every commands/*.mjs public verb appears in maddu --help',
      missingVerbs.length === 0, `modules=${verbs.length}; missing=${missingVerbs.join(', ') || 'none'}`);

    // Grep the two handler shapes present in this checkout: named *Help()
    // functions (including global's usage fallback) and inline --help arms.
    // Direct module output is the oracle, not a hard-coded usage sentence.
    const bespoke = [];
    for (const file of commandFiles) {
      const source = await read(`commands/${file}`);
      if (/\bfunction\s+\w*Help\s*\(/.test(source)
        || /\b(?:argv|args)\.includes\(['"]--help['"]\)/.test(source)) bespoke.push(file.slice(0, -4));
    }
    if (!bespoke.length) throw new Error('bespoke help census is empty');
    const unreachable = [];
    for (const verb of bespoke) {
      const url = pathToFileURL(join(REPO_ROOT, 'commands', `${verb}.mjs`)).href;
      const direct = run(['--input-type=module', '-e',
        `const mod = await import(${JSON.stringify(url)}); await mod.default(['--help']);`]);
      if (!direct.text || direct.text.startsWith(GENERIC_GUIDE)
        || !direct.text.replace(/\s+/g, ' ').toLowerCase().includes(`usage: maddu ${verb}`)) {
        throw new Error(`${verb}: direct module did not produce identifiable bespoke usage: ${direct.text}`);
      }
      const dispatched = cli([verb, '--help']);
      // global's direct handler currently exits 2 after printing help. This
      // clause promises that text is reachable, not a new exit-code policy.
      if (dispatched.text.startsWith(GENERIC_GUIDE) || dispatched.text !== direct.text) {
        unreachable.push(`${verb}: ${dispatched.text.startsWith(GENERIC_GUIDE) ? 'generic guide' : 'differs from module help'}`);
      }
    }
    ok('6 every bespoke --help handler is reached through the dispatcher',
      unreachable.length === 0, `modules=${bespoke.length}; unreachable=${unreachable.join('; ') || 'none'}`);

    const rosterResult = cli(['help', '--format', 'json']);
    if (rosterResult.status !== 0) throw new Error(`help roster exited ${rosterResult.status}: ${rosterResult.text}`);
    const roster = JSON.parse(rosterResult.stdout);
    const rosterNames = new Set(roster.topics.flatMap((topic) => topic.items)
      .map((item) => item.name.match(/^\/(maddu-[a-z-]+)\b/)?.[1]).filter(Boolean));
    const shippedNames = new Set((await readdir(join(REPO_ROOT, 'template/maddu/agent-files/commands'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^maddu-.+\.md$/.test(entry.name)).map((entry) => entry.name.slice(0, -3)));
    if (!rosterNames.size || !shippedNames.size) throw new Error('slash roster or shipped directory oracle is empty');
    const missingSlashes = [...shippedNames].filter((name) => !rosterNames.has(name)).sort();
    ok('7 every shipped slash command appears in ROSTER', missingSlashes.length === 0,
      `shipped=${shippedNames.size}; roster=${rosterNames.size}; missing=${missingSlashes.join(', ') || 'none'}`);
    const phantomSlashes = [...rosterNames].filter((name) => !shippedNames.has(name)).sort();
    ok('7 CONTROL: every ROSTER slash command ships', phantomSlashes.length === 0,
      `phantoms=${phantomSlashes.join(', ') || 'none'}`);
  }

  for (const tree of ['docs', 'template/maddu/docs']) {
    const file = `${tree}/03-cli-reference.md`;
    const text = await read(file);
    // Removing the enumeration is valid; if it remains, compare its names
    // with the dispatcher read above. No frozen six/ten-name expected set.
    const lists = [...text.matchAll(/\bbespoke\s+(?:usage|help)[^\n()]*\(([^()\n]+)\)/gi)];
    const drift = lists.flatMap((match) => {
      const names = new Set(match[1].replace(/[`*]/g, '').split(/\s*,\s*|\s+and\s+/).map((name) => name.trim()).filter(Boolean));
      const missing = [...ownHelp].filter((name) => !names.has(name));
      const extra = [...names].filter((name) => !ownHelp.has(name));
      return missing.length || extra.length ? [`missing=${missing.join(', ') || 'none'}; extra=${extra.join(', ') || 'none'}`] : [];
    });
    ok(`8 ${file}: bespoke-help enumeration agrees with VERBS_WITH_OWN_HELP`,
      drift.length === 0, lists.length ? drift.join(' | ') || 'enumeration agrees' : 'no bespoke-help enumeration');
  }
} catch (err) {
  ok('PR3a help-surface harness', false, err.stack || err.message);
}

console.log('');
console.log(`PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
