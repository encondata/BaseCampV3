# Time Clock station on Android and iOS: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Android and iOS kiosks get two things:
- the new guided time clock flow;
- a dedicated **Time Clock station** mode. The station rests on Welcome, nobody needs to be signed in, and it punches through its own station key.

**Architecture:**
- **API:** one small change lets `android`, `zebra` and `ios` kiosks hold a `timeclock` station key.
- **Shared design per app:** each app gets:
  - a pure flow reducer, ported from `kiosk/src/timeclock/flow.ts`;
  - native screens for the reducer's steps;
  - a station API client that sends `Authorization: Station <key>`;
  - the key, kept in the platform's secure store;
  - a station-type step in Kiosk Setup;
  - a signed-out Welcome screen, shown by the auth guard in place of Login when the kiosk is an armed Time Clock station.
- **Order:** Android first, then iOS. Each platform has three tasks: data, flow, station mode.

**Tech Stack:** FastAPI/pytest (API); Kotlin, Compose, Room and Robolectric (Android); SwiftUI, SwiftData and Swift Testing (iOS).

**Spec:** `docs/superpowers/specs/2026-10-20-kiosk-timeclock-station-design.md`. Sections 4–9, plus the phase-1 Implementation notes. Section 9 is these phases.

**Reference implementation (phase 1, on main):**
- `kiosk/src/timeclock/`: `flow.ts` (the reducer), `TimeclockFlow.tsx`, `screens/*`, `OnScreenKeyboard.tsx`, `TcShell.tsx`, `format.ts`, `useIdle.ts`, `backend.ts`, `stationApi.ts`.
- The API station routes in `api/src/serversherpa/api/routes/kiosk.py`.

Every copy string, timer and step rule comes from these files verbatim. Port them, don't reinvent them.

## Global Constraints

- **Steps:** `welcome` (station only) → `name` → `confirm` → `action` → `clockOut` (clock-out only) → `badge` (after a clock-in) → `printing` → `verify` → `done`. Back rules, the busy guard and `punchFailed` handling are exactly as in `flow.ts`.
- **Timers:** `IDLE_MS` 20 s, applied off the start step and not on `done`. `DONE_MS` 8 s. `PRINTING_MS` 3 s. `MESSAGE_MS` 5 s. `SCAN_QUIET_MS` 1.5 s. Reads time out at 10 s. Punches never time out.
- **Where it returns:**
  - Station: start and every exit go to Welcome.
  - Regular kiosk: the Timeclock tile starts at Enter Your Name, and exits (including Back on Name) go Home.
- **Clock In** punches before any badge step. Lunch Out/In is left out. Badge printing and verification are placeholders.
- **Light mode only.** Portrait and landscape follow the spec's layout A:
  - results beside the keyboard;
  - the photo left of the name;
  - the tiles in one row;
  - the total left of the punches table.
- **No orange dashed route line.**
- **Artwork already bundled:**
  - Android: `R.drawable.login_mountains_light`, `R.drawable.login_logo`.
  - iOS: `Image("LoginMountains")`, `Image("Logo")`.
  - Colors: ink `#0F172A`, amber `#FF6A00`, paper `#FFF9F2`.
- **The header** has the logo, the wordmark, "DATACENTER RELOCATION TOOLS", and a live date and time. The gear shows on Welcome in station mode only.
- **The footer** has the mountains and "TRACK | MONITOR | VERIFY | COMPLETE".
- **`tz`** is the device's IANA zone (`ZoneId.systemDefault().id` / `TimeZone.current.identifier`). It is sent on every status read and punch, on both session and station routes.
- **Station calls** send only `Authorization: Station <key>`, plus `serial` in the body (POST) or the query (GET). There is no Bearer token, no refresh, and no session-ended handling on station calls.
- **Station errors:**
  - 401 `station_key_invalid` drops the stored key.
  - 403 `kiosk_not_registered` keeps the key and shows the paused copy.
  - 403 `wrong_station_type` is treated like an invalid key.
  - 409 `already_clocked_in` / `not_clocked_in` is the "Your status changed. Please choose again." path.
  - 423 means read-only.
