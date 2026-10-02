# Sirdar Deploy Step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a Deploy page that:
- lists the deployment targets (DigitalOcean and Custom SSH live; AWS and GCP coming soon);
- lets you pick a deployment type (Blue, Green, Dev, Beta);
- tests the connection using credentials from `.env`, with SSH host keys trusted on first use.

**Architecture:**
- New `sirdar_api.deploy` package with `settings`, `targets`, `digitalocean`, `ssh` and `known_hosts` modules.
- Routes under `/api/deploy`.
- Migration 0003 creates `ssh_known_hosts` and seeds the `deploy` grants.
- Sirdar web gets a `/deploy` page.
- Installer and compose gain the "Target deployment" settings and a `deploy-keys` mount.

**Spec:** `docs/superpowers/specs/2026-10-01-sirdar-groundwork-design.md`, the section "Addendum (2026-10-01): Deploy page, step 1". Read it first.

## Global Constraints
- **Where to work:** only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`).
- **Things to leave alone:**
  - Never cd into the main checkout.
  - Never run a bare `git stash`.
  - Never run `npm install` in `portal/`.
  - Never touch `serversherpa-dev`, the dev sirdar-db data (except through migrations), or ports 5434/8097/8098.
  - Clean up any containers you start.
- **Testing:** TDD. Run the suites in the foreground:
  - `cd sirdar/api && .venv/bin/pytest -q`
  - `npm --prefix sirdar/web test`
  - `cd sirdar/web && npx tsc -p tsconfig.json --noEmit`
- **Commits:** end messages with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **API conventions:** error bodies are `{"detail": {"code": "<code>", ...extra}}`. Routes live under `/api`.
- **Secrets:**
  - Never return or log the DO token, AWS secret, SSH password, key passphrase or key contents.
  - Never put them in audit `changes`.
  - Error text from libraries must be sanitized: no secrets, and no full exception reprs that may contain them.
- **Permissions:**

  | Resource `deploy` | Who gets it by default |
  |---|---|
  | view, add, change | developer, founder, super_admin |
  | view only | admin |

  | Action | What it allows |
  |---|---|
  | view | the page and `GET` routes |
  | add | connection tests |
  | change | trusting and forgetting host keys |
- **Copy:** American English. Use portal UI idioms (cards, segmented controls, `kv` lists, `mini-btn`, `DataTable`, the modal header pattern with an eyebrow).
- **Ledger:** record per-task Minor review findings in `.superpowers/sdd/progress.md` under a "Deploy step 1" heading.

---

### Task A: Settings, permission resource, migration 0003

**Files:**
- Modify: `sirdar/api/src/sirdar_api/config.py`
- Modify: `access/resources.py`, `access/defaults.py`
- Create: `migrations/versions/0003_deploy.py`
- Modify: `db/models.py` (add `SshKnownHost`)
- Modify tests: `tests/test_access.py` and anything asserting the resource list or count (e.g. `test_access_api.py` summary order)

**Requirements:**
1. **Settings.** Add these optional fields to `Settings` (all `SecretStr | None` for secrets, `str` / `int` otherwise):

   | Field | Type | Default |
   |---|---|---|
   | `deploy_do_token` | SecretStr | None |
   | `deploy_do_region` | str | "" |
   | `deploy_aws_access_key_id` | str | "" |
   | `deploy_aws_secret_access_key` | SecretStr | None |
   | `deploy_aws_region` | str | "" |
   | `deploy_gcp_project_id` | str | "" |
   | `deploy_gcp_credentials_file` | str | "" |
   | `deploy_gcp_region` | str | "" |
   | `deploy_ssh_host` | str | "" |
   | `deploy_ssh_port` | int | 22 |
   | `deploy_ssh_user` | str | "" |
   | `deploy_ssh_password` | SecretStr | None |
   | `deploy_ssh_key_path` | str | "" |
   | `deploy_ssh_key_passphrase` | SecretStr | None |
   | `deploy_keys_dir` | str | "/app/deploy-keys" |

   Env names follow the `SIRDAR_` prefix: `SIRDAR_DEPLOY_DO_TOKEN`, and so on.
   - Treat empty-string env values as None for the SecretStr fields. Add a `field_validator(mode="before")` that maps `""` to None.
   - Add a property `deploy_ssh_key_file -> str | None`: absolute paths as-is; bare names joined to `deploy_keys_dir`; empty gives None.
2. **Resource.** Register `Resource("deploy", "Deploy")` in `REGISTRY` between `settings` and `devtools`.
   - Add to `DEFAULT_GRANTS`: developer/founder/super_admin `FULL`, admin `("view",)`.
   - `restore_default_roles` keeps working.
3. **Migration 0003** (`down_revision="0002"`, hand-written SQL):
   - Insert the `deploy` role_permissions rows for the four default roles if those roles exist: `INSERT … SELECT … WHERE EXISTS`, idempotent with `ON CONFLICT DO NOTHING`.
   - Create table:
     ```sql
     CREATE TABLE ssh_known_hosts (
       id uuid PK default gen_random_uuid(),
       host text NOT NULL,
       port integer NOT NULL,
       key_type text NOT NULL,
       fingerprint_sha256 text NOT NULL,
       public_key text NOT NULL,
       trusted_by uuid,
       trusted_at timestamptz NOT NULL default now(),
       UNIQUE(host, port)
     );
     ```
   - Downgrade drops the table and deletes the `deploy` grants.
4. **Seed-snapshot test.** `test_migration_seed_matches_defaults` currently compares only 0001's frozen snapshot. Change it so `DEFAULT_GRANTS` equals 0001's GRANTS plus the deploy grants that 0003 adds. Have 0003 expose a `DEPLOY_GRANTS` dict constant to make this easy. The test must still fail if `defaults.py` drifts.
5. **Tests:**
   - `resolve_access` gives super_admin deploy view, add and change, and admin view only.
   - The access summary lists `deploy`.
   - The settings key-file property works for bare and absolute paths.

### Task B: Deploy services and API

**Files:**
- Create package `sirdar/api/src/sirdar_api/deploy/` with:
  - `__init__.py`
  - `targets.py` (target registry + configured detection + public summaries)
  - `digitalocean.py`
  - `ssh.py`
  - `known_hosts.py`
- Create `api/routes/deploy.py` and include it in `app.py`.
- Add `asyncssh>=2.14` to `pyproject.toml` dependencies, and move `httpx` from dev deps to dependencies. Run `.venv/bin/pip install -e '.[dev]'`.
- Tests:
  - `tests/test_deploy_targets.py`
  - `tests/test_deploy_digitalocean.py`
  - `tests/test_deploy_ssh.py`
  - `tests/test_deploy_api.py`

**Requirements:**
1. **Targets.** `TARGETS` lists ids `aws`, `gcp`, `digitalocean`, `ssh` with labels "AWS", "Google Cloud", "DigitalOcean", "Custom (SSH)".
   - `available`: built in this step. True for digitalocean and ssh, False for aws and gcp.
   - `configured`:

     | Target | Configured when |
     |---|---|
     | DigitalOcean | token set |
     | SSH | host and user set, plus a password or a key path |
     | AWS | key id and secret set |
     | GCP | project and credentials file set |

   - No summary or connection details in the public list (product owner decision 2026-10-01): `public_targets` returns `{id, label, available, configured}` only.

   - `DEPLOY_TYPES`:

     | id | label | description |
     |---|---|---|
     | blue | Blue | Production slot |
     | green | Green | Production slot |
     | dev | Dev | Development |
     | beta | Beta | External testing |

2. **DigitalOcean.** `async test_connection(settings, *, transport=None) -> ConnectResult` using `httpx.AsyncClient(base_url="https://api.digitalocean.com/v2", headers={"Authorization": f"Bearer {token}"}, timeout=15, transport=transport)`.
   - Calls:
     - `GET /account` → email, status, droplet_limit
     - `GET /droplets?per_page=1` → `meta.total`
     - if a region is configured, `GET /regions?per_page=200` → checks the slug exists and is available
   - **Errors:**

     | Condition | Result |
     |---|---|
     | 401 | `connect_failed`, reason "DigitalOcean rejected the API token." |
     | Network or timeout | `connect_failed`, reason "Couldn't reach the DigitalOcean API." |

   - Region missing or unavailable is a **warn** check, not a failure.
   - `ConnectResult` is a dataclass: `ok`, `target`, `checks: list[Check(label, status: 'pass'|'warn'|'fail', value)]`, `facts: dict` (non-secret).
   - Tests use `httpx.MockTransport` for success, 401, a missing region and a timeout.
3. **SSH.** Use asyncssh, with `async test_connection(settings, db) -> ConnectResult`.
   - **Host key fetch:** `asyncssh.get_server_host_key(host, port)` with a 15 s timeout. Compute the SHA256 fingerprint in OpenSSH format (`SHA256:<base64 no padding>`).
   - **known_hosts lookup by (host, port):**

     | Stored entry | Result |
     |---|---|
     | None | raise `HostKeyUnknown(host, port, key_type, fingerprint)` |
     | Fingerprint differs | raise `HostKeyMismatch(host, port, expected, actual, key_type)` |
     | Matches | connect with `asyncssh.connect(host, port=…, username=…, password=…, client_keys=[key] if key else None, passphrase=…, known_hosts=<asyncssh known hosts object built from the stored public key>)` |

     The connect step therefore pins the key; do not pass `known_hosts=None`.
   - **Checks.** Run each command with a timeout:

     | Check | Command | Status rule |
     |---|---|---|
     | OS | `. /etc/os-release && echo "$PRETTY_NAME"` | |
     | Kernel | `uname -srm` | |
     | Docker | `docker --version` | warn if missing |
     | Compose | `docker compose version` | warn if missing |
     | Disk | `df -Pk / \| tail -1` | free GB; warn under 10 GB |
     | Memory | `grep MemTotal /proc/meminfo` | warn under 2 GB |

   - **Errors** (all `connect_failed`):

     | Condition | reason |
     |---|---|
     | Auth failure (`asyncssh.PermissionDenied`) | "The SSH server rejected the username, password or key." |
     | Missing or unreadable key file | "The SSH key file <name> wasn't found in deploy-keys." (name only) |
     | Bad passphrase | "Couldn't unlock the SSH key (check the passphrase)." |
     | Network/DNS/timeout | "Couldn't reach <host>:<port>." |

   - **Tests:** start a real in-process asyncssh server in a fixture. Generate a host key, use password and public-key auth, and run a minimal process factory that answers the check commands with canned output. Cover:
     - unknown host → `HostKeyUnknown` with the right fingerprint
     - trust then connect → checks
     - mismatched stored key → `HostKeyMismatch`
     - wrong password → `connect_failed`
     - key auth works
     - a missing Docker output → warn
4. **known_hosts.** `trust(db, host, port, expected_fingerprint, actor_id)`:
   - re-fetches the live key;
   - if the live fingerprint differs from `expected_fingerprint`, raises `HostKeyChanged` → 409 `host_key_changed`;
   - upserts the row and audits `deploy.host_trust`.

   Also provide `forget(db, host, port, actor_id)` (audits `deploy.host_forget`) and `list(db)`.
5. **Routes** (`/api/deploy`):

   | Route | Permission | Behavior |
   |---|---|---|
   | `GET /targets` | deploy:view | `{targets:[{id,label,available,configured}], types:[…]}` |
   | `POST /connect` `{target, type}` | deploy:add | see below |
   | `GET /known-hosts` | deploy:view | `[{host, port, key_type, fingerprint, trusted_at, trusted_by_name}]` |
   | `POST /known-hosts` `{host, port, fingerprint}` | deploy:change | Only the configured SSH host and port may be trusted, else 400 `not_configured_host` |
   | `DELETE /known-hosts?host=&port=` | deploy:change | 204, or 404 `not_found` |

   `POST /connect` behavior:
   - Unknown target or type → 422.
   - aws/gcp → 400 `target_unavailable`.
   - Not configured → 400 `target_not_configured`.
   - Success → 200 `{ok, target, type, checks, facts}`.
   - `HostKeyUnknown` → 409 `{code:"host_key_unknown", host, port, key_type, fingerprint}`.
   - `HostKeyMismatch` → 409 `{code:"host_key_mismatch", host, port, key_type, expected, actual}`.
   - `connect_failed` → 502 `{code:"connect_failed", reason}`.
   - Every attempt audits `deploy.connect` with `{target, type, ok, code?}`.
6. **Route tests:**
   - permissions: admin can GET but gets 403 on connect and trust;
   - the API never echoes secrets: assert the token and password strings are absent from every response body in the tests;
   - the full TOFU flow via the in-process SSH server.

### Task C: Web — Deploy page

**Files:**
- Create: `sirdar/web/src/pages/Deploy.tsx`, `sirdar/web/src/components/HostKeyModal.tsx`
- Modify:
  - `lib/sirdarApi.ts` (types + calls + MESSAGES for the new codes)
  - `layout/sirdarNav.tsx` (new section "Deployments" with item "Deploy" → `/deploy`, resource `deploy`, placed after Dashboard; PAGE_TITLES)
  - `App.tsx` (route `/deploy` wrapped in `<Gate resource="deploy">`)
- Tests: `pages/Deploy.test.tsx`, `components/HostKeyModal.test.tsx`

**Requirements:**
1. **Layout.** Eyebrow "Deployments", title "Deploy", lead "Pick where and what kind of environment to deploy. This step tests the connection; deploying the apps comes next." Then three stacked sections:
   1. **Target.** Four cards in a grid:
      - icon/initials and label only. Cards show no connection details (host, user, port, region, auth method): product owner decision 2026-10-01;
      - a status chip: "Ready" (configured + available), "Not configured" (available) or "Coming soon" (aws/gcp, disabled);
      - selectable by click or keyboard: `role="radio"` in a `radiogroup`.
      - When a not-configured target is selected, show which `.env` keys to set (names only, e.g. `SIRDAR_DEPLOY_DO_TOKEN`) and "then re-run the installer".
   2. **Deployment type.** Segmented control (radio semantics) with Blue, Green, Dev and Beta, each with its description underneath.
   3. **Connect.** Button "Test connection", enabled only with a configured target, a type and `can('deploy','add')`.
      - While running: "Connecting…".
      - Results panel with a pass/warn/fail chip per check (label, value), facts as a `kv` list, and the target, type and time.
      - Errors are shown inline (`role="alert"`) using MESSAGES and the `reason`.
2. **Host-key flow.**
   - **On `host_key_unknown`:** open `HostKeyModal`. Header: eyebrow "SSH", title "Trust this server?", description "First time connecting to host:port. Check this fingerprint with the server's administrator before trusting it." Body: the key type and fingerprint in mono. Buttons "Cancel" and "Trust and connect" (needs deploy:change; otherwise explain who can). Trusting POSTs known-hosts, then re-runs the connect automatically. On `host_key_changed`, show "The server's key changed while you were looking. Try again."
   - **On `host_key_mismatch`:** an alert panel, "This server's key doesn't match the one Sirdar trusted. Connection refused.", with the expected and actual fingerprints. If the user has deploy:change, offer "Forget the old key" (confirm dialog, then DELETE), after which the next test shows the trust modal again.
3. **Known hosts.** Below the connect panel, a "Trusted SSH hosts" `DataTable` (host:port, key type, fingerprint, trusted by/at) with "Forget" for deploy:change. Empty state: "No hosts trusted yet."
4. **Tests:** jsdom with the API mocked.
   - Cards render with the right chips.
   - aws/gcp are disabled.
   - Connect is disabled until target + type are chosen.
   - Success renders checks.
   - `host_key_unknown` opens the modal, and trusting calls trust then connect again.
   - The mismatch panel offers forget only with deploy:change.
   - An admin (view only) sees the page but the button is disabled with a note.

### Task D: Env, compose and installer

**Files:**
- Modify: `sirdar/.env.example`, `sirdar/docker-compose.yml`, `sirdar/install.sh`, `sirdar/README.md`
- Create: `sirdar/deploy-keys/.gitkeep`

**Requirements:**
1. **`.env.example`.** Add a commented "Target deployment" section with every key from the spec, each with a one-line comment (where to get a DO token, key file location, etc.). Values are blank, except `SIRDAR_DEPLOY_SSH_PORT=22`.
2. **compose.** Mount `${SIRDAR_DEPLOY_KEYS_DIR:-./deploy-keys}:/app/deploy-keys:ro` on the `sirdar` service. The relative path is relative to the compose file directory.
   - Ignore key files in git: `sirdar/deploy-keys/*` with `!.gitkeep` in `sirdar/.gitignore`.
   - The Dockerfile already creates `/app`; make sure the container user can read mounted keys (document `chmod 600` + matching uid caveat in README). Note that the container runs as uid 10001.
3. **Installer.**
   - **First install:** after the existing prompts, ask "Configure deployment targets now? [y/N]".
     - **Yes:** prompt DigitalOcean (token hidden, Enter = skip; region, Enter = skip), then Custom SSH (host, Enter = skip; if a host is given then port [22], user, password hidden with Enter = none, key file name, Enter = none). For the key file name, validate that the file exists in `<dir>/sirdar/deploy-keys/` and warn if not.
     - **No:** write the deploy keys blank.
   - Create `<dir>/sirdar/deploy-keys` (mode 700) on every run.
   - **Re-run:** add the deploy keys to the new-settings list as a GROUP. If any are absent, ask the same yes/no once. Yes runs the prompts; no appends them blank. Either way they're then present, so it's never asked again.
   - Never echo secrets.
   - Summary rows show "set"/"blank" for secrets.
4. **README.** "Deployment targets" section: the keys, putting a key in `deploy-keys/` with chmod 600, `chown 10001` or making it readable by the container user, and the TOFU flow.
5. **Verify:**
   - `bash -n` + `shellcheck`.
   - `SIRDAR_INSTALL_LIB` + `SIRDAR_TTY` tests: yes-path, no-path and the re-run group path.
   - `docker compose config` shows the mount.

### Task E: Live verification (controller)
1. Start Sirdar from the worktree (temp `-wt` launch entries; remove after) with a test SSH server container as the Custom target, e.g. `linuxserver/openssh-server` with password auth on a free port. Set the `SIRDAR_DEPLOY_SSH_*` vars in the worktree's `sirdar/.env` temporarily and restore afterwards.
2. In the browser:
   - Deploy page → Custom (SSH) → Dev → Test connection;
   - trust modal → trust → results;
   - forget → modal again;
   - change the server's host key (recreate the container) → mismatch panel.
3. DigitalOcean with a bogus token gives a clean "rejected the API token" error. A real token is tested later on Tower by the product owner.
4. Run all suites. Clean up the containers and env changes.
