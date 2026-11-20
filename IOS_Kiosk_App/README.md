# ServerSherpa Kiosk (iOS / iPadOS)

The native iPad and iPhone port of the web kiosk (`../kiosk/`) and the Android kiosk (`../Android_Kiosk_App/`), in SwiftUI. iPad first (all four orientations), iPhone supported. Spec: `../docs/superpowers/specs/2026-09-30-ios-kiosk-design.md`.

## Build and test

`xcode-select` may point at the Command Line Tools, so set `DEVELOPER_DIR`:

```bash
cd "IOS_Kiosk_App/ServerSherpa Kiosk"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
# unit tests (iPad Air 11-inch (M3), iOS 18.5)
xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3),OS=18.5' -derivedDataPath ../.derived -only-testing:"ServerSherpa KioskTests"
# phone build (iPhone 16, iOS 18.5)
xcodebuild build -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' -derivedDataPath ../.derived
```

Or open `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk.xcodeproj` in Xcode. The UI tests (`-only-testing:"ServerSherpa KioskUITests"`) run signed out; set `TEST_RUNNER_SCREENSHOT_DIR` to also write login, Settings, Pair and move-password screenshots. `SheetButtonsUITests` checks that sheet buttons are on screen without a scroll (the Face ID sign-in sheet, the support card, the sign-in Settings sheet) in both orientations and at large text sizes; run it on an iPad and an iPhone (for example `name=iPad Pro 13-inch (M4)` and `name=iPhone 16`).

## Run on a device

Signing team `Y2QYBG96U4`. Select the iPad (or iPhone) in Xcode and press Run.

Until an environment is saved, debug builds and the IPA builds for the Devices site (below) connect to the Dev environment (`https://api.dev.serversherpa.com`, `https://portal.dev.serversherpa.com`); other Release builds connect to Prod (`https://api.serversherpa.com`, `https://portal.serversherpa.com`). Change them under Settings › This Kiosk (reachable signed out via the gear on the login screen). For a local API the simulator can use `http://localhost:8000`.

## Building an IPA for the Devices site

Crews install the app from `devices.dev.serversherpa.com`. `tools/build_ipa.sh` archives an optimized Release build with the `DEV_API` Swift condition, which makes the app default to the Dev environment, `https://api.dev.serversherpa.com` (`App/KioskBuildConfig.swift`), so its update check asks `devices.dev.serversherpa.com`. Nothing else in the app changes.

Raise the build number first (no argument adds 1; `bump_build.sh 7` sets 7):

```bash
IOS_Kiosk_App/tools/bump_build.sh
```

Commit the bump, so the commit the script prints holds this build:

```bash
git commit -m "chore(ios): raise the kiosk build number" -- "IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk.xcodeproj/project.pbxproj"
```

Then build:

```bash
IOS_Kiosk_App/tools/build_ipa.sh
```

- The IPA lands in `IOS_Kiosk_App/.derived/ipa/ServerSherpa-Kiosk-<version>-<build>.ipa` (git-ignored). The script checks it (one app, bundle ID, build, device build, DEV_API in the compile log and the dev API URL in the binary, basic entitlements only, under the 500 MB upload limit) and prints its path, version, build, size and commit. It never uploads: upload it on the Devices site.
- The Devices site re-signs the app with its own Ad Hoc profile and the team's distribution certificate, so the development signature Xcode puts on it is fine.
- Every upload needs a higher build number than any build ever uploaded, deleted versions included. The update check compares the build only.
- A capability added to the app (an entitlement beyond the basic ones) must be turned on for the App ID `Server-Sherpas.ServerSherpa-Kiosk` in Apple's developer site first, or the re-sign fails. Even then, the first upload with it is normally refused once: the Devices site signs it with the profile it already holds, made before the change. That refusal makes the site build a new profile for the next upload, so bump the build and upload again. The script refuses an IPA with a new capability until the entitlement is added to its list.

## Scanning inputs