- **The key** is shown once by `POST /kiosk/station-key`. It is stored only in the secure store: Android `AndroidSecretStore` (EncryptedSharedPreferences, Keystore) and iOS `KeychainSecretStore`. It is never logged and never written to plain preferences.
- **The station key reaches only:** `GET /kiosk/station/sync/people`, `GET /kiosk/station/timeclock/{person_id}`, and `POST /kiosk/station/timeclock/clock-in|clock-out`.
- **A worker at a station must not reach** Kiosk Setup, Settings or any other feature without signing in. The gear goes to Login.
- **Code style:** American English. Reuse the existing flash and sound, `matchPersonExact` and `searchPeople` (max 8), and the camera scan sheet into `ScanBus`. iOS: every new file basename must be unique, and never hand-edit the pbxproj. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An app killed and relaunched while armed** must come back to Welcome signed out, not to Login. The key survives in the secure store, and the station type in prefs. Covered by Tasks 4 and 7: `aRelaunchedArmedStationRestsOnWelcome`.
2. **A key revoked mid-shift** (Clear Setup, a re-setup elsewhere, or deleted on Kiosk Devices) gives the next station call 401. The key must be dropped and Welcome must show the "waiting for its station key" copy. The app must not crash or loop. Covered by Tasks 4 and 7: `aRevokedKeyShowsWaitingForKey`.
3. **A double tap or a retry after a network failure** must never send two punches. The busy guard holds until the punch settles, and Try again re-reads the status first. Covered by Tasks 3 and 6: `aSecondTapWhilePunchingIsIgnored`.
4. **Rotation mid-flow** (Android configuration change, iPad rotation) keeps the step, the person and the typed text. Covered by Tasks 3 and 6: `rotationKeepsTheStep`. The state lives in the view model, not the composable or the view.
5. **A person with no photo, no job title and no Employee ID** gets a confirm card with initials and no empty lines. An unknown QR code or a scanned asset barcode gets "We couldn't find that code." Covered by Tasks 3 and 6.

---

### Task 1: API — Time Clock keys on Android, Zebra and iOS kiosks

**Files:**
- Modify: `api/src/serversherpa/services/station_keys.py` (`verify`)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (`is_station`, ~line 667)
- Test: the existing station-key and timeclock-station tests under `api/tests/`. Extend whichever file covers `verify` and `POST /kiosk/station-key`.

**Interfaces:**
- Produces: a `timeclock` device whose `sub_type` is in `{"laptop","android","zebra","ios"}` passes `verify` and `is_station`. `rfid` and `label` stay laptop-only.

- [ ] **Step 1: Write failing tests.**
  - `test_android_timeclock_station_gets_and_uses_a_key`: a kiosk device with `sub_type="android"`, `station_type="timeclock"` and a signed-in session stamped on the device. `POST /kiosk/station-key` returns 200 `{key}`, and `GET /kiosk/station/timeclock/{person}` with `Authorization: Station <key>` returns 200.
  - The same test for `"ios"` and `"zebra"`, parametrized.
  - `test_android_rfid_station_still_refused`: `sub_type="android"`, `station_type="rfid"` gives 409 `not_rfid_station` on station-key.
- [ ] **Step 2: Run them.** `cd api && SS_TEST_DB=serversherpa_test_tcnative .venv/bin/pytest -k "station" -q` → the new tests FAIL.
- [ ] **Step 3: Implement.** One shared predicate `station_sub_type_ok(device) -> bool`: laptop for any station type; `android`/`zebra`/`ios` only when `station_type == "timeclock"`. Use it in both `verify` and `is_station`.
- [ ] **Step 4: Run the full API suite** (same env) → PASS.
- [ ] **Step 5: Commit** `feat(api): Time Clock station keys on Android, Zebra and iOS kiosks`.

---

