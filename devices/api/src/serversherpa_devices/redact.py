"""Keeping UDIDs out of text that leaves the service: Apple's error details
can quote the device number back ("A device with number '…' already
exists")."""

import re

THIS_DEVICE = "this device"


def without_udid(text: str, udid: str) -> str:
    """`text` with every copy of `udid` replaced by "this device": any case,
    with or without its dashes (or with dashes anywhere)."""
    chars = [c for c in udid if c != "-"]
    if not text or not chars:
        return text
    pattern = "-?".join(re.escape(c) for c in chars)
    return re.sub(pattern, THIS_DEVICE, text, flags=re.IGNORECASE)
