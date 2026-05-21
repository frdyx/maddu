// Agent-context builder — Phase 6 of the v0.17 agent-native rollout.
//
// Builds a self-contained snapshot an agent can read at turn start
// without opening multiple files. The text rendition fits the `maddu
// brief --for-agent` need (single CLI block); the JSON rendition is
// served by GET /bridge/agent-context.
//
// Inputs: a projection (rebuilt deterministically from the spine).
// Outputs: { goal, phase, activeSession, openFollowups, laneCatalog,
//            recentSliceStops, sessionsTreeSummary, janitor }.

// v0.19 Phase 3 — skill auto-injection.
//
// Cap injected skills per orientation. Hard limits enforced by both the
// matcher (returns at most MAX_SKILLS) and the rendered output (truncates
// each body to MAX_BYTES_PER_SKILL). The `skill-injection-bounded` gate
// verifies these constants are honored on every orientation read.
export const MAX_INJECTED_SKILLS = 3;
export const MAX_INJECTED_BYTES_PER_SKILL = 8192; // 8 KB per skill

// Pure matcher. Given a list of skills (each with `triggers: [str]?` and
// `tags: [str]?` in their parsed frontmatter) and a context object with
// `triggers` (string array) + `tags` (string array), return up to
// MAX_INJECTED_SKILLS matches ranked by:
//   1. Number of trigger matches (descending).
//   2. Number of tag matches (descending).
//   3. Skill `updated` timestamp (descending — recency tiebreak).
//
// Deterministic, side-effect free. Easy to test in isolation.
export function matchSkillsForContext(skills, ctx) {
  if (!Array.isArray(skills) || skills.length === 0) return [];
  const triggers = new Set((ctx?.triggers || []).map((s) => String(s).toLowerCase()));
  const tags = new Set((ctx?.tags || []).map((s) => String(s).toLowerCase()));
  const scored = [];
  for (const s of skills) {
    const sTriggers = Array.isArray(s.triggers) ? s.triggers.map((x) => String(x).toLowerCase()) : [];
    const sTags = Array.isArray(s.tags) ? s.tags.map((x) => String(x).toLowerCase()) : [];
    let triggerHits = 0;
    for (const t of sTriggers) if (triggers.has(t)) triggerHits++;
    let tagHits = 0;
    for (const t of sTags) if (tags.has(t)) tagHits++;
    if (triggerHits === 0 && tagHits === 0) continue;
    scored.push({ skill: s, triggerHits, tagHits, updated: s.updated || '' });
  }
  scored.sort((a, b) => {
    if (b.triggerHits !== a.triggerHits) return b.triggerHits - a.triggerHits;
    if (b.tagHits !== a.tagHits) return b.tagHits - a.tagHits;
    return (b.updated || '').localeCompare(a.updated || '');
  });
  return scored.slice(0, MAX_INJECTED_SKILLS).map((x) => x.skill);
}

// Build the structured context object. Deterministic — given the
// same projection, the same object is returned. No wall-clock reads.
export function buildAgentContext(proj) {
  const active = (proj.activeSessions || []).map((s) => ({
    id: s.id, role: s.role, label: s.label, focus: s.focus,
    source: s.source || null,
  }));
  // Lane catalog from claims + sessions. We don't have a direct
  // accessor on the projection so derive from claims for the active
  // set; a fuller list lives in .maddu/lanes/catalog.json which the
  // operator owns. Keep this view to lanes currently being used.
  const claims = (proj.claims || []).map((c) => ({
    lane: c.lane, sessionId: c.sessionId, focus: c.focus, claimedAt: c.claimedAt,
  }));
  const recentSliceStops = (proj.sliceStops || []).slice(-5).map((s) => ({
    id: s.id, summary: s.summary || s.data?.summary || null,
    ts: s.ts, actor: s.actor || null,
  }));
  const tree = proj.sessionsTree || {};
  const sessionsTreeSummary = {
    total: Object.keys(tree).length,
    activeRoots: Object.entries(tree)
      .filter(([, n]) => !n.parentSessionId && n.state === 'active')
      .map(([id]) => id),
  };
  return {
    lastEventId: proj.lastEventId || null,
    goal: proj.goal || null,
    phase: proj.phase || null,
    activeSession: active[0] || null,
    activeSessions: active,
    openFollowups: (proj.openFollowups || []).map((f) => ({
      severity: f.severity, fromReviewEventId: f.fromReviewEventId,
    })),
    laneClaims: claims,
    recentSliceStops,
    sessionsTreeSummary,
    janitor: proj.janitor || null,
  };
}

