# People Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/dashboards/people` placeholder with a live admin dashboard: clocked-in KPIs, a debounced walk-by avatar rail from person badge scans, on-the-clock rows, 14-day hours bars, a timeclock event feed, and the Move Dashboard's auto-refresh timer.

**Architecture:** Two small dashboard-tailored API endpoints (`GET /time/stats/summary`, `GET /scans/people-flow` with server-side 5-minute debounce + presigned avatars) plus existing `/time/active`, `/time/entries`, `/workers`. One portal page composed of per-permission panels (Home.tsx style), pure helpers in `lib/peopleDashboard.ts`, house SVG chart primitives, `pdash-` CSS block in dashboard.css.

**Tech Stack:** FastAPI/SQLAlchemy async/pytest (real Postgres); React/TS/vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-people-dashboard-design.md`

## Global Constraints

- All suites FOREGROUND, one continuous run, `timeout: 600000` ms — NEVER background a run, never use Monitor, never end a turn "waiting". API: `cd api && .venv/bin/pytest` (986 at branch HEAD `3fc1441`). Portal: `cd portal && npm test` (749) + `npm run build`.
- `git checkout -- api/src/serversherpa/_dev_reload.py` if dirty; never commit it.
- API errors `{"detail": {"code": ...}}`; endpoints gated: `/time/stats/summary` → `require_permission("time","view")`; `/scans/people-flow` → `require_permission("scans","view")`.
- Debounce: `FLOW_DEBOUNCE_MINUTES = 5`, per `(person_id, device_id)`, kept event = EARLIEST read of a burst; a read >5 min after the previously KEPT read (or a different reader) starts a new event. `distinct_people_today` / `person_scans_today` are computed over ALL of today's person scans (pre-debounce; distinct person_ids), independent of `since`/`limit`.
- "Clocked in" = `clock_out_at IS NULL`; worked minutes per the existing `_minutes()` rule (open entries contribute 0). Day buckets are UTC, zero-filled, oldest first, today included (the `/scans/stats/daily` convention).
- Dashboard visuals: pure SVG primitives from `components/dashboard/charts.tsx`; single-series marks `var(--accent)`; multi-hue always direct label + count; `.dash-rise` staggering; `.dash-skel` skeletons; `Intl.NumberFormat` for counts.
- Refresh timer copied verbatim from MoveDashboard (`REFRESH_OPTIONS` Off/15s/30s/60s/5 min/15 min, default Off, `initial`-style non-blanking refresh, `.dash-asof` pulsing dot).
- No changes to existing endpoints' behavior; portal panels degrade by permission (`time`, `scans`, `workers`), avatars degrade to `avatarGradient`+`initials`.

---

### Task 1: `GET /time/stats/summary`

**Files:**
- Modify: `api/src/serversherpa/api/routes/time.py`
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_time_stats_api.py`

**Interfaces:**
- Consumes: existing `TimeEntry` model, `_minutes(entry)` helper already in `time.py` (returns 0 while open; else floor(span/60) − break, clamped ≥ 0), `require_permission`.
- Produces: `GET /time/stats/summary?days=` (default 14, 1–90) → `TimeStatsSummaryOut { clocked_in: int, pending_entries: int, minutes_today: int, days: [TimeDayStat { day: date, minutes: int }] }`. Wire day format `"2026-09-02"`.

- [ ] **Step 1: Write the failing tests `api/tests/test_time_stats_api.py`**

```python
"""Dashboard time aggregates: open count, pending count, zero-filled days."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Person, TimeEntry

from tests.test_status_values_write import _make


async def _person(db, first="Tess", last="Clock"):
    p = Person(first_name=first, last_name=last,
               email=f"{first}.{last}@test.example.com".lower())
    db.add(p)
    await db.flush()
    return p


async def test_summary_counts_and_days(client, db, seeded_user):
    now = datetime.now(UTC)
    p = await _person(db)
    # open entry (clocked in) — contributes 0 minutes
    db.add(TimeEntry(person_id=p.id, clock_in_at=now - timedelta(hours=3)))
    # closed entry today: 120 min span, 30 min break -> 90 worked, pending
    db.add(TimeEntry(person_id=p.id, clock_in_at=now - timedelta(hours=6),
                     clock_out_at=now - timedelta(hours=4),
                     break_minutes=30, status="pending"))
    # closed entry 3 days ago: 60 min, approved
    db.add(TimeEntry(person_id=p.id,
                     clock_in_at=now - timedelta(days=3, hours=2),
                     clock_out_at=now - timedelta(days=3, hours=1),
                     status="approved"))
    # entry outside the window: excluded from days
    db.add(TimeEntry(person_id=p.id,
                     clock_in_at=now - timedelta(days=40, hours=2),
                     clock_out_at=now - timedelta(days=40, hours=1)))
    await db.commit()

    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/time/stats/summary", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["clocked_in"] == 1
    assert body["pending_entries"] == 1
    assert body["minutes_today"] == 90
    assert len(body["days"]) == 14
    assert body["days"][-1]["day"] == now.date().isoformat()
    assert body["days"][-1]["minutes"] == 90
    day3 = (now - timedelta(days=3)).date().isoformat()
    assert next(d for d in body["days"] if d["day"] == day3)["minutes"] == 60
    # zero-filled elsewhere
    assert sum(d["minutes"] for d in body["days"]) == 150


async def test_summary_days_param_and_empty(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/time/stats/summary?days=7", headers=hdrs)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["days"]) == 7
    assert body["clocked_in"] == 0 and body["minutes_today"] == 0
    assert all(d["minutes"] == 0 for d in body["days"])
```

