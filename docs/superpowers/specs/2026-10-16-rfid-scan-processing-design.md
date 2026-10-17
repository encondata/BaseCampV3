# RFID scan processing: raw tag reads to portal scans

Status: for Jimmy's review, 2026-10-16. Builds on `2026-10-16-rfid-tag-ingest-design.md`, which put the paired reader's tag reads into the laptop's `raw_tag_reads`.

## 1. Intent

An RFID Station's reads only matter once the portal acts on them. The portal's status rules move an asset (or a crate, or a person) to the scan type's status when it passes the reader.

This work turns the laptop's raw reads into scans the portal accepts. It leaves a record on the laptop proving each scan reached the portal, and when. A station keeps doing this **with nobody signed in**, for weeks.

### Goals

- **Matching.** A job on the laptop runs all the time. It matches each new raw read against the downloaded data: the selected move's assets, containers (crates) and people's badges, and a client-wide list of assets on the move's client's other moves.
- **Pending scans.** Every match becomes one row in a new laptop table, `pending_rfid_scans`. Each row has **Was Accepted** and **Time Accepted**, filled in when the portal confirms the scan.
- **Uploads.** Batches of at most **50** go to the portal. The portal runs its normal scan matching and status rules on them.
- **Retries:** 5 attempts with growing gaps. After that, every 30 minutes while the portal answers. With no internet, wait and upload as soon as it's back.
- **Attribution.** The portal records these scans as **the kiosk's name, with no person**, whether or not someone is signed in at the laptop.
- **Off-move sightings.** An asset that belongs to another of the client's moves still becomes a scan, flagged **Off move**. The portal records it and makes it searchable, but **doesn't change the asset's status**.

### Non-goals

- **No de-duplication on the laptop.** The reader's own debounce decides when a tag counts again: once it runs out, a tag still in range is reported, matched and uploaded again. *(Jimmy.)*
- **The portal's matcher stays as it is.** It already tries asset, then container, then person for RFID values (`scans/matching.py`), and the `rfid` scan type exists. The only change is the Off move handling (§5).
- **No change to barcode scanning or the existing upload queue (`outbox`).**
- **No new dashboard widgets.**
- **No retention.** Rows stay until Wipe, as with raw reads.
- **Not in this design** (next projects). *This design covers project 1 (processing, station key, uploads) together with project 2 (the client-wide asset list), because off-move matching needs that list; project 3, the alert, follows as its own design:*
  - The on-screen "Asset Not Part Of Move" flash and alarm, on the RFID Station and later on barcode scanning and label printing. It uses the client-wide list this design adds.
  - The off-move status rule. Jimmy will add a status rule for off-move scans to trigger notifications or other actions. This design only provides the flag for it to key on.

### Anti-goals

- **A scan silently lost.** Every matched read is either accepted by the portal, refused by it for a stated reason, or still waiting, and the table shows which.
- **Feeding the wrong data.** A laptop must not be able to feed scans into a move it was never set up for, keep feeding them after a move is completed or cancelled, or keep feeding them after it's de-registered.
- **Spreading other clients' data.** A laptop must not receive asset details for clients other than the selected move's client.

## 2. Data on the laptop

### 2.1 What the laptop downloads

- **The selected move** (unchanged): `/kiosk/sync/assets`, `/containers` and `/people`, with full details.
- **New: the client asset list.** `GET /kiosk/sync/client-assets?initiative_id=` returns, for every asset on **any move of the selected move's client** except the selected move itself, only `{id, asset_id, name, rfid, serial_number, initiative_id, initiative_name}`. *(Jimmy: name, asset ID, RFID and serial; the move fields are Claude's addition, so a sighting can say which move the asset belongs to.)*
  - The client is the move's client.
  - A move with no client gets an empty list.
  - It is scoped the same way as the existing sync routes: `kiosk:view`, and a move-password session gets only its own move's client.
  - The edge downloads and caches it with the other three during sync. It uses the same cache table, so Wipe clears it.

### 2.2 Matching (`edge.rfid.processing`)

**Runs:** every 2 seconds in the edge background loop, and right after an ingest batch is stored.

