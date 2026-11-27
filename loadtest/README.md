# Move load test

## What this is

This tool runs a whole simulated data-center move against a BaseCamp server.
It acts as the 32 devices a real move uses: handhelds, RFID Stations and
Label Stations. It sends every scan and truck update a real move sends, in
the real order. Then it tells you whether the server kept up and whether
every scan landed.

It runs on its own machine and serves a small web page. You start, watch
and read the run on that page.

It has two speeds:

- **Real time** follows the pace of a real crew. A 3,000-server move takes
  about two days.
- **Fast** replaces every wait with a pause of half a second to one second.
  Use it to find where the server slows down.

The tool needs only this folder. It does not import any server code.

## Install

You need Python 3.11 or newer.

```bash
cd loadtest
```

```bash
python3 -m venv .venv && .venv/bin/pip install -e .
```

## Before a run

1. **On a test server, take a snapshot first.** In the portal, open
   Developer › Database › Testing and take a snapshot. After the run you
   can revert to it. See "What a run leaves on the server".
2. **Make the From-To list.** Start the tool (see "Start"), open the page,
   and use **Generate**. Pick the number of servers. The summary tells you
   how many containers and trucks the move needs (20 servers per
   container, 15 containers per truck).
3. **Create the move** in the portal: Bulk Actions › Create a move in steps.
   Upload the From-To list. Enter the container and truck counts the page
   showed. The move needs an origin site and a destination site, and both
   need a latitude and longitude.
4. **Set the move In progress.** Status rules only change a move's servers
   while the move is In progress.
5. **Set a move password** on the move (at least 8 characters). The
   simulated devices sign in with it.
6. **Check the asset statuses.** Every checkpoint the run uses must be an
   active asset status. On a fresh server built from the starter data,
   four are not: `in_container`, `on_truck`, `received` and `un_pack`. The
   readiness check names them. Turn them on in the portal's asset statuses
   before the run (changing statuses needs the developer role).

Use the portal account you will run with. It needs to change trucks and
read scans and the move. If it uses 2FA, keep your authenticator handy.
If the account still has to set up 2FA, finish that in the portal first.

## Start

```bash
.venv/bin/python -m loadtest
```

The tool prints the page's address. Open it in a browser.

### Who can open the page

By default the page is reachable from other machines on your network.
Anyone who opens it can press Start or Stop, so the tool asks for a key:

- **On the runner machine itself**, open `http://localhost:8795`. No key is
  needed.
- **From another machine**, open the full link the tool printed. It ends in
  `/?key=…`. The key changes every time the tool starts. Keep the link to
  yourself.

To keep the page on this machine only:

```bash
.venv/bin/python -m loadtest --host 127.0.0.1
```

Behind a reverse proxy, name the proxy's host so the tool accepts it:

```bash
.venv/bin/python -m loadtest --allow-host loadtest.example.com
```

With `--allow-host`, everyone needs the key, on this machine too. Put
`/?key=…` from the printed link after the proxy's own address.

Other options:

- `--port 8800` uses another port (the default is 8795).
- `--runs-dir /some/folder` saves results somewhere else (the default is
  the `runs` folder in this directory).

### Use the server's https address

Enter the server as `https://…`, the same address the portal uses. The
server only lets a browser keep its sign-in over https (unless the server
runs in development mode). Over plain http, every device has to sign in
again about every 15 minutes. That adds load a real move does not have,
and a portal account with 2FA would be asked for a new code mid-run. The
readiness check warns about this, or fails if 2FA is involved.

## The steps on the page

1. **Connect.** Enter the server address, the portal email and password.
   Enter a 2FA code if the page asks for one.
2. **Pick the move**, enter the move password, and pick the speed.
3. **Check server.** Every line must pass before Start is enabled. Each
   failed line says what to fix. Two lines are only warnings:
   - checkpoints with no enabled status rule (their scans are recorded but
     change no status);
   - the run sends the server's normal notifications to anyone watching
     this move, its trucks or its sites.
