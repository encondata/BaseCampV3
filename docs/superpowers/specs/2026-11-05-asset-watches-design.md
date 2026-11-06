# Asset watches: design

**Status:** building, 2026-11-05. Jimmy described the feature and asked for no more questions. Every decision marked **(my call)** is mine and is listed again in the build report for him to check.

## Why

Clients ask where a particular server is ("Where is server abc123?"). Jimmy, 2026-11-05: "a user can then go into the portal and find the asset either as a standalone asset or as part of an initiative, they then 'mark/watch' and select from a set of options (notify on next update, notify when 'x' status becomes true) when that selection becomes true we send a notification so the user can go put hands on the device and action as the client has instructed".

Notifications Phase 2 left assets out of watches because no single place in the code writes an asset's status. This design gets around that by comparing snapshots instead of hooking every writer.

## What the user sees

### Where they set a watch

- **Asset page** (`/assets/:assetId`): a Watch button in the header. It sits beside Edit, but it is shown to everyone who can open the page, not only to editors.
  - It looks like the Watch button on initiative, site and truck pages: eye icon, "Watch", or amber "Watching".
  - A click opens the Watch modal instead of toggling, because there is a choice to make.
- **Move asset page** (`/initiatives/:id/assets/:rowId`): the same button. It watches the asset on that initiative.
- **Assets list:** each row's Actions ▾ menu gets "Watch…". It reads "Watching…" while the user has a watch on the asset itself, and either one opens the modal.
- **Initiative page, asset list:** each row's Actions ▾ menu gets the same "Watch…" / "Watching…" item, for the asset on that initiative. **(my call)** Viewers without `initiatives:change` now get the Actions button too, holding only Watch.
- **(my calls, during the build)** On the initiative list and the move asset page, Watch shows only to people with `assets:view`. A watch set on an initiative also needs the asset, and the move asset page's route needs only `initiatives:view`. The row menu order is Edit, Watch…, Remove, with the destructive item last as in the other row menus.

### The Watch modal

It uses the house modal shell (`NotificationModal` / `StandardModal`):
- Eyebrow "Watch asset", title "Watch {asset}", and the hint "You'll get one notification the first time this happens. Then the watch ends."
- On an initiative, a line under the hint: "On {initiative name}."
- A segmented choice (`ChoiceField`): **Next update** | **Status becomes**.
  - **Next update** shows the hint "Any scan, status change or edit, or a move into or out of a container or truck."
  - **Status becomes** shows a status picker (`ComboBox` over the active asset statuses), plus the hint "Its status is {current label} now." On an initiative the hint reads "Its status on this initiative is {current label} now."
  - The current status is left out of the picker **(my call)**, because a watch for the status it already has would mean nothing. Watching for its next update covers that case.
- Footer buttons:
  - "Cancel"
  - "Stop watching", only when a watch exists
  - the primary button: "Watch" for a new watch, or "Save" for an existing one
- Errors show in a `pf-error` line, as in the other watch modals.

### Where they see their watches

/me › Notifications › What you watch: asset watches join the same table **(my call: one list, not a second section)**.
- **Watching:** the asset, linked to where the watch was set, with an "Asset" chip. A watch set on an initiative adds "on {initiative}".
- **Events:** "Next update", or "Status becomes {label}".
- **Via:** "You".
- **Actions:** "Change…" (opens the modal) and "Stop watching".
- **(my calls, during the build)**
  - The list and its count wait for both answers, and the count includes asset rows.
  - If the asset watches can't be loaded, the section shows "Could not load your asset watches." and still lists the other watches.
  - If the other watches can't be loaded, the section shows nothing, as before.

### The notification

It goes to the inbox, and to email under the person's own switches, in a new category **Assets** **(my call)** with one kind, **Asset watch**. More in "Notice wording".

## What counts

### Next update

Anything recorded about the asset after the watch was set:
- **A scan of it:** barcode, RFID sightings and off-move sightings, kiosk scans, and status edits. Status edits made on the asset page, in Update assets in bulk and on an initiative are all recorded as processed scans.
- **A change to its record:** `updated_at`, `last_seen_at`, status, site, location or archive state.
- **A change to any of its initiative rows:** it was added to or removed from an initiative, a roster edit, a re-upload, or a restated status. This covers every initiative, wherever the watch was set **(my call)**: for "where is it?", any news counts.
- **Its placement:** it went into or out of a container, or its container went onto or off a truck.

