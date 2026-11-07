# Fewer SSH Connections per Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deploy makes about one SSH connection per server for Ansible and one for Sirdar's own commands, held for the whole deployment.

**Architecture:**
- **Sirdar's own commands:** `ssh.run_command` logs in once, pinned to the stored key, instead of fetching the key first. Inside a per-deployment `SshPool` (published through a `ContextVar`), it reuses one `asyncssh` connection per (host, port, user, fingerprint).
- **Ansible:** the runner uses `ControlMaster=auto`, a 15-minute `ControlPersist` and pipelining, with control sockets in a per-deployment private directory.
- **Lifecycle:** `pipeline._run` opens both around the deployment and closes them in `finally`.

**Tech Stack:** Python 3.13, asyncssh, ansible-runner, pytest (async), the in-process `tests/ssh_server.py`.

**Spec:** `docs/superpowers/specs/2026-11-06-sirdar-fewer-ssh-connections-design.md`

## Global Constraints

- Every connection, new or reused, is to a host whose live key matched the pinned one. Never weaken pinning.
- Nothing opened for a deployment outlives it: success, failure, cancel, or Sirdar shutting down.
- Control sockets go in a mode-700 directory, and each `ControlPath` stays under 100 characters.
- A command whose connection dropped mid-run is never re-run. It returns `CommandResult(None, "")`.
- The existing retries stay: `CONNECT_TRIES=5`, `CONNECT_RETRY_DELAY=3.0`, `ANSIBLE_SSH_RETRIES=5`, `ConnectTimeout=15`.
- New log copy, exactly: `Lost the SSH connection to {host}; reconnecting.\n`
- `ControlPersist=15m` (spec, my call).
- `test_connection` (the Test button) and `known_hosts.trust` stay one-off connections.
- American English. Commit attribution: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `cd sirdar/api && SIRDAR_TEST_DB=<unique name> .venv/bin/python -m pytest <files>`.

## Review Focus

1. **A pooled connection that dropped between steps.** The next command reconnects (with retries) and logs the reconnect line. It doesn't fail the step. Pinned in Task 2.
2. **A re-pinned host mid-deployment,** for example after Clean up and a recreated droplet at the same address. The old connection or master must not be reused. The fingerprint is part of the pool key and of the socket name. Pinned in Tasks 2 and 3.
3. **A cancelled deployment.** The pool and the masters are closed and the control directory is removed. Pinned in Task 4.
4. **`become` with a sudo password under pipelining.** Tests can't run real sudo, so this is checked live in Task 5 (demo on ESXi plus rc1).
5. **An unknown host outside a pool,** such as Adopt or the backups list. It still raises `HostKeyUnknown` with the live fingerprint, so the UI can offer Trust. Pinned in Task 1.

---

### Task 1: one connection per `run_command`

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/ssh.py` (`run_command`, a new `_login_pinned`)
- Modify: `sirdar/api/tests/ssh_server.py` (count accepted connections)
- Test: `sirdar/api/tests/test_deploy_ssh.py`

**Interfaces:**
- Produces: `async def open_pinned(cfg: SshTargetConfig, db: AsyncSession, *, tries: int = CONNECT_TRIES, log=None) -> tuple[asyncssh.SSHClientConnection, PinnedHost]`. It logs in with the stored key pinned, retrying with `with_connect_retry`. With no stored key it raises `HostKeyUnknown` (with the live fingerprint). When the login fails with `HostKeyNotVerifiable`, it fetches the live key and raises `HostKeyMismatch(host, port, stored, actual, key_type)`. `ConnectFailed` is unchanged.
- `FakeSshServer.connections: int`, which counts accepted TCP connections, including bare host-key fetches.

- [ ] **Step 1: Write the failing tests** in `test_deploy_ssh.py`, using the existing trusted-server fixtures:
  - `test_run_command_opens_one_connection`: after trusting the server, one `run_command(..., "uname -srm")` leaves `server.connections == 1`.
  - `test_run_command_mismatch_still_names_both_fingerprints`: the stored key differs from the served one, so the call raises `HostKeyMismatch` with `.expected` set to the stored fingerprint and `.actual` set to the live one.
  - `test_run_command_unknown_host_raises_with_live_fingerprint`: nothing is stored, so the call raises `HostKeyUnknown` whose `.fingerprint` equals the server's.
- [ ] **Step 2:** Run them. Expect the first to fail with `connections == 2`.
- [ ] **Step 3:** Implement `open_pinned`, and make `run_command` use it. Build a `PinnedHost` from the stored row (`asyncssh.import_public_key(stored.public_key)`). Fetch the live key only for the unknown and mismatch cases. Keep `pinned_host_key` for its other callers.
- [ ] **Step 4:** Run `tests/test_deploy_ssh.py tests/test_deploy_ssh_retry.py tests/test_deploy_gitref*.py`. All pass.
- [ ] **Step 5: Commit** `feat(sirdar): run_command logs in once, pinned, instead of fetching the host key first`.

### Task 2: the per-deployment `SshPool`

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/ssh.py`
- Test: `sirdar/api/tests/test_deploy_ssh_pool.py` (new)

