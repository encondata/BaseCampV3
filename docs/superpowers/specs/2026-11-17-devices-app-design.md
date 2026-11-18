# Devices app: app distribution for crew devices — design

Date: 2026-11-17. Status: draft for Jimmy's review.

## Intent

Our crew's phones and handhelds need our own apps (the kiosk app first, more
later) without going through Google Play or the App Store. The Devices app is
a new web app at **devices.dev.serversherpa.com** (later `devices.<env>` on
every stack). Supervisors and admins sign in with the standard ServerSherpa
login, then install Android apps as APKs and iOS apps as Ad Hoc `.ipa` files
over the air. The kiosk apps also check it for updates and offer them in-app.

Who uses it: supervisors and admins with existing portal accounts, setting up
crew devices that we own. Crew workers do not sign in to it.

## Goals

- One sign-in page, the same one the portal, wiki and learn apps use.
- An app catalog: each app (per platform) with its current version, release
  notes, previous versions, and an **Install** button.
- Admins upload a new version by dragging in an APK or IPA. The app's name,
  package/bundle ID, version and build number are read from the file.
- iOS, fully automatic: a new iPhone is registered with Apple, the Ad Hoc
  profile is regenerated, and every iOS app is re-signed for it on the server,
  so the phone can install within minutes without anyone touching the Mac.
- In-app update check in the Android and iOS kiosk apps, in this build.

## Non-goals

- Customer devices, or crew workers signing in.
- Device management (remote wipe, lock, policies). This is app distribution
  only.
- Publishing to Google Play, the App Store or TestFlight. Play internal
  testing stays as it is.
- Apple Enterprise distribution. We use Ad Hoc on the paid Apple Developer
  Program.
- Silent updates. A person always confirms an install (Android cannot install
  silently without device-owner mode, and iOS never can).
- A Sirdar app-list entry for Devices (follow-up).

## Anti-goals (would make it a failure even if it "works")

- An install that fails with no explanation. Every failure the site can know
  about (iPhone not registered yet, signing still running, Apple refused the
  device, Android signature mismatch) is shown in plain words before the person
  taps Install.
- The Apple certificate, its password or the App Store Connect key ever being
  downloadable or shown again after upload, or leaving the devices service.
- Anyone with a client or learning role seeing the app.
- An Android update that the phone will reject because it is signed with a
  different key than the installed copy.

## Constraints

- **Apple Ad Hoc rules.** An iPhone can only install an Ad Hoc build whose
  provisioning profile lists its UDID. Apple allows 100 registered devices per
  device type (iPhone, iPad…) per membership year; disabling a device does
  not free its slot until the membership renews. Ad Hoc profiles cannot be
  edited, only deleted and created again with the new device list.
- **Paid Apple account.** Jimmy will get the paid Apple Developer Program.
  Until then the iOS half cannot be tested end to end against Apple (today
  this Mac has only an Apple Development certificate, team `Y2QYBG96U4`,
  bundle `Server-Sherpas.ServerSherpa-Kiosk`).
- **UDID collection.** The only way a website can learn an iPhone's UDID is an
  over-the-air profile (a `.mobileconfig` with a Profile Service payload) that
  the person installs in Settings. That step cannot be skipped.
- **OTA install needs HTTPS** and an `itms-services://` link to a manifest
  plist. iOS downloads the manifest and IPA without the browser's cookies or
  tokens, so those URLs carry their own short-lived signed token.
- **Android signing.** A phone only accepts an update signed with the same key
  as the installed copy. Play-installed copies carry Google's app-signing key;
  our builds carry our upload key (`~/.android-keys/serversherpa-kiosk-upload.jks`).
- **Production runs Linux containers.** iOS re-signing must work on Linux
  (no `codesign`).
- House rules that apply to every screen: follows light/dark (never forced),
  24-hour HH:MM times, American English, the report-generate modal header,
  rounded modal corners, action buttons never below a scroll, no default
  scrollbars, the standard Actions ▾ menu for row actions, every bulk or
  destructive action shows a review summary first. No reader-facing widgets
  beyond what this doc lists.

## Approaches considered

- **A. Same pattern as wiki/learn:** a `devices/` web app on the portal's
  sign-in, with data and endpoints in the main API, signing on the main
  API's worker. Least new plumbing, but the Apple keys would sit in the main
  database.
- **B. A separate service with its own backend, database, storage and worker
  (chosen by Jimmy).** The Apple certificate and key never live in the main
  API. It costs a sign-in bridge to the main API, its own deploy stack, and a
  second server for the kiosk apps to talk to. The bridge already has a
  precedent: the wiki's live-editing server passes the user's bearer token to
  the main API's `/internal/collab/authorize` with a shared service token.
