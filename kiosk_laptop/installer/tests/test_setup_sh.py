import os
import signal
import subprocess
import time

import pytest

from conftest import ALL_ROWS_OK, SYS_OK

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


NOT_ROOT = 'is_root() { return 1; }; '   # the tests must not depend on CI's user


def test_check_admin(setup):
    assert setup(NOT_ROOT + 'check_admin; row_state admin').stdout == "ok"
    out = setup(NOT_ROOT + 'KIOSK_SETUP_YES=1; check_admin; row_state admin', env={"SUDO_FAIL": "1"}).stdout
    assert out == "fix"


# A sudo that has no cached credentials until `sudo -v` reads a password.
SUDO_ASKS = r'''#!/bin/sh
d="$(dirname "$0")/.."
echo "sudo $*" >> "$SUDO_LOG"
case "$1" in
  -v) printf '[sudo] password for kiosk: ' >&2; IFS= read -r pw || exit 1
      printf '%s' "$pw" > "$d/sudo.password"; touch "$d/sudo.cached"; exit 0 ;;
  -n) [ -f "$d/sudo.cached" ]; exit $? ;;
esac
exit 1
'''


def test_check_admin_asks_for_the_password_on_the_tty(setup, tmp_path):
    sudo = tmp_path / "bin" / "sudo"; sudo.write_text(SUDO_ASKS); sudo.chmod(0o755)
    r = setup(NOT_ROOT + 'check_admin; row_state admin; echo; row_note admin', tty="hunter2\n")
    assert r.stdout.splitlines() == ["ok", "sudo"]
    assert (tmp_path / "sudo.password").read_text() == "hunter2"
    out = (tmp_path / "tty.out").read_text()
    assert "Administrator rights are needed" in out and "[sudo] password for kiosk:" in out
    assert r.stderr == ""


