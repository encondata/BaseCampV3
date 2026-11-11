"""kiosk_session.py (Linux kiosk lockdown): the GNOME lock, system info and
Wi-Fi join (Task 2); the helper server and the watcher (Task 3). Every tool
goes through run_cmd, which these tests replace."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SESSION_PY = Path(__file__).resolve().parents[1] / "kiosk_session.py"


def load(name="kiosk_session_under_test"):
    spec = importlib.util.spec_from_file_location(name, SESSION_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def ks(tmp_path, monkeypatch):
    (tmp_path / "home").mkdir()
    (tmp_path / "kiosk").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("KIOSK_DIR", str(tmp_path / "kiosk"))
    return load()


def done(cmd, rc=0, out="", err=""):
    return subprocess.CompletedProcess(cmd, rc, out, err)


class Tools:
    """run_cmd's stand-in: a gsettings store ((schema, key) -> printed value),
    an nmcli answer function, and every call with its stdin."""

    def __init__(self, values=None, nmcli=None):
        self.values = dict(values or {})
        self.fail = set()
        self.nmcli = nmcli or (lambda cmd, stdin: done(cmd, 1))
        self.calls = []

    def __call__(self, cmd, *, stdin=None, timeout=10):
        self.calls.append((list(cmd), stdin))
        if cmd[0] == "gsettings":
            verb, schema, key = cmd[1], cmd[2], cmd[3]
            if (schema, key) not in self.values:
                return done(cmd, 1, err="No such key")
            if verb == "get":
                return done(cmd, 0, self.values[(schema, key)] + "\n")
            if (schema, key) in self.fail:
                return done(cmd, 1, err="write failed")
            self.values[(schema, key)] = cmd[4] if verb == "set" else "DEFAULT"
            return done(cmd)
        if cmd[0] == "nmcli":
            return self.nmcli(cmd, stdin)
        return done(cmd, 127)


GNOME = {
    ("org.gnome.mutter", "overlay-key"): "'Super_L'",
    ("org.gnome.desktop.wm.keybindings", "switch-applications"): "['<Super>Tab', '<Alt>Tab']",
    ("org.gnome.desktop.interface", "enable-hot-corners"): "true",
    ("org.gnome.desktop.wm.preferences", "num-workspaces"): "4",
    ("org.gnome.mutter", "dynamic-workspaces"): "true",
    ("org.gnome.desktop.wm.keybindings", "switch-to-workspace-left"): "['<Super>Page_Up']",
}


# ── desktop lock ──────────────────────────────────────────────────────
def test_lock_keys_cover_the_four_groups(ks):
    keys = {(s, k): v for s, k, v in ks.LOCK_KEYS}
    assert keys[("org.gnome.mutter", "overlay-key")] == "''"
    assert keys[("org.gnome.shell.keybindings", "toggle-overview")] == "@as []"
    assert keys[("org.gnome.desktop.wm.keybindings", "switch-applications")] == "@as []"
    assert keys[("org.gnome.desktop.wm.keybindings", "switch-windows-backward")] == "@as []"
    assert keys[("org.gnome.desktop.interface", "enable-hot-corners")] == "false"
    assert keys[("org.gnome.desktop.wm.preferences", "num-workspaces")] == "1"
    assert keys[("org.gnome.desktop.wm.keybindings", "switch-to-workspace-12")] == "@as []"
    assert keys[("org.gnome.desktop.wm.keybindings", "move-to-workspace-last")] == "@as []"
    # Alt+F2 and Ctrl+Alt+T are real escapes, so they are locked too (spec §8)
    assert keys[("org.gnome.desktop.wm.keybindings", "panel-run-dialog")] == "@as []"
    assert keys[("org.gnome.settings-daemon.plugins.media-keys", "terminal")] == "@as []"


def test_lock_saves_first_then_locks_and_restore_puts_everything_back(ks, monkeypatch):
    tools = Tools(GNOME)
    order = []
    real_write = ks.write_saved
    monkeypatch.setattr(ks, "write_saved", lambda items: (order.append("saved"), real_write(items)))
    monkeypatch.setattr(ks, "run_cmd", lambda cmd, **kw: (order.append(cmd[1]), tools(cmd, **kw))[1])
    assert ks.lock_desktop() == len(GNOME)
    assert order.index("saved") < order.index("set")          # on disk before anything changes
    assert tools.values[("org.gnome.mutter", "overlay-key")] == "''"
    assert tools.values[("org.gnome.desktop.interface", "enable-hot-corners")] == "false"
    lock = ks.state_dir() / "desktop-lock.json"
    assert oct(lock.stat().st_mode & 0o777) == "0o600"
    assert ks.restore_desktop() is True
    assert tools.values == GNOME
    assert not lock.exists()


def test_relock_after_a_crash_keeps_the_originals(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    ks.lock_desktop()
    ks.lock_desktop()                                          # next sign-in, file still there
    assert ks.restore_desktop() is True
    assert tools.values == GNOME


def test_a_value_already_locked_is_reset_to_the_default(ks, monkeypatch):
    tools = Tools({**GNOME, ("org.gnome.mutter", "overlay-key"): "''"})   # a lost file left it locked
    monkeypatch.setattr(ks, "run_cmd", tools)
    ks.lock_desktop()
    saved = json.loads((ks.state_dir() / "desktop-lock.json").read_text())["saved"]
    assert {"schema": "org.gnome.mutter", "key": "overlay-key", "value": None} in saved
    ks.restore_desktop()
    assert tools.values[("org.gnome.mutter", "overlay-key")] == "DEFAULT"


def test_keys_missing_on_this_desktop_are_skipped(ks, monkeypatch):
    tools = Tools({("org.gnome.mutter", "overlay-key"): "'Super_L'"})
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.lock_desktop() == 1
    sets = [c for c, _ in tools.calls if c[1] == "set"]
    assert sets == [["gsettings", "set", "org.gnome.mutter", "overlay-key", "''"]]


def test_a_key_that_fails_to_restore_stays_for_next_time(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    ks.lock_desktop()
    tools.fail.add(("org.gnome.mutter", "overlay-key"))
    assert ks.restore_desktop() is False
    left = json.loads((ks.state_dir() / "desktop-lock.json").read_text())["saved"]
    assert left == [{"schema": "org.gnome.mutter", "key": "overlay-key", "value": "'Super_L'"}]
    tools.fail.clear()
    assert ks.restore_desktop() is True and tools.values == GNOME


def test_nothing_is_locked_when_the_originals_cant_be_saved(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    def refuse(items):
        raise OSError("read-only")
    monkeypatch.setattr(ks, "write_saved", refuse)
    assert ks.lock_desktop() == 0
    assert tools.values == GNOME


def test_restore_without_a_file_is_a_no_op(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.restore_desktop() is True and tools.calls == []


def test_restore_cleanup_cli_removes_the_one_shot_entry_and_its_copy(tmp_path):
    home, state = tmp_path / "home", tmp_path / "state"
    auto = home / ".config" / "autostart"; auto.mkdir(parents=True)
    (auto / "serversherpa-kiosk-restore.desktop").write_text("[Desktop Entry]\n")
    (state / "serversherpa-kiosk").mkdir(parents=True)
    copy = state / "serversherpa-kiosk" / "kiosk_session.py"
    copy.write_text(SESSION_PY.read_text())
    (state / "serversherpa-kiosk" / "desktop-lock.json").write_text(
        json.dumps({"version": 1, "saved": [{"schema": "org.gnome.mutter", "key": "overlay-key", "value": "'Super_L'"}]}))
    bindir = tmp_path / "bin"; bindir.mkdir()
    (bindir / "gsettings").write_text("#!/bin/sh\nexit 1\n"); (bindir / "gsettings").chmod(0o755)
    env = {**os.environ, "HOME": str(home), "XDG_STATE_HOME": str(state), "PATH": f"{bindir}:/usr/bin:/bin"}
    r = subprocess.run([sys.executable, str(copy), "restore", "--cleanup"], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert not (auto / "serversherpa-kiosk-restore.desktop").exists() and not copy.exists()


# ── battery and network ───────────────────────────────────────────────
def supply(root, name, **files):
    d = root / name; d.mkdir(parents=True)
    for k, v in files.items():
        (d / k).write_text(f"{v}\n")


def test_battery_from_sysfs(ks, tmp_path):
    root = tmp_path / "ps"
    supply(root, "AC", type="Mains", online="1")
    supply(root, "hidpp_battery_0", type="Battery", scope="Device", capacity="12", status="Discharging")
    supply(root, "BAT0", type="Battery", capacity="87", status="Not charging")
    assert ks.battery(root) == {"percent": 87, "charging": True}
    (root / "AC" / "online").write_text("0\n")
    (root / "BAT0" / "status").write_text("Discharging\n")
    assert ks.battery(root) == {"percent": 87, "charging": False}
    assert ks.battery(tmp_path / "missing") is None


def test_nmcli_fields_unescape(ks):
    assert ks.nmcli_fields(r"*:Cafe\: Guest:72:WPA2") == ["*", "Cafe: Guest", "72", "WPA2"]
    assert ks.nmcli_fields(r" :back\\slash:5:") == [" ", "back\\slash", "5", ""]


WIFI = "\n".join([
    " :CSG-Ops:40:WPA2", "*:CSG-Ops:72:WPA2", " ::80:WPA2", " :Guest:55:", " :Lobby:90:--",
]) + "\n"
DEVICES = "docker0:bridge:connected (externally)\nveth1a2:ethernet:unmanaged\nenp0s31f6:ethernet:connected\nwlp2s0:wifi:connected\n"


def nm(cmd, stdin):
    if cmd[:6] == ["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi"]:
        return done(cmd, 0, WIFI)
    if cmd[:6] == ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"]:
        return done(cmd, 0, DEVICES)
    return done(cmd, 1)


def test_wifi_networks_merge_bssids_drop_hidden_and_sort(ks, monkeypatch):
    tools = Tools(nmcli=nm)
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.wifi_networks() == [
        {"ssid": "CSG-Ops", "signal": 72, "secure": True, "active": True},
        {"ssid": "Lobby", "signal": 90, "secure": False, "active": False},
        {"ssid": "Guest", "signal": 55, "secure": False, "active": False},
    ]
    assert tools.calls[-1][0][-2:] == ["--rescan", "auto"]
    ks.wifi_networks(rescan=False)
    assert tools.calls[-1][0][-2:] == ["--rescan", "no"]


def test_wired_status_and_system_info(ks, monkeypatch, tmp_path):
    monkeypatch.setattr(ks, "run_cmd", Tools(nmcli=nm))
    monkeypatch.setattr(ks, "POWER_SUPPLY", tmp_path / "none")
    assert ks.wired_status() == {"connected": True, "device": "enp0s31f6"}
    assert ks.system_info() == {"battery": None, "wifi": {"ssid": "CSG-Ops", "signal": 72},
                                "wired": {"connected": True, "device": "enp0s31f6"}, "network": "wifi"}
    monkeypatch.setattr(ks, "run_cmd", Tools(nmcli=lambda c, s: done(c, 1)))
    assert ks.system_info()["network"] == "none"


# ── Wi-Fi join ────────────────────────────────────────────────────────
def test_join_sends_the_password_on_stdin_only(ks, monkeypatch):
    tools = Tools(nmcli=lambda cmd, stdin: done(cmd, 0, "Device 'wlp2s0' successfully activated"))
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.join_wifi("CSG-Ops", "s3cret pass") == "ok"
    cmd, stdin = tools.calls[-1]
    assert cmd == ["nmcli", "--wait", "45", "--ask", "device", "wifi", "connect", "CSG-Ops"]
    assert stdin == "s3cret pass\n" and "s3cret pass" not in " ".join(cmd)
    assert ks.join_wifi("Guest", "") == "ok"
    assert tools.calls[-1] == (["nmcli", "--wait", "45", "device", "wifi", "connect", "Guest"], None)
    log = ks.state_dir() / "session.log"
    assert not log.exists() or "s3cret" not in log.read_text()


@pytest.mark.parametrize("err,password,code", [
    ("Error: Connection activation failed: Secrets were required, but not provided.", "x", "wrong_password"),
    ("Error: Connection activation failed: Secrets were required, but not provided.", "", "password_required"),
    ("Error: No network with SSID 'Nope' found.", "x", "not_found"),
    ("Error: something else", "x", "failed"),
])
def test_join_error_codes(ks, monkeypatch, err, password, code):
    monkeypatch.setattr(ks, "run_cmd", Tools(nmcli=lambda cmd, stdin: done(cmd, 4, "", err)))
    assert ks.join_wifi("Nope", password) == code


def test_join_input_checks(ks):
    assert ks.valid_ssid("CSG-Ops") and ks.valid_ssid("x" * 32)
    for bad in ("", "x" * 33, "a\nb", "a\x00", 5, None):
        assert not ks.valid_ssid(bad)
    assert ks.valid_password("") and ks.valid_password("p" * 128)
    for bad in ("p" * 129, "a\nb", "a\rb", None, 3):
        assert not ks.valid_password(bad)


# ── Start Kiosk icon ──────────────────────────────────────────────────
def test_start_icon_text(ks):
    t = ks.start_icon_text(Path("/opt/serversherpa-kiosk/launch.sh"))
    assert t.splitlines() == ["[Desktop Entry]", "Type=Application", "Name=Start Kiosk",
                              "Comment=Open the ServerSherpa kiosk", "Exec=/opt/serversherpa-kiosk/launch.sh",
                              "Icon=web-browser", "Terminal=false"]
    assert 'Exec="/opt/Server Sherpa/50%%/launch.sh"' in ks.start_icon_text(Path("/opt/Server Sherpa/50%/launch.sh"))


def test_ensure_start_icon_writes_marks_executable_and_trusted(ks, monkeypatch, tmp_path):
    tools = Tools()
    monkeypatch.setattr(ks, "run_cmd", tools)                  # xdg-user-dir missing: ~/Desktop
    ks.ensure_start_icon()
    f = tmp_path / "home" / "Desktop" / "serversherpa-start-kiosk.desktop"
    assert f.read_text() == ks.start_icon_text(ks.KIOSK_DIR / "launch.sh")
    assert f.stat().st_mode & 0o777 == 0o755
    assert (["gio", "set", str(f), "metadata::trusted", "true"], None) in tools.calls
