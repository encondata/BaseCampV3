#!/usr/bin/env python3
"""ServerSherpa kiosk session (laptop edition, Linux only).

Started at sign-in by launch.sh (the autostart entry serversherpa-kiosk.desktop),
from the app menu, or from Start Kiosk on the desktop, as the desktop user,
inside the GNOME session. One process holds four parts:

  - a helper on 127.0.0.1:8092. It serves the "Connecting to ServerSherpa…"
    page and answers the kiosk page (battery, network, Wi-Fi, exit), gated by
    Host, Origin and a per-session token;
  - the cloud check, every 15 s, never giving up;
  - the desktop lock: the GNOME shortcuts that escape the kiosk are switched
    off (the earlier values saved first) and put back on exit;
  - the watcher: Chrome in --kiosk mode, reopened whenever it closes, until
    the kiosk is exited with the PIN.

Stdlib only; written for Ubuntu 22.04's python3 (3.10). Refreshed nightly by
update.sh (Linux only).

  kiosk_session.py run --browser PATH   the session (launch.sh)
  kiosk_session.py restore [--cleanup]  put the desktop shortcuts back
                                        (install.sh --uninstall; --cleanup
                                        also removes the one-shot restore entry)
  kiosk_session.py stop-chrome [--browser PATH]
                                        close a Chrome left on the kiosk profile
                                        (launch.sh, before its fallback window;
                                        without --browser, both kiosk profiles)

Exit codes of run: 0 a PIN exit (or another session already running); 1 the
browser can't start or keeps closing; 3 (RC_NO_LOCKDOWN) the kiosk app on this
laptop has no Esc → PIN exit. launch.sh opens the plain app window on any
nonzero code.
"""
from __future__ import annotations

import hmac
import ipaddress
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

KIOSK_DIR = Path(os.environ.get("KIOSK_DIR") or Path(__file__).resolve().parent)
KIOSK_URL = "http://localhost:8090"
KIOSK_ORIGIN = KIOSK_URL
EDGE_IDENTITY_URL = "http://127.0.0.1:8090/edge/identity"
# The kiosk app's lockdown marker: the edge's /config.js has a "hostOs" key
# (added in the same change set as the Esc → PIN pad). 127.0.0.1 as the
# identity probe; the key is served whatever the Host.
EDGE_CONFIG_URL = "http://127.0.0.1:8090/config.js"
RC_NO_LOCKDOWN = 3          # run's exit code when the kiosk app lacks the lockdown
DEFAULT_API_URL = "https://api.serversherpa.com"   # install.sh's default
HELPER_HOST = "127.0.0.1"
HELPER_PORT = 8092          # assumption: next to 8090 (UI) and 8091 (RFID reader)
# A barrier, not a secret (decided): the same on every laptop, plain text.
EXIT_PIN = "csg"
CLOUD_CHECK_S = 15          # decided
WATCH_S = 1.0               # assumption: how often the watcher looks at Chrome
RELAUNCH_DELAY_S = 2.0      # assumption: Chrome is back within about 3 s
WAIT_POLL_MS = 2000         # assumption: the waiting page's poll
SYSTEM_CACHE_S = 5.0        # assumption
PROBE_TIMEOUT_S = 5.0       # assumption
EDGE_LIVE_TIMEOUT_S = 2.5   # assumption: /v1/state's own edge probe
EDGE_CACHE_S = 2.0          # assumption: about the waiting page's poll
CHROME_STOP_S = 5.0         # assumption: SIGTERM grace before SIGKILL
FAST_EXIT_S = 10.0          # assumption: Chrome closing this soon after a launch is a "fast exit"
FAST_EXIT_LIMIT = 5         # assumption: this many fast exits in a row end the session (rc 1)
CONFIG_MAX_BYTES = 65536    # assumption: /config.js is well under 1 KB
JOIN_WAIT_S = 45            # assumption: nmcli --wait
JOIN_TIMEOUT_S = 60         # assumption
MAX_BODY = 4096             # assumption
MAX_PASSWORD = 128          # assumption
LOG_MAX_BYTES = 1_048_576   # as update.log
START_ICON = "serversherpa-start-kiosk.desktop"
RESTORE_AUTOSTART = "serversherpa-kiosk-restore.desktop"
POWER_SUPPLY = Path("/sys/class/power_supply")


# ── Small helpers ─────────────────────────────────────────────────────
def state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "serversherpa-kiosk"


