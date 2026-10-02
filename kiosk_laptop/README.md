# ServerSherpa Kiosk — Laptop Edition

## What it is

The ServerSherpa kiosk running on a laptop. Today it prints labels over WebUSB
and scans; FX9600 RFID support comes next. After one online sign-in and Kiosk
Setup it keeps working without a network connection and uploads its scans when
the cloud is reachable again.

## Requirements

- Windows 10 22H2 (build 19045) or Windows 11, macOS 13 or later, or a Linux
  system that runs systemd.
- Docker. On Windows and macOS the installer installs Docker Desktop for you.
  On Linux it installs Docker Engine if it is missing.
- Chrome or Edge (WebUSB label printing does not work in other browsers).
- Docker Desktop licensing: it is free only for organizations with fewer than
  250 employees and less than $10M in annual revenue. Above that, each Windows
  or macOS laptop needs a paid Docker seat. Linux uses Docker Engine, which
  has no such limit.

## Install

Windows (PowerShell):

```
irm https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.ps1 | iex
```

macOS and Linux:

```
curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.sh | bash
```

To pass flags on macOS or Linux, use
`curl -fsSL .../install.sh | bash -s -- --channel edge`. On Windows, use the
scriptblock form, which accepts the flags:

```
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.ps1))) -Channel edge
```

You can also run `install.ps1` or `install.sh` from a checkout with the same
flags.

| macOS / Linux | Windows | Meaning |
| --- | --- | --- |
| `--api-url URL` | `-ApiUrl URL` | Cloud API (default `https://api.serversherpa.com`). |
| `--portal-url URL` | `-PortalUrl URL` | Portal address (default: the API URL with `api.` replaced by `portal.`). |
| `--channel NAME` | `-Channel NAME` | `stable` (default) or `edge`. `edge` is for test laptops. |
| `--yes` | `-Yes` | Never prompt. |
| `--start-fresh` | `-StartFresh` | Don't copy an earlier (manually installed) kiosk's data; this laptop gets a new identity. |

What it does: installs Docker if needed, saves your settings in
`config.env`, writes `docker-compose.yml`, downloads the kiosk image, starts
it, schedules the nightly update, and makes the kiosk open in Chrome or Edge
at sign-in (and from a shortcut or menu entry). It ends with a summary. The
same command repairs and updates an existing install, and it keeps the
settings you gave it before.

Where things go:

| | Install folder | Data folder |
| --- | --- | --- |
| Windows | `C:\ProgramData\ServerSherpaKiosk` | `C:\ProgramData\ServerSherpaKiosk\data` |
| macOS | `/Library/Application Support/ServerSherpaKiosk` | `/Users/Shared/ServerSherpaKiosk/data` |
| Linux | `/opt/serversherpa-kiosk` | `/var/lib/serversherpa-kiosk` |

Override them with the `KIOSK_DIR` and `KIOSK_DATA_DIR` environment variables.

A laptop that ran the earlier, manually installed kiosk (Docker Compose project
`serversherpa-kiosk-laptop`) keeps its identity: the installer stops that
kiosk and copies its data folder (the one its container mounts at `/data`)
into the new, empty data folder, once. If the installer can't read that folder
(on Windows, for example, a folder inside WSL such as
`\\wsl$\<distro>\home\<you>\ServerSherpaKiosk`), it stops and tells you where
the data is: copy it into the data folder yourself and run the command again,
or run it with `--start-fresh` (Windows: `-StartFresh`) to start without it.

Windows notes:

- Windows may need a restart to turn on WSL2. The install continues by itself
  when an administrator signs in. If the PC's everyday user isn't an
  administrator, sign in as an administrator once, or run the install command
  again after the restart.
- If the installer adds you to the `docker-users` group, sign out and back in
  before Docker Desktop works for you. The install then continues the same way.

## First run

1. Sign in while online. The laptop registers itself with the cloud.
2. Open Kiosk Setup and pick the move. Its data downloads to the laptop.
3. From then on the kiosk works offline.

Open it at `http://localhost:8090`, or from the ServerSherpa Kiosk shortcut or
menu entry.

## Using the kiosk from other devices

The kiosk also answers on the laptop's network address, so a phone, tablet or
another computer on the same network can use it:

```
http://<laptop-ip>:8090
```

- `<laptop-ip>` is the laptop's address on the local network, for example
  `10.10.48.57`. The kiosk only answers on the laptop's own current addresses
  (it learns them from `host-network.json`, below), plus `localhost`.
- The connection is **not encrypted** (plain HTTP). Passwords and scans cross
  the network as readable text, and the sign-in page says so. Use it only on a
  network you trust. TLS is planned.
- On Linux, ports that Docker publishes bypass ufw and firewalld, so 8090 and
  8091 are open to the network whatever those firewalls say. That is one more
  reason to use the kiosk only on a trusted network.
