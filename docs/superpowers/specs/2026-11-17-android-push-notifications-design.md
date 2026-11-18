# Push notifications to admins' Android phones: design

Date: 2026-11-17. Status: draft for Jimmy's approval.

## Intent

Admins hear about notifications today only when they look at the portal bell
(the inbox) or read their email. Jimmy wants an admin's own phone to buzz when
something they care about happens, the way any other app's notifications do,
and to deal with it right there: read it, mark it read, hide it, or snooze it.

This pass builds it for **Android only**. iPhones are to behave exactly the
same later, but that needs the paid Apple Developer Program, which Jimmy is not
renewing yet. The server side is built so iOS is app work plus Apple keys, not a
redesign.

## Goals

- An admin's personal Android phone gets a push for each notification whose
  category they have turned Push on for, even when the app is closed, the phone
  is locked, or their 1-day kiosk sign-in has run out.
- The push shows the notification's own title and text, with **Snooze** and
  **Mark read** buttons on the alert.
- Tapping the alert opens a basic **Notifications** page in the app: the same
  inbox as the portal bell, with Mark read / Mark unread, Hide and Snooze.
- Push is a third column in the existing category grid, next to Inbox and
  Email, on System › Notifications › Defaults and on /me.
- Push appears in Check delivery and in the Delivery log like email does.

## Non-goals

- iPhone/iPad push (later; same behavior, see "Later: iOS").
- Push to shared devices: Zebra handhelds, stations, shared kiosk phones.
- Push for non-admins.
- An unread count on Home, a portal view of snoozes, or any setting for the
  snooze length.
- Any new notification kinds. This is a new channel for the existing ones.

## Anti-goals (would make this a failure even if it works)

- A phone that keeps getting someone's alerts after it stopped being theirs.
- A 2 a.m. buzz for something that isn't critical.
- Alerts that quietly stop arriving (for example, a connection the phone's
  battery saver kills). This is why the design uses Firebase, not a
  self-held connection.
- Re-alerting about something the admin already handled on the portal.

## Jimmy's decisions

1. **Devices:** admins' personal phones only. Shared and Zebra handhelds never
   get push.
2. **Delivery:** Firebase Cloud Messaging (FCM). It is free, needs Google Play
   services (every personal phone has them), and works with the app closed.
3. **Who:** admins only, rank 60+ (`GATE_BYPASS_RANK`).
4. **Which phone is personal:** reuse the existing "Personal device of"
   assignment (`devices.personal_person_id`, migration 0107), the one that
   gates biometric sign-in. Add a **"This is my phone"** switch to the app's
   Settings, shown only to admins. Keep the portal control too.
5. **Push keeps going after the 1-day sign-in expires**, for as long as the
   phone is still personal to the admin and its kiosk registration is valid
   (`devices.token_expires_at`, 30 days, renewed by a sign-in within 7 days of
   expiry).
6. **Which notifications:** a Push column in the grid (approach A), with
   company defaults and personal switches, like Email.
7. **Push starts off** in every category's company default.
8. **Quiet hours:** no push during the person's quiet hours or days, except
   critical kinds, which push anyway (critical emails work the same way).
   Nothing is lost: the inbox has it, and the summary email covers it if email
   is on.
9. **Push content:** the notification's own title and text, flagged private
   so a phone set to hide sensitive content shows only a generic line on the
   lock screen.
10. **Tap:** opens a new Notifications page in the app (sign-in first if the
    session ran out). The page lists the inbox with **Mark read** and **Hide**
    buttons, like the portal.
11. **Home:** a Notifications app button styled like Settings, admins only.
12. **Snooze:** a Snooze button, always 5 minutes, no setting. On the alert
    and on the page. Tracked on the **server**: after 5 minutes the worker
    pushes it again unless it was read or hidden anywhere meanwhile. The
    lock-screen Snooze and Mark read buttons work without a sign-in, using a
    credential tied to the phone's push registration and limited to those two
    actions on the owner's own notifications. A security review looks at it.
13. **iOS later**, same behavior.
14. **Any admin (rank 60+) can claim a phone nobody owns** with the app
    switch. This lowers the bar for biometric sign-in on that phone from
    super admin to admin. Every claim is audited. Only a super admin, on the
    portal, can take a phone from its owner. Zebras are refused.
