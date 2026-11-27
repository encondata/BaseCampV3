# Move load test — design

Date: 2026-11-27 · Status: building. Jimmy said to go ahead without
questions until it is ready to test; every call Claude made for him is
listed under "Decisions for Jimmy".

## Intent

Jimmy wants to benchmark a server and prove it is reliable by running a
whole simulated move against it: a chosen number of servers, containers
and trucks, every scan and update a real move produces, in the real order.

Two speeds, same move:

- **Real time** follows the times a real crew takes, so the server sees a
  realistic move (about two days for 3,000 servers).
- **Fast** replaces every wait with a 0.5–1 second pause, to find
  bottlenecks.

He wants a web page to start it from, with a live feed of what is
happening and an overall progress tracker.

## What exists today

- **No load or benchmark tooling** anywhere in the repo.
- **From-To generator page:** `docs/mockups/data-generator.html`
  (untracked, single file, no API). It writes the 25-column "Move Assets"
  template as `.xlsx` and leaves RFID Tag blank. It opens on two cards,
  Generate and Simulate; Simulate is a disabled "Coming later" card.
- **Scan pipeline:** every scan endpoint only stores a `raw_scans` row.
  One `scan-matching-worker` then matches each scan and runs the status
  rules, one transaction per scan, 50 per batch. So the API can accept
  scans much faster than the server finishes them; the waiting count (the
  backlog) is the main thing a fast run measures.
- **Status rules are data.** A rule only updates a move's roster row when
  the move is `in_progress`. The starter data has no rule for the truck
  load (`on_truck`) or unload (`received`) checkpoints, so those scans are
  recorded but change no status.
- **Kiosk sessions are fenced.** A kiosk sign-in may only call `/kiosk/*`
  and a few auth routes. Truck depart, arrive and location updates need a
  portal sign-in. Portal sign-ins can be asked for a 2FA code; kiosk
  sign-ins never are.
- **Scans are idempotent only while they wait.** `client_scan_id` is
  unique on `raw_scans` alone. Once the worker has processed a scan and
  deleted its raw row, a retry of the same scan is stored and processed a
  second time (`processed_scans.client_scan_id` has no unique index). Real
  kiosks retry the same way, so this is a gap in the server that a run can
  surface; the tool reports it, it does not hide it.
- **Pack, unpack, load and unload change state in the request** as well as
  storing a scan.
- **No endpoint counts processed scans for one move.** The per-asset scan
  history (`GET /scans/asset/{id}`) lists each processed scan with its
  checkpoint, `scanned_at` and `processed_at`.
- **No road routing** exists in the app. The truck maps draw straight
  trail lines between reported points.
- **No throttle fires on correct credentials.** Only failed sign-ins count
  toward lockouts and address blocks.

## Goals

1. One tool that runs a whole move against any server from a separate
   machine, at either speed.
2. A local web page: generate the From-To, check the server is ready,
   start the run, watch a live feed and progress, read the result.
3. A result that says plainly whether the server kept up and whether every
   scan landed.

## Non-goals

- **No change to server code.** Nothing in `api/`, `portal/`, `kiosk/` or
  the mobile apps changes. The tool uses the endpoints the real devices
  use. A number that no existing endpoint can supply is left out of the
  result and named as missing.
- **No move creation.** Jimmy uploads the From-To and creates the move,
  containers and trucks in the portal (Bulk Actions › Create a move in
  steps). That also exercises the import.
- **No cleanup.** The run leaves its scans, device rows and truck updates
  on the server. On a test server, take a Developer › Database › Testing
  snapshot before the run and revert after.
- **One run at a time**, one move per run.
- **No speed thresholds.** The tool reports response times; it does not
  decide what is fast enough.
- **Not simulated:** label printing itself, the time clock, off-move
  alarms, Dock Station auto-pack, photos, notes.

## Continuing an interrupted run

A real-time run lasts about two days, so losing it to a restart of the
runner machine is not acceptable.

- The runner writes a journal line for every step it finishes (which
  server finished which stage, which container and truck it went to, when
  each truck left). The journal is the run's memory.
