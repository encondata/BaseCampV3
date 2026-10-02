"""update.sh (nightly updater) and launch.sh (at-login launcher)."""
import os
import subprocess
from pathlib import Path

from conftest import BASH

UPDATE_SH = Path(__file__).resolve().parents[1] / "update.sh"
LAUNCH_SH = Path(__file__).resolve().parents[1] / "launch.sh"


def _upd(tmp_path, body, docker_script, status_json, extra_env=None):
    fake = tmp_path / "docker"; fake.write_text(docker_script); fake.chmod(0o755)
    st = tmp_path / "status.json"; st.write_text(status_json)
    # An empty template folder: the helper-script refresh finds nothing (and never downloads).
    env = {**os.environ, "KIOSK_UPDATE_LIB": "1", "KIOSK_DIR": str(tmp_path),
           "KIOSK_TEMPLATE_DIR": str(tmp_path / "no-templates"), **(extra_env or {})}
    return subprocess.run([BASH, "-c", f'source "{UPDATE_SH}"; DOCKER=("{fake}"); '
                           f'status_json() {{ cat "{st}"; }}; HEALTH_POLL_S=0; {body}'],
                          capture_output=True, text=True, env=env)


IDLE = '{"outbox": {"queued": 0, "sending": 0, "needs_sign_in": 4, "failed": 1}}'


def test_update_skips_while_uploading(tmp_path):
    r = _upd(tmp_path, 'main; echo rc=$?', '#!/bin/sh\necho "$@" >> "$0.log"\n',
             '{"outbox": {"queued": 2, "sending": 0}}')
    assert "rc=0" in r.stdout and "skipped" in (tmp_path / "update.log").read_text()
    assert not (tmp_path / "docker.log").exists() or "pull" not in (tmp_path / "docker.log").read_text()


def test_update_noop_when_digest_unchanged(tmp_path):
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in *inspect*) echo sha256:same ;; *"image inspect"*) echo sha256:same ;; esac\n')
    r = _upd(tmp_path, 'main; echo rc=$?', script, IDLE)
    log = (tmp_path / "docker.log").read_text()
    assert "rc=0" in r.stdout and "pull" in log and " up " not in f" {log} "


def test_update_rolls_back_when_unhealthy(tmp_path):
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in\n'
              '  *"--format {{.Image}}"*) echo sha256:old ;;\n'
              '  *"image inspect"*) echo sha256:new ;;\n'
              '  *Health*) echo unhealthy ;;\n'
              'esac\n')
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?', script, IDLE)
    log = (tmp_path / "docker.log").read_text()
    assert "rc=1" in r.stdout and "tag sha256:old" in log
    assert "rolled back" in (tmp_path / "update.log").read_text()
    # the rollback re-tags the channel image, then starts it again
    lines = log.splitlines()
    tag = max(i for i, l in enumerate(lines) if l.startswith("tag sha256:old ghcr.io/"))
    assert any(l.endswith("up -d") for l in lines[tag:])


def test_update_log_is_trimmed(tmp_path):
    (tmp_path / "update.log").write_text("x" * (2 * 1024 * 1024) + "TAIL")
    _upd(tmp_path, 'trim_log', '#!/bin/sh\n', '{}')
    text = (tmp_path / "update.log").read_text()
    assert len(text.encode()) <= 1024 * 1024 and text.endswith("TAIL")


# ── beyond the brief ──────────────────────────────────────────────────

HEALTHY_NEW = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
               'case "$*" in\n'
               '  *"--format {{.Image}}"*) echo sha256:old ;;\n'
               '  *"image inspect"*) echo sha256:new ;;\n'
               '  *Health*) echo healthy ;;\n'
               'esac\n')


def test_update_applies_new_image_keeps_previous_and_prunes(tmp_path):
    r = _upd(tmp_path, 'main; echo rc=$?', HEALTHY_NEW, IDLE)
    lines = (tmp_path / "docker.log").read_text().splitlines()
    assert "rc=0" in r.stdout
    # the previous image keeps a tag so the prune can't remove it
    i_keep = lines.index("tag sha256:old serversherpa-kiosk-laptop:previous")
    i_up = next(i for i, l in enumerate(lines) if l.endswith("up -d"))
    i_prune = lines.index("image prune -f --filter "
                          "label=org.opencontainers.image.source=https://github.com/encondata/BaseCampV3")
    assert i_keep < i_up < i_prune
    assert "sha256:old" in (tmp_path / "update-state.json").read_text()
    assert "updated" in (tmp_path / "update.log").read_text()


