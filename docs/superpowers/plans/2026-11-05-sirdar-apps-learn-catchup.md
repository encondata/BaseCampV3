# Sirdar: editable apps and mail, the learn app, and stack catch-up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `learn` a first-class optional app in Sirdar and the stack, let apps, mail and the kiosk signing digests be edited after create, hide portal links to apps that are off, pass `SS_KIOSK_SIGNING_DIGESTS` through the stack, seed starter content on empty first deploys, and guard against app-list drift.

**Architecture:** The main API learns which apps run from a new `SS_APPS` setting (fed by `STACK_APPS`) and reports them on `GET /system/status`; the portal hides nav items and the Help button from that. The stack passes `SS_APPS` and `SS_KIOSK_SIGNING_DIGESTS` to every API container, monitors learn on the status page, refuses learn without the wiki, and gets an `ss-stack seed` command. Sirdar gains `learn` in every app and service list (migration 0015 backfills rows and adds `environments.kiosk_signing_digests` and `deployments.seed_content`), validates apps, mail and digests on PATCH with the create rules, rebuilds hostnames, reissues a DigitalOcean certificate that covers names no longer wanted, and plans a new step 20 "Seed starter content". The Sirdar web shares the Extras step's app and mail controls with a new Settings › Apps & mail section.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (Sirdar API, main API), pydantic-settings, Ansible playbooks, bash (`ss-stack`), Docker Compose, React + TypeScript + vitest (portal, Sirdar web).

**Spec:** `docs/superpowers/specs/2026-11-05-sirdar-apps-learn-catchup-design.md`

---

## Global Constraints

- American English in all copy, comments and docs.
- Never use the `AVNS_` prefix in fake secrets.
- Sirdar API tests: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest …`. The full suite takes ~23 min; implementers run only covering files. Baseline before this plan (17 covering files, the list in Task 4 Step 9): **712 passed in 9:06**.
- Migration tests hard-code the head revision. Bump every `== "0014"` assert to "0015".
- Production is decided by `env.type == "production"`.
- Main BaseCamp API tests: `cd api && SS_TEST_DB=serversherpa_test_learn .venv/bin/python -m pytest …` (`SS_TEST_DB` must start with `serversherpa_test`, one per agent; see `api/tests/conftest.py`). Portal tests: `cd portal && npx vitest run <files>`. Deploy tests: `api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests/<files>` from the worktree root (deploy/tests/conftest.py puts this checkout's `api/src` first). Status app tests: `cd status && .venv/bin/pytest -q tests/<files>` (create the venv once with `python3.13 -m venv status/.venv && status/.venv/bin/pip install -e 'status[dev]'` if `status/.venv` is missing). Sirdar web tests: `cd sirdar/web && npx vitest run <files>`.
- ruff has ~1359 pre-existing findings; only new findings in touched files count (`sirdar/api/.venv/bin/ruff check <touched files>` / `api/.venv/bin/ruff check <touched files>`, compared against `git stash`-free `git show HEAD:<file>` if in doubt).
- Don't commit `api/src/serversherpa/_dev_reload.py`.
- Every commit message ends with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the `sirdar` worktree (`/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar`); all paths below are relative to it.

## Decisions this plan makes (the spec left them open)

- **Learn's place in the lists:** right after `wiki` everywhere (`SERVICES`, `PUBLIC_SERVICES`, `certs.PUBLIC_SERVICES`, `OPTIONAL_APPS`, `env.example`'s `STACK_LEARN_PORT`), so key order stays `…WIKI, LEARN, SPACES…`.
- **`SS_KIOSK_SIGNING_DIGESTS` in `.env`:** an uncommented, empty key in `env.example`'s Optional block (after `SS_SMTP_PASSWORD`). Sirdar renders it as a new `envfile.OPTIONAL_SETTINGS` key (always written, `""` when unset) whose value comes from `apps.env_extra`. It is not a secret and not an `EXTRA_KEYS` entry, so adopt reads it.
- **Migration 0015 learn ports:** Python in the migration. Environments without a learn row (and with a portal row) are handled in `created_at, name` order. Ports in use are the environment's own rows plus, only for an SSH target (`ssh` or `ssh:<slug>`), every row of another SSH environment on the same `host_ip` (the portal row's) whose bind address overlaps (`0.0.0.0` on either side, or equal). The first free port at or above 8092 wins; rows inserted earlier in the loop count. VM and DigitalOcean environments only avoid their own ports.
- **Migration 0015 extras:** it also adds the DB backstop `environments_learn_check` (learn needs wiki), `environments.kiosk_signing_digests text[] NOT NULL DEFAULT '{}'` and `deployments.seed_content boolean NOT NULL DEFAULT false`.
- **Seed step number and name:** `StepDef(20, "seed", "Seed starter content", "seed.yml", 20 * 60)`. Step numbers are unique keys inside a deployment (`_close` and Retry address steps by number, steps run in number order, `test_plans` requires rising numbers) and 11–19 are all taken, so step 20 runs last: after 11 Create the first admin and after any 12–14 / slot smoke / switch. The spec's "after the first-admin step" holds; it is not immediately after it.
- **How the seed step runs commands:** like step 11 — an Ansible playbook (`seed.yml`) runs a new `ss-stack seed <env-dir> [--learning]`, which runs `serversherpa seed-label-fonts`, `seed-label-templates` and (with `--learning`) `learning-seed` through `docker compose exec -T api`. The playbook passes `--learning` when `"learn"` and `"wiki"` are both in `env.apps`. Sirdar appends the TT0003M_.TTF note to the step's log on success.
- **`seed_content` storage and API default:** `deployments.seed_content` (0015). `POST …/deployments` takes `seed_content: bool | None`; the API default is off (no seed step), the web Data step defaults the switch on and sends `seed_content: true`. Anything but a first Update that restores no snapshot answers 422 `seed_content_not_allowed`. Retry keeps it.
- **SMTP password on PATCH:** the Settings form keeps using the existing Secrets row (`secrets.SS_SMTP_PASSWORD`); the API also accepts `mail.password` on PATCH and stores it as the same secret.
- **Portal before status loads:** an app counts as on until `/system/status` says `false` (and when an older API sends no `apps`), so nothing disappears and comes back.

## File Structure

**Main API**
- Modify `api/src/serversherpa/config.py` — `apps` setting (`SS_APPS`) + `app_on()`.
- Modify `api/src/serversherpa/api/schemas.py` — `AppsStatusOut`, `SystemStatusOut.apps`.
- Modify `api/src/serversherpa/api/routes/system.py` — `_status_from` fills `apps`.
- Modify `api/tests/conftest.py` — `SS_APPS=""` for the suite.
- Create `api/tests/test_apps_setting.py`; modify `api/tests/test_system_admin_api.py`.

**Portal**
- Modify `portal/src/lib/systemStatus.ts` (`apps`, `appOn`), `portal/src/lib/godmode.ts` (`app`, 6th arg), `portal/src/layout/navSections.tsx` (`app` on Kiosk/Wiki), `portal/src/layout/AppShell.tsx`, `portal/src/components/HelpButton.tsx`.
- Create `portal/src/layout/appsNav.test.tsx`; modify `portal/src/layout/AppShell.test.tsx`, `portal/src/components/HelpButton.test.tsx`.

**Stack / status app**
- Modify `deploy/stack/api/compose.yml`, `deploy/stack/status/compose.yml`, `deploy/stack/ss-stack`, `deploy/stack/env.example` (Task 4), `deploy/stack/README.md` (Task 11).
- Modify `status/src/serversherpa_status/config.py`, `status/tests/test_config.py`.
- Modify `deploy/tests/test_ss_stack.py`, `deploy/tests/test_stack_config.py`.

**Sirdar API**
- Create `sirdar/api/migrations/versions/0015_learn_and_editable_apps.py`.
- Modify `sirdar/api/src/sirdar_api/db/models.py`.
- Modify `sirdar/api/src/sirdar_api/deploy/{apps.py, envfile.py, certs.py, smoke.py, environments.py, do_provision.py, steps.py, pipeline.py, serialize.py}`; create `sirdar/api/src/sirdar_api/deploy/ansible/seed.yml`.
- Modify `sirdar/api/src/sirdar_api/api/routes/deploy.py`.
- Create `sirdar/api/tests/test_deploy_stack_drift.py`, `sirdar/api/tests/test_deploy_apps_edit_api.py`, `sirdar/api/tests/test_deploy_pipeline_seed.py`; modify the existing tests named per task.

**Sirdar web**
- Create `sirdar/web/src/lib/appRules.ts`, `sirdar/web/src/lib/appRules.test.ts`, `sirdar/web/src/components/AppsMail.tsx`.
- Modify `sirdar/web/src/lib/sirdarApi.ts`, `sirdar/web/src/pages/deploy/{flowState.ts, flowFixtures.ts, DeployFlow.tsx, steps/ExtrasStep.tsx, steps/DataStep.tsx}`, `sirdar/web/src/pages/environments/{EnvSettings.tsx, testData.ts}` and their tests.

**Docs**
- Modify `sirdar/README.md`, `deploy/stack/README.md`.

---

### Task 1: Main API knows which apps run (`SS_APPS`, `/system/status` apps)

**Files:**
- Modify: `api/src/serversherpa/config.py`
- Modify: `api/src/serversherpa/api/schemas.py:2577-2590`
- Modify: `api/src/serversherpa/api/routes/system.py:28-34,103-114`
- Modify: `api/tests/conftest.py:105-108`
- Modify: `api/tests/test_system_admin_api.py:25-32,77-82`
- Create: `api/tests/test_apps_setting.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Settings.apps: list[str]` (env `SS_APPS`), `Settings.app_on(app: str) -> bool`; `AppsStatusOut(wiki: bool, kiosk: bool, learn: bool)`; `SystemStatusOut.apps: AppsStatusOut`. JSON: `GET /system/status` → `"apps": {"wiki": bool, "kiosk": bool, "learn": bool}`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_apps_setting.py`:

```python
"""SS_APPS: which optional apps this environment runs (deploy/stack's
STACK_APPS). Unset or empty means every app is on; "none" means none."""

import pytest

from serversherpa.config import Settings


@pytest.fixture
def apps_env(monkeypatch):
    from serversherpa.config import get_settings

    def set_apps(raw: str) -> None:
        monkeypatch.setenv("SS_APPS", raw)
        get_settings.cache_clear()

    yield set_apps
    get_settings.cache_clear()


@pytest.mark.parametrize("raw, apps", [
    ("", []), (" ", []), ("wiki,kiosk", ["wiki", "kiosk"]),
    ("Wiki, LEARN ,", ["wiki", "learn"]), ("none", ["none"]),
])
def test_the_setting_is_split_trimmed_and_lowercased(monkeypatch, raw, apps):
    monkeypatch.setenv("SS_APPS", raw)
    assert Settings().apps == apps


@pytest.mark.parametrize("raw, on", [
    ("", {"wiki": True, "kiosk": True, "learn": True}),
    ("none", {"wiki": False, "kiosk": False, "learn": False}),
    ("kiosk,status", {"wiki": False, "kiosk": True, "learn": False}),
    ("wiki,learn,mailpit", {"wiki": True, "kiosk": False, "learn": True}),
])
def test_app_on(monkeypatch, raw, on):
    monkeypatch.setenv("SS_APPS", raw)
    settings = Settings()
    assert {app: settings.app_on(app) for app in on} == on


async def test_the_status_says_which_apps_run(client, apps_env):
    apps_env("kiosk,status")
    body = (await client.get("/system/status")).json()
    assert body["apps"] == {"wiki": False, "kiosk": True, "learn": False}
    apps_env("")
    body = (await client.get("/system/status")).json()
    assert body["apps"] == {"wiki": True, "kiosk": True, "learn": True}
```

In `api/tests/test_system_admin_api.py`, add `"apps": {"wiki": True, "kiosk": True, "learn": True},` to both exact dicts: after `"background": None,` in `test_status_is_public_and_defaults_off` (line 31), and change line 82's `"background": None}` to `"background": None, "apps": {"wiki": True, "kiosk": True, "learn": True}}`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd api && SS_TEST_DB=serversherpa_test_learn .venv/bin/python -m pytest tests/test_apps_setting.py tests/test_system_admin_api.py -q`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'apps'` and the status dicts lack `apps`.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/config.py`, after the `attestation_status_url` line (73-75 block), add:

```python
    # ── Optional apps (deploy/stack's STACK_APPS) ──────────
    # The optional apps this environment runs: comma-separated, lowercase
    # (wiki, kiosk, learn, status, mailpit). Unset or empty: every app counts
    # as on (dev, older stacks). "none": none of them is on. The portal hides
    # its links to an app that is off (GET /system/status → apps).
    apps: Annotated[list[str], NoDecode] = []
```

After `_split_signing_digests` add:

```python
    @field_validator("apps", mode="before")
    @classmethod
    def _split_apps(cls, value):
        if isinstance(value, str):
            value = value.split(",")
        return [str(a).strip().lower() for a in value or [] if str(a).strip()]

    def app_on(self, app: str) -> bool:
        """Whether an optional app runs: every one when SS_APPS is unset or empty."""
        return not self.apps or app in self.apps
```

In `api/src/serversherpa/api/schemas.py`, before `class SystemStatusOut`, add:

```python
class AppsStatusOut(BaseModel):
    """Which optional apps this environment runs (SS_APPS): the portal hides
    its links to an app that is off."""

    wiki: bool = True
    kiosk: bool = True
    learn: bool = True
```

and add as the last field of `SystemStatusOut`:

```python
    apps: AppsStatusOut = Field(default_factory=AppsStatusOut)
```

(`Field` is already imported in schemas.py; if not, add it to the `pydantic` import.)

In `api/src/serversherpa/api/routes/system.py`, add `AppsStatusOut,` to the schemas import list (line 31-34) and change `_status_from` to:

```python
def _status_from(cfg: dict, background: BackgroundStatusOut | None = None) -> SystemStatusOut:
    banner = cfg["banner_message"].strip() if cfg["banner_enabled"] else ""
    settings = get_settings()
    return SystemStatusOut(
        read_only=cfg["read_only"],
        read_only_message=cfg["read_only_message"] if cfg["read_only"] else "",
        workers_paused=bool(cfg["read_only"] and cfg["pause_workers"]),
        banner=banner or None,
        totp_trust_days=settings.totp_trust_days,
        email_enabled=email_enabled(),
        password_reset_ttl_minutes=settings.password_reset_ttl_minutes,
        password_min_length=settings.password_min_length,
        background=background,
        apps=AppsStatusOut(**{app: settings.app_on(app) for app in ("wiki", "kiosk", "learn")}))
```

In `api/tests/conftest.py`, after `os.environ["SS_SMTP_FROM"] = ""` (line 107), add:

```python
    # Every optional app is on unless a test says otherwise (a developer's
    # .env may list fewer).
    os.environ["SS_APPS"] = ""
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd api && SS_TEST_DB=serversherpa_test_learn .venv/bin/python -m pytest tests/test_apps_setting.py tests/test_system_admin_api.py tests/test_attestation_status.py -q`
Expected: PASS (all).

- [ ] **Step 5: Lint the touched files**

Run: `api/.venv/bin/ruff check api/src/serversherpa/config.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/system.py api/tests/test_apps_setting.py`
Expected: no findings that weren't there before.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/config.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/system.py api/tests/conftest.py api/tests/test_apps_setting.py api/tests/test_system_admin_api.py
git commit -m "feat(api): SS_APPS says which optional apps run; /system/status reports wiki, kiosk and learn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Portal hides Kiosk, Wiki and Help for apps that are off

**Files:**
- Modify: `portal/src/lib/systemStatus.ts`
- Modify: `portal/src/lib/godmode.ts`
- Modify: `portal/src/layout/navSections.tsx:20,808-834`
- Modify: `portal/src/layout/AppShell.tsx:19,74-83`
- Modify: `portal/src/components/HelpButton.tsx`
- Create: `portal/src/layout/appsNav.test.tsx`
- Modify: `portal/src/layout/AppShell.test.tsx:68-73,88-94`
- Modify: `portal/src/components/HelpButton.test.tsx:18-36`

**Interfaces:**
- Consumes: Task 1's `GET /system/status` → `apps`.
- Produces: `SystemStatus.apps?: { wiki: boolean; kiosk: boolean; learn: boolean }`; `type PortalApp = 'wiki' | 'kiosk' | 'learn'`; `appOn(status: SystemStatus, app: PortalApp): boolean`; `NavItem.app?: 'wiki' | 'kiosk'`; `isNavItemVisible(item, can, godMode, maxRank, isGlobal, appOn?: (app: 'wiki' | 'kiosk') => boolean)`.

- [ ] **Step 1: Write the failing tests**

Create `portal/src/layout/appsNav.test.tsx`:

```tsx
/** The Apps section's links follow the environment's apps (SS_APPS via
 *  /system/status): an app that is off loses its link; one the status
 *  doesn't mention (not loaded yet, or an older API) keeps it. */
import { expect, it } from 'vitest';

import { isNavItemVisible } from '../lib/godmode';
import { DEFAULT_SYSTEM_STATUS, appOn } from '../lib/systemStatus';
import { NAV_SECTIONS } from './navSections';

const apps = NAV_SECTIONS.find((s) => s.label === 'Apps')!.items;
const item = (label: string) => apps.find((i) => i.label === label)!;
const can = () => true;

it('the Kiosk and Wiki links name their app', () => {
  expect(item('Kiosk').app).toBe('kiosk');
  expect(item('Wiki').app).toBe('wiki');
});

it('an app that is off hides its link; unknown counts as on', () => {
  const off = { ...DEFAULT_SYSTEM_STATUS, apps: { wiki: false, kiosk: true, learn: true } };
  const on = (a: 'wiki' | 'kiosk') => appOn(off, a);
  expect(isNavItemVisible(item('Wiki'), can, false, 100, true, on)).toBe(false);
  expect(isNavItemVisible(item('Kiosk'), can, false, 100, true, on)).toBe(true);
  expect(isNavItemVisible(item('Wiki'), can, false, 100, true, (a) => appOn(DEFAULT_SYSTEM_STATUS, a))).toBe(true);
  expect(isNavItemVisible(item('Wiki'), can, false, 100, true)).toBe(true);
});

it('appOn: only an explicit false is off', () => {
  expect(appOn(DEFAULT_SYSTEM_STATUS, 'learn')).toBe(true);
  expect(appOn({ ...DEFAULT_SYSTEM_STATUS, apps: { wiki: true, kiosk: false, learn: false } }, 'kiosk')).toBe(false);
});
```