**Interfaces:**
- Consumes: `open_pinned` (Task 1).
- Produces:
  - `class SshPool`: an async context manager. `__aexit__` closes every connection and awaits `wait_closed`, also on exceptions and cancellation.
  - `async def SshPool.connection(cfg, db, *, tries=CONNECT_TRIES, log=None) -> tuple[asyncssh.SSHClientConnection, PinnedHost]`: returns the open connection for the key (host, port, user, fingerprint of the stored key), or opens one with `open_pinned`. When it replaces a connection it had for that key and lost, it first logs `Lost the SSH connection to {host}; reconnecting.\n` through `log`. A fingerprint change gives a new key, so a new connection.
  - `def SshPool.discard(conn) -> None`.
  - `current_pool: ContextVar[SshPool | None]`, defaulting to None.
  - `def using_pool(pool) -> contextlib.AbstractContextManager`: sets and resets `current_pool`.
- `run_command`: when `current_pool.get()` is set, it uses `pool.connection(...)` and doesn't close the connection afterwards. On `OSError`, `asyncssh.ConnectionLost` or `asyncssh.DisconnectError` during `conn.run`, it calls `pool.discard(conn)` and returns `CommandResult(None, "")`, never re-running the command. On a plain timeout, it keeps the connection.

- [ ] **Step 1: Write the failing tests:**
  - `test_pool_reuses_one_connection`: inside `SshPool()` with `using_pool`, two `run_command`s leave `server.connections == 1`.
  - `test_pool_reconnects_after_drop_and_logs`: close the server-side connection between two commands. The second succeeds, `connections == 2`, and the log holds the exact reconnect line.
  - `test_dropped_command_is_not_rerun`: the server drops the connection while command X runs (use a delay override). The result is `exit_status None`, and `server.commands.count(X) == 1`, even after a later command on the pool.
  - `test_new_fingerprint_gets_new_connection`: re-trust the host with another key mid-pool. The next command opens a new connection.
  - `test_pool_closes_on_exit_and_cancel`: a task inside the pool is cancelled, and every connection is closed afterwards (the server sees them close).
  - `test_outside_pool_unchanged`: with no pool set, two commands give `connections == 2`.
- [ ] **Step 2:** Run them. They fail with an ImportError for `SshPool`.
- [ ] **Step 3:** Implement the pool, the context variable and the `run_command` branch.
- [ ] **Step 4:** Run the new file plus `test_deploy_ssh.py` and `test_deploy_ssh_retry.py`. All pass.
- [ ] **Step 5: Commit** `feat(sirdar): a per-deployment SSH connection pool`.

