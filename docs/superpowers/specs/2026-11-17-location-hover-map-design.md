# Location hover map: first step of SS-531

2026-11-17. Short design (small change).

## Intent

On the assets list of an initiative's full details page, hovering over a
Location that names a container or truck opens a small map showing where it
is. People can see where a crate or load physically is without leaving the
list. This is the first step of Harbor Master card SS-531, which will later
cover every asset list and dashboard, so the popup is built to be reused.

## What the popup shows

The popup works from the asset's container, in this order:

1. **Container on a truck:** the truck's last known GPS position, taken from
   its newest report that has coordinates. The popup shows the truck name and
   the report time as HH:MM, 24-hour, with how long ago it was ("14:32 ·
   3 h ago"), plus the approximate address when the report has one.
   - The truck is picked the same way the Location text picks it: the latest
     `added_at`, skipping archived trucks.
   - **Truck that hasn't reported a position:** a note, "<truck> hasn't
     reported a position yet". The popup does not fall back to the site,
     because a site pin would suggest the load is still there.
2. **Container not on a truck** (Jimmy's choice): the pin of the container's
   site, labeled with the site name and "Site location, not a live position".
3. **No truck, and no site or no site pin:** a note, "No known position".

Plain-text locations, with no container, get no popup, the same as today.

## Approaches

1. **Picked: a new position lookup, made when someone hovers.**
   `GET /containers/{id}/position` returns the truck position, the site pin,
   or nothing. The answer is current as of the hover, lists stay light, and
   the later lists can reuse it by passing a container id. The cost is a
   brief loading moment on the first hover.
2. Existing calls only (the truck detail call, or the container call followed
   by the site call). Rejected: heavier and slower, and the permission checks
   would be split across three calls. Someone who can see containers but not
   sites would get an empty popup with no clear reason.
3. Load coordinates with every list row. Rejected: every row of every list
   carries coordinates whether anyone hovers or not, and truck positions would
   only be as fresh as the page load.

## API

`GET /containers/{container_id}/position` returns:

```
{ kind: "truck" | "site" | "none",
  name: str | null,                 # truck or site name
  lat, lng: float | null,
  recorded_at: datetime | null,     # truck only
  approximate_address: str }        # truck only, "" otherwise
```

Each kind is gated by the same rules the Location links use:

- **Container:** needs `containers:view` plus `scope_conditions("containers")`,
  and the container must not be archived. Otherwise the call returns 404.
- **Truck:** needs `trucks:view` plus `scope_conditions("trucks")`. Without
  that access, the truck is treated as absent and the answer drops to the
  site step.
- **Site pin:** needs `sites:view` plus `scope_conditions("sites")`. Without
  that access, the answer is `none`.

The truck position comes from one indexed query: the newest `truck_updates`
row for that truck where `lat` and `lng` are not null.

## Portal

- **Hover-map component**, shared by every later list. It takes a container
  id and wraps any element:
  - it opens after a short hover delay (about 300 ms), and also when the
    element gets keyboard focus
  - it closes when the pointer or focus leaves
  - it is static, with no pan or zoom
- **Answers are cached** per container id for about a minute.
- **Placement:**
  - the popup portals into `.portal-shell` so it keeps the theme
  - it has rounded corners and follows light and dark mode
  - the map panel gets `isolation: isolate` so Leaflet doesn't paint over
    other layers
  - its size is roughly 280 × 180 px
- **Map:** a fixed zoom on one marker, using the existing `MAP_TILE_URL`
  tiles and the `TrucksMap` marker style.
- **`AssetLocation`** gets an optional prop that turns the popup on. The
  container and truck names both open the same popup, and clicking them
  still opens the container or truck as before.
- **Scope of this step:** only the InitiativeDetail assets list turns it on.

## Non-goals and anti-goals

**Non-goals:**
- Other lists and dashboards. They come later under SS-531.
- Touch and tap support. The links keep working on touch devices.
- Route trails, or positions for assets that aren't in a container.

**Anti-goals:**
- The popup must never show a truck or site the viewer couldn't open.
- It must never present a site pin as a live GPS position.
- It must never slow down the list. Nothing is fetched until someone hovers.

## Left to the builder

- Exact component and file names.
- The loading and error states inside the popup. Keep them small, matching
  the existing `.pf-notice` style.
- The tests: API tests for each kind and each permission drop, plus portal
  tests for opening, closing, the cache, and each message.
