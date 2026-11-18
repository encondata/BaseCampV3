# Settings parity: Android vs iOS kiosk

Scope: Settings and every tab in it. Android `ui/screens/settings/*`, `core/settings/*`, `nettest/*` compared with iOS `UI/Screens/Settings/*`, `Core/Settings/*`.
Paths are shortened below:
- `A/` = `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/`
- `I/` = `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`

Excluded as the request asks (Zebra RFD40 sled, handheld readers, DataWedge, Zebra SDKs, MC2200 layout, Zebra hardware keys). These are listed at the end so it's clear they were left out on purpose.

## Tab map

| Tab | Android | iOS | Verdict |
|---|---|---|---|
| Appearance | `A/ui/screens/settings/AppearancePanel.kt` | `I/UI/Screens/Settings/AppearancePanel.swift` | Same: three HSL flash pickers with Preview flash, and a 100–2000 ms flash duration in 50 ms steps |
| Sound | `SoundPanel.kt` | `SoundPanel.swift` | Same: None/Chime/Beep/Double beep/Buzz/Bonk for good, not-found and duplicate scans, a Play button for each, and Volume |
| Devices | `DevicesPanel.kt` | `DevicesPanel.swift` + `DeviceCapabilities.swift` | Android-only rows are all excluded (DataWedge, RFID reader). The Camera and Hardware keyboard rows match. iOS has more (see "iOS has, Android lacks") |
| Troubleshooting | `TroubleshootingPanel.kt` + `TroubleshootingModel.kt` (1705 lines) | `TroubleshootingPanel.swift` + `TroubleshootingModel.swift` (770 lines) | Same sections. Android has several report-hygiene and command-box rules iOS lacks (gaps 2–7) |
| RFID | `RfidPanel.kt` | none | Excluded: the whole tab is the RFD40 sled |
| This Kiosk | `ThisKioskPanel.kt` | `ThisKioskPanel.swift` + `BiometricRow.swift` | Same rows. iOS is stricter on saving the API URL and adds Copy serial and Device model |
| Admin | `AdminPanel.kt` | `AdminPanel.swift` | The RFID Enroll checkpoint matches. Android's RFID region row is excluded (sled) |
| Developer | `DeveloperPanel.kt` | `DeveloperPanel.swift` | Developer mode, Kiosk setup state, Local data (Clear local data and Reset app) and the local-data inspector match. Internet Test is a gap (gap 1). The other three Android rows are excluded (sled) |

Tab gating matches on both (`A/core/settings/SettingsTabs.kt` and `I/Core/Settings/SettingsTabs.swift`): signed out shows only This Kiosk, Admin needs the admin role, Developer needs the developer role, and Appearance is the default tab.

## Gaps (Android has it, iOS doesn't), in scope

### 1. Internet Test (network link conditioner), Settings › Developer
- **What it does on Android:** It shows only with Developer mode on and the developer role. A switch slows the app's own traffic only. It turns itself off after 2 hours, at sign-out, or when setup is cleared, and shows "Turns off at HH:MM". Two dials, Internet (portal API) and Local network (printer sockets), each have Apple's Network Link Conditioner presets (Off, Wi-Fi, Wi-Fi 802.11ac, LTE, DSL, 3G, Edge, Very Bad Network, High Latency DNS, 100% Loss, Custom). Custom gives six boxes: speed, delay and drop for download and upload. While it is on, an amber "Net test" chip shows in the top bar and in the Time Clock header, and there is a "Net test" footer item. Tapping either opens Settings › Developer. Conditioning applies only while someone is signed in. Sign-in, session restore and pairing always go direct.
- **Android files:**
  - The whole `A/nettest/` folder: `InternetTest.kt`, `InternetTestSection.kt`, `InternetTestSettings.kt`, `InternetTestIndicators.kt`, `InternetTestRoutes.kt`, `LinkShaper.kt`, `LinkProfile.kt`, `LocalShaping.kt`, `PortalShaping.kt`, `Presets.kt`, `REMOVAL.md`. About 1,800 lines.
  - 25 lines marked `// INTERNET-TEST` in `AppContainer.kt`, `data/api/OkHttpKioskApi.kt`, `data/auth/MoveSetupGuard.kt`, `data/printer/NetworkZebra.kt`, `ui/shell/KioskShell.kt`, `ui/screens/settings/DeveloperPanel.kt`, `ui/screens/timeclock/TimeclockScreen.kt`, `ui/screens/timeclock/screens/TcShell.kt` and `ui/screens/timeclock/screens/ConfirmPerson.kt`.
  - Design: `docs/superpowers/specs/2026-10-21-android-internet-test-design.md`.
