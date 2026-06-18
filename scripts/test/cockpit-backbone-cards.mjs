#!/usr/bin/env node
// cockpit-backbone-cards (v1.40.0) — the pure data→DOM card renderers extracted
// from cockpit.js. Imported under a minimal `document` stub; we assert each card
// returns the expected node shape (empty-state placeholder vs populated rows).
// The full visual render is covered headlessly by the cockpit-snapshot gate;
// this is the unit guard that the extraction preserved structure.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

function mkNode(tag) {
  return {
    tag, className: '', innerHTML: '', textContent: '', attrs: {}, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    get childNodes() { return this.children; },
  };
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createTextNode(text) { return { text, nodeType: 3 }; },
};

const m = await import('../../template/maddu/cockpit/cockpit-backbone-cards.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const EXPORTS = ['renderAdvisorsCard', 'renderSkillInjectionsCard', 'renderModelRoutingRuntimes',
  'renderModelRoutingLanes', 'renderModelRoutingPipelines', 'renderTestStatusCard',
  'renderTeamsCard', 'renderPipelinesCard', 'renderCostCard', 'renderSlashCheatsheet'];
for (const n of EXPORTS) ok(`exports ${n}`, typeof m[n] === 'function');

// Empty → unified empty-state placeholder.
ok('advisors [] → empty-state', m.renderAdvisorsCard([]).className === 'empty-state');
ok('skillInjections [] → empty-state', m.renderSkillInjectionsCard([]).className === 'empty-state');
ok('modelRoutingRuntimes [] → empty-state', m.renderModelRoutingRuntimes([]).className === 'empty-state');
ok('modelRoutingLanes [] → empty-state', m.renderModelRoutingLanes([]).className === 'empty-state');
ok('modelRoutingLanes no-defaults → empty-state', m.renderModelRoutingLanes([{ id: 'a' }]).className === 'empty-state');
ok('modelRoutingPipelines [] → empty-state', m.renderModelRoutingPipelines([]).className === 'empty-state');
ok('testStatus {} → empty-state', m.renderTestStatusCard({}).className === 'empty-state');
ok('teams [] → empty-state', m.renderTeamsCard([]).className === 'empty-state');
ok('pipelines [] → empty-state', m.renderPipelinesCard([]).className === 'empty-state');
ok('cost [] → empty-state', m.renderCostCard([]).className === 'empty-state');

// Populated → a wrapper div carrying panel-row children.
const adv = m.renderAdvisorsCard([{ id: 'a1', runtime: 'codex', ts: '2026-06-19T12:00:00Z' }]);
ok('advisors populated → 1 panel-row', adv.children.length === 1 && adv.children[0].className === 'panel-row');

const runtimes = m.renderModelRoutingRuntimes([{ id: 'r1', kind: 'cli', modelPreference: 'opus' }]);
ok('modelRoutingRuntimes populated → panel-row', runtimes.children[0].className === 'panel-row');

const lanes = m.renderModelRoutingLanes([{ id: 'L', defaults: { modelPreference: 'sonnet' } }]);
ok('modelRoutingLanes with defaults → panel-row', lanes.children[0].className === 'panel-row');

const ts = m.renderTestStatusCard({ stress: { completedAt: '2026-06-19T12:00:00Z', summary: 'ok' } });
ok('testStatus with data → panel-row', ts.children[0].className === 'panel-row');

const teams = m.renderTeamsCard([{ id: 't1', status: 'open', lanes: ['a'], members: [{}] }]);
ok('teams populated → panel-row', teams.children[0].className === 'panel-row');

const pipes = m.renderPipelinesCard([{ id: 'p1', status: 'completed', stages: [{ name: 's', status: 'ok' }] }]);
ok('pipelines populated → panel-row', pipes.children[0].className === 'panel-row');

const cost = m.renderCostCard([{ runtime: 'codex', inputTokens: 10, outputTokens: 5 }]);
ok('cost populated → meta + runtime row', cost.children.length === 2 && cost.children[1].className === 'panel-row');

const cheat = m.renderSlashCheatsheet();
ok('slashCheatsheet → 12 rows + trailing note', cheat.children.length === 13 && cheat.children[12].tag === 'p');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
