# deploy/stack — one ServerSherpa environment on one host

Five Compose stacks run one environment on a Docker host:

| Stack | Services | Published |
|---|---|---|
| `db` | postgres (16) | — |
| `storage` | seaweedfs, mailpit | 9000 (spaces), 8025 (mailpit UI) |
| `api` | migrate (job), api, 10 workers | 8000 |
| `web` | portal, kiosk, wiki | 8091, 8090, 8096 |
| `status` | status | 8095 |

All of them share the Docker network `ss-<env>`. `ss-stack` runs them in
order; Sirdar's deploy pipeline (phase 2) will run the same commands.

## Accepted risk: staging CORS

These stacks run the API with `SS_ENV=staging`, and outside production the
API accepts credentialed requests from **any** HTTPS origin
(`api/src/serversherpa/api/app.py`, the dev/staging `allow_origin_regex`);
`SS_ALLOWED_ORIGINS` is not enforced. The refresh cookie is SameSite=Lax, so
unrelated sites can't use it, but a page on any `*.serversherpa.com` host
could call this environment's API with a signed-in user's session.
`/docs` and `/openapi.json` are also public. Accepted for UAT by Jimmy on
2026-10-03. Revisit before seeding real accounts that matter, or before
any environment faces untrusted users: make staging honor
`SS_ALLOWED_ORIGINS`.

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
   `api.uat`, `portal.uat`, `kiosk.uat`, `wiki.uat`, `spaces.uat`, `status.uat`.

   LAN browsers need the router to support hairpin NAT for the `*.uat`
   names. If it doesn't, add the six names to local DNS pointing at NPM's
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
   | `spaces.uat.serversherpa.com` | 9000 |
   | `status.uat.serversherpa.com` | 8095 |

   For `spaces`, add to the Advanced tab: `client_max_body_size 0;`
   (large uploads go straight to SeaweedFS).

   The API trusts forwarded client IPs only from `STACK_PROXY_IP`. If NPM
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

## Tests

From the repo root, with any Python that has pytest:

```bash
python -m pytest -c deploy/pytest.ini deploy/tests              # config + script (seconds)
python -m pytest -c deploy/pytest.ini deploy/tests -m images    # build and inspect images
SS_STACK_E2E=1 python -m pytest -c deploy/pytest.ini deploy/tests -m e2e -s   # whole environment
```
