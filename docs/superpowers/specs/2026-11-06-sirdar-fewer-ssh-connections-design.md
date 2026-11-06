# Sirdar: fewer SSH connections per deploy

Date: 2026-11-06. Branch: `sirdar` (at main 9cfb4113 + 9ba51c41).

## Why

DigitalOcean deploys from the office never get past step 0. Measured 2026-11-06:
- From the office (Tower and the Mac), a few SSH connections to a droplet succeed. After that, new connections to that address time out for a while.
- From another droplet, 25 rapid connections to the same address all succeed.
- A single connection from a terminal always works.

So something between the office and DigitalOcean limits how many new SSH connections can be made to one address in a short time. The droplets refuse nothing (their sshd logs are clean).

A deploy opens far more than that:
- **Ansible** runs with `ControlMaster=no`, `ControlPersist=no` and `ANSIBLE_PIPELINING=False`. Every task opens several connections (temp dir, copy module, run, clean up), and gathering facts opens more. That's hundreds per deploy.
- **Sirdar's own commands** (`ssh.run_command`) open two connections each: one to fetch and compare the host key, one to log in.
- **Each Ansible step's preparation** (`pipeline._run_target`) opens one to fetch the host key.
- **Step 0's loops** (`confirm_pin`, the cloud-init/psql wait, the /healthz wait) open new connections every time round.

Jimmy chose this fix (2026-11-06): "build option 2, fewer SSH connections". The office-side limit is being looked at separately.

## Goal

A deploy opens about **one SSH connection per server for Ansible and one for Sirdar's own commands**, held for the whole deployment, instead of a new one for every command. The connection retries from 049dea0d (5 tries, 3 s apart; Ansible retries 5) stay as they are for when a connection does have to be made.

## Non-goals

- A second SSH port on droplets.
- Changing which commands run, or their order.
- The connection test (Test button) and the host-key trust flow. They stay one-off connections.

## Anti-goals

- Weakening host-key pinning. Every connection, new or reused, is to a host whose live key matches the pinned one. A reused connection was verified when it was made.
- A connection, or an Ansible control socket, that outlives its deployment. Everything opened for a deployment is closed when the deployment ends, whether it succeeds, fails or is cancelled, and when Sirdar shuts down.
- Secrets in new places. Control sockets live in a private (mode 700) directory, and nothing new is logged.

## A. Ansible reuses one connection per host

- In `runner.py`'s SSH args, replace `ControlMaster=no` and `ControlPersist=no` with:
  - `ControlMaster=auto`;
  - `ControlPersist` long enough to bridge the gap between steps. **My call: 15 minutes.** The deployment closes the masters itself when it ends (below), so the timeout only matters if Sirdar dies.
  - `ControlPath` in a per-deployment private directory.
- **The socket path must stay short.** Unix socket paths are limited to about 104 characters. Use a short directory, for example under `/tmp` via `tempfile.mkdtemp(prefix="sc-")`, mode 700, and `%C`, which hashes host, port and user. **Add the pinned key's fingerprint to the socket name** (a short hex of it, as literal text in the path). That way a re-pinned host never reuses a master made under the old key.
- **The control directory belongs to the deployment, not to one Ansible run.** `pipeline._run` creates it before the first step and passes it to the runner, through `RunRequest` or the runner's construction (builder's choice). In its `finally`, it ends every master (`ssh -O exit -o ControlPath=…` for each socket, or killing the master processes) and removes the directory.
- **`ANSIBLE_PIPELINING=True`.** Ansible then sends each module over the open connection instead of copying files first. The playbooks use `become` with a sudo password (`ansible_become_password`). Ansible supports that with pipelining as long as sudo doesn't require a TTY, which is the default on Ubuntu. The live check below confirms it on the VM and droplet images.
- `ANSIBLE_SSH_RETRIES=5`, `ConnectTimeout=15` and the other existing options stay.

## B. Sirdar's own commands share one connection per host

- **A per-deployment connection pool in `ssh.py`.** It's keyed by (host, port, user, pinned fingerprint) and holds one open `asyncssh` connection per key. `pipeline._run` opens it as an async context manager around the whole deployment and closes every connection in its `finally`.
  - It reaches the code that runs commands through a `contextvars.ContextVar`, so the call sites (`run_command`, `_ssh_remote`, `gitref.resolve_ref`, the health and backup helpers) keep their signatures.
  - **Outside a pool**, for example the Test button, Adopt or the backups list, `run_command` behaves exactly as today, except for the next point.
- **One connection instead of two.** When a host key is stored for the host, log in directly with `known_hosts` pinned to the stored key.
  - Only when that login fails with `HostKeyNotVerifiable` does Sirdar fetch the live key, so it can raise `HostKeyMismatch` with both fingerprints, as today.
  - When no key is stored, raise `HostKeyUnknown` without connecting, apart from the fetch that reports the live fingerprint. Builder's choice whether that fetch stays; the UI needs the fingerprint to offer Trust.
- **Reuse and reconnect.**
  - A pooled connection is reused while it's open. If a command fails because the connection dropped (`asyncssh` connection lost, `OSError`), the pool discards it. The *next* command reconnects, with the 5-try retry.
  - A command whose connection dropped mid-run is **never re-run**, because it may have run. It returns the same `exit_status None` as today.
- **`pipeline._run_target`** uses the pool's connection: getting or making it is the host-key check. So an Ansible step no longer opens a separate connection to check the key.
- **Step 0's waiting loops** (cloud-init/psql ready, `/healthz`) reuse the pooled connection on each round instead of reconnecting.
  - `vmcommon.confirm_pin` still fetches the key until SSH answers, because nothing is pinned yet. Once it pins, that's the last separate connection to that host.

## C. Logging

- The existing retry line ("Couldn't reach …; trying again (n of 5).") still shows when a connection has to be made again.
- When a pooled connection drops and the next command reconnects, add one line: "Lost the SSH connection to {host}; reconnecting." That way a flaky network stays visible.

## Testing

- **Runner:**
  - the env has `ControlMaster=auto`, the 15-minute `ControlPersist`, a `ControlPath` inside the deployment's control directory that's under 100 characters, and `ANSIBLE_PIPELINING=True`;
  - the control directory is mode 700;
  - closing the deployment's control directory ends masters and removes it.
- **Pool, against the existing test SSH server:**
  - two `run_command`s in one pool use one connection (count accepted connections);
  - outside a pool, one `run_command` opens one connection, not two;
  - a mismatched key still raises `HostKeyMismatch` with both fingerprints, and an unknown host still raises `HostKeyUnknown`;
  - after the server drops the connection, the next command reconnects and logs the reconnect line;
  - a command whose connection dropped isn't re-run;
  - different pinned fingerprints never share a connection;
  - the pool closes everything on exit, including on an exception and on cancel.
- **Pipeline:** `_run` opens and closes the pool and the control directory around a deployment, including a failed one and a cancelled one.
- **Live (Tower):**
  - Retry rc1 on DigitalOcean from the office and confirm step 0 and the rest pass.
  - Count SSH connections per droplet during the run from the droplet's sshd log (`journalctl -u ssh | grep -c "Accepted publickey"`), and record the number in the merge notes.
  - Deploy demo (ESXi) as a regression check of Ansible's `become` with pipelining.

## Left to the builder

- How the control directory reaches the runner (`RunRequest` field or runner state).
- How masters are ended (`ssh -O exit` per socket, or tracking the master processes).
- Whether `HostKeyUnknown` still fetches the live key, and how.
