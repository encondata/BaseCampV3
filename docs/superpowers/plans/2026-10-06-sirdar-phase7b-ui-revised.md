# Sirdar deploy phase 7b, revised (Blue/Green, renewal, the environment spotlight, the DigitalOcean UI, the live verify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This plan replaces `2026-10-05-sirdar-phase7b-ui.md`. That plan was written before 7a was built; 7a then changed in review (zero-downtime Switch traffic, CA-verified database TLS, the slot's commit set at `up`, seed refusal, production Delete rules, the web copy scanner, the cert-worker's `switching` outcome). Every task below was checked against the code at `a939112d` (main = sirdar, 7a merged, 7b Task 3 merged) plus the spotlight spec commit.

**Goal:** Finish phase 7 on top of 7a:

- **Activate** moves a DigitalOcean environment's load balancer to its idle slot (a deployment: smoke test, then zero-downtime switch); **Deactivate** (a retiring production only) points it at nothing; non-production environments can **activate automatically**; a one-slot environment can **add its second slot**; droplet and database sizes can **grow**;
- **Sirdar is the backup certificate renewer**: a `renew` deployment every 6 hours for each environment with 14 days or fewer left, and every droplet's `.env` carries the cert-worker's `SS_CERT_*` keys (the cert-worker itself is done: Task 3);
- the **Deployments page spotlight**: any environment (production first) shown as live traffic → load balancer or Nginx Proxy Manager → its server(s), with Activate, Deploy and Open; both DigitalOcean accounts in the infrastructure view;
- the **web**: both accounts in Settings and on the Deploy page, DigitalOcean in New environment, the DigitalOcean environment pages (Overview, Settings, Delete, Deploy, Deployments), the spotlight;
- the **live verify**: a throwaway two-slot dev environment in the Development account, folding in the 7a whole-phase checklist.

**Architecture:**

- Backend: Tasks 1 → 2 → 4 run in that order (they share `routes/deploy.py`, `steps.py`, `pipeline.py`, `do_envs.py`, `do_provision.py`). Task 5 (dashboard API) touches only `dashboard/` and runs in parallel with them.
- Activate is a deployment of mode `activate` (13 Smoke test (slot), 14 Switch traffic, already in 7a's `_CLOUD_PLANS`); Deactivate is mode `activate` with `slot=None`, whose plan is 14 alone (new `plan_for(..., smoke=False)`). Switch traffic is 7a's zero-downtime `_go_live`: add the new droplet, wait for the load balancer, the droplet's own `/healthz`, the health-check settle, a public smoke test, new-only, `_prove_switch`, a second public smoke test; any failure puts the previous targets back.
- The backup renewal is a deployment of mode `renew` (19 Renew certificate, `runs="vm"`), so it shares the one-running-deployment lock with Activate and keeps the environment's status.
- Web: Task 6 owns every shared web file (`sirdarApi.ts` types/calls/copy, `labels.tsx`, both `testData.ts`, the new CSS) so Tasks 7, 8 and 9 touch disjoint files and run in parallel. Task 10 (the spotlight) follows Tasks 5, 6 and 9.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, httpx, Alembic (no migration in 7b), Docker Compose; React 18 + TypeScript, Vite, Vitest + Testing Library (jsdom), GSAP (MotionPathPlugin), the portal's `DataTable` / `ComboBox` / `Switch` / `lib/api` through `@portal`.

**Spec and context:**

- Spec: `docs/superpowers/specs/2026-10-05-sirdar-digitalocean-environments-design.md` (§3 renewal, §4 Blue/Green, §8 accounts in the UI).
- Spotlight spec (approved 2026-10-06, replaces the old Task 10 and the old `GET /dashboard` shape): `docs/superpowers/specs/2026-10-06-sirdar-dashboard-spotlight-design.md`.
- Decisions: `docs/superpowers/plans/2026-10-05-sirdar-phase7-context.md`.
- 7a reports and review fixes: `.superpowers/sdd/p7a-task-*-report.md`, `p7b-task-3-report.md`; ledger `.superpowers/sdd/progress.md`; live-verify checklist `.superpowers/sdd/p7-live-verify-checklist.md`.

## Global Constraints

**Where and how to work**

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it.
- `sirdar` is both a branch and a folder: use `--` in `git diff` and `git log`.
- Other agents commit here at the same time: `git add` only your task's files (see "File ownership"); never `git add -A`, never bare `git stash`; retry when `.git/index.lock` is busy. Never `git checkout --` a file another task owns. If a file this plan edits changed since it was written, apply the same edit to the new text and keep their change.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Backend**

- Python 3.13, Ruff line length 100, `asyncio_mode = "auto"`. Changed files pass `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` (from `sirdar/api`).
- Sirdar's dev database must be up (from the main checkout: `docker compose -f docker-compose.dev.yml up -d sirdar-db`, Postgres on 127.0.0.1:5434).
- Sirdar tests run from `sirdar/api` with **this task's own test DB**: `SIRDAR_TEST_DB=sirdar_test_p7bN .venv/bin/pytest -q tests/<file>` (N = the task number). Never the dev `sirdar` DB; run test files in the foreground. Implementers run focused files; the controller runs the whole suite (about 12 minutes).
- When the task is done, drop its DBs: `PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7bN` and the same for `sirdar_test_p7bN_source` (a bare `dropdb` prompts and hangs).
- Deploy-stack suite (only when a task touches `deploy/stack`): from the worktree root, `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests` (expected: 65 passed, 28 deselected).
- No migration: 0010 already allows the modes `activate` and `renew`, the four slot names, `auto_activate` (refused on production by `environments_production_check`) and `retiring`.
- Secrets (account and renewal tokens, ACME keys, certificate keys, database passwords, the Spaces secret) never reach a response, log, audit row, exception text or `repr()`.
- Tests never reach real DigitalOcean, Spaces, Let's Encrypt or Cloudflare (`do_helpers.do_cloud` wires the fakes into `outbound.transports()`).

**Web**

- Web tests: `npm --prefix sirdar/web test` (or a path filter after `--`). Type-check and build: `npm --prefix sirdar/web run build`. Never `npm install`.
- Every new modal gets the report-generate header (`.rgm-card`, `.rgm-head-text` with `.eyebrow`, `h3` title, `.page-hint` description; `.rgm-steps` when it has steps) and sizes to its content (a content-matched card width class in `sirdar.css`; dropdowns through `portal`).
- Reuse the portal idioms: `DataTable`, `ComboBox` (with `portal`), `Switch` (named export; its `label` is the checkbox's accessible name), segmented radio groups (`.segmented`, `role="radio"`, `arrowNav` from `lib/arrowNav`), chips (`chip c-green|c-amber|c-red|c-blue|tag`), `.pf-form` with `.field-label` (`span.field-label` for captions that aren't labels), `sirdar-span2` for full-width rows, `.sirdar-kv`, `Breakable`. **Never a raw `<select>`.**
- Component tests start with `// @vitest-environment jsdom`, mock `../../lib/sirdarApi` (spreading the real module) and `@portal/auth/AuthContext` as the existing tests do, and set `Element.prototype.scrollIntoView = () => {}` when a ComboBox is used.
- No new `@portal` import beyond the allowlist (`auth/AuthContext`, `components/DataTable`, `components/ComboBox`, `components/Switch`, `lib/api`).
- The copy scanner (`src/lib/sirdarApi.test.ts`, "every error code the deploy routes can return has its own message") reads `routes/deploy.py`, `routes/integrations.py`, `environments.py`, `gitref.py`, `ssh_targets.py`, `snapshots.py`, `integrations.py`, `vms.py`, `do_accounts.py`, `do_envs.py` and `pipeline.py`. Every new code a backend task adds must have copy in `MESSAGES`; Task 6 adds all of them up front (the table below), so the scanner stays green in any order.
- American English in all copy, comments and docs ("Canceled" for `cancelled`). Don't add reader-facing widgets the spec doesn't ask for.

## 7a as built (what the old 7b plan got wrong)

- **Test helpers moved.** `make_do_environment`, `configure_account`, `do_cloud`, `do_build`, `built`, `built_env`, `deployed(db, env, active, *, sha)`, `fetched`, `ready_snapshot`, `CA`, `DOADMIN`, `SPACES_SECRET` live in `tests/do_helpers.py`. `test_deploy_do_deployments_api._deployed(db, env, active)` wraps `deployed(..., sha=SHA)`; its `ready` fixture records step 0's rows through `fake_provisioner.effects["do_prepare"] = built`. `pipeline.wait()` takes a `uuid.UUID`, not the response's string id.
- **`create_deployment(..., cloud, slot, go_live)`** raises `ValueError` unless `cloud` matches the target, forces `go_live=True` for `activate`, raises `NotSupportedOnDigitalOcean` for reset/restore_dump/rollback/vm_restore, and through `_check_cloud` raises `do_envs.DoEnvError("slot_not_deployed", slot=…)` for an Activate of a slot with no `sha`, and `seed_not_allowed`. `_launch` maps `DoEnvError` to 409 `{code, **extra}`.
- **`plan_for(mode, *, restore, publish, vm, cloud, go_live, snapshot)`**: `_CLOUD_PLANS[("activate", False)] == ("slot_smoke", "go_live")` already exists; Deactivate needs the new `smoke` flag.
- **The slot's commit** is written to `do_slots.sha/image_tag` when `up` succeeds; `after_success` makes the slot's commit the environment's when traffic moved; a failed go_live keeps the old `active_slot` (and `env.status = "failed"`).
- **`DoContext`** fields: `env_id, env_name, env_type, deployment_id, actor_id, mode, git_ref, sha, repo_url, slot, go_live, slots, active_slot, account_key, account_label, team_uuid, region, droplet_size, droplet_image, db_size, db_standby, acme_staging, acme_directory, bucket, ssh_public_key, slot_states, hosts, token, db_password, ssh_private_key, db_admin_password, cloudflare`. No load-balancer id: steps read `load_records(ctx.env_id)`.
- **`do_provision`** helpers: `_same_team`, `_live_lb(api, ctx, records)`, `_lb_active`, `_put_targets`, `_certificate(api, ctx, out)` (records what the cert-worker uploaded; issues by DNS-01 only at ≤ `certs.SIRDAR_RENEW_DAYS`), `_retire_certificates(api, ctx, keep, out)`, `_rules(cert_id)`, `lb_update_body(lb, **changes)`, `https_certificate(lb)`; `_wait(fetch, ready, seconds, what)`. A load-balancer PUT while it applies the previous one is refused (422): wait for `active` first.
- **`do_api`** has `droplet_action`, `resize_database`, `sizes`, `database_options`, but **no `get_action`**; the fake's droplet actions finish only when polled while `action_polls > 0`.
- **`envfile.EXTRA_KEYS`** ends `… SS_DATABASE_SSL, SS_DATABASE_CA_B64, SS_SPACES_ENDPOINT, SS_SPACES_REGION, SS_SPACES_ACCESS_KEY, SS_SPACES_SECRET_KEY, SS_SPACES_USE_PATH_STYLE, STACK_DROPLET_ID`; `env.example` lists them commented out; `env_extra` returns `(extra, [url, spaces_secret, ca_b64, (quoted password)])` and its `missing` order is load balancer address, VPC range, database host, database port, database CA, Spaces key, droplet.
- **Redaction** is already wide: `do_envs.secret_values` (account token, renewal token, ACME PEM, Spaces secret, doadmin password) at the run's start and in each host `_prepare`, plus `env_extra`'s list.
- **Routes**: `RetryIn` already has `confirm_production`; `DeploymentIn` has `snapshot` and `confirm_production`; `_production_removable` checks retiring → no active slot → phrase under `environments.lock_production`.
- **Web**: `MESSAGES` already has copy for every 7a code (`slot_not_deployed`, `seed_not_allowed`, `production_slot_active`, …); the Delete checkbox the copy names is **"Save a snapshot first"**; there are no DigitalOcean types, calls, fixtures or labels yet; `DashboardData.production` and `ProductionFlow` still exist.

## New error codes (copy added by Task 6)

| Code | Status | Added by | Copy |
|---|---|---|---|
| `not_digitalocean_environment` | 409 | Task 1 | This environment isn't on DigitalOcean. |
| `slot_invalid` | 422 | Task 1 | That isn't one of this environment's slots. |
| `slot_required` | 422 | Task 1 | Choose the slot to activate. |
| `slot_already_active` | 409 | Task 1 | That slot is already live. |
| `production_retiring` | 409 | Task 1 | This production environment is retiring: it can only be deactivated. |
| `already_inactive` | 409 | Task 1 | No slot is live. |
| `auto_activate_not_allowed` | 422 | Task 1 | Only non-production DigitalOcean environments activate automatically. |
| `slots_full` | 409 | Task 2 | This environment already has two slots. |
| `slot_not_allowed` | 422 | Task 2 | Production always has its Blue and Green slots. |
| `do_shrink_refused` | 422 | Task 2 | Sizes can only grow. |

## File ownership / parallelism

| Task | Files (create or modify) | Runs |
|---|---|---|
| 1 Activate, Deactivate, auto-activate | `deploy/steps.py`, `deploy/pipeline.py`, `deploy/environments.py`, `deploy/do_envs.py` (`check_spec`), `api/routes/deploy.py`; tests `test_deploy_do_activate_api.py` (new), `test_deploy_playbooks.py` | first backend task |
| 2 Second slot, grow, per-account regions/connect | `deploy/do_api.py`, `deploy/do_envs.py`, `deploy/environments.py`, `deploy/do_provision.py`, `api/routes/deploy.py`, `deploy/stack/ss-stack` (comment); tests `test_deploy_do_slots_and_sizes.py` (new), `test_deploy_do_api.py`, `test_deploy_do_account_targets.py` (new) | after 1 |
| 3 cert-worker | done | — |
| 4 Renewal side | `deploy/envfile.py`, `deploy/stack/env.example`, `deploy/do_envs.py` (`env_extra`), `deploy/steps.py`, `deploy/pipeline.py`, `deploy/do_provision.py`, `deploy/renewals.py` (new), `config.py`, `api/app.py`; tests `do_helpers.py`, `test_deploy_do_environments.py`, `test_deploy_envfile.py`, `test_deploy_pipeline_do.py`, `test_deploy_playbooks.py`, `test_deploy_do_renewals.py` (new) | after 2 |
| 5 Dashboard API | `dashboard/service.py`, `dashboard/demo.py`; tests `test_dashboard_api.py`, `test_dashboard_flow.py` (new), `test_deploy_digitalocean_integration.py` (one expected dict) | parallel with 1, 2, 4 |
| 6 Web foundation | `web/src/lib/sirdarApi.ts` (+ test), `pages/environments/labels.tsx` (+ test), `pages/environments/testData.ts`, `pages/dashboard/testData.ts`, `styles/sirdar.css` | parallel with 1–5 |
| 7 Accounts in Settings and Deploy | `pages/settings/DoAccountModal.tsx` (+ test, new), `IntegrationsSection.tsx` (+ test), `DigitalOceanModal.tsx` (+ test, deleted), `pages/Deploy.tsx` (+ test) | after 6, parallel with 8, 9 |
| 8 New environment on DigitalOcean | `pages/environments/NewEnvironmentModal.tsx` (+ test) | after 6, parallel with 7, 9 |
| 9 Environment pages | `components/ActivateModal.tsx` (+ test, new), `pages/environments/DoMachineSection.tsx`, `DoSettingsSection.tsx` (+ tests, new), `EnvOverview.tsx`, `EnvSettings.tsx`, `EnvironmentDetail.tsx`, `DeleteEnvironmentModal.tsx`, `DeployModal.tsx`, `DeploymentView.tsx`, `DeploymentsTab.tsx`, `BackupsTab.tsx` (+ their tests) | after 6, parallel with 7, 8 |
| 10 Spotlight | `lib/sirdarApi.ts` (dashboard section only), `pages/dashboard/*` (`ProductionFlow.tsx` → `EnvironmentFlow.tsx`, new `Spotlight.tsx`, `EnvCard.tsx`, `DashboardPage.tsx`, `testData.ts`, `dashboard.css`, tests) | after 5, 6, 9 |
| 11 Live verify | controller | last |

Dependency graph: `1 → 2 → 4`; `5` ‖ `1, 2, 4`; `6` ‖ backend; `6 → {7, 8, 9}`; `{5, 6, 9} → 10`; everything → 11. Web tests that call the real API shapes use fixtures, so Tasks 6–10 never wait on the backend tasks; only Task 11 needs both.

---

### Task 1: Activate, Deactivate and auto-activate

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (`plan_for(..., smoke=True)`)
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py` (`smokes`, `plan_of`, `create_deployment`)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_envs.py` (`check_spec` reads `auto_activate`)
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`_create_on_do` stores it; `update` takes `auto_activate`)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`POST /environments/{name}/activate`, `DoIn.auto_activate`, `EnvironmentPatch.auto_activate`, `CHANGE_MODES`, retry)
- Create: `sirdar/api/tests/test_deploy_do_activate_api.py`
- Modify: `sirdar/api/tests/test_deploy_playbooks.py`

**Interfaces:**
- Consumes (7a): `pipeline.create_deployment(db, env, *, mode, git_ref, sha, actor_id, …, cloud, slot, go_live)` (forces `go_live` for `activate`; `_check_cloud` raises `DoEnvError("slot_not_deployed", slot=…)`), `do_envs.after_success` (an activate with `slot=None` clears `active_slot`), `do_envs.goes_live` (already honors `auto_activate` off production), `do_envs.slots_of`, routes' `_environment`, `_on_do`, `_require_account`, `_host_target(db, env, *, slot)`, `_launch(..., cloud, slot, go_live)` (maps `DoEnvError` to 409, audits `slot` and `go_live` for cloud runs), `environments.is_deploying`.
- Produces:
  - `steps.plan_for(mode, *, restore=False, publish=False, vm=False, cloud=False, go_live=False, snapshot=False, smoke=True)`; the cloud `activate` plan is `["slot_smoke", "go_live"]`, or `["go_live"]` with `smoke=False`.
  - `pipeline.smokes(mode: str, slot: str | None) -> bool` (`False` only for `activate` with no slot).
  - `POST /api/deploy/environments/{name}/activate` (`deploy:change`). Body `{slot: string | null, confirm_name?: string}` → `Deployment` (201). Errors, in order: 409 `not_digitalocean_environment`; 422 `confirm_name_mismatch` (production); 409 `deploy_in_progress`; 400 `secrets_key_missing`; 409 `do_account_not_configured {account}` / `do_not_ready`; then for `slot: null`: 422 `slot_required` (anything but a retiring production), 409 `already_inactive`; for a slot: 422 `slot_invalid`, 409 `production_retiring`, 409 `slot_already_active`, 409 `slot_not_deployed {slot}`, 409 `do_not_ready` (its droplet has no address). Audit `deploy.activate` with `environment`, `mode`, `slot`, `go_live`.
  - `POST /environments` `do.auto_activate?: bool` (422 `auto_activate_not_allowed` on production); `PATCH /environments/{name}` `auto_activate?: bool` (422 `auto_activate_not_allowed` unless a non-production DigitalOcean environment).
  - Retry: `activate` is retryable; it needs `deploy:change`, and production's also needs `confirm_name`. A production Activate retried while the environment is retiring answers 409 `production_retiring`.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/test_deploy_playbooks.py`, after `test_digitalocean_plans`:

```python
def test_deactivate_has_no_slot_smoke_test():
    assert _cloud("activate", smoke=False) == ["go_live"]
    assert _cloud("activate") == ["slot_smoke", "go_live"]
    for mode in ("update", "teardown"):
        with pytest.raises(ValueError):
            steps.plan_for(mode, cloud=True, smoke=False)   # only Deactivate skips it
```

Create `sirdar/api/tests/test_deploy_do_activate_api.py`:

```python
"""Activate on a DigitalOcean environment: a deployment that smoke-tests the
slot on its droplet, then moves the load balancer to it (7a's zero-downtime
Switch traffic); Deactivate (a retiring production only) points the load
balancer at nothing; a non-production environment can activate by itself
after a good deploy. The pipeline runs with fakes."""

import uuid

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, DoSlot, Environment
from sirdar_api.deploy import pipeline, vms
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import built, built_env, deployed, make_do_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA

NEWER = "e1" * 20
URL = "/api/deploy/environments"


@pytest.fixture
async def ready(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_runner,
                fake_publisher, fake_provisioner):
    """make(**kw): a built DigitalOcean environment, every slot deployed at SHA
    and `active` (default: the first slot) live."""
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)

    async def make(*, active: str | None = None, **kw) -> Environment:
        env = await make_do_environment(db, **kw)
        await built_env(env)
        await deployed(db, env, active or env.slots[0], sha=SHA)
        return env
    return make


async def _wait(resp):
    if resp.status_code == 201:
        await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp


async def _activate(client, h, name, **body):
    return await _wait(await client.post(f"{URL}/{name}/activate", headers=h, json=body))


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def _env(db, env_id) -> Environment:
    return await db.get(Environment, env_id, populate_existing=True)


async def test_activate_the_idle_slot(client, db, ready, fake_provisioner, fake_runner):
    env = await ready()
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "purple")
                     .values(sha=NEWER, image_tag=NEWER[:8]))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _activate(client, h, "uat9", slot="purple")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["slot"], body["go_live"], body["sha"]) == (
        "activate", "purple", True, NEWER)
    assert [s["key"] for s in body["steps"]] == ["slot_smoke", "go_live"]
    assert fake_runner.steps() == ["slot_smoke"]
    assert fake_provisioner.calls == ["go_live"]
    env = await _env(db, env.id)
    assert (env.active_slot, env.current_sha, env.image_tag, env.status) == (
        "purple", NEWER, NEWER[:8], "ready")
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.activate"))).one()
    assert (audit["environment"], audit["mode"], audit["slot"], audit["go_live"]) == (
        "uat9", "activate", "purple", True)


@pytest.mark.parametrize("body, expected", [
    ({"slot": "orange"}, (409, "slot_already_active")),
    ({"slot": "blue"}, (422, "slot_invalid")),
    ({"slot": None}, (422, "slot_required")),
])
async def test_activate_refusals(client, db, ready, body, expected):
    await ready()
    h = await auth_headers(client, db)
    assert _code(await _activate(client, h, "uat9", **body)) == expected


async def test_a_slot_that_never_ran_a_deploy(client, db, ready):
    env = await ready()
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "purple").values(sha=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _activate(client, h, "uat9", slot="purple")
    assert _code(resp) == (409, "slot_not_deployed")
    assert resp.json()["detail"]["slot"] == "purple"


async def test_only_digitalocean_activates(client, db, ready):
    from .deploy_factories import make_environment
    await make_environment(db, name="lan1", secrets={})
    h = await auth_headers(client, db)
    assert _code(await _activate(client, h, "lan1", slot="orange")) == (
        409, "not_digitalocean_environment")


async def test_production_needs_the_name_and_deactivates_only_when_retiring(
        client, db, ready, fake_runner):
    env = await ready(name="prod", type_="production", account="production", active="blue")
    h = await auth_headers(client, db)
    assert _code(await _activate(client, h, "prod", slot="green")) == (
        422, "confirm_name_mismatch")
    resp = await _activate(client, h, "prod", slot="green", confirm_name="prod")
    assert resp.status_code == 201, resp.text
    assert (await _env(db, env.id)).active_slot == "green"
    assert _code(await _activate(client, h, "prod", slot=None, confirm_name="prod")) == (
        422, "slot_required")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    assert _code(await _activate(client, h, "prod", slot="blue", confirm_name="prod")) == (
        409, "production_retiring")
    fake_runner.requests.clear()
    resp = await _activate(client, h, "prod", slot=None, confirm_name="prod")
    assert resp.status_code == 201, resp.text
    assert ([s["key"] for s in resp.json()["steps"]], resp.json()["slot"]) == (["go_live"], None)
    assert fake_runner.requests == []                    # Deactivate has no slot to test
    env = await _env(db, env.id)
    assert (env.active_slot, env.status) == (None, "ready")
    assert _code(await _activate(client, h, "prod", slot=None, confirm_name="prod")) == (
        409, "already_inactive")


async def test_activate_needs_change(client, db, ready):
    await ready()
    h = await auth_headers(client, db, email="v@test.example.com", roles=("admin",))
    resp = await client.post(f"{URL}/uat9/activate", headers=h, json={"slot": "purple"})
    assert resp.status_code == 403


async def test_a_failed_activate_is_retried(client, db, ready, fake_runner):
    env = await ready()
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    failed = (await _activate(client, h, "uat9", slot="purple")).json()
    env = await _env(db, env.id)
    assert (env.active_slot, env.status) == ("orange", "failed")   # orange still live
    fake_runner.results.clear()
    resp = await _wait(await client.post(f"/api/deploy/deployments/{failed['id']}/retry",
                                         headers=h, json={}))
    assert resp.status_code == 201, resp.text
    assert (resp.json()["mode"], resp.json()["slot"], resp.json()["start_step"]) == (
        "activate", "purple", 13)
    assert (await _env(db, env.id)).active_slot == "purple"


async def test_a_production_activate_retry_needs_the_name(client, db, ready, fake_runner):
    await ready(name="prod", type_="production", account="production", active="blue")
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    failed = (await _activate(client, h, "prod", slot="green", confirm_name="prod")).json()
    fake_runner.results.clear()
    retry = f"/api/deploy/deployments/{failed['id']}/retry"
    assert _code(await client.post(retry, headers=h, json={})) == (422, "confirm_name_mismatch")
    resp = await _wait(await client.post(retry, headers=h, json={"confirm_name": "prod"}))
    assert resp.status_code == 201, resp.text


async def test_auto_activate(client, db, ready):
    await ready()
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"auto_activate": True})
    assert resp.status_code == 200 and resp.json()["auto_activate"] is True
    resp = await _wait(await client.post(f"{URL}/uat9/deployments", headers=h,
                                         json={"mode": "update"}))
    assert (resp.json()["slot"], resp.json()["go_live"]) == ("purple", True)


async def test_auto_activate_is_not_for_production(client, db, ready):
    await ready(name="prod", type_="production", account="production", active="blue")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/prod", headers=h, json={"auto_activate": True})
    assert _code(resp) == (422, "auto_activate_not_allowed")
    from .deploy_factories import make_environment
    await make_environment(db, name="lan1", secrets={})
    resp = await client.patch(f"{URL}/lan1", headers=h, json={"auto_activate": True})
    assert _code(resp) == (422, "auto_activate_not_allowed")


async def test_auto_activate_at_create(client, db, ready):
    env = await make_do_environment(db, name="auto1", auto_activate=True)
    assert (await _env(db, env.id)).auto_activate is True
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        "mode": "new", "name": "prod2", "type": "production", "target": "digitalocean",
        "do": {"account": "production", "auto_activate": True}})
    assert _code(resp) == (422, "auto_activate_not_allowed")
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `sirdar/api`): `SIRDAR_TEST_DB=sirdar_test_p7b1 .venv/bin/pytest -q tests/test_deploy_do_activate_api.py tests/test_deploy_playbooks.py -k "activate or deactivate"`
Expected: FAIL (`plan_for() got an unexpected keyword argument 'smoke'`; the route answers 404).

- [ ] **Step 3: Plans and `smokes`**

In `sirdar/api/src/sirdar_api/deploy/steps.py`, give `_cloud_plan` and `plan_for` a `smoke: bool = True` keyword. In `_cloud_plan`, right after `keys = _CLOUD_PLANS[key]`:

```python
    if not smoke:
        if mode != "activate":
            raise ValueError("only Deactivate skips the slot smoke test")
        return ("go_live",)                     # Deactivate: no slot to test
```

`plan_for` passes `smoke=smoke` to `_cloud_plan`; on the non-cloud path, before `_PLANS`, add `if not smoke: raise ValueError("only Deactivate skips the slot smoke test")`. Extend the module docstring's DigitalOcean paragraph: "Activate is 13 then 14; Deactivate (a retiring production, no slot) is 14 alone."

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, after `takes_snapshot`:

```python
def smokes(mode: str, slot: str | None) -> bool:
    """Activate smoke-tests its slot before the switch; Deactivate (no slot)
    has nothing to test."""
    return not (mode == "activate" and slot is None)
```

`plan_of` adds `smoke=smokes(dep.mode, dep.slot)`; `create_deployment`'s `plan_for(...)` call adds `smoke=smokes(mode, slot)`.

- [ ] **Step 4: `auto_activate` at create and in PATCH**

In `sirdar/api/src/sirdar_api/deploy/do_envs.py`, `check_spec`: after the `standby`/`staging` type check, add

```python
    auto = fields.get("auto_activate", False)
    if not isinstance(auto, bool):
        raise DoEnvError("do_invalid")
    if production and auto:
        raise DoEnvError("auto_activate_not_allowed")    # production waits for Activate
```

and return `"auto_activate": auto` in the dict.

In `sirdar/api/src/sirdar_api/deploy/environments.py`, `_create_on_do`, right after the `env = await _insert(...)` call: `env.auto_activate = spec["auto_activate"]`. In `update`, after the `retiring` block:

```python
    if fields.get("auto_activate") is not None:
        if not on_do or env.type == "production":
            raise EnvError("auto_activate_not_allowed")
        put("auto_activate", bool(fields["auto_activate"]))
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`: `DoIn` gains `auto_activate: bool | None = None`; `EnvironmentPatch` gains `auto_activate: bool | None = None` (comment: "Non-production DigitalOcean only: an Update to the idle slot goes live by itself").

- [ ] **Step 5: The Activate route**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace the mode tuples:

```python
# Modes that replace data: deploy:change and the environment's name typed back.
GATED_MODES = ("reset", "restore_dump", "rollback", "teardown", "vm_restore")
# Modes that need deploy:change (production's Activate also needs its name typed).
CHANGE_MODES = (*GATED_MODES, "activate")
RETRY_MODES = ("update", "reset", "restore_dump", "rollback", "publish", "teardown",
               "vm_restore", "activate")
```

`_require_mode` checks `mode in CHANGE_MODES` (docstring: "…the modes that replace data, and Activate, also need change"). Add, after `_start_do_teardown`:

```python
class ActivateIn(BaseModel):
    # The slot to send traffic to; None deactivates (a retiring production only).
    slot: str | None = Field(default=None, max_length=10)
    confirm_name: str | None = Field(default=None, max_length=64)


def _refuse(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


@router.post("/environments/{name}/activate", status_code=201)
async def activate(name: str, body: ActivateIn, request: Request, db: DbSession,
                   actor: AuthContext = require_permission("deploy", "change")):
    """Blue/Green: smoke-test a slot on its droplet, then move the load
    balancer to it without a gap (a deployment, so it shares the lock, the
    log and Retry). Going back is activating the other slot. A retiring
    production can be deactivated (slot None) so Delete can remove it."""
    env = await _environment(db, name)
    if not _on_do(env):
        raise _refuse(409, "not_digitalocean_environment")
    if env.type == "production" and body.confirm_name != env.name:
        raise _refuse(422, "confirm_name_mismatch")
    if await environments.is_deploying(db, env.id):
        raise _refuse(409, "deploy_in_progress")
    if not vault.is_configured(get_settings()):
        raise _refuse(400, "secrets_key_missing")
    await _require_account(db, env)
    if body.slot is None:
        if not (env.type == "production" and env.retiring):
            raise _refuse(422, "slot_required")
        if env.active_slot is None:
            raise _refuse(409, "already_inactive")
        return await _launch(db, env, request, actor, action="deploy.activate", mode="activate",
                             git_ref=env.git_ref, sha=env.current_sha or "", cloud=True,
                             slot=None, go_live=True)
    if body.slot not in env.slots:
        raise _refuse(422, "slot_invalid")
    if env.type == "production" and env.retiring:
        raise _refuse(409, "production_retiring")
    if body.slot == env.active_slot:
        raise _refuse(409, "slot_already_active")
    row = (await do_envs.slots_of(db, env.id)).get(body.slot)
    if row is None or not row.sha:
        raise _refuse(409, "slot_not_deployed", slot=body.slot)
    if await _host_target(db, env, slot=body.slot) is None:
        raise _refuse(409, "do_not_ready")           # the slot's droplet has no address
    return await _launch(db, env, request, actor, action="deploy.activate", mode="activate",
                         git_ref=row.sha, sha=row.sha, cloud=True, slot=body.slot,
                         go_live=True)
```

(No `_pinned`: Sirdar pins its droplets in step 0; an unpinned droplet fails the slot smoke test with the pipeline's own copy.)

- [ ] **Step 6: Retry an Activate**

In `retry_deployment`:
1. Replace the `GATED_MODES` name check with

```python
    typed = dep.mode in GATED_MODES or (dep.mode == "activate" and env.type == "production")
    if typed and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if dep.mode == "activate" and dep.slot and env.type == "production" and env.retiring:
        raise HTTPException(status_code=409, detail={"code": "production_retiring"})
```

2. The `plan_for(...)` call adds `smoke=pipeline.smokes(dep.mode, dep.slot)`.

Nothing else changes: the retry already copies `cloud`, `slot` and `go_live`, checks the account, and asks `_host_target(slot=dep.slot)` only when an Ansible step is left (none for Deactivate).

- [ ] **Step 7: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_p7b1 .venv/bin/pytest -q tests/test_deploy_do_activate_api.py tests/test_deploy_playbooks.py tests/test_deploy_do_deployments_api.py tests/test_deploy_pipeline_do.py tests/test_deploy_deployments_api.py tests/test_deploy_do_environments.py tests/test_deploy_environments_api.py`
Expected: all PASS.

- [ ] **Step 8: Lint, commit, drop the test DB**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/do_envs.py src/sirdar_api/deploy/environments.py src/sirdar_api/api/routes/deploy.py tests/test_deploy_do_activate_api.py tests/test_deploy_playbooks.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/do_envs.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_do_activate_api.py sirdar/api/tests/test_deploy_playbooks.py
git commit -m "feat(sirdar): Activate and Deactivate slots, and auto-activate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7b1
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7b1_source
```

---

### Task 2: Add a second slot, grow sizes, and each account's regions and connection test

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/do_api.py` (`get_action`)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_envs.py` (`check_grow`, `apply_sizes`)
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`update` applies checked sizes)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_provision.py` (step 0 grows the slot it deploys and the cluster; docstrings)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`POST /environments/{name}/slots`, PATCH `do`, regions/connect/targets per account)
- Modify: `deploy/stack/ss-stack` (the restore comment only)
- Modify: `sirdar/api/tests/test_deploy_do_api.py`
- Create: `sirdar/api/tests/test_deploy_do_slots_and_sizes.py`, `sirdar/api/tests/test_deploy_do_account_targets.py`

