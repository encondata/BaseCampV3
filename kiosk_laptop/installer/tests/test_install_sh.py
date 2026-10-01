import pytest


def test_detect_os_sets_os_and_arch(sh):
    out = sh('detect_os; echo "$OS $ARCH"').stdout.split()
    assert out[0] in ("Darwin", "Linux") and out[1] in ("amd64", "arm64")


@pytest.mark.parametrize("os_name,install,data", [
    ("Linux", "/opt/serversherpa-kiosk", "/var/lib/serversherpa-kiosk"),
    ("Darwin", "/Library/Application Support/ServerSherpaKiosk",
     "/Users/Shared/ServerSherpaKiosk/data"),
])
def test_default_dirs(sh, os_name, install, data):
    out = sh(f'OS={os_name}; default_dirs; printf "%s\\n%s" "$KIOSK_DIR" "$KIOSK_DATA_DIR"').stdout
    assert out.splitlines() == [install, data]


def test_default_dirs_respects_overrides(sh):
    out = sh('OS=Linux; default_dirs; echo "$KIOSK_DIR|$KIOSK_DATA_DIR"',
             env={"KIOSK_DIR": "/x", "KIOSK_DATA_DIR": "/y"}).stdout.strip()
    assert out == "/x|/y"


@pytest.mark.parametrize("api,portal", [
    ("https://api.serversherpa.com", "https://portal.serversherpa.com"),
    ("https://api.dev.serversherpa.com/", "https://portal.dev.serversherpa.com"),
    ("http://10.0.0.5:8000", ""),
])
def test_derive_portal_url(sh, api, portal):
    assert sh(f'derive_portal_url "{api}"').stdout.strip() == portal


def test_config_round_trip_and_merge_precedence(sh, tmp_path):
    cfg = tmp_path / "config.env"
    sh(f'CFG_API_URL=https://api.a.com CFG_PORTAL_URL=https://portal.a.com CFG_CHANNEL=edge '
       f'CFG_DATA_DIR=/d; write_config "{cfg}"')
    text = cfg.read_text()
    assert "EDGE_CLOUD_API_URL=https://api.a.com\n" in text and "KIOSK_CHANNEL=edge\n" in text
    assert "KIOSK_BROWSER=\n" in text   # no browser found
    sh(f'CFG_API_URL=https://api.a.com CFG_PORTAL_URL= CFG_CHANNEL=edge CFG_DATA_DIR=/d '
       f'BROWSER_BIN="/Applications/Google Chrome.app"; write_config "{cfg}"')
    assert "KIOSK_BROWSER=/Applications/Google Chrome.app\n" in cfg.read_text()
    assert oct(cfg.stat().st_mode & 0o777) == "0o644"
    # re-run with no flags keeps saved values
    out = sh(f'load_config "{cfg}"; merge_config; echo "$CFG_API_URL $CFG_CHANNEL"').stdout.strip()
    assert out == "https://api.a.com edge"
    # a flag beats the saved value
    out = sh(f'load_config "{cfg}"; OPT_API_URL=https://api.b.com; merge_config; echo "$CFG_API_URL"').stdout.strip()
    assert out == "https://api.b.com"


def test_merge_defaults_and_rejects_bad_channel(sh, tmp_path):
    out = sh(f'load_config "{tmp_path}/none"; merge_config; echo "$CFG_API_URL $CFG_PORTAL_URL $CFG_CHANNEL"').stdout.split()
    assert out == ["https://api.serversherpa.com", "https://portal.serversherpa.com", "stable"]
    bad = sh(f'load_config "{tmp_path}/none"; OPT_CHANNEL=nightly; merge_config', check=False)
    assert bad.returncode != 0 and "channel" in bad.stderr.lower()


def test_write_config_rejects_unsafe_values(sh, tmp_path):
    bad = sh(f'CFG_API_URL=\'https://x.com/$(id)\' CFG_PORTAL_URL= CFG_CHANNEL=stable CFG_DATA_DIR=/d; '
             f'write_config "{tmp_path}/c.env"', check=False)
    assert bad.returncode != 0


