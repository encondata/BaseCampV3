import pytest

from conftest import SYS_OK

PROD = ("https://api.serversherpa.com", "https://portal.serversherpa.com")
DEV = ("https://api.dev.serversherpa.com", "https://portal.dev.serversherpa.com")


def write_config(tmp_path, api, portal, channel, data_dir=""):
    (tmp_path / "opt" / "config.env").write_text(
        f"EDGE_CLOUD_API_URL={api}\nEDGE_PORTAL_URL={portal}\nKIOSK_CHANNEL={channel}\n"
        f"KIOSK_DATA_DIR={data_dir}\nKIOSK_BROWSER=/usr/bin/google-chrome\nKIOSK_INSTALLER_REF=main\n")


@pytest.mark.parametrize("env,api,portal,channel,label", [
    ("prod", *PROD, "stable", "Prod"), ("rc", *PROD, "beta", "RC"),
    ("dev", *DEV, "beta", "Dev"), ("edge", *DEV, "edge", "Edge"),
])
def test_environment_table(setup, env, api, portal, channel, label):
    out = setup(f'env_api {env}; echo; env_portal {env}; echo; env_channel {env}; echo; env_label {env}').stdout
    assert out.splitlines() == [api, portal, channel, label]


@pytest.mark.parametrize("api,portal,channel,want", [
    (*PROD, "stable", "prod"), (*PROD, "beta", "rc"), (*DEV, "beta", "dev"), (*DEV, "edge", "edge"),
    ("https://api.serversherpa.com/", "https://portal.serversherpa.com/", "stable", "prod"),
    (*PROD, "edge", "custom"), (*DEV, "stable", "custom"),
    ("http://10.0.0.5:8000", "", "stable", "custom"),
])
def test_detect_env(setup, api, portal, channel, want):
    assert setup(f'detect_env "{api}" "{portal}" {channel}').stdout == want


def test_current_env_reads_the_saved_config(setup, tmp_path):
    assert setup('load_saved_config; current_env').stdout == "none"
    write_config(tmp_path, *DEV, "edge")
    assert setup('load_saved_config; current_env').stdout == "edge"
    assert setup('load_saved_config; env_label custom').stdout == "Custom (keep current settings)"


@pytest.mark.parametrize("env,saved,want", [
    ("prod", "", "varlib/serversherpa-kiosk"), ("rc", "varlib/serversherpa-kiosk-dev", "varlib/serversherpa-kiosk"),
    ("dev", "varlib/serversherpa-kiosk", "varlib/serversherpa-kiosk-dev"), ("edge", "", "varlib/serversherpa-kiosk-dev"),
])
def test_data_dir_for_follows_the_server_set(setup, tmp_path, env, saved, want):
    write_config(tmp_path, *PROD, "stable", f"{tmp_path}/{saved}" if saved else "")
    assert setup(f'load_saved_config; data_dir_for {env}').stdout == f"{tmp_path}/{want}"


@pytest.mark.parametrize("env", ["prod", "dev", "custom"])
def test_data_dir_for_keeps_a_custom_folder(setup, tmp_path, env):
    write_config(tmp_path, *PROD, "stable", "/srv/kiosk/")
    out = setup(f'load_saved_config; data_dir_for {env}').stdout
    assert out == ("" if env == "custom" else "/srv/kiosk")


