# Sirdar deploy phase 2b (UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the phase 2a deploy backend its UI: environments on `/deploy` (list, New environment create/adopt), an environment detail page (Overview, Deployments with live logs, cancel and retry, Settings), a Deploy modal (Update / Reset data, host-key trust), the sudo password on saved SSH targets, and real environments on the Dashboard.

**Architecture:** Everything is web code in `sirdar/web/src` over the existing `/api/deploy` routes, plus three small API additions the UI needs (an environment-defaults endpoint, `imported_secrets` in the adopt response, environments in `GET /api/dashboard`). Environment pages live in a new folder `pages/environments/`; shared pieces (`SecretField`, `useHostKeyTrust`, `lib/envRules.ts`, `lib/arrowNav.ts`) are extracted so the SSH target modal, the New environment modal, the Deploy modal and the Settings tab share them. Live progress is polling (`GET /api/deploy/deployments/{id}` every 2 s while `running`), as the 2a context decided.

**Tech Stack:** React 18 + TypeScript 5.6 + react-router-dom 6 + Vitest 3 / Testing Library (jsdom) on the web; FastAPI + SQLAlchemy 2 (async) + pytest on real Postgres for the API; portal components through `@portal` (`DataTable`, `ComboBox`, `Switch`, `AuthContext`, `lib/api`).

## Global Constraints

- Every new modal gets the report-generate header (eyebrow, title, description, and steps where the modal has steps) and sizes to its content: a wide card, a content-matched grid, and dropdowns that aren't clipped.
- Reuse the existing portal and Sirdar idioms (DataTable, ComboBox, segmented control, chip, form classes). Never use raw native `<select>` or unstyled controls.
- Lists follow the list column-floor conventions where Sirdar's existing tables do.
- Don't add reader-facing widgets that weren't asked for.
- All copy is in American English.
- Component tests start with `// @vitest-environment jsdom`, mock `../lib/sirdarApi` and the auth context the way `Deploy.test.tsx` does, and use fake timers for polling.
- New `@portal` imports must pass `portalImports.test.ts`. Extend the allowlist only when unavoidable, and say so.
- Web tests run with `npm --prefix sirdar/web test`. Type-check with `npm --prefix sirdar/web run build` (`tsc --noEmit` + vite). Don't run `npm install` in this worktree. Its node_modules are present, so check whether they're symlinked before relying on them.
- Backend tests (if any) run with `.venv/bin/pytest -q` from `sirdar/api`.

Repo-specific facts every task relies on:

- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Every command below runs from that folder unless it says `cd sirdar/api`.
- `sirdar/web/node_modules` is a real folder (not a symlink); `portal/node_modules` in this worktree is a symlink to the main checkout's. Never run `npm install` here.
- No new `@portal` import is needed: this plan only uses `auth/AuthContext`, `components/DataTable`, `components/ComboBox`, `components/Switch` and `lib/api`, all already allowlisted. The allowlist is not extended.
- Sirdar's existing tables (`Deploy.tsx`, `Users.tsx`) use `DataTable` with no column floors, `list-scroll` or `ColumnMenu`; the new tables follow the same pattern (so "where Sirdar's existing tables do" means: none here).
- `tsc` type-checks the tests too (`include: ["src"]`, `noUnusedLocals`, `noUnusedParameters`): no unused imports, variables or parameters in tests either (a parameter may be prefixed `_`).
- Ruff line length is 100 (`cd sirdar/api && .venv/bin/ruff check src tests`).
- Commit messages end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Backend facts the UI follows (verified against the code, not the 2a plan)

- Routes (all under `/api/deploy`): `GET /environments` (view) → `{environments: Environment[]}`; `GET /environments/{name}` (view); `POST /environments` (add) body `{mode: "new"|"adopt", name, type: "dev"|"beta"|"custom", target: "ssh"|"ssh:<slug>", git_ref="main", base_domain?, proxy_ip?, bind_ip="0.0.0.0", ports={}}` → 201; `PATCH /environments/{name}` (change); `POST /environments/{name}/deployments` (add; `mode: "reset"` also needs change + `confirm_name`) → 201 deployment; `GET /environments/{name}/deployments?limit=20` → `{deployments: DeploymentSummary[]}` newest first; `GET /deployments/{id}?tail=8000` → deployment with `steps[].log_tail`; `POST /deployments/{id}/cancel` (change) → 202 `{id, status: "cancelling"|"cancelled"}`; `POST /deployments/{id}/retry` (add; a reset deployment also needs change + `confirm_name`) body `{from_step?, confirm_name?}` → 201 deployment.
- Environment status: `new | ready | deploying | failed`. Deployment status: `running | succeeded | failed | cancelled | interrupted | adopted`. Step status: `pending | running | succeeded | failed | skipped | not_run | cancelled | interrupted`.
- Steps are numbered by `steps.STEPS`: update = 1, 2, 3, 4, 5, 6, 8; reset = 1, 2, 3, 4, 5, 7, 8 (spec steps 8–11 are one step, 8 "Start services").
- Retry's default and ceiling is the API's `_stopped_step`: the first step whose status is `failed`, `cancelled` or `interrupted`, else the first `not_run` step; `from_step` must be a step of the mode's plan and `<=` that step. Only the environment's latest deployment can be retried (`retry_not_latest`).
- Optional secrets editable through PATCH: `SS_ANTHROPIC_API_KEY`, `SS_DB_TESTING_PASSWORD` (`""` clears one). Allowed characters: `[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}`.
- Host-key failures keep the `/connect` shapes: 409 `host_key_unknown {host, port, key_type, fingerprint}`, 409 `host_key_mismatch {host, port, key_type, expected, actual}`, 502 `connect_failed {reason}`. Trusting needs `deploy:change`.

## File map

API (`sirdar/api`)
- Modify `src/sirdar_api/deploy/environments.py` — `DEFAULT_DOMAIN_SUFFIX`, `DEFAULT_GIT_REF`, `DEFAULT_BIND_IP` constants used by `create_new`.
- Modify `src/sirdar_api/api/routes/deploy.py` — `GET /deploy/environment-defaults`; adopt response adds `imported_secrets`.
- Modify `src/sirdar_api/dashboard/service.py` — environment cards from the `environments` table; health from them.
- Modify `src/sirdar_api/dashboard/demo.py` — demo cards carry the new keys.
- Modify `src/sirdar_api/api/routes/dashboard.py` — pass the DB session.
- Tests: `tests/test_deploy_environments_api.py`, `tests/test_dashboard_api.py`.

Web (`sirdar/web/src`)
- Modify `lib/sirdarApi.ts` — environment/deployment types, ten endpoint functions, `MESSAGES` for every deploy error code, `deployErrorText`, `sudo_password` on SSH targets, new `DashEnvironment` keys. Test: `lib/sirdarApi.test.ts` (new).
- Create `lib/envRules.ts` (+ `envRules.test.ts`) — name, ref, IPv4 and port checks (moves `nameProblem` out of `Deploy.tsx`).
- Create `lib/arrowNav.ts` — the radiogroup arrow-key helper (moved out of `Deploy.tsx`).
- Create `components/SecretField.tsx` (+ test) — the write-only secret field extracted from `SshTargetModal.tsx`, with `disabled`.
- Modify `components/SshTargetModal.tsx` (+ test) — Sudo password field.
- Modify `components/HostKeyModal.tsx` (+ test) — optional `trustLabel`.
- Create `components/useHostKeyTrust.tsx` — host-key trust flow shared by three modals/views.
- Create `pages/environments/labels.tsx` (+ `labels.test.ts`) — status chips, labels, `stoppedStep`, `duration`, `sshTargets`.
- Create `pages/environments/testData.ts` — fixtures for every environments test.
- Create `pages/environments/EnvironmentsSection.tsx` (+ test) — the list on `/deploy` and the New environment button.
- Create `pages/environments/NewEnvironmentModal.tsx` (+ test) — Create (Basics › Services › Review) and Adopt (Basics › Result).
- Create `pages/environments/DeployModal.tsx` (+ test) — ref, Update / Reset data, typed-name gate, host-key trust.
- Create `pages/environments/EnvironmentDetail.tsx` (+ test) — `/deploy/environments/:name` with tabs.
- Create `pages/environments/EnvOverview.tsx` — Overview tab.
- Create `pages/environments/DeploymentsTab.tsx` (+ test) and `DeploymentView.tsx` (+ test) — history, step list, live log polling, Cancel, Retry from step.
- Create `pages/environments/EnvSettings.tsx` (+ test) — Settings tab.
- Modify `pages/Deploy.tsx` (+ `Deploy.test.tsx`) — Environments section first; helpers imported from `lib/`.
- Modify `App.tsx`, `layout/SirdarTopbar.tsx` — route and crumb title.
- Modify `pages/dashboard/{parts.tsx, EnvCard.tsx, DashboardPage.tsx, testData.ts, DashboardPage.test.tsx, dashboard.css}` — real environment cards, Deploy modal, "Coming later".
- Modify `styles/sirdar.css` — the new classes.

---

### Task 1: API — environment defaults endpoint and imported secret names on adopt

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (constants after `ENV_TYPES`; `create_new` signature and domain default)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (import list; new route before `@router.get("/environments")`; adopt branch of `create_environment`)
- Test: `sirdar/api/tests/test_deploy_environments_api.py`

**Interfaces:**
- Consumes: `envfile.SERVICES`, `envfile.PUBLIC_SERVICES`, `envfile.DEFAULT_PORTS`, `envfile.ENV_ROOT`, `envfile.DEFAULT_KEEP_DUMPS`, `envfile.DEFAULT_SPACES_BUCKET`, `envfile.LOG_LEVELS`, `envfile.OPTIONAL_SECRETS`; `AdoptReport.imported_secrets`.
- Produces: `GET /api/deploy/environment-defaults` (`deploy:view`) → `{services: [{service: str, port: int, public: bool}], domain_suffix: str, env_root: str, git_ref: str, bind_ip: str, keep_dumps: int, spaces_bucket: str, log_levels: [str], optional_secrets: [str]}`. Adopt (`POST /environments` with `mode: "adopt"`) response = `environment_out` + `ignored_keys: [str]` + `imported_secrets: [str]` (names only, sorted).

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_environments_api.py`, add under the `NEW = {...}` constant:

```python
DEFAULTS_URL = "/api/deploy/environment-defaults"
```

Add this test after `test_permissions`:

```python
async def test_environment_defaults(client, db):
    assert (await client.get(DEFAULTS_URL)).status_code == 401
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.get(DEFAULTS_URL, headers=admin)
    assert resp.status_code == 200
    assert resp.json() == {
        "services": [{"service": "api", "port": 8000, "public": True},
                     {"service": "portal", "port": 8091, "public": True},
                     {"service": "kiosk", "port": 8090, "public": True},
                     {"service": "wiki", "port": 8096, "public": True},
                     {"service": "spaces", "port": 9000, "public": True},
                     {"service": "status", "port": 8095, "public": True},
                     {"service": "mailpit", "port": 8025, "public": False}],
        "domain_suffix": "serversherpa.com", "env_root": "/opt/serversherpa", "git_ref": "main",
        "bind_ip": "0.0.0.0", "keep_dumps": 5, "spaces_bucket": "serversherpa",
        "log_levels": ["DEBUG", "INFO", "WARNING", "ERROR"],
        "optional_secrets": ["SS_ANTHROPIC_API_KEY", "SS_DB_TESTING_PASSWORD"]}
```

In `test_adopt_environment`, replace

```python
    assert set(body) == ENV_KEYS | {"ignored_keys"}