4. **Start.** The page shows overall progress, each stage, the trucks, the
   server's waiting scans, and a live feed. You can close the page and
   open it again; the run keeps going.
5. **Stop** ends the run early. It waits for calls already sent, then
   writes the result.

## The two speeds and how long each takes

| Speed | What sets the pace | 60 servers | 600 servers | 3,000 servers |
|---|---|---|---|---|
| Real time | The crew times in the stage table below | about 20 hours (the trip alone is 17) | about a day | about two days |
| Fast | A pause of 0.5 to 1 second between each crew's requests | about 2 minutes | about 5 minutes | roughly 20 to 30 minutes (estimated) |

The fast times were measured against a scratch copy of the server on one
Mac. At fast speed the three Label Stations set the pace, because each
server is labeled one at a time.

The truck trip always sends 68 location updates per truck. At real time
they are 15 minutes apart (17 hours). At fast speed they are 0.5 to 1
second apart.

## Changing the numbers

Every number lives in one file per speed:

- `profiles/real-time.toml`
- `profiles/fast.toml`

Edit the file and start a new run. No code changes. If a value is wrong,
the page says which one when you check the server.

The stages, in order:

| Stage | Checkpoint | Crew | Real-time pace | Devices |
|---|---|---|---|---|
| RFID enroll | `pre_stage` | 5 people | 15 s per server | 5 handhelds |
| RFID 1 – Cage Exit | `rfid_1_cage_exit` | 20 teams, carts of 10 | 10 min per cart | 1 RFID Station |
| Label station | `labeled` | 3 printers | 15–30 s per server | 3 Label Stations |
| RFID 2 – Loading Dock | `rfid_2_loading_dock` | 4 people, carts of 10 | 2–3 min per cart | 1 RFID Station |
| Pack containers | `in_container` | 4 teams, 20 per container | 7 min per container | 4 handhelds |
| Load truck | `on_truck` | 1 team, 15 containers per truck | 8 min per container | 1 handheld |
| Truck trip | — | — | 17 hours, an update every 15 min | — |
| Unload truck | `received` | 1 team | 8 min per container | 1 handheld |
| Unpack containers | `un_pack` | 4 teams | 7 min per container | 4 handhelds |
| RFID 3 – Staging | `rfid_3_staging` | 4 people, carts of 10 | 2–3 min per cart | 1 RFID Station |
| RFID 4 – Into Cage | `rfid_4_into_cage` | 20 teams, carts of 10 | 10 min per cart | 1 RFID Station |
| QA | `qa` | 5 people | 15 s per server | 5 handhelds |
| Complete | `complete` | 5 people | 15 s per server | 5 handhelds |

In a profile, each stage is one `[[stage]]` block. The fields you are most
likely to change:

- `crews`: how many people or teams work the stage at once.
- `devices`: how many devices send the calls.
- `batch`: servers per cart (RFID stages).
- `seconds`: the time per server, cart or container, as `[low, high]`. A
  random time in that range is picked each time. Use the same number twice
  for a fixed time.
- `checkpoint`: the scan status the stage sends.

At the top of the file:

- `container_size` (20) and `containers_per_truck` (15).
- `final_status`: the move status every server should end at (`complete`).
- `heartbeat_seconds`: how often each device reports in (60, as the real
  kiosk app does).
- `sample_seconds`: how often the tool reads the server's waiting scans,
  workers and progress.
- `[retry]`: how many times a failed call is tried, and the waits between
  tries.
- `[trip]`: trip length in hours and minutes between location updates.

## The road route

The trucks follow real roads between the move's two sites. Once per run,
during the readiness check, the tool asks a routing service for the
driving route. It sends only the two sites' latitude and longitude. Each
truck update is placed that far along the road: update 34 of 68 is halfway.

The default service is the public OSRM server
(`https://router.project-osrm.org`). It needs no account. If the route
cannot be found, the run does not start.

