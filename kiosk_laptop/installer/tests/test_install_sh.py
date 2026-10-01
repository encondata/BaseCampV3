import pytest


def test_detect_os_sets_os_and_arch(sh):
    out = sh('detect_os; echo "$OS $ARCH"').stdout.split()
    assert out[0] in ("Darwin", "Linux") and out[1] in ("amd64", "arm64")


@pytest.mark.parametrize("os_name,install,data", [
    ("Linux", "/opt/serversherpa-kiosk", "/var/lib/serversherpa-kiosk"),
    ("Darwin", "/Library/Application Support/ServerSherpaKiosk",
     "/Library/Application Support/ServerSherpaKiosk/data"),
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
    r = subprocess.run([sc, "-s", "bash", str(INSTALL_SH)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout


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
    f = tmp_path / "settings-store.json"
    f.write_text('{"AutoStart": false, "MemoryMiB": 4096, "FilesharingDirectories": ["/Users"]}')
    sh(f'set_docker_settings "{f}" "/Library/Application Support/ServerSherpaKiosk/data"')
    import json
    d = json.loads(f.read_text())
    assert d["AutoStart"] is True and d["MemoryMiB"] == 4096
    assert d["FilesharingDirectories"] == ["/Users", "/Library/Application Support/ServerSherpaKiosk/data"]


def test_docker_autostart_creates_missing_file_without_python(sh, tmp_path):
    import json
    f = tmp_path / "gc" / "settings-store.json"
    sh(f'has_python() {{ return 1; }}; set_docker_settings "{f}" /Library/x/data')
    d = json.loads(f.read_text())
    assert d["AutoStart"] is True and "/Library/x/data" in d["FilesharingDirectories"]
    assert "/Users" in d["FilesharingDirectories"]
    # an existing file is never rewritten without python
    f.write_text('{"AutoStart": false, "Keep": 1}')
    r = sh(f'has_python() {{ return 1; }}; set_docker_settings "{f}" /Library/x/data')
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