**Interfaces:**
- Consumes (7a): `do_envs.add_slot(db, settings, env, slot)`, `do_api.sizes()`, `do_api.database_options()`, `do_api.droplet_action(droplet_id, type_, **extra)`, `do_api.resize_database(database_id, size, num_nodes)`, `DoProvisioner._wait`, `_waits["droplet"]`, `do_api.droplet_ips`; `digitalocean.resolve(db, settings, account)`; `do_accounts.KEYS`, `do_accounts.source_of(row, settings)`, `do_accounts.require`; Task 1's `_refuse`, `_launch`, `_require_account`, `_require_integrations`.
- Produces:
  - `DigitalOceanApi.get_action(droplet_id, action_id) -> dict | None`.
  - `do_envs.check_grow(api, row, fields) -> dict` (the values to store; `DoEnvError` `do_invalid | do_size_invalid | do_db_size_invalid | do_shrink_refused`); `do_envs.apply_sizes(row, values) -> list[str]` (changed names `do.droplet_size`, `do.db_size`, `do.db_standby`).
  - Step 0: when the deploy slot's droplet `size_slug` differs from the record, power off → resize (with disk) → power on, each droplet action waited through `get_action`; when the cluster's `size` or `num_nodes` differs, `resize_database`. Log lines `Resizing ss-<env>-<slot> to <size> (the droplet stops for a few minutes).` and `Database ss-<env>-db: resizing to <size>, <n> node(s).`
  - `POST /api/deploy/environments/{name}/slots` (`deploy:change`) → `{environment, deployment: Deployment | null}` (201): adds `purple` to a one-slot non-production environment and, once anything was deployed, deploys the running commit to it (`go_live` false, never a seed). Errors: 409 `not_digitalocean_environment`, 422 `slot_not_allowed` (production), 409 `slots_full`, 409 `deploy_in_progress`, 400 `secrets_key_missing`, 409 `do_account_not_configured` / `do_not_ready`, 409 `integration_not_configured`. Audit `deploy.slot_add`.
  - `PATCH /environments/{name}` `do?: {droplet_size?, db_size?, db_standby?}` (grow only): 422 `do_not_allowed | do_invalid | do_size_invalid | do_db_size_invalid | do_shrink_refused`, 502 `connect_failed {reason}`; audit lists `do.<field>`.
  - `GET /deploy/digitalocean/regions?account=production|development` (default production); `POST /deploy/connect` takes `account` for the DigitalOcean target (audited); `GET /deploy/targets` shows DigitalOcean configured when **either** account has a token.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/test_deploy_do_api.py`:

```python
async def test_get_action_reads_a_droplet_action(fake):
    fake.action_polls = 2                        # it completes on the second GET
    d = fake.add_droplet("ss-uat9-orange", ["sirdar"])
    did = str(d["id"])
    async with do_api.connect(DO_TOKEN) as api:
        action = await api.droplet_action(did, "power_off")
        assert action["status"] == "in-progress"
        first = await api.get_action(did, str(action["id"]))
        second = await api.get_action(did, str(action["id"]))
        assert (first["status"], second["status"]) == ("in-progress", "completed")
        assert await api.get_action(did, "999999") is None
```

Create `sirdar/api/tests/test_deploy_do_slots_and_sizes.py`:

```python
"""A one-slot environment adds its second slot and deploys the running
commit to it (never a seed: the shared database already holds data); sizes
only grow, checked against DigitalOcean's catalogs; step 0 grows the slot
it deploys (power off, resize, power on, each action waited for) and the
database cluster."""

import uuid

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, DoEnvironment, DoSlot, Environment
from sirdar_api.deploy import pipeline, vms
from sirdar_api.deploy.provision import VmOutcome

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import built, built_env, deployed, do_build, do_cloud, make_do_environment  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA

URL = "/api/deploy/environments"


@pytest.fixture
async def ready(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_runner,
                fake_publisher, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def test_add_the_second_slot(client, db, ready):
    env = await make_do_environment(db, name="solo", slots=1)
    await built_env(env)
    await deployed(db, env, "orange", sha=SHA)
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/solo/slots", headers=h)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["environment"]["slots"] == ["orange", "purple"]
    dep = body["deployment"]
    assert (dep["mode"], dep["slot"], dep["go_live"], dep["sha"]) == ("update", "purple", False, SHA)
    assert "restore" not in [s["key"] for s in dep["steps"]]     # never a seed
    await pipeline.wait(uuid.UUID(dep["id"]))
    purple = await db.get(DoSlot, (env.id, "purple"), populate_existing=True)
    assert purple is not None and purple.sha == SHA
    env = await db.get(Environment, env.id, populate_existing=True)
    assert env.active_slot == "orange"                           # traffic didn't move
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.slot_add"))).one()
    assert audit == {"environment": "solo", "slot": "purple"}
    assert _code(await client.post(f"{URL}/solo/slots", headers=h)) == (409, "slots_full")


async def test_a_new_environment_adds_the_slot_without_deploying(client, db, ready):
    env = await make_do_environment(db, name="solo", slots=1)
    h = await auth_headers(client, db)
    body = (await client.post(f"{URL}/solo/slots", headers=h)).json()
    assert body["deployment"] is None and body["environment"]["slots"] == ["orange", "purple"]
    assert (await db.get(DoSlot, (env.id, "purple"))).host_key_private_enc is not None


async def test_slot_refusals(client, db, ready):
    await make_do_environment(db, name="prod", type_="production", account="production")
    await make_environment(db, name="lan1", secrets={})
    h = await auth_headers(client, db)
    assert _code(await client.post(f"{URL}/prod/slots", headers=h)) == (422, "slot_not_allowed")
    assert _code(await client.post(f"{URL}/lan1/slots", headers=h)) == (
        409, "not_digitalocean_environment")
    viewer = await auth_headers(client, db, email="v@test.example.com", roles=("admin",))
    assert (await client.post(f"{URL}/prod/slots", headers=viewer)).status_code == 403


@pytest.mark.parametrize("do, status, code", [
    ({"droplet_size": "s-4vcpu-8gb"}, 200, None),
    ({"droplet_size": "s-1vcpu-2gb"}, 422, "do_shrink_refused"),
    ({"droplet_size": "s-99vcpu-1tb"}, 422, "do_size_invalid"),
    ({"db_size": "db-s-4vcpu-8gb"}, 200, None),
    ({"db_size": "db-s-1vcpu-1gb"}, 422, "do_shrink_refused"),
    ({"db_size": "db-s-64vcpu-1tb"}, 422, "do_db_size_invalid"),
    ({"db_standby": True}, 200, None),
])
async def test_sizes_only_grow(client, db, do_build, do, status, code):
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"do": do})
    assert resp.status_code == status, resp.text
    if code:
        assert resp.json()["detail"]["code"] == code
        return
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    key, value = next(iter(do.items()))
    assert getattr(row, key) == value
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_update"))).one()
    assert audit["changed"] == [f"do.{key}"]


async def test_standby_never_goes_away(client, db, do_build):
    await db.execute(update(DoEnvironment).where(
        DoEnvironment.environment_id == do_build.env.id).values(db_standby=True))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"do": {"db_standby": False}})
    assert _code(resp) == (422, "do_shrink_refused")


async def test_sizes_belong_to_digitalocean(client, db, do_build):
    await make_environment(db, name="lan1", secrets={})
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/lan1", headers=h, json={"do": {"db_standby": True}})
    assert _code(resp) == (422, "do_not_allowed")


async def test_step_0_grows_the_slot_it_deploys_and_the_database(db, do_build):
    await do_build.run()
    await db.execute(update(DoEnvironment).where(
        DoEnvironment.environment_id == do_build.env.id).values(
        droplet_size="s-4vcpu-8gb", db_size="db-s-4vcpu-8gb", db_standby=True))
    await db.commit()
    fake = do_build.cloud.do
    fake.action_polls = 2                # each droplet action finishes only once polled
    await do_build.run(slot="purple", go_live=False)
    sizes = {d["name"]: d["size_slug"] for d in fake.droplets.values()}
    assert sizes == {"ss-uat9-orange": "s-2vcpu-4gb", "ss-uat9-purple": "s-4vcpu-8gb"}
    purple = next(d for d in fake.droplets.values() if d["name"] == "ss-uat9-purple")
    assert purple["status"] == "active"
    assert [a["type"] for a in fake.actions.values()] == ["power_off", "resize", "power_on"]
    (database,) = fake.databases.values()
    assert (database["size"], database["num_nodes"]) == ("db-s-4vcpu-8gb", 2)
    log = do_build.log()
    assert "Resizing ss-uat9-purple to s-4vcpu-8gb" in log
    assert "Database ss-uat9-db: resizing to db-s-4vcpu-8gb, 2 nodes." in log


async def test_a_second_run_with_matching_sizes_resizes_nothing(db, do_build):
    await do_build.run()
    await do_build.run(slot="purple", go_live=False)
    fake = do_build.cloud.do
    assert fake.actions == {}
    assert not any(path.endswith("/resize") for _, path in fake.writes())
```

Create `sirdar/api/tests/test_deploy_do_account_targets.py`:

```python
"""The Deploy page's DigitalOcean pieces per account: regions and the
connection test read the chosen account's token; the target counts as set
up when either account has one."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import configure_account, do_cloud  # noqa: F401
from .fake_digitalocean import DEV_TOKEN

pytestmark = pytest.mark.usefixtures("secrets_key")


@pytest.fixture(autouse=True)
def _no_env_token(monkeypatch):
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def test_regions_per_account(client, db, do_cloud):
    await configure_account(db)                      # Development only
    h = await auth_headers(client, db)
    resp = await client.get("/api/deploy/digitalocean/regions?account=development", headers=h)
    assert resp.status_code == 200, resp.text
    assert {r.headers["authorization"] for r in do_cloud.do.requests} == {f"Bearer {DEV_TOKEN}"}
    resp = await client.get("/api/deploy/digitalocean/regions", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (400, "target_not_configured")
    resp = await client.get("/api/deploy/digitalocean/regions?account=staging", headers=h)
    assert resp.status_code == 422


async def test_connect_uses_the_chosen_account(client, db, do_cloud):
    await configure_account(db)
    h = await auth_headers(client, db)
    do_cloud.do.requests.clear()
    resp = await client.post("/api/deploy/connect", headers=h, json={
        "target": "digitalocean", "type": "dev", "account": "development"})
    assert resp.status_code == 200, resp.text
    assert {r.headers["authorization"] for r in do_cloud.do.requests} == {f"Bearer {DEV_TOKEN}"}
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.connect"))).one()
    assert audit["account"] == "development"


async def test_targets_count_either_account(client, db, do_cloud):
    h = await auth_headers(client, db)
    listed = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
    assert next(t for t in listed if t["id"] == "digitalocean")["configured"] is False
    await configure_account(db)
    listed = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
    assert next(t for t in listed if t["id"] == "digitalocean")["configured"] is True
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_p7b2 .venv/bin/pytest -q tests/test_deploy_do_slots_and_sizes.py tests/test_deploy_do_account_targets.py tests/test_deploy_do_api.py -k "slot or size or grow or region or connect or targets or get_action"`
Expected: FAIL (`get_action` missing; the slots route 404/405; `do` ignored; `account` refused or ignored).

- [ ] **Step 3: `get_action`**

In `sirdar/api/src/sirdar_api/deploy/do_api.py`, after `droplet_action`:

```python
    async def get_action(self, droplet_id: str, action_id: str) -> dict | None:
        """A droplet action's state ("in-progress", "completed", "errored")."""
        return await self._one(f"/droplets/{_id(droplet_id)}/actions/{_id(action_id)}",
                               "action")
```

- [ ] **Step 4: Grow checks**

Append to `sirdar/api/src/sirdar_api/deploy/do_envs.py` (after `check_spec`):

```python
def _size_of(catalog: list[dict], slug: str | None) -> dict | None:
    return next((s for s in catalog if isinstance(s, dict) and s.get("slug") == slug), None)


def _db_rank(options: dict, slug: str, nodes: int) -> int:
    layouts = ((options.get("pg") or {}).get("layouts")) or []
    sizes = next((lay.get("sizes") or [] for lay in layouts
                  if isinstance(lay, dict) and lay.get("num_nodes") == nodes), [])
    if slug not in sizes:
        raise DoEnvError("do_db_size_invalid")
    return sizes.index(slug)              # DigitalOcean lists them smallest first


async def check_grow(api, row: DoEnvironment, fields: dict) -> dict:
    """The sizes a PATCH asks for, checked against DigitalOcean's catalogs: a
    droplet size it offers with at least the vCPUs, memory and disk of the
    current one; a database size at least as large for the node count; a
    standby node that is never removed. Returns only what changes."""
    if not isinstance(fields, dict) or set(fields) - {"droplet_size", "db_size", "db_standby"}:
        raise DoEnvError("do_invalid")
    out: dict = {}
    want = fields.get("droplet_size")
    if want is not None and want != row.droplet_size:
        if not isinstance(want, str) or not _SIZE_RE.fullmatch(want) or want.startswith("db-"):
            raise DoEnvError("do_size_invalid")
        catalog = await api.sizes()
        new, old = _size_of(catalog, want), _size_of(catalog, row.droplet_size)
        if new is None or not new.get("available", True):
            raise DoEnvError("do_size_invalid")
        if old is not None and any(int(new.get(k) or 0) < int(old.get(k) or 0)
                                   for k in ("vcpus", "memory", "disk")):
            raise DoEnvError("do_shrink_refused")
        out["droplet_size"] = want
    standby = fields.get("db_standby")
    if standby is not None and not isinstance(standby, bool):
        raise DoEnvError("do_invalid")
    if standby is False and row.db_standby:
        raise DoEnvError("do_shrink_refused")
    adding_standby = standby is True and not row.db_standby
    db_size = fields.get("db_size") or row.db_size
    if not isinstance(db_size, str) or not _DB_SIZE_RE.fullmatch(db_size):
        raise DoEnvError("do_db_size_invalid")
    if db_size != row.db_size or adding_standby:
        nodes = 2 if (adding_standby or row.db_standby) else 1
        options = await api.database_options()
        if _db_rank(options, db_size, nodes) < _db_rank(options, row.db_size, nodes):
            raise DoEnvError("do_shrink_refused")
        if db_size != row.db_size:
            out["db_size"] = db_size
    if adding_standby:
        out["db_standby"] = True
    return out


def apply_sizes(row: DoEnvironment, values: dict) -> list[str]:
    """Store checked sizes; step 0 applies them on the next deploy."""
    changed = [f"do.{k}" for k, v in values.items() if getattr(row, k) != v]
    for key, value in values.items():
        setattr(row, key, value)
    if changed:
        row.updated_at = datetime.now(UTC)
    return changed
```

In `sirdar/api/src/sirdar_api/deploy/environments.py`, `update`, after the `vm` block:

```python
    if fields.get("do_checked") is not None:       # checked by the route (it asks DigitalOcean)
        row = await do_envs.get(db, env.id) if on_do else None
        if row is None:
            raise EnvError("do_not_allowed")
        changed += do_envs.apply_sizes(row, fields["do_checked"])
```

- [ ] **Step 5: Step 0 grows the slot it deploys, and the cluster**

In `sirdar/api/src/sirdar_api/deploy/do_provision.py`:

1. Module docstring: replace "Not step 0's: growing a droplet or the cluster (7b resizes the slot being deployed), and …" with "Step 0 grows the droplet of the slot it deploys (only that one: the other may be live; it grows on its own next deploy) and the cluster to the recorded sizes; PATCH `do` only ever grows them. Not step 0's: the load balancer's targets …".
2. In `_prepare`, replace the "Sizes are as frozen at create…" comment with "# The deploy slot's droplet and the cluster grow to the recorded sizes here."
3. At the end of `_droplets`, before `return found`:

```python
        if ctx.slot in found and found[ctx.slot].get("size_slug") != ctx.droplet_size:
            found[ctx.slot] = await self._resize_droplet(api, ctx, found[ctx.slot], out)
```

4. Add after `_create_droplet`:

```python
    async def _droplet_action(self, api: DigitalOceanApi, did: str, type_: str, what: str,
                              **extra) -> None:
        """Start a droplet action and wait until DigitalOcean reports it done."""
        action = await api.droplet_action(did, type_, **extra)
        aid = str(action.get("id"))
        done = await self._wait(lambda: api.get_action(did, aid),
                                lambda a: a.get("status") in ("completed", "errored"),
                                self._waits["droplet"], what)
        if done.get("status") != "completed":
            raise StepFailed(f"{what} failed on DigitalOcean. Retry from step 0.")

    async def _resize_droplet(self, api: DigitalOceanApi, ctx: DoContext, droplet: dict,
                              out: Output) -> dict:
        """The slot being deployed (never the live one of two): power off,
        resize with its disk (a disk only grows), power on."""
        name, did = droplet["name"], str(droplet["id"])
        out(f"Resizing {name} to {ctx.droplet_size} (the droplet stops for a few minutes).\n")
        if droplet.get("status") != "off":
            await self._droplet_action(api, did, "power_off", f"The power-off of {name}")
        await self._droplet_action(api, did, "resize", f"The resize of {name}",
                                   size=ctx.droplet_size, disk=True)
        await self._droplet_action(api, did, "power_on", f"The power-on of {name}")
        ready = await self._wait(
            lambda: api.droplet(did),
            lambda d: d.get("status") == "active" and all(do_api.droplet_ips(d)),
            self._waits["droplet"], f"The droplet {name}")
        out(f"{name}: now {ready.get('size_slug')}.\n")
        return ready
```

5. In `_database`, right after `await self._db_firewall(...)`:

```python
        nodes = 2 if ctx.db_standby else 1
        if database.get("size") != ctx.db_size or int(database.get("num_nodes") or 1) != nodes:
            await api.resize_database(database["id"], ctx.db_size, nodes)
            out(f"Database {name}: resizing to {ctx.db_size}, {nodes} node"
                f"{'s' if nodes > 1 else ''}.\n")
```

(The wait for `online` that follows covers the resize.)

- [ ] **Step 6: The routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`:

1. Imports: add `do_api` to the `sirdar_api.deploy` import list and `DoAccount` to the models import.
2. Accounts on the Deploy page. Right after `DeployType = Literal[...]` (near the top: `ConnectIn` uses it) add `DoAccountKey = Literal["production", "development"]`; then replace `_digitalocean_settings`:

```python
async def _digitalocean_settings(db, account: str = "production") -> tuple:
    """(settings carrying that DigitalOcean account's token, None) or (None,
    IntegrationError) when its stored token can't be read."""
    try:
        return await digitalocean.resolve(db, get_settings(), account), None
    except integrations.IntegrationError as e:
        return None, e
```

   `digitalocean_regions` gains `account: DoAccountKey = Query(default="production")` and calls `_digitalocean_settings(db, account)`. `ConnectIn` gains `account: DoAccountKey | None = None`; `connect` calls `_digitalocean_settings(db, body.account or "production")` and its `record` adds `changes["account"] = body.account` when given. In `list_targets`:

```python
    do_on = False
    for key in do_accounts.KEYS:                     # either account makes it usable
        row = await db.get(DoAccount, key)
        do_on = do_on or (row is not None and do_accounts.source_of(row, s) is not None)
```

   and pass `digitalocean_configured=do_on`.
3. PATCH `do`:

```python
class DoPatch(BaseModel):
    """PATCH's `do`: sizes only grow; step 0 applies them on the next deploy."""
    droplet_size: str | None = Field(default=None, max_length=40)
    db_size: str | None = Field(default=None, max_length=40)
    db_standby: bool | None = None
```

   `EnvironmentPatch` gains `do: DoPatch | None = None`. Add:

```python
async def _checked_sizes(db, env: Environment, wanted: dict) -> dict:
    """PATCH `do`, checked against DigitalOcean's catalogs (sizes only grow)."""
    if not _on_do(env):
        raise _refuse(422, "do_not_allowed")
    row = await do_envs.get(db, env.id)
    if row is None:
        raise _refuse(409, "do_not_ready")
    try:
        account = await do_accounts.require(db, get_settings(), row.account_key)
    except integrations.IntegrationError as e:
        status = 409 if e.code in ("do_account_not_configured", "integration_unreadable") else 400
        raise HTTPException(status_code=status, detail={"code": e.code, **e.extra}) from None
    try:
        async with do_api.connect(account.token) as api:
            return await do_envs.check_grow(api, row, wanted)
    except do_envs.DoEnvError as e:
        raise _refuse(422, e.code) from None
    except do_api.DoError as e:
        raise _refuse(502, "connect_failed", reason=e.reason) from None
```

   In `update_environment`, after `fields.pop("confirm_name", None)`:

```python
    wanted = fields.pop("do", None)
    if wanted is not None:
        fields["do_checked"] = await _checked_sizes(
            db, env, {k: v for k, v in wanted.items() if v is not None})
```

4. Add a slot:

```python
@router.post("/environments/{name}/slots", status_code=201)
async def add_slot(name: str, request: Request, db: DbSession,
                   actor: AuthContext = require_permission("deploy", "change")):
    """A one-slot environment gets its second slot (purple). Once anything was
    deployed, the running commit is deployed to it (step 0 builds its droplet
    and lets it reach the database; never a seed: the shared database already
    holds the data); traffic stays where it is. Otherwise the first Update
    builds it."""
    env = await _environment(db, name)
    if not _on_do(env):
        raise _refuse(409, "not_digitalocean_environment")
    if env.type == "production":
        raise _refuse(422, "slot_not_allowed")
    await db.refresh(env, with_for_update=True)      # one add at a time
    if len(env.slots) != 1:
        raise _refuse(409, "slots_full")
    if await environments.is_deploying(db, env.id):
        raise _refuse(409, "deploy_in_progress")
    settings = get_settings()
    if not vault.is_configured(settings):
        raise _refuse(400, "secrets_key_missing")
    await _require_account(db, env)
    sha = env.current_sha
    if sha is not None:
        await _require_integrations(db, env)
    env_name = env.name
    await do_envs.add_slot(db, settings, env, "purple")
    env.slots = [*env.slots, "purple"]
    env.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.user.person_id, action="deploy.slot_add", entity_type="environment",
          entity_id=env_name, ip=client_ip(request),
          changes={"environment": env_name, "slot": "purple"})
    deployment = None
    if sha is None:
        await db.commit()
    else:
        # One commit for the slot, its audit row and the deployment.
        deployment = await _launch(db, env, request, actor, action="deploy.deployment_start",
                                   mode="update", git_ref=sha, sha=sha, cloud=True,
                                   slot="purple", go_live=False)
    await db.refresh(env)
    return {"environment": await serialize.environment_out(db, env), "deployment": deployment}
```

5. In `deploy/stack/ss-stack`, `restore)`: replace the two lines "This stops writers only on this droplet (this host). Once two slots share one managed database (phase 7b), the other slot must be stopped before restoring, or it keeps writing into the database mid-restore." with:

```bash
    # This stops writers only on this host. On DigitalOcean two slots share
    # one managed database, so Sirdar restores only while no slot has run a
    # deploy (pipeline: seed_not_allowed; an added slot's first deploy never
    # seeds): no other slot is writing.
```

- [ ] **Step 7: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_p7b2 .venv/bin/pytest -q tests/test_deploy_do_slots_and_sizes.py tests/test_deploy_do_account_targets.py tests/test_deploy_do_api.py tests/test_deploy_do_provision.py tests/test_deploy_do_environments.py tests/test_deploy_do_activate_api.py tests/test_deploy_digitalocean_integration.py tests/test_deploy_api.py tests/test_deploy_environments_api.py`
Then the deploy-stack suite (the comment change): `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests` and `bash -n deploy/stack/ss-stack`.
Expected: all PASS (65 passed, 28 deselected for the deploy suite). `test_a_second_run_changes_nothing` in `test_deploy_do_provision.py` must still pass: nothing differs from the record.

- [ ] **Step 8: Lint, commit, drop the test DB**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/do_api.py src/sirdar_api/deploy/do_envs.py src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/do_provision.py src/sirdar_api/api/routes/deploy.py tests/test_deploy_do_api.py tests/test_deploy_do_slots_and_sizes.py tests/test_deploy_do_account_targets.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/do_api.py sirdar/api/src/sirdar_api/deploy/do_envs.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/do_provision.py sirdar/api/src/sirdar_api/api/routes/deploy.py deploy/stack/ss-stack sirdar/api/tests/test_deploy_do_api.py sirdar/api/tests/test_deploy_do_slots_and_sizes.py sirdar/api/tests/test_deploy_do_account_targets.py
git commit -m "feat(sirdar): add a second slot, grow droplet and database sizes, and per-account regions and connection test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7b2
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7b2_source
```

---

### Task 3: The cert-worker (ServerSherpa API image) — DONE

Built and merged (`f268d91d`, `e2f6b36f`, review fixes `264801de`): `api/src/serversherpa/certs/{acme,worker}.py` (byte-identical `acme.py`, HTTP-01 on :8089 behind Caddy, renews at ≤ 30 days only when the load balancer targets exactly this droplet and is `active`, outcomes `not_active | fresh | locked | switching | renewed`, advisory lock `0x5353434552545752` in AUTOCOMMIT), `serversherpa cert-worker [--once] [--renew-days N]`, the `cert-worker` Compose service under profile `certs` (the only service given `SS_CERT_*`, with `SS_CERT_ENV=${STACK_ENV}` and `SS_CERT_DROPLET_ID=${STACK_DROPLET_ID}`), and `ss-stack` adding `--profile certs` when `STACK_CADDY=1`. Its `.env` keys are rendered by Task 4.

---

### Task 4: Sirdar's side of renewal — the cert-worker's `.env`, the `renew` deployment and the 6-hourly check

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/envfile.py` (`EXTRA_KEYS`), `deploy/stack/env.example` (the commented block)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_envs.py` (`env_extra` adds the `SS_CERT_*` keys)
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py` (`renew`, step 19), `pipeline.py` (`renew` keeps the status), `do_provision.py` (`do_renew`)
- Create: `sirdar/api/src/sirdar_api/deploy/renewals.py`
- Modify: `sirdar/api/src/sirdar_api/config.py` (`cert_check_seconds`), `sirdar/api/src/sirdar_api/api/app.py` (the loop)
- Modify: `sirdar/api/tests/do_helpers.py` (`built` records the load balancer), `test_deploy_do_environments.py`, `test_deploy_envfile.py`, `test_deploy_pipeline_do.py`, `test_deploy_playbooks.py`
- Create: `sirdar/api/tests/test_deploy_do_renewals.py`

**Interfaces:**
- Consumes: the cert-worker's keys (Task 3: `SS_CERT_DO_TOKEN`, `SS_CERT_LB_ID` matching `[A-Za-z0-9-]{1,64}`, `SS_CERT_NAMES` comma-separated, `SS_CERT_ACME_DIRECTORY`, `SS_CERT_ACME_KEY` strict base64 of the PEM; `STACK_ENV` and a decimal `STACK_DROPLET_ID` already rendered); 7a's `do_accounts.load`, `certs.public_names`, `certs.SIRDAR_RENEW_DAYS`, `settings.acme_directory` / `acme_staging_directory`, `DoProvisioner._same_team`, `_live_lb`, `_certificate`, `_lb_active`, `_retire_certificates`, `_rules`, `lb_update_body`, `https_certificate`, `load_records`.
- Produces:
  - `envfile.EXTRA_KEYS` ends `…, STACK_DROPLET_ID, SS_CERT_DO_TOKEN, SS_CERT_LB_ID, SS_CERT_NAMES, SS_CERT_ACME_DIRECTORY, SS_CERT_ACME_KEY`.
  - `do_envs.env_extra` renders them; its `missing` list ends `…, "droplet", "load balancer", "renewal token"` (a non-decimal droplet id counts as missing); its secret list adds the renewal token and the base64 ACME key.
  - `steps.MODES` adds `"renew"`; `StepDef(19, "do_renew", "Renew certificate", "", 30 * 60, "vm")`; cloud plan `("renew", False): ("do_renew",)`; `pipeline.KEEPS_STATUS = ("snapshot", "publish", "renew")`.
  - `DoProvisioner.STEPS` adds `"do_renew"`: `_same_team` → `_certificate` (records the cert-worker's upload; DNS-01 only at ≤ 14 days) → the load balancer's HTTPS rule on it (waiting while the load balancer applies another change) → `_retire_certificates`.
  - `renewals.due(db, now) -> list[Environment]`, `async renewals.start_due(now=None) -> list[str]`, `async renewals.loop(seconds)`, `renewals.FIRST_DELAY_SECONDS = 300`; audit `deploy.certificate_renew` (`actor_id` None, `{"environment": name}`).
  - `Settings.cert_check_seconds: int = 21600` (`SIRDAR_CERT_CHECK_SECONDS`; 0 turns the loop off).

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/do_helpers.py`, `built()`: after the `vpc` record add

```python
    await do_envs.record(ctx.env_id, "load_balancer", f"lb-{ctx.env_id}", f"ss-{ctx.env_name}-lb")
```

In `sirdar/api/tests/test_deploy_pipeline_do.py`:
- `test_delete_keeps_the_environment_while_resources_are_recorded`: `assert left == 1` → `assert left == 2` (the VPC and the load balancer).
- `test_a_first_deploy_goes_live`: after the `STACK_DROPLET_ID=4001` assertion add

```python
    assert f"SS_CERT_LB_ID=lb-{do_env.id}\n" in text
    assert f"SS_CERT_DO_TOKEN={DEV_RENEW_TOKEN}\n" in text
    assert "SS_CERT_NAMES=api.uat9.serversherpa.com,portal.uat9.serversherpa.com," in text
```

- `test_every_cloud_secret_is_redacted`: `leaks` adds `base64.b64encode(acme_key.encode()).decode()`.

In `sirdar/api/tests/test_deploy_do_environments.py`:
- `_ready_for_extras`: after `set_slot`, add `await do_envs.record(env.id, "load_balancer", "lb-0001", "ss-uat9-lb")`.
- `test_env_extra`: the first `missing` becomes `["load balancer address", "VPC range", "database host", "database port", "database CA", "Spaces key", "droplet", "load balancer"]`; then compute the ACME key and extend the expectations:

```python
    from .fake_digitalocean import DEV_RENEW_TOKEN
    key_pem = vault.decrypt(get_settings(), (await do_envs.get(db, env.id)).acme_key_enc)
    acme_b64 = base64.b64encode(key_pem.encode()).decode()
```

  the expected dict gains (after `"STACK_DROPLET_ID": "4001"`)

```python
        "SS_CERT_DO_TOKEN": DEV_RENEW_TOKEN, "SS_CERT_LB_ID": "lb-0001",
        "SS_CERT_NAMES": ",".join(f"{s}.uat9.serversherpa.com"
                                  for s in ("api", "portal", "kiosk", "wiki", "status")),
        "SS_CERT_ACME_DIRECTORY": "https://acme-v02.api.letsencrypt.org/directory",
        "SS_CERT_ACME_KEY": acme_b64,
```

  and the secrets assertion becomes `assert set(secrets) == {extra["SS_DATABASE_URL"], "spaces-SECRET-1", ca_b64, DEV_RENEW_TOKEN, acme_b64}`.
