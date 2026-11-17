# Kiosk Laptop Setup (Ubuntu) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command on a fresh Ubuntu desktop (`wget -qO- …/setup.sh | bash`) shows a checklist, an environment picker and a progress screen with Try again, and leaves a working kiosk. Re-running it updates in place or switches environment.

**Architecture:**
- `kiosk_laptop/installer/setup.sh` is a new Ubuntu-only front end. It handles the checks, the picker, progress, retry, snapshot and restore. It draws with `whiptail` through `/dev/tty`, and falls back to plain numbered prompts when whiptail is missing.
- `install.sh` stays the engine. It gains `--step NAME`, which runs one named, re-runnable step. `setup.sh` runs each step as `sudo env … bash install.sh --step NAME --yes [env flags] </dev/null`, and reads the result from the exit code and the last `Error:` line.
- `install.sh` also gains the following, which its normal run on Ubuntu uses too:
  - Docker from Docker's apt repo (falling back to Ubuntu's `docker.io`);
  - Chrome from Google's apt repo;
  - a `check` step that prints checklist rows;
  - the one-time move of dev data;
  - the "Set up kiosk" desktop launcher.
- The launcher runs a tiny runner script that downloads `setup.sh` fresh on every run. So `update.sh`'s nightly helper refresh list does **not** change.

**Tech Stack:** bash 3.2-compatible shell (`install.sh` and `setup.sh`), whiptail (newt), apt, systemd, Docker Engine plus Compose v2, pytest with shell stubs, shellcheck.

**Spec:** `docs/superpowers/specs/2026-11-12-kiosk-setup-installer-design.md` (approved; binding).

## Global Constraints

- **Platforms:** `setup.sh` targets Ubuntu 22.04 and newer only. `install.sh` keeps serving macOS and other Linux unchanged, and `install.ps1` is not touched.
- **bash 3.2:** both `install.sh` and `setup.sh` run under macOS `/bin/bash` 3.2. The tests run on Linux bash and on macOS `/bin/bash` 3.2 in CI (`conftest.BASH`).
  - **Decision:** `setup.sh` is kept bash-3.2 compatible, and its tests run on every platform; they do not skip off Linux. Every OS probe goes through an overridable function or a `KIOSK_*` hook.
  - So the new code avoids associative arrays, `mapfile`, `${x,,}`, `wait -n` and `printf '%(…)T'`. An empty array under `set -u` is expanded as `${a[@]+"${a[@]}"}`.
- **Character sets:** every new character set is spelled out, never a range. For example `*[!0123456789.]*`, and `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-` for git refs.
- **shellcheck:** stays clean. `setup.sh` joins the `test_shellcheck_clean` list.
- **Idempotence:** every new install path is safe to re-run, and a second run changes nothing.
- **Environments** (copied from the spec):

  | Env | Label | API | Portal | Channel | Server set |
  | --- | --- | --- | --- | --- | --- |
  | `prod` (default) | `Prod` | `https://api.serversherpa.com` | `https://portal.serversherpa.com` | `stable` | production |
  | `rc` | `RC` | `https://api.serversherpa.com` | `https://portal.serversherpa.com` | `beta` | production |
  | `dev` | `Dev` | `https://api.dev.serversherpa.com` | `https://portal.dev.serversherpa.com` | `beta` | dev |
  | `edge` | `Edge` | `https://api.dev.serversherpa.com` | `https://portal.dev.serversherpa.com` | `edge` | dev |
  | `custom` | `Custom (keep current settings)` | saved | saved | saved | from the saved API URL |

  - Recognizing a saved environment: compare both URLs (trailing `/` trimmed) and the channel. Any other combination is `custom`, and no `config.env` means `none`.
- **Data folders:**
  - production (Prod, RC): `/var/lib/serversherpa-kiosk`;
  - dev (Dev, Edge): `/var/lib/serversherpa-kiosk-dev`.
  - A saved `KIOSK_DATA_DIR` that is neither of these is custom. It is passed on unchanged and never moved.
  - Production data is never moved.
  - Testing hook: `KIOSK_VAR_LIB` (default `/var/lib`) replaces `/var/lib` in both paths.
- **Checklist minimums:**
  - Ubuntu 22.04 or newer;
  - at least 10 GB free on `/var/lib`, taken as 10485760 KiB from `df -Pk`;
  - `download.docker.com`, `dl.google.com` and `raw.githubusercontent.com` reachable;
  - `curl`, `ca-certificates` and `gpg` present.
- **Log:** `/var/log/serversherpa-kiosk-setup.log`. Testing hook: `KIOSK_SETUP_LOG`. Timestamps are 24-hour: `date '+%Y-%m-%d %H:%M:%S'`.
- **Progress steps** (labels exact, in order) and the `install.sh --step` names each one runs:
  1. `Install download tools`: `tools`
  2. `Install Docker Engine`: `docker`
  3. `Start Docker and enable it at boot`: `docker-start`
  4. `Install Google Chrome`: `chrome`
  5. `Install python3`: `python3`
  6. `Set up USB label printers`: `printers`
  7. `Download the kiosk app for the chosen environment`: `move-dev-data`, then setup's snapshot, then `download`
  8. `Start the kiosk and wait for it to be healthy`: `start`
  9. `Install kiosk mode, the Start Kiosk icon, sign-in startup and nightly updates`: `login-items`, then `launcher`
  - Steps 1, 2, 4 and 5 run only when their checklist row is `add`. Step 2 also runs when Snap Docker is `add`. Steps 3 and 6–9 always run.
- **Exact copy from the spec:**
  - `This setup supports Ubuntu 22.04 and newer.`
  - `Google Chrome isn't available for this processor.`
  - `This laptop will use a separate dev kiosk. Its production kiosk data is kept for when you switch back.`
  - its mirror, `This laptop will use a separate production kiosk. Its dev kiosk data is kept for when you switch back.`
  - `Custom (keep current settings)`
  - `Done. Sign out and back in (or restart) to start the kiosk.`
  - Row markers: `[ OK ]`, `[ ADD ]`, `[ FIX ]`. `[ -- ]` marks a row not checked yet (see Task 5).
  - Buttons: `Check again`, `Continue`, `Quit`, `Try again`, `Show details`, `Pick another environment`, `Restart now`, `Close`.
- **Copy rules:** American English. 24-hour times. No AM/PM anywhere.
- **Published command:** `wget -qO- https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/setup.sh | bash`.
- **Apt repos (vendor-documented):**
  - Keyrings go in `/etc/apt/keyrings` and sources in `/etc/apt/sources.list.d`. Each source line carries `signed-by=`.
  - Docker: `https://download.docker.com/linux/ubuntu`, key `…/gpg` saved as `docker.asc`, file `docker.list`. When `…/dists/CODENAME/Release` is missing, install Ubuntu's `docker.io` and `docker-compose-v2` instead.
  - Chrome: key `https://dl.google.com/linux/linux_signing_key.pub`, run through `gpg --dearmor` into `google-chrome.gpg`. The repo is `https://dl.google.com/linux/chrome/deb/ stable main` in `google-chrome.list`, amd64 only.
  - Testing hooks: `KIOSK_APT_KEYRINGS`, `KIOSK_APT_SOURCES`, `KIOSK_OS_RELEASE` (default `/etc/os-release`).
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **`wget … | bash` stdin.** bash is reading the script from stdin, so any child that reads stdin swallows the rest of the script. Every engine call must get `</dev/null`, and whiptail must read `/dev/tty`. Pinned by `test_engine_never_reads_the_script_pipe` (Task 7).
2. **Try again on step 7 must not re-snapshot.** A retry after `download` half-wrote the new `config.env` would otherwise snapshot the new environment, and Quit would then "restore" the wrong one. Pinned by `test_retrying_download_keeps_the_first_snapshot` (Task 7).
3. **Custom data folder.** A laptop with `KIOSK_DATA_DIR=/srv/kiosk` must keep it on every pick, and the dev move must never touch it. Pinned by `test_data_dir_for_keeps_a_custom_folder` (Task 5) and `test_move_dev_data_never_moves_a_custom_folder` (Task 4).
4. **A stale `docker.list` for a codename Docker doesn't serve.** It makes every later `apt-get update` fail. The fallback must remove it. Pinned by `test_docker_fallback_removes_a_stale_docker_list` (Task 2).
5. **Offline or no sudo at the checklist.** The engine can't be fetched or run, so the engine-backed rows show `[ -- ]` and the screen still offers only Check again and Quit, with no crash. Pinned by `test_offline_rows_are_not_checked_yet` (Task 6).

---

### Task 1: `install.sh --step NAME` (step mode)

**Files:**
- Modify: `kiosk_laptop/installer/install.sh`:
  - globals (around line 65);
  - `usage` (line 138);
  - a new `prepare_kiosk_image` after `start_kiosk` (around line 1156);
  - new `pkg_installed`, `apt_update`, `apt_install` and `ensure_download_tools` near `remove_printer_autoconfig` (around line 796);
  - `parse_args` (line 1749);
  - `main` (line 1815);
  - a new `restart_kiosk` and `run_step` before `main`.
- Create: `kiosk_laptop/installer/tests/test_install_steps.py`

**Interfaces:**
- Consumes: the existing `ensure_root`, `check_minimums`, `start_log`, `setup_docker_cli`, `ensure_docker`, `enable_docker_autostart`, `wait_for_engine`, `check_compose`, `ensure_python3`, `have_python3`, `setup_label_printers`, `merge_config`, `find_browser`, `create_data_dir`, `write_config`, `render_compose`, `migrate_legacy_data`, `start_kiosk`, `install_login_items`, `compose`, `wait_kiosk_healthy`, `keep_previous`, `pull_image`, `image_ref`, `image_id`.
- Produces (later tasks fill in the functions it names):
  - Global `STEP=''`, set by `--step NAME`.
  - `run_step NAME ARGS...`:
    - Step names: `check tools docker docker-start chrome python3 printers move-dev-data download start login-items launcher restart`.
    - Exit 0 means done. Failure goes through `die` (`Error: …` on stderr, exit 1).
    - `check` only runs `setup_docker_cli; check_rows` (no root, no log).
  - `ensure_chrome MODE` (Task 2), `check_rows` (Task 3), `install_setup_launcher` (Task 3), `move_dev_data` (Task 4). Until those tasks land, Task 1 defines one-line placeholders that `die "Not implemented yet."` so the dispatcher is testable. Each later task replaces its placeholder.
  - `prepare_kiosk_image`: tags the running image `:previous` (via `keep_previous`) before `pull_image`, and starts nothing.
  - `restart_kiosk`: `compose up -d` plus `wait_kiosk_healthy`, using whatever `docker-compose.yml` is in place.
  - `pkg_installed PKG` (0 when dpkg says `install ok installed`).
  - `apt_update`: `apt-get -o DPkg::Lock::Timeout=120 update`.
  - `apt_install PKG...`: `DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y PKG...`.
  - `ensure_download_tools`.

- [ ] **Step 1: Write the failing tests** in `tests/test_install_steps.py`

```python
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_install_steps.py`
Expected: FAIL. `run_step`, `prepare_kiosk_image`, `restart_kiosk` and `ensure_download_tools` are not defined.

