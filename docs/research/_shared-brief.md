# Shared deep-research brief — AionUi + Hermes

This is the substantive brief used to commission both the Gemini Deep Research and the GPT Deep Research passes that produced the four reports in this directory. The Gemini and GPT wrappers (`_gemini-wrapper-brief.md`, `_gpt-wrapper-brief.md`) reference this file as the canonical source of *what* to study; their own wrappers only differ on *how* to investigate.

## Targets (equal depth)

1. **AionUi** — https://github.com/iOfficeAI/AionUi (primary inspiration source for Máddu's cockpit / workspace / runtime affordances).
2. **Hermes** — https://github.com/NousResearch/hermes-agent (paired runtime; studied for its agent protocol, approval API, hindsight memory, and session model).

Equal-depth means one full report per repo using the 15-section template at [`_template.md`](_template.md).

## Why this research exists

Máddu is being designed as a files-only, local-first orchestration framework — a cockpit-plus-bridge that installs into any git repo. The research surfaces patterns from existing agentic-OS-style systems so Máddu can adopt the additive ones and explicitly reject the violating ones.

Output flows into [`../maddu-v0.3-roadmap.md`](../maddu-v0.3-roadmap.md), specifically Phase A–D feature definitions.

## Máddu's hard rules (any recommendation that violates these must be flagged "do-not-copy")

1. **Files-only state.** No SQLite, no embedded DB, no hosted DB.
2. **No hosted backends.** Provider calls go directly to vendor APIs from local subprocesses.
3. **No broad new dependencies.** Node stdlib where possible.
4. **No provider SDK imports in app code.** Only worker subprocesses own the API call.
5. **No token export.** OAuth tokens are device-bound; portable bundles scrub them.
6. **Three-layer brand boundary** — framework shell / app / content brands never mix.
7. **Event spine + slice-stop ritual** — append-only NDJSON; every working slice ends with a structured stop summary.
8. **Lane ownership** — agents claim a lane before editing.

Any feature requiring cloud backends, embedded DBs, provider SDKs in renderer/runtime code, token-exporting "sync" features, or cross-lane mutation must be flagged as **do-not-copy** in the compatibility matrix — never silently included as a "future improvement."

## OS-like axes of interest (all four are in scope)

- Shell / window / workspace UX.
- Process / runtime model.
- Filesystem & state model.
- Tool / MCP integration surface.

## Prioritized questions (answer ALL inside the template's sections)

1. What is the studied repo's equivalent of Máddu's *lanes, events, slice-stop, context packs, verification reports*? Side-by-side mapping.
2. What does the renderer / main / worker process model look like, and what does it buy users that a single bridge server doesn't?
3. How does the studied repo persist conversations, attachments, per-workspace configs? Storage model compatibility with Máddu's files-only rule?
4. How does it discover and configure MCP servers? Per-workspace? Global? Hot-reload? Permission model per tool?
5. Shell metaphor — tabs / panes / windows / workspaces / "applets" — and which patterns are additive on top of Máddu's planned cockpit routes (`/dashboard`, `/operations`, `/swarm`, `/chats`, `/roadmap`, `/settings`, plus new OS-like routes from Phase A–D)?
6. Tool invocations: approval prompts, streaming output, cancellation, replay, history.
7. Multi-agent / multi-provider sessions in one workspace — routing, fan-out.
8. (Hermes only) What does Hermes contribute when paired with an AionUi-style shell — runtime, tool schemas, agent protocol, model preferences?
9. Anti-patterns that violate Máddu's rules. Each must be flagged do-not-copy.
10. What does Máddu already do better than the studied repo (slice-stop loop, three-layer brand boundary, files-only event spine, lane ownership)? List at least 3.
11. For each high-priority finding, sketch what it would look like as an **additive route or panel** in the Máddu cockpit.
12. Single minimum-viable cockpit addition that captures the biggest OS-like UX win.
13. Licensing — can we directly port code, or is this study-only?
14. MCP discovery model compatibility with Máddu's bridge-owned MCP assumption.
15. Cross-machine portability — anything analogous to Máddu's planned `maddu export` / `maddu import` (scrubs tokens, ports definitions)?

## Output format

Fill in the 15-section template at [`_template.md`](_template.md). No prose outside that structure.