- Add:

```python
async def test_env_extra_wants_the_renewal_token_and_a_numeric_droplet(db):
    from .deploy_factories import ENV_SECRETS
    env = await make_do_environment(db)
    await _ready_for_extras(env)
    await do_accounts.save(db, get_settings(), "development", label="Development",
                           region="nyc3", clear_renewal=True)
    await db.commit()
    await do_envs.set_slot(env.id, "orange", droplet_id="not-a-number")
    with pytest.raises(do_envs.DoEnvError) as e:
        await do_envs.env_extra(db, get_settings(), env, "orange", ENV_SECRETS)
    assert e.value.extra["missing"] == ["droplet", "renewal token"]


async def test_env_extra_uses_staging_for_a_staging_environment(db):
    from .deploy_factories import ENV_SECRETS
    env = await make_do_environment(db, acme_staging=True)
    await _ready_for_extras(env)
    extra, _ = await do_envs.env_extra(db, get_settings(), env, "orange", ENV_SECRETS)
    assert extra["SS_CERT_ACME_DIRECTORY"] == get_settings().acme_staging_directory
```

  (import `do_accounts` from `sirdar_api.deploy`).

Append to `sirdar/api/tests/test_deploy_envfile.py`:

```python
def test_the_cert_worker_keys_close_the_extras():
    assert envfile.EXTRA_KEYS[-6:] == ("STACK_DROPLET_ID", "SS_CERT_DO_TOKEN", "SS_CERT_LB_ID",
                                       "SS_CERT_NAMES", "SS_CERT_ACME_DIRECTORY",
                                       "SS_CERT_ACME_KEY")
    text = ENV_EXAMPLE.read_text()
    for key in envfile.EXTRA_KEYS:
        assert f"# {key}=" in text or f" {key}=" in text, key     # listed, commented out
```

In `sirdar/api/tests/test_deploy_playbooks.py`, `test_plans`: the `STEPS` number list ends `…, 16, 17, 18, 19]`, and the loop's `cloud = mode == "activate"` becomes `cloud = mode in ("activate", "renew")`. In `test_digitalocean_plans` add `assert _cloud("renew") == ["do_renew"]` and, with the non-cloud refusals, `with pytest.raises(ValueError): steps.plan_for("renew")`.

Create `sirdar/api/tests/test_deploy_do_renewals.py`:

```python
"""Sirdar, the backup renewer: every few hours it starts a `renew`
deployment (step 19) for each DigitalOcean environment whose certificate has
14 days or fewer left and that isn't deploying; the step records what the
cert-worker uploaded, renews by DNS-01 only when still due, moves the load
balancer's HTTPS rule (waiting while it applies another change) and deletes
the old certificate. A renew job keeps the environment's status."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, Deployment, DoEnvironment, Environment
from sirdar_api.deploy import pipeline, renewals

from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
)
from .do_helpers import do_build, do_cloud, make_do_environment  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
pytestmark = pytest.mark.usefixtures("secrets_key", "deploy_env")


async def _env(db, name: str, *, days: int | None, deployed: bool = True) -> Environment:
    env = await make_do_environment(db, name=name, slots=1)
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        current_sha=SHA if deployed else None, status="ready",
        active_slot="orange" if deployed else None))
    await db.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env.id).values(
        cert_not_after=None if days is None else NOW + timedelta(days=days)))
    await db.commit()
    return env


async def test_start_due_picks_only_what_needs_it(db, do_cloud, fake_provisioner):
    await _env(db, "soon", days=10)
    await _env(db, "later", days=20)
    await _env(db, "fresh", days=None, deployed=False)
    assert await renewals.start_due(NOW) == ["soon"]
    dep = (await db.scalars(select(Deployment).where(Deployment.mode == "renew"))).one()
    await pipeline.wait(dep.id)
    dep = await db.get(Deployment, dep.id, populate_existing=True)
    assert (dep.status, dep.cloud, dep.slot, dep.actor_id) == ("succeeded", True, None, None)
    assert fake_provisioner.calls == ["do_renew"]
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.certificate_renew"))).one()
    assert audit == {"environment": "soon"}
    env = (await db.scalars(select(Environment).where(Environment.name == "soon")
                            .execution_options(populate_existing=True))).one()
    assert env.status == "ready"                         # a renew job keeps the status
    assert await renewals.start_due(NOW) == ["soon"]     # due again until it renews


async def test_a_deploying_environment_waits(db, do_cloud):
    env = await _env(db, "busy", days=5)
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="running", cloud=True, slot="orange"))
    await db.commit()
    assert await renewals.start_due(NOW) == []


async def test_the_loop_outlives_a_failed_check(monkeypatch):
    calls: list[int] = []

    async def check(now=None):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("database down")
        raise asyncio.CancelledError

    monkeypatch.setattr(renewals, "start_due", check)
    monkeypatch.setattr(renewals, "FIRST_DELAY_SECONDS", 0)
    with pytest.raises(asyncio.CancelledError):
        await renewals.loop(0)
    assert len(calls) == 2


@pytest.mark.parametrize("days, renewed", [(10, True), (20, False)])
async def test_the_renew_step(db, do_build, days, renewed):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = (datetime.now(UTC) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    assert (cert["id"] in fake.certificates) is not renewed
    assert len(fake.certificates) == 1
    (lb,) = fake.load_balancers.values()
    https = next(r for r in lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == next(iter(fake.certificates))


async def test_the_renew_step_waits_while_the_load_balancer_applies(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = (datetime.now(UTC) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    fake.lb_apply_polls = 2              # after the PUT it stays "new" for two GETs
    await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    (lb,) = fake.load_balancers.values()
    assert lb["status"] == "active"
    assert "now uses the certificate" in do_build.log()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_p7b4 .venv/bin/pytest -q tests/test_deploy_do_renewals.py tests/test_deploy_do_environments.py tests/test_deploy_envfile.py tests/test_deploy_playbooks.py tests/test_deploy_pipeline_do.py`
Expected: FAIL (`renewals` missing; no `SS_CERT_*`; `left == 2` and the plan numbers).

- [ ] **Step 3: The cert-worker's `.env` keys**

In `sirdar/api/src/sirdar_api/deploy/envfile.py`, `EXTRA_KEYS` ends:

```python
    "SS_SPACES_REGION", "SS_SPACES_ACCESS_KEY", "SS_SPACES_SECRET_KEY", "SS_SPACES_USE_PATH_STYLE",
    "STACK_DROPLET_ID",
    # the cert-worker (deploy/stack/api/compose.yml, profile certs) reads only these
    "SS_CERT_DO_TOKEN", "SS_CERT_LB_ID", "SS_CERT_NAMES", "SS_CERT_ACME_DIRECTORY",
    "SS_CERT_ACME_KEY",
)
```

In `deploy/stack/env.example`, after `# STACK_DROPLET_ID=` add:

```
# SS_CERT_DO_TOKEN= SS_CERT_LB_ID=   the cert-worker: the account's renewal token, the load balancer
# SS_CERT_NAMES=                     the public names its certificate covers, comma-separated
# SS_CERT_ACME_DIRECTORY= SS_CERT_ACME_KEY=   Let's Encrypt (staging for test environments); base64 PEM
```

In `sirdar/api/src/sirdar_api/deploy/do_envs.py`, `env_extra` (add `certs` to the `sirdar_api.deploy` import; `select`, `DoResource` and `IntegrationError` are already imported). Before the `missing` list:

```python
    try:
        account = await do_accounts.load(db, settings, row.account_key) if row else None
    except IntegrationError:              # a token that won't open: reported as missing
        account = None
    lb_id = await db.scalar(select(DoResource.do_id).where(
        DoResource.environment_id == env.id, DoResource.kind == "load_balancer").limit(1))
    droplet = slot_row.droplet_id if slot_row else None
```

the `missing` tuple's `("droplet", slot_row.droplet_id if slot_row else None)` becomes

```python
        ("droplet", droplet if droplet and droplet.isdecimal() else None),
        ("load balancer", lb_id),
        ("renewal token", account.renewal_token if account else None)) if not value]
```

and after `extra = {...}`:

```python
    acme_key = base64.b64encode(vault.decrypt(settings, row.acme_key_enc).encode()).decode()
    extra |= {   # the cert-worker's (Task 3); STACK_ENV and STACK_DROPLET_ID come with the rest
        "SS_CERT_DO_TOKEN": account.renewal_token, "SS_CERT_LB_ID": lb_id,
        "SS_CERT_NAMES": ",".join(certs.public_names(env.base_domain)),
        "SS_CERT_ACME_DIRECTORY": (settings.acme_staging_directory if row.acme_staging
                                   else settings.acme_directory),
        "SS_CERT_ACME_KEY": acme_key}
    found = [url, spaces_secret, ca_b64, account.renewal_token, acme_key]
```

Update the docstring: "…and the cert-worker's keys: the account's renewal token, the load balancer, the public names, the ACME directory and this environment's ACME key (base64)."

- [ ] **Step 4: The `renew` mode and step 19**

In `sirdar/api/src/sirdar_api/deploy/steps.py`: `MODES` adds `"renew"`; append `StepDef(19, "do_renew", "Renew certificate", "", 30 * 60, "vm")` to `STEPS`; add `("renew", False): ("do_renew",)` to `_CLOUD_PLANS`; the docstring's DigitalOcean paragraph adds "19 Renew certificate is Sirdar's backup renewal, a job of its own (renewals.py)."

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`: `KEEPS_STATUS = ("snapshot", "publish", "renew")`, and in `_close` replace `if mode not in ("snapshot", "publish"):` with `if mode not in KEEPS_STATUS:` (comment: "a snapshot, publish or renew job leaves the environment as it was").

In `sirdar/api/src/sirdar_api/deploy/do_provision.py`: the module docstring's first sentence adds "and Renew certificate (\"do_renew\", step 19)"; `STEPS = ("do_prepare", "go_live", "do_destroy", "do_renew")`; in `run`, before the `else` that destroys:

```python
                elif step == "do_renew":
                    await self._renew(api, ctx, out)
```

(keep `do_destroy` as the final `else`). Add after `_put_back`:

```python
    # ---- step 19: Renew certificate --------------------------------------------------------

    async def _renew(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        """Sirdar's backup renewal: what step 0 does for the certificate
        (record what the cert-worker uploaded; renew by DNS-01 at 14 days or
        fewer), then the load balancer's HTTPS rule on it and the old
        certificates gone. The targets stay as they are."""
        await self._same_team(api, ctx)
        records = await load_records(ctx.env_id)
        lb = await self._live_lb(api, ctx, records)
        cert = await self._certificate(api, ctx, out)
        if https_certificate(lb) == cert["id"]:
            out(f"Load balancer {lb['name']}: already uses the certificate {cert['name']}.\n")
        else:
            current = await self._lb_active(api, lb["id"], lb["name"])
            await api.update_load_balancer(lb["id"], lb_update_body(
                current, forwarding_rules=_rules(cert["id"])))
            await self._lb_active(api, lb["id"], lb["name"])
            out(f"Load balancer {lb['name']}: now uses the certificate {cert['name']}.\n")
        await self._retire_certificates(api, ctx, cert["id"], out)
```

- [ ] **Step 5: `renewals.py`, the setting and the loop**

Create `sirdar/api/src/sirdar_api/deploy/renewals.py`:

```python
"""Sirdar's backup certificate renewal for DigitalOcean environments (deploy
phase 7): every few hours, a `renew` deployment (step 19) for each
environment whose load balancer certificate has certs.SIRDAR_RENEW_DAYS (14)
or fewer days left and that isn't deploying. A deployment, so it shares the
one-running-deployment lock with Activate, keeps a log and an audit row, and
can be retried. The cert-worker on the live droplet renews first (at 30
days); this catches what it missed."""

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
                dep = await pipeline.create_deployment(
                    db, env, mode="renew", git_ref=env.git_ref, sha=env.current_sha,
                    actor_id=None, cloud=True)
            except pipeline.DeployInProgress:      # one started meanwhile: next round
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

In `sirdar/api/src/sirdar_api/config.py`, after `acme_staging_directory`:

```python
    # How often Sirdar looks for DigitalOcean certificates to renew (seconds; 0: never).
    cert_check_seconds: int = 6 * 3600
```

In `sirdar/api/src/sirdar_api/api/app.py` (import `asyncio` and `from contextlib import suppress`), in `_lifespan` after the startup sweeps:

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
    await pipeline.shutdown(timeout=pipeline.SHUTDOWN_SECONDS)   # runs end "interrupted"
    await dispose_engine()
```

(replacing the existing `yield` and the two lines after it). The tests' ASGI client doesn't run the lifespan.

- [ ] **Step 6: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_p7b4 .venv/bin/pytest -q tests/test_deploy_do_renewals.py tests/test_deploy_do_environments.py tests/test_deploy_envfile.py tests/test_deploy_playbooks.py tests/test_deploy_pipeline_do.py tests/test_deploy_do_provision.py tests/test_deploy_do_deployments_api.py tests/test_deploy_do_activate_api.py tests/test_deploy_do_slots_and_sizes.py tests/test_deploy_environments.py`
Then `SIRDAR_TEST_DB=sirdar_test_p7b4 SS_STACK_E2E=1 .venv/bin/pytest -q tests/test_deploy_stack_external.py` (env.example changed).
Expected: all PASS.

- [ ] **Step 7: Lint, commit, drop the test DB**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/envfile.py src/sirdar_api/deploy/do_envs.py src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/do_provision.py src/sirdar_api/deploy/renewals.py src/sirdar_api/config.py src/sirdar_api/api/app.py tests/do_helpers.py tests/test_deploy_do_renewals.py tests/test_deploy_do_environments.py tests/test_deploy_envfile.py tests/test_deploy_pipeline_do.py tests/test_deploy_playbooks.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/envfile.py deploy/stack/env.example sirdar/api/src/sirdar_api/deploy/do_envs.py sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/do_provision.py sirdar/api/src/sirdar_api/deploy/renewals.py sirdar/api/src/sirdar_api/config.py sirdar/api/src/sirdar_api/api/app.py sirdar/api/tests/do_helpers.py sirdar/api/tests/test_deploy_do_renewals.py sirdar/api/tests/test_deploy_do_environments.py sirdar/api/tests/test_deploy_envfile.py sirdar/api/tests/test_deploy_pipeline_do.py sirdar/api/tests/test_deploy_playbooks.py
git commit -m "feat(sirdar): backup certificate renewal and the cert-worker's .env

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7b4
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7b4_source
```

---

### Task 5: The dashboard API — every environment's flow, production first, both accounts

Implements the spotlight spec §5 (`GET /dashboard`). Runs in parallel with Tasks 1, 2 and 4: it touches only `dashboard/` and its tests, and its tests set up DigitalOcean records themselves (never through `do_helpers.built`, which Task 4 changes).

**Files:**
- Modify: `sirdar/api/src/sirdar_api/dashboard/service.py`, `sirdar/api/src/sirdar_api/dashboard/demo.py`
- Modify: `sirdar/api/tests/test_dashboard_api.py`, `sirdar/api/tests/test_deploy_digitalocean_integration.py` (one expected dict)
- Create: `sirdar/api/tests/test_dashboard_flow.py`

**Interfaces:**
- Consumes (7a): `do_envs.get`, `do_envs.slots_of`, `do_accounts.KEYS`, `DoAccount.label`, `DoResource` (`kind="load_balancer"`), `digitalocean.resolve(db, settings, account)`, `digitalocean.inventory`, `certs.days_left`, `certs.SIRDAR_RENEW_DAYS`, `serialize.latest_deployment`, `vms.get_for`, `targets.ssh_config_for`, `targets.public_targets`, `targets.is_vm_target`, `integrations.config_of(db, "npm")`.
- Produces the spotlight `GET /api/dashboard`:
  - `production` is gone. `environments[0]` is always the production card: the non-retiring production environment (else a retiring one), or the placeholder `{id: "production", label: "Production", sub: null, state: "empty", action_label: "Set up Production", environment: null, production: true, flow: <none flow>}`. Then Dev / Beta (placeholders until an environment of that type exists), the other environments by name, then tagged placeholders.
  - Every card: `id, label, sub, state, version, last_release, last_release_at, action_label, environment` (as today), plus `production: bool` and `flow`:

    ```
    flow = {kind: "load_balancer" | "proxy" | "none",
            middle: {label, sub, status: "ok" | "warn" | "down" | "unknown"},
            servers: [{id, label, sub, state: "live" | "idle" | "empty",
                       health: "healthy" | "degraded" | "unknown", version, deployed}],
            active_slot, certificate: {days_left, expires_at, tone: "ok" | "warn" | "bad"} | null,
            deploying_slot, failed_slot}
    ```

    DigitalOcean: `load_balancer`, middle "Load balancer" / its IP (or "Built by the first deploy") / the recorded load balancer's inventory status (`active` → ok, other → warn, recorded but missing from a fetched inventory → down, no record or no inventory → unknown); one server per slot (label `Orange`, sub its droplet's public IP or "Not built yet", `live` for the active slot, `idle` for a built or deployed slot, else `empty`; health from `last_check_ok`, degraded when the inventory shows its droplet not `active`; version = the slot's image tag; `deployed` = the slot has a commit); certificate from `do_environments.cert_not_after` (tone `bad` once expired, `warn` at ≤ 14 days by the floor of the days left, else `ok`; `days_left` never below 0).
    LAN (SSH target or VM): `proxy`, middle "Nginx Proxy Manager" / the NPM integration URL's host (or "Not set up"; `ok` when set up, else `unknown`); one server `{id: "host", label: <VM name or the target's label>, sub: <VM address or the SSH host>}`, `live` once deployed; health `degraded` when failed, `healthy` when deployed and ready, else `unknown`; certificate null; `active_slot` `"host"` once deployed.
    Placeholders: `none`, middle `{label: "Not built yet", sub: "", status: "unknown"}`, one server `{id: "none", label: "Server", sub: "Not built yet", state: "empty", health: "unknown", version: null, deployed: false}`.
    `deploying_slot`: while the environment is deploying (or deleting) and its latest deployment runs, that deployment's slot (`"host"` on the LAN). `failed_slot`: while the environment is failed and its latest deployment failed, was canceled or interrupted, that deployment's slot (`"host"` on the LAN); a Deactivate has none.
  - `infrastructure = {source, error, tree, accounts: [{key, label, error}]}`: every DigitalOcean account with a token is read with its own token (cached by token hash, as today). One account: the tree and `error` exactly as today. Two: one top node per account (`node("account-<key>", "<label> account", "group", "DigitalOcean account", …)` with that account's tree as children), and `error` names each failed account ("Development account: <reason>").
  - `service.cert_info(when, now) -> dict | None`.
  - Demo data (`?demo=1`): the same shape — a two-slot production (blue live, green idle), a two-slot dev `dev` (orange live, purple idle, deployed), a LAN `uat`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_dashboard_flow.py`:

```python
"""The spotlight's data: every dashboard card carries its flow (live
traffic → load balancer or Nginx Proxy Manager → its servers). Production is
always the first card (or a placeholder); DigitalOcean values come from
Sirdar's records and the accounts' inventories, LAN values from the target
and the NPM integration."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import update

from sirdar_api.config import get_settings
from sirdar_api.dashboard import service
from sirdar_api.dashboard.demo import demo_dashboard
from sirdar_api.db.models import Deployment, DoEnvironment, DoSlot, Environment
from sirdar_api.deploy import do_envs, targets, vms

from .api_helpers import auth_headers
from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .do_helpers import configure_account, deployed, do_cloud, make_do_environment  # noqa: F401
from .fake_digitalocean import DEV_TOKEN, DO_TOKEN, RENEW_TOKEN
from .integration_helpers import configure, configure_proxmox
from .test_deploy_pipeline import SHA
from .vm_helpers import make_vm_environment

pytestmark = pytest.mark.usefixtures("secrets_key")
NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    service.clear_cache()
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "")
    get_settings.cache_clear()
    yield
    service.clear_cache()
    get_settings.cache_clear()


async def _dashboard(client, db) -> dict:
    h = await auth_headers(client, db)
    resp = await client.get("/api/dashboard", headers=h)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _do_live(db, env, *, active, days=40, checks=None, lb="lb-1"):
    """Records as a deploy leaves them, without step 0: slots deployed, the
    load balancer recorded (and in the fake's inventory), a certificate."""
    await deployed(db, env, active, sha=SHA)
    await db.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env.id).values(
        lb_ip="203.0.113.50", cert_not_after=datetime.now(UTC) + timedelta(days=days, hours=1)))
    for slot, ok in (checks or {}).items():
        await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                              DoSlot.slot == slot).values(last_check_ok=ok))
    await db.commit()
    if lb:
        await do_envs.record(env.id, "load_balancer", lb, f"ss-{env.name}-lb")


def _lb(do_cloud, lb_id: str, status: str = "active") -> None:
    do_cloud.do.load_balancers[lb_id] = {
        "id": lb_id, "name": "lb", "ip": "203.0.113.50", "status": status,
        "region": {"slug": "nyc3"}, "droplet_ids": [], "forwarding_rules": [], "tags": []}


async def test_a_two_slot_production_is_the_first_card(client, db, do_cloud):
    prod = await make_do_environment(db, name="prod", type_="production", account="production")
    await _do_live(db, prod, active="blue", days=10, checks={"blue": True})
    _lb(do_cloud, "lb-1")
    card = (await _dashboard(client, db))["environments"][0]
    assert (card["id"], card["production"], card["environment"], card["state"]) == (
        "prod", True, "prod", "active")
    flow = card["flow"]
    assert flow["kind"] == "load_balancer"
    assert flow["middle"] == {"label": "Load balancer", "sub": "203.0.113.50", "status": "ok"}
    assert [(s["id"], s["label"], s["sub"], s["state"], s["health"], s["deployed"])
            for s in flow["servers"]] == [
        ("blue", "Blue", "127.0.0.1", "live", "healthy", True),
        ("green", "Green", "127.0.0.1", "idle", "unknown", True)]
    assert flow["servers"][0]["version"] == SHA[:8]
    assert (flow["active_slot"], flow["deploying_slot"], flow["failed_slot"]) == ("blue", None, None)
    assert (flow["certificate"]["days_left"], flow["certificate"]["tone"]) == (10, "warn")


async def test_without_production_the_first_card_is_a_placeholder(client, db):
    first = (await _dashboard(client, db))["environments"][0]
    assert {k: first[k] for k in ("id", "label", "state", "action_label", "environment",
                                  "production")} == {
        "id": "production", "label": "Production", "state": "empty",
        "action_label": "Set up Production", "environment": None, "production": True}
    assert first["flow"] == {
        "kind": "none", "middle": {"label": "Not built yet", "sub": "", "status": "unknown"},
        "servers": [{"id": "none", "label": "Server", "sub": "Not built yet", "state": "empty",
                     "health": "unknown", "version": None, "deployed": False}],
        "active_slot": None, "certificate": None, "deploying_slot": None, "failed_slot": None}


async def test_a_one_slot_environment_without_a_load_balancer_yet(client, db, do_cloud):
    await make_do_environment(db, name="solo", slots=1)
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "solo")
    assert (card["production"], card["sub"]) == (False, "Development")
    flow = card["flow"]
    assert flow["middle"] == {"label": "Load balancer", "sub": "Built by the first deploy",
                              "status": "unknown"}
    assert [(s["id"], s["sub"], s["state"]) for s in flow["servers"]] == [
        ("orange", "Not built yet", "empty")]
    assert flow["certificate"] is None


async def test_a_load_balancer_missing_from_the_inventory_is_down(client, db, do_cloud):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange", lb="lb-gone")
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "uat9")
    assert card["flow"]["middle"]["status"] == "down"


async def test_deploying_and_failed_slots(client, db, do_cloud):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange")
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="running", cloud=True, slot="purple"))
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        status="deploying"))
    await db.commit()
    flow = next(c for c in (await _dashboard(client, db))["environments"]
                if c["id"] == "uat9")["flow"]
    assert (flow["deploying_slot"], flow["failed_slot"]) == ("purple", None)
    await db.execute(update(Deployment).where(Deployment.environment_id == env.id).values(
        status="failed"))
    await db.execute(update(Environment).where(Environment.id == env.id).values(status="failed"))
    await db.commit()
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "uat9")
    assert card["state"] == "failed"
    assert (card["flow"]["deploying_slot"], card["flow"]["failed_slot"],
            card["flow"]["active_slot"]) == (None, "purple", "orange")   # orange still live


async def test_a_lan_ssh_environment_is_proxy_then_one_host(client, db, monkeypatch):
    await configure(db)                        # Cloudflare and NPM (http://10.10.48.6:81)
    await make_environment(db, name="uat", current_sha=SHA, secrets={})
    monkeypatch.setattr(targets, "ssh_config_for",
                        lambda tid, s: SimpleNamespace(host="10.10.48.63"))
    monkeypatch.setattr(targets, "public_targets",
                        lambda s, **kw: [{"id": "ssh", "label": "Lab box"}])
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "uat")
    assert card["flow"] == {
        "kind": "proxy",
        "middle": {"label": "Nginx Proxy Manager", "sub": "10.10.48.6", "status": "ok"},
        "servers": [{"id": "host", "label": "Lab box", "sub": "10.10.48.63", "state": "live",
                     "health": "healthy", "version": SHA[:8], "deployed": True}],
        "active_slot": "host", "certificate": None, "deploying_slot": None,
        "failed_slot": None}


async def test_a_vm_environment_shows_its_vm(client, db):
    await configure_proxmox(db)
    env = await make_vm_environment(db, name="uat3")
    vm = await vms.get_for(db, env)
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "uat3")
    (server,) = card["flow"]["servers"]
    assert (server["label"], server["sub"], server["state"]) == (
        vm.name, vm.ip or "No address yet", "empty")
    assert card["flow"]["middle"] == {"label": "Nginx Proxy Manager", "sub": "Not set up",
                                      "status": "unknown"}


@pytest.mark.parametrize("delta, days, tone", [
    (timedelta(days=30, hours=1), 30, "ok"),
    (timedelta(days=14, hours=1), 14, "warn"),
    (timedelta(hours=-1), 0, "bad"),
])
def test_certificate_tones(delta, days, tone):
    info = service.cert_info(NOW + delta, NOW)
    assert (info["days_left"], info["tone"]) == (days, tone)
    assert info["expires_at"] == (NOW + delta).isoformat()
    assert service.cert_info(None, NOW) is None


async def test_both_accounts_in_the_infrastructure(client, db, do_cloud):
    await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
    await configure_account(db)
    do_cloud.do.add_droplet("ss-prod-blue", ["sirdar", "sirdar-env:prod"])
    infra = (await _dashboard(client, db))["infrastructure"]
    assert [(a["key"], a["error"]) for a in infra["accounts"]] == [
        ("production", None), ("development", None)]
    assert [n["name"] for n in infra["tree"]] == ["Production account", "Development account"]
    assert {r.headers["authorization"] for r in do_cloud.do.requests} == {
        f"Bearer {DO_TOKEN}", f"Bearer {DEV_TOKEN}"}


def test_the_demo_has_the_same_shape():
    d = demo_dashboard()
    assert "production" not in d
    assert [(c["id"], c["production"], c["flow"]["kind"], len(c["flow"]["servers"]))
            for c in d["environments"]] == [
        ("production", True, "load_balancer", 2), ("dev", False, "load_balancer", 2),
        ("uat", False, "proxy", 1)]
    for card in d["environments"]:
        assert set(card) == {"id", "label", "sub", "state", "version", "last_release",
                             "last_release_at", "action_label", "environment", "production",
                             "flow"}
        assert set(card["flow"]) == {"kind", "middle", "servers", "active_slot", "certificate",
                                     "deploying_slot", "failed_slot"}
```

Update `sirdar/api/tests/test_dashboard_api.py` for the new shape:
- add near the top

```python
def _plain(card: dict) -> dict:
    """A card without the spotlight fields (test_dashboard_flow covers them)."""
    return {k: v for k, v in card.items() if k not in ("flow", "production")}
```

- `test_real_no_token`: `d["infrastructure"] == {"source": "none", "error": None, "tree": [], "accounts": []}`; replace the `p = d["production"]` block (5 lines) with `assert "production" not in d`; the environments assertion becomes `[("production", "empty", None, None, "Set up Production"), ("dev", …), ("beta", …)]`.
- `test_real_with_inventory`: drop the `d["production"]["load_balancer"]` line; ids become `["production", "dev", "beta", "qa-team"]` and the label check uses index 3; add `assert d["infrastructure"]["accounts"] == [{"key": "production", "label": "Production", "error": None}]`.
- `test_do_401_still_200`: add `assert infra["accounts"] == [{"key": "production", "label": "Production", "error": "DigitalOcean rejected the API token."}]`.
- `test_demo`: replace the `blue, green = d["production"]["slots"]` block and the environments assertions with

```python
    prod, dev, uat = d["environments"]
    blue, green = prod["flow"]["servers"]
    assert (blue["state"], blue["version"], green["state"], green["version"]) == (
        "live", "v2.8.0", "idle", "v2.7.9")
    assert (prod["flow"]["active_slot"], dev["flow"]["active_slot"]) == ("blue", "orange")
    assert uat["flow"]["middle"]["label"] == "Nginx Proxy Manager"
```

  (the tree assertions stay).
- `test_demo_shape_is_stable`: `set(d)` is unchanged except `"production"` goes: `{"demo", "generated_at", "health", "environments", "infrastructure"}`.
- `test_real_environments`: `[_plain(c) for c in d["environments"][1:]] == [...]` (the three dicts as before); the first card is the production placeholder.
- `test_health_when_an_environment_is_deployed` and `test_a_tagged_droplet_with_an_environment_gets_one_card`: the id lists start with `("production", "empty")` / `("production", None)`.

In `sirdar/api/tests/test_deploy_digitalocean_integration.py`, `test_dashboard_uses_the_stored_token`: `assert infra == {"source": "none", "error": None, "tree": [], "accounts": []}`.

- [ ] **Step 2: Run them to verify they fail**

Run: `SIRDAR_TEST_DB=sirdar_test_p7b5 .venv/bin/pytest -q tests/test_dashboard_flow.py tests/test_dashboard_api.py`
Expected: FAIL (no `flow`; the `production` block is still there).

- [ ] **Step 3: The service**

In `sirdar/api/src/sirdar_api/dashboard/service.py`:

1. Docstring:

```python
"""Dashboard data (the Deployments page's spotlight). Every card has one
shape: Production first (or a placeholder), Dev / Beta (placeholders until an
environment of that type exists), the other environments by name, then
DigitalOcean env tags no environment answers to. Each card carries its flow:
live traffic → the middle box (a DigitalOcean load balancer, or Nginx Proxy
Manager on the LAN) → its server(s). DigitalOcean values come from Sirdar's
records (do_environments, do_slots, do_resources) and each account's
inventory (read with that account's token, cached by the token's hash; the
same inventories fill the infrastructure tree). LAN values come from the
environment's target and the NPM integration's URL. No token reaches the
response or a cache key."""
```

2. Imports: `import math`, `from urllib.parse import urlsplit`; models `Deployment, DoAccount, DoEnvironment, DoResource, Environment`; `from sirdar_api.deploy import (ConnectFailed, certs, digitalocean, do_accounts, do_envs, integrations, names, outbound, serialize, targets, vms)`; and `_RETRYABLE = ("failed", "cancelled", "interrupted")  # pipeline.RETRYABLE_STATUSES (not imported: the dashboard stays light)`.
3. `_TYPE_LABELS = {"dev": "Development", "beta": "Beta", "custom": "Custom", "production": "Production"}`.
4. Replace `_environment_card`, `_placeholder`, `environment_cards` and `build_dashboard` with the code below, and add the helpers (keep `_slot_of`, `build_tree`, `_inventory`, `_env_state`, `_last_release`, `_health`):

