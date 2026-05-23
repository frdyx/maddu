---
id: read-before-edit
tags: read, edit, file, discipline
triggers: edit, modify file, change file
---

# Read before edit

Always Read a file before you Edit it. The Edit tool requires it, and so does basic professional discipline — the file may have changed since you last saw it (operator edit, prior slice, upstream sync).

Particular hazards:
- Files with markers (`<!-- BEGIN MADDU v1 -->`) are partly framework-owned; mis-edits drift the agent-file-current gate.
- Framework-owned files (anything under `maddu/` in a consumer install) get blown away by `maddu upgrade`. Edit `template/maddu/...` in the source repo instead.
- The lane catalog (`.maddu/lanes/catalog.json`) is one-time-seeded — `maddu upgrade` doesn't touch it after init.

When in doubt: read, diff in your head, then edit. The Edit tool refuses if you haven't read.
