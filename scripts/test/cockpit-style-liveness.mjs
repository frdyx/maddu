#!/usr/bin/env node
// PR3b clauses 2-3: class liveness + compound modifier placement.
// Static reachability includes shipped docs and golden class attributes. The
// compound check observes real renderers under the same small document/context
// seam as cockpit-views-live, cockpit-views-inspect and cockpit-comms.
// No CSS/renderer changes, browser dependency, golden updates or bridge writes.
//
// KNOWN LIMIT — found by adversarial review, recorded rather than papered over.
// A selector is reduced to its CLASS PAIR, so every other constraint in it is
// dropped: `button.pill.tone-ok` and `.pill.tone-ok` are indistinguishable
// here, and a rule whose element, attribute or ancestor constraint can never
// match the rendered node still counts as reachable. Closing this needs a real
// selector matcher over the harness DOM, which is its own piece of work. The
// gap makes clause 3 MISS an unreachable rule; it cannot make it condemn a
// reachable one.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = 'template/maddu/cockpit/cockpit.css';
let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
const escapeRE = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const classesOf = (node) => String(node.className || '').split(/\s+/).filter(Boolean);

function stylesheet(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '));
  const classes = new Map(), pairs = [], rules = [];
  for (const match of text.matchAll(/([^{}]+)\{/g)) {
    const raw = match[1];
    if (raw.trim().startsWith('@')) continue;
    // Strings in attributes are not class selectors. Parse selector preludes,
    // never declarations (decimal numbers, URLs and custom properties).
    const selector = raw.replace(/\[[^\]]*\]/g, (s) => ' '.repeat(s.length));
    const lineAt = (offset) => text.slice(0, match.index + offset).split('\n').length;
    for (const cls of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      if (!classes.has(cls[1])) classes.set(cls[1], lineAt(cls.index));
    }
    for (const compound of selector.matchAll(/\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/g)) {
      const [, base, modifier] = compound;
      const prefix = modifier.match(/^[^-]+-/)?.[0];
      if (prefix) pairs.push({ base, modifier, prefix, line: lineAt(compound.index) });
    }
    rules.push({ selector: selector.trim(), body: text.slice(match.index + match[0].length).split(/[{}]/, 1)[0] });
  }
  const families = new Map();
  for (const pair of pairs) {
    const members = new Set(pairs.filter((p) => p.prefix === pair.prefix).map((p) => p.modifier));
    if (members.size < 2) continue;
    const family = families.get(pair.prefix) || { prefix: pair.prefix, pairs: [] };
    if (!family.pairs.some((p) => p.base === pair.base && p.modifier === pair.modifier)) family.pairs.push(pair);
    families.set(pair.prefix, family);
  }
  return { classes, families, rules };
}

