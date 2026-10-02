# Kiosk laptop edition — cross-platform installer

**Date:** 2026-10-01 · **Branch:** `kiosk-installer` · **Status:** design approved by Jimmy
**Builds on:** `docs/superpowers/specs/2026-10-01-kiosk-laptop-design.md` (phase 1, merged 9c3e3f74)

## Goal

One command per operating system turns a laptop — Windows, macOS or Linux —
into a ServerSherpa kiosk station: it detects the OS, installs Docker if it
is missing, pulls our prebuilt image, configures it, and makes the kiosk
start with the laptop and open in the browser. The same command repairs and
upgrades. Laptops then update themselves nightly from a stable channel.

## Decisions (Jimmy, 2026-10-01)

| Topic | Decision |
|---|---|
| Distribution | **Prebuilt multi-arch images** from a registry; no source code or builds on laptops |
| Container engine | **Docker Desktop** on Windows and macOS, **Docker Engine** on Linux |
| Install delivery | **One command per OS** pasted into a terminal; re-run = repair/upgrade |
| Visibility | **Public** image (GHCR) and public install scripts; no registry token |
| Updates | **Automatic nightly** on a `:stable` channel, skipped while scans are uploading, with rollback |
| Browser | **Shortcut + auto-open at login** in Chrome/Edge app mode once the kiosk answers |

Consequences accepted:

- **Docker Desktop licensing.** Free only for organizations under 250
  employees *and* under $10M revenue; above that each laptop needs a paid
  seat. The README states this.
- **Windows/macOS start at login, not at power-on.** Docker Desktop starts
  when a user signs in, and the container (`restart: unless-stopped`) comes
  up with it. Unattended stations should be set to sign in automatically;
  the README says how. Linux starts at boot.
- **Public image and scripts.** The image holds only the built kiosk web app
  and the edge's Python code — no secrets; the cloud URL is entered at
  install time and nothing works without a ServerSherpa sign-in.
  (The main repository `encondata/BaseCampV3` is itself public today, so the
  scripts are served from it directly; no separate install repo.)

## 1. Pieces

### 1.1 CI image build — `.github/workflows/kiosk-laptop-image.yml`

