// Shared skill external-reference detection — one source of truth for
// "is this skill locally resident?", used by BOTH enforcement points so they
// can never disagree:
//   - the `skill-no-external-refs` doctor gate (audit-time), and
//   - the load-time injection refusal in commands/brief.mjs (inject-time).
//
// Threat: the skill URL-swap attack (cybernews, 2026 — a fake "brand landing
// page" skill hijacked ~26,000 agents). A skill markdown file is CLEAN at
// review, then the content behind an EXTERNAL link its body points at is
// swapped after approval. The file never changes; a dependency it references
// does. The formally-checkable countermeasure: an auto-injectable skill should
// be locally resident. See docs/34-threat-model.md scenario 5.

export function isFrameworkOrigin(provenance) {
  return /^framework-/.test(provenance || '') || provenance === 'pre-v1.2-grandfathered';
}

// Deterministic external-reference detector over a skill BODY. Two high-signal
// classes: explicit http/https URLs (the swap-target pattern) and bare
// remote-fetch commands (curl/wget). Bare hostnames without a scheme are NOT
// matched (too false-positive-prone; the attack needs a fetchable target).
//
// Query strings and fragments are STRIPPED from the returned refs: the evidence
// only needs to show THAT an off-box reference exists, not carry a
// secret-bearing `?token=…` toward the spine. This is defense-in-depth —
// spine.append still redacts known secret patterns centrally — so we never even
// stage one. Detection still fires on the full match; only the stored ref is
// trimmed.
export function findExternalRefs(body) {
  if (typeof body !== 'string' || !body) return [];
  const refs = new Set();
  let m;
  const urlRe = /\bhttps?:\/\/[^\s)>\]"'`|]+/gi;
  while ((m = urlRe.exec(body))) {
    const raw = m[0].replace(/[.,;:]+$/, '').split(/[?#]/)[0];
    refs.add(raw.slice(0, 120));
  }
  const fetchRe = /\b(?:curl|wget)\b[^\n]{0,80}/gi;
  while ((m = fetchRe.exec(body))) refs.add(m[0].split(/[?#]/)[0].trim().slice(0, 120));
  return Array.from(refs);
}

export function externalRefsAcknowledged(fm) {
  const v = fm?.external_refs;
  return v === 'allowed' || v === 'true' || v === true;
}

// True when a non-framework skill points off-box without an operator
// acknowledgment. Framework-origin skills are origin-trusted (install-integrity
// covers tampering) and are never blocked here. Skills with no provenance are
// owned by `skill-provenance-required`, not this check.
export function skillHasUnacknowledgedExternalRefs({ provenance, fm, body }) {
  if (!provenance || isFrameworkOrigin(provenance)) return false;
  if (externalRefsAcknowledged(fm)) return false;
  return findExternalRefs(body).length > 0;
}
