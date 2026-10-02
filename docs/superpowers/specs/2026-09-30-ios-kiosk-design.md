# iOS kiosk app: framework, setup, scanning, RFID enroll, timeclock

The iOS kiosk is the Android kiosk (`Android_Kiosk_App/`, spec `2026-09-15-android-kiosk-design.md`) rewritten as a native Swift/SwiftUI app for iPad first and iPhone second. It ports the same scope — sign-in, session, heartbeat, shell, launcher, settings, Kiosk Setup with local sync, Scanning with its offline outbox, RFID Enroll, Timeclock — and adds the move-password sign-in the web kiosk has and Android lacks. Every piece of Zebra code (DataWedge, the RFD40 sled, the reader settings) is left out. Where this spec says "as Android", the Android source file named is the reference for behavior, copy and constants, and its unit tests are ported with it.

**Date:** 2026-09-30 · **Status:** approved (Jimmy, 2026-09-30: sections 1–3 approved, "go all the way to building the app") · **Branch:** `ios-kiosk` (worktree `.claude/worktrees/ios-kiosk` off `main` at 4f53b304)

## Decisions already made

| Question | Decision |
|---|---|
| Scope | Android parity: framework, Login (email + password, pair with phone, **move password**), Home, Kiosk Setup + sync, Scanning + outbox, RFID Enroll (typed or scanned tag, with Android's enroll gates), Timeclock, Settings. Containers, Trucks, Labels are placeholder tiles. |
| Left out | All Zebra code: DataWedge, RFD40 / `RfidController` / `RfidReadPanel`, the Settings › RFID tab, the Admin tab's region setting. No NFC. |
| Targets | iPad first (portrait and landscape), iPhone supported (portrait and landscape). |
| Minimum OS | iOS / iPadOS **18.0** (iPad 7th gen and newer, iPhone XS/XR and newer). |
| Stack | Swift + SwiftUI, Observation (`@Observable`), `NavigationStack`, SwiftData, URLSession + Codable, Keychain (Security framework), AVFoundation (camera), Core Image (QR), AVAudioEngine (sounds). **No third-party packages.** |
| Architecture | Native port, layer by layer, of the Android app. `Core/` is pure Swift (Foundation only) and mirrors Android `core/`. Nothing is shared at build time with Android or the web kiosk. |
| Project | Keep the Xcode 26 project Jimmy created: `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk.xcodeproj`, targets `ServerSherpa Kiosk`, `ServerSherpa KioskTests` (Swift Testing), `ServerSherpa KioskUITests`; bundle id `Server-Sherpas.ServerSherpa-Kiosk`, team `Y2QYBG96U4`, display name "ServerSherpa Kiosk". Synchronized folders (objectVersion 77), so new files need no `project.pbxproj` edits. |
| Git | The project's nested `.git` (one template commit) is deleted and `IOS_Kiosk_App/` is committed in this repo on `ios-kiosk`. `xcuserdata/` is git-ignored. |
| Session model | As Android: `ss_refresh` cookie persisted by the app (Keychain), access token in memory only, login tagged `client: "kiosk"`. |
| Registration | Self-registers as a `Device` by serial through `POST /kiosk/heartbeat`, `mode: "ios"` (already in the API's `HeartbeatIn.mode` Literal). |
| API base URL | Editable on Settings › This Kiosk (reachable signed out), persisted. Default `https://api.dev.serversherpa.com` in Debug, `https://api.serversherpa.com` in Release; portal URL default `https://portal.dev.serversherpa.com` in both, as Android's `BuildConfig`. |
| Server changes | None. Every endpoint exists on `main`. |

## Project shape

### Build settings (changes to the template)

- `IPHONEOS_DEPLOYMENT_TARGET = 18.0` (all three targets).
- `SWIFT_VERSION = 5.0` stays (Swift 5 language mode; Swift 6 strict checking is not adopted in this pass).
- `SWIFT_DEFAULT_ACTOR_ISOLATION` changes from `MainActor` to `nonisolated` on the app and unit-test targets, so `Core/` value types and the data layer's actors are not implicitly main-actor. Views are main-actor through SwiftUI; view models and `@Observable` app state are marked `@MainActor` explicitly.
- Info.plist keys (generated): `NSCameraUsageDescription` = "The camera reads barcodes and QR codes when you tap the camera button.", `NSAppTransportSecurity › NSAllowsArbitraryLoads = YES` (a LAN dev API over plain HTTP, the Android `usesCleartextTraffic` equivalent), `UIApplicationSupportsIndirectInputEvents` (template), all four iPad orientations and portrait + landscape on iPhone (template), `UIRequiresFullScreen = NO` (split view allowed).
- Build-time config: `KioskBuildConfig.swift` with `#if DEBUG` defaults for the API and portal URLs; `kioskVersion` from `CFBundleShortVersionString` (`MARKETING_VERSION`, 1.0).
- Template files removed: `Item.swift`, `ContentView.swift`'s SwiftData sample, the UI-test `testLaunchPerformance` (a 35 s performance run on every test pass).

### Source layout (`IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`)

```
App/
  ServerSherpa_KioskApp.swift  @main; builds AppContainer, injects it, scenePhase hooks
  AppContainer.swift           manual wiring: config, identity, api, session, auth, db, stores, scan bus, sound, flash
  KioskBuildConfig.swift       default URLs, version
Core/                          FOUNDATION ONLY — enforced by CorePurityTests
  Model/                       Session, Person, Preferences, SetupOptions, KioskSetupSelection, rows, ScanEvent,
                               OutboxRow, RegistrationState, SystemStatus, Timeclock (Codable, snake_case keys)
  ApiError.swift
  Access.swift                 can(resource, action) from perms (Android core/access/Access.kt)
  Features.swift               FEATURES registry + featureAvailable (core/features/Features.kt)
  SetupState.swift             (core/setup/SetupState.kt)
  Registration.swift           (core/devices/Registration.kt)
  Scan/ScanMatch.swift         (core/scan/ScanMatch.kt)
  Scan/Rfid.swift              (core/scan/Rfid.kt)
  Scan/EnrollGate.swift        (core/scan/EnrollGate.kt)
  People/PeopleMatch.swift     (core/people/PeopleMatch.kt)
  Outbox/OutboxMachine.swift   (core/outbox/OutboxMachine.kt)
  Settings/                    Appearance, SoundSettings, Checkpoints, SettingsTabs (core/settings/*) — minus RFID tab
Data/
  Config/KioskConfig.swift     apiUrl / portalUrl from UserDefaults (ss.kiosk.apiUrl / ss.kiosk.portalUrl) + defaults
  Identity/Identity.swift      serial (Keychain) + name (UserDefaults)
  Api/KioskApi.swift           protocol: every endpoint (Android data/api/KioskApi.kt + moveLogin)
  Api/URLSessionKioskApi.swift implementation; authed() = refresh → bearer → 401 refresh+retry once
  Api/SessionStore.swift       actor: token + expiries in memory, single-flight refresh
  Api/SecretStore.swift        protocol; KeychainSecretStore + MemorySecretStore (tests)
  Api/RefreshCookie.swift      Set-Cookie parsing for ss_refresh; storage keyed by host
  Api/KioskJSON.swift          shared JSONEncoder/Decoder (snake_case via explicit CodingKeys, ISO dates as String)
  Auth/KioskAuth.swift         @MainActor @Observable: state, login, moveLogin, completePair, logout, can, isAdmin, isDeveloper
  Auth/SessionCoordinator.swift reacts to sessionEnded (Android data/auth/SessionCoordinator.kt)
  Heartbeat/Heartbeat.swift    60 s loop while active + signed in
  Db/Records.swift             SwiftData @Model classes
  Db/KioskStore.swift          @ModelActor: every read/write (sync replace, outbox, roster reads, clear)
  Sync/Sync.swift              @MainActor @Observable SyncStatus + runSync
  Outbox/Outbox.swift          sender around OutboxMachine (Android data/outbox/Outbox.kt)
  Prefs/KioskPrefs.swift       UserDefaults stores with the web's ss.kiosk.* keys
  Status/SystemStatus.swift    GET /system/status for the login banners
Input/
  ScanBus.swift                broadcast of ScanEvent to the one active listener
  Camera/CameraScanner.swift   AVCaptureSession + AVCaptureMetadataOutput wrapper
  Camera/CameraScanSheet.swift full-screen sheet: Single/Multi, torch, front/back flip
  Camera/MultiReadSession.swift (input/camera/MultiReadSession.kt)
UI/
  Theme/                       Tokens (portal colors), LoginTokens (lx-*), Fonts (Geologica, Fragment Mono), KioskTheme
  RootView.swift               NavigationStack + guards
  Shell/KioskShell.swift       top bar + content + footer + ScanFlash overlay
  Guards/                      KioskGuard, SetupGate
  Components/                  ScanInput, SetupCard, KioskChip, Segmented, SettingsRow, HslPicker, Toast, PageHeader, Buttons, KioskIcons
  Flash/                       FlashController + ScanFlash overlay
  Sound/SoundPlayer.swift      AVAudioEngine synth of the five built-ins
  Screens/Login/               LoginScreen, LoginScene (the mockup art), LoginForm, PairPanel, MovePasswordForm, SupportCard, LoginViewModel
  Screens/Home/                HomeScreen, FeatureIcons
  Screens/Setup/               KioskSetupScreen + ViewModel
  Screens/Scan/                ScanScreen + ViewModel, ScanTable (iPad), ScanRows (iPhone)
  Screens/Enroll/              EnrollScreen + ViewModel
  Screens/Timeclock/           TimeclockScreen + ViewModel
  Screens/Settings/            SettingsScreen + Appearance, Sound, Devices, ThisKiosk, Admin, Developer panels
  Screens/Placeholder/         FeaturePlaceholderScreen
Resources/
  Fonts/                       geologica.ttf, fragment_mono.ttf, fragment_mono_italic.ttf (copied from Android res/font, OFL)
  Assets.xcassets              AppIcon, Logo (serversherpa-logo.png), LoginMountains (PNG from login-mountains-light.webp)
```

`CorePurityTests` reads every `.swift` file under `Core/` (path resolved from `#filePath`) and fails on any `import` other than `Foundation`.

### App icon and images

`IOS_Kiosk_App/tools/make_icons.py` (Pillow) writes the single 1024×1024 `AppIcon` (iOS 18 single-size icon): `portal/public/images/serversherpa-logo.png` centered at 80 % on paper `#f1f4f7`, no alpha (App Store rule). It also converts `portal/public/images/login-mountains-light.webp` to `LoginMountains.png` and copies the logo into `Logo.imageset`. Re-running the script is the only way these assets change.

### Theme

`UI/Theme/Tokens.swift` restates Android `ui/theme/Tokens.kt` (the portal tokens, the six accents, light and dark paper sets). The accent follows the person's `preferences.accent`, the color scheme follows `preferences.theme` (`system` follows iOS). `LoginTokens` holds the login-light set: ink `#0F172A`, orange `#FF6A00`, canvas `#FFF9F2`, slate `#64748B`, line `#CBD5E1`, field `#F8FAFC`, ok `#22C55E`. Fonts are registered from the bundle with `CTFontManagerRegisterFontsForURL` at launch (not `UIAppFonts`, so a missing file cannot crash launch); Geologica is a variable font and weights are chosen with `Font.custom(...).weight(...)`. If registration fails the theme falls back to the system sans and monospaced fonts.

## Runtime pieces

### Config and identity

- `KioskConfig`: `apiUrl` / `portalUrl` from UserDefaults `ss.kiosk.apiUrl` / `ss.kiosk.portalUrl`, trailing slashes trimmed, defaults from `KioskBuildConfig`. Setting a URL accepts only `http://` or `https://` with a host. The API client reads the URL per request.
- `Identity`: `serial` stored in the Keychain (`kiosk.serial`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), generated once as `kiosk-ios-<uuid lowercased>` — the Keychain survives an app reinstall so the portal keeps one Device row per iPad. `name` in UserDefaults `ss.kiosk.name`, default `Kiosk <last 4 of serial, uppercased>`, trimmed, 1–80 chars.

### Transport (`Data/Api`)

- `KioskApi` (protocol) mirrors Android `KioskApi.kt` function for function, plus `moveLogin(password:) -> SessionData` (`POST /kiosk/move-login {password}`, unauthenticated).
- `URLSessionKioskApi` uses one `URLSession` built from `.ephemeral` with `httpCookieStorage = nil`, `httpShouldSetCookies = false`, `httpCookieAcceptPolicy = .never`, request timeout 20 s. Tests inject a `URLProtocol` stub through the configuration's `protocolClasses`.
- **Refresh cookie.** Responses from `/auth/login`, `/auth/refresh`, `/kiosk/move-login` and `/kiosk/pair/{code}/poll` are scanned for a `Set-Cookie` named `ss_refresh` (`HTTPCookie.cookies(withResponseHeaderFields:for:)`); the value is saved in the `SecretStore` under `refresh.<host>`. A `Max-Age=0` / expired cookie deletes it. The stored value is sent as `Cookie: ss_refresh=<value>` on `/auth/refresh` and `/auth/logout` to the same host only. Cleared on logout and on session end.
- **SessionStore** is an `actor`: `accessToken`, `accessTokenExpiresAt`, `sessionExpiresAt`; `tokenIsStale()` within 30 s of expiry; `refresh()` single-flight (a stored `Task<Bool, Never>?` every concurrent caller awaits). A non-OK refresh clears the session; a network failure keeps local state.
- `authed(request)`: refresh when stale, attach `Authorization: Bearer`, on 401 refresh once and retry once, a failed refresh or second 401 posts `sessionEnded` (an `AsyncStream` the `SessionCoordinator` consumes).
- Errors: non-2xx → `ApiError(status, code, detail)` with `code` from `detail.code` (or `detail` when it is a string code, as the web's `jsonFrom`), default `unknown_error`; a `URLError` → `ApiError(status: 0, code: "network")`.

### Auth (`Data/Auth`)

`KioskAuth` is `@MainActor @Observable` with `state: AuthState` = `.loading | .anon | .authed(Session)` where `Session` carries person, roles, perms, preferences, mustChangePassword, sessionExpiresAt, maxRank, kioskMove (the move-session flag and initiative id from the session payload). On launch it calls `refresh()` once. `login(email:password:)` sends `client: "kiosk"`, marks the next heartbeat `sign_in` with `login_method: "password"`; `moveLogin(password:)` marks it `"password"` too (the web's rule: the heartbeat only knows password | link) and, when the saved setup selection belongs to a different initiative, clears the selection and sets setup state `incomplete` (the web's `KioskAuthContext` rule); `completePair(session)` marks `"link"`. `logout()` stops the heartbeat, POSTs `/kiosk/sign-out {serial}`, POSTs `/auth/logout`, clears the cookie and state. `can`, `isAdmin` (`maxRank >= 60`), `isDeveloper` (`roles` contains `developer`) as Android.

### Heartbeat

As Android `data/heartbeat/Heartbeat.kt`: runs while authed, not `mustChangePassword`, and `scenePhase == .active`; immediate beat then every 60 s; `now()` after a rename. Body `{serial, name, mode: "ios", version, raw_info: {manufacturer: "Apple", model: <utsname machine, e.g. "iPad14,8">, system_name, system_version, idiom: "ipad" | "phone"}, sign_in?, login_method?}`. The pending sign-in clears only when a beat carrying it succeeds; a failed beat keeps the last registration state.

### Local database (`Data/Db`)

SwiftData `ModelContainer` (store file `serversherpa-kiosk.store` in Application Support; an in-memory configuration in tests) with these `@Model` classes, fields as Android's Room entities (`data/db/Entities.kt`):

| Model | Unique | Indexed (`#Index`, iOS 18) |
|---|---|---|
| `AssetRecord` | `id` | `rfid`, `assetId`, `serialNumber` |
| `PersonRecord` | `id` | `rfidTag` |
| `ContainerRecord` | `id` | `rfidTag`, `name` |
| `TruckRecord` | `id` | `name`, `loadNumber` |
| `MetaRecord` | `key` | — (value is a JSON string; the `sync` row) |
| `OutboxRecord` | `clientScanId` | `status`, `seq` |

`KioskStore` is a `@ModelActor` and the only thing that touches the container. It returns `Core` value types (never `@Model` objects) across the actor boundary. `replaceRoster(assets:people:containers:trucks:meta:)` deletes the four tables and the meta row and inserts the new rows, then saves once — one save is one SQLite transaction, so a crash leaves either the old roster or the new one. `clearLocalData()` empties assets, people, containers, trucks, meta; never the outbox. Schema changes after release need a `VersionedSchema` + `SchemaMigrationPlan` (deferred: this pass ships schema v1).

### Sync

As Android `data/sync/Sync.kt`: `runSync(initiativeId:initiativeName:)` fetches `/kiosk/sync/assets`, `/people`, `/containers`, `/trucks` in parallel (`async let`); any failure → `phase = .error(code)` and the tables are untouched; success → `KioskStore.replaceRoster` and the meta row `{initiativeId, initiativeName, assets, people, containers, trucks, syncedAt}`. `SyncStatus` is `@Observable` (`idle | running | done | error`, counts, syncedAt, error). `hydrate()` at launch reads the meta row. A newer run supersedes an older one (run counter). Sync never changes setup state.

### Outbox

`Core/Outbox/OutboxMachine.swift` is Android `OutboxMachine.kt` verbatim: statuses `queued | sending | accepted | retrying | failed | nomatch`, `BACKOFF = [2000, 4000, 15000, 60000]` ms, `MAX_BATCH = 100`, `BATCH_DELAY = 500` ms, `LIST_CAP = 200`, `NOMATCH_TTL_MS = 120000`, `NOMATCH_SWEEP_MS = 10000`, pure functions over rows and an injected clock. `Data/Outbox/Outbox.swift` is the sender (an `actor`): `enqueue`, `flushOnce` (single-flight, POST `/kiosk/scans {serial, scans}`, accepted/rejected/no_ack handling, the backoff ladder, re-flush when more is due, wake at the earliest retry), `recoverStranded()` (sending → queued) on every `start()`, the no-match sweep every 10 s, and the operator actions `retryFailed`, `clearSent`, `discardFailed`. `start()` on `scenePhase == .active`, `stop()` on background. When the app backgrounds with a POST in flight, the sender holds a `UIApplication.beginBackgroundTask` until that batch's outcome is saved (the Android `NonCancellable` write-back). `OutboxSnapshot(rows: newest 200, counts)` is published to the Scanning screen.

### Kiosk-local settings (`Data/Prefs`)

UserDefaults, the web's `ss.kiosk.*` keys and defaults, as Android `data/prefs/KioskPrefs.kt`: `setupState`, `setupSelection` (JSON), `appearance` (good / not-found / duplicate HSL + `flash_ms` 350, 100–2000 step 50), `sound` (three choices + volume 0.8), `checkpoints` (`enroll` default `pre_stage`), `devMode`, plus iOS's `camera.position` (`back` default). Each store is `@Observable` so the UI follows changes.

### Flash, sound, screen

- `FlashController.flash(color, ms)` drives one full-window overlay at 0.85 opacity that fades over `ms`.
- `SoundPlayer` synthesizes chime, beep, double_beep, buzz, bonk with `AVAudioEngine` + `AVAudioSourceNode` (the same notes and envelopes as Android `ui/sound/SoundPlayer.kt`), at the configured volume; the audio session is `.playback` with `.mixWithOthers`, activated lazily on first play; it never throws.
- While signed in and active, `UIApplication.shared.isIdleTimerDisabled = true` (the kiosk screen does not auto-lock); it is reset on sign-out and background. Locking the device into the app is Guided Access or MDM single-app mode, documented in the README, not app code.

## Scan input pipeline (`Input/`)

`ScanEvent(value, source: .keyboard | .camera, symbology: String?)`. `ScanBus` hands events to the **one** registered listener: a screen registers in its `.task { for await event in bus.events() { … } }`, which SwiftUI cancels when the screen leaves the screen (a new registration replaces the old one). No view model subscribes in `init`, so a scan never lands on a screen that is not visible (the Android lesson).

- **Keyboard / HID.** `ScanInput` is a `TextField` with `@FocusState`: it takes focus when the screen appears and takes it back when focus becomes nil (not when another field or a button took it), `.submitLabel(.done)`, autocorrection and autocapitalization off, `.onSubmit` publishes the trimmed value and clears the field. A Bluetooth HID scanner is a hardware keyboard, so iPadOS hides the software keyboard while it is connected.
- **Camera.** `CameraScanSheet` (full-screen cover): `AVCaptureSession` with `AVCaptureMetadataOutput` for `.qr, .code128, .code39, .code39Mod43, .code93, .ean8, .ean13, .upce, .itf14, .interleaved2of5, .codabar, .pdf417, .dataMatrix, .aztec`; a reticle; a torch toggle (back camera only, hidden when the device has no torch); a **front/back flip** stored in `camera.position`; the Single / Multi segmented switch (default Single). **Single** publishes the first read and closes. **Multi** publishes each value not yet seen in this open once (`MultiReadSession`), shows the count and the last five values, and closes on Done. Permission is requested on first open; denied → inline message with an "Open Settings" button (`UIApplication.openSettingsURLString`). The session runs on a dedicated serial queue, stops when the sheet closes, and frames are never stored. The camera button shows only when a video device exists (never on the simulator's no-camera case).

## Navigation and guards

`RootView` holds a `NavigationStack(path:)` with routes `home`, `setup`, `settings(tab)`, `scan`, `enroll`, `timeclock`, `containers`, `trucks`, `labels`. Login is not a route: `KioskGuard` renders `LoginScreen` whenever `auth.state == .anon`, a spinner for `.loading`, and the must-change-password notice (Android wording) for that case; otherwise the shell and stack. `SetupGate` redirects a feature route to home when `featureAvailable` is false. Settings is reachable signed out (This Kiosk only) as a sheet from the login gear.

## Screens

### Login (the mockup)

The signed-out screen reproduces Jimmy's mockup (`2026-09-30` attachment, which is the portal's `LoginScene` + `login-light.css` with the mockup's wording). Where the mockup and the portal differ, the mockup wins.

**Scene** (`LoginScene.swift`, drawn with SwiftUI `Canvas`/`Path`, no web view):
- Canvas `#FFF9F2`; 17 contour lines from the portal's `contour(i)` formula in a 1672×941 frame, aspect-fill, orange at 14 % opacity, 1 pt stroke.
- Mountains (`LoginMountains`) bottom-right, 61.1 % of the width, with the top (0→26 %) and left (0→16 %) edges faded by gradient masks.
- Logo top-left: the mark (52–74 pt), "Server" ink + "Sherpa" orange (weight 800), "DATACENTER RELOCATION TOOLS" mono, letter-spaced, slate.
- Map: a 1040×560 box that scales as one piece. Dashed orange route `M373 421 C 392 330 440 244 573 213 C 670 190 745 160 776 112` (2.6 stroke, dash 8/7), glowing midpoints at (573, 213) and (373, 421), ringed pins at (790, 95) and (358, 458) with an orange glow. Pin labels (mockup wording): **LAS VEGAS** / "Las Vegas, NV" and **DALLAS** / "Dallas, TX" in mono, orange titles. States NEVADA (576, 138), CALIFORNIA (138, 319), ARIZONA (813, 403), TEXAS (183, 509), mono, 0.3 em tracking, slate. The card at (240, 205): **1,241 ASSETS** / "RACK 83 · ETA 2h 14m", white, orange 1.5 pt border, 8 pt radius, with the leader line `M432 242 H 470`.
- Headline bottom-left: "Migration Control." (ink, 800) over "From First Scan to Final Rack." (orange, 800); under it "Track assets. Verify work. Move with confidence." (slate, light).
- Status line bottom-left: green dot + "ALL SYSTEMS OPERATIONAL" (mono, tracked).

**Form column** (right side, max 392 pt wide, vertically centered, over the mountain mist):
- Eyebrow "SERVERSHERPA PORTAL" in orange mono with a trailing orange rule; title "Sign in" (800, ~52 pt); "Use your account to access your migration workspace." (slate).
- EMAIL label + field (placeholder `you@company.com`, email keyboard, no autocorrect, `.textContentType(.username)`); PASSWORD label with **Forgot password?** link at the right + secure field with the eye toggle (`.textContentType(.password)`); fields are `#F8FAFC` with a `#CBD5E1` border, 8 pt radius, 56 pt tall.
- **Sign in →** full-width ink button (60 pt, white label + orange arrow); "Signing in…" while busy.
- "OR" divider; **Continue with SSO** outline button with the orange link icon; tapping shows "Company SSO isn't enabled yet — sign in with your email and password." under it (the portal's copy).
- "Need help? **Contact support**" — opens the support card (the portal's Forgot Password / Contact Support card copy); **Forgot password?** opens the same card.
- Kiosk additions: a gear button (44 pt) at the top-right of the form column opens Settings › This Kiosk as a sheet; under the SSO button, two quiet links **Pair with phone** and **Use a move password** that swap the form body in place with a Back link; read-only / broadcast banners from `/system/status` above the eyebrow.
- Errors (the web kiosk's `ERROR_MESSAGES`): `invalid_credentials` "Invalid email or password.", `account_locked`, `account_disabled`, `totp_required`, `kiosk_not_allowed`, `network` "Can't reach the server. Check the kiosk's network connection.", else "Login failed. Please try again."; empty fields → "Please enter both email and password" with the empty field outlined red.
- **Pair with phone** (`PairPanel`): as Android `PairPanel.kt` — the code large in mono, a QR of `link_url` (Core Image `CIQRCodeGenerator`, nearest-neighbor scaled), the URL, "Expires in m:ss", poll every 2 s, approved → `completePair`, denied / expired states with Try again / New code.
- **Move password** (`MovePasswordForm`): one secure field with the eye toggle, "Sign in" button, the web's `MOVE_ERROR_MESSAGES` (`invalid_move_password` "That move password isn't right.", `move_not_active` "That move password isn't active.", `move_login_rate_limited` "Too many tries. Wait a few minutes.", `kiosk_not_allowed` "That move can't sign in to kiosks right now. Ask a coordinator.", `network`), empty → "Enter the move password."; the field clears after a failure.

**Sizes** (the web's breakpoints, measured on the screen's width in points):
- **≥ 1180** (iPad landscape, 11″ and 13″): the full mockup — scene left, form right.
- **900–1179** (iPad portrait 13″, iPad landscape mini): the web's `max-width: 1279px` rules — map scaled down, leader line hidden, headline kept, form right.
- **< 900** (iPad portrait 11″ and smaller, iPhone, split view): the web's `max-width: 899px` rules — logo on top, the form in a single scrolling column, status line below, no map and no headline, mountains full width at 45 % opacity behind.
- Height under 780 pt hides the state names (the web's `max-height: 780px`).
- The form scrolls when the keyboard is up.

### Shell

As Android `KioskShell.kt`: ink top bar — logo 26 pt, "Server**Sherpa**" (accent on Sherpa), chip "KIOSK · IPAD" / "KIOSK · IPHONE" (mono), current feature title; then the kiosk name as a mono button (→ This Kiosk), the registration chip (green Registered / amber Expires soon / red Expired / slate Unregistered), the person's display name (long-press → "Session ends …"; a move session shows "Kiosk · <move>"), Sign out. On compact width the bar wraps to two rows. Footer: one mono line — Mode iOS · Version · Move · Site · Scan · Data Sync (green `done` / red otherwise, long-press for detail) · Dev mode On. `ScanFlash` overlays everything.

### Home

As Android `HomeScreen.kt` (eyebrow "Kiosk", "What would you like to do?", setup banners, tiles in `FEATURES` order, unavailable tiles dimmed with the reason). Grid: 3 columns when the content width is ≥ 1000 pt, 2 columns otherwise.

### Kiosk Setup

As Android `KioskSetupScreen.kt` + `KioskSetupViewModel.kt` (three steps, revalidation of cached choices, summary with Sync again / Change setup). A move session sees only its own move. Cards are an adaptive grid (min 300 pt) on iPad, one column on iPhone.

### Scanning

As Android `ScanScreen.kt` + `ScanViewModel.kt` minus the RFID read panel and DataWedge trigger: the header, `ScanInput` + camera button, counts, Retry failed / Clear sent / Discard failed (confirmation dialog), match → flash + sound + enqueue, the empty-roster notice. Layout: at ≥ 700 pt content width a table with columns Time, Value, Asset, Make / Model, Status (pill, `last_error` under a failed status); narrower, stacked rows as Android.

### RFID Enroll

As Android `EnrollScreen.kt` + `EnrollViewModel.kt` + `core/scan/EnrollGate.kt`: step one (asset ID or serial, RFID refused), the existing-tag confirmation step with **Update RFID Value**, "You just enrolled…", step two (tag entry with the live padded preview), `checkEnrollTag` before and inside the send, the POST, the success toast, the error map, the 25-row session log. The tag arrives typed, from a HID scanner or from the camera. At ≥ 1000 pt the session log sits in a right-hand column beside the steps.

### Timeclock

As Android `TimeclockScreen.kt` + `TimeclockViewModel.kt`: badge or name entry with the ambiguous-prefix rule, up to 8 tappable results, the person card with avatar (the presigned URL fetched with URLSession and decoded to `UIImage`; initials on failure), Clock in / Clock out, toasts, the error map, 20 s idle reset, elapsed time ticking every 30 s.

### Settings

As Android `SettingsScreen.kt` with tabs Appearance, Sound, Devices, This Kiosk, Admin (admin only), Developer (developer role only); signed out, only This Kiosk. The Segmented tab strip scrolls horizontally on iPhone.

- **Appearance, Sound:** as Android (HSL pickers with Preview, flash duration; sound choices with play buttons, volume).
- **Devices:** read-only rows — Camera (back / front / both / none), Torch (available / none), Hardware keyboard (connected / none, from `GCKeyboard.coalesced` via GameController), Camera used for scanning (Back / Front, the same setting as the sheet's flip).
- **This Kiosk:** name (Save, validation, beats immediately), serial (mono, copy), Mode iOS, device model, API URL (Save, `http(s)://` only), portal URL, version.
- **Admin:** the RFID Enroll checkpoint chooser only (no RFID region).
- **Developer:** as Android (dev mode switch, setup-state override, local data counts, Clear local data, the local data inspector).

### Placeholder

As Android `FeaturePlaceholderScreen.kt`.

## API

No server changes. Endpoints used (all on `main`): the Android list (`/auth/login|refresh|logout`, `/system/status`, `/kiosk/pair` + poll, `/kiosk/heartbeat`, `/kiosk/sign-out`, `/kiosk/setup-options`, `/kiosk/setup`, `/kiosk/sync/assets|people|containers|trucks`, `/kiosk/scans`, `/kiosk/assets/{id}/rfid`, `/kiosk/timeclock/{person_id}`, `/kiosk/timeclock/clock-in|clock-out`) plus `POST /kiosk/move-login`. The move lock is server-enforced on every kiosk route; the app only has to clear another move's saved setup at move sign-in.

## Security notes

- The refresh cookie value is the only secret at rest; it lives in the Keychain (`kSecClassGenericPassword`, service `com.serversherpa.kiosk.session`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). URLSession's cookie storage is disabled so the cookie is never written to the plain-text cookie file. The access token is memory-only.
- `raw_info` has five bounded keys, no identifiers beyond model strings.
- Scan values are data, never interpreted.
- The camera runs only while the sheet is open; frames are never stored.
- The API URL setting accepts only `http(s)://` origins. ATS arbitrary loads are allowed so a LAN dev API over HTTP works (the Android cleartext equivalent); production is HTTPS.

## Testing

- **Unit tests (`ServerSherpa KioskTests`, Swift Testing)** — every Android `core/` test ported with its cases: ScanMatch, Rfid, EnrollGate, PeopleMatch, OutboxMachine (injected clock), Features, SetupState, Registration, Access, Appearance, SoundSettings, Checkpoints, SettingsTabs (no RFID tab), plus `CorePurityTests`.
- **Transport tests** with a `URLProtocol` stub: login stores the session and the cookie; refresh is single-flight under concurrent callers; 401 → refresh → retry once; a second 401 ends the session; the cookie is sent only on refresh/logout to the same host; `ApiError` code extraction; `URLError` → `network`; move-login.
- **Data tests** with an in-memory SwiftData container and `MemorySecretStore` + a throwaway `UserDefaults(suiteName:)`: `KioskStore.replaceRoster` (a failed sync leaves tables intact; success replaces all four + meta), outbox persistence round-trip + `recoverStranded`, sender batching / rejection / backoff with a stub API and injected clock, prefs round-trips and defaults, heartbeat body, identity serial generation and name validation, move-login clearing another move's setup.
- **View-model tests**: login error mapping and empty-field validation, move-password errors, launcher gating, setup wizard advancing and saving, scan enqueue path, enroll gates, timeclock exact-badge auto-select.
- **UI test (`ServerSherpa KioskUITests`)**: launch shows the login screen with "Sign in" and the email field (the template's launch test, kept; the performance test removed).
- **Gate:** `xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,id=<iPad Air 11-inch (M3), iOS 18.5>' -only-testing:"ServerSherpa KioskTests"` green and a clean `xcodebuild build` for an iPhone 16 (iOS 18.5) destination, with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (the Mac's `xcode-select` points at the Command Line Tools).
- **Live verification** (implementer): run on the iPad Air 11-inch (M3) iOS 18.5 simulator in landscape and portrait and on the iPhone 16 iOS 18.5 simulator; screenshot the login screen at each size and compare with the mockup; sign in against `https://api.dev.serversherpa.com` with the seeded dev login (`claude-dev@test.example.com`, see the dev-workflow memory); run Kiosk Setup against a seeded move; scan typed values (the simulator has no camera); enroll a tag on a seeded asset; clock a seeded worker in and out; confirm the portal's Kiosk Devices page shows the device as iOS, Registered, signed in.

## Out of scope (deliberately)

Containers, Trucks, Label Printing and printer tools, sound uploads, 2FA sign-in (the `totp_required` message stands, as on the web kiosk and Android), real SSO, delta or periodic sync, background sending beyond finishing an in-flight batch, tile permission gating, any RFID reader hardware (Zebra or otherwise), NFC, density and text-size preferences, a SwiftData migration plan (v1 only), App Store / TestFlight packaging, MDM configuration, Swift 6 language mode.

## Implementation notes (2026-09-30)

Deviations from this spec, all decided during review:

- The `Sync` type lives in `Data/Sync/SyncCoordinator.swift` (file-name clash with synchronized folders).
- The refresh cookie survives 5xx and network refresh failures; it is deleted only on a 401/403 refresh, on logout, or when the server clears it with Set-Cookie (Android parity).
- A `RedirectGuard` strips `Cookie` and `Authorization` on cross-origin redirects (tightened below: credentialed or non-GET ones are not followed at all).
- One shell top bar with a "‹ Home" back control; the system navigation bar is hidden.
- The `.inactive` scene phase is not treated as background.
- Enroll and Timeclock drop scans that arrive mid-request (Android parity).
- Timeclock keeps a typed name and its matches on Enter; stale punch results do not touch a new selection.
- The login uses the portal's cropped mountain art (Jimmy's original art file would fill the lower-left).
- Pairing survives rotation; kiosk links work under SSO; the web's empty-field rule applies to the login form.
- Scan box reclaims focus whenever nothing holds it; scanning uses cached time formatters and ignores canceled roster loads.
- Camera sheet stops cleanly, turns the torch off on flip, shows an upright preview, and reports start failures.
- Identity caches its serial; the URL setting requires a host.
- The UI tests add a signed-out screenshot pass (`testSignedOutScreenshots`: Settings, Pair with phone, move password) driven by `-uiTestSignedOut` (Debug only).
- Final review fixes: a refresh whose answer lands after a sign-in or sign-out is dropped (a SessionStore generation counter; nothing is stored, captured or cleared), and the outbox flushes only while the app is active and signed in; saving a new API origin while signed in clears the session and returns to the login screen (the old host keeps its cookie); a cross-origin redirect of a credentialed, bodied or non-GET request is not followed (its 3xx comes back as an error; credential-less GETs still follow, stripped); the outbox waits out the first back-off step (2 s) when its store can't save, instead of retrying at once; an approved pair poll keeps its session and cookie only when `KioskAuth.completePair` accepts it; sign-out flips to signed out at once and tells the portal in the background with the token and cookie captured beforehand.
- The unit-test host never restores the live session: when `XCTestConfigurationFilePath` is set (`RuntimeEnvironment.isUnitTestHost`), `ServerSherpa_KioskApp` shows an empty view and never builds `AppContainer.live()`. xcodebuild runs tests in a simulator clone that copies the Keychain, so a host-launched restore rotated the real refresh token server-side and tripped reuse detection (`auth_sessions.revoke_reason = 'reuse_detected'`) on the real simulator. UI tests are unaffected (their app process lacks the variable).

Verification status: unit tests, phone build, UI tests and the Release build pass. The signed-out screens were checked on the iPad Air 11-inch (M3) and iPhone 16 (iOS 18.5) simulators. Camera behavior is unverified on hardware. The signed-in live run (sign-in, Kiosk Setup, sync, scanning, RFID Enroll, Timeclock, portal Kiosk Devices check) is pending and will be done with Jimmy.
