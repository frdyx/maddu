// Máddu cockpit — backbone route views (v0.18 single-panel routes).
//
// Extracted from cockpit.js (v1.45.0) as the FIRST view-module slice of Phase 1.
// Each renderer builds a route page that fetches one bridge slice and renders it
// through an already-extracted card builder. Their only shell dependency is the
// stream-refresh binder, injected via `ctx.bindRefresh` (the dependency-injection
// seam): the view module imports ONLY leaves + route metadata + card builders and
// never reaches back into cockpit.js, so there is no circular import.
//
// ctx.bindRefresh(load) — runs load() once, then re-runs it (debounced) on every
// spine event until the route changes. Owned by cockpit.js (it closes over the
// page-wide event stream + the active route view).

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';
import {
  renderPipelinesCard, renderCostCard, renderAdvisorsCard, renderSkillInjectionsCard,
  renderModelRoutingRuntimes, renderModelRoutingLanes, renderModelRoutingPipelines,
  renderTestStatusCard,
} from './cockpit-backbone-cards.js';

export function renderPipelinesRoute(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Pipelines'));
  root.appendChild(el('p', {}, ROUTE_META.pipelines.description));

  const host = el('div', {});
  host.appendChild(loading('Loading pipelines…'));
  root.appendChild(panel('Pipeline runs', 'GET /bridge/pipelines', host));

  ctx.bindRefresh(async () => {
    let data;
    try {
      const r = await fetch('/bridge/pipelines', { cache: 'no-store' });
      data = await r.json();
    } catch {
      host.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    host.replaceChildren(renderPipelinesCard(data.pipelines || []));
  });
  return root;
}

export function renderCostRoute(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Cost'));
  root.appendChild(el('p', {}, ROUTE_META.cost.description));

  const host = el('div', {});
  host.appendChild(loading('Loading token ledger…'));
  root.appendChild(panel('Token + call rollup', 'GET /bridge/cost', host));

  ctx.bindRefresh(async () => {
    let data;
    try {
      const r = await fetch('/bridge/cost', { cache: 'no-store' });
      data = await r.json();
    } catch {
      host.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    host.replaceChildren(renderCostCard(data.tokenLedger || []));
  });
  return root;
}

export function renderAdvisorsRoute(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Advisors'));
  root.appendChild(el('p', {}, ROUTE_META.advisors.description));

  const host = el('div', {});
  host.appendChild(loading('Loading advisor artifacts…'));
  root.appendChild(panel('Advisor artifacts', 'GET /bridge/advisors', host));

  ctx.bindRefresh(async () => {
    let data;
    try {
      const r = await fetch('/bridge/advisors', { cache: 'no-store' });
      data = await r.json();
    } catch {
      host.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    host.replaceChildren(renderAdvisorsCard(data.advisors || []));
  });
  return root;
}

export function renderSkillInjectionsRoute(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Skill Injections'));
  root.appendChild(el('p', {}, ROUTE_META.skillinjections.description));

  const host = el('div', {});
  host.appendChild(loading('Loading injection log…'));
  root.appendChild(panel('SKILL_INJECTED events', 'GET /bridge/skill-injections', host));

  ctx.bindRefresh(async () => {
    let data;
    try {
      const r = await fetch('/bridge/skill-injections', { cache: 'no-store' });
      data = await r.json();
    } catch {
      host.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    host.replaceChildren(renderSkillInjectionsCard(data.skillInjections || []));
  });
  return root;
}

export function renderModelRoutingRoute(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Model Routing'));
  root.appendChild(el('p', {}, ROUTE_META.modelrouting.description));

  const runtimesHost = el('div', {});
  runtimesHost.appendChild(loading('Loading runtime descriptors…'));
  root.appendChild(panel('Per-runtime modelPreference', 'GET /bridge/runtimes', runtimesHost));

  const lanesHost = el('div', {});
  lanesHost.appendChild(loading('Loading lane defaults…'));
  root.appendChild(panel('Per-lane defaults', 'GET /bridge/lanes', lanesHost));

  const pipelinesHost = el('div', {});
  pipelinesHost.appendChild(loading('Loading pipeline stage hints…'));
  root.appendChild(panel('Per-pipeline stage hints', 'GET /bridge/pipelines', pipelinesHost));

  ctx.bindRefresh(async () => {
    let runtimesData, lanesData, pipelinesData;
    try {
      [runtimesData, lanesData, pipelinesData] = await Promise.all([
        fetch('/bridge/runtimes', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch('/bridge/lanes', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch('/bridge/pipelines', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      ]);
    } catch {
      runtimesHost.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    runtimesHost.replaceChildren(renderModelRoutingRuntimes((runtimesData && runtimesData.runtimes) || []));
    lanesHost.replaceChildren(renderModelRoutingLanes(((lanesData && lanesData.catalog && lanesData.catalog.lanes) || lanesData && lanesData.lanes) || []));
    pipelinesHost.replaceChildren(renderModelRoutingPipelines((pipelinesData && pipelinesData.pipelines) || []));
  });
  return root;
}

export function renderTestStatusRoute(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Test Status'));
  root.appendChild(el('p', {}, ROUTE_META.teststatus.description));

  const host = el('div', {});
  host.appendChild(loading('Loading test status…'));
  root.appendChild(panel('Latest test runs', 'GET /bridge/test-status', host));

  ctx.bindRefresh(async () => {
    let data;
    try {
      const r = await fetch('/bridge/test-status', { cache: 'no-store' });
      data = await r.json();
    } catch {
      host.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    host.replaceChildren(renderTestStatusCard(data || {}));
  });
  return root;
}
