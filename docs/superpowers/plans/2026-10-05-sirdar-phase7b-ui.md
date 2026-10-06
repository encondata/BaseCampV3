# Sirdar deploy phase 7b (DigitalOcean environments: Blue/Green, the cert-worker, the dashboard, UI and live verify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish phase 7 on top of 7a:

- **Activate** (and, for a retiring production, Deactivate) switches the load balancer between slots; non-production environments can **activate automatically** after a good deploy; a one-slot environment can **add its second slot**; sizes can **grow**;
- the **cert-worker** in the api image renews the load balancer certificate by HTTP-01 from the active slot; **Sirdar is the backup renewer** (a `renew` deployment every 6 hours when ≤ 14 days remain);
- the **dashboard** reads real state: the production card's slots, load balancer and certificate, with a working Activate; two-slot cards elsewhere; both accounts in the infrastructure view;
- the **web**: the two accounts in Settings, DigitalOcean in New environment, the environment pages, the dashboard;
- the **live verify**: a throwaway two-slot dev environment in the Development account.

**Architecture:**

- Backend first (Tasks 1–5). Activate is a deployment of mode `activate` (13 Smoke test (slot), 14 Switch traffic); Deactivate is mode `activate` with no slot (14 alone). The periodic renewal is a deployment of mode `renew` (19 Renew certificate), so it shares the one-running-deployment lock with Activate.
- The cert-worker lives in the ServerSherpa API (`api/src/serversherpa/certs/`) with a byte-identical copy of 7a's `acme.py`, runs as the `cert-worker` service under the Compose profile `certs` (only on droplets), answers HTTP-01 on :8089 behind Caddy, and renews only on the droplet the load balancer targets, under a Postgres advisory lock.
- Web (Tasks 6–10): `sirdarApi.ts` types and calls, `DoAccountModal`, `ActivateModal` (shared by the environment page and the dashboard), `DoMachineSection` / `DoSettingsSection`, and DigitalOcean branches in New environment, Delete and Deploy.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, httpx, `cryptography`, Typer (api CLI), Docker Compose; React 18 + TypeScript, Vite, Vitest + Testing Library (jsdom), the portal's `DataTable` / `ComboBox` / `Switch` / `lib/api` through `@portal`.

**Spec and context:**
- Spec: `docs/superpowers/specs/2026-10-05-sirdar-digitalocean-environments-design.md` (§3 cert-worker, §4 Blue/Green, §7 dashboard, §8 accounts in the UI).
- Decisions: `docs/superpowers/plans/2026-10-05-sirdar-phase7-context.md`.
- 7a: `docs/superpowers/plans/2026-10-05-sirdar-phase7a-backend.md` ("API produced for 7b"). 7a must be merged on `sirdar` (all 13 tasks, suite green) before this plan starts.

## Global Constraints

**Where and how to work**

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it.
- `sirdar` is both a branch and a folder: use `--` in `git diff` and `git log`.
- Other agents may commit here at the same time: `git add` only your task's files; never `git add -A`, never `git stash`; retry when `.git/index.lock` is busy. If a file this plan edits has changed since it was written, apply the same edit to the new text and keep their change.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Backend**

- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"`. Changed files pass `.venv/bin/ruff check --select E,F,W --ignore F811 <files>`.
- Sirdar tests: from `sirdar/api`, `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/<file>`. Never the dev `sirdar` DB. Implementers run focused files; the controller runs the whole suite (about 11 minutes).
- ServerSherpa API tests (Task 3): from the worktree's `api/`, with the main checkout's venv and **`PYTHONPATH=src`** (the venv's editable install points at the main checkout, so without it you test the wrong code): `PYTHONPATH=src SS_TEST_DB=serversherpa_test_phase7b /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest -q tests/test_cert_worker.py`. Lint with `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check`.
- No migration: 0010 (7a) already allows the modes `activate` and `renew`.
- Secrets (account and renewal tokens, ACME keys, certificate keys, database passwords) never reach a response, log, audit row, exception or `repr()`. The cert-worker logs outcomes only.
- Tests never reach real DigitalOcean, Spaces, Let's Encrypt or Cloudflare.

**Web**

- Every new modal gets the report-generate header (eyebrow, title, description) and sizes to its content (a content-matched card width; dropdowns through `portal`).
- Reuse `DataTable`, `ComboBox`, `Switch`, segmented radio groups with `arrowNav`, chips, `.pf-form` with `.field-label` for captions that aren't labels; sections inside a `.pf-form` grid get `grid-column: 1 / -1` (`sirdar-span2`); cards use `.sirdar-integration-cards`, `.sirdar-kv` and `Breakable`. No raw `<select>`.
- American English; "Canceled" for `cancelled`.
- Component tests start with `// @vitest-environment jsdom`, mock `../../lib/sirdarApi` (spreading the real module) and `@portal/auth/AuthContext` as the existing tests do, and set `Element.prototype.scrollIntoView = () => {}` when a ComboBox is used.
- No new `@portal` import beyond the allowlist (`auth/AuthContext`, `components/DataTable`, `components/ComboBox`, `components/Switch`, `lib/api`).
- Web tests: `npm --prefix sirdar/web test`. Type-check and build: `npm --prefix sirdar/web run build`. Never `npm install`.
- Don't add reader-facing widgets that weren't asked for.

## Interfaces from 7a

(All under `/api/deploy`.)

- `Environment` has `type: 'dev'|'beta'|'custom'|'production'`, `target_kind: 'ssh'|'proxmox'|'esxi'|'digitalocean'`, `slots: string[]`, `active_slot`, `auto_activate`, `retiring`, and `do: EnvDo | null` (account, account_label, region, droplet_size, db_size, db_standby, acme_staging, vpc_ip_range, lb_ip, db_host, bucket, cert_not_after, slots[{slot, droplet_id, public_ip, private_ip, sha, image_tag, active, last_check_ok, last_check_at}], resources[{kind, name, slot}]).
- `DeploymentSummary` has `cloud`, `slot`, `go_live`.
- Accounts: `GET/PUT/POST test/DELETE /integrations/digitalocean/accounts[/{key}]`; the old `/integrations/digitalocean` alias stays in the API, but the web stops using it (Task 7).
- `POST /environments` takes `do: {account, slots?, droplet_size?, db_size?, db_standby?, acme_staging?}`; `GET /environment-defaults` has `do`.
- Delete on DigitalOcean takes `snapshot?` and `confirm_production?`.
- Python: `do_envs`, `do_provision` (`DoProvisioner`, `DoContext`, `prepare`, `load_records`, `lb_update_body`, `https_certificate`, `_certificate`), `do_accounts`, `certs`, `acme`, `steps.plan_for(..., cloud, go_live, snapshot)`, `pipeline.create_deployment(..., cloud, slot, go_live)`, `envfile.EXTRA_KEYS`.

## API produced by Tasks 1–5 (for the web tasks)

- `POST /environments/{name}/activate` (change). Body `{slot: string|null, confirm_name?}` → `Deployment` (201). `slot: null` deactivates (only a retiring production). Errors: 409 `not_digitalocean_environment`, 409 `deploy_in_progress`, 409 `slot_already_active`, 409 `slot_not_deployed`, 409 `production_retiring`, 409 `already_inactive`, 409 `do_account_not_configured {account}`, 422 `slot_invalid`, 422 `slot_required`, 422 `confirm_name_mismatch` (production).
- `PATCH /environments/{name}` adds `auto_activate?: bool` (non-production DigitalOcean; 422 `auto_activate_not_allowed`) and `do?: {droplet_size?, db_size?, db_standby?}` (grow only; 422 `do_size_invalid | do_db_size_invalid | do_shrink_refused`; 502 `connect_failed`).
- `POST /environments/{name}/slots` (change) → `{environment, deployment: Deployment|null}` (201): adds `purple` to a one-slot non-production environment and, once it has a commit, deploys that commit to it. Errors: 409 `not_digitalocean_environment`, 409 `slots_full`, 409 `deploy_in_progress`, 422 `slot_not_allowed` (production).
- Modes `activate` and `renew`; steps 19 `do_renew` "Renew certificate".
- `GET /digitalocean/regions?account=production|development`; `POST /connect` takes `account` for the DigitalOcean target.
- `GET /dashboard`:
  - `production`: `{status, active_slot, environment: string|null, traffic, load_balancer: {label, sub, present, ip}, certificate: Cert|null, slots: [{id, label, state, health, version, instances, traffic_pct}]}`;
  - each `environments[]` card adds `slots: [{id, label, state, health, version}]` (two-slot DigitalOcean environments; else `[]`), `active_slot`, `certificate: Cert|null`;
  - `Cert = {not_after, days_left, warn}` (`warn` at ≤ 14 days);
  - `infrastructure.accounts: [{key, label, error}]`; with both accounts set up, `tree` has one top node per account.

## File map

| File | Change |
|---|---|
| `sirdar/api/src/sirdar_api/api/routes/deploy.py` | Activate, add a slot, PATCH `auto_activate` and `do`, regions/connect per account |
| `sirdar/api/src/sirdar_api/deploy/steps.py`, `pipeline.py`, `do_envs.py`, `do_provision.py`, `environments.py` | Activate plans, grows in step 0, the renew step, cert-worker `.env` keys |
| `sirdar/api/src/sirdar_api/deploy/renewals.py` | New: the 6-hourly backup renewal |
| `sirdar/api/src/sirdar_api/api/app.py`, `config.py` | The renewal loop |
| `sirdar/api/src/sirdar_api/dashboard/service.py` | Real production card, slot pairs, certificates, both accounts |
| `api/src/serversherpa/certs/{__init__,acme,worker}.py`, `api/src/serversherpa/config.py`, `api/src/serversherpa/cli.py` | New: the cert-worker |
| `deploy/stack/api/compose.yml`, `deploy/stack/ss-stack` | The `cert-worker` service (profile `certs`) |
| `sirdar/web/src/lib/sirdarApi.ts`, `pages/environments/labels.tsx`, `testData.ts` | Types, calls, messages, fixtures |
| `sirdar/web/src/pages/settings/DoAccountModal.tsx`, `IntegrationsSection.tsx`, `sirdar/web/src/pages/Deploy.tsx` | The two accounts (the old `DigitalOceanModal` goes); the Deploy page's account choice |
| `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx` | DigitalOcean target and its Cloud step |
| `sirdar/web/src/components/ActivateModal.tsx` | New: Activate / Deactivate |
| `sirdar/web/src/pages/environments/DoMachineSection.tsx`, `DoSettingsSection.tsx`, `EnvOverview.tsx`, `EnvSettings.tsx`, `DeleteEnvironmentModal.tsx`, `DeployModal.tsx` | DigitalOcean environment pages |
| `sirdar/web/src/pages/dashboard/ProductionFlow.tsx`, `EnvCard.tsx`, `DashboardPage.tsx` | Real Activate, slot pairs, certificate warnings |
| `sirdar/web/src/styles/sirdar.css`, `pages/dashboard/dashboard.css` | Layout for the new pieces |

---

### Task 1: Activate, Deactivate and auto-activate

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (`plan_for(..., smoke=True)`)
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py` (`plan_of` and `create_deployment` pass `smoke`)
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`auto_activate`)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`POST /environments/{name}/activate`; PATCH `auto_activate`; retry passes `smoke`)
- Create: `sirdar/api/tests/test_deploy_do_activate_api.py`
- Modify: `sirdar/api/tests/test_deploy_playbooks.py`

**Interfaces:**
- Consumes: 7a's cloud plans, `do_envs.goes_live` (already reads `auto_activate`), `do_envs.after_success` (an activate deployment has `go_live=True`; with `slot=None` it clears `active_slot`), `_launch`, `_require_account`, `_host_target`, `_pinned`, `_on_do`.
- Produces: `steps.plan_for(mode, ..., smoke: bool = True)` — `activate` is `slot_smoke, go_live`, or `go_live` alone with `smoke=False`; `pipeline.smokes(dep) -> bool` (`not (dep.mode == "activate" and dep.slot is None)`); the route and codes listed under "API produced by Tasks 1–5".

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/test_deploy_playbooks.py`:

```python
def test_deactivate_has_no_slot_smoke_test():
    assert _cloud("activate", smoke=False) == ["go_live"]
    assert _cloud("activate") == ["slot_smoke", "go_live"]
```

Create `sirdar/api/tests/test_deploy_do_activate_api.py`:

```python
"""Activate on a DigitalOcean environment: a deployment that smoke-tests
the slot on its droplet, then moves the load balancer to it; Deactivate (a
retiring production only) points the load balancer at nothing; a
non-production environment can activate automatically after a good deploy."""

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, DoSlot, Environment
from sirdar_api.deploy import pipeline, vms
from sirdar_api.deploy.provision import VmOutcome

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import make_do_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_do_deployments_api import _deployed
from .test_deploy_pipeline import SHA

NEWER = "e1" * 20
URL = "/api/deploy/environments"


@pytest.fixture
async def ready(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_runner,
                fake_publisher, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)

    async def make(**kw) -> Environment:
        env = await make_do_environment(db, **kw)
        await _deployed(db, env, active=env.slots[0])
        return env
    return make


async def _activate(client, h, name, **body):
    resp = await client.post(f"{URL}/{name}/activate", headers=h, json=body)
    if resp.status_code == 201:
        await pipeline.wait(resp.json()["id"])
    return resp


async def test_activate_the_other_slot(client, db, ready, fake_provisioner, fake_runner):
    env = await ready()
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "purple").values(sha=NEWER))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _activate(client, h, "uat9", slot="purple")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["slot"], body["go_live"], body["sha"]) == (
        "activate", "purple", True, NEWER)
    assert [s["key"] for s in body["steps"]] == ["slot_smoke", "go_live"]
    assert fake_runner.steps() == ["slot_smoke"] and fake_provisioner.calls == ["go_live"]
    env = await db.get(Environment, env.id, populate_existing=True)
    assert (env.active_slot, env.current_sha, env.status) == ("purple", NEWER, "ready")
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.activate"))).one()
    assert (audit["slot"], audit["environment"]) == ("purple", "uat9")


@pytest.mark.parametrize("body, status, code", [
    ({"slot": "orange"}, 409, "slot_already_active"),
    ({"slot": "blue"}, 422, "slot_invalid"),
    ({"slot": None}, 422, "slot_required"),
])
async def test_activate_refusals(client, db, ready, body, status, code):
    await ready()
    h = await auth_headers(client, db)
    resp = await _activate(client, h, "uat9", **body)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (status, code)


async def test_a_slot_that_was_never_deployed(client, db, ready):
    env = await ready()
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "purple").values(sha=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _activate(client, h, "uat9", slot="purple")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "slot_not_deployed")


async def test_production_needs_the_name_and_deactivates_only_when_retiring(
        client, db, ready, fake_provisioner, fake_runner):
    env = await ready(name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    resp = await _activate(client, h, "prod", slot="green")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "confirm_name_mismatch")
    assert (await _activate(client, h, "prod", slot="green", confirm_name="prod")
            ).status_code == 201
    resp = await _activate(client, h, "prod", slot=None, confirm_name="prod")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "slot_required")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    resp = await _activate(client, h, "prod", slot="blue", confirm_name="prod")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "production_retiring")
    fake_runner.requests.clear()
    resp = await _activate(client, h, "prod", slot=None, confirm_name="prod")
    assert resp.status_code == 201, resp.text
    assert [s["key"] for s in resp.json()["steps"]] == ["go_live"]
    assert fake_runner.requests == []
    env = await db.get(Environment, env.id, populate_existing=True)
    assert env.active_slot is None
    resp = await _activate(client, h, "prod", slot=None, confirm_name="prod")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "already_inactive")


async def test_auto_activate(client, db, ready):
    await ready()
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"auto_activate": True})
    assert resp.status_code == 200 and resp.json()["auto_activate"] is True
    resp = await client.post(f"{URL}/uat9/deployments", headers=h, json={"mode": "update"})
    assert (resp.json()["slot"], resp.json()["go_live"]) == ("purple", True)
    await pipeline.wait(resp.json()["id"])


async def test_auto_activate_is_not_for_production(client, db, ready):
    await ready(name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/prod", headers=h, json={"auto_activate": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "auto_activate_not_allowed")


async def test_activate_needs_change(client, db, ready):
    await ready()
    h = await auth_headers(client, db, email="v@test.example.com", roles=("admin",))
    assert (await _activate(client, h, "uat9", slot="purple")).status_code == 403
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_deploy_do_activate_api.py tests/test_deploy_playbooks.py -k "activate or deactivate"`
Expected: FAIL (404 on the route; `smoke` unknown).

- [ ] **Step 3: Plans**

In `sirdar/api/src/sirdar_api/deploy/steps.py`, add `smoke: bool = True` to `plan_for` and `_cloud_plan`, and in `_cloud_plan`, before the `go_live` handling:

```python
    if mode == "activate":
        return keys if smoke else ("go_live",)        # Deactivate: no slot to test
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`:

```python
def smokes(dep: Deployment) -> bool:
    """Activate tests the slot first; Deactivate (no slot) has nothing to test."""
    return not (dep.mode == "activate" and dep.slot is None)
```

`plan_of` passes `smoke=smokes(dep)`; `create_deployment` passes `smoke=not (mode == "activate" and slot is None)`.

- [ ] **Step 4: `auto_activate` in PATCH**

In `sirdar/api/src/sirdar_api/deploy/environments.py`, `update`, next to the `retiring` branch:

```python
    if fields.get("auto_activate") is not None:
        if not on_do or env.type == "production":
            raise EnvError("auto_activate_not_allowed")
        put("auto_activate", bool(fields["auto_activate"]))
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, `EnvironmentPatch` gains `auto_activate: bool | None = None`.

- [ ] **Step 5: The Activate route**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

```python
class ActivateIn(BaseModel):
    # A slot to send traffic to; None (a retiring production only): none.
    slot: str | None = Field(default=None, max_length=10)
    confirm_name: str | None = Field(default=None, max_length=64)


@router.post("/environments/{name}/activate", status_code=201)
async def activate(name: str, body: ActivateIn, request: Request, db: DbSession,
                   actor: AuthContext = require_permission("deploy", "change")):
    """Blue/Green: smoke-test the slot on its droplet, then move the load
    balancer to it (a deployment, so it shares the lock, the log and Retry).
    Switching back is activating the other slot. A retiring production can
    be deactivated (slot None) before Delete."""
    env = await _environment(db, name)
    if not _on_do(env):
        raise HTTPException(status_code=409, detail={"code": "not_digitalocean_environment"})
    if env.type == "production" and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    if not vault.is_configured(get_settings()):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    await _require_account(db, env)
    if body.slot is None:
        if not (env.type == "production" and env.retiring):
            raise HTTPException(status_code=422, detail={"code": "slot_required"})
        if env.active_slot is None:
            raise HTTPException(status_code=409, detail={"code": "already_inactive"})
        return await _launch(db, env, request, actor, action="deploy.activate", mode="activate",
                             git_ref=env.git_ref, sha=env.current_sha or "", cloud=True,
                             slot=None, go_live=True)
    if body.slot not in env.slots:
        raise HTTPException(status_code=422, detail={"code": "slot_invalid"})
    if body.slot == env.active_slot:
        raise HTTPException(status_code=409, detail={"code": "slot_already_active"})
    if env.type == "production" and env.retiring:
        raise HTTPException(status_code=409, detail={"code": "production_retiring"})
    slot = (await do_envs.slots_of(db, env.id))[body.slot]
    if not slot.sha or not slot.public_ip:
        raise HTTPException(status_code=409, detail={"code": "slot_not_deployed"})
    cfg = await _host_target(db, env, slot=body.slot)
    await _pinned(db, cfg)
    return await _launch(db, env, request, actor, action="deploy.activate", mode="activate",
                         git_ref=slot.sha, sha=slot.sha, cloud=True, slot=body.slot,
                         go_live=True)
```

`_launch`'s audit `changes` already has `environment`, and adds `slot` and `go_live` for cloud deployments. Add `"activate"` to `RETRY_MODES` and `GATED_MODES` (a retry of an Activate needs `deploy:change` and the name typed back), and pass `smoke=pipeline.smokes(dep)` where the retry route builds its plan. Add `"activate": "Activate"` handling nowhere else: `serialize` shows the mode as is.

- [ ] **Step 6: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_deploy_do_activate_api.py tests/test_deploy_playbooks.py tests/test_deploy_do_deployments_api.py tests/test_deploy_pipeline_do.py tests/test_deploy_deployments_api.py`
Expected: all PASS.

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/environments.py src/sirdar_api/api/routes/deploy.py tests/test_deploy_do_activate_api.py tests/test_deploy_playbooks.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_do_activate_api.py sirdar/api/tests/test_deploy_playbooks.py
git commit -m "feat(sirdar): Activate and Deactivate slots, and auto-activate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Add a second slot, and grow sizes

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`POST /environments/{name}/slots`; PATCH `do`)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_envs.py` (`check_grow`, `apply_sizes`)
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (PATCH `do`)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_provision.py` (step 0 resizes the deploy slot's droplet and the database)
- Create: `sirdar/api/tests/test_deploy_do_slots_and_sizes.py`

**Interfaces:**
- Consumes: `do_envs.add_slot`, `do_api.sizes()`, `do_api.database_options()`, `do_api.droplet_action`, `do_api.resize_database`, Task 1's `_launch`.
- Produces:
  - `async do_envs.check_grow(api, row, fields) -> dict` (the new values; DoEnvError `do_size_invalid | do_db_size_invalid | do_shrink_refused`);
  - `do_envs.apply_sizes(row, values) -> list[str]` (changed names, `do.droplet_size` …);
  - step 0: the deploy slot's droplet is resized (power off, resize with disk, power on) when its size differs from the record; the database is resized when its size or node count differs.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_do_slots_and_sizes.py`:

```python
"""A one-slot environment adds its second slot (and deploys the running
commit to it); sizes only grow, checked against DigitalOcean's catalogs;
step 0 resizes the slot it deploys and the database."""

import pytest
from sqlalchemy import update

from sirdar_api.db.models import DoEnvironment, DoSlot, Environment

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import do_build, do_cloud, make_do_environment  # noqa: F401
from .test_deploy_do_deployments_api import _deployed

URL = "/api/deploy/environments"


async def test_add_the_second_slot(client, db, do_build, fake_runner, fake_publisher,
                                   fake_provisioner):
    env = await make_do_environment(db, name="solo", slots=1)
    await _deployed(db, env)
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/solo/slots", headers=h)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["environment"]["slots"] == ["orange", "purple"]
    dep = body["deployment"]
    assert (dep["mode"], dep["slot"], dep["go_live"], dep["sha"]) == (
        "update", "purple", False, body["environment"]["current_sha"])
    assert (await db.get(DoSlot, (env.id, "purple"))).host_key_private_enc is not None
    resp = await client.post(f"{URL}/solo/slots", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) in (
        (409, "slots_full"), (409, "deploy_in_progress"))


async def test_a_new_environment_adds_the_slot_without_deploying(client, db, do_build):
    await make_do_environment(db, name="solo", slots=1)
    h = await auth_headers(client, db)
    body = (await client.post(f"{URL}/solo/slots", headers=h)).json()
    assert body["deployment"] is None and body["environment"]["slots"] == ["orange", "purple"]


async def test_production_has_its_slots(client, db, do_build):
    await make_do_environment(db, name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/prod/slots", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "slot_not_allowed")


@pytest.mark.parametrize("do, status, code", [
    ({"droplet_size": "s-4vcpu-8gb"}, 200, None),
    ({"droplet_size": "s-1vcpu-2gb"}, 422, "do_shrink_refused"),
    ({"droplet_size": "s-99vcpu-1tb"}, 422, "do_size_invalid"),
    ({"db_size": "db-s-4vcpu-8gb"}, 200, None),
    ({"db_size": "db-s-1vcpu-1gb"}, 422, "do_shrink_refused"),
    ({"db_standby": True}, 200, None),
])
async def test_sizes_only_grow(client, db, do_build, do, status, code):
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"do": do})
    assert resp.status_code == status, resp.text
    if code:
        assert resp.json()["detail"]["code"] == code
    else:
        row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
        key, value = next(iter(do.items()))
        assert getattr(row, key) == value


async def test_standby_never_goes_away(client, db, do_build):
    await db.execute(update(DoEnvironment).where(
        DoEnvironment.environment_id == do_build.env.id).values(db_standby=True))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"do": {"db_standby": False}})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "do_shrink_refused")


async def test_step_0_resizes_the_slot_it_deploys_and_the_database(db, do_build):
    await do_build.run()
    await db.execute(update(DoEnvironment).where(
        DoEnvironment.environment_id == do_build.env.id).values(
        droplet_size="s-4vcpu-8gb", db_size="db-s-4vcpu-8gb", db_standby=True))
    await db.commit()
    await do_build.run(slot="purple", go_live=False)
    fake = do_build.cloud.do
    sizes = {d["name"]: d["size_slug"] for d in fake.droplets.values()}
    assert sizes == {"ss-uat9-orange": "s-2vcpu-4gb", "ss-uat9-purple": "s-4vcpu-8gb"}
    (database,) = fake.databases.values()
    assert (database["size"], database["num_nodes"]) == ("db-s-4vcpu-8gb", 2)
    assert "Resizing ss-uat9-purple to s-4vcpu-8gb" in do_build.log()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_deploy_do_slots_and_sizes.py`
Expected: FAIL.

- [ ] **Step 3: Grow checks**

Append to `sirdar/api/src/sirdar_api/deploy/do_envs.py`:

```python
def _droplet_size(catalog: list[dict], slug: str) -> dict:
    found = next((s for s in catalog if s.get("slug") == slug), None)
    if found is None or not found.get("available", True):
        raise DoEnvError("do_size_invalid")
    return found


def _db_rank(options: dict, slug: str, nodes: int) -> int:
    layouts = ((options.get("pg") or {}).get("layouts")) or []
    sizes = next((lay.get("sizes") or [] for lay in layouts if lay.get("num_nodes") == nodes), [])
    if slug not in sizes:
        raise DoEnvError("do_db_size_invalid")
    return sizes.index(slug)          # DigitalOcean lists them smallest first


async def check_grow(api, row: DoEnvironment, fields: dict) -> dict:
    """The sizes a PATCH asks for, checked against DigitalOcean's catalogs:
    a droplet size with at least the vCPUs, memory and disk it has, a
    database size at least as large, a standby node that is never removed."""
    if not isinstance(fields, dict) or set(fields) - {"droplet_size", "db_size", "db_standby"}:
        raise DoEnvError("do_invalid")
    out: dict = {}
    if fields.get("droplet_size") and fields["droplet_size"] != row.droplet_size:
        catalog = await api.sizes()
        old, new = _droplet_size(catalog, row.droplet_size), _droplet_size(
            catalog, fields["droplet_size"])
        if any(int(new.get(k) or 0) < int(old.get(k) or 0) for k in ("vcpus", "memory", "disk")):
            raise DoEnvError("do_shrink_refused")
        out["droplet_size"] = fields["droplet_size"]
    standby = fields.get("db_standby")
    if standby is not None and not isinstance(standby, bool):
        raise DoEnvError("do_invalid")
    if standby is False and row.db_standby:
        raise DoEnvError("do_shrink_refused")
    nodes = 2 if (standby or row.db_standby) else 1
    if fields.get("db_size") and fields["db_size"] != row.db_size:
        options = await api.database_options()
        if _db_rank(options, fields["db_size"], nodes) < _db_rank(options, row.db_size, nodes):
            raise DoEnvError("do_shrink_refused")
        out["db_size"] = fields["db_size"]
    if standby and not row.db_standby:
        out["db_standby"] = True
    return out


def apply_sizes(row: DoEnvironment, values: dict) -> list[str]:
    changed = [f"do.{k}" for k, v in values.items() if getattr(row, k) != v]
    for key, value in values.items():
        setattr(row, key, value)
    if changed:
        row.updated_at = datetime.now(UTC)
    return changed
```

- [ ] **Step 4: PATCH `do` and the slots route**

In `sirdar/api/src/sirdar_api/deploy/environments.py`, `update` takes the checked values in `fields["do_checked"]` (the route calls DigitalOcean first):

```python
    if fields.get("do_checked") is not None:
        row = await do_envs.get(db, env.id) if on_do else None
        if row is None:
            raise EnvError("do_not_allowed")
        changed += do_envs.apply_sizes(row, fields["do_checked"])
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

```python
class DoPatch(BaseModel):
    droplet_size: str | None = Field(default=None, max_length=40)
    db_size: str | None = Field(default=None, max_length=40)
    db_standby: bool | None = None
```

`EnvironmentPatch` gains `do: DoPatch | None = None`. In `update_environment`, before `environments.update`:

```python
    if body.do is not None:
        if not _on_do(env):
            raise HTTPException(status_code=422, detail={"code": "do_not_allowed"})
        row = await do_envs.get(db, env.id)
        account = await do_accounts.require(db, get_settings(), row.account_key)
        try:
            async with do_api.connect(account.token) as api:
                fields["do_checked"] = await do_envs.check_grow(
                    api, row, body.do.model_dump(exclude_none=True))
        except do_envs.DoEnvError as e:
            raise HTTPException(status_code=422, detail={"code": e.code}) from None
        except do_api.DoError as e:
            raise HTTPException(status_code=502, detail={"code": "connect_failed",
                                                         "reason": e.reason}) from None
        fields.pop("do", None)
```

(wrap `do_accounts.require` the way `_require_account` does). Add:

```python
@router.post("/environments/{name}/slots", status_code=201)
async def add_slot(name: str, request: Request, db: DbSession,
                   actor: AuthContext = require_permission("deploy", "change")):
    """A one-slot environment gets its second slot (purple): step 0 of the
    deployment this starts builds its droplet and adds it to the database's
    trusted sources, then the running commit is deployed to it. Without a
    commit yet, the next Update builds it."""
    env = await _environment(db, name)
    if not _on_do(env):
        raise HTTPException(status_code=409, detail={"code": "not_digitalocean_environment"})
    if env.type == "production":
        raise HTTPException(status_code=422, detail={"code": "slot_not_allowed"})
    if len(env.slots) != 1:
        raise HTTPException(status_code=409, detail={"code": "slots_full"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    settings = get_settings()
    if not vault.is_configured(settings):
        raise HTTPException(status_code=400, detail={"code": "secrets_key_missing"})
    await do_envs.add_slot(db, settings, env, "purple")
    env.slots = [*env.slots, "purple"]
    env_name = env.name
    audit(db, actor_id=actor.user.person_id, action="deploy.slot_add", entity_type="environment",
          entity_id=env_name, ip=client_ip(request), changes={"environment": env_name,
                                                             "slot": "purple"})
    await db.commit()
    deployment = None
    if env.current_sha:
        await _require_account(db, env)
        await _require_integrations(db, env)
        deployment = await _launch(db, env, request, actor, action="deploy.deployment_start",
                                   mode="update", git_ref=env.current_sha, sha=env.current_sha,
                                   cloud=True, slot="purple", go_live=False)
    await db.refresh(env)
    return {"environment": await serialize.environment_out(db, env), "deployment": deployment}
```

- [ ] **Step 5: Step 0 resizes**

In `sirdar/api/src/sirdar_api/deploy/do_provision.py`, at the end of `_droplets` (after the readiness loop), resize the slot this deployment deploys:

```python
        droplet = found[ctx.slot]
        if droplet.get("size_slug") != ctx.droplet_size:
            found[ctx.slot] = await self._resize_droplet(api, ctx, droplet, out)
        return found
```

and add:

```python
    async def _resize_droplet(self, api: DigitalOceanApi, ctx: DoContext, droplet: dict,
                              out: Output) -> dict:
        """Only the slot being deployed (it isn't live, unless the environment
        has one slot): power off, resize with its disk, power on."""
        name, did = droplet["name"], str(droplet["id"])
        out(f"Resizing {name} to {ctx.droplet_size} (the droplet stops for a few minutes).\n")
        await api.droplet_action(did, "power_off")
        await self._wait(lambda: api.droplet(did), lambda d: d.get("status") == "off",
                         self._waits["droplet"], f"The droplet {name}")
        await api.droplet_action(did, "resize", size=ctx.droplet_size, disk=True)
        await self._wait(lambda: api.droplet(did),
                         lambda d: d.get("size_slug") == ctx.droplet_size,
                         self._waits["droplet"], f"The resize of {name}")
        for _ in range(self._tries(self._waits["droplet"])):
            try:
                await api.droplet_action(did, "power_on")
                break
            except DoError as e:
                if e.status != 422:              # still resizing
                    raise
                await self._sleep(self._poll)
        return await self._wait(lambda: api.droplet(did), lambda d: d.get("status") == "active",
                                self._waits["droplet"], f"The droplet {name}")
```

In `_database`, after the firewall and before waiting for `online`:

```python
        nodes = 2 if ctx.db_standby else 1
        live = await api.database(database["id"]) or database
        if live.get("size") != ctx.db_size or int(live.get("num_nodes") or 1) != nodes:
            await api.resize_database(database["id"], ctx.db_size, nodes)
            out(f"Resizing the database to {ctx.db_size}, {nodes} node"
                f"{'s' if nodes > 1 else ''}.\n")
```

- [ ] **Step 6: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_deploy_do_slots_and_sizes.py tests/test_deploy_do_provision.py tests/test_deploy_do_environments.py`
Expected: all PASS. (`test_a_second_run_changes_nothing` still holds: nothing differs from the record.)

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/do_envs.py src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/do_provision.py src/sirdar_api/api/routes/deploy.py tests/test_deploy_do_slots_and_sizes.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/do_envs.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/do_provision.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_do_slots_and_sizes.py
git commit -m "feat(sirdar): add a second slot, and grow droplet and database sizes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The cert-worker (ServerSherpa API image)

**Files:**
- Create: `api/src/serversherpa/certs/__init__.py`, `api/src/serversherpa/certs/acme.py` (a byte-identical copy of `sirdar/api/src/sirdar_api/deploy/acme.py`), `api/src/serversherpa/certs/worker.py`
- Modify: `api/src/serversherpa/config.py` (`cert_*` settings), `api/src/serversherpa/cli.py` (`cert-worker`)
- Modify: `deploy/stack/api/compose.yml` (the `cert-worker` service, profile `certs`), `deploy/stack/ss-stack` (`--profile certs` for the api stack on droplets)
- Create: `api/tests/test_cert_worker.py`
- Modify: `sirdar/api/tests/test_deploy_stack_external.py`

**Interfaces:**
- Consumes: 7a's `acme.py` (copied, not imported: the api can't import Sirdar).
- Produces:
  - `Settings.cert_do_token: SecretStr | None`, `cert_lb_id: str`, `cert_names: str` (comma-separated), `cert_env: str`, `cert_acme_directory: str`, `cert_acme_key: SecretStr | None` (base64 of the PEM), `cert_droplet_id: str`, `cert_challenge_port: int = 8089`.
  - `worker.WorkerConfig`, `worker.config_from(settings) -> WorkerConfig | None`, `worker.Challenges` (`.tokens`, `.solver`, `async .start(host, port)`), `async worker.check_once(cfg, *, challenges, transports=None, now=None, try_lock=None, sleep=asyncio.sleep, poll=acme.POLL_SECONDS, renew_days=RENEW_DAYS) -> str` (`"not_active" | "fresh" | "locked" | "renewed"`), `worker.advisory_lock()`, `async worker.run_forever(*, once=False, renew_days=RENEW_DAYS)`, `worker.RENEW_DAYS = 30`; CLI `serversherpa cert-worker [--once] [--renew-days N]`.
  - The `.env` keys Task 4 renders: `SS_CERT_DO_TOKEN`, `SS_CERT_LB_ID`, `SS_CERT_NAMES`, `SS_CERT_ACME_DIRECTORY`, `SS_CERT_ACME_KEY` (and `STACK_ENV`, `STACK_DROPLET_ID`, already there).

- [ ] **Step 1: Copy the ACME client**

```bash
mkdir -p api/src/serversherpa/certs
cp sirdar/api/src/sirdar_api/deploy/acme.py api/src/serversherpa/certs/acme.py
```

Create `api/src/serversherpa/certs/__init__.py`:

```python
"""Certificates for environments Sirdar builds on DigitalOcean (deploy
phase 7): the cert-worker renews the load balancer's Let's Encrypt
certificate. acme.py is a byte-identical copy of Sirdar's
sirdar_api/deploy/acme.py (a Sirdar test compares them)."""
```

- [ ] **Step 2: Write the failing tests**

Create `api/tests/test_cert_worker.py`:

```python
"""The cert-worker: it renews only from the droplet the load balancer sends
traffic to, only inside 30 days, only while it holds the advisory lock; a
renewal uploads the new certificate, moves the load balancer to it and
deletes the old one. ACME itself is tested in Sirdar (the same acme.py);
here acme.issue is replaced. Tokens never reach a log or repr()."""

import asyncio
import base64
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from serversherpa.certs import acme, worker

TOKEN = "dop_v1_" + "ab" * 32
KEY_PEM = acme.new_key_pem()
NAMES = ("api.uat9.serversherpa.com", "portal.uat9.serversherpa.com")
NOW = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)


def _cfg(**over) -> worker.WorkerConfig:
    base = dict(token=TOKEN, lb_id="lb-1", names=NAMES, env="uat9",
                directory="https://acme.test/directory", key_pem=KEY_PEM, droplet_id="4001",
                port=0)
    return worker.WorkerConfig(**{**base, **over})


class FakeDo:
    """The renewal token's view: one load balancer and its certificates."""

    def __init__(self, days_left: int, targets: list[int]):
        self.certs = {"old": {"id": "old", "name": "ss-uat9-202609010000",
                              "not_after": (NOW + timedelta(days=days_left))
                              .strftime("%Y-%m-%dT%H:%M:%SZ"), "dns_names": list(NAMES)}}
        self.lb = {"id": "lb-1", "name": "ss-uat9-lb", "region": {"slug": "nyc3"},
                   "size_unit": 1, "vpc_uuid": "vpc-1", "droplet_ids": targets,
                   "redirect_http_to_https": False,
                   "health_check": {"protocol": "http", "port": 80, "path": "/healthz"},
                   "forwarding_rules": [
                       {"entry_protocol": "https", "entry_port": 443, "target_protocol": "http",
                        "target_port": 80, "certificate_id": "old"},
                       {"entry_protocol": "http", "entry_port": 80, "target_protocol": "http",
                        "target_port": 80}]}
        self.calls: list[tuple[str, str]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        path, method = request.url.path.removeprefix("/v2"), request.method
        self.calls.append((method, path))
        if path == "/load_balancers/lb-1" and method == "GET":
            return httpx.Response(200, json={"load_balancer": self.lb})
        if path == "/load_balancers/lb-1" and method == "PUT":
            self.lb = {**self.lb, **json.loads(request.content)}
            return httpx.Response(200, json={"load_balancer": self.lb})
        if path.startswith("/certificates/") and method == "GET":
            cert = self.certs.get(path.rsplit("/", 1)[1])
            return (httpx.Response(200, json={"certificate": cert}) if cert
                    else httpx.Response(404, json={"id": "not_found"}))
        if path == "/certificates" and method == "POST":
            body = json.loads(request.content)
            self.certs["new"] = {"id": "new", "name": body["name"], "dns_names": list(NAMES),
                                 "not_after": "2027-01-03T12:00:00Z"}
            return httpx.Response(201, json={"certificate": self.certs["new"]})
        if path.startswith("/certificates/") and method == "DELETE":
            self.certs.pop(path.rsplit("/", 1)[1], None)
            return httpx.Response(204)
        return httpx.Response(404, json={"id": "not_found"})


def _issued() -> acme.Issued:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, NAMES[0])])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(1)
            .not_valid_before(NOW).not_valid_after(NOW + timedelta(days=90))
            .sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    key_pem = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.TraditionalOpenSSL,
                                serialization.NoEncryption()).decode()
    return acme.Issued(key_pem=key_pem, leaf_pem=pem, chain_pem=pem, not_after=NOW,
                       names=NAMES)


@asynccontextmanager
async def _lock(got: bool = True):
    yield got


async def _check(fake: FakeDo, monkeypatch, *, locked=False):
    async def fake_issue(client, names, kind, solve):
        assert kind == "http-01" and tuple(names) == NAMES
        return _issued()
    monkeypatch.setattr(acme, "issue", fake_issue)
    return await worker.check_once(
        _cfg(), challenges=worker.Challenges(), now=NOW,
        transports={"digitalocean": httpx.MockTransport(fake.handler)},
        try_lock=lambda: _lock(not locked))


def test_config_from_settings_hides_secrets():
    from serversherpa.config import get_settings
    settings = get_settings().model_copy(update={
        "cert_do_token": None, "cert_lb_id": "", "cert_names": ""})
    assert worker.config_from(settings) is None
    from pydantic import SecretStr
    settings = settings.model_copy(update={
        "cert_do_token": SecretStr(TOKEN), "cert_lb_id": "lb-1",
        "cert_names": ",".join(NAMES), "cert_env": "uat9", "cert_droplet_id": "4001",
        "cert_acme_key": SecretStr(base64.b64encode(KEY_PEM.encode()).decode())})
    cfg = worker.config_from(settings)
    assert (cfg.names, cfg.droplet_id, cfg.key_pem) == (NAMES, "4001", KEY_PEM)
    assert TOKEN not in repr(cfg) and "PRIVATE KEY" not in repr(cfg)


async def test_only_the_active_slot_renews(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4002])
    assert await _check(fake, monkeypatch) == "not_active"
    assert ("POST", "/certificates") not in fake.calls


async def test_nothing_to_do_outside_30_days(monkeypatch):
    fake = FakeDo(days_left=45, targets=[4001])
    assert await _check(fake, monkeypatch) == "fresh"


async def test_another_worker_holds_the_lock(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    assert await _check(fake, monkeypatch, locked=True) == "locked"


async def test_renewal_swaps_the_certificate(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    assert await _check(fake, monkeypatch) == "renewed"
    https = next(r for r in fake.lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == "new" and fake.lb["droplet_ids"] == [4001]
    assert fake.certs["new"]["name"] == "ss-uat9-202610051200" and "old" not in fake.certs
    assert fake.calls.index(("PUT", "/load_balancers/lb-1")) < fake.calls.index(
        ("DELETE", "/certificates/old"))


async def test_the_challenge_server_answers_tokens():
    challenges = worker.Challenges()
    server = await challenges.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    async def get(path: str) -> bytes:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(f"GET {path} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        await writer.drain()
        data = await reader.read()
        writer.close()
        return data

    try:
        async with challenges.solver("http-01", NAMES[0], "tok123", "tok123.thumb"):
            assert (await get("/.well-known/acme-challenge/tok123")).endswith(b"tok123.thumb")
        assert b" 404 " in await get("/.well-known/acme-challenge/tok123")
        assert b" 404 " in await get("/anything-else")
    finally:
        server.close()
        await server.wait_closed()


async def test_the_advisory_lock_is_single(db):
    async with worker.advisory_lock() as first:
        assert first is True
        async with worker.advisory_lock() as second:
            assert second is False
    async with worker.advisory_lock() as again:
        assert again is True
```

Append to `sirdar/api/tests/test_deploy_stack_external.py`:

```python
def test_the_api_stack_runs_the_cert_worker_only_on_droplets(tmp_path):
    log, _ = _run(tmp_path, "up", str(_env_dir(tmp_path, external=True)))
    assert re.search(r"api/compose.yml --profile certs up -d", log)
    local = tmp_path / "local"
    local.mkdir()
    log, _ = _run(local, "up", str(_env_dir(local, external=False)))
    assert "--profile certs" not in log


def test_the_acme_copies_match():
    sirdar = REPO / "sirdar" / "api" / "src" / "sirdar_api" / "deploy" / "acme.py"
    api = REPO / "api" / "src" / "serversherpa" / "certs" / "acme.py"
    assert sirdar.read_bytes() == api.read_bytes(), "change both copies of acme.py together"
```

- [ ] **Step 3: Run them to verify they fail**

```bash
cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_phase7b /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest -q tests/test_cert_worker.py
```

Expected: FAIL (`serversherpa.certs.worker` is missing).

- [ ] **Step 4: Settings**

In `api/src/serversherpa/config.py`, add a section (after the wiki settings):

```python
    # ── cert-worker (environments Sirdar builds on DigitalOcean) ─────
    # The account's renewal token: certificates and load balancers only.
    cert_do_token: SecretStr | None = None
    cert_lb_id: str = ""
    cert_names: str = ""                   # the public names, comma-separated
    cert_env: str = ""                     # certificates are named ss-<env>-<UTC time>
    cert_acme_directory: str = "https://acme-v02.api.letsencrypt.org/directory"
    cert_acme_key: SecretStr | None = None # base64 of this environment's ACME account key
    cert_droplet_id: str = ""              # the droplet this worker runs on
    cert_challenge_port: int = 8089
```

- [ ] **Step 5: The worker**

Create `api/src/serversherpa/certs/worker.py`:

```python
"""The cert-worker (Sirdar deploy phase 7): keeps a DigitalOcean
environment's load balancer certificate fresh with Let's Encrypt HTTP-01.

Both slots of an environment run one, against the shared database. Only
the one on the droplet the load balancer targets renews (the challenge
reaches the active slot only), and only while it holds a Postgres advisory
lock, at 30 days or fewer. Renewing uploads a new custom certificate named
ss-<env>-<UTC yyyymmddhhmm>, moves the load balancer's HTTPS rule to it and
deletes the old one. Caddy sends /.well-known/acme-challenge/* here (:8089).

Sirdar renews too, by DNS-01, at 14 days or fewer: the backup. The DigitalOcean
token here is the account's renewal token (certificates and load balancers
only). Nothing here logs a token, a key or a certificate."""

import asyncio
import base64
import binascii
import logging
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
from sqlalchemy import text

from serversherpa.certs import acme
from serversherpa.config import Settings, get_settings
from serversherpa.db.engine import get_engine

log = logging.getLogger(__name__)

DO_API = "https://api.digitalocean.com/v2"
RENEW_DAYS = 30
CHECK_SECONDS = 24 * 3600
FIRST_CHECK_SECONDS = 5 * 60
LOCK_KEY = 0x5353434552545752           # "SSCERTWR"
CHALLENGE_PREFIX = "/.well-known/acme-challenge/"


class CertWorkerError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class WorkerConfig:
    token: str = field(repr=False)
    lb_id: str = ""
    names: tuple[str, ...] = ()
    env: str = ""
    directory: str = acme.LETSENCRYPT
    key_pem: str = field(default="", repr=False)
    droplet_id: str = ""
    port: int = 8089


def config_from(settings: Settings) -> WorkerConfig | None:
    """None when this isn't a DigitalOcean droplet (or a value is missing)."""
    names = tuple(n.strip() for n in settings.cert_names.split(",") if n.strip())
    if (settings.cert_do_token is None or settings.cert_acme_key is None
            or not settings.cert_lb_id or not names or not settings.cert_env
            or not settings.cert_droplet_id.isdecimal()):
        return None
    try:
        key_pem = base64.b64decode(settings.cert_acme_key.get_secret_value()).decode()
    except (binascii.Error, UnicodeDecodeError):
        return None
    return WorkerConfig(token=settings.cert_do_token.get_secret_value(), lb_id=settings.cert_lb_id,
                        names=names, env=settings.cert_env,
                        directory=settings.cert_acme_directory, key_pem=key_pem,
                        droplet_id=settings.cert_droplet_id, port=settings.cert_challenge_port)


class Challenges:
    """Answers GET /.well-known/acme-challenge/<token> while a solver holds it."""

    def __init__(self):
        self.tokens: dict[str, str] = {}

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = (await asyncio.wait_for(reader.readline(), 10)).decode("latin-1")
            parts = line.split()
            path = parts[1] if len(parts) >= 2 else ""
            answer = (self.tokens.get(path.removeprefix(CHALLENGE_PREFIX))
                      if path.startswith(CHALLENGE_PREFIX) else None)
            if answer is None:
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n"
                             b"Connection: close\r\n\r\n")
            else:
                body = answer.encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
                             + f"Content-Length: {len(body)}\r\n".encode()
                             + b"Connection: close\r\n\r\n" + body)
            await writer.drain()
        except (TimeoutError, ConnectionError, UnicodeError):
            pass
        finally:
            writer.close()

    async def start(self, host: str, port: int) -> asyncio.Server:
        return await asyncio.start_server(self._handle, host, port)

    @asynccontextmanager
    async def solver(self, kind: str, name: str, token: str, key_auth: str):
        self.tokens[token] = key_auth
        try:
            yield
        finally:
            self.tokens.pop(token, None)


@asynccontextmanager
async def advisory_lock():
    """True while this worker is the only renewer (both slots share the
    database); False when another holds it."""
    async with get_engine().connect() as conn:
        got = bool(await conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}))
        try:
            yield got
        finally:
            if got:
                await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})


async def _do(client: httpx.AsyncClient, method: str, path: str, body: dict | None = None,
              *, missing_ok: bool = False) -> dict:
    try:
        resp = await client.request(method, path, json=body)
    except httpx.HTTPError:
        raise CertWorkerError("Couldn't reach the DigitalOcean API.") from None
    if missing_ok and resp.status_code == 404:
        return {}
    if resp.status_code >= 400:
        raise CertWorkerError(f"DigitalOcean answered with HTTP {resp.status_code}.")
    if resp.status_code == 204 or not resp.content:
        return {}
    try:
        return resp.json()
    except ValueError:
        raise CertWorkerError("DigitalOcean sent a response the worker didn't understand.") \
            from None


def _https_certificate(lb: dict) -> str | None:
    return next((r.get("certificate_id") for r in lb.get("forwarding_rules") or []
                 if r.get("entry_protocol") == "https"), None)


def _lb_body(lb: dict, certificate_id: str) -> dict:
    """A PUT replaces the whole load balancer: everything it has, with the
    HTTPS rule on the new certificate (Sirdar's do_provision.lb_update_body)."""
    region = lb.get("region")
    rules = [{**r, "certificate_id": certificate_id} if r.get("entry_protocol") == "https"
             else r for r in lb.get("forwarding_rules") or []]
    return {"name": lb.get("name"),
            "region": region.get("slug") if isinstance(region, dict) else region,
            "size_unit": lb.get("size_unit") or 1, "vpc_uuid": lb.get("vpc_uuid"),
            "forwarding_rules": rules, "health_check": lb.get("health_check"),
            "droplet_ids": lb.get("droplet_ids") or [],
            "redirect_http_to_https": bool(lb.get("redirect_http_to_https"))}


def _days_left(cert: dict | None, now: datetime) -> float | None:
    try:
        when = datetime.strptime(str((cert or {}).get("not_after")),
                                 "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None
    return (when - now).total_seconds() / 86400


async def check_once(cfg: WorkerConfig, *, challenges: Challenges,
                     transports: dict | None = None, now: datetime | None = None,
                     try_lock: Callable[[], AbstractAsyncContextManager[bool]] | None = None,
                     sleep=asyncio.sleep, poll: float = acme.POLL_SECONDS,
                     renew_days: float = RENEW_DAYS) -> str:
    transports = transports or {}
    now = now or datetime.now(UTC)
    async with httpx.AsyncClient(base_url=DO_API, timeout=30,
                                 headers={"Authorization": f"Bearer {cfg.token}"},
                                 transport=transports.get("digitalocean")) as do:
        lb = (await _do(do, "GET", f"/load_balancers/{cfg.lb_id}"))["load_balancer"]
        if int(cfg.droplet_id) not in [int(d) for d in lb.get("droplet_ids") or []]:
            return "not_active"
        old = _https_certificate(lb)
        cert = (await _do(do, "GET", f"/certificates/{old}", missing_ok=True)).get(
            "certificate") if old else None
        left = _days_left(cert, now)
        if left is not None and left > renew_days:
            return "fresh"
        async with (try_lock or advisory_lock)() as got:
            if not got:
                return "locked"
            async with acme.AcmeClient(cfg.directory, cfg.key_pem,
                                       transport=transports.get("acme"), sleep=sleep,
                                       poll=poll) as client:
                issued = await acme.issue(client, cfg.names, "http-01", challenges.solver)
            name = f"ss-{cfg.env}-{now:%Y%m%d%H%M}"
            made = (await _do(do, "POST", "/certificates", {
                "name": name, "type": "custom", "private_key": issued.key_pem,
                "leaf_certificate": issued.leaf_pem,
                "certificate_chain": issued.chain_pem}))["certificate"]
            lb = (await _do(do, "GET", f"/load_balancers/{cfg.lb_id}"))["load_balancer"]
            await _do(do, "PUT", f"/load_balancers/{cfg.lb_id}", _lb_body(lb, made["id"]))
            if old and old != made["id"]:
                await _do(do, "DELETE", f"/certificates/{old}", missing_ok=True)
            return "renewed"


async def run_forever(*, once: bool = False, renew_days: float = RENEW_DAYS) -> str | None:
    """The service: a check a few minutes after start, then daily. `once`
    (the CLI's --once, for an operator who stopped the service first): one
    check right away, its outcome returned; `renew_days` forces a renewal
    when raised past the days left."""
    settings = get_settings()
    cfg = config_from(settings)
    if cfg is None:
        log.info("cert-worker: not a DigitalOcean droplet (SS_CERT_* unset); idle")
        if once:
            return "not_configured"
        while True:
            await asyncio.sleep(CHECK_SECONDS)
    challenges = Challenges()
    server = await challenges.start("0.0.0.0", cfg.port)
    log.info("cert-worker: answering HTTP-01 on :%s", cfg.port)
    try:
        if once:
            return await check_once(cfg, challenges=challenges, renew_days=renew_days)
        await asyncio.sleep(FIRST_CHECK_SECONDS)
        while True:
            try:
                outcome = await check_once(cfg, challenges=challenges)
                log.info("cert-worker: %s", outcome)
            except CertWorkerError as e:
                log.warning("cert-worker: %s", e.reason)
            except acme.AcmeError as e:
                log.warning("cert-worker: %s", e.reason)
            # Never stop the loop; never log the text of an unknown error.
            except Exception as e:  # noqa: BLE001
                log.warning("cert-worker: check failed (%s)", type(e).__name__)
            await asyncio.sleep(CHECK_SECONDS)
    finally:
        server.close()
```

- [ ] **Step 6: The CLI command**

In `api/src/serversherpa/cli.py`, after `db_testing_worker`:

```python
@app.command(name="cert-worker")
def cert_worker(
    once: bool = typer.Option(False, help="One check now, print its outcome, then exit "
                                          "(stop the cert-worker service first: it owns :8089)"),
    renew_days: float = typer.Option(30.0, help="Renew at this many days left or fewer "
                                                "(raise it to force a renewal)"),
) -> None:
    """Run the cert-worker on a DigitalOcean droplet (Sirdar phase 7):
    renews the load balancer's Let's Encrypt certificate from the active
    slot. Idles where SS_CERT_* aren't set."""

    async def _run() -> None:
        from serversherpa.certs import worker

        try:
            outcome = await worker.run_forever(once=once, renew_days=renew_days)
            if once:
                typer.echo(outcome)
        finally:
            await dispose_engine()

    asyncio.run(_run())
```

- [ ] **Step 7: The compose service and `ss-stack`**

In `deploy/stack/api/compose.yml`, after `db-testing-worker`:

```yaml
  # DigitalOcean droplets only (ss-stack adds --profile certs when
  # STACK_CADDY=1): renews the load balancer's certificate by HTTP-01 from
  # the active slot; Caddy sends /.well-known/acme-challenge/* to :8089.
  # Only this service gets the renewal token and the ACME key.
  cert-worker:
    <<: *ss-service
    profiles: ["certs"]
    command: ["serversherpa", "cert-worker"]
    environment:
      <<: *ss-env
      SS_CERT_DO_TOKEN: ${SS_CERT_DO_TOKEN:-}
      SS_CERT_LB_ID: ${SS_CERT_LB_ID:-}
      SS_CERT_NAMES: ${SS_CERT_NAMES:-}
      SS_CERT_ENV: ${STACK_ENV}
      SS_CERT_ACME_DIRECTORY: ${SS_CERT_ACME_DIRECTORY:-https://acme-v02.api.letsencrypt.org/directory}
      SS_CERT_ACME_KEY: ${SS_CERT_ACME_KEY:-}
      SS_CERT_DROPLET_ID: ${STACK_DROPLET_ID:-}
```

In `deploy/stack/ss-stack`, make `dc` add the profile for the api stack on droplets:

```bash
dc() {  # dc <stack> <compose args…>
  local stack=$1; shift
  # On a droplet the api stack also runs the cert-worker (profile certs).
  if [[ $stack == api ]] && caddy; then set -- --profile certs "$@"; fi
  docker compose --env-file "$env_file" -f "$STACK_DIR/$stack/compose.yml" "$@"
}
```

(`caddy` is defined before `dc` is first called; move its definition above `dc` if needed.)

- [ ] **Step 8: Run the tests**

```bash
cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_phase7b /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest -q tests/test_cert_worker.py
cd ../sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_deploy_stack_external.py
```

Expected: all PASS (the Docker compose test also renders the `cert-worker` service where Docker exists).

- [ ] **Step 9: Lint and commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar
/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check api/src/serversherpa/certs api/src/serversherpa/cli.py api/src/serversherpa/config.py api/tests/test_cert_worker.py
bash -n deploy/stack/ss-stack
git add api/src/serversherpa/certs/__init__.py api/src/serversherpa/certs/acme.py api/src/serversherpa/certs/worker.py api/src/serversherpa/config.py api/src/serversherpa/cli.py api/tests/test_cert_worker.py deploy/stack/api/compose.yml deploy/stack/ss-stack sirdar/api/tests/test_deploy_stack_external.py
git commit -m "feat(api): cert-worker renews DigitalOcean load balancer certificates by HTTP-01

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Sirdar's side of renewal — the worker's `.env`, the `renew` deployment and the 6-hourly check

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/envfile.py` (`EXTRA_KEYS`), `do_envs.py` (`env_extra` adds the worker's keys)
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (`renew` mode, step 19), `pipeline.py` (`renew` keeps the environment's status), `do_provision.py` (`do_renew`)
- Create: `sirdar/api/src/sirdar_api/deploy/renewals.py`
- Modify: `sirdar/api/src/sirdar_api/config.py` (`cert_check_seconds`), `sirdar/api/src/sirdar_api/api/app.py` (the loop)
- Modify: `sirdar/api/tests/test_deploy_do_environments.py` (`test_env_extra`'s expected keys)
- Create: `sirdar/api/tests/test_deploy_do_renewals.py`

**Interfaces:**
- Consumes: Task 3's `.env` keys; 7a's `_certificate`, `_live_lb`, `_retire_certificates`, `_rules`, `lb_update_body`, `https_certificate`.
- Produces:
  - `envfile.EXTRA_KEYS` ends with `SS_CERT_DO_TOKEN, SS_CERT_LB_ID, SS_CERT_NAMES, SS_CERT_ACME_DIRECTORY, SS_CERT_ACME_KEY`; `env_extra` returns them (the renewal token and the key among the secrets) and lists `"load balancer"` and `"renewal token"` under `missing` when absent.
  - `steps.MODES` adds `"renew"`; `StepDef(19, "do_renew", "Renew certificate", "", 30 * 60, "vm")`; cloud plan `("renew", False): ("do_renew",)`; `pipeline.KEEPS_STATUS` adds `"renew"`.
  - `renewals.due(db, now) -> list[Environment]`, `async renewals.start_due(now=None) -> list[str]`, `async renewals.loop(seconds)`; audit `deploy.certificate_renew`.
  - `Settings.cert_check_seconds: int = 21600` (0 turns the loop off).

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_do_environments.py`, in `test_env_extra`: add before the second `env_extra` call

```python
    await do_envs.record(env.id, "load_balancer", "lb-0001", "ss-uat9-lb")
```

and replace the `assert extra == {...}` with:

```python
    import base64
    key_pem = vault.decrypt(get_settings(), (await do_envs.get(db, env.id)).acme_key_enc)
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
        "STACK_DROPLET_ID": "4001", "SS_CERT_DO_TOKEN": DEV_RENEW_TOKEN,
        "SS_CERT_LB_ID": "lb-0001",
        "SS_CERT_NAMES": ",".join(f"{s}.uat9.serversherpa.com"
                                  for s in ("api", "portal", "kiosk", "wiki", "status")),
        "SS_CERT_ACME_DIRECTORY": "https://acme-v02.api.letsencrypt.org/directory",
        "SS_CERT_ACME_KEY": base64.b64encode(key_pem.encode()).decode()}
    assert set(secrets) == {extra["SS_DATABASE_URL"], "spaces-SECRET-1", DEV_RENEW_TOKEN,
                            extra["SS_CERT_ACME_KEY"]}
```

(import `DEV_RENEW_TOKEN` from `.fake_digitalocean`; the first `missing` list now ends with `"load balancer", "droplet"` — update that expectation to `["load balancer address", "VPC range", "database host", "Spaces key", "load balancer", "droplet"]`).

Create `sirdar/api/tests/test_deploy_do_renewals.py`:

```python
"""Sirdar, the backup renewer: every 6 hours it starts a `renew`
deployment for each DigitalOcean environment whose certificate has 14 days
or fewer left (and that isn't deploying); the renew step reconciles what the
cert-worker did, renews by DNS-01 when still due, and moves the load
balancer."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, Deployment, DoEnvironment, Environment
from sirdar_api.deploy import pipeline, renewals

from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    stop_pipeline,
)
from .do_helpers import do_build, make_do_environment  # noqa: F401
from .test_deploy_pipeline import SHA

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)


async def _env(db, name: str, *, days: int | None, deployed: bool = True) -> Environment:
    env = await make_do_environment(db, name=name, slots=1)
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        current_sha=SHA if deployed else None, status="ready", active_slot="orange"
        if deployed else None))
    await db.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env.id).values(
        cert_not_after=None if days is None else NOW + timedelta(days=days)))
    await db.commit()
    return env


async def test_start_due_picks_only_what_needs_it(db, do_build, fake_provisioner):
    await _env(db, "soon", days=10)
    await _env(db, "later", days=20)
    await _env(db, "fresh", days=None, deployed=False)
    started = await renewals.start_due(NOW)
    assert started == ["soon"]
    dep = (await db.scalars(select(Deployment).where(Deployment.mode == "renew"))).one()
    await pipeline.wait(dep.id)
    assert (dep.cloud, dep.actor_id) == (True, None)
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.certificate_renew"))).one()
    assert audit["environment"] == "soon"
    env = (await db.scalars(select(Environment).where(Environment.name == "soon")
                            .execution_options(populate_existing=True))).one()
    assert env.status == "ready"                       # a renew job keeps the status
    assert await renewals.start_due(NOW) == ["soon"]   # finished: due again until it renews


async def test_a_deploying_environment_waits(db, do_build):
    env = await _env(db, "busy", days=5)
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="running", cloud=True, slot="orange"))
    await db.commit()
    assert await renewals.start_due(NOW) == []


@pytest.mark.parametrize("days, renewed", [(10, True), (20, False)])
async def test_the_renew_step(db, do_build, days, renewed):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = (datetime.now(UTC) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    assert (cert["id"] in fake.certificates) is not renewed
    (lb,) = fake.load_balancers.values()
    https = next(r for r in lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == next(iter(fake.certificates))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_deploy_do_renewals.py tests/test_deploy_do_environments.py`
Expected: FAIL.

- [ ] **Step 3: The worker's `.env` keys**

In `sirdar/api/src/sirdar_api/deploy/envfile.py`, append to `EXTRA_KEYS`:

```python
    # the cert-worker (7b): only its service reads these
    "SS_CERT_DO_TOKEN", "SS_CERT_LB_ID", "SS_CERT_NAMES", "SS_CERT_ACME_DIRECTORY",
    "SS_CERT_ACME_KEY",
```

In `sirdar/api/src/sirdar_api/deploy/do_envs.py`, `env_extra` (import `base64`, `certs`, `do_accounts`, `DoResource` is already imported):

```python
    account = await do_accounts.load(db, settings, row.account_key)
    lb = await db.scalar(select(DoResource.do_id).where(
        DoResource.environment_id == env.id, DoResource.kind == "load_balancer"))
    missing = [label for label, value in (
        ("load balancer address", row.lb_ip), ("VPC range", row.vpc_ip_range),
        ("database host", row.db_host), ("Spaces key", row.spaces_key_id),
        ("load balancer", lb), ("droplet", slot_row.droplet_id if slot_row else None),
        ("renewal token", account.renewal_token if account else None)) if not value]
```

(the renewal token is checked last, so 7a's ordering of the earlier names stays) and add to `extra`:

```python
    acme_key = base64.b64encode(vault.decrypt(settings, row.acme_key_enc).encode()).decode()
    directory = settings.acme_staging_directory if row.acme_staging else settings.acme_directory
    extra |= {"SS_CERT_DO_TOKEN": account.renewal_token, "SS_CERT_LB_ID": lb,
              "SS_CERT_NAMES": ",".join(certs.public_names(env.base_domain)),
              "SS_CERT_ACME_DIRECTORY": directory, "SS_CERT_ACME_KEY": acme_key}
    return extra, [url, spaces_secret, account.renewal_token, acme_key]
```

- [ ] **Step 4: The `renew` mode and step 19**

In `sirdar/api/src/sirdar_api/deploy/steps.py`: add `"renew"` to `MODES`; append `StepDef(19, "do_renew", "Renew certificate", "", 30 * 60, "vm")` to `STEPS`; add `("renew", False): ("do_renew",)` to `_CLOUD_PLANS`; mention it in the docstring ("19 Renew certificate is Sirdar's backup renewal, a job of its own"). Update `test_plans`' `STEPS` number list in `tests/test_deploy_playbooks.py` to end with `17, 18, 19`, and its mode loop to `cloud = mode in ("activate", "renew")`.

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`: `KEEPS_STATUS = ("snapshot", "publish", "renew")`; in `_close`, `if mode not in ("snapshot", "publish", "renew"):` before marking the environment failed.

In `sirdar/api/src/sirdar_api/deploy/do_provision.py`: `STEPS = ("do_prepare", "go_live", "do_destroy", "do_renew")`; in `run`, `elif step == "do_renew": await self._renew(api, ctx, out)`; and add:

```python
    async def _renew(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        """Sirdar's backup renewal: what step 0 does for the certificate (record
        what the cert-worker uploaded, renew by DNS-01 at 14 days or fewer),
        then the load balancer's HTTPS rule and the old certificates."""
        records = await load_records(ctx.env_id)
        lb = await self._live_lb(api, ctx, records)
        cert = await self._certificate(api, ctx, out)
        if https_certificate(lb) != cert["id"]:
            await api.update_load_balancer(lb["id"], lb_update_body(
                lb, forwarding_rules=_rules(cert["id"])))
            out(f"Load balancer {lb['name']}: now uses the certificate {cert['name']}.\n")
        await self._retire_certificates(api, ctx, cert["id"], out)
```

- [ ] **Step 5: `renewals.py` and the loop**

Create `sirdar/api/src/sirdar_api/deploy/renewals.py`:

```python
"""Sirdar's backup certificate renewal for DigitalOcean environments (deploy
phase 7): every few hours, a `renew` deployment (step 19) for each
environment whose load balancer certificate has SIRDAR_RENEW_DAYS (14) or
fewer days left, unless it is deploying. A deployment, so it shares the
one-running-deployment lock with Activate, keeps a log and an audit row,
and can be retried. The cert-worker renews first (at 30 days); this only
catches what it missed."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import DoEnvironment, Environment
from sirdar_api.deploy import certs, environments, pipeline
from sirdar_api.services.audit import audit

log = logging.getLogger(__name__)
FIRST_DELAY_SECONDS = 5 * 60


async def due(db: AsyncSession, now: datetime) -> list[Environment]:
    rows = await db.scalars(
        select(Environment).join(DoEnvironment, DoEnvironment.environment_id == Environment.id)
        .where(DoEnvironment.cert_not_after.is_not(None),
               DoEnvironment.cert_not_after <= now + timedelta(days=certs.SIRDAR_RENEW_DAYS),
               Environment.current_sha.is_not(None),
               Environment.status.in_(("ready", "failed")))
        .order_by(Environment.name))
    return [env for env in rows if not await environments.is_deploying(db, env.id)]


async def start_due(now: datetime | None = None) -> list[str]:
    """Start a renew deployment for each environment that needs one; the
    names started."""
    now = now or datetime.now(UTC)
    started: list[str] = []
    async with get_sessionmaker()() as db:
        for env in await due(db, now):
            name = env.name
            try:
                dep = await pipeline.create_deployment(db, env, mode="renew", git_ref=env.git_ref,
                                                       sha=env.current_sha, actor_id=None,
                                                       cloud=True)
            except pipeline.DeployInProgress:
                continue
            audit(db, actor_id=None, action="deploy.certificate_renew", entity_type="deployment",
                  entity_id=str(dep.id), changes={"environment": name})
            await db.commit()
            pipeline.launch(dep.id)
            started.append(name)
    return started


async def loop(seconds: int) -> None:
    await asyncio.sleep(FIRST_DELAY_SECONDS)
    while True:
        try:
            names = await start_due()
            if names:
                log.info("certificate renewals started: %s", ", ".join(names))
        # A database hiccup must not end the loop; never log its text.
        except Exception as e:  # noqa: BLE001
            log.warning("certificate renewal check failed: %s", type(e).__name__)
        await asyncio.sleep(seconds)
```

In `sirdar/api/src/sirdar_api/config.py`, add `cert_check_seconds: int = 6 * 3600` (comment: "how often Sirdar looks for DigitalOcean certificates to renew; 0: never"). In `sirdar/api/src/sirdar_api/api/app.py`'s `_lifespan`, after the startup sweeps:

```python
    renewal = None
    seconds = get_settings().cert_check_seconds
    if seconds > 0:
        from sirdar_api.deploy import renewals
        renewal = asyncio.create_task(renewals.loop(seconds), name="certificate-renewals")
    yield
    if renewal is not None:
        renewal.cancel()
        with suppress(asyncio.CancelledError):
            await renewal
```

(import `asyncio` and `contextlib.suppress`).

- [ ] **Step 6: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_deploy_do_renewals.py tests/test_deploy_do_environments.py tests/test_deploy_playbooks.py tests/test_deploy_pipeline_do.py tests/test_deploy_do_provision.py`
Expected: all PASS.

- [ ] **Step 7: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/envfile.py src/sirdar_api/deploy/do_envs.py src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/do_provision.py src/sirdar_api/deploy/renewals.py src/sirdar_api/config.py src/sirdar_api/api/app.py tests/test_deploy_do_renewals.py tests/test_deploy_do_environments.py tests/test_deploy_playbooks.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/envfile.py sirdar/api/src/sirdar_api/deploy/do_envs.py sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/do_provision.py sirdar/api/src/sirdar_api/deploy/renewals.py sirdar/api/src/sirdar_api/config.py sirdar/api/src/sirdar_api/api/app.py sirdar/api/tests/test_deploy_do_renewals.py sirdar/api/tests/test_deploy_do_environments.py sirdar/api/tests/test_deploy_playbooks.py
git commit -m "feat(sirdar): backup certificate renewal and the cert-worker's .env

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The dashboard reads real state, and both accounts everywhere

**Files:**
- Modify: `sirdar/api/src/sirdar_api/dashboard/service.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (regions and connect per account; the targets list counts either account)
- Create: `sirdar/api/tests/test_dashboard_do.py`
- Modify: `sirdar/api/tests/test_dashboard_api.py` (expected shapes gain the new keys: `production.environment: None`, `production.certificate: None`, `production.load_balancer.ip: None`, and on each environment card `slots: []`, `active_slot: None`, `certificate: None`; `infrastructure.accounts`)

**Interfaces:**
- Consumes: `do_envs.get/slots_of`, `do_accounts.KEYS/load/source_of`, `digitalocean.resolve(db, settings, account)`, `certs.days_left`, `certs.SIRDAR_RENEW_DAYS`.
- Produces: the `GET /dashboard` shape under "API produced by Tasks 1–5"; `service.cert_info(when, now) -> dict | None`; `GET /deploy/digitalocean/regions?account=`; `ConnectIn.account`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_dashboard_do.py`:

```python
"""The dashboard with DigitalOcean environments: the production card is the
production environment (its slots, load balancer and certificate), other
two-slot environments show their slot pair, certificates warn at 14 days,
and both accounts' inventories show, one node each."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from sirdar_api.dashboard import service
from sirdar_api.db.models import DoEnvironment, DoSlot, Environment

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import configure_account, do_cloud, make_do_environment  # noqa: F401
from .fake_digitalocean import DEV_TOKEN, DO_TOKEN, RENEW_TOKEN
from .test_deploy_api import deploy_env  # noqa: F401

pytestmark = pytest.mark.usefixtures("secrets_key", "deploy_env")


@pytest.fixture(autouse=True)
def _fresh_cache():
    service.clear_cache()
    yield
    service.clear_cache()


async def _state(db, env, *, active, days, checks):
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        active_slot=active, current_sha="a" * 40, image_tag="aaaaaaaa", status="ready"))
    await db.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env.id).values(
        lb_ip="203.0.113.50",
        cert_not_after=datetime.now(UTC) + timedelta(days=days, hours=1)))
    for slot, ok in checks.items():
        await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                              DoSlot.slot == slot).values(
            droplet_id=f"40{len(slot)}", public_ip="127.0.0.1", sha="a" * 40,
            image_tag="aaaaaaaa", last_check_ok=ok))
    await db.commit()