def test_update_uses_image_from_compose_file(tmp_path):
    (tmp_path / "docker-compose.yml").write_text("services:\n  edge:\n    image: local/kiosk:test\n")
    _upd(tmp_path, 'main', HEALTHY_NEW, IDLE)
    assert "image inspect --format {{.Id}} local/kiosk:test" in (tmp_path / "docker.log").read_text()


def test_update_channel_from_config_when_no_compose_file(tmp_path):
    (tmp_path / "config.env").write_text("KIOSK_CHANNEL=edge\n")
    _upd(tmp_path, 'main', HEALTHY_NEW, IDLE)
    assert "ghcr.io/encondata/serversherpa-kiosk-laptop:edge" in (tmp_path / "docker.log").read_text()


def test_update_runs_when_status_unreachable(tmp_path):
    # a dead kiosk must still be repairable: no status = not uploading
    r = _upd(tmp_path, 'status_json() { return 7; }; main; echo rc=$?', HEALTHY_NEW, IDLE)
    assert "rc=0" in r.stdout and "pull" in (tmp_path / "docker.log").read_text()


def test_update_pull_failure_exits_2(tmp_path):
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in *pull*) exit 1 ;; *"--format {{.Image}}"*) echo sha256:old ;; esac\n')
    r = _upd(tmp_path, 'main; echo rc=$?', script, IDLE)
    assert "rc=2" in r.stdout and " up " not in f' {(tmp_path / "docker.log").read_text()} '


def test_uploading_sed_fallback(tmp_path):
    body = ('python_bin() { return 1; }; '
            'status_json() { echo \'{"outbox":{"queued":0,"sending":3}}\'; }; uploading && echo BUSY; '
            'status_json() { echo \'{"outbox": {"queued": 0, "sending": 0}}\'; }; uploading || echo IDLE')
    out = _upd(tmp_path, body, '#!/bin/sh\n', '{}').stdout
    assert "BUSY" in out and "IDLE" in out


def test_uploading_python(tmp_path):
    body = ('status_json() { echo \'{"outbox":{"queued":1,"sending":0}}\'; }; uploading && echo BUSY; '
            'status_json() { echo \'not json\'; }; uploading || echo IDLE')
    out = _upd(tmp_path, body, '#!/bin/sh\n', '{}').stdout
    assert "BUSY" in out and "IDLE" in out


def test_update_log_falls_back_when_not_writable(tmp_path):
    # the macOS job runs as the desktop user; a root-owned folder must not stop it
    ro = tmp_path / "ro"; ro.mkdir(); ro.chmod(0o500)
    try:
        r = _upd(tmp_path, f'KIOSK_DIR="{ro}"; UPDATE_LOG="{ro}/update.log"; '
                 f'UPDATE_STATE="{ro}/update-state.json"; '
                 f'TMPDIR="{tmp_path}"; main; echo rc=$?', HEALTHY_NEW, IDLE)
    finally:
        ro.chmod(0o700)
    assert "rc=0" in r.stdout
    assert "updated" in (tmp_path / "serversherpa-kiosk-update.log").read_text()



# ── fix round 1: interrupted updates, rejected images ────────────────

def _state(tmp_path, **kw):
    import json
    (tmp_path / "update-state.json").write_text(json.dumps({"previous_image": "", "image": "",
                                                            "rejected_image": "", "phase": "done", **kw}))


def _read_state(tmp_path):
    import json
    return json.loads((tmp_path / "update-state.json").read_text())


def _docker(running, pulled, health):
    return ('#!/bin/sh\necho "$@" >> "$0.log"\n'
            'case "$*" in\n'
            f'  *"--format {{{{.Image}}}}"*) echo {running} ;;\n'
            f'  *"image inspect"*) echo {pulled} ;;\n'
            f'  *Health*) echo {health} ;;\n'
            'esac\n')


