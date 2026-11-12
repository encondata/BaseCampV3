# Kiosk laptop setup: interactive installer for Ubuntu

**Status:** reviewed, waiting on Jimmy's approval, 2026-11-12.

## Why

Today a laptop is set up with one long `curl … | bash -s -- --channel … --api-url … --portal-url …` command.

- Whoever sets up a laptop has to know the right flags for the environment and type them exactly.
- A fresh Ubuntu install doesn't even have `curl`.
- If something is missing or half-installed, they find out in the middle of a wall of output.

Jimmy wants one guided setup that is **wholly responsible for setting up the laptop**, starting from a fresh Ubuntu install. It:
1. shows what's there;
2. lets them pick the environment;
3. installs everything, showing progress;
4. lets them retry anything that fails.

## Goals

1. **A clean start.** One command on a fresh Ubuntu desktop gets a working kiosk. Nothing has to be installed before the command runs.
2. **Three screens, in this order** (Jimmy's words: "first is a picture of what is installed and what is missing. next is a environment selector finally a progress indicator of install progress"):
   1. **Checklist:** each requirement shown as installed, missing (will be installed) or problem (blocks the install).
   2. **Environment picker:** one choice sets both the servers and the app version.
   3. **Progress:** each install step shown as it runs, with an overall progress bar.
3. **Try again.** Any failed step stops the install and offers *Try again* (re-runs that step), *Show details* (the step's log) or *Quit*. Steps already done are not redone.
4. **Re-running is an update.** On a laptop that's already set up, the picker preselects the laptop's current environment, so pressing Enter updates in place. Picking another environment switches it.
5. **Chrome.** The kiosk browser is Google Chrome, installed from Google's own apt repository (not snap Chromium).

## Non-goals

- **Windows and macOS.** This setup is Ubuntu only. The existing `install.sh` keeps serving macOS, and `install.ps1` keeps serving Windows, unchanged.
- **Uninstall.** This setup doesn't uninstall. That stays `install.sh --uninstall`.
- **Per-laptop settings.** Beyond the environment, settings such as data folder overrides and custom URLs stay as `install.sh` flags for the rare case. The setup doesn't expose them.
- **A graphical (windowed) app.** Jimmy was fine with "TUI or a small GUI if we don't have to install anything before it runs". See "How it looks" below.

## Anti-goals

- Anything the user must install, configure or type flags for before the setup runs.
- A setup that leaves the laptop half-configured with no clear way to finish it.
- Removing things the user may rely on. Snap Chromium is left installed. Only snap Docker is replaced, as `install.sh` already does, because it breaks the kiosk.

## Environments (decided with Jimmy)

| Environment | Servers | App version (channel) | Who gets it |
| --- | --- | --- | --- |
| **Prod** (default) | production: `https://api.serversherpa.com`, `https://portal.serversherpa.com` | `stable` (tagged releases) | every normal laptop |
| **RC** | production | `beta` (release candidates) | only laptops deliberately installed as RC |
| **Dev** | dev: `https://api.dev.serversherpa.com`, `https://portal.dev.serversherpa.com` | `beta` (release candidates) | only laptops deliberately installed as Dev |
| **Edge** | dev | `edge` (every push to main) | development laptops |

How a laptop's current environment is recognized from its saved `config.env`:
- Prod is production URLs plus `stable`. RC is production URLs plus `beta`. Dev is dev URLs plus `beta`. Edge is dev URLs plus `edge`.
- Any other combination shows as **Custom (keep current settings)** and is offered as an extra choice. Nothing is lost on a laptop set up with custom flags.

### Switching servers: separate data folders (decided with Jimmy)

The kiosk's data folder holds its identity (`identity.json`, `edge.key`), cached sign-ins and settings, and scans not yet uploaded (`edge.db`). These belong to one server set, so each server set gets its own folder:

| Server set | Data folder |
| --- | --- |
| production (Prod, RC) | `/var/lib/serversherpa-kiosk` (today's folder, so existing production laptops keep their data) |
| dev (Dev, Edge) | `/var/lib/serversherpa-kiosk-dev` |

- Switching between Prod and RC, or between Dev and Edge, keeps the folder.
- Switching between the two server sets stops the kiosk, points it at the other set's folder, and starts it. The other folder is never touched, so switching back picks up the same identity, and its unsent scans upload then.
- The first switch to a set starts a fresh kiosk for that set, which registers as a new kiosk with those servers.
- The picker says so in one line when a switch changes the server set, for example: "This laptop will use a separate dev kiosk. Its production kiosk data is kept for when you switch back."
- **Existing laptops:** a laptop already on dev servers today keeps its data in `/var/lib/serversherpa-kiosk`. My call: on its first run, setup moves that folder to the dev path only if the folder's saved environment is dev. It never moves production data.
- A custom `KIOSK_DATA_DIR` in config.env (set with install.sh flags) is respected and never moved.

## The checklist (screen 1)

| Check | Installed means | Missing → installed by setup | Problem → blocks until fixed |
| --- | --- | --- | --- |
| Ubuntu version | Ubuntu 22.04 or newer, amd64 | — | other distro or version: "This setup supports Ubuntu 22.04 and newer." |
| Administrator rights | the user can use sudo (the setup asks for the password once, up front) | — | not in sudo group |
| Internet | can reach `download.docker.com`, `dl.google.com` and `raw.githubusercontent.com` | — | no network |
| Disk space | at least 10 GB free on `/var/lib` (my call) | — | less |
| Download tools | `curl`, `ca-certificates`, `gpg` | apt install | — |
| Docker Engine | Docker's own packages, service running and enabled at boot, `docker compose` works | installed from Docker's apt repo | — |
| Snap Docker | not present | — (shown as "will be replaced" when present, not as a blocker) | — |
| Google Chrome | `google-chrome-stable` installed | installed from Google's apt repo | — |
| python3 | present | apt install | — |
| USB label printers | the udev rule, the usblp block and no Zebra CUPS queues (the `install.sh` printer block) | set up by setup | — |
| Kiosk | installed, running and healthy, with its environment shown | installed or updated | — |

- A row can be **installed** (green), **missing** (amber, "will be installed") or **problem** (red, with a one-line reason).
- Missing isn't a failure. Problems block: the screen offers *Check again* and *Quit*, but not *Continue*.
- After the environment is picked, the setup also checks that the chosen environment's API answers (`GET {api}/system/status`) before installing. If it doesn't, it shows the error with *Try again*, *Pick another environment* or *Quit*.

## The progress screen (screen 3)

The steps, in order. Each shows pending, running, done or failed, with an overall bar:
1. Install download tools (if missing).
2. Install Docker Engine (if missing; replaces snap Docker).
3. Start Docker and enable it at boot.
4. Install Google Chrome (if missing).
5. Install python3 (if missing).
6. Set up USB label printers.
7. Download the kiosk app for the chosen environment.
8. Start the kiosk and wait for it to be healthy.
9. Install kiosk mode, the Start Kiosk icon, sign-in startup and nightly updates.

- **On failure:** the screen shows the step, a one-line reason and *Try again*, *Show details* or *Quit*.
  - *Try again* re-runs only that step.
  - *Show details* shows the step's log in a scrolling view.
  - Every step's full output goes to a log file whose path is shown at the end and on failure (my call: `/var/log/serversherpa-kiosk-setup.log`).
- **At the end:** "Done. Sign out and back in (or restart) to start the kiosk," with *Restart now* and *Close*.

## How it looks (my call)

- **A text interface in the terminal, built with `whiptail`.** It's preinstalled on Ubuntu (the `whiptail` package, priority important), so nothing is installed first. It has a checklist view, a menu (the picker), a progress gauge, a message box and a scrolling text box. Running everything in the terminal also keeps the sudo password prompt simple.
- **Fallback.** If `whiptail` is missing (a stripped image), the setup falls back to plain numbered prompts with the same three screens.
- **Colors.** `whiptail` can't color single rows, so the states show as text markers: `[ OK ]`, `[ ADD ]`, `[ FIX ]`.

## How it's started

- On a fresh Ubuntu, `curl` isn't there but `wget` is, so the published command uses `wget`:

  ```
  wget -qO- https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/setup.sh | bash
  ```

- The setup reads its answers from `/dev/tty`, because stdin is the pipe.
- **Laptop desktop scripts.** The two desktop scripts made for the test laptop (`update-kiosk.sh`, `install-kiosk.sh`) are replaced by one desktop launcher, "Set up kiosk", that runs this setup in a terminal. My call: the setup writes that launcher, so re-running later is a double-click. It is trusted the same way as the Start Kiosk icon.

## How it's built (my call)

- **A front end over `install.sh`.** The new `kiosk_laptop/installer/setup.sh` is the Ubuntu front end: checks, picker, progress, retry. `install.sh` stays the engine, and macOS, CI end-to-end and the existing flags keep using it as is.
- **How they connect.** `setup.sh` runs `install.sh`'s steps one at a time:
  - Add a step mode to `install.sh`, `--step NAME` (with the environment passed as the existing `--channel`/`--api-url`/`--portal-url` flags). It runs one named step against the saved config.
  - The step names map to the progress list above.
  - Each step must be safe to re-run, which `install.sh`'s steps mostly already are.
- **Chrome.** The Chrome install is a new step in `install.sh`:
  - add Google's signing key and apt source the documented way;
  - install `google-chrome-stable`;
  - set `KIOSK_BROWSER=/usr/bin/google-chrome` in config.env.

  `install.sh` run on its own on Linux gains the same Chrome install, so both paths stay in step.
- **Docker.** Docker comes from Docker's apt repository (the documented `download.docker.com` steps), rather than piping `get.docker.com` into sh. My call: it's the documented path, it's verifiable, and it fits a retryable step.
- **The release ref.** `setup.sh` fetches `install.sh` from the same ref it was fetched from (main by default, `KIOSK_INSTALLER_REF` to override), as `install.sh` already does for its companions.
- **Tests.** Tests follow the existing pytest-with-stubs style in `kiosk_laptop/installer/tests`:
  - stub `whiptail`, apt, docker and the network;
  - drive the screens through a fake tty;
  - cover the environment mapping, the checklist states, a retry after a failed step, re-run preselection, and the plain-prompt fallback.

  shellcheck must be clean. The CI e2e (`test_linux_e2e.sh`) gains one non-interactive `setup.sh` run if practical. Otherwise this is left to the builder.

## Decisions made after review (my calls, settled without changing what gets built)

- **Ubuntu only for the new install paths.** The apt-based Docker and Chrome installs run on Ubuntu (setup.sh, and install.sh when it detects Ubuntu).
  - install.sh run on its own on other Linux distributions keeps `get.docker.com` and the optional browser, unchanged.
  - Chrome is amd64 only (Google ships no arm64 Linux build). On arm64 Ubuntu, setup shows Chrome as a Problem: "Google Chrome isn't available for this processor."
  - install.sh on its own keeps warning and continuing when no browser can be installed.
- **New Ubuntu releases.** When Docker's apt repository doesn't serve the laptop's Ubuntu codename yet, the Docker step falls back to Ubuntu's own `docker.io` and `docker-compose-v2` packages, which install.sh already accepts as Docker Engine, and logs that. The version check has no upper bound.
- **A failed kiosk start.** If step 8 fails (the new image fails its health check, whether or not install.sh rolled back to the earlier image), it is a failed step with *Try again*, *Show details* and *Quit*.
  - *Try again* re-runs the step. The image is tried again, which is install.sh's existing retry behavior.
  - Before applying a new environment, setup snapshots `config.env` and `docker-compose.yml`. *Quit* after a failed switch restores them and restarts the previous kiosk, so the laptop goes back to its previous environment. *Quit* on a laptop with no previous environment leaves the partial install with a message to re-run setup.
- **The test laptop's desktop scripts.** Setup adds the "Set up kiosk" launcher and doesn't delete the existing `update-kiosk.sh` and `install-kiosk.sh`, which the user made.

## Left to the builder

- Exact copy, apart from the strings quoted above. Use American English.
- Exact `whiptail` widget sizes and layout.
- Whether the checks run in parallel.
- How `--step` reports progress back to `setup.sh` (exit codes plus log lines are enough).
- A non-interactive mode for CI or automation (for example `setup.sh --env prod --yes`). It's worth adding if cheap.
