# Research-report template

This is the 15-section template used to structure any "study an external repo for Máddu's design" deep-research task. The four reports in this directory (AionUi × Gemini, AionUi × GPT, Hermes × Gemini, Hermes × GPT) all follow this shape.

Every factual claim must be cited — either `path/to/file.ext:LINE-RANGE` from the studied repo, or a public URL (docs, blog, issue, video).

```
# Research Report — <REPO NAME>

## 1. Repo Identity
- URL:
- Commit SHA read:
- License:
- Last commit date:
- Primary language(s):
- Maintainer(s):
- One-paragraph elevator pitch:

## 2. Architecture Map
- Top-level directories (annotated):
- Runtime entry point(s):
- Build / packaging story:
- ASCII data-flow diagram:

## 3. Core Primitives
For each of `agent`, `session`, `task`, `tool`, `memory`, `workspace`, `event` — one paragraph + at least one `file:line` citation. If a primitive does not exist, say so.

## 4. State & Persistence Model
- Where state lives:
- Schema shape:
- Durability + recovery story:
- Compatibility with Máddu's files-only rule (✅ / ⚠️ / ❌ with reasoning):

## 5. Orchestration Model
- Scheduler / queue / lane equivalent:
- Concurrency model:
- Supervision + failure handling:

## 6. Provider / Model Integration
- How providers are configured:
- Where credentials flow:
- Where the API call actually executes (renderer / main / subprocess / cloud):
- Compatibility with Máddu's "no provider SDK in app code" rule:

## 7. UI / Cockpit Layer
- Shell metaphor:
- Window / pane / tab / workspace model:
- Navigation:
- Keyboard shortcuts:
- Theming / tokens / design system:
- Accessibility:

## 8. Tool / MCP Integration Surface
- Discovery mechanism:
- Registration:
- Invocation flow:
- Permission / approval model:
- Sandboxing:
- Hot-reload:

## 9. Strengths (ranked, copyable patterns)
Each item: name • one-line description • additive-feasibility-for-Máddu score (high / medium / low) • evidence citation.

## 10. Weaknesses / Gaps
Each item: name • why it's a problem • evidence citation.

## 11. Máddu Compatibility Matrix
| Feature | What it is | Máddu analog (or none) | Verdict | Rationale |
|---|---|---|---|---|
Verdict must be one of EXACTLY: `copy` / `adapt` / `skip` / `already-have`.
Aim for 15–25 rows.

## 12. Additive-Only Proposals for Máddu
Each proposal:
- **Name**
- **What it adds** (one paragraph)
- **Where it lives** in Máddu (new route/panel/file path)
- **Hard-rule check** (files-only, no SQLite, no hosted, brand boundary, etc.)
- **Estimated complexity** (S / M / L)
- **Suggested lane owner**

## 13. Risks of Adoption
Concrete risks. For each, propose mitigation.

## 14. Máddu Strengths Worth Preserving
At least 3 things Máddu's invariants do better than the studied repo. Keeps the synthesis honest.

## 15. Evidence Appendix
Every claim above gets a citation here:
- `path/to/file.ext:LINE-RANGE` — what was observed
- `https://url` — what was read
```