In `portal/src/layout/AppShell.test.tsx`, replace the `vi.mock('../lib/systemStatusContext', …)` block (lines 68-73) with:

```tsx
const sys = vi.hoisted(() => ({ apps: undefined as undefined | { wiki: boolean; kiosk: boolean; learn: boolean } }));
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({
    status: { read_only: true, read_only_message: 'Cutover', workers_paused: false, banner: 'Hello', apps: sys.apps },
    refresh: vi.fn(),
  }),
}));
```

add `sys.apps = undefined;` as the last line of the `beforeEach` (after `auth.updatePreferences = …`), and add after the existing "the Apps section links to the kiosk and wiki…" test:

```tsx
it('the Apps section leaves out an app the environment turned off', () => {
  auth.navMode = 'expanded';
  sys.apps = { wiki: false, kiosk: true, learn: true };
  renderShell();
  const nav = within(document.querySelector('.portal-nav.docked')!);
  expect(nav.queryByText('Wiki')).toBeNull();
  expect(nav.getByText('Kiosk')).toBeTruthy();
});
```

In `portal/src/components/HelpButton.test.tsx`, after the `vi.mock('../lib/api', …)` line (19) add:

```tsx
const sys = vi.hoisted(() => ({ apps: undefined as undefined | { wiki: boolean; kiosk: boolean; learn: boolean } }));
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { apps: sys.apps }, loaded: true, refresh: () => {} }),
}));
```

add `sys.apps = undefined;` to the `afterEach` (after `auth.person = …`), and after the 'is hidden without wiki:view' test add:

```tsx
it('is hidden while the wiki is off, and asks nothing', () => {
  sys.apps = { wiki: false, kiosk: true, learn: true };
  renderAt();
  expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  expect(apiFetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd portal && npx vitest run src/layout/appsNav.test.tsx src/layout/AppShell.test.tsx src/components/HelpButton.test.tsx`
Expected: FAIL — `appOn` is not exported; the Wiki link and the ? button still render.

- [ ] **Step 3: Implement**

`portal/src/lib/systemStatus.ts` — add to `SystemStatus` after `password_min_length: number;`:

```ts
  /** Which optional apps this environment runs (SS_APPS). Absent from an older API. */
  apps?: { wiki: boolean; kiosk: boolean; learn: boolean };
```

and after `DEFAULT_SYSTEM_STATUS` add:

```ts
export type PortalApp = 'wiki' | 'kiosk' | 'learn';

/** Whether an optional app runs. Only an explicit false is off: until the
 *  status loads (or from an older API) every app counts as on, so links
 *  never vanish and come back. */
export function appOn(status: SystemStatus, app: PortalApp): boolean {
  return status.apps?.[app] !== false;
}
```

`portal/src/lib/godmode.ts` — add to `GodGatedItem` after `globalOnly?: boolean;`:

```ts
  /** A link to an optional app: hidden while the environment runs it off. */
  app?: 'wiki' | 'kiosk';
```

and change `isNavItemVisible` to:

```ts
export function isNavItemVisible(
  item: GodGatedItem,
  can: (resource: string, action: Action) => boolean,
  godMode: boolean,
  maxRank: number,
  isGlobal: boolean,
  appOn: (app: 'wiki' | 'kiosk') => boolean = () => true,
): boolean {
  if (item.app && !appOn(item.app)) return false;
  if (item.globalOnly && !isGlobal) return false;
  if (item.minRank !== undefined && maxRank < item.minRank) return false;
  if (item.learningManager) {
    if (!canManageLearning({ can, isGlobal })) return false;
  } else if (item.resource && !can(item.resource, 'view')) return false;
  return !item.godOnly || godMode;
}
```

`portal/src/layout/navSections.tsx` — in the `NavItem` interface (line 20) add `app?: 'wiki' | 'kiosk';` after `href?: string;`; add `app: 'kiosk',` after `resource: 'kiosk',` (Kiosk item) and `app: 'wiki',` after `resource: 'wiki',` (Wiki item) in the Apps section.

`portal/src/layout/AppShell.tsx` — add imports:

```ts
import { appOn } from '../lib/systemStatus';
import { useSystemStatus } from '../lib/systemStatusContext';
```

and in `AppShellInner`, after `const isGlobal = scope?.global ?? true;`:

```ts
  const { status } = useSystemStatus();
  const visibleSections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => isNavItemVisible(i, can, godMode, maxRank, isGlobal,
                                                                         (app) => appOn(status, app))) }))
    .filter((s) => s.items.length > 0);
```

(replacing the existing `visibleSections` declaration).

`portal/src/components/HelpButton.tsx` — first doc line becomes `* The top bar's ? button (wiki:view, and only while the environment runs the wiki):`; add imports:

```ts
import { appOn } from '../lib/systemStatus';
import { useSystemStatus } from '../lib/systemStatusContext';
```

and replace `const canView = can('wiki', 'view');` with:

```ts
  const { status } = useSystemStatus();
  // no guide to show while the environment runs without the wiki (SS_APPS)
  const canView = can('wiki', 'view') && appOn(status, 'wiki');
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd portal && npx vitest run src/layout src/components/HelpButton.test.tsx`
Expected: PASS (every layout test file, the new ones included).

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/systemStatus.ts portal/src/lib/godmode.ts portal/src/layout/navSections.tsx portal/src/layout/AppShell.tsx portal/src/components/HelpButton.tsx portal/src/layout/appsNav.test.tsx portal/src/layout/AppShell.test.tsx portal/src/components/HelpButton.test.tsx
git commit -m "feat(portal): no Kiosk or Wiki link, and no Help button, for an app the environment runs off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Stack passes SS_APPS and the signing digests, monitors learn, and refuses learn without the wiki

**Files:**
- Modify: `deploy/stack/api/compose.yml:7-56` (x-ss-env, extra_hosts)
- Modify: `deploy/stack/status/compose.yml`
- Modify: `deploy/stack/ss-stack:28-29,76-91,348-357`
- Modify: `status/src/serversherpa_status/config.py:16-26`
- Modify: `status/tests/test_config.py`
- Modify: `deploy/tests/test_ss_stack.py`
- Modify: `deploy/tests/test_stack_config.py`

**Interfaces:**
- Consumes: Task 1's `Settings.apps` (so `SS_APPS` is a known setting for `test_api_environment_has_no_unknown_ss_keys`).
- Produces: x-ss-env keys `SS_APPS: ${STACK_APPS:-}`, `SS_KIOSK_SIGNING_DIGESTS: ${SS_KIOSK_SIGNING_DIGESTS:-}`; status env `STATUS_LEARN_URL`; `ss-stack` dies with "The learning site needs the wiki: turn the wiki on, or turn learning off." when `STACK_APPS` lists learn without wiki; status monitor `("learn", "Learning", "STATUS_LEARN_URL", False)`.

`env.example` is NOT touched here: its new keys must land with Sirdar's renderer (Task 4) or Sirdar's key-order test breaks.

- [ ] **Step 1: Write the failing tests**

`deploy/tests/test_ss_stack.py`:

1. In `FAKE_DOCKER`, change the status line to also print learn:

```bash
    printf 'kiosk=%s wiki=%s learn=%s\n' "${STATUS_KIOSK_URL-unset}" "${STATUS_WIKI_URL-unset}" \
      "${STATUS_LEARN_URL-unset}" >> "$DOCKER_LOG.status" ;;
```

2. Replace the `test_the_status_page_checks_only_the_apps_that_run` parametrize list and its `env` line with:

```python
@pytest.mark.parametrize("apps, seen", [
    ("", "kiosk=unset wiki=unset learn=unset"),
    ("wiki,kiosk,learn,status,mailpit", "kiosk=unset wiki=unset learn=unset"),
    ("wiki,kiosk,status,mailpit", "kiosk=unset wiki=unset learn="),
    ("status,mailpit", "kiosk= wiki= learn="),
    ("wiki,status,mailpit", "kiosk= wiki=unset learn="),
    ("kiosk,status,mailpit", "kiosk=unset wiki= learn="),
])
```

and inside it `env = {**fake, "STATUS_KIOSK_URL": "https://elsewhere.example", "STATUS_WIKI_URL": "x", "STATUS_LEARN_URL": "y"}`.

3. Replace `test_the_learn_site_runs_when_listed` with:

```python
def test_the_learn_site_runs_when_listed(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=wiki,learn\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    assert dc(env_dir, "web", f"{WAIT} --scale kiosk=0") in calls(fake)


@pytest.mark.parametrize("command", ["up", "data"])
def test_the_learning_site_needs_the_wiki(env_dir: Path, fake: dict[str, str],
                                          command: str) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=kiosk,learn,status\n")
    out = run(fake, command, str(env_dir))
    assert out.returncode != 0
    assert ("The learning site needs the wiki: turn the wiki on, or turn learning off."
            in out.stderr)
    assert calls(fake) == []
```

`deploy/tests/test_stack_config.py`:

1. `PUBLIC = ("api", "portal", "kiosk", "wiki", "learn", "spaces", "status")`.
2. Replace `test_the_status_page_targets_follow_ss_stack` with:

```python
@pytest.mark.parametrize("given, kiosk, wiki, learn", [
    ({}, f"https://kiosk.{DOMAIN}", f"https://wiki.{DOMAIN}", f"https://learn.{DOMAIN}"),
    ({"STATUS_KIOSK_URL": "", "STATUS_WIKI_URL": "", "STATUS_LEARN_URL": ""}, "", "", ""),
])
def test_the_status_page_targets_follow_ss_stack(given: dict[str, str], kiosk: str,
                                                 wiki: str, learn: str) -> None:
    """ss-stack sets STATUS_KIOSK_URL / STATUS_WIKI_URL / STATUS_LEARN_URL
    empty for an app that is off (STACK_APPS); unset, each is the app's
    public URL."""
    env = {k: v for k, v in os.environ.items()
           if k not in ("STATUS_KIOSK_URL", "STATUS_WIKI_URL", "STATUS_LEARN_URL")}
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(ENV_EXAMPLE), "-f",
         str(STACK_DIR / "status" / "compose.yml"), "config", "--format", "json"],
        capture_output=True, text=True, env={**env, **given})
    assert out.returncode == 0, out.stderr
    status = json.loads(out.stdout)["services"]["status"]["environment"]
    assert (status["STATUS_KIOSK_URL"], status["STATUS_WIKI_URL"],
            status["STATUS_LEARN_URL"]) == (kiosk, wiki, learn)
```

3. Append:

```python
def test_the_api_reads_the_apps_and_the_signing_digests_from_the_env_file(tmp_path) -> None:
    env = rendered("api")["services"]["api"]["environment"]
    assert (env["SS_APPS"], env["SS_KIOSK_SIGNING_DIGESTS"]) == ("", "")
    digest = "ab" * 32
    env_file = tmp_path / ".env"
    env_file.write_text(ENV_EXAMPLE.read_text() + (
        f"STACK_APPS=wiki,learn,mailpit\nSS_KIOSK_SIGNING_DIGESTS={digest}\n"))
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(STACK_DIR / "api/compose.yml"),
         "config", "--format", "json"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    got = json.loads(out.stdout)["services"]["api"]["environment"]
    assert (got["SS_APPS"], got["SS_KIOSK_SIGNING_DIGESTS"]) == ("wiki,learn,mailpit", digest)
```

`status/tests/test_config.py` — append:

```python
def test_learn_is_optional_and_off_by_default():
    assert "learn" not in [s.key for s in load_settings(BASE).services]


def test_learn_follows_the_wiki_when_configured():
    s = load_settings({**BASE, "STATUS_WIKI_URL": "https://wiki.example.com",
                       "STATUS_LEARN_URL": "https://learn.example.com/"})
    assert [(x.key, x.name, x.url) for x in s.services][-2:] == [
        ("wiki", "Wiki", "https://wiki.example.com"),
        ("learn", "Learning", "https://learn.example.com"),
    ]


def test_learn_url_must_be_http():
    with pytest.raises(ConfigError, match="STATUS_LEARN_URL"):
        load_settings({**BASE, "STATUS_LEARN_URL": "learn.example.com"})
```

- [ ] **Step 2: Run them to see them fail**

Run: `api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests/test_ss_stack.py deploy/tests/test_stack_config.py -q`
Expected: FAIL — learn without wiki starts; `learn=unset` where `learn=` is expected; `SS_APPS` missing; learn has no extra_hosts entry.

Run: `cd status && .venv/bin/pytest -q tests/test_config.py`
Expected: FAIL — no learn service.

- [ ] **Step 3: Implement**

`deploy/stack/api/compose.yml` — in x-ss-env, after `SS_DB_TESTING_PASSWORD: ${SS_DB_TESTING_PASSWORD:-}` add:

```yaml
  # the optional apps that run (the portal hides links to the others); empty: every app
  SS_APPS: ${STACK_APPS:-}
  # comma-separated SHA-256 digests of the kiosk app's signing certificates
  # (release and Play): biometric sign-in enrolls only apps signed with these
  SS_KIOSK_SIGNING_DIGESTS: ${SS_KIOSK_SIGNING_DIGESTS:-}
```

and in `extra_hosts` after the `wiki.` line add:

```yaml
    - "learn.${STACK_DOMAIN}:${STACK_HOSTS_IP:-${STACK_PROXY_IP}}"
```

`deploy/stack/status/compose.yml` — after the `STATUS_WIKI_URL` line add:

```yaml
      STATUS_LEARN_URL: ${STATUS_LEARN_URL-https://learn.${STACK_DOMAIN}}
```

and in `extra_hosts` after the `wiki.` line add `      - "learn.${STACK_DOMAIN}:${STACK_HOSTS_IP:-${STACK_PROXY_IP}}"`.

`deploy/stack/ss-stack`:

- Header comment (lines 28-29) becomes:

```bash
# STACK_APPS lists the optional apps that run (wiki, kiosk, learn, status, mailpit;
# "none" for none); without it every app runs. API and portal always run. The
# learning site needs the wiki (its documents render there).
```

- In `check_apps()`, after the `done` that closes the `for app` loop, add:

```bash
  if app_on learn && ! app_on wiki; then
    die "The learning site needs the wiki: turn the wiki on, or turn learning off."
  fi
```

- In `up)`, the status subshell becomes:

```bash
      ( unset STATUS_KIOSK_URL STATUS_WIKI_URL STATUS_LEARN_URL
        app_on kiosk || export STATUS_KIOSK_URL=
        app_on wiki || export STATUS_WIKI_URL=
        app_on learn || export STATUS_LEARN_URL=
        dc status up -d "${WAIT[@]}" )
```

`status/src/serversherpa_status/config.py` — `SERVICES` gains a last entry and the comment mentions it:

```python
# adding one never breaks an existing deployment's .env. The kiosk, the wiki
# and the learning site are optional too: an environment can run without
# them (Sirdar's STACK_APPS).
SERVICES = (
    ("api", "API", "STATUS_API_URL", True),
    ("portal", "Portal", "STATUS_PORTAL_URL", True),
    ("kiosk", "Kiosk", "STATUS_KIOSK_URL", False),
    ("wiki", "Wiki", "STATUS_WIKI_URL", False),
    ("learn", "Learning", "STATUS_LEARN_URL", False),
)
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests/test_ss_stack.py deploy/tests/test_stack_config.py -q`
Expected: PASS (test_stack_config.py is skipped only where the docker CLI is missing).

