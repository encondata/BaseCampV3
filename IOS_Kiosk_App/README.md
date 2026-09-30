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

## Kiosk lock-down

iOS has no app pinning API for an ordinary app. Use Guided Access (Settings › Accessibility › Guided Access; triple-click the side button to start) or, on managed devices, MDM single-app mode. The app keeps the screen awake while signed in.

## Layout

`Core/` is pure Swift (Foundation only) mirroring Android `core/`; `Data/` is URLSession, Keychain, SwiftData and UserDefaults, sync, and outbox; `Input/` is the scan sources; `UI/` is SwiftUI. The Xcode project uses synchronized folders: new files under the app or test folders join the target automatically.

## Icons and fonts

`python3 IOS_Kiosk_App/tools/make_icons.py` regenerates the app icon from `portal/public/images/serversherpa-logo.png`. Fonts are bundled under the OFL (see `Android_Kiosk_App/FONTS-LICENSE.md`).