- **iOS counterpart:** none.
- **Server routes:** none (client only).
- **Hardware/SDK dependency:** none. It does not condition Bluetooth or the sled.
- **Size:** L. On iOS it needs a custom `URLProtocol` or URLSession delegate shaping for the API, a shaped wrapper around the port-9100 `NWConnection`/stream sockets, the controller with its expiry and turn-off rules, the dials UI, and the chip in the top bar and the Time Clock header.
- **Note:** the Android design explicitly left iOS out of scope (§ non-goals). iOS already has Apple's own system-wide Network Link Conditioner (Settings › Developer on a device in Developer Mode), so ask the user whether iOS needs this in the app at all. On Android, one of its turn-off rules depends on remote Clear Setup, which iOS also lacks (see the cross-area note).

### 2. Secret redaction in the Troubleshooting report
- **What it does on Android:** Copy and Share mask secret-looking values on every report and log line: bearer tokens, JWTs, values of names containing password, psk, token, secret, cookie, apikey, station key, session id, wep key, pin and so on (quoted, unquoted and JSON/SGD forms), and URL passwords. If masking a line fails, the whole line becomes "[redacted: this line couldn't be checked for secrets]".
  - The reply to `getvar "<secret setting>"` becomes "[redacted: the reply to a secret setting]".
  - Logged failures carry only the exception's kind, never its message (`describe()`).
  - `troubleText()` never shows a stray exception's message.
- **Android files:** `A/ui/screens/settings/TroubleshootingModel.kt`: `redactSecrets`, `maskSecrets` and helpers (about lines 1060–1690), `asksForASecret`, `describe`, `troubleText`. Commits 44b1e5c7a, ebc71903a, cc0a057c7, 029cecd4f.
- **iOS counterpart:** `I/UI/Screens/Settings/TroubleshootingModel.swift` `report()` writes commands, replies and log lines as they are. iOS `troubleText()` falls back to `errorDescription` or `String(describing: error)`.
- **Server routes:** none.
- **Hardware/SDK dependency:** none.
- **Size:** M. The masker is linear-time with a lot of edge cases. Port it together with `TroubleshootingModelTest`'s redaction cases.

### 3. ~HS front-panel password hidden
- **What it does on Android:** a reply to any command containing `~HS` has the printer's 4-digit front-panel password shown as `****`, both on the ask card on screen and in the report.
- **Android files:** `TroubleshootingModel.kt` `withoutPanelPassword` and `PANEL_PASSWORD`. `TroubleshootingPanel.kt` `AskResultCard` uses it.
- **iOS counterpart:** `TroubleshootingPanel.swift` `AskResultCard` shows `visibleBytes(result.reply)` unmasked, and the report does the same.
- **Server routes:** none.
- **Hardware/SDK dependency:** none.
- **Size:** S.

### 4. Non-Zebra Bluetooth names kept out of the report and log
- **What it does on Android:** in the report and log, a scanned device that isn't a Zebra appears as "Other device · -52 dBm" (its name is often a person's, like "Jimmy's AirPods"). The report adds the line "Devices that aren't Zebras are listed by signal only." The on-screen list still shows names.
- **Android files:** `TroubleshootingModel.kt` `scanLine()` and `report()`.
- **iOS counterpart:** `TroubleshootingModel.swift` `scanLine()` logs every device's name.
- **Server routes:** none.
- **Hardware/SDK dependency:** none.
- **Size:** S.

