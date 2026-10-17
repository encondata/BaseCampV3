# Kiosk-Attached Readers on Fixed Readers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An RFID-Station laptop reports its paired FX9600 (make, model, MAC, IP, uptime, antennas, Reading/Standby, 24 h raw-read count) through the kiosk heartbeat. The portal keeps a `fixed_reader` device for it, which Fixed Readers lists with new **Make** and **Status** columns.

**Architecture:**
- **Edge:** `edge.rfid.reader_report` builds a snapshot every 60 s on its own loop, independent of internet. The heartbeat rewrite in `routes/proxy.py` adds `reader` to the body when the snapshot is fresh.
- **API:** the kiosk heartbeat validates `reader` loosely, then upserts a `fixed_reader` Device. `/devices` derives `make`, `reader_status`, `antennas_total` and the reported `tags_read_24h`.
- **Portal:** the Fixed Readers page gets the two new columns.

**Tech Stack:** Python 3.12, FastAPI, sqlite3 (edge); FastAPI, SQLAlchemy async, Postgres (API); React 18, TypeScript, vitest (portal).

**Spec:** `docs/superpowers/specs/2026-10-16-fixed-reader-report-design.md` — read it; every value below comes from it.

## Global Constraints

**Where to work:** worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/fixed-reader-report`, branch `fixed-reader-report`.

**First-time setup in this worktree:**
- `cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'` (Python 3.12 or newer)
- `npm --prefix portal ci`

**Git rules:**
- Stage files **by explicit path only**. Never use `git add -A`, `git add .` or `git add -f`.
- Commits end with `Co-Authored-By:` naming your model.

**Suites** (all in the FOREGROUND, with a 600000 ms timeout):
- Edge: `cd kiosk_laptop/edge && .venv/bin/pytest -q`
- API, focused: `cd api && SS_TEST_DB=serversherpa_test_fixed_reader PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q tests/test_kiosk_heartbeat_api.py tests/test_kiosk_heartbeat_reader.py tests/test_devices_api.py`
  - `serversherpa_test_fixed_reader` is this branch's own test DB, created by the harness.
  - Read `api/tests/conftest.py` first. Never point tests at the dev DB.
- Portal: `npm --prefix portal test -- --run src/pages/FixedReaders.test.tsx src/lib` and `npm --prefix portal run build`

**Schema and copy:**
- **No migration.** The new values live in `devices.raw_info`.
- Copy, comments and docs use American English.

**Fixed values:**
- Snapshot every **60 s**.
- The heartbeat attaches a snapshot taken in the last **3 minutes**.
- Status is **offline** when `last_seen_at` is null or older than **3 minutes**.
- `make` is always `"Zebra"`.
- `connection_type` is `"local_api"`.
- Reader strings are at most 64 characters. The MAC is six hex pairs; the IP is IPv4.

**A bad `reader` never fails the kiosk heartbeat.** It is dropped and logged (serial only), and the rest of the beat proceeds.

**Lists:**
- Fixed Readers keeps the list-column-floor rules: default columns plus trailing must fit `LIST_FIT.page`.
- The list guardrail tests must stay green: run `npm --prefix portal test -- --run src/lib` (they live there).

## Review Focus

1. **`/cloud/network` fails while version and status work** (an older firmware, for example): the snapshot still goes out with mac, ip and name null. The portal still creates or updates the record and never 422s. (Task 1 `test_snapshot_without_network_call`; Task 2 `test_reader_with_only_serial_is_accepted`.)
2. **The reader is unreachable at the first snapshot:** the snapshot carries the serial from the pairing, with `reachable: false`. The portal creates the record but leaves `last_seen_at` null, so it shows Offline. (Task 1 `test_unreachable_first_snapshot`; Task 2 `test_unreachable_snapshot_creates_offline_record`.)
3. **The serial already belongs to a kiosk or router:** the reader report is ignored, and the heartbeat still returns 200 with the kiosk updated. (Task 2 `test_serial_owned_by_other_type_is_ignored`.)
4. **A hand-made fixed reader with the same serial:** it is adopted and updated, but its name is kept, so its scan counts still join. (Task 2 `test_existing_fixed_reader_keeps_its_name`.)
5. **The station switches to Label, or the pairing is gone:** no `reader` is sent, and the record goes Offline after 3 minutes. (Task 1 `test_no_reader_on_heartbeat_for_label_station`; Task 3 `test_reader_status_offline_after_3_minutes`.)