Timezone caution: the "3 days ago" entry uses `now - 3 days` — if `now` is within 2h of UTC midnight the `-2 hours` shift could land it a day earlier. Make the test robust: compute `base = now.replace(hour=12, minute=0, second=0, microsecond=0)` and derive all today/older stamps from `base` (12:00 UTC) instead of raw `now` — adjust the code above accordingly when writing the file (keep the same durations so the minute math is unchanged; `minutes_today` asserts then hold for any run time).

- [ ] **Step 2: Run → FAIL (404)**

Run: `cd api && .venv/bin/pytest tests/test_time_stats_api.py -v` (foreground, timeout 600000)

- [ ] **Step 3: Append schemas to `api/src/serversherpa/api/schemas.py`**

```python
class TimeDayStat(BaseModel):
    day: date
    minutes: int


class TimeStatsSummaryOut(BaseModel):
    clocked_in: int
    pending_entries: int
    minutes_today: int
    days: list[TimeDayStat]
```

(`date` is already imported at the top of schemas.py for `ScanDailyStat` — verify, add to the import if not.)

- [ ] **Step 4: Add the route to `api/src/serversherpa/api/routes/time.py`**

Place after `GET /time/summary`. Reuse the file's existing imports where present (`func`, `select`, `Query`, `datetime`, `UTC`, `timedelta`); add missing ones in its style — the `time.min` combine needs `from datetime import time as dt_time` if the module's own name `time` collides (this file is `time.py`; check its header — it already handles this, mirror it).

```python
@router.get("/stats/summary", response_model=TimeStatsSummaryOut)
async def time_stats_summary(
    db: DbSession,
    _actor: AuthContext = require_permission("time", "view"),
    days: int = Query(14, ge=1, le=90),
) -> TimeStatsSummaryOut:
    """Dashboard aggregates: open/pending counts + worked minutes per UTC
    day, zero-filled oldest-first with today included (the
    /scans/stats/daily convention). Minutes follow _minutes(): open
    entries contribute 0; closed span minus break, clamped >= 0.
    Aggregated in Python — time_entries stays small (one row per shift).
    """
    clocked_in = (await db.execute(
        select(func.count()).select_from(TimeEntry)
        .where(TimeEntry.clock_out_at.is_(None)))).scalar_one()
    pending = (await db.execute(
        select(func.count()).select_from(TimeEntry)
        .where(TimeEntry.status == "pending"))).scalar_one()

    start_day = datetime.now(UTC).date() - timedelta(days=days - 1)
    start = datetime.combine(start_day, dt_time.min, tzinfo=UTC)
    rows = (await db.execute(select(TimeEntry).where(
        TimeEntry.clock_in_at >= start))).scalars().all()
    per_day: dict = {}
    for e in rows:
        d = e.clock_in_at.date()
        per_day[d] = per_day.get(d, 0) + _minutes(e)
    out_days = [
        TimeDayStat(day=start_day + timedelta(days=i),
                    minutes=per_day.get(start_day + timedelta(days=i), 0))
        for i in range(days)
    ]
    return TimeStatsSummaryOut(
        clocked_in=clocked_in, pending_entries=pending,
        minutes_today=out_days[-1].minutes, days=out_days)
```

(`_minutes` signature: check its exact name/args at the top of time.py — the worked-minutes helper described in the docstring — and call it as defined there.)

- [ ] **Step 5: Run focused → PASS, FULL API suite foreground → green, commit**

```bash
git add -A api && git commit -m "feat(api): /time/stats/summary dashboard aggregates"
```

---

### Task 2: `GET /scans/people-flow`

