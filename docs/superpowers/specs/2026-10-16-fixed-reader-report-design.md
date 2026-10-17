# Kiosk-attached readers on the Fixed Readers page

Status: approved in conversation 2026-10-16 (Jimmy). Builds on the RFID Station (`2026-10-01-kiosk-rfid-station-design.md`) and tag ingest (`2026-10-16-rfid-tag-ingest-design.md`) work.

## 1. Intent

The portal's **Scanning Hardware › Fixed Readers** page (`/hardware/fixed-readers`) is meant to list connected readers, but nothing feeds it. When a laptop kiosk is an RFID Station, its paired Zebra FX9600 should appear there, kept current by the laptop.

The page should answer one question: **is this reader alive and reading?** Jimmy wants to see:

- make, model, MAC and IP;
- a tag count;
- **status**: Reading or Standby, or Offline when it isn't reporting;
- scan type and site, taken from the kiosk's setup.

### Goals

- **Laptop:** an RFID Station reports its paired reader to the portal about every minute while someone is signed in at the laptop.
- **Portal:** creates or updates one **fixed reader** device record per reader, keyed by the reader's serial, and shows it on Fixed Readers. The page gains **Make** and **Status** columns.
- **Tags (24h):** for a kiosk-attached reader this is the **laptop's count of raw reads in the last 24 hours**, every tag the reader reported, matched or not. It's a pulse showing the reader is reading, not a count of assets scanned in.

### Non-goals

- **No reporting while nobody is signed in.** The only scheduled call from the laptop to the portal is the kiosk heartbeat, and it only runs while someone is signed in. The reader shows **Offline** until someone signs in again. Jimmy accepted this until the **station key** from `2026-10-16-rfid-scan-processing-design.md` exists. That key will let this report go up unattended; this work should be easy to move onto it.
- No change for readers that don't come through a kiosk. Their Tags (24h) keeps using portal scan counts, as today.
- No page layout, filter or Delete changes beyond the two new columns.
- Known limit: until the station key exists, reader records are written by the kiosk heartbeat under the existing kiosk trust model (any `kiosk:view` session can heartbeat a kiosk serial). Writes are limited to new or kiosk-created rows and are audited.
- No migration. *(Claude's call: the new values live in the device's existing `raw_info` JSON.)*

## 2. What the laptop reads

The real FX9600, checked 2026-10-16:

| Call | Fields used |
|---|---|
| `GET /cloud/version` | `model` (`FX9600`), `serialNumber`, `readerApplication` |
| `GET /cloud/network` | `macAddress` (`C4:7D:CC:64:7D:23`), `ipAddress`, `hostName` (`FX9600647D23`) |
| `GET /cloud/status` | `radioActivity` (`active` / `inactive`; read through `ziotc.is_reading`), `uptime` (`"357:6:17"`, hours:minutes:seconds), `antennas` (port → `connected` / `disconnected`) |

**Every 60 seconds**, while the laptop is an RFID Station with a paired reader, the edge:

1. Opens the paired reader under `pair_lock`, the same way `/edge/rfid/status` does, and reads the three calls.
2. Counts `raw_tag_reads` rows with `received_at` in the last 24 hours **for this reader's serial**. This uses the `received_at` index.
3. Keeps the result in memory as the **reader snapshot**:

```json
{"serial": "22131010562035", "make": "Zebra", "model": "FX9600", "name": "FX9600647D23",
 "mac": "C4:7D:CC:64:7D:23", "ip": "10.10.48.119", "firmware": "3.32.37.0",
 "uptime_seconds": 1285577, "antennas_connected": 2, "antennas_total": 4,
 "reading": false, "tags_24h": 1832, "taken_at": "2026-10-16T23:00:05+00:00"}
```

- `make` is always `"Zebra"`. Every reader the edge can pair with is a Zebra FX.
- If the reader can't be reached, the snapshot keeps its last good values and sets `"reachable": false`. The portal then shows **Offline**.
- **Uptime parsing:** `h:m:s` with any number of hours. Anything unparseable becomes null.

## 3. How it reaches the portal

The kiosk browser's heartbeat already passes through the edge proxy, which rewrites it to the laptop's identity. When the laptop is an RFID Station with a fresh snapshot (taken in the last 3 minutes), the edge adds `"reader": <snapshot>` to the heartbeat body. Without one, the body is unchanged.

`HeartbeatIn` gains an optional `reader`.

