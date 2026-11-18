# Android vs iOS kiosk: data, sync, offline and the server API surface

Scope: `KioskApi` / `StationApi`, local storage (Room vs SwiftData), move sync (assets, people,
containers, trucks, label templates, fonts), the scan outbox, sounds, alarms, push, telemetry,
kiosk config sync. Zebra RFD40 sled, DataWedge, vendor `.aar`, MC2200 layout and Zebra hardware
keys are excluded throughout.

Paths below are relative to:
- Android: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/`
- iOS: `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`
- Server: `api/src/serversherpa/api/routes/kiosk.py` (plus `kiosk_biometric.py`, `kiosk_rolodex.py`, `devices.py`)

## Verdict in one paragraph

The data layer is close to a 1:1 port. Sync (6 parts, same all-or-nothing move rule, soft label
parts, font file cache), the outbox (same state machine and constants), the storage schema (v3,
same 9 tables), sounds, the Rolodex offline copy, the station key, and the session/refresh handling
all match. Four Android-only items remain in this area: **Asset Lookup** (3 API methods plus an
offline fallback), **Clear Setup** handling on the heartbeat, the **remembered sign-in method** for
sign-in beats, and the developer-only **Internet Test** link conditioner. One more Android-only
item (`Outbox.enqueueAll`) exists only for sled RFID bursts and is excluded.

---

## 1. KioskApi method diff

Android `data/api/KioskApi.kt` + `OkHttpKioskApi.kt` (39 methods) vs iOS `Data/Api/KioskApi.swift` +
`URLSessionKioskApi.swift` (37 methods). Every route below exists in `api/`.

| Method | Route | Android | iOS | Notes |
|---|---|---|---|---|
| login | POST /auth/login | yes | yes | |
| moveLogin | POST /kiosk/move-login | yes | yes | |
| logout | POST /auth/logout | yes | yes | iOS sends a cookie captured before local state is cleared |
| systemStatus | GET /system/status | yes | yes | |
| createPairRequest | POST /kiosk/pair | yes | yes | |
| pollPair | POST /kiosk/pair/{code}/poll | yes | yes | iOS adopts an approved session only if the pair view still wants it |
| heartbeat | POST /kiosk/heartbeat | yes | yes | **Android also sends `setup_cleared` and reads `clear_setup`** (gap 2) |
| signOut | POST /kiosk/sign-out | yes | yes | |
| biometricEnrollChallenge | POST /kiosk/biometric/enroll-challenge | yes | yes | |
| biometricEnroll | POST /kiosk/biometric/enroll | yes | yes | Platform payload differs (Android key attestation chain, iOS `BiometricIosEnrollIn`), as designed |
| biometricChallenge / biometricSignIn / biometricForget | /kiosk/biometric/challenge, /sign-in, DELETE /kiosk/biometric | yes | yes | |
| setupOptions / submitSetup | GET /kiosk/setup-options, POST /kiosk/setup | yes | yes | |
| syncAssets / assetsSyncRaw | GET /kiosk/sync/assets | yes | yes | |
| syncPeople | GET /kiosk/sync/people | yes | yes | |
| syncContainers | GET /kiosk/sync/containers | yes | yes | |
| syncTrucks | GET /kiosk/sync/trucks | yes | yes | |
| labelTemplatesRaw | GET /kiosk/sync/label-templates | yes | yes | |
| labelFonts / labelFontContent | GET /kiosk/labels/fonts, /fonts/{id}/content | yes | yes | |
| postScans | POST /kiosk/scans | yes | yes | |
| postRfidEnroll | POST /kiosk/assets/{id}/rfid | yes | yes | |
| timeclockStatus | GET /kiosk/timeclock/{person_id} | yes (`?tz=`) | yes (`?serial=&tz=`) | iOS is ahead: it names the kiosk, so "today" is the site's day |
| clockIn / clockOut | POST /kiosk/timeclock/clock-in, clock-out | yes | yes | |
| issueStationKey | POST /kiosk/station-key | yes | yes | |
| rolodexWorkers / Worker / Options / Duplicates / Create / Update / Photo | /kiosk/rolodex/... | yes (7) | yes (7) | |
| **lookupAssets** | GET /kiosk/assets/lookup?serial=&q= (kiosk.py:1918) | **yes** | **no** | Asset Lookup (gap 1) |
| **assetDetail** | GET /kiosk/assets/{id}?serial= (kiosk.py:1954) | **yes** | **no** | Asset Lookup (gap 1) |
| **assetScans** | GET /kiosk/assets/{id}/scans?serial=&limit= (kiosk.py:2022) | **yes** | **no** | Asset Lookup scan history for admins with scans:view (gap 1) |
| fetchImage | absolute presigned URL (no auth) | inline | yes | Not a gap: Android fetches photos with the app's OkHttp client in `ui/screens/rolodex/WorkerAvatar.kt` and `ui/screens/timeclock/screens/ConfirmPerson.kt` |

`StationApi` (Time Clock station, station key): `people`, `status`, `clockIn`, `clockOut` on both
(`data/api/StationApi.kt` vs `Data/Api/StationApi.swift`), same routes `/kiosk/station/sync/people`,
`/kiosk/station/timeclock/...`. Parity.

### Server routes neither native app calls (web kiosk / laptop edge only; not iOS gaps)

`/kiosk/sync/client-assets` and `/kiosk/station/sync/client-assets` (off-move alarm data),
`/kiosk/station/sync/{assets,containers,label-templates}`, `/kiosk/station/scans`,
`/kiosk/station/heartbeat`, `/kiosk/station/dock/passes` (RFID and Dock stations),
`/kiosk/containers/{id}/assets` and `/kiosk/trucks/{id}/containers` (Containers and Trucks tiles are
placeholders on both apps), `/kiosk/labels/test-render`, `/kiosk/labels/vocab`, `/kiosk/labels/bundle`,
`/kiosk/printer-events` (printer telemetry), `/kiosk/sounds` (uploaded sounds),
`/kiosk/timeclock/learning-link` and `learning-override` (and their station twins),
`/kiosk/edge/move-passwords`, `GET /kiosk/setup`. Heartbeat fields neither app uses: `config`,
`config_changed_at`, `config_applied_version` (kiosk settings sync), `server_time`, `scan_status`,
`scan_status_label`, `client_ip`. Scan field neither sends: `off_move`.

---

## 2. Gaps: Android has it, iOS does not

### Gap 1. Asset Lookup (data layer, API and offline fallback)

- **What it does on Android:** Home › Asset Lookup finds an asset by asset tag, serial, RFID or name,
  from typing or the camera (the sled path is excluded). It lists up to 25 matches (with "truncated"),
  opens a detail card (identity, source and destination route; admins also get status, moves, current
  location and an "Off move" chip), and admins with `scans:view` see the 50 latest scans. When the API
  can't be reached (`network` or `edge_offline`) it falls back to the synced move in local storage and
  shows an offline notice; scan history needs a connection. It never writes to the outbox. Needs
  Kiosk Setup (tile disabled until setup is complete).
- **Android files:** `data/api/KioskApi.kt` + `data/api/OkHttpKioskApi.kt` (the 3 methods),
  `core/model/Lookup.kt` (95 lines), `core/lookup/AssetLookup.kt` (172 lines: local matching,
  `LOOKUP_CAP=25`, `SCAN_LIMIT=50`, local detail), `data/lookup/AssetLookupRepository.kt` (92 lines:
  API first, offline fallback off Main), `ui/screens/lookup/AssetLookupViewModel.kt` and
  `AssetLookupScreen.kt` (513 lines), `core/features/Features.kt` (`FeatureId.LOOKUP` tile), README
  "Asset Lookup". Ported from web `kiosk/src/lib/assetLookup.ts`. Specs:
  `docs/superpowers/specs/2026-11-10-android-asset-lookup-design.md`,
  `docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md`.
- **Closest iOS counterpart:** none. iOS `Core/Features.swift` has no lookup tile. The data the offline
  fallback needs is already stored: `KioskStore.assetPayloads()` (each asset's raw JSON),
  `KioskStore.labelContext()` (source/destination site) and container names.
- **Server routes:** GET `/kiosk/assets/lookup`, GET `/kiosk/assets/{asset_id}`, GET
  `/kiosk/assets/{asset_id}/scans`, all in `kiosk.py`, platform-agnostic, already used by Android.
- **Excluded hardware:** only the one-tag sled sweep input (`onSweep`, `RfidOwner.LOOKUP`,
  `SledSlot`, `RfidReadPanel`). Typing and camera have no hardware dependency. Keep the feature,
  drop the sled input.
- **Size:** M (models, matching, repository, view model, screen, tile, tests).

### Gap 2. Clear Setup on the heartbeat

- **What it does on Android:** an admin picks **Clear Setup** on the kiosk's row in the portal. On the
  next signed-in heartbeat the reply carries `clear_setup: <id>`. The app applies it once: drops the
  Kiosk Setup selection, marks setup incomplete, drops a Time Clock station key, sends whoever is
  signed in to Kiosk Setup with the banner "An administrator cleared this kiosk's setup. Run Kiosk
  Setup to continue." and greys other tiles. It acknowledges with `setup_cleared: <id>` on an
  immediate re-beat and every beat after until the reply stops asking. Queued scans and cached move
  data are kept. Completing Kiosk Setup dismisses the banner.
- **Android files:** `data/heartbeat/Heartbeat.kt` (apply, ack, `setupCleared` flow, re-beat),
  `data/prefs/KioskPrefs.kt` (`SetupClearRecord`, `applySetupClear`, `pendingSetupClearAck`,
  `settleSetupClearAck`, `dismissSetupClearNotice`, `setupStateWithClearNotice`),
  `core/model/Kiosk.kt` (`HeartbeatIn.setup_cleared`, `HeartbeatResult.clear_setup`),
  `ui/KioskApp.kt` (`SetupClearedRedirect`), `ui/guards/SetupGate.kt`,
  `ui/screens/setup/KioskSetupScreen.kt` (banner) and `KioskSetupViewModel.kt` (dismiss),
  `AppContainer.kt` (`heartbeat.setupCleared.collect { stationKeys.clear() }`).
  Commits cb5734613, 03accc574, 8e982b947.
- **Closest iOS counterpart:** none. `Data/Heartbeat/Heartbeat.swift` sends neither field and
  `Core/Model/Kiosk.swift` `HeartbeatResult` has no `clear_setup`. The spec
  (`docs/superpowers/specs/2026-10-01-kiosk-clear-setup-design.md`) lists iOS as a follow-up.
  User-visible today: an iOS kiosk ignores Clear Setup and the portal row stays "Setup clear
  pending" until an admin cancels it.
- **Server routes:** POST `/devices/{id}/clear-setup` and `/clear-setup/cancel` (`devices.py:460`,
  `:482`; also revokes the station key), heartbeat fields in `api/schemas.py` (`HeartbeatIn.setup_cleared`,
  `HeartbeatOut.clear_setup`). All exist.
- **Excluded hardware:** no.
- **Size:** S to M (1 to 2 days with tests).

### Gap 3. Remembered sign-in method for sign-in beats

- **What it does on Android:** every sign-in beat saves its method (`password`, `link`, `biometric`) in
  `ss.kiosk.signInMethod`. A later `signInNow()` (station key issue, `not_signed_in_here` retry) on a
  restored session reports that same method, or sends no method rather than a guessed one.
- **Android files:** `data/heartbeat/Heartbeat.kt` (`signInNow`, `prefs.setSignInMethod`),
  `data/prefs/KioskPrefs.kt` (`signInMethod`).
- **Closest iOS counterpart:** `Heartbeat.signInNow(_ method:)`; the caller
  `UI/Screens/Setup/KioskSetupViewModel.swift:327` passes `auth.lastSignIn ?? .password`, which is in
  memory only. After a relaunch (cookie restore) iOS reports "password" even for a Face ID or pair
  sign-in, so the portal's device sign-in record can show the wrong method.
- **Server routes:** POST `/kiosk/heartbeat` (`sign_in`, `login_method`), exists.
- **Excluded hardware:** no.
- **Size:** S.

### Gap 4. Internet Test (developer network link conditioner), optional

- **What it does on Android:** Settings › Developer (developer mode) can add latency, drops and
  outages to the portal link (every `KioskApi` call) and to the local network link (network printer
  sockets), only while someone is signed in. An amber "Net test" chip shows on the top bar and the
  Time Clock screens while it is on. It turns itself off by rule (sign-out, setup dropped, expiry).
- **Android files:** `nettest/` (11 Kotlin files, about 1,700 lines, plus `REMOVAL.md`), hooks marked
  `// INTERNET-TEST` in `data/api/OkHttpKioskApi.kt`, `AppContainer.kt`, `data/auth/MoveSetupGuard.kt`,
  `data/printer/NetworkZebra.kt`, `ui/shell/KioskShell.kt`, `ui/screens/settings/DeveloperPanel.kt`,
  `ui/screens/timeclock/TimeclockScreen.kt`, `ui/screens/timeclock/screens/TcShell.kt` and
  `ConfirmPerson.kt`.
