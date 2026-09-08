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

async function filesUnder(dir) {
  const files = [];
  for (const entry of await readdir(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile() && entry.name !== 'CHANGELOG.md') files.push(file);
  }
  return files.sort();
}

// Claim-shaped greps, not a bare tokens.css ban. External Claude citations
// have neither the Máddu cockpit path nor same-line cockpit ownership prose.
const ownsPhantom = (line) => /maddu\/cockpit\/tokens\.css/.test(line)
  || /\bcockpit(?:['’]s)?[^\n]*\btokens\.css\b/i.test(line)
  || /\btokens\.css\b[^\n]*\bowned by Máddu\b/i.test(line);

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
      const lines = (await read(file)).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (ownsPhantom(line)) claims.push(`${file}:${i + 1}`);
      });
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
      /\bcockpit\.css\b/.test(text) && !text.split(/\r?\n/).some(ownsPhantom),
      `cockpit.css mentioned=${/\bcockpit\.css\b/.test(text)}; phantom claim=${text.split(/\r?\n/).some(ownsPhantom)}`);
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
} catch (err) {
  ok('PR3a doc-phantoms harness', false, err.stack || err.message);
}

console.log('');
console.log(`PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
