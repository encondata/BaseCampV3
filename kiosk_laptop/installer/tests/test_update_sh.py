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
    env = {**os.environ, "KIOSK_UPDATE_LIB": "1", "KIOSK_DIR": str(tmp_path), **(extra_env or {})}
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
            f'open() {{ echo "open $*" >> "{calls}"; }}; OS=Linux; main; OS=Darwin; main')
    _launch(tmp_path, body, config="KIOSK_BROWSER=\n")
    assert calls.read_text().splitlines() == ["xdg http://localhost:8090", "open http://localhost:8090"]

