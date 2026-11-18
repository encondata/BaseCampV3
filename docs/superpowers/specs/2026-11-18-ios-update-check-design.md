# iOS kiosk: Devices update check (design)

Short design for the iOS half of the "In-app update check" in
`2026-11-17-devices-app-design.md`. iOS app only (`IOS_Kiosk_App/`); the
devices service, Android and the portal are untouched.

## Intent

Crew iPhones that installed the kiosk app from devices.<env> should learn
about a newer build without anyone visiting the site, and install it with one
tap. A phone that can't take the update (installed from Xcode, TestFlight or
the App Store) is told what to do instead of being offered a link that fails.

## Goals / non-goals / anti-goals

- Goals: check at launch, on return to the foreground after a while, and from
  a visible **Check for updates** button; a Home banner and a Settings row with
  release notes; Update opens the `itms-services://` link.
- Non-goals: silent installs, downloading the IPA in the app, Android.
- Anti-goals: an Update button that leads to a failed install (only Ad Hoc
  builds get one); an update check that signs the kiosk out (a devices 401
  never ends the kiosk session); a check that never says why it failed.

## The contract (fixed by the devices service)

`GET <devices>/api/updates?platform=ios&bundle_id=<id>&build=<CFBundleVersion>&profile_kind=adhoc|development|none`
with the kiosk bearer token. Answer (`response_model_exclude_none`):
`status` ∈ up_to_date | available | register_first | preparing | not_set_up
(reinstall_required is Android only) plus optional `version_name`, `build`,
`notes`, `size`, `install_url`, `message`.

## Approaches considered

1. **Read the app's own `embedded.mobileprovision`** (spec's choice): the plist
   inside the CMS wrapper says Ad Hoc (ProvisionedDevices, get-task-allow
   false), development (get-task-allow true) or no file (App Store/TestFlight).
   Picked: it's the only signal an app has about how it was signed.
2. Ask the server with the device's UDID: impossible, iOS hides the UDID.
3. Always send `none` and let the site decide: never offers an update. Rejected.

How the plist is read: iOS has no public CMS decoder (CMSDecoder is macOS
only), so the reader finds the `<?xml … </plist>` bytes in the DER file and
parses them with PropertyListSerialization (the standard approach; the plist
is stored unencrypted in the CMS content). *(my call)*

## Design (my calls marked)

- **Core (pure Foundation, tested):**
  - `ProfileKind` + `profileKind(fromMobileprovision: Data?)`: nil → none;
    unreadable → none *(my call: never offer an update on a guess)*;
    `Entitlements.get-task-allow` true → development; a non-empty
    `ProvisionedDevices` with get-task-allow false → adhoc; anything else
    (enterprise `ProvisionsAllDevices`, a store profile) → none.
  - `devicesBaseUrl(apiUrl:)`: the API URL's first host label `api` becomes
    `devices` (`https://api.dev.serversherpa.com` →
    `https://devices.dev.serversherpa.com`), scheme and port kept; any other
    host (localhost, an IP) → nil, and Settings says the address can't be
    worked out *(my call)*.
  - `UpdateAnswer` (decoded) and a pure `UpdateOffer` mapping: `available`
    with an `itms-services` URL and an Ad Hoc profile → offer with Update;
    `available` without Ad Hoc, or `register_first` → "Add this iPhone on
    devices.<env> first" (the server's message when it sends one); preparing /
    not_set_up → the server's message, Settings only; up_to_date → "Up to
    date". Only `itms-services://` URLs are ever opened *(my call)*.
- **Data:** `URLSessionDevicesApi` on the app's one URLSession (the redirect
  guard), the access token from `SessionStore` (refresh first when stale), one
  request, no refresh-and-retry and **no session end on 401** *(my call)*.
  `UpdateChecker` (@MainActor @Observable, in `AppContainer`): state, last
  checked time, single-flight, `Later` hides the Home banner for that build
  until the next launch (Settings still shows it) *(my call)*.
- **When:** after launch once signed in (and on each sign-in), on becoming
  active when the last check is over 6 hours old *(my call on the interval)*,
  and from Settings › This Kiosk › **Check for updates** (always runs; disabled
  signed out with "Sign in to check for updates").
- **UI:** Home: a card under the page header, "Update available — 1.2.0" with
  Update (primary) and Later, or the register-first line with Later. Settings ›
  This Kiosk: an "App updates" row under Version with the installed version and
  build, the result, release notes and size, Update when offered, the Check
  for updates button and "Last checked 14:05" (24-hour). Theme palette only;
  buttons are plain on-screen rows, never behind a scroll inside a sheet.
- **Simulator check:** no devices service is reachable from the simulator
  today (devices.dev has no DNS yet), so DEBUG builds accept
  `-uiTestUpdate available|register_first|preparing|up_to_date` to show a
  sample answer, as `-uiTestEnrollOffer` does. *(my call)*

## Left to the builder

File names, view composition, copy polish within the lines above.
