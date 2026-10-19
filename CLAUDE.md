# Working preferences

- When executing an implementation plan, always use subagent-driven
  development (superpowers:subagent-driven-development) — do not ask which
  execution approach to use.
- The V2-to-V3 parity tracker is a Google Sheet, not the files in `docs/`.
  Before reading or updating it (after merges, retiring/deferring items, or
  the Weekly Summary tab), read `.claude/parity-sheet.md` — it has the sheet
  id, tab/column layout, row map, note formats, summary math, and how to
  write cells through Claude in Chrome.
- Harbor Master (MCP, project `SS`) duplicates the parity sheet for now:
  boards Feature Parity, To-Do and Future Features, plus weekly progress
  updates. Whenever the sheet is updated, make the same change in Harbor
  Master. `.claude/parity-sheet.md` covers both.
- `/factory` is the Harbor Master-hosted skill, installed under
  `~/.claude/skills/factory` with its agents in `~/.claude/agents`. The
  user says per request whether a feature comes from the sheet or from
  Harbor Master, and where its design doc goes.
