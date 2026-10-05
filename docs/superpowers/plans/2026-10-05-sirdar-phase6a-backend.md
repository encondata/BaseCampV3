# Sirdar deploy phase 6a (VMware ESXi targets: backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Sirdar build an environment's host on Jimmy's standalone, licensed ESXi 7 host, with the same safety rules as phase 5's Proxmox targets:

- an `esxi` integration (password, pinned TLS certificate, Test);
- step 0 builds an Ubuntu 24.04 VM from a seed disk with cloud-init through guestinfo, and pins an SSH host key Sirdar generated;
- VM snapshots, with Restore VM snapshot;
- Delete environment destroys only the VM Sirdar created.

**Architecture:**

- `deploy/esxi.py` is the vSphere client (pyVmomi), behind one seam: the `esxi.connect(cfg)` async context manager, which yields an `EsxiApi`.
- `deploy/cloudinit.py` renders guestinfo metadata and user-data.
- `deploy/esxi_provision.py` runs the existing `"vm"` steps (0 Prepare VM, 0 Restore VM snapshot, 15 Destroy VM) for ESXi.
- What both hypervisors share moves out of `provision.py` into `deploy/vmcommon.py`.
- `deploy/vmsteps.py` picks the provisioner by the environment's target.
- `esxi_vms` (migration 0008) is the ownership record.
- `vms.py`, `environments.py`, the routes and `serialize.py` become VM-host-neutral.

**Tech Stack:** FastAPI, SQLAlchemy 2 async + asyncpg, Alembic (raw SQL), pyVmomi 8.0.3.0.1 (+ six 1.17.0, hash-pinned), asyncssh, `cryptography`, PyYAML (already present through ansible-core), pytest on real Postgres.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` Section 6. The binding decisions are in `docs/superpowers/plans/2026-10-05-sirdar-phase6-context.md`. Read it first. The UI is plan 6b (`2026-10-05-sirdar-phase6b-ui.md`), which uses exactly the shapes under "API produced for 6b".

## Global Constraints

**Where and how to work**

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it.
- `sirdar` is both a branch and a folder: use `--` in `git diff` and `git log` (`git log -- sirdar/`).
- Other agents may commit in this worktree at the same time (web layout fixes):
  - `git add` only the files your task names. Never `git add -A`, never `git stash`.
  - If `.git/index.lock` is busy, wait a few seconds and retry.
  - If a file this plan edits has changed since it was written, apply the same edit to the new text and keep their change.
- Commit messages end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Code style and lint**

- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"` (never add `@pytest.mark.asyncio`).
- New and changed files must pass `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` and print `All checks passed!`.

**Migration number**

- The migration is **0008** (`revision = "0008"`, `down_revision = "0007"`).
- Task 1 checks every worktree and the dev DB before writing it.

**Secrets and errors**

- The ESXi password, environment secrets, the VM's private SSH key and the VM's private host key must never appear in any of these:
  - an API response or a log line;
  - an audit `changes` or an exception message;
  - a `repr()` or a stored step log;
  - argv or the environment of any process.
- The private host key goes to ESXi only inside the base64 `guestinfo.userdata` of the VM it belongs to. It is scrubbed from the VM, and from `esxi_vms`, once SSH answers with it.
- Errors are our own copy. Never use pyVmomi's text, ESXi's text or a fault's `msg`. A fault's class name is allowed.

**Tests never touch real hosts**

- Every ESXi call goes through `esxi.connect(cfg)`. Tests replace it with `FakeEsxi.connect` (fixture `esxi_fake`).
- The autouse `no_real_hosts` guard fails any test that reaches `esxi._smart_connect`, the only function that opens a real ESXi session.
- Tests never reach a real ESXi, Proxmox, Terraform, TLS server (other than 127.0.0.1) or port.

**Ownership**

- Sirdar manages only VMs it created. The `esxi_vms` row is the ownership record.
- Before any change, step 0, restore and destroy check three things together: the `instance_uuid`, the name `ss-<env>`, and the extraConfig `sirdar.environment == <env id>`.
- No route attaches an existing VM.

**API conventions**

- Errors: `HTTPException(status, detail={"code": "snake_code", ...})`.
- Permissions reuse `deploy`:

  | Level | Allows |
  |---|---|
  | `view` | the VM and its snapshots |
  | `add` | create an ESXi environment, Update |
  | `change` | ESXi credentials, PATCH sizing, Reset, Restore backup, Roll back, Restore VM snapshot, Delete |

- Gated modes need `confirm_name`.
- Every successful mutation writes one audit row named `deploy.<verb>`.

**Copy and housekeeping**

- American English in all copy, comments and docs.
- Never commit `sirdar/.env`. No `npm install` in this worktree.

## Working environment

- Sirdar's dev database must be running. From the main checkout: `cd /Users/jrh1812/Developer/BaseCampV3 && docker compose -f docker-compose.dev.yml up -d sirdar-db` (Postgres on 127.0.0.1:5434).
- Every Sirdar test command runs from `sirdar/api` in the worktree:
  1. `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api`
  2. `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/<file>`
- The conftest creates that database; Task 10 drops it. Never point tests at the dev `sirdar` database. Run test files in the foreground.
- pyVmomi must be in the worktree's venv before Task 2's tests run. Task 2 installs it with hashes. Pip installs into `sirdar/api/.venv` are allowed; `npm install` is not.

## API produced for 6b

All under `/api/deploy`. Times are ISO 8601 strings.

**Integrations**

- `Integrations` gains `esxi`:

  ```
  {configured, url, user, datastore, network, resource_pool: str|null, source_vm,
   dns_servers: string[], tls_fingerprint, password_set, updated_at, updated_by_name}
  ```

  Unset values are null; `dns_servers` is `[]` when unset.
- `PUT /integrations/esxi` (change). Body:

  ```
  {url, user, datastore, network, resource_pool?: str|null, source_vm,
   dns_servers?: string[], tls_fingerprint?: str|null, password?: str}
  ```

  Returns `Integrations`. Omitting `password` keeps the stored one, which is allowed only for the same `url` and `user`. Errors:
  - 409 `tls_untrusted {fingerprint, subject, issuer, not_after, names}`;
  - 409 `tls_mismatch {expected, actual}`;
  - 502 `connect_failed {reason}`;
  - 422 `esxi_url_invalid`, `esxi_user_invalid`, `datastore_invalid`, `network_invalid`, `resource_pool_invalid`, `source_vm_invalid`, `dns_servers_invalid`, `password_invalid`, `tls_fingerprint_invalid`, `secret_required {reason?}`;
  - 400 `secrets_key_missing`.
- `POST /integrations/esxi/test` (change). The optional body is the PUT body. Returns:

  ```
  {ok, target: "esxi", checks: [{label, status, value}],
   facts: {url, version, build, fingerprint, user}}
  ```

  The check labels, in order: ESXi, License, Datastore, Network, Resource pool, Seed VM. Errors are the PUT's, plus 409 `integration_not_configured {kinds: ["esxi"]}` and 409 `integration_unreadable`.
- `DELETE /integrations/esxi` (change) → 204. While an environment uses it, 409 `integration_in_use {environments}`.

**Targets and defaults**

- `GET /targets` adds `{id: "esxi", label: "VMware ESXi", kind: "esxi", available: true, configured: true}` after Proxmox, once ESXi is saved.
- `GET /environment-defaults` is unchanged; its `vm` block is shared by both hosts.

**Environments**

- `POST /environments` mode `new` accepts `target: "esxi"` with the same `vm` body as Proxmox. Errors:
  - 409 `integration_not_configured {kinds: ["esxi"]}`;
  - 409 `ip_in_use`;
  - the `vm_*` 422s;
  - mode `adopt` with `target: "esxi"` → 422 `adopt_not_allowed`.
- `PATCH /environments/{name}`:
  - `vm` works for ESXi environments.
  - `target_kind_locked` also blocks proxmox ⇄ esxi.
  - `host_ip_managed` applies to both.
- `Environment.target_kind` is `"ssh" | "proxmox" | "esxi"`. `Environment.vm` is:

  ```
  {kind: "proxmox"|"esxi", stage: "none"|"partial"|"built", name,
   host, node: str|null, vmid: int|null, moref: str|null,
   cores, memory_mb, disk_gb, ip_mode, ip_cidr, gateway, ip, keep_snapshots, created}
  ```

  - `host` is the Proxmox node or the ESXi host.
  - `node` and `vmid` are set only for Proxmox; `moref` only for ESXi.
  - `stage` is `none` before step 0 started a VM, `partial` while a VM exists but isn't finished, and `built` after that.

**Deployments and VM snapshots**

- Deployments on ESXi environments behave exactly like Proxmox ones:
  - `take_vm_snapshot`, `vm_restore`, retry from step 0, Roll back with `take_vm_snapshot`;
  - steps 0 `provision` / 0 `vm_restore` / 15 `destroy`;
  - `sha` is `""` until step 0 resolves a branch.
- `GET /environments/{name}/vm-snapshots` works for both hosts:

  ```
  {snapshots: [{name, taken_at, sha, deployment_id, description, restorable, reason}]}
  ```

  Errors: 409 `not_vm_environment` (was `not_proxmox`), 409 `integration_not_configured {kinds: [target]}`, 502 `connect_failed {reason}`.
- `POST …/deployments` with `mode: "vm_restore"` on an SSH environment → 409 `not_vm_environment` (was `not_proxmox`).

## File map

| File | Responsibility |
|---|---|
| `sirdar/api/migrations/versions/0008_esxi.py` | `esxi` integration kind; `esxi_vms` |
| `sirdar/api/src/sirdar_api/db/models.py` | `EsxiVm` |
| `sirdar/api/requirements-esxi.txt`, `sirdar/api/pyproject.toml`, `sirdar/Dockerfile` | pyVmomi 8.0.3.0.1 + six 1.17.0, hash-pinned in the image |
| `sirdar/api/src/sirdar_api/deploy/tls_pin.py` | `pinned_context(…, check_hostname=)` |
| `sirdar/api/src/sirdar_api/deploy/integrations.py` | The `esxi` kind: fields, `EsxiConfig`, `in_use` for both VM hosts |
| `sirdar/api/src/sirdar_api/deploy/esxi.py` | pyVmomi client, pure helpers, connection test |
| `sirdar/api/src/sirdar_api/api/routes/integrations.py` | PUT / test / DELETE for `esxi`, shared certificate trust flow |
| `sirdar/api/src/sirdar_api/deploy/cloudinit.py` | guestinfo metadata and user-data |
| `sirdar/api/src/sirdar_api/deploy/targets.py` | `ESXI_TARGET`, `VM_TARGETS`, `is_vm_target`, the ESXi target entry |
| `sirdar/api/src/sirdar_api/deploy/vms.py` | Kind-aware `get_for`, `host_config`, `address_in_use`, `public`, `stage`; `add_esxi`, `new_host_keypair` |
| `sirdar/api/src/sirdar_api/deploy/environments.py`, `serialize.py` | ESXi create, adopt refusal, PATCH, `target_kind` |
| `sirdar/api/src/sirdar_api/deploy/vmcommon.py` | Shared VM-step machinery (moved out of `provision.py`) |
| `sirdar/api/src/sirdar_api/deploy/provision.py` | Proxmox steps, now on `vmcommon` |
| `sirdar/api/src/sirdar_api/deploy/vmsteps.py` | `prepare` and `HostProvisioner` dispatch by target |
| `sirdar/api/src/sirdar_api/deploy/esxi_provision.py` | ESXi steps 0 / 0 / 15 |
| `sirdar/api/src/sirdar_api/deploy/pipeline.py` | Uses `vmsteps`; VM-target checks |
| `sirdar/api/src/sirdar_api/api/routes/deploy.py` | VM-host-neutral routes, the ESXi VM snapshot list, targets |
| `sirdar/api/tests/…` | `fake_esxi.py`, `esxi_helpers.py`; tests for each module; conftest guard and tables |
| `sirdar/README.md` | ESXi targets: the seed VM, the user, the license, the certificate |

---

### Task 1: Migration 0008 and the `EsxiVm` model

**Files:**
- Create: `sirdar/api/migrations/versions/0008_esxi.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py`
- Modify: `sirdar/api/tests/conftest.py` (`SIRDAR_TABLES`)
- Test: `sirdar/api/tests/test_deploy_models.py`

**Interfaces:**
- Produces (tables):
  - `integrations.kind` may be `esxi`.
  - `esxi_vms` has these columns:
    - `environment_id`: PK, FK ON DELETE CASCADE.
    - `name`: UNIQUE.
    - Frozen at create: `host`, `datastore`, `network`, `resource_pool`, `source_vm`, `dns_servers text[]`.
    - Set by ESXi: `moref`, `instance_uuid` (UNIQUE), `vm_path`.
    - Sizing and network: `cores`, `memory_mb`, `disk_gb`, `ip_mode`, `ip_cidr`, `gateway`, `ip`.
    - Keys: `ssh_public_key`, `ssh_private_key_enc`, `host_key_public`, `host_key_private_enc` (nullable).
    - `keep_snapshots`, `created`, `created_at`, `updated_at`.
  - `moref` and `instance_uuid` are both set or both null. `created` needs `instance_uuid`.
- Produces (ORM): `class EsxiVm(Base)` with those columns (`dns_servers: list[str]`).

- [ ] **Step 1: Check the migration number**

Run:

```bash
ls /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/*/sirdar/api/migrations/versions/ /Users/jrh1812/Developer/BaseCampV3/sirdar/api/migrations/versions/ 2>/dev/null | grep -E '^00[0-9]{2}_' | sort | tail -3
for b in $(git -C /Users/jrh1812/Developer/BaseCampV3 for-each-ref --format='%(refname:short)' refs/heads); do git -C /Users/jrh1812/Developer/BaseCampV3 ls-tree --name-only "$b" sirdar/api/migrations/versions/ 2>/dev/null | grep -E '/0008_' | sed "s|^|$b: |"; done
docker exec $(docker ps -qf name=sirdar-db | head -1) psql -U sirdar -d sirdar -tAc 'select version_num from alembic_version'
```

Expected:
- the newest file is `0007_proxmox.py`;
- no branch prints a `0008_` file;
- the DB prints `0007` or lower (on 2026-10-05 it was `0004`).

If any of these is not true, stop and report.

- [ ] **Step 2: Write the failing tests**

In `sirdar/api/tests/test_deploy_models.py`, add `EsxiVm` to the `from sirdar_api.db.models import (...)` list (alphabetical, after `Environment…` entries, before `Integration`). Append:

```python
def _esxi_vm(env_id, **over) -> EsxiVm:
    kw = dict(environment_id=env_id, name="ss-uat3", host="10.10.48.10", datastore="datastore1",
              network="VM Network", source_vm="sirdar-ubuntu-2404-seed", cores=4,
              memory_mb=8192, disk_gb=64, ip_mode="static", ip_cidr="10.10.48.71/24",
              gateway="10.10.48.1", ssh_public_key="ssh-ed25519 AAAAC3Nz test",
              ssh_private_key_enc=b"enc", host_key_public="ssh-ed25519 AAAAC3Nz host",
              host_key_private_enc=b"henc")
    kw.update(over)
    return EsxiVm(**kw)


async def test_esxi_vms(db):
    env = await _env(db, name="uat3")
    db.add(_esxi_vm(env.id))
    db.add(Integration(kind="esxi", config={"url": "https://10.10.48.10"}, secret_enc=b"x"))
    await db.commit()
    vm = await db.get(EsxiVm, env.id)
    assert (vm.moref, vm.instance_uuid, vm.vm_path, vm.ip, vm.created, vm.keep_snapshots,
            vm.resource_pool, vm.dns_servers) == (None, None, None, None, False, 3, None, [])
    vm.moref, vm.instance_uuid = "12", "52b1c3d4-0000-0000-0000-000000000001"
    vm.vm_path, vm.created = "[datastore1] ss-uat3/ss-uat3.vmx", True
    vm.dns_servers, vm.host_key_private_enc = ["10.10.48.1"], None
    await db.commit()
    other = await _env(db, name="uat4")
    for bad in (_esxi_vm(other.id),                                    # the name is taken
                _esxi_vm(other.id, name="ss-uat4", moref="13"),        # uuid without moref
                _esxi_vm(other.id, name="ss-uat4", created=True),      # created without a VM
                _esxi_vm(other.id, name="ss-uat4", moref="14",
                         instance_uuid="52b1c3d4-0000-0000-0000-000000000001"),  # uuid taken
                _esxi_vm(other.id, name="ss-uat4", ip_mode="dhcp"),    # dhcp with an address
                _esxi_vm(other.id, name="ss-uat4", cores=0),
                _esxi_vm(other.id, name="ss-uat4", disk_gb=10),
                _esxi_vm(other.id, name="ss-uat4", keep_snapshots=11),
                _esxi_vm(other.id, name="ss-uat4", host_key_public=None)):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    db.add(_esxi_vm(other.id, name="ss-uat4", ip_mode="dhcp", ip_cidr=None, gateway=None))
    await db.commit()
    await db.delete(await db.get(Environment, other.id))
    await db.commit()
    assert await db.get(EsxiVm, other.id) is None                       # cascades


async def test_migration_0008_downgrade_refuses_while_esxi_vms_are_managed():
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
            "VALUES ('vm3', 'dev', 'esxi', 'vm3.example.com', '10.0.0.2') RETURNING id"
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO esxi_vms (environment_id, name, host, datastore, network, source_vm, "
            "cores, memory_mb, disk_gb, ip_mode, ssh_public_key, ssh_private_key_enc, "
            "host_key_public) VALUES (%s, 'ss-vm3', '10.10.48.10', 'datastore1', "
            "'VM Network', 'seed', 4, 8192, 64, 'dhcp', 'ssh-ed25519 x', 'k', "
            "'ssh-ed25519 h')", (env_id,))
    with pytest.raises(subprocess.CalledProcessError) as err:
        _alembic("downgrade", "0007")
    assert b"while Sirdar manages ESXi VMs" in err.value.stderr
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT count(*) FROM esxi_vms").fetchone()[0] == 1
        conn.execute("DELETE FROM esxi_vms")
        conn.execute("INSERT INTO integrations (kind, config) VALUES ('esxi', '{}')")
    _alembic("downgrade", "0007")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert not conn.execute("SELECT to_regclass('esxi_vms') IS NOT NULL").fetchone()[0]
            assert conn.execute("SELECT count(*) FROM integrations WHERE kind = 'esxi'"
                                ).fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM environments WHERE id = %s",
                                (env_id,)).fetchone()[0] == 1
            with pytest.raises(psycopg.errors.CheckViolation):
                conn.execute("INSERT INTO integrations (kind, config) VALUES ('esxi', '{}')")
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT to_regclass('esxi_vms') IS NOT NULL").fetchone()[0]
```

The existing test that adds `Integration(kind="vsphere")` as an invalid kind stays as it is: `vsphere` is still invalid.

- [ ] **Step 3: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_models.py -k "esxi or 0008"`
Expected: FAIL. Collection fails with `ImportError: cannot import name 'EsxiVm'`.

- [ ] **Step 4: Write the migration**

Create `sirdar/api/migrations/versions/0008_esxi.py`:

```python
"""Deploy phase 6: VMware ESXi targets. The esxi integration kind and the
VMs Sirdar builds on a standalone ESXi host (the ownership record).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-05
"""
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox', 'esxi'));
        -- One row per ESXi environment: Sirdar manages only the VM whose
        -- instance UUID, name and sirdar.environment marker match this row.
        CREATE TABLE esxi_vms (
          environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
          name text NOT NULL UNIQUE,
          -- Frozen from the integration when the environment is created.
          host text NOT NULL,
          datastore text NOT NULL,
          network text NOT NULL,
          resource_pool text,
          source_vm text NOT NULL,
          dns_servers text[] NOT NULL DEFAULT '{}',
          -- Set by step 0 the moment ESXi creates the VM.
          moref text,
          instance_uuid text UNIQUE,
          vm_path text,
          cores integer NOT NULL CHECK (cores BETWEEN 1 AND 64),
          memory_mb integer NOT NULL CHECK (memory_mb BETWEEN 2048 AND 262144),
          disk_gb integer NOT NULL CHECK (disk_gb BETWEEN 20 AND 4096),
          ip_mode text NOT NULL CHECK (ip_mode IN ('static', 'dhcp')),
          ip_cidr text,
          gateway text,
          ip text,
          ssh_public_key text NOT NULL,
          ssh_private_key_enc bytea NOT NULL,
          -- The VM's SSH host key, generated by Sirdar: the private half only
          -- until step 0 has delivered it and scrubbed the user-data.
          host_key_public text NOT NULL,
          host_key_private_enc bytea,
          keep_snapshots integer NOT NULL DEFAULT 3 CHECK (keep_snapshots BETWEEN 1 AND 10),
          created boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK ((ip_mode = 'static') = (ip_cidr IS NOT NULL AND gateway IS NOT NULL)),
          CHECK ((moref IS NULL) = (instance_uuid IS NULL)),
          CHECK (NOT created OR instance_uuid IS NOT NULL)
        );
    """)


def downgrade() -> None:
    # Environments on target 'esxi' stay: deleting them would orphan their VMs.
    # It refuses while esxi_vms (the ownership record and each VM's keys) has rows.
    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM esxi_vms) THEN
            RAISE EXCEPTION 'Can''t downgrade below 0008 while Sirdar manages ESXi VMs; '
              'delete those environments first.';
          END IF;
        END
        $$;
        DELETE FROM integrations WHERE kind = 'esxi';
        DROP TABLE esxi_vms;
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox'));
    """)
```

- [ ] **Step 5: Add the model**

In `sirdar/api/src/sirdar_api/db/models.py`:
- change the docstring's "(migrations 0001–0007)" to "(migrations 0001–0008)";
- add `ARRAY` to the dialect import: `from sqlalchemy.dialects.postgresql import ARRAY, BYTEA, CITEXT, INET, JSONB, TIMESTAMP, UUID`.

Then append after `class ProxmoxVm`:

```python
class EsxiVm(Base):
    """The VM Sirdar builds on a standalone ESXi host for one environment
    (migration 0008), and the record that it is Sirdar's: Sirdar changes or
    destroys only the VM whose instance UUID, name and `sirdar.environment`
    extraConfig marker match this row. `moref`, `instance_uuid` and
    `vm_path` are written the moment ESXi creates it; `created` turns true
    once its disk is attached and it has booted. The host key's private half
    is kept only until step 0 has delivered it. Private keys are
    Fernet-encrypted with SIRDAR_SECRETS_KEY and never returned."""

    __tablename__ = "esxi_vms"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)
    name: Mapped[str]
    host: Mapped[str]
    datastore: Mapped[str]
    network: Mapped[str]
    resource_pool: Mapped[str | None]
    source_vm: Mapped[str]
    dns_servers: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'"))
    moref: Mapped[str | None]
    instance_uuid: Mapped[str | None]
    vm_path: Mapped[str | None]
    cores: Mapped[int] = mapped_column(Integer)
    memory_mb: Mapped[int] = mapped_column(Integer)
    disk_gb: Mapped[int] = mapped_column(Integer)
    ip_mode: Mapped[str]                              # static | dhcp
    ip_cidr: Mapped[str | None]
    gateway: Mapped[str | None]
    ip: Mapped[str | None]
    ssh_public_key: Mapped[str]
    ssh_private_key_enc: Mapped[bytes] = mapped_column(BYTEA)
    host_key_public: Mapped[str]
    host_key_private_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    keep_snapshots: Mapped[int] = mapped_column(Integer, server_default=text("3"))
    created: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

In `sirdar/api/tests/conftest.py`, append `, esxi_vms` to `SIRDAR_TABLES` (after `proxmox_vms`).

- [ ] **Step 6: Run the tests and the existing model suite**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_models.py`
Expected: all pass, including `test_migration_0007_round_trip` (it downgrades through 0008).

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 migrations/versions/0008_esxi.py src/sirdar_api/db/models.py tests/test_deploy_models.py tests/conftest.py
cd ../.. && git add sirdar/api/migrations/versions/0008_esxi.py sirdar/api/src/sirdar_api/db/models.py sirdar/api/tests/test_deploy_models.py sirdar/api/tests/conftest.py
git commit -m "feat(sirdar): migration 0008 — esxi integration kind and the esxi_vms ownership record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: pyVmomi pinned in the image, TLS pins without a host name, and the ESXi credentials

**Files:**
- Create: `sirdar/api/requirements-esxi.txt`
- Modify: `sirdar/api/pyproject.toml`, `sirdar/Dockerfile`
- Modify: `sirdar/api/src/sirdar_api/deploy/tls_pin.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/integrations.py`
- Modify: `sirdar/api/tests/integration_helpers.py`
- Test: `sirdar/api/tests/test_deploy_tls_pin.py`, `sirdar/api/tests/test_deploy_integrations.py`, create `sirdar/api/tests/test_deploy_esxi_image.py`

**Interfaces:**
- Produces: `tls_pin.pinned_context(pem: str, *, check_hostname: bool = True) -> ssl.SSLContext`. With `check_hostname=False`, `verify_mode` stays `CERT_REQUIRED` and the pinned certificate stays the only anchor.
- Produces (`integrations`):
  - `KINDS = ("cloudflare", "npm", "proxmox", "esxi")`;
  - `VM_HOST_KINDS = ("proxmox", "esxi")`;
  - `LABELS["esxi"] = "VMware ESXi"`;
  - `SECRET_FIELD["esxi"] = "password"`;
  - `TARGET_FIELDS["esxi"] = ("url", "user")`;
  - `check_esxi_url(value) -> str`;
  - `EsxiConfig(url, user, datastore, network, resource_pool: str | None, source_vm, dns_servers: tuple[str, ...], tls_fingerprint, tls_cert_pem (repr=False), password (repr=False))`;
  - `load_esxi(db, settings) -> EsxiConfig | None`;
  - `in_use(db, kind)` covers both VM host kinds.
- Produces (test helpers): `ESXI_PASSWORD`, `ESXI_CERT`, `ESXI_CERT_KEY`, `ESXI_FINGERPRINT`, `ESXI_VALUES`, `ESXI_BODY`, `async configure_esxi(db)`.

- [ ] **Step 1: Pin pyVmomi with hashes and install it in the venv**

Create `sirdar/api/requirements-esxi.txt`:

```
# The vSphere SDK for ESXi targets (deploy phase 6), installed by the image
# with --require-hashes before `pip install .`. 8.0.3.0.1, not 9.x: pyVmomi
# supports the four vSphere releases before its own, and 8.0 U3's window still
# includes Jimmy's ESXi 7. Bump together with pyproject.toml (a test compares).
pyvmomi==8.0.3.0.1 \
    --hash=sha256:db795c960159cfa3c81e6af4cf1f46618e61cf0349db1666de75df98a4f29c69
six==1.17.0 \
    --hash=sha256:4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274 \
    --hash=sha256:ff70335d468e7eb6ec65b95b99d3a2836546063f63acc5171de367e834932a81
```

In `sirdar/api/pyproject.toml`, add to `dependencies` after the `ansible-runner` line:

```toml
    "pyvmomi==8.0.3.0.1",      # ESXi targets (hash-pinned in requirements-esxi.txt)
```

In `sirdar/Dockerfile`, replace:

```dockerfile
COPY sirdar/api/pyproject.toml ./
COPY sirdar/api/src ./src
RUN pip install --no-cache-dir .
```

with:

```dockerfile
COPY sirdar/api/pyproject.toml sirdar/api/requirements-esxi.txt ./
# pyVmomi (ESXi targets, deploy phase 6) and its one dependency, checked
# against their published SHA-256 sums; `pip install .` then finds them
# installed.
RUN pip install --no-cache-dir --require-hashes --no-deps -r requirements-esxi.txt
COPY sirdar/api/src ./src
RUN pip install --no-cache-dir .
```

Install into the worktree venv:

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api
.venv/bin/pip install --require-hashes --no-deps -r requirements-esxi.txt
.venv/bin/python -c "import pyVmomi, pyVim.connect; from pyVmomi import vim; print(vim.fault.InvalidLogin)"
```

Expected: the install succeeds and the import prints a class.

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_esxi_image.py`:

```python
"""The image installs exactly the pyVmomi pyproject.toml names, hash-checked."""

