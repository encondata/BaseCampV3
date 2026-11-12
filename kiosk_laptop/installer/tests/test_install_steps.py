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


def test_restart_kiosk_shows_compose_errors(sh, tmp_path):
    fake = tmp_path / "docker"
    fake.write_text('#!/bin/sh\ncase "$1" in compose) echo "compose: port 8090 is taken" >&2;; '
                    'inspect) echo healthy;; esac\nexit 0\n')
    fake.chmod(0o755)
    r = sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; HEALTH_POLL_S=0; HEALTH_TIMEOUT_S=0; restart_kiosk')
    assert "compose: port 8090 is taken" in r.stderr


def test_start_and_download_share_the_keep_previous_helper():
    from conftest import INSTALL_SH
    body = INSTALL_SH.read_text()

    def func(name):
        start = body.index(f"\n{name}() {{")
        return body[start:body.index("\n}\n", start)]
    for name in ("start_kiosk", "prepare_kiosk_image"):
        assert "keep_running_image" in func(name) and "keep_previous" not in func(name)


def _apt_env(tmp_path, release_ok=True, ubuntu=True, codename="noble", release_rc=None):
    if release_rc is None:
        release_rc = 0 if release_ok else 22
    rel = tmp_path / "os-release"
    rel.write_text(f'ID={"ubuntu" if ubuntu else "debian"}\nVERSION_ID="24.04"\n'
                   f'VERSION_CODENAME={codename}\nUBUNTU_CODENAME={codename}\n')
    for d in ("keyrings", "sources"):
        (tmp_path / d).mkdir(exist_ok=True)
    calls = tmp_path / "apt.calls"
    stubs = (f'curl() {{ echo "curl $*" >> "{calls}"; case "$*" in *dists/*) return {release_rc};; '
             f'*" -o "*) for a; do l=$a; done; echo KEY > "$l";; *) echo ARMORED;; esac; }}; '
             f'gpg() {{ echo "gpg $*" >> "{calls}"; for a; do l=$a; done; cat > "$l"; }}; '
             f'apt-get() {{ echo "apt-get $*" >> "{calls}"; }}; dpkg() {{ echo amd64; }}; ')
    env = {"KIOSK_OS_RELEASE": str(rel), "KIOSK_APT_KEYRINGS": str(tmp_path / "keyrings"),
           "KIOSK_APT_SOURCES": str(tmp_path / "sources")}
    return stubs, env, calls


def test_docker_from_dockers_apt_repo(sh, tmp_path):
    stubs, env, calls = _apt_env(tmp_path)
    sh(stubs + 'install_docker_engine', env=env)
    assert (tmp_path / "keyrings" / "docker.asc").read_text() == "KEY\n"
    assert (tmp_path / "sources" / "docker.list").read_text() == (
        f"deb [arch=amd64 signed-by={tmp_path}/keyrings/docker.asc] "
        "https://download.docker.com/linux/ubuntu noble stable\n")
    log = calls.read_text()
    assert "https://download.docker.com/linux/ubuntu/dists/noble/Release" in log
    assert ("install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
            in log)
    assert "get.docker.com" not in log


def test_docker_falls_back_to_ubuntus_packages_for_a_new_codename(sh, tmp_path):
    stubs, env, calls = _apt_env(tmp_path, release_ok=False, codename="zesty")
    r = sh(stubs + 'install_docker_engine', env=env)
    assert "install -y docker.io docker-compose-v2" in calls.read_text()
    assert "Docker's apt repository doesn't serve Ubuntu zesty yet" in r.stdout
    assert not (tmp_path / "sources" / "docker.list").exists()


def test_docker_fallback_removes_a_stale_docker_list(sh, tmp_path):
    stubs, env, calls = _apt_env(tmp_path, release_ok=False)
    (tmp_path / "sources" / "docker.list").write_text("deb stale\n")
    (tmp_path / "sources" / "docker.sources").write_text("Types: deb\n")
    sh(stubs + 'install_docker_engine', env=env)
    assert not (tmp_path / "sources" / "docker.list").exists()
    assert not (tmp_path / "sources" / "docker.sources").exists()


def test_docker_list_replaces_a_deb822_docker_sources(sh, tmp_path):
    stubs, env, _ = _apt_env(tmp_path)
    (tmp_path / "sources" / "docker.sources").write_text("Types: deb\n")
    sh(stubs + 'install_docker_engine', env=env)
    assert not (tmp_path / "sources" / "docker.sources").exists()
    assert (tmp_path / "sources" / "docker.list").exists()


ENSURE_DOCKER = ('OS=Linux; lp_engine_present() { return 1; }; lp_snap_has() { return 1; }; '
                 'ensure_compose_plugin() { :; }; lp_remove_snap_docker() { :; }; unset SUDO_USER; ensure_docker')


@pytest.mark.parametrize("rc", [6, 28])
def test_docker_network_failure_stops_without_falling_back(sh, tmp_path, rc):
    stubs, env, calls = _apt_env(tmp_path, release_rc=rc)
    (tmp_path / "sources" / "docker.list").write_text("deb kept\n")
    (tmp_path / "sources" / "docker.sources").write_text("Types: deb\n")
    r = sh(stubs + ENSURE_DOCKER, env=env, check=False)
    assert r.returncode != 0
    assert "Couldn't reach Docker's apt repository" in r.stderr and "re-run" in r.stderr
    assert "Docker Engine didn't install" not in r.stderr
    log = calls.read_text()
    assert "docker.io" not in log and "apt-get" not in log
    assert (tmp_path / "sources" / "docker.list").read_text() == "deb kept\n"
    assert (tmp_path / "sources" / "docker.sources").exists()


