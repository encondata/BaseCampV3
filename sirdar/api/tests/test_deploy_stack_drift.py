"""Sirdar's app and port lists against deploy/stack's: a new optional app or
port in the stack must reach Sirdar (and the reverse). And every playbook
grep that asks what a checkout's ss-stack can do must still find its line in
the real ss-stack: rewording that line silently turns the feature off (as
4e8ceb1d4 did to the learning site's check)."""

import re
import subprocess
from pathlib import Path

import pytest
import yaml

from sirdar_api.deploy import apps, certs, envfile, smoke
from sirdar_api.deploy.steps import PLAYBOOK_DIR

STACK = Path(__file__).resolve().parents[3] / "deploy" / "stack"
SS_STACK_ARG = "{{ ss_stack }}"


def _stack_apps() -> set[str]:
    text = (STACK / "ss-stack").read_text()
    found = re.search(r"^OPTIONAL_APPS=\(([a-z ]+)\)$", text, re.MULTILINE)
    assert found, "ss-stack's OPTIONAL_APPS list moved"
    return set(found.group(1).split())


def test_sirdar_knows_exactly_the_stacks_optional_apps():
    assert _stack_apps() == set(apps.OPTIONAL_APPS)


def test_every_stack_port_is_a_sirdar_service_and_back():
    keys = set(re.findall(r"^(STACK_[A-Z]+_PORT)=", (STACK / "env.example").read_text(), re.MULTILINE))
    assert keys == set(envfile.PORT_KEYS.values())


def test_learn_is_a_public_app_everywhere():
    assert "learn" in apps.OPTIONAL_APPS
    assert "learn" in envfile.PUBLIC_SERVICES and "learn" in certs.PUBLIC_SERVICES
    assert envfile.DEFAULT_PORTS["learn"] == 8092
    assert smoke.PATHS["learn"] == "/"


def test_devices_is_a_public_app_everywhere():
    assert "devices" in apps.OPTIONAL_APPS
    assert "devices" in envfile.PUBLIC_SERVICES and "devices" in certs.PUBLIC_SERVICES
    assert envfile.DEFAULT_PORTS["devices"] == 8093
    assert envfile.PORT_KEYS["devices"] == "STACK_DEVICES_PORT"
    assert smoke.PATHS["devices"] == "/healthz"


def test_sirdar_and_the_stack_order_the_apps_the_same():
    """Sirdar writes an explicit STACK_APPS in its OPTIONAL_APPS order: the
    stack's list and its example's STACK_APPS line keep the same order."""
    text = (STACK / "ss-stack").read_text()
    listed = re.search(r"^OPTIONAL_APPS=\(([a-z ]+)\)$", text, re.MULTILINE)
    assert listed and tuple(listed.group(1).split()) == apps.OPTIONAL_APPS
    found = re.search(r"^# STACK_APPS=([a-z,]+)\s", (STACK / "env.example").read_text(), re.MULTILINE)
    assert found, "env.example's STACK_APPS line moved"
    assert tuple(found.group(1).split(",")) == apps.OPTIONAL_APPS


# ---- the playbooks' greps of the checkout's ss-stack ----------------------------

# deploy/tests/test_sirdar_greps.py has a twin of this walker and these
# checks (deploy/tests can't import Sirdar): change both together.
MODULES = ("command", "shell", "raw", "action", "local_action")
ODD_MESSAGE = ("grep ss-stack as argv: [grep, ..., \"{{ ss_stack }}\"], and keep other greps out "
               "of tasks that mention ss-stack:\n")


def _scan_stack_greps() -> tuple[list[tuple[str, str, list[str]]], list[str]]:
    """Every task in the playbooks (tasks/ included) that greps the checkout's
    ss-stack. Returns the argv-form greps, (playbook, task name, argv), and
    any other task that runs grep on ss-stack in a form this walker can't
    run (free-form, cmd:, shell, raw, action strings), named so the test can
    refuse it."""
    found: list[tuple[str, str, list[str]]] = []
    odd: list[str] = []

    def walk(node, playbook: str) -> None:
        if isinstance(node, dict):
            for key, module in node.items():
                # PyYAML loads keys like 80: or on: as int or bool: never a module.
                if not isinstance(key, str) or key.rsplit(".", 1)[-1] not in MODULES:
                    continue
                if module is None or isinstance(module, dict):
                    # argv can also sit in the task's args:
                    args = node.get("args")
                    module = {**(args if isinstance(args, dict) else {}), **(module or {})}
                argv = module.get("argv") if isinstance(module, dict) else None
                text = str(module)
                if argv and argv[0] == "grep" and argv[-1] == SS_STACK_ARG:
                    found.append((playbook, node.get("name"), argv))
                elif "grep" in text and ("ss_stack" in text or "ss-stack" in text):
                    odd.append(f"{playbook}: {node.get('name')!r} ({key})")
            node = list(node.values())
        if isinstance(node, list):
            for item in node:
                walk(item, playbook)

    for path in sorted([*PLAYBOOK_DIR.rglob("*.yml"), *PLAYBOOK_DIR.rglob("*.yaml")]):
        walk(yaml.safe_load(path.read_text()), path.relative_to(PLAYBOOK_DIR).as_posix())
    return found, odd


def _stack_greps() -> list[tuple[str, str, list[str]]]:
    return _scan_stack_greps()[0]


def _failed_greps(ss_stack: Path) -> list[str]:
    """Each playbook grep, run as the playbook runs it, that finds nothing in
    `ss_stack`."""
    failed = []
    for playbook, name, argv in _stack_greps():
        rc = subprocess.run([*argv[:-1], str(ss_stack)], check=False).returncode
        if rc != 0:
            failed.append(f"{playbook}: {name!r} greps ss-stack for {argv[-2]!r} (rc {rc})")
    return failed


def test_the_playbook_greps_cover_learn_devices_and_the_commands():
    greps = _stack_greps()
    for app in ("learn", "devices"):
        assert {p for p, _, argv in greps if app in argv[-2]} == {"render.yml", "slot_smoke.yml"}
    for playbook, command in (("data.yml", "data"), ("first_admin.yml", "admin"),
                              ("seed.yml", "seed")):
        assert any(p == playbook and f"{command})" in argv[-2] for p, _, argv in greps), playbook


def test_every_ss_stack_grep_is_one_these_tests_can_run():
    """A grep of ss-stack written any other way would be skipped by the
    checks below; write it as `argv: [grep, ..., "{{ ss_stack }}"]`."""
    odd = _scan_stack_greps()[1]
    assert not odd, ODD_MESSAGE + "\n".join(odd)


def test_every_playbook_grep_finds_its_line_in_ss_stack():
    failed = _failed_greps(STACK / "ss-stack")
    assert not failed, "deploy/stack/ss-stack no longer has what these checks grep for:\n" \
        + "\n".join(failed)


@pytest.mark.parametrize("app", ["learn", "devices"])
def test_render_and_slot_smoke_ask_the_same_question(app):
    asked: dict[str, list[list[str]]] = {}
    for playbook, _, argv in _stack_greps():
        if app in argv[-2]:
            asked.setdefault(playbook, []).append(argv)
    assert sorted(asked) == ["render.yml", "slot_smoke.yml"]
    assert len(asked["render.yml"]) == len(asked["slot_smoke.yml"]) == 1, asked
    assert asked["render.yml"] == asked["slot_smoke.yml"]
