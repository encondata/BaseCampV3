# Android in-app update check (Devices) — design

Short design for the Android half of the in-app update check. The approved
parent spec is `2026-11-17-devices-app-design.md` (sections "Android" and
"In-app update check"); this file records how the Android app does it.

## Intent

Crew phones that installed the kiosk app from devices.<env> should learn
about a newer build without anyone visiting the site, and install it in two
taps. A Play-installed copy can't take our upload-key APK, so it is told to
reinstall once instead of being offered an update that would fail.

## Goals

- Two product flavors, `play` (today's build) and `direct` (updater), one
  versionCode sequence, same package `com.serversherpa.kiosk`.
- The `direct` app asks `GET <devices>/api/updates` at launch, on return to
  the front after a while, and from a visible **Check for updates** button.
- Home banner "Update available — <version>" with **Update** and **Later**;
  the same in Settings › This Kiosk with the release notes.
- **Update** downloads the APK into app storage with progress and hands it to
  the system installer through `PackageInstaller`, sending the person to
  "Allow from this source" the first time.
- `reinstall_required` (and any other answer that carries a message) shows the
  message instead of an Update button.

## Non-goals / anti-goals

- No updater code or `REQUEST_INSTALL_PACKAGES` in the `play` build (Play
  policy forbids self-updates and restricts the permission).
- Never signs the kiosk out because the devices service answered 401.
- Never installs something that isn't our package at the offered build.
- Never changes device settings itself (it only opens the system page).
- No iOS, portal or devices-service changes.

## Approaches

1. **Product flavors, updater only in `src/direct` (picked).** Shared code
   holds an `AppUpdates` interface, the state type and the UI; `src/play`
   supplies a no-op, `src/direct` the real client, downloader and installer
   plus the manifest additions. The Play binary carries no install code.
2. Flavors with all code in `main`, gated by a BuildConfig flag. Simpler
   tests, but the Play build would still contain PackageInstaller code.
3. A `direct` build type instead of a flavor. Keeps `testDebugUnitTest`
   working, but departs from the spec and gives no direct debug build.

## Design

- **Gradle:** `flavorDimensions += "distribution"`; `play` (default) and
  `direct`. Task names become `testPlayDebugUnitTest`,
  `testDirectDebugUnitTest`, `assemblePlayDebug`, `bundlePlayRelease`,
  `assembleDirectRelease`; `assembleDebug` still builds both. README updated.
- **core/update (pure Kotlin):** the update answer model, `devicesUrlFor(api)`
  (`api.<rest>` → `devices.<rest>`, same scheme and port; any other host has
  no devices service and the check says so), the foreground re-check rule.
- **data/update (main):** `AppUpdates` interface (`supported`,
  `state: StateFlow<UpdateState>`, `check()`, `update()`, `later()`,
  `homeBannerVisible`), `NoAppUpdates` used by `play`.
- **src/direct:** `DevicesUpdateClient` (OkHttp GET with the kiosk bearer;
  refreshes once on 401 through `SessionStore`, never ends the session),
  `SigningDigest` (SHA-256 hex of `signingInfo.apkContentsSigners[0]`),
  `ApkDownloader` (streams to `filesDir/updates/`, only from the devices host
  over the same scheme, no bearer — the link's token is the credential),
  `ApkInstaller` (`PackageInstaller` session, commit with a mutable
  PendingIntent to a non-exported `UpdateInstallReceiver`, which launches the
  system confirm screen on `STATUS_PENDING_USER_ACTION`), `DirectAppUpdates`
  (the state machine and triggers).
- **Triggers:** while signed in with a kiosk session and in the foreground:
  once per process start, then on each return to the front when the last
  check is at least an hour old *(my call on the interval)*. The button
  always checks.
- **Later** hides the Home banner for that build until the app is next
  started; Settings still shows it *(my call)*.
- **Permission:** if `canRequestPackageInstalls()` is false, Update opens
  `ACTION_MANAGE_UNKNOWN_APP_SOURCES` for our package and remembers the
  request; back in the app with the permission on, the download starts by
  itself; still off, the banner says installs from this app are off.
- **Checks on the file:** after download, `getPackageArchiveInfo` must show
  our package and the offered build; otherwise it's deleted and reported.
  Old files in `updates/` are removed at start.
- **Settings › This Kiosk:** the Version row grows an "App updates" row:
  status ("Up to date · checked 14:05", 24-hour), the offered version, notes
  and size, Update, progress, and **Check for updates** (disabled with a hint
  while signed out). The `play` build shows none of it.

## Left to the builder

Class names, exact copy, the progress UI, error wording.