def test_update_recovers_from_interrupted_update(tmp_path):
    _state(tmp_path, previous_image="sha256:old", phase="updating")
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?',
             _docker("sha256:new", "sha256:new", "unhealthy"), IDLE)
    log = (tmp_path / "docker.log").read_text()
    assert "rc=1" in r.stdout
    assert "tag sha256:old ghcr.io/encondata/serversherpa-kiosk-laptop:stable" in log
    assert "pull" not in log
    assert "recovered from an interrupted update" in (tmp_path / "update.log").read_text()
    st = _read_state(tmp_path)
    assert st["rejected_image"] == "sha256:new" and st["phase"] == "done"


def test_update_no_recovery_when_interrupted_update_is_healthy(tmp_path):
    _state(tmp_path, previous_image="sha256:old", phase="updating")
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?',
             _docker("sha256:new", "sha256:new", "healthy"), IDLE)
    assert "rc=0" in r.stdout and "tag sha256:old" not in (tmp_path / "docker.log").read_text()
    assert _read_state(tmp_path)["phase"] == "done"


def test_update_no_recovery_after_finished_update(tmp_path):
    # a finished update whose container later turns unhealthy is not rolled back
    _state(tmp_path, previous_image="sha256:old", phase="done")
    _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main', _docker("sha256:new", "sha256:new", "unhealthy"), IDLE)
    assert "recovered" not in (tmp_path / "update.log").read_text()
    assert "tag sha256:old" not in (tmp_path / "docker.log").read_text()


def test_update_rollback_records_rejected_image(tmp_path):
    _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main', _docker("sha256:old", "sha256:new", "unhealthy"), IDLE)
    assert _read_state(tmp_path)["rejected_image"] == "sha256:new"


def test_update_skips_rejected_image(tmp_path):
    _state(tmp_path, previous_image="sha256:old", rejected_image="sha256:bad")
    r = _upd(tmp_path, 'main; echo rc=$?', _docker("sha256:old", "sha256:bad", "healthy"), IDLE)
    log = (tmp_path / "docker.log").read_text()
    assert "rc=0" in r.stdout
    assert "skipping sha256:bad — it failed its health check before" in (tmp_path / "update.log").read_text()
    assert "tag sha256:old ghcr.io/encondata/serversherpa-kiosk-laptop:stable" in log
    assert " up " not in f" {log} "
    assert _read_state(tmp_path)["rejected_image"] == "sha256:bad"


def test_update_newer_image_clears_rejected(tmp_path):
    _state(tmp_path, previous_image="sha256:older", rejected_image="sha256:bad")
    r = _upd(tmp_path, 'main; echo rc=$?', _docker("sha256:old", "sha256:newer", "healthy"), IDLE)
    assert "rc=0" in r.stdout
    st = _read_state(tmp_path)
    assert st["rejected_image"] == "" and st["previous_image"] == "sha256:old"



# ── fix round 2 ───────────────────────────────────────────────────────

def test_failed_rollback_keeps_phase_updating(tmp_path):
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in\n'
              '  tag*) exit 1 ;;\n'
              '  *"--format {{.Image}}"*) echo sha256:old ;;\n'
              '  *"image inspect"*) echo sha256:new ;;\n'
              '  *Health*) echo unhealthy ;;\n'
              'esac\n')
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?', script, IDLE)
    assert "rc=2" in r.stdout
    st = _read_state(tmp_path)
    assert st["phase"] == "updating" and st["previous_image"] == "sha256:old"
    assert "failed" in (tmp_path / "update.log").read_text()


def test_failed_recovery_keeps_phase_updating(tmp_path):
    _state(tmp_path, previous_image="sha256:old", phase="updating")
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in\n'
              '  tag*) exit 1 ;;\n'
              '  *"--format {{.Image}}"*) echo sha256:new ;;\n'
              '  *Health*) echo unhealthy ;;\n'
              'esac\n')
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?', script, IDLE)
    assert "rc=2" in r.stdout and _read_state(tmp_path)["phase"] == "updating"


