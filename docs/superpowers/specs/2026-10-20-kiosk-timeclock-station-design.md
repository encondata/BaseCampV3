# Kiosk Time Clock station and new time clock flow: design

Date: 2026-10-20. Builds on `2026-09-13-kiosk-web-design.md` (the current
time clock), `2026-10-01-kiosk-rfid-station-design.md` and
`2026-10-19-label-station-printing-station-design.md` (station types),
`2026-10-16-station-key-telemetry-design.md` (station keys), and
`2026-10-17-kiosk-config-in-portal-design.md` (phasing across platforms).

Artwork: `Sample Data/kiosk timeclock/`. `light_screen_01..08.png` are the
portrait reference screens (1080×1920). The small `*_reference.png` files are
crops for matching the look and are not usable as app images.

## 1. Why

The time clock today is one plain screen: one input box ("Scan a badge or
type a name"), a person card, and one Clock in or Clock out button. Jimmy
wants:

- a guided, friendly flow, built from his mockup, for crews walking up at the
  start and end of a shift;
- a kiosk that can be a **dedicated Time Clock station**, like RFID and
  Label stations. It sits in a central check-in or briefing conference room,
  rests on a Welcome screen, and stays signed in on its own.

## 2. Goals, non-goals, anti-goals

**Goals**
- The new flow replaces the old time clock screen everywhere it exists.
- Time Clock becomes a station type, with a station key so it works with
  nobody signed in.
- Workers identify themselves by name or by QR code.
- The Clock Out screen shows how long they have worked today.
- Both portrait and landscape layouts.

**Non-goals (this round)**
- Lunch Out / Lunch In. The mockup shows them; Jimmy said leave them out.
  Only Clock In and Clock Out exist.
- Real badge printing and real RFID badge verification. Both screens are
  styled placeholders.
- Dark mode for the time clock. There is no dark mountain artwork, so the
  time clock screens are always light (the way `/rfid_status` is always dark).
- Offline punches. A punch with no connection still fails with a clear
  message, as today.
- Limiting a station to people on its move. Anyone can clock in anywhere
  (Jimmy).

**Anti-goals (would make this a failure even if it works)**
- A Time Clock station that drops out every day and needs someone to sign it
  in again.
- A worker walking past a dedicated station and getting into Kiosk Setup,
  Settings, or any other kiosk feature.
- The station key reaching anything beyond the time clock.
- A punch lost because a later step (badge print or verify) failed.

## 3. Phases (Jimmy)

1. **API + portal + web/laptop kiosk.** Everything in sections 4 to 8.
2. **Android** gets the new flow and the Time Clock station mode (section 9).
3. **iOS** gets the same (section 9).

Each phase ships and merges on its own.

## 4. The flow

The screens follow the mockup, light mode, **without the orange dashed route
line** (Jimmy removed it). The header is the logo plus date and time; the
footer is the mountain scene with "TRACK | MONITOR | VERIFY | COMPLETE".

1. **Welcome** (dedicated station only). "Welcome! Please identify yourself
   to continue." Two cards:
   - **Scan Your QR Code.** On the laptop, a barcode reader (keyboard wedge)
     scans at any time while Welcome is showing; tapping the card only
     explains "Scan your code with the reader". *(Builder's call: the screen
     keeps a hidden focused input, like today's time clock.)* On Android and
     iOS (phases 2-3), tapping the card opens the camera.
   - **Enter Your Name** opens step 2.
2. **Enter Your Name.** A search box with an on-screen keyboard (QWERTY,
   123, Space, Search) and live results using today's `searchPeople`. A
   physical keyboard also types into it. A badge scan (RFID wedge or QR)
   typed into the box still selects its owner at once, through
   `matchPersonExact`.
3. **Is this you?** Photo (initials when no photo), display name, job title,
   and Employee ID when set. Buttons: **Yes, that's me** and **No, search
   again**.
4. **What would you like to do?** Two large tiles, Clock In and Clock Out.
   Only the one that fits the person's current status can be tapped; the
   other is dimmed. *(My call; Jimmy did not object.)*
5. **Clock Out.** "You've been working for **7h 24m** today", with a small
   table of today's punches (clock-in and clock-out times per shift, then the
   total). **Confirm Clock Out** records the punch.
6. **Clock In.** Tapping the tile records the punch at once, **before**
   anything about badges, so the punch is never at risk. Then: "Do you need
   a new badge?" with **Print a new badge** and **My badge works**.
   - Print a new badge leads to **Printing Your Badge** (placeholder: the
     spinner screen, which moves on after about 3 seconds), then **Verify
     Your Badge** (placeholder: the "place your badge against the reader"
     screen with a **Continue** button, since no tag is read yet).
   - My badge works skips straight to step 7.
7. **You're All Set!** "Have a great day, {first name}!" plus a **Done**
   button. It returns on its own after about 8 seconds.

Every screen after Welcome has **Back** (bottom-left) to the previous step.

**Where it returns** (Jimmy):
- **Dedicated station:** the flow starts at Welcome and every exit returns to
  Welcome.
- **Regular kiosk:** the Timeclock tile starts at Enter Your Name, and every
  exit returns to kiosk Home. Back on Enter Your Name also goes Home.

**Idle reset:** after 20 seconds with no touch or key on any step after the
start screen, the flow returns to its start (Welcome or Home). The All Set
screen uses its own 8-second timer. *(My call, matching today's 20-second
reset.)*

**Feedback:** identifying a person and a successful punch reuse the kiosk's
good-scan flash and sound. An unknown badge or QR code uses the not-found
flash and sound and a "We couldn't find that code" message. *(My call.)*

**Errors:**
- A 409 `already_clocked_in` or `not_clocked_in` (someone punched elsewhere
  in between) reloads the person's status and returns to step 4 with a short
  message.
- A network failure keeps the person on the screen with "Can't reach the
  portal. Your punch was not recorded. Try again." plus a retry button.

## 5. Layout: portrait and landscape

- **Portrait** follows the mockup.
- **Landscape uses layout A** (Jimmy picked it from mockups). The portrait
  screen is widened: the greeting is centered on top, the two Welcome cards
  sit side by side, and the mountains run along the bottom. The mockups are
  saved in `.superpowers/brainstorm/16241-1792526939/content/landscape-v1.html`.
  - Is this you? puts the photo on the left and the name and buttons on the
    right.
  - Clock Out puts the big total on the left and the punches table on the
    right.
  - The action tiles sit in one row.
  - Enter Your Name puts the results list beside the keyboard.
- Orientation is chosen by CSS (`orientation` / aspect-ratio media queries),
  not by a setting.
- The flow fills the whole screen in both modes, with no kiosk top bar or
  footer. This is a new shell; see section 6.

**Artwork** (Jimmy: use what exists):
- The mountains are the portal's `login-mountains-light.webp`.
- The logo is the portal's `serversherpa-logo.png`.
- Icons, cards, buttons and the topographic background are built in code
  (SVG/CSS), so they stay sharp in either orientation.
- The colors and type come from the portal's light login styles
  (`portal/src/styles/login-light.css`: ink `#0F172A`, amber `#FF6A00`, paper
  `#FFF9F2`).

## 6. The Time Clock station (web/laptop, phase 1)

**Which kiosks:** like RFID and Label, the Time Clock station type exists on
the **laptop edition** only in phase 1. The edge holds the station key, and
the browser never sees it. A plain web-mode kiosk keeps behaving as a
regular kiosk with the new flow. *(My call. The laptop is Jimmy's phase-1
hardware, and the key needs somewhere to live that is not browser storage.)*

**Setup:**
- Kiosk Setup's station type step gets a third card, **Time Clock**.
- Path: `type → move → site`. No scan type step, since punches need no
  checkpoint.
- **The move is optional for a Time Clock station** (Jimmy). The Move step
  gets a **No move** card.
  - With a move, punches are filed under the station's move, and the Site
    step offers that move's source and destination, as today.
  - With no move, punches are filed under no move and sorted out later on the
    portal. The Site step then lists every active site, plus a **No site**
    card. *(My call. The site still sets the time zone for "today".)*
  - So `POST /kiosk/setup`, `POST /kiosk/station-key` (which refuses a kiosk
    with no move today) and the station-key move lock all accept a missing
    move for `timeclock` only. A Time Clock key with no move covers no move:
    its punches carry `initiative_id = null`, and its people sync is called
    with no `initiative_id`. Changing the move, including from none to one or
    back, still revokes the key.
- `KioskSetupIn.scan_status` is required, so the Time Clock path sends a
  fixed value, the way the Label path sends `labeled`. *(Builder: pick any
  active status; it is never used for punches.)*
- Finishing setup issues the station key, the same way it happens for RFID
  and Label stations, and lands on Welcome.

**Data and API:**
- New migration: `devices.station_type` CHECK becomes
  `IN ('label','rfid','timeclock')`.
- Schemas that list the types (`Literal["label","rfid"]`) gain `timeclock`.
- `station_keys.verify` and `is_station` accept `timeclock`.
- Station-type changes and Clear Setup revoke the key as they do today.
- **Key scope.** A time clock key works only on new time clock station
  routes:
  - `GET /kiosk/station/sync/people`, which already exists, so the station
    can load the people list;
  - `GET /kiosk/station/timeclock/{person_id}`;
  - `POST /kiosk/station/timeclock/clock-in` and `clock-out`.

  Each route checks `station_type == 'timeclock'`. The existing station routes
  refuse a time clock key (as Label keys are refused on some routes today).
  `sync/people` is the one existing route shared with other station types.
- The new routes share the rules of today's `/kiosk/timeclock/*`:
  `services/timeclock.py`, the one-open-entry index, always `now`, no
  back-dating.
  - Site and move come from the device's setup: the station's move, or
    none (Jimmy). A worker from another move who punches here is filed
    under this station's move.
  - `created_by` is null.
  - The audit row has no person actor, and its `changes` carry `person_id`,
    `device_id` and `via: "station_key"`.

  `time_entries.created_by` and the audit actor (`actor_person_id`) are both
  nullable (checked).
- A station may clock out any open shift, including one another move's kiosk
  opened, because anyone can punch anywhere. *(My call.)*
- Same registration rule as other stations: a lapsed 30-day registration
  gives 403 `kiosk_not_registered` and keeps the key. Anyone signing in at
  the station, or an admin renewing on Kiosk Devices, brings it back.
**The edge.** Today it already pulls people under the station key into its
cache (`STATION_SYNC` in `edge/sync.py`), and `CACHEABLE` already covers
`/kiosk/sync/`. What has to change:
- `STATION_TYPES` in `edge/rfid/station_key.py` gains `timeclock`.
- The station sync is all-or-nothing over five lists. For a Time Clock
  station it pulls **people only**, since the other routes refuse its key.
- `EDGE_ONLY` blocks `/kiosk/station/*` from the browser, and the proxy
  answers a cached read with no session with 401. So the edge gets **new
  edge routes of its own** for the signed-out flow:
  - a public station-info read (station type, has key, setup site name);
  - people search data served from the edge's cache;
  - status, clock-in and clock-out, which the edge forwards to the station
    routes with the key attached.

  The browser never sees the key. A punch with no connection still fails.
- **These signed-out edge routes answer only the laptop's own screen
  (loopback requests).** The kiosk UI is published on every interface for
  other LAN devices, and the people list and punches must not be open to the
  venue's network without a login. Other LAN devices keep the normal
  signed-in kiosk. *(My call.)*

**What a signed-out station shows:**
- A browser can't know it's at a station today: the station type lives in
  localStorage or in `GET /edge/setup`, which needs a session. On load, the
  kiosk asks the new public station-info read.
- When that read says Time Clock station with a key, `/` with nobody signed
  in shows Welcome instead of redirecting to `/login`.
- The time clock screens are a **new full-screen shell outside `KioskGuard`
  and `KioskShell`**. No existing page works this way (`/rfid_status` is
  inside both), so this is new work.
- Every other route still requires sign-in.

**Getting to Setup and Settings:**
- A small gear in the Welcome header goes to `/login`.
- After sign-in, Home shows the station's tiles: **Time Clock** (back to
  Welcome), **Kiosk Setup** and **Settings**.