- [ ] **Step 3: Implement in `install.sh`**
  - `parse_args`: add `--step) [ "$#" -ge 2 ] || die "--step needs a value."; STEP="$2"; shift 2 ;;`.
  - `usage`: add the line `  --step NAME        run one setup step (used by setup.sh on Ubuntu)`.
  - `main`, right after `load_config`:

    ```bash
    if [ -n "$STEP" ]; then
      [ "$DO_UNINSTALL" = 0 ] || die "--step and --uninstall can't be used together."
      run_step "$STEP" "$@"
      return 0
    fi
    ```

  - `run_step NAME ARGS...` (ARGS are the original arguments, so `ensure_root` re-runs the same command):
    - Die with `--step is for the Ubuntu setup (setup.sh).` unless `OS=Linux`.
    - Set `KIOSK_NONINTERACTIVE=1`.
    - `check`: runs `setup_docker_cli; check_rows; return 0`.
    - Other known names: `ensure_root "$@"; check_minimums; mkdir -p "$KIOSK_DIR"; chmod 755 "$KIOSK_DIR"; start_log "$@"`, then exactly the call lists in the test table.
    - The `chrome` step calls `ensure_chrome strict`.
    - The `python3` step ends with `have_python3 || die "python3 didn't install, so kiosk mode can't run. See the messages above, then try again."`.
    - Unknown name: `die "Unknown step '$name'. Steps: check tools docker docker-start chrome python3 printers move-dev-data download start login-items launcher restart."`. This check comes before `ensure_root`.
  - Placeholders until Tasks 2–4: `ensure_chrome() { die "Not implemented yet."; }` and the same for `check_rows`, `install_setup_launcher` and `move_dev_data`.
  - `prepare_kiosk_image`:

    ```bash
    prepare_kiosk_image() {
      local ref prev
      ref=$(image_ref)
      stop_legacy_kiosk
      prev=$("${DOCKER[@]}" inspect -f '{{.Image}}' "$KIOSK_CONTAINER" 2>/dev/null || true)
      [ -z "$prev" ] || keep_previous "$prev" "$ref" || true
      info "Downloading the kiosk image"
      pull_image
    }
    ```

  - `start_kiosk` is left unchanged. It pulls again, which is quick because the image is cached, and a retry after a rollback moves the channel tag back to the new image.
  - `restart_kiosk`:
    - Runs `compose up -d >/dev/null 2>&1 && wait_kiosk_healthy`.
    - On failure it dies with `The kiosk didn't become healthy (status: ${KIOSK_STATUS:-unknown}). See: docker compose -f "$KIOSK_DIR/docker-compose.yml" logs edge`.
    - On success it prints `info "The kiosk is running."`.
  - `ensure_download_tools`:
    - Missing tools are `curl`, `gpg` (`command -v`) and `ca-certificates` (`pkg_installed`).
    - When none is missing it prints `info "curl, ca-certificates and gpg are installed."`.
    - Otherwise it runs `apt_update && apt_install <missing>`. If that fails it dies with `Couldn't install <missing> (apt-get install). See the messages above, then try again.`.
  - Change `remove_printer_autoconfig` and `ensure_python3` to call `apt_install` / `apt-get remove` with the same lock timeout, so there is one apt idiom.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_install_steps.py kiosk_laptop/installer/tests/test_install_sh.py`
Expected: all pass. That includes `test_main_sets_up_label_printers_after_docker_and_before_the_kiosk_starts` and `test_shellcheck_clean` (skipped where shellcheck is missing).

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/installer/install.sh kiosk_laptop/installer/tests/test_install_steps.py
git commit -m "feat(kiosk-laptop): install.sh --step runs one named setup step" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Docker Engine and Google Chrome from the vendors' apt repositories

**Files:**
- Modify: `kiosk_laptop/installer/install.sh`:
  - the platform section (after `detect_os`);
  - `ensure_docker` (line 828);
  - `main`;
  - the `ensure_chrome` placeholder from Task 1.
- Modify: `kiosk_laptop/installer/tests/conftest.py` (`sh` fixture env)
- Test: `kiosk_laptop/installer/tests/test_install_steps.py`

**Interfaces:**
- Consumes: `apt_update`, `apt_install` and `pkg_installed` (Task 1); `lp_engine_present`, `lp_snap_has` and `lp_remove_snap_docker` (existing).
- Produces:
  - Constants:
    - `OS_RELEASE_FILE="${KIOSK_OS_RELEASE:-/etc/os-release}"`, `APT_KEYRINGS="${KIOSK_APT_KEYRINGS:-/etc/apt/keyrings}"` and `APT_SOURCES="${KIOSK_APT_SOURCES:-/etc/apt/sources.list.d}"`;
    - `DOCKER_APT_URL='https://download.docker.com/linux/ubuntu'`;
    - `CHROME_KEY_URL='https://dl.google.com/linux/linux_signing_key.pub'` and `CHROME_APT_URL='https://dl.google.com/linux/chrome/deb/'`.
  - `os_release_value KEY`: the value with surrounding quotes stripped, read without sourcing the file.
  - `is_ubuntu` (`ID=ubuntu`).
  - `ubuntu_codename`: `UBUNTU_CODENAME`, else `VERSION_CODENAME`.
  - `docker_repo_serves CODENAME` (0 or 1).
  - `install_docker_engine_apt` and `install_docker_engine` (each 0 or non-zero).
  - `ensure_compose_plugin` (Ubuntu only).
  - `chrome_installed`, `install_chrome_apt` and `ensure_chrome warn|strict`.

- [ ] **Step 1: Default the tests to "not Ubuntu".** In `conftest.py`'s `sh` fixture, add `"KIOSK_OS_RELEASE": str(tmp_path / "no-os-release")` to `full_env`. Otherwise the existing `_ensure_docker_linux` tests would take the apt path on the Ubuntu CI runner. The existing `get.docker.com` tests keep passing unchanged.

- [ ] **Step 2: Write the failing tests** (append to `test_install_steps.py`)

```python
def _apt_env(tmp_path, release_ok=True, ubuntu=True, codename="noble"):
    rel = tmp_path / "os-release"
    rel.write_text(f'ID={"ubuntu" if ubuntu else "debian"}\nVERSION_ID="24.04"\n'
                   f'VERSION_CODENAME={codename}\nUBUNTU_CODENAME={codename}\n')
    for d in ("keyrings", "sources"):
        (tmp_path / d).mkdir(exist_ok=True)
    calls = tmp_path / "apt.calls"
    stubs = (f'curl() {{ echo "curl $*" >> "{calls}"; case "$*" in *dists/*) return {0 if release_ok else 22};; '
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
    sh(stubs + 'install_docker_engine', env=env)
    assert not (tmp_path / "sources" / "docker.list").exists()


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
    assert f"install -y {pkg}" in calls.read_text()


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
    r = sh(stubs + 'ARCH=amd64; OS=Linux; chrome_installed() { return 1; }; ensure_chrome warn', env=env)
    assert "Couldn't install Google Chrome" in r.stderr


def test_main_installs_chrome_before_the_config_is_written():
    from conftest import INSTALL_SH
    body = INSTALL_SH.read_text()
    body = body[body.index("\nmain() {"):]
    assert body.index("setup_label_printers") < body.index("ensure_chrome warn") \
        < body.index("find_browser") < body.index("write_config")
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_install_steps.py -k "docker or chrome or compose"`
Expected: FAIL. The functions are missing, and `ensure_chrome` is still the placeholder.

- [ ] **Step 4: Implement**
  - `install_docker_engine_apt`, following Docker's documented steps:

    ```bash
    install_docker_engine_apt() {
      local codename key="$APT_KEYRINGS/docker.asc" list="$APT_SOURCES/docker.list"
      codename=$(ubuntu_codename)
      [ -n "$codename" ] || { warn "Couldn't read this Ubuntu's codename from $OS_RELEASE_FILE."; return 1; }
      if docker_repo_serves "$codename"; then
        install -m 0755 -d "$APT_KEYRINGS" || return 1
        curl -fsSL "$DOCKER_APT_URL/gpg" -o "$key" || return 1
        chmod a+r "$key"
        printf 'deb [arch=%s signed-by=%s] %s %s stable\n' "$(dpkg --print-architecture)" "$key" \
          "$DOCKER_APT_URL" "$codename" >"$list" || return 1
        apt_update && apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      else
        info "Docker's apt repository doesn't serve Ubuntu $codename yet; installing Ubuntu's docker.io and docker-compose-v2 instead."
        rm -f "$list"
        apt_update && apt_install docker.io docker-compose-v2
      fi
    }
    ```

  - `docker_repo_serves`: `curl -fsSI --max-time 15 "$DOCKER_APT_URL/dists/$1/Release" >/dev/null 2>&1`.
  - `install_docker_engine`:
    - On Ubuntu it prints `info "Installing Docker Engine (Docker's apt repository)"`, then runs `install_docker_engine_apt`.
    - Elsewhere it keeps today's `info "Installing Docker Engine (get.docker.com)"; curl -fsSL https://get.docker.com | sh`.
  - `ensure_docker` (Linux branch): replace the inline `curl … | sh || die` with `install_docker_engine || die "Docker Engine didn't install. See the messages above, then re-run."`, then call `ensure_compose_plugin` before `lp_remove_snap_docker`.
  - `ensure_compose_plugin`:
    - Acts only when `is_ubuntu`, `lp_engine_present` holds, and `"${DOCKER[@]}" compose version` fails.
    - It installs `docker-compose-plugin` when `pkg_installed docker-ce`, else `docker-compose-v2`. A failure here is a `warn` only, because `check_compose` reports it later.
  - `chrome_installed`: `command -v google-chrome-stable >/dev/null 2>&1`.
  - `install_chrome_apt`:
    - `install -m 0755 -d "$APT_KEYRINGS"`.
    - `curl -fsSL "$CHROME_KEY_URL" | gpg --dearmor --yes -o "$APT_KEYRINGS/google-chrome.gpg"`, then `chmod a+r`.
    - Write `google-chrome.list` with exactly the line in the test.
    - `apt_update && apt_install google-chrome-stable`.
    - Comment that Chrome's package keeps the same `google-chrome.list` file name, so there is never a second, conflicting entry.
  - `ensure_chrome MODE`:
    - Returns 0 unless `OS=Linux`.
    - When `chrome_installed`, prints `info "Google Chrome is installed."`.
    - Off Ubuntu: `warn` mode returns 0; `strict` mode dies with `This setup supports Ubuntu 22.04 and newer.`.
    - `ARCH` other than `amd64`: prints the exact processor message through `warn` and returns 0, or `die`s in strict mode.
    - Install failure, strict: dies with `Google Chrome didn't install. See the messages above, then try again.`.
    - Install failure, warn: `warn "Couldn't install Google Chrome; the kiosk uses another browser if one is installed."`.
  - `main`: after `setup_label_printers` insert `ensure_chrome warn` and then `find_browser`, so `write_config` records `KIOSK_BROWSER=/usr/bin/google-chrome` (this also re-runs the `find_browser` that `preflight` already ran).
- Also update the `install.sh` header comment and the `usage` text: on Ubuntu, Docker and Chrome come from the vendors' apt repositories.

- [ ] **Step 5: Run the full installer suite**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests`
Expected: all pass, the existing `test_ensure_docker_*` tests included.

- [ ] **Step 6: Commit**

```bash
git add kiosk_laptop/installer/install.sh kiosk_laptop/installer/tests/conftest.py kiosk_laptop/installer/tests/test_install_steps.py
git commit -m "feat(kiosk-laptop): Docker and Chrome from the vendors' apt repositories on Ubuntu" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `check` rows and the "Set up kiosk" launcher

**Files:**
- Modify: `kiosk_laptop/installer/install.sh`:
  - the `check_rows` and `install_setup_launcher` placeholders;
  - `install_start_icon` (line 1218);
  - `remove_login_items` (line 1576);
  - the `uninstall` file list (line 1733).
- Test: `kiosk_laptop/installer/tests/test_install_steps.py`

**Interfaces:**
- Consumes: `lp_engine_present`, `lp_snap_has`, `lp_udev_rule`, `lp_modprobe_conf`, `lp_usblp_loaded`, `lp_zebra_queues`, `chrome_installed` (Task 2), `have_python3`, `desktop_user`, `user_home`, `user_desktop_dir`, `write_as_user`, `as_user`, `exec_path`, `safe_ref`.
- Produces:
  - `check_rows` prints one line per row, `row|ID|STATE|NOTE`.
    - IDs, in this order: `docker snapdocker chrome python3 printers kiosk`.
    - STATE is `ok`, `add` or `fix`.
    - Notes never contain `|`.
  - `printers_ok`: 0 when the udev rule and modprobe file hold exactly the rendered text, usblp isn't loaded, and `lpstat -v` lists no USB Zebra queue.
  - `install_desktop_icon USER HOME FILE RENDER_FN LABEL`: the generalized `install_start_icon` body. `install_start_icon USER HOME` becomes `install_desktop_icon "$1" "$2" "$START_ICON_FILE" render_start_icon "Start Kiosk"`.
  - Constants: `SETUP_ICON_FILE='serversherpa-setup-kiosk.desktop'` and `SETUP_RUNNER='setup-kiosk.sh'`.
  - `render_setup_runner FILE`, `render_setup_icon FILE` and `install_setup_launcher`.

- [ ] **Step 1: Write the failing tests**

```python
from conftest import lp_stubs  # noqa: E402

CHECK = ('ARCH=amd64; chrome_installed() { :; }; have_python3() { :; }; printers_ok() { :; }; '
         'lp_engine_present() { :; }; lp_snap_has() { return 1; }; '
         'systemctl() { return 0; }; DOCKER=(true); ')


def _rows(out):
    return {line.split("|")[1]: line.split("|")[2:] for line in out.splitlines() if line.startswith("row|")}


def test_check_rows_all_installed(sh, tmp_path):
    (tmp_path / "docker-compose.yml").write_text("x")
    fake = tmp_path / "d"; fake.write_text('#!/bin/sh\necho healthy\n'); fake.chmod(0o755)
    rows = _rows(sh(CHECK + f'KIOSK_DIR="{tmp_path}"; DOCKER=("{fake}"); check_rows').stdout)
    assert list(rows) == ["docker", "snapdocker", "chrome", "python3", "printers", "kiosk"]
    assert all(state == "ok" for state, _ in rows.values())


def test_check_rows_missing_things_are_add(sh, tmp_path):
    out = sh(CHECK + f'KIOSK_DIR="{tmp_path}"; lp_engine_present() {{ return 1; }}; '
             'lp_snap_has() { [ "$1" = docker ]; }; chrome_installed() { return 1; }; '
             'have_python3() { return 1; }; printers_ok() { return 1; }; check_rows').stdout
    rows = _rows(out)
    assert rows["docker"] == ["add", "will be installed"]
    assert rows["snapdocker"] == ["add", "will be replaced"]
    assert rows["chrome"] == ["add", "will be installed"]
    assert rows["python3"] == ["add", "will be installed"]
    assert rows["printers"] == ["add", "will be set up"]
    assert rows["kiosk"] == ["add", "will be installed"]


def test_check_rows_engine_not_running_and_kiosk_unhealthy(sh, tmp_path):
    (tmp_path / "docker-compose.yml").write_text("x")
    fake = tmp_path / "d"; fake.write_text('#!/bin/sh\necho unhealthy\n'); fake.chmod(0o755)
    rows = _rows(sh(CHECK + f'KIOSK_DIR="{tmp_path}"; DOCKER=("{fake}"); '
                    'systemctl() { [ "$1" != is-active ]; }; check_rows').stdout)
    assert rows["docker"] == ["add", "installed; will be started"]
    assert rows["kiosk"] == ["add", "installed, not healthy (unhealthy); will be started"]


def test_check_rows_chrome_on_arm64_is_a_problem(sh, tmp_path):
    rows = _rows(sh(CHECK + f'KIOSK_DIR="{tmp_path}"; ARCH=arm64; chrome_installed() {{ return 1; }}; check_rows').stdout)
    assert rows["chrome"] == ["fix", "Google Chrome isn't available for this processor."]


def test_printers_ok_follows_the_printer_block(sh, tmp_path):
    stubs = lp_stubs(tmp_path, usblp=False, lpstat="")
    assert sh(stubs + 'printers_ok && echo yes || echo no').stdout.strip() == "no"
    sh(stubs + 'lp_ensure_udev_rule; lp_ensure_no_usblp')
    assert sh(stubs + 'printers_ok && echo yes || echo no').stdout.strip() == "yes"
    from conftest import LPSTAT_V
    stubs = lp_stubs(tmp_path, usblp=False, lpstat=LPSTAT_V)
    assert sh(stubs + 'printers_ok && echo yes || echo no').stdout.strip() == "no"


def _launcher_env(tmp_path):
    inst = tmp_path / "inst"; inst.mkdir()
    home = tmp_path / "uhome"; home.mkdir()
    return inst, home, (f'KIOSK_DIR="{inst}"; desktop_user() {{ printf alice; }}; '
                        f'user_home() {{ printf "%s" "{home}"; }}; as_user() {{ shift; "$@"; }}; '
                        'xdg-user-dir() { return 1; }; id() { echo 501; }; ')


def test_setup_launcher_runs_a_fresh_setup_from_the_ref(sh, tmp_path):
    inst, home, stubs = _launcher_env(tmp_path)
    sh(stubs + 'install_setup_launcher', env={"KIOSK_INSTALLER_REF": "release/1.2"})
    runner = (inst / "setup-kiosk.sh")
    assert runner.stat().st_mode & 0o777 == 0o755
    text = runner.read_text()
    assert text.startswith("#!/usr/bin/env bash\n")
    assert ("https://raw.githubusercontent.com/encondata/BaseCampV3/release/1.2/kiosk_laptop/installer/setup.sh"
            in text)
    icon = (home / "Desktop" / "serversherpa-setup-kiosk.desktop")
    assert icon.stat().st_mode & 0o777 == 0o755
    t = icon.read_text()
    assert "Name=Set up kiosk\n" in t and f"Exec={inst}/setup-kiosk.sh\n" in t and "Terminal=true\n" in t
    import subprocess
    from conftest import BASH
    assert subprocess.run([BASH, "-n", str(runner)]).returncode == 0


def test_setup_launcher_is_idempotent_and_ignores_an_unsafe_ref(sh, tmp_path):
    inst, home, stubs = _launcher_env(tmp_path)
    sh(stubs + 'install_setup_launcher; install_setup_launcher', env={"KIOSK_INSTALLER_REF": "a;rm"})
    assert "/main/kiosk_laptop/installer/setup.sh" in (inst / "setup-kiosk.sh").read_text()


def test_setup_launcher_without_desktop_user_warns(sh, tmp_path):
    inst, home, stubs = _launcher_env(tmp_path)
    r = sh(stubs + 'desktop_user() { :; }; install_setup_launcher')
    assert "Set up kiosk" in r.stderr and (inst / "setup-kiosk.sh").exists()


def test_uninstall_removes_the_setup_launcher(sh, tmp_path):
    inst, home, stubs = _launcher_env(tmp_path)
    sh(stubs + 'install_setup_launcher')
    sh(stubs + f'OS=Linux; SYSTEMD_UNIT_DIR="{tmp_path}"; systemctl() {{ :; }}; '
       'restore_desktop_lock() { :; }; remove_login_items')
    assert not (home / "Desktop" / "serversherpa-setup-kiosk.desktop").exists()
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_install_steps.py -k "check_rows or printers_ok or launcher"`
Expected: FAIL (the placeholders `die`, and `printers_ok` is missing).

- [ ] **Step 3: Implement**
  - `check_rows` notes (exact):

    | Row | State | Condition | Note |
    | --- | --- | --- | --- |
    | docker | ok | engine present, `systemctl is-active --quiet docker.service`, `systemctl is-enabled --quiet docker.service` and `"${DOCKER[@]}" compose version` all succeed | `running` |
    | docker | add | engine present, but any of those checks fails | `installed; will be started` |
    | docker | add | no engine | `will be installed` |
    | snapdocker | add | `lp_snap_has docker` | `will be replaced` |
    | snapdocker | ok | otherwise | `not installed` |
    | chrome | fix | `ARCH` isn't `amd64` and Chrome isn't installed | `Google Chrome isn't available for this processor.` |
    | chrome | ok | installed | `installed` |
    | chrome | add | otherwise | `will be installed` |
    | python3 | ok / add | | `installed` / `will be installed` |
    | printers | ok / add | | `set up` / `will be set up` |
    | kiosk | add | no `$KIOSK_DIR/docker-compose.yml` | `will be installed` |
    | kiosk | ok | health `healthy` | `running` |
    | kiosk | add | other health | `installed, not healthy (${status:-stopped}); will be started` |

    - Kiosk health comes from `"${DOCKER[@]}" inspect -f '{{.State.Health.Status}}' "$KIOSK_CONTAINER"`.
    - A missing compose plugin makes the docker row `add` (`installed; will be started`). Setup runs step 2 whenever the docker row is `add` (Task 7, `step_needed`), and there Task 2's `ensure_compose_plugin` installs the plugin. With the engine already present, `ensure_docker` only reports it, so the extra run is harmless.
  - `printers_ok`: compares `$(cat "$LP_UDEV_RULES")` with `$(lp_udev_rule)` and `$LP_MODPROBE_CONF` with `$(lp_modprobe_conf)`, then checks `! lp_usblp_loaded` and an empty `LC_ALL=C lpstat -v 2>/dev/null | lp_zebra_queues`. When `lpstat` is missing, the queue part passes. Put it after `setup_label_printers`, outside the shared `>>> USB label printers` block, so the drift test stays green.
  - `render_setup_runner FILE`: the ref is baked in with `safe_ref "${KIOSK_INSTALLER_REF:-main}"`. Its content:

    ```bash
    #!/usr/bin/env bash
    # Set up kiosk (desktop launcher): runs the newest setup.sh, downloaded fresh each time.
    url='https://raw.githubusercontent.com/encondata/BaseCampV3/REF/kiosk_laptop/installer/setup.sh'
    tmp=$(mktemp "${TMPDIR:-/tmp}/kiosk-setup.XXXXXX") || exit 1
    rc=0
    if wget -qO "$tmp" "$url" 2>/dev/null || curl -fsSL "$url" -o "$tmp" 2>/dev/null; then
      bash "$tmp" "$@" || rc=$?
    else
      echo "Couldn't download the kiosk setup from $url. Check the network, then try again."
      rc=1
    fi
    rm -f "$tmp"
    if [ "$rc" != 0 ]; then printf 'Press Enter to close this window.'; read -r _ </dev/tty; fi
    exit "$rc"
    ```

  - `render_setup_icon FILE` writes these lines:
    - `[Desktop Entry]`, `Type=Application`, `Name=Set up kiosk`;
    - `Comment=Install, update or switch the ServerSherpa kiosk`;
    - `Exec=$(exec_path "$KIOSK_DIR/$SETUP_RUNNER")`;
    - `Icon=system-software-install`, `Terminal=true`.
  - `install_setup_launcher`:
    - Writes the runner to `$KIOSK_DIR/$SETUP_RUNNER`, mode 755, through a temp file and `mv`. Step mode runs as root, so the file is root's; don't `chown` it.
    - Then `user=$(desktop_user)`. With no user it warns `No desktop user found, so the Set up kiosk icon wasn't added. Run $KIOSK_DIR/$SETUP_RUNNER to set up again.`.
    - Otherwise it runs `install_desktop_icon "$user" "$(user_home "$user")" "$SETUP_ICON_FILE" render_setup_icon "Set up kiosk"`. The icon is trusted with `gio` exactly like Start Kiosk.
  - `remove_login_items` (Linux, with a user): also `rm -f "$(user_desktop_dir "$user" "$home")/$SETUP_ICON_FILE"`. Add `"$SETUP_RUNNER"` to `uninstall`'s file list and `rm -rf "${KIOSK_DIR:?}/setup-snapshot"`.
  - The test laptop's own `update-kiosk.sh` and `install-kiosk.sh` are never touched.

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests`
Expected: all pass, `test_start_icon_matches_kiosk_session` and the label-printer drift test included.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/installer/install.sh kiosk_laptop/installer/tests/test_install_steps.py
git commit -m "feat(kiosk-laptop): install.sh check rows and the Set up kiosk launcher" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: One-time move of dev data to its own folder (`move-dev-data`)

**Files:**
- Modify: `kiosk_laptop/installer/install.sh`:
  - constants next to `DEFAULT_API_URL` (line 81);
  - the `move_dev_data` placeholder;
  - a new `set_config_line` next to `write_config`.
- Test: `kiosk_laptop/installer/tests/test_install_steps.py`

**Interfaces:**
- Consumes: `load_config` (already run by `main` before `run_step`), `CFG_API_URL`, `CFG_DATA_DIR`, `CFG_CHANNEL`, `render_compose`, `compose`, `docker_answers`, `check_data_dir`.
- Produces:
  - `DEV_API_URL='https://api.dev.serversherpa.com'`;
  - `PROD_DATA_DIR="${KIOSK_VAR_LIB:-/var/lib}/serversherpa-kiosk"` and `DEV_DATA_DIR="${KIOSK_VAR_LIB:-/var/lib}/serversherpa-kiosk-dev"`;
  - `set_config_line FILE KEY VALUE`: replaces that key's line, or appends it, keeping every other line. It writes atomically and leaves the file at mode 644.
  - `move_dev_data`: 0 when there is nothing to do or the move worked; `die`s on a conflict.
  - It never calls `merge_config`, because the move belongs to the *saved* environment, not the chosen one.

- [ ] **Step 1: Write the failing tests**

```python
def _saved(tmp_path, api, data_dir, channel="beta"):
    inst = tmp_path / "inst"; inst.mkdir(exist_ok=True)
    (inst / "config.env").write_text(
        f"EDGE_CLOUD_API_URL={api}\nEDGE_PORTAL_URL=https://portal.x\nKIOSK_CHANNEL={channel}\n"
        f"KIOSK_DATA_DIR={data_dir}\nKIOSK_BROWSER=/usr/bin/google-chrome\nKIOSK_INSTALLER_REF=main\n")
    (inst / "docker-compose.yml").write_text("old\n")
    varlib = tmp_path / "varlib"; varlib.mkdir(exist_ok=True)
    calls = tmp_path / "docker.calls"
    fake = tmp_path / "docker"; fake.write_text(f'#!/bin/sh\necho "$*" >> "{calls}"\n'); fake.chmod(0o755)
    body = (f'KIOSK_DIR="{inst}"; DOCKER=("{fake}"); load_config "{inst}/config.env"; move_dev_data')
    return inst, varlib, calls, body, {"KIOSK_VAR_LIB": str(varlib), "KIOSK_IMAGE": ""}


def test_move_dev_data_moves_a_dev_laptops_folder_once(sh, tmp_path):
    varlib = tmp_path / "varlib"; varlib.mkdir()
    prod = varlib / "serversherpa-kiosk"; prod.mkdir(); (prod / "identity.json").write_text("dev-id")
    inst, _, calls, body, env = _saved(tmp_path, "https://api.dev.serversherpa.com/", str(prod), channel="edge")
    r = sh(body, env=env)
    dev = varlib / "serversherpa-kiosk-dev"
    assert (dev / "identity.json").read_text() == "dev-id" and not prod.exists()
    cfg = (inst / "config.env").read_text()
    assert f"KIOSK_DATA_DIR={dev}\n" in cfg and "KIOSK_BROWSER=/usr/bin/google-chrome\n" in cfg
    compose = (inst / "docker-compose.yml").read_text()
    assert f'"{dev}:/data"' in compose and "serversherpa-kiosk-laptop:edge" in compose
    assert "compose" in calls.read_text() and " stop" in calls.read_text()
    assert "Moved the dev kiosk's data" in r.stdout
    sh(body, env=env)   # second run: config now names the dev folder -> nothing to do
    assert (dev / "identity.json").exists()


def test_move_dev_data_never_moves_production_data(sh, tmp_path):
    varlib = tmp_path / "varlib"; varlib.mkdir()
    prod = varlib / "serversherpa-kiosk"; prod.mkdir(); (prod / "identity.json").write_text("prod-id")
    inst, _, calls, body, env = _saved(tmp_path, "https://api.serversherpa.com", str(prod), channel="stable")
    sh(body, env=env)
    assert (prod / "identity.json").read_text() == "prod-id"
    assert not (varlib / "serversherpa-kiosk-dev").exists() and not calls.exists()


def test_move_dev_data_never_moves_a_custom_folder(sh, tmp_path):
    custom = tmp_path / "srv-kiosk"; custom.mkdir(); (custom / "identity.json").write_text("x")
    inst, varlib, calls, body, env = _saved(tmp_path, "https://api.dev.serversherpa.com", str(custom))
    sh(body, env=env)
    assert (custom / "identity.json").exists() and not (varlib / "serversherpa-kiosk-dev").exists()


def test_move_dev_data_without_config_does_nothing(sh, tmp_path):
    r = sh(f'KIOSK_DIR="{tmp_path}"; DOCKER=(false); load_config "{tmp_path}/none"; move_dev_data; echo rc=$?',
           env={"KIOSK_VAR_LIB": str(tmp_path)})
    assert "rc=0" in r.stdout


def test_move_dev_data_refuses_when_both_folders_hold_data(sh, tmp_path):
    varlib = tmp_path / "varlib"; varlib.mkdir()
    prod = varlib / "serversherpa-kiosk"; prod.mkdir(); (prod / "edge.db").write_text("a")
    dev = varlib / "serversherpa-kiosk-dev"; dev.mkdir(); (dev / "edge.db").write_text("b")
    inst, _, _, body, env = _saved(tmp_path, "https://api.dev.serversherpa.com", str(prod))
    r = sh(body, env=env, check=False)
    assert r.returncode != 0 and "Both" in r.stderr and "Move one of them aside" in r.stderr
    assert (prod / "edge.db").read_text() == "a" and (dev / "edge.db").read_text() == "b"


def test_move_dev_data_into_an_empty_dev_folder(sh, tmp_path):
    varlib = tmp_path / "varlib"; varlib.mkdir()
    prod = varlib / "serversherpa-kiosk"; prod.mkdir(); (prod / "edge.db").write_text("a")
    (varlib / "serversherpa-kiosk-dev").mkdir()
    inst, _, _, body, env = _saved(tmp_path, "https://api.dev.serversherpa.com", str(prod))
    sh(body, env=env)
    assert (varlib / "serversherpa-kiosk-dev" / "edge.db").read_text() == "a"


def test_set_config_line_keeps_other_lines(sh, tmp_path):
    f = tmp_path / "c.env"; f.write_text("A=1\nB=2\n")
    sh(f'set_config_line "{f}" B 3; set_config_line "{f}" C 4')
    assert f.read_text() == "A=1\nB=3\nC=4\n" and oct(f.stat().st_mode & 0o777) == "0o644"
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_install_steps.py -k "move_dev_data or set_config_line"`
Expected: FAIL.

- [ ] **Step 3: Implement `move_dev_data`.** The rules, in order:
  1. Return 0 unless `$KIOSK_DIR/config.env` exists.
  2. Strip trailing `/` from `CFG_API_URL` and `CFG_DATA_DIR`. Return 0 unless the API equals `$DEV_API_URL`.
  3. Return 0 unless the data dir is empty or equals `$PROD_DATA_DIR`. A custom folder is never moved.
  4. Return 0 when `$PROD_DATA_DIR` doesn't exist.
  5. If `$DEV_DATA_DIR` exists and isn't empty (`ls -A`), `die "Both $PROD_DATA_DIR and $DEV_DATA_DIR hold kiosk data. Move one of them aside, then try again."`.
  6. If the compose file exists and `docker_answers`, run `compose stop >/dev/null 2>&1 || die "Couldn't stop the kiosk to move its data. Check 'systemctl status docker', then try again."`.
  7. Run `rmdir "$DEV_DATA_DIR" 2>/dev/null || true; mv "$PROD_DATA_DIR" "$DEV_DATA_DIR" || die …`.
  8. Set `KIOSK_DATA_DIR="$DEV_DATA_DIR"` and `CFG_DATA_DIR="$DEV_DATA_DIR"`, then `set_config_line "$KIOSK_DIR/config.env" KIOSK_DATA_DIR "$DEV_DATA_DIR"`, then `render_compose "$KIOSK_DIR/docker-compose.yml"`. The compose file uses the saved `CFG_CHANNEL`, so the snapshot setup takes next is still the old environment.
  9. Print `info "Moved the dev kiosk's data from $PROD_DATA_DIR to $DEV_DATA_DIR (production and dev kiosks now keep separate data)."`.
  - It starts nothing. Step 8 (`start`) brings the kiosk back.
  - `set_config_line`: validate with `check_config_value`, then use `awk -v k="$2" -v v="$3"` into `mktemp "$1.XXXXXX"`, then `chmod 644` and `mv`.

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/installer/install.sh kiosk_laptop/installer/tests/test_install_steps.py
git commit -m "feat(kiosk-laptop): move a dev laptop's data to its own folder, never production data" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `setup.sh` foundations: environments, data folders and system checks

**Files:**
- Create: `kiosk_laptop/installer/setup.sh`
- Modify: `kiosk_laptop/installer/tests/conftest.py` (add `SETUP_SH`, the stubs and the `setup` fixture)
- Modify: `kiosk_laptop/installer/tests/test_install_sh.py` (`test_shellcheck_clean` list: add `setup.sh`)
- Create: `kiosk_laptop/installer/tests/test_setup_sh.py`

**Interfaces:**
- Consumes: the `install.sh --step check` output format from Task 3 (`row|ID|STATE|NOTE`).
- Produces (all in `setup.sh`; Tasks 6 and 7 use these names):
  - **Script shape:**
    - Header usage comment and `# Written for bash 3.2 (macOS's bash).`, then `set -u -o pipefail`. There is no `-e`: dialogs return non-zero on purpose.
    - The last line is `if [ "${KIOSK_SETUP_LIB:-0}" != 1 ]; then main "$@"; exit $?; fi`.
  - **Hooks and globals:**
    - `KIOSK_DIR="${KIOSK_DIR:-/opt/serversherpa-kiosk}"`, `VAR_LIB="${KIOSK_VAR_LIB:-/var/lib}"`, `PROD_DATA_DIR="$VAR_LIB/serversherpa-kiosk"`, `DEV_DATA_DIR="$VAR_LIB/serversherpa-kiosk-dev"`.
    - `OS_RELEASE_FILE="${KIOSK_OS_RELEASE:-/etc/os-release}"`.
    - `SETUP_LOG="${KIOSK_SETUP_LOG:-/var/log/serversherpa-kiosk-setup.log}"`.
    - `TTY_IN="${KIOSK_TTY:-/dev/tty}"`, `TTY_OUT="${KIOSK_TTY_OUT:-/dev/tty}"`.
    - `ENGINE="${KIOSK_SETUP_ENGINE:-}"`.
    - `MIN_FREE_KIB=10485760`.
  - **Environment table:**
    - Constants `PROD_API`, `PROD_PORTAL`, `DEV_API`, `DEV_PORTAL`.
    - `env_api ENV`, `env_portal ENV`, `env_channel ENV`, `env_label ENV`. `custom` reads `SAVED_API`, `SAVED_PORTAL` and `SAVED_CHANNEL`.
    - `env_server_set ENV`: `prod`, `dev` or `other`. `custom` goes through `url_server_set "$SAVED_API"`.
    - `url_server_set URL`: `prod`, `dev` or `other`.
  - **Saved configuration:**
    - `load_saved_config` sets `HAVE_CONFIG` (0 or 1) and `SAVED_API`, `SAVED_PORTAL`, `SAVED_CHANNEL`, `SAVED_DATA_DIR` from `$KIOSK_DIR/config.env`, read without sourcing it.
    - `detect_env API PORTAL CHANNEL`: `prod`, `rc`, `dev`, `edge` or `custom`.
    - `current_env`: `none` when `HAVE_CONFIG=0`, else `detect_env` of the saved values.
  - **Data folders and notes:**
    - `data_dir_for ENV`: the folder to pass as `KIOSK_DATA_DIR`. It is empty for `custom`, and a custom saved folder is returned unchanged.
    - `server_set_note FROM TO`: the one-line switch note, or empty.
  - **System helpers:**
    - `safe_ref REF` (spelled-out characters).
    - `BASE_URL`.
    - `is_root`.
    - `as_root CMD...`: runs directly when root, else `sudo -n CMD...`.
    - `have_cmd NAME`, `pkg_installed PKG`, `free_kib PATH`, `net_ok URL`, `download URL DEST`, `ubuntu_version_ok VERSION`.
  - **Checklist rows:**
    - `ROW_IDS=(ubuntu admin internet disk tools docker snapdocker chrome python3 printers kiosk)`.
    - `ROW_LABELS` (in the same order): `Ubuntu version`, `Administrator rights`, `Internet`, `Disk space`, `Download tools`, `Docker Engine`, `Snap Docker`, `Google Chrome`, `python3`, `USB label printers`, `Kiosk`.
    - Parallel arrays `ROW_STATES` and `ROW_NOTES`, where a state is `ok`, `add`, `fix` or `--`.
    - `row_set ID STATE NOTE`, `row_state ID`, `row_note ID`, `row_marker STATE` (`[ OK ]`, `[ ADD ]`, `[ FIX ]`, `[ -- ]`).
  - **Checks:**
    - `check_ubuntu`, `check_admin`, `check_internet`, `check_disk`, `check_tools`.
    - `fetch_engine`: 0 when `ENGINE` is a readable file. It downloads `install.sh` from `$BASE_URL` when `ENGINE` is empty.
    - `engine_checks`.
    - `run_checks` (all of the above, in row order).
    - `has_problems`: 0 when any row is `fix`.
    - `run_engine STEP LOG`, which Task 7 also uses: `as_root env KIOSK_NONINTERACTIVE=1 KIOSK_DIR="$KIOSK_DIR" ${ENGINE_DATA_DIR:+KIOSK_DATA_DIR=$ENGINE_DATA_DIR} KIOSK_INSTALLER_REF=… [KIOSK_TEMPLATE_DIR=…] bash "$ENGINE" --step STEP --yes ${ENGINE_ARGS[@]+…} </dev/null >>LOG 2>&1`.
  - **Engine arguments:** globals `ENGINE_ARGS=()` and `ENGINE_DATA_DIR=''`, set by `set_engine_args ENV`.

- [ ] **Step 1: Add the test fixture to `conftest.py`**

```python
SETUP_SH = INSTALL_SH.parent / "setup.sh"

# whiptail stub: logs each call (one arg per line, then ----); --gauge input
# goes to WT_LOG.gauge; --infobox needs no answer; every other dialog takes the
# next line of WT_ANSWERS ("RC [OUTPUT]") and prints OUTPUT on stderr, as
# whiptail does. No answers left = Esc (255), so a test never hangs.
WHIPTAIL = r'''#!/bin/sh
{ for a in "$@"; do printf '%s\n' "$a"; done; echo ----; } >> "$WT_LOG"
case " $* " in
  *" --gauge "*) cat >> "$WT_LOG.gauge"; exit 0 ;;
  *" --infobox "*) exit 0 ;;
esac
[ -s "$WT_ANSWERS" ] || exit 255
line=$(head -n 1 "$WT_ANSWERS")
tail -n +2 "$WT_ANSWERS" > "$WT_ANSWERS.t"; mv "$WT_ANSWERS.t" "$WT_ANSWERS"
rc=${line%% *}; out=''
[ "$rc" = "$line" ] || out=${line#* }
printf '%s' "$out" >&2
exit "$rc"
'''

# sudo stub: -v / -n true succeed unless SUDO_FAIL is set; otherwise runs the command.
SUDO = r'''#!/bin/sh
echo "sudo $*" >> "$SUDO_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n) shift ;;
    -v|true) [ -z "${SUDO_FAIL:-}" ]; exit $? ;;
    *) break ;;
  esac
done
exec "$@"
'''

# A fake install.sh: logs "STEP|ARGS|KIOSK_DATA_DIR|stdin=N" to engine.log
# (N = bytes it could read from stdin); --step check prints engine.rows; a
# step listed in engine.fail fails once per line (printing "Error: STEP broke");
# download writes "changed" into $KIOSK_DIR/config.env first, like the real one.
ENGINE = r'''#!/usr/bin/env bash
d="$(dirname "$0")"; step=''; all="$*"
while [ "$#" -gt 0 ]; do [ "$1" = --step ] && step="$2"; shift; done
input=$(cat)
printf '%s|%s|%s|stdin=%s\n' "$step" "$all" "${KIOSK_DATA_DIR:-}" "${#input}" >> "$d/engine.log"
if [ "$step" = check ]; then cat "$d/engine.rows" 2>/dev/null; exit 0; fi
[ "$step" != download ] || [ ! -f "$KIOSK_DIR/config.env" ] || echo changed > "$KIOSK_DIR/config.env"
if [ -f "$d/engine.fail" ] && grep -qx "$step" "$d/engine.fail"; then
  awk -v s="$step" '!done && $0 == s { done = 1; next } { print }' "$d/engine.fail" > "$d/engine.fail.t"
  mv "$d/engine.fail.t" "$d/engine.fail"
  echo "Working on $step"; echo "Error: $step broke" >&2; exit 1
fi
echo "Did $step"
'''

ALL_ROWS_OK = "".join(f"row|{r}|ok|fine\n" for r in
                      ("docker", "snapdocker", "chrome", "python3", "printers", "kiosk"))
SYS_OK = 'free_kib() { echo 99999999; }; net_ok() { :; }; have_cmd() { :; }; pkg_installed() { :; }; '


@pytest.fixture
def setup(tmp_path):
    """Run `body` with setup.sh sourced in library mode; stubs on PATH.
    Returns (CompletedProcess, tmp_path)."""
    bin_ = tmp_path / "bin"; bin_.mkdir()
    for name, text in (("whiptail", WHIPTAIL), ("sudo", SUDO)):
        (bin_ / name).write_text(text); (bin_ / name).chmod(0o755)
    engine = tmp_path / "engine.sh"; engine.write_text(ENGINE); engine.chmod(0o755)
    (tmp_path / "engine.rows").write_text(ALL_ROWS_OK)
    osr = tmp_path / "os-release"
    osr.write_text('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n')
    (tmp_path / "opt").mkdir()

    def run(body, env=None, check=True, answers=(), tty=""):
        (tmp_path / "answers").write_text("".join(f"{a}\n" for a in answers))
        (tmp_path / "tty").write_text(tty)
        full_env = {**os.environ, "KIOSK_SETUP_LIB": "1", "PATH": f"{bin_}:{os.environ['PATH']}",
                    "WT_LOG": str(tmp_path / "wt.log"), "WT_ANSWERS": str(tmp_path / "answers"),
                    "SUDO_LOG": str(tmp_path / "sudo.log"), "KIOSK_TTY": str(tmp_path / "tty"),
                    "KIOSK_TTY_OUT": str(tmp_path / "tty.out"), "KIOSK_SETUP_ENGINE": str(engine),
                    "KIOSK_SETUP_LOG": str(tmp_path / "setup.log"), "KIOSK_OS_RELEASE": str(osr),
                    "KIOSK_DIR": str(tmp_path / "opt"), "KIOSK_VAR_LIB": str(tmp_path / "varlib"),
                    "KIOSK_SETUP_POLL_S": "0.05", "TERM": "xterm", **(env or {})}
        proc = subprocess.run([BASH, "-c", f'source "{SETUP_SH}"; {body}'], input="leftover script text\n",
                              capture_output=True, text=True, env=full_env, cwd=tmp_path, timeout=60)
        if check and proc.returncode != 0:
            raise AssertionError(f"exit {proc.returncode}\nstdout:{proc.stdout}\nstderr:{proc.stderr}")
        return proc
    return run
```

- [ ] **Step 2: Write the failing tests** in `tests/test_setup_sh.py`

```python
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
    out = setup('load_saved_config; set_engine_args custom; echo "${#ENGINE_ARGS[@]}|$ENGINE_DATA_DIR"').stdout
    assert out == "0|"
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_setup_sh.py`
Expected: FAIL (`setup.sh` doesn't exist).

- [ ] **Step 4: Create `setup.sh` with the functions above.** Points the signatures and tests leave open:
  - **`detect_env`:**
    - Trim every trailing `/` from both URLs.
    - Production = `PROD_API`+`PROD_PORTAL`, and dev = `DEV_API`+`DEV_PORTAL`.
    - The mapping is `prod`+`stable`→prod, `prod`+`beta`→rc, `dev`+`beta`→dev and `dev`+`edge`→edge. Anything else is custom.
  - **`data_dir_for ENV`:**
    - Trim the trailing `/` from `SAVED_DATA_DIR`.
    - If it is set and is neither `PROD_DATA_DIR` nor `DEV_DATA_DIR`, print it and return.
    - `custom` prints nothing.
    - Otherwise print `DEV_DATA_DIR` for the dev set, else `PROD_DATA_DIR`.
  - **`server_set_note FROM TO`:** prints nothing in any of these cases: `FROM` is `none`; the saved data dir is custom; either set is `other`; the sets are equal.
  - **`check_admin`:**
    - `ok` with note `running as root` when `is_root`.
    - Else `sudo -n true` gives `ok` with note `sudo`.
    - Else, unless `KIOSK_SETUP_YES=1`, print `Administrator rights are needed; sudo may ask for your password.` to `TTY_OUT` and run `sudo -v <"$TTY_IN"`, then try `sudo -n true` again.
    - Still failing: `fix` with note `This account can't use sudo. Sign in as an administrator, then run the setup again.`.
  - **`check_internet`:**
    - Tries the hosts in the order `download.docker.com dl.google.com raw.githubusercontent.com`, each as `https://HOST/`.
    - `ok` with note `online`, else `fix` with note `Can't reach HOSTS. Check the network connection.`.
  - **`net_ok URL`:** any HTTP answer counts. It uses `curl -sS -o /dev/null --max-time 10 URL` when curl exists, else `wget -q --spider --timeout=10 --tries=1 URL`, where exit code 0 or 8 counts as reachable.
  - **`download URL DEST`:** `curl -fsSL --max-time 60 URL -o DEST`, else `wget -qO DEST URL`.
  - **`check_disk`:**
    - `free_kib` runs `df -Pk "$VAR_LIB"` and prints the available column (falling back to `/` when the path is missing).
    - `ok` note: `N GB free`. `fix` note: `Only N GB free on /var/lib; the kiosk needs at least 10 GB.`.
    - N is the integer `kib / 1048576`.
  - **`check_tools`:** checks `curl`, `gpg`, then `ca-certificates` (via `pkg_installed`). Note `will be installed: <names>`, else `ok` with note `curl, ca-certificates, gpg`.
  - **`engine_checks`:**
    - When `admin` or `internet` is `fix`, or `fetch_engine` fails, the six engine rows get `--` with note `Not checked`.
    - Otherwise it runs `bash "$ENGINE" --step check --yes </dev/null`, through `as_root` when admin is `ok`. It parses `row|…` lines, and any row not reported stays `--`.
    - It appends ` ($(env_label "$(current_env)"))` to the kiosk note when the kiosk row is `ok` and `HAVE_CONFIG=1`.
    - When fetching fails, the internet row becomes `fix` with note `Couldn't download the installer from $BASE_URL/install.sh.`.
  - **`fetch_engine` download check:** the first line must be `#!/usr/bin/env bash`, and `bash -n` must pass.
  - **`safe_ref` pattern:** `''|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-]*|*..*`. Nothing in `setup.sh` uses a `[a-z]`-style range, comments included; the test greps for `A-Z` and `a-z`.
  - **`ubuntu_version_ok`:**
    - Reject `''` and `*[!0123456789.]*`, and anything without a `.`.
    - It passes when the major version is above 22, or when it is 22 and the minor is at least 4.
  - **`set_engine_args ENV`:**
    - For `custom`, `ENGINE_ARGS=()` and `ENGINE_DATA_DIR=''`.
    - Otherwise `--api-url`, `--portal-url` and `--channel` with that environment's values, and `ENGINE_DATA_DIR=$(data_dir_for ENV)`.
  - Add `INSTALL_SH.parent / "setup.sh"` to the `test_shellcheck_clean` script tuple.

- [ ] **Step 5: Run the tests**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_setup_sh.py kiosk_laptop/installer/tests/test_install_sh.py::test_shellcheck_clean`
Expected: PASS. Also run it under `/bin/bash` 3.2 if you are on a Mac; conftest picks it automatically.

- [ ] **Step 6: Commit**

```bash
git add kiosk_laptop/installer/setup.sh kiosk_laptop/installer/tests/conftest.py kiosk_laptop/installer/tests/test_setup_sh.py kiosk_laptop/installer/tests/test_install_sh.py
git commit -m "feat(kiosk-laptop): setup.sh environments, data folders and checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `setup.sh` screens: UI layer, checklist, picker and API check

**Files:**
- Modify: `kiosk_laptop/installer/setup.sh`
- Test: `kiosk_laptop/installer/tests/test_setup_sh.py`

**Interfaces:**
- Consumes: everything Task 5 produces.
- Produces:
  - **UI mode:** global `UI`, `whiptail` or `plain`. `ui_init` picks `whiptail` when `command -v whiptail` succeeds, `TTY_IN` is readable and `KIOSK_SETUP_PLAIN` isn't `1`; otherwise `plain`.
  - **Whiptail wrapper:** `wt ARGS...` runs `whiptail ARGS <"$TTY_IN" >"$TTY_OUT" 2>tmpfile`, prints the tmpfile, and returns whiptail's rc.
  - **Dialogs:**
    - `ui_yesno TITLE TEXT YES_LABEL NO_LABEL`: rc 0 = yes, 1 = no, Esc, or EOF in plain mode.
    - `ui_menu TITLE TEXT DEFAULT_TAG TAG LABEL [TAG LABEL...]`: prints the chosen tag. It returns 1 on cancel or EOF.
    - `ui_msg TITLE TEXT`.
    - `ui_textbox TITLE FILE`.
  - **Screens:**
    - `checklist_text`: one line per row, `MARKER  LABEL: NOTE`.
    - `checklist_screen`: 0 = continue, 1 = quit. It loops internally on Check again by re-running `run_checks`.
    - `pick_env`: sets `CHOSEN_ENV`. `CURRENT_ENV` is set by the caller from `current_env`.
    - `api_check_screen`: 0 = continue, 1 = quit, 2 = pick again.
  - Global `KIOSK_SETUP_YES` (`--yes`): no dialogs at all.

- [ ] **Step 1: Write the failing tests**

```python
from conftest import ALL_ROWS_OK, SYS_OK  # noqa: E402


def wt_calls(tmp_path):
    f = tmp_path / "wt.log"
    return f.read_text().split("----\n")[:-1] if f.exists() else []


def test_checklist_shows_markers_and_continue(setup, tmp_path):
    (tmp_path / "engine.rows").write_text(ALL_ROWS_OK.replace("row|chrome|ok|fine", "row|chrome|add|will be installed"))
    r = setup(SYS_OK + 'ui_init; load_saved_config; checklist_screen; echo rc=$?', answers=["0"])
    assert "rc=0" in r.stdout
    call = wt_calls(tmp_path)[0]
    assert "--yesno" in call and "Continue" in call and "Quit" in call
    assert "[ OK ]  Ubuntu version" in call and "[ ADD ]  Google Chrome: will be installed" in call


def test_checklist_with_a_problem_offers_check_again_and_quit_only(setup, tmp_path):
    (tmp_path / "os-release").write_text('ID=fedora\nVERSION_ID="40"\n')
    r = setup(SYS_OK + 'ui_init; load_saved_config; checklist_screen; echo rc=$?', answers=["0", "1"])
    assert "rc=1" in r.stdout
    calls = wt_calls(tmp_path)
    assert len(calls) == 2   # Check again re-ran the checks, then Quit
    for c in calls:
        assert "Check again" in c and "Continue" not in c
        assert "[ FIX ]  Ubuntu version: This setup supports Ubuntu 22.04 and newer." in c


def test_offline_rows_are_not_checked_yet(setup, tmp_path):
    r = setup('free_kib() { echo 99999999; }; net_ok() { return 1; }; have_cmd() { :; }; pkg_installed() { :; }; '
              'ui_init; load_saved_config; checklist_screen; echo rc=$?', answers=["1"])
    assert "rc=1" in r.stdout
    call = wt_calls(tmp_path)[0]
    assert "[ FIX ]  Internet" in call and "[ -- ]  Docker Engine: Not checked" in call
    assert "Continue" not in call
    assert not (tmp_path / "engine.log").exists()


def test_picker_preselects_the_current_environment(setup, tmp_path):
    write_config(tmp_path, *DEV, "edge")
    r = setup('ui_init; load_saved_config; CURRENT_ENV=$(current_env); pick_env; echo "chosen=$CHOSEN_ENV"',
              answers=["0 edge"])
    assert "chosen=edge" in r.stdout
    call = wt_calls(tmp_path)[0].splitlines()
    assert "--menu" in call and call[call.index("--default-item") + 1] == "edge"
    assert "custom" not in call


def test_picker_offers_custom_only_for_a_custom_laptop_and_defaults_to_it(setup, tmp_path):
    write_config(tmp_path, "http://10.0.0.5:8000", "", "stable")
    setup('ui_init; load_saved_config; CURRENT_ENV=$(current_env); pick_env', answers=["0 custom"])
    call = wt_calls(tmp_path)[0].splitlines()
    assert "Custom (keep current settings)" in call
    assert call[call.index("--default-item") + 1] == "custom"


def test_picker_defaults_to_prod_on_a_new_laptop(setup, tmp_path):
    setup('ui_init; load_saved_config; CURRENT_ENV=$(current_env); pick_env', answers=["0 prod"])
    call = wt_calls(tmp_path)[0].splitlines()
    assert call[call.index("--default-item") + 1] == "prod"


def test_switching_server_sets_asks_with_the_note_and_back_returns_to_the_picker(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    r = setup('ui_init; load_saved_config; CURRENT_ENV=$(current_env); pick_env; echo "chosen=$CHOSEN_ENV"',
              answers=["0 dev", "1", "0 rc"])
    assert "chosen=rc" in r.stdout
    calls = wt_calls(tmp_path)
    assert ("This laptop will use a separate dev kiosk. Its production kiosk data is kept for when you "
            "switch back.") in calls[1]
    assert "--menu" in calls[2]


def test_api_check_failure_offers_try_again_pick_another_and_quit(setup, tmp_path):
    r = setup('ui_init; load_saved_config; CHOSEN_ENV=dev; api_ok() { echo "timed out"; return 1; }; '
              'api_check_screen; echo rc=$?', answers=["0 pick"])
    assert "rc=2" in r.stdout
    call = next(c for c in wt_calls(tmp_path) if "Try again" in c)
    for s in ("Try again", "Pick another environment", "Quit", "https://api.dev.serversherpa.com/system/status",
              "timed out"):
        assert s in call


def test_api_check_passes_quietly(setup, tmp_path):
    r = setup('ui_init; load_saved_config; CHOSEN_ENV=prod; api_ok() { :; }; api_check_screen; echo rc=$?')
    assert "rc=0" in r.stdout
    assert all("--infobox" in c for c in wt_calls(tmp_path))


def test_plain_fallback_screens(setup, tmp_path):
    r = setup(SYS_OK + 'ui_init; load_saved_config; checklist_screen && CURRENT_ENV=$(current_env) && pick_env; '
              'echo "ui=$UI chosen=$CHOSEN_ENV"', env={"KIOSK_SETUP_PLAIN": "1"}, tty="1\n4\n")
    assert "ui=plain chosen=edge" in r.stdout
    out = (tmp_path / "tty.out").read_text()
    assert "[ OK ]  Ubuntu version" in out and "1) Continue" in out and "2) Quit" in out
    assert "1) Prod" in out and "4) Edge" in out
    assert not (tmp_path / "wt.log").exists()


def test_missing_whiptail_means_plain(setup):
    out = setup('command() { [ "$2" != whiptail ] && builtin command "$@"; }; ui_init; echo "$UI"').stdout
    assert out.strip() == "plain"
    assert setup('ui_init; echo "$UI"').stdout.strip() == "whiptail"


def test_plain_mode_eof_means_quit(setup):
    r = setup(SYS_OK + 'ui_init; load_saved_config; checklist_screen; echo rc=$?',
              env={"KIOSK_SETUP_PLAIN": "1"}, tty="")
    assert "rc=1" in r.stdout
```

`KIOSK_SETUP_PLAIN=1` is used instead of hiding whiptail from `PATH`, because the Ubuntu CI runner has a real `/usr/bin/whiptail`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_setup_sh.py -k "checklist or picker or api_check or plain or offline or switching"`
Expected: FAIL.

- [ ] **Step 3: Implement.** Decisions the tests leave open:
  - **Titles:**
    - The backtitle is `ServerSherpa kiosk setup`.
    - Screen titles: `1 of 3: What this laptop has`, `2 of 3: Environment`, `3 of 3: Installing`.
  - **Checklist text:** the rows, a blank line, then one of these:
    - with no problem: `[ ADD ] rows are installed in the next steps.`;
    - with a problem: `Fix the [ FIX ] rows, then choose Check again.`.
    - In whiptail mode it uses `--yesno` with `--yes-button "Continue" --no-button "Quit"`, or `"Check again"`/`"Quit"` when there are problems. Use `--scrolltext`.
  - **Plain mode:**
    - It prints the same text to `TTY_OUT`, then the choices as `1) Continue` / `2) Quit`, or `1) Check again` / `2) Quit`. It reads one line from `TTY_IN`.
    - `ui_menu` numbers its items `1) LABEL`, marks the default `(press Enter)`, and takes an empty answer as the default. An unknown answer re-asks. EOF returns 1.
  - **Picker items:** tag, label, description:
    - `prod`, `Prod`, `Production servers, released versions (stable)`;
    - `rc`, `RC`, `Production servers, release candidates (beta)`;
    - `dev`, `Dev`, `Dev servers, release candidates (beta)`;
    - `edge`, `Edge`, `Dev servers, every build of main (edge)`;
    - `custom`, `Custom (keep current settings)`, `<saved API>, <saved channel>`. This item only appears when `CURRENT_ENV=custom`.
    - The current environment's description gets ` (current)`.
    - The default is `CURRENT_ENV`, or `prod` when that is `none`.
    - The text is `Choose the servers and app version for this laptop. Press Enter to keep the highlighted choice.`.
    - In whiptail mode the menu tag is the env name and the item text is `LABEL  DESCRIPTION`. Plain mode prints the same.
  - **Switch note:** when `server_set_note CURRENT CHOSEN` isn't empty, show `ui_yesno "Switch servers" NOTE "Continue" "Back"`. Back goes back to the picker.
  - **`api_ok URL`:** prints the error text and returns 1 on failure. It runs `curl -fsS --max-time 10 "$URL/system/status" -o /dev/null`, capturing stderr, or the `wget` equivalent.
  - **`api_check_screen`:**
    - Shows `ui_info "Checking that the <Label> servers answer…"`. `ui_info` uses `--infobox` in whiptail mode and prints a line in plain mode.
    - On failure it shows a `ui_menu` with tags `retry`/`pick`/`quit` and labels `Try again`/`Pick another environment`/`Quit`.
    - The menu text is `The <Label> servers didn't answer (<api>/system/status):` followed by the error line.
    - `retry` loops. The return codes are 0, 1 or 2 as in Interfaces.
  - **`--yes` mode:**
    - `checklist_screen` prints `checklist_text` to stdout and returns 1 when there are problems, else 0.
    - `pick_env` uses `--env`, or `CURRENT_ENV` (`prod` when `none`) when `--env` isn't given.
    - `api_check_screen` returns 1 on failure.

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_setup_sh.py kiosk_laptop/installer/tests/test_install_sh.py::test_shellcheck_clean`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/installer/setup.sh kiosk_laptop/installer/tests/test_setup_sh.py
git commit -m "feat(kiosk-laptop): setup.sh checklist, environment picker and API check screens" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `setup.sh` progress, Try again, snapshot and restore, and `main`

**Files:**
- Modify: `kiosk_laptop/installer/setup.sh`
- Test: `kiosk_laptop/installer/tests/test_setup_sh.py`

**Interfaces:**
- Consumes: Task 5 (`run_engine`, `set_engine_args`, `row_state`, `row_note`, `as_root`, `fetch_engine`) and Task 6 (`ui_*`, `checklist_screen`, `pick_env`, `api_check_screen`).
- Produces:
  - `STEP_IDS=(tools docker docker-start chrome python3 printers download start finish)` and `STEP_LABELS`, with the exact labels from Global Constraints.
  - `step_needed IDX`:
    - `tools`: the tools row is `add`;
    - `docker`: the docker row or the snapdocker row is `add`;
    - `chrome` and `python3`: their row is `add`;
    - every other step: always.
  - `run_setup_step IDX LOG`, `progress_text`, `run_steps` (0 = all done, 1 = quit), `step_reason LOG`, `snapshot_config`, `restore_config`, `quit_after_failure IDX`, `finish_screen`, `start_sudo_keepalive`, `log_line TEXT`, `parse_args`, `main`.
  - **Exit codes:** 0 done, 1 quit or failure, 2 bad usage.
  - **Command line:** `setup.sh [--env prod|rc|dev|edge|custom] [--yes] [--help]`.

- [ ] **Step 1: Write the failing tests**

```python
def engine_steps(tmp_path):
    return [line.split("|")[0] for line in (tmp_path / "engine.log").read_text().splitlines()]


