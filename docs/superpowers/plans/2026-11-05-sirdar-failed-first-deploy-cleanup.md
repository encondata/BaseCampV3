# Sirdar failed-first-deploy clean-up + SSH retries: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed first deploy can be cleaned up from its page, either keeping the environment ("Clean up and keep settings") or removing it ("Remove everything"), on every target. Separately, SSH connections during deploys retry dropped connections.

**Architecture:**
- **New deployment mode `cleanup`.** It runs the same steps as `teardown` on every target. When it succeeds, `deploy/cleanup.py` resets the environment to never deployed instead of deleting its row.
- **Remove everything** is the existing `teardown` started from the new section.
- **SSH retries.** `ssh.py` gets one connect-retry helper used by `pinned_host_key` and `connect_pinned`. The Ansible runner gets `ANSIBLE_SSH_RETRIES`.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (Sirdar API, `sirdar/api`), asyncssh, ansible-runner, React + vitest (`sirdar/web`).

**Spec:** `docs/superpowers/specs/2026-11-05-sirdar-failed-first-deploy-cleanup-design.md`. Read it first; this plan only adds the decisions it leaves open.

## Global Constraints

- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` on branch `sirdar`. Stage files by explicit path. Never commit `api/src/serversherpa/_dev_reload.py`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Copy** is American English, plain sentences, and exactly as written here or in the spec:
  - "Clean up and keep settings"
  - "Remove everything"
  - "This environment has never deployed. Remove what this attempt built:"
  - "Couldn't reach {host}:{port}; trying again ({n} of 5)."
- **SSH retry:** 5 attempts, 3 s apart. `ANSIBLE_SSH_RETRIES=5`. SSH `ConnectTimeout` 15 s.
- **Never retry:** a host-key mismatch, an unknown host, permission denied, or a command that has started.
- **Production** keeps Delete's rules for `cleanup` too: retiring, no active slot, and the phrase `delete production <name>`. Typing the name is always required (`confirm_name`).
- **Running tests:**
  - Sirdar API: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_cleanup_<task> .venv/bin/python -m pytest <paths> -q`. Run only the named files; the full suite runs at the end.
  - Web: `cd sirdar/web && npx vitest run <files>` and `npx tsc --noEmit -p .`.
- Match the surrounding code's comment density, naming and idioms. New modals follow the existing modal header pattern with rounded corners. Reuse DeleteEnvironmentModal's idioms.

## Review Focus

1. **A cleanup on DigitalOcean that leaves `do_resources` rows** must fail with the existing "Sirdar still records N…" guard and keep the environment un-reset. Pinned in Task 3: `test_cleanup_do_resources_left_fails_without_reset`.
2. **The next Update after a cleanup** must not die on old state (old pins, a missing ESXi/Proxmox host key, stale `host_ip`). Pinned in Task 3: `test_cleanup_then_update_plans_step0_with_fresh_keys` per VM target.
3. **A cleanup started on an environment that deployed successfully once,** including via a retry or a direct API call, must be refused. Pinned in Task 4: `test_cleanup_refused_after_a_successful_update` and `test_retry_cleanup_refused_after_success`.
4. **A retried SSH command is never run twice.** A failure after the session opens is not retried. Pinned in Task 1: `test_run_command_failure_after_connect_not_retried`.
5. **A first admin created by the failed attempt** must be asked for again (typed password), and a deploy must be refused until it is. It must never deploy with an empty password. Pinned in Task 3: `test_cleanup_resets_typed_first_admin_to_needs_password`, and in Task 4: `test_update_refused_while_first_admin_needs_password`.

---

### Task 1: SSH connection retries (Sirdar + Ansible)

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/ssh.py` (`pinned_host_key`, `connect_pinned`, `run_command`)
- Modify: `sirdar/api/src/sirdar_api/deploy/runner.py` (`envvars`)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_provision.py` (`_ssh_remote` passes a log callback)
- Test: `sirdar/api/tests/test_deploy_ssh_retry.py` (new); extend the runner envvars test if one exists (`grep -l envvars sirdar/api/tests`)