**Cursor:** a one-row `rfid_processing_meta (id=1, last_raw_id)`. Rows are read in id order, up to 500 at a time.

**Indexes:** every tag is normalized with `tagreads.normalize_epc`. Each source is indexed once and memoized like `tagreads`' asset index.

**Order of matching for a raw read** (using the move on that read, its `initiative_id` snapshot):

| Order | Match | `matched_kind` | `off_move` |
|---|---|---|---|
| 1 | the move's asset | `asset` | 0 |
| 2 | the move's container | `container` | 0 |
| 3 | a person's badge (the people list is not per move) | `person` | 0 |
| 4 | the client asset list | `asset` | **1**; `off_move_initiative_id` and `_name` are recorded |
| — | no match | see "Unmatched reads" below | — |

**Reads that are skipped and stay only in `raw_tag_reads`:**

- reads with no move (the laptop wasn't set up when they arrived);
- reads whose move is **no longer the laptop's setup move**. *(Claude's call. Only the current move's data is kept up to date, so older reads can't be matched reliably, and they must not block newer ones.)*

**Unmatched reads:** a read for the current move that matches nothing is remembered in a small `rfid_unmatched (raw_read_id PRIMARY KEY, received_at)` table. After every successful sync (person or station key), the processor re-checks the unmatched reads from the **last 24 hours** against the fresh data. A read that matches now becomes a pending scan as usual; reads older than 24 hours are dropped from `rfid_unmatched` and stay only in `raw_tag_reads`. *(Claude's call, so a tag assigned in the portal after the last sync isn't lost.)* Wipe clears it.

**Waiting for data:** if the read's move **is** the current setup move but its cache isn't there yet (set up, not synced), the processor **stops at that read without advancing**. It tries again on the next tick, so nothing is skipped just because the data hadn't downloaded.

### 2.3 `pending_rfid_scans`

One row per match, with these columns:

- **Identity:** `raw_read_id` (unique) and `client_scan_id` (a new UUID).
- **The match:** `epc`, `matched_kind`, `matched_id`, `off_move`, `off_move_initiative_id`, `off_move_initiative_name`.
- **When:** `scanned_at`, the raw read's `received_at`. That's the laptop's clock; the reader's clock may drift, and its time stays in `raw_tag_reads.read_at`.
- **Where:** `initiative_id`, `site_id`, `scan_status`, from the raw read.
- **Upload state:**
  - `upload_state`: `pending`, `accepted` or `rejected`
  - `was_accepted` (0/1, default 0) and `accepted_at`
  - `reject_code`, `attempts`, `next_attempt_at`, `waiting_for_internet` (0/1), `last_error`
  - `created_at`

**Wipe** clears `pending_rfid_scans`, resets the cursor and deletes the station key. Wipe's existing guard ("you have unsent data, type WIPE") also counts pending RFID scans.

## 3. The station key

### 3.1 Issuing

**When:** after an **RFID Station** setup is saved through the edge (`POST /kiosk/setup` succeeds with `station_type = rfid`). The edge then calls a new `POST /kiosk/station-key` as the signed-in person, with `{serial}`. A real account or a move-password session can do this, with `kiosk:view` as setup requires.

**Portal:**