To use your own routing service (anything that answers the OSRM
`/route/v1/driving/…` question):

```bash
LOADTEST_ROUTER_URL=https://osrm.example.com .venv/bin/python -m loadtest
```

## Reading the result

The result shows on the page when the run ends. It is also saved in the
run's folder as `results.json` (every number, plus every sample with its
time) and `events.log` (the whole live feed).

### The verdict

- **Pass**: no call failed for good, every scan the run sent was processed
  exactly once, and the final check found nothing wrong.
- **Pass with warnings**: the same, but something needs a look. For
  example, the server processed a scan twice, or a check was skipped
  because a status rule is missing.
- **Fail**: a call failed for good, a scan was never processed, the run
  was stopped early, or the final check found a server, container or truck
  in the wrong state.

The reasons are listed under the verdict, under **Findings**.

### The tables

- **Scans**: scans the run sent for its servers, how many the server
  processed, how many it processed twice, and how many it never processed.
  Load and unload scans name the container, not a server, so they are
  counted on their own line. They are not checked one by one; the waiting
  count reaching zero covers them.
- **Scan delay**: for each scan, the time from when it was scanned to when
  the server finished processing it. Median, 95th percentile (95 out of 100
  scans were faster) and slowest. This is how far behind the server ran.
- **Backlog**: the most scans that were waiting at once (peak), and how
  long the server took to finish them after the run's last step
  (catch-up time).
- **Calls**: every kind of call the run made. For each: how many, how many
  were tried again, how many failed for good, and the response times
  (median, 95th percentile, slowest).
- **Run facts**: server, move, counts, speed, the profile used, start and
  end times, and any interruptions.

`results.json` also keeps, through the run: the waiting count, workers
running, each move status count from the server, and database health (only
when the portal account may read Developer › Database › Health).

### What "processed twice" means

When an answer from the server is lost (a timeout, a dropped connection),
the tool sends the same scan again with the same scan id, as a real kiosk
does. The server ignores the copy only while the first one is still
waiting. If the server already processed the first one, it processes the
copy too. So a busy or flaky network can make the server count a scan twice.

That is a gap in the server, not in the tool. The tool does not hide it: it
finds every scan the server processed twice and lists them as a warning.

## Continuing an interrupted run

A run is **interrupted** when the tool stops without finishing: the runner
machine restarts, the tool is closed, or the process is killed. The run's
journal in its folder records every finished step, so nothing is lost.

When the tool starts again, the page shows the interrupted run with two
choices:

- **Continue run** asks for the passwords again (they are never saved) and
  carries on from the journal.
- **Start new run** discards the interrupted run (the page asks first).

On Continue:

- A step that was sent but not yet recorded is sent again with the same
  scan id, so the server normally counts it once (see "processed twice").
- A cart or container that was half done starts its timer again.
- A truck on the road is placed where the clock says it should be. Location
  updates that fell in the gap are skipped and counted as skipped.
- The result lists each interruption: when it stopped and how long it was
  down.

The Calls table after a Continue counts only the calls made since the
Continue.

## What a run leaves on the server

The tool does not clean up after itself. A run leaves:

- every scan it sent, in each server's scan history;
- the RFID tag it gave each server;
- the servers' move statuses, container contents and truck statuses;
- 32 devices named "Load test – …" with serials starting `LOADTEST-`, in
  Settings › Devices;
- each truck's location updates (68 per truck) and its trip;
- the notifications the server sent to anyone watching the move, its
  trucks or its sites.

**On a test server**, revert to the snapshot you took before the run
(Developer › Database › Testing). That removes everything above.

A move can only be run once: the readiness check needs servers with no RFID
tag, empty containers and trucks that have not left. Make a new move for
the next run, or revert the snapshot.

## Keeping the runner machine awake

A real-time run lasts about two days. If the runner machine sleeps, the run
pauses and the server sees a gap. On a Mac, keep it awake for as long as
the tool runs:

```bash
caffeinate -dimsu .venv/bin/python -m loadtest
```

Also plug the machine in and turn off automatic updates that restart it. If
it does restart, use Continue (see above).

## Developing

### Tests

```bash
.venv/bin/pip install -e '.[dev]'
```

```bash
.venv/bin/python -m pytest -q
```

The tests use an in-process fake of the BaseCamp server
(`tests/fakeserver.py` and `tests/fakeserver_portal.py`) and a fake clock,
so a whole move runs in under a second. When the real server behaves
differently from the fake, fix the fake to match and add a test.

### Trying the page against the fake server

`tests/serve_fake.py` serves the fake on this machine with a 60-server move,
a portal user and a road route, and prints the sign-in details:

```bash
.venv/bin/python tests/serve_fake.py --port 8796
```

```bash
LOADTEST_ROUTER_URL=http://127.0.0.1:8796 .venv/bin/python -m loadtest --host 127.0.0.1
```

### A real scratch server

`tests/e2e/` stands up a throwaway copy of the real BaseCamp API on
`127.0.0.1:8010` from the main checkout, for runs against the real code.
It needs the dev Docker stack (Postgres on 5433, MinIO on 9000), the
repository's `.env` and `api/.venv`.

What the scratch stack shares with the dev stack, and how it is kept apart:

- **Postgres:** the same container, but its own database,
  `serversherpa_loadtest`, restored from
  `api/backups/clean-starter-20NOV26.sql` and migrated to head. The name is
  fixed in `scratch_stack.py`; every create, migrate and drop checks it and
  refuses any other name. The dev database is never touched.
- **Object storage:** the same MinIO, but its own bucket,
  `serversherpa-loadtest`. Import files land there, and `down` removes the
  bucket with everything in it.
- **Code:** the main checkout's `api/` code and virtualenv, without
  `--reload`. Settings come from `.env`, with the scratch database, bucket
  and address set by environment only.
- **No outbound side effects:** push, email, error reporting, AI and spec
  lookup are switched off by environment. The road route comes from a
  canned answer served locally.
- **Processes:** one API, one import worker and one scan-matching worker,
  started by `up` and recorded in pid files. `down` stops only those pids.
- **Admin:** `loadtest-admin@example.com` (developer role) with a password
  generated at run time and written only to the scratch folder.

Logs, pid files, passwords and run folders go to `LOADTEST_SCRATCH_DIR`
(default: `loadtest-scratch` in the system temp folder).

```bash
export LOADTEST_SCRATCH_DIR=/tmp/loadtest-scratch
```

```bash
tests/e2e/scratch_stack.sh up
```

```bash
.venv/bin/python tests/e2e/make_move.py --activate-checkpoints --enable-rules --servers 60
```

That prints the new move's id and writes its move password to
`$LOADTEST_SCRATCH_DIR/moves/<id>.password`. `--planned` leaves the move
Planned; `--disable-rules` turns every status rule off (the scan worker
picks up rule changes within 60 seconds).

Serve the canned road route, and start the tool on this machine only:

```bash
.venv/bin/python tests/e2e/make_move.py --serve-route 8798 &
```

```bash
LOADTEST_ROUTER_URL=http://127.0.0.1:8798 .venv/bin/python -m loadtest --host 127.0.0.1 --runs-dir "$LOADTEST_SCRATCH_DIR/runs" &
```

Then use the page, or drive the tool from the command line:

```bash
.venv/bin/python tests/e2e/drive.py run <move id>
```

`drive.py` also has `check`, `wait`, `state`, `stop` and `continue`.

To see token refresh and new sign-ins within a short run, restart the
scratch processes with short sign-ins (the data stays):

```bash
LOADTEST_SCRATCH_TOKEN_SECONDS=90 LOADTEST_SCRATCH_SESSION_SECONDS=150 tests/e2e/scratch_stack.sh restart
```

When you are done, stop the route server and the tool, then:

```bash
tests/e2e/scratch_stack.sh down
```