### Status becomes X

- On a watch set on the asset itself, the asset's own status is X.
- On a watch set on an initiative, its status on that initiative is X. That is the row status the initiative's list shows.
- It doesn't matter what set the status: a scan, a status rule, an edit, an import or a placement recheck.

## How it's checked

The notification worker runs an asset-watch check **once a minute**, after the device check and before the event sweep, so a notice arrives within about a minute **(my call)**. `notification-worker --once` runs it too, in the same order, and its summary line counts the watches that ended.

### The snapshot

Each watch stores a snapshot of the asset, taken when the watch was set or last changed:
- the asset's `updated_at`, `last_seen_at`, `status`, `site_id`, `location_detail` and `archived_at`
- each of its initiative rows: id, initiative, status and `updated_at`
- its container and truck
- how many processed scans it has, and the latest `processed_at` among them

### When it fires

- **Next update** fires when anything in the current state differs from the snapshot.
- **Status becomes X** fires when the status it watches equals X.

### Why snapshots

There are no hooks in the writers, and no "since time T" cursors.
- No single place writes all of this. Several writers don't bump `updated_at` or leave any record: the scan worker, packing, truck loads, roster edits and the placement recheck.
- Timestamps can land before the watch was set. A long bulk update stamps its start time, so a "since" cursor could miss its rows. The scan count catches those.

### Limitations

- A status that is set and then changed again between two checks (under a minute apart) is missed. A watch for that status stays set.
- A scan that a failing status rule rolls back shows up once its retry succeeds.
- Sometimes a notice can describe the wrong scan. This happens when a long transaction commits a scan stamped before a scan the snapshot already held. The watch still fires, because the scan count changed. But the notice describes the newest scan by its stamp, which is the older one. No column orders such rows reliably, so this stays as it is.
- When one watch's notice fails, only that watch waits for the next run. The others still go out.

## When it fires

- One notice goes to the person who set the watch, and then the watch is deleted **(my call: one-shot)**.
  - The notice stays in their inbox and in the Delivery log.
  - To keep watching, they set a new watch.
- First the check confirms that the person's account is active and that they can still open the asset, and the initiative too for a watch set there. If either fails, the watch ends without a notice **(my call)**.
- If the asset leaves the initiative a **Status becomes** watch was set on, the watch ends with a notice saying so **(my call)**. A **Next update** watch simply fires on that change.
- If the person's Inbox switch for Assets is off, nothing is written, as for every kind, and the watch still ends.
- Two workers share one database, so the check claims its watches `FOR UPDATE SKIP LOCKED` and nobody hears twice.

## Notice wording (please check)

- **The asset's name:** its serial number, else its name, else its id, as status-rule notices name it.
- **Times:** 24-hour, in the company reference zone with its abbreviation, for example "Nov 5, 15:05 EST" **(my call: your 24-hour rule; other notices still show AM/PM)**.
- **Line separator:** " · " joins the parts of a line, as in other notices. Parts that are missing are left out.

### Next update

**Title:** "{asset}: {what happened}". *What happened* is the first of these that applies:

1. A new scan, described from the newest processed scan:
   - A status edit (no raw scan): "status set to {label} by {person}". With no person known, "status set to {label}".
   - An off-move sighting: "seen off-move at {site}". With no site, "seen off-move".
   - Any other scan: "scanned at {site}". With no site, "scanned".
2. Its container: "packed into {container}" or "taken out of {container}".
3. Its truck: "loaded on {truck}" or "taken off {truck}".
4. Its initiative rows: "added to {initiative}" or "removed from {initiative}".
5. A status change, of the asset itself or of the watched initiative row: "status changed to {label}".
6. Anything else: "record updated".

**Body lines:**
- "{What happened, first letter capitalized} · {time}". The time is the scan's `processed_at` for a scan, or the moment of the check for anything else.
- "Now: {status label} · {site} · {placement}". The placement is "{container} · on {truck}", the container alone, or the location text, as the Assets list shows it.
- "On {initiative}", for a watch set on an initiative.
- "You set this watch on {time} for its next update."

### Status becomes X

- **Title:** "{asset} is now {label}". On an initiative: "{asset} is now {label} on {initiative}".
- **Body lines:**
  - "Now: …" as above.
  - "Last scan: {scan description} · {time}", when a scan came in after the watch was set.
  - "You set this watch on {time} for status {label}."

### Removed from the initiative (a Status becomes watch)

