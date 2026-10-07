# Sirdar phase 8b (LAN Blue/Green on ESXi and Proxmox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A LAN environment on ESXi or Proxmox can be **Blue/Green**: three VMs Sirdar builds and owns,

- `ss-<env>-data` runs only the data stacks (Postgres + SeaweedFS); Postgres listens on the LAN for the two app VMs only (`pg_hba.conf` written from their addresses, plus a firewall on the VM);
- `ss-<env>-orange` and `ss-<env>-purple` each run the app stacks with `STACK_EXTERNAL_DATA=1`, pointed at the data VM;
- an **Update** deploys to the idle slot and smoke-tests it on its VM; **Activate** (or auto-activate) repoints the environment's Nginx Proxy Manager proxy hosts to the slot's VM, smoke-tests the public names through NPM and puts every proxy host back on failure;
- **Delete** takes a snapshot, then removes the three VMs and the proxy hosts and DNS records;
- the dashboard shows proxy → two servers, with Activate on the idle one.

Single-server LAN environments stay exactly as they are (one VM, local data). Blue/Green on SSH targets and converting an environment between the two are out of scope (spec).

**Architecture:**

- **VM records get a role.** `proxmox_vms` and `esxi_vms` gain `role` (`main` for today's single VM; `data`, `orange`, `purple` for Blue/Green), the primary key becomes `(environment_id, role)`, and every helper that reads or writes a VM row takes the role (default `main`, so single-server code paths and their tests don't change).
- **Slot records: a new `vm_slots` table** (environment, slot, `sha`, `image_tag`, `last_check_ok`, `last_check_at`), mirroring the commit/smoke columns of `do_slots`. Why not reuse or generalize `do_slots`: its foreign key is `do_environments` (a DigitalOcean record a LAN environment doesn't have) and half its columns are a droplet's (`droplet_id`, public/private IPs, the generated host key), which on the LAN already live on the VM rows; generalizing it would mean a nullable-everything table plus a data migration of live DigitalOcean rows for no gain. `deploy/lan_slots.py` mirrors the slot functions of `do_envs.py` (`slots_of`, `set_slot`, `after_success`), and reuses its pure ones (`target_slot`, `goes_live`).
- **Plans.** `deployments.bluegreen` marks a LAN Blue/Green deployment. Its plans (`steps.plan_for(..., vm=True, bluegreen=True)`): Update `0 Prepare VM (data VM, then the slot's), 1–5, 6 Pre-deploy dump, 7 Prepare data VM, [9 Restore snapshot], 10 Start services, [11 Create the first admin], [12 DNS records], 13 Smoke test (slot), [14 Switch traffic]`; Activate `13, 14`; Delete `[11 Take snapshot], 15 Destroy VM (all three), 16 Remove proxy hosts, 17 Remove DNS records`. Reset, Restore backup, Roll back and Restore VM snapshot are refused (409 `not_supported_on_bluegreen`): both app VMs share one database. A publish job stays the ordinary one (12–14): the services' address already follows the live slot.
- **Two hosts in one deployment.** The host steps run on the slot's VM as today; the new Ansible step **7 `data_vm` "Prepare data VM"** runs on the data VM (`_Context.data_target`), installs Docker (shared `tasks/docker.yml`), checks out the commit, writes a **data-only `.env`** (`envfile.render_data_env`: no JWT secret, pepper or TOTP key), the firewall unit, and runs `ss-stack data` with the new `db/lan.yml` override (Postgres published, `pg_hba.conf` from `STACK_DB_ALLOW`).
- **Switch traffic on the LAN** is a new Python step **14 `lan_switch`** run by the Publisher (`publish.switch_lan`): point the app services' `host_ip` at the slot's VM, `ensure_proxy` (only the forward host changes; the first time it creates the proxy hosts and certificates), the public smoke test through NPM, and on failure the old addresses and proxy hosts back. `spaces` always points at the data VM.
- **Data on the app VMs** is external: `STACK_DB_HOST` = the data VM, `STACK_DB_SSLMODE=disable` (no TLS on the LAN, as today's local stacks), objects at `https://spaces.<domain>` through NPM as today. Snapshots and pre-deploy dumps run on the slot's app VM against the data VM (the export needs the api image, which only app VMs build) — see "Decisions to confirm".
- **Step 0 on three VMs.** `vmsteps.prepare` builds a `LanContext` (one per-role context: the data VM, then the slot's VM; Destroy: purple, orange, data) and `HostProvisioner` runs the ESXi or Proxmox provisioner on each. Blue/Green VMs need static addresses (`vm_static_required`): the data VM's `pg_hba.conf` and firewall list the app VMs before they exist.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic (raw SQL), asyncssh, pyVmomi / Terraform (unchanged), Ansible, bash (`ss-stack`), Docker Compose, iptables; React 18 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-sirdar-deploy-flow-design.md` §2 "LAN Blue/Green". Phases 5–7 decisions (`docs/superpowers/plans/2026-10-04-sirdar-phase5-context.md`, `…phase6-context.md`, `…phase7-context.md`) still bind. Plan 8a (`2026-10-07-sirdar-phase8a-fresh-start.md`) comes first: this plan's migration revises 0011, and the Blue/Green Update plan takes 8a's `first_admin` flag.

## Global Constraints

**Where and how to work**

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it.
- `sirdar` is both a branch and a folder: use `--` in `git diff` and `git log`.
- Other agents commit in this worktree at the same time: `git add` only your task's files (see "File ownership"); never `git add -A`, never bare `git stash`; retry when `.git/index.lock` is busy. Never `git checkout --` a file another task owns. If a file this plan edits changed since it was written, apply the same edit to the new text and keep their change.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**House rules**

- American English in all copy, comments and docs ("Canceled" for `cancelled`).
- Every new modal gets the report-generate header (`.rgm-card`, `.rgm-head-text` with `.eyebrow`, `h3`, `.page-hint`; `.rgm-steps` when it has steps) and sizes to its content (a content-matched card width class in `sirdar.css`). 8b adds no modal; new sections use the existing section styles.
- Reuse the portal idioms: `DataTable`, `ComboBox` (with `portal`), segmented radio groups (`.segmented`, `role="radio"`, `arrowNav`), chips (`chip c-green|c-amber|c-red|c-blue|tag`), `.pf-form`, `.sirdar-kv`, `Breakable`. **Never a raw `<select>`.**
- **Secrets never appear in a response, a log line, an audit row, an exception message, a `repr()`, a stored step log, or any process's argv or environment**: the database password (`POSTGRES_PASSWORD`, also inside `SS_DATABASE_URL`), the SeaweedFS secret, the VMs' private keys and host keys, the ESXi password and Proxmox token, the NPM password, the Cloudflare token. The data VM's `.env` carries only the database password and the SeaweedFS secret.
- Never use `AVNS_`-prefixed fake passwords.
- Never invent password rules (8b adds none).

**Backend**

- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"`. Changed files pass `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` (from `sirdar/api`).
- Sirdar's dev database must be up (from the main checkout: `docker compose -f docker-compose.dev.yml up -d sirdar-db`, Postgres on 127.0.0.1:5434).
- Sirdar tests run from `sirdar/api` with **this task's own test DB**: `SIRDAR_TEST_DB=sirdar_test_p8bN .venv/bin/pytest -q tests/<file>` (N = the task number). Never the dev `sirdar` DB; run test files in the foreground with a long timeout (600000 ms), never in the background. Implementers run focused files; the controller runs the whole suite (about 22 minutes).
- When the task is done, drop its DBs: `PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8bN` and the same for `sirdar_test_p8bN_source`.
- Deploy-stack suite (tasks touching `deploy/stack`): from the worktree root, `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests`; plus `bash -n deploy/stack/ss-stack`.
- Tests never reach real ESXi, Proxmox, Terraform, NPM, Cloudflare or a public URL (`FakeEsxi`, `FakeProxmox`, `FakeTerraform`, `FakeNpm`, `FakeCloudflare`, `FakeSmoke` through `outbound.transports()`; the autouse `no_real_http` guard stays). The tests' SSH server (`tests/ssh_server.py`) plays every VM at 127.0.0.1.

**Web**

- `npm --prefix sirdar/web test -- <path>`; `npm --prefix sirdar/web run build`. Never `npm install`.
- Component tests start with `// @vitest-environment jsdom`, mock `../../lib/sirdarApi` (spreading the real module) and `@portal/auth/AuthContext` as the existing tests do.
- No new `@portal` import beyond the allowlist.
- The copy scanner (`src/lib/sirdarApi.test.ts`) must stay green: Task 9 adds copy for every code in the table below and adds `deploy/lan_slots.py` (and `LanError`) to the scanner.

**Migration number**

- **0012** (`revision = "0012"`, `down_revision = "0011"`, 8a's). Task 1 Step 1 checks every worktree and the dev DB first; if 8a's 0011 isn't merged yet, or 0012 is taken, stop and ask the controller.

## New error codes (copy added by Task 9)

| Code | Status | Raised by | Copy |
|---|---|---|---|
| `vm_static_required` | 422 | `vms.check_bluegreen` | Blue/Green needs a static address for each of the three VMs. |
| `vm_ips_not_distinct` | 422 | `vms.check_bluegreen` | The data VM and the two app VMs need three different addresses. |
| `vm_resize_not_supported` | 409 | `environments.update` | A Blue/Green environment's VM sizes can't change yet. |
| `not_bluegreen_environment` | 409 | activate route | This environment has one server, so there's nothing to activate. |
| `not_supported_on_bluegreen` | 409 | routes, pipeline | Both servers share one database, so that would change the live server too. Activate the other server to go back. |
| `bluegreen_not_allowed` | 422 | `environments.create_new` | Blue/Green on the LAN needs an ESXi or Proxmox target. |

Kept and reused: `slot_invalid`, `slot_required`, `slot_already_active`, `slot_not_deployed`, `seed_not_allowed`, `auto_activate_not_allowed` (its copy changes to "Only non-production environments with two servers activate automatically."), `vm_not_ready`, `integration_not_configured`. `not_digitalocean_environment` is retired from the activate route (it answers `not_bluegreen_environment` for any one-server environment); keep its copy for older clients.

## Decisions to confirm (recommended answers built in)

1. **Where snapshots and pre-deploy dumps run.** Spec: "Snapshots/backups run on the data VM." Taking a snapshot needs the api image (`bundle.py export-objects` runs in it), which only app VMs build. Built in: they run on the slot's app VM **against** the data VM (DigitalOcean's external-data pattern), so the data that is saved is the data VM's. Restore backup is refused anyway (shared database), so where a dump file sits matters only for a manual restore.
2. **Static addresses only** for Blue/Green VMs (DHCP refused): the data VM's `pg_hba.conf` and firewall must list both app VMs before purple exists.
3. **Proxy hosts are always managed** on a Blue/Green environment (NPM is the switch): Nginx Proxy Manager must be configured even with Publish off; Publish on/off only decides the DNS step.
4. **No VM snapshots** on Blue/Green (step 0 never takes one; Restore VM snapshot is refused): the other slot is the way back, and the data VM's data is in the pre-deploy dump and snapshots.

## Uncertain points (check in the live verify)

1. With `docker-proxy` off for LAN traffic, a published Postgres port sees the app VM's real source address (DNAT keeps it), so `pg_hba.conf`'s `/32` lines match.
2. `iptables -m conntrack --ctorigdstport` in `DOCKER-USER` filters published ports by their host port on Ubuntu 24.04's iptables-nft.
3. `docker compose up --wait` with the `db/lan.yml` override (a custom `command` with `-c hba_file=…`) keeps the image's first-start initialization.
4. NPM applies a `forward_host` change to every proxy host within the smoke test's retries (6 × 10 s).

## File ownership / parallelism

| Task | Files (create or modify) | Runs |
|---|---|---|
| 1 Records: roles, `vm_slots`, 0012 | `sirdar/api/migrations/versions/0012_lan_bluegreen.py` (new), `db/models.py`, `deploy/vms.py`, `deploy/vmcommon.py`, `deploy/terraform.py`, `deploy/cloudinit.py`; tests `conftest.py`, `test_deploy_vm_roles.py` (new), `test_deploy_vms.py`, `test_deploy_esxi_vms.py`, `test_deploy_vm_api.py`, `test_deploy_esxi_vm_api.py`, `test_deploy_cloudinit.py` | first |
| 2 Create a Blue/Green environment | `deploy/vms.py` (`check_bluegreen`), `deploy/lan_slots.py` (new), `deploy/environments.py`, `deploy/serialize.py`; tests `lan_helpers.py` (new), `test_deploy_lan_environments.py` (new), `test_deploy_environments_api.py` (ENV_KEYS) | after 1 |
| 3 Step 0 on three VMs | `deploy/provision.py`, `deploy/esxi_provision.py`, `deploy/vmsteps.py`; tests `test_deploy_lan_provision.py` (new) | after 2 |
| 4 Stack and playbooks | `deploy/stack/ss-stack`, `deploy/stack/db/lan.yml` (new), `deploy/stack/env.example`, `deploy/steps.py` (the `data_vm` StepDef only), `sirdar/api/src/sirdar_api/deploy/ansible/data_vm.yml` (new), `ansible/tasks/docker.yml` (new), `ansible/bootstrap.yml`, `ansible/dump.yml`, `ansible/slot_smoke.yml`, `sirdar/api/pyproject.toml` (package data), `deploy/envfile.py`; tests `deploy/tests/test_ss_stack.py`, `deploy/tests/test_stack_config.py`, `test_deploy_playbooks.py`, `test_deploy_envfile.py` | parallel with 1–3 |
| 5 Switch traffic on the LAN | `deploy/publish.py`, `deploy/lan_slots.py` (`slot_ip` only — coordinate: Task 2 created the file); tests `test_deploy_lan_switch.py` (new) | after 2 |
| 6 Steps and pipeline | `deploy/steps.py`, `deploy/pipeline.py`, `deploy/lan_slots.py` (`env_extra`, `data_vars`), `deploy/serialize.py` (deployment summary); tests `test_deploy_playbooks.py` (plans only), `test_deploy_pipeline_lan.py` (new) | after 3, 4, 5 |
| 7 Routes | `api/routes/deploy.py`, `deploy/environments.py` (`update` auto_activate, resize refusal); tests `test_deploy_lan_api.py` (new), `test_deploy_do_activate_api.py` (one refusal code) | after 6 |
| 8 Dashboard | `dashboard/service.py`; test `test_dashboard_flow.py` | after 2, parallel with 3–7 |
| 9 Web | `web/src/lib/sirdarApi.ts` (+ test), `pages/environments/labels.tsx` (+ test), `pages/environments/LanMachinesSection.tsx` (+ test, new), `EnvOverview.tsx`, `EnvironmentDetail.tsx`, `DeployModal.tsx`, `DeleteEnvironmentModal.tsx`, `DeploymentView.tsx`, `pages/dashboard/Spotlight.tsx`, both `testData.ts` (+ the touched tests) | parallel with 2–8 (fixtures) |
| 10 Docs, suites, live verify | `sirdar/README.md`, `deploy/stack/README.md` | last (controller) |

Dependency graph: `1 → 2 → {3, 5, 8}`; `4 ‖ 1–3`; `{3, 4, 5} → 6 → 7`; `9 ‖ 2–8`; everything → 10. Tasks 2 and 5 both touch `lan_slots.py`: Task 2 creates it; Task 5 only appends `slot_ip`; Task 6 appends `env_extra` and `data_vars`.

---

### Task 1: VM roles, `vm_slots`, migration 0012

**Files:**
- Create: `sirdar/api/migrations/versions/0012_lan_bluegreen.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py` (`ProxmoxVm.role`, `EsxiVm.role`, `VmSlot`, `Deployment.bluegreen`)
- Modify: `sirdar/api/src/sirdar_api/deploy/vms.py`, `deploy/vmcommon.py`, `deploy/terraform.py`, `deploy/cloudinit.py`
- Modify: `sirdar/api/tests/conftest.py` (`SIRDAR_TABLES` gains `vm_slots`)
- Create: `sirdar/api/tests/test_deploy_vm_roles.py`
- Modify: `sirdar/api/tests/test_deploy_vms.py`, `test_deploy_esxi_vms.py`, `test_deploy_vm_api.py`, `test_deploy_esxi_vm_api.py` (expected `vm` dicts gain `"role": "main"`), `test_deploy_cloudinit.py`

**Interfaces:**
- Produces:
  - `vms.MAIN = "main"`, `vms.DATA = "data"`, `vms.ROLES = ("main", "data", "orange", "purple")`, `vms.APP_SLOTS = ("orange", "purple")`.
  - `vms.vm_name(env_name, role="main")` → `ss-<env>` / `ss-<env>-<role>`; `_VM_NAME_RE` allows up to 54 characters after `ss-` (a 32-character environment plus `-purple`).
  - `vms.get(db, env_id, role="main")`, `vms.get_for(db, env, role="main")`, `vms.machines(db, env) -> list` (every VM row, roles in `ROLES` order).
  - `vms.add(db, settings, env, spec, proxmox, *, role="main")`, `vms.add_esxi(db, settings, env, spec, esxi, *, role="main")`.
  - `vms.host_config(db, settings, env, *, slot=None, role=None)`: a Blue/Green VM environment resolves `role or slot or env.active_slot or env.slots[0]`; everything else as today.
  - `vms.address_in_use(..., env_id=None, role=None)`: with `role`, this environment's other VMs count as taken.
  - `vms.public(vm)` gains `"role"`.
  - `vmcommon.set_vm(model, env_id, *, role="main", **values)`; `check_address(..., role="main")`; `record_address(..., role="main", services=None)` (`None`: every service follows the VM, today's rule; a tuple: only those services); `settle_address(..., role="main", services=None)`.
  - `terraform.workdir(settings, env_id, role="main")` (`<dir>/<env_id>` for main, `<dir>/<env_id>-<role>` otherwise), `prepare_workdir(..., role="main")`, `remove_workdir(..., role="main")`.
  - `cloudinit.metadata(..., role="main")` (instance id `sirdar-<env_id>` for main, `sirdar-<env_id>-<role>` otherwise); `_HOSTNAME_RE` widened like `_VM_NAME_RE`.
  - Table `vm_slots (environment_id, slot ∈ {orange, purple}, sha, image_tag, last_check_ok, last_check_at, created_at, updated_at)`, PK `(environment_id, slot)`, `ON DELETE CASCADE`; `deployments.bluegreen boolean NOT NULL DEFAULT false`.

- [ ] **Step 1: Check the migration number**

From the main checkout: `grep -l 'revision = "001[12]"' .claude/worktrees/*/sirdar/api/migrations/versions/*.py sirdar/api/migrations/versions/*.py` and `docker compose -f docker-compose.dev.yml exec -T sirdar-db psql -U sirdar -d sirdar -tAc 'SELECT version_num FROM alembic_version'`.
Expected: only 8a's `0011_first_admin.py` (in this worktree), nothing at 0012, the dev DB at 0011 or lower. Otherwise stop and report.

- [ ] **Step 2: Write the failing tests**

Create `sirdar/api/tests/test_deploy_vm_roles.py`:

```python
"""VM rows carry a role (migration 0012): today's single VM is `main`; a
LAN Blue/Green environment has `data`, `orange` and `purple`. Every helper
defaults to `main`, so single-server environments don't change."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import EnvironmentService, EsxiVm, VmSlot
from sirdar_api.deploy import cloudinit, terraform, vmcommon, vms

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import ESXI_VALUES


def test_names():
    assert vms.vm_name("uat3") == "ss-uat3"
    assert vms.vm_name("uat3", "data") == "ss-uat3-data"
    long = "a" + "b" * 31                                  # the longest environment name
    assert vms.check_vm_hostname(vms.vm_name(long, "purple")) == f"ss-{long}-purple"


async def _esxi_row(db, env, role: str, ip: str) -> EsxiVm:
    spec = {"cores": 2, "memory_mb": 4096, "disk_gb": 40, "ip_mode": "static",
            "ip_cidr": f"{ip}/24", "gateway": "10.10.48.1"}
    return await vms.add_esxi(db, get_settings(), env, spec, ESXI_VALUES, role=role)


async def test_three_rows_per_environment(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    for role, ip in (("data", "10.10.48.47"), ("orange", "10.10.48.48"),
                     ("purple", "10.10.48.49")):
        await _esxi_row(db, env, role, ip)
    await db.commit()
    rows = await vms.machines(db, env)
    assert [(r.role, r.name) for r in rows] == [
        ("data", "ss-lan1-data"), ("orange", "ss-lan1-orange"), ("purple", "ss-lan1-purple")]
    assert (await vms.get_for(db, env, "orange")).name == "ss-lan1-orange"
    assert await vms.get_for(db, env) is None                 # no main VM
    assert vms.public(rows[0])["role"] == "data"
    with pytest.raises(IntegrityError):
        await _esxi_row(db, env, "data", "10.10.48.50")      # one row per role
    await db.rollback()


async def test_set_vm_and_record_address_touch_one_role(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", host="0.0.0.0", secrets={})
    for role, ip in (("data", "10.10.48.47"), ("orange", "10.10.48.48")):
        await _esxi_row(db, env, role, ip)
    await db.commit()
    await vmcommon.set_vm(EsxiVm, env.id, role="data", moref="7")
    with pytest.MonkeyPatch.context() as mp:
        async def free(*args, **kwargs) -> bool:
            return False
        mp.setattr(vms, "address_in_use", free)
        moved = await vmcommon.record_address(get_settings(), EsxiVm, env.id, None,
                                              "10.10.48.47", host_label="ESXi", role="data",
                                              services=("spaces",))
    assert moved is True
    async with get_sessionmaker()() as s:
        rows = {r.role: r for r in await s.scalars(select(EsxiVm))}
        hosts = dict((await s.execute(select(EnvironmentService.service,
                                             EnvironmentService.host_ip))).all())
    assert (rows["data"].moref, rows["data"].ip) == ("7", "10.10.48.47")
    assert (rows["orange"].moref, rows["orange"].ip) == (None, None)
    assert hosts["spaces"] == "10.10.48.47" and hosts["api"] == "0.0.0.0"


async def test_an_environments_other_vm_holds_its_address(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    data = await _esxi_row(db, env, "data", "10.10.48.47")
    data.ip = "10.10.48.47"
    await db.commit()
    taken = await vms.address_in_use(db, get_settings(), "10.10.48.47", proxy_ip="10.0.0.2",
                                     env_id=env.id, role="orange")
    assert taken is True
    assert await vms.address_in_use(db, get_settings(), "10.10.48.47", proxy_ip="10.0.0.2",
                                    env_id=env.id, role="data") is False


async def test_host_config_follows_the_slot(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    for role, ip in (("data", "10.10.48.47"), ("orange", "10.10.48.48"),
                     ("purple", "10.10.48.49")):
        row = await _esxi_row(db, env, role, ip)
        row.ip = ip
    env.slots, env.active_slot = ["orange", "purple"], "purple"
    await db.commit()
    s = get_settings()
    assert (await vms.host_config(db, s, env)).host == "10.10.48.49"            # active
    assert (await vms.host_config(db, s, env, slot="orange")).host == "10.10.48.48"
    assert (await vms.host_config(db, s, env, role="data")).host == "10.10.48.47"


def test_terraform_workdir_per_role(tmp_path):
    import uuid
    from types import SimpleNamespace
    settings = SimpleNamespace(terraform_dir=str(tmp_path))      # workdir reads only this
    env_id = uuid.uuid4()
    assert terraform.workdir(settings, env_id) == tmp_path / str(env_id)
    assert terraform.workdir(settings, env_id, "data") == tmp_path / f"{env_id}-data"


def test_cloudinit_instance_id_per_role():
    import uuid
    env_id = uuid.uuid4()
    meta = cloudinit.metadata(env_id=env_id, hostname="ss-lan1-data", ip_cidr="10.10.48.47/24",
                              gateway="10.10.48.1", dns_servers=(), role="data")
    assert f"instance-id: sirdar-{env_id}-data" in meta
    main = cloudinit.metadata(env_id=env_id, hostname="ss-lan1", ip_cidr=None, gateway=None,
                              dns_servers=())
    assert f"instance-id: sirdar-{env_id}\n" in main


async def test_vm_slots_go_with_the_environment(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    db.add(VmSlot(environment_id=env.id, slot="orange"))
    await db.commit()
    await db.delete(env)
    await db.commit()
    assert await db.scalar(select(VmSlot)) is None
```

In `test_deploy_vms.py`, `test_deploy_esxi_vms.py`, `test_deploy_vm_api.py` and `test_deploy_esxi_vm_api.py`, add `"role": "main"` to every expected `vm` / `vms.public(...)` dict (search for `"moref"` and `"stage":`).

- [ ] **Step 3: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b1 .venv/bin/pytest -q tests/test_deploy_vm_roles.py`
Expected: FAIL (`cannot import name 'VmSlot'`).

- [ ] **Step 4: Migration 0012**

Create `sirdar/api/migrations/versions/0012_lan_bluegreen.py`:

```python
"""LAN Blue/Green (deploy phase 8b): VM rows get a role (main for the one VM
of a single-server environment; data, orange and purple for a Blue/Green
one), each slot's commit and smoke test (vm_slots), and the deployments that
run a LAN Blue/Green plan.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-07
"""
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

_ROLES = "('main', 'data', 'orange', 'purple')"


def upgrade() -> None:
    op.execute(f"""
        ALTER TABLE proxmox_vms
          ADD COLUMN role text NOT NULL DEFAULT 'main' CHECK (role IN {_ROLES}),
          DROP CONSTRAINT proxmox_vms_pkey,
          ADD PRIMARY KEY (environment_id, role);
        ALTER TABLE esxi_vms
          ADD COLUMN role text NOT NULL DEFAULT 'main' CHECK (role IN {_ROLES}),
          DROP CONSTRAINT esxi_vms_pkey,
          ADD PRIMARY KEY (environment_id, role);

        CREATE TABLE vm_slots (
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          slot text NOT NULL CHECK (slot IN ('orange', 'purple')),
          sha text,
          image_tag text,
          last_check_ok boolean,
          last_check_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (environment_id, slot)
        );

        ALTER TABLE deployments ADD COLUMN bluegreen boolean NOT NULL DEFAULT false;
    """)


def downgrade() -> None:
    # Refuses while a Blue/Green environment exists: its VMs would lose their records.
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM proxmox_vms WHERE role <> 'main')
             OR EXISTS (SELECT 1 FROM esxi_vms WHERE role <> 'main') THEN
            RAISE EXCEPTION 'Can''t downgrade below 0012 while Blue/Green VMs exist: '
                            'delete those environments first.';
          END IF;
        END $$;
        ALTER TABLE deployments DROP COLUMN bluegreen;
        DROP TABLE vm_slots;
        ALTER TABLE esxi_vms DROP CONSTRAINT esxi_vms_pkey,
          ADD PRIMARY KEY (environment_id), DROP COLUMN role;
        ALTER TABLE proxmox_vms DROP CONSTRAINT proxmox_vms_pkey,
          ADD PRIMARY KEY (environment_id), DROP COLUMN role;
    """)
```

- [ ] **Step 5: Models**

In `sirdar/api/src/sirdar_api/db/models.py` (docstring: "0001–0012"):

- `ProxmoxVm` and `EsxiVm`: after `environment_id`, add
  ```python
      # main: the one VM of a single-server environment; data, orange, purple:
      # a LAN Blue/Green environment's (migration 0012)
      role: Mapped[str] = mapped_column(primary_key=True, server_default=text("'main'"))
  ```
  and update both docstrings' "for one environment" to "for one environment (one per role)".
- `Deployment`, after `first_admin`:
  ```python
      # LAN Blue/Green (migration 0012): its plan is a LAN Blue/Green plan;
      # `slot` and `go_live` mean what they mean on DigitalOcean.
      bluegreen: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
  ```
- after `class EsxiVm`:
  ```python
  class VmSlot(Base):
      """One slot of a LAN Blue/Green environment (migration 0012): the commit
      its app VM runs and its last slot smoke test. The VM itself is the
      proxmox_vms / esxi_vms row whose role is the slot."""

      __tablename__ = "vm_slots"

      environment_id: Mapped[uuid.UUID] = mapped_column(
          ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)
      slot: Mapped[str] = mapped_column(primary_key=True)
      sha: Mapped[str | None]
      image_tag: Mapped[str | None]
      last_check_ok: Mapped[bool | None] = mapped_column(Boolean)
      last_check_at: Mapped[datetime | None]
      created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
      updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
  ```

In `sirdar/api/tests/conftest.py`, append `, vm_slots` to `SIRDAR_TABLES`.

- [ ] **Step 6: `vms.py`**

In `sirdar/api/src/sirdar_api/deploy/vms.py`:

```python
MAIN, DATA = "main", "data"
APP_SLOTS = ("orange", "purple")
ROLES = (MAIN, DATA, *APP_SLOTS)


def vm_name(env_name: str, role: str = MAIN) -> str:
    return f"ss-{env_name}" if role == MAIN else f"ss-{env_name}-{role}"


# A VM's name is its guest host name too: "ss-", an environment name and,
# for a Blue/Green VM, "-data" / "-orange" / "-purple"; never ending in "-".
_VM_NAME_RE = re.compile(r"ss-[a-z][a-z0-9-]{0,52}[a-z0-9]")
```

- `get(db, env_id, role=MAIN)` → `await db.get(ProxmoxVm, (env_id, role), populate_existing=True)`.
- `get_for(db, env, role=MAIN)` → `await db.get(model, (env.id, role), populate_existing=True)`.
- add:
  ```python
  async def machines(db: AsyncSession, env: Environment) -> list[ProxmoxVm | EsxiVm]:
      """Every VM row of a VM environment, in ROLES order."""
      model = MODELS.get(env.target_id)
      if model is None:
          return []
      rows = list(await db.scalars(select(model).where(model.environment_id == env.id)
                                   .execution_options(populate_existing=True)))
      return sorted(rows, key=lambda r: ROLES.index(r.role))
  ```
- `add(..., *, role: str = MAIN)`: `ProxmoxVm(environment_id=env.id, role=role, …, name=vm_name(env.name, role), …)`.
- `add_esxi(..., *, role: str = MAIN)`: `name = check_vm_hostname(vm_name(env.name, role))`, `EsxiVm(environment_id=env.id, role=role, name=name, …)`. Keep `new_keypair(env.name)` / `new_host_keypair(env.name)` calls as they are (tests replace `new_host_keypair` with a one-argument lambda).
- `address_in_use(..., env_id=None, role=None)`: in the VM loop,
  ```python
          machines_q = select(model.ip, model.ip_cidr)
          if env_id is not None:
              mine = model.environment_id == env_id
              # a Blue/Green environment's other VMs hold their addresses too
              machines_q = machines_q.where(~mine if role is None else ~(mine & (model.role == role)))
  ```
  (rename the local `machines` variable so it doesn't shadow the new function).
- `host_config(db, settings, env, *, slot=None, role=None)`: after the DigitalOcean branch and the SSH branch,
  ```python
      if role is None:
          role = (slot or env.active_slot or env.slots[0]) if env.slots else MAIN
      vm = await get_for(db, env, role)
  ```
  (the rest as today). Docstring: "…for a VM environment the VM's (a Blue/Green one: `role`, else the slot's: `slot`, else the active slot, else the first)…".
- `public(vm)`: add `"role": vm.role` to `common`.

- [ ] **Step 7: `vmcommon.py`, `terraform.py`, `cloudinit.py`**

`sirdar/api/src/sirdar_api/deploy/vmcommon.py`:

```python
async def set_vm(model, env_id: uuid.UUID, *, role: str = vms.MAIN, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(model).where(model.environment_id == env_id, model.role == role)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()
```

- `_address_free(s, settings, env_id, ip, host_label, *, before_boot=False, role=None)` passes `role=role` to `vms.address_in_use`; `check_address(..., role: str = vms.MAIN)` passes it on.
- `record_address(settings, model, env_id, previous, ip, *, host_label="Proxmox", role=vms.MAIN, services: tuple[str, ...] | None = None)`:
  ```python
      async with get_sessionmaker()() as s:
          await _address_free(s, settings, env_id, ip, host_label, role=role)
          if ip != previous:
              await s.execute(update(model).where(model.environment_id == env_id,
                                                  model.role == role)
                              .values(ip=ip, updated_at=datetime.now(UTC)))
          moved = 0
          if services is None or services:
              query = update(EnvironmentService).where(
                  EnvironmentService.environment_id == env_id, EnvironmentService.host_ip != ip)
              if services is not None:
                  query = query.where(EnvironmentService.service.in_(services))
              moved = (await s.execute(query.values(host_ip=ip))).rowcount
          await s.commit()
          return moved > 0
  ```
  Docstring: "`services`: None moves every service to the VM (a single-server environment); a tuple only those (a Blue/Green data VM: spaces; an app VM: none — Switch traffic moves them)."
- `settle_address(..., host_label="Proxmox", role=vms.MAIN, services=None)` passes `role` to `check_address` and `role`, `services` to `record_address`; its "Every service now points at" line becomes `out(f"{'Every service' if services is None else ', '.join(services)} now points at {ip}.\n")` (only when `moved`).

`sirdar/api/src/sirdar_api/deploy/terraform.py`:

```python
def workdir(settings: Settings, env_id: uuid.UUID, role: str = "main") -> Path:
    name = str(env_id) if role == "main" else f"{env_id}-{role}"
    return Path(settings.terraform_dir) / name
```

`prepare_workdir(settings, env_id, config, ca_pem, role: str = "main")` uses `workdir(settings, env_id, role)`; `remove_workdir(settings, env_id, role: str = "main")` likewise. Module docstring: "One working folder per VM: SIRDAR_TERRAFORM_DIR/<environment id>/ (a Blue/Green VM: <environment id>-<role>/)".

`sirdar/api/src/sirdar_api/deploy/cloudinit.py`: `_HOSTNAME_RE = re.compile(r"ss-[a-z][a-z0-9-]{0,52}[a-z0-9]")` (comment: "vms.check_vm_hostname's rule"); `metadata(..., dns_servers, role: str = "main")` with `"instance-id": f"sirdar-{env_id}" if role == "main" else f"sirdar-{env_id}-{role}"`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b1 .venv/bin/pytest -q tests/test_deploy_vm_roles.py tests/test_deploy_vms.py tests/test_deploy_esxi_vms.py tests/test_deploy_vm_api.py tests/test_deploy_esxi_vm_api.py tests/test_deploy_cloudinit.py tests/test_deploy_provision.py tests/test_deploy_esxi_provision.py tests/test_deploy_pipeline_vm.py tests/test_deploy_terraform.py tests/test_deploy_models.py tests/test_scaffold.py`
Expected: PASS (the provisioners still default to `main`). If `tests/test_deploy_terraform.py` doesn't exist, drop it from the list.

- [ ] **Step 9: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 migrations/versions/0012_lan_bluegreen.py src/sirdar_api/db/models.py src/sirdar_api/deploy/vms.py src/sirdar_api/deploy/vmcommon.py src/sirdar_api/deploy/terraform.py src/sirdar_api/deploy/cloudinit.py tests/test_deploy_vm_roles.py
cd ../.. && git add sirdar/api/migrations/versions/0012_lan_bluegreen.py sirdar/api/src/sirdar_api/db/models.py sirdar/api/src/sirdar_api/deploy/vms.py sirdar/api/src/sirdar_api/deploy/vmcommon.py sirdar/api/src/sirdar_api/deploy/terraform.py sirdar/api/src/sirdar_api/deploy/cloudinit.py sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_vm_roles.py sirdar/api/tests/test_deploy_vms.py sirdar/api/tests/test_deploy_esxi_vms.py sirdar/api/tests/test_deploy_vm_api.py sirdar/api/tests/test_deploy_esxi_vm_api.py sirdar/api/tests/test_deploy_cloudinit.py
git commit -m "feat(sirdar): VM rows get a role; vm_slots (migration 0012)

main for a single-server environment, data/orange/purple for LAN
Blue/Green; every helper defaults to main. vm_slots keeps each slot's
commit and smoke test.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b1
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b1_source
```

---

### Task 2: Create a LAN Blue/Green environment

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/vms.py` (`check_bluegreen`)
- Create: `sirdar/api/src/sirdar_api/deploy/lan_slots.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`create_new` Blue/Green path)
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py` (`machines`, `lan_slots`)
- Create: `sirdar/api/tests/lan_helpers.py`, `sirdar/api/tests/test_deploy_lan_environments.py`
- Modify: `sirdar/api/tests/test_deploy_environments_api.py` (`ENV_KEYS` gains `machines`, `lan_slots`)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `vms.check_bluegreen(fields) -> {"orange": spec, "purple": spec, "data": spec, "auto_activate": bool}` — `fields` is the create body's `vm` with `slots: 2`, `ip_cidr` (orange), `purple_ip_cidr`, `data_ip_cidr`, one `gateway`, the app sizes, optional `data: {cores, memory_mb, disk_gb}`, optional `auto_activate`. Static only (`vm_static_required`), three distinct addresses (`vm_ips_not_distinct`), each checked like a single VM's.
  - `lan_slots.is_bluegreen(env) -> bool` (a VM target with two slots).
  - `async lan_slots.add(db, env_id, slots)`, `async lan_slots.slots_of(db, env_id) -> dict[str, VmSlot]`, `async lan_slots.set_slot(env_id, slot, **values)` (own session), `async lan_slots.ran(db, env) -> bool` (anything live, or a slot whose `up` ran), `async lan_slots.after_success(db, env, dep)` (as `do_envs.after_success`; raises `do_envs.DoEnvError("slot_not_deployed", slot=…)`), `lan_slots.public(env, rows, machines) -> list[dict]`.
  - `environments.create_new(..., vm={"slots": 2, …})` on `esxi` / `proxmox`: Nginx Proxy Manager must be configured (`integration_not_configured {kinds: ["npm"]}`); `env.slots = ["orange", "purple"]`; three VM rows (`data`, `orange`, `purple`); two `vm_slots` rows; every service's `host_ip` = orange's address except `spaces` = the data VM's; `auto_activate` from `vm.auto_activate`. `vm.slots` other than 1 or 2 → `vm_invalid`; `vm.slots: 2` on an SSH or DigitalOcean target → `bluegreen_not_allowed`.
  - Environment JSON gains `"machines": [vms.public(row) …]` (every VM; a single-server VM environment lists its one `main` row; others `[]`) and `"lan_slots": [{"slot", "ip", "sha", "image_tag", "active", "last_check_ok", "last_check_at"}] | null` (`null` unless Blue/Green). `"vm"` stays the `main` row (`null` on Blue/Green).

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/lan_helpers.py`:

```python
"""LAN Blue/Green environments for tests. The three VMs' static addresses
are on loopback (127.0.0.1-3/8); the step-0 effect records 127.0.0.1 for
every VM, so the tests' own SSH server plays all three once vms.VM_SSH_PORT
points at it."""

import pytest

from sirdar_api.config import get_settings
from sirdar_api.db.models import EsxiVm
from sirdar_api.deploy import environments, vmcommon, vms

ORANGE, PURPLE, DATA = "127.0.0.1", "127.0.0.2", "127.0.0.3"
LAN_VM = {"slots": 2, "ip_mode": "static", "ip_cidr": f"{ORANGE}/8",
          "purple_ip_cidr": f"{PURPLE}/8", "data_ip_cidr": f"{DATA}/8",
          "gateway": "127.0.0.254", "cores": 2, "memory_mb": 4096, "disk_gb": 40,
          "data": {"cores": 2, "memory_mb": 4096, "disk_gb": 60}}


async def make_bluegreen_environment(db, *, name: str = "lan9", target: str = "esxi",
                                     publish: bool = False, host_key=None,
                                     **vm):
    """Needs secrets_key, the target's integration and NPM (integration_helpers).
    Loopback is allowed and the address check skipped, as in vm_helpers."""
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
                                            target_id=target, proxy_ip="10.0.0.2",
                                            vm={**LAN_VM, **vm}, publish=publish)
    await db.commit()
    return env


def lan_built(model=EsxiVm):
    """A step-0 effect for a LanContext: every VM it names is built at
    127.0.0.1 (each Proxmox VM gets its own id: vmid is unique)."""
    async def effect(ctx) -> None:
        for n, machine in enumerate(ctx.machines):
            extra = {"moref": str(n + 1)} if model is EsxiVm else {"vmid": 200 + n}
            await vmcommon.set_vm(model, ctx.env_id, role=machine.vm.role, created=True,
                                  ip="127.0.0.1", **extra)
    return effect
```

Create `sirdar/api/tests/test_deploy_lan_environments.py`:

```python
"""Creating a LAN Blue/Green environment: three VM rows, two slots, the
services' first addresses, and the checks."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentService, VmSlot
from sirdar_api.deploy import environments, lan_slots, serialize, vms

from .deploy_factories import secrets_key  # noqa: F401
from .integration_helpers import configure, configure_esxi, configure_proxmox
from .lan_helpers import DATA, LAN_VM, ORANGE, PURPLE, make_bluegreen_environment


@pytest.fixture
async def esxi(db, secrets_key):
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)


async def test_create_builds_three_records_and_two_slots(db, esxi):
    env = await make_bluegreen_environment(db, auto_activate=True)
    assert (env.slots, env.active_slot, env.auto_activate) == (["orange", "purple"], None, True)
    assert lan_slots.is_bluegreen(env)
    rows = await vms.machines(db, env)
    assert [(r.role, r.name, vms.static_ip(r.ip_cidr), r.cores, r.disk_gb) for r in rows] == [
        ("data", "ss-lan9-data", DATA, 2, 60), ("orange", "ss-lan9-orange", ORANGE, 2, 40),
        ("purple", "ss-lan9-purple", PURPLE, 2, 40)]
    assert sorted((await lan_slots.slots_of(db, env.id))) == ["orange", "purple"]
    hosts = dict((await db.execute(select(EnvironmentService.service, EnvironmentService.host_ip)
                                   .where(EnvironmentService.environment_id == env.id))).all())
    assert hosts["spaces"] == DATA
    assert {h for s, h in hosts.items() if s != "spaces"} == {ORANGE}


async def test_the_json_lists_the_machines_and_slots(db, esxi):
    env = await make_bluegreen_environment(db)
    out = await serialize.environment_out(db, env)
    assert out["vm"] is None
    assert [m["role"] for m in out["machines"]] == ["data", "orange", "purple"]
    assert out["lan_slots"] == [
        {"slot": "orange", "ip": None, "sha": None, "image_tag": None, "active": False,
         "last_check_ok": None, "last_check_at": None},
        {"slot": "purple", "ip": None, "sha": None, "image_tag": None, "active": False,
         "last_check_ok": None, "last_check_at": None}]


@pytest.mark.parametrize("change, code", [
    ({"ip_mode": "dhcp", "ip_cidr": None, "gateway": None}, "vm_static_required"),
    ({"purple_ip_cidr": f"{ORANGE}/8"}, "vm_ips_not_distinct"),
    ({"data_ip_cidr": None}, "vm_ip_invalid"),
    ({"slots": 3}, "vm_invalid"),
    ({"auto_activate": "yes"}, "vm_invalid"),
])
async def test_create_refusals(db, esxi, change, code):
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db, **change)
    assert e.value.code == code


async def test_needs_npm(db, secrets_key):
    await configure_esxi(db)
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db)
    assert (e.value.code, e.value.extra) == ("integration_not_configured", {"kinds": ["npm"]})


