# Sirdar deploy phase 7a (DigitalOcean environments: backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Sirdar build complete ServerSherpa environments on DigitalOcean, in one of two DigitalOcean accounts:

- a VPC, one droplet per slot running the whole app stack behind Caddy, a managed PostgreSQL 16 cluster locked to the environment's droplets, a Spaces bucket with a bucket-scoped key, a load balancer with a Let's Encrypt certificate, a cloud firewall, and Cloudflare DNS at the load balancer;
- step 0 "Prepare DigitalOcean", idempotent, recorded and tagged;
- seeding from a snapshot onto the managed database and bucket;
- Delete: snapshot first, then remove only what Sirdar recorded.

**Architecture:**

- `deploy/do_api.py` is the DigitalOcean API v2 client behind `do_api.connect(token)`; tests answer through `FakeDigitalOcean` (an httpx MockTransport handed out by `outbound.transports()`).
- `deploy/do_accounts.py` holds the two accounts (`do_accounts` table); `integrations`' `digitalocean` kind becomes a facade over the Production account.
- `deploy/s3sig.py` + `deploy/spaces.py` make and remove buckets through the S3 API; `deploy/acme.py` (RFC 8555, shared byte-for-byte with the api's cert-worker in 7b) + `deploy/certs.py` issue certificates by DNS-01 through Cloudflare.
- `deploy/do_envs.py` is the record (`do_environments`, `do_slots`, `do_resources`): create, slots, SSH config, `.env` extras.
- `deploy/do_provision.py` runs the new `"vm"` steps 0 `do_prepare`, 14 `go_live` and 18 `do_destroy`; `vmsteps` dispatches to it.
- `deploy/stack` gains an external-data mode and a Caddy `proxy` stack; the playbooks gain the external branches and a slot smoke test.

**Tech Stack:** FastAPI, SQLAlchemy 2 async + asyncpg, Alembic (raw SQL), httpx, asyncssh, `cryptography`, PyYAML, Ansible, Docker Compose, Caddy 2, pytest on real Postgres.

**Spec:** `docs/superpowers/specs/2026-10-05-sirdar-digitalocean-environments-design.md`. The binding decisions are in `docs/superpowers/plans/2026-10-05-sirdar-phase7-context.md`. Read both first. 7b (`2026-10-05-sirdar-phase7b-ui.md`) builds on the shapes under "API produced for 7b".

## Global Constraints

**Where and how to work**

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it.
- `sirdar` is both a branch and a folder: use `--` in `git diff` and `git log` (`git log -- sirdar/`).
- Other agents may commit in this worktree at the same time:
  - `git add` only the files your task names. Never `git add -A`, never `git stash`.
  - If `.git/index.lock` is busy, wait a few seconds and retry.
  - If a file this plan edits has changed since it was written, apply the same edit to the new text and keep their change.
- Commit messages end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Code style and lint**

- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"` (never add `@pytest.mark.asyncio`).
- New and changed Python files must pass `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` (from `sirdar/api`) and print `All checks passed!`.
- Shell: `bash -n deploy/stack/ss-stack` must pass; run `shellcheck deploy/stack/ss-stack` if it is installed.

**Migration number**

- The migration is **0010** (`revision = "0010"`, `down_revision = "0009"`). Task 1 checks every worktree and the dev DB before writing it.

**Secrets and errors**

- These never appear in an API response, a log line, an audit `changes`, an exception message, a `repr()`, a stored step log, or the argv or environment of any process: the account tokens, the renewal tokens, the `doadmin` password, the app's database password (`POSTGRES_PASSWORD`), the Spaces secrets, Sirdar's and the environments' ACME account keys, certificate private keys, the generated private host keys, the environment's private SSH key.
- The `doadmin` password and the SQL holding the SCRAM verifier reach the droplet only on the SSH session's stdin.
- Errors are our own copy. Never use DigitalOcean's, Let's Encrypt's or httpx's text. A DigitalOcean error `id` matching `[a-z_]{1,40}` may be named.

**Tests never touch real hosts**

- Every DigitalOcean, Spaces and ACME call goes through an httpx client whose transport comes from `outbound.transports()` (kinds `digitalocean`, `spaces`, `acme`). Tests replace them with `FakeDigitalOcean`, `FakeSpaces` and `FakeAcme`. The autouse `no_real_http` guard stays as it is.
- The tests' own SSH server (`tests/ssh_server.py`) plays every droplet at 127.0.0.1.

**Ownership**

- Sirdar changes or deletes only DigitalOcean resources it recorded in `do_resources` **and** that still match: tagged `sirdar-env-<environment id>` where DigitalOcean tags the kind (droplets, databases), otherwise the exact recorded name (and, for the VPC, `sirdar:<environment id>` in its description).
- A recorded resource that no longer matches stops the step with our copy and changes nothing; one that is gone is forgotten.

**API conventions**

- Errors: `HTTPException(status, detail={"code": "snake_code", ...})`.
- Permissions reuse `deploy`: `view` (read), `add` (create, Update, Take snapshot), `change` (accounts, `retiring`, Delete).
- Gated modes need `confirm_name`. Every successful mutation writes one audit row named `deploy.<verb>`.

**Copy and housekeeping**

- American English in all copy, comments and docs.
- Never commit `sirdar/.env`. No `npm install` in this worktree.

## Working environment

- Sirdar's dev database must be running. From the main checkout: `cd /Users/jrh1812/Developer/BaseCampV3 && docker compose -f docker-compose.dev.yml up -d sirdar-db` (Postgres on 127.0.0.1:5434).
- Every Sirdar test command runs from `sirdar/api` in the worktree:
  1. `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api`
  2. `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/<file>`
- The conftest creates that database; Task 13 drops it. Never point tests at the dev `sirdar` database. Run test files in the foreground. Implementers run the focused files their task names; the controller runs the whole suite (about 11 minutes) in Task 13.
- Docker-dependent tests (`docker compose config`, the Caddy container run) skip when `docker` isn't on `PATH`; the Caddy run also needs `SS_STACK_E2E=1`.

## API produced for 7b

All under `/api/deploy`. Times are ISO 8601 strings.

**DigitalOcean accounts**

- `GET /integrations/digitalocean/accounts` (view) → `{accounts: DoAccount[]}`, always both, Production first:

  ```
  DoAccount = {key: "production"|"development", label, region: str|null,
               configured, token_set, source: "stored"|"environment"|null,
               renewal_token_set, team_name: str|null, environments: string[],
               updated_at, updated_by_name}
  ```

- `PUT /integrations/digitalocean/accounts/{key}` (change). Body `{label, region, token?, renewal_token?, clear_renewal_token?: bool}` → `{accounts}`. Omitted secrets keep the stored ones. Errors: 422 `do_account_invalid | label_invalid | region_invalid | do_token_invalid | renewal_token_invalid | secret_required`; 409 `do_token_shared`, `do_team_changed {environments}`; 400 `secrets_key_missing`; 502 `connect_failed {reason}` (only when the team check runs).
- `POST /integrations/digitalocean/accounts/{key}/test` (change). Optional body = the PUT body. → `{ok, target: "digitalocean", checks, facts: {email, team_name, region, …}}`. Check labels, in order: Account, Team, Droplets, Region, Renewal token. Errors as the PUT's, plus 409 `do_account_not_configured {account}`.
- `DELETE /integrations/digitalocean/accounts/{key}` (change) → 204: clears both tokens (label and region stay). 409 `account_in_use {environments}`.
- Unchanged (an alias for the Production account; the web stops using it in 7b): `PUT /integrations/digitalocean`, `POST /integrations/digitalocean/test`, `DELETE /integrations/digitalocean`, `Integrations.digitalocean`.

**Environments**

- `EnvType` adds `"production"` (DigitalOcean only). `target_kind` adds `"digitalocean"`.
- `POST /environments` with `target: "digitalocean"` takes `do`:

  ```
  {account: "production"|"development", slots?: 1|2, droplet_size?, db_size?,
   db_standby?: bool, acme_staging?: bool}
  ```

  Production: `slots` is 2 (blue, green), `acme_staging` false. Errors: 409 `do_account_not_configured {account}`, 409 `integration_not_configured {kinds: ["cloudflare"]}`, 409 `production_exists`, 422 `do_invalid | do_slots_invalid | do_size_invalid | do_db_size_invalid | production_requires_digitalocean | base_domain_not_in_zone | do_not_allowed`.
- `Environment` adds `slots: string[]`, `active_slot: string|null`, `auto_activate: bool`, `retiring: bool` and `do: EnvDo|null`:

  ```
  EnvDo = {account, account_label, region, droplet_size, db_size, db_standby, acme_staging,
           vpc_ip_range: str|null, lb_ip: str|null, db_host: str|null, bucket: str|null,
           cert_not_after: str|null,
           slots: [{slot, droplet_id: str|null, public_ip, private_ip, sha, image_tag,
                    active: bool, last_check_ok: bool|null, last_check_at}],
           resources: [{kind, name, slot}]}
  ```

- `PATCH /environments/{name}` adds `retiring?: bool` (production only, `deploy:change`, needs `confirm_name`; 422 `retiring_not_allowed` otherwise). On DigitalOcean it refuses `target`, `proxy_ip`, `bind_ip`, `base_domain`, `spaces_bucket` and `publish` (422 `do_field_locked {field}`) and service `host_ip` (422 `host_ip_managed`).
- `GET /environment-defaults` adds `do: {droplet_size: "s-2vcpu-4gb", db_size: "db-s-2vcpu-4gb", db_standby: false, production_slots: ["blue","green"], one_slot: ["orange"], two_slots: ["orange","purple"]}`.
- `GET /targets` lists `digitalocean` as today.

**Deployments**

- On DigitalOcean, `POST /environments/{name}/deployments` accepts `update`, `publish` and `teardown`; `reset`, `restore_dump` and `POST /deployments/{id}/rollback` answer 409 `not_supported_on_digitalocean`.
- `DeploymentSummary` adds `cloud: bool`, `slot: str|null`, `go_live: bool`.
- `teardown` on DigitalOcean takes `snapshot?: bool` (default true; production can't turn it off, 422 `snapshot_required`) and, for production, `confirm_production: "delete production <name>"`. Production also needs `retiring` (409 `production_not_retiring`) and no active slot (409 `production_slot_active`).
- Steps: 0 `do_prepare` "Prepare DigitalOcean", 13 `slot_smoke` "Smoke test (slot)", 14 `go_live` "Switch traffic", 18 `do_destroy` "Remove DigitalOcean resources". The `activate` and `renew` deployment modes exist in the schema (0010) and are used by 7b.

## File map

| File | Change |
|---|---|
| `sirdar/api/migrations/versions/0010_digitalocean_environments.py` | New: `do_accounts`, `do_environments`, `do_slots`, `do_resources`, `acme_accounts`; environment and deployment columns; `production` type; `activate` mode; moves the DigitalOcean token |
| `sirdar/api/src/sirdar_api/db/models.py` | The new models and columns |
| `sirdar/api/src/sirdar_api/deploy/do_api.py` | New: the DigitalOcean API v2 client |
| `sirdar/api/src/sirdar_api/deploy/do_accounts.py` | New: the two accounts |
| `sirdar/api/src/sirdar_api/deploy/integrations.py` | `digitalocean` becomes a facade over the Production account |
| `sirdar/api/src/sirdar_api/deploy/digitalocean.py` | `resolve(db, settings, account=...)` |
| `sirdar/api/src/sirdar_api/deploy/outbound.py` | Kinds `spaces`, `acme` |
| `sirdar/api/src/sirdar_api/deploy/s3sig.py`, `spaces.py` | New: SigV4 and buckets |
| `sirdar/api/src/sirdar_api/deploy/acme.py`, `certs.py`, `pgauth.py` | New: ACME, certificates, SCRAM verifiers |
| `sirdar/api/src/sirdar_api/deploy/cloudflare.py` | TXT records |
| `sirdar/api/src/sirdar_api/deploy/do_envs.py` | New: DigitalOcean environment records |
| `sirdar/api/src/sirdar_api/deploy/do_provision.py` | New: steps 0, 14, 18 |
| `sirdar/api/src/sirdar_api/deploy/{targets,environments,serialize,envfile,steps,pipeline,vmsteps,vms,publish,smoke,ssh,bundle,cloudinit}.py` | DigitalOcean branches |
| `sirdar/api/src/sirdar_api/deploy/ansible/{bootstrap,export,restore,slot_smoke}.yml` | External data, the metadata block, the slot smoke test |
| `sirdar/api/src/sirdar_api/api/routes/{deploy,integrations}.py` | Accounts, DigitalOcean environments and deployments |
| `sirdar/api/src/sirdar_api/config.py` | `acme_directory`, `acme_staging_directory` |
| `deploy/stack/ss-stack`, `deploy/stack/api/compose.yml`, `deploy/stack/status/compose.yml`, `deploy/stack/env.example`, `deploy/stack/README.md` | External data, the network subnet, nested defaults |
| `deploy/stack/proxy/compose.yml`, `deploy/stack/proxy/Caddyfile` | New: the Caddy edge |
| `sirdar/api/tests/fake_digitalocean.py`, `fake_spaces.py`, `fake_acme.py`, `do_helpers.py` | New fakes and fixtures |
| `sirdar/api/tests/test_deploy_do_*.py`, `test_deploy_stack_external.py` | New tests |
| `sirdar/README.md` | "DigitalOcean environments" |

---

### Task 1: Migration 0010 and the models

**Files:**
- Create: `sirdar/api/migrations/versions/0010_digitalocean_environments.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py`
- Modify: `sirdar/api/tests/conftest.py` (truncate the new tables; reset the two accounts)
- Modify: `sirdar/api/tests/test_deploy_models.py` (head is now 0010; the 0009 round trip; new 0010 tests)

**Interfaces:**
- Consumes: migration 0009 (`integrations.kind` includes `digitalocean`).
- Produces (models, used by every later task):
  - `DoAccount(key, label, region, token_enc, renewal_token_enc, team_uuid, team_name, updated_by, updated_at)`
  - `DoEnvironment(environment_id, account_key, team_uuid, region, droplet_size, droplet_image, db_size, db_standby, acme_staging, ssh_public_key, ssh_private_key_enc, acme_key_enc, vpc_ip_range, lb_ip, db_host, db_port, db_admin_password_enc, db_ca_cert, bucket, spaces_key_id, spaces_secret_enc, cert_not_after, created_at, updated_at)`
  - `DoSlot(environment_id, slot, host_key_public, host_key_private_enc, droplet_id, public_ip, private_ip, sha, image_tag, last_check_ok, last_check_at, created_at, updated_at)`
  - `DoResource(id, environment_id, kind, do_id, name, slot, origin, created_at)`
  - `AcmeAccount(directory, key_enc, kid, created_at)`
  - `Environment.slots: list[str]`, `.active_slot`, `.auto_activate`, `.retiring`; `Deployment.cloud`, `.slot`, `.go_live`.

- [ ] **Step 1: Check the migration number is free**

```bash
cd /Users/jrh1812/Developer/BaseCampV3
for w in $(git worktree list --porcelain | grep '^worktree' | cut -d' ' -f2); do
  ls "$w"/sirdar/api/migrations/versions 2>/dev/null | grep -E '^001[0-9]' | sed "s|^|$w: |"; done
for b in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes); do
  git ls-tree --name-only "$b" sirdar/api/migrations/versions/ 2>/dev/null | grep -E '/001[0-9]' | sed "s|^|$b: |"; done | sort -u
docker exec serversherpa-dev-sirdar-db-1 psql -U sirdar -d sirdar -tAc "select version_num from alembic_version"
```

Expected: no `0010*` file anywhere; the dev DB prints `0004` (or anything up to `0009`). If a `0010` exists, stop and tell the controller.

- [ ] **Step 2: Write the failing tests**

In `sirdar/api/tests/test_deploy_models.py`:

1. In `test_migration_0007_downgrade_refuses_while_vms_are_managed`, change the head check from `"0009"` to `"0010"`.
2. Replace `test_migration_0009_round_trip` with:

```python
async def test_migration_0009_round_trip():
    """Below 0010 the Production account's token is the digitalocean
    integration row; below 0009 it is dropped (SIRDAR_DEPLOY_DO_TOKEN is the
    only source) and the kind is refused. At head the kind is refused too:
    the token lives in do_accounts."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        conn.execute("UPDATE do_accounts SET token_enc = 'enc' WHERE key = 'production'")
        conn.execute("INSERT INTO integrations (kind, config) VALUES ('esxi', '{}')")
    _alembic("downgrade", "0008")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT kind FROM integrations ORDER BY kind").fetchall() == [
                ("esxi",)]
            with pytest.raises(psycopg.errors.CheckViolation):
                conn.execute("INSERT INTO integrations (kind, config) "
                             "VALUES ('digitalocean', '{}')")
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO integrations (kind, config) VALUES ('digitalocean', '{}')")
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO integrations (kind, config) VALUES ('aws', '{}')")
```

3. Append:

```python
async def test_migration_0010_moves_the_token_both_ways():
    """0010 moves the stored DigitalOcean token into the Production account
    (same ciphertext); its downgrade moves it back. The Development account's
    token has nowhere to go below 0010 and is dropped."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT key, label FROM do_accounts ORDER BY key").fetchall() == [
            ("development", "Development"), ("production", "Production")]
        conn.execute("UPDATE do_accounts SET token_enc = 'prod-enc', region = 'nyc3' "
                     "WHERE key = 'production'")
        conn.execute("UPDATE do_accounts SET token_enc = 'dev-enc' WHERE key = 'development'")
    _alembic("downgrade", "0009")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            row = conn.execute("SELECT secret_enc FROM integrations "
                               "WHERE kind = 'digitalocean'").fetchone()
            assert bytes(row[0]) == b"prod-enc"
            assert not conn.execute("SELECT to_regclass('do_accounts') IS NOT NULL").fetchone()[0]
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        rows = dict(conn.execute("SELECT key, token_enc FROM do_accounts").fetchall())
        assert bytes(rows["production"]) == b"prod-enc"
        assert rows["development"] is None
        assert conn.execute("SELECT count(*) FROM integrations WHERE kind = 'digitalocean'"
                            ).fetchone()[0] == 0


async def test_migration_0010_downgrade_refuses_while_do_environments_exist():
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip, slots) "
            "VALUES ('do1', 'dev', 'digitalocean', 'do1.serversherpa.com', '172.30.0.2', "
            "'{orange}') RETURNING id").fetchone()[0]
        conn.execute(
            "INSERT INTO do_environments (environment_id, account_key, region, droplet_size, "
            "db_size, ssh_public_key, ssh_private_key_enc, acme_key_enc, bucket) VALUES "
            "(%s, 'development', 'nyc3', 's-2vcpu-4gb', 'db-s-2vcpu-4gb', 'ssh-ed25519 x', "
            "'k', 'a', 'ss-do1-12345678')", (env_id,))
    with pytest.raises(subprocess.CalledProcessError) as err:
        _alembic("downgrade", "0009")
    assert b"while Sirdar manages DigitalOcean environments" in err.value.stderr
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0010"
        conn.execute("DELETE FROM environments WHERE id = %s", (env_id,))


async def test_do_constraints(db):
    """Production lives only on DigitalOcean and never auto-activates; the
    active slot is one of the slots; slot names are the four colors; a
    DigitalOcean resource is recorded once."""
    from sirdar_api.db.models import DoResource, Environment

    def env(**kw) -> Environment:
        base = dict(name="p1", type="production", target_id="digitalocean",
                    base_domain="p1.serversherpa.com", proxy_ip="172.30.0.2",
                    slots=["blue", "green"])
        return Environment(**{**base, **kw})

    for bad in (env(target_id="ssh"), env(auto_activate=True), env(active_slot="orange")):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    good = env(active_slot="blue")
    db.add(good)
    await db.commit()
    db.add(DoResource(environment_id=good.id, kind="droplet", do_id="1", name="ss-p1-blue",
                      slot="blue"))
    await db.commit()
    db.add(DoResource(environment_id=good.id, kind="droplet", do_id="1", name="ss-p1-blue",
                      slot="blue"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    db.add(DoResource(environment_id=good.id, kind="kettle", do_id="2", name="x"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
```

- [ ] **Step 3: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_models.py -k "0009 or 0010 or do_constraints or 0007"`
Expected: FAIL (`do_accounts` doesn't exist; `DoResource` can't be imported).

- [ ] **Step 4: Write the migration**

Create `sirdar/api/migrations/versions/0010_digitalocean_environments.py`:

```python
"""DigitalOcean environments (deploy phase 7): the two DigitalOcean
accounts (the token stored in 0009 becomes the Production account's), the
DigitalOcean record of an environment (do_environments), its slots
(do_slots) and the ownership record of every resource Sirdar made there
(do_resources), Sirdar's ACME account keys, Blue/Green fields on
environments, DigitalOcean fields on deployments, the production type and
the activate and renew modes (used by phase 7b).

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-05
"""
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

_MODES_9 = ("'update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish', "
            "'teardown', 'vm_restore'")


def upgrade() -> None:
    op.execute(f"""
        CREATE TABLE do_accounts (
          key text PRIMARY KEY CHECK (key IN ('production', 'development')),
          label text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
          region text CHECK (region ~ '^[a-z]{{3}}[0-9]$'),
          token_enc bytea,
          renewal_token_enc bytea,
          team_uuid text,
          team_name text,
          updated_by uuid,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO do_accounts (key, label)
          VALUES ('production', 'Production'), ('development', 'Development');
        UPDATE do_accounts a
          SET token_enc = i.secret_enc, updated_by = i.updated_by, updated_at = i.updated_at
          FROM integrations i
          WHERE i.kind = 'digitalocean' AND a.key = 'production';
        DELETE FROM integrations WHERE kind = 'digitalocean';
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox', 'esxi'));

        ALTER TABLE environments
          DROP CONSTRAINT environments_type_check,
          ADD CONSTRAINT environments_type_check
            CHECK (type IN ('dev', 'beta', 'custom', 'production')),
          ADD COLUMN slots text[] NOT NULL DEFAULT '{{}}',
          ADD COLUMN active_slot text,
          ADD COLUMN auto_activate boolean NOT NULL DEFAULT false,
          ADD COLUMN retiring boolean NOT NULL DEFAULT false,
          ADD CONSTRAINT environments_slots_check
            CHECK (slots <@ ARRAY['blue', 'green', 'orange', 'purple']::text[]),
          ADD CONSTRAINT environments_active_slot_check
            CHECK (active_slot IS NULL OR active_slot = ANY (slots)),
          ADD CONSTRAINT environments_production_check
            CHECK (type <> 'production' OR (target_id = 'digitalocean' AND NOT auto_activate));

        ALTER TABLE deployments
          ADD COLUMN cloud boolean NOT NULL DEFAULT false,
          ADD COLUMN slot text,
          ADD COLUMN go_live boolean NOT NULL DEFAULT false,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check
            CHECK (mode IN ({_MODES_9}, 'activate', 'renew'));

        CREATE TABLE do_environments (
          environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
          account_key text NOT NULL REFERENCES do_accounts(key) ON DELETE RESTRICT,
          team_uuid text,
          region text NOT NULL CHECK (region ~ '^[a-z]{{3}}[0-9]$'),
          droplet_size text NOT NULL,
          droplet_image text NOT NULL DEFAULT 'ubuntu-24-04-x64',
          db_size text NOT NULL,
          db_standby boolean NOT NULL DEFAULT false,
          acme_staging boolean NOT NULL DEFAULT false,
          ssh_public_key text NOT NULL,
          ssh_private_key_enc bytea NOT NULL,
          acme_key_enc bytea NOT NULL,
          vpc_ip_range text,
          lb_ip text,
          db_host text,
          db_port integer,
          db_admin_password_enc bytea,
          db_ca_cert text,
          bucket text NOT NULL UNIQUE,
          spaces_key_id text,
          spaces_secret_enc bytea,
          cert_not_after timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE do_slots (
          environment_id uuid NOT NULL
            REFERENCES do_environments(environment_id) ON DELETE CASCADE,
          slot text NOT NULL CHECK (slot IN ('blue', 'green', 'orange', 'purple')),
          host_key_public text NOT NULL,
          host_key_private_enc bytea,
          droplet_id text,
          public_ip text,
          private_ip text,
          sha text,
          image_tag text,
          last_check_ok boolean,
          last_check_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (environment_id, slot)
        );

        CREATE TABLE do_resources (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          kind text NOT NULL CHECK (kind IN ('vpc', 'droplet', 'database', 'spaces_key',
                                             'bucket', 'certificate', 'load_balancer',
                                             'firewall')),
          do_id text NOT NULL,
          name text NOT NULL,
          slot text,
          origin text NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'claimed')),
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (kind, do_id)
        );
        CREATE INDEX do_resources_environment ON do_resources (environment_id);

        CREATE TABLE acme_accounts (
          directory text PRIMARY KEY,
          key_enc bytea NOT NULL,
          kid text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
    """)


def downgrade() -> None:
    # Refuses while Sirdar manages anything on DigitalOcean: dropping the
    # records would orphan droplets, databases and buckets that cost money.
    # The Production token goes back to the digitalocean integration; the
    # Development token has nowhere to go and is dropped.
    op.execute(f"""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM do_environments) OR EXISTS (SELECT 1 FROM do_resources) THEN
            RAISE EXCEPTION 'Can''t downgrade below 0010 while Sirdar manages DigitalOcean '
                            'environments: delete them first.';
          END IF;
        END $$;
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox', 'esxi', 'digitalocean'));
        INSERT INTO integrations (kind, config, secret_enc, updated_by, updated_at)
          SELECT 'digitalocean', '{{}}', token_enc, updated_by, updated_at
          FROM do_accounts WHERE key = 'production' AND token_enc IS NOT NULL;
        DROP TABLE acme_accounts, do_resources, do_slots, do_environments, do_accounts;
        DELETE FROM deployments WHERE mode IN ('activate', 'renew');
        ALTER TABLE deployments
          DROP COLUMN cloud, DROP COLUMN slot, DROP COLUMN go_live,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN ({_MODES_9}));
        ALTER TABLE environments
          DROP CONSTRAINT environments_production_check,
          DROP CONSTRAINT environments_active_slot_check,
          DROP CONSTRAINT environments_slots_check,
          DROP COLUMN slots, DROP COLUMN active_slot, DROP COLUMN auto_activate,
          DROP COLUMN retiring,
          DROP CONSTRAINT environments_type_check,
          ADD CONSTRAINT environments_type_check CHECK (type IN ('dev', 'beta', 'custom'));
    """)
```

(`{{` and `}}` are literal braces inside the f-strings.)

- [ ] **Step 5: Add the models**

In `sirdar/api/src/sirdar_api/db/models.py`, change the module docstring's "(migrations 0001–0008)" to "(migrations 0001–0010)". In `Environment`, change the `type` comment to `# dev | beta | custom | production` and `target_id`'s to `# "ssh" | "ssh:<slug>" | "proxmox" | "esxi" | "digitalocean"`, then add after `publish`:

```python
    # Blue/Green (migration 0010, DigitalOcean environments): the slots it
    # has, the one the load balancer sends traffic to, whether a good deploy
    # of a non-production environment activates itself, and production's
    # "being retired" mark (Delete needs it).
    slots: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'"))
    active_slot: Mapped[str | None]
    auto_activate: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    retiring: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
```

In `Deployment`, change the mode comment's last line to `# | vm_restore | activate | renew` and add after `vm_snapshot`:

```python
    # DigitalOcean (migration 0010): its plan is a DigitalOcean plan; the slot
    # it deploys, smoke-tests or switches to; whether it ends with 14 Switch
    # traffic. Retries keep all three.
    cloud: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    slot: Mapped[str | None]
    go_live: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
```

Append at the end of the file:

```python
class DoAccount(Base):
    """One of the two DigitalOcean accounts (migration 0010), keyed
    "production" or "development". The API token and the droplets' renewal
    token are Fernet-encrypted with SIRDAR_SECRETS_KEY and never returned;
    team_uuid is the DigitalOcean team the token answered for when Sirdar
    last checked."""

    __tablename__ = "do_accounts"

    key: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    region: Mapped[str | None]
    token_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    renewal_token_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    team_uuid: Mapped[str | None]
    team_name: Mapped[str | None]
    updated_by: Mapped[uuid.UUID | None]
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class DoEnvironment(Base):
    """An environment Sirdar builds on DigitalOcean (migration 0010): the
    account and sizes frozen at create (step 0 builds from these), the
    per-environment SSH key pair and the cert-worker's ACME account key, and
    what step 0 learned (VPC range, load balancer address, database
    connection, bucket key, certificate expiry). Secrets are
    Fernet-encrypted with SIRDAR_SECRETS_KEY and never returned."""

    __tablename__ = "do_environments"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)
    account_key: Mapped[str] = mapped_column(ForeignKey("do_accounts.key", ondelete="RESTRICT"))
    team_uuid: Mapped[str | None]
    region: Mapped[str]
    droplet_size: Mapped[str]
    droplet_image: Mapped[str] = mapped_column(server_default=text("'ubuntu-24-04-x64'"))
    db_size: Mapped[str]
    db_standby: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    acme_staging: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    ssh_public_key: Mapped[str]
    ssh_private_key_enc: Mapped[bytes] = mapped_column(BYTEA)
    acme_key_enc: Mapped[bytes] = mapped_column(BYTEA)
    vpc_ip_range: Mapped[str | None]
    lb_ip: Mapped[str | None]
    db_host: Mapped[str | None]
    db_port: Mapped[int | None] = mapped_column(Integer)
    db_admin_password_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    db_ca_cert: Mapped[str | None]
    bucket: Mapped[str] = mapped_column(unique=True)
    spaces_key_id: Mapped[str | None]
    spaces_secret_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    cert_not_after: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class DoSlot(Base):
    """One slot of a DigitalOcean environment (migration 0010): its droplet,
    the SSH host key Sirdar generated for it (the private half only until
    step 0 has delivered it), the commit deployed on it, and the last slot
    smoke test."""

    __tablename__ = "do_slots"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("do_environments.environment_id", ondelete="CASCADE"), primary_key=True)
    slot: Mapped[str] = mapped_column(primary_key=True)
    host_key_public: Mapped[str]
    host_key_private_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    droplet_id: Mapped[str | None]
    public_ip: Mapped[str | None]
    private_ip: Mapped[str | None]
    sha: Mapped[str | None]
    image_tag: Mapped[str | None]
    last_check_ok: Mapped[bool | None] = mapped_column(Boolean)
    last_check_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class DoResource(Base):
    """Something Sirdar made on DigitalOcean for one environment (migration
    0010), and the record that it is Sirdar's: Sirdar changes or deletes only
    what a row names and what still matches (its tag, or its exact name)."""

    __tablename__ = "do_resources"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"))
    # vpc | droplet | database | spaces_key | bucket | certificate | load_balancer | firewall
    kind: Mapped[str]
    do_id: Mapped[str]
    name: Mapped[str]
    slot: Mapped[str | None]
    origin: Mapped[str] = mapped_column(server_default=text("'created'"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AcmeAccount(Base):
    """Sirdar's own ACME account for one directory URL (migration 0010): an
    ES256 key, Fernet-encrypted, and the account URL (kid) once registered."""

    __tablename__ = "acme_accounts"

    directory: Mapped[str] = mapped_column(primary_key=True)
    key_enc: Mapped[bytes] = mapped_column(BYTEA)
    kid: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

- [ ] **Step 6: Keep the test database clean**

In `sirdar/api/tests/conftest.py`, append `do_environments, do_slots, do_resources, acme_accounts` to `SIRDAR_TABLES` (after `esxi_vms`, inside the same string), and in `clean_db`, right after the `TRUNCATE` line, add:

```python
        # The two DigitalOcean accounts are fixed rows: reset them, never drop them.
        await session.execute(text(
            "UPDATE do_accounts SET label = CASE key WHEN 'production' THEN 'Production' "
            "ELSE 'Development' END, region = NULL, token_enc = NULL, "
            "renewal_token_enc = NULL, team_uuid = NULL, team_name = NULL, updated_by = NULL"))
```

- [ ] **Step 7: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_models.py`
Expected: all PASS.

- [ ] **Step 8: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 migrations/versions/0010_digitalocean_environments.py src/sirdar_api/db/models.py tests/conftest.py tests/test_deploy_models.py
cd ../.. && git add sirdar/api/migrations/versions/0010_digitalocean_environments.py sirdar/api/src/sirdar_api/db/models.py sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_models.py
git commit -m "feat(sirdar): migration 0010 — DigitalOcean accounts, environments, slots and resources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The DigitalOcean client and `FakeDigitalOcean`

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/do_api.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/outbound.py` (kinds `spaces`, `acme`)
- Create: `sirdar/api/tests/fake_digitalocean.py`
- Create: `sirdar/api/tests/test_deploy_do_api.py`

**Interfaces:**
- Produces:
  - `do_api.connect(token: str, *, transport=None, sleep=asyncio.sleep)` — an async context manager yielding `DigitalOceanApi`. `transport=None` means `outbound.transports()["digitalocean"]`.
  - `DoError(reason, status=None)`, `DoNotFound(DoError)`, `DoForbidden(DoError)`.
  - `DigitalOceanApi` methods (all async): `account() -> dict`; `vpc(id) -> dict|None`, `create_vpc(name, region, description) -> dict`, `delete_vpc(id) -> bool`, `vpc_member_count(id) -> int`; `droplet(id) -> dict|None`, `droplets_tagged(tag) -> list[dict]`, `create_droplet(body: dict) -> dict`, `delete_droplet(id) -> bool`, `droplet_action(id, type_, **extra) -> dict`; `database(id) -> dict|None`, `databases_tagged(tag) -> list[dict]`, `create_database(body) -> dict`, `set_database_firewall(id, droplet_ids: list[str]) -> None`, `database_firewall(id) -> list[dict]`, `database_ca(id) -> str`, `delete_database(id) -> bool`, `resize_database(id, size, num_nodes) -> None`; `spaces_keys() -> list[dict]`, `create_spaces_key(name, grants) -> dict`, `delete_spaces_key(access_key) -> bool`; `certificate(id) -> dict|None`, `create_certificate(name, private_key, leaf, chain) -> dict`, `delete_certificate(id) -> bool`; `load_balancer(id) -> dict|None`, `create_load_balancer(body) -> dict`, `update_load_balancer(id, body) -> dict`, `delete_load_balancer(id) -> bool`; `firewall(id) -> dict|None`, `create_firewall(body) -> dict`, `delete_firewall(id) -> bool`; `sizes() -> list[dict]`, `database_options() -> dict`.
  - `do_api.droplet_ips(droplet: dict) -> tuple[str | None, str | None]` (public, private IPv4).
  - Test fake: `FakeDigitalOcean(tokens=None)` with `.transport()`, state dicts `vpcs, droplets, databases, db_rules, keys, certificates, load_balancers, firewalls`, knobs `boot_polls, db_polls, lb_polls, firewall_wait, vpc_lingering`, `requests`, and constants `DO_TOKEN`, `DEV_TOKEN`, `RENEW_TOKEN`, `DEV_RENEW_TOKEN`, `TEAMS`, `DB_ADMIN_PASSWORD`, `LB_IP`.

- [ ] **Step 1: Add the outbound kinds**

In `sirdar/api/src/sirdar_api/deploy/outbound.py`, change the docstring's list to "(Cloudflare, Nginx Proxy Manager, smoke tests, the Proxmox and DigitalOcean APIs, DigitalOcean Spaces' S3 API and the ACME directory)" and set:

```python
KINDS = ("cloudflare", "npm", "smoke", "proxmox", "digitalocean", "spaces", "acme")
```

- [ ] **Step 2: Write the fake**

Create `sirdar/api/tests/fake_digitalocean.py`:

```python
"""A stand-in for the DigitalOcean API v2 calls deploy/do_api.py makes: an
httpx.MockTransport over in-memory accounts, VPCs, droplets, managed
databases (with firewall rules and a CA), Spaces keys, certificates, load
balancers and cloud firewalls. Tokens carry a team and, for a renewal
token, a scope set. Droplets, databases and load balancers become ready
after a few GETs, like the real thing."""

import base64
import itertools
import json
import uuid
from datetime import UTC, datetime

import httpx
from cryptography import x509

DO_TOKEN = "dop_v1_" + "1a2b3c4d" * 8
DEV_TOKEN = "dop_v1_" + "5e6f7a8b" * 8
RENEW_TOKEN = "dop_v1_" + "9c0d1e2f" * 8
DEV_RENEW_TOKEN = "dop_v1_" + "3a4b5c6d" * 8
TEAMS = {DO_TOKEN: ("team-prod-0001", "Encon Production"),
         DEV_TOKEN: ("team-dev-0002", "Encon Development"),
         RENEW_TOKEN: ("team-prod-0001", "Encon Production"),
         DEV_RENEW_TOKEN: ("team-dev-0002", "Encon Development")}
# What a custom-scoped renewal token may do: (method, first path segment).
RENEWAL_SCOPES = frozenset({("GET", "certificates"), ("POST", "certificates"),
                            ("DELETE", "certificates"), ("GET", "load_balancers"),
                            ("PUT", "load_balancers")})
DB_ADMIN_PASSWORD = "FAKE_doadmin-S3cr3t-0123456789"
LB_IP = "203.0.113.50"
VPC_RANGE = "10.116.0.0/20"
CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfakeCA\n-----END CERTIFICATE-----\n"


def _err(status: int, code: str, message: str = "") -> httpx.Response:
    return httpx.Response(status, json={"id": code, "message": message or code})


class FakeDigitalOcean:
    def __init__(self, *, tokens: dict | None = None):
        # token -> None (full access) or a scope set
        self.tokens = tokens if tokens is not None else {
            DO_TOKEN: None, DEV_TOKEN: None, RENEW_TOKEN: RENEWAL_SCOPES,
            DEV_RENEW_TOKEN: RENEWAL_SCOPES}
        self.vpcs: dict[str, dict] = {}
        self.droplets: dict[str, dict] = {}
        self.databases: dict[str, dict] = {}
        self.db_rules: dict[str, list] = {}
        self.keys: dict[str, dict] = {}
        self.certificates: dict[str, dict] = {}
        self.load_balancers: dict[str, dict] = {}
        self.firewalls: dict[str, dict] = {}
        self.requests: list[httpx.Request] = []
        self.boot_polls = 1           # GETs before a droplet is active
        self.db_polls = 1             # GETs before a database is online
        self.lb_polls = 1             # GETs before a load balancer is active
        self.firewall_wait = 0        # database firewall PUTs refused before one is accepted
        self.vpc_lingering = 0        # VPC deletes refused after its members went
        self.public_ip = "127.0.0.1"  # the tests' SSH server plays every droplet
        self.down = False
        self.fail: dict[tuple[str, str], int] = {}   # (method, path) -> status
        self._ids = itertools.count(4001)
        self._private = itertools.count(2)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def writes(self) -> list[tuple[str, str]]:
        return [(r.method, r.url.path.removeprefix("/v2")) for r in self.requests
                if r.method != "GET"]

    # ---- helpers for tests ---------------------------------------------------------

    def add_droplet(self, name: str, tags: list[str], **over) -> dict:
        did = str(next(self._ids))
        self.droplets[did] = {"id": int(did), "name": name, "status": "active", "tags": tags,
                              "region": {"slug": "nyc3"}, "size_slug": "s-2vcpu-4gb",
                              "vpc_uuid": None, "networks": self._networks(), "_polls": 99,
                              "_user_data": "", **over}
        return self.droplets[did]

    def _networks(self) -> dict:
        return {"v4": [{"ip_address": self.public_ip, "type": "public"},
                       {"ip_address": f"10.116.0.{next(self._private)}", "type": "private"}]}

    # ---- the handler ---------------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        auth = request.headers.get("authorization", "")
        token = auth.removeprefix("Bearer ")
        if token not in self.tokens:
            return _err(401, "unauthorized", "Unable to authenticate you")
        path = request.url.path.removeprefix("/v2")
        parts = [p for p in path.split("/") if p]
        method = request.method
        scopes = self.tokens[token]
        if scopes is not None and (method, parts[0] if parts else "") not in scopes:
            return _err(403, "forbidden", "You are not authorized to perform this operation")
        if (method, path) in self.fail:
            return _err(self.fail[(method, path)], "unprocessable_entity", "refused " + token)
        body = json.loads(request.content) if request.content else {}
        handler = getattr(self, f"_{parts[0]}", None) if parts else None
        if handler is None:
            return _err(404, "not_found")
        return handler(method, parts[1:], body, request, token)

    # ---- account, regions, sizes ---------------------------------------------------------

    def _account(self, method, rest, body, request, token):
        team_uuid, team_name = TEAMS.get(token, ("team-x", "Team X"))
        return httpx.Response(200, json={"account": {
            "uuid": "acct-" + team_uuid, "email": "ops@encondata.com", "status": "active",
            "droplet_limit": 25, "team": {"uuid": team_uuid, "name": team_name}}})

    def _regions(self, method, rest, body, request, token):
        return httpx.Response(200, json={"regions": [
            {"slug": "nyc3", "name": "New York 3", "available": True},
            {"slug": "sfo3", "name": "San Francisco 3", "available": True}],
            "meta": {"total": 2}})

    def _sizes(self, method, rest, body, request, token):
        sizes = [{"slug": "s-1vcpu-2gb", "vcpus": 1, "memory": 2048, "disk": 50},
                 {"slug": "s-2vcpu-4gb", "vcpus": 2, "memory": 4096, "disk": 80},
                 {"slug": "s-4vcpu-8gb", "vcpus": 4, "memory": 8192, "disk": 160}]
        return httpx.Response(200, json={"sizes": [{**s, "available": True} for s in sizes],
                                         "links": {}, "meta": {"total": 3}})

    # ---- VPCs ------------------------------------------------------------------------------

    def _vpc_members(self, vid: str) -> int:
        return (sum(d.get("vpc_uuid") == vid for d in self.droplets.values())
                + sum(d.get("private_network_uuid") == vid for d in self.databases.values())
                + sum(lb.get("vpc_uuid") == vid for lb in self.load_balancers.values()))

    def _vpcs(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            vid = str(uuid.uuid4())
            self.vpcs[vid] = {"id": vid, "urn": f"do:vpc:{vid}", "name": body["name"],
                              "region": body["region"], "description": body.get("description", ""),
                              "ip_range": VPC_RANGE, "default": False}
            return httpx.Response(201, json={"vpc": self.vpcs[vid]})
        vpc = self.vpcs.get(rest[0]) if rest else None
        if vpc is None:
            return _err(404, "not_found")
        if method == "GET" and rest[1:] == ["members"]:
            n = self._vpc_members(vpc["id"])
            return httpx.Response(200, json={"members": [{"urn": "x"}] * n,
                                             "links": {}, "meta": {"total": n}})
        if method == "GET":
            return httpx.Response(200, json={"vpc": vpc})
        if method == "DELETE":
            if self._vpc_members(vpc["id"]) or self.vpc_lingering:
                self.vpc_lingering = max(0, self.vpc_lingering - 1)
                return _err(403, "forbidden", "Can not delete VPC with members")
            del self.vpcs[vpc["id"]]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    # ---- droplets --------------------------------------------------------------------------

    def _droplets(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            did = str(next(self._ids))
            self.droplets[did] = {"id": int(did), "name": body["name"], "status": "new",
                                  "tags": list(body.get("tags") or []),
                                  "region": {"slug": body["region"]},
                                  "size_slug": body["size"], "vpc_uuid": body.get("vpc_uuid"),
                                  "image": body["image"], "networks": {"v4": []}, "_polls": 0,
                                  "_user_data": body.get("user_data", "")}
            return httpx.Response(202, json={"droplet": self._public_droplet(did)})
        if method == "GET" and not rest:
            tag = request.url.params.get("tag_name")
            rows = [self._public_droplet(k) for k, d in self.droplets.items()
                    if tag is None or tag in d["tags"]]
            return httpx.Response(200, json={"droplets": rows, "links": {},
                                             "meta": {"total": len(rows)}})
        did = rest[0]
        if did not in self.droplets:
            return _err(404, "not_found")
        if method == "GET":
            d = self.droplets[did]
            d["_polls"] += 1
            if d["status"] == "new" and d["_polls"] >= self.boot_polls:
                d["status"], d["networks"] = "active", self._networks()
            return httpx.Response(200, json={"droplet": self._public_droplet(did)})
        if method == "DELETE":
            del self.droplets[did]
            return httpx.Response(204)
        if method == "POST" and rest[1:] == ["actions"]:
            d = self.droplets[did]
            if body["type"] == "power_off":
                d["status"] = "off"
            elif body["type"] == "power_on":
                d["status"] = "active"
            elif body["type"] == "resize":
                d["size_slug"] = body["size"]
            return httpx.Response(201, json={"action": {"id": next(self._ids),
                                                        "status": "completed",
                                                        "type": body["type"]}})
        return _err(405, "method_not_allowed")

    def _public_droplet(self, did: str) -> dict:
        return {k: v for k, v in self.droplets[did].items() if not k.startswith("_")}

    # ---- managed databases ----------------------------------------------------------------

    def _databases(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            dbid = str(uuid.uuid4())
            name = body["name"]
            conn = {"user": "doadmin", "password": DB_ADMIN_PASSWORD, "port": 25060,
                    "database": "defaultdb", "ssl": True}
            self.databases[dbid] = {
                "id": dbid, "name": name, "engine": body["engine"], "version": body["version"],
                "status": "creating", "region": body["region"], "size": body["size"],
                "num_nodes": body["num_nodes"], "tags": list(body.get("tags") or []),
                "private_network_uuid": body.get("private_network_uuid"),
                "connection": {**conn, "host": f"{name}-do-user-1.db.ondigitalocean.com"},
                "private_connection": {**conn,
                                       "host": f"private-{name}-do-user-1.db.ondigitalocean.com"},
                "_polls": 0}
            self.db_rules[dbid] = []
            return httpx.Response(201, json={"database": self._public_db(dbid)})
        if method == "GET" and rest == ["options"]:
            sizes = ["db-s-1vcpu-1gb", "db-s-1vcpu-2gb", "db-s-2vcpu-4gb", "db-s-4vcpu-8gb"]
            return httpx.Response(200, json={"options": {"pg": {
                "versions": ["14", "15", "16", "17"],
                "layouts": [{"num_nodes": 1, "sizes": sizes}, {"num_nodes": 2, "sizes": sizes}]}}})
        if method == "GET" and not rest:
            tag = request.url.params.get("tag_name")
            rows = [self._public_db(k) for k, d in self.databases.items()
                    if tag is None or tag in d["tags"]]
            return httpx.Response(200, json={"databases": rows})
        dbid = rest[0]
        if dbid not in self.databases:
            return _err(404, "not_found")
        sub = rest[1:]
        d = self.databases[dbid]
        if method == "GET" and not sub:
            d["_polls"] += 1
            if d["status"] == "creating" and d["_polls"] >= self.db_polls:
                d["status"] = "online"
            return httpx.Response(200, json={"database": self._public_db(dbid)})
        if sub == ["firewall"] and method == "PUT":
            if self.firewall_wait:
                self.firewall_wait -= 1
                return _err(422, "unprocessable_entity", "cluster is not ready")
            self.db_rules[dbid] = [{"type": r["type"], "value": r["value"]} for r in body["rules"]]
            return httpx.Response(204)
        if sub == ["firewall"] and method == "GET":
            return httpx.Response(200, json={"rules": self.db_rules[dbid]})
        if sub == ["ca"] and method == "GET":
            return httpx.Response(200, json={"ca": {
                "certificate": base64.b64encode(CA_PEM.encode()).decode()}})
        if sub == ["resize"] and method == "PUT":
            d["size"], d["num_nodes"] = body["size"], body["num_nodes"]
            return httpx.Response(202)
        if method == "DELETE" and not sub:
            del self.databases[dbid]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    def _public_db(self, dbid: str) -> dict:
        return {k: v for k, v in self.databases[dbid].items() if not k.startswith("_")}

    # ---- Spaces keys -------------------------------------------------------------------------

    def _spaces(self, method, rest, body, request, token):
        if rest[:1] != ["keys"]:
            return _err(404, "not_found")
        if method == "POST" and len(rest) == 1:
            n = next(self._ids)
            key = {"name": body["name"], "access_key": f"DO00KEY{n:06d}",
                   "secret_key": f"spaces-SECRET-{n:06d}-xyz", "grants": body["grants"],
                   "created_at": datetime.now(UTC).isoformat()}
            self.keys[key["access_key"]] = key
            return httpx.Response(201, json={"key": key})
        if method == "GET" and len(rest) == 1:
            return httpx.Response(200, json={"keys": [
                {k: v for k, v in key.items() if k != "secret_key"} for key in self.keys.values()],
                "links": {}, "meta": {"total": len(self.keys)}})
        if method == "DELETE" and len(rest) == 2:
            if self.keys.pop(rest[1], None) is None:
                return _err(404, "not_found")
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    # ---- certificates ------------------------------------------------------------------------

    def _certificates(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            leaf = x509.load_pem_x509_certificate(body["leaf_certificate"].encode())
            names = leaf.extensions.get_extension_for_class(
                x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
            cid = str(uuid.uuid4())
            self.certificates[cid] = {
                "id": cid, "name": body["name"], "type": "custom", "state": "verified",
                "not_after": leaf.not_valid_after_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "dns_names": sorted(names), "sha1_fingerprint": "ab" * 20,
                "_private_key": body["private_key"]}
            return httpx.Response(201, json={"certificate": self._public_cert(cid)})
        if method == "GET" and not rest:
            return httpx.Response(200, json={"certificates": [
                self._public_cert(c) for c in self.certificates], "links": {},
                "meta": {"total": len(self.certificates)}})
        cid = rest[0] if rest else None
        if cid not in self.certificates:
            return _err(404, "not_found")
        if method == "GET":
            return httpx.Response(200, json={"certificate": self._public_cert(cid)})
        if method == "DELETE":
            if any(r.get("certificate_id") == cid for lb in self.load_balancers.values()
                   for r in lb["forwarding_rules"]):
                return _err(403, "forbidden", "certificate is in use")
            del self.certificates[cid]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    def _public_cert(self, cid: str) -> dict:
        return {k: v for k, v in self.certificates[cid].items() if not k.startswith("_")}

    # ---- load balancers ----------------------------------------------------------------------

    _LB_FIELDS = ("name", "region", "size_unit", "vpc_uuid", "forwarding_rules", "health_check",
                  "droplet_ids", "redirect_http_to_https", "sticky_sessions")

    def _load_balancers(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            lid = str(uuid.uuid4())
            self.load_balancers[lid] = {"id": lid, "ip": "", "status": "new", "_polls": 0,
                                        **{k: body.get(k) for k in self._LB_FIELDS}}
            self.load_balancers[lid]["region"] = {"slug": body["region"]}
            return httpx.Response(202, json={"load_balancer": self._public_lb(lid)})
        if method == "GET" and not rest:
            return httpx.Response(200, json={"load_balancers": [
                self._public_lb(k) for k in self.load_balancers], "links": {},
                "meta": {"total": len(self.load_balancers)}})
        lid = rest[0]
        if lid not in self.load_balancers:
            return _err(404, "not_found")
        lb = self.load_balancers[lid]
        if method == "GET":
            lb["_polls"] += 1
            if lb["status"] == "new" and lb["_polls"] >= self.lb_polls:
                lb["status"], lb["ip"] = "active", LB_IP
            return httpx.Response(200, json={"load_balancer": self._public_lb(lid)})
        if method == "PUT":
            missing = [k for k in ("name", "region", "forwarding_rules") if k not in body]
            if missing:                     # PUT replaces the whole load balancer
                return _err(422, "unprocessable_entity", "missing " + ",".join(missing))
            for k in self._LB_FIELDS:
                if k in body:
                    lb[k] = body[k]
            lb["region"] = {"slug": body["region"]} if isinstance(body["region"], str) \
                else body["region"]
            return httpx.Response(200, json={"load_balancer": self._public_lb(lid)})
        if method == "DELETE":
            del self.load_balancers[lid]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    def _public_lb(self, lid: str) -> dict:
        return {k: v for k, v in self.load_balancers[lid].items() if not k.startswith("_")}

    # ---- cloud firewalls ---------------------------------------------------------------------

    def _firewalls(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            fid = str(uuid.uuid4())
            self.firewalls[fid] = {"id": fid, "status": "succeeded", "name": body["name"],
                                   "inbound_rules": body["inbound_rules"],
                                   "outbound_rules": body["outbound_rules"],
                                   "tags": body.get("tags") or [], "droplet_ids": []}
            return httpx.Response(202, json={"firewall": self.firewalls[fid]})
        fid = rest[0] if rest else None
        if fid not in self.firewalls:
            return _err(404, "not_found")
        if method == "GET":
            return httpx.Response(200, json={"firewall": self.firewalls[fid]})
        if method == "DELETE":
            del self.firewalls[fid]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")
```

- [ ] **Step 3: Write the failing client tests**

Create `sirdar/api/tests/test_deploy_do_api.py`:

```python
"""deploy/do_api.py against FakeDigitalOcean: the token travels only in the
Authorization header, errors are our own copy (DigitalOcean's message, which
may echo the request, never shows), a 404 reads as "gone", a 429 is retried
once, and lists follow pages."""

import httpx
import pytest

from sirdar_api.deploy import do_api, outbound
from sirdar_api.deploy.do_api import DoError, DoForbidden

from .fake_digitalocean import DO_TOKEN, RENEW_TOKEN, FakeDigitalOcean


@pytest.fixture
def fake(monkeypatch):
    fake = FakeDigitalOcean()
    monkeypatch.setattr(outbound, "transports",
                        lambda: {k: None for k in outbound.KINDS} | {"digitalocean": fake.transport()})
    return fake


async def test_account_and_the_token_header(fake):
    async with do_api.connect(DO_TOKEN) as api:
        account = await api.account()
    assert account["team"]["uuid"] == "team-prod-0001"
    request = fake.requests[0]
    assert request.headers["authorization"] == f"Bearer {DO_TOKEN}"
    assert DO_TOKEN not in str(request.url)


async def test_a_bad_token_is_our_copy():
    with pytest.raises(DoError) as err:
        async with do_api.connect("nope", transport=FakeDigitalOcean().transport()) as api:
            await api.account()
    assert err.value.reason == "DigitalOcean rejected the API token."
    assert err.value.status == 401


async def test_errors_never_carry_digitalocean_text(fake):
    fake.fail[("POST", "/vpcs")] = 422          # the fake's message echoes the token
    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN) as api:
            await api.create_vpc("ss-uat9", "nyc3", "sirdar:x")
    assert err.value.reason == ("DigitalOcean refused the request (unprocessable_entity, "
                                "HTTP 422).")
    assert DO_TOKEN not in repr(err.value)


async def test_gone_reads_as_none_or_false(fake):
    async with do_api.connect(DO_TOKEN) as api:
        assert await api.droplet("999") is None
        assert await api.delete_droplet("999") is False
        assert await api.certificate("nope") is None


async def test_a_scoped_token_is_forbidden_elsewhere(fake):
    async with do_api.connect(RENEW_TOKEN) as api:
        assert await api.load_balancer("nope") is None        # in scope: a plain 404
        with pytest.raises(DoForbidden):
            await api.droplets_tagged("sirdar")


async def test_429_is_retried_once():
    calls = {"n": 0}
    slept: list[float] = []

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "3"})
        return httpx.Response(200, json={"account": {"uuid": "u"}})

    async def sleep(s):
        slept.append(s)

    async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler),
                              sleep=sleep) as api:
        assert (await api.account())["uuid"] == "u"
    assert slept == [3.0]


async def test_lists_follow_pages():
    def handler(request):
        page = request.url.params.get("page", "1")
        nxt = {"pages": {"next": "https://api.digitalocean.com/v2/droplets?page=2"}} \
            if page == "1" else {}
        return httpx.Response(200, json={"droplets": [{"id": int(page)}], "links": nxt})

    async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler)) as api:
        assert [d["id"] for d in await api.droplets_tagged("sirdar")] == [1, 2]


async def test_droplet_ips_and_readiness(fake):
    fake.boot_polls = 2
    async with do_api.connect(DO_TOKEN) as api:
        made = await api.create_droplet({"name": "ss-uat9-orange", "region": "nyc3",
                                         "size": "s-2vcpu-4gb", "image": "ubuntu-24-04-x64",
                                         "tags": ["sirdar"], "user_data": "#cloud-config\n"})
        assert do_api.droplet_ips(made) == (None, None)
        first = await api.droplet(str(made["id"]))
        assert first["status"] == "new"
        second = await api.droplet(str(made["id"]))
    assert second["status"] == "active"
    public, private = do_api.droplet_ips(second)
    assert public == "127.0.0.1" and private.startswith("10.116.0.")


async def test_database_firewall_and_ca(fake):
    async with do_api.connect(DO_TOKEN) as api:
        made = await api.create_database({"name": "ss-uat9-db", "engine": "pg", "version": "16",
                                          "region": "nyc3", "size": "db-s-2vcpu-4gb",
                                          "num_nodes": 1, "tags": ["sirdar"]})
        await api.set_database_firewall(made["id"], ["4001", "4002"])
        assert await api.database_firewall(made["id"]) == [
            {"type": "droplet", "value": "4001"}, {"type": "droplet", "value": "4002"}]
        assert (await api.database_ca(made["id"])).startswith("-----BEGIN CERTIFICATE-----")


async def test_unreachable_is_our_copy(fake):
    fake.down = True
    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN) as api:
            await api.account()
    assert err.value.reason == "Couldn't reach the DigitalOcean API."
```

- [ ] **Step 4: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_api.py`
Expected: FAIL (`cannot import name 'do_api'`).

- [ ] **Step 5: Write the client**

Create `sirdar/api/src/sirdar_api/deploy/do_api.py`:

```python
"""The DigitalOcean API v2 calls Sirdar builds environments with (deploy
phase 7): VPCs, droplets, managed databases (firewall, CA), Spaces keys,
certificates, load balancers and cloud firewalls.

One seam: `async with connect(token) as api:`. The token goes only into the
Authorization header. Errors are DoError with our own copy: DigitalOcean's
`message` (which may echo request details) is never kept; its error `id`
(like `unprocessable_entity`) may be named. A 404 on a single resource reads
as "gone" (None, or False from a delete). The transport comes from
outbound.transports(), so tests answer with FakeDigitalOcean."""

import asyncio
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import httpx

from sirdar_api.deploy import outbound

BASE_URL = "https://api.digitalocean.com/v2"
TIMEOUT = 30
PER_PAGE = 200
MAX_PAGES = 10
RETRY_AFTER_DEFAULT = 5.0
RETRY_AFTER_CAP = 30.0
_ID_RE = re.compile(r"[a-z_]{1,40}")
_UNREACHABLE = "Couldn't reach the DigitalOcean API."
_BAD_TOKEN = "DigitalOcean rejected the API token."
_MALFORMED = "The DigitalOcean API token is malformed."
_FORBIDDEN = "The DigitalOcean token isn't allowed to do that."
_NOT_FOUND = "DigitalOcean couldn't find that resource."
_UNEXPECTED = "DigitalOcean sent a response Sirdar didn't understand."
_RATE_LIMITED = "DigitalOcean is rate-limiting Sirdar; try again in a few minutes."


class DoError(Exception):
    """`reason` is user-facing copy we wrote; `status` the HTTP status, if any."""

    def __init__(self, reason: str, *, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class DoNotFound(DoError):
    pass


class DoForbidden(DoError):
    pass


def _refused(status: int, body) -> str:
    code = body.get("id") if isinstance(body, dict) else None
    if isinstance(code, str) and _ID_RE.fullmatch(code):
        return f"DigitalOcean refused the request ({code}, HTTP {status})."
    return f"DigitalOcean answered with HTTP {status}."


def _retry_after(resp: httpx.Response) -> float:
    try:
        seconds = float(resp.headers.get("retry-after", ""))
    except ValueError:
        return RETRY_AFTER_DEFAULT
    if seconds != seconds or seconds < 0:
        return RETRY_AFTER_DEFAULT
    return min(seconds, RETRY_AFTER_CAP)


def droplet_ips(droplet: dict) -> tuple[str | None, str | None]:
    """(public, private) IPv4 of a droplet; None until DigitalOcean assigns them."""
    v4 = ((droplet.get("networks") or {}).get("v4") or []) if isinstance(droplet, dict) else []
    found = {n.get("type"): n.get("ip_address") for n in v4 if isinstance(n, dict)}
    return found.get("public"), found.get("private")


class DigitalOceanApi:
    def __init__(self, client: httpx.AsyncClient, sleep: Callable[[float], Awaitable[None]]):
        self._client = client
        self._sleep = sleep

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            return await self._client.request(method, path, **kwargs)
        except httpx.HTTPError:
            raise DoError(_UNREACHABLE) from None

    async def call(self, method: str, path: str, *, params: dict | None = None,
                   json: dict | None = None) -> dict:
        kwargs: dict = {}
        if params:
            kwargs["params"] = params
        if json is not None:
            kwargs["json"] = json
        resp = await self._request(method, path, **kwargs)
        if resp.status_code == 429:
            await self._sleep(_retry_after(resp))
            resp = await self._request(method, path, **kwargs)
            if resp.status_code == 429:
                raise DoError(_RATE_LIMITED, status=429)
        if resp.status_code == 401:
            raise DoError(_BAD_TOKEN, status=401)
        if resp.status_code in (202, 204) and not resp.content:
            return {}
        try:
            body = resp.json()
        except ValueError:
            body = None
        if resp.status_code == 403:
            raise DoForbidden(_FORBIDDEN, status=403)
        if resp.status_code == 404:
            raise DoNotFound(_NOT_FOUND, status=404)
        if resp.status_code >= 400:
            raise DoError(_refused(resp.status_code, body), status=resp.status_code)
        if not isinstance(body, dict):
            raise DoError(_UNEXPECTED)
        return body

    @staticmethod
    def _field(body: dict, key: str) -> dict:
        value = body.get(key)
        if not isinstance(value, dict):
            raise DoError(_UNEXPECTED)
        return value

    async def _one(self, path: str, key: str) -> dict | None:
        try:
            return self._field(await self.call("GET", path), key)
        except DoNotFound:
            return None

    async def _delete(self, path: str) -> bool:
        try:
            await self.call("DELETE", path)
        except DoNotFound:
            return False
        return True

    async def _list(self, path: str, key: str, **params) -> list[dict]:
        out: list[dict] = []
        query = {"per_page": PER_PAGE, **params}
        for _ in range(MAX_PAGES):
            body = await self.call("GET", path, params=query)
            page = body.get(key)
            if not isinstance(page, list):
                raise DoError(_UNEXPECTED)
            out += [r for r in page if isinstance(r, dict)]
            nxt = ((body.get("links") or {}).get("pages") or {}).get("next")
            number = httpx.URL(nxt).params.get("page") if isinstance(nxt, str) else None
            if not number:
                return out
            query = {**query, "page": number}
        raise DoError("DigitalOcean listed more than Sirdar reads.")

    # account and catalogs

    async def account(self) -> dict:
        return self._field(await self.call("GET", "/account"), "account")

    async def sizes(self) -> list[dict]:
        return await self._list("/sizes", "sizes")

    async def database_options(self) -> dict:
        return self._field(await self.call("GET", "/databases/options"), "options")

    # VPCs

    async def vpc(self, vpc_id: str) -> dict | None:
        return await self._one(f"/vpcs/{vpc_id}", "vpc")

    async def create_vpc(self, name: str, region: str, description: str) -> dict:
        body = await self.call("POST", "/vpcs", json={"name": name, "region": region,
                                                      "description": description})
        return self._field(body, "vpc")

    async def delete_vpc(self, vpc_id: str) -> bool:
        return await self._delete(f"/vpcs/{vpc_id}")

    async def vpc_member_count(self, vpc_id: str) -> int:
        body = await self.call("GET", f"/vpcs/{vpc_id}/members", params={"per_page": 1})
        try:
            return int((body.get("meta") or {})["total"])
        except (KeyError, TypeError, ValueError):
            raise DoError(_UNEXPECTED) from None

    # droplets

    async def droplet(self, droplet_id: str) -> dict | None:
        return await self._one(f"/droplets/{droplet_id}", "droplet")

    async def droplets_tagged(self, tag: str) -> list[dict]:
        return await self._list("/droplets", "droplets", tag_name=tag)

    async def create_droplet(self, body: dict) -> dict:
        return self._field(await self.call("POST", "/droplets", json=body), "droplet")

    async def delete_droplet(self, droplet_id: str) -> bool:
        return await self._delete(f"/droplets/{droplet_id}")

    async def droplet_action(self, droplet_id: str, type_: str, **extra) -> dict:
        body = await self.call("POST", f"/droplets/{droplet_id}/actions",
                               json={"type": type_, **extra})
        return self._field(body, "action")

    # managed databases

    async def database(self, database_id: str) -> dict | None:
        return await self._one(f"/databases/{database_id}", "database")

    async def databases_tagged(self, tag: str) -> list[dict]:
        body = await self.call("GET", "/databases", params={"tag_name": tag})
        rows = body.get("databases")
        if rows is None:                    # DigitalOcean answers null for "none"
            return []
        if not isinstance(rows, list):
            raise DoError(_UNEXPECTED)
        return [r for r in rows if isinstance(r, dict)]

    async def create_database(self, body: dict) -> dict:
        return self._field(await self.call("POST", "/databases", json=body), "database")

    async def set_database_firewall(self, database_id: str, droplet_ids: list[str]) -> None:
        await self.call("PUT", f"/databases/{database_id}/firewall", json={
            "rules": [{"type": "droplet", "value": str(d)} for d in droplet_ids]})

    async def database_firewall(self, database_id: str) -> list[dict]:
        rules = (await self.call("GET", f"/databases/{database_id}/firewall")).get("rules")
        if not isinstance(rules, list):
            raise DoError(_UNEXPECTED)
        return [{"type": r.get("type"), "value": r.get("value")} for r in rules
                if isinstance(r, dict)]

    async def database_ca(self, database_id: str) -> str:
        import base64
        ca = self._field(await self.call("GET", f"/databases/{database_id}/ca"), "ca")
        try:
            return base64.b64decode(ca["certificate"]).decode()
        except (KeyError, ValueError, TypeError):
            raise DoError(_UNEXPECTED) from None

    async def delete_database(self, database_id: str) -> bool:
        return await self._delete(f"/databases/{database_id}")

    async def resize_database(self, database_id: str, size: str, num_nodes: int) -> None:
        await self.call("PUT", f"/databases/{database_id}/resize",
                        json={"size": size, "num_nodes": num_nodes})

    # Spaces keys

    async def spaces_keys(self) -> list[dict]:
        return await self._list("/spaces/keys", "keys")

    async def create_spaces_key(self, name: str, grants: list[dict]) -> dict:
        body = await self.call("POST", "/spaces/keys", json={"name": name, "grants": grants})
        return self._field(body, "key")

    async def delete_spaces_key(self, access_key: str) -> bool:
        return await self._delete(f"/spaces/keys/{access_key}")

    # certificates

    async def certificate(self, certificate_id: str) -> dict | None:
        return await self._one(f"/certificates/{certificate_id}", "certificate")

    async def create_certificate(self, name: str, private_key: str, leaf: str,
                                 chain: str) -> dict:
        body = await self.call("POST", "/certificates", json={
            "name": name, "type": "custom", "private_key": private_key,
            "leaf_certificate": leaf, "certificate_chain": chain})
        return self._field(body, "certificate")

    async def delete_certificate(self, certificate_id: str) -> bool:
        return await self._delete(f"/certificates/{certificate_id}")

    # load balancers

    async def load_balancer(self, lb_id: str) -> dict | None:
        return await self._one(f"/load_balancers/{lb_id}", "load_balancer")

    async def create_load_balancer(self, body: dict) -> dict:
        return self._field(await self.call("POST", "/load_balancers", json=body), "load_balancer")

    async def update_load_balancer(self, lb_id: str, body: dict) -> dict:
        return self._field(await self.call("PUT", f"/load_balancers/{lb_id}", json=body),
                           "load_balancer")

    async def delete_load_balancer(self, lb_id: str) -> bool:
        return await self._delete(f"/load_balancers/{lb_id}")

    # cloud firewalls

    async def firewall(self, firewall_id: str) -> dict | None:
        return await self._one(f"/firewalls/{firewall_id}", "firewall")

    async def create_firewall(self, body: dict) -> dict:
        return self._field(await self.call("POST", "/firewalls", json=body), "firewall")

    async def delete_firewall(self, firewall_id: str) -> bool:
        return await self._delete(f"/firewalls/{firewall_id}")


@asynccontextmanager
async def connect(token: str, *, transport: httpx.AsyncBaseTransport | None = None,
                  sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
                  ) -> AsyncIterator[DigitalOceanApi]:
    if transport is None:
        transport = outbound.transports().get("digitalocean")
    try:
        client = httpx.AsyncClient(base_url=BASE_URL, timeout=TIMEOUT, transport=transport,
                                   headers={"Authorization": f"Bearer {token}"})
    except (UnicodeError, ValueError, TypeError):
        raise DoError(_MALFORMED) from None
    async with client:
        yield DigitalOceanApi(client, sleep)
```

Move the `import base64` in `database_ca` to the module's imports (it is shown inline only to keep this listing short).

- [ ] **Step 6: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_api.py tests/test_deploy_digitalocean.py`
Expected: all PASS.

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/do_api.py src/sirdar_api/deploy/outbound.py tests/fake_digitalocean.py tests/test_deploy_do_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/do_api.py sirdar/api/src/sirdar_api/deploy/outbound.py sirdar/api/tests/fake_digitalocean.py sirdar/api/tests/test_deploy_do_api.py
git commit -m "feat(sirdar): DigitalOcean API v2 client and FakeDigitalOcean

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The two DigitalOcean accounts

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/do_accounts.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/integrations.py` (the `digitalocean` kind is a facade over the Production account)
- Modify: `sirdar/api/src/sirdar_api/deploy/digitalocean.py` (`resolve(..., account=)`)
- Modify: `sirdar/api/src/sirdar_api/api/routes/integrations.py` (the account routes)
- Create: `sirdar/api/tests/do_helpers.py`, `sirdar/api/tests/test_deploy_do_accounts.py`
- Modify: `sirdar/api/tests/test_deploy_digitalocean_integration.py` (two tests read the row from `do_accounts`)

**Interfaces:**
- Consumes: `DoAccount`, `DoEnvironment` (Task 1); `do_api.connect`, `DoError`, `DoForbidden` (Task 2).
- Produces:
  - `do_accounts.KEYS = ("production", "development")`
  - `@dataclass(frozen=True) class Account: key, label, region: str|None, team_uuid: str|None, token (repr=False), renewal_token: str|None (repr=False), source: "stored"|"environment"`
  - `async load(db, settings, key) -> Account | None`, `async require(db, settings, key) -> Account` (IntegrationError `do_account_not_configured {account}`)
  - `async save(db, settings, key, *, label, region, token=None, renewal_token=None, clear_renewal=False, actor_id=None) -> list[str]`
  - `async clear(db, key) -> bool`, `async in_use(db, key) -> list[str]`, `async has_token(db, key) -> bool`
  - `async team_of(token) -> tuple[str, str | None]` (ConnectFailed on errors)
  - `async public(db, settings) -> list[dict]`
  - `async test(db, settings, key, *, token=None, renewal_token=None) -> ConnectResult`
  - `digitalocean.resolve(db, settings, account="production")`
  - Test helpers in `tests/do_helpers.py`: fixture `do_cloud` (patches `outbound.transports` with `FakeDigitalOcean`, `FakeSpaces`, `FakeAcme`, `FakeCloudflare`; Tasks 4–5 fill in the last three) and `async configure_account(db, key="development", token=DEV_TOKEN, region="nyc3", renewal=DEV_RENEW_TOKEN)`.

- [ ] **Step 1: Write the test helpers**

Create `sirdar/api/tests/do_helpers.py`:

```python
"""DigitalOcean for tests: the fakes wired into outbound.transports() (one
fixture for every outbound kind a DigitalOcean environment uses) and saved
accounts."""

import pytest

from sirdar_api.config import get_settings
from sirdar_api.deploy import do_accounts, outbound

from .fake_digitalocean import DEV_RENEW_TOKEN, DEV_TOKEN, FakeDigitalOcean


class Cloud:
    """The fakes one test talks to; `smoke` is any MockTransport the test sets."""

    def __init__(self):
        self.do = FakeDigitalOcean()
        self.spaces = None
        self.acme = None
        self.cloudflare = None
        self.smoke = None

    def transports(self) -> dict:
        found = {k: None for k in outbound.KINDS}
        found["digitalocean"] = self.do.transport()
        for kind in ("spaces", "acme", "cloudflare", "smoke"):
            fake = getattr(self, kind)
            if fake is not None:
                found[kind] = fake if not hasattr(fake, "transport") else fake.transport()
        return found


@pytest.fixture
def do_cloud(monkeypatch):
    cloud = Cloud()
    monkeypatch.setattr(outbound, "transports", cloud.transports)
    return cloud


async def configure_account(db, key: str = "development", *, token: str = DEV_TOKEN,
                            region: str = "nyc3", renewal: str | None = DEV_RENEW_TOKEN,
                            label: str | None = None) -> None:
    """Save an account (needs the secrets_key fixture) and commit."""
    await do_accounts.save(db, get_settings(), key, label=label or key.title(), region=region,
                           token=token, renewal_token=renewal)
    await db.commit()
```

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_do_accounts.py`:

```python
"""The two DigitalOcean accounts (Production and Development): tokens and
renewal tokens are write-only and vault-encrypted; the same token can't be
both; a token from another team is refused while environments use the
account; SIRDAR_DEPLOY_DO_TOKEN is the Production account's fallback; the
old /integrations/digitalocean routes act on the Production account."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, DoAccount, DoEnvironment, Environment
from sirdar_api.deploy import do_accounts, integrations
from sirdar_api.deploy.integrations import IntegrationError

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import configure_account, do_cloud  # noqa: F401
from .fake_digitalocean import DEV_RENEW_TOKEN, DEV_TOKEN, DO_TOKEN, RENEW_TOKEN

pytestmark = pytest.mark.usefixtures("secrets_key")
URL = "/api/deploy/integrations/digitalocean/accounts"
TOKENS = (DO_TOKEN, DEV_TOKEN, RENEW_TOKEN, DEV_RENEW_TOKEN)


@pytest.fixture
def no_env_token(monkeypatch):
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "")
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_REGION", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _in_use(db, key: str, team: str | None = "team-dev-0002") -> Environment:
    env = Environment(name="do9", type="dev", target_id="digitalocean",
                      base_domain="do9.serversherpa.com", proxy_ip="172.30.0.2",
                      slots=["orange"])
    db.add(env)
    await db.flush()
    db.add(DoEnvironment(environment_id=env.id, account_key=key, team_uuid=team,
                         region="nyc3", droplet_size="s-2vcpu-4gb", db_size="db-s-2vcpu-4gb",
                         ssh_public_key="ssh-ed25519 x", ssh_private_key_enc=b"k",
                         acme_key_enc=b"a", bucket="ss-do9-00000000"))
    await db.commit()
    return env


async def test_both_accounts_are_always_listed(db, no_env_token):
    view = await do_accounts.public(db, get_settings())
    assert [(a["key"], a["label"], a["configured"]) for a in view] == [
        ("production", "Production", False), ("development", "Development", False)]


async def test_save_load_and_secrets_stay_hidden(db, no_env_token):
    await configure_account(db)
    account = await do_accounts.load(db, get_settings(), "development")
    assert (account.token, account.renewal_token, account.region) == (
        DEV_TOKEN, DEV_RENEW_TOKEN, "nyc3")
    assert DEV_TOKEN not in repr(account) and DEV_RENEW_TOKEN not in repr(account)
    row = await db.get(DoAccount, "development", populate_existing=True)
    assert DEV_TOKEN.encode() not in bytes(row.token_enc)
    view = next(a for a in await do_accounts.public(db, get_settings())
                if a["key"] == "development")
    assert view | {"updated_at": None} == {
        "key": "development", "label": "Development", "region": "nyc3", "configured": True,
        "token_set": True, "source": "stored", "renewal_token_set": True, "team_name": None,
        "environments": [], "updated_at": None, "updated_by_name": None}


async def test_the_environment_token_is_production_only(db, monkeypatch):
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", DO_TOKEN)
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_REGION", "sfo3")
    get_settings.cache_clear()
    try:
        prod = await do_accounts.load(db, get_settings(), "production")
        assert (prod.token, prod.source, prod.region) == (DO_TOKEN, "environment", "sfo3")
        assert await do_accounts.load(db, get_settings(), "development") is None
        with pytest.raises(IntegrationError) as e:
            await do_accounts.require(db, get_settings(), "development")
        assert (e.value.code, e.value.extra) == ("do_account_not_configured",
                                                 {"account": "development"})
    finally:
        get_settings.cache_clear()


async def test_one_token_can_not_be_both_accounts(db, no_env_token):
    await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
    with pytest.raises(IntegrationError) as e:
        await do_accounts.save(db, get_settings(), "development", label="Development",
                               region="nyc3", token=DO_TOKEN)
    assert e.value.code == "do_token_shared"


@pytest.mark.parametrize("field,value,code", [
    ("label", "", "label_invalid"), ("label", "x" * 41, "label_invalid"),
    ("region", "New York", "region_invalid"), ("token", "has space", "do_token_invalid"),
    ("renewal_token", "dop_v1_short", "renewal_token_invalid"),
])
async def test_values_are_checked(db, no_env_token, field, value, code):
    kw = {"label": "Development", "region": "nyc3", "token": DEV_TOKEN, field: value}
    with pytest.raises(IntegrationError) as e:
        await do_accounts.save(db, get_settings(), "development", **kw)
    assert e.value.code == code


async def test_a_token_from_another_team_is_refused_while_in_use(db, no_env_token, do_cloud):
    await configure_account(db)
    await _in_use(db, "development", team="team-dev-0002")
    with pytest.raises(IntegrationError) as e:
        await do_accounts.save(db, get_settings(), "development", label="Development",
                               region="nyc3", token=DO_TOKEN)        # the Production team
    assert (e.value.code, e.value.extra) == ("do_team_changed", {"environments": ["do9"]})
    # A new token for the same team is fine, and the team is remembered.
    other = "dop_v1_" + "77" * 32
    do_cloud.do.tokens[other] = None
    from . import fake_digitalocean
    fake_digitalocean.TEAMS[other] = ("team-dev-0002", "Encon Development")
    try:
        assert await do_accounts.save(db, get_settings(), "development", label="Development",
                                      region="nyc3", token=other) == ["token"]
    finally:
        del fake_digitalocean.TEAMS[other]
    row = await db.get(DoAccount, "development", populate_existing=True)
    assert (row.team_uuid, row.team_name) == ("team-dev-0002", "Encon Development")


async def test_clear_is_refused_while_in_use(db, no_env_token):
    await configure_account(db)
    await _in_use(db, "development")
    with pytest.raises(IntegrationError) as e:
        await do_accounts.clear(db, "development")
    assert (e.value.code, e.value.extra) == ("account_in_use", {"environments": ["do9"]})


async def test_the_integrations_facade_is_the_production_account(db, no_env_token):
    assert await integrations.save(db, get_settings(), "digitalocean", {}, DO_TOKEN,
                                   None) == ["token"]
    await db.commit()
    assert (await integrations.load_digitalocean(db, get_settings())).token == DO_TOKEN
    assert (await do_accounts.load(db, get_settings(), "production")).token == DO_TOKEN
    assert await integrations.is_configured(db, "digitalocean")
    assert (await integrations.public(db, get_settings()))["digitalocean"]["token_set"]
    assert await integrations.remove(db, "digitalocean") is True
    await db.commit()
    assert await do_accounts.load(db, get_settings(), "production") is None


# ---- routes ------------------------------------------------------------------------

async def test_account_routes(client, db, no_env_token, do_cloud):
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/development", headers=h, json={
        "label": "Dev account", "region": "nyc3", "token": DEV_TOKEN,
        "renewal_token": DEV_RENEW_TOKEN})
    assert resp.status_code == 200, resp.text
    dev = resp.json()["accounts"][1]
    assert (dev["label"], dev["token_set"], dev["renewal_token_set"]) == (
        "Dev account", True, True)
    resp = await client.post(f"{URL}/development/test", headers=h)
    assert resp.status_code == 200, resp.text
    checks = {c["label"]: c for c in resp.json()["checks"]}
    assert list(checks) == ["Account", "Team", "Droplets", "Region", "Renewal token"]
    assert checks["Team"]["value"] == "Encon Development"
    assert checks["Renewal token"]["status"] == "pass"
    resp = await client.put(f"{URL}/bogus", headers=h, json={"label": "x", "region": "nyc3"})
    assert resp.status_code == 422
    assert (await client.delete(f"{URL}/development", headers=h)).status_code == 204
    audits = [a.changes for a in await db.scalars(
        select(AuditLog).where(AuditLog.action.like("deploy.do_account%"))
        .order_by(AuditLog.id))]
    assert audits[0] == {"account": "development",
                         "changed": ["label", "region", "token", "renewal_token"]}
    texts = [repr(a) for a in audits] + [resp.text]
    assert not any(t in text for t in TOKENS for text in texts)


async def test_a_renewal_token_that_reads_droplets_warns(client, db, no_env_token, do_cloud):
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/development/test", headers=h, json={
        "label": "Development", "region": "nyc3", "token": DEV_TOKEN,
        "renewal_token": DEV_TOKEN})
    check = next(c for c in resp.json()["checks"] if c["label"] == "Renewal token")
    assert check["status"] == "warn"
    assert "can read droplets" in check["value"]


async def test_account_routes_need_change(client, db, no_env_token):
    viewer = await auth_headers(client, db, email="v@test.example.com", roles=("admin",))
    assert (await client.get(URL, headers=viewer)).status_code == 200
    resp = await client.put(f"{URL}/development", headers=viewer,
                            json={"label": "x", "region": "nyc3"})
    assert resp.status_code == 403
```

In `sirdar/api/tests/test_deploy_digitalocean_integration.py`:
- In `test_save_load_and_the_public_view`, replace the two lines reading `row = await db.get(Integration, "digitalocean")` and `assert row.config == {}` with `row = await db.get(DoAccount, "production", populate_existing=True)`, and change `bytes(row.secret_enc)` to `bytes(row.token_enc)`.
- In `test_an_unreadable_stored_token`, replace `db.add(Integration(kind="digitalocean", config={}, secret_enc=...))` with:

```python
    row = await db.get(DoAccount, "production")
    row.token_enc = Fernet(Fernet.generate_key()).encrypt(STORED.encode())
```

- Import `DoAccount` from `sirdar_api.db.models` (drop `Integration` from that import if nothing else uses it).

- [ ] **Step 3: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_accounts.py`
Expected: FAIL (`cannot import name 'do_accounts'`).

- [ ] **Step 4: Write `do_accounts.py`**

Create `sirdar/api/src/sirdar_api/deploy/do_accounts.py`:

```python
"""The two DigitalOcean accounts Sirdar builds environments in (deploy phase
7): "production" and "development", each with a label, a default region, an
API token and the renewal token droplets get (a custom-scoped token Jimmy
makes by hand in the control panel: certificate create/read/delete and
load_balancer read/update). Both tokens are Fernet-encrypted with
SIRDAR_SECRETS_KEY and write-only. SIRDAR_DEPLOY_DO_TOKEN (and _REGION) stay
the Production account's fallback.

An environment is built in one account and stays there: a token from
another DigitalOcean team is refused while environments use the account, and
the same token can't be both accounts. Errors are IntegrationError (codes
only, never values). Callers audit and commit."""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import DoAccount, DoEnvironment, Environment, User
from sirdar_api.deploy import Check, ConnectFailed, ConnectResult, do_api, integrations, vault
from sirdar_api.deploy.integrations import IntegrationError

KEYS = ("production", "development")
DEFAULT_LABELS = {"production": "Production", "development": "Development"}
_REGION_RE = re.compile(r"[a-z]{3}[0-9]")
_LABEL_BAD = re.compile(r"[\x00-\x1f\x7f]")


@dataclass(frozen=True)
class Account:
    key: str
    label: str
    region: str | None
    team_uuid: str | None
    token: str = field(repr=False)
    renewal_token: str | None = field(default=None, repr=False)
    source: str = "stored"          # "stored" | "environment" (SIRDAR_DEPLOY_DO_TOKEN)


def check_key(key) -> str:
    if key not in KEYS:
        raise IntegrationError("do_account_invalid")
    return key


def check_label(value) -> str:
    label = str(value or "").strip()
    if not 1 <= len(label) <= 40 or _LABEL_BAD.search(label):
        raise IntegrationError("label_invalid")
    return label


def check_region(value) -> str | None:
    region = str(value or "").strip().lower()
    if not region:
        return None
    if not _REGION_RE.fullmatch(region):
        raise IntegrationError("region_invalid")
    return region


def check_token(value, code: str = "do_token_invalid") -> str:
    try:
        return integrations.check_secret("digitalocean", value)
    except IntegrationError:
        raise IntegrationError(code) from None


def _other(key: str) -> str:
    return KEYS[1] if key == KEYS[0] else KEYS[0]


async def _row(db: AsyncSession, key: str) -> DoAccount:
    return await db.get(DoAccount, check_key(key), populate_existing=True)


def _decrypt(settings: Settings, blob: bytes) -> str:
    try:
        return vault.decrypt(settings, blob)
    except vault.SecretsKeyMissing:
        raise IntegrationError("secrets_key_missing") from None
    except vault.SecretUnreadable:
        raise IntegrationError("integration_unreadable", kind="digitalocean") from None


def _env_token(settings: Settings, key: str) -> str | None:
    if key == "production" and settings.deploy_do_token is not None:
        return settings.deploy_do_token.get_secret_value()
    return None


def _region(settings: Settings, row: DoAccount) -> str | None:
    if row.region:
        return row.region
    if row.key == "production":
        return check_region_or_none(settings.deploy_do_region)
    return None


def check_region_or_none(value) -> str | None:
    try:
        return check_region(value)
    except IntegrationError:
        return None


async def has_token(db: AsyncSession, key: str) -> bool:
    return (await _row(db, key)).token_enc is not None


def source_of(row: DoAccount, settings: Settings) -> str | None:
    if row.token_enc is not None:
        return "stored"
    return "environment" if _env_token(settings, row.key) else None


async def load(db: AsyncSession, settings: Settings, key: str) -> Account | None:
    """The account with its tokens decrypted; None when it has no token. A
    stored token that won't decrypt raises IntegrationError: it is never
    silently replaced by SIRDAR_DEPLOY_DO_TOKEN."""
    row = await _row(db, key)
    if row.token_enc is not None:
        token, source = _decrypt(settings, row.token_enc), "stored"
    else:
        token, source = _env_token(settings, key), "environment"
    if token is None:
        return None
    renewal = _decrypt(settings, row.renewal_token_enc) if row.renewal_token_enc else None
    return Account(key=row.key, label=row.label, region=_region(settings, row),
                   team_uuid=row.team_uuid, token=token, renewal_token=renewal, source=source)


async def require(db: AsyncSession, settings: Settings, key: str) -> Account:
    account = await load(db, settings, key)
    if account is None:
        raise IntegrationError("do_account_not_configured", account=key)
    return account


async def in_use(db: AsyncSession, key: str) -> list[str]:
    """Environments built in this account (by name)."""
    return list(await db.scalars(
        select(Environment.name).join(DoEnvironment, DoEnvironment.environment_id == Environment.id)
        .where(DoEnvironment.account_key == key).order_by(Environment.name)))


async def team_of(token: str) -> tuple[str, str | None]:
    """(team uuid, team name) the token answers for; a token without a team
    gets "personal:<account uuid>". ConnectFailed with our copy."""
    try:
        async with do_api.connect(token) as api:
            account = await api.account()
    except do_api.DoError as e:
        raise ConnectFailed(e.reason) from None
    team = account.get("team") if isinstance(account.get("team"), dict) else {}
    uuid = team.get("uuid")
    if isinstance(uuid, str) and uuid:
        name = team.get("name")
        return uuid, name if isinstance(name, str) else None
    return f"personal:{account.get('uuid')}", None


async def _frozen_teams(db: AsyncSession, key: str) -> set[str]:
    return {t for t in await db.scalars(select(DoEnvironment.team_uuid)
                                        .where(DoEnvironment.account_key == key)) if t}


async def save(db: AsyncSession, settings: Settings, key: str, *, label, region,
               token: str | None = None, renewal_token: str | None = None,
               clear_renewal: bool = False, actor_id=None) -> list[str]:
    """Store the label and region, and each token given (None keeps the
    stored one). Returns the names of what changed (tokens as `token` and
    `renewal_token`, never their values). May call DigitalOcean (the team
    check) when environments use the account: ConnectFailed then."""
    key, label, region = check_key(key), check_label(label), check_region(region)
    if token is not None:
        check_token(token)
    if renewal_token is not None:
        check_token(renewal_token, "renewal_token_invalid")
    if (token is not None or renewal_token is not None) and not vault.is_configured(settings):
        raise IntegrationError("secrets_key_missing")
    row = await _row(db, key)
    changed: list[str] = []
    if row.label != label:
        row.label = label
        changed.append("label")
    if row.region != region:
        row.region = region
        changed.append("region")
    if token is not None:
        other = await _row(db, _other(key))
        if ((other.token_enc is not None and _decrypt(settings, other.token_enc) == token)
                or _env_token(settings, _other(key)) == token):
            raise IntegrationError("do_token_shared")
        users = await in_use(db, key)
        if users:
            team, team_name = await team_of(token)
            known = await _frozen_teams(db, key) | ({row.team_uuid} if row.team_uuid else set())
            if known and team not in known:
                raise IntegrationError("do_team_changed", environments=users)
            row.team_uuid, row.team_name = team, team_name
        else:
            # Learned again by Test or the next step 0.
            row.team_uuid = row.team_name = None
        row.token_enc = vault.encrypt(settings, token)
        changed.append("token")
    if renewal_token is not None:
        row.renewal_token_enc = vault.encrypt(settings, renewal_token)
        changed.append("renewal_token")
    elif clear_renewal and row.renewal_token_enc is not None:
        row.renewal_token_enc = None
        changed.append("renewal_token")
    if changed:
        row.updated_by, row.updated_at = actor_id, datetime.now(UTC)
    await db.flush()
    return changed


async def remember_team(db: AsyncSession, key: str, team: str, name: str | None) -> None:
    row = await _row(db, key)
    row.team_uuid, row.team_name = team, name
    await db.flush()


async def clear(db: AsyncSession, key: str) -> bool:
    """Drop both tokens (label and region stay). False when none was stored."""
    users = await in_use(db, key)
    if users:
        raise IntegrationError("account_in_use", environments=users)
    row = await _row(db, key)
    had = row.token_enc is not None
    row.token_enc = row.renewal_token_enc = None
    row.team_uuid = row.team_name = None
    row.updated_at = datetime.now(UTC)
    await db.flush()
    return had


async def public(db: AsyncSession, settings: Settings) -> list[dict]:
    out = []
    for key in KEYS:
        row = await _row(db, key)
        by = await db.get(User, row.updated_by) if row.updated_by else None
        source = source_of(row, settings)
        out.append({"key": key, "label": row.label, "region": _region(settings, row),
                    "configured": source is not None, "token_set": row.token_enc is not None,
                    "source": source, "renewal_token_set": row.renewal_token_enc is not None,
                    "team_name": row.team_name, "environments": await in_use(db, key),
                    "updated_at": row.updated_at, "updated_by_name":
                        by.display_name if by else None})
    return out


async def _status(api: do_api.DigitalOceanApi, path: str) -> int:
    try:
        await api.call("GET", path, params={"per_page": 1})
    except do_api.DoForbidden:
        return 403
    except do_api.DoError as e:
        return e.status or 0
    return 200


async def test(db: AsyncSession, settings: Settings, key: str, *, token: str | None = None,
               renewal_token: str | None = None, region: str | None = None) -> ConnectResult:
    """Read-only checks with the given tokens, else the stored ones:
    Account, Team, Droplets, Region, Renewal token. Facts carry no secret."""
    stored = await load(db, settings, key)
    token = token if token is not None else (stored.token if stored else None)
    if token is None:
        raise IntegrationError("do_account_not_configured", account=key)
    renewal = renewal_token if renewal_token is not None else (
        stored.renewal_token if stored else None)
    region = region if region is not None else (stored.region if stored else None)
    try:
        async with do_api.connect(token) as api:
            account = await api.account()
            count = int((await api.call("GET", "/droplets", params={"per_page": 1}))
                        ["meta"]["total"])
            regions = (await api.call("GET", "/regions", params={"per_page": 200}))["regions"]
    except do_api.DoError as e:
        raise ConnectFailed(e.reason) from None
    except (KeyError, TypeError, ValueError):
        raise ConnectFailed("DigitalOcean sent a response Sirdar didn't understand.") from None
    team = account.get("team") if isinstance(account.get("team"), dict) else {}
    team_name = team.get("name") if isinstance(team.get("name"), str) else None
    limit = int(account.get("droplet_limit") or 0)
    status = str(account.get("status") or "")
    checks = [
        Check("Account", "pass" if status == "active" else "warn",
              f"{account.get('email')} · {status}"),
        Check("Team", "pass" if team_name else "warn", team_name or "No team"),
        Check("Droplets", "pass" if count < limit else "warn", f"{count} of {limit}"),
    ]
    match = next((r for r in regions if isinstance(r, dict) and r.get("slug") == region), None)
    if region is None:
        checks.append(Check("Region", "warn", "Not set"))
    else:
        ok = bool(match and match.get("available"))
        checks.append(Check("Region", "pass" if ok else "fail",
                            f"{region} available" if ok else f"{region} not available"))
    if renewal is None:
        checks.append(Check("Renewal token", "warn",
                            "Not set: Sirdar can't build environments in this account yet."))
    else:
        async with do_api.connect(renewal) as api:
            certs = await _status(api, "/certificates")
            lbs = await _status(api, "/load_balancers")
            droplets = await _status(api, "/droplets")
        if certs != 200 or lbs != 200:
            checks.append(Check("Renewal token", "fail",
                                "It can't read certificates and load balancers."))
        elif droplets == 200:
            checks.append(Check("Renewal token", "warn",
                                "It can read droplets; give it only the certificate and load "
                                "balancer scopes."))
        else:
            checks.append(Check("Renewal token", "pass", "Certificates and load balancers only"))
    facts = {"email": account.get("email"), "team_name": team_name, "region": region,
             "droplet_count": count, "droplet_limit": limit}
    return ConnectResult(ok=True, target="digitalocean", checks=checks, facts=facts)


test.__test__ = False   # not a pytest test, despite the name
```

- [ ] **Step 5: Make `integrations`' `digitalocean` a facade**

In `sirdar/api/src/sirdar_api/deploy/integrations.py`:

1. Docstring: replace "and the DigitalOcean API token (SIRDAR_DEPLOY_DO_TOKEN is its fallback when none is stored)" with "and (since phase 7) a facade over the Production DigitalOcean account in do_accounts (SIRDAR_DEPLOY_DO_TOKEN is its fallback)".
2. Replace `load_digitalocean` and `digitalocean_source`:

```python
async def load_digitalocean(db: AsyncSession, settings: Settings) -> DigitalOceanConfig | None:
    """The Production account's token (do_accounts): the stored one, else
    SIRDAR_DEPLOY_DO_TOKEN; None when neither is set."""
    from sirdar_api.deploy import do_accounts
    account = await do_accounts.load(db, settings, "production")
    if account is None:
        return None
    return DigitalOceanConfig(token=account.token, source=account.source)


async def digitalocean_source(db: AsyncSession, settings: Settings) -> str | None:
    from sirdar_api.db.models import DoAccount
    from sirdar_api.deploy import do_accounts
    row = await db.get(DoAccount, "production", populate_existing=True)
    return do_accounts.source_of(row, settings)
```

3. At the top of `is_configured`, `save`, `remove`, `candidate`, `in_use` add a DigitalOcean branch:

```python
async def is_configured(db: AsyncSession, kind: str) -> bool:
    if kind == "digitalocean":
        from sirdar_api.deploy import do_accounts
        return await do_accounts.has_token(db, "production")
    ...
```

```python
async def in_use(db: AsyncSession, kind: str) -> list[str]:
    if kind == "digitalocean":
        from sirdar_api.deploy import do_accounts
        return await do_accounts.in_use(db, "production")
    ...
```

```python
async def candidate(db, settings, kind, values, secret) -> Config:
    if kind == "digitalocean":
        if secret is not None:
            return DigitalOceanConfig(token=check_secret(kind, secret))
        from sirdar_api.deploy import do_accounts
        if not await do_accounts.has_token(db, "production"):
            raise IntegrationError("secret_required")
        return await load_digitalocean(db, settings)
    ...
```

```python
async def save(db, settings, kind, values, secret, actor_id) -> list[str]:
    if kind == "digitalocean":
        from sirdar_api.deploy import do_accounts
        row = await db.get(DoAccount, "production", populate_existing=True)
        if secret is None:
            if row.token_enc is None:
                raise IntegrationError("secret_required")
            return []
        return [c for c in await do_accounts.save(
            db, settings, "production", label=row.label, region=row.region, token=secret,
            actor_id=actor_id) if c == "token"]
    ...
```

```python
async def remove(db: AsyncSession, kind: str) -> bool:
    if kind == "digitalocean":
        from sirdar_api.deploy import do_accounts
        return await do_accounts.clear(db, "production")
    ...
```

Import `DoAccount` from `sirdar_api.db.models` at the top. In `public()`, replace the `if kind == "digitalocean":` block's body with:

```python
        if kind == "digitalocean":                 # the Production account (do_accounts)
            account = await db.get(DoAccount, "production", populate_existing=True)
            by = await db.get(User, account.updated_by) if account.updated_by else None
            source = await digitalocean_source(db, settings)
            out[kind] = {"configured": source is not None,
                         "token_set": account.token_enc is not None, "source": source,
                         "updated_at": account.updated_at if account.token_enc else None,
                         "updated_by_name": by.display_name if by else None}
            continue
```

and move that block to the top of the loop body (before `row = await _row(db, kind)`), so `_row` is never read for `digitalocean`.

- [ ] **Step 6: `resolve` takes the account**

In `sirdar/api/src/sirdar_api/deploy/digitalocean.py`, replace `resolve`:

```python
async def resolve(db: AsyncSession, settings: Settings, account: str = "production") -> Settings:
    """settings with the token of the given DigitalOcean account (do_accounts;
    the Production account falls back to SIRDAR_DEPLOY_DO_TOKEN), else none.
    IntegrationError when a stored token can't be decrypted."""
    from sirdar_api.deploy import do_accounts
    found = await do_accounts.load(db, settings, account)
    resolved = with_token(settings, found.token if found else None)
    if found is not None and found.region:
        resolved = resolved.model_copy(update={"deploy_do_region": found.region})
    return resolved
```

- [ ] **Step 7: The account routes**

In `sirdar/api/src/sirdar_api/api/routes/integrations.py`, import `do_accounts` from `sirdar_api.deploy`, and add after `check_digitalocean`:

```python
# ---- DigitalOcean accounts (deploy phase 7) ----------------------------------------

class DoAccountIn(BaseModel):
    label: str = Field(max_length=80)
    region: str | None = Field(default=None, max_length=20)
    token: str | None = None
    renewal_token: str | None = None
    clear_renewal_token: bool = False


async def _accounts_out(db) -> dict:
    return {"accounts": await do_accounts.public(db, get_settings())}


@router.get("/digitalocean/accounts")
async def read_do_accounts(db: DbSession,
                           actor: AuthContext = require_permission("deploy", "view")):
    return await _accounts_out(db)


@router.put("/digitalocean/accounts/{key}")
async def save_do_account(key: str, body: DoAccountIn, request: Request, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "change")):
    try:
        changed = await do_accounts.save(
            db, get_settings(), key, label=body.label, region=body.region, token=body.token,
            renewal_token=body.renewal_token, clear_renewal=body.clear_renewal_token,
            actor_id=actor.user.person_id)
    except IntegrationError as e:
        await db.rollback()
        raise _http(e) from None
    except ConnectFailed as e:
        await db.rollback()
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    if changed:
        audit(db, actor_id=actor.user.person_id, action="deploy.do_account_update",
              entity_type="do_account", entity_id=key, ip=client_ip(request),
              changes={"account": key, "changed": changed})
    await db.commit()
    return await _accounts_out(db)


@router.post("/digitalocean/accounts/{key}/test")
async def test_do_account(key: str, request: Request, db: DbSession,
                          body: DoAccountIn | None = None,
                          actor: AuthContext = require_permission("deploy", "change")):
    settings = get_settings()
    try:
        do_accounts.check_key(key)
        if body is not None:
            if body.token is not None:
                do_accounts.check_token(body.token)
            if body.renewal_token is not None:
                do_accounts.check_token(body.renewal_token, "renewal_token_invalid")
            region = do_accounts.check_region(body.region)
        else:
            region = None
        result = await do_accounts.test(
            db, settings, key, token=body.token if body else None,
            renewal_token=body.renewal_token if body else None, region=region)
    except IntegrationError as e:
        raise _http(e) from None
    except ConnectFailed as e:
        audit(db, actor_id=actor.user.person_id, action="deploy.do_account_test",
              entity_type="do_account", entity_id=key, ip=client_ip(request),
              changes={"account": key, "ok": False})
        await db.commit()
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    if body is None or body.token is None:      # the stored token: remember its team
        team_name = result.facts.get("team_name")
        if team_name and not await do_accounts.in_use(db, key):
            team, _ = await do_accounts.team_of(
                (await do_accounts.require(db, settings, key)).token)
            await do_accounts.remember_team(db, key, team, team_name)
    audit(db, actor_id=actor.user.person_id, action="deploy.do_account_test",
          entity_type="do_account", entity_id=key, ip=client_ip(request),
          changes={"account": key, "ok": True})
    await db.commit()
    return result.as_dict()


@router.delete("/digitalocean/accounts/{key}", status_code=204)
async def clear_do_account(key: str, request: Request, db: DbSession,
                           actor: AuthContext = require_permission("deploy", "change")):
    try:
        do_accounts.check_key(key)
        await do_accounts.clear(db, key)
    except IntegrationError as e:
        await db.rollback()
        raise _http(e) from None
    audit(db, actor_id=actor.user.person_id, action="deploy.do_account_clear",
          entity_type="do_account", entity_id=key, ip=client_ip(request),
          changes={"account": key})
    await db.commit()
    return Response(status_code=204)
```

Add the new codes to `_STATUS`: `"do_token_shared": 409, "do_team_changed": 409, "account_in_use": 409, "do_account_not_configured": 409`. These routes are registered on the same router as `/{kind}`; FastAPI matches `/digitalocean/accounts` before `DELETE /{kind}` only for paths with more segments, so no reordering is needed (the `/{kind}` routes have one segment).

- [ ] **Step 8: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_accounts.py tests/test_deploy_digitalocean_integration.py tests/test_deploy_integrations.py tests/test_deploy_integrations_api.py tests/test_dashboard_api.py tests/test_deploy_api.py`
Expected: all PASS.

- [ ] **Step 9: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/do_accounts.py src/sirdar_api/deploy/integrations.py src/sirdar_api/deploy/digitalocean.py src/sirdar_api/api/routes/integrations.py tests/do_helpers.py tests/test_deploy_do_accounts.py tests/test_deploy_digitalocean_integration.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/do_accounts.py sirdar/api/src/sirdar_api/deploy/integrations.py sirdar/api/src/sirdar_api/deploy/digitalocean.py sirdar/api/src/sirdar_api/api/routes/integrations.py sirdar/api/tests/do_helpers.py sirdar/api/tests/test_deploy_do_accounts.py sirdar/api/tests/test_deploy_digitalocean_integration.py
git commit -m "feat(sirdar): two DigitalOcean accounts with renewal tokens and the team check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Spaces — SigV4 and buckets

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/s3sig.py`, `sirdar/api/src/sirdar_api/deploy/spaces.py`
- Create: `sirdar/api/tests/fake_spaces.py`, `sirdar/api/tests/test_deploy_spaces.py`
- Modify: `sirdar/api/tests/do_helpers.py` (`Cloud.spaces` defaults to a `FakeSpaces` over `Cloud.do`)

**Interfaces:**
- Produces:
  - `s3sig.sign(*, method, host, path, query: dict[str, str], headers: dict[str, str], payload_sha256: str, access_key: str, secret_key: str, region: str, now: datetime, service="s3") -> dict[str, str]` — the headers to send (the given ones plus `x-amz-date`, `x-amz-content-sha256`, `Authorization`).
  - `s3sig.EMPTY_SHA256`.
  - `spaces.SpacesKey(access_key, secret_key)` (secret `repr=False`), `spaces.SpacesError(reason)`.
  - `spaces.endpoint(region) -> "https://<region>.digitaloceanspaces.com"`.
  - async `spaces.create_bucket(bucket, region, key) -> bool` (True: made now; False: already Sirdar's), `spaces.bucket_exists(...) -> bool`, `spaces.empty_bucket(...) -> int` (objects deleted), `spaces.delete_bucket(...) -> bool` (False: already gone). Each takes `transport=None` (→ `outbound.transports()["spaces"]`) and `now=None`.
  - Test fake: `FakeSpaces(do_fake)` with `.buckets: dict[str, dict[str, bytes]]`, `.put(bucket, key, data)`, `.page_size`, `.transport()`.

- [ ] **Step 1: Write the fake**

Create `sirdar/api/tests/fake_spaces.py`:

```python
"""A stand-in for the DigitalOcean Spaces S3 calls deploy/spaces.py makes
(virtual-hosted: <bucket>.<region>.digitaloceanspaces.com): create, HEAD,
list (v2, paged), multi-object delete and delete. A request must carry a
SigV4 Authorization whose access key is a Spaces key FakeDigitalOcean
issued, and the key's grants must cover the bucket."""

import base64
import hashlib
import re
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

import httpx

NS = "http://s3.amazonaws.com/doc/2006-03-01/"
_CRED_RE = re.compile(r"AWS4-HMAC-SHA256 Credential=([^/]+)/")


def _xml_error(status: int, code: str) -> httpx.Response:
    return httpx.Response(status, content=f"<Error><Code>{code}</Code></Error>".encode(),
                          headers={"content-type": "application/xml"})


class FakeSpaces:
    def __init__(self, do_fake):
        self.do = do_fake
        self.buckets: dict[str, dict[str, bytes]] = {}
        self.requests: list[httpx.Request] = []
        self.page_size = 1000
        self.down = False

    def put(self, bucket: str, key: str, data: bytes) -> None:
        self.buckets.setdefault(bucket, {})[key] = data

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def _allowed(self, access_key: str, bucket: str) -> bool:
        key = self.do.keys.get(access_key)
        if key is None:
            return False
        return any(g["permission"] == "fullaccess" or g["bucket"] == bucket for g in key["grants"])

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        host = request.url.host
        bucket = host.split(".", 1)[0]
        auth = _CRED_RE.match(request.headers.get("authorization", ""))
        if auth is None or not self._allowed(auth.group(1), bucket):
            return _xml_error(403, "AccessDenied")
        if "x-amz-date" not in request.headers or "x-amz-content-sha256" not in request.headers:
            return _xml_error(400, "AuthorizationHeaderMalformed")
        method, path, params = request.method, request.url.path, request.url.params
        if path == "/" and method == "PUT":
            if bucket in self.buckets:
                return _xml_error(409, "BucketAlreadyOwnedByYou")
            self.buckets[bucket] = {}
            return httpx.Response(200)
        if bucket not in self.buckets:
            return _xml_error(404, "NoSuchBucket")
        objects = self.buckets[bucket]
        if path == "/" and method == "HEAD":
            return httpx.Response(200)
        if path == "/" and method == "GET" and params.get("list-type") == "2":
            keys = sorted(objects)
            start = int(params.get("continuation-token") or 0)
            page = keys[start:start + self.page_size]
            more = start + self.page_size < len(keys)
            body = [f'<ListBucketResult xmlns="{NS}"><IsTruncated>{str(more).lower()}'
                    "</IsTruncated>"]
            body += [f"<Contents><Key>{escape(k)}</Key><Size>{len(objects[k])}</Size></Contents>"
                     for k in page]
            if more:
                body.append(f"<NextContinuationToken>{start + self.page_size}"
                            "</NextContinuationToken>")
            body.append("</ListBucketResult>")
            return httpx.Response(200, content="".join(body).encode())
        if path == "/" and method == "POST" and "delete" in params:
            md5 = base64.b64encode(hashlib.md5(request.content).digest()).decode()
            if request.headers.get("content-md5") != md5:
                return _xml_error(400, "InvalidDigest")
            root = ET.fromstring(request.content)
            for key in root.iter("Key"):
                objects.pop(key.text, None)
            return httpx.Response(200, content=f'<DeleteResult xmlns="{NS}"/>'.encode())
        if path == "/" and method == "DELETE":
            if objects:
                return _xml_error(409, "BucketNotEmpty")
            del self.buckets[bucket]
            return httpx.Response(204)
        return _xml_error(405, "MethodNotAllowed")
```

In `sirdar/api/tests/do_helpers.py`, in `Cloud.__init__`, set `self.spaces = FakeSpaces(self.do)` (import it from `.fake_spaces`).

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_spaces.py`:

```python
"""SigV4 (checked against AWS's published examples) and the bucket calls
against FakeSpaces."""

from datetime import UTC, datetime

import httpx
import pytest

from sirdar_api.deploy import s3sig, spaces
from sirdar_api.deploy.spaces import SpacesError, SpacesKey

from .fake_digitalocean import FakeDigitalOcean
from .fake_spaces import FakeSpaces

AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
AWS_NOW = datetime(2013, 5, 24, tzinfo=UTC)


def _signature(headers: dict) -> str:
    return headers["Authorization"].rsplit("Signature=", 1)[1]


def test_sigv4_get_object_example():
    """AWS S3 docs, "Signature Calculations for the Authorization Header:
    Transferring Payload in a Single Chunk", example "GET Object". If this
    fails, compare each string with that page before changing the signer."""
    headers = s3sig.sign(method="GET", host="examplebucket.s3.amazonaws.com", path="/test.txt",
                         query={}, headers={"Range": "bytes=0-9"},
                         payload_sha256=s3sig.EMPTY_SHA256, access_key=AWS_KEY,
                         secret_key=AWS_SECRET, region="us-east-1", now=AWS_NOW)
    assert _signature(headers) == \
        "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    assert headers["Authorization"].startswith(
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ")


def test_sigv4_list_objects_example():
    """The same page's "GET Bucket (List Objects)" example."""
    headers = s3sig.sign(method="GET", host="examplebucket.s3.amazonaws.com", path="/",
                         query={"max-keys": "2", "prefix": "J"}, headers={},
                         payload_sha256=s3sig.EMPTY_SHA256, access_key=AWS_KEY,
                         secret_key=AWS_SECRET, region="us-east-1", now=AWS_NOW)
    assert _signature(headers) == \
        "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"


@pytest.fixture
def fakes():
    do = FakeDigitalOcean()
    return do, FakeSpaces(do)


def _key(do, name: str, grants: list[dict]) -> SpacesKey:
    made = do.keys.setdefault(f"DO00{name.upper()}", {
        "name": name, "access_key": f"DO00{name.upper()}", "secret_key": f"secret-{name}",
        "grants": grants})
    return SpacesKey(made["access_key"], made["secret_key"])


async def test_create_empty_delete(fakes):
    do, fake = fakes
    setup = _key(do, "setup", [{"bucket": "", "permission": "fullaccess"}])
    t = fake.transport()
    assert await spaces.create_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) is True
    assert await spaces.create_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) is False
    assert await spaces.bucket_exists("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t)
    fake.page_size = 2
    for i in range(5):
        fake.put("ss-uat9-0a1b2c3d", f"photos/{i}&<x>.jpg", b"x")
    assert await spaces.empty_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) == 5
    assert await spaces.delete_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) is True
    assert await spaces.delete_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) is False
    assert not await spaces.bucket_exists("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t)
    first = fake.requests[0]
    assert first.url.host == "ss-uat9-0a1b2c3d.nyc3.digitaloceanspaces.com"
    assert "secret-setup" not in str(first.headers)


async def test_a_bucket_scoped_key_reaches_only_its_bucket(fakes):
    do, fake = fakes
    app = _key(do, "app", [{"bucket": "ss-uat9-0a1b2c3d", "permission": "readwrite"}])
    fake.buckets["other"] = {}
    with pytest.raises(SpacesError) as err:
        await spaces.bucket_exists("other", "nyc3", app, transport=fake.transport())
    assert err.value.reason == "Spaces refused the key (AccessDenied)."


async def test_a_taken_name_is_our_copy(fakes):
    do, fake = fakes
    setup = _key(do, "setup", [{"bucket": "", "permission": "fullaccess"}])

    def taken(request):
        return httpx.Response(409, content=b"<Error><Code>BucketAlreadyExists</Code></Error>")

    with pytest.raises(SpacesError) as err:
        await spaces.create_bucket("ss-uat9-0a1b2c3d", "nyc3", setup,
                                   transport=httpx.MockTransport(taken))
    assert err.value.reason == "Another Spaces account already has the bucket ss-uat9-0a1b2c3d."
    assert repr(setup).count("secret-setup") == 0
```

- [ ] **Step 3: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_spaces.py`
Expected: FAIL (`cannot import name 's3sig'`).

- [ ] **Step 4: Write the signer**

Create `sirdar/api/src/sirdar_api/deploy/s3sig.py`:

```python
"""AWS Signature Version 4 for the few S3 calls Sirdar makes to DigitalOcean
Spaces (deploy phase 7: create, list, empty and delete a bucket). Sirdar has
no boto3: it would bypass the httpx transports tests replace. Pure functions;
the secret only feeds the HMAC chain and is never returned."""

import hashlib
import hmac
from datetime import datetime
from urllib.parse import quote

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
ALGORITHM = "AWS4-HMAC-SHA256"


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _signing_key(secret_key: str, date: str, region: str, service: str) -> bytes:
    k = _hmac(("AWS4" + secret_key).encode(), date)
    k = _hmac(k, region)
    k = _hmac(k, service)
    return _hmac(k, "aws4_request")


def _encode(value: str) -> str:
    return quote(value, safe="-_.~")


def canonical_query(query: dict[str, str]) -> str:
    return "&".join(f"{_encode(k)}={_encode(v)}" for k, v in sorted(query.items()))


def sign(*, method: str, host: str, path: str, query: dict[str, str], headers: dict[str, str],
         payload_sha256: str, access_key: str, secret_key: str, region: str, now: datetime,
         service: str = "s3") -> dict[str, str]:
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    canon = {k.lower(): " ".join(str(v).split()) for k, v in headers.items()}
    canon |= {"host": host, "x-amz-date": amz_date, "x-amz-content-sha256": payload_sha256}
    names = sorted(canon)
    signed = ";".join(names)
    request = "\n".join([method, quote(path, safe="/-_.~"), canonical_query(query),
                         "".join(f"{n}:{canon[n]}\n" for n in names), signed, payload_sha256])
    scope = f"{date}/{region}/{service}/aws4_request"
    to_sign = "\n".join([ALGORITHM, amz_date, scope,
                         hashlib.sha256(request.encode()).hexdigest()])
    signature = hmac.new(_signing_key(secret_key, date, region, service), to_sign.encode(),
                         hashlib.sha256).hexdigest()
    return {**headers, "x-amz-date": amz_date, "x-amz-content-sha256": payload_sha256,
            "Authorization": f"{ALGORITHM} Credential={access_key}/{scope}, "
                             f"SignedHeaders={signed}, Signature={signature}"}
```

- [ ] **Step 5: Write the bucket calls**

Create `sirdar/api/src/sirdar_api/deploy/spaces.py`:

```python
"""DigitalOcean Spaces buckets through the S3 API (deploy phase 7): the API
v2 can't make buckets. Virtual-hosted addressing
(<bucket>.<region>.digitaloceanspaces.com), SigV4 with the region slug as
the signing region. Errors are SpacesError with our own copy; an S3 error
<Code> may be named. The transport comes from outbound.transports()."""

import base64
import hashlib
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

import httpx

from sirdar_api.deploy import outbound, s3sig

TIMEOUT = 60
MAX_PAGES = 10_000
_CODE_RE = re.compile(r"<Code>([A-Za-z]{1,60})</Code>")
_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


class SpacesError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class SpacesKey:
    access_key: str
    secret_key: str = field(repr=False)


def endpoint(region: str) -> str:
    return f"https://{region}.digitaloceanspaces.com"


def _host(bucket: str, region: str) -> str:
    return f"{bucket}.{region}.digitaloceanspaces.com"


def _code(resp: httpx.Response) -> str | None:
    found = _CODE_RE.search(resp.text or "")
    return found.group(1) if found else None


async def _send(method: str, bucket: str, region: str, key: SpacesKey, *,
                query: dict[str, str] | None = None, body: bytes = b"",
                headers: dict[str, str] | None = None, transport=None,
                now: datetime | None = None) -> httpx.Response:
    if transport is None:
        transport = outbound.transports().get("spaces")
    host = _host(bucket, region)
    query = query or {}
    signed = s3sig.sign(method=method, host=host, path="/", query=query,
                        headers=headers or {}, payload_sha256=hashlib.sha256(body).hexdigest(),
                        access_key=key.access_key, secret_key=key.secret_key, region=region,
                        now=now or datetime.now(UTC))
    url = f"https://{host}/"
    if query:
        url += "?" + s3sig.canonical_query(query)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport) as client:
            resp = await client.request(method, url, content=body, headers=signed)
    except httpx.HTTPError:
        raise SpacesError("Couldn't reach DigitalOcean Spaces.") from None
    if resp.status_code == 403:
        raise SpacesError(f"Spaces refused the key ({_code(resp) or 'HTTP 403'}).")
    return resp


def _refused(resp: httpx.Response) -> SpacesError:
    code = _code(resp)
    return SpacesError(f"Spaces refused the request ({code or f'HTTP {resp.status_code}'}).")


async def create_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    resp = await _send("PUT", bucket, region, key, transport=transport, now=now)
    if resp.status_code == 200:
        return True
    if resp.status_code == 409 and _code(resp) == "BucketAlreadyOwnedByYou":
        return False
    if resp.status_code == 409:
        raise SpacesError(f"Another Spaces account already has the bucket {bucket}.")
    raise _refused(resp)


async def bucket_exists(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    resp = await _send("HEAD", bucket, region, key, transport=transport, now=now)
    if resp.status_code == 200:
        return True
    if resp.status_code == 404:
        return False
    raise _refused(resp)


async def empty_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                       now: datetime | None = None) -> int:
    """Delete every object, a page (up to 1,000) at a time."""
    deleted = 0
    for _ in range(MAX_PAGES):
        resp = await _send("GET", bucket, region, key, query={"list-type": "2"},
                           transport=transport, now=now)
        if resp.status_code == 404:
            return deleted
        if resp.status_code != 200:
            raise _refused(resp)
        try:
            root = ET.fromstring(resp.content)
        except ET.ParseError:
            raise SpacesError("Spaces sent a listing Sirdar didn't understand.") from None
        keys = [k.text or "" for k in root.iter(f"{_NS}Key")] or \
               [k.text or "" for k in root.iter("Key")]
        if not keys:
            return deleted
        doc = ("<Delete><Quiet>true</Quiet>"
               + "".join(f"<Object><Key>{escape(k)}</Key></Object>" for k in keys)
               + "</Delete>").encode()
        md5 = base64.b64encode(hashlib.md5(doc).digest()).decode()
        resp = await _send("POST", bucket, region, key, query={"delete": ""}, body=doc,
                           headers={"Content-MD5": md5, "Content-Type": "application/xml"},
                           transport=transport, now=now)
        if resp.status_code != 200:
            raise _refused(resp)
        deleted += len(keys)
    raise SpacesError("The bucket has more objects than Sirdar deletes in one step.")


async def delete_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    resp = await _send("DELETE", bucket, region, key, transport=transport, now=now)
    if resp.status_code in (200, 204):
        return True
    if resp.status_code == 404:
        return False
    raise _refused(resp)
```

Note the listing re-lists from the start after every delete (no continuation token): deleted keys are gone, so the next page is the rest. `FakeSpaces.page_size = 2` in the test proves it loops.

- [ ] **Step 6: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_spaces.py`
Expected: all PASS. If a SigV4 vector fails, recheck the canonical request (the `Range` header and the trailing newline after the header block) against the AWS page before touching the expected values.

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/s3sig.py src/sirdar_api/deploy/spaces.py tests/fake_spaces.py tests/test_deploy_spaces.py tests/do_helpers.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/s3sig.py sirdar/api/src/sirdar_api/deploy/spaces.py sirdar/api/tests/fake_spaces.py sirdar/api/tests/test_deploy_spaces.py sirdar/api/tests/do_helpers.py
git commit -m "feat(sirdar): Spaces buckets through SigV4, and FakeSpaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: ACME, Cloudflare TXT records and certificates

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/acme.py` (7b copies it byte-for-byte into the api)
- Create: `sirdar/api/src/sirdar_api/deploy/certs.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/cloudflare.py` (`create_record`)
- Modify: `sirdar/api/src/sirdar_api/config.py` (`acme_directory`, `acme_staging_directory`)
- Create: `sirdar/api/tests/fake_acme.py`, `sirdar/api/tests/test_deploy_acme.py`
- Modify: `sirdar/api/tests/do_helpers.py` (`Cloud.cloudflare` = a `FakeCloudflare`, `Cloud.acme` = a `FakeAcme` over it)

**Interfaces:**
- Consumes: `FakeCloudflare` (`tests/fake_cloudflare.py`), `integration_helpers.configure`, `AcmeAccount` (Task 1).
- Produces:
  - `acme.AcmeClient(directory_url, account_key_pem, *, kid=None, transport=None, sleep=asyncio.sleep, poll=POLL_SECONDS, tries=POLL_TRIES)` (async context manager; `.kid`, `.key`), `acme.issue(client, names, challenge_type, solve) -> Issued`, `acme.Issued(key_pem, leaf_pem, chain_pem, not_after, names)`, `acme.AcmeError(reason)`, `acme.new_key_pem()`, `acme.key_authorization(token, key)`, `acme.dns01_value(key_auth)`, `acme.thumbprint(key)`, `acme.jwk(key)`, `acme.make_csr(names)`, `acme.split_chain(pem)`, `acme.LETSENCRYPT`, `acme.LETSENCRYPT_STAGING`, and the type `Solver = Callable[[str, str, str, str], AbstractAsyncContextManager[None]]`.
  - `Cloudflare.create_record(type_, name, content, *, proxied=False, comment) -> DnsRecord` (`create_a` calls it).
  - `certs.SIRDAR_RENEW_DAYS = 14`, `certs.WORKER_RENEW_DAYS = 30`, `certs.DNS_WAIT = 15`, `certs.PUBLIC_SERVICES`, `certs.public_names(base_domain) -> tuple[str, ...]`, `certs.cert_name(env_name, now) -> str`, `certs.is_ours(cert: dict, env_name, names) -> bool`, `certs.not_after(cert: dict) -> datetime | None`, `certs.days_left(when, now) -> float`, `async certs.issue_dns01(settings, *, names, directory, cloudflare, out, sleep=asyncio.sleep, dns_wait=DNS_WAIT, poll=acme.POLL_SECONDS) -> acme.Issued`, `certs.CertError(reason)`.
  - `Settings.acme_directory` (default Let's Encrypt production), `Settings.acme_staging_directory`.
  - Test fake: `FakeAcme(cloudflare=None, http_fetch=None)` with `.directory_url`, `.transport()`, `.new_accounts`, `.bad_nonce_once`, `.fail_validation`, `.issued` (list of `x509.Certificate`).

- [ ] **Step 1: Settings**

In `sirdar/api/src/sirdar_api/config.py`, add after `snapshots_dir`:

```python
    # Let's Encrypt for DigitalOcean environments (deploy phase 7); an
    # environment created with acme_staging uses the staging directory.
    acme_directory: str = "https://acme-v02.api.letsencrypt.org/directory"
    acme_staging_directory: str = "https://acme-staging-v02.api.letsencrypt.org/directory"
```

- [ ] **Step 2: Cloudflare TXT records**

In `sirdar/api/src/sirdar_api/deploy/cloudflare.py`, replace `create_a` with:

```python
    async def create_record(self, type_: str, name: str, content: str, *, proxied: bool = False,
                            comment: str) -> DnsRecord:
        zone = await self.zone_id()
        body = await self._call("POST", f"/zones/{zone}/dns_records", json={
            "type": type_, "name": name, "content": content, "ttl": 1, "proxied": proxied,
            "comment": comment})
        return _record(body.get("result"))

    async def create_a(self, name: str, content: str, *, proxied: bool,
                       comment: str) -> DnsRecord:
        return await self.create_record("A", name, content, proxied=proxied, comment=comment)
```

- [ ] **Step 3: Write the fake ACME directory**

Create `sirdar/api/tests/fake_acme.py`:

```python
"""A stand-in ACME (RFC 8555) directory for deploy/acme.py: JWS signatures
are checked (ES256; jwk for a new account, kid after), nonces are
single-use, DNS-01 is answered from a FakeCloudflare's TXT records and
HTTP-01 through http_fetch(name, token) -> str | None, and certificates come
from a test CA."""

import base64
import hashlib
import itertools
import json
from datetime import UTC, datetime, timedelta

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.x509.oid import NameOID

BASE = "https://acme.test"


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _thumb(jwk: dict) -> str:
    canon = json.dumps({k: jwk[k] for k in ("crv", "kty", "x", "y")}, sort_keys=True,
                       separators=(",", ":"))
    return _b64(hashlib.sha256(canon.encode()).digest())


def _verify(jwk: dict, signing_input: bytes, sig: bytes) -> bool:
    pub = ec.EllipticCurvePublicNumbers(int.from_bytes(_unb64(jwk["x"]), "big"),
                                        int.from_bytes(_unb64(jwk["y"]), "big"),
                                        ec.SECP256R1()).public_key()
    try:
        pub.verify(encode_dss_signature(int.from_bytes(sig[:32], "big"),
                                        int.from_bytes(sig[32:], "big")),
                   signing_input, ec.ECDSA(hashes.SHA256()))
    except Exception:  # noqa: BLE001 — any failure is a bad signature
        return False
    return True


class FakeAcme:
    def __init__(self, *, cloudflare=None, http_fetch=None, days: int = 90):
        self.cloudflare = cloudflare
        self.http_fetch = http_fetch
        self.days = days
        self.ca_key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Fake ACME CA")])
        now = datetime.now(UTC)
        self.ca_cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                        .public_key(self.ca_key.public_key())
                        .serial_number(x509.random_serial_number())
                        .not_valid_before(now - timedelta(days=1))
                        .not_valid_after(now + timedelta(days=3650))
                        .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
                        .sign(self.ca_key, hashes.SHA256()))
        self.nonces: set[str] = set()
        self.accounts: dict[str, dict] = {}
        self.orders: dict[str, dict] = {}
        self.authzs: dict[str, dict] = {}
        self.certs: dict[str, str] = {}
        self.issued: list[x509.Certificate] = []
        self.requests: list[httpx.Request] = []
        self.new_accounts = 0
        self.bad_nonce_once = False
        self.fail_validation = False
        self._ids = itertools.count(1)

    @property
    def directory_url(self) -> str:
        return f"{BASE}/directory"

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def _nonce(self) -> str:
        n = f"nonce-{next(self._ids)}"
        self.nonces.add(n)
        return n

    def _problem(self, status: int, type_: str, detail: str = "") -> httpx.Response:
        return httpx.Response(status, json={"type": f"urn:ietf:params:acme:error:{type_}",
                                            "detail": detail or type_},
                              headers={"Replay-Nonce": self._nonce(),
                                       "Content-Type": "application/problem+json"})

    def _json(self, status: int, body: dict, location: str | None = None) -> httpx.Response:
        headers = {"Replay-Nonce": self._nonce()}
        if location:
            headers["Location"] = location
        return httpx.Response(status, json=body, headers=headers)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/directory":
            return httpx.Response(200, json={"newNonce": f"{BASE}/new-nonce",
                                             "newAccount": f"{BASE}/new-account",
                                             "newOrder": f"{BASE}/new-order"})
        if path == "/new-nonce":
            return httpx.Response(200, headers={"Replay-Nonce": self._nonce()})
        if request.method != "POST":
            return self._problem(405, "malformed")
        jws = json.loads(request.content)
        protected = json.loads(_unb64(jws["protected"]))
        if self.bad_nonce_once:
            self.bad_nonce_once = False
            return self._problem(400, "badNonce", "SECRET-DETAIL bad nonce")
        if protected.get("nonce") not in self.nonces:
            return self._problem(400, "badNonce")
        self.nonces.discard(protected["nonce"])
        if protected.get("url") != str(request.url):
            return self._problem(401, "unauthorized")
        if "jwk" in protected:
            if path != "/new-account":
                return self._problem(400, "malformed")
            account_jwk = protected["jwk"]
        else:
            account_jwk = self.accounts.get(protected.get("kid"))
            if account_jwk is None:
                return self._problem(400, "accountDoesNotExist")
        if not _verify(account_jwk, f"{jws['protected']}.{jws['payload']}".encode(),
                       _unb64(jws["signature"])):
            return self._problem(400, "malformed", "bad signature")
        payload = json.loads(_unb64(jws["payload"])) if jws["payload"] else None
        parts = [p for p in path.split("/") if p]
        if parts == ["new-account"]:
            for kid, known in self.accounts.items():
                if _thumb(known) == _thumb(account_jwk):
                    return self._json(200, {"status": "valid"}, kid)
            kid = f"{BASE}/acct/{next(self._ids)}"
            self.accounts[kid] = account_jwk
            self.new_accounts += 1
            return self._json(201, {"status": "valid"}, kid)
        if parts == ["new-order"]:
            names = [i["value"] for i in payload["identifiers"]]
            oid = str(next(self._ids))
            authz_urls = []
            for name in names:
                aid = str(next(self._ids))
                token = _b64(hashlib.sha256(f"{oid}-{aid}".encode()).digest())
                self.authzs[aid] = {"identifier": {"type": "dns", "value": name},
                                    "status": "pending", "_order": oid,
                                    "challenges": [
                                        {"type": "dns-01", "url": f"{BASE}/chall/{aid}/dns",
                                         "token": token, "status": "pending"},
                                        {"type": "http-01", "url": f"{BASE}/chall/{aid}/http",
                                         "token": token, "status": "pending"}]}
                authz_urls.append(f"{BASE}/authz/{aid}")
            self.orders[oid] = {"status": "pending", "identifiers": payload["identifiers"],
                                "authorizations": authz_urls,
                                "finalize": f"{BASE}/finalize/{oid}"}
            return self._json(201, self.orders[oid], f"{BASE}/order/{oid}")
        if parts[0] == "authz":
            return self._json(200, self._public(self.authzs[parts[1]]))
        if parts[0] == "chall":
            authz = self.authzs[parts[1]]
            ok = self._validate(authz, parts[2], account_jwk)
            authz["status"] = "valid" if ok else "invalid"
            order = self.orders[authz["_order"]]
            states = {self.authzs[u.rsplit("/", 1)[1]]["status"] for u in order["authorizations"]}
            order["status"] = "invalid" if "invalid" in states else (
                "ready" if states == {"valid"} else "pending")
            return self._json(200, {"type": parts[2], "status": authz["status"]})
        if parts[0] == "order":
            return self._json(200, self.orders[parts[1]])
        if parts[0] == "finalize":
            order = self.orders[parts[1]]
            csr = x509.load_der_x509_csr(_unb64(payload["csr"]))
            names = sorted(csr.extensions.get_extension_for_class(
                x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName))
            if names != sorted(i["value"] for i in order["identifiers"]):
                return self._problem(400, "badCSR")
            leaf = self._issue(csr, names)
            self.certs[parts[1]] = (leaf.public_bytes(serialization.Encoding.PEM).decode()
                                    + self.ca_cert.public_bytes(serialization.Encoding.PEM).decode())
            order |= {"status": "valid", "certificate": f"{BASE}/cert/{parts[1]}"}
            return self._json(200, order)
        if parts[0] == "cert":
            return httpx.Response(200, text=self.certs[parts[1]],
                                  headers={"Replay-Nonce": self._nonce(),
                                           "Content-Type": "application/pem-certificate-chain"})
        return self._problem(404, "malformed")

    @staticmethod
    def _public(authz: dict) -> dict:
        return {k: v for k, v in authz.items() if not k.startswith("_")}

    def _validate(self, authz: dict, kind: str, account_jwk: dict) -> bool:
        if self.fail_validation:
            return False
        token = authz["challenges"][0]["token"]
        key_auth = f"{token}.{_thumb(account_jwk)}"
        name = authz["identifier"]["value"]
        if kind == "dns":
            want = _b64(hashlib.sha256(key_auth.encode()).digest())
            return any(r["type"] == "TXT" and r["name"] == f"_acme-challenge.{name}"
                       and r["content"] == want for r in self.cloudflare.records.values())
        return self.http_fetch is not None and self.http_fetch(name, token) == key_auth

    def _issue(self, csr: x509.CertificateSigningRequest, names: list[str]) -> x509.Certificate:
        now = datetime.now(UTC)
        leaf = (x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
                .issuer_name(self.ca_cert.subject).public_key(csr.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(hours=1))
                .not_valid_after(now + timedelta(days=self.days))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]),
                               False)
                .sign(self.ca_key, hashes.SHA256()))
        self.issued.append(leaf)
        return leaf
```

In `sirdar/api/tests/do_helpers.py`, in `Cloud.__init__`, set `self.cloudflare = FakeCloudflare()` and `self.acme = FakeAcme(cloudflare=self.cloudflare)` (imports from `.fake_cloudflare` and `.fake_acme`).

- [ ] **Step 4: Write the failing tests**

Create `sirdar/api/tests/test_deploy_acme.py`:

```python
"""ACME (RFC 8555) against FakeAcme, and Sirdar's DNS-01 issuance through
the Cloudflare integration: the challenge records are removed afterwards,
Sirdar's account key is stored encrypted and reused, a bad nonce is retried,
and errors are our own copy."""

import pytest
from cryptography import x509
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AcmeAccount
from sirdar_api.deploy import acme, certs, integrations

from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import do_cloud  # noqa: F401
from .integration_helpers import CF_TOKEN, configure

pytestmark = pytest.mark.usefixtures("secrets_key")
NAMES = certs.public_names("uat9.serversherpa.com")


async def _nap(_s):
    return None


def test_names_and_helpers():
    assert NAMES == ("api.uat9.serversherpa.com", "portal.uat9.serversherpa.com",
                     "kiosk.uat9.serversherpa.com", "wiki.uat9.serversherpa.com",
                     "status.uat9.serversherpa.com")
    key = acme._load_key(acme.new_key_pem())
    assert set(acme.jwk(key)) == {"crv", "kty", "x", "y"}
    assert len(acme.thumbprint(key)) == 43
    assert acme.key_authorization("tok", key) == f"tok.{acme.thumbprint(key)}"
    assert len(acme.dns01_value("tok.x")) == 43
    key_pem, csr = acme.make_csr(list(NAMES))
    parsed = x509.load_der_x509_csr(csr)
    assert sorted(parsed.extensions.get_extension_for_class(
        x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)) == sorted(NAMES)
    assert "PRIVATE KEY" in key_pem


async def _issue(db, do_cloud, out=None):
    await configure(db, npm=False)
    cf = await integrations.load_cloudflare(db, get_settings())
    lines: list[str] = []
    issued = await certs.issue_dns01(get_settings(), names=NAMES,
                                     directory=do_cloud.acme.directory_url, cloudflare=cf,
                                     out=out or lines.append, sleep=_nap, dns_wait=0, poll=0)
    return issued, lines


async def test_issue_by_dns01(db, do_cloud):
    issued, lines = await _issue(db, do_cloud)
    assert sorted(issued.names) == sorted(NAMES)
    leaf = x509.load_pem_x509_certificate(issued.leaf_pem.encode())
    assert leaf.not_valid_after_utc == issued.not_after
    assert "BEGIN CERTIFICATE" in issued.chain_pem
    assert issued.key_pem not in repr(issued)
    # Every challenge record went again.
    assert not [r for r in do_cloud.cloudflare.records.values() if r["type"] == "TXT"]
    assert sum("DNS challenge record added" in line for line in lines) == len(NAMES)
    row = (await db.scalars(select(AcmeAccount))).one()
    assert row.directory == do_cloud.acme.directory_url and row.kid
    assert b"PRIVATE KEY" not in bytes(row.key_enc)
    # The account is reused: no second registration.
    await _issue(db, do_cloud)
    assert do_cloud.acme.new_accounts == 1


async def test_a_bad_nonce_is_retried(db, do_cloud):
    do_cloud.acme.bad_nonce_once = True
    issued, _ = await _issue(db, do_cloud)
    assert issued.leaf_pem


async def test_a_failed_challenge_is_our_copy(db, do_cloud):
    do_cloud.acme.fail_validation = True
    with pytest.raises(certs.CertError) as err:
        await _issue(db, do_cloud)
    assert err.value.reason.startswith("Let's Encrypt couldn't validate ")
    assert "SECRET" not in err.value.reason and CF_TOKEN not in err.value.reason
    assert not [r for r in do_cloud.cloudflare.records.values() if r["type"] == "TXT"]


def test_ownership_and_expiry_helpers():
    from datetime import UTC, datetime
    now = datetime(2026, 10, 5, tzinfo=UTC)
    assert certs.cert_name("uat9", now) == "ss-uat9-202610050000"
    cert = {"name": "ss-uat9-202610050000", "dns_names": list(reversed(NAMES)),
            "not_after": "2026-11-04T00:00:00Z"}
    assert certs.is_ours(cert, "uat9", NAMES)
    assert not certs.is_ours({**cert, "name": "hand-made"}, "uat9", NAMES)
    assert not certs.is_ours({**cert, "dns_names": list(NAMES[:2])}, "uat9", NAMES)
    assert certs.days_left(certs.not_after(cert), now) == 30
```

- [ ] **Step 5: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_acme.py`
Expected: FAIL (`cannot import name 'acme'`).

- [ ] **Step 6: Write the ACME client**

Create `sirdar/api/src/sirdar_api/deploy/acme.py` (no `sirdar_api` imports: the same file goes into the api in 7b):

```python
"""A small ACME (RFC 8555) client: one ES256 account key, one order for a
set of DNS names, DNS-01 or HTTP-01 challenges, finalize with a CSR, and the
certificate chain. Standard library, `cryptography` and `httpx` only.

This file is shared byte-for-byte by Sirdar
(sirdar/api/src/sirdar_api/deploy/acme.py: DNS-01 through Cloudflare) and
ServerSherpa's cert-worker (api/src/serversherpa/certs/acme.py: HTTP-01).
Change both together; a Sirdar test compares them.

Errors are AcmeError with our own copy: the server's `detail` text is never
kept. Nothing here logs; private keys are returned only in Issued.key_pem,
which repr() hides."""

import asyncio
import base64
import hashlib
import json
import re
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import datetime

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.x509.oid import NameOID

LETSENCRYPT = "https://acme-v02.api.letsencrypt.org/directory"
LETSENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory"
POLL_SECONDS = 3
POLL_TRIES = 100
TIMEOUT = 30
_TYPE_RE = re.compile(r"urn:ietf:params:acme:error:([A-Za-z]{1,40})")
_PEM_RE = re.compile(r"-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----\n?")

Solver = Callable[[str, str, str, str], AbstractAsyncContextManager[None]]


class AcmeError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Issued:
    key_pem: str = field(repr=False)
    leaf_pem: str
    chain_pem: str
    not_after: datetime
    names: tuple[str, ...]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def new_key_pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()


def _load_key(pem: str) -> ec.EllipticCurvePrivateKey:
    try:
        key = serialization.load_pem_private_key(pem.encode(), None)
    except (ValueError, TypeError):
        raise AcmeError("The ACME account key can't be read.") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise AcmeError("The ACME account key isn't a P-256 key.")
    return key


def jwk(key: ec.EllipticCurvePrivateKey) -> dict:
    numbers = key.public_key().public_numbers()
    return {"crv": "P-256", "kty": "EC", "x": b64url(numbers.x.to_bytes(32, "big")),
            "y": b64url(numbers.y.to_bytes(32, "big"))}


def thumbprint(key: ec.EllipticCurvePrivateKey) -> str:
    canon = json.dumps(jwk(key), sort_keys=True, separators=(",", ":"))
    return b64url(hashlib.sha256(canon.encode()).digest())


def key_authorization(token: str, key: ec.EllipticCurvePrivateKey) -> str:
    return f"{token}.{thumbprint(key)}"


def dns01_value(key_auth: str) -> str:
    return b64url(hashlib.sha256(key_auth.encode()).digest())


def make_csr(names) -> tuple[str, bytes]:
    """(the certificate's new private key as PEM, the CSR as DER)."""
    names = list(names)
    key = ec.generate_private_key(ec.SECP256R1())
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
           .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]), False)
           .sign(key, hashes.SHA256()))
    key_pem = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.TraditionalOpenSSL,
                                serialization.NoEncryption()).decode()
    return key_pem, csr.public_bytes(serialization.Encoding.DER)


def split_chain(pem: str) -> tuple[str, str]:
    """(leaf, the rest of the chain) from a PEM chain."""
    blocks = [b if b.endswith("\n") else b + "\n" for b in _PEM_RE.findall(pem or "")]
    if not blocks:
        raise AcmeError("The ACME server sent no certificate.")
    return blocks[0], "".join(blocks[1:])


def _error_type(resp: httpx.Response) -> str | None:
    try:
        body = resp.json()
    except ValueError:
        return None
    found = _TYPE_RE.fullmatch(str(body.get("type", ""))) if isinstance(body, dict) else None
    return found.group(1) if found else None


def _refused(resp: httpx.Response) -> str:
    kind = _error_type(resp)
    return (f"The ACME server refused the request ({kind})." if kind
            else f"The ACME server answered with HTTP {resp.status_code}.")


class AcmeClient:
    def __init__(self, directory_url: str, account_key_pem: str, *, kid: str | None = None,
                 transport: httpx.AsyncBaseTransport | None = None, sleep=asyncio.sleep,
                 poll: float = POLL_SECONDS, tries: int = POLL_TRIES):
        self.directory_url = directory_url
        self.key = _load_key(account_key_pem)
        self.kid = kid
        self._transport = transport
        self._sleep = sleep
        self._poll = poll
        self._tries = tries
        self._nonce: str | None = None
        self._directory: dict | None = None
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "AcmeClient":
        self._client = httpx.AsyncClient(timeout=TIMEOUT, transport=self._transport,
                                         headers={"User-Agent": "sirdar-acme/1"})
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _http(self, method: str, url: str, **kwargs) -> httpx.Response:
        try:
            return await self._client.request(method, url, **kwargs)
        except httpx.HTTPError:
            raise AcmeError("Couldn't reach the ACME server.") from None

    async def directory(self) -> dict:
        if self._directory is None:
            resp = await self._http("GET", self.directory_url)
            try:
                body = resp.json()
            except ValueError:
                body = None
            if (resp.status_code != 200 or not isinstance(body, dict)
                    or not all(isinstance(body.get(k), str)
                               for k in ("newNonce", "newAccount", "newOrder"))):
                raise AcmeError("The ACME directory isn't usable.")
            self._directory = body
        return self._directory

    async def _fresh_nonce(self) -> str:
        resp = await self._http("HEAD", (await self.directory())["newNonce"])
        nonce = resp.headers.get("replay-nonce")
        if not nonce:
            raise AcmeError("The ACME server sent no nonce.")
        return nonce

    def _signed(self, url: str, payload, nonce: str, use_jwk: bool) -> bytes:
        protected: dict = {"alg": "ES256", "nonce": nonce, "url": url}
        protected |= {"jwk": jwk(self.key)} if use_jwk else {"kid": self.kid}
        p64 = b64url(json.dumps(protected).encode())
        pl64 = "" if payload is None else b64url(json.dumps(payload).encode())
        r, s = decode_dss_signature(self.key.sign(f"{p64}.{pl64}".encode(),
                                                  ec.ECDSA(hashes.SHA256())))
        signature = b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        return json.dumps({"protected": p64, "payload": pl64, "signature": signature}).encode()

    async def post(self, url: str, payload, *, use_jwk: bool = False,
                   accept: str | None = None) -> httpx.Response:
        """A signed POST (payload None: POST-as-GET). A badNonce is retried once."""
        for attempt in (1, 2):
            nonce = self._nonce or await self._fresh_nonce()
            self._nonce = None
            headers = {"Content-Type": "application/jose+json"}
            if accept:
                headers["Accept"] = accept
            resp = await self._http("POST", url, content=self._signed(url, payload, nonce, use_jwk),
                                    headers=headers)
            self._nonce = resp.headers.get("replay-nonce")
            if resp.status_code == 400 and _error_type(resp) == "badNonce" and attempt == 1:
                continue
            if resp.status_code >= 400:
                raise AcmeError(_refused(resp))
            return resp
        raise AcmeError("The ACME server kept refusing the nonce.")

    async def get_json(self, url: str) -> dict:
        resp = await self.post(url, None)
        try:
            body = resp.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise AcmeError("The ACME server sent a response Sirdar didn't understand.")
        return body

    async def register(self) -> str:
        if self.kid:
            return self.kid
        resp = await self.post((await self.directory())["newAccount"],
                               {"termsOfServiceAgreed": True}, use_jwk=True)
        kid = resp.headers.get("location")
        if not kid:
            raise AcmeError("The ACME server sent no account URL.")
        self.kid = kid
        return kid

    async def new_order(self, names) -> tuple[str, dict]:
        resp = await self.post((await self.directory())["newOrder"], {
            "identifiers": [{"type": "dns", "value": n} for n in names]})
        url = resp.headers.get("location")
        try:
            body = resp.json()
        except ValueError:
            body = None
        if not url or not isinstance(body, dict):
            raise AcmeError("The ACME server sent an order Sirdar didn't understand.")
        return url, body

    async def wait_for(self, url: str, ready: tuple[str, ...], what: str) -> dict:
        for _ in range(self._tries):
            body = await self.get_json(url)
            status = body.get("status")
            if status in ready:
                return body
            if status == "invalid":
                raise AcmeError(f"Let's Encrypt couldn't validate {what}.")
            await self._sleep(self._poll)
        raise AcmeError(f"Let's Encrypt didn't finish {what} in time.")

    async def certificate(self, url: str) -> str:
        return (await self.post(url, None, accept="application/pem-certificate-chain")).text


async def issue(client: AcmeClient, names, challenge_type: str, solve: Solver) -> Issued:
    """Order a certificate for `names` and answer each authorization with
    `solve(challenge_type, name, token, key_authorization)`, an async context
    manager that publishes the answer while it is open."""
    names = list(dict.fromkeys(names))
    await client.register()
    order_url, order = await client.new_order(names)
    for authz_url in order.get("authorizations") or []:
        authz = await client.get_json(authz_url)
        if authz.get("status") == "valid":
            continue
        name = (authz.get("identifier") or {}).get("value")
        challenge = next((c for c in authz.get("challenges") or []
                          if isinstance(c, dict) and c.get("type") == challenge_type), None)
        if challenge is None or not isinstance(name, str):
            raise AcmeError(f"The ACME server offered no {challenge_type} challenge.")
        key_auth = key_authorization(str(challenge["token"]), client.key)
        async with solve(challenge_type, name, str(challenge["token"]), key_auth):
            await client.post(challenge["url"], {})
            await client.wait_for(authz_url, ("valid",), name)
    order = await client.wait_for(order_url, ("ready", "valid"), "the order")
    key_pem, csr = make_csr(names)
    if order.get("status") == "ready":
        await client.post(order["finalize"], {"csr": b64url(csr)})
        order = await client.wait_for(order_url, ("valid",), "the certificate")
    leaf, rest = split_chain(await client.certificate(order["certificate"]))
    not_after = x509.load_pem_x509_certificate(leaf.encode()).not_valid_after_utc
    return Issued(key_pem=key_pem, leaf_pem=leaf, chain_pem=rest, not_after=not_after,
                  names=tuple(names))
```

- [ ] **Step 7: Write `certs.py`**

Create `sirdar/api/src/sirdar_api/deploy/certs.py`:

```python
"""Certificates for DigitalOcean environments (deploy phase 7): Sirdar
issues the first one, and is the backup renewer, by DNS-01 through the
Cloudflare integration; the environment's cert-worker (7b) renews by
HTTP-01. A certificate is uploaded to DigitalOcean as a custom certificate
named ss-<env>-<UTC yyyymmddhhmm> covering exactly the public names.

Sirdar's ACME account key (one per directory) is kept Fernet-encrypted in
acme_accounts. Errors are CertError with our own copy."""

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import AcmeAccount
from sirdar_api.deploy import acme, outbound, vault
from sirdar_api.deploy.cloudflare import Cloudflare, CloudflareError
from sirdar_api.deploy.integrations import CloudflareConfig

SIRDAR_RENEW_DAYS = 14
WORKER_RENEW_DAYS = 30
DNS_WAIT = 15                     # seconds for Cloudflare's answer to settle
PUBLIC_SERVICES = ("api", "portal", "kiosk", "wiki", "status")
CHALLENGE_COMMENT = "Managed by Sirdar (ACME challenge)"


class CertError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def public_names(base_domain: str) -> tuple[str, ...]:
    return tuple(f"{s}.{base_domain}" for s in PUBLIC_SERVICES)


def cert_name(env_name: str, now: datetime) -> str:
    return f"ss-{env_name}-{now.astimezone(UTC):%Y%m%d%H%M}"


def is_ours(cert: dict, env_name: str, names) -> bool:
    """A DigitalOcean certificate named for this environment that covers
    exactly its public names (what Sirdar or its cert-worker uploads)."""
    found = cert.get("dns_names") if isinstance(cert, dict) else None
    return (isinstance(cert.get("name"), str) and cert["name"].startswith(f"ss-{env_name}-")
            and isinstance(found, list) and sorted(found) == sorted(names))


def not_after(cert: dict) -> datetime | None:
    try:
        return datetime.strptime(str(cert.get("not_after")),
                                 "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None


def days_left(when: datetime, now: datetime) -> float:
    return (when - now).total_seconds() / 86400


async def _account_key(settings: Settings, directory: str) -> tuple[str, str | None]:
    async with get_sessionmaker()() as s:
        row = await s.get(AcmeAccount, directory)
        if row is None:
            pem = acme.new_key_pem()
            s.add(AcmeAccount(directory=directory, key_enc=vault.encrypt(settings, pem)))
            await s.commit()
            return pem, None
        try:
            return vault.decrypt(settings, row.key_enc), row.kid
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise CertError("Sirdar's ACME account key doesn't open with the current "
                            "SIRDAR_SECRETS_KEY.") from None


async def _remember_kid(directory: str, kid: str) -> None:
    async with get_sessionmaker()() as s:
        row = await s.get(AcmeAccount, directory)
        row.kid = kid
        await s.commit()


def dns01_solver(api: Cloudflare, *, sleep, wait: float, out) -> acme.Solver:
    @asynccontextmanager
    async def solve(kind: str, name: str, token: str, key_auth: str):
        record = await api.create_record("TXT", f"_acme-challenge.{name}",
                                         acme.dns01_value(key_auth), comment=CHALLENGE_COMMENT)
        out(f"{name}: DNS challenge record added\n")
        try:
            await sleep(wait)
            yield
        finally:
            try:
                await api.delete(record.id)
            except CloudflareError:
                out(f"{name}: couldn't remove the DNS challenge record; it stays in "
                    "Cloudflare\n")
    return solve


async def issue_dns01(settings: Settings, *, names, directory: str,
                      cloudflare: CloudflareConfig, out, sleep=asyncio.sleep,
                      dns_wait: float = DNS_WAIT, poll: float = acme.POLL_SECONDS
                      ) -> acme.Issued:
    key_pem, kid = await _account_key(settings, directory)
    transports = outbound.transports()
    try:
        async with Cloudflare(cloudflare, transport=transports.get("cloudflare")) as cf, \
                acme.AcmeClient(directory, key_pem, kid=kid, transport=transports.get("acme"),
                                sleep=sleep, poll=poll) as client:
            issued = await acme.issue(client, names, "dns-01",
                                      dns01_solver(cf, sleep=sleep, wait=dns_wait, out=out))
            if client.kid != kid:
                await _remember_kid(directory, client.kid)
    except CloudflareError as e:
        raise CertError(e.reason) from None
    except acme.AcmeError as e:
        raise CertError(e.reason) from None
    return issued
```

- [ ] **Step 8: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_acme.py tests/test_deploy_cloudflare.py tests/test_deploy_publish_steps.py`
Expected: all PASS.

- [ ] **Step 9: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/acme.py src/sirdar_api/deploy/certs.py src/sirdar_api/deploy/cloudflare.py src/sirdar_api/config.py tests/fake_acme.py tests/test_deploy_acme.py tests/do_helpers.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/acme.py sirdar/api/src/sirdar_api/deploy/certs.py sirdar/api/src/sirdar_api/deploy/cloudflare.py sirdar/api/src/sirdar_api/config.py sirdar/api/tests/fake_acme.py sirdar/api/tests/test_deploy_acme.py sirdar/api/tests/do_helpers.py
git commit -m "feat(sirdar): ACME client and DNS-01 certificates through Cloudflare

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: DigitalOcean environment records, and creating one

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/do_envs.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/targets.py` (`DO_TARGET`, `BUILT_TARGETS`, `is_built_target`)
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (production type, `do` on create, locked fields, `retiring`)
- Modify: `sirdar/api/src/sirdar_api/deploy/vms.py` (`host_config(..., slot=None)` dispatches to DigitalOcean)
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py` (`target_kind`, slots, `do`, deployment fields)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (create, defaults, PATCH `retiring`)
- Modify: `sirdar/api/tests/do_helpers.py` (`make_do_environment`)
- Create: `sirdar/api/tests/test_deploy_do_environments.py`

**Interfaces:**
- Consumes: `do_accounts.require` (Task 3), `certs.PUBLIC_SERVICES` (Task 5), `vms.new_keypair`, `vms.new_host_keypair`, `vms.VM_USER`, `vms.VM_SSH_PORT`.
- Produces (`do_envs`):
  - constants `DO_TARGET = "digitalocean"`, `PRODUCTION_SLOTS`, `ONE_SLOT`, `TWO_SLOTS`, `DEFAULT_DROPLET_SIZE = "s-2vcpu-4gb"`, `DEFAULT_DB_SIZE = "db-s-2vcpu-4gb"`, `CADDY_IP = "172.30.0.2"`, `NETWORK_SUBNET = "172.30.0.0/24"`, `BIND_IP = "127.0.0.1"`, `DB_NAME = DB_USER = "serversherpa"`;
  - `DoEnvError(code, **extra)`; `check_spec(fields, *, production) -> dict` (`account, slots, droplet_size, db_size, db_standby, acme_staging`);
  - names: `droplet_name(env_name, slot)`, `resource_name(env_name, suffix="")`, `bucket_name(env_name, env_id)`, `env_tag(env_id)`, `tags(env_id, env_name, slot=None)`;
  - async `add(db, settings, env, spec, *, region) -> DoEnvironment`, `add_slot(db, settings, env, slot) -> DoSlot`, `get(db, env_id)`, `slots_of(db, env_id) -> dict[str, DoSlot]`, `resources_of(db, env_id) -> list[DoResource]`, `host_config(db, settings, env, slot=None) -> SshTargetConfig | None`, `production_exists(db) -> bool`;
  - own-session writers: `record(env_id, kind, do_id, name, slot=None)`, `forget(env_id, kind, do_id)`, `set_do(env_id, **values)`, `set_slot(env_id, slot, **values)`, `lb_ip(env_id) -> str | None`;
  - pure: `target_slot(env) -> str`, `goes_live(env, slot) -> bool`, `public(env, row, slots, resources, account_label) -> dict`.
  - `targets.DO_TARGET`, `targets.BUILT_TARGETS = VM_TARGETS + (DO_TARGET,)`, `targets.is_built_target(target_id) -> bool`.
  - `environments.create_new(..., do: dict | None = None)`; `environments.ENV_TYPES` adds `"production"`.
  - Test helper `make_do_environment(db, *, name="uat9", type_="dev", slots=2, account="development", snapshot_id=None) -> Environment` (saves Cloudflare and the account first).

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/do_helpers.py`:

```python
async def make_do_environment(db, *, name: str = "uat9", type_: str = "dev", slots: int = 2,
                              account: str = "development", snapshot_id=None, **do):
    """A DigitalOcean environment through environments.create_new (needs the
    secrets_key fixture). Saves Cloudflare and the account first."""
    from sirdar_api.deploy import environments, integrations

    from .fake_digitalocean import DO_TOKEN, RENEW_TOKEN
    from .integration_helpers import configure

    if not await integrations.is_configured(db, "cloudflare"):
        await configure(db, npm=False)
    if not await do_accounts.has_token(db, account):
        if account == "production":
            await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
        else:
            await configure_account(db)
    env = await environments.create_new(
        db, get_settings(), name=name, type_=type_, target_id="digitalocean",
        snapshot_id=snapshot_id, do={"account": account, "slots": slots, **do})
    await db.commit()
    return env
```

Create `sirdar/api/tests/test_deploy_do_environments.py`:

```python
"""Creating and editing DigitalOcean environments: the record (frozen
account and sizes, a key pair, one host key per slot), production's rules,
the locked fields, the slot an Update targets and whether it goes live, and
the SSH connection to a slot's droplet."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import DoEnvironment, DoSlot, Environment
from sirdar_api.deploy import do_envs, environments, vms
from sirdar_api.deploy.environments import EnvError

from .api_helpers import auth_headers
from .deploy_factories import leak_guard, secrets_key  # noqa: F401
from .do_helpers import configure_account, make_do_environment
from .integration_helpers import configure

pytestmark = pytest.mark.usefixtures("secrets_key")
URL = "/api/deploy/environments"


async def test_create_two_slots(db):
    env = await make_do_environment(db)
    assert (env.type, env.target_id, env.slots, env.active_slot) == (
        "dev", "digitalocean", ["orange", "purple"], None)
    assert (env.proxy_ip, env.bind_ip, env.publish) == ("172.30.0.2", "127.0.0.1", True)
    assert env.spaces_bucket == f"ss-uat9-{env.id.hex[:8]}"
    row = await db.get(DoEnvironment, env.id)
    assert (row.account_key, row.region, row.droplet_size, row.db_size, row.db_standby) == (
        "development", "nyc3", "s-2vcpu-4gb", "db-s-2vcpu-4gb", False)
    assert row.bucket == env.spaces_bucket and b"PRIVATE" not in bytes(row.ssh_private_key_enc)
    slots = (await db.scalars(select(DoSlot).where(DoSlot.environment_id == env.id))).all()
    assert sorted(s.slot for s in slots) == ["orange", "purple"]
    assert all(s.host_key_private_enc is not None for s in slots)
    hostnames = {s.service: s.hostname for s in await environments.services_of(db, env.id)}
    assert hostnames["api"] == "api.uat9.serversherpa.com"
    assert hostnames["spaces"] is None and hostnames["mailpit"] is None


async def test_production_rules(db):
    env = await make_do_environment(db, name="prod", type_="production", account="production",
                                    slots=None)
    assert env.slots == ["blue", "green"]
    with pytest.raises(EnvError) as e:
        await make_do_environment(db, name="prod2", type_="production", account="production")
    assert e.value.code == "production_exists"
    await db.rollback()
    env.retiring = True
    await db.commit()
    await make_do_environment(db, name="prod2", type_="production", account="production")
    for bad, code in (({"slots": 1}, "do_slots_invalid"), ({"acme_staging": True}, "do_invalid")):
        with pytest.raises(EnvError) as e:
            await make_do_environment(db, name="prod3", type_="production",
                                      account="production", **bad)
        assert e.value.code == code
        await db.rollback()


async def test_create_refusals(db):
    await configure(db, npm=False)
    settings = get_settings()

    async def create(**kw):
        base = dict(name="uat9", type_="dev", target_id="digitalocean",
                    do={"account": "development"})
        return await environments.create_new(db, settings, **{**base, **kw})

    with pytest.raises(EnvError) as e:
        await create()
    assert (e.value.code, e.value.extra) == ("do_account_not_configured",
                                             {"account": "development"})
    await configure_account(db)
    with pytest.raises(EnvError) as e:
        await create(base_domain="uat9.example.org")
    assert e.value.code == "base_domain_not_in_zone"
    with pytest.raises(EnvError) as e:
        await create(type_="production", target_id="ssh", do=None)
    assert e.value.code in ("production_requires_digitalocean", "target_not_configured")
    for do, code in (({"account": "development", "droplet_size": "Huge!"}, "do_size_invalid"),
                     ({"account": "development", "db_size": "s-2vcpu-4gb"}, "do_db_size_invalid"),
                     ({"account": "development", "slots": 3}, "do_slots_invalid"),
                     ({"account": "elsewhere"}, "do_invalid")):
        with pytest.raises(EnvError) as e:
            await create(do=do)
        assert e.value.code == code
    with pytest.raises(EnvError) as e:
        await create(vm={"ip_mode": "dhcp"})
    assert e.value.code == "vm_not_allowed"


async def test_create_without_cloudflare(db):
    await configure_account(db)
    with pytest.raises(EnvError) as e:
        await environments.create_new(db, get_settings(), name="uat9", type_="dev",
                                      target_id="digitalocean", do={"account": "development"})
    assert (e.value.code, e.value.extra) == ("integration_not_configured",
                                             {"kinds": ["cloudflare"]})


def _env(slots, active=None, auto=False, type_="dev") -> Environment:
    return Environment(name="x", type=type_, target_id="digitalocean", slots=slots,
                       active_slot=active, auto_activate=auto)


def test_target_slot_and_going_live():
    assert do_envs.target_slot(_env(["orange", "purple"])) == "orange"
    assert do_envs.target_slot(_env(["orange", "purple"], "orange")) == "purple"
    assert do_envs.target_slot(_env(["orange", "purple"], "purple")) == "orange"
    assert do_envs.target_slot(_env(["orange"], "orange")) == "orange"
    assert do_envs.goes_live(_env(["orange", "purple"]), "orange")              # first deploy
    assert not do_envs.goes_live(_env(["orange", "purple"], "orange"), "purple")
    assert do_envs.goes_live(_env(["orange", "purple"], "orange", auto=True), "purple")
    assert do_envs.goes_live(_env(["orange"], "orange"), "orange")              # in place
    assert not do_envs.goes_live(_env(["blue", "green"], "blue", type_="production"), "green")


async def test_host_config_is_the_slots_droplet(db, monkeypatch):
    env = await make_do_environment(db)
    assert await vms.host_config(db, get_settings(), env) is None       # no droplet yet
    await do_envs.set_slot(env.id, "purple", public_ip="203.0.113.9", droplet_id="4002")
    await db.refresh(env)
    cfg = await vms.host_config(db, get_settings(), env, slot="purple")
    assert (cfg.host, cfg.user, cfg.port) == ("203.0.113.9", "deploy", vms.VM_SSH_PORT)
    assert cfg.private_key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    assert await vms.host_config(db, get_settings(), env) is None       # orange: no droplet


async def test_the_api(client, db, leak_guard):
    await configure(db, npm=False)
    await configure_account(db)
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        "mode": "new", "name": "uat9", "type": "dev", "target": "digitalocean",
        "do": {"account": "development", "slots": 2, "acme_staging": True}})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["target_kind"], body["slots"], body["active_slot"], body["retiring"]) == (
        "digitalocean", ["orange", "purple"], None, False)
    do = body["do"]
    assert (do["account"], do["account_label"], do["acme_staging"], do["lb_ip"]) == (
        "development", "Development", True, None)
    assert [s["slot"] for s in do["slots"]] == ["orange", "purple"]
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"proxy_ip": "10.0.0.9"})
    assert (resp.status_code, resp.json()["detail"]) == (
        422, {"code": "do_field_locked", "field": "proxy_ip"})
    resp = await client.patch(f"{URL}/uat9", headers=h,
                              json={"retiring": True, "confirm_name": "uat9"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "retiring_not_allowed")
    resp = await client.get("/api/deploy/environment-defaults", headers=h)
    assert resp.json()["do"] == {"droplet_size": "s-2vcpu-4gb", "db_size": "db-s-2vcpu-4gb",
                                 "db_standby": False, "production_slots": ["blue", "green"],
                                 "one_slot": ["orange"], "two_slots": ["orange", "purple"]}


async def test_retiring_production(client, db):
    await make_do_environment(db, name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/prod", headers=h, json={"retiring": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "confirm_name_mismatch")
    resp = await client.patch(f"{URL}/prod", headers=h,
                              json={"retiring": True, "confirm_name": "prod"})
    assert resp.status_code == 200 and resp.json()["retiring"] is True
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_environments.py`
Expected: FAIL (`cannot import name 'do_envs'`).

- [ ] **Step 3: Targets**

In `sirdar/api/src/sirdar_api/deploy/targets.py`, after `VM_TARGET_LABELS`:

```python
# Environments whose hosts Sirdar builds in a DigitalOcean account (phase 7):
# droplets per slot, a managed database, Spaces and a load balancer.
DO_TARGET = "digitalocean"
BUILT_TARGETS = (*VM_TARGETS, DO_TARGET)


def is_built_target(target_id: str | None) -> bool:
    """A target whose host Sirdar builds (a VM host or DigitalOcean)."""
    return target_id in BUILT_TARGETS
```

- [ ] **Step 4: Write `do_envs.py`**

Create `sirdar/api/src/sirdar_api/deploy/do_envs.py`:

```python
"""DigitalOcean environments' records (deploy phase 7): the frozen
settings, slots and ownership rows, the slot an Update targets, the SSH
connection to a slot's droplet, and the JSON shape. Secrets are
Fernet-encrypted with SIRDAR_SECRETS_KEY and never returned.

record/forget/set_do/set_slot each write in their own committed
transaction: step 0 records a resource the moment DigitalOcean answers, so a
later failure still knows it exists."""

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import DoEnvironment, DoResource, DoSlot, Environment
from sirdar_api.deploy import acme, vault, vms
from sirdar_api.deploy.ssh import SshTargetConfig

DO_TARGET = "digitalocean"
PRODUCTION_SLOTS = ("blue", "green")
ONE_SLOT = ("orange",)
TWO_SLOTS = ("orange", "purple")
DEFAULT_DROPLET_SIZE = "s-2vcpu-4gb"     # V2 production: 2 vCPU / 4 GB / 80 GB
DEFAULT_DB_SIZE = "db-s-2vcpu-4gb"       # V2 production: 2 vCPU / 4 GB / 60 GB
DROPLET_IMAGE = "ubuntu-24-04-x64"
CADDY_IP = "172.30.0.2"                  # Caddy on the ss-<env> network = the env's proxy_ip
NETWORK_SUBNET = "172.30.0.0/24"
BIND_IP = "127.0.0.1"                    # app ports stay on the droplet; Caddy publishes :80
DB_NAME = DB_USER = "serversherpa"
_SIZE_RE = re.compile(r"[a-z0-9][a-z0-9-]{2,39}")
_DB_SIZE_RE = re.compile(r"db-[a-z0-9][a-z0-9-]{2,36}")


class DoEnvError(Exception):
    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


# ---- names and tags ----------------------------------------------------------------

def resource_name(env_name: str, suffix: str = "") -> str:
    return f"ss-{env_name}{suffix}"


def droplet_name(env_name: str, slot: str) -> str:
    return f"ss-{env_name}-{slot}"


def bucket_name(env_name: str, env_id) -> str:
    return f"ss-{env_name}-{uuid.UUID(str(env_id)).hex[:8]}"


def env_tag(env_id) -> str:
    """The ownership tag: only this environment's resources carry it."""
    return f"sirdar-env-{env_id}"


def tags(env_id, env_name: str, slot: str | None = None) -> list[str]:
    found = ["sirdar", env_tag(env_id), f"sirdar-env:{env_name}"]
    return found + ([f"sirdar-slot:{slot}"] if slot else [])


# ---- create ------------------------------------------------------------------------------

def check_spec(fields, *, production: bool) -> dict:
    if not isinstance(fields, dict):
        raise DoEnvError("do_invalid")
    account = fields.get("account") or ("production" if production else None)
    if account not in ("production", "development"):
        raise DoEnvError("do_invalid")
    count = fields.get("slots")
    if count is not None and (isinstance(count, bool) or count not in (1, 2)):
        raise DoEnvError("do_slots_invalid")
    if production:
        if count == 1:
            raise DoEnvError("do_slots_invalid")
        if fields.get("acme_staging"):
            raise DoEnvError("do_invalid")
        slots = PRODUCTION_SLOTS
    else:
        slots = TWO_SLOTS if count == 2 else ONE_SLOT
    droplet = fields.get("droplet_size") or DEFAULT_DROPLET_SIZE
    if not isinstance(droplet, str) or not _SIZE_RE.fullmatch(droplet) \
            or droplet.startswith("db-"):
        raise DoEnvError("do_size_invalid")
    db_size = fields.get("db_size") or DEFAULT_DB_SIZE
    if not isinstance(db_size, str) or not _DB_SIZE_RE.fullmatch(db_size):
        raise DoEnvError("do_db_size_invalid")
    standby, staging = fields.get("db_standby", False), fields.get("acme_staging", False)
    if not isinstance(standby, bool) or not isinstance(staging, bool):
        raise DoEnvError("do_invalid")
    return {"account": account, "slots": slots, "droplet_size": droplet, "db_size": db_size,
            "db_standby": standby, "acme_staging": staging}


async def add_slot(db: AsyncSession, settings: Settings, env: Environment, slot: str) -> DoSlot:
    private, public = vms.new_host_keypair(f"{env.name}-{slot}")
    row = DoSlot(environment_id=env.id, slot=slot, host_key_public=public,
                 host_key_private_enc=vault.encrypt(settings, private))
    db.add(row)
    await db.flush()
    return row


async def add(db: AsyncSession, settings: Settings, env: Environment, spec: dict, *,
              region: str) -> DoEnvironment:
    private, public = vms.new_keypair(env.name)
    row = DoEnvironment(environment_id=env.id, account_key=spec["account"], region=region,
                        droplet_size=spec["droplet_size"], droplet_image=DROPLET_IMAGE,
                        db_size=spec["db_size"], db_standby=spec["db_standby"],
                        acme_staging=spec["acme_staging"], ssh_public_key=public,
                        ssh_private_key_enc=vault.encrypt(settings, private),
                        acme_key_enc=vault.encrypt(settings, acme.new_key_pem()),
                        bucket=bucket_name(env.name, env.id))
    db.add(row)
    await db.flush()
    for slot in spec["slots"]:
        await add_slot(db, settings, env, slot)
    env.slots = list(spec["slots"])
    await db.flush()
    return row


async def production_exists(db: AsyncSession) -> bool:
    found = await db.scalar(select(Environment.id).where(
        Environment.type == "production", Environment.retiring.is_(False)).limit(1))
    return found is not None


# ---- reads ---------------------------------------------------------------------------------

async def get(db: AsyncSession, env_id) -> DoEnvironment | None:
    return await db.get(DoEnvironment, env_id, populate_existing=True)


async def slots_of(db: AsyncSession, env_id) -> dict[str, DoSlot]:
    rows = await db.scalars(select(DoSlot).where(DoSlot.environment_id == env_id)
                            .execution_options(populate_existing=True))
    return {r.slot: r for r in rows}


async def resources_of(db: AsyncSession, env_id) -> list[DoResource]:
    return list(await db.scalars(select(DoResource).where(DoResource.environment_id == env_id)
                                 .order_by(DoResource.created_at, DoResource.kind)
                                 .execution_options(populate_existing=True)))


def target_slot(env: Environment) -> str:
    """The slot an Update deploys to: the idle one of two, else the only one."""
    slots = list(env.slots)
    if env.active_slot is None or len(slots) == 1:
        return slots[0]
    return next(s for s in slots if s != env.active_slot)


def goes_live(env: Environment, slot: str) -> bool:
    """Whether an Update of `slot` switches traffic to it: nothing is live
    yet, a one-slot environment (in place), or a non-production environment
    with auto_activate. Production always waits for Activate."""
    if env.active_slot is None or len(env.slots) == 1 or env.active_slot == slot:
        return True
    return env.auto_activate and env.type != "production"


async def host_config(db: AsyncSession, settings: Settings, env: Environment,
                      slot: str | None = None) -> SshTargetConfig | None:
    """SSH to a slot's droplet (default: the active slot, else the first);
    None until step 0 has its address. vault errors propagate."""
    slot = slot or env.active_slot or (env.slots[0] if env.slots else None)
    if slot is None:
        return None
    row = await get(db, env.id)
    slot_row = await db.get(DoSlot, (env.id, slot), populate_existing=True)
    if row is None or slot_row is None or not slot_row.public_ip:
        return None
    return SshTargetConfig(host=slot_row.public_ip, port=vms.VM_SSH_PORT, user=vms.VM_USER,
                           private_key=vault.decrypt(settings, row.ssh_private_key_enc),
                           key_name=f"Sirdar's key for {droplet_name(env.name, slot)}")


# ---- own-session writers -------------------------------------------------------------------

async def record(env_id, kind: str, do_id, name: str, slot: str | None = None) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(insert(DoResource).values(
            environment_id=env_id, kind=kind, do_id=str(do_id), name=name, slot=slot)
            .on_conflict_do_nothing(index_elements=["kind", "do_id"]))
        await s.commit()


async def forget(env_id, kind: str, do_id) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(delete(DoResource).where(
            DoResource.environment_id == env_id, DoResource.kind == kind,
            DoResource.do_id == str(do_id)))
        await s.commit()


async def set_do(env_id, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env_id)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


async def set_slot(env_id, slot: str, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(DoSlot).where(DoSlot.environment_id == env_id,
                                             DoSlot.slot == slot)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


async def lb_ip(env_id) -> str | None:
    async with get_sessionmaker()() as s:
        return await s.scalar(select(DoEnvironment.lb_ip)
                              .where(DoEnvironment.environment_id == env_id))


# ---- JSON ------------------------------------------------------------------------------------

def public(env: Environment, row: DoEnvironment, slots: dict[str, DoSlot],
           resources: list[DoResource], account_label: str) -> dict:
    return {
        "account": row.account_key, "account_label": account_label, "region": row.region,
        "droplet_size": row.droplet_size, "db_size": row.db_size, "db_standby": row.db_standby,
        "acme_staging": row.acme_staging, "vpc_ip_range": row.vpc_ip_range, "lb_ip": row.lb_ip,
        "db_host": row.db_host, "bucket": row.bucket, "cert_not_after": row.cert_not_after,
        "slots": [{"slot": s, "droplet_id": r.droplet_id, "public_ip": r.public_ip,
                   "private_ip": r.private_ip, "sha": r.sha, "image_tag": r.image_tag,
                   "active": s == env.active_slot, "last_check_ok": r.last_check_ok,
                   "last_check_at": r.last_check_at}
                  for s in env.slots if (r := slots.get(s)) is not None],
        "resources": [{"kind": r.kind, "name": r.name, "slot": r.slot} for r in resources],
    }
```

- [ ] **Step 5: `vms.host_config` dispatches**

In `sirdar/api/src/sirdar_api/deploy/vms.py`, change `host_config`'s signature and add the branch first:

```python
async def host_config(db: AsyncSession, settings: Settings, env: Environment, *,
                      slot: str | None = None) -> SshTargetConfig | None:
    """The SSH connection the deploy steps use: a saved target's, for a VM
    environment the VM's (None until step 0 has read its address), and for
    a DigitalOcean environment the slot's droplet (default: the active
    slot). Keys are decrypted here: vault.SecretsKeyMissing or
    vault.SecretUnreadable propagate."""
    if env.target_id == targets.DO_TARGET:
        from sirdar_api.deploy import do_envs           # do_envs imports vms
        return await do_envs.host_config(db, settings, env, slot)
    ...
```

- [ ] **Step 6: Environments**

In `sirdar/api/src/sirdar_api/deploy/environments.py`:

1. `ENV_TYPES = ("dev", "beta", "custom", "production")`. Import `certs`, `do_accounts`, `do_envs` from `sirdar_api.deploy` and `IntegrationError` from `sirdar_api.deploy.integrations`.
2. `_check_target`: change `if targets.is_vm_target(target_id):` to `if targets.is_built_target(target_id):` (docstring: "or None for a host Sirdar builds").
3. `_insert` takes `public_services: tuple[str, ...] = envfile.PUBLIC_SERVICES` and writes `hostname=(f"{service}.{domain}" if service in public_services else None)` instead of `_hostname(service, domain)`.
4. In `create_new`, add the parameter `do: dict | None = None`, and right after `cfg = await _precheck(...)`:

```python
    on_do = target_id == targets.DO_TARGET
    if type_ == "production" and not on_do:
        raise EnvError("production_requires_digitalocean")
    if do is not None and not on_do:
        raise EnvError("do_not_allowed")
    if on_do and vm is not None:
        raise EnvError("vm_not_allowed")
```

   and just before `if not proxy_ip:` (after the ports are checked), insert:

```python
    if on_do:
        return await _create_on_do(db, settings, name=name, type_=type_, git_ref=git_ref,
                                   domain=domain, ports=all_ports, actor_id=actor_id,
                                   snapshot_id=snapshot_id, do=do or {})
```

   (move the `given`/`unknown`/`all_ports`/`_check_ports_unique` block above the `proxy_ip` check so it runs first; it only reads `ports`).

5. Add `_create_on_do`:

```python
async def _create_on_do(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                        git_ref: str, domain: str, ports: dict[str, int], actor_id,
                        snapshot_id, do: dict) -> Environment:
    """A DigitalOcean environment: the account and sizes frozen, Caddy as the
    proxy on the droplet, publishing on (its plan has DNS), and only the
    public names its load balancer certificate covers."""
    try:
        spec = do_envs.check_spec(do, production=type_ == "production")
    except do_envs.DoEnvError as e:
        raise EnvError(e.code, **e.extra) from None
    try:
        account = await do_accounts.require(db, settings, spec["account"])
    except IntegrationError as e:
        raise EnvError(e.code, **e.extra) from None
    if account.region is None:
        raise EnvError("do_account_not_configured", account=spec["account"])
    if not await integrations.is_configured(db, "cloudflare"):
        raise EnvError("integration_not_configured", kinds=["cloudflare"])
    zone = (await integrations.config_of(db, "cloudflare")).get("zone") or ""
    if not (domain == zone or domain.endswith("." + zone)):
        raise EnvError("base_domain_not_in_zone")
    if type_ == "production" and await do_envs.production_exists(db):
        raise EnvError("production_exists")
    env = await _insert(
        db, settings, name=name, type_=type_, target_id=targets.DO_TARGET, git_ref=git_ref,
        host="0.0.0.0", domain=domain, proxy_ip=do_envs.CADDY_IP, bind_ip=do_envs.BIND_IP,
        ports=ports, keep_dumps=envfile.DEFAULT_KEEP_DUMPS,
        spaces_bucket=envfile.DEFAULT_SPACES_BUCKET, log_level=envfile.DEFAULT_LOG_LEVEL,
        status="new", current_sha=None, image_tag=None, secrets=vault.generate_env_secrets(),
        actor_id=actor_id, seed_snapshot_id=snapshot_id, publish=True,
        public_services=certs.PUBLIC_SERVICES)
    env.spaces_bucket = do_envs.bucket_name(env.name, env.id)
    await do_envs.add(db, settings, env, spec, region=account.region)
    return env
```

6. `adopt`: change `if targets.is_vm_target(target_id):` to `if targets.is_built_target(target_id):`.
7. In `update`, after `on_vm = targets.is_vm_target(env.target_id)`:

```python
    on_do = env.target_id == targets.DO_TARGET
    if on_do:
        # Its names, proxy, bucket and DNS belong to what step 0 built.
        attrs = {"target": "target_id"}
        for key in ("target", "proxy_ip", "bind_ip", "base_domain", "spaces_bucket", "publish"):
            if fields.get(key) is not None and fields[key] != getattr(env, attrs.get(key, key)):
                raise EnvError("do_field_locked", field=key)
    if fields.get("retiring") is not None:
        if env.type != "production":
            raise EnvError("retiring_not_allowed")
        put("retiring", bool(fields["retiring"]))
```

   change the target-move check to `if fields["target"] != env.target_id and (targets.is_built_target(env.target_id) or targets.is_built_target(fields["target"])):`, and the `host_ip` refusal to `if on_vm or on_do:`.

- [ ] **Step 7: Serialize**

In `sirdar/api/src/sirdar_api/deploy/serialize.py`:

1. `deployment_summary` adds `"cloud": dep.cloud, "slot": dep.slot, "go_live": dep.go_live` after `"vm_snapshot"`.
2. `environment_out`:

```python
async def _do_out(db: AsyncSession, env: Environment) -> dict | None:
    if env.target_id != targets.DO_TARGET:
        return None
    from sirdar_api.db.models import DoAccount
    from sirdar_api.deploy import do_envs
    row = await do_envs.get(db, env.id)
    if row is None:
        return None
    account = await db.get(DoAccount, row.account_key)
    return do_envs.public(env, row, await do_envs.slots_of(db, env.id),
                          await do_envs.resources_of(db, env.id), account.label)
```

   and in the returned dict: `"target_kind": env.target_id if targets.is_built_target(env.target_id) else "ssh"`, plus after `"vm"`: `"do": await _do_out(db, env), "slots": list(env.slots), "active_slot": env.active_slot, "auto_activate": env.auto_activate, "retiring": env.retiring,`.

- [ ] **Step 8: Routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

```python
ENV_TARGET_PATTERN = r"^(ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*|proxmox|esxi|digitalocean)$"
EnvType = Literal["dev", "beta", "custom", "production"]
```

Add to `_ENV_STATUS`: `"do_account_not_configured": 409, "production_exists": 409`. Add:

```python
class DoIn(BaseModel):
    """A DigitalOcean environment (mode "new", target "digitalocean")."""
    account: Literal["production", "development"] | None = None
    slots: int | None = None
    droplet_size: str | None = Field(default=None, max_length=40)
    db_size: str | None = Field(default=None, max_length=40)
    db_standby: bool | None = None
    acme_staging: bool | None = None
```

`EnvironmentIn` gains `do: DoIn | None = None`; `EnvironmentPatch` gains `retiring: bool | None = None` and `confirm_name: str | None = Field(default=None, max_length=64)`.

In `create_environment`: `if body.mode == "adopt" and body.do is not None: raise HTTPException(422, {"code": "do_not_allowed"})`; pass `do=body.do.model_dump(exclude_none=True) if body.do else None` to `create_new`; add `if body.do is not None: changes["do"] = body.do.model_dump(exclude_none=True)` to the audit.

In `update_environment`, before calling `environments.update`:

```python
    if body.retiring is not None and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    fields = body.model_dump(exclude_unset=True)
    fields.pop("confirm_name", None)
```

and pass `fields`.

In `environment_defaults`, add:

```python
        "do": {"droplet_size": do_envs.DEFAULT_DROPLET_SIZE, "db_size": do_envs.DEFAULT_DB_SIZE,
               "db_standby": False, "production_slots": list(do_envs.PRODUCTION_SLOTS),
               "one_slot": list(do_envs.ONE_SLOT), "two_slots": list(do_envs.TWO_SLOTS)},
```

(import `do_envs`).

- [ ] **Step 9: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_environments.py tests/test_deploy_environments.py tests/test_deploy_environments_api.py tests/test_deploy_vms.py tests/test_deploy_esxi_vms.py tests/test_deploy_vm_api.py`
Expected: all PASS.

- [ ] **Step 10: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/do_envs.py src/sirdar_api/deploy/targets.py src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/vms.py src/sirdar_api/deploy/serialize.py src/sirdar_api/api/routes/deploy.py tests/do_helpers.py tests/test_deploy_do_environments.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/do_envs.py sirdar/api/src/sirdar_api/deploy/targets.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/vms.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/do_helpers.py sirdar/api/tests/test_deploy_do_environments.py
git commit -m "feat(sirdar): DigitalOcean environments — records, slots, production rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The stack — external data, the network subnet and the Caddy `proxy` stack

**Files:**
- Modify: `deploy/stack/ss-stack` (replaced whole, below)
- Modify: `deploy/stack/api/compose.yml`, `deploy/stack/status/compose.yml` (nested defaults)
- Create: `deploy/stack/proxy/compose.yml`, `deploy/stack/proxy/Caddyfile`
- Modify: `deploy/stack/env.example`, `deploy/stack/README.md`
- Create: `sirdar/api/tests/test_deploy_stack_external.py`

**Interfaces:**
- Produces (read by Task 8's render and playbooks):
  - `.env` keys: `STACK_EXTERNAL_DATA=1`, `STACK_CADDY=1`, `STACK_NETWORK_SUBNET`, `STACK_HOSTS_IP`, `STACK_TRUSTED_PROXIES`, `STACK_DB_HOST`, `STACK_DB_PORT`, `STACK_DB_NAME`, `STACK_DB_USER`, `SS_DATABASE_URL`, `SS_DATABASE_SSL`, `SS_SPACES_ENDPOINT`, `SS_SPACES_REGION`, `SS_SPACES_ACCESS_KEY`, `SS_SPACES_SECRET_KEY`, `SS_SPACES_USE_PATH_STYLE`, `STACK_DROPLET_ID`.
  - `ss-stack pgdump <env-dir> <out>` (custom format, `--no-owner --no-acl`) and `ss-stack revision <env-dir>` (prints the Alembic revision), in both modes.
  - Caddy answers `/caddy-health` on `127.0.0.1`, proxies the load balancer's `/healthz` (any host outside the domain) to the API, sends `/.well-known/acme-challenge/*` to `cert-worker:8089`, redirects `X-Forwarded-Proto: http` to HTTPS, and routes `api.`, `portal.`, `kiosk.`, `wiki.`, `status.` to their services.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_stack_external.py`:

```python
"""deploy/stack for DigitalOcean droplets: ss-stack's external-data mode
(no db/storage stacks except mailpit, a fixed network subnet, the managed
database through one-off postgres containers whose password never reaches
argv), the Caddy proxy stack, and the compose files' nested defaults.

ss-stack runs against a fake `docker` on PATH that logs its argv (and the
PGPASSWORD it was given, separately). The compose and Caddy checks need a
real Docker and skip without one; the Caddy run also needs SS_STACK_E2E=1."""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
STACK = REPO / "deploy" / "stack"
SS_STACK = STACK / "ss-stack"
PASSWORD = "a1b2" * 16

FAKE_DOCKER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ -n ${PGPASSWORD:-} ]]; then printf '%s\\n' "$PGPASSWORD" >> "$DOCKER_LOG.pw"; fi
case "$1 $2" in
  "network inspect") [[ -f "$DOCKER_LOG.net" ]] && { echo 172.30.0.0/24; exit 0; }; exit 1 ;;
  "network create") touch "$DOCKER_LOG.net" ;;
esac
case "$*" in *pg_dump*) printf 'PGDMP' ;; *"SELECT version_num"*) echo 0089 ;; esac
exit 0
"""


def _env_dir(tmp_path: Path, external: bool) -> Path:
    env_dir = tmp_path / "env"
    env_dir.mkdir()
    lines = ["STACK_ENV=uat9", "STACK_DOMAIN=uat9.serversherpa.com", "STACK_IMAGE_TAG=abc12345",
             "STACK_REPO_DIR=/opt/serversherpa/uat9/repo", "STACK_PROXY_IP=172.30.0.2",
             "STACK_BIND_IP=127.0.0.1", "STACK_KEEP_DUMPS=5", f"POSTGRES_PASSWORD={PASSWORD}",
             "SPACES_SECRET_KEY=x", "SS_JWT_SECRET=x", "SS_TOTP_ENCRYPTION_KEY=x",
             "SS_PASSWORD_PEPPER=x", "SS_WIKI_SERVICE_TOKEN=x"]
    if external:
        lines += ["STACK_EXTERNAL_DATA=1", "STACK_CADDY=1",
                  "STACK_NETWORK_SUBNET=172.30.0.0/24",
                  "STACK_DB_HOST=private-ss-uat9-db.db.ondigitalocean.com",
                  "STACK_DB_PORT=25060", "STACK_DB_NAME=serversherpa", "STACK_DB_USER=serversherpa"]
    (env_dir / ".env").write_text("\n".join(lines) + "\n")
    return env_dir


def _run(tmp_path: Path, *args, stdin: bytes | None = None) -> tuple[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    log = tmp_path / "docker.log"
    env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "DOCKER_LOG": str(log)}
    subprocess.run([str(SS_STACK), *args], env=env, check=True, input=stdin,
                   capture_output=True)
    pw = Path(f"{log}.pw")
    return log.read_text(), pw.read_text() if pw.exists() else ""


def test_ss_stack_parses_and_documents_the_new_commands():
    subprocess.run(["bash", "-n", str(SS_STACK)], check=True)
    text = SS_STACK.read_text()
    assert "ss-stack pgdump" in text and "ss-stack revision" in text


def test_up_external_skips_local_data_and_starts_caddy(tmp_path):
    log, _ = _run(tmp_path, "up", str(_env_dir(tmp_path, external=True)))
    assert "db/compose.yml" not in log
    assert re.search(r"storage/compose.yml up -d .* mailpit", log)
    assert "network create --subnet 172.30.0.0/24 ss-uat9" in log
    assert log.index("api/compose.yml run --rm migrate") < log.index("proxy/compose.yml up -d")


def test_up_local_is_unchanged(tmp_path):
    log, _ = _run(tmp_path, "up", str(_env_dir(tmp_path, external=False)))
    assert "db/compose.yml up -d" in log and "proxy/compose.yml" not in log
    assert "network create ss-uat9" in log


def test_dump_external_uses_a_one_off_client_and_keeps_the_password_off_argv(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    log, pw = _run(tmp_path, "dump", str(env_dir))
    assert "run --rm -i --network ss-uat9" in log and "postgres:16-alpine pg_dump" in log
    assert "-e PGSSLMODE=require" in log
    assert PASSWORD not in log and PASSWORD in pw
    dumps = list((env_dir / "backups").glob("*.dump"))
    assert len(dumps) == 1 and dumps[0].read_bytes() == b"PGDMP"


def test_restore_external(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    dump = tmp_path / "db.dump"
    dump.write_bytes(b"PGDMP")
    log, _ = _run(tmp_path, "restore", str(env_dir), str(dump), "--clear-sessions")
    assert "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" in log
    assert re.search(r"pg_restore --exit-on-error --no-owner --no-acl -d serversherpa", log)
    assert "DELETE FROM auth_sessions" in log
    assert "db/compose.yml" not in log


def test_pgdump_and_revision(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    out = tmp_path / "snap.dump"
    log, _ = _run(tmp_path, "pgdump", str(env_dir), str(out))
    assert out.read_bytes() == b"PGDMP" and "--no-owner --no-acl" in log
    _run(tmp_path, "revision", str(env_dir))


def test_caddyfile_routes_in_order():
    text = (STACK / "proxy" / "Caddyfile").read_text()
    assert "auto_https off" in text and "admin off" in text
    assert "trusted_proxies static {$STACK_TRUSTED_PROXIES}" in text
    order = ["respond @self", "reverse_proxy @lbhealth api:8000",
             "reverse_proxy /.well-known/acme-challenge/* cert-worker:8089",
             "redir @plain https://{host}{uri} 308", "reverse_proxy @api api:8000",
             "reverse_proxy @portal portal:8080", "reverse_proxy @kiosk kiosk:8080",
             "reverse_proxy @wiki wiki:8080", "reverse_proxy @status status:8080", "respond 404"]
    found = [text.index(line) for line in order]
    assert found == sorted(found)


def test_caddy_image_is_pinned_by_digest():
    compose = (STACK / "proxy" / "compose.yml").read_text()
    assert re.search(r"image: caddy:2\.[0-9.]+-alpine@sha256:[0-9a-f]{64}\n", compose)
    assert "ipv4_address: ${STACK_PROXY_IP:?set STACK_PROXY_IP}" in compose


needs_docker = pytest.mark.skipif(shutil.which("docker") is None, reason="needs docker")


@needs_docker
@pytest.mark.parametrize("external", [False, True])
def test_compose_nested_defaults(tmp_path, external):
    env_dir = _env_dir(tmp_path, external=external)
    if external:
        with (env_dir / ".env").open("a") as f:
            f.write("SS_DATABASE_URL=postgresql+asyncpg://serversherpa:pw@db.example:25060/"
                    "serversherpa\nSS_DATABASE_SSL=require\nSTACK_HOSTS_IP=203.0.113.50\n"
                    "SS_SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com\n"
                    "SS_SPACES_SECRET_KEY=do-secret\n")
    out = subprocess.run(["docker", "compose", "--env-file", str(env_dir / ".env"), "-f",
                          str(STACK / "api" / "compose.yml"), "config"],
                         check=True, capture_output=True, text=True).stdout
    if external:
        assert "db.example:25060" in out and "SS_DATABASE_SSL: require" in out
        assert "nyc3.digitaloceanspaces.com" in out and "203.0.113.50" in out
        assert "do-secret" in out
    else:
        assert "@postgres:5432/serversherpa" in out and "SS_DATABASE_SSL: disable" in out
        assert "https://spaces.uat9.serversherpa.com" in out and "172.30.0.2" in out


@needs_docker
@pytest.mark.skipif(os.environ.get("SS_STACK_E2E") != "1", reason="set SS_STACK_E2E=1")
def test_caddy_routes_in_a_container(tmp_path):
    """Caddy with the real Caddyfile in front of a busybox 'api' and
    'portal': health, host routing, the HTTPS redirect and the 404."""
    net = "ss-sirdar-caddy-e2e"
    subprocess.run(["docker", "network", "create", "--subnet", "172.30.9.0/24", net],
                   check=True, capture_output=True)
    names = []
    try:
        for name in ("api", "portal"):
            names.append(f"{net}-{name}")
            subprocess.run(["docker", "run", "-d", "--rm", "--name", f"{net}-{name}",
                            "--network", net, "--network-alias", name, "busybox:1.36",
                            "sh", "-c", f"mkdir -p /www && echo {name} > /www/index.html && "
                            f"echo ok > /www/healthz && httpd -f -p "
                            f"{8000 if name == 'api' else 8080} -h /www"], check=True,
                           capture_output=True)
        image = re.search(r"image: (\S+)", (STACK / "proxy" / "compose.yml").read_text()).group(1)
        names.append(f"{net}-caddy")
        subprocess.run(["docker", "run", "-d", "--rm", "--name", f"{net}-caddy", "--network", net,
                        "--ip", "172.30.9.2", "-e", "STACK_DOMAIN=uat9.serversherpa.com",
                        "-e", "STACK_TRUSTED_PROXIES=10.116.0.0/20",
                        "-v", f"{STACK / 'proxy' / 'Caddyfile'}:/etc/caddy/Caddyfile:ro", image],
                       check=True, capture_output=True)

        def curl(*args) -> str:
            return subprocess.run(["docker", "run", "--rm", "--network", net,
                                   "curlimages/curl:8.10.1", "-s", "-o", "/dev/null", "-w",
                                   "%{http_code} %{redirect_url}", *args],
                                  capture_output=True, text=True).stdout

        assert curl("http://172.30.9.2/healthz").startswith("200")
        assert curl("-H", "Host: portal.uat9.serversherpa.com",
                    "http://172.30.9.2/").startswith("200")
        assert curl("-H", "Host: portal.uat9.serversherpa.com", "-H", "X-Forwarded-Proto: http",
                    "http://172.30.9.2/x") == "308 https://portal.uat9.serversherpa.com/x"
        assert curl("-H", "Host: other.example", "http://172.30.9.2/").startswith("404")
    finally:
        for name in names:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        subprocess.run(["docker", "network", "rm", net], capture_output=True)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_stack_external.py`
Expected: FAIL (no `pgdump`, no `proxy/` folder).

- [ ] **Step 3: Replace `ss-stack`**

Replace `deploy/stack/ss-stack` with:

```bash
#!/usr/bin/env bash
# ss-stack — run one ServerSherpa environment's Compose stacks (db, storage,
# api, web, status, and proxy on a DigitalOcean droplet) on this host, in
# dependency order.
#
#   ss-stack build   <env-dir>              build every image at STACK_IMAGE_TAG
#   ss-stack up      <env-dir>              start or update everything, waiting on health
#   ss-stack down    <env-dir> [--volumes]  stop everything; --volumes also deletes the data
#   ss-stack ps      <env-dir>              list every stack's containers
#   ss-stack dump    <env-dir>              pg_dump into <env-dir>/backups (keeps STACK_KEEP_DUMPS)
#   ss-stack data    <env-dir>              start only the database and storage, waiting on health
#   ss-stack restore <env-dir> <file.dump> [--clear-sessions]
#                                           stop the app stacks, empty the database, pg_restore the
#                                           dump; --clear-sessions also signs everyone out
#   ss-stack pgdump  <env-dir> <out.dump>   pg_dump (custom, no owner or ACLs) to one file
#   ss-stack revision <env-dir>             print the database's Alembic revision
#
# <env-dir> holds the environment's .env (see env.example) and backups/.
# With STACK_EXTERNAL_DATA=1 (DigitalOcean) the database is a managed
# PostgreSQL and objects live in DigitalOcean Spaces: the db and storage
# stacks don't run (mailpit does), and the database commands use one-off
# postgres containers. With STACK_CADDY=1 the proxy stack (Caddy) runs last.
# Sirdar's deploy pipeline runs exactly these commands over SSH.
set -euo pipefail
# dumps hold every secret in the database: backups/ and its files are owner-only
umask 077

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAIT=(--wait --wait-timeout 300 --remove-orphans)
PG_IMAGE=postgres:16-alpine

die() { echo "ss-stack: $*" >&2; exit 1; }
usage() { sed -n '6,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

[[ $# -ge 2 ]] || usage
cmd=$1
env_dir=$(cd "$2" 2>/dev/null && pwd) || die "no such environment directory: $2"
shift 2
env_file="$env_dir/.env"
[[ -f $env_file ]] || die "missing $env_file (copy deploy/stack/env.example)"

# One value from the env file: last assignment wins, surrounding quotes dropped.
env_value() {
  local v
  v=$(sed -n "s/^$1=//p" "$env_file" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}

STACK_ENV=$(env_value STACK_ENV)
[[ $STACK_ENV =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]] \
  || die "STACK_ENV must be 2-32 lowercase letters, digits and hyphens (got '$STACK_ENV')"
NETWORK="ss-$STACK_ENV"
SUBNET=$(env_value STACK_NETWORK_SUBNET)
external() { [[ $(env_value STACK_EXTERNAL_DATA) == 1 ]]; }
caddy() { [[ $(env_value STACK_CADDY) == 1 ]]; }

if external; then STACKS=(storage api web status); else STACKS=(db storage api web status); fi
if caddy; then STACKS+=(proxy); fi

dc() {  # dc <stack> <compose args…>
  local stack=$1; shift
  docker compose --env-file "$env_file" -f "$STACK_DIR/$stack/compose.yml" "$@"
}

ensure_network() {
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    if [[ -n $SUBNET ]]; then
      local have
      have=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NETWORK")
      [[ $have == "$SUBNET" ]] \
        || die "network $NETWORK has subnet '$have', not $SUBNET: remove it (docker network rm $NETWORK) and run again"
    fi
    return
  fi
  if [[ -n $SUBNET ]]; then
    docker network create --subnet "$SUBNET" "$NETWORK" >/dev/null
  else
    docker network create "$NETWORK" >/dev/null
  fi
}

# The managed database: a one-off client container on the environment's
# network. The password reaches docker through the environment, never argv.
pg() {  # pg <client> [args…] — stdin and stdout pass through
  local client=$1; shift
  PGPASSWORD=$(env_value POSTGRES_PASSWORD) docker run --rm -i --network "$NETWORK" \
    -e PGPASSWORD -e PGSSLMODE=require \
    -e PGHOST="$(env_value STACK_DB_HOST)" -e PGPORT="$(env_value STACK_DB_PORT)" \
    -e PGUSER="$(env_value STACK_DB_USER)" -e PGDATABASE="$(env_value STACK_DB_NAME)" \
    "$PG_IMAGE" "$client" "$@"
}

# The local database container (db stack).
pg_local() {  # pg_local <client> [args…]
  local client=$1; shift
  dc db exec -T postgres "$client" -U serversherpa -d serversherpa "$@"
}

psql_run() {  # psql_run <sql> — on whichever database this environment uses
  if external; then
    pg psql -v ON_ERROR_STOP=1 -q -c "$1" </dev/null
  else
    pg_local psql -v ON_ERROR_STOP=1 -q -c "$1" </dev/null
  fi
}

data_up() {
  if external; then
    dc storage up -d "${WAIT[@]}" mailpit
  else
    dc db up -d "${WAIT[@]}"
    dc storage up -d "${WAIT[@]}"
  fi
}

# A restored copy's sessions and remembered browsers belong to the source.
CLEAR_SESSIONS="DO \$\$ BEGIN IF to_regclass('public.auth_sessions') IS NOT NULL THEN DELETE FROM auth_sessions; END IF; IF to_regclass('public.trusted_devices') IS NOT NULL THEN DELETE FROM trusted_devices; END IF; END \$\$;"

refuse_placeholders() {
  local left
  left=$(grep -oE '^[A-Z0-9_]+=CHANGEME' "$env_file" | cut -d= -f1 | tr '\n' ' ' || true)
  [[ -z $left ]] || die "replace the CHANGEME values in $env_file: $left"
}

# pg_dump to stdout, custom format; extra args pass through.
dump_db() {
  if external; then
    pg pg_dump -Fc "$@" </dev/null
  else
    pg_local pg_dump -Fc "$@"
  fi
}

case $cmd in
  build)
    [[ $# -eq 0 ]] || usage
    refuse_placeholders
    docker compose --env-file "$env_file" -f "$STACK_DIR/build.yml" build
    ;;
  up)
    [[ $# -eq 0 ]] || usage
    refuse_placeholders
    ensure_network
    data_up
    dc api run --rm migrate
    dc api up -d "${WAIT[@]}"
    dc web up -d "${WAIT[@]}"
    dc status up -d "${WAIT[@]}"
    if caddy; then dc proxy up -d "${WAIT[@]}"; fi
    ;;
  down)
    volumes=""
    if [[ ${1:-} == --volumes ]]; then volumes="--volumes"; shift; fi
    [[ $# -eq 0 ]] || usage
    for (( i=${#STACKS[@]}-1; i>=0; i-- )); do
      # $volumes is deliberately unquoted: empty means no argument at all
      # shellcheck disable=SC2086
      dc "${STACKS[i]}" down $volumes
    done
    if [[ -n $volumes ]]; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
    ;;
  data)
    [[ $# -eq 0 ]] || usage
    refuse_placeholders
    ensure_network
    data_up
    ;;
  restore)
    [[ $# -eq 1 || $# -eq 2 ]] || usage
    dump=$1
    clear=""
    if [[ $# -eq 2 ]]; then
      [[ $2 == --clear-sessions ]] || usage
      clear=1
    fi
    [[ -f $dump && -r $dump ]] || die "no such dump file: $dump"
    refuse_placeholders
    ensure_network
    # nothing may write while the database is replaced: stop the writers
    # (stopping a stack that isn't running is a no-op), keep the database up
    for s in status web api; do dc "$s" stop </dev/null; done
    if ! external; then dc db up -d "${WAIT[@]}" </dev/null; fi
    # an empty schema, never pg_restore --clean: tables a newer migration
    # created aren't in the dump, and --clean would leave them behind
    psql_run 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' \
      || die "couldn't empty the database"
    if external; then
      pg pg_restore --exit-on-error --no-owner --no-acl -d "$(env_value STACK_DB_NAME)" \
        < "$dump" || die "pg_restore failed"
    else
      dc db exec -T postgres pg_restore --exit-on-error --no-owner --no-acl \
        -U serversherpa -d serversherpa < "$dump" || die "pg_restore failed"
    fi
    if [[ -n $clear ]]; then
      psql_run "$CLEAR_SESSIONS" || die "couldn't clear the sessions"
    fi
    echo "restored $dump"
    ;;
  ps)
    [[ $# -eq 0 ]] || usage
    for s in "${STACKS[@]}"; do dc "$s" ps; done
    ;;
  dump)
    [[ $# -eq 0 ]] || usage
    keep=$(env_value STACK_KEEP_DUMPS)
    keep=${keep:-5}
    [[ $keep =~ ^[1-9][0-9]*$ ]] || die "STACK_KEEP_DUMPS must be a whole number above 0"
    mkdir -p "$env_dir/backups"
    out="$env_dir/backups/$(date -u +%Y%m%dT%H%M%SZ).dump"
    # pg_dump writes to a .partial that becomes the .dump only once it
    # succeeds, so an error, Ctrl-C or dropped SSH session never leaves a
    # truncated file that looks like a backup. The signal traps turn a
    # signal into an exit so the EXIT trap removes the partial.
    partial="$out.partial"
    trap 'rm -f "$partial"' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if ! dump_db > "$partial"; then
      die "pg_dump failed"
    fi
    mv "$partial" "$out"
    # names are UTC timestamps, so name order is age order (newest first).
    # Only *.dump counts: a stray .partial (maybe a dump still running) is
    # never counted and never deleted here.
    printf '%s\n' "$env_dir/backups"/*.dump | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r old; do
      rm -f "$old"
    done
    echo "$out"
    ;;
  pgdump)
    [[ $# -eq 1 ]] || usage
    out=$1
    partial="$out.partial"
    trap 'rm -f "$partial"' EXIT
    dump_db --no-owner --no-acl > "$partial" || die "pg_dump failed"
    mv "$partial" "$out"
    ;;
  revision)
    [[ $# -eq 0 ]] || usage
    if external; then
      pg psql -tAc 'SELECT version_num FROM alembic_version' </dev/null
    else
      pg_local psql -tAc 'SELECT version_num FROM alembic_version'
    fi
    ;;
  *)
    usage
    ;;
esac
```

Keep the file executable (`git update-index --chmod=+x` is not needed: rewriting the content keeps the mode).

- [ ] **Step 4: Nested defaults in the compose files**

In `deploy/stack/api/compose.yml`, replace the database, Spaces and proxy lines of `x-ss-env` and the `extra_hosts` list:

```yaml
  # Local stacks: the db stack's postgres; a DigitalOcean droplet's .env sets
  # SS_DATABASE_URL (the managed database) and SS_DATABASE_SSL=require.
  SS_DATABASE_URL: ${SS_DATABASE_URL:-postgresql+asyncpg://serversherpa:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@postgres:5432/serversherpa}
  SS_DATABASE_SSL: ${SS_DATABASE_SSL:-disable}
```

```yaml
  # presigned URLs are signed for this host, so it must be the public name;
  # a DigitalOcean droplet's .env points these at its Spaces bucket
  SS_SPACES_ENDPOINT: ${SS_SPACES_ENDPOINT:-https://spaces.${STACK_DOMAIN}}
  SS_SPACES_REGION: ${SS_SPACES_REGION:-us-east-1}
  SS_SPACES_BUCKET: ${SS_SPACES_BUCKET:-serversherpa}
  SS_SPACES_ACCESS_KEY: ${SS_SPACES_ACCESS_KEY:-serversherpa}
  SS_SPACES_SECRET_KEY: ${SS_SPACES_SECRET_KEY:-${SPACES_SECRET_KEY:?set SPACES_SECRET_KEY}}
  SS_SPACES_USE_PATH_STYLE: ${SS_SPACES_USE_PATH_STYLE:-true}
```

```yaml
  # the public names go straight to NPM on the LAN (or, on a DigitalOcean
  # droplet, to the load balancer: STACK_HOSTS_IP), never out and back
  # through the router (hairpin NAT is not a given)
  extra_hosts:
    - "api.${STACK_DOMAIN}:${STACK_HOSTS_IP:-${STACK_PROXY_IP:?set STACK_PROXY_IP}}"
    - "portal.${STACK_DOMAIN}:${STACK_HOSTS_IP:-${STACK_PROXY_IP}}"
    - "kiosk.${STACK_DOMAIN}:${STACK_HOSTS_IP:-${STACK_PROXY_IP}}"
    - "wiki.${STACK_DOMAIN}:${STACK_HOSTS_IP:-${STACK_PROXY_IP}}"
    - "spaces.${STACK_DOMAIN}:${STACK_HOSTS_IP:-${STACK_PROXY_IP}}"
    - "status.${STACK_DOMAIN}:${STACK_HOSTS_IP:-${STACK_PROXY_IP}}"
```

`FORWARDED_ALLOW_IPS` stays `${STACK_PROXY_IP:?set STACK_PROXY_IP}` (on a droplet that is Caddy's fixed address). Make the same `extra_hosts` change in `deploy/stack/status/compose.yml`, and add to its header comment: "On a DigitalOcean droplet they resolve to the load balancer (STACK_HOSTS_IP)."

- [ ] **Step 5: The proxy stack**

Create `deploy/stack/proxy/Caddyfile`:

```
# The edge on a DigitalOcean droplet (STACK_CADDY=1): plain HTTP on :80
# behind the load balancer, which terminates HTTPS. One route list, in this
# order: Caddy's own health, the load balancer's health check (any host
# outside the environment's domain: the API's health), Let's Encrypt
# HTTP-01 for the cert-worker, plain HTTP to HTTPS, then each public name.
# Client IPs come only from the load balancer (the VPC's range).
{
	auto_https off
	admin off
	servers {
		trusted_proxies static {$STACK_TRUSTED_PROXIES}
		client_ip_headers X-Forwarded-For
	}
}

:80 {
	@self {
		path /caddy-health
		remote_ip 127.0.0.1
	}
	@lbhealth {
		path /healthz
		not host *.{$STACK_DOMAIN}
	}
	@plain header X-Forwarded-Proto http
	@api host api.{$STACK_DOMAIN}
	@portal host portal.{$STACK_DOMAIN}
	@kiosk host kiosk.{$STACK_DOMAIN}
	@wiki host wiki.{$STACK_DOMAIN}
	@status host status.{$STACK_DOMAIN}

	route {
		respond @self "ok" 200
		reverse_proxy @lbhealth api:8000
		reverse_proxy /.well-known/acme-challenge/* cert-worker:8089
		redir @plain https://{host}{uri} 308
		reverse_proxy @api api:8000 {
			header_up X-Forwarded-For {client_ip}
		}
		reverse_proxy @portal portal:8080 {
			header_up X-Forwarded-For {client_ip}
		}
		reverse_proxy @kiosk kiosk:8080 {
			header_up X-Forwarded-For {client_ip}
		}
		reverse_proxy @wiki wiki:8080 {
			header_up X-Forwarded-For {client_ip}
		}
		reverse_proxy @status status:8080 {
			header_up X-Forwarded-For {client_ip}
		}
		respond 404
	}
}
```

Look up the current Caddy 2 Alpine image's digest (the newest `2.x.y-alpine` tag on Docker Hub; 2.10.2 or later):

```bash
docker buildx imagetools inspect caddy:2.10.2-alpine --format '{{json .Manifest.Digest}}'
```

Create `deploy/stack/proxy/compose.yml`, putting that tag and digest in `image:`:

```yaml
# Caddy, the edge on a DigitalOcean droplet (STACK_CADDY=1): the only
# published port on the droplet (:80, reachable only from the load balancer
# through the cloud firewall). It sits at a fixed address on the ss-<env>
# network (STACK_PROXY_IP, in STACK_NETWORK_SUBNET), which is what
# FORWARDED_ALLOW_IPS trusts. Pinned by digest.
name: ss-${STACK_ENV:?set STACK_ENV}-proxy

services:
  caddy:
    image: caddy:2.10.2-alpine@sha256:<the 64-hex digest from the command above>
    environment:
      STACK_DOMAIN: ${STACK_DOMAIN:?set STACK_DOMAIN}
      STACK_TRUSTED_PROXIES: ${STACK_TRUSTED_PROXIES:?set STACK_TRUSTED_PROXIES}
    ports:
      - "0.0.0.0:80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    networks:
      default:
        ipv4_address: ${STACK_PROXY_IP:?set STACK_PROXY_IP}
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/caddy-health"]
      interval: 10s
      timeout: 5s
      retries: 6
    restart: unless-stopped

networks:
  default:
    name: ss-${STACK_ENV}
    external: true
```

- [ ] **Step 6: env.example and README**

Append to `deploy/stack/env.example`:

```
# ── DigitalOcean droplet (Sirdar writes these; leave them out elsewhere) ──
# STACK_EXTERNAL_DATA=1          managed PostgreSQL + Spaces: no db/storage stacks
# STACK_CADDY=1                  run the proxy stack (Caddy on :80)
# STACK_NETWORK_SUBNET=172.30.0.0/24
# STACK_HOSTS_IP=                the load balancer: public names inside containers
# STACK_TRUSTED_PROXIES=         the VPC's range: Caddy trusts X-Forwarded-* from it
# STACK_DB_HOST= STACK_DB_PORT= STACK_DB_NAME=serversherpa STACK_DB_USER=serversherpa
# SS_DATABASE_URL= SS_DATABASE_SSL=require
# SS_SPACES_ENDPOINT= SS_SPACES_REGION= SS_SPACES_ACCESS_KEY= SS_SPACES_SECRET_KEY=
# SS_SPACES_USE_PATH_STYLE=false
# STACK_DROPLET_ID=
```

In `deploy/stack/README.md`, add `proxy | caddy | 80 (DigitalOcean droplets only)` to the table, and a section "DigitalOcean droplets (Sirdar phase 7)" saying: Sirdar writes the keys above; `ss-stack` then skips the `db` and `storage` stacks (mailpit still runs), dumps and restores through a one-off `postgres:16-alpine` container against the managed database (`PGSSLMODE=require`, the password from `POSTGRES_PASSWORD`), creates `ss-<env>` with `STACK_NETWORK_SUBNET`, and starts the `proxy` stack last; `pgdump` and `revision` serve snapshots in both modes.

- [ ] **Step 7: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_stack_external.py tests/test_deploy_playbooks.py`
Expected: PASS (the Docker tests skip without Docker; run them where Docker exists, and `SS_STACK_E2E=1` for the Caddy run).

- [ ] **Step 8: Lint and commit**

```bash
bash -n ../../deploy/stack/ss-stack && (command -v shellcheck >/dev/null && shellcheck ../../deploy/stack/ss-stack || true)
.venv/bin/ruff check --select E,F,W --ignore F811 tests/test_deploy_stack_external.py
cd ../.. && git add deploy/stack/ss-stack deploy/stack/api/compose.yml deploy/stack/status/compose.yml deploy/stack/proxy/compose.yml deploy/stack/proxy/Caddyfile deploy/stack/env.example deploy/stack/README.md sirdar/api/tests/test_deploy_stack_external.py
git commit -m "feat(stack): external data for DigitalOcean droplets and the Caddy proxy stack

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The `.env` extras, the new step definitions, the playbooks and `bundle.py`

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/envfile.py` (`EnvConfig.extra`, `EXTRA_KEYS`)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_envs.py` (`env_extra`)
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (the four new `StepDef`s only; plans are Task 11)
- Modify: `sirdar/api/src/sirdar_api/deploy/ansible/dump.yml`, `export.yml`, `restore.yml`, `bootstrap.yml`
- Create: `sirdar/api/src/sirdar_api/deploy/ansible/slot_smoke.yml`
- Modify: `sirdar/api/src/sirdar_api/deploy/bundle.py` (`--region`; `SS_SPACES_SECRET_KEY`)
- Modify: `sirdar/api/tests/test_deploy_envfile.py`, `test_deploy_playbooks.py`, `test_deploy_bundle.py`, `test_deploy_do_environments.py`

**Interfaces:**
- Consumes: the `.env` keys of Task 7; `DoEnvironment`, `DoSlot` (Task 1); `do_envs.get` (Task 6).
- Produces:
  - `envfile.EXTRA_KEYS` (the DigitalOcean keys; 7b appends the cert-worker's) and `EnvConfig(..., extra: dict[str, str] = {})`, rendered after the optional secrets in the given order. A key outside `EXTRA_KEYS` is `RenderError("unknown key <KEY>")`.
  - `async do_envs.env_extra(db, settings, env, slot, secrets: dict[str, str]) -> tuple[dict[str, str], list[str]]` — the extras and the secret values among them; `DoEnvError("do_not_ready", missing=[…])` when step 0 hasn't recorded what they need.
  - `steps.STEPS` gains `0 do_prepare "Prepare DigitalOcean"` (vm, 60 min), `13 slot_smoke "Smoke test (slot)"` (`slot_smoke.yml`, 10 min), `14 go_live "Switch traffic"` (vm, 15 min), `18 do_destroy "Remove DigitalOcean resources"` (vm, 60 min).
  - Playbook variables: `external_data` (bool), `spaces_endpoint`, `spaces_key_id`, `spaces_region` (export/restore), `public_hosts` (list of `{service, hostname, path}`), `slot_port`, `slot_smoke_retries`, `slot_smoke_delay` (slot_smoke), `block_metadata` (bootstrap).
  - `bundle.py` objects commands take `--region` (default `us-east-1`); the secret comes from `SNAP_S3_SECRET`, then `SS_SPACES_SECRET_KEY`, then `SPACES_SECRET_KEY`.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/test_deploy_envfile.py`:

```python
def test_extras_render_after_the_optional_secrets():
    text = envfile.render_env(_cfg(extra={"STACK_EXTERNAL_DATA": "1", "SS_DATABASE_SSL": "require",
                                          "STACK_DB_PORT": "25060"}))
    keys = _keys(text)
    assert keys[-3:] == ["STACK_EXTERNAL_DATA", "SS_DATABASE_SSL", "STACK_DB_PORT"]
    assert keys.index("SS_DB_TESTING_PASSWORD") < keys.index("STACK_EXTERNAL_DATA")
    assert envfile.parse_env(text)["STACK_DB_PORT"] == "25060"


@pytest.mark.parametrize("extra, reason", [
    ({"NOT_ALLOWED": "1"}, "unknown key NOT_ALLOWED"),
    ({"POSTGRES_PASSWORD": "x"}, "unknown key POSTGRES_PASSWORD"),
    ({"SS_DATABASE_URL": "a\nB=c"}, "SS_DATABASE_URL contains a control or line-break character"),
])
def test_extras_are_checked(extra, reason):
    with pytest.raises(RenderError) as err:
        envfile.render_env(_cfg(extra=extra))
    assert err.value.reason == reason


def test_extras_stay_out_of_repr():
    cfg = _cfg(extra={"SS_SPACES_SECRET_KEY": "spaces-SECRET"})
    assert "spaces-SECRET" not in repr(cfg)
```

Append to `sirdar/api/tests/test_deploy_do_environments.py`:

```python
async def test_env_extra(db):
    from .deploy_factories import ENV_SECRETS
    env = await make_do_environment(db)
    with pytest.raises(do_envs.DoEnvError) as e:
        await do_envs.env_extra(db, get_settings(), env, "orange", ENV_SECRETS)
    assert e.value.code == "do_not_ready"
    assert e.value.extra["missing"] == ["load balancer address", "VPC range", "database host",
                                        "Spaces key", "droplet"]
    from sirdar_api.deploy import vault
    await do_envs.set_do(env.id, lb_ip="203.0.113.50", vpc_ip_range="10.116.0.0/20",
                         db_host="private-ss-uat9-db.db.ondigitalocean.com", db_port=25060,
                         spaces_key_id="DO00KEY000001",
                         spaces_secret_enc=vault.encrypt(get_settings(), "spaces-SECRET-1"))
    await do_envs.set_slot(env.id, "orange", droplet_id="4001", public_ip="127.0.0.1")
    extra, secrets = await do_envs.env_extra(db, get_settings(), env, "orange", ENV_SECRETS)
    password = ENV_SECRETS["POSTGRES_PASSWORD"]
    assert extra == {
        "STACK_EXTERNAL_DATA": "1", "STACK_CADDY": "1", "STACK_NETWORK_SUBNET": "172.30.0.0/24",
        "STACK_HOSTS_IP": "203.0.113.50", "STACK_TRUSTED_PROXIES": "10.116.0.0/20",
        "STACK_DB_HOST": "private-ss-uat9-db.db.ondigitalocean.com", "STACK_DB_PORT": "25060",
        "STACK_DB_NAME": "serversherpa", "STACK_DB_USER": "serversherpa",
        "SS_DATABASE_URL": "postgresql+asyncpg://serversherpa:"
                           f"{password}@private-ss-uat9-db.db.ondigitalocean.com:25060/serversherpa",
        "SS_DATABASE_SSL": "require", "SS_SPACES_ENDPOINT": "https://nyc3.digitaloceanspaces.com",
        "SS_SPACES_REGION": "nyc3", "SS_SPACES_ACCESS_KEY": "DO00KEY000001",
        "SS_SPACES_SECRET_KEY": "spaces-SECRET-1", "SS_SPACES_USE_PATH_STYLE": "false",
        "STACK_DROPLET_ID": "4001"}
    assert set(secrets) == {extra["SS_DATABASE_URL"], "spaces-SECRET-1"}
    assert list(extra) == [k for k in envfile.EXTRA_KEYS if k in extra]
```

(add `from sirdar_api.deploy import envfile` to that file's imports).

In `sirdar/api/tests/test_deploy_playbooks.py`:
1. In `test_plans`, change the first assertion to:

```python
    assert [s.number for s in steps.STEPS] == [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11,
                                               12, 13, 13, 14, 14, 15, 15, 16, 17, 18]
```

2. Append:

```python
EXTERNAL_ENV = ("STACK_EXTERNAL_DATA=1\nSTACK_NETWORK_SUBNET=172.30.0.0/24\n"
                "STACK_DB_HOST=db.internal\nSTACK_DB_PORT=25060\nSTACK_DB_NAME=serversherpa\n"
                "STACK_DB_USER=serversherpa\nSS_SPACES_SECRET_KEY=spaces-SECRET\n")
SPACES_VARS = {"external_data": True, "spaces_endpoint": "https://nyc3.digitaloceanspaces.com",
               "spaces_key_id": "DO00KEY000001", "spaces_region": "nyc3"}
SPACES_ARGS = ("--endpoint https://nyc3.digitaloceanspaces.com --key-id DO00KEY000001 "
               "--region nyc3")


def _external(env_dir: Path) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(EXTERNAL_ENV)


def test_dump_playbook_on_a_managed_database(tmp_path):
    env_dir, env = _target(tmp_path)
    _external(env_dir)
    result, calls = _play(tmp_path, "dump.yml", {**_common(env_dir), "external_data": True,
                                                "dump_required": True}, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not any(c.startswith("ps ") or c.startswith("volume ") for c in calls)
    assert any("postgres:16-alpine pg_dump -Fc" in c for c in calls)


def test_export_playbook_on_a_managed_database(tmp_path):
    env_dir, env = _target(tmp_path)
    _external(env_dir)
    dest = tmp_path / "sirdar" / "incoming" / "snap.tar.gz"
    result, calls = _play(tmp_path, "export.yml", {**_export_vars(env_dir, dest), **SPACES_VARS},
                          env)
    out = result.stdout + result.stderr
    assert result.returncode == 0, out
    assert not any("db/compose.yml" in c for c in calls)
    assert any("postgres:16-alpine psql -tAc SELECT version_num FROM alembic_version" in c
               for c in calls)
    assert any("pg_dump -Fc --no-owner --no-acl" in c for c in calls)
    assert any(c.endswith(f"export-objects --out /work/objects.tar {SPACES_ARGS}") for c in calls)
    assert bundle.read_head(dest)[0]["alembic_revision"] == "0089"
    assert "spaces-SECRET" not in out


def test_restore_playbook_on_a_managed_database(tmp_path):
    env_dir, env = _target(tmp_path)
    _external(env_dir)
    snap = make_bundle(tmp_path)
    result, calls = _play(tmp_path, "restore.yml", {**_restore_vars(env_dir, snap), **SPACES_VARS},
                          env)
    out = result.stdout + result.stderr
    assert result.returncode == 0, out
    assert any("pg_restore --exit-on-error --no-owner --no-acl -d serversherpa" in c
               for c in calls)
    assert calls[-1].endswith(f"import-objects --in /work/objects.tar {SPACES_ARGS}")


class _Answer(BaseHTTPRequestHandler):
    status = 200
    seen: list = []

    def do_GET(self):  # noqa: N802
        type(self).seen.append((self.headers["Host"], self.path,
                                self.headers["X-Forwarded-Proto"]))
        self.send_response(type(self).status)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.mark.parametrize("status, ok", [(200, True), (308, True), (502, False)])
def test_slot_smoke_playbook(tmp_path, status, ok):
    _Answer.status, _Answer.seen = status, []
    server = HTTPServer(("127.0.0.1", 0), _Answer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        env_dir, env = _target(tmp_path)
        hosts = [{"service": "api", "hostname": "api.e2e.serversherpa.com", "path": "/healthz"},
                 {"service": "portal", "hostname": "portal.e2e.serversherpa.com", "path": "/"}]
        result, _ = _play(tmp_path, "slot_smoke.yml", {
            **_common(env_dir), "public_hosts": hosts, "slot_port": server.server_port,
            "slot_smoke_retries": 1, "slot_smoke_delay": 0}, env)
    finally:
        server.shutdown()
    assert (result.returncode == 0) is ok, result.stdout + result.stderr
    assert ("api.e2e.serversherpa.com", "/healthz", "https") in _Answer.seen
    if not ok:
        assert "api.e2e.serversherpa.com" in result.stdout


def test_bootstrap_blocks_the_metadata_service_only_when_asked():
    text = (PLAYBOOK_DIR / "bootstrap.yml").read_text()
    assert "block_metadata | default(false) | bool" in text
    assert "iptables -I DOCKER-USER -d 169.254.169.254 -j REJECT" in text
    assert "PartOf=docker.service" in text
```

and add `import threading` and `from http.server import BaseHTTPRequestHandler, HTTPServer` to its imports.

Append to `sirdar/api/tests/test_deploy_bundle.py`:

```python
def test_objects_commands_take_the_spaces_secret_and_region(monkeypatch, tmp_path):
    seen = {}

    def fake_client(endpoint, key_id, secret, region="us-east-1"):
        seen.update(endpoint=endpoint, key_id=key_id, secret=secret, region=region)
        raise bundle.BundleError("stop here")

    monkeypatch.setattr(bundle, "s3_client", fake_client)
    monkeypatch.delenv("SNAP_S3_SECRET", raising=False)
    monkeypatch.setenv("SPACES_SECRET_KEY", "local-seaweed")
    monkeypatch.setenv("SS_SPACES_SECRET_KEY", "do-spaces")
    assert bundle.main(["export-objects", "--out", str(tmp_path / "o.tar"), "--endpoint",
                        "https://nyc3.digitaloceanspaces.com", "--key-id", "DO00KEY",
                        "--region", "nyc3"]) == 1
    assert seen == {"endpoint": "https://nyc3.digitaloceanspaces.com", "key_id": "DO00KEY",
                    "secret": "do-spaces", "region": "nyc3"}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_envfile.py tests/test_deploy_playbooks.py tests/test_deploy_bundle.py tests/test_deploy_do_environments.py -k "extra or managed or slot_smoke or metadata or region or test_plans"`
Expected: FAIL.

- [ ] **Step 3: `envfile` extras**

In `sirdar/api/src/sirdar_api/deploy/envfile.py`:

```python
# Extra keys a DigitalOcean droplet's .env carries (deploy phase 7), in the
# order they are written. deploy/stack reads them with defaults, so a .env
# without them still means "local data, NPM on the LAN".
EXTRA_KEYS = (
    "STACK_EXTERNAL_DATA", "STACK_CADDY", "STACK_NETWORK_SUBNET", "STACK_HOSTS_IP",
    "STACK_TRUSTED_PROXIES", "STACK_DB_HOST", "STACK_DB_PORT", "STACK_DB_NAME", "STACK_DB_USER",
    "SS_DATABASE_URL", "SS_DATABASE_SSL", "SS_SPACES_ENDPOINT", "SS_SPACES_REGION",
    "SS_SPACES_ACCESS_KEY", "SS_SPACES_SECRET_KEY", "SS_SPACES_USE_PATH_STYLE",
    "STACK_DROPLET_ID",
)
```

Append `*EXTRA_KEYS` to `KNOWN_KEYS`. In `EnvConfig` add `extra: dict[str, str] = field(default_factory=dict, repr=False)` after `secrets`. In `render_env`, right after building `values`:

```python
    for key, value in cfg.extra.items():
        if key not in EXTRA_KEYS:
            raise RenderError(f"unknown key {key}")
        values[key] = value
```

(the existing loop then checks every value for control characters and `CHANGEME`).

- [ ] **Step 4: `do_envs.env_extra`**

Append to `sirdar/api/src/sirdar_api/deploy/do_envs.py` (import `spaces` from `sirdar_api.deploy`):

```python
async def env_extra(db: AsyncSession, settings: Settings, env: Environment, slot: str,
                    secrets: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """The .env keys a slot's droplet needs on top of the usual ones, and the
    secret values among them (for the redactor). DoEnvError("do_not_ready",
    missing=[…]) until step 0 has recorded them."""
    row = await get(db, env.id)
    slot_row = await db.get(DoSlot, (env.id, slot), populate_existing=True)
    missing = [label for label, value in (
        ("load balancer address", row.lb_ip), ("VPC range", row.vpc_ip_range),
        ("database host", row.db_host), ("Spaces key", row.spaces_key_id),
        ("droplet", slot_row.droplet_id if slot_row else None)) if not value]
    if missing:
        raise DoEnvError("do_not_ready", missing=missing)
    spaces_secret = vault.decrypt(settings, row.spaces_secret_enc)
    url = (f"postgresql+asyncpg://{DB_USER}:{secrets['POSTGRES_PASSWORD']}@{row.db_host}:"
           f"{row.db_port}/{DB_NAME}")
    extra = {
        "STACK_EXTERNAL_DATA": "1", "STACK_CADDY": "1", "STACK_NETWORK_SUBNET": NETWORK_SUBNET,
        "STACK_HOSTS_IP": row.lb_ip, "STACK_TRUSTED_PROXIES": row.vpc_ip_range,
        "STACK_DB_HOST": row.db_host, "STACK_DB_PORT": str(row.db_port),
        "STACK_DB_NAME": DB_NAME, "STACK_DB_USER": DB_USER,
        "SS_DATABASE_URL": url, "SS_DATABASE_SSL": "require",
        "SS_SPACES_ENDPOINT": spaces.endpoint(row.region), "SS_SPACES_REGION": row.region,
        "SS_SPACES_ACCESS_KEY": row.spaces_key_id, "SS_SPACES_SECRET_KEY": spaces_secret,
        "SS_SPACES_USE_PATH_STYLE": "false", "STACK_DROPLET_ID": slot_row.droplet_id,
    }
    return extra, [url, spaces_secret]
```

`POSTGRES_PASSWORD` is the generated hex secret (safe inside a URL), and it is also the managed role's password (step 0 sets it).

- [ ] **Step 5: The new step definitions**

In `sirdar/api/src/sirdar_api/deploy/steps.py`, insert into `STEPS`, keeping number order:

```python
    StepDef(0, "do_prepare", "Prepare DigitalOcean", "", 60 * 60, "vm"),
```

after `vm_restore`;

```python
    StepDef(13, "slot_smoke", "Smoke test (slot)", "slot_smoke.yml", 10 * 60),
```

after `proxy`;

```python
    StepDef(14, "go_live", "Switch traffic", "", 15 * 60, "vm"),
```

after `smoke`; and at the end:

```python
    StepDef(18, "do_destroy", "Remove DigitalOcean resources", "", 60 * 60, "vm"),
```

- [ ] **Step 6: The playbooks**

Create `sirdar/api/src/sirdar_api/deploy/ansible/slot_smoke.yml`:

```yaml
# Step 13 — Smoke test (slot), DigitalOcean: every public name answers
# through Caddy on this droplet (http://127.0.0.1 with its Host), before the
# load balancer sends it any traffic. Sirdar isn't in the VPC, so the check
# runs on the droplet. 200–399 passes; redirects aren't followed.
- name: Smoke test (slot)
  hosts: target
  gather_facts: false
  tasks:
    - name: Each public name answers through Caddy
      ansible.builtin.uri:
        url: "http://127.0.0.1:{{ slot_port | default(80) }}{{ item.path }}"
        headers:
          Host: "{{ item.hostname }}"
          X-Forwarded-Proto: https
        follow_redirects: none
        status_code: [200, 201, 202, 203, 204, 301, 302, 303, 304, 307, 308]
        timeout: 10
      register: answer
      until: answer is not failed
      retries: "{{ slot_smoke_retries | default(6) }}"
      delay: "{{ slot_smoke_delay | default(10) }}"
      loop: "{{ public_hosts }}"
      loop_control:
        label: "{{ item.hostname }}"
```

Replace `sirdar/api/src/sirdar_api/deploy/ansible/dump.yml`'s `tasks:` with:

```yaml
  tasks:
    # DigitalOcean: the managed database is always running, so the dump always
    # happens (a first deploy dumps an empty database).
    - name: ss-stack dump (the managed database)
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", dump, "{{ env_dir }}"]
      register: managed_dump
      when: external_data | default(false) | bool

    - name: The local database
      when: not (external_data | default(false) | bool)
      block:
        - name: Is the database running?
          ansible.builtin.command:
            argv:
              - docker
              - ps
              - --quiet
              - --filter
              - "label=com.docker.compose.project=ss-{{ env_name }}-db"
              - --filter
              - status=running
          register: db_running
          changed_when: false

        # A deployment that restores a snapshot (a seeded first deploy) would
        # start a stopped database's volume (`ss-stack data`) and drop it
        # (`ss-stack restore`) without this dump: refuse before anything changes.
        - name: Is there a stopped database?
          ansible.builtin.command:
            argv: [docker, volume, inspect, "ss-{{ env_name }}-db_pgdata"]
          register: db_volume
          changed_when: false
          failed_when: false
          when:
            - restores_snapshot | default(false) | bool
            - db_running.stdout | length == 0

        - name: Stop before the restore drops it
          ansible.builtin.fail:
            msg: >-
              A database for {{ env_name }} already exists on this server but isn't running.
              Adopt the environment instead, or remove its volume (ss-{{ env_name }}-db_pgdata).
          when:
            - db_volume is not skipped
            - db_volume.rc == 0

        - name: Stop when the backup can't be taken
          ansible.builtin.fail:
            msg: >-
              The database isn't running, so the pre-deploy backup can't be taken.
              Start it (or Reset) and retry.
          when:
            - dump_required | default(false) | bool
            - db_running.stdout | length == 0

        - name: ss-stack dump
          ansible.builtin.command:
            argv: ["{{ ss_stack }}", dump, "{{ env_dir }}"]
          register: dump
          when: db_running.stdout | length > 0

    - name: Report the dump path
      ansible.builtin.set_stats:
        data:
          dump_path: >-
            {{ managed_dump.stdout_lines[-1] if managed_dump is not skipped
               else (dump.stdout_lines[-1] if dump is defined and dump is not skipped
                     else '') }}
        per_host: false
        aggregate: true
```

Keep the file's header comment, adding: "On DigitalOcean (external_data) the managed database is dumped through ss-stack's one-off client."

In `sirdar/api/src/sirdar_api/deploy/ansible/export.yml`:
1. Add to `vars:`:

```yaml
    external: "{{ external_data | default(false) | bool }}"
    spaces_args: >-
      {{ ['--endpoint', spaces_endpoint, '--key-id', spaces_key_id, '--region', spaces_region]
         if external_data | default(false) | bool else [] }}
```

2. Give "The database's migration", "pg_dump inside the database container" and "Copy the dump out" `when: not external`, and add after them:

```yaml
        - name: The database's migration (managed)
          ansible.builtin.command:
            argv: ["{{ ss_stack }}", revision, "{{ env_dir }}"]
          register: managed_revision
          changed_when: false
          when: external

        - name: pg_dump of the managed database
          ansible.builtin.command:
            argv: ["{{ ss_stack }}", pgdump, "{{ env_dir }}", "{{ work }}/db.dump"]
          when: external
```

3. "Export the objects": `argv: "{{ ['docker', 'run', '--rm', '--network', 'ss-' + env_name, '--env-file', env_dir + '/.env', '--user', uid.stdout + ':' + gid.stdout, '-e', 'HOME=/tmp', '-v', work + ':/work', api_image, 'python', '/work/bundle.py', 'export-objects', '--out', '/work/objects.tar'] + spaces_args }}"`.
4. "Pack the bundle": `--revision` becomes `"{{ (managed_revision.stdout if external else revision.stdout) | trim }}"`.
5. In `always:`, "Remove the dump from the database container" gets `when: not external`.

In `sirdar/api/src/sirdar_api/deploy/ansible/restore.yml`, add the same `spaces_args` var, and make "Upload the objects" `argv: "{{ ['docker', 'run', '--rm', '--network', 'ss-' + env_name, '--env-file', env_dir + '/.env', '--user', uid.stdout + ':' + gid.stdout, '-e', 'HOME=/tmp', '-v', work + ':/work:ro', api_image, 'python', '/work/bundle.py', 'import-objects', '--in', '/work/objects.tar'] + spaces_args }}"` (`ss-stack restore` already handles the managed database).

In `sirdar/api/src/sirdar_api/deploy/ansible/bootstrap.yml`, after "Docker starts on boot", add:

```yaml
    # DigitalOcean: the droplet's user-data holds its SSH host key, and the
    # metadata service hands user-data to anything on the droplet. Containers
    # never need it: reject their traffic to it, now and after every Docker
    # (re)start.
    - name: Containers can't reach the metadata service
      when: block_metadata | default(false) | bool
      become: true
      block:
        - name: The rule's unit
          ansible.builtin.copy:
            dest: /etc/systemd/system/sirdar-metadata-block.service
            mode: "0644"
            content: |
              [Unit]
              Description=Keep containers away from the DigitalOcean metadata service (Sirdar)
              After=docker.service
              Requires=docker.service
              PartOf=docker.service

              [Service]
              Type=oneshot
              RemainAfterExit=yes
              ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -d 169.254.169.254 -j REJECT 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j REJECT'

              [Install]
              WantedBy=multi-user.target

        - name: The rule is on, and comes back with Docker
          ansible.builtin.systemd_service:
            name: sirdar-metadata-block
            enabled: true
            state: restarted
            daemon_reload: true
```

- [ ] **Step 7: `bundle.py`**

In `sirdar/api/src/sirdar_api/deploy/bundle.py`:

```python
def s3_client(endpoint: str, key_id: str, secret: str, region: str = "us-east-1"):
    ...
    return boto3.client("s3", endpoint_url=endpoint, region_name=region, ...)
```

```python
def _s3_from_args(args):
    # SS_SPACES_SECRET_KEY (a DigitalOcean droplet's bucket key) before
    # SPACES_SECRET_KEY (the local SeaweedFS secret every .env also has).
    secret = (os.environ.get("SNAP_S3_SECRET") or os.environ.get("SS_SPACES_SECRET_KEY")
              or os.environ.get("SPACES_SECRET_KEY"))
    if not secret:
        raise BundleError("Set SNAP_S3_SECRET (or SPACES_SECRET_KEY) to the bucket's secret key.")
    bucket = args.bucket or os.environ.get("SS_SPACES_BUCKET") or DEFAULT_BUCKET
    return s3_client(args.endpoint, args.key_id, secret, args.region), bucket
```

and in `main`, for both objects commands: `o.add_argument("--region", default="us-east-1")`.

- [ ] **Step 8: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_envfile.py tests/test_deploy_playbooks.py tests/test_deploy_bundle.py tests/test_deploy_do_environments.py`
Expected: all PASS. (`test_plans`'s later loop over `steps.MODES` is unchanged here: no new mode yet.)

- [ ] **Step 9: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/envfile.py src/sirdar_api/deploy/do_envs.py src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/bundle.py tests/test_deploy_envfile.py tests/test_deploy_playbooks.py tests/test_deploy_bundle.py tests/test_deploy_do_environments.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/envfile.py sirdar/api/src/sirdar_api/deploy/do_envs.py sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/bundle.py sirdar/api/src/sirdar_api/deploy/ansible/dump.yml sirdar/api/src/sirdar_api/deploy/ansible/export.yml sirdar/api/src/sirdar_api/deploy/ansible/restore.yml sirdar/api/src/sirdar_api/deploy/ansible/bootstrap.yml sirdar/api/src/sirdar_api/deploy/ansible/slot_smoke.yml sirdar/api/tests/test_deploy_envfile.py sirdar/api/tests/test_deploy_playbooks.py sirdar/api/tests/test_deploy_bundle.py sirdar/api/tests/test_deploy_do_environments.py
git commit -m "feat(sirdar): DigitalOcean .env extras, slot smoke test, managed-database playbooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Step 0 — Prepare DigitalOcean

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/do_provision.py` (the context, step 0; Task 10 adds steps 14 and 18)
- Create: `sirdar/api/src/sirdar_api/deploy/pgauth.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/cloudinit.py` (`droplet_userdata`)
- Modify: `sirdar/api/src/sirdar_api/deploy/ssh.py` (`run_command(..., input=None)`)
- Modify: `sirdar/api/src/sirdar_api/deploy/vmcommon.py` (`resolve_ref(..., slot=None)`)
- Modify: `sirdar/api/tests/do_helpers.py` (`do_build` fixture)
- Create: `sirdar/api/tests/test_deploy_do_provision.py`, `sirdar/api/tests/test_deploy_pgauth.py`
- Modify: `sirdar/api/tests/test_deploy_cloudinit.py`

**Interfaces:**
- Consumes: `do_api` (Task 2), `do_accounts` (3), `spaces` (4), `certs` (5), `do_envs` (6), `vmcommon.confirm_pin`, `vmcommon.VmOutcome`, `vmcommon.VmPrepareError`, `publish.StepFailed`.
- Produces:
  - `pgauth.scram_sha256(password, *, salt=None, iterations=4096) -> str`, `pgauth.setup_sql(*, role, database, verifier) -> str`.
  - `cloudinit.droplet_userdata(*, hostname, ssh_public_key, host_key_private, host_key_public) -> str`.
  - `ssh.run_command(cfg, db, command, *, timeout=RUN_TIMEOUT, input=None)`.
  - `vmcommon.resolve_ref(settings, resolve, *, env_id, git_ref, repo_url, out, slot=None)`.
  - `do_provision.SlotState`, `do_provision.DoContext` (fields below; `.secret_values`, `.slot_state(slot)`), `async do_provision.prepare(db, env, dep, settings) -> DoContext` (VmPrepareError with our copy), `do_provision.DoProvisioner(*, settings, sleep=asyncio.sleep, poll=POLL_SECONDS, now=None, resolve=None, remote=None, dns_wait=certs.DNS_WAIT, waits=None, smoke_attempts=smoke.ATTEMPTS, smoke_delay=smoke.DELAY)` with `STEPS = ("do_prepare", "go_live", "do_destroy")` and `async run(step, ctx, out) -> VmOutcome`.
  - Helpers Task 10 uses: `lb_body(ctx, vpc_id, certificate_id, droplet_ids) -> dict`, `lb_update_body(lb, **changes) -> dict`, `https_certificate(lb) -> str | None`, `load_records(env_id) -> Records` (`.find(kind, slot=None)`, `.slots`).
  - Test fixture `do_build` (in `do_helpers.py`): a built-from-scratch harness — see Step 1.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_pgauth.py`:

```python
"""SCRAM-SHA-256 verifiers (so the role's password never reaches
PostgreSQL in plaintext) and the setup SQL."""

import base64
import hashlib
import hmac
import re

import pytest

from sirdar_api.deploy import pgauth


def test_the_rfc7677_exchange_verifies_against_our_verifier():
    """RFC 7677 §3 (user "user", password "pencil"): the server signature
    computed from our StoredKey/ServerKey must match the RFC's. If this fails,
    compare the strings with RFC 7677 before touching the code."""
    salt = base64.b64decode("W22ZaJ0SNY7soEsUEjb6gQ==")
    verifier = pgauth.scram_sha256("pencil", salt=salt, iterations=4096)
    m = re.fullmatch(r"SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)", verifier)
    assert m and base64.b64decode(m.group(1)) == salt
    server_key = base64.b64decode(m.group(3))
    auth = ("n=user,r=rOprNGfwEbeRWgbNEkqO,"
            "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,"
            "i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0")
    signature = hmac.new(server_key, auth.encode(), hashlib.sha256).digest()
    assert base64.b64encode(signature).decode() == "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="


def test_salts_are_random_and_the_password_never_shows():
    a, b = pgauth.scram_sha256("hex-secret"), pgauth.scram_sha256("hex-secret")
    assert a != b and "hex-secret" not in a


def test_setup_sql():
    sql = pgauth.setup_sql(role="serversherpa", database="serversherpa",
                           verifier=pgauth.scram_sha256("x"))
    assert "CREATE ROLE serversherpa LOGIN" in sql
    assert "ALTER ROLE serversherpa WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:" in sql
    assert "GRANT serversherpa TO doadmin" in sql
    assert "CREATE DATABASE serversherpa OWNER serversherpa" in sql and "\\gexec" in sql
    assert "ALTER DATABASE serversherpa OWNER TO serversherpa" in sql


@pytest.mark.parametrize("kw", [{"role": "Bad-Role"}, {"database": "x;drop"},
                                {"verifier": "md5abc"}, {"verifier": "SCRAM-SHA-256$1:a'$b:c"}])
def test_setup_sql_refuses_unsafe_values(kw):
    base = {"role": "serversherpa", "database": "serversherpa",
            "verifier": pgauth.scram_sha256("x")}
    with pytest.raises(ValueError):
        pgauth.setup_sql(**{**base, **kw})
```

Append to `sirdar/api/tests/test_deploy_cloudinit.py`:

```python
def test_droplet_userdata():
    text = cloudinit.droplet_userdata(hostname="ss-uat9-purple",
                                      ssh_public_key="ssh-ed25519 AAAAuser sirdar",
                                      host_key_private="-----BEGIN OPENSSH PRIVATE KEY-----\nx\n",
                                      host_key_public="ssh-ed25519 AAAAhost root")
    doc = yaml.safe_load(text.removeprefix("#cloud-config\n"))
    assert text.startswith("#cloud-config\n")
    assert doc["users"][0]["name"] == "deploy"
    assert doc["ssh_keys"]["ed25519_public"] == "ssh-ed25519 AAAAhost root"
    assert doc["ssh_genkeytypes"] == [] and doc["ssh_deletekeys"] is True
    assert "postgresql-client" in doc["packages"] and doc["package_update"] is True
    with pytest.raises(ValueError):
        cloudinit.droplet_userdata(hostname="bad name", ssh_public_key="k",
                                   host_key_private="p", host_key_public="h")
```

(add `import pytest` / `import yaml` there if missing).

Append to `sirdar/api/tests/do_helpers.py`:

```python
SHA = "d0" * 20


class Remote:
    """Stands in for the SSH commands step 0 runs on a droplet."""

    def __init__(self):
        self.calls: list[tuple[str, str, str | None]] = []
        self.codes: dict[str, int] = {}

    async def __call__(self, cfg, command: str, stdin: str | None) -> int:
        self.calls.append((cfg.host, command, stdin))
        return next((code for key, code in self.codes.items() if key in command), 0)


async def _resolve(cfg, db, repo_url, ref):
    return SHA


async def _nap(_seconds):
    return None


class Build:
    """One DigitalOcean environment, the provisioner wired to the fakes, and
    helpers to run a step the way the pipeline would."""

    def __init__(self, db, cloud, env, settings, remote):
        self.db, self.cloud, self.env, self.settings, self.remote = db, cloud, env, settings, remote
        self.lines: list[str] = []

    def provisioner(self, **kw):
        from sirdar_api.deploy import do_provision
        base = dict(settings=self.settings, sleep=_nap, poll=0, resolve=_resolve,
                    remote=self.remote, dns_wait=0, smoke_attempts=1, smoke_delay=0)
        return do_provision.DoProvisioner(**{**base, **kw})

    async def deployment(self, *, mode="update", slot="orange", go_live=True):
        from sirdar_api.db.models import Deployment
        dep = Deployment(environment_id=self.env.id, mode=mode, git_ref="main", sha="",
                         status="running", start_step=0, cloud=True, slot=slot,
                         go_live=go_live)
        self.db.add(dep)
        await self.db.commit()
        return dep

    async def run(self, step="do_prepare", **kw):
        from sirdar_api.db.models import Environment
        from sirdar_api.deploy import do_provision
        self.db.expire_all()
        env = await self.db.get(Environment, self.env.id)
        dep = await self.deployment(**kw)
        ctx = await do_provision.prepare(self.db, env, dep, self.settings)
        return await self.provisioner().run(step, ctx, self.lines.append)

    def log(self) -> str:
        return "".join(self.lines)


@pytest.fixture
async def do_build(db, do_cloud, secrets_key, ssh_server, monkeypatch, deploy_env):
    """uat9 (orange + purple) on DigitalOcean in the Development account. The
    tests' SSH server plays every droplet at 127.0.0.1, with the host key
    Sirdar 'generated' (the server's own)."""
    from sirdar_api.deploy import vms
    key = ssh_server.host_key
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    monkeypatch.setattr(vms, "new_host_keypair", lambda name: (
        key.export_private_key("openssh").decode(),
        key.export_public_key("openssh").decode().strip()))
    env = await make_do_environment(db)
    return Build(db, do_cloud, env, get_settings(), Remote())
```

(`secrets_key`, `ssh_server` and `deploy_env` come from their modules: import them at the top of `do_helpers.py` with `# noqa: F401` so `do_build` can request them, as `test_deploy_esxi_provision.py` does.)

Create `sirdar/api/tests/test_deploy_do_provision.py`:

```python
"""Step 0, Prepare DigitalOcean, against FakeDigitalOcean, FakeSpaces,
FakeAcme and FakeCloudflare, with the tests' SSH server playing the
droplets: it builds everything once, records it the moment it exists, does
nothing the second time, finds lost droplets by their tag, refuses what no
longer matches, and keeps every secret out of its log."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from sirdar_api.db.models import DoEnvironment, DoResource, DoSlot
from sirdar_api.deploy import do_envs, known_hosts, vms
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.vmcommon import VmPrepareError

from .deploy_factories import ENV_SECRETS
from .do_helpers import SHA, do_build  # noqa: F401
from .fake_digitalocean import DB_ADMIN_PASSWORD, DEV_TOKEN, LB_IP


async def _kinds(db, env_id) -> list[tuple[str, str | None]]:
    rows = await db.scalars(select(DoResource).where(DoResource.environment_id == env_id))
    return sorted((r.kind, r.slot) for r in rows)


async def test_the_first_run_builds_everything(db, do_build):
    b, fake = do_build, do_build.cloud.do
    outcome = await b.run()
    assert outcome.sha == SHA
    env_tag = do_envs.env_tag(b.env.id)
    # One of each, recorded.
    assert await _kinds(db, b.env.id) == [
        ("bucket", None), ("certificate", None), ("database", None), ("droplet", "orange"),
        ("droplet", "purple"), ("firewall", None), ("load_balancer", None), ("spaces_key", None),
        ("vpc", None)]
    droplets = sorted(fake.droplets.values(), key=lambda d: d["name"])
    assert [d["name"] for d in droplets] == ["ss-uat9-orange", "ss-uat9-purple"]
    assert all(env_tag in d["tags"] and "sirdar" in d["tags"] for d in droplets)
    assert "sirdar-slot:orange" in droplets[0]["tags"]
    assert "postgresql-client" in droplets[0]["_user_data"]
    (database,) = fake.databases.values()
    assert (database["version"], database["num_nodes"], database["size"]) == (
        "16", 1, "db-s-2vcpu-4gb")
    assert database["private_network_uuid"] == next(iter(fake.vpcs))
    assert sorted(r["value"] for r in fake.db_rules[database["id"]]) == sorted(
        str(d["id"]) for d in droplets)
    (key,) = fake.keys.values()                                   # the setup key is gone
    assert key["grants"] == [{"bucket": b.env.spaces_bucket, "permission": "readwrite"}]
    assert b.env.spaces_bucket in b.cloud.spaces.buckets
    (cert,) = fake.certificates.values()
    assert sorted(cert["dns_names"]) == sorted(
        f"{s}.uat9.serversherpa.com" for s in ("api", "portal", "kiosk", "wiki", "status"))
    (lb,) = fake.load_balancers.values()
    assert lb["droplet_ids"] == [] and lb["vpc_uuid"] == database["private_network_uuid"]
    https = next(r for r in lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert (https["certificate_id"], https["target_port"]) == (cert["id"], 80)
    assert lb["health_check"]["path"] == "/healthz"
    (fw,) = fake.firewalls.values()
    assert fw["tags"] == [env_tag]
    port80 = next(r for r in fw["inbound_rules"] if r["ports"] == "80")
    assert port80["sources"] == {"load_balancer_uids": [lb["id"]]}
    row = await db.get(DoEnvironment, b.env.id, populate_existing=True)
    assert (row.lb_ip, row.vpc_ip_range, row.team_uuid, row.db_port) == (
        LB_IP, "10.116.0.0/20", "team-dev-0002", 25060)
    assert row.db_host.startswith("private-ss-uat9-db") and row.spaces_key_id == key["access_key"]
    assert row.cert_not_after is not None
    slots = (await db.scalars(select(DoSlot).where(DoSlot.environment_id == b.env.id)
                              .execution_options(populate_existing=True))).all()
    assert all(s.droplet_id and s.public_ip == "127.0.0.1" and s.host_key_private_enc is None
               for s in slots)
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is not None
    # The role's password reached the droplet only as a SCRAM verifier, on stdin.
    sql = [c for c in b.remote.calls if "exec psql" in c[1]]
    assert len(sql) == 1
    host, command, stdin = sql[0]
    assert stdin.startswith(DB_ADMIN_PASSWORD + "\n") and "SCRAM-SHA-256$4096:" in stdin
    assert ENV_SECRETS["POSTGRES_PASSWORD"] not in stdin
    assert DB_ADMIN_PASSWORD not in command
    log = b.log()
    for secret in (DEV_TOKEN, DB_ADMIN_PASSWORD, ENV_SECRETS["POSTGRES_PASSWORD"],
                   key["secret_key"]):
        assert secret not in log
    assert "Created the VPC ss-uat9" in log and "Load balancer ss-uat9-lb: active" in log


async def test_a_second_run_changes_nothing(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    before = len(fake.writes())
    await do_build.run()
    assert fake.writes()[before:] == []
    assert "in place" in do_build.log()


async def test_a_lost_droplet_record_is_found_by_its_tag(db, do_build):
    await do_build.run()
    await db.execute(DoResource.__table__.delete().where(DoResource.kind == "droplet",
                                                         DoResource.slot == "purple"))
    await db.commit()
    count = len(do_build.cloud.do.droplets)
    await do_build.run()
    assert len(do_build.cloud.do.droplets) == count
    assert ("droplet", "purple") in await _kinds(db, do_build.env.id)
    assert "found it by its tag" in do_build.log()


async def test_a_droplet_that_lost_its_tag_stops_the_step(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    droplet = next(d for d in fake.droplets.values() if d["name"] == "ss-uat9-orange")
    droplet["tags"] = ["someone-else"]
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "no longer carries Sirdar's tag" in err.value.reason
    assert fake.writes()[before:] == []


async def test_a_token_from_another_team_stops_the_step(db, do_build):
    await do_build.run()
    await do_envs.set_do(do_build.env.id, team_uuid="team-somewhere-else")
    before = len(do_build.cloud.do.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "another team" in err.value.reason
    assert do_build.cloud.do.writes()[before:] == []


async def test_the_database_firewall_waits_until_accepted(db, do_build):
    do_build.cloud.do.firewall_wait = 2
    await do_build.run()
    (database,) = do_build.cloud.do.databases.values()
    assert len(do_build.cloud.do.db_rules[database["id"]]) == 2


async def test_a_leftover_setup_key_is_removed(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.keys["DO00LEFT"] = {"name": "ss-uat9-setup", "access_key": "DO00LEFT",
                             "secret_key": "x", "grants": []}
    await do_envs.record(do_build.env.id, "spaces_key", "DO00LEFT", "ss-uat9-setup")
    await do_build.run()
    assert "DO00LEFT" not in fake.keys


@pytest.mark.parametrize("days, renewed", [(10, True), (20, False), (60, False)])
async def test_sirdar_renews_only_inside_14_days(db, do_build, days, renewed):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = (datetime.now(UTC) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    await do_build.run()
    assert (len(fake.certificates) == 1) and ((cert["id"] in fake.certificates) is not renewed)
    (lb,) = fake.load_balancers.values()
    https = next(r for r in lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == next(iter(fake.certificates))


async def test_a_certificate_the_worker_swapped_in_is_recorded(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (lb,) = fake.load_balancers.values()
    (old,) = fake.certificates.values()
    later = datetime.strptime(old["not_after"], "%Y-%m-%dT%H:%M:%SZ") + timedelta(days=1)
    swapped = {**old, "id": "cert-from-worker", "name": "ss-uat9-209901010000",
               "not_after": later.strftime("%Y-%m-%dT%H:%M:%SZ")}
    fake.certificates["cert-from-worker"] = swapped
    for rule in lb["forwarding_rules"]:
        if rule["entry_protocol"] == "https":
            rule["certificate_id"] = "cert-from-worker"
    await do_build.run()
    rows = await db.scalars(select(DoResource.do_id).where(DoResource.kind == "certificate"))
    assert "cert-from-worker" in set(rows)
    assert "Recorded the certificate ss-uat9-209901010000" in do_build.log()


async def test_no_renewal_token_stops_before_anything(db, do_build):
    from sirdar_api.config import get_settings
    from sirdar_api.deploy import do_accounts
    await do_accounts.save(db, get_settings(), "development", label="Development",
                           region="nyc3", clear_renewal=True)
    await db.commit()
    with pytest.raises(VmPrepareError) as err:
        await do_build.run()
    assert "renewal token" in err.value.reason
    assert do_build.cloud.do.writes() == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_pgauth.py tests/test_deploy_cloudinit.py tests/test_deploy_do_provision.py`
Expected: FAIL (missing modules and functions).

- [ ] **Step 3: `pgauth.py`**

Create `sirdar/api/src/sirdar_api/deploy/pgauth.py`:

```python
"""PostgreSQL role setup for DigitalOcean environments (deploy phase 7):
the SCRAM-SHA-256 verifier of a password (what PostgreSQL stores; sending
it instead of the password keeps the plaintext out of the server and its
logs) and the idempotent SQL step 0 runs as doadmin. Pure functions."""

import base64
import hashlib
import hmac
import os
import re

_IDENT_RE = re.compile(r"[a-z_][a-z0-9_]{0,62}")
_VERIFIER_RE = re.compile(r"SCRAM-SHA-256\$[0-9]{4,7}:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:"
                          r"[A-Za-z0-9+/=]+")


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def scram_sha256(password: str, *, salt: bytes | None = None, iterations: int = 4096) -> str:
    salt = salt if salt is not None else os.urandom(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    return f"SCRAM-SHA-256${iterations}:{_b64(salt)}${_b64(stored_key)}:{_b64(server_key)}"


def setup_sql(*, role: str, database: str, verifier: str) -> str:
    """Run as doadmin in defaultdb: the role (created by doadmin, so PG 16
    gives doadmin ADMIN OPTION on it), its password, doadmin's membership
    (needed to hand it a database) and the database it owns. Idempotent."""
    if not _IDENT_RE.fullmatch(role) or not _IDENT_RE.fullmatch(database):
        raise ValueError("identifier")
    if not _VERIFIER_RE.fullmatch(verifier):
        raise ValueError("verifier")
    return "\n".join([
        "DO $$ BEGIN",
        f"  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{role}') THEN",
        f"    CREATE ROLE {role} LOGIN;",
        "  END IF;",
        "END $$;",
        f"ALTER ROLE {role} WITH LOGIN PASSWORD '{verifier}';",
        f"GRANT {role} TO doadmin;",
        f"SELECT 'CREATE DATABASE {database} OWNER {role}'",
        f"  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{database}')\\gexec",
        f"ALTER DATABASE {database} OWNER TO {role};",
        "",
    ])
```

- [ ] **Step 4: cloud-init for droplets, SSH stdin, slot-aware ref resolution**

In `sirdar/api/src/sirdar_api/deploy/cloudinit.py`, append:

```python
# A droplet's host name: "ss-", the environment and the slot (a DNS label).
_DROPLET_HOSTNAME_RE = re.compile(r"ss-[a-z][a-z0-9-]{0,52}[a-z0-9]")


def droplet_userdata(*, hostname: str, ssh_public_key: str, host_key_private: str,
                     host_key_public: str) -> str:
    """A DigitalOcean droplet's user-data (deploy phase 7): the ESXi user-data
    (deploy user, Sirdar's key, the host key Sirdar generated) plus the
    PostgreSQL client step 0 uses to set up the managed database."""
    if not isinstance(hostname, str) or not _DROPLET_HOSTNAME_RE.fullmatch(hostname):
        raise ValueError("hostname")
    doc = yaml.safe_load(userdata(hostname=hostname, ssh_public_key=ssh_public_key,
                                  host_key_private=host_key_private,
                                  host_key_public=host_key_public)
                         .removeprefix("#cloud-config\n"))
    doc["package_update"] = True
    doc["packages"] = ["postgresql-client"]
    return "#cloud-config\n" + yaml.safe_dump(doc, sort_keys=False)
```

In `sirdar/api/src/sirdar_api/deploy/ssh.py`, give `run_command` an `input: str | None = None` keyword and pass it: `conn.run(command, check=False, errors="replace", input=input)`. Add to its docstring: "`input` goes to the command's stdin (for secrets: never argv)."

In `sirdar/api/src/sirdar_api/deploy/vmcommon.py`, `resolve_ref` gains `slot: str | None = None` and calls `cfg = await vms.host_config(s, settings, env, slot=slot)`.

- [ ] **Step 5: Write `do_provision.py` (context and step 0)**

Create `sirdar/api/src/sirdar_api/deploy/do_provision.py`:

```python
"""Steps 0, 14 and 18 of a DigitalOcean environment (deploy phase 7), run in
Sirdar through do_api.connect with the environment's account token:
Prepare DigitalOcean ("do_prepare"), Switch traffic ("go_live") and Remove
DigitalOcean resources ("do_destroy").

Step 0 is idempotent: it makes what is missing and never replaces what
exists. In order: the team check, the VPC, the bucket and its key, a droplet
per slot, the database cluster (its firewall set to the droplets right after
create), the droplets' SSH host keys (Sirdar generated them; cloud-init
delivers them; they are pinned before any command runs), the commit, the
database role and database (SQL on the slot's droplet, as doadmin), the
certificate, the load balancer and the cloud firewall.

Every resource is recorded in do_resources the moment DigitalOcean answers,
in its own transaction. Sirdar acts only on what is recorded and still
matches (its tag, or its exact name); droplets and databases tagged
sirdar-env-<id> but not recorded are Sirdar's (the tag holds the
environment's UUID) and are recorded again. Failures raise
publish.StepFailed with our own copy."""

import asyncio
import shlex
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import asyncssh
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    Deployment,
    DoAccount,
    DoResource,
    DoSlot,
    Environment,
    EnvironmentSecret,
)
from sirdar_api.deploy import (
    certs,
    cloudinit,
    do_accounts,
    do_api,
    do_envs,
    gitref,
    integrations,
    known_hosts,
    pgauth,
    smoke,
    spaces,
    ssh,
    targets,
    vault,
    vmcommon,
    vms,
)
from sirdar_api.deploy.do_api import DigitalOceanApi, DoError
from sirdar_api.deploy.integrations import CloudflareConfig, IntegrationError
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.ssh import SshTargetConfig
from sirdar_api.deploy.vmcommon import Output, VmOutcome, VmPrepareError

POLL_SECONDS = 10
WAITS = {"droplet": 10 * 60, "database": 30 * 60, "lb": 10 * 60, "ssh": 10 * 60,
         "vpc": 10 * 60}
FIREWALL_TRIES = 60
SQL_TIMEOUT = 15 * 60          # cloud-init may still be installing psql
_PSQL = ('IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql '
         '"host=$0 port=$1 dbname=defaultdb user=doadmin sslmode=require" '
         '-v ON_ERROR_STOP=1 -q -f -')
_READY = "cloud-init status --wait > /dev/null 2>&1; command -v psql > /dev/null"
_UNREADABLE = ("Sirdar can't read this environment's DigitalOcean secrets with the current "
               "SIRDAR_SECRETS_KEY.")


# ---- context -----------------------------------------------------------------------------

@dataclass(frozen=True)
class SlotState:
    slot: str
    host_key_public: str
    host_key_private: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class DoContext:
    env_id: uuid.UUID
    env_name: str
    env_type: str
    deployment_id: uuid.UUID
    actor_id: uuid.UUID | None
    mode: str
    git_ref: str
    sha: str
    repo_url: str
    slot: str | None                 # the slot it deploys / switches to
    go_live: bool
    slots: tuple[str, ...]
    active_slot: str | None
    account_key: str
    account_label: str
    team_uuid: str | None            # frozen by the first step 0
    region: str
    droplet_size: str
    droplet_image: str
    db_size: str
    db_standby: bool
    acme_staging: bool
    acme_directory: str
    bucket: str
    ssh_public_key: str
    slot_states: tuple[SlotState, ...]
    hosts: tuple[tuple[str, str], ...]     # (service, public hostname)
    token: str = field(repr=False)
    db_password: str = field(repr=False)
    ssh_private_key: str = field(repr=False)
    db_admin_password: str | None = field(default=None, repr=False)
    cloudflare: CloudflareConfig | None = field(default=None, repr=False)

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(h for _, h in self.hosts)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        found = [self.token, self.db_password, self.ssh_private_key, self.db_admin_password,
                 self.cloudflare.token if self.cloudflare else None,
                 *(s.host_key_private for s in self.slot_states)]
        return [v for v in found if v]

    def slot_state(self, slot: str) -> SlotState:
        return next(s for s in self.slot_states if s.slot == slot)


def _decrypt(settings: Settings, blob: bytes | None) -> str | None:
    if blob is None:
        return None
    try:
        return vault.decrypt(settings, blob)
    except (vault.SecretsKeyMissing, vault.SecretUnreadable):
        raise VmPrepareError(_UNREADABLE) from None


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> DoContext:
    row = await do_envs.get(db, env.id)
    if row is None:
        raise VmPrepareError("This environment has no DigitalOcean record, so Sirdar won't "
                             "build or remove anything for it.")
    label = (await db.get(DoAccount, row.account_key)).label
    try:
        account = await do_accounts.load(db, settings, row.account_key)
        cloudflare = await integrations.load_cloudflare(db, settings)
    except IntegrationError as e:
        raise VmPrepareError(e.reason) from None
    if account is None:
        raise VmPrepareError(f"The {label} DigitalOcean account has no API token. Add it in "
                             "Settings › Integrations, then retry.")
    building = dep.mode == "update"
    if building and account.renewal_token is None:
        raise VmPrepareError(f"The {label} DigitalOcean account has no renewal token (the "
                             "token droplets renew their certificate with). Add it in Settings "
                             "› Integrations, then retry.")
    secret = await db.get(EnvironmentSecret, (env.id, "POSTGRES_PASSWORD"))
    if secret is None:
        raise VmPrepareError("This environment has no database password. Recreate it.")
    slots = await do_envs.slots_of(db, env.id)
    states = tuple(SlotState(s, slots[s].host_key_public,
                             _decrypt(settings, slots[s].host_key_private_enc) if building
                             else None) for s in env.slots)
    directory = settings.acme_staging_directory if row.acme_staging else settings.acme_directory
    return DoContext(
        env_id=env.id, env_name=env.name, env_type=env.type, deployment_id=dep.id,
        actor_id=dep.actor_id, mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
        repo_url=settings.deploy_repo_url, slot=dep.slot, go_live=dep.go_live,
        slots=tuple(env.slots), active_slot=env.active_slot, account_key=row.account_key,
        account_label=label, team_uuid=row.team_uuid, region=row.region,
        droplet_size=row.droplet_size, droplet_image=row.droplet_image, db_size=row.db_size,
        db_standby=row.db_standby, acme_staging=row.acme_staging, acme_directory=directory,
        bucket=row.bucket, ssh_public_key=row.ssh_public_key, slot_states=states,
        hosts=tuple((s, f"{s}.{env.base_domain}") for s in certs.PUBLIC_SERVICES),
        token=account.token, db_password=_decrypt(settings, secret.value_enc),
        ssh_private_key=_decrypt(settings, row.ssh_private_key_enc),
        db_admin_password=_decrypt(settings, row.db_admin_password_enc),
        cloudflare=cloudflare)


# ---- fresh records -----------------------------------------------------------------------

@dataclass
class Records:
    resources: list[DoResource]
    slots: dict[str, DoSlot]

    def find(self, kind: str, slot: str | None = None) -> list[DoResource]:
        return [r for r in self.resources
                if r.kind == kind and (slot is None or r.slot == slot)]


async def load_records(env_id) -> Records:
    """What do_resources and do_slots hold now (each step reads them again:
    the context was built before step 0 wrote anything)."""
    async with get_sessionmaker()() as s:
        return Records(await do_envs.resources_of(s, env_id), await do_envs.slots_of(s, env_id))


# ---- load balancer bodies ----------------------------------------------------------------

def _rules(certificate_id: str) -> list[dict]:
    return [{"entry_protocol": "https", "entry_port": 443, "target_protocol": "http",
             "target_port": 80, "certificate_id": certificate_id, "tls_passthrough": False},
            {"entry_protocol": "http", "entry_port": 80, "target_protocol": "http",
             "target_port": 80}]


def lb_body(ctx: DoContext, vpc_id: str, certificate_id: str, droplet_ids: list[int]) -> dict:
    return {"name": do_envs.resource_name(ctx.env_name, "-lb"), "region": ctx.region,
            "size_unit": 1, "vpc_uuid": vpc_id, "forwarding_rules": _rules(certificate_id),
            "health_check": {"protocol": "http", "port": 80, "path": "/healthz",
                             "check_interval_seconds": 10, "response_timeout_seconds": 5,
                             "healthy_threshold": 3, "unhealthy_threshold": 3},
            "redirect_http_to_https": False, "droplet_ids": droplet_ids}


def lb_update_body(lb: dict, **changes) -> dict:
    """A PUT replaces the whole load balancer: what it has, plus `changes`."""
    region = lb.get("region")
    body = {"name": lb.get("name"),
            "region": region.get("slug") if isinstance(region, dict) else region,
            "size_unit": lb.get("size_unit") or 1, "vpc_uuid": lb.get("vpc_uuid"),
            "forwarding_rules": lb.get("forwarding_rules") or [],
            "health_check": lb.get("health_check"), "droplet_ids": lb.get("droplet_ids") or [],
            "redirect_http_to_https": bool(lb.get("redirect_http_to_https"))}
    return {**body, **changes}


def https_certificate(lb: dict) -> str | None:
    return next((r.get("certificate_id") for r in lb.get("forwarding_rules") or []
                 if r.get("entry_protocol") == "https"), None)


# ---- the provisioner ---------------------------------------------------------------------

Remote = Callable[[SshTargetConfig, str, str | None], Awaitable[int | None]]


async def _ssh_remote(cfg: SshTargetConfig, command: str, stdin: str | None) -> int | None:
    async with get_sessionmaker()() as s:
        result = await ssh.run_command(cfg, s, command, input=stdin, timeout=SQL_TIMEOUT)
    return result.exit_status


class DoProvisioner:
    """The real DigitalOcean provisioner. Waits, the clock, the ref lookup
    and the commands on droplets are injectable for tests."""

    STEPS = ("do_prepare", "go_live", "do_destroy")

    def __init__(self, *, settings: Settings,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 poll: float = POLL_SECONDS, now: Callable[[], datetime] | None = None,
                 resolve=None, remote: Remote | None = None, dns_wait: float = certs.DNS_WAIT,
                 waits: dict | None = None, smoke_attempts: int = smoke.ATTEMPTS,
                 smoke_delay: float = smoke.DELAY):
        self._settings = settings
        self._sleep = sleep
        self._poll = poll
        self._now = now or (lambda: datetime.now(UTC))
        self._resolve = resolve or gitref.resolve_ref
        self._remote = remote or _ssh_remote
        self._dns_wait = dns_wait
        self._waits = {**WAITS, **(waits or {})}
        self._smoke_attempts = smoke_attempts
        self._smoke_delay = smoke_delay

    async def run(self, step: str, ctx: DoContext, out: Output) -> VmOutcome:
        if step not in self.STEPS:
            raise ValueError(f"{step!r} isn't a DigitalOcean step")
        try:
            async with do_api.connect(ctx.token, sleep=self._sleep) as api:
                if step == "do_prepare":
                    return await self._prepare(api, ctx, out)
                if step == "go_live":
                    await self._go_live(api, ctx, out)
                else:
                    await self._destroy(api, ctx, out)
                return VmOutcome()
        except DoError as e:
            raise StepFailed(e.reason) from None
        except spaces.SpacesError as e:
            raise StepFailed(e.reason) from None

    # ---- shared helpers ------------------------------------------------------------------

    def _tries(self, seconds: int) -> int:
        return max(1, int(seconds // self._poll)) if self._poll else max(1, seconds)

    async def _wait(self, fetch, ready, seconds: int, what: str) -> dict:
        for _ in range(self._tries(seconds)):
            found = await fetch()
            if found is None:
                raise StepFailed(f"{what} disappeared from DigitalOcean while Sirdar waited.")
            if ready(found):
                return found
            await self._sleep(self._poll)
        raise StepFailed(f"{what} wasn't ready after {seconds // 60} minutes.")

    def _slot_config(self, ctx: DoContext, slot: str, ip: str) -> SshTargetConfig:
        return SshTargetConfig(host=ip, port=vms.VM_SSH_PORT, user=vms.VM_USER,
                               private_key=ctx.ssh_private_key,
                               key_name=f"Sirdar's key for {do_envs.droplet_name(ctx.env_name, slot)}")

    # ---- step 0 --------------------------------------------------------------------------

    async def _prepare(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> VmOutcome:
        if ctx.slot is None:
            raise StepFailed("This deployment has no slot to build. Start a new deployment.")
        await self._check_team(api, ctx, out)
        vpc = await self._vpc(api, ctx, out)
        await self._bucket(api, ctx, out)
        host_keys = {s.slot: s.host_key_public for s in ctx.slot_states}
        droplets = await self._droplets(api, ctx, vpc, host_keys, out)
        database = await self._database(api, ctx, vpc, droplets, out)
        await self._pin(ctx, droplets, host_keys, out)
        sha = await vmcommon.resolve_ref(self._settings, self._resolve, env_id=ctx.env_id,
                                         git_ref=ctx.git_ref, repo_url=ctx.repo_url, out=out,
                                         slot=ctx.slot)
        await self._grants(ctx, droplets, database, out)
        cert = await self._certificate(api, ctx, out)
        lb = await self._load_balancer(api, ctx, vpc, cert, droplets, out)
        await self._firewall(api, ctx, lb, out)
        return VmOutcome(sha=sha)

    async def _check_team(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        account = await api.account()
        team = account.get("team") if isinstance(account.get("team"), dict) else {}
        uuid_ = team.get("uuid") or f"personal:{account.get('uuid')}"
        if ctx.team_uuid is None:
            await do_envs.set_do(ctx.env_id, team_uuid=uuid_)
            out(f"Building in the {ctx.account_label} account ({team.get('name') or uuid_}).\n")
        elif uuid_ != ctx.team_uuid:
            raise StepFailed(f"The {ctx.account_label} DigitalOcean token now answers for "
                             "another team than the one this environment was built in. Sirdar "
                             "changed nothing. Put back a token for that team in Settings › "
                             "Integrations, then retry.")

    async def _vpc(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> dict:
        name = do_envs.resource_name(ctx.env_name)
        marker = f"sirdar:{ctx.env_id}"
        vpc = None
        for rec in (await load_records(ctx.env_id)).find("vpc"):
            found = await api.vpc(rec.do_id)
            if found is None:
                await do_envs.forget(ctx.env_id, "vpc", rec.do_id)
                out(f"The VPC {name} Sirdar recorded is gone; making it again.\n")
                continue
            if found.get("name") != name or marker not in str(found.get("description") or ""):
                raise StepFailed(f"VPC {rec.do_id} no longer looks like Sirdar's {name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            vpc = found
        if vpc is None:
            vpc = await api.create_vpc(name, ctx.region, f"{marker} Built by Sirdar for the "
                                                         f"environment {ctx.env_name}.")
            await do_envs.record(ctx.env_id, "vpc", vpc["id"], name)
            out(f"Created the VPC {name} ({vpc.get('ip_range')}).\n")
        else:
            out(f"VPC {name}: in place ({vpc.get('ip_range')}).\n")
        await do_envs.set_do(ctx.env_id, vpc_ip_range=vpc.get("ip_range"))
        return vpc

    async def _setup_key(self, api: DigitalOceanApi, ctx: DoContext) -> spaces.SpacesKey:
        name = do_envs.resource_name(ctx.env_name, "-setup")
        key = await api.create_spaces_key(name, [{"bucket": "", "permission": "fullaccess"}])
        await do_envs.record(ctx.env_id, "spaces_key", key["access_key"], name)
        return spaces.SpacesKey(key["access_key"], key["secret_key"])

    async def _drop_setup_key(self, api: DigitalOceanApi, ctx: DoContext, access_key: str):
        await api.delete_spaces_key(access_key)
        await do_envs.forget(ctx.env_id, "spaces_key", access_key)

    async def _bucket(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        setup_name = do_envs.resource_name(ctx.env_name, "-setup")
        app_name = do_envs.resource_name(ctx.env_name)
        records = await load_records(ctx.env_id)
        for rec in records.find("spaces_key"):
            if rec.name == setup_name:              # a run stopped before deleting it
                await self._drop_setup_key(api, ctx, rec.do_id)
                out("Removed a temporary Spaces key a stopped run left behind.\n")
        if not records.find("bucket"):
            setup = await self._setup_key(api, ctx)
            try:
                made = await spaces.create_bucket(ctx.bucket, ctx.region, setup)
            finally:
                await self._drop_setup_key(api, ctx, setup.access_key)
            await do_envs.record(ctx.env_id, "bucket", ctx.bucket, ctx.bucket)
            out(f"Created the bucket {ctx.bucket}.\n" if made
                else f"Bucket {ctx.bucket}: already this account's; recorded it.\n")
        else:
            out(f"Bucket {ctx.bucket}: in place.\n")
        if not [r for r in records.find("spaces_key") if r.name == app_name]:
            key = await api.create_spaces_key(app_name, [{"bucket": ctx.bucket,
                                                          "permission": "readwrite"}])
            await do_envs.record(ctx.env_id, "spaces_key", key["access_key"], app_name)
            await do_envs.set_do(ctx.env_id, spaces_key_id=key["access_key"],
                                 spaces_secret_enc=vault.encrypt(self._settings,
                                                                 key["secret_key"]))
            out(f"Made the bucket's own key {key['access_key']}.\n")

    def _check_tagged(self, ctx: DoContext, found: dict, name: str, what: str) -> None:
        if found.get("name") != name or do_envs.env_tag(ctx.env_id) not in (found.get("tags")
                                                                             or []):
            raise StepFailed(f"The {what} Sirdar recorded as {name} ({found.get('id')}) no "
                             "longer carries Sirdar's tag and name for this environment. Sirdar "
                             "changed nothing: put them back or remove it by hand, then retry.")

    async def _droplets(self, api: DigitalOceanApi, ctx: DoContext, vpc: dict,
                        host_keys: dict[str, str], out: Output) -> dict[str, dict]:
        records = await load_records(ctx.env_id)
        tagged = {d.get("name"): d for d in await api.droplets_tagged(do_envs.env_tag(ctx.env_id))}
        found: dict[str, dict] = {}
        for slot in ctx.slots:
            name = do_envs.droplet_name(ctx.env_name, slot)
            droplet = None
            for rec in records.find("droplet", slot):
                live = await api.droplet(rec.do_id)
                if live is None:
                    await do_envs.forget(ctx.env_id, "droplet", rec.do_id)
                    out(f"{name}: the droplet Sirdar recorded is gone; building it again.\n")
                    continue
                self._check_tagged(ctx, live, name, "droplet")
                droplet = live
            if droplet is None and name in tagged:
                droplet = tagged[name]
                await do_envs.record(ctx.env_id, "droplet", droplet["id"], name, slot)
                out(f"{name}: found it by its tag and recorded it.\n")
            if droplet is None:
                droplet = await self._create_droplet(api, ctx, slot, vpc, host_keys, out)
            else:
                out(f"{name}: in place (droplet {droplet['id']}).\n")
            found[slot] = droplet
        for slot, droplet in list(found.items()):
            name = do_envs.droplet_name(ctx.env_name, slot)
            ready = await self._wait(
                lambda d=droplet: api.droplet(str(d["id"])),
                lambda d: d.get("status") == "active" and all(do_api.droplet_ips(d)),
                self._waits["droplet"], f"The droplet {name}")
            public, private = do_api.droplet_ips(ready)
            await do_envs.set_slot(ctx.env_id, slot, droplet_id=str(ready["id"]),
                                   public_ip=public, private_ip=private)
            found[slot] = ready
        return found

    async def _create_droplet(self, api: DigitalOceanApi, ctx: DoContext, slot: str, vpc: dict,
                              host_keys: dict[str, str], out: Output) -> dict:
        name = do_envs.droplet_name(ctx.env_name, slot)
        private = ctx.slot_state(slot).host_key_private
        if private is None:
            # Delivered to a droplet that is gone: a new key for the new droplet.
            private, public = vms.new_host_keypair(f"{ctx.env_name}-{slot}")
            await do_envs.set_slot(ctx.env_id, slot, host_key_public=public,
                                   host_key_private_enc=vault.encrypt(self._settings, private))
            host_keys[slot] = public
        user_data = cloudinit.droplet_userdata(hostname=name, ssh_public_key=ctx.ssh_public_key,
                                               host_key_private=private,
                                               host_key_public=host_keys[slot])
        made = await api.create_droplet({
            "name": name, "region": ctx.region, "size": ctx.droplet_size,
            "image": ctx.droplet_image, "vpc_uuid": vpc["id"], "ipv6": False,
            "monitoring": True, "tags": do_envs.tags(ctx.env_id, ctx.env_name, slot),
            "user_data": user_data})
        await do_envs.record(ctx.env_id, "droplet", made["id"], name, slot)
        out(f"{name}: created droplet {made['id']} ({ctx.droplet_size}, {ctx.droplet_image}).\n")
        return made

    async def _database(self, api: DigitalOceanApi, ctx: DoContext, vpc: dict,
                        droplets: dict[str, dict], out: Output) -> dict:
        name = do_envs.resource_name(ctx.env_name, "-db")
        env_tag = do_envs.env_tag(ctx.env_id)
        database = None
        for rec in (await load_records(ctx.env_id)).find("database"):
            live = await api.database(rec.do_id)
            if live is None:
                await do_envs.forget(ctx.env_id, "database", rec.do_id)
                out(f"The database {name} Sirdar recorded is gone; creating it again.\n")
                continue
            self._check_tagged(ctx, live, name, "database")
            database = live
        if database is None:
            tagged = [d for d in await api.databases_tagged(env_tag) if d.get("name") == name]
            if tagged:
                database = tagged[0]
                await do_envs.record(ctx.env_id, "database", database["id"], name)
                out(f"Database {name}: found it by its tag and recorded it.\n")
        if database is None:
            database = await api.create_database({
                "name": name, "engine": "pg", "version": "16", "region": ctx.region,
                "size": ctx.db_size, "num_nodes": 2 if ctx.db_standby else 1,
                "private_network_uuid": vpc["id"],
                "tags": do_envs.tags(ctx.env_id, ctx.env_name)})
            await do_envs.record(ctx.env_id, "database", database["id"], name)
            out(f"Creating the database cluster {name} (PostgreSQL 16, {ctx.db_size}"
                f"{', with a standby node' if ctx.db_standby else ''}).\n")
        else:
            out(f"Database {name}: in place.\n")
        await self._db_firewall(api, database["id"], [str(d["id"]) for d in droplets.values()],
                                out)
        online = await self._wait(lambda: api.database(database["id"]),
                                  lambda d: d.get("status") == "online",
                                  self._waits["database"], f"The database {name}")
        private = online.get("private_connection") or {}
        host, port = private.get("host"), private.get("port")
        if not host or not port:
            raise StepFailed("DigitalOcean didn't give the database a private address.")
        admin = ((online.get("connection") or {}).get("password")
                 or (database.get("connection") or {}).get("password") or ctx.db_admin_password)
        if not admin:
            raise StepFailed("DigitalOcean didn't give Sirdar the database's admin password.")
        await do_envs.set_do(ctx.env_id, db_host=host, db_port=int(port),
                             db_ca_cert=await api.database_ca(database["id"]),
                             db_admin_password_enc=vault.encrypt(self._settings, admin))
        out(f"Database {name}: online at {host}:{port}.\n")
        return {"id": database["id"], "host": host, "port": int(port), "admin": admin}

    async def _db_firewall(self, api: DigitalOceanApi, database_id: str,
                           droplet_ids: list[str], out: Output) -> None:
        """Only this environment's droplets, by droplet ID: set right after the
        cluster is created, retried while DigitalOcean isn't ready for it."""
        wanted = sorted(("droplet", d) for d in droplet_ids)
        for _ in range(FIREWALL_TRIES):
            current = sorted((r["type"], str(r["value"]))
                             for r in await api.database_firewall(database_id))
            if current == wanted:
                return
            try:
                await api.set_database_firewall(database_id, droplet_ids)
            except DoError as e:
                if e.status in (409, 422):
                    await self._sleep(self._poll)
                    continue
                raise
            out("Database firewall: only this environment's droplets may connect.\n")
            return
        raise StepFailed("DigitalOcean didn't accept the database firewall in time. Sirdar "
                         "won't go on while the database isn't locked to the droplets.")

    async def _pin(self, ctx: DoContext, droplets: dict[str, dict], host_keys: dict[str, str],
                   out: Output) -> None:
        saved = {cfg.host for _, cfg in targets.ssh_configs(self._settings)}
        for slot, droplet in droplets.items():
            name = do_envs.droplet_name(ctx.env_name, slot)
            ip, _ = do_api.droplet_ips(droplet)
            if ip in saved:
                raise StepFailed(f"{ip} is a saved SSH target's address. Sirdar won't pin a "
                                 "droplet's key there.")
            expected = known_hosts.fingerprint(asyncssh.import_public_key(host_keys[slot]))
            await vmcommon.confirm_pin(
                ip=ip, expected=expected, actor_id=ctx.actor_id, target_id="digitalocean",
                tries=self._tries(self._waits["ssh"]), poll=self._poll, sleep=self._sleep,
                out=out, how="the key Sirdar generated for the droplet",
                mismatch=(f"{name} answered SSH with a host key Sirdar didn't generate for it. "
                          "Sirdar trusted nothing. Check the droplet in DigitalOcean, then "
                          "retry."), minutes=self._waits["ssh"] // 60)
            await do_envs.set_slot(ctx.env_id, slot, host_key_private_enc=None)

    async def _grants(self, ctx: DoContext, droplets: dict[str, dict], database: dict,
                      out: Output) -> None:
        name = do_envs.droplet_name(ctx.env_name, ctx.slot)
        ip, _ = do_api.droplet_ips(droplets[ctx.slot])
        cfg = self._slot_config(ctx, ctx.slot, ip)
        if await self._remote(cfg, _READY, None) != 0:
            raise StepFailed(f"cloud-init didn't finish setting up {name} (psql is missing). "
                             "Retry from step 0.")
        sql = pgauth.setup_sql(role=do_envs.DB_USER, database=do_envs.DB_NAME,
                               verifier=pgauth.scram_sha256(ctx.db_password))
        command = (f"bash -c {shlex.quote(_PSQL)} {shlex.quote(database['host'])} "
                   f"{int(database['port'])}")
        code = await self._remote(cfg, command, f"{database['admin']}\n{sql}")
        if code != 0:
            raise StepFailed("The managed database didn't accept Sirdar's setup (psql exited "
                             f"{code}). Retry from step 0.")
        out(f"Database: {do_envs.DB_USER} owns {do_envs.DB_NAME}.\n")

    async def _certificate(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> dict:
        records = await load_records(ctx.env_id)
        recorded = {r.do_id for r in records.find("certificate")}
        current = None
        for rec in records.find("load_balancer"):
            lb = await api.load_balancer(rec.do_id)
            current = https_certificate(lb) if lb else None
            if current and current not in recorded:
                cert = await api.certificate(current)
                if cert is not None and certs.is_ours(cert, ctx.env_name, ctx.names):
                    await do_envs.record(ctx.env_id, "certificate", current, cert["name"])
                    recorded.add(current)
                    out(f"Recorded the certificate {cert['name']} the cert-worker uploaded.\n")
        live = []
        for cert_id in sorted(recorded):
            cert = await api.certificate(cert_id)
            if cert is None:
                await do_envs.forget(ctx.env_id, "certificate", cert_id)
                continue
            live.append(cert)
        # The latest to expire; on a tie, the one the load balancer already uses.
        oldest = datetime.min.replace(tzinfo=UTC)
        best = max(live, key=lambda c: (certs.not_after(c) or oldest, c["id"] == current),
                   default=None)
        now = self._now()
        when = certs.not_after(best) if best else None
        if when is not None and certs.days_left(when, now) > certs.SIRDAR_RENEW_DAYS:
            out(f"Certificate {best['name']}: valid until {when:%Y-%m-%d}.\n")
        else:
            if ctx.cloudflare is None:
                raise StepFailed("Cloudflare isn't set up, so Sirdar can't prove to Let's Encrypt "
                                 "that it owns these names. Add it in Settings › Integrations, "
                                 "then retry.")
            out("Requesting a Let's Encrypt certificate"
                f"{' (staging)' if ctx.acme_staging else ''} for {', '.join(ctx.names)}.\n")
            try:
                issued = await certs.issue_dns01(
                    self._settings, names=ctx.names, directory=ctx.acme_directory,
                    cloudflare=ctx.cloudflare, out=out, sleep=self._sleep,
                    dns_wait=self._dns_wait, poll=self._poll)
            except certs.CertError as e:
                raise StepFailed(e.reason) from None
            name = certs.cert_name(ctx.env_name, now)
            best = await api.create_certificate(name, issued.key_pem, issued.leaf_pem,
                                                issued.chain_pem)
            await do_envs.record(ctx.env_id, "certificate", best["id"], name)
            out(f"Uploaded the certificate {name} (valid until {issued.not_after:%Y-%m-%d}).\n")
        await do_envs.set_do(ctx.env_id, cert_not_after=certs.not_after(best))
        return best

    async def _load_balancer(self, api: DigitalOceanApi, ctx: DoContext, vpc: dict, cert: dict,
                             droplets: dict[str, dict], out: Output) -> dict:
        name = do_envs.resource_name(ctx.env_name, "-lb")
        lb = None
        for rec in (await load_records(ctx.env_id)).find("load_balancer"):
            live = await api.load_balancer(rec.do_id)
            if live is None:
                await do_envs.forget(ctx.env_id, "load_balancer", rec.do_id)
                out(f"The load balancer {name} Sirdar recorded is gone; creating it again.\n")
                continue
            if live.get("name") != name:
                raise StepFailed(f"Load balancer {rec.do_id} is no longer named {name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            lb = live
        if lb is None:
            active = droplets.get(ctx.active_slot) if ctx.active_slot else None
            lb = await api.create_load_balancer(lb_body(ctx, vpc["id"], cert["id"],
                                                        [int(active["id"])] if active else []))
            await do_envs.record(ctx.env_id, "load_balancer", lb["id"], name)
            out(f"Creating the load balancer {name}.\n")
        elif https_certificate(lb) != cert["id"]:
            lb = await api.update_load_balancer(lb["id"], lb_update_body(
                lb, forwarding_rules=_rules(cert["id"])))
            out(f"Load balancer {name}: now uses the certificate {cert['name']}.\n")
        ready = await self._wait(lambda: api.load_balancer(lb["id"]),
                                 lambda x: x.get("status") == "active" and bool(x.get("ip")),
                                 self._waits["lb"], f"The load balancer {name}")
        await do_envs.set_do(ctx.env_id, lb_ip=ready["ip"])
        out(f"Load balancer {name}: active at {ready['ip']}.\n")
        await self._retire_certificates(api, ctx, cert["id"], out)
        return ready

    async def _retire_certificates(self, api: DigitalOceanApi, ctx: DoContext, keep: str,
                                   out: Output) -> None:
        for rec in (await load_records(ctx.env_id)).find("certificate"):
            if rec.do_id == keep:
                continue
            try:
                gone = await api.delete_certificate(rec.do_id)
            except do_api.DoForbidden:
                out(f"Certificate {rec.name}: still in use; left for the next run.\n")
                continue
            await do_envs.forget(ctx.env_id, "certificate", rec.do_id)
            out(f"Certificate {rec.name}: {'deleted' if gone else 'already gone'}.\n")

    async def _firewall(self, api: DigitalOceanApi, ctx: DoContext, lb: dict,
                        out: Output) -> None:
        name = do_envs.resource_name(ctx.env_name, "-fw")
        for rec in (await load_records(ctx.env_id)).find("firewall"):
            live = await api.firewall(rec.do_id)
            if live is None:
                await do_envs.forget(ctx.env_id, "firewall", rec.do_id)
                continue
            if live.get("name") != name:
                raise StepFailed(f"Cloud firewall {rec.do_id} is no longer named {name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            sources = [r.get("sources") or {} for r in live.get("inbound_rules") or []]
            if any(lb["id"] in (s.get("load_balancer_uids") or []) for s in sources):
                out(f"Cloud firewall {name}: in place.\n")
                return
            await api.delete_firewall(rec.do_id)         # its load balancer was rebuilt
            await do_envs.forget(ctx.env_id, "firewall", rec.do_id)
        everywhere = {"addresses": ["0.0.0.0/0", "::/0"]}
        made = await api.create_firewall({
            "name": name, "tags": [do_envs.env_tag(ctx.env_id)],
            "inbound_rules": [
                {"protocol": "tcp", "ports": "22", "sources": everywhere},
                {"protocol": "tcp", "ports": "80", "sources": {"load_balancer_uids": [lb["id"]]}}],
            "outbound_rules": [
                {"protocol": "tcp", "ports": "all", "destinations": everywhere},
                {"protocol": "udp", "ports": "all", "destinations": everywhere},
                {"protocol": "icmp", "destinations": everywhere}]})
        await do_envs.record(ctx.env_id, "firewall", made["id"], name)
        out(f"Cloud firewall {name}: SSH from anywhere, HTTP only from the load balancer.\n")

    # Task 10: _go_live and _destroy.
    async def _go_live(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        raise StepFailed("Switch traffic isn't built yet.")

    async def _destroy(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        raise StepFailed("Remove DigitalOcean resources isn't built yet.")
```

In `test_the_first_run_builds_everything`, "Created the VPC ss-uat9" matches `Created the VPC {name} (…)`; "Load balancer ss-uat9-lb: active" matches the last load balancer line.

- [ ] **Step 6: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_pgauth.py tests/test_deploy_cloudinit.py tests/test_deploy_do_provision.py tests/test_deploy_vmcommon.py tests/test_deploy_ssh.py`
Expected: all PASS. If the RFC 7677 test fails, check the AuthMessage strings against RFC 7677 §3 before changing `scram_sha256`.

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/do_provision.py src/sirdar_api/deploy/pgauth.py src/sirdar_api/deploy/cloudinit.py src/sirdar_api/deploy/ssh.py src/sirdar_api/deploy/vmcommon.py tests/do_helpers.py tests/test_deploy_do_provision.py tests/test_deploy_pgauth.py tests/test_deploy_cloudinit.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/do_provision.py sirdar/api/src/sirdar_api/deploy/pgauth.py sirdar/api/src/sirdar_api/deploy/cloudinit.py sirdar/api/src/sirdar_api/deploy/ssh.py sirdar/api/src/sirdar_api/deploy/vmcommon.py sirdar/api/tests/do_helpers.py sirdar/api/tests/test_deploy_do_provision.py sirdar/api/tests/test_deploy_pgauth.py sirdar/api/tests/test_deploy_cloudinit.py
git commit -m "feat(sirdar): step 0 Prepare DigitalOcean — VPC, bucket, droplets, database, certificate, load balancer, firewall

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Switch traffic (step 14) and Remove DigitalOcean resources (step 18)

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/do_provision.py` (`_go_live`, `_destroy`)
- Modify: `sirdar/api/src/sirdar_api/deploy/smoke.py` (`insecure`)
- Create: `sirdar/api/tests/test_deploy_do_switch_and_remove.py`

**Interfaces:**
- Consumes: Task 9's `DoProvisioner`, `load_records`, `lb_update_body`, `_check_tagged`, `_setup_key`, `_drop_setup_key`; `spaces.empty_bucket`, `spaces.delete_bucket`; `vmcommon.forget_pin`.
- Produces:
  - `go_live`: points the load balancer at `ctx.slot`'s droplet (`ctx.slot is None`: at no droplet — 7b's Deactivate), then (with a slot) runs the public smoke test through the load balancer's IP; on failure puts the previous targets back and fails.
  - `do_destroy`: checks every recorded resource still matches before deleting anything, then removes the load balancer, certificates, cloud firewall, droplets (and droplets tagged for the environment but not recorded; forgets their pinned host keys), database clusters (same), Spaces keys, the bucket (emptied with a temporary full-access key) and the VPC (once it has no members), forgetting each row as it goes.
  - `smoke.run(..., insecure: bool = False)`: with `insecure`, certificates aren't verified (ACME staging).

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_do_switch_and_remove.py`:

```python
"""Step 14 Switch traffic and step 18 Remove DigitalOcean resources against
the fakes: the load balancer moves to the slot and back on a failed public
smoke test; Delete checks everything first, removes only what Sirdar
recorded (and droplets/databases carrying the environment's tag), forgets
each row as it goes and resumes after a failure."""

import httpx
import pytest
from sqlalchemy import select

from sirdar_api.db.models import DoResource
from sirdar_api.deploy import do_envs, known_hosts, smoke, vms
from sirdar_api.deploy.publish import StepFailed

from .do_helpers import do_build  # noqa: F401


def _answer(status: int):
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(status)

    return httpx.MockTransport(handler), seen


def _lb(fake) -> dict:
    (lb,) = fake.load_balancers.values()
    return lb


def _droplet_id(fake, slot: str) -> int:
    return next(d["id"] for d in fake.droplets.values() if d["name"] == f"ss-uat9-{slot}")


async def test_switch_traffic_to_the_slot(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, seen = _answer(200)
    await do_build.run("go_live", slot="orange")
    fake = do_build.cloud.do
    assert _lb(fake)["droplet_ids"] == [_droplet_id(fake, "orange")]
    assert {r.headers["host"] for r in seen} >= {"api.uat9.serversherpa.com",
                                                 "status.uat9.serversherpa.com"}
    assert all(r.url.host == fake.load_balancers[_lb(fake)["id"]]["ip"] for r in seen)
    assert "traffic now goes to orange" in do_build.log()


async def test_a_failed_public_check_puts_traffic_back(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, _ = _answer(200)
    await do_build.run("go_live", slot="orange")
    do_build.cloud.smoke, _ = _answer(502)
    with pytest.raises(StepFailed) as err:
        await do_build.run("go_live", slot="purple")
    fake = do_build.cloud.do
    assert _lb(fake)["droplet_ids"] == [_droplet_id(fake, "orange")]
    assert "didn't answer through the load balancer" in err.value.reason
    assert "Put traffic back on orange" in do_build.log()


async def test_staging_certificates_are_not_verified(db, do_build, monkeypatch):
    await do_build.run()
    await do_envs.set_do(do_build.env.id, acme_staging=True)
    seen = {}

    async def fake_run(targets, proxy_ip, **kw):
        seen.update(kw)
        return [smoke.SmokeResult(s, f"https://{h}/", True, "HTTP 200") for s, h in targets]

    monkeypatch.setattr(smoke, "run", fake_run)
    await do_build.run("go_live", slot="orange")
    assert seen["insecure"] is True


async def test_deactivate_points_at_no_droplet(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, seen = _answer(200)
    await do_build.run("go_live", slot="orange")
    seen.clear()
    await do_build.run("go_live", slot=None)
    assert _lb(do_build.cloud.do)["droplet_ids"] == []
    assert seen == []


async def test_remove_everything(db, do_build):
    await do_build.run()
    fake, spaces_fake = do_build.cloud.do, do_build.cloud.spaces
    for i in range(3):
        spaces_fake.put(do_build.env.spaces_bucket, f"files/{i}.pdf", b"x")
    stranger = fake.add_droplet("someone-elses", ["web"])
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert list(fake.droplets) == [str(stranger["id"])]
    assert (fake.vpcs, fake.databases, fake.keys, fake.certificates, fake.load_balancers,
            fake.firewalls) == ({}, {}, {}, {}, {}, {})
    assert do_build.env.spaces_bucket not in spaces_fake.buckets
    assert (await db.scalars(select(DoResource))).all() == []
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is None
    log = do_build.log()
    assert "emptied (3 objects)" in log and "Forgot 127.0.0.1's SSH host key" in log


async def test_remove_finds_tagged_droplets_it_lost(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    await db.execute(DoResource.__table__.delete().where(DoResource.kind == "droplet",
                                                         DoResource.slot == "purple"))
    await db.commit()
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert fake.droplets == {}
    assert "tagged for this environment but not recorded" in do_build.log()


async def test_remove_checks_everything_before_deleting(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    next(iter(fake.databases.values()))["tags"] = []
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert "no longer carries Sirdar's tag" in err.value.reason
    assert fake.writes()[before:] == []


async def test_remove_resumes_after_a_failure(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.vpc_lingering = 10_000                      # the VPC never empties this time
    with pytest.raises(StepFailed) as err:
        await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert "still has members" in err.value.reason
    kinds = {r.kind for r in (await db.scalars(select(DoResource))).all()}
    assert kinds == {"vpc"}
    fake.vpc_lingering = 0
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert fake.vpcs == {} and (await db.scalars(select(DoResource))).all() == []
```

Pass a small VPC wait so the failure test is quick: `Build.provisioner` already passes `poll=0`; `_tries(seconds)` then equals `seconds` (600 tries), which is fast with the no-op sleep.

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_switch_and_remove.py`
Expected: FAIL ("Switch traffic isn't built yet.").

- [ ] **Step 3: `smoke.insecure`**

In `sirdar/api/src/sirdar_api/deploy/smoke.py`, `_check` gains `insecure: bool = False` and builds its client with `verify=not insecure`; `run` gains `insecure: bool = False` and passes it to `_check`. Add to the module docstring: "With insecure (a DigitalOcean environment on Let's Encrypt staging) the certificate isn't verified."

- [ ] **Step 4: Steps 14 and 18**

In `sirdar/api/src/sirdar_api/deploy/do_provision.py`, import `outbound` from `sirdar_api.deploy`, and replace the two placeholder methods:

```python
    # ---- step 14: Switch traffic ---------------------------------------------------------

    async def _live_lb(self, api: DigitalOceanApi, ctx: DoContext, records: Records) -> dict:
        name = do_envs.resource_name(ctx.env_name, "-lb")
        recs = records.find("load_balancer")
        if not recs:
            raise StepFailed("This environment has no load balancer yet. Retry from step 0.")
        lb = await api.load_balancer(recs[0].do_id)
        if lb is None:
            raise StepFailed("The load balancer Sirdar recorded is gone. Deploy again: step 0 "
                             "builds a new one.")
        if lb.get("name") != name:
            raise StepFailed(f"Load balancer {lb.get('id')} is no longer named {name}. Sirdar "
                             "changed nothing: fix it by hand, then retry.")
        return lb

    async def _public_smoke(self, ctx: DoContext, lb_ip: str, out: Output) -> list[str]:
        results = await smoke.run(list(ctx.hosts), lb_ip,
                                  transport=outbound.transports().get("smoke"),
                                  sleep=self._sleep, attempts=self._smoke_attempts,
                                  delay=self._smoke_delay, out=out, insecure=ctx.acme_staging)
        for r in results:
            out(f"{r.url}: {r.detail}\n")
        return [r.service for r in results if not r.ok]

    async def _go_live(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        records = await load_records(ctx.env_id)
        lb = await self._live_lb(api, ctx, records)
        name = lb["name"]
        previous = [int(d) for d in lb.get("droplet_ids") or []]
        before = next((r.slot for r in records.find("droplet")
                       if int(r.do_id) in previous), None)
        if ctx.slot is None:
            wanted = []
        else:
            recs = records.find("droplet", ctx.slot)
            droplet = await api.droplet(recs[0].do_id) if recs else None
            if droplet is None:
                raise StepFailed(f"The {ctx.slot} slot has no droplet. Deploy to it first.")
            self._check_tagged(ctx, droplet, do_envs.droplet_name(ctx.env_name, ctx.slot),
                               "droplet")
            wanted = [int(droplet["id"])]
        if previous != wanted:
            await api.update_load_balancer(lb["id"], lb_update_body(lb, droplet_ids=wanted))
            out(f"Load balancer {name}: traffic now goes to {ctx.slot or 'no slot'}"
                f"{f' (was {before})' if before else ''}.\n")
        else:
            out(f"Load balancer {name}: already sends traffic to {ctx.slot or 'no slot'}.\n")
        if ctx.slot is None:
            return
        failed = await self._public_smoke(ctx, lb["ip"], out)
        if not failed:
            return
        if previous != wanted:
            current = await api.load_balancer(lb["id"]) or lb
            await api.update_load_balancer(lb["id"], lb_update_body(current,
                                                                    droplet_ids=previous))
            out(f"Put traffic back on {before or 'no slot'}.\n")
        raise StepFailed(f"{len(failed)} of {len(ctx.hosts)} public URLs didn't answer through "
                         f"the load balancer: {', '.join(failed)}. Traffic stays where it was.")

    # ---- step 18: Remove DigitalOcean resources -------------------------------------------

    _FETCH = {"vpc": "vpc", "droplet": "droplet", "database": "database",
              "certificate": "certificate", "load_balancer": "load_balancer",
              "firewall": "firewall"}

    async def _check_all(self, api: DigitalOceanApi, ctx: DoContext, records: Records) -> None:
        """Before anything is deleted: every recorded resource that still
        exists must still match (tag or exact name)."""
        for rec in records.resources:
            if rec.kind not in self._FETCH:
                continue
            live = await getattr(api, self._FETCH[rec.kind])(rec.do_id)
            if live is None:
                continue
            if rec.kind in ("droplet", "database"):
                self._check_tagged(ctx, live, rec.name, rec.kind.replace("_", " "))
            elif rec.kind == "certificate":
                if not str(live.get("name") or "").startswith(f"ss-{ctx.env_name}-"):
                    raise StepFailed(f"Certificate {rec.do_id} is no longer one of Sirdar's for "
                                     f"{ctx.env_name}. Sirdar changed nothing.")
            elif rec.kind == "vpc":
                if live.get("name") != rec.name or f"sirdar:{ctx.env_id}" not in str(
                        live.get("description") or ""):
                    raise StepFailed(f"VPC {rec.do_id} no longer looks like Sirdar's {rec.name}. "
                                     "Sirdar changed nothing.")
            elif live.get("name") != rec.name:
                raise StepFailed(f"The {rec.kind.replace('_', ' ')} {rec.do_id} is no longer "
                                 f"named {rec.name}. Sirdar changed nothing.")

    async def _remove(self, api: DigitalOceanApi, ctx: DoContext, rec: DoResource,
                      delete, out: Output) -> None:
        gone = await delete(rec.do_id)
        await do_envs.forget(ctx.env_id, rec.kind, rec.do_id)
        out(f"{rec.name}: {'deleted' if gone else 'already gone'}.\n")

    async def _destroy(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        records = await load_records(ctx.env_id)
        await self._check_all(api, ctx, records)
        env_tag = do_envs.env_tag(ctx.env_id)
        for rec in records.find("load_balancer"):
            await self._remove(api, ctx, rec, api.delete_load_balancer, out)
        for rec in records.find("certificate"):
            await self._remove(api, ctx, rec, api.delete_certificate, out)
        for rec in records.find("firewall"):
            await self._remove(api, ctx, rec, api.delete_firewall, out)
        # Droplets: the recorded ones, then any carrying this environment's tag.
        ips = {s.public_ip for s in records.slots.values() if s.public_ip}
        recorded = {r.do_id for r in records.find("droplet")}
        for rec in records.find("droplet"):
            await self._remove(api, ctx, rec, api.delete_droplet, out)
        for droplet in await api.droplets_tagged(env_tag):
            if str(droplet["id"]) in recorded:
                continue
            out(f"{droplet.get('name')}: tagged for this environment but not recorded; "
                "deleting it too.\n")
            await api.delete_droplet(str(droplet["id"]))
        for ip in sorted(ips):
            if await vmcommon.forget_pin(ip, ctx.actor_id, "digitalocean"):
                out(f"Forgot {ip}'s SSH host key.\n")
        recorded = {r.do_id for r in records.find("database")}
        for rec in records.find("database"):
            await self._remove(api, ctx, rec, api.delete_database, out)
        for database in await api.databases_tagged(env_tag):
            if str(database["id"]) not in recorded:
                out(f"{database.get('name')}: tagged for this environment but not recorded; "
                    "deleting it too.\n")
                await api.delete_database(str(database["id"]))
        for rec in records.find("spaces_key"):
            await self._remove(api, ctx, rec, api.delete_spaces_key, out)
        for rec in records.find("bucket"):
            setup = await self._setup_key(api, ctx)
            try:
                count = await spaces.empty_bucket(rec.do_id, ctx.region, setup)
                gone = await spaces.delete_bucket(rec.do_id, ctx.region, setup)
            finally:
                await self._drop_setup_key(api, ctx, setup.access_key)
            await do_envs.forget(ctx.env_id, "bucket", rec.do_id)
            out(f"Bucket {rec.name}: emptied ({count} objects) and "
                f"{'deleted' if gone else 'already gone'}.\n")
        for rec in records.find("vpc"):
            await self._remove_vpc(api, ctx, rec, out)
        out("Nothing of this environment is left on DigitalOcean.\n")

    async def _remove_vpc(self, api: DigitalOceanApi, ctx: DoContext, rec: DoResource,
                          out: Output) -> None:
        """A VPC can't go while it has members; deleted droplets and databases
        leave it a little later."""
        for _ in range(self._tries(self._waits["vpc"])):
            try:
                gone = await api.delete_vpc(rec.do_id)
            except DoError as e:
                if e.status in (403, 409, 422):
                    await self._sleep(self._poll)
                    continue
                raise
            await do_envs.forget(ctx.env_id, "vpc", rec.do_id)
            out(f"{rec.name}: {'deleted' if gone else 'already gone'}.\n")
            return
        raise StepFailed(f"The VPC {rec.name} still has members after "
                         f"{self._waits['vpc'] // 60} minutes. Retry Delete in a few minutes.")
```

- [ ] **Step 5: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_switch_and_remove.py tests/test_deploy_do_provision.py tests/test_deploy_smoke.py`
Expected: all PASS.

- [ ] **Step 6: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/do_provision.py src/sirdar_api/deploy/smoke.py tests/test_deploy_do_switch_and_remove.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/do_provision.py sirdar/api/src/sirdar_api/deploy/smoke.py sirdar/api/tests/test_deploy_do_switch_and_remove.py
git commit -m "feat(sirdar): Switch traffic and Remove DigitalOcean resources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: DigitalOcean plans and the pipeline

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (`activate` mode; `plan_for(..., cloud, go_live, snapshot)`)
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py` (cloud deployments)
- Modify: `sirdar/api/src/sirdar_api/deploy/vmsteps.py` (DigitalOcean dispatch)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_envs.py` (`after_success`)
- Modify: `sirdar/api/src/sirdar_api/deploy/publish.py` (DNS at the load balancer; no NPM on DigitalOcean)
- Modify: `sirdar/api/tests/test_deploy_playbooks.py` (`test_plans`' mode loop; cloud plans)
- Create: `sirdar/api/tests/test_deploy_pipeline_do.py`

**Interfaces:**
- Consumes: Task 8's step definitions and `do_envs.env_extra`; Task 9/10's `do_provision`.
- Produces:
  - `steps.MODES` adds `"activate"`; `steps.plan_for(mode, *, restore=False, publish=False, vm=False, cloud=False, go_live=False, snapshot=False)`. Cloud plans:
    - update: `do_prepare, preflight, bootstrap, fetch, render, build, dump, [restore], up, dns, slot_smoke, [go_live]` (numbers 0 1 2 3 4 5 6 [9] 10 12 13 [14]);
    - snapshot: `preflight, export`; publish: `dns`;
    - teardown: `[export], undns, do_destroy` (11 17 18);
    - activate: `slot_smoke, go_live` (13 14), and `go_live` is always part of it.
  - `pipeline.create_deployment(..., cloud=False, slot=None, go_live=False)`; `pipeline.takes_snapshot(dep) -> bool`.
  - `do_envs.after_success(db, env, dep)`: the slot's commit (Update), and on a deployment that went live the active slot and the environment's commit.
  - `vmsteps.HostProvisioner(*, proxmox, esxi=None, digitalocean=None)`.
  - `PublishContext.cloud`; `publish.ensure_dns(..., target=None)`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_playbooks.py`, in `test_plans`, change the mode loop to:

```python
    for mode in steps.MODES:
        cloud = mode == "activate"
        numbers = [s.number for s in steps.plan_for(mode, vm=mode == "vm_restore", cloud=cloud)]
        assert numbers == sorted(set(numbers)), f"{mode}: numbers must rise"
```

and append:

```python
def _cloud(mode, **kw):
    return [s.key for s in steps.plan_for(mode, cloud=True, **kw)]


def test_digitalocean_plans():
    build = ["do_prepare", "preflight", "bootstrap", "fetch", "render", "build"]
    assert _cloud("update") == [*build, "dump", "up", "dns", "slot_smoke"]
    assert _cloud("update", go_live=True)[-1] == "go_live"
    assert _cloud("update", restore=True) == [*build, "dump", "restore", "up", "dns",
                                              "slot_smoke"]
    assert [s.number for s in steps.plan_for("update", cloud=True, restore=True,
                                             go_live=True)] == [0, 1, 2, 3, 4, 5, 6, 9, 10, 12,
                                                                13, 14]
    assert _cloud("teardown") == ["undns", "do_destroy"]
    assert _cloud("teardown", snapshot=True) == ["export", "undns", "do_destroy"]
    assert _cloud("activate") == ["slot_smoke", "go_live"]
    assert _cloud("publish") == ["dns"] and _cloud("snapshot") == ["preflight", "export"]
    for mode, kw in (("reset", {}), ("restore_dump", {}), ("update", {"publish": True}),
                     ("update", {"vm": True}), ("teardown", {"go_live": True})):
        with pytest.raises(ValueError):
            steps.plan_for(mode, cloud=True, **kw)
    with pytest.raises(ValueError):
        steps.plan_for("activate")                       # only DigitalOcean activates
```

Create `sirdar/api/tests/test_deploy_pipeline_do.py`:

```python
"""The pipeline with a DigitalOcean environment: step 0 through the
provisioner, the host steps on the slot's droplet with the managed
database and Spaces in .env, DNS at the load balancer, the slot smoke test,
going live, and Delete with its snapshot. FakeProvisioner stands in for
DigitalOcean; its step 0 effect records what a real one would."""

import base64

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import DoSlot, Environment, Snapshot
from sirdar_api.deploy import do_envs, envfile, pipeline, snapshots, vault, vms
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.runner import RunResult

from .deploy_factories import (  # noqa: F401
    ENV_SECRETS,
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import make_do_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA, _load

SPACES_SECRET = "spaces-SECRET-pipeline-1"


async def _built(ctx) -> None:
    """What a real step 0 leaves behind."""
    await do_envs.set_do(ctx.env_id, lb_ip="203.0.113.50", vpc_ip_range="10.116.0.0/20",
                         db_host="private-ss-uat9-db.db.ondigitalocean.com", db_port=25060,
                         spaces_key_id="DO00KEY000001",
                         spaces_secret_enc=vault.encrypt(get_settings(), SPACES_SECRET))
    for i, slot in enumerate(ctx.slots):
        await do_envs.set_slot(ctx.env_id, slot, droplet_id=str(4001 + i), public_ip="127.0.0.1")


@pytest.fixture
async def do_env(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    env = await make_do_environment(db)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = _built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)
    return env


async def _start(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, git_ref="main", actor_id=None, cloud=True,
                                           **{"mode": "update", "sha": "", **kw})
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_a_first_deploy_goes_live(db, do_env, fake_runner, fake_publisher,
                                        fake_provisioner, ssh_server):
    fake_runner.output["render"] = [f"echo {SPACES_SECRET}\n"]
    dep_id = await _start(db, do_env, slot="orange", go_live=True)
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.status, s.log) for s in steps]
    assert [s.key for s in steps] == ["do_prepare", "preflight", "bootstrap", "fetch", "render",
                                      "build", "dump", "up", "dns", "slot_smoke", "go_live"]
    assert fake_provisioner.calls == ["do_prepare", "go_live"]
    assert fake_publisher.calls == ["dns"] and fake_publisher.contexts[0].cloud is True
    assert (env.active_slot, env.current_sha, env.status) == ("orange", SHA, "ready")
    slot = await db.get(DoSlot, (env.id, "orange"), populate_existing=True)
    assert (slot.sha, slot.image_tag, slot.last_check_ok) == (SHA, envfile.image_tag(SHA), True)
    render = next(r for r in fake_runner.requests if r.step == "render")
    text = base64.b64decode(render.extravars["env_file_b64"]).decode()
    assert "STACK_EXTERNAL_DATA=1\n" in text and "STACK_DROPLET_ID=4001\n" in text
    assert f"SS_SPACES_SECRET_KEY={SPACES_SECRET}\n" in text
    assert "SS_DATABASE_URL=postgresql+asyncpg://serversherpa:" in text
    smoke = next(r for r in fake_runner.requests if r.step == "slot_smoke")
    assert [h["hostname"] for h in smoke.extravars["public_hosts"]] == [
        f"{s}.uat9.serversherpa.com" for s in ("api", "portal", "kiosk", "wiki", "status")]
    assert smoke.extravars["block_metadata"] is True
    assert SPACES_SECRET not in next(s.log for s in steps if s.key == "render")


async def test_an_idle_slot_deploy_waits_for_activate(db, do_env, fake_runner,
                                                      fake_publisher, fake_provisioner):
    await _start(db, do_env, slot="orange", go_live=True)
    dep_id = await _start(db, do_env, slot="purple", go_live=False)
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded" and steps[-1].key == "slot_smoke"
    assert (env.active_slot, env.current_sha) == ("orange", SHA)
    purple = await db.get(DoSlot, (env.id, "purple"), populate_existing=True)
    assert purple.sha == SHA


async def test_a_failed_slot_smoke_test(db, do_env, fake_runner, fake_publisher,
                                        fake_provisioner):
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    dep_id = await _start(db, do_env, slot="orange", go_live=True)
    dep, steps, env = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 13)
    assert fake_provisioner.calls == ["do_prepare"]
    slot = await db.get(DoSlot, (env.id, "orange"), populate_existing=True)
    assert slot.last_check_ok is False and env.active_slot is None


async def test_delete_takes_a_snapshot_then_removes_everything(db, do_env, snapshots_dir,
                                                               fake_runner, fake_publisher,
                                                               fake_provisioner):
    await _start(db, do_env, slot="orange", go_live=True)
    env = await db.get(Environment, do_env.id, populate_existing=True)
    snap = await snapshots.begin_take(db, get_settings(), env, name="uat9-before-delete-x",
                                      notes="", actor_id=None)
    await db.commit()

    def fetched(request):
        from .bundle_helpers import make_bundle
        make_bundle(snapshots.fetched_path(get_settings(), snap.id).parent,
                    out=snapshots.fetched_path(get_settings(), snap.id))

    fake_runner.effects["export"] = fetched
    dep_id = await _start(db, env, mode="teardown", sha=env.current_sha, slot="orange",
                          snapshot_id=snap.id)
    dep, steps, _ = await _load(dep_id)
    assert [s.key for s in steps] == ["export", "undns", "do_destroy"]
    assert dep.status == "succeeded", [(s.key, s.log) for s in steps]
    export = next(r for r in fake_runner.requests if r.step == "export")
    assert export.extravars["external_data"] is True
    assert export.extravars["spaces_endpoint"] == "https://nyc3.digitaloceanspaces.com"
    assert (await db.scalar(select(Snapshot.status).where(Snapshot.id == snap.id))) == "ready"
    assert await db.get(Environment, do_env.id, populate_existing=True) is None
```

Check `tests/bundle_helpers.py` for `make_bundle`'s real signature first and adapt the `fetched` effect to write a valid bundle at `snapshots.fetched_path(...)`, the way `tests/test_deploy_pipeline_snapshots.py` fakes the export step (copy that test's effect).

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_pipeline_do.py tests/test_deploy_playbooks.py -k "plans or pipeline_do or digitalocean"`
Expected: FAIL.

- [ ] **Step 3: Plans**

In `sirdar/api/src/sirdar_api/deploy/steps.py`, add `"activate"` to `MODES`; update the module docstring with a paragraph:

```
A DigitalOcean environment (cloud=True) has plans of its own: 0 Prepare
DigitalOcean builds what is missing; the host steps run on the slot's
droplet; 12 DNS records point at the load balancer; 13 Smoke test (slot)
checks the slot through Caddy on the droplet; 14 Switch traffic moves the
load balancer to the slot (a first deploy, a one-slot environment, an
auto-activating one, or Activate). Delete is [11 Take snapshot], 17 Remove
DNS records, 18 Remove DigitalOcean resources.
```

and add:

```python
_CLOUD_BUILD = ("do_prepare", *_BUILD)
# (mode, restores or takes a snapshot) -> step keys of a DigitalOcean plan.
_CLOUD_PLANS: dict[tuple[str, bool], tuple[str, ...]] = {
    ("update", False): (*_CLOUD_BUILD, "dump", "up", "dns", "slot_smoke"),
    ("update", True): (*_CLOUD_BUILD, "dump", "restore", "up", "dns", "slot_smoke"),
    ("snapshot", False): ("preflight", "export"),
    ("publish", False): ("dns",),
    ("teardown", False): ("undns", "do_destroy"),
    ("teardown", True): ("export", "undns", "do_destroy"),
    ("activate", False): ("slot_smoke", "go_live"),
}


def _cloud_plan(mode: str, *, restore: bool, publish: bool, vm: bool, go_live: bool,
                snapshot: bool) -> tuple[str, ...]:
    if publish or vm:
        raise ValueError("a DigitalOcean plan has its own DNS step and no VM steps")
    key = (mode, snapshot if mode == "teardown" else restore)
    if key not in _CLOUD_PLANS:
        raise ValueError(f"no DigitalOcean plan for mode {mode!r}")
    keys = _CLOUD_PLANS[key]
    if go_live and mode != "activate":
        if mode != "update":
            raise ValueError(f"mode {mode!r} doesn't switch traffic")
        keys = (*keys, "go_live")
    return keys
```

and change `plan_for`:

```python
def plan_for(mode: str, *, restore: bool = False, publish: bool = False, vm: bool = False,
             cloud: bool = False, go_live: bool = False, snapshot: bool = False
             ) -> list[StepDef]:
    if cloud:
        keys = _cloud_plan(mode, restore=restore, publish=publish, vm=vm, go_live=go_live,
                           snapshot=snapshot)
        return [STEPS_BY_KEY[k] for k in keys]
    if mode == "activate":
        raise ValueError("only a DigitalOcean environment activates a slot")
    ...   # the existing body, unchanged
```

- [ ] **Step 4: The pipeline**

In `sirdar/api/src/sirdar_api/deploy/pipeline.py` (import `certs`, `do_envs`, `do_provision`, `smoke` from `sirdar_api.deploy`; `and_`, `or_` from `sqlalchemy`):

1. Docstring: add "A DigitalOcean environment's deployment (cloud) runs its own plans (steps.plan_for(cloud=True)); its steps 0, 14 and 18 go through the same provisioner seam."
2. After `restores`:

```python
def takes_snapshot(dep: Deployment) -> bool:
    """A DigitalOcean Delete that saves a snapshot first (step 11)."""
    return dep.mode == "teardown" and dep.cloud and dep.snapshot_id is not None


def plan_of(dep: Deployment) -> list[StepDef]:
    return plan_for(dep.mode, restore=restores(dep.mode, dep.snapshot_id), publish=dep.publish,
                    vm=dep.vm, cloud=dep.cloud, go_live=dep.go_live,
                    snapshot=takes_snapshot(dep))
```

3. `make_provisioner` passes `digitalocean=do_provision.DoProvisioner(settings=settings)` to `vmsteps.HostProvisioner`.
4. `create_deployment` gains `cloud: bool = False, slot: str | None = None, go_live: bool = False`; builds the plan with `plan_for(mode, restore=restores(mode, snapshot_id), publish=publish, vm=vm, cloud=cloud, go_live=go_live, snapshot=mode == "teardown" and cloud and snapshot_id is not None)`; the snapshot check becomes

```python
        export = STEPS_BY_KEY["export"].number
        taking = mode == "snapshot" or (mode == "teardown" and cloud and start_step <= export)
        wanted = "pending" if taking else "ready"
```

   and `Deployment(...)` gets `cloud=cloud, slot=slot, go_live=go_live`.
5. In `recover_orphans`, the `taken` query becomes `select(Deployment.snapshot_id).where(Deployment.id.in_(ids), or_(Deployment.mode == "snapshot", and_(Deployment.mode == "teardown", Deployment.cloud)), Deployment.snapshot_id.is_not(None))`.
6. In `_close`, select `Deployment.cloud` too, and replace the snapshot/environment block with:

```python
        if (mode == "snapshot" or (mode == "teardown" and cloud)) and snapshot_id is not None:
            taken = snapshot_id
            await s.execute(update(Snapshot).where(Snapshot.id == snapshot_id,
                                                   Snapshot.status == "pending")
                            .values(status="failed"))
        if mode not in ("snapshot", "publish"):
            # a snapshot job and a publish job leave the environment as it was
            await s.execute(update(Environment).where(Environment.id == env_id)
                            .values(status="failed", updated_at=now))
```

7. In `_snapshot_vars`, change `if dep.mode == "snapshot":` to `if dep.mode == "snapshot" or takes_snapshot(dep):`, and before `return step_vars, keys, extra` add:

```python
    if dep.cloud:
        row = await do_envs.get(db, env.id)
        external = {"external_data": True, "spaces_endpoint": spaces.endpoint(row.region),
                    "spaces_key_id": row.spaces_key_id or "", "spaces_region": row.region}
        for key in ("export", "restore"):
            if key in step_vars:
                step_vars[key] |= external
```

   (import `spaces`).
8. In `_prepare`:
   - `cfg = await vms.host_config(db, settings, env, slot=dep.slot if dep.cloud else None)`;
   - the no-address message:

```python
    if cfg is None and targets.is_built_target(env.target_id):
        raise PrepareError(
            "This environment's droplet has no address yet. Retry from step 0 (Prepare "
            "DigitalOcean)." if env.target_id == targets.DO_TARGET else
            "This environment's VM has no address yet. Retry from step 0 (Prepare VM).")
```

   - after `secrets = {**secrets, **snapshot_keys}`:

```python
    extra: dict[str, str] = {}
    if dep.cloud and dep.mode == "update":           # only Update renders .env
        try:
            extra, cloud_secrets = await do_envs.env_extra(db, settings, env, dep.slot, secrets)
        except do_envs.DoEnvError as e:
            missing = ", ".join(e.extra.get("missing") or [])
            raise PrepareError(f"This environment isn't fully built yet (missing: {missing}). "
                               "Retry from step 0 (Prepare DigitalOcean).") from None
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise PrepareError("Sirdar can't read this environment's DigitalOcean secrets "
                               "with the current SIRDAR_SECRETS_KEY.") from None
        extra_secrets = [*extra_secrets, *cloud_secrets]
```

   - `envfile.EnvConfig(..., extra=extra)`;
   - `common` adds:

```python
        "external_data": dep.cloud, "block_metadata": dep.cloud,
        "public_hosts": ([{"service": s, "hostname": f"{s}.{env.base_domain}",
                           "path": smoke.PATHS.get(s, "/")} for s in certs.PUBLIC_SERVICES]
                         if dep.cloud else []),
```

9. In `_run`'s step loop, change `if step.key == "provision":` to `if step.key in ("provision", "do_prepare"):`; record the slot smoke result on both outcomes:

```python
                    if step.key == "slot_smoke" and dep.slot:
                        await do_envs.set_slot(env.id, dep.slot,
                                               last_check_ok=result.status == "successful",
                                               last_check_at=_now())
```

   placed right after `result = ...` (before the failure branch). In the success branch after the loop:

```python
            elif dep.cloud and dep.mode in ("update", "activate"):
                await do_envs.after_success(db, env, dep)
            elif dep.mode not in KEEPS_STATUS:
                ...
```

- [ ] **Step 5: `after_success`**

Append to `sirdar/api/src/sirdar_api/deploy/do_envs.py` (import `envfile`):

```python
async def after_success(db: AsyncSession, env: Environment, dep) -> None:
    """A DigitalOcean Update or Activate that finished: the slot keeps the
    commit it now runs; if traffic moved, the slot is the active one and its
    commit is the environment's. The caller commits."""
    now = datetime.now(UTC)
    slot = await db.get(DoSlot, (env.id, dep.slot), populate_existing=True) if dep.slot else None
    if dep.mode == "update" and slot is not None:
        slot.sha, slot.image_tag, slot.updated_at = dep.sha, envfile.image_tag(dep.sha), now
    if dep.go_live:
        env.active_slot = dep.slot
        if slot is not None and slot.sha:
            env.current_sha, env.image_tag = slot.sha, slot.image_tag
    env.status, env.updated_at = "ready", now
```

- [ ] **Step 6: The dispatcher**

In `sirdar/api/src/sirdar_api/deploy/vmsteps.py`:

```python
VmContext = provision.VmContext | esxi_provision.EsxiVmContext | do_provision.DoContext


async def prepare(db, env, dep, settings) -> VmContext:
    if env.target_id == targets.DO_TARGET:
        return await do_provision.prepare(db, env, dep, settings)
    ...


class HostProvisioner:
    def __init__(self, *, proxmox: Provisioner, esxi: Provisioner | None = None,
                 digitalocean: Provisioner | None = None):
        ...
        self._do = digitalocean

    async def run(self, step, ctx, out):
        if isinstance(ctx, do_provision.DoContext):
            if self._do is None:
                raise VmPrepareError("DigitalOcean steps can't run here.")
            return await self._do.run(step, ctx, out)
        ...
```

(update the module docstring: "…or DigitalOcean's steps 0, 14 and 18 (do_provision.py)").

- [ ] **Step 7: Publishing at the load balancer**

In `sirdar/api/src/sirdar_api/deploy/publish.py` (import `do_envs` and `targets`):

1. `PublishContext` gains `cloud: bool = False` (after `services`).
2. `prepare`:

```python
async def prepare(db: AsyncSession, env: Environment, settings: Settings) -> PublishContext:
    cloud = env.target_id == targets.DO_TARGET
    try:
        cf = await integrations.load_cloudflare(db, settings)
        proxy = None if cloud else await integrations.load_npm(db, settings)
    except IntegrationError as e:
        raise PublishError(e.reason) from None
    return PublishContext(env_id=env.id, env_name=env.name, proxy_ip=env.proxy_ip,
                          services=await service_plans(db, env), cloud=cloud, cloudflare=cf,
                          npm=proxy)
```

3. `missing_integrations`: before `if teardown:`, add `if env.target_id == targets.DO_TARGET: wanted = {"cloudflare"}` (and skip the other branches) — DigitalOcean environments never use NPM.
4. `ensure_dns(ctx, out, *, transport, target: str | None = None)`: `public_ip = target or cfg.public_ip` at the top, and use `public_ip` everywhere `cfg.public_ip` appears inside it.
5. `HttpPublisher.run`'s `"dns"` case:

```python
                case "dns":
                    target = None
                    if ctx.cloud:
                        target = await do_envs.lb_ip(ctx.env_id)
                        if not target:
                            raise StepFailed("The load balancer has no address yet. Retry from "
                                             "step 0 (Prepare DigitalOcean).")
                    await ensure_dns(ctx, out, transport=transports["cloudflare"], target=target)
```

6. `inspect`: for a DigitalOcean environment use the load balancer's address and skip NPM:

```python
    cloud = env.target_id == targets.DO_TARGET
    lb = (await do_envs.get(db, env.id)).lb_ip if cloud else None
```

   then use `lb or cf.public_ip` wherever `cf.public_ip` is used for the DNS status and `out["cloudflare"]["public_ip"]`, and wrap the NPM section in `if not cloud:`.

- [ ] **Step 8: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_pipeline_do.py tests/test_deploy_playbooks.py tests/test_deploy_pipeline.py tests/test_deploy_pipeline_vm.py tests/test_deploy_pipeline_publish.py tests/test_deploy_pipeline_snapshots.py tests/test_deploy_publish.py tests/test_deploy_publish_steps.py tests/test_deploy_vm_steps.py`
Expected: all PASS.

- [ ] **Step 9: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/vmsteps.py src/sirdar_api/deploy/do_envs.py src/sirdar_api/deploy/publish.py tests/test_deploy_playbooks.py tests/test_deploy_pipeline_do.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/vmsteps.py sirdar/api/src/sirdar_api/deploy/do_envs.py sirdar/api/src/sirdar_api/deploy/publish.py sirdar/api/tests/test_deploy_playbooks.py sirdar/api/tests/test_deploy_pipeline_do.py
git commit -m "feat(sirdar): DigitalOcean plans in the pipeline — slots, DNS at the load balancer, Delete with a snapshot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Deployment routes on DigitalOcean

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`
- Create: `sirdar/api/tests/test_deploy_do_deployments_api.py`

**Interfaces:**
- Consumes: `pipeline.create_deployment(..., cloud, slot, go_live)`, `do_envs.target_slot`, `do_envs.goes_live`, `do_accounts.require`, `snapshots.begin_take`.
- Produces (routes; see "API produced for 7b"):
  - `DeploymentIn` gains `snapshot: bool | None` and `confirm_production: str | None`.
  - `_launch(..., cloud=False, slot=None, go_live=False)`, `_host_target(db, env, *, need_secrets=True, slot=None)`.
  - Error codes: 409 `not_supported_on_digitalocean`, 409 `do_account_not_configured {account}`, 409 `production_not_retiring`, 409 `production_slot_active`, 409 `do_not_ready`, 422 `confirm_production_mismatch`, 422 `snapshot_required`.
  - Audit `deploy.deployment_start` adds `slot` and `go_live` for DigitalOcean deployments.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_do_deployments_api.py`:

```python
"""Starting DigitalOcean deployments through the API: Update targets the
idle slot and goes live only when the rules say so; Reset, Restore backup
and Roll back aren't offered; Delete takes a snapshot first and keeps
production's rules. The pipeline runs with fakes."""

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, Deployment, DoAccount, DoSlot, Environment, Snapshot
from sirdar_api.deploy import do_envs, pipeline, vms

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import make_do_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA

URL = "/api/deploy/environments"


@pytest.fixture
async def ready(db, deploy_env, secrets_key, snapshots_dir, ssh_server, monkeypatch,
                fake_runner, fake_publisher, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)

    async def make(**kw) -> Environment:
        return await make_do_environment(db, **kw)
    return make


async def _deployed(db, env: Environment, active: str = "orange") -> None:
    """As if a first deploy went live on `active`."""
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        active_slot=active, current_sha=SHA, image_tag=SHA[:8], status="ready"))
    for i, slot in enumerate(env.slots):
        await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                              DoSlot.slot == slot)
                         .values(droplet_id=str(4001 + i), public_ip="127.0.0.1", sha=SHA))
    await db.commit()


async def _start(client, h, name, **body):
    resp = await client.post(f"{URL}/{name}/deployments", headers=h, json=body)
    if resp.status_code == 201:
        await pipeline.wait(resp.json()["id"])
    return resp


async def test_update_targets_the_idle_slot(client, db, ready):
    env = await ready()
    h = await auth_headers(client, db)
    first = await _start(client, h, "uat9", mode="update")
    assert first.status_code == 201, first.text
    assert (first.json()["cloud"], first.json()["slot"], first.json()["go_live"]) == (
        True, "orange", True)
    await _deployed(db, env)
    second = (await _start(client, h, "uat9", mode="update")).json()
    assert (second["slot"], second["go_live"]) == ("purple", False)
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.deployment_start").order_by(AuditLog.id))).all()
    assert (audit[-1]["slot"], audit[-1]["go_live"]) == ("purple", False)


async def test_a_one_slot_environment_always_goes_live(client, db, ready):
    env = await ready(slots=1)
    await _deployed(db, env)
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="update")).json()
    assert (body["slot"], body["go_live"]) == ("orange", True)


async def test_modes_that_would_touch_the_live_slot_are_refused(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    for body in ({"mode": "reset", "confirm_name": "uat9"},
                 {"mode": "restore_dump", "confirm_name": "uat9",
                  "backup": "20261001T010203Z.dump"}):
        resp = await _start(client, h, "uat9", **body)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (
            409, "not_supported_on_digitalocean")
    dep = Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                     status="failed", previous_sha=SHA, dump_path="/x/backups/a.dump",
                     cloud=True, slot="purple")
    db.add(dep)
    await db.commit()
    resp = await client.post(f"/api/deploy/deployments/{dep.id}/rollback", headers=h,
                             json={"confirm_name": "uat9"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (
        409, "not_supported_on_digitalocean")


async def test_an_account_without_a_token(client, db, ready):
    await ready()
    await db.execute(update(DoAccount).where(DoAccount.key == "development")
                     .values(token_enc=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "do_account_not_configured", "account": "development"})


async def test_delete_takes_a_snapshot_first(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert [s["key"] for s in body["steps"]] == ["export", "undns", "do_destroy"]
    assert body["snapshot"]["name"].startswith("uat9-before-delete-")
    assert body["slot"] == "orange"


async def test_delete_without_a_snapshot(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9",
                         snapshot=False)).json()
    assert [s["key"] for s in body["steps"]] == ["undns", "do_destroy"]
    assert (await db.scalars(select(Snapshot))).all() == []


async def test_delete_a_never_deployed_environment(client, db, ready):
    await ready()
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")).json()
    assert [s["key"] for s in body["steps"]] == ["undns", "do_destroy"]


async def test_production_delete_rules(client, db, ready):
    env = await ready(name="prod", type_="production", account="production")
    await _deployed(db, env, active="blue")
    h = await auth_headers(client, db)
    base = {"mode": "teardown", "confirm_name": "prod",
            "confirm_production": "delete production prod"}
    resp = await _start(client, h, "prod", **base)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "production_not_retiring")
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(retiring=True))
    await db.commit()
    resp = await _start(client, h, "prod", **base)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "production_slot_active")
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(active_slot=None))
    await db.commit()
    resp = await _start(client, h, "prod", **{**base, "confirm_production": "yes"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (
        422, "confirm_production_mismatch")
    resp = await _start(client, h, "prod", **{**base, "snapshot": False})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "snapshot_required")
    resp = await _start(client, h, "prod", **base)
    assert resp.status_code == 201, resp.text
    assert resp.json()["steps"][0]["key"] == "export"
```

Production with no active slot still has droplets with a commit; the snapshot is taken on the first slot that has one (`blue`).

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_deployments_api.py`
Expected: FAIL.

- [ ] **Step 3: The routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py` (import `do_accounts`, `do_envs`; `datetime`'s `UTC` and `datetime` are already imported or add them):

1. `DeploymentIn` gains:

```python
    # DigitalOcean Delete: save a snapshot first (default yes; production always).
    snapshot: bool | None = None
    # DigitalOcean production Delete: "delete production <name>", typed.
    confirm_production: str | None = Field(default=None, max_length=100)
```

2. `_host_target(db, env, *, need_secrets=True, slot=None)` calls `vms.host_config(db, settings, env, slot=slot)` and returns None (not 400) for any built target: change `targets.is_vm_target` there to `targets.is_built_target`.
3. `_launch` gains `cloud: bool = False, slot: str | None = None, go_live: bool = False`, passes them to `pipeline.create_deployment`, and adds `if cloud: changes |= {"slot": slot, "go_live": go_live}` to the audit.
4. `_start_publish` passes `cloud=env.target_id == targets.DO_TARGET` to `_launch`.
5. Add:

```python
def _on_do(env: Environment) -> bool:
    return env.target_id == targets.DO_TARGET


def _not_on_do() -> HTTPException:
    return HTTPException(status_code=409, detail={"code": "not_supported_on_digitalocean"})


async def _require_account(db, env: Environment) -> None:
    row = await do_envs.get(db, env.id)
    try:
        await do_accounts.require(db, get_settings(), row.account_key)
    except integrations.IntegrationError as e:
        status = 409 if e.code in ("do_account_not_configured", "integration_unreadable") else 400
        raise HTTPException(status_code=status, detail={"code": e.code, **e.extra}) from None


async def _start_do_update(db, env: Environment, body: DeploymentIn, request: Request,
                           actor: AuthContext) -> dict:
    """Update on DigitalOcean: to the idle slot (the only one of a one-slot
    environment); it goes live when do_envs.goes_live says so. Step 0
    resolves the ref on the slot's droplet."""
    if not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    await _require_account(db, env)
    await _require_integrations(db, env)
    ref = body.git_ref or env.git_ref
    if not gitref.valid_ref(ref):
        raise HTTPException(status_code=422, detail={"code": "ref_invalid"})
    snapshot = None
    if env.current_sha is None and env.seed_snapshot_id is not None:
        try:
            snapshot = await snapshots.ready_snapshot(db, env.seed_snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    slot = do_envs.target_slot(env)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="update", git_ref=ref,
                         sha=ref.lower() if gitref.is_full_sha(ref) else "", snapshot=snapshot,
                         cloud=True, slot=slot, go_live=do_envs.goes_live(env, slot))


async def _snapshot_slot(db, env: Environment) -> str | None:
    """Where a DigitalOcean snapshot is taken: the active slot, else the first
    slot whose droplet runs a commit."""
    if env.active_slot:
        return env.active_slot
    slots = await do_envs.slots_of(db, env.id)
    return next((s for s in env.slots if slots[s].public_ip and slots[s].sha), None)


async def _start_do_teardown(db, env: Environment, body: DeploymentIn, request: Request,
                             actor: AuthContext) -> dict:
    """Delete on DigitalOcean: a snapshot first (unless turned off; never for
    production), then DNS records, then everything Sirdar recorded.
    Production must be retiring, with no active slot, and the phrase typed."""
    settings = get_settings()
    if not vault.is_configured(settings):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    if env.type == "production":
        if not env.retiring:
            raise HTTPException(status_code=409, detail={"code": "production_not_retiring"})
        if env.active_slot is not None:
            raise HTTPException(status_code=409, detail={"code": "production_slot_active"})
        if body.confirm_production != f"delete production {env.name}":
            raise HTTPException(status_code=422, detail={"code": "confirm_production_mismatch"})
        if body.snapshot is False:
            raise HTTPException(status_code=422, detail={"code": "snapshot_required"})
    await _require_account(db, env)
    await _require_integrations(db, env, teardown=True)
    slot = await _snapshot_slot(db, env)
    snap = None
    if body.snapshot is not False and env.current_sha is not None:
        cfg = await _host_target(db, env, slot=slot) if slot else None
        if cfg is None:
            raise HTTPException(status_code=409, detail={"code": "do_not_ready"})
        await _pinned(db, cfg)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        try:
            snap = await snapshots.begin_take(
                db, settings, env, name=f"{env.name}-before-delete-{stamp}",
                notes="Taken by Sirdar before Delete environment.",
                actor_id=actor.user.person_id)
        except snapshots.SnapshotError as e:
            await db.rollback()
            raise _snapshot_http(e) from None
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="teardown", git_ref=env.git_ref, sha=env.current_sha or "",
                         snapshot=snap, cloud=True, slot=slot)
```

6. In `start_deployment`, right after `env = await _environment(db, name)`:

```python
    if _on_do(env) and body.mode in ("reset", "restore_dump", "vm_restore"):
        raise _not_on_do()
    if (body.snapshot is not None or body.confirm_production is not None) and not (
            _on_do(env) and body.mode == "teardown"):
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
```

   and after the `is_deploying` check / the publish and vm_restore branches:

```python
    if _on_do(env):
        if body.mode == "teardown":
            return await _start_do_teardown(db, env, body, request, actor)
        return await _start_do_update(db, env, body, request, actor)
```

7. `rollback_deployment`: right after loading `env`, `if _on_do(env): raise _not_on_do()`.
8. `retry_deployment`:
   - compute `taking = dep.mode == "teardown" and dep.cloud and await _has_step(db, dep.id, "export")` and build the plan with `plan_for(dep.mode, restore=restoring, publish=dep.publish, vm=dep.vm, cloud=dep.cloud, go_live=dep.go_live, snapshot=taking)`;
   - for a cloud teardown: if `from_step <= STEPS_BY_KEY["export"].number`, start a new pending snapshot named like `_start_do_teardown` does (the failed one stays failed); otherwise pass the ready snapshot when `dep.snapshot_id` still points at one, else none (the plan then has no step 11; `from_step` must still be 17 or 18);
   - `cfg = await _host_target(db, env, slot=dep.slot if dep.cloud else None)`, and call `_pinned` only `if not dep.vm and not dep.cloud`;
   - pass `cloud=dep.cloud, slot=dep.slot, go_live=dep.go_live` to `_launch`.
9. `take_snapshot`: pass `cloud=_on_do(env), slot=env.active_slot if _on_do(env) else None` to `_launch` (the default `_host_target` slot is the active one).
10. `list_backups`: `need_secrets=_on_vm(env) or _on_do(env)`.

- [ ] **Step 4: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q tests/test_deploy_do_deployments_api.py tests/test_deploy_deployments_api.py tests/test_deploy_restore_api.py tests/test_deploy_snapshots_api.py tests/test_deploy_vm_api.py tests/test_deploy_esxi_vm_api.py tests/test_deploy_publish_api.py`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/api/routes/deploy.py tests/test_deploy_do_deployments_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_do_deployments_api.py
git commit -m "feat(sirdar): DigitalOcean deployments — slots, Delete with a snapshot, production rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: README, the full suites, lint (controller)

**Files:**
- Modify: `sirdar/README.md` (a "DigitalOcean environments" section under "Deploy pipeline (environments)")

- [ ] **Step 1: README**

Add a section that says, in this order:

1. What gets built per environment (VPC `ss-<env>`, a droplet per slot `ss-<env>-<slot>`, `ss-<env>-db`, the bucket and its key, `ss-<env>-lb`, the certificate, `ss-<env>-fw`, Cloudflare A records at the load balancer) and the tags (`sirdar`, `sirdar-env-<id>`, `sirdar-env:<name>`, `sirdar-slot:<slot>`).
2. The two accounts in Settings › Integrations › DigitalOcean, and **how to make the renewal token** in the control panel: API › Generate New Token › Custom Scopes: `certificate` (create, read, delete) and `load_balancer` (read, update); no expiry or a long one; one per account.
3. Defaults (V2 production sizes) and the standby option; ACME staging for test environments.
4. Blue/Green: Update deploys to the idle slot; the first deploy and one-slot environments go live by themselves; **migrations must be expand/contract** (the old slot still runs against the shared database until Activate).
5. Delete: snapshot first; production needs "retiring", no active slot and the typed phrase.
6. What is out of scope (V2 production, Reset on DigitalOcean, real SMTP).

- [ ] **Step 2: The full Sirdar suite (about 11 minutes)**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api
SIRDAR_TEST_DB=sirdar_test_phase7a .venv/bin/pytest -q
```

Expected: all pass (Docker-dependent tests skip without Docker).

- [ ] **Step 3: Docker checks (where Docker exists)**

```bash
SIRDAR_TEST_DB=sirdar_test_phase7a SS_STACK_E2E=1 .venv/bin/pytest -q tests/test_deploy_stack_external.py
```

- [ ] **Step 4: Lint every changed Python file**

```bash
git diff --name-only main -- sirdar/api | grep '\.py$' | sed 's|^sirdar/api/||' | xargs .venv/bin/ruff check --select E,F,W --ignore F811
bash -n ../../deploy/stack/ss-stack
```

Expected: `All checks passed!`.

- [ ] **Step 5: Drop the test database and commit the README**

```bash
docker exec serversherpa-dev-sirdar-db-1 psql -U sirdar -d postgres -c 'DROP DATABASE IF EXISTS sirdar_test_phase7a' -c 'DROP DATABASE IF EXISTS sirdar_test_phase7a_source'
cd ../.. && git add sirdar/README.md
git commit -m "docs(sirdar): DigitalOcean environments in the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Self-review notes (for the controller)

- Spec coverage: accounts (§8) → Tasks 1, 3; resources and tags (§1) → 6, 9; step 0 order and idempotency (§2) → 9; external stack, Caddy, `.env` (§3) → 7, 8; seeding (§5) → 8, 11, 12; Delete (§6) → 10, 11, 12; security (§9) → every task's leak checks; fakes (§10) → 2, 4, 5. Blue/Green Activate, auto-activate, add-a-slot, the cert-worker, Sirdar's periodic renewal and the dashboard are 7b.
- Names used across tasks: `do_envs.target_slot/goes_live/env_extra/after_success/host_config/record/forget/set_do/set_slot/lb_ip`, `do_provision.prepare/DoContext/DoProvisioner/load_records/lb_update_body/https_certificate`, `plan_for(..., cloud, go_live, snapshot)`, `create_deployment(..., cloud, slot, go_live)`.
- Known judgment calls to watch in review: the database role is created by SQL (not the API) so PG 16 ownership works; `ssl=require` lives in `SS_DATABASE_SSL`; the slot smoke test runs on the droplet; Sirdar renews only inside 14 days (the 15–30 day window is the cert-worker's).