async def test_the_production_card_is_real(client, db, do_cloud):
    prod = await make_do_environment(db, name="prod", type_="production", account="production")
    await _state(db, prod, active="blue", days=10, checks={"blue": True, "green": None})
    h = await auth_headers(client, db)
    body = (await client.get("/api/dashboard", headers=h)).json()
    p = body["production"]
    assert (p["status"], p["active_slot"], p["environment"]) == ("active", "blue", "prod")
    assert p["load_balancer"] == {"label": "Load balancer", "sub": "Blue active",
                                  "present": True, "ip": "203.0.113.50"}
    assert (p["certificate"]["days_left"], p["certificate"]["warn"]) == (10, True)
    blue, green = p["slots"]
    assert (blue["state"], blue["health"], blue["traffic_pct"], blue["version"]) == (
        "active", "healthy", 100, "aaaaaaaa")
    assert (green["state"], green["health"], green["traffic_pct"]) == ("standby", "unknown", 0)
    assert "prod" not in [c["environment"] for c in body["environments"]]


async def test_two_slot_cards_and_certificates(client, db, do_cloud):
    env = await make_do_environment(db)
    await _state(db, env, active="orange", days=40, checks={"orange": True, "purple": False})
    h = await auth_headers(client, db)
    card = next(c for c in (await client.get("/api/dashboard", headers=h)).json()["environments"]
                if c["environment"] == "uat9")
    assert card["active_slot"] == "orange"
    assert [(s["id"], s["state"], s["health"]) for s in card["slots"]] == [
        ("orange", "active", "healthy"), ("purple", "standby", "degraded")]
    assert card["certificate"]["warn"] is False