**Interfaces:**
- Produces:
  - `ssh.CONNECT_TRIES = 5`
  - `ssh.CONNECT_RETRY_DELAY = 3.0`
  - `async def ssh.with_connect_retry(host: str, port: int, attempt: Callable[[], Awaitable[T]], *, log: Callable[[str], None] | None = None, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> T`. It retries only `ConnectFailed` whose reason is the `known_hosts.unreachable` one. Mark that case with a subclass `known_hosts.Unreachable(ConnectFailed)` raised by `unreachable()`, so the auth-failed and "key changed during the test" ConnectFailed are not retried. The last failure is re-raised unchanged.
  - `run_command(..., log: Callable[[str], None] | None = None)` and `pinned_host_key(db, host, port, *, log=None)`, both wrapped in the retry.
  - `test_connection` stays single-attempt. Retry everywhere else that calls these.

- [ ] **Step 1: Write the failing tests** in `test_deploy_ssh_retry.py`, with monkeypatched `known_hosts.fetch_key_of_type` / `asyncssh.connect` and a fake sleep:
  - `test_connect_retries_then_succeeds`: two `Unreachable` failures then success. The result is returned; `log` got exactly `"Couldn't reach 10.0.0.5:22; trying again (2 of 5).\n"` and `"... (3 of 5).\n"`; sleep was called with 3.0 twice.
  - `test_connect_gives_up_after_five`: five failures. It raises `ConnectFailed` with reason `"Couldn't reach 10.0.0.5:22."`, after 5 attempts.
  - `test_mismatch_and_auth_not_retried`: `HostKeyMismatch` and the `_AUTH_FAILED` ConnectFailed each propagate after 1 attempt.
  - `test_run_command_failure_after_connect_not_retried`: connect succeeds, `conn.run` raises `asyncssh.ChannelOpenError`. Result `CommandResult(None, "")` and connect was called once.
  - `test_runner_sets_ssh_retries`: `envvars(...)` has `ANSIBLE_SSH_RETRIES == "5"`, and `ANSIBLE_SSH_ARGS` contains `-o ConnectTimeout=15`.
- [ ] **Step 2: Run them**; expect failures (no `with_connect_retry` / `Unreachable`).
- [ ] **Step 3: Implement.**
  - `known_hosts.Unreachable(ConnectFailed)`; `unreachable()` returns it.
  - `with_connect_retry` goes in `ssh.py`. `pinned_host_key` wraps its `fetch_key_of_type` call, and `connect_pinned` wraps the `asyncssh.connect` call (the mapping to `Unreachable` stays inside the attempt).
  - `run_command` passes `log` to both.
  - `runner.envvars` adds `ANSIBLE_SSH_RETRIES` and `-o ConnectTimeout=15` to the existing `ssh_args`, unless `ConnectTimeout` is already there; check the current value first.
  - `do_provision._ssh_remote` takes an optional `log` and passes it on. `_grants` and the health check pass `out`. Keep the `Remote` type in step: tests inject fakes, so update the `Remote` alias and the fakes' signature, or pass `log` as a keyword with default `None`.
- [ ] **Step 4: Run** the new tests plus `tests/test_deploy_ssh*.py tests/test_deploy_host_key_algs.py tests/test_deploy_runner*.py tests/test_deploy_do_provision*.py`; all pass.
- [ ] **Step 5: Commit** `feat(sirdar): retry dropped SSH connections (Sirdar 5x/3 s, Ansible SSH retries 5)`.

### Task 2: `cleanup` mode plumbing (migration, steps, pipeline modes)

