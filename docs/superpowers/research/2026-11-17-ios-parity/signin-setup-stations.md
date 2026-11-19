# Android → iOS parity: sign-in, session, Kiosk Setup, station modes

Scope: login screen options, must-change-password, sign-out, session restore and expiry, Kiosk Setup, Clear Setup, station types, heartbeat, portal kiosk config, registration.
Compared on main `28f180ee4` (2026-11-17).

Paths:
- Android: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/` (shown below as `A/`)
- iOS: `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/` (shown below as `I/`)

Anything that touches the Zebra sled, DataWedge or the Zebra SDKs is left out (see "Excluded" at the end).

## Summary

| # | Gap (Android has, iOS lacks) | Size | Server ready? |
|---|---|---|---|
| G1 | Portal **Clear Setup**: apply, acknowledge, banner, redirect to Kiosk Setup | M | Yes |
| G2 | Move password: **QR button** that opens the camera (QR only) and signs in | S | Yes (no new route) |
| G3 | Station **Time Clock tile** issues a missing station key before signing out, and shows errors | S | Yes |
| G4 | The **kiosk's name** under the logo on the sign-in page | S | n/a |
| G5 | The **sign-in method is remembered** across launches for the station-key sign-in beat | S | Yes |

Most of this area is already at parity: password sign-in and its error copy, pairing with a phone, move-password sign-in, the move lock, biometric sign-in (Face ID / Touch ID against Android's fingerprint), must-change-password, the sign-out confirmation, session restore, heartbeat cadence and registration, the Kiosk Setup wizard (Regular / Time Clock, Top/Front), the Time Clock station (key bound to the API origin, pause, Welcome, the gear, the 60 s idle return), and Reset app.

---

## G1. Portal Clear Setup (heartbeat request and acknowledgment)

- **What Android does.** An admin presses Clear Setup on the kiosk's page in the portal. On the next signed-in heartbeat the kiosk:
  - drops its saved setup and marks setup incomplete;
  - drops a Time Clock station key;
  - sends whoever is signed in to Kiosk Setup, once, with the banner "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue.";
  - on a summary or wizard already open, starts the wizard again at step 1;
  - from a setup-gated screen, goes to Setup rather than Home.

  It acknowledges the clear on an immediate second beat, and on every beat after until the server stops asking. The banner goes away once setup completes. The record is `ss.kiosk.setupClear` = `{id, acked, notice}`.
- **Android files:**
  - `A/data/heartbeat/Heartbeat.kt`: `setup_cleared` ack, applies `clear_setup`, `setupCleared` flow, immediate re-beat
  - `A/core/model/Kiosk.kt`: `HeartbeatIn.setup_cleared`, `HeartbeatResult.clear_setup`
  - `A/data/prefs/KioskPrefs.kt`: `SetupClearRecord`, `applySetupClear`, `pendingSetupClearAck`, `settleSetupClearAck`, `dismissSetupClearNotice`, `setupStateWithClearNotice`
  - `A/ui/KioskApp.kt`: `SetupClearedRedirect`, which sits beside the NavHost
  - `A/ui/guards/SetupGate.kt`: redirects to Setup while the notice is up
  - `A/ui/screens/setup/KioskSetupScreen.kt`: the banner
  - `A/ui/screens/setup/KioskSetupViewModel.kt`: restarts the wizard on a dropped setup; `dismissSetupClearNotice` on finish
  - `A/AppContainer.kt`: `heartbeat.setupCleared` → `stationKeys.clear()`
- **Closest on iOS:** none on main.
  - `I/Data/Heartbeat/Heartbeat.swift` never sends `setup_cleared` and ignores `clear_setup`. Its `HeartbeatIn` and `HeartbeatResult` in `I/Core/Model/Kiosk.swift` don't have those fields.
  - `I/UI/Screens/Setup/KioskSetupViewModel.swift` sets `step` only in `init`, so a setup dropped while the screen is open leaves an empty summary.
  - **There is unmerged prior work:** branch `ios-clear-setup` (4 commits, head `351256c4a`, based on `4e025baba`, 2026-10-01). It is +576 lines over 17 files: Heartbeat, KioskPrefs, SetupGate, RootView, KioskSetupScreen/ViewModel and tests.
  - Since that branch, main has reworked the same files (Time Clock station, biometric, labels). Port it by hand; a merge won't apply cleanly.
- **Server routes:** all exist.
  - `POST /kiosk/heartbeat` (`HeartbeatIn.setup_cleared`, `HeartbeatOut.clear_setup`: `api/src/serversherpa/api/schemas.py` lines 429–478, `api/routes/kiosk.py` around line 535).
  - The portal side: `POST /devices/{id}/clear-setup` and `/clear-setup/cancel` (`api/routes/devices.py` lines 460 and 482).
- **Why it matters on iOS today:**
  - A Clear Setup sent to an iOS kiosk never completes. The portal keeps showing it as pending.
  - While it is pending, `POST /kiosk/station-key` answers **409 `setup_clear_pending`** (`kiosk.py` line 944). So that iPad or iPhone can't become a Time Clock station until an admin cancels the clear. The setup saves, then the key step fails with that code.
- **Depends on excluded hardware/SDK:** no.
- **Size:** M. It is a port of the branch onto today's main, plus tests: the Heartbeat ack and settle rules, the prefs record, a one-shot redirect, the SetupGate redirect, the wizard restart, and dropping the station key.

## G2. Move password: QR button (camera, QR only)

- **What Android does.**
  - The Move password field has a QR button on any device with a camera. It opens the kiosk's own camera in QR-only mode.
  - The first code it reads goes into the field and signs in at once. An error lands in the field's error line.
  - The camera shows only over the Move view, and it closes when that view is left.
- **Android files:**
  - `A/ui/screens/login/LoginScreen.kt`: `MoveScanButton`, the `scanning` state, `CameraScanSheet(qrOnly = true)`, `vm.submitScannedMove`
  - `A/ui/screens/login/LoginViewModel.kt`: `submitScannedMove`
  - `A/input/camera/CameraScanSheet.kt`: the `qrOnly` mode
  - `A/ui/screens/login/LoginControls.kt`: the field's trailing slot
- **Closest on iOS:**
  - `I/UI/Screens/Login/MovePasswordForm.swift` is a secure field with an eye toggle and no scan button.
  - `I/Input/Camera/CameraScanSheet.swift` has Single and Multi modes, but no QR-only mode. It publishes to the `ScanBus`, which the sign-in screen doesn't listen to.
- **Server routes:** `POST /kiosk/move-login` already exists and iOS already calls it. Nothing new is needed.
- **Depends on excluded hardware/SDK:** no. Android also signs in from sled and DataWedge scans on the scan bus while the Move view is up; that part is excluded. A Bluetooth or HID scanner that types the code and Enter already works on iOS through `onSubmit`.
- **Size:** S. Add a QR-only mode to the camera sheet, a button in the field, and a scan handler that fills the field and submits.

## G3. Station Time Clock tile issues a missing station key

- **What Android does.** On a Time Clock station's Home, the Time Clock tile (the web's Start Time Clock) works like this:
  - It checks for the station key first. If there is none, it issues one (`POST /kiosk/station-key`, with one sign-in beat and a retry on 403 `not_signed_in_here`), then signs the person out onto Welcome.
  - While that runs, the tile is disabled.
  - If it fails, the person stays signed in and Home shows an error toast:
    - network: "The station key hasn't arrived yet. Check the connection and try again in a minute.";
    - `move_locked`: "A move password can't start the time clock. Sign in with your own account.";
    - anything else: "Couldn't start the time clock (code). Try again."
- **Android files:**
  - `A/ui/screens/home/HomeScreen.kt`: `startTimeclock`, `startTimeclockError`
  - `A/AppContainer.kt`: `startTimeclock()`, `issueStationKey()`
  - `A/data/station/StationStatus.kt`: `issueAndStore`, `issueStationKeyRetrying`
- **Closest on iOS:**
  - `I/UI/Screens/Home/HomeScreen.swift` `open(_:)` only calls `auth.logout()`.
  - A station whose key was lost (a 401, `wrong_station_type`, or an API URL change) rests on Welcome saying it is waiting for its key. The only way back is to run Kiosk Setup again.
  - The pieces to reuse exist: the key-issue logic in `I/UI/Screens/Setup/KioskSetupViewModel.swift` `issueStationKey(serial:)`, and `TimeclockStation.storeKey`.
- **Server routes:** `POST /kiosk/station-key` exists (`kiosk.py` line 924) and iOS already calls it.
- **Depends on excluded hardware/SDK:** no.
- **Size:** S. Move the key issue into a shared helper (container or `TimeclockStation`), then call it from the tile with a busy state and the three error messages.

## G4. Kiosk name on the sign-in page

- **What Android does.** Under the ServerSherpa wordmark and "DATACENTER RELOCATION TOOLS", the sign-in page shows the kiosk's own name (the name set in Settings › This Kiosk). That way, someone pairing a phone can see which kiosk they are on.
- **Android files:** `A/ui/screens/login/LoginChrome.kt` (`LoginBrand(kioskName)`), `A/ui/screens/login/LoginScreen.kt` (passes `identity.name`).
- **Closest on iOS:** the iOS login (`I/UI/Screens/Login/LoginScene.swift`, `LoginScreen.swift`, `LoginForm.swift`) follows Jimmy's mockup and never shows the kiosk name. The name appears only after sign-in, in the shell's top bar.
- **Server routes:** none.
- **Depends on excluded hardware/SDK:** no.
- **Size:** S. **Ask Jimmy first:** the iOS login was built to match his mockup exactly, so adding a line to it is a design decision for him.

## G5. Sign-in method remembered for the sign-in beat

- **What Android does.** It saves how the person last signed in (`ss.kiosk.signInMethod`: password, link or biometric) whenever a sign-in beat lands.
  - A later station-key retry (`heartbeat.signInNow()` on 403 `not_signed_in_here`) reports that same method, even after the app was relaunched and the session restored from the cookie.
  - If it doesn't know the method, it sends the beat with no method rather than guessing one.
- **Android files:** `A/data/heartbeat/Heartbeat.kt` (`signInNow()`, `prefs.setSignInMethod`), `A/data/prefs/KioskPrefs.kt` (`Keys.signInMethod`).
- **Closest on iOS:** `I/Data/Heartbeat/Heartbeat.swift` `signInNow(_:)` is called from `KioskSetupViewModel.issueStationKey` with `auth.lastSignIn ?? .password`. `lastSignIn` is held in memory only, so after a restore iOS reports "password" even when the person paired or used Face ID.
- **Who notices:** only the portal's device row, which shows the login method. The 30-day biometric anchor uses the server's own `auth_sessions.login_method`, so this doesn't affect it.
- **Server routes:** `POST /kiosk/heartbeat` (`login_method`, `sign_in`) exists.
- **Depends on excluded hardware/SDK:** no.
- **Size:** S. Store the method in prefs; send `sign_in` with no method when it is unknown.

---

## iOS has, Android lacks (one line each; keep these)

- **Home hides locked apps.** Before setup is complete, Home shows only Kiosk Setup, Rolodex (admins) and Settings (Jimmy, 2026-11-17, commit `62b4b607d`). Android still shows every tile, locked, with "Finish Kiosk Setup first."
- **No Face ID prompt right after Sign out.** The card waits for a tap (`KioskAuth.takeSignedOut`). Android's card prompts on its own every time the sign-in screen opens.
- **The biometric card follows Forget.** Forgetting the enrollment under the gear drops the card back to the password form (`LoginViewModel.followEnrollment`). The auto prompt also waits while the Settings sheet or the support card covers the card.
- **Login extras from the mockup:**
  - "Continue with SSO" (shows a not-enabled-yet note);
  - "Forgot password?" and "Contact support" open the Account Recovery card (`SupportCard.swift`). Android shows one line: "Reset it in the portal.";
  - the move-password field has a show/hide eye.
- **A new API address signs you out.** Saving an API URL with a different origin while signed in signs the kiosk out (`SettingsModel.saveUrls`), so the live token never goes to the new host. Android only says "Sign in again if the API changed" and keeps the session.
- **Settings › This Kiosk** has a Copy button for the serial and a Device model row.
- **Shell:**
  - a separate registration chip (Android colors the Sign out outline instead);
  - a long press on the person's name shows "Session ends …";
  - a "KIOSK · IPAD/IPHONE" chip;
  - the footer keeps Mode, Version and Data Sync. Android trimmed its footer to the move context on purpose, in `936416f65`.
- **Screen stays awake** while signed in, and on a resting Time Clock station (`AppContainer.refreshRunState`, `isIdleTimerDisabled`). Android keeps the screen on only for its sled display rules, which are excluded.
- **Time Clock station keyboard.** Enter Your Name has the in-app on-screen keyboard and captures keystrokes from a hardware reader (`TcOnScreenKeyboard.swift`, `TcKeyCapture.swift`). Android uses the system keyboard, by Jimmy's ruling; iOS keeps its own for now.
- **Clear local data** asks for confirmation (Developer tab). Android clears at once.

## Neither app has it, so it isn't a gap

- **Kiosk config synced from the portal (the per-kiosk settings document).** The server already accepts `config`, `config_changed_at` and `config_applied_version` on `/kiosk/heartbeat` and replies with `config_version` and `config` (`schemas.py` lines 443–448, `kiosk.py` `_sync_config`). Neither native app sends or applies them. They are "phases 2 and 3" of that feature and need a separate decision.
- **Developer-tab Clear Setup** (the web kiosk's full out-of-box reset, `kiosk/src/lib/factoryReset.ts`). Both apps have only **Reset app**, which keeps the sign-in and the unsent scans, at parity.
- **Label, RFID and Dock stations.** Kiosk Setup on both apps offers only Regular and Time Clock. The server refuses RFID and Dock on anything but a laptop (`rfid_needs_laptop`).

## Outside this area (seen in passing, for the other area owners)

- The Asset Lookup tile and screen exist on Android and not on iOS. That is the lookup area; the `FEATURES` lists differ by that tile.
- Internet Test (`A/nettest/*`, the "Net test" chip and footer item, turned off on sign-out and on Clear Setup) is Android-only. It is a developer link-conditioner tool, which belongs to the Settings/Developer area.

## Excluded (Zebra sled, handheld, DataWedge, vendor SDK)

- Move password over the scan bus (sled and DataWedge scans while the Move view is up), and `SledScanGuard` on the move-password field (`LoginScreen.kt` `guard.noteTyping` / `acceptTyped`).
- The heartbeat `raw_info["datawedge"]` key (`AppContainer.kt`). iOS sends its own `raw_info`: manufacturer, model, system name and version, idiom.
- `SledDisplayEffect` keep-screen-on, sled flashes, the Settings › RFID tab, the Admin RFID region row, and the Developer-tab "Zebra SDK logging", "Offer Both in Sled triggers" and "Simulate an RFID sweep" rows.
- The MC2200 compact sign-in layout constants (`MAX_ART_SHARE` and similar in `LoginScreen.kt`).
