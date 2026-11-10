# Android kiosk Asset Lookup — design

Date: 2026-11-10. Branch `android-asset-lookup`.

## What Jimmy asked for

The web kiosk's Asset Lookup (main d39cb11b, 2026-11-08) on the Android app:
"yep lets build it for android", and asked whether it should differ from the
web version: "work the same".

So this is a port. The web design,
`docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md`, is the
authority for behavior, access and wording, together with the web screen as it
stands on main (`kiosk/src/pages/AssetLookup.tsx`, `kiosk/src/lib/assetLookup.ts`),
including the style rounds after the merge (b5457100f to ab994ba5b). This
document only records how it lands in the Android app and the calls a phone
needs. The API is unchanged: the three routes already exist.

## Goals

- An **Asset Lookup** tile on Home, between Trucks and Label Printing (the web
  order), greyed until Kiosk Setup is complete like the other move tiles.
- Scan or type an asset tag, serial, RFID or name; see the device.
- Everyone signed in sees identity, source and destination. Admin and above
  (rank 60+) also see status, moves, current location and, with `scans:view`
  and the device on a move, the scan history (newest 50).
- Read-only. A lookup never queues a scan, never touches the outbox.
- Offline: the same matching rules over the move's synced devices, with the
  web notice "Offline — showing this move's devices only."

## Non-goals

- iOS (its own project later), any API change, editing or re-tagging, printing,
  containers, trucks and badges.

## The screen (Android)

Follows RFID Enroll and Scanning for the input, header, sizes, themes and
touch targets.

- **Header:** `PageHeader("Kiosk · Asset Lookup", "Asset Lookup", setup?.headerLine() ?: "Finish Kiosk Setup first.")`.
- **Scan box:** the shared `ScanInput` (typed + Done, keeps focus) with
  placeholder "Scan or type an asset tag, serial, RFID, or name", the camera
  button when the device has a camera, then **Search** and **Clear** buttons,
  as on the web.
- **Inputs:** typed text, Zebra DataWedge barcode scans and the camera, all
  through the app's `ScanBus`, as RFID Enroll uses it. The view model takes no
  `Outbox`, so nothing it does can record a scan.
- **RFD40 sled (my call).** On the web an RFID read arrives as keystrokes; on
  Android the sled's trigger is the RFID input. The screen arms the sled while
  it is open (as Scanning does, disarmed on leave) and a finished sweep is
  looked up:
  - one distinct tag: looked up like a typed RFID;
  - several distinct tags: no lookup; the screen says "N tags read. Point the
    reader at one tag and try again." (a lookup is about one device).
- **Results:** the web rules exactly: one device opens its details; several
  show the list (name, asset tag, serial, and "Matched on" when any match is
  not by name), capped at 25 with "Refine your search"; none says "No asset
  matches *value*." and keeps the value; errors read "Couldn't look that up.
  Try again." / "Couldn't load that asset." A newer lookup, pick or Clear drops
  any older answer.
- **Details card:** as the web card is now: name (or "Unnamed asset") and
  make/model, with the admin status chip (no "Status" word) at the top right;
  Asset tag, Serial and RFID (display form, unpadded) on one line, with
  Current location (admins) after them (`"<container> · on <truck>"`, else the
  location text, else "—"); Source and Destination each with Site, Rack and
  RU, or Position when there is no RU (no Pod); a move name above each pair
  when the device is on more than one move; admins also get Moves with each
  move's status chip, and Scan history. Blank values show "—".
- **Phone layout (my call).** The web's wide tables don't fit a 360 dp
  screen. The match list and the scan history are stacked rows instead, with
  the same fields and order: a history row shows the status chip (and an
  amber "Off move" chip), the time (24-hour, `yyyy-MM-dd HH:mm`), the method
  chip, then Device, Operator, Site and Location. On a tablet the same rows
  are used. It must fit the MC2200 at 320 dp.
- **Status chips** use the server's colors, through the Rolodex's
  `ColorChip`/`hexColor`, moved to `ui/components` so both screens share it.
  Offline the status has no color, so it shows as a plain chip, as on the web.
- **Scan history** copy as the web: "Scan history", "Loading…", "Could not
  load scan history.", "No scans recorded for this asset.", "Latest 50 scans
  shown.", and offline "Scan history needs a connection."

## Offline

Same as the web:
- Online, every lookup and details read goes to the API.
- When the API can't be reached (`ApiError.isNetwork`), matching runs on the
  synced move assets: an asset tag only as plain digits with no leading zero
  (at most 18 digits), the serial ignoring case and spaces, the RFID compared
  padded to 24; exact hits first, else a part-name match; sorted naturally by
  name then asset tag; capped at 25.
- The details come from each synced asset's stored server row
  (`assets.payload_json`, the raw `/kiosk/sync/assets` element, which carries
  source and destination rack/RU/position, `asset_status`,
  `asset_status_label`, `location_detail` and `container_id`) plus the site
  names from the stored label context. No database migration.
- Admins offline see the synced status (no color), the kiosk's move (no
  status), the container name from the synced containers, no truck, and
  "Scan history needs a connection."

