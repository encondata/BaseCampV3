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
    mod = load()
    # Never the real edge: by default its /config.js says the lockdown is there.
    mod.fetch_text = lambda url, timeout=5: CAPABLE_JS
    return mod


CAPABLE_JS = ('window.__KIOSK_CONFIG__ = { apiUrl: window.location.origin, portalUrl: "https://p.test", '
              '"mode": "laptop", "lanAccess": false, "hostOs": "linux", '
              '"identity": {"serial": "K-1", "name": "Kiosk 1"} };\n')
OLD_JS = ('window.__KIOSK_CONFIG__ = { apiUrl: window.location.origin, portalUrl: "https://p.test", '
          '"mode": "laptop", "lanAccess": false, "identity": {"serial": "K-1", "name": "Kiosk 1"} };\n')


def done(cmd, rc=0, out="", err=""):
    return subprocess.CompletedProcess(cmd, rc, out, err)


class Tools:
    """run_cmd's stand-in: a gsettings store ((schema, key) -> printed value),
    an nmcli answer function, and every call with its stdin."""

    def __init__(self, values=None, nmcli=None):
        self.values = dict(values or {})
        self.fail = set()
        self.down = False          # gsettings itself failing (D-Bus not ready, timeout)
        self.nmcli = nmcli or (lambda cmd, stdin: done(cmd, 1))
        self.calls = []

    def __call__(self, cmd, *, stdin=None, timeout=10):
        self.calls.append((list(cmd), stdin))
        if cmd[0] == "gsettings":
            verb, schema, key = cmd[1], cmd[2], cmd[3]
            if self.down:
                return done(cmd, 1, err="error: Cannot autolaunch D-Bus without X11 $DISPLAY")
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


