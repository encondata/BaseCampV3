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
