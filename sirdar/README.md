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

**Install directory.** The default is `/opt/serversherpa/sirdar` on both Linux
and macOS. On a fresh interactive install the first prompt is
`Install directory [/opt/serversherpa/sirdar]:` (Enter accepts the default; the
answer must be an absolute path, and a leading `~/` is expanded). There is no
prompt when the default directory already exists (an existing install is just
updated), when `SIRDAR_DIR` is set, or when running non-interactively. To pick
a directory up front, including through the curl one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/sirdar/install.sh | SIRDAR_DIR=/srv/sirdar bash
```

The directory is the checkout root, so the app lives in `<dir>/sirdar/` and
its settings in `<dir>/sirdar/.env` (by default
`/opt/serversherpa/sirdar/sirdar/.env`). Creating it may need `sudo` (on macOS
too); the installer then hands the new directories to you.

Environment overrides:

| Variable | Default |
|---|---|
| `REPO_URL` | `https://github.com/encondata/BaseCampV3.git` |
| `SIRDAR_BRANCH` | `main` |
| `SIRDAR_DIR` | `/opt/serversherpa/sirdar` (Linux and macOS); setting it skips the directory prompt |
| `SIRDAR_PORT` | `8098` (used only when creating `.env`) |
| `SIRDAR_BIND` | `127.0.0.1` (used only when creating `.env`); the address the port is published on, default for the listen-address prompt |
| `SIRDAR_NONINTERACTIVE=1` | never prompt; generate every secret and print the admin commands |
| `SIRDAR_DOCKER_VERSION` | newest stable; Linux static installs only: the Docker Engine version to download (e.g. `29.8.2`) |
| `SIRDAR_FORCE_STATIC=1` | off; Linux static installs only: replace Docker binaries in `/usr/local/bin` that the installer didn't put there |

What it does:

- **Linux:** installs any missing `git`, `curl`, `openssl` and CA
  certificates, and Docker Engine with the compose (v2) and buildx plugins,
  the way the table under [Supported systems](#supported-systems) shows. If
  `docker info` already works, it installs nothing for Docker except missing
  compose/buildx plugins, and never starts a daemon. Otherwise it starts the
  daemon (now and at boot) and waits up to 60 s for it. It uses `sudo` only
  when not root, and stops if you are neither root nor have sudo. If Docker
  needs sudo, it adds you to the `docker` group (log out and back in for that
  to take effect; until then the `docker compose ...` admin commands it prints
  start with `sudo`). git must be 2.25 or newer (for sparse checkout). A
  Podman `docker` shim (podman-docker) isn't enough: the installer stops and
  asks for Docker Engine with the compose plugin.
- **macOS:** needs Docker Desktop already installed (it starts it if it isn't
  running) and git (`xcode-select --install`).
- **Other operating systems** (anything but Linux and macOS): stops with a
  message.
- Sparse-checks out `sirdar/` plus the portal files the SPA imports into
  `SIRDAR_DIR`, owned by you.
- **First run:** writes `sirdar/.env` (mode 600) from `.env.example`. With a
  terminal it asks for the port, listen address, cookie domain, public URL(s)
  for CORS, portal database URL, password
  pepper, 2FA key, JWT secret and database password; press Enter to accept
  the default or generate a secret. Without a terminal, or with
  `SIRDAR_NONINTERACTIVE=1`, it generates every secret. Prompts go to the terminal, not stdout, so
  `curl ... | bash > install.log` still shows them.
- **Later runs:** keeps your `.env`, and asks only for settings added since
  your install (`SIRDAR_BIND`, `SIRDAR_ALLOWED_ORIGINS`,
  `SIRDAR_PASSWORD_MIN_LENGTH`) that the file doesn't have yet; a line that is
  present, even blank, is never re-asked or rewritten. Answers are appended
  (mode 600, existing lines untouched). Without a terminal nothing is written
  and the installer lists which settings are using their defaults.
- Builds and starts the stack, waits for it to be healthy, and, when Sirdar
  has no users yet and a terminal is available, offers to create the first
  local admin (the first attempt plus up to 3 retries). It ends with the URL and the admin commands.

The app listens on 127.0.0.1:8098 by default; put a TLS reverse proxy in front.

### Listen address (`SIRDAR_BIND`)

The second first-install prompt, `Listen address`, sets `SIRDAR_BIND` in
`.env`: `127.0.0.1` (default) is this machine only, for a reverse proxy on the
same box; `0.0.0.0` publishes on every interface; or give a specific host IPv4.
Non-interactive installs use the `SIRDAR_BIND` environment variable, else
`127.0.0.1`. Existing installs without the line stay on `127.0.0.1`; add
`SIRDAR_BIND=0.0.0.0` to `.env` and re-run the installer to change it.

Example, an Unraid box at 10.10.48.14 with the reverse proxy elsewhere: bind
`0.0.0.0` and point the proxy at `http://10.10.48.14:8098`.

The app serves plain HTTP. The sign-in cookie is marked `Secure` (production)
and, when `SIRDAR_COOKIE_DOMAIN` is set, only works on that domain, so browsing
to `http://<ip>:<port>` directly will not keep you signed in. Use the proxy's
HTTPS hostname.

### Public URL for CORS (`SIRDAR_ALLOWED_ORIGINS`)

The fourth first-install prompt sets `SIRDAR_ALLOWED_ORIGINS`: the address
people use in the browser, e.g. `https://sirdar.example.com` (comma-separate
several; each is `http(s)://host[:port]`, no path, a trailing `/` is dropped).
Listed origins may call the API from the browser with credentials (allowed
headers: `Authorization`, `Content-Type`, `X-Totp-Challenge`). Blank, the
default, means same-origin only and sends no CORS headers; that is normal,
because the web app and API are served from the same origin. It is only needed
when another site calls the API. A bad value stops the API from starting.

### Minimum password length (`SIRDAR_PASSWORD_MIN_LENGTH`)

Minimum length for local passwords set with the CLI: 4 to 128, default 8 (the
portal's default). Asked about only when re-running the installer on a `.env`
that lacks it.

### Deployment targets (Deploy page)

Optional settings for the Deploy page (read-only cloud views and an SSH
connection test). The installer asks "Configure deployment targets now?" on a
first install, and once on a re-run when the `.env` has none of these keys;
answering no writes them blank. All are `SIRDAR_DEPLOY_*` keys in `.env`:

| Keys | Purpose |
|---|---|
| `DO_TOKEN`, `DO_REGION` | DigitalOcean read-only token; the region is optional (a default for the Deploy page's region list, which comes live from DigitalOcean) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | AWS read-only IAM user |
| `GCP_PROJECT_ID`, `GCP_CREDENTIALS_FILE`, `GCP_REGION` | Google Cloud project and service-account file name |
| `SSH_HOST`, `SSH_PORT` (22), `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY_PATH`, `SSH_KEY_PASSPHRASE` | Custom SSH target |

The installer prompts for DigitalOcean and the SSH host (and for the key
passphrase, hidden, when you name a key file); edit `.env` for AWS and GCP.

**Key files.** Put private keys in `sirdar/deploy-keys/` (git-ignored; created
by the installer, mode 711) and give the bare file name in `SSH_KEY_PATH` or
`GCP_CREDENTIALS_FILE` (no `/` or `..`). The folder is mounted read-only at
`/app/deploy-keys`. The container runs as uid 10001, so that user must be able
to read the file:

    chmod 600 sirdar/deploy-keys/id_ed25519
    sudo chown 10001 sirdar/deploy-keys/id_ed25519

or, if you want to keep your own ownership, make it group-readable by a group
the container user is in (for example `chmod 640` plus a matching group id);
a world-readable key is not recommended. The installer warns when a named key
isn't readable by uid 10001. To keep keys elsewhere, set
`SIRDAR_DEPLOY_KEYS_DIR` to the host folder (relative to `docker-compose.yml`).

**Trusting a host (TOFU).** The first connection test to an SSH host shows its
host-key fingerprint and does not log in. Compare it with the server's real
fingerprint, then trust it on the Deploy page; later tests refuse a host whose
key has changed until you forget the old key and trust the new one. Secrets are
never shown or logged.

### Supported systems

| Family | Detected from `/etc/os-release` (`ID`, else `ID_LIKE`) | Prerequisites with | Docker Engine + compose v2 |
|---|---|---|---|
| Debian | debian, ubuntu and derivatives (Mint, Pop!_OS, Raspberry Pi OS…) | `apt-get` | Docker's apt repository, mapped to the upstream release (`UBUNTU_CODENAME` / `DEBIAN_CODENAME`); static binaries if Docker has no repo for that release |
| Fedora / RHEL | fedora, rhel, centos, rocky, almalinux, ol, amzn | `dnf` (`yum` without dnf) | Docker's repository (`fedora`, `rhel`, else `centos`); static binaries if it has no repo for that release yet. Amazon Linux: the distro's `docker` package plus the compose/buildx plugins |
| SUSE | opensuse-leap, opensuse-tumbleweed, sles | `zypper` | `docker` + `docker-compose` packages |
| Arch | arch, manjaro, endeavouros | `pacman -Syu` (a full system upgrade) | `docker` + `docker-compose` (+ `docker-buildx`) packages |
| Alpine | alpine | `apk` | `docker` + `docker-cli-compose` packages, started with OpenRC |
| Void | void | `xbps-install` | `docker` + `docker-compose` packages, enabled as a runit service |
| Slackware | slackware (or `/etc/slackware-version`) | none: if something is missing it stops and tells you the `slackpkg install …` line (a full install includes them) | Docker's static binaries |
| Gentoo / other | anything else | the first package manager it finds (`emerge` included); otherwise it lists what is missing | Docker's static binaries |

**When packages fail.** Docker's static binaries are used only where they are
the design: Slackware, Gentoo and other systems, and Debian/Ubuntu or
Fedora/RHEL releases (or derivatives) that Docker's repository doesn't cover.
If a package step fails anywhere else (a download error, or another package
job holding the dpkg/rpm lock, such as unattended-upgrades), the installer
stops with the package manager's exit status and asks you to wait and re-run;
it never switches to the static binaries on its own. On Debian and Fedora it
adds Docker's source (`/etc/apt/sources.list.d/docker.list`,
`/etc/yum.repos.d/docker-ce.repo`) only after Docker's signing key downloaded,
and removes a source it just added if the packages then don't install.

**Arch:** pacman supports full upgrades only, so on Arch the installer runs
`pacman -Syu`, which upgrades the whole system along with installing what it
needs.

**Static binaries** (x86_64 and aarch64 only): the newest stable
`docker-X.Y.Z.tgz` from `https://download.docker.com/linux/static/stable/<arch>/`
(or `SIRDAR_DOCKER_VERSION`) goes into `/usr/local/bin` (`docker`, `dockerd`,
`containerd`, `containerd-shim-runc-v2`, `ctr`, `runc`, `docker-init`,
`docker-proxy`). The archive must list cleanly and `docker`/`dockerd` must be
Linux executables. A binary already in `/usr/local/bin` that the installer
didn't put there (it records its own in
`/usr/local/lib/sirdar-installer/static-docker-version`) is left alone with a
warning; set `SIRDAR_FORCE_STATIC=1` to replace it. The compose and buildx
plugins come from their latest GitHub releases into
`/usr/local/lib/docker/cli-plugins/`, checked against the release's published
SHA-256 (compose's `<asset>.sha256`, buildx's `checksums.txt`); a download
that doesn't match is deleted and the installer stops. The installer creates the
`docker` group, then starts `dockerd` by init system: a
`/etc/systemd/system/docker.service` with systemd, `/etc/init.d/docker` with
OpenRC, or, with no init it knows, `nohup dockerd` (with a warning that it
won't start at boot).

**Slackware:** it writes `/etc/rc.d/rc.docker` (`start|stop|restart|status`,
pidfile `/var/run/docker.pid`, log `/var/log/docker.log`), adds a
marked block to `/etc/rc.d/rc.local` that starts it at boot and one to
`/etc/rc.d/rc.local_shutdown` (created if missing) that stops it, then runs
`/etc/rc.d/rc.docker start`. An `rc.docker` you already have (e.g. from
SlackBuilds) is never edited or chmodded, and gets no rc.local block; it is
just started. If it isn't executable (Slackware's "disabled"), the installer
warns and starts it once with `sh /etc/rc.d/rc.docker start`. If `rc.local`
doesn't mention rc.docker, it warns that starting Docker at boot is up to you
(`chmod +x /etc/rc.d/rc.docker` and add it to `rc.local`). An existing
`rc.local` or `rc.local_shutdown` keeps its mode: if it isn't executable, the
installer warns instead of changing it. If `/sys/fs/cgroup` is empty it
tries to mount cgroup2 there first. Re-running doesn't add the blocks twice.

**Alpine:** the installer itself needs bash and curl, so run
`apk add bash curl` first; the one-liner is then unchanged. Running the script
with `sh` stops with a "run it with bash" message.


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
  `--forwarded-allow-ips='*'`, and the port is bound to 127.0.0.1 by default.
  Never expose the container port directly. If you set `SIRDAR_BIND` beyond
  127.0.0.1, LAN clients can spoof `X-Forwarded-For` (audit and session IPs
  only); bind to the proxy-facing address or firewall the port to the proxy.
- Have the proxy rate-limit `/api/auth/*`; account lockout alone does not stop
  password guessing while an account is locked. (A locked account answers
  `account_locked` to every password and adds no strikes, so the lock never
  reveals whether a guess was right. The accepted trade-off: a locked account
  is distinguishable from an unknown email, which answers `invalid_credentials`.)
- The dev import uses the portal's own DB URL, but the import always runs in a
  READ ONLY transaction. In production, use a read-only role anyway.
- Local users created with `create-admin` have no 2FA.
- Never commit `sirdar/.env`.