def log(message: str) -> None:
    """One line in session.log (the last LOG_MAX_BYTES kept). Never a password,
    a token or a request line."""
    try:
        d = state_dir()
        d.mkdir(parents=True, exist_ok=True)
        f = d / "session.log"
        if f.exists() and f.stat().st_size > LOG_MAX_BYTES:
            f.write_bytes(f.read_bytes()[-(LOG_MAX_BYTES // 2):])
        with f.open("a", encoding="utf-8") as out:
            out.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def tool_env() -> dict[str, str]:
    """os.environ with untranslated messages, so nmcli's and gsettings' errors
    match the English strings below. C.UTF-8 rather than plain C: in plain C,
    GLib tools escape non-ASCII text (an SSID like "Café") on output. LANGUAGE
    goes because gettext honors it over LC_ALL in any locale but plain C."""
    env = {k: v for k, v in os.environ.items() if k != "LANGUAGE"}
    env["LC_ALL"] = "C.UTF-8"
    return env


def run_cmd(cmd: list[str], *, stdin: str | None = None, timeout: float = 10) -> subprocess.CompletedProcess:
    """Runs a tool in the C locale (tool_env). A missing tool is exit 127 and a
    timeout is 124, never an exception. stdin, when given, is the tool's whole
    input."""
    try:
        return subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout, check=False,
                              env=tool_env())
    except FileNotFoundError:
        return subprocess.CompletedProcess(cmd, 127, "", "")
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", "")


def config_value(key: str, path: Path | None = None) -> str:
    """KEY's value in config.env, read without executing the file ('' when missing)."""
    path = path or KIOSK_DIR / "config.env"
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                return line[len(key) + 1:].strip()
    except OSError:
        pass
    return ""


# ── Desktop lock ──────────────────────────────────────────────────────
# (schema, key, locked value), written with gsettings in the user's session.
# Values are in gsettings' own print format, so "already locked" is a plain
# string compare. A schema or key this desktop doesn't have is skipped.
EMPTY = "@as []"
_WM = "org.gnome.desktop.wm.keybindings"
_SHELL = "org.gnome.shell.keybindings"
_SWITCHERS = ("switch-applications", "switch-windows", "switch-group", "cycle-windows",
              "cycle-group", "switch-panels", "cycle-panels")
_WORKSPACE_KEYS = tuple(f"{verb}-to-workspace-{where}" for verb in ("switch", "move")
                        for where in ("left", "right", "up", "down", "last", *map(str, range(1, 13))))
LOCK_KEYS: tuple[tuple[str, str, str], ...] = (
    # 1. the Super key and the overview it opens
    ("org.gnome.mutter", "overlay-key", "''"),
    (_SHELL, "toggle-overview", EMPTY),
    (_SHELL, "toggle-application-view", EMPTY),
    (_SHELL, "toggle-message-tray", EMPTY),
    (_SHELL, "toggle-quick-settings", EMPTY),
    (_SHELL, "focus-active-notification", EMPTY),
    *((_SHELL, f"switch-to-application-{n}", EMPTY) for n in range(1, 10)),
    ("org.gnome.shell.extensions.dash-to-dock", "hot-keys", "false"),
    (_WM, "panel-main-menu", EMPTY),          # Alt+F1 opens the overview
    (_WM, "minimize", EMPTY),                 # Super+H
    (_WM, "panel-run-dialog", EMPTY),         # Alt+F2 runs a command
    ("org.gnome.settings-daemon.plugins.media-keys", "terminal", EMPTY),  # Ctrl+Alt+T
    # 2. Alt+Tab and the other window switchers
    *((_WM, k, EMPTY) for name in _SWITCHERS for k in (name, f"{name}-backward")),
    # 3. the Activities hot corner
    ("org.gnome.desktop.interface", "enable-hot-corners", "false"),
    # 4. workspaces: one, fixed, with no keys to switch or move
    ("org.gnome.mutter", "dynamic-workspaces", "false"),
    ("org.gnome.desktop.wm.preferences", "num-workspaces", "1"),
    (_SHELL, "shift-overview-up", EMPTY),
    (_SHELL, "shift-overview-down", EMPTY),
    *((_WM, k, EMPTY) for k in _WORKSPACE_KEYS),
)


def gsettings_get(schema: str, key: str) -> str | None:
    r = run_cmd(["gsettings", "get", schema, key])
    return r.stdout.strip() if r.returncode == 0 else None


def gsettings_set(schema: str, key: str, value: str) -> bool:
    return run_cmd(["gsettings", "set", schema, key, value]).returncode == 0


def gsettings_reset(schema: str, key: str) -> bool:
    return run_cmd(["gsettings", "reset", schema, key]).returncode == 0


def gsettings_gone(r: subprocess.CompletedProcess) -> bool:
    """True only when gsettings itself says the schema or key doesn't exist on
    this desktop. A timeout, a missing gsettings or a D-Bus/dconf error is not
    "gone": the key may well be there and still locked."""
    return r.returncode != 0 and ("No such schema" in r.stderr or "No such key" in r.stderr
                                  or "No such schema" in r.stdout or "No such key" in r.stdout)


def lock_file() -> Path:
    return state_dir() / "desktop-lock.json"


def _set_aside_corrupt() -> None:
    """A corrupt desktop-lock.json is kept as desktop-lock.json.corrupt, so
    nothing in it is lost."""
    f = lock_file()
    try:
        os.replace(f, f.with_name(f.name + ".corrupt"))
        log("desktop-lock.json is corrupt; kept as desktop-lock.json.corrupt")
    except OSError as exc:
        log(f"desktop-lock.json is corrupt and can't be set aside ({exc})")


def read_saved() -> list[dict] | None:
    """The saved originals, or None when there is no usable file (a corrupt
    one is set aside first)."""
    try:
        data = json.loads(lock_file().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except ValueError:
        _set_aside_corrupt()
        return None
    except OSError as exc:
        log(f"desktop-lock.json is unreadable ({exc})")
        return None
    items = data.get("saved") if isinstance(data, dict) else None
    if not isinstance(items, list):
        _set_aside_corrupt()
        return None
    return [i for i in items if isinstance(i, dict) and isinstance(i.get("schema"), str)
            and isinstance(i.get("key"), str) and (i.get("value") is None or isinstance(i.get("value"), str))]


def write_saved(items: list[dict]) -> None:
    """Atomically, mode 600, synced to disk before it replaces the file."""
    d = state_dir()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / ".desktop-lock.json.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "saved": items}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, lock_file())


def lock_desktop() -> int:
    """Saves the current values once (a file that is already there keeps the
    true originals after a crash), then writes the locked ones. A value
    already locked is saved as None, which means "reset to the default" on
    restore, so a lost file can never make the locked values the originals.
    A file missing some LOCK_KEYS (a key that couldn't be read last time) gets
    those added, with their current values, before they are locked; the
    values already in it are never overwritten. Returns how many settings
    were locked (0 when the originals couldn't be saved: then nothing
    changes)."""
    saved = read_saved()
    had = saved or []
    have = {(i["schema"], i["key"]) for i in had}
    added = []
    for schema, key, locked in LOCK_KEYS:
        if (schema, key) in have:
            continue
        current = gsettings_get(schema, key)
        if current is None:
            continue
        added.append({"schema": schema, "key": key, "value": None if current == locked else current})
    if saved is None or added:
        try:
            write_saved(had + added)
            saved = had + added
        except OSError as exc:
            if saved is None:
                log(f"desktop lock skipped: can't save the current values ({exc})")
                return 0
            log(f"desktop lock: can't save {len(added)} more values ({exc}); locking the saved ones only")
    keep = {(i["schema"], i["key"]) for i in saved}
    n = sum(1 for schema, key, locked in LOCK_KEYS
            if (schema, key) in keep and gsettings_set(schema, key, locked))
    log(f"desktop locked ({n} settings)")
    return n


def reset_locked_keys() -> bool:
    """No usable save file: every LOCK_KEYS key that holds its locked value is
    reset to the GNOME default; the others are left alone. True when nothing
    is left locked (False when a key couldn't be read or reset)."""
    ok = True
    n = 0
    for schema, key, locked in LOCK_KEYS:
        r = run_cmd(["gsettings", "get", schema, key])
        if r.returncode != 0:
            if not gsettings_gone(r):
                ok = False
            continue
        if r.stdout.strip() != locked:
            continue
        r = run_cmd(["gsettings", "reset", schema, key])
        if r.returncode == 0:
            n += 1
        elif not gsettings_gone(r):
            ok = False
    log(f"desktop restore without a save file: {n} locked settings reset"
        + ("" if ok else "; some couldn't be checked or reset"))
    return ok


def restore_desktop() -> bool:
    """Puts every saved value back (None: reset). The file goes when all are
    back, or when gsettings says a key's schema or key no longer exists. Any
    other failure (gsettings down, timed out, missing) keeps the item in the
    file for the next restore. With no usable file, the keys still holding
    their locked values are reset. True when nothing is left."""
    saved = read_saved()
    if saved is None:
        return reset_locked_keys()
    left = []
    for item in saved:
        schema, key, value = item["schema"], item["key"], item["value"]
        cmd = ["gsettings", "reset", schema, key] if value is None else ["gsettings", "set", schema, key, value]
        r = run_cmd(cmd)
        if r.returncode == 0:
            continue
        if gsettings_gone(r):
            log(f"desktop restore: {schema} {key} no longer exists; dropped")
            continue
        left.append(item)
    if left:
        try:
            write_saved(left)
        except OSError:
            pass
        log(f"desktop restore: {len(left)} settings left for next time")
        return False
    try:
        lock_file().unlink()
    except FileNotFoundError:
        pass
    log("desktop restored")
    return True


# ── Battery and network ───────────────────────────────────────────────
def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def battery(root: Path | None = None) -> dict | None:
    """The laptop's own battery: the first type=Battery supply with a numeric
    capacity, never a device's (a mouse's: scope=Device). Charging means the
    battery says so, or a charger (Mains, or USB-C) is online and it isn't
    discharging ("Not charging" on a full battery counts as plugged in)."""
    root = root or POWER_SUPPLY
    try:
        supplies = sorted(root.iterdir())
    except OSError:
        return None
    # The charger: a Mains supply, or a USB one (USB-C power delivery) that is online.
    mains = any(_read(s / "type") in ("Mains", "USB") and _read(s / "online") == "1" for s in supplies)
    for s in supplies:
        if _read(s / "type") != "Battery" or _read(s / "scope") == "Device" or _read(s / "present") == "0":
            continue
        cap = _read(s / "capacity")
        if not cap.isdigit():
            continue
        status = _read(s / "status")
        return {"percent": max(0, min(100, int(cap))),
                "charging": status == "Charging" or (mains and status != "Discharging")}
    return None


def nmcli_fields(line: str) -> list[str]:
    """One line of `nmcli -t` output, split on unescaped colons (`\\:` and
    `\\\\` are a literal colon and backslash)."""
    out: list[str] = []
    cur: list[str] = []
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur.append(line[i + 1])
            i += 2
            continue
        if c == ":":
            out.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    out.append("".join(cur))
    return out


def wifi_networks(rescan: bool = True) -> list[dict]:
    """Visible Wi-Fi networks, one per name (the in-use access point for the
    connected one, else the strongest), hidden ones dropped, the connected one
    first, then by signal."""
    r = run_cmd(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list",
                 "--rescan", "auto" if rescan else "no"], timeout=20)
    if r.returncode != 0:
        return []
    best: dict[str, dict] = {}
    for line in r.stdout.splitlines():
        f = nmcli_fields(line)
        if len(f) < 4 or not f[1]:
            continue
        net = {"ssid": f[1], "signal": max(0, min(100, int(f[2]) if f[2].isdigit() else 0)),
               "secure": f[3].strip() not in ("", "--"), "active": f[0].strip() == "*"}
        old = best.get(net["ssid"])
        if old is None:
            best[net["ssid"]] = net
            continue
        if net["active"]:
            best[net["ssid"]] = net
        elif not old["active"] and net["signal"] > old["signal"]:
            old["signal"], old["secure"] = net["signal"], net["secure"]
    return sorted(best.values(), key=lambda n: (not n["active"], -n["signal"], n["ssid"].lower()))


def wired_status() -> dict | None:
    """The first wired adapter NetworkManager manages (Docker's veths are
    unmanaged), connected ones first; None when there is none."""
    r = run_cmd(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"])
    if r.returncode != 0:
        return None
    found = None
    for line in r.stdout.splitlines():
        f = nmcli_fields(line)
        if len(f) < 3 or f[1] != "ethernet" or f[2] == "unmanaged":
            continue
        item = {"connected": f[2].startswith("connected"), "device": f[0]}
        if item["connected"]:
            return item
        found = found or item
    return found


def system_info() -> dict:
    nets = wifi_networks(rescan=False)
    active = next((n for n in nets if n["active"]), None)
    wired = wired_status()
    network = "wifi" if active else "wired" if wired and wired["connected"] else "none"
    return {"battery": battery(),
            "wifi": {"ssid": active["ssid"], "signal": active["signal"]} if active else None,
            "wired": wired, "network": network}


def _no_controls(v: str) -> bool:
    return not any(ord(c) < 32 or ord(c) == 127 for c in v)


def valid_ssid(v) -> bool:
    return isinstance(v, str) and 1 <= len(v.encode("utf-8")) <= 32 and _no_controls(v)


def valid_password(v) -> bool:
    return isinstance(v, str) and len(v) <= MAX_PASSWORD and _no_controls(v)


def join_wifi(ssid: str, password: str) -> str:
    """Joins SSID with NetworkManager: "ok", or "wrong_password",
    "password_required", "not_found", "failed". The password reaches nmcli on
    stdin only (--ask), never on its command line, and is never logged. An
    empty password uses a saved profile."""
    cmd = ["nmcli", "--wait", str(JOIN_WAIT_S)] + (["--ask"] if password else []) + ["device", "wifi", "connect", ssid]
    r = run_cmd(cmd, stdin=(password + "\n") if password else None, timeout=JOIN_TIMEOUT_S)
    if r.returncode == 0:
        return "ok"
    err = f"{r.stderr}\n{r.stdout}"
    if "No network with SSID" in err:
        return "not_found"
    if "Secrets were required" in err or "802-1X supplicant" in err or "(7) Secrets" in err:
        return "wrong_password" if password else "password_required"
    return "failed"


# ── Start Kiosk icon ──────────────────────────────────────────────────
def _exec_path(p: str) -> str:
    """As install.sh's exec_path: % doubled, quoted when it has spaces."""
    p = p.replace("%", "%%")
    return f'"{p}"' if any(c.isspace() for c in p) else p


def start_icon_text(launch: Path) -> str:
    """The desktop icon. install.sh's render_start_icon writes the same text
    (tests/test_install_sh.py checks they match)."""
    return ("[Desktop Entry]\nType=Application\nName=Start Kiosk\nComment=Open the ServerSherpa kiosk\n"
            f"Exec={_exec_path(str(launch))}\nIcon=web-browser\nTerminal=false\n")


def desktop_dir() -> Path:
    r = run_cmd(["xdg-user-dir", "DESKTOP"])
    p = r.stdout.strip() if r.returncode == 0 else ""
    return Path(p) if p and p != str(Path.home()) else Path.home() / "Desktop"


def ensure_start_icon() -> None:
    """Start Kiosk on the desktop: written when missing or different,
    executable, and trusted (the desktop launches it on a double-click)."""
    try:
        d = desktop_dir()
        d.mkdir(parents=True, exist_ok=True)
        f = d / START_ICON
        text = start_icon_text(KIOSK_DIR / "launch.sh")
        if not f.exists() or f.read_text(encoding="utf-8") != text:
            f.write_text(text, encoding="utf-8")
        f.chmod(0o755)
        run_cmd(["gio", "set", str(f), "metadata::trusted", "true"])
    except OSError as exc:
        log(f"Start Kiosk icon: {exc}")


def cleanup_restore_entry() -> None:
    """After an uninstall's one-shot restore: its autostart entry goes, and
    this file too when it is the copy in the state folder. An error is logged,
    never raised (the shortcuts are already back)."""
    try:
        (Path.home() / ".config" / "autostart" / RESTORE_AUTOSTART).unlink(missing_ok=True)
        me = Path(__file__).resolve()
        if me.parent == state_dir().resolve():
            me.unlink(missing_ok=True)
    except OSError as exc:
        log(f"restore cleanup: {exc}")


# ── Cloud and edge checks ─────────────────────────────────────────────
def url_answers(url: str, timeout: float = PROBE_TIMEOUT_S) -> bool:
    """True when URL answers 2xx (a 4xx/5xx, a timeout or no network is False)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ServerSherpaKiosk"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


def fetch_text(url: str, timeout: float = PROBE_TIMEOUT_S) -> str | None:
    """URL's body (at most CONFIG_MAX_BYTES) when it answers 2xx, else None."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ServerSherpaKiosk"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if not 200 <= r.status < 300:
                return None
            return r.read(CONFIG_MAX_BYTES).decode("utf-8", "replace")
    except Exception:
        return None


_HOST_OS_KEY = re.compile(r"""["']?hostOs["']?\s*:""")
_HOST_OS_LINUX = re.compile(r"""["']?hostOs["']?\s*:\s*["']linux["']""")


def lockdown_support(config_js: str) -> bool | None:
    """From the edge's /config.js: True when the kiosk app has the Esc → PIN
    exit and will show it ("hostOs": "linux"); False when it is an older app
    with no hostOs key at all (no way out of a locked desktop); None when the
    key is there but not "linux" yet (hostnet.sh hasn't written host_os: the
    page would hide the PIN pad, so not confirmed, but not refused either)."""
    if not _HOST_OS_KEY.search(config_js):
        return False
    return True if _HOST_OS_LINUX.search(config_js) else None


class ChromeKeepsClosing(Exception):
    """Chrome closed FAST_EXIT_LIMIT times in a row within FAST_EXIT_S of its launch."""


class Session:
    """What the helper, the check loop and the watcher share."""

    def __init__(self, token: str, api_url: str):
        self.token = token
        self.api_url = api_url.rstrip("/")
        self.exit = threading.Event()
        self.cloud_ok = False          # the cloud answered once this session
        self.edge_ok = False           # the edge answered at the last check
        self.last_attempt_ms: int | None = None
        self.chrome: subprocess.Popen | None = None
        self.waiting_url = ""
        self._cloud_failing = False
        self._sys_cond = threading.Condition()
        self._system: tuple[float, dict] | None = None
        self._sys_refreshing = False
        self._sys_gen = 0              # bumped by forget_system: a refresh under way is dropped
        self._edge_lock = threading.Lock()
        self._edge_at: float | None = None   # monotonic time of the last edge answer
        # The kiosk app supports the lockdown (lockdown_support): kept per edge
        # start (forgotten when an edge probe fails, since an update can swap
        # the image) and re-read by the 15 s check.
        self.lockdown: bool | None = None
        self.no_lockdown = False       # the edge's app has no lockdown: the session ends, rc 3

    @property
    def ready(self) -> bool:
        return self.cloud_ok and self.edge_ok and self.lockdown is True

    def _edge_answered(self, ok: bool, *, recheck: bool) -> None:
        """After an edge probe (under _edge_lock). Down: the capability is
        forgotten. Up: /config.js is read when the capability isn't known yet
        (or recheck). An app without the marker ends the session: the
        watcher stops, Chrome closes, the desktop comes back, rc 3."""
        self.edge_ok = ok
        self._edge_at = time.monotonic()
        if not ok:
            self.lockdown = None
            return
        if self.lockdown is True and not recheck:
            return
        text = fetch_text(EDGE_CONFIG_URL, timeout=EDGE_LIVE_TIMEOUT_S)
        if text is None:
            return                     # no answer this time: as it was
        support = lockdown_support(text)
        if support is False:
            if not self.no_lockdown:
                log("the kiosk app on this laptop has no Esc → PIN exit (its /config.js has no hostOs); "
                    "ending the kiosk session so the kiosk opens in a plain window")
            self.lockdown = False
            self.no_lockdown = True
            self.exit.set()
            return
        if support and self.lockdown is not True:
            log("the kiosk app supports the lockdown")
        self.lockdown = support

    def ready_now(self) -> bool:
        """ready, with the edge checked live (EDGE_LIVE_TIMEOUT_S) once the
        cloud has answered, so the waiting page never forwards to a dead
        localhost:8090 on a check up to 15 s old. A result is kept for
        EDGE_CACHE_S, so the page's 2 s poll doesn't hammer the edge; callers
        arriving during a probe wait for that one. Not under the system lock."""
        if not self.cloud_ok:
            return False
        with self._edge_lock:
            if self._edge_at is None or time.monotonic() - self._edge_at >= EDGE_CACHE_S:
                self._edge_answered(url_answers(EDGE_IDENTITY_URL, timeout=EDGE_LIVE_TIMEOUT_S), recheck=False)
            return self.ready

    def system(self) -> dict:
        """system_info, cached SYSTEM_CACHE_S. The nmcli calls run outside the
        lock: while one refresh runs, others get the last value (only the very
        first callers, with nothing cached, wait for it)."""
        with self._sys_cond:
            while True:
                if self._system and time.monotonic() - self._system[0] < SYSTEM_CACHE_S:
                    return self._system[1]
                if not self._sys_refreshing:
                    break
                if self._system:
                    return self._system[1]
                self._sys_cond.wait()
            self._sys_refreshing = True
            gen = self._sys_gen
        info = None
        try:
            info = system_info()
            return info
        finally:
            with self._sys_cond:
                self._sys_refreshing = False
                if info is not None and gen == self._sys_gen:
                    self._system = (time.monotonic(), info)
                self._sys_cond.notify_all()

    def forget_system(self) -> None:
        with self._sys_cond:
            self._system = None
            self._sys_gen += 1

    def check_once(self) -> None:
        """The cloud until it has answered once (decided: every 15 s, never
        giving up), then the edge, every time."""
        if not self.cloud_ok:
            self.last_attempt_ms = int(time.time() * 1000)
            self.cloud_ok = url_answers(f"{self.api_url}/system/status")
            if self.cloud_ok:
                log("the cloud answered")
            elif not self._cloud_failing:
                log(f"the cloud doesn't answer yet ({self.api_url}); trying every {CLOUD_CHECK_S} s")
            self._cloud_failing = not self.cloud_ok
        with self._edge_lock:
            self._edge_answered(url_answers(EDGE_IDENTITY_URL), recheck=True)

    def check_loop(self) -> None:
        while not self.exit.is_set():
            self.check_once()
            self.exit.wait(CLOUD_CHECK_S)


# ── Helper HTTP server ────────────────────────────────────────────────
def _proc_addr(hex_addr: str):
    """An address as /proc/net/tcp{,6} prints it: 32-bit words in native byte
    order, each as %08X. IPv4-mapped IPv6 comes back as IPv4."""
    raw = b"".join(int(hex_addr[i:i + 8], 16).to_bytes(4, sys.byteorder) for i in range(0, len(hex_addr), 8))
    ip = ipaddress.ip_address(raw)
    return ip.ipv4_mapped or ip if ip.version == 6 else ip


def _norm_ip(text: str):
    ip = ipaddress.ip_address(text.split("%", 1)[0])
    return ip.ipv4_mapped or ip if ip.version == 6 else ip


def peer_uid(client_addr, server_port: int, proc_root: str = "/proc") -> int | None:
    """The UID that owns the client end of a connection to this helper: the
    /proc/net/tcp or tcp6 row whose local end is the client's (address, port)
    and whose remote port is the server's. None when it can't be found (no
    /proc, a row gone, a parse error): the caller refuses then."""
    try:
        want_ip, want_port = _norm_ip(client_addr[0]), int(client_addr[1])
    except (ValueError, TypeError, IndexError):
        return None
    for name in ("tcp", "tcp6"):
        try:
            lines = Path(proc_root, "net", name).read_text(encoding="ascii", errors="replace").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            f = line.split()
            if len(f) < 8:
                continue
            try:
                l_ip, l_port = f[1].rsplit(":", 1)
                _, r_port = f[2].rsplit(":", 1)
                if (int(l_port, 16) == want_port and int(r_port, 16) == server_port
                        and _proc_addr(l_ip) == want_ip):
                    return int(f[7])
            except ValueError:
                continue
    return None


CSP = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


class Handler(BaseHTTPRequestHandler):
    server_version = "ServerSherpaKiosk"
    sys_version = ""

    def log_message(self, format, *args):  # noqa: A002 (the base class's name)
        """Request lines never reach a log."""

    @property
    def session(self) -> Session:
        return self.server.session

    def _send(self, status: int, body: bytes, ctype: str, extra=()) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.headers.get("Origin") == KIOSK_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", KIOSK_ORIGIN)
            self.send_header("Vary", "Origin")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj).encode(), "application/json")

    def _path(self) -> str:
        return self.path.split("?", 1)[0]

    def _peer_ok(self) -> bool:
        """Only the session user's own processes (Chrome) get an answer, so
        another Linux account on this laptop can't read the token from
        /waiting. Fails closed: an unknown peer is refused too."""
        uid = peer_uid(self.client_address, self.server.server_port)
        if uid == os.getuid():
            return True
        log("helper: refused a request from " + ("an unknown process" if uid is None else f"uid {uid}"))
        self._json(403, {"error": "forbidden"})
        return False

    def _gate(self) -> bool:
        """The peer's UID, Host (no DNS rebinding), Origin (only the kiosk and
        this page) and, for /v1/*, the session token."""
        if not self._peer_ok():
            return False
        if self.headers.get("Host") != self.server.host_header:
            self._send(400, b"Invalid host header", "text/plain; charset=utf-8")
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in (KIOSK_ORIGIN, self.server.origin):
            self._json(403, {"error": "forbidden"})
            return False
        if self._path().startswith("/v1/"):
            given = self.headers.get("X-Kiosk-Token", "").encode("utf-8", "replace")
            if not hmac.compare_digest(given, self.session.token.encode()):
                self._json(403, {"error": "forbidden"})
                return False
        return True

    def _body(self) -> dict | None:
        if self.headers.get_content_type() != "application/json":
            return None
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if not 0 < n <= MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def do_OPTIONS(self):  # noqa: N802
        if not self._peer_ok():
            return
        if (self.headers.get("Host") != self.server.host_header
                or self.headers.get("Origin") != KIOSK_ORIGIN or not self._path().startswith("/v1/")):
            self._send(403, b"", "text/plain; charset=utf-8")
            return
        self._send(204, b"", "text/plain; charset=utf-8", (
            ("Access-Control-Allow-Methods", "GET, POST"),
            ("Access-Control-Allow-Headers", "Content-Type, X-Kiosk-Token"),
            ("Access-Control-Allow-Private-Network", "true"),
            ("Access-Control-Max-Age", "600"),
        ))

    def do_GET(self):  # noqa: N802
        if not self._gate():
            return
        path = self._path()
        s = self.session
        if path == "/waiting":
            self._send(200, waiting_page(s.token).encode(), "text/html; charset=utf-8",
                       (("Content-Security-Policy", CSP), ("X-Frame-Options", "DENY")))
        elif path == "/v1/state":
            self._json(200, {"ready": s.ready_now(), "cloud": s.cloud_ok, "last_attempt": s.last_attempt_ms,
                             "system": s.system()})
        elif path == "/v1/system":
            self._json(200, s.system())
        elif path == "/v1/wifi":
            self._json(200, {"networks": wifi_networks(rescan=True), "wired": wired_status()})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if not self._gate():
            return
        path = self._path()
        body = self._body()
        if body is None:
            self._json(400, {"error": "bad_request"})
            return
        if path == "/v1/exit":
            pin = body.get("pin")
            if not isinstance(pin, str) or not hmac.compare_digest(pin.encode(), EXIT_PIN.encode()):
                log("exit: wrong PIN")
                self._json(403, {"error": "wrong_pin"})
                return
            self._json(200, {"ok": True})
            log("exit: PIN accepted")
            self.session.exit.set()
        elif path == "/v1/wifi/join":
            ssid, password = body.get("ssid"), body.get("password", "")
            if not valid_ssid(ssid) or not valid_password(password):
                self._json(400, {"error": "bad_request"})
                return
            code = join_wifi(ssid, password)
            log(f"join Wi-Fi {ssid!r}: {code}")
            self.session.forget_system()
            if code == "ok":
                self._json(200, {"ok": True})
            else:
                self._json(422, {"error": code})
        else:
            self._json(404, {"error": "not_found"})


class HelperServer(ThreadingHTTPServer):
    """127.0.0.1 only. The bind is also the single-instance lock: a second
    session finds the port taken."""
    daemon_threads = True

    def __init__(self, session: Session, port: int | None = None):
        super().__init__((HELPER_HOST, HELPER_PORT if port is None else port), Handler)
        self.session = session
        self.host_header = f"{HELPER_HOST}:{self.server_port}"
        self.origin = f"http://{self.host_header}"


# ── Waiting page ──────────────────────────────────────────────────────
# Served by the helper, not the container (which may be down while the cloud
# is too) and not a file:// page (origin null). House tokens, light/dark from
# the system, no scrollbars. Esc opens the same PIN pad as the kiosk.
WAITING_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connecting to ServerSherpa</title>
<style>
:root { color-scheme: light dark;
  --ink: #0c1117; --paper: #fbfcfd; --paper-2: #f1f4f7; --paper-line: #e4e8ee;
  --text-dark: #1b2129; --text-mute: #667085; --surface: #fff; --accent: #ffa12e; --c-red: #c03540;
  --font-display: 'Geologica', system-ui, sans-serif; --font-mono: 'Fragment Mono', ui-monospace, monospace; }
@media (prefers-color-scheme: dark) { :root {
  --paper: #10151f; --paper-2: #0b0f17; --paper-line: rgba(255, 255, 255, 0.09);
  --text-dark: #e8edf4; --text-mute: #8a97aa; --surface: #161d2a; --c-red: #ff5d6c; } }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--paper-2);
  color: var(--text-dark); font-family: var(--font-display); }
main { height: 100%; display: grid; place-items: center; text-align: center; }
.mark { font-weight: 600; font-size: 22px; letter-spacing: .01em; }
.mark em { font-style: normal; color: var(--accent); }
h1 { font-size: 28px; font-weight: 600; margin: 18px 0 12px; }
.facts { font-family: var(--font-mono); font-size: 14px; color: var(--text-mute); line-height: 1.9; }
.scrim { position: fixed; inset: 0; display: none; place-items: center; padding: 24px;
  background: rgba(5, 8, 12, 0.55); backdrop-filter: blur(4px); }
.scrim.open { display: grid; }
.card { width: min(420px, 96vw); background: var(--surface); color: var(--text-dark);
  border: 1px solid var(--paper-line); border-radius: 16px; overflow: hidden; text-align: left;
  box-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.6); }
.head { padding: 18px 20px 12px; border-bottom: 1px solid var(--paper-line); }
.eyebrow, label { font-family: var(--font-mono); font-size: 11px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--text-mute); }
.head h3 { margin: 4px 0; font-size: 18px; }
.hint { margin: 0; font-size: 13px; color: var(--text-mute); }
.body { padding: 16px 20px; }
label { display: block; margin-bottom: 6px; }
input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--paper-line);
  border-radius: 10px; background: var(--paper); color: var(--text-dark); font: inherit; }
