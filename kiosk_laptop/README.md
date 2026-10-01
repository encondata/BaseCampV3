# ServerSherpa Kiosk — Laptop Edition

## What it is

The ServerSherpa kiosk running on a laptop. Today it prints labels over WebUSB
and scans; FX9600 RFID support comes next. After one online sign-in and Kiosk
Setup it keeps working without a network connection and uploads its scans when
the cloud is reachable again.

## Requirements

- Docker Desktop (on Windows, with the WSL2 engine — see
  [Windows (WSL2)](#windows-wsl2) before installing).
- Chrome or Edge (WebUSB label printing does not work in other browsers).

## Install

1. Clone or copy this repository onto the laptop.
2. Set `EDGE_CLOUD_API_URL` to your ServerSherpa API and start it:

   ```
   EDGE_CLOUD_API_URL=https://api.serversherpa.com \
     docker compose -f kiosk_laptop/docker-compose.yml up -d
   ```

3. Open `http://localhost:8090`.

Optional settings:

- `EDGE_PORTAL_URL`: the portal address, used for links.
- `EDGE_DATA_HOST_DIR`: where the data folder lives (default
  `~/ServerSherpaKiosk`). On Windows, leave it at the default and run compose
  from the WSL2 shell; don't point it at a `C:\` folder (see
  [Windows (WSL2)](#windows-wsl2)).
- `EDGE_OFFLINE_LOGIN_DAYS` (default `14`): how long after an online sign-in
  a person can still sign in offline on this laptop.
- `EDGE_SYNC_INTERVAL_S` (default `300`): how often the move data is
  refreshed while online.
- `EDGE_ALLOWED_HOSTS`: extra host names the kiosk answers on, comma
  separated. `localhost`, `127.0.0.1` and `[::1]` are always allowed; any
  other `Host` gets 400.
- `EDGE_BIND` (default `127.0.0.1`): must stay `127.0.0.1` until the edge
  supports TLS. WebUSB label printing needs a secure context, which a browser
  only grants to `localhost` over plain HTTP, and sign-ins would cross the
  network in clear text. Do not expose the kiosk to the LAN or a VPN.

## First run

1. Sign in while online. The laptop registers itself with the cloud.
2. Open Kiosk Setup and pick the move. Its data downloads to the laptop.
3. From then on the kiosk works offline.

## Offline

- Who can sign in offline: anyone who signed in online on this laptop in the
  last 14 days (`EDGE_OFFLINE_LOGIN_DAYS`), and the set-up move's password.
  A person whose account is disabled or whose sessions are revoked loses
  offline sign-in the next time the laptop reaches the cloud.
- What works offline: scanning and the label printer tools.
- What needs the cloud: RFID enroll, packing containers, loading trucks, clock
  in/out, Kiosk Setup and link with phone.
- "Offline" means the cloud can't be reached, or it answers 502, 503 or 504
  (a gateway with nothing behind it, or a deploy in progress).
- An offline sign-in keeps working after the internet comes back: scanning
  and the cached move data carry on, and nobody is signed out. Actions that
  need the cloud say "Sign in again while online". Signing out and back in
  while online fixes that, and uploads any scans that were waiting for that
  person.
- Scans waiting to upload are never dropped: when the cloud is busy or
  failing, the laptop keeps retrying (at most every 15 minutes). Only a scan
  the cloud refuses outright is marked failed, and Edge settings can retry
  it.

## Windows (WSL2)

The kiosk runs on Windows through Docker Desktop's WSL2 engine. Three things
differ from a Mac.

**Run everything from the WSL2 shell.** Install a WSL2 distribution (Ubuntu
is fine), turn on Docker Desktop › Settings › Resources › WSL integration for
it, then open the Ubuntu shell and clone the repository there (for example
`~/BaseCampV3`), not under `C:\` or `/mnt/c`. Run the install, update and
troubleshooting commands from that shell, exactly as written in this README.

Why: the data folder holds a SQLite database, and SQLite's locking is not
reliable on Windows folders shared into Docker (`C:\…`, `/mnt/c/…`). Doing so
can give "database is locked" errors or a damaged database. Run from the WSL2
shell, `~/ServerSherpaKiosk` is on the Linux disk, where it is fast and safe.

**The data folder lives inside the WSL2 distribution.** From Windows you can
reach it at `\\wsl$\Ubuntu\home\<you>\ServerSherpaKiosk`. Uninstalling,
resetting or running `wsl --unregister` on that distribution deletes it — and
with it the kiosk's identity and any scans that have not uploaded. Back it up
before any of those (see [Data and backups](#data-and-backups)).

**Label printers need the WinUSB driver.** Chrome can only print to a USB
printer that no Windows driver has claimed. If the Zebra driver (ZDesigner)
is installed for the printer, Chrome can't connect to it. For each label
printer on the laptop:

1. Plug the printer in and turn it on.
2. Run [Zadig](https://zadig.akeo.ie/), choose Options › List All Devices,
   and select the Zebra printer.
3. Set the driver to **WinUSB** and click Replace Driver.
4. Unplug the printer and plug it back in, then connect it from Label
   Printing › Printers in the kiosk.

That printer then prints only through the kiosk, not through Windows print
dialogs. To undo it, uninstall the device in Device Manager (tick "Delete the
driver software") and reinstall the Zebra driver.

Each laptop builds its own image (`up -d --build`), so it does not matter
that Windows laptops are x86 and Macs are ARM.

## Data and backups

The data folder (default `~/ServerSherpaKiosk`, set by `EDGE_DATA_HOST_DIR`) is
a normal folder on the laptop, not a Docker volume. It holds:

- `identity.json` — the kiosk's permanent serial and name.
- `edge.key` — the key that protects cached sign-in data.
- `edge.db` — settings, cached data and scans waiting to upload.

Back this folder up. Deleting it creates a brand-new kiosk, and any scans that
had not uploaded are lost. Stop the kiosk first
(`docker compose -f kiosk_laptop/docker-compose.yml stop`) so the copy of
`edge.db` is consistent, then copy the whole folder. On Windows the folder is
inside the WSL2 distribution; copy it out from `\\wsl$\Ubuntu\home\<you>\` or
with `cp -r ~/ServerSherpaKiosk /mnt/c/Users/<you>/Backups/` from the Ubuntu
shell (a backup copy on `C:\` is fine; only the live folder must stay on the
Linux side).

## Updating

```
git pull
docker compose -f kiosk_laptop/docker-compose.yml up -d --build
```

The data folder is kept.

## Troubleshooting

- Logs: `docker compose -f kiosk_laptop/docker-compose.yml logs -f edge`
- "edge.key is unreadable": run

  ```
  EDGE_CLOUD_API_URL=http://unused docker compose -f kiosk_laptop/docker-compose.yml run --rm edge python -m edge reset-key
  ```

  Everyone then signs in online again; scans waiting to upload are kept and
  go up once their owner signs in online.
- Health: `docker compose -f kiosk_laptop/docker-compose.yml ps` shows the
  container as healthy once the kiosk answers.