def test_restore_without_a_file_and_nothing_locked_changes_nothing(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.restore_desktop() is True
    assert tools.values == GNOME
    assert [c for c, _ in tools.calls if c[1] != "get"] == []


LOCKED = {
    ("org.gnome.mutter", "overlay-key"): "''",                                   # locked
    ("org.gnome.desktop.interface", "enable-hot-corners"): "false",              # locked
    ("org.gnome.desktop.wm.preferences", "num-workspaces"): "4",                 # not the locked value
    ("org.gnome.desktop.wm.keybindings", "switch-applications"): "@as []",       # locked
}


def test_restore_without_a_file_resets_the_keys_still_locked(ks, monkeypatch):
    tools = Tools(LOCKED)
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.restore_desktop() is True
    resets = sorted((c[2], c[3]) for c, _ in tools.calls if c[1] == "reset")
    assert resets == sorted([("org.gnome.mutter", "overlay-key"), ("org.gnome.desktop.interface", "enable-hot-corners"),
                             ("org.gnome.desktop.wm.keybindings", "switch-applications")])
    assert tools.values[("org.gnome.desktop.wm.preferences", "num-workspaces")] == "4"
    assert [c for c, _ in tools.calls if c[1] == "set"] == []


def test_a_corrupt_file_is_kept_aside_and_the_locked_keys_reset(ks, monkeypatch):
    tools = Tools(LOCKED)
    monkeypatch.setattr(ks, "run_cmd", tools)
    lock = ks.state_dir() / "desktop-lock.json"
    lock.parent.mkdir(parents=True)
    lock.write_text('{"version": 1, "saved": [{"sch')
    assert ks.restore_desktop() is True
    assert tools.values[("org.gnome.mutter", "overlay-key")] == "DEFAULT"
    assert tools.values[("org.gnome.desktop.wm.preferences", "num-workspaces")] == "4"
    assert not lock.exists()
    assert (lock.parent / "desktop-lock.json.corrupt").read_text() == '{"version": 1, "saved": [{"sch'
    assert "corrupt" in (ks.state_dir() / "session.log").read_text()


def test_a_gsettings_outage_keeps_the_file(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    ks.lock_desktop()
    lock = ks.state_dir() / "desktop-lock.json"
    before = lock.read_text()
    tools.down = True
    assert ks.restore_desktop() is False
    assert json.loads(lock.read_text()) == json.loads(before)
    tools.down = False
    assert ks.restore_desktop() is True and tools.values == GNOME and not lock.exists()


def test_a_missing_schema_or_key_is_dropped_on_restore(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    ks.lock_desktop()
    del tools.values[("org.gnome.mutter", "overlay-key")]        # gone since: "No such key"
    assert ks.restore_desktop() is True
    assert not (ks.state_dir() / "desktop-lock.json").exists()


def test_without_a_file_an_outage_reports_failure(ks, monkeypatch):
    tools = Tools(LOCKED)
    tools.down = True
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.restore_desktop() is False


def test_relock_fills_in_keys_missing_from_a_partial_file(ks, monkeypatch):
    tools = Tools({**GNOME, ("org.gnome.desktop.interface", "enable-hot-corners"): "false"})
    monkeypatch.setattr(ks, "run_cmd", tools)
    lock = ks.state_dir() / "desktop-lock.json"
    lock.parent.mkdir(parents=True)
    partial = [{"schema": "org.gnome.mutter", "key": "overlay-key", "value": "'Super_L'"}]
    lock.write_text(json.dumps({"version": 1, "saved": partial}))
    tools.values[("org.gnome.mutter", "overlay-key")] = "''"     # locked by the crashed session
    order = []
    real_write = ks.write_saved
    monkeypatch.setattr(ks, "write_saved", lambda items: (order.append("saved"), real_write(items)))
    real_run = tools
    monkeypatch.setattr(ks, "run_cmd", lambda cmd, **kw: (order.append(cmd[1]), real_run(cmd, **kw))[1])
    assert ks.lock_desktop() == len(GNOME)
    assert order.index("saved") < order.index("set")
    saved = {(i["schema"], i["key"]): i["value"] for i in json.loads(lock.read_text())["saved"]}
    assert saved[("org.gnome.mutter", "overlay-key")] == "'Super_L'"            # never overwritten
    assert saved[("org.gnome.desktop.interface", "enable-hot-corners")] is None  # already locked
    assert saved[("org.gnome.desktop.wm.preferences", "num-workspaces")] == "4"
    assert len(saved) == len(GNOME)
    assert ks.restore_desktop() is True
    assert tools.values == {**GNOME, ("org.gnome.desktop.interface", "enable-hot-corners"): "DEFAULT"}


def test_relock_with_a_partial_file_that_cant_be_rewritten_locks_only_the_saved_keys(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    lock = ks.state_dir() / "desktop-lock.json"
    lock.parent.mkdir(parents=True)
    lock.write_text(json.dumps({"version": 1, "saved": [
        {"schema": "org.gnome.mutter", "key": "overlay-key", "value": "'Super_L'"}]}))
    def refuse(items):
        raise OSError("read-only")
    monkeypatch.setattr(ks, "write_saved", refuse)
    assert ks.lock_desktop() == 1
    assert [c for c, _ in tools.calls if c[1] == "set"] == [["gsettings", "set", "org.gnome.mutter", "overlay-key", "''"]]


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
    (bindir / "gsettings").write_text(
        '#!/bin/sh\necho "No such schema \u201c$3\u201d" >&2\nexit 1\n'); (bindir / "gsettings").chmod(0o755)
    env = {**os.environ, "HOME": str(home), "XDG_STATE_HOME": str(state), "PATH": f"{bindir}:/usr/bin:/bin"}
    r = subprocess.run([sys.executable, str(copy), "restore", "--cleanup"], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert not (auto / "serversherpa-kiosk-restore.desktop").exists() and not copy.exists()
    assert not (state / "serversherpa-kiosk" / "desktop-lock.json").exists()


def test_restore_cleanup_cli_keeps_everything_when_gsettings_fails(tmp_path):
    home, state = tmp_path / "home", tmp_path / "state"
    auto = home / ".config" / "autostart"; auto.mkdir(parents=True)
    entry = auto / "serversherpa-kiosk-restore.desktop"
    entry.write_text("[Desktop Entry]\n")
    (state / "serversherpa-kiosk").mkdir(parents=True)
    copy = state / "serversherpa-kiosk" / "kiosk_session.py"
    copy.write_text(SESSION_PY.read_text())
    lock = state / "serversherpa-kiosk" / "desktop-lock.json"
    lock.write_text(json.dumps({"version": 1, "saved": [
        {"schema": "org.gnome.mutter", "key": "overlay-key", "value": "'Super_L'"}]}))
    before = lock.read_text()
    bindir = tmp_path / "bin"; bindir.mkdir()
    (bindir / "gsettings").write_text(
        "#!/bin/sh\necho 'error: Failed to connect to the D-Bus session bus' >&2\nexit 1\n")
    (bindir / "gsettings").chmod(0o755)
    env = {**os.environ, "HOME": str(home), "XDG_STATE_HOME": str(state), "PATH": f"{bindir}:/usr/bin:/bin"}
    r = subprocess.run([sys.executable, str(copy), "restore", "--cleanup"], env=env, capture_output=True, text=True)
    assert r.returncode != 0
    assert json.loads(lock.read_text()) == json.loads(before)
    assert entry.exists() and copy.exists()


def test_cleanup_restore_entry_survives_an_oserror(ks, monkeypatch):
    def boom(self, missing_ok=False):
        raise PermissionError("denied")
    with monkeypatch.context() as m:
        m.setattr(Path, "unlink", boom)
        ks.cleanup_restore_entry()                             # no exception
    assert "denied" in (ks.state_dir() / "session.log").read_text()


def test_tools_run_in_the_c_locale(ks, monkeypatch):
    seen = {}
    def fake_run(cmd, **kw):
        seen.update(kw)
        return done(cmd)
    monkeypatch.setenv("LANG", "de_DE.UTF-8")
    monkeypatch.setenv("LC_ALL", "de_DE.UTF-8")
    monkeypatch.setenv("LANGUAGE", "de")
    monkeypatch.setenv("KIOSK_MARKER", "kept")
    monkeypatch.setattr(ks.subprocess, "run", fake_run)
    ks.run_cmd(["nmcli", "device", "status"])
    env = seen["env"]
    assert env["LC_ALL"].split(".")[0] == "C"
    assert "LANGUAGE" not in env                               # gettext would still translate
    assert env["KIOSK_MARKER"] == "kept" and env["PATH"] == os.environ["PATH"]


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


def test_battery_counts_a_usb_c_charger(ks, tmp_path):
    root = tmp_path / "ps"
    supply(root, "ucsi-source-psy-USBC000:001", type="USB", online="1")
    supply(root, "BAT0", type="Battery", capacity="64", status="Not charging")
    assert ks.battery(root) == {"percent": 64, "charging": True}
    (root / "ucsi-source-psy-USBC000:001" / "online").write_text("0\n")
    assert ks.battery(root) == {"percent": 64, "charging": False}


def test_nmcli_fields_unescape(ks):
    assert ks.nmcli_fields(r"*:Cafe\: Guest:72:WPA2") == ["*", "Cafe: Guest", "72", "WPA2"]
    assert ks.nmcli_fields(r" :back\\slash:5:") == [" ", "back\\slash", "5", ""]
    assert ks.nmcli_fields("*:trailing\\") == ["*", "trailing\\"]
    assert ks.nmcli_fields("\\") == ["\\"]


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


def test_the_connected_network_shows_the_in_use_access_points_signal(ks, monkeypatch):
    out = " :CSG-Ops:90:WPA2\n*:CSG-Ops:35:WPA2\n :CSG-Ops:60:WPA2\n :Lobby:50:--\n"
    monkeypatch.setattr(ks, "run_cmd", Tools(nmcli=lambda cmd, stdin: done(cmd, 0, out) if "wifi" in cmd else done(cmd, 1)))
    monkeypatch.setattr(ks, "POWER_SUPPLY", Path("/nonexistent-ps"))
    nets = ks.wifi_networks()
    assert nets[0] == {"ssid": "CSG-Ops", "signal": 35, "secure": True, "active": True}
    assert ks.system_info()["wifi"] == {"ssid": "CSG-Ops", "signal": 35}


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


# ── Task 3: helper server, waiting page, cloud check, watcher ─────────
import http.client
import socket
import threading

KIOSK = "http://localhost:8090"
TOKEN = "t" * 43
SYS = {"battery": None, "wifi": None, "wired": None, "network": "none"}


@pytest.fixture
def helper(ks, monkeypatch):
    monkeypatch.setattr(ks, "system_info", lambda: dict(SYS))
    # /proc/net/tcp isn't there on every test machine: the peer is "us"
    monkeypatch.setattr(ks, "peer_uid", lambda addr, port: os.getuid())
    session = ks.Session(TOKEN, "http://cloud.test")
    server = ks.HelperServer(session, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield session, server.server_port
    server.shutdown()
    server.server_close()


def call(port, method, path, *, host=None, origin=None, token=None, body=None, ctype="application/json"):
    headers = {"Host": host or f"127.0.0.1:{port}"}
    if origin:
        headers["Origin"] = origin
    if token:
        headers["X-Kiosk-Token"] = token
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers["Content-Type"] = ctype
        headers["Content-Length"] = str(len(data))
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(method, path, body=data, headers=headers)
    r = conn.getresponse()
    raw = r.read()
    hdrs = {k.lower(): v for k, v in r.getheaders()}
    conn.close()
    return r.status, hdrs, raw


def test_wrong_host_is_400(helper):
    _, port = helper
    for path in ("/waiting", "/v1/system"):
        assert call(port, "GET", path, host=f"evil.test:{port}", token=TOKEN)[0] == 400
        assert call(port, "GET", path, host=f"localhost:{port}", token=TOKEN)[0] == 400


def test_v1_needs_the_token_and_a_known_origin(helper):
    _, port = helper
    assert call(port, "GET", "/v1/system", origin=KIOSK)[0] == 403
    assert call(port, "GET", "/v1/system", origin=KIOSK, token="x" * 43)[0] == 403
    assert call(port, "GET", "/v1/system", origin="http://evil.test", token=TOKEN)[0] == 403
    assert call(port, "GET", "/v1/system", origin="http://10.10.48.57:8090", token=TOKEN)[0] == 403
    status, hdrs, raw = call(port, "GET", "/v1/system", origin=KIOSK, token=TOKEN)
    assert status == 200 and json.loads(raw) == SYS
    assert hdrs["access-control-allow-origin"] == KIOSK
    status, hdrs, _ = call(port, "GET", "/v1/system", origin=f"http://127.0.0.1:{port}", token=TOKEN)
    assert status == 200 and "access-control-allow-origin" not in hdrs   # same origin: no CORS


def test_preflight_only_for_the_kiosk(helper):
    _, port = helper
    status, hdrs, _ = call(port, "OPTIONS", "/v1/exit", origin=KIOSK)
    assert status == 204
    assert hdrs["access-control-allow-origin"] == KIOSK
    assert "X-Kiosk-Token" in hdrs["access-control-allow-headers"]
    assert hdrs["access-control-allow-private-network"] == "true"
    assert call(port, "OPTIONS", "/v1/exit", origin="http://evil.test")[0] == 403


def test_waiting_page(helper):
    _, port = helper
    status, hdrs, raw = call(port, "GET", "/waiting")
    page = raw.decode()
    assert status == 200 and hdrs["content-type"].startswith("text/html")
    assert "Connecting to ServerSherpa" in page and TOKEN in page and '"http://localhost:8090"' in page
    assert "frame-ancestors 'none'" in hdrs["content-security-policy"] and hdrs["x-frame-options"] == "DENY"
    assert "access-control-allow-origin" not in hdrs
    assert call(port, "GET", "/waiting", origin="http://evil.test")[0] == 403


def test_state_is_ready_once_cloud_and_edge_answer(helper, ks, monkeypatch):
    session, port = helper
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: True)
    out = json.loads(call(port, "GET", "/v1/state", token=TOKEN)[2])
    assert out == {"ready": False, "cloud": False, "last_attempt": None, "system": SYS}
    session.cloud_ok = session.edge_ok = True
    session.last_attempt_ms = 1762851900000
    out = json.loads(call(port, "GET", "/v1/state", token=TOKEN)[2])
    assert out["ready"] is True and out["last_attempt"] == 1762851900000


def test_exit_needs_the_pin(helper):
    session, port = helper
    status, _, raw = call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body={"pin": "CSG"})
    assert status == 403 and json.loads(raw) == {"error": "wrong_pin"} and not session.exit.is_set()
    status, _, raw = call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body={"pin": "csg"})
    # the answer goes out first, then the session is told to exit
    assert status == 200 and json.loads(raw) == {"ok": True} and session.exit.wait(2)


def test_post_body_rules(helper):
    session, port = helper
    assert call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body=b"pin=csg", ctype="text/plain")[0] == 400
    assert call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body=b"[1]")[0] == 400
    assert call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body={"pin": "x" * 5000})[0] == 400
    assert not session.exit.is_set()


