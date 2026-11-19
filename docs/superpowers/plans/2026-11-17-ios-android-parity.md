# iOS ↔ Android Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the iOS kiosk app's gaps against the Android app in four batches: Clear Setup and station key; quick wins; Asset Lookup; Troubleshooting hardening. RFID sled, handheld and Zebra SDK items are excluded.

**Architecture:** The Android app is the reference implementation. Each task ports one Android behavior into the iOS app's existing layers:
- pure rules go in `Core/` (Foundation only);
- I/O goes in `Data/`;
- SwiftUI goes in `UI/`.

No server changes: every route already exists.

**Tech Stack:** Swift 5, SwiftUI, Swift Testing, XCUITest. The Android source (Kotlin and Compose) is read for reference only.

**Spec:** `docs/superpowers/specs/2026-11-17-ios-android-parity-design.md`. Gap detail with Android file paths is in `docs/superpowers/research/2026-11-17-ios-parity/`: `GAP-LIST.md` plus the four area reports.

## Global Constraints

**Paths**
- `A/` = `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/`.
- Android tests are in `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/`.
- `IK/` = `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`.
- `IT/` = `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa KioskTests/`.
- `UIT/` = `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa KioskUITests/`.

**Behavior rules**
- **Match Android.** Behavior, rules, error codes and user-facing copy match Android, unless the spec says otherwise. Read the Android code and its tests for every item, and port the Android test cases that apply, minus anything about the sled, DataWedge or Zebra SDK.
- **Layering.** `Core/` imports Foundation only (`CorePurityTests`). Every new `KioskApi` member is added to `IT/Support/FakeKioskApi.swift`.
- **Appearance.** Never force a theme. Modals have rounded corners. Sheet and modal buttons are never only reachable by scrolling.
- **Language.** American English.
- **Don't regress iOS-only behavior.** Two examples:
  - Home hides apps that need setup until Kiosk Setup is done (`homeTiles` filters with `featureAvailable`).
  - There is no Face ID auto prompt right after Sign out.

**Commands.** Run these from `IOS_Kiosk_App/ServerSherpa Kiosk/`, with `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`, in the foreground with long timeouts, and filter the output.
- **Unit tests:** `xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3),OS=18.5' -derivedDataPath ../.derived-parity -only-testing:"ServerSherpa KioskTests"`.
  - Use focused `-only-testing:` runs while you iterate, and one full run before you commit.
  - Ignore the known pre-existing failure `JavaScriptLabelEngineTests/theReferenceCasesPrintByteForByte`.
- **Simulator build:** `xcodebuild build -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' -derivedDataPath ../.derived-parity`.
- `../.derived-parity` is untracked. Never commit it, and delete it when the plan is done.

## Review Focus

These are the cases most likely to break. Each must have a test in the task named.

1. **A clear while someone else is signed in.** A clear-setup answer that lands after a sign-out, or while a different person is signed in, must never apply to the wrong session. **Task 1:** `aClearAnsweredAfterStopIsNeverApplied` and `aClearNeverReachesAnotherPersonsSession`.
2. **A clear while Time Clock is running.** If a clear arrives while the station is mid-flow, the station key is dropped and the next tile tap must not use a stale key. **Task 1:** `clearSetupDropsTheStationKey`.
3. **The Time Clock tile tapped twice.** The issue must run once, and the tile must stay disabled. **Task 2:** `theTileRunsOnceWhileTheKeyIsIssued`.
4. **Asset Lookup offline with nothing synced.** It must say so, not show "No asset matches". **Task 5:** `offlineWithNoSyncedMoveSaysSo`, with Android's copy.
5. **A secret split across lines in a printer reply.** It must still be masked, or the line dropped whole. **Task 7:** port Android's `TroubleshootingModelTest` cases, including the unparseable-line case.

---

### Task 1: Portal Clear Setup (batch 1, gap #1)

**Files:**
- Modify:
  - `IK/Core/Model/Kiosk.swift`: `HeartbeatIn.setupCleared`, `HeartbeatResult.clearSetup`
  - `IK/Data/Heartbeat/Heartbeat.swift`
  - `IK/Data/Prefs/KioskPrefs.swift`: the setup-clear record, its pending ack and its notice
  - `IK/App/AppContainer.swift`: drop the station key on a clear
  - `IK/UI/RootView.swift` or the shell: the redirect to Kiosk Setup
  - `IK/UI/Screens/Setup/KioskSetupScreen.swift` and `KioskSetupViewModel.swift`: the banner and the wizard restart
  - `IK/UI/Guards/SetupGate.swift` if needed