async def test_only_on_a_vm_host(db, secrets_key):
    with pytest.raises(environments.EnvError) as e:
        await environments.create_new(db, get_settings(), name="x1", type_="dev",
                                      target_id="ssh", proxy_ip="10.0.0.2", vm=LAN_VM)
    assert e.value.code in ("bluegreen_not_allowed", "target_not_configured")


async def test_proxmox_too(db, secrets_key):
    await configure_proxmox(db)
    await configure(db, cloudflare=True, npm=True)
    env = await make_bluegreen_environment(db, target="proxmox")
    assert [r.role for r in await vms.machines(db, env)] == ["data", "orange", "purple"]


async def test_a_single_server_environment_is_unchanged(db, esxi):
    from .vm_helpers import make_esxi_environment
    env = await make_esxi_environment(db, name="solo")
    assert (env.slots, lan_slots.is_bluegreen(env)) == ([], False)
    assert [r.role for r in await vms.machines(db, env)] == ["main"]
    assert await db.scalar(select(VmSlot)) is None
```

In `test_deploy_environments_api.py`, add `"machines"` and `"lan_slots"` to `ENV_KEYS`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b2 .venv/bin/pytest -q tests/test_deploy_lan_environments.py`
Expected: FAIL (`No module named 'sirdar_api.deploy.lan_slots'`).

