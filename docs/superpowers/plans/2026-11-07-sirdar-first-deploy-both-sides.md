# First Deploy Deploys Both Sides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an A/B environment's first deploy succeeds and goes live on side A, Sirdar immediately starts a separate Update that deploys the same commit to side B and leaves it idle.

**Architecture:** One new pipeline function, `_start_other_side(deployment_id)`, runs after A's success commit in `pipeline._run`. It uses its own session, checks the trigger rule against the environment's state, then calls `create_deployment` for the other slot (`go_live=False`, no snapshot, no first admin, no seed). It writes an audit row and a note in B's first step log, commits and launches B. `pipeline.wait()` also waits for a follow-up its deployment started, so callers and tests settle on both.

**Tech Stack:** Python 3.13, FastAPI, async SQLAlchemy, pytest (async), the existing fakes (`fake_provisioner`, `fake_runner`, `fake_publisher`).

**Spec:** `docs/superpowers/specs/2026-11-07-sirdar-first-deploy-both-sides-design.md`

## Global Constraints

- Run tests from `sirdar/api` with `.venv/bin/pytest`. Test DB names start with `sirdar_test`.
- American English in copy, comments and docs.
- Exact log line, appended to the start of B's first planned step's log: `Sirdar started this deploy after {slot} went live: the first deploy puts the same commit on both sides.\n` with `{slot}` = A's slot.
- B: `mode="update"`, other slot, `go_live=False` (even with auto_activate), `sha` = A's `dep.sha`, `git_ref` = A's, `snapshot_id=None`, `first_admin=False`, `seed_content=False`, `cloud`/`bluegreen`/`publish`/`vm` copied from A, `actor_id` = A's.
- Audit: `action="deploy.deployment_start"`, `entity_type="deployment"`, `entity_id=str(B.id)`, `ip=None`, `changes={"environment", "mode", "git_ref", "sha", "slot", "go_live": False, "follows": str(A.id)}`.
- A's status, log and audit are never changed by anything about B. B never triggers a further deployment.
- Stage files by explicit path. Never commit `api/src/serversherpa/_dev_reload.py`.

## Review Focus

1. **A's sha is empty** (step 0 didn't resolve one): B must not start with an empty sha. Expect a warning and no B.
2. **The trigger runs inside A's transaction or before A's commit:** `deployments_one_running` would refuse B, or a B failure would roll back A. The trigger runs after the commit, in its own session.
3. **The other slot's row is missing** (DigitalOcean before step 0 built it): treat it as never released.
4. **A retry of A that succeeds** must trigger B. A retry of B must not, because B has `go_live=False`.
5. **`pipeline.wait(A)` hangs or misses B:** `wait` must follow the follow-up exactly once, with the same timeout budget.

---

