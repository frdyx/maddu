// Máddu cockpit — prose formatter.
//
// Máddu records structured-but-dense strings: slice-stop summaries
// ("SLICE STOP: … Action: … Targets: … Gates: … Learnings: - … - … Next
// actions: - … Reason: …"), handoff bodies, long objectives. Rendered raw they
// read as a wall of text. This turns them into a scannable structure — a lead
// headline + labeled sections (chips for comma-lists like Gates/Targets/Paths,
// bullets for Learnings/Next, prose for Action/Reason) — with the tail sections
// collapsed behind a "+N more" toggle.
//
// formatProse(text) is PURE (structure only, no DOM) so it unit-tests without a
// browser. renderProse(text, opts) builds the DOM via el().

import { el } from './cockpit-util.js';

// Section labels Máddu emits, in rough emit order. Longer multi-word labels
// MUST precede their prefixes ("Next actions" before "Next") so the matcher
// prefers the longer one.
const SECTION_LABELS = [
  'Action', 'Targets', 'Paths', 'Gates',
  'Learnings', 'Learning', 'Next actions', 'Next steps', 'Next',
  'Reason', 'Follow-ups', 'Followups', 'Blockers', 'Result', 'Verification',
];
const CHIP_LABELS = new Set(['Targets', 'Paths', 'Gates']);
const BULLET_LABELS = new Set(['Learnings', 'Learning', 'Next actions', 'Next steps', 'Next', 'Follow-ups', 'Followups', 'Blockers']);

function escapeRe(s) { return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }

// Split a bullet-ish blob into items. Máddu writes "- a - b - c"; also tolerate
// leading bullets and "•". Splits only on space-delimited hyphens so hyphenated
// words ("URL-swap") don't fracture.
function splitBullets(content) {
  const cleaned = content.replace(/^\s*[-•]\s+/, '');
  const items = cleaned.split(/\s+[-•]\s+/).map((s) => s.trim()).filter(Boolean);
  return items.length ? items : [content];
}

// Break a dense clause-y prose section (Action/Reason) into readable lines so it
// stops reading as a wall. Primary split on semicolons (how Máddu chains
// clauses); a still-long piece splits again on sentence boundaries. One clause
// stays a single line.
function splitClauses(content) {
  const parts = content.split(/\s*;\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length > 140 && /\.\s+\S/.test(p)) {
      out.push(...p.split(/\.\s+(?=[A-Z0-9(])/).map((s) => s.trim()).filter(Boolean));
    } else out.push(p);
  }
  return out.length ? out : [content];
}

// Short display label for a chip item — a bare file basename when the item is a
// path, so Targets/Paths read as compact tags (full value kept for the title).
function chipLabel(it) {
  const s = String(it);
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) || s : s;
}

export function formatProse(text) {
  const raw = String(text == null ? '' : text).replace(/\r/g, '').trim();
  if (!raw) return { lead: '', sections: [], plain: '' };

  const labelAlt = SECTION_LABELS.map(escapeRe).join('|');
  // A label starts a segment when it follows a sentence break, a newline, a
  // double-space (collapsed multiline), or the very start.
  const labelRe = new RegExp(`(?:^|[.;]\\s+|\\n\\s*|\\s{2,})(${labelAlt}):\\s*`, 'g');
  const marks = [];
  let m;
  while ((m = labelRe.exec(raw))) {
    marks.push({ label: m[1], contentStart: m.index + m[0].length, labelStart: m.index + (m[0].length - m[0].trimStart().length) });
  }
  if (!marks.length) {
    // Freeform (handoff body, objective) — no known labels. Keep as one blob;
    // the renderer paragraph-splits it.
    return { lead: '', sections: [], plain: raw };
  }

  let lead = raw.slice(0, marks[0].labelStart).trim();
  lead = lead.replace(/^SLICE\s*STOP:\s*/i, '').replace(/[.;]\s*$/, '').trim();

  const sections = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].labelStart : raw.length;
    const content = raw.slice(marks[i].contentStart, end).trim().replace(/[.;]\s*$/, '').trim();
    if (!content) continue;
    const label = marks[i].label;
    if (BULLET_LABELS.has(label)) sections.push({ label, kind: 'list', items: splitBullets(content) });
    else if (CHIP_LABELS.has(label)) sections.push({ label, kind: 'chips', items: content.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean) });
    else sections.push({ label, kind: 'text', lines: splitClauses(content) });
  }
  return { lead, sections, plain: raw };
}

function renderSectionContent(sec) {
  if (sec.kind === 'chips') {
    return el('span', { class: 'prose-chips' }, sec.items.map((it) => el('span', { class: 'prose-chip', title: String(it) }, chipLabel(it))));
  }
  if (sec.kind === 'list') {
    return el('ul', { class: 'prose-list' }, sec.items.map((it) => el('li', {}, it)));
  }
  // text → one line, or a line-broken clause list when it was a run-on.
  const lines = Array.isArray(sec.lines) ? sec.lines : (sec.text ? [sec.text] : []);
  if (lines.length <= 1) return el('span', { class: 'prose-text' }, lines[0] || '');
  return el('ul', { class: 'prose-list prose-clauses' }, lines.map((l) => el('li', {}, l)));
}

// Build the DOM. opts.collapseAfter (default 2) — sections beyond this fold
// behind a "+N more" toggle.
export function renderProse(text, opts = {}) {
  const collapseAfter = typeof opts.collapseAfter === 'number' ? opts.collapseAfter : 2;
  const p = formatProse(text);
  const root = el('div', { class: 'prose' });

  // Freeform — no labeled structure. Split into paragraphs on blank lines /
  // sentence-y breaks; keep it readable, never a single run-on line.
  if (!p.sections.length) {
    const blob = p.plain || p.lead || '';
    const paras = blob.split(/\n{2,}|\n(?=[-•])/).map((s) => s.trim()).filter(Boolean);
    (paras.length ? paras : [blob]).forEach((para) => root.appendChild(el('div', { class: 'prose-para' }, para)));
    return root;
  }

  if (p.lead) root.appendChild(el('div', { class: 'prose-lead' }, p.lead));
  const wrap = el('div', { class: 'prose-sections' });
  p.sections.forEach((sec, idx) => {
    const row = el('div', { class: idx >= collapseAfter ? 'prose-sec prose-extra' : 'prose-sec' }, [
      el('span', { class: 'prose-key' }, sec.label),
      renderSectionContent(sec),
    ]);
    wrap.appendChild(row);
  });
  root.appendChild(wrap);

  if (p.sections.length > collapseAfter) {
    const extra = p.sections.length - collapseAfter;
    const btn = el('button', { class: 'prose-more', type: 'button' }, `+${extra} more`);
    btn.addEventListener('click', () => {
      const open = root.classList.toggle('prose-open');
      btn.textContent = open ? 'show less' : `+${extra} more`;
    });
    root.appendChild(btn);
  }
  return root;
}