import re
import tomllib
from pathlib import Path

API = Path(__file__).resolve().parents[1]
SIRDAR = API.parent


def test_pyproject_and_the_hash_file_pin_the_same_pyvmomi():
    deps = tomllib.loads((API / "pyproject.toml").read_text())["project"]["dependencies"]
    [pin] = [d for d in deps if d.startswith("pyvmomi")]
    hashed = (API / "requirements-esxi.txt").read_text()
    version = pin.split("==", 1)[1]
    assert re.search(rf"^pyvmomi=={re.escape(version)} \\$", hashed, re.M)
    assert re.search(r"^six==[0-9.]+ \\$", hashed, re.M)
    assert hashed.count("--hash=sha256:") == 3


def test_the_image_installs_the_hash_file_before_the_app():
    text = (SIRDAR / "Dockerfile").read_text()
    hashed = text.index("--require-hashes --no-deps -r requirements-esxi.txt")
    assert hashed < text.index("RUN pip install --no-cache-dir .")
```

Append to `sirdar/api/tests/test_deploy_tls_pin.py`:

```python
async def test_without_a_host_name_check_only_the_pinned_certificate_is_trusted(tmp_path):
    """ESXi's default certificate names its host name, not the IP Sirdar uses:
    the pin alone decides."""
    pem, key = make_cert(cn="localhost.localdomain", ips=(), dns=("localhost.localdomain",))
    impostor, _ = make_cert(cn="localhost.localdomain", ips=(), dns=("localhost.localdomain",))
    server, port = await _tls_server(tmp_path, pem, key)
    async with server:
        ctx = tls_pin.pinned_context(pem, check_hostname=False)
        assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname is False
        _, writer = await asyncio.open_connection("127.0.0.1", port, ssl=ctx)
        writer.close()
        with pytest.raises(ssl.SSLCertVerificationError):
            await asyncio.open_connection("127.0.0.1", port, ssl=tls_pin.pinned_context(pem))
        with pytest.raises(ssl.SSLCertVerificationError):
            await asyncio.open_connection(
                "127.0.0.1", port, ssl=tls_pin.pinned_context(impostor, check_hostname=False))
```

In `sirdar/api/tests/integration_helpers.py`, append:

```python
ESXI_PASSWORD = "esxi-PASSWORD-s3cr3t!"
# ESXi's default certificate names only its host name (no IP).
ESXI_CERT, ESXI_CERT_KEY = make_cert(cn="localhost.localdomain", ips=(),
                                     dns=("localhost.localdomain",))
ESXI_FINGERPRINT = tls_pin.fingerprint_of(ESXI_CERT)
ESXI_VALUES = {"url": "https://10.10.48.10", "user": "sirdar", "datastore": "datastore1",
               "network": "VM Network", "resource_pool": None,
               "source_vm": "sirdar-ubuntu-2404-seed", "dns_servers": [],
               "tls_fingerprint": ESXI_FINGERPRINT, "tls_cert_pem": ESXI_CERT}
# What the Settings modal sends (no certificate: the API fetches it).
ESXI_BODY = {k: v for k, v in ESXI_VALUES.items() if k != "tls_cert_pem"}


async def configure_esxi(db) -> None:
    """Save the ESXi integration (needs the secrets_key fixture) and commit."""
    await integrations.save(db, get_settings(), "esxi", ESXI_VALUES, ESXI_PASSWORD,
                            actor_id=None)
    await db.commit()
```

Append to `sirdar/api/tests/test_deploy_integrations.py`. Add any import that is missing at the top of the file:
- `from .integration_helpers import ESXI_CERT, ESXI_FINGERPRINT, ESXI_PASSWORD, ESXI_VALUES, configure_esxi`
- `from sirdar_api.deploy import integrations`
- `from sirdar_api.config import get_settings`
- `from .deploy_factories import secrets_key  # noqa: F401`

Reuse the module's existing imports where they are already there.

```python
async def test_esxi_settings_round_trip(db, secrets_key):
    changed = await integrations.save(db, get_settings(), "esxi",
                                      {**ESXI_VALUES, "dns_servers": ["10.10.48.1", " 1.1.1.1"],
                                       "resource_pool": "  "}, ESXI_PASSWORD, actor_id=None)
    await db.commit()
    assert "password" in changed and "user" in changed
    cfg = await integrations.load_esxi(db, get_settings())
    assert (cfg.url, cfg.user, cfg.datastore, cfg.network, cfg.resource_pool, cfg.source_vm,
            cfg.dns_servers, cfg.tls_fingerprint) == (
        "https://10.10.48.10", "sirdar", "datastore1", "VM Network", None,
        "sirdar-ubuntu-2404-seed", ("10.10.48.1", "1.1.1.1"), ESXI_FINGERPRINT)
    assert cfg.password == ESXI_PASSWORD and cfg.tls_cert_pem == ESXI_CERT
    assert ESXI_PASSWORD not in repr(cfg) and "BEGIN CERTIFICATE" not in repr(cfg)
    shown = (await integrations.public(db, get_settings()))["esxi"]
    assert shown["password_set"] and shown["configured"] and "password" not in shown
    assert shown["dns_servers"] == ["10.10.48.1", "1.1.1.1"] and "tls_cert_pem" not in shown


@pytest.mark.parametrize(("change", "code"), [
    ({"url": "http://10.10.48.10"}, "esxi_url_invalid"),
    ({"url": "https://10.10.48.10/ui"}, "esxi_url_invalid"),
    ({"user": "root:x"}, "esxi_user_invalid"),
    ({"user": ""}, "esxi_user_invalid"),
    ({"datastore": "[datastore1]"}, "datastore_invalid"),
    ({"datastore": ""}, "datastore_invalid"),
    ({"network": "a/b"}, "network_invalid"),
    ({"resource_pool": "pool\\x"}, "resource_pool_invalid"),
    ({"source_vm": " "}, "source_vm_invalid"),
    ({"dns_servers": ["10.10.48.1", "dns.example"]}, "dns_servers_invalid"),
    ({"dns_servers": ["1.1.1.1", "8.8.8.8", "9.9.9.9", "1.0.0.1"]}, "dns_servers_invalid"),
    ({"dns_servers": ["127.0.0.1"]}, "dns_servers_invalid"),
    ({"tls_fingerprint": ""}, "tls_untrusted"),
    ({"tls_fingerprint": "AB:CD"}, "tls_fingerprint_invalid"),
])
async def test_esxi_validation(db, secrets_key, change, code):
    with pytest.raises(integrations.IntegrationError) as e:
        await integrations.save(db, get_settings(), "esxi", {**ESXI_VALUES, **change},
                                ESXI_PASSWORD, actor_id=None)
    assert e.value.code == code


async def test_esxi_password_rules_and_reuse(db, secrets_key):
    for bad in ("", "a\nb", "x" * 1025):
        with pytest.raises(integrations.IntegrationError) as e:
            await integrations.save(db, get_settings(), "esxi", ESXI_VALUES, bad, actor_id=None)
        assert e.value.code == "password_invalid"
    await configure_esxi(db)
    await integrations.save(db, get_settings(), "esxi", {**ESXI_VALUES, "datastore": "ssd2"},
                            None, actor_id=None)                 # same host and user: kept
    for other in ({"url": "https://10.10.48.11"}, {"user": "root"}):
        with pytest.raises(integrations.IntegrationError) as e:
            await integrations.save(db, get_settings(), "esxi", {**ESXI_VALUES, **other},
                                    None, actor_id=None)
        assert e.value.code == "secret_required"
        assert "different ESXi host or user" in e.value.extra["reason"]


async def test_vm_hosts_in_use(db, secrets_key):
    await configure_esxi(db)
    env = await make_environment(db, name="uat3")
    env.target_id = "esxi"
    await db.commit()
    assert await integrations.in_use(db, "esxi") == ["uat3"]
    assert await integrations.in_use(db, "proxmox") == []
    assert await integrations.in_use(db, "npm") == []
```

If `make_environment` is not imported in that file yet, import it from `.deploy_factories`.

- [ ] **Step 3: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_image.py tests/test_deploy_tls_pin.py tests/test_deploy_integrations.py`
Expected: FAIL. The image tests fail on the missing hash-file line (until Step 1's edits are in), `pinned_context` doesn't take `check_hostname`, and `integrations` rejects the kind `esxi` with a `KeyError`.

- [ ] **Step 4: `pinned_context` without the host name check**

In `sirdar/api/src/sirdar_api/deploy/tls_pin.py`, replace the whole `pinned_context` function with:

```python
def pinned_context(pem: str, *, check_hostname: bool = True) -> ssl.SSLContext:
    """A client context whose only trust anchor is this certificate. Partial
    chains are allowed so a leaf can anchor itself. The host name is checked
    against the certificate's names unless check_hostname is False (ESXi's
    default certificate names only its host name, and the pin alone decides:
    verification itself stays on). ValueError unless `pem` is exactly one
    certificate (only its DER bytes are loaded)."""
    der = _der(pem)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)          # CERT_REQUIRED, check_hostname
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.check_hostname = check_hostname                    # verify_mode stays CERT_REQUIRED
    ctx.load_verify_locations(cadata=der)
    if ctx.cert_store_stats()["x509"] != 1:                # not an assert: survives -O
        raise ValueError("the pinned context must trust exactly one certificate")
    ctx.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx
```

Also change the module docstring's first sentence to: "Trust-on-first-use pinning of a server's TLS certificate (Proxmox's pve-ssl.pem, ESXi's rui.crt), the TLS twin of known_hosts:".

- [ ] **Step 5: The `esxi` kind in `integrations.py`**

In `sirdar/api/src/sirdar_api/deploy/integrations.py`:

1. Update the module docstring's first sentence to name "the ESXi password it builds VMs with (phase 6)" next to the Proxmox token.
2. Replace the constants block from `KINDS = …` through `PROXMOX_TARGET = "proxmox"` with:

```python
KINDS = ("cloudflare", "npm", "proxmox", "esxi")
# The kinds an environment's VM is built on; an environment on one has
# target_id equal to the kind (targets.VM_TARGETS).
VM_HOST_KINDS = ("proxmox", "esxi")
LABELS = {"cloudflare": "Cloudflare", "npm": "Nginx Proxy Manager", "proxmox": "Proxmox",
          "esxi": "VMware ESXi"}
FIELDS = {"cloudflare": ("zone", "public_ip"), "npm": ("url", "identity", "letsencrypt_email"),
          "proxmox": ("url", "node", "pool", "storage", "bridge", "vlan_tag", "template_vmid",
                      "tls_fingerprint", "token_id"),
          "esxi": ("url", "user", "datastore", "network", "resource_pool", "source_vm",
                   "dns_servers", "tls_fingerprint")}
SECRET_FIELD = {"cloudflare": "token", "npm": "password", "proxmox": "token",
                "esxi": "password"}
DEFAULT_ZONE = "serversherpa.com"
# A stored secret is reused (secret omitted) only for the target it was
# entered for: the Cloudflare token only ever goes to api.cloudflare.com, so
# the zone is enough; the NPM and ESXi passwords go to the URL, for that login.
TARGET_FIELDS = {"cloudflare": ("zone",), "npm": ("url", "identity"), "proxmox": ("url",),
                 "esxi": ("url", "user")}
NEW_TARGET_REASON = {
    "cloudflare": "Enter the token again to use it with a different zone.",
    "npm": "Enter the password again to use it with a different server or login.",
    "proxmox": "Enter the API token again to use it with a different Proxmox server.",
    "esxi": "Enter the password again to use it with a different ESXi host or user.",
}
# The environment target that builds its host on Proxmox (targets.PROXMOX_TARGET).
PROXMOX_TARGET = "proxmox"
MAX_DNS_SERVERS = 3
```

3. After `_PVE_TOKEN_RE`, add:

```python
# ESXi local users ("root", "sirdar") and datastore / port group / pool / VM
# names: no brackets (datastore paths use them), slashes, colons or
# leading/trailing spaces.
_ESXI_USER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@-]{0,63}")
_ESXI_NAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 ._()-]{0,78}[A-Za-z0-9._()-])?")
```

4. After `class ProxmoxConfig …` (and its properties), add:

```python
@dataclass(frozen=True)
class EsxiConfig:
    url: str
    user: str
    datastore: str
    network: str
    resource_pool: str | None
    source_vm: str
    dns_servers: tuple[str, ...]
    tls_fingerprint: str
    tls_cert_pem: str = field(repr=False)
    password: str = field(repr=False)
```

5. Replace `check_proxmox_url` with a shared checker plus the two named ones:

```python
def check_https_url(value, code: str) -> str:
    url = str(value or "").strip().rstrip("/")
    match = _PVE_URL_RE.fullmatch(url)
    if not match or (match.group(2) is not None and not 1 <= int(match.group(2)) <= 65535):
        raise IntegrationError(code)
    return url


def check_proxmox_url(value) -> str:
    return check_https_url(value, "proxmox_url_invalid")


def check_esxi_url(value) -> str:
    return check_https_url(value, "esxi_url_invalid")
```

6. Split the pin check out of `_check_proxmox`. Add this before `_check_proxmox`:

```python
def _check_pin(values: dict) -> tuple[str, str]:
    """(fingerprint, certificate PEM): the certificate the route fetched and
    the user trusted must have the fingerprint the request names."""
    given = str(values.get("tls_fingerprint") or "").strip()
    if not given:                                  # nothing trusted yet
        raise IntegrationError("tls_untrusted")
    try:
        fingerprint = tls_pin.normalize_fingerprint(given)
    except ValueError:
        raise IntegrationError("tls_fingerprint_invalid") from None
    pem = values.get("tls_cert_pem")
    if not isinstance(pem, str):
        raise IntegrationError("tls_untrusted")
    try:
        actual = tls_pin.fingerprint_of(pem)
    except ValueError:
        raise IntegrationError("tls_untrusted") from None
    if actual != fingerprint:
        raise IntegrationError("tls_untrusted")
    return fingerprint, pem