15. **Account security never pushes** in this pass. The category has no grid
    row to hold a Push switch, and its kinds are all critical, so they would
    skip quiet hours (a 2 a.m. buzz for "Password expiring").

## Approaches considered

How alerts reach the phone:

- **FCM (chosen).** Google's push service, free. The app is woken even when
  closed. The only Android path that is reliable and battery-friendly.
- **A connection the app holds open to our server** (like the portal bell's
  websocket). No Google, but Android requires a permanent "running"
  notification, drains the battery, and kills it when the phone sleeps, so
  alerts quietly stop. Rejected (anti-goal).
- **UnifiedPush or ntfy.** Self-hosted, but each admin installs a second app
  to carry the alerts. No gain when every target phone has Google services.
  Rejected.

How the server sends (Claude's call, following the existing pattern): a **push
queue drained by the notification worker**, like `EmailOutbox`. A snooze is a
queued push dated 5 minutes ahead, so the queue covers both. Sending inline in
`notify()` was rejected: it puts a Google network call inside the caller's
transaction and has nowhere to put a snooze. The sender calls FCM's HTTP v1
endpoint with `httpx` plus a service-account token signed with `pyjwt` and
`cryptography`, all already API dependencies. The `firebase-admin` SDK was
rejected as a heavy new dependency for one HTTP call.

## How it works

### When a phone gets a push

All of these must hold at **send time** (checked by the worker, not just when
queued):

- The notification is still live: not read and not hidden.
- The person's account is active and their max rank is 60+.
- The person's Push switch for the category is on (their own value, else the
  company default). Push needs Inbox, like Email does.
