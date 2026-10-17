# Software factory

A feature goes in; a reviewed branch merged to `main` (or a job waiting for
you) comes out. The whole thing is markdown plus one skill:

| File | What it is |
|---|---|
| `.claude/skills/factory/SKILL.md` | the orchestrator: the loop, the commands, the rules |
| `.claude/agents/factory-*.md` | the seven agents (spec writer, builder, four reviewers, approver) |
| `factory/repo.md` | the repo profile every agent reads first (stack, test commands, conventions) |
| `factory/backlog.md` | the queue for `/factory next` |
| `factory/board.py` | the orchestrator's only way to write `board.json` (locked, atomic) |
| `factory/board.json` | live state; drives the dashboard (local, git-ignored) |
| `factory/jobs/<id>/` | one folder per job: `spec.md`, `build.md`, `round-N/review-*.md`, `decision.md` (local, git-ignored) |
| `factory/dashboard.html` | the visual board |

## Use it

```
/factory Sites list: add a "Last move" column
/factory next
/factory approve 004-last-move-column
/factory rework 004-last-move-column Use the initiative end date, not start
```

Dashboard: `cd factory && python3 -m http.server 8765` (or the `factory-dashboard`
entry in `.claude/launch.json`), then open
http://localhost:8765/dashboard.html.

## Change it

Edit the loop diagram and steps in `SKILL.md`, or an agent's file. Each
agent reads only files and writes only its own file, so you can swap one
without touching the others. The builder works in its own worktree on
`factory/<id>`; merges are local and never pushed.