```python
def cert_info(when: datetime | None, now: datetime) -> dict | None:
    """A load balancer certificate for the spotlight: amber at 14 days or
    fewer, red once expired."""
    if when is None:
        return None
    left = certs.days_left(when, now)
    days = math.floor(left)
    tone = "bad" if left <= 0 else "warn" if days <= certs.SIRDAR_RENEW_DAYS else "ok"
    return {"days_left": max(0, days), "expires_at": when.isoformat(), "tone": tone}


def _empty_flow() -> dict:
    return {"kind": "none", "middle": {"label": "Not built yet", "sub": "", "status": "unknown"},
            "servers": [{"id": "none", "label": "Server", "sub": "Not built yet",
                         "state": "empty", "health": "unknown", "version": None,
                         "deployed": False}],
            "active_slot": None, "certificate": None, "deploying_slot": None,
            "failed_slot": None}


async def _marks(db: AsyncSession, env: Environment, lan: bool) -> tuple[str | None, str | None]:
    """(deploying slot, failed slot) from the environment's latest deployment."""
    latest = await serialize.latest_deployment(db, env.id)
    if latest is None:
        return None, None
    slot = "host" if lan else latest.slot
    if env.status in ("deploying", "deleting") and latest.status == "running":
        return slot, None
    if env.status == "failed" and latest.status in _RETRYABLE:
        return None, slot
    return None, None


def _slot_health(row, droplet: dict | None) -> str:
    if droplet is not None and droplet.get("status") != "active":
        return "degraded"
    if row is None or row.last_check_ok is None:
        return "unknown"
    return "healthy" if row.last_check_ok else "degraded"


async def _do_flow(db: AsyncSession, env: Environment, row: DoEnvironment, inv: dict | None,
                   now: datetime) -> dict:
    slots = await do_envs.slots_of(db, env.id)
    lb_id = await db.scalar(select(DoResource.do_id).where(
        DoResource.environment_id == env.id, DoResource.kind == "load_balancer")
        .order_by(DoResource.created_at.desc()).limit(1))
    lbs = {str(x.get("id")): x for x in (inv or {}).get("load_balancers", [])}
    droplets = {str(x.get("id")): x for x in (inv or {}).get("droplets", [])}
    if lb_id is None or inv is None:
        status = "unknown"
    elif lb_id not in lbs:
        status = "down"
    else:
        status = "ok" if lbs[lb_id].get("status") == "active" else "warn"
    servers = []
    for slot in env.slots:
        r = slots.get(slot)
        built = bool(r and (r.droplet_id or r.sha))
        state = "live" if slot == env.active_slot else "idle" if built else "empty"
        servers.append({
            "id": slot, "label": slot.title(),
            "sub": r.public_ip if r and r.public_ip else "Not built yet", "state": state,
            "health": _slot_health(r, droplets.get(r.droplet_id) if r and r.droplet_id else None),
            "version": r.image_tag if r else None, "deployed": bool(r and r.sha)})
    deploying, failed = await _marks(db, env, lan=False)
    return {"kind": "load_balancer",
            "middle": {"label": "Load balancer", "sub": row.lb_ip or "Built by the first deploy",
                       "status": status},
            "servers": servers, "active_slot": env.active_slot,
            "certificate": cert_info(row.cert_not_after, now),
            "deploying_slot": deploying, "failed_slot": failed}


async def _lan_server(db: AsyncSession, settings: Settings, env: Environment) -> tuple[str, str]:
    """(label, address) of a LAN environment's one host: its VM, or its SSH target."""
    if targets.is_vm_target(env.target_id):
        vm = await vms.get_for(db, env)
        return (vm.name, vm.ip or "No address yet") if vm else ("VM", "Not built yet")
    try:
        cfg = targets.ssh_config_for(env.target_id, settings)
        labels = {t["id"]: t["label"] for t in targets.public_targets(settings)}
    # An unreadable deploy-targets.env must not break the dashboard.
    except Exception as e:  # noqa: BLE001
        log.warning("dashboard couldn't read the SSH targets: %s", type(e).__name__)
        cfg, labels = None, {}
    return labels.get(env.target_id, "Host"), cfg.host if cfg else "—"


async def _lan_flow(db: AsyncSession, settings: Settings, env: Environment) -> dict:
    url = (await integrations.config_of(db, "npm")).get("url")
    npm_host = urlsplit(url).hostname if url else None
    label, sub = await _lan_server(db, settings, env)
    live = env.current_sha is not None
    health = ("degraded" if env.status == "failed"
              else "healthy" if live and env.status == "ready" else "unknown")
    deploying, failed = await _marks(db, env, lan=True)
    return {"kind": "proxy",
            "middle": {"label": "Nginx Proxy Manager", "sub": npm_host or "Not set up",
                       "status": "ok" if npm_host else "unknown"},
            "servers": [{"id": "host", "label": label, "sub": sub,
                         "state": "live" if live else "empty", "health": health,
                         "version": env.image_tag, "deployed": live}],
            "active_slot": "host" if live else None, "certificate": None,
            "deploying_slot": deploying, "failed_slot": failed}


async def _environment_card(db: AsyncSession, settings: Settings, env: Environment,
                            inventories: dict[str, dict], now: datetime) -> dict:
    last = await _last_release(db, env.id)
    version = env.image_tag or (env.current_sha[:8] if env.current_sha else None)
    if env.target_id == targets.DO_TARGET:
        row = await do_envs.get(db, env.id)
        flow = (await _do_flow(db, env, row, inventories.get(row.account_key), now)
                if row else _empty_flow())
    else:
        flow = await _lan_flow(db, settings, env)
    return {"id": env.name, "label": env.name,
            "sub": _TYPE_LABELS.get(env.type, env.type.title()), "state": _env_state(env),
            "version": version, "last_release": last.sha[:8] if last else None,
            "last_release_at": (last.finished_at.isoformat()
                                if last and last.finished_at else None),
            "action_label": f"Deploy {env.name}", "environment": env.name,
            "production": env.type == "production", "flow": flow}


def _placeholder(env: str, action_label: str, *, production: bool = False) -> dict:
    return {"id": env, "label": _label(env), "sub": None, "state": "empty", "version": None,
            "last_release": None, "last_release_at": None, "action_label": action_label,
            "environment": None, "production": production, "flow": _empty_flow()}


async def environment_cards(db: AsyncSession | None, settings: Settings, tagged: list[str],
                            inventories: dict[str, dict], now: datetime) -> list[dict]:
    """Production first (the live one, else a retiring one, else a
    placeholder), Dev / Beta (placeholders until one exists), the rest by
    name, then DigitalOcean env tags no environment answers to."""
    rows: list[Environment] = []
    if db is not None:
        rows = list(await db.scalars(select(Environment).order_by(Environment.name)))

    async def card(e: Environment) -> dict:
        return await _environment_card(db, settings, e, inventories, now)

    prods = sorted((e for e in rows if e.type == "production"), key=lambda e: e.retiring)
    first = prods[0] if prods else None
    cards = [await card(first) if first else
             _placeholder("production", "Set up Production", production=True)]
    for type_, short in (("dev", "Dev"), ("beta", "Beta")):
        typed = [e for e in rows if e.type == type_]
        if typed:
            cards += [await card(e) for e in typed]
        else:
            cards.append(_placeholder(type_, f"Set up {short}"))
    cards += [await card(e) for e in rows if e.type not in ("dev", "beta") and e is not first]
    known = {e.name for e in rows}
    cards += [_placeholder(e, f"Set up {_label(e)}") for e in tagged if e not in known]
    return cards


async def _read_accounts(db: AsyncSession, settings: Settings, refresh: bool,
                         infra: dict) -> list[tuple[str, str, dict]]:
    """(key, label, inventory) for each account whose inventory was read;
    every account with a token (or an unreadable one) is listed in
    infra["accounts"] with its error."""
    read: list[tuple[str, str, dict]] = []
    for key in do_accounts.KEYS:
        row = await db.get(DoAccount, key)
        label = row.label if row else key.title()
        try:
            resolved = await digitalocean.resolve(db, settings, key)
        except IntegrationError as e:          # a stored token that won't decrypt
            infra["accounts"].append({"key": key, "label": label, "error": e.reason})
            continue
        if not targets.is_configured("digitalocean", resolved):
            continue
        try:
            read.append((key, label, await _inventory(resolved, refresh)))
            infra["accounts"].append({"key": key, "label": label, "error": None})
        except ConnectFailed as e:
            infra["accounts"].append({"key": key, "label": label, "error": e.reason})
    return read


async def build_dashboard(settings: Settings, *, db: AsyncSession | None = None,
                          demo: bool = False, refresh: bool = False) -> dict:
    if demo:
        return demo_dashboard()
    infra: dict = {"source": "none", "error": None, "tree": [], "accounts": []}
    read: list[tuple[str, str, dict]] = []
    if db is not None:
        read = await _read_accounts(db, settings, refresh, infra)
    elif targets.is_configured("digitalocean", settings):
        # No database (unit callers): the server's SIRDAR_DEPLOY_DO_TOKEN only.
        infra["accounts"].append({"key": "production", "label": "Production", "error": None})
        try:
            read = [("production", "Production", await _inventory(settings, refresh))]
        except ConnectFailed as e:
            infra["accounts"][0]["error"] = e.reason
    if infra["accounts"]:
        infra["source"] = "digitalocean"
    failed = [a for a in infra["accounts"] if a["error"]]
    if len(infra["accounts"]) == 1 and failed:
        infra["error"] = failed[0]["error"]
    elif failed:
        infra["error"] = " ".join(f"{a['label']} account: {a['error']}" for a in failed)
    if len(read) == 1:
        infra["tree"] = build_tree(read[0][2])
    elif read:
        groups = []
        for key, label, inv in read:
            children = build_tree(inv)
            status, status_label = _rollup(children)
            groups.append(node(f"account-{key}", f"{label} account", "group",
                               "DigitalOcean account", status, status_label, children=children))
        infra["tree"] = groups
    every = [r for _, _, inv in read for kind in ("droplets", "databases", "load_balancers")
             for r in inv[kind]]
    tagged = sorted({e for r in every if (e := _env_of(r)) and e not in _FIXED})
    envs = await environment_cards(db, settings, tagged, {key: inv for key, _, inv in read},
                                   datetime.now(UTC))
    return {"demo": False, "generated_at": datetime.now(UTC).isoformat(),
            "health": _health(envs), "environments": envs, "infrastructure": infra}
```

   (`log = logging.getLogger(__name__)` and `import logging` at the top; `IntegrationError` stays imported.)

- [ ] **Step 4: The demo**

In `sirdar/api/src/sirdar_api/dashboard/demo.py`, replace the `production` block and `environments` list with cards of the new shape (keep `tree` as it is):

```python
def _server(id_, label, sub, state, health, version) -> dict:
    return {"id": id_, "label": label, "sub": sub, "state": state, "health": health,
            "version": version, "deployed": version is not None}


def _do_flow(lb_ip, servers, active, days) -> dict:
    return {"kind": "load_balancer",
            "middle": {"label": "Load balancer", "sub": lb_ip, "status": "ok"},
            "servers": servers, "active_slot": active,
            "certificate": {"days_left": days, "expires_at": "2027-01-04T12:00:00+00:00",
                            "tone": "ok" if days > 14 else "warn"},
            "deploying_slot": None, "failed_slot": None}


def _card(id_, label, sub, state, version, release, action, production, flow) -> dict:
    return {"id": id_, "label": label, "sub": sub, "state": state, "version": version,
            "last_release": release, "last_release_at": None, "action_label": action,
            "environment": None, "production": production, "flow": flow}
```

and in `demo_dashboard()`:

```python
        "environments": [
            _card("production", "Production", "Production", "active", "v2.8.0", "v2.8.0",
                  "Deploy production", True, _do_flow("203.0.113.10", [
                      _server("blue", "Blue", "10.20.0.10", "live", "healthy", "v2.8.0"),
                      _server("green", "Green", "10.20.0.20", "idle", "unknown", "v2.7.9")],
                      "blue", 64)),
            _card("dev", "Development", "Development", "active", "v2.8.1-dev", "v2.8.1-dev",
                  "Deploy to Dev", False, _do_flow("203.0.113.20", [
                      _server("orange", "Orange", "10.30.0.10", "live", "healthy", "v2.8.1-dev"),
                      _server("purple", "Purple", "10.30.0.11", "idle", "healthy", "v2.8.2-dev")],
                      "orange", 12)),
            _card("uat", "UAT", "Custom", "active", "v2.8.1-rc.2", "v2.8.1-rc.2", "Deploy to UAT",
                  False, {"kind": "proxy",
                          "middle": {"label": "Nginx Proxy Manager", "sub": "10.10.48.6",
                                     "status": "ok"},
                          "servers": [_server("host", "Lab box", "10.10.48.63", "live",
                                              "healthy", "v2.8.1-rc.2")],
                          "active_slot": "host", "certificate": None, "deploying_slot": None,
                          "failed_slot": None}),
        ],
```

(the demo dev certificate at 12 days shows the amber pill). Remove the `"production": {...}` key.

- [ ] **Step 5: Run the tests**

Run: `SIRDAR_TEST_DB=sirdar_test_p7b5 .venv/bin/pytest -q tests/test_dashboard_flow.py tests/test_dashboard_api.py tests/test_dashboard_inventory.py tests/test_deploy_digitalocean_integration.py`
Expected: all PASS.

- [ ] **Step 6: Lint, commit, drop the test DB**

```bash
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/dashboard/service.py src/sirdar_api/dashboard/demo.py tests/test_dashboard_flow.py tests/test_dashboard_api.py tests/test_deploy_digitalocean_integration.py
cd ../.. && git add sirdar/api/src/sirdar_api/dashboard/service.py sirdar/api/src/sirdar_api/dashboard/demo.py sirdar/api/tests/test_dashboard_flow.py sirdar/api/tests/test_dashboard_api.py sirdar/api/tests/test_deploy_digitalocean_integration.py
git commit -m "feat(sirdar): dashboard flows for every environment, production first, both accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7b5
PGPASSWORD=sirdar dropdb -w -h 127.0.0.1 -p 5434 -U sirdar --if-exists sirdar_test_p7b5_source
```

---

### Task 6: Web foundation — types, calls, copy, labels, fixtures and styles

Owns every web file Tasks 7–9 share, so those three run in parallel afterwards. Its additions are inert until they're used, so it can land before, during or after the backend tasks.

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts`, `sirdar/web/src/lib/sirdarApi.test.ts`
- Modify: `sirdar/web/src/pages/environments/labels.tsx`, `sirdar/web/src/pages/environments/labels.test.ts`
- Modify: `sirdar/web/src/pages/environments/testData.ts`, `sirdar/web/src/pages/dashboard/testData.ts`
- Modify: `sirdar/web/src/styles/sirdar.css`

**Interfaces:**
- Consumes: the API shapes of 7a (`Environment.do/slots/active_slot/auto_activate/retiring`, `target_kind: 'digitalocean'`, `DeploymentSummary.cloud/slot/go_live`, `GET/PUT/POST test/DELETE /deploy/integrations/digitalocean/accounts[/{key}]`, `environment-defaults.do`, Delete's `snapshot`/`confirm_production`, `RetryIn.confirm_production`), Tasks 1–2 (`POST …/activate`, `POST …/slots`, PATCH `auto_activate`/`do`, `regions?account=`, connect `account`, create `do.auto_activate`) and Task 5 (`DashEnvironment.production/flow`, `infrastructure.accounts`).
- Produces (for Tasks 7–10):
  - types `DoAccountKey`, `DoAccount`, `DoAccountBody`, `EnvDoSlot`, `EnvDo`, `NewDo`, `DoDefaults`, `DoSizes`, `DashCert`, `DashServer`, `DashFlow`; `EnvType` adds `'production'`; `DeploymentMode` adds `'activate' | 'renew'`; `Environment` adds `slots`, `active_slot`, `auto_activate`, `retiring`, `do`, and `target_kind` adds `'digitalocean'`; `DeploymentSummary` adds `cloud`, `slot`, `go_live`; `NewEnvironmentBody.proxy_ip`/`bind_ip` become optional and it gains `do?`; `EnvironmentDefaults.do`; `EnvironmentPatch` adds `retiring?`, `confirm_name?`, `auto_activate?`, `do?`; `DeploymentBody` adds `snapshot?`, `confirm_production?`; `RetryBody` adds `confirm_production?`; `DashEnvironment` adds `production`, `flow`; `DashboardData.infrastructure.accounts?`.
  - calls `getDoAccounts()`, `saveDoAccount(key, body)`, `testDoAccount(key, body?)`, `clearDoAccount(key)`, `getDoRegions(account = 'production')`, `connectDeploy(target, type, region?, name?, account?)`, `activateSlot(name, slot, confirmName?)`, `addSlot(name)`.
  - copy for the ten codes in "New error codes".
  - labels: `TYPE_LABEL.production`, `MODE_LABEL.activate/renew`, `CHANGE_MODES`, `RETRY_MODES` + `activate`, `renew`; `NOT_ON_DO` (`reset`, `restore_dump`, `rollback`, `vm_restore`); `onDo(env)`, `isDoTarget(id)`, `slotTitle(slot)`, `idleSlot(env)`, `goesLive(env, slot)`, `certDaysLeft(iso, now?)`, `deploymentLabel(d)`, `retryNeedsName(mode, env)`, `DO_RESOURCE_LABEL`; `envTargets` lists DigitalOcean once configured.
  - fixtures (environments): `DO_DEFAULTS` (also in `DEFAULTS.do`), `DO_ACCOUNTS` (Production set up, Development not), `DO_ACCOUNTS_BOTH`, `DO_ENV` (uat9: orange live, purple deployed idle), `ONE_SLOT_ENV` (solo), `PROD_ENV` (prod: blue live), `DO_TARGETS`, `DO_UPDATE` (a DigitalOcean Update to purple, not live); every existing fixture gains the new fields. Fixtures (dashboard): `NONE_FLOW`, and every existing card gains `production: false, flow: NONE_FLOW`.
  - CSS: `.sirdar-doacct-card`, `.sirdar-doacct-form`, `.sirdar-activate-card`, `.sirdar-docloud-form`, `.sirdar-switch-row`; the old `.sirdar-do-card` / `.sirdar-do-form` rules go (their only user, `DigitalOceanModal`, is deleted in Task 7).

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/lib/sirdarApi.test.ts`, add to `CALLS`:

```ts
  { name: 'getDoAccounts', call: () => sirdar.getDoAccounts(), path: '/deploy/integrations/digitalocean/accounts' },
  { name: 'saveDoAccount', call: () => sirdar.saveDoAccount('development', { label: 'Development', region: 'nyc3', token: 't' }),
    path: '/deploy/integrations/digitalocean/accounts/development', method: 'PUT',
    body: { label: 'Development', region: 'nyc3', token: 't' } },
  { name: 'testDoAccount', call: () => sirdar.testDoAccount('production'),
    path: '/deploy/integrations/digitalocean/accounts/production/test', method: 'POST' },
  { name: 'clearDoAccount', call: () => sirdar.clearDoAccount('development'),
    path: '/deploy/integrations/digitalocean/accounts/development', method: 'DELETE' },
  { name: 'getDoRegions', call: () => sirdar.getDoRegions('development'),
    path: '/deploy/digitalocean/regions?account=development' },
  { name: 'getDoRegions (default)', call: () => sirdar.getDoRegions(), path: '/deploy/digitalocean/regions?account=production' },
  { name: 'connectDeploy (account)', call: () => sirdar.connectDeploy('digitalocean', 'dev', 'nyc3', undefined, 'development'),
    path: '/deploy/connect', method: 'POST', body: { target: 'digitalocean', type: 'dev', region: 'nyc3', account: 'development' } },
  { name: 'activateSlot', call: () => sirdar.activateSlot('uat9', 'purple'), path: '/deploy/environments/uat9/activate',
    method: 'POST', body: { slot: 'purple' } },
  { name: 'activateSlot (deactivate)', call: () => sirdar.activateSlot('prod', null, 'prod'),
    path: '/deploy/environments/prod/activate', method: 'POST', body: { slot: null, confirm_name: 'prod' } },
  { name: 'addSlot', call: () => sirdar.addSlot('solo'), path: '/deploy/environments/solo/slots', method: 'POST' },
  { name: 'updateEnvironment (sizes)', call: () => sirdar.updateEnvironment('uat9', { do: { droplet_size: 's-4vcpu-8gb' } }),
    path: '/deploy/environments/uat9', method: 'PATCH', body: { do: { droplet_size: 's-4vcpu-8gb' } } },
  { name: 'startDeployment (production delete)',
    call: () => sirdar.startDeployment('prod', { mode: 'teardown', confirm_name: 'prod', confirm_production: 'delete production prod' }),
    path: '/deploy/environments/prod/deployments', method: 'POST',
    body: { mode: 'teardown', confirm_name: 'prod', confirm_production: 'delete production prod' } },
  { name: 'retryDeployment (production delete)',
    call: () => sirdar.retryDeployment('d1', { from_step: 18, confirm_name: 'prod', confirm_production: 'delete production prod' }),
    path: '/deploy/deployments/d1/retry', method: 'POST',
    body: { from_step: 18, confirm_name: 'prod', confirm_production: 'delete production prod' } },
```

and append:

```ts
it('the phase 7b DigitalOcean codes have copy', () => {
  for (const code of ['not_digitalocean_environment', 'slot_invalid', 'slot_required', 'slot_already_active',
    'production_retiring', 'already_inactive', 'auto_activate_not_allowed', 'slots_full', 'slot_not_allowed',
    'do_shrink_refused']) {
    expect(sirdar.errorText(new ApiError(409, code), '__none__')).not.toBe('__none__');
  }
});
```

In `sirdar/web/src/pages/environments/labels.test.ts`, add to its imports `CHANGE_MODES, certDaysLeft, deploymentLabel, envTargets, goesLive, idleSlot, onDo, retryNeedsName, slotTitle` (from `./labels`) and `DO_ENV, DO_TARGETS, ENV, ONE_SLOT_ENV, PROD_ENV, SUCCEEDED, TARGETS, summary` (from `./testData`), and append:

```ts
describe('DigitalOcean helpers', () => {
  it('knows the slot an Update targets and whether it goes live', () => {
    expect(onDo(DO_ENV)).toBe(true);
    expect(onDo(ENV)).toBe(false);
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
    expect(certDaysLeft('2026-10-15T12:00:00Z', now)).toBe(10);
    expect(certDaysLeft(null, now)).toBeNull();
  });

  it('names DigitalOcean deployments by their slot', () => {
    const base = summary(SUCCEEDED);
    expect(deploymentLabel({ ...base, cloud: true, slot: 'purple', go_live: false })).toBe('Update to Purple, not live');
    expect(deploymentLabel({ ...base, cloud: true, slot: 'purple', go_live: true })).toBe('Update to Purple');
    expect(deploymentLabel({ ...base, mode: 'activate', cloud: true, slot: 'green', go_live: true })).toBe('Activate Green');
    expect(deploymentLabel({ ...base, mode: 'activate', cloud: true, slot: null, go_live: true })).toBe('Deactivate');
    expect(deploymentLabel({ ...base, mode: 'renew', cloud: true })).toBe('Renew certificate');
    expect(deploymentLabel(base)).toBe('Update');
  });

  it('offers DigitalOcean once an account is set up, and gates Activate', () => {
    expect(envTargets(DO_TARGETS.targets).map((t) => t.id)).toContain('digitalocean');
    expect(envTargets(TARGETS.targets).map((t) => t.id)).not.toContain('digitalocean');
    expect(CHANGE_MODES).toContain('activate');
    expect(retryNeedsName('activate', PROD_ENV)).toBe(true);
    expect(retryNeedsName('activate', DO_ENV)).toBe(false);
    expect(retryNeedsName('reset', ENV)).toBe(true);
    expect(retryNeedsName('update', ENV)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/lib/sirdarApi.test.ts src/pages/environments/labels.test.ts`
Expected: FAIL (the calls, helpers and fixtures don't exist).

- [ ] **Step 3: Types and calls**

In `sirdar/web/src/lib/sirdarApi.ts`:

```ts
export type EnvType = 'dev' | 'beta' | 'custom' | 'production';
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback' | 'publish' | 'teardown' | 'vm_restore'
  | 'activate' | 'renew';
```

After the `DoRegions` interface add:

```ts
/* ---- DigitalOcean accounts and environments (deploy phase 7) ---- */
export type DoAccountKey = 'production' | 'development';
export interface DoAccount {
  key: DoAccountKey; label: string; region: string | null; configured: boolean; token_set: boolean;
  source: 'stored' | 'environment' | null; renewal_token_set: boolean; team_name: string | null;
  /** Environments built in this account: it can't be cleared while any exist. */
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
  acme_staging?: boolean; auto_activate?: boolean;
}
export interface DoDefaults {
  droplet_size: string; db_size: string; db_standby: boolean;
  production_slots: string[]; one_slot: string[]; two_slots: string[];
}
/** PATCH `do`: sizes only grow (step 0 applies them on the next deploy). */
export interface DoSizes { droplet_size?: string; db_size?: string; db_standby?: boolean }
```

Edit the existing interfaces:
- `DeploymentSummary`: add `/** DigitalOcean: the slot it deploys or switches to, and whether it ends with Switch traffic. */ cloud: boolean; slot: string | null; go_live: boolean;`.
- `Environment`: `target_kind: 'ssh' | VmHostKind | 'digitalocean';` and add `/** DigitalOcean: its slots, the one the load balancer sends traffic to, auto-activate, retiring (production), and what Sirdar built. */ slots: string[]; active_slot: string | null; auto_activate: boolean; retiring: boolean; do: EnvDo | null;`.
- `EnvironmentDefaults`: add `do: DoDefaults;`.
- `NewEnvironmentBody`: `proxy_ip?: string; bind_ip?: string;` (DigitalOcean sends neither) and add `/** target 'digitalocean' only. */ do?: NewDo;`.
- `EnvironmentPatch`: add `retiring?: boolean; confirm_name?: string; auto_activate?: boolean; do?: DoSizes;`.
- `DeploymentBody`: add `/** DigitalOcean Delete: save a snapshot first (default yes; production always). */ snapshot?: boolean; /** DigitalOcean production Delete: "delete production <name>". */ confirm_production?: string;`.
- `RetryBody`: `{ from_step?: number; confirm_name?: string; confirm_production?: string }`.

Replace `connectDeploy` and `getDoRegions`:

```ts
export const connectDeploy = (target: string, type: string, region?: string, name?: string, account?: DoAccountKey) =>
  sendJson<ConnectResult>('POST', '/deploy/connect',
    { target, type, ...(region ? { region } : {}), ...(name ? { name } : {}), ...(account ? { account } : {}) });
export const getDoRegions = (account: DoAccountKey = 'production') =>
  getJson<DoRegions>(`/deploy/digitalocean/regions?account=${account}`);
const doAccountPath = (key: DoAccountKey) => `/deploy/integrations/digitalocean/accounts/${key}`;
export const getDoAccounts = () => getJson<{ accounts: DoAccount[] }>('/deploy/integrations/digitalocean/accounts');
export const saveDoAccount = (key: DoAccountKey, body: DoAccountBody) =>
  sendJson<{ accounts: DoAccount[] }>('PUT', doAccountPath(key), body);
/** No body: the saved account. A body: those values unsaved (omitted tokens = the stored ones). */
export const testDoAccount = (key: DoAccountKey, body?: DoAccountBody) =>
  sendJson<IntegrationCheck>('POST', `${doAccountPath(key)}/test`, body);
export async function clearDoAccount(key: DoAccountKey): Promise<void> {
  const resp = await apiFetch(doAccountPath(key), { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
```

After `rollbackDeployment`:

```ts
/** Blue/Green: smoke-test `slot` and move the load balancer to it; null deactivates (a retiring production).
 *  Production needs its name typed. */
export const activateSlot = (name: string, slot: string | null, confirmName?: string) =>
  sendJson<Deployment>('POST', `${envPath(name)}/activate`,
    confirmName === undefined ? { slot } : { slot, confirm_name: confirmName });
/** A one-slot environment's second slot; `deployment` deploys the running commit to it (null before any deploy). */
export const addSlot = (name: string) =>
  sendJson<{ environment: Environment; deployment: Deployment | null }>('POST', `${envPath(name)}/slots`);
```

Dashboard types (additive; Task 10 removes `DashProduction`):

```ts
export interface DashCert { days_left: number; expires_at: string; tone: 'ok' | 'warn' | 'bad' | string }
export interface DashServer {
  /** A slot ("blue", "orange"…), "host" on the LAN, "none" on a placeholder. */
  id: string; label: string; sub: string;
  state: 'live' | 'idle' | 'empty' | string; health: 'healthy' | 'degraded' | 'unknown' | string;
  version: string | null;
  /** The slot has run a deploy: it can be activated. */
  deployed: boolean;
}
export interface DashFlow {
  kind: 'load_balancer' | 'proxy' | 'none' | string;
  middle: { label: string; sub: string; status: 'ok' | 'warn' | 'down' | 'unknown' | string };
  servers: DashServer[]; active_slot: string | null; certificate: DashCert | null;
  deploying_slot: string | null; failed_slot: string | null;
}
```

`DashEnvironment` adds `/** The production card (always first). */ production: boolean; flow: DashFlow;`; `DashboardData.infrastructure` adds `accounts?: { key: string; label: string; error: string | null }[]`.

Add to `MESSAGES`, after `slot_not_deployed`:

```ts
  not_digitalocean_environment: "This environment isn't on DigitalOcean.",
  slot_invalid: "That isn't one of this environment's slots.",
  slot_required: 'Choose the slot to activate.',
  slot_already_active: 'That slot is already live.',
  production_retiring: 'This production environment is retiring: it can only be deactivated.',
  already_inactive: 'No slot is live.',
  auto_activate_not_allowed: 'Only non-production DigitalOcean environments activate automatically.',
  slots_full: 'This environment already has two slots.',
  slot_not_allowed: 'Production always has its Blue and Green slots.',
  do_shrink_refused: 'Sizes can only grow.',
```

- [ ] **Step 4: Labels**

In `sirdar/web/src/pages/environments/labels.tsx` (import `DeploymentSummary` too):

```ts
export const TYPE_LABEL: Record<string, string> = { dev: 'Dev', beta: 'Beta', custom: 'Custom', production: 'Production' };
```

`MODE_LABEL` gains `activate: 'Activate', renew: 'Renew certificate'`. Replace the mode lists:

```ts
/** Modes that replace data: they need deploy:change and the environment's name typed back
 *  (the API's GATED_MODES). A snapshot job is never retried. */
export const GATED_MODES = ['reset', 'restore_dump', 'rollback', 'teardown', 'vm_restore'];
/** Modes that need deploy:change (the API's CHANGE_MODES). */
export const CHANGE_MODES = [...GATED_MODES, 'activate'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback', 'publish', 'teardown', 'vm_restore',
  'activate', 'renew'];
/** Modes a DigitalOcean environment doesn't offer: both slots share the managed database. */
export const NOT_ON_DO = ['reset', 'restore_dump', 'rollback', 'vm_restore'];
```

and append:

```ts
/** Its hosts are droplets Sirdar builds in a DigitalOcean account. */
export const onDo = (env: Pick<Environment, 'target_kind'>) => env.target_kind === 'digitalocean';
export const isDoTarget = (id: string) => id === 'digitalocean';
export const slotTitle = (slot: string | null | undefined) => (slot ? slot[0].toUpperCase() + slot.slice(1) : '');
/** The slot an Update deploys to (the API's do_envs.target_slot). */
export const idleSlot = (env: Pick<Environment, 'slots' | 'active_slot'>): string =>
  env.active_slot === null || env.slots.length < 2 ? env.slots[0]
    : env.slots.find((s) => s !== env.active_slot) ?? env.slots[0];
/** Whether an Update of `slot` goes live by itself (the API's do_envs.goes_live). */
export const goesLive = (env: Pick<Environment, 'slots' | 'active_slot' | 'auto_activate' | 'type'>, slot: string) =>
  env.active_slot === null || env.slots.length === 1 || env.active_slot === slot
  || (env.auto_activate && env.type !== 'production');
/** Whole days until a certificate expires; null without one. */
export function certDaysLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.floor((at - now) / 86_400_000);
}
/** "Update to Purple, not live", "Activate Green", "Deactivate", else the mode's label. */
export function deploymentLabel(d: Pick<DeploymentSummary, 'mode' | 'cloud' | 'slot' | 'go_live'>): string {
  if (d.mode === 'activate') return d.slot ? `Activate ${slotTitle(d.slot)}` : 'Deactivate';
  if (d.cloud && d.mode === 'update' && d.slot) return `Update to ${slotTitle(d.slot)}${d.go_live ? '' : ', not live'}`;
  return MODE_LABEL[d.mode] ?? d.mode;
}
/** A retry needs the environment's name typed: the modes that replace data, and production's Activate. */
export const retryNeedsName = (mode: string, env: Pick<Environment, 'type'>) =>
  GATED_MODES.includes(mode) || (mode === 'activate' && env.type === 'production');
/** What Delete removes on DigitalOcean, by do_resources kind. */
export const DO_RESOURCE_LABEL: Record<string, string> = {
  vpc: 'VPC', droplet: 'Droplet', database: 'Database', spaces_key: 'Spaces key', bucket: 'Bucket',
  certificate: 'Certificate', load_balancer: 'Load balancer', firewall: 'Cloud firewall',
};
```

`envTargets` becomes `[...sshTargets(targets), ...targets.filter((t) => (isVmTarget(t.id) || isDoTarget(t.id)) && t.available && t.configured)]` (docstring: "…then the VM hosts and DigitalOcean once set up").

- [ ] **Step 5: Fixtures**

In `sirdar/web/src/pages/environments/testData.ts` (import `DoAccount`, `EnvDoSlot` types):
- `ADOPTED` and the `deployment()` builder (before `...extra`) gain `cloud: false, slot: null, go_live: false`; `summary()` copies `cloud`, `slot`, `go_live`.
- `ENV` gains `slots: [], active_slot: null, auto_activate: false, retiring: false, do: null` (every fixture spread from it inherits them; fix any other `Environment` literal the compiler flags the same way).
- `DEFAULTS` gains `do: DO_DEFAULTS` (declare `DO_DEFAULTS` above `DEFAULTS`).
- Append:

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
export const DO_ACCOUNTS_BOTH: DoAccount[] = [
  DO_ACCOUNTS[0],
  { ...DO_ACCOUNTS[1], region: 'nyc3', configured: true, token_set: true, source: 'stored', renewal_token_set: true,
    team_name: 'Encon Development', environments: ['uat9'], updated_at: '2026-10-05T12:00:00Z',
    updated_by_name: 'Jimmy Henderson' },
];
const doSlot = (slot: string, active: boolean, sha: string | null, n: number): EnvDoSlot => ({
  slot, droplet_id: String(4000 + n), public_ip: `203.0.113.${10 + n}`, private_ip: `10.116.0.${1 + n}`, sha,
  image_tag: sha ? sha.slice(0, 8) : null, active, last_check_ok: sha ? true : null,
  last_check_at: sha ? '2026-10-05T12:00:00Z' : null,
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
    slots: [doSlot('orange', true, SHA, 1), doSlot('purple', false, NEW_SHA, 2)],
    resources: [
      { kind: 'vpc', name: 'ss-uat9', slot: null }, { kind: 'droplet', name: 'ss-uat9-orange', slot: 'orange' },
      { kind: 'droplet', name: 'ss-uat9-purple', slot: 'purple' }, { kind: 'database', name: 'ss-uat9-db', slot: null },
      { kind: 'load_balancer', name: 'ss-uat9-lb', slot: null },
    ],
  },
};
export const ONE_SLOT_ENV: Environment = {
  ...DO_ENV, id: 'e10', name: 'solo', slots: ['orange'],
  do: { ...DO_ENV.do!, slots: [doSlot('orange', true, SHA, 1)] },
};
export const PROD_ENV: Environment = {
  ...DO_ENV, id: 'p1', name: 'prod', type: 'production', base_domain: 'serversherpa.com',
  slots: ['blue', 'green'], active_slot: 'blue',
  do: { ...DO_ENV.do!, account: 'production', account_label: 'Production', acme_staging: false,
        slots: [doSlot('blue', true, SHA, 1), doSlot('green', false, NEW_SHA, 2)] },
};
export const DO_TARGETS = {
  ...TARGETS,
  targets: [...TARGETS.targets,
            { id: 'digitalocean', label: 'DigitalOcean', kind: 'digitalocean', available: true, configured: true }] as DeployTarget[],
};
/** A DigitalOcean Update that deployed to purple and left traffic on orange. */
export const DO_UPDATE: DeploymentSummary = {
  ...summary(SUCCEEDED), id: 'd9', cloud: true, slot: 'purple', go_live: false,
};
```

  (`summary` and `SUCCEEDED` are declared above; keep `DO_UPDATE` after them.)

In `sirdar/web/src/pages/dashboard/testData.ts` (import `DashFlow`): add

```ts
/** A card with nothing built (placeholders, and every card until Task 10's fixtures). */
export const NONE_FLOW: DashFlow = {
  kind: 'none', middle: { label: 'Not built yet', sub: '', status: 'unknown' },
  servers: [{ id: 'none', label: 'Server', sub: 'Not built yet', state: 'empty', health: 'unknown', version: null,
              deployed: false }],
  active_slot: null, certificate: null, deploying_slot: null, failed_slot: null,
};
```

and `production: false, flow: NONE_FLOW` on every card in `DEMO`, `EMPTY` and `REAL`.

- [ ] **Step 6: Styles**

In `sirdar/web/src/styles/sirdar.css`, replace the two lines `.modal-card.reports-modal-card.rgm-card.sirdar-do-card { … }` and `.sirdar-do-form { … }` with:

```css
/* ---- DigitalOcean environments (phase 7b) ---- */
.modal-card.reports-modal-card.rgm-card.sirdar-doacct-card { width: min(640px, 96vw); max-width: 96vw; }
.sirdar-doacct-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sirdar-doacct-form .sirdar-span2 { grid-column: 1 / -1; }
.modal-card.reports-modal-card.rgm-card.sirdar-activate-card { width: min(520px, 96vw); max-width: 96vw; }
.sirdar-docloud-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 18px; }
.sirdar-docloud-form .sirdar-span2 { grid-column: 1 / -1; }
.sirdar-switch-row { display: flex; align-items: center; gap: 10px; }
@media (max-width: 640px) {
  .sirdar-doacct-form, .sirdar-docloud-form { grid-template-columns: minmax(0, 1fr); }
}
```

- [ ] **Step 7: Run the tests and the type-check**

Run: `npm --prefix sirdar/web test -- src/lib src/pages/environments/labels.test.ts && npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS and a clean build (fix any fixture the compiler flags for the new required fields; no component changes in this task).