- **Closest iOS counterpart:** none. `URLSessionKioskApi.makeSession(protocolClasses:)` already takes
  `URLProtocol` classes, which covers the portal half; the printer half needs a wrapper around the
  NWConnection transport in `Data/Printer/NetworkZebra.swift`.
- **Server routes:** none.
- **Excluded hardware:** no. It is a developer test tool, not an operator feature; whether iOS
  needs it is a question for Jimmy.
- **Size:** L.

### Excluded (sled-only)

- `Outbox.enqueueAll` (`data/outbox/Outbox.kt`): persists a whole RFID burst in one write. Its only
  caller is `ScanViewModel.onBurst`, fed by `container.rfid.burstsFor(RfidOwner.SCANNING)` (sled
  sweeps). Excluded.
- Prefs `ss.kiosk.rfid`, `offerSledBothToEveryone`, `sledFlash`; heartbeat `raw_info.datawedge`;
  Asset Lookup's sled sweep. Excluded.

---

## 3. Areas checked and at parity

- **Local storage.** Room `data/db/KioskDatabase.kt` v3 vs SwiftData `Data/Db/KioskSchemaVersions.swift`
  V3 with the same 9 tables: assets (with raw `payload_json`), people (with `badge_uid`, `job_title`,
  `external_id`), containers, trucks, meta (`sync`, `label_context`, `rolodex`), outbox,
  label_templates, label_fonts, generated_labels. Synced row fields match field for field.