FLOW = SYS_OK + 'api_ok() { :; }; '

ADDS = ALL_ROWS_OK.replace("row|docker|ok|fine", "row|docker|add|will be installed") \
                  .replace("row|chrome|ok|fine", "row|chrome|add|will be installed")


def test_fresh_laptop_runs_every_needed_step_once(setup, tmp_path):
    (tmp_path / "engine.rows").write_text(ADDS)
    r = setup(FLOW + 'main', answers=["0", "0 prod", "1"], check=False)
    assert r.returncode == 0, r.stderr
    assert engine_steps(tmp_path) == ["check", "docker", "docker-start", "chrome", "printers",
                                      "move-dev-data", "download", "start", "login-items", "launcher"]
    download = next(l for l in (tmp_path / "engine.log").read_text().splitlines() if l.startswith("download|"))
    assert ("--channel stable" in download and "--api-url https://api.serversherpa.com" in download
            and "--portal-url https://portal.serversherpa.com" in download)
    assert download.split("|")[2] == f"{tmp_path}/varlib/serversherpa-kiosk"
    done = wt_calls(tmp_path)[-1]
    assert "Done. Sign out and back in (or restart) to start the kiosk." in done
    assert "Restart now" in done and "Close" in done and str(tmp_path / "setup.log") in done
    gauge = (tmp_path / "wt.log.gauge").read_text()
    assert "Install download tools" in gauge and "(already installed)" in gauge


