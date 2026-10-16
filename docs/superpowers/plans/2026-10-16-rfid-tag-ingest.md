# RFID Tag Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The laptop kiosk accepts the paired FX9600's tag-data POSTs on port 8091, stores every tag event in SQLite `raw_tag_reads` (plus an `rfid_tags_seen` summary), and the `/rfid_status` dashboard shows real tag counts, move progress and live reads.

**Architecture:**
- `edge.rfid.tagreads` parses Zebra events and writes a batch in one transaction.
- `edge.rfid.ingest` is a tiny ASGI app for `POST /rfid/{serial}/{token}`. It shares `app.state` with the 8090 app.
- `python -m edge serve` runs both uvicorn servers in one event loop.
- `GET /edge/rfid/reads` (8090) feeds the dashboard.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, sqlite3 (edge); React 18 + TypeScript + vitest (kiosk).

**Spec:** `docs/superpowers/specs/2026-10-16-rfid-tag-ingest-design.md` — read it; every value below comes from it.

## Global Constraints

**Where to work:**
- Worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/rfid-ingest`, branch `rfid-ingest`.
- First-time setup in this worktree:
  - `cd kiosk_laptop/edge && python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'` (or `python3`, if 3.12 is the default);
  - `npm --prefix kiosk ci`.

**Git rules:**
- Stage files **by explicit path only**. Never use `git add -A`, `git add .` or `git add -f`.
- Commit messages end with a `Co-Authored-By:` line naming your model, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Suites** (all in the FOREGROUND, with a 600000 ms timeout):
- Edge: `cd kiosk_laptop/edge && .venv/bin/pytest -q`. Use plain `pytest` (CI does).
- Kiosk: `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build`.

**Copy and schema:**
- Copy, comments and docs use American English.
- `SCHEMA_STEPS` in `kiosk_laptop/edge/src/edge/db.py` is append-only. Add ONE new step at the end, never edit earlier ones.

**Fixed values:**
- Max body: **5 MB** (5 * 1024 * 1024 bytes) → 413.
- EPC: `data.idHex`, whitespace stripped, uppercased, 1–128 hex characters.
- `read_at` ≤ 64 characters; `event_type` ≤ 32 characters.
- "Tag data receiving" event after **5 minutes** without an accepted batch.
- Recent reads: **50**.
- Dashboard poll: the existing chained **5000 ms**.

**Security:**
- The pairing token is compared with `hmac.compare_digest`.
- It is never logged, and never in a response or event.

**Retention:** none (rows stay until Wipe). Wipe clears `raw_tag_reads` and `rfid_tags_seen`.

## Review Focus

1. **A batch where one event is garbage:** the good events are stored and the bad ones counted as skipped; the whole batch is never rejected. (Task 1 test: `test_mixed_batch_stores_good_events`.)
2. **The reader re-sends after a 500:** a write failure must roll back the whole batch (no half-stored batch), so a retry doesn't duplicate half of it. (Task 2 test: `test_write_failure_rolls_back_and_returns_500`.)
3. **The laptop isn't set up yet, or was just wiped:** reads still store, with NULL setup columns, and the dashboard reads endpoint returns null move counts instead of crashing. (Task 1 `test_rows_without_setup_have_null_context`; Task 4 `test_reads_without_setup_or_cache`.)
4. **An asset's rfid stored with different case or spaces from the reader's EPC:** it still matches. (Task 4 `test_asset_match_ignores_case_and_spaces`.)
5. **Midnight in the laptop's time zone, not UTC:** a read at 23:30 local time yesterday is not counted today. (Task 4 `test_tags_today_uses_local_midnight`.)

---

