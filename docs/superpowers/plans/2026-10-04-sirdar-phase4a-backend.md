# Sirdar deploy phase 4a (DNS + proxy: backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Sirdar publish an environment on its own: Cloudflare A records and Nginx Proxy Manager proxy hosts (with Let's Encrypt certificates) for every public service, a smoke test of the public URLs after each deploy, claiming of hand-made records, Delete environment that tears down only what Sirdar created, and write-only integration credentials with Test buttons.

**Architecture:** Two HTTP clients (`deploy/cloudflare.py`, `deploy/npm.py`) and a smoke checker (`deploy/smoke.py`), each taking an injectable `httpx` transport. `deploy/publish.py` plans per service against `managed_records` (pure status functions), applies the plan as pipeline steps 12–14 (and removes it as steps 16–17), and serves the Publish tab's inspection and Claim. Credentials live in a new `integrations` table, encrypted with the existing vault. The pipeline learns Python steps (`StepDef.runs`), two modes (`publish`, `teardown`) and a per-deployment `publish` flag; step 15 is a new playbook `teardown.yml`.

**Tech Stack:** FastAPI, SQLAlchemy 2 async + asyncpg, Alembic (raw SQL), httpx (`AsyncClient`, `MockTransport`), ansible-core 2.21.4 + ansible-runner 2.4.3, pytest on real Postgres.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` (Architecture, Sections 2–5), with the binding decisions in `docs/superpowers/plans/2026-10-04-sirdar-phase4-context.md`. The UI is plan 4b (`docs/superpowers/plans/2026-10-04-sirdar-phase4b-ui.md`), which uses exactly the shapes under "API produced for 4b".

## Global Constraints

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it. `sirdar` is both a branch and a folder: use `--` in `git diff`/`git log` (`git log -- sirdar/`).
- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"` (never add `@pytest.mark.asyncio`). New and changed files must pass `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` (`All checks passed!`).
- Migration number is **0006** (`revision = "0006"`, `down_revision = "0005"`). Before writing it, check: `ls /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/*/sirdar/api/migrations/versions/ | sort | tail -3` shows nothing above 0005, and `docker exec $(docker ps -qf name=sirdar-db) psql -U sirdar -d sirdar -tAc 'select version_num from alembic_version'` prints `0005`. If either shows 0006, stop and ask the controller.
- Steps (number, key, name, runs): 12 `dns` "DNS records" python; 13 `proxy` "Proxy hosts" python; 14 `smoke` "Smoke test" python; 15 `teardown` "Remove environment" ansible (`teardown.yml`); 16 `unproxy` "Remove proxy hosts" python; 17 `undns` "Remove DNS records" python.
- Plans: a deployment with `publish = true` in mode update / reset / restore_dump / rollback (with or without a restore) appends 12, 13, 14. Mode `publish` = 12, 13, 14. Mode `teardown` = 15, 16, 17. Numbers rise in every plan.
- `publish` and `snapshot` deployments never change the environment's `status`, `current_sha` or `image_tag`. A `teardown` deployment sets the status to `deleting`; on success the pipeline audits `deploy.environment_delete` and deletes the environment row.
- Sirdar edits or deletes only what `managed_records` lists for the environment. Only `origin = "created"` entries are ever deleted from Cloudflare or NPM; `claimed` ones are forgotten and left in place. A step with any blocker (claimable or conflicting entry) changes nothing and fails.
- Every create in Cloudflare or NPM is recorded in `managed_records` at once, in its own committed transaction.
- Credentials (Cloudflare token, NPM password) never appear in an API response, a log line, an audit `changes`, an exception message, a `repr()` or a stored step log. Errors are our own copy, never library or upstream text.
- Every outbound HTTP call goes through an `httpx.AsyncClient` built with a `transport` argument; `outbound.transports()` is the single switch tests replace. Tests never reach the real Cloudflare or NPM: the conftest guard fails any request through `httpx.AsyncHTTPTransport`.
- Errors: `HTTPException(status, detail={"code": "snake_code", ...})`.
- Permissions reuse `deploy`: `view` = read integrations and the Publish tab; `add` = Update and Publish deployments; `change` = save / remove / test integrations, Claim, the `publish` switch (PATCH), Delete environment and its retry (`confirm_name` = the environment's name). Every successful mutation writes one audit row named `deploy.<verb>`.
- American English in all copy, comments and docs. Display copy "Canceled"; the status value stays `cancelled`.
- Never commit `sirdar/.env`. No `npm install` in this worktree.

## Working environment

- Sirdar's dev database must be running. From the main checkout: `cd /Users/jrh1812/Developer/BaseCampV3 && docker compose -f docker-compose.dev.yml up -d sirdar-db` (Postgres on 127.0.0.1:5434).
- Every Sirdar test command runs from `sirdar/api` in the worktree: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api`, then `SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/<file>`. The conftest creates that database; Task 12 drops it. Never point tests at the dev `sirdar` database.
- The dev `sirdar/.env` is read by `Settings`; tests override with `monkeypatch.setenv` (an env var beats the file).

## API produced for 4b

All under `/api/deploy`. Times are ISO 8601 strings.

- `Integrations` = `{secrets_key_configured: bool, cloudflare: {configured: bool, zone: str|null, public_ip: str|null, token_set: bool, updated_at: str|null, updated_by_name: str|null}, npm: {configured: bool, url: str|null, identity: str|null, letsencrypt_email: str|null, password_set: bool, updated_at: str|null, updated_by_name: str|null}}`.
- `GET /integrations` (view) → `Integrations`.
- `PUT /integrations/cloudflare` (change) body `{zone, public_ip, token?}` (`token` omitted or null = keep the stored one) → `Integrations`. Errors: 422 `zone_invalid`, `public_ip_invalid`, `token_invalid`, `secret_required`; 400 `secrets_key_missing`.
- `PUT /integrations/npm` (change) body `{url, identity, letsencrypt_email?, password?}` (blank `letsencrypt_email` = the login email) → `Integrations`. Errors: 422 `npm_url_invalid`, `identity_invalid`, `letsencrypt_email_invalid`, `password_invalid`, `secret_required`; 400 `secrets_key_missing`.
- `DELETE /integrations/{kind}` (change) → 204. Errors: 404 `integration_not_found`; 422 for an unknown kind.
- `POST /integrations/{kind}/test` (change), optional body = the PUT body (unsaved values; a missing secret means the stored one) → `ConnectResult` `{ok: true, target: kind, checks: [{label, status: "pass"|"warn"|"fail", value}], facts: {...}}`. Errors: 409 `integration_not_configured`; 409 `integration_unreadable`; 400 `secrets_key_missing`; 502 `connect_failed {reason}`; the PUT validation codes.
- `PublishState` = `{publish: bool, proxy_ip: str, cloudflare: {configured: bool, zone: str|null, public_ip: str|null, error: str|null}, npm: {configured: bool, url: str|null, error: str|null}, services: [{service, hostname, forward: "ip:port", dns: {state, detail, origin: "created"|"claimed"|null, record_id: str|null}, proxy: {state, detail, origin, host_id: int|null}, certificate: {state, detail, expires_on: str|null}}], stale: [{service, kind, name, origin}]}`. `state` is `ok | update | create | claimable | conflict | unknown` (`unknown` = that integration isn't configured or couldn't be read; its section's `error` says why); certificate states are `ok | update | create | unknown`.
- `GET /environments/{name}/publish` (view) → `PublishState` (reads Cloudflare and NPM live, changes nothing). Errors: 404 `environment_not_found`.
- `POST /environments/{name}/publish/claim` (change) → `PublishState` plus `claimed: string[]` (`"dns:<hostname>"`, `"proxy:<hostname>"`). Errors: 409 `deploy_in_progress`; 409 `nothing_to_claim`; 409 `claim_conflict`.
- `POST /environments` (add) accepts `publish?: bool` (mode `new`; default true). Adopt with `publish: true` → 422 `publish_not_allowed`.
- `PATCH /environments/{name}` (change) accepts `publish: bool`.
- `POST /environments/{name}/deployments` (add) `mode` may also be `publish` (no other fields) or `teardown` (change + `confirm_name`). Errors add: 409 `publish_off`; 409 `not_deployed` (publish); 409 `integration_not_configured {kinds: ["cloudflare"|"npm"]}` (publish, any publishing deploy, or a teardown that must delete entries); 422 `git_ref_not_allowed` (publish, teardown).
- `POST /deployments/{id}/retry` retries `publish` and `teardown` (teardown needs change + `confirm_name`).
- `Environment` adds `publish: bool` and `managed_records: [{service, kind: "dns_record"|"proxy_host"|"certificate", name, origin}]`; `status` may be `deleting`. `DeploymentSummary` adds `publish: bool`; `mode` may be `publish` or `teardown`. After a teardown succeeds, `GET /environments/{name}` and `GET /deployments/{id}` answer 404.

## File map

| File | Responsibility |
|---|---|
| `sirdar/api/migrations/versions/0006_publish.py` | `integrations`, `managed_records`, `environments.publish`, `deployments.publish`, status `deleting`, modes `publish`/`teardown` |
| `sirdar/api/src/sirdar_api/db/models.py` | `Integration`, `ManagedRecord`; new columns |
| `sirdar/api/src/sirdar_api/deploy/integrations.py` | Credential store: validate, save, load, public view, remove |
| `sirdar/api/src/sirdar_api/deploy/outbound.py` | The transport switch every outbound client reads |
| `sirdar/api/src/sirdar_api/deploy/cloudflare.py` | Cloudflare API client + connection test |
| `sirdar/api/src/sirdar_api/deploy/npm.py` | Nginx Proxy Manager API client (login, hosts, certificates with certbot retry) + connection test |
| `sirdar/api/src/sirdar_api/deploy/smoke.py` | Smoke checks through NPM's LAN IP with SNI |
| `sirdar/api/src/sirdar_api/deploy/publish.py` | Context, status functions, inspection, claim, steps 12–14 / 16–17, `HttpPublisher` |
| `sirdar/api/src/sirdar_api/deploy/steps.py` | Steps 12–17, `runs`, plans with `publish` |
| `sirdar/api/src/sirdar_api/deploy/ansible/teardown.yml` | Step 15 |
| `sirdar/api/src/sirdar_api/deploy/pipeline.py` | Python steps, `publish`/`teardown` modes, delete on success |
| `sirdar/api/src/sirdar_api/deploy/environments.py` | `publish` on create / adopt / PATCH |
| `sirdar/api/src/sirdar_api/deploy/serialize.py` | `publish`, `managed_records` |
| `sirdar/api/src/sirdar_api/dashboard/service.py` | `deleting` shows as deploying |
| `sirdar/api/src/sirdar_api/api/routes/integrations.py` | Integration routes |
| `sirdar/api/src/sirdar_api/api/routes/deploy.py` | Publish tab routes, publish/teardown deployments, retries |
| `sirdar/api/src/sirdar_api/api/app.py` | Registers the integrations router |
| `sirdar/api/tests/…` | `integration_helpers.py`, `fake_cloudflare.py`, `fake_npm.py`, `fake_publisher.py`, `test_deploy_integrations.py`, `test_deploy_cloudflare.py`, `test_deploy_npm.py`, `test_deploy_integrations_api.py`, `test_deploy_publish.py`, `test_deploy_publish_steps.py`, `test_deploy_smoke.py`, `test_deploy_pipeline_publish.py`, `test_deploy_publish_api.py`; updates to conftest, deploy_factories, models, playbooks, environments API tests |
| `sirdar/README.md`, `deploy/stack/README.md` | Integrations, Publish, Delete environment |

---

### Task 1: Migration 0006 and the models

**Files:**
- Create: `sirdar/api/migrations/versions/0006_publish.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py`
- Modify: `sirdar/api/tests/conftest.py` (`SIRDAR_TABLES`)
- Test: `sirdar/api/tests/test_deploy_models.py`

**Interfaces:**
- Produces (tables): `integrations` (`kind` PK in cloudflare|npm, `config` jsonb default `{}`, `secret_enc` bytea, `updated_by` uuid, `updated_at`); `managed_records` (`id`, `environment_id` FK ON DELETE CASCADE, `service`, `kind` in dns_record|proxy_host|certificate, `external_id`, `name`, `origin` in created|claimed, `created_at`, `updated_at`; UNIQUE (`environment_id`, `service`, `kind`) and UNIQUE (`kind`, `external_id`)); `environments.publish` boolean default false; `environments.status` may be `deleting`; `deployments.publish` boolean default false; `deployments.mode` may be `publish` or `teardown`.
- Produces (ORM): `class Integration(Base)` (`kind`, `config: dict`, `secret_enc: bytes | None`, `updated_by`, `updated_at`); `class ManagedRecord(Base)` (the columns above); `Environment.publish: bool`; `Deployment.publish: bool`.

- [ ] **Step 1: Check the migration number**

Run:

```bash
ls /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/*/sirdar/api/migrations/versions/ | sort | tail -3
docker exec $(docker ps -qf name=sirdar-db) psql -U sirdar -d sirdar -tAc 'select version_num from alembic_version'
```

Expected: no `0006_*` file anywhere, and `0005`. Otherwise stop and report.

- [ ] **Step 2: Write the failing tests**

In `sirdar/api/tests/test_deploy_models.py`, replace:

```python
from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    Snapshot,
)
```

with:

```python
from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    Integration,
    ManagedRecord,
    Snapshot,
)
```

Append to the end of `sirdar/api/tests/test_deploy_models.py`:

```python
def _record(env_id, **over) -> ManagedRecord:
    kw = dict(environment_id=env_id, service="api", kind="dns_record", external_id="rec-1",
              name="api.uat.serversherpa.com", origin="created")
    kw.update(over)
    return ManagedRecord(**kw)


async def test_publish_tables_and_columns(db):
    env = await _env(db)
    await db.refresh(env)
    assert env.publish is False
    db.add(Integration(kind="cloudflare", config={"zone": "serversherpa.com"}, secret_enc=b"x"))
    db.add(_record(env.id))
    dep = Deployment(environment_id=env.id, mode="publish", git_ref="main", sha=SHA,
                     status="succeeded", start_step=12, publish=True)
    db.add(dep)
    env.status = "deleting"
    await db.commit()
    row = await db.get(Integration, "cloudflare")
    assert row.updated_at is not None and row.config == {"zone": "serversherpa.com"}
    await db.refresh(dep)
    assert dep.publish is True
    db.add(Deployment(environment_id=env.id, mode="teardown", git_ref="main", sha="",
                      status="failed", start_step=15))
    await db.commit()
    await db.execute(delete(Environment).where(Environment.id == env.id))
    await db.commit()
    assert await db.scalar(select(func.count()).select_from(ManagedRecord)) == 0


async def test_managed_record_constraints(db):
    env, other = await _env(db), await _env(db, name="uat2")
    env_id, other_id = env.id, other.id
    db.add(_record(env_id))
    await db.commit()
    for bad in (_record(env_id, external_id="rec-2"),      # a second api record for uat
                _record(other_id),                         # uat's record, claimed by uat2
                _record(other_id, external_id="r3", kind="cname"),
                _record(other_id, external_id="r4", origin="adopted")):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    # one id per kind: a proxy host and a DNS record may share "rec-1"
    db.add(_record(other_id, kind="proxy_host"))
    await db.commit()
    db.add(Integration(kind="route53"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_migration_0006_round_trip():
    """Downgrading drops the publish and teardown deployments with their
    steps; upgrading again leaves every existing environment unpublished."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip, publish) "
            "VALUES ('pub', 'dev', 'ssh', 'pub.example.com', '10.0.0.2', true) RETURNING id"
        ).fetchone()[0]
        dep_id = conn.execute(
            "INSERT INTO deployments (environment_id, mode, git_ref, sha, status, start_step, "
            "publish) VALUES (%s, 'publish', 'main', %s, 'succeeded', 12, true) RETURNING id",
            (env_id, SHA)).fetchone()[0]
        conn.execute("INSERT INTO deployment_steps (deployment_id, number, key, name) "
                     "VALUES (%s, 12, 'dns', 'DNS records')", (dep_id,))
    _alembic("downgrade", "0005")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM deployments WHERE id = %s",
                                (dep_id,)).fetchone()[0] == 0
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT publish FROM environments WHERE id = %s",
                            (env_id,)).fetchone()[0] is False
```

`_alembic` is the helper the 0005 migration test already uses in this file.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_models.py`
Expected: FAIL — `ImportError: cannot import name 'Integration'`.

- [ ] **Step 4: Write the migration**

Create `sirdar/api/migrations/versions/0006_publish.py`:

```python
"""Deploy phase 4: DNS + proxy. Integration credentials, the records Sirdar
manages, the environment's Publish switch, whether a deployment publishes,
the deleting status and the publish / teardown modes.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-04
"""
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE integrations (
          kind text PRIMARY KEY CHECK (kind IN ('cloudflare', 'npm')),
          config jsonb NOT NULL DEFAULT '{}'::jsonb,
          secret_enc bytea,
          updated_by uuid,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE managed_records (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          service text NOT NULL,
          kind text NOT NULL CHECK (kind IN ('dns_record', 'proxy_host', 'certificate')),
          external_id text NOT NULL,
          name text NOT NULL,
          origin text NOT NULL CHECK (origin IN ('created', 'claimed')),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (environment_id, service, kind),
          UNIQUE (kind, external_id)
        );
        -- Environments that exist now were published by hand (or not at
        -- all): they start unpublished until someone turns Publish on.
        ALTER TABLE environments
          ADD COLUMN publish boolean NOT NULL DEFAULT false,
          DROP CONSTRAINT environments_status_check,
          ADD CONSTRAINT environments_status_check CHECK (status IN
            ('new', 'deploying', 'ready', 'failed', 'deleting'));
        ALTER TABLE deployments
          ADD COLUMN publish boolean NOT NULL DEFAULT false,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish',
             'teardown'));
    """)


def downgrade() -> None:
    op.execute("""
        DELETE FROM deployments WHERE mode IN ('publish', 'teardown');
        DELETE FROM deployment_steps
          WHERE key IN ('dns', 'proxy', 'smoke', 'teardown', 'unproxy', 'undns');
        UPDATE environments SET status = 'failed' WHERE status = 'deleting';
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback')),
          DROP COLUMN publish;
        ALTER TABLE environments
          DROP CONSTRAINT environments_status_check,
          ADD CONSTRAINT environments_status_check CHECK (status IN
            ('new', 'deploying', 'ready', 'failed')),
          DROP COLUMN publish;
        DROP TABLE managed_records;
        DROP TABLE integrations;
    """)
```

- [ ] **Step 5: Add the models**

In `sirdar/api/src/sirdar_api/db/models.py`, replace:

```python
"""Sirdar's own tables (migrations 0001–0005). `users` mirrors the portal's
```

with:

```python
"""Sirdar's own tables (migrations 0001–0006). `users` mirrors the portal's
```

In the `Environment` class, replace:

```python
    seed_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("snapshots.id", ondelete="SET NULL"))
    created_by: Mapped[uuid.UUID | None]
```

with:

```python
    seed_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("snapshots.id", ondelete="SET NULL"))
    # Deploys add steps 12–14 (DNS, proxy, smoke test) when on (migration 0006).
    publish: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_by: Mapped[uuid.UUID | None]
```

In the `Deployment` class, replace:

```python
    restore_dump: Mapped[str | None]
    previous_sha: Mapped[str | None]
```

with:

```python
    restore_dump: Mapped[str | None]
    # Whether its plan has steps 12–14 (migration 0006): retries keep it.
    publish: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    previous_sha: Mapped[str | None]
```

Also in `Deployment`, replace:

```python
    # update | reset | adopt | snapshot | restore_dump | rollback
    mode: Mapped[str]
```

with:

```python
    # update | reset | adopt | snapshot | restore_dump | rollback | publish | teardown
    mode: Mapped[str]
```

Append to the end of `sirdar/api/src/sirdar_api/db/models.py`:

```python
class Integration(Base):
    """Credentials Sirdar publishes with (migration 0006): `config` holds the
    non-secret settings, `secret_enc` the token or password (Fernet,
    SIRDAR_SECRETS_KEY). Never returned; see deploy/integrations.py."""

    __tablename__ = "integrations"

    kind: Mapped[str] = mapped_column(primary_key=True)        # cloudflare | npm
    config: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    secret_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    updated_by: Mapped[uuid.UUID | None]
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ManagedRecord(Base):
    """A Cloudflare record, NPM proxy host or NPM certificate Sirdar manages
    for one environment's service (migration 0006). origin "created": Sirdar
    made it and Delete environment removes it; "claimed": it existed before,
    Sirdar keeps it up to date and never deletes it."""

    __tablename__ = "managed_records"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"))
    service: Mapped[str]
    kind: Mapped[str]                              # dns_record | proxy_host | certificate
    external_id: Mapped[str]
    name: Mapped[str]                              # the hostname it serves
    origin: Mapped[str]                            # created | claimed
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

- [ ] **Step 6: Truncate the new tables between tests**

In `sirdar/api/tests/conftest.py`, replace:

```python
                 "deployment_steps, snapshots")
```

with:

```python
                 "deployment_steps, snapshots, integrations, managed_records")
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_models.py`
Expected: PASS (all tests, including the 0005 migration test, which now upgrades through 0006).

- [ ] **Step 8: Commit**

```bash
git add sirdar/api/migrations/versions/0006_publish.py sirdar/api/src/sirdar_api/db/models.py \
  sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_models.py
git commit -m "feat(sirdar): migration 0006 — integrations, managed records, publish flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Integration credentials store

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/integrations.py`
- Create: `sirdar/api/tests/integration_helpers.py`
- Test: `sirdar/api/tests/test_deploy_integrations.py`

**Interfaces:**
- Consumes: `vault.encrypt/decrypt/is_configured`, `vault.SecretsKeyMissing`, `vault.SecretUnreadable`, `envfile.unsafe_value`, `Integration`, `User`.
- Produces (module `sirdar_api.deploy.integrations`): `KINDS = ("cloudflare", "npm")`; `LABELS = {"cloudflare": "Cloudflare", "npm": "Nginx Proxy Manager"}`; `FIELDS = {"cloudflare": ("zone", "public_ip"), "npm": ("url", "identity", "letsencrypt_email")}`; `SECRET_FIELD = {"cloudflare": "token", "npm": "password"}`; `DEFAULT_ZONE = "serversherpa.com"`; `class IntegrationError(Exception)` with `.code`, `.extra`, `.reason`; frozen dataclasses `CloudflareConfig(zone, public_ip, token)` and `NpmConfig(url, identity, letsencrypt_email, password)` (secrets `repr=False`); `check_fields(kind, values: dict) -> dict`; `check_secret(kind, value: str) -> str`; `async is_configured(db, kind) -> bool`; `async load(db, settings, kind) -> CloudflareConfig | NpmConfig | None`; `async load_cloudflare(db, settings) -> CloudflareConfig | None`; `async load_npm(db, settings) -> NpmConfig | None`; `async candidate(db, settings, kind, values, secret: str | None)`; `async save(db, settings, kind, values, secret: str | None, actor_id) -> list[str]` (changed field names; the secret appears as `token` / `password`); `async remove(db, kind) -> bool`; `async public(db, settings) -> dict` (the `Integrations` shape).
- Produces (tests): `tests/integration_helpers.py` — `CF_TOKEN`, `NPM_PASSWORD`, `CF_VALUES`, `NPM_VALUES`, `async configure(db, *, cloudflare=True, npm=True)`.

- [ ] **Step 1: Write the test helpers**

Create `sirdar/api/tests/integration_helpers.py`:

```python
"""Stored integration credentials for publish tests. The secrets are
distinct strings so leak checks can look for them."""

from sirdar_api.config import get_settings
from sirdar_api.deploy import integrations

CF_TOKEN = "cfTOKEN-" + "s3cr3t" * 5
NPM_PASSWORD = "npm-PASSWORD-s3cr3t!"
CF_VALUES = {"zone": "serversherpa.com", "public_ip": "203.0.113.7"}
NPM_VALUES = {"url": "http://10.10.48.6:81", "identity": "admin@example.com",
              "letsencrypt_email": ""}


async def configure(db, *, cloudflare: bool = True, npm: bool = True) -> None:
    """Save the integrations (needs the secrets_key fixture) and commit."""
    if cloudflare:
        await integrations.save(db, get_settings(), "cloudflare", CF_VALUES, CF_TOKEN,
                                actor_id=None)
    if npm:
        await integrations.save(db, get_settings(), "npm", NPM_VALUES, NPM_PASSWORD,
                                actor_id=None)
    await db.commit()
```

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_integrations.py`:

```python
import pytest
from cryptography.fernet import Fernet

from sirdar_api.config import get_settings
from sirdar_api.db.models import Integration
from sirdar_api.deploy import integrations
from sirdar_api.deploy.integrations import IntegrationError

from .deploy_factories import secrets_key  # noqa: F401
from .factories import make_user
from .integration_helpers import CF_TOKEN, CF_VALUES, NPM_PASSWORD, NPM_VALUES, configure


async def test_save_and_load_cloudflare(db, secrets_key):
    changed = await integrations.save(db, get_settings(), "cloudflare", CF_VALUES, CF_TOKEN,
                                      actor_id=None)
    await db.commit()
    assert changed == ["zone", "public_ip", "token"]
    row = await db.get(Integration, "cloudflare")
    assert row.config == {"zone": "serversherpa.com", "public_ip": "203.0.113.7"}
    assert CF_TOKEN.encode() not in bytes(row.secret_enc)
    cfg = await integrations.load_cloudflare(db, get_settings())
    assert (cfg.zone, cfg.public_ip, cfg.token) == ("serversherpa.com", "203.0.113.7", CF_TOKEN)
    assert CF_TOKEN not in repr(cfg)
    assert await integrations.is_configured(db, "cloudflare")
    assert not await integrations.is_configured(db, "npm")


async def test_npm_defaults_the_lets_encrypt_email_to_the_login(db, secrets_key):
    await configure(db, cloudflare=False)
    cfg = await integrations.load_npm(db, get_settings())
    assert (cfg.url, cfg.identity, cfg.letsencrypt_email, cfg.password) == (
        "http://10.10.48.6:81", "admin@example.com", "admin@example.com", NPM_PASSWORD)
    assert NPM_PASSWORD not in repr(cfg)


async def test_saving_without_a_secret_keeps_the_stored_one(db, secrets_key):
    await configure(db)
    changed = await integrations.save(db, get_settings(), "cloudflare",
                                      {**CF_VALUES, "public_ip": "203.0.113.8"}, None,
                                      actor_id=None)
    await db.commit()
    assert changed == ["public_ip"]
    cfg = await integrations.load_cloudflare(db, get_settings())
    assert (cfg.public_ip, cfg.token) == ("203.0.113.8", CF_TOKEN)
    assert await integrations.save(db, get_settings(), "cloudflare",
                                   {**CF_VALUES, "public_ip": "203.0.113.8"}, None,
                                   actor_id=None) == []


async def test_first_save_needs_a_secret(db, secrets_key):
    with pytest.raises(IntegrationError) as e:
        await integrations.save(db, get_settings(), "npm", NPM_VALUES, None, actor_id=None)
    assert e.value.code == "secret_required"


@pytest.mark.parametrize("kind, values, secret, code", [
    ("cloudflare", {**CF_VALUES, "zone": "not a zone"}, CF_TOKEN, "zone_invalid"),
    ("cloudflare", {**CF_VALUES, "public_ip": "999.1.1.1"}, CF_TOKEN, "public_ip_invalid"),
    ("cloudflare", CF_VALUES, "short", "token_invalid"),
    ("cloudflare", CF_VALUES, "has spaces in it, twenty+ chars", "token_invalid"),
    ("npm", {**NPM_VALUES, "url": "10.10.48.6:81"}, NPM_PASSWORD, "npm_url_invalid"),
    ("npm", {**NPM_VALUES, "url": "http://npm/api"}, NPM_PASSWORD, "npm_url_invalid"),
    ("npm", {**NPM_VALUES, "identity": "admin"}, NPM_PASSWORD, "identity_invalid"),
    ("npm", {**NPM_VALUES, "letsencrypt_email": "x@"}, NPM_PASSWORD,
     "letsencrypt_email_invalid"),
    ("npm", NPM_VALUES, "", "password_invalid"),
    ("npm", NPM_VALUES, "line\nbreak", "password_invalid"),
    ("npm", NPM_VALUES, "x" * 1025, "password_invalid"),
])
async def test_validation(db, secrets_key, kind, values, secret, code):
    with pytest.raises(IntegrationError) as e:
        await integrations.save(db, get_settings(), kind, values, secret, actor_id=None)
    assert e.value.code == code
    assert secret not in str(e.value) and secret not in repr(e.value.extra)


async def test_values_are_normalized(db, secrets_key):
    await integrations.save(db, get_settings(), "cloudflare",
                            {"zone": " ServerSherpa.com. ", "public_ip": " 203.0.113.7 "},
                            CF_TOKEN, actor_id=None)
    await integrations.save(db, get_settings(), "npm",
                            {**NPM_VALUES, "url": "http://10.10.48.6:81/"}, NPM_PASSWORD,
                            actor_id=None)
    assert (await db.get(Integration, "cloudflare")).config["zone"] == "serversherpa.com"
    assert (await db.get(Integration, "npm")).config["url"] == "http://10.10.48.6:81"


async def test_a_secret_needs_the_secrets_key(db, monkeypatch):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(IntegrationError) as e:
        await integrations.save(db, get_settings(), "cloudflare", CF_VALUES, CF_TOKEN,
                                actor_id=None)
    assert e.value.code == "secrets_key_missing"
    get_settings.cache_clear()


async def test_a_secret_from_another_key_is_unreadable(db, secrets_key):
    db.add(Integration(kind="npm", config={**NPM_VALUES, "letsencrypt_email": "a@b.co"},
                       secret_enc=Fernet(Fernet.generate_key()).encrypt(b"x")))
    await db.commit()
    with pytest.raises(IntegrationError) as e:
        await integrations.load_npm(db, get_settings())
    assert (e.value.code, e.value.extra) == ("integration_unreadable", {"kind": "npm"})


async def test_candidate_uses_the_given_or_the_stored_secret(db, secrets_key):
    with pytest.raises(IntegrationError) as e:
        await integrations.candidate(db, get_settings(), "cloudflare", CF_VALUES, None)
    assert e.value.code == "secret_required"
    given = await integrations.candidate(db, get_settings(), "cloudflare", CF_VALUES,
                                         "other-" + "t" * 20)
    assert given.token == "other-" + "t" * 20
    await configure(db)
    stored = await integrations.candidate(db, get_settings(), "npm",
                                          {**NPM_VALUES, "identity": "ops@example.com"}, None)
    assert (stored.identity, stored.password) == ("ops@example.com", NPM_PASSWORD)
    row = await db.get(Integration, "npm", populate_existing=True)
    assert row.config["identity"] == "admin@example.com"      # nothing was saved


async def test_public_view_never_carries_a_secret(db, secrets_key):
    empty = await integrations.public(db, get_settings())
    assert empty == {
        "secrets_key_configured": True,
        "cloudflare": {"configured": False, "zone": None, "public_ip": None, "token_set": False,
                       "updated_at": None, "updated_by_name": None},
        "npm": {"configured": False, "url": None, "identity": None, "letsencrypt_email": None,
                "password_set": False, "updated_at": None, "updated_by_name": None},
    }
    user = await make_user(db, email="ops@test.example.com", first_name="Jimmy",
                           last_name="Henderson")
    await integrations.save(db, get_settings(), "cloudflare", CF_VALUES, CF_TOKEN,
                            actor_id=user.person_id)
    await db.commit()
    view = await integrations.public(db, get_settings())
    assert view["cloudflare"] | {"updated_at": None} == {
        "configured": True, "zone": "serversherpa.com", "public_ip": "203.0.113.7",
        "token_set": True, "updated_at": None, "updated_by_name": "Jimmy Henderson"}
    assert view["cloudflare"]["updated_at"] is not None
    assert CF_TOKEN not in repr(view)


async def test_remove(db, secrets_key):
    await configure(db)
    assert await integrations.remove(db, "npm") is True
    await db.commit()
    assert await integrations.remove(db, "npm") is False
    assert await integrations.load_npm(db, get_settings()) is None
```

`make_user` comes from `tests/factories.py` (the API helpers use it the same way); if its keyword names differ, read `tests/factories.py` and match them.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_integrations.py`
Expected: FAIL — `ImportError: cannot import name 'integrations'`.

- [ ] **Step 4: Write the module**

Create `sirdar/api/src/sirdar_api/deploy/integrations.py`:

```python
"""Integration credentials Sirdar publishes with (phase 4): the Cloudflare
API token and the Nginx Proxy Manager login, plus their non-secret settings.

The secret is Fernet-encrypted with SIRDAR_SECRETS_KEY in
integrations.secret_enc and write-only: public() reports only whether one is
set, errors name fields, never values, and the config dataclasses keep the
secret out of repr(). Callers audit and commit."""

import ipaddress
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Integration, User
from sirdar_api.deploy import envfile, vault

KINDS = ("cloudflare", "npm")
LABELS = {"cloudflare": "Cloudflare", "npm": "Nginx Proxy Manager"}
FIELDS = {"cloudflare": ("zone", "public_ip"), "npm": ("url", "identity", "letsencrypt_email")}
SECRET_FIELD = {"cloudflare": "token", "npm": "password"}
DEFAULT_ZONE = "serversherpa.com"
PASSWORD_MAX = 1024

_DOMAIN_RE = re.compile(r"(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{20,200}")
_URL_RE = re.compile(r"https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}")

_REASONS = {
    "secrets_key_missing": "SIRDAR_SECRETS_KEY isn't set, so Sirdar can't read the "
                           "integration credentials.",
    "integration_unreadable": "The stored credentials don't open with the current "
                              "SIRDAR_SECRETS_KEY. Enter them again in Settings.",
}


class IntegrationError(Exception):
    """`code` is the API error code; `extra` holds non-secret details."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra

    @property
    def reason(self) -> str:
        return _REASONS.get(self.code, "The integration settings can't be used.")


@dataclass(frozen=True)
class CloudflareConfig:
    zone: str
    public_ip: str
    token: str = field(repr=False)


@dataclass(frozen=True)
class NpmConfig:
    url: str
    identity: str
    letsencrypt_email: str
    password: str = field(repr=False)


def _check_cloudflare(values: dict) -> dict:
    zone = str(values.get("zone") or "").strip().lower().rstrip(".")
    if not _DOMAIN_RE.fullmatch(zone):
        raise IntegrationError("zone_invalid")
    try:
        ip = str(ipaddress.IPv4Address(str(values.get("public_ip") or "").strip()))
    except ValueError:
        raise IntegrationError("public_ip_invalid") from None
    return {"zone": zone, "public_ip": ip}


def _email(value: str) -> bool:
    return len(value) <= 254 and bool(_EMAIL_RE.fullmatch(value))


def _check_npm(values: dict) -> dict:
    url = str(values.get("url") or "").strip().rstrip("/")
    if not _URL_RE.fullmatch(url):
        raise IntegrationError("npm_url_invalid")
    identity = str(values.get("identity") or "").strip()
    if not _email(identity):
        raise IntegrationError("identity_invalid")
    email = str(values.get("letsencrypt_email") or "").strip() or identity
    if not _email(email):
        raise IntegrationError("letsencrypt_email_invalid")
    return {"url": url, "identity": identity, "letsencrypt_email": email}


def check_fields(kind: str, values: dict) -> dict:
    return _check_cloudflare(values) if kind == "cloudflare" else _check_npm(values)


def check_secret(kind: str, value: str) -> str:
    if kind == "cloudflare":
        if not isinstance(value, str) or not _TOKEN_RE.fullmatch(value):
            raise IntegrationError("token_invalid")
    elif (not isinstance(value, str) or not value or len(value) > PASSWORD_MAX
          or envfile.unsafe_value(value)):
        raise IntegrationError("password_invalid")
    return value


def _config(kind: str, config: dict, secret: str) -> CloudflareConfig | NpmConfig:
    if kind == "cloudflare":
        return CloudflareConfig(zone=config["zone"], public_ip=config["public_ip"], token=secret)
    return NpmConfig(url=config["url"], identity=config["identity"],
                     letsencrypt_email=config.get("letsencrypt_email") or config["identity"],
                     password=secret)


def _decrypt(settings: Settings, row: Integration) -> str:
    try:
        return vault.decrypt(settings, row.secret_enc)
    except vault.SecretsKeyMissing:
        raise IntegrationError("secrets_key_missing") from None
    except vault.SecretUnreadable:
        raise IntegrationError("integration_unreadable", kind=row.kind) from None


async def _row(db: AsyncSession, kind: str) -> Integration | None:
    return await db.get(Integration, kind, populate_existing=True)


async def is_configured(db: AsyncSession, kind: str) -> bool:
    row = await _row(db, kind)
    return row is not None and row.secret_enc is not None


async def load(db: AsyncSession, settings: Settings,
               kind: str) -> CloudflareConfig | NpmConfig | None:
    """The stored settings with the decrypted secret; None when not set up."""
    row = await _row(db, kind)
    if row is None or row.secret_enc is None:
        return None
    return _config(kind, row.config, _decrypt(settings, row))


async def load_cloudflare(db: AsyncSession, settings: Settings) -> CloudflareConfig | None:
    return await load(db, settings, "cloudflare")


async def load_npm(db: AsyncSession, settings: Settings) -> NpmConfig | None:
    return await load(db, settings, "npm")


async def candidate(db: AsyncSession, settings: Settings, kind: str, values: dict,
                    secret: str | None) -> CloudflareConfig | NpmConfig:
    """Unsaved values for a Test: the given secret, else the stored one."""
    checked = check_fields(kind, values)
    if secret is not None:
        return _config(kind, checked, check_secret(kind, secret))
    row = await _row(db, kind)
    if row is None or row.secret_enc is None:
        raise IntegrationError("secret_required")
    return _config(kind, checked, _decrypt(settings, row))


async def save(db: AsyncSession, settings: Settings, kind: str, values: dict,
               secret: str | None, actor_id) -> list[str]:
    """Store the settings, and the secret when given (None keeps the stored
    one). Returns the names of what changed (the secret as token/password)."""
    checked = check_fields(kind, values)
    if secret is not None:
        check_secret(kind, secret)
    row = await _row(db, kind)
    if secret is None and (row is None or row.secret_enc is None):
        raise IntegrationError("secret_required")
    if secret is not None and not vault.is_configured(settings):
        raise IntegrationError("secrets_key_missing")
    if row is None:
        row = Integration(kind=kind, config={})
        db.add(row)
    changed = [k for k, v in checked.items() if row.config.get(k) != v]
    row.config = dict(checked)
    if secret is not None:
        row.secret_enc = vault.encrypt(settings, secret)
        changed.append(SECRET_FIELD[kind])
    if changed:
        row.updated_by, row.updated_at = actor_id, datetime.now(UTC)
    await db.flush()
    return changed


async def remove(db: AsyncSession, kind: str) -> bool:
    result = await db.execute(delete(Integration).where(Integration.kind == kind))
    return result.rowcount > 0


async def public(db: AsyncSession, settings: Settings) -> dict:
    """What the Settings page shows: settings and whether a secret is set."""
    out: dict = {"secrets_key_configured": vault.is_configured(settings)}
    for kind in KINDS:
        row = await _row(db, kind)
        config = dict(row.config) if row else {}
        by = await db.get(User, row.updated_by) if row and row.updated_by else None
        out[kind] = {
            "configured": bool(row and row.secret_enc is not None),
            **{name: config.get(name) for name in FIELDS[kind]},
            f"{SECRET_FIELD[kind]}_set": bool(row and row.secret_enc is not None),
            "updated_at": row.updated_at if row else None,
            "updated_by_name": by.display_name if by else None,
        }
    return out
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_integrations.py`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/integrations.py tests/integration_helpers.py tests/test_deploy_integrations.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/integrations.py \
  sirdar/api/tests/integration_helpers.py sirdar/api/tests/test_deploy_integrations.py
git commit -m "feat(sirdar): encrypted, write-only integration credentials

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Cloudflare client, its fake, and the no-real-HTTP guard

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/cloudflare.py`
- Create: `sirdar/api/tests/fake_cloudflare.py`
- Modify: `sirdar/api/tests/conftest.py` (autouse `no_real_http`)
- Test: `sirdar/api/tests/test_deploy_cloudflare.py`

**Interfaces:**
- Consumes: `CloudflareConfig` (Task 2); `Check`, `ConnectFailed`, `ConnectResult` from `sirdar_api.deploy`.
- Produces (module `sirdar_api.deploy.cloudflare`): `BASE_URL`, `PER_PAGE = 500`, `MAX_PAGES = 20`; `class CloudflareError(Exception)` with `.reason`; `class RecordGone(CloudflareError)`; frozen dataclass `DnsRecord(id: str, type: str, name: str, content: str, proxied: bool, comment: str | None = None)` (name lowercased, no trailing dot); `class Cloudflare(cfg, *, transport=None)` — async context manager with `zone_id() -> str`, `records() -> list[DnsRecord]` (the whole zone, paged), `create_a(name, content, *, proxied, comment) -> DnsRecord`, `update_a(record_id, *, name, content, proxied) -> DnsRecord`, `delete(record_id) -> bool` (False when already gone); `async test_connection(cfg, *, transport=None) -> ConnectResult` (raises `ConnectFailed`).
- Produces (tests): `tests/fake_cloudflare.py` — `ZONE_ID`, `class FakeCloudflare(*, zone="serversherpa.com", token=CF_TOKEN)` with `.records` (id → dict), `.requests`, `.fail_writes: int | None`, `.down: bool`, `add(type_, name, content, *, proxied=False, comment=None) -> str`, `writes() -> list[tuple[str, str]]` (method, record id or ""), `transport() -> httpx.MockTransport`.
- Produces (conftest): autouse fixture `no_real_http` — any request through `httpx.AsyncHTTPTransport` raises `AssertionError`.

- [ ] **Step 1: Write the fake**

Create `sirdar/api/tests/fake_cloudflare.py`:

```python
"""A stand-in for the Cloudflare API v4 calls deploy/cloudflare.py makes:
an httpx.MockTransport over one in-memory zone."""

import itertools
import json

import httpx

from .integration_helpers import CF_TOKEN

ZONE_ID = "zone-0001"
API = "/client/v4"
RECORDS = f"{API}/zones/{ZONE_ID}/dns_records"


class FakeCloudflare:
    def __init__(self, *, zone: str = "serversherpa.com", token: str = CF_TOKEN):
        self.zone = zone
        self.token = token
        self.records: dict[str, dict] = {}
        self.requests: list[httpx.Request] = []
        self.fail_writes: int | None = None     # answer every write with this status
        self.down = False
        self._ids = itertools.count(1)

    def add(self, type_: str, name: str, content: str, *, proxied: bool = False,
            comment: str | None = None) -> str:
        rid = f"rec-{next(self._ids):04d}"
        self.records[rid] = {"id": rid, "type": type_, "name": name, "content": content,
                             "proxied": proxied, "ttl": 1, "comment": comment}
        return rid

    def writes(self) -> list[tuple[str, str]]:
        return [(r.method, r.url.path.removeprefix(RECORDS).lstrip("/"))
                for r in self.requests if r.method != "GET"]

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    @staticmethod
    def _ok(result, **extra) -> httpx.Response:
        return httpx.Response(200, json={"success": True, "errors": [], "messages": [],
                                         "result": result, **extra})

    @staticmethod
    def _error(status: int, code: int, message: str) -> httpx.Response:
        return httpx.Response(status, json={"success": False, "messages": [], "result": None,
                                            "errors": [{"code": code, "message": message}]})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        if request.headers.get("authorization") != f"Bearer {self.token}":
            return self._error(403, 9109, "Invalid access token")
        path, method = request.url.path, request.method
        if path == f"{API}/zones" and method == "GET":
            name = request.url.params.get("name")
            return self._ok([{"id": ZONE_ID, "name": self.zone}] if name == self.zone else [])
        if path == RECORDS and method == "GET":
            per_page = int(request.url.params.get("per_page", "100"))
            page = int(request.url.params.get("page", "1"))
            rows = sorted(self.records.values(), key=lambda r: r["id"])
            chunk = rows[(page - 1) * per_page:page * per_page]
            return self._ok(chunk, result_info={
                "page": page, "per_page": per_page, "count": len(chunk),
                "total_count": len(rows), "total_pages": max(1, -(-len(rows) // per_page))})
        if self.fail_writes:
            return self._error(self.fail_writes, 81057, "Record already exists.")
        if path == RECORDS and method == "POST":
            body = json.loads(request.content)
            rid = self.add(body["type"], body["name"], body["content"],
                           proxied=body.get("proxied", False), comment=body.get("comment"))
            return self._ok(self.records[rid])
        if path.startswith(RECORDS + "/"):
            rid = path.removeprefix(RECORDS + "/")
            if rid not in self.records:
                return self._error(404, 81044, "Record does not exist.")
            if method == "PATCH":
                self.records[rid].update(json.loads(request.content))
                return self._ok(self.records[rid])
            if method == "DELETE":
                del self.records[rid]
                return self._ok({"id": rid})
        return self._error(404, 7003, "No route for that URI")
```

- [ ] **Step 2: Add the guard**

In `sirdar/api/tests/conftest.py`, replace:

```python
import psycopg
import pytest
```

with:

```python
import httpx
import psycopg
import pytest
```

and append to the end of `sirdar/api/tests/conftest.py`:

```python
@pytest.fixture(autouse=True)
def no_real_http(monkeypatch):
    """No test reaches a real server (Cloudflare, Nginx Proxy Manager, a
    public URL): every outbound client takes a transport, and the real one
    fails the test here."""
    async def refuse(self, request):
        raise AssertionError(f"a test made a real HTTP request to {request.url.host}")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse)
```

- [ ] **Step 3: Write the failing tests**

Create `sirdar/api/tests/test_deploy_cloudflare.py`:

```python
import pytest

from sirdar_api.deploy import ConnectFailed, cloudflare
from sirdar_api.deploy.cloudflare import Cloudflare, CloudflareError
from sirdar_api.deploy.integrations import CloudflareConfig

from .fake_cloudflare import ZONE_ID, FakeCloudflare
from .integration_helpers import CF_TOKEN

CFG = CloudflareConfig(zone="serversherpa.com", public_ip="203.0.113.7", token=CF_TOKEN)


async def test_reads_the_whole_zone_page_by_page(monkeypatch):
    fake = FakeCloudflare()
    for i in range(5):
        fake.add("A", f"h{i}.uat.serversherpa.com", "203.0.113.7")
    fake.add("CNAME", "www.serversherpa.com", "serversherpa.com")
    monkeypatch.setattr(cloudflare, "PER_PAGE", 2)
    async with Cloudflare(CFG, transport=fake.transport()) as cf:
        assert await cf.zone_id() == ZONE_ID
        records = await cf.records()
    assert len(records) == 6
    assert records[0].name == "h0.uat.serversherpa.com" and records[-1].type == "CNAME"
    pages = [r.url.params.get("page") for r in fake.requests if r.url.path.endswith("records")]
    assert pages == ["1", "2", "3"]
    assert sum(r.url.path.endswith("/zones") for r in fake.requests) == 1     # cached


async def test_create_update_delete():
    fake = FakeCloudflare()
    async with Cloudflare(CFG, transport=fake.transport()) as cf:
        made = await cf.create_a("api.uat2.serversherpa.com", "203.0.113.7", proxied=False,
                                 comment="Managed by Sirdar (uat2/api)")
        assert (made.type, made.name, made.content, made.proxied) == (
            "A", "api.uat2.serversherpa.com", "203.0.113.7", False)
        assert fake.records[made.id]["ttl"] == 1
        assert fake.records[made.id]["comment"] == "Managed by Sirdar (uat2/api)"
        moved = await cf.update_a(made.id, name=made.name, content="203.0.113.9", proxied=True)
        assert (moved.content, moved.proxied) == ("203.0.113.9", True)
        assert fake.records[made.id]["comment"] == "Managed by Sirdar (uat2/api)"
        assert await cf.delete(made.id) is True
        assert await cf.delete(made.id) is False         # already gone counts as gone
    assert fake.writes() == [("POST", ""), ("PATCH", made.id), ("DELETE", made.id),
                             ("DELETE", made.id)]


async def test_a_zone_the_token_cannot_see():
    fake = FakeCloudflare(zone="example.org")
    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=fake.transport()) as cf:
            await cf.records()
    assert e.value.reason == "The API token can't see the zone serversherpa.com."


@pytest.mark.parametrize("setup, reason", [
    (lambda f: setattr(f, "token", "another-token-1234567890"),
     "Cloudflare rejected the API token, or it has no access to this zone."),
    (lambda f: setattr(f, "down", True), "Couldn't reach the Cloudflare API."),
])
async def test_errors_are_our_own_copy(setup, reason):
    fake = FakeCloudflare()
    setup(fake)
    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=fake.transport()) as cf:
            await cf.zone_id()
    assert e.value.reason == reason
    assert CF_TOKEN not in str(e.value)


async def test_a_refused_write_names_cloudflares_error_code_only():
    fake = FakeCloudflare()
    fake.fail_writes = 400
    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=fake.transport()) as cf:
            await cf.create_a("api.uat2.serversherpa.com", "203.0.113.7", proxied=False,
                              comment="x")
    assert e.value.reason == "Cloudflare refused the request (error 81057)."


async def test_connection_test():
    fake = FakeCloudflare()
    fake.add("A", "api.uat.serversherpa.com", "203.0.113.7")
    fake.add("A", "old.serversherpa.com", "198.51.100.1")
    fake.add("TXT", "serversherpa.com", "v=spf1 -all")
    result = await cloudflare.test_connection(CFG, transport=fake.transport())
    assert result.ok and result.target == "cloudflare"
    assert [(c.label, c.status, c.value) for c in result.checks] == [
        ("Zone", "pass", f"serversherpa.com ({ZONE_ID})"),
        ("DNS records", "pass", "3 records, 2 A"),
        ("Public IP", "pass", "203.0.113.7 · 1 A record points at it"),
    ]
    assert result.facts == {"zone": "serversherpa.com", "zone_id": ZONE_ID, "records": 3,
                            "public_ip": "203.0.113.7", "records_at_public_ip": 1}
    fake.records.clear()
    empty = await cloudflare.test_connection(CFG, transport=fake.transport())
    assert empty.checks[2].status == "warn"
    fake.down = True
    with pytest.raises(ConnectFailed) as e:
        await cloudflare.test_connection(CFG, transport=fake.transport())
    assert e.value.reason == "Couldn't reach the Cloudflare API."


async def test_the_guard_stops_real_requests():
    with pytest.raises(AssertionError, match="real HTTP request to api.cloudflare.com"):
        async with Cloudflare(CFG) as cf:
            await cf.zone_id()
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_cloudflare.py`
Expected: FAIL — `ImportError: cannot import name 'cloudflare'`.

- [ ] **Step 5: Write the client**

Create `sirdar/api/src/sirdar_api/deploy/cloudflare.py`:

```python
"""Cloudflare DNS for publishing (spec Section 2 step 12): read the zone's
records, and create, change and delete A records by id. The API token goes
only into the Authorization header; errors carry our own copy, never
Cloudflare's or httpx's text (either may echo request details)."""

from dataclasses import dataclass

import httpx

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult
from sirdar_api.deploy.integrations import CloudflareConfig

BASE_URL = "https://api.cloudflare.com/client/v4"
PER_PAGE = 500
MAX_PAGES = 20
_UNREACHABLE = "Couldn't reach the Cloudflare API."
_DENIED = "Cloudflare rejected the API token, or it has no access to this zone."
_MALFORMED = "The Cloudflare API token is malformed."
_UNEXPECTED = "Cloudflare sent a response Sirdar didn't understand."


class CloudflareError(Exception):
    """`reason` is user-facing copy we wrote."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class RecordGone(CloudflareError):
    def __init__(self):
        super().__init__("The record no longer exists.")


@dataclass(frozen=True)
class DnsRecord:
    id: str
    type: str
    name: str
    content: str
    proxied: bool
    comment: str | None = None


def _record(raw) -> DnsRecord:
    try:
        comment = raw.get("comment")
        return DnsRecord(id=str(raw["id"]), type=str(raw["type"]),
                         name=str(raw["name"]).lower().rstrip("."), content=str(raw["content"]),
                         proxied=bool(raw.get("proxied")),
                         comment=comment if isinstance(comment, str) else None)
    except (KeyError, TypeError, AttributeError):
        raise CloudflareError(_UNEXPECTED) from None


def _refused(body, status: int) -> str:
    errors = body.get("errors") if isinstance(body, dict) else None
    if (isinstance(errors, list) and errors and isinstance(errors[0], dict)
            and isinstance(errors[0].get("code"), int)):
        return f"Cloudflare refused the request (error {errors[0]['code']})."
    return f"Cloudflare answered with HTTP {status}."


class Cloudflare:
    """`async with Cloudflare(cfg, transport=...) as cf:` — one client per step."""

    def __init__(self, cfg: CloudflareConfig, *,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.cfg = cfg
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._zone_id: str | None = None

    async def __aenter__(self) -> "Cloudflare":
        try:
            self._client = httpx.AsyncClient(
                base_url=BASE_URL, headers={"Authorization": f"Bearer {self.cfg.token}"},
                timeout=20, transport=self._transport)
        except (UnicodeError, ValueError, TypeError):
            raise CloudflareError(_MALFORMED) from None
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _call(self, method: str, path: str, *, params: dict | None = None,
                    json: dict | None = None) -> dict:
        try:
            resp = await self._client.request(method, path, params=params, json=json)
        except httpx.HTTPError:
            raise CloudflareError(_UNREACHABLE) from None
        try:
            body = resp.json()
        except ValueError:
            body = None
        if resp.status_code in (401, 403):
            raise CloudflareError(_DENIED)
        if resp.status_code == 404:
            raise RecordGone()
        if not isinstance(body, dict) or resp.status_code >= 400 or body.get("success") is not True:
            raise CloudflareError(_refused(body, resp.status_code))
        return body

    async def zone_id(self) -> str:
        if self._zone_id is None:
            body = await self._call("GET", "/zones", params={"name": self.cfg.zone})
            result = body.get("result")
            found = [z for z in result if isinstance(z, dict) and z.get("name") == self.cfg.zone
                     and z.get("id")] if isinstance(result, list) else []
            if not found:
                raise CloudflareError(f"The API token can't see the zone {self.cfg.zone}.")
            self._zone_id = str(found[0]["id"])
        return self._zone_id

    async def records(self) -> list[DnsRecord]:
        """Every record in the zone, any type."""
        zone = await self.zone_id()
        out: list[DnsRecord] = []
        for page in range(1, MAX_PAGES + 1):
            body = await self._call("GET", f"/zones/{zone}/dns_records",
                                    params={"page": page, "per_page": PER_PAGE})
            result = body.get("result")
            if not isinstance(result, list):
                raise CloudflareError(_UNEXPECTED)
            out += [_record(r) for r in result]
            try:
                pages = int((body.get("result_info") or {}).get("total_pages") or 1)
            except (TypeError, ValueError, AttributeError):
                raise CloudflareError(_UNEXPECTED) from None
            if page >= pages:
                return out
        raise CloudflareError("The zone has more DNS records than Sirdar reads.")

    async def create_a(self, name: str, content: str, *, proxied: bool,
                       comment: str) -> DnsRecord:
        zone = await self.zone_id()
        body = await self._call("POST", f"/zones/{zone}/dns_records", json={
            "type": "A", "name": name, "content": content, "ttl": 1, "proxied": proxied,
            "comment": comment})
        return _record(body.get("result"))

    async def update_a(self, record_id: str, *, name: str, content: str,
                       proxied: bool) -> DnsRecord:
        zone = await self.zone_id()
        body = await self._call("PATCH", f"/zones/{zone}/dns_records/{record_id}", json={
            "type": "A", "name": name, "content": content, "proxied": proxied})
        return _record(body.get("result"))

    async def delete(self, record_id: str) -> bool:
        """False when the record was already gone."""
        zone = await self.zone_id()
        try:
            await self._call("DELETE", f"/zones/{zone}/dns_records/{record_id}")
        except RecordGone:
            return False
        return True


async def test_connection(cfg: CloudflareConfig, *,
                          transport: httpx.AsyncBaseTransport | None = None) -> ConnectResult:
    """Read-only: the zone and its records. Cloudflare doesn't let a token
    read its own permissions, so edit access shows on the first publish."""
    try:
        async with Cloudflare(cfg, transport=transport) as cf:
            zone = await cf.zone_id()
            records = await cf.records()
    except CloudflareError as e:
        raise ConnectFailed(e.reason) from None
    a_records = [r for r in records if r.type == "A"]
    pointing = sum(1 for r in a_records if r.content == cfg.public_ip)
    noun = "A record points" if pointing == 1 else "A records point"
    checks = [
        Check("Zone", "pass", f"{cfg.zone} ({zone})"),
        Check("DNS records", "pass", f"{len(records)} records, {len(a_records)} A"),
        Check("Public IP", "pass" if pointing else "warn",
              f"{cfg.public_ip} · {pointing} {noun} at it"),
    ]
    return ConnectResult(ok=True, target="cloudflare", checks=checks, facts={
        "zone": cfg.zone, "zone_id": zone, "records": len(records),
        "public_ip": cfg.public_ip, "records_at_public_ip": pointing})


test_connection.__test__ = False  # not a pytest test, despite the name
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_cloudflare.py`
Expected: PASS.

- [ ] **Step 7: Prove the guard doesn't break the existing suite**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q`
Expected: every test passes (the opt-in e2e tests skip). A failure saying "a test made a real HTTP request" means an existing test reached the network: give that client a transport rather than loosening the guard.

- [ ] **Step 8: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/cloudflare.py tests/fake_cloudflare.py tests/test_deploy_cloudflare.py \
  tests/conftest.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/cloudflare.py sirdar/api/tests/fake_cloudflare.py \
  sirdar/api/tests/test_deploy_cloudflare.py sirdar/api/tests/conftest.py
git commit -m "feat(sirdar): Cloudflare DNS client; tests can't make real HTTP requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Nginx Proxy Manager client and its fake

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/npm.py`
- Create: `sirdar/api/tests/fake_npm.py`
- Test: `sirdar/api/tests/test_deploy_npm.py`

**Interfaces:**
- Consumes: `NpmConfig` (Task 2); `Check`, `ConnectFailed`, `ConnectResult`.
- Produces (module `sirdar_api.deploy.npm`): `HOST_FIELDS` (the keys NPM accepts on create/update: `domain_names, forward_scheme, forward_host, forward_port, certificate_id, ssl_forced, hsts_enabled, hsts_subdomains, http2_support, block_exploits, caching_enabled, allow_websocket_upgrade, access_list_id, advanced_config, meta, locations`), `CERT_BACKOFF = (30, 60, 120, 240)`, `CERT_TIMEOUT = 300`; `class NpmError(Exception)` with `.reason`; `class NotFound(NpmError)`; frozen dataclasses `ProxyHost(id: int, domain_names: tuple[str, ...], forward_scheme: str, forward_host: str, forward_port: int, certificate_id: int, ssl_forced: bool, http2_support: bool, allow_websocket_upgrade: bool, raw: dict)` and `Certificate(id: int, provider: str, domain_names: tuple[str, ...], expires_on: datetime | None)`; `covers(cert, hostname) -> bool` (exact name or `*.<parent>`); `days_left(cert, now) -> float | None`; `parse_expiry(value) -> datetime | None`; `class Npm(cfg, *, transport=None, sleep=asyncio.sleep, backoff=CERT_BACKOFF)` — async context manager (logs in on enter) with `login()`, `version() -> str`, `proxy_hosts() -> list[ProxyHost]`, `create_host(body) -> ProxyHost`, `update_host(host_id, body) -> ProxyHost`, `delete_host(host_id) -> bool`, `certificates() -> list[Certificate]`, `request_certificate(domain, email, out=None) -> Certificate`, `renew_certificate(cert_id, domain, out=None) -> Certificate`, `delete_certificate(cert_id) -> bool`; `async test_connection(cfg, *, transport=None, now=None) -> ConnectResult`.
- Produces (tests): `tests/fake_npm.py` — `class FakeNpm(*, identity="admin@example.com", secret=NPM_PASSWORD, now=None)` with `.hosts`, `.certs`, `.requests`, `.certbot_busy: int`, `.challenge_fails: int`, `.cert_requests: list[list[str]]`, `.renewed: list[int]`, `.expire_tokens: bool`, `.down: bool`, `add_host(domain, forward_host, forward_port, **over) -> int`, `add_cert(domains, *, days=60, provider="letsencrypt") -> int`, `logins() -> int`, `transport()`.

- [ ] **Step 1: Write the fake**

Create `sirdar/api/tests/fake_npm.py`:

```python
"""A stand-in for the Nginx Proxy Manager REST API calls deploy/npm.py
makes: an httpx.MockTransport over in-memory proxy hosts and certificates.
Hosts and certificates share one id counter, as ids are only compared
within a kind."""

import itertools
import json
from datetime import UTC, datetime, timedelta

import httpx

from sirdar_api.deploy import npm

from .integration_helpers import NPM_PASSWORD

CERTBOT_BUSY = ("Command failed: certbot certonly ... Another instance of Certbot is already "
                "running.")
CHALLENGE_FAILED = "Some challenges have failed."


class FakeNpm:
    def __init__(self, *, identity: str = "admin@example.com", secret: str = NPM_PASSWORD,
                 now: datetime | None = None):
        self.identity, self.secret = identity, secret
        self.now = now or datetime.now(UTC)
        self.hosts: dict[int, dict] = {}
        self.certs: dict[int, dict] = {}
        self.requests: list[httpx.Request] = []
        self.tokens: set[str] = set()
        self.certbot_busy = 0          # the next N certificate calls collide with certbot
        self.challenge_fails = 0       # the next N fail Let's Encrypt's challenge
        self.cert_requests: list[list[str]] = []
        self.renewed: list[int] = []
        self.expire_tokens = False     # the next authenticated call finds its token expired
        self.down = False
        self._ids = itertools.count(1)

    def add_host(self, domain: str, forward_host: str, forward_port: int, **over) -> int:
        hid = next(self._ids)
        self.hosts[hid] = {
            "id": hid, "domain_names": [domain], "forward_scheme": "http",
            "forward_host": forward_host, "forward_port": forward_port, "certificate_id": 0,
            "ssl_forced": False, "hsts_enabled": False, "hsts_subdomains": False,
            "http2_support": False, "block_exploits": False, "caching_enabled": False,
            "allow_websocket_upgrade": False, "access_list_id": 0, "advanced_config": "",
            "enabled": True, "locations": [],
            "meta": {"letsencrypt_agree": False, "dns_challenge": False, "nginx_online": True,
                     "nginx_err": None},
            **over}
        return hid

    def add_cert(self, domains: list[str], *, days: float = 60,
                 provider: str = "letsencrypt") -> int:
        cid = next(self._ids)
        self.certs[cid] = {
            "id": cid, "provider": provider, "nice_name": domains[0],
            "domain_names": list(domains), "meta": {},
            "expires_on": (self.now + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")}
        return cid

    def logins(self) -> int:
        return sum(1 for r in self.requests if r.url.path == "/api/tokens")

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    @staticmethod
    def _error(status: int, message: str) -> httpx.Response:
        return httpx.Response(status, json={"error": {"code": status, "message": message}})

    def _certbot(self, domains: list[str]) -> httpx.Response | None:
        if self.certbot_busy:
            self.certbot_busy -= 1
            return self._error(500, CERTBOT_BUSY)
        if self.challenge_fails:
            self.challenge_fails -= 1
            return self._error(500, CHALLENGE_FAILED)
        return None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        path, method = request.url.path, request.method
        if path == "/api/tokens" and method == "POST":
            body = json.loads(request.content)
            if (body.get("identity"), body.get("secret")) != (self.identity, self.secret):
                return self._error(401, "Invalid email or password")
            token = f"tok-{next(self._ids)}"
            self.tokens.add(token)
            return httpx.Response(200, json={"token": token, "expires": "2026-10-05T00:00:00Z"})
        if path == "/api/" and method == "GET":
            return httpx.Response(200, json={"status": "OK",
                                             "version": {"major": 2, "minor": 12, "revision": 3}})
        if self.expire_tokens:
            self.tokens.clear()
            self.expire_tokens = False
        if request.headers.get("authorization", "").removeprefix("Bearer ") not in self.tokens:
            return self._error(401, "Token has expired")
        if path == "/api/nginx/proxy-hosts":
            if method == "GET":
                return httpx.Response(200, json=list(self.hosts.values()))
            body = json.loads(request.content)
            extra = sorted(set(body) - set(npm.HOST_FIELDS))
            if extra:
                return self._error(400, f"data should NOT have additional properties ({extra[0]})")
            rest = {k: v for k, v in body.items()
                    if k not in ("domain_names", "forward_host", "forward_port")}
            hid = self.add_host(body["domain_names"][0], body["forward_host"],
                                body["forward_port"], **rest)
            self.hosts[hid]["domain_names"] = list(body["domain_names"])
            return httpx.Response(201, json=self.hosts[hid])
        if path.startswith("/api/nginx/proxy-hosts/"):
            hid = int(path.rsplit("/", 1)[1])
            if hid not in self.hosts:
                return self._error(404, "Not Found")
            if method == "DELETE":
                del self.hosts[hid]
                return httpx.Response(200, json=True)
            body = json.loads(request.content)
            extra = sorted(set(body) - set(npm.HOST_FIELDS))
            if extra:
                return self._error(400, f"data should NOT have additional properties ({extra[0]})")
            self.hosts[hid].update(body)
            return httpx.Response(200, json=self.hosts[hid])
        if path == "/api/nginx/certificates":
            if method == "GET":
                return httpx.Response(200, json=list(self.certs.values()))
            body = json.loads(request.content)
            self.cert_requests.append(list(body["domain_names"]))
            failed = self._certbot(body["domain_names"])
            if failed is not None:
                return failed
            cid = self.add_cert(body["domain_names"], days=90)
            return httpx.Response(201, json=self.certs[cid])
        if path.startswith("/api/nginx/certificates/"):
            parts = path.removeprefix("/api/nginx/certificates/").split("/")
            cid = int(parts[0])
            if cid not in self.certs:
                return self._error(404, "Not Found")
            if method == "DELETE":
                del self.certs[cid]
                return httpx.Response(200, json=True)
            if parts[1:] == ["renew"] and method == "POST":
                failed = self._certbot(self.certs[cid]["domain_names"])
                if failed is not None:
                    return failed
                self.renewed.append(cid)
                self.certs[cid]["expires_on"] = (self.now + timedelta(days=90)).strftime(
                    "%Y-%m-%d %H:%M:%S")
                return httpx.Response(200, json=self.certs[cid])
        return self._error(404, "Not Found")
```

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_npm.py`:

```python
from datetime import UTC, datetime, timedelta

import pytest

from sirdar_api.deploy import ConnectFailed, npm
from sirdar_api.deploy.integrations import NpmConfig
from sirdar_api.deploy.npm import Certificate, Npm, NpmError

from .fake_npm import FakeNpm
from .integration_helpers import NPM_PASSWORD

CFG = NpmConfig(url="http://10.10.48.6:81", identity="admin@example.com",
                letsencrypt_email="ops@example.com", password=NPM_PASSWORD)
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


def _client(fake, sleeps=None, **kw) -> Npm:
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)
    return Npm(CFG, transport=fake.transport(), sleep=sleep, **kw)


async def test_login_and_reads():
    fake = FakeNpm(now=NOW)
    hid = fake.add_host("api.uat.serversherpa.com", "10.10.48.63", 8000, certificate_id=7)
    cid = fake.add_cert(["*.uat.serversherpa.com"], days=45)
    async with _client(fake) as api:
        assert await api.version() == "2.12.3"
        hosts = await api.proxy_hosts()
        certs = await api.certificates()
    assert [(h.id, h.domain_names, h.forward_host, h.forward_port, h.certificate_id)
            for h in hosts] == [(hid, ("api.uat.serversherpa.com",), "10.10.48.63", 8000, 7)]
    assert hosts[0].raw["meta"]["nginx_online"] is True
    assert [(c.id, c.provider, c.domain_names) for c in certs] == [
        (cid, "letsencrypt", ("*.uat.serversherpa.com",))]
    assert npm.days_left(certs[0], NOW) == pytest.approx(45)
    login = fake.requests[0]
    assert (login.method, str(login.url)) == ("POST", "http://10.10.48.6:81/api/tokens")
    assert all(NPM_PASSWORD not in r.headers.get("authorization", "") for r in fake.requests)


async def test_a_wrong_password_is_our_copy():
    fake = FakeNpm(secret="something-else")
    with pytest.raises(NpmError) as e:
        async with _client(fake):
            pass
    assert e.value.reason == "Nginx Proxy Manager rejected the login."
    assert NPM_PASSWORD not in str(e.value)


async def test_an_expired_token_logs_in_again_once():
    fake = FakeNpm()
    async with _client(fake) as api:
        fake.expire_tokens = True
        assert await api.proxy_hosts() == []
    assert fake.logins() == 2


async def test_unreachable():
    fake = FakeNpm()
    fake.down = True
    with pytest.raises(NpmError) as e:
        async with _client(fake):
            pass
    assert e.value.reason == "Couldn't reach Nginx Proxy Manager."


async def test_hosts_create_update_delete():
    fake = FakeNpm()
    async with _client(fake) as api:
        host = await api.create_host({"domain_names": ["api.uat2.serversherpa.com"],
                                      "forward_scheme": "http", "forward_host": "10.10.48.63",
                                      "forward_port": 8100, "allow_websocket_upgrade": True})
        assert (host.forward_port, host.allow_websocket_upgrade) == (8100, True)
        moved = await api.update_host(host.id, {**{k: host.raw[k] for k in npm.HOST_FIELDS},
                                                "forward_port": 8101})
        assert moved.forward_port == 8101
        with pytest.raises(NpmError) as e:
            await api.update_host(host.id, {"enabled": False})
        assert e.value.reason == "Nginx Proxy Manager answered with HTTP 400."
        assert await api.delete_host(host.id) is True
        assert await api.delete_host(host.id) is False


async def test_a_certificate_request_waits_out_certbot():
    fake = FakeNpm()
    fake.certbot_busy, fake.challenge_fails = 2, 1
    sleeps, lines = [], []
    async with _client(fake, sleeps) as api:
        cert = await api.request_certificate("api.uat2.serversherpa.com", "ops@example.com",
                                             out=lines.append)
    assert cert.domain_names == ("api.uat2.serversherpa.com",)
    assert sleeps == [30, 60, 120]
    assert lines == [
        "api.uat2.serversherpa.com: Certbot is busy (NPM's hourly renewal); trying again in 30 s\n",
        "api.uat2.serversherpa.com: Certbot is busy (NPM's hourly renewal); trying again in 60 s\n",
        "api.uat2.serversherpa.com: Let's Encrypt couldn't check the name yet; trying again in "
        "120 s\n",
    ]
    body = fake.requests[-1].read()
    assert b'"letsencrypt_email":"ops@example.com"' in body.replace(b" ", b"")
    assert b'"dns_challenge":false' in body.replace(b" ", b"")


async def test_a_certificate_request_gives_up_after_the_backoff():
    fake = FakeNpm()
    fake.certbot_busy = 99
    sleeps = []
    with pytest.raises(NpmError) as e:
        async with _client(fake, sleeps) as api:
            await api.request_certificate("api.uat2.serversherpa.com", "ops@example.com")
    assert sleeps == [30, 60, 120, 240]
    assert len(fake.cert_requests) == 5
    assert e.value.reason == (
        "Nginx Proxy Manager couldn't get a certificate for api.uat2.serversherpa.com. Check "
        "that the name resolves to the public IP and that port 80 reaches the proxy, then "
        "retry.")


async def test_renew_and_delete_certificates():
    fake = FakeNpm(now=NOW)
    cid = fake.add_cert(["api.uat.serversherpa.com"], days=5)
    fake.certbot_busy = 1
    sleeps = []
    async with _client(fake, sleeps) as api:
        renewed = await api.renew_certificate(cid, "api.uat.serversherpa.com")
        assert npm.days_left(renewed, NOW) == pytest.approx(90)
        assert await api.delete_certificate(cid) is True
        assert await api.delete_certificate(cid) is False
    assert (fake.renewed, sleeps) == ([cid], [30])


def test_covers_and_expiry_parsing():
    cert = Certificate(id=1, provider="letsencrypt", domain_names=("*.uat.serversherpa.com",),
                       expires_on=None)
    assert npm.covers(cert, "api.uat.serversherpa.com")
    assert not npm.covers(cert, "api.uat2.serversherpa.com")
    assert not npm.covers(cert, "a.b.uat.serversherpa.com")
    assert npm.days_left(cert, NOW) is None
    assert npm.parse_expiry("2026-12-30 10:00:00") == datetime(2026, 12, 30, 10, tzinfo=UTC)
    assert npm.parse_expiry("2026-12-30T10:00:00.000Z") == datetime(2026, 12, 30, 10,
                                                                    tzinfo=UTC)
    assert npm.parse_expiry("") is None and npm.parse_expiry("soon") is None


async def test_connection_test():
    fake = FakeNpm(now=NOW)
    fake.add_host("api.uat.serversherpa.com", "10.10.48.63", 8000)
    fake.add_cert(["api.uat.serversherpa.com"], days=80)
    fake.add_cert(["kiosk.uat.serversherpa.com"], days=10)
    result = await npm.test_connection(CFG, transport=fake.transport(), now=NOW)
    assert result.target == "npm"
    assert [(c.label, c.status, c.value) for c in result.checks] == [
        ("Login", "pass", "admin@example.com"), ("Version", "pass", "2.12.3"),
        ("Proxy hosts", "pass", "1"),
        ("Certificates", "warn", "2, 1 expiring within 30 days"),
    ]
    assert result.facts == {"url": "http://10.10.48.6:81", "version": "2.12.3",
                            "proxy_hosts": 1, "certificates": 2}
    fake.secret = "changed-password"
    with pytest.raises(ConnectFailed) as e:
        await npm.test_connection(CFG, transport=fake.transport())
    assert e.value.reason == "Nginx Proxy Manager rejected the login."


def test_expiry_math_is_in_days():
    later = NOW + timedelta(days=31, hours=12)
    cert = Certificate(id=1, provider="other", domain_names=("x.y.z",), expires_on=later)
    assert npm.days_left(cert, NOW) == pytest.approx(31.5)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_npm.py`
Expected: FAIL — `ImportError` (no `npm` module; `fake_npm` imports it too).

- [ ] **Step 4: Write the client**

Create `sirdar/api/src/sirdar_api/deploy/npm.py`:

```python
"""Nginx Proxy Manager for publishing (spec Section 2 step 13): proxy hosts
and Let's Encrypt certificates over NPM's REST API (<url>/api).

Logs in with the stored email and password (POST /api/tokens) and once more
when a call answers 401. NPM's hourly certbot renew can hold certbot's lock
("Another instance of Certbot is already running"), and a name Cloudflare
just published may not be visible to Let's Encrypt yet ("Some challenges
have failed"): certificate requests that fail for those reasons are retried
after each CERT_BACKOFF wait. The password goes only into the login body;
errors carry our own copy, never NPM's or httpx's text."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult
from sirdar_api.deploy.integrations import NpmConfig

HOST_FIELDS = ("domain_names", "forward_scheme", "forward_host", "forward_port",
               "certificate_id", "ssl_forced", "hsts_enabled", "hsts_subdomains",
               "http2_support", "block_exploits", "caching_enabled", "allow_websocket_upgrade",
               "access_list_id", "advanced_config", "meta", "locations")
CERT_BACKOFF = (30, 60, 120, 240)
CERT_TIMEOUT = 300
TIMEOUT = 30
RENEW_DAYS = 30
_RETRYABLE = {
    "Another instance of Certbot is already running": "Certbot is busy (NPM's hourly renewal)",
    "Some challenges have failed": "Let's Encrypt couldn't check the name yet",
}
_UNREACHABLE = "Couldn't reach Nginx Proxy Manager."
_TIMED_OUT = "Nginx Proxy Manager didn't answer in time."
_BAD_LOGIN = "Nginx Proxy Manager rejected the login."
_UNEXPECTED = "Nginx Proxy Manager sent a response Sirdar didn't understand."


class NpmError(Exception):
    """`reason` is user-facing copy we wrote."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class NotFound(NpmError):
    def __init__(self):
        super().__init__("Nginx Proxy Manager has no such item.")


class _Retryable(NpmError):
    def __init__(self, why: str):
        super().__init__(why)
        self.why = why


@dataclass(frozen=True)
class ProxyHost:
    id: int
    domain_names: tuple[str, ...]
    forward_scheme: str
    forward_host: str
    forward_port: int
    certificate_id: int
    ssl_forced: bool
    http2_support: bool
    allow_websocket_upgrade: bool
    raw: dict = field(repr=False, compare=False)


@dataclass(frozen=True)
class Certificate:
    id: int
    provider: str
    domain_names: tuple[str, ...]
    expires_on: datetime | None


def parse_expiry(value) -> datetime | None:
    """NPM writes "YYYY-MM-DD HH:MM:SS" (UTC); accept ISO too."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace(" ", "T").removesuffix("Z"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def covers(cert: Certificate, hostname: str) -> bool:
    """The certificate names the host, or is a wildcard for its parent."""
    parent = hostname.split(".", 1)[1] if "." in hostname else ""
    return hostname in cert.domain_names or (bool(parent) and f"*.{parent}" in cert.domain_names)


def days_left(cert: Certificate, now: datetime) -> float | None:
    if cert.expires_on is None:
        return None
    return (cert.expires_on - now).total_seconds() / 86400


def _host(raw) -> ProxyHost:
    try:
        return ProxyHost(
            id=int(raw["id"]), domain_names=tuple(str(d).lower() for d in raw["domain_names"]),
            forward_scheme=str(raw.get("forward_scheme") or "http"),
            forward_host=str(raw["forward_host"]), forward_port=int(raw["forward_port"]),
            certificate_id=int(raw.get("certificate_id") or 0),
            ssl_forced=bool(raw.get("ssl_forced")), http2_support=bool(raw.get("http2_support")),
            allow_websocket_upgrade=bool(raw.get("allow_websocket_upgrade")), raw=dict(raw))
    except (KeyError, TypeError, ValueError, AttributeError):
        raise NpmError(_UNEXPECTED) from None


def _certificate(raw) -> Certificate:
    try:
        return Certificate(id=int(raw["id"]), provider=str(raw.get("provider") or ""),
                           domain_names=tuple(str(d).lower() for d in raw["domain_names"]),
                           expires_on=parse_expiry(raw.get("expires_on")))
    except (KeyError, TypeError, ValueError, AttributeError):
        raise NpmError(_UNEXPECTED) from None


def _message(resp: httpx.Response) -> str:
    try:
        error = resp.json().get("error")
        return str(error.get("message") or "") if isinstance(error, dict) else ""
    except (ValueError, AttributeError):
        return ""


def _cert_failed(domain: str) -> str:
    return (f"Nginx Proxy Manager couldn't get a certificate for {domain}. Check that the name "
            "resolves to the public IP and that port 80 reaches the proxy, then retry.")


class Npm:
    """`async with Npm(cfg, transport=...) as api:` — logs in on enter."""

    def __init__(self, cfg: NpmConfig, *, transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 backoff: tuple[int, ...] = CERT_BACKOFF):
        self.cfg = cfg
        self._transport = transport
        self._sleep = sleep
        self._backoff = backoff
        self._client: httpx.AsyncClient | None = None
        self._token = ""

    async def __aenter__(self) -> "Npm":
        self._client = httpx.AsyncClient(base_url=self.cfg.url + "/api", timeout=TIMEOUT,
                                         transport=self._transport)
        try:
            await self.login()
        except BaseException:
            await self._client.aclose()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def login(self) -> None:
        try:
            resp = await self._client.post("/tokens", json={"identity": self.cfg.identity,
                                                            "secret": self.cfg.password})
        except httpx.TimeoutException:
            raise NpmError(_TIMED_OUT) from None
        except httpx.HTTPError:
            raise NpmError(_UNREACHABLE) from None
        if resp.status_code in (400, 401, 403):
            raise NpmError(_BAD_LOGIN)
        if resp.status_code != 200:
            raise NpmError(f"Nginx Proxy Manager answered with HTTP {resp.status_code}.")
        try:
            token = resp.json().get("token")
        except (ValueError, AttributeError):
            token = None
        if not isinstance(token, str) or not token:
            raise NpmError(_UNEXPECTED)
        self._token = token

    async def _call(self, method: str, path: str, *, json=None, timeout: float = TIMEOUT,
                    again: bool = True):
        try:
            resp = await self._client.request(
                method, path, json=json, timeout=timeout,
                headers={"Authorization": f"Bearer {self._token}"})
        except httpx.TimeoutException:
            raise NpmError(_TIMED_OUT) from None
        except httpx.HTTPError:
            raise NpmError(_UNREACHABLE) from None
        if resp.status_code == 401 and again:
            await self.login()
            return await self._call(method, path, json=json, timeout=timeout, again=False)
        if resp.status_code == 404:
            raise NotFound()
        if resp.status_code >= 400:
            message = _message(resp)
            for marker, why in _RETRYABLE.items():
                if marker in message:
                    raise _Retryable(why)
            raise NpmError(f"Nginx Proxy Manager answered with HTTP {resp.status_code}.")
        try:
            return resp.json()
        except ValueError:
            raise NpmError(_UNEXPECTED) from None

    async def version(self) -> str:
        body = await self._call("GET", "/")
        try:
            v = body["version"]
            return f"{int(v['major'])}.{int(v['minor'])}.{int(v['revision'])}"
        except (KeyError, TypeError, ValueError):
            raise NpmError(_UNEXPECTED) from None

    async def proxy_hosts(self) -> list[ProxyHost]:
        body = await self._call("GET", "/nginx/proxy-hosts")
        if not isinstance(body, list):
            raise NpmError(_UNEXPECTED)
        return [_host(h) for h in body]

    async def create_host(self, body: dict) -> ProxyHost:
        return _host(await self._call("POST", "/nginx/proxy-hosts", json=body))

    async def update_host(self, host_id: int, body: dict) -> ProxyHost:
        return _host(await self._call("PUT", f"/nginx/proxy-hosts/{int(host_id)}", json=body))

    async def delete_host(self, host_id: int) -> bool:
        """False when the host was already gone."""
        try:
            await self._call("DELETE", f"/nginx/proxy-hosts/{int(host_id)}")
        except NotFound:
            return False
        return True

    async def certificates(self) -> list[Certificate]:
        body = await self._call("GET", "/nginx/certificates")
        if not isinstance(body, list):
            raise NpmError(_UNEXPECTED)
        return [_certificate(c) for c in body]

    async def _certbot(self, domain: str, out: Callable[[str], None] | None,
                       attempt: Callable[[], Awaitable]) -> Certificate:
        for wait in (*self._backoff, None):
            try:
                return _certificate(await attempt())
            except _Retryable as e:
                if wait is None:
                    break
                if out is not None:
                    out(f"{domain}: {e.why}; trying again in {wait} s\n")
                await self._sleep(wait)
        raise NpmError(_cert_failed(domain))

    async def request_certificate(self, domain: str, email: str,
                                  out: Callable[[str], None] | None = None) -> Certificate:
        body = {"provider": "letsencrypt", "domain_names": [domain],
                "meta": {"letsencrypt_email": email, "letsencrypt_agree": True,
                         "dns_challenge": False}}
        return await self._certbot(domain, out, lambda: self._call(
            "POST", "/nginx/certificates", json=body, timeout=CERT_TIMEOUT))

    async def renew_certificate(self, cert_id: int, domain: str,
                                out: Callable[[str], None] | None = None) -> Certificate:
        return await self._certbot(domain, out, lambda: self._call(
            "POST", f"/nginx/certificates/{int(cert_id)}/renew", timeout=CERT_TIMEOUT))

    async def delete_certificate(self, cert_id: int) -> bool:
        """False when the certificate was already gone."""
        try:
            await self._call("DELETE", f"/nginx/certificates/{int(cert_id)}")
        except NotFound:
            return False
        return True


async def test_connection(cfg: NpmConfig, *, transport: httpx.AsyncBaseTransport | None = None,
                          now: datetime | None = None) -> ConnectResult:
    """Read-only: log in, read the version, count hosts and certificates."""
    try:
        async with Npm(cfg, transport=transport) as api:
            version = await api.version()
            hosts = await api.proxy_hosts()
            certs = await api.certificates()
    except NpmError as e:
        raise ConnectFailed(e.reason) from None
    now = now or datetime.now(UTC)
    soon = [c for c in certs if (left := days_left(c, now)) is not None and left <= RENEW_DAYS]
    checks = [
        Check("Login", "pass", cfg.identity),
        Check("Version", "pass", version),
        Check("Proxy hosts", "pass", str(len(hosts))),
        Check("Certificates", "warn" if soon else "pass",
              f"{len(certs)}, {len(soon)} expiring within {RENEW_DAYS} days"),
    ]
    return ConnectResult(ok=True, target="npm", checks=checks, facts={
        "url": cfg.url, "version": version, "proxy_hosts": len(hosts),
        "certificates": len(certs)})


test_connection.__test__ = False  # not a pytest test, despite the name
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_npm.py`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/npm.py tests/fake_npm.py tests/test_deploy_npm.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/npm.py sirdar/api/tests/fake_npm.py \
  sirdar/api/tests/test_deploy_npm.py
git commit -m "feat(sirdar): Nginx Proxy Manager client with certbot-collision retries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Integrations API — read, save, remove, test

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/outbound.py`
- Create: `sirdar/api/src/sirdar_api/api/routes/integrations.py`
- Modify: `sirdar/api/src/sirdar_api/api/app.py`
- Test: `sirdar/api/tests/test_deploy_integrations_api.py`

**Interfaces:**
- Consumes: `integrations.*` (Task 2), `cloudflare.test_connection` (Task 3), `npm.test_connection` (Task 4).
- Produces (module `sirdar_api.deploy.outbound`): `KINDS = ("cloudflare", "npm", "smoke")`; `transports() -> dict[str, httpx.AsyncBaseTransport | None]` (all None = real HTTP). Every outbound caller reads its transport from `outbound.transports()[kind]` at call time; tests `monkeypatch.setattr(outbound, "transports", ...)`.
- Produces (routes): the integration endpoints under "API produced for 4b"; audit actions `deploy.integration_update` `{kind, changed}`, `deploy.integration_remove` `{kind}`, `deploy.integration_test` `{kind, ok}`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_integrations_api.py`:

```python
import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import outbound

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .fake_cloudflare import FakeCloudflare
from .fake_npm import FakeNpm
from .integration_helpers import CF_TOKEN, NPM_PASSWORD

URL = "/api/deploy/integrations"
CF_BODY = {"zone": "serversherpa.com", "public_ip": "203.0.113.7", "token": CF_TOKEN}
NPM_BODY = {"url": "http://10.10.48.6:81", "identity": "admin@example.com",
            "password": NPM_PASSWORD}


@pytest.fixture
def fakes(monkeypatch):
    cf, proxy = FakeCloudflare(), FakeNpm()
    monkeypatch.setattr(outbound, "transports", lambda: {
        "cloudflare": cf.transport(), "npm": proxy.transport(), "smoke": None})
    return cf, proxy


@pytest.fixture
async def leaks(client, db):
    """No response body and no audit row this test produced holds a secret."""
    seen: list[str] = []

    async def record(response):
        await response.aread()
        seen.append(response.text)

    client.event_hooks["response"].append(record)
    yield
    await db.rollback()
    audits = [repr(c) for c in await db.scalars(select(AuditLog.changes))]
    assert seen
    for text in seen + audits:
        assert CF_TOKEN not in text and NPM_PASSWORD not in text


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_permissions(client, db, secrets_key):
    assert (await client.get(URL)).status_code == 401
    viewer = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(URL, headers=viewer)).status_code == 200
    for method, path, body in (("PUT", "/cloudflare", CF_BODY), ("PUT", "/npm", NPM_BODY),
                               ("DELETE", "/npm", None), ("POST", "/cloudflare/test", None),
                               ("POST", "/npm/test", None)):
        resp = await client.request(method, URL + path, headers=viewer, json=body)
        assert resp.status_code == 403, path


async def test_save_read_and_keep_the_secret(client, db, secrets_key, leaks):
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/cloudflare", headers=h, json=CF_BODY)
    assert resp.status_code == 200
    cf = resp.json()["cloudflare"]
    assert (cf["configured"], cf["zone"], cf["public_ip"], cf["token_set"],
            cf["updated_by_name"]) == (True, "serversherpa.com", "203.0.113.7", True, "Boss User")
    resp = await client.put(f"{URL}/cloudflare", headers=h,
                            json={"zone": "serversherpa.com", "public_ip": "203.0.113.8"})
    assert resp.json()["cloudflare"]["token_set"] is True
    resp = await client.put(f"{URL}/npm", headers=h, json=NPM_BODY)
    assert resp.json()["npm"] | {"updated_at": None} == {
        "configured": True, "url": "http://10.10.48.6:81", "identity": "admin@example.com",
        "letsencrypt_email": "admin@example.com", "password_set": True, "updated_at": None,
        "updated_by_name": "Boss User"}
    assert resp.json()["secrets_key_configured"] is True
    assert await _audits(db, "deploy.integration_update") == [
        {"kind": "cloudflare", "changed": ["zone", "public_ip", "token"]},
        {"kind": "cloudflare", "changed": ["public_ip"]},
        {"kind": "npm", "changed": ["url", "identity", "letsencrypt_email", "password"]},
    ]


@pytest.mark.parametrize("path, body, status, code", [
    ("/cloudflare", {**CF_BODY, "public_ip": "nope"}, 422, "public_ip_invalid"),
    ("/cloudflare", {**CF_BODY, "zone": "-bad-"}, 422, "zone_invalid"),
    ("/cloudflare", {"zone": "serversherpa.com", "public_ip": "203.0.113.7"}, 422,
     "secret_required"),
    ("/cloudflare", {**CF_BODY, "token": "bad token"}, 422, "token_invalid"),
    ("/npm", {**NPM_BODY, "url": "ftp://npm"}, 422, "npm_url_invalid"),
    ("/npm", {**NPM_BODY, "identity": "admin"}, 422, "identity_invalid"),
    ("/npm", {**NPM_BODY, "password": ""}, 422, "password_invalid"),
])
async def test_save_errors(client, db, secrets_key, leaks, path, body, status, code):
    h = await auth_headers(client, db)
    resp = await client.put(URL + path, headers=h, json=body)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (status, code)
    assert await _audits(db, "deploy.integration_update") == []


async def test_saving_a_secret_needs_the_secrets_key(client, db, monkeypatch, leaks):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/cloudflare", headers=h, json=CF_BODY)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (400, "secrets_key_missing")
    assert (await client.get(URL, headers=h)).json()["secrets_key_configured"] is False
    get_settings.cache_clear()


async def test_remove(client, db, secrets_key, leaks):
    h = await auth_headers(client, db)
    await client.put(f"{URL}/npm", headers=h, json=NPM_BODY)
    assert (await client.delete(f"{URL}/npm", headers=h)).status_code == 204
    resp = await client.delete(f"{URL}/npm", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (404, "integration_not_found")
    assert (await client.delete(f"{URL}/route53", headers=h)).status_code == 422
    assert await _audits(db, "deploy.integration_remove") == [{"kind": "npm"}]
    assert (await client.get(URL, headers=h)).json()["npm"]["configured"] is False


async def test_test_with_saved_and_unsaved_values(client, db, secrets_key, fakes, leaks):
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/cloudflare/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["cloudflare"]})
    resp = await client.post(f"{URL}/cloudflare/test", headers=h, json=CF_BODY)
    assert resp.status_code == 200
    assert (resp.json()["target"], resp.json()["checks"][0]["label"]) == ("cloudflare", "Zone")
    assert (await client.get(URL, headers=h)).json()["cloudflare"]["configured"] is False
    await client.put(f"{URL}/npm", headers=h, json=NPM_BODY)
    resp = await client.post(f"{URL}/npm/test", headers=h)
    assert (resp.status_code, resp.json()["facts"]["version"]) == (200, "2.12.3")
    resp = await client.post(f"{URL}/npm/test", headers=h,
                             json={**NPM_BODY, "password": None, "identity": "ops@example.com"})
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": "Nginx Proxy Manager rejected the login."})
    resp = await client.post(f"{URL}/npm/test", headers=h, json={**NPM_BODY, "url": "x"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "npm_url_invalid")
    assert await _audits(db, "deploy.integration_test") == [
        {"kind": "cloudflare", "ok": True}, {"kind": "npm", "ok": True},
        {"kind": "npm", "ok": False}]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_integrations_api.py`
Expected: FAIL — `ImportError: cannot import name 'outbound'`.

- [ ] **Step 3: Write the transport switch**

Create `sirdar/api/src/sirdar_api/deploy/outbound.py`:

```python
"""The one switch for Sirdar's outbound HTTP to publish environments
(Cloudflare, Nginx Proxy Manager, smoke tests): every client gets its
transport from transports() when it is built. None means httpx's real
transport; tests replace this function with fakes (and a conftest guard
fails any real request)."""

import httpx

KINDS = ("cloudflare", "npm", "smoke")


def transports() -> dict[str, httpx.AsyncBaseTransport | None]:
    return {kind: None for kind in KINDS}
```

- [ ] **Step 4: Write the routes**

Create `sirdar/api/src/sirdar_api/api/routes/integrations.py`:

```python
"""Settings › Integrations: the Cloudflare and Nginx Proxy Manager
credentials Sirdar publishes environments with. Secrets are write-only: no
response, log line or audit row carries one (audits list the names of the
fields that changed), and the request models put no constraint on them, so
no validation error can describe one."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from sirdar_api.api.deps import AuthContext, DbSession, client_ip, require_permission
from sirdar_api.config import get_settings
from sirdar_api.deploy import ConnectFailed, cloudflare, integrations, npm, outbound
from sirdar_api.deploy.integrations import IntegrationError
from sirdar_api.services.audit import audit

router = APIRouter(prefix="/deploy/integrations", tags=["deploy"])

Kind = Literal["cloudflare", "npm"]
TESTERS = {"cloudflare": cloudflare.test_connection, "npm": npm.test_connection}
_STATUS = {"secrets_key_missing": 400, "integration_unreadable": 409}


class CloudflareIn(BaseModel):
    zone: str = Field(default=integrations.DEFAULT_ZONE, max_length=253)
    public_ip: str = Field(max_length=45)
    token: str | None = None


class NpmIn(BaseModel):
    url: str = Field(max_length=300)
    identity: str = Field(max_length=254)
    letsencrypt_email: str = Field(default="", max_length=254)
    password: str | None = None


def _http(e: IntegrationError) -> HTTPException:
    return HTTPException(status_code=_STATUS.get(e.code, 422), detail={"code": e.code, **e.extra})


def _cloudflare_values(body: CloudflareIn) -> dict:
    return {"zone": body.zone, "public_ip": body.public_ip}


def _npm_values(body: NpmIn) -> dict:
    return {"url": body.url, "identity": body.identity,
            "letsencrypt_email": body.letsencrypt_email}


@router.get("")
async def read_integrations(db: DbSession,
                            actor: AuthContext = require_permission("deploy", "view")):
    return await integrations.public(db, get_settings())


async def _save(kind: str, values: dict, secret: str | None, request: Request, db,
                actor: AuthContext) -> dict:
    try:
        changed = await integrations.save(db, get_settings(), kind, values, secret,
                                          actor.user.person_id)
    except IntegrationError as e:
        await db.rollback()
        raise _http(e) from None
    if changed:
        audit(db, actor_id=actor.user.person_id, action="deploy.integration_update",
              entity_type="integration", entity_id=kind, ip=client_ip(request),
              changes={"kind": kind, "changed": changed})
        await db.commit()
    return await integrations.public(db, get_settings())


@router.put("/cloudflare")
async def save_cloudflare(body: CloudflareIn, request: Request, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "change")):
    return await _save("cloudflare", _cloudflare_values(body), body.token, request, db, actor)


@router.put("/npm")
async def save_npm(body: NpmIn, request: Request, db: DbSession,
                   actor: AuthContext = require_permission("deploy", "change")):
    return await _save("npm", _npm_values(body), body.password, request, db, actor)


@router.delete("/{kind}", status_code=204)
async def remove_integration(kind: Kind, request: Request, db: DbSession,
                             actor: AuthContext = require_permission("deploy", "change")):
    if not await integrations.remove(db, kind):
        raise HTTPException(status_code=404, detail={"code": "integration_not_found"})
    audit(db, actor_id=actor.user.person_id, action="deploy.integration_remove",
          entity_type="integration", entity_id=kind, ip=client_ip(request),
          changes={"kind": kind})
    await db.commit()
    return Response(status_code=204)


async def _test(kind: str, values: dict | None, secret: str | None, request: Request, db,
                actor: AuthContext) -> dict:
    """The saved settings (no body), or unsaved values with the given secret
    or else the stored one. Read-only calls only."""
    settings = get_settings()
    try:
        cfg = (await integrations.load(db, settings, kind) if values is None
               else await integrations.candidate(db, settings, kind, values, secret))
    except IntegrationError as e:
        raise _http(e) from None
    if cfg is None:
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": [kind]})

    def record(ok: bool) -> None:
        audit(db, actor_id=actor.user.person_id, action="deploy.integration_test",
              entity_type="integration", entity_id=kind, ip=client_ip(request),
              changes={"kind": kind, "ok": ok})

    try:
        result = await TESTERS[kind](cfg, transport=outbound.transports()[kind])
    except ConnectFailed as e:
        record(False)
        await db.commit()
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    record(True)
    await db.commit()
    return result.as_dict()


@router.post("/cloudflare/test")
async def check_cloudflare(request: Request, db: DbSession, body: CloudflareIn | None = None,
                           actor: AuthContext = require_permission("deploy", "change")):
    return await _test("cloudflare", _cloudflare_values(body) if body else None,
                       body.token if body else None, request, db, actor)


@router.post("/npm/test")
async def check_npm(request: Request, db: DbSession, body: NpmIn | None = None,
                    actor: AuthContext = require_permission("deploy", "change")):
    return await _test("npm", _npm_values(body) if body else None,
                       body.password if body else None, request, db, actor)
```

- [ ] **Step 5: Register the router**

In `sirdar/api/src/sirdar_api/api/app.py`, replace:

```python
    from sirdar_api.api.routes import access, audit, auth, dashboard, deploy, me, system, users
    from sirdar_api.api.routes import settings as settings_routes
```

with:

```python
    from sirdar_api.api.routes import access, audit, auth, dashboard, deploy, me, system, users
    from sirdar_api.api.routes import integrations as integration_routes
    from sirdar_api.api.routes import settings as settings_routes
```

and replace:

```python
    api.include_router(deploy.router)
    api.include_router(dashboard.router)
```

with:

```python
    api.include_router(deploy.router)
    api.include_router(integration_routes.router)
    api.include_router(dashboard.router)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_integrations_api.py`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/outbound.py src/sirdar_api/api/routes/integrations.py \
  src/sirdar_api/api/app.py tests/test_deploy_integrations_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/outbound.py \
  sirdar/api/src/sirdar_api/api/routes/integrations.py sirdar/api/src/sirdar_api/api/app.py \
  sirdar/api/tests/test_deploy_integrations_api.py
git commit -m "feat(sirdar): integration credential routes with write-only secrets and Test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: The smoke test module

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/smoke.py`
- Create: `sirdar/api/tests/fake_smoke.py`
- Test: `sirdar/api/tests/test_deploy_smoke.py`

**Interfaces:**
- Produces (module `sirdar_api.deploy.smoke`): `PATHS = {"api": "/healthz", "portal": "/", "kiosk": "/", "wiki": "/healthz", "spaces": "/healthz", "status": "/healthz"}`, `ATTEMPTS = 6`, `DELAY = 10`, `TIMEOUT = 10`; frozen dataclass `SmokeResult(service, url, ok: bool, detail: str)`; `async run(targets: list[tuple[str, str]], proxy_ip: str, *, transport=None, sleep=asyncio.sleep, attempts=ATTEMPTS, delay=DELAY, out=None) -> list[SmokeResult]` (targets are `(service, hostname)`; results in the same order).
- Produces (tests): `tests/fake_smoke.py` — `class FakeSmoke(default=200)` with `.requests`, `set(hostname, *answers)` (an int status, or `"tls"`, `"down"`, `"slow"`; the last answer repeats), `transport()`.

- [ ] **Step 1: Write the fake**

Create `sirdar/api/tests/fake_smoke.py`:

```python
"""Answers the smoke test's requests by their Host header: a status code,
or "tls" (certificate didn't verify), "down" (refused) or "slow" (timeout).
Each hostname's answers are used in turn; the last one repeats."""

import httpx


class FakeSmoke:
    def __init__(self, default: int = 200):
        self.default = default
        self.answers: dict[str, list] = {}
        self.requests: list[httpx.Request] = []

    def set(self, hostname: str, *answers) -> None:
        self.answers[hostname] = list(answers)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        queue = self.answers.get(request.headers["host"])
        answer = (queue.pop(0) if len(queue) > 1 else queue[0]) if queue else self.default
        if answer == "tls":
            raise httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed",
                                     request=request)
        if answer == "down":
            raise httpx.ConnectError("[Errno 111] Connection refused", request=request)
        if answer == "slow":
            raise httpx.ReadTimeout("timed out", request=request)
        return httpx.Response(answer)
```

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_smoke.py`:

```python
import pytest

from sirdar_api.deploy import smoke

from .fake_smoke import FakeSmoke

TARGETS = [("api", "api.uat2.serversherpa.com"), ("portal", "portal.uat2.serversherpa.com"),
           ("spaces", "spaces.uat2.serversherpa.com")]


async def _run(fake, sleeps=None, lines=None, **kw):
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)
    return await smoke.run(TARGETS, "10.10.48.6", transport=fake.transport(), sleep=sleep,
                           out=lines.append if lines is not None else None, **kw)


async def test_every_url_goes_to_the_proxy_with_sni_and_host():
    fake = FakeSmoke()
    results = await _run(fake)
    assert [(r.service, r.url, r.ok, r.detail) for r in results] == [
        ("api", "https://api.uat2.serversherpa.com/healthz", True, "HTTP 200"),
        ("portal", "https://portal.uat2.serversherpa.com/", True, "HTTP 200"),
        ("spaces", "https://spaces.uat2.serversherpa.com/healthz", True, "HTTP 200"),
    ]
    first = fake.requests[0]
    assert str(first.url) == "https://10.10.48.6/healthz"
    assert first.headers["host"] == "api.uat2.serversherpa.com"
    assert first.extensions["sni_hostname"] == "api.uat2.serversherpa.com"


async def test_redirects_pass_and_errors_fail():
    fake = FakeSmoke()
    fake.set("api.uat2.serversherpa.com", 301)
    fake.set("portal.uat2.serversherpa.com", 404)
    fake.set("spaces.uat2.serversherpa.com", "tls")
    results = await _run(fake, attempts=1)
    assert [(r.ok, r.detail) for r in results] == [
        (True, "HTTP 301"), (False, "HTTP 404"), (False, "the certificate didn't verify")]
    fake.set("portal.uat2.serversherpa.com", "down")
    fake.set("spaces.uat2.serversherpa.com", "slow")
    results = await _run(fake, attempts=1)
    assert [r.detail for r in results[1:]] == ["couldn't connect to the proxy",
                                               "no answer within 10 s"]


async def test_failures_are_retried_until_they_answer():
    fake = FakeSmoke()
    fake.set("portal.uat2.serversherpa.com", "down", 502, 200)
    sleeps, lines = [], []
    results = await _run(fake, sleeps, lines)
    assert all(r.ok for r in results)
    assert sleeps == [10, 10]
    assert lines == ["Waiting 10 s, then trying portal again (2 of 6)\n",
                     "Waiting 10 s, then trying portal again (3 of 6)\n"]
    hosts = [r.headers["host"] for r in fake.requests]
    assert hosts.count("api.uat2.serversherpa.com") == 1          # passed URLs aren't re-asked


async def test_gives_up_after_the_last_attempt():
    fake = FakeSmoke()
    fake.set("spaces.uat2.serversherpa.com", 502)
    sleeps = []
    results = await _run(fake, sleeps)
    assert (results[2].ok, results[2].detail) == (False, "HTTP 502")
    assert sleeps == [10] * 5


async def test_the_guard_stops_real_requests():
    with pytest.raises(AssertionError, match="real HTTP request"):
        await smoke.run(TARGETS[:1], "10.10.48.6", attempts=1)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_smoke.py`
Expected: FAIL — `ImportError: cannot import name 'smoke'`.

- [ ] **Step 4: Write the module**

Create `sirdar/api/src/sirdar_api/deploy/smoke.py`:

```python
"""Smoke test after a publish (spec Section 2 step 14): every public URL
answers over HTTPS. Requests go to the environment's proxy IP (NPM on the
LAN) with SNI and Host set to the public name, so the check covers NPM, the
certificate (verified against that name) and the app without depending on
the router's hairpin NAT — the reason the stacks map these names to NPM in
extra_hosts too. Redirects are not followed: 200–399 passes. Details are
our own copy, never httpx's text."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

PATHS = {"api": "/healthz", "portal": "/", "kiosk": "/", "wiki": "/healthz",
         "spaces": "/healthz", "status": "/healthz"}
ATTEMPTS = 6
DELAY = 10
TIMEOUT = 10


@dataclass(frozen=True)
class SmokeResult:
    service: str
    url: str
    ok: bool
    detail: str


async def _check(client: httpx.AsyncClient, proxy_ip: str, service: str,
                 hostname: str) -> SmokeResult:
    path = PATHS.get(service, "/")
    url = f"https://{hostname}{path}"
    try:
        resp = await client.get(f"https://{proxy_ip}{path}", headers={"Host": hostname},
                                extensions={"sni_hostname": hostname})
    except httpx.TimeoutException:
        return SmokeResult(service, url, False, f"no answer within {TIMEOUT} s")
    except httpx.ConnectError as e:
        text = str(e).upper()
        tls = "CERTIFICATE" in text or "SSL" in text      # branch only; never shown
        return SmokeResult(service, url, False, "the certificate didn't verify" if tls
                           else "couldn't connect to the proxy")
    except httpx.HTTPError:
        return SmokeResult(service, url, False, "the request failed")
    return SmokeResult(service, url, 200 <= resp.status_code < 400, f"HTTP {resp.status_code}")


async def run(targets: list[tuple[str, str]], proxy_ip: str, *,
              transport: httpx.AsyncBaseTransport | None = None,
              sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
              attempts: int = ATTEMPTS, delay: float = DELAY,
              out: Callable[[str], None] | None = None) -> list[SmokeResult]:
    """Check each (service, hostname); failures are asked again, up to
    `attempts` rounds `delay` seconds apart (NPM may still be reloading)."""
    results: dict[str, SmokeResult] = {}
    pending = list(targets)
    async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport,
                                 follow_redirects=False) as client:
        for attempt in range(1, attempts + 1):
            failed = []
            for service, hostname in pending:
                result = await _check(client, proxy_ip, service, hostname)
                results[service] = result
                if not result.ok:
                    failed.append((service, hostname))
            pending = failed
            if not pending or attempt == attempts:
                break
            if out is not None:
                names = ", ".join(service for service, _ in pending)
                out(f"Waiting {delay:g} s, then trying {names} again "
                    f"({attempt + 1} of {attempts})\n")
            await sleep(delay)
    return [results[service] for service, _ in targets]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_smoke.py`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/smoke.py tests/fake_smoke.py tests/test_deploy_smoke.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/smoke.py sirdar/api/tests/fake_smoke.py \
  sirdar/api/tests/test_deploy_smoke.py
git commit -m "feat(sirdar): smoke test of public URLs through the proxy's LAN IP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Publish planning, the Publish tab's inspection, and Claim

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/publish.py`
- Create: `sirdar/api/tests/publish_helpers.py`
- Test: `sirdar/api/tests/test_deploy_publish.py`

**Interfaces:**
- Consumes: `integrations.load_cloudflare/load_npm/is_configured`, `IntegrationError` (Task 2); `Cloudflare`, `CloudflareError`, `DnsRecord` (Task 3); `Npm`, `NpmError`, `ProxyHost`, `Certificate`, `covers`, `days_left`, `RENEW_DAYS` (Task 4); `outbound.transports()` (Task 5); `environments.services_of`.
- Produces (module `sirdar_api.deploy.publish`): constants `DNS = "dns_record"`, `PROXY = "proxy_host"`, `CERT = "certificate"`, `KIND_INTEGRATION`; `Output = Callable[[str], None]`; `class PublishError(Exception)` with `.reason`; frozen dataclasses `ServicePlan(service, hostname, host_ip, port, proxied)` (property `forward`), `PublishContext(env_id, env_name, proxy_ip, services: tuple[ServicePlan, ...], cloudflare=None, npm=None)` (property `secret_values: list[str]`), `Status(state, detail, current=None)`; `async service_plans(db, env) -> tuple[ServicePlan, ...]`; `async prepare(db, env, settings) -> PublishContext` (raises `PublishError`); `async rows_of(db, env_id) -> dict[tuple[str, str], ManagedRecord]` keyed `(service, kind)`; `async owners_of(db, env_id, kind) -> dict[str, str]` (external id → the other environment's name); `current_row(rows, sp, kind)`; `stale_rows(rows, services) -> list[ManagedRecord]`; `async missing_integrations(db, env, *, teardown=False) -> list[str]`; `in_zone(hostname, zone)`; `dns_status(sp, records, row, owners, *, zone, public_ip) -> Status`; `proxy_status(sp, hosts, row, owners) -> Status`; `usable_certificate(certs, hostname, now) -> Certificate | None`; `cert_status(host, certs, hostname, now) -> Status`; `async inspect(db, env, settings) -> dict` (the `PublishState` shape); `async claim(db, env, state) -> list[str]` (adds `claimed` rows; caller audits and commits).
- Produces (tests): `tests/publish_helpers.py` — fixture `publish_fakes` (patches `outbound.transports`; returns `SimpleNamespace(cf, npm, smoke)`), `sp(service="api", env="uat2", host_ip="10.10.48.63", port=8100, proxied=False) -> ServicePlan`, `PUBLIC_IP = "203.0.113.7"`, `async managed(db, env, service, kind, external_id, *, origin="created", name=None)`.

- [ ] **Step 1: Write the test helpers**

Create `sirdar/api/tests/publish_helpers.py`:

```python
"""Shared pieces for the publish tests: fake Cloudflare, NPM and smoke
targets wired into outbound.transports(), and builders."""

from types import SimpleNamespace

import pytest

from sirdar_api.db.models import ManagedRecord
from sirdar_api.deploy import outbound
from sirdar_api.deploy.publish import ServicePlan

from .fake_cloudflare import FakeCloudflare
from .fake_npm import FakeNpm
from .fake_smoke import FakeSmoke

PUBLIC_IP = "203.0.113.7"


@pytest.fixture
def publish_fakes(monkeypatch):
    fakes = SimpleNamespace(cf=FakeCloudflare(), npm=FakeNpm(), smoke=FakeSmoke())
    monkeypatch.setattr(outbound, "transports", lambda: {
        "cloudflare": fakes.cf.transport(), "npm": fakes.npm.transport(),
        "smoke": fakes.smoke.transport()})
    return fakes


def sp(service: str = "api", env: str = "uat2", host_ip: str = "10.10.48.63",
       port: int = 8100, proxied: bool = False) -> ServicePlan:
    return ServicePlan(service, f"{service}.{env}.serversherpa.com", host_ip, port, proxied)


async def managed(db, env, service: str, kind: str, external_id, *, origin: str = "created",
                  name: str | None = None) -> ManagedRecord:
    row = ManagedRecord(environment_id=env.id, service=service, kind=kind,
                        external_id=str(external_id), origin=origin,
                        name=name or f"{service}.{env.base_domain}")
    db.add(row)
    await db.commit()
    return row
```

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_publish.py`:

```python
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import ManagedRecord
from sirdar_api.deploy import publish
from sirdar_api.deploy.cloudflare import DnsRecord
from sirdar_api.deploy.npm import Certificate, ProxyHost
from sirdar_api.deploy.publish import CERT, DNS, PROXY, Status

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import CF_TOKEN, NPM_PASSWORD, configure
from .publish_helpers import PUBLIC_IP, managed, publish_fakes, sp  # noqa: F401

API = sp()
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


def rec(rid, type_="A", name=API.hostname, content=PUBLIC_IP, proxied=False) -> DnsRecord:
    return DnsRecord(id=rid, type=type_, name=name, content=content, proxied=proxied)


def row(kind, external_id, *, name=API.hostname, origin="created"):
    return publish.ManagedRecord(environment_id=uuid.uuid4(), service="api", kind=kind,
                                 external_id=str(external_id), name=name, origin=origin)


def host(hid, *, names=(API.hostname,), fwd=("10.10.48.63", 8100), cert=0, ssl=True,
         ws=True, scheme="http") -> ProxyHost:
    return ProxyHost(id=hid, domain_names=tuple(names), forward_scheme=scheme,
                     forward_host=fwd[0], forward_port=fwd[1], certificate_id=cert,
                     ssl_forced=ssl, http2_support=True, allow_websocket_upgrade=ws, raw={})


def cert(cid, names=(API.hostname,), days=60, provider="letsencrypt") -> Certificate:
    return Certificate(id=cid, provider=provider, domain_names=tuple(names),
                       expires_on=None if days is None else NOW + timedelta(days=days))


def _dns(records, managed_row=None, owners=None, service=API):
    return publish.dns_status(service, records, managed_row, owners or {},
                              zone="serversherpa.com", public_ip=PUBLIC_IP)


@pytest.mark.parametrize("records, managed_row, owners, expected", [
    ([], None, None, ("create", "Sirdar will create A 203.0.113.7.")),
    ([rec("r1")], row(DNS, "r1"), None, ("ok", "A 203.0.113.7")),
    ([rec("r1", content="198.51.100.1")], row(DNS, "r1"), None,
     ("update", "A 198.51.100.1; Sirdar will point it at 203.0.113.7.")),
    ([rec("r1", proxied=True)], row(DNS, "r1", origin="claimed"), None,
     ("update", "Cloudflare's proxy is on; Sirdar will turn it off.")),
    ([], row(DNS, "r1"), None, ("create", "Sirdar's record is gone; it will be created again.")),
    ([rec("r1", content="198.51.100.1")], None, None,
     ("claimable", "A 198.51.100.1, made outside Sirdar.")),
    ([rec("r1")], None, {"r1": "uat"}, ("conflict", "The environment uat manages this record.")),
    ([rec("r1", type_="CNAME", content="x.example.com")], None, None,
     ("conflict", "A CNAME record already uses this name.")),
    ([rec("r1"), rec("r2")], None, None,
     ("conflict", "More than one A record uses this name.")),
    ([rec("r1", name="*.uat2.serversherpa.com")], None, None,
     ("conflict", "The wildcard *.uat2.serversherpa.com covers this name; a record here would "
                  "override it.")),
    ([rec("r1", name="portal.uat2.serversherpa.com")], None, None,
     ("create", "Sirdar will create A 203.0.113.7.")),
])
def test_dns_status(records, managed_row, owners, expected):
    status = _dns(records, managed_row, owners)
    assert (status.state, status.detail) == expected


def test_dns_status_outside_the_zone():
    outside = publish.ServicePlan("api", "api.example.org", "10.10.48.63", 8100, False)
    status = _dns([], service=outside)
    assert (status.state, status.detail) == (
        "conflict", "api.example.org isn't in the Cloudflare zone serversherpa.com.")


@pytest.mark.parametrize("hosts, managed_row, owners, expected", [
    ([], None, None, ("create", "Sirdar will create a proxy host to 10.10.48.63:8100.")),
    ([host(5)], row(PROXY, 5), None, ("ok", "To 10.10.48.63:8100")),
    ([host(5, fwd=("10.10.48.63", 8000), ws=False)], row(PROXY, 5), None,
     ("update", "Sirdar will change the forward port and WebSockets.")),
    ([], row(PROXY, 5), None,
     ("create", "Sirdar's proxy host is gone; it will be created again.")),
    ([host(5, fwd=("10.10.48.63", 8000))], None, None,
     ("claimable", "To 10.10.48.63:8000, made outside Sirdar.")),
    ([host(5)], None, {"5": "uat"}, ("conflict", "The environment uat manages this proxy host.")),
    ([host(5), host(6)], None, None,
     ("conflict", "More than one proxy host serves this name.")),
    ([host(5, names=(API.hostname, "www.example.com"))], None, None,
     ("conflict", "This proxy host also serves www.example.com.")),
])
def test_proxy_status(hosts, managed_row, owners, expected):
    status = publish.proxy_status(API, hosts, managed_row, owners or {})
    assert (status.state, status.detail) == expected


@pytest.mark.parametrize("the_host, certs, expected", [
    (None, [], ("create", "Sirdar will request a Let's Encrypt certificate.")),
    (host(5, cert=9), [cert(9)], ("ok", "Valid until 2026-12-03.")),
    (host(5, cert=9, ssl=False), [cert(9)], ("update", "Force SSL is off; Sirdar will turn it on.")),
    (host(5, cert=9), [cert(9, days=12)], ("update", "Expires 2026-10-16; Sirdar will renew it.")),
    (host(5, cert=9), [cert(9, days=12, provider="other"),
                       cert(10, names=("*.uat2.serversherpa.com",), days=80)],
     ("update", "Sirdar will use certificate #10 (valid until 2026-12-23).")),
    (host(5), [cert(10, names=("*.uat2.serversherpa.com",), days=80), cert(11, days=40)],
     ("update", "Sirdar will use certificate #11 (valid until 2026-11-13).")),
    (host(5), [cert(10, names=("*.uat.serversherpa.com",), days=80)],
     ("create", "Sirdar will request a Let's Encrypt certificate.")),
    (host(5, cert=9), [cert(9, days=None)], ("ok", "In place; no expiry date.")),
])
def test_cert_status(the_host, certs, expected):
    status = publish.cert_status(the_host, certs, API.hostname, NOW)
    assert (status.state, status.detail) == expected


def test_stale_rows_and_current_row():
    rows = {("api", DNS): row(DNS, "r1", name="api.old.serversherpa.com"),
            ("portal", DNS): row(DNS, "r2", name="portal.uat2.serversherpa.com"),
            ("mailpit", DNS): row(DNS, "r3", name="mailpit.uat2.serversherpa.com")}
    rows[("portal", DNS)].service = "portal"
    rows[("mailpit", DNS)].service = "mailpit"
    services = (API, sp("portal"))
    assert publish.current_row(rows, API, DNS) is None
    assert publish.current_row(rows, sp("portal"), DNS) is rows[("portal", DNS)]
    assert {r.external_id for r in publish.stale_rows(rows, services)} == {"r1", "r3"}


async def test_prepare_and_missing_integrations(db, secrets_key):
    env = await make_environment(db, name="uat2", host="10.10.48.63")
    assert await publish.missing_integrations(db, env) == ["cloudflare", "npm"]
    assert await publish.missing_integrations(db, env, teardown=True) == []
    await managed(db, env, "api", DNS, "r1")
    await managed(db, env, "api", PROXY, 5, origin="claimed")
    assert await publish.missing_integrations(db, env, teardown=True) == ["cloudflare"]
    await configure(db)
    assert await publish.missing_integrations(db, env) == []
    ctx = await publish.prepare(db, env, get_settings())
    assert [s.service for s in ctx.services] == ["api", "portal", "kiosk", "wiki", "spaces",
                                                 "status"]
    assert ctx.services[0] == publish.ServicePlan("api", "api.uat2.serversherpa.com",
                                                  "10.10.48.63", 8000, False)
    assert (ctx.env_name, ctx.proxy_ip) == ("uat2", "10.0.0.2")
    assert sorted(ctx.secret_values) == sorted([CF_TOKEN, NPM_PASSWORD])
    assert CF_TOKEN not in repr(ctx) and NPM_PASSWORD not in repr(ctx)


async def _uat2(db):
    """uat2 on 10.10.48.63 with integrations configured."""
    await configure(db)
    return await make_environment(db, name="uat2", host="10.10.48.63")


async def test_inspect_reports_every_service(db, secrets_key, publish_fakes):
    env = await _uat2(db)
    cf, proxy = publish_fakes.cf, publish_fakes.npm
    hand_api = cf.add("A", "api.uat2.serversherpa.com", PUBLIC_IP)
    mine = cf.add("A", "portal.uat2.serversherpa.com", PUBLIC_IP)
    await managed(db, env, "portal", DNS, mine)
    cf.add("CNAME", "kiosk.uat2.serversherpa.com", "elsewhere.example.com")
    api_cert = proxy.add_cert(["api.uat2.serversherpa.com"], days=70)
    api_host = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000,
                              certificate_id=api_cert, ssl_forced=True)
    await managed(db, env, "wiki", DNS, "rec-gone", name="wiki.old.serversherpa.com")
    state = await publish.inspect(db, env, get_settings())
    assert state["publish"] is False and state["proxy_ip"] == "10.0.0.2"
    assert state["cloudflare"] == {"configured": True, "zone": "serversherpa.com",
                                   "public_ip": PUBLIC_IP, "error": None}
    assert state["npm"] == {"configured": True, "url": "http://10.10.48.6:81", "error": None}
    by = {s["service"]: s for s in state["services"]}
    assert list(by) == ["api", "portal", "kiosk", "wiki", "spaces", "status"]
    assert by["api"]["forward"] == "10.10.48.63:8000"
    assert by["api"]["dns"] == {"state": "claimable", "detail": "A 203.0.113.7, made outside "
                                "Sirdar.", "origin": None, "record_id": hand_api}
    assert by["api"]["proxy"] == {"state": "claimable", "detail": "To 10.10.48.63:8000, made "
                                  "outside Sirdar.", "origin": None, "host_id": api_host}
    assert by["api"]["certificate"]["state"] == "ok"
    assert by["api"]["certificate"]["expires_on"] is not None
    assert (by["portal"]["dns"]["state"], by["portal"]["dns"]["origin"]) == ("ok", "created")
    assert by["kiosk"]["dns"]["state"] == "conflict"
    assert (by["status"]["dns"]["state"], by["status"]["proxy"]["state"],
            by["status"]["certificate"]["state"]) == ("create", "create", "create")
    assert state["stale"] == [{"service": "wiki", "kind": DNS,
                               "name": "wiki.old.serversherpa.com", "origin": "created"}]


async def test_inspect_without_integrations_or_when_one_is_down(db, secrets_key,
                                                                publish_fakes):
    env = await make_environment(db, name="uat2", host="10.10.48.63")
    state = await publish.inspect(db, env, get_settings())
    assert state["cloudflare"]["configured"] is False and state["npm"]["configured"] is False
    assert {s["dns"]["state"] for s in state["services"]} == {"unknown"}
    assert {s["certificate"]["state"] for s in state["services"]} == {"unknown"}
    await configure(db)
    publish_fakes.cf.down = True
    state = await publish.inspect(db, env, get_settings())
    assert state["cloudflare"]["error"] == "Couldn't reach the Cloudflare API."
    assert {s["dns"]["state"] for s in state["services"]} == {"unknown"}
    assert {s["proxy"]["state"] for s in state["services"]} == {"create"}


async def test_claim_records_only_claimable_entries(db, secrets_key, publish_fakes):
    env = await _uat2(db)
    hand_api = publish_fakes.cf.add("A", "api.uat2.serversherpa.com", PUBLIC_IP)
    publish_fakes.cf.add("CNAME", "kiosk.uat2.serversherpa.com", "elsewhere.example.com")
    api_host = publish_fakes.npm.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000,
                                          allow_websocket_upgrade=True)
    state = await publish.inspect(db, env, get_settings())
    claimed = await publish.claim(db, env, state)
    await db.commit()
    assert claimed == ["dns:api.uat2.serversherpa.com", "proxy:api.uat2.serversherpa.com"]
    rows = list(await db.scalars(select(ManagedRecord).order_by(ManagedRecord.kind)))
    assert [(r.service, r.kind, r.external_id, r.origin) for r in rows] == [
        ("api", DNS, hand_api, "claimed"), ("api", PROXY, str(api_host), "claimed")]
    again = await publish.inspect(db, env, get_settings())
    api = again["services"][0]
    assert (api["dns"]["state"], api["dns"]["origin"]) == ("ok", "claimed")
    assert (api["proxy"]["state"], api["proxy"]["origin"]) == ("ok", "claimed")
    assert await publish.claim(db, env, again) == []
    assert CERT not in {r.kind for r in rows}          # certificates are never claimed


def test_status_compares_on_state_and_detail_only():
    assert Status("ok", "x", current=1) == Status("ok", "x", current=2)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_publish.py`
Expected: FAIL — `ImportError` (no `publish` module).

- [ ] **Step 4: Write the module**

Create `sirdar/api/src/sirdar_api/deploy/publish.py`:

```python
"""Publishing an environment (spec Section 2 steps 12–14, Section 3
managed_records): a Cloudflare A record and an Nginx Proxy Manager proxy
host (with its certificate) for every public service, a smoke test of the
public URLs, and their removal when the environment is deleted.

Sirdar edits or deletes only what managed_records lists for the
environment. A row's origin says why it is there: "created" (Sirdar made
it; Delete environment removes it) or "claimed" (it existed before and
someone claimed it on the Publish tab; Sirdar keeps it up to date and never
deletes it). Anything else at a wanted name blocks: the step changes
nothing, fails, and says to claim it or fix it by hand.

The status functions are pure: they compare what Cloudflare and NPM hold
with the managed rows and give one Status per service. The Publish tab
shows them (inspect), Claim records the claimable ones, and the steps
apply them. Errors carry our own copy; credentials stay inside the
Cloudflare and Npm clients."""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Environment, ManagedRecord
from sirdar_api.deploy import integrations, outbound
from sirdar_api.deploy.cloudflare import Cloudflare, CloudflareError, DnsRecord
from sirdar_api.deploy.environments import services_of
from sirdar_api.deploy.integrations import CloudflareConfig, IntegrationError, NpmConfig
from sirdar_api.deploy.npm import (
    RENEW_DAYS,
    Certificate,
    Npm,
    NpmError,
    ProxyHost,
    covers,
    days_left,
)

Output = Callable[[str], None]
DNS, PROXY, CERT = "dns_record", "proxy_host", "certificate"
KIND_INTEGRATION = {DNS: "cloudflare", PROXY: "npm", CERT: "npm"}


class PublishError(Exception):
    """The publish context can't be built. `reason` is our own copy."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ServicePlan:
    service: str
    hostname: str
    host_ip: str
    port: int
    proxied: bool

    @property
    def forward(self) -> str:
        return f"{self.host_ip}:{self.port}"


@dataclass(frozen=True)
class PublishContext:
    env_id: uuid.UUID
    env_name: str
    proxy_ip: str
    services: tuple[ServicePlan, ...]
    cloudflare: CloudflareConfig | None = field(default=None, repr=False)
    npm: NpmConfig | None = field(default=None, repr=False)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        return [v for v in (self.cloudflare.token if self.cloudflare else None,
                            self.npm.password if self.npm else None) if v]


@dataclass(frozen=True)
class Status:
    state: str              # ok | update | create | claimable | conflict
    detail: str
    current: object = field(default=None, compare=False)    # DnsRecord / ProxyHost / Certificate


# ---- context -------------------------------------------------------------------

async def service_plans(db: AsyncSession, env: Environment) -> tuple[ServicePlan, ...]:
    """The public services (those with a hostname), in envfile order."""
    rows = await services_of(db, env.id)
    return tuple(ServicePlan(r.service, r.hostname, r.host_ip, r.port, r.proxied)
                 for r in rows if r.hostname)


async def prepare(db: AsyncSession, env: Environment, settings: Settings) -> PublishContext:
    try:
        cf = await integrations.load_cloudflare(db, settings)
        proxy = await integrations.load_npm(db, settings)
    except IntegrationError as e:
        raise PublishError(e.reason) from None
    return PublishContext(env_id=env.id, env_name=env.name, proxy_ip=env.proxy_ip,
                          services=await service_plans(db, env), cloudflare=cf, npm=proxy)


# ---- managed rows ----------------------------------------------------------------

async def rows_of(db: AsyncSession, env_id) -> dict[tuple[str, str], ManagedRecord]:
    rows = await db.scalars(select(ManagedRecord).where(ManagedRecord.environment_id == env_id)
                            .execution_options(populate_existing=True))
    return {(r.service, r.kind): r for r in rows}


async def owners_of(db: AsyncSession, env_id, kind: str) -> dict[str, str]:
    """External id -> name of the other environment that manages it."""
    rows = await db.execute(
        select(ManagedRecord.external_id, Environment.name)
        .join(Environment, Environment.id == ManagedRecord.environment_id)
        .where(ManagedRecord.kind == kind, ManagedRecord.environment_id != env_id))
    return {external_id: name for external_id, name in rows}


def current_row(rows: dict, sp: ServicePlan, kind: str) -> ManagedRecord | None:
    """The managed row for this service and kind, if it serves the wanted name."""
    found = rows.get((sp.service, kind))
    return found if found is not None and found.name == sp.hostname else None


def stale_rows(rows: dict, services) -> list[ManagedRecord]:
    """Managed rows for a service that is no longer public, or under a name
    the environment no longer uses (its base domain changed)."""
    wanted = {s.service: s.hostname for s in services}
    return [r for r in rows.values() if wanted.get(r.service) != r.name]


async def missing_integrations(db: AsyncSession, env: Environment, *,
                               teardown: bool = False) -> list[str]:
    """Integrations a publish (both) or a teardown (those whose created
    entries it must delete) needs but which aren't configured."""
    if teardown:
        rows = await rows_of(db, env.id)
        wanted = {KIND_INTEGRATION[r.kind] for r in rows.values() if r.origin == "created"}
    else:
        wanted = {"cloudflare", "npm"}
    return sorted([k for k in wanted if not await integrations.is_configured(db, k)])


# ---- status ----------------------------------------------------------------------

def in_zone(hostname: str, zone: str) -> bool:
    return hostname == zone or hostname.endswith("." + zone)


def dns_status(sp: ServicePlan, records: list[DnsRecord], row: ManagedRecord | None,
               owners: dict[str, str], *, zone: str, public_ip: str) -> Status:
    if not in_zone(sp.hostname, zone):
        return Status("conflict", f"{sp.hostname} isn't in the Cloudflare zone {zone}.")
    here = [r for r in records if r.name == sp.hostname]
    if row is not None:
        mine = next((r for r in here if r.id == row.external_id), None)
        if mine is None:
            return Status("create", "Sirdar's record is gone; it will be created again.")
        if mine.type == "A" and mine.content == public_ip:
            if mine.proxied == sp.proxied:
                return Status("ok", f"A {public_ip}", mine)
            return Status("update", f"Cloudflare's proxy is {'on' if mine.proxied else 'off'}; "
                                    f"Sirdar will turn it {'on' if sp.proxied else 'off'}.", mine)
        return Status("update", f"A {mine.content}; Sirdar will point it at {public_ip}.", mine)
    others = [r for r in here if r.type != "A"]
    if others:
        return Status("conflict", f"A {others[0].type} record already uses this name.")
    a_records = [r for r in here if r.type == "A"]
    if len(a_records) > 1:
        return Status("conflict", "More than one A record uses this name.")
    if a_records:
        found = a_records[0]
        if found.id in owners:
            return Status("conflict", f"The environment {owners[found.id]} manages this record.")
        return Status("claimable", f"A {found.content}, made outside Sirdar.", found)
    parent = sp.hostname.split(".", 1)[1]
    wildcard = f"*.{parent}"
    if any(r.name == wildcard for r in records):
        return Status("conflict", f"The wildcard {wildcard} covers this name; a record here "
                                  "would override it.")
    return Status("create", f"Sirdar will create A {public_ip}.")


def _forward_drift(host: ProxyHost, sp: ServicePlan) -> list[str]:
    checks = (("the scheme", host.forward_scheme, "http"),
              ("the forward host", host.forward_host, sp.host_ip),
              ("the forward port", host.forward_port, sp.port),
              ("WebSockets", host.allow_websocket_upgrade, True))
    return [name for name, have, want in checks if have != want]


def _and(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def proxy_status(sp: ServicePlan, hosts: list[ProxyHost], row: ManagedRecord | None,
                 owners: dict[str, str]) -> Status:
    if row is not None:
        mine = next((h for h in hosts if str(h.id) == row.external_id), None)
        if mine is None:
            return Status("create", "Sirdar's proxy host is gone; it will be created again.")
        drift = _forward_drift(mine, sp)
        if not drift:
            return Status("ok", f"To {sp.forward}", mine)
        return Status("update", f"Sirdar will change {_and(drift)}.", mine)
    named = [h for h in hosts if sp.hostname in h.domain_names]
    if len(named) > 1:
        return Status("conflict", "More than one proxy host serves this name.")
    if named:
        found = named[0]
        if str(found.id) in owners:
            return Status("conflict",
                          f"The environment {owners[str(found.id)]} manages this proxy host.")
        extra = [d for d in found.domain_names if d != sp.hostname]
        if extra:
            return Status("conflict", f"This proxy host also serves {', '.join(extra)}.")
        return Status("claimable",
                      f"To {found.forward_host}:{found.forward_port}, made outside Sirdar.", found)
    return Status("create", f"Sirdar will create a proxy host to {sp.forward}.")


def _date(cert: Certificate) -> str:
    return cert.expires_on.strftime("%Y-%m-%d") if cert.expires_on else "an unknown date"


def usable_certificate(certs: list[Certificate], hostname: str,
                       now: datetime) -> Certificate | None:
    """A certificate covering the name with more than RENEW_DAYS left (or no
    expiry date): one naming it exactly first, then the latest to expire."""
    fresh = [c for c in certs if covers(c, hostname)
             and ((left := days_left(c, now)) is None or left > RENEW_DAYS)]
    fresh.sort(key=lambda c: (hostname not in c.domain_names,
                              -(c.expires_on.timestamp() if c.expires_on else float("inf"))))
    return fresh[0] if fresh else None


def cert_status(host: ProxyHost | None, certs: list[Certificate], hostname: str,
                now: datetime) -> Status:
    current = None
    if host is not None and host.certificate_id:
        current = next((c for c in certs if c.id == host.certificate_id), None)
    if current is not None and covers(current, hostname):
        left = days_left(current, now)
        if left is None or left > RENEW_DAYS:
            if not host.ssl_forced:
                return Status("update", "Force SSL is off; Sirdar will turn it on.", current)
            if current.expires_on is None:
                return Status("ok", "In place; no expiry date.", current)
            return Status("ok", f"Valid until {_date(current)}.", current)
        if current.provider == "letsencrypt":
            return Status("update", f"Expires {_date(current)}; Sirdar will renew it.", current)
    other = usable_certificate(certs, hostname, now)
    if other is not None:
        return Status("update",
                      f"Sirdar will use certificate #{other.id} (valid until {_date(other)}).",
                      other)
    return Status("create", "Sirdar will request a Let's Encrypt certificate.")


# ---- the Publish tab ---------------------------------------------------------------

def _entry(status: Status | None, row: ManagedRecord | None, id_key: str) -> dict:
    if status is None:
        return {"state": "unknown", "detail": "", "origin": None, id_key: None}
    found = status.current
    return {"state": status.state, "detail": status.detail,
            "origin": row.origin if row is not None else None,
            id_key: found.id if found is not None else None}


def _cert_entry(status: Status | None) -> dict:
    if status is None:
        return {"state": "unknown", "detail": "", "expires_on": None}
    found = status.current
    return {"state": status.state, "detail": status.detail,
            "expires_on": found.expires_on if found is not None else None}


async def inspect(db: AsyncSession, env: Environment, settings: Settings) -> dict:
    """What publishing this environment would do now, per service. Reads
    Cloudflare and NPM, changes nothing. A section whose integration isn't
    configured or can't be read reports "unknown" and says why."""
    transports = outbound.transports()
    services = await service_plans(db, env)
    rows = await rows_of(db, env.id)
    now = datetime.now(UTC)
    out: dict = {"publish": env.publish, "proxy_ip": env.proxy_ip,
                 "cloudflare": {"configured": False, "zone": None, "public_ip": None,
                                "error": None},
                 "npm": {"configured": False, "url": None, "error": None}}
    dns: dict[str, Status] = {}
    proxies: dict[str, Status] = {}
    certs: dict[str, Status] = {}

    try:
        cf = await integrations.load_cloudflare(db, settings)
    except IntegrationError as e:
        cf, out["cloudflare"]["error"] = None, e.reason
    if cf is not None:
        out["cloudflare"].update(configured=True, zone=cf.zone, public_ip=cf.public_ip)
        try:
            async with Cloudflare(cf, transport=transports["cloudflare"]) as api:
                records = await api.records()
        except CloudflareError as e:
            out["cloudflare"]["error"] = e.reason
        else:
            owners = await owners_of(db, env.id, DNS)
            dns = {s.service: dns_status(s, records, current_row(rows, s, DNS), owners,
                                         zone=cf.zone, public_ip=cf.public_ip)
                   for s in services}

    try:
        proxy_cfg = await integrations.load_npm(db, settings)
    except IntegrationError as e:
        proxy_cfg, out["npm"]["error"] = None, e.reason
    if proxy_cfg is not None:
        out["npm"].update(configured=True, url=proxy_cfg.url)
        try:
            async with Npm(proxy_cfg, transport=transports["npm"]) as api:
                hosts = await api.proxy_hosts()
                all_certs = await api.certificates()
        except NpmError as e:
            out["npm"]["error"] = e.reason
        else:
            owners = await owners_of(db, env.id, PROXY)
            for s in services:
                status = proxy_status(s, hosts, current_row(rows, s, PROXY), owners)
                proxies[s.service] = status
                certs[s.service] = cert_status(status.current, all_certs, s.hostname, now)

    out["services"] = [{
        "service": s.service, "hostname": s.hostname, "forward": s.forward,
        "dns": _entry(dns.get(s.service), current_row(rows, s, DNS), "record_id"),
        "proxy": _entry(proxies.get(s.service), current_row(rows, s, PROXY), "host_id"),
        "certificate": _cert_entry(certs.get(s.service)),
    } for s in services]
    out["stale"] = [{"service": r.service, "kind": r.kind, "name": r.name, "origin": r.origin}
                    for r in stale_rows(rows, services)]
    return out


async def claim(db: AsyncSession, env: Environment, state: dict) -> list[str]:
    """Record every claimable DNS record and proxy host in `state` (from
    inspect) as claimed. Certificates are never claimed. Writes only
    Sirdar's database; the caller audits and commits."""
    claimed: list[str] = []
    for svc in state["services"]:
        for key, kind, id_key in (("dns", DNS, "record_id"), ("proxy", PROXY, "host_id")):
            entry = svc[key]
            if entry["state"] != "claimable":
                continue
            db.add(ManagedRecord(environment_id=env.id, service=svc["service"], kind=kind,
                                 external_id=str(entry[id_key]), name=svc["hostname"],
                                 origin="claimed"))
            claimed.append(f"{key}:{svc['hostname']}")
    await db.flush()
    return claimed
```

`publish.ManagedRecord` in the tests is the model this module imports (no extra export needed).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_publish.py`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/publish.py tests/publish_helpers.py tests/test_deploy_publish.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/publish.py sirdar/api/tests/publish_helpers.py \
  sirdar/api/tests/test_deploy_publish.py
git commit -m "feat(sirdar): publish planning per service, inspection and Claim

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: The publish steps and the real publisher

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/publish.py`
- Test: `sirdar/api/tests/test_deploy_publish_steps.py`

**Interfaces:**
- Consumes: everything Task 7 produced; `smoke.run` (Task 6); `npm.HOST_FIELDS`, `npm.CERT_BACKOFF`; `get_sessionmaker`.
- Produces (module `sirdar_api.deploy.publish`): `SPACES_ADVANCED = "client_max_body_size 0;"`; `class StepFailed(Exception)` with `.reason`; `class Publisher(Protocol)` with `async run(step: str, ctx: PublishContext, out: Output) -> None` (raises `StepFailed`); `new_host_body(sp) -> dict`; `host_body(host, sp, *, certificate_id=None) -> dict`; `async ensure_dns(ctx, out, *, transport)`; `async ensure_proxy(ctx, out, *, transport, sleep, now, backoff)`; `async run_smoke(ctx, out, *, transport, sleep, attempts, delay)`; `async remove_proxy(ctx, out, *, transport)`; `async remove_dns(ctx, out, *, transport)`; `class HttpPublisher(*, sleep=asyncio.sleep, now=None, cert_backoff=CERT_BACKOFF, smoke_attempts=smoke.ATTEMPTS, smoke_delay=smoke.DELAY)` implementing `Publisher` for the step keys `dns`, `proxy`, `smoke`, `unproxy`, `undns` (`CloudflareError` / `NpmError` become `StepFailed`; any other key raises `ValueError`).

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_publish_steps.py`:

```python
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import ManagedRecord
from sirdar_api.deploy import publish
from sirdar_api.deploy.publish import CERT, DNS, PROXY, StepFailed

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import CF_TOKEN, NPM_PASSWORD, configure
from .publish_helpers import PUBLIC_IP, managed, publish_fakes  # noqa: F401

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)
NAMES = [f"{s}.uat2.serversherpa.com" for s in
         ("api", "portal", "kiosk", "wiki", "spaces", "status")]
PORTS = {"api": 8000, "portal": 8091, "kiosk": 8090, "wiki": 8096, "spaces": 9000,
         "status": 8095}


@pytest.fixture
async def env(db, secrets_key, publish_fakes):
    publish_fakes.npm.now = NOW
    await configure(db)
    return await make_environment(db, name="uat2", host="10.10.48.63")


def _publisher(sleeps=None, **kw) -> publish.HttpPublisher:
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)
    return publish.HttpPublisher(sleep=sleep, now=lambda: NOW, **kw)


async def _run(db, env, step, publisher=None) -> list[str]:
    ctx = await publish.prepare(db, env, get_settings())
    lines: list[str] = []
    await (publisher or _publisher()).run(step, ctx, lines.append)
    text = "".join(lines)
    assert CF_TOKEN not in text and NPM_PASSWORD not in text
    return lines


async def _rows(db) -> list[tuple]:
    rows = await db.scalars(select(ManagedRecord)
                            .order_by(ManagedRecord.service, ManagedRecord.kind)
                            .execution_options(populate_existing=True))
    return [(r.service, r.kind, r.external_id, r.origin) for r in rows]


def _writes(fake_npm) -> list[tuple[str, str]]:
    return [(r.method, r.url.path) for r in fake_npm.requests
            if r.method != "GET" and r.url.path != "/api/tokens"]


# ---- step 12: DNS -------------------------------------------------------------------

async def test_dns_creates_every_record_and_records_ownership(db, env, publish_fakes):
    cf = publish_fakes.cf
    lines = await _run(db, env, "dns")
    made = {r["name"]: r for r in cf.records.values()}
    assert sorted(made) == sorted(NAMES)
    api = made["api.uat2.serversherpa.com"]
    assert (api["type"], api["content"], api["proxied"], api["comment"]) == (
        "A", PUBLIC_IP, False, "Managed by Sirdar (uat2/api)")
    assert lines[0] == "api.uat2.serversherpa.com: created A 203.0.113.7\n"
    assert [(s, k, o) for s, k, _, o in await _rows(db)] == sorted(
        (s, DNS, "created") for s in PORTS)
    before = len(cf.writes())
    again = await _run(db, env, "dns")
    assert len(cf.writes()) == before
    assert again[0] == "api.uat2.serversherpa.com: A 203.0.113.7, unchanged\n"


async def test_dns_corrects_drift_on_managed_and_claimed_records(db, env, publish_fakes):
    cf = publish_fakes.cf
    mine = cf.add("A", "api.uat2.serversherpa.com", "198.51.100.1",
                  comment="Managed by Sirdar (uat2/api)")
    theirs = cf.add("A", "portal.uat2.serversherpa.com", "198.51.100.1", comment="by hand")
    await managed(db, env, "api", DNS, mine)
    await managed(db, env, "portal", DNS, theirs, origin="claimed")
    lines = await _run(db, env, "dns")
    assert cf.records[mine]["content"] == PUBLIC_IP
    assert (cf.records[theirs]["content"], cf.records[theirs]["comment"]) == (PUBLIC_IP,
                                                                              "by hand")
    assert "portal.uat2.serversherpa.com: updated to A 203.0.113.7\n" in lines
    rows = {(s, k): (e, o) for s, k, e, o in await _rows(db)}
    assert rows[("portal", DNS)] == (theirs, "claimed")


async def test_dns_blockers_change_nothing(db, env, publish_fakes):
    cf = publish_fakes.cf
    cf.add("A", "api.uat2.serversherpa.com", "198.51.100.1")
    cf.add("CNAME", "kiosk.uat2.serversherpa.com", "elsewhere.example.com")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "dns")
    assert e.value.reason == (
        "Sirdar changed nothing: these DNS records are in the way.\n"
        "  api.uat2.serversherpa.com: A 198.51.100.1, made outside Sirdar.\n"
        "  kiosk.uat2.serversherpa.com: A CNAME record already uses this name.\n"
        "Claim the existing ones on the Publish tab, or remove them by hand, then retry.")
    assert cf.writes() == [] and await _rows(db) == []


async def test_dns_moves_records_off_an_old_name(db, env, publish_fakes):
    cf = publish_fakes.cf
    old_mine = cf.add("A", "api.old.serversherpa.com", PUBLIC_IP)
    old_theirs = cf.add("A", "portal.old.serversherpa.com", PUBLIC_IP)
    await managed(db, env, "api", DNS, old_mine, name="api.old.serversherpa.com")
    await managed(db, env, "portal", DNS, old_theirs, origin="claimed",
                  name="portal.old.serversherpa.com")
    lines = await _run(db, env, "dns")
    assert old_mine not in cf.records and old_theirs in cf.records
    assert "api.old.serversherpa.com: deleted the A record\n" in lines
    assert "portal.old.serversherpa.com: left in place (claimed, not made by Sirdar)\n" in lines
    assert {e for _, _, e, _ in await _rows(db)}.isdisjoint({old_mine, old_theirs})


async def test_dns_needs_cloudflare(db, secrets_key, publish_fakes):
    env = await make_environment(db, name="uat2", host="10.10.48.63")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "dns")
    assert e.value.reason == ("Cloudflare isn't set up. Add it in Settings › Integrations, or "
                              "turn Publish off for this environment.")


async def test_upstream_errors_become_step_failures(db, env, publish_fakes):
    publish_fakes.cf.down = True
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "dns")
    assert e.value.reason == "Couldn't reach the Cloudflare API."
    with pytest.raises(ValueError):
        await _run(db, env, "build")


# ---- step 13: proxy hosts and certificates ---------------------------------------------

async def test_proxy_creates_hosts_with_certificates(db, env, publish_fakes):
    proxy = publish_fakes.npm
    lines = await _run(db, env, "proxy")
    hosts = {h["domain_names"][0]: h for h in proxy.hosts.values()}
    assert sorted(hosts) == sorted(NAMES)
    for service, port in PORTS.items():
        h = hosts[f"{service}.uat2.serversherpa.com"]
        assert (h["forward_scheme"], h["forward_host"], h["forward_port"]) == (
            "http", "10.10.48.63", port)
        assert (h["allow_websocket_upgrade"], h["block_exploits"], h["ssl_forced"],
                h["http2_support"]) == (True, True, True, True)
        assert proxy.certs[h["certificate_id"]]["domain_names"] == [h["domain_names"][0]]
        assert h["advanced_config"] == ("client_max_body_size 0;" if service == "spaces" else "")
    assert sorted(proxy.cert_requests) == sorted([n] for n in NAMES)
    assert lines[:3] == [
        "api.uat2.serversherpa.com: created a proxy host to 10.10.48.63:8000\n",
        "api.uat2.serversherpa.com: requesting a Let's Encrypt certificate\n",
        f"api.uat2.serversherpa.com: HTTPS with certificate "
        f"#{hosts['api.uat2.serversherpa.com']['certificate_id']}, Force SSL on\n"]
    kinds = [(s, k, o) for s, k, _, o in await _rows(db)]
    assert kinds == sorted([(s, k, "created") for s in PORTS for k in (CERT, PROXY)])
    writes = len(_writes(proxy))
    again = await _run(db, env, "proxy")
    assert len(_writes(proxy)) == writes
    assert again[0] == "api.uat2.serversherpa.com: proxy host to 10.10.48.63:8000, unchanged\n"


async def test_proxy_reuses_renews_and_keeps_claimed_fields(db, env, publish_fakes):
    proxy = publish_fakes.npm
    wildcard = proxy.add_cert(["*.uat2.serversherpa.com"], days=80)
    expiring = proxy.add_cert(["api.uat2.serversherpa.com"], days=10)
    api_host = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 7999,
                              certificate_id=expiring, ssl_forced=True, http2_support=True,
                              allow_websocket_upgrade=True, advanced_config="# by hand",
                              access_list_id=3)
    await managed(db, env, "api", PROXY, api_host, origin="claimed")
    lines = await _run(db, env, "proxy")
    assert proxy.renewed == [expiring]
    assert proxy.cert_requests == []                        # the wildcard covers the rest
    h = proxy.hosts[api_host]
    assert (h["forward_port"], h["advanced_config"], h["access_list_id"],
            h["certificate_id"]) == (8000, "# by hand", 3, expiring)
    assert {proxy.hosts[i]["certificate_id"] for i in proxy.hosts if i != api_host} == {wildcard}
    assert "api.uat2.serversherpa.com: proxy host now goes to 10.10.48.63:8000\n" in lines
    assert f"portal.uat2.serversherpa.com: using certificate #{wildcard}\n" in lines
    rows = {(s, k): o for s, k, _, o in await _rows(db)}
    assert rows[("api", PROXY)] == "claimed" and ("api", CERT) not in rows


async def test_proxy_waits_out_a_busy_certbot(db, env, publish_fakes):
    publish_fakes.npm.certbot_busy = 1
    sleeps: list = []
    lines = await _run(db, env, "proxy", _publisher(sleeps))
    assert sleeps == [30]
    assert ("api.uat2.serversherpa.com: Certbot is busy (NPM's hourly renewal); trying again "
            "in 30 s\n") in lines


async def test_proxy_blockers_change_nothing(db, env, publish_fakes):
    proxy = publish_fakes.npm
    proxy.add_host("kiosk.uat2.serversherpa.com", "10.10.48.63", 8090)
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy")
    assert "kiosk.uat2.serversherpa.com: To 10.10.48.63:8090, made outside Sirdar." in (
        e.value.reason)
    assert _writes(proxy) == [] and await _rows(db) == []


# ---- step 14: smoke test ---------------------------------------------------------------

async def test_smoke_passes_and_fails(db, env, publish_fakes):
    lines = await _run(db, env, "smoke")
    assert lines[0] == "https://api.uat2.serversherpa.com/healthz: HTTP 200\n"
    assert {r.url.host for r in publish_fakes.smoke.requests} == {"10.0.0.2"}
    publish_fakes.smoke.set("portal.uat2.serversherpa.com", 502)
    sleeps: list = []
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "smoke", _publisher(sleeps, smoke_attempts=2))
    assert e.value.reason == "1 of 6 public URLs didn't answer: portal."
    assert sleeps == [10]


# ---- steps 16 and 17: removal ------------------------------------------------------------

async def test_remove_deletes_only_what_sirdar_created(db, env, publish_fakes):
    cf, proxy = publish_fakes.cf, publish_fakes.npm
    await _run(db, env, "dns")
    await _run(db, env, "proxy")
    hand_record = cf.add("A", "mail.uat2.serversherpa.com", PUBLIC_IP)
    claimed_host = proxy.add_host("mail.uat2.serversherpa.com", "10.10.48.63", 8025)
    await managed(db, env, "mailpit", PROXY, claimed_host, origin="claimed",
                  name="mail.uat2.serversherpa.com")
    lines = await _run(db, env, "unproxy")
    assert list(proxy.hosts) == [claimed_host] and proxy.certs == {}
    assert ("mail.uat2.serversherpa.com: left the proxy host in place (claimed, not made by "
            "Sirdar)\n") in lines
    assert {k for _, k, _, _ in await _rows(db)} == {DNS}
    gone = next(rid for rid, r in cf.records.items() if r["name"].startswith("api."))
    del cf.records[gone]
    lines = await _run(db, env, "undns")
    assert list(cf.records) == [hand_record]
    assert "api.uat2.serversherpa.com: already gone\n" in lines
    assert await _rows(db) == []
    assert await _run(db, env, "undns") == ["No DNS records to remove.\n"]
    assert await _run(db, env, "unproxy") == ["No proxy hosts or certificates to remove.\n"]


async def test_removing_only_claimed_entries_needs_no_credentials(db, secrets_key,
                                                                  publish_fakes):
    env = await make_environment(db, name="uat2", host="10.10.48.63")
    await managed(db, env, "api", DNS, "rec-9", origin="claimed")
    await managed(db, env, "api", PROXY, 9, origin="claimed")
    await _run(db, env, "unproxy")
    await _run(db, env, "undns")
    assert await _rows(db) == []
    await managed(db, env, "api", DNS, "rec-9")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "undns")
    assert e.value.reason == ("Cloudflare isn't set up, so Sirdar can't remove what it made "
                              "there. Add it in Settings › Integrations, then retry.")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_publish_steps.py`
Expected: FAIL — `ImportError: cannot import name 'StepFailed'`.

- [ ] **Step 3: Extend the module's imports**

In `sirdar/api/src/sirdar_api/deploy/publish.py`, replace:

```python
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Environment, ManagedRecord
from sirdar_api.deploy import integrations, outbound
```

with:

```python
import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Environment, ManagedRecord
from sirdar_api.deploy import integrations, npm, outbound, smoke
```

and replace:

```python
from sirdar_api.deploy.npm import (
    RENEW_DAYS,
    Certificate,
```

with:

```python
from sirdar_api.deploy.npm import (
    CERT_BACKOFF,
    RENEW_DAYS,
    Certificate,
```

- [ ] **Step 4: Append the steps**

Append to the end of `sirdar/api/src/sirdar_api/deploy/publish.py`:

```python
# ---- steps 12–14 and 16–17 -------------------------------------------------------------

SPACES_ADVANCED = "client_max_body_size 0;"


class StepFailed(Exception):
    """A publish step can't finish. `reason` (our own copy) ends its log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Publisher(Protocol):
    async def run(self, step: str, ctx: PublishContext, out: Output) -> None: ...


def _need_to_publish(cfg, label: str):
    if cfg is None:
        raise StepFailed(f"{label} isn't set up. Add it in Settings › Integrations, or turn "
                         "Publish off for this environment.")
    return cfg


def _need_to_remove(cfg, label: str):
    if cfg is None:
        raise StepFailed(f"{label} isn't set up, so Sirdar can't remove what it made there. "
                         "Add it in Settings › Integrations, then retry.")
    return cfg


def _stop_on_blockers(plan: list[tuple[ServicePlan, Status]], what: str) -> None:
    """Plan first: one blocker anywhere and nothing is changed."""
    bad = [(s, st) for s, st in plan if st.state in ("claimable", "conflict")]
    if not bad:
        return
    lines = "\n".join(f"  {s.hostname}: {st.detail}" for s, st in bad)
    hint = ("Claim the existing ones on the Publish tab, or remove them by hand, then retry."
            if any(st.state == "claimable" for _, st in bad) else "Fix them by hand, then retry.")
    raise StepFailed(f"Sirdar changed nothing: these {what} are in the way.\n{lines}\n{hint}")


async def _rows_and_owners(env_id, kind: str) -> tuple[dict, dict]:
    async with get_sessionmaker()() as s:
        return await rows_of(s, env_id), await owners_of(s, env_id, kind)


async def _all_rows(env_id, kinds: tuple[str, ...]) -> list[ManagedRecord]:
    async with get_sessionmaker()() as s:
        return [r for r in (await rows_of(s, env_id)).values() if r.kind in kinds]


async def _remember(env_id, service: str, kind: str, external_id, name: str) -> None:
    """Record something Sirdar just created, at once and on its own, so a
    later failure in the same step still knows it is Sirdar's."""
    async with get_sessionmaker()() as s:
        await s.execute(delete(ManagedRecord).where(
            ManagedRecord.environment_id == env_id, ManagedRecord.service == service,
            ManagedRecord.kind == kind))
        s.add(ManagedRecord(environment_id=env_id, service=service, kind=kind,
                            external_id=str(external_id), name=name, origin="created"))
        await s.commit()


async def _forget(row_id) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(delete(ManagedRecord).where(ManagedRecord.id == row_id))
        await s.commit()


# DNS

async def _drop_dns(api: Cloudflare | None, row: ManagedRecord, out: Output) -> None:
    if row.origin == "created":
        deleted = await api.delete(row.external_id)
        out(f"{row.name}: {'deleted the A record' if deleted else 'already gone'}\n")
    else:
        out(f"{row.name}: left in place (claimed, not made by Sirdar)\n")
    await _forget(row.id)


async def ensure_dns(ctx: PublishContext, out: Output, *, transport) -> None:
    cfg = _need_to_publish(ctx.cloudflare, "Cloudflare")
    rows, owners = await _rows_and_owners(ctx.env_id, DNS)
    async with Cloudflare(cfg, transport=transport) as api:
        records = await api.records()
        plan = [(s, dns_status(s, records, current_row(rows, s, DNS), owners, zone=cfg.zone,
                               public_ip=cfg.public_ip)) for s in ctx.services]
        _stop_on_blockers(plan, "DNS records")
        dns_rows = {k: r for k, r in rows.items() if k[1] == DNS}
        for row in stale_rows(dns_rows, ctx.services):
            await _drop_dns(api, row, out)
        for s, st in plan:
            if st.state == "ok":
                out(f"{s.hostname}: A {cfg.public_ip}, unchanged\n")
            elif st.state == "update":
                await api.update_a(st.current.id, name=s.hostname, content=cfg.public_ip,
                                   proxied=s.proxied)
                out(f"{s.hostname}: updated to A {cfg.public_ip}\n")
            else:
                made = await api.create_a(s.hostname, cfg.public_ip, proxied=s.proxied,
                                          comment=f"Managed by Sirdar ({ctx.env_name}/{s.service})")
                await _remember(ctx.env_id, s.service, DNS, made.id, s.hostname)
                out(f"{s.hostname}: created A {cfg.public_ip}\n")


async def remove_dns(ctx: PublishContext, out: Output, *, transport) -> None:
    rows = sorted(await _all_rows(ctx.env_id, (DNS,)), key=lambda r: r.name)
    if not rows:
        out("No DNS records to remove.\n")
        return
    if not any(r.origin == "created" for r in rows):
        for row in rows:
            await _drop_dns(None, row, out)
        return
    cfg = _need_to_remove(ctx.cloudflare, "Cloudflare")
    async with Cloudflare(cfg, transport=transport) as api:
        for row in rows:
            await _drop_dns(api, row, out)


# Proxy hosts and certificates

def new_host_body(sp: ServicePlan) -> dict:
    return {"domain_names": [sp.hostname], "forward_scheme": "http",
            "forward_host": sp.host_ip, "forward_port": sp.port, "certificate_id": 0,
            "ssl_forced": False, "hsts_enabled": False, "hsts_subdomains": False,
            "http2_support": False, "block_exploits": True, "caching_enabled": False,
            "allow_websocket_upgrade": True, "access_list_id": 0,
            "advanced_config": SPACES_ADVANCED if sp.service == "spaces" else "",
            "meta": {"letsencrypt_agree": False, "dns_challenge": False}, "locations": []}


def host_body(host: ProxyHost, sp: ServicePlan, *, certificate_id: int | None = None) -> dict:
    """Read-modify-write: everything the host has (access lists, advanced
    config, ...) with Sirdar's fields on top."""
    body = {k: host.raw[k] for k in npm.HOST_FIELDS if k in host.raw}
    body["locations"] = body.get("locations") or []
    body.update(forward_scheme="http", forward_host=sp.host_ip, forward_port=sp.port,
                allow_websocket_upgrade=True)
    if certificate_id is not None:
        body.update(certificate_id=certificate_id, ssl_forced=True, http2_support=True)
    return body


async def _drop_npm(api: Npm | None, row: ManagedRecord, out: Output) -> None:
    what = "proxy host" if row.kind == PROXY else "certificate"
    if row.origin == "created":
        if row.kind == PROXY:
            deleted = await api.delete_host(int(row.external_id))
        else:
            deleted = await api.delete_certificate(int(row.external_id))
        out(f"{row.name}: {'deleted the' if deleted else 'already gone:'} {what} "
            f"#{row.external_id}\n")
    else:
        out(f"{row.name}: left the {what} in place (claimed, not made by Sirdar)\n")
    await _forget(row.id)


async def _ensure_certificate(api: Npm, ctx: PublishContext, sp: ServicePlan, host: ProxyHost,
                              certs: list[Certificate], email: str, rows: dict,
                              now: datetime, out: Output) -> int:
    """Spec: keep a covering certificate with more than RENEW_DAYS left;
    renew the host's own Let's Encrypt one when it is closer; else reuse
    another covering one; else request one (HTTP challenge)."""
    current = (next((c for c in certs if c.id == host.certificate_id), None)
               if host.certificate_id else None)
    if current is not None and covers(current, sp.hostname):
        left = days_left(current, now)
        if left is None or left > RENEW_DAYS:
            return current.id
        if current.provider == "letsencrypt":
            out(f"{sp.hostname}: certificate #{current.id} expires {_date(current)}; renewing\n")
            renewed = await api.renew_certificate(current.id, sp.hostname, out=out)
            certs[:] = [renewed if c.id == renewed.id else c for c in certs]
            return renewed.id
    other = usable_certificate(certs, sp.hostname, now)
    if other is not None:
        out(f"{sp.hostname}: using certificate #{other.id}\n")
        return other.id
    out(f"{sp.hostname}: requesting a Let's Encrypt certificate\n")
    made = await api.request_certificate(sp.hostname, email, out=out)
    certs.append(made)
    await _remember(ctx.env_id, sp.service, CERT, made.id, sp.hostname)
    old = rows.get((sp.service, CERT))
    if old is not None and old.origin == "created" and old.external_id != str(made.id):
        try:
            await api.delete_certificate(int(old.external_id))
        except NpmError:
            out(f"{sp.hostname}: couldn't delete the old certificate #{old.external_id}; "
                "it stays in Nginx Proxy Manager\n")
    return made.id


async def ensure_proxy(ctx: PublishContext, out: Output, *, transport,
                       sleep: Callable[[float], Awaitable[None]], now: datetime,
                       backoff: tuple[int, ...]) -> None:
    cfg = _need_to_publish(ctx.npm, "Nginx Proxy Manager")
    rows, owners = await _rows_and_owners(ctx.env_id, PROXY)
    async with Npm(cfg, transport=transport, sleep=sleep, backoff=backoff) as api:
        hosts = await api.proxy_hosts()
        certs = await api.certificates()
        plan = [(s, proxy_status(s, hosts, current_row(rows, s, PROXY), owners))
                for s in ctx.services]
        _stop_on_blockers(plan, "proxy hosts")
        npm_rows = {k: r for k, r in rows.items() if k[1] in (PROXY, CERT)}
        for row in sorted(stale_rows(npm_rows, ctx.services), key=lambda r: r.kind != PROXY):
            await _drop_npm(api, row, out)       # hosts before the certificates they use
        for s, st in plan:
            found = st.current
            if st.state == "create":
                found = await api.create_host(new_host_body(s))
                await _remember(ctx.env_id, s.service, PROXY, found.id, s.hostname)
                out(f"{s.hostname}: created a proxy host to {s.forward}\n")
            elif st.state == "update":
                found = await api.update_host(found.id, host_body(found, s))
                out(f"{s.hostname}: proxy host now goes to {s.forward}\n")
            else:
                out(f"{s.hostname}: proxy host to {s.forward}, unchanged\n")
            cert_id = await _ensure_certificate(api, ctx, s, found, certs,
                                                cfg.letsencrypt_email, rows, now, out)
            if (found.certificate_id != cert_id or not found.ssl_forced
                    or not found.http2_support):
                await api.update_host(found.id, host_body(found, s, certificate_id=cert_id))
                out(f"{s.hostname}: HTTPS with certificate #{cert_id}, Force SSL on\n")


async def remove_proxy(ctx: PublishContext, out: Output, *, transport) -> None:
    rows = sorted(await _all_rows(ctx.env_id, (PROXY, CERT)),
                  key=lambda r: (r.kind != PROXY, r.name))
    if not rows:
        out("No proxy hosts or certificates to remove.\n")
        return
    if not any(r.origin == "created" for r in rows):
        for row in rows:
            await _drop_npm(None, row, out)
        return
    cfg = _need_to_remove(ctx.npm, "Nginx Proxy Manager")
    async with Npm(cfg, transport=transport) as api:
        for row in rows:
            await _drop_npm(api, row, out)


# Smoke test

async def run_smoke(ctx: PublishContext, out: Output, *, transport,
                    sleep: Callable[[float], Awaitable[None]], attempts: int,
                    delay: float) -> None:
    results = await smoke.run([(s.service, s.hostname) for s in ctx.services], ctx.proxy_ip,
                              transport=transport, sleep=sleep, attempts=attempts, delay=delay,
                              out=out)
    for r in results:
        out(f"{r.url}: {r.detail}\n")
    failed = [r.service for r in results if not r.ok]
    if failed:
        raise StepFailed(f"{len(failed)} of {len(results)} public URLs didn't answer: "
                         f"{', '.join(failed)}.")


class HttpPublisher:
    """The real publisher: steps 12–14 and 16–17 against Cloudflare, Nginx
    Proxy Manager and the public URLs, through outbound.transports(). Waits
    and the clock are injectable for tests."""

    def __init__(self, *, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 now: Callable[[], datetime] | None = None,
                 cert_backoff: tuple[int, ...] = CERT_BACKOFF,
                 smoke_attempts: int = smoke.ATTEMPTS, smoke_delay: float = smoke.DELAY):
        self._sleep = sleep
        self._now = now or (lambda: datetime.now(UTC))
        self._backoff = cert_backoff
        self._smoke_attempts = smoke_attempts
        self._smoke_delay = smoke_delay

    async def run(self, step: str, ctx: PublishContext, out: Output) -> None:
        transports = outbound.transports()
        try:
            match step:
                case "dns":
                    await ensure_dns(ctx, out, transport=transports["cloudflare"])
                case "proxy":
                    await ensure_proxy(ctx, out, transport=transports["npm"], sleep=self._sleep,
                                       now=self._now(), backoff=self._backoff)
                case "smoke":
                    await run_smoke(ctx, out, transport=transports["smoke"], sleep=self._sleep,
                                    attempts=self._smoke_attempts, delay=self._smoke_delay)
                case "unproxy":
                    await remove_proxy(ctx, out, transport=transports["npm"])
                case "undns":
                    await remove_dns(ctx, out, transport=transports["cloudflare"])
                case _:
                    raise ValueError(f"{step!r} isn't a publish step")
        except (CloudflareError, NpmError) as e:
            raise StepFailed(e.reason) from None
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_publish_steps.py tests/test_deploy_publish.py`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/publish.py tests/test_deploy_publish_steps.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/publish.py \
  sirdar/api/tests/test_deploy_publish_steps.py
git commit -m "feat(sirdar): DNS, proxy, smoke and removal steps over managed records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Steps 12–17, the plans, and `teardown.yml`

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py`
- Create: `sirdar/api/src/sirdar_api/deploy/ansible/teardown.yml`
- Test: `sirdar/api/tests/test_deploy_playbooks.py`

**Interfaces:**
- Produces (module `sirdar_api.deploy.steps`): `StepDef` gains `runs: Literal["ansible", "python"] = "ansible"` (python steps have `playbook == ""`); `MODES` adds `"publish"`, `"teardown"`; `PUBLISHING_MODES = ("update", "reset", "restore_dump", "rollback")`; `PUBLISH_KEYS = ("dns", "proxy", "smoke")`; `ANSIBLE_STEPS`; `plan_for(mode, *, restore=False, publish=False)` (publish appends 12–14 to a publishing mode; `ValueError` for any other mode).
- Produces (playbook `teardown.yml`): vars `env_name`, `env_dir`, `ss_stack`; optional `env_root` (default `/opt/serversherpa`) and `teardown_become` (default true; the local test passes false).

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_playbooks.py`, replace:

```python
def _keys(mode, restore=False):
    return [s.key for s in steps.plan_for(mode, restore=restore)]


def test_plans():
    assert [s.number for s in steps.STEPS] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11]
```

with:

```python
def _keys(mode, restore=False, publish=False):
    return [s.key for s in steps.plan_for(mode, restore=restore, publish=publish)]


def test_publish_and_teardown_plans():
    published = ["dns", "proxy", "smoke"]
    for mode in steps.PUBLISHING_MODES:
        for restore in ((False, True) if mode in ("update", "reset") else (False,)):
            assert _keys(mode, restore, publish=True) == [*_keys(mode, restore), *published]
    assert [s.number for s in steps.plan_for("update", publish=True)] == [
        1, 2, 3, 4, 5, 6, 10, 12, 13, 14]
    assert _keys("publish") == published
    assert _keys("teardown") == ["teardown", "unproxy", "undns"]
    assert [s.number for s in steps.plan_for("teardown")] == [15, 16, 17]
    for mode in ("snapshot", "publish", "teardown"):
        with pytest.raises(ValueError):
            steps.plan_for(mode, publish=True)
    runs = {s.key: s.runs for s in steps.STEPS}
    assert [k for k, r in runs.items() if r == "python"] == [
        "dns", "proxy", "smoke", "unproxy", "undns"]
    assert all(s.playbook == "" for s in steps.STEPS if s.runs == "python")
    assert steps.STEPS_BY_KEY["proxy"].timeout >= 30 * 60
    assert (steps.STEPS_BY_KEY["dns"].name, steps.STEPS_BY_KEY["teardown"].name) == (
        "DNS records", "Remove environment")


def test_plans():
    assert [s.number for s in steps.STEPS] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12, 13, 14,
                                               15, 16, 17]
```

Then replace:

```python
def test_every_playbook_belongs_to_a_step():
    assert sorted(p.name for p in PLAYBOOK_DIR.glob("*.yml")) == \
        sorted(s.playbook for s in steps.STEPS)


def test_playbooks_ship_with_the_package():
    folder = resources.files("sirdar_api.deploy").joinpath("ansible")
    for step in steps.STEPS:
        assert folder.joinpath(step.playbook).is_file()


@pytest.mark.parametrize("step", steps.STEPS, ids=lambda s: s.key)
def test_playbook_shape(step):
```

with:

```python
def test_every_playbook_belongs_to_a_step():
    assert sorted(p.name for p in PLAYBOOK_DIR.glob("*.yml")) == \
        sorted(s.playbook for s in steps.ANSIBLE_STEPS)


def test_playbooks_ship_with_the_package():
    folder = resources.files("sirdar_api.deploy").joinpath("ansible")
    for step in steps.ANSIBLE_STEPS:
        assert folder.joinpath(step.playbook).is_file()


@pytest.mark.parametrize("step", steps.ANSIBLE_STEPS, ids=lambda s: s.key)
def test_playbook_shape(step):
```

and replace:

```python
@pytest.mark.parametrize("step", steps.STEPS, ids=lambda s: s.key)
def test_syntax_check(step, tmp_path):
```

with:

```python
@pytest.mark.parametrize("step", steps.ANSIBLE_STEPS, ids=lambda s: s.key)
def test_syntax_check(step, tmp_path):
```

Append to the end of `sirdar/api/tests/test_deploy_playbooks.py`:

```python
# ---- step 15: Remove environment ------------------------------------------------------

def _teardown_vars(env_dir: Path, tmp_path: Path) -> dict:
    # _target names the folder "env": that is the environment name the
    # playbook's safety check compares against, under env_root = tmp_path.
    return {**_common(env_dir), "env_name": "env", "env_root": str(tmp_path),
            "teardown_become": False}


def test_teardown_playbook_stops_everything_and_removes_the_folder(tmp_path):
    env_dir, env = _target(tmp_path)
    result, calls = _play(tmp_path, "teardown.yml", _teardown_vars(env_dir, tmp_path), env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert [c.split(" -f ")[-1] for c in calls if c.startswith("compose")] == [
        f"{env_dir}/repo/deploy/stack/{s}/compose.yml down --volumes"
        for s in ("status", "web", "api", "storage", "db")]
    assert "network rm ss-e2e" in calls
    assert not env_dir.exists()
    assert (REPO / "deploy" / "stack" / "ss-stack").is_file()      # the symlink went, not this


def test_teardown_playbook_removes_a_folder_that_never_deployed(tmp_path):
    env_dir, env = _target(tmp_path)
    (env_dir / ".env").unlink()
    result, calls = _play(tmp_path, "teardown.yml", _teardown_vars(env_dir, tmp_path), env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert calls == [] and not env_dir.exists()
    again, _ = _play(tmp_path, "teardown.yml", _teardown_vars(env_dir, tmp_path), env)
    assert again.returncode == 0, again.stdout + again.stderr


def test_teardown_playbook_refuses_a_folder_outside_the_root(tmp_path):
    env_dir, env = _target(tmp_path)
    extra = {**_teardown_vars(env_dir, tmp_path), "env_root": "/opt/serversherpa"}
    result, calls = _play(tmp_path, "teardown.yml", extra, env)
    assert result.returncode != 0
    assert f"Refusing to remove {env_dir}" in result.stdout
    assert calls == [] and env_dir.exists()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_playbooks.py`
Expected: FAIL — `AttributeError: module 'sirdar_api.deploy.steps' has no attribute 'ANSIBLE_STEPS'` at collection.

- [ ] **Step 3: Write the steps**

Replace the whole of `sirdar/api/src/sirdar_api/deploy/steps.py` with:

```python
"""The deploy steps (spec Section 2) and the plan each mode runs.

Numbers follow the spec's order: 8 starts the data services, 9 restores
data and 10 ("Start services": `ss-stack up` runs migrate, then the app)
covers spec steps 10–11. Restore snapshot and Restore backup share number
9 and never meet in one plan. Take snapshot (11) is a job of its own.

12–14 publish (DNS records, proxy hosts, smoke test). They run in Sirdar
itself (runs="python", see publish.py) and a deployment has them when it
publishes; a "publish" deployment is only them. Delete environment
("teardown") runs 15 (stacks and folder on the host, an Ansible playbook),
then 16 and 17 (the proxy hosts and DNS records Sirdar made)."""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

PLAYBOOK_DIR = Path(__file__).resolve().parent / "ansible"
MODES = ("update", "reset", "snapshot", "restore_dump", "rollback", "publish", "teardown")
# Modes that change what runs on the host: they publish afterwards when asked.
PUBLISHING_MODES = ("update", "reset", "restore_dump", "rollback")
PUBLISH_KEYS = ("dns", "proxy", "smoke")


@dataclass(frozen=True)
class StepDef:
    number: int
    key: str
    name: str
    playbook: str                # "" for a step that runs in Sirdar
    timeout: int                 # seconds for the whole step
    runs: Literal["ansible", "python"] = "ansible"


STEPS: tuple[StepDef, ...] = (
    StepDef(1, "preflight", "Preflight", "preflight.yml", 5 * 60),
    StepDef(2, "bootstrap", "Bootstrap", "bootstrap.yml", 30 * 60),
    StepDef(3, "fetch", "Fetch code", "fetch.yml", 15 * 60),
    StepDef(4, "render", "Render config", "render.yml", 5 * 60),
    StepDef(5, "build", "Build images", "build.yml", 90 * 60),
    StepDef(6, "dump", "Pre-deploy dump", "dump.yml", 30 * 60),
    StepDef(7, "reset", "Reset data", "reset.yml", 15 * 60),
    StepDef(8, "data", "Start data services", "data.yml", 15 * 60),
    StepDef(9, "restore", "Restore snapshot", "restore.yml", 120 * 60),
    StepDef(9, "restore_dump", "Restore backup", "restore_dump.yml", 60 * 60),
    StepDef(10, "up", "Start services", "up.yml", 45 * 60),
    StepDef(11, "export", "Take snapshot", "export.yml", 120 * 60),
    StepDef(12, "dns", "DNS records", "", 10 * 60, "python"),
    StepDef(13, "proxy", "Proxy hosts", "", 45 * 60, "python"),
    StepDef(14, "smoke", "Smoke test", "", 10 * 60, "python"),
    StepDef(15, "teardown", "Remove environment", "teardown.yml", 30 * 60),
    StepDef(16, "unproxy", "Remove proxy hosts", "", 15 * 60, "python"),
    StepDef(17, "undns", "Remove DNS records", "", 10 * 60, "python"),
)
STEPS_BY_KEY = {s.key: s for s in STEPS}
ANSIBLE_STEPS = tuple(s for s in STEPS if s.runs == "ansible")

_BUILD = ("preflight", "bootstrap", "fetch", "render", "build")
# (mode, restores a snapshot) -> step keys, in order.
_PLANS: dict[tuple[str, bool], tuple[str, ...]] = {
    ("update", False): (*_BUILD, "dump", "up"),
    # the first deploy of an environment created from a snapshot; the dump
    # backs up a database already on the host (not required: usually none)
    # before ss-stack restore drops it
    ("update", True): (*_BUILD, "dump", "data", "restore", "up"),
    ("reset", False): (*_BUILD, "reset", "up"),
    ("reset", True): (*_BUILD, "reset", "data", "restore", "up"),
    # The deployed commit (current_sha) again, rendered with Sirdar's stored
    # keys: a failed Update may have left repo/ and .env at another commit,
    # and a failed restoring Reset the snapshot's keys in .env. Build is cached.
    ("restore_dump", False): ("preflight", "fetch", "render", "build", "data", "restore_dump",
                              "up"),
    # the previous commit, with the failed deployment's pre-deploy dump
    ("rollback", False): ("preflight", "fetch", "render", "build", "data", "restore_dump", "up"),
    ("snapshot", False): ("preflight", "export"),
    ("publish", False): PUBLISH_KEYS,
    # the host first: nothing is unpublished while the environment still runs
    ("teardown", False): ("teardown", "unproxy", "undns"),
}


def plan_for(mode: str, *, restore: bool = False, publish: bool = False) -> list[StepDef]:
    try:
        keys = _PLANS[(mode, restore)]
    except KeyError:
        raise ValueError(f"no deploy plan for mode {mode!r} (restore={restore})") from None
    if publish:
        if mode not in PUBLISHING_MODES:
            raise ValueError(f"mode {mode!r} doesn't publish")
        keys = (*keys, *PUBLISH_KEYS)
    return [STEPS_BY_KEY[k] for k in keys]
```

- [ ] **Step 4: Write the playbook**

Create `sirdar/api/src/sirdar_api/deploy/ansible/teardown.yml`:

```yaml
# Step 15 — Remove environment (Delete environment only): stop every stack
# and delete its volumes and network (ss-stack down --volumes), then delete
# the environment's folder: checkout, .env and backups. Images stay: another
# environment on this host may run the same commit. A folder without a .env
# or ss-stack (never deployed, half bootstrapped) is simply deleted. Steps
# 16 and 17 then remove the proxy hosts and DNS records Sirdar made.
- name: Remove environment
  hosts: target
  gather_facts: false
  vars:
    root: "{{ env_root | default('/opt/serversherpa') }}"
  tasks:
    - name: Only an environment's own folder
      ansible.builtin.assert:
        that:
          - env_name is match('^[a-z][a-z0-9-]{1,31}$')
          - env_dir == root ~ '/' ~ env_name
        fail_msg: "Refusing to remove {{ env_dir }}: it isn't {{ root }}/{{ env_name }}."
        quiet: true

    - name: Look for the environment's .env
      ansible.builtin.stat:
        path: "{{ env_dir }}/.env"
      register: env_file

    - name: Look for ss-stack
      ansible.builtin.stat:
        path: "{{ ss_stack }}"
      register: stack_tool

    - name: ss-stack down --volumes
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", down, "{{ env_dir }}", --volumes]
      when: env_file.stat.exists and stack_tool.stat.exists
      changed_when: true

    - name: Remove the environment folder
      become: "{{ teardown_become | default(true) | bool }}"
      ansible.builtin.file:
        path: "{{ env_dir }}"
        state: absent
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_playbooks.py tests/test_deploy_runner.py`
Expected: PASS (the runner tests read `STEPS` for the stale-run age and still pass).

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/steps.py tests/test_deploy_playbooks.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/steps.py \
  sirdar/api/src/sirdar_api/deploy/ansible/teardown.yml sirdar/api/tests/test_deploy_playbooks.py
git commit -m "feat(sirdar): steps 12-17, publish and teardown plans, teardown playbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: The pipeline runs Python steps, publish jobs and Delete environment

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py`
- Create: `sirdar/api/tests/fake_publisher.py`
- Modify: `sirdar/api/tests/deploy_factories.py` (fixture `fake_publisher`)
- Test: `sirdar/api/tests/test_deploy_pipeline_publish.py`

**Interfaces:**
- Consumes: `steps.plan_for(..., publish=)`, `StepDef.runs` (Task 9); `publish.prepare`, `publish.PublishError`, `publish.StepFailed`, `publish.Publisher`, `publish.HttpPublisher`, `PublishContext.secret_values` (Tasks 7–8); `services.audit.audit`.
- Produces (module `sirdar_api.deploy.pipeline`): `KEEPS_STATUS = ("snapshot", "publish")`; `make_publisher(settings) -> publish.Publisher` (tests replace it); `create_deployment(..., start_step: int | None = None, publish: bool = False)` (start_step None = the plan's first step; stores `Deployment.publish`; teardown sets the environment to `deleting`; `publish` and `snapshot` leave its status); `plan_of(dep)` honors `dep.publish`; `_prepare(db, env, dep, settings, *, needs_host=True, more_secrets=())`; `_Context.target` may be `None` and `_Context.publishing: PublishContext | None`; a succeeded teardown audits `deploy.environment_delete` `{environment, deployment}` (actor = the deployment's) and deletes the environment row; `recover_orphans` fails a `deleting` environment too.
- Produces (tests): `tests/fake_publisher.py` — `class FakePublisher` with `.calls`, `.contexts`, `.fail: dict[str, str]` (step → StepFailed reason), `.raises: dict[str, Exception]`, `.gates: dict[str, asyncio.Event]`, `.echo: dict[str, str]` (step → the line it prints; default `"<step>: ok\n"`); fixture `fake_publisher` in `tests/deploy_factories.py`.

- [ ] **Step 1: Write the fake and its fixture**

Create `sirdar/api/tests/fake_publisher.py`:

```python
"""A Publisher for pipeline tests: records each step and its context,
prints one line, and can fail (StepFailed), raise, or wait on a gate."""

import asyncio

from sirdar_api.deploy import publish


class FakePublisher:
    def __init__(self):
        self.calls: list[str] = []
        self.contexts: list = []
        self.fail: dict[str, str] = {}
        self.raises: dict[str, Exception] = {}
        self.gates: dict[str, asyncio.Event] = {}
        self.echo: dict[str, str] = {}

    async def run(self, step: str, ctx, out) -> None:
        self.calls.append(step)
        self.contexts.append(ctx)
        out(self.echo.get(step, f"{step}: ok\n"))
        if step in self.gates:
            await self.gates[step].wait()
        if step in self.raises:
            raise self.raises[step]
        if step in self.fail:
            raise publish.StepFailed(self.fail[step])
```

In `sirdar/api/tests/deploy_factories.py`, replace:

```python
from .fake_runner import FakeRunner
```

with:

```python
from .fake_publisher import FakePublisher
from .fake_runner import FakeRunner
```

and replace:

```python
@pytest.fixture(autouse=True)
async def stop_pipeline():
```

with:

```python
@pytest.fixture
def fake_publisher(monkeypatch):
    publisher = FakePublisher()
    monkeypatch.setattr(pipeline, "make_publisher", lambda settings: publisher)
    return publisher


@pytest.fixture(autouse=True)
async def stop_pipeline():
```

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_pipeline_publish.py`:

```python
import asyncio
from dataclasses import replace

from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import AuditLog, Deployment, Environment, Integration
from sirdar_api.deploy import pipeline
from sirdar_api.deploy.runner import RunResult
from sirdar_api.deploy.steps import STEPS_BY_KEY

from .deploy_factories import (  # noqa: F401
    fake_publisher,
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
)
from .integration_helpers import CF_TOKEN, configure
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import OLD, SHA, UPDATE_KEYS, _load, env  # noqa: F401

PUBLISHED = ["dns", "proxy", "smoke"]


async def _start(db, env, mode="update", **kw):
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main",
                                           sha=kw.pop("sha", SHA), actor_id=None, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_a_publishing_update_runs_12_to_14_after_the_host(db, env, fake_runner,
                                                                fake_publisher):
    dep_id = await _start(db, env, publish=True)
    dep, steps, e = await _load(dep_id)
    assert fake_runner.steps() == UPDATE_KEYS
    assert fake_publisher.calls == PUBLISHED
    assert [(s.number, s.key, s.status) for s in steps][-3:] == [
        (12, "dns", "succeeded"), (13, "proxy", "succeeded"), (14, "smoke", "succeeded")]
    assert steps[-1].log == "smoke: ok\n"
    assert (dep.status, dep.publish, e.status, e.current_sha) == ("succeeded", True, "ready",
                                                                  SHA)
    ctx = fake_publisher.contexts[0]
    assert (ctx.env_name, ctx.proxy_ip, ctx.services[0].hostname) == (
        "uat", "10.0.0.2", "api.uat.serversherpa.com")
    assert [s.key for s in pipeline.plan_of(dep)][-3:] == PUBLISHED


async def test_an_update_without_publish_has_no_publish_steps(db, env, fake_runner,
                                                              fake_publisher):
    dep_id = await _start(db, env)
    _, steps, _ = await _load(dep_id)
    assert [s.key for s in steps] == UPDATE_KEYS and fake_publisher.calls == []


async def test_a_publish_job_needs_no_host_and_keeps_the_environment(
        db, deploy_env, secrets_key, fake_runner, fake_publisher):
    deploy_env()                            # no SSH target configured at all
    env = await make_environment(db, current_sha=OLD, status="failed")
    dep = await pipeline.create_deployment(db, env, mode="publish", git_ref="main", sha=OLD,
                                           actor_id=None)
    await db.commit()
    await db.refresh(env)
    assert env.status == "failed"            # a publish job never marks it deploying
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    d, steps, e = await _load(dep.id)
    assert fake_runner.requests == [] and fake_publisher.calls == PUBLISHED
    assert (d.status, e.status, e.current_sha) == ("succeeded", "failed", OLD)
    assert [s.number for s in steps] == [12, 13, 14]


async def test_a_failed_publish_step_stops_with_its_reason(db, env, fake_runner,
                                                           fake_publisher):
    fake_publisher.fail["proxy"] = "Sirdar changed nothing: these proxy hosts are in the way."
    dep_id = await _start(db, env, publish=True)
    dep, steps, e = await _load(dep_id)
    by_key = {s.key: s for s in steps}
    assert (dep.status, dep.failed_step, dep.error) == (
        "failed", 13, "Step 13 (Proxy hosts) failed. See its log.")
    assert by_key["proxy"].log == ("proxy: ok\nSirdar changed nothing: these proxy hosts are "
                                   "in the way.\n")
    assert by_key["smoke"].status == "not_run" and e.status == "failed"


async def test_a_failed_publish_job_leaves_the_environment_status(db, env, fake_runner,
                                                                  fake_publisher):
    fake_publisher.fail["smoke"] = "1 of 6 public URLs didn't answer: portal."
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    dep, _, e = await _load(dep_id)
    assert (dep.status, dep.failed_step, e.status) == ("failed", 14, "ready")


async def test_python_step_timeout_and_crash(db, env, fake_runner, fake_publisher,
                                             monkeypatch):
    monkeypatch.setitem(STEPS_BY_KEY, "dns", replace(STEPS_BY_KEY["dns"], timeout=0.05))
    fake_publisher.gates["dns"] = asyncio.Event()
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    dep, steps, _ = await _load(dep_id)
    assert dep.error.startswith("Step 12 (DNS records) timed out")
    assert steps[0].status == "failed"
    fake_publisher.gates.clear()
    fake_publisher.raises["dns"] = RuntimeError("upstream said SECRET-DETAIL")
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    _, steps, _ = await _load(dep_id)
    assert steps[0].log == "dns: ok\nSirdar couldn't run this step.\n"


async def test_credentials_are_redacted_from_python_step_logs(db, env, fake_runner,
                                                              fake_publisher):
    await configure(db)
    fake_publisher.echo["dns"] = f"token {CF_TOKEN} in a line\n"
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    _, steps, _ = await _load(dep_id)
    assert steps[0].log == "token [redacted] in a line\n"


async def test_unreadable_credentials_fail_the_first_step(db, env, fake_runner,
                                                          fake_publisher):
    db.add(Integration(kind="npm", config={"url": "http://10.10.48.6:81",
                                           "identity": "a@b.co", "letsencrypt_email": "a@b.co"},
                       secret_enc=Fernet(Fernet.generate_key()).encrypt(b"x")))
    await db.commit()
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    dep, steps, _ = await _load(dep_id)
    reason = ("The stored credentials don't open with the current SIRDAR_SECRETS_KEY. Enter "
              "them again in Settings.")
    assert (dep.status, dep.failed_step, dep.error) == ("failed", 12, reason)
    assert steps[0].log == reason + "\n" and fake_publisher.calls == []


async def test_a_retry_of_publish_steps_runs_without_the_host(db, env, fake_runner,
                                                              fake_publisher):
    fake_publisher.fail["proxy"] = "busy"
    first = await _start(db, env, publish=True)
    fake_publisher.fail.clear()
    host_calls = len(fake_runner.requests)
    retry = await _start(db, env, publish=True, start_step=13, retry_of=first)
    dep, steps, e = await _load(retry)
    assert len(fake_runner.requests) == host_calls          # no SSH step ran again
    assert fake_publisher.calls[-2:] == ["proxy", "smoke"]
    assert [(s.number, s.status) for s in steps if s.number >= 12] == [
        (12, "skipped"), (13, "succeeded"), (14, "succeeded")]
    assert (dep.status, e.status, e.current_sha) == ("succeeded", "ready", SHA)


async def test_teardown_removes_the_environment(db, env, fake_runner, fake_publisher):
    env_id = env.id
    dep = await pipeline.create_deployment(db, env, mode="teardown", git_ref="main", sha="",
                                           actor_id=None)
    await db.commit()
    await db.refresh(env)
    assert env.status == "deleting"
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    assert fake_runner.steps() == ["teardown"]
    assert fake_runner.requests[0].extravars["env_dir"] == "/opt/serversherpa/uat"
    assert fake_publisher.calls == ["unproxy", "undns"]
    async with get_sessionmaker()() as s:
        assert await s.get(Environment, env_id) is None
        assert await s.get(Deployment, dep.id) is None
        audit = await s.scalar(select(AuditLog).where(
            AuditLog.action == "deploy.environment_delete"))
    assert (audit.entity_id, audit.changes) == ("uat", {"environment": "uat",
                                                        "deployment": str(dep.id)})


async def test_a_failed_teardown_keeps_the_environment(db, env, fake_runner, fake_publisher):
    fake_runner.results["teardown"] = RunResult(status="failed", rc=2)
    dep_id = await _start(db, env, mode="teardown", sha="")
    dep, steps, e = await _load(dep_id)
    assert (dep.status, dep.failed_step, e.status) == ("failed", 15, "failed")
    assert [s.status for s in steps] == ["failed", "not_run", "not_run"]
    assert fake_publisher.calls == []


async def test_recover_orphans_fails_a_deleting_environment(db, env):
    await pipeline.create_deployment(db, env, mode="teardown", git_ref="main", sha="",
                                     actor_id=None)
    await db.commit()
    assert await pipeline.recover_orphans() == 1
    await db.refresh(env)
    assert env.status == "failed"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_pipeline_publish.py`
Expected: FAIL — `TypeError: create_deployment() got an unexpected keyword argument 'publish'` (and `make_publisher` missing).

- [ ] **Step 4: Update the pipeline**

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`:

Replace the first paragraph of the module docstring:

```python
"""Deployment pipeline (spec Section 2: steps 1–11 here; DNS, proxy and smoke
tests come in phase 4). Besides Update and Reset it runs the snapshot
modes: Reset (or a first deploy) that restores a snapshot, Restore backup,
Roll back, and Take snapshot, a job that leaves the environment as it is.
```

with:

```python
"""Deployment pipeline (spec Section 2). Besides Update and Reset it runs the
snapshot modes: Reset (or a first deploy) that restores a snapshot, Restore
backup, Roll back, and Take snapshot, a job that leaves the environment as
it is. A deployment that publishes adds steps 12–14 (DNS records, proxy
hosts, smoke test), which run in Sirdar through a Publisher instead of a
playbook; a publish job is only those. Delete environment (teardown) runs
15–17 and, when they succeed, deletes the environment's row.
```

Replace:

```python
from dataclasses import dataclass, field
```

with:

```python
from dataclasses import dataclass, field, replace
```

Replace:

```python
from sirdar_api.deploy import ConnectFailed, envfile, known_hosts, snapshots, ssh, targets, vault
```

with:

```python
from sirdar_api.deploy import (
    ConnectFailed,
    envfile,
    known_hosts,
    publish,
    snapshots,
    ssh,
    targets,
    vault,
)
```

Replace:

```python
from sirdar_api.deploy.steps import STEPS_BY_KEY, StepDef, plan_for

log = logging.getLogger(__name__)
```

with:

```python
from sirdar_api.deploy.steps import STEPS_BY_KEY, StepDef, plan_for
from sirdar_api.services.audit import audit

log = logging.getLogger(__name__)
```

Replace:

```python
RETRYABLE_STATUSES = ("failed", "cancelled", "interrupted")
```

with:

```python
RETRYABLE_STATUSES = ("failed", "cancelled", "interrupted")
# Jobs that leave the environment's status, commit and image tag as they are.
KEEPS_STATUS = ("snapshot", "publish")
```

Replace:

```python
def make_runner(settings: Settings) -> Runner:
    """The runner every deployment uses (tests replace this function)."""
    return AnsibleRunner(settings.runner_dir)
```

with:

```python
def make_runner(settings: Settings) -> Runner:
    """The runner every deployment uses (tests replace this function)."""
    return AnsibleRunner(settings.runner_dir)


def make_publisher(settings: Settings) -> publish.Publisher:
    """What runs steps 12–14 and 16–17 (tests replace this function)."""
    return publish.HttpPublisher()
```

Replace:

```python
def plan_of(dep: Deployment) -> list[StepDef]:
    return plan_for(dep.mode, restore=restores(dep.mode, dep.snapshot_id))
```

with:

```python
def plan_of(dep: Deployment) -> list[StepDef]:
    return plan_for(dep.mode, restore=restores(dep.mode, dep.snapshot_id), publish=dep.publish)
```

Replace:

```python
async def create_deployment(db: AsyncSession, env: Environment, *, mode: str, git_ref: str,
                            sha: str, actor_id: uuid.UUID | None, start_step: int = 1,
                            retry_of: uuid.UUID | None = None,
                            snapshot_id: uuid.UUID | None = None,
                            restore_dump: str | None = None) -> Deployment:
    """Add a running deployment and its step rows. The caller commits, then
    calls launch(). Raises DeployInProgress (only the insert is rolled back,
    through a savepoint: the caller's session and objects stay usable), or
    ValueError when start_step isn't a step of this mode's plan. A snapshot
    job leaves the environment's status alone."""
    plan = plan_for(mode, restore=restores(mode, snapshot_id))
```

with:

```python
async def create_deployment(db: AsyncSession, env: Environment, *, mode: str, git_ref: str,
                            sha: str, actor_id: uuid.UUID | None,
                            start_step: int | None = None,
                            retry_of: uuid.UUID | None = None,
                            snapshot_id: uuid.UUID | None = None,
                            restore_dump: str | None = None,
                            publish: bool = False) -> Deployment:
    """Add a running deployment and its step rows. The caller commits, then
    calls launch(). start_step None means the plan's first step (1, or 12
    for a publish job, 15 for a teardown). Raises DeployInProgress (only the
    insert is rolled back, through a savepoint: the caller's session and
    objects stay usable), or ValueError when start_step isn't a step of this
    mode's plan (or the mode can't publish). Snapshot and publish jobs leave
    the environment's status alone; a teardown marks it deleting."""
    plan = plan_for(mode, restore=restores(mode, snapshot_id), publish=publish)
    if start_step is None:
        start_step = plan[0].number
```

Replace:

```python
                     snapshot_id=snapshot_id, restore_dump=restore_dump,
                     dump_path=dump_path)
```

with:

```python
                     snapshot_id=snapshot_id, restore_dump=restore_dump,
                     dump_path=dump_path, publish=publish)
```

Replace:

```python
    if mode != "snapshot":
        env.status = "deploying"
        env.updated_at = _now()
    await db.flush()
    return dep
```

with:

```python
    if mode == "teardown":
        env.status, env.updated_at = "deleting", _now()
    elif mode not in KEEPS_STATUS:
        env.status, env.updated_at = "deploying", _now()
    await db.flush()
    return dep
```

In `recover_orphans`, replace:

```python
                               Environment.status == "deploying")
                        .values(status="failed", updated_at=now))
```

with:

```python
                               Environment.status.in_(("deploying", "deleting")))
                        .values(status="failed", updated_at=now))
```

In `_close`, replace:

```python
                                .values(status="failed"))
        else:
            await s.execute(update(Environment).where(Environment.id == env_id)
                            .values(status="failed", updated_at=now))
```

with:

```python
                                .values(status="failed"))
        elif mode != "publish":          # a publish job leaves the environment as it was
            await s.execute(update(Environment).where(Environment.id == env_id)
                            .values(status="failed", updated_at=now))
```

Replace:

```python
@dataclass(frozen=True)
class _Context:
    target: RunTarget
    common: dict = field(repr=False)
```

with:

```python
@dataclass(frozen=True)
class _Context:
    target: RunTarget | None                   # None when no step runs on the host
    common: dict = field(repr=False)
```

and, in the same class, replace:

```python
    # The restored snapshot's pepper and TOTP key: stored as the
    # environment's own once Restore snapshot succeeds.
    snapshot_keys: dict = field(default_factory=dict, repr=False)
```

with:

```python
    # The restored snapshot's pepper and TOTP key: stored as the
    # environment's own once Restore snapshot succeeds.
    snapshot_keys: dict = field(default_factory=dict, repr=False)
    # Steps 12–14 and 16–17: credentials and the public services.
    publishing: publish.PublishContext | None = field(default=None, repr=False)
```

Replace:

```python
async def _prepare(db: AsyncSession, env: Environment, dep: Deployment,
                   settings: Settings) -> _Context:
    cfg = targets.ssh_config_for(env.target_id, settings)
```

with:

```python
async def _prepare(db: AsyncSession, env: Environment, dep: Deployment, settings: Settings, *,
                   needs_host: bool = True, more_secrets: tuple[str, ...] = ()) -> _Context:
    """Everything the steps need. Without host steps (a publish job, or a
    retry of only steps 12–14 or 16–17) there is no target to connect to:
    only the redactor is built. more_secrets: the integration credentials."""
    if not needs_host:
        return _Context(target=None, common={"env_name": env.name}, env_file_b64="",
                        redactor=Redactor(_redaction_values(more_secrets)))
    cfg = targets.ssh_config_for(env.target_id, settings)
```

and replace:

```python
    redactor = Redactor(_redaction_values([*secrets.values(), env_b64, cfg.password,
                                           cfg.passphrase, cfg.sudo_password, private_key,
                                           *extra_secrets]))
```

with:

```python
    redactor = Redactor(_redaction_values([*secrets.values(), env_b64, cfg.password,
                                           cfg.passphrase, cfg.sudo_password, private_key,
                                           *extra_secrets, *more_secrets]))
```

Replace:

```python
async def _run(deployment_id: uuid.UUID) -> None:
```

with:

```python
async def _run_python_step(publisher: publish.Publisher, ctx: _Context,
                           step: DeploymentStep) -> RunResult:
    """A step that runs in Sirdar: the same log handling as a playbook. A
    StepFailed reason ends the log; any other error shows only our copy."""
    definition = STEPS_BY_KEY[step.key]
    buffer = _LogBuffer(ctx.redactor)
    flusher = asyncio.create_task(_flush_loop(step.id, buffer))
    try:
        await asyncio.wait_for(publisher.run(step.key, ctx.publishing, buffer.append),
                               definition.timeout)
        return RunResult(status="successful", rc=0)
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        return RunResult(status="timeout", rc=-1)
    except publish.StepFailed as e:
        buffer.append(e.reason + "\n")
        return RunResult(status="failed", rc=1)
    # A failed step, never the exception text.
    except Exception as e:  # noqa: BLE001
        log.error("deploy step %s couldn't run: %s", step.key, type(e).__name__)
        buffer.append(UNEXPECTED + "\n")
        return RunResult(status="failed", rc=-1)
    finally:
        flusher.cancel()
        with suppress(asyncio.CancelledError):
            await flusher
        await _save_log(step.id, buffer.text())


async def _run(deployment_id: uuid.UUID) -> None:
```

In `_run`, replace:

```python
                await _mark_running(db, todo[0])
                try:
                    ctx = await _prepare(db, env, dep, settings)
                except PrepareError as e:
```

with:

```python
                await _mark_running(db, todo[0])
                runs = {STEPS_BY_KEY[s.key].runs for s in todo}
                try:
                    publishing = (await publish.prepare(db, env, settings)
                                  if "python" in runs else None)
                    ctx = await _prepare(
                        db, env, dep, settings, needs_host="ansible" in runs,
                        more_secrets=tuple(publishing.secret_values) if publishing else ())
                except (PrepareError, publish.PublishError) as e:
```

then replace:

```python
                await db.commit()
                runner = make_runner(settings)
                for step in todo:
```

with:

```python
                ctx = replace(ctx, publishing=publishing)
                await db.commit()
                runner = make_runner(settings)
                publisher = make_publisher(settings)
                for step in todo:
```

then replace:

```python
                    result = await _run_step(runner, ctx, step)
                    if result.status != "successful":
```

with:

```python
                    if STEPS_BY_KEY[step.key].runs == "python":
                        result = await _run_python_step(publisher, ctx, step)
                    else:
                        result = await _run_step(runner, ctx, step)
                    if result.status != "successful":
```

and replace:

```python
            dep.status, dep.finished_at = "succeeded", now
            if dep.mode != "snapshot":
                env.current_sha, env.image_tag = dep.sha, envfile.image_tag(dep.sha)
                env.status, env.updated_at = "ready", now
            await db.commit()
```

with:

```python
            dep.status, dep.finished_at = "succeeded", now
            if dep.mode == "teardown":
                # Its deployments, steps, services, secrets and managed
                # records go with it (ON DELETE CASCADE); the audit row stays.
                audit(db, actor_id=dep.actor_id, action="deploy.environment_delete",
                      entity_type="environment", entity_id=env.name,
                      changes={"environment": env.name, "deployment": str(dep.id)})
                await db.delete(env)
            elif dep.mode not in KEEPS_STATUS:
                env.current_sha, env.image_tag = dep.sha, envfile.image_tag(dep.sha)
                env.status, env.updated_at = "ready", now
            await db.commit()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_pipeline_publish.py tests/test_deploy_pipeline.py tests/test_deploy_pipeline_snapshots.py`
Expected: PASS (the phase 2–3 pipeline tests are unchanged: their deployments don't publish).

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/pipeline.py tests/fake_publisher.py tests/deploy_factories.py \
  tests/test_deploy_pipeline_publish.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/tests/fake_publisher.py \
  sirdar/api/tests/deploy_factories.py sirdar/api/tests/test_deploy_pipeline_publish.py
git commit -m "feat(sirdar): pipeline runs publish steps, publish jobs and Delete environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: Routes — the Publish tab, publish and teardown deployments, the publish switch

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py`
- Modify: `sirdar/api/src/sirdar_api/dashboard/service.py`
- Modify: `sirdar/api/tests/test_deploy_environments_api.py`
- Test: `sirdar/api/tests/test_deploy_publish_api.py`

**Interfaces:**
- Consumes: `pipeline.create_deployment(..., start_step=None, publish=)` (Task 10); `publish.inspect`, `publish.claim`, `publish.missing_integrations` (Task 7).
- Produces: every route change under "API produced for 4b"; `environments.create_new(..., publish=True)`; `environments.update` accepts `publish`; `serialize.environment_out` adds `publish` and `managed_records`; `serialize.deployment_summary` adds `publish`; audit actions `deploy.publish_claim` `{environment, claimed}`; `deploy.deployment_start` changes gain `"publish": true` for a publishing deploy; `deploy.environment_create` changes gain `publish`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_environments_api.py`, replace:

```python
            "log_level", "services", "secrets_set", "seed_snapshot", "last_deployment",
            "created_at", "updated_at"}
```

with:

```python
            "log_level", "services", "secrets_set", "seed_snapshot", "last_deployment",
            "created_at", "updated_at", "publish", "managed_records"}
```

replace (in `test_create_new_environment`):

```python
        "git_ref": "main", "proxy_ip": "10.10.48.6", "bind_ip": "0.0.0.0"}]
```

with:

```python
        "git_ref": "main", "proxy_ip": "10.10.48.6", "bind_ip": "0.0.0.0", "publish": True}]
```

and append to the end of that file:

```python
async def test_publish_flag_on_create_adopt_and_patch(client, db, target, leak_guard):
    h = await auth_headers(client, db)
    made = (await client.post(URL, headers=h, json=NEW)).json()
    assert (made["publish"], made["managed_records"]) == (True, [])
    off = (await client.post(URL, headers=h, json={**NEW, "name": "qa2", "publish": False}))
    assert off.json()["publish"] is False
    resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "uat", "type": "dev",
                                                   "target": "ssh", "publish": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "publish_not_allowed")
    resp = await client.patch(f"{URL}/qa2", headers=h, json={"publish": True})
    assert resp.json()["publish"] is True
    assert (await _audits(db, "deploy.environment_update"))[-1] == {"changed": ["publish"]}
    assert [c["publish"] for c in await _audits(db, "deploy.environment_create")] == [True, False]
```

Create `sirdar/api/tests/test_deploy_publish_api.py`:

```python
import asyncio

import pytest

from sirdar_api.dashboard.service import _env_state
from sirdar_api.db.models import Environment
from sirdar_api.deploy import environments
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_publisher,
    fake_runner,
    leak_guard,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .integration_helpers import CF_TOKEN, NPM_PASSWORD, configure
from .publish_helpers import PUBLIC_IP, managed, publish_fakes  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_deployments_api import (  # noqa: F401
    OLD,
    SHA,
    UPDATE_KEYS,
    _audits,
    _finish,
    _headers_without_change,
    ready,
)

ENV_URL = "/api/deploy/environments/uat"
START = f"{ENV_URL}/deployments"
PUBLISHED = ["dns", "proxy", "smoke"]


@pytest.fixture
def no_leaks(leak_guard):
    leak_guard.extend([CF_TOKEN, NPM_PASSWORD])
    return leak_guard


async def _publish_on(db, env) -> None:
    env.publish = True
    await db.commit()


async def test_permissions(client, db, ready, publish_fakes):
    viewer = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(f"{ENV_URL}/publish", headers=viewer)).status_code == 200
    for url, body in ((f"{ENV_URL}/publish/claim", None), (START, {"mode": "publish"}),
                      (START, {"mode": "teardown", "confirm_name": "uat"})):
        assert (await client.post(url, headers=viewer, json=body)).status_code == 403, url
    adder = await _headers_without_change(client, db)
    for url, body in ((f"{ENV_URL}/publish/claim", None),
                      (START, {"mode": "teardown", "confirm_name": "uat"})):
        assert (await client.post(url, headers=adder, json=body)).status_code == 403, url


async def test_publish_tab_and_claim(client, db, ready, publish_fakes, no_leaks):
    await configure(db)
    publish_fakes.cf.add("A", "api.uat.serversherpa.com", PUBLIC_IP)
    h = await auth_headers(client, db)
    state = (await client.get(f"{ENV_URL}/publish", headers=h)).json()
    assert state["services"][0]["dns"]["state"] == "claimable"
    assert state["cloudflare"]["configured"] and state["npm"]["configured"]
    resp = await client.post(f"{ENV_URL}/publish/claim", headers=h)
    assert resp.status_code == 200
    assert resp.json()["claimed"] == ["dns:api.uat.serversherpa.com"]
    assert resp.json()["services"][0]["dns"]["origin"] == "claimed"
    assert await _audits(db, "deploy.publish_claim") == [
        {"environment": "uat", "claimed": ["dns:api.uat.serversherpa.com"]}]
    again = await client.post(f"{ENV_URL}/publish/claim", headers=h)
    assert (again.status_code, again.json()["detail"]["code"]) == (409, "nothing_to_claim")
    env = (await client.get(ENV_URL, headers=h)).json()
    assert env["managed_records"] == [{"service": "api", "kind": "dns_record",
                                       "name": "api.uat.serversherpa.com", "origin": "claimed"}]


async def test_claim_waits_for_a_running_deployment(client, db, ready, publish_fakes,
                                                    monkeypatch):
    async def busy(db, env_id):
        return True
    monkeypatch.setattr(environments, "is_deploying", busy)
    h = await auth_headers(client, db)
    resp = await client.post(f"{ENV_URL}/publish/claim", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "deploy_in_progress")


async def test_publish_job(client, db, ready, fake_runner, fake_publisher, no_leaks):
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={"mode": "publish"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "publish_off")
    resp = await client.patch(ENV_URL, headers=h, json={"publish": True})
    assert resp.json()["publish"] is True
    resp = await client.post(START, headers=h, json={"mode": "publish"})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["cloudflare", "npm"]})
    await configure(db)
    resp = await client.post(START, headers=h, json={"mode": "publish", "git_ref": "main"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "git_ref_not_allowed")
    resp = await client.post(START, headers=h, json={"mode": "publish"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["sha"], body["start_step"], body["publish"]) == (
        "publish", OLD, 12, False)
    assert [s["key"] for s in body["steps"]] == PUBLISHED
    await _finish(body)
    assert fake_runner.requests == [] and fake_publisher.calls == PUBLISHED
    assert (await _audits(db, "deploy.deployment_start"))[-1] == {
        "environment": "uat", "mode": "publish", "git_ref": "main", "sha": OLD}


async def test_publish_needs_a_deployed_environment(client, db, ready, no_leaks):
    await configure(db)
    fresh = await make_environment(db, name="qa")
    await _publish_on(db, fresh)
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/environments/qa/deployments", headers=h,
                             json={"mode": "publish"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_deployed")


async def test_a_publishing_update_and_its_retry(client, db, ready, fake_runner,
                                                 fake_publisher, no_leaks):
    await _publish_on(db, ready)
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (
        409, "integration_not_configured")
    await configure(db)
    fake_publisher.fail["proxy"] = "busy"
    resp = await client.post(START, headers=h, json={})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["publish"] is True
    assert [s["key"] for s in body["steps"]] == [*UPDATE_KEYS, *PUBLISHED]
    await _finish(body)
    assert (await _audits(db, "deploy.deployment_start"))[-1]["publish"] is True
    fake_publisher.fail.clear()
    resp = await client.post(f"/api/deploy/deployments/{body['id']}/retry", headers=h, json={})
    assert resp.status_code == 201, resp.text
    retry = resp.json()
    assert (retry["start_step"], retry["publish"]) == (13, True)
    await _finish(retry)
    got = (await client.get(f"/api/deploy/deployments/{retry['id']}", headers=h)).json()
    assert got["status"] == "succeeded"


async def test_delete_environment(client, db, ready, fake_runner, fake_publisher, no_leaks):
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={"mode": "teardown"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "confirm_name_mismatch")
    resp = await client.post(START, headers=h, json={"mode": "teardown", "confirm_name": "uat",
                                                     "git_ref": "main"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "git_ref_not_allowed")
    await managed(db, ready, "api", "dns_record", "rec-1")
    resp = await client.post(START, headers=h, json={"mode": "teardown", "confirm_name": "uat"})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["cloudflare"]})
    await configure(db)
    fake_runner.gates["teardown"] = asyncio.Event()
    resp = await client.post(START, headers=h, json={"mode": "teardown", "confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["start_step"], body["sha"]) == ("teardown", 15, "")
    assert [s["key"] for s in body["steps"]] == ["teardown", "unproxy", "undns"]
    await asyncio.wait_for(fake_runner.started["teardown"].wait(), 5)
    assert (await client.get(ENV_URL, headers=h)).json()["status"] == "deleting"
    fake_runner.gates["teardown"].set()
    await _finish(body)
    assert (await client.get(ENV_URL, headers=h)).status_code == 404
    resp = await client.get(f"/api/deploy/deployments/{body['id']}", headers=h)
    assert resp.status_code == 404
    assert (await _audits(db, "deploy.environment_delete")) == [
        {"environment": "uat", "deployment": body["id"]}]


async def test_a_failed_delete_is_retried_with_the_typed_name(client, db, ready, fake_runner,
                                                             fake_publisher, no_leaks):
    fake_runner.results["teardown"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    body = (await client.post(START, headers=h,
                              json={"mode": "teardown", "confirm_name": "uat"})).json()
    await _finish(body)
    assert (await client.get(ENV_URL, headers=h)).json()["status"] == "failed"
    url = f"/api/deploy/deployments/{body['id']}/retry"
    resp = await client.post(url, headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "confirm_name_mismatch")
    del fake_runner.results["teardown"]
    resp = await client.post(url, headers=h, json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    await _finish(resp.json())
    assert (await client.get(ENV_URL, headers=h)).status_code == 404


def test_the_dashboard_shows_a_deleting_environment_as_deploying():
    env = Environment(name="uat", status="deleting", current_sha=OLD)
    assert _env_state(env) == "deploying"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_publish_api.py tests/test_deploy_environments_api.py`
Expected: FAIL — e.g. `test_publish_job` gets 422 (mode `publish` isn't accepted) and `ENV_KEYS` misses `publish`.

- [ ] **Step 3: Environments: create, adopt and PATCH know `publish`**

In `sirdar/api/src/sirdar_api/deploy/environments.py`, replace:

```python
                  image_tag: str | None, secrets: dict[str, str],
                  actor_id, seed_snapshot_id: uuid.UUID | None = None) -> Environment:
    env = Environment(name=name, type=type_, target_id=target_id, base_domain=domain,
                      git_ref=git_ref, current_sha=current_sha, image_tag=image_tag,
                      status=status, proxy_ip=proxy_ip, bind_ip=bind_ip,
                      keep_dumps=keep_dumps, spaces_bucket=spaces_bucket,
                      log_level=log_level, created_by=actor_id,
                      seed_snapshot_id=seed_snapshot_id)
```

with:

```python
                  image_tag: str | None, secrets: dict[str, str],
                  actor_id, seed_snapshot_id: uuid.UUID | None = None,
                  publish: bool = False) -> Environment:
    env = Environment(name=name, type=type_, target_id=target_id, base_domain=domain,
                      git_ref=git_ref, current_sha=current_sha, image_tag=image_tag,
                      status=status, proxy_ip=proxy_ip, bind_ip=bind_ip,
                      keep_dumps=keep_dumps, spaces_bucket=spaces_bucket,
                      log_level=log_level, created_by=actor_id,
                      seed_snapshot_id=seed_snapshot_id, publish=publish)
```

Replace:

```python
                     ports: dict[str, int] | None = None, actor_id=None,
                     snapshot_id: uuid.UUID | None = None) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets. With a
    snapshot, its first deploy restores that snapshot (and its keys)."""
```

with:

```python
                     ports: dict[str, int] | None = None, actor_id=None,
                     snapshot_id: uuid.UUID | None = None,
                     publish: bool = True) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets. With a
    snapshot, its first deploy restores that snapshot (and its keys). With
    publish (the default), its deploys add DNS, proxy and smoke steps."""
```

Replace:

```python
        secrets=vault.generate_env_secrets(), actor_id=actor_id, seed_snapshot_id=snapshot_id)
```

with:

```python
        secrets=vault.generate_env_secrets(), actor_id=actor_id, seed_snapshot_id=snapshot_id,
        publish=publish)
```

In `update`, replace:

```python
    if fields.get("log_level") is not None:
        put("log_level", _check_log_level(fields["log_level"]))
```

with:

```python
    if fields.get("log_level") is not None:
        put("log_level", _check_log_level(fields["log_level"]))
    if fields.get("publish") is not None:
        put("publish", bool(fields["publish"]))
```

(Adopt keeps the column default, false: a hand-built environment's DNS and proxy were made by hand.)

- [ ] **Step 4: Serializers and the dashboard**

In `sirdar/api/src/sirdar_api/deploy/serialize.py`, replace:

```python
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, User
```

with:

```python
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, ManagedRecord, User
```

Replace:

```python
            "restore_dump": dep.restore_dump, "rollback_available": rollback_available(dep),
```

with:

```python
            "restore_dump": dep.restore_dump, "rollback_available": rollback_available(dep),
            "publish": dep.publish,
```

Replace:

```python
async def environment_out(db: AsyncSession, env: Environment) -> dict:
```

with:

```python
async def managed_records_out(db: AsyncSession, env_id) -> list[dict]:
    """What Sirdar manages for the environment in Cloudflare and NPM (names
    and origins only)."""
    rows = await db.scalars(select(ManagedRecord).where(ManagedRecord.environment_id == env_id)
                            .order_by(ManagedRecord.service, ManagedRecord.kind))
    return [{"service": r.service, "kind": r.kind, "name": r.name, "origin": r.origin}
            for r in rows]


async def environment_out(db: AsyncSession, env: Environment) -> dict:
```

and replace:

```python
        "seed_snapshot": await snapshots.snapshot_ref(db, env.seed_snapshot_id),
        "last_deployment": await deployment_summary(db, last) if last else None,
```

with:

```python
        "seed_snapshot": await snapshots.snapshot_ref(db, env.seed_snapshot_id),
        "publish": env.publish,
        "managed_records": await managed_records_out(db, env.id),
        "last_deployment": await deployment_summary(db, last) if last else None,
```

In `sirdar/api/src/sirdar_api/dashboard/service.py`, replace:

```python
def _env_state(env: Environment) -> str:
    if env.status in ("deploying", "failed"):
        return env.status
```

with:

```python
def _env_state(env: Environment) -> str:
    if env.status in ("deploying", "failed"):
        return env.status
    if env.status == "deleting":
        return "deploying"
```

- [ ] **Step 5: Routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

Replace:

```python
    names,
    pipeline,
    serialize,
```

with:

```python
    names,
    pipeline,
    publish,
    serialize,
```

In `EnvironmentIn`, replace:

```python
    # mode "new" only: the first deploy restores this snapshot
    snapshot_id: uuid.UUID | None = None
```

with:

```python
    # mode "new" only: the first deploy restores this snapshot
    snapshot_id: uuid.UUID | None = None
    # mode "new" only (default on): deploys publish DNS records and proxy hosts
    publish: bool | None = None
```

In `EnvironmentPatch`, replace:

```python
    services: dict[str, ServicePatch] | None = None
```

with:

```python
    services: dict[str, ServicePatch] | None = None
    publish: bool | None = None
```

In `create_environment`, replace:

```python
    if body.mode == "adopt" and body.snapshot_id is not None:
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
```

with:

```python
    if body.mode == "adopt" and body.snapshot_id is not None:
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if body.mode == "adopt" and body.publish:
        # A hand-built environment's DNS and proxy were made by hand: turn
        # Publish on after claiming them on the Publish tab.
        raise HTTPException(status_code=422, detail={"code": "publish_not_allowed"})
```

replace:

```python
                bind_ip=body.bind_ip, ports=body.ports, actor_id=actor_id,
                snapshot_id=body.snapshot_id)
```

with:

```python
                bind_ip=body.bind_ip, ports=body.ports, actor_id=actor_id,
                snapshot_id=body.snapshot_id, publish=body.publish is not False)
```

and replace:

```python
                   "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip}
        seed = await snapshots.snapshot_ref(db, env.seed_snapshot_id)
```

with:

```python
                   "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip, "publish": env.publish}
        seed = await snapshots.snapshot_ref(db, env.seed_snapshot_id)
```

Replace:

```python
class DeploymentIn(BaseModel):
    mode: Literal["update", "reset", "restore_dump"] = "update"
```

with:

```python
class DeploymentIn(BaseModel):
    # publish: steps 12–14 for the running commit; teardown: Delete environment
    mode: Literal["update", "reset", "restore_dump", "publish", "teardown"] = "update"
```

Replace:

```python
GATED_MODES = ("reset", "restore_dump", "rollback")
RETRY_MODES = ("update", "reset", "restore_dump", "rollback")
```

with:

```python
GATED_MODES = ("reset", "restore_dump", "rollback", "teardown")
RETRY_MODES = ("update", "reset", "restore_dump", "rollback", "publish", "teardown")
```

Replace the `_launch` signature and its create call:

```python
async def _launch(db, env: Environment, request: Request, actor: AuthContext, *, action: str,
                  mode: str, git_ref: str, sha: str, start_step: int = 1,
                  retry_of: uuid.UUID | None = None, snapshot: Snapshot | None = None,
                  restore_dump: str | None = None) -> dict:
    env_name = env.name           # read now: a lock conflict rolls the session back
    snapshot_id = snapshot.id if snapshot is not None else None
    snapshot_name = snapshot.name if snapshot is not None else None
    try:
        dep = await pipeline.create_deployment(db, env, mode=mode, git_ref=git_ref, sha=sha,
                                               actor_id=actor.user.person_id,
                                               start_step=start_step, retry_of=retry_of,
                                               snapshot_id=snapshot_id,
                                               restore_dump=restore_dump)
```

with:

```python
async def _launch(db, env: Environment, request: Request, actor: AuthContext, *, action: str,
                  mode: str, git_ref: str, sha: str, start_step: int | None = None,
                  retry_of: uuid.UUID | None = None, snapshot: Snapshot | None = None,
                  restore_dump: str | None = None, publish: bool = False) -> dict:
    env_name = env.name           # read now: a lock conflict rolls the session back
    snapshot_id = snapshot.id if snapshot is not None else None
    snapshot_name = snapshot.name if snapshot is not None else None
    try:
        dep = await pipeline.create_deployment(db, env, mode=mode, git_ref=git_ref, sha=sha,
                                               actor_id=actor.user.person_id,
                                               start_step=start_step, retry_of=retry_of,
                                               snapshot_id=snapshot_id,
                                               restore_dump=restore_dump, publish=publish)
```

and, in `_launch`, replace:

```python
    if restore_dump is not None:
        changes["backup"] = restore_dump
```

with:

```python
    if restore_dump is not None:
        changes["backup"] = restore_dump
    if publish:
        changes["publish"] = True
```

Replace:

```python
async def _pinned(db, cfg: SshTargetConfig) -> None:
    try:
        await ssh.pinned_host_key(db, cfg.host, cfg.port)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None
```

with:

```python
async def _pinned(db, cfg: SshTargetConfig) -> None:
    try:
        await ssh.pinned_host_key(db, cfg.host, cfg.port)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None


async def _require_integrations(db, env: Environment, *, teardown: bool = False) -> None:
    """Refuse up front (not after a 30-minute build) when publishing, or
    removing what Sirdar made, needs an integration that isn't set up."""
    missing = await publish.missing_integrations(db, env, teardown=teardown)
    if missing:
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": missing})


async def _start_publish(db, env: Environment, request: Request, actor: AuthContext) -> dict:
    """A publish job: steps 12–14 for the running commit. No SSH."""
    if not env.publish:
        raise HTTPException(status_code=409, detail={"code": "publish_off"})
    if env.current_sha is None:
        raise HTTPException(status_code=409, detail={"code": "not_deployed"})
    if not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="publish", git_ref=env.git_ref, sha=env.current_sha)
```

Replace the body of `start_deployment` from:

```python
    if body.mode == "restore_dump":
        if not environments.valid_backup_name(body.backup):
            raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
        if body.git_ref is not None:        # it deploys the running commit
            raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    cfg = _deploy_target(env)
    if body.mode == "restore_dump":
```

to:

```python
    if body.mode == "restore_dump":
        if not environments.valid_backup_name(body.backup):
            raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
        if body.git_ref is not None:        # it deploys the running commit
            raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if body.mode in ("publish", "teardown") and body.git_ref is not None:
        raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    if body.mode == "publish":
        return await _start_publish(db, env, request, actor)
    cfg = _deploy_target(env)
    if body.mode == "teardown":
        await _require_integrations(db, env, teardown=True)
        await _pinned(db, cfg)
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="teardown", git_ref=env.git_ref, sha=env.current_sha or "")
    if env.publish:
        await _require_integrations(db, env)
    if body.mode == "restore_dump":
```

In the same function, replace:

```python
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="restore_dump", git_ref=env.current_sha,
                             sha=env.current_sha, restore_dump=body.backup)
```

with:

```python
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="restore_dump", git_ref=env.current_sha,
                             sha=env.current_sha, restore_dump=body.backup,
                             publish=env.publish)
```

and replace:

```python
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode=body.mode, git_ref=ref, sha=sha, snapshot=snapshot)
```

with:

```python
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode=body.mode, git_ref=ref, sha=sha, snapshot=snapshot,
                         publish=env.publish)
```

In `retry_deployment`, replace:

```python
    plan = plan_for(dep.mode, restore=restoring)
```

with:

```python
    plan = plan_for(dep.mode, restore=restoring, publish=dep.publish)
```

and replace:

```python
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    return await _launch(db, env, request, actor, action="deploy.deployment_retry",
                         mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump)
```

with:

```python
    if dep.mode == "publish":
        if not vault.is_configured(get_settings()):
            raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    else:
        cfg = _deploy_target(env)
        await _pinned(db, cfg)
    if dep.mode == "teardown":
        await _require_integrations(db, env, teardown=True)
    elif dep.mode == "publish" or dep.publish:
        await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_retry",
                         mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump, publish=dep.publish)
```

In `rollback_deployment`, replace:

```python
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    return await _launch(db, env, request, actor, action="deploy.deployment_rollback",
                         mode="rollback", git_ref=dep.previous_sha, sha=dep.previous_sha,
                         restore_dump=dump)
```

with:

```python
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    if env.publish:
        await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_rollback",
                         mode="rollback", git_ref=dep.previous_sha, sha=dep.previous_sha,
                         restore_dump=dump, publish=env.publish)
```

Replace:

```python
# ---- snapshots -------------------------------------------------------------------
```

with:

```python
# ---- publishing (the Publish tab) -----------------------------------------------

@router.get("/environments/{name}/publish")
async def publish_state(name: str, db: DbSession,
                        actor: AuthContext = require_permission("deploy", "view")):
    """What publishing would do now, per public service (reads Cloudflare and
    Nginx Proxy Manager, changes nothing)."""
    env = await _environment(db, name)
    return await publish.inspect(db, env, get_settings())


@router.post("/environments/{name}/publish/claim")
async def publish_claim(name: str, request: Request, db: DbSession,
                        actor: AuthContext = require_permission("deploy", "change")):
    """Take every hand-made DNS record and proxy host at this environment's
    names under Sirdar's care: kept up to date, never deleted. Writes only
    Sirdar's database."""
    env = await _environment(db, name)
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    settings = get_settings()
    state = await publish.inspect(db, env, settings)
    try:
        claimed = await publish.claim(db, env, state)
    except IntegrityError:
        # another environment, or a concurrent claim, took one first
        await db.rollback()
        raise HTTPException(status_code=409, detail={"code": "claim_conflict"}) from None
    if not claimed:
        raise HTTPException(status_code=409, detail={"code": "nothing_to_claim"})
    audit(db, actor_id=actor.user.person_id, action="deploy.publish_claim",
          entity_type="environment", entity_id=env.name, ip=client_ip(request),
          changes={"environment": env.name, "claimed": claimed})
    await db.commit()
    return {**await publish.inspect(db, env, settings), "claimed": claimed}


# ---- snapshots -------------------------------------------------------------------
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q tests/test_deploy_publish_api.py tests/test_deploy_environments_api.py tests/test_deploy_deployments_api.py tests/test_deploy_restore_api.py tests/test_deploy_snapshots_api.py tests/test_dashboard_api.py`
Expected: PASS. If an older test compares a whole deployment or environment body, add `publish` / `managed_records` to its expected keys — never drop them from the serializer.

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/api/routes/deploy.py src/sirdar_api/deploy/environments.py \
  src/sirdar_api/deploy/serialize.py src/sirdar_api/dashboard/service.py \
  tests/test_deploy_publish_api.py tests/test_deploy_environments_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/api/routes/deploy.py \
  sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/serialize.py \
  sirdar/api/src/sirdar_api/dashboard/service.py sirdar/api/tests/test_deploy_publish_api.py \
  sirdar/api/tests/test_deploy_environments_api.py
git commit -m "feat(sirdar): Publish tab, publish and teardown deployments, publish switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: Docs, the full suites, lint

**Files:**
- Modify: `sirdar/README.md`
- Modify: `deploy/stack/README.md`

- [ ] **Step 1: Document publishing in the Sirdar README**

In `sirdar/README.md`, replace:

```markdown
10 Start services (migrate, then the app) · 11 Take snapshot (a job of its
own). The first failure stops the deployment; retry re-runs from the failed
step. One deployment per environment at a time. Reset, Restore backup and
Roll back replace data: they need `deploy:change` and the environment's name
typed back (`confirm_name`).
```

with:

```markdown
10 Start services (migrate, then the app) · 11 Take snapshot (a job of its
own) · 12 DNS records · 13 Proxy hosts · 14 Smoke test (when the environment
publishes) · 15 Remove environment · 16 Remove proxy hosts · 17 Remove DNS
records (Delete environment). The first failure stops the deployment; retry
re-runs from the failed step. One deployment per environment at a time.
Reset, Restore backup, Roll back and Delete environment replace or remove
data: they need `deploy:change` and the environment's name typed back
(`confirm_name`).

**Publishing (DNS + proxy).** With an environment's **Publish** switch on
(the default for new environments; off for adopted ones and for every
environment that existed before migration 0006), each deploy ends with
steps 12–14: a Cloudflare A record per public service
(`<service>.<base domain>` → the public IP set in Settings, DNS only unless
the service's `proxied` flag is on), an Nginx Proxy Manager proxy host per
service (http to the service's host and port, WebSockets, Block common
exploits, HTTP/2, Force SSL, a Let's Encrypt certificate by HTTP challenge,
reused while it has more than 30 days left), and a smoke test that asks every
public URL through NPM's LAN IP (`proxy_ip`) with the public name as SNI and
Host. A **publish** deployment runs only those three. Credentials live in
Settings › Integrations (Cloudflare API token with DNS edit on the zone; NPM
URL, login and password), encrypted with `SIRDAR_SECRETS_KEY` and never
shown again; each has a Test button.

Sirdar changes only what it records in `managed_records`: entries it
**created**, and hand-made ones someone **claimed** on the environment's
Publish tab. Any other record or proxy host at a wanted name — or a wildcard
such as `*.dev.serversherpa.com` that a new record would override — stops
the step before anything changes. Claimed entries are kept up to date but
never deleted. **Delete environment** stops the stacks, deletes the
volumes and `/opt/serversherpa/<env>` (backups included), removes the proxy
hosts, certificates and DNS records Sirdar created, forgets the claimed
ones, and then removes the environment from Sirdar. Docker images stay on the
host.
```

Replace:

```markdown
| `DELETE /snapshots/{id}` | `deploy:change` |
```

with:

```markdown
| `DELETE /snapshots/{id}` | `deploy:change` |
| `GET /integrations` | `deploy:view` |
| `PUT /integrations/cloudflare`, `PUT /integrations/npm`, `DELETE /integrations/{kind}`, `POST /integrations/{kind}/test` | `deploy:change` |
| `GET /environments/{name}/publish` | `deploy:view` |
| `POST /environments/{name}/publish/claim` | `deploy:change` |
| `POST /environments/{name}/deployments` (`mode`: `publish`) | `deploy:add` |
| `POST /environments/{name}/deployments` (`mode`: `teardown`, with `confirm_name`) | `deploy:change` |
```

- [ ] **Step 2: Point the manual steps at Sirdar**

In `deploy/stack/README.md`, replace:

```markdown
6. **Nginx Proxy Manager** — one proxy host per name, scheme `http`,
```

with:

```markdown
   Sirdar does steps 5 and 6 itself for an environment with Publish on
   (Settings › Integrations needs the Cloudflare token and NPM login); the
   hand steps below are for environments it doesn't manage.

6. **Nginx Proxy Manager** — one proxy host per name, scheme `http`,
```

- [ ] **Step 3: Run every suite**

Run:

```bash
cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase4a .venv/bin/pytest -q
cd ../.. && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests
```

Expected: both pass (opt-in e2e tests skip). The Sirdar suite takes a few minutes; run it in the foreground.

- [ ] **Step 4: Lint everything this plan touched**

Run:

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/integrations.py src/sirdar_api/deploy/cloudflare.py \
  src/sirdar_api/deploy/npm.py src/sirdar_api/deploy/smoke.py src/sirdar_api/deploy/outbound.py \
  src/sirdar_api/deploy/publish.py src/sirdar_api/deploy/steps.py \
  src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/environments.py \
  src/sirdar_api/deploy/serialize.py src/sirdar_api/api/routes/deploy.py \
  src/sirdar_api/api/routes/integrations.py src/sirdar_api/api/app.py \
  src/sirdar_api/dashboard/service.py src/sirdar_api/db/models.py \
  migrations/versions/0006_publish.py tests/conftest.py tests/deploy_factories.py \
  tests/integration_helpers.py tests/fake_cloudflare.py tests/fake_npm.py tests/fake_smoke.py \
  tests/fake_publisher.py tests/publish_helpers.py tests/test_deploy_models.py \
  tests/test_deploy_integrations.py tests/test_deploy_cloudflare.py tests/test_deploy_npm.py \
  tests/test_deploy_integrations_api.py tests/test_deploy_smoke.py tests/test_deploy_publish.py \
  tests/test_deploy_publish_steps.py tests/test_deploy_playbooks.py \
  tests/test_deploy_pipeline_publish.py tests/test_deploy_publish_api.py \
  tests/test_deploy_environments_api.py
```

Expected: `All checks passed!`

- [ ] **Step 5: Secrets never leak (one last grep)**

Run: `cd sirdar/api && grep -rn "token\|password" src/sirdar_api/deploy/cloudflare.py src/sirdar_api/deploy/npm.py src/sirdar_api/deploy/publish.py | grep -n "log\.\|out(\|reason\|detail" || echo "no secret reaches a log, an output line or a reason"`
Expected: the echo line (no match), or only lines that name a field ("API token", "password") without its value.

- [ ] **Step 6: Drop the test database and commit**

```bash
docker exec $(docker ps -qf name=sirdar-db) psql -U sirdar -d postgres \
  -c 'DROP DATABASE IF EXISTS sirdar_test_phase4a' -c 'DROP DATABASE IF EXISTS sirdar_test_phase4a_source'
git add sirdar/README.md deploy/stack/README.md
git commit -m "docs(sirdar): publishing, integrations and Delete environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Plan 4b (`docs/superpowers/plans/2026-10-04-sirdar-phase4b-ui.md`) builds the UI on these endpoints and ends with the live verify.