// Literal strings are possible class tokens, including strings passed through
// helpers/conditional expressions. Never use bare source identifiers/comments.
// Interpolated class fragments and concatenated prefixes are conservative:
// `tone-${x}` or 'tone-' + x can reach any CSS class with that prefix.
function literalPatterns(text) {
  const patterns = [];
  let i = 0, previous = '';
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (text[i] === '/' && (!previous || /^(?:[=(:,;!&|?{}\[]|return|throw|case|=>)$/.test(previous))) {
      i++; let bracket = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') bracket = true;
        if (text[i] === ']') bracket = false;
        if (text[i++] === '/' && !bracket) break;
      }
      while (i < text.length && /[a-z]/i.test(text[i])) i++;
      previous = '<regex>'; continue;
    }
    if (/[\w$]/.test(text[i])) {
      const start = i++;
      while (i < text.length && /[\w$]/.test(text[i])) i++;
      previous = text.slice(start, i); continue;
    }
    const quote = text[i++];
    if (!['"', "'", '`'].includes(quote)) { previous = quote; continue; }
    previous = '<string>';
    let value = '';
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\') { value += text[i + 1] || ''; i += 2; continue; }
      if (quote === '`' && text.startsWith('${', i)) {
        value += '*'; i += 2; const innerStart = i; let depth = 1, innerQuote = '';
        while (i < text.length && depth) {
          const c = text[i++];
          if (c === '\\') { i++; continue; }
          if (innerQuote) { if (c === innerQuote) innerQuote = ''; continue; }
          if (['"', "'", '`'].includes(c)) innerQuote = c;
          else if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        // A template interpolation is CODE, and code holds strings — markup is
        // routinely built as `${cond ? '<span class="x">…</span>' : ''}`.
        // Treating the whole `${…}` as an opaque wildcard loses those classes,
        // and once the raw-text scan was removed this was the ONLY path to
        // them: wrapping existing inspector markup in an interpolation produced
        // byte-identical output while making inspector-title look dead. Recurse
        // into the expression, which keeps comments excluded because this same
        // function skips them.
        patterns.push(...literalPatterns(text.slice(innerStart, depth ? i : i - 1)));
      } else value += text[i++];
    }
    i++;
    const concatenated = /^\s*\+/.test(text.slice(i));
    const words = value.split(/\s+/);
    words.forEach((token, index) => {
      if (concatenated && index === words.length - 1 && token.endsWith('-')) token += '*';
      if (/^[A-Za-z_][\w*-]*$/.test(token)) patterns.push(new RegExp('^' + token.split('*').map(escapeRE).join('[\\w-]*') + '$'));
    });
    // HTML embedded in strings is also shipped markup.
    for (const m of value.matchAll(/\bclass\s*=\s*["']([^"']*)["']/g)) {
      for (const token of m[1].split(/\s+/).filter(Boolean)) patterns.push(new RegExp('^' + escapeRE(token) + '$'));
    }
  }
  return patterns;
}
function classReferences(names, artefacts) {
  names = [...names];
  const references = new Map([...names].map((name) => [name, []]));
  for (const { file, text, kind } of artefacts) {
    const patterns = kind === 'js' ? literalPatterns(text) : [];
    // For a JS artefact the class evidence must come from LEXED STRING VALUES
    // (literalPatterns), never from a raw scan of the file. Scanning the raw
    // text lets a commented-out `// class="foo"` vouch for a rule that nothing
    // renders -- a dead class stays "referenced" by a line the browser never
    // sees. Goldens and docs are markup through and through, so they keep the
    // raw scan.
    const htmlTokens = kind === 'js'
      ? new Set()
      : new Set([...text.matchAll(/\bclass\s*=\s*["']([^"']*)["']/g)].flatMap((m) => m[1].split(/\s+/)));
    for (const name of names) {
      const mentioned = kind === 'doc'
        ? new RegExp('(?:^|[^\\w-])' + escapeRE(name) + '(?![\\w-])').test(text)
        : htmlTokens.has(name) || patterns.some((p) => p.test(name));
      if (mentioned) references.get(name).push(file);
    }
  }
  return references;
}

