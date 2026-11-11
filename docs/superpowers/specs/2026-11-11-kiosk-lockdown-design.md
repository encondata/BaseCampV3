# Ubuntu Kiosk Lockdown (Laptop Edition) — Design

Status: approved behavior (2026-11-11), design for review. Applies to **Linux laptops only**.
Windows and macOS keep exactly what they have today: `launch.ps1`/`launch.sh --app=` and no lockdown.

## 1. What it does

1. **Startup.** At sign-in the launcher opens a full-screen local page, "Connecting to ServerSherpa…".
   - It tries the cloud every **15 s** and never gives up. The cloud is `EDGE_CLOUD_API_URL` from
     `/opt/serversherpa-kiosk/config.env`, probed at `GET {url}/system/status`. That is the API's
     public status route, which `install.sh` (`check_api_reachable`) and the edge (`Upstream.probe`)
     already use. Any 2xx counts as an answer.
   - The page shows the time of the last attempt (24-hour `HH:MM`) and the network status:
     `Wi-Fi: <name>`, `Wired network`, or `No network`.
   - When the cloud has answered once and the edge answers `GET http://127.0.0.1:8090/edge/identity`,
     the page goes on to the kiosk at `http://localhost:8090`.
   - Chrome (`KIOSK_BROWSER`) runs with `--kiosk`: full screen, with no address bar and no tabs, and
     F11 does nothing.
2. **Watcher.** If Chrome closes for any reason (Alt+F4, Ctrl+Shift+Q, a crash), it is reopened
   within about 3 s. The only exception is an exit with the PIN.
3. **Desktop lock.** While the session runs, the GNOME shortcuts that escape the kiosk are turned
   off for the desktop user (§4). They come back on a PIN exit or when the session ends.
4. **Esc → PIN → desktop.**
   - On a Linux laptop, opened on the laptop itself, Esc opens a PIN pad, but only when nothing else
     took that Esc: no dialog, modal or takeover is open, and no handler called `preventDefault`.
   - The PIN is `csg` in plain text, the same on every laptop. It is a barrier, not a secret.
   - The right PIN stops the watcher, closes Chrome and restores the shortcuts, in that order.
5. **Back into the kiosk.** Sign in again or reboot, or double-click the **Start Kiosk** icon on the
   desktop. The icon is `~/Desktop/serversherpa-start-kiosk.desktop` (the `xdg-user-dir DESKTOP`
   folder), executable and marked `metadata::trusted`.
6. **System info in the top bar** (Linux laptop only):
   - battery %, with a charging icon;
   - the Wi-Fi name and signal strength.
   
   Tapping the network shows the Network modal: the wired status, plus a list of Wi-Fi networks to
   join, with a password field. Everything comes from NetworkManager (`nmcli`) and sysfs, run as the
   desktop user.

## 2. Components

| Piece | Where | Runs as | New / changed |
| --- | --- | --- | --- |
| `kiosk_session.py` | `kiosk_laptop/installer/` → `/opt/serversherpa-kiosk/` | desktop user, in the GNOME session | **new** (python3 stdlib, 3.10+) |
| `launch.sh` | same | desktop user (autostart, menu, Start Kiosk) | Linux: hands off to `kiosk_session.py`; macOS untouched |
| `hostnet.sh` | same | root timer, 60 s | Linux adds `"host_os": "linux"` to `host-network.json` |
| `install.sh` | same | root | copies `kiosk_session.py` (Linux), Start Kiosk icon, python3, uninstall restore |
| `update.sh` | same | root timer, 03:00 | also refreshes `kiosk_session.py` (Linux), checked as Python |
| edge `hostnet.py`, `app.py` | container | — | `read_host_os`; `/config.js` gains `"hostOs"` |
| kiosk web app | `kiosk/src` (built into the image by `kiosk_laptop/Dockerfile`, stage `web`) | browser | PIN pad, Esc rule, top-bar tray, Network modal |

**One process.** `kiosk_session.py run` holds four parts:
- the helper HTTP server;
- the cloud-check loop;
- the desktop lock;
- the Chrome watcher.

Its lifetime is the session's. Autostart already runs `launch.sh` inside the graphical session, with
`DISPLAY`/`WAYLAND_DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`, which gsettings, gio and Chrome need.

A `systemd --user` unit was considered and rejected. It would need the graphical environment
imported into the user manager, and a unit file under the user's home. It would also outlive the
kiosk after a PIN exit, which is not wanted.

