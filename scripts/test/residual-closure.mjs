#!/usr/bin/env node
// PR5 clauses 2-4: derive source facts at run time, check BOTH doc trees.
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, cleanupFixtures } from './_pr1-fixtures.mjs';
import { nodeFixture, readChildJson } from './_pr2-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = 'template/maddu/runtime/lib';
const read = (path) => readFile(join(ROOT, path), 'utf8');
const sorted = (values) => [...new Set(values)].sort();
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond, extra = '') => {
  extra = extra.replace(/\s+/g, ' ').trim();
  if (cond) { passed++; console.log(`  [PASS] ${name} - ${extra || 'assertion holds'}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};

async function files(dir, recursive = true) {
  const result = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && recursive) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

// These modules use standalone // and block-comment lines for commentary.
// Preserve code on a block comment's closing line and trailing code comments;
// unlike a whole-source /* regex, quoted glob strings cannot eat later code.
function codeLines(source) {
  let block = false;
  return source.split(/\r?\n/).map((line) => {
    let text = line.trimStart();
    if (block) {
      const end = text.indexOf('*/');
      if (end < 0) return '';
      text = text.slice(end + 2); block = false;
    }
    while (text.trimStart().startsWith('/*')) {
      text = text.trimStart();
      const end = text.indexOf('*/', 2);
      if (end < 0) { block = true; return ''; }
      text = text.slice(end + 2);
    }
    return text.trimStart().startsWith('//') ? '' : text;
  }).join('\n');
}

function section(doc, heading) {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((line) => /^###\s/.test(line) && line.includes(heading));
  if (start < 0) throw new Error(`missing section ${heading}`);
  let end = start + 1;
  while (end < lines.length && !/^#{1,3}\s/.test(lines[end])) end++;
  return lines.slice(start + 1, end).join('\n');
}

function releaseVersion(changelog, title) {
  const matches = changelog.split(/\r?\n/).filter((line) => /^## \[v/.test(line) && line.toLowerCase().includes(title));
  if (matches.length !== 1) throw new Error(`expected one CHANGELOG heading for ${title}, got ${matches.length}`);
  const version = matches[0].match(/^## \[(v\d+\.\d+\.\d+)\]/)?.[1];
  if (!version) throw new Error(`unparsed CHANGELOG heading: ${matches[0]}`);
  return version;
}

function featureVersion(doc, feature) {
  const paragraphs = doc.split(/\r?\n\s*\r?\n/);
  for (const paragraph of paragraphs) {
    const start = paragraph.search(feature);
    if (start >= 0) {
      const version = paragraph.slice(start).match(/\bv\d+\.\d+\.\d+\b/)?.[0];
      if (version) return version;
    }
  }
  return null;
}

try {
  const cockpitFiles = (await files('template/maddu/cockpit', false)).filter((p) => p.endsWith('.js'));
  const cockpit = (await Promise.all(cockpitFiles.map(read))).map(codeLines).join('\n');
  const cockpitPaths = new Set([...cockpit.matchAll(/['"`](\/bridge\/[A-Za-z0-9_/-]+)/g)].map((m) => m[1]));
  const server = codeLines(await read('template/maddu/runtime/server.js'));
  const exactRoutes = sorted([...server.matchAll(/\bpath\s*===\s*(['"])(\/bridge\/[^'"]+)\1/g)].map((m) => m[2]));
  if (!cockpitFiles.length || !cockpitPaths.size || !exactRoutes.length) throw new Error('empty bridge source census');

  const gateFiles = (await files('template/maddu/runtime/gates/builtin', false)).filter((p) => p.endsWith('.mjs'));
  const gateIds = [];
  for (const file of gateFiles) {
    // Deliberately anchored AFTER export default: can-read-old-state has a
    // fixture's id: 'ses_x' earlier in the same source file.
    const id = codeLines(await read(file)).match(/\bexport\s+default\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/)?.[1];
    if (!id) throw new Error(`cannot derive export-default gate id: ${file}`);
    gateIds.push(id);
  }
  if (!gateIds.length || new Set(gateIds).size !== gateIds.length) throw new Error('empty or duplicate gate-id census');

  const codeFiles = (await Promise.all(['bin', 'commands', 'template/maddu/runtime'].map((dir) => files(dir)))).flat();
  // Whole identifiers, not the substring MADDU_* inside __MADDU_*__ globals
  // or the differently named __MADDU_TEST_ZERO_CREDIT__ environment seam.
  // A stem ending in `_` (a comment's `MADDU_COORDINATOR_*` family glob) is
  // not an identifier the code reads; the family's real members are censused
  // on their own. Surfaced when the doc side moved to whole-token matching.
  const envNames = (text) => [...text.matchAll(/\bMADDU_[A-Z0-9_]+\b/g)].map((m) => m[0]).filter((n) => !n.endsWith('_'));
  const codeEnv = sorted((await Promise.all(codeFiles.map(read))).flatMap(envNames));
  if (!codeEnv.length) throw new Error('empty environment census');
  const sharedDocs = (await Promise.all([
    'README.md', 'template/maddu/CLAUDE.md', ...await files('template/maddu/agent-files'),
  ].map(read))).join('\n');
  const changelog = await read('CHANGELOG.md');
  const acceptanceVersion = releaseVersion(changelog, 'acceptance proofs');
  const massVersion = releaseVersion(changelog, 'structural mass');

  for (const tree of ['docs', 'template/maddu/docs']) {
    const docFiles = (await files(tree, false)).filter((p) => p.endsWith('.md'));
    if (!docFiles.length) throw new Error(`empty doc tree: ${tree}`);
    const docText = (await Promise.all(docFiles.map(read))).join('\n');
    const tour = await read(`${tree}/04-cockpit-tour.md`);
    const orientationPaths = sorted([...section(tour, '#orientation').matchAll(/\/bridge\/[A-Za-z0-9_/-]+/g)].map((m) => m[0]));
    const unfetched = orientationPaths.filter((path) => !cockpitPaths.has(path));
    ok(`2a ${tree} orientation names only cockpit-fetched paths`, orientationPaths.length > 0 && unfetched.length === 0,
      `cockpit literals=${cockpitPaths.size}; missing=${unfetched.join(', ') || 'none'}`);

    const endpoints = await read(`${tree}/05-bridge-endpoints.md`);
    // funnel r1 #6: a documented path is a whole token, never a substring —
    // `/bridge/trust/snapshot` must not vouch for `/bridge/trust`.
    const documentedRoutes = new Set([...endpoints.matchAll(/\/bridge\/[A-Za-z0-9_/-]+/g)].map((m) => m[0]));
    const missingRoutes = exactRoutes.filter((path) => !documentedRoutes.has(path));
    ok(`2b ${tree} [control] a route documented only as a longer path's prefix is still missing`,
      !new Set([...'/bridge/trust/snapshot'.matchAll(/\/bridge\/[A-Za-z0-9_/-]+/g)].map((m) => m[0])).has('/bridge/trust'),
      'token set built from a snapshot-only doc does not contain /bridge/trust');
    ok(`2b ${tree} documents every exact server route`, missingRoutes.length === 0,
      `exact routes=${exactRoutes.length}; missing (${missingRoutes.length})=${missingRoutes.join(', ') || 'none'}`);

    const acceptance = featureVersion(await read(`${tree}/34-threat-model.md`), /acceptance proofs\*{0,2}\s*\(/i);
    ok(`2c ${tree} acceptance-proofs version agrees with CHANGELOG`, acceptance === acceptanceVersion,
      `doc=${acceptance}; CHANGELOG=${acceptanceVersion}`);
    const mass = featureVersion(await read(`${tree}/03-cli-reference.md`), /structural[- ]mass/i);
    ok(`2c ${tree} structural-mass version agrees with CHANGELOG`, mass === massVersion,
      `doc=${mass}; CHANGELOG=${massVersion}`);

    const upgrade = await read(`${tree}/upgrade-policy.md`);
    const runtimePaths = sorted([...upgrade.matchAll(/`(maddu\/runtime\/[^`\r\n]+)`/g)].map((m) => m[1]));
    const nonexistent = [];
    for (const path of runtimePaths) {
      const wildcard = path.search(/[*?\[{]/);
      const prefix = wildcard < 0 ? path : path.slice(0, wildcard).replace(/[^/]*$/, '').replace(/\/$/, '');
      try {
        const info = await stat(join(ROOT, 'template', prefix));
        if (wildcard >= 0 && !info.isDirectory()) nonexistent.push(`${path} (prefix is not a directory)`);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        nonexistent.push(path);
      }
    }
    ok(`2c ${tree} upgrade runtime paths exist in the payload`, runtimePaths.length > 0 && nonexistent.length === 0,
      `missing=${nonexistent.join(', ') || 'none'}`);

    const transcript = await read(`${tree}/27-transcript-import.md`);
    const labels = sorted([...transcript.matchAll(/\[([^\]]+)\]\([^)]*\)/g)]
      .flatMap((m) => m[1].match(/(?:[\w.-]+\/)*[\w.-]+\.md\b/g) || []));
    const badLabels = [];
    for (const label of labels) {
      const name = label.replace(/^docs\//, '');
      try {
        if (!(await stat(join(ROOT, tree, name))).isFile()) badLabels.push(label);
      } catch (err) { if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err; badLabels.push(label); }
    }
    ok(`2c ${tree} transcript link labels name existing markdown files`, labels.length > 0 && badLabels.length === 0,
      `missing labels=${badLabels.join(', ') || 'none'}`);

    const missingGates = sorted(gateIds.filter((id) => !new RegExp(`(?<![\\w-])${escape(id)}(?![\\w-])`).test(docText)));
    ok(`2d ${tree} documents every builtin gate id`, missingGates.length === 0,
      `derived gates=${gateIds.length}; missing (${missingGates.length})=${missingGates.join(', ') || 'none'}`);
    // The contract's census is textual: a name counts when its literal
    // appears anywhere in shipped docs (including documented family members).
    const documentedEnv = docText + '\n' + sharedDocs;
    // funnel r1 #6: identifier boundaries on the doc side too — `MADDU_LANE_ID`
    // in a doc must not vouch for `MADDU_LANE` (the code census already bounds).
    const documentedNames = new Set(documentedEnv.match(/\bMADDU_[A-Z0-9_]+\b/g) || []);
    const missingEnv = codeEnv.filter((name) => !documentedNames.has(name));
    ok(`2e ${tree} [control] a name documented only as a longer identifier's prefix is still missing`,
      !new Set('see MADDU_LANE_ID'.match(/\bMADDU_[A-Z0-9_]+\b/g) || []).has('MADDU_LANE'),
      'token set built from a LANE_ID-only doc does not contain MADDU_LANE');
    ok(`2e ${tree} shipped docs name every MADDU_* identifier in code directories`, missingEnv.length === 0,
      `derived names=${codeEnv.length}; missing (${missingEnv.length})=${missingEnv.join(', ') || 'none'}`);
    const endpointPaths = new Set([...endpoints.matchAll(/\/bridge\/[A-Za-z0-9_/-]+/g)].map((m) => m[0]));
    ok(`2f ${tree} [control] project-cockpit endpoint replaces project`,
      endpointPaths.has('/bridge/project-cockpit') && !endpointPaths.has('/bridge/project'));
  }

  const libFiles = (await files(LIB)).filter((p) => /\.(?:mjs|js|cjs)$/.test(p));
  const sources = new Map(await Promise.all(libFiles.map(async (p) => [p, codeLines(await read(p))])));
  for (const name of ['stripAllowSecret', 'summarizeCounts']) {
    const declaration = new RegExp(`\\b(?:function\\s+|(?:const|let|var)\\s+)${name}\\b|\\bexport\\s*\\{[^}]*\\b${name}\\b`);
    const owners = [...sources].filter(([, src]) => declaration.test(src)).map(([p]) => p);
    ok(`3a unused ${name} has no declaration or named export in runtime/lib`, owners.length === 0,
      `declarations=${owners.join(', ') || 'none'}`);
  }
  const secretPath = `${LIB}/secret-scan.mjs`;
  const liveConsumers = [];
  for (const file of codeFiles.filter((p) => /\.(?:mjs|js|cjs)$/.test(p) && p !== secretPath)) {
    if (/\bhasAllowSecret\s*\(/.test(codeLines(await read(file)))) liveConsumers.push(file);
  }
  ok('3b [control] hasAllowSecret retains its declaration and an outside caller',
    /\b(?:function|const)\s+hasAllowSecret\b/.test(sources.get(secretPath)) && liveConsumers.length > 0,
    `callers=${liveConsumers.join(', ') || 'none'}`);

  const configOwners = [...sources].filter(([, src]) => /\bXDG_CONFIG_HOME\b/.test(src)).map(([p]) => p);
  ok('4a exactly one runtime/lib module derives XDG_CONFIG_HOME', configOwners.length === 1,
    `owners (${configOwners.length})=${configOwners.join(', ') || 'none'}`);
  for (const name of ['bridges-registry.mjs', 'workspaces.mjs', 'auth.mjs']) {
    const file = `${LIB}/${name}`;
    const imports = [...sources.get(file).matchAll(/\bimport\s+(?:[^;'"\r\n]|\r?\n)*?\sfrom\s*['"](\.[^'"]+)['"]/g)]
      .map((m) => relative(ROOT, resolve(ROOT, dirname(file), m[1])).replace(/\\/g, '/'));
    const shared = configOwners.length === 1 ? configOwners[0] : null;
    ok(`4b ${name} imports the sole shared config-dir module`, shared !== null && imports.includes(shared),
      `derivation owners=${configOwners.join(', ')}; relative imports=${imports.join(', ') || 'none'}`);
  }

  const fixture = await tmp('maddu-pr5-config-control-');
  // globalDir/tokensDir are private. Smallest public equivalents: take the
  // dirname of globalSchedulesPath(), and writeCapability()'s returned path.
  // The latter writes only beneath the child's fixture APPDATA/XDG_CONFIG_HOME.
  const observed = readChildJson(nodeFixture(fixture, `
    import { dirname, join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const lib = process.argv[1];
    const global = await import(pathToFileURL(join(lib, 'global.mjs')));
    const bridge = await import(pathToFileURL(join(lib, 'bridge-auth.mjs')));
    const base = join(process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME, 'maddu');
    const tokenPath = await bridge.writeCapability(4177, process.pid, 'pr5-fixture-token');
    console.log(JSON.stringify({ base, global: dirname(global.globalSchedulesPath()), tokens: dirname(tokenPath) }));
  `, [join(ROOT, LIB)]));
  ok('4c [control] global schedules still live under configDir/global', observed.global === join(observed.base, 'global'),
    `globalSchedulesPath dirname=${observed.global}`);
  ok('4c [control] bridge capabilities still live under configDir/bridge-tokens', observed.tokens === join(observed.base, 'bridge-tokens'),
    `writeCapability returned dirname=${observed.tokens}`);
} catch (err) {
  ok('PR5 residual-closure harness', false, err.stack || err.message);
} finally {
  await cleanupFixtures();
}
console.log('');
console.log(`residual-closure: PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
process.exit(failed ? 1 : 0);
