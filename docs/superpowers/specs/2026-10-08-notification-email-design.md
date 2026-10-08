# Notification email and per-category settings — design

**Date:** 2026-10-08
**Tracker:** Notifications › "Notification delivery" (Feature Parity 390) and "Per-event-type notification settings" (Feature Parity 391), both Not built
**Branch:** `notification-email`

## Goal

In-app notifications can also go out by email, following the notification
group settings that are stored today but never applied. Each person picks,
per category, Inbox + Email / Inbox only / Off. Dev and test mail lands in
Mailpit (`localhost:1026`, UI `http://localhost:8025`) through the existing
mail outbox.

## What already exists, and what this does with it

| Existing | Today | This design |
|---|---|---|
| `notify()` (`notifications/inbox.py`) writes the in-app inbox row | Works, ~18 kinds | Keep. Email decision and enqueue happen inside it |
| Mail outbox (`mail/`: `enqueue`, Jinja templates, `deliver_once` every 5 s in notification-worker, retries) | Used by password reset and invites | Reuse; one new `notification` template |
| Group settings: `channels`, `quiet_start/end`, `timezone`, `active_days`, `dnd_behavior` (defer/skip), `urgent_bypass`, `enabled` | Stored, never applied | Applied at send time |
| Member overrides + `effective_settings()` (in `api/routes/notifications.py`) | Stored, shown | Applied; `effective_settings` moves to `notifications/settings.py` (the route re-imports it) |
| `capabilities()` email check | Shown on member chips | Reused idea; address rule below |
| `UiPreferences.notif.{critical,email,maint,digest}` switches on /me › Notifications | Saved, never read ("Delivery wiring lands with the notification service") | Replaced by the per-category table. `sound` stays |
| Inbox popover, toasts, sound | Works | Unchanged |

Nothing else is duplicated: no new settings page, no new worker, no new
mail path.

## Jimmy's decisions (2026-10-08)

1. **Groups own event categories.** A group is subscribed to categories;
   its settings apply to events in those categories for its members.
2. **No subscribed group → inbox only.** Email is opt-in through groups;
   on ship day every group has no categories, so nobody gets email until
   an admin opts groups in.
3. **Account-security events to the owner always email**, regardless of
   groups, personal choice or quiet hours. Admin copies follow group rules.
4. **/me's four dead switches become a per-category table.**

## Kinds and categories

New `api/src/serversherpa/notifications/kinds.py` — the single registry:

```python
@dataclass(frozen=True)
class KindInfo:
    category: str          # "approvals" | "reports" | "wiki" | "security"
    label: str             # "Report ready"
    brief: bool = False    # email carries title + link only, never the body
    email: bool = True     # False = never emailed
    owner_always: bool = False  # owner copies always email (decision 3)
    urgent: bool = False   # counts for a group's urgent_bypass

CATEGORIES = {"approvals": "Approvals & requests", "reports": "Reports & labels",
              "wiki": "Wiki", "security": "Account security"}
```

| Kind | Category | Flags |
|---|---|---|
| membership_request, membership_decided | approvals | |
| router_approval | approvals | brief |
| password_reset_request | approvals | email=False (exists only when email is off) |
| report_ready, report_failed, labels_ready, labels_failed | reports | |
| wiki_update, wiki_comment, wiki_mention, wiki_review_request, wiki_review_decision, wiki_review_due, wiki_export_ready, wiki_export_failed | wiki | |
| password_expiring | security | owner_always, urgent |
| totp_enrolled | security | brief, owner_always, urgent |

An unknown kind is treated as category `None`: inbox only, never emailed
(and a test asserts every `notify(` kind in the codebase is registered).

Portal mirror: `portal/src/lib/notificationKinds.ts` with the same
categories, labels and order.

## Data — migration 0092

- `notification_groups.categories text[] NOT NULL DEFAULT '{}'` with a check
  `categories <@ ARRAY['approvals','reports','wiki','security']`.
- `email_outbox.kind text NULL` and `email_outbox.notification_id uuid NULL
  REFERENCES notifications(id) ON DELETE SET NULL` (traceability; existing
  rows stay NULL).
- `UiPreferences.notif` (JSONB, no migration): drops `critical`, `email`,
  `maint`, `digest` (the schema has `extra="ignore"`, so stored values are
  simply ignored) and gains
  `categories: dict[str, "email" | "inbox" | "off"]`, default every
  category `"email"`. Sirdar's mirrored `NotifPrefs` (sirdar/api schemas)
  changes the same way.

## Sending rule

`notify(db, person_id, kind, title, *, body="", link=None, payload=None,
owner_notice=False)`. `owner_notice=True` marks the copy that goes to the
account owner about their own account (`totp.py` self copy,
`password_reminders.py`).

1. **Personal choice** = `ui_prefs.notif.categories[category]` (default
   `"email"`). Security is fixed at `"email"`; a stored value is ignored.
   - `"off"` → no inbox row and no email; `notify()` returns `None`.
2. Write the inbox row (unchanged).
3. **Email gate** — stop (inbox only) when any of these hold:
   `email_enabled()` is false; the kind's `email` flag is false; the kind
   is unregistered; personal choice is `"inbox"`; no address.