**Single instance.** The helper's bind on `127.0.0.1:8092` is the lock. A second `run`, from
autostart plus a double-click on the icon, finds the port taken, logs that, and exits 0.

**How the app knows it is a Linux laptop.**
- `/config.js` already says `mode: "laptop"` (`platform.ts` `isLaptop()`) and `lanAccess`.
- The OS was not known. `hostnet.sh` now writes `"host_os": "linux"` on Linux only. macOS's file
  stays byte-identical, and `hostnet.ps1` is not touched.
- The edge reads it (`read_host_os`; staleness doesn't matter for an OS) and serves `hostOs`.

The UI turns on only when all four hold:
- `isLaptop()`;
- `lanAccess !== true`;
- `hostOs === 'linux'`;
- the page holds a helper token (§3).

So a phone on the LAN, Android, iOS, the web kiosk, and Mac/Windows laptops never show it.

## 3. Helper transport and security

**Choice: a user-level HTTP helper on `127.0.0.1:8092`, which the browser calls directly. The edge
container is not involved.**

The other options were rejected for these reasons:
- **hostnet file drop.** hostnet runs as root once a minute; it can't do a sub-second exit, a live
  Wi-Fi join, or anything in the user's dconf/D-Bus session.
- **Container proxy.** The container is on Docker's bridge, and the host's loopback isn't reachable
  from it. The helper would have to listen on `docker0`, which widens exposure. Proxying would also
  stop working whenever the container is down, and the waiting page exists exactly for those times.

**Rules the helper enforces on every request:**
1. It binds `127.0.0.1` only, so LAN devices can't reach it.
2. **Host check.** `Host` must be exactly `127.0.0.1:8092`; anything else gets 400. This blocks DNS
   rebinding, the same idea as the edge's `HostCheckMiddleware`.
3. **Origin check.** When an `Origin` header is present, it must be `http://localhost:8090` (the
   kiosk) or `http://127.0.0.1:8092` (the waiting page); anything else gets 403. CORS headers go only
   to `http://localhost:8090`. Preflight (`OPTIONS`) is answered only for that origin, with
   `Access-Control-Allow-Private-Network: true` included in case Chrome asks.
4. **Session token.** Each `run` makes a random token (`secrets.token_urlsafe(32)`) and keeps it in
   memory only. Every `/v1/*` call needs `X-Kiosk-Token`, compared with `hmac.compare_digest`.
   - The token goes inline into the waiting page's HTML. Only the same origin can read that page: no
     CORS headers, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, and the Host check.
   - The waiting page hands the token to the kiosk in the URL **fragment**,
     `http://localhost:8090/#kh=<token>`. A fragment is never sent to the edge or logged, and never
     appears on a command line. Chrome is always started at the waiting page's URL, never with the
     token.
   - The kiosk (`captureHelperToken`) moves it into `sessionStorage` (`ss-kiosk-helper-token`) and
     strips it from the address bar before React renders.
   - A per-install token file was rejected. The page would have to fetch it through the edge, and a
     LAN client could fetch it too, since Host headers are spoofable on 0.0.0.0:8090.
5. **What the token stops, and what it doesn't.** Other web pages can't call the helper; any page in
   Chrome is blocked by rules 2–4. A local process can read the waiting page, but it already runs
   with the user's rights (nmcli, gsettings), so that gains it nothing. Other local Unix users are
   out of scope on a single-user kiosk laptop.
6. **Bodies.** A POST must be `application/json` and at most 4 KB. Request lines are never logged
   (`log_message` is a no-op).

**Endpoints** (all JSON; `/v1/*` need the token):

| Method, path | Answer |
| --- | --- |
| `GET /waiting` | the waiting page (HTML, no token needed) |
| `GET /v1/state` | `{"ready": bool, "cloud": bool, "last_attempt": epoch_ms \| null, "system": System}` |
| `GET /v1/system` | `System = {"battery": {"percent": 0-100, "charging": bool} \| null, "wifi": {"ssid", "signal"} \| null, "wired": {"connected": bool, "device": str} \| null, "network": "wifi" \| "wired" \| "none"}` (cached 5 s) |
| `GET /v1/wifi` | `{"networks": [{"ssid", "signal", "secure", "active"}], "wired": …}` (rescans) |
| `POST /v1/wifi/join` `{"ssid", "password"}` | 200 `{"ok": true}`, 422 `{"error": "wrong_password" \| "password_required" \| "not_found" \| "failed"}`, 400 for a bad body |
| `POST /v1/exit` `{"pin"}` | 200 `{"ok": true}`, then the exit runs; 403 `{"error": "wrong_pin"}` |

**The Wi-Fi password** goes only to `nmcli --wait 45 --ask device wifi connect <ssid>`, on **stdin**.
- It is never on argv, which other users can read in `/proc`.
- It is never logged or echoed back. The log line is `join Wi-Fi '<ssid>': <code>`.
- An empty password tries a saved profile.
- The nmcli calls run as the desktop user. On Ubuntu, polkit lets the active local session user
  manage networks.

**System info sources:**
- Battery: `/sys/class/power_supply/*`.
  - Uses the first entry with `type=Battery` and a numeric `capacity`, skipping `scope=Device`
    (mice, headsets).
  - "Charging" means `status=Charging`, or a `Mains` supply is online and the status isn't
    `Discharging`.
- Wi-Fi: `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list --rescan no|auto`. A field
  splitter handles `\:` escapes. Duplicate BSSIDs are merged, and hidden SSIDs are dropped.
- Wired: `nmcli -t -f DEVICE,TYPE,STATE device status`. Uses the first `ethernet` device that isn't
  `unmanaged`; Docker veths are unmanaged.

## 4. Desktop lock and restore

**Keys** (`LOCK_KEYS` in `kiosk_session.py`, set with `gsettings` in the user's session; a missing
schema or key is skipped):

| Group | Keys → locked value |
| --- | --- |
| Super key + overlay | `org.gnome.mutter overlay-key` → `''`; `org.gnome.shell.keybindings` `toggle-overview`, `toggle-application-view`, `toggle-message-tray`, `toggle-quick-settings`, `focus-active-notification`, `switch-to-application-1..9` → `@as []`; `org.gnome.desktop.wm.keybindings` `panel-main-menu` (Alt+F1 opens the overview), `minimize` → `@as []`; `org.gnome.shell.extensions.dash-to-dock hot-keys` → `false` |
| Alt+Tab / switchers | wm.keybindings `switch-applications`, `switch-windows`, `switch-group`, `cycle-windows`, `cycle-group`, `switch-panels`, `cycle-panels`, each with its `-backward` → `@as []` |
| Hot corner | `org.gnome.desktop.interface enable-hot-corners` → `false` |
| Workspaces | `org.gnome.mutter dynamic-workspaces` → `false`; `org.gnome.desktop.wm.preferences num-workspaces` → `1`; wm.keybindings `switch-to-workspace-*` and `move-to-workspace-*` (left/right/up/down/last/1–12) → `@as []`; shell.keybindings `shift-overview-up/down` → `@as []` |

**Save first, then lock.**
- The prior values go to `~/.local/state/serversherpa-kiosk/desktop-lock.json` (mode 600, fsync,
  then rename) **before** any key changes. If that write fails, nothing is locked.
- While the file exists it is never overwritten. A relock after a crash reuses the true originals.
- A key that already holds its locked value at save time is saved as `null`, which means
  `gsettings reset` (the GNOME default) on restore. So a lost or corrupt file can never make the
  locked values the "originals".

**Restore** runs on a PIN exit, and on SIGTERM/SIGHUP/SIGINT (sign-out, power-off, uninstall).
- Each saved key is set back, or reset when saved as `null`.
- The file is deleted when everything worked, or when a key no longer exists. A key that is still
  there but failed stays in the file for the next restore.

**Why a crash or reboot can't lock anyone out for good:**
- The originals are on disk before anything changes, and they survive SIGKILL and power loss.
- The next sign-in starts the session again, which relocks while keeping the file. A PIN exit then
  restores the originals.
- If the session can't start at sign-in, `launch.sh` runs `kiosk_session.py restore` before falling
  back to the old window. That covers a missing browser; a missing `kiosk_session.py` can't have
  locked anything.
- **Uninstall** (`install.sh --uninstall`):
  - It sends SIGTERM to a running session, which restores.
  - Otherwise it runs `restore` through the user's session bus (`/run/user/<uid>/bus`).
  - If the user isn't signed in, it copies `kiosk_session.py` into the user's state folder and adds
    a one-shot autostart entry, `serversherpa-kiosk-restore.desktop`. At their next sign-in that
    entry runs `restore --cleanup` and then deletes itself.
- Support recovery: sign in, wait for the kiosk, press Esc, and type `csg`.

## 5. Waiting page

**Served by the helper, at `http://127.0.0.1:8092/waiting`.** Chrome opens it, and the page
forwards itself to the kiosk once `/v1/state` says `ready`.

There were two other options:
- **Served by the container.** The container can be down or still pulling when the cloud is also
  down: first boot, Docker restarting, the snap-Docker purge. So the "connecting" screen would
  itself fail.
- **A `file://` page.** Its origin is `null`, so it can't read the status without opening CORS to
  `null`, which every sandboxed iframe on the web shares.

The helper is up before Chrome starts, and it is same-origin with its own status.

**What the page shows:**
- The ServerSherpa wordmark, **Connecting to ServerSherpa…**, `Last attempt HH:MM` (`—` before the
  first one), and `Network: …`.
- The house tokens (ink/paper/accent, Geologica/Fragment Mono with fallbacks), light/dark through
  `prefers-color-scheme`, and no scrollbars (`overflow: hidden`).
- Esc opens the same PIN pad there, so a laptop with no network isn't stuck behind a page that
  never forwards.

It polls `/v1/state` every 2 s (assumption). Chrome reopened by the watcher lands on it too and
forwards at once while ready.

## 6. Kiosk web app

- **Esc rule** (`lib/escapeToPin.ts`):
  - A `keydown` listener on `window` in the **capture** phase notes whether a dialog is open:
    `[role=dialog]`, `[role=alertdialog]`, `[aria-modal=true]`, `.modal-scrim`, `.tcx-modal-scrim`,
    or `openTakeovers.length > 0`.
  - A **bubble** listener on `window` opens the PIN pad only when nothing was open at capture time,
    `!e.defaultPrevented`, and `!e.repeat`.
  - Capture is what makes "Esc closes the modal first" hold. Most modals close on Esc without
    `preventDefault`, so a bubble-only check would find the modal already gone.
- **PIN pad** (`components/lockdown/PinPadModal.tsx`):
  - The house modal: `modal-scrim` > `modal-card reports-modal-card rgm-card confirm-card`, with the
    report-generate header (eyebrow `This laptop`, title `Exit the kiosk`, page-hint).
  - One masked `PIN` field (`csg` has letters, so it is a text field, not a digit grid).
  - Cancel and **Exit kiosk** in `modal-foot`, which stays pinned (`confirm-card` flex rules).
  - Wrong PIN: "That PIN isn't right." The field clears.
- **Mounting** (`LockdownLayer`): mounted once in `App.tsx`, so it works on the sign-in screen too.
  - It renders through a portal into `<div class="portal-shell kiosk-shell kiosk-pin-host">`.
  - That div takes the shell's `data-theme` when a shell exists, otherwise `prefers-color-scheme`.
    That gives the tokens and the pinned-foot rules everywhere.
- **Tray** (`components/lockdown/SystemTray.tsx`):
  - It sits first in `.kiosk-user` in `KioskShell`'s top bar and polls `/v1/system` every 15 s
    (assumption; the same as `EDGE_POLL_MS`).
  - It shows a battery icon with a bolt when charging, plus `NN%`.
  - It also shows a network button styled like `.kiosk-name`: Wi-Fi bars (0–3) with the SSID,
    `Wired`, or `No network`.
- **Network modal** (`components/lockdown/NetworkModal.tsx`):
  - The same house modal, portaled into the shell so `.kiosk-top` styles don't reach it.
  - Body: Wired, with `Connected (dev)`, `Not connected` or `No wired adapter`; then Wi-Fi, as the
    existing kiosk `ChoiceCard` radiogroup, with `NN% signal · Secured|Open · Connected`.
  - Foot (always visible): the password field (for a secured network), the error or notice line,
    Close, and Join.
  - It lists again every 15 s while open (assumption).
- **Theme and scrollbars.** The list scrolls inside `.modal-card`, which is already on chrome.css's
  themed rounded-scrollbar list.

## 7. Install, refresh, update

- `install.sh` (and re-running it, as the desktop update script does) delivers everything:
  - it copies `kiosk_session.py` on Linux;
  - it installs `python3` with apt if missing (it is on every Ubuntu desktop);
  - it writes the Start Kiosk icon and marks it trusted, best-effort through the user's bus;
  - the session marks the icon again at each start.
- `update.sh` `refresh_helpers` refreshes `launch.sh` and `hostnet.sh` (unchanged), plus
  `kiosk_session.py` on Linux.
  - A `.py` file is accepted only with a `#!/usr/bin/env python3` shebang that parses
    (`ast.parse`).
  - A refreshed session file takes effect at the next sign-in.
- **Laptops already installed.** Their `update.sh` is never refreshed (by design), so it only
  refreshes `launch.sh`/`hostnet.sh`.
  - The new `launch.sh` falls back to today's `--app` window while `kiosk_session.py` is absent,
    and `hostOs` simply shows up.
  - One run of the install command (the desktop update script) delivers the lockdown. From then on,
    the nightly refresh covers every file.
- **Chrome profile.** The kiosk Chrome runs on its own profile:
  - `--user-data-dir=~/.local/share/serversherpa-kiosk/chrome`;
  - snap Chromium uses `~/snap/chromium/common/serversherpa-kiosk` instead, since the snap can't
    reach hidden folders.
  
  Without its own profile, a Chrome already open on the desktop would take the launch and exit at
  once, which would defeat `--kiosk` and the watcher.
  
  The cost is a one-time loss of what the old default profile held: the kiosk sign-in, browser-local
  settings, and the WebUSB printer permission (pick the printer once). Kiosk Setup and the config
  come back from the edge (`/edge/setup`, `/edge/config`).
- **Chrome flags:** `--kiosk --no-first-run --no-default-browser-check --noerrdialogs
  --password-store=basic --hide-crash-restore-bubble --user-data-dir=…`.

## 8. Limits (not blocked)

- Ctrl+Alt+F1–F12 virtual consoles, the power button and its GNOME dialog, and Ctrl+Alt+Del
  (log-out dialog).
- **Alt+F2** (run a command) and **Ctrl+Alt+T** (terminal) are locked too (`panel-run-dialog` and the
  media-keys `terminal` binding), because both are real escapes.
- Touchpad gestures. A three-finger swipe still opens the Activities overview; GNOME has no gsettings
  key for that. With one fixed workspace, the swipe has nowhere else to go.
- Chrome's own dialogs (print, file pickers).
- Another local Unix user on the laptop could call the helper by reading the waiting page.

## 9. Assumptions (values not given)

| Value | Picked |
| --- | --- |
| Helper port | `127.0.0.1:8092` (8090 UI, 8091 reader) |
| Watch poll / relaunch delay | 1 s / 2 s (about 3 s to reopen) |
| Waiting-page poll | 2 s |
| Tray poll, Network modal re-list | 15 s (as `EDGE_POLL_MS`) |
| System info cache | 5 s |
| Cloud/edge probe timeout | 5 s |
| Chrome stop grace | 5 s SIGTERM, then SIGKILL |
| nmcli join wait | `--wait 45`, process timeout 60 s |
| Body limit / password limit | 4 KB / 128 characters, no control characters; SSID 1–32 bytes |
| PIN match | exact, case-sensitive `csg` |
| Start Kiosk icon | `Icon=web-browser` (theme icon) |
| Session log | `~/.local/state/serversherpa-kiosk/session.log`, last 1 MB (as `update.log`) |

## 10. Testing

- **Installer** (pytest, stubs; `kiosk_laptop/installer/tests`, run on Linux and macOS CI):
  - `test_kiosk_session.py`: the lock with save/restore, crash reuse, null→reset; battery/nmcli
    parsing; join stdin-only; server gates (Host, Origin, token, preflight, body); the watcher
    reopening; exit order; and a drift test of the icon text against `install.sh`.
  - Existing suites extended: `test_hostnet_sh.py` (`host_os`), `test_update_sh.py` (the `.py`
    refresh, Linux only), `test_install_sh.py` (copy, icon, uninstall restore).
  - `test_shellcheck_clean` covers the changed shell scripts.
- **Edge** (`kiosk_laptop/edge/tests`): `read_host_os` and the `hostOs` in `/config.js`.
- **Kiosk** (vitest): token capture and gating; the Esc rule; the PIN pad; the tray; the Network
  modal.
- **Live check on an Ubuntu 24.04 laptop** (plan Task 7), for what stubs can't prove:
  - nmcli `--ask` reads the password from stdin;
  - polkit allows a non-admin desktop user to join Wi-Fi;
  - Chrome on Wayland honors `--kiosk`;
  - a fresh-profile first-run dialog;
  - `gio set metadata::trusted` on the DING desktop;
  - snap Chromium's profile path;
  - Alt+Tab, Super and the hot corner are dead, and come back after `csg`.