- When the tool starts and finds an unfinished run, the page offers
  **Continue run** beside **Start new run**. Continue asks for the
  passwords again (they are never saved), rebuilds progress from the
  journal and carries on.
- Every scan's `client_scan_id` is derived from the run, the server and
  the stage, so a step that was sent but not yet journaled is sent again
  and the server counts it once.
- A cart or container that was mid-way starts its timer over. A truck on
  the road is placed where it should be by the clock; location updates
  that fell in the gap are skipped and counted as skipped.
- The result says the run was interrupted, when, and for how long.

## Anti-goals

- Load generated by the server under test. It would skew every number.
- A page that must stay open. The run belongs to the runner process; the
  page can be closed and reopened.
- Credentials written to disk, the feed, the log or the result.

## Approaches

1. **Standalone runner with its own web page (picked).** A small Python
   program in a new top-level `loadtest/` folder. It serves a local page
   and makes every call to the server itself. Load comes from another
   machine, the page can close and reopen, and it points at any server.
   The move is modeled directly: servers flow through ordered stages with
   crews, carts, containers and trucks.
2. **Locust.** An off-the-shelf load tool that already has a web page with
   live request statistics. It models independent users calling endpoints
   at a rate. A move is the opposite: one ordered pipeline where a server
   cannot be packed before it is labeled and a truck leaves when it is
   full. The pipeline would have to be built on top of Locust anyway, and
   its page shows request rates, not move progress.
3. **A Developer page in the portal with a server-side worker.** Easiest
   to reach, but the server would generate its own load, test code would
   ship in the product, and a new worker would be needed on every server.

Jimmy asked for a web front end with a live feed and a progress tracker;
the choice of approach 1 to deliver it is Claude's call.

## The move process

From Jimmy's steps. Each row is one stage. "Crew" sets the pace; "Devices"
is how many signed-in devices send the calls.

**Origin site**

| # | Stage | Checkpoint | Crew and real-time pace | Devices | Call |
|---|---|---|---|---|---|
| 1 | RFID enroll | `pre_stage` | 5 people, 15 s per server | 5 handhelds | `POST /kiosk/assets/{id}/rfid` with a random 24-character tag |
| 2 | RFID 1 – Cage Exit | `rfid_1_cage_exit` | 20 teams, 10 servers per cart, 10 min per cart | 1 RFID Station | `POST /kiosk/station/scans`, the cart's 10 tags in one batch |
| 3 | Label station | `labeled` | 3 printers, 15–30 s per server | 3 Label Stations | `POST /kiosk/station/scans`, one barcode scan of the serial |
| 4 | RFID 2 – Loading Dock | `rfid_2_loading_dock` | 4 people, 10 servers per cart, 2–3 min per cart | 1 RFID Station | `POST /kiosk/station/scans`, 10 tags in one batch |
| 5 | Pack containers | `in_container` | 4 teams, 20 servers per container, 7 min per container | 4 handhelds | `POST /kiosk/containers/{id}/assets` `pack`, one per server |
| 6 | Load truck | `on_truck` | 1 team, 8 min per container, 15 containers per truck | 1 handheld | `POST /kiosk/trucks/{id}/containers` `load`, one per container |

**Trip**

| # | Stage | Pace | Call (portal sign-in) |
|---|---|---|---|
| 7 | Truck departs | when the truck is full, or no containers are left | `PATCH /trucks/{id}` `in_transit` |
| 7 | Truck location | every 15 min for 17 hours: 68 updates per truck | `POST /trucks/{id}/updates` |
| 8 | Truck arrives | 17 hours after it left | `PATCH /trucks/{id}` `at_destination` |

**Destination site** (the origin stages in reverse)

| # | Stage | Checkpoint | Crew and real-time pace | Devices | Call |
|---|---|---|---|---|---|
| 8 | Unload truck | `received` | 1 team, 8 min per container | 1 handheld | truck containers `unload` |
| 9 | Unpack containers | `un_pack` | 4 teams, 7 min per container | 4 handhelds | container assets `unpack` |
| 9 | RFID 3 – Staging | `rfid_3_staging` | 4 people, 10 per cart, 2–3 min per cart | 1 RFID Station | station scans, 10 tags |
| 9 | RFID 4 – Into Cage | `rfid_4_into_cage` | 20 teams, 10 per cart, 10 min per cart | 1 RFID Station | station scans, 10 tags |
| 10 | QA | `qa` | 5 people, 15 s per server | 5 handhelds | `POST /kiosk/scans`, barcode of the serial |
| 11 | Complete | `complete` | 5 people, 15 s per server | 5 handhelds | `POST /kiosk/scans`, barcode of the serial |