Run: `cd status && .venv/bin/pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/stack/api/compose.yml deploy/stack/status/compose.yml deploy/stack/ss-stack status/src/serversherpa_status/config.py status/tests/test_config.py deploy/tests/test_ss_stack.py deploy/tests/test_stack_config.py
git commit -m "feat(stack): SS_APPS and the kiosk signing digests reach the API, the status page checks learn, and learn needs the wiki

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Sirdar knows learn — migration 0015, the app and service lists, env.example, drift tests

Migration and lists go together: the 0013 check constraint refuses `learn` in `apps`, and the new column default puts learn on every factory-made environment, so neither half is green alone.

**Files:**
- Create: `sirdar/api/migrations/versions/0015_learn_and_editable_apps.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py:217-218,312-313`
- Modify: `sirdar/api/src/sirdar_api/deploy/apps.py:13-14,99-106`
- Modify: `sirdar/api/src/sirdar_api/deploy/envfile.py:14-18,59-63,88-110`
- Modify: `sirdar/api/src/sirdar_api/deploy/certs.py:28`
- Modify: `sirdar/api/src/sirdar_api/deploy/smoke.py:28-29`
- Modify: `deploy/stack/env.example`
- Create: `sirdar/api/tests/test_deploy_stack_drift.py`
- Modify tests: `test_deploy_models.py`, `test_deploy_apps.py`, `test_deploy_envfile.py`, `test_deploy_environments_api.py`, `test_deploy_apps_api.py`, `test_deploy_home.py`, `test_deploy_publish_steps.py`, `test_deploy_publish.py`, `test_dashboard_flow.py`, `test_deploy_do_provision.py`, `test_deploy_do_environments.py`, `test_deploy_pipeline_do.py`, `test_deploy_pipeline_lan.py`, `test_deploy_acme.py`, `deploy_factories.py` (all under `sirdar/api/tests/`).

**Interfaces:**
- Consumes: nothing new.
- Produces: `apps.OPTIONAL_APPS = ("wiki", "kiosk", "learn", "status", "mailpit")`; `apps._PUBLIC_APPS = ("wiki", "kiosk", "learn", "status")`; `envfile.SERVICES = ("api", "portal", "kiosk", "wiki", "learn", "spaces", "status", "mailpit")`, `envfile.PUBLIC_SERVICES = SERVICES[:7]`, `envfile.DEFAULT_PORTS["learn"] == 8092`, `envfile.OPTIONAL_SETTINGS = ("SS_KIOSK_SIGNING_DIGESTS",)`; `certs.PUBLIC_SERVICES = ("api", "portal", "kiosk", "wiki", "learn", "status")`; `smoke.PATHS["learn"] == "/"`; `Environment.kiosk_signing_digests: list[str]`; `Deployment.seed_content: bool`; `apps.env_extra(env)` adds `SS_KIOSK_SIGNING_DIGESTS` when `env.kiosk_signing_digests` is non-empty.

- [ ] **Step 1: Write the migration test and bump the head asserts**

In `sirdar/api/tests/test_deploy_models.py`, replace every `== "0014"` (lines 427, 595, 652, 871, 913, 953) with `== "0015"`, then append:

```python
async def test_migration_0015_adds_learn_and_the_new_columns():
    """Upgrade: learn joins the apps of every environment that runs the wiki
    (in the canonical order); every environment with a portal row and no
    learn row gets one on the portal's host: 8092, or the first free port at
    or above it among its own ports and, on an SSH target, those of the other
    SSH environments on that host; named learn.<base domain> only where learn
    is on. Learn without the wiki is refused. Downgrade: the rows, the apps
    entry and the new columns go."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    _alembic("downgrade", "0014")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            def env(name, target, apps=None):
                cols, vals = (", apps", ", %s") if apps is not None else ("", "")
                return conn.execute(
                    "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip"
                    f"{cols}) VALUES (%s, 'dev', %s, %s, '10.0.0.2'{vals}) RETURNING id",
                    (name, target, f"{name}.serversherpa.com",
                     *([apps] if apps is not None else []))).fetchone()[0]

            def row(env_id, service, host, port, hostname=None):
                conn.execute(
                    "INSERT INTO environment_services (environment_id, service, host_ip, port, "
                    "hostname) VALUES (%s, %s, %s, %s, %s)",
                    (env_id, service, host, port, hostname))

            a = env("a", "ssh")                                # wiki on (0013's default)
            row(a, "portal", "10.0.0.5", 8091)
            row(a, "status", "10.0.0.5", 8092)                 # its own 8092 is taken
            b = env("b", "ssh:lab", ["kiosk", "mailpit"])      # same SSH host, no wiki
            row(b, "portal", "10.0.0.5", 8093)
            c = env("c", "esxi", ["wiki", "mailpit"])          # a VM: shares nothing
            row(c, "portal", "10.0.0.5", 8092)
            d = env("d", "ssh")                                # already has a learn row
            row(d, "portal", "10.0.0.9", 8091)
            row(d, "learn", "10.0.0.9", 9999, "old.example.com")
        _alembic("upgrade", "head")
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0015"
            apps = dict(conn.execute("SELECT name, apps FROM environments").fetchall())
            assert apps == {"a": ["wiki", "kiosk", "learn", "status", "mailpit"],
                            "b": ["kiosk", "mailpit"], "c": ["wiki", "learn", "mailpit"],
                            "d": ["wiki", "kiosk", "learn", "status", "mailpit"]}
            learn = conn.execute(
                "SELECT e.name, s.host_ip, s.port, s.hostname, s.proxied "
                "FROM environment_services s JOIN environments e ON e.id = s.environment_id "
                "WHERE s.service = 'learn' ORDER BY e.name").fetchall()
            assert learn == [("a", "10.0.0.5", 8094, "learn.a.serversherpa.com", False),
                             ("b", "10.0.0.5", 8095, None, False),
                             ("c", "10.0.0.5", 8093, "learn.c.serversherpa.com", False),
                             ("d", "10.0.0.9", 9999, "old.example.com", False)]
            assert conn.execute("SELECT DISTINCT kiosk_signing_digests FROM environments"
                                ).fetchall() == [([],)]
            default = conn.execute(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_name = 'environments' AND column_name = 'apps'").fetchone()[0]
            assert default.startswith("'{wiki,kiosk,learn,status,mailpit}'")
            assert conn.execute(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_name = 'deployments' AND column_name = 'seed_content'"
            ).fetchone()[0] == "false"
            with pytest.raises(psycopg.errors.CheckViolation):
                conn.execute("UPDATE environments SET apps = '{learn,mailpit}' WHERE name = 'b'")
        _alembic("downgrade", "0014")
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM environment_services "
                                "WHERE service = 'learn'").fetchone()[0] == 0
            assert conn.execute("SELECT apps FROM environments WHERE name = 'a'"
                                ).fetchone()[0] == ["wiki", "kiosk", "status", "mailpit"]
            assert conn.execute(
                "SELECT count(*) FROM information_schema.columns WHERE column_name IN "
                "('kiosk_signing_digests', 'seed_content')").fetchone()[0] == 0
    finally:
        _alembic("upgrade", "head")
```

- [ ] **Step 2: Write the list, envfile and drift tests**

Create `sirdar/api/tests/test_deploy_stack_drift.py`:

```python
"""Sirdar's app and port lists against deploy/stack's: a new optional app or
port in the stack must reach Sirdar (and the reverse)."""

import re
from pathlib import Path

from sirdar_api.deploy import apps, certs, envfile, smoke

STACK = Path(__file__).resolve().parents[3] / "deploy" / "stack"


def _stack_apps() -> set[str]:
    text = (STACK / "ss-stack").read_text()
    body = text[text.index("check_apps() {"):]
    body = body[:body.index("\n}\n")]
    case = re.search(r"^\s*([a-z|]+)\) ;;$", body, re.M)
    assert case, "check_apps' case list moved"
    return set(case.group(1).split("|"))


def test_sirdar_knows_exactly_the_stacks_optional_apps():
    assert _stack_apps() == set(apps.OPTIONAL_APPS)


def test_every_stack_port_is_a_sirdar_service_and_back():
    keys = set(re.findall(r"^(STACK_[A-Z]+_PORT)=", (STACK / "env.example").read_text(), re.M))
    assert keys == set(envfile.PORT_KEYS.values())


def test_learn_is_a_public_app_everywhere():
    assert "learn" in apps.OPTIONAL_APPS
    assert "learn" in envfile.PUBLIC_SERVICES and "learn" in certs.PUBLIC_SERVICES
    assert envfile.DEFAULT_PORTS["learn"] == 8092
    assert smoke.PATHS["learn"] == "/"
```

In `sirdar/api/tests/test_deploy_envfile.py`: line 108 becomes `assert envfile.PUBLIC_SERVICES == envfile.SERVICES[:7]`; append:

```python
def test_learn_has_its_own_port():
    assert envfile.parse_env(envfile.render_env(_cfg()))["STACK_LEARN_PORT"] == "8092"


def test_the_signing_digests_follow_the_optional_secrets():
    digest = "ab" * 32
    text = envfile.render_env(_cfg(extra={"SS_KIOSK_SIGNING_DIGESTS": digest}))
    keys = _keys(text)
    assert keys.index("SS_KIOSK_SIGNING_DIGESTS") == keys.index("SS_SMTP_PASSWORD") + 1
    assert envfile.parse_env(text)["SS_KIOSK_SIGNING_DIGESTS"] == digest
    assert envfile.parse_env(envfile.render_env(_cfg()))["SS_KIOSK_SIGNING_DIGESTS"] == ""
```

In `sirdar/api/tests/test_deploy_apps.py`:
- line 11: `assert apps.check_apps(None) == ["wiki", "kiosk", "learn", "status", "mailpit"]`
- line 70: `assert apps.public_services(["wiki", "kiosk", "learn", "status", "mailpit"]) == envfile.PUBLIC_SERVICES`
- in `test_env_extra` and `test_an_environment_with_nothing_chosen_runs_every_app_on_mailpit`, add `kiosk_signing_digests=[]` to each `SimpleNamespace(...)`; line 100 becomes `assert apps.env_extra(env) == {"STACK_APPS": "wiki,kiosk,learn,status,mailpit"}`.
- append:

```python
def test_env_extra_writes_the_signing_digests():
    env = SimpleNamespace(apps=["kiosk", "mailpit"], smtp_host=None, smtp_port=None,
                          smtp_username=None, smtp_from=None, smtp_starttls=True,
                          kiosk_signing_digests=["ab" * 32, "cd" * 32])
    extra = apps.env_extra(env)
    assert extra["SS_KIOSK_SIGNING_DIGESTS"] == f"{'ab' * 32},{'cd' * 32}"
    assert set(extra) <= set(envfile.EXTRA_KEYS) | set(envfile.OPTIONAL_SETTINGS)
```

Update the pinned lists (learn goes right after wiki; its port is 8092):
- `test_deploy_environments_api.py`: in `test_environment_defaults` add `{"service": "learn", "port": 8092, "public": True},` after the wiki row; line 85 `"optional": ["wiki", "kiosk", "learn", "status", "mailpit"]`; line 110 `"apps": ["wiki", "kiosk", "learn", "status", "mailpit"]`.
- `test_deploy_apps_api.py`: lines 116, 136, 142, 331 — the list becomes `["wiki", "kiosk", "learn", "status", "mailpit"]`; line 146 `"wiki,kiosk,learn,status,mailpit"`; in `test_a_new_base_domain_names_only_the_running_apps` add `"learn": None,` after `"wiki": None,`.
- `test_deploy_home.py`: `_env` apps `["wiki", "kiosk", "learn", "status", "mailpit"]`; `SERVICE_ORDER == ("api", "portal", "home", "kiosk", "wiki", "learn", "spaces", "status", "mailpit")`.
- `test_deploy_publish_steps.py` lines 17-20: `("api", "portal", "kiosk", "wiki", "learn", "spaces", "status")` and `PORTS = {"api": 8000, "portal": 8091, "kiosk": 8090, "wiki": 8096, "learn": 8092, "spaces": 9000, "status": 8095}`.
- `test_deploy_publish.py` lines 207 and 239: `["api", "portal", "kiosk", "wiki", "learn", "spaces", "status"]`.
- `test_dashboard_flow.py` line 391: `("api", "portal", "kiosk", "wiki", "learn", "spaces", "status")`.
- `test_deploy_do_provision.py` line 80, `test_deploy_do_environments.py` line 253, `test_deploy_pipeline_do.py` lines 102 and 389: `("api", "portal", "kiosk", "wiki", "learn", "status")`.
- `test_deploy_pipeline_lan.py` line 94: `"api", "portal", "kiosk", "wiki", "learn", "status"}`.
- `test_deploy_acme.py` `test_names_and_helpers`: insert `"learn.uat9.serversherpa.com",` after `"wiki.uat9.serversherpa.com",`.
- `deploy_factories.py` `REMOTE_BASE`: insert `"STACK_LEARN_PORT": "8092",` after `"STACK_WIKI_PORT": "8096",`.

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_stack_drift.py tests/test_deploy_envfile.py tests/test_deploy_apps.py tests/test_deploy_models.py -q`
Expected: FAIL — no `learn` in the lists, no `OPTIONAL_SETTINGS`, head is 0014.

- [ ] **Step 4: Write migration 0015**

Create `sirdar/api/migrations/versions/0015_learn_and_editable_apps.py`:

```python
"""The learning site (learn, port 8092) as an optional app, and two columns
for later work: an environment's kiosk signing digests (plain, not secret;
rendered as SS_KIOSK_SIGNING_DIGESTS) and whether a deployment seeds starter
content (step 20).