---

### Task 1: Edge reader snapshot and heartbeat attach

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/reader_report.py`
- Modify:
  - `src/edge/rfid/ziotc.py`: add `async def network(self) -> dict` (`GET /cloud/network`, like `version`).
  - `src/edge/routes/proxy.py`: the heartbeat rewrite adds `reader`.
  - `src/edge/app.py`: start and stop the reporter alongside `Background`.
  - `tests/fake_reader.py`: add `/cloud/network` (fields `macAddress`, `ipAddress`, `hostName`; a `network_fails` flag gives a 404), plus an `uptime` field in STATUS like `"357:6:17"`.
- Test: `kiosk_laptop/edge/tests/test_reader_report.py` (new), plus a test in `tests/test_proxy.py`.

**Interfaces:**
- `parse_uptime(value) -> int | None`: `"h:m:s"` with any number of hours, giving seconds. Anything else gives None.
- `async build_snapshot(state, *, now: datetime | None = None) -> dict | None`:
  - Returns None when there is no current pairing (`pairing.current_row`) or the laptop setup isn't `station_type == "rfid"`.
  - Otherwise it calls version, network and status under `state.pair_lock` via `pairing.open_current`. Each call is tried independently; a failing call leaves its fields absent.
  - Returns the spec §2 dict:
    - `serial` (from the row when the reader is unreachable)
    - `make` (`"Zebra"`), `model`, `name` (hostName), `mac`, `ip`, `firmware` (readerApplication)
    - `uptime_seconds`, `antennas_connected`, `antennas_total` (len of `antennas`), `reading` (`ziotc.is_reading`)
    - `tags_24h`: the count of `raw_tag_reads` for this serial with `received_at >= now - 24 h`, formatted like `db.iso`
    - `reachable` (False when `open_current`/version raised)
    - `taken_at` (`db.now_iso()`)
  - Values that fail the spec's limits are omitted (strings over 64 characters, a bad MAC or IP).
  - When unreachable, it keeps the previous snapshot's values and sets `reachable: false`, `tags_24h` and `taken_at` fresh.
- `class ReaderReporter(state)`:
  - `start()` and `stop()`.
  - A loop every 60 s that sets `state.reader_snapshot`.
  - The loop never raises: errors are logged, type only.
- `current_snapshot(state, *, now=None) -> dict | None` returns the snapshot only when `taken_at` is within 3 minutes.
- **`rewrite_body`:** for `/kiosk/heartbeat`, when `current_snapshot(...)` is not None, add `data["reader"] = snapshot`.
  - Pass the snapshot in as a parameter, so `rewrite_body(path, body, identity, reader=None)` stays pure; the caller supplies it.

**Tests:**
- `test_parse_uptime`:
  - `"357:6:17"` gives 1285577;
  - `"0:0:5"` gives 5;
  - `""`, `"x"` and None give None.
- `test_snapshot_fields`: pair the fake reader (helpers from `tests/test_rfid_pairing.py`) with an RFID laptop setup (`laptop_setup.save(..., "rfid")`). Every spec field matches the fake, `make == "Zebra"`, `antennas_connected == 2` and `antennas_total == 4`.
- `test_tags_24h_counts_only_this_reader_and_window`: rows at now−1 h (this serial), now−25 h (this serial) and now−1 h (another serial) give 1.
- `test_snapshot_without_network_call`: with the fake's `network_fails`, `mac`, `ip` and `name` are absent; `model` and `reading` are present.
- `test_unreachable_first_snapshot`: with the reader unreachable, the result is `{"serial": SERIAL, "make": "Zebra", "reachable": False, "tags_24h": 0, ...}`.
- `test_unreachable_keeps_last_values`.
- `test_no_snapshot_without_pairing_or_label_station`.
- `test_reporter_loop_survives_errors`: `build_snapshot` raises once, and the next tick still sets the snapshot.
- In `test_proxy.py`:
  - `test_heartbeat_carries_fresh_reader`: the upstream body has `reader.serial`.
  - `test_stale_snapshot_not_sent`: `taken_at` 4 minutes ago means no `reader` key.
  - `test_no_reader_on_heartbeat_for_label_station`.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the edge suite; all pass.
- [ ] Commit: `feat(edge): RFID station reports its reader on the kiosk heartbeat`

---

### Task 2: API — heartbeat upserts the fixed reader

**Files:**
- Modify:
  - `api/src/serversherpa/api/schemas.py`: `HeartbeatIn.reader: dict | None = None` (loose), plus a strict `KioskReaderReport` model used inside the route.
  - `api/src/serversherpa/api/routes/kiosk.py`: the heartbeat route.
- Create: `api/src/serversherpa/services/fixed_readers.py`
- Test: `api/tests/test_kiosk_heartbeat_reader.py` (new)

**Interfaces:**
- `KioskReaderReport` (pydantic):
  - `serial: str`, 1–64 characters, the only required field.
  - `make`, `model`, `name`, `firmware`: `str | None`, at most 64 characters.
  - `mac`: `str | None`, matching `^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$`.
  - `ip`: `IPv4Address | None`.
  - `uptime_seconds`, `antennas_connected`, `antennas_total`, `tags_24h`: non-negative `int | None`.
  - `reading`, `reachable`: `bool | None`.
  - `taken_at`: `datetime | None`.
  - `model_config = ConfigDict(extra="ignore")`.
- `async def apply_reader_report(db, *, kiosk: Device, report: dict, actor_id) -> Device | None` in `services/fixed_readers.py`. It is called by the heartbeat after the kiosk row is updated, and **never raises out to the route**: it catches validation errors, logs the serial at most, and returns None. Rules (spec §3–4):
  - **Ignore unless** `kiosk.station_type == "rfid"` and `report.serial == kiosk.rfid_reader_serial`.
  - **Serial held by another device type:** ignore and log.
  - **Field mapping:** as in the spec table.
    - `name` is set only when creating: `report.name or f"FX9600 {serial}"`.
    - `last_seen_at` is set only when `reachable is not False`.
    - `scan_status`, `site_id` and `current_initiative_id` are copied from `kiosk`.
    - `raw_info` is merged with `make`, `reading`, `reachable`, `reported_tags_24h`, `antennas_total`, `reported_at` (ISO), `via_kiosk_id` and `via_kiosk_name`.
  - **Creation** is audited once: action `self_register`, changes `{serial, name, via_kiosk}`.

**Tests in `test_kiosk_heartbeat_reader.py`:**
- `test_reader_creates_fixed_reader`: an rfid kiosk (setup through `POST /kiosk/setup` with a reader, as in `tests/test_kiosk_station_setup.py`) plus a heartbeat with a full report gives one `fixed_reader` with:
  - name `FX9600647D23`, mac, `lan_ip`, model, version, uptime and `antennas_connected`;
  - `connection_type "local_api"`;
  - `scan_status` and `site_id` equal to the kiosk's;
  - `raw_info.make "Zebra"`;
  - exactly one `self_register` audit.
- `test_second_beat_updates_without_audit`.
- `test_reader_with_only_serial_is_accepted`.
- `test_bad_mac_is_dropped_not_422`: the response is 200, the kiosk's `last_seen_at` is updated, and no fixed reader is created.
- `test_serial_not_paired_is_ignored`.
- `test_label_station_reader_ignored`.
- `test_serial_owned_by_other_type_is_ignored`: a router holding that serial gives a 200 and no change to the router.
- `test_existing_fixed_reader_keeps_its_name`: a pre-made fixed reader named `Dock door 3` with that serial keeps that name, but its mac and site are updated.
- `test_unreachable_snapshot_creates_offline_record`: `reachable false` creates the record with `last_seen_at` None.
- `test_reader_moves_to_another_kiosk`: `raw_info.via_kiosk_name` updates in place, still one row.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the focused API suites; all pass.
- [ ] Commit: `feat(api): kiosk heartbeat keeps a fixed reader for an RFID station's reader`

