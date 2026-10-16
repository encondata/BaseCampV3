# RFID tag ingest on the laptop kiosk

Status: approved in conversation 2026-10-16 (Jimmy). Builds on `2026-10-01-kiosk-rfid-station-design.md` and `2026-10-02-kiosk-rfid-network-check-design.md`.

## 1. Goal

A Zebra FX9600 paired to a laptop kiosk posts its tag reads to the laptop at `http://<laptop-ip>:8091/rfid/<reader-serial>/<token>`. Pairing already points it there, but nothing listens yet.

This work adds:

- the listener;
- a `raw_tag_reads` table in the **laptop's own SQLite database**, the only store for raw reads (Jimmy: the kiosk is the only endpoint and database that gets raw tag reads; a future processing script decides any further destinations);
- the RFID dashboard's tag tiles and Live Tag Reads table, fed from that data.

Out of scope:

- uploading reads to the cloud;
- the processing script;
- retention or cleanup. Rows are kept until Wipe; Jimmy: "keep everything for now".

## 2. What the reader sends

The ZIOTC `httpPost` data endpoint POSTs JSON with `Content-Type: application/json`.

- With batching on (our pairing sets `reportingInterval` 2000 ms and `maxPayloadSizePerReport` 256000), the body is a **JSON array** of events.
- Without batching, it is a single event object.

A tag event:

```json
{"type": "SIMPLE", "timestamp": "2026-10-16T14:03:22.512+0000",
 "data": {"idHex": "e28011606000020d6a1b2004", "antenna": 1, "peakRssi": -52, "reads": 3,
          "channel": 915.25, "phase": 12.4, "eventNum": 1047, "format": "epc"}}
```

- Field names are Zebra's.
- Any of the `data` fields except `idHex` may be missing.
- Unknown fields are kept in `raw_json`.
- An event without a string `data.idHex` is **not a tag event**. Heartbeats, GPI events and the like are counted and skipped.

## 3. Listener (edge, port 8091)

### Process

A second, minimal ASGI app (`edge.rfid.ingest`) is served on `0.0.0.0:8091` **in the same process** as the kiosk app on 8090, so both share `app.state.store`. The SQLite database is opened `locking_mode=EXCLUSIVE` by one process.

- The container command changes from plain `uvicorn …8090` to `python -m edge serve`, which runs two `uvicorn.Server` instances in one event loop with `asyncio.gather`.
  - The 8090 app is built by `create_app()` as today.
  - The 8091 app gets the same `app.state` objects.
- `python -m edge reset-key` keeps working.
- The healthcheck stays on 8090.
- Docker already publishes 8091 (installer compose and dev compose).
- The 8091 app does **not** use the 8090 host-check middleware. The reader addresses the laptop by IP, and the route is authenticated by its token.

### Route

`POST /rfid/{reader_serial}/{token}` is the only route. Anything else gets a 404 with an empty body.

**Accepted** only when `reader_serial` equals the current pairing's serial **and** `token` equals that reader's stored token. The token is compared with `hmac.compare_digest`.

- A mismatch, no pairing, or no stored token gets a 404 and stores nothing. A random device on the LAN learns nothing.
- The path, including the token, is never logged. Logs name only the serial and counts.

**Body handling:**

- Bodies over **5 MB** get a 413. Check the `Content-Length` header and the bytes actually read.
- Bodies that aren't valid UTF-8 JSON get a 400.
- A top-level value that is neither an object nor an array gets a 400.
- The body is a list of events: a single object is treated as a list of one.
- Each event is parsed into a row (§4). Non-tag events are skipped and counted.

**Write:** all rows from one POST go in **one transaction**, together with the summary updates (§4).

**Response:** 200 `{"stored": n, "skipped": m}`, quickly. The reader only needs a 2xx.

**Events:** the first accepted batch after 5 minutes with no accepted batch records an event, using the existing `events.record`:

- kind `tag_data_receiving`
- title "Tag data receiving"
- detail `"{model} · {n} reads"`

The edge remembers the last accepted batch time in memory.

## 4. Storage (edge SQLite, one new appended SCHEMA_STEP)

```sql
CREATE TABLE raw_tag_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,          -- the laptop's clock, ISO 8601 UTC (now_iso)
    read_at TEXT,                       -- the event's own timestamp as sent, or NULL
    reader_serial TEXT NOT NULL,
    epc TEXT NOT NULL,                  -- data.idHex, uppercased, whitespace stripped
    antenna INTEGER, peak_rssi REAL, reads INTEGER, channel REAL, phase REAL,
    event_num INTEGER, event_type TEXT,
    initiative_id TEXT, site_id TEXT, scan_status TEXT,   -- the laptop's setup when received
    raw_json TEXT NOT NULL              -- this one event, as received
);
CREATE INDEX raw_tag_reads_received ON raw_tag_reads (received_at);
CREATE INDEX raw_tag_reads_epc ON raw_tag_reads (epc);

CREATE TABLE rfid_tags_seen (
    epc TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,     -- received_at values
    total_reads INTEGER NOT NULL,                          -- sum of max(reads, 1)
    last_antenna INTEGER, last_rssi REAL, reader_serial TEXT NOT NULL
);
CREATE INDEX rfid_tags_seen_last ON rfid_tags_seen (last_seen);
```