def test_render_compose(sh, tmp_path):
    out = tmp_path / "docker-compose.yml"
    sh(f'CFG_CHANNEL=stable; KIOSK_DATA_DIR="/var/lib/serversherpa-kiosk"; render_compose "{out}"')
    text = out.read_text()
    assert "image: ghcr.io/encondata/serversherpa-kiosk-laptop:stable" in text
    assert '"/var/lib/serversherpa-kiosk:/data"' in text
    assert '"127.0.0.1:8090:8090"' in text and "restart: unless-stopped" in text
    out2 = tmp_path / "c2.yml"
    sh(f'CFG_CHANNEL=stable; KIOSK_DATA_DIR=/d; render_compose "{out2}"', env={"KIOSK_IMAGE": "local/kiosk:test"})
    assert "image: local/kiosk:test" in out2.read_text()


def test_migration_copies_legacy_identity_once(sh, tmp_path):
    legacy = tmp_path / "home" / "ServerSherpaKiosk"
    legacy.mkdir(parents=True)
    (legacy / "identity.json").write_text('{"serial":"kiosk-laptop-old"}')
    (legacy / "edge.db").write_text("db")
    data = tmp_path / "data"
    data.mkdir()
    out = sh(f'KIOSK_DATA_DIR="{data}"; DOCKER=(true); migrate_legacy_data').stdout
    assert (data / "identity.json").read_text() == '{"serial":"kiosk-laptop-old"}'
    assert (legacy / "identity.json").exists() and "left in place" in out
    # second run: data already has an identity -> untouched
    (legacy / "identity.json").write_text('{"serial":"other"}')
    sh(f'KIOSK_DATA_DIR="{data}"; DOCKER=(true); migrate_legacy_data')
    assert "kiosk-laptop-old" in (data / "identity.json").read_text()


def test_saved_data_dir_survives_rerun_but_env_wins(sh, tmp_path):
    cfg = tmp_path / "config.env"
    sh(f'CFG_API_URL=https://api.a.com CFG_PORTAL_URL=https://portal.a.com CFG_CHANNEL=stable '
       f'CFG_DATA_DIR=/custom; write_config "{cfg}"')
    body = f'OS=Linux; default_dirs; load_config "{cfg}"; merge_config; echo "$KIOSK_DATA_DIR $CFG_DATA_DIR"'
    assert sh(body).stdout.split() == ["/custom", "/custom"]
    assert sh(body, env={"KIOSK_DATA_DIR": "/fromenv"}).stdout.split() == ["/fromenv", "/fromenv"]
    out = sh(f'OS=Linux; default_dirs; load_config "{tmp_path}/none"; merge_config; echo "$KIOSK_DATA_DIR"').stdout.strip()
    assert out == "/var/lib/serversherpa-kiosk"


def test_migration_never_overwrites_nonempty_data_dir(sh, tmp_path):
    legacy = tmp_path / "home" / "ServerSherpaKiosk"
    legacy.mkdir(parents=True)
    (legacy / "identity.json").write_text("{}")
    data = tmp_path / "data"
    data.mkdir()
    (data / "edge.db").write_text("mine")
    out = sh(f'KIOSK_DATA_DIR="{data}"; DOCKER=(true); migrate_legacy_data').stdout
    assert (data / "edge.db").read_text() == "mine" and not (data / "identity.json").exists()
    assert "Keeping" in out


def test_portal_rederived_only_when_api_changes(sh, tmp_path):
    cfg = tmp_path / "config.env"
    sh(f'CFG_API_URL=https://api.a.com CFG_PORTAL_URL=https://custom.a.com CFG_CHANNEL=stable '
       f'CFG_DATA_DIR=/d; write_config "{cfg}"')
    same = sh(f'load_config "{cfg}"; OPT_API_URL=https://api.a.com//; merge_config; echo "$CFG_PORTAL_URL"').stdout.strip()
    assert same == "https://custom.a.com"
    chg = sh(f'load_config "{cfg}"; OPT_API_URL=https://api.b.com; merge_config; echo "$CFG_PORTAL_URL"').stdout.strip()
    assert chg == "https://portal.b.com"
    odd = sh(f'load_config "{cfg}"; OPT_API_URL=http://10.0.0.5:8000; merge_config; echo "[$CFG_PORTAL_URL]"')
    assert odd.stdout.strip() == "[]" and "--portal-url" in odd.stderr


@pytest.mark.parametrize("bad", ["/a:b", "C\\x"])
def test_data_dir_rejects_backslash_and_colon(sh, tmp_path, bad):
    r = sh(f"CFG_API_URL=https://api.a.com CFG_PORTAL_URL= CFG_CHANNEL=stable CFG_DATA_DIR='{bad}'; "
           f'write_config "{tmp_path}/c.env"', check=False)
    assert r.returncode != 0