### Task 1: Storage, parsing and Wipe

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/tagreads.py`
- Modify: `kiosk_laptop/edge/src/edge/db.py` (append one SCHEMA_STEP: both tables and three indexes exactly as in spec §4)
- Modify: `kiosk_laptop/edge/src/edge/routes/edge.py` (`MOVE_TABLES` += `"raw_tag_reads", "rfid_tags_seen"`)
- Modify: `kiosk_laptop/edge/tests/fake_reader.py` (event builders)
- Test: `kiosk_laptop/edge/tests/test_tagreads.py` (new), plus a Wipe assertion in `tests/test_edge_routes.py`

**Interfaces:**
- Produces:
  - `normalize_epc(value) -> str | None`: strips all whitespace and uppercases. It returns None unless the result is 1–128 hex characters. Task 4 reuses it for asset rfids.
  - `parse_events(body) -> tuple[list[dict], int]`: `body` is the decoded JSON (a dict or a list). It returns `(rows, skipped)`. Each row dict has the spec §4 column names except `id`, `received_at`, `reader_serial` and the setup columns. `raw_json` is `json.dumps(event, separators=(",", ":"))`. Raise `ValueError` when `body` is neither a dict nor a list.
  - `store_batch(store, *, reader_serial: str, rows: list[dict], setup: dict | None, received_at: str | None = None) -> int`:
    - one `store.tx()` inserts every row and upserts `rfid_tags_seen`;
    - it returns the number stored;
    - `setup` is `laptop_setup.load(store)` (keys `initiative_id`, `site_id`, `scan_status`);
    - `received_at` defaults to `now_iso()`.
  - `fake_reader.tag_event(epc: str, *, antenna=1, peak_rssi=-52, reads=1, event_num=1, timestamp="2026-10-16T14:03:22.512+0000", **extra_data) -> dict` returns a Zebra SIMPLE event (spec §2 shape).
  - `fake_reader.tag_batch(n: int, prefix="E28011606000020D6A1B") -> list[dict]` returns n events with distinct EPCs `prefix + f"{i:04X}"`.

**Tests in `test_tagreads.py`:**
- `test_normalize_epc`:
  - `" e2 80 11 "` → `"E28011"`;
  - `""`, `"xyz"` and 129 hex characters → None;
  - non-str → None.
- `test_single_object_is_one_row`: `parse_events(tag_event("e2801160"))` returns a row with `epc == "E2801160"`, `antenna == 1`, `peak_rssi == -52.0`, and skipped 0.
- `test_mixed_batch_stores_good_events`: a list of `[tag_event("AA01"), {"type": "HEARTBEAT", "data": {}}, tag_event("not-hex"), "junk"]` gives 1 row and skipped 3.
- `test_non_numeric_fields_become_null`: an event with `antenna: "x"` and `peakRssi: None` gives both columns None. An over-long `timestamp` (65 characters) gives `read_at` None.
- `test_parse_events_rejects_scalars`: `parse_events(5)` raises ValueError.
- `test_store_batch_writes_rows_and_summary`:
  - store two events for the same EPC (`reads` 3 and 0) plus one other EPC;
  - `raw_tag_reads` count is 3;
  - `rfid_tags_seen` has 2 rows, and the repeated EPC has `total_reads == 4` (`max(reads, 1)` summed) with `first_seen` ≤ `last_seen`.
- `test_rows_carry_setup_snapshot`: setup `{"initiative_id": "m-1", "site_id": "s-1", "scan_status": "rfid_in"}` is copied onto every row.
- `test_rows_without_setup_have_null_context`: `setup=None` gives NULL columns.
- `test_raw_json_round_trips`: `json.loads(row["raw_json"]) == event`.
- `test_edge_routes.py`: extend the existing wipe test so it seeds one `raw_tag_reads` row and one `rfid_tags_seen` row and asserts both are empty after the wipe.

- [ ] Write the tests; run `.venv/bin/pytest -q tests/test_tagreads.py`; they fail (no module).
- [ ] Implement the schema step, `tagreads.py`, the fake builders and `MOVE_TABLES`.
- [ ] Run the full edge suite; all pass.
- [ ] Commit: `feat(edge): raw_tag_reads + rfid_tags_seen storage for FX9600 tag events`

---

### Task 2: The 8091 ingest app

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/ingest.py`
- Modify: `kiosk_laptop/edge/src/edge/rfid/events.py`: no change needed if `record` already takes any kind; just use the kind `tag_data_receiving`.
- Test: `kiosk_laptop/edge/tests/test_rfid_ingest.py` (new)