- **Title:** "{asset} was removed from {initiative}".
- **Body:**
  - "Your watch for status {label} on it has ended."
  - The "Now: …" line.

### Link

- A watch set on the asset: `/assets/{asset_id}`.
- A watch set on an initiative: `/initiatives/{initiative_id}/assets/{row_id}`. Once the row is gone, `/assets/{asset_id}`.

## Data and API

### Migration 0120: `asset_watches`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `person_id` | uuid | → `people`, on delete cascade |
| `asset_id` | uuid | → `assets`, on delete cascade |
| `initiative_id` | uuid, null | → `initiatives`, on delete cascade; null = set on the asset itself |
| `condition` | text | `next_update` or `status` |
| `status` | text, null | an asset status key; set exactly when `condition = 'status'` (check constraint) |
| `baseline` | jsonb | the snapshot |
| `created_at` | timestamptz | when the watch was set or last changed |

- There is one watch per person, asset and place: a unique index on (person_id, asset_id, initiative_id), NULLS NOT DISTINCT.
- **(my call)** A new table, not columns on `notification_watches`. Those watches subscribe to kinds of events and never end. These wait for one condition and then end.

### Routes

They live beside the person's other watch routes in `api/routes/me.py` and use the same error style.

| Route | Does |
|---|---|
| `GET /auth/me/asset-watches` | the person's asset watches, only those they can open now |
| `GET /auth/me/asset-watches/state?asset_id=&initiative_id=` | `{watching, watch}` for one asset and place |
| `POST /auth/me/asset-watches` | body `{asset_id, initiative_id?, condition, status?}`; 201 |
| `PATCH /auth/me/asset-watches/{id}` | body `{condition, status?}`; takes a new snapshot and resets `created_at`; 200 |
| `DELETE /auth/me/asset-watches/{id}` | 204 |

**Errors:**

| Code | Meaning |
|---|---|
| 409 `already_watching` | the person already has a watch on that asset and place |
| 404 `thing_not_found` | there is no such asset or initiative, or the person can't open it |
| 404 `watch_not_found` | no such watch of theirs |
| 422 `not_on_initiative` | the asset isn't on that initiative |
| 422 `invalid_condition` | the condition isn't one of the two |
| 422 `status_required` | the condition is `status` and no status was given |
| 422 `invalid_status` | the key isn't an active asset status, or a status came with a Next update watch |
| 422 `already_at_status` | the asset already has that status there |

**Access:**
- A watch on the asset itself needs what `GET /assets/{id}` needs: `assets:view` plus the asset's client scope.
- A watch on an initiative needs what the initiative's asset list needs: `initiatives:view` plus the initiative's scope. The asset must be on that initiative.
- **(my call, during the build)** A watch on an initiative also needs the asset itself to be one the person can open. That's the same rule the check applies before it sends. Without it, a watch could be set and then end without a notice.
  - It applies on POST (404 `thing_not_found`), on PATCH, in the list and in the state endpoint.
  - It also means nobody can watch another client's asset just because it appears on a shared initiative's list.

**`AssetWatchOut`:** `{id, asset_id, asset_name, initiative_id, initiative_name, initiative_asset_id, condition, status, status_label, current_status, current_status_label, link, created_at}`. `current_status` is the asset's own status for a watch on the asset, and the row status for a watch on an initiative. The /me Change flow uses it to leave that status out of the picker.

**Audit:** each write is audited on the person's account, as their other watches are since answer 2: `watch.add`, `watch.update` and `watch.remove`, with `thing: "asset"` **(my call)**.

### Category and kind

- A new category, `assets` ("Assets"), placed after `initiatives`.
  - It is configurable like the others: add it to `CONFIGURABLE_CATEGORIES` and to the stored defaults, with Inbox and Email on.
  - It shows on the /me switch grid and on the Defaults tab, with the description "Notifications from your asset watches" **(my call, during the build: modeled on "Notifications from status rules")**.
- One kind, `asset_watch` ("Asset watch"), sent with `notify()`. It is neither watchable nor an Everything kind.

## Not in this build

These are left out:
- Containers.
- Group watches on assets, and watching for someone else.
- Repeating watches.
- A note of the client's instructions.
- A scan-type condition. Jimmy's first message mentioned one, but his description today lists Next update and Status becomes.

## Deploy

1. Migration 0120 (one new table).
2. Restart the API and the notification worker.
3. Build the portal.

There is no backfill and no change to existing data.
