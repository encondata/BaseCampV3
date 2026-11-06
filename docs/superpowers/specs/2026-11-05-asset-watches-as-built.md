# Asset watches: as built

Companion to `2026-11-05-asset-watches-design.md`. It records what was built, every call I made on Jimmy's behalf (he asked for no more questions on 2026-11-05), the wording to check, what was left as it is, and how to deploy.

- **Branch:** `asset-watches`, from main 81a20707, with main 4a75457a merged in (130c70f4). Not merged into main.
- **Plan:** `docs/superpowers/plans/2026-11-05-asset-watches.md`. Built in 5 tasks, each reviewed, then a whole-branch review on the most capable model, one fix round and its re-review.
- **Migration:** 0121 (`asset_watches`, one new table), on Dock Station's 0120. Its downgrade drops the table.

## What it does

- **Where to set a watch:**
  - On an asset's page, or with Actions ▾ → Watch… in the Assets list.
  - For the asset on an initiative: Actions ▾ → Watch… in the initiative's asset list, or the Watch button on the move asset page.
- **What to watch for:** **Next update**, or **Status becomes X**.
- **When it fires:** within about a minute, you get one notice (inbox, and email under your own switches) saying what happened, where the asset is now and when you set the watch, with a link back. Then the watch ends.
- **Where your watches are listed:** /me › Notifications › What you watch, with Change… and Stop watching.
- **How it's checked:** the notification worker runs the check once a minute. Each watch keeps a snapshot of the asset taken when it was set. "Next update" fires on any difference: a new scan, a record change, an initiative row change, or a container or truck change. "Status becomes X" fires when the status it watches is X: the asset's own status, or its row status on that initiative.

## Calls I made (please check)

These are the design doc's "(my call)" items. Each says what it costs if I got it wrong.

1. **Viewers can watch from the initiative list.** Viewers without `initiatives:change` now get the Actions button there, holding only Watch. Cost: one gate, if viewers shouldn't watch.
2. **The current status isn't offered.** It's left out of the Status becomes picker. Cost: none material. Next update covers "tell me when it moves".
3. **One list on /me.** Asset watches join the What you watch table instead of getting their own section. Cost: a layout change.
4. **A new Assets notification category**, holding one kind, "Asset watch". Cost: moving the kind to another category.
5. **"Next update" counts changes on every initiative the asset is on**, wherever the watch was set. Cost: a narrower rule for watches set on an initiative.
6. **The check runs once a minute**, after the device check and before the event sweep. Cost: up to a minute of delay. Hooking every writer instead isn't possible, because several leave no record.
7. **Watches are one-shot.** A watch is deleted when it fires, and the notice stays in the inbox. Cost: a "watch again" or repeating option later.
8. **A watch ends silently if its owner can't receive it.** That means their account is inactive, or they can no longer open the asset (or the initiative, for a watch set there). Cost: they might expect a "your watch ended" notice.
9. **Leaving the initiative ends a status watch.** If the asset leaves the initiative a Status becomes watch was set on, the watch ends with a notice saying so. Cost: wording.
10. **24-hour times.** The notice shows "Nov 5, 15:05 EST", following your 24-hour rule. Other notices still show AM/PM. Cost: none. Switching the others is a follow-up.
11. **A new table**, not columns on `notification_watches`. Those watches never end and subscribe to kinds of events. Cost: a refactor if they should merge later.
12. **Audit rows** are `watch.add`, `watch.update` and `watch.remove` on the person's account, with `thing: "asset"`, like their other watches. Cost: an action rename.

## Rulings during the build

These are in the order I made them.

1. **No plan review.** The build ran without one, because you said no more questions and described the feature. Cost: rework of any piece you disagree with.
2. **Errors don't reveal asset ids.** `not_on_initiative` is answered only to someone who can open the asset. Anyone else gets 404 `thing_not_found`, so a request never confirms an asset id exists. Cost: a less specific error in one edge case.
3. **One shared status list.** The active-status query moved into `status/labels.py` `active_statuses()`. `/status-values` calls it too, with no change in behavior. Cost: none.
4. **A watch whose initiative row is gone stays listed**, linking to the asset page, until the next check ends it. Cost: a stale row on /me for up to a minute.
5. **A change or stop racing the check gets 404, not 500.** The watch row is locked while it's changed or stopped. Cost: none.
6. **Assets category description:** "Notifications from your asset watches", modeled on "Notifications from status rules". Cost: a one-line copy change.
7. **A watch on an initiative also needs access to the asset itself**, when it's set, in the list and in the state read. This matches the check before sending, so no watch can be set that would end silently. It also means nobody can watch another client's asset just because it's on a shared initiative's list. Cost: someone who sees an asset only through an initiative's list can't watch it.
8. **Names in a notice follow what the person can see:**
   - Container and truck names appear only for people whose Assets list shows them. Other initiatives are named only for people who can open them. Otherwise the title falls through to the next thing, ending at "record updated".
   - "status changed to" reads the watched status.
   - Operator names are shown to anyone who can open the asset, as the status history already does.
   - Cost: copy differs for limited viewers.
