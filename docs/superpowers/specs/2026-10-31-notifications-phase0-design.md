# Notifications Phase 0 — honest settings, a delivery log, and a send-time re-check

Date: 2026-10-31 · Branch: `notif-phase0` · Status: approved in chat by Jimmy (two play-backs, 2026-10-31)

## Why

A review of the notification system (2026-10-31) found the plumbing sound but the
surfaces misleading: /me shows "Inbox + Email" for categories that can never email,
groups advertise Text/Push/Web channels that have no sender, the lists hide which
categories a group covers, deferred emails go out even after the item was read or the
approval was decided, and nobody can see why an email did or did not go out. Phase 0
fixes those without changing the model. The model change (personal schedules, a
channel grid, subscriptions, groups as audiences) is the separate redesign that
follows this phase.

Jimmy added one requirement: **every notification and email decision is logged where
super admins and above can read it**, so delivery problems can be troubleshot and
debugged.

## Goals

1. /me never claims an email that cannot happen.
2. Only channels that can actually send appear anywhere in the UI.
3. Group lists show the categories each group covers.
4. Notification emails are re-checked just before sending and dropped when no longer wanted.
5. The bell links to settings and to a full notifications page.
6. Quiet hours and days read the same everywhere.
7. The notification modals use the portal's own controls and the standard header.
8. A Delivery log (super admin and above) records every decision, with a Check delivery tool.

## Non-goals

- No change to who receives what, to group semantics, or to the per-category choice model.
- No SMS or push sender. No digest. No personal quiet hours.
- No change to who can open the process logs (they stay developer-only).
- The per-run "Notify me" switch and urgent bypass are left as they are.

## Anti-goals

- Hiding a channel must not delete or rewrite stored settings.
- The re-check must never drop an account-security email.
- Log rows and process-log lines must never carry an email body.

## Constraints (house rules)

- American English in all copy, comments and docs.
- Portal UI reuses the established controls: `.segmented`, ComboBox, `.org-select`,
  chips, `RowActionsMenu`, `.pf-form`, `Switch`. No raw native `<select>`, time input or
  checkbox in touched notification UI.
- Every modal touched or added carries the standard header: eyebrow, `h3` title,
  one-line `page-hint` description (the report-generate header). Rounded corners and
  themed scrollbars per the existing guardrails; ComboBox menus auto-portal in dialogs.
- Every list touched or added follows the list-column-floors recipe and keeps a fit test.
- `notify()`, `enqueue()` and the new log writer add to the caller's session and never commit.
- "Super admin and above" means global access and `max_rank >= 80` (`SUPER_ADMIN_RANK`),
  the same rule the System › Processes list uses.
- No new policy numbers: log retention reuses the Logging setting `local_max_age_days`.

## What changes

### 1. /me tells the truth (Notifications tab)

- Each category declares where its email permission comes from (`email_source`):
  `groups` (approvals, reports, wiki, learning — a subscribed group must allow it) or
  `always` (account security). A later category whose email follows the /me choice
  alone (the unmerged Plans work) uses `direct`. Email is possible when the server can
  send email **and** the source is `always` or `direct`, or the source is `groups` and
  one of the person's groups subscribes to the category with Email among its effective
  channels.
- When email is not possible, the "Inbox + Email" segment is disabled and "Inbox only"
  shows as selected. The saved choice is **not** changed, so joining a group later turns
  email back on with no extra click. While groups load, the saved choice is shown as is.
- "Email from" column: groups as chips; "No group — inbox only" when none; "Email isn't
  set up" when the server cannot send. The disabled segment's tooltip gives the same reason.
- Account security row: "Always emailed" when the server can send, otherwise
  "Inbox only — email isn't set up".
- Section copy: "Emails go to your contact email; account security notices go to your
  sign-in email. Your groups decide which categories can email you and when — here you
  can turn them down."
- A "View all notifications" link to the new `/notifications` page.

### 2. Only working channels show

- The portal treats **Email** as the only live channel (`LIVE_CHANNELS = ['email']`).
  Text, Push and Web are hidden in every list cell, chip, filter, export and modal.
  The API's channel list and stored data do not change.
- Saving group settings or member overrides preserves any hidden channel already stored.
- A group or member whose effective channels contain no live channel shows a "No email" chip.
- The "not available yet" notes go away with the hidden channels.

### 3. Categories on group lists

- System › Notifications group list: a default-on Categories column (chips in registry
  order; "None — inbox only" when empty), a Categories filter, search text and a
  "Categories" CSV column.
- /me "My groups" and "Join a group": a Categories column, so people see what joining gets them.

### 4. Send-time re-check

At delivery, an email that mirrors a notification is dropped (status `skipped`, with a
reason) when, by then:

| Reason code | Condition |
|---|---|
| `notification_gone` | the inbox row no longer exists |
| `hidden` | the person hid it in the portal |
| `read` | the person already read it in the portal *(Jimmy approved)* |
| `resolved` | its payload `state` is set and is not `pending` or `open` (the approval was decided) |
| `recipient_inactive` | person archived or account disabled |
| `category_turned_down` | the person's choice for the category is no longer Inbox + Email |
| `no_email_group` | no enabled group subscribed to the category has Email in their effective channels |

Never re-checked: account-security kinds (owner and admin copies alike) and emails that
are not notification mail (password resets, invites, learning emails). Timing is not
re-computed. When SMTP is not configured the existing `skipped` outcome gets the reason
`email_not_set_up`.

### 5. Bell, full page, decided approvals