## Access

Unchanged: the API decides what each person may see and refuses the rest
(404 out of reach, 403 for scans below admin). The app sends the kiosk's
`serial`; it never sends a move id. The admin check on the screen (rank 60)
and `scans:view` only decide what is drawn and whether the scan history is
asked for.

## Tile placement

- In `FEATURES` after Trucks (web order: setup, scan, enroll, containers,
  trucks, lookup, labels, timeclock, settings), for everyone, gated on setup.
- A Time Clock station keeps its fixed tiles and does not get it, like the
  web's station laptops.

## Testing

Robolectric and unit tests, mirroring the web tests:
- pure matching (`core/`): each key, tag rule, RFID padding, mixed exact hits,
  name fallback, cap and `truncated`, natural sort;
- offline details from a stored payload, admin and not;
- the API client's three calls (paths, `serial` and `q` encoding, models);
- the screen: tile order, greyed until setup, one match opens, several list,
  none says so, worker sees source and destination only, admin the full card,
  history only for an admin with `scans:view` on a moved device, offline
  notice and fallback, a newer lookup wins, Clear empties, a sled sweep of one
  tag looks up and several say so, the sled is disarmed on leave, and the
  outbox stays empty throughout;
- fits 320 dp (MC2200).

Live: on the Pixel and the MC2200, against the dev API, look up dev asset
102466 `atl1-web-001` by each of its four values as a worker and as an admin.

## Implementation notes

Built on branch `android-asset-lookup` (commits `df39eb1b3` to `aa47c1520`).

### Files

All paths under `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/`.

- **core/lookup** — `AssetLookup.kt`: pure matching (keys, tag rule, RFID padding, exact hits then name fallback, natural sort, cap and `truncated`), offline details from a stored payload, `scanWhenText`. `core/model/Lookup.kt` holds the API models; `core/text/NaturalSort.kt` the natural compare.
- **data/lookup** — `AssetLookupRepository.kt` (`find`, `open`, `scans`, `loadLocal`) with the offline fallback. `data/api/KioskApi.kt` and `OkHttpKioskApi.kt` gain `lookupAssets`, `assetDetail` and `assetScans`.
- **ui/screens/lookup** — `AssetLookupViewModel.kt` (stale-answer counter, scan history state) and `AssetLookupScreen.kt` (input, match list, detail card, scan history, notices).
- **ui/components/ColorChip.kt** — `ColorChip` and `hexColor` moved out of the Rolodex so both screens share them; the Rolodex files (`RolodexList`, `WorkerJobs`, `WorkerPage`) only changed imports.
- **Features, Routes, KioskApp, FeatureIcons** — the Asset Lookup tile (after Trucks, for everyone, gated on setup, not on Time Clock stations), its route, and its icon.
- Tests: `AssetLookupTest`, `NaturalSortTest`, `AssetLookupRepositoryTest`, `AssetLookupViewModelTest`, `AssetLookupScreenTest`, plus additions to `ModelsJsonTest`, `OkHttpKioskApiEndpointsTest`, `FeaturesTest`, `HomeScreenTest` and `FakeKioskApi`.

### Offline data source

No migration. Offline matching and details read the synced move assets already in Room: the stored server row (`assets.payload_json`), the site names from the `label_context` meta, and the container names from the synced containers. Fallback happens only on `ApiError.isNetwork` or code `edge_offline`; any other error propagates. Opening a result found offline skips the API. Payloads that don't decode are skipped.

### Sled sweeps and `forgetQueued`

After each sweep the screen calls `rfid.forgetQueued(epcs)`. A lookup sends nothing anywhere, but the controller marks every tag it emits as queued this visit. Under a "skip tags already sent" sweep policy a second sweep of the same tag on this screen would be dropped without it. One distinct tag looks it up; several show "N tags read. Point the reader at one tag and try again." with no API call. The sled is armed while the screen is open and set up, and disarmed on leave.

### Setup gate on inputs

The view model does not check setup. The route is wrapped in `SetupGate`, and the screen forwards scanner, camera and sled input, and enables the box and Search, only when setup is complete.

### Rulings made during the build

- Review Focus #3 wording ("404/403 on lookup reads as No asset matches") follows the web instead: the lookup route returns an empty list for out-of-reach devices (shown as "No asset matches"), and any thrown error from find reads "Couldn't look that up. Try again." Cost if wrong: a forbidden lookup shows the generic error instead of the miss line (copy only).
- The view model does not gate on setup; the route is wrapped in `SetupGate` (redirects Home until setup is complete) and the screen disables the box when setup is missing. Cost if wrong: none expected.

### Owed

- A device check at 320 dp on the MC2200 (the layout was only checked under Robolectric).
- The live check against the dev API: dev asset 102466 `atl1-web-001` by each of its four values (asset tag, serial, RFID, name), as a worker and as an admin.
- Deferred review notes: no on-screen latched-read state or Stop control for the sled on this screen; the doc comment on `RfidController` still says only Scanning arms the sled.