def test_server_set_note(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    assert setup('load_saved_config; server_set_note prod dev').stdout == (
        "This laptop will use a separate dev kiosk. Its production kiosk data is kept for when you switch back.")
    assert setup('load_saved_config; server_set_note prod rc').stdout == ""
    write_config(tmp_path, *DEV, "edge")
    assert setup('load_saved_config; server_set_note edge prod').stdout == (
        "This laptop will use a separate production kiosk. Its dev kiosk data is kept for when you switch back.")
    assert setup('load_saved_config; server_set_note none dev').stdout == ""
    write_config(tmp_path, *DEV, "edge", "/srv/kiosk")
    assert setup('load_saved_config; server_set_note edge prod').stdout == ""


@pytest.mark.parametrize("v,ok", [("22.04", True), ("22.10", True), ("24.04", True), ("26.04", True),
                                  ("20.04", False), ("", False), ("22", False), ("2x.04", False)])
def test_ubuntu_version_ok(setup, v, ok):
    assert setup(f'ubuntu_version_ok "{v}" && echo y || echo n').stdout.strip() == ("y" if ok else "n")


def test_check_ubuntu_problem_copy(setup, tmp_path):
    (tmp_path / "os-release").write_text('ID=debian\nVERSION_ID="12"\n')
    out = setup('check_ubuntu; row_state ubuntu; echo; row_note ubuntu').stdout.splitlines()
    assert out == ["fix", "This setup supports Ubuntu 22.04 and newer."]


def test_check_admin(setup):
    assert setup('check_admin; row_state admin').stdout == "ok"
    out = setup('KIOSK_SETUP_YES=1; check_admin; row_state admin', env={"SUDO_FAIL": "1"}).stdout
    assert out == "fix"


def test_check_disk_needs_10_gb(setup):
    assert setup('free_kib() { echo 10485760; }; check_disk; row_state disk').stdout == "ok"
    out = setup('free_kib() { echo 5242880; }; check_disk; row_state disk; echo; row_note disk').stdout.splitlines()
    assert out[0] == "fix" and "at least 10 GB" in out[1]


def test_check_internet_names_the_unreachable_hosts(setup):
    out = setup('net_ok() { [ "$1" != https://dl.google.com/ ]; }; check_internet; row_state internet; echo; '
                'row_note internet').stdout.splitlines()
    assert out[0] == "fix" and "dl.google.com" in out[1] and "download.docker.com" not in out[1]


def test_check_tools_lists_what_will_be_installed(setup):
    out = setup('have_cmd() { [ "$1" != gpg ]; }; pkg_installed() { return 1; }; check_tools; '
                'row_state tools; echo; row_note tools').stdout.splitlines()
    assert out == ["add", "will be installed: gpg ca-certificates"]


def test_engine_rows_fill_the_checklist_and_run_through_sudo_without_stdin(setup, tmp_path):
    (tmp_path / "engine.rows").write_text("row|docker|add|will be installed\nrow|kiosk|ok|running\n")
    write_config(tmp_path, *DEV, "edge")
    out = setup(SYS_OK + 'load_saved_config; run_checks; for i in docker kiosk snapdocker; do '
                'printf "%s=%s;" "$(row_state $i)" "$(row_note $i)"; done').stdout
    assert out == "add=will be installed;ok=running (Edge);--=Not checked;"
    log = (tmp_path / "engine.log").read_text()
    assert log.startswith("check|--step check --yes|") and log.rstrip().endswith("stdin=0")
    assert "sudo -n env" in (tmp_path / "sudo.log").read_text()


def test_safe_ref_spells_out_its_characters(setup):
    assert setup('safe_ref release/1.2_a-b').stdout == "release/1.2_a-b"
    assert setup('safe_ref "a;b"').stdout == "main" and setup('safe_ref "a..b"').stdout == "main"
    from conftest import SETUP_SH
    assert "A-Z" not in SETUP_SH.read_text() and "a-z" not in SETUP_SH.read_text()


def test_set_engine_args(setup, tmp_path):
    out = setup('load_saved_config; set_engine_args dev; printf "%s\\n" "${ENGINE_ARGS[@]}" "$ENGINE_DATA_DIR"').stdout
    assert out.splitlines() == ["--api-url", DEV[0], "--portal-url", DEV[1], "--channel", "beta",
                                f"{tmp_path}/varlib/serversherpa-kiosk-dev"]
    write_config(tmp_path, *PROD, "stable", "/srv/kiosk")
    out = setup('load_saved_config; set_engine_args custom; printf "%s|%s" "${#ENGINE_ARGS[@]}" "$ENGINE_DATA_DIR"').stdout
    assert out == "0|"