- [ ] **Step 8: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts sirdar/web/src/pages/environments/labels.tsx sirdar/web/src/pages/environments/labels.test.ts sirdar/web/src/pages/environments/testData.ts sirdar/web/src/pages/dashboard/testData.ts sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): DigitalOcean types, calls, copy, labels, fixtures and styles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The two DigitalOcean accounts in Settings › Integrations, and the Deploy page's account choice

**Files:**
- Create: `sirdar/web/src/pages/settings/DoAccountModal.tsx`, `sirdar/web/src/pages/settings/DoAccountModal.test.tsx`
- Modify: `sirdar/web/src/pages/settings/IntegrationsSection.tsx`, `IntegrationsSection.test.tsx`
- Delete: `sirdar/web/src/pages/settings/DigitalOceanModal.tsx`, `DigitalOceanModal.test.tsx` (the accounts replace them; the API's `/integrations/digitalocean` alias stays)
- Modify: `sirdar/web/src/pages/Deploy.tsx`, `sirdar/web/src/pages/Deploy.test.tsx`

**Interfaces:**
- Consumes (Task 6): `getDoAccounts`, `saveDoAccount`, `testDoAccount`, `clearDoAccount`, `getDoRegions(account)`, `connectDeploy(..., account)`, `DoAccount`, `DoAccountBody`, `DO_ACCOUNTS`, `DO_ACCOUNTS_BOTH`, `.sirdar-doacct-card`, `.sirdar-doacct-form`; existing `SecretField` (`id, label, isSet, adding, action, value, error, clearable, onAction, onValue`), `CheckList` (`label`, `checks`), `Breakable`, `ComboBox`, `arrowNav`.
- Produces: `<DoAccountModal account={DoAccount} onSaved={(accounts: DoAccount[]) => void} onClose={() => void} />`; Settings shows one card per account ("DigitalOcean · Production", "DigitalOcean · Development") in place of the old DigitalOcean card; the Deploy page's DigitalOcean target has an Account choice (segmented, configured accounts only, Production first) that picks the regions and the account the connection test reads.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/settings/DoAccountModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  const onClose = vi.fn();
  render(<DoAccountModal account={DO_ACCOUNTS.find((a) => a.key === key)!} onSaved={onSaved} onClose={onClose} />);
  return { onSaved, onClose, dialog: screen.getByRole('dialog', { name: /DigitalOcean/ }) };
}

it('has the report-generate header and two write-only tokens', () => {
  const { dialog } = show();
  expect(within(dialog).getByText('Integrations', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'DigitalOcean · Development' })).toBeTruthy();
  expect(within(dialog).getByText(/Custom Scopes/)).toBeTruthy();
  expect((within(dialog).getByLabelText('API token') as HTMLInputElement).type).toBe('password');
  expect((within(dialog).getByLabelText('Renewal token') as HTMLInputElement).type).toBe('password');
});

it('sets up an account: label, region and both tokens; no token reaches the page', async () => {
  const { onSaved, dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.type(within(dialog).getByLabelText('Renewal token'), RENEW);
  await userEvent.type(within(dialog).getByLabelText('Region'), 'nyc3');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(api.saveDoAccount).toHaveBeenCalledWith('development', {
    label: 'Development', region: 'nyc3', token: TOKEN, renewal_token: RENEW });
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(DO_ACCOUNTS));
  expect(document.body.textContent).not.toContain(TOKEN);
});

it('keeps the stored tokens and offers the account\'s regions', async () => {
  const { dialog } = show('production');
  await waitFor(() => expect(api.getDoRegions).toHaveBeenCalledWith('production'));
  expect(within(dialog).getByRole('combobox', { name: 'Region' })).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(api.saveDoAccount).toHaveBeenCalledWith('production', { label: 'Production', region: 'nyc3' });
});

it('checks the token shape before sending', async () => {
  const { dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('API token'), 'dop_v1_short');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText("That doesn't look like a DigitalOcean API token.")).toBeTruthy();
  expect(api.saveDoAccount).not.toHaveBeenCalled();
});

it('Test shows the checks without saving', async () => {
  const { dialog } = show('production');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(await within(dialog).findByText('Certificates and load balancers only')).toBeTruthy();
  expect(api.testDoAccount).toHaveBeenCalledWith('production', { label: 'Production', region: 'nyc3' });
  expect(api.saveDoAccount).not.toHaveBeenCalled();
});

it("shows the API's reason for a token from another team", async () => {
  api.saveDoAccount.mockRejectedValue(new ApiError(409, 'do_team_changed', { code: 'do_team_changed', environments: ['prod'] }));
  const { dialog } = show('production');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Replace API token' }));
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText(/different DigitalOcean team/)).toBeTruthy();
});
```

(Check `SecretField`'s Replace button name — it renders "Replace" next to "API token: set"; match the accessible name it actually has, e.g. `getByRole('button', { name: /Replace/ })` scoped to the token's row.)

In `sirdar/web/src/pages/settings/IntegrationsSection.test.tsx`: add `getDoAccounts: vi.fn(), clearDoAccount: vi.fn(), testDoAccount: vi.fn()` to `api`; in `beforeEach`, `api.getDoAccounts.mockResolvedValue({ accounts: DO_ACCOUNTS }); api.clearDoAccount.mockResolvedValue(undefined); api.testDoAccount.mockResolvedValue(CF_CHECK);` (import `DO_ACCOUNTS`, `DO_ACCOUNTS_BOTH`). Delete the four DigitalOcean tests (from "shows the DigitalOcean card in the main grid" to "removing the stored DigitalOcean token…") and add:

```tsx
it('shows both DigitalOcean accounts, never a token', async () => {
  render(<IntegrationsSection />);
  const prod = await screen.findByRole('group', { name: 'DigitalOcean · Production' });
  expect(within(prod).getByText('Configured')).toBeTruthy();
  expect(within(prod).getByText('nyc3')).toBeTruthy();
  expect(within(prod).getByText('Encon Production')).toBeTruthy();
  expect(within(prod).getByText('prod')).toBeTruthy();
  const dev = screen.getByRole('group', { name: 'DigitalOcean · Development' });
  expect(within(dev).getByText('Not set up')).toBeTruthy();
  await userEvent.click(within(dev).getByRole('button', { name: 'Set up DigitalOcean · Development' }));
  expect(screen.getByRole('dialog', { name: 'DigitalOcean · Development' })).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'DigitalOcean' })).toBeNull();      // the old single card is gone
});

it('an account with environments can\'t be removed', async () => {
  render(<IntegrationsSection />);
  const prod = await screen.findByRole('group', { name: 'DigitalOcean · Production' });
  const remove = within(prod).getByRole('button', { name: 'Remove DigitalOcean · Production' }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect(remove.title).toBe('Environments are built in this account. Delete them first.');
});

it('removing an account asks first, then clears its tokens', async () => {
  api.getDoAccounts.mockResolvedValue({ accounts: [DO_ACCOUNTS[0], { ...DO_ACCOUNTS_BOTH[1], environments: [] }] });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<IntegrationsSection />);
  const dev = await screen.findByRole('group', { name: 'DigitalOcean · Development' });
  await userEvent.click(within(dev).getByRole('button', { name: 'Remove DigitalOcean · Development' }));
  expect(confirm.mock.calls[0][0]).toBe(
    "Clear the Development account's tokens? Nothing changes in DigitalOcean itself.");
  await waitFor(() => expect(api.clearDoAccount).toHaveBeenCalledWith('development'));
});

it('Test on an account card lists the checks in the card', async () => {
  render(<IntegrationsSection />);
  const prod = await screen.findByRole('group', { name: 'DigitalOcean · Production' });
  await userEvent.click(within(prod).getByRole('button', { name: 'Test DigitalOcean · Production' }));
  expect(api.testDoAccount).toHaveBeenCalledWith('production');
  expect(await within(prod).findByText('serversherpa.com (zone-1)')).toBeTruthy();
});
```

In `sirdar/web/src/pages/Deploy.test.tsx`: add `getDoAccounts: vi.fn()` to `api` and `api.getDoAccounts.mockResolvedValue({ accounts: DO_ACCOUNTS_BOTH })` to `beforeEach` (import from `./environments/testData`). In the two existing DigitalOcean tests the expected calls gain the account: `getDoRegions` is called with `'production'`, and `connectDeploy` with `('digitalocean', 'dev', 'sfo3', undefined, 'production')` / `('digitalocean', 'dev', 'nyc3', undefined, 'production')`. Add:

```tsx
it('DigitalOcean: the account choice picks its regions and the account the test reads', async () => {
  api.getDoRegions.mockResolvedValue(REGIONS);
  api.connectDeploy.mockResolvedValue(DO_OK);
  await pickDo();
  const accounts = await screen.findByRole('radiogroup', { name: 'Account' });
  expect(within(accounts).getByRole('radio', { name: 'Production' }).getAttribute('aria-checked')).toBe('true');
  await userEvent.click(within(accounts).getByRole('radio', { name: 'Development' }));
  await waitFor(() => expect(api.getDoRegions).toHaveBeenLastCalledWith('development'));
  await screen.findByRole('combobox', { name: 'Region' });
  await userEvent.click(screen.getByRole('radio', { name: /^Dev\b/ }));
  await userEvent.click(testBtn());
  expect(api.connectDeploy).toHaveBeenLastCalledWith('digitalocean', 'dev', 'nyc3', undefined, 'development');
});

it("DigitalOcean: an account that isn't set up can't be chosen", async () => {
  api.getDoAccounts.mockResolvedValue({ accounts: DO_ACCOUNTS });
  api.getDoRegions.mockResolvedValue(REGIONS);
  await pickDo();
  const accounts = await screen.findByRole('radiogroup', { name: 'Account' });
  expect((within(accounts).getByRole('radio', { name: 'Development' }) as HTMLButtonElement).disabled).toBe(true);
});
```

(`pickDo`, `testBtn`, `REGIONS` and `DO_OK` already exist in that file; import `within` from Testing Library if it isn't yet. The account radios are named "Development"/"Production", so the existing tests' type selector `/^Dev/` would match two radios: change it to `/^Dev\b/` everywhere in the file.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/settings src/pages/Deploy.test.tsx`
Expected: FAIL.

- [ ] **Step 3: `DoAccountModal`**

Create `sirdar/web/src/pages/settings/DoAccountModal.tsx`:

```tsx
/** One DigitalOcean account (Production or Development): its label, default
 *  region, API token and the renewal token droplets renew their certificate
 *  with. Tokens are write-only: kept unless replaced, never shown. Test tries
 *  the form's values without saving. */
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

  // A configured account can list its regions; before that the slug is typed.
  useEffect(() => {
    if (!account.configured) return undefined;
    let live = true;
    getDoRegions(account.key)
      .then((r) => { if (live) setRegions(r.regions.map((x) => ({ value: x.slug, label: `${x.name} (${x.slug})` }))); })
      .catch(() => { if (live) setRegions([]); });
    return () => { live = false; };
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
    if (region && !REGION_RE.test(region)) e.region = "That isn't a DigitalOcean region slug, like nyc3.";
    if (tokenAction === 'set' && !tokenOk(token)) {
      e.token = token ? "That doesn't look like a DigitalOcean API token." : 'Enter the API token.';
    }
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
    busyRef.current = what;
    setBusy(what);
    setResult(null);
    try {
      if (what === 'test') setResult(await testDoAccount(account.key, body()));
      else onSaved((await saveDoAccount(account.key, body())).accounts);
    } catch (err) {
      setErrors({ form: deployErrorText(err, what === 'test' ? "Couldn't test this account." : "Couldn't save this account.") });
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  };

  const name = `DigitalOcean · ${account.label}`;
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={cardRef} className="modal-card reports-modal-card rgm-card sirdar-doacct-card" role="dialog"
           aria-modal="true" aria-labelledby="sirdar-doacct-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-doacct-title">{name}</h3>
            <p className="page-hint">
              Sirdar builds environments in this account with its API token. Droplets get only the renewal token: make it
              in the control panel under API › Generate New Token › Custom Scopes, with certificate (create, read, delete)
              and load_balancer (read, update).
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-doacct-form">
          <div>
            <label className="field-label" htmlFor="doacct-label">Label</label>
            <input id="doacct-label" value={label} maxLength={40} aria-invalid={!!errors.label}
                   onChange={(e) => setLabel(e.target.value)} />
            {errors.label && <p className="form-error" role="alert">{errors.label}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="doacct-region">Region</label>
            {regions.length ? (
              <ComboBox inputId="doacct-region" ariaLabel="Region" portal value={region} options={regions}
                        onChange={setRegion} placeholder="Choose a region…" />
            ) : (
              <input id="doacct-region" value={region} placeholder="nyc3" aria-invalid={!!errors.region}
                     onChange={(e) => setRegion(e.target.value.trim().toLowerCase())} />
            )}
            <p className="page-hint">New environments in this account are built here.</p>
            {errors.region && <p className="form-error" role="alert">{errors.region}</p>}
          </div>
          <div className="sirdar-span2">
            <SecretField id="doacct-token" label="API token" isSet={account.token_set} adding={!account.token_set}
                         action={tokenAction} value={token} error={errors.token} clearable={false}
                         onAction={(a) => { setTokenAction(a); setToken(''); }} onValue={setToken} />
          </div>
          <div className="sirdar-span2">
            <SecretField id="doacct-renewal" label="Renewal token" isSet={account.renewal_token_set}
                         adding={!account.renewal_token_set} action={renewAction} value={renewal}
                         error={errors.renewal} clearable={false}
                         onAction={(a) => { setRenewAction(a); setRenewal(''); }} onValue={setRenewal} />
          </div>
          {result && <div className="sirdar-span2"><CheckList label={`${name} test`} checks={result.checks} /></div>}
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

Check `CheckList`'s props in `components/CheckList.tsx` and `SecretField`'s label wiring (so `getByLabelText('API token')` reaches the input in both the adding and the replacing state) and adjust only the call sites if they differ.

- [ ] **Step 4: The account cards**

In `sirdar/web/src/pages/settings/IntegrationsSection.tsx`:
- `KINDS` becomes `['cloudflare', 'npm', 'esxi']`; drop `DigitalOceanModal`, the DigitalOcean entries of the hint map, and the `digitalocean` branches of `stored`, `settingsOf` and `remove` (and the `editing === 'digitalocean'` modal).
- Load `getDoAccounts()` alongside `getIntegrations()` into `accounts: DoAccount[] | null` (a failure leaves the account cards out and shows the error the section already shows).
- After `{KINDS.map(card)}`, inside the same `.sirdar-cards.sirdar-integration-cards` grid, render `{accounts?.map(accountCard)}`:

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
          {a.key === 'production' ? 'Production environments are built here.' : 'Development, UAT and test environments.'}
        </p>
        <dl className="sirdar-kv">
          {rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd><Breakable text={v} /></dd></Fragment>)}
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

  with state `busyAccount: DoAccountKey | ''`, `accountResults: Partial<Record<DoAccountKey, IntegrationCheck>>`, `accountProblems: Partial<Record<DoAccountKey, string>>`, `editingAccount: DoAccount | null`; `testAccount(a)` calls `testDoAccount(a.key)` (no body: the saved account); `clearAccount(a)` asks `window.confirm(\`Clear the ${a.label} account's tokens? Nothing changes in DigitalOcean itself.\`)` and then `clearDoAccount(a.key)` and reloads the accounts; errors go through `deployErrorText`. Render `<DoAccountModal account={editingAccount} onSaved={(next) => { setAccounts(next); setEditingAccount(null); }} onClose={() => setEditingAccount(null)} />` while `editingAccount` is set (a sibling of the other integration modals). The section's hint: "…DigitalOcean environments are built in the Production or Development account; each has its own token and the renewal token its droplets use."
- `git rm` `DigitalOceanModal.tsx` and `DigitalOceanModal.test.tsx`.

- [ ] **Step 5: The Deploy page asks which account**

In `sirdar/web/src/pages/Deploy.tsx`:
- state `doAccounts: DoAccount[]` (from `getDoAccounts()` on load; failure → `[]`), `account: DoAccountKey` (initially `'production'`; once the accounts load, the first configured one, Production first), and `regionsBy: Partial<Record<DoAccountKey, DoRegions>>` replacing `doRegions` (each account's list fetched once and reused).
- `loadRegions` calls `getDoRegions(account)` and stores into `regionsBy[account]`; the effect keyed on `[doReady, account, regionsBy, loadRegions]` picks `regionsBy[account]?.default` (clearing `region` when the account changes).
- When `doReady`, above the Region field:

```tsx
            <div>
              <span className="field-label" id="do-account-label">Account</span>
              <div className="segmented" role="radiogroup" aria-labelledby="do-account-label">
                {doAccounts.map((a) => (
                  <button key={a.key} type="button" role="radio" aria-checked={account === a.key}
                          className={account === a.key ? 'on' : ''} tabIndex={account === a.key ? 0 : -1}
                          disabled={!a.configured} onKeyDown={arrowNav}
                          onClick={() => { if (a.key !== account) { setAccount(a.key); setRegion(''); clearOutcome(); } }}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
```

- `run` sends the account for DigitalOcean: `doReady ? await connectDeploy(target, type, sent, sentName, account) : …` (keep today's call shapes for SSH targets).
- The not-configured hint: replace `'Add the API token in Settings › Integrations › DigitalOcean, or '` with `'Set up a DigitalOcean account in Settings › Integrations, or '` (the env-key list after it stays).

- [ ] **Step 6: Run the tests and build**

Run: `npm --prefix sirdar/web test -- src/pages/settings src/pages/Deploy.test.tsx && npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS and a clean build.

- [ ] **Step 7: Commit**

```bash
git rm -q sirdar/web/src/pages/settings/DigitalOceanModal.tsx sirdar/web/src/pages/settings/DigitalOceanModal.test.tsx
git add sirdar/web/src/pages/settings/DoAccountModal.tsx sirdar/web/src/pages/settings/DoAccountModal.test.tsx sirdar/web/src/pages/settings/IntegrationsSection.tsx sirdar/web/src/pages/settings/IntegrationsSection.test.tsx sirdar/web/src/pages/Deploy.tsx sirdar/web/src/pages/Deploy.test.tsx
git commit -m "feat(sirdar-web): two DigitalOcean accounts in Settings and on the Deploy page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: New environment on DigitalOcean

**Files:**
- Modify: `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, `NewEnvironmentModal.test.tsx`

**Interfaces:**
- Consumes (Task 6): `envTargets` (lists DigitalOcean once configured), `isDoTarget`, `TYPE_LABEL.production`, `getDoAccounts`, `NewDo`, `DoAccount`, `EnvironmentDefaults.do`, fixtures `DO_TARGETS`, `DO_ACCOUNTS`, `DO_ACCOUNTS_BOTH`, `DO_ENV`, `DEFAULTS.do`, `.sirdar-docloud-form`; Task 1's `do.auto_activate` at create.
- Produces: with target DigitalOcean (mode New), the steps are Basics › DigitalOcean › Services › Data › Review; Type offers Production only there; Proxy IP and Bind IP aren't asked; the request carries `do: {account, slots?, droplet_size, db_size, db_standby, acme_staging?, auto_activate?}` and no `proxy_ip`, `bind_ip`, `publish` or `vm`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`: add `getDoAccounts: vi.fn()` to `api`, `api.getDoAccounts.mockResolvedValue({ accounts: DO_ACCOUNTS_BOTH })` to `beforeEach`, and import `DO_ACCOUNTS, DO_ACCOUNTS_BOTH, DO_ENV, DO_TARGETS` from `./testData`. Append:

```tsx
async function pickDigitalOcean() {
  await userEvent.click(screen.getByRole('combobox', { name: 'Target' }));
  await userEvent.click(await screen.findByRole('button', { name: 'DigitalOcean' }));
}
const radioIn = (group: string, name: string) =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });

it('DigitalOcean: a DigitalOcean step instead of the proxy, and the request carries do', async () => {
  api.getDeployTargets.mockResolvedValue(DO_TARGETS);
  api.createEnvironment.mockResolvedValue(DO_ENV);
  const { onCreated } = await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat9');
  await pickDigitalOcean();
  expect(screen.queryByLabelText('Proxy IP')).toBeNull();
  expect(screen.queryByLabelText('Bind IP')).toBeNull();
  expect(['Basics', 'DigitalOcean', 'Services', 'Data', 'Review']
    .every((s) => screen.getByText(s, { selector: '.rgm-step-label' }))).toBe(true);
  await next();
  await userEvent.click(radioIn('Account', 'Development'));
  await userEvent.click(radioIn('Slots', 'Two slots (orange + purple)'));
  await userEvent.click(radioIn('Certificate', "Let's Encrypt staging"));
  await userEvent.click(radioIn('Activate automatically', 'On'));
  await next();
  await next();
  await next();
  expect(screen.getByText('Development · nyc3')).toBeTruthy();
  expect(screen.getByText('Orange + Purple')).toBeTruthy();
  expect(screen.getByText('s-2vcpu-4gb · db-s-2vcpu-4gb')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(DO_ENV));
  const body = api.createEnvironment.mock.calls[0][0];
  expect(body).toMatchObject({
    name: 'uat9', type: 'dev', target: 'digitalocean',
    do: { account: 'development', slots: 2, droplet_size: 's-2vcpu-4gb', db_size: 'db-s-2vcpu-4gb',
          db_standby: false, acme_staging: true, auto_activate: true },
  });
  for (const key of ['proxy_ip', 'bind_ip', 'publish', 'vm']) expect(body).not.toHaveProperty(key);
});

it('DigitalOcean production: the Production account, Blue and Green, no staging or auto-activate', async () => {
  api.getDeployTargets.mockResolvedValue(DO_TARGETS);
  await open();
  expect(screen.queryByRole('radio', { name: 'Production' })).toBeNull();     // only on DigitalOcean
  await userEvent.type(screen.getByLabelText('Name'), 'prod');
  await pickDigitalOcean();
  await userEvent.click(radioIn('Type', 'Production'));
  await next();
  expect(radioIn('Account', 'Production').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText(/Blue and Green, always/)).toBeTruthy();
  expect(screen.queryByRole('radiogroup', { name: 'Slots' })).toBeNull();
  expect(screen.queryByRole('radiogroup', { name: 'Certificate' })).toBeNull();
  expect(screen.queryByRole('radiogroup', { name: 'Activate automatically' })).toBeNull();
});

it("DigitalOcean: an account that isn't set up can't be chosen", async () => {
  api.getDoAccounts.mockResolvedValue({ accounts: DO_ACCOUNTS });
  api.getDeployTargets.mockResolvedValue(DO_TARGETS);
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat9');
  await pickDigitalOcean();
  await next();
  expect((radioIn('Account', 'Development') as HTMLButtonElement).disabled).toBe(true);
  expect(radioIn('Account', 'Production').getAttribute('aria-checked')).toBe('true');
});

it('DigitalOcean: a base domain outside the Cloudflare zone goes back to Basics', async () => {
  api.getDeployTargets.mockResolvedValue(DO_TARGETS);
  api.createEnvironment.mockRejectedValue(new ApiError(422, 'base_domain_not_in_zone', { code: 'base_domain_not_in_zone' }));
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat9');
  await pickDigitalOcean();
  await next();
  await next();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText("That base domain isn't in the Cloudflare zone Sirdar manages.")).toBeTruthy();
  expect(screen.getByLabelText('Base domain')).toBeTruthy();
});
```

(The Type group is labelled by its `span#env-type-label` "Type"; if `getByRole('radiogroup', { name: 'Type' })` doesn't resolve, add `aria-labelledby` exactly as the existing groups do.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: The DigitalOcean step**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`:

1. Types and tables: `type Step` adds `'cloud'`; `type Field` adds `'cloud'`; add

```ts
const DO_STEPS: [Step, string][] = [
  ['basics', 'Basics'], ['cloud', 'DigitalOcean'], ['services', 'Services'], ['data', 'Data'], ['review', 'Review'],
];
type SlotChoice = '1' | '2';
const SLOT_CHOICES: [SlotChoice, string][] = [['1', 'One droplet'], ['2', 'Two slots (orange + purple)']];
const ON_OFF: ['on' | 'off', string][] = [['on', 'On'], ['off', 'Off']];
const CERT_CHOICES: ['production' | 'staging', string][] = [['production', "Let's Encrypt"], ['staging', "Let's Encrypt staging"]];
const DROPLET_SIZE_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const DB_SIZE_RE = /^db-[a-z0-9][a-z0-9-]{2,36}$/;
```

   and `CODE_FIELD` gains `do_account_not_configured: 'cloud', do_invalid: 'cloud', do_slots_invalid: 'cloud', do_size_invalid: 'cloud', do_db_size_invalid: 'cloud', auto_activate_not_allowed: 'cloud', production_exists: 'name', production_requires_digitalocean: 'target', base_domain_not_in_zone: 'domain'`.
2. State: `accounts: DoAccount[]` (from `getDoAccounts()` when the modal opens; a failure leaves `[]`), `doAccount: DoAccountKey` (`'development'`), `slotChoice: SlotChoice` (`'1'`), `dropletSize`, `dbSize` (`''` until the defaults load, then `defaults.do.droplet_size` / `db_size`), `dbStandby: 'on' | 'off'` (`'off'`), `certChoice` (`'production'`), `autoActivate: 'on' | 'off'` (`'off'`).
3. Derived: `const onDo = mode === 'new' && isDoTarget(target);`, `const production = type === 'production';`, `const accountOf = (k: DoAccountKey) => accounts.find((a) => a.key === k);`. Effects: switching the type to Production picks `setDoAccount('production')`; leaving DigitalOcean while the type is Production sets the type back to `'dev'`; once the accounts load, if the chosen account isn't configured, pick the first configured one.
4. Basics: the type radios are `(onDo ? [...TYPES, 'production'] : TYPES)`; the Proxy IP and Bind IP fields render only when `!onDo`; under Target, when `onDo`: `<p className="page-hint">Sirdar builds a load balancer, droplets, a managed database and a Spaces bucket in a DigitalOcean account on the first deploy.</p>`; under Base domain, when `onDo`, the hint reads "Leave empty for {effectiveDomain}. It must be in the Cloudflare zone; DNS points at the load balancer." `basicsErrors` checks `proxy` and `bind` only when `mode === 'new' && !onDo`.
5. Steps: `const stepList = onDo ? DO_STEPS : onVm ? VM_STEPS : STEPS[mode];` `next()` goes basics → (onDo ? 'cloud' : onVm ? 'machine' : 'services'), cloud → services, and checks `cloudErrors()` on the cloud step; `back()` from services goes to `onDo ? 'cloud' : onVm ? 'machine' : 'basics'`; `fail()` sends `'cloud'` to that step like `'machine'`.
6. `cloudErrors()`:

```ts
  const cloudErrors = (): Errors => {
    const a = accountOf(doAccount);
    if (!a || !a.configured || !a.region) {
      return { cloud: `Set up the ${a?.label ?? 'DigitalOcean'} account (token and region) in Settings › Integrations first.` };
    }
    if (!DROPLET_SIZE_RE.test(dropletSize) || dropletSize.startsWith('db-')) return { cloud: "That isn't a DigitalOcean droplet size." };
    if (!DB_SIZE_RE.test(dbSize)) return { cloud: "That isn't a DigitalOcean database size." };
    return {};
  };
```

7. The step body:

```tsx
            {defaults && step === 'cloud' && (
              <div className="sirdar-docloud-form">
                <div className="sirdar-span2">
                  <span className="field-label" id="env-do-account-label">Account</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-do-account-label">
                    {accounts.map((a) => (
                      <button key={a.key} type="button" role="radio" aria-checked={doAccount === a.key}
                              className={doAccount === a.key ? 'on' : ''} tabIndex={doAccount === a.key ? 0 : -1}
                              disabled={!a.configured} onKeyDown={arrowNav}
                              onClick={() => { setDoAccount(a.key); setErrors({}); }}>{a.label}</button>
                    ))}
                  </div>
                  <p className="page-hint">
                    {accountOf(doAccount)?.region ? `Built in ${accountOf(doAccount)!.region}. ` : ''}
                    An environment stays in the account it is built in.
                  </p>
                </div>
                {production ? (
                  <p className="page-hint sirdar-span2">
                    Blue and Green, always. Each deploy goes to the idle slot; Activate moves traffic to it.
                  </p>
                ) : (
                  <div className="sirdar-span2">
                    <span className="field-label" id="env-do-slots-label">Slots</span>
                    <div className="segmented" role="radiogroup" aria-labelledby="env-do-slots-label">
                      {radios(SLOT_CHOICES, slotChoice, setSlotChoice)}
                    </div>
                    <p className="page-hint">
                      {slotChoice === '1'
                        ? 'One droplet: each deploy updates it in place. A second slot can be added later in Settings.'
                        : 'Each deploy goes to the idle slot; traffic moves when you activate it (or by itself, below).'}
                    </p>
                  </div>
                )}
                <div>
                  <label className="field-label" htmlFor="env-do-droplet">Droplet size</label>
                  <input id="env-do-droplet" type="text" value={dropletSize} spellCheck={false} autoComplete="off"
                         onChange={(e) => setDropletSize(e.target.value.trim())} />
                  <p className="page-hint">Default: V2 production, 2 vCPU · 4 GB · 80 GB. Sizes only grow later.</p>
                </div>
                <div>
                  <label className="field-label" htmlFor="env-do-db">Database size</label>
                  <input id="env-do-db" type="text" value={dbSize} spellCheck={false} autoComplete="off"
                         onChange={(e) => setDbSize(e.target.value.trim())} />
                  <p className="page-hint">Managed PostgreSQL 16; default 2 vCPU · 4 GB · 60 GB.</p>
                </div>
                <div>
                  <span className="field-label" id="env-do-standby-label">Standby node</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-do-standby-label">
                    {radios(ON_OFF, dbStandby, setDbStandby)}
                  </div>
                </div>
                {!production && (
                  <div>
                    <span className="field-label" id="env-do-cert-label">Certificate</span>
                    <div className="segmented" role="radiogroup" aria-labelledby="env-do-cert-label">
                      {radios(CERT_CHOICES, certChoice, setCertChoice)}
                    </div>
                    <p className="page-hint">Staging certificates aren't trusted by browsers: for test environments.</p>
                  </div>
                )}
                {!production && slotChoice === '2' && (
                  <div className="sirdar-span2">
                    <span className="field-label" id="env-do-auto-label">Activate automatically</span>
                    <div className="segmented" role="radiogroup" aria-labelledby="env-do-auto-label">
                      {radios(ON_OFF, autoActivate, setAutoActivate)}
                    </div>
                    <p className="page-hint">On: a deploy whose smoke test passes takes traffic by itself.</p>
                  </div>
                )}
                {errors.cloud && <p className="form-error sirdar-span2" role="alert">{errors.cloud}</p>}
              </div>
            )}
```

8. `submit()` builds the DigitalOcean body without `proxy_ip`, `bind_ip`, `publish` or `vm`:

```ts
    const common = {
      name: trimmed, type, target, git_ref: ref.trim(),
      ...(domain.trim() ? { base_domain: domain.trim() } : {}),
      ports: Object.fromEntries(services.map((s) => [s.service, Number(ports[s.service])])),
      ...(chosen ? { snapshot_id: chosen.id } : {}),
    };
    if (onDo) {
      const two = !production && slotChoice === '2';
      void run({ mode, body: { ...common, do: {
        account: doAccount, ...(production ? {} : { slots: two ? 2 : 1 }),
        droplet_size: dropletSize, db_size: dbSize, db_standby: dbStandby === 'on',
        ...(production ? {} : { acme_staging: certChoice === 'staging' }),
        ...(two ? { auto_activate: autoActivate === 'on' } : {}),
      } } });
      return;
    }
    void run({ mode, body: { ...common, proxy_ip: proxy.trim(), bind_ip: bind.trim(), publish: publish === 'on',
      ...(onVm ? { vm: {
        cores: machine.cores, memory_mb: machine.memory_mb, disk_gb: machine.disk_gb, ip_mode: ipMode,
        ...(ipMode === 'static' ? { ip_cidr: ipCidr.trim(), gateway: gateway.trim() } : {}),
      } } : {}) } });
```

9. Review, when `onDo`, lists (in the existing review `dl`) Account `{label} · {region}`, Slots (`Blue + Green`, `Orange`, or `Orange + Purple`), Sizes `{droplet} · {db}{standby ? ' · standby node' : ''}`, Certificate (`Let's Encrypt` or `Let's Encrypt staging`), and for two slots Activates (`Automatically` / `With Activate`); it leaves out the proxy, bind and Publish rows (a DigitalOcean environment always publishes its DNS records itself).

- [ ] **Step 4: Run the tests and build**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx && npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS (the existing SSH, Proxmox and ESXi tests unchanged) and a clean build.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/NewEnvironmentModal.tsx sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx
git commit -m "feat(sirdar-web): New environment on DigitalOcean — account, slots, sizes, certificate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The environment pages — Overview, Activate, Settings, Delete, Deploy, Deployments, Backups

**Files:**
- Create: `sirdar/web/src/components/ActivateModal.tsx`, `ActivateModal.test.tsx`
- Create: `sirdar/web/src/pages/environments/DoMachineSection.tsx`, `DoMachineSection.test.tsx`, `DoSettingsSection.tsx`, `DoSettingsSection.test.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvOverview.tsx`, `EnvironmentDetail.tsx` (+ test), `EnvSettings.tsx` (+ test), `DeleteEnvironmentModal.tsx` (+ test), `DeployModal.tsx` (+ test), `DeploymentView.tsx` (+ test), `DeploymentsTab.tsx` (+ test), `BackupsTab.tsx` (+ test)

**Interfaces:**
- Consumes (Task 6): `activateSlot`, `addSlot`, `updateEnvironment`, `startDeployment`, `retryDeployment`, `onDo`, `idleSlot`, `goesLive`, `slotTitle`, `certDaysLeft`, `deploymentLabel`, `retryNeedsName`, `CHANGE_MODES`, `DO_RESOURCE_LABEL`, fixtures `DO_ENV`, `ONE_SLOT_ENV`, `PROD_ENV`, `DO_UPDATE`, `.sirdar-activate-card`, `.sirdar-docloud-form`, `.sirdar-switch-row`; the API's 7a and Task 1–2 rules (production Delete: retiring → no active slot → `confirm_production` "delete production <name>" plus `confirm_name`; non-production `snapshot: false` to skip; Reset, Restore backup and Roll back refused).
- Produces:
  - `<ActivateModal envName production slot fromSlot version onStarted onClose />` (`slot === null`: Deactivate) — used here and by the spotlight (Task 10).
  - `<DoMachineSection env canActivate onActivate={(slot: string | null) => void} />` on Overview.
  - `<DoSettingsSection env disabled onSaved onDeployStarted />` in Settings.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/components/ActivateModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ activateSlot: vi.fn() }));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { RUNNING } from '../pages/environments/testData';

import ActivateModal from './ActivateModal';

beforeEach(() => { api.activateSlot.mockReset(); api.activateSlot.mockResolvedValue(RUNNING); });
afterEach(cleanup);

function show(props: Partial<Parameters<typeof ActivateModal>[0]> = {}) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<ActivateModal envName="uat9" production={false} slot="purple" fromSlot="orange" version="f00dbabe"
                        onStarted={onStarted} onClose={onClose} {...props} />);
  return { onStarted, onClose, dialog: screen.getByRole('dialog') };
}