**Field parsing:**

- Numeric fields that are missing, or that aren't numbers, become NULL.
- `read_at` is stored only when it is a string of at most 64 characters.
- `event_type` is stored only when it is a string of at most 32 characters.
- `epc` must be 1 to 128 hex characters after normalizing. Otherwise the event counts as skipped.

**Setup snapshot:** `initiative_id`, `site_id` and `scan_status` come from `laptop_setup.load(store)` once per POST, or are NULL when the laptop isn't set up.

**Summary table:** `rfid_tags_seen` is upserted per row in the same transaction, using `ON CONFLICT(epc) DO UPDATE`, so the dashboard never scans `raw_tag_reads`.

**No retention.** **Wipe** (Edge settings) adds both tables to `MOVE_TABLES`, so they are cleared with the rest of the move data.

## 5. Dashboard data: `GET /edge/rfid/reads` (edge session)

```json
{"tags_today": 42,
 "move_total": 500, "move_seen": 37,
 "recent": [{"id": 1234, "epc": "E28011…", "received_at": "…", "antenna": 1, "peak_rssi": -52,
             "asset": {"serial_number": "CZJ…", "name": "NAP11-ESX-027", "make_model": "HPE ProLiant DL380 Gen10"} }],
 "last_received_at": "…"}
```

**`tags_today`:** the number of rows in `rfid_tags_seen` with `last_seen` on or after **local midnight**. The edge takes local midnight from the browser's `tz` query parameter (an IANA name, validated with `zoneinfo`; default UTC), so it matches the dashboard clock.

**`move_total` and `move_seen`:**

- `move_total` is the number of assets in the cached `/kiosk/sync/assets?initiative_id=<setup move>` body.
- `move_seen` is how many of those assets have a non-empty `rfid` that, normalized like `epc`, appears in `rfid_tags_seen`.
- Both are null when there is no setup or no cache.

**`recent`:**

- The newest 50 rows of `raw_tag_reads`, by `id` descending.
- Each row is matched to a cached asset by normalized tag. `asset` is null for an unknown tag.
- The asset index (normalized rfid → summary) is built from the cache body and memoized on that cache row's `stored_at`.

**`last_received_at`:** the newest `received_at`, or null.

## 6. Kiosk dashboard (`/rfid_status`)

**Polling:** the page polls `GET /edge/rfid/reads` along with status and events, using the same chained 5 s polling.

**Tiles:**

| Tile | Value | Sub-line |
|---|---|---|
| Tags read today | `tags_today` | "Unique tags" |
| Move progress | `move_seen / move_total` | "{pct}% complete", with a real bar |

When the move counts are null, Move progress keeps `—`.

**Live Tag Reads table:**

| Column | Value |
|---|---|
| Tag ID | EPC, monospace |
| Serial Number | the asset's serial |
| Computer Name | the asset's name |
| Make / Model | the asset's make and model |

- A row with an unknown tag shows "Unknown tag" across the asset columns, muted.
- The newest row is highlighted briefly when it first appears.
- The empty state "No tag reads yet." replaces "…when tag data is connected."
- The footnote stays.

**System Events:** shows the new `tag_data_receiving` kind with the broadcast (antenna) icon.

**Removed:** the "Waiting for tag data" placeholders.

## 7. Errors and logging

- An ingest failure while writing rolls back the batch and returns 500, so the reader retries it. Its own retention keeps up to 150000 events.
- Log lines name the serial, stored and skipped counts, and duration at debug level. A rejected request logs at info, without the path.

## 8. Testing

**Fake reader:** `fake_reader.tag_event(epc, **fields)` builds a Zebra event, and `tag_batch(n)` builds a list of them.

**Edge (pytest):**

- Routing and auth:
  - wrong token, wrong serial, or no pairing: 404 and 0 rows;
  - any other path: 404.
- Body handling:
  - a single object is stored;
  - a batch of 3 is stored;
  - a mixed batch with a heartbeat and a bad EPC gives stored 1 and skipped 2;
  - a malformed body gives 400;
  - a non-object, non-array body gives 400;
  - a body over 5 MB gives 413.
- Stored rows:
  - the setup snapshot is on each row, or NULL when the laptop isn't set up;
  - the EPC is normalized;
  - raw_json round-trips.
- `rfid_tags_seen`: first and last seen, total reads, last antenna.
- Events: `tag_data_receiving` is recorded once, then again only after 5 quiet minutes. Use an injected clock.
- The token is never in the logs. Check with caplog.
- Wipe clears both tables.
- `GET /edge/rfid/reads`:
  - `tags_today` across midnight in a given `tz`;
  - move totals from the cache;
  - asset matching, and unknown tags;
  - the limit of 50;
  - a session is required.
- The two-server entrypoint starts both apps on given ports. A smoke test with ephemeral ports.

**Kiosk (vitest):**

- Tiles with data and with nulls.
- The table with matched and unknown rows.
- The empty state.
- Polling includes reads.

**Live:** with the FX9600 paired to a laptop running this build, start the reader and confirm:

- rows appear in `raw_tag_reads`;
- the dashboard tiles and table move.
