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
- **What each person sees:** "any user gets source and destination info but
  admin and higher get full details".

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
  screen, for admins and above.
- **Everyone** sees who the device is plus its source and destination.
  **Admin and above** (role rank 60 or more: admin, super_admin, founder,
  developer) see the full details.
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
2. **Matching (my call, from the builder check).** The kiosk can't tell a
   keyboard-wedge RFID read from typing, so the value is tried against three
   exact keys at once, ignoring case and surrounding spaces:
   - the asset tag (legacy Asset ID);
   - the serial;
   - the RFID tag, compared the way stored tags are kept (zero-padded to 24
     characters, `normalize_rfid`).

   Then:
   - **All exact hits are one device:** its details open straight away.
   - **Exact hits on different devices** (for example a typed "102466" that is
     one device's asset tag and, padded, another device's RFID): a short list
     shows each with what it matched on ("Asset tag", "Serial", "RFID"), and
     tapping one opens it.
   - **No exact hit:** the value is tried as part of a name. One hit opens it;
     several show the list. The list shows name, asset tag and serial, and is
     capped at 25, with "Refine your search" when there are more.
   - **No match at all:** "No asset matches *value*." The value stays in the
     box.
   - Offline, the same rules run on the synced devices.
3. **Details card — everyone.**
   - Name (large), make/model.
   - Asset tag, serial and RFID, each "—" when blank. **My call:** these are
     shown to everyone, since the person just scanned or typed one of them and
     needs to know they have the right device.
   - **Source:** site, pod, rack and RU (or position). **Destination:** the
     same four. When the device is on more than one move, the source and
     destination of each move are shown under the move's name.
4. **Details card — admin and above only.** These are added to the card:
   - The asset's status, with its color.
   - The move or moves it is on, with each move's status.
   - **Current location:** the container, and the truck that container is on,
     when there is one, as the portal shows it (`placementText`:
     `"<container> · on <truck>"`). Otherwise the asset's Location text.
     Otherwise "—".
   - **Scan history,** only when the device is on a move. It lists the
     device's scans, newest first, the same rows the portal's asset Scan
     History shows: status, when (24-hour clock), how it was scanned, which
     device, who scanned it, the site and the location. Off-move sightings
     are marked, as in the portal. It shows the newest 50; the portal page has
     the rest.
   - Below admin, none of these are shown, and the screen says nothing about
     them being hidden.
5. **Scan again.** After a result, the scan box stays focused, so the next scan
   replaces the result without a tap. A Clear button empties the screen.

## Offline

- **Online:** every lookup goes to the API.
- **Offline (my call):** the lookup searches the devices the kiosk has synced
  for its own move (the `assets` store), with the same matching rules. It
  shows what the synced data holds for that person's level: source and
  destination for everyone, and for admins also the status and the container
  the sync records (`container_id`, named from the `containers` store). It
  shows the notice "Offline — showing this move's devices only." Scan history
  needs a connection, and says so for admins.

## Where the tile appears (my call, from the builder check)

- Like Scanning and the other move tiles, it is greyed until Kiosk Setup is
  complete. The kiosk's move is always known when it is used.
- It shows wherever every tile shows: the web kiosk, and a laptop that isn't
  set up as a station. Station laptops (RFID, Label, Time Clock, Dock) keep
  their fixed tile lists and don't get it.
- The breadcrumb trail is Home › Asset Lookup.

## Access

- **Who:** anyone signed in to the kiosk (`kiosk:view`), workers included
  (Jimmy).
- **What they see:** everyone gets the identity, source and destination;
  admin and above (rank 60 or more) get the full details (Jimmy). The API
  enforces this split. A response to someone below admin never carries the
  status, moves, location or scan history.
- **Which devices (my call; Jimmy didn't choose when asked).**
  - **Below admin:** devices on the kiosk's move, plus that move's client's
    devices on its other moves or on no move. That is the same set the kiosk
    already downloads (`/kiosk/sync/assets` and `/kiosk/sync/client-assets`).
    Anything else reads as not found.
  - **Admin and above:** what their portal scope allows (`assets:view` and its
    scope conditions), plus the kiosk's move.
  - **A move-password session** (a worker locked to one move): that move's
    devices only, as the other kiosk asset routes keep it
    (`_require_move_asset`).
- **The kiosk's move is the registered device's move, not a value the screen
  sends** (my call, from the builder check). The routes take the kiosk's
  serial and use `Device.current_initiative_id`, the way RFID Enroll does
  (`enroll_rfid`). Otherwise a worker could pass any move id and reach every
  move's devices.

## API

New kiosk routes in `api/src/serversherpa/api/routes/kiosk.py`, since a kiosk
session may only call `/kiosk/*`. Each takes the kiosk's `serial`, which
identifies its move:

- `GET /kiosk/assets/lookup?serial=<kiosk>&q=<value>` returns the matches by
  the rules above. Each match has id, name, asset tag, serial and what it
  matched on, plus a `truncated` flag.
- `GET /kiosk/assets/{asset_id}?serial=<kiosk>` returns the details card.
  - **Everyone:** identity, plus source and destination for each live move.
  - **Admin and above:** also the status, the moves, and the current location
    (from `assets/placement.py` `asset_placements`; admins hold
    `containers:view` and `trucks:view`).
- `GET /kiosk/assets/{asset_id}/scans?serial=<kiosk>&limit=50` returns the
  scan history, built the same way as `/scans/asset/{asset_id}` through a
  shared helper so the two can't drift.
  - Admin and above only (`require_rank(60)`); anyone else gets 403.
  - Empty when the asset is on no move.
- **All three:** `kiosk:view`, plus the device rules under Access. A device
  outside the person's reach gets 404, the same as one that doesn't exist.
  They are read-only.
- The laptop edge already proxies `/kiosk/*`, so the laptop needs no edge
  change.

## Testing

- **API (pytest).**
  - Each match kind finds its device, in the stated order.
  - RFID never matches an asset tag.
  - A part-name finds several devices, and results stop at 25 with
    `truncated`.
  - A worker is refused (404) a device outside the reach, even when it sends
    another move's id. A move-password session stays on its move. An admin
    follows their scope plus the kiosk's move.
  - Below admin, the details carry identity, source and destination only.
    Admins also get status, moves and current location (container and
    truck).
  - The scans route gives a worker 403.
  - A typed value that is one device's asset tag and another device's RFID
    returns both, each with what it matched on.
  - The scans equal the portal route's rows for the same asset.
  - Nothing writes: there are no new scans and no outbox rows.
- **Kiosk (vitest).**
  - The tile shows for a worker, and is greyed until setup.
  - One match opens the details; several show the list; none says so.
  - A worker sees source and destination only; an admin sees the full card.
  - Scan history shows only for an admin, and only when the device is on a
    move.
  - The offline fallback searches the synced move devices and shows its
    notice.
  - The next scan replaces the result.
  - No outbox write ever happens.
- **Live.** On the dev web kiosk, look up the dev asset 102466
  `atl1-web-001`, which is in ATL1-W1M-DC-01 on truck ATL1-T01. Search it by
  each of the four values, as a worker (source and destination only) and as
  an admin (full details, with the container and truck).
