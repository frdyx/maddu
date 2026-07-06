// experience-export.mjs — EXP phase 5: the governed ATDP export.
//
// Pure builders for `maddu experience export --format atdp` (design §8).
// All I/O lives in commands/experience.mjs; this module is a pure function
// of its inputs so the artifact is DETERMINISTIC given the same spine and
// --since (no clock, no randomness — deliberately NO generation timestamp;
// byte-identical re-export is a feature, provenance rides the event range).
//
// Security posture (design §8, the SYNC posture — chosen deliberately over
// the otel scrub-and-ship precedent because an ATDP file exists to be handed
// to someone else, i.e. a sharing boundary like `spine sync`):
//   • REFUSE-on-hit: a secret-shaped value anywhere in the SELECTED events
//     refuses the whole export and names the offending event ids. No flag to
//     skip it, no partial file. The scan is the exporter's own scoped pass —
//     a redactText changed-output check per selected event (the sync helper
//     scans whole segment files and reports line locations; same canonical
//     patterns, not the same function).
//   • Defense-in-depth: on a clean scan, redactText still runs over every
//     outgoing string leaf (belt and braces, both existing machinery).
//   • trainingEligibility: false by default — the manifest names the
//     redaction profile; the operator owns the judgment regex cannot make
//     (free prose can carry secrets that match no pattern — acknowledged
//     residual, design §8).

import { redactText } from './secret-scan.mjs';
import { EVENT_CONTRACT_VERSION } from './event-schema.mjs';
import { EXPERIENCE_SCHEMA_VERSION } from './experience.mjs';

export const ATDP_FORMAT_VERSION = 1;
export const REDACTION_PROFILE = 'maddu-secret-scan-v1 (refuse-on-hit + redactText defense-in-depth)';

// The exporter's scoped secret gate: one changed-output check per SELECTED
// event, reporting ev.id — never a partial result.
export function scanSelectedEvents(events) {
  const hits = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !ev.id) continue;
    const line = JSON.stringify(ev);
    // redactText returns { text, redactions } — a hit is a CHANGED text (and
    // the redactions counter names the pattern types for the refusal message).
    const r = redactText(line);
    if (r.text !== line) hits.push({ id: ev.id, patternTypes: Object.keys(r.redactions).sort() });
  }
  return hits;
}

// Defense-in-depth: redact every string leaf of an arbitrary JSON value.
// Keys are NEVER redacted (collision would drop fields — provenance loss;
// secrets ride in values — the #220 lesson).
function deepRedact(value) {
  if (typeof value === 'string') return redactText(value).text;
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v);
    return out;
  }
  return value;
}

// Select events strictly AFTER sinceId (exclusive) and up TO untilId
// (inclusive); null bounds mean unbounded on that side. Returns
// { selected, unknown } — unknown names the flag whose id is not on the
// spine (the caller refuses, exit 2 — the export --otel --since discipline).
// --until exists so a PAST export stays reproducible after the spine grows:
// re-run with --until <manifest.range.lastEventId> and the bytes come back.
export function selectRange(events, sinceId = null, untilId = null) {
  let list = events.slice();
  if (sinceId) {
    const idx = list.findIndex((e) => e && e.id === sinceId);
    if (idx === -1) return { selected: null, unknown: 'since' };
    list = list.slice(idx + 1);
  }
  if (untilId) {
    const idx = list.findIndex((e) => e && e.id === untilId);
    if (idx === -1) return { selected: null, unknown: 'until' };
    list = list.slice(0, idx + 1);
  }
  return { selected: list, unknown: null };
}

// Build the ATDP document from PRE-SCANNED (clean) events + the experience
// projection derived from them. `provenance` is caller-supplied (repo label,
// replicaId when in sync mode).
export function buildAtdp({ events, experience, sinceId = null, provenance = {} }) {
  const first = events.find((e) => e && e.id) || null;
  const last = [...events].reverse().find((e) => e && e.id) || null;
  const doc = {
    manifest: {
      format: 'atdp',
      formatVersion: ATDP_FORMAT_VERSION,
      generator: 'maddu experience export',
      eventContractVersion: EVENT_CONTRACT_VERSION,
      experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
      eventCount: events.length,
      // The range is fully described by first/last event ids; the --until
      // request is deliberately NOT recorded here so that after the spine
      // grows, `--until <lastEventId>` reproduces an earlier unbounded
      // export byte-identically (same selection ⇒ same bytes).
      range: {
        sinceExclusive: sinceId,
        firstEventId: first ? first.id : null,
        lastEventId: last ? last.id : null,
        firstTs: first ? first.ts ?? null : null,
        lastTs: last ? last.ts ?? null : null,
      },
      trainingEligibility: false,
      redactionProfile: REDACTION_PROFILE,
      provenance: {
        repo: provenance.repo ?? null,
        replicaId: provenance.replicaId ?? null,
      },
      // Axes absent by design (never inferred) — restated on the artifact so a
      // consumer can't mistake absence for omission (design §2).
      absentByDesign: experience.stats.absentByDesign,
    },
    trajectories: experience.trajectories,
    steps: experience.steps,
    stats: experience.stats,
  };
  // Belt and braces on the whole outgoing document.
  return deepRedact(doc);
}