def test_join_maps_codes_and_never_logs_the_password(helper, ks, monkeypatch):
    _, port = helper
    codes = iter(["wrong_password", "ok"])
    monkeypatch.setattr(ks, "join_wifi", lambda ssid, password: next(codes))
    body = {"ssid": "CSG-Ops", "password": "hunter2-secret"}
    status, _, raw = call(port, "POST", "/v1/wifi/join", origin=KIOSK, token=TOKEN, body=body)
    assert status == 422 and json.loads(raw) == {"error": "wrong_password"}
    status, _, raw = call(port, "POST", "/v1/wifi/join", origin=KIOSK, token=TOKEN, body=body)
    assert status == 200 and json.loads(raw) == {"ok": True}
    assert call(port, "POST", "/v1/wifi/join", origin=KIOSK, token=TOKEN, body={"ssid": "", "password": ""})[0] == 400
    log = ks.state_dir() / "session.log"
    assert "hunter2" not in log.read_text() and TOKEN not in log.read_text()


def test_check_once_tries_the_cloud_until_it_answers_then_only_the_edge(ks, monkeypatch):
    answers = {"http://cloud.test/system/status": [False, True], ks.EDGE_IDENTITY_URL: [True, True, True]}
    seen = []
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: (seen.append(url), answers[url].pop(0))[1])
    s = ks.Session(TOKEN, "http://cloud.test")
    s.check_once()
    assert not s.ready and s.last_attempt_ms is not None
    s.check_once()
    assert s.ready
    s.check_once()
    assert seen.count("http://cloud.test/system/status") == 2 and seen.count(ks.EDGE_IDENTITY_URL) == 3


class FakeProc:
    def __init__(self, life):
        self.life, self.returncode, self.pid = life, None, 999999

    def poll(self):
        if self.life <= 0:
            self.returncode = 0
            return 0
        self.life -= 1
        return None


