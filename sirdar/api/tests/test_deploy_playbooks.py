import json
import os
import subprocess
import sys
from importlib import resources
from pathlib import Path

import pytest
import yaml

from sirdar_api.deploy import steps
from sirdar_api.deploy.steps import PLAYBOOK_DIR

ANSIBLE_PLAYBOOK = Path(sys.executable).parent / "ansible-playbook"
SHELL_MODULES = {"shell", "ansible.builtin.shell", "raw", "ansible.builtin.raw"}


def _tasks(playbook: str):
    plays = yaml.safe_load((PLAYBOOK_DIR / playbook).read_text())
    found: list[dict] = []

    def walk(tasks):
        for task in tasks or []:
            found.append(task)
            walk(task.get("block"))

    for play in plays:
        walk(play.get("tasks"))
    return plays, found


def test_plans():
    assert [s.number for s in steps.STEPS] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert [s.number for s in steps.plan_for("update")] == [1, 2, 3, 4, 5, 6, 8]
    assert [s.key for s in steps.plan_for("reset")] == [
        "preflight", "bootstrap", "fetch", "render", "build", "reset", "up"]
    with pytest.raises(ValueError):
        steps.plan_for("adopt")
    assert steps.STEPS_BY_KEY["up"].timeout >= 30 * 60
    assert steps.STEPS_BY_KEY["build"].timeout >= 60 * 60
    assert steps.STEPS_BY_KEY["up"].name == "Start services"


def test_every_playbook_belongs_to_a_step():
    assert sorted(p.name for p in PLAYBOOK_DIR.glob("*.yml")) == \
        sorted(s.playbook for s in steps.STEPS)


def test_playbooks_ship_with_the_package():
    folder = resources.files("sirdar_api.deploy").joinpath("ansible")
    for step in steps.STEPS:
        assert folder.joinpath(step.playbook).is_file()


@pytest.mark.parametrize("step", steps.STEPS, ids=lambda s: s.key)
def test_playbook_shape(step):
    plays, tasks = _tasks(step.playbook)
    assert len(plays) == 1 and plays[0]["hosts"] == "target"
    assert tasks
    for task in tasks:
        assert task.get("name"), f"{step.playbook}: every task needs a name"
        assert not SHELL_MODULES & set(task), f"{step.playbook}: {task['name']} uses a shell"
        if "env_file_b64" in yaml.safe_dump(task) and "block" not in task:
            assert task.get("no_log") is True, f"{step.playbook}: {task['name']} needs no_log"


@pytest.mark.parametrize("step", steps.STEPS, ids=lambda s: s.key)
def test_syntax_check(step, tmp_path):
    cfg = tmp_path / "ansible.cfg"
    cfg.write_text("[defaults]\n")
    env = {**os.environ, "ANSIBLE_CONFIG": str(cfg), "ANSIBLE_HOME": str(tmp_path),
           "ANSIBLE_LOCAL_TEMP": str(tmp_path / "tmp"), "ANSIBLE_NOCOLOR": "1"}
    result = subprocess.run(
        [str(ANSIBLE_PLAYBOOK), "--syntax-check", "-i", "target,",
         str(PLAYBOOK_DIR / step.playbook)],
        capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


DUMP_BLOCKED = ("The database isn't running, so the pre-deploy backup can't be taken. "
                "Start it (or Reset) and retry.")


def _run_dump(tmp_path, *, db_running: bool, dump_required: bool | None):
    """dump.yml on this machine (connection local) with stand-ins for docker
    (answers a container id only when db_running) and ss-stack."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text("#!/bin/sh\n" + ("echo 0123abcd\n" if db_running else "") + "exit 0\n")
    ss_stack = bin_dir / "ss-stack"
    ss_stack.write_text(f"#!/bin/sh\necho \"$1 $2\" > {tmp_path / 'ss-stack-called'}\n"
                        "echo /x/backups/e2e.dump\n")
    for f in (docker, ss_stack):
        f.chmod(0o755)
    cfg = tmp_path / "ansible.cfg"
    cfg.write_text("[defaults]\n")
    extra = {"env_name": "e2e", "env_dir": "/x", "ss_stack": str(ss_stack)}
    if dump_required is not None:
        extra["dump_required"] = dump_required
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
           "ANSIBLE_CONFIG": str(cfg), "ANSIBLE_HOME": str(tmp_path),
           "ANSIBLE_LOCAL_TEMP": str(tmp_path / "tmp"), "ANSIBLE_NOCOLOR": "1"}
    return subprocess.run(
        [str(ANSIBLE_PLAYBOOK), "-i", "target,", "-c", "local",
         "-e", f"ansible_python_interpreter={sys.executable}",
         "-e", json.dumps(extra), str(PLAYBOOK_DIR / "dump.yml")],
        capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, check=False)


@pytest.mark.parametrize("db_running, dump_required, ok, dumped", [
    (True, True, True, True),
    (True, False, True, True),
    (False, False, True, False),      # a first deploy: nothing to back up yet
    (False, None, True, False),
    (False, True, False, False),      # an established environment: never migrate unbacked
])
def test_dump_playbook_logic(tmp_path, db_running, dump_required, ok, dumped):
    result = _run_dump(tmp_path, db_running=db_running, dump_required=dump_required)
    out = result.stdout + result.stderr
    assert (result.returncode == 0) is ok, out
    called = tmp_path / "ss-stack-called"
    assert called.exists() is dumped, out
    if dumped:
        assert called.read_text() == "dump /x\n"
    assert (DUMP_BLOCKED in out) is (not ok), out
