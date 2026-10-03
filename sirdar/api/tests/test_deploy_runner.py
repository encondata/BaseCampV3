import asyncio
import json
import os
import shutil
import stat
import time
from pathlib import Path
from types import SimpleNamespace

import ansible_runner
import pytest

from sirdar_api.deploy import runner as runner_mod
from sirdar_api.deploy.redact import REDACTED, Redactor
from sirdar_api.deploy.runner import AnsibleRunner, RunRequest, RunResult, RunTarget

PW = "ssh-PW-runner-1"
SUDO = "sudo-PW-runner-2"
KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
B64 = "c2VjcmV0LWVudi1maWxl"


def _target(**over) -> RunTarget:
    kw = dict(host="10.0.0.5", port=2222, user="deployer",
              known_hosts_line="[10.0.0.5]:2222 ssh-ed25519 AAAAC3",
              host_key_algorithms="ssh-ed25519", password=PW, private_key=KEY_TEXT,
              become_password=SUDO)
    kw.update(over)
    return RunTarget(**kw)


def _request(**over) -> RunRequest:
    kw = dict(step="render", playbook="render.yml", target=_target(), timeout=300,
              extravars={"env_name": "uat", "env_file_b64": B64})
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
            "env_name": "uat", "env_file_b64": B64, "ansible_password": PW,
            "ansible_become_password": SUDO}
        assert json.loads((run_dir / "inventory" / "hosts.json").read_text()) == {
            "all": {"hosts": {"target": {
                "ansible_host": "10.0.0.5", "ansible_port": 2222, "ansible_user": "deployer",
                "ansible_ssh_private_key_file": str(run_dir / "id_key")}}}}
        assert (run_dir / "project" / "render.yml").is_file()
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
        return SimpleNamespace(status="successful", rc=0)

    monkeypatch.setattr(ansible_runner, "run", fake_run)
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
    monkeypatch.setattr(ansible_runner, "run",
                        lambda **kw: SimpleNamespace(status=status, rc=rc))
    result = await AnsibleRunner(str(tmp_path / "runner")).run(_request(), lambda s: None)
    assert (result.status, result.rc) == expected


async def test_cancel_stops_the_run_and_cleans_up(tmp_path, monkeypatch):
    state: dict = {}

    def fake_run(**kw):
        state["dir"] = Path(kw["private_data_dir"])
        while not kw["cancel_callback"]():
            time.sleep(0.01)
        state["cancelled"] = True
        return SimpleNamespace(status="canceled", rc=254)

    monkeypatch.setattr(ansible_runner, "run", fake_run)
    task = asyncio.create_task(
        AnsibleRunner(str(tmp_path / "runner")).run(_request(), lambda s: None))
    while "dir" not in state:
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert state["cancelled"] is True
    assert not state["dir"].exists()