.err { color: var(--c-red); font-size: 13px; margin: 8px 0 0; min-height: 1em; }
.foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px;
  border-top: 1px solid var(--paper-line); }
button { font: inherit; font-size: 13px; border-radius: 999px; padding: 8px 16px; cursor: pointer; }
.ghost { background: transparent; color: var(--text-dark); border: 1px solid var(--paper-line); }
.solid { background: var(--accent); color: var(--ink); border: 1px solid var(--accent); font-weight: 600; }
</style>
</head>
<body>
<main>
  <div>
    <div class="mark">Server<em>Sherpa</em></div>
    <h1>Connecting to ServerSherpa…</h1>
    <div class="facts">
      <div>Last attempt <span id="last">—</span></div>
      <div>Network: <span id="net">…</span></div>
    </div>
  </div>
</main>
<div class="scrim" id="pin-scrim">
  <form class="card" id="pin-form" role="dialog" aria-modal="true" aria-label="Exit the kiosk">
    <div class="head">
      <div class="eyebrow">This laptop</div>
      <h3>Exit the kiosk</h3>
      <p class="hint">Enter the PIN to close the kiosk and go to the desktop. Start Kiosk on the desktop opens it again.</p>
    </div>
    <div class="body">
      <label for="pin">PIN</label>
      <input id="pin" type="password" autocomplete="new-password" spellcheck="false" maxlength="32">
      <p class="err" id="pin-err" role="alert"></p>
      <p class="hint" id="pin-msg" role="status"></p>
    </div>
    <div class="foot">
      <button type="button" class="ghost" id="pin-cancel">Cancel</button>
      <button type="submit" class="solid" id="pin-ok">Exit kiosk</button>
    </div>
  </form>