Learn joins the apps of every environment that runs the wiki (its documents
render there), and every environment with a portal row and no learn row gets
one on the portal's host: 8092, or the first free port at or above it. An
SSH target can share its host with other SSH environments, so their ports on
that host count too (any bind address of theirs or ours being 0.0.0.0, or the
same one); a VM or droplet only avoids its own. It is named learn.<base
domain> where learn is on. The next Update writes STACK_APPS with learn and
its publish adds the DNS record, proxy host and certificate name.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-05
"""
import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

LEARN_PORT = 8092


def _shares_host(target_id: str) -> bool:
    return target_id == "ssh" or target_id.startswith("ssh:")


def upgrade() -> None:
    op.execute("""
        ALTER TABLE environments
          DROP CONSTRAINT environments_apps_check,
          ADD CONSTRAINT environments_apps_check
            CHECK (apps <@ ARRAY['wiki', 'kiosk', 'learn', 'status', 'mailpit']::text[]),
          ALTER COLUMN apps SET DEFAULT '{wiki,kiosk,learn,status,mailpit}',
          ADD COLUMN kiosk_signing_digests text[] NOT NULL DEFAULT '{}';
        UPDATE environments
           SET apps = ARRAY(SELECT t.app
                              FROM unnest(ARRAY['wiki', 'kiosk', 'learn', 'status', 'mailpit'])
                                   WITH ORDINALITY AS t(app, i)
                             WHERE t.app = ANY (apps) OR t.app = 'learn'
                             ORDER BY t.i)
         WHERE 'wiki' = ANY (apps) AND NOT 'learn' = ANY (apps);
        ALTER TABLE environments
          ADD CONSTRAINT environments_learn_check
            CHECK (NOT 'learn' = ANY (apps) OR 'wiki' = ANY (apps));
        ALTER TABLE deployments ADD COLUMN seed_content boolean NOT NULL DEFAULT false;
    """)
    conn = op.get_bind()
    todo = conn.execute(sa.text("""
        SELECT e.id, e.target_id, e.bind_ip, e.base_domain, 'learn' = ANY (e.apps), p.host_ip
          FROM environments e
          JOIN environment_services p ON p.environment_id = e.id AND p.service = 'portal'
         WHERE NOT EXISTS (SELECT 1 FROM environment_services s
                            WHERE s.environment_id = e.id AND s.service = 'learn')
         ORDER BY e.created_at, e.name
    """)).all()
    for env_id, target_id, bind_ip, domain, learn_on, host_ip in todo:
        used = set(conn.execute(sa.text("""
            SELECT s.port
              FROM environment_services s
              JOIN environments o ON o.id = s.environment_id
             WHERE s.environment_id = :env_id
                OR (CAST(:shared AS boolean) AND s.host_ip = :host_ip
                    AND (o.target_id = 'ssh' OR left(o.target_id, 4) = 'ssh:')
                    AND (o.bind_ip = '0.0.0.0' OR CAST(:bind_ip AS text) = '0.0.0.0'
                         OR o.bind_ip = :bind_ip))
        """), {"env_id": env_id, "shared": _shares_host(target_id), "host_ip": host_ip,
               "bind_ip": bind_ip}).scalars())
        port = LEARN_PORT
        while port in used:
            port += 1
        conn.execute(sa.text("""
            INSERT INTO environment_services (environment_id, service, host_ip, port, hostname,
                                              proxied)
            VALUES (:env_id, 'learn', :host_ip, :port, :hostname, false)
        """), {"env_id": env_id, "host_ip": host_ip, "port": port,
               "hostname": f"learn.{domain}" if learn_on else None})


def downgrade() -> None:
    # Managed records for learn stay: the code below 0015 sees them as stale on
    # the next publish and removes what Sirdar created.
    op.execute("""
        DELETE FROM environment_services WHERE service = 'learn';
        ALTER TABLE deployments DROP COLUMN seed_content;
        ALTER TABLE environments
          DROP CONSTRAINT environments_learn_check,
          DROP COLUMN kiosk_signing_digests;
        UPDATE environments SET apps = array_remove(apps, 'learn');
        ALTER TABLE environments
          DROP CONSTRAINT environments_apps_check,
          ADD CONSTRAINT environments_apps_check
            CHECK (apps <@ ARRAY['wiki', 'kiosk', 'status', 'mailpit']::text[]),
          ALTER COLUMN apps SET DEFAULT '{wiki,kiosk,status,mailpit}';
    """)
```

- [ ] **Step 5: Update the models**

In `sirdar/api/src/sirdar_api/db/models.py`, `Environment`:

```python
    # The Deploy page flow (migration 0013; learn: 0015): the optional apps it
    # runs, and its SMTP server (smtp_host NULL: its own Mailpit).
    apps: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{wiki,kiosk,learn,status,mailpit}'"))
```

and after `smtp_starttls`:

```python
    # SHA-256 digests of the kiosk app's signing certificates (migration 0015):
    # lowercase hex, rendered as SS_KIOSK_SIGNING_DIGESTS. Not a secret.
    kiosk_signing_digests: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{}'"))
```

`Deployment`, after `first_admin`:

```python
    # Its plan ends with step 20, Seed starter content (migration 0015): a first
    # Update that starts empty and asked for it. Retries keep it.
    seed_content: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
```

- [ ] **Step 6: Update the lists and the renderer**

`sirdar/api/src/sirdar_api/deploy/apps.py`:

```python
OPTIONAL_APPS = ("wiki", "kiosk", "learn", "status", "mailpit")
ALWAYS = ("api", "portal")
_PUBLIC_APPS = ("wiki", "kiosk", "learn", "status")  # their public names go when they're off
```

(also change the module docstring's "wiki, kiosk, status and mailpit" to "wiki, kiosk, learn, status and mailpit"), and `env_extra` becomes:

```python
def env_extra(env) -> dict[str, str]:
    out = {"STACK_APPS": ",".join(env.apps) if env.apps else "none"}
    if env.smtp_host:
        out |= {"SS_SMTP_HOST": env.smtp_host, "SS_SMTP_PORT": str(env.smtp_port),
                "SS_SMTP_USERNAME": env.smtp_username or "",
                "SS_SMTP_STARTTLS": "true" if env.smtp_starttls else "false",
                "SS_SMTP_FROM": env.smtp_from}
    if env.kiosk_signing_digests:
        out["SS_KIOSK_SIGNING_DIGESTS"] = ",".join(env.kiosk_signing_digests)
    return out
```

`sirdar/api/src/sirdar_api/deploy/envfile.py`:

```python
SERVICES = ("api", "portal", "kiosk", "wiki", "learn", "spaces", "status", "mailpit")
PUBLIC_SERVICES = ("api", "portal", "kiosk", "wiki", "learn", "spaces", "status")
DEFAULT_PORTS = {"api": 8000, "portal": 8091, "kiosk": 8090, "wiki": 8096, "learn": 8092,
                 "spaces": 9000, "status": 8095, "mailpit": 8025}
```

after `SECRET_KEYS = …` add:

```python
# Settings that aren't secrets, written right after the optional secrets ("" when
# unset): the kiosk app's signing certificate digests (apps.env_extra fills it).
OPTIONAL_SETTINGS = ("SS_KIOSK_SIGNING_DIGESTS",)
```

`KNOWN_KEYS` becomes:

```python
KNOWN_KEYS = (
    "STACK_ENV", "STACK_DOMAIN", "STACK_IMAGE_TAG", "STACK_REPO_DIR", "STACK_PROXY_IP",
    "STACK_BIND_IP", *(PORT_KEYS[s] for s in SERVICES), "STACK_KEEP_DUMPS",
    *REQUIRED_SECRETS, "SS_SPACES_BUCKET", "SS_LOG_LEVEL", *OPTIONAL_SECRETS,
    *OPTIONAL_SETTINGS, *EXTRA_KEYS,
)
```

In `EnvConfig`, the `extra` comment becomes `# EXTRA_KEYS (written after the optional settings, in this order) and OPTIONAL_SETTINGS`. In `render_env`, after `**{k: cfg.secrets.get(k, "") for k in OPTIONAL_SECRETS},` add `**{k: cfg.extra.get(k, "") for k in OPTIONAL_SETTINGS},`, and the extra check becomes `if key not in EXTRA_KEYS and key not in OPTIONAL_SETTINGS:`.

`sirdar/api/src/sirdar_api/deploy/certs.py`: `PUBLIC_SERVICES = ("api", "portal", "kiosk", "wiki", "learn", "status")`.

`sirdar/api/src/sirdar_api/deploy/smoke.py`:

```python
PATHS = {"api": "/healthz", "portal": "/", "kiosk": "/", "wiki": "/healthz", "learn": "/",
         "spaces": "/healthz", "status": "/healthz"}
```

`deploy/stack/env.example`: after `STACK_WIKI_PORT=8096` add `STACK_LEARN_PORT=8092`; after `SS_SMTP_PASSWORD=` add:

```
# comma-separated SHA-256 digests of the kiosk app's signing certificates (release
# and Play): kiosk biometric sign-in enrolls only apps signed with these
SS_KIOSK_SIGNING_DIGESTS=
```

- [ ] **Step 7: Run the focused tests to see them pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_stack_drift.py tests/test_deploy_envfile.py tests/test_deploy_apps.py tests/test_deploy_models.py tests/test_deploy_home.py -q`
Expected: PASS.

- [ ] **Step 8: Run the deploy tests that read env.example**

Run: `api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests/test_ss_stack.py deploy/tests/test_stack_config.py -q`
Expected: PASS.

- [ ] **Step 9: Run the covering Sirdar files**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest -q tests/test_deploy_apps.py tests/test_deploy_apps_api.py tests/test_deploy_envfile.py tests/test_deploy_environments_api.py tests/test_deploy_home.py tests/test_deploy_publish_steps.py tests/test_deploy_acme.py tests/test_deploy_models.py tests/test_deploy_playbooks.py tests/test_deploy_pipeline_first_admin.py tests/test_deploy_do_provision.py tests/test_deploy_publish.py tests/test_deploy_do_environments.py tests/test_deploy_pipeline_do.py tests/test_deploy_pipeline_lan.py tests/test_dashboard_flow.py tests/test_deploy_do_switch_and_remove.py tests/test_deploy_stack_drift.py`
Expected: PASS (712 + the new tests, about 9 minutes). A failure whose only cause is a hard-coded service or app list without `learn` (or a port map without `"learn": 8092`) gets the same edit as Step 2's list; anything else is a real bug — fix the code, not the test.

- [ ] **Step 10: Lint and commit**

Run: `sirdar/api/.venv/bin/ruff check sirdar/api/migrations/versions/0015_learn_and_editable_apps.py sirdar/api/src/sirdar_api/deploy/apps.py sirdar/api/src/sirdar_api/deploy/envfile.py sirdar/api/tests/test_deploy_stack_drift.py`
Expected: no new findings.

```bash
git add sirdar/api/migrations/versions/0015_learn_and_editable_apps.py sirdar/api/src/sirdar_api/db/models.py sirdar/api/src/sirdar_api/deploy/apps.py sirdar/api/src/sirdar_api/deploy/envfile.py sirdar/api/src/sirdar_api/deploy/certs.py sirdar/api/src/sirdar_api/deploy/smoke.py deploy/stack/env.example sirdar/api/tests
git commit -m "feat(sirdar): learn is an optional public app (port 8092, migration 0015 backfills its rows), STACK_LEARN_PORT and SS_KIOSK_SIGNING_DIGESTS in the .env, and drift tests against deploy/stack

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The learn-needs-wiki rule, signing digests at create, and adopt reads both

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/apps.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`create_new`, `_set_apps_and_mail`, `adopt`)
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py:122-123`
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`EnvironmentIn`, `create_environment`, imports)
- Modify tests: `sirdar/api/tests/test_deploy_apps.py`, `test_deploy_apps_api.py`, `test_deploy_environments_api.py:24-29`

**Interfaces:**
- Consumes: Task 4's `Environment.kiosk_signing_digests`, `apps.env_extra`.
- Produces: `apps.check_apps` raises `AppsError("learn_needs_wiki")`; `apps.check_digests(value) -> list[str]` (raises `AppsError("signing_digest_invalid", index=i)` for a bad entry, without `index` for a non-list); `environments.create_new(..., kiosk_signing_digests: list[str] | None = None)`; `environments._set_apps_and_mail(db, env, apps_on, mail_spec, digests: list[str] | None = None)`; `EnvironmentIn.kiosk_signing_digests`; environment JSON gains `"kiosk_signing_digests": [str]`; adopt reads `SS_KIOSK_SIGNING_DIGESTS` (bad: `adopt_value_invalid` with `key`); 422 `digests_not_allowed` for adopt with digests.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/test_deploy_apps.py`:

```python
def test_learn_needs_the_wiki():
    assert apps.check_apps(["learn", "wiki"]) == ["wiki", "learn"]
    with pytest.raises(apps.AppsError) as e:
        apps.check_apps(["learn", "kiosk"])
    assert e.value.code == "learn_needs_wiki"


def test_signing_digests_are_normalized_and_deduplicated():
    raw = " " + "AB:" * 31 + "AB "
    assert apps.check_digests([raw, "ab" * 32, "cd" * 32]) == ["ab" * 32, "cd" * 32]
    assert apps.check_digests(None) == [] and apps.check_digests([]) == []


@pytest.mark.parametrize("value, index", [
    (["ab" * 31], 0), (["ab" * 32, "zz" * 32], 1), (["ab" * 33], 0), ([""], 0),
])
def test_a_bad_signing_digest_names_its_place(value, index):
    with pytest.raises(apps.AppsError) as e:
        apps.check_digests(value)
    assert (e.value.code, e.value.extra) == ("signing_digest_invalid", {"index": index})


@pytest.mark.parametrize("value", ["ab" * 32, [1], {"a": "b"}])
def test_signing_digests_must_be_a_list_of_strings(value):
    with pytest.raises(apps.AppsError) as e:
        apps.check_digests(value)
    assert (e.value.code, e.value.extra) == ("signing_digest_invalid", {})
```

Append to `sirdar/api/tests/test_deploy_apps_api.py`:

```python
DIGEST = "ab" * 32


async def test_create_stores_the_signing_digests_and_renders_them(client, db, target,
                                                                  fake_runner):
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        **NEW, "kiosk_signing_digests": ["AB:" * 31 + "AB"]})
    assert resp.status_code == 201, resp.text
    assert resp.json()["kiosk_signing_digests"] == [DIGEST]
    dep = await client.post(f"{URL}/qa1/deployments", headers=h, json={"mode": "update"})
    await pipeline.wait(uuid.UUID(dep.json()["id"]))
    assert (await _render_values(fake_runner))["SS_KIOSK_SIGNING_DIGESTS"] == DIGEST


async def test_create_refuses_a_bad_digest_and_learn_without_the_wiki(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "kiosk_signing_digests": ["nope"]})
    assert (resp.status_code, resp.json()["detail"]) == (
        422, {"code": "signing_digest_invalid", "index": 0})
    resp = await client.post(URL, headers=h, json={**NEW, "apps": ["learn", "mailpit"]})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "learn_needs_wiki")


async def test_adopt_reads_learn_its_port_and_the_digests(client, db, target):
    resp = await _adopt(client, db, target, STACK_APPS="wiki,learn,mailpit",
                        STACK_LEARN_PORT="8192",
                        SS_KIOSK_SIGNING_DIGESTS=f"{DIGEST},{'cd' * 32}")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["apps"] == ["wiki", "learn", "mailpit"]
    learn = next(s for s in body["services"] if s["service"] == "learn")
    assert (learn["port"], learn["hostname"]) == (8192, "learn.uat.serversherpa.com")
    assert body["kiosk_signing_digests"] == [DIGEST, "cd" * 32]
    assert not {"STACK_LEARN_PORT", "SS_KIOSK_SIGNING_DIGESTS"} & set(body["ignored_keys"])


async def test_adopt_refuses_a_bad_digest(client, db, target):
    resp = await _adopt(client, db, target, SS_KIOSK_SIGNING_DIGESTS="nope")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {"code": "adopt_value_invalid",
                                     "key": "SS_KIOSK_SIGNING_DIGESTS"}


async def test_adopt_refuses_learn_without_the_wiki(client, db, target):
    resp = await _adopt(client, db, target, STACK_APPS="learn,mailpit")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "learn_needs_wiki")


async def test_adopt_takes_no_digests(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**ADOPT, "kiosk_signing_digests": [DIGEST]})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "digests_not_allowed")
```

In `sirdar/api/tests/test_deploy_environments_api.py`, add `"kiosk_signing_digests"` to `ENV_KEYS` (after `"mail"`).

- [ ] **Step 2: Run them to see them fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_apps.py tests/test_deploy_apps_api.py tests/test_deploy_environments_api.py -q`
Expected: FAIL — no `check_digests`, learn without wiki accepted, no `kiosk_signing_digests` in the output.

- [ ] **Step 3: Implement**

`sirdar/api/src/sirdar_api/deploy/apps.py` — after `_USER_RE` add `_DIGEST_RE = re.compile(r"[0-9a-f]{64}")`; `check_apps` becomes:

```python
def check_apps(value) -> list[str]:
    if value is None:
        return list(OPTIONAL_APPS)
    if (not isinstance(value, list) or not all(isinstance(a, str) for a in value)
            or set(value) - set(OPTIONAL_APPS)):
        raise AppsError("apps_invalid")
    if "learn" in value and "wiki" not in value:
        # learning documents render through the wiki container
        raise AppsError("learn_needs_wiki")
    return [a for a in OPTIONAL_APPS if a in value]


def check_digests(value) -> list[str]:
    """The kiosk app's signing certificate digests (SS_KIOSK_SIGNING_DIGESTS):
    each a SHA-256 as 64 hex characters, colons and case ignored; stored
    lowercase without colons, each once. None: none."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(d, str) for d in value):
        raise AppsError("signing_digest_invalid")
    digests: list[str] = []
    for index, raw in enumerate(value):
        digest = raw.strip().replace(":", "").lower()
        if not _DIGEST_RE.fullmatch(digest):
            raise AppsError("signing_digest_invalid", index=index)
        if digest not in digests:
            digests.append(digest)
    return digests
```

`sirdar/api/src/sirdar_api/deploy/environments.py`:

- `create_new` gains the keyword `kiosk_signing_digests: list[str] | None = None` (after `mail`), the docstring line `kiosk_signing_digests: the kiosk app's signing certificate digests (apps.check_digests).`, and its first `try` becomes:

```python
    try:
        apps_on = app_rules.check_apps(apps)
        mail_spec = app_rules.check_mail(mail, apps_on)
        digests = app_rules.check_digests(kiosk_signing_digests)
    except app_rules.AppsError as e:
        raise EnvError(e.code, **e.extra) from None
```

  and both `await _set_apps_and_mail(db, env, apps_on, mail_spec)` calls in `create_new` become `await _set_apps_and_mail(db, env, apps_on, mail_spec, digests)`.

- `_set_apps_and_mail` becomes:

```python
async def _set_apps_and_mail(db: AsyncSession, env: Environment, apps_on: list[str],
                             mail_spec: dict, digests: list[str] | None = None) -> None:
    env.apps = apps_on
    (env.smtp_host, env.smtp_port, env.smtp_username, env.smtp_from,
     env.smtp_starttls) = (mail_spec[k] for k in ("smtp_host", "smtp_port", "smtp_username",
                                                  "smtp_from", "smtp_starttls"))
    if digests is not None:
        env.kiosk_signing_digests = digests
    await db.flush()
```

- In `adopt`, after the `apps_on, mail_spec = app_rules.from_env(...)` try block, add:

```python
    try:
        digests = app_rules.check_digests(
            [d for d in values.get("SS_KIOSK_SIGNING_DIGESTS", "").split(",") if d.strip()])
    except app_rules.AppsError:
        raise EnvError("adopt_value_invalid", key="SS_KIOSK_SIGNING_DIGESTS") from None
```

  and its `await _set_apps_and_mail(db, env, apps_on, mail_spec)` becomes `await _set_apps_and_mail(db, env, apps_on, mail_spec, digests)`.

`sirdar/api/src/sirdar_api/deploy/serialize.py` — after the `"mail": …` line add `"kiosk_signing_digests": list(env.kiosk_signing_digests),`.

`sirdar/api/src/sirdar_api/api/routes/deploy.py`:
- `from typing import Literal` → `from typing import Annotated, Literal`.
- Add above `class EnvironmentIn`:

```python
# One kiosk signing digest as sent (apps.check_digests normalizes it).
Digest = Annotated[str, Field(max_length=200)]
```

- In `EnvironmentIn`, after `mail`:

```python
    # mode "new" only: the kiosk app's signing certificate digests (adopt reads
    # SS_KIOSK_SIGNING_DIGESTS from the .env)
    kiosk_signing_digests: list[Digest] | None = Field(default=None, max_length=10)
```

- In `create_environment`, after the `mail_not_allowed` check:

```python
    if body.mode == "adopt" and body.kiosk_signing_digests is not None:
        raise HTTPException(status_code=422, detail={"code": "digests_not_allowed"})
```

  and pass `kiosk_signing_digests=body.kiosk_signing_digests,` to `environments.create_new(...)` (after `mail=...`).

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_apps.py tests/test_deploy_apps_api.py tests/test_deploy_environments_api.py tests/test_deploy_do_environments.py -q`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `sirdar/api/.venv/bin/ruff check sirdar/api/src/sirdar_api/deploy/apps.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/api/routes/deploy.py`
Expected: no new findings.

```bash
git add sirdar/api/src/sirdar_api/deploy/apps.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_apps.py sirdar/api/tests/test_deploy_apps_api.py sirdar/api/tests/test_deploy_environments_api.py
git commit -m "feat(sirdar): learn needs the wiki; kiosk signing digests set at create and read on adopt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: PATCH apps, mail and digests; hostnames follow the apps

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`_hostname`, new `_mail_of`, `_update_apps_and_mail`, `update`)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`EnvironmentPatch`, `update_environment`)
- Create: `sirdar/api/tests/test_deploy_apps_edit_api.py`
- Modify: `sirdar/api/tests/test_deploy_publish_steps.py`

**Interfaces:**
- Consumes: Task 5's `check_apps` (learn rule), `check_digests`, `_set_apps_and_mail(…, digests)`.
- Produces: `EnvironmentPatch.apps: list[str] | None`, `.mail: MailIn | None`, `.kiosk_signing_digests: list[Digest] | None`; `environments.update()` returns change names `"apps"`, `"mail"`, `"secrets.SS_SMTP_PASSWORD"`, `"kiosk_signing_digests"`; refusals `learn_needs_wiki`, `apps_invalid`, `mailpit_required`, `mail_invalid`, `smtp_*_invalid`, `smtp_required_for_first_admin`, `signing_digest_invalid`, `deploy_in_progress`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_apps_edit_api.py`:

```python
"""PATCH apps, mail and the kiosk signing digests: checked as create checks
them, refused while a deploy runs, the public names rebuilt (envfile's list
on the LAN, the certificate's on DigitalOcean), and the next deploy renders
them."""

import uuid

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Deployment, Environment, EnvironmentSecret
from sirdar_api.deploy import environments, first_admins, pipeline

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    leak_guard,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import make_do_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_apps_api import NEW, SMTP_PASSWORD, URL, _render_values, target  # noqa: F401
from .test_deploy_deployments_api import LS, SHA

SMTP = {"mode": "smtp", "host": "smtp.example.com", "port": 587,
        "from_address": "ops@example.com"}
DIGEST = "ab" * 32
ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": "Correct-Horse-Battery-9"}


def _names(body) -> dict[str, str | None]:
    return {s["service"]: s["hostname"] for s in body["services"]}