- It is not their quiet time, or the kind is critical.
- The device is personal to them (`personal_person_id`), its registration is
  valid (`token_expires_at > now`), it is not a shared station
  (`biometric.shared_station`), it is not a Zebra (`sub_type == "zebra"`,
  even if the portal made it someone's personal device), and it has a push
  registration with an FCM token.

A person with two personal phones gets the push on both.

Which kinds can push (Claude's calls):
- **Account security never pushes** (decision 15).
- **Kinds that are never emailed** (`KindInfo.email = False`, such as the
  `plan_task_*` kinds, `learning_quiz_locked` and `password_reset_request`)
  still push when their category's Push switch is on. The email flag is about
  email only. They can never be marked critical (`critical_eligible` requires
  email), so they always obey quiet hours.
- **A bumped request card pushes again.** `reset_requests.open_or_bump`
  marks an existing card unread and moves it to the top without calling
  `notify()`. It gets its own push hook so a repeat request still buzzes.
  `address_blocks.reannounce_block` already goes through `notify()`.

### What stops push to a phone

- Turning off "This is my phone" in the app, or clearing or reassigning
  "Personal device of" in the portal. Both delete the device's push
  registration.
- The kiosk registration expiring (`token_expires_at` passes). The registration
  row stays, and push resumes when a sign-in renews it.
- The platform-family change that already clears a personal assignment
  (`biometric.clear_personal_on_platform_change`). It also deletes the push
  registration.
- Google reporting the token dead (app uninstalled or data cleared). The sender
  deletes the registration.
- Losing admin rank, or a disabled or archived account. Push stops at send
  time. Claude's call: the registration row is also deleted where
  `revoke_keys` already runs for `demoted`, `account_disabled` and
  `blacklist`.

Claude's calls on what does **not** stop push: a plain Sign out, the 1-day
session expiry, Clear Setup (it resets kiosk setup and leaves the personal
assignment alone), "Forget fingerprint" (it revokes only the biometric key),
and a password change.

### API: data

New migration with two tables.

**`push_registrations`**: one row per device.
- `id`, `device_id` (FK devices, unique, ON DELETE CASCADE), `person_id`
  (FK people, ON DELETE CASCADE): the owner at registration time.
- `platform` (`android`; `ios` later), `provider` (`fcm`; `apns` possible
  later), `token` (text, unique).
- `secret_hash`: sha256 of the phone's push key (below).
- `created_at`, `updated_at`, `last_sent_at`, `last_error`.

A row whose `person_id` no longer matches `devices.personal_person_id` is
dead: the worker skips it, and every writer of `personal_person_id` deletes it.

**`push_outbox`**: one queued push.
- `id`, `notification_id` (FK notifications, ON DELETE CASCADE), `person_id`,
  `send_at`, `reason` (`new` | `snooze`), `state`
  (`queued` | `sent` | `dropped` | `failed`), `attempts`, `last_error`,
  `created_at`, `handled_at`.
- At most one `queued` row per notification (partial unique index). A new
  snooze replaces the queued one.

`notifications` gains `push_snoozed_until` (timestamptz, NULL), so the app's
page can show "Snoozed until 14:37" without reading the queue.

Company defaults (`system_config` `notifications` section) gain a `push` key in
each category's pair. A missing `push` reads as **off**, and is not treated as
malformed: `_switches` keeps today's on/on fallback only for a bad Inbox/Email
pair. The /me per-person switches gain an optional `push` value the same way.
`effective_switches` returns `push` (and `push_source`), with push on only when
inbox is on.

### API: deciding

`decide_push(db, person_id, info, *, contact, company, now)` is the twin of
`decide_email`. It writes nothing, so Check delivery can call it. The first
check that fails decides the reason code:
`push_not_set_up` (no FCM credentials configured), `unregistered_kind`,
`security_category` (decision 15), `category_off` (Inbox off),
`category_no_push`, `recipient_inactive`, `not_admin`, `no_phone` (no valid
personal device with a registration), `quiet_hours` (not critical). Otherwise
it answers "queue now" with the device count.

`notify()` calls it after the email decision and, on "queue now", inserts a
`push_outbox` row in the same transaction. It logs the decision to the Delivery
log with `channel='push'`. The log writer (`delivery_log.record`) is extended to
accept `push`; the database CHECK already allows it.

### API: sending (notification-worker)

A new `run_push` step in `notifications/worker.py`, polled with the others
(about every 5 s):

1. Claim due `queued` rows (`send_at <= now`) with `FOR UPDATE SKIP LOCKED`.
2. Re-check the send-time rules above. A row that fails is marked `dropped`
   with a reason, for example `read`, `hidden`, `no_phone` or `quiet_hours`.
   It is never retried.
3. For each live registration, send an FCM HTTP v1 **data-only, high-priority**
   message. The app builds the visible notification itself, so it controls the
   buttons, channel and lock-screen privacy. The payload is
   `{type: "notification", notification_id, person_id, kind, title, body,
   critical, created_at}`, with the title and body cut to sensible lengths (builder's
   call).
4. FCM `UNREGISTERED`, or `INVALID_ARGUMENT` about the token: delete the
   registration and log `token_removed`. 429 or 5xx: retry with backoff, up to
   a few attempts (builder's call), then `failed`. 401: refresh the access
   token once.
5. Clear `push_snoozed_until` when a snooze push is sent.

The access token (`oauth2.googleapis.com/token`, scope
`https://www.googleapis.com/auth/firebase.messaging`) is cached until shortly
before it expires.

Claude's call: when a notification is read or hidden anywhere (portal, app,
lock screen), the API queues a normal-priority data message
`{type: "clear", notification_id}`, so the alert disappears from the phone's
shade, and any queued snooze is cancelled. Without this, reading something on
the portal leaves a stale alert on the phone. This includes the server-side
paths that mark cards read with raw SQL when a request is decided
(`requests.resolve_copies`, `reset_requests.resolve`,
`address_blocks.resolve_block`, `router_agent`): each sends the clear and
cancels the snooze too.

**Configuration:** `SS_FCM_SERVICE_ACCOUNT_FILE`, the path to the Firebase
service-account JSON (it is a secret, never in git). The project id is read
from it. If it is unset, push is "not set up": the decisions say
`push_not_set_up`, and the portal shows Push as unavailable in Check delivery.

### API: endpoints

Kiosk sessions may call only `/kiosk/*` (`enforce_session_scope` in
`api/deps.py`), so the app cannot use `/notifications/inbox`. Everything the
app needs lives under `/kiosk/`, reusing the inbox route's helpers so both
behave the same.

With the **signed-in kiosk session** (the session must be bound to this
device's serial, as the heartbeat's `_bind_kiosk_session` checks):
- `PUT /kiosk/personal` `{on: bool}`: "This is my phone". Turning on requires
  rank 60+, the existing eligibility rule (`_refusal_for`), not a shared
  station, not a Zebra (`zebra`), a known platform, and a device that is not
  already personal to someone else (`owned_by_other`; only a super admin on
  the portal reassigns). Turning off is allowed only for the owner
  (`not_owner` otherwise). It clears the assignment, revokes biometric keys
  (`reassigned`) and deletes the push registration. Audited `personal_set` /
  `personal_cleared` with `source: kiosk` (decision 14).
- `POST /kiosk/push/registration` `{token}`: create or replace this device's
  registration. Requires the device to be personal to the caller and rank 60+.
  It returns a new **push key** (256-bit random, shown once, only its sha256
  stored). It also replaces any earlier key.
- `DELETE /kiosk/push/registration`.
- `GET /kiosk/notifications`: the same page, cursor and counts as
  `GET /notifications/inbox`.
- `POST /kiosk/notifications/{id}/read`, `/unread`, `/snooze`, and
  `DELETE /kiosk/notifications/{id}` (hide).

With the **push key** instead of a session (header
`Authorization: PushKey <registration id>.<key>`), accepted only on:
- `PUT /kiosk/push/registration/token` `{token}`: FCM rotated the token while
  nobody was signed in.
- `POST /kiosk/push/notifications/{id}/read` and `/snooze`: the alert's
  buttons.

A push key works only while its registration is live (device still personal
to the same person, registration valid), and only on that person's own
notifications. Wrong or unknown keys get a flat 401, rate-limited like the
other key-authenticated kiosk routes (see the station-key routes). Turning off
"This is my phone" or any personal change deletes the registration, which
kills the key.

Snooze: sets `push_snoozed_until = now + 5 min` and upserts the notification's
queued `push_outbox` row to `reason=snooze, send_at=now+5min`. It is refused
(409) for a read or hidden notification. Snoozing again restarts the 5 minutes.
Mark read and Hide cancel a queued snooze and clear `push_snoozed_until`.

### Android app

**Firebase setup:** Firebase BoM plus `firebase-messaging`, and the
`com.google.gms.google-services` Gradle plugin. `google-services.json` for
package `com.serversherpa.kiosk` is committed (it identifies the project and is
not a secret). Robolectric tests must not need it (builder's call: a test
config or a fake token source behind an interface).

**"This is my phone"** in Settings, admins only (rank from the session's
`/auth/me`). Turning it on:
1. calls `PUT /kiosk/personal {on: true}`;
2. on Android 13+, asks for `POST_NOTIFICATIONS`. If refused, the switch stays
   on (the phone is still personal, which also enables biometric sign-in), and
   a line under it says notifications are blocked, with a button that opens
   the app's Android notification settings;
3. gets the FCM token and calls `POST /kiosk/push/registration`;
4. stores the push key in the existing EncryptedSharedPreferences
   (`SecretStore`).

Turning it off calls `PUT /kiosk/personal {on: false}`, drops the stored key,
and deletes the FCM token locally. The switch shows the server's state on each
Settings open, so a portal reassignment shows correctly. The switch is hidden
on Zebra devices.

**Someone else signed in on the owner's phone** (Claude's calls): the owner's
alerts keep arriving, since it is still their phone. In Settings the other
admin sees "This phone belongs to <owner>" and no switch. Tapping one of the
owner's alerts while someone else is signed in shows "This alert is for
<owner>. Sign in as <owner> to see it." with a Sign out button, and does not
open the other person's inbox. The lock-screen buttons keep working on the
owner's notifications, as decision 12 implies.

**`FirebaseMessagingService`:**
- `onNewToken`: if a push key is stored, send it with
  `PUT /kiosk/push/registration/token` (push key auth). If that fails, retry on
  the next app start.
- `onMessageReceived`:
  - `type: notification`: post a system notification on channel **Critical
    alerts** (`critical: true`) or **Notifications**. It uses
    `VISIBILITY_PRIVATE` with a public version reading "ServerSherpa: new
    notification", 24-hour time, and actions **Snooze** and **Mark read**. The
    Android notification id is derived from the notification id, so a snooze
    re-push replaces rather than stacks.
  - `type: clear`: cancel that alert.
  - Alerts show in the shade even when the app is open.
- The action buttons go to a `BroadcastReceiver` that calls the push-key
  endpoint (via `goAsync` or WorkManager, builder's call) and cancels the alert
  on success. On failure the alert stays, so the admin can try again.

**Tap:** the content intent opens `MainActivity` with the notification id.
Signed in as the owner: go to Notifications with that item highlighted (not
marked read). Signed out: the sign-in screen (biometric offered as today),
then Notifications if the owner signed in. The push payload carries the
owner's person id, so the app can tell. `KioskGuard` does not remember the intended route today (a
deferred item from the original Android build); this needs it, or a one-shot
"pending route" the shell reads after sign-in.

**Home:** a **Notifications** app button styled like Settings, shown to admins
only, with no unread count. It shows whether or not the phone is marked
personal: it is just the inbox.

**Notifications page:** a plain list, newest first, from
`GET /kiosk/notifications`, with "Load more" for the next page and a visible
Refresh button.

```
 ‹ Home                              Sign out
 ─────────────────────────────────────────────
 ● Off-move alert                       14:32
   3 assets on DC1 to DC2 Migration
   Snoozed until 14:37
   [ Mark read ]  [ Snooze ]  [ Hide ]
 ─────────────────────────────────────────────
   Shipment delivered                   09:05
   Truck 12 arrived at DC2
   [ Mark unread ]  [ Hide ]
 ─────────────────────────────────────────────
```

- Unread rows have a dot. Snooze shows only on unread rows. Times are 24-hour.
- An empty state says there are no notifications.
- It works in both the standard and compact layouts and follows light/dark.
- No action button sits behind a scroll.

### Portal

- **System › Notifications › Defaults:** a Push column after Email, off by
  default. Push can't be on while Inbox is off, mirroring how the Email column
  behaves today.
- **/me › Preferences:** the Push column shown to admins (rank 60+) only. The
  same "own value, else default" behavior as Email.
- **Check delivery:** a Push line with `decide_push`'s answer and reason,
  for example "No phone set up for push" or "Quiet hours".
- **Delivery log:** push rows (`queued`, `sent`, `dropped`, `failed`,
  `token_removed`) with the channel filter offering Push.
- **Kiosk device page:** clearing or reassigning "Personal device of" also
  removes push. The page shows whether the phone has push registered
  ("Push: on" / "off"), since the registration is otherwise invisible. Claude's
  call; drop it if unwanted.

## Constraints

- Kiosk sessions are 2FA-exempt and limited to `/kiosk/*`. The new kiosk
  routes put an admin's inbox in reach of a password-only kiosk sign-in. That
  matches what the push already shows on the lock screen, but the security
  review should confirm it.
- The personal-device rules from the biometric work stay intact: the platform
  must be known; shared stations can't be personal; a platform-family change
  clears the assignment.
- American English, 24-hour times, the existing modal and list idioms, and no
  buttons behind a scroll.
- Never `adb shell monkey` on a phone; launch with the launcher intent
  (CLAUDE.md).

## Setup Jimmy does (at build time)

1. Create a Firebase project (the EnconDATA Google account is the natural
   owner) and add an Android app for `com.serversherpa.kiosk`. Download
   `google-services.json`.
2. Create a service-account key for the project and put the JSON on the API
   host, outside git. Set `SS_FCM_SERVICE_ACCOUNT_FILE` in the dev `.env`, and
   later in production.

Claude can do step 1 through the Firebase tools once Jimmy signs in, if he
prefers.

## Testing

- API: `decide_push` reasons in order; `effective_switches` with push; the
  defaults read with a missing `push`; outbox claim, drop and retry; the FCM
  sender against a fake transport (dead token, 429, 401 refresh); snooze,
  re-snooze, read and hide cancel; push-key auth (wrong key, stale owner,
  expired registration, someone else's notification); every personal writer
  deletes the registration; `/kiosk/personal` rules; delivery-log `push`.
- Portal: the Push column on Defaults and /me (admin-only on /me), Check
  delivery, Delivery log filter.
- Android: Robolectric for the Settings switch states, the Notifications page
  (compact and standard), the receiver actions, the route after sign-in, and
  the notification builder (channel, visibility, actions).
- Device pass on Jimmy's Pixel (Kiosk F4E1): app closed, locked, signed out
  after expiry, quiet hours, critical, Snooze from the lock screen, Mark read
  on the portal clears the phone, and turning the switch off stops push.

## Later: iOS

Same behavior. Needs the Apple Developer Program, the `aps-environment`
entitlement, and either direct APNs (`.p8` key; HTTP/2 via the `h2` extra) or
FCM's iOS SDK forwarding to APNs. That choice is deferred to the iOS pass. The
tables already carry `platform` and `provider`.

## Open questions for Jimmy

None. The two raised by the builder check are answered as decisions 14
(any admin can claim an unowned phone) and 15 (security never pushes).

## Left to the builder

Payload length cuts, retry counts and backoff, the exact Settings tab for the
switch, receiver mechanics (`goAsync` vs WorkManager), the test seam for
Firebase, and the migration number.

## Implementation notes (2026-11-18)

What differs from, or adds to, the design above. Written after the build.

### API

- Two migrations: 0131 (push tables) and 0132. 0132 widens the delivery-log
  event CHECK to allow the push events. They stay separate because both were
  unmerged when the CHECK change came up.
- Push log rows carry the outbox id in `detail.push_outbox_id`, not in
  `notification_log.outbox_id` (that column is a foreign key to `email_outbox`).
- `push_not_set_up` writes no log row. It only shows in Check delivery.
- New log reason `alerted_again`: a re-alert on an open notification.
- Plans notices DO push. There is no special case; the earlier
  `plans_not_pushed` reason was removed.
- `/system/status` returns `push_enabled`, next to `email_enabled`.
- Revoke-all (per person and system-wide) also drops that person's push
  registrations. Password change and Forget fingerprint do not.
- Push-key write routes honor read-only mode and return 423. A token refresh
  waits until maintenance ends.
- A token already registered to another device returns 409 `token_conflict`.
- Refused push keys are capped at 20 per hour per address.

### Worker

- The worker commits one outbox row at a time, so one bad row cannot cause a
  resend loop.
- It skips a notification that is being changed (SKIP LOCKED). A push may wait
  one more drain.
- Restart the worker after rotating the FCM key file. The key is read once.

### Kiosk routes and push key

- Kiosk notification items carry no payload.
- The push key authenticates only the push routes. A 401 `push_key_invalid`
  tells the app to drop its local key.

### Portal

- The Defaults grid and the /me grid disable Push when the server cannot push
  (`push_enabled` false).

### Android

- The google-services plugin applies only when `app/google-services.json`
  exists. Without it the app still builds and runs, and the switch says "Push
  isn't available in this build."
- FCM auto-init is off until the switch is turned on.
- Registration repeats automatically. There is no "Set up push" button. A
  failed load shows a visible Try again.
- On a portal-assigned phone, Settings asks for the notification permission
  once.
- A tap uses action `com.serversherpa.kiosk.push.OPEN_NOTIFICATION` with
  extras `open_notification_id` and `owner_person_id`. The owner-mismatch
  screen names the owner, read from `GET /kiosk/personal`.
- The push-key call carries the Internet Test marker, so the RemovalGuardTest
  count is 3.
- Compact layout: when the android-compact branch merges, the Notifications
  page needs its "‹ Home" label and a hidden title. `CompactFit.kt` was copied
  verbatim from that branch, so the merge will collide on it.
- Deploy the API before shipping the app build.

### Still open

- Device pass (Task 13): waiting on the Firebase project, `google-services.json`
  and the service-account key.
- A rare deadlock is parked: a snooze row's fifth-attempt fallback ends the
  snooze without SKIP LOCKED. Postgres detects it; the worst case is one failed
  Mark read or a row left queued.
- The iOS pass.
