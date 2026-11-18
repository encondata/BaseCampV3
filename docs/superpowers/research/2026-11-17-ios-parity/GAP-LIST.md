# iOS kiosk app: gaps against the Android app

Compared on main `28f180ee4` (2026-11-17). This list merges four area reports in this folder: `home-apps.md`, `settings.md`, `signin-setup-stations.md` and `data-sync-api.md`. Each claim below was checked against the code on both apps and in `api/`.

Paths:
- `A/` = `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/`
- `I/` = `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`
- Server = `api/src/serversherpa/api/routes/`

**Headline:** 18 gaps: 14 S, 3 M and 1 L. **No gap needs new server work.** Every route is already in `api/`, and most of them already serve Android. Two of the 18 need Jimmy's decision before anyone builds them (#17 and #18).

## Gap table

| # | Gap | What the user gets on iOS | Android files | iOS counterpart today | Server work | Size | Batch |
|---|---|---|---|---|---|---|---|
| 1 | **Portal Clear Setup** | When an admin presses Clear Setup on the kiosk's portal page, the iPad or iPhone drops its setup and any Time Clock station key at the next signed-in heartbeat. Whoever is signed in lands on Kiosk Setup, from any screen, with the banner "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue.", and an open wizard restarts at step 1. The kiosk then acknowledges with `setup_cleared`. **Today this is broken on iOS:** the clear never completes, and the portal shows it as pending forever. While it is pending, `POST /kiosk/station-key` refuses with 409 `setup_clear_pending`, so that device can't become a Time Clock station until an admin cancels the clear. | `A/data/heartbeat/Heartbeat.kt`, `A/core/model/Kiosk.kt`, `A/data/prefs/KioskPrefs.kt` (`SetupClearRecord`, `applySetupClear`, `pendingSetupClearAck`, `settleSetupClearAck`, `dismissSetupClearNotice`), `A/ui/KioskApp.kt` (`SetupClearedRedirect`), `A/ui/guards/SetupGate.kt`, `A/ui/screens/setup/KioskSetupScreen.kt` and `KioskSetupViewModel.kt`, `A/AppContainer.kt` (drops the station key) | None on main: `I/Data/Heartbeat/Heartbeat.swift` and `I/Core/Model/Kiosk.swift` have no `clear_setup` or `setup_cleared`. **Unmerged branch `ios-clear-setup`** (4 commits, head `351256c4a`, from 2026-10-01, +576 lines over 17 files) built most of it. Main has since reworked those files, so it must be ported by hand, not merged. | Exists (`kiosk.py` heartbeat, `devices.py:460` and `:482`, `schemas.py` `HeartbeatIn` and `HeartbeatOut`) | M | 1 |
| 2 | **Time Clock tile gets a missing station key** | On a Time Clock station's Home, tapping Time Clock first checks for the station key. If the key is missing, the app issues one under the signed-in session (with one sign-in beat, and a retry on `not_signed_in_here`), then signs out to Welcome. The tile is disabled while this runs. If it fails, the person stays signed in and sees one of three red toasts (network, `move_locked`, other). Today an iOS station whose key was dropped waits on Welcome until someone runs Kiosk Setup again. | `A/ui/screens/home/HomeScreen.kt` (`startTimeclock`, `startTimeclockError`), `A/AppContainer.kt` (`startTimeclock`, `issueStationKey`), `A/data/station/StationStatus.kt` (`issueAndStore`) | `I/UI/Screens/Home/HomeScreen.swift` `open(_:)` only calls `auth.logout()`. The code to reuse is in `I/UI/Screens/Setup/KioskSetupViewModel.swift` `issueStationKey(serial:)` and `TimeclockStation.storeKey`. | Exists (`POST /kiosk/station-key`, `kiosk.py:925`; iOS already calls it) | S | 1 |
| 3 | **Sign-in method remembered** | The portal's device row shows the right sign-in method (password, link or Face ID) after the app restarts and restores the session. Today iOS keeps the method in memory only, so after a relaunch it reports "password". When the method is unknown, the beat sends no method rather than a guess. | `A/data/heartbeat/Heartbeat.kt` (`signInNow`, `setSignInMethod`), `A/data/prefs/KioskPrefs.kt` (`ss.kiosk.signInMethod`) | `I/Data/Auth/KioskAuth.swift` `lastSignIn` (in memory only); `I/UI/Screens/Setup/KioskSetupViewModel.swift:327` falls back to `?? .password` | Exists (`POST /kiosk/heartbeat`, `sign_in` and `login_method`) | S | 1 |
| 4 | **RFID Enroll refuses an asset ID or serial at the tag step** | Scanning a barcode label by mistake at "Scan the RFID tag" is refused with a message such as "That's this asset's own serial, not an RFID tag." or "That's the asset ID for <name>, not an RFID tag." Today iOS zero-pads that value and saves it as the tag. | `A/core/scan/EnrollGate.kt` (`checkEnrollRaw`), `A/ui/screens/enroll/EnrollViewModel.kt` (`submitTag`); the copy is in `A/core/rfid/SledWords.kt` but is plain text | `I/Core/Scan/EnrollGate.swift` has only `checkEnrollTag`. `I/UI/Screens/Enroll/EnrollViewModel.swift` `submitTag` goes straight to `padRfid`. | None (same `POST /kiosk/assets/{id}/rfid`) | S | 2 |
| 5 | **Rolodex: Previous jobs card** | The worker page lists the initiatives the worker was added to, newest first. Each row shows the name, "Type · Work type · Site", "Added Oct 3, 2026" and a status chip in the initiative's color. With no jobs it reads "No jobs yet."; past 50 it reads "Showing the latest 50 of N jobs." | `A/ui/screens/rolodex/WorkerJobs.kt`, `WorkerPage.kt`, `A/core/model/Rolodex.kt` (`RolodexJob`, `jobs`, `jobs_total`) | None. `I/Core/Rolodex/RolodexModels.swift` doesn't decode `jobs`. | Exists (`GET /kiosk/rolodex/workers/{id}` already returns `jobs` and `jobs_total`, `kiosk_rolodex.py:233`) | S | 2 |
| 6 | **Rolodex: tap the photo to see it large** | Tapping the worker's photo (not its camera badge) shows it full screen, scaled to fit and not cut to a circle. Close, a tap anywhere or Back dismisses it. With initials only, a tap does nothing. | `A/ui/screens/rolodex/PhotoViewer.kt`, `WorkerPage.kt` (`PhotoWithBadge`) | None; only the badge does anything | None | S | 2 |
| 7 | **Rolodex: Employee ID off the worker page** | The worker page no longer shows Employee ID (Jimmy, 2026-10-22). It stays on the Time Clock confirm card. | `A/ui/screens/rolodex/WorkerPage.kt` (comment near line 433) | `I/UI/Screens/Rolodex/RolodexWorkerView.swift:183` still shows it. The Edit form already leaves it out. | None | S | 2 |
| 8 | **Move password: QR button** | The Move password field gets a QR button that opens the camera in QR-only mode. The first code read fills the field and signs in, and an error lands on the field's error line. A Bluetooth or USB scanner that types the code and Enter already works on iOS. | `A/ui/screens/login/LoginScreen.kt` (`MoveScanButton`, `CameraScanSheet(qrOnly = true)`), `LoginViewModel.kt` (`submitScannedMove`), `A/input/camera/CameraScanSheet.kt` (`qrOnly`), `LoginControls.kt` | `I/UI/Screens/Login/MovePasswordForm.swift` has no scan button. `I/Input/Camera/CameraScanSheet.swift` has Single and Multi modes but no QR-only mode, and it publishes to the `ScanBus`, which the sign-in screen doesn't listen to. | Exists (`POST /kiosk/move-login`; iOS already calls it) | S | 2 |
| 9 | **Asset Lookup** (new Home tile and screen) | A new "Asset Lookup" tile: "Scan an asset to see what it is and where it goes." You can type, use a keyboard scanner or the camera, and search by asset tag, serial, RFID or name. One match opens a card; several show a list of up to 25 with "Matched on"; no match says "No asset matches X." Everyone sees the name, make and model, tag, serial, RFID and each route's source and destination (site, rack, RU or position). Admins also see the status chip, current location ("container · on truck") and moves. Admins with `scans:view` also see the latest 50 scans. Offline, it searches the synced move, shows "Offline — showing this move's devices only.", and scan history reads "needs a connection". It is read-only. Under iOS's new Home rule the tile stays hidden until Kiosk Setup is done. | `A/core/model/Lookup.kt`, `A/core/lookup/AssetLookup.kt`, `A/core/text/NaturalSort.kt`, `A/data/lookup/AssetLookupRepository.kt`, `A/ui/screens/lookup/AssetLookupViewModel.kt` and `AssetLookupScreen.kt`, `A/ui/components/ColorChip.kt`, `A/core/features/Features.kt` (`LOOKUP`), `A/ui/Routes.kt`, `A/ui/KioskApp.kt`, `A/ui/screens/home/FeatureIcons.kt`, `A/data/api/OkHttpKioskApi.kt` (`lookupAssets`, `assetDetail`, `assetScans`) | None: `I/Core/Features.swift` has no `lookup`. The stored data is already there: `KioskStore.assetPayloads()`, `labelContext()` and container rows. `KioskAuth.can` covers `scans:view`. | Exists (`GET /kiosk/assets/lookup` `kiosk.py:1918`, `GET /kiosk/assets/{id}` `:1954`, `GET /kiosk/assets/{id}/scans` `:2022`) | M | 3 |
| 10 | **Troubleshooting: secrets masked in the report** | Copy and Share mask anything that looks secret: bearer tokens, JWTs, values named password, PSK, token, secret, cookie, API key, station key, session id, WEP key or PIN (quoted, unquoted, JSON and SGD forms), and passwords inside URLs. A line that can't be checked is replaced whole. The reply to a `getvar` of a secret setting is redacted. Logged failures carry only the error kind, never its message. Today iOS writes everything into the report as it is. | `A/ui/screens/settings/TroubleshootingModel.kt` (`redactSecrets`, `maskSecrets`, `asksForASecret`, `describe`, `troubleText`); port the redaction cases from `TroubleshootingModelTest` with it | `I/UI/Screens/Settings/TroubleshootingModel.swift` `report()` and `troubleText()` (no masking) | None | M | 4 |
| 11 | **Troubleshooting: printer's panel password hidden** | A reply to any `~HS` command shows the printer's 4-digit front-panel password as `****`, both on screen and in the report. | `TroubleshootingModel.kt` (`withoutPanelPassword`), `TroubleshootingPanel.kt` (`AskResultCard`) | `TroubleshootingPanel.swift` `AskResultCard` shows the reply unmasked | None | S | 4 |
| 12 | **Troubleshooting: other people's Bluetooth names left out** | In the report and log, a device that isn't a Zebra shows as "Other device · -52 dBm" (its name is often a person's, such as "Jimmy's AirPods"), and the report says so. The on-screen list still shows names. | `TroubleshootingModel.kt` `scanLine()` and `report()` | `TroubleshootingModel.swift:543` `scanLine()` logs every name | None | S | 4 |
| 13 | **Troubleshooting: a typed `^XA` format goes out as a label** | In the admin and developer command box, text that starts with `^XA` and has no `^H` or `~H` query goes out on the label send path, under the printer guard's rules: a cut font refuses it, and a send cut off part-way marks the printer for `~JX`. It then reads "Sent as a label or format; no reply is read." Today iOS sends it as a query. | `TroubleshootingModel.kt` (`sendCommand`, `sendFormat`, `sendsAsFormat`, `hasHostCommand`) | `TroubleshootingModel.swift` `sendCommand()` always runs `runQuery` | None | S | 4 |
| 14 | **Troubleshooting: Printer Setup button** | With no printer saved, the Connection section offers a Printer Setup button instead of only the text "Choose one in Label Printing › Printer Setup." Bring over only this no-printer case: Android's "found at another address" note follows a rule iOS doesn't share, because iOS adopts the new Bluetooth identifier on purpose. | `TroubleshootingPanel.kt` (`ConnectionSection`, `openPrinterSetup`), `SettingsScreen.kt` | The text only. `I/UI/RootView.swift` has `.labelsPrinter`, but `SettingsScreen` gets no path binding and also opens as a sheet from the login gear, so it can't push the route yet. | None | S | 4 |
| 15 | **Troubleshooting: report built in the background** | The report is built off the main thread, and "Preparing the report…" shows when that takes more than 400 ms. A failed build says "Couldn't build the report. Try again." Copy shows a "Report copied." toast. The 100,000-character cap matters less on iOS, which shares a file. | `TroubleshootingPanel.kt` (`ReportSection`), `TroubleshootingModel.kt` (`shareableReport`, `fit`, `REPORT_FAILED_TEXT`) | Copy builds the report on the main actor, with no failure message | None | S | 4 |
| 16 | **Troubleshooting: Bluetooth scan restarts once Bluetooth is ready** | A scan refused because Bluetooth was off or not allowed starts again by itself once Bluetooth is ready, or when the app comes back from Settings. A scan the system ended early says "The scan stopped early. Scan again." The Location parts are Android-only. | `TroubleshootingModel.kt` (`scan`, `appResumed`, `bluetoothReady`, `rescanWhenReady`, `SCAN_ENDED_EARLY_TEXT`), `TroubleshootingPanel.kt` | `TroubleshootingModel.swift` `scan()` shows the refusal and waits for another tap. The `.refused` and `.replaced` endings say nothing. | None | S | 4 |
| 17 | **Kiosk name on the sign-in page** *(needs Jimmy's OK)* | The kiosk's own name shows under the wordmark, so someone pairing a phone can see which kiosk they are on. | `A/ui/screens/login/LoginChrome.kt` (`LoginBrand(kioskName)`), `LoginScreen.kt` | None. The iOS sign-in page follows Jimmy's mockup exactly, so adding a line is a design call for him. | None | S | 5 |
| 18 | **Internet Test** (developer link conditioner) *(needs Jimmy's call)* | In Settings › Developer, Developer mode can slow the app's own traffic. One dial covers the portal API and one covers network printer sockets, each with Apple's presets or Custom. It turns itself off after 2 hours, at sign-out and on Clear Setup. While it is on, an amber "Net test" chip shows in the top bar and the Time Clock header. | The whole `A/nettest/` folder (about 1,800 lines, with `REMOVAL.md`), plus 25 `// INTERNET-TEST` lines in 9 files | None. `URLSessionKioskApi.makeSession(protocolClasses:)` could host the portal half; the printer half needs a wrapper around `I/Data/Printer/NetworkZebra.swift`. | None | L | 5 |

Small notes that don't need their own rows:
- **Rolodex offline copy.** The offline Contact card reads "Phone and email need a connection." on Android and "Contact details need a connection." on iOS. Pick one wording in batch 2.
- **Release channel.** Android ships through Play internal testing (README "Release build (Google Play)"). iOS has no TestFlight or App Store setup in the repo. That is distribution, not an app feature, but it decides how the iOS work reaches devices.

## Suggested build order

1. **Batch 1: heartbeat and station key** (#1 M, #2 S, #3 S). About 3–4 days. Start here because #1 is a real break today: the portal's Clear Setup does nothing on iOS and blocks that device's station key. All three touch `Heartbeat.swift`, the station key and the sign-in beat, so they share one round of tests. Port the `ios-clear-setup` branch by hand, and follow the review lessons recorded for that feature: the ack settles only on the beat that carried it, the redirect fires once, a stopped heartbeat never applies a clear, and a clear on an open wizard restarts it.
2. **Batch 2: quick wins** (#4, #5, #6, #7, #8, plus the Rolodex copy note; all S). About 2–3 days. These are small, independent UI and logic changes, and the server already sends everything they need.
3. **Batch 3: Asset Lookup** (#9 M). About 3–5 days. This is the biggest operator-facing feature. Use the two specs: `docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md` and `2026-11-10-android-asset-lookup-design.md`. Leave out every sled piece (see Excluded). On iPad, think about the wide table that `ScanTable` already uses.
4. **Batch 4: Troubleshooting hardening** (#10 M, #11–#16 S). About 3–4 days, all in `TroubleshootingModel.swift` and `TroubleshootingPanel.swift`. Do #10 and #11 first, because they keep secrets out of shared reports.
5. **Batch 5: needs a decision first** (#17 S, #18 L). Ask Jimmy before building either:
   - **#17:** a design change to his iOS sign-in mockup.
   - **#18:** the Android design put iOS out of scope, and iOS devices already have Apple's system-wide Network Link Conditioner.

Without #18 that comes to roughly 2.5–3.5 weeks.

## On hold (Jimmy, 2026-10-22: not to be started on the apps yet)

- **Containers:** a placeholder tile on both apps. The server already has `GET /kiosk/containers/{id}/assets`.
- **Trucks:** a placeholder tile on both apps. The server already has `GET /kiosk/trucks/{id}/containers`.

Neither app has more than a placeholder, so there's no gap today. They become iOS work only when Jimmy starts them.

## Excluded on purpose: RFID sled, handhelds, DataWedge and the Zebra SDKs

These are Android-only and were left out as asked. None should be ported.

- **Scanning:**
  - the live RFID read panel with Stop (`RfidReadPanel.kt`)
  - sweep bursts to the outbox (`ScanViewModel.onBurst`, `Outbox.enqueueAll`)
  - the sled line, Sled triggers control and sled Scan button (`SledControls.kt`, `ScanTools.kt`)
  - the DataWedge soft-trigger Scan button
- **Asset Lookup:** sled arming (`RfidOwner.LOOKUP`), the one-tag sweep lookup and the "N tags read" notice.
- **RFID Enroll, Print Labels and the move password:** sled scanner-session barcodes and DataWedge input, and `SledScanGuard` on the scan box, the Time Clock name field and the move password.
- **App-wide:**
  - sled flashes (`SledFlashOverlay.kt`)
  - `SledDisplayEffect` keep-screen-on
  - `SledScreenSignal`
  - `input/datawedge/*`, `input/rfid/*`, `core/rfid/*` and `ExternalKeyLog.kt`
- **Settings:**
  - the whole RFID tab (`RfidPanel.kt`)
  - the Admin RFID region and frequency-hopping rows
  - the Devices tab's DataWedge and RFID reader rows
  - the Developer rows "Simulate an RFID connection", "Zebra SDK logging" and "Offer Both in Sled triggers to everyone"
- **Heartbeat:** `raw_info["datawedge"]`.
- **Layout:** the MC2200 compact layout constants and the Zebra hardware keys and triggers.

## Not in either app, so not gaps

- Bulk Print (web kiosk only)
- Kiosk settings synced from the portal (the heartbeat `config` fields)
- The web's Developer-tab full reset (both apps have Reset app, which matches between them)
- Label, RFID and Dock stations (laptop only)
- The off-move alarm
- Uploaded sounds
- Printer telemetry
- Learning links
- Push notifications and analytics

## iOS has, Android lacks (keep these; several are worth porting to Android)

- **Home**
  - Home hides apps that need setup until Kiosk Setup is done, with the banner "Finish Kiosk Setup to see the other apps." (Jimmy, 2026-11-17). Android still greys them out.
  - Home uses three columns at 1000 pt or wider.
- **Wide layouts**
  - Scanning shows a wide five-column receipt table at 700 pt or wider.
  - RFID Enroll shows its session log beside the steps at 1000 pt or wider.
- **Camera**
  - The camera has Flip (front and back).
  - Settings › Devices has a back/front camera choice and a Torch row, and its camera text says which cameras exist.
- **Time Clock station**
  - The Time Clock station has its own on-screen keyboard and captures keystrokes from a hardware reader. Android uses the system keyboard by Jimmy's ruling.
  - Its sign-in Settings sheet closes when the sign-in request ends. Android covers this case with `StationIdleReturn` instead.
- **Face ID**
  - There is no Face ID prompt right after Sign out.
  - The biometric card follows Forget.
  - The automatic prompt waits while a sheet covers the card.
- **Sign-in page extras from the mockup**
  - Continue with SSO, which shows a "not enabled yet" note.
  - Forgot password? and Contact support, which open the Account Recovery card.
  - A show/hide eye on the move password.
- **Settings**
  - Saving a new API origin while signed in signs the kiosk out, so the token never goes to the new host. **This is an Android gap worth closing.**
  - This Kiosk has Copy serial and a Device model row.
  - Clear local data asks first.
  - Signed out, Settings hides the tab strip, and the login-gear sheet has Done.
  - Troubleshooting Share sends a named `printer-report-<stamp>.txt` file.
- **Shell**
  - A separate registration chip.
  - A long press on the person's name shows "Session ends …".
  - A "KIOSK · IPAD/IPHONE" chip.
  - The footer keeps Mode, Version and Data Sync. Android trimmed its footer on purpose in `936416f65`.
- **Screen awake:** the screen stays awake while signed in, and on a resting Time Clock station.
- **Time Clock day:** `timeclockStatus` sends `serial`, so "today" is the site's day.
- **Session safety**
  - Sign-out never waits on the network.
  - `RedirectGuard` refuses credentialed redirects to another origin.
  - A stale refresh can't end a newer session.
  - An approved pair poll is kept only when the pair view still wants it.
- **Storage and outbox**
  - A corrupt store is moved aside and its queued scans are salvaged, with an in-memory fallback for that launch.
  - A toast appears when a scan can't be saved.
  - An in-flight batch finishes in the background.
  - The outbox runs only while the app is active and signed in.
- **Serial:** the kiosk serial is kept in the Keychain, so it survives a reinstall.