def test_watch_reopens_chrome_until_exit(ks, monkeypatch):
    monkeypatch.setattr(ks, "WATCH_S", 0.01)
    monkeypatch.setattr(ks, "RELAUNCH_DELAY_S", 0.01)
    closed = []
    monkeypatch.setattr(ks, "close_chrome", lambda p: closed.append(p))
    s = ks.Session(TOKEN, "http://cloud.test")
    s.waiting_url = "http://127.0.0.1:8092/waiting"
    launched = []

    def launch(browser, url):
        launched.append((browser, url))
        if len(launched) == 3:
            s.exit.set()
        return FakeProc(2)
    ks.watch(s, "/usr/bin/google-chrome", launch=launch)
    assert launched == [("/usr/bin/google-chrome", "http://127.0.0.1:8092/waiting")] * 3
    assert closed == [s.chrome]


def test_launch_chrome_flags_and_profile(ks, monkeypatch, tmp_path):
    got = {}
    monkeypatch.setattr(ks.subprocess, "Popen", lambda args, **kw: got.update(args=args, kw=kw) or "proc")
    assert ks.launch_chrome("/usr/bin/google-chrome", "http://127.0.0.1:8092/waiting") == "proc"
    profile = tmp_path / "home" / ".local" / "share" / "serversherpa-kiosk" / "chrome"
    assert got["args"] == ["/usr/bin/google-chrome", *ks.CHROME_FLAGS, f"--user-data-dir={profile}",
                           "http://127.0.0.1:8092/waiting"]
    assert "--kiosk" in ks.CHROME_FLAGS and got["kw"]["start_new_session"] is True
    assert profile.is_dir()
    assert ks.profile_dir("/snap/bin/chromium") == tmp_path / "home" / "snap" / "chromium" / "common" / "serversherpa-kiosk"


def test_run_order_lock_watch_close_restore(ks, monkeypatch):
    events = []
    monkeypatch.setattr(ks, "HELPER_PORT", 0)
    monkeypatch.setattr(ks.signal, "signal", lambda *a: None)
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: False)
    monkeypatch.setattr(ks, "ensure_start_icon", lambda: events.append("icon"))
    monkeypatch.setattr(ks, "lock_desktop", lambda: events.append("lock") or 1)
    monkeypatch.setattr(ks, "restore_desktop", lambda: events.append("restore") or True)
    monkeypatch.setattr(ks, "close_chrome", lambda p: events.append("close"))

    def fake_watch(session, browser):
        events.append("watch")
        assert session.waiting_url.endswith("/waiting")
        session.exit.set()
    monkeypatch.setattr(ks, "watch", fake_watch)
    assert ks.run("/usr/bin/google-chrome") == 0
    assert events == ["icon", "lock", "watch", "close", "restore"]


def test_a_second_session_exits_quietly_when_the_port_is_taken(ks, monkeypatch):
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen()
    try:
        monkeypatch.setattr(ks, "HELPER_PORT", blocker.getsockname()[1])
        monkeypatch.setattr(ks, "lock_desktop", lambda: pytest.fail("a second session must not lock"))
        assert ks.run("/usr/bin/google-chrome") == 0
    finally:
        blocker.close()


def test_chrome_keeps_the_users_language(ks, monkeypatch):
    """Chrome starts with the user's own environment, not tool_env's C
    locale, so its UI stays in the laptop's language."""
    monkeypatch.setenv("LANGUAGE", "nl:en")
    monkeypatch.setenv("LANG", "nl_NL.UTF-8")
    monkeypatch.delenv("LC_ALL", raising=False)
    got = {}
    monkeypatch.setattr(ks.subprocess, "Popen", lambda args, **kw: got.update(kw=kw) or "proc")
    monkeypatch.setattr(ks, "run_cmd", lambda *a, **k: pytest.fail("Chrome must not go through run_cmd"))
    ks.launch_chrome("/usr/bin/google-chrome", "http://127.0.0.1:8092/waiting")
    env = got["kw"].get("env")
    env = os.environ if env is None else env      # None: Popen inherits the user's environment
    assert env.get("LANGUAGE") == "nl:en" and env.get("LANG") == "nl_NL.UTF-8"
    assert "LC_ALL" not in env


# ── Task 3, fix round 1 ───────────────────────────────────────────────
import signal
import time

TCP_HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"


def v4hex(ip):
    """An IPv4 address as /proc/net/tcp prints it (a native-order u32)."""
    return "%08X" % int.from_bytes(socket.inet_aton(ip), sys.byteorder)


def v6hex(ip):
    raw = socket.inet_pton(socket.AF_INET6, ip)
    return "".join("%08X" % int.from_bytes(raw[i:i + 4], sys.byteorder) for i in range(0, 16, 4))


def tcp_row(n, local, remote, uid):
    return (f"{n:4d}: {local} {remote} 01 00000000:00000000 00:00000000 00000000 {uid:5d}        0 "
            f"{4000 + n} 1 0000000000000000 20 4 30 10 -1\n")


def fake_proc_net(tmp_path, tcp=(), tcp6=()):
    root = tmp_path / "proc"
    (root / "net").mkdir(parents=True)
    (root / "net" / "tcp").write_text(TCP_HEAD + "".join(tcp))
    (root / "net" / "tcp6").write_text(TCP_HEAD + "".join(tcp6))
    return root


def test_peer_uid_ipv4(ks, tmp_path):
    lo = v4hex("127.0.0.1")
    root = fake_proc_net(tmp_path, tcp=[
        tcp_row(0, f"{lo}:1F9C", "00000000:0000", 1000),        # the helper listening (8092)
        tcp_row(1, f"{lo}:1F9C", f"{lo}:D431", 1000),           # the helper's side of it
        tcp_row(2, f"{lo}:D431", f"{lo}:1F90", 0),              # same port, to 8080: not ours
        tcp_row(3, f"{lo}:D431", f"{lo}:1F9C", 1001),           # the client (54321 -> 8092)
    ])
    assert ks.peer_uid(("127.0.0.1", 54321), 8092, proc_root=str(root)) == 1001


def test_peer_uid_ipv4_mapped_ipv6(ks, tmp_path):
    mapped = v6hex("::ffff:127.0.0.1")
    root = fake_proc_net(tmp_path, tcp6=[tcp_row(0, f"{mapped}:D431", f"{mapped}:1F9C", 1002)])
    assert ks.peer_uid(("127.0.0.1", 54321), 8092, proc_root=str(root)) == 1002
    assert ks.peer_uid(("::ffff:127.0.0.1", 54321, 0, 0), 8092, proc_root=str(root)) == 1002