// Render the context as a single readable text block for an agent's
// turn-start prompt. Plain text, no ANSI. Sections kept terse.
export function renderAgentContextText(ctx) {
  const lines = [];
  lines.push('You are operating inside a Máddu repo.');
  lines.push('');
  if (ctx.goal) {
    lines.push(`Goal: ${ctx.goal.objective}`);
    if (ctx.goal.constraints?.length) {
      for (const c of ctx.goal.constraints) lines.push(`  - constraint: ${c}`);
    }
  } else {
    lines.push('Goal: (none declared — operator may set one with `maddu goal set`)');
  }
  if (ctx.phase) {
    lines.push(`Phase: ${ctx.phase.name}`);
    if (ctx.phase.notes) lines.push(`  notes: ${ctx.phase.notes}`);
  } else {
    lines.push('Phase: (none declared)');
  }
  if (ctx.activeSession) {
    lines.push('');
    lines.push(`Active session: ${ctx.activeSession.id}`);
    lines.push(`  role:  ${ctx.activeSession.role || '—'}`);
    lines.push(`  label: ${ctx.activeSession.label || '—'}`);
    if (ctx.activeSession.focus) lines.push(`  focus: ${ctx.activeSession.focus}`);
  } else {
    lines.push('');
    lines.push('Active session: (none — run `./maddu/run register` to bootstrap one)');
  }
  if (ctx.openFollowups?.length) {
    lines.push('');
    lines.push(`Open follow-ups (${ctx.openFollowups.length}):`);
    for (const f of ctx.openFollowups) {
      lines.push(`  [${f.severity}] ${f.fromReviewEventId}`);
    }
  }
  if (ctx.laneClaims?.length) {
    lines.push('');
    lines.push(`Lane claims (${ctx.laneClaims.length}):`);
    for (const c of ctx.laneClaims) {
      lines.push(`  ${c.lane}  ← ${c.sessionId}${c.focus ? '  ' + c.focus : ''}`);
    }
  }
  if (ctx.recentSliceStops?.length) {
    lines.push('');
    lines.push(`Recent slice-stops (${ctx.recentSliceStops.length}):`);
    for (const s of ctx.recentSliceStops) {
      lines.push(`  ${s.id}  ${s.summary || '—'}`);
    }
  }
  if (ctx.sessionsTreeSummary?.total) {
    lines.push('');
    lines.push(`Session tree: ${ctx.sessionsTreeSummary.total} total, ${ctx.sessionsTreeSummary.activeRoots.length} active root(s)`);
  }
  if (ctx.janitor && (ctx.janitor.staleSessions?.length || ctx.janitor.autoClosedTotal)) {
    lines.push('');
    lines.push(`Janitor: ${ctx.janitor.staleSessions?.length || 0} stale session(s), ${ctx.janitor.autoClosedTotal || 0} auto-closed total`);
  }
  lines.push('');
  lines.push('Turn-start ritual: `./maddu/run brief` · `./maddu/run register` · `./maddu/run status`.');
  lines.push('Full brief: MADDU.md at repo root.');
  // v0.19 Phase 3 — auto-injected skills appear under a clearly-marked
  // section so the agent (and the doctor gate) can find them.
  if (Array.isArray(ctx.injectedSkills) && ctx.injectedSkills.length > 0) {
    lines.push('');
    lines.push(`## Skills injected for this slice (${ctx.injectedSkills.length})`);
    for (const s of ctx.injectedSkills) {
      lines.push('');
      lines.push(`### ${s.id}${s.title ? ` — ${s.title}` : ''}`);
      const body = (s.body || '').slice(0, MAX_INJECTED_BYTES_PER_SKILL);
      lines.push(body);
      if ((s.body || '').length > MAX_INJECTED_BYTES_PER_SKILL) {
        lines.push(`_(truncated to ${MAX_INJECTED_BYTES_PER_SKILL} bytes)_`);
      }
    }
  }
  return lines.join('\n') + '\n';
}