- [ ] **Step 3: `vms.check_bluegreen`**

Append to `vms.py` after `check_spec`:

```python
def check_bluegreen(fields: dict) -> dict:
    """A LAN Blue/Green environment's three VMs: orange (`ip_cidr`) and purple
    (`purple_ip_cidr`) with the app sizes, the data VM (`data_ip_cidr`, sizes
    in `data`, default DEFAULTS) on the same gateway. Static addresses only:
    the data VM's pg_hba.conf and firewall list the app VMs before they exist."""
    if not isinstance(fields, dict):
        raise VmError("vm_invalid")
    if fields.get("ip_mode") != "static":
        raise VmError("vm_static_required")
    orange = check_spec(fields)
    purple = check_spec({**fields, "ip_cidr": fields.get("purple_ip_cidr")})
    data_sizes = fields.get("data") or {}
    if not isinstance(data_sizes, dict):
        raise VmError("vm_invalid")
    data = check_spec({**{k: data_sizes.get(k) for k in DEFAULTS}, "ip_mode": "static",
                       "ip_cidr": fields.get("data_ip_cidr"), "gateway": fields.get("gateway")})
    if len({static_ip(s["ip_cidr"]) for s in (orange, purple, data)}) != 3:
        raise VmError("vm_ips_not_distinct")
    auto = fields.get("auto_activate", False)
    if not isinstance(auto, bool):
        raise VmError("vm_invalid")
    return {"orange": orange, "purple": purple, "data": data, "auto_activate": auto}
```

- [ ] **Step 4: `lan_slots.py`**

Create `sirdar/api/src/sirdar_api/deploy/lan_slots.py`:

```python
"""LAN Blue/Green environments' slots (deploy phase 8b): two app VMs
(orange, purple) and a data VM, on ESXi or Proxmox. vm_slots keeps each
slot's commit and last smoke test; the VMs are the proxmox_vms / esxi_vms
rows whose role is the slot. Which slot an Update targets and when it goes
live are DigitalOcean's rules (do_envs.target_slot, do_envs.goes_live).

set_slot writes in its own committed transaction (the pipeline's slot smoke
test records its result whatever happens next)."""

from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Environment, VmSlot
from sirdar_api.deploy import do_envs, envfile, targets, vms

SLOTS = vms.APP_SLOTS


def is_bluegreen(env: Environment) -> bool:
    return targets.is_vm_target(env.target_id) and len(env.slots or ()) == 2


async def add(db: AsyncSession, env_id, slots) -> None:
    for slot in slots:
        db.add(VmSlot(environment_id=env_id, slot=slot))
    await db.flush()


async def slots_of(db: AsyncSession, env_id) -> dict[str, VmSlot]:
    rows = await db.scalars(select(VmSlot).where(VmSlot.environment_id == env_id)
                            .execution_options(populate_existing=True))
    return {r.slot: r for r in rows}


async def ran(db: AsyncSession, env: Environment) -> bool:
    """Anything live, or a slot whose up step ran: the shared database is
    then seeded (and migrated), so the next Update doesn't seed again."""
    if env.current_sha is not None or env.active_slot is not None:
        return True
    return any(r.sha for r in (await slots_of(db, env.id)).values())


async def set_slot(env_id, slot: str, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(VmSlot).where(VmSlot.environment_id == env_id,
                                             VmSlot.slot == slot)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


async def after_success(db: AsyncSession, env: Environment, dep) -> None:
    """As do_envs.after_success, for vm_slots: the slot keeps the commit it now
    runs; if traffic moved, it is the active one and its commit the
    environment's. The caller commits."""
    now = datetime.now(UTC)
    slot = await db.get(VmSlot, (env.id, dep.slot), populate_existing=True) if dep.slot else None
    if dep.go_live and dep.mode != "update" and dep.slot and (slot is None or not slot.sha):
        raise do_envs.DoEnvError("slot_not_deployed", slot=dep.slot)
    if dep.mode == "update" and slot is not None:
        slot.sha, slot.image_tag, slot.updated_at = dep.sha, envfile.image_tag(dep.sha), now
    if dep.go_live:
        env.active_slot = dep.slot
        if slot is not None and slot.sha:
            env.current_sha, env.image_tag = slot.sha, slot.image_tag
    env.status, env.updated_at = "ready", now


def public(env: Environment, rows: dict[str, VmSlot], machines: list) -> list[dict]:
    by_role = {m.role: m for m in machines}
    return [{"slot": s, "ip": by_role[s].ip if s in by_role else None,
             "sha": r.sha, "image_tag": r.image_tag, "active": s == env.active_slot,
             "last_check_ok": r.last_check_ok, "last_check_at": r.last_check_at}
            for s in env.slots if (r := rows.get(s)) is not None]
```

- [ ] **Step 5: `create_new`'s Blue/Green path**

In `environments.py`, import `lan_slots`. In `create_new`, the VM branch (`if targets.is_vm_target(target_id):`) becomes:

```python
    bluegreen = None
    if vm is not None and vm.get("slots") not in (None, 1, 2):
        raise EnvError("vm_invalid")
    if vm is not None and vm.get("slots") == 2 and not targets.is_vm_target(target_id):
        raise EnvError("bluegreen_not_allowed")
    if targets.is_vm_target(target_id):
        if not await integrations.is_configured(db, target_id):
            raise EnvError("integration_not_configured", kinds=[target_id])
        try:
            if (vm or {}).get("slots") == 2:
                if not await integrations.is_configured(db, "npm"):
                    # Nginx Proxy Manager is the switch between the two app VMs.
                    raise EnvError("integration_not_configured", kinds=["npm"])
                bluegreen = vms.check_bluegreen(vm)
                addresses = [vms.static_ip(bluegreen[r]["ip_cidr"])
                             for r in ("orange", "purple", "data")]
                await vms.lock_addresses(db)        # held until the caller commits
                for address in addresses:
                    if await vms.address_in_use(db, settings, address, proxy_ip=proxy):
                        raise EnvError("ip_in_use")
                address = addresses[0]                 # services start on orange
            else:
                spec = vms.check_spec({} if vm is None else
                                      {k: v for k, v in vm.items() if k != "slots"})
                address = vms.static_ip(spec["ip_cidr"])
                if address:
                    await vms.lock_addresses(db)
                    if await vms.address_in_use(db, settings, address, proxy_ip=proxy):
                        raise EnvError("ip_in_use")
        except vms.VmError as e:
            raise EnvError(e.code, **e.extra) from None
        host = address or "0.0.0.0"
```

(`vms.check_spec` ignores keys it doesn't know, so passing the dict without `slots` keeps today's behavior; the `elif vm is not None: raise EnvError("vm_not_allowed")` branch stays.) After `_insert(...)`, replace the `if spec is not None:` block with:

```python
    stored = await integrations.config_of(db, target_id) if targets.is_vm_target(target_id) \
        else None
    add_vm = vms.add_esxi if target_id == targets.ESXI_TARGET else vms.add
    try:
        if bluegreen is not None:
            env.slots, env.auto_activate = list(lan_slots.SLOTS), bluegreen["auto_activate"]
            for role in ("data", *lan_slots.SLOTS):
                await add_vm(db, settings, env, bluegreen[role], stored, role=role)
            await lan_slots.add(db, env.id, lan_slots.SLOTS)
            await db.execute(update(EnvironmentService).where(
                EnvironmentService.environment_id == env.id,
                EnvironmentService.service == "spaces")
                .values(host_ip=vms.static_ip(bluegreen["data"]["ip_cidr"])))
        elif spec is not None:
            await add_vm(db, settings, env, spec, stored)
    except vms.VmError as e:
        raise EnvError(e.code, **e.extra) from None
    await db.flush()
```

(initialize `spec = None` before the VM branch as today; import `update` from sqlalchemy.) Extend the docstring: "With `vm.slots: 2` (ESXi or Proxmox) the environment is LAN Blue/Green: a data VM and two app VMs (orange, purple), static addresses, Nginx Proxy Manager as the switch."

- [ ] **Step 6: The JSON**

In `serialize.py`, import `lan_slots`; in `environment_out`:

```python
    on_vm = targets.is_vm_target(env.target_id)
    machines = await vms.machines(db, env) if on_vm else []
    main = next((m for m in machines if m.role == vms.MAIN), None)
    lan = (lan_slots.public(env, await lan_slots.slots_of(db, env.id), machines)
           if lan_slots.is_bluegreen(env) else None)
```

and in the dict: `"vm": vms.public(main) if main is not None else None, "machines": [vms.public(m) for m in machines], "lan_slots": lan,`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b2 .venv/bin/pytest -q tests/test_deploy_lan_environments.py tests/test_deploy_environments_api.py tests/test_deploy_vms.py tests/test_deploy_esxi_vms.py tests/test_deploy_vm_api.py tests/test_deploy_esxi_vm_api.py`
Expected: PASS.

- [ ] **Step 8: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/vms.py src/sirdar_api/deploy/lan_slots.py src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/serialize.py tests/lan_helpers.py tests/test_deploy_lan_environments.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/vms.py sirdar/api/src/sirdar_api/deploy/lan_slots.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/tests/lan_helpers.py sirdar/api/tests/test_deploy_lan_environments.py sirdar/api/tests/test_deploy_environments_api.py
git commit -m "feat(sirdar): create a LAN Blue/Green environment

A data VM and two app VMs (static, distinct addresses), two vm_slots,
spaces on the data VM and every other service on orange; NPM required.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b2
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b2_source
```

---

### Task 3: Step 0 on three VMs

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/provision.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/esxi_provision.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/vmsteps.py`
- Create: `sirdar/api/tests/test_deploy_lan_provision.py`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `VmState.role` and `EsxiVmState.role` (from the row).
  - `VmContext` / `EsxiVmContext` gain `services: tuple[str, ...] | None = None` (what `record_address` moves; `None` = every service) and `resolve: bool = True` (step 0 resolves the ref on this VM).
  - `provision.prepare(db, env, dep, settings, *, role="main", services=None, resolve=True)` and the same for `esxi_provision.prepare`; a missing row for that role raises today's `VmPrepareError`.
  - Every `set_vm`, `_set_vm`, `_claim_vmid`, `check_address`, `settle_address`, Terraform workdir and cloud-init call passes the context's role. `provision._set_vm(env_id, *, role="main", **values)` and `provision._claim_vmid(env_id, vmid, *, role="main")` keep their positional `env_id` (tests call them).
  - `vmsteps.LanContext(env_id, machines: tuple[context, ...])` with `secret_values`; `vmsteps.prepare` returns one for a Blue/Green environment: `provision` → (data VM: `services=("spaces",)`, `resolve=False`; then the deployment's slot: `services=()`, `resolve=True`), `destroy` → every VM that has a row, purple, orange, data (each `services=()`, `resolve=False`). `vm_restore` on Blue/Green → `VmPrepareError`.
  - `HostProvisioner.run` runs each machine of a `LanContext` in order (a heading line per VM), returns the slot run's `sha`, never a VM snapshot.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_lan_provision.py`:

```python
"""Step 0 and Destroy VM on a LAN Blue/Green environment: the data VM, then
the slot's VM; Delete removes all three. FakeEsxi boots every VM at
127.0.0.1, where the tests' SSH server answers, so the end-to-end build runs
one VM (the data VM, moved to 127.0.0.1); the order and dispatch are checked
with a recording provisioner."""

import pytest
from sqlalchemy import select, update

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, EnvironmentService, EsxiVm
from sirdar_api.deploy import vmsteps, vms
from sirdar_api.deploy.vmcommon import VmOutcome, VmPrepareError

from .deploy_factories import secrets_key, trust_fake  # noqa: F401
from .esxi_helpers import esxi_fake  # noqa: F401
from .integration_helpers import configure, configure_esxi
from .lan_helpers import make_bluegreen_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_esxi_provision import provisioner
from .test_deploy_pipeline import SHA


@pytest.fixture
async def lan(db, secrets_key, ssh_server, monkeypatch):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)

    async def free(*args, **kwargs) -> bool:
        return False

    monkeypatch.setattr(vms, "address_in_use", free)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    return await make_bluegreen_environment(db, host_key=ssh_server.host_key)


async def _dep(db, env, mode="update", slot="orange") -> Deployment:
    dep = Deployment(environment_id=env.id, mode=mode, git_ref="main", sha="",
                     status="running", vm=True, bluegreen=True, slot=slot)
    db.add(dep)
    await db.commit()
    return dep


class Recorder:
    """A host provisioner that records (step, role) and resolves on app VMs."""

    def __init__(self):
        self.seen: list[tuple[str, str]] = []

    async def run(self, step, ctx, out) -> VmOutcome:
        self.seen.append((step, ctx.vm.role))
        return VmOutcome(sha=SHA if ctx.resolve else None)


async def test_prepare_names_the_data_vm_then_the_slot(db, lan):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan), get_settings())
    assert isinstance(ctx, vmsteps.LanContext)
    assert [(m.vm.role, m.services, m.resolve) for m in ctx.machines] == [
        ("data", ("spaces",), False), ("orange", (), True)]
    assert all(v in ctx.secret_values for m in ctx.machines for v in m.secret_values)


async def test_destroy_names_every_vm_apps_first(db, lan):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan, mode="teardown", slot=None),
                                get_settings())
    assert [m.vm.role for m in ctx.machines] == ["purple", "orange", "data"]


async def test_the_host_provisioner_runs_each_vm_in_order(db, lan):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan, slot="purple"), get_settings())
    recorder, lines = Recorder(), []
    outcome = await vmsteps.HostProvisioner(proxmox=recorder, esxi=recorder).run(
        "provision", ctx, lines.append)
    assert recorder.seen == [("provision", "data"), ("provision", "purple")]
    assert outcome == VmOutcome(sha=SHA)                 # the slot's; never a VM snapshot
    assert lines[0] == "— ss-lan9-data —\n"


async def test_the_data_vm_is_built_and_moves_only_spaces(db, lan, esxi_fake):
    await db.execute(update(EsxiVm).where(EsxiVm.environment_id == lan.id,
                                          EsxiVm.role == "data").values(ip_cidr="127.0.0.1/8"))
    await db.execute(update(EnvironmentService).where(
        EnvironmentService.environment_id == lan.id).values(host_ip="0.0.0.0"))
    await db.commit()
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan), get_settings())
    outcome = await provisioner().run("provision", ctx.machines[0], lambda _: None)
    assert outcome.sha is None                           # the data VM resolves nothing
    rows = {r.role: r for r in await db.scalars(
        select(EsxiVm).where(EsxiVm.environment_id == lan.id)
        .execution_options(populate_existing=True))}
    assert (rows["data"].created, rows["data"].ip) == (True, "127.0.0.1")
    assert rows["data"].host_key_private_enc is None     # delivered, then scrubbed
    assert not rows["orange"].created and rows["orange"].moref is None
    hosts = dict((await db.execute(select(EnvironmentService.service,
                                          EnvironmentService.host_ip))).all())
    assert hosts["spaces"] == "127.0.0.1" and hosts["api"] == "0.0.0.0"
    assert [v.name for v in esxi_fake.vms.values() if v.name.startswith("ss-")] == [
        "ss-lan9-data"]


async def test_vm_restore_is_refused(db, lan):
    with pytest.raises(VmPrepareError):
        await vmsteps.prepare(db, lan, await _dep(db, lan, mode="vm_restore"), get_settings())
```