def test_docker_http_error_still_falls_back(sh, tmp_path):
    stubs, env, calls = _apt_env(tmp_path, release_rc=22, codename="zesty")
    r = sh(stubs + ENSURE_DOCKER, env=env)
    assert "install -y docker.io docker-compose-v2" in calls.read_text()
    assert "Couldn't reach" not in r.stderr


def test_docker_off_ubuntu_keeps_get_docker_com(sh, tmp_path):
    stubs, env, calls = _apt_env(tmp_path, ubuntu=False)
    sh(stubs.replace('*) echo ARMORED;;', '*) echo true;;') + 'install_docker_engine', env=env)
    assert "https://get.docker.com" in calls.read_text() and "apt-get" not in calls.read_text()


def test_docker_install_is_idempotent(sh, tmp_path):
    stubs, env, _ = _apt_env(tmp_path)
    sh(stubs + 'install_docker_engine; install_docker_engine', env=env)
    assert (tmp_path / "sources" / "docker.list").read_text().count("deb ") == 1


@pytest.mark.parametrize("have,pkg", [("docker-ce", "docker-compose-plugin"), ("docker.io", "docker-compose-v2")])
def test_missing_compose_is_installed_to_match_the_engine(sh, tmp_path, have, pkg):
    stubs, env, calls = _apt_env(tmp_path)
    sh(stubs + f'DOCKER=(false); lp_engine_present() {{ :; }}; pkg_installed() {{ [ "$1" = {have} ]; }}; '
       'ensure_compose_plugin', env=env)
    log = calls.read_text()
    assert f"install -y {pkg}" in log
    assert "update" in log and log.index("update") < log.index(f"install -y {pkg}")


def test_chrome_from_googles_apt_repo(sh, tmp_path):
    stubs, env, calls = _apt_env(tmp_path)
    r = sh(stubs + 'ARCH=amd64; OS=Linux; chrome_installed() { return 1; }; ensure_chrome strict', env=env)
    assert r.returncode == 0
    assert (tmp_path / "keyrings" / "google-chrome.gpg").read_text() == "ARMORED\n"
    assert (tmp_path / "sources" / "google-chrome.list").read_text() == (
        f"deb [arch=amd64 signed-by={tmp_path}/keyrings/google-chrome.gpg] "
        "https://dl.google.com/linux/chrome/deb/ stable main\n")
    log = calls.read_text()
    assert "https://dl.google.com/linux/linux_signing_key.pub" in log and "--dearmor" in log
    assert "install -y google-chrome-stable" in log


def test_chrome_already_installed_touches_nothing(sh, tmp_path):
    stubs, env, calls = _apt_env(tmp_path)
    sh(stubs + 'ARCH=amd64; OS=Linux; chrome_installed() { :; }; ensure_chrome strict', env=env)
    assert not calls.exists()


@pytest.mark.parametrize("mode,fails", [("strict", True), ("warn", False)])
def test_chrome_on_arm64(sh, tmp_path, mode, fails):
    stubs, env, _ = _apt_env(tmp_path)
    r = sh(stubs + f'ARCH=arm64; OS=Linux; chrome_installed() {{ return 1; }}; ensure_chrome {mode}',
           env=env, check=False)
    assert (r.returncode != 0) == fails
    assert "Google Chrome isn't available for this processor." in r.stderr


def test_chrome_install_failure_strict_dies_warn_continues(sh, tmp_path):
    stubs, env, _ = _apt_env(tmp_path)
    stubs += 'apt-get() { return 100; }; '
    r = sh(stubs + 'ARCH=amd64; OS=Linux; chrome_installed() { return 1; }; ensure_chrome strict', env=env, check=False)
    assert r.returncode != 0 and "Google Chrome didn't install" in r.stderr
    assert "a re-run will retry" in r.stdout
    assert (tmp_path / "sources" / "google-chrome.list").exists()
    r = sh(stubs + 'ARCH=amd64; OS=Linux; chrome_installed() { return 1; }; ensure_chrome warn', env=env)
    assert "Couldn't install Google Chrome" in r.stderr


def test_main_installs_chrome_before_the_config_is_written():
    from conftest import INSTALL_SH
    body = INSTALL_SH.read_text()
    body = body[body.index("\nmain() {"):]
    assert body.index("setup_label_printers") < body.index("ensure_chrome warn") \
        < body.index("find_browser") < body.index("write_config")


MAIN_FUNCS = ("parse_args detect_os default_dirs load_config ensure_root check_minimums start_log prompt_settings "
              "merge_config check_api_reachable setup_docker_cli ensure_docker enable_docker_autostart "
              "wait_for_engine check_compose setup_label_printers create_data_dir write_config render_compose "
              "migrate_legacy_data start_kiosk install_login_items summary")


@pytest.mark.parametrize("case,count", [("darwin", 1), ("not-ubuntu", 1), ("installed", 1), ("new", 2)])
def test_main_looks_for_the_browser_again_only_after_installing_chrome(sh, tmp_path, case, count):
    calls = tmp_path / "browser.calls"
    stubs = (f'for f in {MAIN_FUNCS}; do eval "$f() {{ :; }}"; done; KIOSK_DIR="$PWD/k"; ARCH=amd64; '
             f'find_browser() {{ echo find_browser >> "{calls}"; }}; install_chrome_apt() {{ :; }}; ')
    stubs += {"darwin": "OS=Darwin; ",
              "not-ubuntu": "OS=Linux; is_ubuntu() { return 1; }; ",
              "installed": "OS=Linux; is_ubuntu() { :; }; chrome_installed() { :; }; ",
              "new": "OS=Linux; is_ubuntu() { :; }; chrome_installed() { return 1; }; "}[case]
    sh(stubs + 'main')
    assert calls.read_text().count("find_browser") == count