def test_peer_uid_not_found_is_none(ks, tmp_path):
    lo = v4hex("127.0.0.1")
    root = fake_proc_net(tmp_path, tcp=[tcp_row(0, f"{lo}:D432", f"{lo}:1F9C", 1000), "garbage line\n"])
    assert ks.peer_uid(("127.0.0.1", 54321), 8092, proc_root=str(root)) is None
    assert ks.peer_uid(("127.0.0.1", 54321), 8092, proc_root=str(tmp_path / "nothing")) is None


@pytest.mark.skipif(not Path("/proc/net/tcp").exists(), reason="Linux /proc only")
def test_peer_uid_finds_a_real_connection(ks):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    cli = socket.create_connection(srv.getsockname())
    try:
        conn, addr = srv.accept()
        assert ks.peer_uid(addr, srv.getsockname()[1]) == os.getuid()
        conn.close()
    finally:
        cli.close()
        srv.close()


@pytest.mark.parametrize("uid", [None, "other"])
def test_only_the_session_users_processes_get_an_answer(helper, ks, monkeypatch, uid):
    _, port = helper
    seen = []
    other = os.getuid() + 1

    def fake(addr, server_port):
        seen.append((addr, server_port))
        return other if uid == "other" else None
    monkeypatch.setattr(ks, "peer_uid", fake)
    status, _, raw = call(port, "GET", "/waiting")
    assert status == 403 and TOKEN.encode() not in raw
    assert call(port, "GET", "/v1/state", token=TOKEN)[0] == 403
    assert call(port, "OPTIONS", "/v1/exit", origin=KIOSK)[0] == 403
    assert call(port, "POST", "/v1/exit", token=TOKEN, body={"pin": "csg"})[0] == 403
    assert not helper[0].exit.is_set()
    assert seen and seen[0][0][0] == "127.0.0.1" and seen[0][1] == port
    text = (ks.state_dir() / "session.log").read_text()
    assert "helper: refused" in text and TOKEN not in text


def test_state_checks_the_edge_live_and_caches_it_briefly(ks, monkeypatch):
    probes = []
    answer = [False]
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: (probes.append((url, timeout)), answer[0])[1])
    s = ks.Session(TOKEN, "http://cloud.test")
    assert s.ready_now() is False and probes == []          # no cloud yet: no edge probe
    s.cloud_ok = s.edge_ok = True                           # the last 15 s check said yes
    assert s.ready_now() is False                           # the edge is down now
    assert probes == [(ks.EDGE_IDENTITY_URL, ks.EDGE_LIVE_TIMEOUT_S)] and ks.EDGE_LIVE_TIMEOUT_S <= 3
    answer[0] = True
    assert s.ready_now() is False and len(probes) == 1      # cached
    assert ks.EDGE_CACHE_S <= 2
    monkeypatch.setattr(ks, "EDGE_CACHE_S", 0)
    assert s.ready_now() is True and len(probes) == 2


def test_state_endpoint_uses_the_live_edge(helper, ks, monkeypatch):
    session, port = helper
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: False)
    session.cloud_ok = session.edge_ok = True
    out = json.loads(call(port, "GET", "/v1/state", token=TOKEN)[2])
    assert out["ready"] is False and out["cloud"] is True


def test_system_serves_the_cached_value_while_a_refresh_runs(ks, monkeypatch):
    gate = threading.Event()
    started = threading.Event()
    n = [0]

    def info():
        n[0] += 1
        if n[0] == 2:
            started.set()
            gate.wait(5)
        return {"n": n[0]}
    monkeypatch.setattr(ks, "system_info", info)
    s = ks.Session(TOKEN, "http://cloud.test")
    assert s.system() == {"n": 1}
    monkeypatch.setattr(ks, "SYSTEM_CACHE_S", 0)
    out = []
    t = threading.Thread(target=lambda: out.append(s.system()))
    t.start()
    assert started.wait(2)
    t0 = time.monotonic()
    assert s.system() == {"n": 1}                           # stale, but not blocked
    s.cloud_ok = True
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: True)
    assert s.ready_now() is True                            # the edge probe doesn't wait either
    assert time.monotonic() - t0 < 1
    gate.set()
    t.join(5)
    assert out == [{"n": 2}]
    monkeypatch.setattr(ks, "SYSTEM_CACHE_S", 60)
    assert s.system() == {"n": 2}


def test_system_first_callers_share_one_refresh(ks, monkeypatch):
    gate = threading.Event()
    calls = []
    monkeypatch.setattr(ks, "system_info", lambda: (calls.append(1), gate.wait(5), {"ok": 1})[2])
    s = ks.Session(TOKEN, "http://cloud.test")
    out = []
    threads = [threading.Thread(target=lambda: out.append(s.system())) for _ in range(3)]
    for t in threads:
        t.start()
    time.sleep(0.1)
    gate.set()
    for t in threads:
        t.join(5)
    assert out == [{"ok": 1}] * 3 and len(calls) == 1


def test_forget_system_drops_a_refresh_already_running(ks, monkeypatch):
    gate = threading.Event()
    started = threading.Event()
    n = [0]

    def info():
        n[0] += 1
        if n[0] == 1:
            started.set()
            gate.wait(5)
        return {"n": n[0]}
    monkeypatch.setattr(ks, "system_info", info)
    s = ks.Session(TOKEN, "http://cloud.test")
    t = threading.Thread(target=s.system)
    t.start()
    assert started.wait(2)
    s.forget_system()                     # a Wi-Fi join just finished
    gate.set()
    t.join(5)
    assert s.system() == {"n": 2}         # the pre-join answer wasn't kept


def test_options_needs_the_right_host_and_a_v1_path(helper):
    _, port = helper
    assert call(port, "OPTIONS", "/v1/exit", origin=KIOSK, host=f"localhost:{port}")[0] == 403
    assert call(port, "OPTIONS", "/waiting", origin=KIOSK)[0] == 403
    assert call(port, "OPTIONS", "/", origin=KIOSK)[0] == 403


def test_post_body_size_edge(helper):
    session, port = helper
    ok = json.dumps({"pin": "x" * (4096 - 11)}).encode()
    big = json.dumps({"pin": "x" * (4097 - 11)}).encode()
    assert len(ok) == 4096 and len(big) == 4097
    status, _, raw = call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body=ok)
    assert status == 403 and json.loads(raw) == {"error": "wrong_pin"}     # read and judged
    status, _, raw = call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body=big)
    assert status == 400 and json.loads(raw) == {"error": "bad_request"}
    assert not session.exit.is_set()


