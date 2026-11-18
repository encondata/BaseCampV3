"""Sort keys for build numbers."""

import re

_PART = re.compile(r"[0-9]+")
_MAX_PARTS = 4
_PART_BITS = 16


def ios_build_sort(build: str) -> int:
    """CFBundleVersion as an integer that sorts like the build: up to four
    dot-separated integers, 16 bits each, missing parts as 0 ("1.10" sorts
    after "1.9"; "1" equals "1.0"). Anything else raises ValueError."""
    parts = build.split(".")
    if len(parts) > _MAX_PARTS or not all(_PART.fullmatch(p) for p in parts):
        raise ValueError(f"build {build!r} isn't up to {_MAX_PARTS} dot-separated integers")
    key = 0
    for i in range(_MAX_PARTS):
        value = int(parts[i]) if i < len(parts) else 0
        if value >= 1 << _PART_BITS:
            raise ValueError(f"build {build!r} has a part over {(1 << _PART_BITS) - 1}")
        key = (key << _PART_BITS) | value
    return key
