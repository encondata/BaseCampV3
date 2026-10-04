# Sirdar deploy phase 5a (Proxmox targets: backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Sirdar build an environment's host itself on Proxmox: a `proxmox` integration (API token, pinned TLS certificate, Test), Terraform `bpg/proxmox` as step 0 that clones an Ubuntu 24.04 cloud-init template into a VM and pins its SSH key, VM snapshots before data-touching deploys with Restore VM snapshot, and Delete environment that destroys only the VM Sirdar created.

**Architecture:** `deploy/tls_pin.py` pins Proxmox's certificate; `deploy/proxmox.py` is the REST client (agent, snapshots, power, Test) over an injectable `httpx` transport; `deploy/terraform.py` renders `main.tf.json`, owns the per-environment state folder and runs Terraform through an injectable `TerraformRunner`; `deploy/vms.py` holds the `proxmox_vms` ownership record and the VM's SSH connection; `deploy/provision.py` runs the new `"vm"` steps (0 Prepare VM, 0 Restore VM snapshot, 15 Destroy VM) through a `Provisioner`, like `publish.py` runs steps 12–17. The pipeline prepares the SSH host lazily, after step 0 has built the VM.

**Tech Stack:** FastAPI, SQLAlchemy 2 async + asyncpg, Alembic (raw SQL), httpx (`AsyncClient`, `MockTransport`), asyncssh, `cryptography` (x509), asyncio subprocesses, Terraform 1.16.5 + `bpg/proxmox` 0.115.0 (in the image only), pytest on real Postgres.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` Section 6 (and Sections 2–4 where it refers to them), with the binding decisions in `docs/superpowers/plans/2026-10-04-sirdar-phase5-context.md`. The UI is plan 5b (`docs/superpowers/plans/2026-10-04-sirdar-phase5b-ui.md`), which uses exactly the shapes under "API produced for 5b".

## Global Constraints

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it. `sirdar` is both a branch and a folder: use `--` in `git diff`/`git log` (`git log -- sirdar/`). Other agents may commit in this worktree at the same time: `git add` only the files your task names, never `git add -A`, never `git stash`; if `.git/index.lock` is busy, wait a few seconds and retry.
- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"` (never add `@pytest.mark.asyncio`). New and changed files must pass `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` (`All checks passed!`).
- Migration number is **0007** (`revision = "0007"`, `down_revision = "0006"`). Before writing it, check: `ls /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/*/sirdar/api/migrations/versions/ | sort | tail -3` shows nothing above 0006, and `docker exec $(docker ps -qf name=sirdar-db | head -1) psql -U sirdar -d sirdar -tAc 'select version_num from alembic_version'` prints 0006 or lower. If either shows 0007, stop and ask the controller.
- Steps (number, key, name, runs): 0 `provision` "Prepare VM" vm; 0 `vm_restore` "Restore VM snapshot" vm; 15 `destroy` "Destroy VM" vm. A Proxmox environment's update / reset / restore_dump / rollback plans start with 0 `provision`; its teardown plan is 15 `destroy`, 16 `unproxy`, 17 `undns`; mode `vm_restore` is 0 `vm_restore` alone. Numbers rise in every plan.
- The Proxmox token (`user@realm!tokenid=<uuid>`), its UUID part, environment secrets and the VM's private key never appear in an API response, a log line, an audit `changes`, an exception message, a `repr()`, a stored step log, a Terraform file in the working folder or Terraform's command line. Terraform gets the token only as `PROXMOX_VE_API_TOKEN` in its own process environment. Errors are our own copy, never Proxmox's, Terraform's or a library's text.
- Every Proxmox API call goes through `proxmox.Proxmox`, built with `transport=outbound.transports()["proxmox"]`; tests never reach a real Proxmox (the existing conftest guard fails any real `httpx` request). Tests never run a real Terraform (`terraform._spawn` is guarded), never fetch a real certificate (`tls_pin._read_certificate` is guarded, 127.0.0.1 only) and never probe a real port (`provision.tcp_open` is guarded).
- Sirdar manages only VMs it created: the `proxmox_vms` row is the ownership record, the VM id is recorded before `terraform apply`, and Destroy checks the VM's name and `sirdar` tag before and its absence after. No route attaches an existing VM.
- Errors: `HTTPException(status, detail={"code": "snake_code", ...})`.
- Permissions reuse `deploy`: `view` = read the VM and its snapshots; `add` = create a Proxmox environment, Update; `change` = Proxmox credentials, PATCH sizing, Reset, Restore backup, Roll back, Restore VM snapshot (`vm_restore`), Delete. Gated modes need `confirm_name` = the environment's name. Every successful mutation writes one audit row named `deploy.<verb>`.
- American English in all copy, comments and docs. Display copy "Canceled"; the status value stays `cancelled`.
- Never commit `sirdar/.env`. No `npm install` in this worktree.

## Working environment