(`provisioner()` is `test_deploy_esxi_provision.py`'s builder: no-op sleep, a probe that finds nothing, a resolver answering SHA.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b3 .venv/bin/pytest -q tests/test_deploy_lan_provision.py`
Expected: FAIL (`module 'sirdar_api.deploy.vmsteps' has no attribute 'LanContext'`).

- [ ] **Step 3: Proxmox**

In `provision.py`:

- `VmState`: add `role: str = vms.MAIN` (last field); `of(cls, row)` passes `role=row.role`.
- `VmContext`: add `services: tuple[str, ...] | None = None` and `resolve: bool = True` after `vm_snapshot`.
- `prepare(db, env, dep, settings, *, role: str = vms.MAIN, services=None, resolve: bool = True)`: `row = await vms.get(db, env.id, role)`; build the context with `services=services, resolve=resolve`.
- `_set_vm(env_id, *, role: str = vms.MAIN, **values)` → `await vmcommon.set_vm(ProxmoxVm, env_id, role=role, **values)`; `_claim_vmid(env_id, vmid, *, role=vms.MAIN)` passes `role`.
- In `ProxmoxProvisioner`, every `_set_vm(ctx.env_id, …)` becomes `_set_vm(ctx.env_id, role=ctx.vm.role, …)`, `_claim_vmid(ctx.env_id, candidate)` → `_claim_vmid(ctx.env_id, candidate, role=ctx.vm.role)`, `vmcommon.check_address(...)` gains `role=ctx.vm.role`, `_settle_address`'s `vmcommon.settle_address(...)` gains `role=ctx.vm.role, services=ctx.services`, `_workdir`'s `terraform.prepare_workdir(..., px.tls_cert_pem)` gains `ctx.vm.role` (positional, after `ca_pem`), `_destroy`'s `terraform.workdir(self._settings, ctx.env_id)` and `terraform.remove_workdir(self._settings, ctx.env_id)` gain `ctx.vm.role`.
- In `_provision`, the ref: `sha = None if ctx.sha or not ctx.resolve else await vmcommon.resolve_ref(self._settings, self._resolve, env_id=ctx.env_id, git_ref=ctx.git_ref, repo_url=ctx.repo_url, out=out, slot=ctx.vm.role if ctx.vm.role in vms.APP_SLOTS else None)`.

- [ ] **Step 4: ESXi**

In `esxi_provision.py` the same pattern:

- `EsxiVmState.role: str = vms.MAIN` (before `host_key_pending`), set in `of`.
- `EsxiVmContext` gains `services` and `resolve`; `prepare(..., *, role=vms.MAIN, services=None, resolve=True)` reads `vms.get_for(db, env, role)`.
- Every `vmcommon.set_vm(EsxiVm, ctx.env_id, …)` gains `role=ctx.vm.role` (in `_record`, the half-built reset in `_provision`, `_scrub`, and `created=True`); `vmcommon.check_address(...)` and both `vmcommon.settle_address(...)` calls gain `role=ctx.vm.role` (and `services=ctx.services` for `settle_address`).
- `_create`'s `cloudinit.metadata(...)` gains `role=ctx.vm.role`.
- `_annotation(ctx)`: `f"sirdar:{ctx.env_id}\nBuilt by Sirdar for the environment {ctx.env_name} ({ctx.vm.name}). …"`.
- The ref: `sha = None if ctx.sha or not ctx.resolve else await vmcommon.resolve_ref(..., slot=ctx.vm.role if ctx.vm.role in vms.APP_SLOTS else None)`.

(The ESXi ownership marker stays the environment id: all three VMs carry it, and identity is the recorded instance UUID plus the VM's own name plus the marker, so they never mix.)

- [ ] **Step 5: `vmsteps`**

In `vmsteps.py`:

```python
from dataclasses import dataclass

from sirdar_api.deploy import do_provision, esxi_provision, lan_slots, provision, targets, vms


@dataclass(frozen=True)
class LanContext:
    """A LAN Blue/Green environment's VM step: one context per VM, in order
    (step 0: the data VM, then the deployment's slot; Destroy: purple,
    orange, data)."""
    env_id: object
    machines: tuple

    @property
    def secret_values(self) -> list[str]:
        return [v for m in self.machines for v in m.secret_values]


async def _lan_prepare(db, env, dep, settings) -> LanContext:
    host_prepare = (esxi_provision.prepare if env.target_id == targets.ESXI_TARGET
                    else provision.prepare)
    if dep.mode == "vm_restore":
        raise VmPrepareError("A Blue/Green environment has no VM snapshots to restore. "
                             "Activate the other server to go back.")
    if dep.mode == "teardown":
        present = {m.role for m in await vms.machines(db, env)}
        order = [r for r in ("purple", "orange", vms.DATA) if r in present]
        machines = [await host_prepare(db, env, dep, settings, role=r, services=(),
                                       resolve=False) for r in order]
    else:
        if dep.slot not in lan_slots.SLOTS:
            raise VmPrepareError("This deployment names no server to build.")
        machines = [await host_prepare(db, env, dep, settings, role=vms.DATA,
                                       services=("spaces",), resolve=False),
                    await host_prepare(db, env, dep, settings, role=dep.slot, services=(),
                                       resolve=True)]
    return LanContext(env_id=env.id, machines=tuple(machines))
```

`prepare(...)`: before the ESXi/Proxmox branches, `if lan_slots.is_bluegreen(env): return await _lan_prepare(db, env, dep, settings)`. `VmContext` alias gains `| LanContext`.

`HostProvisioner.run`: first,

```python
        if isinstance(ctx, LanContext):
            sha = None
            for machine in ctx.machines:
                out(f"— {machine.vm.name} —\n")
                got = await self.run(step, machine, out)
                sha = got.sha or sha
            return VmOutcome(sha=sha)
```

Also take a VM snapshot never on Blue/Green: the routes send `take_vm_snapshot=False` (Task 7), and every machine's context carries it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b3 .venv/bin/pytest -q tests/test_deploy_lan_provision.py tests/test_deploy_provision.py tests/test_deploy_esxi_provision.py tests/test_deploy_pipeline_vm.py tests/test_deploy_vm_steps.py`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/provision.py src/sirdar_api/deploy/esxi_provision.py src/sirdar_api/deploy/vmsteps.py tests/test_deploy_lan_provision.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/provision.py sirdar/api/src/sirdar_api/deploy/esxi_provision.py sirdar/api/src/sirdar_api/deploy/vmsteps.py sirdar/api/tests/test_deploy_lan_provision.py
git commit -m "feat(sirdar): step 0 builds the data VM and the slot's VM

Both provisioners act on a role; LanContext runs them per VM (Destroy:
purple, orange, data). The data VM moves only spaces, the app VMs nothing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b3
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b3_source
```

---

### Task 4: The data VM's stack and the playbooks

**Files:**
- Modify: `deploy/stack/ss-stack` (`STACK_DB_SSLMODE`; `db/lan.yml` and `pg_hba.conf` when `STACK_DB_PUBLISH=1`)
- Create: `deploy/stack/db/lan.yml`
- Modify: `deploy/stack/env.example` (the new keys, commented)
- Create: `sirdar/api/src/sirdar_api/deploy/ansible/data_vm.yml`, `ansible/tasks/docker.yml`
- Modify: `ansible/bootstrap.yml` (includes `tasks/docker.yml`), `ansible/dump.yml` (`data_new`), `ansible/slot_smoke.yml` (per-name port)
- Modify: `sirdar/api/pyproject.toml` (`"ansible/tasks/*.yml"` in package data)
- Modify: `sirdar/api/src/sirdar_api/deploy/envfile.py` (`STACK_DB_SSLMODE` in `EXTRA_KEYS`; `DataEnvConfig`, `render_data_env`)
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (the `data_vm` StepDef only; Task 6 owns the rest of the file)
- Modify: `deploy/tests/test_ss_stack.py`, `deploy/tests/test_stack_config.py`, `sirdar/api/tests/test_deploy_playbooks.py`, `sirdar/api/tests/test_deploy_envfile.py`

**Interfaces:**
- Produces:
  - `ss-stack`: `STACK_DB_SSLMODE` (default `require`; `disable` turns TLS off for the one-off client on an app VM that talks to a LAN data VM). `STACK_DB_PUBLISH=1` (a data VM): before `up` / `data` / `restore`, ss-stack writes `<env-dir>/pg_hba.conf` (mode 644) from `STACK_DB_ALLOW` (comma-separated IPv4) and adds `-f db/lan.yml` to every db-stack compose call, exporting `STACK_DB_HBA_FILE`.
  - `db/lan.yml`: Postgres with `listen_addresses=*`, `hba_file=/etc/ss/pg_hba.conf`, published on `${STACK_BIND_IP}:${STACK_DB_PORT:-5432}`.
  - `envfile.DataEnvConfig(name, domain, bind_ip, spaces_port, mailpit_port, keep_dumps, spaces_bucket, db_port, allow: tuple[str, ...], secrets)` and `envfile.render_data_env(cfg) -> str` (keys: `STACK_ENV, STACK_DOMAIN, STACK_IMAGE_TAG=data, STACK_BIND_IP, STACK_SPACES_PORT, STACK_MAILPIT_PORT, STACK_KEEP_DUMPS, POSTGRES_PASSWORD, SPACES_SECRET_KEY, SS_SPACES_BUCKET, STACK_DB_PUBLISH=1, STACK_DB_PORT, STACK_DB_ALLOW`); `envfile.DATA_KEYS`.
  - `data_vm.yml` vars: `env_name`, `env_dir`, `repo_url`, `sha`, `ss_stack`, `data_env_b64`, `db_clients` (list), `spaces_clients` (list), `db_port`, `spaces_port`, `mailpit_port`.
  - `dump.yml`: with `external_data` and `data_new` true (a brand-new data VM), no dump (`dump_path` empty).
  - `slot_smoke.yml`: each `public_hosts` item may carry `port` (LAN app VM); else `slot_port` (default 80, Caddy).

- [ ] **Step 1: Write the failing tests**

Append to `deploy/tests/test_ss_stack.py`:

```python
LAN_DATA = ("STACK_DB_PUBLISH=1\nSTACK_DB_PORT=5432\n"
            "STACK_DB_ALLOW=10.10.48.48,10.10.48.49\n")


def test_a_data_vm_publishes_postgres_with_its_hba(env_dir: Path, fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    out = run(fake, "data", str(env_dir))
    assert out.returncode == 0, out.stderr
    lan = f"-f {STACK_DIR}/db/lan.yml"
    db_calls = [c for c in calls(fake) if "/db/compose.yml" in c]
    assert db_calls and all(lan in c for c in db_calls)
    hba = (env_dir / "pg_hba.conf").read_text()
    assert "host serversherpa serversherpa 10.10.48.48/32 scram-sha-256" in hba
    assert "host serversherpa serversherpa 10.10.48.49/32 scram-sha-256" in hba
    assert "local all all trust" in hba and "0.0.0.0/0" not in hba
    assert oct((env_dir / "pg_hba.conf").stat().st_mode & 0o777) == "0o644"


@pytest.mark.parametrize("allow", ["", "10.10.48.48,not-an-ip", "10.10.48.48;rm -rf /"])
def test_a_bad_allow_list_is_refused(env_dir: Path, fake: dict[str, str], allow: str) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(f"STACK_DB_PUBLISH=1\nSTACK_DB_ALLOW={allow}\n")
    out = run(fake, "data", str(env_dir))
    assert out.returncode != 0
    assert "STACK_DB_ALLOW" in out.stderr
    assert not any("/db/compose.yml" in c for c in calls(fake))


def test_an_app_vm_on_a_lan_data_vm_talks_without_tls(env_dir: Path,
                                                      fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write("STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=10.10.48.47\nSTACK_DB_PORT=5432\n"
                "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n"
                "STACK_DB_SSLMODE=disable\n")
    out = run(fake, "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    dump = next(c for c in calls(fake) if "pg_dump" in c)
    assert "-e PGSSLMODE=disable" in dump and "PGSSLMODE=require" not in dump
    assert "-e PGHOST=10.10.48.47" in dump


def test_the_managed_database_still_requires_tls(env_dir: Path, fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write("STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=db.internal\nSTACK_DB_PORT=25060\n"
                "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n")
    run(fake, "dump", str(env_dir))
    assert "-e PGSSLMODE=require" in next(c for c in calls(fake) if "pg_dump" in c)
```

Append to `deploy/tests/test_stack_config.py`:

```python
def test_the_lan_override_publishes_postgres_with_the_hba_file(tmp_path) -> None:
    hba = tmp_path / "pg_hba.conf"
    hba.write_text("local all all trust\n")
    env = ENV_EXAMPLE.read_text() + "STACK_DB_PUBLISH=1\nSTACK_DB_PORT=5432\n"
    env_file = tmp_path / ".env"
    env_file.write_text(env)
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(STACK_DIR / "db/compose.yml"),
         "-f", str(STACK_DIR / "db/lan.yml"), "config", "--format", "json"],
        capture_output=True, text=True, env={**os.environ, "STACK_DB_HBA_FILE": str(hba)})
    assert out.returncode == 0, out.stderr
    pg = json.loads(out.stdout)["services"]["postgres"]
    assert published(pg) == [5432]
    assert pg["command"] == ["postgres", "-c", "listen_addresses=*", "-c",
                             "hba_file=/etc/ss/pg_hba.conf"]
    assert any(v["target"] == "/etc/ss/pg_hba.conf" and v.get("read_only") for v in pg["volumes"])
```

(add `import os` at the top if missing; `test_postgres_is_16_and_unpublished` keeps checking the plain file.)

Append to `sirdar/api/tests/test_deploy_envfile.py`:

```python
def test_the_data_vm_env_has_only_the_data_secrets():
    secrets = {k: f"{k.lower()}-value" for k in envfile.REQUIRED_SECRETS}
    text = envfile.render_data_env(envfile.DataEnvConfig(
        name="lan9", domain="lan9.serversherpa.com", bind_ip="0.0.0.0", spaces_port=9000,
        mailpit_port=8025, keep_dumps=5, spaces_bucket="serversherpa", db_port=5432,
        allow=("10.10.48.48", "10.10.48.49"), secrets=secrets))
    values = envfile.parse_env(text)
    assert list(values) == list(envfile.DATA_KEYS)
    assert (values["STACK_DB_PUBLISH"], values["STACK_DB_ALLOW"]) == (
        "1", "10.10.48.48,10.10.48.49")
    assert values["POSTGRES_PASSWORD"] == "postgres_password-value"
    for key in ("SS_JWT_SECRET", "SS_PASSWORD_PEPPER", "SS_TOTP_ENCRYPTION_KEY",
                "SS_WIKI_SERVICE_TOKEN"):
        assert key not in values and secrets[key] not in text


def test_the_data_vm_env_refuses_a_bad_address():
    with pytest.raises(envfile.RenderError):
        envfile.render_data_env(envfile.DataEnvConfig(
            name="lan9", domain="lan9.serversherpa.com", bind_ip="0.0.0.0", spaces_port=9000,
            mailpit_port=8025, keep_dumps=5, spaces_bucket="serversherpa", db_port=5432,
            allow=("10.10.48.48\nX=1",),
            secrets={k: "v" for k in envfile.REQUIRED_SECRETS}))


def test_stack_db_sslmode_is_an_extra_key():
    assert "STACK_DB_SSLMODE" in envfile.EXTRA_KEYS
```

In `sirdar/api/tests/test_deploy_playbooks.py`, append (they use the module's `_target`, `_play`, `_common`, `_Answer`):

```python
def test_slot_smoke_uses_each_names_port(tmp_path):
    _Answer.status, _Answer.seen = 200, []
    server = HTTPServer(("127.0.0.1", 0), _Answer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        env_dir, env = _target(tmp_path)
        hosts = [{"service": "api", "hostname": "api.lan9.serversherpa.com", "path": "/healthz",
                  "port": server.server_port}]
        result, _ = _play(tmp_path, "slot_smoke.yml", {
            **_common(env_dir), "public_hosts": hosts, "slot_port": 1,
            "slot_smoke_retries": 0, "slot_smoke_delay": 0}, env)
    finally:
        server.shutdown()
    assert result.returncode == 0, result.stdout + result.stderr
    assert ("api.lan9.serversherpa.com", "/healthz", "https") in _Answer.seen


def test_dump_skips_a_brand_new_data_vm(tmp_path):
    env_dir, env = _target(tmp_path)
    _external(env_dir)
    result, calls = _play(tmp_path, "dump.yml", {**_common(env_dir), "external_data": True,
                                                "data_new": True, "dump_required": False}, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not any("pg_dump" in c for c in calls)


def test_bootstrap_and_the_data_vm_share_the_docker_tasks():
    _, tasks = _tasks("bootstrap.yml")
    assert any(t.get("ansible.builtin.include_tasks") == "tasks/docker.yml" for t in tasks)
    _, tasks = _tasks("data_vm.yml")
    assert any(t.get("ansible.builtin.include_tasks") == "tasks/docker.yml" for t in tasks)
    text = (PLAYBOOK_DIR / "data_vm.yml").read_text()
    assert "--ctorigdstport" in text and "DOCKER-USER" in text and "PartOf=docker.service" in text


def test_the_docker_tasks_ship_with_the_package():
    folder = resources.files("sirdar_api.deploy").joinpath("ansible").joinpath("tasks")
    assert folder.joinpath("docker.yml").is_file()


def test_data_vm_playbook_writes_its_env_and_starts_the_data_stacks(tmp_path):
    env_dir, env = _target(tmp_path)
    data_env = "STACK_ENV=e2e\nPOSTGRES_PASSWORD=0123abcd\n"
    result, calls = _play(tmp_path, "data_vm.yml", {
        **_common(env_dir), "data_env_b64": base64.b64encode(data_env.encode()).decode(),
        "db_clients": ["10.10.48.48", "10.10.48.49"],
        "spaces_clients": ["10.10.48.48", "10.10.48.49", "10.10.48.6"],
        "db_port": 5432, "spaces_port": 9000, "mailpit_port": 8025,
        "data_vm_test_mode": True}, env)
    out = result.stdout + result.stderr
    assert result.returncode == 0, out
    assert (env_dir / ".env").read_text() == data_env
    assert "0123abcd" not in out
    rules = (tmp_path / "sirdar-data-firewall").read_text()
    assert "-s 10.10.48.48 -m conntrack --ctorigdstport 5432 -j RETURN" in rules
    assert "-s 10.10.48.6 -m conntrack --ctorigdstport 9000 -j RETURN" in rules
    assert "-s 10.10.48.6 -m conntrack --ctorigdstport 5432" not in rules
    assert rules.rstrip().endswith("--ctorigdstport 8025 -j DROP")
```

`data_vm_test_mode` makes the playbook skip the parts a test machine can't run (installing Docker, git, systemd, and the firewall's root paths) and write the firewall script to `{{ env_dir }}/../sirdar-data-firewall` instead — exactly as `teardown.yml`'s test root is handled (read its `test_root` logic first and follow it: the test mode must never reach a real run; add a test like `test_the_test_root_never_reaches_a_real_run` for `data_vm_test_mode`, asserting Sirdar's pipeline never sends that var).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b4 .venv/bin/pytest -q tests/test_deploy_envfile.py tests/test_deploy_playbooks.py` and, from the worktree root, `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests`
Expected: FAIL (no `render_data_env`, no `data_vm.yml`, `db/lan.yml` missing, no TLS switch).

- [ ] **Step 3: `ss-stack`**

In `deploy/stack/ss-stack`:

- the header gains, after the DigitalOcean paragraph: `# With STACK_DB_PUBLISH=1 (a LAN Blue/Green data VM) the db stack listens on # the LAN for STACK_DB_ALLOW's addresses only (pg_hba.conf, written here). # STACK_DB_SSLMODE=disable: the external database is a LAN data VM (no TLS).`
- after `caddy()`:

```bash
lan_db() { [[ $(env_value STACK_DB_PUBLISH) == 1 ]]; }
HBA_FILE="$env_dir/pg_hba.conf"

# pg_hba.conf for a data VM: the local socket (ss-stack dump, the health
# check), localhost, and the app servers in STACK_DB_ALLOW; nobody else.
write_hba() {
  local allow ip
  allow=$(env_value STACK_DB_ALLOW)
  [[ -n $allow ]] || die "STACK_DB_ALLOW must list the app servers' IPv4 addresses"
  {
    echo "# Written by ss-stack from STACK_DB_ALLOW: edits are replaced."
    echo "local all all trust"
    echo "host all all 127.0.0.1/32 scram-sha-256"
    IFS=, read -ra ips <<<"$allow"
    for ip in "${ips[@]}"; do
      [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] \
        || die "STACK_DB_ALLOW has '$ip', not an IPv4 address"
      echo "host serversherpa serversherpa $ip/32 scram-sha-256"
    done
  } > "$HBA_FILE.tmp"
  chmod 644 "$HBA_FILE.tmp"          # the container's postgres user reads it
  mv "$HBA_FILE.tmp" "$HBA_FILE"
  export STACK_DB_HBA_FILE="$HBA_FILE"
}
```

- `dc()`:

```bash
dc() {  # dc <stack> <compose args…>
  local stack=$1; shift
  local files=(-f "$STACK_DIR/$stack/compose.yml")
  # A data VM's database listens on the LAN (db/lan.yml).
  if [[ $stack == db ]] && lan_db; then files+=(-f "$STACK_DIR/db/lan.yml"); fi
  if [[ $stack == api ]] && caddy; then set -- --profile certs "$@"; fi
  docker compose --env-file "$env_file" "${files[@]}" "$@"
}
```

- `pg()`: replace `local tls=(-e PGSSLMODE=require)` with

```bash
  local mode tls
  mode=$(env_value STACK_DB_SSLMODE)
  mode=${mode:-require}
  [[ $mode == require || $mode == disable ]] || die "STACK_DB_SSLMODE must be require or disable"
  tls=(-e "PGSSLMODE=$mode")
```

  and only take the CA branch when `mode == require` (`if [[ $mode == require && -n $CA_FILE ]]; then …`).
- In `up)`, `data)` and `restore)`, right after `refuse_placeholders`: `if lan_db; then write_hba; fi`.
- In `down)`, `ps)`, `dump)`, `pgdump)` and `revision)`, before the first `dc db …`/`pg_local` call: `if lan_db; then export STACK_DB_HBA_FILE="$HBA_FILE"; fi` (Compose interpolates the override's `${STACK_DB_HBA_FILE:?}` even to stop the stack).

- [ ] **Step 4: `db/lan.yml` and `env.example`**

Create `deploy/stack/db/lan.yml`:

```yaml
# The db stack on a LAN Blue/Green data VM (STACK_DB_PUBLISH=1; ss-stack adds
# this file to db/compose.yml). Postgres listens on the LAN for the
# environment's app VMs only: ss-stack writes pg_hba.conf from STACK_DB_ALLOW,
# and Sirdar's firewall on the VM drops everyone else. No TLS on the LAN, as
# the local stacks have none.
services:
  postgres:
    command: ["postgres", "-c", "listen_addresses=*", "-c", "hba_file=/etc/ss/pg_hba.conf"]
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_DB_PORT:-5432}:5432"
    volumes:
      - ${STACK_DB_HBA_FILE:?ss-stack sets STACK_DB_HBA_FILE}:/etc/ss/pg_hba.conf:ro
```

Append to `deploy/stack/env.example`:

```
# ── LAN Blue/Green (Sirdar writes these; leave them out elsewhere) ──
# On the data VM:   STACK_DB_PUBLISH=1  STACK_DB_PORT=5432  STACK_DB_ALLOW=<app VM>,<app VM>
# On each app VM:   STACK_EXTERNAL_DATA=1 STACK_DB_HOST=<data VM> STACK_DB_PORT=5432
#                   STACK_DB_NAME=serversherpa STACK_DB_USER=serversherpa STACK_DB_SSLMODE=disable
#                   SS_DATABASE_URL= SS_DATABASE_SSL=disable
```

- [ ] **Step 5: `envfile`**

In `sirdar/api/src/sirdar_api/deploy/envfile.py`: add `"STACK_DB_SSLMODE"` to `EXTRA_KEYS` right after `"STACK_DB_USER"`. Then:

```python
# A LAN Blue/Green data VM's .env (deploy phase 8b): the data stacks only, so
# only the database and storage secrets (no JWT secret, pepper, TOTP key or
# wiki token), and the app VMs allowed to reach Postgres.
DATA_KEYS = ("STACK_ENV", "STACK_DOMAIN", "STACK_IMAGE_TAG", "STACK_BIND_IP",
             "STACK_SPACES_PORT", "STACK_MAILPIT_PORT", "STACK_KEEP_DUMPS",
             "POSTGRES_PASSWORD", "SPACES_SECRET_KEY", "SS_SPACES_BUCKET",
             "STACK_DB_PUBLISH", "STACK_DB_PORT", "STACK_DB_ALLOW")
_IPV4_RE = re.compile(r"[0-9]{1,3}(\.[0-9]{1,3}){3}")


@dataclass(frozen=True)
class DataEnvConfig:
    name: str
    domain: str
    bind_ip: str
    spaces_port: int
    mailpit_port: int
    keep_dumps: int
    spaces_bucket: str
    db_port: int
    allow: tuple[str, ...]
    secrets: dict[str, str] = field(repr=False)


def render_data_env(cfg: DataEnvConfig) -> str:
    missing = [k for k in ("POSTGRES_PASSWORD", "SPACES_SECRET_KEY") if not cfg.secrets.get(k)]
    if missing:
        raise RenderError(f"missing secrets: {', '.join(missing)}")
    if not cfg.allow or not all(_IPV4_RE.fullmatch(ip) for ip in cfg.allow):
        raise RenderError("STACK_DB_ALLOW must be IPv4 addresses")
    values = {
        "STACK_ENV": cfg.name, "STACK_DOMAIN": cfg.domain, "STACK_IMAGE_TAG": "data",
        "STACK_BIND_IP": cfg.bind_ip, "STACK_SPACES_PORT": str(cfg.spaces_port),
        "STACK_MAILPIT_PORT": str(cfg.mailpit_port), "STACK_KEEP_DUMPS": str(cfg.keep_dumps),
        "POSTGRES_PASSWORD": cfg.secrets["POSTGRES_PASSWORD"],
        "SPACES_SECRET_KEY": cfg.secrets["SPACES_SECRET_KEY"],
        "SS_SPACES_BUCKET": cfg.spaces_bucket, "STACK_DB_PUBLISH": "1",
        "STACK_DB_PORT": str(cfg.db_port), "STACK_DB_ALLOW": ",".join(cfg.allow),
    }
    for key, value in values.items():
        if unsafe_value(value) or value == PLACEHOLDER:
            raise RenderError(f"{key} can't be written")
    lines = ["# Written by Sirdar: edits here are replaced on the next deploy.",
             f"# Environment: {cfg.name} (data VM)", *(f"{k}={v}" for k, v in values.items())]
    return "\n".join(lines) + "\n"
```

- [ ] **Step 6: The playbooks**

Create `sirdar/api/src/sirdar_api/deploy/ansible/tasks/docker.yml` by **moving** bootstrap.yml's tasks from "Base packages" through "Docker answers without sudo" (everything except the metadata block) into it, unchanged; `bootstrap.yml` keeps its play header, then:

```yaml
  tasks:
    - name: Docker, git and the environment folder
      ansible.builtin.include_tasks: tasks/docker.yml

    # DigitalOcean: … (the metadata block, unchanged)
```

(the order changes only in that the metadata block now follows the docker tasks; it needs Docker's `DOCKER-USER` chain anyway). `bootstrap.yml` keeps `gather_facts: true` (the docker tasks use `ansible_facts['user_id']`).

`slot_smoke.yml`: the `url` becomes `"http://127.0.0.1:{{ item.port | default(slot_port | default(80)) }}{{ item.path }}"`; its header gains "On a LAN Blue/Green app VM each name carries its own port (no Caddy)."

`dump.yml`: the managed-dump task's `when` becomes

```yaml
      when:
        - external_data | default(false) | bool
        # a LAN Blue/Green data VM built by this very deploy has nothing to dump
        - not (data_new | default(false) | bool)
```

Create `sirdar/api/src/sirdar_api/deploy/ansible/data_vm.yml`:

```yaml
# Step 7 — Prepare data VM (LAN Blue/Green): the environment's data VM runs
# only the database and object storage, shared by both app VMs. Docker and
# the checkout (for deploy/stack), a data-only .env (no app secrets; no_log),
# a firewall that lets only the app VMs reach Postgres and only they and
# Nginx Proxy Manager reach object storage (published ports bypass ufw, so
# the rules sit in Docker's DOCKER-USER chain and come back with Docker),
# then ss-stack data (Postgres on the LAN through db/lan.yml, pg_hba.conf from
# STACK_DB_ALLOW). data_vm_test_mode is for the playbook tests only.
- name: Prepare data VM
  hosts: target
  gather_facts: true
  vars:
    test_mode: "{{ data_vm_test_mode | default(false) | bool }}"
    firewall_script: >-
      {{ (env_dir ~ '/../sirdar-data-firewall') if test_mode
         else '/usr/local/sbin/sirdar-data-firewall' }}
  tasks:
    - name: Docker, git and the environment folder
      ansible.builtin.include_tasks: tasks/docker.yml
      when: not test_mode

    - name: Check out the commit (the stack's files)
      ansible.builtin.git:
        repo: "{{ repo_url }}"
        dest: "{{ env_dir }}/repo"
        version: "{{ sha }}"
        force: false
      when: not test_mode

    - name: Backups folder
      ansible.builtin.file:
        path: "{{ env_dir }}/backups"
        state: directory
        mode: "0700"

    - name: Write .env
      ansible.builtin.copy:
        content: "{{ data_env_b64 | b64decode }}"
        dest: "{{ env_dir }}/.env"
        mode: "0600"
      no_log: true

    - name: The firewall's rules
      ansible.builtin.copy:
        dest: "{{ firewall_script }}"
        mode: "0755"
        content: |
          #!/bin/sh
          # Written by Sirdar for {{ env_name }}'s data VM: Postgres only from the
          # app VMs, object storage only from them and Nginx Proxy Manager.
          set -e
          iptables -N SIRDAR-DATA 2>/dev/null || iptables -F SIRDAR-DATA
          iptables -C DOCKER-USER -j SIRDAR-DATA 2>/dev/null || iptables -I DOCKER-USER -j SIRDAR-DATA
          iptables -A SIRDAR-DATA -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
          {% for ip in db_clients %}
          iptables -A SIRDAR-DATA -p tcp -s {{ ip }} -m conntrack --ctorigdstport {{ db_port }} -j RETURN
          {% endfor %}
          {% for ip in spaces_clients %}
          iptables -A SIRDAR-DATA -p tcp -s {{ ip }} -m conntrack --ctorigdstport {{ spaces_port }} -j RETURN
          {% endfor %}
          iptables -A SIRDAR-DATA -p tcp -m conntrack --ctorigdstport {{ db_port }} -j DROP
          iptables -A SIRDAR-DATA -p tcp -m conntrack --ctorigdstport {{ spaces_port }} -j DROP
          iptables -A SIRDAR-DATA -p tcp -m conntrack --ctorigdstport {{ mailpit_port }} -j DROP
      become: "{{ not test_mode }}"

    - name: The firewall's unit
      ansible.builtin.copy:
        dest: /etc/systemd/system/sirdar-data-firewall.service
        mode: "0644"
        content: |
          [Unit]
          Description=Only the app VMs reach this data VM's database and storage (Sirdar)
          After=docker.service
          Requires=docker.service
          PartOf=docker.service

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          ExecStart=/usr/local/sbin/sirdar-data-firewall

          [Install]
          WantedBy=docker.service
      become: true
      when: not test_mode

    - name: The firewall is on, and comes back with Docker
      ansible.builtin.systemd_service:
        name: sirdar-data-firewall
        enabled: true
        state: restarted
        daemon_reload: true
      become: true
      when: not test_mode

    - name: ss-stack data
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", data, "{{ env_dir }}"]
```

(`db_clients` and `spaces_clients` are IPv4 addresses Sirdar checked; the `firewall_script` path can't come from extravars in a real run: Task 6's pipeline never sends `data_vm_test_mode`, and a test proves it.)

In `sirdar/api/pyproject.toml`: `"sirdar_api.deploy" = ["ansible/*.yml", "ansible/tasks/*.yml"]`.

`test_every_playbook_belongs_to_a_step` globs only the top level, so `tasks/docker.yml` doesn't need a step; `data_vm.yml` does. Add its step here, in `steps.py`'s `STEPS` right after the `reset` line — `StepDef(7, "data_vm", "Prepare data VM", "data_vm.yml", 30 * 60),` — and in `test_deploy_playbooks.py`'s `test_plans` insert the extra `7` into the STEPS-number list (after the existing 7). Task 6 adds the plans and step 14 `lan_switch`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b4 .venv/bin/pytest -q tests/test_deploy_envfile.py tests/test_deploy_playbooks.py` and, from the worktree root, `bash -n deploy/stack/ss-stack && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests`
Expected: PASS.

- [ ] **Step 8: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/envfile.py src/sirdar_api/deploy/steps.py tests/test_deploy_envfile.py tests/test_deploy_playbooks.py
cd ../.. && git add deploy/stack/ss-stack deploy/stack/db/lan.yml deploy/stack/env.example deploy/tests/test_ss_stack.py deploy/tests/test_stack_config.py sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/ansible/data_vm.yml sirdar/api/src/sirdar_api/deploy/ansible/tasks/docker.yml sirdar/api/src/sirdar_api/deploy/ansible/bootstrap.yml sirdar/api/src/sirdar_api/deploy/ansible/dump.yml sirdar/api/src/sirdar_api/deploy/ansible/slot_smoke.yml sirdar/api/pyproject.toml sirdar/api/src/sirdar_api/deploy/envfile.py sirdar/api/tests/test_deploy_envfile.py sirdar/api/tests/test_deploy_playbooks.py
git commit -m "feat(sirdar): the data VM's stack, firewall and playbook

ss-stack publishes Postgres on a data VM with pg_hba.conf from
STACK_DB_ALLOW and talks to it without TLS from an app VM; data_vm.yml
writes a data-only .env and DOCKER-USER rules; the slot smoke test takes
a port per name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b4
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b4_source
```

---

### Task 5: Switch traffic on the LAN (`lan_switch`)

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/publish.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/lan_slots.py` (append `slot_ip`)
- Create: `sirdar/api/tests/test_deploy_lan_switch.py`

**Interfaces:**
- Consumes: Task 2 (`lan_slots`, VM rows with roles), `publish.ensure_proxy`, `publish.run_smoke`.
- Produces:
  - `PublishContext.slot: str | None = None` (the slot a Switch traffic moves to; the pipeline sets it, Task 6).
  - `publish.APP_SERVICES` (every service but `spaces`: they follow the live slot).
  - `async lan_slots.slot_ip(env_id, slot) -> str | None` (own session; the slot VM's recorded address).
  - `async publish.switch_lan(ctx, out, *, npm_transport, smoke_transport, sleep, now, backoff, attempts, delay) -> None`: point `APP_SERVICES`' `host_ip` at the slot's VM (own committed transaction), `ensure_proxy` (create or update; the forward host is the only thing that changes on an existing host), `run_smoke` through NPM; on any `StepFailed`/`NpmError`: the old addresses back, `ensure_proxy` with them (only when they differ), `StepFailed("<reason> Traffic stays where it was.")`; if putting back fails too, `StepFailed("<reason> Sirdar couldn't put the proxy hosts back (<reason 2>): check them in Nginx Proxy Manager.")`.
  - `HttpPublisher.run("lan_switch", ctx, out)`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_lan_switch.py`:

```python
"""Switch traffic on the LAN: every proxy host of the environment forwards
to the slot's VM, then the public names are checked through NPM; a failure
puts every proxy host back."""

from dataclasses import replace

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentService, EsxiVm
from sirdar_api.deploy import publish, vmcommon

from .deploy_factories import secrets_key  # noqa: F401
from .integration_helpers import configure, configure_esxi
from .lan_helpers import DATA, ORANGE, make_bluegreen_environment
from .publish_helpers import publish_fakes  # noqa: F401

PURPLE_IP = "10.10.48.49"


async def _no_sleep(_):
    return None


@pytest.fixture
async def lan(db, secrets_key):
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    env = await make_bluegreen_environment(db)
    await vmcommon.set_vm(EsxiVm, env.id, role="orange", ip=ORANGE, created=True)
    await vmcommon.set_vm(EsxiVm, env.id, role="purple", ip=PURPLE_IP, created=True)
    return env


def _publisher():
    return publish.HttpPublisher(sleep=_no_sleep, smoke_attempts=1, smoke_delay=0,
                                 cert_backoff=(0,))


async def _ctx(db, env, slot):
    return replace(await publish.prepare(db, env, get_settings()), slot=slot)


async def _hosts(db, env) -> dict[str, str]:
    return dict((await db.execute(select(EnvironmentService.service, EnvironmentService.host_ip)
                                  .where(EnvironmentService.environment_id == env.id)
                                  .execution_options(populate_existing=True))).all())


async def test_the_first_switch_creates_the_proxy_hosts(db, lan, publish_fakes):
    lines: list[str] = []
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lines.append)
    forwards = {h["domain_names"][0]: h["forward_host"] for h in publish_fakes.npm.hosts.values()}
    assert forwards["api.lan9.serversherpa.com"] == ORANGE
    assert forwards["spaces.lan9.serversherpa.com"] == DATA        # never switched
    assert "Traffic goes to orange" in "".join(lines)


async def test_a_switch_repoints_every_app_proxy_host(db, lan, publish_fakes):
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lambda _: None)
    await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    forwards = {h["domain_names"][0]: h["forward_host"] for h in publish_fakes.npm.hosts.values()}
    assert {d: ip for d, ip in forwards.items() if not d.startswith("spaces.")} == {
        d: PURPLE_IP for d in forwards if not d.startswith("spaces.")}
    hosts = await _hosts(db, lan)
    assert hosts["spaces"] == DATA and hosts["api"] == PURPLE_IP and hosts["mailpit"] == PURPLE_IP


async def test_a_failed_smoke_test_puts_everything_back(db, lan, publish_fakes):
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lambda _: None)
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    assert e.value.reason.endswith("Traffic stays where it was.")
    forwards = {h["forward_host"] for d, h in
                ((h["domain_names"][0], h) for h in publish_fakes.npm.hosts.values())
                if not d.startswith("spaces.")}
    assert forwards == {ORANGE}
    assert (await _hosts(db, lan))["api"] == ORANGE


async def test_a_slot_without_an_address_changes_nothing(db, lan, publish_fakes):
    await vmcommon.set_vm(EsxiVm, lan.id, role="purple", ip=None)
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    assert "purple VM has no address" in e.value.reason
    assert publish_fakes.npm.hosts == {}
```

(If `HttpPublisher`'s keyword for the certificate backoff differs, use the one in `publish.py`: `cert_backoff`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b5 .venv/bin/pytest -q tests/test_deploy_lan_switch.py`
Expected: FAIL (`PublishContext.__init__() got an unexpected keyword argument 'slot'` through `replace`).

- [ ] **Step 3: `lan_slots.slot_ip`**

Append to `lan_slots.py`:

```python
async def slot_ip(env_id, slot: str) -> str | None:
    """The slot VM's recorded address (own session)."""
    async with get_sessionmaker()() as s:
        env = await s.get(Environment, env_id)
        row = await vms.get_for(s, env, slot) if env is not None else None
        return row.ip if row is not None else None
```

- [ ] **Step 4: `switch_lan`**

In `publish.py`: add `slot: str | None = None` to `PublishContext` (after `cloud`); import `replace` from dataclasses, `update` from sqlalchemy, `EnvironmentService` from the models, and `envfile`, `lan_slots`. Then, before `class HttpPublisher`:

```python
# Switch traffic on the LAN (deploy phase 8b): these follow the live app VM;
# spaces stays on the data VM.
APP_SERVICES = tuple(s for s in envfile.SERVICES if s != "spaces")


async def _point(env_id, addresses: dict[str, str]) -> None:
    async with get_sessionmaker()() as s:
        for service, ip in addresses.items():
            await s.execute(update(EnvironmentService).where(
                EnvironmentService.environment_id == env_id,
                EnvironmentService.service == service).values(host_ip=ip))
        await s.commit()


async def _addresses(env_id) -> dict[str, str]:
    async with get_sessionmaker()() as s:
        rows = await s.execute(select(EnvironmentService.service, EnvironmentService.host_ip)
                               .where(EnvironmentService.environment_id == env_id,
                                      EnvironmentService.service.in_(APP_SERVICES)))
        return dict(rows.all())


async def switch_lan(ctx: PublishContext, out: Output, *, npm_transport, smoke_transport,
                     sleep: Callable[[float], Awaitable[None]], now: datetime,
                     backoff: tuple[int, ...], attempts: int, delay: float) -> None:
    """Point the environment's proxy hosts at the slot's VM, check the public
    names through NPM, and put everything back if that fails."""
    if ctx.slot is None:
        raise StepFailed("This Switch traffic names no server.")
    ip = await lan_slots.slot_ip(ctx.env_id, ctx.slot)
    if not ip:
        raise StepFailed(f"The {ctx.slot} VM has no address yet. Deploy to it first.")
    before = await _addresses(ctx.env_id)
    moved = replace(ctx, services=tuple(replace(s, host_ip=ip) if s.service in APP_SERVICES
                                        else s for s in ctx.services))
    await _point(ctx.env_id, {s: ip for s in before})
    out(f"Switching the proxy hosts to {ctx.slot} ({ip}).\n")
    try:
        await ensure_proxy(moved, out, transport=npm_transport, sleep=sleep, now=now,
                           backoff=backoff)
        await run_smoke(moved, out, transport=smoke_transport, sleep=sleep, attempts=attempts,
                        delay=delay)
    except (StepFailed, NpmError) as e:
        out("Putting traffic back.\n")
        await _point(ctx.env_id, before)
        if any(addr != ip for addr in before.values()):
            back = replace(ctx, services=tuple(
                replace(s, host_ip=before.get(s.service, s.host_ip)) for s in ctx.services))
            try:
                await ensure_proxy(back, out, transport=npm_transport, sleep=sleep, now=now,
                                   backoff=backoff)
            except (StepFailed, NpmError) as again:
                raise StepFailed(f"{e.reason} Sirdar couldn't put the proxy hosts back "
                                 f"({again.reason}): check them in Nginx Proxy Manager.") \
                    from None
        raise StepFailed(f"{e.reason} Traffic stays where it was.") from None
    out(f"Traffic goes to {ctx.slot} ({ip}).\n")
```

In `HttpPublisher.run`'s `match`, add:

```python
                case "lan_switch":
                    await switch_lan(ctx, out, npm_transport=transports["npm"],
                                     smoke_transport=transports["smoke"], sleep=self._sleep,
                                     now=self._now(), backoff=self._backoff,
                                     attempts=self._smoke_attempts, delay=self._smoke_delay)
```

Extend the module docstring: "Step 14 Switch traffic of a LAN Blue/Green environment (lan_switch) points the proxy hosts at the slot's app VM, checks the public names, and puts them back on failure; spaces always forwards to the data VM."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b5 .venv/bin/pytest -q tests/test_deploy_lan_switch.py tests/test_deploy_publish.py tests/test_deploy_pipeline_publish.py`
Expected: PASS (use the publish test files that exist; `ls tests/test_deploy_*publish*`).

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/publish.py src/sirdar_api/deploy/lan_slots.py tests/test_deploy_lan_switch.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/publish.py sirdar/api/src/sirdar_api/deploy/lan_slots.py sirdar/api/tests/test_deploy_lan_switch.py
git commit -m "feat(sirdar): Switch traffic on the LAN repoints NPM's proxy hosts

Every app service's proxy host forwards to the slot's VM, the public
names are checked through NPM, and everything goes back on a failure.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b5
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b5_source
```

---

### Task 6: Blue/Green plans and the pipeline

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/lan_slots.py` (append `env_extra`, `data_vars`)
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py` (`deployment_summary` gains `bluegreen`)
- Modify: `sirdar/api/tests/test_deploy_playbooks.py` (plans)
- Create: `sirdar/api/tests/test_deploy_pipeline_lan.py`

**Interfaces:**
- Consumes: Tasks 1–5, 8a's `first_admin` flag.
- Produces:
  - Steps: `StepDef(14, "lan_switch", "Switch traffic", "", 15 * 60, "python")` (after `go_live`); step 7 `data_vm` exists already (Task 4).
  - `steps.plan_for(..., bluegreen=False)`; `bluegreen=True` needs `vm=True` and gives the plans in the Architecture section; `publish` adds `dns` to an Update; `first_admin` adds step 11 after `up`; a mode without a Blue/Green plan raises `ValueError`.
  - `pipeline.NotSupportedOnBlueGreen` (code `not_supported_on_bluegreen`) for `reset`, `restore_dump`, `rollback`, `vm_restore` on a Blue/Green environment.
  - `create_deployment(..., bluegreen=False)`: `ValueError` unless `bluegreen` matches `lan_slots.is_bluegreen(env)` (a publish job excepted: it runs the ordinary 12–14); slot refusals as DigitalOcean's (`slot_not_deployed`, `seed_not_allowed`) through `_check_slots`.
  - `takes_snapshot(dep)` also for a Blue/Green Delete; `recover_orphans` / `_close` mark its pending snapshot failed.
  - `_Context.data_target`, `_Context.target_for(key)`; `vars_for("data_vm")` = common + `lan_slots.data_vars(...)` + `data_env_b64`; `vars_for("dump")` gains `data_new`.
  - `async lan_slots.env_extra(db, env, secrets) -> tuple[dict, list[str]]` (the app VM's `.env` extras and the secret values among them) and `async lan_slots.data_vars(db, env, ports) -> dict` (`db_clients`, `spaces_clients`, `db_port`, `spaces_port`, `mailpit_port`) and `lan_slots.data_ip(env, machines) -> str`.
  - `deployment_summary` → `"bluegreen": dep.bluegreen`.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/test_deploy_playbooks.py` (update `test_publish_and_teardown_plans`' python-steps list to `["dns", "proxy", "smoke", "lan_switch", "unproxy", "undns"]`, and `test_plans`' STEPS-number list: Task 4 already added the `7` for `data_vm`; insert `14` for `lan_switch` after `go_live`'s 14 — the list becomes `[0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 9, 10, 11, 11, 12, 13, 13, 14, 14, 14, 15, 15, 16, 17, 18, 19]`):

```python
def _bg(mode, **kw):
    return [s.key for s in steps.plan_for(mode, vm=True, bluegreen=True, **kw)]


def test_lan_bluegreen_plans():
    build = ["provision", "preflight", "bootstrap", "fetch", "render", "build"]
    assert _bg("update") == [*build, "dump", "data_vm", "up", "slot_smoke"]
    assert _bg("update", go_live=True)[-1] == "lan_switch"
    assert _bg("update", restore=True, publish=True, go_live=True) == [
        *build, "dump", "data_vm", "restore", "up", "dns", "slot_smoke", "lan_switch"]
    assert _bg("update", first_admin=True, publish=True) == [
        *build, "dump", "data_vm", "up", "first_admin", "dns", "slot_smoke"]
    assert [s.number for s in steps.plan_for("update", vm=True, bluegreen=True, restore=True,
                                             publish=True, go_live=True)] == [
        0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13, 14]
    assert _bg("activate") == ["slot_smoke", "lan_switch"]
    assert _bg("snapshot") == ["preflight", "export"]
    assert _bg("teardown") == ["destroy", "unproxy", "undns"]
    assert _bg("teardown", snapshot=True) == ["export", "destroy", "unproxy", "undns"]
    assert steps.STEPS_BY_KEY["data_vm"].name == "Prepare data VM"
    assert steps.STEPS_BY_KEY["lan_switch"].runs == "python"
    for mode in ("reset", "restore_dump", "rollback", "vm_restore", "publish", "renew"):
        with pytest.raises(ValueError):
            steps.plan_for(mode, vm=True, bluegreen=True)
    with pytest.raises(ValueError):
        steps.plan_for("update", bluegreen=True)           # a VM plan only
    with pytest.raises(ValueError):
        steps.plan_for("update", vm=True, bluegreen=True, cloud=True)
```

Create `sirdar/api/tests/test_deploy_pipeline_lan.py`:

```python
"""A LAN Blue/Green environment's deployments through the pipeline (fakes):
the first deploy builds the data VM and orange and goes live; the next goes
to purple and waits; Activate switches; Delete snapshots then destroys."""

import base64

import pytest

from sirdar_api.db.models import Environment, VmSlot
from sirdar_api.deploy import envfile, pipeline, vms
from sirdar_api.deploy.vmcommon import VmOutcome

from .deploy_factories import (  # noqa: F401
    ENV_SECRETS,
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .integration_helpers import configure, configure_esxi
from .lan_helpers import DATA, ORANGE, PURPLE, lan_built, make_bluegreen_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_pipeline import SHA, _load

NEWER = "e1" * 20
FIRST = ["preflight", "bootstrap", "fetch", "render", "build", "dump", "data_vm", "up",
         "slot_smoke"]


@pytest.fixture
async def lan(db, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    # every run names its commit (a full SHA): step 0 resolves nothing
    fake_provisioner.outcomes["provision"] = VmOutcome()
    return await make_bluegreen_environment(db)


async def _run(db, env, *, mode="update", slot="orange", go_live=False, sha=SHA, **kw):
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=sha,
                                           actor_id=None, vm=True, bluegreen=True, slot=slot,
                                           go_live=go_live, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_the_first_deploy_builds_and_goes_live(db, lan, fake_runner, fake_publisher,
                                                     fake_provisioner):
    dep_id = await _run(db, lan, go_live=True)
    dep, steps, env = await _load(dep_id)
    assert (dep.status, dep.bluegreen, dep.slot) == ("succeeded", True, "orange")
    assert fake_provisioner.calls == ["provision"] and fake_runner.steps() == FIRST
    assert fake_publisher.calls == ["lan_switch"]
    assert fake_publisher.contexts[0].slot == "orange"
    assert (env.active_slot, env.current_sha, env.status) == ("orange", SHA, "ready")
    slot = await db.get(VmSlot, (env.id, "orange"), populate_existing=True)
    assert (slot.sha, slot.last_check_ok) == (SHA, True)

    data = next(r for r in fake_runner.requests if r.step == "data_vm")
    assert data.extravars["db_clients"] == [ORANGE, PURPLE]
    assert data.extravars["spaces_clients"] == [ORANGE, PURPLE, "10.0.0.2"]
    data_env = envfile.parse_env(base64.b64decode(data.extravars["data_env_b64"]).decode())
    assert data_env["STACK_DB_ALLOW"] == f"{ORANGE},{PURPLE}"
    assert ENV_SECRETS["SS_JWT_SECRET"] not in data_env.values()
    assert "data_vm_test_mode" not in data.extravars

    render = next(r for r in fake_runner.requests if r.step == "render")
    app_env = envfile.parse_env(base64.b64decode(render.extravars["env_file_b64"]).decode())
    assert (app_env["STACK_EXTERNAL_DATA"], app_env["STACK_DB_HOST"],
            app_env["STACK_DB_SSLMODE"], app_env["SS_DATABASE_SSL"]) == (
        "1", DATA, "disable", "disable")
    assert app_env["SS_DATABASE_URL"].endswith(f"@{DATA}:5432/serversherpa")

    dump = next(r for r in fake_runner.requests if r.step == "dump")
    assert (dump.extravars["external_data"], dump.extravars["data_new"]) == (True, True)
    smoke = next(r for r in fake_runner.requests if r.step == "slot_smoke")
    assert {h["service"] for h in smoke.extravars["public_hosts"]} == {
        "api", "portal", "kiosk", "wiki", "status"}
    assert all("port" in h for h in smoke.extravars["public_hosts"])


async def test_the_next_deploy_goes_to_purple_and_waits(db, lan, fake_runner, fake_publisher):
    await _run(db, lan, go_live=True)
    fake_runner.requests.clear()
    dep_id = await _run(db, lan, slot="purple", sha=NEWER)
    dep, steps, env = await _load(dep_id)
    assert [s.key for s in steps][-1] == "slot_smoke"
    assert fake_publisher.calls == ["lan_switch"]                 # only the first deploy's
    assert (env.active_slot, env.current_sha) == ("orange", SHA)
    purple = await db.get(VmSlot, (env.id, "purple"), populate_existing=True)
    assert purple.sha == NEWER
    assert next(r for r in fake_runner.requests if r.step == "dump").extravars["data_new"] is False


async def test_activate_switches_to_the_idle_slot(db, lan, fake_runner, fake_publisher):
    await _run(db, lan, go_live=True)
    await _run(db, lan, slot="purple", sha=NEWER)
    fake_runner.requests.clear()
    dep_id = await _run(db, lan, mode="activate", slot="purple", sha=NEWER)
    dep, steps, env = await _load(dep_id)
    assert [s.key for s in steps] == ["slot_smoke", "lan_switch"]
    assert (env.active_slot, env.current_sha) == ("purple", NEWER)


async def test_a_failed_switch_keeps_the_live_slot(db, lan, fake_runner, fake_publisher):
    await _run(db, lan, go_live=True)
    await _run(db, lan, slot="purple", sha=NEWER)
    fake_publisher.fail["lan_switch"] = "2 of 5 public URLs didn't answer. Traffic stays where it was."
    dep_id = await _run(db, lan, mode="activate", slot="purple", sha=NEWER)
    dep, _, env = await _load(dep_id)
    assert (dep.status, env.active_slot, env.status) == ("failed", "orange", "failed")


@pytest.mark.parametrize("mode", ["reset", "restore_dump", "rollback", "vm_restore"])
async def test_shared_data_modes_are_refused(db, lan, mode):
    with pytest.raises(pipeline.NotSupportedOnBlueGreen):
        await pipeline.create_deployment(db, lan, mode=mode, git_ref="main", sha=SHA,
                                         actor_id=None, vm=True, bluegreen=True)


async def test_the_flag_must_match_the_environment(db, lan):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, lan, mode="update", git_ref="main", sha=SHA,
                                         actor_id=None, vm=True)


async def test_activate_needs_a_deployed_slot(db, lan):
    from sirdar_api.deploy.do_envs import DoEnvError
    with pytest.raises(DoEnvError) as e:
        await pipeline.create_deployment(db, lan, mode="activate", git_ref="main", sha=SHA,
                                         actor_id=None, vm=True, bluegreen=True, slot="purple")
    assert e.value.code == "slot_not_deployed"


async def test_delete_destroys_all_three(db, lan, fake_runner, fake_publisher, fake_provisioner):
    await _run(db, lan, go_live=True)
    fake_provisioner.calls.clear()
    await _run(db, lan, mode="teardown", slot="orange")
    assert fake_provisioner.calls == ["destroy"]
    assert [m.vm.role for m in fake_provisioner.contexts[-1].machines] == [
        "purple", "orange", "data"]
    assert fake_publisher.calls[-2:] == ["unproxy", "undns"]
    assert await db.get(Environment, lan.id, populate_existing=True) is None
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b6 .venv/bin/pytest -q tests/test_deploy_playbooks.py -k "plans" tests/test_deploy_pipeline_lan.py`
Expected: FAIL (`plan_for() got an unexpected keyword argument 'bluegreen'`).

- [ ] **Step 3: Steps and plans**

In `steps.py`: add the `lan_switch` `StepDef` (Interfaces). Then:

```python
_BG_BUILD = ("provision", *_BUILD)
# (mode, restores or takes a snapshot) -> step keys of a LAN Blue/Green plan.
_BG_PLANS: dict[tuple[str, bool], tuple[str, ...]] = {
    ("update", False): (*_BG_BUILD, "dump", "data_vm", "up", "slot_smoke"),
    ("update", True): (*_BG_BUILD, "dump", "data_vm", "restore", "up", "slot_smoke"),
    ("snapshot", False): ("preflight", "export"),
    ("teardown", False): ("destroy", "unproxy", "undns"),
    ("teardown", True): ("export", "destroy", "unproxy", "undns"),
    ("activate", False): ("slot_smoke", "lan_switch"),
}


def _bg_plan(mode: str, *, restore: bool, publish: bool, go_live: bool,
             snapshot: bool) -> tuple[str, ...]:
    key = (mode, snapshot if mode == "teardown" else restore)
    if key not in _BG_PLANS:
        raise ValueError(f"no LAN Blue/Green plan for mode {mode!r}")
    keys = _BG_PLANS[key]
    if publish:
        if mode != "update":
            raise ValueError(f"mode {mode!r} doesn't publish")
        at = keys.index("slot_smoke")
        keys = (*keys[:at], "dns", *keys[at:])
    if go_live and mode != "activate":
        if mode != "update":
            raise ValueError(f"mode {mode!r} doesn't switch traffic")
        keys = (*keys, "lan_switch")
    return keys
```

`plan_for(..., bluegreen: bool = False)`: right after the `first_admin` guard,

```python
    if bluegreen:
        if not vm or cloud:
            raise ValueError("a LAN Blue/Green plan is a VM plan")
        if not smoke:
            raise ValueError("only Deactivate skips the slot smoke test")
        keys = _bg_plan(mode, restore=restore, publish=publish, go_live=go_live,
                        snapshot=snapshot)
        if first_admin:
            keys = _with_first_admin(keys)
        return [STEPS_BY_KEY[k] for k in keys]
```

and the non-cloud path's `if go_live or snapshot:` refusal stays for non-Blue/Green VM and SSH plans. The `mode == "activate"` refusal text becomes "only a DigitalOcean or LAN Blue/Green environment activates a slot". Docstring paragraph: "A LAN Blue/Green environment (vm and bluegreen) …" with the plans.

- [ ] **Step 4: `lan_slots.env_extra`, `data_vars`, `data_ip`**

Append to `lan_slots.py`:

```python
DB_PORT = 5432


def data_ip(machines: list) -> str | None:
    """The data VM's address: its static one (Blue/Green VMs are static)."""
    data = next((m for m in machines if m.role == vms.DATA), None)
    return vms.static_ip(data.ip_cidr) if data is not None else None


def app_ips(machines: list) -> list[str]:
    by_role = {m.role: m for m in machines}
    return [vms.static_ip(by_role[s].ip_cidr) for s in SLOTS if s in by_role]


async def env_extra(db: AsyncSession, env: Environment,
                    secrets: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """An app VM's .env keys on top of the usual ones: the data VM's database
    (no TLS on the LAN) and the secret values among them. Objects stay at
    https://spaces.<domain> through NPM, as on a single-server LAN host."""
    from urllib.parse import quote
    host = data_ip(await vms.machines(db, env))
    if host is None:
        raise do_envs.DoEnvError("do_not_ready", missing=["data VM"])
    password = quote(secrets["POSTGRES_PASSWORD"], safe="")
    url = f"postgresql+asyncpg://{do_envs.DB_USER}:{password}@{host}:{DB_PORT}/{do_envs.DB_NAME}"
    extra = {"STACK_EXTERNAL_DATA": "1", "STACK_DB_HOST": host, "STACK_DB_PORT": str(DB_PORT),
             "STACK_DB_NAME": do_envs.DB_NAME, "STACK_DB_USER": do_envs.DB_USER,
             "STACK_DB_SSLMODE": "disable", "SS_DATABASE_URL": url, "SS_DATABASE_SSL": "disable"}
    found = [url]
    if password != secrets["POSTGRES_PASSWORD"]:
        found.append(password)
    return extra, found


async def data_vars(db: AsyncSession, env: Environment, ports: dict[str, int]) -> dict:
    """data_vm.yml's firewall inputs: the app VMs reach Postgres; they and
    Nginx Proxy Manager (the environment's proxy) reach object storage."""
    apps = app_ips(await vms.machines(db, env))
    return {"db_clients": apps, "spaces_clients": [*apps, env.proxy_ip], "db_port": DB_PORT,
            "spaces_port": ports["spaces"], "mailpit_port": ports["mailpit"]}
```

- [ ] **Step 5: The pipeline**

In `pipeline.py` (import `lan_slots`, `VmSlot`):

```python
class NotSupportedOnBlueGreen(Exception):
    """Both app VMs share the data VM: the mode would change the live one too."""

    code = "not_supported_on_bluegreen"

    def __init__(self, mode: str):
        super().__init__(self.code)
        self.mode = mode
```

- `takes_snapshot(dep)`: `return dep.mode == "teardown" and (dep.cloud or dep.bluegreen) and dep.snapshot_id is not None`.
- `plan_of`: `bluegreen=dep.bluegreen`.
- `create_deployment(..., bluegreen: bool = False)`:

```python
    on_bg = lan_slots.is_bluegreen(env)
    if on_bg and mode in NOT_ON_DIGITALOCEAN:
        raise NotSupportedOnBlueGreen(mode)
    if bluegreen != (on_bg and mode != "publish"):
        raise ValueError("bluegreen must be set exactly for a LAN Blue/Green deployment")
```

  (after the DigitalOcean checks); `if cloud or bluegreen: await _check_slots(...)`; `taking_on_delete = mode == "teardown" and (cloud or bluegreen) and snapshot_id is not None`; `plan_for(..., bluegreen=bluegreen)`; `Deployment(..., bluegreen=bluegreen)`.
- `_check_cloud` → `_check_slots(db, env, *, mode, slot, snapshot_id, retry_of)`: read `rows = await do_envs.slots_of(db, env.id) if env.target_id == targets.DO_TARGET else await lan_slots.slots_of(db, env.id)`; `row = rows.get(slot)`; `deployed = sum(1 for r in rows.values() if r.sha)`; the rest unchanged (update the docstring: "DigitalOcean's and LAN Blue/Green's own refusals…"). Rename the call site.
- `recover_orphans` and `_close`: `and_(Deployment.mode == "teardown", or_(Deployment.cloud, Deployment.bluegreen))` / `(mode == "teardown" and (cloud or bluegreen))` (select `Deployment.bluegreen` in `_close`'s query).
- `_Context`: add `data_target: RunTarget | None = None` and `data_env_b64: str = field(default="", repr=False)`; `vars_for`:

```python
    def target_for(self, step_key: str) -> RunTarget | None:
        return self.data_target if step_key == "data_vm" else self.target

    def vars_for(self, step_key: str) -> dict:
        if step_key == "render":
            return {**self.common, "env_file_b64": self.env_file_b64}
        if step_key == "dump":
            return {**self.common, "dump_required": self.dump_required,
                    "restores_snapshot": self.restores_snapshot,
                    **self.step_vars.get("dump", {})}
        if step_key == "data_vm":
            return {**self.common, **self.step_vars.get("data_vm", {}),
                    "data_env_b64": self.data_env_b64}
        return {**self.common, **self.step_vars.get(step_key, {})}
```

  and `_run_step` uses `target=ctx.target_for(step.key)`.
- `_prepare`:
  - extract the "pinned + client key + RunTarget" block into a helper `async def _run_target(db, cfg) -> tuple[RunTarget, str | None]` (same refusals and copy) and call it for the slot's host;
  - `cfg = await vms.host_config(db, settings, env, slot=dep.slot if (dep.cloud or dep.bluegreen) else None)`; the "no address yet" copy for Blue/Green: f"This environment's {dep.slot} VM has no address yet. Retry from step 0 (Prepare VM)." (`dep.slot` or "VM");
  - `if dep.bluegreen and dep.mode == "update":` → `extra, lan_secrets = await lan_slots.env_extra(db, env, secrets)` (a `DoEnvError` becomes `PrepareError("This environment's data VM isn't recorded. Retry from step 0 (Prepare VM).")`), `extra_secrets += lan_secrets`; and the data VM: `data_cfg = await vms.host_config(db, settings, env, role=vms.DATA)` (None → `PrepareError("This environment's data VM has no address yet. Retry from step 0 (Prepare VM).")`), `data_target, data_key = await _run_target(db, data_cfg)`; `data_text = envfile.render_data_env(envfile.DataEnvConfig(name=env.name, domain=env.base_domain, bind_ip=env.bind_ip, spaces_port=ports["spaces"], mailpit_port=ports["mailpit"], keep_dumps=env.keep_dumps, spaces_bucket=env.spaces_bucket, db_port=lan_slots.DB_PORT, allow=tuple(lan_slots.app_ips(await vms.machines(db, env))), secrets=secrets))` (a `RenderError` → today's "couldn't write this environment's .env" `PrepareError`), `data_b64 = base64…`; `step_vars["data_vm"] = await lan_slots.data_vars(db, env, ports)`; add `data_b64` and `data_key` to the redactor list; pass `data_target=data_target, data_env_b64=data_b64` to `_Context`;
  - `step_vars["dump"] = {"data_new": dep.bluegreen and not await lan_slots.ran(db, env)}` when `dep.bluegreen`;
  - `common["external_data"] = dep.cloud or dep.bluegreen` (keep `block_metadata = dep.cloud`); `public_hosts` for Blue/Green:

```python
    if dep.bluegreen:
        hosts = [{"service": r.service, "hostname": r.hostname,
                  "path": smoke.PATHS.get(r.service, "/"), "port": r.port}
                 for r in rows_list if r.hostname and r.service != "spaces"]
```

    (read the service rows before `common` is built: move the existing `rows = …EnvironmentService…` query up and keep it as a list `rows_list`, building `ports` from it);
  - `_snapshot_vars`: for `dep.bluegreen`, `external = {"external_data": True, "spaces_endpoint": f"http://{lan_slots.data_ip(await vms.machines(db, env))}:{ports_spaces}", "spaces_key_id": "serversherpa", "spaces_region": "us-east-1"}` for `export`/`restore` (pass the spaces port in, or read the `spaces` service row there); the export's image is the slot's (`VmSlot.image_tag`), as on DigitalOcean (`row = await db.get(VmSlot, (env.id, slot))`).
- `_run`:
  - after `publishing = …`: `if publishing is not None and dep.bluegreen: publishing = replace(publishing, slot=dep.slot)`;
  - slot smoke: `if step.key == "slot_smoke" and dep.slot: await (do_envs.set_slot if dep.cloud else lan_slots.set_slot)(env.id, dep.slot, last_check_ok=…, last_check_at=_now())`;
  - `up`: `elif step.key == "up" and dep.slot and (dep.cloud or dep.bluegreen):` with `row = await db.get(DoSlot if dep.cloud else VmSlot, (env.id, dep.slot), populate_existing=True)`;
  - `elif step.key in ("go_live", "lan_switch"): env.active_slot = dep.slot`;
  - the end: `elif (dep.cloud or dep.bluegreen) and dep.mode in ("update", "activate"):` calls `(do_envs if dep.cloud else lan_slots).after_success(db, env, dep)`.

In `serialize.py`, `deployment_summary` gains `"bluegreen": dep.bluegreen,`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b6 .venv/bin/pytest -q tests/test_deploy_playbooks.py tests/test_deploy_pipeline_lan.py tests/test_deploy_pipeline.py tests/test_deploy_pipeline_vm.py tests/test_deploy_pipeline_do.py tests/test_deploy_pipeline_snapshots.py tests/test_deploy_pipeline_publish.py tests/test_deploy_pipeline_first_admin.py tests/test_deploy_do_activate_api.py`
Expected: PASS (deployment-summary key pins gain `"bluegreen": False`).

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/lan_slots.py src/sirdar_api/deploy/serialize.py tests/test_deploy_pipeline_lan.py tests/test_deploy_playbooks.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/lan_slots.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/tests/test_deploy_playbooks.py sirdar/api/tests/test_deploy_pipeline_lan.py
git commit -m "feat(sirdar): LAN Blue/Green plans in the pipeline

Update to the idle slot (data VM prepared, app VM on external data), the
slot smoke test per port, Switch traffic through NPM; Activate; Delete
with a snapshot; shared-data modes refused.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b6
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b6_source
```

---

### Task 7: Routes for LAN Blue/Green

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`update`: `auto_activate` for Blue/Green; `vm` resize refusal)
- Create: `sirdar/api/tests/test_deploy_lan_api.py`
- Modify: `sirdar/api/tests/test_deploy_do_activate_api.py` (`test_only_digitalocean_activates` expects `not_bluegreen_environment`)

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - `VmIn` gains `slots: int | None`, `purple_ip_cidr`, `data_ip_cidr` (`str | None`, max 50), `data: VmSizeIn | None` (`cores`, `memory_mb`, `disk_gb`), `auto_activate: bool | None`.
  - `POST …/deployments` on a Blue/Green environment: `update` → the idle slot (`do_envs.target_slot`), `go_live = do_envs.goes_live(env, slot)`, `vm=True, bluegreen=True`, never a VM snapshot (`take_vm_snapshot` → 422 `vm_snapshot_not_allowed`), seeds only while `not lan_slots.ran(...)`, needs NPM (and Cloudflare when publishing); `teardown` → like DigitalOcean's Delete (`snapshot` default yes once deployed; the slot `env.active_slot` or the first deployed slot with an address; `snapshot: false` allowed); `reset`, `restore_dump`, `vm_restore` → 409 `not_supported_on_bluegreen`; `publish` → the ordinary publish job.
  - `POST …/activate`: DigitalOcean as today; Blue/Green: 422 `slot_required` for `slot: null`, 422 `slot_invalid`, 409 `slot_already_active`, 409 `slot_not_deployed {slot}`, 409 `vm_not_ready` (no address), 409 `integration_not_configured {kinds}` (the VM host or NPM); any other environment → 409 `not_bluegreen_environment`. Audit `deploy.activate` with `slot`, `go_live`.
  - Retry keeps `bluegreen`; `rollback` on Blue/Green → 409 `not_supported_on_bluegreen`; `PATCH auto_activate` allowed on Blue/Green (`auto_activate_not_allowed` otherwise, as today); `PATCH vm` on Blue/Green → 409 `vm_resize_not_supported`.
  - `_launch(..., bluegreen=False)` and `pipeline.NotSupportedOnBlueGreen` → 409.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_lan_api.py`:

```python
"""LAN Blue/Green through the API: create, Update to the idle slot,
Activate, refusals, auto-activate, Delete with a snapshot."""

import uuid

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, Environment, VmSlot
from sirdar_api.deploy import pipeline, vms
from sirdar_api.deploy.vmcommon import VmOutcome

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
from .integration_helpers import configure, configure_esxi
from .lan_helpers import LAN_VM, lan_built
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_pipeline import SHA

URL = "/api/deploy/environments"
NEWER = "e1" * 20
NEW = {"mode": "new", "name": "lan9", "type": "custom", "target": "esxi",
       "proxy_ip": "10.0.0.2", "publish": False, "vm": LAN_VM}


@pytest.fixture
async def ready(db, secrets_key, ssh_server, monkeypatch, fake_provisioner, fake_runner,
                fake_publisher):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    monkeypatch.setattr(vms, "ALLOW_LOOPBACK", True)

    async def free(*args, **kwargs) -> bool:
        return False
    monkeypatch.setattr(vms, "address_in_use", free)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    fake_provisioner.outcomes["provision"] = VmOutcome()     # the API sends full SHAs


async def _wait(resp):
    if resp.status_code == 201:
        await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def _deployed(client, db, h) -> Environment:
    assert (await client.post(URL, headers=h, json=NEW)).status_code == 201
    first = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                          json={"git_ref": SHA}))
    assert (first.json()["slot"], first.json()["go_live"], first.json()["bluegreen"]) == (
        "orange", True, True)
    return await db.scalar(select(Environment).where(Environment.name == "lan9")
                           .execution_options(populate_existing=True))


async def test_create_update_activate(client, db, ready):
    h = await auth_headers(client, db)
    env = await _deployed(client, db, h)
    assert env.active_slot == "orange"
    second = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                           json={"git_ref": NEWER}))
    assert (second.json()["slot"], second.json()["go_live"]) == ("purple", False)
    resp = await _wait(await client.post(f"{URL}/lan9/activate", headers=h,
                                         json={"slot": "purple"}))
    assert resp.status_code == 201, resp.text
    assert [s["key"] for s in resp.json()["steps"]] == ["slot_smoke", "lan_switch"]
    env = await db.get(Environment, env.id, populate_existing=True)
    assert (env.active_slot, env.current_sha) == ("purple", NEWER)
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.activate"))).one()
    assert (audit["slot"], audit["go_live"]) == ("purple", True)


@pytest.mark.parametrize("body, expected", [
    ({"slot": "orange"}, (409, "slot_already_active")),
    ({"slot": "blue"}, (422, "slot_invalid")),
    ({"slot": None}, (422, "slot_required")),
    ({"slot": "purple"}, (409, "slot_not_deployed")),
])
async def test_activate_refusals(client, db, ready, body, expected):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    assert _code(await client.post(f"{URL}/lan9/activate", headers=h, json=body)) == expected


async def test_shared_data_modes_are_refused(client, db, ready):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    for body in ({"mode": "reset", "confirm_name": "lan9"},
                 {"mode": "restore_dump", "confirm_name": "lan9",
                  "backup": "20261007T120000Z.dump"},
                 {"mode": "vm_restore", "confirm_name": "lan9",
                  "vm_snapshot": "sirdar-20261007T120000Z"}):
        assert _code(await client.post(f"{URL}/lan9/deployments", headers=h, json=body)) == (
            409, "not_supported_on_bluegreen")
    assert _code(await client.post(f"{URL}/lan9/deployments", headers=h,
                                   json={"take_vm_snapshot": True})) == (
        422, "vm_snapshot_not_allowed")


async def test_auto_activate(client, db, ready):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    resp = await client.patch(f"{URL}/lan9", headers=h, json={"auto_activate": True})
    assert resp.status_code == 200 and resp.json()["auto_activate"] is True
    resp = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                         json={"git_ref": NEWER}))
    assert (resp.json()["slot"], resp.json()["go_live"]) == ("purple", True)
    assert _code(await client.patch(f"{URL}/lan9", headers=h, json={"vm": {"cores": 8}})) == (
        409, "vm_resize_not_supported")


async def test_a_single_server_environment_has_nothing_to_activate(client, db, ready):
    h = await auth_headers(client, db)
    single = {**NEW, "name": "solo", "vm": {k: v for k, v in LAN_VM.items()
                                            if k in ("ip_mode", "ip_cidr", "gateway")}}
    assert (await client.post(URL, headers=h, json=single)).status_code == 201
    assert _code(await client.post(f"{URL}/solo/activate", headers=h,
                                   json={"slot": "orange"})) == (409, "not_bluegreen_environment")


async def test_delete_takes_a_snapshot_then_removes_all_three(client, db, ready, snapshots_dir,
                                                              fake_runner, fake_provisioner):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    # the plan and the pending snapshot; the run itself is the pipeline tests' (Task 6)
    resp = await client.post(f"{URL}/lan9/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "lan9"})
    assert resp.status_code == 201, resp.text
    assert [s["key"] for s in resp.json()["steps"]] == ["export", "destroy", "unproxy", "undns"]
    assert resp.json()["snapshot"]["name"].startswith("lan9-before-delete-")


async def test_delete_without_a_snapshot(client, db, ready):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    await db.execute(update(VmSlot).values(sha=SHA))
    await db.commit()
    resp = await client.post(f"{URL}/lan9/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "lan9", "snapshot": False})
    assert resp.status_code == 201, resp.text
    assert [s["key"] for s in resp.json()["steps"]] == ["destroy", "unproxy", "undns"]
```

In `test_deploy_do_activate_api.py`, `test_only_digitalocean_activates` now expects `(409, "not_bluegreen_environment")`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b7 .venv/bin/pytest -q tests/test_deploy_lan_api.py`
Expected: FAIL (`vm` with `slots` is rejected by `VmIn`; deployments run the single-VM plan).

- [ ] **Step 3: Models and helpers**

In `routes/deploy.py` (import `lan_slots`):

```python
class VmSizeIn(BaseModel):
    cores: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None


class VmIn(BaseModel):
    """A VM environment's VM (mode "new", target "proxmox" or "esxi"). With
    slots 2 it is LAN Blue/Green: `ip_cidr` is orange's, plus purple's and
    the data VM's (static, one gateway)."""
    cores: int | None = None
    memory_mb: int | None = None
    disk_gb: int | None = None
    ip_mode: str = Field(max_length=10)
    ip_cidr: str | None = Field(default=None, max_length=50)
    gateway: str | None = Field(default=None, max_length=45)
    slots: int | None = None
    purple_ip_cidr: str | None = Field(default=None, max_length=50)
    data_ip_cidr: str | None = Field(default=None, max_length=50)
    data: VmSizeIn | None = None
    auto_activate: bool | None = None


def _on_bg(env: Environment) -> bool:
    return lan_slots.is_bluegreen(env)


def _not_on_bg() -> HTTPException:
    return HTTPException(status_code=409, detail={"code": pipeline.NotSupportedOnBlueGreen.code})


async def _require_npm(db) -> None:
    """Nginx Proxy Manager is a Blue/Green environment's switch."""
    if not await integrations.is_configured(db, "npm"):
        raise HTTPException(status_code=409, detail={"code": "integration_not_configured",
                                                     "kinds": ["npm"]})
```

`create_environment` passes `vm=body.vm.model_dump(exclude_none=True)` as today (the nested `data` dumps to a dict).

`_launch` gains `bluegreen: bool = False`, passes it to `create_deployment`, maps `pipeline.NotSupportedOnBlueGreen` to 409 like `NotSupportedOnDigitalOcean`, and audits `slot`/`go_live` when `cloud or bluegreen`.

- [ ] **Step 4: Update and Delete**

```python
async def _start_lan_update(db, env: Environment, body: DeploymentIn, request: Request,
                            actor: AuthContext) -> dict:
    """Update on LAN Blue/Green: to the idle slot; it goes live when
    do_envs.goes_live says so. Step 0 builds the data VM and the slot's VM
    and resolves the ref there. No VM snapshot: the other slot is the way back."""
    if not vault.is_configured(get_settings()):
        raise _refuse(400, "secrets_key_missing")
    if body.take_vm_snapshot is not None:
        raise _refuse(422, "vm_snapshot_not_allowed")
    await _require_vm_host(db, env)
    await _require_npm(db)
    if env.publish:
        await _require_integrations(db, env)
    ref = body.git_ref or env.git_ref
    if not gitref.valid_ref(ref):
        raise _refuse(422, "ref_invalid")
    snapshot = None
    if env.seed_snapshot_id is not None and not await lan_slots.ran(db, env):
        try:
            snapshot = await snapshots.ready_snapshot(db, env.seed_snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    slot = do_envs.target_slot(env)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="update", git_ref=ref,
                         sha=ref.lower() if gitref.is_full_sha(ref) else "", snapshot=snapshot,
                         publish=env.publish, vm=True, bluegreen=True, slot=slot,
                         go_live=do_envs.goes_live(env, slot),
                         first_admin=snapshot is None and await first_admins.pending(db, env.id))


async def _start_lan_teardown(db, env: Environment, body: DeploymentIn, request: Request,
                              actor: AuthContext) -> dict:
    """Delete on LAN Blue/Green: a snapshot first (unless turned off), taken on
    the live slot's VM against the data VM; then the three VMs, the proxy
    hosts and the DNS records."""
    if not vault.is_configured(get_settings()):
        raise _refuse(400, "secrets_key_missing")
    await _require_vm_host(db, env)
    await _require_integrations(db, env, teardown=True)
    rows = await lan_slots.slots_of(db, env.id)
    slot = env.active_slot or next((s for s in env.slots if rows.get(s) and rows[s].sha), None)
    snap = None
    if body.snapshot is not False and env.current_sha is not None:
        cfg = await _host_target(db, env, slot=slot) if slot else None
        if cfg is None:
            raise _snapshot_slot_unreachable(env)
        await _pinned(db, cfg)
        snap = await _begin_delete_snapshot(db, env, actor)
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode="teardown", git_ref=env.git_ref, sha=env.current_sha or "",
                         snapshot=snap, vm=True, bluegreen=True, slot=slot)
```

In `start_deployment`:

- the `snapshot`/`confirm_production` guard allows `body.snapshot` for a Blue/Green teardown: `if (body.snapshot is not None or body.confirm_production is not None) and not (body.mode == "teardown" and (_on_do(env) or (_on_bg(env) and body.confirm_production is None))):`;
- right after the DigitalOcean `reset/restore_dump/vm_restore` refusal: `if _on_bg(env) and body.mode in ("reset", "restore_dump", "vm_restore"): raise _not_on_bg()`;
- after the DigitalOcean dispatch: `if _on_bg(env) and body.mode in ("update", "teardown"): return await (_start_lan_teardown if body.mode == "teardown" else _start_lan_update)(db, env, body, request, actor)`.

`rollback_deployment`: `if _on_bg(env): raise _not_on_bg()` next to the DigitalOcean refusal.

- [ ] **Step 5: Activate and Retry**

`activate`: replace `if not _on_do(env): raise _refuse(409, "not_digitalocean_environment")` with

```python
    if _on_bg(env):
        return await _activate_lan(db, env, body, request, actor)
    if not _on_do(env):
        raise _refuse(409, "not_bluegreen_environment")
```

and add:

```python
async def _activate_lan(db, env: Environment, body: ActivateIn, request: Request,
                        actor: AuthContext) -> dict:
    if await environments.is_deploying(db, env.id):
        raise _refuse(409, "deploy_in_progress")
    if not vault.is_configured(get_settings()):
        raise _refuse(400, "secrets_key_missing")
    if body.slot is None:
        raise _refuse(422, "slot_required")              # Deactivate is production's
    if body.slot not in env.slots:
        raise _refuse(422, "slot_invalid")
    if body.slot == env.active_slot:
        raise _refuse(409, "slot_already_active")
    row = (await lan_slots.slots_of(db, env.id)).get(body.slot)
    if row is None or not row.sha:
        raise _refuse(409, "slot_not_deployed", slot=body.slot)
    await _require_vm_host(db, env)
    await _require_npm(db)
    if await _host_target(db, env, slot=body.slot) is None:
        raise _refuse(409, "vm_not_ready")
    return await _launch(db, env, request, actor, action="deploy.activate", mode="activate",
                         git_ref=row.sha, sha=row.sha, vm=True, bluegreen=True, slot=body.slot,
                         go_live=True)
```

`retry_deployment`: `if _on_bg(env) and dep.mode in pipeline.NOT_ON_DIGITALOCEAN: raise _not_on_bg()`; the `publish_off` rule for `dep.bluegreen` refuses only a retry *of* step 12 (`from_step == STEPS_BY_KEY["dns"].number`: 13 and 14 aren't publishing steps there, and `plan_for(..., publish=False)` simply drops `dns`); `taking = dep.mode == "teardown" and (dep.cloud or dep.bluegreen) and await _has_step(...)`; `plan_for(..., bluegreen=dep.bluegreen)`; `cfg = await _host_target(db, env, slot=dep.slot if (dep.cloud or dep.bluegreen) else None)`; `if dep.bluegreen and dep.mode in ("update", "activate"): await _require_npm(db)`; `_launch(..., bluegreen=dep.bluegreen)`.

- [ ] **Step 6: PATCH**

In `environments.update`: the `auto_activate` rule becomes

```python
    if fields.get("auto_activate") is not None:
        # Off is always fine; on only for a non-production environment with two slots.
        two_slots = (on_do or lan_slots.is_bluegreen(env)) and env.type != "production"
        if fields["auto_activate"] and not two_slots:
            raise EnvError("auto_activate_not_allowed")
        put("auto_activate", bool(fields["auto_activate"]))
```

and the `vm` branch starts with `if lan_slots.is_bluegreen(env): raise EnvError("vm_resize_not_supported")`. Add `"vm_resize_not_supported": 409` to the route's `_ENV_STATUS`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b7 .venv/bin/pytest -q tests/test_deploy_lan_api.py tests/test_deploy_do_activate_api.py tests/test_deploy_deployments_api.py tests/test_deploy_vm_api.py tests/test_deploy_esxi_vm_api.py tests/test_deploy_do_deployments_api.py tests/test_deploy_environments_api.py`
Expected: PASS.

- [ ] **Step 8: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/api/routes/deploy.py src/sirdar_api/deploy/environments.py tests/test_deploy_lan_api.py tests/test_deploy_do_activate_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/tests/test_deploy_lan_api.py sirdar/api/tests/test_deploy_do_activate_api.py
git commit -m "feat(sirdar): Update, Activate and Delete for LAN Blue/Green

The phase-7 routes, generalized: idle-slot Update, Activate through NPM,
auto-activate, Delete with a snapshot; shared-data modes refused.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b7
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b7_source
```

---

### Task 8: The dashboard: proxy → two servers

**Files:**
- Modify: `sirdar/api/src/sirdar_api/dashboard/service.py`
- Modify: `sirdar/api/tests/test_dashboard_flow.py`

**Interfaces:**
- Consumes: Task 2 (`lan_slots`, `vms.machines`).
- Produces: a Blue/Green environment's card `flow` = `{"kind": "proxy", "middle": NPM, "servers": [orange, purple], "active_slot", "certificate": None, "deploying_slot", "failed_slot"}` where each server is `{"id": slot, "label": "Orange", "sub": <VM address or "Not built yet">, "state": "live"|"idle"|"empty", "health": from `vm_slots.last_check_ok`, "version": its image tag, "deployed": its sha is set}`; `_marks` names the slot (not `"host"`); the infrastructure tree shows NPM, the data VM and both app VMs. Single-server LAN cards are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `sirdar/api/tests/test_dashboard_flow.py` (it already builds cards with `service.environment_cards` / `build_dashboard`; follow its existing helpers for the settings and the NPM integration):

```python
async def test_a_lan_bluegreen_card_shows_proxy_to_two_servers(db, secrets_key):
    from sqlalchemy import update as sql_update

    from sirdar_api.db.models import EsxiVm, VmSlot
    from sirdar_api.deploy import vmcommon
    from .integration_helpers import configure, configure_esxi
    from .lan_helpers import make_bluegreen_environment

    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    env = await make_bluegreen_environment(db)
    await vmcommon.set_vm(EsxiVm, env.id, role="orange", ip="10.10.48.48", created=True)
    await vmcommon.set_vm(EsxiVm, env.id, role="purple", ip="10.10.48.49", created=True)
    await db.execute(sql_update(VmSlot).where(VmSlot.environment_id == env.id,
                                              VmSlot.slot == "orange")
                     .values(sha="a" * 40, image_tag="aaaaaaaa", last_check_ok=True))
    env.active_slot, env.current_sha, env.status = "orange", "a" * 40, "ready"
    await db.commit()
    data = await service.build_dashboard(get_settings(), db=db)
    card = next(c for c in data["environments"] if c["id"] == "lan9")
    flow = card["flow"]
    assert (flow["kind"], flow["active_slot"]) == ("proxy", "orange")
    assert [(s["id"], s["label"], s["sub"], s["state"], s["health"], s["version"], s["deployed"])
            for s in flow["servers"]] == [
        ("orange", "Orange", "10.10.48.48", "live", "healthy", "aaaaaaaa", True),
        ("purple", "Purple", "10.10.48.49", "idle", "unknown", None, False)]
    node = next(n for n in data["infrastructure"]["tree"] if n["id"] == "lan9")
    assert [c["name"] for c in node["children"]][:4] == [
        "Nginx Proxy Manager", "ss-lan9-data", "ss-lan9-orange", "ss-lan9-purple"]
```

(Use the imports and fixtures the file already has: `service`, `get_settings`, `secrets_key`; add any missing at the top.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b8 .venv/bin/pytest -q tests/test_dashboard_flow.py -k bluegreen`
Expected: FAIL (one `host` server).

- [ ] **Step 3: The flow and the parts**

In `dashboard/service.py` (import `lan_slots`):

```python
async def _lan_bluegreen_flow(db: AsyncSession, env: Environment) -> dict:
    url = (await integrations.config_of(db, "npm")).get("url")
    npm_host = urlsplit(url).hostname if url else None
    rows = await lan_slots.slots_of(db, env.id)
    machines = {m.role: m for m in await vms.machines(db, env)}
    servers = []
    for slot in env.slots:
        r, m = rows.get(slot), machines.get(slot)
        built = bool(m and m.created)
        state = "live" if slot == env.active_slot else "idle" if built or (r and r.sha) \
            else "empty"
        health = ("unknown" if r is None or r.last_check_ok is None
                  else "healthy" if r.last_check_ok else "degraded")
        servers.append({"id": slot, "label": slot.title(),
                        "sub": m.ip if m and m.ip else "Not built yet", "state": state,
                        "health": health, "version": r.image_tag if r else None,
                        "deployed": bool(r and r.sha)})
    deploying, failed = await _marks(db, env, lan=False)
    return {"kind": "proxy",
            "middle": {"label": "Nginx Proxy Manager", "sub": npm_host or "Not set up",
                       "status": "ok" if npm_host else "unknown"},
            "servers": servers, "active_slot": env.active_slot, "certificate": None,
            "deploying_slot": deploying, "failed_slot": failed}
```

In `_environment_card`, the LAN branch becomes `do, flow = None, (await _lan_bluegreen_flow(db, env) if lan_slots.is_bluegreen(env) else await _lan_flow(db, settings, env))`; keep the machines for the tree in the card's private `_do`-like slot: `"_lan": await vms.machines(db, env) if lan_slots.is_bluegreen(env) else None`, popped wherever `_do` is popped.

`_lan_parts(env, flow, machines=None)`: for Blue/Green,

```python
    if machines:
        ok = flow["middle"]["status"] == "ok"
        parts = [node(f"{env.name}:npm", "Nginx Proxy Manager", "proxy", "Reverse proxy",
                      "active" if ok else "unknown", "Active" if ok else "Not set up",
                      region="LAN", endpoint=flow["middle"]["sub"] if ok else "—")]
        data = next((m for m in machines if m.role == vms.DATA), None)
        if data is not None:
            parts.append(node(f"{env.name}:data", data.name, "server", "Data VM",
                              "active" if data.created else "unknown",
                              "Built" if data.created else "Not built yet", region="LAN",
                              endpoint=data.ip or "—"))
        for s in flow["servers"]:
            health = {"healthy": ("healthy", "Healthy"), "degraded": ("degraded", "Degraded")}.get(
                s["health"], ("unknown", "Unknown"))
            parts.append(node(f"{env.name}:{s['id']}", vms.vm_name(env.name, s["id"]), "server",
                              f"App VM ({s['label']}{', live' if s['state'] == 'live' else ''})",
                              *health, region="LAN", endpoint=s["sub"], badge=s["version"]))
        return parts
```

and `environment_nodes` passes the card's `_lan` machines (`children, region = _lan_parts(env, card["flow"], lan), "LAN"`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b8 .venv/bin/pytest -q tests/test_dashboard_flow.py tests/test_dashboard_api.py tests/test_dashboard_inventory.py`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/dashboard/service.py tests/test_dashboard_flow.py
cd ../.. && git add sirdar/api/src/sirdar_api/dashboard/service.py sirdar/api/tests/test_dashboard_flow.py
git commit -m "feat(sirdar): the dashboard shows LAN Blue/Green as proxy to two servers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b8
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p8b8_source
```

---

### Task 9: Web for LAN Blue/Green

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts` (+ `sirdarApi.test.ts`)
- Modify: `sirdar/web/src/pages/environments/labels.tsx` (+ `labels.test.ts`)
- Create: `sirdar/web/src/pages/environments/LanMachinesSection.tsx` (+ `.test.tsx`)
- Modify: `EnvOverview.tsx`, `EnvironmentDetail.tsx`, `DeployModal.tsx`, `DeleteEnvironmentModal.tsx`, `DeploymentView.tsx`, `pages/dashboard/Spotlight.tsx` (+ the tests that cover them), `pages/environments/testData.ts`, `pages/dashboard/testData.ts`

**Interfaces:**
- Consumes: the API shapes of Tasks 2, 6 and 7.
- Produces:
  - Types: `EnvVm.role: 'main' | 'data' | 'orange' | 'purple'`; `interface LanSlot { slot: string; ip: string | null; sha: string | null; image_tag: string | null; active: boolean; last_check_ok: boolean | null; last_check_at: string | null }`; `Environment.machines: EnvVm[]`, `Environment.lan_slots: LanSlot[] | null`; `DeploymentSummary.bluegreen: boolean`; `NewVm` gains `slots?: 1 | 2; purple_ip_cidr?: string; data_ip_cidr?: string; data?: { cores?: number; memory_mb?: number; disk_gb?: number }; auto_activate?: boolean`.
  - `MESSAGES` for every new code; `auto_activate_not_allowed` reworded (table).
  - `labels`: `onBluegreen(env)` (a VM host with two slots), `twoSlots(env)` (`onDo(env) || onBluegreen(env)`), `NOT_ON_BLUEGREEN` (= `NOT_ON_DO`), `deploymentLabel` uses `d.cloud || d.bluegreen` for "Update to Purple, not live".
  - `LanMachinesSection({ env, canActivate, onActivate })`: a `DataTable` of the three VMs (role, name, address, size, slot state chip, version, last check) with "Activate <Slot>" on a deployed idle slot (deploy:add + change, not while running).
  - `Spotlight`: `twoSlots` = `(f.kind === 'load_balancer' || f.kind === 'proxy') && f.servers.length === 2`.
  - `EnvironmentDetail`: the ActivateModal's version comes from `env.do?.slots` or `env.lan_slots`.
  - `DeployModal`: the idle-slot hint and the hidden Mode selector for Blue/Green too (`twoSlots(env)`); the first-deploy rule reads `env.lan_slots` like `env.do.slots`.
  - `DeleteEnvironmentModal`: "Save a snapshot first" for Blue/Green too (sends `snapshot: false` when unticked); its list of what goes names the three VMs.
  - `DeploymentView`: no Roll back on Blue/Green.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/environments/LanMachinesSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import LanMachinesSection from './LanMachinesSection';
import { LAN_ENV } from './testData';

afterEach(cleanup);

it('lists the data VM and both app VMs with their slot state', () => {
  render(<LanMachinesSection env={LAN_ENV} canActivate onActivate={vi.fn()} />);
  const table = screen.getByRole('table', { name: 'Blue/Green VMs' });
  expect(within(table).getByText('ss-lan9-data')).toBeTruthy();
  expect(within(table).getByText('ss-lan9-orange')).toBeTruthy();
  expect(within(table).getByText('Live')).toBeTruthy();
  expect(within(table).getByText('10.10.48.47')).toBeTruthy();
});

it('offers Activate on the deployed idle slot only', async () => {
  const onActivate = vi.fn();
  render(<LanMachinesSection env={LAN_ENV} canActivate onActivate={onActivate} />);
  await userEvent.click(screen.getByRole('button', { name: 'Activate Purple' }));
  expect(onActivate).toHaveBeenCalledWith('purple');
  expect(screen.queryByRole('button', { name: 'Activate Orange' })).toBeNull();
});

it('has no Activate without permission', () => {
  render(<LanMachinesSection env={LAN_ENV} canActivate={false} onActivate={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
});
```

Add to `pages/environments/testData.ts` a `LAN_ENV: Environment` fixture: `name: 'lan9'`, `target: 'esxi'`, `target_kind: 'esxi'`, `slots: ['orange', 'purple']`, `active_slot: 'orange'`, `vm: null`, `machines` (data `10.10.48.47`, orange `10.10.48.48`, purple `10.10.48.49`, all `stage: 'built'`, `role` set), `lan_slots` (orange `sha: 'a'.repeat(40)`, `image_tag: 'aaaaaaaa'`, `active: true`, `last_check_ok: true`; purple `sha: 'b'.repeat(40)`, `image_tag: 'bbbbbbbb'`, `active: false`), and every other field like the existing `ENV` fixture; add `machines: []`, `lan_slots: null` to every other `Environment` fixture, `bluegreen: false` to every `DeploymentSummary` fixture, and `role: 'main'` to every `EnvVm` fixture (both `testData.ts` files).

Append to `pages/environments/labels.test.ts`:

```ts
it('Blue/Green on the LAN counts as two slots', () => {
  expect(onBluegreen(LAN_ENV)).toBe(true);
  expect(twoSlots(LAN_ENV)).toBe(true);
  expect(twoSlots(ENV)).toBe(false);
  expect(deploymentLabel({ mode: 'update', cloud: false, bluegreen: true, slot: 'purple', go_live: false }))
    .toBe('Update to Purple, not live');
});
```

(import `onBluegreen`, `twoSlots` from `./labels` and `LAN_ENV`, `ENV` from `./testData`; `deploymentLabel`'s argument type gains `bluegreen`.)

In `pages/dashboard/DashboardPage.test.tsx` (or the Spotlight's test file), add a case with a `flow.kind: 'proxy'` card with two servers (one `live`, one `idle` + `deployed: true`) and assert the "Activate Purple" button shows for a user with add + change.

In `lib/sirdarApi.test.ts`: add `'deploy/lan_slots.py'` to the scanner's file list and `'not_supported_on_bluegreen', 'vm_ips_not_distinct', 'not_bluegreen_environment'` to the expected codes; `pipeline.py`'s `code = "not_supported_on_bluegreen"` is found by the existing `^\s+code = "…"$` pattern.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments src/lib src/pages/dashboard`
Expected: FAIL (no `LanMachinesSection`, no `onBluegreen`, missing copy).

- [ ] **Step 3: Types, copy and labels**

Make the type changes in `sirdarApi.ts` (Interfaces), add the six codes' copy and reword `auto_activate_not_allowed`. In `labels.tsx`:

```ts
/** A LAN environment Sirdar runs as Blue/Green: a data VM and two app VMs behind Nginx Proxy Manager. */
export const onBluegreen = (env: Pick<Environment, 'target_kind' | 'slots'>) =>
  (env.target_kind === 'proxmox' || env.target_kind === 'esxi') && env.slots.length === 2;
/** Two slots and an Activate: DigitalOcean, or LAN Blue/Green. */
export const twoSlots = (env: Pick<Environment, 'target_kind' | 'slots'>) =>
  (onDo(env) && env.slots.length === 2) || onBluegreen(env);
/** Modes a LAN Blue/Green environment doesn't offer: both app VMs share the data VM. */
export const NOT_ON_BLUEGREEN = NOT_ON_DO;
```

`deploymentLabel`'s argument is `Pick<DeploymentSummary, 'mode' | 'cloud' | 'bluegreen' | 'slot' | 'go_live'>` and its update branch tests `(d.cloud || d.bluegreen)`.

- [ ] **Step 4: `LanMachinesSection`**

Create `sirdar/web/src/pages/environments/LanMachinesSection.tsx`:

```tsx
/** Overview › Blue/Green: a LAN Blue/Green environment's data VM and two app
 *  VMs, which slot is live, and Activate on the idle one once it ran a deploy. */
import DataTable from '@portal/components/DataTable';

import type { Environment } from '../../lib/sirdarApi';

import { slotTitle, vmSize, when } from './labels';

const ROLE_LABEL: Record<string, string> = { data: 'Data', orange: 'Orange', purple: 'Purple' };

export default function LanMachinesSection({ env, canActivate, onActivate }: {
  env: Environment; canActivate: boolean; onActivate: (slot: string) => void;
}) {
  const slots = new Map((env.lan_slots ?? []).map((s) => [s.slot, s]));
  return (
    <section className="sirdar-section">
      <h2>Blue/Green</h2>
      <p className="page-hint">
        Nginx Proxy Manager sends traffic to the live app VM; both app VMs use the data VM's database and storage.
      </p>
      <DataTable
        ariaLabel="Blue/Green VMs"
        columns={[
          { key: 'role', label: 'Role' }, { key: 'name', label: 'VM', mono: true },
          { key: 'ip', label: 'Address', mono: true }, { key: 'size', label: 'Size' },
          { key: 'state', label: 'Traffic' }, { key: 'version', label: 'Version', mono: true },
          { key: 'check', label: 'Last check' }, { key: 'act', label: '', align: 'right' },
        ]}
        rows={env.machines.map((m) => {
          const s = slots.get(m.role);
          const live = !!s?.active;
          const state = m.role === 'data'
            ? <span className="chip tag">Shared</span>
            : live ? <span className="chip c-green">Live</span>
              : s?.sha ? <span className="chip c-blue">Idle</span> : <span className="chip tag">Not deployed</span>;
          const check = s?.last_check_ok == null ? '—'
            : `${s.last_check_ok ? 'Passed' : 'Failed'} · ${when(s.last_check_at)}`;
          return {
            key: m.role,
            cells: [
              <b className="cell-top">{ROLE_LABEL[m.role] ?? m.role}</b>, m.name, m.ip ?? 'Not built yet',
              vmSize(m), state, s?.image_tag ?? '—', check,
              canActivate && s && !live && s.sha
                ? <button type="button" className="mini-btn" onClick={() => onActivate(m.role)}>
                    {`Activate ${slotTitle(m.role)}`}
                  </button>
                : '',
            ],
          };
        })}
      />
    </section>
  );
}
```

- [ ] **Step 5: Wire it in**

- `EnvOverview.tsx`: import `LanMachinesSection` and `onBluegreen`; after the DigitalOcean section, `{onBluegreen(env) && (<LanMachinesSection env={env} canActivate={canActivate && !!onActivate} onActivate={(s) => onActivate?.(s)} />)}`; the single-VM "Machine" section stays for `env.vm`; the Services table's address column says `:${s.port} on the live app VM` for every service but `spaces` on Blue/Green.
- `EnvironmentDetail.tsx`: `version={env.do?.slots.find((s) => s.slot === activating.slot)?.image_tag ?? env.lan_slots?.find((s) => s.slot === activating.slot)?.image_tag ?? null}`.
- `DeployModal.tsx`: the idle-slot block renders for `twoSlots(env) || onDo(env)` (replace `onDo(env) && (() => {…})()` with `(onDo(env) || onBluegreen(env)) && (() => {…})()`); `firstDeploy` = `env.current_sha === null && (!(onDo(env) || onBluegreen(env)) || (env.active_slot === null && !(env.do?.slots ?? env.lan_slots ?? []).some((s) => s.sha)))`; the Mode selector shows only when `!onDo(env) && !onBluegreen(env)`; the "take a VM snapshot" option hides on Blue/Green.
- `DeleteEnvironmentModal.tsx`: the "Save a snapshot first" box shows for `cloud || onBluegreen(env)` and sends `snapshot: false` when unticked; for Blue/Green the list of what goes is `env.machines.map((m) => \`VM ${m.name}\`)` plus the proxy hosts and DNS records (`env.managed_records`).
- `DeploymentView.tsx`: `mayRollBack` adds `&& !onBluegreen(env)`.
- `pages/dashboard/Spotlight.tsx`: `const twoSlots = (f.kind === 'load_balancer' || f.kind === 'proxy') && f.servers.length === 2;` and the header comment says "two-slot DigitalOcean or LAN Blue/Green environment".

- [ ] **Step 6: Run the tests and the build**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts sirdar/web/src/pages/environments/labels.tsx sirdar/web/src/pages/environments/labels.test.ts sirdar/web/src/pages/environments/LanMachinesSection.tsx sirdar/web/src/pages/environments/LanMachinesSection.test.tsx sirdar/web/src/pages/environments/EnvOverview.tsx sirdar/web/src/pages/environments/EnvironmentDetail.tsx sirdar/web/src/pages/environments/DeployModal.tsx sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx sirdar/web/src/pages/environments/DeploymentView.tsx sirdar/web/src/pages/dashboard/Spotlight.tsx sirdar/web/src/pages/environments/testData.ts sirdar/web/src/pages/dashboard/testData.ts
git add sirdar/web/src/pages/environments/*.test.tsx sirdar/web/src/pages/dashboard/*.test.tsx
git commit -m "feat(sirdar-web): LAN Blue/Green on the environment page and the dashboard

The three VMs with Activate on the idle slot, idle-slot deploys, Delete's
snapshot, and the spotlight's proxy to two servers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, full suites, live verify (controller)

**Files:**
- Modify: `sirdar/README.md` ("Deploy pipeline (environments)": LAN Blue/Green)
- Modify: `deploy/stack/README.md` (the data VM and app VM `.env` keys; `db/lan.yml`)

- [ ] **Step 1: Docs**

`sirdar/README.md`: a "LAN Blue/Green (ESXi, Proxmox)" subsection: the three VMs and their names; static addresses; NPM as the switch (required) and Publish deciding only DNS; the plans (Update, Activate, Delete) with step numbers; the data VM's firewall and `pg_hba.conf`; what's refused (Reset, Restore backup, Roll back, Restore VM snapshot, VM resize) and why; where snapshots and dumps run (decision 1).

`deploy/stack/README.md`: the `STACK_DB_PUBLISH` / `STACK_DB_ALLOW` / `STACK_DB_SSLMODE` keys, `db/lan.yml`, and a by-hand note: "To reach a data VM's Postgres from another machine, add it to STACK_DB_ALLOW and to Sirdar's firewall rules (`/usr/local/sbin/sirdar-data-firewall`), then `ss-stack data`."

- [ ] **Step 2: Full suites and lint**

Run (foreground, 600000 ms timeouts):

```bash
cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_p8b10 .venv/bin/pytest -q
cd ../.. && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -c deploy/pytest.ini deploy/tests
bash -n deploy/stack/ss-stack && (command -v shellcheck >/dev/null && shellcheck deploy/stack/ss-stack || true)
npm --prefix sirdar/web test && npm --prefix sirdar/web run build
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src tests migrations
```

Expected: green. Drop `sirdar_test_p8b10` and `sirdar_test_p8b10_source`.

- [ ] **Step 3: Live verify on ESXi (throwaway environment `lan8`; never uat, never production)**

Recipe (phase 6's): ESXi 7 host 10.10.48.111, datastore `datastore2`, port group `VM Network`, seed `sirdar-ubuntu-2404-seed`; NPM at 10.10.48.6; Sirdar on Tower updated to this branch's head (or the worktree's dev Sirdar per the memory's live-verify recipe). Addresses on 10.10.48.0/23, gateway **10.10.48.1**: data **10.10.48.47/23**, orange **10.10.48.48/23**, purple **10.10.48.49/23** — ping each first and check the ESXi host and NPM for them; if one answers, pick free ones and note them.

1. Create `lan8` (type Custom, target ESXi, Blue/Green, the three addresses, Publish on with Cloudflare, auto-activate off) through the API (8c's page comes later): `POST /api/deploy/environments` with `vm.slots: 2`.
2. Deploy. Step 0 builds `ss-lan8-data` then `ss-lan8-orange` (purple stays unbuilt); step 7 runs on .47; steps 1–6 and 10 on .48; 13 smoke on .48; 14 creates the proxy hosts (forward .48, spaces → .47) and the public smoke passes. Check: `ssh deploy@10.10.48.47 'sudo iptables -S SIRDAR-DATA'` shows the two app VMs on 5432 and the app VMs + 10.10.48.6 on 9000; `cat /opt/serversherpa/lan8/pg_hba.conf`; from Tower `psql -h 10.10.48.47 -U serversherpa` is refused (firewall), from .48 `docker run --rm postgres:16-alpine pg_isready -h 10.10.48.47` answers. The data VM's `.env` has no `SS_JWT_SECRET`. The portal works at `https://portal.lan8.serversherpa.com`.
3. Deploy again: purple is built and deployed; traffic stays on orange (NPM forward hosts still .48); the dashboard shows Orange live, Purple idle with "Activate Purple".
4. Activate Purple from the dashboard: slot smoke on .49, NPM forward hosts → .49 (spaces still .47), public smoke passes; sign in on the portal; data (a probe row) written before the switch is still there.
5. Failure path: stop the portal container on orange (`docker stop ss-lan8-web-portal-1` on .48), Activate Orange: the slot smoke test fails at step 13 and nothing changes in NPM. Start it again. Then break the public check another way (e.g. a temporary NPM access list on one proxy host) and Activate Orange: step 14 fails and every proxy host is back on .49; remove the access list.
6. Auto-activate on (Settings), deploy: the idle slot goes live by itself.
7. Refusals: Reset / Restore backup from the API answer `not_supported_on_bluegreen`; `PATCH vm` answers `vm_resize_not_supported`.
8. Delete with "Save a snapshot first": a `lan8-before-delete-…` snapshot is ready (its object count matches SeaweedFS on .47), then the three VMs are destroyed (ESXi Host Client shows none), the proxy hosts and DNS records are gone, the pins are forgotten.
9. Regression: an existing single-server ESXi environment (e.g. a fresh `solo8` at another free address) still deploys and deletes exactly as before.
10. Check the four "Uncertain points" and record the answers, timings and any fixes in `.superpowers/sdd/p8b-live-verify.md` (git-ignored).
</content>
</invoke>