---

### Task 3: API — `/devices` derives make, status, antennas and reported tags

**Files:**
- Modify:
  - `api/src/serversherpa/api/routes/devices.py`: `_row_to_item`.
  - `api/src/serversherpa/api/schemas.py`: `DeviceItem` gains `make: str | None`, `reader_status: Literal["reading", "standby", "offline"] | None`, and `antennas_total: int | None`.
- Test: `api/tests/test_devices_api.py` (add tests)

**Rules (spec §4):** for `device_type == "fixed_reader"` only. Other types get None for all three.
- `make` = `raw_info.make`.
- `reader_status`:
  - `offline` when `last_seen_at` is None or older than 3 minutes;
  - else `reading` when `raw_info.reading` is true;
  - else `standby`.
- `antennas_total` = `raw_info.antennas_total`.
- `tags_read_24h` = `raw_info.reported_tags_24h` when `raw_info.via_kiosk_id` is set and the status isn't `offline`. Otherwise the existing raw-plus-processed count.

**Tests:**
- `test_reader_status_reading_standby`.
- `test_reader_status_offline_after_3_minutes`: `last_seen_at` now−4 minutes gives `offline`.
- `test_reported_tags_used_while_fresh_else_scan_counts`: a fresh kiosk-attached reader reports 1832. Stale, it falls back to the portal scan count (seed 2 raw_scans under the reader's name and expect 2).
- `test_non_reader_devices_have_null_reader_fields`.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the focused API suites; all pass.
- [ ] Commit: `feat(api): /devices reports make, reader status and kiosk-reported tags for fixed readers`

---

### Task 4: Fixed Readers page — Make and Status columns

**Files:**
- Modify:
  - `portal/src/lib/api.ts`: `DeviceItem` gains `make`, `reader_status` and `antennas_total`.
  - `portal/src/lib/devices.ts`: cell text, sort value and search text for `make` and `status`. `antennas` shows `${connected} / ${antennas_total ?? 8}`.
  - `portal/src/pages/FixedReaders.tsx`: columns, CSV and facets.
- Test: `portal/src/pages/FixedReaders.test.tsx`, and `portal/src/lib/devices.test.ts` if it exists.

**Columns:**

| Key | Label | Placement | Default | Cell |
|---|---|---|---|---|
| `status` | Status | after Name | visible | a chip: **Reading** `c-green`, **Standby** `c-slate`, **Offline** `c-red`; `—` for null (reuse the page's existing chip idiom) |
| `make` | Make | before Model | visible | `make ?? '—'` |

- Both get CSV columns.
- `status` is a facet group (Reading, Standby, Offline) next to the existing Site, Connection and Scan Type facets.
- Widths follow the list-column-floor rules. The defaults plus trailing must fit `LIST_FIT.page`; tighten existing tracks if needed. The existing guardrail tests in `src/lib` must stay green.

**Tests:**
- Columns and cells render for a reading reader with make Zebra and antennas `2 / 4`.
- The Status facet filters Offline.
- The CSV has the Make and Status columns.
- A device with `antennas_total` null shows `/ 8`.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the portal tests named above and `npm --prefix portal run build`; all pass.
- [ ] Commit: `feat(portal): Fixed Readers shows Make and Reading/Standby/Offline status`
