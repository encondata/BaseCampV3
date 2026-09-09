# ServerSherpa

Datacenter relocation tools — asset tracking, move management, and chain of
custody for IT relocations. This repository holds the V3 platform: a
ground-up rewrite with a security-first design.

## Architecture

| Piece | Stack | Where |
|---|---|---|
| **API** | Python 3.13 · FastAPI · SQLAlchemy 2 (async) · Alembic | [`api/`](api/) |
| **Web portal** | React 18 · Vite · TypeScript | [`portal/`](portal/) |
| **Database** | PostgreSQL 16 (DO Managed Postgres in prod) | migrations in [`api/migrations/`](api/migrations/) |
| **Object storage** | S3-compatible via boto3 (MinIO dev / DO Spaces prod) | private bucket, presigned reads |
| **Kiosk / mobile** | planned — consume the same API | — |

Production target: a single DigitalOcean droplet running Docker Compose
(Caddy → api / portal containers), with managed Postgres and Spaces external.
Nothing stateful lives on the droplet.

### Security design (prime directive)

- Argon2id + server-side pepper for passwords; TOTP seeds encrypted at rest
- Short-lived JWT access tokens; opaque rotating refresh tokens (httpOnly
  cookie scoped to `/auth`) with **replay detection** — a reused token
  revokes the whole session family
- Sessions have an **absolute lifetime** (`SS_SESSION_TTL_SECONDS`, default
  24 h from login); rotation never extends the deadline
- Role grants (`person_roles`) with full grant/revoke history; server-side
  guards (staff cannot manage admins, no self-targeting admin actions)
- All uploads content-sniffed and size-capped; storage bucket is private,
  reads go through short-lived presigned URLs
- Config via typed, validated `Settings` (pydantic-settings); the app
  refuses to boot with missing/invalid config; secrets never in git

## Development setup

Prereqs: Python 3.13+, Node 20+, Docker Desktop.

```bash
# 1. environment — copy the template and fill in dev values
cp .env.example .env        # see comments; generate fresh secrets

# 2. local services (Postgres :5433, MinIO :9000/:9001, Mailpit :8025)
docker compose -f docker-compose.dev.yml up -d

# 3. API
cd api
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
# WeasyPrint (PDF reports) needs Pango: brew install pango  (Debian: apt-get install -y libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libgdk-pixbuf-2.0-0)
# macOS/Homebrew: if `import weasyprint` still fails, export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib
.venv/bin/alembic upgrade head
.venv/bin/serversherpa bootstrap-admin --email you@example.com \
    --first-name You --last-name Name          # prompts for password
.venv/bin/uvicorn --factory serversherpa.api.app:create_app --reload --host 0.0.0.0
# --host 0.0.0.0 so phones/laptops on the network can reach the API too

# 4. Portal (second terminal)
cd portal
npm install
npm run dev                  # http://localhost:5173
```

Or, after the one-time setup above, run the whole dev stack (API +
import worker + portal, all auto-reloading) in a single terminal:

```bash
api/.venv/bin/honcho start -f Procfile.dev
```

Background workers also reload standalone, uvicorn-style:

```bash
api/.venv/bin/serversherpa import-worker --reload
```

Tests (spin up a dedicated `serversherpa_test` database automatically):

```bash
cd api && .venv/bin/pytest
```

Portal typecheck: `cd portal && npx tsc -b`

> macOS note: if the editable install stops importing after a pip install,
> see the `sitecustomize.py` workaround in `api/.venv/…/site-packages`
> (iCloud re-hides `.pth` files, which Python then skips).

## Repository layout

```
api/                  FastAPI app, import worker, CLI (`serversherpa`)
  src/serversherpa/   routers → services → db (no SQL outside repositories)
  migrations/         Alembic — every schema change is a migration
  tests/              integration tests against real Postgres + MinIO
portal/               React portal (login, shell, users, profile, settings)
docker-compose.dev.yml  local stand-ins for the DO managed services
.env.example          documented configuration template (prefix SS_)
BaseCampV2/, fibertrace/   prior-generation reference material (not tracked)
```

## Conventions

- Schema changes only via Alembic; migrations must downgrade cleanly
- UUID primary keys, `timestamptz` everywhere, soft deletes where
  business-meaningful (`archived_at` / `deleted_at`), append-only history
  tables for auth sessions and role grants
- API errors carry stable machine codes: `{"detail": {"code": "..."}}`
- Portal design tokens live in `portal/src/styles/portal-theme.css`
  (ink / white / accent, Geologica + Fragment Mono)