- **C. An off-the-shelf OTA site.** Rejected: none combine our sign-in and
  permission matrix, automatic Apple registration and the kiosk update check,
  so most of the glue would be ours anyway.

## Design

### Pieces

| Piece | What it is |
|---|---|
| `devices/api` | New Python FastAPI service, own package (e.g. `serversherpa_devices`), own Alembic migrations. |
| `devices/worker` | Same package, a worker process: Apple calls, profile regeneration, IPA re-signing, upload parsing. |
| Devices database | Its own Postgres database on the same Postgres server (`db` stack), e.g. `serversherpa_devices`. |
| Devices bucket | Its own bucket on SeaweedFS (or DigitalOcean Spaces on droplets) for APKs, original IPAs, signed IPAs, icons. |
| `devices/web` | New Vite/React app, built like `learn/`: the portal's `LoginScene` sign-in and `NavPanel` shell via `@portal` imports, with the usual portalImports/dedupe guard test. |
| Main API changes | A new permission resource, an internal authorize endpoint, an audit write endpoint, and `devices` in `SS_APPS`. |
| Portal changes | A **Devices** link in the Apps nav section (external href, hidden when `devices` is not in `SS_APPS`), like Wiki and Learning. |
| Kiosk app changes | Android and iOS update check, banner and installer hand-off. |

### Sign-in and permissions

- The browser signs in exactly as on the portal (`client=portal`, the
  `ss_portal_refresh` cookie on the API host), so a portal session carries
  over and signing out anywhere signs out here. 2FA, password expiry,
  remembered browsers, read-only mode and the broadcast banner behave as on
  the portal.
- The web app sends its main-API access token to the devices API. The devices
  API calls a new main-API route, `GET /internal/devices/authorize`, with the
  caller's bearer token plus `X-Devices-Service-Token`
  (`SS_DEVICES_SERVICE_TOKEN` on both sides). The main API validates the
  session the same way `deps.py` does (revoked, expired, forced password
  change, session scope) and returns: person id, display name, client
  (`portal` or `kiosk`), the person's `app_distribution` actions, and for a
  kiosk session the kiosk device id. The devices API may cache an answer
  briefly, keyed by a hash of the token (builder's call on the time, short
  enough that a revoked session stops working within a minute).
- **New permission resource `app_distribution`** (shown as "Apps" in Access),
  added to the matrix by a main-API migration and to `access/defaults.py`:

  | Role | Actions | Meaning |
  |---|---|---|
  | developer, founder, super admin, admin | view, add, change, delete | everything below |
  | staff | view | sign in, add a device, install |
  | client and learning roles | none | no access |

  - **view:** sign in, see apps, add an iPhone, install.
  - **add / change:** upload versions, edit release notes, set the current
    version, manage Apple settings.
  - **delete:** remove versions, disable registered devices.

  The matrix stays editable in Access like every other resource. A signed-in
  person without `view` sees a "You don't have access to Devices" page with a
  Back to portal link.
- **Audit:** every upload, current-version change, delete, device add/disable
  and Apple-settings change is written to the main API's existing audit log
  through a service-token internal endpoint, so it shows in the portal's
  audit view. No new audit page.

### Pages

```
Apps                                          [Upload]   ← add
┌─────────────────────────────────────────────────┐
│ ServerSherpa Kiosk · Android     0.1.1 (2)         │
│ Uploaded 2026-11-09 by J. Henderson      [Install] │
│ What's new: QR label changes                       │
│ ▸ Previous versions                               │
├─────────────────────────────────────────────────┤
│ ServerSherpa Kiosk · iOS         1.0 (5)           │
│ This iPhone isn't registered    [Add this iPhone]  │
└─────────────────────────────────────────────────┘
```

- **Apps** (home): one card per app and platform. The Install button reflects
  the viewing device: on an Android phone it installs the APK; on an iPhone
  it is **Add this iPhone** until the phone is registered, then **Preparing…**
  while signing runs, then **Install**. On a desktop it shows the version info
  and a QR code that opens the same page on a phone (installs only happen on
  the phone). Previous versions expand into a standard list with their own
  Install buttons and, for `change`, Actions ▾ → Make current / Edit notes /
  Delete.
- **App detail:** name, platform, package/bundle ID, all versions as a
  standard list (version, build, uploaded by, date, size, notes, current).
- **Upload** (modal, `add`): drag in an APK or IPA. The site parses it and
  shows a review summary (app, new or existing, version, build, signing
  certificate) before saving, and an optional release-notes field. A file
  for a package/bundle ID it has not seen creates a new app.
  - Rejected with a plain reason: the same version/build already uploaded;
    an Android APK whose signing certificate differs from the app's earlier
    versions; an IPA whose bundle ID can't be provisioned on our Apple team.
  - Files upload straight to the bucket through a presigned URL (the kiosk AAB
    is ~23 MB; APKs/IPAs are similar).