```

   In `_check_proxmox`, replace everything from `given = str(values.get("tls_fingerprint") …` down to the line `raise IntegrationError("tls_untrusted")` that sits just before `return {"url": url, …}` with `fingerprint, pem = _check_pin(values)`. Leave its `return` as it is.

7. After `_check_proxmox`, add:

```python
def _check_dns(value) -> list[str]:
    """Up to MAX_DNS_SERVERS IPv4 addresses (a list, or one comma-separated
    string); empty: the VM uses its gateway."""
    if value in (None, ""):
        return []
    items = value if isinstance(value, list) else str(value).split(",")
    found: list[str] = []
    for item in items:
        text = str(item).strip()
        if not text:
            continue
        try:
            ip = ipaddress.IPv4Address(text)
        except ValueError:
            raise IntegrationError("dns_servers_invalid") from None
        if ip.is_unspecified or ip.is_multicast or ip.is_loopback or ip.is_link_local:
            raise IntegrationError("dns_servers_invalid")
        if str(ip) not in found:
            found.append(str(ip))
    if len(found) > MAX_DNS_SERVERS:
        raise IntegrationError("dns_servers_invalid")
    return found


def _check_esxi(values: dict) -> dict:
    url = check_esxi_url(values.get("url"))

    def text(key: str, regex: re.Pattern, code: str) -> str:
        value = str(values.get(key) or "").strip()
        if not regex.fullmatch(value):
            raise IntegrationError(code)
        return value

    user = text("user", _ESXI_USER_RE, "esxi_user_invalid")
    datastore = text("datastore", _ESXI_NAME_RE, "datastore_invalid")
    network = text("network", _ESXI_NAME_RE, "network_invalid")
    pool = str(values.get("resource_pool") or "").strip()
    if pool and not _ESXI_NAME_RE.fullmatch(pool):
        raise IntegrationError("resource_pool_invalid")
    source = text("source_vm", _ESXI_NAME_RE, "source_vm_invalid")
    dns = _check_dns(values.get("dns_servers"))
    fingerprint, pem = _check_pin(values)
    return {"url": url, "user": user, "datastore": datastore, "network": network,
            "resource_pool": pool or None, "source_vm": source, "dns_servers": dns,
            "tls_fingerprint": fingerprint, "tls_cert_pem": pem}
```

8. Change `_CHECKS` to include `"esxi": _check_esxi`.
9. Change the return annotation `CloudflareConfig | NpmConfig | ProxmoxConfig` to `CloudflareConfig | NpmConfig | ProxmoxConfig | EsxiConfig` everywhere it appears (`_config`, `load`, `candidate`).
10. In `_config`, add before the NPM `return`:

```python
    if kind == "esxi":
        return EsxiConfig(url=config["url"], user=config["user"], datastore=config["datastore"],
                          network=config["network"], resource_pool=config.get("resource_pool"),
                          source_vm=config["source_vm"],
                          dns_servers=tuple(config.get("dns_servers") or ()),
                          tls_fingerprint=config["tls_fingerprint"],
                          tls_cert_pem=config["tls_cert_pem"], password=secret)
```

11. After `load_proxmox`, add:

```python
async def load_esxi(db: AsyncSession, settings: Settings) -> EsxiConfig | None:
    return await load(db, settings, "esxi")
```

12. Replace `in_use` with:

```python
async def in_use(db: AsyncSession, kind: str) -> list[str]:
    """Environments that can't lose this integration: those built on this
    VM host (their VMs could no longer be destroyed)."""
    if kind not in VM_HOST_KINDS:
        return []
    return list(await db.scalars(select(Environment.name)
                                 .where(Environment.target_id == kind)
                                 .order_by(Environment.name)))
```

`check_secret` needs no change: `esxi` falls through to the password rules, the same as NPM.

- [ ] **Step 6: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_image.py tests/test_deploy_tls_pin.py tests/test_deploy_integrations.py tests/test_deploy_proxmox_api.py`
Expected: all pass. The Proxmox API tests prove `_check_pin` changed nothing.

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/tls_pin.py src/sirdar_api/deploy/integrations.py tests/integration_helpers.py tests/test_deploy_tls_pin.py tests/test_deploy_integrations.py tests/test_deploy_esxi_image.py
cd ../.. && git add sirdar/api/requirements-esxi.txt sirdar/api/pyproject.toml sirdar/Dockerfile sirdar/api/src/sirdar_api/deploy/tls_pin.py sirdar/api/src/sirdar_api/deploy/integrations.py sirdar/api/tests/integration_helpers.py sirdar/api/tests/test_deploy_tls_pin.py sirdar/api/tests/test_deploy_integrations.py sirdar/api/tests/test_deploy_esxi_image.py
git commit -m "feat(sirdar): esxi integration kind, hash-pinned pyVmomi, TLS pins without a host name check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The ESXi client, its fake, its guard and the connection test

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/esxi.py`
- Create: `sirdar/api/tests/fake_esxi.py`, `sirdar/api/tests/esxi_helpers.py`
- Modify: `sirdar/api/tests/conftest.py` (`no_real_hosts`)
- Test: create `sirdar/api/tests/test_deploy_esxi.py`

**Interfaces:**
- Consumes: `integrations.EsxiConfig`, `tls_pin.pinned_context(…, check_hostname=False)`, `deploy.Check`, `ConnectFailed`, `ConnectResult`.
- Produces (`esxi`):
  - Constants: `OWNER_KEY = "sirdar.environment"`, `DEFAULT_PORT = 443`, `TLS_CHANGED`, `LICENSE_READ_ONLY`.
  - Errors: `EsxiError(reason)`, and `QuiesceFailed(EsxiError)`.
  - Records (frozen dataclasses):
    - `About(product, version, build, api_type)`;
    - `DatastoreInfo(name, accessible, free_gb, capacity_gb)`;
    - `DiskInfo(key: int, path: str, capacity_gb: int)`;
    - `VmInfo(moref, instance_uuid, name, owner, power_state, vm_path, cores, memory_mb, disks: tuple[DiskInfo, ...], snapshot_count, template)`, with the property `disk_gb`;
    - `Guest(tools_running: bool, ipv4: tuple[str, ...])`;
    - `SnapshotInfo(id: int, name, description, created)`;
    - `CreateSpec(name, datastore, network, resource_pool, cores, memory_mb, annotation, extra_config: dict[str, str] (repr=False))`.
  - The `EsxiApi` protocol (all async):
    - `about()`, `license_editions()`;
    - `datastore(name) -> DatastoreInfo | None`, `network_names()`, `resource_pool_names()`;
    - `find_vm(instance_uuid) -> VmInfo | None`, `find_vm_by_name(name) -> VmInfo | None`;
    - `create_vm(spec) -> VmInfo`;
    - `file_exists(path) -> bool`, `copy_disk(src, dst)`, `delete_disk(path)`;
    - `attach_disk(uuid, path)`, `grow_disk(uuid, disk_key, size_gb)`, `set_size(uuid, cores, memory_mb)`;
    - `set_extra_config(uuid, values: dict[str, str])`;
    - `power_on(uuid)`, `shutdown_guest(uuid)`, `power_off(uuid)`;
    - `guest(uuid) -> Guest`;
    - `snapshots(uuid) -> list[SnapshotInfo]`;
    - `take_snapshot(uuid, name, description, *, quiesce: bool)`, `revert_snapshot(uuid, snapshot_id)`, `delete_snapshot(uuid, snapshot_id)`;
    - `destroy(uuid)`.
  - Functions:
    - `connect(cfg)`, an async context manager yielding `EsxiApi`;
    - `split_url(url) -> (host, port)`;
    - `vm_folder(vm_path) -> str` and `disk_path_for(vm_path, name) -> str`;
    - `fault_reason(fault, what) -> str`, `owner_of(extra_config) -> str`, `flatten_snapshots(tree) -> list[SnapshotInfo]`, `guest_ipv4(guest) -> tuple[str, ...]`;
    - `create_config(spec, *, network) -> vim.vm.ConfigSpec`, `vm_info(vm) -> VmInfo`;
    - `async test_connection(cfg, *, transport=None) -> ConnectResult`.
- Produces (tests): `FakeEsxi` (in-memory `EsxiApi` with `connect`, `add_seed`, `add_vm`, failure knobs), and the `esxi_fake` fixture in `esxi_helpers.py`.

- [ ] **Step 1: Check how the installed pyVmomi takes a SHA-256 thumbprint**

Run:

```bash
grep -n "def VerifyCertThumbprint" -A25 .venv/lib/python3.13/site-packages/pyVmomi/Security.py
grep -n "def SmartConnect(" -A30 .venv/lib/python3.13/site-packages/pyVim/connect.py | grep -n "thumbprint\|httpConnectionTimeout\|sslContext"
```

Expected:
- `VerifyCertThumbprint` accepts a 64-hex-character thumbprint (SHA-256).
- `SmartConnect` takes `thumbprint`, `sslContext` and `httpConnectionTimeout`.

If the thumbprint must have no colons (or must be lowercase), `_smart_connect` below already passes it that way. If SHA-256 thumbprints aren't supported at all, drop the `thumbprint=` argument (the pinned context alone still trusts only the pin) and say so in the task report.

- [ ] **Step 2: Write the fake and the fixture**

Create `sirdar/api/tests/fake_esxi.py`:

```python
"""An in-memory standalone ESXi host for tests: the esxi.EsxiApi protocol
over plain records. It acts the way ESXi does where Sirdar depends on it:
VM names are unique, a disk with snapshots can't grow, CPU and memory change
only while the VM is off, a disk-only snapshot reverts to a powered-off VM,
and destroying a running VM is refused. `fail[method] = EsxiError(...)` makes
a method fail; `logins` records (url, user) — never the password."""

import contextlib
import itertools
from dataclasses import dataclass, field, replace

from sirdar_api.deploy import esxi
from sirdar_api.deploy.esxi import (
    About,
    DatastoreInfo,
    DiskInfo,
    EsxiError,
    Guest,
    QuiesceFailed,
    SnapshotInfo,
    VmInfo,
)

SEED = "sirdar-ubuntu-2404-seed"
SEED_DISK = f"[datastore1] {SEED}/{SEED}.vmdk"


@dataclass
class FakeVm:
    moref: str
    instance_uuid: str
    name: str
    vm_path: str
    owner: str = ""
    annotation: str = ""
    extra: dict = field(default_factory=dict)
    cores: int = 2
    memory_mb: int = 2048
    disks: list = field(default_factory=list)          # [DiskInfo]
    power_state: str = "poweredOff"
    tools_running: bool = False
    ipv4: tuple = ()
    snapshots: list = field(default_factory=list)      # [SnapshotInfo]
    template: bool = False

    def info(self) -> VmInfo:
        return VmInfo(moref=self.moref, instance_uuid=self.instance_uuid, name=self.name,
                      owner=self.owner, power_state=self.power_state, vm_path=self.vm_path,
                      cores=self.cores, memory_mb=self.memory_mb, disks=tuple(self.disks),
                      snapshot_count=len(self.snapshots), template=self.template)


class FakeEsxi:
    def __init__(self):
        self.about_ = About("VMware ESXi 7.0.3 build-21930508", "7.0.3", "21930508",
                            "HostAgent")
        self.editions = ["esx.enterprisePlus.cpuPackage"]
        self.datastores = {"datastore1": DatastoreInfo("datastore1", True, 800, 1800)}
        self.networks = ["VM Network"]
        self.pools: list[str] = []
        self.files: dict[str, int] = {}                # disk path -> size in GB
        self.vms: dict[str, FakeVm] = {}               # by instance UUID
        self.calls: list[str] = []
        self.fail: dict[str, EsxiError] = {}
        self.specs: list = []                          # every CreateSpec
        self.quiesce_fails = False
        self.shutdown_stalls = False
        self.boot_ips: tuple = ("127.0.0.1",)          # what Tools reports once a VM runs
        self.logins: list[tuple[str, str]] = []
        self._ids = itertools.count(10)

    # ---- set-up helpers ----------------------------------------------------------
    def add_vm(self, name: str, *, owner: str = "", power_state: str = "poweredOn",
               ips: tuple = (), disks: list | None = None, vm_path: str | None = None) -> FakeVm:
        n = next(self._ids)
        vm = FakeVm(moref=str(n), instance_uuid=f"52aa0000-0000-0000-0000-{n:012d}", name=name,
                    vm_path=vm_path or f"[datastore1] {name}/{name}.vmx", owner=owner,
                    extra={esxi.OWNER_KEY: owner} if owner else {},
                    disks=list(disks or []), power_state=power_state,
                    tools_running=power_state == "poweredOn", ipv4=tuple(ips))
        self.vms[vm.instance_uuid] = vm
        return vm

    def add_seed(self, name: str = SEED, size_gb: int = 3) -> FakeVm:
        path = f"[datastore1] {name}/{name}.vmdk"
        self.files[path] = size_gb
        return self.add_vm(name, power_state="poweredOff",
                           disks=[DiskInfo(2000, path, size_gb)])

    def by_name(self, name: str) -> FakeVm | None:
        return next((v for v in self.vms.values() if v.name == name), None)

    # ---- the seam ----------------------------------------------------------------
    @contextlib.asynccontextmanager
    async def connect(self, cfg):
        self._call("connect")
        self.logins.append((cfg.url, cfg.user))
        yield self

    def _call(self, name: str) -> None:
        self.calls.append(name)
        if name in self.fail:
            raise self.fail[name]

    def _vm(self, uuid: str) -> FakeVm:
        vm = self.vms.get(uuid)
        if vm is None:
            raise EsxiError("ESXi has no VM with that id.")
        return vm

    # ---- EsxiApi -----------------------------------------------------------------
    async def about(self) -> About:
        self._call("about")
        return self.about_

    async def license_editions(self) -> list[str]:
        self._call("license_editions")
        return list(self.editions)

    async def datastore(self, name: str) -> DatastoreInfo | None:
        self._call("datastore")
        return self.datastores.get(name)

    async def network_names(self) -> list[str]:
        self._call("network_names")
        return list(self.networks)

    async def resource_pool_names(self) -> list[str]:
        self._call("resource_pool_names")
        return list(self.pools)

    async def find_vm(self, instance_uuid: str) -> VmInfo | None:
        self._call("find_vm")
        vm = self.vms.get(instance_uuid)
        return vm.info() if vm else None

    async def find_vm_by_name(self, name: str) -> VmInfo | None:
        self._call("find_vm_by_name")
        found = [v for v in self.vms.values() if v.name == name]
        if len(found) > 1:
            raise EsxiError(f"ESXi has more than one VM named {name}; Sirdar won't pick one.")
        return found[0].info() if found else None

    async def create_vm(self, spec) -> VmInfo:
        self._call("create_vm")
        if self.by_name(spec.name):
            raise EsxiError("ESXi couldn't create the VM: the name or file already exists.")
        self.specs.append(spec)
        vm = self.add_vm(spec.name, owner=spec.extra_config.get(esxi.OWNER_KEY, ""),
                         power_state="poweredOff",
                         vm_path=f"[{spec.datastore}] {spec.name}/{spec.name}.vmx")
        vm.extra = dict(spec.extra_config)
        vm.annotation, vm.cores, vm.memory_mb = spec.annotation, spec.cores, spec.memory_mb
        return vm.info()

    async def file_exists(self, path: str) -> bool:
        self._call("file_exists")
        return path in self.files

    async def copy_disk(self, src: str, dst: str) -> None:
        self._call("copy_disk")
        if src not in self.files:
            raise EsxiError("ESXi couldn't copy the seed disk: a file it needs is missing.")
        if dst in self.files:
            raise EsxiError("ESXi couldn't copy the seed disk: the name or file already exists.")
        self.files[dst] = self.files[src]

    async def delete_disk(self, path: str) -> None:
        self._call("delete_disk")
        self.files.pop(path, None)

    async def attach_disk(self, uuid: str, path: str) -> None:
        self._call("attach_disk")
        vm = self._vm(uuid)
        vm.disks.append(DiskInfo(2000 + len(vm.disks), path, self.files[path]))

    async def grow_disk(self, uuid: str, disk_key: int, size_gb: int) -> None:
        self._call("grow_disk")
        vm = self._vm(uuid)
        if vm.snapshots:
            raise EsxiError("ESXi couldn't grow the disk (vim.fault.InvalidSnapshotFormat).")
        vm.disks = [replace(d, capacity_gb=max(d.capacity_gb, size_gb)) if d.key == disk_key
                    else d for d in vm.disks]
        for d in vm.disks:
            self.files[d.path] = d.capacity_gb

    async def set_size(self, uuid: str, cores: int, memory_mb: int) -> None:
        self._call("set_size")
        vm = self._vm(uuid)
        if vm.power_state != "poweredOff":
            raise EsxiError("ESXi couldn't resize the VM: the VM's power state doesn't allow it.")
        vm.cores, vm.memory_mb = cores, memory_mb

    async def set_extra_config(self, uuid: str, values: dict[str, str]) -> None:
        self._call("set_extra_config")
        vm = self._vm(uuid)
        for key, value in values.items():
            if value == "":
                vm.extra.pop(key, None)
            else:
                vm.extra[key] = value

    async def power_on(self, uuid: str) -> None:
        self._call("power_on")
        vm = self._vm(uuid)
        vm.power_state, vm.tools_running, vm.ipv4 = "poweredOn", True, tuple(self.boot_ips)

    async def shutdown_guest(self, uuid: str) -> None:
        self._call("shutdown_guest")
        vm = self._vm(uuid)
        if not vm.tools_running:
            raise EsxiError("ESXi couldn't shut down the guest (vim.fault.ToolsUnavailable).")
        if not self.shutdown_stalls:
            vm.power_state, vm.tools_running, vm.ipv4 = "poweredOff", False, ()

    async def power_off(self, uuid: str) -> None:
        self._call("power_off")
        vm = self._vm(uuid)
        vm.power_state, vm.tools_running, vm.ipv4 = "poweredOff", False, ()

    async def guest(self, uuid: str) -> Guest:
        self._call("guest")
        vm = self._vm(uuid)
        return Guest(tools_running=vm.tools_running, ipv4=tuple(vm.ipv4))

    async def snapshots(self, uuid: str) -> list[SnapshotInfo]:
        self._call("snapshots")
        return list(self._vm(uuid).snapshots)

    async def take_snapshot(self, uuid: str, name: str, description: str, *,
                            quiesce: bool) -> None:
        self._call("take_snapshot")
        if quiesce and self.quiesce_fails:
            raise QuiesceFailed("ESXi couldn't quiesce the guest's file systems.")
        self._vm(uuid).snapshots.append(SnapshotInfo(next(self._ids), name, description, None))

    async def revert_snapshot(self, uuid: str, snapshot_id: int) -> None:
        self._call("revert_snapshot")
        vm = self._vm(uuid)
        if not any(s.id == snapshot_id for s in vm.snapshots):
            raise EsxiError("ESXi has no such snapshot.")
        vm.power_state, vm.tools_running, vm.ipv4 = "poweredOff", False, ()

    async def delete_snapshot(self, uuid: str, snapshot_id: int) -> None:
        self._call("delete_snapshot")
        vm = self._vm(uuid)
        vm.snapshots = [s for s in vm.snapshots if s.id != snapshot_id]

    async def destroy(self, uuid: str) -> None:
        self._call("destroy")
        vm = self._vm(uuid)
        if vm.power_state != "poweredOff":
            raise EsxiError("ESXi couldn't destroy the VM: the VM's power state doesn't allow it.")
        for d in vm.disks:
            self.files.pop(d.path, None)
        del self.vms[uuid]
```

Create `sirdar/api/tests/esxi_helpers.py`:

```python
"""The fake ESXi wired into esxi.connect, for every test that reaches ESXi
through Sirdar's client."""

import pytest

from sirdar_api.deploy import esxi

from .fake_esxi import FakeEsxi


@pytest.fixture
def esxi_fake(monkeypatch):
    fake = FakeEsxi()
    fake.add_seed()
    monkeypatch.setattr(esxi, "connect", fake.connect)
    return fake
```

- [ ] **Step 3: Write the failing tests**

Create `sirdar/api/tests/test_deploy_esxi.py`:

```python
import ssl
from types import SimpleNamespace

import pytest
from pyVmomi import vim, vmodl

from sirdar_api.deploy import ConnectFailed, esxi, integrations
from sirdar_api.deploy.esxi import CreateSpec, EsxiError

from .esxi_helpers import esxi_fake  # noqa: F401
from .fake_esxi import SEED
from .integration_helpers import ESXI_CERT, ESXI_FINGERPRINT, ESXI_PASSWORD

CFG = integrations.EsxiConfig(
    url="https://10.10.48.10", user="sirdar", datastore="datastore1", network="VM Network",
    resource_pool=None, source_vm=SEED, dns_servers=(), tls_fingerprint=ESXI_FINGERPRINT,
    tls_cert_pem=ESXI_CERT, password=ESXI_PASSWORD)


def test_paths():
    assert esxi.split_url("https://10.10.48.10") == ("10.10.48.10", 443)
    assert esxi.split_url("https://esx.lab:8443") == ("esx.lab", 8443)
    assert esxi.vm_folder("[datastore1] ss-uat3/ss-uat3.vmx") == "[datastore1] ss-uat3"
    assert esxi.vm_folder("[SSD 2] ss-uat3_1/ss-uat3.vmx") == "[SSD 2] ss-uat3_1"
    assert esxi.disk_path_for("[datastore1] ss-uat3/ss-uat3.vmx", "ss-uat3") == (
        "[datastore1] ss-uat3/ss-uat3-disk0.vmdk")
    for bad in ("ss-uat3.vmx", "[datastore1] ss-uat3.vmx", ""):
        with pytest.raises(ValueError):
            esxi.vm_folder(bad)


@pytest.mark.parametrize(("fault", "expected"), [
    (vim.fault.InvalidLogin(), "ESXi rejected the user name or password."),
    (vim.fault.RestrictedVersion(), esxi.LICENSE_READ_ONLY),
    (vim.fault.NoPermission(), "The ESXi user isn't allowed to create the VM."),
    (vmodl.fault.SecurityError(), "The ESXi user isn't allowed to create the VM."),
    (vim.fault.DuplicateName(), "ESXi couldn't create the VM: the name or file already exists."),
    (vim.fault.FileNotFound(), "ESXi couldn't create the VM: a file it needs is missing."),
    (vim.fault.NoDiskSpace(), "ESXi couldn't create the VM: not enough disk space or resources."),
    (vim.fault.InvalidPowerState(),
     "ESXi couldn't create the VM: the VM's power state doesn't allow it."),
])
def test_faults_become_our_copy(fault, expected):
    fault.msg = "raw ESXi text with a SECRET"
    assert esxi.fault_reason(fault, "create the VM") == expected


def test_an_unknown_fault_names_only_its_class():
    fault = vim.fault.TaskInProgress(msg="raw text")
    reason = esxi.fault_reason(fault, "start the VM")
    assert reason.startswith("ESXi couldn't start the VM (") and "raw text" not in reason


def test_create_config():
    spec = CreateSpec(name="ss-uat3", datastore="datastore1", network="VM Network",
                      resource_pool=None, cores=4, memory_mb=8192, annotation="sirdar:abc",
                      extra_config={esxi.OWNER_KEY: "abc", "guestinfo.userdata": "c2VjcmV0"})
    config = esxi.create_config(spec, network=None)
    assert (config.name, config.guestId, config.numCPUs, config.memoryMB, config.annotation,
            config.files.vmPathName) == ("ss-uat3", "ubuntu64Guest", 4, 8192, "sirdar:abc",
                                         "[datastore1]")
    extra = {o.key: o.value for o in config.extraConfig}
    assert extra[esxi.OWNER_KEY] == "abc" and extra["disk.EnableUUID"] == "TRUE"
    kinds = [type(c.device) for c in config.deviceChange]
    assert kinds == [vim.vm.device.ParaVirtualSCSIController, vim.vm.device.VirtualVmxnet3]
    nic = config.deviceChange[1].device
    assert nic.backing.deviceName == "VM Network" and nic.connectable.startConnected
    assert "c2VjcmV0" not in repr(spec)


def test_vm_info_reads_disks_owner_and_snapshots():
    disk = vim.vm.device.VirtualDisk(key=2000, capacityInKB=64 * 1024 * 1024,
                                     backing=vim.vm.device.VirtualDisk.FlatVer2BackingInfo(
                                         fileName="[datastore1] ss-uat3/ss-uat3-disk0.vmdk"))
    tree = [SimpleNamespace(id=1, name="sirdar-20261005T120000Z", description="d",
                            createTime=None,
                            childSnapshotList=[SimpleNamespace(id=2, name="by hand",
                                                               description="", createTime=None,
                                                               childSnapshotList=[])])]
    vm = SimpleNamespace(
        _moId="12", runtime=SimpleNamespace(powerState="poweredOn"),
        snapshot=SimpleNamespace(rootSnapshotList=tree),
        config=SimpleNamespace(
            instanceUuid="52aa", name="ss-uat3", template=False,
            files=SimpleNamespace(vmPathName="[datastore1] ss-uat3/ss-uat3.vmx"),
            extraConfig=[SimpleNamespace(key=esxi.OWNER_KEY, value="env-1")],
            hardware=SimpleNamespace(numCPU=4, memoryMB=8192,
                                     device=[vim.vm.device.VirtualVmxnet3(key=4000), disk])))
    info = esxi.vm_info(vm)
    assert (info.moref, info.instance_uuid, info.owner, info.power_state, info.cores,
            info.memory_mb, info.disk_gb, info.snapshot_count) == (
        "12", "52aa", "env-1", "poweredOn", 4, 8192, 64, 2)
    assert [s.name for s in esxi.flatten_snapshots(tree)] == ["sirdar-20261005T120000Z",
                                                              "by hand"]


def test_guest_ipv4_skips_link_local_and_non_virtual_nics():
    def nic(device, *ips):
        return SimpleNamespace(deviceConfigId=device, ipAddress=list(ips),
                               ipConfig=SimpleNamespace(ipAddress=[
                                   SimpleNamespace(ipAddress=i) for i in ips]))
    guest = SimpleNamespace(ipAddress="10.10.48.71", net=[
        nic(-1, "172.17.0.1"), nic(4000, "fe80::1", "169.254.3.4", "10.10.48.71")])
    assert esxi.guest_ipv4(guest) == ("10.10.48.71",)
    assert esxi.guest_ipv4(SimpleNamespace(ipAddress=None, net=None)) == ()


async def test_the_test_passes_on_a_good_host(esxi_fake):
    result = await esxi.test_connection(CFG)
    assert result.ok and result.target == "esxi"
    assert [c.label for c in result.checks] == ["ESXi", "License", "Datastore", "Network",
                                                "Resource pool", "Seed VM"]
    assert result.facts == {"url": CFG.url, "version": "7.0.3", "build": "21930508",
                            "fingerprint": ESXI_FINGERPRINT, "user": "sirdar"}
    assert esxi_fake.logins == [(CFG.url, "sirdar")]


async def test_the_test_names_each_problem(esxi_fake):
    esxi_fake.editions = ["esxBasic"]
    esxi_fake.datastores["datastore1"] = esxi.DatastoreInfo("datastore1", False, 0, 0)
    esxi_fake.networks = ["Management Network"]
    esxi_fake.by_name(SEED).power_state = "poweredOn"
    cfg = integrations.EsxiConfig(**{**CFG.__dict__, "resource_pool": "sirdar"})
    result = await esxi.test_connection(cfg)
    status = {c.label: (c.status, c.value) for c in result.checks}
    assert not result.ok
    assert status["License"] == ("fail", esxi.LICENSE_READ_ONLY)
    assert status["Datastore"][0] == "fail" and status["Network"][0] == "fail"
    assert status["Resource pool"] == ("fail", "No resource pool named sirdar.")
    assert status["Seed VM"][0] == "fail" and "powered on" in status["Seed VM"][1]


async def test_a_vcenter_is_refused(esxi_fake):
    esxi_fake.about_ = esxi.About("VMware vCenter Server 7.0.3", "7.0.3", "1", "VirtualCenter")
    result = await esxi.test_connection(CFG)
    assert result.checks[0].status == "fail" and "standalone ESXi" in result.checks[0].value


async def test_a_seed_with_snapshots_or_two_disks_is_refused(esxi_fake):
    seed = esxi_fake.by_name(SEED)
    seed.snapshots.append(esxi.SnapshotInfo(1, "base", "", None))
    result = await esxi.test_connection(CFG)
    assert "snapshots" in result.checks[-1].value
    seed.snapshots.clear()
    seed.disks.append(esxi.DiskInfo(2001, "[datastore1] x.vmdk", 1))
    result = await esxi.test_connection(CFG)
    assert "2 disks" in result.checks[-1].value


async def test_a_failed_sign_in_is_connect_failed(esxi_fake):
    esxi_fake.fail["connect"] = EsxiError("ESXi rejected the user name or password.")
    with pytest.raises(ConnectFailed) as e:
        await esxi.test_connection(CFG)
    assert e.value.reason == "ESXi rejected the user name or password."


def test_the_tls_refusal_is_recognized():
    err = OSError("wrapped")
    err.__cause__ = ssl.SSLCertVerificationError("bad cert")
    assert esxi._tls_refused(err) and not esxi._tls_refused(OSError("refused"))


async def test_the_guard_refuses_a_real_esxi(no_real_hosts):
    with pytest.raises(EsxiError):
        async with esxi.connect(CFG):
            pass
    assert no_real_hosts == ["esxi:10.10.48.10"]
    no_real_hosts.clear()


def test_the_password_never_reaches_a_repr():
    assert ESXI_PASSWORD not in repr(CFG)
```

- [ ] **Step 4: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi.py`
Expected: FAIL with `ImportError: cannot import name 'esxi'`.

- [ ] **Step 5: Write `deploy/esxi.py`**

Create `sirdar/api/src/sirdar_api/deploy/esxi.py`:

```python
"""VMware ESXi client (deploy phase 6): what Sirdar does on a standalone,
licensed ESXi 7 host through the vSphere API with pyVmomi. That covers the
connection test, VMs found by instance UUID or name, the empty VM step 0
creates, the seed disk copy, sizing, cloud-init guestinfo, power, VMware
Tools' view of the guest, VM snapshots and destroy.

One seam: connect(cfg) yields an EsxiApi. The real PyvmomiEsxi runs every
SOAP call on a one-thread executor of its own (pyVmomi blocks, and its stub
isn't shared across threads). Tests replace connect() with FakeEsxi's, and
an autouse guard replaces _smart_connect, the only function that opens a
real session.

TLS: the pinned certificate is the only trust anchor (no host name check:
ESXi's default certificate names only its host name), and pyVmomi also
compares the leaf's SHA-256 with the pin before the login is sent. Errors
are EsxiError with our own copy: never pyVmomi's or ESXi's text, and never
the password."""

import asyncio
import contextlib
import functools
import http.client
import ipaddress
import re
import ssl
import time
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol
from urllib.parse import urlsplit

from pyVim.connect import Disconnect, SmartConnect
from pyVmomi import vim, vmodl

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult, tls_pin
from sirdar_api.deploy.integrations import EsxiConfig

DEFAULT_PORT = 443
# The extraConfig key that marks a VM as Sirdar's, holding the environment's
# id. Not a guestinfo.* key, so the guest can neither read nor change it.
OWNER_KEY = "sirdar.environment"
HTTP_TIMEOUT = 30
TASK_POLL_SECONDS = 2.0
TASK_TIMEOUT_SECONDS = 30 * 60
SCSI_KEY = -101
NIC_KEY = -102
NEW_DISK_KEY = -201
_KB_PER_GB = 1024 * 1024
FREE_EDITIONS = ("esxBasic",)                 # the free license: the API is read-only
TLS_CHANGED = ("The ESXi host's certificate isn't the one Sirdar trusts. If it was renewed "
               "on purpose, trust the new one in Settings › Integrations › VMware ESXi.")
LICENSE_READ_ONLY = ("ESXi's license doesn't allow changes through its API (a free ESXi "
                     "license is read-only). Sirdar needs a paid license.")
MALFORMED = "ESXi answered in a way Sirdar doesn't understand."
_VM_PATH_RE = re.compile(r"(\[[^\]]+\] [^/]+)/[^/]+\.vmx")
_QUIESCE_FAULTS = ("ApplicationQuiesceFault", "FilesystemQuiesceFault")


class EsxiError(Exception):
    """`reason` is our own copy."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class QuiesceFailed(EsxiError):
    """VMware Tools couldn't quiesce the guest for a snapshot."""


@dataclass(frozen=True)
class About:
    product: str
    version: str
    build: str
    api_type: str                   # "HostAgent" for ESXi, "VirtualCenter" for vCenter


@dataclass(frozen=True)
class DatastoreInfo:
    name: str
    accessible: bool
    free_gb: int
    capacity_gb: int


@dataclass(frozen=True)
class DiskInfo:
    key: int
    path: str                       # "[datastore1] ss-uat3/ss-uat3-disk0.vmdk"
    capacity_gb: int


@dataclass(frozen=True)
class VmInfo:
    moref: str
    instance_uuid: str
    name: str
    owner: str                      # extraConfig sirdar.environment, "" when unset
    power_state: str                # poweredOn | poweredOff | suspended
    vm_path: str                    # "[datastore1] ss-uat3/ss-uat3.vmx"
    cores: int
    memory_mb: int
    disks: tuple[DiskInfo, ...]
    snapshot_count: int
    template: bool

    @property
    def disk_gb(self) -> int:
        return self.disks[0].capacity_gb if self.disks else 0


@dataclass(frozen=True)
class Guest:
    tools_running: bool
    ipv4: tuple[str, ...]


@dataclass(frozen=True)
class SnapshotInfo:
    id: int
    name: str
    description: str
    created: datetime | None


@dataclass(frozen=True)
class CreateSpec:
    name: str
    datastore: str
    network: str
    resource_pool: str | None
    cores: int
    memory_mb: int
    annotation: str
    # guestinfo.userdata carries the VM's private host key: never in a repr.
    extra_config: dict[str, str] = field(repr=False)


class EsxiApi(Protocol):
    async def about(self) -> About: ...
    async def license_editions(self) -> list[str]: ...
    async def datastore(self, name: str) -> DatastoreInfo | None: ...
    async def network_names(self) -> list[str]: ...
    async def resource_pool_names(self) -> list[str]: ...
    async def find_vm(self, instance_uuid: str) -> VmInfo | None: ...
    async def find_vm_by_name(self, name: str) -> VmInfo | None: ...
    async def create_vm(self, spec: CreateSpec) -> VmInfo: ...
    async def file_exists(self, path: str) -> bool: ...
    async def copy_disk(self, src: str, dst: str) -> None: ...
    async def delete_disk(self, path: str) -> None: ...
    async def attach_disk(self, uuid: str, path: str) -> None: ...
    async def grow_disk(self, uuid: str, disk_key: int, size_gb: int) -> None: ...
    async def set_size(self, uuid: str, cores: int, memory_mb: int) -> None: ...
    async def set_extra_config(self, uuid: str, values: dict[str, str]) -> None: ...
    async def power_on(self, uuid: str) -> None: ...
    async def shutdown_guest(self, uuid: str) -> None: ...
    async def power_off(self, uuid: str) -> None: ...
    async def guest(self, uuid: str) -> Guest: ...
    async def snapshots(self, uuid: str) -> list[SnapshotInfo]: ...
    async def take_snapshot(self, uuid: str, name: str, description: str, *,
                            quiesce: bool) -> None: ...
    async def revert_snapshot(self, uuid: str, snapshot_id: int) -> None: ...
    async def delete_snapshot(self, uuid: str, snapshot_id: int) -> None: ...
    async def destroy(self, uuid: str) -> None: ...


# ---- pure helpers -----------------------------------------------------------------

def split_url(url: str) -> tuple[str, int]:
    parts = urlsplit(url)
    return parts.hostname or "", parts.port or DEFAULT_PORT


def vm_folder(vm_path: str) -> str:
    """"[datastore1] ss-uat3" from "[datastore1] ss-uat3/ss-uat3.vmx"."""
    match = _VM_PATH_RE.fullmatch(str(vm_path or ""))
    if not match:
        raise ValueError("not a VM's .vmx path")
    return match.group(1)


def disk_path_for(vm_path: str, name: str) -> str:
    """Where step 0 copies the seed disk: the VM's own folder."""
    return f"{vm_folder(vm_path)}/{name}-disk0.vmdk"


def _fault_name(fault: BaseException) -> str:
    return type(fault).__name__.rsplit(".", 1)[-1]


def fault_reason(fault: BaseException, what: str) -> str:
    """Our copy for a vSphere fault; never its msg."""
    if isinstance(fault, vim.fault.InvalidLogin):
        return "ESXi rejected the user name or password."
    if isinstance(fault, vim.fault.RestrictedVersion):
        return LICENSE_READ_ONLY
    if isinstance(fault, (vim.fault.NoPermission, vmodl.fault.SecurityError)):
        return f"The ESXi user isn't allowed to {what}."
    if isinstance(fault, (vim.fault.DuplicateName, vim.fault.FileAlreadyExists)):
        return f"ESXi couldn't {what}: the name or file already exists."
    if isinstance(fault, vim.fault.FileNotFound):
        return f"ESXi couldn't {what}: a file it needs is missing."
    if isinstance(fault, (vim.fault.NoDiskSpace, vim.fault.InsufficientResourcesFault)):
        return f"ESXi couldn't {what}: not enough disk space or resources."
    if isinstance(fault, vim.fault.InvalidPowerState):
        return f"ESXi couldn't {what}: the VM's power state doesn't allow it."
    return f"ESXi couldn't {what} ({type(fault).__name__})."


def _mapped(fault: BaseException, what: str) -> EsxiError:
    if _fault_name(fault) in _QUIESCE_FAULTS:
        return QuiesceFailed("ESXi couldn't quiesce the guest's file systems.")
    return EsxiError(fault_reason(fault, what))


def _tls_refused(exc: BaseException) -> bool:
    """Whether a connection error came from a certificate the pin refused."""
    seen: BaseException | None = exc
    for _ in range(8):
        if seen is None:
            return False
        if (isinstance(seen, ssl.SSLCertVerificationError)
                or type(seen).__name__ == "ThumbprintMismatchException"):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def owner_of(extra_config) -> str:
    for option in extra_config or ():
        if getattr(option, "key", None) == OWNER_KEY:
            return str(option.value or "")
    return ""


def flatten_snapshots(tree) -> list[SnapshotInfo]:
    found: list[SnapshotInfo] = []
    for node in tree or ():
        found.append(SnapshotInfo(id=int(node.id), name=str(node.name),
                                  description=str(node.description or ""),
                                  created=node.createTime))
        found += flatten_snapshots(node.childSnapshotList)
    return found


def guest_ipv4(guest) -> tuple[str, ...]:
    """The guest's IPv4 addresses on its virtual NICs (not Docker's bridges),
    without link-local ones, in VMware Tools' order."""
    found: list[str] = []

    def add(text) -> None:
        try:
            ip = ipaddress.IPv4Address(str(text))
        except ValueError:
            return
        if not ip.is_link_local and not ip.is_loopback and str(ip) not in found:
            found.append(str(ip))

    for nic in guest.net or ():
        device = getattr(nic, "deviceConfigId", None)
        if device is None or device < 0:              # not a virtual NIC (a bridge inside)
            continue
        config = getattr(nic, "ipConfig", None)
        addresses = [a.ipAddress for a in (config.ipAddress if config else None) or ()]
        for text in addresses or (nic.ipAddress or ()):
            add(text)
    if not found and guest.ipAddress:
        add(guest.ipAddress)
    return tuple(found)


def vm_info(vm) -> VmInfo:
    cfg = vm.config
    disks = tuple(DiskInfo(int(d.key), str(d.backing.fileName), int(d.capacityInKB) // _KB_PER_GB)
                  for d in cfg.hardware.device if isinstance(d, vim.vm.device.VirtualDisk))
    tree = vm.snapshot.rootSnapshotList if vm.snapshot else ()
    return VmInfo(moref=str(vm._moId), instance_uuid=str(cfg.instanceUuid), name=str(cfg.name),
                  owner=owner_of(cfg.extraConfig), power_state=str(vm.runtime.powerState),
                  vm_path=str(cfg.files.vmPathName), cores=int(cfg.hardware.numCPU),
                  memory_mb=int(cfg.hardware.memoryMB), disks=disks,
                  snapshot_count=len(flatten_snapshots(tree)), template=bool(cfg.template))


def create_config(spec: CreateSpec, *, network) -> "vim.vm.ConfigSpec":
    """The empty VM step 0 creates: no disk yet (the seed copy is attached
    next), a ParaVirtual SCSI controller, a vmxnet3 NIC on the port group,
    the owner marker and the guestinfo cloud-init keys."""
    scsi = vim.vm.device.VirtualDeviceSpec(
        operation="add",
        device=vim.vm.device.ParaVirtualSCSIController(key=SCSI_KEY, busNumber=0,
                                                       sharedBus="noSharing"))
    nic = vim.vm.device.VirtualDeviceSpec(
        operation="add",
        device=vim.vm.device.VirtualVmxnet3(
            key=NIC_KEY, addressType="generated",
            backing=vim.vm.device.VirtualEthernetCard.NetworkBackingInfo(
                deviceName=spec.network, network=network),
            connectable=vim.vm.device.VirtualDevice.ConnectInfo(
                startConnected=True, allowGuestControl=True, connected=True)))
    extra = {**spec.extra_config, "disk.EnableUUID": "TRUE"}
    return vim.vm.ConfigSpec(
        name=spec.name, guestId="ubuntu64Guest", numCPUs=spec.cores, memoryMB=spec.memory_mb,
        annotation=spec.annotation, files=vim.vm.FileInfo(vmPathName=f"[{spec.datastore}]"),
        extraConfig=[vim.option.OptionValue(key=k, value=v) for k, v in extra.items()],
        deviceChange=[scsi, nic])


# ---- the real client ----------------------------------------------------------------

class PyvmomiEsxi:
    """EsxiApi over one pyVmomi session. Every call runs on the session's own
    one-thread executor; vSphere faults become EsxiError with our copy."""

    def __init__(self, si, pool: ThreadPoolExecutor, *, poll: float = TASK_POLL_SECONDS,
                 task_timeout: int = TASK_TIMEOUT_SECONDS):
        self._si = si
        self._pool = pool
        self._poll = poll
        self._task_timeout = task_timeout

    async def _do(self, what: str, fn: Callable, *args):
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(self._pool, functools.partial(fn, *args))
        except EsxiError:
            raise
        except vmodl.MethodFault as e:
            raise _mapped(e, what) from None
        except (OSError, http.client.HTTPException) as e:
            raise EsxiError(TLS_CHANGED if _tls_refused(e) else "Sirdar lost its connection "
                            "to ESXi.") from None
        except (AttributeError, TypeError, ValueError, KeyError, IndexError, StopIteration):
            raise EsxiError(MALFORMED) from None

    # -- sync helpers (worker thread only) --
    def _content(self):
        return self._si.RetrieveContent()

    def _dc(self):
        return next(e for e in self._content().rootFolder.childEntity
                    if isinstance(e, vim.Datacenter))

    def _host(self):
        compute = next(e for e in self._dc().hostFolder.childEntity
                       if isinstance(e, vim.ComputeResource))
        return compute, compute.host[0]

    def _vm(self, uuid: str):
        vm = self._content().searchIndex.FindByUuid(None, uuid, True, True)
        if vm is None:
            raise EsxiError("ESXi has no VM with that id.")
        return vm

    def _wait(self, task, what: str):
        deadline = time.monotonic() + self._task_timeout
        while True:
            info = task.info
            if info.state == vim.TaskInfo.State.success:
                return info.result
            if info.state == vim.TaskInfo.State.error:
                raise _mapped(info.error, what)
            if time.monotonic() >= deadline:
                raise EsxiError(f"ESXi didn't finish ({what}) in "
                                f"{self._task_timeout // 60} minutes.")
            time.sleep(self._poll)

    def _pools(self) -> dict[str, object]:
        compute, _ = self._host()
        found: dict[str, object] = {}
        todo = list(compute.resourcePool.resourcePool or ())
        while todo:
            pool = todo.pop()
            found.setdefault(str(pool.name), pool)
            todo += list(pool.resourcePool or ())
        return found

    def _all_vms(self):
        content = self._content()
        view = content.viewManager.CreateContainerView(content.rootFolder,
                                                       [vim.VirtualMachine], True)
        try:
            return list(view.view)
        finally:
            view.Destroy()

    def _device(self, vm, kind, key: int | None = None):
        return next(d for d in vm.config.hardware.device
                    if isinstance(d, kind) and (key is None or d.key == key))

    def _reconfig(self, uuid: str, spec, what: str) -> None:
        self._wait(self._vm(uuid).ReconfigVM_Task(spec=spec), what)

    def _snapshot_obj(self, vm, snapshot_id: int):
        todo = list(vm.snapshot.rootSnapshotList if vm.snapshot else ())
        while todo:
            node = todo.pop()
            if int(node.id) == int(snapshot_id):
                return node.snapshot
            todo += list(node.childSnapshotList or ())
        raise EsxiError("ESXi has no such snapshot.")

    # -- EsxiApi --
    async def about(self) -> About:
        def run():
            a = self._content().about
            return About(str(a.fullName), str(a.version), str(a.build), str(a.apiType))
        return await self._do("read its version", run)

    async def license_editions(self) -> list[str]:
        return await self._do("read its license", lambda: [
            str(lic.editionKey) for lic in self._content().licenseManager.licenses or ()])

    async def datastore(self, name: str) -> DatastoreInfo | None:
        def run():
            for ds in self._dc().datastore:
                if ds.name == name:
                    s = ds.summary
                    return DatastoreInfo(name, bool(s.accessible), int(s.freeSpace) // 1024 ** 3,
                                         int(s.capacity) // 1024 ** 3)
            return None
        return await self._do("read the datastores", run)

    async def network_names(self) -> list[str]:
        return await self._do("read the networks",
                              lambda: [str(n.name) for n in self._dc().network])

    async def resource_pool_names(self) -> list[str]:
        return await self._do("read the resource pools", lambda: sorted(self._pools()))

    async def find_vm(self, instance_uuid: str) -> VmInfo | None:
        def run():
            vm = self._content().searchIndex.FindByUuid(None, instance_uuid, True, True)
            return vm_info(vm) if vm is not None else None
        return await self._do("look up the VM", run)

    async def find_vm_by_name(self, name: str) -> VmInfo | None:
        def run():
            found = [vm for vm in self._all_vms() if vm.name == name]
            if len(found) > 1:
                raise EsxiError(f"ESXi has more than one VM named {name}; Sirdar won't pick "
                                "one.")
            return vm_info(found[0]) if found else None
        return await self._do("look up the VM", run)

    async def create_vm(self, spec: CreateSpec) -> VmInfo:
        def run():
            dc = self._dc()
            compute, host = self._host()
            network = next((n for n in dc.network if n.name == spec.network), None)
            if network is None:
                raise EsxiError(f"ESXi has no port group named {spec.network}.")
            pool = compute.resourcePool
            if spec.resource_pool:
                pool = self._pools().get(spec.resource_pool)
                if pool is None:
                    raise EsxiError(f"ESXi has no resource pool named {spec.resource_pool}.")
            task = dc.vmFolder.CreateVM_Task(config=create_config(spec, network=network),
                                             pool=pool, host=host)
            return vm_info(self._wait(task, "create the VM"))
        return await self._do("create the VM", run)

    async def file_exists(self, path: str) -> bool:
        def run():
            try:
                self._content().virtualDiskManager.QueryVirtualDiskUuid(name=path,
                                                                        datacenter=self._dc())
            except vim.fault.FileNotFound:
                return False
            return True
        return await self._do("look for the disk", run)

    async def copy_disk(self, src: str, dst: str) -> None:
        def run():
            spec = vim.VirtualDiskManager.VirtualDiskSpec(diskType="thin", adapterType="lsiLogic")
            dc = self._dc()
            task = self._content().virtualDiskManager.CopyVirtualDisk_Task(
                sourceName=src, sourceDatacenter=dc, destName=dst, destDatacenter=dc,
                destSpec=spec, force=False)
            self._wait(task, "copy the seed disk")
        await self._do("copy the seed disk", run)

    async def delete_disk(self, path: str) -> None:
        await self._do("delete the half-copied disk", lambda: self._wait(
            self._content().virtualDiskManager.DeleteVirtualDisk_Task(name=path,
                                                                      datacenter=self._dc()),
            "delete the half-copied disk"))

    async def attach_disk(self, uuid: str, path: str) -> None:
        def run():
            vm = self._vm(uuid)
            controller = self._device(vm, vim.vm.device.ParaVirtualSCSIController)
            disk = vim.vm.device.VirtualDisk(
                key=NEW_DISK_KEY, controllerKey=controller.key, unitNumber=0,
                backing=vim.vm.device.VirtualDisk.FlatVer2BackingInfo(
                    fileName=path, diskMode="persistent", thinProvisioned=True))
            spec = vim.vm.ConfigSpec(deviceChange=[
                vim.vm.device.VirtualDeviceSpec(operation="add", device=disk)])
            self._wait(vm.ReconfigVM_Task(spec=spec), "attach the disk")
        await self._do("attach the disk", run)

    async def grow_disk(self, uuid: str, disk_key: int, size_gb: int) -> None:
        def run():
            vm = self._vm(uuid)
            disk = self._device(vm, vim.vm.device.VirtualDisk, disk_key)
            if size_gb * _KB_PER_GB <= int(disk.capacityInKB):
                return
            disk.capacityInKB = size_gb * _KB_PER_GB
            disk.capacityInBytes = size_gb * 1024 ** 3
            spec = vim.vm.ConfigSpec(deviceChange=[
                vim.vm.device.VirtualDeviceSpec(operation="edit", device=disk)])
            self._wait(vm.ReconfigVM_Task(spec=spec), "grow the disk")
        await self._do("grow the disk", run)

    async def set_size(self, uuid: str, cores: int, memory_mb: int) -> None:
        await self._do("resize the VM", self._reconfig, uuid,
                       vim.vm.ConfigSpec(numCPUs=cores, memoryMB=memory_mb), "resize the VM")

    async def set_extra_config(self, uuid: str, values: dict[str, str]) -> None:
        spec = vim.vm.ConfigSpec(extraConfig=[vim.option.OptionValue(key=k, value=v)
                                              for k, v in values.items()])
        await self._do("change the VM's settings", self._reconfig, uuid, spec,
                       "change the VM's settings")

    async def power_on(self, uuid: str) -> None:
        await self._do("start the VM", lambda: self._wait(self._vm(uuid).PowerOnVM_Task(),
                                                          "start the VM"))

    async def shutdown_guest(self, uuid: str) -> None:
        await self._do("shut down the guest", lambda: self._vm(uuid).ShutdownGuest())

    async def power_off(self, uuid: str) -> None:
        await self._do("power off the VM", lambda: self._wait(self._vm(uuid).PowerOffVM_Task(),
                                                              "power off the VM"))

    async def guest(self, uuid: str) -> Guest:
        def run():
            g = self._vm(uuid).guest
            return Guest(tools_running=str(g.toolsRunningStatus) == "guestToolsRunning",
                         ipv4=guest_ipv4(g))
        return await self._do("ask VMware Tools about the guest", run)

    async def snapshots(self, uuid: str) -> list[SnapshotInfo]:
        def run():
            vm = self._vm(uuid)
            return flatten_snapshots(vm.snapshot.rootSnapshotList if vm.snapshot else ())
        return await self._do("list the VM snapshots", run)

    async def take_snapshot(self, uuid: str, name: str, description: str, *,
                            quiesce: bool) -> None:
        await self._do("take a VM snapshot", lambda: self._wait(
            self._vm(uuid).CreateSnapshot_Task(name=name, description=description,
                                               memory=False, quiesce=quiesce),
            "take a VM snapshot"))

    async def revert_snapshot(self, uuid: str, snapshot_id: int) -> None:
        def run():
            vm = self._vm(uuid)
            self._wait(self._snapshot_obj(vm, snapshot_id).RevertToSnapshot_Task(),
                       "restore the VM snapshot")
        await self._do("restore the VM snapshot", run)

    async def delete_snapshot(self, uuid: str, snapshot_id: int) -> None:
        def run():
            vm = self._vm(uuid)
            self._wait(self._snapshot_obj(vm, snapshot_id).RemoveSnapshot_Task(
                removeChildren=False), "delete a VM snapshot")
        await self._do("delete a VM snapshot", run)

    async def destroy(self, uuid: str) -> None:
        await self._do("destroy the VM", lambda: self._wait(self._vm(uuid).Destroy_Task(),
                                                            "destroy the VM"))


def _smart_connect(cfg: EsxiConfig):
    """The only call that opens a real ESXi session (tests guard it)."""
    host, port = split_url(cfg.url)
    return SmartConnect(host=host, port=port, user=cfg.user, pwd=cfg.password,
                        sslContext=tls_pin.pinned_context(cfg.tls_cert_pem,
                                                          check_hostname=False),
                        thumbprint=cfg.tls_fingerprint.replace(":", "").lower(),
                        httpConnectionTimeout=HTTP_TIMEOUT)


def _open(cfg: EsxiConfig):
    host, port = split_url(cfg.url)
    try:
        return _smart_connect(cfg)
    except vmodl.MethodFault as e:
        raise EsxiError(fault_reason(e, "sign in")) from None
    except Exception as e:  # noqa: BLE001 — the message may carry upstream text
        if _tls_refused(e):
            raise EsxiError(TLS_CHANGED) from None
        raise EsxiError(f"Couldn't reach ESXi at {host}:{port}.") from None


@contextlib.asynccontextmanager
async def connect(cfg: EsxiConfig) -> AsyncIterator[EsxiApi]:
    """A signed-in session for the length of the block, then signed out."""
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="esxi")
    loop = asyncio.get_running_loop()
    try:
        si = await loop.run_in_executor(pool, _open, cfg)
    except BaseException:
        pool.shutdown(wait=False)
        raise
    try:
        yield PyvmomiEsxi(si, pool)
    finally:
        with contextlib.suppress(Exception):
            await loop.run_in_executor(pool, Disconnect, si)
        pool.shutdown(wait=False)


async def test_connection(cfg: EsxiConfig, *, transport=None) -> ConnectResult:
    """Read-only: what the host is, then one check each for the license, the
    datastore, the port group, the resource pool and the seed VM. `transport`
    is unused (the other testers take one)."""
    checks: list[Check] = []
    try:
        async with connect(cfg) as api:
            try:
                about = await api.about()
            except EsxiError as e:
                raise ConnectFailed(e.reason) from None
            if about.api_type != "HostAgent":
                checks.append(Check("ESXi", "fail", f"This is {about.product}; Sirdar works "
                                                    "with a standalone ESXi host."))
            else:
                checks.append(Check("ESXi", "pass", about.product))

            async def license_() -> Check:
                editions = await api.license_editions()
                if any(e in FREE_EDITIONS for e in editions):
                    return Check("License", "fail", LICENSE_READ_ONLY)
                if not editions:
                    return Check("License", "warn", "ESXi didn't say which license it has.")
                return Check("License", "pass", ", ".join(editions))

            async def datastore() -> Check:
                ds = await api.datastore(cfg.datastore)
                if ds is None:
                    return Check("Datastore", "fail", f"No datastore named {cfg.datastore}.")
                if not ds.accessible:
                    return Check("Datastore", "fail", f"{cfg.datastore} isn't accessible.")
                return Check("Datastore", "pass", f"{cfg.datastore} · {ds.free_gb} GB free")

            async def network() -> Check:
                names = await api.network_names()
                if cfg.network in names:
                    return Check("Network", "pass", cfg.network)
                return Check("Network", "fail", f"No port group named {cfg.network} (found "
                                                f"{', '.join(names) or 'none'}).")

            async def pool() -> Check:
                if not cfg.resource_pool:
                    return Check("Resource pool", "pass", "The host's root pool")
                if cfg.resource_pool in await api.resource_pool_names():
                    return Check("Resource pool", "pass", cfg.resource_pool)
                return Check("Resource pool", "fail",
                             f"No resource pool named {cfg.resource_pool}.")

            async def seed() -> Check:
                vm = await api.find_vm_by_name(cfg.source_vm)
                if vm is None:
                    return Check("Seed VM", "fail", f"No VM named {cfg.source_vm}. Import the "
                                                    "Ubuntu 24.04 cloud image OVA with that "
                                                    "name (see the README).")
                if vm.power_state != "poweredOff":
                    return Check("Seed VM", "fail", f"{cfg.source_vm} is powered on. Power it "
                                                    "off and never start it: its disk is the "
                                                    "seed.")
                if len(vm.disks) != 1:
                    return Check("Seed VM", "fail", f"{cfg.source_vm} has {len(vm.disks)} "
                                                    "disks; the seed needs exactly one.")
                if vm.snapshot_count:
                    return Check("Seed VM", "fail", f"{cfg.source_vm} has snapshots. Delete "
                                                    "them so Sirdar copies one plain disk.")
                disk = vm.disks[0]
                return Check("Seed VM", "pass",
                             f"{cfg.source_vm} · {disk.path} · {disk.capacity_gb} GB")

            for label, check in (("License", license_), ("Datastore", datastore),
                                 ("Network", network), ("Resource pool", pool),
                                 ("Seed VM", seed)):
                try:
                    checks.append(await check())
                except EsxiError as e:
                    checks.append(Check(label, "fail", e.reason))
    except EsxiError as e:                       # signing in failed
        raise ConnectFailed(e.reason) from None
    facts = {"url": cfg.url, "version": about.version, "build": about.build,
             "fingerprint": cfg.tls_fingerprint, "user": cfg.user}
    return ConnectResult(ok=not any(c.status == "fail" for c in checks), target="esxi",
                         checks=checks, facts=facts)


test_connection.__test__ = False  # not a pytest test, despite the name
```

The test `test_vm_info_reads_disks_owner_and_snapshots` gives `vm_info` a `SimpleNamespace` snapshot tree, so `flatten_snapshots` must read plain attributes only. It does.

- [ ] **Step 6: The guard**

In `sirdar/api/tests/conftest.py`, inside `no_real_hosts`:
- change the import to `from sirdar_api.deploy import esxi, provision, terraform, tls_pin`;
- add after `async def probe(...)`:

```python
    def esxi_session(cfg):
        host = esxi.split_url(cfg.url)[0]
        hits.append(f"esxi:{host}")
        raise AssertionError(f"a test opened a real ESXi session ({host})")
```

- in the `with pytest.MonkeyPatch.context() as mp:` block, add `mp.setattr(esxi, "_smart_connect", esxi_session)`;
- extend the docstring: "…, never opens a real ESXi session (esxi._smart_connect), and …".

(`provision.tcp_open` stays guarded as it is. Task 7 moves that guard to `vmcommon.tcp_open`.)

- [ ] **Step 7: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi.py tests/test_deploy_tls_pin.py`
Expected: all pass. If a pyVmomi fault class named above doesn't exist in 8.0.3.0.1 (the import fails at attribute access), use the nearest existing class. Check with `.venv/bin/python -c "from pyVmomi import vim; print(vim.fault.<Name>)"` and report it.

- [ ] **Step 8: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/esxi.py tests/fake_esxi.py tests/esxi_helpers.py tests/test_deploy_esxi.py tests/conftest.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/esxi.py sirdar/api/tests/fake_esxi.py sirdar/api/tests/esxi_helpers.py sirdar/api/tests/test_deploy_esxi.py sirdar/api/tests/conftest.py
git commit -m "feat(sirdar): ESXi client over pyVmomi with its fake, guard and connection test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ESXi in the integrations API, with the shared certificate trust flow, and the target list

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/integrations.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/targets.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`list_targets` only)
- Test: create `sirdar/api/tests/test_deploy_esxi_api.py`; `sirdar/api/tests/test_deploy_targets.py`

**Interfaces:**
- Consumes: `integrations` (Task 2), `esxi.test_connection`, `esxi.split_url` (Task 3).
- Produces (`targets`):
  - `ESXI_TARGET = "esxi"`;
  - `VM_TARGETS = ("proxmox", "esxi")`;
  - `is_vm_target(target_id) -> bool`;
  - `public_targets(s, *, proxmox_configured=False, esxi_configured=False)`.
- Produces (routes):
  - `PUT /deploy/integrations/esxi`;
  - `POST /deploy/integrations/esxi/test`;
  - `DELETE /deploy/integrations/esxi` (the generic route);
  - the ESXi target in `GET /deploy/targets`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_esxi_api.py`:

```python
import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import ConnectFailed, tls_pin

from .api_helpers import auth_headers
from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .esxi_helpers import esxi_fake  # noqa: F401
from .integration_helpers import (
    ESXI_BODY,
    ESXI_CERT,
    ESXI_FINGERPRINT,
    ESXI_PASSWORD,
    configure_esxi,
)
from .tls_helpers import make_cert

URL = "/api/deploy/integrations/esxi"
UNPINNED = {k: v for k, v in ESXI_BODY.items() if k != "tls_fingerprint"}


@pytest.fixture
def certificate(monkeypatch):
    """The certificate the ESXi host serves (the real fetch is guarded)."""
    state = {"pem": ESXI_CERT, "calls": []}

    async def fetch(host, port):
        state["calls"].append((host, port))
        if state["pem"] is None:
            raise ConnectFailed(f"Couldn't reach {host}:{port} over TLS.")
        return state["pem"]

    monkeypatch.setattr(tls_pin, "fetch_certificate", fetch)
    return state


@pytest.fixture
async def no_password_leaks(client, db):
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
        assert ESXI_PASSWORD not in text and "BEGIN CERTIFICATE" not in text


async def test_saving_asks_to_trust_the_certificate_first(client, db, secrets_key, certificate,
                                                          no_password_leaks):
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**UNPINNED, "password": ESXI_PASSWORD})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert (detail["code"], detail["fingerprint"], detail["subject"]) == (
        "tls_untrusted", ESXI_FINGERPRINT, "localhost.localdomain")
    assert certificate["calls"] == [("10.10.48.10", 443)]
    resp = await client.put(URL, headers=h, json={**ESXI_BODY, "password": ESXI_PASSWORD})
    assert resp.status_code == 200, resp.text
    shown = resp.json()["esxi"]
    assert (shown["configured"], shown["password_set"], shown["user"], shown["tls_fingerprint"],
            shown["source_vm"], shown["dns_servers"]) == (
        True, True, "sirdar", ESXI_FINGERPRINT, "sirdar-ubuntu-2404-seed", [])
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == "deploy.integration_update"))
    [change] = [r.changes for r in rows]
    assert change["kind"] == "esxi" and "password" in change["changed"]


async def test_a_changed_certificate_is_refused(client, db, secrets_key, certificate):
    h = await auth_headers(client, db)
    certificate["pem"], _ = make_cert(cn="impostor")
    resp = await client.put(URL, headers=h, json={**ESXI_BODY, "password": ESXI_PASSWORD})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "tls_mismatch"
    assert resp.json()["detail"]["expected"] == ESXI_FINGERPRINT


async def test_the_stored_pin_is_reused_without_fetching(client, db, secrets_key, certificate):
    await configure_esxi(db)
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**ESXI_BODY, "datastore": "ssd2"})
    assert resp.status_code == 200, resp.text
    assert certificate["calls"] == []
    assert resp.json()["esxi"]["datastore"] == "ssd2"


@pytest.mark.parametrize(("change", "code"), [
    ({"url": "http://10.10.48.10"}, "esxi_url_invalid"),
    ({"user": "a b"}, "esxi_user_invalid"),
    ({"source_vm": ""}, "source_vm_invalid"),
    ({"dns_servers": ["x"]}, "dns_servers_invalid"),
    ({"password": "a\nb"}, "password_invalid"),
])
async def test_validation(client, db, secrets_key, certificate, change, code):
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h,
                            json={**ESXI_BODY, "password": ESXI_PASSWORD, **change})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == code


async def test_test_saved_and_unsaved(client, db, secrets_key, certificate, esxi_fake,
                                      no_password_leaks):
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/test", headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "integration_not_configured", "kinds": ["esxi"]}
    resp = await client.post(f"{URL}/test", headers=h,
                             json={**ESXI_BODY, "password": ESXI_PASSWORD})
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] and resp.json()["target"] == "esxi"
    await configure_esxi(db)
    resp = await client.post(f"{URL}/test", headers=h)
    assert resp.status_code == 200 and resp.json()["facts"]["user"] == "sirdar"


async def test_remove_refuses_while_an_environment_uses_it(client, db, secrets_key):
    await configure_esxi(db)
    env = await make_environment(db, name="uat3")
    env.target_id = "esxi"
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.delete(URL, headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "integration_in_use", "environments": ["uat3"]}


async def test_the_target_list_has_esxi_once_saved(client, db, secrets_key):
    h = await auth_headers(client, db)
    ids = [t["id"] for t in (await client.get("/api/deploy/targets", headers=h)).json()["targets"]]
    assert "esxi" not in ids
    await configure_esxi(db)
    listed = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
    assert listed[-1] == {"id": "esxi", "label": "VMware ESXi", "kind": "esxi",
                          "available": True, "configured": True}
```

Append to `sirdar/api/tests/test_deploy_targets.py`, importing `targets` if it isn't imported:

```python
def test_vm_targets():
    assert targets.VM_TARGETS == ("proxmox", "esxi")
    assert targets.is_vm_target("esxi") and targets.is_vm_target("proxmox")
    assert not targets.is_vm_target("ssh") and not targets.is_vm_target("ssh:uat")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_api.py tests/test_deploy_targets.py`
Expected: FAIL. The ESXi routes return 404/405, and `targets` has no `VM_TARGETS`.

- [ ] **Step 3: Targets**

In `sirdar/api/src/sirdar_api/deploy/targets.py`, replace:

```python
# An environment whose host is a VM Sirdar builds on Proxmox (phase 5).
PROXMOX_TARGET = "proxmox"
```

with:

```python
# Environments whose host is a VM Sirdar builds: on Proxmox (phase 5) or on a
# standalone ESXi host (phase 6). The target id equals the integration kind.
PROXMOX_TARGET = "proxmox"
ESXI_TARGET = "esxi"
VM_TARGETS = (PROXMOX_TARGET, ESXI_TARGET)
VM_TARGET_LABELS = {PROXMOX_TARGET: "Proxmox", ESXI_TARGET: "VMware ESXi"}


def is_vm_target(target_id: str | None) -> bool:
    return target_id in VM_TARGETS
```

Replace `public_targets` with:

```python
def public_targets(s: Settings, *, proxmox_configured: bool = False,
                   esxi_configured: bool = False) -> list[dict]:
    """The VM hosts are listed last (Proxmox, then ESXi) once saved."""
    out = [{"id": t.id, "label": t.label, "kind": t.id, "available": t.available,
            "configured": is_configured(t.id, s)}
           for t in TARGETS if t.id != "ssh"]
    if installer_present(s):
        out.append({"id": "ssh", "label": INSTALLER_LABEL, "kind": "ssh", "source": "installer",
                    "available": True, "configured": is_configured("ssh", s)})
    out += [{"id": t.id, "label": t.name, "kind": "ssh", "source": "saved",
             "available": True, "configured": t.configured}
            for t in saved_targets(s)]
    for kind, on in ((PROXMOX_TARGET, proxmox_configured), (ESXI_TARGET, esxi_configured)):
        if on:
            out.append({"id": kind, "label": VM_TARGET_LABELS[kind], "kind": kind,
                        "available": True, "configured": True})
    return out
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, in `list_targets`, replace:

```python
    listed = targets.public_targets(
        s, proxmox_configured=await integrations.is_configured(db, "proxmox"))
```

with:

```python
    listed = targets.public_targets(
        s, proxmox_configured=await integrations.is_configured(db, "proxmox"),
        esxi_configured=await integrations.is_configured(db, "esxi"))
```

- [ ] **Step 4: The ESXi routes and the shared pin flow**

In `sirdar/api/src/sirdar_api/api/routes/integrations.py`:

1. Docstring: change "and the Proxmox API token it builds VMs with (its TLS certificate …)" to "and the Proxmox API token and ESXi password it builds VMs with (their TLS certificates are pinned trust-on-first-use: …)".
2. Add `esxi` to the `from sirdar_api.deploy import (...)` list.
3. Replace the `Kind` and `TESTERS` lines with:

```python
Kind = Literal["cloudflare", "npm", "proxmox", "esxi"]
TESTERS = {"cloudflare": cloudflare.test_connection, "npm": npm.test_connection,
           "proxmox": proxmox.test_connection, "esxi": esxi.test_connection}
# Where each VM host's certificate is fetched from (host, port).
SPLIT_URL = {"proxmox": proxmox.split_url, "esxi": esxi.split_url}
```

4. After `PROXMOX_FIELDS`, add:

```python
ESXI_FIELDS = ("url", "user", "datastore", "network", "resource_pool", "source_vm",
               "dns_servers", "tls_fingerprint")
```

5. After `class ProxmoxIn`, add:

```python
class EsxiIn(BaseModel):
    url: str = Field(max_length=300)
    user: str = Field(max_length=64)
    datastore: str = Field(max_length=80)
    network: str = Field(max_length=80)
    resource_pool: str | None = Field(default=None, max_length=80)
    source_vm: str = Field(max_length=80)
    dns_servers: list[str] = Field(default_factory=list, max_length=5)
    # The fingerprint the user was shown and trusted (None: show it first).
    tls_fingerprint: str | None = Field(default=None, max_length=95)
    password: str | None = None
```

6. Replace the whole `_proxmox_values` function with:

```python
async def _pinned(db, kind: str, url: str, given: str | None) -> tuple[str, str]:
    """(fingerprint, certificate PEM) for a VM host's form. The stored pin is
    reused for the same URL and fingerprint; otherwise the live certificate is
    fetched and must have the fingerprint the request names (409 tls_untrusted
    shows it first, 409 tls_mismatch when it changed)."""
    wanted = None
    if (given or "").strip():
        try:
            wanted = tls_pin.normalize_fingerprint(given)
        except ValueError:
            raise _http(IntegrationError("tls_fingerprint_invalid")) from None
    stored = await integrations.config_of(db, kind)
    if (wanted and stored.get("url") == url and stored.get("tls_fingerprint") == wanted
            and stored.get("tls_cert_pem")):
        return wanted, stored["tls_cert_pem"]
    try:
        pem = await tls_pin.fetch_certificate(*SPLIT_URL[kind](url))
    except ConnectFailed as e:
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    actual = tls_pin.fingerprint_of(pem)
    if not wanted:
        raise HTTPException(status_code=409, detail={"code": "tls_untrusted",
                                                     "fingerprint": actual,
                                                     **tls_pin.describe(pem)})
    if actual != wanted:
        raise HTTPException(status_code=409, detail={"code": "tls_mismatch",
                                                     "expected": wanted, "actual": actual})
    return wanted, pem


async def _proxmox_values(db, body: ProxmoxIn) -> dict:
    """The form's values plus the pinned certificate."""
    try:
        url = integrations.check_proxmox_url(body.url)
    except IntegrationError as e:
        raise _http(e) from None
    fingerprint, pem = await _pinned(db, "proxmox", url, body.tls_fingerprint)
    values = {name: getattr(body, name) for name in PROXMOX_FIELDS}
    return {**values, "url": url, "tls_fingerprint": fingerprint, "tls_cert_pem": pem}


async def _esxi_values(db, body: EsxiIn) -> dict:
    """The form's values plus the pinned certificate."""
    try:
        url = integrations.check_esxi_url(body.url)
    except IntegrationError as e:
        raise _http(e) from None
    fingerprint, pem = await _pinned(db, "esxi", url, body.tls_fingerprint)
    values = {name: getattr(body, name) for name in ESXI_FIELDS}
    return {**values, "url": url, "tls_fingerprint": fingerprint, "tls_cert_pem": pem}
```

7. After `save_proxmox`, add:

```python
@router.put("/esxi")
async def save_esxi(body: EsxiIn, request: Request, db: DbSession,
                    actor: AuthContext = require_permission("deploy", "change")):
    return await _save("esxi", await _esxi_values(db, body), body.password, request, db, actor)
```

8. In `_test`, replace `result = await TESTERS[kind](cfg, transport=outbound.transports()[kind])` with `result = await TESTERS[kind](cfg, transport=outbound.transports().get(kind))`. ESXi has no httpx transport; its seam is `esxi.connect`.
9. After `check_proxmox`, add:

```python
@router.post("/esxi/test")
async def check_esxi(request: Request, db: DbSession, body: EsxiIn | None = None,
                     actor: AuthContext = require_permission("deploy", "change")):
    values = await _esxi_values(db, body) if body else None
    return await _test("esxi", values, body.password if body else None, request, db, actor)
```

- [ ] **Step 5: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_api.py tests/test_deploy_targets.py tests/test_deploy_proxmox_api.py tests/test_deploy_integrations_api.py`
Expected: all pass. The Proxmox API tests prove `_pinned` kept their behavior.

- [ ] **Step 6: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/api/routes/integrations.py src/sirdar_api/deploy/targets.py src/sirdar_api/api/routes/deploy.py tests/test_deploy_esxi_api.py tests/test_deploy_targets.py
cd ../.. && git add sirdar/api/src/sirdar_api/api/routes/integrations.py sirdar/api/src/sirdar_api/deploy/targets.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_esxi_api.py sirdar/api/tests/test_deploy_targets.py
git commit -m "feat(sirdar): ESXi credentials in Settings API with the shared certificate trust flow, ESXi target

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: cloud-init through guestinfo

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/cloudinit.py`
- Test: create `sirdar/api/tests/test_deploy_cloudinit.py`

**Interfaces:**
- Produces (`cloudinit`):
  - `VM_USER = "deploy"`;
  - `metadata(*, env_id, hostname, ip_cidr: str | None, gateway: str | None, dns_servers: tuple[str, ...]) -> str` (YAML);
  - `userdata(*, hostname, ssh_public_key, host_key_private, host_key_public) -> str` (`#cloud-config` YAML);
  - `guestinfo(meta: str, user: str) -> dict[str, str]`, with the four `guestinfo.*` keys, base64;
  - `scrub() -> dict[str, str]`, the user-data keys set to `""`, which deletes them on ESXi.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_cloudinit.py`:

```python
import base64
import uuid

import yaml

from sirdar_api.deploy import cloudinit

ENV_ID = uuid.UUID("0b6c2f7e-1111-4222-8333-944455556666")
PRIVATE = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"
PUBLIC = "ssh-ed25519 AAAAhost root@ss-uat3"
CLIENT = "ssh-ed25519 AAAAclient sirdar@ss-uat3"


def test_static_metadata():
    meta = yaml.safe_load(cloudinit.metadata(env_id=ENV_ID, hostname="ss-uat3",
                                             ip_cidr="10.10.48.71/24", gateway="10.10.48.1",
                                             dns_servers=()))
    assert meta["instance-id"] == f"sirdar-{ENV_ID}" and meta["local-hostname"] == "ss-uat3"
    nic = meta["network"]["ethernets"]["nic0"]
    assert meta["network"]["version"] == 2
    assert nic == {"match": {"driver": "vmxnet3"}, "dhcp4": False,
                   "addresses": ["10.10.48.71/24"],
                   "routes": [{"to": "default", "via": "10.10.48.1"}],
                   "nameservers": {"addresses": ["10.10.48.1"]}}
    assert meta["cleanup-guestinfo"] == ["userdata"]


def test_dhcp_metadata_and_dns_servers():
    meta = yaml.safe_load(cloudinit.metadata(env_id=ENV_ID, hostname="ss-uat3", ip_cidr=None,
                                             gateway=None, dns_servers=("1.1.1.1", "9.9.9.9")))
    assert meta["network"]["ethernets"]["nic0"] == {
        "match": {"driver": "vmxnet3"}, "dhcp4": True,
        "nameservers": {"addresses": ["1.1.1.1", "9.9.9.9"]}}
    meta = yaml.safe_load(cloudinit.metadata(env_id=ENV_ID, hostname="ss-uat3", ip_cidr=None,
                                             gateway=None, dns_servers=()))
    assert "nameservers" not in meta["network"]["ethernets"]["nic0"]


def test_userdata():
    text = cloudinit.userdata(hostname="ss-uat3", ssh_public_key=CLIENT,
                              host_key_private=PRIVATE, host_key_public=PUBLIC)
    assert text.startswith("#cloud-config\n")
    doc = yaml.safe_load(text)
    [user] = doc["users"]
    assert (user["name"], user["sudo"], user["lock_passwd"], user["ssh_authorized_keys"]) == (
        "deploy", "ALL=(ALL) NOPASSWD:ALL", True, [CLIENT])
    assert doc["ssh_pwauth"] is False and doc["ssh_deletekeys"] is True
    assert doc["ssh_genkeytypes"] == []
    assert doc["ssh_keys"] == {"ed25519_private": PRIVATE, "ed25519_public": PUBLIC}
    assert doc["growpart"] == {"mode": "auto", "devices": ["/"]}


def test_guestinfo_is_base64_and_only_the_user_data_holds_the_private_key():
    meta = cloudinit.metadata(env_id=ENV_ID, hostname="ss-uat3", ip_cidr=None, gateway=None,
                              dns_servers=())
    user = cloudinit.userdata(hostname="ss-uat3", ssh_public_key=CLIENT,
                              host_key_private=PRIVATE, host_key_public=PUBLIC)
    info = cloudinit.guestinfo(meta, user)
    assert set(info) == {"guestinfo.metadata", "guestinfo.metadata.encoding",
                         "guestinfo.userdata", "guestinfo.userdata.encoding"}
    assert info["guestinfo.metadata.encoding"] == info["guestinfo.userdata.encoding"] == "base64"
    assert base64.b64decode(info["guestinfo.userdata"]).decode() == user
    assert "PRIVATE KEY" not in base64.b64decode(info["guestinfo.metadata"]).decode()
    assert cloudinit.scrub() == {"guestinfo.userdata": "", "guestinfo.userdata.encoding": ""}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_cloudinit.py`
Expected: FAIL with `ImportError: cannot import name 'cloudinit'`.

- [ ] **Step 3: Write `deploy/cloudinit.py`**

```python
"""cloud-init for the VMs Sirdar builds on ESXi (deploy phase 6), delivered
through VMware's guestinfo datasource.

Metadata holds the instance id, the host name and the network (netplan v2,
matched by the vmxnet3 driver). User-data holds the deploy user with
Sirdar's key, and the SSH host key Sirdar generated, so the fingerprint is
known before the VM first boots. Pure: no I/O.

User-data holds a private host key. esxi_provision scrubs it from the VM's
settings once SSH answers with that key; metadata cleans it up in the guest
as well."""

import base64
import uuid

import yaml

VM_USER = "deploy"


def metadata(*, env_id: uuid.UUID, hostname: str, ip_cidr: str | None, gateway: str | None,
             dns_servers: tuple[str, ...]) -> str:
    """A static address with its default route and DNS (the given servers,
    else the gateway), or DHCP (with the given DNS servers, if any)."""
    if ip_cidr:
        nic: dict = {"match": {"driver": "vmxnet3"}, "dhcp4": False, "addresses": [ip_cidr],
                     "routes": [{"to": "default", "via": gateway}],
                     "nameservers": {"addresses": list(dns_servers) or [gateway]}}
    else:
        nic = {"match": {"driver": "vmxnet3"}, "dhcp4": True}
        if dns_servers:
            nic["nameservers"] = {"addresses": list(dns_servers)}
    doc = {"instance-id": f"sirdar-{env_id}", "local-hostname": hostname,
           "network": {"version": 2, "ethernets": {"nic0": nic}},
           "cleanup-guestinfo": ["userdata"]}
    return yaml.safe_dump(doc, sort_keys=False)


def userdata(*, hostname: str, ssh_public_key: str, host_key_private: str,
             host_key_public: str) -> str:
    doc = {
        "hostname": hostname,
        "preserve_hostname": False,
        "ssh_pwauth": False,
        "disable_root": True,
        "users": [{"name": VM_USER, "groups": ["sudo"], "shell": "/bin/bash",
                   "sudo": "ALL=(ALL) NOPASSWD:ALL", "lock_passwd": True,
                   "ssh_authorized_keys": [ssh_public_key]}],
        # Only the host key Sirdar generated: its fingerprint is pinned before
        # the first boot.
        "ssh_deletekeys": True,
        "ssh_genkeytypes": [],
        "ssh_keys": {"ed25519_private": host_key_private, "ed25519_public": host_key_public},
        "growpart": {"mode": "auto", "devices": ["/"]},
        "resize_rootfs": True,
    }
    return "#cloud-config\n" + yaml.safe_dump(doc, sort_keys=False)


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def guestinfo(meta: str, user: str) -> dict[str, str]:
    return {"guestinfo.metadata": _b64(meta), "guestinfo.metadata.encoding": "base64",
            "guestinfo.userdata": _b64(user), "guestinfo.userdata.encoding": "base64"}


def scrub() -> dict[str, str]:
    """An empty value deletes an extraConfig key on ESXi."""
    return {"guestinfo.userdata": "", "guestinfo.userdata.encoding": ""}
```

- [ ] **Step 4: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_cloudinit.py`
Expected: 4 passed.

- [ ] **Step 5: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/cloudinit.py tests/test_deploy_cloudinit.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/cloudinit.py sirdar/api/tests/test_deploy_cloudinit.py
git commit -m "feat(sirdar): cloud-init metadata and user-data for ESXi guestinfo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: VM records for both hosts, and ESXi environments

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/vms.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py`
- Modify: `sirdar/api/tests/vm_helpers.py`
- Modify: `sirdar/api/tests/test_deploy_vm_api.py` (the exact `vm` dict assertions only)
- Test: create `sirdar/api/tests/test_deploy_esxi_vms.py`

**Interfaces:**
- Consumes: `targets.ESXI_TARGET`, `VM_TARGETS`, `is_vm_target` (Task 4); `EsxiVm` (Task 1); `integrations.config_of`.
- Produces (`vms`):
  - `MODELS = {"proxmox": ProxmoxVm, "esxi": EsxiVm}`;
  - `async get_for(db, env) -> ProxmoxVm | EsxiVm | None`;
  - `stage(vm) -> "none" | "partial" | "built"`;
  - `new_host_keypair(env_name) -> (private, public)` (tests replace it);
  - `async add_esxi(db, settings, env, spec, esxi: dict) -> EsxiVm`;
  - `host_config` and `address_in_use` cover both hosts;
  - `public(vm)` has the shape under "API produced for 6b".
- Produces (tests): `vm_helpers.make_esxi_environment(db, *, name="uat3", current_sha=None, publish=False, host_key=None, **vm)`.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/vm_helpers.py`:

```python
async def make_esxi_environment(db, *, name: str = "uat3", current_sha: str | None = None,
                                publish: bool = False, host_key=None, **vm) -> Environment:
    """An ESXi environment. Needs the secrets_key fixture and a saved ESXi
    integration. Loopback is allowed and the address check skipped, as in
    make_vm_environment. host_key: the asyncssh private key the VM's SSH
    server presents (the tests' own server); otherwise Sirdar makes one."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(vms, "ALLOW_LOOPBACK", True)

        async def free(*args, **kwargs) -> bool:
            return False

        mp.setattr(vms, "address_in_use", free)
        if host_key is not None:
            mp.setattr(vms, "new_host_keypair", lambda env_name: (
                host_key.export_private_key("openssh").decode(),
                host_key.export_public_key("openssh").decode().strip()))
        env = await environments.create_new(db, get_settings(), name=name, type_="dev",
                                            target_id="esxi", proxy_ip="10.0.0.2",
                                            vm={**VM_SPEC, **vm}, publish=publish)
    if current_sha:
        env.current_sha, env.image_tag = current_sha, envfile.image_tag(current_sha)
        env.status = "ready"
    await db.commit()
    return env
```

Create `sirdar/api/tests/test_deploy_esxi_vms.py`:

```python
import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentService, EsxiVm
from sirdar_api.deploy import environments, serialize, vault, vms
from sirdar_api.deploy.environments import EnvError

from .deploy_factories import secrets_key  # noqa: F401
from .integration_helpers import configure_esxi, configure_proxmox
from .test_deploy_api import deploy_env  # noqa: F401
from .vm_helpers import make_esxi_environment, make_vm_environment


async def test_an_esxi_environment_freezes_its_inputs_and_holds_two_key_pairs(db, secrets_key):
    await configure_esxi(db)
    env = await make_esxi_environment(db)
    vm = await vms.get_for(db, env)
    assert isinstance(vm, EsxiVm)
    assert (vm.name, vm.host, vm.datastore, vm.network, vm.source_vm, vm.resource_pool,
            vm.dns_servers, vm.instance_uuid, vm.created) == (
        "ss-uat3", "10.10.48.10", "datastore1", "VM Network", "sirdar-ubuntu-2404-seed",
        None, [], None, False)
    assert vm.ssh_public_key.startswith("ssh-ed25519 ")
    assert vm.host_key_public.startswith("ssh-ed25519 ")
    private = vault.decrypt(get_settings(), vm.host_key_private_enc)
    assert private.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    hosts = set(await db.scalars(select(EnvironmentService.host_ip).where(
        EnvironmentService.environment_id == env.id)))
    assert hosts == {"127.0.0.1"}
    assert vms.public(vm) == {
        "kind": "esxi", "stage": "none", "name": "ss-uat3", "host": "10.10.48.10",
        "node": None, "vmid": None, "moref": None, "cores": 4, "memory_mb": 8192,
        "disk_gb": 64, "ip_mode": "static", "ip_cidr": "127.0.0.1/8",
        "gateway": "127.0.0.254", "ip": None, "keep_snapshots": 3, "created": False}
    out = await serialize.environment_out(db, env)
    assert (out["target"], out["target_kind"], out["vm"]["kind"]) == ("esxi", "esxi", "esxi")


async def test_stage():
    vm = EsxiVm(instance_uuid=None, created=False)
    assert vms.stage(vm) == "none"
    vm.instance_uuid = "52aa"
    assert vms.stage(vm) == "partial"
    vm.created = True
    assert vms.stage(vm) == "built"


async def test_esxi_must_be_set_up(db, secrets_key, deploy_env):
    with pytest.raises(EnvError) as e:
        await environments.create_new(db, get_settings(), name="uat3", type_="dev",
                                      target_id="esxi", proxy_ip="10.0.0.2",
                                      vm={"ip_mode": "dhcp"})
    assert (e.value.code, e.value.extra) == ("integration_not_configured", {"kinds": ["esxi"]})


async def test_the_esxi_host_and_esxi_vm_addresses_are_in_use(db, secrets_key, deploy_env):
    await configure_esxi(db)
    env = await make_esxi_environment(db, ip_cidr="10.10.48.71/24", gateway="10.10.48.1")
    s = get_settings()
    assert await vms.address_in_use(db, s, "10.10.48.10", proxy_ip="10.0.0.2")   # ESXi itself
    assert await vms.address_in_use(db, s, "10.10.48.71", proxy_ip="10.0.0.2")   # its VM
    assert not await vms.address_in_use(db, s, "10.10.48.71", proxy_ip="10.0.0.2",
                                        env_id=env.id)
    assert not await vms.address_in_use(db, s, "10.10.48.72", proxy_ip="10.0.0.2")


async def test_a_proxmox_vm_address_is_in_use_for_esxi_too(db, secrets_key, deploy_env):
    await configure_proxmox(db)
    await configure_esxi(db)
    await make_vm_environment(db, name="pve1", ip_cidr="10.10.48.70/24", gateway="10.10.48.1")
    assert await vms.address_in_use(db, get_settings(), "10.10.48.70", proxy_ip="10.0.0.2")


async def test_adopt_and_moving_between_hosts_are_refused(db, secrets_key, deploy_env):
    await configure_proxmox(db)
    await configure_esxi(db)
    with pytest.raises(EnvError) as e:
        await environments.adopt(db, get_settings(), name="uat3", type_="dev",
                                 target_id="esxi")
    assert e.value.code == "adopt_not_allowed"
    env = await make_esxi_environment(db)
    for target in ("proxmox", "ssh"):
        with pytest.raises(EnvError) as e:
            await environments.update(db, get_settings(), env, {"target": target})
        assert e.value.code == "target_kind_locked"
        await db.rollback()


async def test_patch_sizes_and_managed_addresses(db, secrets_key, deploy_env):
    await configure_esxi(db)
    env = await make_esxi_environment(db)
    changed = await environments.update(db, get_settings(), env,
                                        {"vm": {"cores": 6, "disk_gb": 80}})
    assert changed == ["vm.cores", "vm.disk_gb"]
    with pytest.raises(EnvError) as e:
        await environments.update(db, get_settings(), env, {"vm": {"disk_gb": 70}})
    assert e.value.code == "vm_disk_shrink"
    await db.rollback()
    with pytest.raises(EnvError) as e:
        await environments.update(db, get_settings(), env,
                                  {"services": {"api": {"host_ip": "10.10.48.9"}}})
    assert e.value.code == "host_ip_managed"


async def test_host_config_is_the_vm_once_it_has_an_address(db, secrets_key, deploy_env):
    await configure_esxi(db)
    env = await make_esxi_environment(db)
    assert await vms.host_config(db, get_settings(), env) is None
    vm = await vms.get_for(db, env)
    vm.ip = "127.0.0.1"
    await db.commit()
    cfg = await vms.host_config(db, get_settings(), env)
    assert (cfg.host, cfg.user, cfg.key_name) == ("127.0.0.1", "deploy",
                                                  "Sirdar's key for ss-uat3")
    assert cfg.private_key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
```

**Check the environment service names first.** Read `environments.update`'s signature and whether `adopt` and `update` take exactly these parameters. If a name differs (for example `patch_environment`), use the real one. The calls above mirror the Proxmox tests in `tests/test_deploy_vms.py`; copy their call shapes.

In `sirdar/api/tests/test_deploy_vm_api.py`, every assertion that compares a whole Proxmox `vm` dict (for example in `test_create_a_proxmox_environment`) gets the four new keys `"kind": "proxmox", "stage": <stage>, "host": "pve", "moref": None`. Run `grep -n '"keep_snapshots"' tests/test_deploy_vm_api.py tests/test_deploy_environments_api.py` to find them.

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_vms.py`
Expected: FAIL. `vms` has no `get_for`, and `create_new` refuses the target `esxi` with `target_invalid`.

- [ ] **Step 3: `vms.py` for both hosts**

In `sirdar/api/src/sirdar_api/deploy/vms.py`:

1. Docstring: "Proxmox VMs Sirdar builds for environments (phase 5)" → "The VMs Sirdar builds for environments, on Proxmox (phase 5) or ESXi (phase 6)". "The proxmox_vms row" → "The proxmox_vms or esxi_vms row".
2. Imports: `from sirdar_api.db.models import Deployment, Environment, EnvironmentService, EsxiVm, ProxmoxVm`.
3. After `PROXMOX_TARGET = targets.PROXMOX_TARGET`, add:

```python
ESXI_TARGET = targets.ESXI_TARGET
MODELS: dict[str, type[ProxmoxVm] | type[EsxiVm]] = {PROXMOX_TARGET: ProxmoxVm,
                                                     ESXI_TARGET: EsxiVm}
```

4. After `new_keypair`, add:

```python
def new_host_keypair(env_name: str) -> tuple[str, str]:
    """(private, public) OpenSSH ed25519 host key for an ESXi VM: delivered by
    cloud-init, so its fingerprint is known before the VM first boots. Tests
    replace this to hand in their SSH server's key."""
    key = asyncssh.generate_private_key("ssh-ed25519", comment=f"root@{vm_name(env_name)}")
    return (key.export_private_key("openssh").decode(),
            key.export_public_key("openssh").decode().strip())
```

5. After `get`, add:

```python
async def get_for(db: AsyncSession, env: Environment) -> ProxmoxVm | EsxiVm | None:
    """The VM row of a VM environment (by its target), None otherwise."""
    model = MODELS.get(env.target_id)
    if model is None:
        return None
    return await db.get(model, env.id, populate_existing=True)


def stage(vm: ProxmoxVm | EsxiVm) -> str:
    """none: no VM yet; partial: one exists (or its id is reserved) but the
    first build didn't finish; built."""
    started = vm.instance_uuid if isinstance(vm, EsxiVm) else vm.vmid
    if started is None:
        return "none"
    return "built" if vm.created else "partial"
```

6. In `address_in_use`, update the docstring ("…, both VM hosts, …") and replace:

```python
    hosts = _target_hosts(settings)
    url = (await integrations.config_of(db, "proxmox")).get("url")
    if url:
        hosts.add(urlsplit(url).hostname or "")
```

with:

```python
    hosts = _target_hosts(settings)
    for kind in targets.VM_TARGETS:
        url = (await integrations.config_of(db, kind)).get("url")
        if url:
            hosts.add(urlsplit(url).hostname or "")
```

   and replace the tail from `services = select(EnvironmentService.host_ip)` to the end of the function with:

```python
    services = select(EnvironmentService.host_ip)
    if env_id is not None:
        services = services.where(EnvironmentService.environment_id != env_id)
    if ip in set(await db.scalars(services)):
        return True
    for model in (ProxmoxVm, EsxiVm):
        machines = select(model.ip, model.ip_cidr)
        if env_id is not None:
            machines = machines.where(model.environment_id != env_id)
        if any(ip in (vm_ip, static_ip(cidr)) for vm_ip, cidr in await db.execute(machines)):
            return True
    return False
```

7. After `add`, add:

```python
async def add_esxi(db: AsyncSession, settings: Settings, env: Environment, spec: dict,
                   esxi: dict) -> EsxiVm:
    """`esxi`: the integration's stored settings. Where the VM is built (the
    host, datastore, port group, pool, seed VM and DNS servers) is frozen
    into the row. Two key pairs: Sirdar's SSH key for the deploy user, and
    the VM's own host key (private half kept only until step 0 delivers it)."""
    private, public_key = new_keypair(env.name)
    host_private, host_public = new_host_keypair(env.name)
    vm = EsxiVm(environment_id=env.id, name=vm_name(env.name),
                host=urlsplit(esxi["url"]).hostname or "", datastore=esxi["datastore"],
                network=esxi["network"], resource_pool=esxi.get("resource_pool"),
                source_vm=esxi["source_vm"], dns_servers=list(esxi.get("dns_servers") or []),
                cores=spec["cores"], memory_mb=spec["memory_mb"], disk_gb=spec["disk_gb"],
                ip_mode=spec["ip_mode"], ip_cidr=spec["ip_cidr"], gateway=spec["gateway"],
                ip=None, ssh_public_key=public_key,
                ssh_private_key_enc=vault.encrypt(settings, private),
                host_key_public=host_public,
                host_key_private_enc=vault.encrypt(settings, host_private),
                keep_snapshots=KEEP_SNAPSHOTS)
    db.add(vm)
    await db.flush()
    return vm
```

8. In `host_config`, replace:

```python
    if env.target_id != PROXMOX_TARGET:
        return targets.ssh_config_for(env.target_id, settings)
    vm = await get(db, env.id)
```

with:

```python
    if not targets.is_vm_target(env.target_id):
        return targets.ssh_config_for(env.target_id, settings)
    vm = await get_for(db, env)
```

   and change its docstring's "for a Proxmox environment the VM's" to "for a VM environment the VM's".
9. Change `update`'s annotation to `vm: ProxmoxVm | EsxiVm`.
10. Replace `public` with:

```python
def public(vm: ProxmoxVm | EsxiVm) -> dict:
    common = {"stage": stage(vm), "name": vm.name, "cores": vm.cores,
              "memory_mb": vm.memory_mb, "disk_gb": vm.disk_gb, "ip_mode": vm.ip_mode,
              "ip_cidr": vm.ip_cidr, "gateway": vm.gateway, "ip": vm.ip,
              "keep_snapshots": vm.keep_snapshots, "created": vm.created}
    if isinstance(vm, EsxiVm):
        return {"kind": "esxi", **common, "host": vm.host, "node": None, "vmid": None,
                "moref": vm.moref}
    return {"kind": "proxmox", **common, "host": vm.node, "node": vm.node, "vmid": vm.vmid,
            "moref": None}
```

   The test compares dicts, so key order doesn't matter.

- [ ] **Step 4: ESXi environments**

In `sirdar/api/src/sirdar_api/deploy/environments.py`:

1. `_check_target`: docstring "or None for a VM target (the host is the VM step 0 builds)", and replace `if target_id == targets.PROXMOX_TARGET:` with `if targets.is_vm_target(target_id):`.
2. In `create_new`'s docstring, change 'On target "proxmox", `vm` sizes the VM' to 'On a VM target ("proxmox" or "esxi"), `vm` sizes the VM', and 'the proxmox_vms row records it' to 'its VM row records it'. Replace:

```python
    if target_id == targets.PROXMOX_TARGET:
        if not await integrations.is_configured(db, "proxmox"):
            raise EnvError("integration_not_configured", kinds=["proxmox"])
```

with:

```python
    if targets.is_vm_target(target_id):
        if not await integrations.is_configured(db, target_id):
            raise EnvError("integration_not_configured", kinds=[target_id])
```

   and replace:

```python
    if spec is not None:
        await vms.add(db, settings, env, spec, await integrations.config_of(db, "proxmox"))
    return env
```

with:

```python
    if spec is not None:
        stored = await integrations.config_of(db, target_id)
        if target_id == targets.ESXI_TARGET:
            await vms.add_esxi(db, settings, env, spec, stored)
        else:
            await vms.add(db, settings, env, spec, stored)
    return env
```

3. In `adopt`, replace:

```python
    if target_id == targets.PROXMOX_TARGET:
        # Proxmox environments are only ones Sirdar built: a hand-built VM
        # (uat) stays an SSH target.
```

with:

```python
    if targets.is_vm_target(target_id):
        # VM environments are only ones Sirdar built: a hand-built VM (uat)
        # stays an SSH target.
```

4. In the PATCH function, replace:

```python
    on_vm = env.target_id == targets.PROXMOX_TARGET
    if fields.get("target") is not None:
        if (fields["target"] == targets.PROXMOX_TARGET) != on_vm:
            raise EnvError("target_kind_locked")
```

with:

```python
    on_vm = targets.is_vm_target(env.target_id)
    if fields.get("target") is not None:
        # An environment never moves to or from a VM host, nor between hosts.
        if fields["target"] != env.target_id and (on_vm or targets.is_vm_target(fields["target"])):
            raise EnvError("target_kind_locked")
```

   and replace `machine = await vms.get(db, env.id) if on_vm else None` with `machine = await vms.get_for(db, env) if on_vm else None`.

In `sirdar/api/src/sirdar_api/deploy/serialize.py`, replace:

```python
    on_vm = env.target_id == targets.PROXMOX_TARGET
    vm = await vms.get(db, env.id) if on_vm else None
```

with:

```python
    on_vm = targets.is_vm_target(env.target_id)
    vm = await vms.get_for(db, env) if on_vm else None
```

and `"target_kind": "proxmox" if on_vm else "ssh",` with `"target_kind": env.target_id if on_vm else "ssh",`.

- [ ] **Step 5: Run the tests and the Proxmox suites**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_vms.py tests/test_deploy_vms.py tests/test_deploy_vm_api.py tests/test_deploy_environments.py tests/test_deploy_environments_api.py`
Expected: all pass.

- [ ] **Step 6: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/vms.py src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/serialize.py tests/vm_helpers.py tests/test_deploy_esxi_vms.py tests/test_deploy_vm_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/vms.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/tests/vm_helpers.py sirdar/api/tests/test_deploy_esxi_vms.py sirdar/api/tests/test_deploy_vm_api.py
git commit -m "feat(sirdar): ESXi environments — esxi_vms records, generated host keys, address checks over both hosts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The shared VM-step layer (refactor, no behavior change) and the dispatcher

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/vmcommon.py`
- Create: `sirdar/api/src/sirdar_api/deploy/vmsteps.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/provision.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py`
- Modify: `sirdar/api/tests/conftest.py` (the probe guard), `sirdar/api/tests/test_deploy_provision.py` (`test_the_probe_is_guarded` only)
- Test: create `sirdar/api/tests/test_deploy_vmcommon.py`

**Interfaces:**
- Produces (`vmcommon`, moved out of `provision.py`):
  - Types: `Output`, `VmPrepareError`, `VmOutcome`, `Provisioner`.
  - Probing and writing: `async tcp_open(host, port, timeout=3.0)`, `async set_vm(model, env_id, **values)`.
  - Addresses:
    - `async check_address(settings, env_id, ip, *, host_label="Proxmox")`;
    - `async record_address(settings, model, env_id, previous, ip, *, host_label="Proxmox") -> bool`;
    - `async settle_address(settings, *, model, env_id, previous_ip, ip, pin, actor_id, target_id, out, host_label="Proxmox") -> None`.
  - Snapshots: `async recorded_snapshots(env_id) -> set[str]`, `async record_vm_snapshot(deployment_id, name: str | None)`, `to_prune(names, recorded, keep) -> list[str]`.
  - Pins:
    - `async forget_pin(ip, actor_id, target_id) -> bool`;
    - `async confirm_pin(*, ip, expected, actor_id, target_id, tries, poll, sleep, out, how, mismatch) -> bool`, where `bool` means this run made the pin.
  - `async resolve_ref(settings, resolve, *, env_id, git_ref, repo_url, out) -> str`.
- Produces (`vmsteps`):
  - `VmContext` (a type alias);
  - `async prepare(db, env, dep, settings) -> VmContext`;
  - `HostProvisioner(*, proxmox, esxi=None)` with `run(step, ctx, out)`.
- `provision.py` re-exports `Output`, `Provisioner`, `VmOutcome` and `VmPrepareError`, and keeps the wrapper `_set_vm(env_id, **values)` that the tests use.

This task moves code; it doesn't change behavior. **Every Proxmox message stays byte-identical.** The phase 5 suites (`test_deploy_provision.py`, `test_deploy_pipeline_vm.py`, `test_deploy_vm_steps.py`, `test_deploy_vm_api.py`) are the safety net and must pass unchanged, except for `test_the_probe_is_guarded`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_vmcommon.py`:

```python
import uuid

import pytest

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment
from sirdar_api.deploy import vmcommon, vmsteps
from sirdar_api.deploy.vmcommon import VmPrepareError

from .deploy_factories import make_environment, secrets_key  # noqa: F401


def test_to_prune_keeps_the_newest_recorded_and_never_hand_made():
    names = ["sirdar-20261001T000000Z", "sirdar-20261002T000000Z", "sirdar-20261003T000000Z",
             "sirdar-20261004T000000Z", "sirdar-20200101T000000Z", "before upgrade"]
    recorded = {"sirdar-20261001T000000Z", "sirdar-20261002T000000Z",
                "sirdar-20261003T000000Z", "sirdar-20261004T000000Z", "before upgrade"}
    assert vmcommon.to_prune(names, recorded, 3) == ["sirdar-20261001T000000Z"]
    assert vmcommon.to_prune(names, recorded, 10) == []


async def test_recording_and_clearing_a_vm_snapshot(db):
    env = await make_environment(db, name="uat3")
    dep = Deployment(id=uuid.uuid4(), environment_id=env.id, mode="update", git_ref="main",
                     sha="", status="running", start_step=0, vm=True)
    db.add(dep)
    await db.commit()
    await vmcommon.record_vm_snapshot(dep.id, "sirdar-20261005T120000Z")
    assert await vmcommon.recorded_snapshots(env.id) == {"sirdar-20261005T120000Z"}
    await vmcommon.record_vm_snapshot(dep.id, None)
    assert await vmcommon.recorded_snapshots(env.id) == set()


async def test_the_probe_is_guarded_here(no_real_hosts):
    with pytest.raises(AssertionError):
        await vmcommon.tcp_open("10.10.48.71", 22)
    assert no_real_hosts == ["probe:10.10.48.71"]
    no_real_hosts.clear()


async def test_an_ssh_environment_has_no_vm_steps(db, secrets_key):
    env = await make_environment(db, name="uat3")
    dep = Deployment(environment_id=env.id, mode="update", git_ref="main", sha="",
                     status="running", start_step=0, vm=True)
    with pytest.raises(VmPrepareError):
        await vmsteps.prepare(db, env, dep, get_settings())
```

In `sirdar/api/tests/test_deploy_provision.py`, replace the whole `test_the_probe_is_guarded` with:

```python
async def test_the_probe_is_guarded(no_real_hosts):
    with pytest.raises(AssertionError):
        await vmcommon.tcp_open("10.10.48.70", 22)
    assert no_real_hosts == ["probe:10.10.48.70"]
    no_real_hosts.clear()
```

and add `vmcommon` to that file's `from sirdar_api.deploy import (...)` line.

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_vmcommon.py`
Expected: FAIL with `ImportError: cannot import name 'vmcommon'`.

- [ ] **Step 3: Write `deploy/vmcommon.py`**

Move the code below out of `provision.py`, unchanged except where noted (a model parameter, a host label, the pin loop's two texts as parameters):

```python
"""What every VM host's steps share (deploy phases 5 and 6): the outcome
and protocol of a provisioner, the address checks under the advisory lock
(a saved SSH target's address is never pinned; a pin made for an address
that then can't be recorded is forgotten), the pin-and-confirm loop over
known_hosts.trust, the VM snapshot record and prune rule (only snapshots
Sirdar recorded, newest kept), and resolving the git ref on the VM. Each
small record is written in its own committed transaction, so a later
failure still knows what exists."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, Environment, EnvironmentService
from sirdar_api.deploy import ConnectFailed, gitref, known_hosts, ssh, targets, vault, vms
from sirdar_api.deploy.publish import StepFailed

Output = Callable[[str], None]
TARGETS_UNREADABLE = ("Sirdar can't read the saved SSH targets file, so it can't check that "
                      "the VM's address is free. Fix the file, then retry.")
_REF_REASONS = {
    "ref_not_found": "The repository has no branch, tag or commit named {ref}.",
    "ref_invalid": "{ref} isn't a valid branch, tag or commit.",
    "git_missing": "git isn't installed on the VM.",
    "ref_lookup_failed": "The VM couldn't list the repository's branches and tags.",
}


class VmPrepareError(Exception):
    """The VM steps can't start. `reason` is our own copy."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class VmOutcome:
    sha: str | None = None             # the commit step 0 resolved
    vm_snapshot: str | None = None     # the VM snapshot step 0 took (or kept)


class Provisioner(Protocol):
    async def run(self, step: str, ctx, out: Output) -> VmOutcome: ...


async def tcp_open(host: str, port: int, timeout: float = 3.0) -> bool:
    """Whether something accepts TCP connections at host:port. Tests guard it."""
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    except (OSError, TimeoutError):
        return False
    writer.close()
    with suppress(Exception):
        await writer.wait_closed()
    return True


async def set_vm(model, env_id: uuid.UUID, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(model).where(model.environment_id == env_id)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


def _address_taken(ip: str, host_label: str) -> StepFailed:
    return StepFailed(f"The VM came up at {ip}, an address another environment, an SSH "
                      f"target, the proxy or {host_label} already uses. Sirdar recorded nothing "
                      "for it: free the address (or fix the DHCP lease), then retry.")


async def _address_free(s: AsyncSession, settings: Settings, env_id: uuid.UUID, ip: str,
                        host_label: str) -> None:
    """Under the address lock (vms.lock_addresses, held until `s`'s
    transaction ends): StepFailed unless `ip` is free for this environment's
    VM."""
    proxy_ip = await s.scalar(select(Environment.proxy_ip).where(Environment.id == env_id))
    await vms.lock_addresses(s)
    try:
        taken = await vms.address_in_use(s, settings, ip, proxy_ip=proxy_ip or "",
                                         env_id=env_id)
    except vms.VmError:
        raise StepFailed(TARGETS_UNREADABLE) from None
    if taken:
        raise _address_taken(ip, host_label)


async def check_address(settings: Settings, env_id: uuid.UUID, ip: str, *,
                        host_label: str = "Proxmox") -> None:
    """Before pinning a key at the address: is it free? (A DHCP lease can
    land on an address in use.)"""
    async with get_sessionmaker()() as s:
        await _address_free(s, settings, env_id, ip, host_label)
        await s.rollback()


async def record_address(settings: Settings, model, env_id: uuid.UUID, previous: str | None,
                         ip: str, *, host_label: str = "Proxmox") -> bool:
    """Re-check the address under the lock, then write the VM's address and
    point every service at it in the same transaction. True when a service
    moved."""
    async with get_sessionmaker()() as s:
        await _address_free(s, settings, env_id, ip, host_label)
        if ip != previous:
            await s.execute(update(model).where(model.environment_id == env_id)
                            .values(ip=ip, updated_at=datetime.now(UTC)))
        result = await s.execute(update(EnvironmentService).where(
            EnvironmentService.environment_id == env_id, EnvironmentService.host_ip != ip)
            .values(host_ip=ip))
        await s.commit()
        return result.rowcount > 0


async def recorded_snapshots(env_id: uuid.UUID) -> set[str]:
    """Names of the VM snapshots Sirdar took for this environment."""
    async with get_sessionmaker()() as s:
        return set(await s.scalars(select(Deployment.vm_snapshot).where(
            Deployment.environment_id == env_id, Deployment.vm_snapshot.is_not(None),
            Deployment.mode != "vm_restore")))


async def record_vm_snapshot(deployment_id: uuid.UUID, name: str | None) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(Deployment).where(Deployment.id == deployment_id)
                        .values(vm_snapshot=name))
        await s.commit()


def to_prune(names, recorded: set[str], keep: int) -> list[str]:
    """Which snapshots to delete: only sirdar-* ones Sirdar's deployments
    recorded (a snapshot made by hand is never pruned, whatever its name),
    all but the newest `keep`."""
    ours = sorted({n for n in names if n in recorded and vms.valid_snapshot_name(n)},
                  reverse=True)
    return ours[keep:]


async def forget_pin(ip: str, actor_id: uuid.UUID | None, target_id: str) -> bool:
    async with get_sessionmaker()() as s:
        if await known_hosts.forget(s, ip, vms.VM_SSH_PORT, actor_id, target_id=target_id):
            await s.commit()
            return True
    return False


async def confirm_pin(*, ip: str, expected: str, actor_id: uuid.UUID | None, target_id: str,
                      tries: int, poll: int, sleep: Callable[[float], Awaitable[None]],
                      out: Output, how: str, mismatch: str) -> bool:
    """Pin `expected` for ip:22 with known_hosts.trust, which re-reads the live
    key and refuses a mismatch; retried while SSH isn't up. True when this run
    made the pin (there was none before)."""
    port = vms.VM_SSH_PORT
    for _ in range(tries):
        async with get_sessionmaker()() as s:
            stored = await known_hosts.lookup(s, ip, port)
            try:
                if stored is not None and stored.fingerprint_sha256 == expected:
                    await ssh.pinned_host_key(s, ip, port)
                    out(f"SSH host key {expected} is pinned.\n")
                    return False
                await known_hosts.trust(s, ip, port, expected, actor_id, target_id=target_id)
                await s.commit()
                changed = " (it changed)" if stored is not None else ""
                out(f"Pinned {ip}'s SSH host key {expected}, {how}{changed}.\n")
                return stored is None
            except (known_hosts.HostKeyChanged, ssh.HostKeyMismatch):
                raise StepFailed(mismatch) from None
            except ConnectFailed:
                pass                                  # SSH isn't up yet
        await sleep(poll)
    raise StepFailed(f"The VM didn't answer SSH at {ip} in {tries * poll // 60} minutes.")


async def settle_address(settings: Settings, *, model, env_id: uuid.UUID,
                         previous_ip: str | None, ip: str,
                         pin: Callable[[], Awaitable[bool]], actor_id: uuid.UUID | None,
                         target_id: str, out: Output, host_label: str = "Proxmox") -> None:
    """The address the VM came up at: refused at a saved SSH target's or one
    in use, its key pinned (`pin`), then recorded (re-checked under the lock)
    on the VM and every service. A pin this run made is forgotten when the
    record fails."""
    if any(cfg.host == ip for _, cfg in targets.ssh_configs(settings)):
        raise StepFailed(f"{ip} is a saved SSH target's address. Sirdar won't pin a VM's "
                         "key there.")
    await check_address(settings, env_id, ip, host_label=host_label)
    made = await pin()
    try:
        moved = await record_address(settings, model, env_id, previous_ip, ip,
                                     host_label=host_label)
    except StepFailed:
        if made:                       # don't leave a pin for an address not recorded
            await forget_pin(ip, actor_id, target_id)
        raise
    if moved:
        out(f"Every service now points at {ip}.\n")


async def resolve_ref(settings: Settings, resolve, *, env_id: uuid.UUID, git_ref: str,
                      repo_url: str, out: Output) -> str:
    """The commit `git_ref` names, resolved on the VM over its SSH connection."""
    async with get_sessionmaker()() as s:
        env = await s.get(Environment, env_id)
        try:
            cfg = await vms.host_config(s, settings, env)
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise StepFailed("Sirdar can't read the VM's SSH key. Is SIRDAR_SECRETS_KEY the "
                             "one it was made with?") from None
        if cfg is None:
            raise StepFailed("The VM has no recorded address yet. Retry from step 0.")
        try:
            sha = await resolve(cfg, s, repo_url, git_ref)
        except gitref.RefError as e:
            reason = _REF_REASONS.get(e.code, _REF_REASONS["ref_lookup_failed"])
            raise StepFailed(reason.format(ref=git_ref)) from None
        except ConnectFailed as e:
            raise StepFailed(e.reason) from None
        except (ssh.HostKeyUnknown, ssh.HostKeyMismatch):
            raise StepFailed("The VM's SSH host key changed while Sirdar was resolving the "
                             "ref. Retry from step 0.") from None
    out(f"{git_ref} is {sha}.\n")
    return sha
```

The Proxmox timeout message was `self._ssh_wait // 60`. Proxmox passes `tries = max(1, ssh_wait // poll)`, so `tries * poll // 60` gives the same minutes for the default values (300 // 5 * 5 // 60 = 5). Run the Proxmox tests: if one asserts the exact minutes at a non-default `ssh_wait`, add a `minutes` keyword to `confirm_pin` and pass `self._ssh_wait // 60` from both provisioners instead.

- [ ] **Step 4: Put `provision.py` on `vmcommon`**

In `sirdar/api/src/sirdar_api/deploy/provision.py`:

1. **Delete** these definitions, which now live in `vmcommon`:
   - `Output`, `TARGETS_UNREADABLE`, `_REF_REASONS`;
   - `class VmPrepareError`, `class VmOutcome`, `class Provisioner`;
   - `tcp_open`, `_set_vm`, `_address_taken`, `_address_free`, `_check_address`, `_record_address`, `_recorded`.
2. Add the import and re-exports, and a Proxmox-bound `_set_vm` (the pipeline tests use it):

```python
from sirdar_api.deploy import vmcommon
from sirdar_api.deploy.vmcommon import (  # noqa: F401 — re-exported for callers and tests
    Output,
    Provisioner,
    VmOutcome,
    VmPrepareError,
)


async def _set_vm(env_id: uuid.UUID, **values) -> None:
    await vmcommon.set_vm(ProxmoxVm, env_id, **values)
```

3. In `ProxmoxProvisioner._provision`, replace `probe = self._probe or tcp_open` with `probe = self._probe or vmcommon.tcp_open`, and `sha = None if ctx.sha else await self._resolve_ref(ctx, out)` with:

```python
        sha = None if ctx.sha else await vmcommon.resolve_ref(
            self._settings, self._resolve, env_id=ctx.env_id, git_ref=ctx.git_ref,
            repo_url=ctx.repo_url, out=out)
```

4. Replace `_settle_address` with:

```python
    async def _settle_address(self, api: Proxmox, ctx: VmContext, vmid: int,
                              out: Output) -> None:
        """The guest agent's address, its key pinned, then recorded on the VM
        and every service (vmcommon.settle_address)."""
        ip = await self._address(api, vmid, ctx.vm, out)
        await vmcommon.settle_address(
            self._settings, model=ProxmoxVm, env_id=ctx.env_id, previous_ip=ctx.vm.ip, ip=ip,
            pin=lambda: self._pin(api, ctx, vmid, ip, out), actor_id=ctx.actor_id,
            target_id=f"proxmox:{ctx.env_name}", out=out)
```

5. In `_pin`, keep the first loop (reading the key through the agent) and the `expected = …` parse. Replace everything from `mismatch = StepFailed(…)` to the end of the method with:

```python
        return await vmcommon.confirm_pin(
            ip=ip, expected=expected, actor_id=ctx.actor_id,
            target_id=f"proxmox:{ctx.env_name}", tries=tries, poll=self._poll,
            sleep=self._sleep, out=out, how="read through the guest agent",
            mismatch="The VM's live SSH key doesn't match the one its guest agent reports. "
                     "Sirdar pinned nothing.")
```

6. Delete `_resolve_ref`, which is now `vmcommon.resolve_ref`.
7. In `_snapshot`, replace the "Recorded at once" `async with get_sessionmaker()() as s: … update(Deployment)…` block with `await vmcommon.record_vm_snapshot(ctx.deployment_id, name)`. Then replace the pruning block, from `keep = await _recorded(ctx.env_id) | {name}` through the `for old in ours[...]` header, with:

```python
        found = [s.get("name") for s in await api.snapshots(vmid)]
        for old in vmcommon.to_prune(found, await vmcommon.recorded_snapshots(ctx.env_id) | {name},
                                     ctx.vm.keep_snapshots):
```

   Keep the loop body (`await api.delete_snapshot(vmid, old)` and its `out`).
8. In `_restore`, replace `await _recorded(ctx.env_id)` with `await vmcommon.recorded_snapshots(ctx.env_id)`.
9. In `_destroy`, replace the final `if vm.ip:` forget block with:

```python
            if vm.ip and await vmcommon.forget_pin(vm.ip, ctx.actor_id,
                                                   f"proxmox:{ctx.env_name}"):
                out(f"Forgot {vm.ip}'s SSH host key.\n")
```

10. Remove imports that are now unused. Ruff F401 lists them, probably `suppress`, `update`, `IntegrityError` only if unused (`_claim_vmid` still uses it), `ConnectFailed`, `gitref`, `ssh`, `targets` and `known_hosts`. Keep what is still used.

- [ ] **Step 5: Write `deploy/vmsteps.py` and use it in the pipeline**

Create `sirdar/api/src/sirdar_api/deploy/vmsteps.py`:

```python
"""Which VM host runs an environment's VM steps (0 Prepare VM, 0 Restore VM
snapshot, 15 Destroy VM): the one its target names. The pipeline calls
prepare() and one HostProvisioner; each host's module does the work
(provision.py for Proxmox, esxi_provision.py for ESXi)."""

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment
from sirdar_api.deploy import provision, targets
from sirdar_api.deploy.vmcommon import Output, Provisioner, VmOutcome, VmPrepareError

VmContext = provision.VmContext


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> VmContext:
    if env.target_id == targets.PROXMOX_TARGET:
        return await provision.prepare(db, env, dep, settings)
    raise VmPrepareError("This environment isn't on a VM host, so it has no VM steps.")


class HostProvisioner:
    """Runs a VM step on the host its context belongs to."""

    def __init__(self, *, proxmox: Provisioner, esxi: Provisioner | None = None):
        self._proxmox = proxmox
        self._esxi = esxi

    async def run(self, step: str, ctx, out: Output) -> VmOutcome:
        return await self._proxmox.run(step, ctx, out)
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`:
- add `vmsteps` to the `from sirdar_api.deploy import (...)` list;
- module docstring: "A Proxmox environment's deployment (vm) adds the VM steps" → "A VM environment's deployment (vm; on Proxmox or ESXi) adds the VM steps";
- `make_provisioner` becomes:

```python
def make_provisioner(settings: Settings) -> provision.Provisioner:
    """What runs a VM environment's VM steps (tests replace this function)."""
    return vmsteps.HostProvisioner(
        proxmox=provision.ProxmoxProvisioner(terraform_runner=make_terraform(settings),
                                             settings=settings))
```

- in `_Context`: `# Steps 0 and 15 of a VM environment: its VM and the host's credentials.` and `vm: vmsteps.VmContext | None = field(default=None, repr=False)`;
- in `_prepare`: `if cfg is None and targets.is_vm_target(env.target_id):`;
- in the run loop: `vm_ctx = (await vmsteps.prepare(db, env, dep, settings) if "vm" in runs else None)` and `except (PrepareError, publish.PublishError, vmsteps.VmPrepareError) as e:`.

In `sirdar/api/tests/conftest.py` (`no_real_hosts`):
- import `vmcommon` in place of `provision` (`from sirdar_api.deploy import esxi, terraform, tls_pin, vmcommon`);
- replace `mp.setattr(provision, "tcp_open", probe)` with `mp.setattr(vmcommon, "tcp_open", probe)`;
- docstring "the provisioner's port probe" → "the provisioners' port probe (vmcommon.tcp_open)".

- [ ] **Step 6: Run the new tests and every phase 5 suite**

Run:

```bash
SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_vmcommon.py tests/test_deploy_provision.py tests/test_deploy_pipeline_vm.py tests/test_deploy_vm_steps.py tests/test_deploy_vm_api.py tests/test_deploy_pipeline.py
```

Expected: all pass. A failure means a message or an order changed: put back exactly what `provision.py` did.

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/vmcommon.py src/sirdar_api/deploy/vmsteps.py src/sirdar_api/deploy/provision.py src/sirdar_api/deploy/pipeline.py tests/conftest.py tests/test_deploy_vmcommon.py tests/test_deploy_provision.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/vmcommon.py sirdar/api/src/sirdar_api/deploy/vmsteps.py sirdar/api/src/sirdar_api/deploy/provision.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_vmcommon.py sirdar/api/tests/test_deploy_provision.py
git commit -m "refactor(sirdar): the VM-host-neutral half of the VM steps moves to vmcommon, vmsteps dispatches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The ESXi provisioner — Prepare VM, Restore VM snapshot, Destroy VM

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/esxi_provision.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/vmsteps.py`, `sirdar/api/src/sirdar_api/deploy/pipeline.py` (`make_provisioner`)
- Test: create `sirdar/api/tests/test_deploy_esxi_provision.py`; append to `sirdar/api/tests/test_deploy_pipeline_vm.py`

**Interfaces:**
- Consumes:
  - `esxi.connect`, `EsxiApi`, `CreateSpec`, `OWNER_KEY`, `disk_path_for`, `EsxiError`, `QuiesceFailed` (Task 3);
  - `cloudinit` (Task 5);
  - `vms.get_for`, `static_ip`, `snapshot_name`, `valid_snapshot_name`, `VM_SSH_PORT` (Task 6);
  - all of `vmcommon` (Task 7).
- Produces (`esxi_provision`):
  - `EsxiVmState`, which includes `host_key_private` (repr=False) and the property `host_fingerprint`;
  - `EsxiVmContext(..., vm, esxi: EsxiConfig)` with `secret_values`;
  - `async prepare(db, env, dep, settings) -> EsxiVmContext`;
  - `EsxiProvisioner(*, settings, sleep, probe, resolve, now, tools_wait, ssh_wait, shutdown_wait, poll)` with `run(step, ctx, out) -> VmOutcome`.
- `vmsteps.VmContext` becomes `provision.VmContext | esxi_provision.EsxiVmContext`. `HostProvisioner` sends an `EsxiVmContext` to `esxi`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_esxi_provision.py`:

```python
import base64
import uuid
from datetime import UTC, datetime

import pytest
import yaml
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, EnvironmentService, EsxiVm, Integration
from sirdar_api.deploy import esxi, esxi_provision, known_hosts, vms
from sirdar_api.deploy.esxi import EsxiError, SnapshotInfo
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.vmcommon import VmPrepareError

from .deploy_factories import secrets_key  # noqa: F401
from .esxi_helpers import esxi_fake  # noqa: F401
from .fake_esxi import SEED_DISK
from .integration_helpers import ESXI_PASSWORD, configure_esxi
from .proxmox_helpers import no_sleep
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .vm_helpers import make_esxi_environment

SHA = "e73b99ca" + "0" * 32
NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=UTC)
SNAP = "sirdar-20261005T120000Z"
DISK = "[datastore1] ss-uat3/ss-uat3-disk0.vmdk"


@pytest.fixture
async def esxi_env(db, deploy_env, secrets_key, ssh_server, esxi_fake, monkeypatch):
    """uat3 on ESXi; the tests' SSH server plays its VM at 127.0.0.1 with the
    host key Sirdar 'generated' (the server's own)."""
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    return await make_esxi_environment(db, host_key=ssh_server.host_key)


async def nothing_answers(host, port):
    return False


def resolves_to(sha):
    async def resolve(cfg, db, repo_url, ref):
        return sha
    return resolve


def provisioner(**kw):
    kw.setdefault("probe", nothing_answers)
    kw.setdefault("resolve", resolves_to(SHA))
    for key, value in (("poll", 1), ("tools_wait", 3), ("ssh_wait", 3), ("shutdown_wait", 3)):
        kw.setdefault(key, value)
    return esxi_provision.EsxiProvisioner(settings=get_settings(), sleep=no_sleep,
                                          now=lambda: NOW, **kw)


async def ctx_for(db, env, *, mode="update", sha="", take=False, vm_snapshot=None):
    dep = Deployment(id=uuid.uuid4(), environment_id=env.id, mode=mode, git_ref="main",
                     sha=sha, status="succeeded", start_step=0, vm=True,
                     take_vm_snapshot=take, vm_snapshot=vm_snapshot)
    db.add(dep)
    await db.commit()
    return await esxi_provision.prepare(db, env, dep, get_settings())


async def run(db, env, step="provision", lines=None, **ctx_kw):
    out = lines if lines is not None else []
    return await provisioner().run(step, await ctx_for(db, env, **ctx_kw), out.append)


async def row(db, env) -> EsxiVm:
    return await db.get(EsxiVm, env.id, populate_existing=True)


async def test_prepare_needs_the_integration(db, esxi_env):
    await db.execute(Integration.__table__.delete().where(Integration.kind == "esxi"))
    await db.commit()
    with pytest.raises(VmPrepareError) as e:
        await ctx_for(db, esxi_env)
    assert "VMware ESXi isn't set up" in e.value.reason


async def test_the_first_run_builds_the_vm_and_pins_the_generated_key(db, esxi_env, esxi_fake,
                                                                       ssh_server):
    lines: list[str] = []
    outcome = await run(db, esxi_env, lines=lines)
    assert outcome.sha == SHA
    [spec] = esxi_fake.specs
    assert (spec.name, spec.datastore, spec.network, spec.cores, spec.memory_mb) == (
        "ss-uat3", "datastore1", "VM Network", 4, 8192)
    assert spec.extra_config[esxi.OWNER_KEY] == str(esxi_env.id)
    assert spec.annotation.startswith(f"sirdar:{esxi_env.id}\n")
    user = yaml.safe_load(base64.b64decode(spec.extra_config["guestinfo.userdata"]))
    assert user["ssh_keys"]["ed25519_public"] == ssh_server.host_key.export_public_key(
        "openssh").decode().strip()
    vm = esxi_fake.by_name("ss-uat3")
    assert [d.path for d in vm.disks] == [DISK] and vm.disks[0].capacity_gb == 64
    assert vm.power_state == "poweredOn"
    assert "guestinfo.userdata" not in vm.extra and "guestinfo.metadata" in vm.extra
    record = await row(db, esxi_env)
    assert (record.moref, record.instance_uuid, record.vm_path, record.created, record.ip,
            record.host_key_private_enc) == (
        vm.moref, vm.instance_uuid, "[datastore1] ss-uat3/ss-uat3.vmx", True, "127.0.0.1", None)
    pinned = await known_hosts.lookup(db, "127.0.0.1", ssh_server.port)
    assert pinned.fingerprint_sha256 == ssh_server.fingerprint
    hosts = set(await db.scalars(select(EnvironmentService.host_ip).where(
        EnvironmentService.environment_id == esxi_env.id)))
    assert hosts == {"127.0.0.1"}
    log = "".join(lines)
    assert "PRIVATE KEY" not in log and ESXI_PASSWORD not in log
    assert SEED_DISK in esxi_fake.files                  # the seed is copied, never moved


async def test_a_second_run_changes_nothing_and_keeps_the_pin(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    esxi_fake.calls.clear()
    lines: list[str] = []
    await run(db, esxi_env, lines=lines)
    assert "create_vm" not in esxi_fake.calls and "copy_disk" not in esxi_fake.calls
    assert "set_size" not in esxi_fake.calls and "is pinned" in "".join(lines)


async def test_a_lost_record_is_found_by_its_marker(db, esxi_env, esxi_fake):
    lost = esxi_fake.add_vm("ss-uat3", owner=str(esxi_env.id), power_state="poweredOff")
    await run(db, esxi_env)
    assert "create_vm" not in esxi_fake.calls
    assert (await row(db, esxi_env)).instance_uuid == lost.instance_uuid


async def test_a_vm_with_the_name_but_not_the_marker_is_never_touched(db, esxi_env, esxi_fake):
    foreign = esxi_fake.add_vm("ss-uat3", owner="", power_state="poweredOn")
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "isn't this environment's" in e.value.reason
    assert foreign.power_state == "poweredOn" and "create_vm" not in esxi_fake.calls
    assert (await row(db, esxi_env)).instance_uuid is None


async def test_a_busy_static_address_stops_before_anything_is_made(db, esxi_env, esxi_fake):
    async def answers(host, port):
        return True
    with pytest.raises(StepFailed) as e:
        await provisioner(probe=answers).run("provision", await ctx_for(db, esxi_env),
                                             lambda _: None)
    assert "already answers SSH" in e.value.reason and esxi_fake.specs == []


async def test_a_half_copied_disk_is_replaced(db, esxi_env, esxi_fake):
    esxi_fake.fail["attach_disk"] = EsxiError("ESXi couldn't attach the disk (x).")
    with pytest.raises(StepFailed):
        await run(db, esxi_env)
    assert DISK in esxi_fake.files and not esxi_fake.by_name("ss-uat3").disks
    del esxi_fake.fail["attach_disk"]
    await run(db, esxi_env)
    assert esxi_fake.calls.count("copy_disk") == 2 and "delete_disk" in esxi_fake.calls
    assert esxi_fake.by_name("ss-uat3").disks[0].path == DISK


async def test_a_created_vm_someone_changed_is_refused(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.owner = ""
    esxi_fake.calls.clear()
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "changed nothing" in e.value.reason
    assert not {"power_on", "power_off", "set_size", "take_snapshot"} & set(esxi_fake.calls)


async def test_a_created_vm_that_is_gone_is_not_rebuilt(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.power_state = "poweredOff"
    await esxi_fake.destroy(vm.instance_uuid)
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "won't build a new one silently" in e.value.reason


async def test_a_half_built_vm_that_is_gone_is_built_again(db, esxi_env, esxi_fake):
    esxi_fake.fail["copy_disk"] = EsxiError("ESXi couldn't copy the seed disk (x).")
    with pytest.raises(StepFailed):
        await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    await esxi_fake.destroy(vm.instance_uuid)
    del esxi_fake.fail["copy_disk"]
    await run(db, esxi_env)
    assert (await row(db, esxi_env)).created and len(esxi_fake.specs) == 2


async def test_cpu_and_memory_change_with_a_shutdown_after_the_snapshot(db, esxi_env,
                                                                        esxi_fake):
    await run(db, esxi_env)
    record = await row(db, esxi_env)
    record.cores, record.memory_mb = 6, 12288
    await db.commit()
    esxi_fake.calls.clear()
    outcome = await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    assert (vm.cores, vm.memory_mb, vm.power_state) == (6, 12288, "poweredOn")
    calls = esxi_fake.calls
    assert calls.index("take_snapshot") < calls.index("shutdown_guest") < calls.index(
        "set_size") < calls.index("power_on")
    assert outcome.vm_snapshot == SNAP


async def test_a_disk_grow_deletes_sirdar_s_snapshots_then_snapshots_again(db, esxi_env,
                                                                           esxi_fake):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)                  # SNAP, recorded
    record = await row(db, esxi_env)
    record.disk_gb = 80
    await db.commit()
    lines: list[str] = []
    outcome = await run(db, esxi_env, take=True, lines=lines)
    vm = esxi_fake.by_name("ss-uat3")
    assert vm.disks[0].capacity_gb == 80
    assert [s.name for s in vm.snapshots] == [SNAP] and outcome.vm_snapshot == SNAP
    assert "ESXi can't grow a disk that has snapshots" in "".join(lines)


async def test_a_hand_made_snapshot_blocks_a_disk_grow(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.snapshots.append(SnapshotInfo(999, "before upgrade", "", None))
    record = await row(db, esxi_env)
    record.disk_gb = 80
    await db.commit()
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "before upgrade" in e.value.reason
    assert vm.disks[0].capacity_gb == 64 and len(vm.snapshots) == 1


async def test_a_guest_that_won_t_shut_down_isn_t_resized(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    record = await row(db, esxi_env)
    record.cores = 6
    await db.commit()
    esxi_fake.shutdown_stalls = True
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "didn't shut down" in e.value.reason and "set_size" not in esxi_fake.calls


async def test_snapshots_quiesce_fall_back_and_prune_only_sirdar_s(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    old = ["sirdar-20261001T000000Z", "sirdar-20261002T000000Z", "sirdar-20261003T000000Z"]
    for name in old:
        vm.snapshots.append(SnapshotInfo(len(vm.snapshots) + 100, name, "", None))
        db.add(Deployment(environment_id=esxi_env.id, mode="update", git_ref="main", sha=SHA,
                          status="succeeded", start_step=0, vm=True, vm_snapshot=name))
    vm.snapshots.append(SnapshotInfo(500, "sirdar-20200101T000000Z", "by hand", None))
    await db.commit()
    esxi_fake.quiesce_fails = True
    lines: list[str] = []
    await run(db, esxi_env, take=True, lines=lines)
    names = {s.name for s in vm.snapshots}
    assert names == {SNAP, old[2], old[1], "sirdar-20200101T000000Z"}
    assert "crash-consistent" in "".join(lines)


async def test_a_retry_keeps_the_first_attempt_s_snapshot_only_while_it_exists(db, esxi_env,
                                                                               esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.snapshots.append(SnapshotInfo(77, "sirdar-20261004T000000Z", "", None))
    esxi_fake.calls.clear()
    outcome = await run(db, esxi_env, take=True, vm_snapshot="sirdar-20261004T000000Z")
    assert outcome.vm_snapshot == "sirdar-20261004T000000Z"
    assert "take_snapshot" not in esxi_fake.calls
    vm.snapshots.clear()
    outcome = await run(db, esxi_env, take=True, vm_snapshot="sirdar-20261004T000000Z")
    assert outcome.vm_snapshot == SNAP


async def test_a_failed_snapshot_task_clears_its_record(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    esxi_fake.fail["take_snapshot"] = EsxiError("ESXi couldn't take a VM snapshot (x).")
    ctx = await ctx_for(db, esxi_env, take=True)
    with pytest.raises(StepFailed):
        await provisioner().run("provision", ctx, lambda _: None)
    dep = await db.get(Deployment, ctx.deployment_id, populate_existing=True)
    assert dep.vm_snapshot is None


async def test_a_live_key_that_isn_t_the_generated_one(db, deploy_env, secrets_key, ssh_server,
                                                       esxi_fake, monkeypatch):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    env = await make_esxi_environment(db)                       # a different host key
    with pytest.raises(StepFailed) as e:
        await run(db, env)
    assert "isn't the one Sirdar generated" in e.value.reason
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is None


async def test_restore_a_vm_snapshot(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)
    lines: list[str] = []
    await run(db, esxi_env, step="vm_restore", mode="vm_restore", sha=SHA, vm_snapshot=SNAP,
              lines=lines)
    assert "revert_snapshot" in esxi_fake.calls
    assert esxi_fake.by_name("ss-uat3").power_state == "poweredOn"
    assert f"back at {SNAP}" in "".join(lines)


@pytest.mark.parametrize("problem", ["unrecorded", "twice", "gone"])
async def test_restore_refuses(db, esxi_env, esxi_fake, problem):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    name = SNAP
    if problem == "unrecorded":
        name = "sirdar-20261001T000000Z"
        vm.snapshots.append(SnapshotInfo(5, name, "", None))
    elif problem == "twice":
        vm.snapshots.append(SnapshotInfo(6, SNAP, "", None))
    else:
        vm.snapshots.clear()
    with pytest.raises(StepFailed):
        await run(db, esxi_env, step="vm_restore", mode="vm_restore", sha=SHA, vm_snapshot=name)
    assert "revert_snapshot" not in esxi_fake.calls


async def test_destroy_removes_only_sirdar_s_vm(db, esxi_env, esxi_fake, ssh_server):
    await run(db, esxi_env)
    other = esxi_fake.add_vm("uat", power_state="poweredOn")
    lines: list[str] = []
    await run(db, esxi_env, step="destroy", mode="teardown", lines=lines)
    assert esxi_fake.by_name("ss-uat3") is None and esxi_fake.by_name("uat") is other
    assert "power_off" in esxi_fake.calls
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is None


async def test_destroy_refuses_a_vm_without_the_marker(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    esxi_fake.by_name("ss-uat3").owner = ""
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env, step="destroy", mode="teardown")
    assert "isn't the VM Sirdar made" in e.value.reason
    assert esxi_fake.by_name("ss-uat3") is not None


async def test_destroy_finds_a_vm_from_an_unfinished_create(db, esxi_env, esxi_fake):
    esxi_fake.add_vm("ss-uat3", owner=str(esxi_env.id), power_state="poweredOff")
    await run(db, esxi_env, step="destroy", mode="teardown")
    assert esxi_fake.by_name("ss-uat3") is None


async def test_destroy_with_nothing_built(db, esxi_env, esxi_fake):
    foreign = esxi_fake.add_vm("ss-uat3", owner="", power_state="poweredOn")
    lines: list[str] = []
    await run(db, esxi_env, step="destroy", mode="teardown", lines=lines)
    assert "never created a VM" in "".join(lines) and esxi_fake.by_name("ss-uat3") is foreign


async def test_esxi_errors_end_as_our_copy(db, esxi_env, esxi_fake):
    esxi_fake.fail["connect"] = EsxiError("ESXi rejected the user name or password.")
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert e.value.reason == "ESXi rejected the user name or password."


async def test_the_context_hides_its_secrets(db, esxi_env):
    ctx = await ctx_for(db, esxi_env)
    assert ESXI_PASSWORD in ctx.secret_values
    assert any("PRIVATE KEY" in v for v in ctx.secret_values)
    assert ESXI_PASSWORD not in repr(ctx) and "PRIVATE KEY" not in repr(ctx)
```

Append to `sirdar/api/tests/test_deploy_pipeline_vm.py` a test that shows the pipeline dispatches an ESXi environment to `vmsteps`. Mirror the module's existing "update plan with step 0" test:
- the `esxi_env`-style setup is `configure_esxi`, then `make_esxi_environment`;
- the fake provisioner is installed through `pipeline.make_provisioner` exactly as that file already does;
- the assertion is that the recorded context is an `esxi_provision.EsxiVmContext`, and that the plan's first step is 0 `provision`.

Copy the shape of the nearest existing test in that file rather than inventing fixtures.

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_provision.py`
Expected: FAIL with `ImportError: cannot import name 'esxi_provision'`.

- [ ] **Step 3: Write `deploy/esxi_provision.py`**

```python
"""Steps 0 and 15 of an ESXi environment (deploy phase 6), run in Sirdar:
Prepare VM ("provision"), Restore VM snapshot ("vm_restore") and Destroy VM
("destroy"), on a standalone ESXi host through esxi.connect.

Sirdar manages only the VM its esxi_vms row names, identified by instance
UUID, name and the sirdar.environment extraConfig marker together. The
marker is written with the VM itself and the VM is recorded the moment ESXi
creates it, so a later failure (or a lost record: the marker finds it again)
still knows what exists.

The VM's SSH host key is one Sirdar generated and delivered through
cloud-init. known_hosts.trust checks it against the live server; then the
user-data holding its private half is scrubbed from the VM's settings and
from esxi_vms. Failures raise publish.StepFailed with our own copy."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime

import asyncssh
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment, EsxiVm
from sirdar_api.deploy import (
    cloudinit,
    esxi,
    gitref,
    integrations,
    known_hosts,
    vault,
    vmcommon,
    vms,
)
from sirdar_api.deploy.esxi import EsxiApi, EsxiError, QuiesceFailed, VmInfo
from sirdar_api.deploy.integrations import EsxiConfig, IntegrationError
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.vmcommon import Output, VmOutcome, VmPrepareError

TOOLS_WAIT_SECONDS = 5 * 60
SSH_WAIT_SECONDS = 5 * 60
SHUTDOWN_WAIT_SECONDS = 5 * 60
POLL_SECONDS = 5
HOST_LABEL = "ESXi"


@dataclass(frozen=True)
class EsxiVmState:
    """The esxi_vms row when the run started (the host key's private half
    decrypted, only while it hasn't been delivered)."""
    name: str
    host: str
    datastore: str
    network: str
    resource_pool: str | None
    source_vm: str
    dns_servers: tuple[str, ...]
    moref: str | None
    instance_uuid: str | None
    vm_path: str | None
    cores: int
    memory_mb: int
    disk_gb: int
    ip_mode: str
    ip_cidr: str | None
    gateway: str | None
    ip: str | None
    ssh_public_key: str
    host_key_public: str
    keep_snapshots: int
    created: bool
    host_key_private: str | None = field(default=None, repr=False)

    @classmethod
    def of(cls, row: EsxiVm, host_key_private: str | None) -> "EsxiVmState":
        return cls(name=row.name, host=row.host, datastore=row.datastore, network=row.network,
                   resource_pool=row.resource_pool, source_vm=row.source_vm,
                   dns_servers=tuple(row.dns_servers or ()), moref=row.moref,
                   instance_uuid=row.instance_uuid, vm_path=row.vm_path, cores=row.cores,
                   memory_mb=row.memory_mb, disk_gb=row.disk_gb, ip_mode=row.ip_mode,
                   ip_cidr=row.ip_cidr, gateway=row.gateway, ip=row.ip,
                   ssh_public_key=row.ssh_public_key, host_key_public=row.host_key_public,
                   keep_snapshots=row.keep_snapshots, created=row.created,
                   host_key_private=host_key_private)

    @property
    def static_ip(self) -> str | None:
        return vms.static_ip(self.ip_cidr)

    @property
    def host_fingerprint(self) -> str:
        return known_hosts.fingerprint(asyncssh.import_public_key(self.host_key_public))


@dataclass(frozen=True)
class EsxiVmContext:
    env_id: uuid.UUID
    env_name: str
    deployment_id: uuid.UUID
    actor_id: uuid.UUID | None
    mode: str
    git_ref: str
    sha: str                       # "" until step 0 resolves git_ref on the VM
    repo_url: str
    take_snapshot: bool
    vm_snapshot: str | None
    vm: EsxiVmState
    esxi: EsxiConfig = field(repr=False)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        return [v for v in (self.esxi.password, self.vm.host_key_private) if v]


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> EsxiVmContext:
    try:
        cfg = await integrations.load_esxi(db, settings)
    except IntegrationError as e:
        raise VmPrepareError(e.reason) from None
    if cfg is None:
        raise VmPrepareError("VMware ESXi isn't set up. Add it in Settings › Integrations, "
                             "then retry.")
    row = await vms.get_for(db, env)
    if not isinstance(row, EsxiVm):
        raise VmPrepareError("This environment has no VM record, so Sirdar won't build or "
                             "remove a VM for it.")
    private = None
    if row.host_key_private_enc is not None:
        try:
            private = vault.decrypt(settings, row.host_key_private_enc)
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise VmPrepareError("Sirdar can't read the VM's host key with the current "
                                 "SIRDAR_SECRETS_KEY.") from None
    return EsxiVmContext(env_id=env.id, env_name=env.name, deployment_id=dep.id,
                         actor_id=dep.actor_id, mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         repo_url=settings.deploy_repo_url, take_snapshot=dep.take_vm_snapshot,
                         vm_snapshot=dep.vm_snapshot, vm=EsxiVmState.of(row, private),
                         esxi=cfg)


def _annotation(ctx: EsxiVmContext) -> str:
    return (f"sirdar:{ctx.env_id}\nBuilt by Sirdar for the environment {ctx.env_name}. Sirdar "
            "destroys this VM when the environment is deleted; don't change it by hand.")


class EsxiProvisioner:
    """The real ESXi provisioner. Waits, the clock, the port probe and the
    ref lookup are injectable for tests."""

    STEPS = ("provision", "vm_restore", "destroy")

    def __init__(self, *, settings: Settings,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 probe: Callable[[str, int], Awaitable[bool]] | None = None,
                 resolve=None, now: Callable[[], datetime] | None = None,
                 tools_wait: int = TOOLS_WAIT_SECONDS, ssh_wait: int = SSH_WAIT_SECONDS,
                 shutdown_wait: int = SHUTDOWN_WAIT_SECONDS, poll: int = POLL_SECONDS):
        self._settings = settings
        self._sleep = sleep
        self._probe = probe
        self._resolve = resolve or gitref.resolve_ref
        self._now = now or (lambda: datetime.now(UTC))
        self._tools_wait = tools_wait
        self._ssh_wait = ssh_wait
        self._shutdown_wait = shutdown_wait
        self._poll = poll

    async def run(self, step: str, ctx: EsxiVmContext, out: Output) -> VmOutcome:
        if step not in self.STEPS:
            raise ValueError(f"{step!r} isn't a VM step")
        try:
            async with esxi.connect(ctx.esxi) as api:
                if step == "provision":
                    return await self._provision(api, ctx, out)
                if step == "vm_restore":
                    await self._restore(api, ctx, out)
                else:
                    await self._destroy(api, ctx, out)
                return VmOutcome()
        except EsxiError as e:
            raise StepFailed(e.reason) from None

    # ---- identity ---------------------------------------------------------------------

    async def _identify(self, api: EsxiApi, ctx: EsxiVmContext, uuid_: str) -> VmInfo | None:
        """The recorded VM, None when ESXi no longer has it. A VM there that
        isn't named vm.name or lacks this environment's marker is refused."""
        found = await api.find_vm(uuid_)
        if found is None:
            return None
        if found.name != ctx.vm.name or found.owner != str(ctx.env_id):
            raise StepFailed(f"The VM Sirdar recorded for {ctx.env_name} isn't {ctx.vm.name} "
                             "with this environment's marker any more; Sirdar changed nothing.")
        return found

    async def _record(self, ctx: EsxiVmContext, info: VmInfo) -> None:
        await vmcommon.set_vm(EsxiVm, ctx.env_id, moref=info.moref,
                              instance_uuid=info.instance_uuid, vm_path=info.vm_path)

    async def _lost_vm(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> VmInfo | None:
        """A VM named vm.name: this environment's (its marker) from a create
        whose record was lost, adopted; anyone else's, refused."""
        found = await api.find_vm_by_name(ctx.vm.name)
        if found is None:
            return None
        if found.owner != str(ctx.env_id):
            raise StepFailed(f"ESXi already has a VM named {ctx.vm.name} that isn't this "
                             "environment's. Sirdar changed nothing: rename or remove that VM "
                             "by hand, or delete this environment.")
        await self._record(ctx, found)
        out(f"Found {ctx.vm.name} from an earlier attempt (it carries this environment's "
            "marker).\n")
        return found

    def _check_disk(self, info: VmInfo, ctx: EsxiVmContext) -> None:
        try:
            path = esxi.disk_path_for(info.vm_path, ctx.vm.name)
        except ValueError:
            raise StepFailed(f"ESXi keeps {ctx.vm.name} at {info.vm_path}, a path Sirdar "
                             "doesn't understand. Sirdar changed nothing.") from None
        if len(info.disks) != 1 or info.disks[0].path != path:
            raise StepFailed(f"{ctx.vm.name} has a disk Sirdar didn't put there. Sirdar "
                             "changed nothing: fix the VM by hand, then retry.")

    # ---- Prepare VM -------------------------------------------------------------------

    async def _provision(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> VmOutcome:
        vm = ctx.vm
        info: VmInfo | None = None
        if vm.instance_uuid is not None:
            info = await self._identify(api, ctx, vm.instance_uuid)
            if info is None and vm.created:
                raise StepFailed(f"The VM Sirdar made for {ctx.env_name} ({vm.name}) is gone "
                                 "from ESXi. Sirdar won't build a new one silently: delete the "
                                 "environment, or fix it by hand, then retry.")
            if info is None:
                out(f"The half-built {vm.name} is gone from ESXi; building it again.\n")
                await vmcommon.set_vm(EsxiVm, ctx.env_id, moref=None, instance_uuid=None,
                                      vm_path=None)
        if info is None:
            info = await self._lost_vm(api, ctx, out) or await self._create(api, ctx, out)
        uuid_ = info.instance_uuid
        snapshot: str | None = None
        if vm.created:
            self._check_disk(info, ctx)
            grows = vm.disk_gb > info.disk_gb
            if not grows:
                # Before anything changes: the snapshot holds the VM as it was.
                snapshot = await self._snapshot(api, ctx, uuid_, out)
            await self._resize(api, ctx, info, grows, out)
            if grows:
                # ESXi can't grow a disk with snapshots: the new one comes after.
                snapshot = await self._snapshot(api, ctx, uuid_, out)
        else:
            await self._build(api, ctx, info, out)
        await self._start(api, uuid_, out)
        ip = await self._address(api, uuid_, out, vm)
        await vmcommon.settle_address(
            self._settings, model=EsxiVm, env_id=ctx.env_id, previous_ip=vm.ip, ip=ip,
            pin=lambda: self._pin(ctx, ip, out), actor_id=ctx.actor_id,
            target_id=f"esxi:{ctx.env_name}", out=out, host_label=HOST_LABEL)
        await self._scrub(api, ctx, uuid_, out)
        if not vm.created:
            await vmcommon.set_vm(EsxiVm, ctx.env_id, created=True)
            # A VM built just now had nothing before: still before step 1.
            snapshot = await self._snapshot(api, ctx, uuid_, out)
        sha = None if ctx.sha else await vmcommon.resolve_ref(
            self._settings, self._resolve, env_id=ctx.env_id, git_ref=ctx.git_ref,
            repo_url=ctx.repo_url, out=out)
        return VmOutcome(sha=sha, vm_snapshot=snapshot)

    async def _create(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> VmInfo:
        vm = ctx.vm
        probe = self._probe or vmcommon.tcp_open
        if vm.static_ip and await probe(vm.static_ip, vms.VM_SSH_PORT):
            raise StepFailed(f"Something already answers SSH at {vm.static_ip}, so Sirdar "
                             "won't give that address to a new VM. Free it, or delete this "
                             "environment and create it with another address.")
        if not vm.host_key_private:
            raise StepFailed(f"Sirdar no longer has the host key it made for {vm.name}, so it "
                             "can't build the VM. Delete this environment and create it again.")
        meta = cloudinit.metadata(env_id=ctx.env_id, hostname=vm.name, ip_cidr=vm.ip_cidr,
                                  gateway=vm.gateway, dns_servers=vm.dns_servers)
        user = cloudinit.userdata(hostname=vm.name, ssh_public_key=vm.ssh_public_key,
                                  host_key_private=vm.host_key_private,
                                  host_key_public=vm.host_key_public)
        spec = esxi.CreateSpec(
            name=vm.name, datastore=vm.datastore, network=vm.network,
            resource_pool=vm.resource_pool, cores=vm.cores, memory_mb=vm.memory_mb,
            annotation=_annotation(ctx),
            extra_config={esxi.OWNER_KEY: str(ctx.env_id), **cloudinit.guestinfo(meta, user)})
        out(f"Creating {vm.name} ({vm.cores} vCPU, {vm.memory_mb / 1024:g} GB) on "
            f"{vm.datastore}.\n")
        info = await api.create_vm(spec)
        await self._record(ctx, info)       # at once: a later failure still knows it exists
        out(f"Created {vm.name} (VM {info.moref}).\n")
        return info

    async def _seed_disk(self, api: EsxiApi, ctx: EsxiVmContext) -> str:
        seed = await api.find_vm_by_name(ctx.vm.source_vm)
        if (seed is None or seed.power_state != "poweredOff" or len(seed.disks) != 1
                or seed.snapshot_count):
            raise StepFailed(f"The seed VM {ctx.vm.source_vm} can't be copied: it must exist, "
                             "be powered off, and have one disk and no snapshots. Run Test in "
                             "Settings › Integrations › VMware ESXi.")
        return seed.disks[0].path

    async def _build(self, api: EsxiApi, ctx: EsxiVmContext, info: VmInfo,
                     out: Output) -> None:
        """The seed disk copied into the VM's own folder, attached, grown."""
        vm, uuid_ = ctx.vm, info.instance_uuid
        try:
            path = esxi.disk_path_for(info.vm_path, vm.name)
        except ValueError:
            raise StepFailed(f"ESXi keeps {vm.name} at {info.vm_path}, a path Sirdar doesn't "
                             "understand. Remove the VM by hand, then retry.") from None
        if not info.disks:
            if await api.file_exists(path):
                # Only this exact path, inside the VM's own folder, never attached.
                await api.delete_disk(path)
                out(f"Removed the half-copied disk {path} from an earlier attempt.\n")
            seed = await self._seed_disk(api, ctx)
            out(f"Copying the seed disk {seed} to {path}.\n")
            await api.copy_disk(seed, path)
            await api.attach_disk(uuid_, path)
            info = await self._identify(api, ctx, uuid_)
            if info is None:
                raise StepFailed(f"{vm.name} disappeared from ESXi while Sirdar built it.")
        self._check_disk(info, ctx)
        if info.disk_gb < vm.disk_gb:
            await api.grow_disk(uuid_, info.disks[0].key, vm.disk_gb)
            out(f"Grew the disk to {vm.disk_gb} GB.\n")

    async def _resize(self, api: EsxiApi, ctx: EsxiVmContext, info: VmInfo, grows: bool,
                      out: Output) -> None:
        vm, uuid_ = ctx.vm, info.instance_uuid
        if info.disk_gb > vm.disk_gb:
            out(f"The disk is {info.disk_gb} GB, more than the {vm.disk_gb} GB recorded; "
                "Sirdar never shrinks a disk.\n")
        resize = (info.cores, info.memory_mb) != (vm.cores, vm.memory_mb)
        if not resize and not grows:
            return
        if grows:
            await self._drop_snapshots_for_grow(api, ctx, uuid_, out)
        if info.power_state != "poweredOff":
            await self._shut_down(api, uuid_, out)
        if resize:
            await api.set_size(uuid_, vm.cores, vm.memory_mb)
            out(f"Set {vm.name} to {vm.cores} vCPU and {vm.memory_mb / 1024:g} GB.\n")
        if grows:
            await api.grow_disk(uuid_, info.disks[0].key, vm.disk_gb)
            out(f"Grew the disk from {info.disk_gb} GB to {vm.disk_gb} GB; the guest grows its "
                "file system when it boots.\n")

    async def _drop_snapshots_for_grow(self, api: EsxiApi, ctx: EsxiVmContext, uuid_: str,
                                       out: Output) -> None:
        snaps = await api.snapshots(uuid_)
        recorded = await vmcommon.recorded_snapshots(ctx.env_id)
        foreign = sorted({s.name for s in snaps
                          if s.name not in recorded or not vms.valid_snapshot_name(s.name)})
        if foreign:
            raise StepFailed(f"ESXi can't grow a disk that has snapshots, and "
                             f"{', '.join(foreign)} weren't taken by Sirdar, so it won't delete "
                             "them. Delete them in the ESXi Host Client, then retry.")
        for snap in snaps:
            await api.delete_snapshot(uuid_, snap.id)
            out(f"Deleted the VM snapshot {snap.name}: ESXi can't grow a disk that has "
                "snapshots.\n")

    async def _shut_down(self, api: EsxiApi, uuid_: str, out: Output) -> None:
        out("Shutting the guest down to resize the VM.\n")
        await api.shutdown_guest(uuid_)
        for _ in range(max(1, self._shutdown_wait // self._poll)):
            info = await api.find_vm(uuid_)
            if info is not None and info.power_state == "poweredOff":
                return
            await self._sleep(self._poll)
        raise StepFailed(f"The guest didn't shut down in {self._shutdown_wait // 60} minutes, "
                         "so Sirdar didn't resize it. Check the VM in the ESXi Host Client, "
                         "then retry.")

    async def _start(self, api: EsxiApi, uuid_: str, out: Output) -> None:
        info = await api.find_vm(uuid_)
        if info is not None and info.power_state != "poweredOn":
            await api.power_on(uuid_)
            out("Started the VM.\n")

    async def _address(self, api: EsxiApi, uuid_: str, out: Output, vm: EsxiVmState) -> str:
        out("Waiting for VMware Tools to report the VM's address.\n")
        ips: tuple[str, ...] = ()
        for _ in range(max(1, self._tools_wait // self._poll)):
            guest = await api.guest(uuid_)
            ips = guest.ipv4 if guest.tools_running else ()
            if vm.static_ip and vm.static_ip in ips:
                out(f"The VM answers at {vm.static_ip}.\n")
                return vm.static_ip
            if not vm.static_ip and ips:
                out(f"DHCP gave the VM {ips[0]}.\n")
                return ips[0]
            await self._sleep(self._poll)
        if vm.static_ip and ips:
            raise StepFailed(f"The VM came up at {', '.join(ips)}, not {vm.static_ip}. Check "
                             "that the seed is Ubuntu's cloud image (see the README).")
        raise StepFailed(f"VMware Tools didn't report the VM's address in "
                         f"{self._tools_wait // 60} minutes. Is open-vm-tools in the seed "
                         "image?")

    async def _pin(self, ctx: EsxiVmContext, ip: str, out: Output) -> bool:
        return await vmcommon.confirm_pin(
            ip=ip, expected=ctx.vm.host_fingerprint, actor_id=ctx.actor_id,
            target_id=f"esxi:{ctx.env_name}", tries=max(1, self._ssh_wait // self._poll),
            poll=self._poll, sleep=self._sleep, out=out,
            how="the key Sirdar generated for the VM",
            mismatch="The VM's live SSH key isn't the one Sirdar generated for it. Sirdar "
                     "pinned nothing.")

    async def _scrub(self, api: EsxiApi, ctx: EsxiVmContext, uuid_: str, out: Output) -> None:
        """Once SSH answered with the generated key: the user-data that held
        its private half leaves the VM's settings, and Sirdar forgets it."""
        if ctx.vm.host_key_private is None:
            return
        await api.set_extra_config(uuid_, cloudinit.scrub())
        await vmcommon.set_vm(EsxiVm, ctx.env_id, host_key_private_enc=None)
        out("Removed the cloud-init user-data (it held the VM's host key) from the VM's "
            "settings.\n")

    async def _snapshot(self, api: EsxiApi, ctx: EsxiVmContext, uuid_: str,
                        out: Output) -> str | None:
        if ctx.vm_snapshot:
            if any(s.name == ctx.vm_snapshot for s in await api.snapshots(uuid_)):
                out(f"Keeping the VM snapshot from the first attempt: {ctx.vm_snapshot}\n")
                return ctx.vm_snapshot
            out(f"The VM snapshot {ctx.vm_snapshot} from the first attempt is gone; taking a "
                "new one.\n")
        elif not ctx.take_snapshot:
            return None
        name = vms.snapshot_name(self._now())
        description = (f"Sirdar: before {ctx.mode} of {ctx.env_name} "
                       f"(deployment {ctx.deployment_id})")
        # Recorded first: if waiting on ESXi's task fails, a snapshot that still
        # appears is Sirdar's (kept by a retry, listed, pruned in turn).
        await vmcommon.record_vm_snapshot(ctx.deployment_id, name)
        try:
            try:
                await api.take_snapshot(uuid_, name, description, quiesce=True)
            except QuiesceFailed:
                out("VMware Tools couldn't quiesce the file systems; taking a crash-consistent "
                    "snapshot instead.\n")
                await api.take_snapshot(uuid_, name, description, quiesce=False)
        except EsxiError:
            with suppress(EsxiError):
                if all(s.name != name for s in await api.snapshots(uuid_)):
                    await vmcommon.record_vm_snapshot(ctx.deployment_id, None)
            raise
        out(f"Took VM snapshot {name}.\n")
        current = await api.snapshots(uuid_)
        doomed = set(vmcommon.to_prune([s.name for s in current],
                                       await vmcommon.recorded_snapshots(ctx.env_id) | {name},
                                       ctx.vm.keep_snapshots))
        for snap in current:
            if snap.name in doomed:
                await api.delete_snapshot(uuid_, snap.id)
                out(f"Deleted the old VM snapshot {snap.name} (keeping the newest "
                    f"{ctx.vm.keep_snapshots}).\n")
        return name

    # ---- Restore VM snapshot ------------------------------------------------------------

    async def _restore(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> None:
        vm, name = ctx.vm, ctx.vm_snapshot
        if vm.instance_uuid is None or not vm.created:
            raise StepFailed("This environment has no VM yet.")
        if not vms.valid_snapshot_name(name):
            raise StepFailed(f"{name} isn't a VM snapshot Sirdar takes.")
        if name not in await vmcommon.recorded_snapshots(ctx.env_id):
            raise StepFailed(f"Sirdar didn't take the VM snapshot {name} for {ctx.env_name}, "
                             "so it won't restore it.")
        if await self._identify(api, ctx, vm.instance_uuid) is None:
            raise StepFailed(f"{vm.name} is gone from ESXi.")
        matches = [s for s in await api.snapshots(vm.instance_uuid) if s.name == name]
        if not matches:
            raise StepFailed(f"The VM snapshot {name} is gone from ESXi.")
        if len(matches) > 1:
            raise StepFailed(f"ESXi has {len(matches)} VM snapshots named {name}; Sirdar won't "
                             "pick one.")
        out(f"Reverting {vm.name} to {name}.\n")
        await api.revert_snapshot(vm.instance_uuid, matches[0].id)
        await self._start(api, vm.instance_uuid, out)
        ip = await self._address(api, vm.instance_uuid, out, vm)
        await vmcommon.settle_address(
            self._settings, model=EsxiVm, env_id=ctx.env_id, previous_ip=vm.ip, ip=ip,
            pin=lambda: self._pin(ctx, ip, out), actor_id=ctx.actor_id,
            target_id=f"esxi:{ctx.env_name}", out=out, host_label=HOST_LABEL)
        out(f"{vm.name} is back at {name}; Docker starts its containers.\n")

    # ---- Destroy VM ---------------------------------------------------------------------

    async def _destroy(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> None:
        vm, owner = ctx.vm, str(ctx.env_id)
        if vm.instance_uuid is None:
            found = await api.find_vm_by_name(vm.name)
            if found is None or found.owner != owner:
                out(f"Sirdar never created a VM for {ctx.env_name}.\n")
            else:
                out(f"Found {vm.name} from an unfinished create (it carries this "
                    "environment's marker).\n")
                await self._remove(api, found, vm, out)
        else:
            found = await api.find_vm(vm.instance_uuid)
            if found is None:
                twin = await api.find_vm_by_name(vm.name)
                if twin is not None and twin.owner == owner:
                    raise StepFailed(f"{vm.name} carries this environment's marker but isn't the "
                                     "VM Sirdar recorded (its id changed). Sirdar changed "
                                     "nothing: remove it by hand in the ESXi Host Client, then "
                                     "retry.")
                out(f"{vm.name} is already gone.\n")
            else:
                if found.name != vm.name:
                    raise StepFailed(f"The VM Sirdar recorded is {found.name or 'unnamed'} now, "
                                     f"not {vm.name}. Sirdar changed nothing.")
                if found.owner != owner:
                    raise StepFailed(f"{vm.name} doesn't carry this environment's marker, so it "
                                     "isn't the VM Sirdar made. Sirdar changed nothing.")
                await self._remove(api, found, vm, out)
        if vm.ip and await vmcommon.forget_pin(vm.ip, ctx.actor_id, f"esxi:{ctx.env_name}"):
            out(f"Forgot {vm.ip}'s SSH host key.\n")

    async def _remove(self, api: EsxiApi, found: VmInfo, vm: EsxiVmState, out: Output) -> None:
        if found.power_state != "poweredOff":
            await api.power_off(found.instance_uuid)
            out("Powered the VM off.\n")
        out(f"Destroying {vm.name} and its VM snapshots.\n")
        await api.destroy(found.instance_uuid)
        if await api.find_vm(found.instance_uuid) is not None:
            raise StepFailed(f"{vm.name} is still there after destroy. Remove it by hand in "
                             "the ESXi Host Client, then retry.")
        out(f"Destroyed {vm.name}.\n")
```

- [ ] **Step 4: Dispatch ESXi in `vmsteps` and the pipeline**

In `sirdar/api/src/sirdar_api/deploy/vmsteps.py`:
- import `esxi_provision` (`from sirdar_api.deploy import esxi_provision, provision, targets`);
- `VmContext = provision.VmContext | esxi_provision.EsxiVmContext`;
- in `prepare`, add before the Proxmox branch:

```python
    if env.target_id == targets.ESXI_TARGET:
        return await esxi_provision.prepare(db, env, dep, settings)
```

- `HostProvisioner.run` becomes:

```python
    async def run(self, step: str, ctx, out: Output) -> VmOutcome:
        if isinstance(ctx, esxi_provision.EsxiVmContext):
            if self._esxi is None:
                raise VmPrepareError("ESXi steps can't run here.")
            return await self._esxi.run(step, ctx, out)
        return await self._proxmox.run(step, ctx, out)
```

In `pipeline.make_provisioner`:
- add `esxi_provision` to the `from sirdar_api.deploy import (...)` list;
- pass `esxi=esxi_provision.EsxiProvisioner(settings=settings)` to `HostProvisioner`.

- [ ] **Step 5: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_provision.py tests/test_deploy_pipeline_vm.py tests/test_deploy_provision.py tests/test_deploy_vmcommon.py`
Expected: all pass. A test above may assume something the fake does differently, such as call order. If so, fix the test only when the code is right by the context file's rules, and say so in the report.

- [ ] **Step 6: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/esxi_provision.py src/sirdar_api/deploy/vmsteps.py src/sirdar_api/deploy/pipeline.py tests/test_deploy_esxi_provision.py tests/test_deploy_pipeline_vm.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/esxi_provision.py sirdar/api/src/sirdar_api/deploy/vmsteps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/tests/test_deploy_esxi_provision.py sirdar/api/tests/test_deploy_pipeline_vm.py
git commit -m "feat(sirdar): ESXi Prepare VM, Restore VM snapshot and Destroy VM

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Routes for both VM hosts — deploys, Restore VM snapshot, the VM snapshot list

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (one message and the docstring)
- Modify: `sirdar/api/tests/test_deploy_vm_api.py` (`not_proxmox` → `not_vm_environment`)
- Test: create `sirdar/api/tests/test_deploy_esxi_vm_api.py`

**Interfaces:**
- Consumes: `targets.is_vm_target` and `vms.get_for` / `stage`; `esxi.connect`; the existing `_launch`, `_environment` and `_vm_snapshot_restorable`.
- Produces:
  - the route behavior under "API produced for 6b";
  - `ENV_TARGET_PATTERN` accepts `esxi`;
  - `_require_vm_host(db, env)`;
  - the code `not_vm_environment`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_esxi_vm_api.py`:

```python
import uuid

import pytest

from sirdar_api.db.models import Deployment, EsxiVm
from sirdar_api.deploy.esxi import SnapshotInfo

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    leak_guard,
    make_environment,
    secrets_key,
    stop_pipeline,
)
from .esxi_helpers import esxi_fake  # noqa: F401
from .integration_helpers import ESXI_PASSWORD, configure_esxi
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_deployments_api import OLD, SHA

URL = "/api/deploy/environments"
UAT3 = f"{URL}/uat3"
SNAP = "sirdar-20261005T120000Z"
BODY = {"mode": "new", "name": "uat3", "type": "dev", "target": "esxi",
        "proxy_ip": "10.10.48.6", "publish": False,
        "vm": {"ip_mode": "static", "ip_cidr": "10.10.48.71/24", "gateway": "10.10.48.1"}}


@pytest.fixture
async def esx(db, deploy_env, secrets_key, esxi_fake, leak_guard):
    await configure_esxi(db)
    leak_guard.append(ESXI_PASSWORD)
    return esxi_fake


async def test_esxi_must_be_set_up(client, db, deploy_env, secrets_key):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json=BODY)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "integration_not_configured", "kinds": ["esxi"]}


async def test_create_an_esxi_environment(client, db, esx):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json=BODY)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["target"], body["target_kind"]) == ("esxi", "esxi")
    assert (body["vm"]["kind"], body["vm"]["stage"], body["vm"]["host"],
            body["vm"]["moref"]) == ("esxi", "none", "10.10.48.10", None)
    assert {s["host_ip"] for s in body["services"]} == {"10.10.48.71"}
    resp = await client.post(URL, headers=h, json={**BODY, "mode": "adopt", "vm": None})
    assert resp.json()["detail"]["code"] in ("adopt_not_allowed", "environment_exists")


async def test_a_deploy_starts_with_prepare_vm_and_delete_destroys_it(client, db, esx,
                                                                      fake_provisioner):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=BODY)
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "update", "git_ref": "main"})
    assert resp.status_code in (201, 202), resp.text
    dep = resp.json()
    assert dep["vm"] is True and dep["sha"] == ""
    assert fake_provisioner.calls[:1] == ["provision"]


async def test_the_vm_snapshot_list_reads_esxi(client, db, esx):
    h = await auth_headers(client, db)
    env_id = uuid.UUID((await client.post(URL, headers=h, json=BODY)).json()["id"])
    vm = esx.add_vm("ss-uat3", owner=str(env_id), power_state="poweredOn")
    vm.snapshots += [SnapshotInfo(1, SNAP, "Sirdar: before update", None),
                     SnapshotInfo(2, "by hand", "", None)]
    record = await db.get(EsxiVm, env_id)
    record.moref, record.instance_uuid, record.created = vm.moref, vm.instance_uuid, True
    db.add(Deployment(environment_id=env_id, mode="update", git_ref="main", sha=SHA,
                      status="succeeded", start_step=0, vm=True, take_vm_snapshot=True,
                      vm_snapshot=SNAP, previous_sha=OLD))
    await db.commit()
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert resp.status_code == 200, resp.text
    [row] = resp.json()["snapshots"]
    assert (row["name"], row["sha"], row["restorable"]) == (SNAP, OLD, True)


async def test_vm_routes_on_an_ssh_environment(client, db, deploy_env, secrets_key):
    await make_environment(db, name="uat3")
    h = await auth_headers(client, db)
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_vm_environment")
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "vm_restore", "vm_snapshot": SNAP,
                                   "confirm_name": "uat3"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_vm_environment")


async def test_moving_to_esxi_is_locked(client, db, esx):
    await make_environment(db, name="uat")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat", headers=h, json={"target": "esxi"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "target_kind_locked")
```

**Check the responses first.** Read `tests/test_deploy_vm_api.py`'s "update starts with step 0" test for the exact status code and the deployment response shape. If it differs from the guesses above (201 or 202, `dep["vm"]`), use what it asserts. Also check `fake_provisioner.calls`: the existing Proxmox test shows whether calls are recorded synchronously or after the task runs. Copy its wait helper if it uses one (`_finish`).

In `sirdar/api/tests/test_deploy_vm_api.py`, change the two `"not_proxmox"` assertions to `"not_vm_environment"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_vm_api.py`
Expected: FAIL. The `target` pattern refuses `esxi` with a 422, and `not_proxmox` is still returned.

- [ ] **Step 3: Make the routes VM-host-neutral**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

1. Add `esxi` to the `from sirdar_api.deploy import (...)` list. Import `EsxiVm` from `sirdar_api.db.models` next to the existing model imports.
2. Replace the target pattern:

```python
# An environment's target: an SSH target, or a VM host Sirdar builds on.
ENV_TARGET_PATTERN = r"^(ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*|proxmox|esxi)$"
```

3. `VmIn` docstring: `"""A VM environment's VM (mode "new", target "proxmox" or "esxi")."""`. In `EnvironmentIn`, the comment becomes `# mode "new" with a VM target only: the VM step 0 builds`.
4. In `_host_target`, use the docstring "None only for a VM environment whose VM has no address yet", and replace `if cfg is None and env.target_id != targets.PROXMOX_TARGET:` with `if cfg is None and not targets.is_vm_target(env.target_id):`.
5. Replace `_on_vm` and `_require_proxmox` with:

```python
def _on_vm(env: Environment) -> bool:
    return targets.is_vm_target(env.target_id)


async def _require_vm_host(db, env: Environment) -> None:
    if _on_vm(env) and not await integrations.is_configured(db, env.target_id):
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": [env.target_id]})
```

   Then replace every call `await _require_proxmox(db, env)` with `await _require_vm_host(db, env)`. Run `grep -n _require_proxmox src/sirdar_api/api/routes/deploy.py`; the output must be empty afterwards.
6. `_take_vm_snapshot` docstring: "A deployed VM environment takes a VM snapshot …".
7. In `_start_vm_restore`, use the docstring "the VM back to a snapshot Sirdar took …", and change `detail={"code": "not_proxmox"}` to `detail={"code": "not_vm_environment"}`.
8. Replace `list_vm_snapshots` with:

```python
async def _live_snapshots(cfg, vm) -> list[tuple[str, str]]:
    """(name, description) of every snapshot the host has for the VM."""
    if isinstance(vm, EsxiVm):
        async with esxi.connect(cfg) as api:
            return [(s.name, s.description) for s in await api.snapshots(vm.instance_uuid)]
    async with proxmox.Proxmox(replace(cfg, node=vm.node),
                               transport=outbound.transports()["proxmox"]) as api:
        return [(str(s.get("name", "")), str(s.get("description") or ""))
                for s in await api.snapshots(vm.vmid)]


@router.get("/environments/{name}/vm-snapshots")
async def list_vm_snapshots(name: str, db: DbSession,
                            actor: AuthContext = require_permission("deploy", "view")):
    """The VM snapshots Sirdar took for a VM environment that still exist on
    its host, newest first, with the commit each holds and whether it can be
    restored (read live from Proxmox or ESXi)."""
    env = await _environment(db, name)
    if not _on_vm(env):
        raise HTTPException(status_code=409, detail={"code": "not_vm_environment"})
    try:
        cfg = await integrations.load(db, get_settings(), env.target_id)
    except integrations.IntegrationError as e:
        status = 400 if e.code == "secrets_key_missing" else 409
        raise HTTPException(status_code=status, detail={"code": e.code}) from None
    if cfg is None:
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": [env.target_id]})
    vm = await vms.get_for(db, env)
    if vm is None or vms.stage(vm) != "built":
        return {"snapshots": []}
    taking = await vms.taking_deployments(db, env.id)
    changed_at = (await environments.key_changes(db, env.id)).changed_at
    try:
        found = await _live_snapshots(cfg, vm)
    except (proxmox.ProxmoxError, esxi.EsxiError) as e:
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    rows = []
    for name_, description in found:
        dep = taking.get(name_)
        if dep is None or not vms.valid_snapshot_name(name_):
            continue
        reason = vms.snapshot_blocked(name_, changed_at)
        rows.append({"name": name_,
                     "taken_at": vms.snapshot_taken_at(name_).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "sha": dep.previous_sha, "deployment_id": str(dep.id),
                     "description": description,
                     "restorable": reason is None and bool(dep.previous_sha),
                     "reason": reason})
    return {"snapshots": sorted(rows, key=lambda r: r["name"], reverse=True)}
```

9. Anywhere else in the file that still compares with `targets.PROXMOX_TARGET`, use `_on_vm(env)` instead. `grep -n "PROXMOX_TARGET\|not_proxmox" src/sirdar_api/api/routes/deploy.py` must print nothing.

In `sirdar/api/src/sirdar_api/deploy/steps.py`:
- docstring: "A Proxmox environment (vm=True) builds its host first" → "A VM environment (vm=True; Proxmox or ESXi) builds its host first";
- `raise ValueError("only a Proxmox environment restores a VM snapshot")` → `raise ValueError("only a VM environment restores a VM snapshot")`;
- the `VM_HOST_MODES` comment: "A VM environment's modes that start with 0 Prepare VM."

If `tests/test_deploy_vm_steps.py` asserts the old message text, update that assertion in the same commit.

- [ ] **Step 4: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q tests/test_deploy_esxi_vm_api.py tests/test_deploy_vm_api.py tests/test_deploy_vm_steps.py tests/test_deploy_restore_api.py tests/test_deploy_deployments_api.py`
Expected: all pass.

- [ ] **Step 5: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/api/routes/deploy.py src/sirdar_api/deploy/steps.py tests/test_deploy_esxi_vm_api.py tests/test_deploy_vm_api.py tests/test_deploy_vm_steps.py
cd ../.. && git add sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/tests/test_deploy_esxi_vm_api.py sirdar/api/tests/test_deploy_vm_api.py sirdar/api/tests/test_deploy_vm_steps.py
git commit -m "feat(sirdar): deploy routes for both VM hosts; ESXi VM snapshot list; not_vm_environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: README, the full suites, lint, and the image check

**Files:**
- Modify: `sirdar/README.md`

- [ ] **Step 1: The README's ESXi section**

In `sirdar/README.md`, add a section **"VMware ESXi targets"** after the Proxmox section. Write it in American English. It says:

- **What it does.** Sirdar builds each ESXi environment's VM, `ss-<name>`, on one standalone, licensed ESXi 7 host:
  - It copies a seed disk.
  - cloud-init through guestinfo sets up the user `deploy` with Sirdar's key, the static address or DHCP, and an SSH host key Sirdar generated. Its fingerprint is pinned before the first boot, and its private half is removed from the VM's settings afterwards.
  - Sirdar takes VM snapshots before data-touching deploys and keeps the newest 3 it took.
  - Delete environment destroys the VM.
- **Ownership.** Sirdar touches only VMs that carry the extraConfig key `sirdar.environment` with that environment's id, under the recorded name and instance UUID. Never edit that key.
- **License.** A paid license is needed. Free ESXi makes the API read-only, and Test says so.
- **The user.** Make a dedicated local user:
  1. In the Host Client, go to Manage › Security & users › Users › Add user, and add `sirdar` with a long password.
  2. Then go to Host › Actions › Permissions › Add user, and give `sirdar` the role Administrator. Standalone ESXi can't scope it to some VMs; Sirdar's marker checks protect the rest.
- **The seed VM** (one time):
  1. Download `noble-server-cloudimg-amd64.ova` from `https://cloud-images.ubuntu.com/noble/current/`, and check it against that folder's `SHA256SUMS`.
  2. In the Host Client, go to Virtual Machines › Create / Register VM › Deploy a virtual machine from an OVF or OVA file.
  3. Name it `sirdar-ubuntu-2404-seed`, pick the datastore and Thin provisioning, leave every property empty, and **uncheck "Power on automatically"**.
  4. Never power it on, and never take snapshots of it.
  5. Test in Settings › Integrations › VMware ESXi checks that it is off, has one disk and has no snapshots.
- **The certificate.** Save or Test shows the host's certificate fingerprint (SHA-256). Compare it with what the ESXi Shell prints for `openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256`, or with the browser's certificate viewer on the Host Client, before you click Trust. The host name isn't checked, because ESXi's certificate usually names only `localhost.localdomain`; the pinned certificate is the only one trusted.
- **Sizing.**
  - Changing vCPU or memory shuts the guest down (VMware Tools) and starts it again on the next deploy. If the guest doesn't stop within 5 minutes, the step fails.
  - Growing the disk first deletes this environment's VM snapshots, because ESXi can't grow a disk that has snapshots. A snapshot someone made by hand stops it.
  - Disks never shrink.
- **Packages.** pyVmomi 8.0.3.0.1 and six 1.17.0 are installed with `--require-hashes` from `sirdar/api/requirements-esxi.txt`. Bump them together with `pyproject.toml`; a test compares the two.

- [ ] **Step 2: The full API suite and lint**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api
SIRDAR_TEST_DB=sirdar_test_phase6a .venv/bin/pytest -q
.venv/bin/ruff check --select E,F,W --ignore F811 src tests migrations
```

Expected:
- every test passes. Phase 5 ended at 1269 passed and 9 skipped; this phase adds about 100.
- ruff prints `All checks passed!`.

Record the counts in the report.

- [ ] **Step 3: The web suite still compiles against the API (no web changes in 6a)**

Run: `npm --prefix /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/web test`
Expected: green, except tests that assert `not_proxmox` copy or the exact Proxmox `vm` shape, if any. Those are 6b Task 1's to update; list them in the report.

- [ ] **Step 4: The image builds with the hash-checked pyVmomi**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar
docker build -f sirdar/Dockerfile -t sirdar-phase6-check /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar
docker run --rm --entrypoint python sirdar-phase6-check -c "import pyVmomi, pyVim.connect, sirdar_api.deploy.esxi; print('ok')"
docker image rm sirdar-phase6-check
```

Expected: the build passes the `--require-hashes` step and the run prints `ok`. If the build context path differs (the Dockerfile says the context is the repo root), use the worktree root, as above.

- [ ] **Step 5: Drop the test database and commit**

```bash
docker exec $(docker ps -qf name=sirdar-db | head -1) psql -U sirdar -d postgres -c 'DROP DATABASE IF EXISTS sirdar_test_phase6a' -c 'DROP DATABASE IF EXISTS sirdar_test_phase6a_source'
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar && git add sirdar/README.md
git commit -m "docs(sirdar): ESXi targets — seed VM, user, license, certificate, sizing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Self-review notes (for the controller)

| Requirement | Where |
|---|---|
| ESXi credentials with a write-only password and TLS pinning | Tasks 2 and 4 |
| pyVmomi pinned by SHA-256 in the image | Tasks 2 and 10 |
| One injectable seam with a fake and an autouse guard | Task 3 |
| cloud-init through guestinfo, static or DHCP | Task 5 |
| A host key pinned before the first boot, then scrubbed | Tasks 5 and 8 |
| Ownership by uuid + name + marker, and destroying only Sirdar's VMs | Task 8 |
| Address safety over both hosts | Tasks 6 and 7 |
| VM snapshots: keep 3, Sirdar's only, recorded before the task | Tasks 7 and 8 |
| Disk grow, never shrink, with ESXi's snapshot rule | Task 8 |
| Power operations | Task 8 |
| Routes and codes for both hosts | Task 9 |
| Migration 0008 with a downgrade guard | Task 1 |
| The phase 5 orphan follow-up (marker search) and unrecorded-snapshot follow-up (record before the task) | Task 8 |