</div>
<script>
const TOKEN = __TOKEN__;
const KIOSK = __KIOSK_URL__;
const POLL_MS = __POLL_MS__;
const $ = (id) => document.getElementById(id);
const two = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
function networkText(s) {
  if (s && s.network === 'wifi' && s.wifi) return 'Wi-Fi: ' + s.wifi.ssid;
  if (s && s.network === 'wired') return 'Wired network';
  return 'No network';
}
const pinOpen = () => $('pin-scrim').classList.contains('open');
async function poll() {
  try {
    const r = await fetch('/v1/state', { headers: { 'X-Kiosk-Token': TOKEN }, cache: 'no-store' });
    if (r.ok) {
      const st = await r.json();
      $('last').textContent = st.last_attempt ? hhmm(st.last_attempt) : '—';
      $('net').textContent = networkText(st.system);
      if (st.ready && !pinOpen()) { location.replace(KIOSK + '/#kh=' + TOKEN); return; }
    }
  } catch (e) { /* this page's own server; try again */ }
  setTimeout(poll, POLL_MS);
}
function openPin() { $('pin-scrim').classList.add('open'); $('pin').value = ''; $('pin-err').textContent = ''; $('pin').focus(); }
function closePin() { $('pin-scrim').classList.remove('open'); }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.repeat) return;
  if (pinOpen()) closePin(); else openPin();
});
$('pin-cancel').addEventListener('click', closePin);
$('pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('pin').value;
  if (!pin) return;
  $('pin-ok').disabled = true;
  try {
    const r = await fetch('/v1/exit', { method: 'POST', body: JSON.stringify({ pin }),
      headers: { 'Content-Type': 'application/json', 'X-Kiosk-Token': TOKEN } });
    if (r.ok) { $('pin-err').textContent = ''; $('pin-msg').textContent = 'Closing the kiosk…'; return; }
    $('pin-err').textContent = r.status === 403 ? "That PIN isn't right." : "Couldn't exit. Try again.";
  } catch (e2) { $('pin-err').textContent = "Couldn't exit. Try again."; }
  $('pin').value = '';
  $('pin-ok').disabled = false;
});
poll();
</script>
</body>
</html>
"""


def waiting_page(token: str) -> str:
    return (WAITING_HTML.replace("__TOKEN__", json.dumps(token))
            .replace("__KIOSK_URL__", json.dumps(KIOSK_URL))
            .replace("__POLL_MS__", str(WAIT_POLL_MS)))


# ── Chrome and the watcher ────────────────────────────────────────────
CHROME_FLAGS = ("--kiosk", "--no-first-run", "--no-default-browser-check", "--noerrdialogs",
                "--password-store=basic", "--hide-crash-restore-bubble")


def profile_dir(browser: str) -> Path:
    """The kiosk's own Chrome profile. Without its own, a Chrome already open
    on the desktop would take the launch and exit at once. Snap Chromium
    can't reach hidden folders, so it gets its snap's own folder."""
    real = os.path.realpath(browser)
    snap = (browser.startswith("/snap/") or real.startswith("/snap/") or real.endswith("/usr/bin/snap")
            or (Path(browser).name == "chromium-browser" and Path("/snap/bin/chromium").exists()))
    if snap:
        return Path.home() / "snap" / "chromium" / "common" / "serversherpa-kiosk"
    return Path.home() / ".local" / "share" / "serversherpa-kiosk" / "chrome"


def kiosk_chrome_pids(profile: Path, proc_root: str = "/proc") -> list[int]:
    """Live processes started on the kiosk profile (--user-data-dir=PROFILE,
    or --user-data-dir PROFILE), never this one. A Chrome on any other profile
    is never listed. No owner check: a sandboxed Chrome process can show as
    root in /proc, and another account's process can't be signalled anyway."""
    want = str(profile)
    me = os.getpid()
    found = []
    try:
        entries = sorted((e for e in os.listdir(proc_root) if e.isdigit()), key=int)
    except OSError:
        return []
    for e in entries:
        pid = int(e)
        if pid == me:
            continue
        try:
            with open(os.path.join(proc_root, e, "cmdline"), "rb") as f:
                args = f.read().decode("utf-8", "replace").split("\0")
        except OSError:
            continue
        if f"--user-data-dir={want}" in args or any(
                a == "--user-data-dir" and b == want for a, b in zip(args, args[1:])):
            found.append(pid)
    return found


def stop_kiosk_chrome(profile: Path, proc_root: str = "/proc", kill=os.kill) -> None:
    """A Chrome left over on the kiosk profile (the session was SIGKILLed:
    Chrome runs in its own session, so it lives on) would take the next launch
    and exit it at once, and the watcher would loop. Each one gets SIGTERM,
    then SIGKILL if still there after CHROME_STOP_S. A PID is signalled only
    while /proc still shows it on the kiosk profile."""
    pids = kiosk_chrome_pids(profile, proc_root)
    if not pids:
        return
    log(f"a kiosk Chrome was left over ({len(pids)} processes); closing it")
    for pid in pids:
        try:
            kill(pid, signal.SIGTERM)
        except OSError:
            pass
    end = time.monotonic() + CHROME_STOP_S
    while time.monotonic() < end:
        if not set(pids) & set(kiosk_chrome_pids(profile, proc_root)):
            return
        time.sleep(0.05)
    for pid in set(pids) & set(kiosk_chrome_pids(profile, proc_root)):
        try:
            kill(pid, signal.SIGKILL)
        except OSError:
            pass


def launch_chrome(browser: str, url: str) -> subprocess.Popen:
    """Chrome starts with the user's own environment (no env=, and not through
    run_cmd/tool_env), so its UI keeps the laptop's language. A Chrome left
    over on the kiosk profile is closed first."""
    profile = profile_dir(browser)
    profile.mkdir(parents=True, exist_ok=True)
    stop_kiosk_chrome(profile)
    return subprocess.Popen([browser, *CHROME_FLAGS, f"--user-data-dir={profile}", url],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)


def close_chrome(proc: subprocess.Popen | None) -> None:
    """SIGTERM to Chrome's process group, SIGKILL after CHROME_STOP_S."""
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=CHROME_STOP_S)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=CHROME_STOP_S)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass


def watch(session: Session, browser: str, launch=launch_chrome) -> None:
    """Chrome on the waiting page (which goes on to the kiosk once ready),
    reopened whenever it closes, until the session is told to exit. Then the
    watcher stops and Chrome is closed. Chrome closing within FAST_EXIT_S of
    its launch FAST_EXIT_LIMIT times in a row (a broken profile, a crash loop)
    raises ChromeKeepsClosing: run ends the session with rc 1 and launch.sh
    falls back to the plain window."""
    fast = 0
    while not session.exit.is_set():
        try:
            proc = launch(browser, session.waiting_url)
        except OSError as exc:
            # Missing or not executable: it won't fix itself, and a locked
            # desktop with no Chrome has no way out. The session ends (run
            # puts the desktop back); Start Kiosk tries again.
            log(f"can't start the browser {browser} ({exc.strerror or exc}); ending the kiosk session")
            raise
        session.chrome = proc
        started = time.monotonic()
        while proc.poll() is None:
            if session.exit.wait(WATCH_S):
                break
        if session.exit.is_set():
            break
        fast = fast + 1 if time.monotonic() - started < FAST_EXIT_S else 0
        if fast >= FAST_EXIT_LIMIT:
            log(f"Chrome closed {fast} times within {FAST_EXIT_S:g} s of opening; ending the kiosk session")
            raise ChromeKeepsClosing()
        log(f"Chrome closed (exit {proc.returncode}); opening it again")
        session.exit.wait(RELAUNCH_DELAY_S)
    close_chrome(session.chrome)