def test_recovery_with_docker_down_leaves_state_alone(tmp_path):
    _state(tmp_path, previous_image="sha256:old", phase="updating")
    before = (tmp_path / "update-state.json").read_text()
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in info*) exit 1 ;; *) exit 1 ;; esac\n')
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?', script, IDLE)
    assert "rc=2" in r.stdout
    assert (tmp_path / "update-state.json").read_text() == before
    log = (tmp_path / "docker.log").read_text()
    assert "tag" not in log and "pull" not in log


def test_recovery_when_previous_is_running_marks_done(tmp_path):
    # interrupted before the new container replaced the old one
    _state(tmp_path, previous_image="sha256:old", phase="updating")
    r = _upd(tmp_path, 'main; echo rc=$?', _docker("sha256:old", "sha256:old", "healthy"), IDLE)
    assert "rc=0" in r.stdout and _read_state(tmp_path)["phase"] == "done"


def test_rejected_image_with_no_container_still_starts_kiosk(tmp_path):
    _state(tmp_path, rejected_image="sha256:bad")
    r = _upd(tmp_path, 'main; echo rc=$?', _docker("", "sha256:bad", "healthy"), IDLE)
    log = (tmp_path / "docker.log").read_text()
    assert "rc=0" in r.stdout and any(l.endswith("up -d") for l in log.splitlines())
    assert "starting it anyway" in (tmp_path / "update.log").read_text()


def test_rejected_image_with_no_container_prefers_previous_tag(tmp_path):
    _state(tmp_path, rejected_image="sha256:bad")
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in\n'
              '  *"--format {{.Image}}"*) exit 1 ;;\n'
              '  *"image inspect --format {{.Id}} serversherpa-kiosk-laptop:previous"*) echo sha256:prev ;;\n'
              '  *"image inspect"*) echo sha256:bad ;;\n'
              'esac\n')
    r = _upd(tmp_path, 'main; echo rc=$?', script, IDLE)
    lines = (tmp_path / "docker.log").read_text().splitlines()
    # by name: on the containerd store the ID alone may not resolve
    i_tag = lines.index("tag serversherpa-kiosk-laptop:previous ghcr.io/encondata/serversherpa-kiosk-laptop:stable")
    assert "rc=0" in r.stdout and any(l.endswith("up -d") for l in lines[i_tag:])
    assert "sha256:prev" in (tmp_path / "update.log").read_text()


# ── final fix round ──────────────────────────────────────────────────

def test_recovery_without_container_keeps_earlier_rejected_image(tmp_path):
    _state(tmp_path, previous_image="sha256:old", phase="updating", rejected_image="sha256:bad")
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in\n'
              '  *"--format {{.Image}}"*) exit 1 ;;\n'
              '  *Health*) exit 1 ;;\n'
              'esac\n')
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?', script, IDLE)
    assert "rc=1" in r.stdout
    st = _read_state(tmp_path)
    assert st["rejected_image"] == "sha256:bad" and st["phase"] == "done"


def test_recovery_records_running_image_as_rejected(tmp_path):
    _state(tmp_path, previous_image="sha256:old", phase="updating", rejected_image="sha256:bad")
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?',
             _docker("sha256:new", "sha256:new", "unhealthy"), IDLE)
    assert "rc=1" in r.stdout and _read_state(tmp_path)["rejected_image"] == "sha256:new"


def test_rejected_image_no_container_logs_failed_retag(tmp_path):
    _state(tmp_path, rejected_image="sha256:bad")
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in\n'
              '  tag*) exit 1 ;;\n'
              '  *"--format {{.Image}}"*) exit 1 ;;\n'
              '  *"image inspect --format {{.Id}} serversherpa-kiosk-laptop:previous"*) echo sha256:prev ;;\n'
              '  *"image inspect"*) echo sha256:bad ;;\n'
              'esac\n')
    r = _upd(tmp_path, 'main; echo rc=$?', script, IDLE)
    log = (tmp_path / "update.log").read_text()
    assert "rc=0" in r.stdout
    assert ("Couldn't re-tag ghcr.io/encondata/serversherpa-kiosk-laptop:stable to the kept previous "
            "image sha256:prev; starting it anyway (sha256:bad).") in log
    assert "no earlier image is kept" not in log
    assert any(l.endswith("up -d") for l in (tmp_path / "docker.log").read_text().splitlines())