def test_wifi_endpoint_shape(helper, ks, monkeypatch):
    _, port = helper
    nets = [{"ssid": "CSG-Ops", "signal": 80, "secure": True, "active": True},
            {"ssid": "Guest", "signal": 40, "secure": False, "active": False}]
    rescans = []
    monkeypatch.setattr(ks, "wifi_networks", lambda rescan=True: rescans.append(rescan) or nets)
    monkeypatch.setattr(ks, "wired_status", lambda: {"connected": False, "device": "enp0s31f6"})
    status, hdrs, raw = call(port, "GET", "/v1/wifi", origin=KIOSK, token=TOKEN)
    assert status == 200 and hdrs["content-type"] == "application/json"
    assert json.loads(raw) == {"networks": nets, "wired": {"connected": False, "device": "enp0s31f6"}}
    assert rescans == [True]
    monkeypatch.setattr(ks, "wired_status", lambda: None)
    assert json.loads(call(port, "GET", "/v1/wifi", token=TOKEN)[2])["wired"] is None


# A leftover kiosk Chrome (the helper was SIGKILLed; Chrome lived on in its own session)
def fake_procs(tmp_path, procs):
    root = tmp_path / "procs"
    root.mkdir(exist_ok=True)
    (root / "self").mkdir(exist_ok=True)
    for pid, args in procs.items():
        d = root / str(pid)
        d.mkdir()
        (d / "cmdline").write_bytes(b"\0".join(a.encode() for a in args) + b"\0")
    return root


def test_kiosk_chrome_pids_match_only_the_kiosk_profile(ks, tmp_path):
    prof = "/home/kiosk/.local/share/serversherpa-kiosk/chrome"
    root = fake_procs(tmp_path, {
        101: ["/opt/google/chrome/chrome", "--kiosk", f"--user-data-dir={prof}", "http://x"],
        102: ["/opt/google/chrome/chrome", "--user-data-dir=/home/kiosk/.config/google-chrome"],
        103: ["/opt/google/chrome/chrome", "--user-data-dir", prof],
        104: ["/opt/google/chrome/chrome", f"--user-data-dir={prof}-2"],
        105: ["/opt/google/chrome/chrome"],                   # the user's everyday Chrome
        os.getpid(): ["python3", f"--user-data-dir={prof}"],  # never this process
    })
    assert ks.kiosk_chrome_pids(Path(prof), proc_root=str(root)) == [101, 103]
    assert ks.kiosk_chrome_pids(Path(prof), proc_root=str(tmp_path / "none")) == []


def test_stop_kiosk_chrome_terms_then_kills_only_the_kiosk_ones(ks, tmp_path, monkeypatch):
    import shutil
    monkeypatch.setattr(ks, "CHROME_STOP_S", 0.2)
    prof = "/p/kiosk"
    root = fake_procs(tmp_path, {201: ["chrome", f"--user-data-dir={prof}"],
                                 202: ["chrome", f"--user-data-dir={prof}", "--type=renderer"],
                                 203: ["chrome", "--user-data-dir=/p/everyday"]})
    sent = []

    def kill(pid, sig):
        sent.append((pid, sig))
        if pid == 201 or sig == signal.SIGKILL:      # 202 ignores SIGTERM
            shutil.rmtree(root / str(pid))
    ks.stop_kiosk_chrome(Path(prof), proc_root=str(root), kill=kill)
    assert sent == [(201, signal.SIGTERM), (202, signal.SIGTERM), (202, signal.SIGKILL)]
    assert (root / "203").exists()
    assert "left over" in (ks.state_dir() / "session.log").read_text()


def test_stop_kiosk_chrome_with_none_left_does_nothing(ks, tmp_path):
    root = fake_procs(tmp_path, {301: ["chrome", "--user-data-dir=/p/everyday"]})
    ks.stop_kiosk_chrome(Path("/p/kiosk"), proc_root=str(root), kill=lambda *a: pytest.fail("no kill"))


def test_launch_chrome_stops_a_leftover_first(ks, monkeypatch, tmp_path):
    order = []
    monkeypatch.setattr(ks, "stop_kiosk_chrome", lambda profile: order.append(("stop", profile)))
    monkeypatch.setattr(ks.subprocess, "Popen", lambda args, **kw: order.append(("popen",)) or "proc")
    ks.launch_chrome("/usr/bin/google-chrome", "http://127.0.0.1:8092/waiting")
    assert order == [("stop", ks.profile_dir("/usr/bin/google-chrome")), ("popen",)]


# A missing browser: the session ends (desktop back), never locked with no Chrome
def test_watch_names_a_missing_browser_and_gives_up(ks):
    s = ks.Session(TOKEN, "http://cloud.test")

    def launch(browser, url):
        raise FileNotFoundError(2, "No such file or directory", browser)
    with pytest.raises(FileNotFoundError):
        ks.watch(s, "/usr/bin/google-chrome", launch=launch)
    text = (ks.state_dir() / "session.log").read_text()
    assert "can't start the browser /usr/bin/google-chrome" in text


@pytest.mark.parametrize("kind", ["missing", "not_executable"])
def test_run_with_a_browser_that_cant_start_restores_and_fails(ks, monkeypatch, tmp_path, kind):
    events = []
    monkeypatch.setattr(ks, "HELPER_PORT", 0)
    monkeypatch.setattr(ks.signal, "signal", lambda *a: None)
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: False)
    monkeypatch.setattr(ks, "ensure_start_icon", lambda: None)
    monkeypatch.setattr(ks, "lock_desktop", lambda: events.append("lock") or 1)
    monkeypatch.setattr(ks, "restore_desktop", lambda: events.append("restore") or True)
    browser = tmp_path / "chrome"
    if kind == "not_executable":
        browser.write_text("#!/bin/sh\n")
        browser.chmod(0o644)
    assert ks.run(str(browser)) == 1
    assert events == ["lock", "restore"]
    assert f"can't start the browser {browser}" in (ks.state_dir() / "session.log").read_text()


# close_chrome on real processes
def _spawn(code):
    p = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True, start_new_session=True)
    line = p.stdout.readline().strip()
    return p, line


