# Sirdar

## What Sirdar is

Sirdar is a standalone app for building, installing, and managing
ServerSherpa environments (portal, kiosk, wiki, API, database). It is one
central instance that manages many environments. This first piece is the
groundwork only: a Dockerized web app with its own database, sign-in for
portal users ranked admin or higher, and the portal's permission model.

## Local development

1. Start Sirdar's database: `docker compose -f docker-compose.dev.yml up -d sirdar-db`
2. Write the dev environment file: `sirdar/scripts/dev-env.sh`
3. Create the virtualenv and migrate:
   `cd sirdar/api && python3.13 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/alembic upgrade head`
4. Run the API (from `sirdar/api`):
   `.venv/bin/uvicorn --factory sirdar_api.api.app:create_app --port 8097 --reload`
5. Run the web app: `npm --prefix sirdar/web install && npm --prefix sirdar/web run dev`
   (http://localhost:5178)
6. Import eligible portal users: `sirdar/api/.venv/bin/sirdar import-users`

Ports: database 127.0.0.1:5434, API 8097, web 5178.

## Tests

- API (from `sirdar/api`): `.venv/bin/pytest -q`
- Web: `npm --prefix sirdar/web test`
- Portal: `npm --prefix portal test`

## First sign-in

- `sirdar create-admin --email … --first-name … --last-name …` creates a local
  admin directly in Sirdar's database.
- `sirdar import-users` copies portal users who are eligible: they have a
  password, are not disabled or archived, and hold an active global role
  ranked admin (60) or higher. Their portal passwords and 2FA keep working.

## Deploy

On a Docker host, run `sirdar/install.sh` (it sparse-checks out `sirdar/` plus
the portal files the SPA imports, creates `sirdar/.env` on the first run, then
builds and starts the stack). Override with `SIRDAR_DIR`, `SIRDAR_BRANCH` (default `main`), or
`REPO_URL`. Or run compose by hand:

```bash
cp sirdar/.env.example sirdar/.env   # then edit it
docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env up -d --build
docker compose -f sirdar/docker-compose.yml run --rm sirdar create-admin --email … --first-name … --last-name …
docker compose -f sirdar/docker-compose.yml run --rm sirdar import-users
```

The app listens on 127.0.0.1:8098 by default; put a TLS reverse proxy in front.

## Security notes

- `SS_PASSWORD_PEPPER` and `SS_TOTP_ENCRYPTION_KEY` must equal the portal's
  values, or copied password hashes and 2FA seeds will not verify.
- Point `SIRDAR_SOURCE_DATABASE_URL` at a read-only role that can only SELECT
  the tables the import reads. Leave it empty to disable the import.
- Sirdar must sit behind a trusted reverse proxy: the API trusts
  `X-Forwarded-For` for audit and session IPs, uvicorn runs with
  `--forwarded-allow-ips='*'`, and the port is bound to 127.0.0.1. Never expose
  the container port directly.
- Have the proxy rate-limit `/api/auth/*`; account lockout alone does not stop
  password guessing while an account is locked. (A locked account answers
  `account_locked` to every password and adds no strikes, so the lock never
  reveals whether a guess was right.)
- The dev import uses the portal's own DB URL, but the import always runs in a
  READ ONLY transaction. In production, use a read-only role anyway.
- Local users created with `create-admin` have no 2FA.
- Never commit `sirdar/.env`.