```

with

```python
    assert set(body) == ENV_KEYS | {"ignored_keys", "imported_secrets"}
    assert body["imported_secrets"] == sorted(envfile.REQUIRED_SECRETS)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && .venv/bin/pytest -q tests/test_deploy_environments_api.py -k "defaults or adopt_environment"`
Expected: 2 failed — `test_environment_defaults` (an unknown route answers 404, not 401) and `test_adopt_environment` (`imported_secrets` missing from the body).

- [ ] **Step 3: Implement**

In `sirdar/api/src/sirdar_api/deploy/environments.py`, after `ENV_TYPES = ("dev", "beta", "custom")` add:

```python
DEFAULT_DOMAIN_SUFFIX = "serversherpa.com"
DEFAULT_GIT_REF = "main"
DEFAULT_BIND_IP = "0.0.0.0"
```

Change the `create_new` signature and its domain default:

```python
async def create_new(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                     target_id: str, git_ref: str = DEFAULT_GIT_REF,
                     base_domain: str | None = None, proxy_ip: str | None = None,
                     bind_ip: str = DEFAULT_BIND_IP, ports: dict[str, int] | None = None,
                     actor_id=None) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets."""
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
    domain = _check_domain(base_domain or f"{name}.{DEFAULT_DOMAIN_SUFFIX}")
```

(the rest of `create_new` is unchanged).

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, add `envfile` to the package import (keep the list sorted):

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
    serialize,
    ssh,
    targets,
    vault,
)
```

Insert this route directly above `@router.get("/environments")`:

```python
@router.get("/environment-defaults")
async def environment_defaults(actor: AuthContext = require_permission("deploy", "view")):
    """What the New environment form prefills: the same values create_new uses."""
    return {
        "services": [{"service": s, "port": envfile.DEFAULT_PORTS[s],
                      "public": s in envfile.PUBLIC_SERVICES} for s in envfile.SERVICES],
        "domain_suffix": environments.DEFAULT_DOMAIN_SUFFIX, "env_root": envfile.ENV_ROOT,
        "git_ref": environments.DEFAULT_GIT_REF, "bind_ip": environments.DEFAULT_BIND_IP,
        "keep_dumps": envfile.DEFAULT_KEEP_DUMPS, "spaces_bucket": envfile.DEFAULT_SPACES_BUCKET,
        "log_levels": list(envfile.LOG_LEVELS),
        "optional_secrets": list(envfile.OPTIONAL_SECRETS),
    }
```

At the end of `create_environment`, replace

```python
    if report is not None:
        out["ignored_keys"] = report.ignored_keys
    return out
```

with

```python
    if report is not None:
        # Names only: what adopt read from the target's .env.
        out["ignored_keys"] = report.ignored_keys
        out["imported_secrets"] = report.imported_secrets
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sirdar/api && .venv/bin/pytest -q tests/test_deploy_environments_api.py tests/test_deploy_environments.py && .venv/bin/ruff check src tests`
Expected: all pass (the existing `leak_guard` in `test_adopt_environment` still passes: secret names are not secret values); `All checks passed!`

- [ ] **Step 5: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_environments_api.py
git commit -m "feat(sirdar): environment defaults endpoint and imported secret names on adopt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API — real environments on the Dashboard

**Files:**
- Modify: `sirdar/api/src/sirdar_api/dashboard/service.py` (docstring, imports, new helpers, `build_dashboard`)
- Modify: `sirdar/api/src/sirdar_api/dashboard/demo.py:64-69` (demo environment cards)
- Modify: `sirdar/api/src/sirdar_api/api/routes/dashboard.py`
- Test: `sirdar/api/tests/test_dashboard_api.py`

**Interfaces:**
- Consumes: `Environment`, `Deployment` models; `names`, `_label` in `service.py`.
- Produces: `async build_dashboard(settings, *, db: AsyncSession | None = None, demo=False, refresh=False) -> dict`. Each `environments[]` card is `{id, label, sub, state, version, last_release, last_release_at, action_label, environment}`:
  - a Sirdar environment → `id = label = environment = name`, `sub` = "Development" / "Beta" / "Custom", `state` = `deploying` | `failed` | `active` (has a `current_sha`) | `empty`, `version` = `image_tag` or the first 8 of `current_sha`, `last_release` = first 8 of the newest `succeeded`/`adopted` deployment's SHA, `last_release_at` = its `finished_at` ISO string, `action_label` = `"Deploy <name>"`.
  - a placeholder (no environment of type dev / beta yet, or a DigitalOcean `sirdar-env:` tag with no matching environment) → `environment: null`, `action_label` = `"Set up Dev"` / `"Set up Beta"` / `"Set up <Label>"`.
  - order: dev-type environments (by name) or the Dev placeholder, beta-type or the Beta placeholder, custom-type by name, then DigitalOcean-only tags.
  - `health`: `degraded` / "A deployment failed" if any environment card is `failed`; else `healthy` / "Environments deployed" if any is `active`; else `unknown` / "No environments deployed".

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_dashboard_api.py`, extend the imports:

```python
import json
from datetime import UTC, datetime

import pytest

from sirdar_api.config import get_settings
from sirdar_api.dashboard import service
from sirdar_api.dashboard.demo import demo_dashboard
from sirdar_api.db.models import Deployment
from sirdar_api.deploy import digitalocean

from .api_helpers import auth_headers
from .deploy_factories import make_environment
from .test_dashboard_inventory import do_transport
from .test_deploy_digitalocean import TOKEN

SHA = "e73b99ca" + "1" * 32
```

Append these tests:

```python
async def test_real_environments(client, db):
    uat = await make_environment(db, name="uat", current_sha=SHA, secrets={})
    qa = await make_environment(db, name="qa-east", status="failed", secrets={})
    qa.type = "custom"
    db.add(Deployment(environment_id=uat.id, mode="adopt", git_ref="main", sha=SHA,
                      status="adopted", start_step=1,
                      finished_at=datetime(2026, 10, 3, 12, 0, tzinfo=UTC)))
    db.add(Deployment(environment_id=uat.id, mode="update", git_ref="main", sha="b" * 40,
                      status="failed", start_step=1,
                      finished_at=datetime(2026, 10, 3, 13, 0, tzinfo=UTC)))
    await db.commit()
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert d["environments"] == [
        {"id": "uat", "label": "uat", "sub": "Development", "state": "active",
         "version": "e73b99ca", "last_release": "e73b99ca",
         "last_release_at": "2026-10-03T12:00:00+00:00", "action_label": "Deploy uat",
         "environment": "uat"},
        {"id": "beta", "label": "Beta", "sub": None, "state": "empty", "version": None,
         "last_release": None, "last_release_at": None, "action_label": "Set up Beta",
         "environment": None},
        {"id": "qa-east", "label": "qa-east", "sub": "Custom", "state": "failed",
         "version": None, "last_release": None, "last_release_at": None,
         "action_label": "Deploy qa-east", "environment": "qa-east"}]
    assert d["health"] == {"status": "degraded", "label": "A deployment failed"}


async def test_health_when_an_environment_is_deployed(client, db):
    await make_environment(db, name="uat", current_sha=SHA, secrets={})
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert d["health"] == {"status": "healthy", "label": "Environments deployed"}
    assert [(e["id"], e["state"]) for e in d["environments"]] == [
        ("uat", "active"), ("beta", "empty")]


async def test_a_tagged_droplet_with_an_environment_gets_one_card(client, db, with_token):
    env = await make_environment(db, name="qa-team", secrets={})
    env.type = "custom"
    await db.commit()
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert [(e["id"], e["environment"]) for e in d["environments"]] == [
        ("dev", None), ("beta", None), ("qa-team", "qa-team")]
```

In `test_real_no_token` replace the last assertion with:

```python
    assert [(e["id"], e["state"], e["last_release"], e["environment"], e["action_label"])
            for e in d["environments"]] == \
        [("dev", "empty", None, None, "Set up Dev"), ("beta", "empty", None, None, "Set up Beta")]
```

In `test_demo`, after the `environments` assertion, add:

```python
    assert all(e["environment"] is None and e["sub"] is None and e["last_release_at"] is None
               for e in d["environments"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && .venv/bin/pytest -q tests/test_dashboard_api.py`
Expected: FAIL — `test_real_environments`, `test_health_when_an_environment_is_deployed`, `test_a_tagged_droplet_with_an_environment_gets_one_card`, `test_real_no_token` (KeyError `environment`) and `test_demo` fail; the rest pass.

- [ ] **Step 3: Implement**

`sirdar/api/src/sirdar_api/api/routes/dashboard.py` becomes:

```python
"""Dashboard overview. Never carries the DigitalOcean token."""

from fastapi import APIRouter, Query

from sirdar_api.api.deps import AuthContext, DbSession, require_permission
from sirdar_api.config import get_settings
from sirdar_api.dashboard.service import build_dashboard

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("")
async def get_dashboard(db: DbSession, demo: bool = Query(default=False),
                        refresh: bool = Query(default=False),
                        actor: AuthContext = require_permission("dashboard", "view")):
    return await build_dashboard(get_settings(), db=db, demo=demo, refresh=refresh)
```

In `sirdar/api/src/sirdar_api/dashboard/service.py`:

Replace the module docstring with:

```python
"""Dashboard data. Environment cards come from Sirdar's environments (deploy
step 2), with Dev / Beta placeholders until environments of those types
exist; DigitalOcean inventory (grouped by sirdar-* tags) fills the
infrastructure tree. Production Blue/Green has no records yet, so it stays
empty."""
```

Replace the import block with:

```python
import hashlib
import time
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.dashboard.demo import demo_dashboard, node
from sirdar_api.db.models import Deployment, Environment
from sirdar_api.deploy import ConnectFailed, digitalocean, names, targets
```

After `_DROPLET = {...}` add:

```python
_TYPE_LABELS = {"dev": "Development", "beta": "Beta", "custom": "Custom"}
_RELEASED = ("succeeded", "adopted")
```

Directly above `async def build_dashboard` add:

```python
def _env_state(env: Environment) -> str:
    if env.status in ("deploying", "failed"):
        return env.status
    return "active" if env.current_sha else "empty"


async def _last_release(db: AsyncSession, env_id) -> Deployment | None:
    return await db.scalar(select(Deployment)
                           .where(Deployment.environment_id == env_id,
                                  Deployment.status.in_(_RELEASED))
                           .order_by(Deployment.finished_at.desc().nulls_last(),
                                     Deployment.created_at.desc())
                           .limit(1))


async def _environment_card(db: AsyncSession, env: Environment) -> dict:
    last = await _last_release(db, env.id)
    version = env.image_tag or (env.current_sha[:8] if env.current_sha else None)
    return {"id": env.name, "label": env.name,
            "sub": _TYPE_LABELS.get(env.type, env.type.title()), "state": _env_state(env),
            "version": version, "last_release": last.sha[:8] if last else None,
            "last_release_at": (last.finished_at.isoformat()
                                if last and last.finished_at else None),
            "action_label": f"Deploy {env.name}", "environment": env.name}


def _placeholder(env: str, action_label: str) -> dict:
    return {"id": env, "label": _label(env), "sub": None, "state": "empty", "version": None,
            "last_release": None, "last_release_at": None, "action_label": action_label,
            "environment": None}


async def environment_cards(db: AsyncSession | None, tagged: list[str]) -> list[dict]:
    """Sirdar environments, a Dev / Beta placeholder while no environment has
    that type, then DigitalOcean env tags no environment answers to."""
    rows: list[Environment] = []
    if db is not None:
        rows = list(await db.scalars(select(Environment).order_by(Environment.name)))
    cards: list[dict] = []
    for type_, short in (("dev", "Dev"), ("beta", "Beta")):
        typed = [e for e in rows if e.type == type_]
        if typed:
            cards += [await _environment_card(db, e) for e in typed]
        else:
            cards.append(_placeholder(type_, f"Set up {short}"))
    cards += [await _environment_card(db, e) for e in rows if e.type not in ("dev", "beta")]
    known = {e.name for e in rows}
    cards += [_placeholder(e, f"Set up {_label(e)}") for e in tagged if e not in known]
    return cards


def _health(cards: list[dict]) -> dict:
    states = {c["state"] for c in cards if c["environment"]}
    if "failed" in states:
        return {"status": "degraded", "label": "A deployment failed"}
    if "active" in states:
        return {"status": "healthy", "label": "Environments deployed"}
    return {"status": "unknown", "label": "No environments deployed"}
```

Replace `build_dashboard` with:

```python
async def build_dashboard(settings: Settings, *, db: AsyncSession | None = None,
                          demo: bool = False, refresh: bool = False) -> dict:
    if demo:
        return demo_dashboard()
    infra: dict = {"source": "none", "error": None, "tree": []}
    inv: dict = {"droplets": [], "databases": [], "load_balancers": []}
    if targets.is_configured("digitalocean", settings):
        infra["source"] = "digitalocean"
        try:
            inv = await _inventory(settings, refresh)
            infra["tree"] = build_tree(inv)
        except ConnectFailed as e:
            infra["error"] = e.reason
    has_lb = any(_env_of(lb) == "production" for lb in inv["load_balancers"])
    tagged = sorted({e for r in (*inv["droplets"], *inv["databases"], *inv["load_balancers"])
                     if (e := _env_of(r)) and e not in _FIXED})
    envs = await environment_cards(db, tagged)
    slots = [{"id": s, "label": f"Production {s.title()}", "state": "empty", "health": "unknown",
              "version": None, "instances": {"running": 0, "total": 0}, "traffic_pct": 0}
             for s in ("blue", "green")]
    return {
        "demo": False,
        "generated_at": datetime.now(UTC).isoformat(),
        "health": _health(envs),
        "production": {
            "status": "inactive", "active_slot": None,
            "traffic": {"label": "Live traffic", "sub": "External users"},
            "load_balancer": {"label": "Load balancer",
                              "sub": "Configured" if has_lb else "Not configured",
                              "present": has_lb},
            "slots": slots},
        "environments": envs,
        "infrastructure": infra,
    }
```

In `sirdar/api/src/sirdar_api/dashboard/demo.py`, replace the `"environments": [...]` block with:

```python
        "environments": [
            {"id": "dev", "label": "Development", "sub": None, "state": "empty",
             "version": None, "last_release": "v2.8.1-dev", "last_release_at": None,
             "action_label": "Deploy to Dev", "environment": None},
            {"id": "beta", "label": "Beta", "sub": None, "state": "empty", "version": None,
             "last_release": "v2.8.1-rc.2", "last_release_at": None,
             "action_label": "Deploy to Beta", "environment": None},
        ],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sirdar/api && .venv/bin/pytest -q tests/test_dashboard_api.py tests/test_dashboard_inventory.py && .venv/bin/ruff check src tests`
Expected: all pass; `All checks passed!`

- [ ] **Step 5: Run the whole API suite once**

Run: `cd sirdar/api && .venv/bin/pytest -q`
Expected: every test passes (about 607; the 4 opt-in e2e tests are skipped).

- [ ] **Step 6: Commit**

```bash
git add sirdar/api/src/sirdar_api/dashboard sirdar/api/src/sirdar_api/api/routes/dashboard.py sirdar/api/tests/test_dashboard_api.py
git commit -m "feat(sirdar): dashboard environment cards come from Sirdar's environments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Web API client — environment and deployment endpoints, every error message

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts`
- Test: `sirdar/web/src/lib/sirdarApi.test.ts` (new)

**Interfaces:**
- Produces (all exported from `lib/sirdarApi.ts`):
  - types `EnvType`, `EnvStatus`, `DeployMode`, `DeploymentStatus`, `StepStatus`, `EnvService`, `DeploymentSummary`, `DeploymentStep`, `Deployment`, `Environment`, `AdoptedEnvironment`, `EnvironmentDefaults`, `NewEnvironmentBody`, `AdoptEnvironmentBody`, `EnvironmentPatch`, `DeploymentBody`, `RetryBody` (shapes below);
  - `listEnvironments(): Promise<{environments: Environment[]}>`, `getEnvironment(name)`, `getEnvironmentDefaults()`, `createEnvironment(body: NewEnvironmentBody): Promise<Environment>`, `adoptEnvironment(body: AdoptEnvironmentBody): Promise<AdoptedEnvironment>`, `updateEnvironment(name, patch: EnvironmentPatch): Promise<Environment>`, `startDeployment(name, body: DeploymentBody): Promise<Deployment>`, `listDeployments(name, limit = 20): Promise<{deployments: DeploymentSummary[]}>`, `getDeployment(id): Promise<Deployment>`, `cancelDeployment(id): Promise<{id: string; status: 'cancelling' | 'cancelled'}>`, `retryDeployment(id, body: RetryBody): Promise<Deployment>`;
  - `deployErrorText(err: unknown, fallback: string): string`;
  - `SshTarget.sudo_password_set: boolean`, `SshTargetBody.sudo_password?: string`.

- [ ] **Step 1: Write the failing test**

Create `sirdar/web/src/lib/sirdarApi.test.ts`:

```ts
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@portal/lib/api', async (orig) => ({
  ...(await orig<typeof import('@portal/lib/api')>()), apiFetch: fetchMock,
}));

import { ApiError } from '@portal/lib/api';

import * as sirdar from './sirdarApi';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(ok({})); });

const NEW_BODY = { name: 'qa', type: 'custom' as const, target: 'ssh:lab', git_ref: 'main',
                   proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0', ports: { api: 8100 } };
const CALLS: { name: string; call: () => Promise<unknown>; path: string; method?: string; body?: unknown }[] = [
  { name: 'listEnvironments', call: () => sirdar.listEnvironments(), path: '/deploy/environments' },
  { name: 'getEnvironment', call: () => sirdar.getEnvironment('qa east'), path: '/deploy/environments/qa%20east' },
  { name: 'getEnvironmentDefaults', call: () => sirdar.getEnvironmentDefaults(), path: '/deploy/environment-defaults' },
  { name: 'createEnvironment', call: () => sirdar.createEnvironment(NEW_BODY), path: '/deploy/environments',
    method: 'POST', body: { mode: 'new', ...NEW_BODY } },
  { name: 'adoptEnvironment', call: () => sirdar.adoptEnvironment({ name: 'uat', type: 'dev', target: 'ssh', git_ref: 'main' }),
    path: '/deploy/environments', method: 'POST',
    body: { mode: 'adopt', name: 'uat', type: 'dev', target: 'ssh', git_ref: 'main' } },
  { name: 'updateEnvironment', call: () => sirdar.updateEnvironment('uat', { keep_dumps: 3 }),
    path: '/deploy/environments/uat', method: 'PATCH', body: { keep_dumps: 3 } },
  { name: 'startDeployment', call: () => sirdar.startDeployment('uat', { mode: 'reset', git_ref: 'main', confirm_name: 'uat' }),
    path: '/deploy/environments/uat/deployments', method: 'POST',
    body: { mode: 'reset', git_ref: 'main', confirm_name: 'uat' } },
  { name: 'listDeployments', call: () => sirdar.listDeployments('uat'), path: '/deploy/environments/uat/deployments?limit=20' },
  { name: 'getDeployment', call: () => sirdar.getDeployment('d1'), path: '/deploy/deployments/d1' },
  { name: 'cancelDeployment', call: () => sirdar.cancelDeployment('d1'), path: '/deploy/deployments/d1/cancel', method: 'POST' },
  { name: 'retryDeployment', call: () => sirdar.retryDeployment('d1', { from_step: 3 }),
    path: '/deploy/deployments/d1/retry', method: 'POST', body: { from_step: 3 } },
];

it.each(CALLS)('$name calls $path', async ({ call, path, method, body }) => {
  await call();
  const [p, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  expect(p).toBe(path);
  expect(init?.method).toBe(method);
  expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
});

/** Every error code the deploy routes and the environment/gitref services can answer. */
function deployCodes(): string[] {
  const root = fileURLToPath(new URL('../../../api/src/sirdar_api/', import.meta.url));
  const found = new Set<string>(['sudo_password_too_long']);
  for (const file of ['api/routes/deploy.py', 'deploy/environments.py', 'deploy/gitref.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g, /(?:EnvError|RefError)\("([a-z_]+)"/g,
                      /_check_ipv4\([^()]*,\s*"([a-z]+_[a-z_]+)"\)/g]) {
      for (const m of src.matchAll(re)) found.add(m[1]);
    }
  }
  return [...found].sort();
}

it('every error code the deploy routes can return has its own message', () => {
  const codes = deployCodes();
  expect(codes.length).toBeGreaterThan(40);       // not vacuous
  expect(codes).toContain('adopt_env_incomplete');
  expect(codes).toContain('proxy_ip_invalid');
  expect(codes).toContain('ref_lookup_failed');
  const missing = codes.filter((c) => sirdar.errorText(new ApiError(400, c), '__none__') === '__none__');
  expect(missing).toEqual([]);
});

it('deployErrorText adds the reason, the missing keys or the named key', () => {
  expect(sirdar.deployErrorText(
    new ApiError(502, 'connect_failed', { code: 'connect_failed', reason: 'Timed out.' }), 'x')).toBe('Timed out.');
  expect(sirdar.deployErrorText(
    new ApiError(422, 'adopt_env_incomplete', { code: 'adopt_env_incomplete', missing: ['SS_JWT_SECRET', 'SS_PASSWORD_PEPPER'] }), 'x'))
    .toBe('That .env is missing required secrets (SS_JWT_SECRET, SS_PASSWORD_PEPPER).');
  expect(sirdar.deployErrorText(
    new ApiError(422, 'adopt_value_invalid', { code: 'adopt_value_invalid', key: 'STACK_DOMAIN' }), 'x'))
    .toBe("A value in that .env isn't valid (STACK_DOMAIN).");
  expect(sirdar.deployErrorText(
    new ApiError(422, 'port_invalid', { code: 'port_invalid', service: 'api' }), 'x'))
    .toBe('Use a port from 1 to 65535 (api).');
  expect(sirdar.deployErrorText(new Error('boom'), 'Fallback.')).toBe('Fallback.');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix sirdar/web test -- src/lib/sirdarApi.test.ts`
Expected: FAIL — `sirdar.listEnvironments is not a function` (and the others), the message test lists the missing codes, `deployErrorText is not a function`.

- [ ] **Step 3: Implement**

In `sirdar/web/src/lib/sirdarApi.ts`:

Replace the `SshTarget` and `SshTargetBody` interfaces with:

```ts
export interface SshTarget {
  slug: string; name: string; host: string; port: number; user: string;
  key_path: string | null; password_set: boolean; passphrase_set: boolean; sudo_password_set: boolean;
}
/** Create body; on update every field is optional and a secret that is omitted is kept,
 *  "" is cleared and a value is set. */
export interface SshTargetBody {
  name: string; host: string; port: number; user: string;
  password?: string; key_path?: string; key_passphrase?: string; sudo_password?: string;
}
```

Replace the whole `const MESSAGES` block with:

```ts
const MESSAGES: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  rank_too_low: 'That person outranks you.',
  cannot_edit_own_role: "You can't change the permissions of a role you hold.",
  developer_role_locked: 'Only developers can change the developer role.',
  developer_role_core: 'The developer role always keeps Developer tools and Roles & access view/change.',
  cannot_target_self: "You can't change your own overrides.",
  grant_exceeds_own: "You can't grant a permission you don't have yourself.",
  developer_only_resource: 'Developer tools can only be granted to the developer role.',
  access_view_locked: 'Every role keeps view on Roles & access.',
  source_not_configured: 'The portal database is not configured for this Sirdar.',
  target_unavailable: "That target isn't available yet.",
  target_not_configured: "That target isn't configured. Set its keys in the .env file and re-run the installer.",
  custom_name_required: 'Enter a name for the custom environment.',
  custom_name_invalid: 'Use lowercase letters, numbers and hyphens, starting with a letter (2–32 characters, no trailing hyphen).',
  custom_name_reserved: 'That name is reserved. Choose a different one.',
  connect_failed: "Couldn't connect.",
  host_key_changed: "The server's key changed while you were looking. Try again.",
  host_key_unknown: "Sirdar doesn't trust this server yet.",
  host_key_mismatch: "The server's key doesn't match the one Sirdar trusted.",
  not_configured_host: "Only the configured SSH host can be trusted.",
  not_found: 'That host is no longer trusted.',
  target_not_found: 'That target no longer exists.',
  targets_file_unwritable: "Sirdar couldn't save deploy-targets.env. Check that it's writable; see the README.",
  targets_file_unreadable: "Sirdar couldn't read deploy-targets.env. Check that it's valid UTF-8; see the README.",
  value_invalid: "One of the values has a character that can't be saved. Remove line breaks and control characters.",
  sudo_password_too_long: 'That sudo password is too long.',
  source_unavailable: "Couldn't reach the portal database. Nothing was changed.",
  // environments
  environment_exists: 'An environment with that name already exists.',
  environment_not_found: 'That environment no longer exists.',
  name_invalid: 'Use lowercase letters, numbers and hyphens, starting with a letter (2–32 characters, no trailing hyphen).',
  name_reserved: 'That name is reserved. Choose a different one.',
  type_invalid: 'Choose Dev, Beta or Custom.',
  target_invalid: 'Choose an SSH target.',
  ref_invalid: "That isn't a valid branch, tag or commit.",
  ref_not_found: 'The repository has no branch, tag or commit by that name.',
  git_missing: "git isn't installed on the target.",
  ref_lookup_failed: "The target couldn't list the repository's branches and tags.",
  base_domain_invalid: "That domain isn't valid. Use a name like uat.serversherpa.com.",
  proxy_ip_required: "Enter the proxy's IP address.",
  proxy_ip_invalid: 'The proxy IP must be an IPv4 address.',
  bind_ip_invalid: 'The bind IP must be an IPv4 address.',
  host_ip_invalid: 'Service addresses must be IPv4 addresses.',
  port_invalid: 'Use a port from 1 to 65535.',
  ports_conflict: "Two services can't use the same port.",
  service_unknown: "Sirdar doesn't know that service.",
  keep_dumps_invalid: 'Keep 1 to 100 dumps.',
  bucket_invalid: "That bucket name isn't valid (3–63 lowercase letters, numbers, dots and hyphens).",
  log_level_invalid: 'Choose DEBUG, INFO, WARNING or ERROR.',
  secret_invalid: "That value can't be saved. Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes.",
  secret_not_editable: 'Only the optional secrets can be changed.',
  secrets_key_missing: "SIRDAR_SECRETS_KEY isn't set on the Sirdar host, so environments can't be created or deployed. Add it to sirdar/.env and restart Sirdar.",
  adopt_env_missing: "There's no .env in that environment's folder on the target.",
  adopt_env_too_large: "That environment's .env is too large to read.",
  adopt_env_mismatch: "That .env belongs to a different environment (its STACK_ENV doesn't match the name).",
  adopt_env_incomplete: 'That .env is missing required secrets.',
  adopt_value_invalid: "A value in that .env isn't valid.",
  adopt_repo_missing: "There's no git checkout in that environment's repo folder.",
  // deployments
  deploy_in_progress: 'A deployment of this environment is already running.',
  confirm_name_mismatch: "Type the environment's name exactly to confirm.",
  deployment_not_found: 'That deployment no longer exists.',
  not_running: "That deployment isn't running any more.",
  not_retryable: "That deployment can't be retried.",
  retry_not_latest: 'Only the most recent deployment can be retried.',
  from_step_invalid: 'Pick a step at or before the one where the deployment stopped.',
  invalid_start_step: "That step isn't part of this deployment.",
};
```

Directly below `errorDetail`, add:

```ts
/** errorText plus what deploy errors carry: a `reason` (connect and git
 *  failures) replaces the message; the missing .env keys, or the key or
 *  service a check named, are added in parentheses. */
export function deployErrorText(err: unknown, fallback: string): string {
  const d = errorDetail<{ reason?: unknown; missing?: unknown; key?: unknown; service?: unknown }>(err);
  if (d && typeof d.reason === 'string' && d.reason) return d.reason;
  const base = errorText(err, fallback);
  let extra = '';
  if (d && Array.isArray(d.missing) && d.missing.length) extra = d.missing.join(', ');
  else if (d && typeof d.key === 'string') extra = d.key;
  else if (d && typeof d.service === 'string') extra = d.service;
  if (!extra) return base;
  return base.endsWith('.') ? `${base.slice(0, -1)} (${extra}).` : `${base} (${extra})`;
}
```

After `forgetKnownHost` (before the Dashboard block), add:

```ts
/* ---- Environments and deployments (/api/deploy, deploy step 2) ---- */
export type EnvType = 'dev' | 'beta' | 'custom';
export type EnvStatus = 'new' | 'ready' | 'deploying' | 'failed';
export type DeployMode = 'update' | 'reset';
export type DeploymentStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'adopted';
export type StepStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'not_run' | 'cancelled' | 'interrupted';
export interface EnvService { service: string; host_ip: string; port: number; hostname: string | null; proxied: boolean }
export interface DeploymentSummary {
  id: string; mode: DeployMode | 'adopt'; git_ref: string; sha: string; status: DeploymentStatus;
  start_step: number; retry_of: string | null; failed_step: number | null; dump_path: string | null;
  previous_sha: string | null; error: string | null; actor_name: string | null;
  started_at: string; finished_at: string | null; created_at: string;
}
export interface DeploymentStep {
  number: number; key: string; name: string; status: StepStatus;
  started_at: string | null; finished_at: string | null;
  /** Characters stored for the step; `log_tail` is its last `tail` (default 8000). */
  log_size: number; log_tail: string;
}
export interface Deployment extends DeploymentSummary { environment: string; steps: DeploymentStep[] }
export interface Environment {
  id: string; name: string; type: EnvType; target: string; base_domain: string; env_dir: string;
  git_ref: string; current_sha: string | null; image_tag: string | null; status: EnvStatus;
  proxy_ip: string; bind_ip: string; keep_dumps: number; spaces_bucket: string; log_level: string;
  services: EnvService[];
  /** Which optional (write-only) secrets are set. */
  secrets_set: Record<string, boolean>;
  last_deployment: DeploymentSummary | null; created_at: string; updated_at: string;
}
/** Adopt's answer adds what it read from the target's .env — names only. */
export interface AdoptedEnvironment extends Environment { ignored_keys: string[]; imported_secrets: string[] }
export interface EnvironmentDefaults {
  services: { service: string; port: number; public: boolean }[];
  domain_suffix: string; env_root: string; git_ref: string; bind_ip: string; keep_dumps: number;
  spaces_bucket: string; log_levels: string[]; optional_secrets: string[];
}
export interface NewEnvironmentBody {
  name: string; type: EnvType; target: string; git_ref: string; base_domain?: string;
  proxy_ip: string; bind_ip: string; ports: Record<string, number>;
}
export interface AdoptEnvironmentBody { name: string; type: EnvType; target: string; git_ref: string }
/** PATCH body: an omitted field is kept; a secret set to "" is cleared. */
export interface EnvironmentPatch {
  git_ref?: string; target?: string; base_domain?: string; proxy_ip?: string; bind_ip?: string;
  keep_dumps?: number; spaces_bucket?: string; log_level?: string;
  services?: Record<string, { port?: number; host_ip?: string }>;
  secrets?: Record<string, string>;
}
export interface DeploymentBody { mode: DeployMode; git_ref?: string; confirm_name?: string }
export interface RetryBody { from_step?: number; confirm_name?: string }

const envPath = (name: string) => `/deploy/environments/${encodeURIComponent(name)}`;
const depPath = (id: string) => `/deploy/deployments/${encodeURIComponent(id)}`;
export const listEnvironments = () => getJson<{ environments: Environment[] }>('/deploy/environments');
export const getEnvironment = (name: string) => getJson<Environment>(envPath(name));
export const getEnvironmentDefaults = () => getJson<EnvironmentDefaults>('/deploy/environment-defaults');
export const createEnvironment = (body: NewEnvironmentBody) =>
  sendJson<Environment>('POST', '/deploy/environments', { mode: 'new', ...body });
export const adoptEnvironment = (body: AdoptEnvironmentBody) =>
  sendJson<AdoptedEnvironment>('POST', '/deploy/environments', { mode: 'adopt', ...body });
export const updateEnvironment = (name: string, patch: EnvironmentPatch) =>
  sendJson<Environment>('PATCH', envPath(name), patch);
export const startDeployment = (name: string, body: DeploymentBody) =>
  sendJson<Deployment>('POST', `${envPath(name)}/deployments`, body);
export const listDeployments = (name: string, limit = 20) =>
  getJson<{ deployments: DeploymentSummary[] }>(`${envPath(name)}/deployments?limit=${limit}`);
export const getDeployment = (id: string) => getJson<Deployment>(depPath(id));
export const cancelDeployment = (id: string) =>
  sendJson<{ id: string; status: 'cancelling' | 'cancelled' }>('POST', `${depPath(id)}/cancel`);
export const retryDeployment = (id: string, body: RetryBody) =>
  sendJson<Deployment>('POST', `${depPath(id)}/retry`, body);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/lib/sirdarApi.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Type-check and run the web suite**

Run: `npm --prefix sirdar/web run build && npm --prefix sirdar/web test`
Expected: build succeeds; every test passes.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts
git commit -m "feat(sirdar-web): API client for environments and deployments, every deploy error message

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Sudo password on saved SSH targets (SecretField extracted)

**Files:**
- Create: `sirdar/web/src/components/SecretField.tsx`, `sirdar/web/src/components/SecretField.test.tsx`
- Modify: `sirdar/web/src/components/SshTargetModal.tsx` (whole file below)
- Test: `sirdar/web/src/components/SshTargetModal.test.tsx`

**Interfaces:**
- Consumes: `SshTarget.sudo_password_set`, `SshTargetBody.sudo_password` (Task 3).
- Produces: `export type SecretAction = 'keep' | 'clear' | 'set'`; `export default function SecretField(props: { id: string; label: string; isSet: boolean; adding: boolean; action: SecretAction; value: string; error?: string; disabled?: boolean; onAction: (a: SecretAction) => void; onValue: (v: string) => void })`. Its wrapper is `.sirdar-secret`; read-only text is `"<label>: set" | "<label>: not set" | "<label>: will be cleared"`; buttons Replace / Clear / Add / Keep / Undo; `disabled` hides every button and the input.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/components/SecretField.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import SecretField from './SecretField';

afterEach(cleanup);

const base = { id: 's', label: 'API key', value: '', onValue: vi.fn() };

it('a set secret offers Replace and Clear; Replace asks for the new value', async () => {
  const onAction = vi.fn();
  render(<SecretField {...base} isSet adding={false} action="keep" onAction={onAction} />);
  expect(screen.getByText('API key: set')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
  expect(onAction).toHaveBeenCalledWith('set');
  await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(onAction).toHaveBeenCalledWith('clear');
});

it('disabled shows the state with no buttons and no input', () => {
  render(<SecretField {...base} isSet adding={false} action="set" disabled onAction={vi.fn()} />);
  expect(screen.getByText('API key: set')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByLabelText('API key')).toBeNull();
});
```

In `sirdar/web/src/components/SshTargetModal.test.tsx`:

Change the import line `import { cleanup, render, screen, waitFor } from '@testing-library/react';` to

```tsx
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
```

Change `SAVED` to carry the flag:

```tsx
const SAVED = { slug: 'edge-box', name: 'Edge Box', host: '10.0.0.5', port: 2222, user: 'deployer',
                key_path: null, password_set: true, passphrase_set: false, sudo_password_set: false };
```

Append:

```tsx
it('adding a target can set a sudo password; empty sends none', async () => {
  const { onSaved } = await openAdd();
  expect(screen.getByText(/without one they use the SSH password/)).toBeTruthy();
  await userEvent.type(field('Name'), 'Key Box');
  await userEvent.type(field('Host'), 'h');
  await userEvent.type(field('User'), 'u');
  await userEvent.type(field('Password'), 'pw');
  await userEvent.type(field('Sudo password'), 'root-pw');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.createSshTarget).toHaveBeenCalledWith(
    { name: 'Key Box', host: 'h', port: 22, user: 'u', password: 'pw', sudo_password: 'root-pw' });
});

it('edit shows the sudo password as set; Clear sends "" and Replace sends the value', async () => {
  api.getSshTarget.mockResolvedValue({ ...SAVED, sudo_password_set: true });
  render(<SshTargetModal mode="edit" slug="edge-box" onSaved={vi.fn()} onClose={vi.fn()} />);
  const sudo = (await screen.findByText('Sudo password: set')).closest('.sirdar-secret') as HTMLElement;
  await userEvent.click(within(sudo).getByRole('button', { name: 'Clear' }));
  expect(screen.getByText('Sudo password: will be cleared')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateSshTarget).toHaveBeenCalled());
  expect(api.updateSshTarget.mock.calls[0][1]).toMatchObject({ sudo_password: '' });
  cleanup(); api.updateSshTarget.mockClear();

  render(<SshTargetModal mode="edit" slug="edge-box" onSaved={vi.fn()} onClose={vi.fn()} />);
  const again = (await screen.findByText('Sudo password: set')).closest('.sirdar-secret') as HTMLElement;
  await userEvent.click(within(again).getByRole('button', { name: 'Replace' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Enter a sudo password, or choose Keep to keep the saved one.')).toBeTruthy();
  expect(api.updateSshTarget).not.toHaveBeenCalled();
  await userEvent.type(field('Sudo password'), 'new-root');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateSshTarget).toHaveBeenCalled());
  expect(api.updateSshTarget.mock.calls[0][1]).toMatchObject({ sudo_password: 'new-root' });
});

it('an untouched sudo password is omitted, and a too-long one shows under its field', async () => {
  api.updateSshTarget.mockRejectedValueOnce(new ApiError(422, 'sudo_password_too_long', { code: 'sudo_password_too_long' }));
  await openEdit();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('That sudo password is too long.')).toBeTruthy();
  expect(api.updateSshTarget.mock.calls[0][1]).not.toHaveProperty('sudo_password');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/components/SecretField.test.tsx src/components/SshTargetModal.test.tsx`
Expected: FAIL — `./SecretField` cannot be resolved; the three new SshTargetModal tests fail (no "Sudo password" field).

- [ ] **Step 3: Implement**

Create `sirdar/web/src/components/SecretField.tsx`:

```tsx
/** A write-only secret: a plain input when adding, otherwise "set / not set"
 *  with Replace / Clear / Add, and Keep / Undo to back out. `disabled` (a
 *  view-only reader) shows the state alone. */
export type SecretAction = 'keep' | 'clear' | 'set';

export default function SecretField({ id, label, isSet, adding, action, value, error, disabled = false, onAction, onValue }: {
  id: string; label: string; isSet: boolean; adding: boolean; action: SecretAction; value: string;
  error?: string; disabled?: boolean; onAction: (a: SecretAction) => void; onValue: (v: string) => void;
}) {
  const showInput = !disabled && (adding || action === 'set');
  return (
    <div className="sirdar-secret">
      {showInput ? (
        <>
          <label className="field-label" htmlFor={id}>{label}</label>
          <div className="sirdar-secret-row">
            <input id={id} type="password" value={value} autoComplete="new-password" spellCheck={false}
                   aria-invalid={!!error} onChange={(e) => onValue(e.target.value)} />
            {!adding && <button type="button" className="mini-btn" onClick={() => { onValue(''); onAction('keep'); }}>Keep</button>}
          </div>
        </>
      ) : (
        <>
          <span className="field-label">{label}</span>
          <div className="sirdar-secret-row">
            <span>{action === 'clear' && !disabled ? `${label}: will be cleared` : `${label}: ${isSet ? 'set' : 'not set'}`}</span>
            {!disabled && (action === 'clear'
              ? <button type="button" className="mini-btn" onClick={() => onAction('keep')}>Undo</button>
              : isSet
                ? <>
                    <button type="button" className="mini-btn" onClick={() => onAction('set')}>Replace</button>
                    <button type="button" className="mini-btn" onClick={() => onAction('clear')}>Clear</button>
                  </>
                : <button type="button" className="mini-btn" onClick={() => onAction('set')}>Add</button>)}
          </div>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
```

Replace `sirdar/web/src/components/SshTargetModal.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';

import {
  createSshTarget, errorText, getSshTarget, listKeyFiles, updateSshTarget,
  type SshTarget, type SshTargetBody,
} from '../lib/sirdarApi';

import SecretField, { type SecretAction } from './SecretField';

type Field = 'name' | 'host' | 'port' | 'user' | 'key' | 'auth' | 'password' | 'passphrase' | 'sudo' | 'form';
type Errors = Partial<Record<Field, string>>;

const NONE = '__none__';
const AUTH_MSG = 'Add a password or choose a key file.';

const CODE_FIELD: Record<string, [Field, string]> = {
  name_invalid: ['name', 'Use up to 64 characters, including at least one letter or number.'],
  name_taken: ['name', 'A target with that name already exists.'],
  host_invalid: ['host', "That host isn't valid. Use a hostname or IP address."],
  port_invalid: ['port', 'Port must be a number from 1 to 65535.'],
  user_invalid: ['user', "That user name isn't valid."],
  key_file_invalid: ['key', "That key file name isn't valid."],
  key_file_not_found: ['key', "That key file isn't in sirdar/deploy-keys/ on the Sirdar host."],
  auth_required: ['auth', AUTH_MSG],
  password_too_long: ['password', 'That password is too long.'],
  passphrase_too_long: ['passphrase', 'That passphrase is too long.'],
  sudo_password_too_long: ['sudo', 'That sudo password is too long.'],
  value_invalid: ['form', "One of the values has a character that can't be saved. Remove line breaks and control characters."],
  targets_file_unwritable: ['form', "Sirdar couldn't save deploy-targets.env. Check that it's writable; see the README."],
};

export default function SshTargetModal({ mode, slug, onSaved, onClose }: {
  mode: 'add' | 'edit'; slug?: string; onSaved: (slug: string) => void; onClose: () => void;
}) {
  const adding = mode === 'add';
  const [loaded, setLoaded] = useState(adding);
  const [loadError, setLoadError] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [saved, setSaved] = useState<SshTarget | null>(null);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [keyFile, setKeyFile] = useState('');
  const [pwAction, setPwAction] = useState<SecretAction>('keep');
  const [pw, setPw] = useState('');
  const [ppAction, setPpAction] = useState<SecretAction>('keep');
  const [pp, setPp] = useState('');
  const [sdAction, setSdAction] = useState<SecretAction>('keep');
  const [sd, setSd] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  savingRef.current = saving;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !savingRef.current) onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    listKeyFiles().then((r) => { if (live) setFiles(r.files); }).catch(() => { /* the picker just stays empty */ });
    if (!adding && slug) {
      getSshTarget(slug).then((t) => {
        if (!live) return;
        setSaved(t); setName(t.name); setHost(t.host); setPort(String(t.port)); setUser(t.user);
        setKeyFile(t.key_path ?? ''); setLoaded(true);
      }).catch((e) => { if (live) setLoadError(errorText(e, "Couldn't load that target.")); });
    }
    return () => { live = false; };
  }, [adding, slug]);

  useEffect(() => { if (loaded) nameRef.current?.focus(); }, [loaded]);

  const pwIsSet = !!saved?.password_set;
  const ppIsSet = !!saved?.passphrase_set;
  const sdIsSet = !!saved?.sudo_password_set;
  const pwNew = adding || pwAction === 'set';
  const ppNew = adding || ppAction === 'set';
  const sdNew = adding || sdAction === 'set';

  const validate = (): Errors => {
    const e: Errors = {};
    if (!name.trim()) e.name = 'Enter a name.';
    else if (name.trim().length > 64) e.name = 'The name can be up to 64 characters.';
    if (!host.trim()) e.host = 'Enter a host.';
    const p = Number(port);
    if (!/^\d+$/.test(port.trim()) || p < 1 || p > 65535) e.port = 'Port must be a number from 1 to 65535.';
    if (!user.trim()) e.user = 'Enter a user.';
    const hasPw = pwNew ? pw !== '' : pwAction === 'keep' && pwIsSet;
    if (pwNew && pw === '' && !adding) e.password = 'Enter a password, or choose Keep to keep the saved one.';
    if (!hasPw && !keyFile) e.auth = AUTH_MSG;
    if (keyFile && ppNew && pp === '' && !adding) e.passphrase = 'Enter a passphrase, or choose Keep to keep the saved one.';
    if (!adding && sdAction === 'set' && sd === '') {
      e.sudo = sdIsSet ? 'Enter a sudo password, or choose Keep to keep the saved one.'
        : 'Enter a sudo password, or choose Keep to leave it unset.';
    }
    return e;
  };

  const save = async () => {
    if (savingRef.current) return;
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: Partial<SshTargetBody> = { name: name.trim(), host: host.trim(), port: Number(port), user: user.trim() };
    if (pwNew) { if (pw) body.password = pw; }
    else if (pwAction === 'clear') body.password = '';
    if (keyFile) {
      body.key_path = keyFile;
      if (ppNew) { if (pp) body.key_passphrase = pp; }
      else if (ppAction === 'clear') body.key_passphrase = '';
    } else if (!adding) {
      body.key_path = '';
      if (ppIsSet) body.key_passphrase = '';
    }
    if (sdNew) { if (sd) body.sudo_password = sd; }
    else if (sdAction === 'clear') body.sudo_password = '';
    setSaving(true);
    try {
      const out = adding ? await createSshTarget(body as SshTargetBody) : await updateSshTarget(slug!, body);
      onSaved(out.slug);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const [field, msg] = CODE_FIELD[code] ?? ['form', errorText(err, "Couldn't save the target.")];
      setErrors({ [field]: msg });
      setSaving(false);
    }
  };

  // The saved passphrase belongs to the saved key: picking a different key (or
  // none) defaults it to Clear; picking the saved key again restores Keep.
  const changeKey = (v: string) => {
    const next = v === NONE ? '' : v;
    setKeyFile(next);
    if (adding || !ppIsSet) return;
    if (next !== (saved?.key_path ?? '')) { if (ppAction === 'keep') setPpAction('clear'); }
    else if (ppAction === 'clear') setPpAction('keep');
  };
  const keyChanged = !adding && ppIsSet && keyFile !== '' && keyFile !== (saved?.key_path ?? '');

  const options = [{ value: NONE, label: 'None' },
    ...[...new Set([...files, ...(keyFile ? [keyFile] : [])])].map((f) => ({ value: f, label: f }))];

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-sshtarget-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-sshtarget-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Deploy</div>
            <h3 id="sirdar-sshtarget-title">{adding ? 'Add SSH target' : 'Edit SSH target'}</h3>
            <p className="page-hint">
              Saved to deploy-targets.env on the Sirdar host. Passwords and passphrases are write-only.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={saving} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form className="modal-body pf-form sirdar-sshtarget-form" noValidate
              onSubmit={(e) => { e.preventDefault(); save(); }}>
          {loadError && <p className="form-error" role="alert">{loadError}</p>}
          {!loaded && !loadError && <p className="page-hint">Loading…</p>}
          {loaded && (
            <>
              <div className="sirdar-sshtarget-grid">
                <div className="sirdar-span2">
                  <label className="field-label" htmlFor="ssh-name">Name</label>
                  <input id="ssh-name" ref={nameRef} type="text" value={name} maxLength={200} autoComplete="off"
                         aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
                  {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
                </div>
                <div>
                  <label className="field-label" htmlFor="ssh-host">Host</label>
                  <input id="ssh-host" type="text" value={host} maxLength={300} autoComplete="off" spellCheck={false}
                         aria-invalid={!!errors.host} onChange={(e) => setHost(e.target.value)} />
                  {errors.host && <p className="form-error" role="alert">{errors.host}</p>}
                </div>
                <div>
                  <label className="field-label" htmlFor="ssh-port">Port</label>
                  <input id="ssh-port" type="text" inputMode="numeric" value={port} autoComplete="off"
                         aria-invalid={!!errors.port} onChange={(e) => setPort(e.target.value)} />
                  {errors.port && <p className="form-error" role="alert">{errors.port}</p>}
                </div>
                <div className="sirdar-span2">
                  <label className="field-label" htmlFor="ssh-user">User</label>
                  <input id="ssh-user" type="text" value={user} maxLength={200} autoComplete="off" spellCheck={false}
                         aria-invalid={!!errors.user} onChange={(e) => setUser(e.target.value)} />
                  {errors.user && <p className="form-error" role="alert">{errors.user}</p>}
                </div>
              </div>

              <h4 className="sirdar-sshtarget-sub">Authentication</h4>
              <SecretField id="ssh-password" label="Password" isSet={pwIsSet} adding={adding} action={pwAction}
                           value={pw} error={errors.password}
                           onAction={setPwAction} onValue={setPw} />
              <div>
                <label className="field-label" htmlFor="ssh-key">Key file</label>
                <ComboBox inputId="ssh-key" ariaLabel="Key file" portal value={keyFile || NONE}
                          options={options} placeholder="None"
                          onChange={changeKey} />
                <p className="page-hint">Put key files in sirdar/deploy-keys/ on the Sirdar host (chmod 600).</p>
                {errors.key && <p className="form-error" role="alert">{errors.key}</p>}
              </div>
              {keyFile && (
                <SecretField id="ssh-passphrase" label="Key passphrase" isSet={ppIsSet} adding={adding}
                             action={ppAction} value={pp} error={errors.passphrase}
                             onAction={setPpAction} onValue={setPp} />
              )}
              {keyFile && keyChanged && ppAction === 'clear' && (
                <p className="page-hint">The saved passphrase belonged to the previous key, so it will be cleared. Choose Replace to enter a new one.</p>
              )}
              <SecretField id="ssh-sudo" label="Sudo password" isSet={sdIsSet} adding={adding} action={sdAction}
                           value={sd} error={errors.sudo} onAction={setSdAction} onValue={setSd} />
              <p className="page-hint">Optional. Deploy steps that need root use it; without one they use the SSH password.</p>
              {errors.auth && <p className="form-error" role="alert">{errors.auth}</p>}
              {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
              <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
            </>
          )}
        </form>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!loaded || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/components`
Expected: PASS — all SecretField, SshTargetModal (old and new) and HostKeyModal tests.

- [ ] **Step 5: Type-check**

Run: `npm --prefix sirdar/web run build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/components/SecretField.tsx sirdar/web/src/components/SecretField.test.tsx sirdar/web/src/components/SshTargetModal.tsx sirdar/web/src/components/SshTargetModal.test.tsx
git commit -m "feat(sirdar-web): write-only sudo password on saved SSH targets; SecretField extracted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Shared environment helpers and the Environments list on /deploy

**Files:**
- Create: `sirdar/web/src/lib/envRules.ts`, `sirdar/web/src/lib/envRules.test.ts`
- Create: `sirdar/web/src/lib/arrowNav.ts`
- Create: `sirdar/web/src/pages/environments/labels.tsx`, `sirdar/web/src/pages/environments/labels.test.ts`
- Create: `sirdar/web/src/pages/environments/testData.ts`
- Create: `sirdar/web/src/pages/environments/EnvironmentsSection.tsx`, `sirdar/web/src/pages/environments/EnvironmentsSection.test.tsx`
- Modify: `sirdar/web/src/pages/Deploy.tsx` (imports, helper removal, header copy, new first section)
- Modify: `sirdar/web/src/pages/Deploy.test.tsx` (router wrapper, `listEnvironments` mock)

**Interfaces:**
- Consumes: Task 3 types and `listEnvironments`.
- Produces:
  - `lib/envRules.ts`: `RESERVED_NAMES: string[]`, `NAME_HELP: string`, `nameProblem(raw): string` ('' for empty or valid), `refProblem(raw): string`, `ipv4Problem(raw, label): string` ("Enter the <label>." / "The <label> must be an IPv4 address."), `portProblem(raw): string` ("Use a port from 1 to 65535.").
  - `lib/arrowNav.ts`: `arrowNav(e: React.KeyboardEvent<HTMLElement>): void`.
  - `pages/environments/labels.tsx`: `ENV_STATUS`, `DEPLOYMENT_STATUS`, `STEP_STATUS` (maps status → `[chipClass, label]`), `StatusChip({map, status})`, `TYPE_LABEL`, `MODE_LABEL`, `RETRYABLE: string[]`, `when(iso)`, `shortSha(sha)`, `duration(start, end, now?)`, `stoppedStep(steps): number | null`, `targetLabel(targets, id)`, `sshTargets(targets)`.
  - `pages/environments/testData.ts`: `SHA`, `NEW_SHA`, `ENV`, `ADOPTED`, `TARGETS`, `DEFAULTS`, `RUNNING`, `RUNNING_MORE`, `SUCCEEDED`, `FAILED`, `RESET_FAILED`, `summary(d)`.
  - `EnvironmentsSection({ targets }: { targets: DeployTarget[] })` — section "Environments" with a DataTable `aria-label="Environments"`; the name cell links to `/deploy/environments/<name>`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/lib/envRules.test.ts`:

```ts
import { expect, it } from 'vitest';

import { ipv4Problem, nameProblem, portProblem, refProblem } from './envRules';

it('names follow the API rule', () => {
  expect(nameProblem('')).toBe('');
  expect(nameProblem('qa-east')).toBe('');
  expect(nameProblem('Qa')).toMatch(/lowercase letters/);
  expect(nameProblem('qa-')).toMatch(/no trailing hyphen/);
  expect(nameProblem('dev')).toBe('That name is reserved. Choose a different one.');
});

it('refs: branches, tags and SHAs; no leading dash, "..", trailing "/" or ".lock"', () => {
  for (const ok of ['main', 'release/2.8', 'v2.8.1', 'e73b99ca'.repeat(5)]) expect(refProblem(ok)).toBe('');
  expect(refProblem(' ')).toBe('Enter a branch, tag or commit.');
  for (const bad of ['-x', 'a..b', 'feat/', 'x.lock', 'has space', 'a;b']) {
    expect(refProblem(bad)).toBe("That isn't a valid branch, tag or commit.");
  }
});

it('IPv4 addresses and ports', () => {
  expect(ipv4Problem('10.10.48.6', 'proxy IP')).toBe('');
  expect(ipv4Problem('', 'proxy IP')).toBe('Enter the proxy IP.');
  for (const bad of ['10.10.48', '256.1.1.1', '010.1.1.1', 'host']) {
    expect(ipv4Problem(bad, 'proxy IP')).toBe('The proxy IP must be an IPv4 address.');
  }
  expect(portProblem('8000')).toBe('');
  for (const bad of ['0', '65536', '80a', '']) expect(portProblem(bad)).toBe('Use a port from 1 to 65535.');
});
```

Create `sirdar/web/src/pages/environments/labels.test.ts`:

```ts
import { expect, it } from 'vitest';

import { duration, sshTargets, stoppedStep } from './labels';
import { FAILED, RUNNING, SUCCEEDED, TARGETS } from './testData';

it('stoppedStep mirrors the API: the failed/cancelled/interrupted step, else the first not run', () => {
  expect(stoppedStep(FAILED.steps)).toBe(5);
  expect(stoppedStep(SUCCEEDED.steps)).toBeNull();
  expect(stoppedStep(RUNNING.steps)).toBeNull();
  const interruptedEarly = FAILED.steps.map((s) => (s.number >= 3 ? { ...s, status: 'not_run' as const } : s));
  expect(stoppedStep(interruptedEarly)).toBe(3);
});

it('duration reads seconds, then minutes', () => {
  expect(duration(null, null)).toBe('');
  expect(duration('2026-10-03T13:00:00Z', '2026-10-03T13:00:42Z')).toBe('42s');
  expect(duration('2026-10-03T13:00:00Z', '2026-10-03T13:01:05Z')).toBe('1m 05s');
  expect(duration('2026-10-03T13:00:00Z', null, Date.parse('2026-10-03T13:00:09Z'))).toBe('9s');
});

it('sshTargets keeps configured SSH targets only', () => {
  expect(sshTargets(TARGETS.targets).map((t) => t.id)).toEqual(['ssh:lab']);
});
```

Create `sirdar/web/src/pages/environments/EnvironmentsSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a === 'view' || perms.add) }),
}));
const api = vi.hoisted(() => ({ listEnvironments: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import EnvironmentsSection from './EnvironmentsSection';
import { ENV, TARGETS } from './testData';

beforeEach(() => {
  perms.add = true;
  api.listEnvironments.mockReset();
  api.listEnvironments.mockResolvedValue({ environments: [] });
});
afterEach(cleanup);

function show() {
  return render(
    <MemoryRouter initialEntries={['/deploy']}>
      <Routes>
        <Route path="/deploy" element={<EnvironmentsSection targets={TARGETS.targets} />} />
        <Route path="/deploy/environments/:name" element={<p>detail page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('lists each environment with its target, type, ref and SHA, status and last deploy', async () => {
  api.listEnvironments.mockResolvedValue({ environments: [
    ENV, { ...ENV, id: 'e2', name: 'qa', type: 'custom', status: 'new', current_sha: null, last_deployment: null },
  ] });
  show();
  const table = await screen.findByRole('table', { name: 'Environments' });
  expect(within(table).getByRole('link', { name: 'uat' }).getAttribute('href')).toBe('/deploy/environments/uat');
  expect(within(table).getAllByText('Lab box')).toHaveLength(2);
  expect(within(table).getByText('Dev')).toBeTruthy();
  expect(within(table).getByText('Custom')).toBeTruthy();
  expect(within(table).getByText('main · e73b99ca')).toBeTruthy();
  expect(within(table).getByText('main · —')).toBeTruthy();
  expect(within(table).getByText('Ready')).toBeTruthy();
  expect(within(table).getByText('New')).toBeTruthy();
  expect(within(table).getByText('Adopted')).toBeTruthy();
});

it('shows the empty state, and a load error as an alert', async () => {
  show();
  expect(await screen.findByText('No environments yet.')).toBeTruthy();
  cleanup();
  api.listEnvironments.mockRejectedValue(new ApiError(500, 'http_500', null));
  show();
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load environments.");
});
```

Create `sirdar/web/src/pages/environments/testData.ts` (fixtures; needed by the tests above and every later environments test):

```ts
/** Fixtures shaped like the /api/deploy environment and deployment endpoints. */
import type {
  Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, Environment,
  EnvironmentDefaults, EnvService, StepStatus,
} from '../../lib/sirdarApi';

export const SHA = `e73b99ca${'1'.repeat(32)}`;
export const NEW_SHA = `f00dbabe${'2'.repeat(32)}`;

const svc = (service: string, port: number): EnvService => ({
  service, host_ip: '10.10.48.63', port, proxied: false,
  hostname: service === 'mailpit' ? null : `${service}.uat.serversherpa.com`,
});

export const ADOPTED: DeploymentSummary = {
  id: 'd0', mode: 'adopt', git_ref: 'main', sha: SHA, status: 'adopted', start_step: 1, retry_of: null,
  failed_step: null, dump_path: null, previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
  started_at: '2026-10-03T12:00:00Z', finished_at: '2026-10-03T12:00:00Z', created_at: '2026-10-03T12:00:00Z',
};

export const ENV: Environment = {
  id: 'e1', name: 'uat', type: 'dev', target: 'ssh:lab', base_domain: 'uat.serversherpa.com',
  env_dir: '/opt/serversherpa/uat', git_ref: 'main', current_sha: SHA, image_tag: 'e73b99ca',
  status: 'ready', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0', keep_dumps: 5,
  spaces_bucket: 'serversherpa', log_level: 'INFO',
  services: [svc('api', 8000), svc('portal', 8091), svc('kiosk', 8090), svc('wiki', 8096),
             svc('spaces', 9000), svc('status', 8095), svc('mailpit', 8025)],
  secrets_set: { SS_ANTHROPIC_API_KEY: true, SS_DB_TESTING_PASSWORD: false },
  last_deployment: ADOPTED, created_at: '2026-10-03T12:00:00Z', updated_at: '2026-10-03T12:00:00Z',
};

export const TARGETS = {
  targets: [
    { id: 'aws', label: 'AWS', kind: 'aws', available: false, configured: false },
    { id: 'ssh', label: 'Custom (SSH) · Installer', kind: 'ssh', source: 'installer', available: true, configured: false },
    { id: 'ssh:lab', label: 'Lab box', kind: 'ssh', source: 'saved', available: true, configured: true },
  ] as DeployTarget[],
  types: [], can_add_ssh: true, ssh_store_hint: null,
};

export const DEFAULTS: EnvironmentDefaults = {
  services: [
    { service: 'api', port: 8000, public: true }, { service: 'portal', port: 8091, public: true },
    { service: 'kiosk', port: 8090, public: true }, { service: 'wiki', port: 8096, public: true },
    { service: 'spaces', port: 9000, public: true }, { service: 'status', port: 8095, public: true },
    { service: 'mailpit', port: 8025, public: false },
  ],
  domain_suffix: 'serversherpa.com', env_root: '/opt/serversherpa', git_ref: 'main', bind_ip: '0.0.0.0',
  keep_dumps: 5, spaces_bucket: 'serversherpa', log_levels: ['DEBUG', 'INFO', 'WARNING', 'ERROR'],
  optional_secrets: ['SS_ANTHROPIC_API_KEY', 'SS_DB_TESTING_PASSWORD'],
};

const UPDATE_PLAN: [number, string, string][] = [
  [1, 'preflight', 'Preflight'], [2, 'bootstrap', 'Bootstrap'], [3, 'fetch', 'Fetch code'],
  [4, 'render', 'Render config'], [5, 'build', 'Build images'], [6, 'dump', 'Pre-deploy dump'],
  [8, 'up', 'Start services'],
];
const RESET_PLAN: [number, string, string][] = [
  [1, 'preflight', 'Preflight'], [2, 'bootstrap', 'Bootstrap'], [3, 'fetch', 'Fetch code'],
  [4, 'render', 'Render config'], [5, 'build', 'Build images'], [7, 'reset', 'Reset data'],
  [8, 'up', 'Start services'],
];
const ENDED: StepStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

function steps(plan: [number, string, string][], statuses: StepStatus[], logs: Record<number, string>): DeploymentStep[] {
  return plan.map(([number, key, name], i) => {
    const status = statuses[i];
    const log = logs[number] ?? '';
    const ran = status !== 'pending' && status !== 'not_run' && status !== 'skipped';
    return { number, key, name, status, started_at: ran ? '2026-10-03T13:00:00Z' : null,
             finished_at: ENDED.includes(status) ? '2026-10-03T13:01:05Z' : null,
             log_size: log.length, log_tail: log };
  });
}

function deployment(status: DeploymentStatus, statuses: StepStatus[], logs: Record<number, string> = {},
                    extra: Partial<Deployment> = {}): Deployment {
  const mode = extra.mode ?? 'update';
  return {
    id: 'd1', mode, git_ref: 'main', sha: NEW_SHA, status, start_step: 1, retry_of: null, failed_step: null,
    dump_path: null, previous_sha: SHA, error: null, actor_name: 'Jimmy Henderson',
    started_at: '2026-10-03T13:00:00Z', finished_at: status === 'running' ? null : '2026-10-03T13:10:00Z',
    created_at: '2026-10-03T13:00:00Z', environment: 'uat',
    steps: steps(mode === 'reset' ? RESET_PLAN : UPDATE_PLAN, statuses, logs), ...extra,
  };
}

const AT_STEP_3: StepStatus[] = ['succeeded', 'succeeded', 'running', 'pending', 'pending', 'pending', 'pending'];
const FAILED_AT_5: StepStatus[] = ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed', 'not_run', 'not_run'];
const ALL_DONE: StepStatus[] = ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded'];
const BUILD_FAILED = 'Step 5 (Build images) failed. See its log.';

export const RUNNING = deployment('running', AT_STEP_3, { 3: 'Cloning the repo\n' });
export const RUNNING_MORE = deployment('running', AT_STEP_3, { 3: 'Cloning the repo\nChecked out f00dbabe\n' });
export const SUCCEEDED = deployment('succeeded', ALL_DONE, {},
  { dump_path: '/opt/serversherpa/uat/backups/pre-deploy-20261003.dump' });
export const FAILED = deployment('failed', FAILED_AT_5, { 5: 'docker build exited 1\n' },
  { failed_step: 5, error: BUILD_FAILED });
export const RESET_FAILED = deployment('failed', FAILED_AT_5, { 5: 'docker build exited 1\n' },
  { id: 'd3', mode: 'reset', failed_step: 5, error: BUILD_FAILED });

export function summary(d: Deployment): DeploymentSummary {
  return {
    id: d.id, mode: d.mode, git_ref: d.git_ref, sha: d.sha, status: d.status, start_step: d.start_step,
    retry_of: d.retry_of, failed_step: d.failed_step, dump_path: d.dump_path, previous_sha: d.previous_sha,
    error: d.error, actor_name: d.actor_name, started_at: d.started_at, finished_at: d.finished_at,
    created_at: d.created_at,
  };
}
```

In `sirdar/web/src/pages/Deploy.test.tsx`:

Add `import { MemoryRouter } from 'react-router-dom';` after the `@testing-library/user-event` import.

Add `listEnvironments: vi.fn(),` to the hoisted `api` object:

```tsx
const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), getDoRegions: vi.fn(), connectDeploy: vi.fn(), listKnownHosts: vi.fn(),
  trustKnownHost: vi.fn(), forgetKnownHost: vi.fn(), deleteSshTarget: vi.fn(),
  getSshTarget: vi.fn(), listKeyFiles: vi.fn(), createSshTarget: vi.fn(), updateSshTarget: vi.fn(),
  listEnvironments: vi.fn(),
}));
```

In `beforeEach`, after `api.listKnownHosts.mockResolvedValue([]);` add:

```tsx
  api.listEnvironments.mockResolvedValue({ environments: [] });
```

Change `ready()` to:

```tsx
async function ready() {
  render(<MemoryRouter><Deploy /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0));
}
```

Append:

```tsx
it('shows the Environments section first', async () => {
  await ready();
  expect(await screen.findByRole('table', { name: 'Environments' })).toBeTruthy();
  expect(screen.getAllByRole('heading', { level: 2 })[0].textContent).toBe('Environments');
  expect(api.listEnvironments).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/lib/envRules.test.ts src/pages/environments src/pages/Deploy.test.tsx`
Expected: FAIL — `./envRules`, `./labels` and `./EnvironmentsSection` cannot be resolved; the new Deploy test finds no "Environments" table.

- [ ] **Step 3: Implement the helpers**

Create `sirdar/web/src/lib/envRules.ts`:

```ts
/** Client-side mirrors of the API's checks (sirdar_api/deploy/names.py,
 *  gitref.py and environments.py) so a form can answer before a round trip.
 *  The API stays the authority. Each returns an inline message, or ''. */
export const RESERVED_NAMES = ['blue', 'green', 'dev', 'beta', 'custom'];
export const NAME_HELP = 'Lowercase letters, numbers and hyphens; starts with a letter; 2–32 characters.';

/** '' for an empty name too: callers say "Enter a name." themselves. */
export function nameProblem(raw: string): string {
  const n = raw.trim();
  if (!n) return '';
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(n) || n.endsWith('-'))
    return 'Use lowercase letters, numbers and hyphens, starting with a letter (2–32 characters, no trailing hyphen).';
  if (RESERVED_NAMES.includes(n)) return 'That name is reserved. Choose a different one.';
  return '';
}

export function refProblem(raw: string): string {
  const r = raw.trim();
  if (!r) return 'Enter a branch, tag or commit.';
  if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(r) || r.endsWith('/') || r.endsWith('.lock'))
    return "That isn't a valid branch, tag or commit.";
  return '';
}

export function ipv4Problem(raw: string, label: string): string {
  const v = raw.trim();
  if (!v) return `Enter the ${label}.`;
  const parts = v.split('.');
  const ok = parts.length === 4
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === '0' || !p.startsWith('0')));
  return ok ? '' : `The ${label} must be an IPv4 address.`;
}

export function portProblem(raw: string): string {
  const v = raw.trim();
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) return 'Use a port from 1 to 65535.';
  return '';
}
```

Create `sirdar/web/src/lib/arrowNav.ts`:

```ts
import type { KeyboardEvent } from 'react';

/** Roving-tabindex arrow-key movement inside a radiogroup. */
export function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!dir) return;
  const group = e.currentTarget.closest('[role="radiogroup"]');
  const items = Array.from(group?.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled="true"])') ?? []);
  const next = items[(items.indexOf(e.currentTarget) + dir + items.length) % items.length];
  if (next) { e.preventDefault(); next.focus(); next.click(); }
}
```

Create `sirdar/web/src/pages/environments/labels.tsx`:

```tsx
/** Labels, status chips and small helpers shared by the environment pages. */
import type { DeployTarget, DeploymentStep } from '../../lib/sirdarApi';

/** status → [chip class, label] */
type ChipMap = Record<string, [string, string]>;

export const ENV_STATUS: ChipMap = {
  new: ['tag', 'New'], ready: ['c-green', 'Ready'], deploying: ['c-blue', 'Deploying'], failed: ['c-red', 'Failed'],
};
export const DEPLOYMENT_STATUS: ChipMap = {
  running: ['c-blue', 'Running'], succeeded: ['c-green', 'Succeeded'], failed: ['c-red', 'Failed'],
  cancelled: ['c-amber', 'Cancelled'], interrupted: ['c-amber', 'Interrupted'], adopted: ['tag', 'Adopted'],
};
export const STEP_STATUS: ChipMap = {
  pending: ['tag', 'Pending'], running: ['c-blue', 'Running'], succeeded: ['c-green', 'Done'],
  failed: ['c-red', 'Failed'], skipped: ['tag', 'Skipped'], not_run: ['tag', 'Not run'],
  cancelled: ['c-amber', 'Cancelled'], interrupted: ['c-amber', 'Interrupted'],
};
export const TYPE_LABEL: Record<string, string> = { dev: 'Dev', beta: 'Beta', custom: 'Custom' };
export const MODE_LABEL: Record<string, string> = { update: 'Update', reset: 'Reset data', adopt: 'Adopt' };
/** Deployment statuses the API retries (pipeline.RETRYABLE_STATUSES). */
export const RETRYABLE = ['failed', 'cancelled', 'interrupted'];

export function StatusChip({ map, status }: { map: ChipMap; status: string }) {
  const [cls, label] = map[status] ?? ['tag', status];
  return <span className={`chip ${cls}`}>{label}</span>;
}

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : '—');

/** "42s" / "1m 05s"; a step still running counts up to `now`. */
export function duration(start: string | null, end: string | null, now = Date.now()): string {
  if (!start) return '';
  const secs = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

/** Where a deployment stopped, as the API's retry check works it out: its
 *  failed, cancelled or interrupted step, else its first step that didn't run. */
export function stoppedStep(steps: DeploymentStep[]): number | null {
  const ended = steps.find((s) => s.status === 'failed' || s.status === 'cancelled' || s.status === 'interrupted');
  if (ended) return ended.number;
  return steps.find((s) => s.status === 'not_run')?.number ?? null;
}

export const targetLabel = (targets: DeployTarget[], id: string) => targets.find((t) => t.id === id)?.label ?? id;

/** Targets an environment can use: the installer's and saved SSH targets that are configured. */
export const sshTargets = (targets: DeployTarget[]) =>
  targets.filter((t) => (t.id === 'ssh' || t.id.startsWith('ssh:')) && t.available && t.configured);
```

- [ ] **Step 4: Implement the list and put it on /deploy**

Create `sirdar/web/src/pages/environments/EnvironmentsSection.tsx`:

```tsx
/** The Environments section at the top of /deploy. */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import DataTable from '@portal/components/DataTable';

import { errorText, listEnvironments, type DeployTarget, type Environment } from '../../lib/sirdarApi';

import {
  DEPLOYMENT_STATUS, ENV_STATUS, StatusChip, TYPE_LABEL, shortSha, targetLabel, when,
} from './labels';

export default function EnvironmentsSection({ targets }: { targets: DeployTarget[] }) {
  const [envs, setEnvs] = useState<Environment[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => listEnvironments()
    .then((r) => { setEnvs(r.environments); setError(''); })
    .catch((e) => setError(errorText(e, "Couldn't load environments."))), []);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Environments</h2>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Environments"
        columns={[
          { key: 'name', label: 'Name' }, { key: 'target', label: 'Target' }, { key: 'type', label: 'Type' },
          { key: 'ref', label: 'Ref · SHA', mono: true }, { key: 'status', label: 'Status' },
          { key: 'last', label: 'Last deploy' },
        ]}
        rows={(envs ?? []).map((e) => ({
          key: e.id,
          cells: [
            <Link to={`/deploy/environments/${encodeURIComponent(e.name)}`}><b className="cell-top">{e.name}</b></Link>,
            targetLabel(targets, e.target),
            TYPE_LABEL[e.type] ?? e.type,
            `${e.git_ref} · ${shortSha(e.current_sha)}`,
            <StatusChip map={ENV_STATUS} status={e.status} />,
            e.last_deployment
              ? <><StatusChip map={DEPLOYMENT_STATUS} status={e.last_deployment.status} />{' '}
                  <span className="mono">{when(e.last_deployment.finished_at ?? e.last_deployment.started_at)}</span></>
              : '—',
          ],
        }))}
        emptyText={envs === null ? 'Loading…' : 'No environments yet.'}
      />
    </section>
  );
}
```

In `sirdar/web/src/pages/Deploy.tsx`:

Replace the first import line

```tsx
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
```

with

```tsx
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
```

Below `import SshTargetModal from '../components/SshTargetModal';` add:

```tsx
import { arrowNav } from '../lib/arrowNav';
import { NAME_HELP, nameProblem } from '../lib/envRules';
```

and below the `../lib/sirdarApi` import add:

```tsx

import EnvironmentsSection from './environments/EnvironmentsSection';
```

Delete these blocks from `Deploy.tsx` (they now live in `lib/`): the `RESERVED_NAMES` and `NAME_HELP` constants, the `nameProblem` function with its doc comment, and the `arrowNav` function with its doc comment.

Replace the header paragraph

```tsx
        <p>Pick where and what kind of environment to deploy. This step tests the connection;
           deploying the apps comes next.</p>
```

with

```tsx
        <p>Create environments and deploy them to your targets, or test a target's connection.</p>
```

Insert the section directly after `{loadError && <p className="form-error" role="alert">{loadError}</p>}`:

```tsx
      <EnvironmentsSection targets={targets} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/lib src/pages/environments src/pages/Deploy.test.tsx`
Expected: PASS — envRules, labels, EnvironmentsSection, all old Deploy tests and the new one.

- [ ] **Step 6: Type-check and run the web suite**

Run: `npm --prefix sirdar/web run build && npm --prefix sirdar/web test`
Expected: build succeeds; every test passes (including `portalImports.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/lib/envRules.ts sirdar/web/src/lib/envRules.test.ts sirdar/web/src/lib/arrowNav.ts sirdar/web/src/pages/environments sirdar/web/src/pages/Deploy.tsx sirdar/web/src/pages/Deploy.test.tsx
git commit -m "feat(sirdar-web): Environments list on the Deploy page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: New environment modal (Create and Adopt) with host-key trust

**Files:**
- Modify: `sirdar/web/src/components/HostKeyModal.tsx`, `sirdar/web/src/components/HostKeyModal.test.tsx`
- Create: `sirdar/web/src/components/useHostKeyTrust.tsx`
- Create: `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvironmentsSection.tsx` (button + modal), `EnvironmentsSection.test.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`

**Interfaces:**
- Consumes: Task 3 (`getDeployTargets`, `getEnvironmentDefaults`, `createEnvironment`, `adoptEnvironment`, `trustKnownHost`, `errorDetail`, `errorText`, `deployErrorText`), Task 5 (`envRules`, `arrowNav`, `labels`, `testData`).
- Produces:
  - `HostKeyModal` gains `trustLabel?: string` (default `'Trust and connect'`).
  - `useHostKeyTrust({ target, canTrust, trustLabel, onTrusted, onProblem }): { handle(err: unknown): boolean; open: boolean; modal: ReactNode }` — `handle` takes over `host_key_unknown` (opens `HostKeyModal`; trusting calls `trustKnownHost(host, port, fingerprint[, target when it starts with "ssh:"])` then `onTrusted()`) and `host_key_mismatch` (calls `onProblem(message)`), returning `true` for those; `modal` must be rendered by the caller.
  - `NewEnvironmentModal({ onCreated, onClose }: { onCreated: (env: Environment) => void; onClose: () => void })`.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/web/src/components/HostKeyModal.test.tsx`:

```tsx
it('the trust button can be relabeled for the action it retries', () => {
  render(<HostKeyModal {...base} trustLabel="Trust and deploy" onTrust={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Trust and deploy' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Trust and connect' })).toBeNull();
});
```

Create `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), getEnvironmentDefaults: vi.fn(), createEnvironment: vi.fn(),
  adoptEnvironment: vi.fn(), trustKnownHost: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import NewEnvironmentModal from './NewEnvironmentModal';
import { DEFAULTS, ENV, TARGETS } from './testData';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue(TARGETS);
  api.getEnvironmentDefaults.mockResolvedValue(DEFAULTS);
  api.createEnvironment.mockResolvedValue(ENV);
});
afterEach(cleanup);

async function open(onCreated = vi.fn(), onClose = vi.fn()) {
  render(<NewEnvironmentModal onCreated={onCreated} onClose={onClose} />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
  return { onCreated, onClose };
}
const next = () => userEvent.click(screen.getByRole('button', { name: 'Next' }));

async function fillBasics(name = 'qa') {
  await userEvent.type(screen.getByLabelText('Name'), name);
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.6');
}

it('has the report-generate header and the Create steps', async () => {
  await open();
  expect(screen.getByRole('heading', { name: 'New environment' })).toBeTruthy();
  expect(screen.getByText('Deploy', { selector: '.eyebrow' })).toBeTruthy();
  expect(screen.getByText(/Sirdar generates its secrets/)).toBeTruthy();
  expect(['Basics', 'Services', 'Review'].every((s) => screen.getByText(s))).toBe(true);
});

it('creates an environment through Basics, Services and Review', async () => {
  const { onCreated } = await open();
  await fillBasics();
  await next();
  const table = await screen.findByRole('table', { name: 'Services' });
  expect(within(table).getByText('api.qa.serversherpa.com')).toBeTruthy();
  const apiPort = screen.getByLabelText('api port') as HTMLInputElement;
  expect(apiPort.value).toBe('8000');
  await userEvent.clear(apiPort);
  await userEvent.type(apiPort, '8100');
  await next();
  expect(screen.getByText('/opt/serversherpa/qa')).toBeTruthy();
  expect(within(screen.getByRole('table', { name: 'Services to create' })).getByText('8100')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(ENV));
  expect(api.createEnvironment).toHaveBeenCalledWith({
    name: 'qa', type: 'custom', target: 'ssh:lab', git_ref: 'main', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0',
    ports: { api: 8100, portal: 8091, kiosk: 8090, wiki: 8096, spaces: 9000, status: 8095, mailpit: 8025 },
  });
});

it('checks the basics and the ports before moving on', async () => {
  await open();
  await next();
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  expect(screen.getByText('Enter the proxy IP.')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Name'), 'dev');
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.6');
  await next();
  expect(screen.getByText('That name is reserved. Choose a different one.')).toBeTruthy();
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next();
  const portal = await screen.findByLabelText('portal port');
  await userEvent.clear(portal);
  await userEvent.type(portal, '8000');
  await next();
  expect(screen.getByText("Two services can't use the same port.")).toBeTruthy();
  expect(api.createEnvironment).not.toHaveBeenCalled();
});

it('an API error goes back to the step that owns the field', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'environment_exists', { code: 'environment_exists' }));
  await open();
  await fillBasics();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText('An environment with that name already exists.')).toBeTruthy();
  expect(screen.getByLabelText('Name')).toBeTruthy();
});

it('adopts an existing environment and lists what it imported and ignored', async () => {
  api.adoptEnvironment.mockResolvedValue({
    ...ENV, imported_secrets: ['POSTGRES_PASSWORD', 'SS_JWT_SECRET'], ignored_keys: ['MINIO_ROOT_PASSWORD'],
  });
  const { onCreated } = await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  expect(screen.queryByLabelText('Proxy IP')).toBeNull();
  expect(screen.getByText('Result')).toBeTruthy();
  expect(screen.getByText(/changes nothing/)).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  expect(await screen.findByText('MINIO_ROOT_PASSWORD')).toBeTruthy();
  expect(screen.getByText('POSTGRES_PASSWORD')).toBeTruthy();
  expect(screen.getByText('SS_JWT_SECRET')).toBeTruthy();
  expect(api.adoptEnvironment).toHaveBeenCalledWith({ name: 'uat', type: 'dev', target: 'ssh:lab', git_ref: 'main' });
  await userEvent.click(screen.getByRole('button', { name: 'Open environment' }));
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: 'uat' }));
});

it('adopt: an unknown host key asks to trust it with the target, then adopts', async () => {
  api.adoptEnvironment
    .mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
      code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }))
    .mockResolvedValueOnce({ ...ENV, imported_secrets: [], ignored_keys: [] });
  api.trustKnownHost.mockResolvedValue({});
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and adopt' }));
  expect(await screen.findByText('None. Sirdar knows every key in that .env.')).toBeTruthy();
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.adoptEnvironment).toHaveBeenCalledTimes(2);
});

it('adopt: a mismatched host key explains what to do', async () => {
  api.adoptEnvironment.mockRejectedValue(new ApiError(409, 'host_key_mismatch', {
    code: 'host_key_mismatch', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' }));
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  expect(await screen.findByText(/doesn't match the one Sirdar trusted/)).toBeTruthy();
  expect(screen.getByText(/Trusted SSH hosts/)).toBeTruthy();
});

it('Escape and Cancel close it', async () => {
  const { onClose } = await open();
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
```

In `sirdar/web/src/pages/environments/EnvironmentsSection.test.tsx`:

Add after the `vi.mock('../../lib/sirdarApi', …)` line:

```tsx
vi.mock('./NewEnvironmentModal', () => ({
  default: ({ onCreated }: { onCreated: (env: typeof ENV) => void }) => (
    <div role="dialog" aria-label="New environment">
      <button type="button" onClick={() => onCreated(ENV)}>fake create</button>
    </div>
  ),
}));
```

Change the testing-library import to add `userEvent`:

```tsx
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
```

Append:

```tsx
it('New environment needs deploy:add; creating one opens its page', async () => {
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'New environment' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'New environment' })).getByRole('button', { name: 'fake create' }));
  expect(await screen.findByText('detail page')).toBeTruthy();
  cleanup();
  perms.add = false;
  show();
  await screen.findByText('No environments yet.');
  expect(screen.queryByRole('button', { name: 'New environment' })).toBeNull();
});
```

(`vi.mock` factories are hoisted above the imports, but the factory only reads `ENV` when the mocked component renders, after the module has loaded, so referring to it there is safe.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/components/HostKeyModal.test.tsx src/pages/environments`
Expected: FAIL — HostKeyModal ignores `trustLabel`; `./NewEnvironmentModal` cannot be resolved; the section has no New environment button.

- [ ] **Step 3: Implement HostKeyModal's label and the trust hook**

In `sirdar/web/src/components/HostKeyModal.tsx`, change the signature and the trust button:

```tsx
export default function HostKeyModal({ host, port, keyType, fingerprint, canTrust, busy, error, trustLabel = 'Trust and connect', onTrust, onCancel }: {
  host: string; port: number; keyType: string; fingerprint: string;
  canTrust: boolean; busy: boolean; error: string; trustLabel?: string;
  onTrust: () => void; onCancel: () => void;
}) {
```

```tsx
          <button type="button" className="btn-solid" disabled={!canTrust || busy} onClick={onTrust}>
            {trustLabel}
          </button>
```

Create `sirdar/web/src/components/useHostKeyTrust.tsx`:

```tsx
import { useRef, useState, type ReactNode } from 'react';

import { errorDetail, errorText, trustKnownHost } from '../lib/sirdarApi';

import HostKeyModal from './HostKeyModal';

export interface HostKeyInfo {
  host: string; port: number; key_type: string; fingerprint?: string; expected?: string; actual?: string;
}

/** The host-key half of an action that SSHes to `target`. `handle(err)` takes
 *  over host_key_unknown (shows HostKeyModal; trusting retries through
 *  `onTrusted`) and host_key_mismatch (a message for `onProblem`), and says
 *  whether it did. The caller renders `modal`. */
export function useHostKeyTrust({ target, canTrust, trustLabel, onTrusted, onProblem }: {
  target: string; canTrust: boolean; trustLabel: string;
  onTrusted: () => void; onProblem: (message: string) => void;
}): { handle: (err: unknown) => boolean; open: boolean; modal: ReactNode } {
  const [unknown, setUnknown] = useState<HostKeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef({ onTrusted, onProblem });
  latest.current = { onTrusted, onProblem };

  const handle = (err: unknown): boolean => {
    const code = (err as { code?: string }).code;
    const d = errorDetail<HostKeyInfo>(err);
    if (code === 'host_key_unknown' && d) { setError(''); setUnknown(d); return true; }
    if (code === 'host_key_mismatch' && d) {
      latest.current.onProblem(`The key of ${d.host}:${d.port} doesn't match the one Sirdar trusted. `
        + 'Check the server, then forget the old key under Trusted SSH hosts on the Deploy page.');
      return true;
    }
    return false;
  };

  const trust = async () => {
    if (!unknown?.fingerprint) return;
    setBusy(true); setError('');
    try {
      if (target.startsWith('ssh:')) await trustKnownHost(unknown.host, unknown.port, unknown.fingerprint, target);
      else await trustKnownHost(unknown.host, unknown.port, unknown.fingerprint);
    } catch (e) {
      setBusy(false);
      if ((e as { code?: string }).code === 'host_key_changed') {
        setUnknown(null);
        latest.current.onProblem("The server's key changed while you were looking. Try again.");
        return;
      }
      setError(errorText(e, "Couldn't trust this server."));
      return;
    }
    setBusy(false);
    setUnknown(null);
    latest.current.onTrusted();
  };

  const modal = unknown ? (
    <HostKeyModal host={unknown.host} port={unknown.port} keyType={unknown.key_type}
                  fingerprint={unknown.fingerprint ?? ''} canTrust={canTrust} busy={busy} error={error}
                  trustLabel={trustLabel} onTrust={trust} onCancel={() => setUnknown(null)} />
  ) : null;
  return { handle, open: unknown !== null, modal };
}
```

- [ ] **Step 4: Implement the modal**

Create `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`:

```tsx
/** New environment: Create (Basics › Services › Review) makes a new
 *  environment record with generated secrets; Adopt (Basics › Result) reads a
 *  hand-built environment's .env and checkout over SSH and changes nothing. */
import { Fragment, useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { arrowNav } from '../../lib/arrowNav';
import { NAME_HELP, ipv4Problem, nameProblem, portProblem, refProblem } from '../../lib/envRules';
import {
  adoptEnvironment, createEnvironment, deployErrorText, getDeployTargets, getEnvironmentDefaults,
  type AdoptedEnvironment, type DeployTarget, type EnvType, type Environment, type EnvironmentDefaults,
} from '../../lib/sirdarApi';

import { TYPE_LABEL, sshTargets } from './labels';

type Mode = 'new' | 'adopt';
type Step = 'basics' | 'services' | 'review' | 'result';
type Field = 'name' | 'target' | 'ref' | 'domain' | 'proxy' | 'bind' | 'services' | 'form';
type Errors = Partial<Record<Field, string>>;

const TYPES: EnvType[] = ['dev', 'beta', 'custom'];
const MODES: [Mode, string][] = [['new', 'Create new'], ['adopt', 'Adopt existing']];
const STEPS: Record<Mode, [Step, string][]> = {
  new: [['basics', 'Basics'], ['services', 'Services'], ['review', 'Review']],
  adopt: [['basics', 'Basics'], ['result', 'Result']],
};
const HINT: Record<Mode, string> = {
  new: 'Create an environment on an SSH target. Sirdar generates its secrets; the first deploy builds it.',
  adopt: "Adopt an environment set up by hand. Sirdar reads its .env and git checkout over SSH and changes nothing.",
};
/** API error code → the field (and so the step) it belongs to. */
const CODE_FIELD: Record<string, Field> = {
  name_invalid: 'name', name_reserved: 'name', environment_exists: 'name',
  target_invalid: 'target', target_not_configured: 'target', ref_invalid: 'ref',
  base_domain_invalid: 'domain', proxy_ip_required: 'proxy', proxy_ip_invalid: 'proxy',
  bind_ip_invalid: 'bind', port_invalid: 'services', ports_conflict: 'services', service_unknown: 'services',
};
const only = (e: Errors): Errors => Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Errors;

export default function NewEnvironmentModal({ onCreated, onClose }: {
  onCreated: (env: Environment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [targets, setTargets] = useState<DeployTarget[] | null>(null);
  const [defaults, setDefaults] = useState<EnvironmentDefaults | null>(null);
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<Mode>('new');
  const [step, setStep] = useState<Step>('basics');
  const [name, setName] = useState('');
  const [type, setType] = useState<EnvType>('dev');
  const [target, setTarget] = useState('');
  const [ref, setRef] = useState('main');
  const [domain, setDomain] = useState('');
  const [proxy, setProxy] = useState('');
  const [bind, setBind] = useState('0.0.0.0');
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdoptedEnvironment | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const nameRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust({
    target, canTrust: can('deploy', 'change'), trustLabel: 'Trust and adopt',
    onTrusted: () => { void submit(); }, onProblem: (message) => setErrors({ form: message }),
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current && !hostKeyOpen.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([getDeployTargets(), getEnvironmentDefaults()]).then(([t, d]) => {
      if (!live) return;
      const ssh = sshTargets(t.targets);
      setTargets(ssh);
      setDefaults(d);
      setTarget((cur) => cur || ssh[0]?.id || '');
      setRef(d.git_ref);
      setBind(d.bind_ip);
      setPorts(Object.fromEntries(d.services.map((s) => [s.service, String(s.port)])));
    }).catch((e) => { if (live) setLoadError(deployErrorText(e, "Couldn't load the targets and defaults.")); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (defaults) nameRef.current?.focus(); }, [defaults]);

  const trimmed = name.trim();
  const services = defaults?.services ?? [];
  const effectiveDomain = domain.trim() || `${trimmed || '<name>'}.${defaults?.domain_suffix ?? 'serversherpa.com'}`;
  const targetName = (id: string) => targets?.find((t) => t.id === id)?.label ?? id;

  const basicsErrors = (): Errors => only({
    name: trimmed ? nameProblem(trimmed) : 'Enter a name.',
    target: target ? '' : 'Choose an SSH target.',
    ref: refProblem(ref),
    proxy: mode === 'new' ? ipv4Problem(proxy, 'proxy IP') : '',
    bind: mode === 'new' ? ipv4Problem(bind, 'bind IP') : '',
  });
  const servicesErrors = (): Errors => {
    for (const s of services) {
      const p = portProblem(ports[s.service] ?? '');
      if (p) return { services: `${s.service}: ${p}` };
    }
    const used = services.map((s) => Number(ports[s.service]));
    return new Set(used).size === used.length ? {} : { services: "Two services can't use the same port." };
  };

  const next = () => {
    const e = step === 'basics' ? basicsErrors() : servicesErrors();
    setErrors(e);
    if (Object.keys(e).length) return;
    setStep(step === 'basics' ? 'services' : 'review');
  };
  const back = () => { setErrors({}); setStep(step === 'review' ? 'services' : 'basics'); };

  const fail = (err: unknown) => {
    if (hostKey.handle(err)) return;
    const code = (err as { code?: string }).code ?? '';
    const field = CODE_FIELD[code] ?? 'form';
    setErrors({ [field]: deployErrorText(err, mode === 'new' ? "Couldn't create the environment." : "Couldn't adopt the environment.") });
    if (field === 'services') setStep('services');
    else if (field !== 'form') setStep('basics');
  };

  const submit = async () => {
    if (busyRef.current) return;
    if (mode === 'adopt') {
      const e = basicsErrors();
      setErrors(e);
      if (Object.keys(e).length) return;
    }
    busyRef.current = true;
    setBusy(true);
    setErrors({});
    try {
      if (mode === 'new') {
        onCreated(await createEnvironment({
          name: trimmed, type, target, git_ref: ref.trim(),
          ...(domain.trim() ? { base_domain: domain.trim() } : {}),
          proxy_ip: proxy.trim(), bind_ip: bind.trim(),
          ports: Object.fromEntries(services.map((s) => [s.service, Number(ports[s.service])])),
        }));
        return;
      }
      setResult(await adoptEnvironment({ name: trimmed, type, target, git_ref: ref.trim() }));
      setStep('result');
    } catch (err) {
      fail(err);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const stepList = STEPS[mode];
  const at = stepList.findIndex(([s]) => s === step);

  const radios = <T extends string>(items: [T, string][], value: T, set: (v: T) => void) => items.map(([v, label]) => (
    <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''}
            tabIndex={value === v ? 0 : -1} onKeyDown={arrowNav}
            onClick={() => { set(v); setErrors({}); }}>{label}</button>
  ));

  return (
    <>
      <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-envmodal-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-envmodal-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Deploy</div>
              <h3 id="sirdar-envmodal-title">New environment</h3>
              <p className="page-hint">{HINT[mode]}</p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="rgm-steps">
            {stepList.map(([s, label], i) => (
              <Fragment key={s}>
                {i > 0 && <span className="rgm-step-sep" />}
                <span className={`rgm-step${i === at ? ' on' : ''}${i < at ? ' done' : ''}`}>
                  <span className="rgm-step-num">{i + 1}</span>
                  <span className="rgm-step-label">{label}</span>
                </span>
              </Fragment>
            ))}
          </div>

          <div className="modal-body pf-form">
            {loadError && <p className="form-error" role="alert">{loadError}</p>}
            {!defaults && !loadError && <p className="page-hint">Loading…</p>}

            {defaults && step === 'basics' && (
              <div className="sirdar-env-grid">
                <div className="sirdar-span2">
                  <span className="field-label" id="env-mode-label">How to add it</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-mode-label">
                    {radios(MODES, mode, setMode)}
                  </div>
                </div>
                <div>
                  <label className="field-label" htmlFor="env-new-name">Name</label>
                  <input id="env-new-name" ref={nameRef} type="text" value={name} maxLength={64} autoComplete="off"
                         spellCheck={false} aria-invalid={!!errors.name} aria-describedby="env-new-name-help"
                         onChange={(e) => setName(e.target.value)} />
                  <p id="env-new-name-help" className="page-hint">{NAME_HELP}</p>
                  {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
                </div>
                <div>
                  <span className="field-label" id="env-type-label">Type</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-type-label">
                    {radios(TYPES.map((t) => [t, TYPE_LABEL[t]] as [EnvType, string]), type, setType)}
                  </div>
                </div>
                <div>
                  <label className="field-label" htmlFor="env-new-target">Target</label>
                  <ComboBox inputId="env-new-target" ariaLabel="Target" portal value={target}
                            placeholder="Choose an SSH target…"
                            options={(targets ?? []).map((t) => ({ value: t.id, label: t.label }))}
                            onChange={setTarget} />
                  {targets && targets.length === 0 && (
                    <p className="page-hint">No SSH target is ready. Add one under Target on the Deploy page first.</p>
                  )}
                  {errors.target && <p className="form-error" role="alert">{errors.target}</p>}
                </div>
                <div>
                  <label className="field-label" htmlFor="env-new-ref">Git ref</label>
                  <input id="env-new-ref" type="text" value={ref} maxLength={200} autoComplete="off" spellCheck={false}
                         aria-invalid={!!errors.ref} onChange={(e) => setRef(e.target.value)} />
                  <p className="page-hint">The branch, tag or commit deploys use unless you pick another.</p>
                  {errors.ref && <p className="form-error" role="alert">{errors.ref}</p>}
                </div>
                {mode === 'new' && (
                  <>
                    <div>
                      <label className="field-label" htmlFor="env-new-domain">Base domain</label>
                      <input id="env-new-domain" type="text" value={domain} maxLength={253} autoComplete="off"
                             spellCheck={false} placeholder={effectiveDomain} aria-invalid={!!errors.domain}
                             onChange={(e) => setDomain(e.target.value)} />
                      <p className="page-hint">Leave empty for {effectiveDomain}.</p>
                      {errors.domain && <p className="form-error" role="alert">{errors.domain}</p>}
                    </div>
                    <div>
                      <label className="field-label" htmlFor="env-new-proxy">Proxy IP</label>
                      <input id="env-new-proxy" type="text" value={proxy} maxLength={45} autoComplete="off"
                             spellCheck={false} aria-invalid={!!errors.proxy} onChange={(e) => setProxy(e.target.value)} />
                      <p className="page-hint">Nginx Proxy Manager's LAN address. The apps trust forwarded headers from it only.</p>
                      {errors.proxy && <p className="form-error" role="alert">{errors.proxy}</p>}
                    </div>
                    <div>
                      <label className="field-label" htmlFor="env-new-bind">Bind IP</label>
                      <input id="env-new-bind" type="text" value={bind} maxLength={45} autoComplete="off"
                             spellCheck={false} aria-invalid={!!errors.bind} onChange={(e) => setBind(e.target.value)} />
                      <p className="page-hint">The address the target publishes the service ports on.</p>
                      {errors.bind && <p className="form-error" role="alert">{errors.bind}</p>}
                    </div>
                  </>
                )}
              </div>
            )}

            {defaults && step === 'services' && (
              <>
                <p className="page-hint">
                  Every service runs on the chosen target. Public names point at the proxy; mailpit stays on the LAN.
                </p>
                <DataTable
                  ariaLabel="Services"
                  columns={[
                    { key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
                    { key: 'addr', label: 'Address' }, { key: 'port', label: 'Port', width: '120px' },
                  ]}
                  rows={services.map((s) => ({
                    key: s.service,
                    cells: [
                      <b className="cell-top">{s.service}</b>,
                      s.public ? `${s.service}.${effectiveDomain}` : '—',
                      <span className="cell-sub">Target's address</span>,
                      <input className="sirdar-port-input" type="text" inputMode="numeric" aria-label={`${s.service} port`}
                             value={ports[s.service] ?? ''}
                             onChange={(e) => setPorts((p) => ({ ...p, [s.service]: e.target.value }))} />,
                    ],
                  }))}
                />
                {errors.services && <p className="form-error" role="alert">{errors.services}</p>}
              </>
            )}

            {defaults && step === 'review' && (
              <>
                <dl className="sirdar-kv">
                  <dt>Name</dt><dd className="mono">{trimmed}</dd>
                  <dt>Type</dt><dd>{TYPE_LABEL[type]}</dd>
                  <dt>Target</dt><dd>{targetName(target)}</dd>
                  <dt>Git ref</dt><dd className="mono">{ref.trim()}</dd>
                  <dt>Folder on the target</dt><dd className="mono">{`${defaults.env_root}/${trimmed}`}</dd>
                  <dt>Base domain</dt><dd className="mono">{effectiveDomain}</dd>
                  <dt>Proxy IP</dt><dd className="mono">{proxy.trim()}</dd>
                  <dt>Bind IP</dt><dd className="mono">{bind.trim()}</dd>
                  <dt>Secrets</dt><dd>Generated by Sirdar and never shown</dd>
                </dl>
                <h4 className="sirdar-sub">Services</h4>
                <DataTable
                  ariaLabel="Services to create"
                  columns={[{ key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
                            { key: 'port', label: 'Port', mono: true }]}
                  rows={services.map((s) => ({
                    key: s.service,
                    cells: [<b className="cell-top">{s.service}</b>, s.public ? `${s.service}.${effectiveDomain}` : '—',
                            ports[s.service]],
                  }))}
                />
                <p className="page-hint">Nothing is installed until the first deploy. DNS records and proxy hosts are still set up by hand.</p>
              </>
            )}

            {step === 'result' && result && (
              <>
                <p>Adopted <b>{result.name}</b>. Nothing on the target was changed.</p>
                <dl className="sirdar-kv">
                  <dt>Running commit</dt><dd className="mono">{result.current_sha ?? '—'}</dd>
                  <dt>Image tag</dt><dd className="mono">{result.image_tag ?? '—'}</dd>
                  <dt>Base domain</dt><dd className="mono">{result.base_domain}</dd>
                  <dt>Folder</dt><dd className="mono">{result.env_dir}</dd>
                </dl>
                <h4 className="sirdar-sub">Imported secrets</h4>
                <div className="sirdar-chips">
                  {result.imported_secrets.map((k) => <span key={k} className="chip tag mono">{k}</span>)}
                </div>
                <h4 className="sirdar-sub">Ignored keys</h4>
                {result.ignored_keys.length ? (
                  <>
                    <div className="sirdar-chips">
                      {result.ignored_keys.map((k) => <span key={k} className="chip tag mono">{k}</span>)}
                    </div>
                    <p className="page-hint">Sirdar doesn't use these. The next deploy writes the .env without them.</p>
                  </>
                ) : <p className="page-hint">None. Sirdar knows every key in that .env.</p>}
              </>
            )}

            {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
          </div>

          <div className="modal-foot">
            {step === 'result' ? (
              <button type="button" className="btn-solid" onClick={() => { if (result) onCreated(result); }}>Open environment</button>
            ) : (
              <>
                <button type="button" className="btn-ghost" disabled={busy} onClick={step === 'basics' ? onClose : back}>
                  {step === 'basics' ? 'Cancel' : 'Back'}
                </button>
                {mode === 'adopt' ? (
                  <button type="button" className="btn-solid" disabled={!defaults || busy} onClick={() => void submit()}>
                    {busy ? 'Adopting…' : 'Adopt'}
                  </button>
                ) : step === 'review' ? (
                  <button type="button" className="btn-solid" disabled={busy} onClick={() => void submit()}>
                    {busy ? 'Creating…' : 'Create environment'}
                  </button>
                ) : (
                  <button type="button" className="btn-solid" disabled={!defaults} onClick={next}>Next</button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
```

- [ ] **Step 5: Wire it into the section and add the styles**

Replace `sirdar/web/src/pages/environments/EnvironmentsSection.tsx` with:

```tsx
/** The Environments section at the top of /deploy. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import { errorText, listEnvironments, type DeployTarget, type Environment } from '../../lib/sirdarApi';

import {
  DEPLOYMENT_STATUS, ENV_STATUS, StatusChip, TYPE_LABEL, shortSha, targetLabel, when,
} from './labels';
import NewEnvironmentModal from './NewEnvironmentModal';

export default function EnvironmentsSection({ targets }: { targets: DeployTarget[] }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [envs, setEnvs] = useState<Environment[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => listEnvironments()
    .then((r) => { setEnvs(r.environments); setError(''); })
    .catch((e) => setError(errorText(e, "Couldn't load environments."))), []);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Environments</h2>
        {can('deploy', 'add') && (
          <button type="button" className="btn-solid" onClick={() => setCreating(true)}>New environment</button>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Environments"
        columns={[
          { key: 'name', label: 'Name' }, { key: 'target', label: 'Target' }, { key: 'type', label: 'Type' },
          { key: 'ref', label: 'Ref · SHA', mono: true }, { key: 'status', label: 'Status' },
          { key: 'last', label: 'Last deploy' },
        ]}
        rows={(envs ?? []).map((e) => ({
          key: e.id,
          cells: [
            <Link to={`/deploy/environments/${encodeURIComponent(e.name)}`}><b className="cell-top">{e.name}</b></Link>,
            targetLabel(targets, e.target),
            TYPE_LABEL[e.type] ?? e.type,
            `${e.git_ref} · ${shortSha(e.current_sha)}`,
            <StatusChip map={ENV_STATUS} status={e.status} />,
            e.last_deployment
              ? <><StatusChip map={DEPLOYMENT_STATUS} status={e.last_deployment.status} />{' '}
                  <span className="mono">{when(e.last_deployment.finished_at ?? e.last_deployment.started_at)}</span></>
              : '—',
          ],
        }))}
        emptyText={envs === null ? 'Loading…' : 'No environments yet.'}
      />
      {creating && (
        <NewEnvironmentModal
          onClose={() => setCreating(false)}
          onCreated={(env) => { setCreating(false); navigate(`/deploy/environments/${encodeURIComponent(env.name)}`); }} />
      )}
    </section>
  );
}
```

Append to `sirdar/web/src/styles/sirdar.css`:

```css
/* Environments (deploy step 2). The 4-class selectors out-rank the portal's
   `.modal-card.reports-modal-card.rgm-card` width. */
.modal-card.reports-modal-card.rgm-card.sirdar-envmodal-card { width: min(860px, 96vw); max-width: 96vw; }
.sirdar-env-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; align-items: start; }
.sirdar-env-grid .sirdar-span2 { grid-column: 1 / -1; }
@media (max-width: 720px) { .sirdar-env-grid { grid-template-columns: 1fr; } }
.sirdar-port-input { width: 96px; }
.sirdar-sub { margin: 16px 0 8px; }
.sirdar-chips { display: flex; flex-wrap: wrap; gap: 6px; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/components src/pages/environments src/pages/Deploy.test.tsx`
Expected: PASS.

- [ ] **Step 7: Type-check and run the web suite**

Run: `npm --prefix sirdar/web run build && npm --prefix sirdar/web test`
Expected: build succeeds; every test passes.

- [ ] **Step 8: Commit**

```bash
git add sirdar/web/src/components/HostKeyModal.tsx sirdar/web/src/components/HostKeyModal.test.tsx sirdar/web/src/components/useHostKeyTrust.tsx sirdar/web/src/pages/environments sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): New environment modal — create (Basics, Services, Review) and adopt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Deploy modal

**Files:**
- Create: `sirdar/web/src/pages/environments/DeployModal.tsx`, `sirdar/web/src/pages/environments/DeployModal.test.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`

**Interfaces:**
- Consumes: `startDeployment`, `deployErrorText` (Task 3); `refProblem`, `arrowNav` (Task 5); `useHostKeyTrust` (Task 6).
- Produces: `DeployModal({ env, onStarted, onClose }: { env: Environment; onStarted: (dep: Deployment) => void; onClose: () => void })`. Title "Deploy <name>"; field "Git ref" (prefilled with `env.git_ref`); radios "Update" / "Reset data" (Reset is `aria-disabled` without `deploy:change`); Reset shows "Type <name> to confirm"; the submit button is "Deploy" or "Reset and deploy".

- [ ] **Step 1: Write the failing test**

Create `sirdar/web/src/pages/environments/DeployModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({ startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DeployModal from './DeployModal';
import { ENV, RUNNING } from './testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.startDeployment.mockResolvedValue(RUNNING);
});
afterEach(cleanup);

function open(env = ENV) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<DeployModal env={env} onStarted={onStarted} onClose={onClose} />);
  return { onStarted, onClose };
}
const deployBtn = () => screen.getByRole('button', { name: /^(Deploy|Reset and deploy|Starting…)$/ }) as HTMLButtonElement;

it('starts an Update from the environment's ref', async () => {
  const { onStarted } = open({ ...ENV, git_ref: 'release/2.9' });
  expect(screen.getByRole('heading', { name: 'Deploy uat' })).toBeTruthy();
  expect(screen.getByText(/Runs in \/opt\/serversherpa\/uat/)).toBeTruthy();
  expect((screen.getByLabelText('Git ref') as HTMLInputElement).value).toBe('release/2.9');
  expect(screen.getByRole('radio', { name: 'Update' }).getAttribute('aria-checked')).toBe('true');
  await userEvent.click(deployBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'update', git_ref: 'release/2.9' });
});

it('Reset data needs the typed environment name', async () => {
  const { onStarted } = open();
  await userEvent.click(screen.getByRole('radio', { name: 'Reset data' }));
  expect(screen.getByText(/can't be undone/)).toBeTruthy();
  expect(deployBtn().textContent).toBe('Reset and deploy');
  expect(deployBtn().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'ua');
  expect(deployBtn().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 't');
  await userEvent.click(deployBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'reset', git_ref: 'main', confirm_name: 'uat' });
});

it('without deploy:change Reset data is locked', async () => {
  perms.change = false;
  open();
  const reset = screen.getByRole('radio', { name: 'Reset data' });
  expect(reset.getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(reset);
  expect(reset.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText('Reset data needs permission to change deployments.')).toBeTruthy();
});

it('checks the ref first, and shows ref and target errors where they belong', async () => {
  open();
  await userEvent.clear(screen.getByLabelText('Git ref'));
  await userEvent.type(screen.getByLabelText('Git ref'), 'a..b');
  await userEvent.click(deployBtn());
  expect(screen.getByText("That isn't a valid branch, tag or commit.")).toBeTruthy();
  expect(api.startDeployment).not.toHaveBeenCalled();

  api.startDeployment.mockRejectedValueOnce(new ApiError(422, 'ref_not_found', { code: 'ref_not_found' }));
  await userEvent.clear(screen.getByLabelText('Git ref'));
  await userEvent.type(screen.getByLabelText('Git ref'), 'nope');
  await userEvent.click(deployBtn());
  expect(await screen.findByText('The repository has no branch, tag or commit by that name.')).toBeTruthy();

  api.startDeployment.mockRejectedValueOnce(new ApiError(502, 'git_missing', {
    code: 'git_missing', reason: "git isn't installed on the target. Install it (sudo apt-get install git) and try again." }));
  await userEvent.click(deployBtn());
  expect(await screen.findByText(/sudo apt-get install git/)).toBeTruthy();

  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  await userEvent.click(deployBtn());
  expect(await screen.findByText('A deployment of this environment is already running.')).toBeTruthy();
});

it('an unknown host key asks to trust it, then deploys', async () => {
  api.startDeployment
    .mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
      code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }))
    .mockResolvedValueOnce(RUNNING);
  api.trustKnownHost.mockResolvedValue({});
  const { onStarted } = open({ ...ENV, target: 'ssh' });
  await userEvent.click(deployBtn());
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and deploy' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc');
  expect(api.startDeployment).toHaveBeenCalledTimes(2);
});

it('without deploy:add nothing can be started', () => {
  perms.add = false; perms.change = false;
  open();
  expect(deployBtn().disabled).toBe(true);
  expect(screen.getByText('You can view deployments but not start them.')).toBeTruthy();
});

it('Escape closes it, but not while starting', async () => {
  let release!: () => void;
  api.startDeployment.mockReturnValue(new Promise((r) => { release = () => r(RUNNING); }));
  const { onClose, onStarted } = open();
  await userEvent.click(deployBtn());
  await userEvent.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  release();
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  cleanup();
  const again = open();
  await userEvent.keyboard('{Escape}');
  expect(again.onClose).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix sirdar/web test -- src/pages/environments/DeployModal.test.tsx`
Expected: FAIL — `./DeployModal` cannot be resolved.

- [ ] **Step 3: Implement**

Create `sirdar/web/src/pages/environments/DeployModal.tsx`:

```tsx
/** Deploy an environment: a git ref and Update (default) or Reset data
 *  (needs deploy:change and the typed environment name). Opened from the
 *  environment page and from the Dashboard. */
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { arrowNav } from '../../lib/arrowNav';
import { refProblem } from '../../lib/envRules';
import {
  deployErrorText, startDeployment, type DeployMode, type Deployment, type Environment,
} from '../../lib/sirdarApi';

type Field = 'ref' | 'confirm' | 'form';
const MODES: [DeployMode, string, string][] = [
  ['update', 'Update', 'Keeps the data. Once the environment has been deployed, a database dump is taken first.'],
  ['reset', 'Reset data', "Deletes this environment's database and files, then starts it empty. This can't be undone."],
];
const CODE_FIELD: Record<string, Field> = { ref_invalid: 'ref', ref_not_found: 'ref', confirm_name_mismatch: 'confirm' };

export default function DeployModal({ env, onStarted, onClose }: {
  env: Environment; onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const canAdd = can('deploy', 'add');
  const canChange = can('deploy', 'change');
  const [ref, setRef] = useState(env.git_ref);
  const [mode, setMode] = useState<DeployMode>('update');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const refInput = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust({
    target: env.target, canTrust: canChange, trustLabel: 'Trust and deploy',
    onTrusted: () => { void submit(); }, onProblem: (message) => setErrors({ form: message }),
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    refInput.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current && !hostKeyOpen.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const reset = mode === 'reset';
  const ready = canAdd && !busy && (!reset || (canChange && confirm === env.name));

  const submit = async () => {
    if (busyRef.current) return;
    const problem = refProblem(ref);
    if (problem) { setErrors({ ref: problem }); return; }
    if (reset && confirm !== env.name) { setErrors({ confirm: `Type ${env.name} to confirm.` }); return; }
    busyRef.current = true;
    setBusy(true);
    setErrors({});
    try {
      onStarted(await startDeployment(env.name, reset
        ? { mode, git_ref: ref.trim(), confirm_name: confirm }
        : { mode, git_ref: ref.trim() }));
    } catch (err) {
      if (!hostKey.handle(err)) {
        const code = (err as { code?: string }).code ?? '';
        setErrors({ [CODE_FIELD[code] ?? 'form']: deployErrorText(err, "Couldn't start the deployment.") });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-deploy-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Deploy</div>
              <h3 id="sirdar-deploy-title">Deploy {env.name}</h3>
              <p className="page-hint">
                Runs in {env.env_dir} on the target. You can follow each step's log while it runs.
              </p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-deploy-form">
            <div>
              <label className="field-label" htmlFor="deploy-ref">Git ref</label>
              <input id="deploy-ref" ref={refInput} type="text" value={ref} maxLength={200} autoComplete="off"
                     spellCheck={false} aria-invalid={!!errors.ref} onChange={(e) => setRef(e.target.value)} />
              <p className="page-hint">A branch, tag or full commit SHA. The target resolves it to a commit before anything runs.</p>
              {errors.ref && <p className="form-error" role="alert">{errors.ref}</p>}
            </div>
            <div>
              <span className="field-label" id="deploy-mode-label">Mode</span>
              <div className="segmented" role="radiogroup" aria-labelledby="deploy-mode-label">
                {MODES.map(([m, label]) => {
                  const locked = m === 'reset' && !canChange;
                  return (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} aria-disabled={locked}
                            className={mode === m ? 'on' : ''} tabIndex={mode === m ? 0 : -1} onKeyDown={arrowNav}
                            onClick={() => { if (!locked) { setMode(m); setErrors({}); } }}>{label}</button>
                  );
                })}
              </div>
              <p className="page-hint">{MODES.find(([m]) => m === mode)?.[2]}</p>
              {!canChange && <p className="page-hint">Reset data needs permission to change deployments.</p>}
            </div>
            {reset && (
              <div>
                <label className="field-label" htmlFor="deploy-confirm">Type {env.name} to confirm</label>
                <input id="deploy-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                       spellCheck={false} aria-invalid={!!errors.confirm} onChange={(e) => setConfirm(e.target.value)} />
                {errors.confirm && <p className="form-error" role="alert">{errors.confirm}</p>}
              </div>
            )}
            {!canAdd && <p className="page-hint">You can view deployments but not start them.</p>}
            {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-solid" disabled={!ready} onClick={() => void submit()}>
              {busy ? 'Starting…' : reset ? 'Reset and deploy' : 'Deploy'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
```

Append to `sirdar/web/src/styles/sirdar.css`:

```css
.modal-card.reports-modal-card.rgm-card.sirdar-deploy-card { width: min(640px, 96vw); max-width: 96vw; }
.sirdar-deploy-form { display: flex; flex-direction: column; gap: 14px; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix sirdar/web test -- src/pages/environments/DeployModal.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Type-check and run the web suite**

Run: `npm --prefix sirdar/web run build && npm --prefix sirdar/web test`
Expected: build succeeds; every test passes.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/environments/DeployModal.tsx sirdar/web/src/pages/environments/DeployModal.test.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): Deploy modal — Update or Reset data with a typed-name gate and host-key trust

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Environment page with the Overview tab

**Files:**
- Create: `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`, `sirdar/web/src/pages/environments/EnvOverview.tsx`, `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`
- Modify: `sirdar/web/src/App.tsx` (route), `sirdar/web/src/layout/SirdarTopbar.tsx` (crumb), `sirdar/web/src/styles/sirdar.css`

**Interfaces:**
- Consumes: `getEnvironment`, `getDeployTargets` (Task 3); labels (Task 5); `DeployModal` (Task 7).
- Produces: route `/deploy/environments/:name` (inside `<Gate resource="deploy">`) rendering `EnvironmentDetail`; `EnvOverview({ env }: { env: Environment })`. The page has a `role="tablist"` `aria-label="Environment"` (Overview only in this task; Tasks 9 and 10 add tabs) and a header "Deploy" button for `deploy:add`, disabled while `env.status === 'deploying'`.

- [ ] **Step 1: Write the failing test**

Create `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({
  getEnvironment: vi.fn(), getDeployTargets: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import EnvironmentDetail from './EnvironmentDetail';
import { ENV, RUNNING, TARGETS } from './testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getEnvironment.mockResolvedValue(ENV);
  api.getDeployTargets.mockResolvedValue(TARGETS);
});
afterEach(cleanup);

function show(path = '/deploy/environments/uat') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deploy/environments/:name" element={<EnvironmentDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('shows the header and the Overview: commit, image tag, services and links', async () => {
  show();
  expect(await screen.findByRole('heading', { level: 1, name: 'uat' })).toBeTruthy();
  expect(api.getEnvironment).toHaveBeenCalledWith('uat');
  expect(await screen.findByText('Dev · Lab box · uat.serversherpa.com')).toBeTruthy();
  expect(screen.getByText('Ready')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText(ENV.current_sha!)).toBeTruthy();
  expect(screen.getByText('/opt/serversherpa/uat')).toBeTruthy();
  const table = screen.getByRole('table', { name: 'Services' });
  expect(within(table).getByRole('link', { name: 'https://api.uat.serversherpa.com' }).getAttribute('href'))
    .toBe('https://api.uat.serversherpa.com');
  expect(within(table).getByRole('link', { name: '10.10.48.63:8025' }).getAttribute('href')).toBe('http://10.10.48.63:8025');
  expect(within(table).getByText('10.10.48.63:8000')).toBeTruthy();
  expect(screen.getByText('Deploy', { selector: '.eyebrow a' }).getAttribute('href')).toBe('/deploy');
});

it('Deploy opens the Deploy modal; starting reloads the environment', async () => {
  api.startDeployment.mockResolvedValue(RUNNING);
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
  const dialog = await screen.findByRole('dialog', { name: 'Deploy uat' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Deploy' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.getEnvironment).toHaveBeenCalledTimes(2);
});

it('a view-only reader has no Deploy button; a running deployment disables it', async () => {
  perms.add = false; perms.change = false;
  show();
  await screen.findByRole('heading', { level: 1, name: 'uat' });
  expect(screen.queryByRole('button', { name: 'Deploy' })).toBeNull();
  cleanup();
  perms.add = true;
  api.getEnvironment.mockResolvedValue({ ...ENV, status: 'deploying' });
  show();
  expect(((await screen.findByRole('button', { name: 'Deploy' })) as HTMLButtonElement).disabled).toBe(true);
});

it('an unknown environment shows the error', async () => {
  api.getEnvironment.mockRejectedValue(new ApiError(404, 'environment_not_found', { code: 'environment_not_found' }));
  show('/deploy/environments/gone');
  expect((await screen.findByRole('alert')).textContent).toBe('That environment no longer exists.');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix sirdar/web test -- src/pages/environments/EnvironmentDetail.test.tsx`
Expected: FAIL — `./EnvironmentDetail` cannot be resolved.

- [ ] **Step 3: Implement**

Create `sirdar/web/src/pages/environments/EnvOverview.tsx`:

```tsx
/** Overview tab: what's running, and where each service answers. */
import DataTable from '@portal/components/DataTable';

import type { Environment } from '../../lib/sirdarApi';

import { DEPLOYMENT_STATUS, MODE_LABEL, StatusChip, when } from './labels';

export default function EnvOverview({ env }: { env: Environment }) {
  const last = env.last_deployment;
  return (
    <>
      <section className="sirdar-section">
        <h2>Running</h2>
        <dl className="sirdar-kv">
          <dt>Running commit</dt><dd className="mono">{env.current_sha ?? 'Not deployed yet'}</dd>
          <dt>Image tag</dt><dd className="mono">{env.image_tag ?? '—'}</dd>
          <dt>Default ref</dt><dd className="mono">{env.git_ref}</dd>
          <dt>Folder</dt><dd className="mono">{env.env_dir}</dd>
          <dt>Last deployment</dt>
          <dd>
            {last ? (
              <>
                <StatusChip map={DEPLOYMENT_STATUS} status={last.status} /> {MODE_LABEL[last.mode] ?? last.mode} ·{' '}
                <span className="mono">{when(last.finished_at ?? last.started_at)}</span>
                {last.actor_name && <> · {last.actor_name}</>}
              </>
            ) : 'None yet'}
          </dd>
        </dl>
      </section>
      <section className="sirdar-section">
        <h2>Services</h2>
        <DataTable
          ariaLabel="Services"
          columns={[{ key: 'service', label: 'Service' }, { key: 'url', label: 'Public URL' },
                    { key: 'addr', label: 'Address', mono: true }]}
          rows={env.services.map((s) => ({
            key: s.service,
            cells: [
              <b className="cell-top">{s.service}</b>,
              s.hostname
                ? <a href={`https://${s.hostname}`} target="_blank" rel="noreferrer">{`https://${s.hostname}`}</a>
                : <span className="cell-sub">LAN only</span>,
              s.service === 'mailpit'
                ? <a href={`http://${s.host_ip}:${s.port}`} target="_blank" rel="noreferrer">{`${s.host_ip}:${s.port}`}</a>
                : `${s.host_ip}:${s.port}`,
            ],
          }))}
        />
        <p className="page-hint">
          Public URLs answer once their DNS records and proxy hosts exist. Mailpit catches this environment's email on the LAN.
        </p>
      </section>
    </>
  );
}
```

Create `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`:

```tsx
/** /deploy/environments/:name — one environment, in tabs. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import { errorText, getDeployTargets, getEnvironment, type DeployTarget, type Environment } from '../../lib/sirdarApi';

import DeployModal from './DeployModal';
import EnvOverview from './EnvOverview';
import { ENV_STATUS, StatusChip, TYPE_LABEL, targetLabel } from './labels';

type Tab = 'overview';
const TABS: [Tab, string][] = [['overview', 'Overview']];

export default function EnvironmentDetail() {
  const { name = '' } = useParams();
  const { can } = useAuth();
  const [env, setEnv] = useState<Environment | null>(null);
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [deploying, setDeploying] = useState(false);

  const load = useCallback(() => getEnvironment(name)
    .then((e) => { setEnv(e); setError(''); })
    .catch((e) => setError(errorText(e, "Couldn't load this environment."))), [name]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    getDeployTargets().then((r) => setTargets(r.targets)).catch(() => { /* target ids stand in for labels */ });
  }, []);

  const started = () => { setDeploying(false); void load(); };

  const crumb = <div className="eyebrow"><Link to="/deploy">Deploy</Link></div>;
  if (!env) {
    return (
      <div className="portal-page">
        {crumb}
        {error ? <p className="form-error" role="alert">{error}</p> : <p className="page-hint">Loading…</p>}
      </div>
    );
  }
  const running = env.status === 'deploying';
  return (
    <div className="portal-page">
      {crumb}
      <div className="dir-head sirdar-env-head">
        <div>
          <div className="page-title"><h1>{env.name}</h1><StatusChip map={ENV_STATUS} status={env.status} /></div>
          <p>{`${TYPE_LABEL[env.type] ?? env.type} · ${targetLabel(targets, env.target)} · ${env.base_domain}`}</p>
        </div>
        {can('deploy', 'add') && (
          <button type="button" className="btn-solid" disabled={running}
                  title={running ? 'A deployment is running.' : undefined} onClick={() => setDeploying(true)}>
            Deploy
          </button>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="segmented sirdar-env-tabs" role="tablist" aria-label="Environment">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'overview' && <EnvOverview env={env} />}
      {deploying && <DeployModal env={env} onStarted={started} onClose={() => setDeploying(false)} />}
    </div>
  );
}
```

In `sirdar/web/src/App.tsx`, add the import after `import Deploy from './pages/Deploy';`:

```tsx
import EnvironmentDetail from './pages/environments/EnvironmentDetail';
```

and the route directly after the `/deploy` route:

```tsx
              <Route path="/deploy/environments/:name" element={<Gate resource="deploy"><EnvironmentDetail /></Gate>} />
```

In `sirdar/web/src/layout/SirdarTopbar.tsx`, replace

```tsx
  const title = PAGE_TITLES[pathname]
    ?? (pathname.startsWith('/admin/users/') ? 'User' : 'Sirdar');
```

with

```tsx
  const title = PAGE_TITLES[pathname]
    ?? (pathname.startsWith('/admin/users/') ? 'User'
      : pathname.startsWith('/deploy/environments/') ? 'Environment' : 'Sirdar');
```

Append to `sirdar/web/src/styles/sirdar.css`:

```css
.sirdar-env-head { align-items: flex-start; }
.sirdar-env-tabs { margin-bottom: 4px; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix sirdar/web test -- src/pages/environments/EnvironmentDetail.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check and run the web suite**

Run: `npm --prefix sirdar/web run build && npm --prefix sirdar/web test`
Expected: build succeeds; every test passes (the nav still highlights Deploy: `sectionForPath` matches `/deploy` by prefix).

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/environments/EnvironmentDetail.tsx sirdar/web/src/pages/environments/EnvOverview.tsx sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx sirdar/web/src/App.tsx sirdar/web/src/layout/SirdarTopbar.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): environment page with Overview and Deploy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Deployments tab — history, step list with live logs, Cancel, Retry from step

**Files:**
- Create: `sirdar/web/src/pages/environments/DeploymentView.tsx`, `DeploymentView.test.tsx`
- Create: `sirdar/web/src/pages/environments/DeploymentsTab.tsx`, `DeploymentsTab.test.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvironmentDetail.tsx` (whole file below), `EnvironmentDetail.test.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`

**Interfaces:**
- Consumes: `getDeployment`, `cancelDeployment`, `retryDeployment`, `listDeployments`, `errorText`, `deployErrorText` (Task 3); labels incl. `stoppedStep`, `RETRYABLE`, `duration` (Task 5); `useHostKeyTrust` (Task 6).
- Produces:
  - `export const POLL_MS = 2000;` and `DeploymentView({ id, env, isLatest, onFinished, onRetried, onClose }: { id: string; env: Environment; isLatest: boolean; onFinished: () => void; onRetried: (dep: Deployment) => void; onClose: () => void })` — fetches `getDeployment(id)` once, then every `POLL_MS` while `status === 'running'`; stops when it isn't (calls `onFinished` once if it had seen it running) and on unmount. Cancel (`deploy:change`, while running) and Retry (latest deployment only; update needs `deploy:add`, reset needs `deploy:change` + the typed name).
  - `DeploymentsTab({ env, selected, onSelect, onChanged }: { env: Environment; selected: string | null; onSelect: (id: string | null) => void; onChanged: () => void })` — DataTable `aria-label="Deployments"`; renders `DeploymentView key={selected}` above it.
  - `EnvironmentDetail` gains the Deployments tab; `?deployment=<id>` opens it on that deployment; a started deployment opens there.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/environments/DeploymentView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({
  getDeployment: vi.fn(), cancelDeployment: vi.fn(), retryDeployment: vi.fn(), trustKnownHost: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DeploymentView, { POLL_MS } from './DeploymentView';
import { ENV, FAILED, RESET_FAILED, RUNNING, RUNNING_MORE, SUCCEEDED } from './testData';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  vi.useFakeTimers({ shouldAdvanceTime: true });
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function show(props: { id?: string; isLatest?: boolean } = {}) {
  const handlers = { onFinished: vi.fn(), onRetried: vi.fn(), onClose: vi.fn() };
  render(<DeploymentView id={props.id ?? 'd1'} env={ENV} isLatest={props.isLatest ?? true} {...handlers} />);
  return handlers;
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it('polls every 2 s while running, shows the live log, and stops when it finishes', async () => {
  api.getDeployment.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING_MORE).mockResolvedValue(SUCCEEDED);
  const { onFinished } = show();
  expect(await screen.findByText(/Cloning the repo/)).toBeTruthy();
  expect(screen.getByText('Fetch code').closest('button')!.getAttribute('aria-expanded')).toBe('true');
  expect(api.getDeployment).toHaveBeenCalledTimes(1);
  await tick(POLL_MS);
  expect(await screen.findByText(/Checked out f00dbabe/)).toBeTruthy();
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
  await tick(POLL_MS);
  await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  expect(screen.getByText('Succeeded')).toBeTruthy();
  expect(screen.getByText(SUCCEEDED.dump_path!)).toBeTruthy();
  await tick(POLL_MS * 5);
  expect(api.getDeployment).toHaveBeenCalledTimes(3);
  expect(api.getDeployment).toHaveBeenCalledWith('d1');
});

it('stops polling when it closes', async () => {
  api.getDeployment.mockResolvedValue(RUNNING);
  show();
  await screen.findByText(/Cloning the repo/);
  cleanup();
  await tick(POLL_MS * 3);
  expect(api.getDeployment).toHaveBeenCalledTimes(1);
});

it('a finished deployment is fetched once and never polled', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  const { onFinished } = show();
  expect(await screen.findByText(/docker build exited 1/)).toBeTruthy();   // the failed step opens
  expect(screen.getByText('Step 5 (Build images) failed. See its log.')).toBeTruthy();
  await tick(POLL_MS * 3);
  expect(api.getDeployment).toHaveBeenCalledTimes(1);
  expect(onFinished).not.toHaveBeenCalled();
});

it('clicking a step shows its log; clicking it again hides it', async () => {
  api.getDeployment.mockResolvedValue({ ...FAILED, steps: FAILED.steps.map((s) => (s.number === 1 ? { ...s, log_tail: 'preflight ok\n', log_size: 13 } : s)) });
  show();
  await screen.findByText(/docker build exited 1/);
  await user.click(screen.getByText('Preflight'));
  expect(screen.getByText(/preflight ok/)).toBeTruthy();
  expect(screen.queryByText(/docker build exited 1/)).toBeNull();
  await user.click(screen.getByText('Preflight'));
  expect(screen.queryByText(/preflight ok/)).toBeNull();
});

it('Cancel asks first, then cancels; it needs deploy:change', async () => {
  api.getDeployment.mockResolvedValue(RUNNING);
  api.cancelDeployment.mockResolvedValue({ id: 'd1', status: 'cancelling' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  show();
  await user.click(await screen.findByRole('button', { name: 'Cancel deployment' }));
  expect(api.cancelDeployment).toHaveBeenCalledWith('d1');
  expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeTruthy();
  cleanup();
  perms.change = false;
  show();
  await screen.findByText(/Cloning the repo/);
  expect(screen.queryByRole('button', { name: 'Cancel deployment' })).toBeNull();
});

it('a failed update retries from the step where it stopped', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd2', retry_of: 'd1', start_step: 5 });
  const { onRetried } = show();
  await user.click(await screen.findByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(onRetried).toHaveBeenCalledWith(expect.objectContaining({ id: 'd2' })));
  expect(api.retryDeployment).toHaveBeenCalledWith('d1', { from_step: 5 });
});

it('Retry from step offers the steps up to where it stopped', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd2' });
  show();
  await user.click(await screen.findByLabelText('Retry from step'));
  expect(await screen.findByText('3. Fetch code')).toBeTruthy();
  expect(screen.queryByText('6. Pre-deploy dump')).toBeNull();
  await user.click(screen.getByText('3. Fetch code'));
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d1', { from_step: 3 }));
});

it('retrying a Reset needs deploy:change and the typed name', async () => {
  api.getDeployment.mockResolvedValue(RESET_FAILED);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd4' });
  show({ id: 'd3' });
  const btn = (await screen.findByRole('button', { name: 'Retry' })) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await user.click(btn);
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d3', { from_step: 5, confirm_name: 'uat' }));
  cleanup();
  perms.change = false;
  show({ id: 'd3' });
  await screen.findByText(/docker build exited 1/);
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

it('only the latest deployment offers Retry, and retry errors show', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  show({ isLatest: false });
  expect(await screen.findByText('Only the most recent deployment can be retried.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  cleanup();
  api.retryDeployment.mockRejectedValue(new ApiError(409, 'retry_not_latest', { code: 'retry_not_latest' }));
  show();
  await user.click(await screen.findByRole('button', { name: 'Retry' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Only the most recent deployment can be retried.');
});
```

Create `sirdar/web/src/pages/environments/DeploymentsTab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./DeploymentView', () => ({
  default: ({ id, isLatest }: { id: string; isLatest: boolean }) => <div>view {id} {isLatest ? 'latest' : 'older'}</div>,
}));
const api = vi.hoisted(() => ({ listDeployments: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import DeploymentsTab from './DeploymentsTab';
import { ADOPTED, ENV, FAILED, summary } from './testData';

beforeEach(() => {
  api.listDeployments.mockReset();
  api.listDeployments.mockResolvedValue({ deployments: [summary(FAILED), ADOPTED] });
});
afterEach(cleanup);

it('lists the history newest first; Open selects one', async () => {
  const onSelect = vi.fn();
  render(<DeploymentsTab env={ENV} selected={null} onSelect={onSelect} onChanged={vi.fn()} />);
  const table = await screen.findByRole('table', { name: 'Deployments' });
  expect(api.listDeployments).toHaveBeenCalledWith('uat');
  expect(within(table).getByText('main · f00dbabe')).toBeTruthy();
  expect(within(table).getByText('Failed')).toBeTruthy();
  expect(within(table).getByText('Update')).toBeTruthy();
  expect(within(table).getByText('Adopt')).toBeTruthy();
  await userEvent.click(within(table).getAllByRole('button', { name: /^Open the deployment from/ })[0]);
  expect(onSelect).toHaveBeenCalledWith('d1');
});

it('shows the selected deployment, marked latest only when it is the newest', async () => {
  const props = { env: ENV, onSelect: vi.fn(), onChanged: vi.fn() };
  const { rerender } = render(<DeploymentsTab {...props} selected="d1" />);
  expect(await screen.findByText('view d1 latest')).toBeTruthy();
  rerender(<DeploymentsTab {...props} selected="d0" />);
  expect(await screen.findByText('view d0 older')).toBeTruthy();
});

it('shows the empty state', async () => {
  api.listDeployments.mockResolvedValue({ deployments: [] });
  render(<DeploymentsTab env={ENV} selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText('No deployments yet.')).toBeTruthy();
});
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`:

Add after the `vi.mock('../../lib/sirdarApi', …)` line:

```tsx
vi.mock('./DeploymentView', () => ({ default: ({ id }: { id: string }) => <div>deployment view {id}</div> }));
```

Add `listDeployments: vi.fn(),` to the hoisted `api` object, and in `beforeEach` add:

```tsx
  api.listDeployments.mockResolvedValue({ deployments: [summary(RUNNING), ADOPTED] });
```

Change the fixtures import to:

```tsx
import { ADOPTED, ENV, RUNNING, TARGETS, summary } from './testData';
```

Append:

```tsx
it('?deployment= opens the Deployments tab on that deployment', async () => {
  show('/deploy/environments/uat?deployment=d1');
  expect(await screen.findByText('deployment view d1')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Deployments' }).getAttribute('aria-selected')).toBe('true');
});

it('a started deployment opens on the Deployments tab', async () => {
  api.startDeployment.mockResolvedValue(RUNNING);
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Deploy uat' })).getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByText('deployment view d1')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Deployments' }).getAttribute('aria-selected')).toBe('true');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments`
Expected: FAIL — `./DeploymentView` and `./DeploymentsTab` cannot be resolved; the two new EnvironmentDetail tests find no Deployments tab.

- [ ] **Step 3: Implement the deployment view**

Create `sirdar/web/src/pages/environments/DeploymentView.tsx`:

```tsx
/** One deployment: its steps with live logs (polled while it runs), Cancel,
 *  and Retry from step. */
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import {
  cancelDeployment, deployErrorText, errorText, getDeployment, retryDeployment,
  type Deployment, type Environment,
} from '../../lib/sirdarApi';

import {
  DEPLOYMENT_STATUS, MODE_LABEL, RETRYABLE, STEP_STATUS, StatusChip, duration, shortSha, stoppedStep, when,
} from './labels';

export const POLL_MS = 2000;

export default function DeploymentView({ id, env, isLatest, onFinished, onRetried, onClose }: {
  id: string; env: Environment; isLatest: boolean;
  onFinished: () => void; onRetried: (dep: Deployment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [dep, setDep] = useState<Deployment | null>(null);
  const [loadError, setLoadError] = useState('');
  /** null = follow the running / stopped step; -1 = none open. */
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [fromStep, setFromStep] = useState('');
  const [confirm, setConfirm] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState('');
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sawRunning = false;
    const tick = async () => {
      try {
        const d = await getDeployment(id);
        if (!live) return;
        setDep(d);
        setLoadError('');
        if (d.status === 'running') { sawRunning = true; timer = setTimeout(tick, POLL_MS); }
        else if (sawRunning) finished.current();
      } catch (e) {
        if (!live) return;
        setLoadError(errorText(e, "Couldn't load this deployment."));
        if (sawRunning) timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [id]);

  const running = dep?.status === 'running';
  useEffect(() => { if (!running) setCancelling(false); }, [running]);
  const stopped = dep ? stoppedStep(dep.steps) : null;
  const followed = dep?.steps.find((s) => s.status === 'running')?.number ?? stopped;
  const shown = dep?.steps.find((s) => s.number === (openStep ?? followed)) ?? null;
  const log = shown?.log_tail ?? '';
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log]);

  const isReset = dep?.mode === 'reset';
  const allowed = dep?.mode === 'update' ? can('deploy', 'add') : dep?.mode === 'reset' ? can('deploy', 'change') : false;
  const mayRetry = !!dep && RETRYABLE.includes(dep.status) && allowed && stopped !== null;

  const retry = async () => {
    if (!dep || stopped === null || retrying) return;
    if (isReset && confirm !== env.name) { setActionError(`Type ${env.name} to confirm.`); return; }
    setRetrying(true);
    setActionError('');
    try {
      onRetried(await retryDeployment(id, {
        from_step: Number(fromStep || stopped), ...(isReset ? { confirm_name: confirm } : {}),
      }));
    } catch (e) {
      if (!hostKey.handle(e)) setActionError(deployErrorText(e, "Couldn't retry the deployment."));
      setRetrying(false);
    }
  };
  const hostKey = useHostKeyTrust({
    target: env.target, canTrust: can('deploy', 'change'), trustLabel: 'Trust and retry',
    onTrusted: () => { void retry(); }, onProblem: setActionError,
  });

  const cancel = async () => {
    if (!window.confirm('Cancel this deployment? The running step stops; finished steps stay as they are.')) return;
    setCancelling(true);
    setActionError('');
    try { await cancelDeployment(id); }
    catch (e) { setCancelling(false); setActionError(errorText(e, "Couldn't cancel the deployment.")); }
  };

  if (!dep) {
    return (
      <section className="sirdar-section sirdar-card sirdar-deployment">
        {loadError ? <p className="form-error" role="alert">{loadError}</p> : <p className="page-hint">Loading…</p>}
      </section>
    );
  }
  const retryOptions = dep.steps.filter((s) => stopped !== null && s.number <= stopped)
    .map((s) => ({ value: String(s.number), label: `${s.number}. ${s.name}` }));

  return (
    <section className="sirdar-section sirdar-card sirdar-deployment" aria-label="Deployment">
      <div className="sirdar-section-head">
        <h2>{MODE_LABEL[dep.mode] ?? dep.mode} · <span className="mono">{shortSha(dep.sha)}</span></h2>
        <div className="sirdar-target-actions">
          {running && can('deploy', 'change') && (
            <button type="button" className="btn-ghost" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? 'Cancelling…' : 'Cancel deployment'}
            </button>
          )}
          <button type="button" className="mini-btn" onClick={onClose}>Close</button>
        </div>
      </div>
      <dl className="sirdar-kv">
        <dt>Status</dt><dd><StatusChip map={DEPLOYMENT_STATUS} status={dep.status} /></dd>
        <dt>Ref</dt><dd className="mono">{dep.git_ref} → {dep.sha}</dd>
        <dt>Started</dt><dd className="mono">{when(dep.started_at)}{dep.actor_name ? ` · ${dep.actor_name}` : ''}</dd>
        <dt>Finished</dt><dd className="mono">{when(dep.finished_at)}</dd>
        {dep.retry_of && <><dt>Retry</dt><dd>From step {dep.start_step}</dd></>}
        {dep.dump_path && <><dt>Pre-deploy dump</dt><dd className="mono">{dep.dump_path}</dd></>}
      </dl>
      {dep.error && <p className="form-error">{dep.error}</p>}
      {loadError && <p className="form-error" role="alert">{loadError}</p>}

      <ol className="sirdar-steps">
        {dep.steps.map((s) => {
          const open = shown?.number === s.number;
          return (
            <li key={s.number}>
              <button type="button" className="sirdar-step-btn" aria-expanded={open}
                      onClick={() => setOpenStep(open ? -1 : s.number)}>
                <span className="mono">{s.number}</span>
                <b>{s.name}</b>
                <StatusChip map={STEP_STATUS} status={s.status} />
                <span className="mono">{duration(s.started_at, s.finished_at)}</span>
              </button>
              {open && (
                <>
                  <pre className="sirdar-log" ref={logRef} aria-label={`Step ${s.number} log`}>{s.log_tail || 'No output yet.'}</pre>
                  {s.log_size > s.log_tail.length && (
                    <p className="page-hint">
                      Showing the last {s.log_tail.length.toLocaleString()} of {s.log_size.toLocaleString()} characters.
                    </p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>

      {mayRetry && isLatest && (
        <div className="sirdar-retry pf-form">
          <div>
            <label className="field-label" htmlFor="retry-step">Retry from step</label>
            <ComboBox inputId="retry-step" ariaLabel="Retry from step" portal value={fromStep || String(stopped)}
                      options={retryOptions} onChange={setFromStep} />
          </div>
          {isReset && (
            <div>
              <label className="field-label" htmlFor="retry-confirm">Type {env.name} to confirm</label>
              <input id="retry-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          <button type="button" className="btn-solid" disabled={retrying || (isReset && confirm !== env.name)}
                  onClick={() => void retry()}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {mayRetry && !isLatest && <p className="page-hint">Only the most recent deployment can be retried.</p>}
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {hostKey.modal}
    </section>
  );
}
```

(`retry` is declared before `useHostKeyTrust` and refers to `hostKey` only when it runs, after the hook has returned; hooks stay unconditional because the early `return` for `!dep` comes after every hook.)

- [ ] **Step 4: Implement the tab and wire it into the page**

Create `sirdar/web/src/pages/environments/DeploymentsTab.tsx`:

```tsx
/** Deployments tab: the open deployment (if any) above the history. */
import { useCallback, useEffect, useState } from 'react';

import DataTable from '@portal/components/DataTable';

import { errorText, listDeployments, type DeploymentSummary, type Environment } from '../../lib/sirdarApi';

import DeploymentView from './DeploymentView';
import { DEPLOYMENT_STATUS, MODE_LABEL, StatusChip, shortSha, when } from './labels';

export default function DeploymentsTab({ env, selected, onSelect, onChanged }: {
  env: Environment; selected: string | null; onSelect: (id: string | null) => void; onChanged: () => void;
}) {
  const [rows, setRows] = useState<DeploymentSummary[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => listDeployments(env.name)
    .then((r) => { setRows(r.deployments); setError(''); })
    .catch((e) => setError(errorText(e, "Couldn't load the deployments."))), [env.name]);
  // A newly selected deployment (just started or retried) joins the list.
  useEffect(() => { void load(); }, [load, selected]);

  const latestId = rows?.[0]?.id ?? null;
  return (
    <>
      {selected && (
        <DeploymentView key={selected} id={selected} env={env} isLatest={selected === latestId}
                        onFinished={() => { void load(); onChanged(); }}
                        onRetried={(dep) => { onChanged(); onSelect(dep.id); }}
                        onClose={() => onSelect(null)} />
      )}
      <section className="sirdar-section">
        <h2>History</h2>
        {error && <p className="form-error" role="alert">{error}</p>}
        <DataTable
          ariaLabel="Deployments"
          columns={[
            { key: 'when', label: 'Started', mono: true }, { key: 'mode', label: 'Mode' },
            { key: 'ref', label: 'Ref · SHA', mono: true }, { key: 'status', label: 'Status' },
            { key: 'by', label: 'By' }, { key: 'act', label: '', align: 'right' },
          ]}
          rows={(rows ?? []).map((d) => ({
            key: d.id,
            cells: [
              when(d.started_at), MODE_LABEL[d.mode] ?? d.mode, `${d.git_ref} · ${shortSha(d.sha)}`,
              <StatusChip map={DEPLOYMENT_STATUS} status={d.status} />, d.actor_name ?? '—',
              d.id === selected
                ? <span className="cell-sub">Open</span>
                : <button type="button" className="mini-btn" aria-label={`Open the deployment from ${when(d.started_at)}`}
                          onClick={() => onSelect(d.id)}>Open</button>,
            ],
          }))}
          emptyText={rows === null ? 'Loading…' : 'No deployments yet.'}
        />
      </section>
    </>
  );
}
```

Replace `sirdar/web/src/pages/environments/EnvironmentDetail.tsx` with:

```tsx
/** /deploy/environments/:name — one environment, in tabs. `?deployment=<id>`
 *  opens the Deployments tab on that deployment (the Dashboard links here). */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import {
  errorText, getDeployTargets, getEnvironment, type DeployTarget, type Deployment, type Environment,
} from '../../lib/sirdarApi';

import DeploymentsTab from './DeploymentsTab';
import DeployModal from './DeployModal';
import EnvOverview from './EnvOverview';
import { ENV_STATUS, StatusChip, TYPE_LABEL, targetLabel } from './labels';

type Tab = 'overview' | 'deployments';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['deployments', 'Deployments']];

export default function EnvironmentDetail() {
  const { name = '' } = useParams();
  const [params] = useSearchParams();
  const { can } = useAuth();
  const [env, setEnv] = useState<Environment | null>(null);
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(params.get('deployment'));
  const [tab, setTab] = useState<Tab>(params.get('deployment') ? 'deployments' : 'overview');
  const [deploying, setDeploying] = useState(false);

  const load = useCallback(() => getEnvironment(name)
    .then((e) => { setEnv(e); setError(''); })
    .catch((e) => setError(errorText(e, "Couldn't load this environment."))), [name]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    getDeployTargets().then((r) => setTargets(r.targets)).catch(() => { /* target ids stand in for labels */ });
  }, []);

  const started = (dep: Deployment) => {
    setDeploying(false);
    setSelected(dep.id);
    setTab('deployments');
    void load();
  };

  const crumb = <div className="eyebrow"><Link to="/deploy">Deploy</Link></div>;
  if (!env) {
    return (
      <div className="portal-page">
        {crumb}
        {error ? <p className="form-error" role="alert">{error}</p> : <p className="page-hint">Loading…</p>}
      </div>
    );
  }
  const running = env.status === 'deploying';
  return (
    <div className="portal-page">
      {crumb}
      <div className="dir-head sirdar-env-head">
        <div>
          <div className="page-title"><h1>{env.name}</h1><StatusChip map={ENV_STATUS} status={env.status} /></div>
          <p>{`${TYPE_LABEL[env.type] ?? env.type} · ${targetLabel(targets, env.target)} · ${env.base_domain}`}</p>
        </div>
        {can('deploy', 'add') && (
          <button type="button" className="btn-solid" disabled={running}
                  title={running ? 'A deployment is running.' : undefined} onClick={() => setDeploying(true)}>
            Deploy
          </button>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="segmented sirdar-env-tabs" role="tablist" aria-label="Environment">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'overview' && <EnvOverview env={env} />}
      {tab === 'deployments' && (
        <DeploymentsTab env={env} selected={selected} onSelect={setSelected} onChanged={() => void load()} />
      )}
      {deploying && <DeployModal env={env} onStarted={started} onClose={() => setDeploying(false)} />}
    </div>
  );
}
```

Append to `sirdar/web/src/styles/sirdar.css`:

```css
.sirdar-deployment { margin-top: 16px; }
.sirdar-steps { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sirdar-step-btn {
  display: grid; grid-template-columns: 28px minmax(0, 1fr) auto 72px; align-items: center; gap: 10px;
  width: 100%; padding: 8px 12px; border: 1px solid var(--paper-line, #e5e7eb); border-radius: 8px;
  background: var(--surface, #fff); color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.sirdar-step-btn[aria-expanded="true"] { border-color: var(--sirdar-accent); }
.sirdar-step-btn > span:last-child { text-align: right; }
.sirdar-log {
  margin: 6px 0 4px; max-height: 420px; overflow: auto; padding: 12px 14px; border-radius: 8px;
  border: 1px solid var(--paper-line, #e5e7eb); background: var(--surface-2, #f5f7fa); color: var(--text-dark);
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
}
.sirdar-retry { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; margin-top: 16px; }
.sirdar-retry > div { min-width: 240px; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/environments`
Expected: PASS — DeploymentView (9), DeploymentsTab (3), EnvironmentDetail (6) and the earlier files.

- [ ] **Step 6: Type-check and run the web suite**

Run: `npm --prefix sirdar/web run build && npm --prefix sirdar/web test`
Expected: build succeeds; every test passes.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/pages/environments sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): Deployments tab — history, live step logs, cancel and retry from step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Settings tab

**Files:**
- Create: `sirdar/web/src/pages/environments/EnvSettings.tsx`, `EnvSettings.test.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvironmentDetail.tsx` (tab list, render), `EnvironmentDetail.test.tsx`

**Interfaces:**
- Consumes: `updateEnvironment`, `getEnvironmentDefaults`, `errorDetail`, `deployErrorText` (Task 3); `SecretField` (Task 4); `envRules`, `labels` (Task 5).
- Produces: `EnvSettings({ env, targets, onSaved }: { env: Environment; targets: DeployTarget[]; onSaved: (env: Environment) => void })`. PATCHes only the changed fields; secrets are write-only (`SecretField`); `deploy:change` edits, everyone else sees disabled fields and no Save; Save is disabled while `env.status === 'deploying'`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/environments/EnvSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ updateEnvironment: vi.fn(), getEnvironmentDefaults: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import EnvSettings from './EnvSettings';
import { DEFAULTS, ENV, TARGETS } from './testData';

Element.prototype.scrollIntoView = () => {};
beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getEnvironmentDefaults.mockResolvedValue(DEFAULTS);
  api.updateEnvironment.mockImplementation(async (_name: string, patch: object) => ({ ...ENV, ...patch }));
});
afterEach(cleanup);

function open(env = ENV) {
  const onSaved = vi.fn();
  render(<EnvSettings env={env} targets={TARGETS.targets} onSaved={onSaved} />);
  return { onSaved };
}
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
const secret = (text: string) => screen.getByText(text).closest('.sirdar-secret') as HTMLElement;

it('saves only what changed, a replaced secret included', async () => {
  const { onSaved } = open();
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).value).toBe('10.10.48.6');
  await userEvent.clear(screen.getByLabelText('Proxy IP'));
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.7');
  await userEvent.clear(screen.getByLabelText('api port'));
  await userEvent.type(screen.getByLabelText('api port'), '8100');
  await userEvent.click(within(secret('Anthropic API key: set')).getByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('Anthropic API key'), 'sk-new-1');
  await save();
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat', {
    proxy_ip: '10.10.48.7', services: { api: { port: 8100 } }, secrets: { SS_ANTHROPIC_API_KEY: 'sk-new-1' },
  });
  expect(screen.getByText('Saved. The next deploy applies these settings.')).toBeTruthy();
});

it('Clear sends an empty secret; nothing changed saves nothing', async () => {
  open();
  await save();
  expect(screen.getByText('Nothing to save.')).toBeTruthy();
  expect(api.updateEnvironment).not.toHaveBeenCalled();
  await userEvent.click(within(secret('Anthropic API key: set')).getByRole('button', { name: 'Clear' }));
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { secrets: { SS_ANTHROPIC_API_KEY: '' } }));
});

it('checks the fields before saving', async () => {
  open();
  await userEvent.clear(screen.getByLabelText('Bind IP'));
  await userEvent.type(screen.getByLabelText('Bind IP'), '1.2.3');
  await userEvent.clear(screen.getByLabelText('Dumps to keep'));
  await userEvent.type(screen.getByLabelText('Dumps to keep'), '0');
  await userEvent.click(within(secret('Database testing password: not set')).getByRole('button', { name: 'Add' }));
  await userEvent.type(screen.getByLabelText('Database testing password'), 'has space');
  await save();
  expect(screen.getByText('The bind IP must be an IPv4 address.')).toBeTruthy();
  expect(screen.getByText('Keep 1 to 100 dumps.')).toBeTruthy();
  expect(screen.getByText(/no spaces or quotes/)).toBeTruthy();
  expect(api.updateEnvironment).not.toHaveBeenCalled();
});

it('API errors show next to their field or under the form', async () => {
  api.updateEnvironment.mockRejectedValueOnce(new ApiError(422, 'secret_invalid', { code: 'secret_invalid', key: 'SS_ANTHROPIC_API_KEY' }));
  open();
  await userEvent.click(within(secret('Anthropic API key: set')).getByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('Anthropic API key'), 'abc');
  await save();
  expect(await within(secret('Anthropic API key')).findByText(/can't be saved/)).toBeTruthy();
  api.updateEnvironment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  await save();
  expect(await screen.findByText('A deployment of this environment is already running.')).toBeTruthy();
});

it('a view-only reader sees disabled fields and no Save', () => {
  perms.change = false;
  open();
  expect(screen.getByText('You can view these settings but not change them.')).toBeTruthy();
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('api port') as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
});

it("settings can't be saved while a deployment runs", () => {
  open({ ...ENV, status: 'deploying' });
  expect(screen.getByText("Settings can't change while a deployment is running.")).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);
});
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, add `updateEnvironment: vi.fn(), getEnvironmentDefaults: vi.fn(),` to the hoisted `api` object; in `beforeEach` add:

```tsx
  api.getEnvironmentDefaults.mockResolvedValue(DEFAULTS);
```

change the fixtures import to `import { ADOPTED, DEFAULTS, ENV, RUNNING, TARGETS, summary } from './testData';`, add `Element.prototype.scrollIntoView = () => {};` under the imports, and append:

```tsx
it('the Settings tab edits the environment and updates the page', async () => {
  api.updateEnvironment.mockResolvedValue({ ...ENV, base_domain: 'uat2.serversherpa.com' });
  show();
  await userEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
  await userEvent.clear(screen.getByLabelText('Base domain'));
  await userEvent.type(screen.getByLabelText('Base domain'), 'uat2.serversherpa.com');
  await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(await screen.findByText('Dev · Lab box · uat2.serversherpa.com')).toBeTruthy();
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { base_domain: 'uat2.serversherpa.com' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/EnvSettings.test.tsx src/pages/environments/EnvironmentDetail.test.tsx`
Expected: FAIL — `./EnvSettings` cannot be resolved; no Settings tab.

- [ ] **Step 3: Implement**

Create `sirdar/web/src/pages/environments/EnvSettings.tsx`:

```tsx
/** Settings tab: edit the environment record. Changes reach the target on
 *  the next deploy. Optional secrets are write-only. */
import { useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';

import SecretField, { type SecretAction } from '../../components/SecretField';
import { ipv4Problem, portProblem, refProblem } from '../../lib/envRules';
import {
  deployErrorText, errorDetail, getEnvironmentDefaults, updateEnvironment,
  type DeployTarget, type Environment, type EnvironmentPatch,
} from '../../lib/sirdarApi';

import { sshTargets, targetLabel } from './labels';

const SECRET_LABELS: Record<string, string> = {
  SS_ANTHROPIC_API_KEY: 'Anthropic API key', SS_DB_TESTING_PASSWORD: 'Database testing password',
};
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SECRET_RE = /^[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}$/;
/** API error code → field key. Secret errors use `secret:<KEY>` from the error's `key`. */
const CODE_FIELD: Record<string, string> = {
  ref_invalid: 'ref', target_invalid: 'target', target_not_configured: 'target', base_domain_invalid: 'domain',
  proxy_ip_invalid: 'proxy', bind_ip_invalid: 'bind', keep_dumps_invalid: 'keep', bucket_invalid: 'bucket',
  log_level_invalid: 'level', port_invalid: 'services', host_ip_invalid: 'services', ports_conflict: 'services',
  service_unknown: 'services',
};

type Svc = { host_ip: string; port: string };
function fromEnv(env: Environment) {
  return {
    ref: env.git_ref, target: env.target, domain: env.base_domain, proxy: env.proxy_ip, bind: env.bind_ip,
    keep: String(env.keep_dumps), bucket: env.spaces_bucket, level: env.log_level,
    services: Object.fromEntries(env.services.map((s) => [s.service, { host_ip: s.host_ip, port: String(s.port) }])) as Record<string, Svc>,
  };
}
type Form = ReturnType<typeof fromEnv>;

function TextField({ id, label, value, error, hint, disabled, onChange }: {
  id: string; label: string; value: string; error?: string; hint?: string; disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type="text" value={value} autoComplete="off" spellCheck={false} disabled={disabled}
             aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint">{hint}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function EnvSettings({ env, targets, onSaved }: {
  env: Environment; targets: DeployTarget[]; onSaved: (env: Environment) => void;
}) {
  const { can } = useAuth();
  const locked = !can('deploy', 'change');
  const deploying = env.status === 'deploying';
  const [form, setForm] = useState<Form>(() => fromEnv(env));
  const [secretAction, setSecretAction] = useState<Record<string, SecretAction>>({});
  const [secretValue, setSecretValue] = useState<Record<string, string>>({});
  const [levels, setLevels] = useState<string[]>([env.log_level]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  // A saved (or reloaded) environment resets the form.
  const stamp = `${env.name}|${env.updated_at}`;
  useEffect(() => { setForm(fromEnv(env)); setSecretAction({}); setSecretValue({}); }, [stamp]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    getEnvironmentDefaults().then((d) => setLevels(d.log_levels)).catch(() => { /* only the current level is offered */ });
  }, []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => { setForm((f) => ({ ...f, [key]: value })); setNotice(''); };
  const setSvc = (service: string, key: keyof Svc, value: string) => {
    setForm((f) => ({ ...f, services: { ...f.services, [service]: { ...f.services[service], [key]: value } } }));
    setNotice('');
  };
  const secretKeys = Object.keys(env.secrets_set);
  const ssh = sshTargets(targets).map((t) => ({ value: t.id, label: t.label }));
  const targetOptions = ssh.some((o) => o.value === form.target)
    ? ssh : [{ value: form.target, label: targetLabel(targets, form.target) }, ...ssh];

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    const put = (key: string, message: string) => { if (message) e[key] = message; };
    put('ref', refProblem(form.ref));
    put('domain', form.domain.trim() ? '' : 'Enter a base domain.');
    put('proxy', ipv4Problem(form.proxy, 'proxy IP'));
    put('bind', ipv4Problem(form.bind, 'bind IP'));
    const keep = Number(form.keep);
    put('keep', /^\d+$/.test(form.keep.trim()) && keep >= 1 && keep <= 100 ? '' : 'Keep 1 to 100 dumps.');
    put('bucket', BUCKET_RE.test(form.bucket.trim()) ? ''
      : "That bucket name isn't valid (3–63 lowercase letters, numbers, dots and hyphens).");
    for (const s of env.services) {
      const v = form.services[s.service];
      const problem = ipv4Problem(v.host_ip, `${s.service} address`) || (portProblem(v.port) && `${s.service}: ${portProblem(v.port)}`);
      if (problem) { e.services = problem; break; }
    }
    if (!e.services) {
      const used = env.services.map((s) => Number(form.services[s.service].port));
      if (new Set(used).size !== used.length) e.services = "Two services can't use the same port.";
    }
    for (const key of secretKeys) {
      if (secretAction[key] !== 'set') continue;
      const v = secretValue[key] ?? '';
      put(`secret:${key}`, !v ? 'Enter a value, or choose Keep.'
        : SECRET_RE.test(v) ? '' : 'Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes.');
    }
    return e;
  };

  const patchOf = (): EnvironmentPatch => {
    const t = (s: string) => s.trim();
    const patch: EnvironmentPatch = {};
    if (t(form.ref) !== env.git_ref) patch.git_ref = t(form.ref);
    if (form.target !== env.target) patch.target = form.target;
    if (t(form.domain) !== env.base_domain) patch.base_domain = t(form.domain);
    if (t(form.proxy) !== env.proxy_ip) patch.proxy_ip = t(form.proxy);
    if (t(form.bind) !== env.bind_ip) patch.bind_ip = t(form.bind);
    if (Number(form.keep) !== env.keep_dumps) patch.keep_dumps = Number(form.keep);
    if (t(form.bucket) !== env.spaces_bucket) patch.spaces_bucket = t(form.bucket);
    if (form.level !== env.log_level) patch.log_level = form.level;
    const services: NonNullable<EnvironmentPatch['services']> = {};
    for (const s of env.services) {
      const v = form.services[s.service];
      const change: { port?: number; host_ip?: string } = {};
      if (Number(v.port) !== s.port) change.port = Number(v.port);
      if (t(v.host_ip) !== s.host_ip) change.host_ip = t(v.host_ip);
      if (Object.keys(change).length) services[s.service] = change;
    }
    if (Object.keys(services).length) patch.services = services;
    const secrets: Record<string, string> = {};
    for (const key of secretKeys) {
      if (secretAction[key] === 'set') secrets[key] = secretValue[key] ?? '';
      else if (secretAction[key] === 'clear') secrets[key] = '';
    }
    if (Object.keys(secrets).length) patch.secrets = secrets;
    return patch;
  };

  const save = async () => {
    if (saving) return;
    const e = validate();
    setErrors(e);
    setNotice('');
    if (Object.keys(e).length) return;
    const patch = patchOf();
    if (Object.keys(patch).length === 0) { setNotice('Nothing to save.'); return; }
    setSaving(true);
    try {
      onSaved(await updateEnvironment(env.name, patch));
      setNotice('Saved. The next deploy applies these settings.');
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const key = errorDetail<{ key?: string }>(err)?.key;
      const field = code.startsWith('secret_') && key ? `secret:${key}` : CODE_FIELD[code] ?? 'form';
      setErrors({ [field]: deployErrorText(err, "Couldn't save the settings.") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="sirdar-section">
      {locked && <p className="page-hint">You can view these settings but not change them.</p>}
      {!locked && deploying && <p className="page-hint">Settings can't change while a deployment is running.</p>}
      <div className="pf-form sirdar-env-grid">
        <TextField id="env-set-ref" label="Default git ref" value={form.ref} error={errors.ref} disabled={locked}
                   onChange={(v) => set('ref', v)} />
        <div>
          <label className="field-label" htmlFor="env-set-target">Target</label>
          <ComboBox inputId="env-set-target" ariaLabel="Target" portal value={form.target} options={targetOptions}
                    disabled={locked} onChange={(v) => set('target', v)} />
          {errors.target && <p className="form-error" role="alert">{errors.target}</p>}
        </div>
        <TextField id="env-set-domain" label="Base domain" value={form.domain} error={errors.domain} disabled={locked}
                   hint={'Each service is named <service>.<base domain>.'} onChange={(v) => set('domain', v)} />
        <TextField id="env-set-proxy" label="Proxy IP" value={form.proxy} error={errors.proxy} disabled={locked}
                   onChange={(v) => set('proxy', v)} />
        <TextField id="env-set-bind" label="Bind IP" value={form.bind} error={errors.bind} disabled={locked}
                   onChange={(v) => set('bind', v)} />
        <TextField id="env-set-keep" label="Dumps to keep" value={form.keep} error={errors.keep} disabled={locked}
                   hint="Pre-deploy database dumps kept on the target." onChange={(v) => set('keep', v)} />
        <TextField id="env-set-bucket" label="Spaces bucket" value={form.bucket} error={errors.bucket} disabled={locked}
                   onChange={(v) => set('bucket', v)} />
        <div>
          <label className="field-label" htmlFor="env-set-level">Log level</label>
          <ComboBox inputId="env-set-level" ariaLabel="Log level" portal value={form.level} disabled={locked}
                    options={levels.map((l) => ({ value: l, label: l }))} onChange={(v) => set('level', v)} />
          {errors.level && <p className="form-error" role="alert">{errors.level}</p>}
        </div>
      </div>

      <h3 className="sirdar-sub">Services</h3>
      <DataTable
        ariaLabel="Service addresses"
        columns={[{ key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
                  { key: 'addr', label: 'Address', width: '200px' }, { key: 'port', label: 'Port', width: '120px' }]}
        rows={env.services.map((s) => ({
          key: s.service,
          cells: [
            <b className="cell-top">{s.service}</b>,
            s.hostname ?? '—',
            <input type="text" aria-label={`${s.service} address`} value={form.services[s.service]?.host_ip ?? ''}
                   disabled={locked} onChange={(e) => setSvc(s.service, 'host_ip', e.target.value)} />,
            <input className="sirdar-port-input" type="text" inputMode="numeric" aria-label={`${s.service} port`}
                   value={form.services[s.service]?.port ?? ''} disabled={locked}
                   onChange={(e) => setSvc(s.service, 'port', e.target.value)} />,
          ],
        }))}
      />
      {errors.services && <p className="form-error" role="alert">{errors.services}</p>}

      <h3 className="sirdar-sub">Secrets</h3>
      <p className="page-hint">Write-only. Sirdar generated the others and never shows them.</p>
      <div className="pf-form">
        {secretKeys.map((key) => (
          <SecretField key={key} id={`env-secret-${key}`} label={SECRET_LABELS[key] ?? key}
                       isSet={env.secrets_set[key]} adding={false} action={secretAction[key] ?? 'keep'}
                       value={secretValue[key] ?? ''} error={errors[`secret:${key}`]} disabled={locked}
                       onAction={(a) => { setSecretAction((m) => ({ ...m, [key]: a })); setNotice(''); }}
                       onValue={(v) => setSecretValue((m) => ({ ...m, [key]: v }))} />
        ))}
      </div>

      {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
      {notice && <p className="page-hint" role="status">{notice}</p>}
      {!locked && (
        <div className="sirdar-actions">
          <button type="button" className="btn-solid" disabled={saving || deploying} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </section>
  );
}
```

(The `eslint-disable-line` comment documents intent; Sirdar has no ESLint run, and `tsc` ignores it.)

In `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`:

Add the import after `import EnvOverview from './EnvOverview';`:

```tsx
import EnvSettings from './EnvSettings';
```

Replace the tab definitions with:

```tsx
type Tab = 'overview' | 'deployments' | 'settings';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['deployments', 'Deployments'], ['settings', 'Settings']];
```

and after the `{tab === 'deployments' && (…)}` block add:

```tsx
      {tab === 'settings' && <EnvSettings env={env} targets={targets} onSaved={setEnv} />}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/environments`
Expected: PASS — EnvSettings (6), EnvironmentDetail (7) and the rest.

- [ ] **Step 5: Type-check and run the web suite**

Run: `npm --prefix sirdar/web run build && npm --prefix sirdar/web test`
Expected: build succeeds; every test passes.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/environments
git commit -m "feat(sirdar-web): environment Settings tab with write-only optional secrets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Dashboard — real environment cards and their Deploy action

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts` (`DashEnvironment`)
- Modify: `sirdar/web/src/pages/dashboard/parts.tsx`, `EnvCard.tsx`, `DashboardPage.tsx` (whole files below), `testData.ts`, `dashboard.css`
- Test: `sirdar/web/src/pages/dashboard/DashboardPage.test.tsx` (whole file below)

**Interfaces:**
- Consumes: `GET /api/dashboard` card shape from Task 2; `getEnvironment` (Task 3); `DeployModal` (Task 7); the `?deployment=` link (Task 9).
- Produces: `DashEnvironment = { id; label; sub: string | null; state: 'active' | 'deploying' | 'failed' | 'empty' | string; version; last_release; last_release_at: string | null; action_label; environment: string | null }`; `SOON = 'Coming later'`; `SoonButton({ className?, title?, children })`; `EnvCard({ env, demo, canDeploy, onDeploy, onSetUp })`.

- [ ] **Step 1: Write the failing test**

Replace `sirdar/web/src/pages/dashboard/DashboardPage.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ deploy: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a?: string) => r !== 'deploy' || a === 'view' || perms.deploy,
    preferences: { motion: false },
  }),
}));
const api = vi.hoisted(() => ({ getDashboard: vi.fn(), getEnvironment: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { ENV, RUNNING } from '../environments/testData';

import DashboardPage from './DashboardPage';
import { DEMO, EMPTY, REAL } from './testData';

let loc = '';
let path = '';
function Where() { const l = useLocation(); loc = l.search; path = l.pathname; return null; }

function show(at = '/') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <DashboardPage />
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  perms.deploy = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDashboard.mockImplementation(async (o: { demo?: boolean }) => (o?.demo ? DEMO : EMPTY));
});
afterEach(cleanup);

it('renders the header and the health pill from the data', async () => {
  show();
  expect(screen.getByRole('heading', { level: 1, name: 'Deployments' })).toBeTruthy();
  expect(screen.getByText('Independent environments. Blue/Green routing for production.')).toBeTruthy();
  const pill = await screen.findByText('No environments deployed');
  expect(pill.closest('.sd-health')!.className).toMatch(/is-unknown/);
  const deploy = screen.getByRole('button', { name: /Deploy release/ });
  expect(deploy.getAttribute('aria-disabled')).toBe('true');
  expect(deploy.getAttribute('title')).toBe('Coming later');
  expect(api.getDashboard).toHaveBeenCalledWith({ demo: false, refresh: false });
});

it('shows a loading skeleton, then content', async () => {
  let resolve!: (v: unknown) => void;
  api.getDashboard.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const { container } = show();
  expect(container.querySelector('.sd-skeleton')).toBeTruthy();
  resolve(EMPTY);
  await screen.findByText('No environments deployed');
  expect(container.querySelector('.sd-skeleton')).toBeNull();
});

it('production inactive: gray pill, empty slots, no Activate button', async () => {
  show();
  const prod = await screen.findByRole('region', { name: 'Production' });
  expect(within(prod).getByText('No active deployment').closest('.sd-pill')!.className).toMatch(/is-muted/);
  expect(within(prod).getAllByText('Not deployed')).toHaveLength(2);
  expect(within(prod).getByText('Not configured')).toBeTruthy();
  expect(within(prod).queryByRole('button', { name: /Activate/ })).toBeNull();
  expect(prod.querySelector('.sd-slot-tag')).toBeNull();
});

it('production active (demo): active and standby slots, Activate Green coming later', async () => {
  show('/?demo=1');
  const prod = await screen.findByRole('region', { name: 'Production' });
  expect(within(prod).getByText('Deployment active').closest('.sd-pill')!.className).toMatch(/is-ok/);
  const blue = within(prod).getByText('Production Blue').closest('.sd-slot') as HTMLElement;
  expect(blue.className).toMatch(/is-active/);
  expect(within(blue).getByText('Active')).toBeTruthy();
  expect(within(blue).getByText('v2.8.0')).toBeTruthy();
  expect(within(blue).getByText('Healthy')).toBeTruthy();
  expect(within(blue).getByText('3 / 3 instances')).toBeTruthy();
  expect(within(blue).getByText('100% traffic')).toBeTruthy();
  const green = within(prod).getByText('Production Green').closest('.sd-slot') as HTMLElement;
  expect(green.className).toMatch(/is-standby/);
  expect(within(green).getByText('0 / 3 instances')).toBeTruthy();
  const act = within(green).getByRole('button', { name: 'Activate Green' });
  expect(act.getAttribute('aria-disabled')).toBe('true');
  expect(act.getAttribute('title')).toBe('Coming later');
  expect(within(prod).getByText('Blue active')).toBeTruthy();
});

it('cards with no environment yet offer Set up, which opens the Deploy page', async () => {
  show();
  const dev = await screen.findByRole('region', { name: 'Development' });
  expect(within(dev).getByText('No active deployment')).toBeTruthy();
  expect(within(dev).getByText('No releases yet')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Qa East' })).toBeTruthy();
  await userEvent.click(within(dev).getByRole('button', { name: 'Set up Dev' }));
  expect(path).toBe('/deploy');
});

it('environment cards show the type, version, state and last release', async () => {
  api.getDashboard.mockResolvedValue(REAL);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).getByRole('link', { name: 'uat' }).getAttribute('href')).toBe('/deploy/environments/uat');
  expect(within(uat).getByText('Development')).toBeTruthy();
  expect(within(uat).getByText('e73b99ca')).toBeTruthy();
  expect(within(uat).getByText('Running')).toBeTruthy();
  expect(within(uat).getByText(/^Last release: e73b99ca · /)).toBeTruthy();
  const qa = screen.getByRole('region', { name: 'qa-east' });
  expect(within(qa).getByText('Last deploy failed')).toBeTruthy();
  expect(within(qa).getByText('No releases yet')).toBeTruthy();
  expect(screen.getByText('A deployment failed').closest('.sd-health')!.className).toMatch(/is-degraded/);
});

it("an environment card's Deploy opens the Deploy modal and follows the new deployment", async () => {
  api.getDashboard.mockResolvedValue(REAL);
  api.getEnvironment.mockResolvedValue(ENV);
  api.startDeployment.mockResolvedValue(RUNNING);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  await userEvent.click(within(uat).getByRole('button', { name: 'Deploy uat' }));
  const dialog = await screen.findByRole('dialog', { name: 'Deploy uat' });
  expect(api.getEnvironment).toHaveBeenCalledWith('uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Deploy' }));
  await waitFor(() => expect(path).toBe('/deploy/environments/uat'));
  expect(loc).toBe('?deployment=d1');
});

it('a card whose environment is deploying has an inert Deploy', async () => {
  api.getDashboard.mockResolvedValue({ ...REAL, environments: [{ ...REAL.environments[0], state: 'deploying' }] });
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).getByText('Deploying')).toBeTruthy();
  const btn = within(uat).getByRole('button', { name: 'Deploy uat' });
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  expect(btn.getAttribute('title')).toBe('A deployment is running.');
});

it('demo cards are inert, and without deploy:add cards have no actions', async () => {
  show('/?demo=1');
  const dev = await screen.findByRole('region', { name: 'Development' });
  const btn = within(dev).getByRole('button', { name: 'Deploy to Dev' });
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  expect(btn.getAttribute('title')).toBe('Demo data');
  cleanup();
  perms.deploy = false;
  api.getDashboard.mockResolvedValue(REAL);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).queryByRole('button')).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Beta' })).queryByRole('button')).toBeNull();
});

it('the demo toggle sets ?demo=1, calls the API with demo and shows the strip', async () => {
  show();
  await screen.findByText('No environments deployed');
  expect(screen.queryByText(/Showing demo data/)).toBeNull();
  await userEvent.click(screen.getByLabelText('Demo data'));
  await screen.findByText('All systems healthy');
  expect(loc).toBe('?demo=1');
  expect(api.getDashboard).toHaveBeenLastCalledWith({ demo: true, refresh: false });
  expect(screen.getByText('Showing demo data — nothing here is real.')).toBeTruthy();
  await userEvent.click(screen.getByLabelText('Demo data'));
  await screen.findByText('No environments deployed');
  expect(loc).toBe('');
});

it('Refresh refetches with refresh=1', async () => {
  show('/?demo=1');
  await screen.findByText('All systems healthy');
  await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
  await waitFor(() => expect(api.getDashboard).toHaveBeenLastCalledWith({ demo: true, refresh: true }));
});

it('a failed load shows an alert with Retry', async () => {
  api.getDashboard.mockRejectedValueOnce(new ApiError(500, 'http_500', null));
  show();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/Couldn't load the dashboard/);
  await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await screen.findByText('No environments deployed');
  expect(screen.queryByRole('alert')).toBeNull();
});
```

In `sirdar/web/src/pages/dashboard/testData.ts`, replace the `DEMO.environments` array with:

```ts
  environments: [
    { id: 'dev', label: 'Development', sub: null, state: 'empty', version: null, last_release: 'v2.8.1-dev',
      last_release_at: null, action_label: 'Deploy to Dev', environment: null },
    { id: 'beta', label: 'Beta', sub: null, state: 'empty', version: null, last_release: 'v2.8.1-rc.2',
      last_release_at: null, action_label: 'Deploy to Beta', environment: null },
  ],
```

replace the `EMPTY.environments` array with:

```ts
  environments: [
    { id: 'dev', label: 'Development', sub: null, state: 'empty', version: null, last_release: null,
      last_release_at: null, action_label: 'Set up Dev', environment: null },
    { id: 'beta', label: 'Beta', sub: null, state: 'empty', version: null, last_release: null,
      last_release_at: null, action_label: 'Set up Beta', environment: null },
    { id: 'qa-east', label: 'Qa East', sub: null, state: 'empty', version: null, last_release: null,
      last_release_at: null, action_label: 'Set up Qa East', environment: null },
  ],
```

and append:

```ts
/** Real mode with Sirdar environments: uat (dev type, deployed), a Beta
 *  placeholder and a custom environment whose last deploy failed. */
export const REAL: DashboardData = {
  ...EMPTY,
  health: { status: 'degraded', label: 'A deployment failed' },
  environments: [
    { id: 'uat', label: 'uat', sub: 'Development', state: 'active', version: 'e73b99ca', last_release: 'e73b99ca',
      last_release_at: '2026-10-03T12:00:00+00:00', action_label: 'Deploy uat', environment: 'uat' },
    { id: 'beta', label: 'Beta', sub: null, state: 'empty', version: null, last_release: null,
      last_release_at: null, action_label: 'Set up Beta', environment: null },
    { id: 'qa-east', label: 'qa-east', sub: 'Custom', state: 'failed', version: null, last_release: null,
      last_release_at: null, action_label: 'Deploy qa-east', environment: 'qa-east' },
  ],
};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix sirdar/web test -- src/pages/dashboard`
Expected: FAIL — titles still "Coming in step 2", no "Set up Dev" action, no environment link or Deploy modal (and `tsc`-level type errors are reported by the build, not by vitest).

- [ ] **Step 3: Implement**

In `sirdar/web/src/lib/sirdarApi.ts`, replace the `DashEnvironment` interface with:

```ts
export interface DashEnvironment {
  /** The Sirdar environment's name, or "dev" / "beta" / a DigitalOcean env tag for a card with no environment. */
  id: string; label: string;
  /** The environment's type ("Development", "Beta", "Custom"); null on placeholder cards. */
  sub: string | null;
  state: 'active' | 'deploying' | 'failed' | 'empty' | string;
  version: string | null; last_release: string | null; last_release_at: string | null;
  action_label: string;
  /** The environment the card's action deploys; null means there's nothing to deploy yet. */
  environment: string | null;
}
```

Replace `sirdar/web/src/pages/dashboard/parts.tsx` with:

```tsx
/** Small shared pieces of the Deployments dashboard. */
import type { ReactNode } from 'react';

export const SOON = 'Coming later';

/** A button for an action that can't run (not built yet, demo data, or busy):
 *  focusable and titled (a native `disabled` button hides its tooltip), but inert. */
export function SoonButton({ className = '', title = SOON, children }: {
  className?: string; title?: string; children: ReactNode;
}) {
  return (
    <button type="button" className={`sd-btn ${className}`} aria-disabled="true" title={title}
            onClick={(e) => e.preventDefault()}>
      {children}
    </button>
  );
}

export type Tone = 'ok' | 'warn' | 'muted' | 'blue';

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`sd-dot is-${tone}`} aria-hidden="true" />;
}

const OK = new Set(['active', 'running', 'healthy', 'available']);
const WARN = new Set(['provisioning', 'degraded']);

export function statusTone(status: string): Tone {
  if (OK.has(status)) return 'ok';
  if (WARN.has(status)) return 'warn';
  return 'muted';
}

export function dotTone(dot: string | null | undefined): Tone | null {
  if (dot === 'green') return 'ok';
  if (dot === 'blue') return 'blue';
  if (dot === 'amber') return 'warn';
  if (dot === 'gray') return 'muted';
  return null;
}
```

Replace `sirdar/web/src/pages/dashboard/EnvCard.tsx` with:

```tsx
/** One non-production environment card: a Sirdar environment (Deploy opens
 *  the Deploy modal), or a Dev / Beta / tagged slot with no environment yet
 *  (Set up goes to the Deploy page). Demo cards are inert. */
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { DashEnvironment } from '../../lib/sirdarApi';

import { ServerRackIcon } from './icons';
import { Dot, SoonButton } from './parts';

function State({ env }: { env: DashEnvironment }) {
  const version = env.version && <b>{env.version}</b>;
  if (env.state === 'active') {
    return <div className="sd-env-state">{version}<span className="sd-pill is-ok"><Dot tone="ok" />Running</span></div>;
  }
  if (env.state === 'deploying') {
    return <div className="sd-env-state">{version}<span className="sd-pill is-muted"><Dot tone="blue" />Deploying</span></div>;
  }
  if (env.state === 'failed') {
    return <div className="sd-env-state">{version}<span className="sd-pill is-warn"><Dot tone="warn" />Last deploy failed</span></div>;
  }
  return <div className="sd-env-state sd-caps">No active deployment</div>;
}

export default function EnvCard({ env, demo, canDeploy, onDeploy, onSetUp }: {
  env: DashEnvironment; demo: boolean; canDeploy: boolean;
  onDeploy: (name: string) => void; onSetUp: () => void;
}) {
  const headingId = useId();
  const lit = env.state === 'active' || env.state === 'deploying';
  const name = env.environment;
  const released = env.last_release
    ? `Last release: ${env.last_release}${env.last_release_at ? ` · ${new Date(env.last_release_at).toLocaleDateString()}` : ''}`
    : 'No releases yet';

  let action: ReactNode = null;
  if (demo) action = <SoonButton className="sd-btn-outline sd-env-action" title="Demo data">{env.action_label}</SoonButton>;
  else if (canDeploy && name && env.state === 'deploying') {
    action = <SoonButton className="sd-btn-outline sd-env-action" title="A deployment is running.">{env.action_label}</SoonButton>;
  } else if (canDeploy && name) {
    action = <button type="button" className="sd-btn sd-btn-outline sd-env-action" onClick={() => onDeploy(name)}>{env.action_label}</button>;
  } else if (canDeploy) {
    action = <button type="button" className="sd-btn sd-btn-outline sd-env-action" onClick={onSetUp}>{env.action_label}</button>;
  }

  return (
    <section className="sd-card sd-env" aria-labelledby={headingId}>
      <h3 id={headingId}>
        {name && !demo ? <Link to={`/deploy/environments/${encodeURIComponent(name)}`}>{env.label}</Link> : env.label}
      </h3>
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
        {action && <div className="sd-vdivider" aria-hidden="true" />}
        {action}
      </div>
    </section>
  );
}
```

Replace `sirdar/web/src/pages/dashboard/DashboardPage.tsx` with:

```tsx
/** Sirdar Dashboard — the Deployments overview: health, production Blue/Green
 *  routing, the environments and the infrastructure tree. `?demo=1` swaps in
 *  the API's fixed sample. An environment card's Deploy opens the Deploy
 *  modal; production actions are still to come. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { Switch } from '@portal/components/Switch';

import { errorText, getDashboard, getEnvironment, type DashboardData, type Environment } from '../../lib/sirdarApi';
import DeployModal from '../environments/DeployModal';

import EnvCard from './EnvCard';
import { RocketIcon } from './icons';
import InfraTree from './InfraTree';
import { Dot, SoonButton } from './parts';
import ProductionFlow from './ProductionFlow';
import './dashboard.css';

function Skeleton() {
  return (
    <div className="sd-skeleton" aria-busy="true" aria-label="Loading the dashboard">
      <div className="sd-card"><div className="sd-shimmer" style={{ height: 24, width: 180 }} />
        <div className="sd-shimmer" style={{ height: 200, marginTop: 20 }} /></div>
      <div className="sd-env-grid">
        <div className="sd-card"><div className="sd-shimmer" style={{ height: 96 }} /></div>
        <div className="sd-card"><div className="sd-shimmer" style={{ height: 96 }} /></div>
      </div>
      <div className="sd-card"><div className="sd-shimmer" style={{ height: 220 }} /></div>
    </div>
  );
}

export default function DashboardPage() {
  const { preferences, can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const demo = params.get('demo') === '1';
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deployEnv, setDeployEnv] = useState<Environment | null>(null);
  const [deployError, setDeployError] = useState('');
  const seq = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await getDashboard({ demo, refresh });
      if (mine === seq.current) setData(d);
    } catch (e) {
      if (mine === seq.current) setError(errorText(e, "Couldn't load the dashboard."));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [demo]);

  // a demo switch shows the skeleton rather than the other mode's data
  useEffect(() => { setData(null); void load(false); }, [load]);

  const setDemo = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('demo', '1'); else next.delete('demo');
    setParams(next, { replace: true });
  };

  const openDeploy = async (name: string) => {
    setDeployError('');
    try { setDeployEnv(await getEnvironment(name)); }
    catch (e) { setDeployError(errorText(e, "Couldn't open that environment.")); }
  };

  const health = data?.health;
  const healthTone = health?.status === 'healthy' ? 'ok' : health?.status === 'degraded' ? 'warn' : 'muted';
  const motion = preferences?.motion !== false;

  return (
    <div className="portal-page sd-dash">
      <div className="sd-head">
        <div>
          <h1>Deployments</h1>
          <p className="sd-sub">Independent environments. Blue/Green routing for production.</p>
        </div>
        <div className="sd-head-actions">
          {health && (
            <span className={`sd-health is-${health.status === 'healthy' || health.status === 'degraded'
              ? health.status : 'unknown'}`}>
              <Dot tone={healthTone} />{health.label}
            </span>
          )}
          <SoonButton className="sd-btn-primary"><RocketIcon size={16} />Deploy release</SoonButton>
          <span className="sd-demo-toggle">
            <Switch checked={demo} onChange={setDemo} label="Demo data" />
            <span aria-hidden="true">Demo data</span>
          </span>
        </div>
      </div>

      {demo && <div className="sd-demo-strip">Showing demo data — nothing here is real.</div>}

      {error && (
        <div className="sd-alert" role="alert">
          <span>{error}</span>
          <button type="button" className="sd-btn sd-btn-outline sd-btn-sm" onClick={() => void load(false)}>
            Retry
          </button>
        </div>
      )}
      {deployError && <div className="sd-alert" role="alert"><span>{deployError}</span></div>}

      {!data && loading && <Skeleton />}

      {data && (
        <div className="sd-stack">
          <ProductionFlow production={data.production} motion={motion} />
          <div className="sd-env-grid">
            {data.environments.map((env) => (
              <EnvCard key={env.id} env={env} demo={data.demo} canDeploy={can('deploy', 'add')}
                       onDeploy={(name) => void openDeploy(name)} onSetUp={() => navigate('/deploy')} />
            ))}
          </div>
          <InfraTree source={data.infrastructure.source} error={data.infrastructure.error}
                     tree={data.infrastructure.tree} refreshing={loading}
                     onRefresh={() => void load(true)} />
        </div>
      )}

      {deployEnv && (
        <DeployModal env={deployEnv} onClose={() => setDeployEnv(null)}
                     onStarted={(dep) => navigate(`/deploy/environments/${encodeURIComponent(deployEnv.name)}?deployment=${dep.id}`)} />
      )}
    </div>
  );
}
```

Append to `sirdar/web/src/pages/dashboard/dashboard.css`:

```css
.sd-dash .sd-pill.is-warn { background: var(--sd-amber-soft); color: var(--sd-amber-text); border-color: color-mix(in srgb, var(--sd-amber) 45%, transparent); }
.sd-dash .sd-env h3 a { color: inherit; text-decoration: none; }
.sd-dash .sd-env h3 a:hover, .sd-dash .sd-env h3 a:focus-visible { text-decoration: underline; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/dashboard`
Expected: PASS — DashboardPage (12), ProductionFlow, InfraTree.

- [ ] **Step 5: Type-check and run both suites**

Run: `npm --prefix sirdar/web run build && npm --prefix sirdar/web test && (cd sirdar/api && .venv/bin/pytest -q)`
Expected: build succeeds; every web test and every API test passes.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/pages/dashboard
git commit -m "feat(sirdar-web): dashboard environment cards show real environments and open the Deploy modal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Live verify in the browser (controller, not a subagent)

The controller runs this task itself with the Browser pane tools. Nothing here touches the real uat VM (10.10.48.63): the target is a throwaway Ubuntu SSH container on this Mac. No commit unless a bug is found (fix it in a TDD step on the owning task's files, re-run both suites, commit as `fix(sirdar-web): …`).

**Files:**
- Temporarily modify: `/Users/jrh1812/Developer/BaseCampV3/.claude/launch.json` (main checkout; restore exactly afterwards)
- Write (gitignored dev file): `sirdar/.env` via `sirdar/scripts/dev-env.sh`

- [ ] **Step 1: Prepare the dev config and the dev database**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar
cp sirdar/.env sirdar/.env.before-2b-verify
sirdar/scripts/dev-env.sh
mkdir -p sirdar/runner sirdar/config && chmod 700 sirdar/runner sirdar/config
grep -c '^SIRDAR_SECRETS_KEY=' sirdar/.env
(cd sirdar/api && .venv/bin/alembic upgrade head)
which sshpass
```

Expected: `wrote sirdar/.env`; `1`; Alembic ends at revision `0004` (or reports nothing to do); `/opt/homebrew/bin/sshpass`. `dev-env.sh` keeps the existing `SIRDAR_JWT_SECRET` and `SIRDAR_SECRETS_KEY`; the backup lets you restore any temporary `SIRDAR_DEPLOY_SSH_*` lines the old file had. If the dev DB has no users, run `sirdar/api/.venv/bin/sirdar import-users`.

- [ ] **Step 2: Start a throwaway SSH target (Ubuntu 24.04 with git, like the e2e image)**

```bash
docker build -t sirdar-2b-target - <<'EOF'
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server python3 sudo git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd --create-home --shell /bin/bash deployer \
 && echo 'deployer:verify-2b-pw' | chpasswd \
 && echo 'deployer ALL=(ALL) ALL' > /etc/sudoers.d/deployer \
 && chmod 440 /etc/sudoers.d/deployer \
 && install -d -o deployer -m 755 /opt/serversherpa
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
EOF
docker run -d --rm --name sirdar-2b-target -p 127.0.0.1:2298:22 sirdar-2b-target
```

Then seed a hand-built environment to adopt (`adopt-me`), with one unknown key (`LEGACY_FLAG`) so ignored keys show:

```bash
docker exec -i -u deployer sirdar-2b-target python3 - <<'PY'
import base64, os, pathlib, secrets, subprocess
d = pathlib.Path("/opt/serversherpa/adopt-me")
(d / "repo").mkdir(parents=True, exist_ok=True)
h = lambda: secrets.token_hex(32)
values = {
    "STACK_ENV": "adopt-me", "STACK_DOMAIN": "adopt-me.serversherpa.com", "STACK_IMAGE_TAG": "0123abcd",
    "STACK_PROXY_IP": "10.10.48.6", "STACK_BIND_IP": "0.0.0.0", "STACK_KEEP_DUMPS": "5",
    "POSTGRES_PASSWORD": h(), "SPACES_SECRET_KEY": h(), "SS_JWT_SECRET": h(),
    "SS_TOTP_ENCRYPTION_KEY": base64.urlsafe_b64encode(os.urandom(32)).decode(),
    "SS_PASSWORD_PEPPER": h(), "SS_WIKI_SERVICE_TOKEN": h(),
    "SS_SPACES_BUCKET": "serversherpa", "SS_LOG_LEVEL": "INFO", "LEGACY_FLAG": "1",
}
(d / ".env").write_text("".join(f"{k}={v}\n" for k, v in values.items()))
os.chmod(d / ".env", 0o600)
subprocess.run(["git", "-C", str(d / "repo"), "init", "-q"], check=True)
subprocess.run(["git", "-C", str(d / "repo"), "-c", "user.email=verify@example.com", "-c", "user.name=verify",
                "commit", "-q", "--allow-empty", "-m", "init"], check=True)
PY
```

Expected: no output, exit 0.

- [ ] **Step 3: Add the temporary launch entries and start both servers**

`.claude/launch.json` is tracked in the main checkout and other sessions use it, so back it up rather than relying on `git checkout` later:

```bash
cp /Users/jrh1812/Developer/BaseCampV3/.claude/launch.json /Users/jrh1812/Developer/BaseCampV3/.claude/launch.json.2b-verify.bak
```

Then add two entries to its `configurations` array:

```json
{
  "name": "sirdar-api-wt",
  "runtimeExecutable": "/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api/.venv/bin/uvicorn",
  "runtimeArgs": ["--factory", "sirdar_api.api.app:create_app",
                  "--app-dir", "/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api/src",
                  "--host", "127.0.0.1", "--port", "8097"],
  "port": 8097
},
{
  "name": "sirdar-web-wt",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["--prefix", "/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/web", "run", "dev"],
  "port": 5178
}
```

Stop any running `sirdar-api` / `sirdar-web` previews first (same ports). Start `sirdar-api-wt`, then `sirdar-web-wt` with `preview_start`; check `preview_logs` for the API: no tracebacks, the startup sweep ran. Open `http://localhost:5178/login` and sign in as described in the Sirdar / basecampv3-dev-workflow memories (claude-dev + its TOTP; the login form needs `form_input` + `requestSubmit`). Never inject cookies.

- [ ] **Step 4: SSH target with a sudo password**

On `/deploy`: **+ Add SSH target** → Name `Verify box`, Host `127.0.0.1`, Port `2298`, User `deployer`, Password `verify-2b-pw` (a throwaway test value for this local container), Sudo password `verify-2b-pw` → Save. Then **Edit**:
- [ ] "Sudo password: set" shows with Replace / Clear; no password value appears anywhere in the DOM (`get_page_text` / `read_page`).
- [ ] Clear → "Sudo password: will be cleared" → Save → Edit again shows "Sudo password: not set". Add it back and save.
- [ ] Select the card, type Custom `verify`, **Test connection** → the host-key modal appears → **Trust and connect** → checks render; the host shows under Trusted SSH hosts.

- [ ] **Step 5: Create an environment (Create mode)**

**New environment**:
- [ ] The modal has the eyebrow "Deploy", title "New environment", description, and the Basics › Services › Review steps bar; it is wide (≈860 px) with a two-column field grid; the Target dropdown opens fully over the modal edge (not clipped).
- [ ] Name `verify-new`, Type Custom, Target `Verify box`, Proxy IP `10.10.48.6` → Next → Services table shows `api.verify-new.serversherpa.com` … with ports 8000/8091/8090/8096/9000/8095/8025 and mailpit "—"; set portal to 8000 → Next → "Two services can't use the same port."; set it back → Next → Review lists `/opt/serversherpa/verify-new`, the domain and "Generated by Sirdar and never shown" → **Create environment** → lands on `/deploy/environments/verify-new`, crumb "Environment", status chip "New", Overview "Not deployed yet".

- [ ] **Step 6: Adopt an environment**

Back on `/deploy` → **New environment** → **Adopt existing**:
- [ ] Steps bar shows Basics › Result; Base domain / Proxy IP / Bind IP fields are gone.
- [ ] Name `adopt-me`, Type Dev, Target `Verify box` → **Adopt** → Result lists the running commit (the container repo's HEAD), image tag `0123abcd`, Imported secrets = the six required names, Ignored keys = `LEGACY_FLAG` with the "next deploy writes the .env without them" hint → **Open environment** → status "Ready", last deployment "Adopted".
- [ ] The `/deploy` list now shows both rows with target "Verify box", type, `main · <sha>`, status and last deploy.

- [ ] **Step 7: Deploy with live logs, then Cancel and Retry**

On `verify-new` → **Deploy**:
- [ ] Modal header "Deploy verify-new", Git ref `main`, Update selected; switching to Reset data shows the warning and keeps the button disabled until `verify-new` is typed; switch back to Update → **Deploy**.
- [ ] The page switches to Deployments with the new deployment open; the running step's log streams in (new lines appear about every 2 s — confirm with `read_network_requests` filtered on `/deploy/deployments/`: one GET roughly every 2 s); the header Deploy button is disabled ("A deployment is running.").
- [ ] The container has no Docker daemon, so the run is expected to fail at preflight or a later step: when it ends, polling stops (no more GETs), the failed step's log opens, the error line shows, status chips read Failed / Not run, and the Overview/header status becomes "Failed".
- [ ] **Retry** offers "Retry from step" with steps up to the failed one only; retry from step 1 → a new deployment opens and runs. While step 1 or 2 runs, **Cancel deployment** → confirm → button reads "Cancelling…" → the deployment ends "Cancelled", the step "Cancelled", later steps "Not run".
- [ ] Retry the cancelled deployment → it starts from the cancelled step. Open an older deployment from History → it shows "Only the most recent deployment can be retried."

- [ ] **Step 8: Settings**

On `verify-new` → **Settings**:
- [ ] Change Dumps to keep to 3 and the api port to 8100 → **Save settings** → "Saved. The next deploy applies these settings."; Overview shows `127.0.0.1:8100` for api.
- [ ] Anthropic API key: **Add** → `sk-verify-1` → Save → "Anthropic API key: set"; no value appears in the DOM; Clear → Save → "not set".
- [ ] During a running deployment, Save is disabled with "Settings can't change while a deployment is running."

- [ ] **Step 9: Dashboard**

Open `/`:
- [ ] Cards: `adopt-me` (sub "Development", version `0123abcd`, Running, "Last release: <sha8> · <date>", links to its page), a "Beta" placeholder with **Set up Beta** (goes to `/deploy`), `verify-new` (sub "Custom", "Last deploy failed" or "Deploying").
- [ ] Health pill: "A deployment failed" while `verify-new` is failed.
- [ ] **Deploy adopt-me** opens the same Deploy modal; Cancel closes it (don't start one there unless you want another failing run; if you do, it navigates to `/deploy/environments/adopt-me?deployment=<id>` on the Deployments tab).
- [ ] "Deploy release" and "Activate …" read "Coming later"; the Demo data toggle still shows the demo with inert "Deploy to Dev" (title "Demo data").

- [ ] **Step 10: Permissions**

Sign in (in a separate private session, or after signing out) as an account with the `admin` role only (view-only on deploy):
- [ ] `/deploy` shows the Environments list with no **New environment**; the detail page has no Deploy button; Deployments shows no Cancel or Retry; Settings shows the view-only hint, disabled fields and no Save; Dashboard cards have no action buttons.

- [ ] **Step 11: Light and dark themes**

Switch the theme in My preferences (Theme: Dark), then revisit: the `/deploy` Environments table, the New environment modal (all steps), the Deploy modal, the environment page tabs, the step list and log panel (readable contrast, no white blocks), status chips, and the Dashboard cards (including the amber "Last deploy failed" pill). Switch back to Light and spot-check the same. Take screenshots of the log panel and the New environment modal in both themes.

- [ ] **Step 12: Clean up**

```bash
docker rm -f sirdar-2b-target
mv /Users/jrh1812/Developer/BaseCampV3/.claude/launch.json.2b-verify.bak /Users/jrh1812/Developer/BaseCampV3/.claude/launch.json
git -C /Users/jrh1812/Developer/BaseCampV3 status --short .claude/launch.json
```

Expected: the last command prints nothing (launch.json is back to its committed state). Stop the `sirdar-api-wt` / `sirdar-web-wt` previews. Remove the `Verify box` target on `/deploy` (Remove) and forget `127.0.0.1:2298` under Trusted SSH hosts. The `verify-new` and `adopt-me` rows stay in the dev database (harmless; there is no delete yet — phase 4). Keep the regenerated `sirdar/.env` (it now has `SIRDAR_SECRETS_KEY` and `SIRDAR_RUNNER_DIR`); copy back any extra lines you need from `sirdar/.env.before-2b-verify`, then delete that backup.

Report: what passed, anything that failed (with the fix commit), and the screenshots.
