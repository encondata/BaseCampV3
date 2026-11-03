# Notifications Phase 2 — watching, groups as audiences, operational notifications, and status rules that notify

Date: 2026-11-02 · Branch: `notif-phase2`, stacked on `notif-phase1` (unmerged) · Status: **approved**. Jimmy asked for it without the questions ("Just propose it", 2026-11-02) and approved it as proposed ("ok that looks ok. lets build it", 2026-11-02).

Mockup: `.superpowers/brainstorm/2865-1793652529/content/phase2-screens.html` in the main checkout (git-ignored scratch). Where this document and the mockup differ, this document wins.

Built 2026-11-03. See `2026-11-02-notifications-phase2-as-built.md` for what was built, where it differs from this design, every decision made during the build, and the open questions.

## Why

Phase 0 made the notification screens honest and logged every decision. Phase 1 let each person decide what reaches them and when. One question is still answered only in code: **who hears about what.**

- **Recipients are hard-coded.** Every `notify()` call names its people: the requester, the approvers, the person whose account it is.
- **Only the wiki can be watched.** A person can watch a wiki page, folder or library. Nothing else in the portal can be watched.
- **Groups decide nothing.** Phase 1 left notification groups as plain member lists until this phase gave them a job.
- **Nothing operational notifies.** These happen silently:
  - a truck or an initiative changes status;
  - a kiosk, fixed reader or router stops checking in;
  - a background bulk action finishes or fails.

  The only device notice is a router waiting for approval.
- **Status rules can't tell anyone.** Off-move sightings reach the portal flagged, but no rule can act on them yet. The RFID scan design left that for later: "Jimmy will add a status rule for off-move scans to trigger notifications or other actions."

## What Jimmy asked for

- **2026-10-31:** notifications should let people "subscribe to events/things; email, SMS, later push; groups and time constraints integrated, not bolted on".
- **The phase plan from that review.** He has followed it so far: Phase 0, then Phase 1, then on 2026-11-02 "start on phase 2".
  - Phase 2 covers subscriptions, groups as real audiences, operational events and a notify action for status rules.
  - Text and push senders are Phase 3.
- **2026-10-16 (RFID scan processing):** an off-move status rule "to trigger notifications or other actions".
- **2026-10-17 (off-move alarm):** a station alarms about the same asset again only after **more than 1 hour**.
- **Standing rules:**
  - no invented features, copy, examples or scenarios;
  - mockups use neutral placeholders (Group A, Person A);
  - anything served for viewing is reachable on the LAN.
- **2026-11-02:** "Just propose it" (skip the questions).

## Goals

1. **Watch a thing.** Anyone can watch an initiative, site, truck or device they can see and hear what happens to it.
2. **Watch events everywhere.** Anyone can watch chosen event types across everything they can see.
3. **Groups are audiences.** A group watches things and event types the same way. Every member of an Active group hears; a Paused group delivers nothing.
4. **Operational notifications.** These new types each sit in a new category on the Phase 1 grid, so switches, the schedule, the summary, critical and the Delivery log apply unchanged:
   - initiative status changed;
   - truck status changed;
   - device offline;
   - bulk action finished or failed;
   - status rule matched.
5. **Status rules can notify,** including about off-move sightings.
6. **One list of what you watch.** /me lists everything a person hears about through their own watches and their groups', the wiki's included.
7. **Explainable.** The Delivery log says why each person got a notification and why someone with a watch didn't. The routes are: named in code, their own watch, a group, or a rule.

## Non-goals

- Text and push senders, and one queue for all channels (Phase 3).
- Channels or timing per watch. A person's grid and schedule decide how and when, for everything they get.
- Admins adding or removing another person's own watches. Admins reach people through groups.
- Making today's notifications watchable. Approvals, reports and labels, learning, wiki mentions and reviews, and account security keep the recipients they have.
- **Watching assets, containers or people.**
  - An asset's status is written in several places with no shared one (rule actions, asset edits, bulk updates, imports, rack re-checks), and rule-applied changes leave no audit row.
  - Status rules already sit on the asset checkpoints, so a rule's Notify action is the way to hear about assets (section 6).