**Interfaces:**
- Consumes:
  - Task 1's `parse_events` and `store_batch`;
  - `pairing.current_row(store)`, a row with `serial`, `token` and `model`, or None;
  - `laptop_setup.load(store)`;
  - `events.record(store, kind, title, detail)`.
- Produces: `create_ingest_app(state, *, clock=time.monotonic) -> Starlette | FastAPI`.
  - `state` is the 8090 app's `app.state`, which carries `store`.
  - The returned app's ONLY route is `POST /rfid/{reader_serial}/{token}`. Everything else gets a 404 with an empty body, including GET on that path.
  - Use FastAPI with `docs_url=None, redoc_url=None, openapi_url=None`, or plain Starlette.

**Behavior** (spec §3):

1. **Auth:**
   - `row = current_row(store)`.
   - Unless `row` exists, `row["serial"] == reader_serial` and `hmac.compare_digest(row["token"] or "", token)` holds, answer 404 with an empty body and store nothing.
   - Log at info: "rejected tag data for reader %s" with the serial only.
2. **Size:** a `Content-Length` over 5 MB gets a 413 before reading. Read the body capped at 5 MB + 1; more than that also gets a 413.
3. **Parse:** `json.loads` (UTF-8). A failure, or a `ValueError` from `parse_events`, gets a 400 `{"error": "bad_json"}`.
4. **Store:** `store_batch(...)` with `setup=laptop_setup.load(store)`.
   - Any exception means the transaction rolled back (`store.tx` does that). Answer 500, log the exception type only, and never the path.
5. **Event:** if `stored > 0` and (there has been no accepted batch yet, or `clock() - last >= 300`), call `events.record(store, "tag_data_receiving", "Tag data receiving", f"{row['model'] or 'Reader'} · {stored} reads")`. Then set `last = clock()` whenever `stored > 0`.
6. **Response:** 200 `{"stored": n, "skipped": m}`.

**Tests in `test_rfid_ingest.py`:**
- **Setup:** pair a reader the same way `tests/test_rfid_pairing.py` does (reuse its helpers, or seed `rfid_readers`/`rfid_pairing` with `pairing.remember` plus the pairing row as that file does). Then build `create_ingest_app(app.state, clock=fake)` and drive it with `httpx.AsyncClient(transport=httpx.ASGITransport(...))`.
- **Tests:**
  - `test_accepts_single_and_batch`: a single event gives `{"stored": 1, "skipped": 0}`; `tag_batch(3)` gives stored 3; the table holds 4 rows, all with `reader_serial == SERIAL`.
  - `test_wrong_token_wrong_serial_or_unpaired_is_404`: three cases, each a 404 with `r.content == b""`; the row count stays 0.
  - `test_other_paths_are_404`: `GET /rfid/SERIAL/token`, `POST /`, and `POST /rfid/SERIAL` all give 404.
  - `test_bad_json_is_400` (body `b"{nope"`), and `test_scalar_json_is_400` (body `b"5"`).
  - `test_oversized_body_is_413`: a 5 MB + 10 byte body gives 413, and nothing is stored.
  - `test_write_failure_rolls_back_and_returns_500`: monkeypatch `tagreads.store_batch`'s insert to raise after the first row (or monkeypatch the summary upsert to raise). The response is 500 and `raw_tag_reads` is still empty.
  - `test_token_never_logged`: use caplog at DEBUG over an accepted and a rejected POST; the token string isn't in `caplog.text`.
  - `test_tag_data_receiving_event_once_then_after_quiet`:
    - fake clock at 0: POST, then 1 event;
    - clock 100: POST, still 1 event;
    - clock 401: POST, then 2 events;
    - the event detail is `"FX9600 · 1 reads"` for a single event.

- [ ] Write the tests; run them; they fail.
- [ ] Implement `ingest.py`.
- [ ] Run the full edge suite; all pass.
- [ ] Commit: `feat(edge): tag-data listener for the paired reader (POST /rfid/<serial>/<token>)`