That is 32 simulated devices. Not sent, because Jimmy's steps do not list
them: `pack_logistics`, `staged`, `re_racked`.

**Flow rules**

- A server enters a stage only after it finished the one before.
- A cart or container is filled from servers that are ready. A team waits
  for a full cart (10) or container (20); it takes a short one only when
  no more servers are coming.
- Stages overlap. Labeling starts as soon as the first cart is through the
  cage exit; nothing waits for a whole stage to finish.
- All trucks follow the same road route and can be on the road together.
- A range (15–30 s, 2–3 min) is a random pick in that range each time.

**Fast speed** keeps the stages, their order, the crews, devices, cart and
container sizes, and the 68 location updates per truck. The only change:
every crew member or team pauses a random 0.5–1 second between requests
instead of the real time. A cart of 10 is still one request.

**Profiles.** Every number above lives in one profile file per speed
(`real-time` and `fast`): crew sizes, device counts, times, cart and
container sizes, containers per truck, trip length, update interval, stage
order and each stage's checkpoint key. Jimmy changes a number by editing
the file; no code change.

## Truck route

Jimmy: the route follows real roads, not a straight line.

The tool asks a road-routing service once per run for the driving route
between the move's origin and destination sites (their latitude and
longitude) and keeps the road line. A truck's position at each update is
the point that far along the road by distance: update 34 of 68 is halfway
along the road. The trip always takes the profile's 17 hours, whatever
drive time the service reports. `approximate_address` is left blank.

The route is fetched during the readiness check, so a routing failure
stops the run before it starts. There is no straight-line fallback.

**Open decision for Jimmy — which routing service.** See "Decisions for
Jimmy" below.

## The tool

**Where it lives:** a new top-level `loadtest/` folder with its own
dependency list and virtual environment. It imports nothing from
`serversherpa`, so it runs on a machine that has only this folder.
Python, `httpx` for calls to the server, FastAPI + uvicorn for the local
page, server-sent events for the live feed. Started with one command; it
prints the page's address.

**The page** is the existing generator page grown up: a copy of
`docs/mockups/data-generator.html` becomes the tool's page, Generate keeps
working as it does today, and the Simulate card becomes live. The mockup
file itself is left where it is. It follows light and
dark like every other screen, uses the portal's look, shows times as
24-hour HH:MM:SS, and keeps Start and Stop always visible.

Generate gains one line in its summary: how many containers and trucks
that device count needs (20 per container, 15 containers per truck), so
Jimmy knows what to enter in the move wizard.

**Simulate, step 1 — connect**

```
Server         [ https://api.test.serversherpa.com      ]
Portal email   [                    ]  Password [        ]
                                       2FA code [      ]   (only if asked)
Move           [ pick a move ▾ ]       Move password [        ]
Speed          ( Real time )  ( Fast )
                                                   [ Check server ]
```

**Step 2 — readiness check.** A list, each line pass or fail with what to
fix. Start stays disabled until every line passes.

- Portal sign-in works and may change trucks and read scans and the move.
- The move password signs a kiosk in to this move.
- The move is In progress.
- Every server on the move has a serial; none has an RFID tag yet.
- Containers: at least servers ÷ 20, all empty.
- Trucks: at least containers ÷ 15, none departed.
- Both sites have a latitude and longitude, and the road route was found.
- Every checkpoint in the profile is an active asset status.
- Background workers are running and the server is not read-only.
- If the portal account still has to set up 2FA, the check fails and says
  to finish that in the portal first.
- Warning only (does not block): checkpoints with no enabled status rule,
  named one by one.
- Warning only: the run changes truck statuses and fires status rules, so
  the server sends its normal notifications to anyone watching this move,
  its trucks or its sites.

**Step 3 — run**