This adds a `timeclock` entry to `STATION_TILES`. Jimmy owns those lists, so
this is flagged for him. *(My call on the contents.)*

**Signed in at the station:** the flow still punches through the station
key, so a station behaves the same whoever is signed in.

## 7. Today's hours and the people list (API)

**Today's hours:**
- The status reply (`KioskTimeclockStatusOut`, from both the session route
  and the station route) gains:
  - `today_minutes`: worked minutes so far today, counting the open entry up
    to now;
  - `today_entries`: each of today's shifts as `{clock_in_at, clock_out_at |
    null, minutes}`, oldest first.
- "Today" means the local day in the **site's time zone**
  (`sites.timezone`). The site is the kiosk's setup site; with no site, it
  falls back to UTC. *(My call.)*
- A shift that began before midnight counts only its minutes after midnight.
  *(My call.)*
- `break_minutes` is subtracted as `worked_minutes` already does.

**Badge ID in the people sync:**
- Both `/kiosk/sync/people` and `/kiosk/station/sync/people` add `badge_uid`
  to each person, along with `job_title` and `external_id` for the "Is this
  you?" card.
- `matchPersonExact` matches a scanned value against `badge_uid` (full UUID,
  case-insensitive).
- The kiosk's IndexedDB `people` store picks up the new fields on its next
  sync.

## 8. Worker QR codes (portal)

The QR code holds the person's `badge_uid`, an existing random UUID. *(My
call; Jimmy confirmed that workers use a phone or a printed QR.)*

**The QR is a shortcut, not a credential.** Anyone can already punch anyone
by name, and `matchPersonExact` already accepts a person id or its 8-character
short form. So matching stays on the kiosk, `badge_uid` rides the people sync
like `rfid_tag` does, and nothing is hashed. *(My call.)*

- **/me** gets a "My QR code" card on the profile page. It shows the QR large
  enough to scan from a phone screen, so workers can pull it up at the kiosk.
- **The worker page** (`/people/workers/:id`) gets **Print QR**, which prints
  a simple card with the name and QR. It is shown to anyone who can view that
  worker. *(My call.)*
- "Employee ID" on the "Is this you?" card is `people.external_id`, which the
  bulk import fills from the employee number.

The portal already has `bwip-js`, which can draw QR codes.

## 9. Android and iOS (phases 2 and 3)

Each platform gets:
- The same flow and layouts, built natively from the same screens.
  Portrait comes first on the Android phone, and both orientations are
  supported.
- A **station type** concept for the first time: a Time Clock choice in that
  app's Kiosk Setup and the same Welcome resting screen.
- Its own station key, kept in the platform's secure store (Android Keystore
  or EncryptedSharedPreferences; iOS Keychain). It calls the station routes
  directly, since there is no edge.

API change for these phases: `verify` / `is_station` accept the
`timeclock` type on `android` and `ios` `sub_type`s as well as `laptop`.

**QR scanning uses the camera.** iOS's `CameraScanner` already decodes QR.
Android's camera input already feeds `ScanBus`.

Each platform phase gets its own short plan when it starts. The decisions
above carry over.

## 10. Left to the builder

- Component structure, CSS file layout, and the exact on-screen keyboard
  implementation. A small in-app keyboard component is fine; no new
  dependency is needed.
- Exact wording of error messages, within the tone of the mockup.
- Whether the placeholder Printing and Verify screens live behind a small
  `badge` module, so real printing and RFID reads can slot in later.
- Test layout, following the kiosk's existing vitest and jsdom patterns and
  the API's pytest patterns.

## 11. Later (named, not built)

- Lunch Out / Lunch In as real punches.
- Real badge printing and RFID badge verification.
- Dark mode artwork and a dark time clock.
- Offline punches through the edge outbox.
- Optional limit of a station to the people on its move.

## Implementation notes (phase 1)

What shipped on branch `timeclock-station` (web/laptop only), and where it
differs from the sections above. Where this section and §6 disagree, this
section wins.

### Display cookie instead of loopback

§6 gated the signed-out edge routes on loopback requests. That was dropped:
Docker hides the client address and `Host` can be spoofed, so a loopback
check cannot be trusted. The edge uses a **display cookie** instead.

- Name `ss_tc_display`. HttpOnly, SameSite=Strict, path `/edge/timeclock`,
  max-age 400 days. `Secure` follows the edge's `secure_cookies` setting.
- The edge stores only a hash of the token, never the token.
- Only `POST /edge/timeclock/arm` sets it. Arming needs a signed-in session
  that is **not** a move-password session (403 `move_locked`), and the laptop
  must be a Time Clock station with a key (409 `not_timeclock_station`). The
  browser gets there through **Start Time Clock**. No rank rule was added.
- Displays are revoked on every Kiosk Setup, every station-key clear or
  replacement, Clear Setup and Wipe. A dropped key therefore needs a person
  to arm the screen again. Start Time Clock does that after setup anyway.
- Other LAN devices have no cookie, so they keep the normal signed-in kiosk.

### A signed-in person never runs the station flow

§6 said the flow punches through the key even when someone is signed in.
That changed. The Time Clock tile on Home goes to **Start Time Clock**,
which arms the display and signs the person out. A signed-in person never
sees the station flow, so a worker never lands in Setup or Settings.

- Kiosk Setup's Time Clock finish lands on Start Time Clock, not on Welcome,
  because arming needs the signed-in session. Both cost one extra tap.
- On an armed station, the login page shows **Back to the time clock**, and
  returns there by itself after 60 seconds idle. Without it, the gear on
  Welcome stranded the station on the sign-in page.

### Station keys scoped by type

A Time Clock key reaches only `/kiosk/station/timeclock/*` and
`/kiosk/station/sync/people`. Every other station route answers 403
`wrong_station_type` and **keeps the key**. The same check applies to Label
and RFID keys against the Time Clock routes.

- Station routes added: `GET /kiosk/station/timeclock/{person_id}?serial=`,
  `POST /kiosk/station/timeclock/clock-in` and `clock-out`
  (body `{serial, person_id}`).
- `POST /kiosk/setup` accepts `timeclock` from any kiosk sub-type, with no
  laptop check, since phases 2 and 3 need it. Keys are still issued to the
  laptop only.
- `setup-options.sites` is empty for move-password sessions. Such a session
  cannot do a no-move setup, so listing every site name would only leak.
- A move with no site is a 422 `bad_site` for `timeclock`, so the wizard
  always sends a site when a move is picked.

### Migration 0105

`devices.station_type` CHECK now allows `timeclock`. The migration is
numbered **0105 and chained on 0103**, because 0104 belongs to the unmerged
badge-templates branch. **Re-point `down_revision` when the two meet**, or
there will be two heads.

### Edge routes

All under `/edge/timeclock`. Punches go to the station routes under the key
and the laptop's serial. The portal's status and JSON body come back as they
are, so the browser sees `{"detail": {"code": ...}}`.

- `GET /station`: public. `timeclock`, `ready`, `paused`, `armed`,
  `initiative_name`, `site_name`. Never the key or the serial.
- `POST /arm`: described above. Answers 204.
- `GET /people`: the cached people list (needs an armed display). 503
  `people_not_synced` before the first sync.
- `GET /status/{person_id}`, `POST /clock-in`, `POST /clock-out`: need an
  armed display. A bad id is 422 `bad_person`.

Error codes across the routes:

| Code | Status | Meaning |
|---|---|---|
| `not_timeclock_display` | 403 | no armed display cookie |
| `move_locked` | 403 | arming from a move-password session |
| `not_timeclock_station` | 409 | arming when the laptop is not a ready Time Clock station |
| `station_not_ready` | 409 | punching with no Time Clock setup or no key |
| `edge_offline` | 503 | the portal is unreachable (punches still need a connection) |
| `people_not_synced` | 503 | no people list cached yet |
| `bad_person` | 422 | person id missing or not a UUID |
| `wrong_station_type` | 403 | portal: key of another type (key kept) |
| `kiosk_not_registered` | 403 | portal: lapsed registration (key kept) |

For a Time Clock station the edge's station sync pulls **people only**. The
other four lists are skipped, since the portal refuses the key on them.

### Setup

The wizard gets a **Time Clock** path type. Path: type, then move
(optional, with a **No move** card), then site. With a move, the site step
offers that move's sites. With no move, it offers any site or **No site**.
There is no scan type step. Finishing issues the station key and lands on
Start Time Clock.

Switching a laptop to Time Clock releases the RFID reader and rejects every
pending scan with `station_changed`. Label settings are dropped on a switch
from Label to Time Clock, as `laptop_setup.save` already does.

### Today's hours

`today_minutes` and `today_entries` follow §7 with these details:

- The math runs in UTC. Local midnight in the kiosk's site zone is converted
  to UTC first, so DST changes do not skew the subtraction.
- A span counts only its overlap with local midnight to now. Minutes are
  floored per span, so the total can be a minute or so under the exact sum.
- `break_minutes` is subtracted only for shifts that **started today**. A
  shift that began yesterday is clipped at midnight and loses no break.
- With no site, or a site with no usable zone, the zone is UTC.

### Kiosk UI

- `pages/Timeclock.tsx` is **retired**. The new flow lives in
  `kiosk/src/timeclock/` (reducer, backends, timers, screens), portrait and
  landscape. `/timeclock` is still the route for the regular kiosk.
- `matchPersonExact` now also matches `badge_uid`. The people store and sync
  carry `badge_uid`, `job_title` and `external_id`.
- Kiosk-mode clock-in still lets the server fall back to the device row's
  site and move. It differs only if the local setup and the device row
  disagree.
- Punches have no client-side timeout. A dropped POST may still be recorded.
  Idle exit still returns the station to Welcome, but a person who walks
  away mid-hang gets no "may have been recorded" hint.

### Worker QR codes

Shipped as §8 describes: the **/me** card and **Print QR** on the worker
page, shown only when the person has a `badge_uid`.

### Accepted risks

- `badge_uid` rides the bulk people sync, like `rfid_tag`. The QR is a
  shortcut, not a credential: anyone can already punch anyone by name. If
  that changes, resolve the QR on the server instead.
- A move-password session sees a person's `today_entries` from other moves.
  These are times only, with no move names, and the existing status route
  already returns an open entry from any move with its move name.
- Punches are not timed out on the client (see above).
- The display cookie lives 400 days. Its lifetime is bounded by setup and the
  key, so shorten the constant if that is too long.

### Open follow-ups

- A real screen-reader check of the card and tile buttons' accessible names.
- No per-display disarm UI, and `timeclock_displays` rows are unbounded (one
  per arm).
- Live verification on the laptop stack: Time Clock setup, Start Time Clock,
  punches by name and by badge UUID, both orientations, `/timeclock` as a
  regular kiosk, and the portal QR. The controller does this after the notes
  land.
- Re-point migration 0105 at merge (see above).
