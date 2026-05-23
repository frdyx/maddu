---
id: parallel-tool-use
tags: parallel, performance, tool-use
triggers: parallel, batch, concurrent
---

# Parallel tool use

When multiple independent tool calls are required, batch them in one message. The harness runs them in parallel, which is 3–10x faster than sequential.

Independent = no later call depends on an earlier call's output.

Examples of safe batching:
- Multiple unrelated Read calls.
- A `git status` and a `git log -5` in parallel.
- Running stress-harness + layout-refusal + upgrade-matrix concurrently when none of them mutate shared state.

Examples of UNSAFE batching:
- Edit then Read of the same file (Read may race the Edit).
- A `git commit` followed by a `git push` (push depends on commit landing).
- Anything that writes the spine concurrently — keep spine appends sequential.

When you batch, do it explicitly inside ONE tool block; do not split across multiple turns.
