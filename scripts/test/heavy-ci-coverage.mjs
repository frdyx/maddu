#!/usr/bin/env node
// PR4 clauses 2 and 3: scheduled heavy-suite coverage and truthful shipped docs.
// Node 20 ESM; no dependencies. Only [control] rows may pass at the branch base.
//
// Deliberately narrow greps, not a YAML parser: block-form on/schedule/jobs,
// run scalars or block scalars, and checkout steps with block/inline `with`.
// Comments, step names and unrelated jobs cannot supply command/tag evidence.
// Workflow basenames and required matrix tags are discovered from this tree.
// No heavy suite is executed: these rows inspect the CI coverage declarations.

import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
const linesOf = (text) => text.split(/\r?\n/);
const indent = (line) => line.match(/^ */)[0].length;
const meaningful = (line) => line.trim() && !/^\s*#/.test(line);

// Take only the indented body of an observed block heading. Line-oriented
// scoping prevents a schedule/checkout in one place blessing a different job.
function bodyAt(lines, index) {
  if (index < 0) return [];
  let end = index + 1;
  while (end < lines.length && (!meaningful(lines[end]) || indent(lines[end]) > indent(lines[index]))) end++;
  return lines.slice(index + 1, end);
}

// funnel r1 #2 / r2 #1–#3 — a shell line is read the way a shell reads it, not
// with regexes over raw text. `shellSegments` splits a command line into simple
// commands at UNQUOTED `;`, `&&`, `||`, `|`, drops an UNQUOTED `#` comment, and
// decodes quotes so `node "scripts/test/stress-harness.mjs"` is the same command
// as the bare form while `echo "x; node scripts/test/stress-harness.mjs # t"` is
// one `echo` with one argument. Blanking quoted spans (the round-1 fix) got the
// echo case right and everything else wrong: a quoted `"--only"` vanished, so a
// partial run passed as full, and a quoted script path was rejected.
function shellSegments(line) {
  const segments = [];
  let tokens = [];
  let token = '';
  let inToken = false;
  let quote = null;
  const endToken = () => { if (inToken) tokens.push(token); token = ''; inToken = false; };
  const endSegment = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && c === '\\' && i + 1 < line.length) { token += line[++i]; continue; }
      token += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inToken = true; continue; }
    if (c === '\\' && i + 1 < line.length) { token += line[++i]; inToken = true; continue; }
    if (c === '#' && !inToken) break;                       // unquoted comment: rest is not a command
    if (c === ';' || c === '|' || c === '&') {              // unquoted separator (; | || & &&)
      endSegment();
      while (i + 1 < line.length && /[|&]/.test(line[i + 1])) i++;
      continue;
    }
    if (/\s/.test(c)) { endToken(); continue; }
    token += c; inToken = true;
  }
  endSegment();
  return segments;
}

function runCommands(lines) {
  const commands = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*(?:-\s*)?run:\s*(.*)$/);
    if (!match) continue;
    const value = match[1].trim();
    const script = /^[|>][-+]?\s*(?:#.*)?$/.test(value) ? bodyAt(lines, i) : [value];
    for (const raw of script.filter(meaningful)) {
      // A YAML plain/quoted scalar: unwrap ONE outer quote pair (the YAML layer)
      // before the shell layer sees it.
      const line = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
      commands.push({ line, segments: shellSegments(line) });
    }
  }
  return commands;
}

const scriptPath = (name) => new RegExp(`^(?:\\./)?scripts/test/${name}\\.mjs$`);
const hasPartialFlag = (tokens, ...flags) => tokens.some((t) => flags.some((f) => t === f || t.startsWith(`${f}=`)));
const directSuite = (tokens, name) => tokens[0] === 'node' && !!tokens[1] && scriptPath(name).test(tokens[1])
  && !hasPartialFlag(tokens, '--scenario');