- Reference (Android): `A/data/heartbeat/Heartbeat.kt`, `A/core/model/Kiosk.kt`, `A/data/prefs/KioskPrefs.kt` (`SetupClearRecord`, `applySetupClear`, `pendingSetupClearAck`, `settleSetupClearAck`, `dismissSetupClearNotice`), `A/ui/KioskApp.kt` (`SetupClearedRedirect`), `A/ui/screens/setup/*`, `A/AppContainer.kt`.
- Reference (old iOS work): `git show 351256c4a`, `d933f62cf` and `fa5508821`. Read them, then port by hand.
- Tests: `IT/Data/HeartbeatTests.swift`, `IT/Data/KioskPrefsTests.swift`, `IT/UI/KioskSetupViewModelTests.swift` (or the existing setup test file), and `IT/Data/AppContainerTests.swift`.

**Behavior** (spec Batch 1 › #1):
- **Applying a clear.** A heartbeat answer of `clear_setup` while signed in does all of this:
  - drops `prefs.setupSelection`;
  - sets the setup state to incomplete;
  - drops the Time Clock station key;
  - records the pending ack;
  - posts the notice.
- **Acknowledging.** Later beats send `setup_cleared` until the server stops asking. The ack settles only on the beat that carried it.
- **Redirect and banner.**
  - The redirect to Kiosk Setup fires once, and only while signed in.
  - The banner reads "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue." until it is dismissed, or until setup completes the way Android clears it.
  - An open wizard restarts at step 1.
- **Never applied:**
  - by a beat answered after `stop()`;
  - to a different person's session.

- [ ] **Step 1: Write the failing tests.**
  - `aClearSetupAnswerDropsSetupAndStationKey`
  - `clearSetupDropsTheStationKey`
  - `theAckIsSentUntilTheServerStopsAsking`
  - `theAckSettlesOnlyOnTheBeatThatCarriedIt`
  - `aClearAnsweredAfterStopIsNeverApplied`
  - `aClearNeverReachesAnotherPersonsSession`
  - `theRedirectFiresOnceAndOnlyWhileSignedIn`
  - `anOpenWizardRestartsAtStepOne`
  - `theBannerShowsAfterAClearAndGoesAwayLikeAndroid`

  Port the assertions from Android's matching `HeartbeatTest`, `KioskPrefsTest` and `KioskSetupViewModelTest` cases.
- [ ] **Step 2: Run them.** Expect them to fail, at least to compile.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused suites, then the full unit target.** Expect them to pass.
- [ ] **Step 5: Commit.** `feat(ios): portal Clear Setup — drop setup and station key, banner, ack`

### Task 2: Time Clock tile gets a missing station key; sign-in method remembered (batch 1, gaps #2 and #3)

**Files:**
- Modify:
  - `IK/UI/Screens/Home/HomeScreen.swift`: `open(_:)` for `TIMECLOCK_STATION_FEATURE`
  - `IK/App/AppContainer.swift`: `startTimeclock` and `issueStationKey`
  - `IK/Data/Station/TimeclockStation.swift`
  - `IK/Data/Auth/KioskAuth.swift`
  - `IK/Data/Prefs/KioskPrefs.swift`: `signInMethod` under `ss.kiosk.signInMethod`
  - `IK/Data/Heartbeat/Heartbeat.swift`
  - `IK/UI/Screens/Setup/KioskSetupViewModel.swift`: drop the `?? .password` fallback near line 327
- Reference (Android):
  - `A/ui/screens/home/HomeScreen.kt` (`startTimeclock`, `startTimeclockError`)
  - `A/AppContainer.kt`
  - `A/data/station/StationStatus.kt` (`issueAndStore`)
  - `A/data/heartbeat/Heartbeat.kt` (`signInNow`, `setSignInMethod`)
  - `A/data/prefs/KioskPrefs.kt`
- Tests:
  - `IT/UI/HomeModelTests.swift` or a new `IT/UI/StationTileTests.swift`
  - `IT/Data/KioskAuthTests.swift`
  - `IT/Data/HeartbeatTests.swift`
  - `IT/Data/KioskPrefsTests.swift`

**Behavior** (spec Batch 1 › #2 and #3):
- **Time Clock tile with no key:**
  1. Issue a key under the session: one sign-in beat, and a retry on `not_signed_in_here`.
  2. Store the key.
  3. Sign out to Welcome.

  The tile is disabled while this runs. On failure the person stays signed in and sees one of three red messages, with Android's exact copy: network, `move_locked` and other.
- **Time Clock tile with a key:** it signs out as it does today.
- **Sign-in method:** it is persisted and reported by the restored session's sign-in beat. When it is unknown, the beat sends no `login_method`.

- [ ] **Step 1: Write the failing tests.**
  - `aStationWithoutAKeyIssuesOneThenSignsOut`
  - `aRefusedIssueRetriesOnceOnNotSignedInHere`
  - `issueFailuresShowAndroidsThreeMessagesAndStaySignedIn`
  - `theTileRunsOnceWhileTheKeyIsIssued`
  - `aStationWithAKeyJustSignsOut`
  - `theSignInMethodSurvivesARelaunch`
  - `anUnknownMethodSendsNoLoginMethod`
- [ ] **Step 2: Run them.** Expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused suites, then the full unit target.** Expect them to pass.
- [ ] **Step 5: Commit.** `feat(ios): Time Clock tile issues a missing station key; sign-in method remembered`

> After Task 2 the controller installs a Debug build on the iPad (batch 1).

### Task 3: Sign-in and Enroll quick wins (batch 2, gaps #4, #8 and #17)

**Files:**
- Modify:
  - `IK/Core/Scan/EnrollGate.swift`: add `checkEnrollRaw`
  - `IK/UI/Screens/Enroll/EnrollViewModel.swift`: `submitTag`
  - `IK/UI/Screens/Login/MovePasswordForm.swift` and `LoginViewModel.swift`: `submitScannedMove`
  - `IK/Input/Camera/CameraScanSheet.swift`: a QR-only mode
  - `IK/UI/Screens/Login/LoginScreen.swift` and `LoginLayout.swift`: the kiosk name under the wordmark
- Reference (Android):
  - `A/core/scan/EnrollGate.kt`
  - `A/ui/screens/enroll/EnrollViewModel.kt`
  - `A/core/rfid/SledWords.kt` (plain-text copy only)
  - `A/ui/screens/login/LoginScreen.kt` (`MoveScanButton`) and `LoginViewModel.kt` (`submitScannedMove`)
  - `A/input/camera/CameraScanSheet.kt` (`qrOnly`)
  - `A/ui/screens/login/LoginChrome.kt` (`LoginBrand(kioskName)`)
- Tests: `IT/Core/EnrollGateTests.swift`, `IT/UI/EnrollViewModelTests.swift`, `IT/UI/LoginViewModelTests.swift`, and a camera-mode test if one exists.

**Behavior** (spec Batch 2 › #4, #8 and #17):
- **#4 Enroll gate.** At the tag step, an asset ID or a serial is refused with Android's messages and is never padded.
- **#8 Move password QR.** A QR button on the Move password field opens the camera in QR-only mode.
  - The first code read fills the field and calls `submitMove`.
  - An error shows on the field's error line.
  - Single and Multi camera modes are unchanged.
- **#17 Kiosk name.**
  - The kiosk's name (`identity.current.name`) shows under the ServerSherpa wordmark on the sign-in page, in the existing login typography.
  - It appears in both the wide and the compact layouts.
  - Nothing is shown when the name is empty.

- [ ] **Step 1: Write the failing tests.**
  - `anAssetIdAtTheTagStepIsRefusedNotPadded`
  - `aSerialAtTheTagStepIsRefusedNotPadded`
  - `aRealTagStillEnrolls`
  - `aScannedMoveCodeSignsIn`
  - `aScannedMoveCodeErrorLandsOnTheField`
  - `qrOnlyModeIgnoresOtherSymbologies` (if the camera layer can be tested)
  - `theSignInPageShowsTheKioskName`, a model or layout test
- [ ] **Step 2: Run them.** Expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused suites and the simulator build.** Expect them to pass.
- [ ] **Step 5: Commit.** `feat(ios): enroll refuses non-tags, move password QR button, kiosk name on sign-in`

### Task 4: Rolodex parity (batch 2, gaps #5, #6 and #7, and the offline wording)

**Files:**
- Modify:
  - `IK/Core/Rolodex/RolodexModels.swift`: decode `jobs` and `jobs_total`
  - `IK/UI/Screens/Rolodex/RolodexWorkerView.swift`: the Previous jobs card, the photo tap, and removing Employee ID
  - a new `IK/UI/Screens/Rolodex/WorkerJobsCard.swift` and `PhotoViewer.swift`
  - the offline Contact copy
- Reference (Android): `A/ui/screens/rolodex/WorkerJobs.kt`, `PhotoViewer.kt` and `WorkerPage.kt`; `A/core/model/Rolodex.kt`.
- Tests: `IT/RolodexApiTests.swift` (decoding), `IT/RolodexLogicTests.swift` and `IT/RolodexModelTests.swift`.

**Behavior** (spec Batch 2 › #5, #6, #7):
- **Previous jobs card.**
  - Rows are newest first and show: name; "Type · Work type · Site"; "Added Oct 3, 2026"; a status chip in the initiative's color.
  - With no jobs it reads "No jobs yet."
  - Past 50 it reads "Showing the latest 50 of N jobs."
- **Photo tap.** Tapping the photo, not its badge, shows it full screen, scaled to fit. Close, a tap or Back dismisses it. With initials only, a tap does nothing.
- **Employee ID** is gone from the worker page.
- **Offline Contact** reads "Phone and email need a connection."

- [ ] **Step 1: Write the failing tests.**
  - `workerDetailDecodesJobs`
  - `jobsAreNewestFirst`
  - `jobRowLines`
  - `noJobsSaysSo`
  - `moreThanFiftySaysShowingTheLatest`
  - `employeeIdIsNotOnTheWorkerPage`, a model test of the shown rows
  - `offlineContactWording`
  - `aPhotoTapOpensTheViewerButInitialsDoNot`, at view-model level
- [ ] **Step 2: Run them.** Expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused suites, then the full unit target.** Expect them to pass.
- [ ] **Step 5: Commit.** `feat(ios): Rolodex previous jobs, photo viewer, no Employee ID`

> After Task 4 the controller installs on the iPad (batch 2).

### Task 5: Asset Lookup — data and rules (batch 3, gap #9)

**Files:**
- Create:
  - `IK/Core/Model/Lookup.swift`: the wire models
  - `IK/Core/Lookup/AssetLookup.swift`: pure rules, including matching, limits, the offline search and "Matched on"
  - `IK/Data/Lookup/AssetLookupRepository.swift`: online calls with an offline fallback to `KioskStore`
- Modify:
  - `IK/Data/Api/KioskApi.swift` and `URLSessionKioskApi.swift`: `lookupAssets`, `assetDetail`, `assetScans`
  - `IT/Support/FakeKioskApi.swift`
  - `IK/Core/Features.swift`: `FeatureId.lookup` and its feature entry, in Android's order
- Reference:
  - Android: `A/core/model/Lookup.kt`, `A/core/lookup/AssetLookup.kt`, `A/core/text/NaturalSort.kt`, `A/data/lookup/AssetLookupRepository.kt`, `A/data/api/OkHttpKioskApi.kt`, and their tests.
  - Specs: `2026-11-08-kiosk-asset-lookup-design.md` and `2026-11-10-android-asset-lookup-design.md`.
- Tests: `IT/Core/AssetLookupTests.swift`, `IT/Data/AssetLookupRepositoryTests.swift`, and the API endpoint tests.

**Behavior** (spec Batch 3, rules only):
- Search by tag, serial, RFID or name.
- One match gives the detail; several give up to 25 with "Matched on"; none gives "No asset matches X."
- Admin-only fields come from the server's role gating.
- With `scans:view`, the latest 50 scans are shown.
- **Offline:** it searches the synced move and shows "Offline — showing this move's devices only." Scan history reads "needs a connection".
- **Offline with nothing synced:** it uses Android's copy.
- Every sled item is excluded.

- [ ] **Step 1: Write the failing tests.** Port Android's `AssetLookupTest` and `AssetLookupRepositoryTest` cases, minus the sled ones. Include `offlineWithNoSyncedMoveSaysSo`.
- [ ] **Step 2: Run them.** Expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused suites.** Expect them to pass.
- [ ] **Step 5: Commit.** `feat(ios): Asset Lookup data, rules and offline fallback`

### Task 6: Asset Lookup — screen (batch 3, gap #9)

**Files:**
- Create: `IK/UI/Screens/Lookup/AssetLookupViewModel.swift` and `AssetLookupScreen.swift`.
- Modify: `IK/UI/Routes.swift`, `IK/UI/RootView.swift` (the destination), `IK/UI/Screens/Home/FeatureIcons.swift` (the icon) and `IK/App/AppContainer.swift` if needed.
- Reference (Android): `A/ui/screens/lookup/AssetLookupViewModel.kt` and `AssetLookupScreen.kt`, `A/ui/components/ColorChip.kt`, `A/ui/screens/home/FeatureIcons.kt`.
- Tests: `IT/UI/AssetLookupViewModelTests.swift`, and a UI smoke test if it's practical.

**Behavior** (spec Batch 3):
- Input by typing, a keyboard scanner or the camera.
- The results list, the detail card (identity, routes, and the admin status, location and moves), and the scans section.
- The tile is hidden until setup is done, which follows from `homeTiles`.
- On iPad it uses the width the way `ScanTable` does.
- No buttons are hidden behind a scroll.
- It follows the theme.

- [ ] **Step 1: Write the failing tests.** Cover the view-model states: idle, searching, one match, many matches, no match, offline, error, an admin's extra fields, the scans gate, and that the tile appears only after setup is done.
- [ ] **Step 2: Run them.** Expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused suites, then the full unit target, then the simulator build.** Expect them to pass.
- [ ] **Step 5: Commit.** `feat(ios): Asset Lookup screen and Home tile`

> After Task 6 the controller installs on the iPad (batch 3).

### Task 7: Troubleshooting masking (batch 4, gaps #10, #11 and #12)

**Files:**
- Modify: `IK/UI/Screens/Settings/TroubleshootingModel.swift` and `TroubleshootingPanel.swift`.
- Move the pure redaction into `IK/Core/` if it needs nothing beyond Foundation.
- Reference (Android): `A/ui/screens/settings/TroubleshootingModel.kt` (`redactSecrets`, `maskSecrets`, `asksForASecret`, `describe`, `troubleText`, `withoutPanelPassword`, `scanLine`, `report`) and `TroubleshootingModelTest`.
- Tests: `IT/UI/TroubleshootingModelTests.swift`, or the existing file.

**Behavior** (spec Batch 4 › #10, #11, #12): mask secrets in the report and log, mask the `~HS` panel password on screen and in the report, and show other people's Bluetooth devices as "Other device · -NN dBm" in the report and log, exactly as Android does.

- [ ] **Step 1: Write the failing tests.** Port every redaction, panel-password and scan-line case from `TroubleshootingModelTest`.
- [ ] **Step 2: Run them.** Expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused suites.** Expect them to pass.
- [ ] **Step 5: Commit.** `feat(ios): Troubleshooting masks secrets, panel password and other people's devices`

### Task 8: Troubleshooting behaviors (batch 4, gaps #13, #14, #15 and #16)

**Files:**
- Modify: `IK/UI/Screens/Settings/TroubleshootingModel.swift`, `TroubleshootingPanel.swift` and `SettingsScreen.swift`, plus the route plumbing the Printer Setup button needs.
- Reference (Android): `TroubleshootingModel.kt` (`sendCommand`, `sendFormat`, `sendsAsFormat`, `hasHostCommand`, `shareableReport`, `fit`, `REPORT_FAILED_TEXT`, `scan`, `appResumed`, `bluetoothReady`, `rescanWhenReady`, `SCAN_ENDED_EARLY_TEXT`), `TroubleshootingPanel.kt` and `SettingsScreen.kt`.
- Tests: `IT/UI/TroubleshootingModelTests.swift`.

**Behavior** (spec Batch 4 › #13–#16):
- **#13** A typed `^XA` with no `^H` or `~H` query is sent as a format under the printer guard. The reply line reads "Sent as a label or format; no reply is read."
- **#14** A Printer Setup button appears when no printer is saved. It works from the signed-in Settings; from the login gear's sheet, behave as Android does or hide the button.
- **#15** The report is built off the main actor. "Preparing the report…" appears after 400 ms. A failure shows "Couldn't build the report. Try again." Copying shows "Report copied."
- **#16** A refused scan restarts once Bluetooth is ready. A scan ended early says "The scan stopped early. Scan again."

- [ ] **Step 1: Write the failing tests.** Port Android's matching cases.
- [ ] **Step 2: Run them.** Expect them to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused suites, then the full unit target, then the simulator build.** Expect them to pass.
- [ ] **Step 5: Commit.** `feat(ios): Troubleshooting sends formats, Printer Setup button, background report, scan restart`

> After Task 8 the controller installs on the iPad (batch 4).
