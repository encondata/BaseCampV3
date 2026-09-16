# Android kiosk app: framework, setup, scanning, RFID enroll, timeclock

The Android kiosk is the web kiosk (`kiosk/`, spec `2026-09-13-kiosk-web-design.md`) rewritten as a native Android app for phones and Zebra handhelds. This first pass ports the framework (sign-in, session, heartbeat, shell, launcher, settings), Kiosk Setup with local data sync, Scanning with its offline outbox, RFID Enroll, and Timeclock. Containers, Trucks, and Label Printing are placeholder tiles. An iOS app will follow as an independent project; nothing here is shared with it beyond the shapes in `core/`.

**Date:** 2026-09-15 · **Status:** approved (Jimmy, 2026-09-15: "yes" to every section) · **Branch:** `android-kiosk` (worktree off `main` at e9e49f2)

## Decisions already made

| Question | Decision |
|---|---|
| Scope | Framework, Kiosk Setup + sync, Scanning, RFID Enroll, Timeclock. Placeholders for Containers, Trucks, Label Printing. |
| Architecture | Native Kotlin + Jetpack Compose. Independent from the future iOS app (Kotlin Multiplatform was considered and rejected). Logic lives in Android-free Kotlin packages so iOS can transliterate it. |
| Targets | Android phones and Zebra handhelds (the MC2200 on Jimmy's desk runs Android 11 / API 30, 480×800 portrait, DataWedge 11.3, no camera, no NFC). Tablets are not a target. |
| minSdk / targetSdk | 30 / 36. |
| Scan input | Typed entry, Bluetooth and USB HID scanners (Zebra DS22), Zebra DataWedge, and the camera with single- and multi-read modes. |
| Stack | OkHttp + kotlinx.serialization, Room, DataStore, Navigation Compose, CameraX + ML Kit, manual dependency wiring in one `AppContainer`. No Hilt, no Retrofit. |
| Project location | `Android_Kiosk_App/` at the repo root, committed on `android-kiosk`. `IOS_Kiosk_App/` stays uncommitted and untouched. |
| Identity | Application id and package `com.serversherpa.kiosk`; app name "ServerSherpa Kiosk". |
| Session model | Same as the web kiosk: `ss_refresh` httpOnly cookie on the API host (persisted by the app), access token in memory only, login tagged `client: "kiosk"`. |
| Kiosk registration | Self-registers as a `Device` by serial through the heartbeat, `mode: "android"`. Signing in auto-registers (the API already handles `sign_in` + `login_method`). |
| API base URL | Editable on Settings › This Kiosk, persisted. Default `https://api.dev.serversherpa.com` in debug builds, `https://api.serversherpa.com` in release. No hostname guessing. |

## Project shape

### Gradle

- One module, `app`. Kotlin 2.0.21, AGP 8.13.2, Compose BOM 2024.09.00 (the scaffold's), `compileSdk 36`, `minSdk 30`, `targetSdk 36`, JVM target 11. KSP for Room.
- Dependencies added to the scaffold: `androidx.navigation:navigation-compose`, `androidx.lifecycle:lifecycle-viewmodel-compose`, `androidx.datastore:datastore-preferences`, `androidx.room:room-runtime` + `room-ktx` (+ `room-compiler` via KSP), `com.squareup.okhttp3:okhttp` + `logging-interceptor`, `org.jetbrains.kotlinx:kotlinx-serialization-json`, `org.jetbrains.kotlinx:kotlinx-coroutines-android`, `androidx.security:security-crypto` (refresh cookie), `androidx.camera:camera-core/camera2/lifecycle/view`, `com.google.mlkit:barcode-scanning`, `com.google.zxing:core` (QR rendering for pairing), camera permission through `rememberLauncherForActivityResult(RequestPermission())` (no Accompanist).
- Test dependencies: JUnit 4, `kotlinx-coroutines-test`, `com.squareup.okhttp3:mockwebserver`, Robolectric, `androidx.room:room-testing`, `androidx.compose.ui:ui-test-junit4` (Robolectric-hosted).
- `BuildConfig` fields: `DEFAULT_API_URL`, `DEFAULT_PORTAL_URL`, `KIOSK_VERSION` (= `versionName`).
- `local.properties` and `.idea/` are ignored. The Gradle wrapper (8.13) is committed. Builds run headless from the Mac with `JAVA_HOME` = Android Studio's bundled JDK 21 and `sdk.dir` from `local.properties`.

### Source layout (`app/src/main/java/com/serversherpa/kiosk/`)

```
KioskApplication.kt        creates AppContainer; starts DataWedge profile setup
MainActivity.kt            single Activity, edge-to-edge, sets KioskApp()
AppContainer.kt            manual DI: config, identity, api, session, db, stores, scan bus, sound, flash
core/                      PURE KOTLIN — no android.* imports (enforced by a unit test that scans the package)
  model/                   Session, Person, Preferences, SetupOptions, KioskSetupSelection, Asset, PersonRow,
                           ContainerRow, TruckRow, ScanEvent, OutboxRow, RegistrationState, SystemStatus …
  features/Features.kt     FEATURES registry (id, route, title, blurb, alwaysAvailable), featureAvailable()
  setup/SetupState.kt      incomplete | complete | failed, isSetupComplete, label
  scan/ScanMatch.kt        buildScanIndex, matchScan, matchAssetOrSerial, scanTypeFor
  scan/Rfid.kt             RFID_LENGTH, padRfid, displayRfid, rfidProblemText
  people/PeopleMatch.kt    buildPeopleIndex, matchPersonExact, isAmbiguousPrefix, searchPeople
  outbox/OutboxMachine.kt  the status transitions, dueRows, backoff ladder, batch selection (pure functions over rows + clock)
  settings/                Appearance (Hsl, defaults, migration), SoundChoice, Checkpoint defs, SettingsTabs
  ApiError.kt              status + code + detail
data/
  config/KioskConfig.kt    apiUrl/portalUrl (DataStore-backed, BuildConfig defaults), kioskVersion
  identity/Identity.kt     serial (`kiosk-android-<uuid>`), name (default `Kiosk XXXX`), NAME_MAX 80
  api/KioskApi.kt          every endpoint, mirrors kiosk/src/lib/api.ts function for function
  api/SessionStore.kt      access token + expiry in memory, refresh single-flight, session-ended flow
  api/RefreshCookieJar.kt  persists ss_refresh in EncryptedSharedPreferences; other cookies in memory
  api/AuthInterceptor.kt   bearer header; on 401 refresh once + retry once; second 401 -> session ended
  auth/KioskAuth.kt        StateFlow<AuthState>: loading | authed(session) | anon; login, completePair, logout,
                           can(resource, action), isAdmin (max_rank >= 60), isDeveloper (roles contains "developer")
  heartbeat/Heartbeat.kt   foreground-only loop, 60 s, pending sign_in until a beat succeeds
  db/KioskDatabase.kt      Room: assets, people, containers, trucks, meta, outbox
  db/*Dao.kt
  sync/Sync.kt             runSync (parallel fetch, one transaction), SyncStatus StateFlow, hydrate from meta
  outbox/Outbox.kt         Room-backed queue + sender (batching, backoff, sweep) around core/outbox/OutboxMachine
  prefs/*.kt               DataStore stores: setup selection, setup state, appearance, sound, checkpoints, devMode
  status/SystemStatus.kt   GET /system/status for the login banners
input/
  ScanBus.kt               MutableSharedFlow<ScanEvent>; ScanEvent(value, source, symbology?)
  datawedge/DataWedge.kt   presence check, SET_CONFIG profile, soft trigger; DataWedgeReceiver (BroadcastReceiver)
  camera/CameraScanner.kt  CameraX + ML Kit analyzer; single/multi read modes
  keyboard/                nothing to build: the screen's text field publishes on Enter
ui/
  theme/                   Tokens.kt (portal colors), Type.kt (Geologica, Fragment Mono), KioskTheme
  KioskApp.kt              NavHost + guards
  shell/KioskShell.kt      top bar + content + footer; ScanFlash overlay
  guards/                  KioskGuard (signed-in / must-change-password), SetupGate
  components/              ScanInput, CardGrid/SetupCard, Chip, Segmented, SettingsRow, HslPicker, Toast
  screens/login/           LoginScreen + LoginViewModel, PairPanel (code, QR, polling)
  screens/home/            HomeScreen (launcher)
  screens/setup/           KioskSetupScreen + ViewModel (wizard + summary)
  screens/settings/        SettingsScreen + tabs (Appearance, Sound, Devices, ThisKiosk, Admin, Developer)
  screens/scan/            ScanScreen + ViewModel
  screens/enroll/          EnrollScreen + ViewModel
  screens/timeclock/       TimeclockScreen + ViewModel
  screens/placeholder/     FeaturePlaceholderScreen
```

`core/` has no Android dependency and no coroutine-framework dependency beyond `kotlinx.coroutines` where a Flow is unavoidable. A unit test (`CorePurityTest`) greps `core/` for `import android` and fails on any hit — the Android equivalent of the web kiosk's `portalImports.test.ts` guardrail.

### App icon

An adaptive icon generated from `portal/public/images/serversherpa-logo.png` (890×890, the favicon is a 48 px downsample of the same art): foreground = the logo scaled to fit the 66 dp safe zone of the 108 dp canvas, background = paper `#f1f4f7`. A checked-in Python script (`Android_Kiosk_App/tools/make_icons.py`, Pillow) writes `ic_launcher_foreground.png` / `ic_launcher_background` for mdpi…xxxhdpi plus the legacy `ic_launcher.webp` / `ic_launcher_round.webp`, and the `mipmap-anydpi-v26` XML references them. Re-running the script is the only way icons change.

### Theme

`ui/theme/Tokens.kt` restates the portal tokens by name: `ink #0c1117`, `ink2 #121925`, `inkLine #243140`, `paper #fbfcfd`, `paper2 #f1f4f7`, `paperLine #e4e8ee`, `textDark #1b2129`, `textMute #667085`, `snow #e8edf4`, `ok #3ecf8e`, accent amber `#ffa12e` / soft `#ffc06b`, chip colors green `#3ddc84`, amber `#ffb84d`, red `#ff5d6c`, blue `#4dd0ff`, violet `#a78bfa`, aqua `#35e0c8`, slate `#8a97aa`, and the dark-theme paper set (`#10151f`, `#0b0f17`, line `rgba(255,255,255,.09)`, text `#e8edf4`, mute `#8a97aa`). The accent follows the signed-in person's `preferences.accent` (amber, aqua, blue, violet, pink `#ff6fae`, green) and the theme follows `preferences.theme` (light/dark; `system` follows the OS). Density and text-size preferences are ignored in this pass.

Fonts: Geologica (200–800) and Fragment Mono (regular, italic) bundled under `res/font/` from Google Fonts (OFL). If the TTFs cannot be fetched during implementation, the theme falls back to the system sans and monospace and the spec's implementation notes say so.

## Runtime pieces

### Config (`data/config`)

`KioskConfig` exposes `apiUrl: Flow<String>` and `portalUrl: Flow<String>` from DataStore keys `ss.kiosk.apiUrl` / `ss.kiosk.portalUrl` (the web kiosk's `ss.kiosk.*` key convention, like every other kiosk-local value), falling back to `BuildConfig.DEFAULT_API_URL` / `DEFAULT_PORTAL_URL`. Trailing slashes are trimmed. `kioskVersion()` = `BuildConfig.KIOSK_VERSION`. The API client reads the URL per request, never at construction.

### Identity (`data/identity`)

- `serial`: DataStore `serial`, generated once as `kiosk-android-<uuid4>`.
- `name`: DataStore `name`, default `Kiosk <last 4 of serial, uppercase>`, editable on This Kiosk (trimmed, 1–80).
- `getIdentity(): KioskIdentity(serial, name)`; `setKioskName(name): Boolean`.

### Transport (`data/api`)

- `KioskApi` mirrors `kiosk/src/lib/api.ts`: `login(email, password)`, `logout()`, `refresh()`, `createPairRequest`, `pollPair`, `heartbeat`, `signOut(serial)`, `getSetupOptions`, `submitKioskSetup`, `fetchAssetsSync`, `fetchPeopleSync`, `fetchContainersSync`, `fetchTrucksSync`, `postScans`, `postRfidEnroll`, `fetchTimeclockStatus`, `postClockIn`, `postClockOut`, `getSystemStatus`. Request/response models are `@Serializable` data classes with the server's snake_case field names (`SessionData`, `HeartbeatResult`, `SetupOptions`, `KioskSetupResult`, `KioskAssetRow`, `KioskPersonRow`, `KioskContainerRow`, `KioskTruckRow`, `KioskScanIn`, `KioskScanBatchOut`, `KioskRfidEnroll`, `KioskTimeclockStatus`, `SystemStatus`). Unknown JSON keys are ignored.
- Errors: a non-2xx response becomes `ApiError(status, code, detail)` with `code` from `detail.code` (default `unknown_error`); a thrown `IOException` becomes `ApiError(0, "network")`.
- `SessionStore` keeps `accessToken`, `accessTokenExpiresAt`, `sessionExpiresAt` in memory. `tokenIsStale()` is true within 30 s of expiry. `refresh()` is single-flight (a `Mutex` + shared `Deferred`): POST `/auth/refresh` with the cookie; success stores the session, a non-OK answer clears it, a network failure keeps local state.
- `AuthInterceptor`: before an authenticated call, refresh if stale; attach `Authorization: Bearer`. On 401, refresh once and retry once; if refresh fails or the retry is 401, emit `sessionEnded`. Unauthenticated calls (`/auth/login`, `/kiosk/pair*`, `/system/status`) bypass it.
- `RefreshCookieJar`: stores only the `ss_refresh` cookie, in `EncryptedSharedPreferences` (`kiosk_session`), keyed by host. Cleared on logout and on `sessionEnded`.
- `installForegroundRefresh`: a `ProcessLifecycleOwner` observer refreshes on `ON_START` when a session exists and the token is stale — the web's visibility-change refresh.

### Auth (`data/auth/KioskAuth`)

`StateFlow<AuthState>` where `AuthState` is `Loading`, `Anon`, or `Authed(person, roles, perms, preferences, mustChangePassword, sessionExpiresAt, maxRank)`. On construction it calls `refresh()` once (cookie restore). `login(email, password)` posts `client: "kiosk"` and marks the next heartbeat `sign_in` with `login_method: "password"`; `completePair(session)` does the same with `"link"`. `logout()` stops the heartbeat, POSTs `/kiosk/sign-out {serial}`, POSTs `/auth/logout`, clears local state. `can(resource, action)` computes from `perms` the way the portal's `computeCan` does. `isAdmin` = `maxRank >= 60`; `isDeveloper` = `"developer" in roles`.

### Heartbeat (`data/heartbeat`)

Runs while `Authed` and not `mustChangePassword` and the app is in the foreground: an immediate beat, then every 60 s. Body: `{serial, name, mode: "android", version, raw_info: {manufacturer, model, android_version, sdk_int, datawedge: bool}, sign_in?, login_method?}`. The pending sign-in is cleared only when a beat carrying it succeeds. Result `registration` (`ok | soon | expired | none`) feeds the shell chip; a failed beat keeps the last state. `now()` beats immediately (after a rename).

### Local database (`data/db`)

Room database `serversherpa-kiosk`, version 1:

| Table | Key | Indexed | Row |
|---|---|---|---|
| `assets` | `id` | `rfid`, `asset_id`, `serial_number` | `KioskAssetRow` (`id, asset_id, name, rfid, serial_number, make, model, make_model, container_id, label` — `label` stored as a JSON string) |
| `people` | `id` | `rfid_tag` | `KioskPersonRow` |
| `containers` | `id` | `rfid_tag`, `name` | `KioskContainerRow` |
| `trucks` | `id` | `name`, `load_number` | `KioskTruckRow` |
| `meta` | `key` | | `key`, `value` (JSON string) — the `sync` row |
| `outbox` | `client_scan_id` | `status`, `seq` | `OutboxRow` (see Outbox) |

`STORES` (what Clear local data empties) = assets, people, containers, trucks, meta. `outbox` is never cleared by that action.

### Sync (`data/sync`)

`runSync(initiativeId, initiativeName)`: fetch `/kiosk/sync/assets?initiative_id`, `/kiosk/sync/people`, `/kiosk/sync/containers?initiative_id`, `/kiosk/sync/trucks?initiative_id` in parallel (`async`); any failure sets `phase = error` with the `ApiError` code and leaves every table untouched. On success, one Room transaction clears and inserts the four tables and writes the `sync` meta row `{initiativeId, initiativeName, assets, people, containers, trucks, syncedAt}`; counts reported afterwards come from the tables. `SyncStatus(phase: idle|running|done|error, assets?, people?, containers?, trucks?, syncedAt?, error?)` is a `StateFlow`; `hydrate()` reads the meta row once at startup so a relaunch shows `done` with counts. A newer run supersedes an older one (run counter, as in the web). Sync never changes setup state.

### Outbox (`core/outbox` + `data/outbox`)

The web machine, verbatim:

- Row: `client_scan_id` (uuid), `seq` (monotonic, persisted), `scanned_value`, `scan_type` (`rfid|barcode`), `scanned_at` (ISO), `asset` (denormalized `id, asset_id, name, rfid, serial_number, make_model`, nullable), `matched`, `status` (`queued|sending|accepted|retrying|failed|nomatch`), `attempts`, `next_attempt_at?`, `last_error?`, `site_id`, `initiative_id`, `scan_status`.
- Constants: `BACKOFF = [2000, 4000, 15000, 60000]`, `MAX_BATCH = 100`, `BATCH_DELAY = 500 ms`, `LIST_CAP = 200`, `NOMATCH_TTL_MS = 120000`, `NOMATCH_SWEEP_MS = 10000`.
- `enqueue(input)`: matched → `queued` and schedule a flush 500 ms out (never later than one already pending); unmatched → `nomatch`, never sent.
- `flushOnce()`: due rows = `queued` + `retrying` past `next_attempt_at`, oldest `seq` first, up to 100, marked `sending`, POSTed to `/kiosk/scans {serial, scans}` with `asset_id = asset?.id`. Accepted ids → `accepted`; ids in `rejected` (or in neither list) → `failed` with the code (`no_ack` when absent). A thrown `ApiError` puts the batch on the ladder: wait = `BACKOFF[attempts]` before increment; past the ladder → `failed`. Single-flight; after a pass, flush again if more is due, otherwise wake at the earliest retry.
- On start: rows left `sending` return to `queued` (ingest is idempotent); expire `nomatch` rows older than the TTL, then every 10 s.
- Operator actions: `retryFailed` (failed → queued, attempts 0), `clearSent` (drops accepted + nomatch), `discardFailed` (drops failed, after a confirm dialog).
- The sender runs while the app is in the foreground (a lifecycle-scoped coroutine); a relaunch picks the queue up. Background sending (WorkManager) is deferred.
- `OutboxSnapshot(rows: newest 200, counts: queued/accepted/failed/nomatch/total)` is a `StateFlow` the Scanning screen renders.

### Kiosk-local settings (`data/prefs`)

All in one DataStore file `kiosk_prefs`, each with the same default as the web:

- `setupState`: `incomplete|complete|failed` (default incomplete).
- `setupSelection`: JSON `{initiativeId, initiativeName, siteId, siteName, siteRole, scanStatus, scanLabel}` or absent.
- `appearance`: `good_scan {h150 s60 l45}`, `not_found_scan {h0 s70 l50}`, `duplicate_scan {h38 s92 l50}`, `flash_ms` (default 350, range 100–2000 step 50).
- `sound`: `good`, `not_found`, `duplicate` each `none | builtin(chime|beep|double_beep|buzz|bonk)`, `volume` 0–1. Defaults: good = chime, not_found = buzz, duplicate = double_beep, volume 0.8.
- `checkpoints`: `enroll` default `pre_stage` (the other four keys exist with their web defaults but have no UI yet).
- `devMode`: Boolean, default false.

### Flash and sound

`ScanFlash` is one overlay at the shell level: `flash(color, ms)` paints the full window with the color at 0.85 alpha and fades over `ms`. `SoundPlayer.play(kind)` synthesizes the five built-ins with `AudioTrack` (short sine/square envelopes matching the web's oscillator notes) at the configured volume and never throws.

## Scan input pipeline (`input/`)

`ScanEvent(value: String, source: KEYBOARD | DATAWEDGE | CAMERA, symbology: String?)`. `ScanBus` is a `MutableSharedFlow<ScanEvent>(extraBufferCapacity = 64)`. The active screen's ViewModel collects it and calls its own `onScan(value)`. Screens that are not on top do not collect, so a scan never lands on a hidden screen.

- **Keyboard / HID.** `ScanInput` composable: a `TextField` that requests focus when the screen is ready and reclaims it when focus drifts to nothing (not from another text field or a button the person tapped), `imeAction = Done`, `singleLine`. Enter/Done publishes the trimmed value to the bus and clears the field. The soft keyboard shows on phones; on the MC2200 (hard keyboard present) it stays hidden unless the field is tapped. A paired HID scanner types into it exactly as on the web.
- **DataWedge.** `DataWedge.isPresent(context)` = `com.symbol.datawedge` installed. On app start, when present, send `com.symbol.datawedge.api.ACTION` with `com.symbol.datawedge.api.SET_CONFIG`: profile `ServerSherpaKiosk`, `PROFILE_ENABLED`, `CONFIG_MODE = CREATE_IF_NOT_EXIST`, `APP_LIST = [com.serversherpa.kiosk, *]`, plugins: BARCODE enabled, INTENT enabled with `intent_output_enabled=true`, `intent_action=com.serversherpa.kiosk.SCAN`, `intent_delivery=2` (broadcast), KEYSTROKE `keystroke_output_enabled=false`. `DataWedgeReceiver` (registered in the manifest with `exported=true` for that action, plus a dynamic registration while the app is in the foreground) reads `com.symbol.datawedge.data_string` and `com.symbol.datawedge.label_type` and publishes. Scan screens show a "Scan" soft-trigger button when DataWedge is present (`SOFT_SCAN_TRIGGER START_SCANNING`). The hardware trigger works with no app involvement.
- **Camera.** Shown as a camera icon button beside the input when `PackageManager.hasSystemFeature(FEATURE_CAMERA_ANY)`. Tapping opens `CameraScanSheet` (full screen): CameraX `Preview` + `ImageAnalysis` with the ML Kit `BarcodeScanner` (all formats), back camera, a viewfinder reticle, torch toggle, and a Single / Multi segmented switch (default Single). **Single**: the first decoded value is published and the sheet closes. **Multi**: each decoded value not yet seen in this sheet session is published once (a `LinkedHashSet`), the sheet shows a count and the last few values, and closes on Done. Camera permission is requested on first open; denial shows an inline message with a Settings link. The sheet never publishes the same value twice within one open.

## Navigation and guards

Routes (Navigation Compose): `login`, `home`, `setup`, `settings?tab=`, `scan`, `enroll`, `timeclock`, `containers`, `trucks`, `labels` (the last three → placeholder). Unknown → `home`.

- `KioskGuard`: `Loading` → spinner; `Anon` → `login` (remembering the intended route); `Authed` with `mustChangePassword` → the notice "Your password needs to be changed before you can use a kiosk. Sign in to the portal at {portalUrl} to change it." with Sign out.
- `SetupGate(feature)`: `featureAvailable(feature, setupState, devMode)` else redirect to `home`. `alwaysAvailable` features: setup, settings.
- `settings` is reachable signed out (This Kiosk only); `setup` needs a signed-in person (it stamps a Device row).

`FEATURES` (order and copy from `kiosk/src/lib/features.ts`): setup, scan, enroll, containers, trucks, labels, timeclock, settings.

## Screens

### Shell

`KioskShell(content)`: top bar on `ink` (logo 26 dp, wordmark "Server**Sherpa**" with the accent on Sherpa, chip "KIOSK · ANDROID" in mono, current feature title), the kiosk name as a mono button (→ `settings?tab=this-kiosk`), then registration chip (green Registered / amber Expires soon / red Expired / slate Unregistered), the person's display name (long-press shows "Session ends …"), and Sign out. On narrow widths the top bar wraps to two rows: brand row, then name/chip/person/sign-out row. Footer: one mono line, `·`-separated: Mode Android, Version, then Move / Site / Scan when a selection is saved, Data Sync as one word colored green (`done`) or red (anything else) with the detail on long-press, Dev mode On when on. `ScanFlash` overlays the shell.

### Login

Portrait split: a dark brand band (logo, wordmark, kiosk name in mono) over the paper form. Email + password (`client: "kiosk"`), show/hide password, "Signing in…" while busy, error messages keyed by code: `invalid_credentials`, `account_locked`, `account_disabled`, `totp_required`, `kiosk_not_allowed`, `network`, else "Login failed. Please try again." Empty fields: "Please enter both email and password" and the empty field marked invalid. Below: "Other ways to sign in" → Link with phone and Move password buttons.

- **Link with phone (`PairPanel`).** POST `/kiosk/pair {serial, name}` → show the code large in mono, a QR of `link_url` (zxing), the link URL text, and "Expires in m:ss". Poll `/kiosk/pair/{code}/poll {poll_token}` every 2 s: `approved` → `completePair(session)` and navigate; `denied` → "This request was denied on the phone." with "Try again"; `expired` or 404 → "This code expired." with "New code". Back returns to the password form.
- **Move password.** Placeholder: the field and a notice "Move passwords aren't available yet. Use email & password or link with your phone."
- **Banners.** `/system/status` on open: read-only mode message and broadcast banner rendered above the form.
- A gear icon in the band opens `settings?tab=this-kiosk` signed out.

### Home

Eyebrow "Kiosk", title "What would you like to do?", the setup banner ("Kiosk setup is incomplete. Only Kiosk Setup and Settings are available." / "Kiosk setup failed. Open Kiosk Setup to try again." / dev-mode variant), then a two-column grid of tiles (icon, title, blurb) in `FEATURES` order. Unavailable tiles are dimmed with "Finish Kiosk Setup first." (or the failed wording). Tile icons are vector drawables traced from the web's SVGs.

### Kiosk Setup

`GET /kiosk/setup-options` on open (retry button on failure). Step 1: move cards (name, status chip, client, dates "Sep 3 – Sep 5" / "Starts …" / "Ends …", "source → destination"); step 2: the move's source and destination site cards (role label); step 3: scan-type cards (label with the color swatch). A tap on steps 1–2 advances; the step-3 tap POSTs `/kiosk/setup {serial, initiative_id, site_id, scan_status}`. Success: store the selection, `setupState = complete`, start `runSync` (not awaited), show the summary card (Move, Site (role), Scan type, sync line "Downloading…" / "N assets · N people · N containers · N trucks · synced 2:14 PM" / error code) with Sync again and Change setup. Failure: `setupState = failed`, error line. Cached choices are revalidated against the loaded options exactly as the web does. A step indicator "Step 1 of 3 · Move" sits above the cards; Back returns a step.

### Scanning

Eyebrow "Kiosk · Scanning", subtitle "{move} · {site} · {scan type}". `ScanInput` (placeholder "Scan or type an asset ID, serial, or tag"), camera button and DataWedge soft-trigger where applicable, then a toolbar with counts (Queued n · Sent n · Failed n · No match n) and Retry failed / Clear sent / Discard failed (confirm). `onScan(value)`: `matchScan(index, value)`; matched → flash good, sound good, `enqueue` with `asset` denormalized, `scan_type = scanTypeFor(kind)`, `site_id/initiative_id/scan_status` from the selection; unmatched → flash not-found, sound not_found, `enqueue` with `asset = null`. The list: time (HH:mm:ss), value (RFID displayed zero-stripped), asset (asset_id · name · make/model) or "No match", status pill (accepted green, queued/sending/retrying amber, failed/nomatch red) with `last_error` on failed rows. The roster index is built from Room once and rebuilt when sync finishes or local data is cleared. Empty roster: "No move data on this kiosk. Sync from Kiosk Setup." with the input disabled.

### RFID Enroll

Step one: `ScanInput` "Scan the asset's ID or serial"; `matchAssetOrSerial` only. An RFID value that matches by tag is refused with "That's an RFID tag. Scan the asset's ID or serial first." No match → flash not-found + "No asset found for "…"". Match → flash good and step two: the asset card (asset ID, name, serial, current tag or "No tag") and `ScanInput` "Scan the RFID tag"; under it the live padded preview `000000000000000000100348` or the problem text (`padRfid`). Enter POSTs `/kiosk/assets/{id}/rfid {serial, rfid_tag, scan_status: enroll checkpoint, client_scan_id, site_id, initiative_id}`. Success: flash good, sound good, toast "Tagged {name} · {tag}" (or "already had this tag"), update the local asset row's `rfid`, prepend to the session list (25 max), back to step one. Errors: `rfid_in_use` → "That tag is already on {asset_name}.", `bad_rfid`, `rfid_too_long`, 423 read-only, `network` → "Can't reach the portal. The tag was not saved.", else "Couldn't save the tag ({code})." Cancel returns to step one. Online only; no outbox.

### Timeclock

Entry: `ScanInput` "Scan a badge or type a name". Each keystroke runs the web rule: if `isAmbiguousPrefix` keep typing; else `matchPersonExact` selects immediately; otherwise `searchPeople(index, value, 8)` fills the tappable results (name, worker/account chips, badge tag). Enter: exact → select; one result → select; several → wait; none → flash not-found + "No worker found for "…"". Selected: card with avatar (the presigned URL fetched with OkHttp and decoded to an `ImageBitmap`; no image library; initials fallback on failure), name, "Clocked in for 3h 12m · since 9:02 AM · move · site" or "Not clocked in · Last clock-out 5:10 PM", one button Clock in / Clock out (disabled until status loads), Cancel. Punches POST `/kiosk/timeclock/clock-in {serial, person_id, site_id, initiative_id}` or `/clock-out {serial, person_id}`; success → flash good, sound good, toast "Clocked in — {name}" / "Clocked out — {name} · 3h 12m", back to entry. Errors map as the web: `already_clocked_in` / `not_clocked_in` (refresh status), read-only, `network` → "Can't reach the portal. The punch was not recorded.", else "Couldn't record the punch ({code})." 20 s idle returns to entry; elapsed time ticks every 30 s. No local history.

### Settings

Segmented tab strip (scrollable on narrow screens): Appearance, Sound, Devices, This Kiosk, Admin (admin only), Developer (developer role only); signed out, only This Kiosk. Each tab: title, blurb, `SettingsRow`s.

- **Appearance:** three `HslPicker` rows (hue/saturation/lightness sliders with a swatch and a "Preview" that flashes) and the flash-duration slider.
- **Sound:** for good / not-found / duplicate, a choice row (None + the five built-ins) with a play button; a volume slider.
- **Devices:** read-only rows: DataWedge (present + profile status / not installed), Camera (available / none), Hardware keyboard (attached / none). Informational only.
- **This Kiosk:** Kiosk name (text field, Save, validation), Serial (mono, copy), Mode Android, API URL (text field, Save; must be `http(s)://`), Portal URL, Version. Visible signed out. Saving the name beats the heartbeat immediately when signed in.
- **Admin:** "RFID Enroll checkpoint" chooser fed by `getSetupOptions().scan_types`, stored choice shown even when the fetch fails ("Couldn't load the checkpoint list. The stored choice still applies.").
- **Developer:** Developer mode switch; when on: Kiosk setup state radio (Incomplete / Complete / Failed), Local data counts + Clear local data, Local data inspector (three collapsible lists: assets, people, meta, 200-row cap, filter box).

### Placeholder

Eyebrow "Kiosk · {title}", title, "Coming soon. {blurb}", dashed card "This feature is not available yet.", "Back to home".

## API

No server changes. Endpoints used, all existing on `main`:

| Endpoint | Auth | Used by |
|---|---|---|
| `POST /auth/login` (`client: "kiosk"`), `POST /auth/refresh`, `POST /auth/logout` | cookie | session |
| `GET /system/status` | none | login banners |
| `POST /kiosk/pair`, `POST /kiosk/pair/{code}/poll` | none | link with phone |
| `POST /kiosk/heartbeat`, `POST /kiosk/sign-out` | kiosk:view | heartbeat, logout |
| `GET /kiosk/setup-options`, `POST /kiosk/setup` | kiosk:view | Kiosk Setup, Admin tab |
| `GET /kiosk/sync/assets`, `/people`, `/containers`, `/trucks` | kiosk:view | sync |
| `POST /kiosk/scans` | kiosk:view | outbox |
| `POST /kiosk/assets/{id}/rfid` | kiosk:view | RFID Enroll |
| `GET /kiosk/timeclock/{person_id}`, `POST /kiosk/timeclock/clock-in`, `/clock-out` | kiosk:view | Timeclock |

The dev API (`https://api.dev.serversherpa.com`, Nginx Proxy Manager → 10.10.48.103:8000) is reachable from a device on the office network or the internet. `SS_ALLOWED_ORIGINS` is irrelevant to a native client (no CORS), and the cookie is host-only on `api.dev…`, which the cookie jar honors.

## Security notes

- The refresh cookie is the only secret at rest; it lives in `EncryptedSharedPreferences` (Android Keystore master key). The access token is memory-only.
- `raw_info` is bounded (five keys) and contains no identifiers beyond model strings.
- The DataWedge receiver accepts only its own action and reads only the two documented extras; scan values are data, never parsed as commands.
- The camera is used only while the sheet is open; frames are never stored.
- The API URL setting accepts only `http://` or `https://` origins; a bad value is rejected with an inline message. Cleartext HTTP is allowed (`usesCleartextTraffic=true`) so a LAN dev box works.

## Testing

- **JVM unit tests (`app/src/test`)**: `core/` in full — scan matching (order, zero-stripping, first-row-wins, `matchAssetOrSerial` refusing RFID), people matching (every case in `peopleMatch.test.ts`: name-part prefixes, distinct-part assignment, short id only when hex, ambiguous prefix), RFID padding, outbox transitions (enqueue, batch selection, backoff ladder, rejection, stranded `sending`, nomatch expiry) with an injected clock, `featureAvailable`, settings tab visibility, appearance defaults/migration, `CorePurityTest`.
- **MockWebServer tests**: login stores the session, refresh is single-flight under concurrent calls, 401 → refresh → retry once, second 401 ends the session, cookie persisted and sent, `ApiError` code extraction, network failure → `network`.
- **Robolectric tests**: Room DAOs, `runSync` transaction (a failed fetch leaves tables intact; a success replaces all four + meta), outbox persistence round-trip, DataStore-backed settings, `DataWedge` config bundle shape, heartbeat body.
- **Compose tests (Robolectric)**: login error mapping and empty-field validation, launcher gating by setup state and dev mode, setup wizard advancing and saving, Scanning enqueue path with a fake bus, Timeclock auto-select on an exact badge.
- **Gradle gate**: `./gradlew testDebugUnitTest assembleDebug` clean before any task is called done.
- **Live verification** (implementer, documented in the plan): install the debug APK on the MC2200 (`adb -s 23287523020891 install`) and on the Medium Phone API 36 AVD; sign in against the dev API with a seeded dev login; run Kiosk Setup against a seeded move; scan with the MC2200's trigger (DataWedge path) and with typed values; RFID-enroll a seeded asset; clock a seeded worker in and out; confirm the Kiosk Devices page in the portal shows the device as `android`, Registered, and signed in.

## Out of scope (deliberately)

Containers, Trucks, Label Printing and printer tools, sound uploads, move password, delta or periodic sync, background sending (WorkManager), tile permission gating, Zebra RFID sled / RFD40 support, NFC, density and text-size preferences, tablet layouts, the iOS app, Play Store packaging and signing.

## Implementation notes (2026-09-15)

- The 401 → refresh → retry rule lives in `OkHttpKioskApi.authed()` rather than an OkHttp interceptor (`AuthInterceptor.kt` in the file list was not created); same behavior as `apiFetch` in the web kiosk, simpler to test with MockWebServer.
- `DataWedgeReceiver` is registered dynamically in `MainActivity.onStart/onStop` only — DataWedge's broadcast is implicit, so a manifest receiver would not receive it on Android 8+.
- The scaffold's generated library versions (core 1.19.0, lifecycle 2.11.0, activity-compose 1.13.0) required compileSdk 37 / AGP 9.1 and were pinned down (1.16.0 / 2.9.2 / 1.10.1) to keep compileSdk 36 on the installed SDK.
- Fonts are the Google Fonts variable TTFs (Geologica variable, Fragment Mono regular + italic); `Font(variationSettings=…)` needs `@OptIn(ExperimentalTextApi::class)` on this Compose version.
- Sound uploads, the container/truck checkpoint rows, and the label vocabulary endpoint are not wired (out of scope).
- ViewModels use `viewModelScope` (constructor `scopeOverride: CoroutineScope? = null`); nothing screen-scoped is launched on `AppContainer.scope`.
- Scan screens collect `ScanBus.events` in a screen-level `LaunchedEffect`, never in a ViewModel `init`, so a scan cannot land on a screen that is not on top; every outbox/Room write from a ViewModel surfaces a `storageError`/error line instead of throwing.
- The outbox rethrows `CancellationException`, persists a batch's outcome under `NonCancellable`, and runs `recoverStranded` on every `start()` (a background/foreground cycle mid-POST resends the batch; ingest is idempotent).
- `EncryptedSharedPreferences` is created lazily on first cookie use, not in `Application.onCreate`.
- DataStore keys for the API/portal URL are `ss.kiosk.apiUrl` / `ss.kiosk.portalUrl` (the spec was aligned).
- `installForegroundRefresh` was not implemented: `tokenIsStale()` on the next authenticated call covers it.
- Scanning placeholder copy is "Scan or type an asset ID, serial, or tag" (web: "Scan or type a serial, asset ID, or RFID") — sanctioned by the spec.
- The Robolectric test config sets `application=android.app.Application` so tests never build the real `KioskApplication`; `testContainer()` injects a per-test DataStore and a `MemorySecretStore`.
- Deferred to the next pass: clearing the refresh cookie of a PREVIOUS API host when the URL changes (needs `SecretStore` key enumeration); Compose tests for the screen-level bus collection; a Room migration strategy; background sending (WorkManager); `KioskGuard` does not remember the intended route; the camera reticle is unstyled.
