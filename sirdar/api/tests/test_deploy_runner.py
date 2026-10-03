import asyncio
import json
import os
import shutil
import stat
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import ansible_runner.interface
import pytest

from sirdar_api.deploy import runner as runner_mod
from sirdar_api.deploy.redact import REDACTED, Redactor
from sirdar_api.deploy.runner import AnsibleRunner, RunRequest, RunResult, RunTarget

PW = "ssh-PW-runner-1"
SUDO = "sudo-PW-runner-2"
KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
B64 = "c2VjcmV0LWVudi1maWxl"


def _target(**over) -> RunTarget:
    kw = {"host": "10.0.0.5", "port": 2222, "user": "deployer",
              "known_hosts_line": "[10.0.0.5]:2222 ssh-ed25519 AAAAC3",
              "host_key_algorithms": "ssh-ed25519", "password": PW, "private_key": KEY_TEXT,
              "become_password": SUDO}
    kw.update(over)
    return RunTarget(**kw)


def _request(**over) -> RunRequest:
    kw = {"step": "render", "playbook": "render.yml", "target": _target(), "timeout": 300,
              "extravars": {"env_name": "uat", "env_file_b64": B64}}
    kw.update(over)
    return RunRequest(**kw)


def _mode(path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def test_redactor():
    redact = Redactor(["s3cret-value", "s3cret", "", "abc", None])
    assert redact("x s3cret-value y s3cret z abc") == f"x {REDACTED} y {REDACTED} z abc"
    assert Redactor([])("plain") == "plain"
    assert Redactor(["a.b.c"])("a.b.c axbxc") == f"{REDACTED} axbxc"   # literal, not a regex


def test_reprs_hide_secrets():
    text = repr(_request())
    for secret in (PW, SUDO, KEY_TEXT, B64):
        assert secret not in text


def test_prepare_writes_private_files(tmp_path):
    runner = AnsibleRunner(str(tmp_path / "runner"))
    run_dir = runner.prepare(_request())
    try:
        assert _mode(tmp_path / "runner") == 0o700
        assert _mode(run_dir) == 0o700
        for name in ("known_hosts", "id_key", "env/extravars", "inventory/hosts.json",
                     "ansible.cfg"):
            assert _mode(run_dir / name) == 0o600, name
        assert (run_dir / "known_hosts").read_text() == "[10.0.0.5]:2222 ssh-ed25519 AAAAC3\n"
        assert (run_dir / "id_key").read_text() == KEY_TEXT + "\n"
        assert json.loads((run_dir / "env" / "extravars").read_text()) == {
            "env_name": {"__ansible_unsafe": "uat"},
            "env_file_b64": {"__ansible_unsafe": B64},
            "ansible_password": {"__ansible_unsafe": PW},
            "ansible_become_password": {"__ansible_unsafe": SUDO}}
        assert json.loads((run_dir / "inventory" / "hosts.json").read_text()) == {
            "all": {"hosts": {"target": {
                "ansible_host": "10.0.0.5", "ansible_port": 2222, "ansible_user": "deployer",
                "ansible_ssh_private_key_file": str(run_dir / "id_key")}}}}
        assert (run_dir / "project" / "render.yml").is_file()
    finally:
        shutil.rmtree(run_dir)


def test_extravars_are_never_templated(tmp_path):
    """ansible templates string extravars: "{{ 7*7 }}" in a password would
    reach the target as "49", and a lookup would run a command in Sirdar.
    Every string, at any depth, is written as an unsafe (literal) value."""
    pw, sudo = "ab{{ 7*7 }}cd", "x{% raw %}y{{ lookup('pipe', 'id') }}"
    runner = AnsibleRunner(str(tmp_path / "runner"))
    run_dir = runner.prepare(_request(
        target=_target(password=pw, become_password=sudo),
        extravars={"env_name": "uat", "min_disk_gb": 10, "dump_required": True,
                   "tags": ["a{{ x }}", 3], "nested": {"k": "{{ y }}", "n": None}}))
    try:
        assert json.loads((run_dir / "env" / "extravars").read_text()) == {
            "env_name": {"__ansible_unsafe": "uat"},
            "min_disk_gb": 10,
            "dump_required": True,
            "tags": [{"__ansible_unsafe": "a{{ x }}"}, 3],
            "nested": {"k": {"__ansible_unsafe": "{{ y }}"}, "n": None},
            "ansible_password": {"__ansible_unsafe": pw},
            "ansible_become_password": {"__ansible_unsafe": sudo}}
    finally:
        shutil.rmtree(run_dir)


def test_prepare_without_password_or_key(tmp_path):
    runner = AnsibleRunner(str(tmp_path / "runner"))
    run_dir = runner.prepare(_request(target=_target(password=None, private_key=None,
                                                     become_password=None)))
    try:
        assert not (run_dir / "id_key").exists()
        extravars = json.loads((run_dir / "env" / "extravars").read_text())
        assert "ansible_password" not in extravars
        assert "ansible_become_password" not in extravars
        hosts = json.loads((run_dir / "inventory" / "hosts.json").read_text())
        assert "ansible_ssh_private_key_file" not in hosts["all"]["hosts"]["target"]
    finally:
        shutil.rmtree(run_dir)


def test_failed_prepare_leaves_nothing(tmp_path, monkeypatch):
    def boom(*a, **kw):
        raise OSError("disk full")
    monkeypatch.setattr(runner_mod.shutil, "copytree", boom)
    with pytest.raises(OSError):
        AnsibleRunner(str(tmp_path / "runner")).prepare(_request())
    assert list((tmp_path / "runner").iterdir()) == []


def test_prepare_reports_an_unwritable_runner_dir(tmp_path, monkeypatch):
    """A runner dir Sirdar can't fix up (not owned by uid 10001) raises
    RunnerDirUnwritable, which the pipeline turns into actionable copy."""
    def denied(*a, **kw):
        raise PermissionError(1, "Operation not permitted")
    monkeypatch.setattr(runner_mod.os, "chmod", denied)
    with pytest.raises(runner_mod.RunnerDirUnwritable):
        AnsibleRunner(str(tmp_path / "runner")).prepare(_request())


def test_envvars_pin_the_host_key(tmp_path):
    run_dir = tmp_path / "run-x"
    env = AnsibleRunner(str(tmp_path)).envvars(run_dir, _target())
    args = env["ANSIBLE_SSH_ARGS"]
    for part in (f"-o UserKnownHostsFile={run_dir / 'known_hosts'}",
                 "-o StrictHostKeyChecking=yes", "-o GlobalKnownHostsFile=/dev/null",
                 "-o HostKeyAlgorithms=ssh-ed25519", "-F /dev/null", "-o ControlMaster=no",
                 "-o IdentitiesOnly=yes"):
        assert part in args, part
    assert env["ANSIBLE_HOST_KEY_CHECKING"] == "True"
    assert env["ANSIBLE_CONFIG"] == str(run_dir / "ansible.cfg")
    assert env["ANSIBLE_HOME"] == str(run_dir / "home")
    assert env["ANSIBLE_PIPELINING"] == "False"
    assert env["PATH"].split(os.pathsep)[0] == str(
        Path(runner_mod.ansible_playbook_binary()).parent)


def _fake_init(fn):
    """init_runner stand-in: fn(**kw) plays the run; returns (status, rc)."""
    def init(**kw):
        return SimpleNamespace(config=SimpleNamespace(env={}), run=lambda: fn(**kw))
    return init


def test_ansible_playbook_binary():
    assert Path(runner_mod.ansible_playbook_binary()).is_file()


async def test_run_streams_output_reports_stats_and_cleans_up(tmp_path, monkeypatch):
    seen: dict = {}

    def fake_run(**kw):
        run_dir = Path(kw["private_data_dir"])
        seen["dir"], seen["kw"] = run_dir, kw
        assert (run_dir / "env" / "extravars").is_file()
        seen["keep"] = kw["event_handler"]({"event": "runner_on_ok",
                                            "stdout": "ok: [target]"})
        kw["event_handler"]({"event": "playbook_on_stats", "stdout": "PLAY RECAP",
                             "event_data": {"changed": {"target": 2},
                                            "artifact_data": {"dump_path": "/x.dump"}}})
        kw["event_handler"]({"event": "verbose", "stdout": ""})
        return "successful", 0

    monkeypatch.setattr(ansible_runner.interface, "init_runner", _fake_init(fake_run))
    lines: list[str] = []
    result = await AnsibleRunner(str(tmp_path / "runner")).run(_request(), lines.append)
    assert result == RunResult(status="successful", rc=0, changed=2,
                               data={"dump_path": "/x.dump"})
    assert lines == ["ok: [target]\n", "PLAY RECAP\n"]
    assert seen["keep"] is False                  # no event files on disk
    assert not seen["dir"].exists()
    kw = seen["kw"]
    assert (kw["playbook"], kw["timeout"], kw["quiet"]) == ("render.yml", 300, True)
    assert "binary" not in kw                     # raw mode would drop the playbook
    assert "UserKnownHostsFile" in kw["envvars"]["ANSIBLE_SSH_ARGS"]


@pytest.mark.parametrize("status, rc, expected", [
    ("failed", 2, ("failed", 2)), ("timeout", 254, ("timeout", 254)),
    ("error", None, ("failed", -1))])
async def test_run_status_mapping(tmp_path, monkeypatch, status, rc, expected):
    monkeypatch.setattr(ansible_runner.interface, "init_runner",
                        _fake_init(lambda **kw: (status, rc)))
    result = await AnsibleRunner(str(tmp_path / "runner")).run(_request(), lambda s: None)
    assert (result.status, result.rc) == expected


async def test_cancel_stops_the_run_and_cleans_up(tmp_path, monkeypatch):
    state: dict = {}

    def fake_run(**kw):
        state["dir"] = Path(kw["private_data_dir"])
        while not kw["cancel_callback"]():
            time.sleep(0.01)
        state["cancelled"] = True
        return "canceled", 254

    monkeypatch.setattr(ansible_runner.interface, "init_runner", _fake_init(fake_run))
    task = asyncio.create_task(
        AnsibleRunner(str(tmp_path / "runner")).run(_request(), lambda s: None))
    while "dir" not in state:
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert state["cancelled"] is True
    assert not state["dir"].exists()


def test_job_env_is_an_allowlist(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "sentinel-secrets-key")
    monkeypatch.setenv("SIRDAR_DATABASE_URL", "postgresql://u:sentinel-db@h/d")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("LC_ALL", "C")
    runner = AnsibleRunner(str(tmp_path / "runner"))
    run_dir = runner.prepare(_request())
    try:
        built = runner.build_runner(run_dir, _request(), lambda e: False, lambda: False)
        env = built.config.env
        assert "SIRDAR_SECRETS_KEY" not in env and "SIRDAR_DATABASE_URL" not in env
        assert not any("sentinel" in v for v in env.values())
        assert env["HOME"] == str(tmp_path) and env["LC_ALL"] == "C"
        assert env["PATH"].split(os.pathsep)[0] == str(
            Path(runner_mod.ansible_playbook_binary()).parent)
        assert env["ANSIBLE_HOST_KEY_CHECKING"] == "True"
        assert built.config.suppress_output_file is True
        assert os.environ["SIRDAR_SECRETS_KEY"] == "sentinel-secrets-key"   # untouched
    finally:
        shutil.rmtree(run_dir)


async def test_cancel_during_prepare_leaves_no_folder(tmp_path, monkeypatch):
    runner = AnsibleRunner(str(tmp_path / "runner"))
    real_prepare = runner.prepare
    entered = threading.Event()
    prepared = threading.Event()

    def slow_prepare(request):
        entered.set()
        time.sleep(0.3)
        try:
            return real_prepare(request)
        finally:
            prepared.set()

    monkeypatch.setattr(runner, "prepare", slow_prepare)
    task = asyncio.create_task(runner.run(_request(), lambda s: None))
    while not entered.is_set():
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    while not prepared.is_set():          # the folder now exists (or is already gone)
        await asyncio.sleep(0.01)
    for _ in range(100):                  # bounded wait for the done-callback
        await asyncio.sleep(0.05)
        if not list((tmp_path / "runner").glob("run-*")):
            break
    assert list((tmp_path / "runner").glob("run-*")) == []


def test_sweep_removes_only_stale_run_folders(tmp_path):
    runner = AnsibleRunner(str(tmp_path / "runner"))
    root = tmp_path / "runner"
    root.mkdir()
    old, fresh, other = root / "run-old", root / "run-fresh", root / "keep-me"
    for d in (old, fresh, other):
        d.mkdir()
    ancient = time.time() - runner_mod.STALE_RUN_SECONDS - 60
    os.utime(old, (ancient, ancient))
    os.utime(other, (ancient, ancient))
    assert runner.sweep_stale() == 1
    assert not old.exists() and fresh.exists() and other.exists()


def test_stale_cutoff_exceeds_every_step_timeout():
    from sirdar_api.deploy.steps import STEPS
    assert runner_mod.STALE_RUN_SECONDS > (
        max(s.timeout for s in STEPS) + runner_mod.CANCEL_GRACE_SECONDS)
