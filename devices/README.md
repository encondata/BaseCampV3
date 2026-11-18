# Devices

The Devices service distributes the crew apps: Android APKs and Ad Hoc iOS
IPAs, installed over the air from `devices.<env>.serversherpa.com`. It has its
own FastAPI backend (`devices/api`, package `serversherpa_devices`), its own
Postgres database and its own bucket. It trusts the main API for sign-in.

## Local development

1. Start the dev stack (Postgres on 127.0.0.1:5433, MinIO on :9000):
   `docker compose -f docker-compose.dev.yml up -d postgres minio`
2. Create the dev database `serversherpa_devices` and the bucket
   `serversherpa-devices` (safe to re-run): `scripts/devices-dev-db.sh`
3. Write `devices/.env` (git-ignored). Every setting is `DEVICES_*`:

   | Key | Dev value |
   | --- | --- |
   | `DEVICES_ENV` | `development` |
   | `DEVICES_DATABASE_URL` | `postgresql+asyncpg://<POSTGRES_USER>:<POSTGRES_PASSWORD>@127.0.0.1:5433/serversherpa_devices` |
   | `DEVICES_MAIN_API_URL` | `http://localhost:8000` |
   | `DEVICES_SERVICE_TOKEN` | the same value as the main API's `SS_DEVICES_SERVICE_TOKEN` |
   | `DEVICES_SECRET_KEY` | a Fernet key: `python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'` |
   | `DEVICES_PUBLIC_URL` | `https://devices.dev.serversherpa.com` |
   | `DEVICES_SPACES_ENDPOINT` | `http://<dev box LAN address>:9000` |
   | `DEVICES_SPACES_REGION` | `us-east-1` |
   | `DEVICES_SPACES_ACCESS_KEY`, `DEVICES_SPACES_SECRET_KEY` | the dev MinIO user and password |
   | `DEVICES_SPACES_USE_PATH_STYLE` | `true` |

   Optional: `DEVICES_IOS_OWNER_URL` (the stack that owns iPhone installs, when
   this one doesn't), `DEVICES_STATIC_DIR` (a built web app to serve from `/`),
   `DEVICES_RCODESIGN_PATH` (default `rcodesign`), `DEVICES_AUTHORIZE_CACHE_SECONDS`
   (default 60), `DEVICES_SPACES_BUCKET` (default `serversherpa-devices`).
4. Create the virtualenv and migrate:
   `cd devices/api && python3.13 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/alembic upgrade head`
5. Run the API (from `devices/api`): `.venv/bin/devices serve --reload`
   (binds 0.0.0.0:8099; `curl -s localhost:8099/healthz` answers `{"status":"ok"}`).

Ports: API 8099, web 5180.

## Tests

From `devices/api`: `.venv/bin/pytest -q`

The tests use their own databases on the dev Postgres, `devices_test` and
`devices_test_m0001` (created when missing), never `serversherpa_devices`.
`DEVICES_TEST_DB` picks another name (it must start with `devices_test`), and
`DEVICES_TEST_DATABASE_URL` another server. Otherwise the connection uses the
repo `.env`'s `POSTGRES_USER` and `POSTGRES_PASSWORD` on 127.0.0.1:5433.