- Sirdar's dev database must be running. From the main checkout: `cd /Users/jrh1812/Developer/BaseCampV3 && docker compose -f docker-compose.dev.yml up -d sirdar-db` (Postgres on 127.0.0.1:5434).
- Every Sirdar test command runs from `sirdar/api` in the worktree: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api`, then `SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/<file>`. The conftest creates that database; Task 11 drops it. Never point tests at the dev `sirdar` database. Run test files in the foreground.
- The dev `sirdar/.env` is read by `Settings`; tests override with `monkeypatch.setenv` (an env var beats the file).

## API produced for 5b

All under `/api/deploy`. Times are ISO 8601 strings.

- `Integrations` gains `proxmox: {configured, url, node, pool, storage, bridge, vlan_tag: int|null, template_vmid: int|null, tls_fingerprint, token_id, token_set, updated_at, updated_by_name}` (unset values null).
- `PUT /integrations/proxmox` (change) body `{url, node, pool, storage, bridge, vlan_tag?: int|null, template_vmid: int, tls_fingerprint?: str|null, token?: str}` (`token` omitted = keep the stored one, allowed only for the same `url`) → `Integrations`. Errors: 409 `tls_untrusted {fingerprint, subject, issuer, not_after, names: string[]}` (no fingerprint sent, or the stored pin is for another URL: show it, then resend with `tls_fingerprint`); 409 `tls_mismatch {expected, actual}`; 502 `connect_failed {reason}` (the certificate couldn't be read); 422 `proxmox_url_invalid`, `node_invalid`, `pool_invalid`, `storage_invalid`, `bridge_invalid`, `vlan_tag_invalid`, `template_vmid_invalid`, `proxmox_token_invalid`, `secret_required {reason?}`; 400 `secrets_key_missing`.
- `POST /integrations/proxmox/test` (change), optional body = the PUT body → `ConnectResult` `{ok, target: "proxmox", checks: [{label, status, value}], facts: {url, node, version, fingerprint, token_id}}`; check labels in order: Proxmox, Node, Pool, Template, Storage, Bridge. Errors: the PUT's, plus 409 `integration_not_configured {kinds: ["proxmox"]}` (no body, nothing saved), 409 `integration_unreadable`.
- `DELETE /integrations/proxmox` (change) → 204; 409 `integration_in_use {environments: string[]}` while an environment uses it; 404 `integration_not_found`.
- `GET /targets` adds `{id: "proxmox", label: "Proxmox", kind: "proxmox", available: true, configured: true}` at the end once the Proxmox integration is saved (absent otherwise).
- `GET /environment-defaults` adds `vm: {cores: 4, memory_mb: 8192, disk_gb: 64, keep_snapshots: 3, limits: {cores: [1, 64], memory_mb: [2048, 262144], disk_gb: [20, 4096], keep_snapshots: [1, 10]}}`.
- `POST /environments` (add), mode `new` with `target: "proxmox"` requires `vm: {cores?, memory_mb?, disk_gb?, ip_mode: "static"|"dhcp", ip_cidr?: "10.10.48.70/24", gateway?: "10.10.48.1"}` (sizes default as above). Errors add: 409 `integration_not_configured {kinds: ["proxmox"]}`; 409 `ip_in_use`; 422 `vm_cores_invalid`, `vm_memory_invalid`, `vm_disk_invalid`, `vm_ip_mode_invalid`, `vm_ip_invalid`, `vm_gateway_invalid`, `vm_not_allowed` (a `vm` for an SSH target); mode `adopt` with `target: "proxmox"` → 422 `adopt_not_allowed`.
- `PATCH /environments/{name}` (change) accepts `vm: {cores?, memory_mb?, disk_gb?, keep_snapshots?}` (applied by the next deploy's step 0). Errors add 422 `vm_disk_shrink`, `vm_keep_snapshots_invalid`, `vm_not_allowed`, `host_ip_managed {service}` (service addresses of a Proxmox environment), `target_kind_locked` (switching between SSH and Proxmox).
- `Environment` adds `target_kind: "ssh" | "proxmox"` and `vm: {name, node, vmid: int|null, cores, memory_mb, disk_gb, ip_mode, ip_cidr, gateway, ip, keep_snapshots, created} | null`. `target` is `"proxmox"` for these environments.
- `POST /environments/{name}/deployments` (add): `mode` may also be `vm_restore` (change + `confirm_name` + `vm_snapshot: "sirdar-YYYYMMDDTHHMMSSZ"`); `take_vm_snapshot?: bool` for update / reset / restore_dump of a Proxmox environment (default: true once deployed). For a Proxmox environment a branch or tag isn't resolved up front: the response's `sha` is `""` until step 0 resolves it on the VM (a full SHA is used as is). Errors add: 409 `integration_not_configured {kinds: ["proxmox"]}`; 422 `vm_snapshot_not_allowed`; 422 `vm_snapshot_invalid`; 404 `vm_snapshot_not_found`; 409 `vm_snapshot_keys_changed {reason}`; 409 `not_proxmox`.
- `POST /deployments/{id}/rollback` (change) body adds `take_vm_snapshot?: bool`. `POST /deployments/{id}/retry` takes `from_step: 0` and retries `vm_restore` (change + `confirm_name`).
- `DeploymentSummary` adds `vm: bool` (the plan has VM steps), `take_vm_snapshot: bool`, `vm_snapshot: str|null` (the VM snapshot this deployment took, or for `vm_restore` the one it restores); `mode` may be `vm_restore`.
- `GET /environments/{name}/vm-snapshots` (view) → `{snapshots: [{name, taken_at, sha, deployment_id, description, restorable, reason}]}` newest first (only the snapshots Sirdar took for this environment and that still exist in Proxmox; `[]` before the VM exists). Errors: 409 `not_proxmox`; 409 `integration_not_configured {kinds: ["proxmox"]}`; 502 `connect_failed {reason}`.
- `GET /environments/{name}/backups` answers `{backups: []}` for a Proxmox environment whose VM has no address yet.
- Steps: 0 `provision` "Prepare VM", 0 `vm_restore` "Restore VM snapshot", 15 `destroy` "Destroy VM".

## File map

| File | Responsibility |
|---|---|
| `sirdar/api/migrations/versions/0007_proxmox.py` | `proxmox` integration kind, `proxmox_vms`, `deployments.vm/take_vm_snapshot/vm_snapshot`, mode `vm_restore` |
| `sirdar/api/src/sirdar_api/db/models.py` | `ProxmoxVm`; new `Deployment` columns |
| `sirdar/api/src/sirdar_api/deploy/tls_pin.py` | Certificate fetch, SHA-256 fingerprint, description, pinned `SSLContext` |
| `sirdar/api/src/sirdar_api/deploy/integrations.py` | The `proxmox` kind: fields, token check, `ProxmoxConfig`, `config_of`, `in_use` |
| `sirdar/api/src/sirdar_api/deploy/proxmox.py` | Proxmox REST client and connection test |
| `sirdar/api/src/sirdar_api/deploy/outbound.py` | `proxmox` transport kind |
| `sirdar/api/src/sirdar_api/api/routes/integrations.py` | PUT / test / DELETE for `proxmox`, the certificate trust flow |
| `sirdar/api/src/sirdar_api/deploy/terraform.py` | `main.tf.json`, the per-environment folder, Terraform's environment, the runner |
| `sirdar/api/src/sirdar_api/config.py` | `terraform_dir`, `terraform_binary`, `terraform_cli_config` |
| `sirdar/Dockerfile`, `sirdar/terraformrc`, `sirdar/docker-compose.yml`, `sirdar/install.sh`, `sirdar/.gitignore`, `sirdar/terraform/.gitkeep` | Terraform + provider in the image (pinned, checksummed, offline mirror), the state folder |
| `sirdar/api/src/sirdar_api/deploy/vms.py` | `proxmox_vms` rows: sizing and network checks, key pair, address checks, the VM's SSH config, snapshot names |
| `sirdar/api/src/sirdar_api/deploy/ssh.py` | `SshTargetConfig.private_key` (an in-memory key) |
| `sirdar/api/src/sirdar_api/deploy/targets.py` | `PROXMOX_TARGET`, the Proxmox entry in the target list |
| `sirdar/api/src/sirdar_api/deploy/gitref.py` | `is_full_sha` |
| `sirdar/api/src/sirdar_api/deploy/environments.py` | Proxmox create, adopt refusal, PATCH `vm`, managed addresses |
| `sirdar/api/src/sirdar_api/deploy/provision.py` | Steps 0 / 0 / 15: `VmContext`, `Provisioner`, `ProxmoxProvisioner` |
| `sirdar/api/src/sirdar_api/deploy/steps.py` | The VM steps, `vm_restore`, `plan_for(vm=…)` |
| `sirdar/api/src/sirdar_api/deploy/pipeline.py` | `"vm"` steps, lazy host preparation, VM outcomes, retries |
| `sirdar/api/src/sirdar_api/deploy/serialize.py` | `target_kind`, `vm`, deployment VM fields |
| `sirdar/api/src/sirdar_api/api/routes/deploy.py` | Proxmox create / PATCH / deploy / retry / rollback / teardown, `vm_restore`, VM snapshot list, defaults, targets |
| `sirdar/api/tests/…` | `tls_helpers.py`, `fake_proxmox.py`, `proxmox_helpers.py`, `fake_terraform.py`, `fake_provisioner.py`, `vm_helpers.py`; `test_deploy_tls_pin.py`, `test_deploy_proxmox.py`, `test_deploy_proxmox_api.py`, `test_deploy_terraform.py`, `test_deploy_vms.py`, `test_deploy_provision.py`, `test_deploy_vm_steps.py`, `test_deploy_pipeline_vm.py`, `test_deploy_vm_api.py`; updates to conftest, models, integrations, playbooks tests |
| `sirdar/README.md` | Proxmox targets, the template recipe, token privileges |

---

### Task 1: Migration 0007 and the models

**Files:**
- Create: `sirdar/api/migrations/versions/0007_proxmox.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py`
- Modify: `sirdar/api/tests/conftest.py` (`SIRDAR_TABLES`)
- Test: `sirdar/api/tests/test_deploy_models.py`

**Interfaces:**
- Produces (tables): `integrations.kind` may be `proxmox`; `proxmox_vms` (`environment_id` PK + FK ON DELETE CASCADE, `node`, `vmid` int UNIQUE 100–999999999 nullable, `name` UNIQUE, `cores` 1–64, `memory_mb` 2048–262144, `disk_gb` 20–4096, `ip_mode` static|dhcp, `ip_cidr`, `gateway` (both set exactly when static), `ip`, `ssh_public_key`, `ssh_private_key_enc` bytea, `keep_snapshots` 1–10 default 3, `created` bool default false, `created_at`, `updated_at`); `deployments.vm` bool default false, `deployments.take_vm_snapshot` bool default false, `deployments.vm_snapshot` text; `deployments.mode` may be `vm_restore`.
- Produces (ORM): `class ProxmoxVm(Base)` with those columns; `Deployment.vm: bool`, `Deployment.take_vm_snapshot: bool`, `Deployment.vm_snapshot: str | None`.

- [ ] **Step 1: Check the migration number**

Run:

```bash
ls /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/*/sirdar/api/migrations/versions/ | sort | tail -3
docker exec $(docker ps -qf name=sirdar-db | head -1) psql -U sirdar -d sirdar -tAc 'select version_num from alembic_version'
```

Expected: no `0007_*` file anywhere, and `0006` or lower. Otherwise stop and report.

- [ ] **Step 2: Write the failing tests**

In `sirdar/api/tests/test_deploy_models.py`, replace:

```python
    Integration,
    ManagedRecord,
    Snapshot,
)
```

with:

```python
    Integration,
    ManagedRecord,
    ProxmoxVm,
    Snapshot,
)
```

Append to the end of `sirdar/api/tests/test_deploy_models.py`:

```python
def _vm(env_id, **over) -> ProxmoxVm:
    kw = dict(environment_id=env_id, node="pve", name="ss-uat", cores=4, memory_mb=8192,
              disk_gb=64, ip_mode="static", ip_cidr="10.10.48.70/24", gateway="10.10.48.1",
              ssh_public_key="ssh-ed25519 AAAAC3Nz test", ssh_private_key_enc=b"enc")
    kw.update(over)
    return ProxmoxVm(**kw)


async def test_proxmox_vms_and_the_vm_columns(db):
    env = await _env(db)
    db.add(_vm(env.id))
    db.add(Integration(kind="proxmox", config={"url": "https://10.10.48.5:8006"},
                       secret_enc=b"x"))
    dep = Deployment(environment_id=env.id, mode="vm_restore", git_ref=SHA, sha=SHA,
                     status="succeeded", start_step=0, vm=True,
                     vm_snapshot="sirdar-20261004T120000Z")
    db.add(dep)
    await db.commit()
    vm = await db.get(ProxmoxVm, env.id)
    assert (vm.vmid, vm.ip, vm.keep_snapshots, vm.created) == (None, None, 3, False)
    assert vm.created_at is not None
    await db.refresh(dep)
    assert (dep.vm, dep.take_vm_snapshot, dep.vm_snapshot) == (
        True, False, "sirdar-20261004T120000Z")
    plain = _dep(env, status="succeeded")
    db.add(plain)
    await db.commit()
    await db.refresh(plain)
    assert (plain.vm, plain.take_vm_snapshot, plain.vm_snapshot) == (False, False, None)
    await db.execute(delete(Environment).where(Environment.id == env.id))
    await db.commit()
    assert await db.scalar(select(func.count()).select_from(ProxmoxVm)) == 0


async def test_proxmox_vm_constraints(db):
    env, other = await _env(db), await _env(db, name="uat2")
    env_id, other_id = env.id, other.id
    db.add(_vm(env_id, vmid=120))
    await db.commit()
    for bad in (_vm(other_id, name="ss-uat2", vmid=120),          # one VM id, one environment
                _vm(other_id),                                    # the name ss-uat again
                _vm(other_id, name="ss-uat2", ip_cidr=None),      # static needs an address
                _vm(other_id, name="ss-uat2", ip_mode="dhcp"),    # dhcp with an address
                _vm(other_id, name="ss-uat2", ip_mode="bridged"),
                _vm(other_id, name="ss-uat2", cores=0),
                _vm(other_id, name="ss-uat2", memory_mb=1024),
                _vm(other_id, name="ss-uat2", disk_gb=10),
                _vm(other_id, name="ss-uat2", keep_snapshots=11),
                _vm(other_id, name="ss-uat2", vmid=99)):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    db.add(_vm(other_id, name="ss-uat2", ip_mode="dhcp", ip_cidr=None, gateway=None))
    await db.commit()
    db.add(Integration(kind="vsphere"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_migration_0007_round_trip():
    """Downgrading drops the VM restores, the VM steps and the Proxmox
    credentials, and keeps the environments (their VMs would be orphaned)."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
            "VALUES ('vm1', 'dev', 'proxmox', 'vm1.example.com', '10.0.0.2') RETURNING id"
        ).fetchone()[0]
        dep_id = conn.execute(
            "INSERT INTO deployments (environment_id, mode, git_ref, sha, status, start_step, "
            "vm) VALUES (%s, 'vm_restore', %s, %s, 'succeeded', 0, true) RETURNING id",
            (env_id, SHA, SHA)).fetchone()[0]
        conn.execute("INSERT INTO deployment_steps (deployment_id, number, key, name) "
                     "VALUES (%s, 0, 'vm_restore', 'Restore VM snapshot')", (dep_id,))
        conn.execute("INSERT INTO integrations (kind, config) VALUES ('proxmox', '{}')")
    _alembic("downgrade", "0006")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM deployments WHERE id = %s",
                                (dep_id,)).fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM integrations WHERE kind = 'proxmox'"
                                ).fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM environments WHERE id = %s",
                                (env_id,)).fetchone()[0] == 1
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT to_regclass('proxmox_vms') IS NOT NULL").fetchone()[0]
```

`_alembic`, `_env`, `_dep` and `SHA` are the helpers this file already has.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_models.py`
Expected: FAIL — `ImportError: cannot import name 'ProxmoxVm'`.

- [ ] **Step 4: Write the migration**

Create `sirdar/api/migrations/versions/0007_proxmox.py`:

```python
"""Deploy phase 5: Proxmox targets. The proxmox integration kind, the VMs
Sirdar builds (the ownership record), the VM flags of a deployment and the
vm_restore mode.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-04
"""
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox'));
        -- One row per Proxmox environment: Sirdar manages only the VM named
        -- here, by the id it reserved before Terraform created it.
        CREATE TABLE proxmox_vms (
          environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
          node text NOT NULL,
          vmid integer UNIQUE CHECK (vmid BETWEEN 100 AND 999999999),
          name text NOT NULL UNIQUE,
          cores integer NOT NULL CHECK (cores BETWEEN 1 AND 64),
          memory_mb integer NOT NULL CHECK (memory_mb BETWEEN 2048 AND 262144),
          disk_gb integer NOT NULL CHECK (disk_gb BETWEEN 20 AND 4096),
          ip_mode text NOT NULL CHECK (ip_mode IN ('static', 'dhcp')),
          ip_cidr text,
          gateway text,
          ip text,
          ssh_public_key text NOT NULL,
          ssh_private_key_enc bytea NOT NULL,
          keep_snapshots integer NOT NULL DEFAULT 3 CHECK (keep_snapshots BETWEEN 1 AND 10),
          created boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK ((ip_mode = 'static') = (ip_cidr IS NOT NULL AND gateway IS NOT NULL))
        );
        ALTER TABLE deployments
          ADD COLUMN vm boolean NOT NULL DEFAULT false,
          ADD COLUMN take_vm_snapshot boolean NOT NULL DEFAULT false,
          ADD COLUMN vm_snapshot text,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish',
             'teardown', 'vm_restore'));
    """)


def downgrade() -> None:
    # Environments on target 'proxmox' stay: deleting them would orphan their VMs.
    op.execute("""
        DELETE FROM deployments WHERE mode = 'vm_restore';
        DELETE FROM deployment_steps WHERE key IN ('provision', 'vm_restore', 'destroy');
        DELETE FROM integrations WHERE kind = 'proxmox';
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish',
             'teardown')),
          DROP COLUMN vm_snapshot,
          DROP COLUMN take_vm_snapshot,
          DROP COLUMN vm;
        DROP TABLE proxmox_vms;
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check CHECK (kind IN ('cloudflare', 'npm'));
    """)
```

- [ ] **Step 5: Add the models**

In `sirdar/api/src/sirdar_api/db/models.py`, replace:

```python
"""Sirdar's own tables (migrations 0001–0006). `users` mirrors the portal's
```

with:

```python
"""Sirdar's own tables (migrations 0001–0007). `users` mirrors the portal's
```

In the `Deployment` class, replace:

```python
    # update | reset | adopt | snapshot | restore_dump | rollback | publish | teardown
    mode: Mapped[str]
```

with:

```python
    # update | reset | adopt | snapshot | restore_dump | rollback | publish | teardown
    # | vm_restore
    mode: Mapped[str]
```

and replace:

```python
    # Whether its plan has steps 12–14 (migration 0006): retries keep it.
    publish: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    previous_sha: Mapped[str | None]
```

with:

```python
    # Whether its plan has steps 12–14 (migration 0006): retries keep it.
    publish: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # Proxmox (migration 0007): its plan has the VM steps (0 / 15); it asked
    # for a VM snapshot in step 0; the VM snapshot it took (vm_restore: the
    # one it restores). Retries keep all three.
    vm: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    take_vm_snapshot: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    vm_snapshot: Mapped[str | None]
    previous_sha: Mapped[str | None]
```

In the `Integration` class, replace:

```python
    kind: Mapped[str] = mapped_column(primary_key=True)        # cloudflare | npm
```

with:

```python
    kind: Mapped[str] = mapped_column(primary_key=True)        # cloudflare | npm | proxmox
```

Append to the end of `sirdar/api/src/sirdar_api/db/models.py`:

```python
class ProxmoxVm(Base):
    """The VM Sirdar builds on Proxmox for one environment (migration 0007),
    and the record that it is Sirdar's: Sirdar changes or destroys only VM
    `vmid` named `name`. `vmid` is reserved before Terraform creates it;
    `created` turns true after the first successful apply; `ip` is the
    address the guest agent reported. The private key is Fernet-encrypted
    with SIRDAR_SECRETS_KEY and never returned."""

    __tablename__ = "proxmox_vms"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)
    node: Mapped[str]
    vmid: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str]
    cores: Mapped[int] = mapped_column(Integer)
    memory_mb: Mapped[int] = mapped_column(Integer)
    disk_gb: Mapped[int] = mapped_column(Integer)
    ip_mode: Mapped[str]                              # static | dhcp
    ip_cidr: Mapped[str | None]
    gateway: Mapped[str | None]
    ip: Mapped[str | None]
    ssh_public_key: Mapped[str]
    ssh_private_key_enc: Mapped[bytes] = mapped_column(BYTEA)
    keep_snapshots: Mapped[int] = mapped_column(Integer, server_default=text("3"))
    created: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

- [ ] **Step 6: Truncate the new table between tests**

In `sirdar/api/tests/conftest.py`, replace:

```python
                 "deployment_steps, snapshots, integrations, managed_records")
```

with:

```python
                 "deployment_steps, snapshots, integrations, managed_records, proxmox_vms")
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_models.py`
Expected: PASS (every test, including the 0005 and 0006 round trips, which now upgrade through 0007).

- [ ] **Step 8: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 migrations/versions/0007_proxmox.py src/sirdar_api/db/models.py tests/test_deploy_models.py tests/conftest.py && cd ../..
git add sirdar/api/migrations/versions/0007_proxmox.py sirdar/api/src/sirdar_api/db/models.py \
  sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_models.py
git commit -m "feat(sirdar): migration 0007 — proxmox integration kind, proxmox_vms, VM deployment flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: TLS pinning and the Proxmox credentials

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/tls_pin.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/integrations.py`
- Create: `sirdar/api/tests/tls_helpers.py`
- Modify: `sirdar/api/tests/integration_helpers.py`
- Modify: `sirdar/api/tests/conftest.py` (a second autouse guard)
- Test: `sirdar/api/tests/test_deploy_tls_pin.py`, `sirdar/api/tests/test_deploy_integrations.py`

**Interfaces:**
- Consumes: `ConnectFailed`; the existing `integrations` store (`IntegrationError`, `save`, `candidate`, `public`, `_check_same_target`).
- Produces (module `sirdar_api.deploy.tls_pin`): `FETCH_TIMEOUT = 10`; `fingerprint_of(pem: str) -> str` (SHA-256 of the DER, `"AB:CD:…"`, 95 characters; `ValueError` for anything that isn't a PEM certificate); `describe(pem: str) -> dict` (`subject`, `issuer` — common names, `not_after` ISO 8601 UTC, `names` — DNS and IP SANs as strings); `_read_certificate(host: str, port: int) -> str` (blocking; the guarded function); `async fetch_certificate(host: str, port: int) -> str` (raises `ConnectFailed(f"Couldn't reach {host}:{port} over TLS.")`); `pinned_context(pem: str) -> ssl.SSLContext` (that certificate is the only trust anchor; hostname checked; TLS 1.2+).
- Produces (module `sirdar_api.deploy.integrations`): `KINDS = ("cloudflare", "npm", "proxmox")`; `LABELS["proxmox"] = "Proxmox"`; `FIELDS["proxmox"] = ("url", "node", "pool", "storage", "bridge", "vlan_tag", "template_vmid", "tls_fingerprint", "token_id")`; `SECRET_FIELD["proxmox"] = "token"`; frozen dataclass `ProxmoxConfig(url, node, pool, storage, bridge, vlan_tag: int | None, template_vmid: int, tls_fingerprint, tls_cert_pem, token)` (`tls_cert_pem` and `token` `repr=False`) with properties `token_id` and `token_secret`; `check_proxmox_url(value) -> str`; `token_id_of(token: str) -> str`; `async load_proxmox(db, settings) -> ProxmoxConfig | None`; `async config_of(db, kind) -> dict` (a copy of the stored non-secret config, `{}` when none); `async in_use(db, kind) -> list[str]` (names of the environments on `proxmox`; `[]` for the other kinds). `check_fields("proxmox", values)` needs `values["tls_cert_pem"]` matching `values["tls_fingerprint"]` (else `IntegrationError("tls_untrusted")`) and returns the checked fields with `tls_cert_pem`; `save` stores `token_id` in the config.
- Produces (tests): `tests/tls_helpers.py` — `make_cert(cn="pve.lab", ips=("10.10.48.5", "127.0.0.1"), dns=("pve", "localhost")) -> tuple[str, str]` (certificate PEM, key PEM); `tests/integration_helpers.py` — `PX_TOKEN`, `PX_TOKEN_SECRET`, `PX_TOKEN_ID`, `PX_CERT`, `PX_CERT_KEY`, `PX_FINGERPRINT`, `PX_VALUES`, `PX_BODY`, `async configure_proxmox(db)`; conftest autouse fixture `no_real_hosts` (yields a list; fails at teardown when anything was blocked).

- [ ] **Step 1: Write the certificate helper**

Create `sirdar/api/tests/tls_helpers.py`:

```python
"""Self-signed certificates for the TLS pinning tests (Proxmox's own
pve-ssl.pem names the node's addresses the same way)."""

import datetime
import ipaddress

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def make_cert(cn: str = "pve.lab", ips: tuple[str, ...] = ("10.10.48.5", "127.0.0.1"),
              dns: tuple[str, ...] = ("pve", "localhost")) -> tuple[str, str]:
    """(certificate PEM, private key PEM), valid from yesterday for a year."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.UTC)
    sans = [x509.DNSName(d) for d in dns] + [x509.IPAddress(ipaddress.ip_address(i))
                                             for i in ips]
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    return (cert.public_bytes(serialization.Encoding.PEM).decode(),
            key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                              serialization.NoEncryption()).decode())
```

- [ ] **Step 2: Write the failing TLS tests**

Create `sirdar/api/tests/test_deploy_tls_pin.py`:

```python
import asyncio
import hashlib
import ssl
from datetime import UTC, datetime

import pytest

from sirdar_api.deploy import ConnectFailed, tls_pin

from .tls_helpers import make_cert


def test_the_fingerprint_is_sha256_in_proxmox_s_format():
    pem, _ = make_cert()
    der = ssl.PEM_cert_to_DER_cert(pem)
    expected = ":".join(f"{b:02X}" for b in hashlib.sha256(der).digest())
    assert tls_pin.fingerprint_of(pem) == expected
    assert len(expected) == 95


def test_something_that_isn_t_a_certificate():
    with pytest.raises(ValueError):
        tls_pin.fingerprint_of("not a certificate")


def test_describe_names_the_certificate():
    pem, _ = make_cert(cn="pve.lab")
    d = tls_pin.describe(pem)
    assert (d["subject"], d["issuer"]) == ("pve.lab", "pve.lab")
    assert set(d["names"]) == {"pve", "localhost", "10.10.48.5", "127.0.0.1"}
    assert datetime.fromisoformat(d["not_after"]) > datetime.now(UTC)


async def _tls_server(tmp_path, pem: str, key: str):
    (tmp_path / "cert.pem").write_text(pem)
    (tmp_path / "key.pem").write_text(key)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(tmp_path / "cert.pem", tmp_path / "key.pem")

    async def handle(reader, writer):
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0, ssl=ctx)
    return server, server.sockets[0].getsockname()[1]


async def test_the_pinned_certificate_is_the_only_one_trusted(tmp_path):
    pem, key = make_cert()
    impostor, _ = make_cert(cn="impostor")
    server, port = await _tls_server(tmp_path, pem, key)
    async with server:
        _, writer = await asyncio.open_connection("127.0.0.1", port,
                                                  ssl=tls_pin.pinned_context(pem))
        writer.close()
        with pytest.raises(ssl.SSLCertVerificationError):
            await asyncio.open_connection("127.0.0.1", port,
                                          ssl=tls_pin.pinned_context(impostor))


async def test_the_host_must_be_named_in_the_certificate(tmp_path):
    pem, key = make_cert(ips=("10.10.48.5",), dns=("pve",))
    server, port = await _tls_server(tmp_path, pem, key)
    async with server:
        with pytest.raises(ssl.SSLCertVerificationError):
            await asyncio.open_connection("127.0.0.1", port, ssl=tls_pin.pinned_context(pem))


async def test_fetch_reads_the_live_certificate(tmp_path):
    pem, key = make_cert()
    server, port = await _tls_server(tmp_path, pem, key)
    async with server:
        live = await tls_pin.fetch_certificate("127.0.0.1", port)
    assert tls_pin.fingerprint_of(live) == tls_pin.fingerprint_of(pem)


async def test_fetch_says_when_nothing_answers():
    with pytest.raises(ConnectFailed) as e:
        await tls_pin.fetch_certificate("127.0.0.1", 9)
    assert e.value.reason == "Couldn't reach 127.0.0.1:9 over TLS."


async def test_the_guard_refuses_a_real_host(no_real_hosts):
    with pytest.raises(AssertionError):
        await tls_pin.fetch_certificate("10.10.48.5", 8006)
    assert no_real_hosts == ["tls:10.10.48.5"]
    no_real_hosts.clear()
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_tls_pin.py`
Expected: FAIL — `ImportError: cannot import name 'tls_pin'`.

- [ ] **Step 4: Write `tls_pin.py`**

Create `sirdar/api/src/sirdar_api/deploy/tls_pin.py`:

```python
"""Trust-on-first-use pinning of a server's TLS certificate (Proxmox's
self-signed pve-ssl.pem), the TLS twin of known_hosts: the user sees the
fingerprint, Sirdar stores the certificate itself, and every later
connection trusts that certificate and nothing else.

Fingerprints are SHA-256 over the DER bytes, colon-separated uppercase hex:
the format Proxmox shows under Node › System › Certificates."""

import asyncio
import hashlib
import ssl

from cryptography import x509
from cryptography.x509.oid import NameOID

from sirdar_api.deploy import ConnectFailed

FETCH_TIMEOUT = 10


def fingerprint_of(pem: str) -> str:
    """ValueError when `pem` isn't a PEM certificate."""
    der = ssl.PEM_cert_to_DER_cert(pem)
    digest = hashlib.sha256(der).hexdigest().upper()
    return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


def _common_name(name: x509.Name) -> str:
    found = name.get_attributes_for_oid(NameOID.COMMON_NAME)
    return str(found[0].value) if found else name.rfc4514_string()


def describe(pem: str) -> dict:
    """What the trust prompt shows: subject, issuer, expiry and names."""
    cert = x509.load_pem_x509_certificate(pem.encode())
    try:
        sans = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        names = ([str(v) for v in sans.get_values_for_type(x509.DNSName)]
                 + [str(v) for v in sans.get_values_for_type(x509.IPAddress)])
    except x509.ExtensionNotFound:
        names = []
    return {"subject": _common_name(cert.subject), "issuer": _common_name(cert.issuer),
            "not_after": cert.not_valid_after_utc.isoformat(), "names": names}


def _read_certificate(host: str, port: int) -> str:
    """The server's certificate, unverified (that is what pinning decides).
    Tests replace this function (conftest's no_real_hosts guard)."""
    return ssl.get_server_certificate((host, port), timeout=FETCH_TIMEOUT)


async def fetch_certificate(host: str, port: int) -> str:
    try:
        return await asyncio.to_thread(_read_certificate, host, port)
    except (OSError, ssl.SSLError, ValueError):
        raise ConnectFailed(f"Couldn't reach {host}:{port} over TLS.") from None


def pinned_context(pem: str) -> ssl.SSLContext:
    """A client context whose only trust anchor is this certificate. Partial
    chains are allowed so a leaf can anchor itself; the host name is still
    checked against the certificate's names."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)          # CERT_REQUIRED, check_hostname
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_verify_locations(cadata=pem)
    ctx.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx
```

- [ ] **Step 5: Add the guard**

In `sirdar/api/tests/conftest.py`, append at the end:

```python
@pytest.fixture(autouse=True)
def no_real_hosts():
    """No test reaches a real Proxmox host outside httpx: the raw TLS
    certificate fetch may only dial 127.0.0.1 (the tests' own TLS server).
    Later tasks add Terraform and the provisioner's port probe here. Yields
    the list of blocked attempts (a test that blocks on purpose clears it);
    the test fails at teardown if any is left. Its own MonkeyPatch, like
    no_real_http."""
    from sirdar_api.deploy import tls_pin

    hits: list[str] = []
    real_read = tls_pin._read_certificate

    def read(host, port):
        if host != "127.0.0.1":
            hits.append(f"tls:{host}")
            raise AssertionError(f"a test fetched a real TLS certificate from {host}")
        return real_read(host, port)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(tls_pin, "_read_certificate", read)
        yield hits
    assert not hits, f"a test reached real hosts: {', '.join(hits)}"
```

- [ ] **Step 6: Run the TLS tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_tls_pin.py`
Expected: PASS (8 tests).

- [ ] **Step 7: Write the credential test helpers**

In `sirdar/api/tests/integration_helpers.py`, replace:

```python
from sirdar_api.config import get_settings
from sirdar_api.deploy import integrations
```

with:

```python
from sirdar_api.config import get_settings
from sirdar_api.deploy import integrations, tls_pin

from .tls_helpers import make_cert
```

and append at the end of the file:

```python
PX_TOKEN_ID = "sirdar@pve!sirdar"
PX_TOKEN_SECRET = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"
PX_TOKEN = f"{PX_TOKEN_ID}={PX_TOKEN_SECRET}"
PX_CERT, PX_CERT_KEY = make_cert()
PX_FINGERPRINT = tls_pin.fingerprint_of(PX_CERT)
PX_VALUES = {"url": "https://10.10.48.5:8006", "node": "pve", "pool": "sirdar",
             "storage": "local-lvm", "bridge": "vmbr0", "vlan_tag": None,
             "template_vmid": 9000, "tls_fingerprint": PX_FINGERPRINT, "tls_cert_pem": PX_CERT}
# What the Settings modal sends (no certificate: the API fetches it).
PX_BODY = {k: v for k, v in PX_VALUES.items() if k != "tls_cert_pem"}


async def configure_proxmox(db) -> None:
    """Save the Proxmox integration (needs the secrets_key fixture) and commit."""
    await integrations.save(db, get_settings(), "proxmox", PX_VALUES, PX_TOKEN, actor_id=None)
    await db.commit()
```

- [ ] **Step 8: Write the failing store tests**

In `sirdar/api/tests/test_deploy_integrations.py`, replace the import block's helpers line:

```python
from .integration_helpers import CF_TOKEN, CF_VALUES, NPM_PASSWORD, NPM_VALUES, configure
```

with:

```python
from .deploy_factories import make_environment
from .integration_helpers import (
    CF_TOKEN,
    CF_VALUES,
    NPM_PASSWORD,
    NPM_VALUES,
    PX_FINGERPRINT,
    PX_TOKEN,
    PX_TOKEN_ID,
    PX_TOKEN_SECRET,
    PX_VALUES,
    configure,
    configure_proxmox,
)
from .tls_helpers import make_cert
```

In `test_public_view_never_carries_a_secret`, replace:

```python
        "npm": {"configured": False, "url": None, "identity": None, "letsencrypt_email": None,
                "password_set": False, "updated_at": None, "updated_by_name": None},
    }
```

with:

```python
        "npm": {"configured": False, "url": None, "identity": None, "letsencrypt_email": None,
                "password_set": False, "updated_at": None, "updated_by_name": None},
        "proxmox": {"configured": False, "url": None, "node": None, "pool": None,
                    "storage": None, "bridge": None, "vlan_tag": None, "template_vmid": None,
                    "tls_fingerprint": None, "token_id": None, "token_set": False,
                    "updated_at": None, "updated_by_name": None},
    }
```

Append to the end of `sirdar/api/tests/test_deploy_integrations.py`:

```python
async def test_save_and_load_proxmox(db, secrets_key):
    changed = await integrations.save(db, get_settings(), "proxmox", PX_VALUES, PX_TOKEN,
                                      actor_id=None)
    await db.commit()
    assert set(changed) == {"url", "node", "pool", "storage", "bridge", "template_vmid",
                            "tls_fingerprint", "tls_cert_pem", "token_id", "token"}
    row = await db.get(Integration, "proxmox")
    assert row.config["token_id"] == PX_TOKEN_ID
    assert PX_TOKEN_SECRET not in repr(row.config)
    assert PX_TOKEN.encode() not in bytes(row.secret_enc)
    cfg = await integrations.load_proxmox(db, get_settings())
    assert (cfg.url, cfg.node, cfg.template_vmid, cfg.vlan_tag, cfg.token) == (
        "https://10.10.48.5:8006", "pve", 9000, None, PX_TOKEN)
    assert (cfg.token_id, cfg.token_secret) == (PX_TOKEN_ID, PX_TOKEN_SECRET)
    assert PX_TOKEN_SECRET not in repr(cfg) and "BEGIN CERTIFICATE" not in repr(cfg)
    view = (await integrations.public(db, get_settings()))["proxmox"]
    assert (view["configured"], view["token_set"], view["token_id"], view["tls_fingerprint"]) == (
        True, True, PX_TOKEN_ID, PX_FINGERPRINT)
    assert "tls_cert_pem" not in view and PX_TOKEN_SECRET not in repr(view)


@pytest.mark.parametrize("field,value,code", [
    ("url", "http://10.10.48.5:8006", "proxmox_url_invalid"),
    ("url", "https://10.10.48.5:8006/api2/json", "proxmox_url_invalid"),
    ("node", "pve node", "node_invalid"),
    ("pool", "", "pool_invalid"),
    ("storage", "1local", "storage_invalid"),
    ("bridge", "vmbr0-much-too-long", "bridge_invalid"),
    ("vlan_tag", 4095, "vlan_tag_invalid"),
    ("vlan_tag", "12", "vlan_tag_invalid"),
    ("template_vmid", 99, "template_vmid_invalid"),
    ("template_vmid", True, "template_vmid_invalid"),
    ("tls_fingerprint", "AB:CD", "tls_untrusted"),
    ("tls_cert_pem", None, "tls_untrusted"),
])
def test_proxmox_fields_are_checked(field, value, code):
    with pytest.raises(IntegrationError) as e:
        integrations.check_fields("proxmox", {**PX_VALUES, field: value})
    assert e.value.code == code


def test_the_pinned_certificate_must_match_the_fingerprint():
    other, _ = make_cert(cn="impostor")
    with pytest.raises(IntegrationError) as e:
        integrations.check_fields("proxmox", {**PX_VALUES, "tls_cert_pem": other})
    assert e.value.code == "tls_untrusted"
    lower = {**PX_VALUES, "tls_fingerprint": PX_FINGERPRINT.lower(), "vlan_tag": 40}
    assert integrations.check_fields("proxmox", lower)["tls_fingerprint"] == PX_FINGERPRINT


@pytest.mark.parametrize("token", [
    PX_TOKEN_ID, f"sirdar@pve={PX_TOKEN_SECRET}", f"{PX_TOKEN_ID}=not-a-uuid",
    f"{PX_TOKEN}\n", f"root@pam {PX_TOKEN}"])
def test_proxmox_tokens_are_checked(token):
    with pytest.raises(IntegrationError) as e:
        integrations.check_secret("proxmox", token)
    assert e.value.code == "proxmox_token_invalid"


async def test_a_stored_proxmox_token_goes_only_to_its_own_server(db, secrets_key):
    await configure_proxmox(db)
    changed = await integrations.save(db, get_settings(), "proxmox",
                                      {**PX_VALUES, "storage": "fast"}, None, actor_id=None)
    assert changed == ["storage"]
    assert (await integrations.config_of(db, "proxmox"))["token_id"] == PX_TOKEN_ID
    with pytest.raises(IntegrationError) as e:
        await integrations.candidate(db, get_settings(), "proxmox",
                                     {**PX_VALUES, "url": "https://10.10.48.9:8006"}, None)
    assert e.value.code == "secret_required"


async def test_in_use_names_the_proxmox_environments(db, secrets_key):
    await make_environment(db, name="uat3", target_id="proxmox")
    await make_environment(db, name="uat")
    assert await integrations.in_use(db, "proxmox") == ["uat3"]
    assert await integrations.in_use(db, "npm") == []
    assert await integrations.config_of(db, "cloudflare") == {}
```

- [ ] **Step 9: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_integrations.py`
Expected: FAIL — `AttributeError: module 'sirdar_api.deploy.integrations' has no attribute 'load_proxmox'` (and the public view test fails on the missing `proxmox` part).

- [ ] **Step 10: Add the `proxmox` kind to the store**

In `sirdar/api/src/sirdar_api/deploy/integrations.py`:

Replace the module docstring's first two lines:

```python
"""Integration credentials Sirdar publishes with (phase 4): the Cloudflare
API token and the Nginx Proxy Manager login, plus their non-secret settings.
```

with:

```python
"""Integration credentials: the Cloudflare API token and the Nginx Proxy
Manager login Sirdar publishes with (phase 4), and the Proxmox API token it
builds VMs with (phase 5), plus their non-secret settings. Proxmox's config
also holds the pinned TLS certificate (tls_pin) and the token's id part.
```

Replace:

```python
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Integration, User
from sirdar_api.deploy import envfile, vault

KINDS = ("cloudflare", "npm")
LABELS = {"cloudflare": "Cloudflare", "npm": "Nginx Proxy Manager"}
FIELDS = {"cloudflare": ("zone", "public_ip"), "npm": ("url", "identity", "letsencrypt_email")}
SECRET_FIELD = {"cloudflare": "token", "npm": "password"}
```

with:

```python
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Environment, Integration, User
from sirdar_api.deploy import envfile, tls_pin, vault

KINDS = ("cloudflare", "npm", "proxmox")
LABELS = {"cloudflare": "Cloudflare", "npm": "Nginx Proxy Manager", "proxmox": "Proxmox"}
FIELDS = {"cloudflare": ("zone", "public_ip"), "npm": ("url", "identity", "letsencrypt_email"),
          "proxmox": ("url", "node", "pool", "storage", "bridge", "vlan_tag", "template_vmid",
                      "tls_fingerprint", "token_id")}
SECRET_FIELD = {"cloudflare": "token", "npm": "password", "proxmox": "token"}
```

Replace:

```python
TARGET_FIELDS = {"cloudflare": ("zone",), "npm": ("url", "identity")}
NEW_TARGET_REASON = {
    "cloudflare": "Enter the token again to use it with a different zone.",
    "npm": "Enter the password again to use it with a different server or login.",
}
```

with:

```python
TARGET_FIELDS = {"cloudflare": ("zone",), "npm": ("url", "identity"), "proxmox": ("url",)}
NEW_TARGET_REASON = {
    "cloudflare": "Enter the token again to use it with a different zone.",
    "npm": "Enter the password again to use it with a different server or login.",
    "proxmox": "Enter the API token again to use it with a different Proxmox server.",
}
# The environment target that builds its host on Proxmox (targets.PROXMOX_TARGET).
PROXMOX_TARGET = "proxmox"
```

Replace:

```python
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}")
```

with:

```python
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}")
_PVE_URL_RE = re.compile(r"https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?")
_NODE_RE = re.compile(r"[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_POOL_RE = re.compile(r"[A-Za-z0-9_.-]{1,40}")
_STORAGE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,62}")
_BRIDGE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,14}")
# user@realm!tokenid=<uuid>: the id part is shown, the uuid is the secret.
_PVE_TOKEN_RE = re.compile(
    r"([A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}![A-Za-z][A-Za-z0-9._-]{1,63})="
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")
_FINGERPRINT_RE = re.compile(r"([0-9A-F]{2}:){31}[0-9A-F]{2}")
```

Replace:

```python
@dataclass(frozen=True)
class NpmConfig:
    url: str
    identity: str
    letsencrypt_email: str
    password: str = field(repr=False)
```

with:

```python
@dataclass(frozen=True)
class NpmConfig:
    url: str
    identity: str
    letsencrypt_email: str
    password: str = field(repr=False)


@dataclass(frozen=True)
class ProxmoxConfig:
    url: str
    node: str
    pool: str
    storage: str
    bridge: str
    vlan_tag: int | None
    template_vmid: int
    tls_fingerprint: str
    tls_cert_pem: str = field(repr=False)
    token: str = field(repr=False)          # user@realm!tokenid=<uuid>

    @property
    def token_id(self) -> str:
        return token_id_of(self.token)

    @property
    def token_secret(self) -> str:
        return self.token.split("=", 1)[1]


def token_id_of(token: str) -> str:
    return token.split("=", 1)[0]
```

Replace:

```python
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
```

with:

```python
def check_proxmox_url(value) -> str:
    url = str(value or "").strip().rstrip("/")
    if not _PVE_URL_RE.fullmatch(url):
        raise IntegrationError("proxmox_url_invalid")
    return url


def _int_in(value, low: int, high: int, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise IntegrationError(code)
    return value


def _check_proxmox(values: dict) -> dict:
    """Also needs the certificate the route fetched and the user trusted:
    `tls_cert_pem` must have the fingerprint `tls_fingerprint`."""
    url = check_proxmox_url(values.get("url"))

    def text(key: str, regex: re.Pattern, code: str) -> str:
        value = str(values.get(key) or "").strip()
        if not regex.fullmatch(value):
            raise IntegrationError(code)
        return value

    node = text("node", _NODE_RE, "node_invalid")
    pool = text("pool", _POOL_RE, "pool_invalid")
    storage = text("storage", _STORAGE_RE, "storage_invalid")
    bridge = text("bridge", _BRIDGE_RE, "bridge_invalid")
    vlan = values.get("vlan_tag")
    vlan = None if vlan is None else _int_in(vlan, 1, 4094, "vlan_tag_invalid")
    template = _int_in(values.get("template_vmid"), 100, 999_999_999, "template_vmid_invalid")
    fingerprint = str(values.get("tls_fingerprint") or "").strip().upper()
    pem = values.get("tls_cert_pem")
    if not _FINGERPRINT_RE.fullmatch(fingerprint) or not isinstance(pem, str):
        raise IntegrationError("tls_untrusted")
    try:
        actual = tls_pin.fingerprint_of(pem)
    except ValueError:
        raise IntegrationError("tls_untrusted") from None
    if actual != fingerprint:
        raise IntegrationError("tls_untrusted")
    return {"url": url, "node": node, "pool": pool, "storage": storage, "bridge": bridge,
            "vlan_tag": vlan, "template_vmid": template, "tls_fingerprint": fingerprint,
            "tls_cert_pem": pem}


_CHECKS = {"cloudflare": _check_cloudflare, "npm": _check_npm, "proxmox": _check_proxmox}


def check_fields(kind: str, values: dict) -> dict:
    return _CHECKS[kind](values)


def check_secret(kind: str, value: str) -> str:
    if kind == "cloudflare":
        if not isinstance(value, str) or not _TOKEN_RE.fullmatch(value):
            raise IntegrationError("token_invalid")
    elif kind == "proxmox":
        if not isinstance(value, str) or not _PVE_TOKEN_RE.fullmatch(value):
            raise IntegrationError("proxmox_token_invalid")
    elif (not isinstance(value, str) or not value or len(value) > PASSWORD_MAX
          or envfile.unsafe_value(value)):
        raise IntegrationError("password_invalid")
    return value


def _config(kind: str, config: dict,
            secret: str) -> CloudflareConfig | NpmConfig | ProxmoxConfig:
    if kind == "cloudflare":
        return CloudflareConfig(zone=config["zone"], public_ip=config["public_ip"], token=secret)
    if kind == "proxmox":
        return ProxmoxConfig(url=config["url"], node=config["node"], pool=config["pool"],
                             storage=config["storage"], bridge=config["bridge"],
                             vlan_tag=config.get("vlan_tag"),
                             template_vmid=config["template_vmid"],
                             tls_fingerprint=config["tls_fingerprint"],
                             tls_cert_pem=config["tls_cert_pem"], token=secret)
    return NpmConfig(url=config["url"], identity=config["identity"],
                     letsencrypt_email=config.get("letsencrypt_email") or config["identity"],
                     password=secret)
```

Replace:

```python
async def load_npm(db: AsyncSession, settings: Settings) -> NpmConfig | None:
    return await load(db, settings, "npm")
```

with:

```python
async def load_npm(db: AsyncSession, settings: Settings) -> NpmConfig | None:
    return await load(db, settings, "npm")


async def load_proxmox(db: AsyncSession, settings: Settings) -> ProxmoxConfig | None:
    return await load(db, settings, "proxmox")


async def config_of(db: AsyncSession, kind: str) -> dict:
    """The stored non-secret settings (a copy), {} when none."""
    row = await _row(db, kind)
    return dict(row.config) if row else {}


async def in_use(db: AsyncSession, kind: str) -> list[str]:
    """Environments that can't lose this integration: those built on
    Proxmox (their VMs could no longer be destroyed)."""
    if kind != "proxmox":
        return []
    return list(await db.scalars(select(Environment.name)
                                 .where(Environment.target_id == PROXMOX_TARGET)
                                 .order_by(Environment.name)))
```

In `save`, replace:

```python
    if secret is not None and not vault.is_configured(settings):
        raise IntegrationError("secrets_key_missing")
    if row is None:
```

with:

```python
    if secret is not None and not vault.is_configured(settings):
        raise IntegrationError("secrets_key_missing")
    if kind == "proxmox":
        checked["token_id"] = (token_id_of(secret) if secret is not None
                               else row.config.get("token_id"))
    if row is None:
```

The return annotations of `load` and `candidate` (`-> CloudflareConfig | NpmConfig | None` and `-> CloudflareConfig | NpmConfig`) gain `| ProxmoxConfig`.

- [ ] **Step 11: Run the store tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_integrations.py tests/test_deploy_tls_pin.py`
Expected: PASS.

- [ ] **Step 12: Run the integration API tests (unchanged behavior)**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_integrations_api.py`
Expected: PASS (Cloudflare and NPM behave as before).

- [ ] **Step 13: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/tls_pin.py src/sirdar_api/deploy/integrations.py tests/tls_helpers.py tests/integration_helpers.py tests/conftest.py tests/test_deploy_tls_pin.py tests/test_deploy_integrations.py && cd ../..
git add sirdar/api/src/sirdar_api/deploy/tls_pin.py sirdar/api/src/sirdar_api/deploy/integrations.py \
  sirdar/api/tests/tls_helpers.py sirdar/api/tests/integration_helpers.py sirdar/api/tests/conftest.py \
  sirdar/api/tests/test_deploy_tls_pin.py sirdar/api/tests/test_deploy_integrations.py
git commit -m "feat(sirdar): pinned TLS certificates and write-only Proxmox credentials

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: The Proxmox API client and its fake

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/proxmox.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/outbound.py`
- Create: `sirdar/api/tests/fake_proxmox.py`, `sirdar/api/tests/proxmox_helpers.py`
- Test: `sirdar/api/tests/test_deploy_proxmox.py`

**Interfaces:**
- Consumes: `ProxmoxConfig` (Task 2), `tls_pin.pinned_context`, `Check`, `ConnectFailed`, `ConnectResult`.
- Produces (module `sirdar_api.deploy.proxmox`) — `agent_ipv4` skips the interfaces `lo`, `docker*`, `br-*` and `veth*` (not addresses by value, so tests can report 127.0.0.1 on `eth0`): `DEFAULT_PORT = 8006`; `TLS_CHANGED` (copy); `class ProxmoxError(Exception)` (`.reason`, `.status`); `class AgentNotReady(ProxmoxError)`; `split_url(url) -> tuple[str, int]`; `class Proxmox` (async context manager; `Proxmox(cfg, *, transport=None, sleep=asyncio.sleep, task_poll=2.0, task_timeout=900)`) with `async version() -> str`, `nodes() -> list[str]`, `next_vmid() -> int`, `pool_vmids() -> set[int]`, `vms() -> dict[int, dict]` (`{"name", "status", "template": bool, "tags": tuple[str, ...]}`), `vm_config(vmid) -> dict`, `status(vmid) -> str`, `storage_status() -> dict`, `bridge() -> dict`, `agent_ipv4(vmid) -> list[str]` (no loopback or link-local; `AgentNotReady` when the agent doesn't answer), `agent_file(vmid, path) -> str` (`AgentNotReady` likewise), `snapshots(vmid) -> list[dict]` (without `current`), `take_snapshot(vmid, name, description)`, `rollback(vmid, name)`, `delete_snapshot(vmid, name)`, `start(vmid)` (each waits for its task), `wait(upid, what)`; `async test_connection(cfg, *, transport=None) -> ConnectResult` (`ConnectFailed` when Proxmox can't be reached or refuses the token).
- Produces (`outbound.KINDS`): adds `"proxmox"`.
- Produces (tests): `tests/fake_proxmox.py` — `FakeProxmox` (`transport()`, `add_vm(vmid, name, *, status="running", tags=None, ips=(), host_key=None)`, `remove_vm(vmid)`, fields `vms`, `pool_members`, `next_id`, `storage`, `bridges`, `agent`, `snaps`, `requests`, `fail[(method, path)] = status`, `task_result[action] = exitstatus`, `running_polls`, `tls_error`, `rolled_back`); `tests/proxmox_helpers.py` — fixture `proxmox_fake` (a `FakeProxmox` wired into `outbound.transports()["proxmox"]`), `async no_sleep(_)`.

- [ ] **Step 1: Add the transport kind**

In `sirdar/api/src/sirdar_api/deploy/outbound.py`, replace:

```python
"""The one switch for Sirdar's outbound HTTP to publish environments
(Cloudflare, Nginx Proxy Manager, smoke tests): every client gets its
```

with:

```python
"""The one switch for Sirdar's outbound HTTP (Cloudflare, Nginx Proxy
Manager, smoke tests, the Proxmox API): every client gets its
```

and replace:

```python
KINDS = ("cloudflare", "npm", "smoke")
```

with:

```python
KINDS = ("cloudflare", "npm", "smoke", "proxmox")
```

- [ ] **Step 2: Write the fake**

Create `sirdar/api/tests/fake_proxmox.py`:

```python
"""A stateful Proxmox VE API for tests: an httpx MockTransport handler that
checks the token header and answers the endpoints Sirdar's client calls.
Tasks finish at once (after `running_polls` "running" answers) with
`task_result[action]`, default "OK"."""

import re
import ssl
from urllib.parse import parse_qs

import httpx

from .integration_helpers import PX_TOKEN

TEMPLATE = 9000


class FakeProxmox:
    def __init__(self, *, node: str = "pve", pool: str = "sirdar"):
        self.node, self.pool = node, pool
        self.version = "9.0.10"
        self.vms: dict[int, dict] = {TEMPLATE: {
            "name": "ubuntu-2404-template", "template": 1, "status": "stopped", "tags": "",
            "config": {"agent": "1", "scsi0": "local-lvm:base-9000-disk-0,size=3584M"}}}
        self.pool_members: set[int] = {TEMPLATE}
        self.next_id = 120
        self.storage = {"active": 1, "enabled": 1, "content": "images,rootdir",
                        "avail": 500 * 1024 ** 3, "total": 900 * 1024 ** 3}
        self.bridges = {"vmbr0"}
        self.agent: dict[int, dict] = {}         # vmid -> {"ips": [...], "host_key": str}
        self.snaps: dict[int, list[dict]] = {}
        self.tasks: dict[str, str] = {}
        self.polls: dict[str, int] = {}
        self.running_polls = 0
        self.requests: list[tuple[str, str]] = []
        self.fail: dict[tuple[str, str], int] = {}
        self.task_result: dict[str, str] = {}
        self.tls_error = False
        self.rolled_back: list[tuple[int, str]] = []
        self._n = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def add_vm(self, vmid: int, name: str, *, status: str = "running", tags: str | None = None,
               ips: tuple[str, ...] = (), host_key: str | None = None) -> None:
        self.vms[vmid] = {"name": name, "template": 0, "status": status,
                          "tags": f"sirdar;{name}" if tags is None else tags,
                          "config": {"agent": "1"}}
        self.pool_members.add(vmid)
        self.agent[vmid] = {"ips": list(ips), "host_key": host_key}

    def remove_vm(self, vmid: int) -> None:
        for table in (self.vms, self.agent, self.snaps):
            table.pop(vmid, None)
        self.pool_members.discard(vmid)

    def _task(self, action: str) -> str:
        self._n += 1
        upid = f"UPID:{self.node}:{self._n:08X}:00000000:00000000:{action}:100:sirdar@pve!sirdar:"
        self.tasks[upid] = self.task_result.get(action, "OK")
        self.polls[upid] = 0
        return upid

    @staticmethod
    def _ok(data) -> httpx.Response:
        return httpx.Response(200, json={"data": data})

    @staticmethod
    def _err(status: int) -> httpx.Response:
        return httpx.Response(status, json={"data": None, "message": "fake proxmox error"})

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.tls_error:
            raise httpx.ConnectError("handshake failed") from ssl.SSLCertVerificationError(
                "certificate verify failed")
        path = request.url.path.removeprefix("/api2/json")
        method = request.method
        self.requests.append((method, path))
        if request.headers.get("authorization") != f"PVEAPIToken={PX_TOKEN}":
            return self._err(401)
        if (method, path) in self.fail:
            return self._err(self.fail[(method, path)])
        form = parse_qs(request.content.decode()) if request.content else {}
        n = f"/nodes/{self.node}"
        if path == "/version":
            return self._ok({"version": self.version, "release": "9.0"})
        if path == "/nodes":
            return self._ok([{"node": self.node, "status": "online"}])
        if path == "/cluster/nextid":
            return self._ok(str(self.next_id))
        if path == f"/pools/{self.pool}":
            return self._ok({"members": [{"vmid": v, "type": "qemu"}
                                         for v in sorted(self.pool_members)]})
        if path == f"{n}/qemu":
            return self._ok([{"vmid": v, "name": d["name"], "status": d["status"],
                              "template": d["template"], "tags": d["tags"]}
                             for v, d in self.vms.items()])
        if path == f"{n}/storage/local-lvm/status":
            return self._ok(self.storage)
        bridge = re.fullmatch(rf"{n}/network/([^/]+)", path)
        if bridge:
            return (self._ok({"iface": bridge[1], "type": "bridge"})
                    if bridge[1] in self.bridges else self._err(500))
        task = re.fullmatch(rf"{n}/tasks/([^/]+)/status", path)
        if task:
            upid = task[1]
            if upid not in self.tasks:
                return self._err(404)
            self.polls[upid] += 1
            if self.polls[upid] <= self.running_polls:
                return self._ok({"status": "running"})
            return self._ok({"status": "stopped", "exitstatus": self.tasks[upid]})
        vm = re.fullmatch(rf"{n}/qemu/(\d+)(/.*)?", path)
        if vm:
            return self._vm(int(vm[1]), vm[2] or "", method, request, form)
        return self._err(404)

    def _vm(self, vmid: int, rest: str, method: str, request: httpx.Request,
            form: dict) -> httpx.Response:
        vm = self.vms.get(vmid)
        if vm is None:
            return self._err(500)                  # Proxmox: "Configuration file ... does not exist"
        agent = self.agent.get(vmid)
        live = vm["status"] == "running"
        if rest == "/config":
            return self._ok(vm["config"])
        if rest == "/status/current":
            return self._ok({"status": vm["status"]})
        if rest == "/status/start" and method == "POST":
            vm["status"] = "running"
            return self._ok(self._task("qmstart"))
        if rest == "/agent/network-get-interfaces":
            if agent is None or not live:
                return self._err(500)              # "QEMU guest agent is not running"
            eth0 = [{"ip-address-type": "ipv4", "ip-address": ip, "prefix": 24}
                    for ip in agent["ips"]]
            eth0 += [{"ip-address-type": "ipv4", "ip-address": "169.254.10.1", "prefix": 16},
                     {"ip-address-type": "ipv6", "ip-address": "fe80::1", "prefix": 64}]
            return self._ok({"result": [
                {"name": "lo", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "127.0.0.1", "prefix": 8}]},
                {"name": "eth0", "ip-addresses": eth0},
                {"name": "docker0", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "172.17.0.1", "prefix": 16}]}]})
        if rest == "/agent/file-read":
            if (agent is None or not live or agent.get("host_key") is None
                    or request.url.params.get("file") != "/etc/ssh/ssh_host_ed25519_key.pub"):
                return self._err(500)
            return self._ok({"content": agent["host_key"] + "\n"})
        if rest == "/snapshot" and method == "GET":
            return self._ok([*self.snaps.get(vmid, []),
                             {"name": "current", "description": "You are here!"}])
        if rest == "/snapshot" and method == "POST":
            self.snaps.setdefault(vmid, []).append({
                "name": form["snapname"][0], "description": form.get("description", [""])[0],
                "snaptime": 1_790_000_000, "vmstate": int(form.get("vmstate", ["0"])[0])})
            return self._ok(self._task("qmsnapshot"))
        snap = re.fullmatch(r"/snapshot/([^/]+)(/rollback)?", rest)
        if snap:
            name = snap[1]
            if not any(s["name"] == name for s in self.snaps.get(vmid, [])):
                return self._err(500)
            if snap[2] and method == "POST":
                vm["status"] = "stopped"
                self.rolled_back.append((vmid, name))
                return self._ok(self._task("qmrollback"))
            if not snap[2] and method == "DELETE":
                self.snaps[vmid] = [s for s in self.snaps[vmid] if s["name"] != name]
                return self._ok(self._task("qmdelsnapshot"))
        return self._err(404)
```

Create `sirdar/api/tests/proxmox_helpers.py`:

```python
"""The fake Proxmox wired into outbound.transports(), for every test that
reaches the Proxmox API through Sirdar's client."""

import pytest

from sirdar_api.deploy import outbound

from .fake_proxmox import FakeProxmox


async def no_sleep(_seconds: float) -> None:
    return None


@pytest.fixture
def proxmox_fake(monkeypatch):
    fake = FakeProxmox()
    earlier = outbound.transports
    monkeypatch.setattr(outbound, "transports",
                        lambda: {**earlier(), "proxmox": fake.transport()})
    return fake
```

- [ ] **Step 3: Write the failing tests**

Create `sirdar/api/tests/test_deploy_proxmox.py`:

```python
from dataclasses import replace

import pytest

from sirdar_api.deploy import ConnectFailed, proxmox
from sirdar_api.deploy.integrations import ProxmoxConfig
from sirdar_api.deploy.proxmox import AgentNotReady, Proxmox, ProxmoxError

from .fake_proxmox import FakeProxmox
from .integration_helpers import PX_CERT, PX_FINGERPRINT, PX_TOKEN, PX_TOKEN_SECRET
from .proxmox_helpers import no_sleep

CFG = ProxmoxConfig(url="https://10.10.48.5:8006", node="pve", pool="sirdar",
                    storage="local-lvm", bridge="vmbr0", vlan_tag=None, template_vmid=9000,
                    tls_fingerprint=PX_FINGERPRINT, tls_cert_pem=PX_CERT, token=PX_TOKEN)
HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheTests0000000000000000000 root@vm"


def api(fake: FakeProxmox, cfg: ProxmoxConfig = CFG, **kw) -> Proxmox:
    return Proxmox(cfg, transport=fake.transport(), sleep=no_sleep, **kw)


def test_split_url():
    assert proxmox.split_url("https://10.10.48.5:8006") == ("10.10.48.5", 8006)
    assert proxmox.split_url("https://pve.lab") == ("pve.lab", 8006)


async def test_a_healthy_host_passes_every_check():
    fake = FakeProxmox()
    result = await proxmox.test_connection(CFG, transport=fake.transport())
    assert result.ok and result.target == "proxmox"
    assert [(c.label, c.status) for c in result.checks] == [
        ("Proxmox", "pass"), ("Node", "pass"), ("Pool", "pass"), ("Template", "pass"),
        ("Storage", "pass"), ("Bridge", "pass")]
    values = {c.label: c.value for c in result.checks}
    assert values["Proxmox"] == "Version 9.0.10"
    assert values["Pool"] == "sirdar · 1 VMs"
    assert values["Template"] == "ubuntu-2404-template (9000)"
    assert values["Storage"] == "local-lvm · 500 GB free"
    assert result.facts == {"url": "https://10.10.48.5:8006", "node": "pve",
                            "version": "9.0.10", "fingerprint": PX_FINGERPRINT,
                            "token_id": "sirdar@pve!sirdar"}
    assert PX_TOKEN_SECRET not in repr(result.as_dict())


async def test_problems_show_as_failed_checks():
    fake = FakeProxmox()
    fake.vms[9000]["template"] = 0
    fake.storage["active"] = 0
    fake.bridges = set()
    fake.fail[("GET", "/pools/sirdar")] = 403
    result = await proxmox.test_connection(CFG, transport=fake.transport())
    assert not result.ok
    by = {c.label: (c.status, c.value) for c in result.checks}
    assert by["Template"] == ("fail", "VM 9000 (ubuntu-2404-template) isn't a template.")
    assert by["Storage"] == ("fail", "local-lvm isn't active or can't hold VM disks.")
    assert by["Bridge"] == ("fail", "No bridge named vmbr0 on pve.")
    assert by["Pool"] == ("fail", "The API token isn't allowed to read the pool. Check its "
                                  "privileges (see the README).")


async def test_a_template_outside_the_pool_and_an_unreadable_network():
    fake = FakeProxmox()
    del fake.vms[9000]
    fake.fail[("GET", "/nodes/pve/network/vmbr0")] = 403
    result = await proxmox.test_connection(CFG, transport=fake.transport())
    by = {c.label: (c.status, c.value) for c in result.checks}
    assert by["Template"] == ("fail", "VM 9000 isn't visible to the token. Is it in the sirdar "
                                      "pool?")
    assert by["Bridge"] == ("warn", "vmbr0 · can't check it (the token can't read the node's "
                                    "network)")


async def test_a_refused_token_or_a_changed_certificate_is_a_connect_failure():
    fake = FakeProxmox()
    bad = replace(CFG, token="sirdar@pve!sirdar=00000000-0000-4000-8000-000000000000")
    with pytest.raises(ConnectFailed) as e:
        await proxmox.test_connection(bad, transport=fake.transport())
    assert e.value.reason == "Proxmox rejected the API token."
    fake.tls_error = True
    with pytest.raises(ConnectFailed) as e:
        await proxmox.test_connection(CFG, transport=fake.transport())
    assert e.value.reason == proxmox.TLS_CHANGED


async def test_vm_ids_and_the_vm_list():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3", ips=("10.10.48.70",))
    async with api(fake) as px:
        assert await px.next_vmid() == 120
        vms = await px.vms()
        assert vms[120] == {"name": "ss-uat3", "status": "running", "template": False,
                            "tags": ("sirdar", "ss-uat3")}
        assert vms[9000]["template"] is True
        assert await px.pool_vmids() == {120, 9000}
        assert await px.status(120) == "running"


async def test_the_guest_agent():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3", ips=("10.10.48.70",), host_key=HOST_KEY)
    async with api(fake) as px:
        assert await px.agent_ipv4(120) == ["10.10.48.70"]
        assert (await px.agent_file(120, "/etc/ssh/ssh_host_ed25519_key.pub")).strip() == HOST_KEY
        fake.vms[120]["status"] = "stopped"
        with pytest.raises(AgentNotReady):
            await px.agent_ipv4(120)
        with pytest.raises(AgentNotReady):
            await px.agent_file(120, "/etc/ssh/ssh_host_ed25519_key.pub")


async def test_snapshots_rollback_start_and_delete():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3")
    fake.running_polls = 2
    async with api(fake) as px:
        await px.take_snapshot(120, "sirdar-20261004T120000Z", "before update")
        snaps = await px.snapshots(120)
        assert [(s["name"], s["description"], s["vmstate"]) for s in snaps] == [
            ("sirdar-20261004T120000Z", "before update", 0)]
        await px.rollback(120, "sirdar-20261004T120000Z")
        assert fake.rolled_back == [(120, "sirdar-20261004T120000Z")]
        assert await px.status(120) == "stopped"
        await px.start(120)
        assert await px.status(120) == "running"
        await px.delete_snapshot(120, "sirdar-20261004T120000Z")
        assert await px.snapshots(120) == []
    polled = [p for m, p in fake.requests if p.endswith("/status") and "/tasks/" in p]
    assert len(polled) == 4 * 3                      # 4 tasks, 2 "running" answers each


async def test_a_failed_task_and_a_task_that_never_ends():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3")
    fake.task_result["qmsnapshot"] = "snapshot feature is not available"
    async with api(fake) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.take_snapshot(120, "sirdar-20261004T120000Z", "x")
    assert e.value.reason == ("Proxmox couldn't take a VM snapshot: its task ended with an "
                              "error. See the task log in Proxmox.")
    fake.running_polls = 10 ** 6
    async with api(fake, task_timeout=0) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.start(120)
    assert e.value.reason == "Proxmox didn't finish (start the VM) in 0 minutes."


async def test_errors_carry_our_copy_never_the_token():
    fake = FakeProxmox()
    fake.fail[("GET", "/cluster/nextid")] = 500
    async with api(fake) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.next_vmid()
    assert e.value.reason == "Proxmox couldn't reserve a VM id (HTTP 500)."
    assert PX_TOKEN_SECRET not in repr(e.value) and PX_TOKEN_SECRET not in str(e.value)


async def test_the_real_transport_is_guarded(no_real_http):
    async with Proxmox(CFG) as px:
        with pytest.raises(AssertionError):
            await px.version()
    assert no_real_http == ["10.10.48.5"]
    no_real_http.clear()
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_proxmox.py`
Expected: FAIL — `ImportError: cannot import name 'proxmox'`.

- [ ] **Step 5: Write the client**

Create `sirdar/api/src/sirdar_api/deploy/proxmox.py`:

```python
"""Proxmox VE API client (phase 5): what Sirdar reads and does on the
Proxmox host besides Terraform's create and destroy — the connection test,
VM ids, the guest agent (the VM's address and SSH host key), VM snapshots
and power. Every request goes through the pinned certificate
(tls_pin.pinned_context) with the API token in the Authorization header;
tests pass an httpx MockTransport (outbound.transports()["proxmox"]).
Errors are ProxmoxError with our own copy, never Proxmox's text or the
token."""

import asyncio
import ssl
import time
from collections.abc import Awaitable, Callable
from urllib.parse import quote, urlsplit

import httpx

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult, tls_pin
from sirdar_api.deploy.integrations import ProxmoxConfig

DEFAULT_PORT = 8006
TIMEOUT = httpx.Timeout(30.0, connect=10.0)
TASK_POLL_SECONDS = 2.0
TASK_TIMEOUT_SECONDS = 15 * 60
TLS_CHANGED = ("The Proxmox server's certificate isn't the one Sirdar trusts. If it was "
               "renewed on purpose, trust the new one in Settings › Integrations › Proxmox.")
_GB = 1024 ** 3
_SKIPPED_IFACES = ("docker", "br-", "veth")


class ProxmoxError(Exception):
    """`reason` is our own copy; `status` the HTTP status, if any."""

    def __init__(self, reason: str, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class AgentNotReady(ProxmoxError):
    """The guest agent didn't answer (still booting, or not installed)."""


def split_url(url: str) -> tuple[str, int]:
    parts = urlsplit(url)
    return parts.hostname or "", parts.port or DEFAULT_PORT


def _tls_refused(exc: BaseException) -> bool:
    """Whether a transport error came from a certificate the pin refused."""
    seen: BaseException | None = exc
    for _ in range(8):
        if seen is None:
            return False
        if isinstance(seen, ssl.SSLCertVerificationError):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _reason(status: int, what: str) -> str:
    if status == 401:
        return "Proxmox rejected the API token."
    if status == 403:
        return f"The API token isn't allowed to {what}. Check its privileges (see the README)."
    return f"Proxmox couldn't {what} (HTTP {status})."


class Proxmox:
    def __init__(self, cfg: ProxmoxConfig, *, transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 task_poll: float = TASK_POLL_SECONDS,
                 task_timeout: int = TASK_TIMEOUT_SECONDS):
        self._cfg = cfg
        self._sleep = sleep
        self._poll = task_poll
        self._task_timeout = task_timeout
        self._node = quote(cfg.node, safe="")
        host, port = split_url(cfg.url)
        self._where = f"{host}:{port}"
        if transport is None:
            transport = httpx.AsyncHTTPTransport(verify=tls_pin.pinned_context(cfg.tls_cert_pem))
        self._client = httpx.AsyncClient(
            base_url=f"{cfg.url}/api2/json", transport=transport, timeout=TIMEOUT,
            headers={"Authorization": f"PVEAPIToken={cfg.token}"}, follow_redirects=False)

    async def __aenter__(self) -> "Proxmox":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _call(self, method: str, path: str, what: str, *, params: dict | None = None,
                    data: dict | None = None, agent: bool = False):
        try:
            resp = await self._client.request(method, path, params=params, data=data)
        except httpx.HTTPError as e:
            if _tls_refused(e):
                raise ProxmoxError(TLS_CHANGED) from None
            raise ProxmoxError(f"Couldn't reach Proxmox at {self._where}.") from None
        if resp.status_code >= 400:
            if agent and resp.status_code == 500:
                raise AgentNotReady("The VM's guest agent isn't answering yet.", 500)
            raise ProxmoxError(_reason(resp.status_code, what), resp.status_code)
        try:
            return resp.json()["data"]
        except (ValueError, KeyError, TypeError):
            raise ProxmoxError("Proxmox answered with something Sirdar can't read.") from None

    def _vm(self, vmid: int) -> str:
        return f"/nodes/{self._node}/qemu/{int(vmid)}"

    async def version(self) -> str:
        data = await self._call("GET", "/version", "read its version")
        return str((data or {}).get("version", ""))

    async def nodes(self) -> list[str]:
        data = await self._call("GET", "/nodes", "list the nodes")
        return [str(n.get("node")) for n in data or []]

    async def next_vmid(self) -> int:
        try:
            return int(await self._call("GET", "/cluster/nextid", "reserve a VM id"))
        except (TypeError, ValueError):
            raise ProxmoxError("Proxmox answered with something Sirdar can't read.") from None

    async def pool_vmids(self) -> set[int]:
        data = await self._call("GET", f"/pools/{quote(self._cfg.pool, safe='')}",
                                "read the pool")
        return {int(m["vmid"]) for m in (data or {}).get("members", []) if "vmid" in m}

    async def vms(self) -> dict[int, dict]:
        data = await self._call("GET", f"/nodes/{self._node}/qemu", "list the VMs")
        return {int(v["vmid"]): {
            "name": str(v.get("name") or ""), "status": str(v.get("status") or ""),
            "template": bool(v.get("template")),
            "tags": tuple(t for t in str(v.get("tags") or "").replace(",", ";").split(";") if t)}
            for v in data or []}

    async def vm_config(self, vmid: int) -> dict:
        return await self._call("GET", f"{self._vm(vmid)}/config", "read the VM's settings") or {}

    async def status(self, vmid: int) -> str:
        data = await self._call("GET", f"{self._vm(vmid)}/status/current", "read the VM's state")
        return str((data or {}).get("status", ""))

    async def storage_status(self) -> dict:
        path = f"/nodes/{self._node}/storage/{quote(self._cfg.storage, safe='')}/status"
        return await self._call("GET", path, "read the storage") or {}

    async def bridge(self) -> dict:
        path = f"/nodes/{self._node}/network/{quote(self._cfg.bridge, safe='')}"
        return await self._call("GET", path, "read the network bridge") or {}

    async def agent_ipv4(self, vmid: int) -> list[str]:
        """The VM's IPv4 addresses in the agent's interface order, without
        loopback, Docker's own interfaces (docker0, br-*, veth*) and
        link-local addresses."""
        data = await self._call("GET", f"{self._vm(vmid)}/agent/network-get-interfaces",
                                "ask the guest agent for the VM's addresses", agent=True)
        found: list[str] = []
        for iface in (data or {}).get("result", []):
            name = str(iface.get("name", ""))
            if name == "lo" or name.startswith(_SKIPPED_IFACES):
                continue
            for addr in iface.get("ip-addresses", []):
                ip = str(addr.get("ip-address", ""))
                if (addr.get("ip-address-type") == "ipv4" and ip
                        and not ip.startswith("169.254.") and ip not in found):
                    found.append(ip)
        return found

    async def agent_file(self, vmid: int, path: str) -> str:
        data = await self._call("GET", f"{self._vm(vmid)}/agent/file-read",
                                "read a file through the guest agent", params={"file": path},
                                agent=True)
        return str((data or {}).get("content", ""))

    async def snapshots(self, vmid: int) -> list[dict]:
        data = await self._call("GET", f"{self._vm(vmid)}/snapshot", "list the VM snapshots")
        return [s for s in data or [] if s.get("name") != "current"]

    async def take_snapshot(self, vmid: int, name: str, description: str) -> None:
        upid = await self._call("POST", f"{self._vm(vmid)}/snapshot", "take a VM snapshot",
                                data={"snapname": name, "description": description,
                                      "vmstate": 0})
        await self.wait(upid, "take a VM snapshot")

    async def rollback(self, vmid: int, name: str) -> None:
        path = f"{self._vm(vmid)}/snapshot/{quote(name, safe='')}/rollback"
        await self.wait(await self._call("POST", path, "restore the VM snapshot"),
                        "restore the VM snapshot")

    async def delete_snapshot(self, vmid: int, name: str) -> None:
        path = f"{self._vm(vmid)}/snapshot/{quote(name, safe='')}"
        await self.wait(await self._call("DELETE", path, "delete a VM snapshot"),
                        "delete a VM snapshot")

    async def start(self, vmid: int) -> None:
        await self.wait(await self._call("POST", f"{self._vm(vmid)}/status/start",
                                         "start the VM"), "start the VM")

    async def wait(self, upid, what: str) -> None:
        """Until Proxmox's task `upid` stops; its exit status must be OK."""
        deadline = time.monotonic() + self._task_timeout
        path = f"/nodes/{self._node}/tasks/{quote(str(upid), safe='')}/status"
        while True:
            data = await self._call("GET", path, f"follow the task ({what})") or {}
            if data.get("status") == "stopped":
                exit_status = str(data.get("exitstatus") or "")
                if exit_status == "OK" or exit_status.startswith("WARNINGS"):
                    return
                raise ProxmoxError(f"Proxmox couldn't {what}: its task ended with an error. "
                                   "See the task log in Proxmox.")
            if time.monotonic() >= deadline:
                raise ProxmoxError(f"Proxmox didn't finish ({what}) in "
                                   f"{self._task_timeout // 60} minutes.")
            await self._sleep(self._poll)


async def test_connection(cfg: ProxmoxConfig, *,
                          transport: httpx.AsyncBaseTransport | None = None) -> ConnectResult:
    """Read-only: the version, then one check each for the node, the pool,
    the template, the storage and the bridge."""
    checks: list[Check] = []
    async with Proxmox(cfg, transport=transport) as api:
        try:
            version = await api.version()
        except ProxmoxError as e:
            raise ConnectFailed(e.reason) from None
        checks.append(Check("Proxmox", "pass", f"Version {version}"))

        async def node() -> Check:
            names = await api.nodes()
            if cfg.node in names:
                return Check("Node", "pass", cfg.node)
            return Check("Node", "fail",
                         f"No node named {cfg.node} (found {', '.join(names) or 'none'}).")

        async def pool() -> Check:
            return Check("Pool", "pass", f"{cfg.pool} · {len(await api.pool_vmids())} VMs")

        async def template() -> Check:
            vm = (await api.vms()).get(cfg.template_vmid)
            if vm is None:
                return Check("Template", "fail", f"VM {cfg.template_vmid} isn't visible to the "
                                                 f"token. Is it in the {cfg.pool} pool?")
            label = f"{vm['name']} ({cfg.template_vmid})"
            if not vm["template"]:
                return Check("Template", "fail",
                             f"VM {cfg.template_vmid} ({vm['name']}) isn't a template.")
            agent = str((await api.vm_config(cfg.template_vmid)).get("agent", ""))
            if agent.startswith("1") or "enabled=1" in agent:
                return Check("Template", "pass", label)
            return Check("Template", "warn", f"{label} · its guest agent option is off; Sirdar "
                                             "turns it on in each VM")

        async def storage() -> Check:
            s = await api.storage_status()
            if not s.get("active") or "images" not in str(s.get("content", "")).split(","):
                return Check("Storage", "fail", f"{cfg.storage} isn't active or can't hold VM "
                                                "disks.")
            return Check("Storage", "pass",
                         f"{cfg.storage} · {int(s.get('avail', 0)) / _GB:.0f} GB free")

        async def bridge() -> Check:
            try:
                await api.bridge()
            except ProxmoxError as e:
                if e.status == 403:
                    return Check("Bridge", "warn", f"{cfg.bridge} · can't check it (the token "
                                                   "can't read the node's network)")
                if e.status in (404, 500):
                    return Check("Bridge", "fail", f"No bridge named {cfg.bridge} on "
                                                   f"{cfg.node}.")
                raise
            return Check("Bridge", "pass",
                         cfg.bridge + (f" · VLAN {cfg.vlan_tag}" if cfg.vlan_tag else ""))

        for label, check in (("Node", node), ("Pool", pool), ("Template", template),
                             ("Storage", storage), ("Bridge", bridge)):
            try:
                checks.append(await check())
            except ProxmoxError as e:
                checks.append(Check(label, "fail", e.reason))
    facts = {"url": cfg.url, "node": cfg.node, "version": version,
             "fingerprint": cfg.tls_fingerprint, "token_id": cfg.token_id}
    return ConnectResult(ok=not any(c.status == "fail" for c in checks), target="proxmox",
                         checks=checks, facts=facts)


test_connection.__test__ = False  # not a pytest test, despite the name
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_proxmox.py`
Expected: PASS (12 tests). If `test_the_real_transport_is_guarded` reports a different host list, the client didn't go through `httpx.AsyncHTTPTransport` — fix the client, not the test. (The guard's AssertionError passes through `_call`, which catches only `httpx.HTTPError`.)

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/proxmox.py src/sirdar_api/deploy/outbound.py tests/fake_proxmox.py tests/proxmox_helpers.py tests/test_deploy_proxmox.py && cd ../..
git add sirdar/api/src/sirdar_api/deploy/proxmox.py sirdar/api/src/sirdar_api/deploy/outbound.py \
  sirdar/api/tests/fake_proxmox.py sirdar/api/tests/proxmox_helpers.py sirdar/api/tests/test_deploy_proxmox.py
git commit -m "feat(sirdar): Proxmox API client and connection test over the pinned certificate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Proxmox in the integrations API, with the certificate trust flow

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/integrations.py`
- Test: `sirdar/api/tests/test_deploy_proxmox_api.py`

**Interfaces:**
- Consumes: `integrations.check_proxmox_url`, `config_of`, `in_use`, `save`, `candidate`, `load` (Task 2); `tls_pin.fetch_certificate`, `fingerprint_of`, `describe`; `proxmox.split_url`, `proxmox.test_connection` (Task 3).
- Produces: `PUT /api/deploy/integrations/proxmox`, `POST /api/deploy/integrations/proxmox/test`, `DELETE /api/deploy/integrations/proxmox` with the shapes under "API produced for 5b". Audits: `deploy.integration_update` (`{kind, changed}`), `deploy.integration_test` (`{kind, ok}`), `deploy.integration_remove` (`{kind}`).

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_proxmox_api.py`:

```python
import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import ConnectFailed, tls_pin

from .api_helpers import auth_headers
from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import (
    PX_BODY,
    PX_CERT,
    PX_FINGERPRINT,
    PX_TOKEN,
    PX_TOKEN_ID,
    PX_TOKEN_SECRET,
    configure_proxmox,
)
from .proxmox_helpers import proxmox_fake  # noqa: F401
from .tls_helpers import make_cert

URL = "/api/deploy/integrations/proxmox"
UNPINNED = {k: v for k, v in PX_BODY.items() if k != "tls_fingerprint"}


@pytest.fixture
def certificate(monkeypatch):
    """The certificate the Proxmox host serves (the real fetch is guarded)."""
    state = {"pem": PX_CERT, "calls": []}

    async def fetch(host, port):
        state["calls"].append((host, port))
        if state["pem"] is None:
            raise ConnectFailed(f"Couldn't reach {host}:{port} over TLS.")
        return state["pem"]

    monkeypatch.setattr(tls_pin, "fetch_certificate", fetch)
    return state


@pytest.fixture
async def no_token_leaks(client, db):
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
        assert PX_TOKEN_SECRET not in text and "BEGIN CERTIFICATE" not in text


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_saving_asks_to_trust_the_certificate_first(client, db, secrets_key, certificate,
                                                          no_token_leaks):
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**UNPINNED, "token": PX_TOKEN})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert (detail["code"], detail["fingerprint"], detail["subject"]) == (
        "tls_untrusted", PX_FINGERPRINT, "pve.lab")
    assert {"10.10.48.5", "pve"} <= set(detail["names"]) and detail["not_after"]
    assert certificate["calls"] == [("10.10.48.5", 8006)]
    resp = await client.put(URL, headers=h, json={**PX_BODY, "token": PX_TOKEN})
    assert resp.status_code == 200, resp.text
    px = resp.json()["proxmox"]
    assert (px["configured"], px["token_set"], px["token_id"], px["tls_fingerprint"],
            px["template_vmid"]) == (True, True, PX_TOKEN_ID, PX_FINGERPRINT, 9000)
    [change] = await _audits(db, "deploy.integration_update")
    assert change["kind"] == "proxmox" and "token" in change["changed"]


async def test_a_changed_certificate_is_refused(client, db, secrets_key, certificate,
                                                no_token_leaks):
    h = await auth_headers(client, db)
    certificate["pem"], _ = make_cert(cn="impostor")
    resp = await client.put(URL, headers=h, json={**PX_BODY, "token": PX_TOKEN})
    detail = resp.json()["detail"]
    assert (resp.status_code, detail["code"], detail["expected"]) == (
        409, "tls_mismatch", PX_FINGERPRINT)
    assert detail["actual"] == tls_pin.fingerprint_of(certificate["pem"])
    certificate["pem"] = None
    resp = await client.put(URL, headers=h, json={**PX_BODY, "token": PX_TOKEN})
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": "Couldn't reach 10.10.48.5:8006 over TLS."})


async def test_the_stored_pin_is_reused_without_fetching(client, db, secrets_key, certificate,
                                                         no_token_leaks):
    await configure_proxmox(db)
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**PX_BODY, "bridge": "vmbr1"})
    assert resp.status_code == 200 and resp.json()["proxmox"]["bridge"] == "vmbr1"
    assert certificate["calls"] == []
    # another server: its certificate must be trusted, and the token entered again
    resp = await client.put(URL, headers=h, json={**UNPINNED, "url": "https://10.10.48.9:8006"})
    assert resp.json()["detail"]["code"] == "tls_untrusted"
    assert certificate["calls"] == [("10.10.48.9", 8006)]
    resp = await client.put(URL, headers=h, json={**PX_BODY, "url": "https://10.10.48.9:8006"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "secret_required")


@pytest.mark.parametrize("change,code", [
    ({"url": "http://10.10.48.5:8006"}, "proxmox_url_invalid"),
    ({"node": "pve node"}, "node_invalid"),
    ({"template_vmid": 12}, "template_vmid_invalid"),
    ({"vlan_tag": 0}, "vlan_tag_invalid"),
    ({"token": "sirdar@pve!sirdar=nope"}, "proxmox_token_invalid"),
])
async def test_validation(client, db, secrets_key, certificate, change, code):
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**PX_BODY, "token": PX_TOKEN, **change})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code)


async def test_test_saved_and_unsaved(client, db, secrets_key, certificate, proxmox_fake,
                                      no_token_leaks):
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["proxmox"]})
    resp = await client.post(f"{URL}/test", headers=h, json={**UNPINNED, "token": PX_TOKEN})
    assert resp.json()["detail"]["code"] == "tls_untrusted"
    resp = await client.post(f"{URL}/test", headers=h, json={**PX_BODY, "token": PX_TOKEN})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] and [c["label"] for c in body["checks"]] == [
        "Proxmox", "Node", "Pool", "Template", "Storage", "Bridge"]
    assert body["facts"]["token_id"] == PX_TOKEN_ID
    await configure_proxmox(db)
    proxmox_fake.bridges = set()
    resp = await client.post(f"{URL}/test", headers=h)
    assert resp.status_code == 200 and resp.json()["ok"] is False
    assert await _audits(db, "deploy.integration_test") == [
        {"kind": "proxmox", "ok": True}, {"kind": "proxmox", "ok": True}]


async def test_remove_refuses_while_an_environment_uses_it(client, db, secrets_key):
    await configure_proxmox(db)
    env = await make_environment(db, name="uat3", target_id="proxmox")
    h = await auth_headers(client, db)
    resp = await client.delete(URL, headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_in_use", "environments": ["uat3"]})
    await db.delete(env)
    await db.commit()
    assert (await client.delete(URL, headers=h)).status_code == 204
    assert await _audits(db, "deploy.integration_remove") == [{"kind": "proxmox"}]


async def test_permissions(client, db, secrets_key):
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    for method, path, body in (("PUT", "", PX_BODY), ("POST", "/test", None),
                               ("DELETE", "", None)):
        resp = await client.request(method, URL + path, headers=admin, json=body)
        assert resp.status_code == 403, (method, path)
```

The Test audit list has two `ok: True` rows: the first unsaved Test (tls_untrusted) never reached Proxmox, so it isn't audited; the saved Test with a failed bridge check still connected (`ok` in the audit is "the Test ran", like the Cloudflare and NPM tests record it — check `_test` in `routes/integrations.py`: it records `True` after the tester returns, whatever `result.ok` is).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_proxmox_api.py`
Expected: FAIL — `PUT /api/deploy/integrations/proxmox` answers 405.

- [ ] **Step 3: Add the routes**

In `sirdar/api/src/sirdar_api/api/routes/integrations.py`:

Replace the module docstring's first two lines:

```python
"""Settings › Integrations: the Cloudflare and Nginx Proxy Manager
credentials Sirdar publishes environments with. Secrets are write-only: no
```

with:

```python
"""Settings › Integrations: the Cloudflare and Nginx Proxy Manager
credentials Sirdar publishes environments with, and the Proxmox API token
it builds VMs with (its TLS certificate is pinned trust-on-first-use: save
and Test answer tls_untrusted until the request names the fingerprint the
user was shown). Secrets are write-only: no
```

Replace:

```python
from sirdar_api.deploy import ConnectFailed, cloudflare, integrations, npm, outbound
from sirdar_api.deploy.integrations import IntegrationError
```

with:

```python
from sirdar_api.deploy import (
    ConnectFailed,
    cloudflare,
    integrations,
    npm,
    outbound,
    proxmox,
    tls_pin,
)
from sirdar_api.deploy.integrations import IntegrationError
```

Replace:

```python
Kind = Literal["cloudflare", "npm"]
TESTERS = {"cloudflare": cloudflare.test_connection, "npm": npm.test_connection}
UNEXPECTED_REASON = "Sirdar couldn't reach it."
_STATUS = {"secrets_key_missing": 400, "integration_unreadable": 409}
```

with:

```python
Kind = Literal["cloudflare", "npm", "proxmox"]
TESTERS = {"cloudflare": cloudflare.test_connection, "npm": npm.test_connection,
           "proxmox": proxmox.test_connection}
UNEXPECTED_REASON = "Sirdar couldn't reach it."
_STATUS = {"secrets_key_missing": 400, "integration_unreadable": 409}
PROXMOX_FIELDS = ("url", "node", "pool", "storage", "bridge", "vlan_tag", "template_vmid",
                  "tls_fingerprint")
```

After the `NpmIn` class, add:

```python
class ProxmoxIn(BaseModel):
    url: str = Field(max_length=300)
    node: str = Field(max_length=63)
    pool: str = Field(max_length=40)
    storage: str = Field(max_length=63)
    bridge: str = Field(max_length=15)
    vlan_tag: int | None = None
    template_vmid: int
    # The fingerprint the user was shown and trusted (None: show it first).
    tls_fingerprint: str | None = Field(default=None, max_length=95)
    token: str | None = None
```

After `_npm_values`, add:

```python
async def _proxmox_values(db, body: ProxmoxIn) -> dict:
    """The form's values plus the pinned certificate. The stored pin is
    reused for the same URL and fingerprint; otherwise the live certificate
    is fetched and must have the fingerprint the request names."""
    values = {name: getattr(body, name) for name in PROXMOX_FIELDS}
    try:
        url = integrations.check_proxmox_url(body.url)
    except IntegrationError as e:
        raise _http(e) from None
    wanted = (body.tls_fingerprint or "").strip().upper()
    stored = await integrations.config_of(db, "proxmox")
    if wanted and stored.get("url") == url and stored.get("tls_fingerprint") == wanted:
        return {**values, "tls_cert_pem": stored["tls_cert_pem"]}
    try:
        pem = await tls_pin.fetch_certificate(*proxmox.split_url(url))
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
    return {**values, "tls_cert_pem": pem}
```

After `save_npm`, add:

```python
@router.put("/proxmox")
async def save_proxmox(body: ProxmoxIn, request: Request, db: DbSession,
                       actor: AuthContext = require_permission("deploy", "change")):
    return await _save("proxmox", await _proxmox_values(db, body), body.token, request, db,
                       actor)
```

In `remove_integration`, replace:

```python
    if not await integrations.remove(db, kind):
```

with:

```python
    users = await integrations.in_use(db, kind)
    if users:
        raise HTTPException(status_code=409, detail={"code": "integration_in_use",
                                                     "environments": users})
    if not await integrations.remove(db, kind):
```

After `check_npm`, add:

```python
@router.post("/proxmox/test")
async def check_proxmox(request: Request, db: DbSession, body: ProxmoxIn | None = None,
                        actor: AuthContext = require_permission("deploy", "change")):
    values = await _proxmox_values(db, body) if body else None
    return await _test("proxmox", values, body.token if body else None, request, db, actor)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_proxmox_api.py tests/test_deploy_integrations_api.py`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/api/routes/integrations.py tests/test_deploy_proxmox_api.py && cd ../..
git add sirdar/api/src/sirdar_api/api/routes/integrations.py sirdar/api/tests/test_deploy_proxmox_api.py
git commit -m "feat(sirdar): Proxmox credentials in Settings with a pinned certificate and Test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Terraform — the config, the state folder, the runner and the image

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/terraform.py`
- Modify: `sirdar/api/src/sirdar_api/config.py`
- Create: `sirdar/api/tests/fake_terraform.py`
- Modify: `sirdar/api/tests/conftest.py` (`no_real_hosts` guards Terraform)
- Create: `sirdar/terraformrc`, `sirdar/terraform/.gitkeep`
- Modify: `sirdar/Dockerfile`, `sirdar/docker-compose.yml`, `sirdar/install.sh`, `sirdar/.gitignore`
- Test: `sirdar/api/tests/test_deploy_terraform.py`

**Interfaces:**
- Produces (settings): `Settings.terraform_dir: str = "/app/terraform"` (`SIRDAR_TERRAFORM_DIR`), `terraform_binary: str = "terraform"`, `terraform_cli_config: str = "/opt/terraform/terraformrc"`.
- Produces (module `sirdar_api.deploy.terraform`): `TERRAFORM_VERSION = "1.16.5"`; `PROVIDER_VERSION = "0.115.0"`; `VM_USER = "deploy"`; `INIT`, `APPLY`, `DESTROY` (argument tuples); `APPLY_TIMEOUT = 25 * 60`; frozen dataclass `VmSpec(env_name, name, vmid, node, pool, storage, bridge, vlan_tag, template_vmid, cores, memory_mb, disk_gb, ip_cidr, gateway, ssh_public_key)`; `render_config(url: str, spec: VmSpec) -> dict`; `class TerraformDirUnwritable(PermissionError)`; `workdir(settings, env_id) -> Path`; `prepare_workdir(settings, env_id, config: dict, ca_pem: str) -> Path`; `needs_init(work: Path) -> bool`; `has_state(work: Path) -> bool`; `remove_workdir(settings, env_id) -> None`; `run_env(settings, work: Path, token: str) -> dict[str, str]`; frozen dataclasses `TfRequest(args: tuple[str, ...], workdir: Path, env: dict (repr=False), timeout: int)` and `TfResult(status: Literal["successful", "failed", "timeout"], rc: int)`; `class TerraformRunner(Protocol)` with `async run(request, on_output) -> TfResult`; `async _spawn(argv: list[str], *, cwd: Path, env: dict)` (the one place a process starts; guarded in tests); `class SubprocessTerraform(binary: str = "terraform", grace: float = 30)`.
- Produces (tests): `tests/fake_terraform.py` — `FakeTerraform` (`requests`, `commands()`, `results[command]`, `effects[command] = fn(request)`, `output[command]`, `gates[command]`); `no_real_hosts` also refuses any binary not named `fake-*`.

- [ ] **Step 1: Add the settings**

In `sirdar/api/src/sirdar_api/config.py`, replace:

```python
    # The largest snapshot upload Sirdar accepts, in bytes (default 5 GiB).
    snapshot_max_bytes: int = Field(default=5 * 1024 ** 3, gt=0)
```

with:

```python
    # The largest snapshot upload Sirdar accepts, in bytes (default 5 GiB).
    snapshot_max_bytes: int = Field(default=5 * 1024 ** 3, gt=0)
    # Proxmox environments (phase 5): one Terraform folder per environment,
    # state included. Owned by uid 10001, mode 700, never served.
    terraform_dir: str = "/app/terraform"
    terraform_binary: str = "terraform"
    # Points Terraform at the provider mirror baked into the image (no registry).
    terraform_cli_config: str = "/opt/terraform/terraformrc"
```

- [ ] **Step 2: Write the fake**

Create `sirdar/api/tests/fake_terraform.py`:

```python
"""A TerraformRunner for provisioner and pipeline tests: records each
request (its environment's names and the token it carried), prints lines,
answers from canned results (default: success), and runs effects — what a
real apply or destroy leaves behind (a state file, a VM in FakeProxmox)."""

import asyncio
import json

from sirdar_api.deploy.terraform import TfRequest, TfResult


def write_state(request: TfRequest, *, vm: bool = True) -> None:
    """What `terraform apply` (vm=True) or `destroy` (vm=False) leaves."""
    resources = [{"type": "proxmox_virtual_environment_vm", "name": "vm"}] if vm else []
    (request.workdir / "terraform.tfstate").write_text(json.dumps({"resources": resources}))


class FakeTerraform:
    def __init__(self):
        self.requests: list[TfRequest] = []
        self.results: dict[str, TfResult] = {}
        self.effects: dict = {}
        self.output: dict[str, list[str]] = {}
        self.gates: dict[str, asyncio.Event] = {}

    def commands(self) -> list[str]:
        return [r.args[0] for r in self.requests]

    async def run(self, request: TfRequest, on_output) -> TfResult:
        self.requests.append(request)
        command = request.args[0]
        if command == "init":
            (request.workdir / ".terraform").mkdir(exist_ok=True)
        for line in self.output.get(command, [f"fake terraform {command}\n"]):
            on_output(line)
        if command in self.gates:
            await self.gates[command].wait()
        if command in self.effects:
            self.effects[command](request)
        return self.results.get(command, TfResult(status="successful", rc=0))
```

- [ ] **Step 3: Write the failing tests**

Create `sirdar/api/tests/test_deploy_terraform.py`:

```python
import asyncio
import json
import os
import re
import stat
import uuid

import pytest

from sirdar_api.config import get_settings
from sirdar_api.deploy import terraform
from sirdar_api.deploy.terraform import SubprocessTerraform, TfRequest, VmSpec

from .conftest import API_DIR
from .integration_helpers import PX_CERT, PX_TOKEN

SPEC = VmSpec(env_name="uat3", name="ss-uat3", vmid=120, node="pve", pool="sirdar",
              storage="local-lvm", bridge="vmbr0", vlan_tag=None, template_vmid=9000,
              cores=4, memory_mb=8192, disk_gb=64, ip_cidr="10.10.48.70/24",
              gateway="10.10.48.1", ssh_public_key="ssh-ed25519 AAAAC3Nz sirdar@ss-uat3")
ENV_ID = uuid.UUID("11111111-2222-4333-8444-555555555555")


@pytest.fixture
def tf_dir(monkeypatch, tmp_path):
    folder = tmp_path / "terraform"
    monkeypatch.setenv("SIRDAR_TERRAFORM_DIR", str(folder))
    monkeypatch.setenv("SIRDAR_TERRAFORM_CLI_CONFIG", "/opt/terraform/terraformrc")
    get_settings.cache_clear()
    yield folder
    get_settings.cache_clear()


def test_the_vm_config():
    config = terraform.render_config("https://10.10.48.5:8006", SPEC)
    assert config["terraform"] == {
        "required_version": "= 1.16.5",
        "required_providers": {"proxmox": {"source": "bpg/proxmox", "version": "= 0.115.0"}}}
    assert config["provider"] == {"proxmox": {"endpoint": "https://10.10.48.5:8006",
                                              "insecure": False}}
    vm = config["resource"]["proxmox_virtual_environment_vm"]["vm"]
    assert (vm["name"], vm["node_name"], vm["vm_id"], vm["pool_id"], vm["tags"]) == (
        "ss-uat3", "pve", 120, "sirdar", ["sirdar", "ss-uat3"])
    assert vm["clone"] == {"vm_id": 9000, "full": True, "node_name": "pve",
                           "datastore_id": "local-lvm"}
    assert (vm["cpu"], vm["memory"]) == ({"cores": 4, "type": "host"}, {"dedicated": 8192})
    assert vm["disk"] == [{"datastore_id": "local-lvm", "interface": "scsi0", "size": 64,
                           "discard": "on", "iothread": True, "ssd": True}]
    assert vm["network_device"] == [{"bridge": "vmbr0", "model": "virtio"}]
    assert vm["agent"] == {"enabled": True, "trim": True, "timeout": "5m"}
    assert vm["initialization"] == {
        "datastore_id": "local-lvm",
        "user_account": {"username": "deploy", "keys": [SPEC.ssh_public_key]},
        "ip_config": [{"ipv4": {"address": "10.10.48.70/24", "gateway": "10.10.48.1"}}]}
    assert (vm["started"], vm["on_boot"], vm["stop_on_destroy"], vm["purge_on_destroy"]) == (
        True, True, True, True)
    assert PX_TOKEN not in json.dumps(config)


def test_dhcp_and_a_vlan():
    from dataclasses import replace
    vm = terraform.render_config("https://pve.lab:8006", replace(
        SPEC, ip_cidr=None, gateway=None, vlan_tag=40))["resource"][
        "proxmox_virtual_environment_vm"]["vm"]
    assert vm["initialization"]["ip_config"] == [{"ipv4": {"address": "dhcp"}}]
    assert vm["network_device"] == [{"bridge": "vmbr0", "model": "virtio", "vlan_id": 40}]


def test_the_working_folder_is_private_and_per_environment(tf_dir):
    settings = get_settings()
    config = terraform.render_config("https://10.10.48.5:8006", SPEC)
    work = terraform.prepare_workdir(settings, ENV_ID, config, PX_CERT)
    assert work == tf_dir / str(ENV_ID) == terraform.workdir(settings, ENV_ID)
    for folder in (tf_dir, work, work / "home", work / "ca"):
        assert stat.S_IMODE(folder.stat().st_mode) == 0o700, folder
    for name in ("main.tf.json", "proxmox-ca.pem"):
        assert stat.S_IMODE((work / name).stat().st_mode) == 0o600, name
    assert json.loads((work / "main.tf.json").read_text()) == config
    assert (work / "proxmox-ca.pem").read_text() == PX_CERT
    assert list((work / "ca").iterdir()) == []
    assert terraform.needs_init(work) and not terraform.has_state(work)
    (work / ".terraform").mkdir()
    (work / "terraform.tfstate").write_text(json.dumps({"resources": [{"type": "x"}]}))
    (work / "crash.log").write_text("panic")
    terraform.prepare_workdir(settings, ENV_ID, config, PX_CERT)       # a second run
    assert not terraform.needs_init(work) and terraform.has_state(work)
    assert not (work / "crash.log").exists()
    (work / "terraform.tfstate").write_text(json.dumps({"resources": []}))
    assert not terraform.has_state(work)
    terraform.remove_workdir(settings, ENV_ID)
    assert not work.exists() and tf_dir.is_dir()
    terraform.remove_workdir(settings, ENV_ID)                          # already gone


def test_an_unwritable_folder(monkeypatch, tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir(mode=0o500)
    monkeypatch.setenv("SIRDAR_TERRAFORM_DIR", str(locked / "terraform"))
    get_settings.cache_clear()
    try:
        with pytest.raises(terraform.TerraformDirUnwritable):
            terraform.prepare_workdir(get_settings(), ENV_ID, {}, PX_CERT)
    finally:
        locked.chmod(0o700)
        get_settings.cache_clear()


def test_terraform_s_environment_is_an_allowlist(tf_dir, monkeypatch):
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "never-passed-on")
    settings = get_settings()
    work = terraform.prepare_workdir(settings, ENV_ID, {}, PX_CERT)
    env = terraform.run_env(settings, work, PX_TOKEN)
    assert env["PROXMOX_VE_API_TOKEN"] == PX_TOKEN
    assert env["SSL_CERT_FILE"] == str(work / "proxmox-ca.pem")
    assert env["SSL_CERT_DIR"] == str(work / "ca")
    assert env["HOME"] == str(work / "home")
    assert env["TF_CLI_CONFIG_FILE"] == "/opt/terraform/terraformrc"
    assert (env["TF_IN_AUTOMATION"], env["TF_INPUT"], env["CHECKPOINT_DISABLE"]) == (
        "1", "0", "1")
    assert not [k for k in env if k.startswith(("SIRDAR_", "AWS_", "SS_", "TF_LOG"))]
    assert set(env) <= {"PATH", "LANG", "TZ", "HOME", "TF_CLI_CONFIG_FILE",
                        "TF_IN_AUTOMATION", "TF_INPUT", "CHECKPOINT_DISABLE", "SSL_CERT_FILE",
                        "SSL_CERT_DIR", "PROXMOX_VE_API_TOKEN"}


def _fake_binary(tmp_path, body: str):
    script = tmp_path / "fake-terraform"
    script.write_text("#!/bin/sh\n" + body)
    script.chmod(0o700)
    return str(script)


async def test_the_runner_streams_output_and_reports_the_exit(tmp_path):
    binary = _fake_binary(tmp_path, 'echo "args: $*"\n'
                                    'echo "token: ${PROXMOX_VE_API_TOKEN:+set}"\n'
                                    'echo "db: ${SIRDAR_DATABASE_URL:-absent}"\n'
                                    'exit "${FAKE_EXIT:-0}"\n')
    lines: list[str] = []
    env = {"PATH": os.environ["PATH"], "PROXMOX_VE_API_TOKEN": PX_TOKEN}
    result = await SubprocessTerraform(binary).run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env=env, timeout=30), lines.append)
    assert (result.status, result.rc) == ("successful", 0)
    assert "".join(lines) == ("args: apply -input=false -no-color -auto-approve\n"
                              "token: set\ndb: absent\n")
    result = await SubprocessTerraform(binary).run(
        TfRequest(args=terraform.INIT, workdir=tmp_path, env={**env, "FAKE_EXIT": "1"},
                  timeout=30), lines.append)
    assert (result.status, result.rc) == ("failed", 1)
    assert PX_TOKEN not in repr(TfRequest(args=terraform.INIT, workdir=tmp_path, env=env,
                                          timeout=1))


async def test_a_run_that_takes_too_long_is_stopped(tmp_path):
    binary = _fake_binary(tmp_path, "trap 'echo interrupted; exit 130' INT\n"
                                    "sleep 30 >/dev/null 2>&1 &\nwait\n")
    lines: list[str] = []
    result = await SubprocessTerraform(binary, grace=5).run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env={"PATH": os.environ["PATH"]},
                  timeout=1), lines.append)
    assert result.status == "timeout"
    assert "interrupted\n" in lines


async def test_cancel_stops_the_process(tmp_path):
    binary = _fake_binary(tmp_path, "echo started\nexec sleep 30\n")
    started = asyncio.Event()

    def out(line):
        started.set()

    task = asyncio.create_task(SubprocessTerraform(binary, grace=1).run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env={"PATH": os.environ["PATH"]},
                  timeout=60), out))
    await asyncio.wait_for(started.wait(), 10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_the_guard_refuses_a_real_terraform(no_real_hosts, tmp_path):
    with pytest.raises(AssertionError):
        await SubprocessTerraform("terraform").run(
            TfRequest(args=terraform.INIT, workdir=tmp_path, env={}, timeout=5), print)
    assert no_real_hosts == ["terraform:terraform"]
    no_real_hosts.clear()


def test_the_image_pins_the_versions_this_module_renders():
    dockerfile = (API_DIR.parent / "Dockerfile").read_text()
    pins = dict(re.findall(r"^ARG (TERRAFORM_VERSION|PROXMOX_PROVIDER_VERSION)=(\S+)$",
                           dockerfile, re.M))
    assert pins == {"TERRAFORM_VERSION": terraform.TERRAFORM_VERSION,
                    "PROXMOX_PROVIDER_VERSION": terraform.PROVIDER_VERSION}
    assert dockerfile.count("sha256sum -c -") == 2
    rc = (API_DIR.parent / "terraformrc").read_text()
    assert "filesystem_mirror" in rc and "/opt/terraform/providers" in rc
    assert "direct" not in rc
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_terraform.py`
Expected: FAIL — `ImportError: cannot import name 'terraform'`.

- [ ] **Step 5: Write `terraform.py`**

Create `sirdar/api/src/sirdar_api/deploy/terraform.py`:

```python
"""Terraform for Proxmox environments (phase 5, step 0 and Destroy VM).

One working folder per environment, SIRDAR_TERRAFORM_DIR/<environment id>/
(mode 700, never served): main.tf.json (rendered here, no secret in it), the
pinned Proxmox certificate, the state and .terraform/. Terraform runs with
an allowlisted environment; the API token reaches it only as
PROXMOX_VE_API_TOKEN, never in a file or on its command line. Its TLS trust
is the pinned certificate alone (SSL_CERT_FILE, and SSL_CERT_DIR pointed at
an empty folder). The provider comes from the image's filesystem mirror
(TF_CLI_CONFIG_FILE), so `init` never goes online.

The pipeline depends only on the TerraformRunner protocol; tests use
FakeTerraform, and conftest's guard refuses to start any binary but a
fake-* script (_spawn is the one place a process starts)."""

import asyncio
import json
import os
import shutil
import signal
import uuid
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

from sirdar_api.config import Settings

TERRAFORM_VERSION = "1.16.5"
PROVIDER_VERSION = "0.115.0"
VM_USER = "deploy"
INIT = ("init", "-input=false", "-no-color")
APPLY = ("apply", "-input=false", "-no-color", "-auto-approve")
DESTROY = ("destroy", "-input=false", "-no-color", "-auto-approve")
APPLY_TIMEOUT = 25 * 60            # inside the step's 30 minutes
_INHERITED_ENV = ("PATH", "LANG", "TZ")


class TerraformDirUnwritable(PermissionError):
    """SIRDAR_TERRAFORM_DIR can't be written (not owned by uid 10001?)."""


@dataclass(frozen=True)
class VmSpec:
    env_name: str
    name: str
    vmid: int
    node: str
    pool: str
    storage: str
    bridge: str
    vlan_tag: int | None
    template_vmid: int
    cores: int
    memory_mb: int
    disk_gb: int
    ip_cidr: str | None            # None: DHCP
    gateway: str | None
    ssh_public_key: str


def render_config(url: str, spec: VmSpec) -> dict:
    """main.tf.json: one full clone of the template, sized and on the bridge,
    with cloud-init for the deploy user and the address."""
    ipv4 = ({"address": spec.ip_cidr, "gateway": spec.gateway} if spec.ip_cidr
            else {"address": "dhcp"})
    network: dict = {"bridge": spec.bridge, "model": "virtio"}
    if spec.vlan_tag is not None:
        network["vlan_id"] = spec.vlan_tag
    vm = {
        "name": spec.name, "node_name": spec.node, "vm_id": spec.vmid, "pool_id": spec.pool,
        "tags": ["sirdar", spec.name],
        "description": f"Managed by Sirdar (environment {spec.env_name}). Change or delete it "
                       "from Sirdar, not here.",
        "started": True, "on_boot": True, "stop_on_destroy": True, "purge_on_destroy": True,
        "clone": {"vm_id": spec.template_vmid, "full": True, "node_name": spec.node,
                  "datastore_id": spec.storage},
        "agent": {"enabled": True, "trim": True, "timeout": "5m"},
        "cpu": {"cores": spec.cores, "type": "host"},
        "memory": {"dedicated": spec.memory_mb},
        "scsi_hardware": "virtio-scsi-single",
        "disk": [{"datastore_id": spec.storage, "interface": "scsi0", "size": spec.disk_gb,
                  "discard": "on", "iothread": True, "ssd": True}],
        "network_device": [network],
        "operating_system": {"type": "l26"},
        "initialization": {"datastore_id": spec.storage,
                           "user_account": {"username": VM_USER, "keys": [spec.ssh_public_key]},
                           "ip_config": [{"ipv4": ipv4}]},
    }
    return {
        "terraform": {"required_version": f"= {TERRAFORM_VERSION}",
                      "required_providers": {"proxmox": {"source": "bpg/proxmox",
                                                         "version": f"= {PROVIDER_VERSION}"}}},
        "provider": {"proxmox": {"endpoint": url, "insecure": False}},
        "resource": {"proxmox_virtual_environment_vm": {"vm": vm}},
    }


def workdir(settings: Settings, env_id: uuid.UUID) -> Path:
    return Path(settings.terraform_dir) / str(env_id)


def _private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def _write_private(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def prepare_workdir(settings: Settings, env_id: uuid.UUID, config: dict, ca_pem: str) -> Path:
    """Write this run's config and pinned certificate; keep the state and
    .terraform/. A crash log from an earlier run is removed."""
    try:
        _private_dir(Path(settings.terraform_dir))
        work = workdir(settings, env_id)
        _private_dir(work)
        _private_dir(work / "home")
        _private_dir(work / "ca")                       # empty: SSL_CERT_DIR
        _write_private(work / "main.tf.json", json.dumps(config, indent=2))
        _write_private(work / "proxmox-ca.pem", ca_pem)
        (work / "crash.log").unlink(missing_ok=True)
    except PermissionError:
        raise TerraformDirUnwritable() from None
    return work


def needs_init(work: Path) -> bool:
    return not (work / ".terraform").is_dir()


def has_state(work: Path) -> bool:
    """Whether the state records any resource (a VM to destroy)."""
    try:
        state = json.loads((work / "terraform.tfstate").read_text())
    except (OSError, ValueError):
        return False
    return bool(state.get("resources"))


def remove_workdir(settings: Settings, env_id: uuid.UUID) -> None:
    shutil.rmtree(workdir(settings, env_id), ignore_errors=True)


def run_env(settings: Settings, work: Path, token: str) -> dict[str, str]:
    env = {k: os.environ[k] for k in _INHERITED_ENV if k in os.environ}
    env.update({
        "HOME": str(work / "home"),
        "TF_CLI_CONFIG_FILE": settings.terraform_cli_config,
        "TF_IN_AUTOMATION": "1",
        "TF_INPUT": "0",
        "CHECKPOINT_DISABLE": "1",
        "SSL_CERT_FILE": str(work / "proxmox-ca.pem"),
        "SSL_CERT_DIR": str(work / "ca"),
        "PROXMOX_VE_API_TOKEN": token,
    })
    return env


@dataclass(frozen=True)
class TfRequest:
    args: tuple[str, ...]
    workdir: Path
    env: dict = field(repr=False)
    timeout: int


@dataclass(frozen=True)
class TfResult:
    status: Literal["successful", "failed", "timeout"]
    rc: int


class TerraformRunner(Protocol):
    async def run(self, request: TfRequest,
                  on_output: Callable[[str], None]) -> TfResult: ...


async def _spawn(argv: list[str], *, cwd: Path, env: dict) -> asyncio.subprocess.Process:
    """The one place a Terraform process starts (tests guard it)."""
    return await asyncio.create_subprocess_exec(
        *argv, cwd=str(cwd), env=env, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        start_new_session=True)


class SubprocessTerraform:
    """Runs the terraform binary. Output goes to on_output line by line (the
    caller redacts). A timeout or cancel sends SIGINT, Terraform's graceful
    stop (it saves the state), and kills after `grace` seconds."""

    def __init__(self, binary: str = "terraform", grace: float = 30):
        self.binary = binary
        self.grace = grace

    async def _stop(self, proc: asyncio.subprocess.Process) -> None:
        """Like Ctrl-C in a terminal: SIGINT to the whole process group
        (Terraform and its provider plugins; _spawn starts a new session),
        then SIGKILL to the group after the grace period."""
        if proc.returncode is not None:
            return
        with suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGINT)
        try:
            await asyncio.wait_for(proc.wait(), self.grace)
        except TimeoutError:
            with suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()

    async def run(self, request: TfRequest,
                  on_output: Callable[[str], None]) -> TfResult:
        proc = await _spawn([self.binary, *request.args], cwd=request.workdir, env=request.env)

        async def pump() -> None:
            async for line in proc.stdout:
                on_output(line.decode(errors="replace"))

        reader = asyncio.ensure_future(pump())
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), request.timeout)
        except TimeoutError:
            await self._stop(proc)
            with suppress(Exception):
                await asyncio.wait_for(reader, 5)
            return TfResult(status="timeout", rc=-1)
        except asyncio.CancelledError:
            await self._stop(proc)
            reader.cancel()
            raise
        with suppress(Exception):
            await asyncio.wait_for(reader, 5)
        return TfResult(status="successful" if proc.returncode == 0 else "failed",
                        rc=proc.returncode)
```

- [ ] **Step 6: Guard Terraform in the tests**

In `sirdar/api/tests/conftest.py`, in `no_real_hosts`, replace:

```python
    from sirdar_api.deploy import tls_pin

    hits: list[str] = []
    real_read = tls_pin._read_certificate
```

with:

```python
    from sirdar_api.deploy import terraform, tls_pin

    hits: list[str] = []
    real_read = tls_pin._read_certificate
    real_spawn = terraform._spawn

    async def spawn(argv, **kw):
        if not Path(argv[0]).name.startswith("fake-"):
            hits.append(f"terraform:{argv[0]}")
            raise AssertionError(f"a test started a real Terraform ({argv[0]})")
        return await real_spawn(argv, **kw)
```

and replace:

```python
        mp.setattr(tls_pin, "_read_certificate", read)
        yield hits
```

with:

```python
        mp.setattr(tls_pin, "_read_certificate", read)
        mp.setattr(terraform, "_spawn", spawn)
        yield hits
```

(`Path` is already imported in conftest.)

- [ ] **Step 7: Install Terraform and the provider in the image**

Create `sirdar/terraformrc`:

```hcl
# Terraform CLI config for Sirdar's image: providers come only from the
# filesystem mirror baked in at build time (sirdar/Dockerfile), never from
# the registry, so `terraform init` works offline and can't pick up anything
# that wasn't checksummed.
disable_checkpoint = true

provider_installation {
  filesystem_mirror {
    path    = "/opt/terraform/providers"
    include = ["registry.terraform.io/bpg/proxmox"]
  }
}
```

In `sirdar/Dockerfile`, replace:

```dockerfile
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SIRDAR_STATIC_DIR=/app/static \
    HOME=/home/sirdar SIRDAR_RUNNER_DIR=/app/runner SIRDAR_SNAPSHOTS_DIR=/app/snapshots
```

with:

```dockerfile
# Terraform and the bpg/proxmox provider for Proxmox environments (deploy
# phase 5), pinned and checked against the SHA-256 sums HashiCorp and the
# Terraform registry publish (amd64 and arm64). The provider goes into a
# filesystem mirror (sirdar/terraformrc), so `terraform init` never goes
# online. Bump both versions together with deploy/terraform.py (a test
# compares them).
FROM python:3.13-slim AS terraform
ARG TERRAFORM_VERSION=1.16.5
ARG PROXMOX_PROVIDER_VERSION=0.115.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) tf_sha=2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4; \
             pv_sha=36c1c6bdcb9c74456ecab30beac94d7984b50deedd236cda8708e5aac924469e ;; \
      arm64) tf_sha=61a50b00485ee4810cf20581ef080fc54d34d666e175c58d9a10501c65c1ccde; \
             pv_sha=7e73903b42fc17078233a6c32fa0b79640c8a2890ed80f69d3fdefba4d0ad085 ;; \
      *) echo "no pinned Terraform for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/terraform.zip \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip"; \
    echo "${tf_sha}  /tmp/terraform.zip" | sha256sum -c -; \
    unzip -q /tmp/terraform.zip terraform -d /usr/local/bin; \
    mirror=/opt/terraform/providers/registry.terraform.io/bpg/proxmox; \
    zip="terraform-provider-proxmox_${PROXMOX_PROVIDER_VERSION}_linux_${arch}.zip"; \
    mkdir -p "$mirror"; \
    curl -fsSLo "$mirror/$zip" \
      "https://github.com/bpg/terraform-provider-proxmox/releases/download/v${PROXMOX_PROVIDER_VERSION}/$zip"; \
    echo "${pv_sha}  $mirror/$zip" | sha256sum -c -
COPY sirdar/terraformrc /opt/terraform/terraformrc

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SIRDAR_STATIC_DIR=/app/static \
    HOME=/home/sirdar SIRDAR_RUNNER_DIR=/app/runner SIRDAR_SNAPSHOTS_DIR=/app/snapshots \
    SIRDAR_TERRAFORM_DIR=/app/terraform
```

Replace:

```dockerfile
COPY --from=web /app/sirdar/web/dist /app/static
```

with:

```dockerfile
COPY --from=web /app/sirdar/web/dist /app/static
COPY --from=terraform /usr/local/bin/terraform /usr/local/bin/terraform
COPY --from=terraform /opt/terraform /opt/terraform
```

Replace:

```dockerfile
# uid 10001 gets a home (ssh and Ansible keep small state under $HOME), the
# runner folder and the snapshots folder (compose mounts sirdar/runner and
# sirdar/snapshots over them). The chown is explicit:
```

with:

```dockerfile
# uid 10001 gets a home (ssh and Ansible keep small state under $HOME), the
# runner folder, the snapshots folder and the Terraform folder (compose
# mounts sirdar/runner, sirdar/snapshots and sirdar/terraform over them).
# The chown is explicit:
```

and replace:

```dockerfile
 && install -d -o sirdar -g sirdar -m 700 /app/runner /app/snapshots
```

with:

```dockerfile
 && install -d -o sirdar -g sirdar -m 700 /app/runner /app/snapshots /app/terraform
```

In `sirdar/docker-compose.yml`, replace:

```yaml
      # Snapshot bundles (database, files and encrypted sign-in keys).
      SIRDAR_SNAPSHOTS_DIR: /app/snapshots
```

with:

```yaml
      # Snapshot bundles (database, files and encrypted sign-in keys).
      SIRDAR_SNAPSHOTS_DIR: /app/snapshots
      # Proxmox environments: one Terraform folder (state included) each.
      SIRDAR_TERRAFORM_DIR: /app/terraform
```

and replace:

```yaml
      - ./snapshots:/app/snapshots
```

with:

```yaml
      - ./snapshots:/app/snapshots
      # Terraform state for Proxmox VMs: owned by uid 10001, mode 700 (the
      # installer sets that up). Losing it means VMs must be removed by hand.
      - ./terraform:/app/terraform
```

In `sirdar/install.sh`, replace:

```bash
ensure_snapshots_dir() {  # ensure_snapshots_dir DIR
  ensure_private_dir "$1" "snapshots can't be uploaded or taken"
}
```

with:

```bash
ensure_snapshots_dir() {  # ensure_snapshots_dir DIR
  ensure_private_dir "$1" "snapshots can't be uploaded or taken"
}
# Terraform state for Proxmox VMs lives in <dir>/sirdar/terraform (/app/terraform).
ensure_terraform_dir() {  # ensure_terraform_dir DIR
  ensure_private_dir "$1" "Proxmox environments can't be built or deleted"
}
```

and replace:

```bash
  ensure_snapshots_dir "$DIR/sirdar/snapshots"
```

with:

```bash
  ensure_snapshots_dir "$DIR/sirdar/snapshots"
  ensure_terraform_dir "$DIR/sirdar/terraform"
```

In `sirdar/.gitignore`, replace:

```
snapshots/*
!snapshots/.gitkeep
```

with:

```
snapshots/*
!snapshots/.gitkeep
terraform/*
!terraform/.gitkeep
```

Create the empty file `sirdar/terraform/.gitkeep`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_terraform.py tests/test_deploy_tls_pin.py`
Expected: PASS.

- [ ] **Step 9: Check the image builds and Terraform finds the provider offline**

Run (from the worktree root; Docker must be running):

```bash
docker build -f sirdar/Dockerfile --target terraform -t sirdar-terraform-check .
docker run --rm --network none -e TF_CLI_CONFIG_FILE=/opt/terraform/terraformrc \
  -w /tmp sirdar-terraform-check sh -c '
terraform version
echo "{\"terraform\":{\"required_providers\":{\"proxmox\":{\"source\":\"bpg/proxmox\",\"version\":\"= 0.115.0\"}}}}" > main.tf.json
terraform init -input=false -no-color | tail -3'
docker image rm sirdar-terraform-check
```

Expected: `Terraform v1.16.5`, then `Terraform has been successfully initialized!` with no network (`--network none`). A checksum mismatch fails the build at `sha256sum -c -`.

- [ ] **Step 10: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/terraform.py src/sirdar_api/config.py tests/fake_terraform.py tests/conftest.py tests/test_deploy_terraform.py && cd ../..
git add sirdar/api/src/sirdar_api/deploy/terraform.py sirdar/api/src/sirdar_api/config.py \
  sirdar/api/tests/fake_terraform.py sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_terraform.py \
  sirdar/terraformrc sirdar/terraform/.gitkeep sirdar/Dockerfile sirdar/docker-compose.yml \
  sirdar/install.sh sirdar/.gitignore
git commit -m "feat(sirdar): Terraform runner and per-environment state; pinned Terraform and bpg/proxmox in the image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: VM records and Proxmox environments

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/vms.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/ssh.py`, `sirdar/api/src/sirdar_api/deploy/targets.py`, `sirdar/api/src/sirdar_api/deploy/gitref.py`, `sirdar/api/src/sirdar_api/deploy/environments.py`
- Create: `sirdar/api/tests/vm_helpers.py`
- Test: `sirdar/api/tests/test_deploy_vms.py`

**Interfaces:**
- Consumes: `ProxmoxVm` (Task 1); `integrations.is_configured`, `config_of` (Task 2); `fake_terraform.write_state` (Task 5).
- Produces (module `sirdar_api.deploy.targets`): `PROXMOX_TARGET = "proxmox"`; `public_targets(s, *, proxmox_configured: bool = False)` appends `{"id": "proxmox", "label": "Proxmox", "kind": "proxmox", "available": True, "configured": True}` when configured.
- Produces (module `sirdar_api.deploy.ssh`): `SshTargetConfig.private_key: str | None` (`repr=False`; an in-memory OpenSSH key, used before `key_file`); `load_client_key` raises `ConnectFailed("Sirdar's key for this VM can't be read.")` for an unreadable one.
- Produces (module `sirdar_api.deploy.gitref`): `is_full_sha(ref: str) -> bool`.
- Produces (module `sirdar_api.deploy.vms`): `PROXMOX_TARGET`; `VM_USER = "deploy"`; `VM_SSH_PORT = 22` (tests set it to their SSH server's port; read at call time); `DEFAULTS = {"cores": 4, "memory_mb": 8192, "disk_gb": 64}`; `KEEP_SNAPSHOTS = 3`; `LIMITS`; `class VmError(Exception)` (`.code`, `.extra`); `vm_name(env_name) -> str` (`ss-<env>`); `check_size(key, value) -> int`; `check_network(ip_mode, ip_cidr, gateway) -> tuple[str, str | None, str | None]`; `static_ip(ip_cidr) -> str | None`; `check_spec(fields: dict) -> dict` (`cores, memory_mb, disk_gb, ip_mode, ip_cidr, gateway`); `new_keypair(env_name) -> tuple[str, str]` (private, public OpenSSH); `async get(db, env_id) -> ProxmoxVm | None`; `async address_in_use(db, settings, ip, *, proxy_ip, env_id=None) -> bool`; `async add(db, settings, env, spec, node) -> ProxmoxVm`; `async host_config(db, settings, env) -> SshTargetConfig | None` (a saved target's config, or the VM's once it has an address; may raise `vault.SecretsKeyMissing` / `vault.SecretUnreadable`); `snapshot_name(now) -> str`, `snapshot_taken_at(name) -> datetime`, `valid_snapshot_name(name) -> bool`, `snapshot_blocked(name, changed_at: datetime | None) -> str | None`; `async taking_deployments(db, env_id) -> dict[str, Deployment]` (snapshot name → the first deployment that took it); `async update(db, vm, fields) -> list[str]` (`"vm.cores"` etc.); `public(vm) -> dict`.
- Produces (module `sirdar_api.deploy.environments`): `create_new(..., vm: dict | None = None)` — for `target_id == "proxmox"` checks the integration (`EnvError("integration_not_configured", kinds=["proxmox"])`), the spec (`vm_*` codes), the address (`ip_in_use`), points every service at the static address (`0.0.0.0` for DHCP) and adds the `proxmox_vms` row; a `vm` for an SSH target is `vm_not_allowed`. `adopt` refuses `proxmox` (`adopt_not_allowed`). `update` takes `vm` (`vm_not_allowed`, `vm_disk_shrink`, `vm_keep_snapshots_invalid`, …) and refuses `target_kind_locked` and `host_ip_managed {service}`.
- Produces (tests): `tests/vm_helpers.py` — `VM_SPEC`, `async make_vm_environment(db, *, name="uat3", current_sha=None, publish=False, **vm)`, `host_key_line(fake_ssh) -> str`, `apply_creates_vm(fake_px, host_key, ips=("127.0.0.1",))`, `destroy_removes_vm(fake_px)`.

- [ ] **Step 1: Write the test helpers**

Create `sirdar/api/tests/vm_helpers.py`:

```python
"""Proxmox environments for tests. The VM's static address is on loopback
(127.0.0.1/8), so the tests' own SSH server plays the VM once
vms.VM_SSH_PORT points at it; FakeProxmox's agent reports that address on
eth0 and the server's host key. The Terraform effects create or remove the
VM in FakeProxmox the way a real apply or destroy would."""

import json

from sirdar_api.config import get_settings
from sirdar_api.db.models import Environment
from sirdar_api.deploy import envfile, environments

from .fake_terraform import write_state

VM_SPEC = {"ip_mode": "static", "ip_cidr": "127.0.0.1/8", "gateway": "127.0.0.254"}


async def make_vm_environment(db, *, name: str = "uat3", current_sha: str | None = None,
                              publish: bool = False, **vm) -> Environment:
    """Needs the secrets_key fixture and a saved Proxmox integration."""
    env = await environments.create_new(db, get_settings(), name=name, type_="dev",
                                        target_id="proxmox", proxy_ip="10.0.0.2",
                                        vm={**VM_SPEC, **vm}, publish=publish)
    if current_sha:
        env.current_sha, env.image_tag = current_sha, envfile.image_tag(current_sha)
        env.status = "ready"
    await db.commit()
    return env


def host_key_line(fake_ssh) -> str:
    return fake_ssh.host_key.export_public_key("openssh").decode().strip()


def _vm_block(request) -> dict:
    config = json.loads((request.workdir / "main.tf.json").read_text())
    return config["resource"]["proxmox_virtual_environment_vm"]["vm"]


def apply_creates_vm(fake_px, host_key: str | None, ips: tuple[str, ...] = ("127.0.0.1",)):
    def effect(request) -> None:
        vm = _vm_block(request)
        if vm["vm_id"] not in fake_px.vms:
            fake_px.add_vm(vm["vm_id"], vm["name"], ips=ips, host_key=host_key)
        write_state(request)
    return effect


def destroy_removes_vm(fake_px):
    def effect(request) -> None:
        fake_px.remove_vm(_vm_block(request)["vm_id"])
        write_state(request, vm=False)
    return effect
```

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_vms.py`:

```python
from datetime import UTC, datetime, timedelta

import asyncssh
import pytest

from sirdar_api.config import get_settings
from sirdar_api.deploy import ConnectFailed, environments, gitref, ssh, targets, vault, vms
from sirdar_api.deploy.environments import EnvError
from sirdar_api.deploy.ssh import SshTargetConfig

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import configure_proxmox
from .test_deploy_api import deploy_env  # noqa: F401
from .test_scaffold import _settings

VM = {"ip_mode": "static", "ip_cidr": "10.10.48.70/24", "gateway": "10.10.48.1"}


async def _create(db, name="uat3", **kw):
    return await environments.create_new(
        db, get_settings(), name=name, type_="dev", target_id=kw.pop("target_id", "proxmox"),
        proxy_ip="10.10.48.6", vm=kw.pop("vm", VM), **kw)


def test_sizes_default_and_networks_are_checked():
    assert vms.check_spec({"ip_mode": "dhcp"}) == {
        "cores": 4, "memory_mb": 8192, "disk_gb": 64, "ip_mode": "dhcp", "ip_cidr": None,
        "gateway": None}
    spec = vms.check_spec({**VM, "cores": 8, "memory_mb": 16384, "disk_gb": 128,
                           "ip_cidr": " 10.10.48.70/24 "})
    assert (spec["cores"], spec["ip_cidr"], spec["gateway"]) == (8, "10.10.48.70/24", "10.10.48.1")
    assert vms.static_ip("10.10.48.70/24") == "10.10.48.70" and vms.static_ip(None) is None


@pytest.mark.parametrize("fields,code", [
    ({"ip_mode": "dhcp", "cores": 0}, "vm_cores_invalid"),
    ({"ip_mode": "dhcp", "cores": True}, "vm_cores_invalid"),
    ({"ip_mode": "dhcp", "memory_mb": 1024}, "vm_memory_invalid"),
    ({"ip_mode": "dhcp", "disk_gb": 5000}, "vm_disk_invalid"),
    ({"ip_mode": "bridged"}, "vm_ip_mode_invalid"),
    ({}, "vm_ip_mode_invalid"),
    ({**VM, "ip_cidr": "10.10.48.70"}, "vm_ip_invalid"),         # no prefix
    ({**VM, "ip_cidr": "10.10.48.0/24"}, "vm_ip_invalid"),       # the network's own address
    ({**VM, "ip_cidr": "10.10.48.255/24"}, "vm_ip_invalid"),     # its broadcast address
    ({**VM, "ip_cidr": "fe80::1/64"}, "vm_ip_invalid"),
    ({**VM, "gateway": "10.10.49.1"}, "vm_gateway_invalid"),     # outside the network
    ({**VM, "gateway": "10.10.48.70"}, "vm_gateway_invalid"),    # the VM itself
    ({**VM, "gateway": ""}, "vm_gateway_invalid"),
])
def test_bad_specs(fields, code):
    with pytest.raises(vms.VmError) as e:
        vms.check_spec(fields)
    assert e.value.code == code


def test_snapshot_names_and_the_key_rule():
    now = datetime(2026, 10, 4, 12, 0, 5, tzinfo=UTC)
    name = vms.snapshot_name(now)
    assert name == "sirdar-20261004T120005Z"
    assert vms.valid_snapshot_name(name) and vms.snapshot_taken_at(name) == now
    for bad in ("sirdar-20261304T120005Z", "manual-before-upgrade", "sirdar-20261004T120005",
                "current"):
        assert not vms.valid_snapshot_name(bad)
    assert vms.snapshot_blocked(name, None) is None
    assert vms.snapshot_blocked(name, now - timedelta(minutes=1)) is None
    assert vms.snapshot_blocked(name, now) == (
        "Taken before the sign-in keys changed (snapshot restore on 2026-10-04 12:00 UTC).")


async def test_create_a_proxmox_environment(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    env = await _create(db)
    await db.commit()
    vm = await vms.get(db, env.id)
    assert (vm.name, vm.node, vm.vmid, vm.ip, vm.created, vm.cores, vm.keep_snapshots) == (
        "ss-uat3", "pve", None, None, False, 4, 3)
    assert vm.ssh_public_key.startswith("ssh-ed25519 ")
    assert vm.ssh_public_key.endswith(" sirdar@ss-uat3")
    private = vault.decrypt(get_settings(), vm.ssh_private_key_enc)
    derived = asyncssh.import_private_key(private).export_public_key("openssh").decode()
    assert derived.split()[:2] == vm.ssh_public_key.split()[:2]
    assert {s.host_ip for s in await environments.services_of(db, env.id)} == {"10.10.48.70"}
    assert env.target_id == "proxmox"
    assert await vms.host_config(db, get_settings(), env) is None     # no address read yet
    assert vms.public(vm) == {
        "name": "ss-uat3", "node": "pve", "vmid": None, "cores": 4, "memory_mb": 8192,
        "disk_gb": 64, "ip_mode": "static", "ip_cidr": "10.10.48.70/24",
        "gateway": "10.10.48.1", "ip": None, "keep_snapshots": 3, "created": False}


async def test_a_dhcp_vm_s_services_wait_for_its_address(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    env = await _create(db, vm={"ip_mode": "dhcp", "cores": 2})
    await db.commit()
    assert {s.host_ip for s in await environments.services_of(db, env.id)} == {"0.0.0.0"}


async def test_create_needs_the_integration_and_a_free_address(db, deploy_env, secrets_key):
    deploy_env(ssh_host="10.10.48.63", ssh_user="jrh", ssh_password="pw")   # uat's VM
    with pytest.raises(EnvError) as e:
        await _create(db)
    assert (e.value.code, e.value.extra) == ("integration_not_configured", {"kinds": ["proxmox"]})
    await configure_proxmox(db)
    for taken in ("10.10.48.63/24", "10.10.48.6/24"):        # an SSH target, the proxy
        with pytest.raises(EnvError) as e:
            await _create(db, vm={**VM, "ip_cidr": taken})
        assert e.value.code == "ip_in_use"
    await _create(db)
    await db.commit()
    with pytest.raises(EnvError) as e:
        await _create(db, name="uat4")                       # uat3's address
    assert e.value.code == "ip_in_use"
    with pytest.raises(EnvError) as e:
        await _create(db, name="uat4", vm={**VM, "cores": 99})
    assert e.value.code == "vm_cores_invalid"


async def test_target_rules(db, deploy_env, secrets_key):
    deploy_env(ssh_host="10.10.48.20", ssh_user="root", ssh_password="pw")
    await configure_proxmox(db)
    with pytest.raises(EnvError) as e:
        await _create(db, name="plain", target_id="ssh")
    assert e.value.code == "vm_not_allowed"
    with pytest.raises(EnvError) as e:
        await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                 target_id="proxmox")
    assert e.value.code == "adopt_not_allowed"
    await _create(db)
    await db.commit()
    settings = get_settings()
    for fields, code in (({"target": "ssh"}, "target_kind_locked"),
                         ({"services": {"api": {"host_ip": "10.10.48.71"}}}, "host_ip_managed"),
                         ({"vm": {"disk_gb": 32}}, "vm_disk_shrink"),
                         ({"vm": {"keep_snapshots": 0}}, "vm_keep_snapshots_invalid"),
                         ({"vm": {"memory_mb": 1000}}, "vm_memory_invalid")):
        # A rollback expires every loaded row: read the environment again each time.
        env = await environments.get_by_name(db, "uat3")
        with pytest.raises(EnvError) as e:
            await environments.update(db, settings, env, fields)
        assert e.value.code == code, fields
        await db.rollback()
    env = await environments.get_by_name(db, "uat3")
    changed = await environments.update(db, settings, env, {
        "vm": {"cores": 8, "memory_mb": 16384, "disk_gb": 64, "keep_snapshots": 5},
        "services": {"api": {"port": 8100}}})
    await db.commit()
    assert changed == ["services.api.port", "vm.cores", "vm.memory_mb", "vm.keep_snapshots"]
    vm = await vms.get(db, env.id)
    assert (vm.cores, vm.memory_mb, vm.disk_gb, vm.keep_snapshots) == (8, 16384, 64, 5)
    plain = await make_environment(db, name="plain", target_id="ssh")
    with pytest.raises(EnvError) as e:
        await environments.update(db, settings, plain, {"vm": {"cores": 2}})
    assert e.value.code == "vm_not_allowed"
    await db.rollback()
    plain = await environments.get_by_name(db, "plain")
    with pytest.raises(EnvError) as e:
        await environments.update(db, settings, plain, {"target": "proxmox"})
    assert e.value.code == "target_kind_locked"


async def test_the_vm_s_ssh_connection(db, deploy_env, secrets_key):
    deploy_env(ssh_host="10.10.48.20", ssh_user="root", ssh_password="pw")
    await configure_proxmox(db)
    env = await _create(db)
    vm = await vms.get(db, env.id)
    vm.ip = "10.10.48.70"
    await db.commit()
    cfg = await vms.host_config(db, get_settings(), env)
    assert (cfg.host, cfg.port, cfg.user, cfg.auth_label, cfg.password) == (
        "10.10.48.70", 22, "deploy", "key", None)
    assert "PRIVATE KEY" not in repr(cfg)
    key = await ssh.load_client_key(cfg)
    assert key.export_public_key("openssh").decode().split()[:2] == vm.ssh_public_key.split()[:2]
    plain = await make_environment(db, name="plain", target_id="ssh")
    assert await vms.host_config(db, get_settings(), plain) == targets.ssh_config_for(
        "ssh", get_settings())
    with pytest.raises(ConnectFailed) as e:
        await ssh.load_client_key(SshTargetConfig(host="h", port=22, user="u",
                                                  private_key="not a key"))
    assert e.value.reason == "Sirdar's key for this VM can't be read."


def test_the_target_list_shows_proxmox_once_it_is_set_up(tmp_path):
    s = _settings(deploy_targets_file=str(tmp_path / "none.env"))
    assert "proxmox" not in [t["id"] for t in targets.public_targets(s)]
    assert targets.public_targets(s, proxmox_configured=True)[-1] == {
        "id": "proxmox", "label": "Proxmox", "kind": "proxmox", "available": True,
        "configured": True}


def test_is_full_sha():
    assert gitref.is_full_sha("A" * 40) and gitref.is_full_sha("0123456789" * 4)
    assert not gitref.is_full_sha("main") and not gitref.is_full_sha("a" * 39)
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_vms.py`
Expected: FAIL — `ImportError: cannot import name 'vms'`.

- [ ] **Step 4: Teach `SshTargetConfig` an in-memory key**

In `sirdar/api/src/sirdar_api/deploy/ssh.py`, replace:

```python
    passphrase: str | None = field(default=None, repr=False)
    sudo_password: str | None = field(default=None, repr=False)

    @property
    def auth_label(self) -> str:
        key, password = bool(self.key_name), self.password is not None
```

with:

```python
    passphrase: str | None = field(default=None, repr=False)
    sudo_password: str | None = field(default=None, repr=False)
    # An unencrypted OpenSSH private key held in memory (a Proxmox VM's key,
    # decrypted from proxmox_vms); used instead of key_file.
    private_key: str | None = field(default=None, repr=False)

    @property
    def auth_label(self) -> str:
        key, password = bool(self.key_name) or self.private_key is not None, \
            self.password is not None
```

and replace:

```python
async def load_client_key(cfg: SshTargetConfig) -> asyncssh.SSHKey | None:
    raw = cfg.key_name
```

with:

```python
async def load_client_key(cfg: SshTargetConfig) -> asyncssh.SSHKey | None:
    if cfg.private_key is not None:
        try:
            return asyncssh.import_private_key(cfg.private_key)
        except (asyncssh.KeyImportError, ValueError):
            raise ConnectFailed("Sirdar's key for this VM can't be read.") from None
    raw = cfg.key_name
```

- [ ] **Step 5: The Proxmox target id and full SHAs**

In `sirdar/api/src/sirdar_api/deploy/targets.py`, replace:

```python
INSTALLER_LABEL = "Custom (SSH) · Installer"
```

with:

```python
INSTALLER_LABEL = "Custom (SSH) · Installer"
# An environment whose host is a VM Sirdar builds on Proxmox (phase 5).
PROXMOX_TARGET = "proxmox"
```

and replace:

```python
def public_targets(s: Settings) -> list[dict]:
    out = [{"id": t.id, "label": t.label, "kind": t.id, "available": t.available,
            "configured": is_configured(t.id, s)}
           for t in TARGETS if t.id != "ssh"]
```

with:

```python
def public_targets(s: Settings, *, proxmox_configured: bool = False) -> list[dict]:
    """Proxmox is listed (last) once its integration is saved."""
    out = [{"id": t.id, "label": t.label, "kind": t.id, "available": t.available,
            "configured": is_configured(t.id, s)}
           for t in TARGETS if t.id != "ssh"]
```

and, at the end of `public_targets`, replace:

```python
    out += [{"id": t.id, "label": t.name, "kind": "ssh", "source": "saved",
             "available": True, "configured": t.configured}
            for t in saved_targets(s)]
    return out
```

with:

```python
    out += [{"id": t.id, "label": t.name, "kind": "ssh", "source": "saved",
             "available": True, "configured": t.configured}
            for t in saved_targets(s)]
    if proxmox_configured:
        out.append({"id": PROXMOX_TARGET, "label": "Proxmox", "kind": "proxmox",
                    "available": True, "configured": True})
    return out
```

In `sirdar/api/src/sirdar_api/deploy/gitref.py`, after `valid_ref`, add:

```python
def is_full_sha(ref: str) -> bool:
    return bool(_ANY_SHA_RE.fullmatch(ref))
```

- [ ] **Step 6: Write `vms.py`**

Create `sirdar/api/src/sirdar_api/deploy/vms.py`:

```python
"""Proxmox VMs Sirdar builds for environments (phase 5). The proxmox_vms
row is both the VM's settings and the record that it is Sirdar's: sizing
and network checks, the per-environment SSH key pair (private half
encrypted with SIRDAR_SECRETS_KEY), address checks that keep a new VM off
addresses in use, the VM's SSH connection for the deploy steps, and VM
snapshot names. Callers audit and commit."""

import ipaddress
import re
from datetime import UTC, datetime

import asyncssh
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment, EnvironmentService, ProxmoxVm
from sirdar_api.deploy import targets, vault
from sirdar_api.deploy.ssh import SshTargetConfig

PROXMOX_TARGET = targets.PROXMOX_TARGET
VM_USER = "deploy"                 # cloud-init's user: passwordless sudo on Ubuntu cloud images
VM_SSH_PORT = 22                   # read at call time; tests point it at their SSH server
DEFAULTS = {"cores": 4, "memory_mb": 8192, "disk_gb": 64}
KEEP_SNAPSHOTS = 3
LIMITS = {"cores": (1, 64), "memory_mb": (2048, 262144), "disk_gb": (20, 4096),
          "keep_snapshots": (1, 10)}
_CODES = {"cores": "vm_cores_invalid", "memory_mb": "vm_memory_invalid",
          "disk_gb": "vm_disk_invalid", "keep_snapshots": "vm_keep_snapshots_invalid"}
SNAPSHOT_RE = re.compile(r"sirdar-[0-9]{8}T[0-9]{6}Z")
_SNAPSHOT_FORMAT = "sirdar-%Y%m%dT%H%M%SZ"


class VmError(Exception):
    """A validation failure; `code` is the API error code."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def vm_name(env_name: str) -> str:
    return f"ss-{env_name}"


def check_size(key: str, value) -> int:
    low, high = LIMITS[key]
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise VmError(_CODES[key])
    return value


def check_network(ip_mode, ip_cidr, gateway) -> tuple[str, str | None, str | None]:
    """("dhcp", None, None) or ("static", "a.b.c.d/nn", "gateway"). The
    address needs its prefix (8–30) and can't be the network's own or
    broadcast address; the gateway must be another address in it."""
    if ip_mode == "dhcp":
        return "dhcp", None, None
    if ip_mode != "static":
        raise VmError("vm_ip_mode_invalid")
    try:
        iface = ipaddress.IPv4Interface(str(ip_cidr or "").strip())
    except ValueError:
        raise VmError("vm_ip_invalid") from None
    net = iface.network
    if (not 8 <= net.prefixlen <= 30
            or iface.ip in (net.network_address, net.broadcast_address)):
        raise VmError("vm_ip_invalid")
    try:
        gw = ipaddress.IPv4Address(str(gateway or "").strip())
    except ValueError:
        raise VmError("vm_gateway_invalid") from None
    if gw not in net or gw == iface.ip:
        raise VmError("vm_gateway_invalid")
    return "static", str(iface), str(gw)


def static_ip(ip_cidr: str | None) -> str | None:
    return str(ipaddress.IPv4Interface(ip_cidr).ip) if ip_cidr else None


def check_spec(fields: dict) -> dict:
    sizes = {key: check_size(key, fields[key] if fields.get(key) is not None else default)
             for key, default in DEFAULTS.items()}
    mode, cidr, gateway = check_network(fields.get("ip_mode"), fields.get("ip_cidr"),
                                        fields.get("gateway"))
    return {**sizes, "ip_mode": mode, "ip_cidr": cidr, "gateway": gateway}


def new_keypair(env_name: str) -> tuple[str, str]:
    """(private, public) OpenSSH ed25519 keys for one VM."""
    key = asyncssh.generate_private_key("ssh-ed25519", comment=f"sirdar@{vm_name(env_name)}")
    return (key.export_private_key("openssh").decode(),
            key.export_public_key("openssh").decode().strip())


async def get(db: AsyncSession, env_id) -> ProxmoxVm | None:
    return await db.get(ProxmoxVm, env_id, populate_existing=True)


async def address_in_use(db: AsyncSession, settings: Settings, ip: str, *, proxy_ip: str,
                         env_id=None) -> bool:
    """The proxy's address, a saved SSH target's host (uat's VM among them),
    another environment's service address, or another VM's address."""
    if ip == proxy_ip or any(cfg.host == ip for _, cfg in targets.ssh_configs(settings)):
        return True
    services = select(EnvironmentService.host_ip)
    machines = select(ProxmoxVm)
    if env_id is not None:
        services = services.where(EnvironmentService.environment_id != env_id)
        machines = machines.where(ProxmoxVm.environment_id != env_id)
    if ip in set(await db.scalars(services)):
        return True
    return any(ip in (vm.ip, static_ip(vm.ip_cidr)) for vm in await db.scalars(machines))


async def add(db: AsyncSession, settings: Settings, env: Environment, spec: dict,
              node: str) -> ProxmoxVm:
    private, public_key = new_keypair(env.name)
    vm = ProxmoxVm(environment_id=env.id, node=node, name=vm_name(env.name),
                   cores=spec["cores"], memory_mb=spec["memory_mb"], disk_gb=spec["disk_gb"],
                   ip_mode=spec["ip_mode"], ip_cidr=spec["ip_cidr"], gateway=spec["gateway"],
                   ip=None, ssh_public_key=public_key,
                   ssh_private_key_enc=vault.encrypt(settings, private),
                   keep_snapshots=KEEP_SNAPSHOTS)
    db.add(vm)
    await db.flush()
    return vm


async def host_config(db: AsyncSession, settings: Settings,
                      env: Environment) -> SshTargetConfig | None:
    """The SSH connection the deploy steps use: a saved target's, or for a
    Proxmox environment the VM's (None until step 0 has read its address).
    The VM's key is decrypted here: vault.SecretsKeyMissing or
    vault.SecretUnreadable propagate."""
    if env.target_id != PROXMOX_TARGET:
        return targets.ssh_config_for(env.target_id, settings)
    vm = await get(db, env.id)
    if vm is None or not vm.ip:
        return None
    return SshTargetConfig(host=vm.ip, port=VM_SSH_PORT, user=VM_USER,
                           private_key=vault.decrypt(settings, vm.ssh_private_key_enc),
                           key_name=f"Sirdar's key for {vm.name}")


def snapshot_name(now: datetime) -> str:
    return now.astimezone(UTC).strftime(_SNAPSHOT_FORMAT)


def snapshot_taken_at(name: str) -> datetime:
    return datetime.strptime(name, _SNAPSHOT_FORMAT).replace(tzinfo=UTC)


def valid_snapshot_name(name: str) -> bool:
    if not isinstance(name, str) or not SNAPSHOT_RE.fullmatch(name):
        return False
    try:
        snapshot_taken_at(name)
    except ValueError:
        return False
    return True


def snapshot_blocked(name: str, changed_at: datetime | None) -> str | None:
    """Why a VM snapshot can't be restored (environments.backup_blocked's
    rule): taken at or before a snapshot restore replaced the sign-in keys,
    its .env holds keys that exist nowhere any more."""
    if changed_at is None or snapshot_taken_at(name) > changed_at:
        return None
    when = changed_at.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
    return f"Taken before the sign-in keys changed (snapshot restore on {when})."


async def taking_deployments(db: AsyncSession, env_id) -> dict[str, Deployment]:
    """VM snapshot name -> the first deployment that took it (its retries
    carry the same name; a vm_restore names the one it restores)."""
    rows = await db.scalars(select(Deployment).where(
        Deployment.environment_id == env_id, Deployment.vm_snapshot.is_not(None),
        Deployment.mode != "vm_restore").order_by(Deployment.created_at))
    found: dict[str, Deployment] = {}
    for dep in rows:
        found.setdefault(dep.vm_snapshot, dep)
    return found


async def update(db: AsyncSession, vm: ProxmoxVm, fields: dict) -> list[str]:
    """A PATCH's `vm`: sizes and how many VM snapshots to keep (the next
    deploy's step 0 applies the sizes). A disk never shrinks."""
    changed: list[str] = []
    for key in ("cores", "memory_mb", "disk_gb", "keep_snapshots"):
        if fields.get(key) is None:
            continue
        value = check_size(key, fields[key])
        if key == "disk_gb" and value < vm.disk_gb:
            raise VmError("vm_disk_shrink")
        if getattr(vm, key) != value:
            setattr(vm, key, value)
            changed.append(f"vm.{key}")
    if changed:
        vm.updated_at = datetime.now(UTC)
    await db.flush()
    return changed


def public(vm: ProxmoxVm) -> dict:
    return {"name": vm.name, "node": vm.node, "vmid": vm.vmid, "cores": vm.cores,
            "memory_mb": vm.memory_mb, "disk_gb": vm.disk_gb, "ip_mode": vm.ip_mode,
            "ip_cidr": vm.ip_cidr, "gateway": vm.gateway, "ip": vm.ip,
            "keep_snapshots": vm.keep_snapshots, "created": vm.created}
```

- [ ] **Step 7: Proxmox environments in `environments.py`**

In `sirdar/api/src/sirdar_api/deploy/environments.py`:

Replace:

```python
from sirdar_api.deploy import ConnectFailed, envfile, names, ssh, targets, vault
```

with:

```python
from sirdar_api.deploy import ConnectFailed, envfile, integrations, names, ssh, targets, vault, vms
```

Replace the whole `_check_target` function:

```python
def _check_target(target_id: str, settings: Settings) -> SshTargetConfig:
    if not SSH_TARGET_RE.fullmatch(target_id):
        raise EnvError("target_invalid")
    cfg = targets.ssh_config_for(target_id, settings)
    if cfg is None:
        raise EnvError("target_not_configured")
    return cfg
```

with:

```python
def _check_target(target_id: str, settings: Settings) -> SshTargetConfig | None:
    """An SSH target's config, or None for "proxmox" (the host is the VM
    step 0 builds)."""
    if target_id == targets.PROXMOX_TARGET:
        return None
    if not SSH_TARGET_RE.fullmatch(target_id):
        raise EnvError("target_invalid")
    cfg = targets.ssh_config_for(target_id, settings)
    if cfg is None:
        raise EnvError("target_not_configured")
    return cfg
```

Replace the signature line of `_precheck`:

```python
                    target_id: str, git_ref: str) -> SshTargetConfig:
```

with:

```python
                    target_id: str, git_ref: str) -> SshTargetConfig | None:
```

Replace the start of `_insert`:

```python
async def _insert(db: AsyncSession, settings: Settings, cfg: SshTargetConfig, *, name: str,
                  type_: str, target_id: str, git_ref: str, domain: str, proxy_ip: str,
```

with:

```python
async def _insert(db: AsyncSession, settings: Settings, *, name: str,
                  type_: str, target_id: str, git_ref: str, host: str, domain: str,
                  proxy_ip: str,
```

and, inside `_insert`, replace:

```python
        db.add(EnvironmentService(environment_id=env.id, service=service, host_ip=cfg.host,
```

with:

```python
        db.add(EnvironmentService(environment_id=env.id, service=service, host_ip=host,
```

Replace the whole `create_new` function with:

```python
async def create_new(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                     target_id: str, git_ref: str = DEFAULT_GIT_REF,
                     base_domain: str | None = None, proxy_ip: str | None = None,
                     bind_ip: str = DEFAULT_BIND_IP,
                     ports: dict[str, int] | None = None, actor_id=None,
                     snapshot_id: uuid.UUID | None = None,
                     publish: bool = True, vm: dict | None = None) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets. With a
    snapshot, its first deploy restores that snapshot (and its keys). With
    publish (the default), its deploys add DNS, proxy and smoke steps. On
    target "proxmox", `vm` sizes the VM step 0 builds and sets its network;
    every service points at its static address (0.0.0.0 for DHCP until step
    0 reads it), and the proxmox_vms row records it as Sirdar's."""
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
    if snapshot_id is not None:
        # Locked until the caller commits, so a concurrent delete waits and
        # then sees this environment's seed (in use) instead of racing it.
        snap = await db.scalar(select(Snapshot).where(Snapshot.id == snapshot_id)
                               .with_for_update()
                               .execution_options(populate_existing=True))
        if snap is None:
            raise EnvError("snapshot_not_found")
        if snap.status != "ready":
            raise EnvError("snapshot_not_ready")
    domain = _check_domain(base_domain or f"{name}.{DEFAULT_DOMAIN_SUFFIX}")
    if not proxy_ip:
        raise EnvError("proxy_ip_required")
    proxy = _check_ipv4(proxy_ip, "proxy_ip_invalid")
    bind = _check_ipv4(bind_ip, "bind_ip_invalid")
    given = ports or {}
    unknown = sorted(set(given) - set(envfile.SERVICES))
    if unknown:
        raise EnvError("service_unknown", service=unknown[0])
    all_ports = {s: _check_port(given.get(s, envfile.DEFAULT_PORTS[s]), s)
                 for s in envfile.SERVICES}
    _check_ports_unique(all_ports)
    spec = None
    host = cfg.host if cfg is not None else ""
    if target_id == targets.PROXMOX_TARGET:
        if not await integrations.is_configured(db, "proxmox"):
            raise EnvError("integration_not_configured", kinds=["proxmox"])
        try:
            spec = vms.check_spec(vm or {})
        except vms.VmError as e:
            raise EnvError(e.code, **e.extra) from None
        address = vms.static_ip(spec["ip_cidr"])
        if address and await vms.address_in_use(db, settings, address, proxy_ip=proxy):
            raise EnvError("ip_in_use")
        host = address or "0.0.0.0"
    elif vm is not None:
        raise EnvError("vm_not_allowed")
    env = await _insert(
        db, settings, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        host=host, domain=domain, proxy_ip=proxy, bind_ip=bind, ports=all_ports,
        keep_dumps=envfile.DEFAULT_KEEP_DUMPS, spaces_bucket=envfile.DEFAULT_SPACES_BUCKET,
        log_level=envfile.DEFAULT_LOG_LEVEL, status="new", current_sha=None, image_tag=None,
        secrets=vault.generate_env_secrets(), actor_id=actor_id, seed_snapshot_id=snapshot_id,
        publish=publish)
    if spec is not None:
        node = (await integrations.config_of(db, "proxmox"))["node"]
        await vms.add(db, settings, env, spec, node)
    return env
```

In `adopt`, replace:

```python
                target_id: str, git_ref: str = "main",
                actor_id=None) -> tuple[Environment, Deployment, AdoptReport]:
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
```

with:

```python
                target_id: str, git_ref: str = "main",
                actor_id=None) -> tuple[Environment, Deployment, AdoptReport]:
    if target_id == targets.PROXMOX_TARGET:
        # Proxmox environments are only ones Sirdar built: a hand-built VM
        # (uat) stays an SSH target.
        raise EnvError("adopt_not_allowed")
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
```

and replace:

```python
    env = await _insert(
        db, settings, cfg, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        domain=picked["domain"], proxy_ip=picked["proxy_ip"], bind_ip=picked["bind_ip"],
```

with:

```python
    env = await _insert(
        db, settings, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        host=cfg.host, domain=picked["domain"], proxy_ip=picked["proxy_ip"],
        bind_ip=picked["bind_ip"],
```

In `update`, replace:

```python
    if fields.get("target") is not None:
        _check_target(fields["target"], settings)
        put("target_id", fields["target"])
```

with:

```python
    on_vm = env.target_id == targets.PROXMOX_TARGET
    if fields.get("target") is not None:
        if (fields["target"] == targets.PROXMOX_TARGET) != on_vm:
            raise EnvError("target_kind_locked")
        _check_target(fields["target"], settings)
        put("target_id", fields["target"])
```

replace:

```python
        if patch.get("host_ip") is not None:
            host_ip = _check_ipv4(patch["host_ip"], "host_ip_invalid")
```

with:

```python
        if patch.get("host_ip") is not None:
            if on_vm:                           # step 0 points them at the VM
                raise EnvError("host_ip_managed", service=service)
            host_ip = _check_ipv4(patch["host_ip"], "host_ip_invalid")
```

and replace:

```python
    if changed:
        env.updated_at = _now()
    await db.flush()
    return changed
```

with:

```python
    if fields.get("vm") is not None:
        machine = await vms.get(db, env.id) if on_vm else None
        if machine is None:
            raise EnvError("vm_not_allowed")
        try:
            changed += await vms.update(db, machine, fields["vm"])
        except vms.VmError as e:
            raise EnvError(e.code, **e.extra) from None

    if changed:
        env.updated_at = _now()
    await db.flush()
    return changed
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_vms.py tests/test_deploy_environments.py tests/test_deploy_environments_api.py tests/test_deploy_targets.py tests/test_deploy_ssh.py`
Expected: PASS (the existing environment, target and SSH tests behave as before).

- [ ] **Step 9: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/vms.py src/sirdar_api/deploy/ssh.py src/sirdar_api/deploy/targets.py src/sirdar_api/deploy/gitref.py src/sirdar_api/deploy/environments.py tests/vm_helpers.py tests/test_deploy_vms.py && cd ../..
git add sirdar/api/src/sirdar_api/deploy/vms.py sirdar/api/src/sirdar_api/deploy/ssh.py \
  sirdar/api/src/sirdar_api/deploy/targets.py sirdar/api/src/sirdar_api/deploy/gitref.py \
  sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/tests/vm_helpers.py \
  sirdar/api/tests/test_deploy_vms.py
git commit -m "feat(sirdar): Proxmox environments with an owned VM record, key pair and address checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The provisioner — Prepare VM, Restore VM snapshot, Destroy VM

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/provision.py`
- Create: `sirdar/api/tests/fake_provisioner.py`
- Modify: `sirdar/api/tests/conftest.py` (`no_real_hosts` guards the port probe)
- Test: `sirdar/api/tests/test_deploy_provision.py`

**Interfaces:**
- Consumes: `Proxmox`, `ProxmoxError`, `AgentNotReady` (Task 3); `terraform.*` (Task 5); `vms.*`, `targets.ssh_configs`, `gitref.resolve_ref` (Task 6); `known_hosts.trust/lookup/forget/fingerprint`, `ssh.pinned_host_key`; `publish.StepFailed`.
- Produces (module `sirdar_api.deploy.provision`): `HOST_KEY_FILE`; `TERRAFORM_DIR_UNWRITABLE`; `class VmPrepareError(Exception)` (`.reason`); frozen dataclasses `VmState` (`of(row)`, `static_ip`), `VmContext(env_id, env_name, deployment_id, actor_id, mode, git_ref, sha, repo_url, take_snapshot, vm_snapshot, vm: VmState, proxmox: ProxmoxConfig)` with `secret_values`, `VmOutcome(sha: str | None = None, vm_snapshot: str | None = None)`; `class Provisioner(Protocol)` with `async run(step, ctx, out) -> VmOutcome`; `async prepare(db, env, dep, settings) -> VmContext` (raises `VmPrepareError`); `async tcp_open(host, port, timeout=3.0) -> bool` (guarded in tests); `class ProxmoxProvisioner(*, terraform_runner, settings, sleep=asyncio.sleep, probe=None, resolve=None, now=None, agent_wait=300, ssh_wait=300, poll=5)`; steps `"provision"`, `"vm_restore"`, `"destroy"`; failures raise `publish.StepFailed` with our copy.
- Produces (tests): `tests/fake_provisioner.py` — `FakeProvisioner` (`calls`, `contexts`, `outcomes[step]`, `fail[step]`, `raises[step]`, `gates[step]`, `effects[step] = async fn(ctx)`).

- [ ] **Step 1: Guard the port probe**

In `sirdar/api/tests/conftest.py`, replace the whole `no_real_hosts` fixture (Tasks 2 and 5 built it) with its final form:

```python
@pytest.fixture(autouse=True)
def no_real_hosts():
    """No test reaches a real Proxmox host outside httpx: the raw TLS
    certificate fetch may only dial 127.0.0.1 (the tests' own TLS server),
    Terraform only runs fake-* scripts, and the provisioner's port probe
    never dials out. Yields the list of blocked attempts (a test that
    blocks on purpose clears it); the test fails at teardown if any is
    left. Its own MonkeyPatch, like no_real_http."""
    from sirdar_api.deploy import provision, terraform, tls_pin

    hits: list[str] = []
    real_read = tls_pin._read_certificate
    real_spawn = terraform._spawn

    def read(host, port):
        if host != "127.0.0.1":
            hits.append(f"tls:{host}")
            raise AssertionError(f"a test fetched a real TLS certificate from {host}")
        return real_read(host, port)

    async def spawn(argv, **kw):
        if not Path(argv[0]).name.startswith("fake-"):
            hits.append(f"terraform:{argv[0]}")
            raise AssertionError(f"a test started a real Terraform ({argv[0]})")
        return await real_spawn(argv, **kw)

    async def probe(host, port, timeout=3.0):
        hits.append(f"probe:{host}")
        raise AssertionError(f"a test probed a real port ({host}:{port})")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(tls_pin, "_read_certificate", read)
        mp.setattr(terraform, "_spawn", spawn)
        mp.setattr(provision, "tcp_open", probe)
        yield hits
    assert not hits, f"a test reached real hosts: {', '.join(hits)}"
```

- [ ] **Step 2: Write the fake provisioner**

Create `sirdar/api/tests/fake_provisioner.py`:

```python
"""A Provisioner for pipeline and API tests: records each VM step and its
context, prints one line, and can fail (StepFailed), raise, wait on a gate,
run an async effect (what the real step leaves behind, such as the VM's
address) and answer an outcome."""

import asyncio

from sirdar_api.deploy import publish
from sirdar_api.deploy.provision import VmOutcome


class FakeProvisioner:
    def __init__(self):
        self.calls: list[str] = []
        self.contexts: list = []
        self.outcomes: dict[str, VmOutcome] = {}
        self.fail: dict[str, str] = {}
        self.raises: dict[str, Exception] = {}
        self.gates: dict[str, asyncio.Event] = {}
        self.effects: dict = {}
        self.echo: dict[str, str] = {}

    async def run(self, step: str, ctx, out) -> VmOutcome:
        self.calls.append(step)
        self.contexts.append(ctx)
        out(self.echo.get(step, f"{step}: ok\n"))
        if step in self.gates:
            await self.gates[step].wait()
        if step in self.effects:
            await self.effects[step](ctx)
        if step in self.raises:
            raise self.raises[step]
        if step in self.fail:
            raise publish.StepFailed(self.fail[step])
        return self.outcomes.get(step, VmOutcome())
```

- [ ] **Step 3: Write the failing tests**

Create `sirdar/api/tests/test_deploy_provision.py`:

```python
import uuid
from datetime import UTC, datetime

import asyncssh
import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Deployment, Integration
from sirdar_api.deploy import gitref, known_hosts, provision, proxmox, terraform, vms
from sirdar_api.deploy.provision import VmOutcome, VmPrepareError
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.terraform import TfResult

from .deploy_factories import secrets_key  # noqa: F401
from .fake_terraform import FakeTerraform
from .integration_helpers import PX_TOKEN, PX_TOKEN_SECRET, configure_proxmox
from .proxmox_helpers import no_sleep, proxmox_fake  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .vm_helpers import apply_creates_vm, destroy_removes_vm, host_key_line, make_vm_environment

SHA = "e73b99ca" + "0" * 32
OLD = "a" * 40
NOW = datetime(2026, 10, 4, 12, 0, 0, tzinfo=UTC)
SNAP = "sirdar-20261004T120000Z"


@pytest.fixture
async def vm_env(db, deploy_env, secrets_key, ssh_server, proxmox_fake, monkeypatch, tmp_path):
    """uat3 on Proxmox; the tests' SSH server plays its VM (127.0.0.1). No
    SSH target is configured (deploy_env blanks them)."""
    monkeypatch.setenv("SIRDAR_TERRAFORM_DIR", str(tmp_path / "terraform"))
    get_settings.cache_clear()
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_proxmox(db)
    yield await make_vm_environment(db)
    get_settings.cache_clear()


@pytest.fixture
def tf(proxmox_fake, ssh_server):
    runner = FakeTerraform()
    runner.effects["apply"] = apply_creates_vm(proxmox_fake, host_key_line(ssh_server))
    runner.effects["destroy"] = destroy_removes_vm(proxmox_fake)
    return runner


async def nothing_answers(host, port):
    return False


def resolves_to(sha: str, calls: list | None = None):
    async def resolve(cfg, db, repo_url, ref):
        if calls is not None:
            calls.append((cfg.host, cfg.user, ref))
        return sha
    return resolve


def provisioner(tf, **kw):
    kw.setdefault("probe", nothing_answers)
    kw.setdefault("resolve", resolves_to(SHA))
    return provision.ProxmoxProvisioner(terraform_runner=tf, settings=get_settings(),
                                        sleep=no_sleep, now=lambda: NOW, poll=1, agent_wait=3,
                                        ssh_wait=3, **kw)


async def ctx_for(db, env, *, mode="update", sha="", take=False, vm_snapshot=None):
    dep = Deployment(id=uuid.uuid4(), environment_id=env.id, mode=mode, git_ref="main",
                     sha=sha, status="running", start_step=0, vm=True,
                     take_vm_snapshot=take, vm_snapshot=vm_snapshot)
    return await provision.prepare(db, env, dep, get_settings())


async def _built(db, vm_env, tf):
    """Run step 0 once: the VM exists, has its address and a pinned key."""
    await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    return await vms.get(db, vm_env.id)


async def test_prepare_needs_the_integration_and_the_vm_record(db, vm_env):
    ctx = await ctx_for(db, vm_env)
    assert (ctx.vm.name, ctx.vm.static_ip, ctx.proxmox.node, ctx.secret_values) == (
        "ss-uat3", "127.0.0.1", "pve", [PX_TOKEN, PX_TOKEN_SECRET])
    assert PX_TOKEN_SECRET not in repr(ctx)
    await db.delete(await db.get(Integration, "proxmox"))
    await db.commit()
    with pytest.raises(VmPrepareError) as e:
        await ctx_for(db, vm_env)
    assert e.value.reason == "Proxmox isn't set up. Add it in Settings › Integrations, then retry."


async def test_the_first_run_builds_the_vm_pins_its_key_and_resolves_the_ref(
        db, vm_env, tf, proxmox_fake, ssh_server):
    lines: list[str] = []
    calls: list = []
    outcome = await provisioner(tf, resolve=resolves_to(SHA, calls)).run(
        "provision", await ctx_for(db, vm_env), lines.append)
    assert outcome == VmOutcome(sha=SHA, vm_snapshot=None)
    assert tf.commands() == ["init", "apply"]
    apply = tf.requests[1]
    assert apply.args == terraform.APPLY and apply.env["PROXMOX_VE_API_TOKEN"] == PX_TOKEN
    assert PX_TOKEN_SECRET not in (apply.workdir / "main.tf.json").read_text()
    vm = await vms.get(db, vm_env.id)
    assert (vm.vmid, vm.created, vm.ip) == (120, True, "127.0.0.1")
    pinned = await known_hosts.lookup(db, "127.0.0.1", ssh_server.port)
    assert pinned.fingerprint_sha256 == ssh_server.fingerprint
    [trust] = await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.host_trust"))
    assert trust["target"] == "proxmox:uat3"
    assert calls == [("127.0.0.1", "deploy", "main")]
    text = "".join(lines)
    for line in ("Reserved VM id 120 for ss-uat3.\n",
                 "Creating ss-uat3 (4 vCPU, 8 GB, 64 GB disk) with Terraform.\n",
                 f"Pinned 127.0.0.1's SSH host key {ssh_server.fingerprint}, read through the "
                 "guest agent.\n",
                 f"main is {SHA}.\n"):
        assert line in text
    assert PX_TOKEN_SECRET not in text


async def test_a_second_run_updates_the_vm_and_keeps_the_pin(db, vm_env, tf, ssh_server):
    await _built(db, vm_env, tf)
    lines: list[str] = []
    outcome = await provisioner(tf).run("provision", await ctx_for(db, vm_env, sha=SHA),
                                        lines.append)
    assert outcome == VmOutcome()                       # a commit given: nothing to resolve
    assert tf.commands() == ["init", "apply", "apply"]
    text = "".join(lines)
    assert "Updating ss-uat3" in text and "Reserved" not in text
    assert f"SSH host key {ssh_server.fingerprint} is pinned.\n" in text


async def test_a_busy_address_stops_before_anything_is_made(db, vm_env, tf, proxmox_fake):
    async def answers(host, port):
        return True

    with pytest.raises(StepFailed) as e:
        await provisioner(tf, probe=answers).run("provision", await ctx_for(db, vm_env),
                                                 lambda _: None)
    assert e.value.reason.startswith("Something already answers SSH at 127.0.0.1")
    assert tf.commands() == [] and ("GET", "/cluster/nextid") not in proxmox_fake.requests
    assert (await vms.get(db, vm_env.id)).vmid is None


async def test_a_reserved_id_someone_else_took(db, vm_env, tf, proxmox_fake):
    vm = await vms.get(db, vm_env.id)
    vm.vmid = 130
    await db.commit()
    proxmox_fake.add_vm(130, "someone-else")
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == "VM 130 is now someone-else, not ss-uat3. Sirdar changed nothing."
    assert tf.commands() == []


async def test_a_failed_apply_keeps_the_reserved_id(db, vm_env, tf):
    tf.results["apply"] = TfResult(status="failed", rc=1)
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == "Terraform couldn't create or update the VM. See the log above."
    vm = await vms.get(db, vm_env.id)
    assert (vm.vmid, vm.created) == (120, False)
    tf.results["apply"] = TfResult(status="timeout", rc=-1)
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == "Terraform didn't create or update the VM in 25 minutes."


async def test_no_address_or_the_wrong_one(db, vm_env, tf, proxmox_fake, ssh_server):
    tf.effects["apply"] = apply_creates_vm(proxmox_fake, host_key_line(ssh_server), ips=())
    slow = provisioner(tf, agent_wait=120, poll=60)
    with pytest.raises(StepFailed) as e:
        await slow.run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("The VM's guest agent didn't report an address in 2 minutes. "
                              "Is qemu-guest-agent installed in the template?")
    proxmox_fake.agent[120]["ips"] = ["10.9.9.9"]
    with pytest.raises(StepFailed) as e:
        await slow.run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("The VM came up at 10.9.9.9, not 127.0.0.1. Check the "
                              "template's cloud-init settings.")


async def test_a_live_key_that_doesn_t_match_the_agent_s(db, vm_env, tf, proxmox_fake):
    other = asyncssh.generate_private_key("ssh-ed25519").export_public_key().decode().strip()
    tf.effects["apply"] = apply_creates_vm(proxmox_fake, other)
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("The VM's live SSH key doesn't match the one its guest agent "
                              "reports. Sirdar pinned nothing.")
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is None


async def test_a_saved_ssh_target_s_address_is_never_pinned(db, vm_env, tf, deploy_env,
                                                           ssh_server):
    deploy_env(ssh_host="127.0.0.1", ssh_port=ssh_server.port, ssh_user="x", ssh_password="y")
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("127.0.0.1 is a saved SSH target's address. Sirdar won't pin a "
                              "VM's key there.")


async def test_a_ref_that_doesn_t_resolve(db, vm_env, tf):
    async def missing(cfg, db, repo_url, ref):
        raise gitref.RefError("ref_not_found")

    with pytest.raises(StepFailed) as e:
        await provisioner(tf, resolve=missing).run("provision", await ctx_for(db, vm_env),
                                                   lambda _: None)
    assert e.value.reason == "The repository has no branch, tag or commit named main."


async def test_a_vm_snapshot_is_taken_and_old_ones_pruned(db, vm_env, tf, proxmox_fake):
    await _built(db, vm_env, tf)
    old = ["sirdar-20261001T080000Z", "sirdar-20261002T080000Z", "sirdar-20261003T080000Z"]
    for name in old:
        db.add(Deployment(environment_id=vm_env.id, mode="update", git_ref="main", sha=OLD,
                          status="succeeded", start_step=0, vm=True, vm_snapshot=name))
        proxmox_fake.snaps.setdefault(120, []).append({"name": name, "description": ""})
    proxmox_fake.snaps[120].append({"name": "manual-before-upgrade", "description": "by hand"})
    await db.commit()
    lines: list[str] = []
    outcome = await provisioner(tf).run(
        "provision", await ctx_for(db, vm_env, sha=SHA, take=True), lines.append)
    assert outcome.vm_snapshot == SNAP
    assert sorted(s["name"] for s in proxmox_fake.snaps[120]) == [
        "manual-before-upgrade", "sirdar-20261002T080000Z", "sirdar-20261003T080000Z", SNAP]
    taken = next(s for s in proxmox_fake.snaps[120] if s["name"] == SNAP)
    assert taken["vmstate"] == 0 and taken["description"].startswith("Sirdar: before update of uat3")
    text = "".join(lines)
    assert f"Took VM snapshot {SNAP}.\n" in text
    assert ("Deleted the old VM snapshot sirdar-20261001T080000Z (keeping the newest 3).\n"
            in text)


async def test_a_retry_keeps_the_first_attempt_s_snapshot(db, vm_env, tf, proxmox_fake):
    await _built(db, vm_env, tf)
    lines: list[str] = []
    outcome = await provisioner(tf).run(
        "provision", await ctx_for(db, vm_env, sha=SHA, take=True, vm_snapshot=SNAP),
        lines.append)
    assert outcome.vm_snapshot == SNAP and proxmox_fake.snaps.get(120, []) == []
    assert f"Keeping the VM snapshot from the first attempt: {SNAP}\n" in "".join(lines)


async def test_restore_a_vm_snapshot(db, vm_env, tf, proxmox_fake):
    await _built(db, vm_env, tf)
    proxmox_fake.snaps[120] = [{"name": SNAP, "description": ""}]
    lines: list[str] = []
    await provisioner(tf).run("vm_restore",
                              await ctx_for(db, vm_env, mode="vm_restore", vm_snapshot=SNAP),
                              lines.append)
    assert proxmox_fake.rolled_back == [(120, SNAP)]
    assert proxmox_fake.vms[120]["status"] == "running"
    text = "".join(lines)
    assert f"Rolling ss-uat3 back to {SNAP}.\n" in text and "Started the VM.\n" in text
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run(
            "vm_restore", await ctx_for(db, vm_env, mode="vm_restore",
                                        vm_snapshot="sirdar-20200101T000000Z"), lambda _: None)
    assert e.value.reason == "The VM snapshot sirdar-20200101T000000Z is gone from Proxmox."


async def test_destroy_removes_only_sirdar_s_vm(db, vm_env, tf, proxmox_fake, ssh_server):
    await _built(db, vm_env, tf)
    work = terraform.workdir(get_settings(), vm_env.id)
    proxmox_fake.vms[120]["name"] = "prod-db"
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert e.value.reason == "VM 120 is prod-db, not the ss-uat3 Sirdar made. Sirdar changed nothing."
    proxmox_fake.vms[120]["name"] = "ss-uat3"
    proxmox_fake.vms[120]["tags"] = "ss-uat3"
    with pytest.raises(StepFailed):
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert "destroy" not in tf.commands() and work.is_dir()
    proxmox_fake.vms[120]["tags"] = "sirdar;ss-uat3"
    lines: list[str] = []
    await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                              lines.append)
    assert tf.commands()[-1] == "destroy" and 120 not in proxmox_fake.vms
    assert not work.exists()
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is None
    text = "".join(lines)
    assert "Destroying ss-uat3 (VM 120) and its VM snapshots with Terraform.\n" in text
    assert "Destroyed ss-uat3.\n" in text


async def test_destroy_without_state_or_a_vm(db, vm_env, tf, proxmox_fake):
    lines: list[str] = []
    await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                              lines.append)
    assert lines == ["Sirdar never created a VM for uat3.\n"]
    await _built(db, vm_env, tf)
    (terraform.workdir(get_settings(), vm_env.id) / "terraform.tfstate").unlink()
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert e.value.reason.startswith("Sirdar's Terraform state for ss-uat3 is missing")
    proxmox_fake.remove_vm(120)
    lines = []
    await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                              lines.append)
    assert "VM 120 (ss-uat3) is already gone.\n" in lines


async def test_destroy_checks_the_vm_is_gone(db, vm_env, tf):
    await _built(db, vm_env, tf)
    del tf.effects["destroy"]
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert e.value.reason == ("VM 120 is still there after Terraform's destroy. Remove it by "
                              "hand in Proxmox, then retry.")


async def test_proxmox_errors_end_as_our_copy(db, vm_env, tf, proxmox_fake):
    proxmox_fake.tls_error = True
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == proxmox.TLS_CHANGED


async def test_the_probe_is_guarded(no_real_hosts):
    with pytest.raises(AssertionError):
        await provision.tcp_open("10.10.48.70", 22)
    assert no_real_hosts == ["probe:10.10.48.70"]
    no_real_hosts.clear()
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_provision.py`
Expected: FAIL — `ImportError: cannot import name 'provision'`.

- [ ] **Step 5: Write `provision.py`**

Create `sirdar/api/src/sirdar_api/deploy/provision.py`:

```python
"""Steps 0 and 15 of a Proxmox environment (phase 5), run in Sirdar like
the publish steps: Prepare VM ("provision"), Restore VM snapshot
("vm_restore") and Destroy VM ("destroy"). Terraform creates, resizes and
destroys the VM (deploy/terraform.py); the Proxmox API (deploy/proxmox.py)
reserves its id, reads its address and SSH host key through the guest
agent, and takes, restores and prunes VM snapshots.

Sirdar manages only the VM its proxmox_vms row names: the id is reserved
and recorded before Terraform runs, and Destroy checks the VM's name and
"sirdar" tag before and its absence after. Every small record (the id,
created, the address, the services' address) is written at once in its own
committed transaction, so a later failure still knows what exists. The
host key comes from the guest agent (over the pinned, authenticated API) and
is then checked against the live SSH server by known_hosts.trust. Failures
raise publish.StepFailed with our own copy."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Protocol

import asyncssh
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, Environment, EnvironmentService, ProxmoxVm
from sirdar_api.deploy import (
    ConnectFailed,
    gitref,
    integrations,
    known_hosts,
    outbound,
    ssh,
    targets,
    terraform,
    vms,
)
from sirdar_api.deploy.integrations import IntegrationError, ProxmoxConfig
from sirdar_api.deploy.proxmox import AgentNotReady, Proxmox, ProxmoxError
from sirdar_api.deploy.publish import StepFailed

Output = Callable[[str], None]
HOST_KEY_FILE = "/etc/ssh/ssh_host_ed25519_key.pub"
AGENT_WAIT_SECONDS = 5 * 60
SSH_WAIT_SECONDS = 5 * 60
POLL_SECONDS = 5
TERRAFORM_DIR_UNWRITABLE = ("Sirdar can't write its Terraform folder (SIRDAR_TERRAFORM_DIR). "
                            "It must be owned by uid 10001 with mode 700.")
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
class VmState:
    """The proxmox_vms row when the run started."""
    vmid: int | None
    name: str
    node: str
    cores: int
    memory_mb: int
    disk_gb: int
    ip_mode: str
    ip_cidr: str | None
    gateway: str | None
    ip: str | None
    ssh_public_key: str
    keep_snapshots: int
    created: bool

    @classmethod
    def of(cls, row: ProxmoxVm) -> "VmState":
        return cls(vmid=row.vmid, name=row.name, node=row.node, cores=row.cores,
                   memory_mb=row.memory_mb, disk_gb=row.disk_gb, ip_mode=row.ip_mode,
                   ip_cidr=row.ip_cidr, gateway=row.gateway, ip=row.ip,
                   ssh_public_key=row.ssh_public_key, keep_snapshots=row.keep_snapshots,
                   created=row.created)

    @property
    def static_ip(self) -> str | None:
        return vms.static_ip(self.ip_cidr)


@dataclass(frozen=True)
class VmContext:
    env_id: uuid.UUID
    env_name: str
    deployment_id: uuid.UUID
    actor_id: uuid.UUID | None
    mode: str
    git_ref: str
    sha: str                       # "" until step 0 resolves git_ref on the VM
    repo_url: str
    take_snapshot: bool
    # The VM snapshot the deployment's chain already took (a retry keeps
    # it), or for vm_restore the one to restore.
    vm_snapshot: str | None
    vm: VmState
    proxmox: ProxmoxConfig = field(repr=False)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        return [self.proxmox.token, self.proxmox.token_secret]


@dataclass(frozen=True)
class VmOutcome:
    sha: str | None = None             # the commit step 0 resolved
    vm_snapshot: str | None = None     # the VM snapshot step 0 took (or kept)


class Provisioner(Protocol):
    async def run(self, step: str, ctx: VmContext, out: Output) -> VmOutcome: ...


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> VmContext:
    try:
        cfg = await integrations.load_proxmox(db, settings)
    except IntegrationError as e:
        raise VmPrepareError(e.reason) from None
    if cfg is None:
        raise VmPrepareError("Proxmox isn't set up. Add it in Settings › Integrations, "
                             "then retry.")
    row = await vms.get(db, env.id)
    if row is None:
        raise VmPrepareError("This environment has no VM record, so Sirdar won't build or "
                             "remove a VM for it.")
    return VmContext(env_id=env.id, env_name=env.name, deployment_id=dep.id,
                     actor_id=dep.actor_id, mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                     repo_url=settings.deploy_repo_url, take_snapshot=dep.take_vm_snapshot,
                     vm_snapshot=dep.vm_snapshot, vm=VmState.of(row), proxmox=cfg)


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


async def _set_vm(env_id: uuid.UUID, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(ProxmoxVm).where(ProxmoxVm.environment_id == env_id)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


async def _point_services(env_id: uuid.UUID, ip: str) -> bool:
    async with get_sessionmaker()() as s:
        result = await s.execute(update(EnvironmentService).where(
            EnvironmentService.environment_id == env_id, EnvironmentService.host_ip != ip)
            .values(host_ip=ip))
        await s.commit()
        return result.rowcount > 0


async def _recorded(env_id: uuid.UUID) -> set[str]:
    """Names of the VM snapshots Sirdar took for this environment."""
    async with get_sessionmaker()() as s:
        return set(await s.scalars(select(Deployment.vm_snapshot).where(
            Deployment.environment_id == env_id, Deployment.vm_snapshot.is_not(None),
            Deployment.mode != "vm_restore")))


class ProxmoxProvisioner:
    """The real provisioner. Waits, the clock, the port probe and the ref
    lookup are injectable for tests."""

    STEPS = ("provision", "vm_restore", "destroy")

    def __init__(self, *, terraform_runner: terraform.TerraformRunner, settings: Settings,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 probe: Callable[[str, int], Awaitable[bool]] | None = None,
                 resolve=None, now: Callable[[], datetime] | None = None,
                 agent_wait: int = AGENT_WAIT_SECONDS, ssh_wait: int = SSH_WAIT_SECONDS,
                 poll: int = POLL_SECONDS):
        self._tf = terraform_runner
        self._settings = settings
        self._sleep = sleep
        self._probe = probe
        self._resolve = resolve or gitref.resolve_ref
        self._now = now or (lambda: datetime.now(UTC))
        self._agent_wait = agent_wait
        self._ssh_wait = ssh_wait
        self._poll = poll

    async def run(self, step: str, ctx: VmContext, out: Output) -> VmOutcome:
        if step not in self.STEPS:
            raise ValueError(f"{step!r} isn't a VM step")
        # The VM lives on the node it was made on, whatever the integration says now.
        cfg = replace(ctx.proxmox, node=ctx.vm.node)
        try:
            async with Proxmox(cfg, transport=outbound.transports()["proxmox"],
                               sleep=self._sleep) as api:
                if step == "provision":
                    return await self._provision(api, ctx, out)
                if step == "vm_restore":
                    await self._restore(api, ctx, out)
                else:
                    await self._destroy(api, ctx, out)
                return VmOutcome()
        except ProxmoxError as e:
            raise StepFailed(e.reason) from None

    # ---- Prepare VM --------------------------------------------------------------

    async def _provision(self, api: Proxmox, ctx: VmContext, out: Output) -> VmOutcome:
        vm = ctx.vm
        vmid = vm.vmid
        if vmid is None:
            probe = self._probe or tcp_open
            if vm.static_ip and await probe(vm.static_ip, vms.VM_SSH_PORT):
                raise StepFailed(f"Something already answers SSH at {vm.static_ip}, so Sirdar "
                                 "won't give that address to a new VM. Free it, or delete this "
                                 "environment and create it with another address.")
            vmid = await api.next_vmid()
            await _set_vm(ctx.env_id, vmid=vmid)
            out(f"Reserved VM id {vmid} for {vm.name}.\n")
        elif not vm.created:
            found = (await api.vms()).get(vmid)
            if found is not None and found["name"] != vm.name:
                raise StepFailed(f"VM {vmid} is now {found['name'] or 'unnamed'}, not "
                                 f"{vm.name}. Sirdar changed nothing.")
        out(f"{'Updating' if vm.created else 'Creating'} {vm.name} ({vm.cores} vCPU, "
            f"{vm.memory_mb // 1024} GB, {vm.disk_gb} GB disk) with Terraform.\n")
        await self._terraform(ctx, vmid, terraform.APPLY, "create or update the VM", out)
        if not vm.created:
            await _set_vm(ctx.env_id, created=True)
        ip = await self._address(api, vmid, vm, out)
        await self._pin(api, ctx, vmid, ip, out)
        if ip != vm.ip:
            await _set_vm(ctx.env_id, ip=ip)
        if await _point_services(ctx.env_id, ip):
            out(f"Every service now points at {ip}.\n")
        sha = None if ctx.sha else await self._resolve_ref(ctx, out)
        return VmOutcome(sha=sha, vm_snapshot=await self._snapshot(api, ctx, vmid, out))

    async def _terraform(self, ctx: VmContext, vmid: int, args: tuple[str, ...], what: str,
                         out: Output) -> None:
        vm, px = ctx.vm, ctx.proxmox
        spec = terraform.VmSpec(
            env_name=ctx.env_name, name=vm.name, vmid=vmid, node=vm.node, pool=px.pool,
            storage=px.storage, bridge=px.bridge, vlan_tag=px.vlan_tag,
            template_vmid=px.template_vmid, cores=vm.cores, memory_mb=vm.memory_mb,
            disk_gb=vm.disk_gb, ip_cidr=vm.ip_cidr, gateway=vm.gateway,
            ssh_public_key=vm.ssh_public_key)
        try:
            work = await asyncio.to_thread(terraform.prepare_workdir, self._settings,
                                           ctx.env_id, terraform.render_config(px.url, spec),
                                           px.tls_cert_pem)
        except terraform.TerraformDirUnwritable:
            raise StepFailed(TERRAFORM_DIR_UNWRITABLE) from None
        env = terraform.run_env(self._settings, work, px.token)
        runs = [(terraform.INIT, "set up Terraform")] if terraform.needs_init(work) else []
        runs.append((args, what))
        for command, doing in runs:
            result = await self._tf.run(terraform.TfRequest(
                args=command, workdir=work, env=env, timeout=terraform.APPLY_TIMEOUT), out)
            if result.status == "timeout":
                raise StepFailed(f"Terraform didn't {doing} in "
                                 f"{terraform.APPLY_TIMEOUT // 60} minutes.")
            if result.status != "successful":
                raise StepFailed(f"Terraform couldn't {doing}. See the log above.")

    async def _address(self, api: Proxmox, vmid: int, vm: VmState, out: Output) -> str:
        out("Waiting for the VM's guest agent to report its address.\n")
        ips: list[str] = []
        for _ in range(max(1, self._agent_wait // self._poll)):
            try:
                ips = await api.agent_ipv4(vmid)
            except AgentNotReady:
                ips = []
            if vm.static_ip and vm.static_ip in ips:
                out(f"The VM answers at {vm.static_ip}.\n")
                return vm.static_ip
            if not vm.static_ip and ips:
                out(f"DHCP gave the VM {ips[0]}.\n")
                return ips[0]
            await self._sleep(self._poll)
        if vm.static_ip and ips:
            raise StepFailed(f"The VM came up at {', '.join(ips)}, not {vm.static_ip}. Check "
                             "the template's cloud-init settings.")
        raise StepFailed(f"The VM's guest agent didn't report an address in "
                         f"{self._agent_wait // 60} minutes. Is qemu-guest-agent installed in "
                         "the template?")

    async def _pin(self, api: Proxmox, ctx: VmContext, vmid: int, ip: str,
                   out: Output) -> None:
        """Read the host key through the guest agent, then pin it with
        known_hosts.trust (which re-reads the live key and refuses a
        mismatch). Never at a saved SSH target's address."""
        port = vms.VM_SSH_PORT
        if any(cfg.host == ip for _, cfg in targets.ssh_configs(self._settings)):
            raise StepFailed(f"{ip} is a saved SSH target's address. Sirdar won't pin a VM's "
                             "key there.")
        tries = max(1, self._ssh_wait // self._poll)
        line = ""
        for _ in range(tries):
            try:
                line = (await api.agent_file(vmid, HOST_KEY_FILE)).strip()
            except AgentNotReady:
                line = ""
            if line:
                break
            await self._sleep(self._poll)
        try:
            expected = known_hosts.fingerprint(asyncssh.import_public_key(line))
        except (asyncssh.KeyImportError, ValueError):
            raise StepFailed("The VM's SSH host key, read through its guest agent, isn't a key "
                             "Sirdar can use.") from None
        mismatch = StepFailed("The VM's live SSH key doesn't match the one its guest agent "
                              "reports. Sirdar pinned nothing.")
        for _ in range(tries):
            async with get_sessionmaker()() as s:
                stored = await known_hosts.lookup(s, ip, port)
                try:
                    if stored is not None and stored.fingerprint_sha256 == expected:
                        await ssh.pinned_host_key(s, ip, port)
                        out(f"SSH host key {expected} is pinned.\n")
                        return
                    await known_hosts.trust(s, ip, port, expected, ctx.actor_id,
                                            target_id=f"proxmox:{ctx.env_name}")
                    await s.commit()
                    changed = " (it changed)" if stored is not None else ""
                    out(f"Pinned {ip}'s SSH host key {expected}, read through the guest "
                        f"agent{changed}.\n")
                    return
                except (known_hosts.HostKeyChanged, ssh.HostKeyMismatch):
                    raise mismatch from None
                except ConnectFailed:
                    pass                                  # SSH isn't up yet
            await self._sleep(self._poll)
        raise StepFailed(f"The VM didn't answer SSH at {ip} in {self._ssh_wait // 60} minutes.")

    async def _resolve_ref(self, ctx: VmContext, out: Output) -> str:
        async with get_sessionmaker()() as s:
            env = await s.get(Environment, ctx.env_id)
            cfg = await vms.host_config(s, self._settings, env)
            try:
                sha = await self._resolve(cfg, s, ctx.repo_url, ctx.git_ref)
            except gitref.RefError as e:
                reason = _REF_REASONS.get(e.code, _REF_REASONS["ref_lookup_failed"])
                raise StepFailed(reason.format(ref=ctx.git_ref)) from None
            except ConnectFailed as e:
                raise StepFailed(e.reason) from None
            except (ssh.HostKeyUnknown, ssh.HostKeyMismatch):
                raise StepFailed("The VM's SSH host key changed while Sirdar was resolving the "
                                 "ref. Retry from step 0.") from None
        out(f"{ctx.git_ref} is {sha}.\n")
        return sha

    async def _snapshot(self, api: Proxmox, ctx: VmContext, vmid: int,
                        out: Output) -> str | None:
        if ctx.vm_snapshot:
            out(f"Keeping the VM snapshot from the first attempt: {ctx.vm_snapshot}\n")
            return ctx.vm_snapshot
        if not ctx.take_snapshot:
            return None
        name = vms.snapshot_name(self._now())
        await api.take_snapshot(vmid, name, f"Sirdar: before {ctx.mode} of {ctx.env_name} "
                                            f"(deployment {ctx.deployment_id})")
        out(f"Took VM snapshot {name}.\n")
        keep = await _recorded(ctx.env_id) | {name}
        ours = sorted((s["name"] for s in await api.snapshots(vmid) if s.get("name") in keep),
                      reverse=True)
        for old in ours[ctx.vm.keep_snapshots:]:
            await api.delete_snapshot(vmid, old)
            out(f"Deleted the old VM snapshot {old} (keeping the newest "
                f"{ctx.vm.keep_snapshots}).\n")
        return name

    # ---- Restore VM snapshot -------------------------------------------------------

    async def _restore(self, api: Proxmox, ctx: VmContext, out: Output) -> None:
        vm, name = ctx.vm, ctx.vm_snapshot
        if vm.vmid is None or not vm.created:
            raise StepFailed("This environment has no VM yet.")
        if name not in {s.get("name") for s in await api.snapshots(vm.vmid)}:
            raise StepFailed(f"The VM snapshot {name} is gone from Proxmox.")
        out(f"Rolling {vm.name} back to {name}.\n")
        await api.rollback(vm.vmid, name)
        if await api.status(vm.vmid) != "running":
            await api.start(vm.vmid)
            out("Started the VM.\n")
        ip = await self._address(api, vm.vmid, vm, out)
        await self._pin(api, ctx, vm.vmid, ip, out)
        if ip != vm.ip:
            await _set_vm(ctx.env_id, ip=ip)
        if await _point_services(ctx.env_id, ip):
            out(f"Every service now points at {ip}.\n")
        out(f"{vm.name} is back at {name}; Docker starts its containers.\n")

    # ---- Destroy VM ----------------------------------------------------------------

    async def _destroy(self, api: Proxmox, ctx: VmContext, out: Output) -> None:
        vm = ctx.vm
        if vm.vmid is None:
            out(f"Sirdar never created a VM for {ctx.env_name}.\n")
        else:
            found = (await api.vms()).get(vm.vmid)
            if found is None:
                out(f"VM {vm.vmid} ({vm.name}) is already gone.\n")
            else:
                if found["name"] != vm.name or "sirdar" not in found["tags"]:
                    raise StepFailed(f"VM {vm.vmid} is {found['name'] or 'unnamed'}, not the "
                                     f"{vm.name} Sirdar made. Sirdar changed nothing.")
                if not terraform.has_state(terraform.workdir(self._settings, ctx.env_id)):
                    raise StepFailed(f"Sirdar's Terraform state for {vm.name} is missing, so it "
                                     f"won't remove VM {vm.vmid}. Remove the VM by hand in "
                                     "Proxmox, then retry.")
                out(f"Destroying {vm.name} (VM {vm.vmid}) and its VM snapshots with "
                    "Terraform.\n")
                await self._terraform(ctx, vm.vmid, terraform.DESTROY, "destroy the VM", out)
                if (await api.vms()).get(vm.vmid) is not None:
                    raise StepFailed(f"VM {vm.vmid} is still there after Terraform's destroy. "
                                     "Remove it by hand in Proxmox, then retry.")
                out(f"Destroyed {vm.name}.\n")
            if vm.ip:
                async with get_sessionmaker()() as s:
                    if await known_hosts.forget(s, vm.ip, vms.VM_SSH_PORT, ctx.actor_id,
                                                target_id=f"proxmox:{ctx.env_name}"):
                        await s.commit()
                        out(f"Forgot {vm.ip}'s SSH host key.\n")
        await asyncio.to_thread(terraform.remove_workdir, self._settings, ctx.env_id)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_provision.py`
Expected: PASS (18 tests).

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/provision.py tests/fake_provisioner.py tests/conftest.py tests/test_deploy_provision.py && cd ../..
git add sirdar/api/src/sirdar_api/deploy/provision.py sirdar/api/tests/fake_provisioner.py \
  sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_provision.py
git commit -m "feat(sirdar): Prepare VM, Restore VM snapshot and Destroy VM steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The VM steps and plans

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py`
- Modify: `sirdar/api/tests/test_deploy_playbooks.py` (`test_plans`)
- Test: `sirdar/api/tests/test_deploy_vm_steps.py`

**Interfaces:**
- Produces (module `sirdar_api.deploy.steps`): `MODES` gains `"vm_restore"`; `VM_HOST_MODES = ("update", "reset", "restore_dump", "rollback")`; `StepDef.runs` may be `"vm"`; steps `StepDef(0, "provision", "Prepare VM", "", 1800, "vm")`, `StepDef(0, "vm_restore", "Restore VM snapshot", "", 1800, "vm")`, `StepDef(15, "destroy", "Destroy VM", "", 1800, "vm")`; `plan_for(mode, *, restore=False, publish=False, vm=False)` (`vm_restore` needs `vm=True`).

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_vm_steps.py`:

```python
import pytest

from sirdar_api.deploy import steps


def keys(mode, **kw):
    return [s.key for s in steps.plan_for(mode, **kw)]


def test_the_vm_steps():
    by = steps.STEPS_BY_KEY
    assert [(by[k].number, by[k].name, by[k].runs, by[k].playbook)
            for k in ("provision", "vm_restore", "destroy")] == [
        (0, "Prepare VM", "vm", ""), (0, "Restore VM snapshot", "vm", ""),
        (15, "Destroy VM", "vm", "")]
    assert "vm_restore" in steps.MODES
    assert all(s.runs == "ansible" for s in steps.ANSIBLE_STEPS)


def test_a_proxmox_environment_s_host_plans_start_with_prepare_vm():
    for mode in steps.VM_HOST_MODES:
        for restore in ((False, True) if mode in ("update", "reset") else (False,)):
            for publish in (False, True):
                plain = keys(mode, restore=restore, publish=publish)
                assert keys(mode, restore=restore, publish=publish, vm=True) == [
                    "provision", *plain]
                numbers = [s.number for s in steps.plan_for(mode, restore=restore,
                                                             publish=publish, vm=True)]
                assert numbers == sorted(set(numbers)) and numbers[0] == 0


def test_deleting_a_proxmox_environment_destroys_the_vm_first():
    assert keys("teardown", vm=True) == ["destroy", "unproxy", "undns"]
    assert [s.number for s in steps.plan_for("teardown", vm=True)] == [15, 16, 17]
    assert keys("teardown") == ["teardown", "unproxy", "undns"]


def test_restore_vm_snapshot_is_a_plan_of_its_own():
    assert keys("vm_restore", vm=True) == ["vm_restore"]
    with pytest.raises(ValueError):
        steps.plan_for("vm_restore")
    with pytest.raises(ValueError):
        steps.plan_for("vm_restore", vm=True, publish=True)


def test_jobs_that_never_touch_the_vm():
    assert keys("snapshot", vm=True) == keys("snapshot")
    assert keys("publish", vm=True) == keys("publish")
```

In `sirdar/api/tests/test_deploy_playbooks.py`, in `test_plans`, replace:

```python
    assert [s.number for s in steps.STEPS] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12, 13, 14,
                                               15, 16, 17]
```

with:

```python
    assert [s.number for s in steps.STEPS] == [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12,
                                               13, 14, 15, 15, 16, 17]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_vm_steps.py tests/test_deploy_playbooks.py -k "vm or test_plans"`
Expected: FAIL — `KeyError: 'provision'`.

- [ ] **Step 3: Add the steps and the plans**

In `sirdar/api/src/sirdar_api/deploy/steps.py`, replace the end of the module docstring:

```python
publishes; a "publish" deployment is only them. Delete environment
("teardown") runs 15 (stacks and folder on the host, an Ansible playbook),
then 16 and 17 (the proxy hosts and DNS records Sirdar made)."""
```

with:

```python
publishes; a "publish" deployment is only them. Delete environment
("teardown") runs 15 (stacks and folder on the host, an Ansible playbook),
then 16 and 17 (the proxy hosts and DNS records Sirdar made).

A Proxmox environment (vm=True) builds its host first: 0 Prepare VM
(runs="vm", see provision.py) starts its update / reset / restore_dump /
rollback plans; its Delete runs 15 Destroy VM instead of 15 Remove
environment; and only it has "vm_restore", a plan of 0 Restore VM snapshot
alone. Steps with the same number never meet in one plan."""
```

Replace:

```python
MODES = ("update", "reset", "snapshot", "restore_dump", "rollback", "publish", "teardown")
# Modes that change what runs on the host: they publish afterwards when asked.
PUBLISHING_MODES = ("update", "reset", "restore_dump", "rollback")
PUBLISH_KEYS = ("dns", "proxy", "smoke")
```

with:

```python
MODES = ("update", "reset", "snapshot", "restore_dump", "rollback", "publish", "teardown",
         "vm_restore")
# Modes that change what runs on the host: they publish afterwards when asked.
PUBLISHING_MODES = ("update", "reset", "restore_dump", "rollback")
PUBLISH_KEYS = ("dns", "proxy", "smoke")
# A Proxmox environment's modes that start with 0 Prepare VM.
VM_HOST_MODES = ("update", "reset", "restore_dump", "rollback")
```

Replace:

```python
    runs: Literal["ansible", "python"] = "ansible"


STEPS: tuple[StepDef, ...] = (
    StepDef(1, "preflight", "Preflight", "preflight.yml", 5 * 60),
```

with:

```python
    runs: Literal["ansible", "python", "vm"] = "ansible"


STEPS: tuple[StepDef, ...] = (
    StepDef(0, "provision", "Prepare VM", "", 30 * 60, "vm"),
    StepDef(0, "vm_restore", "Restore VM snapshot", "", 30 * 60, "vm"),
    StepDef(1, "preflight", "Preflight", "preflight.yml", 5 * 60),
```

Replace:

```python
    StepDef(15, "teardown", "Remove environment", "teardown.yml", 30 * 60),
```

with:

```python
    StepDef(15, "teardown", "Remove environment", "teardown.yml", 30 * 60),
    StepDef(15, "destroy", "Destroy VM", "", 30 * 60, "vm"),
```

Replace:

```python
    # the host first: nothing is unpublished while the environment still runs
    ("teardown", False): ("teardown", "unproxy", "undns"),
}


def plan_for(mode: str, *, restore: bool = False, publish: bool = False) -> list[StepDef]:
    try:
        keys = _PLANS[(mode, restore)]
    except KeyError:
        raise ValueError(f"no deploy plan for mode {mode!r} (restore={restore})") from None
    if publish:
```

with:

```python
    # the host first: nothing is unpublished while the environment still runs
    ("teardown", False): ("teardown", "unproxy", "undns"),
    ("vm_restore", False): ("vm_restore",),
}


def plan_for(mode: str, *, restore: bool = False, publish: bool = False,
             vm: bool = False) -> list[StepDef]:
    try:
        keys = _PLANS[(mode, restore)]
    except KeyError:
        raise ValueError(f"no deploy plan for mode {mode!r} (restore={restore})") from None
    if mode == "vm_restore" and not vm:
        raise ValueError("only a Proxmox environment restores a VM snapshot")
    if vm and mode in VM_HOST_MODES:
        keys = ("provision", *keys)
    elif vm and mode == "teardown":
        keys = ("destroy", *keys[1:])           # the VM goes, with everything on it
    if publish:
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_vm_steps.py tests/test_deploy_playbooks.py tests/test_deploy_runner.py`
Expected: PASS (the playbook checks still cover exactly the Ansible steps).

- [ ] **Step 5: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/steps.py tests/test_deploy_vm_steps.py tests/test_deploy_playbooks.py && cd ../..
git add sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/tests/test_deploy_vm_steps.py \
  sirdar/api/tests/test_deploy_playbooks.py
git commit -m "feat(sirdar): steps 0 Prepare VM, 0 Restore VM snapshot, 15 Destroy VM and their plans

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: The pipeline runs VM steps and prepares the host after step 0

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py`
- Modify: `sirdar/api/tests/deploy_factories.py` (`fake_provisioner` fixture)
- Test: `sirdar/api/tests/test_deploy_pipeline_vm.py`

**Interfaces:**
- Consumes: `provision.prepare`, `VmPrepareError`, `VmContext`, `Provisioner`, `ProxmoxProvisioner` (Task 7); `terraform.SubprocessTerraform` (Task 5); `vms.host_config` (Task 6); `steps.plan_for(vm=…)` (Task 8).
- Produces (module `sirdar_api.deploy.pipeline`): `make_terraform(settings) -> terraform.TerraformRunner`; `make_provisioner(settings) -> provision.Provisioner` (tests replace it); `plan_of(dep)` passes `vm=dep.vm`; `create_deployment(..., vm: bool = False, take_vm_snapshot: bool = False, vm_snapshot: str | None = None)` — a retry inherits its chain's `vm_snapshot` unless one is given; `vm_restore` deployments set the environment `deploying` and, on success, its `current_sha` / `image_tag` to the deployment's commit. Step 0's outcome sets `dep.sha` (when it resolved one) and `dep.vm_snapshot`. The host (`_prepare` with SSH) is prepared before the first Ansible step that needs it, after step 0. A Proxmox environment's VM without an address stops that step with "This environment's VM has no address yet. Retry from step 0 (Prepare VM)."
- Produces (tests): `deploy_factories.fake_provisioner` fixture (a `FakeProvisioner` behind `pipeline.make_provisioner`).

- [ ] **Step 1: Add the fixture**

In `sirdar/api/tests/deploy_factories.py`, replace:

```python
from .fake_publisher import FakePublisher
from .fake_runner import FakeRunner
```

with:

```python
from .fake_provisioner import FakeProvisioner
from .fake_publisher import FakePublisher
from .fake_runner import FakeRunner
```

and after the `fake_publisher` fixture add:

```python
@pytest.fixture
def fake_provisioner(monkeypatch):
    provisioner = FakeProvisioner()
    monkeypatch.setattr(pipeline, "make_provisioner", lambda settings: provisioner)
    return provisioner
```

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_pipeline_vm.py`:

```python
import base64

import pytest

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, Environment, ProxmoxVm
from sirdar_api.deploy import envfile, pipeline, provision, vms
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.runner import RunResult

from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .integration_helpers import PX_TOKEN_SECRET, configure_proxmox
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import OLD, SHA, UPDATE_KEYS, _load
from .vm_helpers import make_vm_environment

SNAP = "sirdar-20261004T120000Z"


@pytest.fixture
async def vm_env(db, deploy_env, secrets_key, ssh_server, monkeypatch):
    """uat3 on Proxmox, deployed at OLD; the tests' SSH server plays its VM
    (127.0.0.1, key pinned) once something records the VM's address."""
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_proxmox(db)
    env = await make_vm_environment(db, current_sha=OLD)
    await trust_fake(db, ssh_server)
    return env


async def _vm_up(ctx) -> None:
    """What a real step 0 leaves behind: the VM's id and address."""
    await provision._set_vm(ctx.env_id, vmid=120, created=True, ip="127.0.0.1")


async def _start(db, env, mode="update", sha=SHA, **kw):
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=sha,
                                           actor_id=None, vm=True, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_step_0_builds_the_vm_then_the_host_steps_run_on_it(db, vm_env, fake_runner,
                                                                   fake_provisioner, ssh_server):
    fake_provisioner.effects["provision"] = _vm_up
    fake_provisioner.outcomes["provision"] = VmOutcome(sha=SHA, vm_snapshot=SNAP)
    dep_id = await _start(db, vm_env, sha="", take_vm_snapshot=True)
    dep, steps, env = await _load(dep_id)
    assert fake_provisioner.calls == ["provision"] and fake_runner.steps() == UPDATE_KEYS
    assert (steps[0].number, steps[0].key, steps[0].status, steps[0].log) == (
        0, "provision", "succeeded", "provision: ok\n")
    assert (dep.status, dep.sha, dep.vm, dep.take_vm_snapshot, dep.vm_snapshot) == (
        "succeeded", SHA, True, True, SNAP)
    assert (env.status, env.current_sha, env.image_tag) == ("ready", SHA, envfile.image_tag(SHA))
    ctx = fake_provisioner.contexts[0]
    assert (ctx.env_name, ctx.sha, ctx.take_snapshot, ctx.vm_snapshot, ctx.vm.static_ip) == (
        "uat3", "", True, None, "127.0.0.1")
    target = fake_runner.requests[0].target
    assert (target.host, target.port, target.user, target.password, target.become_password) == (
        "127.0.0.1", ssh_server.port, "deploy", None, None)
    assert target.private_key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    render = next(r for r in fake_runner.requests if r.step == "render")
    env_file = base64.b64decode(render.extravars["env_file_b64"]).decode()
    assert f"STACK_IMAGE_TAG={envfile.image_tag(SHA)}\n" in env_file   # step 0's commit


async def test_a_vm_without_an_address_stops_at_step_1(db, vm_env, fake_runner,
                                                        fake_provisioner):
    dep_id = await _start(db, vm_env)
    dep, steps, env = await _load(dep_id)
    assert fake_runner.steps() == []
    assert (dep.status, dep.failed_step, env.status) == ("failed", 1, "failed")
    assert steps[0].status == "succeeded"
    assert steps[1].log == ("This environment's VM has no address yet. Retry from step 0 "
                            "(Prepare VM).\n")


async def test_a_failed_step_0_runs_nothing_on_the_host(db, vm_env, fake_runner,
                                                        fake_provisioner):
    fake_provisioner.fail["provision"] = "Terraform couldn't create or update the VM."
    dep_id = await _start(db, vm_env)
    dep, steps, env = await _load(dep_id)
    assert fake_runner.steps() == []
    assert (dep.status, dep.failed_step, dep.error, env.status) == (
        "failed", 0, "Step 0 (Prepare VM) failed. See its log.", "failed")
    assert steps[0].log == "provision: ok\nTerraform couldn't create or update the VM.\n"
    assert {s.status for s in steps[1:]} == {"not_run"}


async def test_a_missing_integration_stops_step_0(db, vm_env, fake_runner, fake_provisioner):
    from sirdar_api.db.models import Integration
    await db.delete(await db.get(Integration, "proxmox"))
    await db.commit()
    dep_id = await _start(db, vm_env)
    dep, steps, _ = await _load(dep_id)
    assert fake_provisioner.calls == [] and dep.failed_step == 0
    assert steps[0].log == "Proxmox isn't set up. Add it in Settings › Integrations, then retry.\n"


async def test_restore_a_vm_snapshot(db, vm_env, fake_runner, fake_provisioner):
    vm_env.current_sha = SHA
    await db.commit()
    dep_id = await _start(db, vm_env, mode="vm_restore", sha=OLD, vm_snapshot=SNAP)
    dep, steps, env = await _load(dep_id)
    assert [s.key for s in steps] == ["vm_restore"] and fake_runner.steps() == []
    assert fake_provisioner.contexts[0].vm_snapshot == SNAP
    assert (dep.status, env.status, env.current_sha) == ("succeeded", "ready", OLD)


async def test_delete_destroys_the_vm_then_the_environment(db, vm_env, fake_runner,
                                                           fake_provisioner, fake_publisher):
    dep_id = await _start(db, vm_env, mode="teardown", sha="")
    assert fake_provisioner.calls == ["destroy"]
    assert fake_publisher.calls == ["unproxy", "undns"] and fake_runner.steps() == []
    async with get_sessionmaker()() as s:
        assert await s.get(Environment, vm_env.id) is None
        assert await s.get(ProxmoxVm, vm_env.id) is None
        assert await s.get(Deployment, dep_id) is None          # gone with the environment


async def test_a_retry_keeps_the_first_attempt_s_vm_snapshot(db, vm_env, fake_runner,
                                                             fake_provisioner):
    fake_provisioner.effects["provision"] = _vm_up
    fake_provisioner.outcomes["provision"] = VmOutcome(vm_snapshot=SNAP)
    fake_runner.results["build"] = RunResult(status="failed", rc=2)
    first = await _start(db, vm_env, take_vm_snapshot=True)
    fake_runner.results.clear()
    fake_provisioner.outcomes["provision"] = VmOutcome()
    await db.refresh(vm_env)
    second = await _start(db, vm_env, retry_of=first, start_step=0, take_vm_snapshot=True)
    dep, steps, env = await _load(second)
    assert fake_provisioner.contexts[1].vm_snapshot == SNAP
    assert (dep.status, dep.vm_snapshot, env.current_sha) == ("succeeded", SNAP, SHA)


async def test_step_0_s_log_is_redacted(db, vm_env, fake_runner, fake_provisioner):
    fake_provisioner.echo["provision"] = f"token {PX_TOKEN_SECRET}\n"
    fake_provisioner.fail["provision"] = "stop"
    dep_id = await _start(db, vm_env)
    _, steps, _ = await _load(dep_id)
    assert steps[0].log == "token [redacted]\nstop\n"


async def test_vm_restore_needs_a_vm_plan(db, vm_env):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, vm_env, mode="vm_restore", git_ref=OLD, sha=OLD,
                                         actor_id=None)
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_pipeline_vm.py`
Expected: FAIL — `TypeError: create_deployment() got an unexpected keyword argument 'vm'`.

- [ ] **Step 4: Teach the pipeline the VM steps**

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`:

Replace the first paragraph of the module docstring's end:

```python
hosts, smoke test), which run in Sirdar through a Publisher instead of a
playbook; a publish job is only those. Delete environment (teardown) runs
15–17 and, when they succeed, deletes the environment's row.
```

with:

```python
hosts, smoke test), which run in Sirdar through a Publisher instead of a
playbook; a publish job is only those. Delete environment (teardown) runs
15–17 and, when they succeed, deletes the environment's row. A Proxmox
environment's deployment (vm) adds the VM steps, run by a Provisioner: 0
Prepare VM before the host steps (the SSH host is prepared after it, once
the VM has an address), 0 Restore VM snapshot alone, and 15 Destroy VM.
```

Replace:

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

with:

```python
from sirdar_api.deploy import (
    ConnectFailed,
    envfile,
    known_hosts,
    provision,
    publish,
    snapshots,
    ssh,
    targets,
    terraform,
    vault,
    vms,
)
```

Replace:

```python
def make_publisher(settings: Settings) -> publish.Publisher:
    """What runs steps 12–14 and 16–17 (tests replace this function)."""
    return publish.HttpPublisher()
```

with:

```python
def make_publisher(settings: Settings) -> publish.Publisher:
    """What runs steps 12–14 and 16–17 (tests replace this function)."""
    return publish.HttpPublisher()


def make_terraform(settings: Settings) -> terraform.TerraformRunner:
    return terraform.SubprocessTerraform(settings.terraform_binary)


def make_provisioner(settings: Settings) -> provision.Provisioner:
    """What runs a Proxmox environment's VM steps (tests replace this function)."""
    return provision.ProxmoxProvisioner(terraform_runner=make_terraform(settings),
                                        settings=settings)
```

Replace:

```python
def plan_of(dep: Deployment) -> list[StepDef]:
    return plan_for(dep.mode, restore=restores(dep.mode, dep.snapshot_id), publish=dep.publish)
```

with:

```python
def plan_of(dep: Deployment) -> list[StepDef]:
    return plan_for(dep.mode, restore=restores(dep.mode, dep.snapshot_id), publish=dep.publish,
                    vm=dep.vm)
```

In `create_deployment`, replace the signature and the first lines:

```python
                            restore_dump: str | None = None,
                            publish: bool = False) -> Deployment:
```

with:

```python
                            restore_dump: str | None = None,
                            publish: bool = False, vm: bool = False,
                            take_vm_snapshot: bool = False,
                            vm_snapshot: str | None = None) -> Deployment:
```

replace:

```python
    plan = plan_for(mode, restore=restores(mode, snapshot_id), publish=publish)
```

with:

```python
    plan = plan_for(mode, restore=restores(mode, snapshot_id), publish=publish, vm=vm)
```

replace:

```python
        parent = await db.get(Deployment, retry_of)
        if parent is not None:
            previous_sha, dump_path = parent.previous_sha, parent.dump_path
```

with:

```python
        parent = await db.get(Deployment, retry_of)
        if parent is not None:
            previous_sha, dump_path = parent.previous_sha, parent.dump_path
            # ...and its VM snapshot from before anything changed (step 0 keeps it).
            if vm_snapshot is None:
                vm_snapshot = parent.vm_snapshot
```

and replace:

```python
                     snapshot_id=snapshot_id, restore_dump=restore_dump,
                     dump_path=dump_path, publish=publish)
```

with:

```python
                     snapshot_id=snapshot_id, restore_dump=restore_dump,
                     dump_path=dump_path, publish=publish, vm=vm,
                     take_vm_snapshot=take_vm_snapshot, vm_snapshot=vm_snapshot)
```

In the `_Context` dataclass, replace:

```python
    # Steps 12–14 and 16–17: credentials and the public services.
    publishing: publish.PublishContext | None = field(default=None, repr=False)
```

with:

```python
    # Steps 12–14 and 16–17: credentials and the public services.
    publishing: publish.PublishContext | None = field(default=None, repr=False)
    # Steps 0 and 15 of a Proxmox environment: its VM and the Proxmox token.
    vm: provision.VmContext | None = field(default=None, repr=False)
```

In `_prepare`, replace:

```python
    cfg = targets.ssh_config_for(env.target_id, settings)
    if cfg is None:
        raise PrepareError("This environment's SSH target isn't configured any more. "
                           "Pick another target, then retry.")
```

with:

```python
    try:
        cfg = await vms.host_config(db, settings, env)
    except (vault.SecretsKeyMissing, vault.SecretUnreadable):
        raise PrepareError("Sirdar can't read its key for this environment's VM with the "
                           "current SIRDAR_SECRETS_KEY.") from None
    if cfg is None and env.target_id == targets.PROXMOX_TARGET:
        raise PrepareError("This environment's VM has no address yet. Retry from step 0 "
                           "(Prepare VM).")
    if cfg is None:
        raise PrepareError("This environment's SSH target isn't configured any more. "
                           "Pick another target, then retry.")
```

After `_run_python_step`, add:

```python
async def _run_vm_step(provisioner: provision.Provisioner, ctx: _Context,
                       step: DeploymentStep) -> RunResult:
    """Step 0 or 15 of a Proxmox environment, in Sirdar: a publish step's log
    handling, plus what step 0 found out (the resolved commit, the VM
    snapshot) in the result's data."""
    definition = STEPS_BY_KEY[step.key]
    buffer = _LogBuffer(ctx.redactor)
    flusher = asyncio.create_task(_flush_loop(step.id, buffer))
    try:
        outcome = await asyncio.wait_for(provisioner.run(step.key, ctx.vm, buffer.append),
                                         definition.timeout)
        return RunResult(status="successful", rc=0,
                         data={"sha": outcome.sha, "vm_snapshot": outcome.vm_snapshot})
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
```

In `_run`, replace this block:

```python
                runs = {STEPS_BY_KEY[s.key].runs for s in todo}
                try:
                    publishing = (await publish.prepare(db, env, settings)
                                  if "python" in runs else None)
                    ctx = await _prepare(
                        db, env, dep, settings, needs_host="ansible" in runs,
                        more_secrets=tuple(publishing.secret_values) if publishing else ())
                except (PrepareError, publish.PublishError) as e:
                    await db.rollback()
                    await _close(deployment_id, env_id, current, step_status="failed",
                                 dep_status="failed", error=e.reason, failed_step=current,
                                 append_log=e.reason + "\n")
                    return
                # End _prepare's read transaction: step 1 must not hold a
                # connection idle in a transaction for its whole timeout.
                ctx = replace(ctx, publishing=publishing)
                await db.commit()
                runner = make_runner(settings)
                publisher = make_publisher(settings)
                for step in todo:
                    current = step.number
                    if step.status != "running":
                        await _mark_running(db, step)
                    if step.key == "dump" and dep.dump_path:
```

with:

```python
                runs = {STEPS_BY_KEY[s.key].runs for s in todo}
                try:
                    publishing = (await publish.prepare(db, env, settings)
                                  if "python" in runs else None)
                    vm_ctx = (await provision.prepare(db, env, dep, settings)
                              if "vm" in runs else None)
                    more = (*(publishing.secret_values if publishing else ()),
                            *(vm_ctx.secret_values if vm_ctx else ()))
                    # Step 0 first: the SSH host is prepared once the VM is up.
                    host_now = "ansible" in runs and STEPS_BY_KEY[todo[0].key].runs != "vm"
                    ctx = await _prepare(db, env, dep, settings, needs_host=host_now,
                                         more_secrets=more)
                except (PrepareError, publish.PublishError, provision.VmPrepareError) as e:
                    await db.rollback()
                    await _close(deployment_id, env_id, current, step_status="failed",
                                 dep_status="failed", error=e.reason, failed_step=current,
                                 append_log=e.reason + "\n")
                    return
                # End _prepare's read transaction: step 1 must not hold a
                # connection idle in a transaction for its whole timeout.
                ctx = replace(ctx, publishing=publishing, vm=vm_ctx)
                await db.commit()
                runner = make_runner(settings)
                publisher = make_publisher(settings)
                provisioner = make_provisioner(settings) if vm_ctx is not None else None
                for step in todo:
                    current = step.number
                    if step.status != "running":
                        await _mark_running(db, step)
                    runs_on = STEPS_BY_KEY[step.key].runs
                    if runs_on == "ansible" and ctx.target is None:
                        try:
                            host = await _prepare(db, env, dep, settings, more_secrets=more)
                        except PrepareError as e:
                            await db.rollback()
                            await _close(deployment_id, env_id, current, step_status="failed",
                                         dep_status="failed", error=e.reason,
                                         failed_step=current, append_log=e.reason + "\n")
                            return
                        ctx = replace(host, publishing=ctx.publishing, vm=ctx.vm)
                        await db.commit()
                    if step.key == "dump" and dep.dump_path:
```

In the same loop, replace:

```python
                    if STEPS_BY_KEY[step.key].runs == "python":
                        result = await _run_python_step(publisher, ctx, step)
                    else:
                        result = await _run_step(runner, ctx, step)
```

with:

```python
                    if runs_on == "python":
                        result = await _run_python_step(publisher, ctx, step)
                    elif runs_on == "vm":
                        result = await _run_vm_step(provisioner, ctx, step)
                    else:
                        result = await _run_step(runner, ctx, step)
```

and replace:

```python
                    step.status, step.finished_at = "succeeded", _now()
                    if step.key == "dump":
```

with:

```python
                    step.status, step.finished_at = "succeeded", _now()
                    if step.key == "provision":
                        # The commit step 0 resolved on the VM, and its VM snapshot.
                        if result.data.get("sha"):
                            dep.sha = result.data["sha"]
                        if result.data.get("vm_snapshot"):
                            dep.vm_snapshot = result.data["vm_snapshot"]
                    elif step.key == "dump":
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_pipeline_vm.py tests/test_deploy_pipeline.py tests/test_deploy_pipeline_publish.py tests/test_deploy_pipeline_snapshots.py`
Expected: PASS (SSH environments run exactly as before).

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/pipeline.py tests/deploy_factories.py tests/test_deploy_pipeline_vm.py && cd ../..
git add sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/tests/deploy_factories.py \
  sirdar/api/tests/test_deploy_pipeline_vm.py
git commit -m "feat(sirdar): the pipeline runs VM steps and prepares the SSH host after step 0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Routes and shapes — Proxmox environments, VM deploys, Restore VM snapshot, the VM snapshot list

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py`
- Test: `sirdar/api/tests/test_deploy_vm_api.py`

**Interfaces:**
- Consumes: everything above.
- Produces: the shapes and errors under "API produced for 5b" (environments, deployments, retry, rollback, `GET /environments/{name}/vm-snapshots`, `GET /targets`, `GET /environment-defaults`). New error codes: `vm_not_ready` (409, a data snapshot of a VM that isn't built), `vm_key_unreadable` (409).

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_vm_api.py`:

```python
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog, Deployment, DeploymentStep, Environment, Integration
from sirdar_api.deploy import proxmox, vms

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
from .integration_helpers import PX_TOKEN_SECRET, configure_proxmox
from .proxmox_helpers import proxmox_fake  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_deployments_api import OLD, SHA, UPDATE_KEYS, _finish, _headers_without_change

URL = "/api/deploy/environments"
UAT3 = f"{URL}/uat3"
SNAP = "sirdar-20261004T120000Z"
VM_BODY = {"mode": "new", "name": "uat3", "type": "dev", "target": "proxmox",
           "proxy_ip": "10.10.48.6", "publish": False,
           "vm": {"ip_mode": "static", "ip_cidr": "10.10.48.70/24", "gateway": "10.10.48.1",
                  "cores": 2}}


@pytest.fixture
async def px(db, deploy_env, secrets_key, proxmox_fake, leak_guard):
    await configure_proxmox(db)
    leak_guard.append(PX_TOKEN_SECRET)
    return proxmox_fake


async def _uat3(client, h, *, current_sha=None, db=None):
    """uat3 through the API; with current_sha, as if deployed at that commit."""
    resp = await client.post(URL, headers=h, json=VM_BODY)
    assert resp.status_code == 201, resp.text
    if current_sha:
        row = await db.get(Environment, uuid.UUID(resp.json()["id"]))
        row.current_sha, row.image_tag, row.status = current_sha, current_sha[:8], "ready"
        await db.commit()
    return resp.json()


async def _taken(db, env_id, name=SNAP, previous=OLD) -> Deployment:
    dep = Deployment(environment_id=env_id, mode="update", git_ref="main", sha=SHA,
                     status="failed", start_step=0, vm=True, take_vm_snapshot=True,
                     vm_snapshot=name, previous_sha=previous)
    db.add(dep)
    await db.commit()
    return dep


async def test_create_a_proxmox_environment(client, db, px):
    h = await auth_headers(client, db)
    body = await _uat3(client, h)
    assert (body["target"], body["target_kind"]) == ("proxmox", "proxmox")
    assert body["vm"] == {"name": "ss-uat3", "node": "pve", "vmid": None, "cores": 2,
                          "memory_mb": 8192, "disk_gb": 64, "ip_mode": "static",
                          "ip_cidr": "10.10.48.70/24", "gateway": "10.10.48.1", "ip": None,
                          "keep_snapshots": 3, "created": False}
    assert {s["host_ip"] for s in body["services"]} == {"10.10.48.70"}
    [audit] = await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))
    assert audit["vm"] == VM_BODY["vm"]
    targets = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
    assert targets[-1]["id"] == "proxmox"
    defaults = (await client.get("/api/deploy/environment-defaults", headers=h)).json()
    assert defaults["vm"] == {"cores": 4, "memory_mb": 8192, "disk_gb": 64, "keep_snapshots": 3,
                              "limits": {"cores": [1, 64], "memory_mb": [2048, 262144],
                                         "disk_gb": [20, 4096], "keep_snapshots": [1, 10]}}


async def test_create_errors(client, db, deploy_env, secrets_key, proxmox_fake):
    deploy_env(ssh_host="10.10.48.63", ssh_user="jrh", ssh_password="pw")
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json=VM_BODY)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["proxmox"]})
    await configure_proxmox(db)
    for change, status, code in (
            ({"vm": {**VM_BODY["vm"], "ip_cidr": "10.10.48.63/24"}}, 409, "ip_in_use"),
            ({"vm": {**VM_BODY["vm"], "ip_cidr": "10.10.48.70"}}, 422, "vm_ip_invalid"),
            ({"vm": {"ip_mode": "dhcp", "disk_gb": 10}}, 422, "vm_disk_invalid"),
            ({"target": "ssh"}, 422, "vm_not_allowed"),
            ({"mode": "adopt", "vm": None}, 422, "adopt_not_allowed"),
            ({"mode": "adopt", "target": "ssh"}, 422, "vm_not_allowed")):
        resp = await client.post(URL, headers=h, json={**VM_BODY, **change})
        assert (resp.status_code, resp.json()["detail"]["code"]) == (status, code), change


async def test_patch_the_vm(client, db, px):
    h = await auth_headers(client, db)
    await _uat3(client, h)
    resp = await client.patch(UAT3, headers=h, json={"vm": {"cores": 4, "disk_gb": 128,
                                                            "keep_snapshots": 5}})
    assert resp.status_code == 200, resp.text
    vm = resp.json()["vm"]
    assert (vm["cores"], vm["disk_gb"], vm["keep_snapshots"]) == (4, 128, 5)
    for patch, code in (({"vm": {"disk_gb": 64}}, "vm_disk_shrink"),
                        ({"services": {"api": {"host_ip": "10.10.48.71"}}}, "host_ip_managed"),
                        ({"target": "ssh"}, "target_kind_locked")):
        resp = await client.patch(UAT3, headers=h, json=patch)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code), patch


async def test_deploy_a_proxmox_environment(client, db, px, fake_runner, fake_provisioner):
    h = await auth_headers(client, db)
    await _uat3(client, h)
    fake_provisioner.fail["provision"] = "stopped here"           # never reaches SSH
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["sha"], body["git_ref"], body["vm"], body["take_vm_snapshot"]) == (
        "", "main", True, False)                                   # never deployed: no snapshot
    assert [s["key"] for s in body["steps"]] == ["provision", *UPDATE_KEYS]
    assert body["steps"][0]["number"] == 0 and body["start_step"] == 0
    await _finish(body)
    retry = await client.post(f"/api/deploy/deployments/{body['id']}/retry", headers=h,
                              json={"from_step": 0})
    assert retry.status_code == 201, retry.text
    assert (retry.json()["start_step"], retry.json()["steps"][0]["status"]) == (0, "pending")
    await _finish(retry.json())
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={"git_ref": SHA.upper()})
    assert resp.json()["sha"] == SHA
    await _finish(resp.json())


async def test_a_deployed_vm_takes_a_snapshot_unless_told_not_to(client, db, px, fake_runner,
                                                                  fake_provisioner):
    h = await auth_headers(client, db)
    await _uat3(client, h, current_sha=OLD, db=db)
    fake_provisioner.fail["provision"] = "stopped here"
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert resp.json()["take_vm_snapshot"] is True
    await _finish(resp.json())
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={"take_vm_snapshot": False})
    assert resp.json()["take_vm_snapshot"] is False
    await _finish(resp.json())
    await make_environment(db, name="uat")
    resp = await client.post(f"{URL}/uat/deployments", headers=h,
                             json={"take_vm_snapshot": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "vm_snapshot_not_allowed")
    await db.delete(await db.get(Integration, "proxmox"))
    await db.commit()
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["proxmox"]})


async def test_restore_a_vm_snapshot(client, db, px, fake_runner, fake_provisioner):
    h = await auth_headers(client, db)
    created = await _uat3(client, h, current_sha=SHA, db=db)
    env_id = uuid.UUID(created["id"])
    await _taken(db, env_id)
    start = f"{UAT3}/deployments"
    good = {"mode": "vm_restore", "vm_snapshot": SNAP, "confirm_name": "uat3"}
    adder = await _headers_without_change(client, db)
    assert (await client.post(start, headers=adder, json=good)).status_code == 403
    for body, status, code in (
            ({**good, "confirm_name": "uat"}, 422, "confirm_name_mismatch"),
            ({**good, "vm_snapshot": "manual-1"}, 422, "vm_snapshot_invalid"),
            ({**good, "vm_snapshot": "sirdar-20200101T000000Z"}, 404, "vm_snapshot_not_found"),
            ({"mode": "update", "vm_snapshot": SNAP}, 422, "vm_snapshot_invalid"),
            ({**good, "git_ref": "main"}, 422, "git_ref_not_allowed")):
        resp = await client.post(start, headers=h, json=body)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (status, code), body
    resp = await client.post(start, headers=h, json=good)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["sha"], body["vm_snapshot"], body["start_step"]) == (
        "vm_restore", OLD, SNAP, 0)
    assert [(s["number"], s["key"]) for s in body["steps"]] == [(0, "vm_restore")]
    await _finish(body)
    env = (await client.get(UAT3, headers=h)).json()
    assert (env["current_sha"], env["status"]) == (OLD, "ready")
    # a snapshot restore after the VM snapshot changed the sign-in keys
    restoring = Deployment(environment_id=env_id, mode="reset", git_ref="main", sha=SHA,
                           status="succeeded", start_step=1)
    db.add(restoring)
    await db.flush()
    db.add(DeploymentStep(deployment_id=restoring.id, number=9, key="restore",
                          name="Restore snapshot", status="succeeded",
                          finished_at=vms.snapshot_taken_at(SNAP) + timedelta(hours=1)))
    await db.commit()
    resp = await client.post(start, headers=h, json=good)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "vm_snapshot_keys_changed")
    await make_environment(db, name="uat")
    resp = await client.post(f"{URL}/uat/deployments", headers=h,
                             json={**good, "confirm_name": "uat"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_proxmox")


async def test_the_vm_snapshot_list(client, db, px):
    h = await auth_headers(client, db)
    created = await _uat3(client, h, current_sha=SHA, db=db)
    env_id = uuid.UUID(created["id"])
    assert (await client.get(f"{UAT3}/vm-snapshots", headers=h)).json() == {"snapshots": []}
    vm = await vms.get(db, env_id)
    vm.vmid, vm.created = 120, True
    await db.commit()
    taking = await _taken(db, env_id)
    await _taken(db, env_id, name="sirdar-20261003T080000Z")       # recorded, but gone
    px.add_vm(120, "ss-uat3")
    px.snaps[120] = [{"name": SNAP, "description": "Sirdar: before update"},
                     {"name": "manual-before-upgrade", "description": "by hand"}]
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"snapshots": [{
        "name": SNAP, "taken_at": "2026-10-04T12:00:00Z", "sha": OLD,
        "deployment_id": str(taking.id), "description": "Sirdar: before update",
        "restorable": True, "reason": None}]}
    px.tls_error = True
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": proxmox.TLS_CHANGED})
    await make_environment(db, name="uat")
    resp = await client.get(f"{URL}/uat/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_proxmox")


async def test_delete_a_proxmox_environment(client, db, px, fake_runner, fake_provisioner,
                                            fake_publisher):
    h = await auth_headers(client, db)
    await _uat3(client, h)
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "uat3"})
    assert resp.status_code == 201, resp.text
    assert [(s["number"], s["key"]) for s in resp.json()["steps"]] == [
        (15, "destroy"), (16, "unproxy"), (17, "undns")]
    await _finish(resp.json())
    assert fake_provisioner.calls == ["destroy"]
    assert (await client.get(UAT3, headers=h)).status_code == 404


async def test_a_vm_without_an_address_has_no_backups_or_data_snapshots(client, db, px):
    h = await auth_headers(client, db)
    await _uat3(client, h, current_sha=SHA, db=db)
    assert (await client.get(f"{UAT3}/backups", headers=h)).json() == {"backups": []}
    resp = await client.post(f"{UAT3}/snapshots", headers=h, json={"name": "uat3-now"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "vm_not_ready")
```

The API tests never let a VM deployment reach SSH: the fake provisioner fails step 0 (or the VM has no address), so no test dials 10.10.48.70.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_vm_api.py`
Expected: FAIL — `POST /api/deploy/environments` answers 422 (the target pattern has no `proxmox`).

- [ ] **Step 3: The shapes**

In `sirdar/api/src/sirdar_api/deploy/serialize.py`, replace:

```python
from sirdar_api.deploy import envfile, snapshots
```

with:

```python
from sirdar_api.deploy import envfile, snapshots, targets, vms
```

In `deployment_summary`, replace:

```python
            "publish": dep.publish,
            "previous_sha": dep.previous_sha, "error": dep.error,
```

with:

```python
            "publish": dep.publish,
            "vm": dep.vm, "take_vm_snapshot": dep.take_vm_snapshot,
            "vm_snapshot": dep.vm_snapshot,
            "previous_sha": dep.previous_sha, "error": dep.error,
```

In `environment_out`, replace:

```python
    last = await latest_deployment(db, env.id)
    return {
        "id": str(env.id), "name": env.name, "type": env.type, "target": env.target_id,
```

with:

```python
    last = await latest_deployment(db, env.id)
    on_vm = env.target_id == targets.PROXMOX_TARGET
    vm = await vms.get(db, env.id) if on_vm else None
    return {
        "id": str(env.id), "name": env.name, "type": env.type, "target": env.target_id,
        "target_kind": "proxmox" if on_vm else "ssh",
        "vm": vms.public(vm) if vm is not None else None,
```

- [ ] **Step 4: The routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

Replace the deploy import block:

```python
from sirdar_api.deploy import (
    ConnectFailed,
    digitalocean,
    envfile,
    environments,
    gitref,
    known_hosts,
    names,
    pipeline,
    publish,
    serialize,
    snapshots,
    ssh,
    targets,
    vault,
)
```

with:

```python
from sirdar_api.deploy import (
    ConnectFailed,
    digitalocean,
    envfile,
    environments,
    gitref,
    integrations,
    known_hosts,
    names,
    outbound,
    pipeline,
    proxmox,
    publish,
    serialize,
    snapshots,
    ssh,
    targets,
    vault,
    vms,
)
```

Replace `list_targets`:

```python
@router.get("/targets")
async def list_targets(actor: AuthContext = require_permission("deploy", "view")):
    s = get_settings()
    writable = targets.can_add_ssh(s)
    return {"targets": targets.public_targets(s), "types": targets.DEPLOY_TYPES,
            "can_add_ssh": writable, "ssh_store_hint": None if writable else targets.STORE_HINT}
```

with:

```python
@router.get("/targets")
async def list_targets(db: DbSession, actor: AuthContext = require_permission("deploy", "view")):
    s = get_settings()
    writable = targets.can_add_ssh(s)
    listed = targets.public_targets(
        s, proxmox_configured=await integrations.is_configured(db, "proxmox"))
    return {"targets": listed, "types": targets.DEPLOY_TYPES,
            "can_add_ssh": writable, "ssh_store_hint": None if writable else targets.STORE_HINT}
```

Replace:

```python
SSH_TARGET_PATTERN = r"^(ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*)$"
EnvType = Literal["dev", "beta", "custom"]
_SSH_ERRORS = (ssh.HostKeyUnknown, ssh.HostKeyMismatch, ConnectFailed)
_ENV_STATUS = {"environment_exists": 409, "deploy_in_progress": 409,
               "secrets_key_missing": 400, "target_not_configured": 400,
               "snapshot_not_found": 404, "snapshot_not_ready": 409}
```

with:

```python
# An environment's target: an SSH target, or "proxmox" (a VM Sirdar builds).
ENV_TARGET_PATTERN = r"^(ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*|proxmox)$"
EnvType = Literal["dev", "beta", "custom"]
_SSH_ERRORS = (ssh.HostKeyUnknown, ssh.HostKeyMismatch, ConnectFailed)
_ENV_STATUS = {"environment_exists": 409, "deploy_in_progress": 409,
               "secrets_key_missing": 400, "target_not_configured": 400,
               "snapshot_not_found": 404, "snapshot_not_ready": 409,
               "integration_not_configured": 409, "ip_in_use": 409}


class VmIn(BaseModel):
    """A Proxmox environment's VM (mode "new", target "proxmox")."""
    cores: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None
    ip_mode: str = Field(max_length=10)
    ip_cidr: str | None = Field(default=None, max_length=50)
    gateway: str | None = Field(default=None, max_length=45)


class VmPatch(BaseModel):
    cores: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None
    keep_snapshots: int | None = None
```

In `EnvironmentIn`, replace:

```python
    target: str = Field(pattern=SSH_TARGET_PATTERN, max_length=36)
```

with:

```python
    target: str = Field(pattern=ENV_TARGET_PATTERN, max_length=36)
```

and replace:

```python
    # mode "new" only (default on): deploys publish DNS records and proxy hosts
    publish: bool | None = None
```

with:

```python
    # mode "new" only (default on): deploys publish DNS records and proxy hosts
    publish: bool | None = None
    # mode "new" with target "proxmox" only: the VM step 0 builds
    vm: VmIn | None = None
```

In `EnvironmentPatch`, replace:

```python
    target: str | None = Field(default=None, pattern=SSH_TARGET_PATTERN, max_length=36)
```

with:

```python
    target: str | None = Field(default=None, pattern=ENV_TARGET_PATTERN, max_length=36)
```

and replace:

```python
    services: dict[str, ServicePatch] | None = None
    publish: bool | None = None
```

with:

```python
    services: dict[str, ServicePatch] | None = None
    publish: bool | None = None
    vm: VmPatch | None = None
```

In `environment_defaults`, replace:

```python
        "log_levels": list(envfile.LOG_LEVELS),
        "optional_secrets": list(envfile.OPTIONAL_SECRETS),
    }
```

with:

```python
        "log_levels": list(envfile.LOG_LEVELS),
        "optional_secrets": list(envfile.OPTIONAL_SECRETS),
        "vm": {**vms.DEFAULTS, "keep_snapshots": vms.KEEP_SNAPSHOTS,
               "limits": {k: list(v) for k, v in vms.LIMITS.items()}},
    }
```

In `create_environment`, replace:

```python
    if body.mode == "adopt" and body.publish:
```

with:

```python
    if body.mode == "adopt" and body.vm is not None:
        raise HTTPException(status_code=422, detail={"code": "vm_not_allowed"})
    if body.mode == "adopt" and body.publish:
```

replace:

```python
                snapshot_id=body.snapshot_id, publish=body.publish is not False)
```

with:

```python
                snapshot_id=body.snapshot_id, publish=body.publish is not False,
                vm=body.vm.model_dump(exclude_none=True) if body.vm else None)
```

and replace:

```python
        seed = await snapshots.snapshot_ref(db, env.seed_snapshot_id)
        if seed is not None:
            changes["seed_snapshot"] = seed["name"]
```

with:

```python
        seed = await snapshots.snapshot_ref(db, env.seed_snapshot_id)
        if seed is not None:
            changes["seed_snapshot"] = seed["name"]
        if body.vm is not None:
            changes["vm"] = body.vm.model_dump(exclude_none=True)
```

Replace `DeploymentIn`, `RetryIn`, `RollbackIn` and the two mode tuples:

```python
class DeploymentIn(BaseModel):
    # publish: steps 12–14 for the running commit; teardown: Delete environment
    mode: Literal["update", "reset", "restore_dump", "publish", "teardown"] = "update"
```

with:

```python
class DeploymentIn(BaseModel):
    # publish: steps 12–14 for the running commit; teardown: Delete environment;
    # vm_restore: a Proxmox environment's VM back to one of its VM snapshots
    mode: Literal["update", "reset", "restore_dump", "publish", "teardown",
                  "vm_restore"] = "update"
    # Proxmox, update / reset / restore_dump: take a VM snapshot in step 0
    # (default: yes once deployed).
    take_vm_snapshot: bool | None = None
    # vm_restore only: the VM snapshot (a name from GET .../vm-snapshots).
    vm_snapshot: str | None = Field(default=None, max_length=40)
```

replace:

```python
class RetryIn(BaseModel):
    from_step: int | None = Field(default=None, ge=1, le=99)
```

with:

```python
class RetryIn(BaseModel):
    from_step: int | None = Field(default=None, ge=0, le=99)
```

replace:

```python
class RollbackIn(BaseModel):
    confirm_name: str | None = Field(default=None, max_length=64)


# Modes that replace data: deploy:change and the environment's name typed back.
GATED_MODES = ("reset", "restore_dump", "rollback", "teardown")
RETRY_MODES = ("update", "reset", "restore_dump", "rollback", "publish", "teardown")
```

with:

```python
class RollbackIn(BaseModel):
    confirm_name: str | None = Field(default=None, max_length=64)
    take_vm_snapshot: bool | None = None


# Modes that replace data: deploy:change and the environment's name typed back.
GATED_MODES = ("reset", "restore_dump", "rollback", "teardown", "vm_restore")
RETRY_MODES = ("update", "reset", "restore_dump", "rollback", "publish", "teardown",
               "vm_restore")
# Modes a deploy request may ask a VM snapshot for (rollback has its own route).
VM_SNAPSHOT_MODES = ("update", "reset", "restore_dump")
```

Replace the whole `_deploy_target` function:

```python
def _deploy_target(env: Environment) -> SshTargetConfig:
    settings = get_settings()
    if not vault.is_configured(settings):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    cfg = targets.ssh_config_for(env.target_id, settings)
    if cfg is None:
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    return cfg
```

with:

```python
async def _host_target(db, env: Environment, *,
                       need_secrets: bool = True) -> SshTargetConfig | None:
    """The SSH connection the host steps use. None only for a Proxmox
    environment whose VM has no address yet (step 0 builds it)."""
    settings = get_settings()
    if need_secrets and not vault.is_configured(settings):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    try:
        cfg = await vms.host_config(db, settings, env)
    except (vault.SecretsKeyMissing, vault.SecretUnreadable):
        raise HTTPException(status_code=409, detail={"code": "vm_key_unreadable"}) from None
    if cfg is None and env.target_id != targets.PROXMOX_TARGET:
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    return cfg


def _on_vm(env: Environment) -> bool:
    return env.target_id == targets.PROXMOX_TARGET


async def _require_proxmox(db, env: Environment) -> None:
    if _on_vm(env) and not await integrations.is_configured(db, "proxmox"):
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": ["proxmox"]})


def _take_vm_snapshot(env: Environment, asked: bool | None) -> bool:
    """A deployed Proxmox environment takes a VM snapshot in step 0 unless
    asked not to; a VM that never ran a deploy has nothing to keep."""
    return _on_vm(env) and env.current_sha is not None and asked is not False
```

In `_launch`, replace its signature's last line:

```python
                  restore_dump: str | None = None, publish: bool = False) -> dict:
```

with:

```python
                  restore_dump: str | None = None, publish: bool = False, vm: bool = False,
                  take_vm_snapshot: bool = False, vm_snapshot: str | None = None) -> dict:
```

replace:

```python
                                               snapshot_id=snapshot_id,
                                               restore_dump=restore_dump, publish=publish)
```

with:

```python
                                               snapshot_id=snapshot_id,
                                               restore_dump=restore_dump, publish=publish,
                                               vm=vm, take_vm_snapshot=take_vm_snapshot,
                                               vm_snapshot=vm_snapshot)
```

and replace:

```python
    if publish:
        changes["publish"] = True
    audit(db, actor_id=actor.user.person_id, action=action, entity_type="deployment",
```

with:

```python
    if publish:
        changes["publish"] = True
    if take_vm_snapshot:
        changes["take_vm_snapshot"] = True
    if vm_snapshot is not None:
        changes["vm_snapshot"] = vm_snapshot
    audit(db, actor_id=actor.user.person_id, action=action, entity_type="deployment",
```

After `_start_publish`, add:

```python
async def _start_vm_restore(db, env: Environment, name: str, request: Request,
                            actor: AuthContext) -> dict:
    """Restore VM snapshot: the VM back to a snapshot Sirdar took for this
    environment, and the environment's commit back to the one it holds."""
    if not _on_vm(env):
        raise HTTPException(status_code=409, detail={"code": "not_proxmox"})
    if not vms.valid_snapshot_name(name):
        raise HTTPException(status_code=422, detail={"code": "vm_snapshot_invalid"})
    await _require_proxmox(db, env)
    if not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    taking = (await vms.taking_deployments(db, env.id)).get(name)
    if taking is None or not taking.previous_sha:
        raise HTTPException(status_code=404, detail={"code": "vm_snapshot_not_found"})
    changed_at = (await environments.key_changes(db, env.id)).changed_at
    reason = vms.snapshot_blocked(name, changed_at)
    if reason is not None:
        raise HTTPException(status_code=409, detail={"code": "vm_snapshot_keys_changed",
                                                     "reason": reason})
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="vm_restore", git_ref=taking.previous_sha,
                         sha=taking.previous_sha, vm=True, vm_snapshot=name)
```

Replace the whole `start_deployment` function with:

```python
@router.post("/environments/{name}/deployments", status_code=201)
async def start_deployment(name: str, body: DeploymentIn, request: Request, db: DbSession,
                           actor: AuthContext = require_permission("deploy", "add")):
    _require_mode(actor, body.mode)
    env = await _environment(db, name)
    on_vm = _on_vm(env)
    if body.mode in GATED_MODES and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if body.snapshot_id is not None and body.mode != "reset":
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if (body.backup is not None) != (body.mode == "restore_dump"):
        raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
    if (body.vm_snapshot is not None) != (body.mode == "vm_restore"):
        raise HTTPException(status_code=422, detail={"code": "vm_snapshot_invalid"})
    if body.take_vm_snapshot is not None and (not on_vm or body.mode not in VM_SNAPSHOT_MODES):
        raise HTTPException(status_code=422, detail={"code": "vm_snapshot_not_allowed"})
    if body.mode == "restore_dump":
        if not environments.valid_backup_name(body.backup):
            raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
        if body.git_ref is not None:        # it deploys the running commit
            raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if body.mode in ("publish", "teardown", "vm_restore") and body.git_ref is not None:
        raise HTTPException(status_code=422, detail={"code": "git_ref_not_allowed"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    if body.mode == "publish":
        return await _start_publish(db, env, request, actor)
    if body.mode == "vm_restore":
        return await _start_vm_restore(db, env, body.vm_snapshot, request, actor)
    await _require_proxmox(db, env)
    cfg = await _host_target(db, env)            # None: a VM step 0 hasn't built yet
    take = _take_vm_snapshot(env, body.take_vm_snapshot)
    if body.mode == "teardown":
        await _require_integrations(db, env, teardown=True)
        if not on_vm:                            # step 15 Destroy VM needs no SSH
            await _pinned(db, cfg)
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="teardown", git_ref=env.git_ref, sha=env.current_sha or "",
                             vm=on_vm)
    if env.publish:
        await _require_integrations(db, env)
    if body.mode == "restore_dump":
        if env.current_sha is None:
            raise HTTPException(status_code=409, detail={"code": "not_deployed"})
        reason = environments.backup_blocked(
            body.backup, await environments.key_changes(db, env.id))
        if reason is not None:
            raise HTTPException(status_code=409, detail={"code": "backup_keys_changed",
                                                         "reason": reason})
        if not on_vm:                            # step 0 pins the VM's key
            await _pinned(db, cfg)
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="restore_dump", git_ref=env.current_sha,
                             sha=env.current_sha, restore_dump=body.backup,
                             publish=env.publish, vm=on_vm, take_vm_snapshot=take)
    snapshot_id = body.snapshot_id
    if body.mode == "update" and env.current_sha is None:
        snapshot_id = env.seed_snapshot_id          # the first deploy restores the seed
    snapshot = None
    if snapshot_id is not None:
        try:
            snapshot = await snapshots.ready_snapshot(db, snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    ref = body.git_ref or env.git_ref
    if on_vm:
        # Step 0 resolves a branch or tag on the VM: it may not exist yet.
        if not gitref.valid_ref(ref):
            raise HTTPException(status_code=422, detail={"code": "ref_invalid"})
        sha = ref.lower() if gitref.is_full_sha(ref) else ""
    else:
        try:
            sha = await gitref.resolve_ref(cfg, db, get_settings().deploy_repo_url, ref)
        except gitref.RefError as e:
            detail: dict = {"code": e.code}
            if e.code in _REF_REASON:
                detail["reason"] = _REF_REASON[e.code]
            raise HTTPException(status_code=_REF_STATUS[e.code], detail=detail) from None
        except _SSH_ERRORS as e:
            raise _ssh_http(e) from None
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode=body.mode, git_ref=ref, sha=sha, snapshot=snapshot,
                         publish=env.publish, vm=on_vm, take_vm_snapshot=take)
```

In `retry_deployment`, replace:

```python
    from_step = body.from_step or stopped
    # Whether it restored a snapshot: its own step rows say so even after the
    # snapshot was deleted (snapshot_id is then NULL).
    restoring = dep.mode in ("update", "reset") and await _has_step(db, dep.id, "restore")
    plan = plan_for(dep.mode, restore=restoring, publish=dep.publish)
```

with:

```python
    from_step = stopped if body.from_step is None else body.from_step   # 0 is a step
    # Whether it restored a snapshot: its own step rows say so even after the
    # snapshot was deleted (snapshot_id is then NULL).
    restoring = dep.mode in ("update", "reset") and await _has_step(db, dep.id, "restore")
    plan = plan_for(dep.mode, restore=restoring, publish=dep.publish, vm=dep.vm)
```

replace:

```python
    else:
        cfg = _deploy_target(env)
        await _pinned(db, cfg)
    if dep.mode == "teardown":
```

with:

```python
    else:
        await _require_proxmox(db, env)
        cfg = await _host_target(db, env)
        if not dep.vm:                  # a VM deployment's step 0 pins the key
            await _pinned(db, cfg)
    if dep.mode == "teardown":
```

and replace:

```python
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump, publish=dep.publish)
```

with:

```python
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump, publish=dep.publish, vm=dep.vm,
                         take_vm_snapshot=dep.take_vm_snapshot,
                         vm_snapshot=dep.vm_snapshot if dep.mode == "vm_restore" else None)
```

In `rollback_deployment`, replace:

```python
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    if env.publish:
        await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_rollback",
                         mode="rollback", git_ref=dep.previous_sha, sha=dep.previous_sha,
                         restore_dump=dump, publish=env.publish)
```

with:

```python
    if body.take_vm_snapshot is not None and not _on_vm(env):
        raise HTTPException(status_code=422, detail={"code": "vm_snapshot_not_allowed"})
    await _require_proxmox(db, env)
    cfg = await _host_target(db, env)
    if not _on_vm(env):
        await _pinned(db, cfg)
    if env.publish:
        await _require_integrations(db, env)
    return await _launch(db, env, request, actor, action="deploy.deployment_rollback",
                         mode="rollback", git_ref=dep.previous_sha, sha=dep.previous_sha,
                         restore_dump=dump, publish=env.publish, vm=_on_vm(env),
                         take_vm_snapshot=_take_vm_snapshot(env, body.take_vm_snapshot))
```

Replace the body of `list_backups`:

```python
    env = await _environment(db, name)
    cfg = targets.ssh_config_for(env.target_id, get_settings())
    if cfg is None:
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    try:
```

with:

```python
    env = await _environment(db, name)
    cfg = await _host_target(db, env, need_secrets=False)
    if cfg is None:                     # a VM step 0 hasn't built: nothing to list
        return {"backups": []}
    try:
```

After `list_backups`, add:

```python
@router.get("/environments/{name}/vm-snapshots")
async def list_vm_snapshots(name: str, db: DbSession,
                            actor: AuthContext = require_permission("deploy", "view")):
    """The VM snapshots Sirdar took for a Proxmox environment that still
    exist in Proxmox, newest first, with the commit each holds and whether
    it can be restored (read live from Proxmox)."""
    env = await _environment(db, name)
    if not _on_vm(env):
        raise HTTPException(status_code=409, detail={"code": "not_proxmox"})
    try:
        cfg = await integrations.load_proxmox(db, get_settings())
    except integrations.IntegrationError as e:
        raise HTTPException(status_code=409, detail={"code": e.code}) from None
    if cfg is None:
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": ["proxmox"]})
    vm = await vms.get(db, env.id)
    if vm is None or vm.vmid is None or not vm.created:
        return {"snapshots": []}
    taking = await vms.taking_deployments(db, env.id)
    changed_at = (await environments.key_changes(db, env.id)).changed_at
    try:
        async with proxmox.Proxmox(replace(cfg, node=vm.node),
                                   transport=outbound.transports()["proxmox"]) as api:
            found = await api.snapshots(vm.vmid)
    except proxmox.ProxmoxError as e:
        raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                     "reason": e.reason}) from None
    rows = []
    for snap in found:
        name_ = str(snap.get("name", ""))
        dep = taking.get(name_)
        if dep is None or not vms.valid_snapshot_name(name_):
            continue
        reason = vms.snapshot_blocked(name_, changed_at)
        rows.append({"name": name_,
                     "taken_at": vms.snapshot_taken_at(name_).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "sha": dep.previous_sha, "deployment_id": str(dep.id),
                     "description": str(snap.get("description") or ""),
                     "restorable": reason is None and bool(dep.previous_sha),
                     "reason": reason})
    return {"snapshots": sorted(rows, key=lambda r: r["name"], reverse=True)}
```

Add `from dataclasses import replace` to the imports at the top of the file.

In `take_snapshot`, replace:

```python
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
```

with:

```python
    cfg = await _host_target(db, env)
    if cfg is None:
        raise HTTPException(status_code=409, detail={"code": "vm_not_ready"})
    await _pinned(db, cfg)
```

Finally check nothing still calls `_deploy_target` or `SSH_TARGET_PATTERN`:

```bash
grep -n "_deploy_target\|SSH_TARGET_PATTERN" sirdar/api/src/sirdar_api/api/routes/deploy.py
```

Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q tests/test_deploy_vm_api.py tests/test_deploy_deployments_api.py tests/test_deploy_environments_api.py tests/test_deploy_restore_api.py tests/test_deploy_publish_api.py tests/test_deploy_snapshots_api.py tests/test_deploy_api.py tests/test_deploy_ssh_targets_api.py`
Expected: PASS (every SSH route behaves as before; `GET /targets` has no Proxmox entry unless it is set up).

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/api/routes/deploy.py src/sirdar_api/deploy/serialize.py tests/test_deploy_vm_api.py && cd ../..
git add sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/src/sirdar_api/deploy/serialize.py \
  sirdar/api/tests/test_deploy_vm_api.py
git commit -m "feat(sirdar): Proxmox environments, VM deploys, Restore VM snapshot and the VM snapshot list in the API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, the full suites, lint

**Files:**
- Modify: `sirdar/README.md`

- [ ] **Step 1: The README**

In `sirdar/README.md`, replace the steps paragraph that begins:

```markdown
**Steps.** 1 Preflight · 2 Bootstrap · 3 Fetch code · 4 Render config ·
```

up to and including its last sentence (`(\`confirm_name\`).`) with:

```markdown
**Steps.** 0 Prepare VM (Proxmox environments) · 1 Preflight · 2 Bootstrap ·
3 Fetch code · 4 Render config · 5 Build images · 6 Pre-deploy dump (Update, a
seeded first deploy too) · 7 Reset data (Reset) · 8 Start data services ·
9 Restore snapshot or Restore backup · 10 Start services (migrate, then the
app) · 11 Take snapshot (a job of its own) · 12 DNS records · 13 Proxy hosts ·
14 Smoke test (when the environment publishes) · 15 Remove environment, or
Destroy VM on Proxmox · 16 Remove proxy hosts · 17 Remove DNS records (Delete
environment). Restore VM snapshot (Proxmox) is step 0 alone. The first
failure stops the deployment; retry re-runs from the failed step. One
deployment per environment at a time. Reset, Restore backup, Roll back,
Restore VM snapshot and Delete environment replace or remove data: they need
`deploy:change` and the environment's name typed back (`confirm_name`).
```

After the "Adopting a hand-built environment" paragraph, add:

````markdown
**Proxmox targets.** Besides SSH targets, an environment can live on a VM
Sirdar builds on Proxmox (target `proxmox`). Step 0 runs Terraform
(`bpg/proxmox`, baked into the image with its checksum; no registry access) to
full-clone the Ubuntu 24.04 template into the pool as `ss-<env>` (tags
`sirdar`, `ss-<env>`), sized as the environment says (default 4 vCPU, 8 GB,
64 GB), with cloud-init for the `deploy` user, Sirdar's key for that VM and a
static address or DHCP. It then reads the VM's address and SSH host key
through the guest agent, pins the key, points every service at the VM and runs
the usual steps. Each Update, Reset, Restore backup or Roll back of a deployed
Proxmox environment first takes a VM snapshot (`sirdar-<UTC time>`, the newest
3 kept; snapshots made by hand are never touched); the Backups tab lists them
with **Restore VM snapshot**. **Delete environment** destroys the VM (only one
Sirdar created: it checks the id, name and `sirdar` tag) with its snapshots,
then the DNS records and proxy hosts. Terraform state lives in
`sirdar/terraform/<environment id>/` (mounted at `/app/terraform`, uid 10001,
mode 700): back it up with the rest of `sirdar/`, and never edit or delete
these VMs in Proxmox by hand. Existing VMs can't be adopted onto Proxmox: a
hand-built VM (uat) stays an SSH target.

Set up once on the Proxmox host (as root), then enter the URL, node, pool,
storage, bridge, template id and API token in Settings › Integrations ›
Proxmox, trust the certificate fingerprint it shows (compare it with
Datacenter › Node › System › Certificates), and press Test:

```bash
# The template: Ubuntu 24.04 cloud image with the guest agent (id 9000)
apt-get install -y libguestfs-tools
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
virt-customize -a noble-server-cloudimg-amd64.img --install qemu-guest-agent \
  --truncate /etc/machine-id
qm create 9000 --name ubuntu-2404-template --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --agent enabled=1 --ostype l26 \
  --serial0 socket --vga serial0
qm importdisk 9000 noble-server-cloudimg-amd64.img local-lvm
qm set 9000 --scsi0 local-lvm:vm-9000-disk-0,discard=on,ssd=1 --boot order=scsi0 \
  --ide2 local-lvm:cloudinit
qm template 9000
# The pool Sirdar works in, holding the template
pvesh create /pools --poolid sirdar
pvesh set /pools/sirdar --vms 9000
# A user and token that can act only in the pool, its storage and bridge
# (Proxmox 8: replace VM.GuestAgent.Audit VM.GuestAgent.FileRead with VM.Monitor)
pveum role add SirdarProvision -privs "VM.Allocate VM.Clone VM.Audit VM.PowerMgmt \
  VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType \
  VM.Config.Memory VM.Config.Network VM.Config.Options VM.Snapshot VM.Snapshot.Rollback \
  VM.GuestAgent.Audit VM.GuestAgent.FileRead Datastore.AllocateSpace Datastore.Audit \
  SDN.Use Pool.Audit Sys.Audit"
pveum user add sirdar@pve
pveum aclmod /pool/sirdar -user sirdar@pve -role SirdarProvision
pveum aclmod /storage/local-lvm -user sirdar@pve -role SirdarProvision
pveum aclmod /sdn/zones/localnetwork/vmbr0 -user sirdar@pve -role SirdarProvision
pveum aclmod /nodes/pve -user sirdar@pve -role SirdarProvision   # the bridge check (optional)
pveum user token add sirdar@pve sirdar --privsep 0               # shows the token once
```

The token (`sirdar@pve!sirdar=<uuid>`) is stored encrypted and never shown
again; Terraform gets it only through its environment. Proxmox can't be
removed from Settings while an environment uses it.

| API (under `/api/deploy`) | Needs |
|---|---|
| `PUT /integrations/proxmox`, `POST /integrations/proxmox/test`, `DELETE /integrations/proxmox` | `deploy:change` |
| `POST /environments` with `target: "proxmox"` and `vm` | `deploy:add` |
| `PATCH /environments/{name}` with `vm` (sizes, snapshots kept) | `deploy:change` |
| `GET /environments/{name}/vm-snapshots` | `deploy:view` |
| `POST /environments/{name}/deployments` (`mode`: `vm_restore`, with `vm_snapshot`) | `deploy:add` and `deploy:change` |
````

- [ ] **Step 2: Run the whole API suite**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase5a .venv/bin/pytest -q`
Expected: all pass. Fix any failure in the task that owns the code (TDD), re-run, and commit the fix with that task's files.

- [ ] **Step 3: Lint every Python file this plan touched**

Run:

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 \
  src/sirdar_api/deploy/tls_pin.py src/sirdar_api/deploy/integrations.py \
  src/sirdar_api/deploy/proxmox.py src/sirdar_api/deploy/outbound.py \
  src/sirdar_api/deploy/terraform.py src/sirdar_api/deploy/vms.py src/sirdar_api/deploy/ssh.py \
  src/sirdar_api/deploy/targets.py src/sirdar_api/deploy/gitref.py \
  src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/provision.py \
  src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/pipeline.py \
  src/sirdar_api/deploy/serialize.py src/sirdar_api/api/routes/deploy.py \
  src/sirdar_api/api/routes/integrations.py src/sirdar_api/config.py src/sirdar_api/db/models.py \
  migrations/versions/0007_proxmox.py tests/
```

Expected: `All checks passed!`

- [ ] **Step 4: Secrets never land in the code paths' outputs**

Run: `cd sirdar/api && grep -rn "PROXMOX_VE_API_TOKEN" src/ | grep -v "terraform.py"`
Expected: no output (only `terraform.run_env` puts the token anywhere, and only in Terraform's process environment).

- [ ] **Step 5: Drop the test databases**

```bash
docker exec $(docker ps -qf name=sirdar-db | head -1) psql -U sirdar -d postgres \
  -c 'DROP DATABASE IF EXISTS sirdar_test_phase5a' -c 'DROP DATABASE IF EXISTS sirdar_test_phase5a_source'
```

- [ ] **Step 6: Commit**

```bash
git add sirdar/README.md
git commit -m "docs(sirdar): Proxmox targets, the template recipe and the token's privileges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
