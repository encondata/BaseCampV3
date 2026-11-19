"""Sirdar's playbooks grep a checkout's ss-stack to tell what it can do (the
learning site; the data, admin and seed commands). Each grep must still find
its line in this ss-stack, or Sirdar treats this checkout as an older one and
quietly drops the feature.

This is a twin of the grep checks in sirdar/api/tests/test_deploy_stack_drift.py
(deploy/tests can't import Sirdar): change both together. PyYAML comes with
the api's uvicorn[standard] dependency."""
from __future__ import annotations

import subprocess

import pytest
import yaml

from conftest import REPO, SS_STACK

PLAYBOOKS = REPO / "sirdar" / "api" / "src" / "sirdar_api" / "deploy" / "ansible"
SS_STACK_ARG = "{{ ss_stack }}"
MODULES = ("command", "shell", "raw")


def _scan_stack_greps() -> tuple[list[tuple[str, str, list[str]]], list[str]]:
    """(playbook, task name, argv) for every task, tasks/ included, whose argv
    greps "{{ ss_stack }}", and the names of any task that runs grep on
    ss_stack in a form these tests can't run (free-form, cmd:, shell, raw)."""
    found: list[tuple[str, str, list[str]]] = []
    odd: list[str] = []

    def walk(node, playbook: str) -> None:
        if isinstance(node, dict):
            for key, module in node.items():
                if key.rsplit(".", 1)[-1] not in MODULES:
                    continue
                argv = module.get("argv") if isinstance(module, dict) else None
                if argv and argv[0] == "grep" and argv[-1] == SS_STACK_ARG:
                    found.append((playbook, node.get("name"), argv))
                elif "grep" in str(module) and "ss_stack" in str(module):
                    odd.append(f"{playbook}: {node.get('name')!r} ({key})")
            node = list(node.values())
        if isinstance(node, list):
            for item in node:
                walk(item, playbook)

    for path in sorted(PLAYBOOKS.rglob("*.yml")):
        walk(yaml.safe_load(path.read_text()), path.relative_to(PLAYBOOKS).as_posix())
    return found, odd


GREPS, ODD = _scan_stack_greps()


def test_the_learn_and_command_greps_are_all_found():
    assert {p for p, _, argv in GREPS if "learn" in argv[-2]} == {"render.yml", "slot_smoke.yml"}
    for playbook, command in (("data.yml", "data"), ("first_admin.yml", "admin"),
                              ("seed.yml", "seed")):
        assert any(p == playbook and f"{command})" in argv[-2] for p, _, argv in GREPS), playbook


def test_every_ss_stack_grep_is_one_these_tests_can_run():
    assert not ODD, "grep ss-stack with an argv list ending in {{ ss_stack }}:\n" + "\n".join(ODD)


def test_render_and_slot_smoke_ask_the_same_learn_question():
    learn = {p: argv for p, _, argv in GREPS if "learn" in argv[-2]}
    assert learn["render.yml"] == learn["slot_smoke.yml"]


@pytest.mark.parametrize("playbook, name, argv", GREPS, ids=[p for p, _, _ in GREPS])
def test_each_sirdar_grep_finds_its_line(playbook, name, argv):
    rc = subprocess.run([*argv[:-1], str(SS_STACK)], check=False).returncode
    assert rc == 0, f"{playbook}: {name!r} greps ss-stack for {argv[-2]!r} and finds nothing"