- **Move sync.** `data/sync/Sync.kt` vs `Data/Sync/SyncCoordinator.swift`: four move parts in
  parallel, replaced in one transaction/save; templates and fonts soft (`labelsError`), cleared on a
  move change; fonts cached as `<id>.ttf` by size, `font_not_servable` read as resident; hydrate
  on launch; Clear local data keeps the outbox. Same triggers (Kiosk Setup save, Sync again, Print
  Labels Sync now). The Time Clock station's roster refresh (`StationTcBackend`) and the Rolodex's
  new-worker roster insert exist on both.
- **Scan outbox.** `core/outbox/OutboxMachine.kt` + `data/outbox/Outbox.kt` vs
  `Core/Outbox/OutboxMachine.swift` + `Data/Outbox/Outbox.swift`: same statuses (queued, sending,
  accepted, retrying, failed, nomatch), back-off 2/4/15/60 s then failed, batch 100, 500 ms batch
  window, list cap 200, no-match TTL 120 s swept every 10 s, stranded `sending` recovered on every
  start, named rejections permanent, missing ack is `no_ack`, Retry failed / Clear sent / Discard
  failed.
- **Rolodex offline copy.** `data/rolodex/RolodexCacheStore.kt` vs `KioskStore.rolodexCache()`: admin
  only, 5xx and network fall back to it, cleared on every session end.