- Bell header: a gear button ("Notification settings") to `/me/notifications`.
- Bell footer: "View all notifications" to `/notifications`.
- New page `/notifications` (any signed-in user; eyebrow "Account", title
  "Notifications", hint "Everything sent to you, newest first."): the same rows and row
  actions as the bell (approve/reject strips included), grouped Today / Yesterday /
  Earlier; All/Unread and category filters; Mark all read, Clear read, Settings; "Load
  more" paging instead of the 50-item cap. In the ⌘K palette as "All notifications"
  ("My notifications" becomes "Notification settings").
- When an approval is decided (membership request, router approval, password-reset
  card), every copy still open is marked read; it keeps showing who decided *(Jimmy approved)*.

### 6. One format

Quiet hours read like "9:00 PM – 7:00 AM CT" and days like "Daily", "Mon–Fri",
"Weekends" or "Tue, Thu" everywhere (the `formatQuietHours` / `formatDays` helpers).
Those list cells never wrap.

### 7. House controls and headers in the modals

- Group settings: Quiet hours Off/Custom and When blocked Defer/Skip become `.segmented`;
  Start/End become quarter-hour ComboBox pickers showing 12-hour labels (the learning
  schedule's `TIME_CHOICES`, moved to a shared module); an off-grid stored time is added
  as an extra option.
- Member overrides: each "Group default / Custom (/ None)" dropdown becomes `.segmented`;
  the group's value shows as a hint under the control.
- All notification modals (new group, edit group, group settings, member overrides,
  membership request, check delivery) get the standard header through one shared shell.

### 8. "Can email" matches sending

A person counts as reachable by email when they have a profile email **or** a sign-in
email — the same rule the sender uses. The unavailable note reads "No email address".

### 9. Delivery log (super admin and above)

**Storage.** A `notification_log` table (migration 0110) with one row per decision:
`id` (bigserial), `at`, `event`, `channel` (`inbox` | `email`), `person_id`,
`notification_id`, `outbox_id`, `kind` (notification kind or email template), `category`,
`reason` (code), `detail` (JSON), `process` (the writing process). Foreign keys use
`ON DELETE SET NULL`. Rows older than the Logging setting `local_max_age_days` are deleted
by the log-service retention pass. `email_outbox` gains `skip_reason`.

**Events.**

| Event | Written by | When |
|---|---|---|
| `inbox_written` | `notify()` | the inbox row was created |
| `inbox_suppressed` | `notify()` | not created: reason `category_off` |
| `email_queued` | `enqueue()` | an email entered the queue; `detail.send_at`, `detail.deferred`, and for notification mail the deferral reason (`quiet_hours` / `inactive_day`), the groups and the address source (`contact` / `login`) |
| `email_not_queued` | `maybe_email()` | a notification was not emailed: `email_not_set_up`, `unregistered_kind`, `kind_not_emailed`, `category_inbox_only`, `recipient_inactive`, `no_address`, `no_email_group`, `blocked_by_schedule` |
| `email_sent` | delivery | sent; `detail.attempt` |
| `email_skipped` | delivery | dropped by the re-check or because SMTP is off; reason from section 4 |
| `email_retry` | delivery | a send failed and will retry; `detail.attempt`, error class, SMTP code, next attempt |
| `email_failed` | delivery | gave up after the last attempt |

Every event is also written as a DEBUG line under the `serversherpa.notifications.log`
logger for developers; it reaches the process log only when the Logging minimum level is
lowered to DEBUG. Neither the row nor the line carries an email body or address; the API
shows the address an email went to by joining its outbox row.

**API (super admin and above).** `GET /notifications/log` — keyset paged (`rows`,
`next_cursor`, `total`), filters: search, event, channel, category, since, person,
notification, outbox email. `GET /notifications/check?person_id=&kind=&owner_copy=` —
explains, for one registered notification kind, without writing anything, what would
happen right now: inbox written or not, the email outcome (now / held until / not sent)
with its reason, the address and its source, and a verdict per group (subscribed, paused,
email channel, open / quiet hours / inactive day / urgent bypass, earliest send). For a
kind the account owner always receives (`owner_always`), `owner_copy` picks the owner's
own copy (default) or an admin's copy, which goes through groups. `GET
/notifications/kinds` lists the registered kinds (key, label, category, emailed or not,
owner-always, urgent) for the tool's picker. The email decision behind `maybe_email()` and
the check is one function, so they cannot drift.

**Portal.** System › Notifications gets tabs **Groups** (today's content) and **Delivery
log** (super admin and above only). The log is a standard list: When, Person,
Notification, Category, Channel, Outcome, Detail; filters for search, outcome, channel,
category and time range (24 h, 7 days, 30 days, all); "Load more" paging. Opening a row
shows that notification's (or email's) full trail in order, with links to the person and
the notification. A **Check delivery** button opens the dry-run tool (person +
notification type, plus Owner / Admin copy for owner-always types → explanation). Hint
copy: "Every notification and email decision — who, what and why."

## Calls made after the builder check (mine, not Jimmy's)

- Check delivery models one notification kind, not a whole category: a category mixes
  kinds with different rules (never-emailed kinds such as the password-reset card,
  security notices the owner always gets), so a category-only answer would be wrong for
  exactly the cases people troubleshoot.
- Each category carries an `email_source` (`groups` / `always`, later `direct`), mirrored
  in the portal, so /me stays honest when a category's email does not come from groups.
- The unmerged `project-plans` branch also uses migration 0110. Whichever branch merges
  second renumbers its migration and rechains it; that branch also adds a `plans`
  category, which takes `email_source = "direct"` when the two meet.

## Left to the builder

Component and file names beyond those fixed here, exact grid widths (within the fit
tests), icon choices, and the wording of event/reason labels other than those quoted.