// A classList synchronized with className matters here: a fix may put a class
// on an existing host through classList instead of recreating that host.
function mkNode(tag) {
  const node = {
    tag, nodeType: 1, className: '', attrs: {}, children: [], style: {}, dataset: {},
    value: '', textContent: '', disabled: false,
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'value') this.value = String(v); },
    getAttribute(k) { return k === 'class' ? this.className : this.attrs[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    replaceChildren(...kids) { this.children = []; kids.forEach((c) => this.appendChild(c)); },
    addEventListener() {},
    querySelectorAll(selector) { return walk(this).slice(1).filter((n) => selector.startsWith('.') ? classesOf(n).includes(selector.slice(1)) : n.tag === selector); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    get childNodes() { return this.children; },
    get firstChild() { return this.children[0] || null; },
    get innerHTML() { return ''; },
    set innerHTML(value) {
      if (value !== '') throw new Error('DOM harness needs HTML parsing for a new renderer path');
      this.children = [];
    },
  };
  const setClasses = (values) => { node.className = [...new Set(values)].join(' '); };
  node.classList = {
    add(...names) { setClasses([...classesOf(node), ...names]); },
    remove(...names) { setClasses(classesOf(node).filter((c) => !names.includes(c))); },
    contains(name) { return classesOf(node).includes(name); },
    toggle(name, force) { const on = force ?? !this.contains(name); if (on) this.add(name); else this.remove(name); return on; },
  };
  return node;
}
function walk(node) { return [node, ...(node.children || []).flatMap(walk)]; }
const describe = (node) => `<${node.tag}${classesOf(node).map((c) => '.' + c).join('')}>`;

async function renderSamples() {
  globalThis.document = {
    createElement: mkNode, createElementNS: (_ns, tag) => mkNode(tag),
    createTextNode: (text) => ({ text, nodeType: 3 }), getElementById: () => null,
  };
  globalThis.location = { hash: '' };
  const data = {
    '/bridge/conductor': {
      nextCommand: { text: 'Claim a lane', reasonCode: 'task_ready', route: 'tasks' },
      kpi: { activeClaims: 1, openApprovals: 0, stuckWorkers: 0, idleSessions: 0, openTasks: 2, lastSliceAgeMs: 1000 },
      board: { now: [{ id: 't1', title: 'Task one' }], next: [], waiting: [], done: [] },
      scoreMatrix: [{ lane: 'test', reasonCode: 'lane_active', done: 1, total: 2, progress: 0.5 }],
    },
    '/bridge/queue': { columns: ['blue', 'accent', 'ok', 'warn'].map((tone, i) => ({ id: 'column-' + i, title: tone, tone, items: [{ id: 't1', label: 'Task one', reasonCode: 'queue_ready' }] })) },
    '/bridge/claims': { claims: ['claim_healthy', 'claim_idle', 'claim_stale', 'claim_expired'].map((reasonCode) => ({ lane: reasonCode, sessionId: 's1', reasonCode, claimAgeMs: 1000, heartbeatAgeMs: 500 })) },
    '/bridge/boss/sessions': { sessions: [{ id: 'default', messageCount: 4, openProposals: 1 }] },
    '/bridge/boss/sessions/default': {
      transcript: [{ role: 'operator', text: 'Hello' }, { role: 'enforcer', reasonCode: 'allowed' }, { role: 'decision', text: 'allowed' }, { role: 'proposal', proposalId: 'p1' }],
      proposals: [{ id: 'p1', status: 'open', risk: 'low', summary: 'Task one', enforcer: { allow: true, reasonCode: 'allowed' } }],
    },
    '/bridge/projection': { activeSessions: [], claims: [], approvals: [] },
    '/bridge/lanes': { lanes: [] },
    '/bridge/learning': {
      count: 2, byKind: { rule: 1, constraint: 1 }, byLane: { test: 2 },
      facts: [{ id: 'f1', kind: 'rule', text: 'A rule', ts: '2026-01-01T00:00:00Z', tags: [] }, { id: 'f2', kind: 'constraint', text: 'A constraint', ts: '2026-01-01T00:00:00Z', tags: [] }],
    },
    '/bridge/telegram/status': { enabled: true, tokenConfigured: true, tokenTail: '1234', allowedChatIds: [], counts: { inbound: 0, dropped: 0, outboundSent: 0, outboundFailed: 0 } },
  };
  const requests = new Set();
  globalThis.fetch = async (url, init) => {
    if (init?.method && init.method !== 'GET') throw new Error('Unexpected mutation in render harness');
    const path = String(url).split('?')[0];
    if (!(path in data)) throw new Error(`Unstubbed render endpoint: ${path}`);
    requests.add(path);
    return { ok: true, status: 200, json: async () => data[path] };
  };
  const { panel } = await import('../../template/maddu/cockpit/cockpit-util.js');
  const ctx = {
    panelFocus: panel, scopePill: () => null, scopedUrl: (_scope, url) => url,
    onSpineEvent() {}, openInspector() {}, paletteFocus: () => null, focusPanelByKeyword() {}, currentSession: () => 's1',
  };
  const { renderConductor, renderBoss } = await import('../../template/maddu/cockpit/cockpit-views-live-decide-command.js');
  const { renderQueueBoard, renderClaimMap } = await import('../../template/maddu/cockpit/cockpit-views-live-decide-board.js');
  const { renderLearning } = await import('../../template/maddu/cockpit/cockpit-views-inspect.js');
  const { renderAdvisorsCard } = await import('../../template/maddu/cockpit/cockpit-backbone-cards.js');
  const { renderTelegramPanel } = await import('../../template/maddu/cockpit/cockpit-comms.js');
  const { eventRow } = await import('../../template/maddu/cockpit/cockpit-event-rows.js');
  const samples = [
    ['Conductor', renderConductor(ctx)], ['Boss', renderBoss(ctx)],
    ['Queue', renderQueueBoard(ctx)], ['Claims', renderClaimMap(ctx)],
    ['Learning', renderLearning(ctx)], ['Advisors', renderAdvisorsCard([{ id: 'a1', runtime: 'codex', refused: true }])],
  ];
  for (const type of ['FRAMEWORK_UPGRADED', 'SESSION_REGISTERED', 'LANE_CLAIMED', 'SLICE_STOP', 'APPROVAL_REQUESTED', 'DOCTOR_REPORT', 'INBOX_MESSAGE']) {
    samples.push([`Event ${type}`, eventRow({ type, ts: '2026-01-01T00:00:00Z', data: { counts: {} } })]);
  }
  for (const enabled of [true, false]) {
    data['/bridge/telegram/status'].enabled = enabled;
    const mount = mkNode('div'); await renderTelegramPanel(mount);
    samples.push([`Telegram enabled=${enabled}`, mount]);
  }
  // Drain promise chains (fetch -> json -> nested fetch -> replaceChildren),
  // as the existing DOM harness does. No subscriptions/timers are fired.
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  for (const endpoint of Object.keys(data)) if (!requests.has(endpoint)) throw new Error(`Render fixture never fetched ${endpoint}`);
  return samples;
}

function modifierFailures(families, samples) {
  const missing = [], misplaced = [];
  const nodes = samples.flatMap(([view, root]) => walk(root).filter((n) => n.nodeType === 1).map((node) => ({ view, node })));
  for (const family of families.values()) {
    for (const base of new Set(family.pairs.map((p) => p.base))) {
      const pairs = family.pairs.filter((p) => p.base === base);
      const candidates = nodes.filter(({ node }) => classesOf(node).includes(base));
      if (!candidates.some(({ node }) => pairs.some((p) => classesOf(node).includes(p.modifier)))) {
        missing.push({ prefix: family.prefix, base, line: pairs[0].line, candidates });
      }
    }
    for (const { view, node } of nodes) {
      for (const modifier of classesOf(node).filter((c) => c.startsWith(family.prefix))) {
        if (!family.pairs.some((p) => p.modifier === modifier && classesOf(node).includes(p.base))) {
          misplaced.push({ prefix: family.prefix, view, node, modifier, expected: family.pairs.filter((p) => p.modifier === modifier).map((p) => p.base) });
        }
      }
    }
  }
  return { missing, misplaced, nodes };
}

async function main() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
    .filter((f) => f && !f.split('/').includes('node_modules')).sort();
  const text = (file) => readFile(join(ROOT, file), 'utf8').then((s) => s.replace(/\r\n/g, '\n'));
  const css = stylesheet(await text(CSS));
  if (!css.classes.size || !css.families.size) throw new Error('No stylesheet classes/compound modifier families found');
  const artefacts = [];
  for (const file of tracked) {
    const kind = file.startsWith('docs/') ? 'doc'
      : file.startsWith('scripts/test/__golden__/') ? 'html'
        : file.startsWith('template/maddu/cockpit/') && /\.(?:js|mjs|html)$/.test(file) ? (/\.html$/.test(file) ? 'html' : 'js') : null;
    if (kind) artefacts.push({ file, kind, text: await text(file) });
  }
  const referenced = classReferences(css.classes.keys(), artefacts);
  const dead = [...css.classes].filter(([name]) => !referenced.get(name).length);
  ok('2a every cockpit CSS class has a shipped reference', dead.length === 0, `${dead.length} unreferenced classes of ${css.classes.size}`);
  for (const [name, line] of dead) console.log(`    ${CSS}:${line} .${name}`);

  const withoutDocs = classReferences(css.classes.keys(), artefacts.filter((a) => a.kind !== 'doc'));
  ok('2b CONTROL: .is-ghost is live only through shipped DESIGN-SYSTEM.md',
    css.classes.has('is-ghost') && referenced.get('is-ghost')?.includes('docs/DESIGN-SYSTEM.md')
      && withoutDocs.get('is-ghost')?.length === 0);

  const samples = await renderSamples();
  const { missing, misplaced, nodes } = modifierFailures(css.families, samples);
  ok('3a every compound modifier family reaches its stylesheet base', missing.length === 0,
    `${missing.length} unreachable base/family pairs; ${css.families.size} families rendered across ${samples.length} samples`);
  for (const item of missing) {
    console.log(`    ${CSS}:${item.line} expected .${item.base}.${item.prefix}* on ONE element; observed ${item.candidates.map(({ view, node }) => `${view}: ${describe(node)}; children ${node.children.filter((n) => n.nodeType === 1).map(describe).join(', ')}`).join(' | ') || 'no base element (add a populated render sample if this is a new view)'}`);
  }
  ok('3b every rendered family modifier has a compound rule on that element', misplaced.length === 0, `${misplaced.length} misplaced modifier occurrences`);
  for (const item of misplaced) {
    const display = css.rules.filter((r) => r.selector.split(',').some((s) => classesOf(item.node).some((c) => s.trim() === '.' + c)))
      .map((r) => r.body.match(/\bdisplay\s*:\s*([^;]+)/)?.[1]).filter(Boolean).at(-1);
    console.log(`    ${item.view}: ${describe(item.node)}${display ? ` (display: ${display})` : ''}; .${item.modifier} expects ${item.expected.map((b) => '.' + b).join(' or ') || 'a missing compound selector'} on the SAME element`);
  }
  const control = css.families.get('t-');
  const controlNodes = nodes.filter(({ node }) => classesOf(node).some((c) => c.startsWith('t-')));
  // 3c asserts the detector FIRES, not merely that it stayed quiet.
  //
  // Checking only "the real t-* family reported no failure" is satisfied by a
  // detector that reports nothing at all: disable the loops in modifierFailures
  // and the failure arrays are empty, so this control passes while 3a and 3b
  // have quietly stopped meaning anything. So the same real detector is driven
  // over a synthetic family carrying a deliberate misplacement, and the control
  // requires that misplacement to be REPORTED.
  const synthFamily = new Map([['zz-', { prefix: 'zz-', pairs: [{ base: 'zzbase', modifier: 'zz-tone', line: 1 }] }]]);
  const placed = mkNode('div'); placed.setAttribute('class', 'zzbase zz-tone');
  const wellFormed = modifierFailures(synthFamily, [['synthetic', placed]]);

  const strayRoot = mkNode('div'); strayRoot.setAttribute('class', 'zzbase');
  const stray = mkNode('span'); stray.setAttribute('class', 'zz-tone');
  strayRoot.appendChild(stray);
  const broken = modifierFailures(synthFamily, [['synthetic', strayRoot]]);

  const detectorFires = broken.misplaced.some((m) => m.modifier === 'zz-tone')
    && broken.missing.some((m) => m.base === 'zzbase')
    && wellFormed.misplaced.length === 0 && wellFormed.missing.length === 0;

  ok('3c CONTROL: the detector reports a deliberate misplacement, and the real t-* family is clean',
    detectorFires && !!control && control.pairs.length > 1 && controlNodes.length > 1
      && !missing.some((m) => m.prefix === 't-') && !misplaced.some((m) => m.prefix === 't-'),
    `${controlNodes.length} rendered event modifiers; synthetic misplacement ${detectorFires ? 'caught' : 'NOT caught'}`);

  console.log(`\ncockpit-style-liveness: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('cockpit-style-liveness FAILED'); process.exit(1); }
  console.log('cockpit-style-liveness OK');
}
main().catch((err) => { console.error('harness error:', err); process.exit(2); });