it('activates a slot: report-generate header, what happens, then the deployment', async () => {
  const { onStarted, dialog } = show();
  expect(within(dialog).getByText('Blue/Green', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'Activate Purple' })).toBeTruthy();
  expect(within(dialog).getByText(/smoke-tests Purple \(f00dbabe\)/)).toBeTruthy();
  expect(within(dialog).getByText(/Orange keeps running/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  expect(api.activateSlot).toHaveBeenCalledWith('uat9', 'purple', undefined);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
});

it('production needs its name typed', async () => {
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

it("shows the API's copy and stays open", async () => {
  api.activateSlot.mockRejectedValue(new ApiError(409, 'slot_not_deployed', { code: 'slot_not_deployed', slot: 'purple' }));
  const { dialog, onStarted } = show();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  expect(await within(dialog).findByText('That slot has never run a deploy. Deploy to it first.')).toBeTruthy();
  expect(onStarted).not.toHaveBeenCalled();
});

it('Escape and Cancel close it', async () => {
  const { dialog, onClose } = show();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(2);
});
```

Create `sirdar/web/src/pages/environments/DoMachineSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import DoMachineSection from './DoMachineSection';
import { DO_ENV, ONE_SLOT_ENV, PROD_ENV } from './testData';

afterEach(cleanup);

it('shows the account, load balancer, certificate, database and slots, with Activate on the idle one', async () => {
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

it('warns when the certificate has 14 days or fewer, and hides Activate without the permission', () => {
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
  render(<DoMachineSection env={{ ...PROD_ENV, do: { ...PROD_ENV.do!, cert_not_after: soon } }}
                           canActivate={false} onActivate={vi.fn()} />);
  expect(screen.getByText('Renews soon')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
});

it('a retiring production offers Deactivate, not Activate', async () => {
  const onActivate = vi.fn();
  render(<DoMachineSection env={{ ...PROD_ENV, retiring: true }} canActivate onActivate={onActivate} />);
  expect(screen.queryByRole('button', { name: 'Activate Green' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
  expect(onActivate).toHaveBeenCalledWith(null);
});

it('one slot: no Activate, and the hint says it updates in place', () => {
  render(<DoMachineSection env={ONE_SLOT_ENV} canActivate onActivate={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
  expect(screen.getByText(/updates in place/)).toBeTruthy();
});
```

Create `sirdar/web/src/pages/environments/DoSettingsSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ updateEnvironment: vi.fn(), addSlot: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DoSettingsSection from './DoSettingsSection';
import { DO_ENV, ONE_SLOT_ENV, PROD_ENV, RUNNING } from './testData';

beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); });
afterEach(cleanup);

function show(env = DO_ENV) {
  const onSaved = vi.fn();
  const onDeployStarted = vi.fn();
  render(<DoSettingsSection env={env} disabled={false} onSaved={onSaved} onDeployStarted={onDeployStarted} />);
  return { onSaved, onDeployStarted, section: screen.getByRole('region', { name: 'DigitalOcean' }) };
}

it('turns on Activate automatically for a two-slot environment', async () => {
  api.updateEnvironment.mockResolvedValue({ ...DO_ENV, auto_activate: true });
  const { onSaved, section } = show();
  await userEvent.click(within(section).getByRole('checkbox', { name: 'Activate automatically' }));
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat9', { auto_activate: true });
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...DO_ENV, auto_activate: true }));
  expect(within(section).queryByRole('button', { name: 'Add a second slot' })).toBeNull();
});

it('adds the second slot and follows its deployment', async () => {
  const grown = { ...ONE_SLOT_ENV, slots: ['orange', 'purple'] };
  api.addSlot.mockResolvedValue({ environment: grown, deployment: RUNNING });
  const { onSaved, onDeployStarted, section } = show(ONE_SLOT_ENV);
  expect(within(section).queryByRole('checkbox', { name: 'Activate automatically' })).toBeNull();
  await userEvent.click(within(section).getByRole('button', { name: 'Add a second slot' }));
  expect(api.addSlot).toHaveBeenCalledWith('solo');
  await waitFor(() => expect(onDeployStarted).toHaveBeenCalledWith(RUNNING));
  expect(onSaved).toHaveBeenCalledWith(grown);
});

it('sizes only grow: Save sends only what changed', async () => {
  api.updateEnvironment.mockResolvedValue(DO_ENV);
  const { section } = show();
  expect(within(section).getByText(/Sizes only grow/)).toBeTruthy();
  const save = within(section).getByRole('button', { name: 'Save sizes' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const droplet = within(section).getByLabelText('Droplet size');
  await userEvent.clear(droplet);
  await userEvent.type(droplet, 's-4vcpu-8gb');
  await userEvent.click(save);
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat9', { do: { droplet_size: 's-4vcpu-8gb' } });
});

it("shows the API's copy for a refused size", async () => {
  api.updateEnvironment.mockRejectedValue(new ApiError(422, 'do_shrink_refused', { code: 'do_shrink_refused' }));
  const { section } = show();
  const db = within(section).getByLabelText('Database size');
  await userEvent.clear(db);
  await userEvent.type(db, 'db-s-1vcpu-1gb');
  await userEvent.click(within(section).getByRole('button', { name: 'Save sizes' }));
  expect(await within(section).findByText('Sizes can only grow.')).toBeTruthy();
});

it('production: no auto-activate or second slot; Mark retiring needs the name', async () => {
  api.updateEnvironment.mockResolvedValue({ ...PROD_ENV, retiring: true });
  const { section } = show(PROD_ENV);
  expect(within(section).queryByRole('checkbox', { name: 'Activate automatically' })).toBeNull();
  expect(within(section).queryByRole('button', { name: 'Add a second slot' })).toBeNull();
  const mark = within(section).getByRole('button', { name: 'Mark retiring' }) as HTMLButtonElement;
  expect(mark.disabled).toBe(true);
  await userEvent.type(within(section).getByLabelText('Type prod to confirm'), 'prod');
  await userEvent.click(mark);
  expect(api.updateEnvironment).toHaveBeenCalledWith('prod', { retiring: true, confirm_name: 'prod' });
});
```

Add to `DeleteEnvironmentModal.test.tsx` (import `DO_ENV`, `PROD_ENV`):

```tsx
it('DigitalOcean: lists what goes there and saves a snapshot first unless unticked', async () => {
  const { dialog } = show(DO_ENV);
  const removes = within(dialog).getByRole('list', { name: 'Sirdar removes' });
  expect(within(removes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(
    expect.arrayContaining(['VPC ss-uat9', 'Droplet ss-uat9-orange', 'Database ss-uat9-db', 'Load balancer ss-uat9-lb']));
  const snap = within(dialog).getByRole('checkbox', { name: 'Save a snapshot first' }) as HTMLInputElement;
  expect(snap.checked).toBe(true);
  await userEvent.click(snap);
  await userEvent.type(within(dialog).getByLabelText('Type uat9 to confirm'), 'uat9');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(api.startDeployment).toHaveBeenCalledWith('uat9', { mode: 'teardown', confirm_name: 'uat9', snapshot: false });
});

it('DigitalOcean: with the snapshot kept on, the default is sent', async () => {
  const { dialog } = show(DO_ENV);
  await userEvent.type(within(dialog).getByLabelText('Type uat9 to confirm'), 'uat9');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(api.startDeployment).toHaveBeenCalledWith('uat9', { mode: 'teardown', confirm_name: 'uat9' });
});

it('production: retiring first, then deactivated, then both phrases and always a snapshot', async () => {
  let dialog = show(PROD_ENV).dialog;
  expect(within(dialog).getByText('Mark this production environment retiring first (Settings).')).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  dialog = show({ ...PROD_ENV, retiring: true }).dialog;
  expect(within(dialog).getByText(/Deactivate it first/)).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  dialog = show({ ...PROD_ENV, retiring: true, active_slot: null }).dialog;
  expect(within(dialog).queryByRole('checkbox', { name: 'Save a snapshot first' })).toBeNull();
  expect(within(dialog).getByText(/A snapshot is always saved first/)).toBeTruthy();
  const del = within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement;
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  expect(del.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type delete production prod to confirm'), 'delete production prod');
  await userEvent.click(del);
  expect(api.startDeployment).toHaveBeenCalledWith('prod', {
    mode: 'teardown', confirm_name: 'prod', confirm_production: 'delete production prod' });
});
```

(`show` looks the dialog up by `Delete uat`; give it a `name` from `env.name`: `screen.getByRole('dialog', { name: \`Delete ${env.name}\` })`.)

Add to `DeployModal.test.tsx` (import `DO_ENV`, `ONE_SLOT_ENV`):

```tsx
it('DigitalOcean: Update only, to the idle slot; traffic stays until Activate', async () => {
  const { onStarted } = open(DO_ENV);
  expect(screen.queryByRole('radio', { name: 'Reset data' })).toBeNull();
  expect(screen.getByText('Deploys to Purple. Traffic stays on Orange until you activate Purple.')).toBeTruthy();
  expect(screen.getByText(/Migrations must work with the code still live on Orange/)).toBeTruthy();
  await userEvent.click(deployBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat9', { mode: 'update', git_ref: 'main' });
});

it('DigitalOcean: one slot, or auto-activate, goes live by itself', () => {
  open(ONE_SLOT_ENV);
  expect(screen.getByText('Deploys to Orange and goes live when its smoke test passes.')).toBeTruthy();
  cleanup();
  open({ ...DO_ENV, auto_activate: true });
  expect(screen.getByText('Deploys to Purple and goes live when its smoke test passes.')).toBeTruthy();
});
```

In `DeploymentView.test.tsx`: give `show` an `env` prop (default `ENV`) and add (import `DO_ENV`, `PROD_ENV`):

```tsx
it("retrying production's Activate needs its name; another environment's doesn't", async () => {
  api.getDeployment.mockResolvedValue({ ...FAILED, mode: 'activate', cloud: true, slot: 'green', go_live: true });
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd2' });
  show({ env: PROD_ENV });
  const btn = (await screen.findByRole('button', { name: 'Retry' })) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type prod to confirm'), 'prod');
  await user.click(btn);
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d1', { from_step: 5, confirm_name: 'prod' }));
  cleanup();
  show({ env: DO_ENV });
  await user.click(await screen.findByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.retryDeployment).toHaveBeenLastCalledWith('d1', { from_step: 5 }));
});

it("retrying production's Delete asks for both phrases again", async () => {
  api.getDeployment.mockResolvedValue({ ...FAILED, mode: 'teardown', cloud: true, slot: 'blue' });
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd2' });
  show({ env: { ...PROD_ENV, retiring: true, active_slot: null } });
  const btn = (await screen.findByRole('button', { name: 'Retry' })) as HTMLButtonElement;
  await user.type(screen.getByLabelText('Type prod to confirm'), 'prod');
  expect(btn.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type delete production prod to confirm'), 'delete production prod');
  await user.click(btn);
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d1', {
    from_step: 5, confirm_name: 'prod', confirm_production: 'delete production prod' }));
});

it('DigitalOcean offers no Roll back', async () => {
  api.getDeployment.mockResolvedValue({ ...ROLLBACKABLE, cloud: true, slot: 'purple' });
  show({ id: 'd4', env: DO_ENV });
  await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByText('Roll back', { selector: 'h3' })).toBeNull();
});
```

In `DeploymentsTab.test.tsx` (import `DO_ENV`, `DO_UPDATE`):

```tsx
it('names a DigitalOcean deployment by its slot', async () => {
  api.listDeployments.mockResolvedValue({ deployments: [DO_UPDATE] });
  render(<DeploymentsTab env={DO_ENV} selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText('Update to Purple, not live')).toBeTruthy();
});
```

In `BackupsTab.test.tsx` (import `DO_ENV`):

```tsx
it('DigitalOcean: backups are listed but not restored here', async () => {
  api.listBackups.mockResolvedValue({ backups: BACKUPS });
  render(<BackupsTab env={DO_ENV} onStarted={vi.fn()} />);
  await screen.findByText(BACKUPS[0].name);
  expect(screen.queryByRole('button', { name: /^Restore / })).toBeNull();
  expect(screen.getByText(/Restore backup isn't offered on DigitalOcean/)).toBeTruthy();
});
```

In `EnvironmentDetail.test.tsx`: add `activateSlot: vi.fn()` to `api`, and:

```tsx
it('DigitalOcean: Overview shows the slots; Activate opens its dialog, then follows the deployment', async () => {
  api.getEnvironment.mockResolvedValue(DO_ENV);
  api.activateSlot.mockResolvedValue(RUNNING);
  show('/deploy/environments/uat9');
  const section = await screen.findByRole('region', { name: 'DigitalOcean' });
  await userEvent.click(within(section).getByRole('button', { name: 'Activate Purple' }));
  const dialog = await screen.findByRole('dialog', { name: 'Activate Purple' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  await waitFor(() => expect(api.activateSlot).toHaveBeenCalledWith('uat9', 'purple', undefined));
  expect(await screen.findByRole('tab', { name: 'Deployments', selected: true })).toBeTruthy();
});
```

In `EnvSettings.test.tsx` (import `DO_ENV`):

```tsx
it("DigitalOcean: what Sirdar built can't change here; the DigitalOcean section can", () => {
  open(DO_ENV);
  for (const label of ['Target', 'Proxy IP', 'Bind IP', 'Base domain', 'Spaces bucket']) {
    expect(screen.queryByLabelText(label)).toBeNull();
  }
  expect(screen.getByRole('region', { name: 'DigitalOcean' })).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/components/ActivateModal.test.tsx src/pages/environments`
Expected: FAIL.

- [ ] **Step 3: `ActivateModal`**

Create `sirdar/web/src/components/ActivateModal.tsx`:

```tsx
/** Blue/Green: activate a slot (Sirdar smoke-tests it on its droplet, adds it
 *  to the load balancer next to the live one, checks it through the load
 *  balancer, then sends every request to it), or deactivate a retiring
 *  production. A deployment, so it shows up in Deployments and can be
 *  retried. Production needs its name typed. Used by the environment page
 *  and the dashboard spotlight. */
import { useEffect, useRef, useState } from 'react';

import { deployErrorText, activateSlot, type Deployment } from '../lib/sirdarApi';
import { slotTitle } from '../pages/environments/labels';

export default function ActivateModal({ envName, production, slot, fromSlot, version, onStarted, onClose }: {
  envName: string; production: boolean; slot: string | null; fromSlot: string | null; version: string | null;
  onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
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
      setError(deployErrorText(err, slot ? "Couldn't activate that slot." : "Couldn't deactivate it."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const from = fromSlot ? slotTitle(fromSlot) : null;
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busyRef.current) onClose(); }}>
      <div ref={cardRef} className="modal-card reports-modal-card rgm-card sirdar-activate-card" role="dialog"
           aria-modal="true" aria-labelledby="sirdar-activate-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Blue/Green</div>
            <h3 id="sirdar-activate-title">{title}</h3>
            <p className="page-hint">
              {slot
                ? `Sirdar smoke-tests ${slotTitle(slot)}${version ? ` (${version})` : ''} on its droplet, adds it to the `
                  + `load balancer${from ? ` next to ${from}` : ''}, checks it through the load balancer, then sends every `
                  + 'request to it. For a minute or two both answer.'
                  + (from ? ` ${from} keeps running: activate it again to switch back.` : '')
                : `The load balancer stops sending traffic to ${from ?? 'any slot'}. Do this only once another environment `
                  + "serves production's names; then Delete can remove it."}
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form">
          {production && (
            <div>
              <label className="field-label" htmlFor="sirdar-activate-confirm">Type {envName} to confirm</label>
              <input id="sirdar-activate-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                     spellCheck={false} disabled={busy} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={slot ? 'btn-solid' : 'btn-solid btn-danger'} disabled={busy || !ready}
                  onClick={() => void go()}>{busy ? 'Starting…' : title}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `DoMachineSection` on Overview**

Create `sirdar/web/src/pages/environments/DoMachineSection.tsx`:

```tsx
/** Overview of a DigitalOcean environment: where it runs, its load balancer,
 *  certificate, database and bucket, and its slots — Activate on a deployed
 *  idle slot, Deactivate on a retiring production. */
import DataTable from '@portal/components/DataTable';

import Breakable from '../../components/Breakable';
import type { Environment } from '../../lib/sirdarApi';

import { certDaysLeft, shortSha, slotTitle, when } from './labels';

export default function DoMachineSection({ env, canActivate, onActivate }: {
  env: Environment; canActivate: boolean; onActivate: (slot: string | null) => void;
}) {
  const d = env.do;
  if (!d) return null;
  const days = certDaysLeft(d.cert_not_after);
  const retiringProduction = env.type === 'production' && env.retiring;
  const cert = d.cert_not_after
    ? `${new Date(d.cert_not_after).toLocaleDateString()} (${Math.max(days ?? 0, 0)} days)`
      + (d.acme_staging ? " · Let's Encrypt staging" : '')
    : 'Issued by the first deploy';
  return (
    <section className="sirdar-section" aria-labelledby="sirdar-do-heading">
      <h2 id="sirdar-do-heading">DigitalOcean</h2>
      <dl className="sirdar-kv">
        <dt>Account</dt><dd>{d.account_label} · {d.region}</dd>
        <dt>Load balancer</dt><dd className="mono">{d.lb_ip ?? 'Built by the first deploy'}</dd>
        <dt>Certificate</dt>
        <dd>
          {cert}
          {days !== null && days < 0 && <> <span className="chip c-red">Expired</span></>}
          {days !== null && days >= 0 && days <= 14 && <> <span className="chip c-amber">Renews soon</span></>}
        </dd>
        <dt>Database</dt><dd className="mono"><Breakable text={d.db_host ?? '—'} /></dd>
        <dt>Sizes</dt><dd className="mono">{d.droplet_size} · {d.db_size}{d.db_standby ? ' · standby node' : ''}</dd>
        <dt>Bucket</dt><dd className="mono">{d.bucket ?? '—'}</dd>
      </dl>
      <DataTable
        ariaLabel="Slots"
        columns={[{ key: 'slot', label: 'Slot' }, { key: 'droplet', label: 'Droplet', mono: true },
                  { key: 'commit', label: 'Commit', mono: true }, { key: 'check', label: 'Last smoke test' },
                  { key: 'live', label: '', align: 'right' }]}
        rows={d.slots.map((s) => ({
          key: s.slot,
          cells: [
            <b className="cell-top">{slotTitle(s.slot)}</b>,
            s.public_ip ? `${s.droplet_id} · ${s.public_ip}` : 'Not built yet',
            shortSha(s.sha),
            s.last_check_ok === null ? '—' : `${s.last_check_ok ? 'Passed' : 'Failed'} · ${when(s.last_check_at)}`,
            s.active
              ? (canActivate && retiringProduction
                ? <button type="button" className="mini-btn danger" onClick={() => onActivate(null)}>Deactivate</button>
                : <span className="chip c-green">Live</span>)
              : canActivate && s.sha && env.slots.length > 1 && !retiringProduction
                ? <button type="button" className="mini-btn" aria-label={`Activate ${slotTitle(s.slot)}`}
                          onClick={() => onActivate(s.slot)}>Activate</button>
                : <span className="cell-sub">{s.sha ? 'Idle' : 'Not deployed'}</span>,
          ],
        }))}
      />
      <p className="page-hint">
        {env.slots.length === 1
          ? 'One slot: each deploy updates it in place. Add a second slot in Settings.'
          : 'Each deploy goes to the idle slot; Activate moves traffic to it.'}
        {' '}The database and the bucket are shared by both slots.
      </p>
    </section>
  );
}
```

In `EnvOverview.tsx`: props become `{ env, canActivate = false, onActivate }: { env: Environment; canActivate?: boolean; onActivate?: (slot: string | null) => void }`; after the Running section render `{onDo(env) && <DoMachineSection env={env} canActivate={canActivate && !!onActivate} onActivate={(s) => onActivate?.(s)} />}`; in the Services table, for DigitalOcean the Address cell is `:${s.port} on each droplet` (and Mailpit is plain text there), and the hint reads "The load balancer serves the public names; DNS points at it. Mailpit catches this environment's email on each droplet." The Running section's "Last deployment" uses `deploymentLabel(last)` instead of `MODE_LABEL[last.mode]`.

In `EnvironmentDetail.tsx`: state `const [activating, setActivating] = useState<{ slot: string | null } | null>(null);`; pass `canActivate={can('deploy', 'change') && !running}` and `onActivate={(slot) => setActivating({ slot })}` to `EnvOverview`; after the `DeployModal` line render

```tsx
      {activating && (
        <ActivateModal envName={env.name} production={env.type === 'production'} slot={activating.slot}
                       fromSlot={env.active_slot}
                       version={env.do?.slots.find((s) => s.slot === activating.slot)?.image_tag ?? null}
                       onStarted={(dep) => { setActivating(null); started(dep); }}
                       onClose={() => setActivating(null)} />
      )}
```

- [ ] **Step 5: `DoSettingsSection`**

Create `sirdar/web/src/pages/environments/DoSettingsSection.tsx`:

```tsx
/** Settings of a DigitalOcean environment: Activate automatically
 *  (non-production, two slots), Add a second slot (non-production, one slot),
 *  grow the sizes, and mark a production environment retiring. */
import { useState } from 'react';

import { Switch } from '@portal/components/Switch';

import {
  addSlot, deployErrorText, updateEnvironment, type Deployment, type DoSizes, type Environment,
} from '../../lib/sirdarApi';

export default function DoSettingsSection({ env, disabled, onSaved, onDeployStarted }: {
  env: Environment; disabled: boolean; onSaved: (env: Environment) => void; onDeployStarted: (dep: Deployment) => void;
}) {
  const d = env.do!;
  const production = env.type === 'production';
  const [droplet, setDroplet] = useState(d.droplet_size);
  const [db, setDb] = useState(d.db_size);
  const [standby, setStandby] = useState(d.db_standby);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const off = busy || disabled;

  const act = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(deployErrorText(e, fallback)); } finally { setBusy(false); }
  };
  const sizes = (): DoSizes => ({
    ...(droplet !== d.droplet_size ? { droplet_size: droplet } : {}),
    ...(db !== d.db_size ? { db_size: db } : {}),
    ...(standby !== d.db_standby ? { db_standby: standby } : {}),
  });

  return (
    <section className="sirdar-section" aria-labelledby="sirdar-do-settings">
      <h2 id="sirdar-do-settings">DigitalOcean</h2>
      <div className="sirdar-docloud-form">
        {!production && env.slots.length === 2 && (
          <div className="sirdar-switch-row sirdar-span2">
            <Switch checked={env.auto_activate} disabled={off} label="Activate automatically"
                    onChange={(on) => void act(async () => onSaved(await updateEnvironment(env.name, { auto_activate: on })),
                                               "Couldn't change that.")} />
            <span aria-hidden="true">Activate automatically: a deploy whose smoke test passes takes traffic by itself</span>
          </div>
        )}
        {!production && env.slots.length === 1 && (
          <div className="sirdar-span2">
            <button type="button" className="mini-btn" disabled={off}
                    onClick={() => void act(async () => {
                      const { environment, deployment } = await addSlot(env.name);
                      onSaved(environment);
                      if (deployment) onDeployStarted(deployment);
                    }, "Couldn't add the slot.")}>Add a second slot</button>
            <p className="page-hint">
              Builds the purple droplet, lets it reach the database, and deploys the running commit to it. Traffic stays
              on orange; then each deploy goes to the idle slot.
            </p>
          </div>
        )}
        <div>
          <label className="field-label" htmlFor="do-droplet-size">Droplet size</label>
          <input id="do-droplet-size" type="text" value={droplet} spellCheck={false} autoComplete="off" disabled={off}
                 onChange={(e) => setDroplet(e.target.value.trim())} />
        </div>
        <div>
          <label className="field-label" htmlFor="do-db-size">Database size</label>
          <input id="do-db-size" type="text" value={db} spellCheck={false} autoComplete="off" disabled={off}
                 onChange={(e) => setDb(e.target.value.trim())} />
        </div>
        <div className="sirdar-switch-row sirdar-span2">
          <Switch checked={standby} disabled={d.db_standby || off} label="Standby node" onChange={setStandby} />
          <span aria-hidden="true">Standby node</span>
        </div>
        <p className="page-hint sirdar-span2">
          Sizes only grow. A bigger droplet size is applied to a slot on its next deploy, and that droplet stops for a few
          minutes{env.slots.length === 1 ? ': with one slot the site is down meanwhile' : ''}.
        </p>
        <div className="sirdar-span2">
          <button type="button" className="mini-btn" disabled={off || !Object.keys(sizes()).length}
                  onClick={() => void act(async () => onSaved(await updateEnvironment(env.name, { do: sizes() })),
                                          "Couldn't save the sizes.")}>Save sizes</button>
        </div>
        {production && !env.retiring && (
          <div className="sirdar-span2">
            <label className="field-label" htmlFor="do-retire-confirm">Type {env.name} to confirm</label>
            <input id="do-retire-confirm" type="text" value={confirm} autoComplete="off" spellCheck={false}
                   disabled={off} onChange={(e) => setConfirm(e.target.value)} />
            <button type="button" className="mini-btn danger" disabled={off || confirm !== env.name}
                    onClick={() => void act(async () => onSaved(await updateEnvironment(
                      env.name, { retiring: true, confirm_name: env.name })), "Couldn't mark it retiring.")}>
              Mark retiring
            </button>
            <p className="page-hint">
              Once another environment serves production's names: a retiring production can be deactivated, then deleted.
            </p>
          </div>
        )}
        {production && env.retiring && (
          <p className="page-hint sirdar-span2">Retiring. Deactivate it on the Overview, then Delete.</p>
        )}
        {error && <p className="form-error sirdar-span2" role="alert">{error}</p>}
      </div>
    </section>
  );
}
```

In `EnvSettings.tsx`: when `onDo(env)`, don't render the Target, Proxy IP, Bind IP, Base domain and Spaces bucket fields (show Base domain and Bucket as read-only `.sirdar-kv` rows instead), skip their checks in `validate()`, and never send them; render `<DoSettingsSection env={env} disabled={off} onSaved={onSaved} onDeployStarted={(dep) => onDeleteStarted?.(dep)} />` above the danger zone. (`onDeleteStarted` already hands any deployment to the page, which opens it on the Deployments tab.)

- [ ] **Step 6: Delete, Deploy, Deployments, Backups**

`DeleteEnvironmentModal.tsx`, when `onDo(env)` (import `Switch`, `onDo`, `DO_RESOURCE_LABEL`):
- `const production = env.type === 'production'`; state `snapshot` (default `true`) and `phrase` (`''`); `const phraseWanted = \`delete production ${env.name}\``; `const deployed = env.current_sha !== null`.
- The description: "Removes everything Sirdar built for {name} on DigitalOcean (droplets, the managed database, the bucket and its files, the load balancer, the certificate and the firewall), after its DNS records. Snapshots taken from {name} are kept in Sirdar. Then Sirdar forgets the environment."
- "Sirdar removes" lists the created DNS records, then `env.do.resources` as `${DO_RESOURCE_LABEL[r.kind] ?? r.kind} ${r.name}`.
- Snapshot: non-production and deployed → `<div className="sirdar-switch-row"><Switch checked={snapshot} onChange={setSnapshot} label="Save a snapshot first" /><span aria-hidden="true">Save a snapshot first (named {name}-before-delete-…, kept in Sirdar)</span></div>`; production → `<p className="page-hint">A snapshot is always saved first for production.</p>`; never deployed → `<p className="page-hint">Nothing was deployed, so there is no snapshot to save.</p>`.
- Production gate: `!env.retiring` → `<p className="form-error">Mark this production environment retiring first (Settings).</p>` and Delete disabled; else `env.active_slot` → "Deactivate it first (Overview › DigitalOcean): a live slot can't be deleted." and disabled; else a second field `<label htmlFor="delete-phrase">Type {phraseWanted} to confirm</label>` and `ready` also needs `phrase === phraseWanted`.
- `Attempt` becomes `{ confirm: string; snapshot: boolean | null; phrase: string | null }`; `run` sends `{ mode: 'teardown', confirm_name: attempt.confirm, ...(attempt.snapshot === false ? { snapshot: false } : {}), ...(attempt.phrase ? { confirm_production: attempt.phrase } : {}) }`; the Delete button passes `{ confirm, snapshot: onDo(env) && !production && deployed ? snapshot : null, phrase: onDo(env) && production ? phrase : null }`.

`DeployModal.tsx`, when `onDo(env)` (import `onDo`, `idleSlot`, `goesLive`, `slotTitle`):
- don't render the mode radiogroup (Update only; Reset isn't offered) — `mode` stays `'update'`;
- under the Git ref, the lines

```tsx
          {onDo(env) && (() => {
            const target = idleSlot(env);
            const live = goesLive(env, target);
            return (
              <>
                <p className="page-hint">
                  {live ? `Deploys to ${slotTitle(target)} and goes live when its smoke test passes.`
                    : `Deploys to ${slotTitle(target)}. Traffic stays on ${slotTitle(env.active_slot)} until you activate ${slotTitle(target)}.`}
                </p>
                {env.slots.length > 1 && env.active_slot && (
                  <p className="page-hint">
                    Migrations must work with the code still live on {slotTitle(env.active_slot)}: add columns and tables
                    first, remove them in a later release.
                  </p>
                )}
              </>
            );
          })()}
```

  (a first deploy from a seed snapshot keeps today's "restores {snapshot}" line).

`DeploymentView.tsx` (import `CHANGE_MODES`, `retryNeedsName`, `deploymentLabel`, `onDo`):
- `const gated = !!dep && retryNeedsName(dep.mode, env);` and the permission check uses `CHANGE_MODES.includes(dep.mode)` (needs `add` and `change`) instead of `gated`;
- `const phraseNeeded = !!dep && dep.cloud && dep.mode === 'teardown' && env.type === 'production';` with state `phrase`; render, after the name field, `<label htmlFor="retry-phrase">Type delete production {env.name} to confirm</label>` + input when `phraseNeeded`; the Retry button is also disabled until `phrase === \`delete production ${env.name}\``;
- the retry `Attempt` gains `phrase: string | null`; `retryDeployment(id, { from_step, ...(attempt.gated ? { confirm_name: attempt.confirm } : {}), ...(attempt.phrase ? { confirm_production: attempt.phrase } : {}) })`;
- `mayRollBack` adds `&& !onDo(env)` (Roll back isn't offered on DigitalOcean);
- the heading shows `deploymentLabel(dep)` where it shows the mode today.

`DeploymentsTab.tsx`: the Mode cell is `deploymentLabel(d)`.

`BackupsTab.tsx`: when `onDo(env)`, the action cell is empty and the hint adds "Restore backup isn't offered on DigitalOcean: both slots share the managed database. To go back, activate the other slot." (`mayRestore` is `can('deploy', 'change') && !onDo(env)`).

- [ ] **Step 7: Run the tests and build**

Run: `npm --prefix sirdar/web test -- src/components src/pages/environments && npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS and a clean build.

- [ ] **Step 8: Commit**

```bash
git add sirdar/web/src/components/ActivateModal.tsx sirdar/web/src/components/ActivateModal.test.tsx sirdar/web/src/pages/environments/DoMachineSection.tsx sirdar/web/src/pages/environments/DoMachineSection.test.tsx sirdar/web/src/pages/environments/DoSettingsSection.tsx sirdar/web/src/pages/environments/DoSettingsSection.test.tsx sirdar/web/src/pages/environments/EnvOverview.tsx sirdar/web/src/pages/environments/EnvironmentDetail.tsx sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx sirdar/web/src/pages/environments/EnvSettings.tsx sirdar/web/src/pages/environments/EnvSettings.test.tsx sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx sirdar/web/src/pages/environments/DeleteEnvironmentModal.test.tsx sirdar/web/src/pages/environments/DeployModal.tsx sirdar/web/src/pages/environments/DeployModal.test.tsx sirdar/web/src/pages/environments/DeploymentView.tsx sirdar/web/src/pages/environments/DeploymentView.test.tsx sirdar/web/src/pages/environments/DeploymentsTab.tsx sirdar/web/src/pages/environments/DeploymentsTab.test.tsx sirdar/web/src/pages/environments/BackupsTab.tsx sirdar/web/src/pages/environments/BackupsTab.test.tsx
git commit -m "feat(sirdar-web): DigitalOcean environment pages — slots, Activate, settings, Delete, Deploy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The Deployments page spotlight

Implements `docs/superpowers/specs/2026-10-06-sirdar-dashboard-spotlight-design.md` §1–§4, §6, §7 (web) on Task 5's data. Replaces the old production-only Task 10.

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts` (dashboard section only: `DashSlot`, `DashProduction` and `DashboardData.production` go)
- Rename and generalize: `sirdar/web/src/pages/dashboard/ProductionFlow.tsx` → `EnvironmentFlow.tsx`, `ProductionFlow.test.tsx` → `EnvironmentFlow.test.tsx` (`git mv`, then edit)
- Create: `sirdar/web/src/pages/dashboard/Spotlight.tsx`
- Modify: `sirdar/web/src/pages/dashboard/EnvCard.tsx`, `DashboardPage.tsx`, `DashboardPage.test.tsx`, `testData.ts`, `dashboard.css`

**Interfaces:**
- Consumes: Task 5's `GET /dashboard` (`DashEnvironment.production/flow`, `DashFlow`, `DashServer`, `DashCert`), Task 6's types, Task 9's `ActivateModal`, the existing `DeployModal`, `SoonButton`, `Dot`, icons, `InfraTree` (unchanged), the portal motion preference (`preferences.motion`), `useSearchParams`.
- Produces:
  - `<EnvironmentFlow flow motion serverAction? />` — live traffic → middle box (`load_balancer` / `proxy` / `none`) → one or two server boxes, measured SVG connectors, GSAP dots on the live path only; the deploying server pulses, a failed one is red; motion off (preference, `data-motion="off"`, `prefers-reduced-motion`) leaves the dots static.
  - `<Spotlight card demo motion canDeploy canView canActivate onDeploy onSetUp onActivate />` — the title row (name, type, state pill, certificate pill, Deploy, Open) and the flow, with **Activate <Slot>** on the idle server box of a two-slot DigitalOcean environment when the user has `deploy:change` and that slot has run a deploy.
  - `<EnvCard env demo canDeploy selected onSelect onDeploy onSetUp />` — a selectable card (a full-card toggle button with `aria-pressed`, Enter/Space) with a small Deploy / Set up button that doesn't change the selection.
  - `DashboardPage` selection: `?env=<card id>` → `localStorage['sirdar.dashboard.env']` (try/catch) → default (the production environment if one exists, else the first card); a click sets both (`replace` history).

- [ ] **Step 1: Types and fixtures**

In `sirdar/web/src/lib/sirdarApi.ts`, delete `DashSlot` and `DashProduction`, and `production: DashProduction;` from `DashboardData`.

Rewrite `sirdar/web/src/pages/dashboard/testData.ts` (keep `n`, `DEMO_TREE` and `NONE_FLOW`):

```ts
const server = (id: string, label: string, sub: string, state: DashServer['state'], health: string,
                version: string | null): DashServer => ({ id, label, sub, state, health, version, deployed: version !== null });
export const lbFlow = (servers: DashServer[], active: string | null, extra: Partial<DashFlow> = {}): DashFlow => ({
  kind: 'load_balancer', middle: { label: 'Load balancer', sub: '203.0.113.50', status: 'ok' }, servers,
  active_slot: active, certificate: { days_left: 64, expires_at: '2026-12-09T12:00:00+00:00', tone: 'ok' },
  deploying_slot: null, failed_slot: null, ...extra,
});
export const lanFlow = (version: string | null, extra: Partial<DashFlow> = {}): DashFlow => ({
  kind: 'proxy', middle: { label: 'Nginx Proxy Manager', sub: '10.10.48.6', status: 'ok' },
  servers: [server('host', 'Lab box', '10.10.48.63', version ? 'live' : 'empty', version ? 'healthy' : 'unknown', version)],
  active_slot: version ? 'host' : null, certificate: null, deploying_slot: null, failed_slot: null, ...extra,
});
const card = (id: string, label: string, sub: string | null, state: string, version: string | null,
              environment: string | null, production: boolean, flow: DashFlow, action: string): DashEnvironment => ({
  id, label, sub, state, version, last_release: version, last_release_at: version ? '2026-10-03T12:00:00+00:00' : null,
  action_label: action, environment, production, flow,
});
export const PLACEHOLDER_PROD = card('production', 'Production', null, 'empty', null, null, true, NONE_FLOW, 'Set up Production');
/** A real two-slot production: blue live, green deployed and idle. */
export const PROD_CARD = card('prod', 'prod', 'Production', 'active', 'e73b99ca', 'prod', true, lbFlow([
  server('blue', 'Blue', '203.0.113.11', 'live', 'healthy', 'e73b99ca'),
  server('green', 'Green', '203.0.113.12', 'idle', 'healthy', 'f00dbabe')], 'blue'), 'Deploy prod');
/** A two-slot dev environment: orange live, purple idle, its certificate inside 14 days. */
export const DO_CARD = card('uat9', 'uat9', 'Development', 'active', 'e73b99ca', 'uat9', false, lbFlow([
  server('orange', 'Orange', '203.0.113.21', 'live', 'healthy', 'e73b99ca'),
  server('purple', 'Purple', '203.0.113.22', 'idle', 'healthy', 'f00dbabe')], 'orange',
  { certificate: { days_left: 10, expires_at: '2026-10-16T12:00:00+00:00', tone: 'warn' } }), 'Deploy uat9');
/** uat9's Activate of purple failed: orange still serves. */
export const FAILED_DO_CARD: DashEnvironment = { ...DO_CARD, state: 'failed', flow: { ...DO_CARD.flow, failed_slot: 'purple' } };
export const LAN_CARD = card('uat', 'uat', 'Development', 'active', 'e73b99ca', 'uat', false, lanFlow('e73b99ca'), 'Deploy uat');
const placeholder = (id: string, label: string, action: string) =>
  card(id, label, null, 'empty', null, null, false, NONE_FLOW, action);

export const DEMO: DashboardData = {
  demo: true, generated_at: '2026-10-02T00:52:43Z', health: { status: 'healthy', label: 'All systems healthy' },
  environments: [
    { ...PROD_CARD, id: 'production', label: 'Production', environment: null, action_label: 'Deploy production' },
    { ...DO_CARD, id: 'dev', label: 'Development', environment: null, action_label: 'Deploy to Dev' },
    { ...LAN_CARD, label: 'UAT', sub: 'Custom', environment: null, action_label: 'Deploy to UAT' },
  ],
  infrastructure: { source: 'demo', error: null, tree: DEMO_TREE },
};
export const EMPTY: DashboardData = {
  demo: false, generated_at: '2026-10-02T00:52:43Z', health: { status: 'unknown', label: 'No environments deployed' },
  environments: [PLACEHOLDER_PROD, placeholder('dev', 'Development', 'Set up Dev'), placeholder('beta', 'Beta', 'Set up Beta'),
                 placeholder('qa-east', 'Qa East', 'Set up Qa East')],
  infrastructure: { source: 'none', error: null, tree: [], accounts: [] },
};
/** Real mode: no production yet, uat (LAN, deployed), a Beta placeholder, a custom environment whose deploy failed. */
export const REAL: DashboardData = {
  ...EMPTY, health: { status: 'degraded', label: 'A deployment failed' },
  environments: [PLACEHOLDER_PROD, LAN_CARD, placeholder('beta', 'Beta', 'Set up Beta'),
                 card('qa-east', 'qa-east', 'Custom', 'failed', null, 'qa-east', false,
                      lanFlow(null, { failed_slot: 'host' }), 'Deploy qa-east')],
};
/** Real mode with DigitalOcean: production first, then uat9 and uat. */
export const CLOUD: DashboardData = {
  ...EMPTY, health: { status: 'healthy', label: 'Environments deployed' },
  environments: [PROD_CARD, DO_CARD, LAN_CARD],
};
```

(import `DashEnvironment`, `DashFlow`, `DashServer` types.)

- [ ] **Step 2: Write the failing tests**

`git mv sirdar/web/src/pages/dashboard/ProductionFlow.test.tsx sirdar/web/src/pages/dashboard/EnvironmentFlow.test.tsx`, then in it: add `screen` to the Testing Library import, import `EnvironmentFlow from './EnvironmentFlow'` and `{ CLOUD, LAN_CARD, PLACEHOLDER_PROD, PROD_CARD }` from `./testData`; every `render(<ProductionFlow production={DEMO.production} …/>)` becomes `render(<EnvironmentFlow flow={PROD_CARD.flow} …/>)`, and `EMPTY.production` becomes `PLACEHOLDER_PROD.flow` (the "inactive" test now expects **one** dashed curve, the placeholder's one server). Add:

```tsx
it('a LAN environment: proxy, one host, dots to it', () => {
  const { container } = render(<EnvironmentFlow flow={LAN_CARD.flow} motion={false} />);
  expect(container.querySelector('.sd-node-lb')!.textContent).toContain('Nginx Proxy Manager');
  expect(container.querySelectorAll('.sd-flow-curve')).toHaveLength(1);
  expect(container.querySelector('.sd-flow-curve')!.getAttribute('class')).toMatch(/is-live/);
  expect(container.querySelectorAll('.sd-flow-dot')).toHaveLength(12);
});

it('the deploying server pulses; a failed one is red while the live one stays lit', () => {
  const deploying = { ...PROD_CARD.flow, deploying_slot: 'green' };
  const { container, unmount } = render(<EnvironmentFlow flow={deploying} motion={false} />);
  const [blue, green] = Array.from(container.querySelectorAll('.sd-slot'));
  expect(green.className).toMatch(/is-deploying/);
  expect(green.textContent).toContain('Deploying');
  expect(blue.className).toMatch(/is-active/);
  unmount();
  const failed = render(<EnvironmentFlow flow={{ ...PROD_CARD.flow, failed_slot: 'green' }} motion={false} />);
  const [blue2, green2] = Array.from(failed.container.querySelectorAll('.sd-slot'));
  expect(green2.className).toMatch(/is-failed/);
  expect(green2.textContent).toContain('Failed');
  expect(blue2.className).toMatch(/is-active/);
  expect(failed.container.querySelector('.sd-flow-curve')!.getAttribute('class')).toMatch(/is-live/);
});

it('a different environment re-measures and restarts the animation', () => {
  const { rerender } = render(<EnvironmentFlow key="prod" flow={PROD_CARD.flow} motion />);
  expect(g.gsap.to).toHaveBeenCalledTimes(12);
  rerender(<EnvironmentFlow key="uat9" flow={CLOUD.environments[1].flow} motion />);
  expect(g.revert).toHaveBeenCalled();
  expect(g.gsap.to).toHaveBeenCalledTimes(24);
});

it('renders the server action next to its box', () => {
  render(<EnvironmentFlow flow={PROD_CARD.flow} motion={false}
                          serverAction={(s) => (s.state === 'idle' ? <button type="button">Activate {s.label}</button> : null)} />);
  expect(screen.getByRole('button', { name: 'Activate Green' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Activate Blue' })).toBeNull();
});
```

In `sirdar/web/src/pages/dashboard/DashboardPage.test.tsx`: add `activateSlot: vi.fn()` to `api`, `window.localStorage.clear()` to `beforeEach`, import `{ CLOUD, DEMO, EMPTY, FAILED_DO_CARD, REAL }`. Replace the two "production inactive" / "production active (demo)" tests and "an environment card's heading links to its page only with deploy:view" with:

```tsx
const spot = () => screen.getByRole('region', { name: 'Selected environment' });
const cardToggle = (label: string) => screen.getByRole('button', { name: `Show ${label}` });

it('Production is the first card; without one the spotlight says Not built yet with Set up', async () => {
  show();
  await screen.findByText('No environments deployed');
  const cards = screen.getAllByRole('button', { name: /^Show / });
  expect(cards[0].getAttribute('aria-label')).toBe('Show Production');
  expect(cards[0].getAttribute('aria-pressed')).toBe('true');
  expect(within(spot()).getByRole('heading', { name: 'Production' })).toBeTruthy();
  expect(within(spot()).getAllByText('Not built yet').length).toBeGreaterThan(0);
  await userEvent.click(within(spot()).getByRole('button', { name: 'Set up' }));
  expect(path).toBe('/deploy');
});

it('selects the production environment by default and shows its flow and certificate', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).getByText('Running')).toBeTruthy();
  expect(within(spot()).getByText('Certificate: 64 days left').className).toMatch(/is-ok/);
  expect(within(spot()).getByText('Blue')).toBeTruthy();
  expect(within(spot()).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/deploy/environments/prod');
});

it('clicking a card changes the spotlight, the URL and the remembered pick', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await screen.findByRole('button', { name: 'Show uat9' });
  await userEvent.click(cardToggle('uat9'));
  expect(within(spot()).getByRole('heading', { name: 'uat9' })).toBeTruthy();
  expect(within(spot()).getByText('Certificate: 10 days left').className).toMatch(/is-warn/);
  expect(cardToggle('uat9').getAttribute('aria-pressed')).toBe('true');
  expect(cardToggle('prod').getAttribute('aria-pressed')).toBe('false');
  expect(loc).toBe('?env=uat9');
  expect(window.localStorage.getItem('sirdar.dashboard.env')).toBe('uat9');
});

it('?env= picks the spotlight; a remembered pick is used without it; an unknown one falls back', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show('/?env=uat');
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'uat' })).toBeTruthy());
  expect(within(spot()).getByText('Nginx Proxy Manager')).toBeTruthy();
  cleanup();
  window.localStorage.setItem('sirdar.dashboard.env', 'uat9');
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'uat9' })).toBeTruthy());
  cleanup();
  window.localStorage.setItem('sirdar.dashboard.env', 'gone');
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
});

it("a card's Deploy opens the Deploy modal without changing the selection", async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  api.getEnvironment.mockResolvedValue(ENV);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  await userEvent.click(within(uat).getByRole('button', { name: 'Deploy uat' }));
  expect(await screen.findByRole('dialog', { name: 'Deploy uat' })).toBeTruthy();
  expect(cardToggle('prod').getAttribute('aria-pressed')).toBe('true');
});

