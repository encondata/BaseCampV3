"""Sirdar's app and port lists against deploy/stack's: a new optional app or
port in the stack must reach Sirdar (and the reverse)."""

import re
from pathlib import Path

from sirdar_api.deploy import apps, certs, envfile, smoke

STACK = Path(__file__).resolve().parents[3] / "deploy" / "stack"


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