### Task 3: Ansible shares one connection per host

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/runner.py`
- Test: `sirdar/api/tests/test_deploy_runner.py`

**Interfaces:**
- Produces:
  - `class ControlDir`, a context manager. `ControlDir.open() -> ControlDir` makes `tempfile.mkdtemp(prefix="sc-")` (mode 700, under `/tmp` so paths stay short).
  - `.path: Path`.
  - `def control_path(self, fingerprint: str) -> str`, which returns `f"{path}/%C-{short}"`, where `short` is the first 12 hex characters of `sha256(fingerprint)`.
  - `def close(self) -> None`: for each socket in the directory, runs `ssh -O exit -o ControlPath=<socket> x` with a short timeout and ignores failures, then removes the directory.
  - `RunRequest.control_dir: ControlDir | None = None`.
- `envvars` with a control dir: `-o ControlMaster=auto -o ControlPersist=15m -o ControlPath=<control_path(fingerprint of target)>` and `ANSIBLE_PIPELINING=True`. Without one (tests, one-off runs), keep today's `ControlMaster=no` / `ControlPersist=no`, with pipelining on in both cases. `RunTarget` needs the fingerprint: add `fingerprint: str` (pipeline fills it from `PinnedHost.fingerprint`).

- [ ] **Step 1: Write the failing tests.**
  - Update the existing env assertions (lines ~145–151): `ANSIBLE_PIPELINING == "True"`.
  - Add `test_envvars_with_control_dir`, which checks the three options and that the expanded `ControlPath` length is under 100 characters with a 40-character `%C`.
  - Add `test_control_dir_is_private_and_removed`, which checks mode `0o700` and that the directory is gone after `close()`.
  - Add `test_control_path_differs_by_fingerprint`.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/test_deploy_runner.py`. If `ansible-playbook` is installed, also run `SIRDAR_RUNNER_E2E=1` with `tests/test_runner_e2e.py` (read its header for the switch). Pass.
- [ ] **Step 5: Commit** `feat(sirdar): Ansible reuses one SSH connection per host (ControlMaster, pipelining)`.

### Task 4: the deployment owns the pool and the control directory

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py` (`_run`, `_run_target`, `_run_step`, `RunTarget` construction)
- Test: `sirdar/api/tests/test_deploy_pipeline.py` (plus DO and VM pipeline tests if fixtures need it)

**Interfaces:**
- Consumes: `SshPool`, `using_pool` (Task 2), `ControlDir`, `RunRequest.control_dir`, `RunTarget.fingerprint` (Task 3).
- `_run`: wrap everything after loading the deployment in `async with SshPool() as pool, ...` plus `using_pool(pool)`, and a `ControlDir.open()` closed in `finally`. Keep it on the context so `_run_step` passes `control_dir=` on each `RunRequest`. Close on success, failure, `CancelledError` and the shutdown interrupt.
- `_run_target`: when a pool is current, get the host key from `pool.connection(cfg, db)` (which is the key check) instead of `pinned_host_key`, and keep the same `PrepareError` copy for unknown, mismatch and unreachable. Fill `RunTarget.fingerprint`.

- [ ] **Step 1: Write the failing tests:**
  - `test_run_opens_and_closes_pool_and_control_dir`: patch `ssh.SshPool` and `runner.ControlDir` with recording fakes. After a successful fake deployment, both were entered and closed, and every `RunRequest` the fake runner got had the same `control_dir`.
  - The same for a failed step and for a cancelled run (reuse the existing cancel test's pattern).
  - `test_run_target_uses_pool_connection`: inside a pool, `_run_target` makes no separate connection (`server.connections == 1` after `_run_target` plus one `run_command`).
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/test_deploy_pipeline*.py`, `tests/test_deploy_ssh*.py` and `tests/test_deploy_runner.py`. Pass.
- [ ] **Step 5: Commit** `feat(sirdar): each deployment holds one SSH pool and one Ansible control dir`.

### Task 5: README and live verification (controller)

- [ ] Update `sirdar/README.md`'s "Connection retries" paragraph: a deployment keeps one connection per server, Ansible shares one per host, and the reconnect line.
- [ ] Run the full API suite and the web suite.
- [ ] Merge to main and push only after Jimmy says so (ask). Update Tower. Retry rc1 from step 0. Count `Accepted publickey` lines per droplet in `journalctl -u ssh`. Deploy demo as a regression check of `become` with pipelining. Record the results in the merge notes.
