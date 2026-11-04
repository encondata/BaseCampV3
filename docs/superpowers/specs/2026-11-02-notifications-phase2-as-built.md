# Notifications Phase 2: as built

Companion to `2026-11-02-notifications-phase2-design.md` (approved 2026-11-02). It records what was built, where it differs from the design, every decision made during the build, the wording added, the open questions, and how to deploy it.

- **Branch:** `notif-phase2`, stacked on the unmerged `notif-phase1` (0468afe7).
- **Size:** 56 commits from fdcc3ac6 to 9d714279, plus this note; 159 files.
- **Migrations:** 0113 to 0116, on top of Phase 1's 0111 and 0112.
- **Plans:** `docs/superpowers/plans/2026-11-0{2,3}-notifications-phase2-slice{1..5}.md`. Each plan's "Calls this plan makes" section stands as built.

## What was built

1. **Watches and events (slice 1).**
   - `notification_watches` holds a person's or a group's watch on an initiative, site or truck, or on Everything (by event type). `notification_events` is an outbox written by `announce()`.
   - The notification worker sweeps the outbox every minute. It sends one notification per person and event type per sweep, through `notify()`, so Phase 1's switches, schedule, summary and critical rules apply.
   - Initiative and truck status changes announce.
   - Portal pieces: the Watch button on initiative, site and truck pages; "What you watch" on /me; group watches on the group page; and watch routes in the Delivery log and Check delivery.
   - Migration 0113 also drops the groups' hidden `categories`.
2. **Devices (slice 2).**
   - "Device offline" covers RFID Station kiosks (laptop + rfid), every fixed reader and approved routers. The thresholds are 3, 3 and 4 minutes.
   - A device announces once per outage. The queued or held email is dropped if every device in it is back.
   - The check stays quiet while read-only mode is on, for 4 minutes after it, and for 4 minutes after the worker starts.
   - Devices can be watched from the kiosk detail page, Fixed Readers and Routers.
   - Migration 0114 adds `devices.offline_notified_at` (devices already offline are marked at migration time) and `notification_events.attempts`.
3. **Bulk actions (slice 3).** The person who committed a background bulk action, and the uploader when that's someone else, hear when it finishes or fails (asset bulk update, move assets, move setup, From-To import). A From-To import that left rows out says how many.
4. **Status rules (slice 4).**
   - A "Send a notification" action goes to people, groups, and optionally people watching the initiative or site. It sends at most once an hour per rule and thing (migration 0115).
   - Matches are grouped per rule. Each person's text names only what they can open.
   - Off-move sightings run the rules that ask for them ("Off-move sighting equals Yes").
   - The rule editor uses the house pickers. Executions can be filtered by rule.
5. **Wiki fold-in (slice 5).**
   - Migration 0116 moves `wiki_watches` into `notification_watches` and drops the old table.
   - The wiki's Watch button, Watching page, auto-watch and in-request fan-out behave as before.
   - Groups can watch a wiki library, folder or page. Their members join the fan-out.
   - /me lists wiki watches.
   - A held or queued wiki email is re-checked for access before it goes out.

## Where it differs from the design

- **The group page lists only what the viewer can open.** This applies to every row: a private wiki page, a page in the trash, or a thing the admin can't open is left out. PATCH and DELETE on such a row answer "not found". Slice 1 had left this list unfiltered; the wiki's private pages made the filter necessary.
- **Wiki emails are re-checked before they go out.** The design's re-check covered only the sweep's notices. A held or queued wiki email is now dropped as "No access" when the reader can no longer open the page. This follows the design's first anti-goal.
- **The wiki logs people it leaves out for access.** It writes `inbox_suppressed` / `no_access` for every active person it leaves out for access, as the sweep does, so the Delivery log can explain a group member who didn't hear.
- **Removing a wiki watch from /me writes the wiki's own audit.** So does adding one. Your own watches on portal things are audited too, since answer 2 (`watch.add`, `watch.update` and `watch.remove` on your account).
- **`notification_events.attempts`.** The sweep claims events ordered by failures, then age, so an event that always fails can't block the queue. This is not in the design.
- **One Notify action per rule.** A second one is refused.
- **Yes/no conditions in the rule editor.** They offer only "equals". "Asset has rails", which can be empty, also offers "is null" and "is not null".
- **Counted rule notices.** They link to the rule's executions only for people who can open Status rules.
- **Inbox links.** In the portal and the wiki, only web addresses and the app's own paths become links. Anything else opens the home page. That includes "javascript:", "//host", and a same-site address whose path starts with "//".

## Decisions made during the build

Each decision is listed with what it costs if it's wrong.

