# People Dashboard

**Date:** 2026-09-02
**Branch:** `labels` (continues the current working branch)
**Status:** Approved design

## Purpose

Replace the `/dashboards/people` placeholder with a desk-density admin
dashboard: who's clocked in, what the timeclock is doing, and a live
"walk-by" rail of people as their badges pass RFID readers — with the Move
Dashboard's auto-refresh timer. A wall/TV status board is a separate future
project; this page optimizes for an admin at a desk (drill-down links,
dense rows), while keeping the KPI numbers glanceable.

## Data & API (approach A)

Two new endpoints, everything else reused. Both follow the
`/scans/stats/daily` conventions (zero-filled days, UTC day buckets,
documented docstrings).

### `GET /scans/people-flow` (gate `scans:view`)

Params: `since` (datetime, default start of today UTC), `limit`
(default 60, 1–200). Returns debounced person-scan events, newest first:

```json
[{ "person_id": "...", "display_name": "Lori Gonzales",
   "avatar_url": "https://...presigned...", "device_id": "dock-reader-1",
   "site_name": "NAP11 - Switch", "scanned_at": "2026-09-02T14:31:07Z" }]
```

- Source rows: `processed_scans` where `match_type='person'`,
  `archived_at IS NULL`, `scanned_at >= since`.
- **Debounce (5 minutes, module constant `FLOW_DEBOUNCE_MINUTES = 5`):**
  scanning newest→oldest per (person_id, device_id), a read within 5
  minutes of the previously kept read for that pair is folded into it —
  and the kept event's timestamp becomes the EARLIEST read of the burst
  (when the person arrived at the reader). A read >5 min after the
  previous kept read, or at a different reader, is a new event.
  Implemented in Python over the windowed query (bounded by `since`).
- `display_name` from `Person.display_name`; `avatar_url` via
  `presign_get(person.avatar_key)` (None when no photo); `site_name`
  denormalized like the existing scans payloads. People are batch-loaded
  (one query), not per-row.
- Also returns header-ish aggregates alongside the list to feed KPIs in
  one call: response shape is
  `{ "events": [...], "distinct_people_today": N, "person_scans_today": M }`
  where the two counts are computed over ALL of today's person scans
  (pre-debounce for `person_scans_today`, distinct person_ids for
  `distinct_people_today`) regardless of `limit`.

### `GET /time/stats/summary` (gate `time:view`)

Params: `days` (default 14, 1–90). Returns:

```json
{ "clocked_in": 4, "pending_entries": 7, "minutes_today": 1260,
  "days": [{ "day": "2026-08-20", "minutes": 2400 }, ...] }
```

- `clocked_in`: count of entries with `clock_out_at IS NULL` (the
  canonical rule).
- `pending_entries`: count with `status = 'pending'`.
- `minutes_today` and each `days[].minutes`: sum of the worked-minutes
  rule (`_minutes()` — closed span minus break, ≥0; open entries
  contribute 0) for entries whose `clock_in_at` falls in that UTC day.
  Zero-filled, oldest first, today included.

### Reused endpoints

- `GET /time/active` (time:view) — on-the-clock rows (person_name,
  clock_in_at, initiative/site names).
- `GET /time/entries?limit=40` (time:view) — feed source.
- `GET /workers` (workers:view) — OPTIONAL avatar join for the time
  panels (person_id → avatar_url, display_name); loaded once per refresh
  cycle, failure or missing permission degrades to initials-gradient
  avatars (initials need only the name, which time payloads carry).

## Page (`portal/src/pages/PeopleDashboard.tsx`)

Route swap in App.tsx (ProtectedRoute resource="dashboard" unchanged).
Panels additionally gate on their own resources client-side, Home.tsx
style: time panels need `can('time','view')`, the rail and scan KPIs need
`can('scans','view')`. A user with neither sees the page head plus a
`.dash-panel-empty` note ("Nothing your permissions can show here yet.").

### Header

`.dash-head`: eyebrow "Dashboards", title "People Dashboard", and
`.dash-ctrls` with the Move Dashboard's Auto-refresh select — module
constant reuse is NOT possible across files today, so copy
`REFRESH_OPTIONS` verbatim (Off/15s/30s/60s/5 min/15 min, default Off) —
plus the `.dash-asof` pulsing-dot "updated HH:MM:SS" indicator. One
`refreshAll(initial)` callback loads all sources; the interval effect
mirrors MoveDashboard.tsx:144-164 (`initial=false` on ticks so panels
never blank; teardown on Off/unmount).

### KPI strip (`.dash-kpis`, five `.dash-kpi` tiles)

1. **Clocked in now** — `summary.clocked_in`; Link to `/people/time`.
2. **On site today** — `flow.distinct_people_today`.
3. **Hours today** — `formatMinutes(summary.minutes_today)`.
4. **Pending approvals** — `summary.pending_entries`; Link to
   `/people/time`.