def test_check_admin_without_a_tty_is_quiet(setup, tmp_path):
    gone = tmp_path / "no-such-dir" / "tty"
    r = setup(NOT_ROOT + 'check_admin; row_state admin', env={"SUDO_FAIL": "1", "KIOSK_TTY": str(gone),
                                                              "KIOSK_TTY_OUT": str(gone)})
    assert r.stdout == "fix"
    assert r.stderr == ""
    assert "sudo -v" not in (tmp_path / "sudo.log").read_text()


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
    out = setup(NOT_ROOT + SYS_OK + 'load_saved_config; run_checks; for i in docker kiosk snapdocker; do '
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


def test_kiosk_note_uses_the_short_custom_label(setup, tmp_path):
    (tmp_path / "engine.rows").write_text("row|kiosk|ok|running\n")
    write_config(tmp_path, "http://10.0.0.5:8000", "", "stable")
    assert setup(SYS_OK + 'load_saved_config; run_checks; row_note kiosk').stdout == "running (Custom)"


@pytest.mark.parametrize("first_line,body", [
    ("#!/bin/sh", "echo hi"),                     # wrong shebang
    ("#!/usr/bin/env bash", "if then fi )"),      # fails bash -n
])
def test_fetch_engine_rejects_a_bad_download(setup, tmp_path, first_line, body):
    tmp = tmp_path / "tmpdir"; tmp.mkdir()
    r = setup(f'download() {{ printf "%s\\n%s\\n" "{first_line}" "{body}" > "$2"; }}; '
              'fetch_engine && echo got || echo rejected; echo "engine=$ENGINE"',
              env={"KIOSK_SETUP_ENGINE": "", "TMPDIR": str(tmp)})
    assert r.stdout.splitlines() == ["rejected", "engine="]
    assert list(tmp.iterdir()) == []


def test_fetch_engine_accepts_a_good_download(setup, tmp_path):
    tmp = tmp_path / "tmpdir"; tmp.mkdir()
    r = setup('download() { printf "#!/usr/bin/env bash\\necho ok\\n" > "$2"; }; fetch_engine && echo "engine=$ENGINE"',
              env={"KIOSK_SETUP_ENGINE": "", "TMPDIR": str(tmp)})
    assert r.stdout.strip() == f"engine={next(tmp.iterdir())}"


@pytest.mark.parametrize("rc,ok", [(0, True), (8, True), (4, False)])
def test_net_ok_with_wget_counts_an_http_error_as_online(setup, rc, ok):
    out = setup(f'have_cmd() {{ [ "$1" != curl ]; }}; wget() {{ return {rc}; }}; net_ok https://x/ && echo y || echo n')
    assert out.stdout.strip() == ("y" if ok else "n")


# ── Task 6: screens ───────────────────────────────────────────────────

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
    assert "Edge  Dev servers, every build of main (edge) (current)" in call
    assert "Prod  Production servers, released versions (stable)" in call


def test_picker_offers_custom_only_for_a_custom_laptop_and_defaults_to_it(setup, tmp_path):
    write_config(tmp_path, "http://10.0.0.5:8000", "", "stable")
    setup('ui_init; load_saved_config; CURRENT_ENV=$(current_env); pick_env', answers=["0 custom"])
    call = wt_calls(tmp_path)[0].splitlines()
    # The item text is "LABEL  DESCRIPTION", so the label starts its line.
    item = len(call) - 1 - call[::-1].index("custom")   # the menu's tag, after --default-item's
    assert call[item + 1] == "Custom (keep current settings)  http://10.0.0.5:8000, stable (current)"
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


def test_picker_cancel_returns_1(setup, tmp_path):
    r = setup('ui_init; load_saved_config; CURRENT_ENV=$(current_env); pick_env; echo rc=$?', answers=["1"])
    assert "rc=1" in r.stdout


def test_api_check_failure_offers_try_again_pick_another_and_quit(setup, tmp_path):
    r = setup('ui_init; load_saved_config; CHOSEN_ENV=dev; api_ok() { echo "timed out"; return 1; }; '
              'api_check_screen; echo rc=$?', answers=["0 pick"])
    assert "rc=2" in r.stdout
    call = next(c for c in wt_calls(tmp_path) if "Try again" in c)
    for s in ("Try again", "Pick another environment", "Quit", "https://api.dev.serversherpa.com/system/status",
              "timed out"):
        assert s in call


def test_api_check_try_again_retries_and_quit_returns_1(setup, tmp_path):
    r = setup('ui_init; load_saved_config; CHOSEN_ENV=prod; api_ok() { echo "$1" >> "$WT_LOG.api"; echo no; return 1; }; '
              'api_check_screen; echo rc=$?', answers=["0 retry", "0 quit"])
    assert "rc=1" in r.stdout
    assert (tmp_path / "wt.log.api").read_text().splitlines() == ["https://api.serversherpa.com"] * 2


def test_api_check_passes_quietly(setup, tmp_path):
    r = setup('ui_init; load_saved_config; CHOSEN_ENV=prod; api_ok() { :; }; api_check_screen; echo rc=$?')
    assert "rc=0" in r.stdout
    assert all("--infobox" in c for c in wt_calls(tmp_path))
    assert "Checking that the Prod servers answer" in wt_calls(tmp_path)[0]


def test_api_ok_reports_curls_error(setup, tmp_path):
    r = setup('curl() { echo "$*" > "$WT_LOG.curl"; echo "curl: (28) Connection timed out" >&2; return 28; }; '
              'api_ok https://api.example; echo " rc=$?"')
    assert r.stdout.strip() == "curl: (28) Connection timed out rc=1"
    assert "https://api.example/system/status" in (tmp_path / "wt.log.curl").read_text()
    assert setup('curl() { :; }; api_ok https://api.example && echo ok').stdout.strip() == "ok"


def test_plain_fallback_screens(setup, tmp_path):
    r = setup(SYS_OK + 'ui_init; load_saved_config; checklist_screen && CURRENT_ENV=$(current_env) && pick_env; '
              'echo "ui=$UI chosen=$CHOSEN_ENV"', env={"KIOSK_SETUP_PLAIN": "1"}, tty="1\n4\n")
    assert "ui=plain chosen=edge" in r.stdout
    out = (tmp_path / "tty.out").read_text()
    assert "[ OK ]  Ubuntu version" in out and "1) Continue" in out and "2) Quit" in out
    assert "1) Prod" in out and "4) Edge" in out
    assert not (tmp_path / "wt.log").exists()


def test_plain_menu_enter_takes_the_default_and_unknown_answers_ask_again(setup, tmp_path):
    r = setup('ui_init; ui_menu T "Pick one" b a Apple b Banana; echo " rc=$?"; ui_menu T Pick a a Apple b Banana',
              env={"KIOSK_SETUP_PLAIN": "1"}, tty="\n9\nzz\n1\n")
    assert r.stdout.splitlines() == ["b rc=0", "a"]
    out = (tmp_path / "tty.out").read_text()
    assert "2) Banana (press Enter)" in out and "1) Apple\n" in out
    assert out.count("Type a number from 1 to 2.") == 2


def test_missing_whiptail_means_plain(setup):
    out = setup('command() { [ "$2" != whiptail ] && builtin command "$@"; }; ui_init; echo "$UI"').stdout
    assert out.strip() == "plain"
    assert setup('ui_init; echo "$UI"').stdout.strip() == "whiptail"


def test_no_tty_means_plain(setup, tmp_path):
    gone = str(tmp_path / "no-such-dir" / "tty")
    r = setup('ui_init; echo "$UI"', env={"KIOSK_TTY": gone, "KIOSK_TTY_OUT": gone})
    assert r.stdout.strip() == "plain" and r.stderr == ""


def test_plain_mode_eof_means_quit(setup):
    r = setup(SYS_OK + 'ui_init; load_saved_config; checklist_screen; echo rc=$?',
              env={"KIOSK_SETUP_PLAIN": "1"}, tty="")
    assert "rc=1" in r.stdout


def test_yes_mode_shows_no_dialogs(setup, tmp_path):
    write_config(tmp_path, *DEV, "edge")
    r = setup(SYS_OK + 'KIOSK_SETUP_YES=1; ui_init; load_saved_config; checklist_screen; echo "rc=$?"; '
              'CURRENT_ENV=$(current_env); pick_env; echo "chosen=$CHOSEN_ENV"; '
              'OPT_ENV=prod; pick_env; echo "chosen=$CHOSEN_ENV"; '
              'api_ok() { echo down; return 1; }; api_check_screen; echo "api=$?"')
    assert "[ OK ]  Ubuntu version" in r.stdout and "rc=0" in r.stdout
    assert "chosen=edge" in r.stdout and "chosen=prod" in r.stdout and "api=1" in r.stdout
    assert "down" in r.stderr
    assert not (tmp_path / "wt.log").exists()


def test_yes_mode_with_a_problem_and_a_bad_env(setup, tmp_path):
    (tmp_path / "os-release").write_text('ID=fedora\nVERSION_ID="40"\n')
    r = setup(SYS_OK + 'KIOSK_SETUP_YES=1; load_saved_config; checklist_screen; echo "rc=$?"; '
              'CURRENT_ENV=none; OPT_ENV=custom; pick_env; echo "pick=$?"')
    assert "Fix the [ FIX ] rows, then choose Check again." in r.stdout
    assert "rc=1" in r.stdout and "pick=1" in r.stdout


def test_checklist_esc_counts_as_quit(setup, tmp_path):
    # No answers: the whiptail stub behaves like Esc (exit 255); the screen must say 1.
    (tmp_path / "engine.rows").write_text(ALL_ROWS_OK)
    r = setup(SYS_OK + 'ui_init; load_saved_config; checklist_screen; echo rc=$?', answers=[])
    assert "rc=1" in r.stdout


def test_wt_size_counts_wrapped_lines(setup):
    r = setup('stty() { echo "40 80"; }; wt_size "$(printf "%0150d" 0)" 7')
    # 150 characters in a 74-column box wrap to 3 lines.
    assert r.stdout.strip() == "10 78"


# ── Task 7: progress, Try again, snapshot and restore, main ───────────

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
    # Nothing to put back (same environment), but the kiosk is restarted as it is.
    write_config(tmp_path, *PROD, "stable")
    (tmp_path / "engine.fail").write_text("start\n")
    r = setup(FLOW + 'main', answers=["0", "0 prod", "0 quit", "0"], check=False)
    assert r.returncode == 1 and engine_steps(tmp_path).count("restart") == 1
    assert (tmp_path / "opt" / "config.env").read_text() == "changed\n"


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


# install.sh --step logs through `exec > >(tee …) 2>&1`: its Error line can be
# on stdout and can land after the process has exited.
LATE_STDOUT_ENGINE = r'''#!/usr/bin/env bash
exec > >(sleep 0.3; cat) 2>&1
echo "Error: an earlier problem"
echo "Error: printed late on stdout"
exit 1
'''


def test_reason_is_the_last_error_line_even_on_stdout_and_late(setup, tmp_path):
    eng = tmp_path / "late.sh"; eng.write_text(LATE_STDOUT_ENGINE); eng.chmod(0o755)
    r = setup('STEP_LOG_DIR=$(mktemp -d); run_setup_step 7 "$PWD/s.log"; echo "rc=$?"; step_reason "$PWD/s.log"',
              env={"KIOSK_SETUP_ENGINE": str(eng)})
    assert r.stdout.splitlines() == ["rc=1", "printed late on stdout"]
    assert "Error: an earlier problem" in (tmp_path / "s.log").read_text()


def test_reason_without_an_error_line(setup, tmp_path):
    (tmp_path / "s.log").write_text("something went wrong\n")
    assert setup('step_reason "$PWD/s.log"').stdout == "See the details."


def test_step_needed(setup):
    out = setup('row_set tools ok x; row_set docker ok x; row_set snapdocker add x; row_set chrome ok x; '
                'row_set python3 add x; i=0; while [ "$i" -lt 9 ]; do '
                'step_needed "$i" && printf "%s " "${STEP_IDS[$i]}"; i=$((i + 1)); done').stdout
    assert out.split() == ["docker", "docker-start", "python3", "printers", "download", "start", "finish"]


def test_no_tty_and_no_yes_says_how_to_run_it(setup, tmp_path):
    gone = str(tmp_path / "no-such-dir" / "tty")
    r = setup(FLOW + 'main', env={"KIOSK_TTY": gone, "KIOSK_TTY_OUT": gone}, check=False)
    assert r.returncode == 1
    assert r.stderr.strip().splitlines() == [
        "This setup asks questions on a terminal. Run it in a terminal, or pass --env NAME --yes."]
    assert not (tmp_path / "engine.log").exists()


def test_unknown_option(setup):
    r = setup('main --frobnicate', check=False)
    assert r.returncode == 2 and r.stderr.strip() == "Unknown option '--frobnicate'. Try --help."


def test_yes_mode_failure_quits_with_the_reason(setup, tmp_path):
    (tmp_path / "engine.fail").write_text("printers\n")
    r = setup(FLOW + 'main --env prod --yes', check=False)
    assert r.returncode == 1
    assert "Step 6 of 9: Set up USB label printers ... failed" in r.stdout
    assert "printers broke" in r.stderr
    assert "The setup stopped before the kiosk was installed." in r.stdout
    assert not (tmp_path / "wt.log").exists()


def test_plain_progress_on_the_tty(setup, tmp_path):
    r = setup(FLOW + 'main', env={"KIOSK_SETUP_PLAIN": "1"}, tty="1\n1\n2\n", check=False)
    assert r.returncode == 0, r.stderr
    out = (tmp_path / "tty.out").read_text()
    assert "Step 1 of 9: Install download tools (already installed)" in out
    assert "Step 8 of 9: Start the kiosk and wait for it to be healthy ... done" in out
    assert "Done. Sign out and back in (or restart) to start the kiosk." in out


def test_env_option_preselects_the_picker(setup, tmp_path):
    setup(FLOW + 'main --env rc', answers=["0", "0 rc", "1"], check=False)
    call = next(c for c in wt_calls(tmp_path) if "--menu" in c).splitlines()
    assert call[call.index("--default-item") + 1] == "rc"


def test_sudo_keepalive_stops_with_the_setup(setup, tmp_path):
    r = setup(NOT_ROOT + 'row_set admin ok sudo; KIOSK_SUDO_KEEPALIVE_S=4711; start_sudo_keepalive; '
              'sleep 0.3; pgrep -f "sleep 4711" >/dev/null && echo running; cleanup; sleep 0.3; '
              'pgrep -f "sleep 4711" >/dev/null && echo left || echo gone')
    assert r.stdout.split() == ["running", "gone"]


def test_snapshot_never_keeps_an_earlier_runs_compose(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    snap = tmp_path / "opt" / "setup-snapshot"; snap.mkdir()
    (snap / "docker-compose.yml").write_text("stale\n")
    setup('STEP_LOG_DIR=$(mktemp -d); snapshot_config')
    assert sorted(p.name for p in snap.iterdir()) == ["config.env"]


def test_cleanup_removes_a_downloaded_engine_only(setup, tmp_path):
    dl = tmp_path / "dl.sh"; dl.write_text("x")
    given = tmp_path / "engine.sh"
    setup(f'STEP_LOG_DIR=$(mktemp -d); ENGINE="{dl}"; cleanup')
    setup('STEP_LOG_DIR=$(mktemp -d); cleanup')
    assert not dl.exists() and given.exists()


# ── Task 7 fix round 1 ────────────────────────────────────────────────

def test_done_screen_defaults_to_close(setup, tmp_path):
    setup(FLOW + 'main', answers=["0", "0 prod", "1"], check=False)
    done = wt_calls(tmp_path)[-1].splitlines()
    assert "--defaultno" in done and "Restart now" in done


def test_plain_done_screen_enter_means_close(setup, tmp_path):
    r = setup(FLOW + 'as_root() { "$@"; }; systemctl() { echo "systemctl $*" >> "$PWD/sys.calls"; }; main',
              env={"KIOSK_SETUP_PLAIN": "1"}, tty="1\n1\n\n", check=False)
    assert r.returncode == 0, r.stderr
    assert not (tmp_path / "sys.calls").exists()
    assert "2) Close (press Enter)" in (tmp_path / "tty.out").read_text()


def test_move_dev_data_failure_says_the_move_did_not_finish(setup, tmp_path):
    write_config(tmp_path, *DEV, "edge")
    (tmp_path / "engine.fail").write_text("move-dev-data\n")
    r = setup(FLOW + 'main --env edge --yes', check=False)
    assert r.returncode == 1
    assert "keeps its current version and settings" not in r.stdout
    assert "the data move didn't finish. Run the setup again to finish it." in r.stdout
    assert "download" not in engine_steps(tmp_path)


def test_setup_log_is_root_only(setup, tmp_path):
    (tmp_path / "setup.log").write_text("old\n"); (tmp_path / "setup.log").chmod(0o644)
    setup(FLOW + 'main --env prod --yes', check=False)
    assert (tmp_path / "setup.log").stat().st_mode & 0o777 == 0o600


# A step that runs until it is stopped: its pid and its child's pid go to files.
SLOW_ENGINE = r'''#!/usr/bin/env bash
d="$(dirname "$0")"
case " $* " in
  *" --step $SLOW_STEP "*)
    echo $$ > "$d/slow.pid"; sleep 300 & echo $! > "$d/sleep.pid.t"; mv "$d/sleep.pid.t" "$d/sleep.pid"
    wait; exit 0 ;;
esac
exec bash "$d/engine.sh" "$@"
'''


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def interrupted(tmp_path, body, slow_step, sig, env=None):
    from conftest import BASH, SETUP_SH
    eng = tmp_path / "slow.sh"; eng.write_text(SLOW_ENGINE); eng.chmod(0o755)
    tmp = tmp_path / "tmpdir"; tmp.mkdir()
    (tmp_path / "answers").write_text(""); (tmp_path / "tty").write_text("")
    env = {**os.environ, "KIOSK_SETUP_LIB": "1", "PATH": f"{tmp_path / 'bin'}:{os.environ['PATH']}",
           "WT_LOG": str(tmp_path / "wt.log"), "WT_ANSWERS": str(tmp_path / "answers"),
           "SUDO_LOG": str(tmp_path / "sudo.log"), "KIOSK_TTY": str(tmp_path / "tty"),
           "KIOSK_TTY_OUT": str(tmp_path / "tty.out"), "KIOSK_SETUP_ENGINE": str(eng),
           "KIOSK_SETUP_LOG": str(tmp_path / "setup.log"), "KIOSK_OS_RELEASE": str(tmp_path / "os-release"),
           "KIOSK_DIR": str(tmp_path / "opt"), "KIOSK_VAR_LIB": str(tmp_path / "varlib"),
           "KIOSK_SETUP_POLL_S": "0.05", "TERM": "xterm", "TMPDIR": str(tmp), "SLOW_STEP": slow_step,
           **(env or {})}
    proc = subprocess.Popen([BASH, "-c", f'source "{SETUP_SH}"; {body}'], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=tmp_path)
    deadline = time.time() + 20
    while not (tmp_path / "sleep.pid").exists():
        assert proc.poll() is None and time.time() < deadline, proc.communicate()
        time.sleep(0.05)
    proc.send_signal(sig)
    pids = [int((tmp_path / f).read_text()) for f in ("slow.pid", "sleep.pid")]
    try:
        out, err = proc.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        for p in pids:   # never leave the fake step behind
            if alive(p):
                os.kill(p, signal.SIGKILL)
        raise
    time.sleep(0.2)
    return proc.returncode, out, err, pids, tmp


@pytest.mark.parametrize("sig,code", [(signal.SIGINT, 130), (signal.SIGTERM, 143)])
def test_interrupt_stops_the_running_step(setup, tmp_path, sig, code):
    rc, out, err, pids, tmp = interrupted(tmp_path, FLOW + 'main --env prod --yes', "printers", sig)
    assert rc == code, out + err
    assert not any(alive(p) for p in pids)
    assert list(tmp.iterdir()) == []           # the step logs are gone, and nothing still writes there
    assert "Step 6 of 9: Set up USB label printers ... " in out
    assert "download" not in engine_steps(tmp_path)


def test_interrupting_a_half_done_switch_puts_the_laptop_back(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    before = (tmp_path / "opt" / "config.env").read_text()
    (tmp_path / "opt" / "docker-compose.yml").write_text("prod compose\n")
    rc, out, err, pids, _ = interrupted(tmp_path, FLOW + 'main --env dev --yes', "start", signal.SIGINT)
    assert rc == 130, out + err
    assert not any(alive(p) for p in pids)
    assert (tmp_path / "opt" / "config.env").read_text() == before
    assert (tmp_path / "opt" / "docker-compose.yml").read_text() == "prod compose\n"
    assert "restart" in engine_steps(tmp_path)
    assert "The setup put this laptop back on Prod" in out


def test_a_failed_move_on_retry_still_restores_a_half_done_switch(setup, tmp_path):
    # Prod -> Dev: download fails, Try again then fails in move-dev-data. The
    # snapshot is owed a restore, so Quit must put Prod back (not just say the move didn't finish).
    write_config(tmp_path, *PROD, "stable")
    before = (tmp_path / "opt" / "config.env").read_text()
    (tmp_path / "opt" / "docker-compose.yml").write_text("prod compose\n")
    (tmp_path / "engine.fail").write_text("download\nmove-dev-data\n")
    r = setup(FLOW + 'main', answers=["0", "0 dev", "0", "0 retry", "0 quit", "0"], check=False)
    assert r.returncode == 1
    assert (tmp_path / "opt" / "config.env").read_text() == before
    assert "back on Prod" in wt_calls(tmp_path)[-1]


# ── Final fix round ───────────────────────────────────────────────────

def test_same_environment_download_failure_then_quit_restarts_the_kiosk(setup, tmp_path):
    # A dev laptop's first run with Dev: move-dev-data stops the kiosk, then download fails.
    write_config(tmp_path, *DEV, "beta")
    (tmp_path / "engine.fail").write_text("download\n")
    r = setup(FLOW + 'main', answers=["0", "0 dev", "0 quit", "0"], check=False)
    assert r.returncode == 1
    steps = engine_steps(tmp_path)
    assert steps.count("restart") == 1 and steps.index("restart") > steps.index("download")
    restart = next(l for l in (tmp_path / "engine.log").read_text().splitlines() if l.startswith("restart|"))
    assert "--api-url" not in restart
    last = wt_calls(tmp_path)[-1]
    assert "The kiosk is running again on its current version." in last
    assert "Run the setup again to finish" in last
    log = (tmp_path / "setup.log").read_text()
    assert "---- restart dev ----" in log and "Did restart" in log


def test_same_environment_failure_when_the_restart_fails_says_so(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    (tmp_path / "engine.fail").write_text("download\nrestart\n")
    r = setup(FLOW + 'main --env prod --yes', check=False)
    assert r.returncode == 1 and engine_steps(tmp_path).count("restart") == 1
    assert "The setup couldn't restart the kiosk. Run the setup again, or see the log." in r.stdout
    assert "running again" not in r.stdout


def test_a_failed_switch_still_restores_and_restarts_once(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    before = (tmp_path / "opt" / "config.env").read_text()
    (tmp_path / "engine.fail").write_text("download\n")
    r = setup(FLOW + 'main --env dev --yes', check=False)
    assert r.returncode == 1
    assert (tmp_path / "opt" / "config.env").read_text() == before
    assert engine_steps(tmp_path).count("restart") == 1
    assert "The setup put this laptop back on Prod" in r.stdout and "current version" not in r.stdout


def test_a_new_laptop_failure_restarts_nothing(setup, tmp_path):
    (tmp_path / "engine.fail").write_text("start\n")
    r = setup(FLOW + 'main --env prod --yes', check=False)
    assert r.returncode == 1 and "restart" not in engine_steps(tmp_path)


def test_hangup_restores_a_half_done_switch_into_the_log(setup, tmp_path):
    write_config(tmp_path, *PROD, "stable")
    before = (tmp_path / "opt" / "config.env").read_text()
    (tmp_path / "opt" / "docker-compose.yml").write_text("prod compose\n")
    rc, out, err, pids, tmp = interrupted(tmp_path, FLOW + 'main --env dev --yes', "start", signal.SIGHUP,
                                          env={"KIOSK_TTY": str(tmp_path / "gone"),
                                               "KIOSK_TTY_OUT": str(tmp_path / "gone")})
    assert rc == 129, out + err
    assert not any(alive(p) for p in pids)
    assert list(tmp.iterdir()) == []
    assert (tmp_path / "opt" / "config.env").read_text() == before
    assert "restart" in engine_steps(tmp_path)
    log = (tmp_path / "setup.log").read_text()
    assert "Interrupted (HUP)." in log
    assert "Putting this laptop back on Prod" in log and "The setup put this laptop back on Prod" in log
    assert "Putting this laptop back" not in out + err


STTY = '#!/bin/sh\necho "stty $*" >> "$(dirname "$0")/../stty.calls"\n'


def _stty(tmp_path):
    f = tmp_path / "bin" / "stty"; f.write_text(STTY); f.chmod(0o755)
    calls = tmp_path / "stty.calls"
    return lambda: calls.read_text().splitlines() if calls.exists() else []


def test_cleanup_and_signals_restore_the_terminal(setup, tmp_path):
    calls = _stty(tmp_path)
    setup('STEP_LOG_DIR=$(mktemp -d); cleanup')
    assert calls() == ["stty sane"]
    r = setup('STEP_LOG_DIR=$(mktemp -d); trap cleanup EXIT; on_signal INT', check=False)
    assert r.returncode == 130 and calls().count("stty sane") >= 3   # on_signal, then the EXIT trap


def test_terminal_restore_is_silent_without_a_tty(setup, tmp_path):
    calls = _stty(tmp_path)
    r = setup('STEP_LOG_DIR=$(mktemp -d); trap cleanup EXIT; on_signal INT', check=False,
              env={"KIOSK_TTY": str(tmp_path / "gone")})
    assert r.returncode == 130 and calls() == []
    assert r.stdout == "" and r.stderr == ""


def test_an_early_log_line_creates_a_root_only_log(setup, tmp_path):
    setup('umask 022; log_line hello')
    assert (tmp_path / "setup.log").stat().st_mode & 0o777 == 0o600
    assert "hello" in (tmp_path / "setup.log").read_text()


def test_ctrl_c_at_the_checklist_leaves_a_root_only_log(setup, tmp_path):
    r = setup('umask 022; STEP_LOG_DIR=$(mktemp -d); trap cleanup EXIT; on_signal INT', check=False)
    assert r.returncode == 130
    assert (tmp_path / "setup.log").stat().st_mode & 0o777 == 0o600
    assert "Interrupted (INT)." in (tmp_path / "setup.log").read_text()