def run(browser: str) -> int:
    """The session. Exit order (decided): the watcher stops, Chrome closes,
    then the desktop shortcuts come back. A signal (sign-out, power-off,
    uninstall) takes the same way out."""
    session = Session(secrets.token_urlsafe(32), config_value("EDGE_CLOUD_API_URL") or DEFAULT_API_URL)
    try:
        server = HelperServer(session)
    except OSError:
        log("another kiosk session is running; nothing to do")
        return 0
    session.waiting_url = f"{server.origin}/waiting"

    def stop(signum, frame):
        session.exit.set()
    for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(s, stop)
    threading.Thread(target=server.serve_forever, name="helper", daemon=True).start()
    log(f"kiosk session started (browser {browser})")
    rc = 0
    try:
        ensure_start_icon()
        lock_desktop()
        threading.Thread(target=session.check_loop, name="cloud-check", daemon=True).start()
        watch(session, browser)
    except (OSError, ChromeKeepsClosing):
        rc = 1            # the browser couldn't start or keeps closing (watch logged it)
    finally:
        session.exit.set()
        close_chrome(session.chrome)
        restore_desktop()
        server.shutdown()
        server.server_close()
        log("kiosk session ended")
    return RC_NO_LOCKDOWN if session.no_lockdown else rc


# ── Command line ──────────────────────────────────────────────────────
def main(argv: list[str]) -> int:
    if argv[:1] == ["run"] and len(argv) == 3 and argv[1] == "--browser" and argv[2]:
        return run(argv[2])
    if argv[:1] == ["restore"] and argv[1:] in ([], ["--cleanup"]):
        ok = restore_desktop()
        if ok and argv[1:] == ["--cleanup"]:
            cleanup_restore_entry()
        return 0 if ok else 1
    if argv[:1] == ["stop-chrome"] and (len(argv) == 1 or (len(argv) == 3 and argv[1] == "--browser" and argv[2])):
        profiles = ([profile_dir(argv[2])] if len(argv) == 3
                    else [profile_dir("google-chrome"), profile_dir("/snap/bin/chromium")])
        for p in dict.fromkeys(profiles):
            stop_kiosk_chrome(p)
        return 0
    print(__doc__, file=sys.stderr)
    return 2


# Called on the last line so a partially written file runs nothing.
if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