### 5. Command box sends a `^XA` format as a label
- **What it does on Android:** for admins and developers, text typed in the command box that starts with `^XA` and holds no `^H…` or `~H…` host query goes out on the send path, like a label. A cut font refuses it, and one cut off part-way marks the printer for `~JX`. The result reads "Sent as a label or format; no reply is read." Everything else is still a query that is read until the printer goes quiet.
- **Android files:** `TroubleshootingModel.kt` `sendCommand`, `sendFormat`, `sendsAsFormat`, `hasHostCommand`, `FORMAT_SENT_TEXT`. Commit fbd9851b6.
- **iOS counterpart:** `TroubleshootingModel.swift` `sendCommand()` always runs `runQuery`, so a format goes out as a query, outside the guard's send rules.
- **Server routes:** none.
- **Hardware/SDK dependency:** none.
- **Size:** S.

### 6. "Printer Setup" button in Troubleshooting
- **What it does on Android:** with no printer saved, the Connection section shows the note plus a Printer Setup button. When the saved Bluetooth printer answered at another address, it shows an amber note plus a Printer Setup button. Both go to `Routes.LABELS_PRINTER`.
- **Android files:** `TroubleshootingPanel.kt` `ConnectionSection` (`openPrinterSetup`), `SettingsScreen.kt`.
- **iOS counterpart:** only the text "Choose one in Label Printing › Printer Setup." iOS has the screen (`I/UI/Screens/Labels/PrinterSetupScreen.swift`, route `.labelsPrinter` in `I/UI/RootView.swift`), but Settings can't push it today because Settings has no path binding. Settings is also shown as a sheet from the login gear.
- **Server routes:** none.
- **Hardware/SDK dependency:** none.
- **Size:** S.
- **Note:** the "found elsewhere" half differs by design. Android never saves an address found by scanning (to stop look-alike devices), so it shows "Found at B (saved A)". iOS adopts the new peripheral identifier automatically (`adoptingLinkedIdentifier` in `I/Data/Printer/ZebraBluetooth.swift`). Bring only the no-printer button across unless the user wants Android's look-alike rule on iOS, which is a printer-area change.

### 7. Report build: off the main thread, failure message, size cap
- **What it does on Android:**
  - The report is built off the main thread.
  - "Preparing the report…" shows if it takes more than 400 ms.
  - A build that fails says "Couldn't build the report. Try again." instead of crashing.
  - Copy and Share are capped at 100,000 characters, dropping the oldest log lines first and saying how many went.
  - "Report copied." shows as a toast.
- **Android files:** `TroubleshootingPanel.kt` `ReportSection`, `TroubleshootingModel.kt` `shareableReport`, `fit`, `SHARE_MAX_CHARS`, `REPORT_FAILED_TEXT`.
- **iOS counterpart:** Copy builds the report synchronously on the main actor (the button reads "Copied" for 2 s). Share writes a `.txt` file through `ShareLink`. There is no cap and no failure message.
- **Server routes:** none.
- **Hardware/SDK dependency:** none.
- **Size:** S.
- **Note:** the cap exists on Android because of a binder-transaction limit. iOS shares a file, so the cap matters less there. The off-main build with "Preparing…" is the part users would notice, with up to 5,000 log lines and pasted labels.

### 8. Bluetooth scan runs again once Bluetooth is ready
- **What it does on Android:**
  - A scan refused because Bluetooth was off or not allowed starts again by itself when Bluetooth becomes ready, or when the app comes back from Settings with the permission granted.
  - A scan Android ended early says "The scan stopped early. Scan again."
  - The Connection lines show "On (Location is off, so scans can't find printers)".
- **Android files:** `TroubleshootingModel.kt` `scan(permitted)`, `appResumed`, `bluetoothReady`, `rescanWhenReady`, `SCAN_ENDED_EARLY_TEXT`. `TroubleshootingPanel.kt` has the lifecycle observer and the permission launcher.
- **iOS counterpart:** `TroubleshootingModel.swift` `scan()` shows the refusal (with Open Settings when it was denied), and the user must tap Scan again. The `.refused` and `.replaced` scan ends say nothing.
- **Server routes:** none.
- **Hardware/SDK dependency:** none. The Location and permission-prompt parts are Android platform behavior with no iOS equivalent.
- **Size:** S. Only the "start again once Bluetooth is ready" part applies to iOS.