- **Station key, API URL binding, move-session setup drop.** Both bind the key to the API origin and
  drop it when the URL changes, on Reset app, and when a move session drops a setup for another move
  (`data/auth/MoveSetupGuard.kt` vs `Data/Auth/KioskAuth.swift`).
- **Sessions.** Refresh cookie `ss_refresh` in secure storage, refresh when stale, one refresh plus
  one retry on 401, session-ended signal. Both.
- **Sounds.** `core/settings/SoundSettings.kt` + `ui/sound/SoundPlayer.kt` vs `Core/Settings/SoundSettings.swift`
  + `UI/Sound/SoundPlayer.swift`: same 5 built-in sounds, 3 outcomes (good, not found, duplicate),
  volume, same stored JSON. Uploaded sounds are web only on both.
- **Heartbeat telemetry.** Both beat once a minute while signed in and in front, with `raw_info`
  (Android: manufacturer, model, android_version, sdk_int; iOS: manufacturer, model, system_name,
  system_version, idiom) and `mode` `android` / `ios`.
- **Alarms.** The off-move alarm (red takeover and siren) lives on the laptop edge / RFID Station
  only (`/edge/rfid/alarm`, `/kiosk/sync/client-assets`). Neither native app has it.
- **Push notifications, analytics, crash reporting.** Neither app has any (no Firebase, APNs, or
  analytics SDK).
- **Kiosk settings sync** (portal-edited config document on the heartbeat, spec
  `2026-10-17-kiosk-config-in-portal-design.md`). Web kiosk only (`kiosk/src/lib/kioskConfig.ts`).
  Neither native app.

---

## 4. iOS has it, Android does not (one line each)

- `timeclockStatus` sends `serial`, so "today" is the kiosk's site day; Android sends only `tz`.
- Sign-out captures the token and refresh cookie first and never waits on the network.
- `RedirectGuard` refuses credentialed or non-GET redirects to another origin.
- A stale refresh or 401 can never end a newer session (session generation, `refreshOutcome`).
- An approved pair poll is kept only when the pair view still wants it.
- `KioskStoreOpener`: a corrupt store is moved aside with its queued scans salvaged; any other open
  failure runs in memory for that launch (`storeIsTemporary`). Android Room has no such fallback.
- The outbox shows an operator toast on Scanning when a scan can't be saved ("Couldn't save this
  scan on the kiosk. Check its storage."); Android only logs it.
- An in-flight outbox batch finishes under a UIKit background task when the app is backgrounded.
- The outbox runs only while the app is active and signed in; Android starts it whenever the app
  is in front.
- The kiosk serial is kept in the Keychain (survives a reinstall); Android keeps it in DataStore.
- `KioskApi.fetchImage` for presigned photos (Android does the same inline).