def test_usage_works_without_script_path(sh):
    out = sh('usage').stdout
    assert "--api-url" in out and "--purge-data" in out


def test_shellcheck_clean():
    import shutil
    import subprocess
    from conftest import INSTALL_SH
    sc = shutil.which("shellcheck") or ("/opt/homebrew/bin/shellcheck" if shutil.os.path.exists("/opt/homebrew/bin/shellcheck") else None)
    if sc is None:
        pytest.skip("shellcheck not installed")
    for script in (INSTALL_SH, INSTALL_SH.parent / "update.sh", INSTALL_SH.parent / "launch.sh"):
        r = subprocess.run([sc, "-s", "bash", str(script)], capture_output=True, text=True)
        assert r.returncode == 0, (script.name, r.stdout)


# ── Task 3: preflight, Docker, start, uninstall ───────────────────────

def test_preflight_rejects_old_macos(sh):
    r = sh('OS=Darwin; OS_VERSION=12.7; check_minimums', check=False)
    assert r.returncode != 0 and "macOS 13" in r.stderr


def test_preflight_accepts_supported_versions(sh):
    sh('OS=Darwin; OS_VERSION=13.0; check_minimums')
    sh('OS=Darwin; OS_VERSION=15.6.1; check_minimums')
    sh('OS=Linux; HAS_SYSTEMD=1; check_minimums')


def test_preflight_requires_systemd_on_linux(sh, tmp_path):
    r = sh('OS=Linux; HAS_SYSTEMD=0; check_minimums', check=False)
    assert r.returncode != 0 and "systemd" in r.stderr


def test_find_browser_prefers_chrome(sh, tmp_path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    for name in ("google-chrome", "microsoft-edge"):
        p = bindir / name; p.write_text("#!/bin/sh\n"); p.chmod(0o755)
    out = sh(f'OS=Linux; PATH="{bindir}:$PATH"; find_browser; echo "$BROWSER_BIN"').stdout.strip()
    assert out.endswith("google-chrome")


def test_find_browser_warns_when_none(sh, tmp_path):
    empty = tmp_path / "empty"; empty.mkdir()
    r = sh(f'OS=Linux; PATH="{empty}"; find_browser; echo "[$BROWSER_BIN]"')
    assert r.stdout.strip() == "[]" and "chrome" in r.stderr.lower()


def test_start_kiosk_waits_for_healthy(sh, tmp_path):
    # fake docker: compose pull/up succeed; inspect says starting twice then healthy
    fake = tmp_path / "docker"
    fake.write_text('#!/bin/sh\n'
                    'case "$1" in\n'
                    '  inspect) n=$(cat "$0.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0.n";\n'
                    '           [ $n -ge 3 ] && echo healthy || echo starting ;;\n'
                    '  *) exit 0 ;;\n'
                    'esac\n')
    fake.chmod(0o755)
    r = sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; HEALTH_POLL_S=0; '
           f'identity_check() {{ echo ok; }}; start_kiosk; echo done')
    assert "done" in r.stdout


def test_start_kiosk_times_out(sh, tmp_path):
    fake = tmp_path / "docker"
    fake.write_text('#!/bin/sh\n[ "$1" = inspect ] && echo unhealthy\nexit 0\n')
    fake.chmod(0o755)
    r = sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; HEALTH_POLL_S=0; HEALTH_TIMEOUT_S=0; start_kiosk',
           check=False)
    assert r.returncode != 0 and "healthy" in r.stderr.lower()


def test_start_kiosk_stops_phase1_project_first(sh, tmp_path):
    log = tmp_path / "calls"
    fake = tmp_path / "docker"
    fake.write_text(f'#!/bin/sh\necho "$*" >> "{log}"\n[ "$1" = inspect ] && echo healthy\nexit 0\n')
    fake.chmod(0o755)
    sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; HEALTH_POLL_S=0; '
       f'identity_check() {{ echo ok; }}; start_kiosk')
    calls = log.read_text().splitlines()
    assert calls[0] == "compose -p serversherpa-kiosk-laptop stop"
    assert any(c.endswith(" pull") for c in calls) and any(c.endswith(" up -d") for c in calls)