it("Activate on production's idle slot asks for the name, then follows the deployment", async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  api.activateSlot.mockResolvedValue({ ...RUNNING, id: 'd7' });
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).queryByRole('button', { name: 'Activate Blue' })).toBeNull();     // the live one
  await userEvent.click(within(spot()).getByRole('button', { name: 'Activate Green' }));
  const dialog = await screen.findByRole('dialog', { name: 'Activate Green' });
  expect(dialog.closest('.sd-dash')).toBeNull();
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Green' }));
  await waitFor(() => expect(api.activateSlot).toHaveBeenCalledWith('prod', 'green', 'prod'));
  await waitFor(() => expect(path).toBe('/deploy/environments/prod'));
  expect(loc).toBe('?deployment=d7');
});

it('Activate needs deploy:change and a deployed idle slot', async () => {
  const notDeployed = { ...CLOUD.environments[0], flow: { ...CLOUD.environments[0].flow,
    servers: CLOUD.environments[0].flow.servers.map((s) => (s.id === 'green' ? { ...s, deployed: false, version: null } : s)) } };
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [notDeployed, ...CLOUD.environments.slice(1)] });
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).queryByRole('button', { name: /Activate/ })).toBeNull();
  cleanup();
  perms.change = false;
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).queryByRole('button', { name: /Activate/ })).toBeNull();
});

it('a failed deploy on a two-slot environment says the live slot still serves', async () => {
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [CLOUD.environments[0], FAILED_DO_CARD] });
  show('/?env=uat9');
  expect(await within(spot()).findByText('Failed — Orange still live')).toBeTruthy();
});

it('demo data: every spotlight action is inert', async () => {
  show('/?demo=1');
  await screen.findByText('All systems healthy');
  for (const name of [/^Deploy/, 'Open', 'Activate Green']) {
    const btn = within(spot()).getByRole('button', { name });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  }
});

it('Open shows only with deploy:view', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  perms.view = false;
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).queryByRole('link', { name: 'Open' })).toBeNull();
});
```

The `perms` hoisted object gains `change: true` (reset in `beforeEach`), and the `useAuth` mock's `can` answers `a === 'change' ? perms.change : a === 'view' ? perms.view : perms.deploy` for `deploy`. Update the existing tests for the new cards (each card now also holds a "Show <label>" toggle button, and the placeholder production card comes first):
- "cards with no environment yet offer Set up": the Development card reads `Not built yet` and its button is `Set up Development`.
- "environment cards show the type, version, state and last release": drop the heading `link` assertion (Open lives in the spotlight).
- "a card whose environment is deploying has an inert Deploy": spread `REAL.environments[1]` (uat), not `[0]`; the inert button is `within(uat).getByRole('button', { name: 'Deploy' })`.
- "demo cards are inert…": the Development card's inert button is `Deploy` (title `Demo data`); without `deploy:add`, assert `within(uat).queryByRole('button', { name: /^(Deploy|Set up)/ })` is null (the Show toggle stays).
- "the Deploy modal and its host-key prompt render outside .sd-dash" and "an environment card's Deploy opens the Deploy modal…" keep `Deploy uat` (the card button's accessible name).

- [ ] **Step 3: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/dashboard`
Expected: FAIL (`EnvironmentFlow`, the spotlight and the selection don't exist).

- [ ] **Step 4: `EnvironmentFlow`**

`git mv sirdar/web/src/pages/dashboard/ProductionFlow.tsx sirdar/web/src/pages/dashboard/EnvironmentFlow.tsx`, then make it:

```tsx
/** An environment's flow: live traffic → the middle box (a DigitalOcean load
 *  balancer, or Nginx Proxy Manager on the LAN) → its server(s), with SVG
 *  connectors drawn behind the boxes and glowing dots that GSAP moves along
 *  the live path only. Paths are measured from the laid-out boxes and
 *  recomputed on resize; a new environment remounts it (key), so it measures
 *  and animates afresh. Motion off (portal preference, `data-motion="off"` on
 *  the shell, or prefers-reduced-motion) leaves the dots static. */
import { gsap } from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import type { DashFlow, DashServer } from '../../lib/sirdarApi';

import { CloudIcon, LoadBalancerIcon, ServerRackIcon } from './icons';
import { Dot, type Tone } from './parts';

gsap.registerPlugin(MotionPathPlugin);

const DOTS_PER_PATH = 6;
const TRIP_SECONDS = 2.5;

type Pt = { x: number; y: number };
type Line = { a: Pt; b: Pt };
type Curve = { a: Pt; c1: Pt; c2: Pt; b: Pt };
type Geo = { seg: Line; curves: Curve[] };

const ZERO: Pt = { x: 0, y: 0 };
const EMPTY_GEO: Geo = { seg: { a: ZERO, b: ZERO }, curves: [] };

const lineD = ({ a, b }: Line) => `M${a.x},${a.y} L${b.x},${b.y}`;
const curveD = ({ a, c1, c2, b }: Curve) => `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;

function onLine({ a, b }: Line, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function onCurve({ a, c1, c2, b }: Curve, t: number): Pt {
  const u = 1 - t;
  const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return {
    x: k[0] * a.x + k[1] * c1.x + k[2] * c2.x + k[3] * b.x,
    y: k[0] * a.y + k[1] * c1.y + k[2] * c2.y + k[3] * b.y,
  };
}

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_QUERY).matches;
}

/** Tracks the OS reduced-motion setting, re-rendering when it is toggled. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

const title = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const healthTone = (h: string): Tone => (h === 'healthy' ? 'ok' : h === 'degraded' ? 'warn' : 'muted');
const MIDDLE_STATUS: Record<string, string> = { ok: 'Active', warn: 'Busy', down: 'Not found', unknown: 'Unknown' };

function ServerBox({ server, flow, action, boxRef }: {
  server: DashServer; flow: DashFlow; action: ReactNode; boxRef: (el: HTMLDivElement | null) => void;
}) {
  const live = server.state === 'live';
  const empty = server.state === 'empty';
  const deploying = flow.deploying_slot === server.id;
  const failed = flow.failed_slot === server.id;
  const [tagClass, tag] = deploying ? ['is-deploying', 'Deploying'] : failed ? ['is-failed', 'Failed']
    : live ? ['is-active', 'Live'] : server.state === 'idle' ? ['is-standby', 'Idle'] : ['', ''];
  return (
    <div ref={boxRef} className={`sd-slot is-${live ? 'active' : empty ? 'empty' : 'standby'}`
      + `${deploying ? ' is-deploying' : ''}${failed ? ' is-failed' : ''}`}>
      <div className="sd-slot-icon">
        <ServerRackIcon size={30} />
        <span className={`sd-icon-dot is-${live ? 'blue' : 'muted'}`} aria-hidden="true" />
      </div>
      <div className="sd-slot-main">
        <div className="sd-slot-title">
          <b>{server.label}</b>
          {tag && <span className={`sd-slot-tag ${tagClass}`}>{tag}</span>}
        </div>
        <div className="sd-muted">{server.sub}</div>
        {empty && !deploying ? <div className="sd-muted">Not deployed</div> : (
          <>
            {server.version && <div className="sd-slot-version">{server.version}</div>}
            <div className="sd-slot-health"><Dot tone={healthTone(server.health)} />{title(server.health)}</div>
          </>
        )}
      </div>
      {action}
    </div>
  );
}

export default function EnvironmentFlow({ flow, motion, serverAction }: {
  flow: DashFlow; motion: boolean; serverAction?: (server: DashServer) => ReactNode;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const liveIdx = flow.kind === 'none' ? -1 : flow.servers.findIndex((s) => s.state === 'live');
  const showDots = liveIdx >= 0;

  const diagramRef = useRef<HTMLDivElement>(null);
  const trafficRef = useRef<HTMLDivElement>(null);
  const lbRef = useRef<HTMLDivElement>(null);
  const boxEls = useRef<(HTMLDivElement | null)[]>([]);
  const segPathRef = useRef<SVGPathElement>(null);
  const curvePathRefs = useRef<(SVGPathElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const [geo, setGeo] = useState<Geo>(EMPTY_GEO);
  const geoKey = useRef('');
  const reducedMotion = useReducedMotion();

  const measure = useCallback(() => {
    const root = diagramRef.current, t = trafficRef.current, lb = lbRef.current;
    if (!root || !t || !lb) return;
    const o = root.getBoundingClientRect();
    const r = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { l: b.left - o.left, r: b.right - o.left, cy: b.top - o.top + b.height / 2 };
    };
    const tr = r(t), lr = r(lb);
    const seg: Line = { a: { x: tr.r, y: tr.cy }, b: { x: lr.l - 1, y: lr.cy } };
    const curves = boxEls.current.slice(0, flow.servers.length).filter(Boolean).map((el) => {
      const s = r(el!);
      const a = { x: lr.r, y: lr.cy }, b = { x: s.l - 1, y: s.cy };
      const mid = (a.x + b.x) / 2;
      return { a, c1: { x: mid, y: a.y }, c2: { x: mid, y: b.y }, b };
    });
    const next = { seg, curves };
    const key = JSON.stringify(next);
    if (key !== geoKey.current) { geoKey.current = key; setGeo(next); }
  }, [flow.servers.length]);

  useLayoutEffect(() => {
    measure();
    const root = diagramRef.current;
    if (!root) return undefined;
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => measure());
      ro.observe(root);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const liveCurve = liveIdx >= 0 ? geo.curves[liveIdx] : undefined;
  const staticDots: Pt[] = [];
  if (showDots) {
    for (let i = 0; i < DOTS_PER_PATH; i += 1) staticDots.push(onLine(geo.seg, (i + 0.5) / DOTS_PER_PATH));
    for (let i = 0; i < DOTS_PER_PATH; i += 1) {
      staticDots.push(liveCurve ? onCurve(liveCurve, (i + 0.5) / DOTS_PER_PATH) : ZERO);
    }
  }

  useEffect(() => {
    const root = diagramRef.current;
    if (!root || !showDots || !motion || !geo.curves.length || reducedMotion) return undefined;
    if (root.closest('.portal-shell')?.getAttribute('data-motion') === 'off') return undefined;
    const seg = segPathRef.current, curve = curvePathRefs.current[liveIdx];
    // jsdom (and very old engines) have no SVG geometry; keep the static dots
    if (!seg || !curve || typeof (seg as { getTotalLength?: unknown }).getTotalLength !== 'function') {
      return undefined;
    }
    const dots = dotRefs.current.slice();
    const ctx = gsap.context(() => {
      dotRefs.current.forEach((dot, i) => {
        if (!dot) return;
        const path = i < DOTS_PER_PATH ? seg : curve;
        gsap.set(dot, { attr: { cx: 0, cy: 0 } });
        gsap.to(dot, {
          motionPath: { path, align: path, alignOrigin: [0.5, 0.5] },
          duration: TRIP_SECONDS,
          ease: 'none',
          repeat: -1,
          onUpdate(this: gsap.core.Tween) {
            const p = this.progress();
            dot.style.opacity = String(Math.min(1, p * 8, (1 - p) * 8));
          },
        }).progress((i % DOTS_PER_PATH) / DOTS_PER_PATH);
      });
    }, root);
    return () => {
      ctx.revert();
      // onUpdate writes inline opacity, which ctx.revert() does not know about
      dots.forEach((d) => { if (d) d.style.opacity = ''; });
    };
  }, [showDots, motion, reducedMotion, liveIdx, geo]);

  const markerBlue = `${uid}-ab`, markerGray = `${uid}-ag`;
  const middleTone: Tone = flow.middle.status === 'ok' ? 'ok' : flow.middle.status === 'unknown' ? 'muted' : 'warn';

  return (
    <div className="sd-flow">
      <div className="sd-flow-diagram" ref={diagramRef}>
        <svg className="sd-flow-svg" aria-hidden="true" focusable="false">
          <defs>
            {[[markerBlue, 'is-live'], [markerGray, 'is-idle']].map(([id, cls]) => (
              <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8"
                      markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0,0 L10,5 L0,10 Z" className={`sd-flow-arrow ${cls}`} />
              </marker>
            ))}
          </defs>
          <path ref={segPathRef} d={lineD(geo.seg)} className={`sd-flow-seg ${showDots ? 'is-live' : 'is-idle'}`}
                markerEnd={`url(#${showDots ? markerBlue : markerGray})`} />
          {flow.servers.map((s, i) => {
            const on = i === liveIdx;
            const c = geo.curves[i];
            return (
              <path key={s.id} ref={(el) => { curvePathRefs.current[i] = el; }}
                    d={c ? curveD(c) : 'M0,0'} className={`sd-flow-curve ${on ? 'is-live' : 'is-idle'}`}
                    markerEnd={`url(#${on ? markerBlue : markerGray})`} />
            );
          })}
          {staticDots.map((p, i) => (
            <circle key={i} ref={(el) => { dotRefs.current[i] = el; }} className="sd-flow-dot"
                    r="3.5" cx={p.x} cy={p.y} />
          ))}
        </svg>

        <div className="sd-node sd-node-traffic" ref={trafficRef}>
          <CloudIcon size={40} className="sd-node-icon" />
          <div>
            <b>Live traffic</b>
            <div className="sd-muted">External users</div>
          </div>
        </div>

        <div className={`sd-node sd-node-lb is-${flow.middle.status}`} ref={lbRef}>
          <LoadBalancerIcon size={34} className="sd-node-icon" />
          <div>
            <b>{flow.middle.label}</b>
            {flow.middle.sub && <div className={showDots ? 'sd-accent' : 'sd-muted'}>{flow.middle.sub}</div>}
            {flow.kind === 'load_balancer' && (
              <div className="sd-node-status"><Dot tone={middleTone} />{MIDDLE_STATUS[flow.middle.status] ?? flow.middle.status}</div>
            )}
          </div>
        </div>

        <div className="sd-slots">
          {flow.servers.map((s, i) => (
            <ServerBox key={s.id} server={s} flow={flow} action={serverAction?.(s) ?? null}
                       boxRef={(el) => { boxEls.current[i] = el; }} />
          ))}
        </div>
      </div>
    </div>
  );
}
```

(The `<section>`, its heading and its pill move to `Spotlight`.)

- [ ] **Step 5: `Spotlight`**

Create `sirdar/web/src/pages/dashboard/Spotlight.tsx`:

```tsx
/** The selected environment, large: its name, type, state and certificate,
 *  Deploy and Open, and its flow. Activate sits on the idle server box of a
 *  two-slot DigitalOcean environment (deploy:change, and only once that slot
 *  has run a deploy). Demo data keeps every action inert. */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { DashEnvironment, DashServer } from '../../lib/sirdarApi';
