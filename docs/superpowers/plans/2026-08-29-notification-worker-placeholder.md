# Notification Worker Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** A `serversherpa notification-worker` process that registers in the heartbeat registry and writes status logs, but performs NO notification processing — the visible scaffold the future sender will fill in.

**Architecture:** New `api/src/serversherpa/notifications/` package with `worker.py`, mirroring `imports/worker.py` line-for-line in structure: `db_logging.install("notification-worker")` + `registry.start_heartbeat("notification-worker", "worker")`, then an idle asyncio loop. The Processes page (`/system/processes`) and log viewer need no changes — they are registry/log_entries-driven.

**Tech Stack:** existing only. No migration (processes/log_entries tables exist).

## Global Constraints

- Process name is exactly `notification-worker`, kind `worker`.
- The worker must NOT read or mutate notification delivery state — the only DB touches are the heartbeat upsert, log writes, and one read-only count query for the status line.
- Tests FOREGROUND, one continuous run, timeout 600000ms; `cd api && .venv/bin/pytest`. Never background a suite.
- `git checkout -- api/src/serversherpa/_dev_reload.py` before committing if dirty.
- Commits end with blank line + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: worker module + CLI + Procfile + tests

**Files:**
- Create: `api/src/serversherpa/notifications/__init__.py` (empty)
- Create: `api/src/serversherpa/notifications/worker.py`
- Modify: `api/src/serversherpa/cli.py` (new `notification-worker` command + picklable `_run_notification_worker_process` reload child, mirroring `import_worker` at cli.py:217-254 and `_run_log_service_process` at :257-269)
- Modify: `Procfile.dev` (add `notifsvc: api/.venv/bin/serversherpa notification-worker --reload` after `logsvc`)
- Test: `api/tests/test_notification_worker.py`

**Interfaces (produces):**
- `notifications/worker.py`:
  ```python
  logger = logging.getLogger("serversherpa.notifications.worker")
  IDLE_LOG_SECONDS = 900   # one INFO status line every 15 min

  async def status_counts(db) -> tuple[int, int]
      # (enabled_group_count, member_count_across_enabled_groups) — read-only
  async def run_once(maker) -> None
      # one status pass: query counts, logger.info(
      #   "idle — %d enabled group(s), %d member(s); delivery pipeline not implemented", ...)
  async def run_forever(poll_seconds: float = 5.0) -> None
      # install("notification-worker"); start_heartbeat("notification-worker", "worker")
      # startup: logger.info("notification worker online — placeholder: "
      #                      "status/logs only, no delivery yet")
      # then run_once immediately, and again whenever IDLE_LOG_SECONDS has
      # elapsed; sleep poll_seconds between checks. finally: cancel heartbeat
      # + gather (copy imports/worker.py:114-135 shutdown shape exactly)
  ```
- CLI `notification-worker`: options `--poll-seconds` (default 5.0), `--once` (one status pass, print + exit), `--reload` (watchfiles, mutually exclusive with --once) — copy the `import_worker` command's structure including `dispose_engine()` at the end.

**Steps:**
- [ ] TDD (failing tests first, model fixtures on `tests/test_notification_groups_api.py` + grep existing tests for `SystemProcess`/`LogEntry` usage): (1) `run_once` with one enabled group (2 members) + one disabled group logs the idle line containing "1 enabled group" and "2 member(s)" (use `caplog`); (2) `status_counts` excludes disabled groups' members; (3) `run_forever` smoke: start as a task, wait briefly, assert a `processes` row `name='notification-worker'` exists with fresh `heartbeat_at`, then cancel and assert `stopped_at` set (mirror however existing registry/worker tests do this — grep `test_` files for `start_heartbeat`/`processes`).
- [ ] Run focused file foreground → fail; implement; focused pass.
- [ ] FULL api suite foreground (timeout 600000ms) → commit `feat(api): notification-worker placeholder — heartbeat + status logs, no delivery`.

---

### Task 2: Verification (orchestrator)
- [ ] Start the worker (`api/.venv/bin/serversherpa notification-worker --once` first, then the honcho stack already running picks it up only after restart — instead run `notification-worker` standalone in background briefly), confirm `/system/processes` shows `notification-worker` Running and its logs page shows the startup + idle lines. Screenshot. Ledger.
