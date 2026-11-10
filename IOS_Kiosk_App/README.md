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

Debug builds default to `https://api.dev.serversherpa.com`; Release builds default to `https://api.serversherpa.com`; the portal URL is `https://portal.dev.serversherpa.com`. Change them under Settings › This Kiosk (reachable signed out via the gear on the login screen). For a local API the simulator can use `http://localhost:8000`.

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
- Admins and developers also get a box to send a command, because a raw command can change printer settings.
- Developers also get the Cut-send test: it sends half a sample label, marks the failure, then sends a full label. Only the full label should print.

## Time Clock station

Kiosk Setup › **Time Clock** makes this device a dedicated time clock. It signs out to a Welcome screen, and crews clock in and out there by name or with the QR code from the portal's /me page.
- The station key is kept in the Keychain and bound to the API origin. Changing the API URL drops it, and you run Kiosk Setup again.
- The gear on Welcome opens sign-in.
- Signed in, Home shows Time Clock, Kiosk Setup and Settings.
- Design and rulings: `../docs/superpowers/specs/2026-10-20-kiosk-timeclock-station-design.md` (Implementation notes, phases 2 and 3).

## Sign-in

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

## Kiosk lock-down

iOS has no app pinning API for an ordinary app. Use Guided Access (Settings › Accessibility › Guided Access; triple-click the side button to start) or, on managed devices, MDM single-app mode. The app keeps the screen awake while signed in.

## Layout

`Core/` is pure Swift (Foundation only) mirroring Android `core/`; `Data/` is URLSession, Keychain, SwiftData and UserDefaults, sync, and outbox; `Input/` is the scan sources; `UI/` is SwiftUI. The Xcode project uses synchronized folders: new files under the app or test folders join the target automatically.

Never hide buttons behind a scroll: a sheet's, cover's or card's action buttons must be on screen when it opens, on every device, orientation and text size. Put them in `PinnedActions` (`UI/Components/PinnedActions.swift`), never at the end of a `ScrollView`: only the content scrolls, and the buttons stay pinned below it.

## Icons and fonts

`python3 IOS_Kiosk_App/tools/make_icons.py` regenerates the app icon from `portal/public/images/serversherpa-logo.png`. Fonts are bundled under the OFL (see `Android_Kiosk_App/FONTS-LICENSE.md`).
