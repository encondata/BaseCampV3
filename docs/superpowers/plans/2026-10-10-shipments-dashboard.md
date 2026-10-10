# Shipment Tracking Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Shipments dashboard with an auto-refreshing map of trucks and their current-trip tracks, a truck/container update feed, counts and a trucks table.

**Architecture:** Migration 0096 adds `trucks.trip_started_at` (maintained on status changes) and two indexes. `api/routes/trucks.py` gains map params (trip window, cap, move/status filters, set-based trails, destination), `GET /trucks/feed` and `GET /trucks/summary`. The portal adds `pages/ShipmentsDashboard.tsx` plus nav/route wiring and turns the Home "coming soon" badge into a link.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, pytest; React + TypeScript, react-leaflet, vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-shipments-dashboard-design.md` — binding.

## Global Constraints

- Migration **0096** (`api/migrations/versions/0096_truck_trip_and_feed_indexes.py`, `down_revision = "0095"`): `trucks.trip_started_at`, `ix_truck_updates_recorded_at`, `ix_audit_log_entity_type_at`, backfill per the spec.
- Trip rule: `trip_started_at = now()` when status changes into `active` or `in_transit` from any status other than those two; unchanged otherwise. Every status writer.
- `TRAIL_POINT_CAP = 500`; trails oldest→newest; set-based (no per-truck queries).
- Feed: kinds `location`, `status`, `load`, `unload`; `limit` default 50, max 200; `before` cursor; response `{events, next_before}` where `next_before` is an opaque cursor string (compound `at~id`) that the portal passes back verbatim and URL-encoded, and a bare ISO `before` still means strictly older; stable event ids.
- All new/changed endpoints gated by `trucks:view`; routes declared above `/{truck_id}`.
- Refresh options Off / 15 s / 30 s / 60 s / 5 min, default 30 s; pause while hidden, refresh on becoming visible.
- Portal copy: nav "Shipments"; title "Shipment tracking"; picker "All moves"; counts "In transit", "Loading", "At destination", "Containers on board"; map empty "No trucks with a recorded position yet. Add a location update on a truck to see it here."; feed "Show older"; Home badge link "Live tracking →".
- House idioms (dash-* CSS, `ComboBox`, `dir-list`/`ColHead`/`listGridStyle` + column floors, `relativeTime`, status chips), natural sort, American English.
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to run things (worktree `.claude/worktrees/shipments-dash`)

- API tests (foreground, one at a time): `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_shipments DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>` (`PYTHONPATH` required). **Any alembic command must set `SS_DATABASE_URL` to the test DB.** Never the dev DB.
- Portal: `cd portal && npx vitest run <files>`; before committing portal work run the full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: Trip start, indexes, map params and summary

**Files:** create `api/migrations/versions/0096_truck_trip_and_feed_indexes.py`; modify `db/models.py` (`Truck.trip_started_at`, indexes if models declare them), `api/routes/trucks.py`, `trucks/bulk_import.py` (status writes), `api/schemas.py`; tests `api/tests/test_migration_0096_truck_trip.py`, `api/tests/test_trucks_map_trip.py`.

**Produces:** `Truck.trip_started_at`; a single helper `apply_status_change(truck, new_status, now)` (or equivalent) used by every status writer; `/trucks/map` params `initiative_id`, `statuses`, `trip`; `TruckMapPoint.end_site`; `GET /trucks/summary`.

- [ ] Step 1: failing tests for the migration (backfill cases), trip rule on PATCH and bulk import, map params (filters, trip window, cap, order, end_site, query count flat across N trucks — count statements with a SQLAlchemy event listener), summary, 403s.
- [ ] Step 2: run; confirm failure. Step 3: implement. Step 4: run new files + `tests/test_trucks*.py` + `tests/test_bulk_trucks*` — pass; ruff clean. Step 5: commit `feat(trucks): trip start time, current-trip map tracks and shipment summary (migration 0096)`.

### Task 2: Feed endpoint

**Files:** modify `api/routes/trucks.py` (or a new `trucks/feed.py` module used by the route), `api/schemas.py`; test `api/tests/test_trucks_feed.py`.

**Produces:** `GET /trucks/feed` per the spec.

- [ ] Step 1: failing tests for every feed item in the spec's Testing paragraph (seed truck_updates and audit rows directly; check how kiosk load/unload and PATCH container changes are audited and cover each).
- [ ] Step 2–4 as above (+ `tests/test_kiosk*truck*` if present). Step 5: commit `feat(trucks): shipment update feed (locations, status changes, loads and unloads)`.

### Task 3: Portal — Shipments dashboard

**Files:** create `portal/src/pages/ShipmentsDashboard.tsx` (+ test), `portal/src/lib/shipments.ts` (+ test, for feed text/formatting); modify `portal/src/lib/api.ts`, `portal/src/layout/navSections.tsx`, `portal/src/App.tsx`, `portal/src/components/Topbar.tsx` (crumbs + command palette), `portal/src/components/dashboard/TransitMap.tsx` (badge → link), CSS beside the dashboard/trucks styles.

- [ ] Step 1: failing tests per the spec's Portal testing paragraph (fake timers for refresh; dispatch `visibilitychange` with `document.hidden` stubbed).
- [ ] Step 2: run; confirm failure. Step 3: implement (reuse `TrucksMap`; follow `pages/PeopleDashboard.tsx` / `MoveDashboard.tsx` refresh idiom; Trucks page fullscreen modal pattern). Step 4: full `npx vitest run`, `npx tsc -b`, `npm run build`. Step 5: commit `feat(portal): Shipment tracking dashboard with live map and update feed`.
