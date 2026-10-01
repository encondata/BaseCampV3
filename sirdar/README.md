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

One command downloads, installs and runs Sirdar (Docker + code):

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/sirdar/install.sh | bash
```

Or, from a checkout: `bash sirdar/install.sh`. Re-run either one to update:
it pulls the branch, rebuilds, and restarts the stack. It never overwrites an
existing `sirdar/.env`.

Environment overrides:

| Variable | Default |
|---|---|
| `REPO_URL` | `https://github.com/encondata/BaseCampV3.git` |
| `SIRDAR_BRANCH` | `main` |
| `SIRDAR_DIR` | `/opt/sirdar` on Linux, `$HOME/sirdar` on macOS |
| `SIRDAR_PORT` | `8098` (used only when creating `.env`) |
| `SIRDAR_NONINTERACTIVE=1` | never prompt; generate every secret and print the admin commands |

What it does:

- **Ubuntu/Debian:** installs any missing `git`, `curl`, `ca-certificates`
  and `openssl` with apt, and Docker Engine + the compose plugin from
  Docker's official apt repository. Starts the daemon with systemd if needed,
  and adds you to the `docker` group (log out and back in for that to take
  effect; this run uses `sudo docker`). Uses `sudo` only when not root.
- **macOS:** needs Docker Desktop already installed (it starts it if it isn't
  running) and git (`xcode-select --install`).
- **Other systems:** stops with a message.
- Sparse-checks out `sirdar/` plus the portal files the SPA imports into
  `SIRDAR_DIR`, owned by you.
- **First run:** writes `sirdar/.env` (mode 600) from `.env.example`. With a
  terminal it asks for the port, cookie domain, portal database URL, password
  pepper, 2FA key, JWT secret and database password; press Enter to accept
  the default or generate a secret. Without a terminal, or with
  `SIRDAR_NONINTERACTIVE=1`, it generates every secret.
- Builds and starts the stack, waits for it to be healthy, and, when Sirdar
  has no users yet and a terminal is available, offers to create the first
  local admin. It ends with the URL and the admin commands.

The app listens on 127.0.0.1:8098 by default; put a TLS reverse proxy in front.

Admin commands (the installer prints them with your paths):

```bash
docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env exec sirdar sirdar create-admin --email … --first-name … --last-name …
docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env exec sirdar sirdar import-users
docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env exec sirdar sirdar reset-password --email …
```

To run compose by hand instead, copy `sirdar/.env.example` to `sirdar/.env`,
fill in every secret, then
`docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env up -d --build`.

## Security notes

- `SS_PASSWORD_PEPPER` and `SS_TOTP_ENCRYPTION_KEY` must equal the portal's
  values, or copied password hashes and 2FA seeds will not verify. The
  installer generates new ones unless you paste the portal's; to import
  portal users later, set them to the portal's values before creating local
  admins (changing the pepper invalidates local passwords; fix with
  `reset-password`).
- Point `SIRDAR_SOURCE_DATABASE_URL` at a read-only role that can only SELECT
  the tables the import reads. Leave it empty to disable the import.
- Sirdar must sit behind a trusted reverse proxy: the API trusts
  `X-Forwarded-For` for audit and session IPs, uvicorn runs with
  `--forwarded-allow-ips='*'`, and the port is bound to 127.0.0.1. Never expose
  the container port directly.
- Have the proxy rate-limit `/api/auth/*`; account lockout alone does not stop
  password guessing while an account is locked. (A locked account answers
  `account_locked` to every password and adds no strikes, so the lock never
  reveals whether a guess was right. The accepted trade-off: a locked account
  is distinguishable from an unknown email, which answers `invalid_credentials`.)
- The dev import uses the portal's own DB URL, but the import always runs in a
  READ ONLY transaction. In production, use a read-only role anyway.
- Local users created with `create-admin` have no 2FA.
- Never commit `sirdar/.env`.
