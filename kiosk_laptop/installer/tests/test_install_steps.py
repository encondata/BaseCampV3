import pytest

from conftest import store_docker

STABLE = "ghcr.io/encondata/serversherpa-kiosk-laptop:stable"
PREV_TAG = "serversherpa-kiosk-laptop:previous"

STEP_FUNCS = ("ensure_root check_minimums start_log setup_docker_cli ensure_download_tools ensure_docker "
              "enable_docker_autostart wait_for_engine check_compose ensure_chrome ensure_python3 have_python3 "
              "setup_label_printers merge_config find_browser create_data_dir write_config render_compose "
              "migrate_legacy_data prepare_kiosk_image start_kiosk install_login_items install_setup_launcher "
              "move_dev_data restart_kiosk check_rows")
STUBS = f'for f in {STEP_FUNCS}; do eval "$f() {{ echo $f; }}"; done; OS=Linux; KIOSK_DIR="$PWD/k"; '


@pytest.mark.parametrize("step,calls", [
    ("tools", ["ensure_download_tools"]),
    ("docker", ["setup_docker_cli", "ensure_docker"]),
    ("docker-start", ["setup_docker_cli", "enable_docker_autostart", "wait_for_engine", "check_compose"]),
    ("chrome", ["ensure_chrome"]),
    ("python3", ["ensure_python3", "have_python3"]),
    ("printers", ["setup_label_printers"]),
    ("move-dev-data", ["setup_docker_cli", "move_dev_data"]),
    ("download", ["merge_config", "setup_docker_cli", "find_browser", "create_data_dir", "write_config",
                  "render_compose", "migrate_legacy_data", "prepare_kiosk_image"]),
    ("start", ["merge_config", "setup_docker_cli", "start_kiosk"]),
    ("login-items", ["install_login_items"]),
    ("launcher", ["install_setup_launcher"]),
    ("restart", ["setup_docker_cli", "restart_kiosk"]),
])
def test_run_step_runs_its_functions_in_order(sh, step, calls):
    out = sh(STUBS + f'run_step {step} --step {step} --yes').stdout.split()
    assert out[:3] == ["ensure_root", "check_minimums", "start_log"]
    assert out[3:] == calls


def test_check_step_needs_no_root_and_writes_no_log(sh):
    assert sh(STUBS + 'run_step check').stdout.split() == ["setup_docker_cli", "check_rows"]


def test_unknown_step_is_refused_before_sudo(sh):
    r = sh(STUBS + 'run_step bogus', check=False)
    assert r.returncode != 0 and "Unknown step 'bogus'" in r.stderr and "ensure_root" not in r.stdout


def test_step_mode_is_linux_only(sh):
    r = sh(STUBS + 'OS=Darwin; run_step tools', check=False)
    assert r.returncode != 0 and "--step is for the Ubuntu setup (setup.sh)." in r.stderr


def test_python3_step_fails_when_python3_is_still_missing(sh):
    r = sh(STUBS + 'have_python3() { return 1; }; run_step python3', check=False)
    assert r.returncode != 0 and "python3 didn't install" in r.stderr


def test_parse_args_takes_step_and_main_dispatches(sh):
    assert sh('parse_args --step start --channel edge; echo "$STEP $OPT_CHANNEL"').stdout.strip() == "start edge"
    r = sh('parse_args --step', check=False)
    assert r.returncode != 0 and "--step needs a value." in r.stderr
    out = sh('run_step() { echo "run_step $*"; }; main --step tools --yes').stdout
    assert "run_step tools --step tools --yes" in out
    r = sh('main --step tools --uninstall', check=False)
    assert r.returncode != 0 and "--step and --uninstall can't be used together." in r.stderr
    assert "--step NAME" in sh('usage').stdout


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_prepare_then_start_keeps_previous_and_runs_the_new_image(sh, tmp_path, mode):
    fake, store = store_docker(tmp_path, mode, STABLE, {STABLE: "sha256:old"}, running="sha256:old",
                               pulled="sha256:new")
    base = (f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; CFG_CHANNEL=stable; HEALTH_POLL_S=0; '
            f'HEALTH_TIMEOUT_S=0; identity_check() {{ echo ok; }}; ')
    sh(base + 'prepare_kiosk_image', env={"KIOSK_IMAGE": ""})
    tags, running = store()
    assert tags[PREV_TAG] == "sha256:old" and tags[STABLE] == "sha256:new" and running == "sha256:old"
    sh(base + 'start_kiosk', env={"KIOSK_IMAGE": ""})
    tags, running = store()
    assert running == "sha256:new" and tags[PREV_TAG] == "sha256:old"


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_start_retry_after_a_rollback_tries_the_new_image_again(sh, tmp_path, mode):
    fake, store = store_docker(tmp_path, mode, STABLE, {STABLE: "sha256:old"}, running="sha256:old",
                               pulled="sha256:new", bad=("sha256:new",))
    base = (f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; CFG_CHANNEL=stable; HEALTH_POLL_S=0; '
            f'HEALTH_TIMEOUT_S=0; identity_check() {{ echo ok; }}; ')
    sh(base + 'prepare_kiosk_image', env={"KIOSK_IMAGE": ""})
    assert sh(base + 'start_kiosk', env={"KIOSK_IMAGE": ""}, check=False).returncode != 0
    assert store()[1] == "sha256:old"            # rolled back
    (tmp_path / "store" / "bad").write_text("")  # the image is fine now
    sh(base + 'start_kiosk', env={"KIOSK_IMAGE": ""})
    assert store()[1] == "sha256:new"


def test_restart_kiosk_dies_when_unhealthy(sh, tmp_path):
    fake, _ = store_docker(tmp_path, "classic", STABLE, {STABLE: "sha256:a"}, running="sha256:a",
                           bad=("sha256:a",))
    r = sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; HEALTH_POLL_S=0; HEALTH_TIMEOUT_S=0; restart_kiosk',
           check=False)
    assert r.returncode != 0 and "didn't become healthy" in r.stderr


def test_ensure_download_tools_installs_only_what_is_missing(sh, tmp_path):
    calls = tmp_path / "calls"
    body = (f'apt-get() {{ echo "apt-get $*" >> "{calls}"; }}; pkg_installed() {{ return 0; }}; '
            'command() { [ "$2" != gpg ] && builtin command "$@"; }; ensure_download_tools')
    sh(body)
    log = calls.read_text()
    assert "update" in log and "install -y gpg" in log and "curl" not in log
    calls.unlink()
    sh(f'apt-get() {{ echo "apt-get $*" >> "{calls}"; }}; pkg_installed() {{ return 0; }}; ensure_download_tools')
    assert not calls.exists()


def test_ensure_download_tools_failure_is_fatal(sh):
    r = sh('apt-get() { return 100; }; pkg_installed() { return 1; }; ensure_download_tools', check=False)
    assert r.returncode != 0 and "Couldn't install" in r.stderr