# ── fix round 3: containerd image store ──────────────────────────────

from conftest import store_docker  # noqa: E402

REF = "ghcr.io/encondata/serversherpa-kiosk-laptop:stable"
PREV = "serversherpa-kiosk-laptop:previous"


def _run_store(tmp_path, body="main; echo rc=$?"):
    st = tmp_path / "status.json"; st.write_text(IDLE)
    env = {**os.environ, "KIOSK_UPDATE_LIB": "1", "KIOSK_DIR": str(tmp_path)}
    return subprocess.run([BASH, "-c", f'source "{UPDATE_SH}"; DOCKER=("{tmp_path}/docker"); '
                           f'status_json() {{ cat "{st}"; }}; HEALTH_POLL_S=0; HEALTH_TIMEOUT_S=0; {body}'],
                          capture_output=True, text=True, env=env)


def _calls(tmp_path):
    return (tmp_path / "docker.log").read_text().splitlines()


import pytest  # noqa: E402


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_update_tags_previous_by_name_before_the_pull(tmp_path, mode):
    _, store = store_docker(tmp_path, mode, REF, {REF: "sha256:old"}, running="sha256:old", pulled="sha256:new")
    r = _run_store(tmp_path)
    assert "rc=0" in r.stdout
    calls = _calls(tmp_path)
    i_prev = calls.index(f"tag {REF} {PREV}")
    assert i_prev < next(i for i, c in enumerate(calls) if c.endswith(" pull"))
    tags, running = store()
    assert tags[PREV] == "sha256:old" and running == "sha256:new"
    assert "Couldn't tag" not in (tmp_path / "update.log").read_text()


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_rollback_tags_from_previous(tmp_path, mode):
    _, store = store_docker(tmp_path, mode, REF, {REF: "sha256:old"}, running="sha256:old",
                            pulled="sha256:new", bad=("sha256:new",))
    r = _run_store(tmp_path)
    assert "rc=1" in r.stdout, (tmp_path / "update.log").read_text()
    assert f"tag {PREV} {REF}" in _calls(tmp_path)
    tags, running = store()
    assert running == "sha256:old" and tags[REF] == "sha256:old"
    assert _read_state(tmp_path)["rejected_image"] == "sha256:new"


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_rejected_skip_repoints_ref_from_previous(tmp_path, mode):
    _state(tmp_path, rejected_image="sha256:bad")
    _, store = store_docker(tmp_path, mode, REF, {REF: "sha256:old"}, running="sha256:old", pulled="sha256:bad")
    r = _run_store(tmp_path)
    assert "rc=0" in r.stdout
    assert f"tag {PREV} {REF}" in _calls(tmp_path)
    tags, running = store()
    assert tags[REF] == "sha256:old" and running == "sha256:old"
    assert "Couldn't re-tag" not in (tmp_path / "update.log").read_text()


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_recovery_tags_from_previous(tmp_path, mode):
    # interrupted: :previous was tagged before the pull, the new (bad) image runs
    _state(tmp_path, previous_image="sha256:old", phase="updating")
    _, store = store_docker(tmp_path, mode, REF, {REF: "sha256:new", PREV: "sha256:old"},
                            running="sha256:new", pulled="sha256:new", bad=("sha256:new",))
    r = _run_store(tmp_path)
    assert "rc=1" in r.stdout, (tmp_path / "update.log").read_text()
    tags, running = store()
    assert running == "sha256:old" and tags[REF] == "sha256:old"
    assert "recovered from an interrupted update" in (tmp_path / "update.log").read_text()


@pytest.mark.parametrize("mode", ["containerd", "classic"])
def test_store_start_without_container_uses_previous_name(tmp_path, mode):
    _state(tmp_path, rejected_image="sha256:bad")
    _, store = store_docker(tmp_path, mode, REF, {REF: "sha256:old", PREV: "sha256:old"},
                            running="", pulled="sha256:bad")
    r = _run_store(tmp_path)
    assert "rc=0" in r.stdout
    assert f"tag {PREV} {REF}" in _calls(tmp_path)
    tags, running = store()
    assert running == "sha256:old"


