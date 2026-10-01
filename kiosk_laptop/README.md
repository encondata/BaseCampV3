# ServerSherpa Kiosk — Laptop Edition

## What it is

The ServerSherpa kiosk running on a laptop. Today it prints labels over WebUSB
and scans; FX9600 RFID support comes next. After one online sign-in and Kiosk
Setup it keeps working without a network connection and uploads its scans when
the cloud is reachable again.

## Requirements

- Docker Desktop.
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
  `~/ServerSherpaKiosk`). On Windows, set it to a full path such as
  `C:\ServerSherpaKiosk`.
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

## Data and backups

The data folder (default `~/ServerSherpaKiosk`, set by `EDGE_DATA_HOST_DIR`) is
a normal folder on the laptop, not a Docker volume. It holds:

- `identity.json` — the kiosk's permanent serial and name.
- `edge.key` — the key that protects cached sign-in data.
- `edge.db` — settings, cached data and scans waiting to upload.

Back this folder up. Deleting it creates a brand-new kiosk, and any scans that
had not uploaded are lost.

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