async def test_without_production_the_card_stays_empty(client, db):
    h = await auth_headers(client, db)
    p = (await client.get("/api/dashboard", headers=h)).json()["production"]
    assert (p["environment"], p["certificate"], p["status"]) == (None, None, "inactive")
    assert [s["id"] for s in p["slots"]] == ["blue", "green"]


async def test_both_accounts_in_the_infrastructure(client, db, do_cloud):
    await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
    await configure_account(db)
    do_cloud.do.add_droplet("ss-prod-blue", ["sirdar-env:prod"])
    h = await auth_headers(client, db)
    infra = (await client.get("/api/dashboard", headers=h)).json()["infrastructure"]
    assert [a["key"] for a in infra["accounts"]] == ["production", "development"]
    assert [n["name"] for n in infra["tree"]] == ["Production account", "Development account"]
    tokens = {r.headers["authorization"] for r in do_cloud.do.requests}
    assert tokens == {f"Bearer {DO_TOKEN}", f"Bearer {DEV_TOKEN}"}


async def test_regions_per_account(client, db, do_cloud):
    await configure_account(db)
    h = await auth_headers(client, db)
    resp = await client.get("/api/deploy/digitalocean/regions?account=development", headers=h)
    assert resp.status_code == 200
    assert {r.headers["authorization"] for r in do_cloud.do.requests} == {f"Bearer {DEV_TOKEN}"}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_dashboard_do.py`
Expected: FAIL.

- [ ] **Step 3: The dashboard service**

In `sirdar/api/src/sirdar_api/dashboard/service.py` (import `do_accounts`, `do_envs`, `certs` from `sirdar_api.deploy`; `DoAccount` from the models):

1. `_slot_of` accepts `("blue", "green", "orange", "purple")`.
2. Add:

```python
def cert_info(when: datetime | None, now: datetime) -> dict | None:
    if when is None:
        return None
    left = certs.days_left(when, now)
    return {"not_after": when.isoformat(), "days_left": int(left),
            "warn": left <= certs.SIRDAR_RENEW_DAYS}


def _slot_health(row) -> str:
    if row is None or row.last_check_ok is None:
        return "unknown"
    return "healthy" if row.last_check_ok else "degraded"


async def _slot_cards(db: AsyncSession, env: Environment, label) -> list[dict]:
    rows = await do_envs.slots_of(db, env.id)
    cards = []
    for slot in env.slots:
        row = rows.get(slot)
        active = slot == env.active_slot
        cards.append({"id": slot, "label": label(slot),
                      "state": "active" if active else ("standby" if row and row.sha else "empty"),
                      "health": _slot_health(row), "version": row.image_tag if row else None,
                      "instances": {"running": 1 if row and row.public_ip else 0,
                                    "total": 1 if row and row.droplet_id else 0},
                      "traffic_pct": 100 if active else 0})
    return cards


async def _production(db: AsyncSession | None, now: datetime) -> dict:
    empty = [{"id": s, "label": f"Production {s.title()}", "state": "empty", "health": "unknown",
              "version": None, "instances": {"running": 0, "total": 0}, "traffic_pct": 0}
             for s in ("blue", "green")]
    card = {"status": "inactive", "active_slot": None, "environment": None,
            "traffic": {"label": "Live traffic", "sub": "External users"},
            "load_balancer": {"label": "Load balancer", "sub": "Not configured",
                              "present": False, "ip": None},
            "certificate": None, "slots": empty}
    if db is None:
        return card
    env = await db.scalar(select(Environment).where(Environment.type == "production")
                          .order_by(Environment.retiring, Environment.name).limit(1))
    if env is None:
        return card
    row = await do_envs.get(db, env.id)
    present = bool(row and row.lb_ip)
    card |= {"status": "active" if env.active_slot else "inactive",
             "active_slot": env.active_slot, "environment": env.name,
             "load_balancer": {"label": "Load balancer",
                               "sub": f"{env.active_slot.title()} active" if env.active_slot
                               else ("Configured" if present else "Not configured"),
                               "present": present, "ip": row.lb_ip if row else None},
             "certificate": cert_info(row.cert_not_after if row else None, now),
             "slots": await _slot_cards(db, env, lambda s: f"Production {s.title()}")}
    return card
```

3. `_environment_card` adds, for every card:

```python
    do_row = await do_envs.get(db, env.id) if env.target_id == "digitalocean" else None
    slots = (await _slot_cards(db, env, str.title) if do_row and len(env.slots) == 2 else [])
    ... "slots": [{k: s[k] for k in ("id", "label", "state", "health", "version")}
                  for s in slots],
        "active_slot": env.active_slot,
        "certificate": cert_info(do_row.cert_not_after if do_row else None,
                                 datetime.now(UTC)),
```

   and `_placeholder` adds `"slots": [], "active_slot": None, "certificate": None`.
4. `environment_cards` skips `type == "production"` (the production card shows it): `cards += [... for e in rows if e.type not in ("dev", "beta", "production")]`.
5. `build_dashboard`: replace the single-token inventory with both accounts when `db` is given:

```python
    accounts: list[dict] = []
    inventories: list[tuple[str, str, dict]] = []
    if db is not None:
        for key in do_accounts.KEYS:
            label = (await db.get(DoAccount, key)).label
            try:
                resolved = await digitalocean.resolve(db, settings, key)
            except IntegrationError as e:
                accounts.append({"key": key, "label": label, "error": e.reason})
                continue
            if resolved.deploy_do_token is None:
                continue
            try:
                inventories.append((key, label, await _inventory(resolved, refresh)))
                accounts.append({"key": key, "label": label, "error": None})
            except ConnectFailed as e:
                accounts.append({"key": key, "label": label, "error": e.reason})