def _gone(pid, within=3.0):
    end = time.monotonic() + within
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.02)
    return False


def test_close_chrome_terms_the_whole_group(ks):
    p, child = _spawn("import subprocess, sys, time\n"
                      "c = subprocess.Popen(['sleep', '30']); print(c.pid, flush=True); time.sleep(30)")
    ks.close_chrome(p)
    assert p.returncode == -signal.SIGTERM
    assert _gone(int(child))


def test_close_chrome_kills_after_the_grace(ks, monkeypatch):
    monkeypatch.setattr(ks, "CHROME_STOP_S", 0.3)
    p, _ = _spawn("import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                  "print('ready', flush=True)\ntime.sleep(30)")
    t0 = time.monotonic()
    ks.close_chrome(p)
    assert p.returncode == -signal.SIGKILL and time.monotonic() - t0 < 3


def test_close_chrome_on_a_process_already_gone(ks, monkeypatch):
    p = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
    p.wait(5)
    monkeypatch.setattr(ks.os, "killpg", lambda *a: pytest.fail("no signal to an exited process"))
    ks.close_chrome(p)
    ks.close_chrome(None)

    class Vanished:          # poll() hasn't seen it yet, but the group is gone
        pid = 999999

        def poll(self):
            return None
    monkeypatch.setattr(ks.os, "killpg", lambda pid, sig: (_ for _ in ()).throw(ProcessLookupError()))
    ks.close_chrome(Vanished())


RUN_SCRIPT = """
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ks", sys.argv[1])
ks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ks)
ks.HELPER_PORT = 0
ks.url_answers = lambda url, timeout=5: False
ks.ensure_start_icon = lambda: None
def mark(m):
    with open(sys.argv[2], "a") as f:
        f.write(m + "\\n")
ks.lock_desktop = lambda: mark("lock") or 1
ks.restore_desktop = lambda: mark("restore") or True
sys.exit(ks.main(["run", "--browser", sys.argv[3]]))
"""


def test_sigterm_to_run_closes_chrome_and_restores(ks, tmp_path):
    marks = tmp_path / "marks"
    browser = tmp_path / "chrome"
    browser.write_text(f'#!/bin/sh\necho "chrome $$" >> "{marks}"\nexec sleep 30\n')
    browser.chmod(0o755)
    err = tmp_path / "stderr"
    with err.open("w") as errf:
        p = subprocess.Popen([sys.executable, "-c", RUN_SCRIPT, str(SESSION_PY), str(marks), str(browser)],
                             stderr=errf)
    try:
        # Generous: shared CI runners can be slow to start Python.
        end = time.monotonic() + 30
        while time.monotonic() < end and p.poll() is None and "chrome" not in (marks.read_text() if marks.exists() else ""):
            time.sleep(0.05)
        log = ks.state_dir() / "session.log"
        assert marks.exists(), (f"rc={p.poll()} stderr={err.read_text()!r} "
                                f"log={log.read_text() if log.exists() else ''!r}")
        lines = marks.read_text().split()
        assert lines[:2] == ["lock", "chrome"]
        chrome_pid = int(lines[2])
        p.send_signal(signal.SIGTERM)
        assert p.wait(10) == 0
    finally:
        if p.poll() is None:
            p.kill()
    assert marks.read_text().splitlines()[-1] == "restore"
    assert _gone(chrome_pid)
    assert "kiosk session ended" in (ks.state_dir() / "session.log").read_text()


# ── Final fix round: lockdown capability, watcher backoff, stop-chrome ──
def test_lockdown_support_reads_the_hostos_key(ks):
    assert ks.lockdown_support(CAPABLE_JS) is True
    assert ks.lockdown_support(OLD_JS) is False               # an old kiosk app: no key at all
    # the key is there but host-network.json isn't written yet: not confirmed, not refused
    assert ks.lockdown_support(CAPABLE_JS.replace('"linux"', "null")) is None


def _capability_session(ks, monkeypatch, config):
    """A session whose cloud has answered and whose edge answers; config is
    what /config.js returns (a list, popped per fetch)."""
    fetched = []
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: True)
    monkeypatch.setattr(ks, "fetch_text", lambda url, timeout=5: (fetched.append(url), config.pop(0))[1])
    monkeypatch.setattr(ks, "EDGE_CACHE_S", 0)
    s = ks.Session(TOKEN, "http://cloud.test")
    s.cloud_ok = True
    return s, fetched


def test_marker_present_means_ready_to_forward(ks, monkeypatch):
    s, fetched = _capability_session(ks, monkeypatch, [CAPABLE_JS])
    assert s.ready_now() is True and s.lockdown is True
    assert fetched == [ks.EDGE_CONFIG_URL] and not s.exit.is_set()
    assert s.ready_now() is True and len(fetched) == 1        # cached while the edge stays up


def test_no_forward_until_the_capability_is_confirmed(ks, monkeypatch):
    s, fetched = _capability_session(ks, monkeypatch, [None, CAPABLE_JS.replace('"linux"', "null"), CAPABLE_JS])
    s.edge_ok = True
    assert s.ready is False                                   # the edge alone isn't enough
    assert s.ready_now() is False                             # config.js didn't answer
    assert s.ready_now() is False                             # hostOs still null
    assert s.ready_now() is True and len(fetched) == 3
    assert not s.exit.is_set() and not s.no_lockdown


def test_marker_absent_ends_the_session(ks, monkeypatch):
    s, _ = _capability_session(ks, monkeypatch, [OLD_JS])
    assert s.ready_now() is False
    assert s.no_lockdown is True and s.exit.is_set()
    assert "no Esc" in (ks.state_dir() / "session.log").read_text()


def test_the_capability_is_checked_again_after_the_edge_comes_back(ks, monkeypatch):
    up = [True]
    s, fetched = _capability_session(ks, monkeypatch, [CAPABLE_JS, OLD_JS])
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: up[0])
    assert s.ready_now() is True
    up[0] = False
    assert s.ready_now() is False and s.lockdown is None      # the edge went down: forgotten
    up[0] = True
    assert s.ready_now() is False and s.no_lockdown is True   # an update swapped in an old app
    assert len(fetched) == 2


def test_the_15s_check_re_reads_the_capability(ks, monkeypatch):
    """A restart faster than the probes is still caught: check_once reads
    /config.js every time; a refusal there ends the session too."""
    s, fetched = _capability_session(ks, monkeypatch, [CAPABLE_JS, CAPABLE_JS, OLD_JS])
    s.check_once()
    assert s.ready and s.lockdown is True
    s.check_once()
    assert s.ready and len(fetched) == 2
    s.check_once()
    assert s.no_lockdown and s.exit.is_set()