9. **`notification-worker --once` runs the check too**, and counts it. Cost: none.
10. **Held emails aren't re-checked.** A held asset-watch email (quiet hours) isn't checked for access again at send time, like every other direct notice kind. Cost: someone who loses access overnight still gets the held email.
11. **Modal behavior when a watch changed underneath it:**

    | Situation | What the modal does |
    |---|---|
    | The person was already watching | Re-reads and closes. |
    | The watch ended before Save | Turns into a new watch with "This watch has already ended. Press Watch to set a new one." |
    | The watch ended before Stop | Counts it as stopped. |
    | The person can't open the asset | "You can't watch this asset." |
    | The asset left the initiative | "This asset is no longer on this initiative." |

    Cost: copy changes.
12. **Modal labels the spec didn't give:** "Watch for", the "Status" picker with "Search statuses…", and "Could not load the status list." Cost: copy changes.
13. **Where the modal opens from the header buttons.** The asset and move asset page buttons first opened it outside the page area. The final fix moved it into the page area, so it keeps the house header (eyebrow, hint) while avoiding the header buttons' styles. Cost: none.
14. **Who sees Watch on the initiative list and the move asset page:** only people with `assets:view`. Cost: a viewer with `assets:view` for another client sees Watch and is refused.
15. **Row menu order:** Edit, Watch…, Remove, with the destructive item last as in other menus. Cost: a one-line swap.
16. **One shared name rule.** A small `assetWatchName` helper (serial, else name, else id) is shared by the four pages. The initiative page makes one extra watch request per load. Cost: none at 25 users.
17. **/me when asset watches fail to load:** the line "Could not load your asset watches." The other watches still show. Cost: a one-line copy change.
18. **/me loading:** the list and its count wait for both answers, and the count includes asset rows. If the other watches fail to load, nothing is listed, as before. Cost: small layout rework.
19. **The final fix round** took both must-fix findings plus seven cheap ones:
    - one failing watch can no longer stall the others
    - no "nothing watched" line under a load error
    - no dead click zone on rows without actions
    - a constant renamed to match its siblings
    - a firmer test
    - precedence and full-body tests
    - `aria-haspopup`
    
    Cost: none.
20. **A rare wrong scan description stays.** A late-committed scan stamped before one the snapshot already held can make a notice describe the older scan. It's recorded under Limitations, not fixed, because no column orders such rows reliably. Cost: that rare notice describes the older scan.
21. **Small edges left as built:**
    - one log line per failing watch until it ends
    - batch loads before the per-watch loop still fail the whole run (logged once)
    - the /me count badge can read 0 beside the load error
    
    Cost: polish later.
22. **Main merged into the branch, and the migration renumbered.** Main took 0120 for Dock Station while this was being built. I merged main into the branch, with no conflicts, and renumbered `asset_watches` to 0121 on top of Dock's 0120, so main can take the branch as it is. Cost: none.

## Wording added (please check)

- **Notice titles, Next update:** "{asset}: {what happened}", where *what happened* is the first that applies:
  - "status set to {label} by {person}"
  - "seen off-move at {site}"
  - "scanned at {site}"
  - "packed into / taken out of {container}"
  - "loaded on / taken off {truck}"
  - "added to / removed from {initiative}"
  - "status changed to {label}"
  - "record updated"
- **Notice title, Status becomes:** "{asset} is now {label}", or "{asset} is now {label} on {initiative}".
- **Notice title, asset removed from an initiative:** "{asset} was removed from {initiative}".
- **Notice body lines:**
  - "{What happened} · {time}"
  - "Now: {status} · {site} · {placement}"
  - "On {initiative}"
  - "Last scan: … · {time}"
  - "You set this watch on {time} for its next update." or "… for status {label}."
  - "Your watch for status {label} on it has ended."
