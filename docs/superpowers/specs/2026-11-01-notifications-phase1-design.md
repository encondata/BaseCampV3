# Notifications Phase 1 — your own settings, company defaults, critical notifications and a summary email

Date: 2026-11-01 · Branch: `notif-phase1` · Status: approved by Jimmy in chat (answers on 2026-11-01, then mockup v2: "Go ahead and write up the phase one design from V2 and build")

Mockup: `.superpowers/brainstorm/63563-1793571434/content/phase1-screens-v2.html` in the main checkout (git-ignored scratch). Where this document and the mockup differ, this document wins.

## Why

The 2026-10-31 review found the notification plumbing sound but the model bolted together:

- **Groups gate email.** A person gets non-security email only if a notification group subscribes to the category.
- **Timing lives on groups.** Quiet hours sit on groups, with per-member overrides, and the most permissive group wins.

Phase 0 (merged to main as `eb3da266`) made the screens honest and logged every decision. Phase 1 moves the decision to the person:

- **What:** each person's own switches decide what reaches them, starting from company defaults that admins set.
- **When:** each person's own schedule decides when email arrives.
- **Held email:** email that has to wait arrives as one summary.
- **Groups:** they stop deciding anything until Phase 2 gives them a job.

## Jimmy's decisions (2026-11-01)

- Defaults for the grid are set by an admin or above.
- Existing group quiet hours were test data. Ignore them and migrate nothing.
- Email held during quiet hours or a non-working day goes out an hour before the person is back online, as one email.
- What counts as critical is not decided yet. The mechanism ships, and nothing new is marked critical.
- Groups: "whichever means less impact or less rework at Phase 2". My call, which Jimmy accepted: plain member lists that keep their status.
- Mockups and designs contain only what he has asked for. No invented features, examples or scenarios.
- Mockup v2 is the basis for this design.

## Goals

1. Email no longer depends on group membership. A person's grid decides Inbox and Email for each category.
2. Company defaults for the grid, set by admins and above. Switches a person hasn't changed follow the defaults, including later changes.
3. One personal schedule: timezone, days they work, quiet hours.
4. Email that waits goes out as one summary an hour before the person's day starts.
5. Admins and above can mark notification types critical. Critical email never waits.
6. Groups keep their name, description, status (Active/Paused), members, and join/leave requests. Their delivery settings and member overrides go.
7. Every decision, including holding and the summary, is in the Delivery log, and Check delivery explains the new decision.

## Non-goals

- Subscriptions and follows, groups as audiences, operational events, and a status-rule notify action (Phase 2).
- Text and Push senders, and one queue for all channels (Phase 3).
- Admins editing another person's switches or schedule.
- A company default schedule (shown as a suggestion in mockup v1 and dropped).
- Changing who receives a notification. Recipients are still chosen in code.
- Learning emails' own send times, password reminders, invites and password resets. They are template mail and keep their timing.
- Any priority level other than critical.
- The Phase 0 leftovers that this work does not touch (the /notifications page items, house-wide tab and row keyboard work).

## Anti-goals

- An admin's change to a default never overwrites a switch a person set themselves.
- Account-security notices are never held, never re-checked, and can't be turned off.
- Nothing is lost silently. Every held email either goes out in a summary or is dropped with a logged reason.
- No invented copy, sample names or scenarios in the portal, emails or docs.
- No email body or address in a log row or log line (Phase 0 rule).

## Constraints (house rules)

- American English in all copy, comments and docs.
- **Portal controls:** reuse the established ones (`Switch`, `.segmented`, ComboBox, chips, `DataTable`, `RowActionsMenu`, `.pf-form`). No raw native `<select>`, time input or bare checkbox in touched notification UI.
- **Timezones and times:** timezone pickers offer every IANA zone through ComboBox (`timezoneOptions()`). Time pickers use the shared quarter-hour `lib/timeChoices.ts`.
- **Lists:** every list touched follows the list-column-floors recipe and keeps its fit test. Modals keep the standard header (eyebrow, title, one-line description), rounded corners and portaled dropdowns.
- **System settings pattern:** admin edits save through one Save button per section, disabled until something changes (as in `BrandingControls`). Errors are sentences, and `read_only_mode` shows its server message.
- **"Admin and above"** means global access and `max_rank >= 60` (`GATE_BYPASS_RANK`), the rule Bulk Actions uses (`require_bulk_rank`). It gets one shared helper next to `ensure_super_admin`. **"Super admin and above"** stays global plus `max_rank >= 80`.
- **No new policy numbers.** The one-hour summary lead is Jimmy's. The summary sweep runs every 60 s, like the learning sweep.
- **Session discipline:** `notify()`, `enqueue()`, `record()` and the new hold writer add to the caller's session and never commit.

