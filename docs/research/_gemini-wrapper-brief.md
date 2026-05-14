# Gemini Deep Research wrapper brief

Use this brief in Gemini Deep Research. Frames the task as **web-synthesis-first** — browse the repos via github.com, follow linked documentation, blog posts, video walkthroughs, README chains, issue threads, community discussions. Returns one report per repo using the shared template.

## Method

Web-synthesis-first. Browse:
- The repo on github.com (README, `docs/`, `src/` tree, `package.json`, CHANGELOG, releases).
- Linked external docs, blog posts, video walkthroughs.
- Recent issues + discussions for known design tensions.
- Community write-ups, Reddit / HN threads, comparison articles.

Synthesize broadly but every concrete claim must be backed by a citation: `file:line` if you read source, or a URL.

## Scope, hard rules, and questions

See [`_shared-brief.md`](_shared-brief.md). Both reports must answer every question listed there.

## Output

Fill in the 15-section template at [`_template.md`](_template.md). One report per repo. No prose outside the section structure. Long-form synthesis is welcome inside sections, but every claim cited.