- **Modal:**
  - Eyebrow "Watch asset", title "Watch {asset}"
  - "You'll get one notification the first time this happens. Then the watch ends."
  - "On {initiative}."
  - The choice: "Next update" / "Status becomes"
  - "Any scan, status change or edit, or a move into or out of a container or truck."
  - "Its status is {label} now." / "Its status on this initiative is {label} now."
  - Buttons: "Watch", "Save", "Stop watching", "Cancel"
  - Plus the strings in rulings 11 and 12.
- **Menus and /me:**
  - "Watch…" / "Watching…"
  - The "Asset" chip and "on {initiative}"
  - "Next update" / "Status becomes {label}"
  - "Change…", "Stop watching"

## Limitations

- A status set and then changed again within a minute is missed.
- A scan rolled back by a failing status rule shows up once its retry succeeds.
- A rare late scan can be described as the older one (ruling 20).

## Left as it is

These were deferred from the reviews. Each has a ledger reason, and none blocks.

- **Duplicated code:**
  - The duplicate-insert block copied from `watches.py`.
  - The placement visibility rule copied from `assets/placement.py`.
  - A third copy of the eye icon.
- **Edge behavior:**
  - `already_watching` closes on whatever watch exists, without saying so.
- **Test and comment gaps:**
  - One untested "can't change the choice while saving" guard.
  - Two comment wordings.

## Deploy

1. Migration 0121 (`ss-stack revision` should read 0121 afterward). The dev DB is at 0119, so this also applies Dock Station's 0120.
2. Restart the API and the notification worker. The worker log shows the asset-watch check each minute.
3. Build the portal.

There is no backfill and no change to existing data. Rolling back to 0120 drops the table, and with it any watches that were set. Dock Station's 0120 stays.

## Verification

- **Full API suite, before main came in** (031dfe41, all five tasks): 8,212 passed, 2 skipped, 0 failed, in 2 h 24 min.
- **The fix round after that run** changed `asset_watch_check.py`, `worker.py` and their tests. Afterward, the asset-watch, notification and /me API tests passed (118).
- **On the merged branch** (ee5c5c96):

  | Check | Result |
  |---|---|
  | Asset-watch, notification, /me and Dock Station API tests | 163 passed |
  | Migration chain | `alembic heads` lists 0121 only |
  | Migration round trip | Down to 0120 drops `asset_watches` and keeps Dock's `dock_passes`. Back up to 0121 restores the table, its unique index and both checks. |
  | Portal | 7,547 passed, build OK |
  | Kiosk | 1,812 passed, build OK |
  | Learn | 137 passed, build OK |

- **Live check:** run on a scratch copy of the dev DB, signed in as claude-dev on localhost.
  - **Next update** was set on HNL23L9's asset page. A status edit to RFID 3 - Staging fired "HNL23L9: status set to RFID 3 - Staging by Claude Dev", with the body lines as above and a link to the asset page. The watch ended.
  - **Status becomes Re-Racked** was set from the initiative's asset list (Actions ▾: Edit, Watch…, Remove), and /me listed it. A row edit to Re-Racked fired "HNL23L9 is now Re-Racked on Acme ATL1 to DFW1 Consolidation", with a Last scan line and a link to the move asset page. The watch ended.

## Found along the way (not this branch)

- **naturalSort guardrail:** `portal/src/styles/naturalSort.test.ts` failed on main from web-kiosk-labels (2026-11-04). It flagged `kiosk/src/lib/webLabels/labelgenHash.ts:22` and `kiosk/src/pages/PrintingStation.tsx:501`. Main has since fixed it (89ac4130, in the Sirdar merge 75b3842c), and the merged branch's portal suite passes in full.
- **Kiosk test error:** one kiosk run on the merged branch logged an unhandled `window is not defined` after all 1,812 tests passed.
  - **Where:** `kiosk/src/components/SoundPanel.tsx:74`, as `src/pages/Settings.test.tsx` tore down. A sound-list promise settled after its test had ended.
  - **When:** that run had the API suite loading the machine.
  - **Since:** it didn't recur in a second full kiosk run or in three runs of that file. This branch changes no kiosk code.
