"""Sirdar's playbooks grep a checkout's ss-stack to tell what it can do (the
learning site; the data, admin and seed commands). Each grep must still find
its line in this ss-stack, or Sirdar treats this checkout as an older one and
quietly drops the feature. sirdar/api/tests/test_deploy_stack_drift.py runs
the same check from Sirdar's side."""
from __future__ import annotations

import subprocess

import pytest
import yaml

from conftest import REPO, SS_STACK

PLAYBOOKS = REPO / "sirdar" / "api" / "src" / "sirdar_api" / "deploy" / "ansible"


def _stack_greps() -> list[tuple[str, str, list[str]]]:
    """(playbook, task name, argv) for every command task, tasks/ included,
    whose argv greps "{{ ss_stack }}"."""
    found: list[tuple[str, str, list[str]]] = []

    def walk(node, playbook: str) -> None:
        if isinstance(node, dict):
            command = node.get("ansible.builtin.command") or node.get("command")
            argv = command.get("argv") if isinstance(command, dict) else None
            if argv and argv[0] == "grep" and argv[-1] == "{{ ss_stack }}":
                found.append((playbook, node.get("name"), argv))
            node = list(node.values())
        if isinstance(node, list):
            for item in node:
                walk(item, playbook)

    for path in sorted(PLAYBOOKS.rglob("*.yml")):
        walk(yaml.safe_load(path.read_text()), path.relative_to(PLAYBOOKS).as_posix())
    return found


GREPS = _stack_greps()


def test_the_learn_and_command_greps_are_all_found():
    assert {p for p, _, _ in GREPS} >= {"render.yml", "slot_smoke.yml", "data.yml",
                                        "first_admin.yml", "seed.yml"}


@pytest.mark.parametrize("playbook, name, argv", GREPS, ids=[p for p, _, _ in GREPS])
def test_each_sirdar_grep_finds_its_line(playbook, name, argv):
    rc = subprocess.run([*argv[:-1], str(SS_STACK)], check=False).returncode
    assert rc == 0, f"{playbook}: {name!r} greps ss-stack for {argv[-2]!r} and finds nothing"
