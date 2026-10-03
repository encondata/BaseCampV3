# Sirdar deploy phase 2 — codebase context and decisions

Companion to `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md`
(Sections 2–4) and the phase 1 plan `2026-10-02-deploy-stack-phase1.md`.
Paths: API = `sirdar/api/src/sirdar_api`, WEB = `sirdar/web/src`,
TESTS = `sirdar/api/tests`.

## Decisions (Jimmy, 2026-10-03)

- Targets get code from GitHub: `git clone`/`fetch` of
  `https://github.com/encondata/BaseCampV3.git` (public today; deploy keys when
  private — later). `main` is pushed (3dd8c98b).
- Root steps (Docker install, `/opt/serversherpa/<env>` creation) run with
  sudo using the target's saved write-only SSH password; key-only targets get
  an optional write-only `SUDO_PASSWORD` field in the saved-target store.
- First live use: **adopt** the hand-built `uat` env on target 10.10.48.63
  (`/opt/serversherpa/uat`, repo checkout at `repo/`, `.env` mode 600, seed in
  `seeds/`) without rebuilding — keep its DB, files, `.env` secrets, containers.
- Phase 2 is split: **2a backend** (this plan's scope) and **2b UI**.

## Controller decisions for 2a (defaults, flag if a reviewer objects)

- Execution: in-process `asyncio.create_task` per deployment with its own
  `get_sessionmaker()()` session; a module registry of running tasks; lifespan
  shutdown cancels them; startup marks orphaned `running` deployments/steps
  `interrupted`. One deployment per environment (DB-enforced).
- Progress to the browser: **polling** `GET /api/deploy/deployments/{id}`
  (deployment + steps + log tails). No SSE/WebSocket (Bearer auth; no precedent).
- Engine: `ansible-runner` (Python API, `ansible_runner.run_async` or
  `run` in a thread) + `ansible-core`, playbooks shipped in the image under
  `sirdar/api/src/sirdar_api/deploy/ansible/`. Host keys: a generated
  `known_hosts` file from the `ssh_known_hosts` table (pinned key) with
  `StrictHostKeyChecking=yes`; refuse unknown/mismatched hosts before any
  step (same `HostKeyUnknown`/`HostKeyMismatch` → 409 shapes as /connect).
  Password auth via `ansible_password`/`ansible_become_password` passed in
  runner `passwords`/extravars files written 0600 into a per-run
  `private_data_dir` under `SIRDAR_RUNNER_DIR` (default `/app/runner`), deleted
  after the run. Key files copied 0600 into the run dir (deploy-keys mount is
  read-only). `no_log: true` on every secret-bearing task; captured output is
  redacted (known secret values replaced with `[redacted]`) before storage.
- Steps (spec Section 2, steps 1–11; 12–14 are phase 4):
  1 preflight (OS, disk, memory, docker, sudo) · 2 bootstrap (docker + compose
  if missing, docker group, `/opt/serversherpa/<env>` owned by the SSH user) ·
  3 fetch code (clone if missing, fetch, checkout the resolved SHA) ·
  4 render config (write `.env` from the environment record + decrypted
  secrets; `STACK_IMAGE_TAG` = short SHA) · 5 build (`ss-stack build`) ·
  6 pre-deploy dump (`ss-stack dump`, last stdout line = path, recorded) ·
  7 reset data (Reset only: `ss-stack down --volumes`) · 8–11 collapse into
  `ss-stack up` (it already orders db → storage → migrate → api → web → status
  and waits on health) — record as steps "start data services" and "migrate +
  start app" only if ss-stack grows sub-commands; otherwise one step "up".
  Each step = one small playbook; `ss-stack` steps run it from
  `<env>/repo/deploy/stack/ss-stack <env-dir>` with long timeouts (up ≥ 30 min).
- Modes: **update** (default; steps 1–6, 8–11) and **reset** (1–5, 7, 8–11;
  no snapshot restore until phase 3 — reset = empty data; typed-name gate is
  UI work in 2b but the API requires `confirm_name == env name`).
- Rollback (spec): out of 2a except recording the pre-deploy dump path and the
  previous successful SHA on each deployment so 2b/phase 3 can offer it.
- Secrets: new `SIRDAR_SECRETS_KEY` (Fernet). Per-environment secrets
  (POSTGRES_PASSWORD, SPACES_SECRET_KEY, SS_JWT_SECRET, SS_TOTP_ENCRYPTION_KEY,
  SS_PASSWORD_PEPPER, SS_WIKI_SERVICE_TOKEN, optional SS_ANTHROPIC_API_KEY,
  SS_DB_TESTING_PASSWORD) stored encrypted in the DB; generated on create
  (hex 32 / Fernet), **imported** on adopt by reading the remote `.env`.
  Never returned by the API, never logged, never in audit `changes`.
- Adopt: `POST /api/deploy/environments` with `mode: "adopt"` reads the
  remote `<env-dir>/.env` over SSH, imports non-secret `STACK_*` values
  (domain, ports, proxy IP, bind IP, image tag) into the environment record and
  secrets into the encrypted store, records the current repo SHA as the
  environment's current SHA, and creates a synthetic `adopted` deployment
  record. No containers are touched.
- Permissions reuse `deploy`: view = list/read; add = create env, start
  update deployment; change = edit env, reset, cancel. No new resource.
- Environment `services` map (spec `environment_services`) is in scope as data
  (host IP, port, hostname per service) because `.env` rendering needs ports;
  DNS/NPM use is phase 4.

## Codebase facts the plan must follow

Backend
- App factory `API/api/app.py:54`; routers imported lazily (line 84) and
  registered at 87–95 under `APIRouter(prefix="/api")`; lifespan at 18–21 only
  disposes the engine. Custom 422 handler strips `input`/`ctx`.
- Routes: `router = APIRouter(prefix="/deploy", tags=["deploy"])`; async
  handlers; inline Pydantic models; errors `HTTPException(status,
  detail={"code": "snake_code", ...})`.
- Permissions: `actor: AuthContext = require_permission("deploy", "view")`
  (`API/api/deps.py:63`); `client_ip(request)` at `deps.py:74`.
- Audit: `API/services/audit.py:8` `audit(db, *, actor_id, action,
  entity_type, entity_id=None, ip=None, changes=None)` — sync add; caller
  commits. Names `deploy.<verb>`; never secrets in `changes`.
- DB: `API/db/engine.py` (`get_sessionmaker()`, `get_db`); models in
  `API/db/models.py` (`Base`, SQLAlchemy 2 `Mapped`, uuid PK
  `server_default=text("gen_random_uuid()")`, timestamptz `now()`, JSONB
  `'{}'::jsonb`). Job-model precedent: `ImportRun` (models.py:149–165).
- Migrations: hand-written raw SQL `op.execute`, folder
  `sirdar/api/migrations/versions/`, latest `0003` → next `0004`
  (`revision="0004"`, `down_revision="0003"`).
- Settings: `API/config.py:20` `Settings(BaseSettings)`, `env_prefix=SIRDAR_`,
  `frozen`, secrets `SecretStr | None` with `_blank_secret_is_none`;
  `get_settings()` lru_cached. New settings → `sirdar/.env.example`,
  `docker-compose.yml`, `install.sh` (`write_env`, re-run prompt list for new
  keys), README.
- Deploy package rules (`API/deploy/__init__.py`): never return/log a secret or
  raw library error; user-facing reasons are our own copy.
- SSH: `API/deploy/ssh.py` (`SshTargetConfig`, `test_connection`, pinned-key
  connect, `_run` = one line / 10 s — not usable for pipeline steps).
  TOFU: `API/deploy/known_hosts.py` (`lookup`, `fingerprint`,
  `HostKeyUnknown`, `HostKeyMismatch`). Target resolution:
  `targets.ssh_config_for(target_id, settings)` (ids `ssh` / `ssh:<slug>`).
  Saved-target store `API/deploy/ssh_targets.py` (dotenv, flock + atomic
  replace, write-only secrets, `public()`; new optional field must follow the
  same patterns incl. `SECRET_MAX`, Cc/Zl/Zp rejection, `*_set` booleans).
- Names: `API/deploy/names.py` (`CUSTOM_NAME_RE`, `RESERVED_NAMES`) — env
  names; consistent with ss-stack `STACK_ENV` regex.
- Dashboard: `API/dashboard/service.py:152` `build_dashboard` has hard-coded
  placeholders (lines 165–188) — 2b replaces them; 2a must not break them.

Tests
- Real Postgres (`sirdar-db` 127.0.0.1:5434), `TESTS/conftest.py`;
  **`SIRDAR_TABLES` TRUNCATE list (conftest.py:37) must include new tables**.
  Fixtures `client`, `db`; `api_helpers.auth_headers(client, db, roles=...)`.
  `asyncio_mode="auto"` — no `@pytest.mark.asyncio`.
- Fake SSH: `TESTS/ssh_server.py` real in-process asyncssh server, canned
  `OUTPUTS`, `overrides`, `delays`, `commands` recorder; user `deployer`,
  password `ssh-PW-secret-4242`; `ssh_settings(fake)`, `ssh_config(fake)`.
  Secret-leak guard pattern: `bodies` fixture in `test_deploy_api.py`.
- ansible-runner is not installed in the venv today; the engine must be
  testable with an injectable runner (fake that records playbook + extravars
  and emits canned events) plus one opt-in integration test against a real
  SSH container (`lscr.io/linuxserver/openssh-server` recipe from memory:
  127.0.0.1:2299, password auth).
- Run: from `sirdar/api`: `.venv/bin/pytest -q`; web: `npm --prefix
  sirdar/web test`. Ruff line-length 100.

Image
- `sirdar/Dockerfile` (context repo root): python:3.13-slim, uid 10001
  `sirdar`, no home, no apt packages. Needs: `openssh-client`, `sshpass`,
  pip `ansible-core` + `ansible-runner` (pinned), writable `HOME` and
  `SIRDAR_RUNNER_DIR` (`/app/runner`, new compose volume `./runner`, owned
  10001, mode 700), playbooks shipped with the package.
- Compose: `sirdar/docker-compose.yml`; `deploy-keys` mounted read-only;
  `./config` read-write.

ss-stack contract (`deploy/stack/ss-stack`)
- `ss-stack <build|up|down [--volumes]|ps|dump> <env-dir>`; exit 0 ok, 2
  usage, 1 die/other; messages `ss-stack: …` on stderr; `dump` prints only the
  dump path on stdout; `up` waits up to 300 s per stack.
- Env dir: `/opt/serversherpa/<env>/{.env,repo/,backups/}`; `.env` keys per
  `deploy/stack/env.example`.
