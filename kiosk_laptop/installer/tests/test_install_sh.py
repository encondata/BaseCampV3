import os

import pytest

from conftest import INSTALL_SH as _INSTALL_SH

INSTALL_SH_DIR = _INSTALL_SH.parent


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
    assert '"0.0.0.0:8090:8090"' in text and '"0.0.0.0:8091:8091"' in text
    assert "127.0.0.1" not in text and "restart: unless-stopped" in text
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
    for script in (INSTALL_SH, INSTALL_SH.parent / "update.sh", INSTALL_SH.parent / "launch.sh",
                   INSTALL_SH.parent / "hostnet.sh", INSTALL_SH.parent / "tests" / "test_linux_e2e.sh"):
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


def test_start_kiosk_stops_phase1_container_by_label_first(sh, tmp_path):
    log = tmp_path / "calls"
    fake = tmp_path / "docker"
    fake.write_text(f'#!/bin/sh\necho "$*" >> "{log}"\n'
                    'case "$1" in ps) echo abc123; echo def456 ;; inspect) echo healthy ;; esac\nexit 0\n')
    fake.chmod(0o755)
    sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; HEALTH_POLL_S=0; '
       f'identity_check() {{ echo ok; }}; start_kiosk')
    calls = log.read_text().splitlines()
    assert calls[0] == "ps -a -q --filter label=com.docker.compose.project=serversherpa-kiosk-laptop"
    assert calls[1] == "stop abc123 def456"
    assert not any(c.startswith("compose -p") for c in calls)
    assert any(c.endswith(" pull") for c in calls) and any(c.endswith(" up -d") for c in calls)


