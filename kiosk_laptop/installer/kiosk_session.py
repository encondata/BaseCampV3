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
"""
from __future__ import annotations

import hmac
import json
import os
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
CHROME_STOP_S = 5.0         # assumption: SIGTERM grace before SIGKILL
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


def run_cmd(cmd: list[str], *, stdin: str | None = None, timeout: float = 10) -> subprocess.CompletedProcess:
    """Runs a tool. A missing tool is exit 127 and a timeout is 124, never an
    exception. stdin, when given, is the tool's whole input."""
    try:
        return subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout, check=False)
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


def lock_file() -> Path:
    return state_dir() / "desktop-lock.json"


def read_saved() -> list[dict] | None:
    """The saved originals, or None when there is no (usable) file."""
    try:
        data = json.loads(lock_file().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        log("desktop-lock.json is unreadable; saving the current values again")
        return None
    items = data.get("saved") if isinstance(data, dict) else None
    if not isinstance(items, list):
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
    Returns how many settings were locked (0 when the originals couldn't be
    saved: then nothing changes)."""
    saved = read_saved()
    if saved is None:
        saved = []
        for schema, key, locked in LOCK_KEYS:
            current = gsettings_get(schema, key)
            if current is None:
                continue
            saved.append({"schema": schema, "key": key, "value": None if current == locked else current})
        try:
            write_saved(saved)
        except OSError as exc:
            log(f"desktop lock skipped: can't save the current values ({exc})")
            return 0
    keep = {(i["schema"], i["key"]) for i in saved}
    n = sum(1 for schema, key, locked in LOCK_KEYS
            if (schema, key) in keep and gsettings_set(schema, key, locked))
    log(f"desktop locked ({n} settings)")
    return n


def restore_desktop() -> bool:
    """Puts every saved value back (None: reset). The file goes when all are
    back, or when a key no longer exists. A key that is there and failed
    stays in the file for the next restore. True when nothing is left."""
    saved = read_saved()
    if saved is None:
        return True
    left = []
    for item in saved:
        schema, key, value = item["schema"], item["key"], item["value"]
        ok = gsettings_reset(schema, key) if value is None else gsettings_set(schema, key, value)
        if not ok and gsettings_get(schema, key) is not None:
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
    battery says so, or the mains are on and it isn't discharging."""
    root = root or POWER_SUPPLY
    try:
        supplies = sorted(root.iterdir())
    except OSError:
        return None
    mains = any(_read(s / "type") == "Mains" and _read(s / "online") == "1" for s in supplies)
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
    """Visible Wi-Fi networks, one per name (the strongest access point),
    hidden ones dropped, the connected one first, then by signal."""
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
        old["active"] = old["active"] or net["active"]
        if net["signal"] > old["signal"]:
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
    this file too when it is the copy in the state folder."""
    (Path.home() / ".config" / "autostart" / RESTORE_AUTOSTART).unlink(missing_ok=True)
    me = Path(__file__).resolve()
    if me.parent == state_dir().resolve():
        me.unlink(missing_ok=True)


# ── Command line ──────────────────────────────────────────────────────
def main(argv: list[str]) -> int:
    if argv[:1] == ["restore"] and argv[1:] in ([], ["--cleanup"]):
        ok = restore_desktop()
        if ok and argv[1:] == ["--cleanup"]:
            cleanup_restore_entry()
        return 0 if ok else 1
    print(__doc__, file=sys.stderr)
    return 2


# Called on the last line so a partially written file runs nothing.
if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