- **Devices** (`view` to see, `delete` to disable): registered iPhones/iPads
  as a standard list — name, model, iOS version, added by, date, Apple status
  (pending, registered, failed with reason, disabled). Above it, Apple's count
  per device type, e.g. "iPhone 7 of 100 this membership year". Disabling
  shows a review that says the slot is not freed until the membership renews.
- **Apple settings** (`change`): upload the Apple Distribution certificate
  (`.p12` + password) and the App Store Connect API key (`.p8`, key ID, issuer
  ID), plus the team ID. After saving, only the certificate's name, expiry
  and the key ID are shown. Replace, never download. A banner on Apps warns
  admins 30 days before the certificate or a profile expires.

### iOS: adding an iPhone

1. On the iPhone, signed in, the person taps **Add this iPhone**. The site
   creates a one-time enroll token tied to that person and serves
   `/enroll/<token>.mobileconfig` (Profile Service payload asking for UDID,
   PRODUCT, VERSION, SERIAL, DEVICE_NAME).
2. iOS asks them to open Settings and install it. iOS then POSTs the signed
   device attributes to `/enroll/<token>/callback`; the devices API parses
   them, records the device as *pending*, and redirects Safari back to the
   Apps page. The profile is temporary and removes itself.
3. A worker job registers the UDID with Apple (App Store Connect API
   `POST /v1/devices`), then for each iOS app deletes its Ad Hoc profile and
   creates a new one with every enabled device, and re-signs the current
   version of each iOS app with the new profile and the distribution
   certificate. Older versions are re-signed on demand when someone taps
   their Install.
4. The page polls and switches to **Install** when the signed IPA is ready.
   Install opens `itms-services://?action=download-manifest&url=…`; the
   manifest and IPA URLs carry a short-lived signed token.

Re-signing runs on Linux with an open-source signer (`rcodesign` from
apple-codesign is the expected choice; `zsign` is the fallback). Uploading a
new iOS version also signs it with the current profile straight away, so
every registered phone can install it immediately.

If an iPhone already holds a dev-signed copy from Xcode, it still has to be
added once before it can install or update from the site.

**Missing App IDs** *(my call)*: when the first IPA for a new bundle ID is
uploaded, the worker registers that bundle ID with Apple if it is missing (no
extra capabilities). An IPA whose entitlements need a capability the App ID
lacks is rejected at upload with the capability named.

### Android

- Install serves the APK with `application/vnd.android.package-archive`
  through a short-lived signed link. The first time, Android asks the person
  to allow installs from the browser.
- The site serves builds signed with our upload key. A phone that got the app
  from Play internal testing needs one uninstall and reinstall from the site;
  updates work from then on. A web page cannot see what is installed, so the
  Android card always carries a short note: "Got it from Google Play? Uninstall
  it first." The in-app check is where a Play copy is detected precisely
  *(my call)*.
- **Two Android build variants** *(my call)*: Google Play restricts the
  `REQUEST_INSTALL_PACKAGES` permission, so the Android app gets a `play`
  flavor (today's build, no updater, no permission) and a `direct` flavor
  (updater + permission) that is the one uploaded to Devices. Both share one
  versionCode sequence.

### In-app update check (kiosk apps)

- The kiosk apps call the devices service,
  `GET /api/updates?platform=&package=&version_code=&signing_digest=`, with
  their kiosk bearer token (authorized through the same internal endpoint;
  any valid kiosk session may check and install updates to the kiosk app,
  independent of `app_distribution`, since it only updates the app already
  on the device).
- It answers with the current version if it is newer than the installed one,
  and the install URL. It never offers a lower version (a rollback only
  changes what new installs get), and on Android never offers an APK whose
  signing digest differs from the installed copy's (Play installs get a
  "reinstall from devices.<env>" note instead of a broken update).
- When it checks: at launch, again when the app returns to the foreground
  after a while (builder's call on the interval), and a visible **Check for
  updates** button in Settings (every automatic behavior has a visible
  control).
- What it shows: an **Update available — 0.1.2** banner on Home with
  **Update** and **Later**, and the same in Settings with the release notes.
  - **Android:** downloads the APK into app storage with progress, then hands
    it to the system installer through `PackageInstaller`. Needs the
    `REQUEST_INSTALL_PACKAGES` permission; the first time, Android sends the
    person to allow it for the kiosk app.
  - **iOS:** opens the `itms-services://` link; iOS installs over the running
    app after confirming. An app cannot read its UDID, so the app reads its
    own `embedded.mobileprovision` *(my call)*: an Ad Hoc profile means this
    phone was registered when the build was signed, so updates are offered; a
    development profile (Xcode install) or none shows "Add this iPhone on
    devices.<env> first" instead of an Update button. (A phone disabled on
    the site after its build was signed is the one case this misses; the
    Devices page shows it as disabled.)