- **Typed / Bluetooth HID scanners:** type or scan into the focused box; Enter submits.
- **Camera:** the Camera button on Scanning, RFID Enroll, and Timeclock; Single closes on the first read, Multi reads each distinct code once until Done; flip between front and back cameras.
- **No RFID reader hardware.** RFID Enroll takes a typed or camera-read tag only; there is no Zebra sled support on iOS.

## Label printing

Asset labels are made on the device by the shared TypeScript generator (`kiosk/src/labelgen/`), run in JavaScriptCore from `ServerSherpa Kiosk/Resources/labelgen.js`. `npm --prefix kiosk run build:labelgen` rebuilds both this copy and Android's, and `npm --prefix kiosk test -- src/labelgen` checks that both are fresh. Never edit the bundle by hand.

Labels print as raw ZPL to a Zebra over the network or over Bluetooth. Both go through one transport seam, so a printer gets the same bytes either way. Unit tests use a fake printer on 127.0.0.1 and a fake Bluetooth central only. Design and rulings: `../docs/superpowers/specs/2026-10-21-android-label-printing-design.md` (iOS implementation notes) for the printing itself, and `../docs/superpowers/specs/2026-10-22-ios-bluetooth-printing-design.md` (Implementation notes) for Bluetooth.

**Network.** Raw ZPL goes to port 9100, one connection per command. Printer Setup finds printers on the iPad's Wi-Fi or Ethernet /24 (never over cellular), or takes a typed IP. iOS asks for Local Network access the first time (`NSLocalNetworkUsageDescription`). If it was denied, turn it on under Settings › ServerSherpa Kiosk › Local Network.

**Bluetooth.** Printers are reached over Bluetooth Low Energy through CoreBluetooth. There is no Zebra SDK and no MFi: the ZD421 is BLE only, and the SDK's iOS version speaks Bluetooth Classic.
- Info.plist carries `NSBluetoothAlwaysUsageDescription`. iOS asks for Bluetooth the first time someone picks Bluetooth in Printer Setup, not at launch. If it was denied, turn it on under Settings › ServerSherpa Kiosk › Bluetooth.
- Printer Setup › Bluetooth lists nearby Zebras, strongest signal first. A Zebra's Bluetooth name is its serial number (12 capital letters and digits), and that is how the list recognizes one. If the printer doesn't show up, hold FEED on it for 5 seconds and scan again. Picking one connects, checks Device Information says Zebra Technologies, identifies it with `~HI`, saves it, and runs the checks.
- iOS gives each iPad its own identifier for a printer and never shows its address. The saved printer reconnects by that identifier first, then by scanning for its serial, and confirms the serial from Device Information before using it.
- The link stays open while the app is in use. Opening Print Labels or Printer Setup connects in the background, and if the printer drops an idle link the next job reconnects first (about a second). The link closes when the app goes to the background, on sign-out, and when the saved printer changes. Nothing prints from the background.
- Writes go in chunks the size the link allows (244 bytes on an iPad Pro 13 with a ZD421), each acknowledged before the next. Expect about 4 KB a second: an asset label sends in under a second, and a 170 KB font takes about 45 seconds.
- A send that fails part-way marks the printer. The next thing sent to it (a label, a test label, a font install or a Printer Setup check) starts with `~JX`, which drops only the half label the printer may be holding, then sends its own bytes. Normal labels never carry it. Network printers get the same step. The mark lives in memory.
- A font install that is cut off (the link drops, the app goes to the background, a timeout) leaves the printer waiting for the rest of the font and treating everything after it as font data. The app stops sending to that printer and says "The font install was cut off. Turn the printer off and on, then tap Check again." The stop is saved on the iPad, so it holds across a relaunch, and the first check that gets an answer from the printer lifts it. Cancel during an install finishes the font being sent and stops before the next one.
- If the printer forgot this iPad (CoreBluetooth error 14 or 15), the app shows the steps: in the iPad's Settings app open Bluetooth, tap ⓘ next to the serial, choose Forget This Device, then come back and tap Connect. iOS can't open Settings › Bluetooth from an app, so that card has Connect only. Open Settings is offered only when Bluetooth isn't allowed for the app.

