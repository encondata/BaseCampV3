# iOS kiosk app: parity with Android — design

Date: 2026-11-17 · Owner: Jimmy Henderson · Status: approved

## Intent

Jimmy's request: "bring the ios app to parity with the android. make sure to leave out the rfid sled/handheld code or anything with the zebra sdk."

The gap analysis compared the two apps on main `28f180ee4`. It lives in `docs/superpowers/research/2026-11-17-ios-parity/`:
- `GAP-LIST.md` is the consolidated table. Its gap numbers (#1–#18) are used below.
- Four area reports carry file-level detail: `home-apps.md`, `settings.md`, `signin-setup-stations.md` and `data-sync-api.md`.

The Android app is the reference implementation for every item here: same behavior, rules, error codes and copy, unless this document says otherwise.

## Jimmy's decisions (2026-11-17)

1. **Batches.** Build batches 1–4 in the order below, and install on the iPad after each batch.
2. **Kiosk name.** Add the kiosk's name to the iOS sign-in page (#17), as Android shows it.
3. **No Internet Test.** Skip it (#18): iPads already have Apple's Network Link Conditioner.
4. **Exclusions.** Leave out everything about the RFID sled, handhelds, DataWedge and the Zebra SDKs. `GAP-LIST.md` › "Excluded on purpose" lists these items; none of them is ported.
5. **On hold.** Containers and trucks stay on hold (decided 2026-10-22).

## Scope

### Batch 1: heartbeat and station key

- **#1 Portal Clear Setup.** Port Android's behavior. Use the old unmerged branch `ios-clear-setup` (head `351256c4a`) as a guide only: main has since changed the same files, so port by hand and never merge that branch.
  - When the heartbeat answers `clear_setup` while someone is signed in, the app drops its setup selection and any Time Clock station key.
  - Whoever is signed in lands on Kiosk Setup from any screen, with the banner "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue."
  - A wizard that is already open restarts at step 1.
  - The app acknowledges with `setup_cleared` on the following beats until the server stops asking.
  - **Rules learned on that branch, all of which hold:**
    - The ack settles only on the beat that carried it.
    - The redirect fires once.
    - A beat answered after the heartbeat stops never applies a clear.
    - The redirect happens only while signed in.
    - A clear never reaches a different person's session.
  - The server side already exists. See `docs/superpowers/specs/2026-10-01-kiosk-clear-setup-design.md` and the Android code listed in `GAP-LIST.md` #1.
- **#2 Time Clock tile fetches a missing station key.**
  - When a Time Clock station's Home tile is tapped without a key, it issues one under the signed-in session first. That includes one sign-in beat, and a retry on `not_signed_in_here`.
  - Only then does it sign out to Welcome. The tile is disabled while this runs.
  - On failure the person stays signed in and sees one of three red messages (network, `move_locked`, other), with the copy taken from Android.
- **#3 Sign-in method remembered.** The sign-in method (password, link or biometric) is persisted under `ss.kiosk.signInMethod`, so a restored session reports the right method on its sign-in beat. When the method is unknown, the beat sends none rather than guessing "password".

### Batch 2: quick wins

- **#4 RFID Enroll refuses non-tags.** At the tag step, an asset ID or serial is refused with Android's messages (`checkEnrollRaw`) and is never padded into a tag. Only the non-sled logic is ported.
- **#5 Rolodex Previous jobs card.** Ported from Android `WorkerJobs.kt`. The server already sends `jobs` and `jobs_total`.
- **#6 Rolodex photo view.** Tapping the worker's photo, not its camera badge, shows the photo full screen, scaled to fit. Close, a tap or Back dismisses it. With initials only, a tap does nothing.
- **#7 Rolodex Employee ID.** Remove it from the worker page; it stays on the Time Clock confirm card.
- **Rolodex offline wording.** Use one line for the offline Contact card on both platforms: "Phone and email need a connection.", Android's wording. *My call.*
- **#8 Move password QR button.**
  - The Move password field gets a QR button that opens the camera in QR-only mode.
  - The first code read fills the field and signs in; an error lands on the field's error line.
  - The camera sheet gains a QR-only mode, and Single and Multi modes are unchanged.
- **#17 Kiosk name on the sign-in page.** The kiosk's own name shows under the ServerSherpa wordmark, as Android's `LoginBrand(kioskName)` does, in a style that fits the existing iOS sign-in layout.

### Batch 3: Asset Lookup (#9)

- A new Home app called "Asset Lookup", with the blurb "Scan an asset to see what it is and where it goes."
- **Placement.** It follows iOS's Home rule, so it is hidden until Kiosk Setup is done. It sits where Android places it in the feature order.
- **Behavior.** It matches `docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md` and `2026-11-10-android-asset-lookup-design.md`, leaving out every sled piece:
  - search by asset tag, serial, RFID or name, by typing, a keyboard scanner or the camera;
  - one match opens a card;
  - several matches show a list of up to 25 with "Matched on";
  - no match reads "No asset matches X.";
  - everyone sees the identity and the routes;
  - admins also see the status chip, the current location and moves;
  - `scans:view` adds the latest 50 scans;
  - offline it searches the synced move, with "Offline — showing this move's devices only.", and scan history reads "needs a connection";
  - it is read-only.
- **Server.** The routes already exist (`GET /kiosk/assets/lookup`, `/kiosk/assets/{id}`, `/kiosk/assets/{id}/scans`).
- **iPad layout.** Use the room on iPad the way Scanning does. Buttons are never hidden behind a scroll (Jimmy's rule).

### Batch 4: Troubleshooting hardening (#10–#16)

- **Masking (#10–#12).**
  - **#10** Mask secrets in the shared report and log, ported with Android's redaction cases.
  - **#11** Mask the printer's `~HS` front-panel password on screen and in the report.
  - **#12** Show other people's Bluetooth devices as "Other device · -NN dBm" in the report and log.
- **Behavior (#13–#16).**
  - **#13** A typed `^XA` format with no `^H` or `~H` query goes out on the label send path, under the printer guard's rules.
  - **#14** A Printer Setup button appears when no printer is saved.
  - **#15** The report is built off the main thread, with "Preparing the report…" after 400 ms, a failure message, and a "Report copied." toast.
  - **#16** A Bluetooth scan that was refused restarts once Bluetooth is ready. A scan the system ends early says so.

## Constraints

- **Layering.** `Core/` imports Foundation only. LocalAuthentication, DeviceCheck, Security, CryptoKit and UIKit code lives in `Data/`.
- **Appearance.**
  - Every screen follows light and dark mode; never force a theme.
  - Modals have rounded corners.
  - Sheet and modal buttons are never only reachable by scrolling.
- **Language.** American English throughout. Copy is Android's unless this document fixes other wording.
- **Do not regress** anything iOS has that Android lacks. `GAP-LIST.md` › "iOS has, Android lacks" lists these, for example Home hiding apps until setup is done, and no Face ID prompt after Sign out.
- **Server.** No server changes are expected, because every route exists. If one turns out to be needed, report it rather than changing the API without saying so.
- **Installs** on the iPad are Debug builds, so they reach the dev API. Chain them as build `&&` install.

## Non-goals

- Every sled, handheld, DataWedge or Zebra SDK item.
- Internet Test.
- Containers and trucks.
- Portal-pushed kiosk settings (the heartbeat `config` fields), which neither app has.
- Porting iOS-only things to Android. That is the Android session's job; `GAP-LIST.md` lists them.

## Left to the builder

File splits within the existing folders, test names, and how each Android behavior is expressed in SwiftUI idioms already used in the iOS app.
