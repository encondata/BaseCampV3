"""Custom environment name rule, shared by the deploy route and the dashboard."""

import re

CUSTOM_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
RESERVED_NAMES = ("blue", "green", "dev", "beta", "custom")


def is_valid_custom_name(name: str) -> bool:
    return bool(CUSTOM_NAME_RE.fullmatch(name)) and not name.endswith("-")


def is_reserved_name(name: str) -> bool:
    return name in RESERVED_NAMES
