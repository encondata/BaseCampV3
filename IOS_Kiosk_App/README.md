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

Or open `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk.xcodeproj` in Xcode. The UI tests (`-only-testing:"ServerSherpa KioskUITests"`) run signed out; set `TEST_RUNNER_SCREENSHOT_DIR` to also write login, Settings, Pair and move-password screenshots.

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

## Kiosk lock-down

iOS has no app pinning API for an ordinary app. Use Guided Access (Settings › Accessibility › Guided Access; triple-click the side button to start) or, on managed devices, MDM single-app mode. The app keeps the screen awake while signed in.

## Layout

`Core/` is pure Swift (Foundation only) mirroring Android `core/`; `Data/` is URLSession, Keychain, SwiftData and UserDefaults, sync, and outbox; `Input/` is the scan sources; `UI/` is SwiftUI. The Xcode project uses synchronized folders: new files under the app or test folders join the target automatically.

## Icons and fonts

`python3 IOS_Kiosk_App/tools/make_icons.py` regenerates the app icon from `portal/public/images/serversherpa-logo.png`. Fonts are bundled under the OFL (see `Android_Kiosk_App/FONTS-LICENSE.md`).