### Task 2: Android data layer — fields, people, station client, key store

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/model/Timeclock.kt`.
  - The status gains `today_minutes: Int`, plus `today_entries: List<TodayEntry>` where `TodayEntry(clock_in_at: String, clock_out_at: String?, minutes: Int)`.
  - The person gains `job_title: String?` and `external_id: String?`.
  - The request bodies gain `tz: String?`.
- Modify: `core/model/Sync.kt`. `KioskPersonRow` gains `badge_uid: String?`, `job_title: String?` and `external_id: String?`.
- Modify: `data/db/Entities.kt` (`PersonEntity`), `data/db/KioskDatabase.kt` (version +1, `MIGRATION_n_n+1` adding three nullable TEXT columns), and the exported schema JSON.
- Modify: `core/people/PeopleMatch.kt`. `MatchPerson` gains `badgeUid`. The index gains `byBadge` (lowercased). `matchPersonExact` order: RFID, then badge_uid, then full id, then 8-character short id. This matches `kiosk/src/` `matchPersonExact`.
- Modify: `core/model/Kiosk.kt`.
  - `KioskSetupIn` gains `station_type: String?`. `initiative_id`, `site_id` and `scan_status` become nullable.
  - `KioskSetupResult` gets nullable fields to match `KioskSetupOut`.
  - `KioskSetupSelection` gains `stationType: String?` (null means a regular kiosk), with nullable move and site fields.
  - `SetupOptions` gains `sites: List<SetupSite>`, where `SetupSite(id, name)` mirrors the API's `setup-options.sites`.
- Create: `data/api/StationApi.kt`. It holds the interface `StationApi` and `OkHttpStationApi`, which share the OkHttp client and `errorFrom` with `OkHttpKioskApi`.
  - `suspend fun issueKey(serial: String): String` is a SESSION call (`POST /kiosk/station-key`, Bearer via the existing `authed`). It lives on `KioskApi` as `issueStationKey`.
  - `suspend fun people(key: String, serial: String): List<KioskPersonRow>` calls `GET /kiosk/station/sync/people?serial=`.
  - `suspend fun status(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus`.
  - `suspend fun clockIn(key, serial, personId, tz): KioskTimeclockStatus` and `clockOut(...)`, with body `{serial, person_id, tz}`.
- Create: `data/station/StationKeyStore.kt`. It holds `get(): String?`, `put(key)` and `clear()`, over `AndroidSecretStore` under the account `station_key`. AppContainer exposes it.
- Modify: `data/api/KioskApi.kt` and `OkHttpKioskApi.kt`. Session `timeclockStatus` / `clockIn` / `clockOut` pass `tz`. Add `issueStationKey(serial)`.
- Test: `MigrationTest` (the new version), `PeopleMatchTest` (badge_uid case-insensitive, and the order), `OkHttpStationApiTest` (MockWebServer: the header is exactly `Station <key>` with no Bearer, serial is in the query or body, and 401/403/409 map to `ApiError` codes), and `StationKeyStoreTest`.

**Interfaces:**
- Produces: `StationApi`, `StationKeyStore`, `KioskApi.issueStationKey`, the model fields above, and `matchPersonExact` with badge matching.

- [ ] **Step 1: Write the failing tests above.** Run `cd Android_Kiosk_App && ANDROID_HOME=~/Library/Android/sdk ./gradlew testDebugUnitTest` → FAIL.
- [ ] **Step 2: Implement.** Existing call sites must compile with the nullable setup fields. Regular kiosks always send non-null values, so keep their behavior.
- [ ] **Step 3: Full suite** → PASS.
- [ ] **Step 4: Commit** `feat(android): time clock data — today's hours, badge ids, station client and key store`.

---

### Task 3: Android — the new time clock flow, replacing the old screen

**Files:**
- Create: `ui/screens/timeclock/flow/TimeclockFlow.kt`, a pure reducer and a port of `flow.ts`:
  - `TcState(step, person, status, results, query, notice, busy, …)`;
  - `sealed interface TcEvent`;
  - `fun reduce(state: TcState, event: TcEvent, mode: TcMode): TcState`, where `TcMode` is `STATION` or `KIOSK`.
- Create: `ui/screens/timeclock/flow/TimeclockFlowViewModel.kt`. It owns the state, the timers (idle, done, printing, message), people loading, matching, and status and punch calls through a `TcBackend` seam:
  - `interface TcBackend { suspend fun people(): List<KioskPersonRow>; suspend fun status(id): KioskTimeclockStatus; suspend fun clockIn(id); suspend fun clockOut(id) }`;
  - `SessionTcBackend` uses `KioskApi` with `tz`, and the people from the Room db;
  - `StationTcBackend` (Task 4) uses `StationApi` and the key.
- Create: `ui/screens/timeclock/screens/` with one composable per step:
  - Welcome (two cards; Scan Your QR Code opens `CameraScanSheet`);
  - Name, with `OnScreenKeyboard.kt` as a port of the web keyboard: QWERTY, Shift, Backspace, the 123 layer `1234567890-'.,&@`, Space and Search, with auto-capitalization;
  - Confirm, with an avatar via the app's existing image loading and an initials fallback;
  - Action;
  - ClockOut, with `formatWorked` and `formatPunch` ported from `format.ts`;
  - Badge, Printing, Verify and Done.
  - `TcShell.kt` holds the header and footer, and a topographic background drawn in Canvas.
- Modify: `ui/screens/timeclock/TimeclockScreen.kt`. It now hosts the new flow in `KIOSK` mode, starting at `name`, with exits going Home. Delete the old two-state UI and its VM. Port or remove its tests.
- Test: `TimeclockFlowTest`, a pure reducer test that mirrors `kiosk/src/timeclock/flow.test.ts` case for case, and `TimeclockFlowViewModelTest`.

The ViewModel tests must cover:
- the timers, using a test dispatcher;
- `aSecondTapWhilePunchingIsIgnored`;
- `rotationKeepsTheStep` (recreate the screen and the VM survives);
- the 409 path;
- a network failure: the Try again flow re-reads the status;
- an unknown QR: not-found copy and flash;
- `confirmCardWithoutOptionalFields`;
- tz sent on status reads and punches.

- [ ] **Step 1: Write the failing tests.** Run them → FAIL.
- [ ] **Step 2: Implement.** Copy is verbatim from the web screens. Landscape follows the spec's layout A, chosen from `LocalConfiguration.current.orientation`. Scans come from `container.scanBus.events`, as the old screen collected them.
- [ ] **Step 3: Full suite plus `assembleDebug`** → PASS.
- [ ] **Step 4: Commit** `feat(android): guided time clock flow`.

---

### Task 4: Android — Time Clock station mode

**Files:**
- Modify: `ui/screens/setup/KioskSetupViewModel.kt` and `KioskSetupScreen.kt`.
  - A new first step, **"What is this kiosk?"**, with two cards: **Regular kiosk** ("Scan, enroll and print with a signed-in crew.") and **Time Clock** ("Crews clock in and out here; it stays ready on its own.").
  - Regular runs the existing steps unchanged.
  - Time Clock runs: Move (with a **No move** card) → Site (the move's sites, or every site in `setupOptions.sites` plus a **No site** card when there is no move) → finish.
  - Finish sends `KioskSetupIn(serial, initiativeId?, siteId?, scanStatus = "labeled"-style fixed value as the web sends, stationType = "timeclock")`, then calls `issueStationKey(serial)`, stores the key, saves the selection with `stationType="timeclock"`, and **signs the person out** to land on Welcome. That matches web's Start Time Clock.
  - If `issueStationKey` gives 403 `not_signed_in_here`, send one heartbeat and retry once.
  - Re-running setup as Regular clears the key.
- Create: `ui/screens/timeclock/StationWelcomeHost.kt`. It runs the flow in `STATION` mode with `StationTcBackend`. It loads people via `StationApi.people` into Room when it starts and whenever the flow returns to Welcome. The gear calls `nav.navigate(Routes.LOGIN)`.
  - The paused copy shows on 403 `kiosk_not_registered`.
  - The waiting-for-key copy shows when the key is missing or was dropped by 401 / 403 `wrong_station_type`.
- Modify: `ui/guards/KioskGuard.kt` and `ui/KioskApp.kt`. With `AuthState.Anon`, `selection.stationType == "timeclock"` and the key present, show `StationWelcomeHost` instead of navigating to Login. With the type set and no key, show Welcome with the waiting copy. The Login screen gets **"Back to the time clock"** when the kiosk is a Time Clock station.
- Modify: `ui/screens/home/HomeScreen.kt` and `core/features/Features.kt`. A signed-in person at a Time Clock station sees only three tiles: **Time Clock** (signs out and returns to Welcome), **Kiosk Setup** and **Settings**. Jimmy owns tile lists; the spec flagged this, and it mirrors web.
- Signed in at the station, the flow still punches through the station key (spec section 6).
- Test: `KioskSetupViewModelTest` (the type step, no move / no site, key issued and stored, the retry on `not_signed_in_here`, Regular clears the key) and `StationModeTest` (Robolectric):
  - `aRelaunchedArmedStationRestsOnWelcome`;
  - `aRevokedKeyShowsWaitingForKey`;
  - `pausedWhenNotRegistered`;
  - `gearGoesToLoginAndBackReturns`;
  - `stationHomeShowsThreeTiles`.

- [ ] **Step 1: Write the failing tests.** Run them → FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Full suite plus `assembleDebug`** → PASS.
- [ ] **Step 4: Commit** `feat(android): Time Clock station mode`.

---

### Task 5: iOS data layer

This mirrors Task 2. Files are under `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`:
- `Core/Model/Timeclock.swift`: the same fields as Task 2.
- `Core/Model/Sync.swift`: `KioskPersonRow` gets `badgeUid`, `jobTitle` and `externalId`.
- `Data/Db/Records.swift` (`PersonRecord`) and `Data/Db/KioskSchemaVersions.swift`:
  - add **KioskSchemaV3**, with a frozen copy of V2 kept and a lightweight V2→V3 stage;
  - golden hash tests for V3;
  - V2's golden test must still pass.
- `Core/People/PeopleMatch.swift`: badge matching in the same order as Task 2.
- `Core/Model/Kiosk.swift`: the same setup changes as Task 2.
- New `Data/Api/StationApi.swift`, with the protocol `StationApi` and `URLSessionStationApi`. It has the same four calls as Task 2 and uses the existing session but no `authed`. Add `KioskApi.issueStationKey(serial:)`.
- New `Data/Station/StationKeyStore.swift`, over `KeychainSecretStore`, account `station_key`.
- Session timeclock calls pass `tz`.
- Tests: `StoreMigrationTests` (V2→V3), `PeopleMatchTests`, `StationApiTests` (StubURLProtocol: the header is exactly `Station <key>` with no Bearer), `StationKeyStoreTests` (with a fake secret store), and `CorePurityTests` stays green.

- [ ] **Steps: failing tests → FAIL → implement → full iOS suite plus iPhone 16 build → PASS → commit** `feat(ios): time clock data — today's hours, badge ids, station client and key store`.

---

### Task 6: iOS — the new time clock flow

This mirrors Task 3.
- `UI/Screens/Timeclock/Flow/TimeclockFlowReducer.swift`: the pure reducer (basenames must be unique).
- `TimeclockFlowModel.swift`: an `@MainActor @Observable` model with injected clocks and sleepers for the timers, and a `TcBackend` protocol with session and station implementations.
- `UI/Screens/Timeclock/Steps/*.swift`: one view per step.
- `TcOnScreenKeyboard.swift` and `TcShell.swift`.
- The avatar uses `api.fetchImage`.
- Landscape is decided from the size class or the geometry aspect ratio.
- Replace the old `TimeclockScreen` and `TimeclockViewModel` UI with the flow in `KIOSK` mode.
- Tests: the reducer, ported from `flow.test.ts`, plus the model tests listed in Task 3, including `aSecondTapWhilePunchingIsIgnored` and `rotationKeepsTheStep` (state kept across a view rebuild).

- [ ] **Steps: failing tests → FAIL → implement → full suite plus iPhone 16 build → PASS → commit** `feat(ios): guided time clock flow`.

---

### Task 7: iOS — Time Clock station mode

This mirrors Task 4:
- `KioskSetupViewModel` gets the type step, the no-move and no-site path, key issuance with one heartbeat retry, sign-out, and landing on Welcome.
- `UI/Guards/KioskGuard.swift` (`guardScreen(for:)`) gets a `.stationResting` case before `.login`.
- New `StationWelcomeHost.swift`.
- `LoginScreen` gets "Back to the time clock".
- Station Home shows three tiles.
- The station people sync goes into SwiftData through `KioskStore`, which runs on its own queue.
- The same tests as Task 4, in Swift Testing.

- [ ] **Steps: failing tests → FAIL → implement → full suite plus iPhone 16 build → PASS → commit** `feat(ios): Time Clock station mode`.

---

### Task 8: Docs

- Append `## Implementation notes (phases 2 and 3)` to the spec: the rulings and the hardware checks still owed.
- Add a Time Clock station section to `Android_Kiosk_App/README.md` and `IOS_Kiosk_App/README.md`.
- Commit `docs: Time Clock station on Android and iOS`.

## After the tasks (controller)

1. One whole-branch review, then one fix wave.
2. **Gates:** the API suite, the Android suite plus `assembleDebug`, the iOS suite plus the iPhone 16 build, and the kiosk tests.
3. **Device test.**
   - Jimmy's Pixel: `adb install`.
   - Jimmy's iPad: `devicectl`, built from a detached scratch worktree with `generic/platform=iOS`.
   - Both against `https://api.dev.serversherpa.com`, after the dev DB is at the merged migration head.
   - Check:
     - set up as a Time Clock station, with no move;
     - the app signs out to Welcome;
     - a QR scan from the portal's /me "My QR code";
     - clock in, the badge placeholders, and done;
     - clock out shows today's hours;
     - relaunch rests on Welcome;
     - the gear goes to Login and Back returns;
     - the Regular kiosk Timeclock tile.
4. **Merge** to main, push, and update the sheet, Harbor Master and the wiki.
