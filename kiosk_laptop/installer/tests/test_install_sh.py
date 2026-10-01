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
