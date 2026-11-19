# deploy/stack — one ServerSherpa environment on one host

Six Compose stacks (seven on a DigitalOcean droplet) run one environment on
a Docker host:

| Stack | Services | Published |
|---|---|---|
| `db` | postgres (16) | — |
| `storage` | seaweedfs, mailpit | 9000 (spaces), 8025 (mailpit UI) |
| `api` | migrate (job), api, 10 workers | 8000 |
| `web` | portal, kiosk, wiki, learn | 8091, 8090, 8096, 8092 |
| `devices` | devices (API + web app), devices-worker | 8093 |
| `status` | status | 8095 |
| `proxy` | caddy | 80 (DigitalOcean droplets only) |

All of them share the Docker network `ss-<env>`. `ss-stack` runs them in
order; Sirdar's deploy pipeline (phase 2) will run the same commands.

The `devices` stack (crew app installs, `devices/`) has its own database,
`serversherpa_devices`, on the environment's database server: `ss-stack up`
creates it when it is missing (before starting the stack), and the service
migrates it on start. Its bucket, `serversherpa-devices`, sits beside the
main one in SeaweedFS or Spaces; the service creates it on start. Its keys
in the `.env` (commented out in `env.example`): `SS_DEVICES_SERVICE_TOKEN`
(hex, shared with the API), `DEVICES_SECRET_KEY` (Fernet: encrypts the saved
Apple settings and signs install links; a new key makes saved Apple settings
unreadable), and optionally `DEVICES_IOS_OWNER_URL` (the devices site of the
stack that owns iPhone installs, for a stack with no Apple settings);
`STACK_DEVICES_PORT` (8093) is its port. The two secrets turn the app on:
- No `STACK_APPS` ("every app"): devices runs only once both are set (not
  `CHANGEME`). Without them every other app runs, the devices stack stays
  stopped, and `ss-stack` hands the compose calls that list as `STACK_APPS`,
  so the portal shows no Devices link. An existing `.env` keeps working.
- A `STACK_APPS` that lists `devices`: `ss-stack up` refuses to start
  without both, naming the missing ones.
- A `STACK_APPS` without `devices`: neither is needed.

Sirdar always writes an explicit `STACK_APPS`, in the order
`wiki,kiosk,learn,status,devices,mailpit`. A new environment runs devices:
Sirdar makes both secrets when it creates the environment and writes them
into the `.env`. An environment created before then keeps its app list
(without devices) until Devices is turned on in its Settings › Apps & mail;
Sirdar makes the secrets then, once, and never replaces a stored
`DEVICES_SECRET_KEY`. Sirdar doesn't manage `DEVICES_IOS_OWNER_URL`: a stack
without Apple settings shows "Apple settings aren't set up yet." Rendering
for a checkout whose `ss-stack` predates Sirdar's devices support (Roll
back, Restore backup, or an Update to an older ref) leaves devices out of
`STACK_APPS` for that deploy, as it does learn for a checkout older than the
learning site. Sirdar tells the two apart by the `DEVICES_DB=serversherpa_devices`
line in `ss-stack`: a commit from before it (79674823f and later know the
app, but not the devices dump, the data VM's `pg_hba.conf` lines or the
devices bucket's own key) runs without devices.

With devices off, the API's internal devices endpoints stay off too.
`ss-stack dump` also dumps the devices database, when it exists, to
`backups/devices/` under the main dump's name (outside the `*.dump` files
that count as backups; rotated with them). `ss-stack restore` stops the
devices stack too and, when that sibling dump is there, empties and
restores the devices database from it; a backup without one leaves the
devices database as it is. Sirdar's Roll back and Restore backup run the
target commit's own `ss-stack restore`, so they bring the devices database
back only when that commit's `ss-stack` is this one or later; an older one
restores the main database and leaves the devices database as it is.
`pgdump` and `revision` cover the main database only. On a LAN Blue/Green
data VM, `pg_hba.conf` lets the app servers in `STACK_DB_ALLOW` reach both
databases. `ss-stack hba` rewrites only that file, as `data` would (Postgres
rereads it only when it changed): Sirdar runs it on the data VM before each
pre-deploy dump, because an Update to an older commit may have left the
devices database's lines out.