```
Move  NAP11 → NAP14   3,000 servers · 150 containers · 10 trucks   Fast
Overall  ████████████░░░░░░░░░░░░  1,412 / 3,000 complete    00:41:07   [ Stop ]

Stage                    Done      Now
RFID enroll            3,000/3,000  ████████████████████
RFID 1 – Cage Exit     3,000/3,000  ████████████████████
Label station          2,870/3,000  ███████████████████░
...
Trucks   loaded 10 · on the road 3 · arrived 7      Truck 08  62% of route

Server   waiting scans 1,204 (peak 5,930)   workers 9/9   failed calls 0

Live feed
14:02:11  Label station 2    labeled       SN 7HK2M93         ok  41 ms
14:02:11  RFID 2 station     10 tags       cart 288           ok  63 ms
14:02:12  Truck 08           location      38.9012, -94.6625  ok  52 ms
```

The feed shows the newest 500 lines; the whole feed goes to a log file.
Closing and reopening the page brings back the current progress and feed.

**Step 4 — result.** Shown on the page when the run ends or is stopped,
and saved to `loadtest/runs/<date-time>/` as `results.json` plus
`events.log`.

- Verdict, with the reasons listed under it:
  - **Pass:** no call failed after its retries, every scan sent was
    processed exactly once, and the final check is clean.
  - **Pass with warnings:** as Pass, but the server processed some retried
    scans twice, or a check was skipped because its status rule is missing.
  - **Fail:** a call failed for good, a scan was never processed, or the
    final check found a server, container or truck in the wrong state.
- Per call type: count, retries, failures, and response time (median, 95th
  percentile, slowest).
- Scans: sent, processed, processed twice, never processed.
- Scan delay: for every scan, the time from `scanned_at` to the server's
  `processed_at` (median, 95th percentile, slowest). This is how far
  behind the server ran.
- Backlog: the count of this run's scans still waiting (raw scans from the
  "Load test" devices, `GET /scans/raw/page`), sampled through the run,
  its peak, and how long after the last scan the server took to finish
  (the catch-up time).
- The server's own view of progress: servers per move status
  (`GET /initiatives/{id}/asset-totals`), sampled through the run.
- Worker status sampled through the run.
- Database health sampled through the run (connections in use and the
  other numbers on Developer › Database › Health), only when the portal
  account is allowed to read that page. Otherwise the result says it was
  not available.
- Every sample is kept with its time in `results.json`, so a chart of the
  backlog or response time over the run can be drawn later.
- Final check, run once the backlog is empty or has stopped shrinking:
  - Every server's scan history has exactly one processed scan per
    checkpoint the run sent for it (one history read per server).
  - Every server has the tag the run gave it.
  - Every server's move status is the profile's final status (`complete`).
    Skipped, with a warning, when no enabled rule fires on the last
    checkpoint.
  - Every container is empty and off its truck; every truck is at the
    destination.
- Run facts: server address, move, counts, speed, profile contents, start
  and end times. Never a password, token or key.

## How devices sign in

- **Kiosk devices** each sign in with the move password
  (`POST /kiosk/move-login`), send a sign-in heartbeat under their own
  serial, and run Kiosk Setup for the move, their site and their
  checkpoint. Handhelds then call with their session.
- **RFID and Label Stations** do the same as a laptop kiosk (heartbeat
  `mode: "laptop"`), set up as a station (RFID Stations with a made-up
  reader: IP, serial, model and versions), then get a station key
  (`POST /kiosk/station-key`) and upload with `Authorization: Station`.
  The key outlives the sign-in, so stations need no token refresh.
- The readiness check signs in once with the move password before the 32
  devices do, because the very first sign-in creates the move's kiosk
  identity.
- **Truck load and unload** send the container's name as a barcode, which
  the server matches as a container.
- **Device names** all start with "Load test" (for example
  "Load test – Label 2") with serials starting `LOADTEST-`, so they are
  easy to find and remove in the device list afterward.
- **Truck calls and result reads** use the portal sign-in.
- Access tokens last 15 minutes and a sign-in lasts 24 hours. The tool
  refreshes tokens, and signs in again when a sign-in ends. It keeps the
  portal's remembered-browser token so a second 2FA code is not needed
  mid-run.
