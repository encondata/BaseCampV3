"""Sort keys for build numbers."""

import re

_PART = re.compile(r"[0-9]+")
_MAX_PARTS = 4
_PART_DIGITS = 9
_PART_MAX = 10**_PART_DIGITS - 1


def ios_build_sort(build: str) -> int:
    """CFBundleVersion as an integer that sorts like the build: up to four
    dot-separated integers of 0..999_999_999, packed in decimal as
    p1*10^27 + p2*10^18 + p3*10^9 + p4 with missing parts as 0 ("1.10" sorts
    after "1.9", "1" equals "1.0", date builds such as "2026111701" fit).
    The result fits numeric(38,0). Anything else raises ValueError."""
    parts = build.split(".")
    if len(parts) > _MAX_PARTS or not all(_PART.fullmatch(p) for p in parts):
        raise ValueError(f"build {build!r} isn't up to {_MAX_PARTS} dot-separated integers")
    key = 0
    for i in range(_MAX_PARTS):
        value = int(parts[i]) if i < len(parts) else 0
        if value > _PART_MAX:
            raise ValueError(f"build {build!r} has a part over {_PART_MAX}")
        key = key * 10**_PART_DIGITS + value
    return key