### Task 1: Start the other side after a first go-live

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py` (new `_start_other_side`; call it from `_run` after the success commit; `_follow_ups` map; `wait` follows it)
- Create: `sirdar/api/tests/test_deploy_first_both_sides.py`

**Interfaces:**
- Produces:
  - `pipeline._follow_ups: dict[uuid.UUID, uuid.UUID]`, mapping A's id to B's id;
  - `async def _start_other_side(deployment_id: uuid.UUID) -> uuid.UUID | None`, which returns B's id, or None when nothing started;
  - `pipeline.wait(deployment_id, timeout=30.0)`, which also awaits `_follow_ups.get(deployment_id)` after the first task ends.
- Trigger rule (all must hold, read in the new session with `populate_existing`):
  - `dep.status == "succeeded"`, `dep.mode == "update"`, `dep.cloud or dep.bluegreen`, `dep.go_live`, `dep.slot`;
  - `len(env.slots) == 2`, other = the slot that isn't `dep.slot`;
  - the other slot's row (`DoSlot` when cloud, `VmSlot` when bluegreen) is missing or has no `sha`;
  - `dep.sha` is non-empty (otherwise `log.warning` and None).
- Refusals from `create_deployment` (`DeployInProgress`, `do_envs.DoEnvError`, `NotSupportedOnDigitalOcean`, `NotSupportedOnBlueGreen`, `ValueError`): roll back, `log.warning("deployment %s: didn't start the %s side: %s", ...)` with the class name or code, return None.

- [ ] **Step 1: Write the failing tests** in `tests/test_deploy_first_both_sides.py`. Reuse the `ready` fixture patterns of `tests/test_deploy_do_deployments_api.py` (DigitalOcean) and `tests/test_deploy_lan_api.py` (LAN), importing their helpers rather than copying them where they are importable.
  - `test_a_first_do_deploy_then_deploys_the_other_side`: a new two-slot env; POST an Update; `await pipeline.wait(A)`. Then:
    - exactly two deployments: A (orange, go_live True, succeeded) and B (purple, go_live False, succeeded, `sha == A.sha`, `git_ref == A.git_ref`, `first_admin` False, `seed_content` False, `snapshot_id` None, `actor_id == A.actor_id`);
    - `env.active_slot == "orange"`;
    - the purple `DoSlot.sha == A.sha`;
    - B's first step's log starts with `"Sirdar started this deploy after orange went live: the first deploy puts the same commit on both sides.\n"`;
    - one audit row with `changes["follows"] == str(A.id)` and `changes["go_live"] is False`.
  - `test_the_second_side_starts_nothing`: after the above, the deployment count stays 2, and a further user Update (both sides released) adds exactly one deployment.
  - `test_auto_activate_still_leaves_the_other_side_idle`: env with `auto_activate=True`; B has `go_live` False and `active_slot` stays orange.
  - `test_a_first_lan_deploy_then_deploys_the_other_side`: the LAN equivalent (`bluegreen` True, purple `VmSlot.sha == A.sha`).
  - `test_a_failed_first_deploy_starts_nothing_until_its_retry_succeeds`: make a step fail (`fake_runner.results[...]` as existing tests do), so there's one deployment and it failed; Retry succeeds and B is started.
  - `test_a_one_slot_environment_starts_nothing`: `slots=1` gives one deployment.
  - `test_an_activate_starts_nothing`: an env with orange live and purple released; Activate purple adds no further deployment.
  - `test_a_busy_environment_skips_the_other_side`: monkeypatch `pipeline.create_deployment` to raise `pipeline.DeployInProgress` only for the follow-up call. Then A is succeeded, there's no B, and the warning is in `caplog`.
  - `test_an_empty_sha_starts_nothing`: `fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=None)` with a ref the route leaves unresolved, so `dep.sha == ""` and there's no B. If the route can't produce an empty sha, call `_start_other_side` directly on a succeeded deployment row with `sha=""`.

- [ ] **Step 2: Run them to verify they fail**
  Run: `.venv/bin/pytest -q tests/test_deploy_first_both_sides.py`
  Expected: FAIL (one deployment where two are expected; `_start_other_side` not defined).

- [ ] **Step 3: Implement `_start_other_side`, the `_run` call and `wait`** in `pipeline.py`.
  - Call it right after the success path's final `await db.commit()` in `_run`, wrapped so that no exception from it escapes into A's handling (log at warning).
  - Insert the note into B's first non-skipped step's `log` before the commit that launches B.
  - Register `_follow_ups[A] = B` before `launch(B)`.

- [ ] **Step 4: Run the new tests to verify they pass**
  Run: `.venv/bin/pytest -q tests/test_deploy_first_both_sides.py`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/tests/test_deploy_first_both_sides.py
  git commit -m "feat(sirdar): an A/B environment's first deploy goes on to deploy the other side"
  ```

### Task 2: Existing tests and docs match the new first deploy

**Files:**
- Modify: whichever existing tests assume the other slot stays empty after a first go-live Update. Likely candidates: `tests/test_deploy_do_deployments_api.py`, `tests/test_deploy_lan_api.py`, `tests/test_deploy_do_activate_api.py`, `tests/test_deploy_do_slots_and_sizes.py`, `tests/test_deploy_do_switch_and_remove.py`. Find them with the full suite.
- Modify: `sirdar/README.md`, in the "Slots (Blue/Green)" paragraph and the LAN "Update" bullet.

**Interfaces:**
- Consumes: Task 1's behavior and `pipeline.wait` following the follow-up.

- [ ] **Step 1: Run the full suite and list the failures**
  Run: `.venv/bin/pytest -q 2>&1 | tail -40` (it takes about 25 minutes, so run it in the background).
  Expected: failures only where a test assumed purple stays empty or counted deployments.

- [ ] **Step 2: Fix each failing test so it tests what it meant to.** Two cases:
  - **A test whose subject is the second, user-started Update or Activate:** keep its intent. Either seed the env through the existing `deployed(...)` / `_deployed(...)` helpers (state, not a first deploy), or account for B (for example `slot_not_deployed` for purple becomes testable only before B runs, so build that state directly).
  - **Deployment counts and audit lists that now include B:** update the expected values.

  Don't weaken an assertion just to make it pass. Put a one-line note in the report for each change.

- [ ] **Step 3: README.**
  - In "Slots (Blue/Green)", after "An Update deploys to the idle slot…", add: "The first deploy then goes on by itself: once the first slot is live, Sirdar starts a second Update that puts the same commit on the other slot and leaves it idle (its log's first line says so). That one never goes live, even with "activate automatically" on, and skips the seed, the first admin and starter content, which the shared database already has."
  - In the LAN "**Update**" bullet, add: "the first deploy then deploys the other VM with the same commit, idle".

- [ ] **Step 4: Run the full suite**
  Run: `.venv/bin/pytest -q` (in the background).
  Expected: 0 failed.

- [ ] **Step 5: Commit**
  ```bash
  git add sirdar/README.md <each test file changed>
  git commit -m "test(sirdar): first deploys now fill both sides; README says so"
  ```