---

### Task 3: Serve both ports from one process

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/__main__.py`: add the `serve` command next to `reset-key`.
- Create: `kiosk_laptop/edge/src/edge/serve.py`
- Modify: `kiosk_laptop/Dockerfile`: the `CMD` becomes `["python", "-m", "edge", "serve"]`. The healthcheck and `EXPOSE 8090` stay; add `EXPOSE 8091`.
- Modify: `kiosk_laptop/README.md`: the RFID station section stops saying nothing listens on 8091. Reads are stored on the laptop in `raw_tag_reads`, and Wipe clears them.
- Test: `kiosk_laptop/edge/tests/test_serve.py` (new)

**Interfaces:**
- Consumes: `create_app()` (8090) and `create_ingest_app(app.state)` (Task 2).
- Produces: `async def serve(*, host: str = "0.0.0.0", port: int = 8090, ingest_port: int = 8091, settings=None, ready: asyncio.Event | None = None) -> None`.
  - It builds the main app, then the ingest app on the **same** `app.state`.
  - It runs `uvicorn.Server(uvicorn.Config(app, host=host, port=port, ...))` and the ingest server together with `asyncio.gather`.
  - When either server exits, it stops the other.
  - It sets `ready` once both report `started`.
  - The main app's lifespan (startup and background tasks) must run only once, through its own server. The ingest server uses `lifespan="off"`.
- CLI: `python -m edge serve [--host H] [--port P] [--ingest-port P]`, defaulting to 0.0.0.0, 8090 and 8091.

**Tests in `test_serve.py`:**
- `test_serve_answers_on_both_ports`:
  - Pick two free ports. Start `serve(...)` as a task with `Settings(..., background=False)` from the conftest pattern and a tmp data dir; wait on `ready`.
  - `GET http://127.0.0.1:<port>/edge/identity` returns 200.
  - `POST http://127.0.0.1:<ingest>/rfid/x/y` returns 404.
  - Then cancel the task, which must finish within 5 s.
- `test_cli_has_serve`: `python -m edge serve --help` exits 0. Run it with `subprocess` and `sys.executable`.

- [ ] Write the tests; run them; they fail.
- [ ] Implement `serve.py`, the CLI, the Dockerfile and README edits.
- [ ] Run the full edge suite; all pass. Also run `docker build -f kiosk_laptop/Dockerfile .` from the repo root if Docker is available. If it isn't available, skip this and say so in the report.
- [ ] Commit: `feat(edge): python -m edge serve runs the kiosk (8090) and the tag listener (8091) in one process`

---

