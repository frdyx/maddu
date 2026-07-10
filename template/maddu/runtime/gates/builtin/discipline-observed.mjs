// discipline-observed — surfaces Máddu's self-discipline enforcement in
// `maddu doctor`: is the record being kept (session/lane/goal-or-plan present,
// slice-stops current, work being committed), and — critically — is the
// enforcement actually WIRED (the PreToolUse hook installed) for the configured
// governance mode? Codex flagged that a repo can configure strict enforcement
// yet never install the hook, so discipline silently does nothing.
//
// Read-only and severity 'warn' — this reports discipline; it never fails a
// build. The hard enforcement happens at the PreToolUse hook, not here.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lib = (name) => pathToFileURL(join(__dirname, '..', '..', 'lib', name)).href;

export default {
  id: 'discipline-observed',
  label: 'self-discipline rituals observed',
  severity: 'warn',
  description: 'Máddu\'s session rituals are current (session/lane/goal-or-plan present, slice-stops fresh, work committed) and — for enforcing governance modes — the PreToolUse enforcement hook is actually installed.',
  run: async (ctx) => {
    let discipline, governance, sessionActive, claudeHooks;
    try {
      discipline = await import(lib('discipline.mjs'));
      governance = await import(lib('governance.mjs'));
      sessionActive = await import(lib('session-active.mjs'));
      claudeHooks = await import(lib('claude-hooks.mjs'));
    } catch {
      return { ok: true, message: 'discipline libs not available (older install) — skipped' };
    }

    const repoRoot = ctx.repoRoot;
    const cfg = await governance.readEffectiveGovernance(repoRoot).catch(() => ({ mode: 'standard', overrides: {} }));
    const enforcement = governance.effectiveValue(cfg, 'discipline-enforcement') || 'graduated';
    const enforcing = enforcement === 'block' || enforcement === 'graduated';

    // Is the PreToolUse enforcement hook actually wired?
    let hookWired = false;
    try {
      const { settings } = await claudeHooks.loadSettings(repoRoot);
      const groups = settings?.hooks?.PreToolUse || [];
      hookWired = groups.some((g) => (g.hooks || []).some((h) => /maddu\.mjs.*hooks fire pre-tool-use|hooks fire pre-tool-use/.test(String(h.command || ''))));
    } catch { /* fail-safe: treat as unknown */ }

    // Gather current ritual state (best-effort; fail-open to a healthy read).
    let sid = null;
    try { const a = await sessionActive.readActiveSessionVerified(repoRoot); sid = a && a.sessionId; } catch {}
    let state = null;
    try { state = await discipline.gatherRitualState(repoRoot, sid, Date.now(), { dirtyBaseline: [], editsSinceSlice: 0 }); } catch {}

    const problems = [];
    if (enforcing && !hookWired) problems.push(`enforcement is "${enforcement}" but the PreToolUse hook is NOT installed — run \`maddu hooks install\` (discipline currently does nothing)`);

    // audit P2 (C6c/F9): out-of-band config provenance. Replay the recorded
    // governance changes and reconcile STORED config (mode + the discipline-
    // enforcement override) against them. A mismatch means the config was changed
    // without a recorded governance command (a possible out-of-band edit that would
    // silently weaken enforcement). Compares STORED mode (not effective — phase
    // escalation is effective-only and never tampering). Best-effort; warn-only.
    try {
      const spine = await import(lib('spine.mjs'));
      const events = await spine.readAll(repoRoot);
      let recMode = 'standard';           // readGovernance's default when unset
      let recOverride = null;             // no discipline-enforcement override recorded
      for (const e of events) {
        if (e.type === 'GOVERNANCE_MODE_CHANGED') recMode = e.data?.to || recMode;
        else if (e.type === 'GOVERNANCE_OVERRIDE_CHANGED' && e.data?.key === 'discipline-enforcement') {
          recOverride = e.data.to == null ? null : String(e.data.to);
        }
      }
      const stored = await governance.readGovernance(repoRoot);
      const storedMode = stored.mode;
      const storedOverride = stored.overrides && Object.prototype.hasOwnProperty.call(stored.overrides, 'discipline-enforcement')
        ? String(stored.overrides['discipline-enforcement']) : null;
      if (storedMode !== recMode || storedOverride !== recOverride) {
        problems.push(`governance state not accounted for by any recorded change (possible out-of-band config edit): stored{mode:${storedMode}, enf-override:${storedOverride ?? 'none'}} vs recorded{mode:${recMode}, enf-override:${recOverride ?? 'none'}}`);
      }
    } catch { /* provenance reconcile is best-effort */ }

    if (state) {
      if (!state.session?.registered) problems.push('no active session registered');
      if (!state.lane?.claimed) problems.push('no lane claimed');
      if (!state.goalOrPlan?.active) problems.push('no active goal or open plan governs current work');
      if (state.commit && state.commit.newDirtyFiles >= 15) problems.push(`${state.commit.newDirtyFiles} uncommitted files piling up`);
    }

    const summary = state
      ? `mode=${cfg.mode} enforcement=${enforcement} hook=${hookWired ? 'wired' : 'MISSING'} · session=${state.session?.registered ? 'ok' : 'none'} lane=${state.lane?.claimed ? 'ok' : 'none'} goal/plan=${state.goalOrPlan?.active ? 'ok' : 'none'} dirty=${state.commit?.newDirtyFiles ?? '?'}`
      : `mode=${cfg.mode} enforcement=${enforcement} hook=${hookWired ? 'wired' : 'MISSING'}`;

    if (problems.length === 0) return { ok: true, message: `rituals observed — ${summary}` };
    return { ok: false, message: `${problems.length} discipline gap(s) — ${summary}`, evidence: { problems } };
  },
};