## Same on both (checked, no work)
- **This Kiosk:**
  - Kiosk name (1–80 characters, Save name, and a heartbeat when signed in).
  - Serial.
  - Mode ("Android" / "iOS").
  - Biometric sign-in row (Off / On for another person / On · Forget this device, which works signed out). Android `FingerprintRow` in `ThisKioskPanel.kt` matches iOS `BiometricRow.swift`.
  - API URL and Portal URL with Save URLs.
  - Version.
  - Typing counts as activity on a Time Clock station.
- **Admin:** the RFID Enroll checkpoint segmented control loaded from `GET /kiosk/setup-options` (scan types), with the same fallback message and default `pre_stage`.
- **Developer:**
  - Developer mode switch.
  - Kiosk setup state (Incomplete / Complete / Failed).
  - Local data line.
  - Clear local data.
  - Reset app, with its confirm. It clears setup, the station key, label settings, the label builder, the Rolodex and local data, and keeps unsent scans and the sign-in.
  - Local-data inspector: a filter and up to 200 assets and 200 people.
- **Troubleshooting core:**
  - Connection lines.
  - `~HI` details and Bluetooth Device Information.
  - Ask buttons (status, error report, DPI, peeler, serial, fonts).
  - The command box for admins and developers.
  - Speed test (10/25/50 KB × 1/3/5 labels, confirm above 1, Stop, KB/s table, average).
  - Cut-send test for developers.
  - Bluetooth scan list with Saved printer and Zebra chips.
  - Copy/Share report with the 5,000-line log merged with the Bluetooth link events.
- Server routes used by Settings already exist and are used by both apps: `/kiosk/heartbeat`, `/kiosk/setup-options`, `/kiosk/biometric/*`.

## iOS has, Android lacks (keep these)
- Devices: a "Camera used for scanning" Back/Front choice when there are two cameras (`DevicesPanel.swift`, `prefs.cameraPosition`).
- Devices: a Torch row, and camera text that says which cameras exist (back, front or both).
- This Kiosk: a Copy button for the serial, and a "Device model" row (the hardware identifier).
- This Kiosk: saving a new API origin while signed in signs the kiosk out, so the token never goes to the new host, and says so in the hint (`SettingsModel.saveUrls`). Android keeps the session and only says "Sign in again if the API changed" (`ThisKioskPanel.kt`, `AppContainer.saveApiUrl`). This looks like an Android gap worth closing.
- Developer: Clear local data asks for confirmation first (Android clears at once).
- Settings: signed out (one tab), the tab strip is hidden, and as the login-gear sheet it has a Done button.
- Troubleshooting Share sends a named `.txt` file (`printer-report-<stamp>.txt`) rather than plain text.

## Cross-area note (not Settings, listed so it isn't lost)
- **Remote Clear Setup through the heartbeat.**
  - Android sends `setup_cleared` (the ack) and reads `clear_setup` from `/kiosk/heartbeat`, clears setup, and redirects to Kiosk Setup.
  - Android files: `A/data/heartbeat/Heartbeat.kt`, `A/data/prefs/KioskPrefs.kt` (`applySetupClear`, `settleSetupClearAck`, `pendingSetupClearAck`), `A/ui/KioskApp.kt` (SetupClearedRedirect), `A/AppContainer.kt`.
  - iOS `HeartbeatIn` and `HeartbeatResult` (`I/Core/Model/Kiosk.swift`) have neither field, so the portal's Clear Setup does nothing on an iPad.
  - The server side already exists (`api/src/serversherpa/api/routes/kiosk.py` around lines 484–550, `schemas.py`).
  - Size M. It belongs to the Setup/Heartbeat area.

## Excluded on purpose (sled, DataWedge, Zebra SDK)
- The whole Settings › RFID tab (`RfidPanel.kt`): reader switch, Connect/Stop, sled flashes, sled triggers, trigger mode, repeat sweeps, beeper, transmit power, session, tag population, unique, DPO, region line.
- Admin: the RFID region and frequency hopping rows (`AdminPanel.kt`).
- Devices: the Zebra DataWedge and RFID reader rows (`DevicesPanel.kt`).
- Developer: "Simulate an RFID connection" (FakeRfidReader), "Zebra SDK logging", "Offer Both in Sled triggers to everyone" (`DeveloperPanel.kt`).
- `SettingsScreen.kt` writes `container.settingsTab` only for the sled-screen signal.
