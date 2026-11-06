# Dock Station (proof of concept): pack crates from an RFID curtain

Date: 2026-11-05. Status: proof of concept, built on branch `dock-station`.
It merges to main only after Jimmy has tried it on a dock.

## Why

Jimmy was asked whether assets can be packed into crates automatically by
RFID. A crate passes an RFID portal on the dock, every tag on it and in it is
read, and the reads say which assets are in which crate. An earlier attempt
streamed reads over MQTT to the API and processed them there. It did not
work at all.

This attempt does the grouping on the laptop beside the reader, using reads
that already land in its SQLite store with timestamps. The API only receives
finished results: "these assets are in this crate."

It is an experiment. The goal is to learn whether the reads group cleanly into
crates on a real dock, and to make that easy to see and tune.

## How the dock works (Jimmy)

- Workers pack a crate on the dock, then move it by hand on a pallet jack.
  There are no forklifts.
- There is a natural gap between crates, because each one takes time to pack.
- A crate holds up to about 20 devices.
- Every asset and every crate has its own RFID tag.
- Only assets and crates pass through the curtain. There are no crates
  inside crates and no tagged pallets. So every container of the move counts
  as a crate, whatever its type.
- The read point uses focused, narrow-beam antennas to make a true "curtain."
  They replace the wide-beam antennas used elsewhere, so tags lying near the
  portal are not read.

## Goals

1. **Dock is its own laptop station type**, next to Label, RFID and Time
   Clock in Kiosk Setup. (Jimmy chose this over a toggle on the RFID
   station.) Its setup is the RFID station's: reader, pair, network check,
   move, site, scan type.
2. **Reads group into passes on the laptop.** Each pass becomes one result:
   packed, or flagged with a reason.
3. **A pass with exactly one crate packs its assets into that crate** in the
   portal.
4. **A Dock screen shows passes as they happen**, and lets you open any pass
   to see every read in it, so the quiet gap and the antennas can be tuned.
5. **Dry run.** Passes are grouped and shown, and nothing reaches the
   portal: no packing and no scans (Jimmy: "dry run is a dry run"). Reads
   taken during dry run are never uploaded, not even after dry run is turned
   off. Dry run is on by default and is turned off with a switch once the
   grouping looks right.

## Non-goals

- **A read point in front of the truck** that records which crates went onto
  which truck. Jimmy raised it as a later idea. The pass grouping should stay
  separate from the packing step so a truck-loading step can reuse it.
- **A signal-strength cutoff.** The curtain antennas handle stray reads. Add
  one later only if the real reader needs it.
- **Unpacking.** A pass never removes an asset from a crate.
- **Fixing flagged passes in the portal.** In this proof of concept, flags
  show only on the Dock screen.
- **Barcodes, and the Android and iOS kiosks.**

## Anti-goals

- **An asset silently packed into the wrong crate.** That is worse than
  leaving it unpacked. When a pass is ambiguous, flag it and never guess.
- **A missed read treated as "removed."** Metal servers block reads, so some
  tags inside a crate will be missed. Missing a tag says nothing about where
  the asset is.

## Pass rules

Decided in conversation with Jimmy:

- **Any tag opens a pass**, asset or crate. Read order does not matter: the
  crate tag is often read after some of the assets.
- **A pass closes after 5 seconds with no *new* tags.** A tag already in the
  pass reading again does not keep the pass open, so a crate parked in the
  curtain still closes. The 5 seconds is a setting on the laptop, default 5.
  (Jimmy set the 5 seconds. "New tags only" was my proposal, and he did not
  object.)
- **When a pass closes:**
  - **Exactly one crate of the move:** every asset of the move in the pass is
    packed into it.
  - **No crate, but assets of the move:** flagged "No crate read". Nothing is
    packed.
  - **Two or more crates:** flagged "More than one crate". Nothing is packed.
- **Packing only adds.** It uses the existing kiosk pack rules (`POST
  /kiosk/containers/{id}/assets`). An asset already in another crate moves
  to this one, and the result names the crate it came from. An asset already
  in this crate is a no-op. A crate passing through twice therefore changes
  nothing the second time.

## My calls (Jimmy can override)