def test_engine_never_reads_the_script_pipe(setup, tmp_path):
    setup(FLOW + 'main', answers=["0", "0 prod", "1"], check=False)
    assert all(line.endswith("stdin=0") for line in (tmp_path / "engine.log").read_text().splitlines())


def test_try_again_reruns_only_the_failed_step(setup, tmp_path):
    (tmp_path / "engine.fail").write_text("start\n")
    r = setup(FLOW + 'main', answers=["0", "0 prod", "0 retry", "1"], check=False)
    assert r.returncode == 0
    steps = engine_steps(tmp_path)
    assert steps.count("start") == 2 and steps.count("download") == 1 and steps.count("printers") == 1
    fail = next(c for c in wt_calls(tmp_path) if "Try again" in c)
    assert "Show details" in fail and "Quit" in fail and "start broke" in fail
    assert "Start the kiosk and wait for it to be healthy" in fail and str(tmp_path / "setup.log") in fail


def test_show_details_then_quit_on_a_new_laptop(setup, tmp_path):
    (tmp_path / "engine.fail").write_text("download\n")
    r = setup(FLOW + 'main', answers=["0", "0 prod", "0 details", "0", "0 quit", "0"], check=False)
    assert r.returncode == 1
    calls = wt_calls(tmp_path)
    assert any("--textbox" in c for c in calls)
    assert "Error: download broke" in (tmp_path / "setup.log").read_text()
    assert "Run the setup again" in calls[-1]
    assert "restart" not in engine_steps(tmp_path)