def test_uninstall_keeps_data_without_purge(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (data / "identity.json").write_text("{}")
    for f in ("docker-compose.yml", "config.env", "update.sh", "launch.sh"):
        (inst / f).write_text("x")
    (inst / "install.log").write_text("log")
    r = sh(f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; '
           f'remove_login_items() {{ :; }}; uninstall')
    assert (data / "identity.json").exists() and not (inst / "config.env").exists()
    assert (inst / "install.log").exists()
    assert "identity" in r.stdout.lower()


def test_uninstall_purge_needs_typed_delete(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (data / "identity.json").write_text("{}")
    base = (f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; PURGE_DATA=1; '
            f'remove_login_items() {{ :; }}; uninstall')
    r = sh(base, check=False)                                   # non-interactive, no confirm
    assert r.returncode != 0 and data.exists()
    r = sh(base, env={"KIOSK_CONFIRM_PURGE": "delete"}, check=False)   # wrong word
    assert r.returncode != 0 and data.exists()
    sh(base, env={"KIOSK_CONFIRM_PURGE": "DELETE"})
    assert not data.exists()


def test_uninstall_purge_asks_on_tty(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (data / "edge.db").write_text("db")
    tty = tmp_path / "tty"; tty.write_text("DELETE\n")
    sh(f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; PURGE_DATA=1; '
       f'remove_login_items() {{ :; }}; uninstall',
       env={"KIOSK_NONINTERACTIVE": "0", "KIOSK_TTY": str(tty)})
    assert not data.exists()


# rm is stubbed in these so a broken guard can never delete anything real.
@pytest.mark.parametrize("data_dir", ["/", "", "/opt", "/opt/", "relative/dir", "/opt/../"])
def test_uninstall_refuses_unsafe_data_dir(sh, tmp_path, data_dir):
    inst = tmp_path / "inst"; inst.mkdir()
    rmlog = tmp_path / "rm.log"
    r = sh(f'rm() {{ echo "rm $*" >> "{rmlog}"; }}; DOCKER=(true); KIOSK_DIR="{inst}"; '
           f'KIOSK_DATA_DIR="{data_dir}"; PURGE_DATA=1; remove_login_items() {{ :; }}; uninstall',
           env={"KIOSK_CONFIRM_PURGE": "DELETE"}, check=False)
    assert r.returncode != 0
    assert "-rf" not in (rmlog.read_text() if rmlog.exists() else "")


@pytest.mark.parametrize("kiosk_dir", ["/", ""])
def test_uninstall_refuses_unsafe_install_dir(sh, tmp_path, kiosk_dir):
    data = tmp_path / "data"; data.mkdir()
    rmlog = tmp_path / "rm.log"
    r = sh(f'rm() {{ echo "rm $*" >> "{rmlog}"; }}; DOCKER=(true); KIOSK_DIR="{kiosk_dir}"; '
           f'KIOSK_DATA_DIR="{data}"; remove_login_items() {{ :; }}; uninstall', check=False)
    assert r.returncode != 0 and not rmlog.exists()


def test_uninstall_purge_refuses_folder_that_is_not_kiosk_data(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "notkiosk"
    inst.mkdir(); data.mkdir(); (data / "taxes.pdf").write_text("x")
    r = sh(f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; PURGE_DATA=1; '
           f'remove_login_items() {{ :; }}; uninstall',
           env={"KIOSK_CONFIRM_PURGE": "DELETE"}, check=False)
    assert r.returncode != 0 and (data / "taxes.pdf").exists()


def test_docker_autostart_keeps_other_keys(sh, tmp_path):
    import json
    f = tmp_path / "settings-store.json"
    f.write_text('{"AutoStart": false, "MemoryMiB": 4096, "FilesharingDirectories": ["/Users"]}')
    sh(f'set_docker_autostart "{f}"')
    d = json.loads(f.read_text())
    assert d == {"AutoStart": True, "MemoryMiB": 4096, "FilesharingDirectories": ["/Users"]}


def test_docker_autostart_creates_missing_file_without_python(sh, tmp_path):
    import json
    f = tmp_path / "gc" / "settings-store.json"
    sh(f'python_bin() {{ return 1; }}; set_docker_autostart "{f}"')
    assert json.loads(f.read_text()) == {"AutoStart": True}
    # an existing file is never rewritten without python
    f.write_text('{"AutoStart": false, "Keep": 1}')
    r = sh(f'python_bin() {{ return 1; }}; set_docker_autostart "{f}"')
    assert f.read_text() == '{"AutoStart": false, "Keep": 1}' and "Start Docker Desktop" in r.stderr


def test_wait_for_engine_times_out(sh):
    r = sh('DOCKER=(false); ENGINE_POLL_S=0; wait_for_engine 0', check=False)
    assert r.returncode != 0 and "re-run" in r.stderr


def test_summary_shows_serial_and_url(sh):
    out = sh('OS=Linux; CFG_CHANNEL=stable; KIOSK_DIR=/opt/k; '
             'KIOSK_IDENTITY=\'{"serial":"kiosk-laptop-abc","name":"Dock 1"}\'; '
             'kiosk_version() { echo 1.2.3; }; summary').stdout
    assert "kiosk-laptop-abc" in out and "Dock 1" in out and "http://localhost:8090" in out
    assert "1.2.3" in out and "stable" in out


# ── Task 3 fix round 1 ────────────────────────────────────────────────

def test_macos_runs_docker_as_desktop_user(sh):
    out = sh('OS=Darwin; desktop_user() { printf alice; }; setup_docker_cli; '
             'printf "%s\\n" "${DOCKER[@]}"').stdout.splitlines()
    assert out[:4] == ["sudo", "-u", "alice", "-H"] and out[-1] == "docker"
    assert any(a.startswith("PATH=") and "/Applications/Docker.app/Contents/Resources/bin" in a for a in out)
    assert sh('OS=Linux; setup_docker_cli; echo "${DOCKER[*]}"').stdout.strip() == "docker"


def test_macos_without_desktop_user_stops(sh):
    r = sh('OS=Darwin; desktop_user() { :; }; setup_docker_cli', check=False)
    assert r.returncode != 0 and "signed-in user" in r.stderr


def test_check_compose_dies_without_plugin(sh):
    r = sh('OS=Linux; DOCKER=(false); check_compose', check=False)
    assert r.returncode != 0 and "Compose" in r.stderr
    sh('OS=Linux; DOCKER=(true); check_compose')


def _uninstall_with_docker(sh, tmp_path, script):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (data / "identity.json").write_text("{}")
    for f in ("docker-compose.yml", "config.env"):
        (inst / f).write_text("x")
    fake = tmp_path / "docker"; fake.write_text("#!/bin/sh\n" + script); fake.chmod(0o755)
    r = sh(f'DOCKER=("{fake}"); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; '
           f'remove_login_items() {{ echo REMOVED-LOGIN-ITEMS; }}; uninstall', check=False)
    return r, inst


def test_uninstall_stops_when_docker_is_down(sh, tmp_path):
    # compose down fails and the engine doesn't answer: nothing may be removed
    r, inst = _uninstall_with_docker(sh, tmp_path, "exit 1\n")
    assert r.returncode != 0 and "Docker isn't running" in r.stderr
    assert (inst / "config.env").exists()


def test_uninstall_stops_when_container_still_exists(sh, tmp_path):
    r, inst = _uninstall_with_docker(
        sh, tmp_path, 'case "$1" in compose) exit 1 ;; *) exit 0 ;; esac\n')
    assert r.returncode != 0 and "serversherpa-kiosk-edge-1" in r.stderr
    assert (inst / "config.env").exists()


def test_uninstall_continues_when_container_is_gone(sh, tmp_path):
    r, inst = _uninstall_with_docker(
        sh, tmp_path, 'case "$1" in compose|inspect) exit 1 ;; *) exit 0 ;; esac\n')
    assert r.returncode == 0, r.stderr
    assert not (inst / "config.env").exists() and "REMOVED-LOGIN-ITEMS" in r.stdout


def test_rosetta_reports_arm64(sh):
    stubs = ('uname() { case "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac; }; '
             'sw_vers() { echo 14.5; }; ')
    out = sh(stubs + 'sysctl() { echo 1; }; detect_os; echo "$ARCH"').stdout.strip()
    assert out == "arm64"
    out = sh(stubs + 'sysctl() { return 1; }; detect_os; echo "$ARCH"').stdout.strip()
    assert out == "amd64"


def test_ensure_root_forwards_args_and_env(sh, tmp_path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    shim = bindir / "sudo"
    shim.write_text('#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n'); shim.chmod(0o755)
    env = {"KIOSK_IMAGE": "local/kiosk:test", "KIOSK_INSTALLER_REF": "feature-x",
           "KIOSK_TEMPLATE_DIR": str(tmp_path / "tpl")}
    (tmp_path / "tpl").mkdir()
    r = sh(f'PATH="{bindir}:$PATH"; is_root() {{ return 1; }}; '
           f'ensure_root --api-url https://api.x.com --yes; echo NOT-REACHED', env=env)
    args = [l[4:] for l in r.stdout.splitlines() if l.startswith("ARG:")]
    assert args[0] == "env" and "NOT-REACHED" not in r.stdout
    for kv in ("KIOSK_IMAGE=local/kiosk:test", "KIOSK_INSTALLER_REF=feature-x",
               f"KIOSK_TEMPLATE_DIR={tmp_path / 'tpl'}"):
        assert kv in args
    i = args.index("bash")
    assert args[i + 1].endswith("install.sh")
    assert args[i + 2:] == ["--api-url", "https://api.x.com", "--yes"]


def test_ensure_root_downloads_copy_and_says_main(sh, tmp_path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    shim = bindir / "sudo"
    shim.write_text('#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n'); shim.chmod(0o755)
    r = sh(f'PATH="{bindir}:$PATH"; is_root() {{ return 1; }}; self_script() {{ :; }}; '
           f'ensure_root --yes')
    assert "main branch" in r.stdout
    args = [l[4:] for l in r.stdout.splitlines() if l.startswith("ARG:")]
    copy = args[args.index("bash") + 1]
    assert "kiosk-install." in copy and not copy.endswith("/install.sh")


def test_docker_autostart_python_cleans_temp_on_failure(sh, tmp_path):
    # os.replace fails after the temp file is written; the temp must not be left.
    # A directory at the destination can't be read as JSON (open() fails before
    # any write), so os.replace is made to fail the way it does for a directory.
    site = tmp_path / "site"; site.mkdir()
    marker = tmp_path / "tmp-was-written"
    (site / "sitecustomize.py").write_text(
        "import os\n"
        "def _replace(src, dst):\n"
        f"    if os.path.exists(src): open({str(marker)!r}, 'w').close()\n"
        "    raise IsADirectoryError(21, 'Is a directory', dst)\n"
        "os.replace = _replace\n")
    f = tmp_path / "settings-store.json"; f.write_text('{"Keep": 1}')
    r = sh(f'set_docker_autostart "{f}"', env={"PYTHONPATH": str(site)})
    assert marker.exists(), "the temp file should have been written before os.replace"
    assert f.read_text() == '{"Keep": 1}' and "Start Docker Desktop" in r.stderr
    assert not (tmp_path / "settings-store.json.kiosk-tmp").exists()


# ── Task 4: login items, update and launch scripts ────────────────────
import plistlib


def test_render_systemd_units(sh, tmp_path):
    sh(f'KIOSK_DIR=/opt/serversherpa-kiosk; render_systemd_units "{tmp_path}"')
    svc = (tmp_path / "serversherpa-kiosk-update.service").read_text()
    tmr = (tmp_path / "serversherpa-kiosk-update.timer").read_text()
    assert "ExecStart=/opt/serversherpa-kiosk/update.sh" in svc and "Type=oneshot" in svc
    assert "OnCalendar=*-*-* 03:00:00" in tmr and "Persistent=true" in tmr
    assert "TimeoutStartSec=30min" in svc


def test_render_launch_agents(sh, tmp_path):
    upd, lch = tmp_path / "u.plist", tmp_path / "l.plist"
    sh(f'render_launch_agent com.serversherpa.kiosk.update "{upd}" calendar /k/update.sh; '
       f'render_launch_agent com.serversherpa.kiosk.launch "{lch}" runatload /k/launch.sh')
    u = plistlib.loads(upd.read_bytes()); l = plistlib.loads(lch.read_bytes())
    assert u["Label"] == "com.serversherpa.kiosk.update"
    assert u["StartCalendarInterval"] == {"Hour": 3, "Minute": 0}
    assert u["ProgramArguments"] == ["/k/update.sh"]
    assert l["RunAtLoad"] is True and l["ProgramArguments"] == ["/k/launch.sh"]


def test_render_launch_agent_escapes_xml(sh, tmp_path):
    f = tmp_path / "a.plist"
    sh(f'render_launch_agent x "{f}" runatload "/Library/A & B <x>/launch.sh"')
    assert plistlib.loads(f.read_bytes())["ProgramArguments"] == ["/Library/A & B <x>/launch.sh"]


def test_render_desktop_entry(sh, tmp_path):
    f = tmp_path / "serversherpa-kiosk.desktop"
    sh(f'KIOSK_DIR=/opt/serversherpa-kiosk; render_desktop_entry "{f}"')
    t = f.read_text()
    assert "Name=ServerSherpa Kiosk" in t and "Exec=/opt/serversherpa-kiosk/launch.sh" in t
    assert "Type=Application" in t


def test_render_app_bundle(sh, tmp_path):
    app = tmp_path / "ServerSherpa Kiosk.app"
    sh(f'KIOSK_DIR="/Library/Application Support/ServerSherpaKiosk"; render_app_bundle "{app}"')
    info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    assert info["CFBundleName"] == "ServerSherpa Kiosk"
    assert info["CFBundleExecutable"] == "ServerSherpa Kiosk"
    assert info["CFBundleIdentifier"] == "com.serversherpa.kiosk"
    exe = app / "Contents" / "MacOS" / "ServerSherpa Kiosk"
    assert exe.stat().st_mode & 0o111
    assert 'exec "/Library/Application Support/ServerSherpaKiosk/launch.sh"' in exe.read_text()


def _login_env(tmp_path):
    inst = tmp_path / "inst"; inst.mkdir()
    home = tmp_path / "uhome"; home.mkdir()
    calls = tmp_path / "calls"
    stubs = (f'KIOSK_DIR="{inst}"; desktop_user() {{ printf alice; }}; '
             f'user_home() {{ printf "%s" "{home}"; }}; as_user() {{ shift; "$@"; }}; '
             f'id() {{ echo 501; }}; chown() {{ echo "chown $*" >> "{calls}"; }}; '
             f'systemctl() {{ echo "systemctl $*" >> "{calls}"; }}; '
             f'launchctl() {{ echo "launchctl $*" >> "{calls}"; }}; '
             f'SYSTEMD_UNIT_DIR="{tmp_path / "units"}"; MAC_APP_DIR="{tmp_path / "ServerSherpa Kiosk.app"}"; ')
    (tmp_path / "units").mkdir()
    return inst, home, calls, stubs


def test_install_login_items_linux(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Linux; install_login_items')
    for f in ("update.sh", "launch.sh"):
        assert (inst / f).stat().st_mode & 0o777 == 0o755
    assert (tmp_path / "units" / "serversherpa-kiosk-update.timer").exists()
    svc = (tmp_path / "units" / "serversherpa-kiosk-update.service").read_text()
    assert f"ExecStart={inst}/update.sh" in svc
    log = calls.read_text().splitlines()
    assert "systemctl daemon-reload" in log
    assert "systemctl enable --now serversherpa-kiosk-update.timer" in log
    for d in (".config/autostart", ".local/share/applications"):
        t = (home / d / "serversherpa-kiosk.desktop").read_text()
        assert f"Exec={inst}/launch.sh" in t


def test_install_login_items_macos(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Darwin; install_login_items')
    agents = home / "Library" / "LaunchAgents"
    u = plistlib.loads((agents / "com.serversherpa.kiosk.update.plist").read_bytes())
    l = plistlib.loads((agents / "com.serversherpa.kiosk.launch.plist").read_bytes())
    assert u["ProgramArguments"] == [f"{inst}/update.sh"] and u["StartCalendarInterval"] == {"Hour": 3, "Minute": 0}
    assert l["ProgramArguments"] == [f"{inst}/launch.sh"] and l["RunAtLoad"] is True
    log = calls.read_text().splitlines()
    for label in ("update", "launch"):
        assert f"launchctl bootstrap gui/501 {agents}/com.serversherpa.kiosk.{label}.plist" in log
    # the update job runs as alice: its log and state files are hers
    for f in ("update.log", "update-state.json"):
        assert (inst / f).stat().st_mode & 0o777 == 0o644
        assert f"chown alice {inst}/{f}" in log
    assert (tmp_path / "ServerSherpa Kiosk.app" / "Contents" / "Info.plist").exists()


def test_install_login_items_macos_reload_boots_out_first(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Darwin; install_login_items')
    log = calls.read_text().splitlines()
    i_out = log.index("launchctl bootout gui/501/com.serversherpa.kiosk.update")
    i_in = next(i for i, l in enumerate(log) if l.startswith("launchctl bootstrap") and "update" in l)
    assert i_out < i_in


def test_remove_login_items_linux(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Linux; install_login_items; remove_login_items; remove_login_items')
    assert not list((tmp_path / "units").iterdir())
    assert not (home / ".config/autostart/serversherpa-kiosk.desktop").exists()
    assert not (home / ".local/share/applications/serversherpa-kiosk.desktop").exists()
    assert "systemctl disable --now serversherpa-kiosk-update.timer" in calls.read_text()


def test_remove_login_items_macos(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Darwin; install_login_items; remove_login_items; remove_login_items')
    assert not list((home / "Library" / "LaunchAgents").iterdir())
    assert not (tmp_path / "ServerSherpa Kiosk.app").exists()
    assert "launchctl bootout gui/501/com.serversherpa.kiosk.launch" in calls.read_text()


def test_login_items_without_desktop_user_still_schedules_update_on_linux(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    r = sh(stubs + 'desktop_user() { :; }; OS=Linux; install_login_items')
    assert "systemctl enable --now serversherpa-kiosk-update.timer" in calls.read_text()
    assert not (home / ".config").exists() and "sign-in" in r.stderr


# ── Task 3 review leftovers ───────────────────────────────────────────

def test_uninstall_continues_when_docker_cli_is_gone(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir()
    (inst / "docker-compose.yml").write_text("x"); (inst / "config.env").write_text("x")
    r = sh(f'OS=Linux; DOCKER=("{tmp_path}/no-such-docker"); KIOSK_DIR="{inst}"; '
           f'KIOSK_DATA_DIR="{data}"; remove_login_items() {{ :; }}; uninstall')
    assert not (inst / "config.env").exists() and "Docker isn't installed" in r.stderr


def test_uninstall_continues_when_docker_desktop_is_gone(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir()
    (inst / "docker-compose.yml").write_text("x"); (inst / "config.env").write_text("x")
    r = sh(f'OS=Darwin; DOCKER=(false); DOCKER_APP="{tmp_path}/Docker.app"; KIOSK_DIR="{inst}"; '
           f'KIOSK_DATA_DIR="{data}"; remove_login_items() {{ :; }}; uninstall')
    assert not (inst / "config.env").exists() and "Docker isn't installed" in r.stderr


def test_docker_down_message_per_os(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (inst / "docker-compose.yml").write_text("x")
    app = tmp_path / "Docker.app"; app.mkdir()
    base = (f'DOCKER=(false); DOCKER_APP="{app}"; KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; '
            f'remove_login_items() {{ :; }}; uninstall')
    lin = sh('OS=Linux; ' + base.replace("DOCKER=(false)", f'DOCKER=("{shutil_which_false()}")'), check=False)
    assert lin.returncode != 0 and "sudo systemctl start docker" in lin.stderr
    assert "Docker Desktop" not in lin.stderr
    mac = sh('OS=Darwin; ' + base, check=False)
    assert mac.returncode != 0 and "start Docker Desktop" in mac.stderr


def shutil_which_false():
    import shutil
    return shutil.which("false")


@pytest.mark.parametrize("has_compose", [False, True])
def test_uninstall_sets_up_docker_only_with_compose_file(sh, tmp_path, has_compose):
    inst = tmp_path / "inst"
    if has_compose:
        inst.mkdir(); (inst / "docker-compose.yml").write_text("x")
    r = sh('is_root() { return 0; }; setup_docker_cli() { echo SETUP-DOCKER; }; '
           'uninstall() { echo UNINSTALL; }; main --uninstall',
           env={"KIOSK_DIR": str(inst), "KIOSK_DATA_DIR": str(tmp_path / "data")})
    assert "UNINSTALL" in r.stdout
    assert ("SETUP-DOCKER" in r.stdout) == has_compose


def test_render_compose_is_mode_644(sh, tmp_path):
    out = tmp_path / "docker-compose.yml"
    sh(f'umask 077; CFG_CHANNEL=stable; KIOSK_DATA_DIR=/d; render_compose "{out}"')
    assert out.stat().st_mode & 0o777 == 0o644



# ── Task 4 fix round 1 ────────────────────────────────────────────────

def test_uninstall_removes_update_job_before_stopping_kiosk(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (inst / "docker-compose.yml").write_text("x")
    r = sh(f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; '
           f'remove_login_items() {{ echo REMOVE-LOGIN-ITEMS; }}; '
           f'stop_kiosk_for_uninstall() {{ echo STOP-KIOSK; }}; uninstall')
    out = r.stdout.splitlines()
    assert out.index("REMOVE-LOGIN-ITEMS") < out.index("STOP-KIOSK")


def test_remove_login_items_linux_without_user_warns(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    r = sh(stubs + 'desktop_user() { :; }; OS=Linux; remove_login_items')
    assert "serversherpa-kiosk.desktop" in r.stderr and "systemctl disable" in calls.read_text()