- Passwords stay in the runner's memory for the length of the run only.

## Background traffic every device sends

Real devices do more than scan, and that traffic is part of the load. Each
simulated device also does what the real kiosk app does, at both speeds:

- **One full move download at setup:** the assets, people, containers,
  trucks and label-template sync calls, as `runSync` makes them
  (`kiosk/src/lib/sync.ts`). With 32 devices and 3,000 servers this is the
  startup spike a real move morning produces. Each device makes the calls
  for the load; the runner keeps one copy of the answers to work from.
- **A heartbeat every 60 seconds** (`HEARTBEAT_MS`,
  `kiosk/src/lib/heartbeat.ts:24`). RFID Stations send the station
  heartbeat, including through the hours they sit idle, so they do not
  read as offline. Label Stations send none: the server refuses a Label
  Station key on the station heartbeat.

These calls appear in the result as their own call types.

## When a call fails

- A network error, a 5xx or a 423 (read-only) is retried with the same
  `client_scan_id`, waiting longer each time, up to the profile's retry
  count. Each retry and each final failure is counted and shown.
- A 4xx other than an expired token is not retried: it is recorded as a
  failure with the server's code, and that server or container carries on.
- On a retry of a pack, unpack, load or unload, an answer that says the
  work is already done (for example 409 `not_in_container` on a repeated
  unpack, 409 `not_on_truck` on a repeated unload) counts as success: the
  first try landed and only its answer was lost.
- A retried scan may be processed twice by the server (see "What exists
  today"). The tool notes every scan it retried; the final check finds the
  ones that were in fact processed twice.
- A truck location update has no idempotency key, so a retried one can
  leave a duplicate point. Retried updates are counted.
- Token refresh rotates the cookie, and replaying an old one ends the
  sign-in. Each device has its own cookie jar and refreshes one at a time;
  a refresh whose answer was lost is never retried — the device signs in
  again.
- A scan the server rejects inside an accepted batch counts as a failure.
- Stop ends every device's loop, waits for calls in flight, then writes
  the result with what was done so far.

## Testing

- Unit tests with a fake clock for the stage flow (order, cart and
  container filling, short last cart, truck departure), profile loading,
  retry rules, and placing 68 points along a road line.
- A fake server (in-process) for sign-in, token refresh and the result
  math.
- One real run on the dev stack: a small move at Fast speed, checked
  against the dev database.

## Left to the builder

- File layout inside `loadtest/`, profile file format, port number.
- How pack and unpack calls are spread across a container's 7 minutes.
- Which existing read endpoints give the backlog, processed and unmatched
  counts cheapest.
- Exact retry count and wait times (in the profile).
- How the copied generator page is split into files, if at all.

## Decisions for Jimmy

Claude's calls, each easy to change:

1. **Routing service.** Pick: the public OSRM demo server
   (router.project-osrm.org). No account or key; one request per run that
   sends only the two sites' coordinates. Alternatives: run OSRM ourselves
   in Docker (nothing leaves the network, but a multi-GB map download), or
   a keyed service such as OpenRouteService.
2. **Label printers:** 3 (Jimmy said 2–3).
3. **QA and Complete pace:** 5 people at 15 s per server, copied from
   enroll, because no pace was given.
4. **Truck loading:** one truck at a time by one team.
5. **RFID points are one reader each.** The 20 teams and 4 people set how
   often a cart passes; they are not separate devices.
6. **Destination order:** unload, unpack, RFID 3, RFID 4, QA, Complete.
7. **The page is reachable on the LAN** (binds 0.0.0.0), like the mockup
   server. Anyone on the network could press Start or Stop while it runs.
8. **The generator page is copied** into the tool; the mockup stays.
9. **Verdict is about correctness only**, not speed.
10. **Continue run** is included, because a real-time run lasts two days.
11. **Devices send heartbeats and the setup download**, as real ones do.
12. **Database health is sampled** when the account may read it.
13. **Three verdicts**, not two: a scan the server processed twice after
    a retry is a warning, not a failure.
14. **No charts on the result page.** The samples are saved so one can be
    added; Jimmy decides whether he wants it.