1. Generate a 32-byte random key and store only its sha256 on the Device, in `station_key_hash`, `station_key_initiative_id` (the device's current setup move), `station_key_issued_at`, `station_key_issued_by` (person) and `station_key_issued_via` (`password`, `link` or `move_password`).
2. Return the raw key once.
3. Audit `station_key_issue` with the move and how the person signed in.

**Edge:** stores the key **encrypted with `edge.key`**, the same way cloud tokens are kept.

**Re-issue:** a new setup issues a new key for the new move, replacing the old key. The key only ever covers one move. *(Jimmy: moves are weeks apart and completed only well after scanning ends, so a backlog from the previous move isn't a concern.)*

**Label Station setup:** revokes the key (§3.3).

**If issuing fails:** the edge retries in the background each minute while someone is signed in online. The Confirm & verify step (RFID path) gains a fourth check, **"Scan uploads ready"**: ok when a key is stored, and if not, fail with "Uploads aren't authorized yet — try again". *(Claude's call, so a station can't look ready while uploading nothing.)*

### 3.2 What the key allows (header `Authorization: Station <key>`)

**`POST /kiosk/station/scans`:**

- **Body:** the same as `/kiosk/scans` (`{serial, scans[]}`), plus an optional per-scan `off_move: bool`. At most **50** scans.
- **Whole-batch refusals:**
  - 401 `station_key_invalid`: no such Device, the key doesn't match (constant-time compare), or there is no key;
  - 401 `station_key_revoked`.
- **Per-scan rejection:** the scan's `initiative_id` must be the key's `station_key_initiative_id` (else `move_locked`), and that move must still be active, meaning its status is not in `HISTORICAL_INITIATIVE_STATUSES` (completed, cancelled) and it isn't archived (else `move_inactive`). A scan whose site isn't the key move's origin or destination (as they are now) is `bad_site`; that check comes after the move checks, so another move's scan reads `move_locked`. Editing a move's origin or destination makes station scans at the old site reject as `bad_site`. Only that scan is rejected; the rest of the batch lands.
- **Storage:** rows are written exactly as `/kiosk/scans` writes them, through one shared implementation, except:
  - `operator_id` = **NULL**
  - `device_id` = the Device name (the kiosk's name)
  - `source` = `"kiosk"`
  - plus the Off move flag (§5). The person route (`POST /kiosk/scans`) always stores `off_move = false`: the flag only means something from a station.
- **Idempotent** on `client_scan_id`. The answer is `{accepted[], rejected[], clear_setup}`, where `clear_setup` carries a pending Clear Setup id so an unattended laptop can act on it.
- **Side effect:** stamps the Device's `last_seen_at`.

**`GET /kiosk/station/sync/{assets|containers|people|client-assets}?initiative_id=`:** read-only. It is the same data as the person sync routes, for **the device's current setup move only**, so an unattended station keeps its data current. The edge's syncer uses the key when no person's cloud session is available.

### 3.3 Revocation

The key is revoked (its hash cleared, an audit `station_key_revoke` row written) when:

- an admin **de-registers** the kiosk;
- an admin **requests Clear Setup**. This takes effect at request time, not on acknowledgment. *(Claude's call: an unattended laptop sends no heartbeats.)*
- the laptop is set up as a Label Station.

**Not a revocation:**

- An **expired** 30-day kiosk registration doesn't revoke it, since that registration only renews when someone signs in. *(Claude's call.)*
- A **completed or cancelled move** stops that move's scans being accepted, without revoking the key.

**The 401 carries a pending Clear Setup:** because requesting Clear Setup revokes the key, an unattended laptop's next station request is refused. While a Clear Setup is pending for that serial's kiosk, the 401 `station_key_invalid` detail also carries `clear_setup` (the opaque request id, nothing else about the device).

**Clear Setup on the laptop:** when a station 401 (upload or sync) or an upload reply carries `clear_setup`, the edge applies Clear Setup as it does from a heartbeat. It drops the shared setup and the stored key, and stops uploading. Rows stay `pending` with `last_error`.

## 4. Uploading (`edge.rfid.uploader`)

**Runs:** every 5 seconds in the background loop, and right after the processor inserts rows.

**Batch:** one at a time, never overlapping. The oldest due `pending` rows (`next_attempt_at` null or past), **at most 50**. Each scan is sent with:

- `client_scan_id`
- `scanned_value` = the EPC, all 24 characters
- `scan_type = "rfid"`
- `scanned_at`
- `asset_id` when an asset matched
- `site_id`, `initiative_id`, `scan_status`
- `off_move`

**Results:**

| Answer | What happens |
|---|---|
| 200 | Accepted ids get `accepted`, `was_accepted = 1`, `accepted_at = now`. Rejected ids get `rejected` and `reject_code`, and are **never retried**. The internet is evidently up, so rows waiting for it are due at once. |
| 401, or no key stored | Rows stay `pending` with `last_error` (set once with no key, not rewritten every tick). The uploader pauses until a key is stored. This doesn't count as an attempt. |
| Network error, timeout, 5xx, 429, or any other 4xx | A failed attempt. |

**Retry schedule (Jimmy):**

- Attempts 1 to 5 back off **30 s, 1 min, 2 min, 5 min, 10 min**. *(The exact gaps are Claude's call; Jimmy asked for "expanding".)*
- From then on, the gap is **30 min**.
- **The probe gates every retry once a row has 5 failed attempts** (so it covers the 6th send, after the 10-minute gap, and every 30-minute retry after it). Before such a send, the uploader probes `GET /system/status`:
  - a 200 means there's internet, so it sends;
  - anything else means no internet. It doesn't use up an attempt, and it sets `waiting_for_internet = 1` on those rows. It probes every 30 s, and once the portal answers it sends at once and clears the flag.

**Label Station setup:** the key is cleared, so remaining `pending` rows can never upload. They become `rejected` with `reject_code = station_changed`, so they stop blocking and the table says why. Rows already accepted or rejected are untouched.

**Browsers never reach the key:** the edge's proxy answers 404 for `/kiosk/station-key` and `/kiosk/station/*` before any upstream call; only the edge itself calls them.

**Older portal:** a 404 for `/kiosk/sync/client-assets` (a portal without that route) syncs as an empty client list; any other failure fails the sync as before.

**Edge status:** `/edge/status` gains an `rfid_uploads` block (`pending`, `waiting_for_internet`, `accepted`, `rejected`). This is for Edge settings and troubleshooting, not a dashboard widget.

## 5. Off move in the portal

- **Storage:** `raw_scans` and `processed_scans` gain `off_move boolean NOT NULL DEFAULT false`. The station endpoint stores the flag, and the worker copies it across.
- **Status:** the scan worker **doesn't apply the checkpoint status or run the status rules** for an `off_move` scan. It still matches the asset and stores the processed scan, so it is a **sighting**. (Jimmy's future off-move status rule will key on this flag. That rule isn't part of this design.)
- **Scan history:** wherever the portal lists processed scans, an **Off move** chip shows on flagged rows, and a filter limits the list to them. The builder finds those list surfaces.

## 6. Testing

**Laptop:**

- **Processor:**
  - each match kind;
  - off-move matches, with the move name recorded;
  - a miss;
  - match order and normalization;
  - a read with no move, and one for an older move (both skipped);
  - waiting for the current move's missing cache, then resuming after sync;
  - an unmatched read that matches after the next sync becomes a pending scan; one older than 24 hours is dropped from the re-check list;
  - the cursor surviving a restart;
  - Wipe.
- **Uploader:**
  - accepted and rejected handling, including `was_accepted` and `accepted_at`;
  - batches of at most 50;
  - the backoff sequence, using an injected clock;
  - the probe gate and `waiting_for_internet`;
  - a 401 pauses without spending attempts;
  - `clear_setup` in a reply;
  - an idempotent resend;
  - no overlapping batches.
- **Station key:** stored encrypted and never logged; retried when issuing fails; the "Scan uploads ready" check.
- **Sync:** uses the key when no person's session is available; the client asset list is cached.

**Portal:**

- **Issuing:** by a real account and by a move-password session (scoped to its move); re-issue replaces the key and its move; audit rows.
- **`/kiosk/station/scans`:**
  - the operator is NULL and the device is the kiosk's name;
  - move rules (any move other than the key's move is `move_locked`; the key's move once completed, cancelled or archived is `move_inactive`);
  - bad, missing or revoked keys;
  - idempotent;
  - at most 50;
  - `clear_setup` in the reply.
- **Station sync routes:** current move only, read-only.
- **Client asset list:**
  - only the move's client;
  - the selected move excluded;
  - a move with no client gets an empty list;
  - move-password scoping.
- **Revocation:** by de-register, Clear Setup request, and Label setup.
- **Off move:** stored, copied to processed scans, no status change or rules, and the history chip and filter.

**Live:** with the FX9600 on the Initech test move:

- tags read become scans in the portal's scan history, under the kiosk's name;
- `pending_rfid_scans` shows `was_accepted = 1` with times;
- a tag from another Initech move shows as Off move with no status change.