async def _changes(db) -> list:
    return list(await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_update").order_by(AuditLog.id)))


async def test_apps_turned_off_lose_their_names_and_turned_on_get_them(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h,
                              json={"apps": ["kiosk", "status", "mailpit"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["apps"] == ["kiosk", "status", "mailpit"]
    assert _names(body) == {
        "api": "api.qa1.serversherpa.com", "portal": "portal.qa1.serversherpa.com",
        "home": "qa1.serversherpa.com", "kiosk": "kiosk.qa1.serversherpa.com", "wiki": None,
        "learn": None, "spaces": "spaces.qa1.serversherpa.com",
        "status": "status.qa1.serversherpa.com", "mailpit": None}
    resp = await client.patch(f"{URL}/qa1", headers=h, json={
        "apps": ["wiki", "kiosk", "learn", "status", "mailpit"]})
    names = _names(resp.json())
    assert (names["wiki"], names["learn"]) == ("wiki.qa1.serversherpa.com",
                                               "learn.qa1.serversherpa.com")
    assert await _changes(db) == [{"changed": ["apps"]}, {"changed": ["apps"]}]


@pytest.mark.parametrize("patch, code", [
    ({"apps": ["learn", "mailpit"]}, "learn_needs_wiki"),
    ({"apps": ["blog"]}, "apps_invalid"),
    ({"apps": ["wiki", "kiosk"]}, "mailpit_required"),
    ({"mail": {**SMTP, "host": "smtp example.com"}}, "smtp_host_invalid"),
    ({"kiosk_signing_digests": ["nope"]}, "signing_digest_invalid"),
])
async def test_create_rules_apply(client, db, target, patch, code):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h, json=patch)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code)
    env = await db.scalar(select(Environment).where(Environment.name == "qa1")
                          .execution_options(populate_existing=True))
    assert env.apps == ["wiki", "kiosk", "learn", "status", "mailpit"] and env.smtp_host is None


async def test_mailpit_off_with_smtp_in_the_same_patch(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h,
                              json={"apps": ["wiki", "kiosk"], "mail": SMTP})
    assert resp.status_code == 200, resp.text
    assert (resp.json()["apps"], resp.json()["mail"]["mode"]) == (["wiki", "kiosk"], "smtp")
    assert await _changes(db) == [{"changed": ["apps", "mail"]}]


async def test_back_to_mailpit_clears_smtp_and_its_password(client, db, target, leak_guard):
    leak_guard += [SMTP_PASSWORD]
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={**NEW, "mail": {**SMTP, "password": SMTP_PASSWORD}})
    resp = await client.patch(f"{URL}/qa1", headers=h, json={"mail": {"mode": "mailpit"}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["mail"] == {"mode": "mailpit", "host": None, "port": None,
                                   "username": None, "from_address": None, "starttls": True,
                                   "password_set": False}
    env = await db.scalar(select(Environment).where(Environment.name == "qa1")
                          .execution_options(populate_existing=True))
    assert (env.smtp_host, env.smtp_port, env.smtp_from) == (None, None, None)
    assert await db.get(EnvironmentSecret, (env.id, "SS_SMTP_PASSWORD")) is None
    assert await _changes(db) == [{"changed": ["mail", "secrets.SS_SMTP_PASSWORD"]}]


async def test_digests_are_normalized_and_kept(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h,
                              json={"kiosk_signing_digests": ["AB:" * 31 + "AB", DIGEST]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["kiosk_signing_digests"] == [DIGEST]
    assert await _changes(db) == [{"changed": ["kiosk_signing_digests"]}]
    resp = await client.patch(f"{URL}/qa1", headers=h, json={"kiosk_signing_digests": []})
    assert resp.json()["kiosk_signing_digests"] == []


async def test_nothing_changes_while_a_deploy_runs(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    env = await db.scalar(select(Environment).where(Environment.name == "qa1"))
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="running"))
    await db.commit()
    for patch in ({"apps": ["wiki", "mailpit"]}, {"mail": SMTP},
                  {"kiosk_signing_digests": [DIGEST]}):
        resp = await client.patch(f"{URL}/qa1", headers=h, json=patch)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "deploy_in_progress")


async def test_the_next_deploy_renders_the_new_apps_mail_and_digests(client, db, target,
                                                                     fake_runner, leak_guard):
    leak_guard += [SMTP_PASSWORD]
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h, json={
        "apps": ["wiki", "learn", "status"], "mail": {**SMTP, "password": SMTP_PASSWORD},
        "kiosk_signing_digests": [DIGEST]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["mail"]["password_set"] is True
    dep = await client.post(f"{URL}/qa1/deployments", headers=h, json={"mode": "update"})
    await pipeline.wait(uuid.UUID(dep.json()["id"]))
    values = await _render_values(fake_runner)
    assert (values["STACK_APPS"], values["SS_SMTP_HOST"], values["SS_SMTP_PASSWORD"],
            values["SS_KIOSK_SIGNING_DIGESTS"]) == (
        "wiki,learn,status", "smtp.example.com", SMTP_PASSWORD, DIGEST)


async def test_on_digitalocean_the_names_follow_the_certificate_list(db, secrets_key):
    env = await make_do_environment(db)
    changed = await environments.update(db, get_settings(), env,
                                        {"apps": ["kiosk", "status", "mailpit"]})
    assert changed == ["apps"]
    names = {r.service: r.hostname for r in await environments.services_of(db, env.id)}
    assert names == {
        "api": "api.uat9.serversherpa.com", "portal": "portal.uat9.serversherpa.com",
        "home": "uat9.serversherpa.com", "kiosk": "kiosk.uat9.serversherpa.com", "wiki": None,
        "learn": None, "spaces": None, "status": "status.uat9.serversherpa.com",
        "mailpit": None}
    await db.rollback()


async def test_production_keeps_smtp_while_its_first_admin_is_pending(db, secrets_key):
    env = await make_do_environment(db, name="prod", type_="production", account="production")
    settings = get_settings()
    assert await environments.update(db, settings, env, {"mail": SMTP}) == ["mail"]
    await first_admins.put(db, settings, env.id, first_admins.check(ADMIN))
    with pytest.raises(environments.EnvError) as e:
        await environments.update(db, settings, env, {"mail": {"mode": "mailpit"}})
    assert e.value.code == "smtp_required_for_first_admin"
    await db.rollback()
```

Append to `sirdar/api/tests/test_deploy_publish_steps.py` (add `from sirdar_api.deploy import environments` next to the `publish` import):

```python
async def test_an_app_turned_off_loses_its_dns_record_and_proxy_host(db, env, publish_fakes):
    await _run(db, env, "dns")
    await _run(db, env, "proxy")
    await environments.update(db, get_settings(), env, {"apps": ["kiosk", "status", "mailpit"]})
    await db.commit()
    await _run(db, env, "dns")
    await _run(db, env, "proxy")
    gone = {"wiki.uat2.serversherpa.com", "learn.uat2.serversherpa.com"}
    assert {r["name"] for r in publish_fakes.cf.records.values()} == set(NAMES) - gone
    assert {h["domain_names"][0] for h in publish_fakes.npm.hosts.values()} == set(NAMES) - gone
    rows = await db.scalars(select(ManagedRecord).execution_options(populate_existing=True))
    assert not {r.service for r in rows} & {"wiki", "learn"}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_apps_edit_api.py tests/test_deploy_publish_steps.py -q`
Expected: FAIL — PATCH ignores `apps`, `mail` and `kiosk_signing_digests` (no refusal, nothing changes).

- [ ] **Step 3: Implement in environments.py**

Replace `_hostname`:

```python
def _hostname(env: Environment, service: str, domain: str) -> str | None:
    """A service's public name: none for mailpit, nor for an app that is off.
    home is the base domain itself. On DigitalOcean the names are the ones
    its certificate covers (no spaces: objects live in Spaces)."""
    if service == home.HOME:
        return domain if home.wants_home(env) else None
    names = (certs.PUBLIC_SERVICES if env.target_id == targets.DO_TARGET
             else envfile.PUBLIC_SERVICES)
    return (f"{service}.{domain}" if service in names
            and app_rules.is_public(env, service) else None)
```

Add after `_set_apps_and_mail`:

```python
def _mail_of(env: Environment) -> dict:
    """The stored mail in create's shape (apps.check_mail checks it again)."""
    if not env.smtp_host:
        return {"mode": "mailpit"}
    return {"mode": "smtp", "host": env.smtp_host, "port": env.smtp_port,
            "username": env.smtp_username, "from_address": env.smtp_from,
            "starttls": env.smtp_starttls}


async def _update_apps_and_mail(db: AsyncSession, env: Environment, fields: dict,
                                changed: list[str]) -> tuple[bool, str | None]:
    """PATCH apps and mail, checked as create checks them: the apps given (or
    kept) against the mail given (or kept). Production keeps SMTP while its
    first admin is pending. Mailpit clears the SMTP columns and the SMTP
    password. Returns (whether the apps changed, an SMTP password to store)."""
    before_apps, before_mail = list(env.apps), _mail_of(env)
    try:
        apps_on = (app_rules.check_apps(fields["apps"]) if fields.get("apps") is not None
                   else before_apps)
        mail_spec = app_rules.check_mail(
            fields["mail"] if fields.get("mail") is not None else before_mail, apps_on)
    except app_rules.AppsError as e:
        raise EnvError(e.code, **e.extra) from None
    if (env.type == "production" and not mail_spec["smtp_host"]
            and await first_admins.pending(db, env.id)):
        raise EnvError("smtp_required_for_first_admin")
    await _set_apps_and_mail(db, env, apps_on, mail_spec)
    if apps_on != before_apps:
        changed.append("apps")
    if _mail_of(env) != before_mail:
        changed.append("mail")
    if not mail_spec["smtp_host"]:
        gone = await db.execute(delete(EnvironmentSecret).where(
            EnvironmentSecret.environment_id == env.id,
            EnvironmentSecret.key == "SS_SMTP_PASSWORD"))
        if gone.rowcount:
            changed.append("secrets.SS_SMTP_PASSWORD")
    return apps_on != before_apps, mail_spec["smtp_password"]
```

In `update()`:
- docstring becomes `"""Apply a PATCH: an absent or None field is kept. Only the optional secrets are editable ("" clears one). Apps and mail follow create's rules (an SMTP password in mail is stored as SS_SMTP_PASSWORD); a change of apps rebuilds the public names (home aside). Returns the changed names."""`
- Before `rows = {r.service: r for r in await services_of(db, env.id)}` insert:

```python
    apps_changed, smtp_password = False, None
    if fields.get("apps") is not None or fields.get("mail") is not None:
        apps_changed, smtp_password = await _update_apps_and_mail(db, env, fields, changed)
    if fields.get("kiosk_signing_digests") is not None:
        try:
            put("kiosk_signing_digests",
                app_rules.check_digests(fields["kiosk_signing_digests"]))
        except app_rules.AppsError as e:
            raise EnvError(e.code, **e.extra) from None
```

- Replace the hostname block:

```python
    if env.base_domain != old_domain or apps_changed:
        for service, row in rows.items():
            if service == home.HOME and env.base_domain == old_domain:
                continue                      # the bare name doesn't follow the apps
            row.hostname = _hostname(env, service, env.base_domain)
```

- Replace the first two secrets lines:

```python
    secrets = dict(fields.get("secrets") or {})
    check_optional_secrets(secrets)          # "" still clears one (below)
    if smtp_password and secrets.get("SS_SMTP_PASSWORD") is None:
        secrets["SS_SMTP_PASSWORD"] = smtp_password
```

- [ ] **Step 4: Implement in the route**

In `EnvironmentPatch`, after `do`:

```python
    # The optional apps it runs, where its mail goes (create's rules; the SMTP
    # password: mail.password or secrets.SS_SMTP_PASSWORD) and the kiosk signing
    # digests. Nothing runs now: the next deploy and publish apply them.
    apps: list[str] | None = None
    mail: MailIn | None = None
    kiosk_signing_digests: list[Digest] | None = Field(default=None, max_length=10)
```

In `update_environment`, after `fields.pop("confirm_name", None)`:

```python
    if body.mail is not None:
        fields["mail"] = body.mail.model_dump(exclude_none=True)   # as create reads it
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_apps_edit_api.py tests/test_deploy_publish_steps.py tests/test_deploy_environments_api.py tests/test_deploy_apps_api.py -q`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

Run: `sirdar/api/.venv/bin/ruff check sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_apps_edit_api.py`
Expected: no new findings.

```bash
git add sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_apps_edit_api.py sirdar/api/tests/test_deploy_publish_steps.py
git commit -m "feat(sirdar): apps, mail and kiosk signing digests can change after create; the public names follow the apps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: DigitalOcean replaces a certificate that covers names no longer served

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/do_provision.py:961-1007`
- Modify: `sirdar/api/tests/test_deploy_do_provision.py`

**Interfaces:**
- Consumes: Task 6 (an app turned off drops out of `certs.public_names(env)`).
- Produces: `_certificate` reissues when the best recorded certificate has a name outside `ctx.names`; log line `Certificate <name> also covers <names>, which this environment no longer serves; Sirdar replaces it.`

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/api/tests/test_deploy_do_provision.py` (add `Environment` to the `sirdar_api.db.models` import):

```python
async def test_a_certificate_with_a_name_no_longer_served_is_replaced_now(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (old,) = fake.certificates.values()
    old["dns_names"] = [*old["dns_names"], "blog.uat9.serversherpa.com"]
    await do_build.run()
    (new,) = fake.certificates.values()                 # the old one is retired
    assert new["id"] != old["id"] and "blog.uat9.serversherpa.com" not in new["dns_names"]
    assert (f"Certificate {old['name']} also covers blog.uat9.serversherpa.com, which this "
            "environment no longer serves; Sirdar replaces it.") in do_build.log()


async def test_turning_apps_off_replaces_the_certificate(db, do_build):
    await do_build.run()
    env = await db.get(Environment, do_build.env.id, populate_existing=True)
    env.apps = ["kiosk", "status", "mailpit"]
    await db.commit()
    await do_build.run()
    (new,) = do_build.cloud.do.certificates.values()
    assert not {"wiki.uat9.serversherpa.com", "learn.uat9.serversherpa.com"} & set(
        new["dns_names"])
    assert "kiosk.uat9.serversherpa.com" in new["dns_names"]
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_do_provision.py -q -k "no_longer_served or turning_apps_off"`
Expected: FAIL — the old certificate is kept ("valid until …").

- [ ] **Step 3: Implement**

In `_certificate`, the docstring's first line becomes `"""The certificate to serve (recorded; renewed at 14 days or fewer, or now when it lacks a wanted name or covers one no longer wanted).` and lines 998-1007 become:

```python
        # A certificate that lacks a wanted name (the bare name, an app turned
        # on after it was issued) or covers one no longer wanted (an app turned
        # off: is_ours wants the names exactly) is due now, not 14 days before
        # it expires.
        covered = set(best.get("dns_names") or []) if best else set()
        missing = sorted(set(ctx.names) - covered) if best else []
        extra = sorted(covered - set(ctx.names)) if best else []
        if (when is not None and not missing and not extra
                and certs.days_left(when, now) > certs.SIRDAR_RENEW_DAYS):
            out(f"Certificate {best['name']}: valid until {when:%Y-%m-%d}.\n")
        else:
            if missing:
                out(f"Certificate {best['name']} doesn't cover {', '.join(missing)}; "
                    "Sirdar replaces it.\n")
            if extra:
                out(f"Certificate {best['name']} also covers {', '.join(extra)}, which this "
                    "environment no longer serves; Sirdar replaces it.\n")
```

(the rest of the `else:` branch is unchanged).

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_do_provision.py tests/test_deploy_do_switch_and_remove.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/do_provision.py sirdar/api/tests/test_deploy_do_provision.py
git commit -m "fix(sirdar): a DigitalOcean certificate that covers an app turned off is replaced, so it stays exactly the environment's names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Step 20 Seed starter content

**Files:**
- Modify: `deploy/stack/ss-stack` (usage lines 17-19, `usage()` range, new `seed)` case)
- Modify: `deploy/tests/test_ss_stack.py`
- Create: `sirdar/api/src/sirdar_api/deploy/ansible/seed.yml`
- Modify: `sirdar/api/src/sirdar_api/deploy/steps.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py` (`plan_of`, `create_deployment`, `_prepare` step vars, the success branch, `SEED_FONT_NOTE`)
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py:42-59`
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (`DeploymentIn`, `_seed_requested`, `_launch`, `start_deployment`, `_start_do_update`, `_start_lan_update`, retry)
- Modify: `sirdar/api/tests/test_deploy_playbooks.py:72-75`
- Create: `sirdar/api/tests/test_deploy_pipeline_seed.py`

**Interfaces:**
- Consumes: Task 4's `Deployment.seed_content`.
- Produces: `ss-stack seed <env-dir> [--learning]`; `StepDef(20, "seed", "Seed starter content", "seed.yml", 20 * 60)`; `steps.plan_for(..., seed: bool = False)`; `pipeline.create_deployment(..., seed_content: bool = False)`; `pipeline.SEED_FONT_NOTE: str`; extravar `seed_learning: bool`; `DeploymentIn.seed_content: bool | None`; deployment JSON `"seed_content": bool`; 422 `seed_content_not_allowed`.

- [ ] **Step 1: Write the failing ss-stack tests**

Append to `deploy/tests/test_ss_stack.py`:

```python
@pytest.mark.parametrize("args, commands", [
    ((), ["seed-label-fonts", "seed-label-templates"]),
    (("--learning",), ["seed-label-fonts", "seed-label-templates", "learning-seed"]),
])
def test_seed_runs_the_starter_content_commands_in_the_api_container(
        env_dir: Path, fake: dict[str, str], args: tuple[str, ...], commands: list[str]) -> None:
    out = run(fake, "seed", str(env_dir), *args)
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, "api", f"exec -T api serversherpa {c}") for c in commands]


def test_seed_stops_at_the_first_failure_with_its_exit_code(env_dir: Path, fake: dict[str, str],
                                                            tmp_path: Path) -> None:
    docker = tmp_path / "bin" / "docker"
    docker.write_text("#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$DOCKER_LOG\"\n"
                      "[[ \"$*\" == *seed-label-fonts* ]] && exit 4\nexit 0\n")
    out = run(fake, "seed", str(env_dir), "--learning")
    assert out.returncode == 4
    assert calls(fake) == [dc(env_dir, "api", "exec -T api serversherpa seed-label-fonts")]


def test_seed_takes_only_learning(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "seed", str(env_dir), "--everything")
    assert out.returncode == 2
    assert calls(fake) == []
```

- [ ] **Step 2: Write the failing Sirdar tests**

In `sirdar/api/tests/test_deploy_playbooks.py` `test_plans`, the numbers list ends `…, 17, 18, 19, 20]`. Append after `test_first_admin_play_pipelines_so_the_password_never_lands_on_disk`:

```python
def _seed_vars(env_dir: Path, learning: bool) -> dict:
    return {**_common(env_dir), "seed_learning": learning}


@pytest.mark.parametrize("learning", [False, True])
def test_seed_playbook_runs_the_seed_commands_in_the_api_container(tmp_path, learning):
    env_dir, env = _target(tmp_path)
    result, calls = _play(tmp_path, "seed.yml", _seed_vars(env_dir, learning), env)
    assert result.returncode == 0, result.stdout + result.stderr
    wanted = ["seed-label-fonts", "seed-label-templates", *(["learning-seed"] if learning else [])]
    assert [c.split(" -f ")[-1] for c in calls if c.startswith("compose")] == [
        f"{env_dir}/repo/deploy/stack/api/compose.yml exec -T api serversherpa {cmd}"
        for cmd in wanted]


def test_seed_playbook_stops_at_the_first_failure_with_its_output(tmp_path):
    env_dir, env = _target(tmp_path)
    result, calls = _play(tmp_path, "seed.yml", _seed_vars(env_dir, True),
                          {**env, "FAKE_FAIL": "seed-label-templates"})
    out = result.stdout + result.stderr
    assert result.returncode != 0
    assert "Seeding stopped (exit 1)" in out and "fake failure" in out
    assert not any("learning-seed" in c for c in calls)


def test_seed_playbook_explains_an_old_checkout(tmp_path):
    env_dir, env = _target(tmp_path)
    old = tmp_path / "old-ss-stack"
    old.write_text("#!/bin/sh\nexit 2\n")
    old.chmod(0o755)
    result, calls = _play(tmp_path, "seed.yml",
                          {**_seed_vars(env_dir, False), "ss_stack": str(old)}, env)
    assert result.returncode != 0
    assert "This commit's ss-stack has no seed command" in result.stdout
    assert calls == []
```

Create `sirdar/api/tests/test_deploy_pipeline_seed.py`:

```python
"""Step 20 (Seed starter content): planned only for a first Update that
starts empty and asked for it, after everything else; the learning switch;
the font note; a failure fails step 20 and Retry runs it again; the deploy
route takes seed_content only for such an Update."""

import uuid

import pytest
from sqlalchemy import select

from sirdar_api.db.models import Deployment, Environment
from sirdar_api.deploy import pipeline, steps
from sirdar_api.deploy.runner import RunResult
from sirdar_api.deploy.steps import STEPS_BY_KEY, StepDef

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
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_apps_api import NEW, URL, target  # noqa: F401
from .test_deploy_deployments_api import LS
from .test_deploy_deployments_api import SHA as REMOTE_SHA
from .test_deploy_pipeline import SHA, _load


def _keys(**kw) -> list[str]:
    return [s.key for s in steps.plan_for("update", seed=True, **kw)]


def test_the_seed_step_ends_every_first_update_plan():
    assert STEPS_BY_KEY["seed"] == StepDef(20, "seed", "Seed starter content", "seed.yml",
                                           20 * 60)
    assert _keys()[-2:] == ["up", "seed"]
    assert _keys(publish=True, first_admin=True)[-6:] == [
        "up", "first_admin", "dns", "proxy", "smoke", "seed"]
    assert _keys(cloud=True, go_live=True, first_admin=True)[-6:] == [
        "up", "first_admin", "dns", "slot_smoke", "go_live", "seed"]
    assert _keys(vm=True, bluegreen=True, publish=True, go_live=True)[-5:] == [
        "up", "dns", "slot_smoke", "lan_switch", "seed"]
    for kw in ({"restore": True}, {}):
        mode = "update" if kw else "reset"
        with pytest.raises(ValueError):
            steps.plan_for(mode, seed=True, **kw)


@pytest.fixture
async def fresh(db, deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    return await make_environment(db, name="fresh", status="new")


async def _run(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, seed_content=True, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_step_20_runs_last_with_the_learning_switch_and_the_font_note(db, fresh,
                                                                            fake_runner):
    dep_id = await _run(db, fresh)
    dep, steps_, _ = await _load(dep_id)
    assert fake_runner.steps()[-2:] == ["up", "seed"]
    assert [s.number for s in steps_][-1] == 20
    assert (dep.status, dep.seed_content) == ("succeeded", True)
    request = next(r for r in fake_runner.requests if r.step == "seed")
    assert request.playbook == "seed.yml"
    assert request.extravars["seed_learning"] is True
    assert steps_[-1].log.endswith(pipeline.SEED_FONT_NOTE)


async def test_without_learn_there_is_no_learning_seed(db, fresh, fake_runner):
    fresh.apps = ["wiki", "kiosk", "status", "mailpit"]
    await db.commit()
    await _run(db, fresh)
    request = next(r for r in fake_runner.requests if r.step == "seed")
    assert request.extravars["seed_learning"] is False


async def test_a_failed_seed_fails_step_20_and_a_retry_runs_only_it(db, fresh, fake_runner):
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    dep_id = await _run(db, fresh)
    dep, steps_, _ = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 20)
    assert [s.status for s in steps_ if s.key == "up"] == ["succeeded"]
    del fake_runner.results["seed"]
    fake_runner.requests.clear()
    env = await db.get(Environment, fresh.id, populate_existing=True)
    retry = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                             actor_id=None, start_step=20, retry_of=dep_id,
                                             seed_content=True)
    await db.commit()
    pipeline.launch(retry.id)
    await pipeline.wait(retry.id)
    assert fake_runner.steps() == ["seed"]
    assert (await _load(retry.id))[0].status == "succeeded"


async def test_the_route_seeds_a_first_empty_update_and_retry_keeps_it(client, db, target,
                                                                       fake_runner):
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{REMOTE_SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    resp = await client.post(f"{URL}/qa1/deployments", headers=h,
                             json={"mode": "update", "seed_content": True})
    assert resp.status_code == 201, resp.text
    dep_id = uuid.UUID(resp.json()["id"])
    await pipeline.wait(dep_id)
    body = (await client.get(f"/api/deploy/deployments/{dep_id}", headers=h)).json()
    assert (body["seed_content"], body["steps"][-1]["key"], body["failed_step"]) == (
        True, "seed", 20)
    del fake_runner.results["seed"]
    resp = await client.post(f"/api/deploy/deployments/{dep_id}/retry", headers=h, json={})
    assert resp.status_code == 201, resp.text
    retry_id = uuid.UUID(resp.json()["id"])
    await pipeline.wait(retry_id)
    retry = await db.get(Deployment, retry_id, populate_existing=True)
    assert (retry.seed_content, retry.status) == (True, "succeeded")
    assert fake_runner.steps()[-1] == "seed"


async def test_seed_content_only_for_a_first_update(client, db, target):
    await trust_fake(db, target)
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.post(f"{URL}/qa1/deployments", headers=h, json={
        "mode": "reset", "confirm_name": "qa1", "seed_content": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "seed_content_not_allowed")
    env = await db.scalar(select(Environment).where(Environment.name == "qa1"))
    env.current_sha = REMOTE_SHA
    await db.commit()
    resp = await client.post(f"{URL}/qa1/deployments", headers=h,
                             json={"mode": "update", "seed_content": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "seed_content_not_allowed")
```

- [ ] **Step 3: Run them to see them fail**

Run: `api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests/test_ss_stack.py -q -k seed`
Expected: FAIL — `seed` prints usage (exit 2).

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_pipeline_seed.py tests/test_deploy_playbooks.py -q`
Expected: FAIL — no step `seed`, no `seed.yml`.

- [ ] **Step 4: Implement ss-stack seed**

In the header usage block, after the two `ss-stack admin` lines (17-18) add:

```bash
#   ss-stack seed    <env-dir> [--learning] starter content in the running api container: label
#                                           fonts and templates (--learning: the Learning space too)
```

change `usage()` to `sed -n '6,20p'`, and add before the `*)` case:

```bash
  seed)
    # Starter content (Sirdar's step 20): label fonts and templates and, with
    # --learning, the wiki Learning space. Each command is idempotent; the
    # first that fails stops here with its exit code.
    learning=0
    if [[ ${1:-} == --learning ]]; then learning=1; shift; fi
    [[ $# -eq 0 ]] || usage
    dc api exec -T api serversherpa seed-label-fonts
    dc api exec -T api serversherpa seed-label-templates
    if (( learning )); then dc api exec -T api serversherpa learning-seed; fi
    ;;
```

- [ ] **Step 5: Implement the playbook and the step**

Create `sirdar/api/src/sirdar_api/deploy/ansible/seed.yml`:

```yaml
# Step 20 — Seed starter content: a first deploy that starts empty (and asked
# for it) loads the label builder's fonts and templates and, when the learning
# site and the wiki run, the sample learning documents, with `ss-stack seed`
# in its api container. Each command is idempotent, so Retry runs the whole
# step again. On a failure the step's log ends with the commands' last lines.
- name: Seed starter content
  hosts: target
  gather_facts: false
  tasks:
    - name: Does this checkout's ss-stack have the seed command?
      ansible.builtin.command:
        argv: [grep, -q, "^  seed)", "{{ ss_stack }}"]
      register: knows_seed
      changed_when: false
      failed_when: false

    - name: Stop when it doesn't
      ansible.builtin.fail:
        msg: >-
          This commit's ss-stack has no seed command, so Sirdar can't seed starter
          content. Deploy a newer commit.
      when: knows_seed.rc != 0

    - name: ss-stack seed
      ansible.builtin.command:
        argv: >-
          {{ [ss_stack, 'seed', env_dir] + (['--learning'] if seed_learning | bool else []) }}
      register: seeded
      changed_when: seeded.rc == 0
      failed_when: false

    - name: What the seed commands printed
      ansible.builtin.debug:
        msg: "{{ seeded.stdout_lines | default([]) }}"
      when: seeded.rc == 0

    - name: Stop when a seed command failed
      ansible.builtin.fail:
        msg: >-
          Seeding stopped (exit {{ seeded.rc }}). Its last lines:
          {{ ((seeded.stdout_lines | default([])) + (seeded.stderr_lines | default([])))[-20:]
             | join(' / ') }}
      when: seeded.rc != 0
```

`sirdar/api/src/sirdar_api/deploy/steps.py`:
- Docstring: after the `19 Renew certificate …` sentence add the paragraph:

```
20 Seed starter content (seed.yml: `ss-stack seed`, label fonts and
templates, and the Learning space when learn runs) ends a first Update that
starts empty and asked for it (deployments.seed_content). Step numbers are
unique in a plan and 11–19 are taken, so it runs last: after Create the first
admin and after any publish, slot smoke test or switch.
```

- In `STEPS`, after the `do_renew` entry: `    StepDef(20, "seed", "Seed starter content", "seed.yml", 20 * 60),`
- After `_with_first_admin` add:

```python
def _with_seed(keys: tuple[str, ...], seed: bool) -> tuple[str, ...]:
    """Step 20 last: every earlier step has a lower number."""
    return (*keys, "seed") if seed else keys
```

- `plan_for` gains `seed: bool = False` (after `bluegreen`) and becomes:

```python
def plan_for(mode: str, *, restore: bool = False, publish: bool = False, vm: bool = False,
             cloud: bool = False, go_live: bool = False, snapshot: bool = False,
             smoke: bool = True, first_admin: bool = False,
             bluegreen: bool = False, seed: bool = False) -> list[StepDef]:
    if first_admin and (mode != "update" or restore):
        raise ValueError("only an Update that starts empty creates the first admin")
    if seed and (mode != "update" or restore):
        raise ValueError("only an Update that starts empty seeds starter content")
    if bluegreen:
        if not vm or cloud:
            raise ValueError("a LAN Blue/Green plan is a VM plan")
        if not smoke:
            raise ValueError("only Deactivate skips the slot smoke test")
        keys = _bg_plan(mode, restore=restore, publish=publish, go_live=go_live,
                        snapshot=snapshot)
        if first_admin:
            keys = _with_first_admin(keys)
        return [STEPS_BY_KEY[k] for k in _with_seed(keys, seed)]
    if cloud:
        keys = _cloud_plan(mode, restore=restore, publish=publish, vm=vm, go_live=go_live,
                           snapshot=snapshot, smoke=smoke)
        if first_admin:
            keys = _with_first_admin(keys)
        return [STEPS_BY_KEY[k] for k in _with_seed(keys, seed)]
```

  and, at the end of the function, the last two lines become:

```python
    if first_admin:
        keys = _with_first_admin(keys)
    return [STEPS_BY_KEY[k] for k in _with_seed(keys, seed)]
```

- [ ] **Step 6: Implement the pipeline**

`sirdar/api/src/sirdar_api/deploy/pipeline.py`:
- Near the other copy constants (e.g. after `KEPT_DUMP`), add:

```python
# Step 20's log ends with this on success: the one font no seed can fetch.
SEED_FONT_NOTE = ("Zebra's TT0003M_.TTF isn't seeded: upload it by hand in the portal "
                  "(Label builder › Fonts).\n")
```

- `plan_of` passes `seed=dep.seed_content`.
- `create_deployment` gains `seed_content: bool = False` (after `bluegreen`), the docstring paragraph `seed_content: its plan ends with step 20 Seed starter content (an Update that starts empty).`, passes `seed=seed_content` to its `plan_for(...)` call and `seed_content=seed_content` to `Deployment(...)`.
- In `_prepare`, after the `if dep.bluegreen: step_vars["dump"] = …` block:

```python
    # Step 20: the Learning space only where the learning site and the wiki run.
    step_vars["seed"] = {"seed_learning": "learn" in env.apps and "wiki" in env.apps}
```

- In `_run`'s success chain, after the `elif step.key == "first_admin":` branch (before `elif step.key == "restore":`):

```python
                    elif step.key == "seed":
                        await db.execute(
                            update(DeploymentStep).where(DeploymentStep.id == step.id)
                            .values(log=DeploymentStep.log + SEED_FONT_NOTE))
```

`sirdar/api/src/sirdar_api/deploy/serialize.py` — in `deployment_summary`, after `"first_admin": dep.first_admin,` add `"seed_content": dep.seed_content,`.

- [ ] **Step 7: Implement the routes**

`sirdar/api/src/sirdar_api/api/routes/deploy.py`:
- `DeploymentIn`, after `confirm_production`:

```python
    # A first Update that starts empty: end with step 20 Seed starter content.
    seed_content: bool | None = None
```

- After `_refuse` (line ~1287) add:

```python
def _seed_requested(body: DeploymentIn, *, first: bool, snapshot) -> bool:
    """seed_content: only a first Update that restores no snapshot seeds."""
    if not body.seed_content:
        return False
    if body.mode != "update" or not first or snapshot is not None:
        raise _refuse(422, "seed_content_not_allowed")
    return True
```

- `_launch` gains `seed_content: bool = False` (after `bluegreen`) and passes `seed_content=seed_content` to `pipeline.create_deployment(...)`.
- `start_deployment`: after `_require_mode(actor, body.mode)` add:

```python
    if body.seed_content and body.mode != "update":
        raise _refuse(422, "seed_content_not_allowed")
```

  and its final `_launch(...)` call adds `seed_content=_seed_requested(body, first=env.current_sha is None, snapshot=snapshot),` — compute it into a local `seed = _seed_requested(...)` right after the `snapshot` block (before `ref = body.git_ref or env.git_ref`) so a refusal comes before the ref lookup, and pass `seed_content=seed`.
- `_start_do_update`: after the `snapshot` block, `seed = _seed_requested(body, first=not await _do_ran(db, env), snapshot=snapshot)`; pass `seed_content=seed` to `_launch`.
- `_start_lan_update`: after the `snapshot` block, `seed = _seed_requested(body, first=not await lan_slots.ran(db, env), snapshot=snapshot)`; pass `seed_content=seed`.
- Retry route: its `plan_for(...)` call adds `seed=dep.seed_content`, and its `_launch(...)` adds `seed_content=dep.seed_content`.

- [ ] **Step 8: Run the tests to see them pass**

Run: `api/.venv/bin/python -m pytest -c deploy/pytest.ini deploy/tests/test_ss_stack.py -q`
Expected: PASS.

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_learn .venv/bin/python -m pytest tests/test_deploy_pipeline_seed.py tests/test_deploy_playbooks.py tests/test_deploy_pipeline_first_admin.py tests/test_deploy_pipeline.py tests/test_deploy_deployments_api.py tests/test_deploy_pipeline_do.py tests/test_deploy_pipeline_lan.py -q`
Expected: PASS.

- [ ] **Step 9: Lint and commit**

Run: `sirdar/api/.venv/bin/ruff check sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_pipeline_seed.py`
Expected: no new findings.

```bash
git add deploy/stack/ss-stack deploy/tests/test_ss_stack.py sirdar/api/src/sirdar_api/deploy/ansible/seed.yml sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_playbooks.py sirdar/api/tests/test_deploy_pipeline_seed.py
git commit -m "feat(sirdar): step 20 seeds starter content on an empty first deploy (ss-stack seed: label fonts and templates, and the Learning space when learn runs)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web — shared apps and mail controls, Learning in the Extras step, digests, Data step seed option

**Files:**
- Create: `sirdar/web/src/lib/appRules.ts`, `sirdar/web/src/lib/appRules.test.ts`
- Create: `sirdar/web/src/components/AppsMail.tsx`
- Modify: `sirdar/web/src/lib/sirdarApi.ts` (types at 520-528, 565-593, 655-698; `MESSAGES` at 370-384)
- Modify: `sirdar/web/src/pages/deploy/flowState.ts`
- Modify: `sirdar/web/src/pages/deploy/flowFixtures.ts:9`
- Modify: `sirdar/web/src/pages/deploy/DeployFlow.tsx:82-85`
- Modify: `sirdar/web/src/pages/deploy/steps/ExtrasStep.tsx`, `steps/DataStep.tsx`
- Modify: `sirdar/web/src/pages/environments/testData.ts` (`ENV`, `DEFAULTS`)
- Modify tests: `steps/ExtrasStep.test.tsx`, `steps/DataStep.test.tsx`, `flowState.test.ts`, `DeployFlow.test.tsx:145`

**Interfaces:**
- Consumes: Task 5/6/8 API shapes (`kiosk_signing_digests`, `learn_needs_wiki`, `signing_digest_invalid`, `seed_content`).
- Produces (`lib/appRules.ts`): `type OptionalApp = 'wiki' | 'kiosk' | 'learn' | 'status' | 'mailpit'`; `OPTIONAL_APPS: [OptionalApp, string][]`; `type AppSwitches = Record<OptionalApp, boolean>`; `interface MailForm { mailMode; smtpHost; smtpPort; smtpUsername; smtpPassword; smtpFrom; smtpStarttls }`; `interface AppsMailForm extends MailForm { apps: AppSwitches }`; `LEARN_NEEDS_WIKI`; `SECRET_RE`; `SECRET_HELP`; `DIGEST_HELP`; `switchApp(form, app, on): Partial<AppsMailForm>`; `appsOn(apps): OptionalApp[]`; `appsProblem(form): string`; `mailProblem(form): string`; `mailBody(form, withPassword?): NewMail`; `parseDigests(text): { digests: string[]; problem: string }`; `formOfEnv(apps: string[], mail: EnvMail, digests: string[] | undefined, smtpPort: number): AppsMailForm & { digests: string }`. (`components/AppsMail.tsx`): `Toggle`, `Field`, `Segmented`, `AppToggles`, `MailFields`, `DigestsField`. `FlowState` gains `digests: string`, `seedContent: boolean`; `Field` union gains `'digests'`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/lib/appRules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  LEARN_NEEDS_WIKI, OPTIONAL_APPS, appsOn, appsProblem, formOfEnv, mailBody, mailProblem, parseDigests, switchApp,
  type AppsMailForm,
} from './appRules';

const base: AppsMailForm = {
  apps: { wiki: true, kiosk: true, learn: true, status: true, mailpit: true },
  mailMode: 'mailpit', smtpHost: '', smtpPort: '587', smtpUsername: '', smtpPassword: '', smtpFrom: '', smtpStarttls: true,
};

describe('apps', () => {
  it('lists Learning between Kiosk and Status page', () => {
    expect(OPTIONAL_APPS.map(([, l]) => l)).toEqual(['Wiki', 'Kiosk', 'Learning', 'Status page', 'Mailpit']);
  });
  it('the learning site goes off with the wiki; Mailpit off moves mail to SMTP', () => {
    expect(switchApp(base, 'wiki', false)).toEqual({ apps: { ...base.apps, wiki: false, learn: false } });
    expect(switchApp(base, 'mailpit', false)).toEqual({ apps: { ...base.apps, mailpit: false }, mailMode: 'smtp' });
    expect(switchApp(base, 'kiosk', false)).toEqual({ apps: { ...base.apps, kiosk: false } });
  });
  it('appsOn keeps the canonical order; appsProblem mirrors the API', () => {
    expect(appsOn({ ...base.apps, kiosk: false })).toEqual(['wiki', 'learn', 'status', 'mailpit']);
    expect(appsProblem({ ...base, apps: { ...base.apps, wiki: false } })).toBe(LEARN_NEEDS_WIKI);
    expect(appsProblem({ ...base, apps: { ...base.apps, mailpit: false } }))
      .toBe('Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.');
    expect(appsProblem(base)).toBe('');
  });
});

describe('mail', () => {
  const smtp = { ...base, mailMode: 'smtp' as const, smtpHost: 'smtp.example.com', smtpFrom: 'ops@example.com' };
  it('checks SMTP as the API does', () => {
    expect(mailProblem({ ...smtp, smtpHost: 'smtp example.com' })).toBe("Enter the SMTP server's host name or address.");
    expect(mailProblem({ ...smtp, smtpPort: '70000' })).toBe('Use an SMTP port from 1 to 65535.');
    expect(mailProblem(smtp)).toBe('');
  });
  it('builds the body, with or without the password', () => {
    expect(mailBody(base)).toEqual({ mode: 'mailpit' });
    expect(mailBody({ ...smtp, smtpPassword: 'pw-1' })).toEqual({
      mode: 'smtp', host: 'smtp.example.com', port: 587, password: 'pw-1', from_address: 'ops@example.com', starttls: true });
    expect(mailBody({ ...smtp, smtpPassword: 'pw-1' }, false)).not.toHaveProperty('password');
  });
  it('formOfEnv reads an environment back', () => {
    const f = formOfEnv(['wiki', 'mailpit'], {
      mode: 'smtp', host: 'smtp.example.com', port: 2525, username: null, from_address: 'ops@example.com',
      starttls: false, password_set: true,
    }, ['ab'.repeat(32)], 587);
    expect(f.apps).toEqual({ wiki: true, kiosk: false, learn: false, status: false, mailpit: true });
    expect([f.mailMode, f.smtpPort, f.smtpStarttls, f.digests]).toEqual(['smtp', '2525', false, 'ab'.repeat(32)]);
  });
});

describe('digests', () => {
  it('splits on lines, commas and spaces, drops colons, lowercases, keeps each once', () => {
    const d = 'AB:'.repeat(31) + 'AB';
    expect(parseDigests(`${d}\n${'ab'.repeat(32)}, ${'cd'.repeat(32)}`))
      .toEqual({ digests: ['ab'.repeat(32), 'cd'.repeat(32)], problem: '' });
    expect(parseDigests('  ')).toEqual({ digests: [], problem: '' });
    expect(parseDigests('nope').problem).toBe('Each digest is a SHA-256: 64 hex characters, colons allowed.');
  });
});
```

`sirdar/web/src/pages/deploy/steps/ExtrasStep.test.tsx` — replace the first two tests with:

```tsx
it('apps: API and Portal always, five switches; the wiki takes learning with it', async () => {
  const set = renderStep();
  expect(screen.getByText('API and Portal always run.')).toBeTruthy();
  for (const label of ['Wiki', 'Kiosk', 'Learning', 'Status page', 'Mailpit']) expect(screen.getByLabelText(label)).toBeTruthy();
  await userEvent.click(screen.getByLabelText('Wiki'));
  expect(set).toHaveBeenCalledWith({ apps: { wiki: false, kiosk: true, learn: false, status: true, mailpit: true } });
});

it('turning Mailpit off switches mail to SMTP', async () => {
  const set = renderStep();
  await userEvent.click(screen.getByLabelText('Mailpit'));
  expect(set).toHaveBeenCalledWith({ apps: { wiki: true, kiosk: true, learn: true, status: true, mailpit: false }, mailMode: 'smtp' });
});

it('Learning is locked while the wiki is off, and says why', () => {
  renderStep({ apps: { wiki: false, kiosk: true, learn: false, status: true, mailpit: true } });
  expect((screen.getByLabelText('Learning') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText('The learning site needs the wiki, so it is off while the wiki is.')).toBeTruthy();
});

it('the kiosk signing digests show with the kiosk', async () => {
  const set = renderStep();
  await userEvent.type(screen.getByLabelText('Kiosk signing digests'), 'a');
  expect(set).toHaveBeenLastCalledWith({ digests: 'a' });
  cleanup();
  renderStep({ apps: { wiki: true, kiosk: false, learn: true, status: true, mailpit: true } });
  expect(screen.queryByLabelText('Kiosk signing digests')).toBeNull();
});
```

and in 'with Mailpit off, SMTP is required…' the apps object gains `learn: true`.

`sirdar/web/src/pages/deploy/steps/DataStep.test.tsx` — append (reuse the file's existing render helper; if it is named differently than `renderStep`, use that name and its `set` return):

```tsx
it('starting empty offers Seed starter content, on by default', async () => {
  const set = renderStep();
  const toggle = screen.getByLabelText('Seed starter content') as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(screen.getByText(/Zebra's TT0003M_\.TTF still goes in by hand \(Label builder › Fonts\)/)).toBeTruthy();
  await userEvent.click(toggle);
  expect(set).toHaveBeenCalledWith({ seedContent: false });
});

it('a snapshot has nothing to seed', () => {
  renderStep({ dataMode: 'snapshot' });
  expect(screen.queryByLabelText('Seed starter content')).toBeNull();
});
```

`sirdar/web/src/pages/deploy/flowState.test.ts` — append:

```ts
describe('learn, digests and seeding', () => {
  it('learning without the wiki is an Extras error; a bad digest too', () => {
    const ctx = flowCtx();
    expect(stepErrors('extras', ssh({ apps: { wiki: false, kiosk: true, learn: true, status: true, mailpit: true } }), ctx).apps)
      .toBe('The learning site needs the wiki: turn the wiki on, or turn learning off.');
    expect(stepErrors('extras', ssh({ digests: 'nope' }), ctx).digests)
      .toBe('Each digest is a SHA-256: 64 hex characters, colons allowed.');
    expect(stepOfCode('learn_needs_wiki')).toBe('extras');
    expect(stepOfCode('signing_digest_invalid')).toBe('extras');
  });
  it('the body carries learn and the digests', () => {
    const body = buildBody(ssh({ digests: 'AB:'.repeat(31) + 'AB' }), flowCtx());
    expect(body.apps).toEqual(['wiki', 'kiosk', 'learn', 'status', 'mailpit']);
    expect(body.kiosk_signing_digests).toEqual(['ab'.repeat(32)]);
    expect(buildBody(ssh(), flowCtx())).not.toHaveProperty('kiosk_signing_digests');
  });
  it('starts with every app on and seeding on', () => {
    const s = initialState(flowCtx());
    expect(s.apps.learn && s.seedContent).toBe(true);
    expect(s.digests).toBe('');
  });
});
```

(`ssh(...)`, `flowCtx`, `stepErrors`, `buildBody`, `stepOfCode`, `initialState` are the file's existing helpers/imports; add any of these four functions missing from its import line.)

`sirdar/web/src/pages/deploy/DeployFlow.test.tsx` line 145 becomes `expect(api.startDeployment).toHaveBeenCalledWith('qa', { mode: 'update', seed_content: true });`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd sirdar/web && npx vitest run src/lib/appRules.test.ts src/pages/deploy`
Expected: FAIL — `./appRules` doesn't exist; no Learning switch; no seed option.

- [ ] **Step 3: Write lib/appRules.ts**

```ts
/** The optional apps, mail and kiosk signing digests, shared by the Deploy
 *  flow's Extras step and an environment's Settings › Apps & mail: the API's
 *  rules mirrored (apps.check_apps, check_mail, check_digests) so a form can
 *  answer before a round trip; the API stays the authority. Pure: no React, no I/O. */
import type { EnvMail, NewMail } from './sirdarApi';

export type OptionalApp = 'wiki' | 'kiosk' | 'learn' | 'status' | 'mailpit';
export const OPTIONAL_APPS: [OptionalApp, string][] = [
  ['wiki', 'Wiki'], ['kiosk', 'Kiosk'], ['learn', 'Learning'], ['status', 'Status page'], ['mailpit', 'Mailpit'],
];
export type AppSwitches = Record<OptionalApp, boolean>;
export interface MailForm {
  mailMode: 'mailpit' | 'smtp'; smtpHost: string; smtpPort: string; smtpUsername: string; smtpPassword: string;
  smtpFrom: string; smtpStarttls: boolean;
}
export interface AppsMailForm extends MailForm { apps: AppSwitches }

export const LEARN_NEEDS_WIKI = 'The learning site needs the wiki: turn the wiki on, or turn learning off.';
const MAILPIT_REQUIRED = 'Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.';
export const DIGEST_HELP = 'Each digest is a SHA-256: 64 hex characters, colons allowed.';

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}$/;
const USER_RE = /^[^\s"'$#`\\]{1,254}$/;
/** envfile.SECRET_VALUE_RE: what an optional secret in the .env may hold. */
export const SECRET_RE = /^[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}$/;
export const SECRET_HELP = "can't be saved. Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes.";
/** Control characters and line/paragraph separators. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f  ]/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const whole = (raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw) : NaN);

/** One switch flipped, with the rules it brings: the learning site goes off
 *  with the wiki, and mail moves to SMTP when Mailpit goes off. */
export function switchApp(form: Pick<AppsMailForm, 'apps' | 'mailMode'>, app: OptionalApp, on: boolean): Partial<AppsMailForm> {
  const apps = { ...form.apps, [app]: on };
  if (app === 'wiki' && !on) apps.learn = false;
  return app === 'mailpit' && !on && form.mailMode === 'mailpit' ? { apps, mailMode: 'smtp' } : { apps };
}

export const appsOn = (apps: AppSwitches): OptionalApp[] => OPTIONAL_APPS.map(([a]) => a).filter((a) => apps[a]);

export function appsProblem(form: Pick<AppsMailForm, 'apps' | 'mailMode'>): string {
  if (form.apps.learn && !form.apps.wiki) return LEARN_NEEDS_WIKI;
  if (form.mailMode === 'mailpit' && !form.apps.mailpit) return MAILPIT_REQUIRED;
  return '';
}

/** SMTP's fields as the API checks them ('' when it would accept them). */
export function mailProblem(f: MailForm): string {
  const port = whole(f.smtpPort);
  return !HOST_RE.test(f.smtpHost.trim()) ? "Enter the SMTP server's host name or address."
    : !(port >= 1 && port <= 65535) ? 'Use an SMTP port from 1 to 65535.'
    : f.smtpUsername && !USER_RE.test(f.smtpUsername) ? "That SMTP user name can't be used: no spaces, quotes, $, # or backslashes."
    : f.smtpPassword && !SECRET_RE.test(f.smtpPassword) ? `That SMTP password ${SECRET_HELP}`
    : !EMAIL_RE.test(f.smtpFrom.trim()) || !USER_RE.test(f.smtpFrom.trim()) || CONTROL_RE.test(f.smtpFrom)
      ? 'Enter the address mail is sent from, like noreply@example.com.' : '';
}

/** The API's `mail`: Mailpit, or the SMTP server (the password only when asked for and typed). */
export function mailBody(f: MailForm, withPassword = true): NewMail {
  return f.mailMode === 'smtp'
    ? { mode: 'smtp', host: f.smtpHost.trim(), port: Number(f.smtpPort), ...(f.smtpUsername ? { username: f.smtpUsername } : {}),
        ...(withPassword && f.smtpPassword ? { password: f.smtpPassword } : {}), from_address: f.smtpFrom.trim(),
        starttls: f.smtpStarttls }
    : { mode: 'mailpit' };
}

/** The kiosk signing digests typed one per line (commas and spaces work too). */
export function parseDigests(text: string): { digests: string[]; problem: string } {
  const digests: string[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const d = raw.replace(/:/g, '').toLowerCase();
    if (!DIGEST_RE.test(d)) return { digests: [], problem: DIGEST_HELP };
    if (!digests.includes(d)) digests.push(d);
  }
  return { digests, problem: '' };
}

/** An environment's stored apps, mail and digests as the form holds them. */
export function formOfEnv(apps: string[], mail: EnvMail, digests: string[] | undefined, smtpPort: number)
  : AppsMailForm & { digests: string } {
  return {
    apps: Object.fromEntries(OPTIONAL_APPS.map(([a]) => [a, apps.includes(a)])) as AppSwitches,
    mailMode: mail.mode, smtpHost: mail.host ?? '', smtpPort: String(mail.port ?? smtpPort),
    smtpUsername: mail.username ?? '', smtpPassword: '', smtpFrom: mail.from_address ?? '', smtpStarttls: mail.starttls,
    digests: (digests ?? []).join('\n'),
  };
}
```

- [ ] **Step 4: Write components/AppsMail.tsx**

```tsx
/** The optional apps, mail and kiosk signing digests: the Deploy flow's Extras
 *  step and an environment's Settings › Apps & mail share these controls
 *  (lib/appRules.ts holds the rules). */
import { Switch } from '@portal/components/Switch';

import { arrowNav } from '../lib/arrowNav';
import { OPTIONAL_APPS, switchApp, type AppsMailForm } from '../lib/appRules';

export function Toggle({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="sirdar-toggle-row">
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

export function Field({ id, label, value, onChange, type = 'text', hint, inputMode, errorId, disabled }: {
  id: string; label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string;
  inputMode?: 'numeric';
  /** The id of the error this field shares, when there is one: marks it invalid and describes it. */
  errorId?: string;
  disabled?: boolean;
}) {
  const described = [hint ? `${id}-hint` : '', errorId ?? ''].filter(Boolean).join(' ');
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} autoComplete={type === 'password' ? 'new-password' : 'off'}
             inputMode={inputMode} spellCheck={false} disabled={disabled} aria-invalid={errorId ? true : undefined}
             aria-describedby={described || undefined} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string | boolean>({ id, caption, value, options, onPick, locked, disabled }: {
  id: string; caption: string; value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void;
  locked?: (v: T) => boolean; disabled?: boolean;
}) {
  return (
    <>
      <span className="field-label" id={id}>{caption}</span>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map(([v, label]) => {
          const off = disabled || (locked?.(v) ?? false);
          return (
            <button key={label} type="button" role="radio" aria-checked={value === v} aria-disabled={off || undefined}
                    className={value === v ? 'on' : ''} tabIndex={value === v ? 0 : -1} onKeyDown={arrowNav}
                    onClick={() => { if (!off) onPick(v); }}>{label}</button>
          );
        })}
      </div>
    </>
  );
}

type Change = (patch: Partial<AppsMailForm>) => void;

export function AppToggles({ form, onChange, error, errorId, disabled }: {
  form: Pick<AppsMailForm, 'apps' | 'mailMode'>; onChange: Change; error?: string; errorId: string; disabled?: boolean;
}) {
  return (
    <>
      <p className="page-hint">API and Portal always run.</p>
      <div className="sirdar-flow-grid">
        {OPTIONAL_APPS.map(([app, label]) => (
          <Toggle key={app} label={label} checked={form.apps[app]} disabled={disabled || (app === 'learn' && !form.apps.wiki)}
                  onChange={(v) => onChange(switchApp(form, app, v))} />
        ))}
      </div>
      {!form.apps.wiki && <p className="page-hint">The learning site needs the wiki, so it is off while the wiki is.</p>}
      {error && <p className="form-error" id={errorId} role="alert">{error}</p>}
    </>
  );
}

export function DigestsField({ id, value, onChange, error, disabled }: {
  id: string; value: string; onChange: (v: string) => void; error?: string; disabled?: boolean;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>Kiosk signing digests</label>
      <textarea id={id} rows={3} value={value} spellCheck={false} disabled={disabled}
                aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint`}
                onChange={(e) => onChange(e.target.value)} />
      <p className="page-hint" id={`${id}-hint`}>
        SHA-256 digests of the kiosk app's signing certificates (release and Play), one per line. Kiosk biometric
        sign-in enrolls only apps signed with these.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export function MailFields({ idPrefix, form, onChange, error, disabled, showPassword }: {
  idPrefix: string; form: AppsMailForm; onChange: Change; error?: string; disabled?: boolean;
  /** The Deploy flow types the SMTP password here; Settings keeps it under Secrets. */
  showPassword: boolean;
}) {
  const mailpitOff = !form.apps.mailpit;
  const errId = error ? `${idPrefix}-mail-error` : undefined;
  return (
    <>
      <Segmented id={`${idPrefix}-mail-label`} caption="Mail" value={form.mailMode} disabled={disabled}
                 options={[['mailpit', 'Mailpit'], ['smtp', 'SMTP']] as const}
                 locked={(m) => m === 'mailpit' && mailpitOff} onPick={(m) => onChange({ mailMode: m })} />
      <p className="page-hint">
        {mailpitOff ? 'Mailpit is off, so mail needs SMTP: enter your SMTP server below.'
          : form.mailMode === 'mailpit' ? 'Mailpit catches every email on the server; nothing is sent. Good for testing.'
          : 'Mail goes out through your SMTP server.'}
      </p>
      {form.mailMode === 'smtp' && (
        <>
          <div className="sirdar-flow-grid" role="group" aria-label="SMTP server">
            <Field id={`${idPrefix}-smtp-host`} label="SMTP host" value={form.smtpHost} errorId={errId} disabled={disabled}
                   onChange={(v) => onChange({ smtpHost: v })} />
            <Field id={`${idPrefix}-smtp-port`} label="SMTP port" value={form.smtpPort} inputMode="numeric" errorId={errId}
                   disabled={disabled} onChange={(v) => onChange({ smtpPort: v })} />
            <Toggle label="STARTTLS" checked={form.smtpStarttls} disabled={disabled} onChange={(v) => onChange({ smtpStarttls: v })} />
          </div>
          <div className="sirdar-flow-grid">
            <Field id={`${idPrefix}-smtp-user`} label="User name" value={form.smtpUsername} errorId={errId} disabled={disabled}
                   onChange={(v) => onChange({ smtpUsername: v })} />
            {showPassword && (
              <Field id={`${idPrefix}-smtp-password`} label="SMTP password" type="password" value={form.smtpPassword}
                     errorId={errId} disabled={disabled} onChange={(v) => onChange({ smtpPassword: v })}
                     hint="Saved encrypted; never shown again." />
            )}
            <Field id={`${idPrefix}-smtp-from`} label="From address" value={form.smtpFrom} errorId={errId} disabled={disabled}
                   onChange={(v) => onChange({ smtpFrom: v })} />
          </div>
          {!showPassword && <p className="page-hint">The SMTP password is under Secrets once SMTP is saved.</p>}
        </>
      )}
      {error && <p className="form-error" id={`${idPrefix}-mail-error`} role="alert">{error}</p>}
    </>
  );
}
```

- [ ] **Step 5: Rewire flowState, the steps, DeployFlow and the API types**

`sirdar/web/src/lib/sirdarApi.ts`:
- `Environment`: after `mail: EnvMail;` add `/** SHA-256 digests of the kiosk app's signing certificates (SS_KIOSK_SIGNING_DIGESTS). */ kiosk_signing_digests: string[];`
- `NewEnvironmentBody`: after `mail?: NewMail;` add `/** The kiosk app's signing certificate digests. */ kiosk_signing_digests?: string[];`
- `EnvironmentPatch`: add `/** The optional apps it runs, its mail (Settings sends the SMTP password as secrets.SS_SMTP_PASSWORD) and the kiosk signing digests. */ apps?: string[]; mail?: NewMail; kiosk_signing_digests?: string[];`
- `DeploymentBody`: add `/** A first Update that starts empty: end with step 20 Seed starter content. */ seed_content?: boolean;`
- `MESSAGES`: `apps_invalid: 'Choose the apps from Wiki, Kiosk, Learning, Status page and Mailpit.',` and add after it:

```ts
  learn_needs_wiki: 'The learning site needs the wiki: turn the wiki on, or turn learning off.',
  signing_digest_invalid: 'Each kiosk signing digest is a SHA-256: 64 hex characters, colons allowed.',
  digests_not_allowed: 'An adopted environment keeps the signing digests its own .env has (SS_KIOSK_SIGNING_DIGESTS).',
  seed_content_not_allowed: 'Only the first deploy of an environment that starts empty can seed starter content.',
```

`sirdar/web/src/pages/deploy/flowState.ts`:
- Imports: add `import { OPTIONAL_APPS, SECRET_HELP, SECRET_RE, appsOn, appsProblem, mailBody, mailProblem, parseDigests, type AppSwitches } from '../../lib/appRules';` and `export { OPTIONAL_APPS, type OptionalApp } from '../../lib/appRules';`. Delete the local `OptionalApp` type, `OPTIONAL_APPS`, `HOST_RE`, `EMAIL_RE`, `USER_RE`, `SECRET_RE` and `SECRET_HELP` declarations (keep `CONTROL_RE`, `whole`, `inRange`: the Data step and sizes still use them).
- `FlowState`: `apps: AppSwitches;` and after `aiKey: string;` add `/** The kiosk signing digests as typed, one per line. */ digests: string;`; after `dataMode…; snapshotId: string;` add `/** Empty start: step 20 seeds starter content. */ seedContent: boolean;`.
- `initialState`: `apps: { wiki: true, kiosk: true, learn: true, status: true, mailpit: true },`, `aiKey: '', digests: '',` and `dataMode: 'empty', snapshotId: '', seedContent: true,`.
- `Field` union: add `| 'digests'`.
- `stepErrors` `case 'extras'` becomes:

```ts
    case 'extras': {
      const errors: Errors = { apps: appsProblem(s) };
      if (s.mailMode === 'smtp') errors.mail = mailProblem(s);
      if (s.apps.kiosk) errors.digests = parseDigests(s.digests).problem;
      if (s.aiKey && !SECRET_RE.test(s.aiKey)) errors.aiKey = `That key ${SECRET_HELP}`;
      return only(errors);
    }
```

- `buildBody`: `apps: appsOn(s.apps),` and `mail: mailBody(s),`, and after the `secrets` spread add:

```ts
    ...(s.apps.kiosk && parseDigests(s.digests).digests.length
      ? { kiosk_signing_digests: parseDigests(s.digests).digests } : {}),
```

- `CODE_FIELD`: add `learn_needs_wiki: 'apps',` next to `apps_invalid`, and `signing_digest_invalid: 'digests',`; `FIELD_STEP`: add `digests: 'extras',`.

`sirdar/web/src/pages/deploy/steps/ExtrasStep.tsx` — delete its local `Toggle`, `Field` and `Segmented`; imports become:

```tsx
import { AppToggles, DigestsField, Field, MailFields, Segmented, Toggle } from '../../../components/AppsMail';
import { targetKind } from '../flowState';
```

In the component, delete `mailpitOff`, `setApp` and `mailErr`; replace the Apps block (from `<h3 className="sirdar-sub">Apps</h3>` to the `errors.apps` line) with:

```tsx
      <h3 className="sirdar-sub">Apps</h3>
      <AppToggles form={state} onChange={set} error={errors.apps} errorId="flow-apps-error" />
      {state.apps.kiosk && (
        <DigestsField id="flow-digests" value={state.digests} error={errors.digests} onChange={(v) => set({ digests: v })} />
      )}
```

and replace everything from `<Segmented id="flow-mail-label" …` through the `{errors.mail && …}` line with:

```tsx
      <MailFields idPrefix="flow" form={state} onChange={set} error={errors.mail} showPassword />
```

(The Hosting, Integrations and Anthropic key blocks are unchanged and keep using `Toggle`, `Segmented` and `Field`.)

`sirdar/web/src/pages/deploy/steps/DataStep.tsx` — add `import { Toggle } from '../../../components/AppsMail';` and, as the last child of the empty-start fragment (after the `errors.adminPassword` line):

```tsx
          <div className="sirdar-span2">
            <Toggle label="Seed starter content" checked={state.seedContent} onChange={(v) => set({ seedContent: v })} />
            <p className="page-hint">
              The first deploy loads the label builder's fonts and templates
              {state.apps.learn ? ', and the sample learning documents' : ''}. Zebra's TT0003M_.TTF still goes in by
              hand (Label builder › Fonts).
            </p>
          </div>
```

`sirdar/web/src/pages/deploy/DeployFlow.tsx` — `start` becomes:

```tsx
  async function start(name: string) {
    const seed = state?.dataMode === 'empty' && state.seedContent;
    const dep = await startDeployment(name, { mode: 'update', ...(seed ? { seed_content: true } : {}) });
    navigate(`/deploy/environments/${encodeURIComponent(name)}?deployment=${encodeURIComponent(dep.id)}`);
  }
```

`sirdar/web/src/pages/deploy/flowFixtures.ts` line 9: `apps: { optional: ['wiki', 'kiosk', 'learn', 'status', 'mailpit'], always: ['api', 'portal'] },`.

`sirdar/web/src/pages/environments/testData.ts`: in `ENV` add `kiosk_signing_digests: [],` after `mail: …`; in `DEFAULTS.services` add `{ service: 'learn', port: 8092, public: true },` after the wiki entry; `DEFAULTS.apps.optional` gains `'learn'` after `'kiosk'`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd sirdar/web && npx vitest run src/lib src/pages/deploy src/components`
Expected: PASS (ReviewStep shows "Learning" in its app list now; if `ReviewStep.test.tsx` pins the joined list, add `Learning` after `Kiosk` there).

- [ ] **Step 7: Type-check**

Run: `cd sirdar/web && npx tsc --noEmit -p .`
Expected: no errors in touched files (fixtures that build `apps` objects without `learn` in `*.test.ts(x)` get `learn: true` — or `false` where the wiki is off).

- [ ] **Step 8: Commit**

```bash
git add sirdar/web/src
git commit -m "feat(sirdar-web): Learning and kiosk signing digests in the Extras step (shared app and mail controls), Seed starter content on the Data step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web — Settings › Apps & mail

**Files:**
- Modify: `sirdar/web/src/pages/environments/EnvSettings.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvSettings.test.tsx`

**Interfaces:**
- Consumes: Task 9's `AppToggles`, `MailFields`, `DigestsField`, `formOfEnv`, `appsOn`, `appsProblem`, `mailProblem`, `mailBody`, `parseDigests`, `AppsMailForm`; Task 6's PATCH fields.
- Produces: the Settings form PATCHes `apps`, `mail` (no password) and `kiosk_signing_digests` when they change, through the existing "Save settings" button.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/web/src/pages/environments/EnvSettings.test.tsx`:

```tsx
it('Apps & mail: turning the wiki off turns learning off, and both are saved', async () => {
  open({ ...ENV, apps: ['wiki', 'kiosk', 'learn', 'status', 'mailpit'] });
  await userEvent.click(screen.getByLabelText('Wiki'));
  expect((screen.getByLabelText('Learning') as HTMLInputElement).checked).toBe(false);
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { apps: ['kiosk', 'status', 'mailpit'] }));
  expect(screen.getByText('Saved. The next deploy applies these settings.')).toBeTruthy();
});

it('Apps & mail: SMTP is checked first and sent without a password', async () => {
  open();
  await userEvent.click(screen.getByRole('radio', { name: 'SMTP' }));
  expect(screen.queryByLabelText('SMTP password')).toBeNull();
  await save();
  expect(screen.getByText("Enter the SMTP server's host name or address.")).toBeTruthy();
  expect(api.updateEnvironment).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText('SMTP host'), 'smtp.example.com');
  await userEvent.type(screen.getByLabelText('From address'), 'ops@example.com');
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', {
    mail: { mode: 'smtp', host: 'smtp.example.com', port: 587, from_address: 'ops@example.com', starttls: true } }));
});

it('Apps & mail: the kiosk signing digests are saved normalized', async () => {
  open();
  await userEvent.type(screen.getByLabelText('Kiosk signing digests'), 'AB:'.repeat(31) + 'AB');
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { kiosk_signing_digests: ['ab'.repeat(32)] }));
});