- **Truck ETAs and lateness:** no ETA or appointment data exists.
- **Arrivals and departures at named stops:** they arrive as raw text, never matched to a site, and change no status.
- A MacroPoint poller or email ingest.
- Notices that a device came back online (question 2).
- Offline notices for kiosks that check in only while in use (phones, tablets, web kiosks, Label and Time Clock stations). See section 5.
- Any change to the station's own off-move alarm, to how devices report, or to the status page's ntfy alerts.

## Anti-goals

- **Nobody hears about a thing they can't see.**
  - Access is checked when the notification is written, and again before a queued or held email goes out.
  - The check is the one the thing's own page uses.
- **No floods.**
  - A person gets one notification per event type per sweep, however many events and watches match.
  - A status rule notifies about the same thing at most once an hour.
- **A watch never overrides a switch.** A category a person turned off stays off.
- **No invented copy, sample names or scenarios** in the portal, emails or docs.
- **No email body or address in a log row or log line** (Phase 0 rule).

## Constraints (house rules)

- American English in all copy, comments and docs.
- **Portal controls:** reuse the established ones (`Switch`, `.segmented`, ComboBox, chips, `DataTable`, `RowActionsMenu`, `.pf-form`). No raw native `<select>`, time input or bare checkbox in touched UI.
- **Watch control:** the portal's Watch button copies the wiki's `WatchButton`, so the product has one way to watch. That means Watch / Watching, `aria-pressed`, the eye icon and the same toast on failure.
- **Lists** follow the list-column-floors recipe and keep their fit tests. **Modals** keep the standard header (eyebrow, title, one-line description), rounded corners and portaled dropdowns.
- **"Admin and above"** and **"super admin and above"** mean what Phase 1 defined.
- **No new policy numbers:**
  - device offline uses the screens' own thresholds;
  - a status rule's repeat window is Jimmy's one hour from the station alarm;
  - the candidate cap is the wiki's `MAX_RECIPIENTS` (500);
  - sweeps run on the notification worker's existing one-minute tick.
- **Session discipline:** `notify()`, `record()` and the new `announce()` add to the caller's session and never commit.
- **Two copies of every worker.** Production runs two full stacks on one database (two DigitalOcean slots). Every new sweep claims its rows with `FOR UPDATE SKIP LOCKED`, as the summary sweep does.

## What changes

### 1. Watches

A **watch** says three things:

- **Who:** a person, or a notification group.
- **What:** one thing, or **Everything** (every thing of the right kind the person can see).
- **Which events:** every type that applies to that thing (the default), or a chosen list.

**What can be watched** (each is the check its own page uses today):

| Thing | Page | Who can see it |
|---|---|---|
| Initiative | `/initiatives/:id` | `initiatives:view` plus the client scope |
| Site | `/sites/:siteId` | `sites:view`, global |
| Truck | `/logistics/trucks/:id` | `trucks:view`, global |
| Device that checks in on its own: an RFID Station kiosk, a fixed reader, an approved router | kiosks: `/hardware/kiosks/:id`; readers and routers: their lists | the permission each device list requires |
| Wiki library, folder or page (section 7) | the wiki | the wiki's own access rule |

**Rules:**

- **One watch per subscriber and thing.** Watching again edits the events.
- **Everything names its events.** An Everything watch must name at least one type *(my call: nobody gets every event in the company by accident)*. A person or group has at most one Everything watch. Only types marked "everywhere" in section 5 can be chosen for it.
- **Events must fit.** Only watchable types can be chosen, and only those that reach the thing's kind.
- **Parents cover children** *(my call, like a wiki folder)*. A watch on an initiative also hears its child initiatives' events.
- **Access is not stored.** A watch whose owner loses access stays in place and stops producing notifications until access returns, as wiki watches do today.
- **Deleted things.** Deleting a thing deletes its watches.

### 2. Watching in the portal

**The Watch button.** It sits in the page header of initiatives, sites, trucks and RFID Station kiosks, for everyone who can open the page.

- Fixed readers and approved routers have no page of their own. Their row menus get "Watch" or "Stop watching".
- Other kiosks get no Watch button: nothing can be heard about them (section 5).
- Watch means every event that applies. To narrow it, use "Choose events…" on /me.

**/me › Notifications › "What you watch".** A new section under "When email reaches you".

