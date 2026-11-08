# Kiosk Asset Lookup — design

Date: 2026-11-08. Branch `kiosk-asset-lookup`.

## What Jimmy asked for

"A new app for the kiosk that allows us to scan an [asset] and get the details
about that [asset]. All versions will get this but let's start with the web
version. If the scanned device is part of a move then we should show the scan
history of the device on screen."

His answers:

- **What finds it:** "asset tag, serial, rfid, name can all be scanned or
  entered".
- **What it shows:** "core details like name, make/model, serial, rfid, source
  and destination along with current location".
- **Who can use it:** "yes anyone". Every person signed in to the kiosk,
  workers included.

## Why

A crew member holding a device, or reading a tag, has no way on the kiosk to
find out what that device is, where it should go, and what has happened to it
so far. Today they ask the office or open the portal. This also closes the
parity gap "Asset lookup on the device" (Feature Parity, Kiosk and device apps,
Partial today; Harbor Master SS-397).

## Goals

- A new **Asset Lookup** tile on the kiosk Home screen at `/lookup`. It is the
  web kiosk first. The laptop gets it at the same time, since it runs the same
  app. iPad and Android follow in their own projects.
- Scan or type an **asset tag** (the legacy Asset ID), **serial**, **RFID** or
  **name**, and see that device.
- The screen shows its **name, make/model, serial, RFID, source, destination**
  and **current location**.
- When the device is **on a move**, its **scan history** shows on the same
  screen.
- It is **read-only**.

## Non-goals

- Editing the asset, re-tagging it (that is RFID Enroll), printing a label for
  it, or recording a scan. A lookup never queues a scan in the outbox.
- Containers, trucks and badges. Only assets are looked up.
- The iPad and Android apps. They come later and follow this design.

## Anti-goals

- **A lookup must never record a scan or change anything.** It is not
  Scanning.
- **It must not show a device to someone who shouldn't see it** (see Access).

## The screen

The page follows the kiosk's other scan screens (Scanning, RFID Enroll) for the
input, sizes, light and dark themes, and touch targets.

1. **Scan box.** One input that takes a scanner's keystrokes or typing, with
   Enter to look up, plus the on-screen Search button the kiosk's other scan
   screens use. A hand scanner and the laptop's RFID reader work the same way
   they do on Scanning (the same keyboard-wedge input).
2. **Matching.** The value is tried, in this order: RFID tag, asset tag
   (legacy Asset ID), serial, then name. RFID matches RFID only, as in
   `rfid-legacy-id-mismatch`: a numeric RFID is never matched against an asset
   tag. Exact matches (ignoring case and surrounding spaces) come first. Name
   also matches on part of the name.
   - **One match:** the device's details open straight away.
   - **Several matches** (a part-name, or a serial shared by two devices): a
     short list shows name, asset tag, serial and the move each is on, and
     tapping one opens it. The list is capped at 25, with "Refine your search"
     when there are more.
   - **No match:** "No asset matches *value*." The value stays in the box.
3. **Details card.**
   - Name (large), make/model.
   - Asset tag, serial and RFID, each "—" when blank.
   - The **move** it is on, with its status. When it is on more than one live
     move, each is listed.
   - **Source:** site, pod, rack and RU (or position). **Destination:** the
     same four.
   - **Current location:** the container, and the truck that container is on,
     when there is one, as the portal shows it (`placementText`:
     `"<container> · on <truck>"`). Otherwise the asset's Location text.
     Otherwise "—".
   - The asset's status, with its color.
4. **Scan history** shows only when the device is on a move. It lists the
   device's scans, newest first, the same rows the portal's asset Scan History
   shows: status, when (24-hour clock), how it was scanned, which device, who
   scanned it, the site and the location. Off-move sightings are marked, as in
   the portal. It shows the newest 50; the portal page has the rest.
5. **Scan again.** After a result, the scan box stays focused, so the next scan
   replaces the result without a tap. A Clear button empties the screen.

## Offline

- **Online:** every lookup goes to the API, so it finds any device the person
  may see, on any move or on none.
- **Offline (my call):** the lookup searches the devices the kiosk has synced
  for its own move (the `assets` store) and shows their details from there. It
  shows the notice "Offline — showing this move's devices only. Scan history
  needs a connection." There is no scan history offline.
- **No move set up and offline:** "Connect to look up assets."

## Access

- **Who:** anyone signed in to the kiosk (`kiosk:view`), workers included
  (Jimmy).
- **Which devices:** the same set the person could reach in the portal, with
  one widening, which is **OPEN QUESTION 1**.
  - Workers hold no `assets:view` or `scans:view` today (access/defaults.py:
    `worker` has dashboard, workers, kiosk and wiki only). So "anyone" means
    the new kiosk routes cannot simply reuse the portal's `assets` and `scans`
    scopes for a worker.
  - **My call, pending question 1:** a person with `assets:view` sees what
    their portal scope allows. A person without it (a worker) sees devices on
    the kiosk's set-up move and on that move's client's other moves. That is
    the same reach the kiosk already syncs (`/kiosk/sync/assets` and
    `/kiosk/sync/client-assets`).
- A move-password session (a worker locked to one move) gets the same
  worker reach.
- The scan history follows the same rule as the device: if the person may see
  the device, they see its scans.

## API

New kiosk routes in `api/src/serversherpa/api/routes/kiosk.py`, since a kiosk
session may only call `/kiosk/*`:

- `GET /kiosk/assets/lookup?q=<value>&initiative_id=<kiosk move>` returns up
  to 25 matches, each with what the list shows (id, name, asset tag, serial,
  RFID, and the moves it is on). It also returns a `truncated` flag. It uses
  the matching order above.
- `GET /kiosk/assets/{asset_id}?initiative_id=<kiosk move>` returns the
  details card: the asset's fields, its live moves with the source and
  destination of each, its current location (reusing
  `assets/placement.py` `asset_placements`), and its status.
- `GET /kiosk/assets/{asset_id}/scans?initiative_id=<kiosk move>&limit=50`
  returns the scan history, built the same way as `/scans/asset/{asset_id}`
  (shared helper, so the two can't drift). It is empty when the asset is on
  no move.
- **All three:** `kiosk:view`, the scope rule under Access, and 404 for a
  device the person may not see, the same as for one that doesn't exist. Each
  is read-only and audited nowhere.
- The laptop edge proxies `/kiosk/*` already, so the laptop needs no edge
  change.

## Testing

- **API (pytest).**
  - Each match kind finds its device, in the stated order.
  - RFID never matches an asset tag.
  - A part-name finds several devices, and results stop at 25 with
    `truncated`.
  - A worker is refused (404) a device outside the reach; a person with
    `assets:view` follows their scope.
  - The details carry source, destination and current location (container and
    truck).
  - The scans equal the portal route's rows for the same asset.
  - Nothing writes: there are no new scans and no outbox rows.
- **Kiosk (vitest).**
  - The tile shows for a worker.
  - One match opens the details; several show the list; none says so.
  - Scan history shows only when the device is on a move.
  - The offline fallback searches the synced move devices and shows its
    notice.
  - The next scan replaces the result.
  - No outbox write ever happens.
- **Live.** On the dev web kiosk, look up the dev asset 102466
  `atl1-web-001`, which is in ATL1-W1M-DC-01 on truck ATL1-T01. Search it by
  each of the four values, as a worker and as staff.

## Open questions for Jimmy

1. **How far a worker can see.** Workers today can't see assets or scans in
   the portal. Should a worker's lookup reach every device in the system, or
   only devices on this kiosk's move and its client's other moves (my call)?
