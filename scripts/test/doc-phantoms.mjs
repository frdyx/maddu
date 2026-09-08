#!/usr/bin/env node
// PR3a clauses 1-4: shipped documentation, checked at the unfixed base.
// Clause 3 narrowly checks the phantom /bridge/project endpoint and its siblings.
// No generator runs here, and CHANGELOG.md is deliberately outside every scan.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const read = (file) => readFile(join(REPO_ROOT, file), 'utf8');
const DOC_TREES = ['docs', 'template/maddu/docs'];

let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond, extra = '') => {
  extra = extra.replace(/\s+/g, ' ').trim();
  if (cond) { passed++; console.log(`  [PASS] ${name} - ${extra || 'assertion holds'}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};

// Historical RECORDS are out of scope; docs that INSTRUCT are in it. CHANGELOG.md
// was already excluded on that reasoning, and docs/audit/ holds the same kind of
// thing: FIXED-IN.json exists to state precisely which phantom was removed, so
// it necessarily quotes the phantom. Scanning it would mean a defect could never
// be described in the ledger that records fixing it — caught when the v1.136.0
// ledger row tripped these very rows.
const RECORD_NOT_INSTRUCTION = (dir, name) => name === 'CHANGELOG.md' || dir.startsWith('docs/audit');

async function filesUnder(dir) {
  const files = [];
  for (const entry of await readdir(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile() && !RECORD_NOT_INSTRUCTION(dir, entry.name)) files.push(file);
  }
  return files.sort();
}

// Claim-shaped, not a bare tokens.css ban.
// True when the text claims Máddu owns a `tokens.css`. Three things this has
// to get right, each learned from a row below:
//
//  1. SOFT WRAPPING. The old form anchored on `[^\n]*`, so a claim split across
//     two physical lines escaped entirely (funnel r1 F2). Whitespace is
//     normalized first, so wrapping cannot hide a claim.
//  2. EXTERNAL CITATIONS. cockpit.css really does cite the Claude design
//     system's own tokens.css, in a sentence that also says "cockpit". Matching
//     on the normalized text alone would flag it and no fix could ever go green.
//  3. THE EXEMPTION IS PER SENTENCE, NEVER PER DOCUMENT. "See Claude Design
//     (claude.ai/design · tokens.css). The cockpit's tokens live in
//     `tokens.css`." must STILL be caught — a real claim standing next to a
//     legitimate citation is the case a whole-text exemption would wave through.
const ownsPhantom = (text) => {
  const s = String(text);
  if (/maddu\/cockpit\/tokens\.css/.test(s)) return true;
  // Collapse wrapping first — a claim split across lines is still a claim — then
  // MASK each `tokens.css` that belongs to an external Claude reference.
  //
  // Masking the OCCURRENCE is the point. Two coarser exemptions were tried and
  // both failed review. Per-SENTENCE is defeated three ways: a citation
  // trailing the claim ("… live in tokens.css, following Claude Design"), an
  // abbreviation's period splitting mid-claim ("i.e. tokens.css"), and JSON
  // string arrays where `",` is no sentence break at all. Per-DOCUMENT is worse
  // — it waves through a real claim standing beside a legitimate citation.
  // Removing the offending occurrence leaves every other one visible, and needs
  // no notion of a sentence, so punctuation cannot defeat it.
  const masked = s.replace(/\s+/g, ' ')
    .replace(/(?:claude\.ai\/design|Claude Design)[\s\S]{0,60}?tokens\.css/gi, '«external-citation»');
  // Ownership prose must sit near a SURVIVING occurrence. The bounded window is
  // what stops the word "cockpit" in one paragraph binding to a `tokens.css`
  // far below it in the same file.
  //
  // KNOWN RESIDUAL: no row exercises the 80-character bound. Widening it to
  // unbounded leaves every row green, because the failure it prevents is a
  // FALSE POSITIVE at distance and no shipped file currently exhibits one — the
  // per-file rows read whole files, so the bound is the only thing standing
  // between "this file says cockpit somewhere" and "this file says tokens.css
  // somewhere". Keep it, and if a row is ever added for it, assert a distant
  // pair is NOT a claim rather than testing the number.
  return /\bcockpit(?:['’]s)?\b[\s\S]{0,80}?tokens\.css/i.test(masked)
    || /tokens\.css[\s\S]{0,80}?\bowned by Máddu\b/i.test(masked);
};

// Blank-line separated blocks, comment markers and indentation collapsed onto
// one line, carrying the first line number so a claim can still be located.
function paragraphs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let buf = [];
  let start = 0;
  const flush = () => {
    if (buf.length) out.push({ line: start + 1, text: buf.join(' ').replace(/\s+/g, ' ').trim() });
    buf = [];
  };
  lines.forEach((raw, i) => {
    const stripped = raw.replace(/^\s*(?:\/\*+|\*+\/?|\/\/|#+|-|\d+\.)\s?/, '').trim();
    if (!stripped) { flush(); return; }
    if (!buf.length) start = i;
    buf.push(stripped);
  });
  flush();
  return out;
}

// NOTE: there is deliberately no second "does this file claim ownership"
// helper. `ownsPhantom` already normalizes wrapping and exempts per sentence,
// so every caller passes it whole text directly. An alias here was a place for
// a divergent implementation to grow back — which is exactly how the wrapped
// claim once slipped past the per-file rows while the tree scan reported clean.

try {
  const css = (await read('template/maddu/cockpit/cockpit.css')).replace(/\r\n/g, '\n');
  const externalCitations = [
    '  /* Radii softened to the canonical Máddu navy-noir scale (Claude Design\n'
      + '   * tokens.css): 4 / 8 / 16 — rounder cards, inputs, chips. Pill unchanged. */',
    '   * design system (claude.ai/design · tokens.css). Its hand-built --m-*',
  ];
  ok('1 CONTROL: both external Claude tokens.css citations remain verbatim and permitted',
    externalCitations.every((citation) => css.includes(citation)
      && citation.split('\n').every((line) => !ownsPhantom(line))));

  const claims = [];
  for (const dir of ['docs', 'template']) {
    for (const file of await filesUnder(dir)) {
      const body = await read(file);
      body.split(/\r?\n/).forEach((line, i) => {
        if (ownsPhantom(line)) claims.push(`${file}:${i + 1}`);
      });
      for (const p of paragraphs(body)) {
        if (ownsPhantom(p.text)) {
          const at = `${file}:${p.line}`;
          if (!claims.includes(at)) claims.push(at);
        }
      }
    }
  }
  ok('1 docs/** and template/** contain no Máddu-owned tokens.css claims',
    claims.length === 0, `claims=${claims.join(', ') || 'none'}`);

  const tokenSites = [
    ...DOC_TREES.flatMap((tree) => ['39-rule-gate-traceability.md', 'hard-rules.md', 'upgrade-policy.md']
      .map((file) => `${tree}/${file}`)),
    'docs/images/brand-boundary.svg',
    'template/maddu/CLAUDE.md',
    'template/maddu/agent-files/rules.json',
  ];
  for (const file of tokenSites) {
    const text = await read(file);
    ok(`1 ${file}: name cockpit.css as the real token source, without the phantom`,
      /\bcockpit\.css\b/.test(text) && !ownsPhantom(text),
      `cockpit.css mentioned=${/\bcockpit\.css\b/.test(text)}; phantom claim=${ownsPhantom(text)}`);
  }

  for (const tree of DOC_TREES) {
    const file = `${tree}/01-getting-started.md`;
    const text = await read(file);
    const invocations = text.split(/\r?\n/).filter((line) => /\bmaddu[ \t]+blast\b/.test(line));
    ok(`2 ${file}: teach /maddu-blast instead of a CLI blast invocation`,
      invocations.length === 0 && /\/maddu-blast\b/.test(text),
      `CLI invocations=${invocations.join(' | ') || 'none'}; slash instruction=${/\/maddu-blast\b/.test(text)}`);
  }

  // The general documented-endpoint-exists check was attempted and deferred:
  // template/maddu/runtime/server.js:260 uses url.pathname.startsWith('/bridge/')
  // as a dispatch guard matching every bridge path, making a shape-only oracle
  // vacuous. Do not broaden this until registration is separated from dispatch
  // and auth guards. This clause only rejects the phantom /bridge/project.
  const namesEndpoint = (text, endpoint) => [...text.matchAll(/\/bridge\/[A-Za-z0-9_/-]+/g)]
    .some(([path]) => path === endpoint); // Whole path, not a substring or \b.
  const docLines = [];
  for (const tree of DOC_TREES) {
    for (const file of await filesUnder(tree)) {
      (await read(file)).split(/\r?\n/).forEach((line, i) => {
        docLines.push({ file, line, site: `${file}:${i + 1}` });
      });
    }
  }
  const projectClaims = docLines.filter(({ line }) => namesEndpoint(line, '/bridge/project'));
  ok('3 docs/** and template/maddu/docs/** name no /bridge/project endpoint',
    projectClaims.length === 0, `claims=${projectClaims.map(({ site }) => site).join(', ') || 'none'}`);
  for (const tree of DOC_TREES) {
    for (const name of ['04-cockpit-tour.md', '05-bridge-endpoints.md']) {
      const file = `${tree}/${name}`;
      const claims = projectClaims.filter((claim) => claim.file === file);
      ok(`3 ${file}: no /bridge/project endpoint`, claims.length === 0,
        `claims=${claims.map(({ site }) => site).join(', ') || 'none'}`);
    }
  }
  const projectionMentions = docLines.filter(({ line }) => namesEndpoint(line, '/bridge/projection'));
  ok('3 CONTROL: /bridge/projection remains documented in both trees and accepted',
    DOC_TREES.every((tree) => projectionMentions.some(({ file }) => file.startsWith(`${tree}/`)))
      && projectionMentions.every(({ line }) => !namesEndpoint(line, '/bridge/project')),
    `mentions=${projectionMentions.length}`);
  // The correct cockpit path is absent from these docs at base. Exercise both
  // documentation shapes in memory so the control stays green before any fix.
  const cockpitExamples = [
    'Reads `GET /bridge/project-cockpit`.',
    '| GET | `/bridge/project-cockpit` | — | single-project cockpit projection |',
  ];
  ok('3 CONTROL: /bridge/project-cockpit is accepted in read prose and endpoint tables',
    cockpitExamples.every((line) => namesEndpoint(line, '/bridge/project-cockpit')
      && !namesEndpoint(line, '/bridge/project')));

  const schema = JSON.parse(await read('docs/event-schema.json'));
  const types = schema.properties?.type?.enum;
  const version = schema['x-contractVersion'];
  if (!Array.isArray(types) || !types.length || typeof version !== 'string' || !version) {
    throw new Error('docs/event-schema.json lacks a usable type enum or x-contractVersion oracle');
  }
  const readme = (await read('README.md')).replace(/\*\*/g, '');
  const counts = [...readme.matchAll(/\b(\d+)\s+typed event types\b/g)].map((match) => Number(match[1]));
  ok('4 README typed event count equals the published schema enum length',
    counts.length > 0 && counts.every((count) => count === types.length),
    `README=${counts.join(', ') || 'missing'}; schema=${types.length}`);
  const versions = [...readme.matchAll(/\bpublished\s+v([^\s`*]+)\s+schema\b/g)].map((match) => match[1]);
  ok('4 README published schema version equals x-contractVersion',
    versions.length > 0 && versions.every((value) => value === version),
    `README=${versions.join(', ') || 'missing'}; schema=${version}`);

  // F2: exercise the existing predicate with complete prose, without changing
  // it or the physical-line scans above. Wrapping must not hide ownership.
  const ownershipExamples = [
    { label: 'cockpit ownership', parts: [
      "The cockpit's canonical design tokens live in", '`tokens.css`.',
    ] },
    { label: 'Máddu ownership', parts: [
      'The `tokens.css` stylesheet is', 'owned by Máddu.',
    ] },
  ];
  for (const { label, parts } of ownershipExamples) {
    const singleLine = parts.join(' ');
    ok(`F2 CONTROL: single-line ${label} is detected`, ownsPhantom(singleLine), singleLine);
    for (const [ending, separator] of [['LF', '\n'], ['CRLF', '\r\n']]) {
      const wrapped = parts.join(separator);
      ok(`F2 ${label} is detected across ${ending} soft wrapping`, ownsPhantom(wrapped),
        JSON.stringify(wrapped));
    }
  }

  // Pin the whole real paragraph, including "cockpit" on the preceding line.
  // The old citation fragment alone cannot catch the normalization hazard.
  const claudeComment = [
    '   * The cockpit is the dark-noir face of the shared "Máddu navy-noir"',
    '   * design system (claude.ai/design · tokens.css). Its hand-built --m-*',
    '   * palette is the source of truth for the DARK theme; here we expose the',
    '   * canonical --s-* names as aliases onto it, so design-system component',
    '   * classes (.callout, .chip, .kpi, .btn variants, table.data, .progress,',
    '   * .spinner, .skeleton …) drop into the cockpit and theme correctly to the',
    "   * console's dark palette — no second palette, no drift. Components read",
    '   * --s-* semantic tokens only; never a hard-coded hex, radius, or font. */',
  ].join('\n');
  const claudeParagraph = claudeComment.replace(/^[ \t]*\* ?/gm, '').replace(/ \*\/$/, '');
  ok('F2 CONTROL: the full wrapped external Claude paragraph remains verbatim and permitted',
    css.includes(claudeComment) && !ownsPhantom(claudeParagraph),
    `paragraph present=${css.includes(claudeComment)}; phantom claim=${ownsPhantom(claudeParagraph)}`);
  // Normalize only this input fixture: a future paragraph-aware predicate must
  // accept it too. This currently exposes the false positive; it is not a fix.
  const joinedClaudeParagraph = claudeParagraph.replace(/\s+/g, ' ').trim();
  ok('F2 CONTROL: the joined external Claude paragraph remains permitted',
    css.includes(claudeComment) && !ownsPhantom(joinedClaudeParagraph),
    `paragraph present=${css.includes(claudeComment)}; phantom claim=${ownsPhantom(joinedClaudeParagraph)}`);
  const joinedRadiiCitation = externalCitations[0].replace(/\s+/g, ' ').trim();
  ok('F2 CONTROL: the joined external Claude radii citation remains permitted',
    css.includes(externalCitations[0]) && !ownsPhantom(joinedRadiiCitation), joinedRadiiCitation);
  ok('F2 CONTROL: an external Claude citation does not exempt an actual ownership claim',
    ownershipExamples.every(({ parts }) => ownsPhantom(
      `See Claude Design (claude.ai/design · tokens.css). ${parts.join(' ')}`)));
  // Round 3: classify ownership prose and legitimate external references.
  const trailingClaudeCitation = "The cockpit's tokens live in tokens.css, following Claude Design.";
  ok('F3 A: cockpit ownership with a trailing Claude citation is detected',
    ownsPhantom(trailingClaudeCitation), trailingClaudeCitation);

  const ownershipWithAbbreviation = "The cockpit's canonical tokens live in a stylesheet, i.e. tokens.css.";
  ok('F3 B: cockpit ownership containing i.e. is detected',
    ownsPhantom(ownershipWithAbbreviation), ownershipWithAbbreviation);

  // Match rules.json's worker.rules array of string arrays, including indented
  // continuation lines. Pass serialized file text, as the per-file row does.
  const rulesJsonOwnership = JSON.stringify({
    worker: {
      rules: [[
        'See Claude Design (claude.ai/design · tokens.css).',
        "The cockpit's canonical design tokens live in",
        '   `tokens.css`.',
      ]],
    },
  }, null, 2);
  ok('F3 C: rules.json-shaped text with an external citation and wrapped cockpit ownership is detected',
    ownsPhantom(rulesJsonOwnership), JSON.stringify(rulesJsonOwnership));

  const externalClaudeExamples = 'See Claude Design, e.g. its cockpit examples in tokens.css.';
  ok('F3 D CONTROL: the external Claude cockpit examples reference is not a Maddu ownership claim',
    !ownsPhantom(externalClaudeExamples), externalClaudeExamples);
} catch (err) {
  ok('PR3a doc-phantoms harness', false, err.stack || err.message);
}

console.log('');
console.log(`PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