def test_state_endpoint_waits_for_the_capability(helper, ks, monkeypatch):
    session, port = helper
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: True)
    monkeypatch.setattr(ks, "fetch_text", lambda url, timeout=5: None)
    session.cloud_ok = True
    out = json.loads(call(port, "GET", "/v1/state", token=TOKEN)[2])
    assert out["ready"] is False


def test_run_without_lockdown_support_stops_closes_restores_and_exits_3(ks, monkeypatch):
    """The exit path, in order: the log line, the watcher stops, Chrome
    closes, the desktop comes back; then the distinct exit code."""
    events = []
    monkeypatch.setattr(ks, "HELPER_PORT", 0)
    monkeypatch.setattr(ks, "WATCH_S", 0.01)
    monkeypatch.setattr(ks.signal, "signal", lambda *a: None)
    chrome_up = threading.Event()        # the check answers once Chrome is open (no race)
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: chrome_up.wait(5))
    monkeypatch.setattr(ks, "fetch_text", lambda url, timeout=5: OLD_JS)
    monkeypatch.setattr(ks, "ensure_start_icon", lambda: None)
    monkeypatch.setattr(ks, "lock_desktop", lambda: events.append("lock") or 1)
    monkeypatch.setattr(ks, "restore_desktop", lambda: events.append("restore") or True)
    real_log = ks.log
    monkeypatch.setattr(ks, "log", lambda m: (events.append("log: no lockdown") if "no Esc" in m else None,
                                              real_log(m)))

    class Chrome(FakeProc):
        def poll(self):
            return None              # stays open until it is closed
    real_watch = ks.watch

    def watch(session, browser):
        real_watch(session, browser, launch=lambda b, u: (events.append("chrome"), chrome_up.set(), Chrome(0))[2])
        events.append("watcher stopped")
    monkeypatch.setattr(ks, "watch", watch)
    monkeypatch.setattr(ks, "close_chrome", lambda p: events.append("close") if p is not None else None)
    rc = ks.run("/usr/bin/google-chrome")
    assert rc == ks.RC_NO_LOCKDOWN == 3
    # the watcher's loop stops and closes Chrome; run's own close finds it closed
    assert events == ["lock", "chrome", "log: no lockdown", "close", "watcher stopped", "close", "restore"]


def test_watch_gives_up_after_five_fast_exits(ks, monkeypatch):
    monkeypatch.setattr(ks, "WATCH_S", 0.001)
    monkeypatch.setattr(ks, "RELAUNCH_DELAY_S", 0.001)
    monkeypatch.setattr(ks, "close_chrome", lambda p: None)
    s = ks.Session(TOKEN, "http://cloud.test")
    launched = []
    with pytest.raises(ks.ChromeKeepsClosing):
        ks.watch(s, "/usr/bin/google-chrome", launch=lambda b, u: launched.append(1) or FakeProc(0))
    assert len(launched) == ks.FAST_EXIT_LIMIT == 5 and ks.FAST_EXIT_S == 10
    assert "closed 5 times within 10 s" in (ks.state_dir() / "session.log").read_text()


def test_watch_a_slow_exit_resets_the_count(ks, monkeypatch):
    monkeypatch.setattr(ks, "WATCH_S", 0.001)
    monkeypatch.setattr(ks, "RELAUNCH_DELAY_S", 0.001)
    monkeypatch.setattr(ks, "close_chrome", lambda p: None)
    clock = [0.0]
    monkeypatch.setattr(ks.time, "monotonic", lambda: clock[0])
    s = ks.Session(TOKEN, "http://cloud.test")
    n = [0]

    class Proc(FakeProc):
        def __init__(self, up_s):
            super().__init__(0)
            self.up_s = up_s

        def poll(self):
            clock[0] += self.up_s              # it stayed open this long
            return super().poll()

    def launch(b, u):
        n[0] += 1
        if n[0] == 9:
            s.exit.set()
        return Proc(30 if n[0] == 4 else 1)    # the 4th one stayed up 30 s
    ks.watch(s, "/usr/bin/google-chrome", launch=launch)
    assert n[0] == 9                             # never 5 fast ones in a row


def test_run_ends_with_1_when_chrome_keeps_closing(ks, monkeypatch):
    events = []
    monkeypatch.setattr(ks, "HELPER_PORT", 0)
    monkeypatch.setattr(ks.signal, "signal", lambda *a: None)
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: False)
    monkeypatch.setattr(ks, "ensure_start_icon", lambda: None)
    monkeypatch.setattr(ks, "lock_desktop", lambda: events.append("lock") or 1)
    monkeypatch.setattr(ks, "restore_desktop", lambda: events.append("restore") or True)

    def watch(session, browser):
        raise ks.ChromeKeepsClosing()
    monkeypatch.setattr(ks, "watch", watch)
    assert ks.run("/usr/bin/google-chrome") == 1
    assert events == ["lock", "restore"]


def test_stop_chrome_cli_closes_the_kiosk_profile(ks, monkeypatch):
    seen = []
    monkeypatch.setattr(ks, "stop_kiosk_chrome", lambda profile: seen.append(profile))
    assert ks.main(["stop-chrome", "--browser", "/usr/bin/google-chrome"]) == 0
    assert seen == [ks.profile_dir("/usr/bin/google-chrome")]
    seen.clear()
    assert ks.main(["stop-chrome"]) == 0           # no browser known: both kiosk profiles
    assert set(seen) == {ks.profile_dir("/usr/bin/google-chrome"), ks.profile_dir("/snap/bin/chromium")}
    assert ks.main(["stop-chrome", "--browser"]) == 2


def test_helper_server_never_does_a_reverse_dns_lookup(ks, monkeypatch):
    # HTTPServer's own server_bind calls socket.getfqdn, which hangs offline.
    def boom(*a, **k):
        raise AssertionError("getfqdn called")
    monkeypatch.setattr(ks.socket, "getfqdn", boom)
    server = ks.HelperServer(ks.Session(TOKEN, "http://cloud.test"), port=0)
    try:
        assert server.server_port > 0
        assert server.host_header == f"127.0.0.1:{server.server_port}"
    finally:
        server.server_close()
