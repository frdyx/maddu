// Spine → projection rebuild.
//
// Projections are derived state. The spine is authoritative. If a projection
// disagrees with the spine, the spine wins — re-derive.
//
// Slice 3 keeps it simple: rebuild on every read. Incremental update lands later
// once the spine grows. None of these projections are persisted — they're
// recomputed on each call. Persistence comes in Slice 4 with maddu doctor.

import { readAll, STUCK_THRESHOLD_MS } from './spine.mjs';
import { readActiveReplicaId } from './spine-append-core.mjs';

// Projection schema version (roadmap #13, compat spine). Stamped into every
// project() result so a reader can tell which shape it's holding. Bump this when
// the projection's top-level shape changes in a way a reader must know about. A
// projection with NO schemaVersion is legacy (pre-v1.84) and reads as 0.
export const SCHEMA_VERSION = 1;

export async function project(repoRoot) {
  const events = await readAll(repoRoot);
  // Roadmap #12c phase 4 — lane-claim reconciliation is SCOPED to team-sync
  // mode (replica.json present). On the default single-machine path the reducer
  // runs the EXACT pre-#12c lane logic (last-writer claim, unconditional
  // release-clear) so the projection is byte-identical for every history —
  // including the local claim/release races the mutex-free spine can produce.
  // Reconciliation (earliest-in-total-order holder + read-time contentions) is
  // the correct convergent semantic for a MERGED multi-writer spine, where a
  // single-writer append-order LWW is undefined; it activates only once the
  // operator opts in via `spine sync init`.
  const syncMode = !!(await readActiveReplicaId(repoRoot));

  const sessions = new Map();              // sessionId -> { id, role, label, focus, registeredAt, lastHeartbeatAt, closedAt, status }
  // v0.17 sessionsTree: parent/child provenance for session spawn graphs.
  //   sessionId -> { parentSessionId, source, state, lastHeartbeatAt }
  // childSessionIds populated in a reverse-index pass after replay.
  const sessionsTree = new Map();
  // v0.17 janitor: rolling window of stale-detected sessions and the
  // auto-closed counter (last hour, for the cockpit). Rebuilt per
  // project() call from SESSION_STALE_DETECTED + SESSION_AUTO_CLOSED.
  const janitorStaleSet = new Set();
  let janitorAutoClosedThisHour = 0;
  let janitorLastRunAt = null;
  const hourMs = 60 * 60 * 1000;
  // Default-path lane claims (pre-#12c behavior): lane -> { lane, sessionId,
  // focus, claimedAt }. Last-writer-claim, release clears the lane. Used when
  // NOT in sync mode — byte-identical to the original reducer.
  const claims = new Map();
  // Team-sync reconciliation (sync mode only): track EVERY active claim per
  // lane keyed by owning session. The winner is re-derived every rebuild as the
  // claim earliest in the k-way-merged total order (first-claimer holds); all
  // later concurrent claims are computed as superseded and surfaced as a
  // read-time `contentions` view, and NOTHING is written to the spine (rule #2).
  // Re-derived from the whole set each rebuild, so a late-arriving earlier claim
  // wins on the next rebuild — monotonic, no frozen "B won" record.
  const laneClaims = new Map();            // lane -> Map<sessionId, { lane, sessionId, focus, claimedAt, _order }>
  let claimSeq = 0;                        // monotonic rank = position in the merged total order
  const sliceStops = [];                   // list of slice-stop events, newest last
  const inbox = [];                        // list of inbox events

  // Approvals projection.
  //   openApprovals : map approvalId -> request (only entries with no decision)
  //   approvalLedger: every APPROVAL_DECIDED, newest last
  //   policies      : key = tool|lane composite key -> { decision, scope, setAt }
  const openApprovals = new Map();
  const approvalLedger = [];
  const policies = new Map();

  // Tasks projection.
  //   tasks         : taskId -> { id, title, description, status, owner, lane,
  //                              blockedBy[], blocks[], tags, metadata,
  //                              createdAt, updatedAt }
  const tasks = new Map();

  // Workers projection.
  //   workers       : workerId -> { id, sessionId, lane, command, pid, startedAt,
  //                                 lastHeartbeat, status, exitCode }
  const workers = new Map();

  // Proposals projection (Slice γ).
  //   proposals     : proposalId -> { id, ts, actor, lane, action, summary, risk,
  //                                   preconditions, status: 'open'|'approved'|'rejected'|'negotiating',
  //                                   decidedAt, decidedBy, reason }
  const proposals = new Map();

  // BOSS transcript fragments (Slice γ) — keyed by sessionId, append-only.
  const bossTranscripts = new Map();

  // Governance Phase 1: goal + phase declarations (latest wins).
  let goal = null;
  let phase = null;
  // Earned autonomy (v1.92.0) — latest recommendation + score digest (latest
  // wins; recommend-only, so this is display state, never behavior).
  let autonomy = null;
  // v1.6.0 — curated cross-session handoff (latest HANDOFF_SET wins).
  let handoff = null;
  // Focus Director — the pilot's attention trail vs the declared goal. Rebuilt
  // from FOCUS_TAGGED (per-turn tag) + DRIFT_FLAGGED (sustained-drift flag).
  let focus = { lastTag: null, window: [], openFlag: null, updatedAt: null };
  const FOCUS_WINDOW_CAP = 12;

  // Governance Phase 2: gate runs + tracked-source hashes.
  const gateRuns = [];                        // capped 200
  const gateSummary = { ok: 0, fail: 0, warn: 0 };
  let gatesLastRunAt = null;
  const sourceHashPaths = {};                 // path -> { hash, recordedAt }
  let sourceHashesLastRecomputedAt = null;
  let sourceHashesLastReason = null;          // why the last re-pin happened

  // Governance Phase 3: slice scope-locks (opt-in).
  // Map sliceId → { scope, lockedScopeHash, expansionBound, expansions[], functionalApproved, declaredAt }
  const sliceLocks = {};

  // Governance Phase 4: trigger discipline + pending-actions queue.
  const triggers = {};                          // triggerId -> { lastFiredAt, cooldownMs }
  const pendingActionsMap = new Map();          // actionId -> { ..., drained, outcome }

  // Governance Phase 5: reviews + open follow-ups.
  const reviewsByVerdict = { CLEAN: 0, P1: 0, P2: 0, P3: 0, INFO: 0 };
  const reviewsRecent = [];                     // capped 200
  const openFollowups = [];                     // FOLLOWUP_OPENED chain

  // v0.18 Phase 4: teams, pipelines, advisors, token ledger.
  //   teams       : Map teamId -> { id, openedAt, parentSessionId, lanes[], members[], status, closedAt }
  //   pipelines   : Map pipelineRunId -> { id, name, goal, startedAt, stages[], status, completedAt }
  //   advisors    : Array of { id, ts, runtime, prompt, parentSessionId, artifactPath }
  //   tokenLedger : Array of { ts, runtime, sessionId, model, inputTokens, outputTokens, cacheRead, cacheCreation }
  //                 Entries without input/output token counts are kept as
  //                 "minimum-schema" rows; `maddu cost --unreported-count`
  //                 surfaces the gap honestly instead of zeroing it.
  const teams = new Map();
  const pipelines = new Map();
  const advisors = [];
  const tokenLedger = [];

  // v0.19 Phase 3 — skill auto-injection ledger.
  //   skillInjections: [{ ts, sessionId, skillIds[], triggers[], tags[], totalBytes }]
  const skillInjections = [];
  // Oversight surface — skill-injection refusals (the URL-swap payoff made visible).
  //   skillRefusals: [{ ts, sessionId, reason, refused[{ id, provenance, reason }] }]
  // Raw payload only — no derived strings, no wall-clock math. The bridge/CLI map
  // each refused[].reason to plain copy and compute "how long ago" at display time.
  const skillRefusals = [];

  let lastEventId = null;

  for (const ev of events) {
    lastEventId = ev.id;
    switch (ev.type) {
      case 'SESSION_REGISTERED':
        sessions.set(ev.actor, {
          id: ev.actor,
          role: ev.data.role || null,
          label: ev.data.label || null,
          focus: ev.data.focus || null,
          registeredAt: ev.ts,
          lastHeartbeatAt: ev.ts,
          closedAt: null,
          status: 'active'
        });
        // v0.17 sessionsTree — `manual` source unless overridden.
        // SESSION_REGISTERED may carry parentSessionId after Phase 2;
        // older events without it remain valid (null parent).
        sessionsTree.set(ev.actor, {
          parentSessionId: ev.data.parentSessionId || null,
          source: ev.data.source || 'manual',
          state: 'active',
          lastHeartbeatAt: ev.ts
        });
        break;
      case 'SESSION_AUTO_REGISTERED':
        // v0.17 — agent-native bootstrap. Same session lifecycle as
        // SESSION_REGISTERED; the only extra is event.data.source which
        // the cockpit can use to disambiguate 'cli' / 'spawn' /
        // 'agent-bootstrap' registrations. Tree provenance (parent
        // links) gets a dedicated sessionsTree slot in Phase 2.
        sessions.set(ev.actor, {
          id: ev.actor,
          role: ev.data.role || null,
          label: ev.data.label || null,
          focus: ev.data.focus || ev.data.label || null,
          registeredAt: ev.ts,
          lastHeartbeatAt: ev.ts,
          closedAt: null,
          status: 'active',
          source: ev.data.source || 'cli'
        });
        sessionsTree.set(ev.actor, {
          parentSessionId: ev.data.parentSessionId || null,
          source: ev.data.source || 'cli',
          state: 'active',
          lastHeartbeatAt: ev.ts
        });
        break;
      case 'SESSION_HEARTBEAT': {
        const s = sessions.get(ev.actor);
        if (s) {
          s.lastHeartbeatAt = ev.ts;
          if (ev.data.focus) s.focus = ev.data.focus;
        }
        const t = sessionsTree.get(ev.actor);
        if (t) t.lastHeartbeatAt = ev.ts;
        break;
      }
      case 'SESSION_CLOSED': {
        const s = sessions.get(ev.actor);
        if (s) {
          s.closedAt = ev.ts;
          s.status = 'closed';
          if (ev.data.handoff) s.handoff = ev.data.handoff;
        }
        const t = sessionsTree.get(ev.actor);
        if (t) t.state = 'closed';
        // Release any claims held by this session (across every lane).
        if (syncMode) {
          for (const [lane, owners] of laneClaims) {
            if (owners.delete(ev.actor) && owners.size === 0) laneClaims.delete(lane);
          }
        } else {
          for (const [lane, c] of claims) {
            if (c.sessionId === ev.actor) claims.delete(lane);
          }
        }
        // Clear from the janitor's stale set — the session is closed
        // by the operator and no longer a janitor concern.
        janitorStaleSet.delete(ev.actor);
        break;
      }
      case 'SESSION_STALE_DETECTED': {
        janitorLastRunAt = ev.ts;
        if (ev.data && ev.data.sessionId) janitorStaleSet.add(ev.data.sessionId);
        const t = sessionsTree.get(ev.data && ev.data.sessionId);
        if (t) t.state = 'stale';
        break;
      }
      case 'SESSION_AUTO_CLOSED': {
        janitorLastRunAt = ev.ts;
        const sid = ev.actor || (ev.data && ev.data.sessionId);
        const s = sessions.get(sid);
        if (s) {
          s.closedAt = ev.ts;
          s.status = 'closed';
          s.closedBy = 'janitor';
        }
        const t = sessionsTree.get(sid);
        if (t) t.state = 'closed';
        janitorStaleSet.delete(sid);
        // Determinism: count events within `hourMs` of the *latest event*
        // we've seen so far, not wall-clock now. Wall-clock would make
        // project() non-idempotent and break the round-trip test.
        // The cockpit can re-window against Date.now() at display time
        // if it wants a sliding hour.
        janitorAutoClosedThisHour += 1;
        // Release any claims held by the auto-closed session (across every lane).
        if (syncMode) {
          for (const [lane, owners] of laneClaims) {
            if (owners.delete(sid) && owners.size === 0) laneClaims.delete(lane);
          }
        } else {
          for (const [lane, c] of claims) {
            if (c.sessionId === sid) claims.delete(lane);
          }
        }
        break;
      }
      case 'LANE_CLAIMED': {
        if (!syncMode) {
          // Pre-#12c default path: last-writer-claim.
          claims.set(ev.lane, {
            lane: ev.lane,
            sessionId: ev.actor,
            focus: ev.data.focus || null,
            claimedAt: ev.ts
          });
          break;
        }
        // Sync mode: track every owner; first-claimer holds.
        let owners = laneClaims.get(ev.lane);
        if (!owners) { owners = new Map(); laneClaims.set(ev.lane, owners); }
        const rank = claimSeq++;
        const prior = owners.get(ev.actor);
        owners.set(ev.actor, {
          lane: ev.lane,
          sessionId: ev.actor,
          focus: ev.data.focus || null,
          claimedAt: ev.ts,
          // A re-claim by the SAME owner updates its data (last-writer-wins
          // within an owner) but KEEPS its original total-order rank, so
          // first-claimer semantics hold and a focus refresh never moves the
          // owner behind a rival.
          _order: prior ? prior._order : rank,
        });
        break;
      }
      case 'LANE_RELEASED': {
        if (!syncMode) {
          // Pre-#12c default path: a release clears the lane unconditionally.
          claims.delete(ev.lane);
          break;
        }
        // Sync mode: drop ONLY the releasing owner's claim, so a co-claimant's
        // (or foreign/bogus) release never evicts a surviving holder.
        const owners = laneClaims.get(ev.lane);
        if (owners) {
          owners.delete(ev.actor);
          if (owners.size === 0) laneClaims.delete(ev.lane);
        }
        break;
      }
      case 'SLICE_STOP':
        sliceStops.push({ id: ev.id, ts: ev.ts, actor: ev.actor, lane: ev.lane, ...ev.data });
        break;
      case 'INBOX_MESSAGE':
        inbox.push({ id: ev.id, ts: ev.ts, actor: ev.actor, lane: ev.lane, ...ev.data });
        break;
      case 'APPROVAL_REQUESTED':
        openApprovals.set(ev.id, {
          approvalId: ev.id,
          ts: ev.ts,
          actor: ev.actor,
          lane: ev.lane,
          tool: ev.data.tool || null,
          action: ev.data.action || null,
          summary: ev.data.summary || null,
          payload: ev.data.payload || null,
          autoDecided: false
        });
        // No projector-side auto-decide. Per-repo + global policy matches
        // are appended as real APPROVAL_DECIDED events by the bridge / CLI
        // before the projection ever runs (see lib/approvals.mjs and the
        // hard-rule-#2 note in docs/06-hard-rules.md). The projector is a
        // pure spine reader; nothing here manufactures ledger entries.
        break;
      case 'APPROVAL_DECIDED': {
        const aid = ev.data.approvalId;
        const open = openApprovals.get(aid);
        openApprovals.delete(aid);
        approvalLedger.push({
          approvalId: aid,
          ts: ev.ts,
          decision: ev.data.decision,
          reason: ev.data.reason || null,
          tool: open ? open.tool : ev.data.tool || null,
          lane: open ? open.lane : ev.data.lane || null,
          actor: ev.actor
        });
        // Persist as policy if the operator chose allow-always or deny-always.
        if (ev.data.decision === 'allow-always' || ev.data.decision === 'deny-always') {
          const tool = open ? open.tool : ev.data.tool;
          const lane = open ? open.lane : ev.data.lane;
          const key = policyKeyFor(tool, lane);
          policies.set(key, {
            tool, lane,
            decision: ev.data.decision === 'allow-always' ? 'allow-always' : 'deny',
            setAt: ev.ts,
            setBy: ev.actor
          });
        }
        break;
      }
      case 'APPROVAL_POLICY_SET': {
        const { tool, lane, decision } = ev.data;
        const key = policyKeyFor(tool, lane);
        if (decision === 'clear') policies.delete(key);
        else policies.set(key, { tool, lane, decision, setAt: ev.ts, setBy: ev.actor });
        break;
      }
      case 'TASK_CREATED':
        tasks.set(ev.data.id, {
          id: ev.data.id,
          title: ev.data.title || '',
          description: ev.data.description || '',
          status: ev.data.status || 'todo',
          owner: ev.data.owner || null,
          lane: ev.lane || ev.data.lane || null,
          blockedBy: Array.isArray(ev.data.blockedBy) ? [...ev.data.blockedBy] : [],
          blocks: [],
          tags: Array.isArray(ev.data.tags) ? [...ev.data.tags] : [],
          metadata: ev.data.metadata || {},
          createdAt: ev.ts,
          updatedAt: ev.ts,
          createdBy: ev.actor || null
        });
        break;
      case 'TASK_UPDATED': {
        const t = tasks.get(ev.data.id);
        if (!t) break;
        if (ev.data.title !== undefined) t.title = ev.data.title;
        if (ev.data.description !== undefined) t.description = ev.data.description;
        if (ev.data.status !== undefined) t.status = ev.data.status;
        if (ev.data.owner !== undefined) t.owner = ev.data.owner;
        if (ev.data.lane !== undefined) t.lane = ev.data.lane;
        if (ev.data.tags !== undefined) t.tags = Array.isArray(ev.data.tags) ? [...ev.data.tags] : t.tags;
        if (ev.data.metadata !== undefined) t.metadata = { ...t.metadata, ...ev.data.metadata };
        if (ev.data.blockedBy !== undefined) t.blockedBy = Array.isArray(ev.data.blockedBy) ? [...ev.data.blockedBy] : t.blockedBy;
        if (Array.isArray(ev.data.addBlockers)) {
          for (const b of ev.data.addBlockers) if (!t.blockedBy.includes(b)) t.blockedBy.push(b);
        }
        if (Array.isArray(ev.data.removeBlockers)) {
          t.blockedBy = t.blockedBy.filter((b) => !ev.data.removeBlockers.includes(b));
        }
        t.updatedAt = ev.ts;
        break;
      }
      case 'TASK_COMPLETED': {
        const t = tasks.get(ev.data.id);
        if (!t) break;
        t.status = 'done';
        t.updatedAt = ev.ts;
        t.completedAt = ev.ts;
        t.completedBy = ev.actor || null;
        break;
      }
      case 'WORKER_SPAWNED':
        workers.set(ev.data.id, {
          id: ev.data.id,
          sessionId: ev.actor || ev.data.sessionId || null,
          lane: ev.lane || null,
          command: ev.data.command || null,
          args: ev.data.args || [],
          pid: ev.data.pid || null,
          startedAt: ev.ts,
          lastHeartbeat: ev.ts,
          status: 'running',
          exitCode: null,
          exitedAt: null
        });
        break;
      case 'WORKER_HEARTBEAT': {
        const w = workers.get(ev.data.id);
        if (w && w.status === 'running') {
          w.lastHeartbeat = ev.ts;
          if (ev.data.focus) w.focus = ev.data.focus;
        }
        break;
      }
      case 'WORKER_EXITED': {
        const w = workers.get(ev.data.id);
        if (!w) break;
        w.status = 'exited';
        w.exitedAt = ev.ts;
        w.exitCode = ev.data.exitCode ?? null;
        break;
      }
      case 'WORKER_KILLED': {
        const w = workers.get(ev.data.id);
        if (!w) break;
        w.status = 'killed';
        w.exitedAt = ev.ts;
        w.killedBy = ev.actor || null;
        break;
      }
      case 'PROPOSAL_CREATED': {
        const id = ev.data.id || ev.id;
        proposals.set(id, {
          id,
          ts: ev.ts,
          bossSessionId: ev.data.bossSessionId || null,
          actor: ev.actor || null,
          lane: ev.lane || ev.data.lane || null,
          action: ev.data.action || null,
          summary: ev.data.summary || null,
          risk: ev.data.risk || 'medium',
          preconditions: Array.isArray(ev.data.preconditions) ? ev.data.preconditions : [],
          status: 'open',
          decidedAt: null,
          decidedBy: null,
          reason: null,
          enforcer: ev.data.enforcer || null
        });
        break;
      }
      case 'PROPOSAL_DECIDED': {
        const p = proposals.get(ev.data.id);
        if (!p) break;
        p.status = ev.data.decision || 'rejected';
        p.decidedAt = ev.ts;
        p.decidedBy = ev.actor || null;
        p.reason = ev.data.reason || null;
        break;
      }
      case 'GATE_RAN': {
        const ok = !!ev.data?.ok;
        const severity = ev.data?.severity || 'warn';
        // Prefer the persisted `status` (v1.79.0+); older events lack it, so
        // fall back to the ok/severity mapping (!ok && severity!=warn → fail).
        const status = ev.data?.status || (ok ? 'ok' : (severity === 'warn' ? 'warn' : 'fail'));
        if (status === 'ok') gateSummary.ok++;
        else if (status === 'warn') gateSummary.warn++;
        else gateSummary.fail++;
        gateRuns.push({
          gateId: ev.data?.gateId || null,
          ok,
          status,
          severity,
          durationMs: ev.data?.durationMs ?? null,
          evidence: ev.data?.evidence ?? null,
          ts: ev.ts,
          eventId: ev.id || null,
        });
        if (gateRuns.length > 200) gateRuns.splice(0, gateRuns.length - 200);
        gatesLastRunAt = ev.ts;
        break;
      }
      case 'SLICE_SCOPE_DECLARED': {
        const sid = ev.data?.sliceId;
        if (sid) {
          sliceLocks[sid] = {
            sliceId: sid,
            scope: Array.isArray(ev.data.scope) ? [...ev.data.scope] : [],
            lockedScopeHash: ev.data.lockedScopeHash || null,
            expansionBound: ev.data.expansionBound || { maxFiles: 5, maxGrowthPct: 30 },
            expansions: [],
            functionalApproved: false,
            declaredAt: ev.ts,
            functionallyApprovedAt: null,
          };
        }
        break;
      }
      case 'SLICE_SCOPE_EXPANDED': {
        const sid = ev.data?.sliceId;
        const lock = sid ? sliceLocks[sid] : null;
        if (lock) {
          const added = Array.isArray(ev.data.addedPaths) ? ev.data.addedPaths : [];
          lock.expansions.push({
            addedPaths: added,
            newHash: ev.data.newHash || null,
            reason: ev.data.reason || null,
            ts: ev.ts,
          });
          lock.scope = [...lock.scope, ...added];
          if (ev.data.newHash) lock.lockedScopeHash = ev.data.newHash;
        }
        break;
      }
      case 'SLICE_FUNCTIONAL_APPROVED': {
        const sid = ev.data?.sliceId;
        const lock = sid ? sliceLocks[sid] : null;
        if (lock) {
          lock.functionalApproved = true;
          lock.functionallyApprovedAt = ev.ts;
        }
        break;
      }
      case 'SLICE_REVIEWED': {
        const verdict = ev.data?.verdict || 'INFO';
        if (verdict in reviewsByVerdict) reviewsByVerdict[verdict]++;
        else reviewsByVerdict[verdict] = (reviewsByVerdict[verdict] || 0) + 1;
        reviewsRecent.push({
          eventId: ev.id,
          sliceEventId: ev.data?.sliceEventId || null,
          verdict,
          findingsCount: ev.data?.findingsCount ?? 0,
          reviewerRuntime: ev.data?.reviewerRuntime || null,
          reviewPath: ev.data?.reviewPath || null,
          ts: ev.ts,
        });
        if (reviewsRecent.length > 200) reviewsRecent.splice(0, reviewsRecent.length - 200);
        break;
      }
      case 'FOLLOWUP_OPENED': {
        openFollowups.push({
          eventId: ev.id,
          fromReviewEventId: ev.data?.fromReviewEventId || null,
          severity: ev.data?.severity || 'P3',
          draftScope: Array.isArray(ev.data?.draftScope) ? ev.data.draftScope : [],
          ts: ev.ts,
        });
        break;
      }
      case 'TRIGGER_FIRED': {
        const tid = ev.data?.triggerId;
        if (tid) {
          triggers[tid] = {
            lastFiredAt: ev.ts,
            cooldownMs: ev.data?.cooldownMs ?? 0,
            target: ev.data?.target || null,
          };
        }
        break;
      }
      case 'PENDING_ACTION_ENQUEUED': {
        const aid = ev.data?.actionId;
        if (aid) {
          pendingActionsMap.set(aid, {
            actionId: aid,
            kind: ev.data?.kind || null,
            payload: ev.data?.payload ?? null,
            enqueuedAt: ev.ts,
            drained: false,
            outcome: null,
          });
        }
        break;
      }
      case 'PENDING_ACTION_DRAINED': {
        const aid = ev.data?.actionId;
        const a = aid ? pendingActionsMap.get(aid) : null;
        if (a) {
          a.drained = true;
          a.outcome = ev.data?.outcome || 'ok';
          a.detail = ev.data?.detail || null;
          a.drainedAt = ev.ts;
        }
        break;
      }
      case 'SOURCE_HASH_RECOMPUTED': {
        // FULL REPLACEMENT, not a merge. A rebuild snapshots the ENTIRE declared
        // pin set, so the newest event is the whole truth. Merging (the pre-fix
        // behaviour) meant a path dropped from the config kept its hash forever
        // and silently resurrected its stale baseline if it was ever re-added —
        // and it hid the `removed` drift class entirely, since a deleted pinned
        // file still had a recorded entry.
        for (const k of Object.keys(sourceHashPaths)) delete sourceHashPaths[k];
        const paths = Array.isArray(ev.data?.paths) ? ev.data.paths : [];
        for (const p of paths) {
          if (p?.path && p?.hash) sourceHashPaths[p.path] = { hash: p.hash, recordedAt: ev.ts };
        }
        sourceHashesLastRecomputedAt = ev.ts;
        sourceHashesLastReason = ev.data?.reason ?? null;
        break;
      }
      case 'GOAL_DECLARED':
        goal = {
          objective: ev.data.objective || '',
          constraints: Array.isArray(ev.data.constraints) ? ev.data.constraints : [],
          // v1.6.0 — measurable success conditions [{ text, verify }]. Older
          // GOAL_DECLARED events without it project to [] (forward-compat).
          success: Array.isArray(ev.data.success) ? ev.data.success : [],
          setAt: ev.ts,
          // Goal lifecycle: a freshly declared goal is active until GOAL_COMPLETED.
          status: 'active',
          completedAt: null,
          completionNote: null,
        };
        break;
      case 'GOAL_COMPLETED':
        // Close the current goal's lifecycle (latest-declared goal wins, same as
        // GOAL_DECLARED). A completed goal stays visible (with its outcome) so
        // `goal show` / orient can prompt for a fresh one instead of silently
        // re-surfacing a finished objective as "the goal".
        if (goal && goal.status === 'active') {
          goal.status = ev.data.outcome === 'abandoned' ? 'abandoned' : 'completed';
          goal.completedAt = ev.ts;
          goal.completionNote = ev.data.note || null;
        }
        break;
      case 'HANDOFF_SET':
        handoff = { body: ev.data.body || '', by: ev.data.by || ev.actor || null, setAt: ev.ts };
        break;
      case 'FOCUS_TAGGED': {
        const tag = ev.data?.tag || null;
        focus.lastTag = tag;
        focus.window.push({
          tag,
          distanceScore: typeof ev.data?.distanceScore === 'number' ? ev.data.distanceScore : null,
          ts: ev.ts,
        });
        if (focus.window.length > FOCUS_WINDOW_CAP) focus.window = focus.window.slice(-FOCUS_WINDOW_CAP);
        focus.updatedAt = ev.ts;
        break;
      }
      case 'DRIFT_FLAGGED':
        // Latest wins; an explicit `cleared:true` (operator answered the menu)
        // resolves the open flag back to null.
        focus.openFlag = ev.data?.cleared
          ? null
          : {
              reason: ev.data?.reason || '',
              runs: typeof ev.data?.runs === 'number' ? ev.data.runs : null,
              menu: Array.isArray(ev.data?.menu) ? ev.data.menu : ['swap', 'revert', 'continue'],
              workerId: ev.data?.workerId || null,
              at: ev.ts,
            };
        focus.updatedAt = ev.ts;
        break;
      case 'PHASE_DECLARED':
        phase = {
          name: ev.data.name || '',
          notes: ev.data.notes || null,
          tier: ev.data.tier || null,
          setAt: ev.ts
        };
        break;
      case 'PHASE_CLEARED':
        phase = null;
        break;
      case 'AUTONOMY_RECOMMENDATION':
        autonomy = {
          lane: ev.data?.lane || null,
          fromRung: ev.data?.fromRung || null,
          toRung: ev.data?.toRung || null,
          recommendation: ev.data?.recommendation || null,
          muted: !!ev.data?.muted,
          mutedReason: ev.data?.mutedReason || null,
          wilson: typeof ev.data?.wilson === 'number' ? ev.data.wilson : null,
          n: typeof ev.data?.n === 'number' ? ev.data.n : null,
          at: ev.ts,
        };
        break;
      case 'BOSS_MESSAGE': {
        const sid = ev.data.bossSessionId || 'default';
        if (!bossTranscripts.has(sid)) bossTranscripts.set(sid, []);
        bossTranscripts.get(sid).push({
          id: ev.id,
          ts: ev.ts,
          actor: ev.actor || null,
          role: ev.data.role || 'operator',
          text: ev.data.text || '',
          proposalId: ev.data.proposalId || null,
          reasonCode: ev.data.reasonCode || null,
          citedRule: ev.data.citedRule || null
        });
        break;
      }
      // v0.18 Phase 4 — teams.
      case 'TEAM_OPENED': {
        const id = ev.data.teamId || ev.id;
        teams.set(id, {
          id,
          openedAt: ev.ts,
          parentSessionId: ev.data.parentSessionId || ev.actor || null,
          lanes: Array.isArray(ev.data.lanes) ? ev.data.lanes.slice() : [],
          members: [],
          status: 'open',
          closedAt: null,
        });
        break;
      }
      case 'TEAM_LANE_ALLOCATED': {
        const t = teams.get(ev.data.teamId);
        if (t && ev.data.lane && !t.lanes.includes(ev.data.lane)) {
          t.lanes.push(ev.data.lane);
        }
        break;
      }
      case 'TEAM_MEMBER_JOINED': {
        const t = teams.get(ev.data.teamId);
        if (t) {
          t.members.push({
            sessionId: ev.data.sessionId || ev.actor,
            lane: ev.data.lane || null,
            joinedAt: ev.ts,
            leftAt: null,
          });
        }
        break;
      }
      case 'TEAM_MEMBER_LEFT': {
        const t = teams.get(ev.data.teamId);
        if (t) {
          const m = t.members.find((x) => x.sessionId === (ev.data.sessionId || ev.actor) && !x.leftAt);
          if (m) m.leftAt = ev.ts;
        }
        break;
      }
      case 'TEAM_CLOSED': {
        const t = teams.get(ev.data.teamId);
        if (t) {
          t.status = 'closed';
          t.closedAt = ev.ts;
        }
        break;
      }
      // v0.18 Phase 4 — pipelines.
      case 'PIPELINE_STARTED': {
        const id = ev.data.pipelineRunId || ev.id;
        pipelines.set(id, {
          id,
          name: ev.data.name || null,
          goal: ev.data.goal || null,
          startedAt: ev.ts,
          stages: [],
          status: 'running',
          completedAt: null,
        });
        break;
      }
      case 'PIPELINE_STAGE_ENTERED': {
        const p = pipelines.get(ev.data.pipelineRunId);
        if (p) {
          p.stages.push({
            name: ev.data.stage || 'unnamed',
            enteredAt: ev.ts,
            exitedAt: null,
            status: 'running',
          });
        }
        break;
      }
      case 'PIPELINE_STAGE_EXITED': {
        const p = pipelines.get(ev.data.pipelineRunId);
        if (p) {
          const s = p.stages.find((x) => x.name === ev.data.stage && !x.exitedAt);
          if (s) {
            s.exitedAt = ev.ts;
            s.status = ev.data.status || 'ok';
          }
        }
        break;
      }
      case 'PIPELINE_COMPLETED': {
        const p = pipelines.get(ev.data.pipelineRunId);
        if (p) {
          p.status = 'completed';
          p.completedAt = ev.ts;
        }
        break;
      }
      case 'PIPELINE_HALTED': {
        const p = pipelines.get(ev.data.pipelineRunId);
        if (p) {
          p.status = 'halted';
          p.completedAt = ev.ts;
          p.haltReason = ev.data.reason || null;
        }
        break;
      }
      // v0.18 Phase 4 — advisors (non-claiming).
      case 'ADVISOR_INVOKED': {
        advisors.push({
          id: ev.data.advisorId || ev.id,
          ts: ev.ts,
          runtime: ev.data.runtime || null,
          prompt: ev.data.prompt || '',
          parentSessionId: ev.data.parentSessionId || ev.actor || null,
          artifactPath: null,
        });
        break;
      }
      case 'ADVISOR_ARTIFACT_WRITTEN': {
        const a = advisors.find((x) => x.id === ev.data.advisorId);
        if (a) a.artifactPath = ev.data.artifactPath || null;
        break;
      }
      // v0.18 Phase 4 — token ledger.
      // v0.19 Phase 3 — skill auto-injection event.
      case 'SKILL_INJECTED': {
        skillInjections.push({
          ts: ev.ts,
          sessionId: ev.data?.sessionId || ev.actor || null,
          skillIds: Array.isArray(ev.data?.skillIds) ? ev.data.skillIds.slice() : [],
          triggers: Array.isArray(ev.data?.triggers) ? ev.data.triggers.slice() : [],
          tags: Array.isArray(ev.data?.tags) ? ev.data.tags.slice() : [],
          totalBytes: typeof ev.data?.totalBytes === 'number' ? ev.data.totalBytes : 0,
        });
        break;
      }
      // Oversight surface — a skill was withheld at inject-time (untrusted
      // provenance or unacknowledged external refs). Kept raw; the display
      // layer maps each refused[].reason to plain language.
      case 'SKILL_INJECTION_REFUSED': {
        skillRefusals.push({
          ts: ev.ts,
          sessionId: ev.data?.sessionId || ev.actor || null,
          reason: typeof ev.data?.reason === 'string' ? ev.data.reason : '',
          refused: Array.isArray(ev.data?.refused)
            ? ev.data.refused.map((r) => ({
                id: r?.id || null,
                provenance: r?.provenance || null,
                reason: r?.reason || null,
              }))
            : [],
        });
        break;
      }
      case 'TOKEN_USAGE_REPORTED': {
        // Minimum schema: { runtime, sessionId, model, ts }. Optional:
        // inputTokens, outputTokens, cacheRead, cacheCreation. We keep
        // rows verbatim; `maddu cost` does the rollup + unreported count.
        tokenLedger.push({
          ts: ev.ts,
          runtime: ev.data.runtime || null,
          sessionId: ev.data.sessionId || ev.actor || null,
          model: ev.data.model || null,
          inputTokens: typeof ev.data.inputTokens === 'number' ? ev.data.inputTokens : null,
          outputTokens: typeof ev.data.outputTokens === 'number' ? ev.data.outputTokens : null,
          cacheRead: typeof ev.data.cacheRead === 'number' ? ev.data.cacheRead : null,
          cacheCreation: typeof ev.data.cacheCreation === 'number' ? ev.data.cacheCreation : null,
        });
        break;
      }
    }
  }

  // Build reverse blocks[] map and auto-unblock tasks whose blockers are all done.
  if (tasks.size > 0) {
    // Reset blocks arrays first (since we rebuild from scratch each projection).
    for (const t of tasks.values()) t.blocks = [];
    for (const t of tasks.values()) {
      for (const b of t.blockedBy) {
        const blocker = tasks.get(b);
        if (blocker && !blocker.blocks.includes(t.id)) blocker.blocks.push(t.id);
      }
    }
    // checkUnblocks: if every blocker of a task is "done", strip those blocker
    // ids from the runtime view of blockedBy and flip "blocked" → "todo".
    for (const t of tasks.values()) {
      const activeBlockers = t.blockedBy.filter((b) => {
        const blocker = tasks.get(b);
        return !blocker || blocker.status !== 'done';
      });
      t.activeBlockers = activeBlockers;
      if (t.status === 'blocked' && activeBlockers.length === 0) {
        t.status = 'todo';
      }
    }
  }

  // Roadmap #12c phase 4 — resolve the lane-claim state into the emitted holder
  // list (+ a read-time contention view in sync mode). On the default path this
  // is just the pre-#12c `claims` map values, byte-identical, contentions [].
  // In sync mode each lane's active claim set collapses to one deterministic
  // holder = the claim earliest in the total order (lowest rank; a rank tie
  // breaks on sessionId so every replica converges on the same holder). Zero
  // spine writes — pure projection, re-derived every rebuild.
  let claimsOut;
  const contentions = [];
  if (!syncMode) {
    claimsOut = Array.from(claims.values());
  } else {
    claimsOut = [];
    for (const [lane, owners] of laneClaims) {
      const active = Array.from(owners.values()).sort(
        (a, b) => a._order - b._order || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
      );
      const winner = active[0];
      claimsOut.push({ lane: winner.lane, sessionId: winner.sessionId, focus: winner.focus, claimedAt: winner.claimedAt });
      if (active.length > 1) {
        contentions.push({
          lane,
          holder: { sessionId: winner.sessionId, focus: winner.focus, claimedAt: winner.claimedAt },
          superseded: active.slice(1).map((c) => ({ sessionId: c.sessionId, focus: c.focus, claimedAt: c.claimedAt })),
        });
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    lastEventId,
    eventCount: events.length,
    sessions: Array.from(sessions.values()),
    activeSessions: Array.from(sessions.values()).filter((s) => s.status === 'active'),
    claims: claimsOut,
    // Roadmap #12c phase 4 — lanes with >1 live claimant (team-sync only;
    // always [] on the single-machine path). Read-time only; no spine write.
    contentions,
    sliceStops: sliceStops.slice(-50),         // most recent 50
    inbox: inbox.slice(-200),                  // most recent 200
    approvals: {
      open: Array.from(openApprovals.values()),
      ledger: approvalLedger.slice(-100),
      policies: Array.from(policies.values())
    },
    tasks: Array.from(tasks.values()),
    workers: Array.from(workers.values()).map((w) => annotateWorker(w)),
    proposals: Array.from(proposals.values()),
    bossTranscripts: Object.fromEntries(bossTranscripts),
    // Governance Phase 1: latest declared goal + phase (null if never set).
    goal,
    // v1.6.0 — latest curated handoff (null if never set).
    handoff,
    phase,
    // Earned autonomy — latest recommendation (null until a rung ever changes).
    autonomy,
    // Focus Director — pilot trajectory trail (last tag, rolling window, open flag).
    focus,
    // Governance Phase 2: gate runs + tracked-source hashes.
    gates: {
      lastRunAt: gatesLastRunAt,
      runs: gateRuns.slice(),
      summary: { ...gateSummary },
    },
    sourceHashes: {
      paths: { ...sourceHashPaths },
      lastRecomputedAt: sourceHashesLastRecomputedAt,
      lastReason: sourceHashesLastReason,
    },
    // Governance Phase 3: slice scope-locks (opt-in).
    sliceLocks: { ...sliceLocks },
    // Governance Phase 4: trigger discipline + pending-actions queue.
    triggers: { ...triggers },
    pendingActions: Array.from(pendingActionsMap.values()),
    // Governance Phase 5: post-stop reviews + open follow-ups.
    reviews: {
      byVerdict: { ...reviewsByVerdict },
      recent: reviewsRecent.slice(),
    },
    openFollowups: openFollowups.slice(),
    // v0.17 Phase 2: session-tree provenance (parent → child links).
    // Each entry is keyed by sessionId; childSessionIds is the reverse
    // index built once after replay (state may flip to 'stale' via Phase 5).
    sessionsTree: buildSessionsTreeView(sessionsTree),
    // v0.17 Phase 5: stale-session janitor view. Deterministic — the
    // counter is total auto-closes seen on the spine (cockpit can
    // re-window against wall-clock at display time).
    janitor: {
      lastRunAt: janitorLastRunAt,
      staleSessions: Array.from(janitorStaleSet).sort(),
      autoClosedTotal: janitorAutoClosedThisHour,
    },
    // v0.18 Phase 4 — backbone projections.
    teams: Array.from(teams.values()),
    pipelines: Array.from(pipelines.values()),
    advisors: advisors.slice(),
    tokenLedger: tokenLedger.slice(),
    // v0.19 Phase 3 — skill auto-injection ledger (cap 200 most recent).
    skillInjections: skillInjections.slice(-200),
    // Oversight surface — skill-injection refusals (cap 200 most recent).
    skillRefusals: skillRefusals.slice(-200),
  };
}

function buildSessionsTreeView(sessionsTree) {
  // Reverse-index children. The forward replay records parentSessionId
  // on the child; the view exposes both directions so `maddu session
  // tree` can walk either way without re-scanning.
  const out = {};
  for (const [id, node] of sessionsTree) {
    out[id] = {
      parentSessionId: node.parentSessionId,
      childSessionIds: [],
      source: node.source,
      state: node.state,
      lastHeartbeatAt: node.lastHeartbeatAt
    };
  }
  for (const [id, node] of sessionsTree) {
    if (node.parentSessionId && out[node.parentSessionId]) {
      out[node.parentSessionId].childSessionIds.push(id);
    }
  }
  for (const id of Object.keys(out)) out[id].childSessionIds.sort();
  return out;
}

// Read-time status derivation: a worker that hasn't heartbeat'd in
// STUCK_THRESHOLD_MS while still nominally "running" is reported as "stuck".
function annotateWorker(w) {
  if (w.status !== 'running') return w;
  const last = new Date(w.lastHeartbeat || w.startedAt).getTime();
  const ageMs = Date.now() - last;
  if (ageMs > STUCK_THRESHOLD_MS) {
    return { ...w, status: 'stuck', ageMs };
  }
  return { ...w, ageMs };
}

function policyKeyFor(tool, lane) {
  return `${tool || '*'}@${lane || '*'}`;
}

// ── Compat reader (roadmap #13) — read an OLD install's state safely ─────────
// `maddu fleet upgrade` now delivers new code into installs as old as v1.15. New
// code that reads a projection persisted (or rebuilt) by old code can crash on a
// key the old shape never had — a silent, field-by-field surprise. The fix: one
// versioned reader that default-fills every top-level (and known nested) key, so
// reading old state is total. `can-read-old-state` gate enforces it stays total.

// A fresh, fully-defaulted projection — every key project() returns, empty.
// A factory (not a shared const) so callers can mutate the result freely.
export function projectionDefaults() {
  return {
    schemaVersion: 0, // 0 = legacy/unstamped until normalized
    lastEventId: null,
    eventCount: 0,
    sessions: [], activeSessions: [], claims: [], contentions: [], sliceStops: [], inbox: [],
    approvals: { open: [], ledger: [], policies: [] },
    tasks: [], workers: [], proposals: [], bossTranscripts: {},
    goal: null, handoff: null, phase: null, autonomy: null, focus: null,
    gates: { lastRunAt: null, runs: [], summary: { ok: 0, warn: 0, fail: 0 } },
    sourceHashes: { paths: {}, lastRecomputedAt: null, lastReason: null },
    sliceLocks: {}, triggers: {}, pendingActions: [],
    reviews: { byVerdict: {}, recent: [] },
    openFollowups: [], sessionsTree: {},
    janitor: { lastRunAt: null, staleSessions: [], autoClosedTotal: 0 },
    teams: [], pipelines: [], advisors: [], tokenLedger: [], skillInjections: [],
    skillRefusals: [],
  };
}

// A projection is legacy if it predates the schema stamp (no numeric
// schemaVersion) or carries an older one than the code now expects.
export function isLegacyProjection(raw) {
  const v = raw && typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  return v < SCHEMA_VERSION;
}

// Read any projection (current, legacy, partial, or garbage) into a TOTAL
// current-shape object: every top-level key present, the known nested objects
// (approvals/gates/sourceHashes/reviews/janitor) deep-defaulted so e.g.
// `normalizeProjection(old).gates.runs` is always an array. Records the source
// version under `sourceSchemaVersion` and stamps the output at SCHEMA_VERSION.
export function normalizeProjection(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const d = projectionDefaults();
  const out = { ...d, ...r };
  out.approvals = { ...d.approvals, ...(r.approvals && typeof r.approvals === 'object' ? r.approvals : {}) };
  out.gates = { ...d.gates, ...(r.gates && typeof r.gates === 'object' ? r.gates : {}) };
  out.gates.summary = { ...d.gates.summary, ...(r.gates && r.gates.summary && typeof r.gates.summary === 'object' ? r.gates.summary : {}) };
  out.sourceHashes = { ...d.sourceHashes, ...(r.sourceHashes && typeof r.sourceHashes === 'object' ? r.sourceHashes : {}) };
  out.reviews = { ...d.reviews, ...(r.reviews && typeof r.reviews === 'object' ? r.reviews : {}) };
  out.janitor = { ...d.janitor, ...(r.janitor && typeof r.janitor === 'object' ? r.janitor : {}) };
  out.sourceSchemaVersion = (typeof r.schemaVersion === 'number') ? r.schemaVersion : 0;
  out.schemaVersion = SCHEMA_VERSION;
  return out;
}