**Watches, events and the sweep**
- Status-change events carry the old and new status and the actor. A deleted subject is dropped silently. Up to 500 candidates are kept before access filtering, as the wiki does. *Cost:* small rework.
- An "Active" group is an enabled one; an active account follows the wiki's rule (has a login, not disabled, not archived). *Cost:* a predicate.
- /me lists only things the person can open now, and only enabled groups' watches. *Cost:* none.
- The watch tables use the house DataTable without a "Since" column. *Cost:* a column.
- Audit names: `watch.add`, `watch.update`, `watch.remove` on the group. `watch.update` records the thing and the change of events. *Cost:* none.
- The send-time re-check lives beside the sweep's candidate code and never pairs subjects with events by position. *Cost:* a module move.
- A retried event keeps its place in a grouped notification. Always-failing events drop behind newer ones (`attempts`). *Cost:* one column.
- In the trail, routes read own watch first, then groups, rules and named people. The API logs them sorted. *Cost:* one sort.
- Kind chips use the neutral "tag" chip. *Cost:* none.
- A Remove on a group watch has no confirm, like /me's Stop watching. *Cost:* one confirm later.

**Devices**
- RFID Stations are covered whatever their station key. A deliberate Clear Setup reads as one offline notice. *Cost:* one predicate.
- The quiet window uses UTC time throughout. It starts with the worker, so an outage in a worker's first 4 minutes is told up to 4 minutes late. *Cost:* that delay.
- Router names in notices and watches match the Routers page (the portal's `routerDisplayName`, ported to the API). *Cost:* one helper.
- Reader "offline at once" (a probe timeout) is kept as the design says. See open question 1. *Cost:* noise from flapping readers.

**Bulk actions**
- A cancelled job is silent, and so is a job with no owner. A From-To import with row errors counts as "finished". *Cost:* small rework.
- "Rows not imported" counts both errors and rows sent to review, matching the import page's own "skipped". *Cost:* narrowing it later.
- A failed bulk action's notice is title and link only. The notice is sent after the job's last commit, in its own session; a failure there is logged. *Cost:* none.

**Status rules**
- A batch's names and links are looked up at its first match, and the commit hook only announces. Access is checked once per person per batch. *Cost:* none.
- Notices are written per person: the initiative's name only if they can open it, the scan site's only if they can open that. *Cost:* less text for some people.
- The payload's subjects list is short: the events' subjects, not every matched thing. *Cost:* none.
- "Rule A (1)" when a person can open one thing of a batch. A deleted rule's notices read "Status rule matched (n)" with no link. *Cost:* wording.
- Executions show "Notified within the hour" for the repeat guard. *Cost:* one string.

**Wiki**
- The two wiki thing types are `wiki_space` and `wiki_node`. Their watches take no event choice: they hear every update and comment, as before. *Cost:* none.
- Ids survive migration 0116 in both directions, so open wiki pages and old audit rows stay valid. *Cost:* none.
- The wiki's own Watch button and Watching page show only the person's own watches. A group's watch shows on /me with Via the group. *Cost:* none.
- Wiki access for notifications follows the wiki's watch rule: a never-published page is hidden from view-only readers. *Cost:* such a watch appears once the page publishes.
- People in a comment thread come before watchers when the 500 cap bites. *Cost:* none.
- The event sweep never matches wiki watches; the wiki keeps its own fan-out. *Cost:* none.
- The Wiki picker shows the library name before the breadcrumbs. It cuts text at 200 characters, waits 200 ms, and lists 8 hits per kind, as the wiki's search bar does. *Cost:* small UI rework.
- A wiki file is labeled "Wiki page" until you choose a word. *Cost:* one label.
- Migration 0116 doesn't count skipped rows. A skip means the same watch is already in the shared table. *Cost:* a wrong-order deploy stays silent.

## Wording added (please check)

- "Could not load your watches." and "Could not load this group's watches."
- "Could not load the initiative list.", "…site list.", "…truck list." and "Could not load the group list."
- "Couldn't update your watch." (the Watch button's failure message)
- "{initiative} · {n} rows not imported" ("1 row not imported")
- "Search the wiki…" and "Could not load the wiki."
- "Wiki library", "Wiki folder", "Wiki page"
- "Notified within the hour"
- From the mockup: "Wiki" and "Wiki watches hear every page update and comment, as today."
- "Picking people needs permission to change notifications." and "Picking groups needs permission to view notifications." (answer 9)
- Removed: "Groups don't change what you get." from the My groups hint, because group watches now do. Say if you want a replacement line.

## Open questions

1. **Flapping readers.** A reader that keeps dropping and coming back gets a notice and email on each drop, because the design says "offline at once". I recommend judging readers by the 3-minute threshold alone for notices.
2. **Auditing your own watches.** Your own watches on portal things aren't audited, while the wiki audits its own. Should they be?
3. **Members without a portal login.** They hear nothing from watches (the wiki's rule), and the Delivery log has no row for them.
4. **The 500-recipient cap.** People past it get no Delivery log row, only a process-log warning. A row would need a new reason and label.
5. **Clients and truck events.** Client users who watch an initiative get "No access" rows in the Delivery log for its truck events.
6. **Failed move setup.** Its notice links to a fresh wizard, because a draft can't be reopened by URL.
7. **From-To imports.** The notice goes to whoever uploaded the file, even if someone else committed it.
8. **What a job left out.** Move setup and bulk update don't say what they left out. From-To does.
9. **Recipient list for viewers.** Someone who can view notifications but not change them sees "Could not load the recipient list." in the rule editor, although nothing failed.
10. **Unpublished wiki pages.** The wiki's `GET /wiki/nodes/{id}` answers a view-only reader on a never-published page (existing behavior; is it meant to?).
11. **Wiki fan-out at scale.** It stays inside the editor's request. With a 500-member group watching a library, each publish or comment costs about 2,500 to 3,000 database round trips. Letting the wiki announce into the sweep is Phase 3 material.

## Answers (2026-11-04)

Jimmy answered the open questions on 2026-11-04. The fixes are planned in `docs/superpowers/plans/2026-11-04-notifications-phase2-answers.md`.

1. **Flapping readers:** keep it as built. A reader its station reports unreachable is offline at once, and its notice goes out straight away.
2. **Auditing your own watches:** yes. Starting, changing or stopping your own watch on an initiative, site, truck, device or Everything writes `watch.add`, `watch.update` or `watch.remove` on your account (`user_account`), with the same details a group's watch records. Wiki watches keep the wiki's own audit.
3. **Members without a portal login:** keep it as built. People who can't sign in get nothing from watches, and nothing is logged for them. Anyone who signs in can watch anything they can open.
4. **The 500-recipient cap:** keep it as built. The system has 25 users at most, so the cap is never reached.
5. **Clients and truck events:** keep the "No access" rows.
6. **Failed move setup:** keep the link to a fresh wizard.
7. **From-To imports:** the notice goes to the person who committed the import, and to the uploader too when that's someone else. Migration 0118 adds `import_jobs.committed_by`, which both commit routes set (From-To import and Bulk update assets). A move setup's job is committed by the person who started it.
8. **What a job left out:** Jimmy needs to see what failed in the portal, during the upload and import. The pages already show it, so nothing changes:
   - Bulk update assets marks each row Update, No change, Needs a match, Error or Skipped before Apply, then shows each row's result, with a CSV download.
   - Move setup's Assets step shows the same per-row report as the From-To page before the move is created. Its finish screen lists every row as Added, Updated or Skipped, with the row's message and a CSV download.
   - A From-To import's Review step lists the error and review rows and says they'll be skipped. Import complete keeps that report, with an .xlsx download.
9. **Recipient list for viewers:** fix it. Someone who may not list people (or groups) sees the rule's chosen people (or groups) by name, read-only, with a note saying which permission picking them needs, instead of an error. A rule's API answer carries those names (`names`).
10. **Unpublished wiki pages:** fix it. `GET /wiki/nodes/{id}` answers a view-only reader on a never-published page with 404 `not_published`, as the page read does, and the wiki shows the API's "This page hasn't been published yet." for it.
11. **Wiki fan-out at scale:** left for Phase 3.

## Deploy

1. Turn read-only mode on.
2. Run the migrations (0111 to 0116).
3. Deploy both slots.
4. Turn read-only mode off. Never leave an old slot live.

What breaks if an old slot runs on 0116:
- `GET /wiki/nodes/{id}/watch` fails, so the wiki's Watch button shows "Watch", and the Watching page errors.
- Developers bypass read-only mode, so a developer creating, publishing or approving wiki pages on the old slot gets a failed save; it rolls back and nothing is corrupted.
- The old worker doesn't touch `wiki_watches`.
- New code on 0115 runs, but wiki watches stay invisible until 0116.

Answer 7's migration 0118 only adds a nullable column, so an old slot keeps working on it.

Migration numbering: `project-plans` also has a 0110, and `notif-phase1` is unmerged. Whichever branch merges later renumbers.

## Verification

Each task had its own review, and each slice had a whole-slice review, one fix wave and a scoped re-review.

Test runs on the final code:
- **API, whole suite:** 6,501 passed, 1 skipped and 3 failed, run at 3cc635f0. Later commits change no API code. The 3 failures are the label-image tests that fail only in a whole-suite run. `tests/test_site_move_survey_fixtures.py` was left out of the run: defusedxml 0.7.1 appeared in the shared environment on 2026-11-03 without being in any pyproject, and the file no longer loads under it. main has the same file.
- **API, wiki group-watch tests:** 15 passed after the last fix, including its two new tests.
- **Portal:** 410 files and 5,313 tests passed. The type check and the build are clean.
- **Wiki web:** 836 tests passed. The type check is clean.

The live check ran on a copy of the dev database at 0116 (API :8022, portal :5196). It covered:
- Watch and Watching.
- The group page: all six segments, the Wiki picker, and wiki rows with their absolute link and only "Remove".
- /me rows: own and Via a group.
- An initiative status change reaching a group member, with the Delivery log reading "Watching · group".
- An Everything watch on Device offline, with the inbox notice.
- The rule editor's yes/no operators.
- A status rule notifying once, then held back within the hour.
- A wiki comment reaching a group member.
