# Changelog

All notable changes to Máddu. Versions follow the depth-upgrade slice plan
documented in `.claude/plans/so-let-me-revise-lazy-floyd.md` (slices α–ε)
plus the integration slices (ζ–η) and the cockpit polish pass.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/),
adapted to the slice-stop ritual: every release is a `SLICE_STOP` event in
the spine, so the canonical log lives in `.maddu/events/`. This file is the
narrative summary.

---

## [v0.12.0] · 2026-05-17 · depth-upgrade complete

**Programmatic palette destinations + UI alignment.**

- **Sub-target system** (3-layer registry: static manifest → render
  discovery → live data fetch). 10 panels in Settings, every Auth provider,
  every MCP server, every runtime, every active session, every lane, every
  open task, every skill — all palette-searchable by their own name.
- **Action palette entries** — 11 verbs (rebuild wiki, re-extract memory,
  pause stream, open hard rules, jump to each integration test sender,
  open the five-minute tour). Distinct `▷` glyph.
- **Design-system alignment pass** — every scrollbar (8 px, brand-toned
  thumb, electric-blue hover), every `<button>` and `<input>` (unified
  base + `.is-primary/.is-danger/.is-ghost` modifiers, focus rings).
- **Skeleton bones** — `loadingFor(kind, text)` with kpi/grid/table/
  donut/card variants so panels don't reflow on first paint.
- **Inspector fix** — every tab (overview/evidence/actions/related/raw)
  now reads top-level `{ raw, evidence, actions, related, label }` slots,
  fixing a bug where only Raw showed content for newer entities.
- **Outside-click closes Inspector** — pointerdown listener with
  `panel.contains(target)` gate.
- **First-run onboarding** — `docs/18-first-slice.md` plus a cockpit
  banner that surfaces when `counts.sliceStops === 0`.
- **WSL docs** — added Windows-prerequisites notes to installation,
  getting-started, troubleshooting, and validation-checklist.

## [v0.11.0] · 2026-05-16 · cockpit polish

**Six phases of polish applied to the cockpit shell.**

- **Phase 1+2** — grouped rail (Decide / Operate / Verify / Connect /
  Reference), tablet collapse to glyphs + flyout labels, mobile bottom
  dock + bottom sheet.
- **Phase 3** — `Ctrl+K` / `⌘K` command palette with fuzzy search,
  arrow navigation, score-ranked results.
- **Phase 4** — Inspector responsive: persistent ≥ 1440 px, slide-over
  with scrim 1024–1439, bottom sheet < 1024.
- **Phase 5** — unified empty/skeleton/error helpers propagate redesigns
  across all 28 routes from one site.
- **Phase 6** — signature motion: 900 ms lime line traces across the
  viewport top on every SLICE_STOP. Route content fades in 180 ms.
  Global `prefers-reduced-motion` kill switch.

## [v0.10.0] · 2026-05-16 · Discord + Email bridges

**Slice η — outbound-only chat integrations.**

- **Discord** — REST bot bridge, channel allowlist, `allowed_mentions: { parse: [] }`
  prevents `@everyone`. Gateway WebSocket NOT opened (no inbound surface).
- **Email** — SMTP outbound via built-in `node:net` + `node:tls`. TLS
  required (port 465 implicit / 587 STARTTLS). Recipient allowlist
  prevents open-relay abuse. No IMAP.
- Both off by default; refuse to enable until token + allowlist set.
- 230-line minimal SMTP client (EHLO / STARTTLS / AUTH LOGIN / DATA),
  no `nodemailer` dep.

## [v0.9.0] · 2026-05-16 · Telegram bridge

**Slice ζ — first chat integration.**

- Long-poll bot bridge (`getUpdates`, no public webhook).
- Allowlisted chat-ids; inbound from non-allowlisted senders silently
  dropped with content never logged.
- Outbound throttle 1.1 s/chat (under Telegram's 1 msg/s/chat cap).
- Bot token stored device-bound via `auth.mjs`; never returned over HTTP.
- Embedded self-scheduling loop (avoids `setInterval` overlap with the
  25 s long-poll).

## [v0.8.0] · 2026-05-16 · Workflows + Roadmap depth + Agents + Teams

**Slice ε — final depth-upgrade slice.**

- **Workflows** — pure-SVG bezier blueprint of the operator → BOSS →
  Enforcer → claims → fleet → gates → reports → learning → wiki flow.
  Each node opens its route via Inspector.
- **Roadmap** rewritten with KPI strip, 28-day cadence bar, lane-mix
  table, clickable slice index.
- **Agents** — coworker profile grid (role / focus / score / claims /
  heartbeat / last slice).
- **Teams** — lane ownership map with held/free pills.
- **Task #13** — native `<select>` brand pass (appearance:none chevron,
  brand-tinted option list).

## [v0.7.0] · 2026-05-16 · Learning Memory + Wiki Updater

**Slice δ.**

- Hindsight + Wiki Updater auto-fire on every `SLICE_STOP`.
- New `runtime/lib/wiki.mjs` — per-lane markdown pages, append-only,
  rebuildable from spine.
- **Learning route** — kind/lane/q filters, click-to-Inspector.
- **Wiki route** — drift drawer, page list, rendered viewer.

## [v0.6.0] · 2026-05-15 · BOSS / Enforcer duality

**Slice γ.**

- **BOSS route** — terminal-style transcript, action-proposal cards
  with risk pill, approve / reject / negotiate buttons.
- **Enforcer** — deterministic pure function in `runtime/lib/enforcer.mjs`.
  7 action kinds; every refusal cites a hard-rule slug.
- 7 proposals smoke-tested via curl (claim_conflict, write_to_auth_dir,
  session_required, allowed-once, etc.).

## [v0.5.0] · 2026-05-14 · Queue Board + Claim Map

**Slice β.**

- **Queue Board** — Scheduler / Queue / Dispatch / Preflights kanban
  with reason codes on every parked card.
- **Claim Map** — active claims with lease state, heartbeat age,
  competing-claim highlights, one-click handoff request.
- Lane policy strip (zones / lease / handoff rule).

## [v0.4.0] · 2026-05-14 · Conductor + Inspector

**Slice α.**

- **Conductor** — new default landing route. KPI strip, next-command,
  Operation Score Matrix, Now / Next / Waiting / Done board.
- **Inspector** — persistent right panel with overview / evidence /
  actions / related / raw tabs. No more modals.

---

## [v0.3.2] · 2026-05-14 · roadmap complete

The original v0.3.x design (Phases A–D from the AionUi/Hermes synthesis).
See `docs/releases/v0.3.2.md` for the full phase ledger.

---

## Tagged releases

```
v0.4.0  · Conductor + Inspector
v0.5.0  · Queue Board + Claim Map
v0.6.0  · BOSS / Enforcer
v0.7.0  · Learning Memory + Wiki Updater
v0.8.0  · Workflows + Roadmap depth + Agents + Teams
v0.9.0  · Telegram bridge
v0.10.0 · Discord + Email bridges
v0.11.0 · Cockpit polish (rail, dock, palette, motion, responsive)
v0.12.0 · Sub-target system + UI design-system alignment
```

`v1.0.0` is gated on the validation walkthrough in
[`docs/17-validation-checklist.md`](docs/17-validation-checklist.md).