**Files:**
- Create: `sirdar/api/migrations/versions/0016_cleanup_mode.py`. Copy 0010's `deployments_mode_check` pattern: add `'cleanup'`; the downgrade deletes `cleanup` deployments and restores the check. Down revision `0015_learn_and_editable_apps`.
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py`: add `"cleanup"` to `MODES`; `plan_for("cleanup", …)` returns exactly `plan_for("teardown", …, snapshot=False)` for every target (vm, cloud, bluegreen). It refuses `snapshot=True` for cleanup.
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py`, `vmsteps.py`, `esxi_provision.py:155`, `renewals.py:65`, `db/models.py` comment. Every `mode == "teardown"` check that is about removing things also covers `"cleanup"`, through one tuple `steps.REMOVING_MODES = ("teardown", "cleanup")`. Exceptions:
  - the snapshot-on-delete checks (cleanup never snapshots);
  - the success branch that deletes the env row (Task 3 adds cleanup's own branch).
  - `pipeline.py:393` sets `deleting` for both.
- Modify: the head-revision asserts in tests, if any (`grep -rn "0015_learn" sirdar/api/tests`).
- Test: `sirdar/api/tests/test_deploy_cleanup_mode.py` (new)

**Interfaces:**
- Produces:
  - `steps.REMOVING_MODES`
  - migration head `0016_cleanup_mode`
  - `create_deployment(..., mode="cleanup")` is accepted by the pipeline layer.

- [ ] **Step 1: Failing tests:**
  - `test_cleanup_plan_equals_teardown` for `{}`, `{vm: True}`, `{cloud: True}`, `{vm: True, bluegreen: True}`: the step keys are equal.
  - `test_cleanup_refuses_snapshot`: `ValueError`.
  - `test_migration_0016_round_trip`: upgrade allows inserting a `cleanup` deployment; downgrade removes it and refuses the mode. Follow the existing migration test file's style.
  - `test_cleanup_marks_env_deleting`: `create_deployment(mode="cleanup")` sets `env.status == "deleting"`.
- [ ] **Step 2: Run them**; expect them to fail.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** the new file plus `tests/test_deploy_steps*.py tests/test_migrations*.py tests/test_deploy_pipeline*.py`; all pass.
- [ ] **Step 5: Commit** `feat(sirdar): cleanup deployment mode runs the teardown steps (migration 0016)`.

### Task 3: Reset the environment after a successful cleanup

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/cleanup.py`
- Modify: `pipeline.py` success path, next to the `teardown` branch at ~1327–1350. For `cleanup`:
  - run the same DigitalOcean `do_resources` guard;
  - then `await cleanup.reset(db, settings, env)`;
  - audit `deploy.environment_cleanup` with `{"environment": env.name, "deployment": str(dep.id)}`;
  - set `env.status = "new"`.
- Modify: `first_admins.py`:
  - `reset(db, env_id) -> None`;
  - `needs_password(row) -> bool` (pending, `password_mode == "typed"` and `password_enc is None`);
  - `public()` gains `"needs_password"`.
- Test: `sirdar/api/tests/test_deploy_cleanup_reset.py` (new)

**Interfaces:**
- Consumes: `steps.REMOVING_MODES` (Task 2).
- Produces:
  - `async def cleanup.reset(db: AsyncSession, settings: Settings, env: Environment) -> None`
  - `first_admins.reset`, `first_admins.needs_password`
  - `public()["needs_password"]`

What `reset` does. Read the models and provisioners for exact column names.
- **Every target:**
  - `current_sha`/`image_tag` stay null;
  - the `host_ip` set by a VM or droplet is cleared on `environment_services` rows (not for SSH-server targets, whose host is the user's);
  - remaining `managed_records` are left alone (steps 16–17 removed them);
  - `first_admins.reset`.
- **DigitalOcean:**
  - each `do_slots` row: `droplet_id`, `public_ip`, `private_ip` = None;
  - a slot with `host_key_private_enc IS NULL` gets `vms.new_host_keypair(f"{env.name}-{slot}")` stored like `_create_droplet` does;
  - `active_slot` = None;
  - clear any step-0 addresses or credentials recorded on `do_environments` that a new build must recreate. Read `_prepare`/`_bucket`/`_vpc` and clear exactly what they skip when it is already set.
- **Proxmox/ESXi** (every VM row, every role):
  - `vmid`/`moref`/`instance_uuid` = None;
  - the learned IP = None, unless a static IP is configured;
  - recorded VM snapshots deleted;
  - a new host keypair (`vms.new_host_keypair`) with `host_key_private_enc` set, so step 0 can build;
  - pins for old addresses forgotten (`vmcommon.forget_pin`), if destroy didn't already.
- **LAN Blue/Green:** the VM reset for the data VM and both app VMs; `lan_slots` rows back to their created state (sha and live markers cleared; read `lan_slots.after_success`).
- **First admin:** `done_at` = None. For `typed`, `password_enc` stays None, so `needs_password` is true. For `invite`, nothing more.

- [ ] **Step 1: Failing tests** (use the existing environment and DigitalOcean/VM fixtures from the teardown tests):
  - `test_cleanup_success_keeps_env_and_resets_do`: env still exists, status `new`; slots have no droplet or IP; delivered slots have a fresh decryptable keypair; audit row `deploy.environment_cleanup`.
  - `test_cleanup_do_resources_left_fails_without_reset`: one leftover `DoResource` row means the deployment failed at `do_destroy` and the env is unchanged except `status` per the existing failure path.
  - `test_cleanup_resets_esxi_vm` and `test_cleanup_resets_proxmox_vm`: ids cleared, new host key present, static IP kept.
  - `test_cleanup_resets_bluegreen`: three VMs reset; `lan_slots` sha null.
  - `test_cleanup_ssh_target_keeps_host`: the saved target, its pin and the service hosts are unchanged.
  - `test_cleanup_resets_typed_first_admin_to_needs_password` and `test_cleanup_resets_invite_first_admin`.
  - `test_cleanup_then_update_plans_step0_with_fresh_keys`: for ESXi and DigitalOcean, after reset, building the next Update's context gets past the "no longer has the host key" check, using the existing provisioner test fakes.
- [ ] **Step 2: Run them**; expect them to fail.
- [ ] **Step 3: Implement `cleanup.reset`, the `first_admins` helpers, and the pipeline branch.**
- [ ] **Step 4: Run** the new file plus `tests/test_deploy_pipeline*.py tests/test_deploy_do*.py tests/test_deploy_esxi*.py tests/test_deploy_provision*.py tests/test_deploy_lan*.py tests/test_first_admin*.py`; all pass.
- [ ] **Step 5: Commit** `feat(sirdar): a successful cleanup resets the environment to never deployed`.

### Task 4: API — start `cleanup`, the never-deployed rule, retry, first-admin gate

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py`: `async def never_deployed(db, env) -> bool`, true when `env.current_sha is None` and there is no `Deployment` with `environment_id == env.id`, `mode == "update"`, `status == "succeeded"`.
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py`: `environment_out` adds `"never_deployed": bool`.
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`:
  - `DeploymentIn.mode` Literal gets `"cleanup"`.
  - Add `cleanup` to `GATED_MODES` (name typed) and `RETRY_MODES`, and to the `git_ref_not_allowed` list.
  - The snapshot fields are refused for cleanup (`snapshot_not_allowed`), except that `confirm_production` is allowed.
  - Before dispatch: `cleanup` with `not await environments.never_deployed(db, env)` → `409 {"code": "cleanup_not_allowed"}`.
  - Dispatch `cleanup` through the same per-target starters as `teardown` (`_start_do_teardown`, `_start_lan_teardown`, the VM/SSH path at ~1524–1540), with a `mode` parameter. Production on DigitalOcean calls `_production_removable` for cleanup too. No snapshot is ever taken.
  - The retry route (~1653–1721) treats `cleanup` like `teardown` for production checks and re-checks `never_deployed`.
  - `update` (and its retry) on an env where `first_admins.needs_password(row)` → `409 {"code": "first_admin_password_needed"}`.
  - Add both codes to the route's status map.
- Test: `sirdar/api/tests/test_deploy_cleanup_route.py` (new)

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - `POST /api/deploy/environments/{name}/deployments {mode:"cleanup", confirm_name, confirm_production?}`
  - `environment_out(...)["never_deployed"]`
  - error codes `cleanup_not_allowed`, `first_admin_password_needed`

- [ ] **Step 1: Failing tests:**
  - `test_cleanup_starts_for_never_deployed`, one per target (SSH, Proxmox, ESXi, Blue/Green, DigitalOcean): 201, mode `cleanup`, the plan's steps equal teardown's.
  - `test_cleanup_refused_after_a_successful_update`: 409 `cleanup_not_allowed`.
  - `test_cleanup_needs_name`: 422 `confirm_name_mismatch`.
  - `test_cleanup_refuses_snapshot_and_git_ref`.
  - `test_cleanup_production_needs_retiring_and_phrase`: `production_not_retiring`, then `confirm_production_mismatch`, then 201.
  - `test_retry_cleanup_refused_after_success`.
  - `test_environment_out_never_deployed`: true for a new env and after a failed update; false after a succeeded update.
  - `test_update_refused_while_first_admin_needs_password`: then a PUT `/first-admin` with a typed password lets it start.
- [ ] **Step 2: Run them**; expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file plus `tests/test_deploy_routes*.py tests/test_deploy_do_routes*.py tests/test_deploy_lan*.py tests/test_first_admin*.py`. Use `grep -l "teardown" sirdar/api/tests` to find the route tests touching teardown, and run them too. All pass.
- [ ] **Step 5: Commit** `feat(sirdar): start a cleanup for a never-deployed environment (API)`.

### Task 5: Web — the Clean up section, its dialog, and the first-admin prompt

**Files:**
- Create: `sirdar/web/src/pages/environments/CleanupModal.tsx` plus `CleanupModal.test.tsx`
- Modify: `DeploymentView.tsx` (+ its test), `labels.tsx` (mode label `cleanup` → "Clean up"; anywhere `teardown` is labeled, add cleanup), `sirdarApi.ts`, `FirstAdminCard.tsx` (+ test)

**Interfaces:**
- Consumes: `Environment.never_deployed: boolean`, `FirstAdmin.needs_password: boolean`, the API modes and codes (Task 4).
- Produces:
  - `CleanupModal({ env, keep, onStarted, onClose }: { env: Environment; keep: boolean; onStarted: (dep: Deployment) => void; onClose: () => void })`.
  - `keep` picks the mode: `cleanup` when true, `teardown` when false.

Behavior:
- **DeploymentView** shows the section only when all of these hold:
  - `isLatest === true`;
  - `env.never_deployed`;
  - `dep.mode` is `update` or `cleanup`;
  - `RETRYABLE.includes(dep.status)`;
  - the user `can('deploy', 'change')`.
- **Section content:**
  - The intro line, then two buttons with the spec's helper lines.
  - "Clean up and keep settings" is primary.
  - "Remove everything" uses the danger style that the Delete environment button uses.
  - Production that isn't retiring shows the hint "Mark this environment retiring in Settings first." and both buttons are disabled.
- **CleanupModal:**
  - Header pattern and rounded corners, like DeleteEnvironmentModal.
  - A name field, plus the production phrase field for production.
  - Host-key trust via `useHostKeyTrust`, as in DeleteEnvironmentModal.
  - It starts the deployment and hands it to `onStarted`. The view then follows it the way Retry hands over (`onRetried`).
  - No snapshot switch.
- **`sirdarApi.ts` messages:**
  - `cleanup_not_allowed`: "This environment has deployed before, so clean-up isn't offered. Use Delete environment in Settings."
  - `first_admin_password_needed`: "Enter the first admin's password again in Settings › First admin. The last attempt used it, and clean-up removed that admin with the data."
- **FirstAdminCard:** when `needs_password`, it shows open in Change mode with that sentence as its hint.

- [ ] **Step 1: Failing tests:**
  - DeploymentView: the section shows for the latest failed update when never deployed; hidden when `never_deployed` is false, not the latest, running, or for a teardown or publish deployment; shows for a failed cleanup.
  - CleanupModal: keep → POST mode `cleanup`; remove → mode `teardown`, `snapshot` not sent; name mismatch disables Start; production shows the phrase field; maps `cleanup_not_allowed` under the form.
  - FirstAdminCard: opens with the hint when `needs_password`.
- [ ] **Step 2: Run them**; expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/pages/environments src/lib` and `npx tsc --noEmit -p .`; all pass.
- [ ] **Step 5: Commit** `feat(sirdar-web): Clean up section on a failed first deploy (keep settings or remove everything)`.

### Task 6: Docs

**Files:** `sirdar/README.md` and/or `sirdar/api/README.md`. Extend the sections that describe Delete environment and the deploy modes; `grep -n "Delete environment\|teardown" sirdar/*.md sirdar/*/README.md`.

- [ ] **Step 1: Document:**
  - the Clean up section and when it shows;
  - the two choices;
  - production's rule;
  - the first-admin re-entry;
  - the SSH retry behavior (5 tries, 3 s; Ansible SSH retries 5) and its log line.
- [ ] **Step 2: Commit** `docs(sirdar): clean-up after a failed first deploy, SSH retries`.