- **Tags that match nothing** on the laptop's copy of the move are ignored
  for packing and listed as "Unknown" in the pass detail. A crate from another
  move looks the same as an unknown tag, so a pass whose only crate tag is
  from another move is flagged "No crate read".
- **People badges** in a pass are ignored for packing.
- **Assets of the move's client that are not on the move** set off the same
  red "Asset Not Part Of Move" alarm the RFID station uses, and are not
  packed. The rest of the pass still packs.
- **Packing runs on the laptop under the station key**, not as the
  signed-in person, so the Dock station works unattended like the RFID
  station. The browser does not have to be open. This needs a new API route
  under `/kiosk/station/`, scoped to the Dock station type, that packs one
  pass in one transaction. It is idempotent on a pass id the laptop
  generates, writes one audit row per asset that moved (as the existing route
  does, with the kiosk's name and no person), and answers per asset:
  packed, moved from, already there, or refused with a reason.
- **A crate that lingers in the curtain** keeps the literal rule: once its
  pass closes, its next reads open a new pass. That repeat pass packs the
  same crate again, which changes nothing. If another crate arrives while
  the first is still in the beam, the pass is flagged "More than one crate."
  The alternative, ignoring a just-closed pass's tags until they go quiet,
  was rejected: an asset in the lingering crate that gets read for the first
  time late could join the next crate's pass and be packed into the wrong
  crate.
- **Offline:** closed passes wait on the laptop and are sent in order when
  the portal is reachable, with the same retry gaps as scan uploads. This
  differs from the Containers screen, which is online-only because a person
  is standing there waiting for an answer.
- **A late pass never overwrites newer packing.** The request carries the
  pass's close time, corrected with the server-time offset the laptop
  already tracks. The route refuses, per asset, any asset whose current
  membership (`container_assets.added_at`) is newer than that, with the
  reason "Changed since this pass." Without this, a pass held offline for an
  hour would quietly move assets back into a crate they had since left.
- **Scans:** with dry run off, the Dock station uploads every read as a
  scan, exactly as the RFID station does, with the scan type picked at
  setup. The pass route changes crate membership only and writes no scans,
  so status rules see the same scans they would from an RFID station.
- **Dry run** is a laptop setting, on by default, with a switch on the Dock
  screen. In dry run a single-crate pass shows "Would pack N into {crate}."
  Passes closed and reads taken during dry run are never sent, now or later.
  Which reads count as dry run is decided when they are read, not when they
  would be uploaded. The off-move alarm still sounds in dry run, because it
  is local to the laptop and never touches the portal.
- **Station Home** for Dock shows: Dock, RFID Reader (the existing dashboard,
  for start/stop and live reads), Kiosk Setup and Settings. The reader
  controls are not rebuilt on the Dock screen.
- **Dock screen** (`/dock`), dark and full screen like `/rfid_status`:
  - the open pass, with tags filling in live and the time left before it
    closes;
  - recent passes, newest first: time (24-hour HH:MM:SS), crate, number of
    assets, outcome (Packed, Would pack, Flagged with its reason, Waiting to
    send), and how many assets moved from another crate;
  - flagged passes stand out;
  - a dry-run switch and the quiet-gap setting, both visible on the screen;
  - opening a pass shows every read in it: time, tag (trimmed the way the
    portal shows tags), what it matched (asset, crate, person, off-move,
    unknown), antenna and signal strength, and per asset what packing did.
- **Pass data lives on the laptop** and is cleared with the alarm tables: on
  a move change, Clear Setup and Wipe. No other retention.
- **The portal shows "Dock"** as the station type wherever it shows Label,
  RFID and Time Clock today (Kiosk Devices, the kiosk detail tabs). A Dock
  station's reader appears on Fixed Readers like an RFID station's.

## Constraints

- **Adding a station type follows the Time Clock precedent.** Migration 0105
  widened `ck_devices_station_type`; this needs the next migration to add
  `'dock'`, with a downgrade that clears `'dock'` to null first. Every place
  that lists the station types gains Dock: about 40 files across the API,
  portal, kiosk and laptop. Most are places that treat `'rfid'` specially,
  and Dock gets the same treatment there: station key, upload routes, reader
  telemetry, online/offline notices, sync, setup checks, Clear Setup and the
  off-move alarm.
- **The station key covers one move**, as it does for RFID stations.
- **Laptop only** (FX9600 through the existing ingest on port 8091).
- **The dev database has no RFID tags.** Every tag was cleared on 2026-11-04.
  The trial uses a different move, which Jimmy will tag. The 2026-11-04 tags
  are not restored.
- **House rules:** American English, 24-hour time, rounded modal corners, no
  default scrollbars, every action has a visible control.

## Testing

It's a proof of concept, but the API route changes real data, so it gets
real tests:

- **Grouping (laptop):** read order, the quiet gap, re-reads not extending a
  pass, one crate, no crate, two crates, off-move and unknown tags, in-order
  sending after an outage.
- **Dry run (laptop):** no passes and no scans leave the laptop while it is
  on, and reads taken during dry run stay unsent after it is turned off.
- **API route:** pack, move from another crate, already there, idempotent
  replay, wrong station type (403), read-only mode (423), crate or asset not
  on the key's move.
- **Kiosk:** light tests on the Dock screen and the Kiosk Setup type step.
- **Live:** the fake reader (`kiosk_laptop/edge/tests/fake_reader.py`) for a
  scripted pass on the branch stack, then the real FX9600 at 10.10.48.119.

## Success

On a dock trial, crates pushed through the curtain end up with the right
contents in the portal. Flagged passes are rare, and the pass detail explains
each one.

## Left to the builder

Table and column names, how the grouper is scheduled (the existing 2-second
processing tick or its own), the route's exact request and response shape,
and the Dock screen's layout within the house style.

Settled during the builder check:

- **The quiet gap is timed by the reader's own `read_at`.** The laptop's
  `received_at` is stamped once per batch, to the second, and the reader
  buffers while the laptop is down.
- **A pass the portal refuses for good** (crate gone, for example) is marked
  refused and skipped. The passes after it still send in order.
- **The Dock screen and its laptop routes need an edge session**, the same
  gate as `/edge/rfid`.
- **Every check that is RFID-only today and should cover Dock gets fixed.**
  For example, `/kiosk/station/heartbeat` answers 401 to anything but
  `rfid`, which would drop a Dock laptop's station key, and
  `processing.alarms_on` is RFID-only.
- **The migration is 0120**, or the next free number at merge time.

## Implementation notes (2026-11-06)

Built on `dock-station` in 10 tasks plus two review fix rounds and a final fix wave. Plan: `docs/superpowers/plans/2026-11-05-dock-station.md` (its "Decisions this plan makes" list also applies).

- **API:** station type `dock` (migration 0120 widens `ck_devices_station_type` and creates `dock_passes`, which stores each answered pass so a replay returns the same reply). `station_keys.READER_STATION_TYPES = ("rfid", "dock")` drives every reader-only gate. `POST /kiosk/station/dock/passes` takes `{serial, pass_id, container_id, closed_at, asset_ids}` and answers per asset `packed | moved | already_there | refused` (`asset_not_found`, `not_on_move`, `changed_since_pass`). It shares `_current_membership` / `_pack_asset` with the Containers route. New memberships get `added_at` = the pass time.
- **Edge:** `edge/dock/` holds `state` (settings, clearing), `grouper` (1 s loop), `sender` and `views`. `/edge/dock`, `/edge/dock/passes/{id}` and `PUT /edge/dock/settings` sit behind the edge session. Dry run is stamped on each raw read at ingest, and dry-run reads' scans are stored as `upload_state = 'dry_run'`, which never uploads.
- **Changed in review:**
  - Switching a laptop to Dock from another station type moves the dock cursor past every earlier read.
  - A reader time near `datetime.max` falls back to the laptop time.
  - The sender sends the reader-clock pass time only when the reader is within 60 s of the laptop. Otherwise it sends the laptop-clock time, so a wrong FX9600 clock can't refuse every move or switch off the "Changed since this pass" guard.
  - The Dock screen says `Can't reach the station. Retrying…` while the edge doesn't answer, and `Checking…` before its first answer.
- **Live verify (2026-11-06):** run on a clone of the dev DB with the fake FX9600. Every scenario passed: dry run, no crate, two crates, the off-move alarm, and a live pack that moved an asset out of another crate. Only the live reads uploaded as scans.
- **Before the first live (non-dry-run) trial:** check that the FX9600's clock agrees with the laptop's.