**Troubleshooting.** Settings › Troubleshooting works on the saved printer, network or Bluetooth.
- Everyone signed in sees it, so a crew can troubleshoot on site. It isn't shown signed out.
- It has the connection (type, address or serial, link state, chunk size, last drop and why), the printer's details from `~HI` (and Device Information over Bluetooth), buttons that ask the printer for status, the error report, DPI, peeler, serial and the font listing (each shows the reply and how long it took), a speed test (10, 25 or 50 KB labels that print END at the bottom, with seconds and KB/s), a Bluetooth scan with signal strength, and a Copy or Share report with a log that includes the Bluetooth link's own events.
- Admins and developers also get a box to send a command, because a raw command can change printer settings. A label or format typed there (`^XA` … `^XZ` with no `^H` or `~H` query in it) goes out the way Print Labels sends one, under the same printer rules, and the card reads "Sent as a label or format; no reply is read." Anything else is asked as a query and shows the reply.
- Developers also get the Cut-send test: it sends half a sample label, marks the failure, then sends a full label. Only the full label should print.
- With no printer saved, the tab says so and shows a **Printer Setup** button that opens Printer Setup; Back returns to the tab. The button is hidden until Kiosk Setup is done.
- The report and its log mask secrets: passwords, keys and tokens typed in the command box, sent back by the printer or in an error's words show as `[redacted]`, and the reply to a secret setting (`getvar "wlan.wpa.psk"`) is replaced whole, with its size left out. The printer's front-panel password in a `~HS` reply shows as `****`, on the tab too. Bluetooth devices that aren't Zebras appear as "Other device · -NN dBm" in the report and log; the tab still lists their names.
- The report is built in the background ("Preparing the report…" if it takes a moment). Copy says "Report copied." and stays on this device: it isn't offered to the person's other Apple devices through Universal Clipboard.

## Time Clock station

Kiosk Setup › **Time Clock** makes this device a dedicated time clock. It signs out to a Welcome screen, and crews clock in and out there by name or with the QR code from the portal's /me page.
- The station key is kept in the Keychain and bound to the API origin. Changing the API URL drops it, and you run Kiosk Setup again.
- The gear on Welcome opens sign-in.
- Signed in, Home shows Time Clock, Kiosk Setup and Settings.
- Tapping Time Clock signs out to Welcome. If the station has no key yet (the API URL changed, or the key was refused), the tile first gets one from the portal under the person signed in, and every tile waits meanwhile. If the key can't be had, the person stays signed in and a red line above the tiles says why: no connection, a move password (sign in with your own account), or the portal's error code. The line goes on the next tap or when the kiosk is set up again.
- Design and rulings: `../docs/superpowers/specs/2026-10-20-kiosk-timeclock-station-design.md` (Implementation notes, phases 2 and 3).

## Clear Setup