## DigitalOcean droplets (Sirdar phase 7)

On a DigitalOcean droplet, Sirdar writes the droplet keys at the end of
`env.example` (`STACK_EXTERNAL_DATA=1`, `STACK_CADDY=1`,
`STACK_NETWORK_SUBNET`, `STACK_HOSTS_IP`, `STACK_TRUSTED_PROXIES`, the
`STACK_DB_*` connection, `SS_DATABASE_URL` / `SS_DATABASE_SSL`, the
`SS_SPACES_*` bucket settings and `STACK_DROPLET_ID`). `ss-stack` then:

- skips the `db` and `storage` stacks: the database is a managed PostgreSQL
  and objects live in DigitalOcean Spaces (mailpit still runs from the
  `storage` stack). The devices service's database, `serversherpa_devices`,
  is on the same cluster, and the `.env` needs `DEVICES_DATABASE_URL` for it
  (`postgresql+asyncpg://`). Sirdar's step 0 creates that database as
  `doadmin`, owned by `serversherpa` (which can't create databases itself),
  and Sirdar writes the URL; a LAN Blue/Green app VM gets one too, for its
  data VM. `ss-stack up` creates the database through a one-off client only
  when it is missing, which needs a role that may create databases. The
  devices service encrypts that connection when `SS_DATABASE_SSL=require`
  and, like the main API, verifies the server against `SS_DATABASE_CA_B64`
  when it is set. The devices bucket may have its own Spaces key
  (`DEVICES_SPACES_ACCESS_KEY` / `DEVICES_SPACES_SECRET_KEY`; without them,
  the main `SS_SPACES_*` key). Sirdar gives each DigitalOcean environment
  that runs devices its own bucket, `<main bucket>-devices`, with its own
  Spaces key (readwrite on that bucket only; the main key's grants never
  change) and CORS for `https://devices.<domain>`, and writes
  `DEVICES_SPACES_BUCKET` and that key into the `.env`. Snapshot bundles
  leave the devices database out: its Apple secrets belong to one stack;
- dumps and restores through a one-off `postgres:16-alpine` container
  against the managed database (`PGSSLMODE=require`, the password from
  `POSTGRES_PASSWORD`, passed through the environment and never on a
  command line);
- creates `ss-<env>` with `STACK_NETWORK_SUBNET` (a `/24`) and the ip-range
  `.128/25`: automatic addresses come from the upper half, so Caddy's fixed
  address in the lower half (`STACK_PROXY_IP`, `.2`) is always free. An
  existing network with another subnet or ip-range is refused (`ss-stack
  down`, `docker network rm ss-<env>`, then run again);
- starts the `proxy` stack (Caddy on :80, behind the load balancer) last.

`ss-stack pgdump <env-dir> <out.dump>` (custom format, no owners or ACLs)
and `ss-stack revision <env-dir>` (the Alembic revision) serve snapshots in
both modes.

`ss-stack admin <env-dir> <args…>` runs `serversherpa bootstrap-admin` in the
running api container (Sirdar's step 11, Create the first admin); stdin (a
typed password) passes through, and its exit code is the command's.

`ss-stack seed <env-dir> [--learning]` runs `serversherpa seed-label-fonts`
and `seed-label-templates` (with `--learning`, `learning-seed` too) in the
running api container (Sirdar's step 20, Seed starter content); the first
command that fails stops it with its exit code.

`STACK_APPS` also reaches the API as `SS_APPS` (the portal hides links to an
app that is off), and `ss-stack` refuses `learn` without `wiki`. With
`devices` off, `ss-stack up` stops the devices stack and creates no
database.
`SS_KIOSK_SIGNING_DIGESTS` (comma-separated SHA-256 digests of the kiosk
app's signing certificates) reaches the API unchanged; empty refuses every
biometric enroll.

## SS_ENV: staging or production

`SS_ENV` in the `.env` is the API's mode, for the API and every worker
(`api/compose.yml`). Left out or empty, it is `staging`, so an environment
whose `.env` predates the setting runs exactly as before. `ss-stack up`
passes the `.env`'s value to Compose (never one from the caller's shell)
and refuses anything but `development`, `staging` or `production` before
it starts a container; the API would crash-loop on any other value.
Sirdar writes `SS_ENV=production` for production environments and
`staging` for every other type (dev, beta, custom); adopting a hand-built
`.env` whose `SS_ENV` doesn't match the type lists it as ignored.

What production changes (`api/src/serversherpa/api/app.py`):

- **CORS:** only `SS_ALLOWED_ORIGINS` (this environment's portal, kiosk,
  wiki, learning and devices sites). Every browser caller in the stack is
  on that list; the laptop kiosk calls through its own origin, the phone
  apps send no Origin, and the status page and Sirdar's smoke test call
  from the server.
- **Docs:** no `/docs` or `/openapi.json` (404).
- Nothing else: the sign-in cookies are Secure in staging too (only
  `development` drops that), no setting is required only in production,
  and no startup check refuses to boot. `development` is for a dev
  machine: it also turns off the Secure flag, so don't use it here.

**Rolling back across the change:** a commit from before `SS_ENV` was a
setting hard-codes `staging` in `api/compose.yml`. A production
environment rolled back (Roll back, Restore backup, an Update to an older
commit) to such a commit runs as staging, CORS open and `/docs` public,
until an Update to a newer commit. Accepted by Jimmy on 2026-11-19.

### Accepted risk: staging CORS

In staging the API accepts credentialed requests from **any** http(s)
origin (the dev/staging `allow_origin_regex`); `SS_ALLOWED_ORIGINS` is not
enforced. The refresh cookie is SameSite=Lax, so unrelated sites can't use
it, but a page on any `*.serversherpa.com` host could call this
environment's API with a signed-in user's session. `/docs` and
`/openapi.json` are also public. Accepted for UAT by Jimmy on 2026-10-03.
Production environments run `SS_ENV=production` instead (above).

## Manual deploy to an Ubuntu host (phase 1)

These steps assume Ubuntu 22.04/24.04 with sudo, on the same LAN as Nginx
Proxy Manager. Use an environment name other than `dev` — the
`*.dev.serversherpa.com` names already serve the Mac dev stack. The first
LAN environment is `uat`.

1. **Docker** (skip if `docker compose version` works):

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker "$USER"   # then log out and back in
   ```

2. **Checkout** (the deployed SHA becomes the image tag):

   ```bash
   sudo mkdir -p /opt/serversherpa/uat && sudo chown "$USER" /opt/serversherpa/uat
   git clone https://github.com/encondata/BaseCampV3.git /opt/serversherpa/uat/repo
   git -C /opt/serversherpa/uat/repo checkout <branch-or-sha>
   ```

   If the repo is private, clone over SSH with a read-only GitHub deploy
   key (repo Settings › Deploy keys), or run `gh auth login` first.

3. **Settings**:

   ```bash
   cp /opt/serversherpa/uat/repo/deploy/stack/env.example /opt/serversherpa/uat/.env
   chmod 600 /opt/serversherpa/uat/.env
   ```

   Edit `/opt/serversherpa/uat/.env`:
   - `STACK_IMAGE_TAG` = `git -C /opt/serversherpa/uat/repo rev-parse --short HEAD`
   - `STACK_PROXY_IP` = NPM's LAN IP
   - every `CHANGEME`: hex values from `openssl rand -hex 32`; the
     Fernet key (goes in `SS_TOTP_ENCRYPTION_KEY`) from
     `python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'`.
     To run the devices app, uncomment and set `SS_DEVICES_SERVICE_TOKEN`
     (hex) and `DEVICES_SECRET_KEY` (a Fernet key) the same way; left
     commented, it stays off.
     To sign in with existing accounts later, `SS_PASSWORD_PEPPER` and
     `SS_TOTP_ENCRYPTION_KEY` must instead equal the values of the
     database you seed from.
   - An existing environment whose `.env` still has `MINIO_ROOT_PASSWORD`
     must rename it to `SPACES_SECRET_KEY` (same value).

4. **Build and start**:

   ```bash
   cd /opt/serversherpa/uat/repo/deploy/stack
   ./ss-stack build /opt/serversherpa/uat
   ./ss-stack up /opt/serversherpa/uat
   ./ss-stack ps /opt/serversherpa/uat
   ```

5. **DNS (Cloudflare, DNS only / grey cloud)** — A records to the WAN IP
   (`curl -fsS https://api.ipify.org` on the host):
   `api.uat`, `portal.uat`, `kiosk.uat`, `wiki.uat`, `learn.uat`, `spaces.uat`, `status.uat`,
   `devices.uat`.

   LAN browsers need the router to support hairpin NAT for the `*.uat`
   names. If it doesn't, add the eight names to local DNS pointing at NPM's
   LAN IP. The containers themselves already go straight to NPM.

   Sirdar does steps 5 and 6 itself for an environment with Publish on
   (Settings > Integrations needs the Cloudflare token and NPM login); the
   hand steps below are for environments it doesn't manage.

6. **Nginx Proxy Manager** — one proxy host per name, scheme `http`,
   forward to the host's LAN IP, Websockets Support ON, then SSL tab:
   request a new Let's Encrypt certificate, Force SSL ON.

   | Domain | Forward port |
   |---|---|
   | `api.uat.serversherpa.com` | 8000 |
   | `portal.uat.serversherpa.com` | 8091 |
   | `kiosk.uat.serversherpa.com` | 8090 |
   | `wiki.uat.serversherpa.com` | 8096 |
   | `learn.uat.serversherpa.com` | 8092 |
   | `spaces.uat.serversherpa.com` | 9000 |
   | `status.uat.serversherpa.com` | 8095 |
   | `devices.uat.serversherpa.com` | 8093 |

   For `spaces`, add to the Advanced tab: `client_max_body_size 0;`
   (large uploads go straight to SeaweedFS). `devices` needs nothing there:
   app packages upload straight to `spaces` too, and the service refuses
   any other request body over 1 MiB. iPhones install over HTTPS only, so
   `devices` needs its certificate before an iPhone can be added.

   The API and the devices service trust forwarded client IPs only from `STACK_PROXY_IP`. If NPM
   ever runs on the same host as the stack, its connections arrive from a
   Docker gateway address, and `STACK_PROXY_IP` must be that address instead.

7. **First admin** (an empty database has no users):

   ```bash
   cd /opt/serversherpa/uat/repo/deploy/stack
   docker compose --env-file /opt/serversherpa/uat/.env -f api/compose.yml \
     exec api serversherpa bootstrap-admin \
       --email you@example.com --first-name First --last-name Last
   ```

   It prompts for the password twice (hidden).

## Updating

```bash
cd /opt/serversherpa/uat/repo/deploy/stack
git -C /opt/serversherpa/uat/repo fetch && git -C /opt/serversherpa/uat/repo checkout <sha>
# set STACK_IMAGE_TAG to the new short SHA in /opt/serversherpa/uat/.env
./ss-stack dump  /opt/serversherpa/uat     # pre-deploy dump; note the path it prints
./ss-stack build /opt/serversherpa/uat
./ss-stack up    /opt/serversherpa/uat     # migrate runs before the API restarts
```

Roll back: its images are still on the host. Warning: the restore
discards everything written after the dump, and files in object storage (SeaweedFS) are not
rolled back. Use the dump `ss-stack dump` printed just before the deploy, or
the newest from `ls -t /opt/serversherpa/uat/backups`. From
`/opt/serversherpa/uat/repo/deploy/stack`:

1. Stop everything that writes to the database:

   ```bash
   for s in api web status; do
     docker compose --env-file /opt/serversherpa/uat/.env -f $s/compose.yml stop
   done
   ```

2. Restore the pre-deploy dump (pick the file from `/opt/serversherpa/uat/backups`)
   into an empty schema. Emptying it first matters: tables the rolled-back
   migration created are not in the dump, so `pg_restore --clean` would
   leave them behind and the next deploy's migrate would fail with
   "relation already exists".

   ```bash
   docker compose --env-file /opt/serversherpa/uat/.env -f db/compose.yml \
     exec -T postgres psql -U serversherpa -d serversherpa -v ON_ERROR_STOP=1 \
     -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
   docker compose --env-file /opt/serversherpa/uat/.env -f db/compose.yml \
     exec -T postgres pg_restore --exit-on-error -U serversherpa -d serversherpa \
     < /opt/serversherpa/uat/backups/<file>.dump
   ```

3. Set `STACK_IMAGE_TAG` in `/opt/serversherpa/uat/.env` back to the previous SHA.
4. `./ss-stack up /opt/serversherpa/uat`

With an `ss-stack` from Sirdar deploy phase 3 on, steps 1 and 2 are one
command (it also starts the database if it is down):
`./ss-stack restore /opt/serversherpa/uat /opt/serversherpa/uat/backups/<file>.dump`.
`./ss-stack data /opt/serversherpa/uat` starts only the database and storage.

## API dependency lock

`api/Dockerfile` installs the API with `pip install -c api/constraints.txt`.
That lock pins serversherpa-api's whole runtime dependency tree to the
versions in `api/.venv`, the venv the API test suite runs in. Without it,
each `ss-stack build` installed the newest PyPI releases of that day, so two
environments deployed at the same commit could run different libraries,
neither of them the ones the tests ran on. The build fails if pip installs
anything the lock doesn't pin at that version (`lock_deps.py verify`, the
step after `pip install`).

`api/pyproject.toml` keeps its `>=` ranges: they say what the code supports,
and the lock says what was tested. `deploy/tests/test_api_lock.py` (in the
fast run) fails when the two disagree: a dependency added or dropped, an
extra or marker changed, or a pin outside its range.

Refresh the lock whenever the venv's packages change (a dependency added or
upgraded), once the API suite passes on them, and commit it with the change.
From the repo root:

```bash
api/.venv/bin/pip install -U pillow                # or: pip install -e './api[dev]' after adding a dependency
(cd api && .venv/bin/python -m pytest -q)          # the API suite, on the new versions
api/.venv/bin/python api/scripts/lock_deps.py      # rewrite api/constraints.txt
git add api/pyproject.toml api/constraints.txt
```

From a worktree, which has no venv, run the main checkout's
`api/.venv/bin/python` on the worktree's `api/scripts/lock_deps.py`. The
script reads the `pyproject.toml` next to it and the packages installed in
the Python that runs it. It follows the dependencies with markers evaluated
for Linux x86_64 and aarch64 (the image's platforms, not the Mac's), and it
stops with an error if the tree needs a package the venv doesn't have. Don't
edit the lock by hand.

- `api/.venv/bin/python api/scripts/lock_deps.py check` exits 1, with a
  diff, when the venv no longer matches the committed lock.
- A new venv on the locked versions (the dev tools aren't locked):
  `api/.venv/bin/pip install -c api/constraints.txt -e './api[dev]'`.

The lock covers Python packages only. The base image (`python:3.13-slim-trixie`),
its pip, and the Debian packages still come from the build day.

## Tests

From the repo root, with any Python that has pytest:

```bash
python -m pytest -c deploy/pytest.ini deploy/tests              # config + script (seconds)
python -m pytest -c deploy/pytest.ini deploy/tests -m images    # build and inspect images
SS_STACK_E2E=1 python -m pytest -c deploy/pytest.ini deploy/tests -m e2e -s   # whole environment
```
