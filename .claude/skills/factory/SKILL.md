---
name: factory
description: Run the software factory. A feature goes through spec, build, four parallel reviews, and an approver, then merges to main or waits for a human. Use for "/factory <feature>", "/factory next", "/factory approve <job-id>", "/factory rework <job-id> <note>".
argument-hint: <feature> | next | approve <job-id> | rework <job-id> <note>
---

# /factory

You are the **orchestrator**. You run the loop below, spawn every agent, and
you are the only writer of `factory/board.json`. You never write code,
specs, reviews, or decisions yourself; agents do, each into its own file.

Arguments: `$ARGUMENTS`

## The loop (edit this to change the factory)

```
feature ─► spec-writer (opus) ─► builder (opus) ◄──────────────┐
                                    │                           │
            ┌───────────┬───────────┼───────────┐               │
            ▼           ▼           ▼           ▼               │
        security       ux       ui design     code              │
         (opus)     (sonnet)    (sonnet)    (sonnet)            │
            └───────────┴─────┬─────┴───────────┘               │
                              ▼                                 │
                    WAIT FOR ALL 4 reviews ── any CHANGES ──────┘
                              │ all PASS       resume builder (max 2)
                              ▼
                       approver (opus)
                     APPROVE │    │ ESCALATE
                             ▼    ▼
                 merge to main    needs-human ◄── /factory approve
```

| Step | Agent (`subagent_type`) | Writes |
|---|---|---|
| spec | `factory-spec-writer` | `spec.md` |
| build | `factory-builder` | commits on `factory/<id>`, `build.md` |
| review | `factory-review-security`, `-ux`, `-ui`, `-code` | `round-N/review-<key>.md` |
| approve | `factory-approver` | `decision.md` |

Reviewer keys on the board: `security`, `ux`, `ui`, `code`.
`MAX_FIXES = 2`: how many times the builder is resumed after a CHANGES round
before the job goes to needs-human.

## Paths

- `MAIN` = the main checkout: `git worktree list --porcelain | head -1 | cut -d' ' -f2`.
  All factory state lives in `$MAIN/factory/`, even if you run in a worktree.
- Job id: `NNN-slug` (next number after the highest in `factory/jobs/`,
  3 digits; slug is 2 to 4 kebab-case words).
- Job dir: `$MAIN/factory/jobs/<id>/`. Round dir: `<job dir>/round-N/`.
- Branch `factory/<id>`, worktree `$MAIN/.claude/worktrees/factory-<id>`.
- Board writes always go through the helper, never by hand:
  `python3 $MAIN/factory/board.py <command> …` (run it with no arguments for help).

Every agent prompt is short and gives **paths only**: repo profile
(`$MAIN/factory/repo.md`), job dir, round dir, worktree, job id. Agents get
context from files, not from this conversation. Never paste reviews or
specs into a prompt.

## /factory <feature>

1. Pick the id, create the job dir, `board.py add <id> "<title>"` (stage `spec`).
2. **Spec.** Spawn `factory-spec-writer` (foreground) with the feature text
   and the paths. Check `spec.md` exists. If it has `## Open questions`,
   `board.py set <id> stage=needs-human note="spec has open questions"` and stop.
3. **Worktree.** `git -C $MAIN worktree add .claude/worktrees/factory-<id> -b factory/<id> main`.
   `board.py set <id> stage=build round=1`.
4. **Build.** Spawn `factory-builder` (foreground) named `builder-<id>` (pass
   the name if your Agent tool takes one). Record the agent id it returns:
   `board.py set <id> builder=<agent id>`. Check `build.md` exists.
5. **Review round N.** Create `round-N/`. `board.py set <id> stage=review`.
   Spawn the four reviewers **in one message, in the background**, each
   with the paths and N. As each one finishes, read the first line of its
   file and `board.py review <id> <key> PASS|CHANGES`, so chips fill in live.
6. **WAIT FOR ALL.** The round is done only when all four
   `round-N/review-*.md` files exist. A finished agent without a file is
   re-spawned (once). Never resume the builder mid-round.
7. **Any CHANGES:**
   - If fixes used < `MAX_FIXES`: `board.py next-round <id>` (archives the
     chips, round N+1, stage `build`), then resume the same builder with
     SendMessage (load it with ToolSearch if it is deferred) to
     `builder-<id>` (or its recorded agent id):
     "Round N had changes. Read `<round dir>` and fix every Required point,
     then update build.md." Back to step 5 with N+1.
   - Otherwise: `board.py set <id> stage=needs-human note="still CHANGES after round N"`. Stop.
   - If the builder cannot be resumed (new session), spawn a fresh
     `factory-builder` with the same paths plus "you are resuming: read
     build.md and the latest round folder first", and record its id.
8. **All PASS.** `board.py set <id> stage=approve`. Spawn `factory-approver`
   (foreground). Read the first line of `decision.md`.
9. **APPROVE** → merge (below). **ESCALATE** →
   `board.py set <id> stage=needs-human note="<one line from ## Why>"`. Stop.

## Merge (APPROVE, or /factory approve)

1. `git -C $MAIN branch --show-current` must be `main`; otherwise set
   needs-human with that note and stop. Never stash or switch branches.
2. `git -C $MAIN merge --no-ff factory/<id> -m "<Merge message from decision.md>"`.
   On a conflict: `git -C $MAIN merge --abort`, set needs-human
   `note="merge conflict"`, stop. Never resolve conflicts yourself.
3. `git -C $MAIN worktree remove --force .claude/worktrees/factory-<id>`
   and `git -C $MAIN branch -d factory/<id>`.
4. `board.py set <id> stage=merged note="<merge commit short sha>"`.
   Do not push; the human pushes.

## /factory next

Take the first `- [ ]` line in `factory/backlog.md`, change it to
`- [x] <text> → <id>` (you write that one line), then run it as `/factory <text>`.
If nothing is unchecked, say so and stop.

## /factory approve <job-id>

Only for a job in stage `needs-human` whose latest round is all PASS (the
human has read decision.md). `board.py set <id> approved_by=human`, then Merge.
If its reviews are not all PASS, say so and suggest `/factory rework`.

## /factory rework <job-id> <note>

1. Write the note to `<job dir>/rework-K.md` (K = next number) under the
   heading `# Human rework note`; this is the one job file you write.
2. `board.py rework <id>`: fixes reset to 0, round N+1, stage `build`.
3. Resume (or respawn) the builder: "A human sent rework notes: read
   `rework-K.md`, fix, update build.md." Continue the loop at step 5.

## Status

After every step, tell the human one line: the job, the stage, and what
happens next. Point them at the dashboard:
`cd factory && python3 -m http.server 8765 --bind 127.0.0.1`, then http://localhost:8765/dashboard.html.