When an administrator presses Clear Setup for this kiosk in the portal, the next heartbeat applies it: the kiosk drops its setup (and a Time Clock station's key), and whoever is signed in lands on Kiosk Setup from any screen, with the banner "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue." A setup wizard that was open starts over at step 1. Home hides every app but Kiosk Setup, the Rolodex (admins) and Settings until setup is done again, and the banner goes when it is.

## Asset Lookup

A Home app ("Scan an asset to see what it is and where it goes."), hidden until Kiosk Setup is done. It is read-only: nothing it does records a scan.
- Search by asset tag, serial, RFID tag or name: type it, scan it with a keyboard scanner, or use the camera. One match opens its card; several show a list of up to 25 with what each matched on; none reads "No asset matches X."
- Everyone sees what the asset is and its routes (source and destination, rack and RU). Admins also see its status, its current location and its moves. People who can view scans also see its latest 50 scans.
- Offline, it searches the move this kiosk is set up for, as last synced, under "Offline — showing this move's devices only." Scan history then reads "Scan history needs a connection." With nothing synced for that move, it says "No move data on this kiosk. Sync from Kiosk Setup."

## Rolodex

- A worker's page has a **Previous jobs** card: each job the worker was added to, newest first (the latest 50), with its type, work type and site, the date they were added and the job's status. "No jobs yet." when there are none. It shows once the page has loaded.
- Tapping the worker's photo (not its camera badge) shows it full screen, scaled to fit. Close, a tap or Back dismisses it. With initials only, a tap does nothing.
- Offline, the Contact card reads "Phone and email need a connection."

## Sign-in

- **Kiosk name.** The sign-in page shows the kiosk's own name (Settings › This Kiosk) under the ServerSherpa wordmark, in every layout, so someone pairing a phone can tell which kiosk this is. VoiceOver reads it too.
- **Move password QR code.** On a device with a camera, the Move password field has a QR button. It opens the camera for QR codes only; the first code read fills the field and signs in, and a wrong one shows its error under the field.

Besides email and password, pairing with a phone and the move password, the iPad or iPhone assigned to a person can sign them in with Face ID or Touch ID. It is the Android feature on the same server routes. Design and rulings: `../docs/superpowers/specs/2026-11-09-ios-biometric-sign-in-design.md`, which builds on `../docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md`.
- **Who it's for.** Only the person assigned to the device in the portal (Scanning Hardware › Kiosks › the device › Personal device). A Time Clock station, or a device holding a station key, is shared, so it never qualifies. A device can be made someone's personal device only after it has checked in once, so the server knows its platform (iOS or Android).
- **Turning it on.** After a password sign-in on that device, a sheet offers "Face ID sign-in" (or Touch ID). Turn on shows the system prompt once. Not now stores nothing, so the next password sign-in asks again. It is never offered after a move password or a pair sign-in, on a move-locked session, or while the password must change.
- **How it works.** The device holds a P-256 key in the Secure Enclave that only Face ID or Touch ID can use. There is no passcode fallback. Turning it on sends the public key and a signature over a one-time nonce; each sign-in signs a one-time challenge. The device stores no password or token for it.
- **App Attest is off for now** (Harbor Master SS-521). It needs the paid Apple Developer Program membership, which the team doesn't have right now; SS-521 turns it back on. Until then the app sends no App Attest statement, so the server takes the key without Apple's proof that it came from this app on a real device and stores it as `unattested`. The app's one switch is `BiometricAppAttest.isEnabled` in `Data/Auth/BiometricKeys.swift`. The app has no entitlements file, so the existing development profile signs it. Turning App Attest on also means adding the entitlements file back (`com.apple.developer.devicecheck.appattest-environment = production`) and restoring `CODE_SIGN_ENTITLEMENTS` in both app build configurations, Debug and Release. The server refuses an enroll without the statement once `SS_KIOSK_IOS_REQUIRE_APP_ATTEST` is set.
- **30 days.** Biometric sign-in lasts 30 days from the last password sign-in. Biometric sign-ins don't extend it; a password sign-in does. After that the sign-in screen shows the password form with the email filled in.
- **Sign-in screen.** It opens on a "Sign in as …" card and starts the prompt once. **Use password** opens the password form with the person's email filled in. **Other account** opens the empty password form, with Pair with phone and Use a move password. While the card loads, "Checking…" shows for at most 3 seconds. Right after Sign out, Face ID (or Touch ID) does not start on its own, because Face ID only needs a look at the screen and would sign the person straight back in. Tap the card to sign in. Opening the app, a session that ended, or a failed restore still starts the prompt on its own.
- **When it turns off.** A face or finger is added, Face ID is reset, or the passcode is removed: iOS invalidates the key, and the app drops it. The password is changed or reset, the account is disabled, or the device is reassigned (or made non-personal). After a key is dropped, the next password sign-in offers it again. Sign out, Reset app and Kiosk Setup keep it.
- **Platform changes.** If a personal device ever checks in as a different platform (iOS instead of Android, or the other way around), its assignment and key are cleared. Only its owner's check-in can do that; anyone else's check-in leaves the platform as it was.
- **Forget.** In Settings › This Kiosk (signed out, the device forgets it and the portal's copy is useless without it), on /me, or on the user page. The device's page in the portal can forget it too.

**Device only.** The Simulator always reports that it can't use biometric sign-in, so it shows the plain password form and never offers Turn on. To check the Turn on sheet's layout there, Debug builds take `-uiTestEnrollOffer`: the real sheet with sample words (Face ID, iPad), which asks nothing (its Turn on only shows the "didn't work" line). The Secure Enclave key, the Face ID or Touch ID prompt, and a key dying when a face or finger is added need a real iPad or iPhone.

**Tests.** `BiometricSignInTests`, `BiometricLoginTests` and `EnrollOfferTests` use a software P-256 key (`FakeBiometricKeys`) and a fake prompt (`FakeBiometricPrompter`) only.

## App updates

The app asks the Devices site (`devices.<env>`, worked out from the API URL: `https://api.dev.serversherpa.com` → `https://devices.dev.serversherpa.com`) whether a newer build is out. Design: `../docs/superpowers/specs/2026-11-18-ios-update-check-design.md`.
- **When it checks.** Settings › This Kiosk › App updates says it in one line: "Updates come from the Devices site. The kiosk checks after sign-in and when the app is reopened, at most every 6 hours." Only while signed in: right after sign-in, on return to the foreground once the last answer is 6 hours old (a failed check doesn't count, so the next foreground tries again), and whenever someone taps **Check for updates** in Settings › This Kiosk › App updates. Signed out, the button is off and the row says "Sign in to check for updates." An API URL that doesn't start with `api.` (localhost, an IP) has no Devices site, so no request is sent and the row says why.
- **What it shows.** A build this iPhone can install puts a card on Home ("Update available — 1.2.0") with **Update** and **Later**. Update never opens a kept link: the install link expires 30 minutes after the answer that carried it, so the tap checks again (the button is off meanwhile) and opens only the new answer's `itms-services://` link (no other kind of link is ever opened); if that answer says up to date or not ready, nothing opens and the card goes, and if it fails the card says why. **Later** hides the card until the next launch or another version or build (a new link for the same build stays hidden). Settings › This Kiosk › App updates shows the answer, "Installed: 1.0 (1)" (this install's version and build), the release notes and download size, Update (the same fresh check), Check for updates and "Last checked HH:mm" (24-hour). A check that fails says why there, keeps the last offer's notes, size and Update below it, and never signs the kiosk out; a Devices 401/403 reads "The Devices site couldn't confirm this sign-in. Try again later."
- **Profile kinds.** The app reads its own `embedded.mobileprovision`. Only an **Ad Hoc** install (from devices.<env>) gets an Update button. A **development** install (from Xcode) or one with **no** profile (TestFlight, App Store, or a profile that can't be read) is told "Add this iPhone on devices.<env> first." instead ("Add this iPad …" on an iPad).
- **Simulator and UI tests.** No Devices site is reachable from the Simulator. Debug builds take `-uiTestUpdate <available|register_first|preparing|up_to_date>`: the check answers a sample (1.2.0, build 7, with notes and a size) at once, and `available` treats the install as Ad Hoc so Update shows. Tapping Update in the Simulator shows an install prompt or a "cannot open" alert; a real install needs a registered iPhone. `UpdateBannerUITests` checks the signed-out Settings row.

## Kiosk lock-down

iOS has no app pinning API for an ordinary app. Use Guided Access (Settings › Accessibility › Guided Access; triple-click the side button to start) or, on managed devices, MDM single-app mode. The app keeps the screen awake while signed in.

## Layout

`Core/` is pure Swift (Foundation only) mirroring Android `core/`; `Data/` is URLSession, Keychain, SwiftData and UserDefaults, sync, and outbox; `Input/` is the scan sources; `UI/` is SwiftUI. The Xcode project uses synchronized folders: new files under the app or test folders join the target automatically.

Never hide buttons behind a scroll: a sheet's, cover's or card's action buttons must be on screen when it opens, on every device, orientation and text size. Put them in `PinnedActions` (`UI/Components/PinnedActions.swift`), never at the end of a `ScrollView`: only the content scrolls, and the buttons stay pinned below it.

## Icons and fonts

`python3 IOS_Kiosk_App/tools/make_icons.py` regenerates the app icon from `portal/public/images/serversherpa-logo.png`. Fonts are bundled under the OFL (see `Android_Kiosk_App/FONTS-LICENSE.md`).
