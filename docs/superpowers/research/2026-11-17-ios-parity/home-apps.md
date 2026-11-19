# Home and the apps it launches: Android vs iOS

Area: Home (launcher rules, station tiles) and every screen a tile opens: Scanning, RFID Enroll,
Containers, Trucks, Asset Lookup, Label Printing (Print Labels, Printer Setup), Timeclock and the
Time Clock station, Rolodex. Kiosk Setup and Settings are only touched where Home depends on them.

Method: read `core/features/Features.kt` vs `Core/Features.swift`, both Home screens, both nav
roots (`ui/KioskApp.kt` vs `UI/RootView.swift`), and every screen pair. I also diffed the
user-visible strings of each pair and checked `git log` on both apps.

Paths below are relative to:
- Android: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/`
- iOS: `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`
- API: `api/src/serversherpa/api/routes/`

Excluded entirely, as the task asked: the RFD40 sled, DataWedge, the Zebra RFID and scanner SDKs,
MC2200 layout and Zebra hardware keys and triggers. These are listed at the end so you can see
what was left out.

## Summary

| # | Gap (Android has, iOS lacks) | Size | Server routes | Hardware-dependent |
|---|---|---|---|---|
| 1 | Asset Lookup tile and screen, with an offline fallback | M | exist | No (only its sled input is, and that part is excluded) |
| 2 | RFID Enroll refuses an asset ID or serial scanned at the tag step | S | none new | No |
| 3 | Rolodex worker page: Previous jobs card | S | exists (already in the detail payload) | No |
| 4 | Rolodex: tap the photo to view it large and whole | S | none | No |
| 5 | Rolodex: Employee ID removed from the worker page and the Edit form | S | none | No |
| 6 | Time Clock station Home tile gets a missing station key before it signs out | S | exists | No |
| 7 | Clear Setup from the portal sends the kiosk to Kiosk Setup and shows a banner (cross-area) | M | exists | No |

Already at parity (excluding sled and DataWedge parts): Scanning, RFID Enroll (apart from #2),
Label Printing home, Print Labels, Printer Setup (network and Bluetooth LE Zebra printers, fonts,
test labels, offsets, Troubleshooting link), Timeclock and the Time Clock station flow, Rolodex list
and New worker flow, travel fields, and the camera scan sheet (Single and Multi).

Containers and Trucks are placeholders on both apps (`placeholder = true` / `placeholder: true`,
both open `FeaturePlaceholderScreen`). Android has nothing more than that, so there is no gap.
**Flag:** on 2026-10-22 Jimmy said containers and trucks are not to be started on the apps yet.

Bulk Print (`docs/superpowers/specs/2026-11-07-kiosk-bulk-print-design.md`) exists only in the
web kiosk. Neither native app has it, so there is no gap.

---

## 1. Asset Lookup (new tile and screen)

- **What it does on Android:** Home has an "Asset Lookup" tile: "Scan an asset to see what it is
  and where it goes." It sits between Trucks and Label Printing and needs Kiosk Setup. The screen
  has one box ("Asset tag, serial, RFID, or name") plus Search and Clear, and takes typed input,
  hardware keyboard scanners and the camera.
  - One match opens a details card. Several matches show a tappable list with Asset tag, Serial
    and "Matched on"; the list holds 25 at most, then "Refine your search". No match keeps the
    value and shows "No asset matches X."
  - **Everyone sees:** name, make/model, asset tag, serial, RFID, and each route's Source and
    Destination (Site, Rack, then RU, or Position when there is no RU).
  - **Admins (rank 60+) also see:** a status chip in the server's color, Current location
    ("<container> · on <truck>" or the location text) and Moves with status chips.
  - **Scan history:** only for an admin with `scans:view` whose asset is on a move. It shows the
    latest 50 (status, Off move chip, time in 24-hour form, scan type, device, operator, site) and
    "Latest 50 scans shown." when it hits the cap.
  - **Offline:** on a network failure or `edge_offline`, it searches the move's synced asset
    payloads instead. An amber line reads "Offline — showing this move's devices only." Admins
    see the synced status with no color and the container name. Scan history reads "needs a
    connection".
  - It is read-only and never writes to the outbox. A request id drops slow, out-of-date answers.
    On a narrow screen, picking a list row scrolls its card into view.
- **Android files:**
  - `core/model/Lookup.kt` (payload models)
  - `core/lookup/AssetLookup.kt` (offline match, cap 25, history limit 50, local detail,
    `placementText`, `scanWhenText`)
  - `core/text/NaturalSort.kt` (only Asset Lookup uses it)
  - `data/lookup/AssetLookupRepository.kt` (API first, Room fallback)
  - `ui/screens/lookup/AssetLookupViewModel.kt`, `ui/screens/lookup/AssetLookupScreen.kt`
  - `ui/components/ColorChip.kt` (a chip in a server hex color)
  - `core/features/Features.kt` (`FeatureId.LOOKUP`), `ui/Routes.kt` (`LOOKUP`), `ui/KioskApp.kt`
    (gated route), `ui/screens/home/FeatureIcons.kt` (lookup icon)
  - `data/api/OkHttpKioskApi.kt` (`lookupAssets`, `assetDetail`, `assetScans`)
  - README section "Asset Lookup"
- **Closest iOS counterpart:** none. `FeatureId` has no `lookup` and `Route` has no case for it.
  The groundwork is there: `KioskStore` already keeps the raw asset payloads
  (`assetPayloads()`), the containers (`ContainerRecord`, though there is no read accessor yet)
  and the `label_context` meta (source and destination site). `KioskAuth.can(_:_:)` exists for
  `scans:view`.
- **Server routes (all exist):** `kiosk.py` has
  - `GET /kiosk/assets/lookup?serial=&q=` (line 1918)
  - `GET /kiosk/assets/{asset_id}?serial=` (line 1954)
  - `GET /kiosk/assets/{asset_id}/scans?serial=&limit=50` (line 2022)

  The server decides which fields a user may see.
- **Hardware or SDK dependence:** none for the screen itself. Leave out its sled parts: arming
  `RfidOwner.LOOKUP`, the one-tag sweep lookup, the "N tags read. Point the reader at one tag"
  notice, `RfidReadPanel`, `SledSlot` and `ScanTools`.
- **Notes for iOS:**
  - Under the new iOS Home rule (hide apps until setup is done) the tile is hidden until Kiosk
    Setup completes, rather than greyed out.
  - Android stacks the web's tables as rows so they fit 320 dp. An iPad could use a wide table,
    as `ScanTable` already does on Scanning.
  - Specs: `docs/superpowers/specs/2026-11-10-android-asset-lookup-design.md` and
    `docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md`.
- **Size:** M. That covers the models, API calls, pure matching with tests, the repository with
  its offline fallback, the view model, the screen, the route and icon, a natural-sort port and a
  hex color chip.

## 2. RFID Enroll: an asset ID or serial scanned at the tag step is refused

- **What it does on Android:** at the "Scan the RFID tag" step, a value that matches any roster
  asset's asset ID or serial is checked before padding and refused. The messages are:
  - "That's this asset's own asset ID, not an RFID tag."
  - "That's this asset's own serial, not an RFID tag."
  - "That's the asset ID for <name>, not an RFID tag."
  - "That's the serial for <name>, not an RFID tag."

  This is the web kiosk's `kiosk/src/lib/enrollGate.ts` first check ("ruling 13"). Without it, a
  barcode label scanned by mistake is zero-padded and saved as the tag.
- **Android files:** `core/scan/EnrollGate.kt` (`checkEnrollRaw` and the `OWN_ASSET_ID`,
  `OWN_SERIAL`, `OTHER_ASSET_ID` and `OTHER_SERIAL` issues), `ui/screens/enroll/EnrollViewModel.kt`
  (`submitTag` calls it first), and the copy in `core/rfid/SledWords.kt` (lines 229–236). The copy
  is plain text and needs no sled.
- **Closest iOS counterpart:** `Core/Scan/EnrollGate.swift` has only `checkEnrollTag` (same tag,
  used this session, on another asset). `UI/Screens/Enroll/EnrollViewModel.swift` `submitTag` goes
  straight to `padRfid`.
- **Server routes:** none new. It uses the same `POST /kiosk/assets/{id}/rfid`.
- **Hardware or SDK dependence:** none. It applies to typed and camera input. It landed in the
  Android sled commit 90615bf2c, but the check itself is generic.
- **Size:** S.

## 3. Rolodex: Previous jobs card on the worker page

- **What it does on Android:** below the details, a "Previous jobs" card lists the initiatives the
  worker was added to, newest first. Each row has:
  - the name, which wraps
  - "Type · Work type · Site"
  - "Added Oct 3, 2026", with a short month in the device's locale
  - the initiative's status chip in its own color, at most 120 dp wide

  With no jobs it reads "No jobs yet.". After the latest 50 it reads "Showing the latest 50 of N
  jobs."
- **Android files:** `ui/screens/rolodex/WorkerJobs.kt`, `ui/screens/rolodex/WorkerPage.kt`, and
  `core/model/Rolodex.kt` (`RolodexJob`, `jobs`, `jobs_total`).
- **Closest iOS counterpart:** none. `Core/Rolodex/RolodexModels.swift` doesn't decode `jobs` or
  `jobs_total`, and `UI/Screens/Rolodex/RolodexWorkerView.swift` has no card for them.
- **Server routes:** they exist. `GET /kiosk/rolodex/workers/{person_id}` (`kiosk_rolodex.py` line
  269) already returns `jobs` and `jobs_total`.
- **Hardware or SDK dependence:** none.
- **Note:** `docs/superpowers/specs/2026-10-22-kiosk-rolodex-design.md` §2 calls #3–#5 a follow-up
  owed to iOS ("Android only so far").
- **Size:** S.

## 4. Rolodex: tap the photo to view it large

- **What it does on Android:** tapping the worker's photo (not its camera badge) opens it large and
  whole: full screen, scaled to fit, never cut to the circle. Close, a tap anywhere or Back
  closes it. With no photo (initials only), a tap does nothing.
- **Android files:** `ui/screens/rolodex/PhotoViewer.kt` and `ui/screens/rolodex/WorkerPage.kt`
  (`PhotoWithBadge`).
- **Closest iOS counterpart:** none. The iOS photo only opens the photo flow from its badge.
- **Server routes:** none.
- **Hardware or SDK dependence:** none.
- **Size:** S.

## 5. Rolodex: Employee ID off the worker page and the Edit form

- **What it does on Android:** the Employee ID (`external_id`) is no longer shown on the page or in
  Edit (Jimmy, 2026-10-22). The API still sends it.
- **Android files:** `ui/screens/rolodex/WorkerPage.kt` (comment at line 433).
- **Closest iOS counterpart:** `UI/Screens/Rolodex/RolodexWorkerView.swift` line 183 still shows
  `RolodexKeyValue(key: "Employee ID", …)`.
- **Server routes:** none.
- **Hardware or SDK dependence:** none.
- **Size:** S (trivial).

## 6. Time Clock station: Home's Time Clock tile gets a missing station key first

- **What it does on Android:** when someone is signed in at a Time Clock station, Home's Time Clock
  tile first makes sure the station has its key. If the key is missing, it issues one under the
  signed-in session (with one sign-in heartbeat and a retry on `not_signed_in_here`), then signs
  out to Welcome. The tile is disabled while this runs. If no key can be had, the person stays
  signed in and a red toast explains why:
  - network failure: "The station key hasn't arrived yet. Check the connection and try again in a
    minute."
  - `move_locked`: "A move password can't start the time clock. Sign in with your own account."
  - anything else: "Couldn't start the time clock (code). Try again."
- **Android files:** `ui/screens/home/HomeScreen.kt` (`startTimeclock`, `startTimeclockError`),
  `AppContainer.kt` (`startTimeclock`, `issueStationKey`) and `data/station/StationStatus.kt`
  (`issueAndStore`).
- **Closest iOS counterpart:** `UI/Screens/Home/HomeScreen.swift` `open(_:)` only calls
  `auth.logout()`. iOS issues the key only during Kiosk Setup's Time Clock finish
  (`UI/Screens/Setup/KioskSetupViewModel.swift` line 309). A station whose key was dropped (by an
  API URL change or a `station_key_invalid` refusal) rests on Welcome with "waiting for its station
  key" until someone runs Kiosk Setup again.
- **Server routes:** exists, `POST /kiosk/station-key` (`kiosk.py` line 924). iOS already calls it
  through `KioskApi.issueStationKey`.
- **Hardware or SDK dependence:** none.
- **Size:** S.

## 7. Clear Setup from the portal (cross-area: heartbeat and Kiosk Setup, but it drives Home navigation)

- **What it does on Android:** when the heartbeat reply carries `clear_setup`, the kiosk does the
  following once:
  - drops its setup and its Time Clock station key, and turns off the Internet Test
  - acknowledges with `setup_cleared` on an immediate re-beat, and on every beat until the server
    stops asking
  - sends whoever is signed in to Kiosk Setup, from any screen
    (`SetupClearedRedirect` beside the NavHost; `SetupGate` also goes to Setup rather than Home)
  - shows "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue." on Kiosk
    Setup until setup is done again
- **Android files:** `data/heartbeat/Heartbeat.kt` (`setupCleared`), `ui/KioskApp.kt`
  (`SetupClearedRedirect`), `ui/guards/SetupGate.kt` (`setupStateWithClearNotice`),
  `ui/screens/setup/KioskSetupScreen.kt` and `KioskSetupViewModel.kt`
  (`dismissSetupClearNotice`), `AppContainer.kt` line 295 (key cleared), and `data/prefs/KioskPrefs.kt`.
- **Closest iOS counterpart:** none. `Data/Heartbeat/Heartbeat.swift` and `Core/Model/Kiosk.swift`
  don't read `clear_setup`, so a portal Clear Setup has no effect on an iOS kiosk.
- **Server routes:** they exist. `POST /kiosk/heartbeat` (`kiosk.py` line 471) returns
  `clear_setup` until a beat sends `setup_cleared`. Spec:
  `docs/superpowers/specs/2026-10-01-kiosk-clear-setup-design.md`.
- **Hardware or SDK dependence:** none.
- **Size:** M (small M). It touches the heartbeat model and the beat, prefs, nav, the Kiosk Setup
  banner, and resetting print jobs and the station key. It may also be reported by the Settings or
  heartbeat area. Count it once.

---

## Differences that are not gaps (checked, at parity)

- **Scanning:** same header, box, camera button, counts, Retry failed, Clear sent, Discard failed
  with confirmation, receipt rows, and no-move-data handling.
- **RFID Enroll:** same two steps, the "Update RFID Value" gate for an asset that already has a
  tag, the session log (25), and save error copy. The only exception is #2.
- **Label Printing:** home, Print Labels (including going to Printer Setup when no printer is
  saved, Labeled scans, reprint and retry) and Printer Setup (network and Bluetooth LE Zebra,
  signal words, non-Zebra refusal, fonts, test labels, offsets) match. The remaining string
  differences are platform copy: Android WebView versus JavaScriptCore, Android
  Bluetooth/Location settings versus iOS Local Network.
- **Timeclock and the Time Clock station:** same steps, punch error, idle and quiet-minute return
  to Welcome, Welcome's gear, and origin-bound key. The only exception is #6.
- **Rolodex:** list, letter sections, offline copy (including the 5xx fallback, Ruling S15), New
  worker flow, photo capture and crop, Blacklist note, and travel fields match. A cosmetic copy
  difference: Android's offline Contact card reads "Phone and email need a connection.", iOS reads
  "Contact details need a connection."
- **Rolodex tile rule:** Android adds the Rolodex for admins on any station type except Time
  Clock, while iOS adds it only when there is no station type. The native apps have no other
  station type, so users see no difference.

## iOS has, Android lacks (so nothing is lost)

- **Home hides tiles until setup is done** (Jimmy, 2026-11-17, iOS 62b4b607d). Android still shows
  them greyed with "Finish Kiosk Setup first.". The banner copy differs too: iOS says "Finish Kiosk
  Setup to see the other apps.", Android says "Only Kiosk Setup and Settings are available." Port
  this to Android; don't port Android's version to iOS.
- **Home uses three columns at 1000 pt or wider** (`homeColumns`). Android always uses two.
- **Scanning shows a wide five-column receipt table at 700 pt or wider** (`ScanTable.swift`).
  Android always shows stacked rows.
- **RFID Enroll shows the session log beside the steps at 1000 pt or wider.**
- **The camera scan sheet has Flip camera** (front/back).
- **The Time Clock flow has its own on-screen keyboard** (`TcOnScreenKeyboard.swift`,
  `TcKeyCapture.swift`). Android chose the system keyboard on purpose (4f8db6648).
- **The sign-in page's Settings sheet on a Time Clock station closes when the sign-in request
  ends** (`loginSettingsSheetShown`). Android covers the same case with its `StationIdleReturn`
  route guard.

## Excluded on purpose (sled, DataWedge, Zebra SDK) — do not port

- **Scanning:**
  - the live RFID read panel with Stop (`ui/screens/scan/RfidReadPanel.kt`)
  - sweep bursts to the outbox (`ScanViewModel.onBurst`, repeat-sweep policies)
  - the sled line, Sled triggers control and sled Scan button (`ui/screens/scan/SledControls.kt`,
    `ScanTools.kt`)
  - the DataWedge soft-trigger Scan button
- **Asset Lookup:** sled arming, the one-tag sweep lookup, the several-tags notice and
  `forgetQueued`.
- **RFID Enroll and Print Labels:** sled scanner-session barcodes and DataWedge.
- **App-wide:** `ui/flash/SledFlashOverlay.kt` (Sled disconnected / Ready to scan), and in
  `ui/KioskApp.kt` both `SledDisplayEffect` and `SledScreenSignal`.
  Also `core/scan/SledScanGuard.kt` (dedupes on the scan box, Time Clock Welcome and Enter Your
  Name, and the move password), `input/ExternalKeyLog.kt`, `input/datawedge/*`, `input/rfid/*`
  and `core/rfid/*`.
- **Not hardware, but outside this area:** Android's Internet Test (`nettest/*`, the "Net test"
  chip on the shell and on the signed-in Time Clock screens) is a developer link conditioner with
  its own `nettest/REMOVAL.md`. It is not in this area and is probably not a parity target.