5. **Badge scans today** — `flow.person_scans_today`.

Skeleton (`.dash-skel`) while loading; tiles without their permission are
omitted (strip auto-fits).

### Walk-by rail (`section.dash-panel.dash-span-12`, title "Reader walk-bys")

- Horizontal scroller `.pdash-rail`: `display:flex; gap:12px;
  overflow-x:auto;` with `scroll-snap-type: x proximity`, thin scrollbar,
  and two nudge buttons (`.pdash-rail-nudge`, ‹ ›) that
  `scrollBy({left: ±320, behavior:'smooth'})`; buttons hidden when
  content fits.
- Card `.pdash-flow-card` (fixed width ~150px): 56px avatar (`.dir-avatar`
  sizing overridden locally — photo `object-fit:cover`, else
  `avatarGradient(name)` + `initials(name)`), first line = first name
  (full name in `title`), second line = reader chip (`chip tag`,
  device_id), third = `relativeTime(scanned_at)` muted. Card links to
  `/people/users?open=<person_id>` (the existing person deep-link
  convention).
- Newest first (left). On refresh, genuinely new events (unseen
  person+device+timestamp keys) mount with the `dash-rise` animation;
  reduced-motion disables it via the existing media query.
- Empty state `.dash-panel-empty`: "No badge reads yet today."

### On the clock now (`dash-span-7`)

Rows from `/time/active`, oldest first (longest on the clock at top):
36px avatar (join or initials) · name (link `/people/workers/<person_id>`)
· "since 9:02 AM" · live elapsed via the 30s tick precedent
(`elapsedSince` + `formatMinutes`) · initiative or site chip when present
· the `12h+ — missed punch?` flag at `MISSED_PUNCH_MINUTES = 720`
(copied constant, same copy). Panel link "Time Management" →
`/people/time`. Empty: "Nobody is clocked in."

### Hours logged — 14 days (`dash-span-5`)

`DailyBars` fed from `summary.days` mapped to `DayPoint`
(`value = minutes`), tooltip `"{label}: {formatMinutes(minutes)}"`,
aria-label "Hours logged per day". Single-series → `var(--accent)` per
the house dataviz rule. Empty (all zero): `.dash-panel-empty`
"No time logged in the last 14 days."

### Timeclock events (`dash-span-12`, title "Latest timeclock events")

Derived client-side from `/time/entries?limit=40`: each entry emits an
IN event at `clock_in_at` (green `.dash-scan-dot`-style dot) and, when
`clock_out_at` is set, an OUT event (slate dot) carrying
`formatMinutes(minutes)`. Interleave, sort desc, cap 20. Row: dot ·
name · "clocked in"/"clocked out · 8h 12m" · initiative/site ·
`relativeTime`. Rows link to `/people/time`. Empty: "No timeclock
activity yet."

## Visual/system rules

- Pure-SVG primitives only (`charts.tsx`); single-series = `var(--accent)`;
  any multi-hue element carries direct label + count (dataviz-validated
  house rule). New CSS in a `/* ── People dashboard ── */` block of
  `dashboard.css` using the `pdash-` prefix (mirrors `mdash-`).
- `.dash-rise` staggering on panels; `nf = Intl.NumberFormat` for counts;
  `dash-skel` skeletons; failed panel fetches keep the previous data
  (quiet catch, Home precedent).

## Error handling

- Each fetch caught independently; a panel that has never loaded shows
  its loading/empty state, one that has loaded keeps stale data (the
  as-of stamp only advances on a successful cycle of at least one fetch).
- Presign failures yield `avatar_url: null` → initials fallback.
- `/scans/people-flow` with a future `since` or empty table returns
  `{events: [], distinct_people_today: 0, person_scans_today: 0}`.

## Testing

- API: people-flow debounce unit-style tests through the endpoint (burst
  at one reader folds to earliest timestamp; >5 min gap splits; different
  reader splits; counts are pre-debounce/distinct; avatar presign None
  passthrough; scans:view gate). time stats summary (clocked_in counts
  open only, minutes zero-filled per day, pending count, gate).
- Portal: page test with mocked api — KPI values render; rail renders
  cards newest-first with initials fallback; on-the-clock rows tick
  elapsed; event feed interleaves in/out correctly; refresh select wires
  an interval (fake timers, assert refetch); permission gating hides
  panels.
- Live verification: dev DB has 100k+ scans and seeded people — seed a
  couple of person-matched processed scans + open time entries, walk the
  page in the browser, screenshot proof.

## Out of scope

TV/wall status board (future project); filling Move Dashboard's
"Workers on site" stub tile (noted follow-up); per-site filtering of the
rail; V2 timeclock history import.