- Android and iOS app changes are separate platform work in their own apps
  (`Android_Kiosk_App/`, `IOS_Kiosk_App/`) and need the devices API deployed
  first.

### One stack owns the Apple side

All stacks share one Apple team, and each stack has its own Devices database,
so two stacks rebuilding the same Ad Hoc profile would wipe out each other's
iPhones. **Exactly one stack owns iOS** (Jimmy's decision): the one whose
Apple settings are filled in. Dev owns it now; production takes over later by
entering the Apple settings there and clearing them on dev.

- On any other stack, iOS cards say "iPhone installs are set up on
  devices.<owner env>" and IPA uploads are refused with the same reason.
  Android works on every stack.
- The Apple settings page says, above the form, that only one environment may
  hold these settings.
- Profiles the worker creates carry a fixed name per bundle ID
  ("ServerSherpa Devices · <bundle id>"); it only ever deletes profiles with
  that name, never ones made in Xcode or by hand.
- The kiosk apps check the devices service next to the API they are pointed
  at (`api.<env>` → `devices.<env>`) *(my call)*, so a kiosk on dev gets dev's
  catalog.

### Secrets

- The `.p12`, its password and the `.p8` are encrypted at rest in the devices
  database with a key from `DEVICES_SECRET_KEY` (env only, never in the DB).
  Only the worker decrypts them, in memory, for an Apple call or a signing
  run. No endpoint returns them.

### Deploy and dev

- New `deploy/stack/devices` compose stack (api, worker, web), joined to
  `ss-<env>`, `devices` added to `STACK_APPS`/`SS_APPS`, a Caddy route for
  droplets, and env keys in `env.example`: `SS_DEVICES_SERVICE_TOKEN`,
  `DEVICES_SECRET_KEY`, the devices database URL, bucket settings,
  `SS_DEVICES_ORIGIN`. The devices origin goes in `SS_ALLOWED_ORIGINS`;
  bucket CORS allows the devices origin for presigned PUT/GET.
- `ss-stack` creates the devices database on first run, like it handles the
  main one.
- Dev: `.claude/launch.json` entries for devices api/worker/web on free ports
  (builder picks; avoid 5173–5179, 8000, 8090–8098). Jimmy adds the NPM proxy
  host `devices.dev.serversherpa.com`. Dev previews bind 0.0.0.0.
- Tests: the Apple API is faked in tests (no real Apple calls); re-signing is
  tested with a self-made test certificate and profile.

## Decided by Jimmy

- Crew-owned devices only; Ad Hoc on a paid Apple account (he'll get it).
- Fully automatic iPhone registration and re-signing on the server.
- Only supervisors and admins with existing accounts sign in.
- Staff install; admins and above upload and delete.
- Include the in-app update check in this build.
- A separate service (approach B).
- One stack owns the Apple side (dev now, production later).
- The paid membership upgrades the current team `Y2QYBG96U4`; the bundle ID
  `Server-Sherpas.ServerSherpa-Kiosk` stays, so existing installs and saved
  sign-in data carry over.

## My calls (Jimmy to check)

- A catalog of apps, not just the kiosk app; new apps appear by uploading.
- Upload happens on the site (drag in), metadata read from the file; no Mac
  build-script upload in this build.
- Every version kept; admins can make an older one current; in-app updates
  never downgrade.
- Apple certificate and key uploaded once on an Apple settings page,
  encrypted, never downloadable.
- Builds served with our upload key; Play-installed phones reinstall once.
- Any kiosk session can check for and install kiosk-app updates.
- Audit goes to the main API's existing audit log.
- The 30-day expiry warning for the certificate and profiles.
- Android gets a `play` flavor (no updater) and a `direct` flavor (with the
  updater) that is uploaded to Devices.
- The Android web card always shows the "Got it from Google Play? Uninstall it
  first" note; precise Play detection happens in the app.
- The iOS app reads its own provisioning profile to decide between Update and
  "Add this iPhone first".
- The server registers a missing bundle ID with Apple on first upload.
- Kiosk apps check the devices service next to their API.

## Left to the builder

Table and column names, ports, the signing library, the authorize cache time,
token lifetimes for install links, the update-check interval, APK/IPA parsing
libraries, and how the worker queues jobs.

## Needs from Jimmy before iOS can be tested end to end

- The paid Apple Developer Program membership.
- An Apple Distribution certificate (`.p12`) and an App Store Connect API key
  with a role that can manage devices and profiles.
- The NPM proxy host `devices.dev.serversherpa.com`.