it('Apps & mail: an API refusal lands on its field', async () => {
  api.updateEnvironment.mockRejectedValueOnce(new ApiError(422, 'learn_needs_wiki', { code: 'learn_needs_wiki' }));
  open();
  await userEvent.click(screen.getByLabelText('Status page'));
  await save();
  expect(await screen.findByText('The learning site needs the wiki: turn the wiki on, or turn learning off.')).toBeTruthy();
});

it('Apps & mail is locked while a deployment runs', () => {
  open({ ...ENV, status: 'deploying' });
  expect((screen.getByLabelText('Kiosk') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Kiosk signing digests') as HTMLTextAreaElement).disabled).toBe(true);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd sirdar/web && npx vitest run src/pages/environments/EnvSettings.test.tsx`
Expected: FAIL — no Wiki / Learning switches, no Kiosk signing digests field.

- [ ] **Step 3: Implement**

In `EnvSettings.tsx`:
- Imports: add

```tsx
import { AppToggles, DigestsField, MailFields } from '../../components/AppsMail';
import {
  appsOn, appsProblem, formOfEnv, mailBody, mailProblem, parseDigests, type AppsMailForm,
} from '../../lib/appRules';
```

- File doc comment: `/** Settings tab: edit the environment record — its apps, mail and kiosk signing digests included. Changes reach the target on the next deploy. Optional secrets are write-only. */`
- `CODE_FIELD`: add

```ts
  apps_invalid: 'apps', mailpit_required: 'apps', learn_needs_wiki: 'apps', mail_invalid: 'mail',
  smtp_host_invalid: 'mail', smtp_port_invalid: 'mail', smtp_username_invalid: 'mail', smtp_from_invalid: 'mail',
  smtp_password_invalid: 'mail', smtp_required_for_first_admin: 'mail', signing_digest_invalid: 'digests',
```

- Add after `const editable = …`: `const SMTP_PORT = 587;   // apps.DEFAULT_SMTP_PORT`
- `fromEnv` returns, after `keepVm: …,`: `...formOfEnv(env.apps, env.mail, env.kiosk_signing_digests, SMTP_PORT),`
- After `setSvc` add:

```tsx
  const setAppsMail = (patch: Partial<AppsMailForm>) => { setForm((f) => ({ ...f, ...patch })); setNotice(''); };
```

- In `validate`, before the `for (const key of secretKeys)` loop:

```tsx
    put('apps', appsProblem(form));
    if (form.mailMode === 'smtp') put('mail', mailProblem(form));
    put('digests', parseDigests(form.digests).problem);
```

- In `patchOf`, before `return patch;`:

```tsx
    const apps = appsOn(form.apps);
    if (apps.join() !== env.apps.join()) patch.apps = apps;
    const mail = mailBody(form, false);
    if (JSON.stringify(mail) !== JSON.stringify(mailBody(formOfEnv(env.apps, env.mail, [], SMTP_PORT), false))) {
      patch.mail = mail;
    }
    const digests = parseDigests(form.digests).digests;
    if (digests.join() !== (env.kiosk_signing_digests ?? []).join()) patch.kiosk_signing_digests = digests;
```

- JSX: right after `{errors.services && <p className="form-error" role="alert">{errors.services}</p>}` add:

```tsx
      <h3 className="sirdar-sub">Apps &amp; mail</h3>
      <AppToggles form={form} onChange={setAppsMail} error={errors.apps} errorId="env-set-apps-error" disabled={off} />
      {form.apps.kiosk && (
        <DigestsField id="env-set-digests" value={form.digests} error={errors.digests} disabled={off}
                      onChange={(v) => set('digests', v)} />
      )}
      <MailFields idPrefix="env-set" form={form} onChange={setAppsMail} error={errors.mail} disabled={off}
                  showPassword={false} />
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd sirdar/web && npx vitest run src/pages/environments src/pages/deploy src/lib src/components`
Expected: PASS.

Run: `cd sirdar/web && npx tsc --noEmit -p .`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/EnvSettings.tsx sirdar/web/src/pages/environments/EnvSettings.test.tsx
git commit -m "feat(sirdar-web): Settings › Apps & mail edits an environment's apps, mail and kiosk signing digests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs

**Files:**
- Modify: `sirdar/README.md:734-763`
- Modify: `deploy/stack/README.md:44-47`

**Interfaces:**
- Consumes: Tasks 1-10's behavior.
- Produces: operator docs only.

- [ ] **Step 1: Update sirdar/README.md**

Replace the "**Extras › Apps:**" bullet with:

```markdown
- **Extras › Apps:** the API and Portal always run; Wiki, Kiosk, Learning (the
  worker training site, `learn.<domain>`), the Status page and Mailpit can be
  turned off (`STACK_APPS` in the `.env`). Learning needs the wiki (its
  documents render there): turning the wiki off turns Learning off. An app that
  is off gets no hostname, DNS record, proxy host, certificate name, smoke test,
  status-page card or portal link (`SS_APPS`). Turning an app off needs a commit
  from this release or later: an older git ref runs every app and uses Mailpit.
- **Extras › Kiosk signing digests:** the SHA-256 digests of the kiosk app's
  signing certificates (release and Play), one per line; written as
  `SS_KIOSK_SIGNING_DIGESTS`. Kiosk biometric sign-in refuses every enroll
  without them.
```

After the "**Ports:**" bullet add:

```markdown
- **Settings › Apps & mail:** the same apps, mail and digests, editable after
  create (locked while a deploy runs; saved with Save settings). Nothing runs
  on save: the next Update rewrites the `.env`, `ss-stack up` starts or stops
  the app containers (their volumes are kept), and the publish adds or removes
  the DNS records and proxy hosts. A DigitalOcean certificate is reissued to
  cover exactly the running apps. The SMTP password stays under Secrets.
```

After the first-admin paragraph (ending "…on dev and UAT that's usually Mailpit.") add:

```markdown
**Starter content (starting empty).** The Data step's **Seed starter content**
(on by default) adds step 20 "Seed starter content" to the first deploy: in
the api container it runs `serversherpa seed-label-fonts` and
`seed-label-templates`, and `learning-seed` when Learning and the wiki run.
Each command is idempotent; a failure fails the step with the commands' last
lines, and Retry runs it again. Step 20 is the last step (after any publish or
switch). Zebra's TT0003M_.TTF is never seeded: upload it by hand
(Label builder › Fonts). The fonts are downloaded from GitHub, so the
environment needs outbound HTTPS.
```

- [ ] **Step 2: Update deploy/stack/README.md**

After the `ss-stack admin` paragraph add:

```markdown
`ss-stack seed <env-dir> [--learning]` runs `serversherpa seed-label-fonts`
and `seed-label-templates` (with `--learning`, `learning-seed` too) in the
running api container (Sirdar's step 20, Seed starter content); the first
command that fails stops it with its exit code.

`STACK_APPS` also reaches the API as `SS_APPS` (the portal hides links to an
app that is off), and `ss-stack` refuses `learn` without `wiki`.
`SS_KIOSK_SIGNING_DIGESTS` (comma-separated SHA-256 digests of the kiosk
app's signing certificates) reaches the API unchanged; empty refuses every
biometric enroll.
```

- [ ] **Step 3: Commit**

```bash
git add sirdar/README.md deploy/stack/README.md
git commit -m "docs(sirdar): learn, editable apps and mail, signing digests and step 20 Seed starter content

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Live check (after merge; not part of the tasks)

Per the spec, on Tower with `demo`: Update demo (learn picked up, `learn.demo.serversherpa.com` published); turn the wiki off in Settings › Apps & mail (Learning goes off), Update; check the wiki and learn names are gone and the portal shows no Wiki link or Help button; turn both back on and Update.