- Another device uses **the laptop's own setup**: Kiosk Setup belongs to the
  laptop, not to each browser. A phone that signs in starts with the move,
  site, scan type and station the laptop was last set up for, and running
  Kiosk Setup from a phone changes the laptop's setup (the page says so).
- **Label printing** works only on the laptop itself: Chrome only lets a page
  reach a USB printer over `localhost`.
- If another device can't connect, check that the laptop's firewall allows
  incoming connections on ports 8090 and 8091 (Windows and macOS).
- **Existing installs:** a kiosk installed before this release keeps
  `127.0.0.1:8090` (this laptop only) and doesn't publish 8091 until you run
  the install command again. The nightly update changes only the kiosk image,
  not the ports or the jobs.

## RFID station

A kiosk can be an **RFID station** with a Zebra FX9600 reader instead of a
label station. Pair the reader from **Kiosk Setup**: choose RFID Station, then
pick the reader the kiosk finds on the laptop's network (or type its address),
and the kiosk points the reader's tag data at this laptop.

- The reader must run its **IoT Connector (ZIOTC) in Local REST mode**. Set
  that in the reader's web console before pairing. The kiosk signs in to it
  with the reader's admin account.
- Port **8091** is published on every network interface for the reader's tag
  data. Handling tag data comes in a later release: nothing listens on 8091
  yet, so reads go nowhere for now. Pairing only points the reader at it.
- The reader and the laptop must be on the same network. The kiosk scans the
  laptop's own subnets for readers, on port 443 (HTTPS) and port 80 (HTTP).
  It sends no password to a device until that device looks like a Zebra
  reader, and then only the password that worked there before; a reader the
  kiosk hasn't signed in to yet shows as "Zebra reader found — select it to
  connect", and selecting it signs in.
- Pairing and connecting need the cloud: an offline sign-in can scan, but not
  connect or pair.
- The installer adds a small job that writes the laptop's current network
  addresses to `host-network.json` in the data folder every minute:
  - Windows: the scheduled task `ServerSherpa Kiosk Host Network`, as SYSTEM,
    at startup and every minute.
  - macOS: the launch agent `com.serversherpa.kiosk.hostnet`, as the signed-in
    user, at sign-in and every minute.
  - Linux: `serversherpa-kiosk-hostnet.timer`, as root, at boot and every
    minute. Only real adapters count: ones with a device under
    `/sys/class/net`, so not `virbr0`, `tailscale0` and the like. That filter
    also drops bridges, bonds and VLAN interfaces (`br0`, `bond0`,
    `eth0.20`), even when they carry the laptop's real address. On such a
    laptop, enter the laptop's IP by hand in Kiosk Setup's Pair step.

  The installer runs the job once and waits for the file (up to 10 seconds,
  30 on Windows). If none appears, it warns that RFID setup may not find
  readers; the job keeps retrying every minute. The kiosk
  treats addresses older than 5 minutes as unknown, and then can't look for
  readers. An existing install gets the job by running the install command
  again.

## Unattended stations

- Windows and macOS start the kiosk only after someone signs in. For a station
  nobody signs in to, turn on automatic sign-in:
  - Windows: Sysinternals Autologon, or `netplwiz`.
  - macOS: System Settings › Users & Groups › "Automatically log in as".
- Run the installer while signed in as the account that will sign in
  automatically. The nightly update, the launcher and (on macOS) Docker
  Desktop are set up for that account, and the install summary names it
  ("Set up for:").
- Windows: when the install needs a restart, it continues by itself only when
  an administrator signs in. If the automatic sign-in account isn't an
  administrator, run the install command again as that account after the
  restart.
- Linux starts the kiosk at boot (Docker starts it); the browser opens when
  someone signs in to the desktop.

## Updates

- The kiosk updates itself every night at 03:00 local time, to the newest
  image on its channel (`stable` by default; `edge` follows every build of
  `main`).
- It skips the update while scans are uploading, and tries again the next
  night.
- It waits up to 2 minutes for the new version to be healthy. If it isn't, the
  previous version is put back. A version that failed its health check isn't
  tried again until a newer one is published.
- It logs to `update.log` in the install folder.
- Windows: the job (the scheduled task `ServerSherpa Kiosk Update`) runs only
  while the user is signed in, hidden, and also on battery. A run that was
  missed starts at the next sign-in.
- macOS: the launch agent `com.serversherpa.kiosk.update` runs the update.
- Linux: `serversherpa-kiosk-update.timer` runs it, and a missed run happens at
  the next boot.
- To update right now, run the install command again.

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

## Windows label printers

Label printers need the WinUSB driver. Chrome can only print to a USB printer
that no Windows driver has claimed. If the Zebra driver (ZDesigner) is
installed for the printer, Chrome can't connect to it. For each label printer
on the laptop:

1. Plug the printer in and turn it on.
2. Run [Zadig](https://zadig.akeo.ie/), choose Options › List All Devices,
   and select the Zebra printer.
3. Set the driver to **WinUSB** and click Replace Driver.
4. Unplug the printer and plug it back in, then connect it from Label
   Printing › Printers in the kiosk.

That printer then prints only through the kiosk, not through Windows print
dialogs. To undo it, uninstall the device in Device Manager (tick "Delete the
driver software") and reinstall the Zebra driver.

## Data and backups

The data folder (see the table under [Install](#install)) is a normal folder
on the laptop, not a Docker volume. It holds:

- `identity.json` — the kiosk's permanent serial and name.
- `edge.key` — the key that protects cached sign-in data.
- `edge.db` — settings, cached data and scans waiting to upload.
- `host-network.json` — the laptop's network addresses, rewritten every minute
  (see [RFID station](#rfid-station)); nothing to back up.

Back this folder up. Deleting it creates a brand-new kiosk, and any scans that
had not uploaded are lost. Stop the kiosk first so the copy of `edge.db` is
consistent, then copy the whole folder, then start it again:

```
docker compose -f <install folder>/docker-compose.yml stop
docker compose -f <install folder>/docker-compose.yml start
```

Use the install folder for your system from the table above, for example
`/opt/serversherpa-kiosk/docker-compose.yml` on Linux. On Windows that is
`C:\ProgramData\ServerSherpaKiosk\docker-compose.yml`.

## Uninstall

macOS and Linux:

```
curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.sh | bash -s -- --uninstall
```

Windows:

```
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.ps1))) -Uninstall
```

(Or run `install.ps1 -Uninstall` from a checkout.)

It removes the update job, the host network job and the launcher first, then
stops the kiosk. If
Docker isn't running, it stops and asks you to start Docker and run the
command again. It keeps the data folder, `install.log` and `update.log`, and
it never uninstalls Docker.

To delete the data folder too, add `--purge-data` (Windows: `-PurgeData`). It
asks you to type `DELETE`. For a scripted run, set `KIOSK_CONFIRM_PURGE=DELETE`
instead.

## Troubleshooting

- Install log: `install.log` in the install folder. Update log: `update.log`
  in the same folder.
- Kiosk logs: `docker compose -f <install folder>/docker-compose.yml logs -f edge`
- Health: `docker compose -f <install folder>/docker-compose.yml ps` shows the
  container as healthy once the kiosk answers.
- "edge.key is unreadable": stop the kiosk first (it holds an exclusive lock
  on `edge.db`), reset the key, then start it again:

  ```
  docker compose -f <install folder>/docker-compose.yml stop edge
  docker compose -f <install folder>/docker-compose.yml run --rm edge python -m edge reset-key
  docker compose -f <install folder>/docker-compose.yml up -d
  ```

  Everyone then signs in online again; scans waiting to upload are kept and
  go up once their owner signs in online.

## For developers

`kiosk_laptop/docker-compose.yml` builds the image locally from this
repository:

```
EDGE_CLOUD_API_URL=https://api.serversherpa.com \
  docker compose -f kiosk_laptop/docker-compose.yml up -d --build
```

Optional settings: `EDGE_PORTAL_URL`, `EDGE_DATA_HOST_DIR` (default
`~/ServerSherpaKiosk`), `EDGE_OFFLINE_LOGIN_DAYS` (default `14`),
`EDGE_SYNC_INTERVAL_S` (default `300`), and `EDGE_ALLOWED_HOSTS` (extra host
names, comma separated; `localhost`, `127.0.0.1`, `[::1]` and the laptop's
fresh addresses from `host-network.json` are always allowed, any other `Host`
gets 400).

Like the installed kiosk, it publishes the UI (8090) and the reader port
(8091) on every interface; set `EDGE_BIND=127.0.0.1` to keep both on this
machine. See [Using the kiosk from other devices](#using-the-kiosk-from-other-devices)
for what that means (plain HTTP, label printing on the laptop only).

No job writes `host-network.json` in a development setup. To use LAN access or
RFID reader setup, write it yourself (it goes stale after 5 minutes, so loop
it while you work):

```
KIOSK_DATA_DIR=~/ServerSherpaKiosk bash kiosk_laptop/installer/hostnet.sh
```

## Maintainers

Images are published to `ghcr.io/encondata/serversherpa-kiosk-laptop` by the
`kiosk-laptop-image` workflow.

- `main` builds publish `:edge` (and `:sha-<sha7>`). Only a release tag moves
  `:stable`, the installers' default channel.
- Cut a release:

  ```
  git tag kiosk-laptop-vX.Y.Z && git push origin kiosk-laptop-vX.Y.Z
  ```

  Use your remote's name in place of `origin` (`git remote -v` shows it; some
  checkouts call it `github`).

- The encondata organization must allow GitHub Actions to create packages
  (Organization settings › Packages), or the first publish fails.
- After the first publish, make the package public, because the installers
  pull it without signing in: GitHub › encondata › Packages ›
  serversherpa-kiosk-laptop › Package settings › Change visibility › Public.
  Also link it to the BaseCampV3 repository.