## What changes

### 1. The grid: what reaches you (/me › Notifications)

A table with one row per category (Approvals & requests, Reports & labels, Wiki, Learning, Account security) and two switches per row, **Inbox** and **Email**.

- **Following the default:** a switch the person hasn't changed follows the company default, and the row says "Company default".
- **Your choice:** once a switch differs from the default, the row says "Your choice" with a "Use company default" link that clears the person's values for that row.
- **Flipping back:** flipping a switch back to the default's value makes it follow the default again.
- **Admin changes:** a later admin change to a default reaches every person who hasn't changed that switch. It never touches a switch they set themselves, even one that happens to equal the new default.
- **Email needs Inbox** *(my call; it keeps today's three states)*. Effective Email = (the person's Email, else the default's) **and** effective Inbox. While Inbox is off, the Email switch shows off and disabled ("Turn on Inbox to get email"). Turning Inbox back on restores whatever Email was.
- **Account security** shows "Always" in both columns. The owner's own notices are always written to the inbox and always emailed, and never held. Admins' copies (the copy of `totp_enrolled` sent to everyone who can manage users) are written to the inbox only, never emailed (see §5).
- **Never-emailed kinds keep their inbox row.** Kinds that are never emailed (`password_reset_request`, `learning_quiz_locked`) keep their inbox row even when the category's Inbox is off, as today.
- **Email not set up:** when the server can't send email, the Email column is disabled with the Phase 0 reason ("Email isn't set up on this server"), and the existing hint stays.
- **Descriptions:** each row's description lists only the kinds that exist today:
  - Approvals & requests: "Group membership requests and decisions, routers waiting for approval"
  - Reports & labels: "Reports and label runs, ready or failed"
  - Wiki: "Page updates, comments, mentions, reviews and exports"
  - Learning: "Learning completed or overdue, quizzes locked"
  - Account security: "Password expiring and two-factor notices about your own account"
- **Critical note:** under the table, "Critical notifications still follow these switches, but skip your quiet hours, days off and the summary email. Your admins choose which are critical. Right now: …", listing the critical kinds' labels.
- **Section copy:** the head keeps "Emails go to your contact email; account security notices go to your sign-in email." and adds "Switches you haven't changed follow the company defaults." The "View all notifications" link stays. The Sound row stays as it is.

**Storage.** `user_accounts.ui_prefs` JSON, under `notif`. It holds `sound` (unchanged) plus:

- `switches`: `{category: {inbox?: bool, email?: bool}}`, holding only the person's own values. An absent key means "follows the default". The security category and unknown categories are dropped on read.
- `schedule`: see §3.

**Migrating today's choices.** The old `notif.categories` is converted and removed by the migration:

- `email` → nothing, so the switch follows the default (out of the box the defaults are all on, which equals today's `email`).
- `inbox` → `{email: false}`.
- `off` → `{inbox: false, email: false}`.

The legacy keys `critical`, `email`, `maint` and `digest` still sitting in raw JSON are stripped, so they can never leak into new fields. A person without an account has no prefs, so the defaults and an empty schedule apply.

### 2. Company defaults (System › Notifications › Defaults)

A **Defaults** tab on System › Notifications, visible to admins and above.

- **Tab strip:** admins see Groups and Defaults. Super admins see Groups, Defaults and Delivery log. Everyone else with `notifications:view` sees the Groups content with no strip.
- **URL:** `?tab=defaults` selects the tab. An unknown or disallowed value falls back to Groups.
- **Header hint for this tab:** "What everyone gets until they change it, and which notifications can't wait."

The tab has two sections. Each has its own Save button, disabled until something changes.

1. **What people get by default.** The same category × Inbox/Email grid, with the same Email-needs-Inbox rule and Account security as "Always". Out of the box every default is on (today's behavior).
2. **Critical notifications.**
   - **List:** every kind that can be emailed, as Notification, Category (chip) and Critical (switch), in registry order. The two security kinds show "Always" instead of a switch.
   - **Foot note:** "Password reset requests and Quiz locked are never emailed, so they aren't listed."
   - **Defaults:** out of the box only the security kinds are critical.

**Storage.** A `system_config` section `notifications`, with `DEFAULTS`:

- `defaults: {approvals, reports, wiki, learning: {inbox: true, email: true}}`
- `critical_kinds: []`

The security kinds are always critical in code and are never stored. Unknown keys are ignored on read.

**API.**

- **`GET /notifications/settings`** (any signed-in user) returns `{defaults, critical_kinds, kinds}`. `kinds` is every registered kind with `kind, label, category, email, owner_always, critical, locked`. /me needs this to show the defaults and the critical list.
- **`PUT /notifications/settings`** (`notifications:change` plus admin and above) takes a partial body `{defaults?, critical_kinds?}` and returns the whole settings.
  - **422 codes:** `invalid_category` and `invalid_kind` (unregistered, never emailed, or a security kind).
  - **Audit:** `entity_type="system"`, `entity_id="notifications"`, action `notifications_config_update`, with `{from, to}` changes.
  - **Read-only mode:** blocks the PUT, as for other system settings.

### 3. Your schedule: when email reaches you (/me › Notifications)

A second card, "When email reaches you", with this copy: "Email that arrives during quiet hours or on a day off waits, then comes as one summary an hour before your day starts. Your inbox in the portal still updates right away."

- **Timezone:** a ComboBox over every zone. Unset means the company reference zone `America/New_York` (`services/timezone.DEFAULT_TIMEZONE`, mirrored in the portal), and the picker shows it.
- **Days you work:** seven day toggles. Out of the box all seven are on. At least one must stay on; the UI blocks saving with "Pick at least one day.", and the API rejects an empty list.
- **Quiet hours:** a Switch plus Start and End quarter-hour ComboBoxes, disabled while the switch is off. Out of the box they are off. Start and End must differ, and an overnight window (start later than end) is allowed.
  - **Turning the switch on** proposes no times. The Start and End pickers start empty, and nothing is saved until both are picked and differ. Until then, the summary line is replaced by the hint "Pick a start and end time." *(my call: no invented hours)*.
  - **Turning it off** saves both times as cleared.
- **Summary line:** a shaded line under the controls shows the rule. Quiet hours "cover midnight" when the window wraps past midnight or starts at 12:00 AM.
  - **Quiet hours on, all days on, or days off and the quiet hours cover midnight:** "Email that waits arrives as one summary at {End − 1 h} {zone abbreviation}, an hour before quiet hours end on a day you work."
  - **Quiet hours on, some days off, and the quiet hours don't cover midnight** *(my call)*. These give two summary times, so the line uses both sentences: "Email that waits during quiet hours arrives as one summary at {End − 1 h} {zone}. Email from days off arrives as one summary at 11:00 PM {zone} the night before the next day you work."
  - **Quiet hours off, some days off:** "Email from days off arrives as one summary at 11:00 PM {zone} the night before the next day you work."
  - **No quiet hours, all days on:** "No quiet hours and no days off, so email always goes out right away."
  - Every version except the last ends with "Critical notifications never wait."
- **Saving:** like the rest of /me, each change saves at once through `PUT /auth/me/preferences`, with the existing save hint.

**Storage.** `notif.schedule = {timezone: str | null, days: [mon..sun] (≥ 1, default all), quiet_start: "HH:MM" | null, quiet_end: "HH:MM" | null}`.

- **Validation:** an invalid zone is `invalid_timezone`, an empty or unknown day list is `invalid_days`, and only one of the pair set, or start equal to end, is `invalid_quiet_hours`.
- **Bad stored zone:** a stored zone that later fails to load falls back to the reference zone, as `_safe_timezone` does today.

### 4. Holding and the summary email

**When email is held.** This applies to notification mail that is not critical and not an owner's account-security copy. It is held when, in the person's timezone at the moment it is decided:

- today is not one of their days (reason `inactive_day`), or
- the time falls inside their quiet hours (reason `quiet_hours`).

Day off takes precedence. The quiet window is `[start, end)` and may wrap past midnight.

**Back online and the summary time.**

- **Back online** is the first moment after the hold at which the person's schedule is open again: quiet hours over, on a day they work. With no quiet hours, it is 12:00 AM of their next working day.
- **The summary time** is one hour before back online *(Jimmy's rule)*. For someone with days off and no quiet hours, that is 11:00 PM the night before *(my reading, shown in v2)*.
- **The last hour** *(my call)*. An email that arrives after the summary time but before back online (the last hour of quiet hours) is not held. It is sent right away, because that morning's summary has already gone.

**Storage.** Held email is not rendered or queued at notify time. A new table `notification_held` holds one row per held email:

| Column | Type |
|---|---|
| `id` | uuid |
| `person_id` | FK people ON DELETE CASCADE |
| `notification_id` | FK notifications ON DELETE SET NULL, so a deleted notification is dropped with a logged reason |
| `kind` | text |
| `category` | text |
| `reason` | text, `quiet_hours` or `inactive_day` |
| `held_at` | timestamptz |

It is indexed on `(person_id, held_at)`. Rows are deleted once they are handled; the history lives in `notification_log`.

**The summary sweep.** The notification-worker runs it every 60 s. For each person with held rows:

1. **Is it due?** It computes the summary time after their oldest `held_at`, from their schedule *as it is now*. A schedule change therefore applies to email already waiting, and a schedule that is now always open makes it due at once. If it is not due yet, the person is skipped.
2. **Re-check each held item, oldest first.** This uses the Phase 0 re-check, shared with `recheck_before_send`: `notification_gone`, `resolved`, `hidden`, `read`, `recipient_inactive`, plus `category_turned_down` (the effective Email switch is now off). It also checks `email_not_set_up` and `no_address`. A dropped item is logged `email_skipped` with that reason and deleted.
3. **Send the rest as one email.** Template `notification_summary` (template mail, `kind = None`, never re-checked again), sent now to the person's usual notification address. The email is always one summary, even for a single item *(my call: one code path)*.
   - **Subject:** "Your notification summary ({count})".
   - **Body:** "Hi {name}," and "Here's what arrived during your quiet hours or day off:", then one line per item, oldest first: category label · title, with its link. Bodies are left out, so brief kinds need no special case.
   - **Footer:** "Change what you receive and when: {prefs_url}".
   - Each item is logged `email_summarized`, with `outbox_id` pointing at the summary email, and its held row is deleted.
4. **Commit per person.** Rows are claimed with `FOR UPDATE SKIP LOCKED`.

**The notification email footer** stops naming groups: "You get these emails from your notification settings. Change what you receive: {prefs_url}". The pinned phrase "Change what you receive" stays.

### 5. Critical notifications

A kind is critical when it is in the account-security category (always, locked) or listed in `critical_kinds`. A critical email skips holding: it is sent right away whatever the schedule says. It **still obeys the person's switches** (Inbox and Email off mean no email).

- **Owner copies:** the owner's account-security copy (`owner_always`) is unchanged. It is sent at once and never re-checked.
- **Admin copies** of `totp_enrolled` go to everyone with `users:change`, which by default includes staff. They used to email only through a group subscribed to Account security. Now they stay in the inbox and are never emailed. The new not-queued reason is `admin_copy`, labeled "Admin copy — inbox only".
  - *My call:* this keeps today's effective behavior, since without such a group these copies were already inbox-only. It avoids an email to every staff member on every two-factor enrollment, which can't be turned off.
  - Flagged for Jimmy in case he wants these copies emailed.
- **Retired:** `KindInfo.urgent` and the group `urgent_bypass` give way to this. `/notifications/kinds` reports `critical` and `locked` instead of `urgent`.

### 6. Groups become member lists

**Kept:**

- name, description, status (Active/Paused; a paused group still drops out of /me's join list), members;
- join/leave requests and their inbox approvals;
- the `categories` column, which is kept but hidden. The API keeps reading and writing it, and nothing in the UI shows it, in case Phase 2 uses it.

**Removed** *(my call to drop the columns, since Jimmy called the data test data)*:

- **Group columns:** `channels`, `quiet_start`, `quiet_end`, `timezone`, `active_days`, `dnd_behavior`, `urgent_bypass`, and their CHECKs.
- **Member override columns:** `channels`, `quiet_mode`, `quiet_start`, `quiet_end`, `timezone`, `active_days`, `dnd_behavior`, `urgent_bypass`, and their CHECKs.
- **Override endpoints:** `PATCH /notifications/groups/{id}/members/{pid}` and `PATCH /auth/me/notification-groups/{id}/overrides`.
- **Code and response fields:**
  - `effective_settings`;
  - the delivery fields on group, member and my-group responses;
  - the `channels` field on the user page's notification groups.

**Portal:**

- **Groups list** (System › Notifications): columns Name, Description, Members, Status, Created (off by default). The Categories, Channels, Quiet hours and Days columns, facets, search text and CSV columns go.
  - **Header hint:** "Notification groups and who's in them."
  - **New group dialog description:** "Name the group. Members come next."
- **Group page:** the "Delivery defaults" panel and its Delivery settings window go. So do the hero's channel chips, the members table's channel, quiet hours and days columns, the Override markers, and the member Edit action. Remove stays. Edit group (name, description), Pause/Resume and Delete stay.
- **/me My groups and Join a group:** columns Group, Members, Status (request state). The overrides action and the "Customized" chip go.
  - **My groups hint:** "The notification groups you belong to. Groups don't change what you get."
  - **Join a group hint:** "Search other notification groups and ask to join."
- **User page notification groups:** the table loses its Channels column.

### 7. Delivery log and Check delivery

**Events.** `EVENTS` gains two, with the database CHECK updated:

| Event | Written by | Meaning |
|---|---|---|
| `email_held` | `maybe_email()` | Held. Reason `quiet_hours` or `inactive_day`; `detail.summary_at` |
| `email_summarized` | summary sweep | Went out in a summary; `outbox_id` = the summary email |

**Reasons.**

- **Retired:** `no_email_group` and `blocked_by_schedule` are no longer produced. Their labels stay so old rows still read well.
- **New:** `admin_copy` (see §5) is a new `email_not_queued` reason.
- **Switch source:** `category_off` and `category_inbox_only` now come from the effective switches, with `detail.source` set to `default` or `own`.
- **`email_queued` detail for notification mail:** `via`, plus `critical: true` when holding was skipped for critical, `owner_copy: true` for owner copies, and `after_summary: true` for the last-hour case. The `groups` key is gone.

**Portal labels and trail.**

- **Labels:** `email_held` is "Held for summary" (amber), and its detail reads "Until {summary time} · {reason}". `email_summarized` is "In summary" (blue).
- **Trail:** a notification's trail shows inbox → held → in summary (or dropped). The summary email's own trail (by `outbox_id`) shows queued → sent.
- **Old rows:** queued rows from before Phase 1 that carry `detail.deferred` still read "Held until …".

**Check delivery** (super admin and above) answers, for one person and one kind (plus Owner/Admin copy for owner-always kinds), what would happen right now. The groups table goes. It shows:

- **Inbox:** written, or suppressed, with the source (Company default or Their choice).
- **Email:** the outcome (now, held until {summary time}, or not sent), with its reason, the address and the address source.
- **Their switches** for the category: Inbox and Email, each on or off, with its source: Company default, Their choice, or Always for security.
- **Their schedule:** timezone, days, quiet hours, and whether they are open, in quiet hours or on a day off right now.
- **Critical:** yes or no.

`DeliveryCheckOut` drops `groups`, `email_source` and `choice`, and adds `switches`, `schedule`, `critical` and `summary_at`. `send_at` stays for the "now" outcome.

### 8. Migrations

Two migrations keep every step of the build green:

| Migration | Changes |
|---|---|
| `0111` (additive) | Creates `notification_held`. Widens `ck_notification_log_event` to the 10 events. Converts `ui_prefs.notif.categories` to `notif.switches` and strips the legacy keys |
| `0112` | Drops the group and member delivery columns and their CHECKs |

Both downgrades restore the schema. Data that was dropped is not restored.

**Merge note.** The unmerged `project-plans` branch is to renumber its old 0110. Whichever branch merges second takes the next free numbers and rechains. When the two meet, the `plans` category simply joins the grid, defaulting to on and on, and needs no `email_source`.

## Calls I made (not Jimmy's)

1. **Email needs Inbox.** This keeps today's three states (Inbox + Email, Inbox only, Off) and the inbox row that the email links to.
2. **Admin copies of Account security notices stay in the inbox only** (reason `admin_copy`). By default they reach every staff member, and an always-on email would flood. Flagged.
3. **The last hour of quiet hours sends right away,** instead of being held a full day.
4. **One code path for the summary.** A summary with one item is still a summary.
5. **The default timezone** is the company reference zone, `America/New_York`.
6. **Group and member delivery columns are dropped,** not hidden. Group categories are hidden, not dropped.
7. **Today's /me choices are converted to switch values,** and legacy prefs keys are stripped.
8. **Admin and above** is global plus rank ≥ 60, one helper.
9. **Held email is a reference,** not a pre-rendered queued email. It is rendered into the summary at send time.
10. **Turning quiet hours on proposes no times.** Nothing saves until both are picked, with the hint "Pick a start and end time."
11. **Quiet hours that don't cover midnight, with days off,** show both summary sentences.

## Left to the builder

- Component, module and function names beyond those fixed here.
- Exact grid widths within the fit tests.
- The order of the summary's lines within the oldest-first rule.
- The wording of log and Check delivery labels other than those quoted.
- The worker's idle status line.
- How the portal mirrors the summary-time rule. It must agree with §3 and §4.