```

   With `db` None (demo-free unit callers), keep today's single-token path. Then: `infra["source"] = "digitalocean"` when `accounts` isn't empty; `infra["error"]` is the error when there is exactly one account and it failed; `infra["accounts"] = accounts`; `infra["tree"]` is `build_tree(inv)` with one inventory, and with two:

```python
            [node(f"account-{key}", f"{label} account", "group", "DigitalOcean account",
                  *_rollup(build_tree(inv)), children=build_tree(inv))
             for key, label, inv in inventories]
```

   `inv` for the tagged-name scan and `has_lb` is the union of all inventories. `"production": await _production(db, datetime.now(UTC))`.

- [ ] **Step 4: Regions, connect and targets per account**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

```python
async def _digitalocean_settings(db, account: str = "production") -> tuple:
    try:
        return await digitalocean.resolve(db, get_settings(), account), None
    except integrations.IntegrationError as e:
        return None, e
```

`digitalocean_regions` gains `account: Literal["production", "development"] = Query(default="production")` and passes it; `ConnectIn` gains `account: Literal["production", "development"] | None = None`, `connect` passes `body.account or "production"` and adds `changes["account"]` when given; `list_targets` computes `digitalocean_configured` as "either account has a source":

```python
    do_on = False
    for key in do_accounts.KEYS:
        row = await db.get(DoAccount, key)
        do_on = do_on or do_accounts.source_of(row, s) is not None
```

- [ ] **Step 5: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_phase7b .venv/bin/pytest -q tests/test_dashboard_do.py tests/test_dashboard_api.py tests/test_dashboard_inventory.py tests/test_deploy_digitalocean_integration.py tests/test_deploy_api.py`
Expected: all PASS.

- [ ] **Step 6: Lint and commit**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/dashboard/service.py src/sirdar_api/api/routes/deploy.py tests/test_dashboard_do.py
cd ../.. && git add sirdar/api/src/sirdar_api/dashboard/service.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_dashboard_do.py
git commit -m "feat(sirdar): the dashboard reads production's slots, load balancer and certificate, and both accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API client, labels and fixtures

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts` (+ `sirdarApi.test.ts`)
- Modify: `sirdar/web/src/pages/environments/labels.tsx` (+ `labels.test.ts`)
- Modify: `sirdar/web/src/pages/environments/testData.ts`, `sirdar/web/src/pages/dashboard/testData.ts`

**Interfaces:**
- Consumes: the API shapes of 7a and Tasks 1–5.
- Produces (used by Tasks 7–10):
  - types `DoAccountKey`, `DoAccount`, `DoAccountBody`, `EnvDo`, `EnvDoSlot`, `NewDo`, `DashCert`, `DashEnvSlot`; `EnvType` adds `'production'`; `Environment` adds `slots`, `active_slot`, `auto_activate`, `retiring`, `do`; `target_kind` adds `'digitalocean'`; `DeploymentSummary` adds `cloud`, `slot`, `go_live`; `DeploymentMode` adds `'activate' | 'renew'`; `DeploymentBody` adds `snapshot?`, `confirm_production?`; `EnvironmentPatch` adds `retiring?`, `confirm_name?`, `auto_activate?`, `do?`; `NewEnvironmentBody.do?`; `EnvironmentDefaults.do`; `DashProduction` adds `environment`, `certificate`, `load_balancer.ip`; `DashEnvironment` adds `slots`, `active_slot`, `certificate`; `DashboardData.infrastructure.accounts?`.
  - calls `getDoAccounts()`, `saveDoAccount(key, body)`, `testDoAccount(key, body?)`, `clearDoAccount(key)`, `getDoRegions(account = 'production')`, `activateSlot(name, slot, confirmName?)`, `addSlot(name)`.
  - labels: `TYPE_LABEL.production`, `MODE_LABEL.activate/renew`, `onDo(env)`, `isDoTarget(id)`, `slotTitle(slot)`, `idleSlot(env)`, `goesLive(env, slot)`, `certDaysLeft(iso, now?)`, `GATED_MODES` + `'activate'`, `RETRY_MODES` + `'activate', 'renew'`; `envTargets` lists DigitalOcean once configured.
  - fixtures: `DO_ACCOUNTS`, `DO_ENV` (two slots, orange active), `ONE_SLOT_ENV`, `PROD_ENV` (blue active), `DO_DEFAULTS` (the `do` block, also merged into `DEFAULTS`), `DO_TARGETS`; dashboard `REAL_PRODUCTION`.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/web/src/pages/environments/labels.test.ts`:

```ts
import { DO_ENV, ONE_SLOT_ENV, PROD_ENV } from './testData';
import { certDaysLeft, goesLive, idleSlot, onDo, slotTitle } from './labels';

describe('DigitalOcean helpers', () => {
  it('knows the slot an Update targets and whether it goes live', () => {
    expect(onDo(DO_ENV)).toBe(true);
    expect(idleSlot(DO_ENV)).toBe('purple');
    expect(goesLive(DO_ENV, 'purple')).toBe(false);
    expect(goesLive({ ...DO_ENV, auto_activate: true }, 'purple')).toBe(true);
    expect(goesLive({ ...DO_ENV, active_slot: null }, 'orange')).toBe(true);
    expect(idleSlot(ONE_SLOT_ENV)).toBe('orange');
    expect(goesLive(ONE_SLOT_ENV, 'orange')).toBe(true);
    expect(goesLive({ ...PROD_ENV, auto_activate: true }, 'green')).toBe(false);
    expect(slotTitle('purple')).toBe('Purple');
  });

  it('counts certificate days', () => {
    const now = Date.parse('2026-10-05T00:00:00Z');
    expect(certDaysLeft('2026-10-15T00:00:00Z', now)).toBe(10);
    expect(certDaysLeft(null, now)).toBeNull();
  });
});
```

Append to `sirdar/web/src/lib/sirdarApi.test.ts` (follow how the file already mocks `apiFetch`):

```ts
it('activates a slot, adds one and reads the accounts', async () => {
  fetchMock.mockResolvedValueOnce(json(201, { id: 'd1' }));
  await activateSlot('uat9', 'purple');
  expect(lastCall()).toEqual(['/deploy/environments/uat9/activate', 'POST', { slot: 'purple' }]);
  fetchMock.mockResolvedValueOnce(json(201, { id: 'd2' }));
  await activateSlot('prod', null, 'prod');
  expect(lastCall()).toEqual(['/deploy/environments/prod/activate', 'POST',
    { slot: null, confirm_name: 'prod' }]);
  fetchMock.mockResolvedValueOnce(json(201, { environment: {}, deployment: null }));
  await addSlot('solo');
  expect(lastCall()).toEqual(['/deploy/environments/solo/slots', 'POST', undefined]);
  fetchMock.mockResolvedValueOnce(json(200, { regions: [], default: null }));
  await getDoRegions('development');
  expect(lastCall()[0]).toBe('/deploy/digitalocean/regions?account=development');
});

it('has copy for the new codes', () => {
  for (const code of ['slot_not_deployed', 'slot_already_active', 'production_not_retiring',
    'production_slot_active', 'confirm_production_mismatch', 'do_team_changed', 'do_token_shared',
    'not_supported_on_digitalocean', 'do_shrink_refused', 'base_domain_not_in_zone']) {
    expect(errorText(new ApiError(409, code, { code }), 'fallback')).not.toBe('fallback');
  }
});
```