- **Head:** "What you watch" with a count badge, and the hint "Things you watch and the ones your groups watch. What reaches you still follows your switches and schedule."
- **Button:** "Watch events everywhere…" opens the Everything editor. It reads "Edit events everywhere…" once the person has an Everything watch.
- **Table** (`DataTable`, list-column-floors):
  - **Watching:** the thing's name with its kind as a chip, linked to its page; or "Everything".
  - **Events:** "All events" or the chosen types' labels.
  - **Via:** "You" or the group's name.
  - **Since:** off by default.
- **Row actions** on the person's own watches: "Choose events…" and "Stop watching". A group's rows have none. Wiki rows have only "Stop watching", because the wiki has no event choice today.
- **Empty state:** "You aren't watching anything yet. Use Watch on a page to start."

**Choosing events.** A modal with the standard header:

- eyebrow "Watch", title the thing's name or "Everything", description "Pick the events you want to hear about.";
- an "All events" Switch ("Every event that applies to this."), on by default, which hides the list (not shown for Everything);
- otherwise the types that apply, grouped by category, each with a Switch;
- Save is disabled while nothing is picked.

### 3. Groups watch too

- **Group page:** a new "What this group watches" panel under Members, with the same table minus Via.
  - People with `notifications:change` get "Add watch" and the row actions "Choose events…" and "Remove".
  - Others with `notifications:view` see the list.
- **Add watch:** a modal with the standard header (eyebrow "Group A", title "Add watch", description "Pick what this group's members hear about.").
  - A `.segmented` strip picks Initiative, Site, Truck, Device, Wiki or Everything.
  - A ComboBox searches that kind's things. Its options list only what the admin can see.
  - Then the events editor follows, except for wiki things, which hear every page update and comment as today.
- **Who hears:** every member of an Active group. A Paused group's watches deliver nothing, which gives Pause a real job.
- **Members:**
  - see their groups' watches on /me (Via = the group);
  - to hear less, they switch a category off or ask to leave the group, as today.
- **Audit:** `notification_group_watch_add`, `_update` and `_remove`, on the group.
- **The hidden `categories` column is dropped** *(my call)*. Watches give groups their job, its values were test data, and they name categories that are never watchable.

### 4. How an event becomes notifications

**Announcing.** Code that sees an event calls `announce()`, new in `notifications/events.py`. It adds one `notification_events` row to the caller's session and never commits, so an event can't outlive a rolled-back change. The row holds:

- the type, and the **subject** (what it is about);
- **reaches:** the other things whose watchers hear it (section 5, per type);
- the **actor**, the person whose action caused it, if any;
- the **people and groups the code names**, if any (a status rule's recipients);
- whether **watches** apply (always, except a rule whose "watchers" option is off);
- the item's title, one-line text and link.

**Sending.** Every minute the notification worker sends what's waiting, oldest first, claiming rows with `FOR UPDATE SKIP LOCKED`. The device check (section 5) runs just before it in the same tick. For each event the candidates are:

1. the people the code named;
2. the members of the Active groups the code named;
3. when watches apply:
   - people whose own watch matches;
   - the members of Active groups whose watch matches.

A watch **matches** when its events are All or include the type, and either:

- its thing is the subject or one of the things the event reaches (an initiative's parents are worked out with the existing upward helper when the event is announced, and stored in `reaches`); or
- it is an Everything watch and the type may be watched everywhere.

Then, for each distinct candidate:

- **Never the actor,** unless the code named them (the wiki's rule).
- **Active accounts only:** not disabled, and the person not archived.
- **Access:** someone who can't see the subject now is dropped and logged `inbox_suppressed`, reason `no_access`. For a rule batch (section 6), access is checked per matched thing: someone who can see some of them hears about those, counted.
- **Cap:** at most `MAX_RECIPIENTS` (500) candidates per event, with a warning in the process log, as the wiki does.

**One notification per person per type per sweep.** The items that reach one person in one sweep become one notification per type. Status rules group per rule instead.

- **One item:** its own title, text and link.
- **Several:**
  - title "{type label} ({count})", or "{rule name} ({count})";
  - one line per item, oldest first. Status rules give one line per initiative with its count.
  - The link is the items' shared initiative when they all have one, else the type's list page.

`notify()` writes the notification, so the Phase 1 switches, schedule, summary and critical all apply unchanged. The inbox row's payload carries the event ids, the subjects and `via`.

**Re-check before email.** `recheck_notification` gains two reasons for these notifications, after `recipient_inactive` and before `category_turned_down`:

- `no_access`: the person can see none of its items any more;
- `not_watching`: nothing reaches them any more. No matching watch or group route is left, and the code didn't name them.

A third, `back_online`, applies to Device offline only (section 5). It runs where `resolved` runs today.

**Keeping events.** A sent event keeps `sent_at` and stays until the Logging retention (`local_max_age_days`) removes it, like the Delivery log.

**Read-only mode.** The sweep pauses with the other background services and catches up on resume.

### 5. The new notification types

| Type | Category | Raised when | Reaches | Everywhere |
|---|---|---|---|---|
| `initiative_status_changed` "Initiative status changed" | Initiatives | `PATCH /initiatives/{id}` changes the status | the initiative and its parents; its site and its origin and destination sites | yes |
| `truck_status_changed` "Truck status changed" | Trucks | a caller of `trucks/trip.apply_status_change`: the truck edit, bulk truck import, the MacroPoint manual update | the truck; its initiative and parents; its start and end sites | yes |
| `device_offline` "Device offline" | Devices | the device check sees an RFID Station kiosk, a fixed reader or an approved router stop checking in | the device; its site; its current initiative and parents | yes |
| `bulk_action_finished` "Bulk action finished" | Bulk actions | the import worker finishes a job that writes data | only the person who started it (named, not watchable) | no |
| `bulk_action_failed` "Bulk action failed" | Bulk actions | that job fails | the same | no |
| `status_rule_matched` "Status rule matched" | Status rules | a rule's Notify action (section 6) | the rule's people and groups; with "watchers" on, the rule's initiative and parents, and the scan's site | no |

**Initiative status changed.**

- **Text:** title "{initiative}: {from} → {to}", using the status labels.
- **Link:** the initiative.
- **Actor:** the editor.
- **Not announced:** creating an initiative.

**Truck status changed.**

- **Text:** title "{truck}: {from} → {to}".
- **Link:** the truck.
- **Actor:** the person who edited, imported or applied the MacroPoint messages.
- **Not announced:** creating a truck.
- **MacroPoint dates:** a manual update can apply hours-old messages. The line carries the message's own time.

**Device offline.**

- **Which devices** *(my call)*: only those that check in on their own, whether or not anyone is using them:
  - RFID Station kiosks (the station heartbeat runs with nobody signed in);
  - fixed readers (reported by their station);
  - approved routers.

  These are left out, because they check in only while in use, so a quiet stretch would read as an outage:
  - phone, tablet and web kiosks (they beat only while someone is signed in);
  - Label Stations (they update only when they upload scans);
  - Time Clock stations (they update only on clock-in and clock-out);
  - routers that are pending or revoked.

  Making them report on their own would change how devices report, which is a non-goal.
- **Offline means what the screens say:**
  - RFID Station kiosks: three minutes since they were last seen;
  - routers: four minutes;
  - fixed readers: three minutes, or at once when the laptop reports the reader unreachable.

  The kiosk and router thresholds live in the portal today. They move to the API and the portal mirrors them, with a pin test.
- **Once per outage:**
  - The check sets a new `devices.offline_notified_at` when it announces.
  - It clears the column once the device is seen again.
  - A device that has never checked in is skipped.
- **Rollout:** the migration marks every covered device already offline as notified, so deploying sends nothing for old outages.
- **Text:** title "{device} is offline", line "{kind} · last seen {time}".
- **Link:** the kiosk's page, or the readers or routers list opened on that row.
- **Actor:** none.
- **Back before the email went:** a queued or held Device offline email is dropped when every device in it has been seen again (re-check reason `back_online`, in the spirit of a decided approval's `resolved`). The inbox row stays.

**Bulk action finished or failed.**

- **Which jobs:** the import worker's three jobs that write data:
  - Bulk update assets (apply);
  - the From-To import (commit);
  - the move setup wizard (apply).

  Validation passes don't notify, since the person is reviewing them on screen.
- **Who gets it:** the person who started the job (`ImportJob.created_by`), always. Their Bulk actions switches decide the rest *(my call)*. Reports and labels have a per-run "Notify me" switch; these don't add one.
- **Text** *(my call)*:
  - title "{action} finished" or "{action} failed", where the action is "Bulk update assets", "From-To import" or "Move setup";
  - line: the initiative's name, when the job has one;
  - failed is title and link only, because the error text is internal.
- **Link** *(my call)*: none of the three jobs has a page of its own, and this phase adds none.
  - **Finished:** the result. A finished move setup links to the new move, a From-To import to the initiative's assets, and Bulk update assets to the Assets list.
  - **Failed:** the tool's page, to try again. A failed move setup keeps its editable draft for 24 hours, as today.
- **Sent by:** `notify()` directly, like `report_ready`.

**The grid.** Five categories join the Phase 1 grid, after Learning and before Account security, in /me, on the Defaults tab and in the Critical list:

| Category | Description |
|---|---|
| Initiatives | "Initiative status changes" |
| Trucks | "Truck status changes" |
| Devices | "Devices going offline" |
| Status rules | "Notifications from status rules" |
| Bulk actions | "Background bulk actions, finished or failed" |

- **Defaults:** on and on, like every Phase 1 default. Watching is already a choice to hear.
- **Critical:** nothing new is critical out of the box. Admins can mark these types critical on the Defaults tab.

### 6. Status rules: a Notify action, and off-move sightings

**The Notify action.** A new action, "Send a notification" (`notify`), appended to the catalog.

- **Parameters:**
  - `people`: person ids;
  - `groups`: group ids;
  - `watchers`: a switch, "Also people watching the initiative or site".
- **Validation:**
  - At least one of the three is required (`notify_no_recipients`).
  - Unknown people or groups are rejected on save (`unknown_person`, `unknown_group`). A group deleted later simply drops out.
- **What it does:** it announces `status_rule_matched`.
  - **Subject:** the matched asset, container or person.
  - **Reaches** (only when watchers is on): the rule's initiative and its parents, and the scan's site. The rule's initiative is the one in the rule's context, or a matched container's own initiative.
  - **Named:** the chosen people and groups.
  - **Actor:** the scan's operator, or the person who edited the status.
- **Text:** title "{rule name}: {matched thing}", line "{initiative} · {scan site}".
- **Link:** the matched thing's page. A grouped notification links to the rule on Status rules › Executions.
- **Repeats** *(my call, using Jimmy's station number):* a rule notifies about the same matched thing again only when it matches **more than an hour** after its last notification about it.
  - Re-scans and RFID re-reads would otherwise repeat it every time.
  - A small table, `status_rule_notified`, keeps the last time per rule and thing.
  - A skipped repeat shows in the rule's execution as not applied, reason `notified_within_hour`.
- **Batches:** inside one transaction, the matches of one rule on one initiative become one event carrying the count and the matched ids. A bulk asset update can run 15,000 rows in one transaction.
- **Transactions:** the action shares the scan's transaction. If a later action fails, the notification is rolled back with everything else.
- **Rule cache:** rules are cached for 60 s per process, so a changed rule's Notify takes effect within a minute.

**In the rule editor:**

- **New parameter types:** `people` and `groups` are ComboBox multi-pickers that search people and notification groups. `watchers` is a Switch.
- **`ParamControl`'s native `<select>`** for status and choice parameters becomes the ComboBox, since this work touches it *(house rule for touched UI)*.
- **The rule list's action summary:** "Notify Person A, Group A and watchers".
- **Permissions:** unchanged (`status_rules:add` and `change`, global).

**Off-move sightings.**

- **A new condition field:** `scan.off_move`, "Off-move sighting" (bool).
- **Which rules run:** an off-move sighting runs only the enabled rules whose conditions include "Off-move sighting equals Yes". Every other rule keeps skipping it, so today's rules behave exactly as before.
- **Actions:** those rules can use any action, Notify included (Jimmy: "notifications or other actions").
- **Initiative:** for an off-move sighting, the rule's initiative is the station's move, the one the sighting was uploaded for (`raw_scans.initiative_id`, passed through). The engine's in-progress guess isn't used *(my call)*.
- **The station's own alarm** is unchanged.

### 7. Wiki watches join

The wiki's watches move into the same table, so there is one system.

- **Data:** each `wiki_watches` row becomes a watch on that library, folder or page, and the old table is dropped.
- **Behavior kept:** these keep working as today; only the storage changes:
  - the wiki's Watch button and Watching page;
  - auto-watch on create, edit and review;
  - its fan-out, which stays in the request, with its own access rule (`recipients_who_can_view`).
- **What's new:**
  - wiki watches appear in /me's list;
  - a group can watch a wiki library, folder or page from the group page, and the wiki's fan-out includes those members.

### 8. Delivery log and Check delivery

- **`inbox_written` detail** gains:
  - `via`, the routes that reached the person: `direct`, `watch` (their own), `group:<id>` and `rule:<id>`;
  - `events`, the event ids.
- **New reasons:**
  - `no_access` on `inbox_suppressed`, and on `email_skipped` from the re-check, labeled "No access";
  - `not_watching` on `email_skipped`, labeled "Not watching any more";
  - `back_online` on `email_skipped`, labeled "Device back online".
- **The trail** shows the route: "Watching · their own", "Watching · Group A", "Rule · Rule A".
- **Check delivery** (super admin and above) keeps its person and type pickers; no thing picker is added *(my call)*.
  - For a watchable type, it lists the person's watches that would hear it: thing, events and via.
  - A fixed note says that whether it reaches them for a particular thing also depends on their access to it.

### 9. Data and migrations

**`notification_watches`**

| Column | Type |
|---|---|
| `id` | uuid |
| `person_id` | FK people ON DELETE CASCADE, null |
| `group_id` | FK notification_groups ON DELETE CASCADE, null |
| `initiative_id`, `site_id`, `truck_id`, `device_id`, `wiki_space_id`, `wiki_node_id` | FKs ON DELETE CASCADE, null |
| `kinds` | text[] NOT NULL DEFAULT '{}' (empty = all that apply) |
| `created_by` | FK people ON DELETE SET NULL |
| `created_at` | timestamptz |

- **Checks:**
  - exactly one of `person_id` and `group_id`;
  - at most one thing column set (none = Everything);
  - an Everything watch has at least one kind.
- **Unique:** one row per subscriber and thing, `NULLS NOT DISTINCT` (Postgres 16 in both stacks).
- **Indexes:** each thing column, for the fan-out lookup.

**`notification_events`**

| Column | Type |
|---|---|
| `id` | bigint identity |
| `kind` | text |
| `subject_type`, `subject_id` | text, uuid |
| `reaches` | jsonb, a list of `{type, id}` |
| `actor_id` | FK people ON DELETE SET NULL |
| `person_ids`, `group_ids` | uuid[] (named) |
| `watchers` | bool |
| `rule_id` | FK status_rules ON DELETE SET NULL, null |
| `item` | jsonb: title, line, link, and for a batch its count and ids |
| `created_at`, `sent_at` | timestamptz, `sent_at` null until sent |

- **Indexes:** waiting rows (`sent_at` null) in id order.
- **A rule batch** (section 6) has the initiative as its subject. Its `item` carries the matched things' kind, count and ids.

**`status_rule_notified`**: `rule_id` (FK status_rules ON DELETE CASCADE), `subject_type`, `subject_id`, `notified_at`. The primary key is the first three; the Notify action upserts it.

**`devices.offline_notified_at`**, timestamptz, null.

**Migrations,** numbered from `0113`, one per slice that needs one (see Build order):

- watches and events: the two tables;
- devices: the column, with the rollout marking;
- status rules: `status_rule_notified`;
- wiki: copies `wiki_watches` into watches, drops `wiki_watches` and `notification_groups.categories`.

The downgrades restore the schema. The wiki downgrade copies person watches back; group wiki watches and group categories come back empty.

**Merge note.** `notif-phase1` (0111, 0112) and `project-plans` are both unmerged. Whichever merges later takes the next free numbers and rechains.

### 10. API

**Your own watches** (signed in, under `/auth/me`):

- `GET /auth/me/watches`: own and group watches, each with `via`.
- `GET /auth/me/watches/state?thing=<kind>&id=<uuid>`: `{watching, watch_id, kinds}`, for the Watch button.
- `POST /auth/me/watches`: `{thing, id | null, kinds}`.
- `PATCH /auth/me/watches/{id}`: `{kinds}`.
- `DELETE /auth/me/watches/{id}`.

**A group's watches** (`notifications:view` to list, `notifications:change` to edit):

- `GET` and `POST /notifications/groups/{id}/watches`;
- `PATCH` and `DELETE /notifications/groups/{id}/watches/{watch_id}`.

**Errors:**

- `404 thing_not_found`, also for a thing the caller can't see, so nothing leaks;
- `409 already_watching`;
- `422`: `invalid_thing`, `invalid_kind` and `kinds_required` (Everything with none).

**Everything else:**

- `GET /notifications/settings` and `/notifications/kinds` report each kind's `watchable`, `everywhere` and `reaches`. /me and the editors need them.
- The wiki's watch routes keep their paths and shapes.
- Read-only mode blocks every write, as elsewhere.

## Build order

One branch, five slices, each landing working and tested:

1. **Watches and events:**
   - the two tables, `announce()` and the sweep;
   - access checks for initiatives, sites and trucks;
   - the re-check reasons and the Delivery log;
   - the API, the Watch button on initiatives, sites and trucks, /me's list and the group panel;
   - the Initiatives and Trucks types and categories;
   - Check delivery.
2. **Devices:** the device check, the column, the RFID Station kiosk Watch button, the reader and router row actions, and the Devices category.
3. **Bulk actions:** the two direct types and their category.
4. **Status rules:** the Notify action, the off-move condition, the editor changes, and the Status rules category.
5. **Wiki watches join.**

## Calls I made (not Jimmy's)

1. **"Watch," not "follow" or "subscribe":** it's the word the product already uses (the wiki).
2. **Events go out on the worker's one-minute sweep,** grouped per person and type. A burst becomes one notification, and fan-out never slows a save.
3. **An Everything watch must name its events.**
4. **A watch on an initiative covers its child initiatives.**
5. **The actor isn't notified about their own change,** unless the code names them (the wiki's rule).
6. **A watch survives a loss of access** and stops producing notifications until access returns (the wiki's rule).
7. **Assets and containers can't be watched in this phase.** Status rules cover asset checkpoints.
8. **Truck notifications are status changes only.** Leaving the pickup and arriving at the drop-off are already status changes (In Transit, At Destination).
9. **Status rules notify about the same thing at most once an hour,** reusing Jimmy's station rule.
10. **A rule batch inside one transaction is one event.**
11. **Off-move rules can use any action,** and their initiative is the station's move.
12. **The rule editor's native select becomes the ComboBox.**
13. **Bulk actions always notify whoever started them;** the category switch is the way out.
14. **Groups' hidden categories are dropped,** not turned into watches.
15. **Wiki watches move into the shared table** and keep their behavior. Groups can watch wiki pages.
16. **New categories default to on and on,** and nothing new is critical.
17. **Device offline covers only devices that check in on their own:** RFID Station kiosks, fixed readers and approved routers.
18. **A Device offline email is dropped if the devices are back before it goes.**
19. **Bulk-action notifications link to the result or the tool.** No job pages are added. Their titles are "{action} finished" and "{action} failed".
20. **Check delivery gets no thing picker.**

## Questions for Jimmy (settled)

1. **Automatic watching.** The wiki watches what you create, edit or review for you. Should people on an initiative's People tab watch it automatically? Most workers can't open initiatives, so it would mostly reach staff and client users.
2. **Back online.** Should people watching a device also hear when it comes back?

Both were planned as no, and Jimmy approved the design as proposed (2026-11-02), so both are no: being on an initiative's People tab adds no watch, and there is no "Device back online" type.

## Left to the builder

- Module, component and function names beyond those fixed here.
- How `can_view` is built for each kind. It must make exactly the decision the thing's own page makes, from `resolve_access_many` and `scope_conditions`.
- The order of rows in the watch tables (newest first is fine).
- Wording of log and Check delivery labels other than those quoted.
- How the portal mirrors `reaches` and the device thresholds, which must agree with the API.