### Task 4: `GET /edge/rfid/reads`

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/rfid/tagreads.py` (query helpers)
- Modify: `kiosk_laptop/edge/src/edge/routes/rfid.py` (the route; the router already requires an edge session)
- Test: `kiosk_laptop/edge/tests/test_rfid_reads.py` (new)

**Interfaces:**
- Consumes:
  - Task 1's tables and `normalize_epc`;
  - the edge `cache` table (key `"/kiosk/sync/assets?initiative_id=<id>"`, body JSON `{"assets": [{"rfid", "serial_number", "name", "make_model", …}]}`). Check the exact key format in `edge/sync.py` (`cache_key`).
- Produces:
  - `reads_summary(store, *, tz: str = "UTC", limit: int = 50, now: datetime | None = None) -> dict`, returning exactly the spec §5 JSON shape: `tags_today`, `move_total`, `move_seen`, `recent[{epc, received_at, antenna, peak_rssi, asset|null}]` and `last_received_at`.
  - An invalid `tz` (`zoneinfo.ZoneInfoNotFoundError`, or a non-str value) falls back to UTC.
  - The asset index is memoized per `(cache key, stored_at)` in a module-level dict holding one entry.
  - Route: `GET /edge/rfid/reads?tz=America/Chicago` → `reads_summary(st.store, tz=...)`.

**Tests in `test_rfid_reads.py`:**
- `test_reads_needs_a_session`: no session gives 401.
- `test_reads_without_setup_or_cache`:
  - with nothing stored, the result is `tags_today 0`, move counts null, `recent []` and `last_received_at` null;
  - with reads but no setup, move counts are still null.
- `test_tags_today_uses_local_midnight`:
  - insert a summary row with `last_seen` 2026-10-16T04:30:00Z (23:30 on 10-15 in America/Chicago) and another at 2026-10-16T05:30:00Z;
  - `now` = 2026-10-16T15:00:00Z with `tz="America/Chicago"` gives 1;
  - with `tz="UTC"` it gives 2.
- `test_move_progress_from_cache`: seed laptop_setup for move m-1 and a cache body with 4 assets (3 with rfid, one without). Two of those rfids have been seen, giving `move_total 4` and `move_seen 2`.
- `test_asset_match_ignores_case_and_spaces`: a cached asset rfid `"e2 80 11 aa"` matches a read EPC `E28011AA`. `recent[0].asset` is `{serial_number, name, make_model}` from the cache.
- `test_unknown_tag_has_null_asset`.
- `test_recent_is_newest_50`: store 60 rows; `len(recent) == 50`, and `recent[0]` is the last stored.
- `test_bad_tz_falls_back_to_utc`.

- [ ] Write the tests; run them; they fail.
- [ ] Implement the helpers and the route.
- [ ] Run the full edge suite; all pass.
- [ ] Commit: `feat(edge): GET /edge/rfid/reads — tags today, move progress, recent reads matched to assets`

---

### Task 5: Dashboard shows real tag data

**Files:**
- Modify: `kiosk/src/lib/api.ts`: add `RfidReads` and `getRfidReads(tz: string): Promise<RfidReads>`, which calls `GET /edge/rfid/reads?tz=` with `encodeURIComponent`. Follow `getRfidEvents`.
- Modify: `kiosk/src/pages/RfidStatus.tsx`, its test, and `kiosk/src/styles/kiosk.css` if needed (existing tokens only).

**Interfaces:**
- Consumes: the spec §5 response shape (Task 4).
- `tz` is `Intl.DateTimeFormat().resolvedOptions().timeZone`.

**Behavior** (spec §6):
- **Polling:** reads are fetched in the same chained poll as status and events, with the same `seq`/`alive` staleness guards already in the page. A failed reads fetch keeps the last data on screen.
- **Tiles:**

  | Tile | Value | Sub-line |
  |---|---|---|
  | Tags read today | `tags_today` | "Unique tags" |
  | Move progress | `${move_seen} / ${move_total}` | `${pct}% complete` (one decimal, like the mockup's "69.4% complete") |

  - The Move progress bar width is `pct%`, with `aria-valuenow`/`aria-valuemax` set.
  - When the move counts are null, keep `— / {assets or —}` and the sub-line "Waiting for move data".
  - Before the first reads response, Tags read today shows `—`.
- **Table rows:** EPC (mono) | serial | name | make_model. For a null `asset`, the three asset cells say "Unknown tag", muted (one cell spanning three columns is fine).
- **Newest row:** a row whose `epc + received_at` wasn't in the previous response gets a highlight class that clears after 2 s.
- **Empty state:** "No tag reads yet." The footnote stays.
- **System Events:** the kind `tag_data_receiving` uses the broadcast icon.
- **Removed:** every "Waiting for tag data" string.

**Tests in `RfidStatus.test.tsx`** (mock `getRfidReads`):
- tiles render 42 and "37 / 500" with "7.4% complete" and the bar at 7.4%;
- null move counts show "Waiting for move data";
- table rows: one matched (shows serial, name and make/model) and one unknown (shows "Unknown tag");
- the empty state "No tag reads yet.";
- `getRfidReads` is called again on the next 5000 ms poll;
- `tz` is passed through;
- a `tag_data_receiving` event renders;
- `queryByText('Waiting for tag data')` is null.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build`; all pass.
- [ ] Commit: `feat(kiosk): RFID dashboard shows tags read today, move progress and live reads`