const selfTestTokens = (tokens) => (tokens[0] === 'node' && /^(?:\.\/)?bin\/maddu\.mjs$/.test(tokens[1] || '') && tokens[2] === 'self-test')
  || ((tokens[0] === 'maddu' || tokens[0] === './maddu/run') && tokens[1] === 'self-test')
  || (tokens[0] === 'npx' && tokens[1] === 'maddu' && tokens[2] === 'self-test');
const profileOf = (tokens) => {
  const i = tokens.indexOf('--profile');
  if (i >= 0) return tokens[i + 1] || null;
  const eq = tokens.find((t) => t.startsWith('--profile='));
  return eq ? eq.slice('--profile='.length) : null;
};
const fullCommand = (tokens) => selfTestTokens(tokens) && profileOf(tokens) === 'full'
  && !hasPartialFlag(tokens, '--only', '--skip');

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line;
}

function checkoutHasTags(lines) {
  // Each `- ...` at step indentation starts a new step, whether its first
  // property is name, id, uses or run. Never borrow `with` from a later step.
  const starts = lines.map((line, i) => /^\s*-\s+(?:name|id|uses|run):/.test(line) ? i : -1).filter((i) => i >= 0);
  return starts.some((start, n) => {
    const end = starts.slice(n + 1).find((i) => indent(lines[i]) === indent(lines[start])) ?? lines.length;
    const step = lines.slice(start, end);
    if (!step.some((line) => /^\s*(?:-\s*)?uses:\s*['"]?actions\/checkout@[^\s'"]+/.test(line))) return false;
    const withIndex = step.findIndex((line) => /^\s*with:/.test(line));
    if (withIndex < 0) return false;
    // funnel r1 #3 / r2 #2: an inline comment is not a setting — `fetch-depth: 1
    // # fetch-tags: true` must not satisfy this row — but a `#` inside a quoted
    // scalar (`path: "checkout #1"`) is a value, not a comment. Strip only an
    // UNQUOTED `#` that YAML would treat as a comment (preceded by whitespace).
    const withText = [step[withIndex], ...bodyAt(step, withIndex)].filter(meaningful)
      .map(stripYamlComment).join('\n');
    return /(?:^|[\s{,])fetch-depth:\s*['"]?0['"]?(?=\s|[,}]|$)/m.test(withText)
      || /(?:^|[\s{,])fetch-tags:\s*['"]?true['"]?(?=\s|[,}]|$)/m.test(withText);
  });
}

function inspectWorkflow(name, text) {
  const lines = linesOf(text).map((line) => /^\s*#/.test(line) ? '' : line);
  const on = bodyAt(lines, lines.findIndex((line) => /^(?:on|'on'|"on"):\s*(?:#.*)?$/.test(line)));
  const schedule = bodyAt(on, on.findIndex((line) => /^\s+schedule:\s*(?:#.*)?$/.test(line)));
  const crons = schedule.filter((line) => /^\s*-\s*cron:\s*['"]?[^\s'"#]/.test(line));
  const jobsBody = bodyAt(lines, lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line)));
  const jobHeaders = jobsBody.map((line, i) => /^\s+[\w-]+:\s*(?:#.*)?$/.test(line) ? i : -1).filter((i) => i >= 0);
  const jobIndent = jobHeaders.length ? Math.min(...jobHeaders.map((i) => indent(jobsBody[i]))) : -1;
  const jobs = jobHeaders.filter((i) => indent(jobsBody[i]) === jobIndent).map((i) => {
    const body = bodyAt(jobsBody, i);
    const runs = runCommands(body);
    const segments = runs.flatMap((run) => run.segments);
    const full = segments.some(fullCommand);
    return {
      name: jobsBody[i].trim().replace(/:.*/, ''), commands: runs.map((run) => run.line), segments, full,
      stress: full || segments.some((tokens) => directSuite(tokens, 'stress-harness')),
      matrix: full || segments.some((tokens) => directSuite(tokens, 'upgrade-matrix')),
      tags: checkoutHasTags(body),
    };
  });
  return { name, crons, jobs, pullRequest: on.some((line) => /^\s+pull_request:/.test(line)) };
}

function markdownSection(lines, heading) {
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return '';
  const depth = lines[start].match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length && !(new RegExp(`^#{1,${depth}}\\s`)).test(lines[end])) end++;
  return lines.slice(start + 1, end).join('\n');
}

function heavyGateContexts(lines) {
  const contexts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('heavy-suites-recent')) continue;
    if (/^#+\s/.test(lines[i])) {
      const depth = lines[i].match(/^#+/)[0].length;
      let end = i + 1;
      while (end < lines.length && !(new RegExp(`^#{1,${depth}}\\s`)).test(lines[end])) end++;
      contexts.push(lines.slice(i, end).join('\n'));
      i = end - 1;
    } else {
      // docs/20 uses a single gate-table row. Do not absorb its neighbouring
      // self-test row, which legitimately mentions self-test-last-run.json.
      contexts.push(lines[i]);
    }
  }
  return contexts.map((text) => text.replace(/\s+/g, ' ').trim());
}

try {
  const workflowDir = join(REPO_ROOT, '.github/workflows');
  const names = (await readdir(workflowDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yml')).map((entry) => entry.name).sort();
  const workflows = [];
  for (const name of names) workflows.push(inspectWorkflow(name, await readFile(join(workflowDir, name), 'utf8')));
  const scheduled = workflows.filter((workflow) => workflow.crons.length > 0);
  const covered = scheduled.filter((workflow) => workflow.jobs.some((job) => job.stress) && workflow.jobs.some((job) => job.matrix));
  const describe = (workflow) => `${workflow.name}: ${workflow.jobs.filter((job) => job.stress || job.matrix)
    .map((job) => `${job.name}=${job.full ? 'self-test --profile full' : [job.stress && 'direct stress', job.matrix && 'direct matrix'].filter(Boolean).join('+')}`).join(', ')}`;

  ok('2a a discovered workflow declares on.schedule with cron', scheduled.length > 0,
    `discovered=${names.join(',') || '(none)'}; scheduled=${scheduled.map((workflow) => workflow.name).join(',') || '(none)'}`);
  ok('2b a scheduled workflow executes both complete heavy suites', covered.length > 0,
    covered.map(describe).join('; ') || `no scheduled workflow covers both; scheduled=${scheduled.map((workflow) => workflow.name).join(',') || '(none)'}`);

  const matrix = await readFile(join(REPO_ROOT, 'scripts/test/upgrade-matrix.mjs'), 'utf8');
  const tags = [...new Set([...linesOf(matrix).filter((line) => !/^\s*\/\//.test(line)).join('\n')
    .matchAll(/\bscenarioFromTag\(\s*(['"])([^'"]+)\1\s*,/g)].map((match) => match[2]))];
  const withTags = covered.filter((workflow) => workflow.jobs.filter((job) => job.matrix).every((job) => job.tags));
  ok('2c scheduled matrix checkout fetches tags required by scenarioFromTag calls',
    tags.length > 0 && withTags.length > 0,
    `matrix tags=${tags.join(',') || '(no literal tag calls: vacuous)'}; eligible checkouts=${withTags.map((workflow) => workflow.name).join(',') || '(none)'}`);

  // funnel r1 #2/#3 — negative controls driven through the REAL inspector: a
  // workflow whose only "evidence" is an echoed string and an inline comment
  // must satisfy neither 2b nor 2c. Without these, both rows could be passed by
  // a workflow that runs nothing and fetches no tags.
  const decoy = inspectWorkflow('decoy.yml', [
    'on:',
    '  schedule:',
    "    - cron: '0 4 * * 1'",
    'jobs:',
    '  heavy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 1 # fetch-tags: true',
    '      - run: echo "ignored; node scripts/test/stress-harness.mjs --all"',
    "      - run: echo 'node scripts/test/upgrade-matrix.mjs'",
    '      - run: |',
    '          echo "node scripts/test/stress-harness.mjs && node scripts/test/upgrade-matrix.mjs"',
    '',
  ].join('\n'));
  ok('2f [control] a heavy-suite command inside a quoted/echoed string is not evidence of running it',
    decoy.crons.length === 1 && !decoy.jobs.some((job) => job.stress || job.matrix),
    `decoy commands=${JSON.stringify(decoy.jobs.flatMap((job) => job.commands))}`);
  ok('2g [control] an inline comment is not a checkout fetch-tags/fetch-depth setting',
    decoy.jobs.length === 1 && !decoy.jobs[0].tags, `decoy tags=${decoy.jobs[0]?.tags}`);

  // funnel r2 #1–#3 — the lexer must read quotes the way a shell does, in BOTH
  // directions: a quoted script path or a quoted `#` inside a YAML value is
  // legitimate (positive controls), while a quoted `--only` or an echoed
  // command with a trailing `# comment` inside the quotes is not (negative).
  const lexer = inspectWorkflow('lexer.yml', [
    'on:',
    '  schedule:',
    "    - cron: '0 4 * * 1'",
    'jobs:',
    '  quoted-paths:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with: { path: "checkout #1", fetch-depth: 0, fetch-tags: true }',
    '      - run: node "scripts/test/stress-harness.mjs" # trailing comment',
    "      - run: node './scripts/test/upgrade-matrix.mjs'",
    '  quoted-partial:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
    '      - run: node bin/maddu.mjs self-test --profile full "--only" governance-budget',
    '      - run: echo "x; node scripts/test/stress-harness.mjs # text"',
    '      - run: node scripts/test/upgrade-matrix.mjs "--scenario" fresh-install',
    '',
  ].join('\n'));
  const quotedPaths = lexer.jobs.find((job) => job.name === 'quoted-paths');
  const quotedPartial = lexer.jobs.find((job) => job.name === 'quoted-partial');
  ok('2h [control] quoted script paths and a quoted # inside a with: value are recognised',
    !!quotedPaths && quotedPaths.stress && quotedPaths.matrix && quotedPaths.tags,
    `stress=${quotedPaths?.stress} matrix=${quotedPaths?.matrix} tags=${quotedPaths?.tags}`);
  ok('2i [control] a quoted --only/--scenario or an echoed command with an inner # is not coverage',
    !!quotedPartial && !quotedPartial.full && !quotedPartial.stress && !quotedPartial.matrix,
    `full=${quotedPartial?.full} stress=${quotedPartial?.stress} matrix=${quotedPartial?.matrix} segments=${JSON.stringify(quotedPartial?.segments)}`);

  const pr = workflows.find((workflow) => workflow.name === 'maddu-ci.yml');
  ok('2d [control] maddu-ci.yml retains quick --fail-on-skip on pull_request',
    !!pr?.pullRequest && pr.jobs.some((job) => job.segments.some((tokens) => selfTestTokens(tokens)
      && profileOf(tokens) === 'quick' && tokens.includes('--fail-on-skip'))),
    `pull_request=${pr?.pullRequest ?? false}; quick command=${pr?.jobs.flatMap((job) => job.commands).find((line) => /self-test/.test(line)) || '(none)'}`);

  // Read-only local evidence. ENOENT, a git error, and an empty successful
  // listing are different observed causes; none proves why a tag is absent.
  if (!tags.length) skip('2e [control] local matrix tags', 'no literal scenarioFromTag tag calls were found');
  for (const tag of tags) {
    const result = spawnSync('git', ['tag', '-l', tag], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 });
    const listed = linesOf(result.stdout || '').map((line) => line.trim()).filter(Boolean);
    if (result.error || result.status !== 0) {
      skip(`2e [control] matrix tag ${tag} exists locally`,
        `git tag -l exit=${result.status}; ${result.error?.message || result.stderr || `signal=${result.signal}`}`);
    } else if (!listed.includes(tag)) {
      skip(`2e [control] matrix tag ${tag} exists locally`,
        `git tag -l ${tag} exited 0; stdout=${JSON.stringify(result.stdout)}; stderr=${JSON.stringify(result.stderr)}`);
    } else {
      ok(`2e [control] matrix tag ${tag} exists locally`, true, `git tag -l returned ${tag}`);
    }
  }

  for (const tree of ['docs', 'template/maddu/docs']) {
    const readDoc = async (name) => linesOf(await readFile(join(REPO_ROOT, tree, name), 'utf8'));
    const signoff = markdownSection(await readDoc('17-validation-checklist.md'), /^## 10 · Sign-off\s*$/);
    const fullAt = signoff.indexOf('maddu self-test --profile full');
    const tagAt = signoff.search(/\bgit tag\b/);
    const precedesTag = (tagAt >= 0 && fullAt >= 0 && fullAt < tagAt)
      || /\bbefore\b[^.!?\n]*\btag(?:ging)?\b/.test(signoff)
      || /\btag(?:ging)?\b[^.!?\n]*\bonly after\b/.test(signoff);
    ok(`3a ${tree}/17 sign-off requires full self-test before tagging`,
      fullAt >= 0 && precedesTag,
      `full command=${fullAt >= 0}; pre-tag step=${precedesTag}; sign-off section=${!!signoff}`);

    const stressDoc = await readDoc('26-stress-testing.md');
    const ci = markdownSection(stressDoc, /^## Running both in CI\s*$/);
    const named = scheduled.filter((workflow) => ci.includes(workflow.name));
    ok(`3b ${tree}/26 CI section names a discovered scheduled workflow`,
      ci.length > 0 && named.length > 0,
      `scheduled=${scheduled.map((workflow) => workflow.name).join(',') || '(none)'}; named=${named.map((workflow) => workflow.name).join(',') || '(none)'}`);
    ok(`3b ${tree}/26 CI section retires npm run test:full recipe`,
      ci.length > 0 && !ci.includes('npm run test:full'),
      `CI section=${!!ci}; obsolete recipe=${ci.includes('npm run test:full')}`);

    const forbidden = [
      'reads `.maddu/state/stress-last-run.json`',
      'reads `.maddu/state/upgrade-matrix-last-run.json`',
      'reads the same two `.maddu/state/*-last-run.json` files',
    ];
    for (const [name, lines] of [['26-stress-testing.md', stressDoc], ['20-governance.md', await readDoc('20-governance.md')]]) {
      const contexts = heavyGateContexts(lines);
      const legacy = forbidden.filter((phrase) => contexts.some((context) => context.includes(phrase)));
      const receiptContexts = contexts.filter((context) => /verified spine receipts/.test(context)).length;
      ok(`3c ${tree}/${name} heavy-suites-recent reads verified spine receipts`,
        contexts.length > 0 && receiptContexts === contexts.length && legacy.length === 0,
        `verified-receipt contexts=${receiptContexts}/${contexts.length}; obsolete claims=${legacy.join('; ') || '(none)'}`);
    }

    const ciDoc = await readDoc('46-ci.md');
    const where = ciDoc.findIndex((line) => /^## Where the pin lives\s*$/.test(line));
    let preceding = where - 1;
    while (preceding >= 0 && !/^##\s/.test(ciDoc[preceding])) preceding--;
    const pinning = where >= 0 && preceding >= 0 ? ciDoc.slice(preceding + 1, where).join('\n') : '';
    ok(`3d ${tree}/46 pinning prose discloses warn-severity gates are never pinnable`,
      pinning.includes('maddu ci pin') && /warn-severity|never pinnable/.test(pinning),
      `pinning section=${!!pinning}; warn-severity/never pinnable=${/warn-severity|never pinnable/.test(pinning)}`);

    const dogfood = markdownSection(ciDoc, /^## .*dogfood.*$/);
    ok(`3e [control] ${tree}/46 dogfood retains self-test --fail-on-skip`,
      dogfood.includes('self-test --fail-on-skip'), `dogfood section=${!!dogfood}`);
  }
} catch (err) {
  ok('PR4 heavy CI harness', false, err.stack || err.message);
}
console.log('');
console.log(`heavy-ci-coverage: PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