def test_quit_after_a_failed_switch_restores_the_previous_environment(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    before = (tmp_path / "opt" / "config.env").read_text()
    (tmp_path / "opt" / "docker-compose.yml").write_text("prod compose\n")
    (tmp_path / "engine.fail").write_text("start\n")
    r = setup(FLOW + 'main', answers=["0", "0 dev", "0", "0 quit", "0"], check=False)
    assert r.returncode == 1
    assert (tmp_path / "opt" / "config.env").read_text() == before
    assert (tmp_path / "opt" / "docker-compose.yml").read_text() == "prod compose\n"
    restart = [l for l in (tmp_path / "engine.log").read_text().splitlines() if l.startswith("restart|")]
    assert restart and "--api-url" not in restart[0] and restart[0].split("|")[2] == ""
    assert "back on Prod" in wt_calls(tmp_path)[-1]


def test_retrying_download_keeps_the_first_snapshot(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    before = (tmp_path / "opt" / "config.env").read_text()
    (tmp_path / "opt" / "docker-compose.yml").write_text("prod compose\n")
    (tmp_path / "engine.fail").write_text("download\nstart\n")
    setup(FLOW + 'main', answers=["0", "0 dev", "0", "0 retry", "0 quit", "0"], check=False)
    assert (tmp_path / "opt" / "config.env").read_text() == before


def test_quit_after_a_failed_same_environment_update_restores_nothing(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    (tmp_path / "engine.fail").write_text("start\n")
    r = setup(FLOW + 'main', answers=["0", "0 prod", "0 quit", "0"], check=False)
    assert r.returncode == 1 and "restart" not in engine_steps(tmp_path)


def test_success_removes_the_snapshot(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    setup(FLOW + 'main', answers=["0", "0 prod", "1"], check=False)
    assert not (tmp_path / "opt" / "setup-snapshot").exists()


def test_yes_mode_needs_no_dialogs(setup, tmp_path):
    r = setup(FLOW + 'main --env edge --yes', check=False)
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (tmp_path / "wt.log").exists()
    assert "Done. Sign out and back in (or restart) to start the kiosk." in r.stdout
    download = next(l for l in (tmp_path / "engine.log").read_text().splitlines() if l.startswith("download|"))
    assert "--channel edge" in download and download.split("|")[2] == f"{tmp_path}/varlib/serversherpa-kiosk-dev"


def test_yes_mode_stops_on_a_problem(setup, tmp_path):
    (tmp_path / "os-release").write_text('ID=fedora\n')
    r = setup(FLOW + 'main --yes', check=False)
    assert r.returncode == 1 and "This setup supports Ubuntu 22.04 and newer." in r.stdout


def test_bad_arguments(setup):
    r = setup('main --env nightly', check=False)
    assert r.returncode == 2 and "prod, rc, dev, edge or custom" in r.stderr
    assert "--env" in setup('main --help').stdout


def test_restart_now_reboots(setup, tmp_path):
    r = setup(FLOW + 'as_root() { "$@"; }; systemctl() { echo "systemctl $*" >> "$PWD/sys.calls"; }; main',
              answers=["0", "0 prod", "0"], check=False)
    assert r.returncode == 0 and "systemctl reboot" in (tmp_path / "sys.calls").read_text()


def test_log_gets_every_steps_output_with_24_hour_times(setup, tmp_path):
    setup(FLOW + 'main', answers=["0", "0 prod", "1"], check=False)
    log = (tmp_path / "setup.log").read_text()
    assert "Did download" in log and "Did start" in log
    import re
    assert re.search(r"^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d ", log, re.M)
    assert " AM" not in log and " PM" not in log
```

Per-step logs live in `STEP_LOG_DIR` (under `${TMPDIR:-/tmp}`, removed by the EXIT trap), so the tests assert on `setup.log`, which gets every step's output. `test_restart_now_reboots` stubs `as_root`, because the `sudo` stub `exec`s its command and would run the real `systemctl`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_setup_sh.py -k "laptop or try_again or details or quit or snapshot or yes_mode or bad_arguments or restart_now or log_gets or script_pipe"`
Expected: FAIL.

- [ ] **Step 3: Implement.** Decisions:
  - **`run_setup_step IDX LOG`:**
    - `download`: `run_engine move-dev-data LOG && snapshot_config && run_engine download LOG`.
    - `finish`: `run_engine login-items LOG && run_engine launcher LOG`.
    - Every other step: `run_engine <id> LOG`.
  - **`snapshot_config`:**
    - Does nothing when `$STEP_LOG_DIR/snapshot.taken` exists. It must be a marker file, not a variable, because steps run in a background subshell.
    - Otherwise, when `$KIOSK_DIR/config.env` exists, run `as_root mkdir -p "$KIOSK_DIR/setup-snapshot"`, then `as_root cp -p` `config.env` and `docker-compose.yml` (if present) into it, then `touch` the marker.
  - **`restore_config`:** sets `ENGINE_ARGS=()` and `ENGINE_DATA_DIR=''`, copies both files back with `as_root cp -p`, then runs `run_engine restart "$SETUP_STEP_LOG"`.
  - **`quit_after_failure IDX`:**
    - Restore only when all of these hold: the failed step is `download` or `start`, the marker exists, `CURRENT_ENV` isn't `none`, and `CHOSEN_ENV` differs from `CURRENT_ENV`.
    - Messages, each ending with `Log: $SETUP_LOG`:
      - restored: `The setup put this laptop back on <Label>, and its kiosk is running again.`;
      - restore failed: `The setup couldn't restart the <Label> kiosk. Run the setup again, or see the log.`;
      - no previous environment: `The setup stopped before the kiosk was installed. Run the setup again to finish.`;
      - otherwise: `The setup stopped. Run the setup again to finish; the kiosk keeps its current version and settings.`.
    - The message is shown with `ui_msg` (or printed in `--yes` mode). Return 1.
  - **Progress (`run_steps`):**
    - Loop over the steps from the first one not yet done. A step not needed is marked `skipped` and shows `[ OK ]  LABEL (already installed)`.
    - Running a step: truncate its log, then start `run_setup_step` in the background, `&` with `pid=$!`.
      - Whiptail mode: pipe a loop into `whiptail --gauge`. While `kill -0 "$pid"`, the loop prints `XXX\n<percent>\n<progress_text>\nXXX`, then sleeps `${KIOSK_SETUP_POLL_S:-1}`.
      - Plain mode: print `Step N of 9: LABEL ...`, then `done` or `failed`.
    - Then `wait "$pid"` and append the step log to `SETUP_LOG` with `as_root tee -a`, after a `log_line "---- step <id> ----"` header.
    - Percent is `100 * (done + skipped) / 9`.
    - `progress_text` uses the markers `[ OK ]`, `[ .. ]` (running), `[FAIL]` and `[    ]` (pending), then `Log: $SETUP_LOG`.
  - **On failure:** `step_reason` is the last `Error: ` line of the step log with the prefix stripped, else `See the details.`.
    - The menu text is `Step N failed: LABEL`, a blank line, the reason, a blank line, then `Log: $SETUP_LOG`.
    - The tags are `retry`/`details`/`quit`, labeled `Try again`/`Show details`/`Quit`. `details` runs `ui_textbox` on the step log and comes back to the menu.
    - In `--yes` mode a failure goes straight to `quit_after_failure`.
  - **`finish_screen`:**
    - Removes the snapshot folder with `as_root rm -rf "$KIOSK_DIR/setup-snapshot"`.
    - Then it shows `ui_yesno "Done" "Done. Sign out and back in (or restart) to start the kiosk.\n\nLog: $SETUP_LOG" "Restart now" "Close"`. Yes runs `as_root systemctl reboot`.
    - In `--yes` mode it prints the text and returns 0.
  - **`log_line TEXT`:** `printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$TEXT" | as_root tee -a "$SETUP_LOG" >/dev/null 2>&1 || true`.
  - **`start_sudo_keepalive`:**
    - Only when not root and admin is `ok`. It runs `( while sleep "${KIOSK_SUDO_KEEPALIVE_S:-50}"; do sudo -n -v >/dev/null 2>&1 || exit 0; done ) </dev/null >/dev/null 2>&1 &`.
    - Its PID is saved, and the EXIT trap kills it and removes `STEP_LOG_DIR`.
  - **`main`:**
    1. `parse_args`. A bad `--env` prints `Unknown environment 'NAME' (use prod, rc, dev, edge or custom).` and an unknown option prints `Unknown option 'X'. Try --help.`, both to stderr, and return 2. `--help` prints usage to stdout and returns 0.
    2. `STEP_LOG_DIR=$(mktemp -d)`, `ui_init` and `load_saved_config`; set `CURRENT_ENV=$(current_env)`.
    3. `checklist_screen`, which also runs `check_admin`'s up-front `sudo -v`. Return 1 on quit.
    4. Create `SETUP_LOG` with `as_root touch` and `as_root chmod 644`, then write `log_line "---- setup.sh $* ----"`.
    5. `start_sudo_keepalive`.
    6. Loop: `pick_env`, `set_engine_args "$CHOSEN_ENV"`, `api_check_screen` (2 goes back to `pick_env`, 1 returns 1).
    7. `run_steps || return 1`.
    8. `finish_screen`.

- [ ] **Step 4: Run the whole installer suite**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests`
Expected: all pass. On a Mac this also runs under `/bin/bash` 3.2.

- [ ] **Step 5: Manual smoke run (whiptail for real, nothing installed).** On a machine with whiptail, save conftest's `ENGINE` text as a scratch file `/tmp/kiosk-fake-engine.sh` (`chmod 755`, not committed). Run `KIOSK_SETUP_ENGINE=/tmp/kiosk-fake-engine.sh KIOSK_SETUP_LOG=/tmp/kiosk-setup.log KIOSK_DIR=/tmp/kiosk-opt bash kiosk_laptop/installer/setup.sh`. On a Mac, also set `KIOSK_OS_RELEASE` to a file with `ID=ubuntu` and `VERSION_ID="24.04"`. Then check:
  - the three screens appear;
  - Enter keeps the preselected environment;
  - the gauge advances;
  - nothing reads the terminal after the last screen.

- [ ] **Step 6: Commit**

```bash
git add kiosk_laptop/installer/setup.sh kiosk_laptop/installer/tests/test_setup_sh.py
git commit -m "feat(kiosk-laptop): setup.sh progress with Try again, snapshot/restore on a failed switch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: README, update.sh decision and CI

**Files:**
- Modify: `kiosk_laptop/README.md`: `## Requirements`, `## Install`, `## Updates`, `## Data and backups`, `## Uninstall`, `## Troubleshooting`.
- Modify: `kiosk_laptop/installer/update.sh`: the comment above `refresh_helpers` only.
- Test: `kiosk_laptop/installer/tests/test_setup_sh.py`

**Interfaces:**
- Consumes: the behavior from Tasks 1–7.
- Produces: user docs only. `update.sh`'s refresh list is **unchanged** (`launch.sh`, `hostnet.sh`, and on Linux `kiosk_session.py`). The "Set up kiosk" icon runs `setup-kiosk.sh`, which downloads `setup.sh` fresh on every run, so a nightly copy would be dead weight.

- [ ] **Step 1: Write the failing doc test**

```python
def test_readme_documents_the_ubuntu_setup():
    from conftest import INSTALL_SH
    text = (INSTALL_SH.parent.parent / "README.md").read_text()
    assert ("wget -qO- https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/setup.sh | bash"
            in text)
    for s in ("/var/lib/serversherpa-kiosk-dev", "/var/log/serversherpa-kiosk-setup.log", "Set up kiosk",
              "--env edge --yes", "Custom (keep current settings)", "10 GB", "Ubuntu 22.04"):
        assert s in text, s


def test_update_sh_does_not_refresh_setup_sh():
    from conftest import INSTALL_SH
    body = (INSTALL_SH.parent / "update.sh").read_text()
    fn = body[body.index("refresh_helpers() {"):]
    fn = fn[:fn.index("\n}\n")]
    assert "setup.sh" not in fn
```

- [ ] **Step 2: Run the tests and confirm the README test fails**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests/test_setup_sh.py -k "readme or update_sh"`
Expected: `test_readme_documents_the_ubuntu_setup` FAILs and `test_update_sh_does_not_refresh_setup_sh` PASSes. It pins the decision.

- [ ] **Step 3: Update the README** (American English, 24-hour times):
  - **Requirements:** Ubuntu 22.04 or newer (amd64) for the guided setup, plus 10 GB free on `/var/lib`.
  - **Install**, a new first subsection "Ubuntu (recommended)":
    - The exact `wget -qO- … | bash` command, and why it uses `wget` (a fresh Ubuntu has no `curl`).
    - The three screens and the `[ OK ]`/`[ ADD ]`/`[ FIX ]` markers.
    - The environment table: Prod/RC/Dev/Edge with servers and channel, plus `Custom (keep current settings)`.
    - Re-running updates in place, with the current environment preselected.
    - Try again, Show details and Quit, with the log at `/var/log/serversherpa-kiosk-setup.log`.
    - Quit after a failed switch puts the laptop back on its previous environment.
    - Non-interactive use: `wget -qO- …/setup.sh | bash -s -- --env edge --yes`.
    - The "Set up kiosk" desktop icon runs the newest setup each time.
    - `install.sh` remains the command for macOS and other Linux, with its flags for per-laptop settings.
  - **Data and backups:**
    - production data in `/var/lib/serversherpa-kiosk`, dev data in `/var/lib/serversherpa-kiosk-dev`;
    - switching server sets keeps both;
    - the one-time move of an existing dev laptop's data (production data is never moved);
    - a custom `KIOSK_DATA_DIR` is never moved.
  - **Updates:** one bullet saying the nightly helper refresh doesn't include `setup.sh`, because the Set up kiosk icon downloads it fresh.
  - **Linux Docker/Chrome:** on Ubuntu, Docker comes from Docker's apt repository. When Docker doesn't serve a new Ubuntu release yet, it falls back to Ubuntu's `docker.io` and `docker-compose-v2`. Chrome comes from Google's apt repository, amd64 only. Snap Chromium is left installed.
  - **Uninstall:** it also removes the Set up kiosk icon. The test laptop's own `update-kiosk.sh`/`install-kiosk.sh` are left alone.
- **`update.sh`:** add one comment line above `refresh_helpers`: `# setup.sh is not refreshed here: the Set up kiosk icon (setup-kiosk.sh) downloads it fresh each run.`
- **CI:** no workflow change is needed. `.github/workflows/kiosk-laptop-image.yml` already runs `pytest -q kiosk_laptop/installer/tests` on Linux (with shellcheck) and on macOS `/bin/bash` 3.2, which now covers `test_setup_sh.py` and `test_install_steps.py`. Verify by reading the workflow, not by editing it.
- **`test_linux_e2e.sh`** gets no `setup.sh` run (see the report): every built-in environment points at real ServerSherpa servers, and a CI kiosk must never register with production or dev.

- [ ] **Step 4: Run everything**

Run: `python3 -m pytest -q kiosk_laptop/installer/tests && shellcheck -s bash kiosk_laptop/installer/setup.sh kiosk_laptop/installer/install.sh`
Expected: all tests pass and shellcheck prints nothing. If shellcheck is missing locally, `test_shellcheck_clean` skips and CI's Linux job runs it.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/README.md kiosk_laptop/installer/update.sh kiosk_laptop/installer/tests/test_setup_sh.py
git commit -m "docs(kiosk-laptop): Ubuntu setup command, environments and data folders" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
