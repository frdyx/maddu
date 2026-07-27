// atlas-domains — domain derivation (contract §5, slice A4)
// Pure functions, no I/O, no repo imports besides atlas-vocab.

import { MEMBERSHIP_EDGES, MEMBERSHIP_TRANSITIVE_EDGES } from './atlas-vocab.mjs';

// The synthetic, always-visible fallback domain (contract §5 "Fallback bucket").
export const UNASSIGNED_DOMAIN_ID = 'urn:maddu:atlas:v1:bounded-context:_unassigned';

// Rule B fires on exactly the edge types atlas-vocab.mjs declares for it
// (contract §5: "1 hop out of a bounded context along owns/realizes").
// Single source of truth — do not redefine this locally.

// Rule D's locator pattern (contract §5 / §4.1).
const LOCATOR_COMMAND_FILE_RE = /^commands\/([a-z0-9-]+)\.mjs$/;

// Priority order for choosing which rule's basis label to report when
// multiple rules independently propose the SAME domain for one entity
// ("later rules never overwrite an earlier basis" — contract §5).
const RULE_PRIORITY = ['graph-1hop', 'capability-matrix-verb', 'locator-command-file'];

const BASIS_CONFIDENCE = {
  self: 'declared',
  'graph-1hop': 'declared',
  'capability-matrix-verb': 'declared',
  'locator-command-file': 'derived',
  'propagated-1hop': 'inferred',
};

function idTail(id) {
  const i = String(id).lastIndexOf(':');
  return i === -1 ? String(id) : String(id).slice(i + 1);
}