def test_uninstall_keeps_data_without_purge(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (data / "identity.json").write_text("{}")
    for f in ("docker-compose.yml", "config.env", "update.sh", "launch.sh", "hostnet.sh"):
        (inst / f).write_text("x")
    (inst / "install.log").write_text("log")
    r = sh(f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; '
           f'remove_login_items() {{ :; }}; uninstall')
    assert (data / "identity.json").exists() and not (inst / "config.env").exists()
    assert not (inst / "hostnet.sh").exists()
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
    assert "re-running the installer puts them back" in r.stderr
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
    (tmp_path / "data").mkdir()
    home = tmp_path / "uhome"; home.mkdir()
    calls = tmp_path / "calls"
    stubs = (f'KIOSK_DIR="{inst}"; desktop_user() {{ printf alice; }}; '
             f'user_home() {{ printf "%s" "{home}"; }}; as_user() {{ shift; "$@"; }}; '
             f'id() {{ echo 501; }}; chown() {{ echo "chown $*" >> "{calls}"; }}; '
             f'systemctl() {{ echo "systemctl $*" >> "{calls}"; }}; '
             f'launchctl() {{ echo "launchctl $*" >> "{calls}"; }}; '
             f'SYSTEMD_UNIT_DIR="{tmp_path / "units"}"; MAC_APP_DIR="{tmp_path / "ServerSherpa Kiosk.app"}"; '
             f'KIOSK_DATA_DIR="{tmp_path / "data"}"; HOSTNET_POLL_S=0; ')
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


def test_install_login_items_macos_chowns_only_the_two_helpers(sh, tmp_path):
    # hostnet.sh and launch.sh run as the desktop user, so the nightly update can
    # refresh them in place; the folder and every other file stay root's.
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Darwin; install_login_items')
    chowns = [l for l in calls.read_text().splitlines() if l.startswith("chown ")]
    assert f"chown alice {inst}/hostnet.sh" in chowns and f"chown alice {inst}/launch.sh" in chowns
    owned = {l.split(" ", 2)[2] for l in chowns}
    assert f"{inst}/update.sh" not in owned and str(inst) not in owned
    assert f"{inst}/docker-compose.yml" not in owned and f"{inst}/config.env" not in owned


def test_install_login_items_linux_chowns_nothing_to_the_user(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Linux; install_login_items')
    assert f"chown alice {inst}/hostnet.sh" not in calls.read_text()


@pytest.mark.parametrize("ref,expect", [
    ("feature-x", "feature-x"), ("release/1.2_a", "release/1.2_a"),
    ("a..b", "main"), ("../x", "main"), ("x y", "main"), ("x;rm", "main"), ("x$(id)", "main"), ("", "main"),
])
def test_safe_ref(sh, ref, expect):
    r = sh('safe_ref "$REF_IN"', env={"REF_IN": ref})
    assert r.stdout == expect


def test_unsafe_ref_is_not_used_in_the_download_url_or_config(sh, tmp_path):
    cfg = tmp_path / "config.env"
    base = 'CFG_API_URL=https://api.x.test; CFG_PORTAL_URL=https://portal.x.test; CFG_CHANNEL=stable; CFG_DATA_DIR=/d; BROWSER_BIN=""'
    r = sh(f'{base}; write_config "{cfg}"; echo "$BASE_URL"', env={"KIOSK_INSTALLER_REF": "../evil"})
    assert "KIOSK_INSTALLER_REF=main\n" in cfg.read_text()
    assert "evil" not in cfg.read_text() and "/main/kiosk_laptop/installer" in r.stdout


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
    assert "systemctl stop serversherpa-kiosk-update.service" in calls.read_text()


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



# ── Task 4 fix round 2 ────────────────────────────────────────────────

def test_dockerfile_runtime_stage_has_source_label():
    from conftest import INSTALL_SH
    text = (INSTALL_SH.parents[1] / "Dockerfile").read_text()
    runtime = text[text.rindex("\nFROM "):]
    assert "LABEL org.opencontainers.image.source=https://github.com/encondata/BaseCampV3\n" in runtime


# ── final fix round ──────────────────────────────────────────────────

def test_uninstall_reads_only_the_data_folder(sh, tmp_path):
    # a damaged channel in config.env must not block uninstall
    inst = tmp_path / "inst"; inst.mkdir()
    (inst / "config.env").write_text("KIOSK_CHANNEL=nightly\nEDGE_CLOUD_API_URL=ftp://x\n"
                                     "KIOSK_DATA_DIR=/custom/kioskdata\n")
    r = sh('is_root() { return 0; }; uninstall() { echo "UNINSTALL $KIOSK_DATA_DIR"; }; main --uninstall',
           env={"KIOSK_DIR": str(inst)})
    assert "UNINSTALL /custom/kioskdata" in r.stdout


def test_uninstall_data_dir_env_then_saved_then_default(sh, tmp_path):
    cfg = tmp_path / "config.env"; cfg.write_text("KIOSK_DATA_DIR=/saved\n")
    body = f'OS=Linux; default_dirs; load_config "{cfg}"; uninstall_data_dir'
    assert sh(body).stdout == "/saved"
    assert sh(body, env={"KIOSK_DATA_DIR": "/fromenv"}).stdout == "/fromenv"
    none = f'OS=Linux; default_dirs; load_config "{tmp_path}/none"; uninstall_data_dir'
    assert sh(none).stdout == "/var/lib/serversherpa-kiosk"


def test_uninstall_says_both_logs_were_kept(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir()
    r = sh(f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; '
           f'remove_login_items() {{ :; }}; uninstall')
    assert "install.log and update.log were kept" in r.stdout


@pytest.mark.parametrize("flag,value", [("OPT_API_URL", "api.serversherpa.com"),
                                        ("OPT_API_URL", "ftp://api.x.com"),
                                        ("OPT_PORTAL_URL", "portal.x.com")])
def test_merge_rejects_urls_without_http_scheme(sh, tmp_path, flag, value):
    r = sh(f'load_config "{tmp_path}/none"; {flag}="{value}"; merge_config', check=False)
    assert r.returncode != 0 and "must start with http:// or https://" in r.stderr


def test_merge_accepts_http_and_https(sh, tmp_path):
    out = sh(f'load_config "{tmp_path}/none"; OPT_API_URL=http://10.0.0.5:8000; '
             f'OPT_PORTAL_URL=https://p.x.com; merge_config; echo "$CFG_API_URL $CFG_PORTAL_URL"').stdout
    assert out.split() == ["http://10.0.0.5:8000", "https://p.x.com"]


def test_derive_portal_url_is_case_sensitive(sh):
    # agrees with Get-PortalUrl (-cmatch)
    assert sh('derive_portal_url "https://API.serversherpa.com"').stdout == ""



# Fake docker for start_kiosk and the phase-1 migration: answers by call, logs
# every call to docker.log, health answers in turn (the last one repeats).
def _kiosk_docker(tmp_path, running="sha256:old", pulled="sha256:new", health=("healthy",),
                  ps="", mount="", pull_error=None, previous_tag=""):
    fake = tmp_path / "docker"
    (tmp_path / "docker.health").write_text("\n".join(health) + "\n")
    pull = f'echo "{pull_error}" >&2; exit 1' if pull_error else 'echo pulled'
    fake.write_text(
        '#!/bin/sh\n'
        'echo "$*" >> "$0.log"\n'
        'case "$*" in\n'
        f'  "ps -a -q"*) [ -z "{ps}" ] || echo "{ps}" ;;\n'
        f'  "inspect -f {{{{range"*) echo "{mount}" ;;\n'
        f'  "inspect -f {{{{.Image}}}}"*) [ -n "{running}" ] || exit 1; echo "{running}" ;;\n'
        f'  "image inspect -f {{{{.Id}}}} serversherpa-kiosk-laptop:previous") [ -n "{previous_tag}" ] || exit 1; echo "{previous_tag}" ;;\n'
        f'  "image inspect"*) echo "{pulled}" ;;\n'
        '  "inspect -f {{.State.Health.Status}}"*)\n'
        '     n=$(cat "$0.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0.n"\n'
        '     line=$(sed -n "${n}p" "$0.health"); [ -n "$line" ] || line=$(tail -n 1 "$0.health")\n'
        '     echo "$line" ;;\n'
        f'  *" pull") {pull} ;;\n'
        'esac\n'
        'exit 0\n')
    fake.chmod(0o755)
    return fake


def _write_state(tmp_path, **kw):
    import json
    (tmp_path / "update-state.json").write_text(json.dumps(
        {"previous_image": "", "image": "", "rejected_image": "", "phase": "done", **kw}))


def _state_of(tmp_path):
    import json
    return json.loads((tmp_path / "update-state.json").read_text())


def _start(sh, tmp_path, fake, extra=""):
    return sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; CFG_CHANNEL=stable; HEALTH_POLL_S=0; '
              f'HEALTH_TIMEOUT_S=0; identity_check() {{ echo ok; }}; {extra} start_kiosk',
              env={"KIOSK_IMAGE": ""}, check=False)


STABLE = "ghcr.io/encondata/serversherpa-kiosk-laptop:stable"


def test_start_kiosk_retries_a_version_that_was_rejected(sh, tmp_path):
    """Running the installer is an explicit retry: the version the nightly
    update set aside is started again and rejected_image is forgotten."""
    _write_state(tmp_path, previous_image="sha256:older", rejected_image="sha256:bad")
    fake = _kiosk_docker(tmp_path, running="sha256:old", pulled="sha256:bad")
    r = _start(sh, tmp_path, fake)
    assert r.returncode == 0, r.stderr
    assert "failed its health check on this laptop before" not in r.stderr
    assert "retries" in r.stdout
    calls = (tmp_path / "docker.log").read_text().splitlines()
    assert f"tag sha256:old {STABLE}" not in calls and any(c.endswith(" up -d") for c in calls)
    st = _state_of(tmp_path)
    assert (st["phase"], st["rejected_image"], st["previous_image"]) == ("done", "", "sha256:older")


def test_start_kiosk_failed_retry_without_a_container_rejects_it_again_in_place(sh, tmp_path):
    _write_state(tmp_path, previous_image="sha256:older", rejected_image="sha256:bad", phase="updating")
    st_file = tmp_path / "update-state.json"
    ino = st_file.stat().st_ino
    fake = _kiosk_docker(tmp_path, running="", pulled="sha256:bad", health=("unhealthy",))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "didn't become healthy in time" in r.stderr
    st = _state_of(tmp_path)
    assert (st["rejected_image"], st["phase"], st["previous_image"]) == ("sha256:bad", "updating", "sha256:older")
    assert st_file.stat().st_ino == ino   # rewritten in place: owner and mode stay


def test_start_kiosk_clears_the_rejection_in_the_file_before_starting(sh, tmp_path):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake = _kiosk_docker(tmp_path, running="", pulled="sha256:bad")
    _start(sh, tmp_path, fake, extra=f'compose() {{ cat "{tmp_path}/update-state.json" > "{tmp_path}/seen"; }}; ')
    import json
    assert json.loads((tmp_path / "seen").read_text())["rejected_image"] == ""


def test_start_kiosk_failed_retry_without_a_container_starts_the_kept_previous(sh, tmp_path):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake = _kiosk_docker(tmp_path, running="", pulled="sha256:bad", previous_tag="sha256:prev",
                         health=("unhealthy", "healthy"))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0
    assert "started the previous version, which is running" in r.stderr, r.stderr
    calls = (tmp_path / "docker.log").read_text().splitlines()
    i_tag = calls.index(f"tag serversherpa-kiosk-laptop:previous {STABLE}")
    assert any(c.endswith(" up -d") for c in calls[i_tag:])
    st = _state_of(tmp_path)
    assert (st["rejected_image"], st["phase"]) == ("sha256:bad", "done")


def test_start_kiosk_kept_previous_that_fails_too_says_so(sh, tmp_path):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake = _kiosk_docker(tmp_path, running="", pulled="sha256:bad", previous_tag="sha256:prev",
                         health=("unhealthy",))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "isn't healthy either" in r.stderr
    assert _state_of(tmp_path)["rejected_image"] == "sha256:bad"


def test_start_kiosk_kept_previous_that_is_the_failed_image_is_not_tried(sh, tmp_path):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake = _kiosk_docker(tmp_path, running="", pulled="sha256:bad", previous_tag="sha256:bad",
                         health=("unhealthy",))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "didn't become healthy in time" in r.stderr
    assert not any(c.startswith("tag ") for c in (tmp_path / "docker.log").read_text().splitlines())
    assert _state_of(tmp_path)["rejected_image"] == "sha256:bad"


def test_start_kiosk_without_a_rejected_version_says_nothing_about_it(sh, tmp_path):
    fake = _kiosk_docker(tmp_path, running="sha256:old", pulled="sha256:new")
    r = _start(sh, tmp_path, fake)
    assert r.returncode == 0 and "retries" not in r.stdout


def test_start_kiosk_rolls_back_when_the_new_version_is_unhealthy(sh, tmp_path):
    fake = _kiosk_docker(tmp_path, running="sha256:old", pulled="sha256:new",
                         health=("unhealthy", "healthy"))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "rolled back to the previous version" in r.stderr
    calls = (tmp_path / "docker.log").read_text().splitlines()
    i_tag = calls.index(f"tag sha256:old {STABLE}")
    assert any(c.endswith(" up -d") for c in calls[i_tag:])
    st = _state_of(tmp_path)
    assert st["rejected_image"] == "sha256:new" and st["phase"] == "done"


def test_start_kiosk_failed_rollback_says_so(sh, tmp_path):
    fake = _kiosk_docker(tmp_path, running="sha256:old", pulled="sha256:new", health=("unhealthy",))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0
    assert "rolled back to the previous version" not in r.stderr and "isn't healthy either" in r.stderr


def test_start_kiosk_no_rollback_without_an_earlier_image(sh, tmp_path):
    fake = _kiosk_docker(tmp_path, running="", pulled="sha256:new", health=("unhealthy",))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "didn't become healthy in time" in r.stderr
    assert "tag " not in (tmp_path / "docker.log").read_text()


def test_start_kiosk_resets_a_stale_updating_phase(sh, tmp_path):
    _write_state(tmp_path, previous_image="sha256:older", rejected_image="sha256:x", phase="updating")
    st_file = tmp_path / "update-state.json"
    ino = st_file.stat().st_ino
    fake = _kiosk_docker(tmp_path, running="sha256:old", pulled="sha256:new")
    r = _start(sh, tmp_path, fake)
    assert r.returncode == 0, r.stderr
    st = _state_of(tmp_path)
    assert (st["phase"], st["rejected_image"], st["previous_image"]) == ("done", "", "sha256:older")
    assert st_file.stat().st_ino == ino   # rewritten in place: owner and mode stay


@pytest.mark.parametrize("err", ["manifest unknown", "pull access denied for x, repository does not exist",
                                 "unauthorized: authentication required", "not found"])
def test_pull_failure_when_image_not_published(sh, tmp_path, err):
    fake = _kiosk_docker(tmp_path, pull_error=f"Error response from daemon: {err}")
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0
    assert ("the stable image isn't published yet, or its package isn't public — "
            "try --channel edge, or ask your administrator") in r.stderr.lower()


def test_pull_failure_from_the_network_keeps_network_message(sh, tmp_path):
    fake = _kiosk_docker(tmp_path, pull_error="dial tcp: lookup ghcr.io: no such host")
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "Check the network" in r.stderr and "published" not in r.stderr


# phase-1 data: found through the old container's /data mount

def _migrate(sh, tmp_path, fake, data, extra=""):
    return sh(f'DOCKER=("{fake}"); KIOSK_DATA_DIR="{data}"; {extra} migrate_legacy_data', check=False)


def test_migration_uses_the_legacy_containers_mount(sh, tmp_path):
    src = tmp_path / "elsewhere" / "kioskdata"; src.mkdir(parents=True)
    (src / "identity.json").write_text('{"serial":"from-mount"}')
    home_guess = tmp_path / "home" / "ServerSherpaKiosk"; home_guess.mkdir(parents=True)
    (home_guess / "identity.json").write_text('{"serial":"from-home"}')
    data = tmp_path / "data"; data.mkdir()
    fake = _kiosk_docker(tmp_path, ps="abc123", mount=str(src))
    r = _migrate(sh, tmp_path, fake, data)
    assert r.returncode == 0, r.stderr
    assert "from-mount" in (data / "identity.json").read_text()
    calls = (tmp_path / "docker.log").read_text().splitlines()
    assert "inspect -f {{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Source}}{{end}}{{end}} abc123" in calls
    assert "stop abc123" in calls


def test_migration_stops_when_the_legacy_mount_is_unreadable(sh, tmp_path):
    data = tmp_path / "data"; data.mkdir()
    fake = _kiosk_docker(tmp_path, ps="abc123", mount="/home/nobody-xyz/ServerSherpaKiosk")
    r = _migrate(sh, tmp_path, fake, data)
    assert r.returncode != 0
    assert "/home/nobody-xyz/ServerSherpaKiosk" in r.stderr and str(data) in r.stderr
    assert "--start-fresh" in r.stderr
    assert not list(data.iterdir())


def test_migration_start_fresh_skips_an_unreadable_mount(sh, tmp_path):
    data = tmp_path / "data"; data.mkdir()
    fake = _kiosk_docker(tmp_path, ps="abc123", mount="/home/nobody-xyz/ServerSherpaKiosk")
    r = _migrate(sh, tmp_path, fake, data, extra="START_FRESH=1;")
    assert r.returncode == 0, r.stderr
    assert "start-fresh" in r.stderr.lower() or "fresh" in r.stdout.lower() + r.stderr.lower()
    assert not list(data.iterdir())


def test_migration_unreadable_mount_with_data_already_there_is_fine(sh, tmp_path):
    data = tmp_path / "data"; data.mkdir(); (data / "edge.db").write_text("mine")
    fake = _kiosk_docker(tmp_path, ps="abc123", mount="/home/nobody-xyz/ServerSherpaKiosk")
    r = _migrate(sh, tmp_path, fake, data)
    assert r.returncode == 0, r.stderr
    assert (data / "edge.db").read_text() == "mine"


def test_migration_without_legacy_container_uses_the_home_folder(sh, tmp_path):
    home_guess = tmp_path / "home" / "ServerSherpaKiosk"; home_guess.mkdir(parents=True)
    (home_guess / "identity.json").write_text('{"serial":"from-home"}')
    data = tmp_path / "data"; data.mkdir()
    fake = _kiosk_docker(tmp_path, ps="")
    r = _migrate(sh, tmp_path, fake, data)
    assert r.returncode == 0, r.stderr
    assert "from-home" in (data / "identity.json").read_text()


def test_start_fresh_flag_parses(sh):
    assert sh('parse_args --start-fresh; echo "$START_FRESH"').stdout.strip() == "1"


# macOS data folder: never trust a pre-created folder

def _mac_data(tmp_path, owner="root"):
    parent = tmp_path / "Shared" / "ServerSherpaKiosk"
    data = parent / "data"
    calls = tmp_path / "calls"
    stubs = (f'OS=Darwin; KIOSK_DATA_DIR="{data}"; desktop_user() {{ printf alice; }}; '
             f'path_owner() {{ printf "%s" "{owner}"; }}; '
             f'chown() {{ echo "chown $*" >> "{calls}"; }}; chmod() {{ echo "chmod $*" >> "{calls}"; }}; ')
    return parent, data, calls, stubs


def test_mac_new_parent_is_root_wheel_755(sh, tmp_path):
    parent, data, calls, stubs = _mac_data(tmp_path)
    sh(stubs + 'create_data_dir')
    log = calls.read_text().splitlines()
    assert f"chown root:wheel {parent}" in log and f"chmod 755 {parent}" in log
    assert f"chown alice {data}" in log and f"chmod 700 {data}" in log


@pytest.mark.parametrize("owner", ["root", "alice"])
def test_mac_existing_parent_owned_by_root_or_desktop_user_is_fine(sh, tmp_path, owner):
    parent, data, calls, stubs = _mac_data(tmp_path, owner=owner)
    parent.mkdir(parents=True)
    sh(stubs + 'create_data_dir')
    assert f"chown root:wheel {parent}" not in calls.read_text()   # left as it is
    assert data.is_dir()


def test_mac_existing_parent_owned_by_someone_else_stops(sh, tmp_path):
    parent, data, calls, stubs = _mac_data(tmp_path, owner="mallory")
    parent.mkdir(parents=True)
    r = sh(stubs + 'create_data_dir', check=False)
    assert r.returncode != 0 and "mallory" in r.stderr and str(parent) in r.stderr
    assert not data.exists()


def test_mac_symlinked_data_folder_stops(sh, tmp_path):
    parent, data, calls, stubs = _mac_data(tmp_path)
    parent.mkdir(parents=True)
    (tmp_path / "elsewhere").mkdir()
    data.symlink_to(tmp_path / "elsewhere")
    r = sh(stubs + 'create_data_dir', check=False)
    assert r.returncode != 0 and "symbolic link" in r.stderr and str(data) in r.stderr


def test_mac_symlinked_parent_stops(sh, tmp_path):
    parent, data, calls, stubs = _mac_data(tmp_path)
    (tmp_path / "Shared").mkdir()
    (tmp_path / "elsewhere").mkdir()
    parent.symlink_to(tmp_path / "elsewhere")
    r = sh(stubs + 'create_data_dir', check=False)
    assert r.returncode != 0 and "symbolic link" in r.stderr and str(parent) in r.stderr
    assert not (tmp_path / "elsewhere" / "data").exists()


def test_summary_names_the_account_on_macos(sh):
    base = ('CFG_CHANNEL=stable; KIOSK_DIR=/k; KIOSK_IDENTITY=; kiosk_version() { :; }; '
            'desktop_user() { printf alice; }; ')
    mac = sh('OS=Darwin; ' + base + 'summary').stdout
    assert "Set up for: alice (the kiosk opens when this account signs in)" in mac
    assert "Set up for:" not in sh('OS=Linux; ' + base + 'summary').stdout



# ── fix round 2 ───────────────────────────────────────────────────────

def test_start_fresh_skips_even_a_readable_legacy_folder(sh, tmp_path):
    src = tmp_path / "old"; src.mkdir(); (src / "identity.json").write_text('{"serial":"old"}')
    data = tmp_path / "data"; data.mkdir()
    fake = _kiosk_docker(tmp_path, ps="abc123", mount=str(src))
    r = _migrate(sh, tmp_path, fake, data, extra="START_FRESH=1;")
    assert r.returncode == 0, r.stderr
    assert f"Starting fresh (--start-fresh): the earlier kiosk's data in {src} was not copied." in r.stderr
    assert not list(data.iterdir())


def test_rollback_without_a_pulled_image_id_rejects_nothing(sh, tmp_path):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake = _kiosk_docker(tmp_path, running="sha256:old", pulled="", health=("unhealthy", "healthy"))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "rolled back to the previous version" in r.stderr
    assert _state_of(tmp_path)["rejected_image"] == ""


@pytest.mark.parametrize("previous_tag", ["sha256:prev", ""])
def test_rejected_image_without_container_is_retried(sh, tmp_path, previous_tag):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake = _kiosk_docker(tmp_path, running="", pulled="sha256:bad", previous_tag=previous_tag)
    r = _start(sh, tmp_path, fake)
    assert r.returncode == 0, r.stderr
    assert "failed its health check on this laptop before" not in r.stderr
    assert not any(c.startswith("tag ") for c in (tmp_path / "docker.log").read_text().splitlines())
    assert _state_of(tmp_path)["rejected_image"] == ""


# ── fix round 3: containerd image store ──────────────────────────────

from conftest import store_docker  # noqa: E402

PREV_TAG = "serversherpa-kiosk-laptop:previous"


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_installer_tags_previous_before_the_pull(sh, tmp_path, mode):
    fake, store = store_docker(tmp_path, mode, STABLE, {STABLE: "sha256:old"}, running="sha256:old",
                               pulled="sha256:new")
    r = _start(sh, tmp_path, fake)
    assert r.returncode == 0, r.stderr
    calls = (tmp_path / "docker.log").read_text().splitlines()
    assert calls.index(f"tag {STABLE} {PREV_TAG}") < next(i for i, c in enumerate(calls) if c.endswith(" pull"))
    tags, running = store()
    assert tags[PREV_TAG] == "sha256:old" and running == "sha256:new"


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_installer_rollback_tags_from_previous(sh, tmp_path, mode):
    fake, store = store_docker(tmp_path, mode, STABLE, {STABLE: "sha256:old"}, running="sha256:old",
                               pulled="sha256:new", bad=("sha256:new",))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "rolled back to the previous version" in r.stderr, r.stderr
    tags, running = store()
    assert running == "sha256:old" and tags[STABLE] == "sha256:old"
    assert _state_of(tmp_path)["rejected_image"] == "sha256:new"


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_installer_retries_a_rejected_version(sh, tmp_path, mode):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake, store = store_docker(tmp_path, mode, STABLE, {STABLE: "sha256:old"}, running="sha256:old",
                               pulled="sha256:bad")
    r = _start(sh, tmp_path, fake)
    assert r.returncode == 0, r.stderr
    assert f"tag {PREV_TAG} {STABLE}" not in (tmp_path / "docker.log").read_text().splitlines()
    tags, running = store()
    assert tags[STABLE] == "sha256:bad" and running == "sha256:bad" and tags[PREV_TAG] == "sha256:old"


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_installer_no_container_failed_retry_falls_back_to_previous(sh, tmp_path, mode):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake, store = store_docker(tmp_path, mode, STABLE, {STABLE: "sha256:old", PREV_TAG: "sha256:prev"},
                               running="", pulled="sha256:bad", bad=("sha256:bad",))
    r = _start(sh, tmp_path, fake)
    assert r.returncode != 0 and "started the previous version, which is running" in r.stderr, r.stderr
    tags, running = store()
    assert running == "sha256:prev" and tags[STABLE] == "sha256:prev"
    assert _state_of(tmp_path)["rejected_image"] == "sha256:bad"


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_installer_no_container_retries_a_rejected_version(sh, tmp_path, mode):
    _write_state(tmp_path, rejected_image="sha256:bad")
    fake, store = store_docker(tmp_path, mode, STABLE, {STABLE: "sha256:old", PREV_TAG: "sha256:old"},
                               running="", pulled="sha256:bad")
    r = _start(sh, tmp_path, fake)
    assert r.returncode == 0, r.stderr
    tags, running = store()
    assert running == "sha256:bad"


# ── RFID station Task 7: host-network helper job ──────────────────────

def test_render_systemd_units_include_the_hostnet_timer(sh, tmp_path):
    sh(f'KIOSK_DIR="/opt/serversherpa kiosk"; render_systemd_units "{tmp_path}"')
    svc = (tmp_path / "serversherpa-kiosk-hostnet.service").read_text()
    tmr = (tmp_path / "serversherpa-kiosk-hostnet.timer").read_text()
    assert 'ExecStart="/opt/serversherpa kiosk/hostnet.sh"' in svc and "Type=oneshot" in svc
    assert "User=" not in svc   # runs as root, like the data folder's owner on Linux
    assert "OnBootSec=10s" in tmr and "OnUnitActiveSec=60s" in tmr and "WantedBy=timers.target" in tmr
    # no per-minute "Starting"/"Finished" lines in the journal
    assert "LogLevelMax=notice" in svc.split("[Service]", 1)[1]
    # a hung helper is stopped well before the next run is due
    assert "TimeoutStartSec=30\n" in svc.split("[Service]", 1)[1]
    for f in ("hostnet.service", "hostnet.timer"):
        assert (tmp_path / f"serversherpa-kiosk-{f}").stat().st_mode & 0o777 == 0o644


def test_render_launch_agent_interval_mode(sh, tmp_path):
    f = tmp_path / "h.plist"
    sh(f'render_launch_agent com.serversherpa.kiosk.hostnet "{f}" interval /k/hostnet.sh')
    a = plistlib.loads(f.read_bytes())
    assert a["Label"] == "com.serversherpa.kiosk.hostnet" and a["ProgramArguments"] == ["/k/hostnet.sh"]
    assert a["StartInterval"] == 60 and a["RunAtLoad"] is True


def test_install_login_items_linux_registers_the_hostnet_timer(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Linux; install_login_items')
    assert (inst / "hostnet.sh").stat().st_mode & 0o777 == 0o755
    assert (inst / "hostnet.sh").read_text() == (INSTALL_SH_DIR / "hostnet.sh").read_text()
    assert (tmp_path / "units" / "serversherpa-kiosk-hostnet.timer").exists()
    assert "systemctl enable --now serversherpa-kiosk-hostnet.timer" in calls.read_text().splitlines()


def test_install_login_items_linux_without_desktop_user_still_registers_hostnet(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'desktop_user() { :; }; OS=Linux; install_login_items')
    assert "systemctl enable --now serversherpa-kiosk-hostnet.timer" in calls.read_text()


def test_install_login_items_macos_registers_the_hostnet_agent(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Darwin; install_login_items')
    agents = home / "Library" / "LaunchAgents"
    h = plistlib.loads((agents / "com.serversherpa.kiosk.hostnet.plist").read_bytes())
    assert h["ProgramArguments"] == [f"{inst}/hostnet.sh"] and h["StartInterval"] == 60 and h["RunAtLoad"] is True
    log = calls.read_text().splitlines()
    i_out = log.index("launchctl bootout gui/501/com.serversherpa.kiosk.hostnet")
    i_in = log.index(f"launchctl bootstrap gui/501 {agents}/com.serversherpa.kiosk.hostnet.plist")
    assert i_out < i_in
    assert (inst / "hostnet.sh").stat().st_mode & 0o777 == 0o755


def test_remove_login_items_linux_removes_the_hostnet_timer(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Linux; install_login_items; remove_login_items')
    assert not (tmp_path / "units" / "serversherpa-kiosk-hostnet.timer").exists()
    assert not (tmp_path / "units" / "serversherpa-kiosk-hostnet.service").exists()
    log = calls.read_text()
    assert "systemctl disable --now serversherpa-kiosk-hostnet.timer" in log
    assert "systemctl stop serversherpa-kiosk-hostnet.service" in log


def test_remove_login_items_macos_removes_the_hostnet_agent(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Darwin; install_login_items; : > "' + str(calls) + '"; remove_login_items')
    assert not (home / "Library" / "LaunchAgents" / "com.serversherpa.kiosk.hostnet.plist").exists()
    assert "launchctl bootout gui/501/com.serversherpa.kiosk.hostnet" in calls.read_text()


def test_remove_login_items_macos_without_user_names_the_hostnet_agent(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    r = sh(stubs + 'desktop_user() { :; }; OS=Darwin; remove_login_items')
    assert "com.serversherpa.kiosk.hostnet.plist" in r.stderr


def test_dev_compose_publishes_both_ports_on_all_interfaces():
    text = (INSTALL_SH_DIR.parent / "docker-compose.yml").read_text()
    assert '"${EDGE_BIND:-0.0.0.0}:8090:8090"' in text and '"${EDGE_BIND:-0.0.0.0}:8091:8091"' in text
    assert "127.0.0.1" not in text


def test_runtime_compose_template_publishes_both_ports_on_all_interfaces():
    text = (INSTALL_SH_DIR / "docker-compose.yml").read_text()
    assert '- "0.0.0.0:8090:8090"' in text and '- "0.0.0.0:8091:8091"' in text


# ── Fix round 1: confirm the host-network job ran ─────────────────────
HOSTNET_WARNING = ("Couldn't confirm the network helper is running (it retries every minute)"
                   " — RFID setup may not find readers.")


def test_linux_starts_the_hostnet_service_once_and_confirms_a_fresh_file(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    data = tmp_path / "data"
    run = (f'systemctl() {{ echo "systemctl $*" >> "{calls}"; '
           f'[ "$*" != "start serversherpa-kiosk-hostnet.service" ] || echo "{{}}" > "{data}/host-network.json"; }}; ')
    r = sh(stubs + run + 'OS=Linux; install_login_items')
    log = calls.read_text().splitlines()
    assert log.index("systemctl enable --now serversherpa-kiosk-hostnet.timer") < \
        log.index("systemctl start serversherpa-kiosk-hostnet.service")
    assert HOSTNET_WARNING not in r.stderr


def test_linux_warns_when_no_fresh_file_appears(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    r = sh(stubs + 'OS=Linux; install_login_items')
    assert HOSTNET_WARNING in r.stderr


def test_a_stale_file_from_before_does_not_count(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    old = tmp_path / "data" / "host-network.json"
    old.write_text("{}")
    os.utime(old, (1_000_000_000, 1_000_000_000))
    r = sh(stubs + 'OS=Linux; install_login_items')
    assert HOSTNET_WARNING in r.stderr


def test_macos_relies_on_run_at_load_and_confirms_a_fresh_file(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    data = tmp_path / "data"
    run = (f'launchctl() {{ echo "launchctl $*" >> "{calls}"; case "$*" in '
           f'"bootstrap "*hostnet*) echo "{{}}" > "{data}/host-network.json" ;; esac; }}; ')
    r = sh(stubs + run + 'OS=Darwin; install_login_items')
    assert HOSTNET_WARNING not in r.stderr
    assert "kickstart" not in calls.read_text()


def test_macos_warns_when_no_fresh_file_appears(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    r = sh(stubs + 'OS=Darwin; install_login_items')
    assert HOSTNET_WARNING in r.stderr


def test_wait_for_host_network_polls_until_the_deadline(sh, tmp_path):
    data = tmp_path / "data"; data.mkdir()
    r = sh(f'KIOSK_DATA_DIR="{data}"; HOSTNET_POLL_S=0; n=0; '
           f'sleep() {{ n=$((n+1)); [ $n -lt 3 ] || echo "{{}}" > "{data}/host-network.json"; }}; '
           f'wait_for_host_network "$(date +%s)" && echo "ok after $n"')
    assert "ok after 3" in r.stdout


def test_wait_for_host_network_gives_up_after_10_seconds(sh, tmp_path):
    data = tmp_path / "data"; data.mkdir()
    r = sh(f'KIOSK_DATA_DIR="{data}"; HOSTNET_POLL_S=0; n=0; sleep() {{ n=$((n+1)); }}; '
           f'wait_for_host_network "$(date +%s)" || echo "gave up after $n"')
    assert "gave up after 10" in r.stdout


def test_config_records_installer_ref_for_the_nightly_update(sh, tmp_path):
    cfg = tmp_path / "config.env"
    base = 'CFG_API_URL=https://api.a.com CFG_PORTAL_URL= CFG_CHANNEL=edge CFG_DATA_DIR=/d'
    sh(f'{base}; write_config "{cfg}"')
    assert "KIOSK_INSTALLER_REF=main\n" in cfg.read_text()          # default
    sh(f'{base}; write_config "{cfg}"', env={"KIOSK_INSTALLER_REF": "feature-x"})
    assert "KIOSK_INSTALLER_REF=feature-x\n" in cfg.read_text()     # from the environment
    out = sh(f'load_config "{cfg}"; echo "$CFG_INSTALLER_REF"; {base}; write_config "{cfg}"').stdout.strip()
    assert out == "feature-x"                                       # a re-run without the env keeps it
    assert "KIOSK_INSTALLER_REF=feature-x\n" in cfg.read_text()


# ── Linux USB label printers, snap Docker, snap Chromium ──────────────

from conftest import LPSTAT_V, ZEBRA_QUEUES, lp_calls, lp_stubs  # noqa: E402

LP_BEGIN = "# >>> USB label printers"
LP_END = "# <<< USB label printers"


def _lp_block(path):
    text = path.read_text()
    assert text.count(LP_BEGIN) == 1 and text.count(LP_END) == 1, path.name
    return text[text.index(LP_BEGIN):text.index(LP_END)]


def test_label_printer_block_is_the_same_in_install_and_hostnet():
    assert _lp_block(INSTALL_SH_DIR / "install.sh") == _lp_block(INSTALL_SH_DIR / "hostnet.sh")


def test_both_scripts_write_the_same_udev_and_modprobe_files(sh, tmp_path):
    import subprocess
    from conftest import BASH
    body = 'lp_udev_rule; echo ---; lp_modprobe_conf; echo ---; echo "$LP_UDEV_RULES"; echo "$LP_MODPROBE_CONF"'
    mine = sh(body).stdout
    env = {**os.environ, "KIOSK_HOSTNET_LIB": "1", "KIOSK_DIR": str(tmp_path)}
    theirs = subprocess.run([BASH, "-c", f'source "{INSTALL_SH_DIR / "hostnet.sh"}"; {body}'],
                            capture_output=True, text=True, env=env).stdout
    assert mine == theirs
    rule, conf, paths = mine.split("---\n")
    assert 'SUBSYSTEM=="usb", ATTR{idVendor}=="0a5f", TAG+="uaccess"' in rule.splitlines()
    assert "blacklist usblp" in conf.splitlines()
    assert paths.splitlines() == ["/etc/udev/rules.d/60-serversherpa-label-printers.rules",
                                  "/etc/modprobe.d/serversherpa-no-usblp.conf"]


def test_lp_zebra_queues_picks_only_usb_zebras(sh):
    assert sh("printf '' | lp_zebra_queues").stdout == ""
    out = sh(f"printf '%s' '{LPSTAT_V}' | lp_zebra_queues").stdout.splitlines()
    assert out == ZEBRA_QUEUES


def test_setup_label_printers_fixes_everything_once(sh, tmp_path):
    stubs = lp_stubs(tmp_path, snaps=("chromium",))
    r = sh(stubs + "OS=Linux; setup_label_printers")
    calls = lp_calls(tmp_path)
    assert "apt-get -o DPkg::Lock::Timeout=120 remove -y system-config-printer-udev" in calls
    assert "DEBIAN_FRONTEND=noninteractive" in calls
    assert "modprobe -r usblp" in calls
    assert [c for c in calls if c.startswith("lpadmin")] == [f"lpadmin -x {q}" for q in ZEBRA_QUEUES]
    assert "udevadm control --reload" in calls
    assert "udevadm trigger --subsystem-match=usb --attr-match=idVendor=0a5f" in calls
    assert "snap connect chromium:raw-usb" in calls
    rule = (tmp_path / "udev" / "60-serversherpa-label-printers.rules").read_text()
    assert 'ATTR{idVendor}=="0a5f", TAG+="uaccess"' in rule
    assert "0666" not in rule
    assert "blacklist usblp" in (tmp_path / "modprobe" / "serversherpa-no-usblp.conf").read_text()
    # one info line per change: package, modprobe file, usblp, 2 queues, udev rule, chromium
    assert r.stdout.count("==>") == 7, r.stdout
    assert r.stderr == ""


def test_setup_label_printers_is_quiet_when_nothing_is_off(sh, tmp_path):
    stubs = lp_stubs(tmp_path, usblp=False, lpstat="device for HP: usb://HP/x\n", pkg=False,
                     snaps=("chromium",), raw_usb=True)
    sh(stubs + "OS=Linux; setup_label_printers")
    (tmp_path / "lp.calls").unlink()
    r = sh(stubs + "OS=Linux; setup_label_printers")
    assert r.stdout == "" and r.stderr == ""
    calls = lp_calls(tmp_path)
    assert not [c for c in calls if c.split()[0] in ("udevadm", "modprobe", "lpadmin", "apt-get")]
    assert "snap connect chromium:raw-usb" not in calls


def test_setup_label_printers_package_removal_failure_is_a_warning(sh, tmp_path):
    stubs = lp_stubs(tmp_path, fail="apt-get")
    r = sh(stubs + "OS=Linux; setup_label_printers; echo rc=$?")
    assert "rc=0" in r.stdout and "Warning:" in r.stderr and "system-config-printer-udev" in r.stderr
    assert (tmp_path / "udev" / "60-serversherpa-label-printers.rules").exists()


def test_setup_label_printers_failing_tools_never_stop_the_install(sh, tmp_path):
    stubs = lp_stubs(tmp_path, snaps=("chromium",), fail="modprobe udevadm lpadmin")
    stubs += f'LP_UDEV_RULES="{tmp_path}/notadir/x.rules"; : > "{tmp_path}/notadir"; '
    r = sh(stubs + 'OS=Linux; setup_label_printers; echo rc=$?; '
                   'snap() { return 1; }; setup_label_printers; echo rc=$?')
    assert r.stdout.count("rc=0") == 2, r.stderr
    assert "Couldn't write" in r.stderr and "Couldn't unload the usblp driver" in r.stderr


def test_setup_label_printers_without_cups_tools(sh, tmp_path):
    stubs = lp_stubs(tmp_path)
    r = sh(stubs + 'unset -f lpstat lpadmin; PATH=/nonexistent; OS=Linux; setup_label_printers; echo rc=$?')
    assert "rc=0" in r.stdout
    assert not [c for c in lp_calls(tmp_path) if c.startswith(("lpstat", "lpadmin"))]


def test_setup_label_printers_does_nothing_on_macos(sh, tmp_path):
    stubs = lp_stubs(tmp_path, snaps=("chromium", "docker"))
    r = sh(stubs + "OS=Darwin; setup_label_printers")
    assert r.stdout == "" and lp_calls(tmp_path) == []
    assert not (tmp_path / "udev" / "60-serversherpa-label-printers.rules").exists()


def _ensure_docker_linux(sh, tmp_path, **kw):
    stubs = lp_stubs(tmp_path, **kw)
    dockerd = tmp_path / "dockerd"
    return sh(stubs + f'curl() {{ echo "curl $*" >> "{tmp_path}/lp.calls"; '
                      f'printf "touch \\"%s\\"; chmod 755 \\"%s\\"\\n" "{dockerd}" "{dockerd}"; }}; '
                      'OS=Linux; ensure_docker', env={"SUDO_USER": ""}), lp_calls(tmp_path)


def test_ensure_docker_with_only_snap_docker_installs_engine_then_removes_the_snap(sh, tmp_path):
    r, calls = _ensure_docker_linux(sh, tmp_path, snaps=("docker",), engine=False)
    i_curl = next(i for i, c in enumerate(calls) if c.startswith("curl ") and "get.docker.com" in c)
    i_rm = calls.index("snap remove --purge docker")
    assert i_curl < i_rm
    assert calls.index("systemctl restart docker.socket docker.service") > i_rm
    assert "Installing Docker Engine" in r.stdout and "Removed snap Docker" in r.stdout
    assert "Docker is installed" not in r.stdout
    assert not (tmp_path / "run" / "serversherpa-kiosk-snap-docker-removed").exists()


def test_ensure_docker_with_snap_and_engine_only_removes_the_snap(sh, tmp_path):
    r, calls = _ensure_docker_linux(sh, tmp_path, snaps=("docker",), engine=True)
    assert not any(c.startswith("curl ") for c in calls)
    assert "snap remove --purge docker" in calls
    assert "systemctl restart docker.socket docker.service" in calls
    assert "Removed snap Docker" in r.stdout


def test_ensure_docker_snap_removal_failure_is_a_warning_and_restarts_nothing(sh, tmp_path):
    stubs = lp_stubs(tmp_path, snaps=("docker",))
    marker = tmp_path / "run" / "serversherpa-kiosk-snap-docker-removed"
    marker.write_text("")
    r = sh(stubs + f'snap() {{ echo "snap $*" >> "{tmp_path}/lp.calls"; '
                   'case "$1" in list) [ "$2" = docker ];; *) return 1;; esac; }; '
                   'OS=Linux; lp_remove_snap_docker; echo rc=$?')
    assert "rc=0" in r.stdout and "Couldn't remove snap Docker" in r.stderr
    assert not [c for c in lp_calls(tmp_path) if c.startswith("systemctl restart")]
    assert marker.exists()


def test_install_failed_engine_restart_is_a_warning_and_clears_the_marker(sh, tmp_path):
    r, calls = _ensure_docker_linux(sh, tmp_path, snaps=("docker",), engine=True, restart_fails=True)
    assert "systemctl restart docker.socket docker.service" in calls
    assert "Couldn't restart Docker Engine (systemctl restart docker.socket docker.service)." in r.stderr
    assert not (tmp_path / "run" / "serversherpa-kiosk-snap-docker-removed").exists()


def test_install_starts_no_kiosk_from_the_label_printer_block(sh, tmp_path):
    r, calls = _ensure_docker_linux(sh, tmp_path, snaps=("docker",), engine=True)
    assert not any(c.startswith(("docker", "systemctl start")) for c in calls)


def test_ensure_docker_with_engine_only_touches_no_snap(sh, tmp_path):
    r, calls = _ensure_docker_linux(sh, tmp_path, engine=True)
    assert "Docker Engine is installed." in r.stdout
    assert not any(c.startswith(("curl ", "snap remove", "systemctl restart")) for c in calls)


def test_engine_present_from_a_non_snap_systemd_unit(sh, tmp_path):
    stubs = lp_stubs(tmp_path, engine=False)
    unit = '[Service]\nExecStart=/usr/local/bin/dockerd -H fd://\n'
    snap_unit = '[Service]\nExecStart=/usr/bin/snap run docker.dockerd\nX=/snap/docker/1\n'
    out = sh(stubs + f'systemctl() {{ printf "%s" "$UNIT"; }}; lp_engine_present && echo yes || echo no',
             env={"UNIT": unit}).stdout
    assert out.strip() == "yes"
    out = sh(stubs + f'systemctl() {{ printf "%s" "$UNIT"; }}; lp_engine_present && echo yes || echo no',
             env={"UNIT": snap_unit}).stdout
    assert out.strip() == "no"
    out = sh(stubs + 'lp_engine_present && echo yes || echo no').stdout   # systemctl cat fails
    assert out.strip() == "no"


def test_uninstall_removes_the_label_printer_files_on_linux(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir()
    stubs = lp_stubs(tmp_path)
    (tmp_path / "udev" / "60-serversherpa-label-printers.rules").write_text("x")
    (tmp_path / "modprobe" / "serversherpa-no-usblp.conf").write_text("x")
    (tmp_path / "udev" / "other.rules").write_text("keep")
    sh(stubs + f'OS=Linux; DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; '
               f'remove_login_items() {{ :; }}; uninstall')
    assert not (tmp_path / "udev" / "60-serversherpa-label-printers.rules").exists()
    assert not (tmp_path / "modprobe" / "serversherpa-no-usblp.conf").exists()
    assert (tmp_path / "udev" / "other.rules").read_text() == "keep"
    assert not any(c.startswith(("apt-get", "snap")) for c in lp_calls(tmp_path))


def test_main_sets_up_label_printers_after_docker_and_before_the_kiosk_starts():
    text = (INSTALL_SH_DIR / "install.sh").read_text()
    body = text[text.index("\nmain() {"):]
    assert body.index("check_compose") < body.index("setup_label_printers") < body.index("start_kiosk")


# ── kiosk lockdown (Linux) ────────────────────────────────────────────
# A runner with xdg-user-dirs installed would answer for its own HOME.
NO_XDG = 'xdg-user-dir() { return 1; }; '


def _session_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("ks_drift", INSTALL_SH_DIR / "kiosk_session.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("kiosk_dir", ["/opt/serversherpa-kiosk", "/opt/Server Sherpa/50%"])
def test_start_icon_matches_kiosk_session(sh, tmp_path, kiosk_dir):
    f = tmp_path / "icon.desktop"
    sh(f'KIOSK_DIR="{kiosk_dir}"; render_start_icon "{f}"')
    from pathlib import Path
    assert f.read_text() == _session_module().start_icon_text(Path(kiosk_dir) / "launch.sh")


def test_install_login_items_linux_adds_the_session_and_the_start_icon(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    auto = home / ".config" / "autostart"; auto.mkdir(parents=True)
    (auto / "serversherpa-kiosk-restore.desktop").write_text("x")       # left by an earlier uninstall
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    assert (inst / "kiosk_session.py").stat().st_mode & 0o777 == 0o755
    icon = home / "Desktop" / "serversherpa-start-kiosk.desktop"
    assert f"Exec={inst}/launch.sh" in icon.read_text() and "Name=Start Kiosk" in icon.read_text()
    assert icon.stat().st_mode & 0o777 == 0o755
    assert not (auto / "serversherpa-kiosk-restore.desktop").exists()


def test_install_login_items_macos_has_no_session(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Darwin; install_login_items')
    assert not (inst / "kiosk_session.py").exists() and not (home / "Desktop").exists()


def test_ensure_python3_installs_it_when_missing(sh, tmp_path):
    calls = tmp_path / "calls"
    sh(f'have_python3() {{ return 1; }}; apt-get() {{ echo "apt-get $*" >> "{calls}"; }}; ensure_python3')
    assert "install -y python3" in calls.read_text()
    calls.unlink()
    sh(f'have_python3() {{ :; }}; apt-get() {{ echo "apt-get $*" >> "{calls}"; }}; ensure_python3')
    assert not calls.exists()


def _locked(home):
    state = home / ".local" / "state" / "serversherpa-kiosk"; state.mkdir(parents=True)
    (state / "desktop-lock.json").write_text('{"version": 1, "saved": []}')
    return state


def test_remove_login_items_linux_restores_in_the_users_session(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    state = _locked(home)
    restore = (f'pkill() {{ echo "pkill $*" >> "{calls}"; }}; SESSION_STOP_WAIT_S=0; '
               f'session_restore() {{ echo "restore $*" >> "{calls}"; rm -f "{state}/desktop-lock.json"; }}; ')
    sh(stubs + NO_XDG + restore + 'OS=Linux; remove_login_items')
    log = calls.read_text()
    assert f"pkill -TERM -u alice -f {inst}/kiosk_session.py" in log and "restore alice 501" in log
    assert not (home / "Desktop" / "serversherpa-start-kiosk.desktop").exists()
    assert not (home / ".config/autostart/serversherpa-kiosk-restore.desktop").exists()


def test_remove_login_items_linux_leaves_a_one_shot_restore_when_signed_out(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    state = _locked(home)
    sh(stubs + NO_XDG + 'pkill() { :; }; SESSION_STOP_WAIT_S=0; have_python3() { :; }; session_restore() { return 1; }; '
               'OS=Linux; remove_login_items')
    entry = (home / ".config/autostart/serversherpa-kiosk-restore.desktop").read_text()
    assert f"Exec=python3 {state}/kiosk_session.py restore --cleanup" in entry
    assert (state / "kiosk_session.py").read_text() == (inst / "kiosk_session.py").read_text()


def test_uninstall_removes_the_session_file(sh, tmp_path):
    inst = tmp_path / "inst"; inst.mkdir()
    (inst / "kiosk_session.py").write_text("x")
    sh(f'KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{tmp_path / "data"}"; OS=Linux; '
       'remove_login_items() { :; }; remove_label_printer_files() { :; }; check_rm_target() { :; }; uninstall')
    assert not (inst / "kiosk_session.py").exists()


# session_restore runs restore on the user's real session bus. Without it,
# gsettings could fall back to its memory backend, "succeed" and save nothing.
def _bus_dir():
    """A RUN_USER_DIR holding 501/bus as a real socket (a short path: a Unix
    socket path is limited to about 100 bytes)."""
    import socket
    import tempfile
    d = tempfile.mkdtemp(prefix="ks")
    os.mkdir(os.path.join(d, "501"))
    s = socket.socket(socket.AF_UNIX)
    s.bind(os.path.join(d, "501", "bus"))
    return d, s


def test_session_restore_runs_as_the_user_on_their_session_bus(sh, tmp_path):
    import shutil
    d, s = _bus_dir()
    try:
        calls = tmp_path / "calls"
        r = sh(f'KIOSK_DIR=/k; RUN_USER_DIR="{d}"; as_user() {{ echo "$*" >> "{calls}"; return 1; }}; '
               'rc=0; session_restore alice 501 || rc=$?; echo rc=$rc')
        assert calls.read_text().splitlines() == [
            f"alice env DBUS_SESSION_BUS_ADDRESS=unix:path={d}/501/bus XDG_RUNTIME_DIR={d}/501 "
            "python3 /k/kiosk_session.py restore"]
        assert "rc=1" in r.stdout       # restore's exit 1 ("couldn't confirm") is passed on
    finally:
        s.close()
        shutil.rmtree(d)


def test_session_restore_without_the_session_bus_does_nothing(sh, tmp_path):
    calls = tmp_path / "calls"
    (tmp_path / "run" / "501").mkdir(parents=True)
    (tmp_path / "run" / "501" / "bus").write_text("")   # a plain file is not the bus
    r = sh(f'KIOSK_DIR=/k; RUN_USER_DIR="{tmp_path / "run"}"; as_user() {{ echo "$*" >> "{calls}"; }}; '
           'rc=0; session_restore alice 501 || rc=$?; echo rc=$rc')
    assert "rc=1" in r.stdout and not calls.exists()


def test_remove_login_items_linux_without_the_session_bus_leaves_a_one_shot_restore(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    state = _locked(home)
    # No bus socket under RUN_USER_DIR: restore never runs; the entry does it at sign-in.
    sh(stubs + NO_XDG + f'pkill() {{ :; }}; SESSION_STOP_WAIT_S=0; have_python3() {{ :; }}; '
       f'RUN_USER_DIR="{tmp_path / "no-run"}"; python3() {{ echo "python3 $*" >> "{calls}"; }}; '
       'OS=Linux; remove_login_items')
    assert "kiosk_session.py restore" not in calls.read_text()
    entry = (home / ".config/autostart/serversherpa-kiosk-restore.desktop").read_text()
    assert f"Exec=python3 {state}/kiosk_session.py restore --cleanup" in entry
    assert (state / "desktop-lock.json").exists()


def test_remove_login_items_linux_keeps_the_one_shot_restore_when_restore_cant_confirm(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    state = _locked(home)
    auto = home / ".config" / "autostart"
    (auto / "serversherpa-kiosk-restore.desktop").write_text("from an earlier uninstall")
    # restore exits 1 and even removes the save file: still not confirmed.
    sh(stubs + NO_XDG + f'pkill() {{ :; }}; SESSION_STOP_WAIT_S=0; have_python3() {{ :; }}; '
       f'session_restore() {{ rm -f "{state}/desktop-lock.json"; return 1; }}; OS=Linux; remove_login_items')
    entry = (auto / "serversherpa-kiosk-restore.desktop").read_text()
    assert f"Exec=python3 {state}/kiosk_session.py restore --cleanup" in entry


def test_remove_login_items_linux_waits_for_the_stopped_session(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    state = _locked(home)
    # The SIGTERMed session restores (removes the save file): no direct restore, no entry.
    sh(stubs + NO_XDG + f'pkill() {{ rm -f "{state}/desktop-lock.json"; }}; SESSION_STOP_WAIT_S=5; '
       f'session_restore() {{ echo "restore $*" >> "{calls}"; }}; OS=Linux; remove_login_items')
    assert "restore alice" not in calls.read_text()
    assert not (home / ".config/autostart/serversherpa-kiosk-restore.desktop").exists()
