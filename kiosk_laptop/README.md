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

Optional settings: `EDGE_PORTAL_URL` (the portal address, used for links),
`EDGE_BIND` (default `127.0.0.1`; set `0.0.0.0` to serve the LAN or a VPN) and
`EDGE_DATA_HOST_DIR` (where the data folder lives). On Windows, set
`EDGE_DATA_HOST_DIR` to a full path such as `C:\ServerSherpaKiosk`.

## First run

1. Sign in while online. The laptop registers itself with the cloud.
2. Open Kiosk Setup and pick the move. Its data downloads to the laptop.
3. From then on the kiosk works offline.

## Offline

- Who can sign in offline: anyone who signed in online on this laptop in the
  last 14 days, and the set-up move's password.
- What works offline: scanning and the label printer tools.
- What needs the cloud: RFID enroll, packing containers, loading trucks, clock
  in/out, Kiosk Setup and link with phone.

## Data and backups

`~/ServerSherpaKiosk` is a normal folder on the laptop, not a Docker volume. It
holds:

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
  `docker compose -f kiosk_laptop/docker-compose.yml run --rm edge python -m edge reset-key`
- To reach the kiosk from other machines (LAN or VPN), set `EDGE_BIND`.