// verbToDomain: Map<verb, boundedContextId> via
// commands[].purposeGroup -> purposeGroups[g].boundedContext (contract §5).
function buildVerbToDomain(capabilityMatrix) {
  const map = new Map();
  const commands = capabilityMatrix && Array.isArray(capabilityMatrix.commands)
    ? capabilityMatrix.commands : [];
  const groups = (capabilityMatrix && capabilityMatrix.purposeGroups) || {};
  for (const cmd of commands) {
    if (!cmd || typeof cmd.verb !== 'string') continue;
    const group = groups[cmd.purposeGroup];
    if (group && typeof group.boundedContext === 'string') {
      map.set(cmd.verb, group.boundedContext);
    }
  }
  return map;
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function byEntityId(a, b) {
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

/**
 * deriveDomains(entities, relationships, capabilityMatrix, opts)
 *   -> { domains, membership, unassigned, ambiguous, stats }
 *
 * Rules A -> E, in order (contract §5). Conflicts are resolved
 * order-independently: every candidate domain for an entity is gathered
 * (across every rule that fires for it) before a decision is made — never
 * "first writer wins". Exactly one candidate -> assign. More than one ->
 * ambiguous, counted toward no domain. A later rule never rescues an entity
 * already marked ambiguous, and never overwrites an earlier rule's basis
 * when both agree on the same domain.
 */
export function deriveDomains(entities, relationships, capabilityMatrix, opts) {
  const options = opts || {};
  const propagate = options.propagate === true;
  const entityList = Array.isArray(entities) ? entities : [];
  const relList = Array.isArray(relationships) ? relationships : [];

  const entityById = new Map();
  for (const e of entityList) {
    if (e && typeof e.id === 'string') entityById.set(e.id, e);
  }

  // Rule A — every bounded-context IS a domain, and is NEVER a member of any
  // domain, including itself (contract §5 "self-membership").
  const boundedContextIds = new Set();
  for (const e of entityList) {
    if (e && e.kind === 'bounded-context' && typeof e.id === 'string') {
      boundedContextIds.add(e.id);
    }
  }

  const verbToDomain = buildVerbToDomain(capabilityMatrix);

  // candidates: entityId -> Map<domainId, Set<basis>>
  const candidates = new Map();
  function addCandidate(entityId, domainId, basis) {
    if (boundedContextIds.has(entityId)) return; // rule A invariant: never a member
    let m = candidates.get(entityId);
    if (!m) { m = new Map(); candidates.set(entityId, m); }
    let bases = m.get(domainId);
    if (!bases) { bases = new Set(); m.set(domainId, bases); }
    bases.add(basis);
  }

  // Rule B — graph-1hop: owns/realizes FROM a bounded context, target must
  // be a known entity id. A broken edge (unresolved target) creates no member.
  for (const rel of relList) {
    if (!rel || !MEMBERSHIP_EDGES.includes(rel.type)) continue;
    if (!boundedContextIds.has(rel.from)) continue;
    if (typeof rel.to !== 'string' || !entityById.has(rel.to)) continue;
    addCandidate(rel.to, rel.from, 'graph-1hop');
  }

  // Rule C — capability-matrix-verb: kind:'command' whose id tail is a
  // known verb.
  for (const e of entityList) {
    if (!e || e.kind !== 'command' || typeof e.id !== 'string') continue;
    if (boundedContextIds.has(e.id)) continue;
    const domain = verbToDomain.get(idTail(e.id));
    if (domain) addCandidate(e.id, domain, 'capability-matrix-verb');
  }

  // Rule D — locator-command-file: every locators[].path matching
  // commands/<verb>.mjs whose slug is a known verb contributes a candidate.
  // [measured against the real corpus, resolves a fixture/contract
  // disagreement — see report] The fixture's own prose ("takes only the
  // first matching locator per entity, so no entity can be internally
  // ambiguous within rule D") only holds because every fixture entity has at
  // most one commands/*.mjs locator. The real corpus does not: e.g.
  // `flow:managed-upgrade` carries BOTH `commands/upgrade.mjs`
  // (-> operations-topology) and `commands/fleet.mjs`
  // (-> operator-experience) — two different mapped verbs on one entity.
  // Stopping at the array-first match assigns it a single domain and
  // silently drops the frozen-table contested/D=304/members=388 result
  // (measured: single-match gives D=305, members=389, ambiguous=2).
  // Gathering every matching locator and letting the same order-independent
  // "gather all candidates, then decide" rule used elsewhere in §5 apply is
  // what reproduces the frozen table exactly.
  for (const e of entityList) {
    if (!e || typeof e.id !== 'string' || boundedContextIds.has(e.id)) continue;
    const locators = Array.isArray(e.locators) ? e.locators : [];
    for (const loc of locators) {
      const path = loc && loc.path;
      if (typeof path !== 'string') continue;
      const m = LOCATOR_COMMAND_FILE_RE.exec(path);
      if (!m) continue;
      const domain = verbToDomain.get(m[1]);
      if (domain) addCandidate(e.id, domain, 'locator-command-file');
    }
  }

  // Decide A-D candidates: exactly one distinct domain -> assign (basis =
  // earliest rule in priority order that proposed it); more than one -> ambiguous.
  const membership = [];
  const ambiguousMap = new Map(); // entityId -> resolutionIssues[]
  const assignedDomain = new Map(); // entityId -> domainId (post A-D, pre-E)

  for (const [entityId, domainMap] of candidates) {
    const domainIds = [...domainMap.keys()];
    if (domainIds.length === 1) {
      const domainId = domainIds[0];
      const bases = domainMap.get(domainId);
      const basis = RULE_PRIORITY.find((b) => bases.has(b)) || [...bases][0];
      assignedDomain.set(entityId, domainId);
      membership.push({
        entityId,
        domain: domainId,
        domainBasis: basis,
        domainConfidence: BASIS_CONFIDENCE[basis] || null,
        derived: ['domain', 'domainBasis'],
      });
    } else {
      const issues = [];
      for (const [domainId, bases] of domainMap) {
        for (const basis of bases) issues.push(`${domainId}:${basis}`);
      }
      issues.sort();
      ambiguousMap.set(entityId, issues);
    }
  }

  // Rule E — propagated-1hop, default OFF, exactly one round (no fixpoint).
  // Sources are fixed at the post-A-D state: a bounded context (its own
  // domain) or an entity already assigned exactly one domain. A target
  // already assigned or already ambiguous from A-D is never touched.
  if (propagate) {
    const sourceDomain = new Map();
    for (const id of boundedContextIds) sourceDomain.set(id, id);
    for (const [id, d] of assignedDomain) sourceDomain.set(id, d);

    const propCandidates = new Map(); // entityId -> Set<domainId>
    for (const rel of relList) {
      if (!rel || !MEMBERSHIP_TRANSITIVE_EDGES.includes(rel.type)) continue;
      const from = rel.from, to = rel.to;
      if (typeof from !== 'string' || typeof to !== 'string') continue;
      if (!entityById.has(to)) continue; // broken edge, no propagation target
      if (boundedContextIds.has(to)) continue; // rule A invariant
      if (assignedDomain.has(to) || ambiguousMap.has(to)) continue; // never overwrite/rescue
      const domain = sourceDomain.get(from);
      if (!domain) continue; // source has no single domain -> not a propagating neighbour
      let set = propCandidates.get(to);
      if (!set) { set = new Set(); propCandidates.set(to, set); }
      set.add(domain);
    }

    for (const [entityId, domainSet] of propCandidates) {
      const domainIds = [...domainSet];
      if (domainIds.length === 1) {
        assignedDomain.set(entityId, domainIds[0]);
        membership.push({
          entityId,
          domain: domainIds[0],
          domainBasis: 'propagated-1hop',
          domainConfidence: BASIS_CONFIDENCE['propagated-1hop'],
          derived: ['domain', 'domainBasis'],
        });
      } else {
        ambiguousMap.set(entityId, domainIds.map((d) => `${d}:propagated-1hop`).sort());
      }
    }
  }

  // Bucket everything else as unassigned (never bounded-context, never a
  // member, never ambiguous).
  const memberIds = new Set(membership.map((m) => m.entityId));
  const unassigned = [];
  for (const e of entityList) {
    if (!e || typeof e.id !== 'string') continue;
    if (boundedContextIds.has(e.id)) continue;
    if (memberIds.has(e.id)) continue;
    if (ambiguousMap.has(e.id)) continue;
    unassigned.push(e.id);
  }

  // Domains bucket: one per bounded-context entity, plus the always-visible
  // synthetic fallback (contract §5 "Fallback bucket").
  const memberCountByDomain = new Map();
  for (const m of membership) {
    memberCountByDomain.set(m.domain, (memberCountByDomain.get(m.domain) || 0) + 1);
  }
  const domains = [...boundedContextIds].map((id) => ({
    id,
    synthetic: false,
    basis: 'self',
    confidence: BASIS_CONFIDENCE.self,
    memberCount: memberCountByDomain.get(id) || 0,
  }));
  domains.push({
    id: UNASSIGNED_DOMAIN_ID,
    synthetic: true,
    basis: null,
    confidence: null,
    memberCount: unassigned.length,
  });
  domains.sort(byId);

  const ambiguous = [...ambiguousMap.keys()].map((entityId) => ({
    entityId,
    domain: null,
    domainAmbiguous: true,
    resolutionIssues: ambiguousMap.get(entityId),
  }));
  ambiguous.sort(byEntityId);

  membership.sort(byEntityId);
  unassigned.sort();

  const totalEntities = entityList.filter((e) => e && typeof e.id === 'string').length;
  const domainEntities = boundedContextIds.size;
  const memberCount = membership.length;
  const ambiguousCount = ambiguous.length;
  const unassignedCount = unassigned.length;

  const ruleCounts = { A: domainEntities, B: 0, C: 0, D: 0, E: 0 };
  const BASIS_TO_RULE = {
    'graph-1hop': 'B',
    'capability-matrix-verb': 'C',
    'locator-command-file': 'D',
    'propagated-1hop': 'E',
  };
  for (const m of membership) {
    const rule = BASIS_TO_RULE[m.domainBasis];
    if (rule) ruleCounts[rule] += 1;
  }

  const stats = {
    entityCount: totalEntities,
    domainEntities,
    memberCount,
    ambiguousCount,
    unassignedCount,
    ruleCounts,
    propagate,
    conserves: (memberCount + domainEntities + ambiguousCount + unassignedCount) === totalEntities,
  };

  return { domains, membership, unassigned, ambiguous, stats };
}