def test_store_previous_holding_another_image_falls_back_to_id_and_logs(tmp_path):
    # classic store: :previous is stale, the ID still resolves
    _, store = store_docker(tmp_path, "classic", REF, {REF: "sha256:old", PREV: "sha256:older"},
                            running="sha256:old", pulled="sha256:new", bad=("sha256:new",))
    r = _run_store(tmp_path, 'PREV_IMAGE=sha256:old; NEW_IMAGE=sha256:new; rollback sha256:old; echo rc=$?')
    assert "rc=1" in r.stdout
    assert f"tag sha256:old {REF}" in _calls(tmp_path)
    assert "holds sha256:older, not sha256:old" in r.stdout   # log() prints; main sends it to update.log


# ── launch.sh ─────────────────────────────────────────────────────────

def _launch(tmp_path, body, config="KIOSK_BROWSER=/usr/bin/google-chrome\n"):
    (tmp_path / "config.env").write_text(config)
    env = {**os.environ, "KIOSK_LAUNCH_LIB": "1", "KIOSK_DIR": str(tmp_path)}
    return subprocess.run([BASH, "-c", f'source "{LAUNCH_SH}"; KIOSK_LAUNCH_POLL_S=0; {body}'],
                          capture_output=True, text=True, env=env)


def test_launch_waits_for_identity_then_opens_linux(tmp_path):
    calls = tmp_path / "calls"
    body = (f'n=0; kiosk_answers() {{ n=$((n+1)); [ $n -ge 3 ]; }}; '
            f'run_browser() {{ echo "$*" >> "{calls}"; }}; OS=Linux; main; echo "tries=$n"')
    r = _launch(tmp_path, body)
    assert "tries=3" in r.stdout
    assert calls.read_text().strip() == "/usr/bin/google-chrome --app=http://localhost:8090"


def test_launch_opens_app_mode_on_macos(tmp_path):
    calls = tmp_path / "calls"
    body = (f'kiosk_answers() {{ :; }}; open() {{ echo "$*" >> "{calls}"; }}; OS=Darwin; main')
    _launch(tmp_path, body, config="KIOSK_BROWSER=/Applications/Google Chrome.app\n")
    assert calls.read_text().strip() == \
        "-na /Applications/Google Chrome.app --args --app=http://localhost:8090"


def test_launch_gives_up_waiting_and_still_opens(tmp_path):
    calls = tmp_path / "calls"
    body = (f'kiosk_answers() {{ return 1; }}; run_browser() {{ echo "$*" >> "{calls}"; }}; '
            f'KIOSK_LAUNCH_TIMEOUT_S=0; OS=Linux; main; echo rc=$?')
    r = _launch(tmp_path, body)
    assert "rc=0" in r.stdout and calls.exists()


def test_launch_without_browser_uses_default_opener(tmp_path):
    calls = tmp_path / "calls"
    body = (f'kiosk_answers() {{ :; }}; xdg-open() {{ echo "xdg $*" >> "{calls}"; }}; '
            f'find_browser() {{ :; }}; '
            f'open() {{ echo "open $*" >> "{calls}"; }}; OS=Linux; main; OS=Darwin; main')
    _launch(tmp_path, body, config="KIOSK_BROWSER=\n")
    assert calls.read_text().splitlines() == ["xdg http://localhost:8090", "open http://localhost:8090"]