import { slotTitle } from '../environments/labels';

import EnvironmentFlow from './EnvironmentFlow';
import { Dot, SoonButton } from './parts';

function StatePill({ card }: { card: DashEnvironment }) {
  const f = card.flow;
  if (card.state === 'active') return <span className="sd-pill is-ok"><Dot tone="ok" />Running</span>;
  if (card.state === 'deploying') return <span className="sd-pill is-blue"><Dot tone="blue" />Deploying</span>;
  if (card.state === 'failed') {
    const stillLive = f.servers.length > 1 && f.active_slot && f.failed_slot !== f.active_slot;
    return (
      <span className="sd-pill is-warn"><Dot tone="warn" />
        {stillLive ? `Failed — ${slotTitle(f.active_slot)} still live` : 'Last deploy failed'}
      </span>
    );
  }
  return <span className="sd-pill is-muted"><Dot tone="muted" />{card.environment ? 'Not deployed' : 'Not built yet'}</span>;
}

function CertPill({ card }: { card: DashEnvironment }) {
  const c = card.flow.certificate;
  if (!c) return null;
  const cls = c.tone === 'bad' ? 'is-bad' : c.tone === 'warn' ? 'is-warn' : 'is-ok';
  return <span className={`sd-pill ${cls}`}>{c.tone === 'bad' ? 'Certificate expired' : `Certificate: ${c.days_left} days left`}</span>;
}

export default function Spotlight({ card, demo, motion, canDeploy, canView, canActivate, onDeploy, onSetUp, onActivate }: {
  card: DashEnvironment; demo: boolean; motion: boolean; canDeploy: boolean; canView: boolean; canActivate: boolean;
  onDeploy: (name: string) => void; onSetUp: () => void; onActivate: (server: DashServer) => void;
}) {
  const name = card.environment;
  const f = card.flow;
  const type = card.sub ?? (card.production ? 'Production' : null);
  const twoSlots = f.kind === 'load_balancer' && f.servers.length === 2;

  let deploy: ReactNode = null;
  if (demo) deploy = <SoonButton className="sd-btn-outline sd-btn-sm" title="Demo data">Deploy</SoonButton>;
  else if (canDeploy && name && card.state === 'deploying') {
    deploy = <SoonButton className="sd-btn-outline sd-btn-sm" title="A deployment is running.">Deploy</SoonButton>;
  } else if (canDeploy && name) {
    deploy = <button type="button" className="sd-btn sd-btn-primary sd-btn-sm" onClick={() => onDeploy(name)}>Deploy</button>;
  } else if (canDeploy) {
    deploy = <button type="button" className="sd-btn sd-btn-primary sd-btn-sm" onClick={onSetUp}>Set up</button>;
  }
  let open: ReactNode = null;
  if (demo) open = <SoonButton className="sd-btn-outline sd-btn-sm" title="Demo data">Open</SoonButton>;
  else if (name && canView) {
    open = <Link className="sd-btn sd-btn-outline sd-btn-sm" to={`/deploy/environments/${encodeURIComponent(name)}`}>Open</Link>;
  }

  const serverAction = (s: DashServer): ReactNode => {
    if (!twoSlots || s.state !== 'idle' || !s.deployed || f.deploying_slot) return null;
    const label = `Activate ${s.label}`;
    if (demo) return <SoonButton className="sd-btn-outline sd-slot-action" title="Demo data">{label}</SoonButton>;
    if (!canActivate || !name || card.state === 'deploying') return null;
    return <button type="button" className="sd-btn sd-btn-outline sd-slot-action" onClick={() => onActivate(s)}>{label}</button>;
  };

  return (
    <section className="sd-card sd-prod sd-spot" aria-label="Selected environment">
      <header className="sd-card-head sd-spot-head">
        <h2>{card.label}</h2>
        {type && <span className="sd-muted">{type}</span>}
        <StatePill card={card} />
        <CertPill card={card} />
        <span className="sd-spot-actions">{deploy}{open}</span>
      </header>
      <EnvironmentFlow key={card.id} flow={f} motion={motion} serverAction={serverAction} />
    </section>
  );
}
```

- [ ] **Step 6: `EnvCard`**

Rewrite `sirdar/web/src/pages/dashboard/EnvCard.tsx`:

```tsx
/** One environment card (Production first). Clicking the card (or Enter /
 *  Space on it) puts it in the spotlight; its small Deploy (or Set up) button
 *  doesn't change the selection. Demo cards' actions are inert. */
import { useId, type ReactNode } from 'react';

import type { DashEnvironment } from '../../lib/sirdarApi';

import { ServerRackIcon } from './icons';
import { Dot, SoonButton } from './parts';

function State({ env }: { env: DashEnvironment }) {
  const version = env.version && <b>{env.version}</b>;
  if (env.state === 'active') return <div className="sd-env-state">{version}<span className="sd-pill is-ok"><Dot tone="ok" />Running</span></div>;
  if (env.state === 'deploying') return <div className="sd-env-state">{version}<span className="sd-pill is-muted"><Dot tone="blue" />Deploying</span></div>;
  if (env.state === 'failed') return <div className="sd-env-state">{version}<span className="sd-pill is-warn"><Dot tone="warn" />Last deploy failed</span></div>;
  return <div className="sd-env-state sd-caps">{env.environment ? 'No active deployment' : 'Not built yet'}</div>;
}

export default function EnvCard({ env, demo, canDeploy, selected, onSelect, onDeploy, onSetUp }: {
  env: DashEnvironment; demo: boolean; canDeploy: boolean; selected: boolean;
  onSelect: () => void; onDeploy: (name: string) => void; onSetUp: () => void;
}) {
  const headingId = useId();
  const lit = env.state === 'active' || env.state === 'deploying';
  const name = env.environment;
  const released = env.last_release
    ? `Last release: ${env.last_release}${env.last_release_at ? ` · ${new Date(env.last_release_at).toLocaleDateString()}` : ''}`
    : 'No releases yet';
  const short = name ? 'Deploy' : 'Set up';
  const label = `${short} ${env.label}`;

  let action: ReactNode = null;
  if (demo) action = <SoonButton className="sd-btn-outline sd-btn-sm sd-env-action" title="Demo data">{short}</SoonButton>;
  else if (canDeploy && name && env.state === 'deploying') {
    action = <SoonButton className="sd-btn-outline sd-btn-sm sd-env-action" title="A deployment is running.">{short}</SoonButton>;
  } else if (canDeploy) {
    action = (
      <button type="button" className="sd-btn sd-btn-outline sd-btn-sm sd-env-action" aria-label={label}
              onClick={(e) => { e.stopPropagation(); if (name) onDeploy(name); else onSetUp(); }}>{short}</button>
    );
  }

  return (
    <section className={`sd-card sd-env${selected ? ' is-selected' : ''}${env.production ? ' is-production' : ''}`}
             aria-labelledby={headingId}>
      <button type="button" className="sd-env-select" aria-pressed={selected} aria-label={`Show ${env.label}`}
              onClick={onSelect} />
      <h3 id={headingId}>{env.label}</h3>
      {env.sub && <div className="sd-muted">{env.sub}</div>}
      <div className="sd-env-body">
        <div className="sd-slot-icon">
          <ServerRackIcon size={30} />
          <span className={`sd-icon-dot is-${lit ? 'blue' : 'muted'}`} aria-hidden="true" />
        </div>
        <div className="sd-env-main">
          <State env={env} />
          <div className="sd-muted">{released}</div>
        </div>
        {action}
      </div>
    </section>
  );
}
```

(For the existing tests' button names: `Set up Dev` → the placeholder's button's accessible name is `Set up Development`; update those tests to the new names — `Deploy uat`, `Set up Development`, `Set up Beta` — and the demo test's `Deploy to Dev` becomes the inert `Deploy`.)

- [ ] **Step 7: `DashboardPage`**

In `sirdar/web/src/pages/dashboard/DashboardPage.tsx`:
- docstring: "Sirdar Dashboard — the Deployments overview: health, the spotlight (the selected environment's flow: live traffic → load balancer or Nginx Proxy Manager → its servers, with Activate, Deploy and Open), the environment cards (Production first) and the infrastructure tree. `?demo=1` swaps in the API's sample; `?env=<id>` picks the spotlight, remembered per viewer."
- imports: drop `ProductionFlow`; add `ActivateModal` (`../../components/ActivateModal`), `Spotlight`, `type DashEnvironment`, `type DashServer`.
- selection:

```tsx
const STORAGE_KEY = 'sirdar.dashboard.env';
function remembered(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function remember(id: string): void {
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* storage blocked: the URL still carries it */ }
}
```

  inside the component:

```tsx
  const [activating, setActivating] = useState<{ card: DashEnvironment; server: DashServer } | null>(null);
  const cards = data?.environments ?? [];
  const fallback = cards.find((c) => c.production && c.environment) ?? cards[0];
  const wanted = params.get('env') ?? remembered();
  const selected = cards.find((c) => c.id === wanted) ?? fallback;
  const select = (id: string) => {
    remember(id);
    const next = new URLSearchParams(params);
    next.set('env', id);
    setParams(next, { replace: true });
  };
```

- the stack becomes:

```tsx
          <div className="sd-stack">
            {selected && (
              <Spotlight card={selected} demo={data.demo} motion={motion} canDeploy={can('deploy', 'add')}
                         canView={can('deploy', 'view')} canActivate={can('deploy', 'change')}
                         onDeploy={(name) => void openDeploy(name)} onSetUp={() => navigate('/deploy')}
                         onActivate={(server) => setActivating({ card: selected, server })} />
            )}
            <div className="sd-env-grid">
              {cards.map((env) => (
                <EnvCard key={env.id} env={env} demo={data.demo} canDeploy={can('deploy', 'add')}
                         selected={env.id === selected?.id} onSelect={() => select(env.id)}
                         onDeploy={(name) => void openDeploy(name)} onSetUp={() => navigate('/deploy')} />
              ))}
            </div>
            <InfraTree source={data.infrastructure.source} error={data.infrastructure.error}
                       tree={data.infrastructure.tree} refreshing={loading}
                       onRefresh={() => void load(true)} />
          </div>
```

- next to the `DeployModal` sibling:

```tsx
      {activating && activating.card.environment && (
        <ActivateModal envName={activating.card.environment} production={activating.card.production}
                       slot={activating.server.id} fromSlot={activating.card.flow.active_slot}
                       version={activating.server.version} onClose={() => setActivating(null)}
                       onStarted={(dep) => navigate(`/deploy/environments/${encodeURIComponent(activating.card.environment!)}?deployment=${dep.id}`)} />
      )}
```

- [ ] **Step 8: Styles**

In `sirdar/web/src/pages/dashboard/dashboard.css`: rename the `/* ---- production flow ---- */` comment to `/* ---- the spotlight's flow ---- */` and add:

```css
.sd-dash .sd-spot-head { align-items: center; }
.sd-dash .sd-spot-actions { margin-left: auto; display: inline-flex; gap: 8px; }
.sd-dash .sd-pill.is-warn { background: var(--sd-amber-soft); color: var(--sd-amber-text); border-color: color-mix(in srgb, var(--sd-amber) 45%, transparent); }
.sd-dash .sd-pill.is-bad { background: var(--sd-red-soft); color: var(--sd-red-text); border-color: color-mix(in srgb, var(--sd-red-text) 35%, transparent); }
.sd-dash .sd-pill.is-blue { background: var(--sd-blue-soft); color: var(--sd-blue); border-color: color-mix(in srgb, var(--sd-blue) 35%, transparent); }
.sd-dash .sd-node-status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sd-muted); }
.sd-dash .sd-node-lb.is-down { border-color: var(--sd-red-text); }
.sd-dash .sd-slot-tag.is-deploying { color: var(--sd-blue); }
.sd-dash .sd-slot-tag.is-failed { color: var(--sd-red-text); }
.sd-dash .sd-slot.is-failed { border: 2px solid var(--sd-red-text); padding: 13px 15px; }
.sd-dash .sd-slot.is-deploying { border: 2px solid var(--sd-blue); padding: 13px 15px; animation: sd-pulse 1.6s ease-in-out infinite; }
@keyframes sd-pulse { 50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--sd-blue) 18%, transparent); } }
.portal-shell[data-motion='off'] .sd-dash .sd-slot.is-deploying { animation: none; }
@media (prefers-reduced-motion: reduce) { .sd-dash .sd-slot.is-deploying { animation: none; } }

.sd-dash .sd-env { position: relative; }
.sd-dash .sd-env-select {
  position: absolute; inset: 0; z-index: 0; border: 0; border-radius: inherit; background: transparent; cursor: pointer;
}
.sd-dash .sd-env-select:focus-visible { outline: 2px solid var(--sd-blue); outline-offset: 2px; }
.sd-dash .sd-env > :not(.sd-env-select) { position: relative; z-index: 1; pointer-events: none; }
.sd-dash .sd-env .sd-btn { pointer-events: auto; }
.sd-dash .sd-env.is-selected { border-color: var(--sd-blue); box-shadow: 0 0 0 2px var(--sd-blue), var(--sd-shadow-strong); }
.sd-dash .sd-env-action { min-width: 0; }
```

- [ ] **Step 9: Run the tests and build**

Run: `npm --prefix sirdar/web test -- src/pages/dashboard && npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: the whole web suite passes; clean build (no `ProductionFlow`, `DashProduction` or `DashSlot` left: `grep -rn "ProductionFlow\|DashProduction\|DashSlot" sirdar/web/src` prints nothing).

- [ ] **Step 10: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/pages/dashboard/EnvironmentFlow.tsx sirdar/web/src/pages/dashboard/EnvironmentFlow.test.tsx sirdar/web/src/pages/dashboard/Spotlight.tsx sirdar/web/src/pages/dashboard/EnvCard.tsx sirdar/web/src/pages/dashboard/DashboardPage.tsx sirdar/web/src/pages/dashboard/DashboardPage.test.tsx sirdar/web/src/pages/dashboard/testData.ts sirdar/web/src/pages/dashboard/dashboard.css
git commit -m "feat(sirdar-web): the Deployments page spotlight — any environment's flow, Activate, selection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git mv` already staged the renames' deletions of `ProductionFlow.tsx` / `ProductionFlow.test.tsx`.)

---

### Task 11: Live verify in the Development account (controller, not a subagent)

Run by the controller after Tasks 1–10 are reviewed and committed on `sirdar` and the full suites pass, with Jimmy. Jimmy has approved the cost of one throwaway two-slot environment, built and deleted the same day. It folds in the 7a whole-phase checklist (`.superpowers/sdd/p7-live-verify-checklist.md`, items 1–14, marked **[C#]** below).

**Safety rules (repeat them to Jimmy before starting):**
- Only the **Development** account. Never touch the Production account's resources, and never V2 production.
- Jimmy types every token himself into Sirdar's Settings; the controller never sees, types or stores one.
- The only environment created, deployed, switched and deleted is `uat9`. Nothing else in the account changes; everything Sirdar makes carries `sirdar-env-<uat9's id>` or an `ss-uat9…` name.
- Let's Encrypt **staging** for uat9, so nothing hits production rate limits.

- [ ] **Step 1: Suites and the account (before anything)**

1. Controller: full Sirdar suite `SIRDAR_TEST_DB=sirdar_test_p7b .venv/bin/pytest -q` (about 12 minutes), `SS_STACK_E2E=1 … tests/test_deploy_stack_external.py`, the deploy-stack suite, the api `tests/test_cert_worker.py` (`PYTHONPATH=src SS_TEST_DB=serversherpa_test_p7b /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest -q tests/test_cert_worker.py tests/test_db_tls.py` from `api/`), `npm --prefix sirdar/web test`, `npm --prefix sirdar/web run build`, ruff on every changed Python file. All green, then drop the test DBs.
2. Jimmy, in the Development DigitalOcean team: an account token (full access, or read + write) and the renewal token (API › Generate New Token › Custom Scopes: `certificate` create/read/delete, `load_balancer` read/update).
3. Record in the ledger what's tagged `sirdar` already (Jimmy: `doctl compute droplet list --tag-name sirdar`, `doctl databases list`, `doctl compute load-balancer list`, `doctl vpcs list`, Spaces keys in the control panel) to compare at the end.

- [ ] **Step 2: Update Tower's Sirdar to the branch head**

1. Push `sirdar` to GitHub, with Jimmy's go-ahead.
2. Update Tower's Sirdar with the installer pinned to that SHA (memory: `SIRDAR_DIR=/mnt/user/serversherpa/sirdar`).
3. `alembic current` in the Sirdar container shows `0010`; Settings › Integrations shows both DigitalOcean account cards (the old token as the Production account); the Deployments page shows the Production placeholder first.

- [ ] **Step 3: Set up the Development account (Jimmy types)**

1. Settings › Integrations › DigitalOcean · Development › Set up: label, both tokens, region.
2. Test: Account, Team, Droplets, Region pass; Renewal token passes (a warn means the token can read droplets: make a narrower one). **[C12]** `/v2/account` returns `team.uuid` for the account (and, read only, for the Production account's existing token) and the renewal token's read checks pass.
3. Save. The audit row `deploy.do_account_update` lists `token` and `renewal_token`, never a value.
4. Deploy page: DigitalOcean card, Account Development, regions load, Test connection passes.

- [ ] **Step 4: Create uat9 from the uat snapshot**

New environment › name `uat9`, type Dev, target DigitalOcean › DigitalOcean step: account Development, Two slots, default sizes, Standby Off, Certificate **Let's Encrypt staging**, Activate automatically **Off** › Data: From a snapshot (`uat-2026-10-05` or the newest uat snapshot) › Create. Overview › DigitalOcean: account, sizes, "Built by the first deploy".

- [ ] **Step 5: First deploy (orange goes live by itself)**

1. Deploy › the modal says "Deploys to Orange and goes live when its smoke test passes."
2. Step 0's log, in order: the team; `Created the VPC ss-uat9`; the bucket, its key and CORS; both droplets; `Creating the database cluster ss-uat9-db`, the firewall line, `online at private-…:25060`; two pinned host keys; the commit; `Database: serversherpa owns serversherpa`; the staging certificate (five DNS challenge lines); `Creating the load balancer ss-uat9-lb`, `active at <ip>`; the cloud firewall.
   - **[C1]** The DB create with `rules` is accepted; its firewall lists only droplet IDs; the cluster is in the VPC (`private_network_uuid`); `private_connection.host` and port 25060.
   - **[C2]** `openssl s_client -starttls postgres -connect private-…:25060 -CAfile ca.pem -verify_hostname private-…` from a droplet verifies (else every verify-full connection fails).
   - **[C3]** doadmin can CREATE ROLE, GRANT serversherpa TO doadmin, CREATE DATABASE … OWNER; the seed's DROP SCHEMA public CASCADE + pg_restore as serversherpa works, including citext, pg_trgm and the ICU collation (0082).
   - **[C5]** The load balancer is accepted with `droplet_ids: []`; a PUT from the live body isn't rejected; health checks reach Caddy `/healthz` (Host outside `*.domain`); note the time to healthy vs the 40 s settle; HTTP:80 forwards `X-Forwarded-Proto: http`; `X-Forwarded-For` is appended and the API logs the real client IP.
   - **[C6]** The firewall GET shows how DigitalOcean writes "all"/icmp ports (`_rule_key`); `load_balancer_uids` admits the load balancer on 80.
   - **[C7]** Spaces: the bucket PUT's signing region; HEAD of a missing bucket under the bucket-scoped key answers 404 or 403 (403 breaks step 0); the scoped read-write key can HEAD/GET/PUT; the secret is shown once; the temporary full-access key is emptied and deleted; the CORS PUT works.
3. Then 1–10 (restore onto the managed database and Spaces), 12 DNS at the load balancer IP, 13 slot smoke, 14 Switch traffic (public smoke without certificate checks: staging).
   - **[C4]** Caddy at 172.30.0.2 after `up` and after a droplet reboot; `docker network inspect ss-uat9` shows ip-range `.128/25`.
   - **[C8]** `bundle.py` path-style export/import against `https://<region>.digitaloceanspaces.com/<bucket>`; the app's presigned GET/PUT (virtual-hosted); a wiki upload in the browser (CORS).
   - **[C11]** The metadata block: the DOCKER-USER reject is present after bootstrap and after a Docker restart; a container can't reach 169.254.169.254.
4. Jimmy in the control panel: the database's trusted sources are exactly the two droplets; the bucket key is limited to the bucket; the load balancer targets `ss-uat9-orange`; the cloud firewall applies to the `sirdar-env-<id>` tag.
5. From the Mac: `curl -sk https://api.uat9.serversherpa.com/healthz` answers 200; signing in at `https://portal.uat9.serversherpa.com` works with a uat account.
6. The `.env` on the droplet (Jimmy, read the key names only): `SS_CERT_DO_TOKEN`, `SS_CERT_LB_ID`, `SS_CERT_NAMES`, `SS_CERT_ACME_DIRECTORY` (staging), `SS_CERT_ACME_KEY`, a decimal `STACK_DROPLET_ID`; `docker compose … --profile certs ps` shows `cert-worker` up.
7. Dashboard: uat9's card, then its spotlight (click the card; `?env=uat9`): load balancer IP and Active, orange Live with dots to it, purple Idle, the certificate pill.

- [ ] **Step 6: Deploy to purple and Activate it**

1. Deploy again: "Deploys to Purple. Traffic stays on Orange until you activate Purple."; it stops after 13; Deployments shows "Update to Purple, not live"; the spotlight shows purple Idle and deployed.
2. Activate Purple from the spotlight (and later from Overview › DigitalOcean). The deployment runs 13 and 14; step 14's log: purple joins orange, `/healthz`, the settle, the public smoke, only purple, the re-check, the second smoke. The public URLs answer throughout (a `while curl …; sleep 1` loop from the Mac shows no failure). Jimmy: the load balancer targets `ss-uat9-purple`.
3. Activate Orange again, then Purple once more. A forced failure (Jimmy stops the api container on the idle slot first) fails 13 and leaves orange live: the spotlight says "Failed — Orange still live"; Retry after starting it again succeeds.
4. Settings › DigitalOcean: Activate automatically On; Deploy → it goes to the idle slot and goes live by itself. Turn it Off again.

- [ ] **Step 7: Renewal**

1. **[C14]** cert-worker (staging): Jimmy opens the Droplet Console for the live slot as `deploy`. If the console can't log in as `deploy`, stop here, record "cert-worker renewal not verified live", and go on.

   ```bash
   cd /opt/serversherpa/uat9/repo/deploy/stack
   C="docker compose --env-file /opt/serversherpa/uat9/.env -f api/compose.yml --profile certs"
   $C stop cert-worker
   $C run --rm --use-aliases cert-worker serversherpa cert-worker --once --renew-days 90
   $C start cert-worker
   ```

   Expected: `renewed`; the load balancer uses a new certificate `ss-uat9-<UTC now>` and the previous one is gone. On the idle slot the same command prints `not_active`; during an Activate it prints `switching` (the sole-target rule).
2. The next Deploy's step 0 logs "Recorded the certificate ss-uat9-… the cert-worker uploaded." and issues nothing.
3. Sirdar's backup renewal: on Tower set `SIRDAR_CERT_CHECK_SECONDS=300` for this run only (restart), and in Sirdar's database set uat9's `do_environments.cert_not_after` to now + 10 days (Jimmy runs the SQL). Within about 10 minutes a `renew` deployment appears ("Renew certificate", step 19, no actor); it issues by DNS-01 (staging), moves the load balancer's HTTPS rule and deletes the old certificate; uat9's status stays `ready`. Put the setting back.
4. **[C10]** Note how long a certificate delete right after a load-balancer change stays refused (403/409/422).

- [ ] **Step 8: Grow, and add a slot on a second environment (optional, Jimmy decides)**

1. Settings › DigitalOcean: droplet size one step up › Save sizes; Deploy: step 0 logs `Resizing ss-uat9-<idle> to …` (power off, resize, power on) only for the idle slot; the live slot keeps serving.
2. If Jimmy approves a second throwaway: a one-slot `uat10`, deploy, Settings › Add a second slot: its deployment builds purple and deploys the running commit to it without moving traffic; delete `uat10` afterwards like uat9.

- [ ] **Step 9: Delete and confirm nothing tagged remains**

1. Settings › Delete environment › "Save a snapshot first" stays on › type `uat9`. The plan is 11 Take snapshot, 17 Remove DNS records, 18 Remove DigitalOcean resources.
2. Step 18's log ends with "Nothing of this environment is left on DigitalOcean." The snapshot `uat9-before-delete-…` is Ready under Snapshots.
   - **[C9]** How long the VPC delete lags after the droplets and cluster go (step 18 waits up to 10 minutes).
3. **[C13]** Jimmy (control panel and `doctl`): nothing tagged `sirdar-env-<id>`; no droplet, database, load balancer, certificate, firewall, VPC, Spaces key or bucket named `ss-uat9…`; the list matches Step 1's "before". Cloudflare has no `*.uat9` records and no `_acme-challenge` TXT left.
4. Anything left: record it, delete it by hand with Jimmy, open a follow-up.

- [ ] **Step 10: Record and clean up**

1. Ledger entry: what passed, timings (step 0, the restore, Activate, the renewals), every **[C#]** item confirmed or corrected, copy fixes. Fix what the run finds in small commits `fix(sirdar): …` / `fix(sirdar-web): …` (full suites again before merging).
2. Update the memory note `sirdar.md` and the Features wiki page row with the phase 7 status.
3. Ask Jimmy whether to merge `sirdar` to main and push.

## Self-review notes (for the controller)

- **Spec coverage.** DigitalOcean spec: Activate / auto-activate / Deactivate (§4) → Task 1; add a slot (§4) and grows (§2) → Task 2; cert-worker `.env` and Sirdar's backup renewal (§3) → Task 4 (the worker itself: Task 3, done); accounts in the UI and per-account regions/connect (§8) → Tasks 2, 6, 7; production Delete rules in the UI (§6) → Task 9; live verify (§10) → Task 11. Spotlight spec: §1 layout → Task 10 (Spotlight, cards, Production first, placeholder with Set up); §2 flows per environment → Task 5 (data) and Task 10 (`EnvironmentFlow`: one/two servers, proxy/LB/none, dots on the live path only, deploying pulse, failed red with "Failed — <Live> still live", motion off static, remount re-measures); §3 actions → Task 10 (Activate only for a deployed idle slot with `deploy:change`, Deploy, Open, demo inert) using Task 9's `ActivateModal`; §4 selection → Task 10; §5 data shape → Task 5 (and demo); §6 components → Task 10; §7 testing → Tasks 5 and 10. The 7a reports' carry-forwards: Activate/Deactivate routes (`cloud=True`, slot/None, 409 `slot_not_deployed`, typed name) → Task 1; restore on a shared DB → Task 2 (no 7b path restores while another slot has run: documented in `ss-stack`, and the added slot's deploy is tested not to seed); `do_api.get_action` with `action_polls` → Task 2; `SS_CERT_*` (strict base64 ACME key, decimal `STACK_DROPLET_ID`), `EXTRA_KEYS` and `env.example`, the redactor, 14-day backup renewal → Task 4 (`switching` is checked in Task 11); "failed, but <slot> still live" → Tasks 5 and 10; Delete's "Save a snapshot first" (on, forced for production), `confirm_production` on Delete and its retry → Task 9; Reset / Restore backup / Roll back hidden on DigitalOcean → Tasks 6 (`NOT_ON_DO`) and 9; deployment rows with slot and go_live → Tasks 6 (`deploymentLabel`) and 9.
- **Names across tasks.** Python: `steps.plan_for(..., smoke)`, `pipeline.smokes(mode, slot)`, routes `CHANGE_MODES`, `_refuse`, `ActivateIn`, `activate`, `add_slot`, `DoPatch`, `_checked_sizes`, `DoAccountKey`; `do_envs.check_grow/apply_sizes`; `DigitalOceanApi.get_action`; `DoProvisioner._droplet_action/_resize_droplet/_renew`; `renewals.due/start_due/loop/FIRST_DELAY_SECONDS`; `Settings.cert_check_seconds`; `service.cert_info/_do_flow/_lan_flow/_empty_flow/_marks/_read_accounts`. Web: `getDoAccounts/saveDoAccount/testDoAccount/clearDoAccount/getDoRegions(account)/connectDeploy(…, account)/activateSlot/addSlot`; `onDo/isDoTarget/slotTitle/idleSlot/goesLive/certDaysLeft/deploymentLabel/retryNeedsName/CHANGE_MODES/NOT_ON_DO/DO_RESOURCE_LABEL`; `ActivateModal`, `DoAccountModal`, `DoMachineSection`, `DoSettingsSection`, `EnvironmentFlow`, `Spotlight`, `EnvCard`; fixtures `DO_ACCOUNTS`, `DO_ACCOUNTS_BOTH`, `DO_ENV`, `ONE_SLOT_ENV`, `PROD_ENV`, `DO_TARGETS`, `DO_UPDATE`, `NONE_FLOW`, `PROD_CARD`, `DO_CARD`, `FAILED_DO_CARD`, `LAN_CARD`, `PLACEHOLDER_PROD`, `CLOUD`.
- **Judgment calls to watch in review.** Deactivate exists only for a retiring production; auto-activate can be chosen at create (`do.auto_activate`) as well as in PATCH; a non-production Activate retry needs `deploy:change` but no typed name; the backup renewal is a deployment (it waits for any running one) and keeps the status; with two accounts the infrastructure tree gets one group node per account (one account: exactly today's tree); a LAN server's health is derived from the environment's status (no probe); the spotlight's default is the production environment, else the first card (the production placeholder).
