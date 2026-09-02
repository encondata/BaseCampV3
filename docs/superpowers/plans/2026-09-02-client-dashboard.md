# Client Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client-scoped dashboard at `/dashboards/clients` — client picker for internal users, pinned + auto-landing for client-anchored users — showing initiatives, asset fleet, and recent scan activity for one client. No financials.

**Architecture:** Initiatives join the client anchor's world (visible_to + SCOPE_COLUMNS + scoped reads + view grants via migration 0044); one new `GET /clients/{id}/activity` endpoint under the `clients` resource joins processed scans through the client's assets. The portal page follows the PeopleDashboard composition (per-permission panels, verbatim refresh idiom), plus a `globalOnly` nav flag and a Home→ClientDashboard redirect for client users.

**Tech Stack:** FastAPI/SQLAlchemy async/pytest (real Postgres); React/TS/vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-client-dashboard-design.md`

## Global Constraints

- All suites FOREGROUND, one continuous run, `timeout: 600000` ms — NEVER background a run, never use Monitor, never end a turn "waiting". API: `cd api && .venv/bin/pytest` (991 at branch HEAD `22f39bf`). Portal: `cd portal && npm test` (757) + `npm run build`.
- `git checkout -- api/src/serversherpa/_dev_reload.py` if dirty; never commit it.
- Scoping contract: global actors' behavior is UNCHANGED everywhere (scope cond is None for them); out-of-scope single-row reads 404 (never 403 — the `_get_org`/`_get_asset` pattern). Client roles gain ONLY `initiatives:view` (migration 0044 + defaults.py in lockstep); writes stay internal.
- Activity endpoint: gate `clients:view` + `_get_org` scope probe; `limit` Query(30, 1–100); `activity_7d` counts the trailing 7 days independent of `limit`; vocab fallback color `#51606f`; batch lookups, no N+1.
- Portal: REFRESH_OPTIONS copied verbatim (Off default), non-blanking refresh, `.dash-asof` dot, per-panel `can()` gates, quiet catches, `Intl.NumberFormat`, `.dash-skel`. `MAX_PROGRESS_FETCHES = 5` (Home's constant, copied). Empty/permission copy strings exactly as the spec states.
- No financials anywhere on the page.

---

### Task 1: Initiative client scoping + grants

**Files:**
- Modify: `api/src/serversherpa/access/resources.py` (initiatives visible_to)
- Modify: `api/src/serversherpa/access/scope.py` (SCOPE_COLUMNS)
- Modify: `api/src/serversherpa/access/defaults.py` (client_* grants)
- Create: `api/migrations/versions/0044_client_initiatives_grants.py`
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (list + `_get_initiative` scope)
- Modify: `api/src/serversherpa/api/routes/time.py` (`/time/summary` probe)
- Test: `api/tests/test_initiatives_client_scope.py`

**Interfaces:**
- Consumes: `scope_conditions(resource, access, person_id)` (access/scope.py), `Initiative` model, existing `_get_initiative` in initiatives.py, `_get_org` 404 pattern.
- Produces: client-anchored actors can `GET /initiatives` (their client's rows only, incl. via the roster endpoint) and are 404'd on foreign ids everywhere, including `GET /time/summary`. Test helper `client_login(db, client_api, client_id, role="client_viewer", email=...)` other tasks may copy.

- [ ] **Step 1: Write the failing tests `api/tests/test_initiatives_client_scope.py`**

```python
"""Client-anchored initiative visibility: scoped list, 404 probes,
global actors unchanged."""

import uuid

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Client, Initiative, Person, PersonRole, UserAccount,
)
from serversherpa.security.passwords import hash_password

from tests.test_sites_api import login
from tests.test_status_values_write import _make

PW = "CorrectHorse9!"


async def client_login(db, client_api, client_id, role="client_viewer",
                       email="cl@test.example.com"):
    """A ready-to-use client-anchored login for the given client."""
    p = Person(first_name="Cli", last_name="Ent", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role, client_id=client_id))
    await db.commit()
    return await login(client_api, email=email)


async def _two_clients_with_initiatives(db):
    a, b = Client(name="Acme"), Client(name="Bravo")
    db.add(a)
    db.add(b)
    await db.flush()
    ia = Initiative(name="Acme move", initiative_type="move",
                    sub_type="migration", client_id=a.id)
    ib = Initiative(name="Bravo move", initiative_type="move",
                    sub_type="migration", client_id=b.id)
    inone = Initiative(name="Unattributed", initiative_type="move",
                       sub_type="migration")
    db.add(ia)
    db.add(ib)
    db.add(inone)
    await db.commit()
    return a, b, ia, ib, inone


async def test_client_actor_sees_only_their_initiatives(client, db,
                                                        seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    resp = await client.get("/initiatives", headers=hdrs)
    assert resp.status_code == 200, resp.text
    names = [i["name"] for i in resp.json()]
    assert names == ["Acme move"]
    # own initiative readable; foreign + unattributed are 404 (not 403)
    assert (await client.get(f"/initiatives/{ia.id}",
                             headers=hdrs)).status_code == 200
    assert (await client.get(f"/initiatives/{ib.id}",
                             headers=hdrs)).status_code == 404
    # roster read of a foreign initiative is 404 too
    assert (await client.get(f"/initiatives/{ib.id}/assets",
                             headers=hdrs)).status_code == 404
    assert (await client.get(f"/initiatives/{ia.id}/assets",
                             headers=hdrs)).status_code == 200


async def test_client_actor_cannot_write_initiatives(client, db,
                                                     seeded_user):
    a, *_ = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    resp = await client.post("/initiatives", headers=hdrs, json={
        "name": "nope", "initiative_type": "move", "sub_type": "migration"})
    assert resp.status_code == 403


async def test_global_actor_unchanged(client, db, seeded_user):
    _a, _b, ia, ib, inone = await _two_clients_with_initiatives(db)
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/initiatives", headers=hdrs)
    names = {i["name"] for i in resp.json()}
    assert {"Acme move", "Bravo move", "Unattributed"} <= names
    assert (await client.get(f"/initiatives/{inone.id}",
                             headers=hdrs)).status_code == 200


async def test_time_summary_scope_probe(client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    ok = await client.get(f"/time/summary?initiative_id={ia.id}",
                          headers=hdrs)
    assert ok.status_code == 200
    foreign = await client.get(f"/time/summary?initiative_id={ib.id}",
                               headers=hdrs)
    assert foreign.status_code == 404
    ghost = await client.get(f"/time/summary?initiative_id={uuid.uuid4()}",
                             headers=hdrs)
    assert ghost.status_code == 404
```

(Verify `hash_password`'s import path and `Initiative`'s NOT NULL columns — mirror how `test_status_values_write._make` builds accounts and how existing initiative tests construct rows; adjust minimally, never weakening assertions. If `/time/summary` already 404s ghosts for global actors, keep that behavior.)

- [ ] **Step 2: Run → FAIL** (`cd api && .venv/bin/pytest tests/test_initiatives_client_scope.py -v`) — expect 403s (hard gate) before the visible_to change, then wrong-shaped results until scoping lands.

- [ ] **Step 3: Access-layer edits**

`access/resources.py` — initiatives entry: `visible_to=frozenset({"global", "client"})`, comment updated to say client visibility is live (work-history view) while writes stay internal.

`access/scope.py` — add to `SCOPE_COLUMNS` (plus the `Initiative` import):

```python
    "initiatives": {"client": Initiative.client_id},
```

`access/defaults.py` — the three client role dicts each gain `"initiatives": ("view",)` (owner/admin/viewer alike).

- [ ] **Step 4: Migration `api/migrations/versions/0044_client_initiatives_grants.py`**

```python
"""Client roles gain initiatives:view — the client work-history slice.

Revision ID: 0044
Revises: 0043
Create Date: 2026-09-02
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0044"
down_revision: str | None = "0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ROLES = ("client_owner", "client_admin", "client_viewer")


def upgrade() -> None:
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'initiatives', 'view') ON CONFLICT DO NOTHING"),
            {"r": role})


def downgrade() -> None:
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "DELETE FROM role_permissions WHERE role = :r "
            "AND resource = 'initiatives' AND action = 'view'"),
            {"r": role})
```

- [ ] **Step 5: Route scoping**

`routes/initiatives.py`:
- `list_initiatives`: after building the base select, apply

```python
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
```

(adapting to the handler's actual query variable; import `scope_conditions`).
- `_get_initiative`: thread the actor through (change its signature to accept `actor: AuthContext` and add the scope probe — load the row, then `if cond is not None: re-select with cond / or evaluate` following `_get_org`'s exact shape at stakeholders.py:110-124; out-of-scope → the function's existing 404). Update EVERY caller in the file to pass the actor. This transitively covers `GET /initiatives/{id}` and `GET /initiatives/{id}/assets` — verify the roster endpoint goes through `_get_initiative`; if it fetches directly, route it through the helper.

`routes/time.py` `time_summary`: before aggregating, verify the initiative is in scope:

```python
    query = select(Initiative).where(Initiative.id == initiative_id)
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    if (await db.execute(query)).scalar_one_or_none() is None:
        raise _err(404, "unknown_initiative")
```

(imports: `Initiative`, `scope_conditions`; reuse the file's `_err`. If time.py has no `_err`, add the standard 3-line helper.)

- [ ] **Step 6: Run focused → PASS. FULL API suite foreground → note EVERY failure caused by the grants/visible_to change (pinned matrices or resolver tests may assert the old state) — update those pins to the new intended state (client roles hold initiatives:view; initiatives visible_to includes client), never weakening unrelated assertions. Re-run → green.**

- [ ] **Step 7: Commit**

```bash
git add -A api && git commit -m "feat(api): client-anchored initiative visibility — scoped reads + view grants"
```

---

### Task 2: `GET /clients/{org_id}/activity`

**Files:**
- Modify: `api/src/serversherpa/api/routes/stakeholders.py` (clients router)
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_clients_activity_api.py`

**Interfaces:**
- Consumes: `_get_org` (scope probe + 404), `ProcessedScan`, `Asset`, `Site`, asset status vocab rows (`StatusValue` where record_type='asset'), Task 1's `client_login` helper (import from `tests.test_initiatives_client_scope`).
- Produces: `GET /clients/{org_id}/activity?limit=` → `ClientActivityOut { events: [ClientActivityItem { id, scanned_at, asset_id, asset_name, serial_number, status, status_label, status_color, site_name }], activity_7d: int }` — newest first. NOTE: the spec's example includes `device_id`; include it: `device_id: str`.

- [ ] **Step 1: Write the failing tests `api/tests/test_clients_activity_api.py`**

```python
"""Client activity feed: asset-join correctness, 7d count, scope."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Asset, Client, ProcessedScan, Site

from tests.test_initiatives_client_scope import client_login
from tests.test_status_values_write import _make


async def _fixture(db):
    now = datetime.now(UTC)
    a, b = Client(name="Acme"), Client(name="Bravo")
    site = Site(name="NAP11 - Switch")
    db.add(a)
    db.add(b)
    db.add(site)
    await db.flush()
    mine = Asset(name="core-sw-01", serial_number="C7X-1",
                 client_id=a.id, status="in_transit")
    theirs = Asset(name="other-box", serial_number="ZZ-9",
                   client_id=b.id, status="labeled")
    db.add(mine)
    db.add(theirs)
    await db.flush()
    for days, asset in ((0, mine), (1, mine), (10, mine), (0, theirs)):
        db.add(ProcessedScan(
            scanned_value=asset.serial_number or "", scan_type="rfid",
            status=asset.status, scanned_at=now - timedelta(days=days),
            device_id="dock-reader-1", site_id=site.id,
            match_type="asset", asset_id=asset.id,
            processed_at=now))
    await db.commit()
    return a, b, mine


async def test_activity_joins_and_counts(client, db, seeded_user):
    a, _b, mine = await _fixture(db)
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get(f"/clients/{a.id}/activity", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["events"]) == 3            # only Acme's asset's scans
    ev = body["events"][0]
    assert ev["asset_name"] == "core-sw-01"
    assert ev["serial_number"] == "C7X-1"
    assert ev["site_name"] == "NAP11 - Switch"
    assert ev["device_id"] == "dock-reader-1"
    assert ev["status_label"]                  # vocab-resolved
    assert ev["status_color"].startswith("#")
    assert body["activity_7d"] == 2            # the 10-day-old scan excluded
    # limit does not change the 7d count
    resp = await client.get(f"/clients/{a.id}/activity?limit=1",
                            headers=hdrs)
    assert len(resp.json()["events"]) == 1
    assert resp.json()["activity_7d"] == 2


async def test_activity_scope_and_empty(client, db, seeded_user):
    a, b, _mine = await _fixture(db)
    hdrs = await client_login(db, client, a.id)
    ok = await client.get(f"/clients/{a.id}/activity", headers=hdrs)
    assert ok.status_code == 200 and len(ok.json()["events"]) == 3
    foreign = await client.get(f"/clients/{b.id}/activity", headers=hdrs)
    assert foreign.status_code == 404
    # Bravo has one scan but a fresh client with no assets is empty-shaped
    c = Client(name="Empty Co")
    db.add(c)
    await db.commit()
    adm = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get(f"/clients/{c.id}/activity", headers=adm)
    assert resp.json() == {"events": [], "activity_7d": 0}
```

(Adjust Asset/ProcessedScan NOT NULL fields to the real models — mirror existing fixtures in test_scans_people_flow_api.py / assets tests; the `status` values must be seeded asset-vocab keys.)

- [ ] **Step 2: Run → FAIL (404 route)**

- [ ] **Step 3: Schemas**

```python
class ClientActivityItem(BaseModel):
    id: uuid.UUID
    scanned_at: datetime
    asset_id: uuid.UUID
    asset_name: str | None
    serial_number: str | None
    status: str
    status_label: str
    status_color: str
    site_name: str | None
    device_id: str


class ClientActivityOut(BaseModel):
    events: list[ClientActivityItem]
    activity_7d: int
```

- [ ] **Step 4: Route in `routes/stakeholders.py`** — register on the clients router (inside or beside the factory the way `/contacts` endpoints are; a standalone `@clients_router.get("/{org_id}/activity")` after the factory instantiation is fine if the factory doesn't expose extension hooks — match the file's structure):

```python
@clients_router.get("/{org_id}/activity", response_model=ClientActivityOut)
async def client_activity(
    org_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("clients", "view"),
    limit: int = Query(30, ge=1, le=100),
) -> ClientActivityOut:
    """Recent processed scans on the client's assets — the dashboard's
    read-only activity feed. activity_7d spans the trailing 7 days
    regardless of limit. Lives under `clients` so client anchors need no
    scans grant."""
    org = await _get_org(db, Client, org_id, actor, "clients")  # adapt to _get_org's real signature
    asset_ids = select(Asset.id).where(Asset.client_id == org.id,
                                       Asset.archived_at.is_(None))
    base = (ProcessedScan.asset_id.in_(asset_ids)
            & ProcessedScan.archived_at.is_(None))
    week_ago = datetime.now(UTC) - timedelta(days=7)
    activity_7d = (await db.execute(select(func.count()).where(
        base, ProcessedScan.scanned_at >= week_ago))).scalar_one()
    rows = (await db.execute(select(ProcessedScan).where(base)
        .order_by(ProcessedScan.scanned_at.desc()).limit(limit))
        ).scalars().all()

    assets = {r.id: r for r in (await db.execute(select(Asset).where(
        Asset.id.in_({s.asset_id for s in rows})))).scalars()} if rows else {}
    site_ids = {s.site_id for s in rows if s.site_id}
    sites = {r.id: r.name for r in (await db.execute(select(Site).where(
        Site.id.in_(site_ids)))).scalars()} if site_ids else {}
    vocab = {v.key: v for v in (await db.execute(select(StatusValue).where(
        StatusValue.record_type == "asset"))).scalars()}

    events = []
    for s in rows:
        a = assets.get(s.asset_id)
        sv = vocab.get(s.status)
        events.append(ClientActivityItem(
            id=s.id, scanned_at=s.scanned_at, asset_id=s.asset_id,
            asset_name=a.name if a else None,
            serial_number=a.serial_number if a else None,
            status=s.status,
            status_label=sv.label if sv else s.status,
            status_color=sv.color if sv else "#51606f",
            site_name=sites.get(s.site_id), device_id=s.device_id))
    return ClientActivityOut(events=events, activity_7d=activity_7d)
```

(Adapt `_get_org`'s call to its actual signature in this file — it exists and implements the scope-404; reuse it exactly as sibling contact endpoints do. Add missing imports: `ProcessedScan`, `StatusValue`, `Query`, `timedelta`, `func` per the file's style.)

- [ ] **Step 5: Run focused → PASS, FULL API suite foreground → green, commit**

```bash
git add -A api && git commit -m "feat(api): client activity feed endpoint"
```

---

### Task 3: Portal wrappers, nav `globalOnly`, Home redirect

**Files:**
- Modify: `portal/src/lib/api.ts` (`// ── Client dashboard ──` section)
- Create: `portal/src/lib/clientDashboard.ts` (+ test)
- Modify: `portal/src/layout/navSections.tsx` (`globalOnly` on Main/Move/People dashboard items)
- Modify: `portal/src/lib/godmode.ts` (`isNavItemVisible` signature)
- Modify: `portal/src/layout/AppShell.tsx` (pass scope.global; its test mock gains `scope`)
- Modify: `portal/src/pages/Home.tsx` (redirect)
- Test: `portal/src/lib/clientDashboard.test.ts`, `portal/src/lib/godmode.test.ts` (extend), `portal/src/pages/Home.test.tsx` (create if absent — redirect cases only)

**Interfaces:**
- Consumes: `ScopeInfo { global, client_ids, partner_ids }` from `useAuth().scope`; `InitiativeItem`, `AssetItem`, `StatusValue`, `DistEntry` types.
- Produces (Task 4 imports verbatim):
  - api.ts: `interface ClientActivityItem { id: string; scanned_at: string; asset_id: string; asset_name: string | null; serial_number: string | null; status: string; status_label: string; status_color: string; site_name: string | null; device_id: string }`; `interface ClientActivityOut { events: ClientActivityItem[]; activity_7d: number }`; `getClientActivity(clientId: string): Promise<ClientActivityOut>` (GET `/clients/${clientId}/activity`).
  - clientDashboard.ts: `sortClientInitiatives(list: InitiativeItem[]): InitiativeItem[]` (unarchived only; active — `real_end_at == null` — first; within each group `scheduled_start` desc, nulls last); `assetDistribution(assets: AssetItem[], statuses: StatusValue[]): DistEntry[]` (count per status key over unarchived assets, label/color from the vocab row, fallback label = key / color `#51606f`, sorted count desc, zero-count entries dropped).
  - `isNavItemVisible(item, can, godMode, maxRank, isGlobal: boolean)` — new 5th param; `item.globalOnly && !isGlobal` → hidden. `NavItem` gains `globalOnly?: boolean`.

- [ ] **Step 1: Failing tests**

`portal/src/lib/clientDashboard.test.ts` (node):

```ts
import { expect, it } from 'vitest';

import type { AssetItem, InitiativeItem, StatusValue } from './api';
import { assetDistribution, sortClientInitiatives } from './clientDashboard';

const I = (over: Partial<InitiativeItem>): InitiativeItem =>
  ({ id: 'i', name: 'n', real_end_at: null, scheduled_start: null,
     archived_at: null, ...over } as InitiativeItem);

it('sorts active first, scheduled_start desc, drops archived', () => {
  const rows = [
    I({ id: 'done', real_end_at: '2026-08-01T00:00:00Z',
        scheduled_start: '2026-07-01' }),
    I({ id: 'old', scheduled_start: '2026-01-01' }),
    I({ id: 'new', scheduled_start: '2026-09-01' }),
    I({ id: 'arch', archived_at: '2026-08-01T00:00:00Z' }),
    I({ id: 'nostart' }),
  ];
  expect(sortClientInitiatives(rows).map((r) => r.id))
    .toEqual(['new', 'old', 'nostart', 'done']);
});

it('assetDistribution counts by status with vocab labels', () => {
  const assets = [
    { id: '1', status: 'in_transit', archived_at: null },
    { id: '2', status: 'in_transit', archived_at: null },
    { id: '3', status: 'labeled', archived_at: null },
    { id: '4', status: 'labeled', archived_at: '2026-01-01' },
    { id: '5', status: 'mystery', archived_at: null },
  ] as AssetItem[];
  const vocab = [
    { record_type: 'asset', key: 'in_transit', label: 'In Transit',
      color: '#1668a7' },
    { record_type: 'asset', key: 'labeled', label: 'Labeled',
      color: '#178a4c' },
  ] as StatusValue[];
  const dist = assetDistribution(assets, vocab);
  expect(dist).toEqual([
    { key: 'in_transit', label: 'In Transit', color: '#1668a7', count: 2 },
    { key: 'labeled', label: 'Labeled', color: '#178a4c', count: 1 },
    { key: 'mystery', label: 'mystery', color: '#51606f', count: 1 },
  ]);
});
```

`godmode.test.ts` — extend with the new param (update existing calls to pass `true`, add):

```ts
it('globalOnly items hide for non-global users', () => {
  const item = { to: '/x', label: 'X', resource: 'dashboard', icon: null,
                 globalOnly: true };
  const canAll = () => true;
  expect(isNavItemVisible(item, canAll, false, 100, true)).toBe(true);
  expect(isNavItemVisible(item, canAll, false, 100, false)).toBe(false);
  const plain = { ...item, globalOnly: undefined };
  expect(isNavItemVisible(plain, canAll, false, 100, false)).toBe(true);
});
```

`Home.test.tsx` (jsdom; hoisted auth mock where `scope` is settable; mock heavy children — mock `../lib/api` list fns to never-resolving promises or empty resolves; MemoryRouter with a `/dashboards/clients` probe route):

```ts
it('client-anchored users are redirected to the client dashboard', async () => {
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  render(<MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/dashboards/clients" element={<div>CLIENT DASH</div>} />
    </Routes>
  </MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('CLIENT DASH')).not.toBeNull());
});

it('global users render Home normally', async () => {
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
  render(<MemoryRouter initialEntries={['/']}><Routes>
    <Route path="/" element={<Home />} /></Routes></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('CLIENT DASH')).toBeNull());
});
```

(Home fetches several endpoints on mount — the api mock must cover every fn Home imports; resolve them all to `[]`/zeroed shapes. Read Home.tsx's imports first and mock the full set.)

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

api.ts: interfaces + fetcher per the Interfaces block (house pattern).

`clientDashboard.ts`:

```ts
/**
 * Pure Client Dashboard helpers — initiative ordering and fleet
 * distribution. No React, no fetching.
 */

import type { AssetItem, InitiativeItem, StatusValue } from './api';
import type { DistEntry } from '../components/dashboard/charts';

/** Unarchived only; active (no real_end_at) before finished; within each
 *  group newest scheduled_start first, missing dates last. */
export function sortClientInitiatives(list: InitiativeItem[]): InitiativeItem[] {
  const rank = (i: InitiativeItem) => (i.real_end_at ? 1 : 0);
  const start = (i: InitiativeItem) => i.scheduled_start ?? '';
  return list
    .filter((i) => !i.archived_at)
    .sort((a, b) => rank(a) - rank(b)
      || (start(a) < start(b) ? 1 : start(a) > start(b) ? -1 : 0));
}

export function assetDistribution(
  assets: AssetItem[], statuses: StatusValue[],
): DistEntry[] {
  const counts = new Map<string, number>();
  for (const a of assets) {
    if (a.archived_at) continue;
    counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  }
  const vocab = new Map(statuses.map((s) => [s.key, s]));
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: vocab.get(key)?.label ?? key,
      color: vocab.get(key)?.color ?? '#51606f',
      count,
    }))
    .sort((a, b) => b.count - a.count);
}
```

(`sortClientInitiatives` note: `'' < anything` — missing starts sort LAST within a group because the comparator treats larger strings as earlier; verify against the test's expected order and flip if needed — the test is the contract.)

`godmode.ts` — add the param + check (`if (item.globalOnly && !isGlobal) return false;` before the resource check); `navSections.tsx` — `globalOnly?: boolean` on `NavItem`, set `globalOnly: true` on Main/Move/People dashboard items; `AppShell.tsx` — destructure `scope` from `useAuth()` and pass `scope?.global ?? true` as the new arg (treat unknown scope as global so nothing flashes hidden pre-load); update `AppShell.test.tsx`'s useAuth mock with a `scope`. `Home.tsx` — top of component:

```tsx
  const { scope } = useAuth();
  if (scope && !scope.global && scope.client_ids.length > 0) {
    return <Navigate to="/dashboards/clients" replace />;
  }
```

(`Navigate` from react-router-dom.)

- [ ] **Step 4: Run focused (all three test files) → PASS, FULL portal suite + build → green, commit**

```bash
git add -A portal && git commit -m "feat(portal): client-dashboard plumbing — wrappers, globalOnly nav, Home redirect"
```

---

### Task 4: The ClientDashboard page

**Files:**
- Create: `portal/src/pages/ClientDashboard.tsx`
- Modify: `portal/src/App.tsx` (swap the Placeholder)
- Modify: `portal/src/styles/dashboard.css` (`/* ── Client dashboard ── */` `cdash-` block)
- Test: `portal/src/pages/ClientDashboard.test.tsx`

**Interfaces:**
- Consumes: Task 3's wrappers/helpers; `listClients()` (`OrgRef[] {id, name, archived_at?}` — verify shape), `getOrg('client', id)` for the identity band (verify the wrapper name StakeholderDetail uses), `listInitiatives`, `listInitiativeAssets`, `listAssets`, `listAssetStatuses`, `moveAssetProgress` (lib/initiatives), `avatarGradient`/`initials`/`relativeTime`/`longDate` (lib/format), charts `Distribution`, scans deep-link helper (lib/scans.ts — its asset branch), PeopleDashboard's refresh idiom.
- Produces: default export `ClientDashboard`.

- [ ] **Step 1: Failing test `portal/src/pages/ClientDashboard.test.tsx`**

House mechanics (hoisted auth + api mocks incl. `listClients`, `getOrg`-equivalent, `listInitiatives`, `listInitiativeAssets`, `listAssets`, `listAssetStatuses`, `getClientActivity`; MemoryRouter). Fixtures: two clients (internal persona) / one client (client persona via `auth.scope`); one active + one finished initiative for client c1; 3 assets (2 in_transit, 1 labeled); activity `{ events: [one row], activity_7d: 9 }`.

```ts
it('internal user gets a client select and panels for the first client', async () => {
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByLabelText('Client')).not.toBeNull());
  expect(screen.queryByText('Acme move')).not.toBeNull();     // initiatives
  expect(screen.queryByText('In Transit')).not.toBeNull();    // fleet dist
  expect(screen.queryByText('9')).not.toBeNull();             // activity 7d KPI
});

it('switching client reloads panels', async () => {
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByLabelText('Client')).not.toBeNull());
  api.getClientActivity.mockClear();
  fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'c2' } });
  await waitFor(() => expect(api.getClientActivity).toHaveBeenCalledWith('c2'));
});

it('single-client user sees static name, no select', async () => {
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  api.listClients.mockResolvedValue([{ id: 'c1', name: 'Acme' }]);
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryAllByText('Acme').length).toBeGreaterThan(0));
  expect(screen.queryByLabelText('Client')).toBeNull();
});

it('permission-poor user sees the empty note', async () => {
  auth.can = (r: string) => r === 'dashboard';
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() =>
    expect(screen.queryByText(/Nothing your permissions/)).not.toBeNull());
});

it('activity rows render with status label and relative time', async () => {
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('core-sw-01')).not.toBeNull());
  expect(screen.queryByText('In Transit')).not.toBeNull();
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement the page** (~330 lines) — same composition discipline as PeopleDashboard.tsx (module consts REFRESH_OPTIONS verbatim, `MAX_PROGRESS_FETCHES = 5`, `nf`, `skel`; state per source; one `refreshAll(selectedId)` with quiet catches + `Promise.allSettled` → `setUpdatedAt`; interval effect; per-permission gates `canClients = can('clients','view')`, `canInitiatives = can('initiatives','view')`, `canAssets = can('assets','view')`).

Client selection:

```tsx
  const [clients, setClients] = useState<OrgRef[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // mount: listClients() -> unarchived, sorted by name; setSelectedId(first)
  // header control: clients.length > 1 -> <select aria-label="Client">;
  // exactly 1 -> <span className="dash-ctrl-static">{clients[0].name}</span>;
  // 0 -> disabled select + page-level "No clients yet."
```

Per-client loads (fired on `selectedId` change AND by refreshAll): `getOrg('client', selectedId)` → identity band; `listInitiatives()` → `sortClientInitiatives(all.filter(i => i.client_id === selectedId))`; `listAssets()` + `listAssetStatuses()` → `assetDistribution` (filter `client_id === selectedId` first); `getClientActivity(selectedId)`. Progress: for the first `MAX_PROGRESS_FETCHES` ACTIVE move-type rows, `listInitiativeAssets(id)` → `moveAssetProgress(rows, statuses)` into `Record<string, {pct, countable}>` (Home.tsx precedent; reuse its state/render shape — `.dash-board-progress`-style bar or the `mdash-wave` fill pattern; pick `.cdash-progress` with `var(--accent)` fill).

Render order in `.dash-grid`: identity band (`cdash-hero`: 44px `.dir-avatar`-style logo box, name `<h2>`, tier chip + status chip, muted meta line joining account_manager?.display_name / website / [city, region] with " · ", panel-link "Client profile" → `/stakeholders/clients/${selectedId}`); KPI strip (Active initiatives = sorted list filtered `!real_end_at` count; Total assets; In transit = fleet count where status === 'in_transit'; Activity · 7d); Initiatives panel span-12 (rows: name Link `/initiatives/${i.id}`, type chip `background: type_color`-tinted per the house chip inline-style convention — check how StakeholderDetail renders type/status chips and copy it, scheduled window `longDate(scheduled_start)` – `longDate(scheduled_end)`, origin→destination names when both present, progress bar when computed); Asset fleet span-5 (`Distribution entries total`); Recent activity span-7 (dot `background: status_color`, asset_name + muted serial, status_label, `site · device`, `relativeTime`, row Link via the scans helper's asset branch). Empty copies per spec. Panels each gated; neither clients/initiatives/assets visible → head + "Nothing your permissions can show here yet."

CSS (`cdash-` block appended to dashboard.css; grep tokens before use, keep fallbacks):

```css
/* ── Client dashboard ─────────────────────────────────────────────── */
.cdash-hero { display: flex; align-items: center; gap: 14px; }
.cdash-hero-logo { width: 44px; height: 44px; border-radius: 12px; flex: none;
  display: grid; place-items: center; color: #fff; font-weight: 600;
  position: relative; overflow: hidden; }
.cdash-hero-logo img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cdash-hero-name { font-size: 18px; font-weight: 650; margin-right: 4px; }
.cdash-hero-meta { font-size: 12.5px; color: var(--text-mute); }
.cdash-hero-spacer { margin-left: auto; }
.cdash-init-row { display: flex; align-items: center; gap: 10px; padding: 9px 0;
  border-bottom: 1px solid var(--paper-line, #eee7da); font-size: 13px; }
.cdash-init-row:last-child { border-bottom: 0; }
.cdash-init-name { font-weight: 600; color: inherit; text-decoration: none; }
.cdash-init-name:hover { text-decoration: underline; }
.cdash-init-dates { color: var(--text-mute); font-size: 12px; }
.cdash-progress { width: 140px; height: 6px; border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 14%, transparent); overflow: hidden; margin-left: auto; }
.cdash-progress .fill { height: 100%; background: var(--accent); }
.cdash-progress-pct { font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 600; width: 36px; text-align: right; }
.cdash-act-row { display: flex; align-items: center; gap: 10px; padding: 7px 0;
  border-bottom: 1px solid var(--paper-line, #eee7da); font-size: 13px;
  color: inherit; text-decoration: none; }
.cdash-act-row:last-child { border-bottom: 0; }
.cdash-act-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.cdash-act-serial { color: var(--text-mute); font-size: 12px; }
.cdash-act-time { margin-left: auto; font-size: 12px; color: var(--text-mute); }
```

(If `color-mix` conflicts with the project's browser floor, use `rgba(var(--accent-rgb), 0.14)` instead — grep which the codebase already uses and match.)

App.tsx: import ClientDashboard, swap only the `/dashboards/clients` element.

- [ ] **Step 4: Run focused → PASS, FULL portal suite + `npm run build` → green, commit**

```bash
git add -A portal && git commit -m "feat(portal): Client Dashboard — picker, identity band, initiatives, fleet, activity"
```

---

### Task 5: Verification — seed both personas + live walkthrough

**Files:** none expected (fixes only if found).

- [ ] **Step 1:** FULL API + portal suites + build foreground → green; tree clean.
- [ ] **Step 2:** `cd api && .venv/bin/alembic upgrade head` (dev DB → 0044).
- [ ] **Step 3:** Seed dev data (dev DB, deliberate):

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/python - << 'EOF'
import asyncio
from sqlalchemy import select, text
from serversherpa.config import get_settings
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, Client, Initiative, Person, PersonRole, UserAccount,
)
from serversherpa.security.passwords import hash_password

async def main():
    async with get_sessionmaker()() as db:
        broadcom = (await db.execute(select(Client).where(
            Client.name == "Broadcom"))).scalar_one()
        # attach the demo move + 20 assets
        await db.execute(text(
            "UPDATE initiatives SET client_id = :c WHERE name LIKE 'NAP11%'"),
            {"c": str(broadcom.id)})
        await db.execute(text(
            "UPDATE assets SET client_id = :c WHERE id IN "
            "(SELECT id FROM assets WHERE archived_at IS NULL LIMIT 20)"),
            {"c": str(broadcom.id)})
        # client-anchored test user
        email = "client-dev@test.example.com"
        existing = (await db.execute(select(Person).where(
            Person.email == email))).scalar_one_or_none()
        if existing is None:
            p = Person(first_name="Client", last_name="Dev", email=email)
            db.add(p)
            await db.flush()
            db.add(UserAccount(person_id=p.id, email=email,
                password_hash=hash_password("client-verify-2026",
                    pepper=get_settings().password_pepper.get_secret_value())))
            db.add(PersonRole(person_id=p.id, role="client_admin",
                              client_id=broadcom.id))
        await db.commit()
        print("Broadcom wired: demo move + 20 assets + client-dev login")

asyncio.run(main())
EOF
```

(If `hash_password` produces an unusable hash the way `bootstrap-admin` once did, follow with `.venv/bin/serversherpa set-password client-dev@test.example.com client-verify-2026` — the known-good path.)

- [ ] **Step 4:** Browser walkthrough, BOTH personas:
  - Internal (claude-dev): `/dashboards/clients` — Client select shows Broadcom, identity band, KPIs (1 active initiative, 20 assets, transit count, activity from any seeded scans on those assets — if zero, add a couple of asset-matched processed scans for the feed), initiatives row with progress bar, fleet distribution, refresh timer tick.
  - Client persona: log in as client-dev@test.example.com in a fresh state (log out first) — verify: redirect from `/` to the client dashboard; nav Dashboards section shows ONLY "Client Dashboard"; no picker (static "Broadcom"); initiatives/assets/activity all Broadcom-only; Initiatives portal page (`/initiatives`) also shows only theirs (bonus of the scoping). Log back in as claude-dev afterward.
  - Screenshots of both personas.
- [ ] **Step 5:** Confirm commits; leave branch unmerged.

## Out of scope (per spec)

Financials (none exist); client writes; partner dashboard; sites panel; notification digests; Move Dashboard client filters.