def test_launch_detects_browser_when_none_configured_linux(tmp_path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    for name in ("microsoft-edge", "chromium"):
        (bindir / name).write_text("#!/bin/sh\n"); (bindir / name).chmod(0o755)
    import shutil
    for tool in ("grep", "head"):   # only these on PATH: no real Chrome on a CI runner
        (bindir / tool).symlink_to(shutil.which(tool))
    calls = tmp_path / "calls"
    body = (f'kiosk_answers() {{ :; }}; run_browser() {{ echo "$*" >> "{calls}"; }}; '
            f'PATH="{bindir}"; OS=Linux; main')
    _launch(tmp_path, body, config="KIOSK_BROWSER=\n")
    # the installer's order: Chromium before Edge
    assert calls.read_text().strip() == f"{bindir}/chromium --app=http://localhost:8090"


def test_launch_detects_browser_when_none_configured_macos(tmp_path):
    apps = tmp_path / "Applications"
    (apps / "Microsoft Edge.app").mkdir(parents=True)
    (apps / "Google Chrome.app").mkdir()
    calls = tmp_path / "calls"
    body = (f'kiosk_answers() {{ :; }}; open() {{ echo "$*" >> "{calls}"; }}; '
            f'MAC_APPS_DIR="{apps}"; OS=Darwin; main')
    _launch(tmp_path, body, config="KIOSK_BROWSER=\n")
    assert calls.read_text().strip() == f"-na {apps}/Google Chrome.app --args --app=http://localhost:8090"


# ── helper-script refresh ─────────────────────────────────────────────

OLD_HOSTNET = "#!/usr/bin/env bash\necho old-hostnet\n"
NEW_HOSTNET = "#!/usr/bin/env bash\necho new-hostnet\n"


def _helpers(tmp_path, installed, published, body='refresh_helpers; echo rc=$?', extra_env=None):
    """KIOSK_DIR = tmp_path/k (the installed scripts); KIOSK_TEMPLATE_DIR = tmp_path/t."""
    k = tmp_path / "k"; t = tmp_path / "t"
    k.mkdir(); t.mkdir()
    for name, text in installed.items():
        (k / name).write_text(text); (k / name).chmod(0o755)
    for name, text in published.items():
        (t / name).write_text(text)
    fake = tmp_path / "docker"; fake.write_text("#!/bin/sh\n"); fake.chmod(0o755)
    env = {**os.environ, "KIOSK_UPDATE_LIB": "1", "KIOSK_DIR": str(k),
           "KIOSK_TEMPLATE_DIR": str(t), **(extra_env or {})}
    r = subprocess.run([BASH, "-c", f'source "{UPDATE_SH}"; DOCKER=("{fake}"); {body}'],
                       capture_output=True, text=True, env=env)
    return r, k


def test_helper_changed_file_is_replaced_keeps_mode_and_runs_hostnet(tmp_path):
    # the published hostnet.sh records that it ran (it is the stub)
    published = "#!/usr/bin/env bash\necho ran >> \"$(dirname \"$0\")/ran.txt\"\n"
    r, k = _helpers(tmp_path, {"hostnet.sh": OLD_HOSTNET, "launch.sh": OLD_HOSTNET, "update.sh": "u"},
                    {"hostnet.sh": published, "launch.sh": NEW_HOSTNET},
                    body='chmod 750 "$KIOSK_DIR/hostnet.sh"; refresh_helpers; echo rc=$?')
    assert "rc=0" in r.stdout
    assert (k / "hostnet.sh").read_text() == published
    assert oct((k / "hostnet.sh").stat().st_mode & 0o777) == "0o750"
    assert (k / "launch.sh").read_text() == NEW_HOSTNET
    assert (k / "ran.txt").read_text() == "ran\n"   # exactly once
    assert not [p for p in k.iterdir() if p.name.startswith(".")]  # no temp files left
    assert "hostnet.sh: refreshed" in r.stdout and "launch.sh: refreshed" in r.stdout


def test_helper_identical_file_is_left_alone(tmp_path):
    r, k = _helpers(tmp_path, {"hostnet.sh": NEW_HOSTNET, "launch.sh": NEW_HOSTNET},
                    {"hostnet.sh": NEW_HOSTNET, "launch.sh": NEW_HOSTNET},
                    body='touch -t 200001010000 "$KIOSK_DIR/hostnet.sh"; refresh_helpers; echo rc=$?')
    assert (k / "hostnet.sh").stat().st_mtime < 1e9   # year 2000, untouched
    assert "hostnet.sh: unchanged" in r.stdout and "refreshed" not in r.stdout
    assert not (k / "ran.txt").exists()


def test_helper_bad_files_are_rejected_and_old_kept(tmp_path):
    for bad, why in (("#!/usr/bin/env bash\nif then fi (\n", "syntax"), ("echo hi\n", "shebang"), ("", "empty")):
        sub = tmp_path / why; sub.mkdir()
        r, k = _helpers(sub, {"hostnet.sh": OLD_HOSTNET, "launch.sh": OLD_HOSTNET},
                        {"hostnet.sh": bad, "launch.sh": bad})
        assert "rc=0" in r.stdout
        assert (k / "hostnet.sh").read_text() == OLD_HOSTNET and (k / "launch.sh").read_text() == OLD_HOSTNET
        assert "hostnet.sh: failed" in r.stdout and why in r.stdout


def test_helper_download_failure_is_logged_and_exit_code_unaffected(tmp_path):
    # no KIOSK_TEMPLATE_DIR: curl is a stub that always fails
    k = tmp_path / "k"; k.mkdir()
    (k / "hostnet.sh").write_text(OLD_HOSTNET); (k / "launch.sh").write_text(OLD_HOSTNET)
    (k / "update.sh").write_text("u")
    (k / "config.env").write_text("KIOSK_INSTALLER_REF=feature-x\n")
    bindir = tmp_path / "bin"; bindir.mkdir()
    (bindir / "curl").write_text('#!/bin/sh\necho "$@" >> "$0.log"\nexit 22\n'); (bindir / "curl").chmod(0o755)
    fake = tmp_path / "docker"; fake.write_text("#!/bin/sh\n"); fake.chmod(0o755)
    env = {**os.environ, "KIOSK_UPDATE_LIB": "1", "KIOSK_DIR": str(k),
           "PATH": f"{bindir}:{os.environ['PATH']}"}
    env.pop("KIOSK_TEMPLATE_DIR", None)
    # the image step fails (2); the refresh must not change that, nor block it
    r = subprocess.run([BASH, "-c", f'source "{UPDATE_SH}"; DOCKER=("{fake}"); '
                        f'status_json() {{ echo "{{}}"; }}; pull_changed() {{ return 2; }}; '
                        f'run_update; echo rc=$?'], capture_output=True, text=True, env=env)
    assert "rc=2" in r.stdout
    assert "hostnet.sh: failed (download)" in r.stdout and "launch.sh: failed (download)" in r.stdout
    assert (k / "hostnet.sh").read_text() == OLD_HOSTNET
    calls = (bindir / "curl.log").read_text()
    assert "--max-time 30" in calls and "/feature-x/kiosk_laptop/installer/hostnet.sh" in calls


def test_helper_ref_defaults_to_main(tmp_path):
    r, _ = _helpers(tmp_path, {}, {}, body='installer_ref')
    assert r.stdout == "main"


def test_helper_refresh_runs_after_image_step_and_never_touches_update_sh(tmp_path):
    k = tmp_path / "k"; k.mkdir(); t = tmp_path / "t"; t.mkdir()
    (k / "update.sh").write_text("#!/usr/bin/env bash\n# original\n")
    (t / "update.sh").write_text("#!/usr/bin/env bash\n# replaced\n")
    (t / "hostnet.sh").write_text(NEW_HOSTNET); (t / "launch.sh").write_text(NEW_HOSTNET)
    fake = tmp_path / "docker"; fake.write_text("#!/bin/sh\n"); fake.chmod(0o755)
    st = tmp_path / "status.json"; st.write_text('{"outbox": {"queued": 2, "sending": 0}}')
    env = {**os.environ, "KIOSK_UPDATE_LIB": "1", "KIOSK_DIR": str(k), "KIOSK_TEMPLATE_DIR": str(t)}
    r = subprocess.run([BASH, "-c", f'source "{UPDATE_SH}"; DOCKER=("{fake}"); status_json() {{ cat "{st}"; }}; '
                        f'main; echo rc=$?'], capture_output=True, text=True, env=env)
    log = (k / "update.log").read_text()
    assert "rc=0" in r.stdout
    assert log.index("skipped") < log.index("hostnet.sh: refreshed")   # even when the image step skipped
    assert (k / "update.sh").read_text() == "#!/usr/bin/env bash\n# original\n"