- Triggers: push to `main` touching `kiosk/**`, `kiosk_laptop/**`,
  `portal/src/**` (the kiosk's `@portal` imports), or the workflow file;
  tags matching `kiosk-laptop-v*`; manual dispatch.
- Jobs: (1) edge tests (`kiosk_laptop/edge`, pytest), kiosk tests + build
  (`npm --prefix kiosk ci && test && run build`), installer lint and tests
  (§4); (2) build `kiosk_laptop/Dockerfile` with Buildx + QEMU for
  `linux/amd64,linux/arm64`, passing `KIOSK_VERSION`/`EDGE_VERSION`
  (tag version, or `0.0.0-<sha7>` on `main`); run `scripts/smoke.sh`
  against the amd64 image; (3) push to
  `ghcr.io/encondata/serversherpa-kiosk-laptop` with tags:
  - every `main` build: `:edge` and `:sha-<sha7>`
  - tag `kiosk-laptop-vX.Y.Z`: `:X.Y.Z` and `:stable`
- Uses the built-in `GITHUB_TOKEN` (`packages: write`). The package is set
  public once in GitHub's package settings (documented in the README's
  maintainer section; it's a one-time manual step).

### 1.2 Install scripts — `kiosk_laptop/installer/`

```
kiosk_laptop/installer/
  install.sh            macOS + Linux (bash 3.2-compatible, like sirdar/install.sh)
  install.ps1           Windows (PowerShell 5.1+, the version every Windows 10/11 ships)
  update.sh / update.ps1        nightly updater (installed into the install folder)
  launch.sh / launch.ps1        at-login browser launcher (installed)
  docker-compose.yml    runtime compose: pulls the image, never builds
  tests/                bats-style shell tests + Pester tests (§4)
```

One-liners (served from the public repo, like Sirdar):

```
# Windows — in an admin PowerShell
irm https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.ps1 | iex

# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.sh | bash
```

The scripts download their companion files (`docker-compose.yml`,
`update.*`, `launch.*`) from the same ref they were fetched from
(`KIOSK_INSTALLER_REF`, default `main`), so a script and its files always
match.

Conventions shared with `sirdar/install.sh`: `info`/`warn`/`die` output
helpers; prompts read from `/dev/tty` so `curl … | bash` still prompts;
`KIOSK_NONINTERACTIVE=1` never prompts; environment overrides for every
choice; a library mode (`KIOSK_INSTALL_LIB=1` / `-LibraryOnly`) that defines
the functions without running `main`, so tests can call them.

### 1.3 Edge changes (small)

- **SQLite exclusive locking.** `Store.__init__` runs
  `PRAGMA locking_mode=EXCLUSIVE` before `journal_mode=WAL`. Only the edge
  process ever opens `edge.db`; in exclusive mode WAL keeps its index in
  process memory instead of the `-shm` file, which is what breaks on Docker
  Desktop's shared folders (Windows 9P/WSL file sharing, macOS VirtioFS).
  This makes a host data folder safe on all three OSes and retires the
  README's "run from the WSL2 shell" workaround. Side effect: nothing else
  can open `edge.db` while the edge runs (backups already say "stop first").
- **Version.** `EDGE_VERSION` (build arg → env) is reported in
  `/edge/status` (`version`) and shown in the kiosk footer's Version item
  and the Edge tab, so a laptop on an old image is visible.

### 1.4 Where things live

| | Windows | macOS | Linux |
|---|---|---|---|
| Install folder (compose, `config.env`, scripts, logs) | `C:\ProgramData\ServerSherpaKiosk` | `/Library/Application Support/ServerSherpaKiosk` | `/opt/serversherpa-kiosk` |
| Data folder (`identity.json`, `edge.key`, `edge.db`) | `C:\ProgramData\ServerSherpaKiosk\data` | `/Users/Shared/ServerSherpaKiosk/data` | `/var/lib/serversherpa-kiosk` |
| Docker | Docker Desktop (WSL2 backend) | Docker Desktop | Docker Engine (`get.docker.com`) |

Data is machine-wide (the kiosk belongs to the laptop, not a user) and
outside any user profile. On macOS the data folder is under `/Users/Shared` because Docker
Desktop shares `/Users` with containers by default and not `/Library`. Overrides: `KIOSK_DIR`, `KIOSK_DATA_DIR`.
The data folder is created readable/writable by administrators (root on
macOS/Linux) and the Docker engine only.

## 2. Install flow

Same command installs, repairs and upgrades. Every step checks before
acting; **no step ever modifies the data folder** except creating it and
the one-time migration in step 4.

1. **Preflight.** Admin rights (Windows relaunches itself elevated with
   the same arguments; macOS/Linux `sudo` once, keeping the user's name for
   the per-user parts). Detect OS, architecture and version; refuse below
   Docker Desktop's minimums (Windows 10 22H2 / 11, macOS 13) or Linux
   without systemd. Windows: check virtualization is on (firmware
   setting) and stop with instructions if not. Browser: Windows has Edge;
   prefer Chrome when installed. macOS/Linux: find Chrome/Chromium/Edge;
   warn (don't stop) if none, with the download link.
2. **Docker.** Skip if `docker version` answers.
   - Windows: enable WSL2 (`wsl --install --no-distribution`). If a reboot
     is required: write `install-state.json` (step reached + arguments),
     register a one-time resume (`RunOnce` → the saved script in the
     install folder), tell the technician to restart, exit 0. After the
     next sign-in the installer resumes on its own. Then download Docker
     Desktop and run `"Docker Desktop Installer.exe" install --quiet
     --accept-license --backend=wsl-2`, add the user to `docker-users`.
   - macOS: download `Docker.dmg` for `arm64` or `amd64`, attach, run
     `Docker.app/Contents/MacOS/install --accept-license --user=<user>`.
   - Linux: `get.docker.com` (Debian/Ubuntu/Fedora/RHEL family), then
     `systemctl enable --now docker`.
   - Windows/macOS: turn on Docker Desktop's start-at-sign-in setting
     (its `settings-store.json` `AutoStart: true`; the script edits only
     that key) and start Docker Desktop.
   - Wait up to 3 minutes for the engine; on timeout stop with "Docker
     didn't start — open Docker Desktop once, accept any prompt, then
     re-run this command."
3. **Settings.** Ask for the ServerSherpa API URL (default
   `https://api.serversherpa.com`) and portal URL (derived: `api.` →
   `portal.`; confirm). Flags/env skip prompts: `-ApiUrl`/`--api-url`,
   `-PortalUrl`/`--portal-url`, `-Channel`/`--channel` (`stable` default,
   `edge` for test laptops). On re-run keep saved values unless new ones are
   passed. Validate the URL answers `/system/status` (warn only — the
   laptop may be installed offline). Save `config.env` (`EDGE_CLOUD_API_URL`,
   `EDGE_PORTAL_URL`, `KIOSK_CHANNEL`, `KIOSK_DATA_DIR`).
4. **Files.** Write `docker-compose.yml` (image
   `ghcr.io/encondata/serversherpa-kiosk-laptop:${KIOSK_CHANNEL}`, port
   `127.0.0.1:8090:8090`, data bind mount, `restart: unless-stopped`,
   `env_file: config.env`). Create the data folder.
   **Migration:** if the data folder is empty and a phase-1 manual install's
   `~/ServerSherpaKiosk` (or `EDGE_DATA_HOST_DIR`) holds `identity.json`,
   stop that container if running and copy the folder in, so the laptop
   keeps its serial; leave the old folder in place and say so.
5. **Start.** `docker compose pull`, `docker compose up -d`; wait for the
   container's health check (up to 2 minutes); read `/edge/identity`.
6. **Login items and jobs.**
   - Shortcut "ServerSherpa Kiosk" (Windows: Desktop + Start menu `.lnk`;
     macOS: a small `.app` in `/Applications` that runs the launcher;
     Linux: `~/.local/share/applications/serversherpa-kiosk.desktop`).
   - At-login launcher (Windows: Startup-folder shortcut; macOS: launch
     agent `com.serversherpa.kiosk.launch`; Linux:
     `~/.config/autostart/serversherpa-kiosk.desktop`) that waits up to
     5 minutes for `http://localhost:8090/edge/identity`, then opens
     Chrome/Edge with `--app=http://localhost:8090`. If it never answers,
     it opens the page anyway (the kiosk shows its own offline state).
   - Nightly updater (§3).
7. **Summary.** Serial and name, `http://localhost:8090`, channel and
   version, next steps (sign in online → Kiosk Setup), the sign-in note for
   Windows/macOS (set automatic sign-in for unattended stations), and the
   WinUSB printer note on Windows.

**Failure handling.** Each step prints what it is doing and stops with a
plain-language reason and the fix. Re-running continues safely from any
point. Everything is logged to `install.log` in the install folder.

## 3. Updates and uninstall

### Nightly update

`update.sh` / `update.ps1`, scheduled at 03:00 local time:

- Windows: Task Scheduler task `ServerSherpa Kiosk Update`, run as the user
  Docker Desktop belongs to, only while signed in (the engine only runs
  then anyway).
- macOS: launch agent `com.serversherpa.kiosk.update` (`StartCalendarInterval`).
- Linux: `serversherpa-kiosk-update.timer` (systemd, root,
  `Persistent=true` so a missed night runs at next boot).

Each run:

1. `GET /edge/status`; if `outbox.queued + outbox.sending > 0`, log
   "uploading — skipped" and exit. (Rows waiting for sign-in or marked
   failed don't block: they are in the data folder and survive a restart;
   so do rows mid-send — the edge re-queues `sending` at start.)
2. `docker compose pull`; if the image digest for the channel tag is
   unchanged, exit.
3. Record the running digest in `update-state.json`, `docker compose up -d`.
4. Wait up to 2 minutes for healthy. If not healthy: retag the recorded
   digest, `up -d` again, log "rolled back to <digest>" and exit non-zero.
5. `docker image prune` keeping the previous image.

Logged to `update.log` (last 1 MB kept).

### Uninstall

`install.ps1 -Uninstall` / `install.sh --uninstall`: removes the container,
scheduled jobs, launcher, shortcuts, and the install folder's scripts and
compose file; **keeps the data folder** and prints that it holds the
kiosk's identity and any scans not yet uploaded. `-PurgeData` /
`--purge-data` also deletes it after a typed confirmation (`DELETE`).
Never uninstalls Docker.

## 4. Testing

- **Lint (CI):** `shellcheck` on `install.sh`, `update.sh`, `launch.sh`;
  PSScriptAnalyzer on the `.ps1` files.
- **Linux end to end (CI, ubuntu-latest — has Docker):**
  `install.sh --api-url http://127.0.0.1:9 --yes` with
  `KIOSK_IMAGE` pointed at the just-built image → health OK,
  `/edge/identity`, `config.js` says laptop; re-run → same serial (idempotent);
  `update.sh` with a retagged "newer" image → updated; with a deliberately
  unhealthy image → rolled back; `--uninstall` → data kept;
  `--uninstall --purge-data` (confirmation fed via `KIOSK_TTY`) → gone.
- **Windows and macOS (CI unit tests):** GitHub's Windows and macOS
  runners can't run Docker Desktop, so the scripts keep their decisions in
  small functions tested directly — Pester on `windows-latest` (OS/version
  gates, resume-state read/write, config merge on re-run, compose file
  rendering, update skip/rollback decisions with mocked `docker`/HTTP) and
  the shell tests on `macos-latest` (bash 3.2 compatibility of the same
  functions, macOS paths, launch-agent plist rendering).
- **Edge:** a test that a second sqlite connection cannot write `edge.db`
  while the store holds it (exclusive mode is on); `/edge/status` includes
  `version`.
- **Manual checklist (once per OS before the first `:stable` tag):**
  fresh Windows 11 laptop (WSL enable → reboot → auto-resume → Docker
  Desktop → kiosk opens at next sign-in), Apple-silicon Mac, Ubuntu laptop;
  each: sign in online, Kiosk Setup, scan, reboot → kiosk back by itself,
  force an update (`:edge` channel), uninstall keeps data. Plus, on Windows,
  a Zebra printer through Zadig/WinUSB.
- **Hardware-only checks (CI can't reach these; add to the manual run):**
  - Windows: `SetOwner` on real files and folders (the install files and the
    data folder end up owned by BUILTIN\Administrators), and the `Get-Acl`
    owner read that guards a pre-created data folder.
  - Windows PowerShell 5.1: the raw-string inspect template
    (``{{if eq .Destination `/data`}}``) reaches docker intact and returns
    the phase-1 container's `/data` Source.
  - Docker Desktop's reported mount Source, on Windows (`C:\...`,
    `/run/desktop/mnt/host/c/...`, or a `/run/desktop/mnt/host/wsl/...` or
    `/home/...` WSL path) and on macOS (the plain host path or `/host_mnt/...`).
  - `Invoke-Docker -Stream`: pull progress shows live under 5.1 and pwsh, and
    a refused pull still carries docker's output into the "isn't published
    yet" message.
  - macOS: `stat -f %Su` on `/Users/Shared/ServerSherpaKiosk` as the
    installer runs it (under sudo).
  - A forced rollback on Docker Desktop (Windows and macOS): an unhealthy new
    image from the installer re-run and from the nightly update, then a
    re-run that keeps the rejected image off.
  - Installing from a technician (admin) account versus the account that
    signs in automatically: who the summary's "Set up for" names, who owns
    the update task / launch agents, and that the kiosk opens at the
    auto-login.
  - Upgrading a phase-1 Windows laptop whose kiosk ran from WSL: the
    installer stops with the `\\wsl$` hint; the copy and a re-run work, and
    so does `-StartFresh`.
  - The RunOnce resume when the console user is a standard user (the install
    continues at an administrator sign-in, or after re-running the command).

## 5. README

`kiosk_laptop/README.md` is rewritten around the one-liners:
install, first run, unattended stations (automatic sign-in per OS),
updates and channels, uninstall, data and backups, Docker Desktop
licensing, Windows label printers (Zadig/WinUSB), troubleshooting
(`install.log`, `update.log`, `docker compose logs`), and a maintainer
section (cutting a `kiosk-laptop-vX.Y.Z` release, making the GHCR package
public once). The "run from the WSL2 shell" section is removed (superseded
by exclusive locking). The repo-checkout compose file
(`kiosk_laptop/docker-compose.yml`, which builds locally) stays for
development.

## Out of scope

Code-signed native installers (MSI/PKG/DEB); MDM/Intune deployment
packaging; running without Docker Desktop on Windows/macOS; LAN/VPN access
(still waits on TLS); FX9600 (phase 2).