4. **Owner rule** — `owner_notice` and `owner_always` → enqueue now.
5. **Group rule** — the person's memberships in *enabled* groups whose
   `categories` contain the kind's category, each turned into effective
   settings with `effective_settings(group, member)`. Keep those whose
   effective `channels` contain `"email"`. None left → inbox only.
   For each remaining group compute when it allows email:
   - *now* if `urgent` and the effective `urgent_bypass` is true;
   - *now* if now (in the effective timezone) is on an active day and
     outside quiet hours;
   - otherwise, if `dnd_behavior == "defer"`, the next moment that is on
     an active day and outside quiet hours (searched minute-accurately
     across at most the next 8 days);
   - otherwise (`"skip"`) never.
   Send at the **earliest** allowed time across the groups (most
   permissive). If every group says never → inbox only.
6. Enqueue the `notification` template with `next_attempt_at` = that time,
   `kind`, `notification_id`, `person_id`.

Quiet hours may span midnight (22:00–07:00). A quiet window with equal
start and end means no quiet hours. Active days are evaluated in the
effective timezone. All of this lives in a pure function
`notifications/email_rule.py::email_send_time(settings_list, now, urgent)
-> datetime | None` so it is tested without a database.

**Address:** `Person.email`, else the person's `UserAccount.email`, else
none.

**Never an email:** a notification whose recipient has no account still
gets its inbox row as today; email follows the same rules (Person.email can
exist without an account).

`enqueue()` gains optional `kind`, `notification_id` and `send_at`
parameters (default now) — existing callers are unchanged.

## Email content

New template `notification` (`.subject.txt`, `.html`, `.txt`, extending
`_base.html`):

- Subject: the notification title.
- Body: "Hi {name}," then the title, then the body text (omitted when the
  kind is `brief`), then an **Open in ServerSherpa** button/link.
- Link: an absolute `link` is used as is (wiki); a relative one is joined to
  the portal origin (the setting password reset already uses); no link →
  the inbox (`<portal>/me/notifications`).
- Footer line: "You get these emails through your notification groups.
  Change what you receive: <portal>/me/notifications". Account-security
  emails say instead "This is a security notice about your account."
- Approvals never carry Approve/Reject buttons — only the link, so a request
  decided later can't be acted on from an old email.

## Portal

**/me › Notifications** (`pages/me/MeNotifications.tsx`):
- The "Notifications" section keeps its Sound row; the four switches are
  replaced by a table: Category | Delivery | Email from.
  - Delivery: the house `segmented` control with Inbox + Email / Inbox only /
    Off (Account security shows "Always emailed" text instead).
  - Email from: the names of the person's groups subscribed to that
    category whose effective channels include email, or "No group — inbox
    only".
  - Section text: "Emails go to your contact email. Your groups decide which
    categories can email you and when; here you can turn them down."
  - When the system has email off (`/system/status` `email_enabled`), a
    `page-hint` says "Email isn't set up on this server yet — notifications
    stay in the inbox."
- `MyNotificationGroup` (GET /auth/me/notification-groups) gains
  `categories` and `effective_channels` so the table can be built.

**Group admin** (`/system/notifications/:groupId`):
- `EditSettingsModal` gains a **Categories** row: a chip/toggle group of the
  four categories (house idiom; no raw checkboxes), saved with the other
  settings (`categories` on create/patch/out, validated against the
  registry → 422 `invalid_category`).
- The group detail's delivery-defaults panel shows the categories (or
  "None — members get inbox only").
- Channels "text" and "push" show "not available yet" next to them.

## Worker and CLI

- `notification-worker` already sends due outbox rows; deferred mail uses
  `next_attempt_at`. Fix the stale `cli.py` worker docstring and make
  `notification-worker --once` also run `deliver_once`.

## Errors and edge cases

- SMTP off → no outbox rows for notifications (avoids `skipped` rows that
  would never be retried).
- A group disabled or a category removed after a deferred email was queued:
  the email still goes at its time (it was decided at send time).
- Person deleted → outbox `person_id` set null by the existing FK; the
  `notification_id` FK is SET NULL.
- `notify()` stays inside the caller's transaction; email rows roll back
  with it.

## Testing

API: `email_send_time` (no groups, outside/inside quiet hours, overnight
window, inactive day, defer vs skip, urgent bypass, multiple groups → most
permissive, timezones); `notify()` paths (SMTP off, personal inbox/off,
no address, contact vs login email, owner rule, unregistered kind, email
flag false, brief body omission, deferred `next_attempt_at`, outbox kind and
notification_id); categories on group CRUD (+ invalid 422); my-groups
payload; migration 0092; registry covers every `notify(` kind; template
rendering (relative/absolute links, security footer).

Portal: the /me table (segmented choices save to `notif.categories`,
security fixed, Email from text, email-off hint); the Categories editor in
EditSettingsModal; group detail display.

Live: on the dev stack, subscribe a group to Reports & labels, generate a
report, see the email in Mailpit.

## Out of scope

Text and push sending; a weekly digest; sending an event to a whole group
as its audience (recipients stay whoever each event targets today).