**A bad `reader` must never break the kiosk's heartbeat.** The heartbeat also carries the kiosk's own last-seen time, its sign-in registration and its Clear Setup acknowledgment. *(Claude's call, from the builder check.)*

- **Portal:** `reader` is accepted as a loose object and validated by its own schema inside the route.
  - Only `serial` is required.
  - Every other field is optional and nullable.
  - Strings are at most 64 characters, the MAC must be six hex pairs, the IP must be IPv4, and integers must be non-negative.
  - If `reader` fails validation, it is **dropped and logged** (serial only) and the rest of the heartbeat is processed normally. No 422.
- **Laptop:** the edge leaves out any value it couldn't read or that wouldn't validate, rather than send it. A snapshot from a reader that has never answered still carries its serial (from the pairing).

The portal acts on `reader` only when the heartbeat's device is a kiosk with `station_type = rfid` **and** `reader.serial` equals the device's `rfid_reader_serial`, the reader it was set up with. Otherwise the field is ignored. That way a laptop can't publish an arbitrary reader.

## 4. Portal: the fixed reader record

On an accepted `reader`, the heartbeat upserts the `Device` with `device_type = "fixed_reader"` and `serial = reader.serial`.

`devices.serial` is unique across **all** device types. *(Claude's calls, from the builder check:)*

- **Another device type already holds that serial:** `reader` is ignored and logged. The heartbeat still succeeds.
- **A fixed reader with that serial already exists:** *(Claude's call, from review.)* It is updated only if it was created through a kiosk (`raw_info.via_kiosk_id` is set). A hand-made fixed reader, or one from another source, is left untouched and the report is ignored and logged (serial only), so a laptop cannot take over another scope's reader. `name` is create-only, which also keeps scan-count joins intact.
- **Partial snapshots never wipe data:** *(Claude's call, from review.)* On update, only fields present in the report are applied (also for the `raw_info` keys); `reachable` and `reported_at` always update.
- **Reassignment is audited:** *(Claude's call, from review.)* When an existing reader's site or initiative changes (it moved to another kiosk or move), an audit row `reader_reassigned` records `site_id`, `initiative_id` and `via_kiosk` from/to. Plain telemetry updates are not audited.
- **A reader that has never answered still gets a record.** It shows Offline until a reachable snapshot arrives.

| Device field | Value |
|---|---|
| `name` | `reader.name` (the reader's host name), falling back to `"FX9600 " + serial` |
| `model` | `reader.model` |
| `version` | `reader.firmware` |
| `mac` | `reader.mac` |
| `lan_ip` | `reader.ip` |
| `uptime_seconds` | `reader.uptime_seconds` |
| `antennas_connected` | `reader.antennas_connected` |
| `connection_type` | `"local_api"` (the page shows "Local API") |
| `scan_status`, `site_id`, `current_initiative_id` | copied from the **kiosk** device's current setup |
| `last_seen_at` | now, but only when `reachable` isn't false |
| `raw_info` | merged with `make`, `reading`, `reachable`, `reported_tags_24h`, `antennas_total`, `reported_at`, and `via_kiosk_id` / `via_kiosk_name` (the kiosk it came through) |

**Creation** is audited once, as action `self_register` with `via_kiosk`, like a kiosk's first heartbeat. Later updates are telemetry and aren't audited.

**A reader moved to another laptop:** the same record (by serial) is updated with the new kiosk in `via_kiosk_*`.

**A station switched to Label:** that kiosk stops sending `reader`, so the record goes stale and shows Offline. Nothing is deleted.

### What the devices API returns (`GET /devices?device_type=fixed_reader`)

These fields are added, or derived, for every fixed reader:

- **`make`:** `raw_info.make`, else null.
- **`reader_status`:**
  - `offline` when `last_seen_at` is null or older than **3 minutes**;
  - else `reading` when `raw_info.reading` is true;
  - else `standby`.
- **`tags_read_24h`:** `raw_info.reported_tags_24h` when the reader reported through a kiosk and isn't offline. Otherwise, the existing portal raw-plus-processed scan count.
- **`antennas_total`:** `raw_info.antennas_total`, else null.

## 5. Fixed Readers page (portal)

**New columns:**

| Column | Placement | Shows |
|---|---|---|
| **Make** | before Model, default visible | the make, or `—` |
| **Status** | after Name, default visible | a chip: **Reading** (green), **Standby** (slate) or **Offline** (red) |

- Both new columns appear in the column menu, the facets (Status is a facet), sorting and the CSV export.
- **Antennas** shows `connected / total` when the total is known, else the current `connected / 8`.
- Widths follow the list column floor rules (`docs` / the list-column-floors pattern): the default columns plus trailing must still fit the page ceiling, so shorten or tighten existing ones if needed.
- Everything else stays as it is.

## 6. Testing

**Laptop:**

- The snapshot from the fake reader (extended with `/cloud/network`).
- Uptime parsing.
- `tags_24h` counts only the last 24 hours.
- An unreachable reader gives `reachable: false` with the last values kept.
- The heartbeat gets `reader` only for an RFID Station with a fresh snapshot, and the body is otherwise unchanged.
- No snapshot when there's no pairing.
- The 60 s job takes `pair_lock`.

**Portal (API):**

- A heartbeat with `reader` creates the fixed reader with every field, audited once.
- A second heartbeat updates it with no new audit.
- A serial that doesn't match the kiosk's paired reader is ignored.
- A Label station is ignored.
- A bad MAC or IP drops the report (logged, serial only) and the beat still succeeds.
- Scan type and site follow the kiosk's setup.
- **`reader_status`:** reading, standby, and offline after 3 minutes.
- **`tags_read_24h`:** the reported count while fresh, falling back to scan counts when stale or not kiosk-attached.
- A reader that moves to another kiosk updates in place.

**Portal (UI):**

- Make and Status columns, the chips, the Status facet, sorting, the CSV columns, and antennas as `2 / 4`.

**Live:** the FX9600 paired to the laptop on this Mac shows on dev's Fixed Readers with its MAC `C4:7D:CC:64:7D:23`. Status changes Reading and Standby with START and STOP, Tags (24h) rises while reading, and it goes Offline about 3 minutes after signing out.
