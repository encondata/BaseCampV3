"""Sirdar's app and port lists against deploy/stack's: a new optional app or
port in the stack must reach Sirdar (and the reverse)."""

import re
from pathlib import Path

from sirdar_api.deploy import apps, certs, envfile, smoke

STACK = Path(__file__).resolve().parents[3] / "deploy" / "stack"


def _stack_apps() -> set[str]:
    text = (STACK / "ss-stack").read_text()
    body = text[text.index("check_apps() {"):]
    body = body[:body.index("\n}\n")]
    case = re.search(r"^\s*([a-z|]+)\) ;;$", body, re.MULTILINE)
    assert case, "check_apps' case list moved"
    return set(case.group(1).split("|"))


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