**Files:**
- Modify: `api/src/serversherpa/api/routes/scans.py`
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_scans_people_flow_api.py`

**Interfaces:**
- Consumes: `ProcessedScan` (person match = `match_type == 'person'` AND `person_id IS NOT NULL`; also filter `archived_at IS NULL`), `Person` (display_name, avatar_key), `Site`, `presign_get` from `serversherpa.services.storage`.
- Produces: `GET /scans/people-flow?since=&limit=` (limit default 60, 1–200) → `PeopleFlowOut { events: [PeopleFlowEvent { person_id, display_name, avatar_url: str|None, device_id, site_name: str|None, scanned_at }], distinct_people_today: int, person_scans_today: int }`, events newest-first, debounced per Global Constraints. Module constant `FLOW_DEBOUNCE_MINUTES = 5`.

- [ ] **Step 1: Write the failing tests `api/tests/test_scans_people_flow_api.py`**

```python
"""Walk-by rail feed: burst debounce, counts, avatars, gate."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Person, ProcessedScan, Site

from tests.test_status_values_write import _make


def _scan(person, at, device="dock-reader-1", site_id=None):
    return ProcessedScan(scanned_value=str(person.id), scan_type="rfid",
                         status="labeled", scanned_at=at, device_id=device,
                         site_id=site_id, match_type="person",
                         person_id=person.id, processed_at=at)


async def _people(db):
    a = Person(first_name="Ada", last_name="Lovelace",
               email="ada@test.example.com")
    b = Person(first_name="Grace", last_name="Hopper",
               email="grace@test.example.com")
    db.add(a)
    db.add(b)
    await db.flush()
    return a, b


async def test_burst_debounce_and_order(client, db, seeded_user):
    now = datetime.now(UTC).replace(microsecond=0)
    a, b = await _people(db)
    site = Site(name="NAP11 - Switch")
    db.add(site)
    await db.flush()
    # Ada burst at dock-reader-1: 3 reads inside 5 min -> ONE event at the EARLIEST
    for mins in (30, 29, 27):
        db.add(_scan(a, now - timedelta(minutes=mins), site_id=site.id))
    # Ada again at the same reader 10 min later (> 5 min after kept) -> new event
    db.add(_scan(a, now - timedelta(minutes=18), site_id=site.id))
    # Ada at a DIFFERENT reader inside 5 min of that -> its own event
    db.add(_scan(a, now - timedelta(minutes=17), device="cage-reader"))
    # Grace once
    db.add(_scan(b, now - timedelta(minutes=5)))
    await db.commit()

    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/scans/people-flow", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    evs = body["events"]
    assert [(e["display_name"], e["device_id"]) for e in evs] == [
        ("Grace Hopper", "dock-reader-1"),
        ("Ada Lovelace", "cage-reader"),
        ("Ada Lovelace", "dock-reader-1"),
        ("Ada Lovelace", "dock-reader-1"),
    ]
    # burst folded to the EARLIEST read (minute 30, not 27)
    assert evs[-1]["scanned_at"].startswith(
        (now - timedelta(minutes=30)).isoformat()[:16])
    assert evs[-1]["site_name"] == "NAP11 - Switch"
    assert evs[0]["avatar_url"] is None  # no avatar_key -> None passthrough
    # counts are PRE-debounce / distinct people
    assert body["person_scans_today"] == 6
    assert body["distinct_people_today"] == 2


async def test_limit_and_since(client, db, seeded_user):
    now = datetime.now(UTC)
    a, _b = await _people(db)
    for i in range(3):
        db.add(_scan(a, now - timedelta(minutes=30 * i), device=f"r{i}"))
    await db.commit()
    hdrs = await _make(db, client, "adm2", "adm2@test.example.com") \
        if False else await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/scans/people-flow?limit=2", headers=hdrs)
    assert len(resp.json()["events"]) == 2
    assert resp.json()["person_scans_today"] == 3  # counts ignore limit
    cutoff = (now - timedelta(minutes=45)).isoformat()
    resp = await client.get(f"/scans/people-flow?since={cutoff}", headers=hdrs)
    assert len(resp.json()["events"]) == 2  # r0 (now) and r1 (-30m) only


async def test_empty_and_gate(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/scans/people-flow", headers=hdrs)
    assert resp.json() == {"events": [], "distinct_people_today": 0,
                           "person_scans_today": 0}
```

(Clean up the `if False else` remnant when writing — one admin login helper call only. If the seeded status vocab lacks `labeled` for the `status` generated-FK, pick any seeded asset-status key — check the 0025 seeds; `scan_type="rfid"` is seeded. If ProcessedScan requires other NOT NULL fields the model defaults don't cover, set them minimally.)

- [ ] **Step 2: Run → FAIL (404)**

- [ ] **Step 3: Append schemas**

```python
class PeopleFlowEvent(BaseModel):
    person_id: uuid.UUID
    display_name: str
    avatar_url: str | None
    device_id: str
    site_name: str | None
    scanned_at: datetime


class PeopleFlowOut(BaseModel):
    events: list[PeopleFlowEvent]
    distinct_people_today: int
    person_scans_today: int
```

- [ ] **Step 4: Add the route to `api/src/serversherpa/api/routes/scans.py`**

Add imports the file lacks (`Person`, `Site`, `presign_get` via `from serversherpa.services.storage import presign_get`, `timedelta`, `time` for `time.min` — the file already imports `datetime`/`time` for stats/daily; reuse its exact aliases).

```python
FLOW_DEBOUNCE_MINUTES = 5


@router.get("/people-flow", response_model=PeopleFlowOut)
async def people_flow(
    db: DbSession,
    _actor: AuthContext = require_permission("scans", "view"),
    since: datetime | None = None,
    limit: int = Query(60, ge=1, le=200),
) -> PeopleFlowOut:
    """Debounced person-badge walk-bys for the People Dashboard.

    Bursts (same person, same reader, reads within FLOW_DEBOUNCE_MINUTES
    of the kept read) fold into ONE event stamped at the burst's EARLIEST
    read — when the person arrived at the reader. A later read or a
    different reader starts a new event. The two counts cover ALL of
    today's person scans (pre-debounce; distinct people), regardless of
    since/limit, so the dashboard KPIs ride the same call.
    """
    today_start = datetime.combine(datetime.now(UTC).date(), time.min,
                                   tzinfo=UTC)
    if since is None:
        since = today_start
    person_match = (
        (ProcessedScan.match_type == "person")
        & ProcessedScan.person_id.is_not(None)
        & ProcessedScan.archived_at.is_(None))

    scans_today, people_today = (await db.execute(
        select(func.count(),
               func.count(func.distinct(ProcessedScan.person_id)))
        .where(person_match, ProcessedScan.scanned_at >= today_start))).one()

    rows = (await db.execute(select(ProcessedScan)
        .where(person_match, ProcessedScan.scanned_at >= since)
        .order_by(ProcessedScan.scanned_at))).scalars().all()

    kept: list[ProcessedScan] = []
    last_kept_at: dict[tuple, datetime] = {}
    for s in rows:  # oldest -> newest so a burst keeps its first read
        k = (s.person_id, s.device_id)
        prev = last_kept_at.get(k)
        if prev is not None and (s.scanned_at - prev) <= timedelta(
                minutes=FLOW_DEBOUNCE_MINUTES):
            continue
        last_kept_at[k] = s.scanned_at
        kept.append(s)
    kept.reverse()  # newest first
    kept = kept[:limit]

    person_ids = {s.person_id for s in kept}
    people = {p.id: p for p in (await db.execute(
        select(Person).where(Person.id.in_(person_ids)))).scalars()}
    site_ids = {s.site_id for s in kept if s.site_id is not None}
    sites = {r.id: r.name for r in (await db.execute(
        select(Site).where(Site.id.in_(site_ids)))).scalars()} if site_ids else {}
    avatar = {pid: presign_get(p.avatar_key) for pid, p in people.items()}

    events = [PeopleFlowEvent(
        person_id=s.person_id,
        display_name=people[s.person_id].display_name if s.person_id in people else "Unknown",
        avatar_url=avatar.get(s.person_id),
        device_id=s.device_id,
        site_name=sites.get(s.site_id),
        scanned_at=s.scanned_at,
    ) for s in kept]
    return PeopleFlowOut(events=events, distinct_people_today=people_today,
                         person_scans_today=scans_today)
```

(`Person.display_name` — check the model: it may be a column or a Python property; if it's a hybrid/property built from first/last, the attribute access above works on loaded instances either way.)

- [ ] **Step 5: Run focused → PASS, FULL API suite foreground → green, commit**

```bash
git add -A api && git commit -m "feat(api): /scans/people-flow debounced walk-by feed"
```

---

### Task 3: Portal client wrappers + pure helpers

**Files:**
- Modify: `portal/src/lib/api.ts` (`// ── People dashboard ──` section)
- Create: `portal/src/lib/peopleDashboard.ts`
- Test: `portal/src/lib/peopleDashboard.test.ts`

**Interfaces:**
- Consumes: house fetcher pattern (`apiFetch` + `errorFrom`); `TimeEntryItem` type (lib/api.ts ~1620 — verify exact field names: `id`, `person_id`, `person_name`, `clock_in_at`, `clock_out_at`, `minutes`, `initiative_name`, `site_name`); `DayPoint` from `../components/dashboard/charts`.
- Produces (Task 4 imports these exact names):
  - api.ts: `interface TimeDayStat { day: string; minutes: number }`; `interface TimeStatsSummary { clocked_in: number; pending_entries: number; minutes_today: number; days: TimeDayStat[] }`; `interface PeopleFlowEvent { person_id: string; display_name: string; avatar_url: string | null; device_id: string; site_name: string | null; scanned_at: string }`; `interface PeopleFlowOut { events: PeopleFlowEvent[]; distinct_people_today: number; person_scans_today: number }`; `getTimeStatsSummary(): Promise<TimeStatsSummary>` (GET `/time/stats/summary`); `getPeopleFlow(): Promise<PeopleFlowOut>` (GET `/scans/people-flow`).
  - peopleDashboard.ts: `interface TimeclockEvent { key: string; kind: 'in' | 'out'; person_id: string; person_name: string; at: string; minutes: number | null; context: string }`; `buildTimeclockEvents(entries: TimeEntryItem[], cap: number): TimeclockEvent[]`; `hoursDayPoints(days: TimeDayStat[]): DayPoint[]`.

- [ ] **Step 1: Write failing tests `portal/src/lib/peopleDashboard.test.ts`** (node env, no jsdom pragma)

```ts
import { expect, it } from 'vitest';

import type { TimeEntryItem } from './api';
import { buildTimeclockEvents, hoursDayPoints } from './peopleDashboard';

const E = (over: Partial<TimeEntryItem>): TimeEntryItem => ({
  id: 'e1', person_id: 'p1', person_name: 'Ada Lovelace',
  initiative_id: null, initiative_name: null, site_id: null, site_name: null,
  clock_in_at: '2026-09-02T09:00:00Z', clock_out_at: null, break_minutes: 0,
  status: 'open', status_label: 'Open', status_color: '#333', minutes: 0,
  source: 'punch', notes: '', adjusted: false,
  ...over,
} as TimeEntryItem);

it('emits in and out events interleaved newest-first with cap', () => {
  const entries = [
    E({ id: 'e2', clock_in_at: '2026-09-02T08:00:00Z',
        clock_out_at: '2026-09-02T12:30:00Z', minutes: 270,
        site_name: 'NAP11' }),
    E({ id: 'e1', clock_in_at: '2026-09-02T09:00:00Z' }), // still open
  ];
  const evs = buildTimeclockEvents(entries, 20);
  expect(evs.map((e) => `${e.kind}@${e.at}`)).toEqual([
    'out@2026-09-02T12:30:00Z',
    'in@2026-09-02T09:00:00Z',
    'in@2026-09-02T08:00:00Z',
  ]);
  expect(evs[0].minutes).toBe(270);
  expect(evs[0].context).toBe('NAP11');
  expect(evs[1].minutes).toBeNull();
  expect(buildTimeclockEvents(entries, 2)).toHaveLength(2);
});

it('prefers initiative over site as context', () => {
  const evs = buildTimeclockEvents(
    [E({ initiative_name: 'NAP11 Hall Migration', site_name: 'NAP11' })], 5);
  expect(evs[0].context).toBe('NAP11 Hall Migration');
});

it('hoursDayPoints maps day stats to chart points', () => {
  const pts = hoursDayPoints([
    { day: '2026-08-30', minutes: 0 },
    { day: '2026-09-02', minutes: 480 },
  ]);
  expect(pts).toHaveLength(2);
  expect(pts[1]).toMatchObject({ key: '2026-09-02', value: 480 });
  expect(pts[1].label).toMatch(/Sep/);
});
```

(Adjust the `E` fixture's field list to `TimeEntryItem`'s real shape — extra/missing keys break `tsc -b`; the `as TimeEntryItem` widening keeps it tolerant but fill genuine required fields.)

- [ ] **Step 2: Run → FAIL** (`cd portal && npx vitest run src/lib/peopleDashboard.test.ts`)

- [ ] **Step 3: Implement**

api.ts section — four interfaces exactly as the Interfaces block, plus:

```ts
export async function getTimeStatsSummary(): Promise<TimeStatsSummary> {
  const resp = await apiFetch('/time/stats/summary');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getPeopleFlow(): Promise<PeopleFlowOut> {
  const resp = await apiFetch('/scans/people-flow');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

`portal/src/lib/peopleDashboard.ts`:

```ts
/**
 * Pure People Dashboard helpers — event-feed derivation and chart-point
 * mapping. No React, no fetching.
 */

import type { DayPoint } from '../components/dashboard/charts';
import type { TimeDayStat, TimeEntryItem } from './api';

export interface TimeclockEvent {
  key: string;
  kind: 'in' | 'out';
  person_id: string;
  person_name: string;
  at: string;
  minutes: number | null;
  context: string;
}

/** Each entry emits an IN event and, when closed, an OUT event carrying
 *  its worked minutes; interleaved newest-first, capped. ISO strings
 *  compare lexicographically so no Date parsing is needed. */
export function buildTimeclockEvents(
  entries: TimeEntryItem[], cap: number,
): TimeclockEvent[] {
  const out: TimeclockEvent[] = [];
  for (const e of entries) {
    const context = e.initiative_name ?? e.site_name ?? '';
    out.push({ key: `${e.id}-in`, kind: 'in', person_id: e.person_id,
               person_name: e.person_name, at: e.clock_in_at,
               minutes: null, context });
    if (e.clock_out_at) {
      out.push({ key: `${e.id}-out`, kind: 'out', person_id: e.person_id,
                 person_name: e.person_name, at: e.clock_out_at,
                 minutes: e.minutes, context });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, cap);
}

export function hoursDayPoints(days: TimeDayStat[]): DayPoint[] {
  return days.map((d) => ({
    key: d.day,
    label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    }),
    value: d.minutes,
  }));
}
```

- [ ] **Step 4: Run focused → PASS, full portal suite + build → green, commit**

```bash
git add -A portal && git commit -m "feat(portal): people-dashboard client wrappers + pure helpers"
```

---

### Task 4: The PeopleDashboard page

**Files:**
- Create: `portal/src/pages/PeopleDashboard.tsx`
- Modify: `portal/src/App.tsx` (swap the `/dashboards/people` Placeholder for `<PeopleDashboard />`; ProtectedRoute resource="dashboard" stays)
- Modify: `portal/src/styles/dashboard.css` (append `/* ── People dashboard ── */` `pdash-` block)
- Test: `portal/src/pages/PeopleDashboard.test.tsx`

**Interfaces:**
- Consumes: Task 3 wrappers/helpers; `listActiveTimeEntries()`, `listTimeEntries(q)` (check the wrapper — pass `{ limit: 40 }` if it forwards `limit`, else `{}` and `.slice(0, 40)`), `listWorkers()`; `DailyBars`; `avatarGradient`, `initials`, `relativeTime` (lib/format); `elapsedSince`, `formatMinutes` (lib/timeFormat); MoveDashboard's refresh idiom.
- Produces: default export `PeopleDashboard`.

- [ ] **Step 1: Write the failing test `portal/src/pages/PeopleDashboard.test.tsx`**

House mechanics (hoisted mocks, top-level `await import` after mocks, MemoryRouter). Stub ResizeObserver (jsdom lacks it): `vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });` in beforeEach. Mock auth `can: () => true` (overridable per test). Mock api:

```ts
const api = vi.hoisted(() => ({
  getTimeStatsSummary: vi.fn(),
  getPeopleFlow: vi.fn(),
  listActiveTimeEntries: vi.fn(),
  listTimeEntries: vi.fn(),
  listWorkers: vi.fn(),
}));
```

Fixtures: summary `{ clocked_in: 3, pending_entries: 2, minutes_today: 510, days: [...14 zero-filled with today 510] }`; flow `{ events: [{ person_id: 'p1', display_name: 'Ada Lovelace', avatar_url: null, device_id: 'dock-reader-1', site_name: 'NAP11', scanned_at: <now-ish iso> }], distinct_people_today: 4, person_scans_today: 12 }`; active `[TimeEntryItem open for Ada, clock_in_at 3h ago]`; entries `[the closed+open pair from Task 3's test]`; workers `[]`.

Tests:

```ts
it('renders KPI values from both sources', async () => {
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Clocked in now')).not.toBeNull());
  expect(screen.queryByText('3')).not.toBeNull();          // clocked in
  expect(screen.queryByText('4')).not.toBeNull();          // on site today
  expect(screen.queryByText('8h 30m')).not.toBeNull();     // 510 minutes
  expect(screen.queryByText('12')).not.toBeNull();         // badge scans
});

it('walk-by rail renders newest-first cards with initials fallback', async () => {
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Ada')).not.toBeNull());
  expect(screen.queryByText('AL')).not.toBeNull();         // initials, no avatar
  expect(screen.queryByText('dock-reader-1')).not.toBeNull();
});

it('on-the-clock rows show elapsed and the event feed interleaves', async () => {
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('On the clock now')).not.toBeNull());
  expect(screen.queryAllByText(/clocked in/i).length).toBeGreaterThan(0);
  expect(screen.queryByText(/clocked out/i)).not.toBeNull();
});

it('auto-refresh interval refetches without blanking', async () => {
  vi.useFakeTimers();
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const before = api.getTimeStatsSummary.mock.calls.length;
  fireEvent.change(screen.getByLabelText(/Auto-refresh/i), { target: { value: '15' } });
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(api.getTimeStatsSummary.mock.calls.length).toBeGreaterThan(before);
  vi.useRealTimers();
});

it('panels hide without their resource', async () => {
  auth.can = (r: string) => r === 'dashboard';
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await waitFor(() =>
    expect(screen.queryByText(/Nothing your permissions/)).not.toBeNull());
  expect(screen.queryByText('Reader walk-bys')).toBeNull();
});
```

(The Auto-refresh select needs an accessible name — wrap in `<label className="dash-ctrl"><span>Auto-refresh</span><select aria-label="Auto-refresh" …>` so `getByLabelText` works; MoveDashboard's bare label/span association may not expose it — the aria-label guarantees it. If the fake-timers test fights the initial fetches, `await act(async () => {})` flush first; keep the assertion "called more after advancing".)

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement `portal/src/pages/PeopleDashboard.tsx`**

Full component (~340 lines). Structure — follow this skeleton exactly, filling straightforward JSX:

```tsx
/**
 * People Dashboard — desk-density view of the workforce right now:
 * clocked-in KPIs, a debounced walk-by rail of badge reads, live
 * on-the-clock rows, 14-day hours, and a timeclock event feed.
 * Refresh idiom mirrors MoveDashboard (interval select; ticks never
 * blank loaded panels). Panels gate on their own resources (Home.tsx
 * style); avatars degrade to the initials gradient.
 */

const REFRESH_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '15s', seconds: 15 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
];
const MISSED_PUNCH_MINUTES = 720; // 12h — same rule/copy as TimeManagement
const nf = new Intl.NumberFormat();
const skel = <span className="dash-skel" aria-label="loading" />;
```

State + refresh (the load cycle):

```tsx
  const { can } = useAuth();
  const canTime = can('time', 'view');
  const canScans = can('scans', 'view');
  const canWorkers = can('workers', 'view');

  const [summary, setSummary] = useState<TimeStatsSummary | null>(null);
  const [flow, setFlow] = useState<PeopleFlowOut | null>(null);
  const [active, setActive] = useState<TimeEntryItem[] | null>(null);
  const [entries, setEntries] = useState<TimeEntryItem[] | null>(null);
  const [workers, setWorkers] = useState<WorkerItem[]>([]);
  const [refreshSec, setRefreshSec] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refreshAll = useCallback(() => {
    const quiet = () => undefined; // a failed fetch keeps the last data
    const jobs: Promise<unknown>[] = [];
    if (canTime) {
      jobs.push(getTimeStatsSummary().then(setSummary).catch(quiet));
      jobs.push(listActiveTimeEntries().then(setActive).catch(quiet));
      jobs.push(listTimeEntries({ limit: 40 }).then(setEntries).catch(quiet));
    }
    if (canScans) jobs.push(getPeopleFlow().then(setFlow).catch(quiet));
    if (canWorkers) jobs.push(listWorkers().then(setWorkers).catch(quiet));
    if (jobs.length) {
      void Promise.allSettled(jobs).then(() => setUpdatedAt(new Date()));
    }
  }, [canTime, canScans, canWorkers]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  useEffect(() => {
    if (!refreshSec) return;
    const t = setInterval(refreshAll, refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec, refreshAll]);

  const [, setTick] = useState(0);           // 30s live-elapsed tick
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const avatarByPerson = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workers) if (w.avatar_url) m.set(w.person_id, w.avatar_url);
    return m;
  }, [workers]);
  const events = useMemo(() => buildTimeclockEvents(entries ?? [], 20), [entries]);
  const hoursDays = useMemo(() => hoursDayPoints(summary?.days ?? []), [summary]);
```

Render, in order inside `.portal-page`: eyebrow "Dashboards"; `.dash-head` with title + `.dash-ctrls` (Auto-refresh `<select aria-label="Auto-refresh">` from REFRESH_OPTIONS + `.dash-asof` with pulsing dot when `refreshSec > 0`); if neither canTime nor canScans → single `.dash-panel-empty` "Nothing your permissions can show here yet." and stop; `.dash-grid` with:

1. **KPI strip** `.dash-kpis.dash-rise`: tiles rendered conditionally — canTime: "Clocked in now" (`nf.format(summary.clocked_in)`, `<Link to="/people/time" className="dash-kpi">`), "Hours today" (`formatMinutes(summary.minutes_today)`), "Pending approvals" (Link, `nf.format(summary.pending_entries)`); canScans: "On site today" (`nf.format(flow.distinct_people_today)`), "Badge scans today". `skel` while the source is null.
2. **Walk-by rail** (canScans) `section.dash-panel.dash-span-12.dash-rise`, panel-head title "Reader walk-bys" + `.dash-panel-link` to `/admin/scans`; body = `WalkByRail` local component: `.pdash-rail-wrap` with two nudge `mini-btn`s (‹ ›, `className="mini-btn pdash-rail-nudge left|right"`, hidden while content fits — ResizeObserver on the scroller sets `fits`; `scrollBy({ left: ±320, behavior: 'smooth' })`) around `.pdash-rail` (ref'd div); cards per event:

```tsx
<Link key={`${e.person_id}|${e.device_id}|${e.scanned_at}`}
      className="pdash-flow-card dash-rise" title={e.display_name}
      to={`/people/users?open=${encodeURIComponent(e.person_id)}`}>
  <div className="dir-avatar pdash-flow-avatar"
       style={{ background: e.avatar_url ? 'var(--surface-2)' : avatarGradient(e.display_name) }}>
    {e.avatar_url ? <img src={e.avatar_url} alt="" /> : initials(e.display_name)}
  </div>
  <div className="pdash-flow-name">{e.display_name.split(/\s+/)[0]}</div>
  <span className="chip tag">{e.device_id || 'reader'}</span>
  <div className="pdash-flow-time">{relativeTime(e.scanned_at)}</div>
</Link>
```

  Empty: `.dash-panel-empty` "No badge reads yet today." Loading (flow null): "Loading…".
3. **On the clock now** (canTime) `dash-span-7`: panel-link "Time Management" → `/people/time`; rows from `active` (already oldest-first from the API): `.pdash-clock-row` — 36px `.dir-avatar` (avatarByPerson.get(person_id) or gradient+initials of person_name) · `<Link className="pdash-clock-name" to={`/people/workers/${e.person_id}`}>{e.person_name}</Link>` · `.pdash-clock-meta` "since {new Date(e.clock_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}"` + (initiative/site chip when present) · `.pdash-clock-elapsed` `formatMinutes(elapsedSince(e.clock_in_at))` + when `elapsedSince(...) >= MISSED_PUNCH_MINUTES` a `chip tag time-flag` "12h+ — missed punch?". Empty: "Nobody is clocked in."
4. **Hours logged — 14 days** (canTime) `dash-span-5`: `DailyBars days={hoursDays} ariaLabel="Hours logged per day" formatTooltip={(d) => `${d.label}: ${formatMinutes(d.value)}`}`; all-zero → `.dash-panel-empty` "No time logged in the last 14 days."
5. **Latest timeclock events** (canTime) `dash-span-12`: rows per `events`: colored dot (`.dash-scan-dot` style — green `#178a4c` for in, `#51606f` slate for out via inline background), `<b>{person_name}</b>`, text "clocked in" / `clocked out · ${formatMinutes(ev.minutes ?? 0)}`, context chip when non-empty, right-aligned `relativeTime(ev.at)`; rows are `<Link to="/people/time">`. Empty: "No timeclock activity yet."

Imports: exactly the ones the skeleton uses (see Task 3/consumes list) + `import '../styles/dashboard.css'; import '../styles/directory.css'; import '../styles/time.css';` (time-flag chip). If `listTimeEntries`'s wrapper doesn't forward `limit`, call `listTimeEntries({})` and `.slice(0, 40)` before storing.

- [ ] **Step 4: CSS — append to `portal/src/styles/dashboard.css`**

```css
/* ── People dashboard ─────────────────────────────────────────────── */
.pdash-rail-wrap { position: relative; }
.pdash-rail {
  display: flex; gap: 12px; overflow-x: auto; padding: 4px 2px 10px;
  scroll-snap-type: x proximity; scrollbar-width: thin;
}
.pdash-flow-card {
  flex: 0 0 150px; scroll-snap-align: start;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 12px 8px; border: 1px solid var(--line, #e5e1d8);
  border-radius: 12px; text-decoration: none; color: inherit;
}
.pdash-flow-card:hover { border-color: rgba(var(--accent-rgb), 0.55); }
.pdash-flow-avatar { width: 56px; height: 56px; border-radius: 16px; font-size: 18px; }
.pdash-flow-name {
  font-size: 13px; font-weight: 600; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pdash-flow-time { font-size: 11.5px; color: var(--text-mute); }
.pdash-rail-nudge { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; }
.pdash-rail-nudge.left { left: -6px; }
.pdash-rail-nudge.right { right: -6px; }

.pdash-clock-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 0;
  border-bottom: 1px solid var(--line, #eee7da);
}
.pdash-clock-row:last-child { border-bottom: 0; }
.pdash-clock-row .dir-avatar { width: 36px; height: 36px; border-radius: 10px; font-size: 12px; }
.pdash-clock-name { font-weight: 600; font-size: 13.5px; color: inherit; text-decoration: none; }
.pdash-clock-name:hover { text-decoration: underline; }
.pdash-clock-meta { font-size: 12px; color: var(--text-mute); }
.pdash-clock-elapsed { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }

.pdash-event-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 0;
  border-bottom: 1px solid var(--line, #eee7da);
  color: inherit; text-decoration: none; font-size: 13px;
}
.pdash-event-row:last-child { border-bottom: 0; }
.pdash-event-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.pdash-event-time { margin-left: auto; font-size: 12px; color: var(--text-mute); }
```

Before committing: grep `--line` / `--surface-2` / `--text-mute` / `--accent-rgb` in portal/src/styles/portal-theme.css and swap any missing token for one that exists (keep the literal fallbacks).

- [ ] **Step 5: Route swap in App.tsx** (import PeopleDashboard; replace the Placeholder element for `/dashboards/people` only).

- [ ] **Step 6: Run focused → PASS, FULL portal suite + `npm run build` → green, commit**

```bash
git add -A portal && git commit -m "feat(portal): People Dashboard — KPIs, walk-by rail, clock panels, refresh timer"
```

---

### Task 5: Verification — seed + live walkthrough

**Files:** none expected (fixes only if found).

- [ ] **Step 1:** FULL API suite + FULL portal suite + build, all foreground → green; tree clean (`_dev_reload.py` reverted).
- [ ] **Step 2:** Seed live-ish dev data (dev DB, main checkout — the guard only protects test DBs; this is the DEV database, seeded deliberately):

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/python - << 'EOF'
import asyncio
from datetime import UTC, datetime, timedelta
from sqlalchemy import select, text
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import Person, ProcessedScan, TimeEntry

async def main():
    now = datetime.now(UTC)
    async with get_sessionmaker()() as db:
        people = (await db.execute(select(Person).where(
            Person.archived_at.is_(None)).limit(6))).scalars().all()
        for i, p in enumerate(people):
            db.add(ProcessedScan(scanned_value=str(p.id), scan_type="rfid",
                status="labeled", scanned_at=now - timedelta(minutes=4 * i + 2),
                device_id="dock-reader-1" if i % 2 else "warehouse-reader-1",
                match_type="person", person_id=p.id,
                processed_at=now))
        for p in people[:3]:
            db.add(TimeEntry(person_id=p.id,
                             clock_in_at=now - timedelta(hours=2, minutes=13 * people.index(p))))
        db.add(TimeEntry(person_id=people[3].id,
                         clock_in_at=now - timedelta(hours=9),
                         clock_out_at=now - timedelta(hours=1),
                         status="pending"))
        await db.commit()
        print("seeded", len(people), "walk-bys, 3 open + 1 pending entries")

asyncio.run(main())
EOF
```

(If `status="labeled"` violates the generated-column FK, use a key that exists in the dev vocab — check with the same session. Adjust field names to the model if needed.)

- [ ] **Step 3:** Browser walkthrough (known login/scroll quirks): open `/dashboards/people` — KPIs populated (Clocked in 3, Pending 1, On site/Badge scans from seeds), walk-by rail shows avatar cards (several seeded people have real V2 photos) newest-first with reader chips, On-the-clock rows tick, Hours bars render (the pending 8h entry lands today), event feed interleaves in/out. Set Auto-refresh 15s → pulsing dot + "updated" stamp advances; add one more ProcessedScan row via the seeding session and watch it appear on the next tick without the page blanking. Screenshot proof (rail + KPIs visible).
- [ ] **Step 4:** Confirm commits; leave branch unmerged.

## Out of scope (per spec)

TV/wall board; Move Dashboard "Workers on site" stub fill; per-site rail filter; V2 timeclock import.