(adapt `fetchMock`, `json` and `lastCall` to the helpers `sirdarApi.test.ts` already has; if it has none, write them over `vi.mock('@portal/lib/api')` the way the file mocks `apiFetch`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/lib/sirdarApi.test.ts src/pages/environments/labels.test.ts`
Expected: FAIL.

- [ ] **Step 3: Types and calls**

In `sirdar/web/src/lib/sirdarApi.ts`:

```ts
export type EnvType = 'dev' | 'beta' | 'custom' | 'production';
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback' | 'publish' | 'teardown' | 'vm_restore'
  | 'activate' | 'renew';

/* ---- DigitalOcean (phase 7) ---- */
export type DoAccountKey = 'production' | 'development';
export interface DoAccount {
  key: DoAccountKey; label: string; region: string | null; configured: boolean; token_set: boolean;
  source: 'stored' | 'environment' | null; renewal_token_set: boolean; team_name: string | null;
  /** Environments built in this account (it can't be cleared while any exist). */
  environments: string[]; updated_at: string | null; updated_by_name: string | null;
}
/** Omitted tokens keep the stored ones. */
export interface DoAccountBody {
  label: string; region: string | null; token?: string; renewal_token?: string; clear_renewal_token?: boolean;
}
export interface EnvDoSlot {
  slot: string; droplet_id: string | null; public_ip: string | null; private_ip: string | null;
  sha: string | null; image_tag: string | null; active: boolean;
  last_check_ok: boolean | null; last_check_at: string | null;
}
export interface EnvDo {
  account: DoAccountKey; account_label: string; region: string; droplet_size: string; db_size: string;
  db_standby: boolean; acme_staging: boolean; vpc_ip_range: string | null; lb_ip: string | null;
  db_host: string | null; bucket: string | null; cert_not_after: string | null;
  slots: EnvDoSlot[]; resources: { kind: string; name: string; slot: string | null }[];
}
export interface NewDo {
  account: DoAccountKey; slots?: 1 | 2; droplet_size?: string; db_size?: string; db_standby?: boolean;
  acme_staging?: boolean;
}
```

`Environment`: `target_kind: 'ssh' | VmHostKind | 'digitalocean'`, and add `slots: string[]; active_slot: string | null; auto_activate: boolean; retiring: boolean; do: EnvDo | null;`. `DeploymentSummary` adds `cloud: boolean; slot: string | null; go_live: boolean;`. `NewEnvironmentBody` adds `do?: NewDo`; `EnvironmentDefaults` adds `do: { droplet_size: string; db_size: string; db_standby: boolean; production_slots: string[]; one_slot: string[]; two_slots: string[] }`; `EnvironmentPatch` adds `retiring?: boolean; confirm_name?: string; auto_activate?: boolean; do?: { droplet_size?: string; db_size?: string; db_standby?: boolean };`; `DeploymentBody` adds `snapshot?: boolean; confirm_production?: string;`.

Calls:

```ts
const doAccountPath = (key: DoAccountKey) => `/deploy/integrations/digitalocean/accounts/${key}`;
export const getDoAccounts = () => getJson<{ accounts: DoAccount[] }>('/deploy/integrations/digitalocean/accounts');
export const saveDoAccount = (key: DoAccountKey, body: DoAccountBody) =>
  sendJson<{ accounts: DoAccount[] }>('PUT', doAccountPath(key), body);
export const testDoAccount = (key: DoAccountKey, body?: DoAccountBody) =>
  sendJson<IntegrationCheck>('POST', `${doAccountPath(key)}/test`, body);
export async function clearDoAccount(key: DoAccountKey): Promise<void> {
  const resp = await apiFetch(doAccountPath(key), { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
export const getDoRegions = (account: DoAccountKey = 'production') =>
  getJson<DoRegions>(`/deploy/digitalocean/regions?account=${account}`);
/** slot null: Deactivate (a retiring production only). */
export const activateSlot = (name: string, slot: string | null, confirmName?: string) =>
  sendJson<Deployment>('POST', `${envPath(name)}/activate`,
    confirmName === undefined ? { slot } : { slot, confirm_name: confirmName });
export const addSlot = (name: string) =>
  sendJson<{ environment: Environment; deployment: Deployment | null }>('POST', `${envPath(name)}/slots`);
```

(replace the old `getDoRegions`). Dashboard types:

```ts
export interface DashCert { not_after: string; days_left: number; warn: boolean }
export interface DashEnvSlot { id: string; label: string; state: string; health: string; version: string | null }
```

`DashProduction` adds `environment: string | null; certificate: DashCert | null;` and `load_balancer: { label: string; sub: string; present: boolean; ip?: string | null }`; `DashEnvironment` adds `slots: DashEnvSlot[]; active_slot: string | null; certificate: DashCert | null;`; `DashboardData.infrastructure` adds `accounts?: { key: string; label: string; error: string | null }[]`.

Add to `MESSAGES` (one sentence each, American English):

```ts
  // DigitalOcean (phase 7)
  do_account_invalid: 'That DigitalOcean account doesn\'t exist.',
  label_invalid: 'Use a label of 1 to 40 characters.',
  region_invalid: 'Use a DigitalOcean region slug, like nyc3.',
  renewal_token_invalid: "That doesn't look like a DigitalOcean token.",
  do_token_shared: 'The other account already uses that token. Each account needs its own.',
  do_team_changed: 'That token belongs to another DigitalOcean team than the environments built in this account.',
  account_in_use: 'Environments are built in this account. Delete them first.',
  do_account_not_configured: 'Set up that DigitalOcean account (token and region) in Settings › Integrations first.',
  do_invalid: "Those DigitalOcean settings aren't valid.",
  do_slots_invalid: 'Choose one droplet or two slots.',
  do_size_invalid: "That droplet size isn't one DigitalOcean offers here.",
  do_db_size_invalid: "That database size isn't one DigitalOcean offers here.",
  do_shrink_refused: 'Sizes can only grow.',
  do_not_allowed: 'Only an environment on DigitalOcean has DigitalOcean settings.',
  do_field_locked: "That setting belongs to what Sirdar built on DigitalOcean and can't change.",
  do_not_ready: "This environment isn't fully built yet. Deploy it first.",
  production_requires_digitalocean: 'Production environments run on DigitalOcean.',
  production_exists: 'A production environment already exists. Mark it retiring first.',
  base_domain_not_in_zone: 'The base domain must be in the Cloudflare zone.',
  not_supported_on_digitalocean: "That isn't offered on DigitalOcean: the database is shared by both slots. To go back, activate the other slot.",
  not_digitalocean_environment: "This environment isn't on DigitalOcean.",
  slot_invalid: "That isn't one of this environment's slots.",
  slot_required: 'Choose the slot to activate.',
  slot_already_active: 'That slot is already live.',
  slot_not_deployed: "That slot hasn't been deployed yet.",
  production_retiring: 'This production environment is retiring: it can only be deactivated.',
  already_inactive: 'No slot is live.',
  slots_full: 'This environment already has two slots.',
  slot_not_allowed: 'Production always has its Blue and Green slots.',
  auto_activate_not_allowed: 'Only non-production DigitalOcean environments activate automatically.',
  retiring_not_allowed: 'Only a production environment can be marked retiring.',
  production_not_retiring: 'Mark this production environment retiring first.',
  production_slot_active: 'Deactivate this production environment first: a live slot can\'t be deleted.',
  confirm_production_mismatch: 'Type the phrase exactly to confirm.',
  snapshot_required: 'Production is always snapshotted before it is deleted.',
```

- [ ] **Step 4: Labels**

In `sirdar/web/src/pages/environments/labels.tsx`:

```ts
export const TYPE_LABEL: Record<string, string> = { dev: 'Dev', beta: 'Beta', custom: 'Custom', production: 'Production' };
// MODE_LABEL gains: activate: 'Activate', renew: 'Renew certificate'
export const GATED_MODES = ['reset', 'restore_dump', 'rollback', 'teardown', 'vm_restore', 'activate'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback', 'publish', 'teardown', 'vm_restore',
  'activate', 'renew'];

/** Its hosts are droplets Sirdar builds in a DigitalOcean account. */
export const onDo = (env: Environment) => env.target_kind === 'digitalocean';
export const isDoTarget = (id: string) => id === 'digitalocean';
export const slotTitle = (slot: string) => (slot ? slot[0].toUpperCase() + slot.slice(1) : slot);
/** The slot an Update deploys to (the API's do_envs.target_slot). */
export const idleSlot = (env: Environment): string =>
  env.active_slot === null || env.slots.length < 2 ? env.slots[0]
    : env.slots.find((s) => s !== env.active_slot) ?? env.slots[0];
/** Whether an Update of `slot` goes live by itself (the API's do_envs.goes_live). */
export const goesLive = (env: Environment, slot: string): boolean =>
  env.active_slot === null || env.slots.length === 1 || env.active_slot === slot
  || (env.auto_activate && env.type !== 'production');
/** Whole days until a certificate expires; null without one. */
export function certDaysLeft(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.floor((at - now) / 86_400_000);
}
```

`envTargets` adds the DigitalOcean target when configured: `[...sshTargets(targets), ...targets.filter((t) => (isVmTarget(t.id) || isDoTarget(t.id)) && t.configured && t.available)]`.

- [ ] **Step 5: Fixtures**

In `sirdar/web/src/pages/environments/testData.ts`: add `slots: [], active_slot: null, auto_activate: false, retiring: false, do: null` to `ENV` (every derived fixture inherits them), `cloud: false, slot: null, go_live: false` to `ADOPTED` and the `deployment()` builder, the `do` block to `DEFAULTS`, and:

```ts
export const DO_DEFAULTS = {
  droplet_size: 's-2vcpu-4gb', db_size: 'db-s-2vcpu-4gb', db_standby: false,
  production_slots: ['blue', 'green'], one_slot: ['orange'], two_slots: ['orange', 'purple'],
};
export const DO_ACCOUNTS: DoAccount[] = [
  { key: 'production', label: 'Production', region: 'nyc3', configured: true, token_set: true, source: 'stored',
    renewal_token_set: true, team_name: 'Encon Production', environments: ['prod'],
    updated_at: '2026-10-05T12:00:00Z', updated_by_name: 'Jimmy Henderson' },
  { key: 'development', label: 'Development', region: null, configured: false, token_set: false, source: null,
    renewal_token_set: false, team_name: null, environments: [], updated_at: null, updated_by_name: null },
];
const doSlot = (slot: string, active: boolean, sha: string | null): EnvDoSlot => ({
  slot, droplet_id: active ? '4001' : '4002', public_ip: active ? '203.0.113.11' : '203.0.113.12',
  private_ip: active ? '10.116.0.2' : '10.116.0.3', sha, image_tag: sha ? sha.slice(0, 8) : null, active,
  last_check_ok: sha ? true : null, last_check_at: sha ? '2026-10-05T12:00:00Z' : null,
});
export const DO_ENV: Environment = {
  ...ENV, id: 'e9', name: 'uat9', target: 'digitalocean', target_kind: 'digitalocean',
  base_domain: 'uat9.serversherpa.com', env_dir: '/opt/serversherpa/uat9', proxy_ip: '172.30.0.2',
  bind_ip: '127.0.0.1', spaces_bucket: 'ss-uat9-0a1b2c3d', publish: true,
  slots: ['orange', 'purple'], active_slot: 'orange',
  do: {
    account: 'development', account_label: 'Development', region: 'nyc3', droplet_size: 's-2vcpu-4gb',
    db_size: 'db-s-2vcpu-4gb', db_standby: false, acme_staging: true, vpc_ip_range: '10.116.0.0/20',
    lb_ip: '203.0.113.50', db_host: 'private-ss-uat9-db-do-user-1.db.ondigitalocean.com',
    bucket: 'ss-uat9-0a1b2c3d', cert_not_after: '2027-01-03T12:00:00Z',
    slots: [doSlot('orange', true, SHA), doSlot('purple', false, NEW_SHA)],
    resources: [{ kind: 'vpc', name: 'ss-uat9', slot: null }, { kind: 'droplet', name: 'ss-uat9-orange', slot: 'orange' },
                { kind: 'droplet', name: 'ss-uat9-purple', slot: 'purple' },
                { kind: 'load_balancer', name: 'ss-uat9-lb', slot: null }],
  },
};
export const ONE_SLOT_ENV: Environment = {
  ...DO_ENV, name: 'solo', slots: ['orange'], do: { ...DO_ENV.do!, slots: [doSlot('orange', true, SHA)] },
};
export const PROD_ENV: Environment = {
  ...DO_ENV, id: 'p1', name: 'prod', type: 'production', slots: ['blue', 'green'], active_slot: 'blue',
  do: { ...DO_ENV.do!, account: 'production', account_label: 'Production', acme_staging: false,
        slots: [doSlot('blue', true, SHA), doSlot('green', false, NEW_SHA)] },
};
export const DO_TARGETS = {
  ...TARGETS,
  targets: TARGETS.targets.map((t) => (t.id === 'digitalocean' ? { ...t, configured: true } : t)),
};
```

(import `DoAccount` and `EnvDoSlot` types). In `sirdar/web/src/pages/dashboard/testData.ts`, add `environment: null, certificate: null` (and `ip: null` on `load_balancer`) to `DEMO.production` and `EMPTY.production`, `slots: [], active_slot: null, certificate: null` to every environment card, and:

```ts
export const REAL_PRODUCTION: DashboardData['production'] = {
  ...DEMO.production, environment: 'prod',
  load_balancer: { label: 'Load balancer', sub: 'Blue active', present: true, ip: '203.0.113.50' },
  certificate: { not_after: '2026-10-15T12:00:00Z', days_left: 10, warn: true },
};
```

- [ ] **Step 6: Run the tests and the type-check**

Run: `npm --prefix sirdar/web test -- src/lib src/pages/environments/labels.test.ts && npm --prefix sirdar/web run build`
Expected: PASS and a clean build (fix any fixture the compiler flags for the new required fields).

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts sirdar/web/src/pages/environments/labels.tsx sirdar/web/src/pages/environments/labels.test.ts sirdar/web/src/pages/environments/testData.ts sirdar/web/src/pages/dashboard/testData.ts
git commit -m "feat(sirdar-web): DigitalOcean types, calls, labels and fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Settings › Integrations — the two DigitalOcean accounts, and the Deploy page's account choice

**Files:**
- Create: `sirdar/web/src/pages/settings/DoAccountModal.tsx`, `DoAccountModal.test.tsx`
- Modify: `sirdar/web/src/pages/settings/IntegrationsSection.tsx`, `IntegrationsSection.test.tsx`
- Modify: `sirdar/web/src/pages/Deploy.tsx`, `Deploy.test.tsx` (the DigitalOcean target card asks which account)
- Modify: `sirdar/web/src/lib/sirdarApi.ts` (`connectDeploy(..., account?)`)
- Delete: `sirdar/web/src/pages/settings/DigitalOceanModal.tsx`, `DigitalOceanModal.test.tsx` (the accounts replace them; the API alias stays)
- Modify: `sirdar/web/src/styles/sirdar.css` (`.sirdar-do-account-card`)

**Interfaces:**
- Consumes: `getDoAccounts`, `saveDoAccount`, `testDoAccount`, `clearDoAccount`, `getDoRegions`, `DO_ACCOUNTS`, `SecretField`, `CheckList`, `Breakable`.
- Produces: `<DoAccountModal account={DoAccount} onSaved={(accounts: DoAccount[]) => void} onClose />`; Settings shows one card per account in place of the old DigitalOcean card; the Deploy page's DigitalOcean card tests the chosen account.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/settings/DoAccountModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ saveDoAccount: vi.fn(), testDoAccount: vi.fn(), getDoRegions: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { DO_ACCOUNTS } from '../environments/testData';

import DoAccountModal from './DoAccountModal';

const TOKEN = `dop_v1_${'0123456789abcdef'.repeat(4)}`;
const RENEW = `dop_v1_${'fedcba9876543210'.repeat(4)}`;
Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.saveDoAccount.mockResolvedValue({ accounts: DO_ACCOUNTS });
  api.getDoRegions.mockResolvedValue({ regions: [{ slug: 'nyc3', name: 'New York 3' }], default: 'nyc3' });
  api.testDoAccount.mockResolvedValue({
    ok: true, target: 'digitalocean', facts: {},
    checks: [{ label: 'Account', status: 'pass', value: 'ops@encondata.com · active' },
             { label: 'Renewal token', status: 'pass', value: 'Certificates and load balancers only' }],
  });
});
afterEach(cleanup);

function show(key: 'production' | 'development' = 'development') {
  const onSaved = vi.fn();
  render(<DoAccountModal account={DO_ACCOUNTS.find((a) => a.key === key)!} onSaved={onSaved} onClose={vi.fn()} />);
  return { onSaved, dialog: screen.getByRole('dialog', { name: /DigitalOcean/ }) };
}

it('has the report-generate header and both write-only tokens', () => {
  const { dialog } = show();
  expect(within(dialog).getByText('Integrations', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText('DigitalOcean · Development')).toBeTruthy();
  expect((within(dialog).getByLabelText('API token') as HTMLInputElement).type).toBe('password');
  expect((within(dialog).getByLabelText('Renewal token') as HTMLInputElement).type).toBe('password');
  expect(within(dialog).getByText(/Custom Scopes/)).toBeTruthy();
});

it('sets up an account: label, region and both tokens', async () => {
  const { onSaved, dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.type(within(dialog).getByLabelText('Renewal token'), RENEW);
  await userEvent.type(within(dialog).getByLabelText('Region'), 'nyc3');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(api.saveDoAccount).toHaveBeenCalledWith('development', {
    label: 'Development', region: 'nyc3', token: TOKEN, renewal_token: RENEW });
  expect(onSaved).toHaveBeenCalledWith(DO_ACCOUNTS);
  expect(document.body.textContent).not.toContain(TOKEN);
});

it('keeps stored tokens and picks the region from the account', async () => {
  const { dialog } = show('production');
  await within(dialog).findByText('New York 3');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(api.saveDoAccount).toHaveBeenCalledWith('production', { label: 'Production', region: 'nyc3' });
});

it('tests and shows the checks', async () => {
  const { dialog } = show('production');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(await within(dialog).findByText('Certificates and load balancers only')).toBeTruthy();
});

it("shows the API's reason for a token from another team", async () => {
  api.saveDoAccount.mockRejectedValue(new ApiError(409, 'do_team_changed', { code: 'do_team_changed', environments: ['prod'] }));
  const { dialog } = show('production');
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText(/another DigitalOcean team/)).toBeTruthy();
});
```

Update `sirdar/web/src/pages/settings/IntegrationsSection.test.tsx`: mock `getDoAccounts` to resolve `{ accounts: DO_ACCOUNTS }`; replace the DigitalOcean card tests with:
- two cards, "DigitalOcean · Production" (chip Configured; rows Region `nyc3`, Team `Encon Production`, API token `Set`, Renewal token `Set`, Environments `prod`) and "DigitalOcean · Development" (Not set up; Set up opens `DoAccountModal`);
- Remove on Production is disabled with the title "Environments are built in this account. Delete them first." (it has `environments`); Remove on a configured account without environments confirms "Clear the Development account's tokens? Nothing changes in DigitalOcean itself." and calls `clearDoAccount('development')`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/settings`
Expected: FAIL.

- [ ] **Step 3: `DoAccountModal`**

Create `sirdar/web/src/pages/settings/DoAccountModal.tsx`:

```tsx
/** One DigitalOcean account (Production or Development): its label, default
 *  region, API token and the renewal token droplets renew their certificate
 *  with. Tokens are write-only: kept unless replaced, never shown. Test
 *  tries the form's values without saving. */
import { useEffect, useRef, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';

import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import {
  deployErrorText, getDoRegions, saveDoAccount, testDoAccount,
  type DoAccount, type DoAccountBody, type IntegrationCheck,
} from '../../lib/sirdarApi';

const REGION_RE = /^[a-z]{3}[0-9]$/;
const TOKEN_RE = /^[!-~]{1,200}$/;
const DO_TOKEN_RE = /^dop_v1_[0-9a-fA-F]{64}$/;
const tokenOk = (t: string) => TOKEN_RE.test(t) && (!t.startsWith('dop_v1_') || DO_TOKEN_RE.test(t));
type Errors = Partial<Record<'label' | 'region' | 'token' | 'renewal' | 'form', string>>;

export default function DoAccountModal({ account, onSaved, onClose }: {
  account: DoAccount; onSaved: (accounts: DoAccount[]) => void; onClose: () => void;
}) {
  const [label, setLabel] = useState(account.label);
  const [region, setRegion] = useState(account.region ?? '');
  const [regions, setRegions] = useState<{ value: string; label: string }[]>([]);
  const [tokenAction, setTokenAction] = useState<SecretAction>(account.token_set ? 'keep' : 'set');
  const [token, setToken] = useState('');
  const [renewAction, setRenewAction] = useState<SecretAction>(account.renewal_token_set ? 'keep' : 'set');
  const [renewal, setRenewal] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!account.configured) return;
    getDoRegions(account.key)
      .then((r) => setRegions(r.regions.map((x) => ({ value: x.slug, label: x.name, sub: x.slug }))))
      .catch(() => setRegions([]));
  }, [account.configured, account.key]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cardRef.current?.querySelector<HTMLElement>('.modal-body input')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const check = (): Errors => {
    const e: Errors = {};
    if (!label.trim() || label.trim().length > 40) e.label = 'Use a label of 1 to 40 characters.';
    if (region && !REGION_RE.test(region)) e.region = 'Use a DigitalOcean region slug, like nyc3.';
    if (tokenAction === 'set' && !tokenOk(token)) e.token = token ? "That doesn't look like a DigitalOcean API token." : 'Enter the API token.';
    if (renewAction === 'set' && renewal && !tokenOk(renewal)) e.renewal = "That doesn't look like a DigitalOcean token.";
    return e;
  };

  const body = (): DoAccountBody => ({
    label: label.trim(), region: region || null,
    ...(tokenAction === 'set' && token ? { token } : {}),
    ...(renewAction === 'set' && renewal ? { renewal_token: renewal } : {}),
  });

  const run = async (what: 'test' | 'save') => {
    if (busyRef.current) return;
    const e = check();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(what);
    setResult(null);
    try {
      if (what === 'test') setResult(await testDoAccount(account.key, body()));
      else onSaved((await saveDoAccount(account.key, body())).accounts);
    } catch (err) {
      setErrors({ form: deployErrorText(err, what === 'test' ? "Couldn't test this account." : "Couldn't save this account.") });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={cardRef} className="modal-card reports-modal-card rgm-card sirdar-do-account-card" role="dialog"
           aria-modal="true" aria-labelledby="sirdar-do-account-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-do-account-title">DigitalOcean · {account.label}</h3>
            <p className="page-hint">
              Sirdar builds environments in this account with its API token. Droplets only get the renewal token, a
              token you make in the control panel under API › Generate New Token › Custom Scopes, with certificate
              (create, read, delete) and load_balancer (read, update).
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form">
          <div>
            <label className="field-label" htmlFor="do-account-label">Label</label>
            <input id="do-account-label" value={label} maxLength={40} aria-invalid={!!errors.label}
                   onChange={(e) => setLabel(e.target.value)} />
            {errors.label && <p className="form-error" role="alert">{errors.label}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="do-account-region">Region</label>
            {regions.length ? (
              <ComboBox inputId="do-account-region" ariaLabel="Region" portal value={region}
                        options={regions} onChange={setRegion} placeholder="Choose a region…" />
            ) : (
              <input id="do-account-region" value={region} placeholder="nyc3" aria-invalid={!!errors.region}
                     onChange={(e) => setRegion(e.target.value.trim().toLowerCase())} />
            )}
            {errors.region && <p className="form-error" role="alert">{errors.region}</p>}
          </div>
          <div className="sirdar-span2">
            <SecretField id="do-account-token" label="API token" isSet={account.token_set} adding={!account.token_set}
                         action={tokenAction} value={token} error={errors.token} clearable={false}
                         onAction={(a: SecretAction) => { setTokenAction(a); setToken(''); }} onValue={setToken} />
          </div>
          <div className="sirdar-span2">
            <SecretField id="do-account-renewal" label="Renewal token" isSet={account.renewal_token_set}
                         adding={!account.renewal_token_set} action={renewAction} value={renewal}
                         error={errors.renewal} clearable={false}
                         onAction={(a: SecretAction) => { setRenewAction(a); setRenewal(''); }} onValue={setRenewal} />
          </div>
          {result && <div className="sirdar-span2"><CheckList label={`DigitalOcean · ${account.label} test`} checks={result.checks} /></div>}
          {errors.form && <p className="form-error sirdar-span2" role="alert">{errors.form}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={!!busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => void run('test')}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          <button type="button" className="btn-solid" disabled={!!busy} onClick={() => void run('save')}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Check `SecretField`'s props against `components/SecretField.tsx` (the DigitalOcean modal used `id, label, isSet, adding, action, value, error, clearable, onAction, onValue`) and match its label wiring so `getByLabelText('API token')` and `getByLabelText('Renewal token')` find the inputs.

In `sirdar/web/src/styles/sirdar.css`, size the card to its content like the other integration modals:

```css
.sirdar-do-account-card { width: min(640px, calc(100vw - 32px)); }
.sirdar-do-account-card .pf-form { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
```

- [ ] **Step 4: The cards**

In `sirdar/web/src/pages/settings/IntegrationsSection.tsx`:
- `KINDS` becomes `['cloudflare', 'npm', 'esxi']`; drop `DigitalOceanModal`, `DO_SOURCE` and the `digitalocean` branches of `stored`, `settingsOf`, `remove`.
- Load `getDoAccounts()` next to `getIntegrations()` into `accounts: DoAccount[] | null`.
- After `{KINDS.map(card)}`, inside the same `.sirdar-cards.sirdar-integration-cards` grid, render one card per account:

```tsx
  const accountCard = (a: DoAccount) => {
    const name = `DigitalOcean · ${a.label}`;
    const rows: [string, string][] = [
      ['Region', a.region ?? '—'], ['Team', a.team_name ?? '—'],
      ['API token', a.source === 'environment' ? 'From the server environment' : a.token_set ? 'Set' : 'Not set'],
      ['Renewal token', a.renewal_token_set ? 'Set' : 'Not set'],
      ['Environments', a.environments.length ? a.environments.join(', ') : 'None'],
    ];
    return (
      <div key={a.key} className="sirdar-card" role="group" aria-label={name}>
        <div className="sirdar-card-head">
          <h3>{name}</h3>
          <span className={`chip ${a.configured ? 'c-green' : 'tag'}`}>{a.configured ? 'Configured' : 'Not set up'}</span>
        </div>
        <p className="page-hint">
          {a.key === 'production' ? 'Production environments are built here by default.'
            : 'Development, UAT and test environments.'}
        </p>
        <dl className="sirdar-kv">
          {rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono"><Breakable text={v} /></dd></Fragment>)}
        </dl>
        {mayChange && (
          <div className="sirdar-actions">
            {a.token_set && (
              <button type="button" className="mini-btn danger" aria-label={`Remove ${name}`}
                      disabled={busyAccount === a.key || a.environments.length > 0}
                      title={a.environments.length ? 'Environments are built in this account. Delete them first.' : undefined}
                      onClick={() => void clearAccount(a)}>Remove</button>
            )}
            {a.configured && (
              <button type="button" className="mini-btn" aria-label={`Test ${name}`} disabled={busyAccount === a.key}
                      onClick={() => void testAccount(a)}>{busyAccount === a.key ? 'Testing…' : 'Test'}</button>
            )}
            <button type="button" className="mini-btn" aria-label={`${a.token_set ? 'Edit' : 'Set up'} ${name}`}
                    disabled={!data?.secrets_key_configured} onClick={() => setEditingAccount(a)}>
              {a.token_set ? 'Edit' : 'Set up'}
            </button>
          </div>
        )}
        {accountProblems[a.key] && <p className="form-error" role="alert">{accountProblems[a.key]}</p>}
        {accountResults[a.key] && <CheckList label={`${name} test`} checks={accountResults[a.key]!.checks} />}
      </div>
    );
  };
```

with state `busyAccount`, `accountResults`, `accountProblems`, `editingAccount`, and `clearAccount` confirming "Clear the {label} account's tokens? Nothing changes in DigitalOcean itself." before `clearDoAccount(a.key)` and reloading. Render `<DoAccountModal>` when `editingAccount` is set; `onSaved` sets `accounts`. Update the section's hint: "…DigitalOcean environments are built in the Production or Development account."

Delete `DigitalOceanModal.tsx` and its test (`git rm`).

- [ ] **Step 5: The Deploy page asks which account**

In `sirdar/web/src/lib/sirdarApi.ts`, `connectDeploy(target, type, region?, name?, account?: DoAccountKey)` sends `account` when given. In `sirdar/web/src/pages/Deploy.tsx`, when the DigitalOcean target is selected, show an Account segmented control (Production / Development, from `getDoAccounts()`; only configured accounts are enabled; Production first) above the region picker; changing it reloads `getDoRegions(account)` and the connection test sends `account`. The hint under an unconfigured target says "Set up a DigitalOcean account in Settings › Integrations." Add a test to `Deploy.test.tsx`: choosing Development calls `getDoRegions('development')`, and Test calls `connectDeploy('digitalocean', 'dev', 'nyc3', undefined, 'development')`.

- [ ] **Step 6: Run the tests and build**

Run: `npm --prefix sirdar/web test -- src/pages/settings src/pages/Deploy.test.tsx && npm --prefix sirdar/web run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git rm -q sirdar/web/src/pages/settings/DigitalOceanModal.tsx sirdar/web/src/pages/settings/DigitalOceanModal.test.tsx
git add sirdar/web/src/pages/settings/DoAccountModal.tsx sirdar/web/src/pages/settings/DoAccountModal.test.tsx sirdar/web/src/pages/settings/IntegrationsSection.tsx sirdar/web/src/pages/settings/IntegrationsSection.test.tsx sirdar/web/src/pages/Deploy.tsx sirdar/web/src/pages/Deploy.test.tsx sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): two DigitalOcean accounts in Settings › Integrations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: New environment on DigitalOcean

**Files:**
- Modify: `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, `NewEnvironmentModal.test.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css` (`.sirdar-do-form`)

**Interfaces:**
- Consumes: `envTargets`, `isDoTarget`, `DO_DEFAULTS`, `DO_TARGETS`, `getDoAccounts`, `NewDo`.
- Produces: with target DigitalOcean, the steps are Basics › DigitalOcean › Services › Data › Review; the body carries `do` and no `proxy_ip`/`bind_ip`/`vm`/`publish`.

- [ ] **Step 1: Write the failing tests**

Add to `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx` (mock `getDeployTargets` → `DO_TARGETS`, `getDoAccounts` → `{ accounts: [DO_ACCOUNTS[0], { ...DO_ACCOUNTS[1], configured: true, token_set: true, region: 'nyc3' }] }`):

```tsx
describe('on DigitalOcean', () => {
  it('asks for the account and slots, and sends do', async () => {
    renderModal();
    await chooseTarget('DigitalOcean');
    await userEvent.type(screen.getByLabelText('Name'), 'uat9');
    expect(screen.queryByLabelText('Proxy IP')).toBeNull();          // Caddy on the droplet
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('DigitalOcean', { selector: '.rgm-step-label' })).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Development' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Two slots (orange + purple)' }));
    await userEvent.click(screen.getByRole('checkbox', { name: "Let's Encrypt staging" }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Activate automatically' }));
    await nextUntil('Review');
    expect(screen.getByText('s-2vcpu-4gb · db-s-2vcpu-4gb')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(api.createEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      name: 'uat9', type: 'dev', target: 'digitalocean',
      do: { account: 'development', slots: 2, droplet_size: 's-2vcpu-4gb', db_size: 'db-s-2vcpu-4gb',
            db_standby: false, acme_staging: true },
    }));
    expect(api.createEnvironment.mock.calls[0][0]).not.toHaveProperty('proxy_ip');
    expect(api.updateEnvironment).toHaveBeenCalledWith('uat9', { auto_activate: true });
  });

  it('production: the Production account, Blue/Green, no staging', async () => {
    renderModal();
    await chooseTarget('DigitalOcean');
    await chooseType('Production');
    await userEvent.type(screen.getByLabelText('Name'), 'prod');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('radio', { name: 'Production' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Blue and Green, always.')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: "Let's Encrypt staging" })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Activate automatically' })).toBeNull();
  });

  it('Production is only offered on DigitalOcean', async () => {
    renderModal();
    await chooseTarget('Custom (SSH) · Lab');
    await openType();
    expect(screen.queryByRole('option', { name: 'Production' })).toBeNull();
  });
});
```

(`chooseTarget`, `chooseType`, `openType`, `nextUntil` and `renderModal`: use the helpers the file already has, or add small ones over the ComboBox the way its existing tests pick a target.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: The DigitalOcean step**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`:
1. `type Step` adds `'cloud'`; add

```ts
const DO_STEPS: [Step, string][] = [
  ['basics', 'Basics'], ['cloud', 'DigitalOcean'], ['services', 'Services'], ['data', 'Data'], ['review', 'Review'],
];
type SlotChoice = 1 | 2;
const SLOT_CHOICES: [SlotChoice, string][] = [[1, 'One droplet'], [2, 'Two slots (orange + purple)']];
```

   and `CODE_FIELD` entries `do_account_not_configured: 'cloud', do_invalid: 'cloud', do_slots_invalid: 'cloud', do_size_invalid: 'cloud', do_db_size_invalid: 'cloud', production_exists: 'name', production_requires_digitalocean: 'target', base_domain_not_in_zone: 'domain'` (`Field` adds `'cloud'`).
2. State: `doAccount: DoAccountKey` (default `'development'`; switching the type to Production sets `'production'`), `slotChoice: SlotChoice` (1), `dropletSize`, `dbSize` (from `defaults.do`), `dbStandby` (false), `acmeStaging` (false), `autoActivate` (false), `accounts: DoAccount[]` (from `getDoAccounts()` when the modal opens).
3. `onDo = mode === 'new' && isDoTarget(target)`; `stepList = onDo ? DO_STEPS : onVm ? VM_STEPS : STEPS[mode]`; Next/Back go through `'cloud'` like `'machine'`.
4. Basics: the Type ComboBox offers `production` only when `onDo` (`TYPES` stays `['dev', 'beta', 'custom']`; append `'production'` when on DigitalOcean); hide the Proxy IP and Bind IP fields when `onDo` and add a hint under the base domain: "Must be in the Cloudflare zone; DNS points at the environment's load balancer."
5. The step body (`step === 'cloud'`), a `.pf-form.sirdar-do-form` section:

```tsx
            {defaults && step === 'cloud' && (
              <div className="pf-form sirdar-do-form">
                <div className="sirdar-span2" role="radiogroup" aria-label="Account">
                  <span className="field-label">Account</span>
                  <div className="segmented">
                    {accounts.map((a) => (
                      <button key={a.key} type="button" role="radio" aria-checked={doAccount === a.key}
                              className={doAccount === a.key ? 'on' : ''} tabIndex={doAccount === a.key ? 0 : -1}
                              disabled={!a.configured} onKeyDown={arrowNav} onClick={() => setDoAccount(a.key)}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <p className="page-hint">
                    {accountOf(doAccount)?.region ? `Built in ${accountOf(doAccount)!.region}. ` : ''}
                    An environment stays in the account it is built in.
                  </p>
                </div>
                {type === 'production' ? (
                  <p className="page-hint sirdar-span2">Blue and Green, always. Each deploy goes to the idle slot;
                    Activate switches traffic.</p>
                ) : (
                  <div className="sirdar-span2" role="radiogroup" aria-label="Slots">
                    <span className="field-label">Slots</span>
                    <div className="segmented">
                      {SLOT_CHOICES.map(([n, label]) => (
                        <button key={n} type="button" role="radio" aria-checked={slotChoice === n}
                                className={slotChoice === n ? 'on' : ''} tabIndex={slotChoice === n ? 0 : -1}
                                onKeyDown={arrowNav} onClick={() => setSlotChoice(n)}>{label}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <label className="field-label" htmlFor="env-new-droplet">Droplet size</label>
                  <input id="env-new-droplet" value={dropletSize} spellCheck={false}
                         onChange={(e) => setDropletSize(e.target.value.trim())} />
                  <p className="page-hint">Default: V2 production, 2 vCPU / 4 GB / 80 GB.</p>
                </div>
                <div>
                  <label className="field-label" htmlFor="env-new-db">Database size</label>
                  <input id="env-new-db" value={dbSize} spellCheck={false}
                         onChange={(e) => setDbSize(e.target.value.trim())} />
                  <p className="page-hint">Managed PostgreSQL 16; default 2 vCPU / 4 GB / 60 GB.</p>
                </div>
                <div className="sirdar-switch-row sirdar-span2">
                  <Switch checked={dbStandby} onChange={setDbStandby} label="Standby node" />
                  <span aria-hidden="true">Standby node</span>
                </div>
                {type !== 'production' && (
                  <>
                    <div className="sirdar-switch-row sirdar-span2">
                      <Switch checked={acmeStaging} onChange={setAcmeStaging} label="Let's Encrypt staging" />
                      <span aria-hidden="true">Let's Encrypt staging (test certificates browsers don't trust)</span>
                    </div>
                    {slotChoice === 2 && (
                      <div className="sirdar-switch-row sirdar-span2">
                        <Switch checked={autoActivate} onChange={setAutoActivate} label="Activate automatically" />
                        <span aria-hidden="true">Activate automatically after a good deploy</span>
                      </div>
                    )}
                  </>
                )}
                {errors.cloud && <p className="form-error sirdar-span2" role="alert">{errors.cloud}</p>}
              </div>
            )}
```

   The portal `Switch` is a checkbox whose `label` prop becomes its `aria-label`, so the tests find it with `getByRole('checkbox', { name: … })`.
6. `cloudErrors()`: sizes must match `/^[a-z0-9][a-z0-9-]{2,39}$/` (droplet, not starting `db-`) and `/^db-[a-z0-9][a-z0-9-]{2,36}$/`; the chosen account must be configured ("Set up the {label} account in Settings › Integrations first.").
7. The create body: for DigitalOcean omit `proxy_ip`, `bind_ip`, `publish`, `vm`, and send

```ts
      do: { account: doAccount, ...(type === 'production' ? {} : { slots: slotChoice }), droplet_size: dropletSize,
            db_size: dbSize, db_standby: dbStandby, ...(type === 'production' ? {} : { acme_staging: acmeStaging }) },
```

   then, after a successful create with `autoActivate` (two slots, not production), `await updateEnvironment(env.name, { auto_activate: true })` before `onCreated`.
8. Review lists Account (`{label} · {region}`), Slots (`Blue + Green` / `Orange` / `Orange + Purple`), Sizes (`{droplet} · {db}{standby ? ' · standby node' : ''}`), Certificate (`Let's Encrypt` or `Let's Encrypt staging`), Activates (`Automatically` / `With Activate`).

`NewEnvironmentBody.proxy_ip` must become optional (`proxy_ip?: string; bind_ip?: string`) in `sirdarApi.ts` for this body to type-check.

- [ ] **Step 4: Run the tests and build**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx && npm --prefix sirdar/web run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/NewEnvironmentModal.tsx sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): New environment on DigitalOcean — account, slots, sizes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The environment pages — Overview, Activate, Settings, Delete, Deploy

**Files:**
- Create: `sirdar/web/src/components/ActivateModal.tsx`, `ActivateModal.test.tsx`
- Create: `sirdar/web/src/pages/environments/DoMachineSection.tsx`, `DoMachineSection.test.tsx`
- Create: `sirdar/web/src/pages/environments/DoSettingsSection.tsx`, `DoSettingsSection.test.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvOverview.tsx`, `EnvSettings.tsx`, `EnvironmentDetail.tsx`, `DeleteEnvironmentModal.tsx` (+ test), `DeployModal.tsx` (+ test)
- Modify: `sirdar/web/src/styles/sirdar.css`

**Interfaces:**
- Consumes: `activateSlot`, `addSlot`, `updateEnvironment`, `startDeployment`, `onDo`, `idleSlot`, `goesLive`, `slotTitle`, `certDaysLeft`, fixtures `DO_ENV`, `ONE_SLOT_ENV`, `PROD_ENV`.
- Produces:
  - `<ActivateModal envName production slot fromSlot version onStarted onClose />` (`slot === null`: Deactivate), used here and by the dashboard (Task 10);
  - `<DoMachineSection env canActivate onActivate={(slot) => …} />` on Overview;
  - `<DoSettingsSection env onSaved onDeployStarted />` in Settings.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/components/ActivateModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ activateSlot: vi.fn() }));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { SUCCEEDED } from '../pages/environments/testData';

import ActivateModal from './ActivateModal';

beforeEach(() => { api.activateSlot.mockReset(); api.activateSlot.mockResolvedValue(SUCCEEDED); });
afterEach(cleanup);

function show(props: Partial<Parameters<typeof ActivateModal>[0]> = {}) {
  const onStarted = vi.fn();
  render(<ActivateModal envName="uat9" production={false} slot="purple" fromSlot="orange" version="f00dbabe"
                        onStarted={onStarted} onClose={vi.fn()} {...props} />);
  return { onStarted, dialog: screen.getByRole('dialog') };
}

it('activates a slot after its smoke test', async () => {
  const { onStarted, dialog } = show();
  expect(within(dialog).getByText('Blue/Green', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'Activate Purple' })).toBeTruthy();
  expect(within(dialog).getByText(/Orange keeps running/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  expect(api.activateSlot).toHaveBeenCalledWith('uat9', 'purple', undefined);
  expect(onStarted).toHaveBeenCalledWith(SUCCEEDED);
});

it('production needs the name typed', async () => {
  const { dialog } = show({ envName: 'prod', production: true, slot: 'green', fromSlot: 'blue' });
  const go = within(dialog).getByRole('button', { name: 'Activate Green' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  expect(go.disabled).toBe(false);
  await userEvent.click(go);
  expect(api.activateSlot).toHaveBeenCalledWith('prod', 'green', 'prod');
});

it('deactivates a retiring production', async () => {
  const { dialog } = show({ envName: 'prod', production: true, slot: null, fromSlot: 'blue' });
  expect(within(dialog).getByRole('heading', { name: 'Deactivate' })).toBeTruthy();
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
  expect(api.activateSlot).toHaveBeenCalledWith('prod', null, 'prod');
});

it("shows the API's copy", async () => {
  api.activateSlot.mockRejectedValue(new ApiError(409, 'slot_not_deployed', { code: 'slot_not_deployed' }));
  const { dialog } = show();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  expect(await within(dialog).findByText("That slot hasn't been deployed yet.")).toBeTruthy();
});
```

Create `sirdar/web/src/pages/environments/DoMachineSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import DoMachineSection from './DoMachineSection';
import { DO_ENV, PROD_ENV } from './testData';

afterEach(cleanup);

it('shows the account, load balancer, certificate, database and slots', async () => {
  const onActivate = vi.fn();
  render(<DoMachineSection env={DO_ENV} canActivate onActivate={onActivate} />);
  const section = screen.getByRole('region', { name: 'DigitalOcean' });
  expect(within(section).getByText('Development · nyc3')).toBeTruthy();
  expect(within(section).getByText('203.0.113.50')).toBeTruthy();
  expect(within(section).getByText(/Let's Encrypt staging/)).toBeTruthy();
  const table = within(section).getByRole('table', { name: 'Slots' });
  expect(within(table).getByText('Live')).toBeTruthy();
  await userEvent.click(within(table).getByRole('button', { name: 'Activate Purple' }));
  expect(onActivate).toHaveBeenCalledWith('purple');
});

it('warns when the certificate has 14 days or fewer', () => {
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
  render(<DoMachineSection env={{ ...PROD_ENV, do: { ...PROD_ENV.do!, cert_not_after: soon } }}
                           canActivate={false} onActivate={vi.fn()} />);
  expect(screen.getByText(/Renews soon/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
});
```

Create `sirdar/web/src/pages/environments/DoSettingsSection.test.tsx` with tests that:
- with `DO_ENV`, toggling "Activate automatically" calls `updateEnvironment('uat9', { auto_activate: true })` and passes the answer to `onSaved`;
- with `ONE_SLOT_ENV`, "Add a second slot" calls `addSlot('solo')`, passes `environment` to `onSaved` and the deployment to `onDeployStarted`; the button isn't shown for `DO_ENV` or `PROD_ENV`;
- "Save sizes" with the droplet size `s-4vcpu-8gb` calls `updateEnvironment('uat9', { do: { droplet_size: 's-4vcpu-8gb' } })`; the hint says "Sizes only grow";
- with `PROD_ENV`, no auto-activate switch; "Mark retiring" needs `prod` typed and calls `updateEnvironment('prod', { retiring: true, confirm_name: 'prod' })`.

In `DeleteEnvironmentModal.test.tsx` add:
- `DO_ENV`: the list shows "VPC ss-uat9", "Droplet ss-uat9-orange", "Load balancer ss-uat9-lb"; "Take a snapshot first" is checked; unticking it sends `{ mode: 'teardown', confirm_name: 'uat9', snapshot: false }`;
- `PROD_ENV` not retiring: "Mark this production environment retiring first (Settings)." and Delete disabled; retiring with `active_slot: 'blue'`: "Deactivate it first: a live slot can't be deleted."; retiring with no active slot: both "Type prod to confirm" and "Type delete production prod to confirm" are required, there is no snapshot checkbox, and the request is `{ mode: 'teardown', confirm_name: 'prod', confirm_production: 'delete production prod' }`.

In `DeployModal.test.tsx` add:
- `DO_ENV`: no Reset choice; "Deploys to Purple. Traffic stays on Orange until you activate Purple."; the expand/contract note "Migrations must work with the code still live on Orange"; the request is `{ mode: 'update', git_ref: 'main' }`;
- `ONE_SLOT_ENV`: "Deploys to Orange and goes live when its smoke test passes."

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/components/ActivateModal.test.tsx src/pages/environments`
Expected: FAIL.

- [ ] **Step 3: `ActivateModal`**

Create `sirdar/web/src/components/ActivateModal.tsx`:

```tsx
/** Blue/Green: activate a slot (Sirdar smoke-tests it on its droplet, then
 *  moves the load balancer to it), or deactivate a retiring production. A
 *  deployment, so it shows up in Deployments and can be retried. Production
 *  needs its name typed. */
import { useEffect, useRef, useState } from 'react';

import { activateSlot, deployErrorText, type Deployment } from '../lib/sirdarApi';
import { slotTitle } from '../pages/environments/labels';

export default function ActivateModal({ envName, production, slot, fromSlot, version, onStarted, onClose }: {
  envName: string; production: boolean; slot: string | null; fromSlot: string | null; version: string | null;
  onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const title = slot ? `Activate ${slotTitle(slot)}` : 'Deactivate';
  const ready = !production || confirm === envName;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cardRef.current?.querySelector<HTMLElement>('.modal-body input, .modal-foot .btn-solid')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const go = async () => {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await activateSlot(envName, slot, production ? confirm : undefined));
    } catch (err) {
      setError(deployErrorText(err, slot ? "Couldn't activate that slot." : "Couldn't deactivate."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={cardRef} className="modal-card reports-modal-card rgm-card sirdar-activate-card" role="dialog"
           aria-modal="true" aria-labelledby="sirdar-activate-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Blue/Green</div>
            <h3 id="sirdar-activate-title">{title}</h3>
            <p className="page-hint">
              {slot
                ? `Sirdar smoke-tests ${slotTitle(slot)}${version ? ` (${version})` : ''} on its droplet, then the load `
                  + 'balancer sends every request to it.'
                  + (fromSlot ? ` ${slotTitle(fromSlot)} keeps running: activate it again to switch back.` : '')
                : `The load balancer stops sending traffic to ${fromSlot ? slotTitle(fromSlot) : 'any slot'}. Do this only `
                  + "once another environment serves production's names; then Delete can remove it."}
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form">
          {production && (
            <div className="sirdar-span2">
              <label className="field-label" htmlFor="sirdar-activate-confirm">Type {envName} to confirm</label>
              <input id="sirdar-activate-confirm" value={confirm} autoComplete="off" spellCheck={false}
                     onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          {error && <p className="form-error sirdar-span2" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={slot ? 'btn-solid' : 'btn-solid danger'} disabled={busy || !ready}
                  onClick={() => void go()}>{busy ? 'Starting…' : title}</button>
        </div>
      </div>
    </div>
  );
}
```

CSS: `.sirdar-activate-card { width: min(520px, calc(100vw - 32px)); }`.

- [ ] **Step 4: `DoMachineSection` on Overview**

Create `sirdar/web/src/pages/environments/DoMachineSection.tsx`:

```tsx
/** Overview of a DigitalOcean environment: where it runs (account, region),
 *  its load balancer, certificate, database and bucket, and its slots with
 *  Activate on the idle one. */
import DataTable from '@portal/components/DataTable';

import Breakable from '../../components/Breakable';
import type { Environment } from '../../lib/sirdarApi';

import { certDaysLeft, shortSha, slotTitle, when } from './labels';

export default function DoMachineSection({ env, canActivate, onActivate }: {
  env: Environment; canActivate: boolean; onActivate: (slot: string) => void;
}) {
  const d = env.do;
  if (!d) return null;
  const days = certDaysLeft(d.cert_not_after);
  const cert = d.cert_not_after
    ? `${new Date(d.cert_not_after).toLocaleDateString()} (${days} days)${d.acme_staging ? " · Let's Encrypt staging" : ''}`
    : 'Issued by the first deploy';
  return (
    <section className="sirdar-section" aria-labelledby="sirdar-do-heading">
      <h2 id="sirdar-do-heading">DigitalOcean</h2>
      <dl className="sirdar-kv">
        <dt>Account</dt><dd>{d.account_label} · {d.region}</dd>
        <dt>Load balancer</dt><dd className="mono">{d.lb_ip ?? 'Built by the first deploy'}</dd>
        <dt>Certificate</dt>
        <dd>{cert}{days !== null && days <= 14 && <> <span className="chip c-amber">Renews soon</span></>}</dd>
        <dt>Database</dt><dd className="mono"><Breakable text={d.db_host ?? '—'} /></dd>
        <dt>Sizes</dt><dd className="mono">{d.droplet_size} · {d.db_size}{d.db_standby ? ' · standby node' : ''}</dd>
        <dt>Bucket</dt><dd className="mono">{d.bucket ?? '—'}</dd>
      </dl>
      <DataTable
        ariaLabel="Slots"
        columns={[{ key: 'slot', label: 'Slot' }, { key: 'droplet', label: 'Droplet', mono: true },
                  { key: 'commit', label: 'Commit', mono: true }, { key: 'check', label: 'Last check' },
                  { key: 'live', label: '' }]}
        rows={d.slots.map((s) => ({
          key: s.slot,
          cells: [
            <b className="cell-top">{slotTitle(s.slot)}</b>,
            s.public_ip ? `${s.droplet_id} · ${s.public_ip}` : 'Not built yet',
            shortSha(s.sha),
            s.last_check_ok === null ? '—' : `${s.last_check_ok ? 'Passed' : 'Failed'} · ${when(s.last_check_at)}`,
            s.active ? <span className="chip c-green">Live</span>
              : canActivate && s.sha ? (
                <button type="button" className="mini-btn" aria-label={`Activate ${slotTitle(s.slot)}`}
                        onClick={() => onActivate(s.slot)}>Activate</button>
              ) : <span className="cell-sub">{s.sha ? 'Idle' : 'Not deployed'}</span>,
          ],
        }))}
      />
      <p className="page-hint">
        Each deploy goes to the idle slot{env.slots.length === 1 ? ' (this environment has one, so it updates in place)' : ''};
        the database and the bucket are shared by both slots.
      </p>
    </section>
  );
}
```

In `EnvOverview.tsx`, take `canActivate` and `onActivate` props and render `{onDo(env) && <DoMachineSection env={env} canActivate={canActivate} onActivate={onActivate} />}` after "Running"; for DigitalOcean the Services table's Address column shows "On the droplet" for every row (host_ip there is meaningless) and the hint says "The load balancer serves the public names; DNS points at it." In `EnvironmentDetail.tsx`, hold `activating: string | null | undefined` state, pass `canActivate={can('deploy', 'change') && !deploymentRunning(env)}` and `onActivate={setActivating}`, and render `<ActivateModal envName={env.name} production={env.type === 'production'} slot={activating} fromSlot={env.active_slot} version={env.do?.slots.find((s) => s.slot === activating)?.image_tag ?? null} onStarted={started} onClose={() => setActivating(undefined)} />` while `activating !== undefined`.

- [ ] **Step 5: `DoSettingsSection`**

Create `sirdar/web/src/pages/environments/DoSettingsSection.tsx`:

```tsx
/** Settings of a DigitalOcean environment: activate automatically
 *  (non-production, two slots), add the second slot (non-production, one
 *  slot), grow sizes, and mark a production environment retiring. */
import { useState } from 'react';

import { Switch } from '@portal/components/Switch';

import {
  addSlot, deployErrorText, updateEnvironment, type Deployment, type Environment,
} from '../../lib/sirdarApi';

export default function DoSettingsSection({ env, onSaved, onDeployStarted, disabled }: {
  env: Environment; onSaved: (env: Environment) => void; onDeployStarted: (dep: Deployment) => void;
  disabled: boolean;
}) {
  const d = env.do!;
  const production = env.type === 'production';
  const [droplet, setDroplet] = useState(d.droplet_size);
  const [db, setDb] = useState(d.db_size);
  const [standby, setStandby] = useState(d.db_standby);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(deployErrorText(e, fallback)); } finally { setBusy(false); }
  };
  const sizes = () => {
    const patch: { droplet_size?: string; db_size?: string; db_standby?: boolean } = {};
    if (droplet !== d.droplet_size) patch.droplet_size = droplet;
    if (db !== d.db_size) patch.db_size = db;
    if (standby !== d.db_standby) patch.db_standby = standby;
    return patch;
  };

  return (
    <section className="sirdar-section" aria-labelledby="sirdar-do-settings">
      <h2 id="sirdar-do-settings">DigitalOcean</h2>
      <div className="pf-form sirdar-do-form">
        {!production && env.slots.length === 2 && (
          <div className="sirdar-switch-row sirdar-span2">
            <Switch checked={env.auto_activate} disabled={busy || disabled} label="Activate automatically"
                    onChange={(on) => void act(async () => onSaved(await updateEnvironment(env.name, { auto_activate: on })),
                                               "Couldn't change that.")} />
            <span aria-hidden="true">Activate automatically after a good deploy</span>
          </div>
        )}
        {!production && env.slots.length === 1 && (
          <div className="sirdar-span2">
            <button type="button" className="mini-btn" disabled={busy || disabled}
                    onClick={() => void act(async () => {
                      const { environment, deployment } = await addSlot(env.name);
                      onSaved(environment);
                      if (deployment) onDeployStarted(deployment);
                    }, "Couldn't add the slot.")}>Add a second slot</button>
            <p className="page-hint">Builds the purple droplet, lets it reach the database, and deploys the running
              commit to it. Then each deploy goes to the idle slot.</p>
          </div>
        )}
        <div>
          <label className="field-label" htmlFor="do-droplet-size">Droplet size</label>
          <input id="do-droplet-size" value={droplet} spellCheck={false} onChange={(e) => setDroplet(e.target.value.trim())} />
        </div>
        <div>
          <label className="field-label" htmlFor="do-db-size">Database size</label>
          <input id="do-db-size" value={db} spellCheck={false} onChange={(e) => setDb(e.target.value.trim())} />
        </div>
        <div className="sirdar-switch-row sirdar-span2">
          <Switch checked={standby} disabled={d.db_standby || busy || disabled} label="Standby node" onChange={setStandby} />
          <span aria-hidden="true">Standby node</span>
        </div>
        <p className="page-hint sirdar-span2">
          Sizes only grow. A bigger droplet size is applied to a slot on its next deploy, and the droplet stops for a
          few minutes{env.slots.length === 1 ? '; with one slot the site is down meanwhile' : ''}.
        </p>
        <div className="sirdar-span2">
          <button type="button" className="mini-btn" disabled={busy || disabled || !Object.keys(sizes()).length}
                  onClick={() => void act(async () => onSaved(await updateEnvironment(env.name, { do: sizes() })),
                                          "Couldn't save the sizes.")}>Save sizes</button>
        </div>
        {production && !env.retiring && (
          <div className="sirdar-span2">
            <label className="field-label" htmlFor="do-retire-confirm">Type {env.name} to confirm</label>
            <input id="do-retire-confirm" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
            <button type="button" className="mini-btn danger" disabled={busy || disabled || confirm !== env.name}
                    onClick={() => void act(async () => onSaved(await updateEnvironment(
                      env.name, { retiring: true, confirm_name: env.name })), "Couldn't mark it retiring.")}>
              Mark retiring
            </button>
            <p className="page-hint">A retiring production can be deactivated, then deleted. Do this after another
              environment serves production's names.</p>
          </div>
        )}
        {production && env.retiring && <p className="page-hint sirdar-span2">Retiring. Deactivate it, then Delete.</p>}
        {error && <p className="form-error sirdar-span2" role="alert">{error}</p>}
      </div>
    </section>
  );
}
```

In `EnvSettings.tsx`, render `{onDo(env) && <DoSettingsSection env={env} onSaved={onSaved} onDeployStarted={onDeleteStarted} disabled={deploymentRunning(env)} />}` (rename the prop `onDeleteStarted` to `onDeploymentStarted` in `EnvSettings` and `EnvironmentDetail` if that reads better; it already navigates to a deployment), and hide the fields DigitalOcean locks (Target, Proxy IP, Bind IP, Base domain, Spaces bucket, Publish, service addresses).

- [ ] **Step 6: Delete and Deploy**

`DeleteEnvironmentModal.tsx`, when `onDo(env)`:
- the description lists what goes: "A snapshot of the database and files first, then DNS records, then on DigitalOcean:" and `env.do.resources` as `{Kind} {name}` lines (`vpc → VPC`, `droplet → Droplet`, `database → Database`, `spaces_key → Spaces key`, `bucket → Bucket`, `certificate → Certificate`, `load_balancer → Load balancer`, `firewall → Cloud firewall`);
- non-production and deployed: a "Take a snapshot first" checkbox (`Switch`, default on) sends `snapshot: false` when off;
- production: if `!env.retiring`, "Mark this production environment retiring first (Settings)." and Delete stays disabled; else if `env.active_slot`, "Deactivate it first: a live slot can't be deleted." (disabled); else a second field "Type delete production {name} to confirm" and the body adds `confirm_production`.

`DeployModal.tsx`, when `onDo(env)`:
- only Update (no Reset, no VM snapshot choice);
- the lines: `Deploys to ${slotTitle(idleSlot(env))}` + (goesLive ? " and goes live when its smoke test passes." : `. Traffic stays on ${slotTitle(env.active_slot)} until you activate ${slotTitle(idleSlot(env))}.`), and for two slots the note: `Migrations must work with the code still live on ${slotTitle(env.active_slot)}: add columns and tables first, remove them in a later release.`;
- a first deploy from a seed snapshot keeps today's "restores {snapshot}" line.

- [ ] **Step 7: Run the tests and build**

Run: `npm --prefix sirdar/web test -- src/components src/pages/environments && npm --prefix sirdar/web run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add sirdar/web/src/components/ActivateModal.tsx sirdar/web/src/components/ActivateModal.test.tsx sirdar/web/src/pages/environments/DoMachineSection.tsx sirdar/web/src/pages/environments/DoMachineSection.test.tsx sirdar/web/src/pages/environments/DoSettingsSection.tsx sirdar/web/src/pages/environments/DoSettingsSection.test.tsx sirdar/web/src/pages/environments/EnvOverview.tsx sirdar/web/src/pages/environments/EnvSettings.tsx sirdar/web/src/pages/environments/EnvironmentDetail.tsx sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx sirdar/web/src/pages/environments/DeleteEnvironmentModal.test.tsx sirdar/web/src/pages/environments/DeployModal.tsx sirdar/web/src/pages/environments/DeployModal.test.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): DigitalOcean environment pages — slots, Activate, settings, Delete, Deploy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The dashboard — real production card, Activate, slot pairs, certificates

**Files:**
- Modify: `sirdar/web/src/pages/dashboard/ProductionFlow.tsx` (+ test), `EnvCard.tsx`, `DashboardPage.tsx` (+ test), `dashboard.css`

**Interfaces:**
- Consumes: `DashProduction.environment/certificate/slots`, `DashEnvironment.slots/active_slot/certificate`, `ActivateModal` (Task 9), `REAL_PRODUCTION`.
- Produces: ProductionFlow's Activate opens `ActivateModal` (production: typed name) for the idle slot when the production environment exists and the user has `deploy:change`; a certificate pill on the production card and on environment cards ("Certificate: 10 days left", amber at ≤ 14); two-slot environment cards show "Orange live · Purple idle" and an Activate button; demo mode stays inert.

- [ ] **Step 1: Write the failing tests**

Add to `sirdar/web/src/pages/dashboard/ProductionFlow.test.tsx`:

```tsx
it('Activate opens for the idle slot of a real production', async () => {
  const onActivate = vi.fn();
  render(<ProductionFlow production={REAL_PRODUCTION} motion={false} canActivate onActivate={onActivate} />);
  await userEvent.click(screen.getByRole('button', { name: 'Activate Green' }));
  expect(onActivate).toHaveBeenCalledWith('green');
  expect(screen.getByText('Certificate: 10 days left').className).toContain('is-warn');
});

it('demo and read-only cards keep Activate inert', () => {
  render(<ProductionFlow production={DEMO.production} motion={false} canActivate={false} onActivate={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Activate Green' }) as HTMLButtonElement).getAttribute('aria-disabled'))
    .toBe('true');
});
```

(import `screen`, `userEvent`, `REAL_PRODUCTION`). In `DashboardPage.test.tsx`, with the dashboard mock answering `{ ...EMPTY, production: REAL_PRODUCTION, environments: [{ ...card('uat9'), slots: [{ id: 'orange', label: 'Orange', state: 'active', health: 'healthy', version: 'e73b99ca' }, { id: 'purple', label: 'Purple', state: 'standby', health: 'healthy', version: 'f00dbabe' }], active_slot: 'orange' }] }`:
- clicking "Activate Green" opens the Activate dialog for `prod` asking "Type prod to confirm"; confirming calls `activateSlot('prod', 'green', 'prod')` and navigates to `/deploy/environments/prod?deployment=<id>`;
- the uat9 card shows "Orange live · Purple idle" and "Activate Purple", which calls `activateSlot('uat9', 'purple', undefined)` after Confirm.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/dashboard`
Expected: FAIL.

- [ ] **Step 3: ProductionFlow**

`ProductionFlow` takes `canActivate: boolean` and `onActivate: (slot: string) => void`. In `SlotCard`, replace the `SoonButton` with:

```tsx
          {!active && (canActivate && slot.state === 'standby'
            ? <button type="button" className="sd-btn sd-btn-outline sd-slot-action"
                      onClick={() => onActivate(slot.id)}>Activate {title(slot.id)}</button>
            : <SoonButton className="sd-btn-outline sd-slot-action"
                          title={canActivate ? 'Deploy to this slot first.' : undefined}>Activate {title(slot.id)}</SoonButton>)}
```

(pass `canActivate`/`onActivate` down to `SlotCard`). Under the load balancer node, show the certificate:

```tsx
            {production.certificate && (
              <div className={`sd-cert ${production.certificate.warn ? 'is-warn' : ''}`}>
                Certificate: {production.certificate.days_left} days left
              </div>
            )}
```

and the load balancer's IP (`production.load_balancer.ip`) as a muted line when present. `canActivate` is false in demo mode and when `production.environment` is null.

- [ ] **Step 4: EnvCard**

`EnvCard` takes `canActivate` and `onActivate: (env: string, slot: string) => void`. When `env.slots.length === 2`, under the state line:

```tsx
          <div className="sd-env-slots">
            {env.slots.map((s) => `${s.label} ${s.state === 'active' ? 'live' : s.state === 'standby' ? 'idle' : 'empty'}`)
              .join(' · ')}
          </div>
```

and, when `canActivate && name` and a `standby` slot exists, an extra `sd-btn-outline` button `Activate {label}` that calls `onActivate(name, slot.id)`. Show `env.certificate` like the production card (`Certificate: N days left`, amber at warn).

- [ ] **Step 5: DashboardPage**

Hold `activating: { env: string; slot: string; production: boolean; from: string | null } | null`. Pass `canActivate={!data.demo && !!data.production.environment && can('deploy', 'change')}` and `onActivate={(slot) => setActivating({ env: data.production.environment!, slot, production: true, from: data.production.active_slot })}` to `ProductionFlow`, and the same for each `EnvCard` (`production: false`, `from: env.active_slot`). Render `ActivateModal` (as a sibling of `.sd-dash`, like `DeployModal`) with `onStarted={(dep) => navigate(`/deploy/environments/${encodeURIComponent(activating.env)}?deployment=${dep.id}`)}`. Update the page docstring ("…production actions are still to come" → "Activate switches production's slots").

CSS in `dashboard.css`: `.sd-cert` (small muted line, `is-warn` uses the existing amber token), `.sd-env-slots` (muted, one line, ellipsis).

- [ ] **Step 6: Run the tests and build**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: the whole web suite passes; clean build.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/pages/dashboard/ProductionFlow.tsx sirdar/web/src/pages/dashboard/ProductionFlow.test.tsx sirdar/web/src/pages/dashboard/EnvCard.tsx sirdar/web/src/pages/dashboard/DashboardPage.tsx sirdar/web/src/pages/dashboard/DashboardPage.test.tsx sirdar/web/src/pages/dashboard/dashboard.css
git commit -m "feat(sirdar-web): dashboard Activate, slot pairs and certificate warnings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Live verify in the Development account (controller, not a subagent)

Run by the controller after 7a and Tasks 1–10 are reviewed and merged on `sirdar`, with Jimmy. Jimmy has approved the cost of one throwaway two-slot environment, built and deleted the same day.

**Safety rules (repeat them to Jimmy before starting):**
- Only the **Development** account. Never touch the Production account's resources, and never V2 production.
- Jimmy types every token himself into Sirdar's Settings; the controller never sees, types or stores one.
- The only environment created, deployed, switched and deleted is `uat9`. Nothing else in the account is changed; everything Sirdar makes carries `sirdar-env-<uat9's id>` or an `ss-uat9…` name.
- Let's Encrypt **staging** (`acme_staging`) for uat9, so the run can't hit production rate limits.

- [ ] **Step 1: Before anything — the account and tokens (Jimmy)**

1. In the Development DigitalOcean team, Jimmy creates:
   - the account token (full access, or read + write), and
   - the renewal token: API › Generate New Token › Custom Scopes: `certificate` create/read/delete, `load_balancer` read/update.
2. Record in the ledger (`.superpowers/sdd/progress.md`) the tagged resources that already exist: `doctl compute droplet list --tag-name sirdar`, and the same for databases (`doctl databases list`), load balancers, VPCs and Spaces keys, to compare at the end. Jimmy runs these (or reads them in the control panel).

- [ ] **Step 2: Update Tower's Sirdar to the branch head**

1. Push `sirdar` to GitHub, with Jimmy's go-ahead.
2. Update Tower's Sirdar with the installer pinned to that SHA (memory: `SIRDAR_DIR=/mnt/user/serversherpa/sirdar`).
3. Confirm `alembic current` shows `0010` in the Sirdar container, and that the Settings page shows both DigitalOcean account cards (the old token appears as the Production account).

- [ ] **Step 3: Set up the Development account (Jimmy types)**

1. Settings › Integrations › DigitalOcean · Development › Set up: label "Development", the tokens, region (the account's usual one).
2. Test. Expected: Account, Team, Droplets and Region pass; Renewal token passes (a warn means the token can read droplets: make a narrower one).
3. Save. Check the audit row `deploy.do_account_update` lists `token` and `renewal_token`, and no value.

- [ ] **Step 4: Create uat9 from the uat snapshot**

1. New environment › name `uat9`, type Dev, target DigitalOcean.
2. DigitalOcean step: account Development, Two slots (orange + purple), default sizes, Standby off, **Let's Encrypt staging on**, Activate automatically **off**.
3. Data: From a snapshot › `uat-2026-10-05`.
4. Create. Check the Overview's DigitalOcean section: account, sizes, "Built by the first deploy".

- [ ] **Step 5: First deploy (orange goes live by itself)**

1. Deploy › Update `main`. The modal says it deploys to Orange and goes live.
2. Watch step 0's log, in order: the team, `Created the VPC ss-uat9`, the bucket and its key, both droplets, `Creating the database cluster ss-uat9-db`, the firewall line, `online at private-…:25060`, two pinned host keys, the commit, `Database: serversherpa owns serversherpa`, the staging certificate (five DNS challenge lines), `Creating the load balancer ss-uat9-lb`, `active at <ip>`, the cloud firewall.
3. Then 1–10 (restore from the snapshot onto the managed database and Spaces), 12 DNS at the load balancer IP, 13 slot smoke, 14 Switch traffic (the public smoke test runs without certificate checks: staging).
4. Check in the control panel (Jimmy): the database's Trusted Sources list exactly the two droplets; the bucket's key is limited to the bucket; the load balancer targets `ss-uat9-orange`; the cloud firewall applies to the `sirdar-env-<id>` tag.
5. Check from the Mac: `curl -sk https://api.uat9.serversherpa.com/healthz` answers 200 (staging certificate); signing in at `https://portal.uat9.serversherpa.com` works with a uat account (the snapshot's pepper came along).
6. Record in the ledger every uncertain API point from the context file as confirmed or not (Spaces bucket signing region, per-bucket keys, firewall-while-creating, doadmin's privileges, LB forwarding rules, Compose nested defaults, asyncpg TLS, presigned uploads — upload a file in the portal).

- [ ] **Step 6: Deploy to purple and Activate it**

1. Deploy › Update `main` again: it goes to Purple and stops after 13 (Traffic stays on Orange).
2. Overview › Slots › Activate Purple. The deployment runs 13 and 14; the load balancer now targets `ss-uat9-purple` (control panel), and the public URLs still answer.
3. Activate Orange again (the instant switch back), then Purple once more.

- [ ] **Step 7: Force a cert-worker renewal (staging)**

Sirdar offers no shell on droplets. Jimmy opens the **Droplet Console** in the control panel for `ss-uat9-purple` (the live slot), logging in as `deploy` (passwordless sudo). If the console can't log in as `deploy`, stop here, record "cert-worker renewal not verified live" in the ledger, and go on to Step 8.

1. In the console:

   ```bash
   cd /opt/serversherpa/uat9/repo/deploy/stack
   C="docker compose --env-file /opt/serversherpa/uat9/.env -f api/compose.yml --profile certs"
   $C stop cert-worker
   $C run --rm --use-aliases cert-worker serversherpa cert-worker --once --renew-days 365
   $C start cert-worker
   ```

   `--use-aliases` keeps the name `cert-worker` on the network, so Caddy forwards the HTTP-01 challenge to the one-off container.
2. Expected output: `renewed`. In the control panel, the load balancer now uses a new certificate `ss-uat9-<UTC now>` and the previous one is gone.
3. On `ss-uat9-orange` (idle) the same `--once` command prints `not_active`.
4. Deploy uat9 once more (Update `main`): step 0 logs "Recorded the certificate ss-uat9-… the cert-worker uploaded." and nothing is re-issued.

- [ ] **Step 8: Delete and confirm nothing tagged remains**

1. Settings › Delete environment › leave "Take a snapshot first" on › type `uat9`. The plan is 11 Take snapshot, 17 Remove DNS records, 18 Remove DigitalOcean resources.
2. Step 18's log ends with "Nothing of this environment is left on DigitalOcean." The snapshot `uat9-before-delete-…` is listed under Snapshots (Ready).
3. Jimmy checks in the control panel (and `doctl`): no droplet, database, load balancer, certificate, firewall, VPC, Spaces key or bucket named `ss-uat9…` or tagged `sirdar-env-<id>`; the list matches Step 1's "before". Cloudflare has no `*.uat9` records and no `_acme-challenge` TXT left.
4. If anything remains, record it, delete it by hand with Jimmy, and open a follow-up.

- [ ] **Step 9: Record and clean up**

1. Ledger entry: what passed, timings (step 0, the restore, Activate), every confirmed or corrected API point, and copy fixes. Fix issues found live in small commits `fix(sirdar): …` / `fix(sirdar-web): …`.
2. Update the memory note `sirdar.md` with the phase 7 status.
3. Ask Jimmy whether to merge `sirdar` to main and push.

## Self-review notes (for the controller)

- Spec coverage: Activate and auto-activate (§4) → Task 1; add a slot (§4) and grows (§2) → Task 2; the cert-worker (§3) → Tasks 3, 4; Sirdar backup renewal and the 14-day warning (§3, §7) → Tasks 4, 5, 10; dashboard (§7) → Tasks 5, 10; accounts in the UI, both accounts in the dashboard and connection test (§8) → Tasks 5, 7; Delete's production rules in the UI (§6) → Task 9; live verify (§10) → Task 11.
- Names used across tasks: `activateSlot`, `addSlot`, `getDoAccounts/saveDoAccount/testDoAccount/clearDoAccount`, `getDoRegions(account)`, `ActivateModal`, `DoMachineSection`, `DoSettingsSection`, `onDo`, `idleSlot`, `goesLive`, `slotTitle`, `certDaysLeft`, `REAL_PRODUCTION`, `DO_ENV`, `ONE_SLOT_ENV`, `PROD_ENV`, `DO_ACCOUNTS`.
- Judgment calls to watch: Deactivate exists only for a retiring production; the periodic renewal is a deployment; the cert-worker idles where `SS_CERT_*` aren't set; the `/integrations/digitalocean` alias stays in the API.
